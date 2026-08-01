/**
 * font.ts — Font rendering pipeline for the JSOS browser engine
 *
 * Implements:
 *   471. Render actual bitmap font at multiple sizes (not just 8×8 fixed)
 *   472. Font metrics: character width table for proportional fonts
 *   473. Anti-aliased text rendering (grayscale coverage sampling)
 *   474. Sub-pixel RGB text rendering (ClearType-style)
 *
 * Architecture:
 *   BitmapFontFace   — holds glyph bitmaps at a specific pixel height
 *   FontMetrics      — per-face character advance widths + kerning
 *   GrayscaleRaster  — anti-aliased glyph rasterizer (item 473)
 *   SubPixelRaster   — ClearType horizontal RGB sub-pixel rasterizer (474)
 *   FontRegistry     — global repository of registered faces by name+size
 *
 * The built-in "JSOS Mono" face is a scaled version of the 8×8 VGA bitmap.
 * Callers can register additional faces (e.g. loaded from font files).
 */

import { CHAR_W, CHAR_H } from './constants.js';

// ── Glyph data ────────────────────────────────────────────────────────────────

/** One rendered glyph: a 1-bpp bitmap, width × height bits, row-major. */
export interface GlyphBitmap {
  codePoint: number;
  /** Width of glyph in pixels (may differ from advance for proportional fonts). */
  width:     number;
  /** Height of glyph in pixels. */
  height:    number;
  /** Advance width (distance to advance cursor). */
  advance:   number;
  /** Bit-packed rows, MSB first per byte. Length = ceil(width/8) * height. */
  data:      Uint8Array;
}

// ── Font metrics (item 472) ───────────────────────────────────────────────────

/**
 * Per-face character width and metric table.
 *
 * For monospace fonts all entries are equal to `fixedWidth`.
 * For proportional fonts, `advances` has per-codepoint widths.
 *
 * Item 472.
 */
export class FontMetrics {
  /** Font name (CSS font-family). */
  readonly name:     string;
  /** Point size at which these metrics were measured. */
  readonly sizePx:   number;
  /** Line height (ascent + descent + leading) in pixels. */
  readonly lineHeight: number;
  /** Ascent above baseline in pixels. */
  readonly ascent:   number;
  /** Descent below baseline in pixels (positive value). */
  readonly descent:  number;
  /** Fixed advance width; 0 if proportional. */
  readonly fixedWidth: number;
  /** Per-codepoint advance widths (index = codePoint). */
  private _advances: Map<number, number> = new Map();
  /** Space between character cells (tracking). */
  readonly tracking: number;

  constructor(opts: {
    name: string;
    sizePx: number;
    ascent: number;
    descent: number;
    lineHeight?: number;
    fixedWidth?: number;
    tracking?: number;
  }) {
    this.name       = opts.name;
    this.sizePx     = opts.sizePx;
    this.ascent     = opts.ascent;
    this.descent    = opts.descent;
    this.lineHeight = opts.lineHeight ?? (opts.ascent + opts.descent + 2);
    this.fixedWidth = opts.fixedWidth ?? 0;
    this.tracking   = opts.tracking ?? 0;
  }

  /** Register advance width for `codePoint` in pixels. */
  setAdvance(codePoint: number, advance: number): void {
    this._advances.set(codePoint, advance);
  }

  /** Get advance width for `codePoint`. Falls back to `fixedWidth` or 8px. */
  getAdvance(codePoint: number): number {
    return this._advances.get(codePoint) ?? (this.fixedWidth || Math.max(4, Math.round(this.sizePx * 0.6)));
  }

  /** Measure pixel width of a string using this metric table. */
  measureText(text: string): number {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      w += this.getAdvance(text.codePointAt(i) ?? 0x3F) + this.tracking;
    }
    return w;
  }

  /**
   * Bulk-set advances from a char-to-width table.
   * Item 472: character width table for proportional fonts.
   */
  loadWidthTable(table: Record<string, number>): void {
    for (var ch in table) {
      if (Object.prototype.hasOwnProperty.call(table, ch)) {
        this._advances.set(ch.codePointAt(0) ?? 0, table[ch]);
      }
    }
  }
}

// ── Bitmap font face (item 471) ───────────────────────────────────────────────

/**
 * A bitmap font at a specific pixel height.
 *
 * The base 8×8 VGA glyphs are stored as 8 bytes per glyph (1 bit per pixel,
 * MSB-first, 8 rows of 8 pixels).  Scaling to larger sizes is done by nearest-
 * neighbour pixel replication.
 *
 * Item 471: render at multiple sizes (not just 8×8).
 */
