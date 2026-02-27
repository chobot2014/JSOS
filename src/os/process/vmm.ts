/**
 * JSOS Virtual Memory Manager
 *
 * Implements virtual memory with:
 * - Page tables
 * - Virtual-to-physical address translation
 * - Memory protection
 * - Page fault handling
 * - Memory-mapped I/O
 * - Phase 4: hardware paging via kernel.setPageEntry / kernel.enablePaging
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export interface PageTableEntry {
  present: boolean;
  writable: boolean;
  user: boolean;
  accessed: boolean;
  dirty: boolean;
  physicalAddress: number;
  virtualAddress: number;
  size: number; // Page size in bytes
}

export interface MemoryRegion {
  start: number;
  end: number;
  permissions: 'r' | 'w' | 'x' | 'rw' | 'rx' | 'wx' | 'rwx';
  type: 'heap' | 'stack' | 'code' | 'data' | 'mmio' | 'shared';
  backingStore?: 'physical' | 'file' | 'anonymous';
  fileDescriptor?: number;
  fileOffset?: number;
}

/** Metadata for an expandable stack region, keyed by the current guard page number. */
interface StackGuardEntry {
  /** Byte address of the current lowest mapped stack page (grows down). */
  regionStart: number;
  /** Minimum byte address the stack is allowed to reach (hard floor). */
  minStack: number;
}

export class VirtualMemoryManager {
  private pageSize = 4096; // 4KB pages
  private pageTable = new Map<number, PageTableEntry>();
  private memoryRegions: MemoryRegion[] = [];
  private nextVirtualAddress = 0x100000; // Start after kernel space
  private get physicalMemorySize(): number {
    // Dynamically read from the multiboot2 RAM report instead of a hardcoded value.
    return (kernel.getRamBytes && kernel.getRamBytes()) || (4 * 1024 * 1024 * 1024);
  }
  private allocatedPhysicalPages = new Set<number>();

  /**
   * Guard pages for expandable stacks.
   * key = virtual page number of the guard page (unmapped page just below stack base)
   * value = metadata needed to extend the stack and relocate the guard
   */
  private stackGuards = new Map<number, StackGuardEntry>();

  // ── Privilege level (ring 0 = kernel, ring 3 = user) ─────────────────────
  /**
   * Tracks the current CPU privilege ring.
   * Ring 0 (kernel) may access all pages.
   * Ring 3 (user) is blocked from pages whose PTE has `user = false`.
   */
  private _currentRing: 0 | 3 = 0;

  /** Set the active privilege level (0 = kernel, 3 = user). */
  setPrivilegeLevel(ring: 0 | 3): void {
    this._currentRing = ring;
  }

  /** Return the currently active privilege level. */
  getPrivilegeLevel(): 0 | 3 {
    return this._currentRing;
  }

  /**
   * Allocate kernel-only virtual memory (ring-0 accessible only).
   * Identical to `allocateVirtualMemory` but marks PTEs with `user = false`.
   */
  allocateKernelMemory(size: number, permissions: MemoryRegion['permissions'] = 'rw'): number | null {
    return this.allocateVirtualMemory(size, permissions, false);
  }

  constructor() {
    // Initialize kernel memory regions
    this.addMemoryRegion({
      start: 0x00000000,
      end: 0x00100000, // 1MB
      permissions: 'rwx',
      type: 'code',
      backingStore: 'physical'
    });

    // Initialize heap
    this.addMemoryRegion({
      start: 0x00100000,
      end: 0x01000000, // 15MB
      permissions: 'rw',
      type: 'heap',
      backingStore: 'anonymous'
    });
  }

  /**
   * Translate virtual address to physical address
   */
  translateAddress(virtualAddress: number): { physical: number; valid: boolean; permissions: string } {
    const pageNumber = Math.floor(virtualAddress / this.pageSize);
    const offset = virtualAddress % this.pageSize;

    const pte = this.pageTable.get(pageNumber);
    if (!pte || !pte.present) {
      return { physical: 0, valid: false, permissions: '' };
    }

    const physicalAddress = pte.physicalAddress + offset;

    // Check permissions
    let permissions = 'r';
    if (pte.writable) permissions += 'w';

    return {
      physical: physicalAddress,
      valid: true,
      permissions
    };
  }

