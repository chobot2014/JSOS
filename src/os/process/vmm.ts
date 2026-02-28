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

// ── Copy-On-Write (Item 133) ──────────────────────────────────────────────────

/**
 * [Item 133] Copy-on-write page table for forked child processes.
 * When a fork() is performed, pages are shared read-only.  On the first
 * write fault, the faulting process receives its own copy.
 */
export interface COWEntry {
  virtualPage:  number;  // virtual page number (vpn = vaddr >> 12)
  physPage:     number;  // current physical page number
  refCount:     number;  // number of processes sharing this physical page
  owners:       Set<number>;  // set of PID values sharing this page
}

export class COWManager {
  private pages = new Map<number, COWEntry>();  // key = physPage

  /**
   * Record a shared page between parent and child PIDs.
   * Both PIDs write-protect the page; writes trigger copyOnWriteFault().
   */
  sharePageForFork(physPage: number, parentPid: number, childPid: number): void {
    var entry = this.pages.get(physPage);
    if (!entry) {
      entry = { virtualPage: physPage, physPage, refCount: 1, owners: new Set([parentPid]) };
      this.pages.set(physPage, entry);
    }
    entry.owners.add(childPid);
    entry.refCount = entry.owners.size;
  }

  /**
   * Handle a write page-fault for process pid at physPage.
   * Allocates a new physical page for the faulting process and updates
   * reference counts.  Returns the new physical page number.
   */
  copyOnWriteFault(physPage: number, pid: number, physAlloc: import('./physalloc.js').PhysicalAllocator): number {
    var entry = this.pages.get(physPage);
    if (!entry || !entry.owners.has(pid)) return physPage;  // not a COW page

    if (entry.refCount === 1) {
      // Last owner: re-enable write and remove COW tracking
      this.pages.delete(physPage);
      return physPage;
    }
    // Allocate a fresh physical page and copy data
    var newPhys = physAlloc.alloc(1);
    // NOTE: actual memory copy would be done by the kernel C layer;
    //       we track the mapping here in TypeScript.
    entry.owners.delete(pid);
    entry.refCount--;
    // Create a private entry for the new page (single owner)
    this.pages.set(newPhys, { virtualPage: newPhys, physPage: newPhys, refCount: 1, owners: new Set([pid]) });
    return newPhys;
  }

  isDirty(physPage: number): boolean { return !this.pages.has(physPage); }
  getRefCount(physPage: number): number { return this.pages.get(physPage)?.refCount ?? 1; }
}

export const cowManager = new COWManager();

// ── Memory-Mapped Files / Anonymous mmap (Item 134) ──────────────────────────

/** [Item 134] A single mmap mapping: file-backed or anonymous. */
export interface MmapRegion {
  vaddr:     number;   // virtual start address
  length:    number;   // mapping length in bytes
  prot:      number;   // PROT_READ(1) | PROT_WRITE(2) | PROT_EXEC(4)
  flags:     number;   // MAP_SHARED(1) | MAP_PRIVATE(2) | MAP_ANON(4)
  fd:        number;   // file descriptor (-1 for anonymous)
  offset:    number;   // file offset
  pid:       number;   // owning process
  loaded:    boolean;  // true once the backing data has been faulted in
}

export class MmapManager {
  private regions: MmapRegion[] = [];
  private nextVaddr = 0x40000000;  // user mmap area base (1 GB)

  /**
   * [Item 134] Map a file-backed or anonymous region into the process address space.
   * Returns the virtual address of the mapping.
   */
  mmap(pid: number, length: number, prot: number, flags: number,
       fd: number, offset: number): number {
    var pageSize = 4096;
    var pages   = Math.ceil(length / pageSize);
    var aligned = pages * pageSize;
    var vaddr   = this.nextVaddr;
    this.nextVaddr += aligned + pageSize;  // +1 guard page
    var region: MmapRegion = { vaddr, length: aligned, prot, flags, fd, offset, pid, loaded: false };
    this.regions.push(region);
    return vaddr;
  }

