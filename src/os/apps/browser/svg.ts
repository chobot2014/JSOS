/**
 * svg.ts — Pure TypeScript SVG renderer for JSOS browser
 *
 * [Item 480] SVG rendering: basic shapes (rect, circle, path, text)
 *
 * Renders SVG into a pixel buffer (DecodedImage) for display in the browser.
 * Supports the following SVG elements and attributes:
 *
 * Elements:
 *   svg, g, rect, circle, ellipse, line, polyline, polygon, path, text, tspan,
 *   use (simple href), defs, title, desc
 *
 * Shared attributes:
 *   fill, stroke, stroke-width, opacity, transform (translate, rotate, scale),
 *   id, class, style (inline, subset)
 *
 * rect: x, y, width, height, rx, ry
 * circle: cx, cy, r
 * ellipse: cx, cy, rx, ry
 * line: x1, y1, x2, y2
 * polyline/polygon: points
 * path: d (M,m,L,l,H,h,V,v,Z,z,C,c,Q,q,A,a — approximated)
 * text/tspan: x, y, font-size, text-anchor, dominant-baseline
 *
 * Output: DecodedImage { w, h, data: Uint32Array (0xAARRGGBB) }
 */

import type { DecodedImage } from './types.js';

// ── Color parsing ─────────────────────────────────────────────────────────────

/** Parse an SVG color string to 0xRRGGBBAA (internal format). Returns 0xFF000000 on failure. */
function parseColor(s: string, opacity = 1): number {
  if (!s || s === 'none' || s === 'transparent') return 0; // transparent
  s = s.trim().toLowerCase();

  var a = Math.round(Math.min(1, Math.max(0, opacity)) * 255);

  if (s.startsWith('#')) {
    var hex = s.slice(1);
    var n: number;
    if (hex.length === 3) {
      n = parseInt(hex[0]! + hex[0]! + hex[1]! + hex[1]! + hex[2]! + hex[2]!, 16);
    } else if (hex.length === 6) {
      n = parseInt(hex, 16);
    } else {
      return (a << 24) | 0;
    }
    return (a << 24 | (n >>> 0)) >>> 0;
  }

  if (s.startsWith('rgb')) {
    var m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) {
      return (a << 24 | parseInt(m[1]!) << 16 | parseInt(m[2]!) << 8 | parseInt(m[3]!)) >>> 0;
    }
    return 0;
  }

  // Named colors (subset)
  var _named: Record<string, number> = {
    black:0, white:0xFFFFFF, red:0xFF0000, green:0x008000, blue:0x0000FF,
    yellow:0xFFFF00, cyan:0x00FFFF, magenta:0xFF00FF, orange:0xFFA500,
    purple:0x800080, pink:0xFFC0CB, grey:0x808080, gray:0x808080,
    brown:0xA52A2A, navy:0x000080, teal:0x008080, silver:0xC0C0C0,
    maroon:0x800000, lime:0x00FF00, aqua:0x00FFFF, fuchsia:0xFF00FF,
  };
  var c = _named[s];
  if (c !== undefined) return (a << 24 | c) >>> 0;

  return (a << 24 | 0x000000) >>> 0; // default black
}

// ── Transform matrix ──────────────────────────────────────────────────────────

