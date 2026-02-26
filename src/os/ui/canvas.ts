/**
 * JSOS Canvas — Phase 3 pixel rendering
 *
 * Maintains a 32-bit BGRA pixel buffer in a JS Uint32Array.
 * flip() transfers the buffer to the physical framebuffer via kernel.fbBlit().
 *
 * Colors are 32-bit values: 0xAARRGGBB (alpha unused by fbBlit — fully opaque).
 * Internally stored as BGRA (matching x86 little-endian framebuffer layout):
 *   0xAARRGGBB → stored as 0xBBGGRRAA in memory.
 * We keep everything as 0xAARRGGBB in the API and convert on blit.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;
import { JITCanvas } from '../process/jit-canvas.js';

// Lazy JIT init — called on first Canvas operation that can benefit.
var _jitReady = false;
function _ensureJIT(): boolean {
  if (_jitReady) return true;
  _jitReady = JITCanvas.init();
  return _jitReady;
}

export type PixelColor = number; // 0xAARRGGBB

// ── Color constants ────────────────────────────────────────────────────────

export const Colors = {
  BLACK:       0xFF000000,
  WHITE:       0xFFFFFFFF,
  RED:         0xFFFF0000,
  LIGHT_RED:   0xFFFF4444,
  GREEN:       0xFF00FF00,
  LIGHT_GREEN: 0xFF44FF44,
  BLUE:        0xFF0000FF,
  CYAN:        0xFF00FFFF,
  LIGHT_CYAN:  0xFF44FFFF,
  MAGENTA:     0xFFFF00FF,
  YELLOW:      0xFFFFFF00,
  DARK_GREY:   0xFF333333,
  LIGHT_GREY:  0xFFAAAAAA,
  ORANGE:      0xFFFF8800,
  DARK_BLUE:   0xFF000080,
  DARK_GREEN:  0xFF008000,
  TITLE_BG:    0xFF1A3A5C,
  DESKTOP_BG:  0xFF2D4F6B,
  TASKBAR_BG:  0xFF1A2B3C,
  EDITOR_BG:   0xFF1E1E2E,  // dark blue-grey editor/terminal background
  TRANSPARENT: 0x00000000,
};

// ── Bitmap Font (8×8, CP437 printable ASCII) ───────────────────────────────
//
// 95 characters, ASCII 0x20 (space) through 0x7E (~).
// Each character is 8 bytes; each byte is one row, MSB = leftmost pixel.
// Font data derived from the public-domain IBM PC 8×8 CGA ROM glyph set.

/* eslint-disable */
const FONT_DATA_8x8 = new Uint8Array([
  // 0x20 space
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  // 0x21 !
  0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x00,
  // 0x22 "
  0x6C,0x6C,0x24,0x00,0x00,0x00,0x00,0x00,
  // 0x23 #
  0x28,0xFE,0x28,0x28,0xFE,0x28,0x28,0x00,
  // 0x24 $
  0x10,0x7C,0xD0,0x7C,0x16,0x7C,0x10,0x00,
  // 0x25 %
  0x60,0x66,0x0C,0x18,0x30,0x66,0x06,0x00,
  // 0x26 &
  0x38,0x4C,0x38,0x76,0x4C,0x46,0x3B,0x00,
  // 0x27 '
  0x18,0x18,0x10,0x00,0x00,0x00,0x00,0x00,
  // 0x28 (
  0x0C,0x18,0x30,0x30,0x30,0x18,0x0C,0x00,
  // 0x29 )
  0x30,0x18,0x0C,0x0C,0x0C,0x18,0x30,0x00,
  // 0x2A *
  0x00,0x24,0x18,0xFF,0x18,0x24,0x00,0x00,
  // 0x2B +
  0x00,0x10,0x10,0x7C,0x10,0x10,0x00,0x00,
  // 0x2C ,
  0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x30,
  // 0x2D -
  0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00,
  // 0x2E .
  0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x00,
  // 0x2F /
  0x02,0x06,0x0C,0x18,0x30,0x60,0x40,0x00,
  // 0x30 0
  0x3C,0x46,0x4E,0x56,0x62,0x62,0x3C,0x00,
  // 0x31 1
  0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00,
  // 0x32 2
  0x3C,0x66,0x06,0x1C,0x30,0x66,0x7E,0x00,
  // 0x33 3
  0x3C,0x66,0x06,0x1C,0x06,0x66,0x3C,0x00,
  // 0x34 4
  0x0E,0x1E,0x36,0x66,0x7F,0x06,0x06,0x00,
  // 0x35 5
  0x7E,0x60,0x7C,0x06,0x06,0x66,0x3C,0x00,
  // 0x36 6
  0x1C,0x30,0x60,0x7C,0x66,0x66,0x3C,0x00,
  // 0x37 7
  0x7E,0x66,0x0C,0x18,0x18,0x18,0x18,0x00,
  // 0x38 8
  0x3C,0x66,0x66,0x3C,0x66,0x66,0x3C,0x00,
  // 0x39 9
  0x3C,0x66,0x66,0x3E,0x06,0x0C,0x38,0x00,
  // 0x3A :
  0x00,0x18,0x18,0x00,0x18,0x18,0x00,0x00,
  // 0x3B ;
  0x00,0x18,0x18,0x00,0x18,0x18,0x30,0x00,
  // 0x3C <
  0x06,0x0C,0x18,0x30,0x18,0x0C,0x06,0x00,
  // 0x3D =
  0x00,0x00,0x7E,0x00,0x7E,0x00,0x00,0x00,
  // 0x3E >
  0x60,0x30,0x18,0x0C,0x18,0x30,0x60,0x00,
  // 0x3F ?
  0x3C,0x66,0x06,0x0C,0x18,0x00,0x18,0x00,
  // 0x40 @
  0x3E,0x61,0x6D,0x6B,0x6E,0x60,0x3E,0x00,
  // 0x41 A
  0x3C,0x66,0x66,0x7E,0x66,0x66,0x66,0x00,
  // 0x42 B
  0x7C,0x66,0x66,0x7C,0x66,0x66,0x7C,0x00,
  // 0x43 C
  0x3C,0x66,0x60,0x60,0x60,0x66,0x3C,0x00,
  // 0x44 D
  0x78,0x6C,0x66,0x66,0x66,0x6C,0x78,0x00,
  // 0x45 E
  0x7E,0x60,0x60,0x7C,0x60,0x60,0x7E,0x00,
  // 0x46 F
  0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x00,
  // 0x47 G
  0x3C,0x66,0x60,0x6E,0x66,0x66,0x3C,0x00,
  // 0x48 H
  0x66,0x66,0x66,0x7E,0x66,0x66,0x66,0x00,
  // 0x49 I
  0x7E,0x18,0x18,0x18,0x18,0x18,0x7E,0x00,
  // 0x4A J
  0x1E,0x06,0x06,0x06,0x66,0x66,0x3C,0x00,
  // 0x4B K
  0x66,0x6C,0x78,0x70,0x78,0x6C,0x66,0x00,
  // 0x4C L
  0x60,0x60,0x60,0x60,0x60,0x60,0x7E,0x00,
  // 0x4D M
  0x63,0x77,0x7F,0x6B,0x63,0x63,0x63,0x00,
  // 0x4E N
  0x63,0x73,0x7B,0x6F,0x67,0x63,0x63,0x00,
  // 0x4F O
  0x3C,0x66,0x66,0x66,0x66,0x66,0x3C,0x00,
  // 0x50 P
  0x7C,0x66,0x66,0x7C,0x60,0x60,0x60,0x00,
  // 0x51 Q
  0x3C,0x66,0x66,0x66,0x6A,0x64,0x3A,0x00,
  // 0x52 R
  0x7C,0x66,0x66,0x7C,0x6C,0x66,0x66,0x00,
  // 0x53 S
  0x3C,0x66,0x60,0x3C,0x06,0x66,0x3C,0x00,
  // 0x54 T
  0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0x00,
  // 0x55 U
  0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0x00,
  // 0x56 V
  0x66,0x66,0x66,0x66,0x66,0x3C,0x18,0x00,
  // 0x57 W
  0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x00,
  // 0x58 X
  0x66,0x66,0x3C,0x18,0x3C,0x66,0x66,0x00,
  // 0x59 Y
  0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0x00,
  // 0x5A Z
  0x7E,0x06,0x0C,0x18,0x30,0x60,0x7E,0x00,
  // 0x5B [
  0x3C,0x30,0x30,0x30,0x30,0x30,0x3C,0x00,
  // 0x5C backslash
  0x40,0x60,0x30,0x18,0x0C,0x06,0x02,0x00,
  // 0x5D ]
  0x3C,0x0C,0x0C,0x0C,0x0C,0x0C,0x3C,0x00,
  // 0x5E ^
  0x10,0x38,0x6C,0x00,0x00,0x00,0x00,0x00,
  // 0x5F _
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xFF,
  // 0x60 `
  0x30,0x18,0x0C,0x00,0x00,0x00,0x00,0x00,
  // 0x61 a
  0x00,0x00,0x3C,0x06,0x3E,0x66,0x3B,0x00,
  // 0x62 b
  0x60,0x60,0x7C,0x66,0x66,0x66,0x7C,0x00,
  // 0x63 c
  0x00,0x00,0x3C,0x60,0x60,0x60,0x3C,0x00,
  // 0x64 d
  0x06,0x06,0x3E,0x66,0x66,0x66,0x3E,0x00,
  // 0x65 e
  0x00,0x00,0x3C,0x66,0x7E,0x60,0x3C,0x00,
  // 0x66 f
  0x1C,0x30,0x7C,0x30,0x30,0x30,0x30,0x00,
  // 0x67 g
  0x00,0x00,0x3E,0x66,0x66,0x3E,0x06,0x3C,
  // 0x68 h
  0x60,0x60,0x7C,0x66,0x66,0x66,0x66,0x00,
  // 0x69 i
  0x18,0x00,0x38,0x18,0x18,0x18,0x3C,0x00,
  // 0x6A j
  0x06,0x00,0x1E,0x06,0x06,0x66,0x66,0x3C,
  // 0x6B k
  0x60,0x60,0x66,0x6C,0x78,0x6C,0x66,0x00,
  // 0x6C l
  0x38,0x18,0x18,0x18,0x18,0x18,0x3C,0x00,
  // 0x6D m
  0x00,0x00,0x36,0x7F,0x6B,0x63,0x63,0x00,
  // 0x6E n
  0x00,0x00,0x7C,0x66,0x66,0x66,0x66,0x00,
  // 0x6F o
  0x00,0x00,0x3C,0x66,0x66,0x66,0x3C,0x00,
  // 0x70 p
  0x00,0x00,0x7C,0x66,0x66,0x7C,0x60,0x60,
  // 0x71 q
  0x00,0x00,0x3E,0x66,0x66,0x3E,0x06,0x06,
  // 0x72 r
  0x00,0x00,0x6C,0x76,0x60,0x60,0x60,0x00,
  // 0x73 s
  0x00,0x00,0x3E,0x60,0x3C,0x06,0x7C,0x00,
  // 0x74 t
  0x30,0x30,0x7C,0x30,0x30,0x36,0x1C,0x00,
  // 0x75 u
  0x00,0x00,0x66,0x66,0x66,0x66,0x3E,0x00,
  // 0x76 v
  0x00,0x00,0x66,0x66,0x66,0x3C,0x18,0x00,
  // 0x77 w
  0x00,0x00,0x63,0x6B,0x7F,0x36,0x22,0x00,
  // 0x78 x
  0x00,0x00,0x66,0x3C,0x18,0x3C,0x66,0x00,
  // 0x79 y
  0x00,0x00,0x66,0x66,0x3E,0x06,0x6C,0x38,
  // 0x7A z
  0x00,0x00,0x7E,0x0C,0x18,0x30,0x7E,0x00,
  // 0x7B {
  0x0E,0x18,0x18,0x70,0x18,0x18,0x0E,0x00,
  // 0x7C |
  0x18,0x18,0x18,0x18,0x18,0x18,0x18,0x00,
  // 0x7D }
  0x70,0x18,0x18,0x0E,0x18,0x18,0x70,0x00,
  // 0x7E ~
  0x00,0x32,0x4C,0x00,0x00,0x00,0x00,0x00,
]);
/* eslint-enable */