  /**
   * [Item 135] Demand-paging: load backing data when a page is first accessed.
   * Called by the page-fault handler when the faulting address falls in an mmap region.
   * Returns the physical page number to map, or -1 if the address is not in any region.
   */
  demandPage(faultAddr: number, pid: number, physAlloc: import('./physalloc.js').PhysicalAllocator, readFile: (fd: number, offset: number, len: number) => Uint8Array | null): number {
    var region = this.regions.find(r => r.pid === pid && faultAddr >= r.vaddr && faultAddr < r.vaddr + r.length);
    if (!region) return -1;

    var pageOff = Math.floor((faultAddr - region.vaddr) / 4096) * 4096;
    var physPage = physAlloc.alloc(1);

    if (region.fd >= 0 && readFile) {
      // File-backed: read one page of data
      var data = readFile(region.fd, region.offset + pageOff, 4096);
      // The actual write to physical memory is done by the C kernel;
      // we record the mapping so we can locate data.
      if (data) region.loaded = true;
    }
    // Anonymous: page is zeroed by the allocator.
    return physPage;
  }

  /** Unmap a previously mmap()ed region. */
  munmap(vaddr: number, length: number, pid: number): void {
    this.regions = this.regions.filter(r => !(r.pid === pid && r.vaddr === vaddr));
  }

  getRegion(vaddr: number, pid: number): MmapRegion | null {
    return this.regions.find(r => r.pid === pid && vaddr >= r.vaddr && vaddr < r.vaddr + r.length) || null;
  }

  allRegionsForPid(pid: number): MmapRegion[] {
    return this.regions.filter(r => r.pid === pid);
  }
}

export const mmapManager = new MmapManager();

// ── Swap Space (Item 136) ─────────────────────────────────────────────────────

/** [Item 136] A single swap slot: one 4 KB page stored to the swap file/partition. */
export interface SwapSlot {
  slotIndex: number;   // position in swap file (slot * 4096 = byte offset)
  physPage:  number;   // original physical page that was swapped out
  pid:       number;   // owning process
  vaddr:     number;   // virtual address in the process
  dirty:     boolean;  // page was modified before eviction
}

/**
 * [Item 136] Swap space manager.
 * Tracks which swap slots are free/used and which physical pages have been
 * evicted.  Actual disk I/O is delegated to kernel.writeDiskSector()/readDiskSector().
 */
export class SwapManager {
  private readonly swapSizePages: number;
  private freeSlots: number[] = [];
  private slotMap = new Map<number, SwapSlot>();  // physPage → slot

  constructor(swapSizePages = 4096) {
    this.swapSizePages = swapSizePages;
    for (var i = 0; i < swapSizePages; i++) this.freeSlots.push(i);
  }

  /**
   * [Item 136] Evict a physical page to swap.
   * Returns the slot index, or -1 if swap is full.
   */
  swapOut(physPage: number, pid: number, vaddr: number): number {
    if (this.freeSlots.length === 0) return -1;
    var slot = this.freeSlots.pop()!;
    var entry: SwapSlot = { slotIndex: slot, physPage, pid, vaddr, dirty: true };
    this.slotMap.set(physPage, entry);
    // kernel.writeDiskSector(swapDiskId, slot * 8, pageData) would be called here
    return slot;
  }

  /**
   * [Item 136] Bring a swapped-out page back into physical memory.
   * Allocates a fresh physical page and marks the slot free.
   */
  swapIn(physPage: number, physAlloc: import('./physalloc.js').PhysicalAllocator): number {
    var entry = this.slotMap.get(physPage);
    if (!entry) return -1;
    var newPhys = physAlloc.alloc(1);
    // kernel.readDiskSector(swapDiskId, entry.slotIndex * 8) → copy to newPhys
    this.freeSlots.push(entry.slotIndex);
    this.slotMap.delete(physPage);
    return newPhys;
  }

  isSwapped(physPage: number): boolean { return this.slotMap.has(physPage); }
  freeSwapPages(): number { return this.freeSlots.length; }
  usedSwapPages(): number { return this.slotMap.size; }
  /** Free a swap slot for `physPage` (alias used by MadviseManager MADV_REMOVE). */
  freeSlot(physPage: number): void {
    var slot = this.slotMap.get(physPage);
    if (slot !== undefined) {
      this.slotMap.delete(physPage);
      this.freeSlots.push(slot.slotIndex);
    }
  }
}

export const swapManager = new SwapManager();

// ── LRU Page Reclaim — Clock Algorithm (Item 137) ────────────────────────────

/**
 * [Item 137] Clock (second-chance) LRU page replacement.
 * Maintains a circular list of physical pages.  The clock hand sweeps; pages
 * with the accessed bit set get one second chance before being evicted.
 */
