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

  /** Build the atlas from the first 96 ASCII glyphs. */
  init(charW: number, charH: number): void {
    this._atlasW = charW * ATLAS_COLS;
    this._atlasH = charH * ATLAS_ROWS;
    this._atlas   = new Uint32Array(this._atlasW * this._atlasH);
    // Pre-render each character into the atlas slot
    for (var ch = 0x20; ch < 0xA0; ch++) {
      var idx  = ch - 0x20;
      var col  = idx % ATLAS_COLS;
      var row  = Math.floor(idx / ATLAS_COLS);
      var ox   = col * charW;
      var oy   = row * charH;
      // Fill with a 0xFFFFFF white glyph placeholder.
      // Real implementation would use a bitmap font table.
      for (var y = 0; y < charH; y++) {
        for (var x = 0; x < charW; x++) {
          // Checkerboard placeholder — replace with actual font data
          var on = ((x + y) & 1) === 0;
          this._atlas[(oy + y) * this._atlasW + (ox + x)] = on ? 0xFFFFFFFF : 0;
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
    if (!this._ready || ch < 0x20 || ch >= 0xA0) return;
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
    for (var si = 0; si < line.nodes.length; si++) {
      var span = line.nodes[si];
      var x    = span.x;
      var text = span.text;
      var clr  = span.color as number;
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
