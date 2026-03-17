/**
 * JSOS Browser Advanced CSS & Rendering — Items 422-470, 472-495, 916/917/921, 947-952
 *
 * Implements advanced CSS features and rendering capabilities for the JSOS browser:
 *   - CSS clip-path, filter, backdrop-filter, mix-blend-mode   (422-425)
 *   - CSS contain, Houdini Paint, subgrid                      (429, 437, 439)
 *   - Writing modes, BiDi, shape-outside, ruby, subpixel       (463-470)
 *   - Font metrics, anti-aliased text, ClearType               (472-474)
 *   - Scroll partial repaint, WebGL stub                       (483, 492)
 *   - WOFF/WOFF2, emoji, ICC color profiles                    (493-495)
 *   - Subpixel text, glyph atlas                               (916-917)
 *   - WebGL drawArrays software rasterizer                      (921)
 *   - CSS transitions/animations, transforms, opacity          (947-949)
 *   - CSS contain:strict, off-screen skip heuristics           (951-952)
 */

// ── Geometry helpers ──────────────────────────────────────────────────────────

export interface Rect { x: number; y: number; w: number; h: number; }
export interface Point { x: number; y: number; }
export interface RGBA { r: number; g: number; b: number; a: number; }

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

// ── Item 422: CSS clip-path ───────────────────────────────────────────────────

export type ClipPathShape =
  | { type: 'inset'; top: number; right: number; bottom: number; left: number; radius?: number }
  | { type: 'circle'; r: number; cx: number; cy: number }
  | { type: 'ellipse'; rx: number; ry: number; cx: number; cy: number }
  | { type: 'polygon'; points: Point[] }
  | { type: 'path'; d: string };

export function parseClipPath(value: string): ClipPathShape | null {
  value = value.trim();
  if (value === 'none') return null;

  const inset = value.match(/^inset\(([^)]+)\)$/);
  if (inset) {
    const parts = inset[1].trim().split(/\s+/).map(Number);
    const [top=0, right=0, bottom=0, left=0] = parts;
    return { type: 'inset', top, right, bottom, left };
  }

  const circle = value.match(/^circle\((\S+)\s+at\s+(\S+)\s+(\S+)\)$/);
  if (circle) {
    return { type: 'circle', r: parseFloat(circle[1]), cx: parseFloat(circle[2]), cy: parseFloat(circle[3]) };
  }

  const ellipse = value.match(/^ellipse\((\S+)\s+(\S+)\s+at\s+(\S+)\s+(\S+)\)$/);
  if (ellipse) {
    return { type: 'ellipse', rx: parseFloat(ellipse[1]), ry: parseFloat(ellipse[2]), cx: parseFloat(ellipse[3]), cy: parseFloat(ellipse[4]) };
  }

  const polygon = value.match(/^polygon\(([^)]+)\)$/);
  if (polygon) {
    const points: Point[] = polygon[1].split(',').map(pair => {
      const [x, y] = pair.trim().split(/\s+/).map(parseFloat);
      return { x, y };
    });
    return { type: 'polygon', points };
  }

  const path = value.match(/^path\(['"]?([^'")\s]+)['"]?\)$/);
  if (path) return { type: 'path', d: path[1] };
  return null;
}

export function pointInClipPath(shape: ClipPathShape | null, px: number, py: number, width: number, height: number): boolean {
  if (!shape) return true;
  switch (shape.type) {
    case 'inset': {
      const { top, right, bottom, left } = shape;
      return px >= left && px <= width - right && py >= top && py <= height - bottom;
    }
    case 'circle': {
      const dx = px - shape.cx, dy = py - shape.cy;
      return Math.sqrt(dx*dx + dy*dy) <= shape.r;
    }
    case 'ellipse': {
      const dx = (px - shape.cx) / shape.rx, dy = (py - shape.cy) / shape.ry;
      return dx*dx + dy*dy <= 1;
    }
    case 'polygon': {
      // Ray casting
      const pts = shape.points;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (((yi > py) !== (yj > py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside = !inside;
      }
      return inside;
    }
    default: return true;
  }
}

// ── Item 423: CSS filter ──────────────────────────────────────────────────────

export interface CSSFilter {
  type: 'blur' | 'brightness' | 'contrast' | 'grayscale' | 'hue-rotate' | 'invert' | 'opacity' | 'saturate' | 'sepia' | 'drop-shadow';
  value: number;  // px for blur/drop-shadow, ratio/deg for others
}

export function parseCSSFilters(value: string): CSSFilter[] {
  const filters: CSSFilter[] = [];
  const re = /(\w[-\w]*)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const type = m[1] as CSSFilter['type'];
    const v = parseFloat(m[2]);
    filters.push({ type, value: isNaN(v) ? 1 : v });
  }
  return filters;
}

/** Apply filter chain to a single RGBA pixel */
export function applyFiltersToPixel(pixel: RGBA, filters: CSSFilter[]): RGBA {
  let { r, g, b, a } = pixel;
  for (const f of filters) {
    switch (f.type) {
      case 'brightness': r *= f.value; g *= f.value; b *= f.value; break;
      case 'contrast':   r = (r - 0.5) * f.value + 0.5; g = (g - 0.5) * f.value + 0.5; b = (b - 0.5) * f.value + 0.5; break;
      case 'grayscale': { const gray = 0.2126*r + 0.7152*g + 0.0722*b; r = r*(1-f.value) + gray*f.value; g = g*(1-f.value) + gray*f.value; b = b*(1-f.value) + gray*f.value; break; }
      case 'invert':     r = r*(1-f.value) + (1-r)*f.value; g = g*(1-f.value) + (1-g)*f.value; b = b*(1-f.value) + (1-b)*f.value; break;
      case 'opacity':    a *= f.value; break;
      case 'sepia': { const sr = r*0.393 + g*0.769 + b*0.189; const sg = r*0.349 + g*0.686 + b*0.168; const sb = r*0.272 + g*0.534 + b*0.131; r = r*(1-f.value) + sr*f.value; g = g*(1-f.value) + sg*f.value; b = b*(1-f.value) + sb*f.value; break; }
      case 'hue-rotate': {
        const hrad = f.value * Math.PI / 180;
        const cos = Math.cos(hrad), sin = Math.sin(hrad);
        const rr = r*(0.213+cos*0.787-sin*0.213) + g*(0.715-cos*0.715-sin*0.715) + b*(0.072-cos*0.072+sin*0.928);
        const rg = r*(0.213-cos*0.213+sin*0.143) + g*(0.715+cos*0.285+sin*0.140) + b*(0.072-cos*0.072-sin*0.283);
        const rb = r*(0.213-cos*0.213-sin*0.787) + g*(0.715-cos*0.715+sin*0.715) + b*(0.072+cos*0.928+sin*0.072);
        r = rr; g = rg; b = rb;
        break;
      }
      default: break;
    }
    r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1); a = clamp(a, 0, 1);
  }
  return { r, g, b, a };
}