export class BitmapFont {
  readonly charWidth  = 8;
  readonly charHeight = 8;

  /** True pixel count for measuring text */
  measureText(text: string): { width: number; height: number } {
    return { width: text.length * this.charWidth, height: this.charHeight };
  }

  /**
   * Render a single character into a Canvas.
   * Pixels with bit set are drawn in `color`; others are left transparent.
   */
  renderChar(canvas: Canvas, x: number, y: number, ch: string, color: PixelColor): void {
    var code = ch.charCodeAt(0);
    if (code < 0x20 || code > 0x7E) return;
    // Delegate to Canvas.drawGlyph — color converted once for all 64 pixels
    canvas.drawGlyph(x, y, FONT_DATA_8x8, (code - 0x20) * 8, color);
  }
}

export const defaultFont = new BitmapFont();

// ── Canvas ─────────────────────────────────────────────────────────────────

export class Canvas {
  readonly width:  number;
  readonly height: number;

  /** Flat BGRA pixel buffer.  Index = y * width + x. */
  private _buf: Uint32Array;

  /** Offset into the screen framebuffer (for sub-canvases). */
  private _fb_x: number;
  private _fb_y: number;
  private _is_screen: boolean;
  /** True when this canvas wraps an external BSS buffer (no heap alloc, flip is NOP). */
  private _external: boolean;

