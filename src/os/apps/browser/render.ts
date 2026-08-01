/**
 * render.ts — JSOS Browser Rendering Pipeline
 *
 * Implements:
 *  - Tile-based renderer: 64×64 tiles; dirty-tile tracking (item 907)
 *  - Compositor: transform/opacity animation separated from layout+paint (item 908)
 *  - Painter's algorithm: z-index sorted render list (item 909)
 *  - Text atlas: pre-rasterized ASCII glyphs blit from atlas (item 910)
 *  - CSS background-color fast path (item 913)
 *  - Border/shadow pre-rasterize cache (item 914)
 *  - Opacity layer compositing (item 919)
 *
 * Architecture:
 *  1. Layout pass produces a list of RenderLayer objects.
 *  2. Painter sorts layers by z-index once, re-sorts only on z-index mutation.
 *  3. Compositor marks which 64×64 tiles are dirty.
 *  4. TileRenderer only repaints dirty tiles.
 *  5. Transform/opacity animation runs through the Compositor layer, skipping
 *     layout+paint (pure GPU/compositor path).
 */

import type { PixelColor } from '../../core/sdk.js';
import { CHAR_W, CHAR_H } from './constants.js';
import type { RenderedLine } from './types.js';
import { fontRegistry, registerJSOSMono } from './font.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Constants ─────────────────────────────────────────────────────────────────

/** Tile size in pixels. 64×64 = 4096 pixels per tile. */
const TILE_SIZE = 64;

/** Max text atlas width (rows of characters). */
const ATLAS_COLS = 32;
const ATLAS_ROWS = 4;   // covers ASCII 0x20–0x9F (128 chars)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Rect { x: number; y: number; w: number; h: number; }
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

/**
 * A layer in the compositor.
 * Each positioned element, z-index stacking context, or transform group
 * gets its own layer.
 */
export interface RenderLayer {
  id:         number;
  zIndex:     number;
  bounds:     Rect;
  opacity:    number;          // 0.0–1.0
  transform:  DOMMatrix2D | null;
  pixels:     Uint32Array | null;  // pre-painted pixel buffer for this layer
  dirty:      boolean;
  promoted:   boolean;         // true = compositor layer (transformed/opacity)
}

/** Minimal 2D transform matrix (no full DOMMatrix used in kernel context). */
export interface DOMMatrix2D {
  a: number; b: number; c: number; d: number;
  e: number; f: number;  // translation
}

const IDENTITY_MATRIX: DOMMatrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

// ── TileDirtyBits ─────────────────────────────────────────────────────────────

/**
 * Tracks which 64×64 tiles are dirty (need repainting).
 * A boolean 2D grid: _dirty[row][col] = true means tile (col, row) needs repaint.
 *
 * Item 907.
 */
export class TileDirtyBits {
  private _cols: number;
  private _rows: number;
  private _bits: Uint8Array;  // flat bit array: 1 bit per tile

  constructor(viewportW: number, viewportH: number) {
    this._cols = Math.ceil(viewportW / TILE_SIZE);
    this._rows = Math.ceil(viewportH / TILE_SIZE);
    this._bits = new Uint8Array(Math.ceil(this._cols * this._rows / 8));
  }

  private _idx(col: number, row: number): [number, number] {
    var bit = row * this._cols + col;
    return [bit >>> 3, bit & 7];
  }

  /** Mark a tile dirty. */
  markDirty(col: number, row: number): void {
    if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) return;
    var [byte, bit] = this._idx(col, row);
    this._bits[byte] |= (1 << bit);
  }

  /** Mark all tiles covering a pixel rectangle dirty. */
  markRectDirty(x: number, y: number, w: number, h: number): void {
    var c0 = Math.floor(x / TILE_SIZE);
    var r0 = Math.floor(y / TILE_SIZE);
    var c1 = Math.ceil((x + w) / TILE_SIZE);
    var r1 = Math.ceil((y + h) / TILE_SIZE);
    for (var r = r0; r < r1; r++) {
      for (var c = c0; c < c1; c++) {
        this.markDirty(c, r);
      }
    }
  }

  /** Check if a tile is dirty. */
  isDirty(col: number, row: number): boolean {
    if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) return false;
    var [byte, bit] = this._idx(col, row);
    return (this._bits[byte] & (1 << bit)) !== 0;
  }

  /** Clear a tile's dirty flag after it has been repainted. */
  clearDirty(col: number, row: number): void {
    if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) return;
    var [byte, bit] = this._idx(col, row);
    this._bits[byte] &= ~(1 << bit);
  }

  /** Mark all tiles dirty (e.g., on navigation or full repaint). */
  markAllDirty(): void { this._bits.fill(0xFF); }

  /** Clear all dirty flags (after full paint). */
  clearAll(): void { this._bits.fill(0); }

  /** Count dirty tiles. */
  dirtyCount(): number {
    var n = 0;
    for (var i = 0; i < this._bits.length; i++) {
      var b = this._bits[i];
      // popcount byte
      b = b - ((b >> 1) & 0x55);
      b = (b & 0x33) + ((b >> 2) & 0x33);
      n += (b + (b >> 4)) & 0x0F;
    }
    return n;
  }

  /** Iterate all dirty tile positions. */
  forEachDirty(cb: (col: number, row: number) => void): void {
    for (var r = 0; r < this._rows; r++) {
      for (var c = 0; c < this._cols; c++) {
        if (this.isDirty(c, r)) cb(c, r);
      }
    }
  }

  resize(viewportW: number, viewportH: number): void {
    this._cols = Math.ceil(viewportW / TILE_SIZE);
    this._rows = Math.ceil(viewportH / TILE_SIZE);
    this._bits = new Uint8Array(Math.ceil(this._cols * this._rows / 8));
    this.markAllDirty();
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
}