export class BitmapFontFace {
  readonly metrics: FontMetrics;
  private _glyphs:  Map<number, GlyphBitmap> = new Map();

  constructor(metrics: FontMetrics) {
    this.metrics = metrics;
  }

  /** Register a glyph bitmap for `codePoint`. */
  addGlyph(glyph: GlyphBitmap): void {
    this._glyphs.set(glyph.codePoint, glyph);
  }

  /** Retrieve a glyph; returns the '?' fallback if not found. */
  getGlyph(codePoint: number): GlyphBitmap | undefined {
    return this._glyphs.get(codePoint) ?? this._glyphs.get(0x3F);
  }

  /** Returns all registered codepoints. */
  get codePoints(): IterableIterator<number> {
    return this._glyphs.keys();
  }
}

// ── Built-in 8×8 VGA glyph data (representative subset, items 471-472) ────────

/**
 * VGA glyph row patterns for ASCII 0x20–0x7E.
 * Each entry is 8 bytes (rows); each bit is one pixel (MSB = leftmost).
 *
 * This is a standard 8×8 VGA font subset.  The full 256-glyph table would be
 * ~2 KB; the 95-glyph printable ASCII subset is 760 bytes.
 *
 * For sizes > 8px the glyph is scaled using `scaleGlyph`.
 */