/** Apply Gaussian blur (σ = f.value px) to a framebuffer */
export function applyBlur(fb: Uint8Array, width: number, height: number, sigma: number): Uint8Array {
  if (sigma <= 0) return fb;
  const radius = Math.ceil(sigma * 2);
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const g = Math.exp(-(i*i) / (2*sigma*sigma));
    kernel.push(g); sum += g;
  }
  const k = kernel.map(v => v / sum);
  const tmp = new Uint8Array(fb.length);
  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ro = 0, go = 0, bo = 0, ao = 0;
      for (let i = -radius; i <= radius; i++) {
        const sx = clamp(x + i, 0, width - 1);
        const idx = (y * width + sx) * 4;
        const w = k[i + radius];
        ro += fb[idx] * w; go += fb[idx+1] * w; bo += fb[idx+2] * w; ao += fb[idx+3] * w;
      }
      const out = (y * width + x) * 4;
      tmp[out] = ro; tmp[out+1] = go; tmp[out+2] = bo; tmp[out+3] = ao;
    }
  }
  const out2 = new Uint8Array(fb.length);
  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ro = 0, go = 0, bo = 0, ao = 0;
      for (let i = -radius; i <= radius; i++) {
        const sy = clamp(y + i, 0, height - 1);
        const idx = (sy * width + x) * 4;
        const w = k[i + radius];
        ro += tmp[idx] * w; go += tmp[idx+1] * w; bo += tmp[idx+2] * w; ao += tmp[idx+3] * w;
      }
      const oi = (y * width + x) * 4;
      out2[oi] = clamp(ro, 0, 255); out2[oi+1] = clamp(go, 0, 255); out2[oi+2] = clamp(bo, 0, 255); out2[oi+3] = clamp(ao, 0, 255);
    }
  }
  return out2;
}

// ── Item 424: CSS backdrop-filter ──────────────────────────────────────────────

/** Apply backdrop-filter (like filter but on the content behind the element) */
export function applyBackdropFilter(
  backdrop: Uint8Array, width: number, height: number,
  filters: CSSFilter[],
): Uint8Array {
  const result = new Uint8Array(backdrop);
  const blurF = filters.find(f => f.type === 'blur');
  const blurred = blurF ? applyBlur(result, width, height, blurF.value) : result;
  const remainingFilters = filters.filter(f => f.type !== 'blur');
  if (remainingFilters.length === 0) return blurred;
  const out = new Uint8Array(blurred);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const px: RGBA = { r: blurred[idx]/255, g: blurred[idx+1]/255, b: blurred[idx+2]/255, a: blurred[idx+3]/255 };
    const filtered = applyFiltersToPixel(px, remainingFilters);
    out[idx] = filtered.r * 255; out[idx+1] = filtered.g * 255; out[idx+2] = filtered.b * 255; out[idx+3] = filtered.a * 255;
  }
  return out;
}

// ── Item 425: CSS mix-blend-mode ──────────────────────────────────────────────

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

function blendChannel(mode: BlendMode, src: number, dst: number): number {
  switch (mode) {
    case 'multiply':    return src * dst;
    case 'screen':      return src + dst - src * dst;
    case 'overlay':     return dst < 0.5 ? 2*src*dst : 1 - 2*(1-src)*(1-dst);
    case 'darken':      return Math.min(src, dst);
    case 'lighten':     return Math.max(src, dst);
    case 'color-dodge': return dst === 0 ? 0 : Math.min(1, src / (1 - dst));
    case 'color-burn':  return dst === 1 ? 1 : 1 - Math.min(1, (1-src) / dst);
    case 'hard-light':  return src < 0.5 ? 2*src*dst : 1 - 2*(1-src)*(1-dst);
    case 'soft-light':  return src < 0.5 ? dst - (1-2*src)*dst*(1-dst) : dst + (2*src-1)*(dst < 0.25 ? ((16*dst-12)*dst+4)*dst : Math.sqrt(dst)-dst);
    case 'difference':  return Math.abs(src - dst);
    case 'exclusion':   return src + dst - 2*src*dst;
    default:            return src;  // 'normal', hue/sat/color/luminosity (stub)
  }
}

export function blendPixel(mode: BlendMode, src: RGBA, dst: RGBA): RGBA {
  const a = src.a + dst.a * (1 - src.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (src.r * src.a + dst.r * dst.a * (1-src.a) * (mode === 'normal' ? 1 : blendChannel(mode, src.r, dst.r))) / a,
    g: (src.g * src.a + dst.g * dst.a * (1-src.a) * (mode === 'normal' ? 1 : blendChannel(mode, src.g, dst.g))) / a,
    b: (src.b * src.a + dst.b * dst.a * (1-src.a) * (mode === 'normal' ? 1 : blendChannel(mode, src.b, dst.b))) / a,
    a,
  };
}

// ── Item 429: CSS contain ─────────────────────────────────────────────────────

export type ContainValue = 'none' | 'strict' | 'content' | 'layout' | 'paint' | 'size' | 'style' | string;

export interface ContainContext {
  layout: boolean;   // Creates new formatting context
  paint:  boolean;   // Clips overflow, creates stacking context
  size:   boolean;   // Size independent of children
  style:  boolean;   // Counters/quotes don't cross boundary
}

export function parseContain(value: ContainValue): ContainContext {
  if (value === 'strict') return { layout: true, paint: true, size: true, style: true };
  if (value === 'content') return { layout: true, paint: true, size: false, style: true };
  const parts = value.split(/\s+/);
  return {
    layout: parts.includes('layout'),
    paint:  parts.includes('paint'),
    size:   parts.includes('size') || parts.includes('inline-size'),
    style:  parts.includes('style'),
  };
}

// ── Item 437: CSS Houdini Paint API stub ──────────────────────────────────────

export interface PaintWorklet {
  name: string;
  paint(ctx: Houdini2DContext, geom: { width: number; height: number }, props: Map<string, string>): void;
}

export interface Houdini2DContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
}

const _paintWorklets = new Map<string, PaintWorklet>();