// ── TextAtlas ─────────────────────────────────────────────────────────────────

/**
 * Pre-rasterised ASCII glyph atlas.
 * All 96 printable ASCII characters (0x20–0x7F) rasterised into a Uint32Array
 * bitmap.  `blitChar()` copies one glyph with optional color.
 *
 * Item 910.
 */
export class TextAtlas {
  private _atlas:   Uint32Array;
  private _atlasW:  number;
  private _atlasH:  number;
  private _ready:   boolean = false;

  /** Build the atlas from the first 96 ASCII glyphs using the JSOS Mono VGA bitmap font. */
  init(charW: number, charH: number): void {
    this._atlasW = charW * ATLAS_COLS;
    this._atlasH = charH * ATLAS_ROWS;
    this._atlas   = new Uint32Array(this._atlasW * this._atlasH);
    // Obtain (or register) the bitmap font face at charH pixels.
    var face = fontRegistry.get('JSOS Mono', charH) ?? registerJSOSMono(charH);
    // Pre-render each character into the atlas slot
    for (var ch = 0x20; ch < 0xA0; ch++) {
      var idx  = ch - 0x20;
      var col  = idx % ATLAS_COLS;
      var row  = Math.floor(idx / ATLAS_COLS);
      var ox   = col * charW;
      var oy   = row * charH;
      var glyph = face.getGlyph(ch);
      if (!glyph) continue;
      // Blit the 1-bpp glyph bitmap directly into the atlas.
      // Set pixels write 0xFFFFFFFF (opaque white); blitChar tints with the requested color.
      var rowBytes = Math.ceil(glyph.width / 8);
      var glyphH   = Math.min(glyph.height, charH);
      var glyphW   = Math.min(glyph.width,  charW);
      for (var gy = 0; gy < glyphH; gy++) {
        for (var gx = 0; gx < glyphW; gx++) {
          var srcByte = glyph.data[gy * rowBytes + (gx >> 3)] ?? 0;
          var bit = (srcByte >> (7 - (gx & 7))) & 1;
          this._atlas[(oy + gy) * this._atlasW + (ox + gx)] = bit ? 0xFFFFFFFF : 0;
        }
      }
    }
    this._ready = true;
  }

  get ready(): boolean { return this._ready; }