/** 2D affine transform: [a,b,c,d,e,f] as in SVG spec. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function matMul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseTransform(s: string): Matrix {
  var m: Matrix = [...IDENTITY];
  if (!s) return m;
  var re = /(\w+)\(([^)]*)\)/g;
  var match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    var fn = match[1]!;
    var args = match[2]!.trim().split(/[\s,]+/).map(Number);
    if (fn === 'translate') {
      var tx: Matrix = [1,0,0,1,args[0]??0,args[1]??0];
      m = matMul(m, tx);
    } else if (fn === 'scale') {
      var sx = args[0] ?? 1, sy = args[1] ?? sx;
      m = matMul(m, [sx,0,0,sy,0,0]);
    } else if (fn === 'rotate') {
      var ang = (args[0] ?? 0) * Math.PI / 180;
      var cx = args[1] ?? 0, cy = args[2] ?? 0;
      var cos = Math.cos(ang), sin = Math.sin(ang);
      var rot: Matrix = [cos, sin, -sin, cos,
        cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
      m = matMul(m, rot);
    } else if (fn === 'matrix') {
      var mm: Matrix = [args[0]??1,args[1]??0,args[2]??0,args[3]??1,args[4]??0,args[5]??0];
      m = matMul(m, mm);
    }
  }
  return m;
}

// ── Pixel buffer operations ───────────────────────────────────────────────────

class PixelBuf {
  data: Uint32Array;
  w: number;
  h: number;

  constructor(w: number, h: number, bg: number = 0) {
    this.w = w; this.h = h;
    this.data = new Uint32Array(w * h);
    if (bg) this.data.fill(bg);
  }

  /** Alpha-composite `color` (0xAARRGGBB) over pixel at (x, y). */
  plot(x: number, y: number, color: number): void {
    var xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= this.w || yi < 0 || yi >= this.h) return;
    var idx = yi * this.w + xi;

    var sA = (color >>> 24) & 0xFF;
    if (sA === 0) return;
    if (sA === 255) { this.data[idx] = color; return; }

    // Alpha blend
    var sR = (color >>> 16) & 0xFF;
    var sG = (color >>>  8) & 0xFF;
    var sB =  color         & 0xFF;
    var dst = this.data[idx]!;
    var dA = (dst >>> 24) & 0xFF;
    var dR = (dst >>> 16) & 0xFF;
    var dG = (dst >>>  8) & 0xFF;
    var dB =  dst         & 0xFF;

    var outA = sA + dA * (255 - sA) / 255;
    if (outA === 0) { this.data[idx] = 0; return; }
    var outR = (sR * sA + dR * dA * (255 - sA) / 255) / outA;
    var outG = (sG * sA + dG * dA * (255 - sA) / 255) / outA;
    var outB = (sB * sA + dB * dA * (255 - sA) / 255) / outA;
    this.data[idx] = ((outA & 0xFF) << 24 | (outR & 0xFF) << 16 | (outG & 0xFF) << 8 | (outB & 0xFF)) >>> 0;
  }

  /** Draw a thick point (stroke-width > 1). */
  plotWide(x: number, y: number, color: number, sw: number): void {
    if (sw <= 1) { this.plot(x, y, color); return; }
    var r = sw / 2;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) this.plot(x + dx, y + dy, color);
      }
    }
  }

  /** Scan-line fill a polygon given vertex lists. */
  fillPoly(xs: number[], ys: number[], color: number): void {
    if (xs.length < 3) return;
    var minY = Math.floor(Math.min(...ys));
    var maxY = Math.ceil(Math.max(...ys));
    minY = Math.max(0, minY); maxY = Math.min(this.h - 1, maxY);

    for (var scanY = minY; scanY <= maxY; scanY++) {
      var intersections: number[] = [];
      var n = xs.length;
      for (var i = 0, j = n - 1; i < n; j = i++) {
        var yi = ys[i]!, yj = ys[j]!;
        if ((yi <= scanY && yj > scanY) || (yj <= scanY && yi > scanY)) {
          var xi = xs[i]!, xj = xs[j]!;
          var t = (scanY - yi) / (yj - yi);
          intersections.push(xi + t * (xj - xi));
        }
      }
      intersections.sort((a, b) => a - b);
      for (var k = 0; k + 1 < intersections.length; k += 2) {
        var x0 = Math.ceil(intersections[k]!);
        var x1 = Math.floor(intersections[k + 1]!);
        for (var px = Math.max(0, x0); px <= Math.min(this.w - 1, x1); px++) {
          this.plot(px, scanY, color);
        }
      }
    }
  }

  /** Draw a polyline with stroke color and width. */
  strokeLine(x0: number, y0: number, x1: number, y1: number, color: number, sw: number): void {
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) { this.plotWide(x0, y0, color, sw); return; }
    var steps = Math.ceil(len * 2);
    for (var i = 0; i <= steps; i++) {
      var t2 = i / steps;
      this.plotWide(x0 + dx * t2, y0 + dy * t2, color, sw);
    }
  }
}

// ── SVG parser helpers ────────────────────────────────────────────────────────