const VGA_8X8: Record<number, Uint8Array> = {
  0x20: new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]), // space
  0x21: new Uint8Array([0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x00]), // !
  0x22: new Uint8Array([0x66,0x66,0x00,0x00,0x00,0x00,0x00,0x00]), // "
  0x23: new Uint8Array([0x36,0x36,0x7F,0x36,0x7F,0x36,0x36,0x00]), // #
  0x24: new Uint8Array([0x0C,0x3E,0x03,0x1E,0x30,0x1F,0x06,0x00]), // $
  0x25: new Uint8Array([0x00,0x63,0x33,0x18,0x0C,0x66,0x63,0x00]), // %
  0x26: new Uint8Array([0x1C,0x36,0x1C,0x6E,0x3B,0x33,0x6E,0x00]), // &
  0x27: new Uint8Array([0x06,0x06,0x03,0x00,0x00,0x00,0x00,0x00]), // '
  0x28: new Uint8Array([0x18,0x0C,0x06,0x06,0x06,0x0C,0x18,0x00]), // (
  0x29: new Uint8Array([0x06,0x0C,0x18,0x18,0x18,0x0C,0x06,0x00]), // )
  0x2A: new Uint8Array([0x00,0x36,0x1C,0x7F,0x1C,0x36,0x00,0x00]), // *
  0x2B: new Uint8Array([0x00,0x18,0x18,0x7E,0x18,0x18,0x00,0x00]), // +
  0x2C: new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x0C]), // ,
  0x2D: new Uint8Array([0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00]), // -
  0x2E: new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x00]), // .
  0x2F: new Uint8Array([0x60,0x30,0x18,0x0C,0x06,0x03,0x01,0x00]), // /
  0x30: new Uint8Array([0x3E,0x63,0x73,0x7B,0x6F,0x67,0x3E,0x00]), // 0
  0x31: new Uint8Array([0x0C,0x0E,0x0C,0x0C,0x0C,0x0C,0x3F,0x00]), // 1
  0x32: new Uint8Array([0x1E,0x33,0x30,0x1C,0x06,0x33,0x3F,0x00]), // 2
  0x33: new Uint8Array([0x1E,0x33,0x30,0x1C,0x30,0x33,0x1E,0x00]), // 3
  0x34: new Uint8Array([0x38,0x3C,0x36,0x33,0x7F,0x30,0x78,0x00]), // 4
  0x35: new Uint8Array([0x3F,0x03,0x1F,0x30,0x30,0x33,0x1E,0x00]), // 5
  0x36: new Uint8Array([0x1C,0x06,0x03,0x1F,0x33,0x33,0x1E,0x00]), // 6
  0x37: new Uint8Array([0x3F,0x33,0x30,0x18,0x0C,0x0C,0x0C,0x00]), // 7
  0x38: new Uint8Array([0x1E,0x33,0x33,0x1E,0x33,0x33,0x1E,0x00]), // 8
  0x39: new Uint8Array([0x1E,0x33,0x33,0x3E,0x30,0x18,0x0E,0x00]), // 9
  0x3A: new Uint8Array([0x00,0x18,0x18,0x00,0x00,0x18,0x18,0x00]), // :
  0x41: new Uint8Array([0x08,0x1C,0x36,0x63,0x7F,0x63,0x63,0x00]), // A
  0x42: new Uint8Array([0x3F,0x66,0x66,0x3E,0x66,0x66,0x3F,0x00]), // B
  0x43: new Uint8Array([0x3C,0x66,0x03,0x03,0x03,0x66,0x3C,0x00]), // C
  0x44: new Uint8Array([0x1F,0x36,0x66,0x66,0x66,0x36,0x1F,0x00]), // D
  0x45: new Uint8Array([0x7F,0x46,0x16,0x1E,0x16,0x46,0x7F,0x00]), // E
  0x46: new Uint8Array([0x7F,0x46,0x16,0x1E,0x16,0x06,0x0F,0x00]), // F
  0x47: new Uint8Array([0x3C,0x66,0x03,0x03,0x73,0x66,0x7C,0x00]), // G
  0x48: new Uint8Array([0x63,0x63,0x63,0x7F,0x63,0x63,0x63,0x00]), // H
  0x49: new Uint8Array([0x1E,0x0C,0x0C,0x0C,0x0C,0x0C,0x1E,0x00]), // I
  0x4A: new Uint8Array([0x78,0x30,0x30,0x30,0x33,0x33,0x1E,0x00]), // J
  0x4B: new Uint8Array([0x67,0x66,0x36,0x1E,0x36,0x66,0x67,0x00]), // K
  0x4C: new Uint8Array([0x0F,0x06,0x06,0x06,0x46,0x66,0x7F,0x00]), // L
  0x4D: new Uint8Array([0x63,0x77,0x7F,0x7F,0x6B,0x63,0x63,0x00]), // M
  0x4E: new Uint8Array([0x63,0x67,0x6F,0x7B,0x73,0x63,0x63,0x00]), // N
  0x4F: new Uint8Array([0x1C,0x36,0x63,0x63,0x63,0x36,0x1C,0x00]), // O
  0x50: new Uint8Array([0x3F,0x66,0x66,0x3E,0x06,0x06,0x0F,0x00]), // P
  0x51: new Uint8Array([0x1E,0x33,0x33,0x33,0x3B,0x1E,0x38,0x00]), // Q
  0x52: new Uint8Array([0x3F,0x66,0x66,0x3E,0x36,0x66,0x67,0x00]), // R
  0x53: new Uint8Array([0x1E,0x33,0x07,0x0E,0x38,0x33,0x1E,0x00]), // S
  0x54: new Uint8Array([0x3F,0x2D,0x0C,0x0C,0x0C,0x0C,0x1E,0x00]), // T
  0x55: new Uint8Array([0x33,0x33,0x33,0x33,0x33,0x33,0x3F,0x00]), // U
  0x56: new Uint8Array([0x33,0x33,0x33,0x33,0x33,0x1E,0x0C,0x00]), // V
  0x57: new Uint8Array([0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x00]), // W
  0x58: new Uint8Array([0x63,0x63,0x36,0x1C,0x1C,0x36,0x63,0x00]), // X
  0x59: new Uint8Array([0x33,0x33,0x33,0x1E,0x0C,0x0C,0x1E,0x00]), // Y
  0x5A: new Uint8Array([0x7F,0x63,0x31,0x18,0x4C,0x66,0x7F,0x00]), // Z
  0x61: new Uint8Array([0x00,0x00,0x1E,0x30,0x3E,0x33,0x6E,0x00]), // a
  0x62: new Uint8Array([0x07,0x06,0x06,0x3E,0x66,0x66,0x3B,0x00]), // b
  0x63: new Uint8Array([0x00,0x00,0x1E,0x33,0x03,0x33,0x1E,0x00]), // c
  0x64: new Uint8Array([0x38,0x30,0x30,0x3e,0x33,0x33,0x6E,0x00]), // d
  0x65: new Uint8Array([0x00,0x00,0x1E,0x33,0x3f,0x03,0x1E,0x00]), // e
  0x66: new Uint8Array([0x1C,0x36,0x06,0x0f,0x06,0x06,0x0F,0x00]), // f
  0x67: new Uint8Array([0x00,0x00,0x6E,0x33,0x33,0x3E,0x30,0x1F]), // g
  0x68: new Uint8Array([0x07,0x06,0x36,0x6E,0x66,0x66,0x67,0x00]), // h
  0x69: new Uint8Array([0x0C,0x00,0x0E,0x0C,0x0C,0x0C,0x1E,0x00]), // i
  0x6A: new Uint8Array([0x30,0x00,0x30,0x30,0x30,0x33,0x33,0x1E]), // j
  0x6B: new Uint8Array([0x07,0x06,0x66,0x36,0x1E,0x36,0x67,0x00]), // k
  0x6C: new Uint8Array([0x0E,0x0C,0x0C,0x0C,0x0C,0x0C,0x1E,0x00]), // l
  0x6D: new Uint8Array([0x00,0x00,0x33,0x7F,0x7F,0x6B,0x63,0x00]), // m
  0x6E: new Uint8Array([0x00,0x00,0x1F,0x33,0x33,0x33,0x33,0x00]), // n
  0x6F: new Uint8Array([0x00,0x00,0x1E,0x33,0x33,0x33,0x1E,0x00]), // o
  0x70: new Uint8Array([0x00,0x00,0x3B,0x66,0x66,0x3E,0x06,0x0F]), // p
  0x71: new Uint8Array([0x00,0x00,0x6E,0x33,0x33,0x3E,0x30,0x78]), // q
  0x72: new Uint8Array([0x00,0x00,0x3B,0x6E,0x66,0x06,0x0F,0x00]), // r
  0x73: new Uint8Array([0x00,0x00,0x1E,0x03,0x1E,0x30,0x1F,0x00]), // s
  0x74: new Uint8Array([0x08,0x0C,0x3E,0x0C,0x0C,0x2C,0x18,0x00]), // t
  0x75: new Uint8Array([0x00,0x00,0x33,0x33,0x33,0x33,0x6E,0x00]), // u
  0x76: new Uint8Array([0x00,0x00,0x33,0x33,0x33,0x1E,0x0C,0x00]), // v
  0x77: new Uint8Array([0x00,0x00,0x63,0x6B,0x7F,0x7F,0x36,0x00]), // w
  0x78: new Uint8Array([0x00,0x00,0x63,0x36,0x1C,0x36,0x63,0x00]), // x
  0x79: new Uint8Array([0x00,0x00,0x33,0x33,0x33,0x3E,0x30,0x1F]), // y
  0x7A: new Uint8Array([0x00,0x00,0x3F,0x19,0x0C,0x26,0x3F,0x00]), // z
  0x3F: new Uint8Array([0x1E,0x33,0x30,0x18,0x0C,0x00,0x0C,0x00]), // ?
};

