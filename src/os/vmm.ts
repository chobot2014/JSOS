/**
 * JSOS Virtual Memory Manager
 *
 * Implements virtual memory with:
 * - Page tables
 * - Virtual-to-physical address translation
 * - Memory protection
 * - Page fault handling
 * - Memory-mapped I/O
 */

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

export class VirtualMemoryManager {
  private pageSize = 4096; // 4KB pages
  private pageTable = new Map<number, PageTableEntry>();
  private memoryRegions: MemoryRegion[] = [];
  private nextVirtualAddress = 0x100000; // Start after kernel space
  private physicalMemorySize = 16 * 1024 * 1024; // 16MB
  private allocatedPhysicalPages = new Set<number>();

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
   * Allocate virtual memory
   */
  allocateVirtualMemory(size: number, permissions: MemoryRegion['permissions'] = 'rw'): number | null {
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
        user: true,
        accessed: false,
        dirty: false,
        physicalAddress: physicalPages[i] * this.pageSize,
        virtualAddress: virtualPage * this.pageSize,
        size: this.pageSize
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
   * Check if memory access is valid
   */
  isValidAccess(virtualAddress: number, size: number, write: boolean = false): boolean {
    for (let addr = virtualAddress; addr < virtualAddress + size; addr += this.pageSize) {
      const translation = this.translateAddress(addr);
      if (!translation.valid) return false;

      if (write && !translation.permissions.includes('w')) return false;
    }
    return true;
  }

  /**
   * Handle page fault
   */
  handlePageFault(virtualAddress: number): boolean {
    const pageNumber = Math.floor(virtualAddress / this.pageSize);
    const pte = this.pageTable.get(pageNumber);

    if (!pte) {
      // Page not mapped - this is a real fault
      return false;
    }

    if (!pte.present) {
      // Page is swapped out - would need swap system
      // For now, just mark as present
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
}

export const vmm = new VirtualMemoryManager();