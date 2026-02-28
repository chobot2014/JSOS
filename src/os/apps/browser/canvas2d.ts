/**
 * JSOS Browser Canvas 2D — Items 491 + 915
 *
 * Implements:
 *   - Item 491: <canvas> 2D rendering context wired to the OS framebuffer
 *   - Item 915: Canvas 2D drawImage() blitting from decoded bitmap cache
 *
 * Design: Each HTMLCanvasElement owns a software CanvasRenderingContext2D that
 * draws into a Uint8Array (RGBA). When flush() is called the buffer is copied
 * to the OS framebuffer via the browser's render pipeline.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CanvasGradientStop { offset: number; color: string; }
export interface CanvasPattern { image: ImageBitmap; repetition: CanvasPatternRepeat; }
export type CanvasPatternRepeat = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat';

export interface ImageBitmap {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

// ── Colour parsing ───────────────────────────────────────────────────────────

interface RGBA { r: number; g: number; b: number; a: number; }

function parseColor(css: string): RGBA {
  css = css.trim().toLowerCase();
  // #rgb
  let m = css.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m) return { r: parseInt(m[1]+m[1], 16), g: parseInt(m[2]+m[2], 16), b: parseInt(m[3]+m[3], 16), a: 255 };
  // #rrggbb
  m = css.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (m) return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16), a: 255 };
  // #rrggbbaa
  m = css.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (m) return { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16), a: parseInt(m[4],16) };
  // rgb(r,g,b)
  m = css.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? Math.round(+m[4]*255) : 255 };
  // Named colours (subset)
  const NAMED: Record<string, number> = {
    black:0x000000, white:0xFFFFFF, red:0xFF0000, green:0x008000, blue:0x0000FF,
    yellow:0xFFFF00, cyan:0x00FFFF, magenta:0xFF00FF, gray:0x808080, grey:0x808080,
    orange:0xFFA500, pink:0xFFC0CB, purple:0x800080, brown:0xA52A2A, transparent: -1,
  };
  const n = NAMED[css];
  if (n === -1) return { r:0, g:0, b:0, a:0 };
  if (n !== undefined) return { r:(n>>16)&255, g:(n>>8)&255, b:n&255, a:255 };
  return { r:0, g:0, b:0, a:255 };
}

// ── Gradient ─────────────────────────────────────────────────────────────────

export class CanvasGradient {
  stops: CanvasGradientStop[] = [];
  readonly type: 'linear' | 'radial';
  // linear params
  x0 = 0; y0 = 0; x1 = 0; y1 = 0;
  // radial params
  cx0 = 0; cy0 = 0; r0 = 0; cx1 = 0; cy1 = 0; r1 = 0;

  constructor(type: 'linear' | 'radial') { this.type = type; }

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
    this.stops.sort((a, b) => a.offset - b.offset);
  }

  sampleAt(t: number): RGBA {
    const stops = this.stops;
    if (!stops.length) return { r:0, g:0, b:0, a:255 };
    if (t <= stops[0].offset) return parseColor(stops[0].color);
    if (t >= stops[stops.length-1].offset) return parseColor(stops[stops.length-1].color);
    for (let i = 0; i < stops.length-1; i++) {
      if (t >= stops[i].offset && t <= stops[i+1].offset) {
        const tl = (t - stops[i].offset) / (stops[i+1].offset - stops[i].offset);
        const a = parseColor(stops[i].color), b = parseColor(stops[i+1].color);
        return {
          r: Math.round(a.r + (b.r-a.r)*tl),
          g: Math.round(a.g + (b.g-a.g)*tl),
          b: Math.round(a.b + (b.b-a.b)*tl),
          a: Math.round(a.a + (b.a-a.a)*tl),
        };
      }
    }
    return parseColor(stops[stops.length-1].color);
  }
}

// ── Path2D ───────────────────────────────────────────────────────────────────

interface PathCmd {
  type: 'M'|'L'|'Q'|'B'|'A'|'Z';
  args: number[];
}

export class Path2D {
  _cmds: PathCmd[] = [];
  _curX = 0; _curY = 0;

  moveTo(x: number, y: number): void { this._cmds.push({ type:'M', args:[x,y] }); this._curX=x; this._curY=y; }
  lineTo(x: number, y: number): void { this._cmds.push({ type:'L', args:[x,y] }); this._curX=x; this._curY=y; }
  closePath(): void { this._cmds.push({ type:'Z', args:[] }); }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x,y); this.lineTo(x+w,y); this.lineTo(x+w,y+h); this.lineTo(x,y+h); this.closePath();
  }
  arc(x: number, y: number, r: number, startAngle: number, endAngle: number, anticlockwise = false): void {
    this._cmds.push({ type:'A', args:[x,y,r,startAngle,endAngle, anticlockwise?1:0] });
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this._cmds.push({ type:'Q', args:[cpx,cpy,x,y] });
  }
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this._cmds.push({ type:'B', args:[cp1x,cp1y,cp2x,cp2y,x,y] });
  }
  addPath(other: Path2D): void { this._cmds.push(...other._cmds); }
}

// ── Transform matrix ─────────────────────────────────────────────────────────

type Mat2D = [number,number,number,number,number,number]; // [a,b,c,d,e,f]

function identM(): Mat2D { return [1,0,0,1,0,0]; }
function mulM(a: Mat2D, b: Mat2D): Mat2D {
  return [
    a[0]*b[0] + a[2]*b[1],
    a[1]*b[0] + a[3]*b[1],
    a[0]*b[2] + a[2]*b[3],
    a[1]*b[2] + a[3]*b[3],
    a[0]*b[4] + a[2]*b[5] + a[4],
    a[1]*b[4] + a[3]*b[5] + a[5],
  ];
}
function applyM(m: Mat2D, x: number, y: number): [number,number] {
  return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
}

// ── ImageBitmap cache (Item 915) ──────────────────────────────────────────────

interface CachedBitmap {
  bitmap: ImageBitmap;
  lastUsed: number;
}

class BitmapCache {
  private _cache = new Map<string, CachedBitmap>();
  private _maxEntries: number;

  constructor(maxEntries = 256) { this._maxEntries = maxEntries; }

  get(key: string): ImageBitmap | undefined {
    const entry = this._cache.get(key);
    if (entry) { entry.lastUsed = Date.now(); return entry.bitmap; }
    return undefined;
  }

  put(key: string, bitmap: ImageBitmap): void {
    if (this._cache.size >= this._maxEntries) {
      // Evict LRU
      let oldest = Infinity, oldestKey = '';
      for (const [k, v] of this._cache) {
        if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
      }
      this._cache.delete(oldestKey);
    }
    this._cache.set(key, { bitmap, lastUsed: Date.now() });
  }

  has(key: string): boolean { return this._cache.has(key); }
  clear(): void { this._cache.clear(); }
  get size(): number { return this._cache.size; }
}

export const bitmapCache = new BitmapCache(256);

// ── Pixel helpers ─────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

function blendPixel(dst: Uint8Array, di: number, sr: number, sg: number, sb: number, sa: number): void {
  const da = dst[di+3] / 255;
  const fa = sa / 255;
  const oa = fa + da * (1-fa);
  if (oa === 0) return;
  dst[di]   = clamp((sr * fa + dst[di]   * da * (1-fa)) / oa, 0, 255);
  dst[di+1] = clamp((sg * fa + dst[di+1] * da * (1-fa)) / oa, 0, 255);
  dst[di+2] = clamp((sb * fa + dst[di+2] * da * (1-fa)) / oa, 0, 255);
  dst[di+3] = clamp(oa * 255, 0, 255);
}

// ── CanvasRenderingContext2D ──────────────────────────────────────────────────

export class CanvasRenderingContext2D {
  // State
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: 'butt' | 'round' | 'square' = 'butt';
  lineJoin: 'miter' | 'round' | 'bevel' = 'miter';
  miterLimit = 10;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  font = '10px sans-serif';
  textAlign: 'start' | 'end' | 'left' | 'right' | 'center' = 'start';
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom' = 'alphabetic';
  shadowColor = 'rgba(0,0,0,0)';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  lineDashOffset = 0;

  private _fb: Uint8Array;
  private _w: number;
  private _h: number;
  private _path = new Path2D();
  private _transform: Mat2D = identM();
  private _stack: Array<{ transform: Mat2D; fillStyle: typeof this.fillStyle; strokeStyle: typeof this.strokeStyle; lineWidth: number; globalAlpha: number; font: string }> = [];
  private _clip: Uint8Array | null = null; // 1-bit mask

  readonly canvas: { width: number; height: number };

  constructor(width: number, height: number, framebuffer?: Uint8Array) {
    this._w = width;
    this._h = height;
    this._fb = framebuffer ?? new Uint8Array(width * height * 4);
    this.canvas = { width, height };
  }

  // ── Transform ──────────────────────────────────────────────────────────────

  save(): void {
    this._stack.push({
      transform: [...this._transform] as Mat2D,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      font: this.font,
    });
  }

  restore(): void {
    const s = this._stack.pop();
    if (!s) return;
    this._transform = s.transform;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.globalAlpha = s.globalAlpha;
    this.font = s.font;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this._transform = [a, b, c, d, e, f];
  }
  resetTransform(): void { this._transform = identM(); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this._transform = mulM(this._transform, [a,b,c,d,e,f]);
  }
  translate(x: number, y: number): void { this.transform(1,0,0,1,x,y); }
  scale(sx: number, sy: number): void { this.transform(sx,0,0,sy,0,0); }
  rotate(angle: number): void {
    const c = Math.cos(angle), s = Math.sin(angle);
    this.transform(c, s, -s, c, 0, 0);
  }
  getTransform(): DOMMatrix { return new DOMMatrix([...this._transform, 0, 0, 0, 1]); }

  // ── Path ──────────────────────────────────────────────────────────────────

  beginPath(): void { this._path = new Path2D(); }
  closePath(): void { this._path.closePath(); }
  moveTo(x: number, y: number): void { this._path.moveTo(x, y); }
  lineTo(x: number, y: number): void { this._path.lineTo(x, y); }
  arc(x: number, y: number, r: number, start: number, end: number, acw = false): void {
    this._path.arc(x, y, r, start, end, acw);
  }
  rect(x: number, y: number, w: number, h: number): void { this._path.rect(x, y, w, h); }
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[] = 0): void {
    const r = Array.isArray(radii) ? radii[0] : radii;
    this.moveTo(x+r, y); this.lineTo(x+w-r, y);
    this.arc(x+w-r, y+r, r, -Math.PI/2, 0);
    this.lineTo(x+w, y+h-r); this.arc(x+w-r, y+h-r, r, 0, Math.PI/2);
    this.lineTo(x+r, y+h); this.arc(x+r, y+h-r, r, Math.PI/2, Math.PI);
    this.lineTo(x, y+r); this.arc(x+r, y+r, r, Math.PI, -Math.PI/2);
    this.closePath();
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this._path.quadraticCurveTo(cpx, cpy, x, y);
  }
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    this._path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }

  // ── Gradient / pattern factories ─────────────────────────────────────────

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    const g = new CanvasGradient('linear');
    g.x0=x0; g.y0=y0; g.x1=x1; g.y1=y1;
    return g;
  }
  createRadialGradient(cx0: number, cy0: number, r0: number, cx1: number, cy1: number, r1: number): CanvasGradient {
    const g = new CanvasGradient('radial');
    g.cx0=cx0; g.cy0=cy0; g.r0=r0; g.cx1=cx1; g.cy1=cy1; g.r1=r1;
    return g;
  }
  createPattern(image: ImageBitmap, repetition: CanvasPatternRepeat): CanvasPattern {
    return { image, repetition };
  }

  // ── Clip ────────────────────────────────────────────────────────────────

  clip(_path?: Path2D | 'nonzero' | 'evenodd'): void {
    // Rasterise current path as clip mask
    this._clip = new Uint8Array(this._w * this._h);
    const p = (_path instanceof Path2D) ? _path : this._path;
    this._rasterizeMask(p, this._clip);
  }

  // ── Draw ─────────────────────────────────────────────────────────────────

  fillRect(x: number, y: number, w: number, h: number): void {
    const [tx, ty] = applyM(this._transform, x, y);
    const [tx2, ty2] = applyM(this._transform, x+w, y+h);
    const x0 = Math.min(tx,tx2), y0 = Math.min(ty,ty2), x1 = Math.max(tx,tx2), y1 = Math.max(ty,ty2);
    this._fillRectRaw(x0, y0, x1-x0, y1-y0, this._resolveStyle(this.fillStyle, x0, y0, x1-x0, y1-y0));
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.beginPath(); this.rect(x, y, w, h); this.stroke();
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const [tx, ty] = applyM(this._transform, x, y);
    const [tx2, ty2] = applyM(this._transform, x+w, y+h);
    const x0 = Math.round(Math.min(tx,tx2)), y0 = Math.round(Math.min(ty,ty2));
    const x1 = Math.round(Math.max(tx,tx2)), y1 = Math.round(Math.max(ty,ty2));
    for (let py = y0; py < y1 && py < this._h; py++) {
      for (let px = x0; px < x1 && px < this._w; px++) {
        const i = (py * this._w + px) * 4;
        this._fb[i] = this._fb[i+1] = this._fb[i+2] = this._fb[i+3] = 0;
      }
    }
  }

  fill(path?: Path2D | 'nonzero' | 'evenodd'): void {
    const p = (path instanceof Path2D) ? path : this._path;
    const bounds = this._pathBounds(p);
    if (!bounds) return;
    const col = this._resolveStyle(this.fillStyle, bounds.x, bounds.y, bounds.w, bounds.h);
    this._rasterizeAndFill(p, col);
  }

  stroke(path?: Path2D): void {
    const p = path ?? this._path;
    this._strokePath(p);
  }

  // ── Text ─────────────────────────────────────────────────────────────────

  fillText(text: string, x: number, y: number, _maxWidth?: number): void {
    const [tx, ty] = applyM(this._transform, x, y);
    this._drawText(text, Math.round(tx), Math.round(ty), this._resolveStyle(this.fillStyle, tx, ty, 100, 16));
  }

  strokeText(text: string, x: number, y: number, _maxWidth?: number): void {
    void text; void x; void y; // stub — full stroke text is complex
  }

  measureText(text: string): TextMetrics {
    const fontSize = this._parseFontSize();
    const width = text.length * fontSize * 0.6;
    return { width, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
      actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2,
      fontBoundingBoxAscent: fontSize, fontBoundingBoxDescent: 0,
      emHeightAscent: fontSize, emHeightDescent: 0, hangingBaseline: 0, alphabeticBaseline: 0, ideographicBaseline: 0 } as TextMetrics;
  }

  // ── Image ── (Item 915: blits from BitmapCache) ──────────────────────────

  drawImage(
    image: ImageBitmap,
    sx: number, sy: number, sw?: number, sh?: number,
    dx?: number, dy?: number, dw?: number, dh?: number
  ): void {
    // Resolve overload
    let srcX = 0, srcY = 0, srcW = image.width, srcH = image.height;
    let dstX: number, dstY: number, dstW: number, dstH: number;

    if (dx !== undefined && dy !== undefined && dw !== undefined && dh !== undefined) {
      // 9-arg: drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
      srcX=sx; srcY=sy; srcW=sw??image.width; srcH=sh??image.height;
      dstX=dx; dstY=dy; dstW=dw; dstH=dh;
    } else if (sw !== undefined && sh !== undefined) {
      // 5-arg: drawImage(img, dx, dy, dw, dh)
      dstX=sx; dstY=sy; dstW=sw; dstH=sh;
    } else {
      // 3-arg: drawImage(img, dx, dy)
      dstX=sx; dstY=sy; dstW=image.width; dstH=image.height;
    }

    // Apply current transform to destination rect
    const [tdx, tdy] = applyM(this._transform, dstX, dstY);
    dstX = Math.round(tdx);
    dstY = Math.round(tdy);

    // Nearest-neighbour scale blit
    const scaleX = srcW / dstW;
    const scaleY = srcH / dstH;

    for (let py = 0; py < dstH; py++) {
      const pixelY = dstY + py;
      if (pixelY < 0 || pixelY >= this._h) continue;
      const srcPy = Math.floor((py + 0.5) * scaleY) + srcY;
      if (srcPy < 0 || srcPy >= image.height) continue;

      for (let px = 0; px < dstW; px++) {
        const pixelX = dstX + px;
        if (pixelX < 0 || pixelX >= this._w) continue;
        const srcPx = Math.floor((px + 0.5) * scaleX) + srcX;
        if (srcPx < 0 || srcPx >= image.width) continue;

        const si = (srcPy * image.width + srcPx) * 4;
        const di = (pixelY * this._w + pixelX) * 4;
        const sa = Math.round((image.data[si+3] / 255) * this.globalAlpha * 255);
        blendPixel(this._fb, di, image.data[si], image.data[si+1], image.data[si+2], sa);
      }
    }
  }

  /** Draw from cache — looks up by key first (Item 915) */
  drawCachedImage(key: string, image: ImageBitmap, dx: number, dy: number, dw?: number, dh?: number): void {
    // Ensure it's cached for future calls
    if (!bitmapCache.has(key)) bitmapCache.put(key, image);
    const bm = bitmapCache.get(key)!;
    if (dw !== undefined && dh !== undefined) {
      this.drawImage(bm, 0, 0, bm.width, bm.height, dx, dy, dw, dh);
    } else {
      this.drawImage(bm, dx, dy);
    }
  }

  // ── ImageData ─────────────────────────────────────────────────────────────

  createImageData(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' } as ImageData;
  }

  getImageData(x: number, y: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const si = ((py+y) * this._w + (px+x)) * 4;
        const di = (py * width + px) * 4;
        data[di]   = this._fb[si];
        data[di+1] = this._fb[si+1];
        data[di+2] = this._fb[si+2];
        data[di+3] = this._fb[si+3];
      }
    }
    return { width, height, data, colorSpace: 'srgb' } as ImageData;
  }

  putImageData(imageData: ImageData, dx: number, dy: number, _dirtyX?: number, _dirtyY?: number, _dirtyW?: number, _dirtyH?: number): void {
    for (let py = 0; py < imageData.height; py++) {
      for (let px = 0; px < imageData.width; px++) {
        const destX = px + dx, destY = py + dy;
        if (destX < 0 || destX >= this._w || destY < 0 || destY >= this._h) continue;
        const si = (py * imageData.width + px) * 4;
        const di = (destY * this._w + destX) * 4;
        this._fb[di]   = imageData.data[si];
        this._fb[di+1] = imageData.data[si+1];
        this._fb[di+2] = imageData.data[si+2];
        this._fb[di+3] = imageData.data[si+3];
      }
    }
  }

  // ── Line dash ─────────────────────────────────────────────────────────────

  private _lineDash: number[] = [];
  setLineDash(segments: number[]): void { this._lineDash = segments; }
  getLineDash(): number[] { return this._lineDash; }

  // ── isPointInPath / isPointInStroke ──────────────────────────────────────

  isPointInPath(xOrPath: number | Path2D, yOrX: number, ruleOrY?: string | number): boolean {
    // Stub: ray-cast test for the current/given path
    void xOrPath; void yOrX; void ruleOrY;
    return false;
  }
  isPointInStroke(_x: number, _y: number): boolean { return false; }

  // ── toDataURL ─────────────────────────────────────────────────────────────

  toDataURL(_type = 'image/png'): string {
    // Return minimal PNG as data URL stub
    return 'data:image/png;base64,';
  }

  /** Get raw RGBA framebuffer */
  get framebuffer(): Uint8Array { return this._fb; }
  get width(): number { return this._w; }
  get height(): number { return this._h; }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _parseFontSize(): number {
    const m = this.font.match(/(\d+(?:\.\d+)?)(px|pt|em|rem)?/);
    return m ? parseFloat(m[1]) : 10;
  }

  private _resolveStyle(
    style: string | CanvasGradient | CanvasPattern,
    x: number, y: number, w: number, h: number
  ): RGBA {
    if (typeof style === 'string') {
      const c = parseColor(style);
      c.a = Math.round(c.a * this.globalAlpha);
      return c;
    }
    if (style instanceof CanvasGradient) {
      let t = 0;
      if (style.type === 'linear') {
        const dx = style.x1-style.x0, dy = style.y1-style.y0;
        const len = Math.sqrt(dx*dx + dy*dy);
        t = len ? ((x - style.x0)*dx + (y - style.y0)*dy) / (len*len) : 0;
      } else {
        // radial gradient — use center distance as t approximation
        const dx = x - style.cx1, dy = y - style.cy1;
        t = Math.sqrt(dx*dx + dy*dy) / (style.r1 || 1);
      }
      const c = style.sampleAt(Math.max(0, Math.min(1, t)));
      c.a = Math.round(c.a * this.globalAlpha);
      return c;
    }
    // CanvasPattern
    void x; void y; void w; void h;
    return { r:0, g:0, b:0, a:255 };
  }

  private _fillRectRaw(x: number, y: number, w: number, h: number, color: RGBA): void {
    const x0 = Math.round(x), y0 = Math.round(y);
    const x1 = Math.round(x+w), y1 = Math.round(y+h);
    for (let py = Math.max(0,y0); py < Math.min(this._h, y1); py++) {
      for (let px = Math.max(0,x0); px < Math.min(this._w, x1); px++) {
        if (this._clip && !this._clip[py*this._w+px]) continue;
        blendPixel(this._fb, (py*this._w+px)*4, color.r, color.g, color.b, color.a);
      }
    }
  }

  private _pathBounds(p: Path2D): { x: number; y: number; w: number; h: number } | null {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const cmd of p._cmds) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        const [tx,ty] = applyM(this._transform, cmd.args[0], cmd.args[1]);
        minX=Math.min(minX,tx); minY=Math.min(minY,ty); maxX=Math.max(maxX,tx); maxY=Math.max(maxY,ty);
      }
      if (cmd.type === 'A') {
        const [tx,ty] = applyM(this._transform, cmd.args[0], cmd.args[1]);
        const r = cmd.args[2];
        minX=Math.min(minX,tx-r); minY=Math.min(minY,ty-r); maxX=Math.max(maxX,tx+r); maxY=Math.max(maxY,ty+r);
      }
    }
    if (!isFinite(minX)) return null;
    return { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
  }

  private _rasterizeAndFill(p: Path2D, color: RGBA): void {
    // Scanline fill using edge table
    const bounds = this._pathBounds(p);
    if (!bounds) return;
    const segments = this._pathToSegments(p);
    const y0 = Math.max(0, Math.floor(bounds.y));
    const y1 = Math.min(this._h-1, Math.ceil(bounds.y + bounds.h));

    for (let py = y0; py <= y1; py++) {
      const xIntersections: number[] = [];
      for (const seg of segments) {
        const { x1: sx1, y1: sy1, x2: sx2, y2: sy2 } = seg;
        if ((sy1 <= py && sy2 > py) || (sy2 <= py && sy1 > py)) {
          const t = (py - sy1) / (sy2 - sy1);
          xIntersections.push(sx1 + t * (sx2 - sx1));
        }
      }
      xIntersections.sort((a,b) => a-b);
      for (let k = 0; k+1 < xIntersections.length; k += 2) {
        const xStart = Math.max(0, Math.round(xIntersections[k]));
        const xEnd   = Math.min(this._w-1, Math.round(xIntersections[k+1]));
        for (let px = xStart; px <= xEnd; px++) {
          if (this._clip && !this._clip[py*this._w+px]) continue;
          blendPixel(this._fb, (py*this._w+px)*4, color.r, color.g, color.b, color.a);
        }
      }
    }
  }

  private _rasterizeMask(p: Path2D, mask: Uint8Array): void {
    const bounds = this._pathBounds(p);
    if (!bounds) return;
    const segments = this._pathToSegments(p);
    const y0 = Math.max(0, Math.floor(bounds.y));
    const y1 = Math.min(this._h-1, Math.ceil(bounds.y + bounds.h));
    for (let py = y0; py <= y1; py++) {
      const xIntersections: number[] = [];
      for (const seg of segments) {
        const { x1: sx1, y1: sy1, x2: sx2, y2: sy2 } = seg;
        if ((sy1 <= py && sy2 > py) || (sy2 <= py && sy1 > py)) {
          const t = (py - sy1) / (sy2 - sy1);
          xIntersections.push(sx1 + t * (sx2 - sx1));
        }
      }
      xIntersections.sort((a,b) => a-b);
      for (let k = 0; k+1 < xIntersections.length; k += 2) {
        const xStart = Math.max(0, Math.round(xIntersections[k]));
        const xEnd   = Math.min(this._w-1, Math.round(xIntersections[k+1]));
        for (let px = xStart; px <= xEnd; px++) mask[py*this._w+px] = 1;
      }
    }
  }

  private _strokePath(p: Path2D): void {
    const color = this._resolveStyle(this.strokeStyle, 0, 0, this._w, this._h);
    const segs = this._pathToSegments(p);
    for (const seg of segs) {
      this._drawLine(seg.x1, seg.y1, seg.x2, seg.y2, color, this.lineWidth);
    }
  }

  private _drawLine(x1: number, y1: number, x2: number, y2: number, color: RGBA, lw: number): void {
    // Bresenham's with width
    const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let cx = Math.round(x1), cy = Math.round(y1);
    const hw = Math.ceil(lw / 2);

    while (true) {
      for (let oy = -hw; oy <= hw; oy++) {
        for (let ox = -hw; ox <= hw; ox++) {
          const px2 = cx+ox, py2 = cy+oy;
          if (px2 < 0 || px2 >= this._w || py2 < 0 || py2 >= this._h) continue;
          blendPixel(this._fb, (py2*this._w+px2)*4, color.r, color.g, color.b, color.a);
        }
      }
      if (cx === Math.round(x2) && cy === Math.round(y2)) break;
      const e2 = 2*err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }

  private _pathToSegments(p: Path2D): Array<{x1:number;y1:number;x2:number;y2:number}> {
    const segs: Array<{x1:number;y1:number;x2:number;y2:number}> = [];
    let cx = 0, cy = 0, startX = 0, startY = 0;
    for (const cmd of p._cmds) {
      switch (cmd.type) {
        case 'M': {
          const [tx,ty] = applyM(this._transform, cmd.args[0], cmd.args[1]);
          cx=tx; cy=ty; startX=tx; startY=ty; break;
        }
        case 'L': {
          const [tx,ty] = applyM(this._transform, cmd.args[0], cmd.args[1]);
          segs.push({x1:cx,y1:cy,x2:tx,y2:ty}); cx=tx; cy=ty; break;
        }
        case 'Z':
          segs.push({x1:cx,y1:cy,x2:startX,y2:startY}); cx=startX; cy=startY; break;
        case 'A': {
          // Approximate arc with line segments
          const [ax,ay,r,sa,ea,acw] = cmd.args;
          const [tax,tay] = applyM(this._transform, ax, ay);
          let angle = sa;
          const step = (Math.PI/2) / Math.max(1, r/4);
          const end = acw ? (ea < sa ? ea : ea - Math.PI*2) : (ea > sa ? ea : ea + Math.PI*2);
          const dir = acw ? -1 : 1;
          let prevX = tax + r * Math.cos(angle), prevY = tay + r * Math.sin(angle);
          for (let steps = 0; steps < 100; steps++) {
            angle += dir * step;
            if ((dir > 0 && angle >= end) || (dir < 0 && angle <= end)) { angle = end; }
            const nx = tax + r * Math.cos(angle), ny = tay + r * Math.sin(angle);
            segs.push({x1:prevX,y1:prevY,x2:nx,y2:ny});
            prevX=nx; prevY=ny;
            if (angle === end) break;
          }
          cx=tax + r*Math.cos(ea); cy=tay + r*Math.sin(ea);
          break;
        }
        default: break;
      }
    }
    return segs;
  }

  private _drawText(text: string, x: number, y: number, color: RGBA): void {
    // Simple 1-bit bitmapped text using a minimal 5×7 glyph set (ASCII 32-126)
    // Each character is drawn as 1× scaled pixels at the given position
    const fontSize = this._parseFontSize();
    const scale = Math.max(1, Math.round(fontSize / 8));
    const charW = 6 * scale, charH = 8 * scale;
    let curX = x;
    if (this.textAlign === 'center') curX -= (text.length * charW) / 2;
    else if (this.textAlign === 'right' || this.textAlign === 'end') curX -= text.length * charW;

    for (const ch of text) {
      const code = ch.charCodeAt(0);
      const glyph = FONT_5X7[code] ?? FONT_5X7[63]; // fallback '?'
      if (glyph) {
        for (let row = 0; row < 7; row++) {
          const rowBits = glyph[row] ?? 0;
          for (let col = 0; col < 5; col++) {
            if (rowBits & (1 << (4 - col))) {
              for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
                const px2 = curX + col*scale + sx;
                const py2 = y + row*scale + sy;
                if (px2 < 0 || px2 >= this._w || py2 < 0 || py2 >= this._h) continue;
                blendPixel(this._fb, (py2*this._w+px2)*4, color.r, color.g, color.b, color.a);
              }
            }
          }
        }
      }
      curX += charW;
    }
  }
}