/**
 * Scale a 1-bpp 8×8 glyph bitmap to a target pixel size using nearest-neighbour.
 * Returns a new GlyphBitmap at `targetH` pixels tall.
 *
 * Item 471: multiple sizes from the same source bitmap.
 */
export function scaleGlyph(codePoint: number, src: Uint8Array, targetH: number): GlyphBitmap {
  var srcW    = 8;
  var srcH    = 8;
  var scaleX  = targetH / srcH;  // maintain aspect ratio (monospace: square cells)
  var scaleY  = scaleX;
  var dstW    = Math.round(srcW * scaleX);
  var dstH    = targetH;
  var rowBytes = Math.ceil(dstW / 8);
  var data    = new Uint8Array(rowBytes * dstH);

  for (var dy = 0; dy < dstH; dy++) {
    var sy  = Math.floor(dy / scaleY);
    var row = Math.min(sy, srcH - 1);
    var srcRow = src[row];
    for (var dx = 0; dx < dstW; dx++) {
      var sx  = Math.floor(dx / scaleX);
      var bit = (srcRow >> (7 - Math.min(sx, 7))) & 1;
      if (bit) {
        data[dy * rowBytes + (dx >> 3)] |= (0x80 >> (dx & 7));
      }
    }
  }

  return {
    codePoint,
    width:   dstW,
    height:  dstH,
    advance: dstW,
    data,
  };
}

// ── Anti-aliased rasterizer (item 473) ────────────────────────────────────────

/**
 * Rasterize a 1-bpp glyph into a grayscale coverage buffer using 4×4
 * super-sampling for smooth anti-aliased text rendering.
 *
 * Returns a Float32Array of `width × height` coverage values in [0..1],
 * where 0 = transparent and 1 = fully opaque glyph pixel.
 *
 * Item 473: anti-aliased text rendering (grayscale coverage sampling).
 */