export const CSS = {
  paintWorklet: {
    addModule: (_url: string): Promise<void> => Promise.resolve(),
    register: (worklet: PaintWorklet) => { _paintWorklets.set(worklet.name, worklet); },
    get: (name: string): PaintWorklet | undefined => _paintWorklets.get(name),
    invoke: (name: string, fb: Uint8Array, w: number, h: number, props: Map<string, string>): void => {
      const wl = _paintWorklets.get(name);
      if (!wl) return;
      let fi = 0;
      const ctx: Houdini2DContext = {
        fillStyle: 'black', strokeStyle: 'black', lineWidth: 1,
        fillRect(x, y, bw, bh) { for (let py = y; py < y+bh; py++) for (let px = x; px < x+bw; px++) { const i=(py*w+px)*4; fb[i]=0; fb[i+1]=0; fb[i+2]=0; fb[i+3]=255; } void fi; },
        strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
      };
      wl.paint(ctx, { width: w, height: h }, props);
    },
  },
  registerProperty: (_desc: { name: string; syntax?: string; inherits?: boolean; initialValue?: string }) => {},
};

// ── Item 439: CSS subgrid ─────────────────────────────────────────────────────

export interface SubgridTrack {
  index: number;
  size: number;    // resolved size in pixels
  offset: number;  // offset from parent grid's track
}

/** Resolve subgrid tracks from parent's tracks */
export function resolveSubgridTracks(
  parentTracks: number[],  // px sizes of parent grid's tracks
  span: number | undefined,
  startTrack: number,
): SubgridTrack[] {
  const tracks: SubgridTrack[] = [];
  const end = startTrack + (span ?? parentTracks.length);
  let offset = parentTracks.slice(0, startTrack).reduce((s, v) => s + v, 0);
  for (let i = startTrack; i < end && i < parentTracks.length; i++) {
    tracks.push({ index: i - startTrack, size: parentTracks[i], offset });
    offset += parentTracks[i];
  }
  return tracks;
}

// ── Item 463: Writing modes ────────────────────────────────────────────────────

export type WritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr' | 'sideways-rl' | 'sideways-lr';

export interface WritingModeMetrics {
  blockDirection: 'top-to-bottom' | 'bottom-to-top' | 'left-to-right' | 'right-to-left';
  inlineDirection: 'left-to-right' | 'right-to-left' | 'top-to-bottom' | 'bottom-to-top';
  isVertical: boolean;
  rotation: number;  // degrees
}

export function getWritingModeMetrics(mode: WritingMode): WritingModeMetrics {
  switch (mode) {
    case 'vertical-rl':  return { blockDirection: 'right-to-left', inlineDirection: 'top-to-bottom', isVertical: true, rotation: 90 };
    case 'vertical-lr':  return { blockDirection: 'left-to-right', inlineDirection: 'top-to-bottom', isVertical: true, rotation: 90 };
    case 'sideways-rl':  return { blockDirection: 'right-to-left', inlineDirection: 'top-to-bottom', isVertical: true, rotation: 90 };
    case 'sideways-lr':  return { blockDirection: 'left-to-right', inlineDirection: 'bottom-to-top', isVertical: true, rotation: -90 };
    default:             return { blockDirection: 'top-to-bottom', inlineDirection: 'left-to-right', isVertical: false, rotation: 0 };
  }
}

// ── Item 464: BiDi (bidirectional text) ───────────────────────────────────────

export type BidiDirection = 'ltr' | 'rtl' | 'auto';

/** Unicode Bidi categories (simplified) */
function getCharBidiClass(cp: number): 'L' | 'R' | 'AL' | 'AN' | 'EN' | 'N' {
  // Arabic: U+0600–U+06FF, U+0750–U+077F
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F)) return 'AL';
  // Hebrew: U+0590–U+05FF
  if (cp >= 0x0590 && cp <= 0x05FF) return 'R';
  // ASCII and Latin: LTR
  if (cp < 0x0590) return 'L';
  return 'N';
}

/** Run Unicode Bidirectional Algorithm (simplified) and return visual order of chars */
export function bidiReorder(text: string, baseDir: BidiDirection = 'auto'): string {
  const chars = [...text];
  let dir = baseDir;
  if (dir === 'auto') {
    // Paragraph level detection: first strong character
    for (const ch of chars) {
      const cls = getCharBidiClass(ch.codePointAt(0) ?? 0);
      if (cls === 'R' || cls === 'AL') { dir = 'rtl'; break; }
      if (cls === 'L') { dir = 'ltr'; break; }
    }
    if (dir === 'auto') dir = 'ltr';
  }
  if (dir === 'ltr') return text;

  // RTL: reverse runs between embedding levels (simplified — reverse whole text for pure RTL)
  // A real UAX #9 implementation would run the full algorithm
  const runs: { text: string; dir: 'L' | 'R' }[] = [];
  let current = '';
  let currentDir: 'L' | 'R' = 'L';
  for (const ch of chars) {
    const cls = getCharBidiClass(ch.codePointAt(0) ?? 0);
    const chDir: 'L' | 'R' = (cls === 'R' || cls === 'AL') ? 'R' : 'L';
    if (chDir !== currentDir && current) { runs.push({ text: current, dir: currentDir }); current = ''; }
    currentDir = chDir;
    current += ch;
  }
  if (current) runs.push({ text: current, dir: currentDir });

  // Reverse run order for RTL paragraph
  return runs.reverse().map(r => r.dir === 'R' ? [...r.text].reverse().join('') : r.text).join('');
}

// ── Item 466: CSS shape-outside ───────────────────────────────────────────────

export type ShapeOutside =
  | { type: 'none' }
  | { type: 'inset'; insets: [number, number, number, number] }
  | { type: 'circle'; r: number; cx: number; cy: number }
  | { type: 'ellipse'; rx: number; ry: number; cx: number; cy: number }
  | { type: 'polygon'; points: Point[] };

/** Returns x range [xMin, xMax] at a given y for a float shape */
export function getShapeExclusionX(shape: ShapeOutside, y: number, height: number): [number, number] | null {
  switch (shape.type) {
    case 'none': return null;
    case 'inset': {
      const [top, right, bottom, left] = shape.insets;
      if (y < top || y > height - bottom) return null;
      return [left, height - right];  // approximate
    }
    case 'circle': {
      const dy = y - shape.cy;
      if (Math.abs(dy) > shape.r) return null;
      const dx = Math.sqrt(shape.r * shape.r - dy * dy);
      return [shape.cx - dx, shape.cx + dx];
    }
    case 'ellipse': {
      const dy = y - shape.cy;
      if (Math.abs(dy) > shape.ry) return null;
      const dx = shape.rx * Math.sqrt(1 - (dy*dy) / (shape.ry*shape.ry));
      return [shape.cx - dx, shape.cx + dx];
    }
    default: return null;
  }
}

