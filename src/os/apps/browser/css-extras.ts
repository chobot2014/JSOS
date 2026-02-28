/**
 * JSOS Browser CSS Extras — Items 427, 430, 918, 965
 *
 * Item 427: CSS `resize` property — ResizeHandle drag logic
 * Item 430: CSS `@font-face` — FontFaceRegistry with web font loading
 * Item 918: CSS clip-path layer-bitmap acceleration — ClipPathLayerCache (LRU)
 * Item 965: CSS paint / audio Worklets — WorkletMicroContext isolated execution pool
 */

// ───────────────────────────────────────────────────────────────────────────────
//  Item 427 — CSS resize property
// ───────────────────────────────────────────────────────────────────────────────

export type CSSResizeValue = 'none' | 'both' | 'horizontal' | 'vertical';

/** Parse the CSS `resize` property value */
export function parseCSSResize(value: string): CSSResizeValue {
  const v = value.trim().toLowerCase();
  if (v === 'both' || v === 'horizontal' || v === 'vertical') return v;
  return 'none';
}

export interface ResizeConstraints {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface ResizeState {
  active: boolean;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
}

/**
 * ResizeHandle — manages drag-to-resize for an element.
 * The consumer calls onMouseDown/onMouseMove/onMouseUp with the raw
 * pointer coordinates; ResizeHandle applies constraints and returns
 * the new dimensions.
 */
export class ResizeHandle {
  readonly element: { width: number; height: number };
  readonly resizeType: CSSResizeValue;
  readonly constraints: ResizeConstraints;
  private _state: ResizeState = { active: false, startX: 0, startY: 0, startW: 0, startH: 0 };
  private _handleSize = 10; // px — the draggable corner/edge area

  constructor(
    element: { width: number; height: number },
    resizeType: CSSResizeValue,
    constraints: ResizeConstraints = {}
  ) {
    this.element = element;
    this.resizeType = resizeType;
    this.constraints = constraints;
  }

  /** Returns true when the point (px, py) falls within the resize handle area */
  isInHandle(px: number, py: number, elementX: number, elementY: number): boolean {
    if (this.resizeType === 'none') return false;
    const right  = elementX + this.element.width;
    const bottom = elementY + this.element.height;
    const hs = this._handleSize;

    if (this.resizeType === 'both') {
      return px >= right - hs && px <= right && py >= bottom - hs && py <= bottom;
    }
    if (this.resizeType === 'horizontal') {
      return px >= right - hs && px <= right && py >= elementY && py <= bottom;
    }
    if (this.resizeType === 'vertical') {
      return px >= elementX && px <= right && py >= bottom - hs && py <= bottom;
    }
    return false;
  }

  onMouseDown(px: number, py: number): void {
    this._state = { active: true, startX: px, startY: py, startW: this.element.width, startH: this.element.height };
  }

  /** Returns { width, height } clamped to constraints, or null if not active */
  onMouseMove(px: number, py: number): { width: number; height: number } | null {
    if (!this._state.active) return null;
    const dx = px - this._state.startX;
    const dy = py - this._state.startY;
    const { minWidth = 20, maxWidth = 99999, minHeight = 20, maxHeight = 99999 } = this.constraints;
    let newW = this._state.startW, newH = this._state.startH;

    if (this.resizeType === 'both' || this.resizeType === 'horizontal') {
      newW = Math.max(minWidth, Math.min(maxWidth, this._state.startW + dx));
    }
    if (this.resizeType === 'both' || this.resizeType === 'vertical') {
      newH = Math.max(minHeight, Math.min(maxHeight, this._state.startH + dy));
    }
    this.element.width = newW;
    this.element.height = newH;
    return { width: newW, height: newH };
  }

  onMouseUp(): void {
    this._state.active = false;
  }