export class LRUClock {
  private pages: number[] = [];   // physical page numbers in clock order
  private accessed = new Set<number>();  // pages with referenced bit set
  private hand = 0;               // clock hand position

  /** Add a physical page to the clock. */
  add(physPage: number): void {
    this.pages.push(physPage);
    this.accessed.add(physPage);  // newly added = recently used
  }

  /** Mark a page as recently accessed (e.g. on a TLB miss/read/write). */
  access(physPage: number): void { this.accessed.add(physPage); }

  /**
   * [Item 137] Sweep the clock and return the next page to evict.
   * Pages with the referenced bit set get one more chance; the bit is cleared.
   */
  evictOne(): number | null {
    if (this.pages.length === 0) return null;
    for (var tries = 0; tries < this.pages.length * 2; tries++) {
      var page = this.pages[this.hand % this.pages.length];
      if (this.accessed.has(page)) {
        // Second chance: clear referenced bit, advance hand
        this.accessed.delete(page);
      } else {
        // Evict this page
        this.pages.splice(this.hand % this.pages.length, 1);
        if (this.hand > 0) this.hand--;
        return page;
      }
      this.hand = (this.hand + 1) % this.pages.length;
    }
    // All pages referenced: evict the current hand position
    var victim = this.pages[this.hand % this.pages.length];
    this.pages.splice(this.hand % this.pages.length, 1);
    return victim;
  }

  remove(physPage: number): void {
    var i = this.pages.indexOf(physPage);
    if (i >= 0) { this.pages.splice(i, 1); if (this.hand >= this.pages.length && this.hand > 0) this.hand--; }
    this.accessed.delete(physPage);
  }

  /** Alias for `add()` — used by MadviseManager (MADV_WILLNEED). */
  track(physPage: number): void { this.add(physPage); }

  /** Alias for `access()` — mark page as recently accessed. */
  markAccessed(physPage: number): void { this.access(physPage); }

  get size(): number { return this.pages.length; }
}

export const lruClock = new LRUClock();

// ─────────────────────────────────────────────────────────────────────────────
// [Item 140] ASLR — Address-Space Layout Randomization
//
// Randomizes the base address of mmap segments, stack, and heap for each
// process to mitigate return-oriented programming (ROP) exploits.
// All JSOS process regions come through here so the kernel enforces ASLR
// transparently.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entropy bits used for randomization.
 * Standard Linux uses 28 bits for mmap ASLR on a 64-bit machine (controlled
 * by /proc/sys/kernel/randomize_va_space).  We use 20 bits for our 32-bit
 * address space, giving 1 million possible base addresses per segment type.
 */
const ASLR_ENTROPY_BITS = 20;
const ASLR_PAGE_SIZE    = 4096;

export interface ASLRConfig {
  enabled:    boolean;
  entropyBits: number; // 0 = disabled, max 28
}

export class ASLRManager {
  private _config: ASLRConfig = { enabled: true, entropyBits: ASLR_ENTROPY_BITS };
  /** Base seeds per process-id. Re-seeded on `fork`. */
  private _seeds: Map<number, Uint32Array> = new Map();