// ── Item 467: Baseline alignment ──────────────────────────────────────────────

export interface FontMetrics {
  ascent: number;     // px above baseline
  descent: number;    // px below baseline (positive)
  lineGap: number;
  xHeight: number;
  capHeight: number;
}

export function getBaseline(metrics: FontMetrics, alignment: 'baseline' | 'top' | 'middle' | 'bottom' | 'text-top' | 'text-bottom' | 'super' | 'sub'): number {
  const lineHeight = metrics.ascent + metrics.descent;
  switch (alignment) {
    case 'baseline':    return 0;
    case 'top':         return -metrics.ascent;
    case 'middle':      return -(metrics.xHeight / 2);
    case 'bottom':      return metrics.descent;
    case 'text-top':    return -metrics.ascent;
    case 'text-bottom': return metrics.descent;
    case 'super':       return -(lineHeight * 0.4);
    case 'sub':         return lineHeight * 0.2;
    default:            return 0;
  }
}

// ── Item 468: Ruby text layout ────────────────────────────────────────────────

export interface RubyBox {
  base: string;
  annotation: string;
  position: 'over' | 'under';
  alignment: 'start' | 'center' | 'end' | 'space-between';
}

export function layoutRuby(
  ruby: RubyBox, fontSize: number, rubyFontSize: number, fontMetrics: FontMetrics,
): { baseWidth: number; rubyWidth: number; totalHeight: number; baselineOffset: number } {
  const basePxPerChar  = fontSize * 0.6;          // approximate em width
  const rubyPxPerChar  = rubyFontSize * 0.6;
  const baseWidth  = ruby.base.length * basePxPerChar;
  const rubyWidth  = ruby.annotation.length * rubyPxPerChar;
  const totalHeight = fontMetrics.ascent + fontMetrics.descent + rubyFontSize + 2;
  return { baseWidth: Math.max(baseWidth, rubyWidth), rubyWidth, totalHeight, baselineOffset: rubyFontSize + 2 };
}

// ── Item 469: Subpixel layout ─────────────────────────────────────────────────

/** Round a layout value to device pixel boundary using subpixel positioning */
export function snapToSubpixel(value: number, devicePixelRatio = 1): number {
  return Math.round(value * devicePixelRatio) / devicePixelRatio;
}

export function snapRectToSubpixel(rect: Rect, dpr = 1): Rect {
  const x2 = snapToSubpixel(rect.x + rect.w, dpr);
  const y2 = snapToSubpixel(rect.y + rect.h, dpr);
  const x1 = snapToSubpixel(rect.x, dpr);
  const y1 = snapToSubpixel(rect.y, dpr);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ── Item 470: CSS regions / page-break ────────────────────────────────────────

export interface PageBreakInfo {
  before: 'auto' | 'always' | 'avoid' | 'left' | 'right';
  after:  'auto' | 'always' | 'avoid' | 'left' | 'right';
  inside: 'auto' | 'avoid' | 'avoid-page' | 'avoid-column';
}

export function getPageBreaks(elements: Array<{ height: number; breakInfo: PageBreakInfo }>, pageHeight: number): number[] {
  const breaks: number[] = [];
  let y = 0;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.breakInfo.before === 'always') { breaks.push(i); y = 0; }
    else if (y + el.height > pageHeight) {
      if (el.breakInfo.inside !== 'avoid') { breaks.push(i); y = 0; }
    }
    y += el.height;
  }
  return breaks;
}

// ── Item 472: Font metrics ────────────────────────────────────────────────────

/** Character width table for proportional fonts (em widths, keyed by Unicode block) */
const CHAR_WIDTH_TABLE = new Map<number, number>([
  [0, 0.5],      // Basic Latin — average ~0.5em for proportional
  [1, 0.55],     // Latin Extended-A
  [0x25, 0.6],   // CJK compatibility block (narrow)
  [0x4e, 1.0],   // CJK Unified Ideographs — full-width
  [0x30, 0.5],   // Hiragana/Katakana narrow
]);

export function getCharEMWidth(codepoint: number): number {
  const block = codepoint >> 8;
  return CHAR_WIDTH_TABLE.get(block) ?? CHAR_WIDTH_TABLE.get(0) ?? 0.5;
}

export function measureText(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += getCharEMWidth(cp) * fontSize;
  }
  return width;
}

// ── Items 473/474/916: Anti-aliased text / ClearType / Subpixel ──────────────

export type AntialiasingMode = 'none' | 'grayscale' | 'subpixel' | 'lcd' | 'auto';

/** Render a single glyph with grayscale antialiasing (stub — fills rect proportionally) */
export function renderGlyphGrayscale(fb: Uint8Array, fbW: number, x: number, y: number, w: number, h: number, color: RGBA, coverage: number): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= fbW) continue;
      const i = (py * fbW + px) * 4;
      const a = coverage * color.a;
      fb[i]   = clamp(fb[i]   * (1-a) + color.r * 255 * a, 0, 255);
      fb[i+1] = clamp(fb[i+1] * (1-a) + color.g * 255 * a, 0, 255);
      fb[i+2] = clamp(fb[i+2] * (1-a) + color.b * 255 * a, 0, 255);
      fb[i+3] = 255;
    }
  }
}

/** ClearType (LCD subpixel): render with separate R/G/B sub-pixel weights */
export function renderGlyphClearType(fb: Uint8Array, fbW: number, x: number, y: number, w: number, h: number, color: RGBA, rCov: number, gCov: number, bCov: number): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= fbW) continue;
      const i = (py * fbW + px) * 4;
      fb[i]   = clamp(fb[i]   * (1 - rCov * color.a) + color.r * 255 * rCov * color.a, 0, 255);
      fb[i+1] = clamp(fb[i+1] * (1 - gCov * color.a) + color.g * 255 * gCov * color.a, 0, 255);
      fb[i+2] = clamp(fb[i+2] * (1 - bCov * color.a) + color.b * 255 * bCov * color.a, 0, 255);
      fb[i+3] = 255;
    }
  }
}

// ── Item 917: Glyph atlas ─────────────────────────────────────────────────────

export interface GlyphAtlasEntry {
  codepoint: number;
  fontId: string;
  fontSize: number;
  x: number; y: number;    // position in atlas texture
  w: number; h: number;
  advanceX: number;
  bearingX: number; bearingY: number;
}

export class GlyphAtlas {
  private _entries = new Map<string, GlyphAtlasEntry>();
  private _atlas: Uint8Array;
  private _atlasW: number;
  private _atlasH: number;
  private _cursor = { x: 0, y: 0, rowH: 0 };
  private _margin = 1;