  constructor(width: number, height: number, fb_x: number | ArrayBuffer = 0, fb_y = 0, is_screen = false) {
    this.width      = width;
    this.height     = height;
    if (fb_x instanceof ArrayBuffer) {
      /* External-buffer mode: wrap the caller-supplied BSS slab directly.        */
      /* Uint32Array view starts at offset 0 and covers exactly width*height px.  */
      this._buf      = new Uint32Array(fb_x, 0, width * height);
      this._external = true;
      this._fb_x     = 0;
      this._fb_y     = 0;
    } else {
      this._buf      = new Uint32Array(width * height);
      this._external = false;
      this._fb_x     = fb_x;
      this._fb_y     = fb_y;
    }
    this._is_screen = is_screen;
    this._buf.fill(0xFF000000); // default black
  }

  // ── Primitive helpers ──────────────────────────────────────────────────

  /** Convert AARRGGBB → BGRA (little-endian framebuffer word) */
  private static _bgra(color: PixelColor): number {
    var a = (color >>> 24) & 0xFF;
    var r = (color >>> 16) & 0xFF;
    var g = (color >>>  8) & 0xFF;
    var b = (color >>>  0) & 0xFF;
    return (a << 24) | (r << 16) | (g << 8) | b;
  }

  // ── Pixel access ──────────────────────────────────────────────────────