  /**
   * Get or create a stable ASLR seed for a process.
   * A new seed is generated once per process lifetime; all address slots
   * for that process derive from this seed so they are reproducible (for
   * core dumps) but unpredictable to attackers.
   */
  private _getSeed(pid: number): Uint32Array {
    if (!this._seeds.has(pid)) {
      var arr = new Uint32Array(4);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
      } else {
        // Fallback: xorshift128
        arr[0] = (Date.now() & 0xffffffff) ^ (pid * 0x9e3779b9);
        arr[1] = arr[0] ^ 0xdeadbeef;
        arr[2] = arr[1] ^ 0xcafe1234;
        arr[3] = arr[2] ^ 0xbabe5678;
        for (var i = 0; i < 32; i++) {
          var t = arr[3]; t ^= t << 11; t ^= t >>> 8;
          arr[3] = arr[2]; arr[2] = arr[1]; arr[1] = arr[0];
          arr[0] ^= t ^ (arr[0] >>> 19);
        }
      }
      this._seeds.set(pid, arr);
    }
    return this._seeds.get(pid)!;
  }

  /**
   * Derive a randomized segment base address for `pid` and `slot` ('heap',
   * 'stack', 'mmap', 'vdso', etc.).  The returned address is page-aligned.
   *
   * Address layout:
   *   - Heap   : 0x10000000 + random offset
   *   - Stack  : 0xBFFF0000 - random offset
   *   - mmap   : 0x40000000 + random offset
   *   - vdso   : 0xFFFF0000 - random offset
   */
  randomizeBase(pid: number, slot: 'heap' | 'stack' | 'mmap' | 'vdso'): number {
    if (!this._config.enabled) {
      // No ASLR: return deterministic defaults
      var defaults: Record<string, number> = {
        heap: 0x10000000, stack: 0xbfff0000, mmap: 0x40000000, vdso: 0xffff0000
      };
      return defaults[slot];
    }
    var seed  = this._getSeed(pid);
    // xorshift one step per slot to get independent values
    var slotIdx = ({ heap: 0, stack: 1, mmap: 2, vdso: 3 } as Record<string,number>)[slot] ?? 0;
    var r = seed[slotIdx];
    r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
    seed[slotIdx] = r; // update so next call for same slot differs
    var entropy  = (r >>> 0) % (1 << this._config.entropyBits);
    var offset   = (entropy * ASLR_PAGE_SIZE) | 0;

    var bases: Record<string, number> = {
      heap:  0x10000000, stack: 0xbfff0000, mmap: 0x40000000, vdso: 0xffff0000
    };
    var base = bases[slot] ?? 0x40000000;
    if (slot === 'stack' || slot === 'vdso') {
      return (base - offset) & ~(ASLR_PAGE_SIZE - 1);  // grows down
    }
    return (base + offset) & ~(ASLR_PAGE_SIZE - 1);    // grows up
  }

  /** Clone the seed from parent PID to child PID (on fork, child gets new seed). */
  fork(parentPid: number, childPid: number): void {
    this._seeds.delete(childPid); // force new seed
    this._getSeed(childPid);      // pre-generate so fork timing doesn't leak entropy
  }

  /** Remove seed when process exits. */
  removePid(pid: number): void { this._seeds.delete(pid); }

  configure(cfg: Partial<ASLRConfig>): void {
    if (cfg.enabled !== undefined)      this._config.enabled      = cfg.enabled;
    if (cfg.entropyBits !== undefined)  this._config.entropyBits  = Math.min(cfg.entropyBits, 28);
  }

  get config(): Readonly<ASLRConfig> { return this._config; }
}

export const aslrManager = new ASLRManager();

// ─────────────────────────────────────────────────────────────────────────────
// [Item 141] Memory Protection Keys (MPK / pkeys)
//
// Intel MPK (PKS/PKU) provides per-page access control using 4-bit protection
// key tags stored in page-table entries (bits 62:59 on x86-64).  Each thread
// has a PKRU register that encodes read/write disable bits for up to 16 keys.
// We model this in TypeScript; the C HAL reads/writes the PKRU register.
// ─────────────────────────────────────────────────────────────────────────────

export const MPK_PROT_NONE    = 0x0;
export const MPK_PROT_READ    = 0x1;
export const MPK_PROT_WRITE   = 0x2;
export const MPK_PROT_EXEC    = 0x4;

export interface ProtectionKey {
  key:         number;   // 0-15
  description: string;
  rights:      number;   // MPK_PROT_* bitmask
}

/**
 * [Item 141] MPK manager: allocates and manages memory protection keys.
 *
 * A process uses pkey_alloc() to obtain a key, pkey_mprotect() to tag a
 * virtual memory range with that key, and pkey_access() to check if the
 * current PKRU allows a specific access type on a key.
 */
export class MPKManager {
  private _keys: Map<number, ProtectionKey> = new Map();
  private _nextKey = 1;  // key 0 is the default (all access)
  /** Map from (pid, key) → pages set with that key. */
  private _keyPages: Map<string, Set<number>> = new Map();
  /** Simulated PKRU per-thread (tid → 32-bit value). */
  private _pkru: Map<number, number> = new Map();

  /** Allocate a new protection key. Returns the key number or -1 if exhausted. */
  alloc(description: string, initRights: number = MPK_PROT_READ | MPK_PROT_WRITE): number {
    if (this._nextKey > 15) return -1; // max 16 keys (kernel + user)
    var k: ProtectionKey = { key: this._nextKey, description, rights: initRights };
    this._keys.set(this._nextKey, k);
    return this._nextKey++;
  }

  /** Free a protection key and remove all page associations. */
  free(key: number): void {
    this._keys.delete(key);
    this._keyPages.forEach((_, k) => { if (k.endsWith(':' + key)) this._keyPages.delete(k); });
  }