  /**
   * Blit character `ch` into `dest` at (dx, dy) with the given RGBA color.
   * `destW` is the stride (width) of the destination buffer.
   */
  blitChar(
    ch: number,
    color: number,
    dest: Uint32Array,
    destW: number,
    dx: number,
    dy: number,
    charW: number,
    charH: number,
  ): void {
    if (!this._ready) return;
    // Map common Unicode characters to renderable ASCII equivalents
    if (ch >= 0xA0) {
      if (ch === 0x2022 || ch === 0x2023 || ch === 0x25CF || ch === 0x25CB || ch === 0x2219) ch = 0x2A; // bullets → *
      else if (ch === 0x2013 || ch === 0x2014) ch = 0x2D; // en/em dash → -
      else if (ch === 0x2018 || ch === 0x2019 || ch === 0x201A || ch === 0x2039 || ch === 0x203A) ch = 0x27; // smart quotes → '
      else if (ch === 0x201C || ch === 0x201D || ch === 0x201E) ch = 0x22; // double smart quotes → "
      else if (ch === 0x2026) ch = 0x2E; // ellipsis → .
      else if (ch === 0x00A0) ch = 0x20; // non-breaking space → space
      else if (ch === 0x00AB || ch === 0x00BB) ch = 0x22; // guillemets → "
      else if (ch === 0x2192) ch = 0x3E; // → → >
      else if (ch === 0x2190) ch = 0x3C; // ← → <
      // Extended Latin / currency / symbols
      else if (ch === 0x20AC) ch = 0x45; // € → E
      else if (ch === 0x00A3) ch = 0x4C; // £ → L
      else if (ch === 0x00A5) ch = 0x59; // ¥ → Y
      else if (ch === 0x00A9) ch = 0x43; // © → C
      else if (ch === 0x00AE) ch = 0x52; // ® → R
      else if (ch === 0x2122) ch = 0x54; // ™ → T
      else if (ch === 0x00B0) ch = 0x6F; // ° → o
      else if (ch === 0x00B7) ch = 0x2E; // · → .
      else if (ch === 0x00D7) ch = 0x78; // × → x
      else if (ch === 0x00F7) ch = 0x2F; // ÷ → /
      else if (ch === 0x2260) ch = 0x21; // ≠ → !
      else if (ch === 0x2264) ch = 0x3C; // ≤ → <
      else if (ch === 0x2265) ch = 0x3E; // ≥ → >
      else if (ch === 0x221E) ch = 0x38; // ∞ → 8
      else if (ch === 0x2191) ch = 0x5E; // ↑ → ^
      else if (ch === 0x2193) ch = 0x76; // ↓ → v
      else if (ch === 0x2194) ch = 0x2D; // ↔ → -
      else if (ch === 0x25B6 || ch === 0x25BA) ch = 0x3E; // ▶/► → >
      else if (ch === 0x25C0 || ch === 0x25C4) ch = 0x3C; // ◀/◄ → <
      else if (ch === 0x2605 || ch === 0x2606) ch = 0x2A; // ★/☆ → *
      else if (ch === 0x2713 || ch === 0x2714) ch = 0x56; // ✓/✔ → V
      else if (ch === 0x2717 || ch === 0x2718) ch = 0x58; // ✗/✘ → X
      else if (ch === 0x00C0 || ch === 0x00C1 || ch === 0x00C2 || ch === 0x00C3 || ch === 0x00C4 || ch === 0x00C5) ch = 0x41; // À-Å → A
      else if (ch === 0x00C7) ch = 0x43; // Ç → C
      else if (ch === 0x00C8 || ch === 0x00C9 || ch === 0x00CA || ch === 0x00CB) ch = 0x45; // È-Ë → E
      else if (ch === 0x00CC || ch === 0x00CD || ch === 0x00CE || ch === 0x00CF) ch = 0x49; // Ì-Ï → I
      else if (ch === 0x00D1) ch = 0x4E; // Ñ → N
      else if (ch === 0x00D2 || ch === 0x00D3 || ch === 0x00D4 || ch === 0x00D5 || ch === 0x00D6 || ch === 0x00D8) ch = 0x4F; // Ò-Ö,Ø → O
      else if (ch === 0x00D9 || ch === 0x00DA || ch === 0x00DB || ch === 0x00DC) ch = 0x55; // Ù-Ü → U
      else if (ch === 0x00DD) ch = 0x59; // Ý → Y
      else if (ch === 0x00E0 || ch === 0x00E1 || ch === 0x00E2 || ch === 0x00E3 || ch === 0x00E4 || ch === 0x00E5) ch = 0x61; // à-å → a
      else if (ch === 0x00E7) ch = 0x63; // ç → c
      else if (ch === 0x00E8 || ch === 0x00E9 || ch === 0x00EA || ch === 0x00EB) ch = 0x65; // è-ë → e
      else if (ch === 0x00EC || ch === 0x00ED || ch === 0x00EE || ch === 0x00EF) ch = 0x69; // ì-ï → i
      else if (ch === 0x00F1) ch = 0x6E; // ñ → n
      else if (ch === 0x00F2 || ch === 0x00F3 || ch === 0x00F4 || ch === 0x00F5 || ch === 0x00F6 || ch === 0x00F8) ch = 0x6F; // ò-ö,ø → o
      else if (ch === 0x00F9 || ch === 0x00FA || ch === 0x00FB || ch === 0x00FC) ch = 0x75; // ù-ü → u
      else if (ch === 0x00FD || ch === 0x00FF) ch = 0x79; // ý,ÿ → y
      else if (ch === 0x0100 || ch === 0x0102 || ch === 0x0104) ch = 0x41; // Ā,Ă,Ą → A
      else if (ch === 0x0101 || ch === 0x0103 || ch === 0x0105) ch = 0x61; // ā,ă,ą → a
      else if (ch === 0x0106 || ch === 0x0108 || ch === 0x010C) ch = 0x43; // Ć,Ĉ,Č → C
      else if (ch === 0x0107 || ch === 0x0109 || ch === 0x010D) ch = 0x63; // ć,ĉ,č → c
      else if (ch === 0x010E || ch === 0x0110) ch = 0x44; // Ď,Đ → D
      else if (ch === 0x010F || ch === 0x0111) ch = 0x64; // ď,đ → d
      else if (ch === 0x0112 || ch === 0x0116 || ch === 0x0118 || ch === 0x011A) ch = 0x45; // Ē,Ė,Ę,Ě → E
      else if (ch === 0x0113 || ch === 0x0117 || ch === 0x0119 || ch === 0x011B) ch = 0x65; // ē,ė,ę,ě → e
      else if (ch === 0x011E || ch === 0x0122) ch = 0x47; // Ğ,Ģ → G
      else if (ch === 0x011F || ch === 0x0123) ch = 0x67; // ğ,ģ → g
      else if (ch === 0x012A || ch === 0x012E || ch === 0x0130) ch = 0x49; // Ī,Į,İ → I
      else if (ch === 0x012B || ch === 0x012F || ch === 0x0131) ch = 0x69; // ī,į,ı → i
      else if (ch === 0x0136) ch = 0x4B; // Ķ → K
      else if (ch === 0x0137) ch = 0x6B; // ķ → k
      else if (ch === 0x0139 || ch === 0x013B || ch === 0x013D) ch = 0x4C; // Ĺ,Ļ,Ľ → L
      else if (ch === 0x013A || ch === 0x013C || ch === 0x013E || ch === 0x0142) ch = 0x6C; // ĺ,ļ,ľ,ł → l
      else if (ch === 0x0141) ch = 0x4C; // Ł → L
      else if (ch === 0x0143 || ch === 0x0145 || ch === 0x0147) ch = 0x4E; // Ń,Ņ,Ň → N
      else if (ch === 0x0144 || ch === 0x0146 || ch === 0x0148) ch = 0x6E; // ń,ņ,ň → n
      else if (ch === 0x0150 || ch === 0x0152) ch = 0x4F; // Ő,Œ → O
      else if (ch === 0x0151 || ch === 0x0153) ch = 0x6F; // ő,œ → o
      else if (ch === 0x0154 || ch === 0x0158) ch = 0x52; // Ŕ,Ř → R
      else if (ch === 0x0155 || ch === 0x0159) ch = 0x72; // ŕ,ř → r
      else if (ch === 0x015A || ch === 0x015E || ch === 0x0160) ch = 0x53; // Ś,Ş,Š → S
      else if (ch === 0x015B || ch === 0x015F || ch === 0x0161) ch = 0x73; // ś,ş,š → s
      else if (ch === 0x0162 || ch === 0x0164) ch = 0x54; // Ţ,Ť → T
      else if (ch === 0x0163 || ch === 0x0165) ch = 0x74; // ţ,ť → t
      else if (ch === 0x016A || ch === 0x016E || ch === 0x0170 || ch === 0x0172) ch = 0x55; // Ū,Ů,Ű,Ų → U
      else if (ch === 0x016B || ch === 0x016F || ch === 0x0171 || ch === 0x0173) ch = 0x75; // ū,ů,ű,ų → u
      else if (ch === 0x0179 || ch === 0x017B || ch === 0x017D) ch = 0x5A; // Ź,Ż,Ž → Z
      else if (ch === 0x017A || ch === 0x017C || ch === 0x017E) ch = 0x7A; // ź,ż,ž → z
      else if (ch === 0x00DF) ch = 0x73; // ß → s
      else if (ch === 0x00C6) ch = 0x41; // Æ → A
      else if (ch === 0x00E6) ch = 0x61; // æ → a
      else if (ch === 0x00DE) ch = 0x54; // Þ → T
      else if (ch === 0x00FE) ch = 0x74; // þ → t
      else if (ch === 0x00F0) ch = 0x64; // ð → d
      else if (ch === 0x00D0) ch = 0x44; // Ð → D
      else if (ch === 0x2010 || ch === 0x2011 || ch === 0x2012 || ch === 0x2015) ch = 0x2D; // hyphens → -
      else if (ch === 0x2032) ch = 0x27; // ′ → '
      else if (ch === 0x2033) ch = 0x22; // ″ → "
      else if (ch === 0x00B1) ch = 0x2B; // ± → +
      else if (ch === 0x00BC) ch = 0x25; // ¼ → %  (approximation)
      else if (ch === 0x00BD) ch = 0x25; // ½ → %
      else if (ch === 0x00BE) ch = 0x25; // ¾ → %
      else if (ch === 0x00BF) ch = 0x3F; // ¿ → ?
      else if (ch === 0x00A1) ch = 0x21; // ¡ → !
      else if (ch === 0x00B6) ch = 0x50; // ¶ → P
      else if (ch === 0x00A7) ch = 0x53; // § → S
      else if (ch === 0x00B2) ch = 0x32; // ² → 2
      else if (ch === 0x00B3) ch = 0x33; // ³ → 3
      else if (ch === 0x00B9) ch = 0x31; // ¹ → 1
      else if (ch === 0x00B5) ch = 0x75; // µ → u
      else if (ch === 0x2116) ch = 0x4E; // № → N
      else if (ch === 0x2212) ch = 0x2D; // − (minus sign) → -
      else if (ch === 0x00AD) ch = 0x2D; // soft hyphen → -
      else return; // Unknown Unicode — skip
    }
    if (ch < 0x20) return;
    var idx  = ch - 0x20;
    var col  = idx % ATLAS_COLS;
    var row  = Math.floor(idx / ATLAS_COLS);
    var ox   = col * charW;
    var oy   = row * charH;
    for (var y = 0; y < charH; y++) {
      for (var x = 0; x < charW; x++) {
        var src = this._atlas[(oy + y) * this._atlasW + (ox + x)];
        if (src !== 0) {
          dest[(dy + y) * destW + (dx + x)] = color;
        }
      }
    }
  }
}