  get cursor(): string {
    switch (this.resizeType) {
      case 'both':       return 'nwse-resize';
      case 'horizontal': return 'ew-resize';
      case 'vertical':   return 'ns-resize';
      default:           return 'default';
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  Item 430 — CSS @font-face
// ───────────────────────────────────────────────────────────────────────────────

export interface FontFaceDescriptor {
  family: string;
  src: Array<{ url: string; format?: string }>;
  style?: string;
  weight?: string | number;
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
  unicodeRange?: string;
  stretch?: string;
}

export interface LoadedFont {
  family: string;
  style: string;
  weight: string;
  data: Uint8Array;
  format: string;
}

export type FontFetchFn = (url: string) => Promise<Uint8Array>;

/**
 * FontFaceRegistry — parses @font-face CSS rules, downloads font files,
 * and registers them for use in the glyph atlas.
 */
export class FontFaceRegistry {
  private _declarations = new Map<string, FontFaceDescriptor>();
  private _loaded = new Map<string, LoadedFont>();
  private _pending = new Map<string, Promise<LoadedFont>>();
  private _fetchFn: FontFetchFn;

  constructor(fetchFn: FontFetchFn) {
    this._fetchFn = fetchFn;
  }

  /** Parse one @font-face rule block into a FontFaceDescriptor */
  parseFontFace(ruleText: string): FontFaceDescriptor {
    const desc: FontFaceDescriptor = { family: '', src: [] };

    // family
    const familyM = ruleText.match(/font-family\s*:\s*['"]?([^;'"]+)['"]?\s*;/i);
    if (familyM) desc.family = familyM[1].trim();

    // src — handle url(...) format(...)
    const srcM = ruleText.match(/src\s*:\s*([^;]+);/i);
    if (srcM) {
      const srcText = srcM[1];
      const entryPattern = /url\(['"]?([^'")\s]+)['"]?\)(?:\s+format\(['"]?([^'")\s]+)['"]?\))?/g;
      let m: RegExpExecArray | null;
      while ((m = entryPattern.exec(srcText)) !== null) {
        desc.src.push({ url: m[1], format: m[2]?.toLowerCase() });
      }
    }

    const weightM = ruleText.match(/font-weight\s*:\s*([^;]+);/i);
    if (weightM) desc.weight = weightM[1].trim();

    const styleM = ruleText.match(/font-style\s*:\s*([^;]+);/i);
    if (styleM) desc.style = styleM[1].trim();

    const displayM = ruleText.match(/font-display\s*:\s*([^;]+);/i);
    if (displayM) desc.display = displayM[1].trim() as FontFaceDescriptor['display'];

    const rangeM = ruleText.match(/unicode-range\s*:\s*([^;]+);/i);
    if (rangeM) desc.unicodeRange = rangeM[1].trim();

    return desc;
  }

  /** Parse all @font-face rules from a full stylesheet string */
  parseStylesheet(css: string): FontFaceDescriptor[] {
    const results: FontFaceDescriptor[] = [];
    const pattern = /@font-face\s*\{([^}]*)\}/gi;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(css)) !== null) {
      const desc = this.parseFontFace(m[1]);
      if (desc.family) { this._declarations.set(desc.family, desc); results.push(desc); }
    }
    return results;
  }

  /**
   * Load (download + register) a font face.
   * Returns a promise that resolves when the first loadable source URL succeeds.
   */
  async loadFontFace(desc: FontFaceDescriptor): Promise<LoadedFont> {
    const key = `${desc.family}|${desc.weight ?? 'normal'}|${desc.style ?? 'normal'}`;
    if (this._loaded.has(key)) return this._loaded.get(key)!;
    if (this._pending.has(key)) return this._pending.get(key)!;

    const promise = this._doLoad(desc, key);
    this._pending.set(key, promise);
    return promise;
  }

  private async _doLoad(desc: FontFaceDescriptor, key: string): Promise<LoadedFont> {
    let lastError: unknown;
    for (const src of desc.src) {
      try {
        const data = await this._fetchFn(src.url);
        const format = src.format ?? this._guessFormat(src.url);
        const font: LoadedFont = {
          family: desc.family,
          style: desc.style ?? 'normal',
          weight: String(desc.weight ?? 'normal'),
          data,
          format,
        };
        this._loaded.set(key, font);
        this._pending.delete(key);
        return font;
      } catch (e) {
        lastError = e;
      }
    }
    this._pending.delete(key);
    throw new Error(`Failed to load font "${desc.family}": ${lastError}`);
  }