  /**
   * Allocate virtual memory.
   *
   * @param size            Bytes to allocate.
   * @param permissions     Read/write/execute permissions string.
   * @param userAccessible  When `true` (default) the pages are accessible from
   *                        ring 3.  Pass `false` for kernel-only allocations.
   */
  allocateVirtualMemory(
    size: number,
    permissions: MemoryRegion['permissions'] = 'rw',
    userAccessible = true,
  ): number | null {
    const pagesNeeded = Math.ceil(size / this.pageSize);
    const virtualAddress = this.findFreeVirtualSpace(pagesNeeded * this.pageSize);

    if (virtualAddress === null) {
      return null; // No free virtual space
    }

    // Allocate physical pages
    const physicalPages: number[] = [];
    for (let i = 0; i < pagesNeeded; i++) {
      const physicalPage = this.allocatePhysicalPage();
      if (physicalPage === null) {
        // Free already allocated pages
        physicalPages.forEach(page => this.freePhysicalPage(page));
        return null;
      }
      physicalPages.push(physicalPage);
    }

    // Create page table entries
    for (let i = 0; i < pagesNeeded; i++) {
      const virtualPage = Math.floor((virtualAddress + i * this.pageSize) / this.pageSize);
      const pte: PageTableEntry = {
        present: true,
        writable: permissions.includes('w'),
        user: userAccessible,
        accessed: false,
        dirty: false,
        physicalAddress: physicalPages[i] * this.pageSize,
        virtualAddress: virtualPage * this.pageSize,
        size: this.pageSize,
      };
      this.pageTable.set(virtualPage, pte);
    }

    // Add memory region
    this.addMemoryRegion({
      start: virtualAddress,
      end: virtualAddress + size,
      permissions,
      type: 'heap',
      backingStore: 'anonymous'
    });

    return virtualAddress;
  }

  /**
   * Free virtual memory
   */
  freeVirtualMemory(virtualAddress: number, size: number): boolean {
    const pagesToFree = Math.ceil(size / this.pageSize);

    for (let i = 0; i < pagesToFree; i++) {
      const virtualPage = Math.floor((virtualAddress + i * this.pageSize) / this.pageSize);
      const pte = this.pageTable.get(virtualPage);

      if (pte) {
        // Free physical page
        const physicalPage = Math.floor(pte.physicalAddress / this.pageSize);
        this.freePhysicalPage(physicalPage);

        // Remove page table entry
        this.pageTable.delete(virtualPage);
      }
    }

    // Remove memory region
    this.memoryRegions = this.memoryRegions.filter(
      region => !(region.start >= virtualAddress && region.end <= virtualAddress + size)
    );

    return true;
  }

  /**
   * Map physical memory into virtual address space (MMIO)
   */
  mapPhysicalMemory(physicalAddress: number, size: number, virtualAddress?: number): number | null {
    const targetVirtual = virtualAddress || this.findFreeVirtualSpace(size);
    if (targetVirtual === null) return null;

    const pagesNeeded = Math.ceil(size / this.pageSize);

    for (let i = 0; i < pagesNeeded; i++) {
      const virtualPage = Math.floor((targetVirtual + i * this.pageSize) / this.pageSize);
      const pte: PageTableEntry = {
        present: true,
        writable: true,
        user: false, // Kernel only
        accessed: false,
        dirty: false,
        physicalAddress: physicalAddress + i * this.pageSize,
        virtualAddress: virtualPage * this.pageSize,
        size: this.pageSize
      };
      this.pageTable.set(virtualPage, pte);
    }

    this.addMemoryRegion({
      start: targetVirtual,
      end: targetVirtual + size,
      permissions: 'rw',
      type: 'mmio',
      backingStore: 'physical'
    });

    return targetVirtual;
  }

  /**
   * Memory-mapped file I/O
   */
  mmapFile(fd: number, offset: number, size: number, virtualAddress?: number): number | null {
    const targetVirtual = virtualAddress || this.findFreeVirtualSpace(size);
    if (targetVirtual === null) return null;

    // For now, allocate anonymous memory (file backing would need file system support)
    const actualAddress = this.allocateVirtualMemory(size, 'rw');
    if (actualAddress === null) return null;

    // Update region info
    const region = this.memoryRegions.find(r => r.start === actualAddress);
    if (region) {
      region.type = 'data';
      region.backingStore = 'file';
      region.fileDescriptor = fd;
      region.fileOffset = offset;
    }

    return actualAddress;
  }

  /**
   * Check if memory access is valid for the **current privilege level**.
   *
   * Ring-3 (user) accessors are denied access to kernel-only pages
   * (`PageTableEntry.user === false`).  Ring-0 (kernel) may access everything.
   *
   * @param virtualAddress  Start of the range to check.
   * @param size            Number of bytes.
   * @param write           `true` to additionally verify write permission.
   * @param forceRing       Override the current ring for this check only.
   */
  isValidAccess(
    virtualAddress: number,
    size: number,
    write = false,
    forceRing?: 0 | 3,
  ): boolean {
    const effectiveRing = forceRing ?? this._currentRing;
    const pageSize = this.pageSize;
    for (let addr = virtualAddress; addr < virtualAddress + size; addr += pageSize) {
      const pageNumber = Math.floor(addr / pageSize);
      const pte = this.pageTable.get(pageNumber);
      if (!pte || !pte.present) return false;

      // Privilege check: ring-3 cannot touch kernel-only pages.
      if (effectiveRing === 3 && !pte.user) return false;

      // Write-permission check.
      if (write && !pte.writable) return false;
    }
    return true;
  }

