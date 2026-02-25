/**
 * JSOS Physical Page Frame Allocator — Phase 4
 *
 * Manages the physical address space as a bitmap of 4 KB page frames.
 * Uses kernel.getRamBytes() to determine total RAM without iterating 
 * the multiboot2 mmap JS array (which has a known access hang).
 *
 * Design:
 *  - One bit per 4 KB frame; 0 = free, 1 = used.
 *  - Frames 0..KERNEL_END_FRAME-1 are permanently reserved.
 *  - alloc(n) does a first-fit search for n contiguous free frames.
 *  - free(addr, n) releases n frames starting at addr.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Page size — 4 KB */
const PAGE_SIZE = 4096;

/**
 * First allocatable frame.
 * Must be above the entire kernel binary + 256 MB BSS heap in linker.ld.
 * kernel loads at 1 MB; code/data ~16 MB max; heap 256 MB → top ~273 MB.
 * We reserve 320 MB (81920 frames) to give a comfortable margin.
 */
const KERNEL_END_FRAME = 81920;

export class PhysicalAllocator {
  private _bitmap: Uint8Array = new Uint8Array(0);
  private _totalFrames = 0;
  private _freeFrames  = 0;

  /** Must be called once before alloc/free are used. */
  init(): void {
    // Use the simple C binding that computes max RAM in a single C call,
    // avoiding the problematic JS array-of-objects iteration.
    var ramBytes = kernel.getRamBytes();
    if (!ramBytes || ramBytes < 1) {
      ramBytes = 3 * 1024 * 1024 * 1024;  // fallback: 3 GB (conservative for a consumer PC)
    }

    // Round up to the nearest MB boundary so page counts are clean multiples.
    var MB = 1024 * 1024;
    var ramBytesMB = Math.ceil(ramBytes / MB) * MB;

    this._totalFrames = Math.floor(ramBytesMB / PAGE_SIZE);
    var bitmapBytes   = Math.ceil(this._totalFrames / 8);

    // Bitmap: all 1 (used) to start.
    this._bitmap = new Uint8Array(bitmapBytes);
    for (var j = 0; j < bitmapBytes; j++) this._bitmap[j] = 0xFF;

    // Free frames from KERNEL_END_FRAME onward.
    // Work at byte level where possible for efficiency: full bytes = 0x00.
    var freeStartByte = Math.ceil(KERNEL_END_FRAME / 8);
    var freeEndByte   = Math.floor(this._totalFrames / 8);
    // Clear full bytes
    for (var b = freeStartByte; b < freeEndByte; b++) this._bitmap[b] = 0x00;
    // Clear partial bits in boundary bytes
    var startBit = KERNEL_END_FRAME % 8;
    if (startBit !== 0) {
      // The byte at freeStartByte - 1 has some bits to clear
      var mask = 0xFF << startBit;
      this._bitmap[freeStartByte - 1] &= ~mask;
    }
    var endBit = this._totalFrames % 8;
    if (endBit !== 0 && freeEndByte < bitmapBytes) {
      // The last partial byte: clear only bits 0..(endBit-1)
      var endMask = (1 << endBit) - 1;
      this._bitmap[freeEndByte] &= ~endMask;
    }

    // Free frame count = total frames minus reserved kernel frames.
    this._freeFrames = this._totalFrames > KERNEL_END_FRAME
      ? this._totalFrames - KERNEL_END_FRAME
      : 0;
  }

  // ── Statistics ────────────────────────────────────────────────────────

  totalPages(): number { return this._totalFrames; }
  freePages():  number { return this._freeFrames; }
  usedPages():  number { return this._totalFrames - this._freeFrames; }
  available():  number { return this._freeFrames * PAGE_SIZE; }
  totalMB():    number {
    return Math.round(this._totalFrames * PAGE_SIZE / (1024 * 1024));
  }

  // ── Allocation ────────────────────────────────────────────────────────

  alloc(pages: number): number {
    var start = this._findFreeRun(pages);
    if (start < 0) throw new Error('PhysicalAllocator: out of contiguous frames');
    for (var i = 0; i < pages; i++) this._setBit(start + i);
    this._freeFrames -= pages;
    return start * PAGE_SIZE;
  }

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
    // Byte-level scan: skip fully-used bytes quickly.
    for (var f = KERNEL_END_FRAME; f < this._totalFrames; f++) {
      var byte_ = Math.floor(f / 8);
      // If full byte is 0xFF (all used), skip 8 frames at once.
      if ((f % 8) === 0 && this._bitmap[byte_] === 0xFF) {
        f += 7;  // 0 + 7 = 7; loop increments to 8 next
        runStart = -1;
        runLen   = 0;
        continue;
      }
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