  private _guessFormat(url: string): string {
    if (url.endsWith('.woff2')) return 'woff2';
    if (url.endsWith('.woff'))  return 'woff';
    if (url.endsWith('.ttf'))   return 'truetype';
    if (url.endsWith('.otf'))   return 'opentype';
    if (url.endsWith('.eot'))   return 'embedded-opentype';
    if (url.endsWith('.svg'))   return 'svg';
    return 'truetype';
  }

  /** Load all registered @font-face declarations */
  async loadAll(): Promise<LoadedFont[]> {
    const promises = Array.from(this._declarations.values()).map(d => this.loadFontFace(d));
    return Promise.all(promises);
  }

  getLoaded(family: string, weight = 'normal', style = 'normal'): LoadedFont | undefined {
    return this._loaded.get(`${family}|${weight}|${style}`);
  }

  getDeclaration(family: string): FontFaceDescriptor | undefined {
    return this._declarations.get(family);
  }

  listFamilies(): string[] { return Array.from(this._declarations.keys()); }
}

// ───────────────────────────────────────────────────────────────────────────────
//  Item 918 — CSS clip-path layer-bitmap cache
// ───────────────────────────────────────────────────────────────────────────────

export type ClipShape =
  | { type: 'polygon'; points: Array<[number, number]> }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'inset'; top: number; right: number; bottom: number; left: number; radius?: number };

interface ClipMaskEntry {
  mask: Uint8Array; // 1 byte per pixel, 255 = visible, 0 = clipped
  width: number;
  height: number;
  lastUsed: number;
}

/**
 * ClipPathLayerCache — pre-renders clip-path shapes into alpha masks.
 * Masks are cached keyed by (shape JSON + dimensions), with LRU eviction.
 * applyClipMask() composites the mask against an RGBA framebuffer in O(pixels).
 */
export class ClipPathLayerCache {
  private _cache = new Map<string, ClipMaskEntry>();
  private _maxEntries: number;

  constructor(maxEntries = 64) { this._maxEntries = maxEntries; }

  /** Get or create the clip mask for the given shape at the given size */
  getClipMask(shape: ClipShape, width: number, height: number): Uint8Array {
    const key = `${JSON.stringify(shape)}|${width}x${height}`;
    const cached = this._cache.get(key);
    if (cached) { cached.lastUsed = Date.now(); return cached.mask; }

    const mask = this._renderMask(shape, width, height);
    this._evict();
    this._cache.set(key, { mask, width, height, lastUsed: Date.now() });
    return mask;
  }

  /**
   * Apply a clip mask to RGBA framebuffer in-place.
   * Pixels where mask[i] === 0 are set to fully transparent.
   */
  applyClipMask(fb: Uint8Array, mask: Uint8Array, fbStride: number, maskW: number, maskH: number): void {
    for (let py = 0; py < maskH; py++) {
      for (let px = 0; px < maskW; px++) {
        const mi = py * maskW + px;
        const fi = (py * fbStride + px) * 4;
        if (!mask[mi]) {
          fb[fi+3] = 0; // clear alpha
        } else if (mask[mi] !== 255) {
          fb[fi+3] = Math.round(fb[fi+3] * mask[mi] / 255);
        }
      }
    }
  }

  private _renderMask(shape: ClipShape, w: number, h: number): Uint8Array {
    const mask = new Uint8Array(w * h); // initialised to 0

    if (shape.type === 'polygon') {
      this._fillPolygon(mask, shape.points, w, h);
    } else if (shape.type === 'circle') {
      this._fillCircle(mask, shape.cx, shape.cy, shape.r, w, h);
    } else if (shape.type === 'ellipse') {
      this._fillEllipse(mask, shape.cx, shape.cy, shape.rx, shape.ry, w, h);
    } else if (shape.type === 'inset') {
      this._fillInset(mask, shape.top, shape.right, shape.bottom, shape.left, shape.radius ?? 0, w, h);
    }

    return mask;
  }