  /**
   * Allocate a stack region with an automatic guard page.
   *
   * Stack grows downward.  The initially-committed region spans
   * [stackBase, stackTop).  The page immediately below stackBase is left
   * unmapped and registered as a guard page.  Any page fault on it will
   * commit one more page and slide the guard page down, up to `maxGrowth`
   * bytes from the original top.
   *
   * @param initialSize  Bytes committed on first call (must be page-aligned).
   * @param maxGrowth    Maximum additional bytes the stack may grow (default 1 MB).
   * @returns The initial stack-pointer value (= stackTop, high watermark).
   */
  allocateStack(initialSize: number, maxGrowth: number = 1 * 1024 * 1024): number | null {
    // Round sizes up to page granularity.
    initialSize = Math.ceil(initialSize / this.pageSize) * this.pageSize;
    maxGrowth   = Math.ceil(maxGrowth  / this.pageSize) * this.pageSize;

    // Reserve virtual space: one guard page + maxGrowth (growth area) + initialSize.
    const totalReserve = this.pageSize + maxGrowth + initialSize;
    const reserveBase  = this.findFreeVirtualSpace(totalReserve);
    if (reserveBase === null) return null;

    const stackTop  = reserveBase + totalReserve; // highest address (initial SP)
    const stackBase = stackTop - initialSize;      // lowest committed address

    // Commit initial pages.
    for (let offset = 0; offset < initialSize; offset += this.pageSize) {
      const phys = this.allocatePhysicalPage();
      if (phys === null) return null; // OOM — partial cleanup omitted for brevity
      const vpn = Math.floor((stackBase + offset) / this.pageSize);
      this.pageTable.set(vpn, {
        present: true,
        writable: true,
        user: true,
        accessed: false,
        dirty: false,
        physicalAddress: phys * this.pageSize,
        virtualAddress: vpn * this.pageSize,
        size: this.pageSize,
      });
    }

    // Register the guard page (one page below the current stack base).
    const guardVA  = stackBase - this.pageSize;
    const guardVPN = Math.floor(guardVA / this.pageSize);
    const minStack = reserveBase + this.pageSize; // never grow below this
    this.stackGuards.set(guardVPN, { regionStart: stackBase, minStack });

    // Record the committed region.
    this.addMemoryRegion({
      start: stackBase,
      end: stackTop,
      permissions: 'rw',
      type: 'stack',
      backingStore: 'anonymous',
    });

    return stackTop; // caller sets SP to this value
  }

  /**
   * Handle page fault.
   *
   * Behaviour:
   * 1. If the fault is on a registered guard page, commit the page and slide
   *    the guard down (stack growth). Returns `true` on success.
   * 2. If the PTE exists but `present` is false (e.g. swapped-out page),
   *    mark it present and return `true`.
   * 3. Any other fault returns `false` (caller should panic/kill process).
   */
  handlePageFault(virtualAddress: number): boolean {
    const pageNumber = Math.floor(virtualAddress / this.pageSize);
    const pte = this.pageTable.get(pageNumber);

    // ── Case 1: guard-page hit → extend stack downward ──────────────────────
    if (!pte) {
      const guard = this.stackGuards.get(pageNumber);
      if (guard) {
        const newPageVA = pageNumber * this.pageSize;

        // Enforce the hard floor (prevents infinite stack overflow).
        if (newPageVA < guard.minStack) {
          // Stack overflow — cannot grow further.
          return false;
        }

        // Commit a fresh physical page for this virtual page.
        const phys = this.allocatePhysicalPage();
        if (phys === null) return false; // OOM

        this.pageTable.set(pageNumber, {
          present: true,
          writable: true,
          user: true,
          accessed: false,
          dirty: false,
          physicalAddress: phys * this.pageSize,
          virtualAddress: newPageVA,
          size: this.pageSize,
        });

        // Slide the guard page one page lower.
        this.stackGuards.delete(pageNumber);
        const nextGuardVPN = pageNumber - 1;
        if (nextGuardVPN * this.pageSize >= guard.minStack) {
          this.stackGuards.set(nextGuardVPN, { ...guard, regionStart: newPageVA });
        }

        // Expand the recorded stack region to include the newly committed page.
        const region = this.memoryRegions.find(
          r => r.type === 'stack' && r.start === guard.regionStart,
        );
        if (region) {
          region.start = newPageVA;
          guard.regionStart = newPageVA;
        }

        return true; // fault handled — retry the faulting instruction
      }

      // Not a guard page — true unmapped-memory fault.
      return false;
    }

    // ── Case 2: page present in table but marked not-present (swapped out) ──
    if (!pte.present) {
      // Swap-in would go here; for now just re-mark as present.
      pte.present = true;
      return true;
    }

    return false;
  }