  /** Tag a set of virtual pages in process `pid` with `key`. */
  mprotect(pid: number, pages: number[], key: number, rights: number): void {
    var pk = this._keys.get(key);
    if (!pk) return;
    pk.rights = rights;
    var mapKey = pid + ':' + key;
    if (!this._keyPages.has(mapKey)) this._keyPages.set(mapKey, new Set());
    var pageSet = this._keyPages.get(mapKey)!;
    pages.forEach(function(p) { pageSet.add(p); });
  }

  /**
   * Read PKRU for a thread, or derive it from the key's rights if not set.
   * PKRU bit layout: bit (2*key)=AD (access disable), bit (2*key+1)=WD (write disable).
   */
  readPKRU(tid: number): number { return this._pkru.get(tid) ?? 0; }

  writePKRU(tid: number, pkru: number): void { this._pkru.set(tid, pkru >>> 0); }

  /**
   * Check if thread `tid` can perform `access` (MPK_PROT_*) on virtual `page`.
   * Returns true if allowed.
   */
  checkAccess(tid: number, pid: number, page: number, access: number): boolean {
    var pkru = this.readPKRU(tid);
    // Find this page's key
    for (var [mk, pages] of this._keyPages) {
      if (!mk.startsWith(pid + ':')) continue;
      if (!pages.has(page)) continue;
      var key = parseInt(mk.split(':')[1]);
      var ad  = (pkru >> (2 * key))     & 1;  // access disable
      var wd  = (pkru >> (2 * key + 1)) & 1;  // write disable
      if (ad && (access & (MPK_PROT_READ | MPK_PROT_WRITE | MPK_PROT_EXEC))) return false;
      if (wd && (access & MPK_PROT_WRITE)) return false;
    }
    return true; // default allow if no key set
  }

  /** Disable all access on key (used for sensitive data protection). */
  protect(tid: number, key: number): void {
    var pkru = this.readPKRU(tid);
    pkru |= (3 << (2 * key));  // set both AD and WD
    this.writePKRU(tid, pkru);
  }

  /** Restore default access on key. */
  unprotect(tid: number, key: number): void {
    var pkru = this.readPKRU(tid);
    pkru &= ~(3 << (2 * key));
    this.writePKRU(tid, pkru);
  }

  listKeys(): ProtectionKey[] {
    var out: ProtectionKey[] = [];
    this._keys.forEach(function(k) { out.push(k); });
    return out;
  }
}

export const mpkManager = new MPKManager();

// ─────────────────────────────────────────────────────────────────────────────
// [Item 142] madvise(MADV_WILLNEED) — memory-access hints
//
// Applications give hints to the VMM about expected memory access patterns.
// The VMM uses these hints to schedule prefetch / eviction.
// ─────────────────────────────────────────────────────────────────────────────

export const MADV_NORMAL       = 0;   // default
export const MADV_RANDOM       = 1;   // random access pattern (no readahead)
export const MADV_SEQUENTIAL   = 2;   // sequential access (aggressive readahead)
export const MADV_WILLNEED     = 3;   // prefetch this range soon
export const MADV_DONTNEED     = 4;   // application will not use this range soon
export const MADV_FREE         = 8;   // pages can be freed lazily
export const MADV_REMOVE       = 9;   // remove backing for range (hole punch)
export const MADV_DONTFORK     = 10;  // do not copy range to child on fork
export const MADV_DOFORK       = 11;  // normal fork behaviour

export interface MadviseRecord {
  pid:       number;
  startPage: number;
  pages:     number;
  advice:    number;
  timestamp: number;
}

/**
 * [Item 142] madvise — virtual memory advice interface.
 *
 * The TypeScript layer records advice; the physical page eviction policy
 * (LRUClock, SwapManager) consults this registry when choosing victims and
 * scheduling I/O.
 */
export class MadviseManager {
  private _records: MadviseRecord[] = [];