/** Shared singleton atlas. */
export const textAtlas = new TextAtlas();

// ── LayerTree ─────────────────────────────────────────────────────────────────

/**
 * Maintains the sorted layer list for Painter's algorithm (item 909).
 * Re-sorts only when a z-index mutation is detected.
 */
export class LayerTree {
  private _layers:   RenderLayer[] = [];
  private _sorted:   boolean = false;
  private _nextId:   number  = 1;

  /** Add a new layer. */
  addLayer(bounds: Rect, zIndex: number, opacity: number, transform: DOMMatrix2D | null): RenderLayer {
    var layer: RenderLayer = {
      id:        this._nextId++,
      zIndex,
      bounds,
      opacity,
      transform,
      pixels:    null,
      dirty:     true,
      promoted:  transform !== null || opacity < 1.0,
    };
    this._layers.push(layer);
    this._sorted = false;
    return layer;
  }

  /** Remove a layer by id. */
  removeLayer(id: number): void {
    this._layers = this._layers.filter(l => l.id !== id);
    this._sorted = false;
  }

  /** Update z-index; triggers re-sort. */
  setZIndex(id: number, zIndex: number): void {
    var l = this._layers.find(x => x.id === id);
    if (l && l.zIndex !== zIndex) { l.zIndex = zIndex; this._sorted = false; }
  }