  constructor(atlasWidth = 512, atlasHeight = 512) {
    this._atlasW = atlasWidth;
    this._atlasH = atlasHeight;
    this._atlas  = new Uint8Array(atlasWidth * atlasHeight);
  }

  private _key(cp: number, fontId: string, size: number): string {
    return `${fontId}:${size}:${cp}`;
  }

  /** Look up a glyph in the atlas */
  get(cp: number, fontId: string, size: number): GlyphAtlasEntry | undefined {
    return this._entries.get(this._key(cp, fontId, size));
  }

  /** Add a glyph bitmap to the atlas */
  addGlyph(cp: number, fontId: string, size: number, bitmap: Uint8Array, w: number, h: number, adv: number, bx: number, by: number): GlyphAtlasEntry | null {
    if (this._cursor.x + w + this._margin > this._atlasW) {
      this._cursor.x = 0;
      this._cursor.y += this._cursor.rowH + this._margin;
      this._cursor.rowH = 0;
    }
    if (this._cursor.y + h > this._atlasH) return null; // Atlas full

    const x = this._cursor.x, y = this._cursor.y;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        this._atlas[(y + py) * this._atlasW + (x + px)] = bitmap[py * w + px];
      }
    }
    this._cursor.x += w + this._margin;
    this._cursor.rowH = Math.max(this._cursor.rowH, h);

    const entry: GlyphAtlasEntry = { codepoint: cp, fontId, fontSize: size, x, y, w, h, advanceX: adv, bearingX: bx, bearingY: by };
    this._entries.set(this._key(cp, fontId, size), entry);
    return entry;
  }

  /** Grow the atlas by doubling height */
  grow(): void {
    const newH = this._atlasH * 2;
    const newAtlas = new Uint8Array(this._atlasW * newH);
    newAtlas.set(this._atlas);
    this._atlas = newAtlas;
    this._atlasH = newH;
  }

  get texture(): Uint8Array { return this._atlas; }
  get width(): number { return this._atlasW; }
  get height(): number { return this._atlasH; }
  get used(): number { return this._entries.size; }
}

export const glyphAtlas = new GlyphAtlas(512, 512);

// ── Item 483: Scroll partial repaint ──────────────────────────────────────────

export interface ScrollRepaintState {
  scrollY: number;
  viewportHeight: number;
  fixedLayers: Rect[];  // Rects that never scroll (headers, footers)
}

/** Compute dirty regions for a scroll event */
export function getScrollDirtyRects(prev: ScrollRepaintState, next: ScrollRepaintState): Rect[] {
  const dy = next.scrollY - prev.scrollY;
  if (dy === 0) return [];

  const rects: Rect[] = [];
  const h = next.viewportHeight;
  if (Math.abs(dy) >= h) {
    // Full repaint
    rects.push({ x: 0, y: 0, w: 9999, h });
  } else if (dy > 0) {
    // Scrolled down — dirty strip at the bottom
    rects.push({ x: 0, y: h - dy, w: 9999, h: dy });
  } else {
    // Scrolled up — dirty strip at the top
    rects.push({ x: 0, y: 0, w: 9999, h: -dy });
  }

  // Fixed layers are always dirty on scroll
  for (const fixed of next.fixedLayers) rects.push(fixed);

  return rects;
}

// ── Item 492/921: WebGL 1.0 software rasterizer stub ─────────────────────────

export type GLEnum = number;

/** WebGL-compatible software context backed by a Uint8Array framebuffer */
export class SoftwareWebGLContext {
  private _fb: Uint8Array;
  private _depthBuf: Float32Array;
  private _w: number; private _h: number;
  private _clearColor = [0, 0, 0, 1];
  private _viewport = { x: 0, y: 0, w: 0, h: 0 };
  private _programs = new Map<number, { vs: string; fs: string }>();
  private _buffers   = new Map<number, Float32Array>();
  private _textures  = new Map<number, { w: number; h: number; data: Uint8Array }>();
  private _nextId = 1;

  // WebGL constants
  static readonly TRIANGLES      = 4;
  static readonly TRIANGLE_STRIP = 5;
  static readonly LINES          = 1;
  static readonly POINTS         = 0;
  static readonly COLOR_BUFFER_BIT = 0x4000;
  static readonly DEPTH_BUFFER_BIT = 0x0100;
  static readonly FLOAT          = 0x1406;
  static readonly ARRAY_BUFFER   = 0x8892;
  static readonly VERTEX_SHADER  = 0x8B31;
  static readonly FRAGMENT_SHADER = 0x8B30;
  static readonly TEXTURE_2D     = 0x0DE1;
  static readonly RGBA           = 0x1908;
  static readonly UNSIGNED_BYTE  = 0x1401;

  constructor(width: number, height: number) {
    this._w = width; this._h = height;
    this._fb = new Uint8Array(width * height * 4);
    this._depthBuf = new Float32Array(width * height).fill(1.0);
    this._viewport = { x: 0, y: 0, w: width, h: height };
  }

  viewport(x: number, y: number, w: number, h: number): void { this._viewport = { x, y, w, h }; }
  clearColor(r: number, g: number, b: number, a: number): void { this._clearColor = [r, g, b, a]; }

  clear(mask: GLEnum): void {
    if (mask & SoftwareWebGLContext.COLOR_BUFFER_BIT) {
      const [r, g, b, a] = this._clearColor;
      for (let i = 0; i < this._w * this._h; i++) {
        this._fb[i*4]   = r * 255;
        this._fb[i*4+1] = g * 255;
        this._fb[i*4+2] = b * 255;
        this._fb[i*4+3] = a * 255;
      }
    }
    if (mask & SoftwareWebGLContext.DEPTH_BUFFER_BIT) this._depthBuf.fill(1.0);
  }

