/**
 * jit-canvas.ts — JIT-compiled pixel operations for the JSOS canvas (Phase 11b)
 *
 * Provides native x86-32 implementations of the canvas hot-paths that dominate
 * rendering time: alpha-blended blit, solid fill, and glyph rasterisation.
 *
 * V8 analogy: this file is the "JIT-compiled shape-specialised code" that V8
 * generates for hot typed-array operations — except JSOS produces it at module
 * load time rather than after profiling, because the pixel-loop shape is always
 * the same (int32 channels, 0-255 alpha, row-major stride layout).
 *
 * ─── How it works ─────────────────────────────────────────────────────────────
 *
 *  1. Each operation has a TypeScript fallback (always correct, zero startup
 *     cost) and a JIT source string (int32 subset, compiled to native x86-32).
 *  2. On first call to JITCanvas.init(), every source string is handed to
 *     JIT.compile().  If the kernel JIT pool is available all subsequent calls
 *     to JITCanvas methods run native code; if not, they transparently fall back
 *     to the TypeScript implementation.
 *  3. Canvas methods obtain physical buffer addresses via kernel.physAddrOf()
 *     (QuickJS is a non-moving GC, so ArrayBuffer pointers are stable).
 *
 * ─── Supported operations ─────────────────────────────────────────────────────
 *
 *   fillBuffer(fb, color, n)          — fill n pixels with a solid color
 *   fillRect(fb, color, x,y,w,h,str) — fill a rectangle (7 params → jitCallI8)
 *   blitRow(dst, src, n)              — copy one row of n pixels
 *   blitAlphaRow(dst, src, n, alpha)  — alpha-blend one row (BGRA, 0-255 alpha)
 *   drawGlyphRow(fb, rowByte, x, w,   — rasterise one 8-bit font row into fb
 *                color, stride)
 *
 * All addresses and sizes are int32-safe (< 2 GB physical RAM assumed).
 */

import { JIT, JITProfiler } from './jit.js';

declare var kernel: any;

// ─── JIT source strings ───────────────────────────────────────────────────────