  /**
   * Get memory statistics
   */
  getMemoryStats(): {
    totalPhysical: number;
    usedPhysical: number;
    freePhysical: number;
    totalVirtual: number;
    mappedPages: number;
  } {
    const totalPages = Math.floor(this.physicalMemorySize / this.pageSize);
    const usedPages = this.allocatedPhysicalPages.size;

    return {
      totalPhysical: this.physicalMemorySize,
      usedPhysical: usedPages * this.pageSize,
      freePhysical: (totalPages - usedPages) * this.pageSize,
      totalVirtual: 0xFFFFFFFF, // 4GB address space
      mappedPages: this.pageTable.size
    };
  }

  /**
   * Add a memory region
   */
  private addMemoryRegion(region: MemoryRegion): void {
    this.memoryRegions.push(region);
    this.memoryRegions.sort((a, b) => a.start - b.start);
  }

  /**
   * Find free virtual address space
   */
  private findFreeVirtualSpace(size: number): number | null {
    // Simple first-fit algorithm
    let current = this.nextVirtualAddress;

    while (current < 0xC0000000) { // Don't go into kernel space
      const conflict = this.memoryRegions.find(
        region => (current >= region.start && current < region.end) ||
                 (current + size > region.start && current + size <= region.end) ||
                 (current <= region.start && current + size >= region.end)
      );

      if (!conflict) {
        this.nextVirtualAddress = current + size;
        return current;
      }

      current = conflict.end;
    }

    return null;
  }

  /**
   * Allocate a physical page
   */
  private allocatePhysicalPage(): number | null {
    const totalPages = Math.floor(this.physicalMemorySize / this.pageSize);

    for (let i = 0; i < totalPages; i++) {
      if (!this.allocatedPhysicalPages.has(i)) {
        this.allocatedPhysicalPages.add(i);
        return i;
      }
    }

    return null; // No free pages
  }

  /**
   * Free a physical page
   */
  private freePhysicalPage(pageNumber: number): void {
    this.allocatedPhysicalPages.delete(pageNumber);
  }

  /**
   * Get memory regions
   */
  getMemoryRegions(): MemoryRegion[] {
    return [...this.memoryRegions];
  }

  // ── Phase 4: real paging (hardware page table support) ─────────────────

  /**
   * Set up an identity-mapped page directory covering `ramMB` megabytes of
   * physical RAM using 4 MB huge pages, plus the high MMIO region (0xE0000000–
   * 0xFFFFFFFF) with cache-disable for PCI/VESA framebuffer access.
   * Then enables hardware paging via kernel.enablePaging().
   *
   * @param ramMB   Total usable physical RAM in MB (from physAlloc.totalMB()).
   * @returns true if paging was enabled successfully.
   */
  enableHardwarePaging(ramMB: number): boolean {
    var MB4      = 4 * 1024 * 1024;
    var PRESENT  = 0x001;
    var WRITABLE = 0x002;
    var HUGE     = 0x080;   // PS bit — 4 MB page
    var NO_CACHE = 0x010;

    // 1. Identity-map physical RAM (up to 512 MB = 128 PDEs).
    var rampages = Math.ceil(ramMB / 4);
    if (rampages > 128) rampages = 128;
    for (var i = 0; i < rampages; i++) {
      kernel.setPageEntry(i, 0, i * MB4, PRESENT | WRITABLE | HUGE);
    }

    // 2. MMIO identity-map 0xE0000000–0xFFFFFFFF (PDE 896–1023).
    //    Covers all PCI/VESA framebuffer addresses QEMU might place at high PA.
    for (var m = 896; m < 1024; m++) {
      kernel.setPageEntry(m, 0, m * MB4, PRESENT | WRITABLE | HUGE | NO_CACHE);
    }

    // 3. Enable paging.
    return kernel.enablePaging();
  }

  /**
   * Minimal mmap test: allocate and free one page via the physical allocator.
   * Returns true if the round-trip succeeded without throwing.
   */
  mmapTest(physAlloc: import('./physalloc.js').PhysicalAllocator): boolean {
    try {
      var phys = physAlloc.alloc(1);    // allocate one 4 KB frame
      physAlloc.free(phys, 1);          // release it
      return true;
    } catch (e) {
      return false;
    }
  }
}

export const vmm = new VirtualMemoryManager();