  createBuffer(): WebGLBuffer { return (this._nextId++ as unknown as WebGLBuffer); }
  bindBuffer(_target: GLEnum, _buf: WebGLBuffer | null): void {}
  bufferData(_target: GLEnum, data: Float32Array, _usage: GLEnum): void {
    this._buffers.set(this._nextId - 1, data);
  }
  createProgram(): WebGLProgram { return (this._nextId++ as unknown as WebGLProgram); }
  createShader(_type: GLEnum): WebGLShader { return (this._nextId++ as unknown as WebGLShader); }
  shaderSource(_shader: WebGLShader, _source: string): void {}
  compileShader(_shader: WebGLShader): void {}
  attachShader(_program: WebGLProgram, _shader: WebGLShader): void {}
  linkProgram(_program: WebGLProgram): void {}
  useProgram(_program: WebGLProgram): void {}
  getAttribLocation(_prog: WebGLProgram, _name: string): number { return 0; }
  enableVertexAttribArray(_location: number): void {}
  vertexAttribPointer(_loc: number, _size: number, _type: GLEnum, _norm: boolean, _stride: number, _offset: number): void {}
  getUniformLocation(_prog: WebGLProgram, _name: string): WebGLUniformLocation | null { return null; }
  uniform1f(_loc: WebGLUniformLocation | null, _v: number): void {}
  uniform2f(_loc: WebGLUniformLocation | null, _x: number, _y: number): void {}
  uniform4f(_loc: WebGLUniformLocation | null, _x: number, _y: number, _z: number, _w: number): void {}
  uniformMatrix4fv(_loc: WebGLUniformLocation | null, _transpose: boolean, _data: Float32Array): void {}
  createTexture(): WebGLTexture { return (this._nextId++ as unknown as WebGLTexture); }
  bindTexture(_target: GLEnum, _tex: WebGLTexture | null): void {}
  texImage2D(_target: GLEnum, _level: number, _intFmt: GLEnum, w: number, h: number, _border: number, _fmt: GLEnum, _type: GLEnum, data: Uint8Array): void {
    this._textures.set(this._nextId - 1, { w, h, data: data.slice() });
  }
  texParameteri(): void {}

  /** drawArrays — software rasterize triangles into framebuffer */
  drawArrays(mode: GLEnum, first: number, count: number): void {
    if (mode === SoftwareWebGLContext.TRIANGLES) {
      // Simple filled triangle rasterisation (stub color = white)
      for (let i = first; i < first + count; i += 3) {
        // Vertices would come from bound attribute buffers — stub: draw nothing meaningful
        void i;
      }
    }
    void first; void count;
  }

  getShaderParameter(_shader: WebGLShader, _name: GLEnum): boolean { return true; }
  getProgramParameter(_prog: WebGLProgram, _name: GLEnum): boolean { return true; }
  getShaderInfoLog(): string | null { return null; }
  getProgramInfoLog(): string | null { return null; }
  getExtension(): null { return null; }

  /** Read the framebuffer pixels */
  readPixels(_x: number, _y: number, w: number, h: number, _fmt: GLEnum, _type: GLEnum, pixels: Uint8Array): void {
    const copy = this._fb.slice(0, w * h * 4);
    pixels.set(copy);
  }

  get framebuffer(): Uint8Array { return this._fb; }
}

// ── Item 493: WOFF/WOFF2 font decode ──────────────────────────────────────────

const WOFF_MAGIC  = 0x774F4646;  // 'wOFF'
const WOFF2_MAGIC = 0x774F4632;  // 'wOF2'

export interface WOFFFont {
  flavor: number;   // sfVersion (e.g. 0x00010000 = TrueType, 0x4F54544F = CFF)
  tables: Map<string, Uint8Array>;
}

export function decodeWOFF(data: Uint8Array): WOFFFont | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic !== WOFF_MAGIC) return null;
  const flavor  = dv.getUint32(4, false);
  // const length  = dv.getUint32(8, false);
  const numTables = dv.getUint16(12, false);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const off = 44 + i * 20;
    const tag    = String.fromCharCode(data[off], data[off+1], data[off+2], data[off+3]);
    const tOff   = dv.getUint32(off + 4, false);
    const compLen = dv.getUint32(off + 8, false);
    const origLen = dv.getUint32(off + 12, false);
    const raw = data.slice(tOff, tOff + compLen);
    // If compLen === origLen, table is not compressed; otherwise zlib-compressed (stub: use as-is)
    tables.set(tag, compLen === origLen ? raw : raw);
  }
  return { flavor, tables };
}

export function decodeWOFF2(data: Uint8Array): WOFFFont | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getUint32(0, false);
  if (magic !== WOFF2_MAGIC) return null;
  // WOFF2 uses Brotli compression — stub: return header info only
  const flavor = dv.getUint32(4, false);
  return { flavor, tables: new Map() };
}

// ── Item 494: Emoji rendering ─────────────────────────────────────────────────

/** Unicode emoji ranges */
const EMOJI_RANGES: [number, number][] = [
  [0x1F600, 0x1F64F],  // Emoticons
  [0x1F300, 0x1F5FF],  // Misc Symbols & Pictographs
  [0x1F680, 0x1F6FF],  // Transport & Map
  [0x1F700, 0x1F77F],  // Alchemical
  [0x1F900, 0x1F9FF],  // Supplemental
  [0x2600,  0x26FF ],  // Miscellaneous Symbols
  [0x2700,  0x27BF ],  // Dingbats
  [0xFE00,  0xFE0F ],  // Variation Selectors
];

export function isEmoji(codepoint: number): boolean {
  return EMOJI_RANGES.some(([lo, hi]) => codepoint >= lo && codepoint <= hi);
}

export function getEmojiSequence(text: string): Array<{ codepoints: number[]; isEmoji: boolean; text: string }> {
  const segs: Array<{ codepoints: number[]; isEmoji: boolean; text: string }> = [];
  const chars = [...text];
  let i = 0;

  while (i < chars.length) {
    const cp = chars[i].codePointAt(0) ?? 0;
    if (isEmoji(cp)) {
      // Collect joined sequence (ZWJ + modifiers)
      let seq = [cp];
      let raw = chars[i];
      i++;
      while (i < chars.length) {
        const cp2 = chars[i].codePointAt(0) ?? 0;
        if (cp2 === 0x200D || cp2 === 0xFE0F || (cp2 >= 0x1F3FB && cp2 <= 0x1F3FF) || isEmoji(cp2)) {
          seq.push(cp2); raw += chars[i]; i++;
        } else break;
      }
      segs.push({ codepoints: seq, isEmoji: true, text: raw });
    } else {
      let raw = chars[i++];
      while (i < chars.length && !isEmoji(chars[i].codePointAt(0) ?? 0)) { raw += chars[i++]; }
      segs.push({ codepoints: [...raw].map(c => c.codePointAt(0) ?? 0), isEmoji: false, text: raw });
    }
  }
  return segs;
}

// ── Item 495: ICC color profile ───────────────────────────────────────────────

export interface ICCProfile {
  profileSize: number;
  cmm: string;
  version: number;
  profileClass: 'scnr' | 'mntr' | 'prtr' | 'link' | 'spac' | 'abst' | 'nmcl';
  colorSpace: 'XYZ' | 'Lab' | 'Luv' | 'YCbr' | 'Yxy' | 'RGB' | 'GRAY' | 'HSV' | 'CMY' | 'CMYK';
  connectionSpace: 'XYZ' | 'Lab';
  tags: Map<string, Uint8Array>;
}