  /** Update opacity; marks layer dirty (compositor-only, no repaint). */
  setOpacity(id: number, opacity: number): void {
    var l = this._layers.find(x => x.id === id);
    if (l) { l.opacity = opacity; l.dirty = true; l.promoted = true; }
  }

  /** Update transform; marks layer dirty (compositor-only). */
  setTransform(id: number, m: DOMMatrix2D): void {
    var l = this._layers.find(x => x.id === id);
    if (l) { l.transform = m; l.dirty = true; l.promoted = true; }
  }

  /** Get layers in painter order (back to front). */
  sorted(): RenderLayer[] {
    if (!this._sorted) {
      this._layers.sort((a, b) => a.zIndex - b.zIndex);
      this._sorted = true;
    }
    return this._layers;
  }

  /** Mark all layers dirty. */
  markAllDirty(): void { for (var l of this._layers) l.dirty = true; }

  get count(): number { return this._layers.length; }

  /** Clear all layers on navigation. */
  clear(): void { this._layers.length = 0; this._sorted = false; this._nextId = 1; }
}

// ── BorderShadowCache ─────────────────────────────────────────────────────────

/**
 * Pre-rasterized border and box-shadow textures per element.
 * Avoids recomputing expensive border drawing on every frame.
 *
 * Item 914.
 */
interface BorderShadowEntry {
  w: number; h: number;
  data: Uint32Array;
  key:  string;
}

export class BorderShadowCache {
  private _cache: Map<string, BorderShadowEntry> = new Map();
  private static readonly MAX = 128;

  /** Build a cache key from border/shadow CSS properties and element size. */
  static key(
    w: number, h: number,
    borderWidth: number, borderColor: number,
    borderRadius: number, shadowBlur: number, shadowColor: number
  ): string {
    return `${w}x${h}|${borderWidth}|${borderColor.toString(16)}|${borderRadius}|${shadowBlur}|${shadowColor.toString(16)}`;
  }

  get(key: string): BorderShadowEntry | null {
    return this._cache.get(key) ?? null;
  }

  /** Rasterise and store a border+shadow texture. */
  set(key: string, entry: BorderShadowEntry): void {
    if (this._cache.size >= BorderShadowCache.MAX) {
      // Evict first entry (FIFO)
      var first = this._cache.keys().next().value;
      if (first !== undefined) this._cache.delete(first);
    }
    this._cache.set(key, entry);
  }

  /** Render a simple rectangle border into a Uint32Array (CPU path). */
  renderBorder(
    w: number, h: number,
    borderWidth: number, borderColor: number
  ): Uint32Array {
    var buf = new Uint32Array(w * h);
    // Top/bottom borders
    for (var x = 0; x < w; x++) {
      for (var b = 0; b < borderWidth; b++) {
        buf[b * w + x] = borderColor;
        buf[(h - 1 - b) * w + x] = borderColor;
      }
    }
    // Left/right borders
    for (var y = borderWidth; y < h - borderWidth; y++) {
      for (var b2 = 0; b2 < borderWidth; b2++) {
        buf[y * w + b2] = borderColor;
        buf[y * w + (w - 1 - b2)] = borderColor;
      }
    }
    return buf;
  }

  clear(): void { this._cache.clear(); }
}

export const borderShadowCache = new BorderShadowCache();

// ── Compositor ────────────────────────────────────────────────────────────────

/**
 * Compositor: composites all layers onto the final framebuffer.
 *
 * Promoted layers (transform/opacity) are composited without re-running
 * layout or paint — only the composite step changes.
 *
 * Item 908: separate transform/opacity animation from layout+paint.
 */
export class Compositor {
  private _layerTree: LayerTree;
  private _tileDirty: TileDirtyBits;
  private _viewportW: number;
  private _viewportH: number;
  private _framebuf:  Uint32Array;

  /** Ticks since last full composite. */
  private _frameCount = 0;

  constructor(viewportW: number, viewportH: number) {
    this._viewportW = viewportW;
    this._viewportH = viewportH;
    this._layerTree = new LayerTree();
    this._tileDirty = new TileDirtyBits(viewportW, viewportH);
    this._framebuf  = new Uint32Array(viewportW * viewportH);
  }

  get layerTree(): LayerTree  { return this._layerTree; }
  get tileDirty(): TileDirtyBits { return this._tileDirty; }