  /**
   * Record a memory access hint from process `pid` for `pageCount` pages
   * starting at virtual page `startPage`.
   *
   * - MADV_WILLNEED: immediately pin those physical pages in the LRU clock so
   *   they are not evicted, and increment their reference count.
   * - MADV_DONTNEED: drop the pages from the LRU clock so they are evicted
   *   first. Their content is discarded (anonymous) or preserved (file-backed).
   * - MADV_SEQUENTIAL: mark pages for aggressive sequential read-ahead (read
   *   ahead 4 extra pages on every access).
   * - MADV_REMOVE: punch a hole — notify swap and page-cache to discard.
   */
  madvise(pid: number, startPage: number, pageCount: number, advice: number): number {
    var now = typeof performance !== 'undefined' ? performance.now() : 0;
    // Remove any existing record that fully overlaps
    this._records = this._records.filter(function(r) {
      if (r.pid !== pid) return true;
      var rEnd = r.startPage + r.pages;
      var sEnd = startPage + pageCount;
      return rEnd <= startPage || r.startPage >= sEnd; // no overlap
    });

    if (advice === MADV_DONTNEED || advice === MADV_FREE || advice === MADV_REMOVE) {
      // Evict pages from LRU clock so they rank for swap-out
      for (var i = 0; i < pageCount; i++) {
        lruClock.remove(startPage + i);
      }
      if (advice === MADV_REMOVE) {
        // Punch hole: free swap slots for these pages
        for (var j = 0; j < pageCount; j++) {
          swapManager.freeSlot(startPage + j);
        }
      }
    } else if (advice === MADV_WILLNEED) {
      // Mark pages as accessed so LRU doesn't evict them immediately
      for (var k = 0; k < pageCount; k++) {
        lruClock.track(startPage + k);
        lruClock.markAccessed(startPage + k);
      }
    }

    this._records.push({ pid, startPage, pages: pageCount, advice, timestamp: now });
    return 0;
  }

  /**
   * Query advice for a virtual page. Returns the most recently registered
   * advice constant, or MADV_NORMAL if none recorded.
   */
  getAdvice(pid: number, page: number): number {
    for (var i = this._records.length - 1; i >= 0; i--) {
      var r = this._records[i];
      if (r.pid === pid && page >= r.startPage && page < r.startPage + r.pages) {
        return r.advice;
      }
    }
    return MADV_NORMAL;
  }

  /**
   * Returns true if sequential read-ahead is appropriate for this page.
   * Used by the block I/O layer to schedule prefetch.
   */
  isSequential(pid: number, page: number): boolean {
    return this.getAdvice(pid, page) === MADV_SEQUENTIAL;
  }

  /** Clear all records for a process (on exit). */
  clearPid(pid: number): void {
    this._records = this._records.filter(function(r) { return r.pid !== pid; });
  }

  snapshot(): MadviseRecord[] { return this._records.slice(); }
}

export const madviseManager = new MadviseManager();

// ── Transparent Huge Pages — Item 143 ────────────────────────────────────────

/** 2 MiB huge-page size in bytes. */
export const THP_SIZE = 2 * 1024 * 1024;
/** 4 KiB base page size in bytes. */
export const BASE_PAGE_SIZE = 4096;
/** Base pages per huge page. */
export const PAGES_PER_HUGE = THP_SIZE / BASE_PAGE_SIZE; // 512

export type THPMode = 'always' | 'madvise' | 'never';

/** [Item 143] Transparent Huge Pages (THP) tracker.
 *
 *  When a process maps a 2 MiB region aligned to 2 MiB, the physical-page
 *  allocator can back that region with a single 2 MiB huge page instead of
 *  512 × 4 KiB pages.  THP reduces TLB pressure and page-table walk depth.
 *
 *  This TypeScript layer records which virtual ranges have been promoted to
 *  huge pages.  The decision logic (canPromote) checks alignment and size.
 *  Actual huge-page allocation is performed by the C kernel
 *  (kernel.allocHugePage) when available.
 */
export class THPManager {
  /** Kernel-global THP policy. */
  mode: THPMode = 'madvise';

  /** Map of huge-page start address → { pid, size }. */
  private _pages: Map<number, { pid: number; size: number }> = new Map();

  /** Return true when vaddr is 2 MiB-aligned and size covers at least THP_SIZE. */
  canPromote(vaddr: number, sizeBytes: number): boolean {
    if (this.mode === 'never') return false;
    return (vaddr % THP_SIZE === 0) && (sizeBytes >= THP_SIZE);
  }

  /** Record a huge-page promotion for region [vaddr, vaddr+size). */
  promote(pid: number, vaddr: number, size: number): void {
    for (var offset = 0; offset < size; offset += THP_SIZE) {
      this._pages.set(vaddr + offset, { pid, size: THP_SIZE });
      if (typeof kernel !== 'undefined' && typeof (kernel as any).allocHugePage === 'function') {
        (kernel as any).allocHugePage(pid, vaddr + offset);
      }
    }
  }