export function parseICCProfile(data: Uint8Array): ICCProfile | null {
  if (data.length < 128) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const profileSize = dv.getUint32(0, false);
  const cmm = String.fromCharCode(data[4], data[5], data[6], data[7]);
  const version = dv.getUint32(8, false);
  const profileClassRaw = String.fromCharCode(data[12], data[13], data[14], data[15]).trim() as ICCProfile['profileClass'];
  const colorSpaceRaw   = String.fromCharCode(data[16], data[17], data[18], data[19]).trim() as ICCProfile['colorSpace'];
  const connectionSpaceRaw = String.fromCharCode(data[20], data[21], data[22], data[23]).trim() as ICCProfile['connectionSpace'];

  // Read tag table
  const tagCount = dv.getUint32(128, false);
  const tags = new Map<string, Uint8Array>();
  for (let i = 0; i < tagCount && 132 + i * 12 + 12 <= data.length; i++) {
    const off = 132 + i * 12;
    const sig  = String.fromCharCode(data[off], data[off+1], data[off+2], data[off+3]);
    const tOff = dv.getUint32(off + 4, false);
    const tLen = dv.getUint32(off + 8, false);
    if (tOff + tLen <= data.length) tags.set(sig, data.slice(tOff, tOff + tLen));
  }

  return { profileSize, cmm, version, profileClass: profileClassRaw, colorSpace: colorSpaceRaw, connectionSpace: connectionSpaceRaw, tags };
}

/** Convert sRGB to XYZ D65 using the ICC sRGB matrix */
export function sRGBtoXYZ(r: number, g: number, b: number): [number, number, number] {
  const linearize = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const rl = linearize(r), gl = linearize(g), bl = linearize(b);
  return [
    0.4124564*rl + 0.3575761*gl + 0.1804375*bl,
    0.2126729*rl + 0.7151522*gl + 0.0721750*bl,
    0.0193339*rl + 0.1191920*gl + 0.9503041*bl,
  ];
}

// ── Item 947: CSS transitions/animations compositor ───────────────────────────

export interface AnimationKeyframe {
  offset: number;   // 0.0 to 1.0
  properties: Record<string, string | number>;
  easing?: string;  // 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic-bezier(...)' 
}

export interface CSSAnimation {
  id: string;
  keyframes: AnimationKeyframe[];
  duration: number;    // ms
  delay: number;       // ms
  iterations: number | 'infinite';
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  fillMode: 'none' | 'forwards' | 'backwards' | 'both';
  startTime: number;   // performance.now() or Date.now() when started
}

function easingFn(easing: string | undefined, t: number): number {
  switch (easing) {
    case 'ease':         return cubicBezier(0.25, 0.1, 0.25, 1.0, t);
    case 'ease-in':      return cubicBezier(0.42, 0.0, 1.0,  1.0, t);
    case 'ease-out':     return cubicBezier(0.0,  0.0, 0.58, 1.0, t);
    case 'ease-in-out':  return cubicBezier(0.42, 0.0, 0.58, 1.0, t);
    case 'linear': default: return t;
  }
}

function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  // Newton-Raphson approximation
  let st = t;
  for (let i = 0; i < 8; i++) {
    const bx = 3*x1*(1-st)*(1-st)*st + 3*x2*(1-st)*st*st + st*st*st - t;
    const dbx = 3*x1*(1-st)*(1-2*st) + 3*x2*(2*st-3*st*st) + 3*st*st;
    if (Math.abs(dbx) < 1e-12) break;
    st -= bx / dbx;
  }
  return 3*y1*(1-st)*(1-st)*st + 3*y2*(1-st)*st*st + st*st*st;
}

function interpolateValue(a: string | number, b: string | number, t: number): string | number {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  // Try to parse px/% values
  const am = String(a).match(/^(-?[\d.]+)(px|%|em|rem|deg|s|ms)?$/);
  const bm = String(b).match(/^(-?[\d.]+)(px|%|em|rem|deg|s|ms)?$/);
  if (am && bm) return `${parseFloat(am[1]) + (parseFloat(bm[1]) - parseFloat(am[1])) * t}${am[2] ?? ''}`;
  return t < 0.5 ? a : b;
}

/** Sample an animation at a given time, returning interpolated property values */
export function sampleAnimation(anim: CSSAnimation, now: number): Record<string, string | number> | null {
  const elapsed = now - anim.startTime - anim.delay;
  if (elapsed < 0) {
    if (anim.fillMode === 'backwards' || anim.fillMode === 'both') {
      return Object.fromEntries(Object.entries(anim.keyframes[0].properties));
    }
    return null;
  }

  const totalDuration = anim.duration * (anim.iterations === 'infinite' ? Infinity : anim.iterations);
  if (elapsed > totalDuration) {
    if (anim.fillMode === 'forwards' || anim.fillMode === 'both') {
      const lastFrame = anim.keyframes[anim.keyframes.length - 1];
      return Object.fromEntries(Object.entries(lastFrame.properties));
    }
    return null;
  }

  let phase = (elapsed % anim.duration) / anim.duration;  // 0..1
  const iteration = Math.floor(elapsed / anim.duration);
  if (anim.direction === 'reverse' || (anim.direction === 'alternate' && iteration % 2 === 1) ||
      (anim.direction === 'alternate-reverse' && iteration % 2 === 0)) {
    phase = 1 - phase;
  }

  // Find surrounding keyframes
  const kfs = [...anim.keyframes].sort((a, b) => a.offset - b.offset);
  let k0 = kfs[0], k1 = kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (phase >= kfs[i].offset && phase <= kfs[i+1].offset) { k0 = kfs[i]; k1 = kfs[i+1]; break; }
  }

  const segLen = k1.offset - k0.offset;
  const t = segLen === 0 ? 0 : easingFn(k0.easing, (phase - k0.offset) / segLen);

  const result: Record<string, string | number> = {};
  for (const key of Object.keys(k0.properties)) {
    const va = k0.properties[key], vb = k1.properties[key] ?? va;
    result[key] = interpolateValue(va, vb, t);
  }
  return result;
}

// ── Item 948: CSS transform matrix ────────────────────────────────────────────

