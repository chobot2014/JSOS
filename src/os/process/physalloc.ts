/**
 * JSOS Physical Page Frame Allocator — Phase 4
 *
 * Manages the physical address space as a bitmap of 4 KB page frames.
 * Initialised from the multiboot2 memory map returned by kernel.getMemoryMap().
 *
 * Design:
 *  - One bit per 4 KB frame; 0 = free, 1 = used.
 *  - On init, ALL bits are set (used); only type-1 (usable RAM) regions
 *    are cleared.  Then the kernel image region is re-marked used.
 *  - alloc(n) does a first-fit search for n contiguous free frames.
 *  - free(addr, n) releases n frames starting at the aligned address.
 *
 * Architecture notes:
 *  - Addresses are 32-bit (i686).  Regions above 4 GB are silently ignored.
 *  - The bitmap itself is allocated from the QuickJS heap (Uint8Array).
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Page size — 4 KB */
const PAGE_SIZE = 4096;

/** Kernel reserved range: first KERNEL_RESERVED_PAGES frames are never given out.
 *  Covers the kernel binary + BSS heap region (first 32 MB). */
const KERNEL_RESERVED_MB = 32;

export class PhysicalAllocator {
  private _bitmap: Uint8Array = new Uint8Array(0);
  private _totalFrames = 0;
  private _freeFrames  = 0;

  /** Must be called once before alloc/free are used. */
  init(): void {
    var mmap = kernel.getMemoryMap();

    // Find the highest address reported in usable (type=1) entries.
    // This gives us the total physical address space we need to track.
    var maxAddr = 0;
    for (var i = 0; i < mmap.length; i++) {
      var e = mmap[i];
      if (e.type === 1 && e.baseHi === 0 && e.lenHi === 0) {
        var end = e.base + e.length;
        if (end > maxAddr) maxAddr = end;
      }
    }

    if (maxAddr === 0) {
      // No usable RAM found — fall back to 16 MB minimum.
      maxAddr = 16 * 1024 * 1024;
    }

    this._totalFrames = Math.floor(maxAddr / PAGE_SIZE);
    var bitmapBytes   = Math.ceil(this._totalFrames / 8);

    // Allocate bitmap; initialise to all-used (0xFF = 8 frames all used).
    this._bitmap = new Uint8Array(bitmapBytes);
    for (var j = 0; j < bitmapBytes; j++) this._bitmap[j] = 0xFF;

    // Mark usable regions free.
    for (var k = 0; k < mmap.length; k++) {
      var entry = mmap[k];
      if (entry.type !== 1) continue;        // skip non-RAM regions
      if (entry.baseHi !== 0) continue;      // skip >4 GB regions
      var regionLen = entry.lenHi !== 0 ? maxAddr : entry.length;
      var startFrame = Math.ceil(entry.base / PAGE_SIZE);
      var endFrame   = Math.floor((entry.base + regionLen) / PAGE_SIZE);
      for (var f = startFrame; f < endFrame && f < this._totalFrames; f++) {
        this._clearBit(f);
      }
    }

    // Re-mark first KERNEL_RESERVED_MB as used (kernel + heap).
    var reservedFrames = Math.ceil(KERNEL_RESERVED_MB * 1024 * 1024 / PAGE_SIZE);
    for (var r = 0; r < reservedFrames && r < this._totalFrames; r++) {
      this._setBit(r);
    }

    // Count free frames.
    this._freeFrames = 0;
    for (var q = 0; q < this._totalFrames; q++) {
      if (!this._testBit(q)) this._freeFrames++;
    }
  }

  // ── Statistics ────────────────────────────────────────────────────────

  totalPages(): number { return this._totalFrames; }
  freePages():  number { return this._freeFrames; }
  usedPages():  number { return this._totalFrames - this._freeFrames; }
  /** Total usable free bytes */
  available():  number { return this._freeFrames * PAGE_SIZE; }

  /** Human-readable total RAM in MB (rounded to nearest MB) */
  totalMB(): number {
    return Math.round(this._totalFrames * PAGE_SIZE / (1024 * 1024));
  }

  // ── Allocation ────────────────────────────────────────────────────────

  /**
   * Allocate `pages` contiguous 4 KB frames.
   * Returns the physical base address of the first frame.
   * Throws if not enough contiguous free frames are available.
   */
  alloc(pages: number): number {
    var start = this._findFreeRun(pages);
    if (start < 0) throw new Error('PhysicalAllocator: out of contiguous frames');
    for (var i = 0; i < pages; i++) {
      this._setBit(start + i);
    }
    this._freeFrames -= pages;
    return start * PAGE_SIZE;
  }

  /**
   * Release `pages` frames starting at physical address `addr`.
   * addr must be page-aligned.
   */
  free(addr: number, pages: number): void {
    var frame = Math.floor(addr / PAGE_SIZE);
    for (var i = 0; i < pages; i++) {
      var f = frame + i;
      if (f < this._totalFrames && this._testBit(f)) {
        this._clearBit(f);
        this._freeFrames++;
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _findFreeRun(count: number): number {
    var runStart = -1;
    var runLen   = 0;
    for (var f = 0; f < this._totalFrames; f++) {
      if (!this._testBit(f)) {
        if (runLen === 0) runStart = f;
        runLen++;
        if (runLen >= count) return runStart;
      } else {
        runStart = -1;
        runLen   = 0;
      }
    }
    return -1;
  }

  private _testBit(frame: number): boolean {
    var byte_ = Math.floor(frame / 8);
    var bit   = frame % 8;
    return (this._bitmap[byte_] & (1 << bit)) !== 0;
  }

  private _setBit(frame: number): void {
    var byte_ = Math.floor(frame / 8);
    var bit   = frame % 8;
    this._bitmap[byte_] |= (1 << bit);
  }

  private _clearBit(frame: number): void {
    var byte_ = Math.floor(frame / 8);
    var bit   = frame % 8;
    this._bitmap[byte_] &= ~(1 << bit);
  }
}

/** Singleton physical allocator — initialised during Phase 4 boot. */
export const physAlloc = new PhysicalAllocator();