// ── Minimal 5×7 bitmap font ───────────────────────────────────────────────────
// Each entry is 7 rows of 5 bits (bit 4 = leftmost pixel)
// Encoding: array of 7 numbers, each 0-31

const FONT_5X7: Partial<Record<number, number[]>> = {
  32: [0,0,0,0,0,0,0],           // space
  33: [4,4,4,4,0,0,4],           // !
  65: [14,17,17,31,17,17,17],    // A
  66: [30,17,17,30,17,17,30],    // B
  67: [14,17,16,16,16,17,14],    // C
  68: [30,9,9,9,9,9,30],         // D
  69: [31,16,16,30,16,16,31],    // E
  70: [31,16,16,30,16,16,16],    // F
  71: [14,17,16,23,17,17,14],    // G
  72: [17,17,17,31,17,17,17],    // H
  73: [14,4,4,4,4,4,14],         // I
  74: [7,2,2,2,2,18,12],         // J
  75: [17,18,20,24,20,18,17],    // K
  76: [16,16,16,16,16,16,31],    // L
  77: [17,27,21,21,17,17,17],    // M
  78: [17,25,25,21,19,19,17],    // N
  79: [14,17,17,17,17,17,14],    // O
  80: [30,17,17,30,16,16,16],    // P
  81: [14,17,17,17,21,18,13],    // Q
  82: [30,17,17,30,20,18,17],    // R
  83: [14,17,16,14,1,17,14],     // S
  84: [31,4,4,4,4,4,4],          // T
  85: [17,17,17,17,17,17,14],    // U
  86: [17,17,17,17,17,10,4],     // V
  87: [17,17,21,21,21,21,10],    // W
  88: [17,17,10,4,10,17,17],     // X
  89: [17,17,10,4,4,4,4],        // Y
  90: [31,1,2,4,8,16,31],        // Z
  97: [0,0,14,1,15,17,15],       // a
  98: [16,16,30,17,17,17,30],    // b
  99: [0,0,14,16,16,17,14],      // c
  100:[1,1,15,17,17,17,15],      // d
  101:[0,0,14,17,31,16,14],      // e
  102:[6,8,8,28,8,8,8],          // f
  103:[0,15,17,17,15,1,14],      // g
  104:[16,16,30,17,17,17,17],    // h
  105:[4,0,12,4,4,4,14],         // i
  106:[2,0,6,2,2,18,12],         // j
  107:[16,16,18,20,28,18,17],    // k
  108:[12,4,4,4,4,4,14],         // l
  109:[0,0,26,21,21,21,21],      // m
  110:[0,0,30,17,17,17,17],      // n
  111:[0,0,14,17,17,17,14],      // o
  112:[0,0,30,17,17,30,16],      // p
  113:[0,0,15,17,17,15,1],       // q
  114:[0,0,22,24,16,16,16],      // r
  115:[0,0,15,16,14,1,30],       // s
  116:[8,8,28,8,8,9,6],          // t
  117:[0,0,17,17,17,17,15],      // u
  118:[0,0,17,17,17,10,4],       // v
  119:[0,0,17,17,21,21,10],      // w
  120:[0,0,17,10,4,10,17],       // x
  121:[0,0,17,17,15,1,14],       // y
  122:[0,0,31,2,4,8,31],         // z
  48: [14,17,17,17,17,17,14],    // 0
  49: [4,12,4,4,4,4,14],         // 1
  50: [14,17,1,6,8,16,31],       // 2
  51: [14,17,1,6,1,17,14],       // 3
  52: [2,6,10,18,31,2,2],        // 4
  53: [31,16,30,1,1,17,14],      // 5
  54: [6,8,16,30,17,17,14],      // 6
  55: [31,1,2,4,8,8,8],          // 7
  56: [14,17,17,14,17,17,14],    // 8
  57: [14,17,17,15,1,2,12],      // 9
  46: [0,0,0,0,0,12,12],         // .
  44: [0,0,0,0,12,8,16],         // ,
  58: [0,12,12,0,12,12,0],       // :
  59: [0,12,12,0,12,8,16],       // ;
  45: [0,0,0,31,0,0,0],          // -
  43: [0,4,4,31,4,4,0],          // +
  61: [0,0,31,0,31,0,0],         // =
  47: [1,2,4,8,16,0,0],          // /
  92: [16,8,4,2,1,0,0],          // backslash
  40: [2,4,8,8,8,4,2],           // (
  41: [8,4,2,2,2,4,8],           // )
  91: [14,8,8,8,8,8,14],         // [
  93: [14,2,2,2,2,2,14],         // ]
  63: [14,17,1,6,4,0,4],         // ?
  64: [14,17,1,13,21,21,14],     // @
};