  /** Called when viewport changes size. */
  resize(w: number, h: number): void {
    this._viewportW = w;
    this._viewportH = h;
    this._framebuf  = new Uint32Array(w * h);
    this._tileDirty.resize(w, h);
    this._layerTree.markAllDirty();
  }

  /**
   * Composite frame.
   *
   * 1. Sorts layers (Painter's algorithm — item 909).
   * 2. For each dirty tile, repaints all overlapping layers.
   * 3. For promoted layers (transform/opacity), applies matrix + blend.
   * 4. Returns the updated framebuffer.
   *
   * Item 907: only dirty tiles are repainted.
   * Item 908: promoted layers skip paint, only composite step changes.
   */
  composite(): Uint32Array {
    this._frameCount++;
    var layers = this._layerTree.sorted();
    var fbW    = this._viewportW;

    this._tileDirty.forEachDirty((col, row) => {
      var tx = col * TILE_SIZE;
      var ty = row * TILE_SIZE;
      var tw = Math.min(TILE_SIZE, this._viewportW - tx);
      var th = Math.min(TILE_SIZE, this._viewportH - ty);

      // Clear tile to background
      for (var py = ty; py < ty + th; py++) {
        for (var px = tx; px < tx + tw; px++) {
          this._framebuf[py * fbW + px] = 0xFF1E1E2E; // dark background
        }
      }

      // Composite each layer that intersects this tile
      for (var li = 0; li < layers.length; li++) {
        var layer = layers[li];
        if (!this._layerIntersectsTile(layer, tx, ty, tw, th)) continue;
        if (layer.pixels === null) continue;

        this._compositeLayerTile(layer, tx, ty, tw, th, fbW);
      }

      this._tileDirty.clearDirty(col, row);
    });

    return this._framebuf;
  }

  private _layerIntersectsTile(layer: RenderLayer, tx: number, ty: number, tw: number, th: number): boolean {
    var b = layer.bounds;
    return !(b.x + b.w <= tx || b.x >= tx + tw || b.y + b.h <= ty || b.y >= ty + th);
  }

  private _compositeLayerTile(
    layer: RenderLayer,
    tx: number, ty: number, tw: number, th: number,
    fbW: number
  ): void {
    var b   = layer.bounds;
    var lW  = b.w;
    var opacity = Math.round(layer.opacity * 255);

    for (var py = ty; py < ty + th; py++) {
      var ly = py - b.y;
      if (ly < 0 || ly >= b.h) continue;
      for (var px = tx; px < tx + tw; px++) {
        var lx = px - b.x;
        if (lx < 0 || lx >= lW) continue;

        var src = layer.pixels![ly * lW + lx];
        if (src === 0) continue;

        // Apply opacity via simple alpha blend (item 919)
        if (opacity < 255) {
          var srcA   = (src >>> 24) & 0xFF;
          var blendA = (srcA * opacity) >>> 8;
          src        = (src & 0x00FFFFFF) | (blendA << 24);
        }

        // Alpha blend with destination
        var dst = this._framebuf[py * fbW + px];
        this._framebuf[py * fbW + px] = this._alphaBlend(src, dst);
      }
    }
  }

  /** Alpha-composite `src` over `dst` (both ARGB). */
  private _alphaBlend(src: number, dst: number): number {
    var srcA = (src >>> 24) & 0xFF;
    if (srcA === 255) return src;
    if (srcA === 0)   return dst;
    var dstA = (dst >>> 24) & 0xFF;
    var invA = 255 - srcA;
    var outA = srcA + ((dstA * invA) >>> 8);
    var outR = (((src >>> 16) & 0xFF) * srcA + ((dst >>> 16) & 0xFF) * invA) >>> 8;
    var outG = (((src >>>  8) & 0xFF) * srcA + ((dst >>>  8) & 0xFF) * invA) >>> 8;
    var outB = ((src & 0xFF) * srcA + (dst & 0xFF) * invA) >>> 8;
    return (outA << 24) | (outR << 16) | (outG << 8) | outB;
  }

  /**
   * Fast solid-color fill for `background-color` (item 913).
   * Only repaints dirty tiles; skips compositing when no children overlap.
   */
  solidFillLayer(layer: RenderLayer, color: number): void {
    if (layer.pixels === null) {
      layer.pixels = new Uint32Array(layer.bounds.w * layer.bounds.h);
    }
    layer.pixels.fill(color);
    layer.dirty = true;
    this._tileDirty.markRectDirty(layer.bounds.x, layer.bounds.y, layer.bounds.w, layer.bounds.h);
  }

  /** Mark a rect dirty (e.g., after DOM mutation). */
  invalidateRect(x: number, y: number, w: number, h: number): void {
    this._tileDirty.markRectDirty(x, y, w, h);
  }

  /** Mark all tiles dirty (full repaint). */
  invalidateAll(): void {
    this._tileDirty.markAllDirty();
    this._layerTree.markAllDirty();
  }

  get frameCount(): number { return this._frameCount; }
  get dirtyTiles(): number { return this._tileDirty.dirtyCount(); }