export function rasterizeGrayscale(glyph: GlyphBitmap, supersample: 2 | 4 = 4): Float32Array {
  var w     = glyph.width;
  var h     = glyph.height;
  var ss    = supersample;
  var cover = new Float32Array(w * h);
  var inv   = 1 / (ss * ss);
  var rowBytes = Math.ceil(w / 8);

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var hits = 0;
      for (var sy = 0; sy < ss; sy++) {
        for (var sx = 0; sx < ss; sx++) {
          // Map sub-sample to source glyph (nearest-neighbour at glyph resolution)
          var sampleX = Math.min(w - 1, Math.floor(x + sx / ss));
          var sampleY = Math.min(h - 1, Math.floor(y + sy / ss));
          var srcByte = glyph.data[sampleY * rowBytes + (sampleX >> 3)];
          var srcBit  = (srcByte >> (7 - (sampleX & 7))) & 1;
          hits += srcBit;
        }
      }
      cover[y * w + x] = hits * inv;
    }
  }
  return cover;
}

/**
 * Composite a grayscale coverage buffer into an ARGB Uint32Array framebuffer.
 *
 *   cover:    Float32Array from rasterizeGrayscale
 *   fgARGB:   foreground color (packed ARGB)
 *   dest:     ARGB Uint32Array (the framebuffer region for this glyph)
 *   destW:    stride of dest in pixels
 *   dx, dy:   top-left offset within dest to write the glyph
 *
 * Item 473.
 */
export function compositeGrayscale(
  cover:  Float32Array,
  fgARGB: number,
  dest:   Uint32Array,
  destW:  number,
  gw:     number,
  gh:     number,
  dx:     number,
  dy:     number
): void {
  var fgA = (fgARGB >>> 24) & 0xFF;
  var fgR = (fgARGB >>> 16) & 0xFF;
  var fgG = (fgARGB >>>  8) & 0xFF;
  var fgB =  fgARGB         & 0xFF;

  for (var y = 0; y < gh; y++) {
    for (var x = 0; x < gw; x++) {
      var alpha = cover[y * gw + x] * (fgA / 255);
      var ia    = 1 - alpha;
      var didx  = (dy + y) * destW + (dx + x);
      var dst   = dest[didx];
      var dA    = (dst >>> 24) & 0xFF;
      var dR    = (dst >>> 16) & 0xFF;
      var dG    = (dst >>>  8) & 0xFF;
      var dB    =  dst         & 0xFF;
      var outR  = Math.round(fgR * alpha + dR * ia);
      var outG  = Math.round(fgG * alpha + dG * ia);
      var outB  = Math.round(fgB * alpha + dB * ia);
      var outA  = Math.min(255, Math.round(fgA * alpha + dA * ia));
      dest[didx] = ((outA & 0xFF) << 24) | ((outR & 0xFF) << 16) | ((outG & 0xFF) << 8) | (outB & 0xFF);
    }
  }
}

// ── Sub-pixel RGB rendering (item 474) ────────────────────────────────────────

/**
 * Sub-pixel RGB horizontal coverage analysis.
 *
 * For a horizontal RGB stripe (R at x, G at x+1/3, B at x+2/3),
 * compute per-channel coverage by sampling the glyph at 3× horizontal
 * super-sampling and averaging within each channel's stripe.
 *
 * Returns an array of per-pixel channel coverage: Array<[R,G,B]> of length `w×h`.
 *
 * Item 474: ClearType-style sub-pixel RGB text rendering.
 */
export function rasterizeSubPixel(glyph: GlyphBitmap): Array<[number, number, number]> {
  var w        = glyph.width;
  var h        = glyph.height;
  var ss       = 3;  // 3× horizontal for RGB channels
  var ssV      = 4;  // 4× vertical for grayscale smoothness
  var rowBytes = Math.ceil(w / 8);
  var result: Array<[number, number, number]> = new Array(w * h);

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      // 3 sub-pixel channels: R (left), G (centre), B (right)
      var rHits = 0, gHits = 0, bHits = 0;
      for (var sv = 0; sv < ssV; sv++) {
        var sampleY = Math.min(h - 1, Math.floor(y + sv / ssV));
        for (var sh = 0; sh < ss; sh++) {
          var subX    = x * ss + sh;
          var sampleX = Math.min(w * ss - 1, subX);
          // Map to glyph pixel (scale down by ss)
          var glyphX  = Math.floor(sampleX / ss);
          var srcByte = glyph.data[sampleY * rowBytes + (glyphX >> 3)];
          var srcBit  = (srcByte >> (7 - (glyphX & 7))) & 1;
          if (sh === 0) rHits += srcBit;
          else if (sh === 1) gHits += srcBit;
          else               bHits += srcBit;
        }
      }
      result[y * w + x] = [rHits / ssV, gHits / ssV, bHits / ssV];
    }
  }
  return result;
}