  setPixel(x: number, y: number, color: PixelColor): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this._buf[y * this.width + x] = Canvas._bgra(color);
  }

  getPixel(x: number, y: number): PixelColor {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return 0;
    var bgra = this._buf[y * this.width + x];
    var a = (bgra >>> 24) & 0xFF;
    var r = (bgra >>> 16) & 0xFF;
    var g = (bgra >>>  8) & 0xFF;
    var b = (bgra >>>  0) & 0xFF;
    return (a << 24) | (r << 16) | (g << 8) | b;
  }

  // ── Drawing primitives ────────────────────────────────────────────────

  clear(color: PixelColor = Colors.BLACK): void {
    var c = Canvas._bgra(color);
    // JIT fast-path: direct physical-memory fill (avoids JS array write loop)
    if (_ensureJIT()) {
      var fb = this.bufPhysAddr();
      if (fb) { JITCanvas.fillBuffer(fb, c, this.width * this.height); return; }
    }
    this._buf.fill(c);
  }

  fillRect(x: number, y: number, w: number, h: number, color: PixelColor): void {
    var c  = Canvas._bgra(color);
    var x1 = Math.max(x, 0);
    var y1 = Math.max(y, 0);
    var x2 = Math.min(x + w, this.width);
    var y2 = Math.min(y + h, this.height);
    var rowW = x2 - x1;
    if (rowW <= 0) return;
    // JIT fast-path: direct physical-memory rectangle fill
    if (_ensureJIT()) {
      var fb = this.bufPhysAddr();
      if (fb) {
        JITCanvas.fillRect(fb, c, x1, y1, rowW, y2 - y1, this.width * 4);
        return;
      }
    }
    // TypedArray.fill() fallback — native bulk operation, far faster than
    // an explicit inner for-col loop which generates individual array writes.
    for (var row = y1; row < y2; row++) {
      var base = row * this.width + x1;
      this._buf.fill(c, base, base + rowW);
    }
  }

  drawRect(x: number, y: number, w: number, h: number, color: PixelColor): void {
    this.fillRect(x,         y,         w,  1, color);  // top
    this.fillRect(x,         y + h - 1, w,  1, color);  // bottom
    this.fillRect(x,         y,         1,  h, color);  // left
    this.fillRect(x + w - 1, y,         1,  h, color);  // right
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color: PixelColor): void {
    var dx = Math.abs(x1 - x0);
    var dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    for (;;) {
      this.setPixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }
  }

  drawText(x: number, y: number, text: string, color: PixelColor, font = defaultFont): void {
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') { y += font.charHeight; cx = x; continue; }
      font.renderChar(this, cx, y, ch, color);
      cx += font.charWidth;
    }
  }

  /**
   * Draw text using the 8×8 bitmap font scaled by `scale` pixels per dot.
   * scale=1 → normal 8×8; scale=2 → 16×16; scale=3 → 24×24.
   */
  drawTextScaled(x: number, y: number, text: string, color: PixelColor, scale: number): void {
    if (scale <= 1) { this.drawText(x, y, text, color); return; }
    var cx = x;
    for (var ti = 0; ti < text.length; ti++) {
      var code = text.charCodeAt(ti);
      if (code < 0x20 || code > 0x7E) { cx += 8 * scale; continue; }
      var base = (code - 0x20) * 8;
      for (var row = 0; row < 8; row++) {
        var byte = FONT_DATA_8x8[base + row];
        if (!byte) continue;
        for (var col = 0; col < 8; col++) {
          if (byte & (0x80 >> col)) {
            this.fillRect(cx + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cx += 8 * scale;
    }
  }

  measureText(text: string, font = defaultFont): { width: number; height: number } {
    return font.measureText(text);
  }

  // ── Extended drawing primitives ───────────────────────────────────────

  /** Filled circle using scanline approach. */
  fillCircle(cx: number, cy: number, r: number, color: PixelColor): void {
    for (var dy = -r; dy <= r; dy++) {
      var dx2 = Math.floor(Math.sqrt(r * r - dy * dy));
      this.fillRect(cx - dx2, cy + dy, 2 * dx2 + 1, 1, color);
    }
  }

  /** Circle outline using Bresenham midpoint algorithm. */
  drawCircle(cx: number, cy: number, r: number, color: PixelColor): void {
    var x = 0, y = r, d = 3 - 2 * r;
    while (y >= x) {
      this.setPixel(cx + x, cy - y, color); this.setPixel(cx - x, cy - y, color);
      this.setPixel(cx + x, cy + y, color); this.setPixel(cx - x, cy + y, color);
      this.setPixel(cx + y, cy - x, color); this.setPixel(cx - y, cy - x, color);
      this.setPixel(cx + y, cy + x, color); this.setPixel(cx - y, cy + x, color);
      if (d < 0) d += 4 * x + 6;
      else { d += 4 * (x - y) + 10; y--; }
      x++;
    }
  }

  /** Filled rounded rectangle. */
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: PixelColor): void {
    r = Math.min(r, w >> 1, h >> 1);
    // Centre horizontal slab
    this.fillRect(x, y + r, w, h - 2 * r, color);
    // Top + bottom slabs (between corners)
    this.fillRect(x + r, y, w - 2 * r, r, color);
    this.fillRect(x + r, y + h - r, w - 2 * r, r, color);
    // Four quarter-disc corners
    for (var row = 0; row < r; row++) {
      var xoff = Math.floor(Math.sqrt(r * r - (r - 1 - row) * (r - 1 - row)));
      var col = r - xoff;
      // top-left
      this.fillRect(x + col, y + row, xoff, 1, color);
      // top-right
      this.fillRect(x + w - r, y + row, xoff, 1, color);
      // bottom-left
      this.fillRect(x + col, y + h - 1 - row, xoff, 1, color);
      // bottom-right
      this.fillRect(x + w - r, y + h - 1 - row, xoff, 1, color);
    }
  }

  /** Rounded rectangle outline. */
  drawRoundRect(x: number, y: number, w: number, h: number, r: number, color: PixelColor): void {
    r = Math.min(r, w >> 1, h >> 1);
    // Straight edges
    this.fillRect(x + r,     y,         w - 2 * r, 1, color);
    this.fillRect(x + r,     y + h - 1, w - 2 * r, 1, color);
    this.fillRect(x,         y + r,     1, h - 2 * r, color);
    this.fillRect(x + w - 1, y + r,     1, h - 2 * r, color);
    // Corner arcs via Bresenham
    var bx = 0, by = r, bd = 3 - 2 * r;
    while (by >= bx) {
      // top-left
      this.setPixel(x + r - bx, y + r - by, color);
      this.setPixel(x + r - by, y + r - bx, color);
      // top-right
      this.setPixel(x + w - r - 1 + bx, y + r - by, color);
      this.setPixel(x + w - r - 1 + by, y + r - bx, color);
      // bottom-left
      this.setPixel(x + r - bx, y + h - r - 1 + by, color);
      this.setPixel(x + r - by, y + h - r - 1 + bx, color);
      // bottom-right
      this.setPixel(x + w - r - 1 + bx, y + h - r - 1 + by, color);
      this.setPixel(x + w - r - 1 + by, y + h - r - 1 + bx, color);
      if (bd < 0) bd += 4 * bx + 6;
      else { bd += 4 * (bx - by) + 10; by--; }
      bx++;
    }
  }

  // ── Gradient fills ────────────────────────────────────────────────────

  /** Linear gradient fill. `stops` are {stop:0..1, color} in order. Direction defaults to vertical. */
  drawLinearGradient(
    x: number, y: number, w: number, h: number,
    stops: Array<{ stop: number; color: PixelColor }>,
    direction: 'horizontal' | 'vertical' | 'diagonal' = 'vertical',
  ): void {
    if (stops.length === 0) return;
    if (stops.length === 1) { this.fillRect(x, y, w, h, stops[0].color); return; }
    var len = direction === 'horizontal' ? w : direction === 'vertical' ? h : Math.max(w, h);
    for (var i = 0; i < len; i++) {
      var t = len <= 1 ? 0 : i / (len - 1);
      var c = Canvas._lerpStops(stops, t);
      if (direction === 'horizontal') this.fillRect(x + i, y, 1, h, c);
      else if (direction === 'vertical') this.fillRect(x, y + i, w, 1, c);
      else { // diagonal
        var frac = i / len;
        var cx2 = Math.round(x + w * frac);
        var cy2 = Math.round(y + h * frac);
        this.setPixel(cx2, cy2, c);
      }
    }
  }

  /** Radial gradient fill from centre outward. `stops` are {stop:0..1, color} in order. */
  drawRadialGradient(
    cx: number, cy: number, r: number,
    stops: Array<{ stop: number; color: PixelColor }>,
  ): void {
    if (stops.length === 0 || r <= 0) return;
    var x0 = Math.max(0, cx - r), x1 = Math.min(this.width,  cx + r + 1);
    var y0 = Math.max(0, cy - r), y1 = Math.min(this.height, cy + r + 1);
    for (var py = y0; py < y1; py++) {
      var dy2 = py - cy;
      for (var px = x0; px < x1; px++) {
        var dx2 = px - cx;
        var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (dist > r) continue;
        var t = dist / r;
        this.setPixel(px, py, Canvas._lerpStops(stops, t));
      }
    }
  }

  private static _lerpStops(stops: Array<{ stop: number; color: PixelColor }>, t: number): PixelColor {
    if (t <= stops[0].stop)            return stops[0].color;
    if (t >= stops[stops.length - 1].stop) return stops[stops.length - 1].color;
    for (var si = 0; si < stops.length - 1; si++) {
      var s0 = stops[si], s1 = stops[si + 1];
      if (t >= s0.stop && t <= s1.stop) {
        var lt = (s1.stop === s0.stop) ? 0 : (t - s0.stop) / (s1.stop - s0.stop);
        return Canvas._lerpColor(s0.color, s1.color, lt);
      }
    }
    return stops[stops.length - 1].color;
  }

  private static _lerpColor(a: PixelColor, b: PixelColor, t: number): PixelColor {
    var ia = 1 - t;
    var aa = ((a >>> 24) & 0xFF) * ia + ((b >>> 24) & 0xFF) * t;
    var rr = ((a >>> 16) & 0xFF) * ia + ((b >>> 16) & 0xFF) * t;
    var gg = ((a >>>  8) & 0xFF) * ia + ((b >>>  8) & 0xFF) * t;
    var bb = ((a >>>  0) & 0xFF) * ia + ((b >>>  0) & 0xFF) * t;
    return ((aa & 0xFF) << 24) | ((rr & 0xFF) << 16) | ((gg & 0xFF) << 8) | (bb & 0xFF);
  }

  // ── Sprite rendering ──────────────────────────────────────────────────

  /**
   * Render an indexed-colour sprite.
   * `pixels` is a flat row-major array of palette indices.
   * `palette[0]` is transparent by convention (alpha=0 → skip).
   * `scale` repeats each pixel N×N times (default 1).
   */
  drawSprite(
    x: number, y: number,
    pixels: number[], pw: number, ph: number,
    palette: PixelColor[],
    scale = 1,
  ): void {
    for (var row = 0; row < ph; row++) {
      for (var col = 0; col < pw; col++) {
        var idx = pixels[row * pw + col];
        if (idx < 0 || idx >= palette.length) continue;
        var c = palette[idx];
        if ((c >>> 24) === 0) continue; // transparent
        var px = x + col * scale;
        var py = y + row * scale;
        if (scale === 1) {
          this.setPixel(px, py, c);
        } else {
          this.fillRect(px, py, scale, scale, c);
        }
      }
    }
  }

  // ── Compositing ───────────────────────────────────────────────────────

  /**
   * Fast glyph renderer: converts `color` once then writes directly into
   * _buf — no per-pixel color conversion or bounds-check call overhead.
   * `data` is the font bitmap array; `base` is the byte offset for the glyph.
   */
  drawGlyph(x: number, y: number, data: Uint8Array, base: number, color: PixelColor): void {
    var bgraColor = Canvas._bgra(color);   // convert ONCE, not 64 times
    for (var row = 0; row < 8; row++) {
      var py = y + row;
      if (py < 0 || py >= this.height) continue;
      var byte = data[base + row];
      if (!byte) continue;                  // skip blank rows early
      var rowBase = py * this.width;
      for (var col = 0; col < 8; col++) {
        if (byte & (0x80 >> col)) {
          var px = x + col;
          if (px >= 0 && px < this.width) this._buf[rowBase + px] = bgraColor;
        }
      }
    }
  }

  // ── Compositing ───────────────────────────────────────────────────────

  blit(src: Canvas, sx: number, sy: number, dx: number, dy: number,
       w: number, h: number): void {
    // JIT fast-path: direct physical-memory row copy
    if (_ensureJIT()) {
      var dstBase = this.bufPhysAddr();
      var srcBase = src.bufPhysAddr();
      if (dstBase && srcBase) {
        for (var row = 0; row < h; row++) {
          var dstY = dy + row;
          if (dstY < 0 || dstY >= this.height) continue;
          var colStart = dx < 0 ? -dx : 0;
          var colEnd   = (dx + w > this.width) ? (this.width - dx) : w;
          if (colStart >= colEnd) continue;
          var srcOff = (sy + row) * src.width + sx + colStart;
          var dstOff = dstY * this.width + dx + colStart;
          JITCanvas.blitRow(dstBase + dstOff * 4, srcBase + srcOff * 4, colEnd - colStart);
        }
        return;
      }
    }
    // Use TypedArray.set() per-row instead of a per-pixel loop.
    // For a 800×550 window this is ~550 bulk copies vs ~440,000 individual assignments.
    for (var row = 0; row < h; row++) {
      var dstY = dy + row;
      if (dstY < 0 || dstY >= this.height) continue;
      // Clamp column range to destination bounds
      var colStart = dx < 0 ? -dx : 0;
      var colEnd   = (dx + w > this.width) ? (this.width - dx) : w;
      if (colStart >= colEnd) continue;
      var srcOff = (sy + row) * src.width + sx + colStart;
      var dstOff =       dstY * this.width     + dx + colStart;
      this._buf.set(src._buf.subarray(srcOff, srcOff + (colEnd - colStart)), dstOff);
    }
  }

  /**
   * Alpha-blended blit: composite `src` onto this canvas with the given
   * alpha value (0=transparent, 255=opaque).  Slower than `blit()` — use
   * only when opacity < 255.  Both buffers are BGRA so channel order matches.
   */
  blitAlpha(src: Canvas, sx: number, sy: number, dx: number, dy: number,
            w: number, h: number, alpha: number): void {
    // JIT fast-path: alpha-blend via native x86-32 code operating on physical memory.
    // Eliminates ~6 multiplies + shifts per pixel of JS interpreter overhead.
    if (_ensureJIT()) {
      var dstBase = this.bufPhysAddr();
      var srcBase = src.bufPhysAddr();
      if (dstBase && srcBase) {
        for (var row = 0; row < h; row++) {
          var dstY = dy + row;
          if (dstY < 0 || dstY >= this.height) continue;
          var colStart = dx < 0 ? -dx : 0;
          var colEnd   = (dx + w > this.width) ? (this.width - dx) : w;
          if (colStart >= colEnd) continue;
          var srcOff = (sy + row) * src.width + sx + colStart;
          var dstOff = dstY * this.width + dx + colStart;
          JITCanvas.blitAlphaRow(
            dstBase + dstOff * 4, srcBase + srcOff * 4,
            colEnd - colStart, alpha,
          );
        }
        return;
      }
    }
    // TypeScript fallback
    var ia = 255 - alpha;
    for (var row = 0; row < h; row++) {
      var dstY = dy + row;
      if (dstY < 0 || dstY >= this.height) continue;
      var srcRowBase = (sy + row) * src.width + sx;
      var dstRowBase =        dstY * this.width + dx;
      for (var col = 0; col < w; col++) {
        var dstX = dx + col;
        if (dstX < 0 || dstX >= this.width) continue;
        var sp = src._buf[srcRowBase + col];
        var dp = this._buf[dstRowBase + col];
        var b = (( sp        & 0xFF) * alpha + ( dp        & 0xFF) * ia) >> 8;
        var g = (((sp >>  8) & 0xFF) * alpha + ((dp >>  8) & 0xFF) * ia) >> 8;
        var r = (((sp >> 16) & 0xFF) * alpha + ((dp >> 16) & 0xFF) * ia) >> 8;
        var a = (((sp >> 24) & 0xFF) * alpha + ((dp >> 24) & 0xFF) * ia) >> 8;
        this._buf[dstRowBase + col] = (a << 24) | (r << 16) | (g << 8) | b;
      }
    }
  }

  /**
   * Blit external pixel data (already in canvas-native 0xAARRGGBB format) directly
   * into this canvas using Uint32Array.set() per row — zero per-pixel overhead.
   * Used by the image renderer: BMP data decoded by decodeBMP() is already in the
   * correct format so no conversion is needed, just bulk memory copies.
   */
  blitPixelsDirect(src: Uint32Array, srcW: number, srcH: number,
                   dx: number, dy: number): void {
    var cols = Math.min(srcW, this.width  - dx);
    var rows = Math.min(srcH, this.height - dy);
    if (cols <= 0 || rows <= 0) return;
    for (var row = 0; row < rows; row++) {
      var dstY = dy + row;
      if (dstY < 0 || dstY >= this.height) continue;
      this._buf.set(
        src.subarray(row * srcW, row * srcW + cols),
        dstY * this.width + dx,
      );
    }
  }

  // ── Framebuffer output ────────────────────────────────────────────────

  /**
   * Double-buffer flip: send the entire canvas to the physical framebuffer.
   * For the screen canvas, blits at (0,0).
   * For sub-canvases, blits at the registered (fb_x, fb_y) offset.
   */
  flip(): void {
    /* External-buffer canvases are owned by the WM render slab; don't blit. */
    if (this._external) return;
    // Zero-copy fast path: pass the Uint32Array's backing ArrayBuffer directly.
    // C side detects it via JS_GetArrayBuffer() and calls a single memcpy.
    (kernel.fbBlit as any)(this._buf.buffer, this._fb_x, this._fb_y, this.width, this.height);
  }

  /**
   * Partial update — blit a sub-region of this canvas to the framebuffer.
   * Builds a compact typed-array region copy (one pass) then hands off
   * its backing ArrayBuffer to C for a single memcpy.
   */
  flipRegion(x: number, y: number, w: number, h: number): void {
    var region = new Uint32Array(w * h);
    for (var row = 0; row < h; row++) {
      var srcOff = (y + row) * this.width + x;
      region.set(this._buf.subarray(srcOff, srcOff + w), row * w);
    }
    (kernel.fbBlit as any)(region.buffer, this._fb_x + x, this._fb_y + y, w, h);
  }

  /** Get raw Uint32Array buffer (BGRA) for compositing without allocation */
  getBuffer(): Uint32Array { return this._buf; }

  /**
   * Copy pixels from a raw BGRA ArrayBuffer (e.g. a BSS render slab) into
   * this canvas at destination offset (dstX, dstY).
   *
   * @param srcBuf    - Source ArrayBuffer containing BGRA pixels
   * @param srcX      - X offset in source (pixels)
   * @param srcY      - Y offset in source (pixels)
   * @param dstX      - X offset in this canvas (pixels)
   * @param dstY      - Y offset in this canvas (pixels)
   * @param w         - Width of the region to copy (pixels)
   * @param h         - Height of the region to copy (pixels)
   * @param srcWidthPx - Row stride of the source in pixels (defaults to `w`)
   */
  blitFromBuffer(
    srcBuf: ArrayBuffer, srcX: number, srcY: number,
    dstX: number, dstY: number, w: number, h: number,
    srcWidthPx?: number,
  ): void {
    var srcStride = srcWidthPx !== undefined ? srcWidthPx : w;
    var src = new Uint32Array(srcBuf);
    for (var row = 0; row < h; row++) {
      var dY = dstY + row;
      if (dY < 0 || dY >= this.height) continue;
      var colStart = dstX < 0 ? -dstX : 0;
      var colEnd   = (dstX + w > this.width) ? (this.width - dstX) : w;
      if (colStart >= colEnd) continue;
      var srcOff = (srcY + row) * srcStride + srcX + colStart;
      var dstOff = dY * this.width + dstX + colStart;
      this._buf.set(src.subarray(srcOff, srcOff + (colEnd - colStart)), dstOff);
    }
  }

  /**
   * Physical address of the pixel buffer, for use with JIT-compiled operations.
   * Returns 0 when kernel.physAddrOf is unavailable (e.g. test environments).
   * QuickJS is a non-moving GC, so the address is stable for the buffer's lifetime.
   */
  bufPhysAddr(): number { return JITCanvas.physAddr(this._buf.buffer as ArrayBuffer); }
}

/**
 * Create the main screen canvas backed by the framebuffer, or null if
 * no framebuffer was negotiated by GRUB.
 */
export function createScreenCanvas(): Canvas | null {
  var info = kernel.fbInfo();
  if (!info) return null;
  return new Canvas(info.width, info.height, 0, 0, true);
}