  /** Reset on navigation. */
  reset(): void {
    this._layerTree.clear();
    this._tileDirty.markAllDirty();
    this._framebuf.fill(0);
  }
}

// ── TileRenderer ─────────────────────────────────────────────────────────────

/**
 * Tile-based page renderer.
 *
 * Converts RenderedLine[] from the layout pass into layer pixel buffers,
 * only repainting tiles that the dirty-bit tracker marks as dirty.
 *
 * Item 907.
 */
export class TileRenderer {
  private _compositor: Compositor;
  private _baseLayer:  RenderLayer | null = null;
  private _vpW:        number;
  private _vpH:        number;

  constructor(vpW: number, vpH: number) {
    this._vpW         = vpW;
    this._vpH         = vpH;
    this._compositor  = new Compositor(vpW, vpH);
  }

  get compositor(): Compositor { return this._compositor; }

  /**
   * Paint `lines` into the base layer, respecting dirty tiles.
   * `scrollY` is the pixel scroll offset.
   */
  paint(
    lines:    RenderedLine[],
    scrollY:  number,
    vpW:      number,
    vpH:      number,
    bgColor:  number = 0xFFFFFFFF,
  ): Uint32Array {
    if (vpW !== this._vpW || vpH !== this._vpH) {
      this._vpW = vpW;
      this._vpH = vpH;
      this._compositor.resize(vpW, vpH);
      this._baseLayer = null;
    }

    if (this._baseLayer === null) {
      this._baseLayer = this._compositor.layerTree.addLayer(
        { x: 0, y: 0, w: vpW, h: vpH }, 0, 1.0, null
      );
      this._baseLayer.pixels = new Uint32Array(vpW * vpH);
      this._compositor.tileDirty.markAllDirty();
    }

    var pixels = this._baseLayer.pixels!;
    var dirty  = this._compositor.tileDirty;

    // Only process tiles that are dirty
    dirty.forEachDirty((col, row) => {
      var tx = col * TILE_SIZE;
      var ty = row * TILE_SIZE;
      var tw = Math.min(TILE_SIZE, vpW - tx);
      var th = Math.min(TILE_SIZE, vpH - ty);

      // Clear tile to background
      for (var py = ty; py < ty + th; py++) {
        for (var px = tx; px < tx + tw; px++) {
          pixels[py * vpW + px] = bgColor;
        }
      }

      // Render lines that intersect this tile
      var scrolledTy = ty + scrollY;
      var scrolledTh = scrolledTy + th;

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.y + line.lineH < scrolledTy) continue;
        if (line.y >= scrolledTh) break;

        var lineY = line.y - scrollY;
        if (lineY < ty || lineY >= ty + th) continue;
        if (lineY < 0 || lineY >= vpH) continue;

        this._renderLine(line, pixels, vpW, tx, lineY, tw);
      }
    });

    return this._compositor.composite();
  }

  private _renderLine(
    line: RenderedLine,
    pixels: Uint32Array,
    vpW: number,
    tileX: number,
    lineY: number,
    tileW: number,
  ): void {
    var lineH = line.lineH || CHAR_H;

    // ── Background fill (bgColor / preBg / hrLine) ─────────────────────────
    if (line.bgColor !== undefined) {
      var bgFill = line.bgColor | 0xFF000000;  // ensure opaque
      for (var bgy = lineY; bgy < Math.min(lineY + lineH, pixels.length / vpW); bgy++) {
        for (var bgx = tileX; bgx < tileX + tileW; bgx++) {
          pixels[bgy * vpW + bgx] = bgFill;
        }
      }
    } else if (line.preBg) {
      // Code block background (#1e1e2e / dark)
      for (var bgy2 = lineY; bgy2 < Math.min(lineY + lineH, pixels.length / vpW); bgy2++) {
        for (var bgx2 = tileX; bgx2 < tileX + tileW; bgx2++) {
          pixels[bgy2 * vpW + bgx2] = 0xFF2D2D2D;
        }
      }
    } else if (line.hrLine) {
      // Horizontal rule: single mid-line
      var hrY = lineY + 1;
      if (hrY >= 0 && hrY < pixels.length / vpW) {
        for (var hrx = tileX; hrx < tileX + tileW; hrx++) {
          pixels[hrY * vpW + hrx] = 0xFFAAAAAA;
        }
      }
    }

    // ── Span rendering ──────────────────────────────────────────────────────
    for (var si = 0; si < line.nodes.length; si++) {
      var span = line.nodes[si];
      var x    = span.x;
      var text = span.text;
      var clr  = span.color as number;
      if (clr === 0 || clr === 0x00000000) continue;  // visibility:hidden — skip rendering but layout reserved space
      var fontScale = (span as any).fontScale || 1;
      var cw   = Math.round(CHAR_W * fontScale);
      var ch   = Math.round(CHAR_H * fontScale);

      for (var ci = 0; ci < text.length; ci++) {
        var px = x + ci * cw;
        if (px < tileX || px >= tileX + tileW) continue;
        if (px < 0 || px + cw > vpW) continue;
        if (lineY < 0 || lineY + ch > pixels.length / vpW) continue;

        // Use text atlas blit (item 910)
        if (textAtlas.ready) {
          textAtlas.blitChar(text.charCodeAt(ci), clr, pixels, vpW, px, lineY, cw, ch);
        } else {
          // Fallback: fill single pixel per character
          pixels[lineY * vpW + px] = clr;
        }
      }

      // ── Text decoration ──────────────────────────────────────────────────
      var spanW  = text.length * cw;
      var spanX0 = x;
      var spanX1 = Math.min(x + spanW, tileX + tileW);
      if (spanX0 < tileX) spanX0 = tileX;

      // Underline: drawn one pixel below baseline (at lineY + ch)
      if ((span as any).underline && spanX0 < spanX1) {
        var ulY = lineY + ch;
        if (ulY >= 0 && ulY < pixels.length / vpW) {
          for (var ulx = spanX0; ulx < spanX1; ulx++) {
            if (ulx >= 0 && ulx < vpW) pixels[ulY * vpW + ulx] = clr;
          }
        }
      }

      // Strikethrough (del): drawn at mid-height of the character cell
      if ((span as any).del && spanX0 < spanX1) {
        var stY = lineY + Math.round(ch * 0.55);
        if (stY >= 0 && stY < pixels.length / vpW) {
          for (var stx = spanX0; stx < spanX1; stx++) {
            if (stx >= 0 && stx < vpW) pixels[stY * vpW + stx] = clr;
          }
        }
      }
    }
  }

  /** Invalidate a region (DOM mutation or scroll). */
  invalidate(x: number, y: number, w: number, h: number): void {
    this._compositor.invalidateRect(x, y, w, h);
    if (this._baseLayer) this._baseLayer.dirty = true;
  }

  /** Full reset (navigation). */
  reset(): void {
    this._compositor.reset();
    this._baseLayer = null;
  }

  get dirtyTileCount(): number { return this._compositor.dirtyTiles; }
}