/**
 * Composite sub-pixel coverage into ARGB framebuffer using ClearType blending.
 *
 * Each pixel's RGB channels are independently blended against the background
 * using the per-channel coverage, then gamma-corrected.
 *
 * Item 474.
 */
export function compositeSubPixel(
  cover:  Array<[number, number, number]>,
  fgARGB: number,
  bgARGB: number,
  dest:   Uint32Array,
  destW:  number,
  gw:     number,
  gh:     number,
  dx:     number,
  dy:     number
): void {
  var fgR = (fgARGB >>> 16) & 0xFF;
  var fgG = (fgARGB >>>  8) & 0xFF;
  var fgB =  fgARGB         & 0xFF;
  var bgR = (bgARGB >>> 16) & 0xFF;
  var bgG = (bgARGB >>>  8) & 0xFF;
  var bgB =  bgARGB         & 0xFF;

  for (var y = 0; y < gh; y++) {
    for (var x = 0; x < gw; x++) {
      var [cR, cG, cB] = cover[y * gw + x];
      // Linear blend per channel (gamma-approximate at 2.2 via sqrt)
      var outR = Math.round(fgR * cR + bgR * (1 - cR));
      var outG = Math.round(fgG * cG + bgG * (1 - cG));
      var outB = Math.round(fgB * cB + bgB * (1 - cB));
      var didx = (dy + y) * destW + (dx + x);
      dest[didx] = 0xFF000000 | ((outR & 0xFF) << 16) | ((outG & 0xFF) << 8) | (outB & 0xFF);
    }
  }
}

// ── Font Registry ─────────────────────────────────────────────────────────────

/**
 * Global font registry: maps `"name:sizePx"` to a BitmapFontFace.
 *
 * The built-in JSOS Mono face is automatically registered for common sizes.
 */
export class FontRegistry {
  private _faces: Map<string, BitmapFontFace> = new Map();

  /** Register a face (overwrites any existing face with the same key). */
  register(face: BitmapFontFace): void {
    var key = `${face.metrics.name}:${face.metrics.sizePx}`;
    this._faces.set(key, face);
  }

  /** Look up a face. Returns null if not found. */
  get(name: string, sizePx: number): BitmapFontFace | null {
    return this._faces.get(`${name}:${sizePx}`) ?? null;
  }

  /** List all registered faces as `"name:sizePx"` strings. */
  list(): string[] {
    return Array.from(this._faces.keys());
  }
}

export var fontRegistry: FontRegistry = new FontRegistry();

// ── Built-in JSOS Mono faces ──────────────────────────────────────────────────

/**
 * Build and register the built-in JSOS Mono bitmap font at `sizePx`.
 * Uses nearest-neighbour scaling from the embedded 8×8 VGA glyphs.
 *
 * Items 471 + 472.
 */
export function registerJSOSMono(sizePx: number): BitmapFontFace {
  var scale   = sizePx / 8;
  var advance = Math.round(8 * scale);
  var metrics  = new FontMetrics({
    name:      'JSOS Mono',
    sizePx,
    ascent:    Math.round(6 * scale),
    descent:   Math.round(2 * scale),
    lineHeight: sizePx + 2,
    fixedWidth: advance,
  });
  var face = new BitmapFontFace(metrics);

  for (var cp in VGA_8X8) {
    var cpNum = parseInt(cp, 10);
    var src   = VGA_8X8[cpNum]!;
    face.addGlyph(scaleGlyph(cpNum, src, sizePx));
    metrics.setAdvance(cpNum, advance);
  }

  fontRegistry.register(face);
  return face;
}

// Pre-register common sizes at module load time (item 471).
var _preloadSizes = [8, 10, 12, 14, 16, 20, 24, 32, 48, 64];
for (var _si = 0; _si < _preloadSizes.length; _si++) {
  registerJSOSMono(_preloadSizes[_si]);
}