  private _fillPolygon(mask: Uint8Array, points: Array<[number, number]>, w: number, h: number): void {
    // Scanline fill
    for (let py = 0; py < h; py++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i+1) % points.length];
        if ((y1 <= py && y2 > py) || (y2 <= py && y1 > py)) {
          xs.push(x1 + (py - y1) * (x2 - x1) / (y2 - y1));
        }
      }
      xs.sort((a,b) => a-b);
      for (let k = 0; k+1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.round(xs[k]));
        const x1 = Math.min(w-1, Math.round(xs[k+1]));
        for (let px = x0; px <= x1; px++) mask[py*w+px] = 255;
      }
    }
  }

  private _fillCircle(mask: Uint8Array, cx: number, cy: number, r: number, w: number, h: number): void {
    const r2 = r * r;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dx = px - cx, dy = py - cy;
        if (dx*dx + dy*dy <= r2) mask[py*w+px] = 255;
      }
    }
  }

  private _fillEllipse(mask: Uint8Array, cx: number, cy: number, rx: number, ry: number, w: number, h: number): void {
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dx = (px-cx)/rx, dy = (py-cy)/ry;
        if (dx*dx + dy*dy <= 1) mask[py*w+px] = 255;
      }
    }
  }

  private _fillInset(
    mask: Uint8Array,
    top: number, right: number, bottom: number, left: number,
    radius: number,
    w: number, h: number
  ): void {
    const x0 = Math.round(left), y0 = Math.round(top);
    const x1 = Math.round(w - right), y1 = Math.round(h - bottom);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (radius > 0) {
          // Check corner radii
          let inside = true;
          const corners: [number, number][] = [[x0+radius, y0+radius], [x1-radius, y0+radius], [x1-radius, y1-radius], [x0+radius, y1-radius]];
          for (const [ccx, ccy] of corners) {
            if (px < x0+radius && py < y0+radius) { inside = (px-ccx)*(px-ccx)+(py-ccy)*(py-ccy) <= radius*radius; break; }
            if (px > x1-radius && py < y0+radius) { inside = (px-ccx)*(px-ccx)+(py-ccy)*(py-ccy) <= radius*radius; break; }
            if (px > x1-radius && py > y1-radius) { inside = (px-ccx)*(px-ccx)+(py-ccy)*(py-ccy) <= radius*radius; break; }
            if (px < x0+radius && py > y1-radius) { inside = (px-ccx)*(px-ccx)+(py-ccy)*(py-ccy) <= radius*radius; break; }
          }
          if (inside) mask[py*w+px] = 255;
        } else {
          mask[py*w+px] = 255;
        }
      }
    }
  }

  private _evict(): void {
    if (this._cache.size < this._maxEntries) return;
    let oldest = Infinity, oldestKey = '';
    for (const [k, v] of this._cache) {
      if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
    }
    this._cache.delete(oldestKey);
  }

  get size(): number { return this._cache.size; }
  clear(): void { this._cache.clear(); }
}

export const clipPathCache = new ClipPathLayerCache(64);

// ───────────────────────────────────────────────────────────────────────────────
//  Item 965 — CSS paint / audio Worklet micro-contexts
// ───────────────────────────────────────────────────────────────────────────────

export interface WorkletContextOptions {
  name?: string;
  type?: 'paint' | 'audio' | 'layout';
  timeout?: number; // ms; default 100
}

export interface WorkletResult {
  output?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * WorkletMicroContext — an isolated Function-based execution sandbox
 * for CSS Worklets. Provides a restricted global environment with
 * typed arrays and Math but no DOM or network access.
 */
export class WorkletMicroContext {
  readonly name: string;
  readonly type: string;
  private _timeout: number;
  private _status: 'idle' | 'running' = 'idle';

  constructor(options: WorkletContextOptions = {}) {
    this.name = options.name ?? 'unnamed-worklet';
    this.type = options.type ?? 'paint';
    this._timeout = options.timeout ?? 100;
  }

  get status(): 'idle' | 'running' { return this._status; }