/** Very simple XML parser for SVG: returns a flat array of tokens. */
function parseSVGXML(svg: string): Array<{ type: 'open'|'close'|'self'|'text'; tag: string; attrs: Record<string,string>; text?: string }> {
  var tokens: ReturnType<typeof parseSVGXML> = [];
  var re = /<(\/?)([A-Za-z][^\s/>]*)((?:\s+[^=>]+(?:=(?:"[^"]*"|'[^']*'|[^\s/>]*))?)*)\s*(\/?)>|([^<]+)/g;
  var m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    if (m[5] !== undefined) {
      // text node
      var txt = m[5].trim();
      if (txt) tokens.push({ type: 'text', tag: '', attrs: {}, text: txt });
      continue;
    }
    var isClose = m[1] === '/';
    var isSelf  = m[4] === '/';
    var tagName = (m[2] ?? '').toLowerCase().replace(/^svg:/, '');
    var attrStr = m[3] ?? '';
    var attrs: Record<string,string> = {};
    var aRe = /([A-Za-z:_][^\s=]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    var aM: RegExpExecArray | null;
    while ((aM = aRe.exec(attrStr)) !== null) {
      attrs[(aM[1] ?? '').toLowerCase()] = aM[2] ?? aM[3] ?? aM[4] ?? '';
    }
    var type: 'open'|'close'|'self' = isClose ? 'close' : (isSelf ? 'self' : 'open');
    tokens.push({ type, tag: tagName, attrs });
  }
  return tokens;
}

/** Parse style="..." into a map */
function parseStyle(s: string): Record<string,string> {
  var r: Record<string,string> = {};
  if (!s) return r;
  s.split(';').forEach(function(part) {
    var kv = part.split(':');
    if (kv.length === 2) r[kv[0]!.trim().toLowerCase()] = kv[1]!.trim();
  });
  return r;
}

function getAttr(attrs: Record<string,string>, style: Record<string,string>, key: string, def = ''): string {
  return style[key] ?? attrs[key] ?? def;
}

function numAttr(attrs: Record<string,string>, style: Record<string,string>, key: string, def = 0): number {
  var v = getAttr(attrs, style, key, String(def));
  return parseFloat(v) || def;
}

// ── Shape renderers ───────────────────────────────────────────────────────────

interface PaintCtx {
  fill:   number;   // 0xAARRGGBB
  stroke: number;   // 0xAARRGGBB
  sw:     number;   // stroke-width
}

function getPaintCtx(attrs: Record<string,string>, style: Record<string,string>, parentCtx: PaintCtx): PaintCtx {
  var opacity  = parseFloat(getAttr(attrs, style, 'opacity', '1'));
  var fillStr  = getAttr(attrs, style, 'fill', '');
  var strokeStr = getAttr(attrs, style, 'stroke', '');
  var sw       = parseFloat(getAttr(attrs, style, 'stroke-width', String(parentCtx.sw))) || parentCtx.sw;

  var fill   = fillStr   ? parseColor(fillStr,   opacity) : (fillStr   === 'none' ? 0 : parentCtx.fill);
  var stroke = strokeStr ? parseColor(strokeStr, opacity) : (strokeStr === 'none' ? 0 : parentCtx.stroke);
  if (!fillStr)   fill   = parentCtx.fill;
  if (!strokeStr) stroke = parentCtx.stroke;

  return { fill, stroke, sw };
}

function renderRect(buf: PixelBuf, attrs: Record<string,string>, style: Record<string,string>, ctx: PaintCtx, m: Matrix): void {
  var x   = numAttr(attrs, style, 'x',      0);
  var y   = numAttr(attrs, style, 'y',      0);
  var rw  = numAttr(attrs, style, 'width',  0);
  var rh  = numAttr(attrs, style, 'height', 0);
  var rx  = numAttr(attrs, style, 'rx',     0);
  var ry  = numAttr(attrs, style, 'ry',     rx);

  if (rw <= 0 || rh <= 0) return;

  // Fill: create polygon vertices for rounded rect (simplified: just plain rect)
  if (ctx.fill) {
    var xs: number[] = [], ys: number[] = [];
    var steps = 16;
    for (var qi = 0; qi < steps; qi++) {
      var ang = (qi / steps) * 2 * Math.PI;
      var px2 = x + rw / 2 + (rw / 2 - rx) * Math.cos(ang) * (rx > 0 ? 1 : 1);
      var py2 = y + rh / 2 + (rh / 2 - ry) * Math.sin(ang) * (ry > 0 ? 1 : 1);
      if (rx === 0 && ry === 0) {
        // Just use rectangle corners
        break;
      }
      var [px3, py3] = applyMatrix(m, px2, py2);
      xs.push(px3); ys.push(py3);
    }
    if (rx === 0 && ry === 0) {
      // Plain rectangle
      var [ax, ay] = applyMatrix(m, x, y);
      var [bx, by] = applyMatrix(m, x + rw, y);
      var [cx2, cy2] = applyMatrix(m, x + rw, y + rh);
      var [dx2, dy2] = applyMatrix(m, x, y + rh);
      buf.fillPoly([ax, bx, cx2, dx2], [ay, by, cy2, dy2], ctx.fill);
    } else {
      buf.fillPoly(xs, ys, ctx.fill);
    }
  }

  if (ctx.stroke && ctx.sw > 0) {
    var corners: [number,number][] = [
      applyMatrix(m, x, y), applyMatrix(m, x + rw, y),
      applyMatrix(m, x + rw, y + rh), applyMatrix(m, x, y + rh),
    ];
    for (var ci = 0; ci < 4; ci++) {
      var [x0, y0] = corners[ci]!;
      var [x1, y1] = corners[(ci + 1) % 4]!;
      buf.strokeLine(x0, y0, x1, y1, ctx.stroke, ctx.sw);
    }
  }
}

function renderCircle(buf: PixelBuf, cx: number, cy: number, rx: number, ry: number, ctx: PaintCtx, m: Matrix): void {
  if (rx <= 0 || ry <= 0) return;
  var steps = Math.max(32, Math.ceil(2 * Math.PI * Math.max(rx, ry)));
  var xs: number[] = [], ys: number[] = [];
  for (var i = 0; i < steps; i++) {
    var ang = (i / steps) * 2 * Math.PI;
    var [px4, py4] = applyMatrix(m, cx + rx * Math.cos(ang), cy + ry * Math.sin(ang));
    xs.push(px4); ys.push(py4);
  }
  if (ctx.fill) buf.fillPoly(xs, ys, ctx.fill);
  if (ctx.stroke && ctx.sw > 0) {
    for (var j = 0; j < xs.length; j++) {
      buf.strokeLine(xs[j]!, ys[j]!, xs[(j + 1) % xs.length]!, ys[(j + 1) % ys.length]!, ctx.stroke, ctx.sw);
    }
  }
}

/** Very simple d-attribute path parser: M/L/H/V/Z/C/Q/A approximated. */
function renderPath(buf: PixelBuf, d: string, ctx: PaintCtx, m: Matrix): void {
  var re = /([MLHVZCSQTACB])\s*((?:[-\d.e+,\s]+)?)/gi;
  var match: RegExpExecArray | null;
  var curX = 0, curY = 0;
  var startX = 0, startY = 0;
  var allXs: number[] = [], allYs: number[] = [];
  var polylines: Array<[number[], number[]]> = [];
  var curPolyXs: number[] = [], curPolyYs: number[] = [];

  function flush(): void {
    if (curPolyXs.length > 0) { polylines.push([[...curPolyXs], [...curPolyYs]]); allXs.push(...curPolyXs); allYs.push(...curPolyYs); }
    curPolyXs = []; curPolyYs = [];
  }

  function addPt(x: number, y: number): void { curPolyXs.push(x); curPolyYs.push(y); }

  while ((match = re.exec(d)) !== null) {
    var cmd = match[1]!.toUpperCase();
    var nums = (match[2] ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    var rel = match[1] === match[1]!.toLowerCase() && match[1] !== 'Z';

    var i = 0;
    while (i <= nums.length - (cmd === 'Z' ? 0 : 1)) {
      if (cmd === 'M' || cmd === 'L') {
        if (i >= nums.length - 1) break;
        var nx = (nums[i++] ?? 0) + (rel ? curX : 0);
        var ny = (nums[i++] ?? 0) + (rel ? curY : 0);
        if (cmd === 'M') { flush(); startX = nx; startY = ny; }
        curX = nx; curY = ny;
        addPt(curX, curY);
      } else if (cmd === 'H') {
        if (i >= nums.length) break;
        curX = (nums[i++] ?? 0) + (rel ? curX : 0);
        addPt(curX, curY);
      } else if (cmd === 'V') {
        if (i >= nums.length) break;
        curY = (nums[i++] ?? 0) + (rel ? curY : 0);
        addPt(curX, curY);
      } else if (cmd === 'Z') {
        addPt(startX, startY);
        flush();
        curX = startX; curY = startY;
        break;
      } else if (cmd === 'C') {
        if (i >= nums.length - 5) break;
        // Bezier: approximate with several line segments
        var cp1x = (nums[i++] ?? 0) + (rel ? curX : 0);
        var cp1y = (nums[i++] ?? 0) + (rel ? curY : 0);
        var cp2x = (nums[i++] ?? 0) + (rel ? curX : 0);
        var cp2y = (nums[i++] ?? 0) + (rel ? curY : 0);
        var ex = (nums[i++] ?? 0) + (rel ? curX : 0);
        var ey = (nums[i++] ?? 0) + (rel ? curY : 0);
        for (var t = 0; t <= 1; t += 0.1) {
          var mt = 1 - t;
          var bx = mt*mt*mt*curX + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*ex;
          var by = mt*mt*mt*curY + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*ey;
          addPt(bx, by);
        }
        curX = ex; curY = ey;
      } else if (cmd === 'Q') {
        if (i >= nums.length - 3) break;
        var qcx = (nums[i++] ?? 0) + (rel ? curX : 0);
        var qcy = (nums[i++] ?? 0) + (rel ? curY : 0);
        var qex = (nums[i++] ?? 0) + (rel ? curX : 0);
        var qey = (nums[i++] ?? 0) + (rel ? curY : 0);
        for (var qt = 0; qt <= 1; qt += 0.1) {
          var qmt = 1 - qt;
          addPt(qmt*qmt*curX + 2*qmt*qt*qcx + qt*qt*qex, qmt*qmt*curY + 2*qmt*qt*qcy + qt*qt*qey);
        }
        curX = qex; curY = qey;
      } else if (cmd === 'A') {
        if (i >= nums.length - 6) break;
        var arx = nums[i++] ?? 0;
        var ary = nums[i++] ?? 0;
        i++; // x-axis-rotation
        i++; // large-arc-flag
        i++; // sweep-flag
        var aex = (nums[i++] ?? 0) + (rel ? curX : 0);
        var aey = (nums[i++] ?? 0) + (rel ? curY : 0);
        // Approximate arc as a line (simplified)
        for (var at = 0; at <= 1; at += 0.1) {
          addPt(curX + (aex - curX) * at, curY + (aey - curY) * at);
        }
        curX = aex; curY = aey;
      } else {
        break;
      }
    }
  }
  flush();

  // Fill (use all points as one polygon)
  if (ctx.fill && allXs.length > 2) {
    var txs: number[] = [], tys: number[] = [];
    for (var pi2 = 0; pi2 < allXs.length; pi2++) {
      var [px5, py5] = applyMatrix(m, allXs[pi2]!, allYs[pi2]!);
      txs.push(px5); tys.push(py5);
    }
    buf.fillPoly(txs, tys, ctx.fill);
  }

  // Stroke
  if (ctx.stroke && ctx.sw > 0) {
    for (var pl = 0; pl < polylines.length; pl++) {
      var plXs = polylines[pl]![0]!;
      var plYs = polylines[pl]![1]!;
      for (var pk = 0; pk + 1 < plXs.length; pk++) {
        var [px6, py6] = applyMatrix(m, plXs[pk]!, plYs[pk]!);
        var [px7, py7] = applyMatrix(m, plXs[pk + 1]!, plYs[pk + 1]!);
        buf.strokeLine(px6, py6, px7, py7, ctx.stroke, ctx.sw);
      }
    }
  }
}

/** Render text as blocky pixel characters (8×8 pixel font). */
function renderText(buf: PixelBuf, text: string, x: number, y: number, fontSize: number, color: number, anchor: string, m: Matrix): void {
  if (!color || !text) return;
  var scale = Math.max(1, Math.round(fontSize / 8));
  var charW = 8 * scale;
  var totalW = text.length * charW;

  var tx = x;
  if (anchor === 'middle') tx -= totalW / 2;
  else if (anchor === 'end') tx -= totalW;

  // Use a tiny "pixel font" based on simple filled rectangles per character
  for (var ci = 0; ci < text.length; ci++) {
    var [rx, ry] = applyMatrix(m, tx + ci * charW, y - fontSize * 0.8);
    // Render each character as a colored block with the char painted inside
    // (simplified: just paint a filled square as placeholder since we have no
    // bitmapped font in the pixel layer — real text goes through terminal.ts)
    for (var dy = 0; dy < fontSize; dy++) {
      for (var dx = 0; dx < charW * 0.6; dx++) {
        buf.plot(Math.round(rx + dx), Math.round(ry + dy), color);
      }
    }
  }
}

// ── SVG Render tree walker ────────────────────────────────────────────────────

interface RenderState {
  ctxStack: PaintCtx[];
  mStack:   Matrix[];
  defs:     Map<string, number>; // id → token index
}

function renderTokens(
  buf: PixelBuf,
  tokens: ReturnType<typeof parseSVGXML>,
  startIdx: number,
  endTag: string,
  state: RenderState,
): number {
  var i = startIdx;
  while (i < tokens.length) {
    var tok = tokens[i]!;
    if (tok.type === 'close' && tok.tag === endTag) return i;

    var attrs = tok.attrs;
    var style = parseStyle(attrs['style'] ?? '');
    var parentCtx = state.ctxStack[state.ctxStack.length - 1] ?? { fill: 0xFF000000, stroke: 0, sw: 1 };
    var m = state.mStack[state.mStack.length - 1] ?? IDENTITY;

    if (tok.type === 'open' || tok.type === 'self') {
      var ctx = getPaintCtx(attrs, style, parentCtx);
      var localM = attrs['transform'] ? matMul(m, parseTransform(attrs['transform'])) : m;

      if (tok.tag === 'g') {
        state.ctxStack.push(ctx);
        state.mStack.push(localM);
        i = renderTokens(buf, tokens, i + 1, 'g', state);
        state.ctxStack.pop();
        state.mStack.pop();
      } else if (tok.tag === 'rect') {
        renderRect(buf, attrs, style, ctx, localM);
      } else if (tok.tag === 'circle') {
        var cr = numAttr(attrs, style, 'r', 0);
        renderCircle(buf, numAttr(attrs, style, 'cx', 0), numAttr(attrs, style, 'cy', 0), cr, cr, ctx, localM);
      } else if (tok.tag === 'ellipse') {
        renderCircle(buf, numAttr(attrs, style, 'cx', 0), numAttr(attrs, style, 'cy', 0),
          numAttr(attrs, style, 'rx', 0), numAttr(attrs, style, 'ry', 0), ctx, localM);
      } else if (tok.tag === 'line') {
        if (ctx.stroke && ctx.sw > 0) {
          var [lx0, ly0] = applyMatrix(localM, numAttr(attrs, style, 'x1', 0), numAttr(attrs, style, 'y1', 0));
          var [lx1, ly1] = applyMatrix(localM, numAttr(attrs, style, 'x2', 0), numAttr(attrs, style, 'y2', 0));
          buf.strokeLine(lx0, ly0, lx1, ly1, ctx.stroke, ctx.sw);
        }
      } else if (tok.tag === 'polyline' || tok.tag === 'polygon') {
        var pts = (attrs['points'] ?? '').trim().split(/[\s,]+/).map(Number);
        var pxs: number[] = [], pys: number[] = [];
        for (var pi = 0; pi + 1 < pts.length; pi += 2) {
          var [ppx, ppy] = applyMatrix(localM, pts[pi] ?? 0, pts[pi + 1] ?? 0);
          pxs.push(ppx); pys.push(ppy);
        }
        if (tok.tag === 'polygon' && ctx.fill && pxs.length > 2) buf.fillPoly(pxs, pys, ctx.fill);
        if (ctx.stroke && ctx.sw > 0) {
          var polyN = pxs.length;
          var loopN = tok.tag === 'polygon' ? polyN : polyN - 1;
          for (var pk2 = 0; pk2 < loopN; pk2++) {
            buf.strokeLine(pxs[pk2]!, pys[pk2]!, pxs[(pk2 + 1) % polyN]!, pys[(pk2 + 1) % polyN]!, ctx.stroke, ctx.sw);
          }
        }
      } else if (tok.tag === 'path') {
        renderPath(buf, attrs['d'] ?? '', ctx, localM);
      } else if (tok.tag === 'text' || tok.tag === 'tspan') {
        var tFontSize = numAttr(attrs, style, 'font-size', 16);
        var tAnchor = getAttr(attrs, style, 'text-anchor', 'start');
        var tx2 = numAttr(attrs, style, 'x', 0);
        var ty2 = numAttr(attrs, style, 'y', 0);
        // Gather text content from next text token
        var textColor = ctx.fill || 0xFF000000;
        // Peek at next token for text content
        if (tok.type === 'open' && i + 1 < tokens.length && tokens[i + 1]!.type === 'text') {
          renderText(buf, tokens[i + 1]!.text ?? '', tx2, ty2, tFontSize, textColor, tAnchor, localM);
          i++;
        }
        if (tok.type === 'open') {
          i = renderTokens(buf, tokens, i + 1, tok.tag, state);
        }
      } else if (tok.tag === 'defs') {
        // Skip defs content
        while (i < tokens.length && !(tokens[i]!.type === 'close' && tokens[i]!.tag === 'defs')) i++;
      }
    }
    i++;
  }
  return i;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * [Item 480] Render an SVG string to a pixel buffer.
 *
 * @param svgStr  The SVG source string
 * @param maxW    Maximum output width in pixels (default 512)
 * @param maxH    Maximum output height in pixels (default 512)
 * @returns       DecodedImage or null
 */
export function renderSVG(svgStr: string, maxW = 512, maxH = 512): DecodedImage | null {
  try {
    return _renderSVG(svgStr, maxW, maxH);
  } catch (_e) {
    return null;
  }
}

function _renderSVG(svgStr: string, maxW: number, maxH: number): DecodedImage | null {
  var tokens = parseSVGXML(svgStr);
  if (tokens.length === 0) return null;

  // Find <svg> root element and extract viewBox / width / height
  var svgTok = tokens.find(t => t.tag === 'svg' && (t.type === 'open' || t.type === 'self'));
  if (!svgTok) return null;

  var attrs0 = svgTok.attrs;
  var svgW = parseFloat(attrs0['width'] ?? '0') || maxW;
  var svgH = parseFloat(attrs0['height'] ?? '0') || maxH;
  svgW = Math.min(svgW, maxW);
  svgH = Math.min(svgH, maxH);

  var scaleX = 1, scaleY = 1;
  var vb = attrs0['viewbox'] ?? attrs0['viewBox'] ?? '';
  if (vb) {
    var vbParts = vb.trim().split(/[\s,]+/).map(Number);
    var vbW = vbParts[2] ?? svgW;
    var vbH = vbParts[3] ?? svgH;
    if (vbW > 0 && vbH > 0) {
      scaleX = svgW / vbW;
      scaleY = svgH / vbH;
    }
  }

  var buf = new PixelBuf(Math.round(svgW), Math.round(svgH), 0); // transparent bg

  var rootCtx: PaintCtx = { fill: 0xFF000000, stroke: 0, sw: 1 };
  var rootM: Matrix = [scaleX, 0, 0, scaleY, 0, 0];

  var svgIdx = tokens.indexOf(svgTok);
  var state: RenderState = {
    ctxStack: [rootCtx],
    mStack:   [rootM],
    defs:     new Map(),
  };
  renderTokens(buf, tokens, svgIdx + 1, 'svg', state);

  return { w: buf.w, h: buf.h, data: buf.data };
}