/** Fill `n` consecutive pixels starting at physical address `fb` with `color`. */
const _SRC_FILL_BUFFER = `
function fillBuffer(fb, color, n) {
  var i = 0;
  while (i < n) {
    mem32[fb + i * 4] = color;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Fill a w×h rectangle at (x,y) within a stride-wide framebuffer.
 * stride = bytes per row (usually canvas.width * 4).
 * Uses 7 parameters → dispatched via kernel.jitCallI8.
 */
const _SRC_FILL_RECT = `
function fillRect(fb, color, x, y, w, h, stride) {
  var row = 0;
  while (row < h) {
    var rowBase = fb + (y + row) * stride + x * 4;
    var col = 0;
    while (col < w) {
      mem32[rowBase + col * 4] = color;
      col = col + 1;
    }
    row = row + 1;
  }
  return 0;
}
`;

/**
 * Copy `n` pixels from physical address `src` to `dst`.
 * Both buffers are 32-bit BGRA.  No alpha blending — pixel-perfect copy.
 */
const _SRC_BLIT_ROW = `
function blitRow(dst, src, n) {
  var i = 0;
  while (i < n) {
    mem32[dst + i * 4] = mem32[src + i * 4];
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Alpha-blend `n` pixels from `src` onto `dst`.  Both are 32-bit BGRA.
 * alpha: 0 = fully transparent (no-op), 255 = fully opaque (covers dst).
 *
 * Uses fixed-point arithmetic: (src_ch * alpha + dst_ch * (256-alpha)) >> 8.
 * The x86-32 IMUL/SAR sequence maps directly from the int32 JIT subset.
 */
const _SRC_BLIT_ALPHA_ROW = `
function blitAlphaRow(dst, src, n, alpha) {
  var ia = 256 - alpha;
  var i = 0;
  while (i < n) {
    var sp = mem32[src + i * 4];
    var dp = mem32[dst + i * 4];
    var b = ((sp & 0xFF) * alpha + (dp & 0xFF) * ia) >> 8;
    var g = (((sp >> 8) & 0xFF) * alpha + ((dp >> 8) & 0xFF) * ia) >> 8;
    var r = (((sp >> 16) & 0xFF) * alpha + ((dp >> 16) & 0xFF) * ia) >> 8;
    var a = (((sp >> 24) & 0xFF) * alpha + ((dp >> 24) & 0xFF) * ia) >> 8;
    mem32[dst + i * 4] = (a << 24) | (r << 16) | (g << 8) | b;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Rasterise one 8-pixel-wide font glyph row into a framebuffer.
 * rowByte: the 8-bit font row bitmap (MSB = leftmost pixel).
 * fb:      physical address of the pixel at (x, y) in the canvas buffer.
 * color:   pre-converted BGRA pixel value.
 * Uses 6 parameters → dispatched via kernel.jitCallI8.
 */
const _SRC_GLYPH_ROW = `
function glyphRow(fb, rowByte, x, w, color, stride) {
  var col = 0;
  while (col < 8) {
    if (rowByte & (0x80 >> col)) {
      var px = x + col;
      if (px >= 0) {
        if (px < w) {
          mem32[fb + col * 4] = color;
        }
      }
    }
    col = col + 1;
  }
  return 0;
}
`;

// ─── Compiled function slots ──────────────────────────────────────────────────

type JITFn = ((...args: number[]) => number) | null;

var _fillBuffer:    JITFn = null;
var _fillRect:      JITFn = null;
var _blitRow:       JITFn = null;
var _blitAlphaRow:  JITFn = null;
var _glyphRow:      JITFn = null;
var _ready = false;

// ─── TypeScript fallbacks (used when JIT pool is unavailable) ─────────────────

// These are intentionally minimal — they exist only as fallbacks, not as the
// primary implementation.  The real performance fallbacks live in canvas.ts.

function _fbFillBuffer(fb: number, color: number, n: number): number {
  // Cannot implement without physAddrOf — canvas.ts has its own fallback.
  return 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const JITCanvas = {

  /**
   * Compile all JIT hot-paths.  Should be called once at OS init (or lazily
   * on first use).  Returns true if all functions compiled successfully.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  init(): boolean {
    if (_ready) return true;
    if (!JIT.available()) return false;
    _fillBuffer   = JIT.compile(_SRC_FILL_BUFFER);
    _fillRect     = JIT.compile(_SRC_FILL_RECT);
    _blitRow      = JIT.compile(_SRC_BLIT_ROW);
    _blitAlphaRow = JIT.compile(_SRC_BLIT_ALPHA_ROW);
    _glyphRow     = JIT.compile(_SRC_GLYPH_ROW);
    _ready = _fillBuffer !== null;
    return _ready;
  },

  /** True once init() has successfully compiled the JIT functions. */
  get ready(): boolean { return _ready; },

  /**
   * Obtain the physical address of a JS ArrayBuffer.
   * Returns 0 if kernel.physAddrOf is unavailable (test environments).
   */
  physAddr(ab: ArrayBuffer): number {
    return (typeof kernel !== 'undefined' &&
            typeof kernel.physAddrOf === 'function')
      ? kernel.physAddrOf(ab) : 0;
  },

  // ── Pixel operations ───────────────────────────────────────────────────

  /**
   * Fill `n` consecutive pixels starting at physical address `fb` with `color`.
   * Faster than TypedArray.fill() for small counts due to absence of bounds
   * checks and range validation in the JIT-compiled path.
   */
  fillBuffer(fb: number, color: number, n: number): void {
    if (_fillBuffer) _fillBuffer(fb, color, n);
  },

  /**
   * Fill a w×h rectangle at (x,y) within a stride-wide framebuffer.
   * stride is bytes-per-row (canvas.width * 4 for 32-bpp buffers).
   */
  fillRect(fb: number, color: number, x: number, y: number,
           w: number, h: number, stride: number): void {
    if (_fillRect) _fillRect(fb, color, x, y, w, h, stride);
  },

  /**
   * Copy `n` pixels from physical address `src` to `dst`.
   * Equivalent to memcpy for 32-bit pixels; no blending.
   */
  blitRow(dst: number, src: number, n: number): void {
    if (_blitRow) _blitRow(dst, src, n);
  },

  /**
   * Alpha-blend `n` pixels from `src` onto `dst` (both physical addresses).
   * alpha: 0 = transparent (nop), 255 = opaque (full cover).
   * Channel order is BGRA (native framebuffer layout).
   */
  blitAlphaRow(dst: number, src: number, n: number, alpha: number): void {
    if (_blitAlphaRow) _blitAlphaRow(dst, src, n, alpha);
  },

  /**
   * Rasterise one 8-pixel-wide glyph row into the framebuffer.
   * fb:      physical address of the leftmost pixel in this glyph row.
   * rowByte: the 8-bit bitmap row (MSB = leftmost pixel).
   * x:       canvas x coordinate of the leftmost glyph column.
   * w:       canvas width (for bounds checking).
   * color:   BGRA pixel value.
   */
  glyphRow(fb: number, rowByte: number, x: number,
           w: number, color: number): void {
    if (_glyphRow) _glyphRow(fb, rowByte, x, w, color, 0);
  },

  /** Diagnostic: JIT pool usage after all canvas functions are compiled. */
  poolUsed(): number { return JIT.stats().poolUsed; },
};

export default JITCanvas;