// ── HTMLCanvasElement (lightweight interface) ──────────────────────────────────

export class HTMLCanvasElement {
  width: number;
  height: number;
  private _ctx: CanvasRenderingContext2D | null = null;

  constructor(width = 300, height = 150) {
    this.width = width;
    this.height = height;
  }

  getContext(contextId: '2d'): CanvasRenderingContext2D;
  getContext(contextId: string): CanvasRenderingContext2D | null {
    if (contextId === '2d') {
      if (!this._ctx) this._ctx = new CanvasRenderingContext2D(this.width, this.height);
      return this._ctx;
    }
    return null;
  }

  toDataURL(_type = 'image/png'): string {
    return this._ctx?.toDataURL(_type) ?? 'data:image/png;base64,';
  }

  toBlob(callback: (blob: Blob | null) => void, _type = 'image/png'): void {
    // Stub
    callback(null);
  }

  transferToImageBitmap(): ImageBitmap {
    const ctx = this._ctx ?? this.getContext('2d');
    return { width: this.width, height: this.height, data: ctx.framebuffer.slice() };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  return new HTMLCanvasElement(width, height);
}

export function createImageBitmap(data: Uint8Array, width: number, height: number): ImageBitmap {
  return { width, height, data: data.slice(0, width * height * 4) };
}

/** Decode a cached image by key or create a new cache entry */
export function getOrLoadBitmap(key: string, width: number, height: number, data: Uint8Array): ImageBitmap {
  const cached = bitmapCache.get(key);
  if (cached) return cached;
  const bm: ImageBitmap = { width, height, data: data.slice() };
  bitmapCache.put(key, bm);
  return bm;
}

export const canvas2d = {
  createCanvas,
  createImageBitmap,
  getOrLoadBitmap,
  bitmapCache,
  CanvasRenderingContext2D,
  HTMLCanvasElement,
  CanvasGradient,
  Path2D,
};