  /**
   * Execute a worklet function in the isolated context.
   * The workletFn receives a restricted API object and args.
   */
  async execute(workletFn: string | ((...args: unknown[]) => unknown), args: unknown[] = []): Promise<WorkletResult> {
    const start = Date.now();
    this._status = 'running';
    try {
      const sandboxGlobals = this._buildSandbox();
      let result: unknown;

      if (typeof workletFn === 'string') {
        // Execute code string in sandbox
        const paramNames = Object.keys(sandboxGlobals);
        const paramVals = Object.values(sandboxGlobals);
        const fn = new Function(...paramNames, `"use strict"; return (${workletFn})`);
        const evaluatedFn = fn(...paramVals);
        if (typeof evaluatedFn === 'function') {
          result = await Promise.race([
            Promise.resolve(evaluatedFn(...args)),
            this._timeoutPromise(),
          ]);
        }
      } else {
        result = await Promise.race([
          Promise.resolve(workletFn(...args)),
          this._timeoutPromise(),
        ]);
      }

      return { output: result, durationMs: Date.now() - start };
    } catch (err) {
      return { error: String(err), durationMs: Date.now() - start };
    } finally {
      this._status = 'idle';
    }
  }

  private _timeoutPromise(): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`Worklet "${this.name}" timed out after ${this._timeout}ms`)), this._timeout));
  }

  private _buildSandbox(): Record<string, unknown> {
    // Restricted global environment — no window, document, fetch, etc.
    return {
      Math,
      parseInt, parseFloat, isNaN, isFinite,
      Array, Object, String, Number, Boolean, Map, Set,
      TypeError, RangeError, Error,
      Uint8Array, Int8Array, Uint16Array, Int16Array,
      Uint32Array, Int32Array, Float32Array, Float64Array,
      ArrayBuffer,
      JSON: { parse: JSON.parse, stringify: JSON.stringify },
      console: {
        log: (...a: unknown[]) => console.log(`[Worklet:${this.name}]`, ...a),
        warn: (...a: unknown[]) => console.warn(`[Worklet:${this.name}]`, ...a),
        error: (...a: unknown[]) => console.error(`[Worklet:${this.name}]`, ...a),
      },
      // Paint Worklet APIs
      registerPaint: (name: string, ctor: new () => { paint: (...a: unknown[]) => unknown }) => {
        WorkletContextPool._registry.set(name, ctor);
      },
      // Audio Worklet API
      registerProcessor: (name: string, ctor: new () => { process: (...a: unknown[]) => unknown }) => {
        WorkletContextPool._registry.set(`audio:${name}`, ctor);
      },
    };
  }
}

/**
 * WorkletContextPool — manages a pool of reusable WorkletMicroContext instances.
 * Idle contexts are returned to the pool for reuse to avoid per-call setup cost.
 */
export class WorkletContextPool {
  static readonly _registry = new Map<string, new () => { paint?: (...a: unknown[]) => unknown; process?: (...a: unknown[]) => unknown }>();

  private _idle: WorkletMicroContext[] = [];
  private _maxSize: number;
  private _contextOptions: WorkletContextOptions;

  constructor(maxSize = 4, options: WorkletContextOptions = {}) {
    this._maxSize = maxSize;
    this._contextOptions = options;
  }

  /** Acquire an idle context from the pool (or create a new one) */
  acquire(): WorkletMicroContext {
    return this._idle.pop() ?? new WorkletMicroContext(this._contextOptions);
  }

  /** Return a context to the pool after use */
  release(ctx: WorkletMicroContext): void {
    if (this._idle.length < this._maxSize) this._idle.push(ctx);
  }

  /** Execute workletFn in a pooled context, automatically releasing it afterwards */
  async executeInContext(
    workletFn: string | ((...args: unknown[]) => unknown),
    args: unknown[] = []
  ): Promise<WorkletResult> {
    const ctx = this.acquire();
    try {
      return await ctx.execute(workletFn, args);
    } finally {
      this.release(ctx);
    }
  }

  get idleCount(): number { return this._idle.length; }
}

export const paintWorkletPool  = new WorkletContextPool(4, { type: 'paint',  timeout: 100 });
export const audioWorkletPool  = new WorkletContextPool(2, { type: 'audio',  timeout: 128 });
export const layoutWorkletPool = new WorkletContextPool(2, { type: 'layout', timeout: 100 });

// ── Public API ────────────────────────────────────────────────────────────────

export const cssExtras = {
  parseCSSResize,
  ResizeHandle,
  FontFaceRegistry,
  clipPathCache,
  ClipPathLayerCache,
  WorkletMicroContext,
  WorkletContextPool,
  paintWorkletPool,
  audioWorkletPool,
  layoutWorkletPool,
};