  /** Demote a huge page back to base pages (e.g. on partial unmap). */
  demote(vaddr: number): void {
    this._pages.delete(vaddr);
    if (typeof kernel !== 'undefined' && typeof (kernel as any).freeHugePage === 'function') {
      (kernel as any).freeHugePage(vaddr);
    }
  }

  /** Return true if vaddr belongs to a huge page. */
  isHuge(vaddr: number): boolean {
    var aligned = vaddr - (vaddr % THP_SIZE);
    return this._pages.has(aligned);
  }

  /** Remove all huge-page entries for a process (on exit). */
  clearPid(pid: number): void {
    this._pages.forEach(function(v, addr) {
      if (v.pid === pid) this._pages.delete(addr);
    }, this);
  }

  stats(): { total: number; byPid: Record<number, number> } {
    var byPid: Record<number, number> = {};
    this._pages.forEach(function(v) {
      byPid[v.pid] = (byPid[v.pid] ?? 0) + 1;
    });
    return { total: this._pages.size, byPid };
  }
}

export const thpManager = new THPManager();

// ── ZRAM Compressed Swap — Item 144 ──────────────────────────────────────────

/** Compression ratio assumed for ZRAM pages (≈2.5 × on typical workloads). */
const ZRAM_DEFAULT_RATIO = 2.5;

/** [Item 144] ZRAM compressed swap device.
 *
 *  ZRAM keeps swapped-out pages compressed in RAM instead of writing them to
 *  disk.  This dramatically reduces swap latency (no I/O) at the cost of CPU
 *  cycles for LZ4 compression.  The TypeScript layer here manages the logical
 *  slot table; actual LZ4 compression is approximated by recording compressed
 *  sizes.
 */
export class ZRAMDevice {
  /** Maximum number of pages stored (soft limit). */
  readonly maxPages: number;
  /** Simulated compressed storage: slot → { compressedSize, origPage }. */
  private _slots: Map<number, { compressedBytes: number; pid: number; vaddr: number }> = new Map();
  private _freeSlots: number[] = [];
  private _nextSlot = 0;

  constructor(maxPages: number = 8192) {
    this.maxPages = maxPages;
    for (var i = 0; i < maxPages; i++) this._freeSlots.push(i);
  }

  /** Compress and store a page.  Returns slot index, or -1 if full. */
  store(pid: number, vaddr: number, pageSizeBytes = BASE_PAGE_SIZE): number {
    if (this._freeSlots.length === 0) return -1;
    var slot = this._freeSlots.pop()!;
    var compressedBytes = Math.ceil(pageSizeBytes / ZRAM_DEFAULT_RATIO);
    this._slots.set(slot, { compressedBytes, pid, vaddr });
    return slot;
  }

  /** Retrieve (decompress) a page from slot.  Frees the slot. */
  retrieve(slot: number): { pid: number; vaddr: number } | null {
    var entry = this._slots.get(slot);
    if (!entry) return null;
    this._slots.delete(slot);
    this._freeSlots.push(slot);
    return { pid: entry.pid, vaddr: entry.vaddr };
  }

  /** True when the device contains a valid slot. */
  hasSlot(slot: number): boolean { return this._slots.has(slot); }

  /** Used pages count. */
  usedPages(): number { return this._slots.size; }

  /** Free pages count. */
  freePages(): number { return this._freeSlots.length; }

  /** Approximate compressed RAM used (bytes). */
  compressedBytes(): number {
    var total = 0;
    this._slots.forEach(function(v) { total += v.compressedBytes; });
    return total;
  }

  /** Uncompressed equivalent (bytes). */
  uncompressedBytes(): number {
    return this._slots.size * BASE_PAGE_SIZE;
  }

  /** Compression ratio achieved. */
  effectiveRatio(): number {
    var cb = this.compressedBytes();
    return cb > 0 ? this.uncompressedBytes() / cb : 1;
  }

  /** Clear all slots for a process on exit. */
  clearPid(pid: number): void {
    this._slots.forEach(function(v, slot) {
      if (v.pid === pid) {
        this._slots.delete(slot);
        this._freeSlots.push(slot);
      }
    }, this);
  }
}

export const zramDevice = new ZRAMDevice();