// ── AnimationCompositor ───────────────────────────────────────────────────────

/**
 * Handles CSS transform / opacity animations entirely on the compositor layer,
 * bypassing layout and paint.
 *
 * Item 908: separate transform/opacity from layout+paint.
 */
export class AnimationCompositor {
  private _animations: Map<number, AnimationState> = new Map();
  private _compositor: Compositor;

  constructor(compositor: Compositor) {
    this._compositor = compositor;
  }

  /**
   * Register a transform animation for a layer.
   * The layer is promoted and future frames only run the compositor pass.
   */
  animateTransform(layerId: number, from: DOMMatrix2D, to: DOMMatrix2D, durationMs: number): void {
    this._animations.set(layerId, {
      kind:       'transform',
      from,
      to,
      startMs:    _nowMs(),
      durationMs,
      layerId,
    });
    this._compositor.layerTree.setTransform(layerId, from);
  }

  /** Register an opacity animation for a layer. */
  animateOpacity(layerId: number, fromOpacity: number, toOpacity: number, durationMs: number): void {
    this._animations.set(layerId, {
      kind:       'opacity',
      fromOpacity,
      toOpacity,
      startMs:    _nowMs(),
      durationMs,
      layerId,
    });
  }

  /**
   * Called every frame; advances all animations.
   * Marks affected tiles dirty for compositor-only repaint.
   * No layout or paint pass required.
   */
  tick(): void {
    var now = _nowMs();
    this._animations.forEach((anim, layerId) => {
      var t = Math.min(1, (now - anim.startMs) / anim.durationMs);
      var eased = _ease(t);

      if (anim.kind === 'opacity') {
        var opacity = anim.fromOpacity! + (anim.toOpacity! - anim.fromOpacity!) * eased;
        this._compositor.layerTree.setOpacity(layerId, opacity);
      } else {
        var m = _lerpMatrix(anim.from!, anim.to!, eased);
        this._compositor.layerTree.setTransform(layerId, m);
      }

      // Find layer bounds and mark dirty
      var layer = this._compositor.layerTree.sorted().find(l => l.id === layerId);
      if (layer) {
        this._compositor.invalidateRect(layer.bounds.x, layer.bounds.y, layer.bounds.w, layer.bounds.h);
      }

      if (t >= 1) this._animations.delete(layerId);
    });
  }

  get activeCount(): number { return this._animations.size; }
}

interface AnimationState {
  kind:         'transform' | 'opacity';
  from?:        DOMMatrix2D;
  to?:          DOMMatrix2D;
  fromOpacity?: number;
  toOpacity?:   number;
  startMs:      number;
  durationMs:   number;
  layerId:      number;
}

/** Ease-in-out cubic timing function. */
function _ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Linearly interpolate two 2D matrices. */
function _lerpMatrix(a: DOMMatrix2D, b: DOMMatrix2D, t: number): DOMMatrix2D {
  return {
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
    c: a.c + (b.c - a.c) * t,
    d: a.d + (b.d - a.d) * t,
    e: a.e + (b.e - a.e) * t,
    f: a.f + (b.f - a.f) * t,
  };
}

function _nowMs(): number {
  return (typeof kernel !== 'undefined' && kernel.getTicks)
    ? kernel.getTicks() * 10
    : Date.now();
}