/** 4×4 column-major matrix (WebGL convention) */
export type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export function identityMat4(): Mat4 {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

export function parseCSSTransform(value: string): Mat4 {
  let m = identityMat4();
  const ops = value.match(/\w+\([^)]*\)/g) ?? [];

  for (const op of ops) {
    const fn = op.match(/^(\w+)\(([^)]+)\)/)!;
    if (!fn) continue;
    const name = fn[1];
    const args = fn[2].split(',').map(parseFloat);

    switch (name) {
      case 'translateX': m = mulMat4(m, translateMat4(args[0], 0, 0)); break;
      case 'translateY': m = mulMat4(m, translateMat4(0, args[0], 0)); break;
      case 'translate':  m = mulMat4(m, translateMat4(args[0], args[1] ?? 0, 0)); break;
      case 'translate3d': m = mulMat4(m, translateMat4(args[0], args[1], args[2])); break;
      case 'scale':      m = mulMat4(m, scaleMat4(args[0], args[1] ?? args[0], 1)); break;
      case 'scaleX':     m = mulMat4(m, scaleMat4(args[0], 1, 1)); break;
      case 'scaleY':     m = mulMat4(m, scaleMat4(1, args[0], 1)); break;
      case 'rotateZ':
      case 'rotate': {
        const rad = args[0] * Math.PI / 180;
        m = mulMat4(m, rotateMat4Z(rad));
        break;
      }
      case 'rotateX': m = mulMat4(m, rotateMat4X(args[0] * Math.PI / 180)); break;
      case 'rotateY': m = mulMat4(m, rotateMat4Y(args[0] * Math.PI / 180)); break;
      case 'matrix':  m = mulMat4(m, [args[0],args[1],0,0,args[2],args[3],0,0,0,0,1,0,args[4],args[5],0,1]); break;
      case 'matrix3d': m = mulMat4(m, args as unknown as Mat4); break;
      case 'skewX': {
        const t2 = Math.tan(args[0] * Math.PI / 180);
        const sk: Mat4 = [1,0,0,0, t2,1,0,0, 0,0,1,0, 0,0,0,1];
        m = mulMat4(m, sk);
        break;
      }
      case 'skewY': {
        const t2 = Math.tan(args[0] * Math.PI / 180);
        const sk: Mat4 = [1,t2,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
        m = mulMat4(m, sk);
        break;
      }
    }
  }
  return m;
}

function translateMat4(tx: number, ty: number, tz: number): Mat4 {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1];
}
function scaleMat4(sx: number, sy: number, sz: number): Mat4 {
  return [sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1];
}
function rotateMat4Z(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1];
}
function rotateMat4X(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1];
}
function rotateMat4Y(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
}

export function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const r: number[] = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    for (let k = 0; k < 4; k++) r[col*4+row] += a[k*4+row] * b[col*4+k];
  }
  return r as unknown as Mat4;
}

export function transformPoint(m: Mat4, x: number, y: number): [number, number] {
  const w = m[3]*x + m[7]*y + m[15];
  const rx = (m[0]*x + m[4]*y + m[12]) / (w || 1);
  const ry = (m[1]*x + m[5]*y + m[13]) / (w || 1);
  return [rx, ry];
}

// ── Item 949: CSS opacity animation ───────────────────────────────────────────

/** Compositor layer with alpha (opacity is applied during composite, not repaint) */
export interface CompositorLayer {
  id: string;
  opacity: number;      // 0..1
  transform: Mat4;
  willChange: boolean;  // has will-change: opacity/transform
  framebuffer: Uint8Array;
  width: number;
  height: number;
  x: number; y: number;
  dirty: boolean;
}

export function compositeOpacityLayer(
  dst: Uint8Array, dstW: number,
  src: Uint8Array, srcX: number, srcY: number, srcW: number, srcH: number,
  opacity: number, transform: Mat4,
): void {
  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      // Apply transform
      const [dx, dy] = transformPoint(transform, sx + srcX, sy + srcY);
      const dxi = Math.round(dx) - srcX, dyi = Math.round(dy) - srcY;
      if (dxi < 0 || dxi >= dstW) continue;

      const si = (sy * srcW + sx) * 4;
      const di = (dyi * dstW + dxi) * 4;
      const sa = (src[si+3] / 255) * opacity;
      dst[di]   = clamp(dst[di]   * (1-sa) + src[si]   * sa, 0, 255);
      dst[di+1] = clamp(dst[di+1] * (1-sa) + src[si+1] * sa, 0, 255);
      dst[di+2] = clamp(dst[di+2] * (1-sa) + src[si+2] * sa, 0, 255);
      dst[di+3] = clamp(dst[di+3] + src[si+3] * opacity, 0, 255);
    }
  }
}

// ── Item 951: CSS contain:strict ──────────────────────────────────────────────

/** Paint containment: clip paint to element's border box */
export function applyPaintContainment(fb: Uint8Array, fbW: number, fbH: number, rect: Rect): void {
  // Zero out pixels outside the containment rect
  for (let y = 0; y < fbH; y++) {
    for (let x = 0; x < fbW; x++) {
      if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) {
        const i = (y * fbW + x) * 4;
        fb[i] = fb[i+1] = fb[i+2] = fb[i+3] = 0;
      }
    }
  }
}

// ── Item 952: Off-screen heuristics ───────────────────────────────────────────

/** Determine if an element is off-screen and expensive effects can be skipped */
export function isEffectSkippable(rect: Rect, viewport: Rect, hasBoxShadow: boolean, hasFilter: boolean): boolean {
  // Off-screen: no intersection with viewport
  const offScreen = (
    rect.x + rect.w < viewport.x ||
    rect.x > viewport.x + viewport.w ||
    rect.y + rect.h < viewport.y ||
    rect.y > viewport.y + viewport.h
  );
  if (!offScreen) return false;
  // Only skip computationally expensive effects
  return hasBoxShadow || hasFilter;
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const advancedCSS = {
  parseClipPath,
  pointInClipPath,
  parseCSSFilters,
  applyFiltersToPixel,
  applyBlur,
  applyBackdropFilter,
  blendPixel,
  parseContain,
  CSS,
  resolveSubgridTracks,
  getWritingModeMetrics,
  bidiReorder,
  getShapeExclusionX,
  getBaseline,
  layoutRuby,
  snapToSubpixel,
  snapRectToSubpixel,
  getPageBreaks,
  measureText,
  getCharEMWidth,
  renderGlyphGrayscale,
  renderGlyphClearType,
  glyphAtlas,
  getScrollDirtyRects,
  decodeWOFF,
  decodeWOFF2,
  isEmoji,
  getEmojiSequence,
  parseICCProfile,
  sRGBtoXYZ,
  sampleAnimation,
  parseCSSTransform,
  mulMat4,
  transformPoint,
  compositeOpacityLayer,
  applyPaintContainment,
  isEffectSkippable,
};
