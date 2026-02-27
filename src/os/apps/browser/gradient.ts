/**
 * gradient.ts — CSS Gradient parser and software rasteriser
 *
 * Implements (item 487):
 *  - linear-gradient()  with angle or directional keywords
 *  - radial-gradient()  (ellipse/circle with closest-side/farthest-corner)
 *  - conic-gradient()   with from-angle and colour stops
 *  - repeating-linear-gradient() / repeating-radial-gradient()
 *
 * Rendering strategy:
 *   For linear gradients   → one canvas.fillRect() call per scan-line (h calls).
 *   For radial/conic       → per-pixel via canvas.setPixel().
 *   All colour-stop interpolation done in linear sRGB (approximate).
 *
 * @module gradient
 */

import { parseCSSColor } from './css.js';
import type { Canvas } from '../../ui/canvas.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ColorStop {
  color: number;    // ARGB
  pos:   number;    // 0.0–1.0 (normalised)
}

type GradientKind =
  | 'linear' | 'radial' | 'conic'
  | 'repeating-linear' | 'repeating-radial';

interface ParsedGradient {
  kind:     GradientKind;
  angle:    number;            // degrees (linear)
  cx:       number;            // 0.0–1.0 centre x (radial/conic)
  cy:       number;            // 0.0–1.0 centre y (radial/conic)
  shape:    'circle' | 'ellipse';
  stops:    ColorStop[];
  repeating: boolean;
}

// ── CSS gradient detector ─────────────────────────────────────────────────────

/** Returns true if `val` is any CSS gradient function. */
export function isGradient(val: string): boolean {
  return /^(repeating-)?(linear|radial|conic)-gradient\s*\(/i.test(val.trim());
}

// ── Tokeniser helpers ─────────────────────────────────────────────────────────

/**
 * Split the top-level comma-delimited arguments of a function call,
 * respecting nested parentheses.
 */
function splitArgs(inner: string): string[] {
  var result: string[] = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < inner.length; i++) {
    var ch = inner[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      result.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  var last = inner.slice(start).trim();
  if (last) result.push(last);
  return result;
}

/** Parse `NNNdeg`, `NNNgrad`, `NNNrad`, `NNNturn` → degrees. */
function parseAngleDeg(s: string): number {
  s = s.trim();
  var m: RegExpMatchArray | null;
  if ((m = s.match(/^(-?[\d.]+)deg$/i)))   return parseFloat(m[1]);
  if ((m = s.match(/^(-?[\d.]+)grad$/i)))  return parseFloat(m[1]) * 0.9;
  if ((m = s.match(/^(-?[\d.]+)rad$/i)))   return parseFloat(m[1]) * 180 / Math.PI;
  if ((m = s.match(/^(-?[\d.]+)turn$/i)))  return parseFloat(m[1]) * 360;
  return parseFloat(s) || 0;
}

/** Parse a percentage string like "30%" → 0.30, or a plain number. */
function parsePct(s: string, total: number): number {
  s = s.trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  return parseFloat(s) / total;
}

// ── Colour stop parser ────────────────────────────────────────────────────────

/**
 * Parse an array of raw stop strings into colour-stop records.
 * Handles missing positions (evenly distributed) and "hint" stops (ignored).
 */
function parseStops(rawStops: string[]): ColorStop[] {
  var stops: Array<{ color: number; pos: number | null }> = [];

  for (var i = 0; i < rawStops.length; i++) {
    var raw = rawStops[i].trim();
    // Try to split: first token may be a colour, rest are positions
    // Colours: rgb(...), hsl(...), hex, named — parse greedily
    var colEnd = 0;
    // Find where the colour ends — after balanced parens
    if (raw[0] === '#' || /^[a-zA-Z]/.test(raw)) {
      // named or hex or function
      if (raw.includes('(')) {
        var depth = 0;
        for (var j = 0; j < raw.length; j++) {
          if (raw[j] === '(') depth++;
          else if (raw[j] === ')') { depth--; if (depth === 0) { colEnd = j + 1; break; } }
        }
      } else {
        // word token (named colour or percent/px position)
        var tok = raw.split(/\s+/)[0];
        colEnd = tok.length;
      }
    }

    var colorStr = raw.slice(0, colEnd || raw.length).trim();
    var rest     = raw.slice(colEnd).trim();

    var parsed = parseCSSColor(colorStr);
    if (parsed === null) continue;

    // rest may be "30%" or "100px" (one or two positions)
    var posParts = rest ? rest.split(/\s+/).filter(Boolean) : [];
    if (posParts.length === 0) {
      stops.push({ color: parsed, pos: null });
    } else {
      // Handle multiple positions per stop (CSS4): "red 20% 40%"
      // means two stops: red at 20% and red at 40%
      for (var p = 0; p < posParts.length; p++) {
        var pp = posParts[p];
        var posVal: number | null = null;
        if (pp.endsWith('%'))  posVal = parseFloat(pp) / 100;
        else if (pp.endsWith('px')) posVal = null; // handled at render time
        stops.push({ color: parsed, pos: posVal });
      }
    }
  }

  // Distribute null positions evenly
  var n = stops.length;
  if (n === 0) return [];
  if (stops[0].pos === null)     stops[0].pos = 0;
  if (stops[n - 1].pos === null) stops[n - 1].pos = 1;

  // Fill in missing positions linearly between known anchors
  var i2 = 0;
  while (i2 < n) {
    if (stops[i2].pos !== null) { i2++; continue; }
    // Find next known position
    var j2 = i2 + 1;
    while (j2 < n && stops[j2].pos === null) j2++;
    var p0 = stops[i2 - 1].pos!;
    var p1 = stops[j2 < n ? j2 : n - 1].pos!;
    var count = j2 - i2 + 1;
    for (var k = i2; k < j2; k++) {
      stops[k].pos = p0 + (p1 - p0) * (k - i2 + 1) / count;
    }
    i2 = j2 + 1;
  }

  return stops.map(s => ({ color: s.color, pos: s.pos! }));
}

// ── Gradient string parser ────────────────────────────────────────────────────

/**
 * Parse a CSS gradient string into a structured `ParsedGradient`.
 * Returns null on parse failure.
 */
export function parseGradient(val: string): ParsedGradient | null {
  val = val.trim();

  // Identify kind
  var kindMatch = val.match(/^(repeating-)?(linear|radial|conic)-gradient\s*\(/i);
  if (!kindMatch) return null;

  var repeating = !!kindMatch[1];
  var kindStr   = kindMatch[2].toLowerCase() as 'linear' | 'radial' | 'conic';
  var kind: GradientKind = repeating ? (`repeating-${kindStr}` as GradientKind) : kindStr;

  // Extract inner args: find matching closing paren
  var openIdx = val.indexOf('(');
  if (openIdx < 0) return null;
  var inner = '';
  var depth = 0;
  for (var i = openIdx; i < val.length; i++) {
    if (val[i] === '(') depth++;
    else if (val[i] === ')') {
      depth--;
      if (depth === 0) { inner = val.slice(openIdx + 1, i); break; }
    }
  }

  var args = splitArgs(inner);

  // ── linear-gradient ───────────────────────────────────────────────────────
  if (kindStr === 'linear') {
    var angle = 180; // default: top→bottom
    var stopStart = 0;

    var first = args[0] ? args[0].trim() : '';
    if (/^to\s/i.test(first)) {
      // to top/bottom/left/right/top left/etc.
      if (/right/i.test(first))  angle = 90;
      else if (/left/i.test(first)) angle = 270;
      else if (/top/i.test(first) && !/bottom/i.test(first)) angle = 0;
      else if (/bottom/i.test(first) && !/top/i.test(first)) angle = 180;
      else if (/top.*right|right.*top/i.test(first)) angle = 45;
      else if (/bottom.*right|right.*bottom/i.test(first)) angle = 135;
      else if (/top.*left|left.*top/i.test(first)) angle = 315;
      else if (/bottom.*left|left.*bottom/i.test(first)) angle = 225;
      stopStart = 1;
    } else if (/deg|grad|rad|turn/i.test(first) || /^-?[\d.]+$/.test(first)) {
      angle = parseAngleDeg(first);
      stopStart = 1;
    }

    var stops = parseStops(args.slice(stopStart));
    return { kind, angle, cx: 0.5, cy: 0.5, shape: 'ellipse', stops, repeating };
  }

  // ── radial-gradient ───────────────────────────────────────────────────────
  if (kindStr === 'radial') {
    var cx = 0.5, cy = 0.5;
    var shape: 'circle' | 'ellipse' = 'ellipse';
    var stopStart2 = 0;

    var first2 = args[0] ? args[0].trim() : '';
    // Check for shape/size/position prefix (e.g. "circle at 50% 50%")
    var atMatch = first2.match(/^(.*?)\s+at\s+(.*?)$/i);
    if (atMatch || /^circle|ellipse/i.test(first2) || /^closest|farthest/i.test(first2)) {
      stopStart2 = 1;
      if (atMatch) {
        var shapeStr = atMatch[1].trim();
        var posStr   = atMatch[2].trim();
        if (/circle/i.test(shapeStr)) shape = 'circle';
        // Parse position
        var posParts = posStr.split(/\s+/);
        if (posParts.length >= 2) {
          cx = posParts[0].endsWith('%') ? parseFloat(posParts[0]) / 100 : 0.5;
          cy = posParts[1].endsWith('%') ? parseFloat(posParts[1]) / 100 : 0.5;
        } else if (posParts.length === 1) {
          cx = parseFloat(posParts[0]) / 100; cy = cx;
        }
      } else if (/circle/i.test(first2)) {
        shape = 'circle';
      }
    }

    var stops2 = parseStops(args.slice(stopStart2));
    return { kind, angle: 0, cx, cy, shape, stops: stops2, repeating };
  }

  // ── conic-gradient ────────────────────────────────────────────────────────
  if (kindStr === 'conic') {
    var angle3 = 0;
    var cx3 = 0.5, cy3 = 0.5;
    var stopStart3 = 0;

    var first3 = args[0] ? args[0].trim() : '';
    // "from <angle>" or "at <position>" or "from <angle> at <position>"
    var fromMatch = first3.match(/^from\s+(.+?)(?:\s+at\s+(.+))?$/i);
    var atOnlyMatch = first3.match(/^at\s+(.+)$/i);
    if (fromMatch || atOnlyMatch) {
      stopStart3 = 1;
      if (fromMatch) {
        angle3 = parseAngleDeg(fromMatch[1].trim());
        if (fromMatch[2]) {
          var pp3 = fromMatch[2].trim().split(/\s+/);
          if (pp3.length >= 2) {
            cx3 = pp3[0].endsWith('%') ? parseFloat(pp3[0]) / 100 : 0.5;
            cy3 = pp3[1].endsWith('%') ? parseFloat(pp3[1]) / 100 : 0.5;
          }
        }
      } else if (atOnlyMatch) {
        var pp4 = atOnlyMatch[1].trim().split(/\s+/);
        if (pp4.length >= 2) {
          cx3 = pp4[0].endsWith('%') ? parseFloat(pp4[0]) / 100 : 0.5;
          cy3 = pp4[1].endsWith('%') ? parseFloat(pp4[1]) / 100 : 0.5;
        }
      }
    }

    var stops3 = parseStops(args.slice(stopStart3));
    return { kind, angle: angle3, cx: cx3, cy: cy3, shape: 'ellipse', stops: stops3, repeating };
  }

  return null;
}

// ── Colour interpolation ──────────────────────────────────────────────────────

/** Sample colour at normalised position t ∈ [0,1] given colour stops. */
function sampleStops(stops: ColorStop[], t: number): number {
  if (stops.length === 0) return 0xFF888888;
  if (t <= stops[0].pos)  return stops[0].color;
  if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;

  for (var i = 0; i < stops.length - 1; i++) {
    var a = stops[i], b = stops[i + 1];
    if (t >= a.pos && t <= b.pos) {
      var f = (t - a.pos) / (b.pos - a.pos || 1);
      return lerpARGB(a.color, b.color, f);
    }
  }
  return stops[stops.length - 1].color;
}

function lerpARGB(a: number, b: number, t: number): number {
  var aa = (a >>> 24) & 0xFF, ra = (a >>> 16) & 0xFF, ga = (a >>> 8) & 0xFF, ba2 = a & 0xFF;
  var ab = (b >>> 24) & 0xFF, rb = (b >>> 16) & 0xFF, gb = (b >>> 8) & 0xFF, bb2 = b & 0xFF;
  var A = aa + (ab - aa) * t | 0;
  var R = ra + (rb - ra) * t | 0;
  var G = ga + (gb - ga) * t | 0;
  var B = ba2 + (bb2 - ba2) * t | 0;
  return ((A << 24) | (R << 16) | (G << 8) | B) >>> 0;
}

function normT(t: number, repeating: boolean): number {
  if (!repeating) return Math.max(0, Math.min(1, t));
  t = t % 1;
  return t < 0 ? t + 1 : t;
}

// ── Rasterisers ───────────────────────────────────────────────────────────────

/**
 * Render any CSS gradient into the canvas area [x, y, w, h].
 *
 * @param canvas   Target canvas
 * @param x        Left edge (px)
 * @param y        Top edge (px)
 * @param w        Width (px)
 * @param h        Height (px)
 * @param gradient Parsed gradient
 */
export function renderGradient(
  canvas: Canvas,
  x: number, y: number, w: number, h: number,
  gradient: ParsedGradient,
): void {
  if (w <= 0 || h <= 0 || gradient.stops.length === 0) return;

  var { stops, repeating } = gradient;

  if (gradient.kind === 'linear' || gradient.kind === 'repeating-linear') {
    _renderLinear(canvas, x, y, w, h, gradient.angle, stops, repeating);
  } else if (gradient.kind === 'radial' || gradient.kind === 'repeating-radial') {
    _renderRadial(canvas, x, y, w, h, gradient.cx, gradient.cy, gradient.shape, stops, repeating);
  } else {
    // conic
    _renderConic(canvas, x, y, w, h, gradient.angle, gradient.cx, gradient.cy, stops, repeating);
  }
}

/**
 * Convenience: parse and render a gradient CSS value string.
 * Returns false if the value is not a gradient.
 */
export function renderGradientCSS(
  canvas: Canvas,
  x: number, y: number, w: number, h: number,
  val: string,
): boolean {
  if (!isGradient(val)) return false;
  var g = parseGradient(val);
  if (!g) return false;
  renderGradient(canvas, x, y, w, h, g);
  return true;
}

// ── Linear gradient rasteriser ────────────────────────────────────────────────

function _renderLinear(
  canvas: Canvas,
  x: number, y: number, w: number, h: number,
  angleDeg: number,
  stops: ColorStop[],
  repeating: boolean,
): void {
  // Convert angle to radians. CSS 0° = top, clockwise.
  // We need the gradient-line direction.
  var a = ((angleDeg - 90) * Math.PI) / 180;
  var cos = Math.cos(a), sin = Math.sin(a);

  // The gradient line passes through the centre of the box.
  // Length of the gradient line = |W*cos| + |H*sin| (bounding-box formula)
  var lineLen = Math.abs(w * cos) + Math.abs(h * sin);
  if (lineLen < 1) lineLen = 1;

  // For each scan line, compute the average t for the scan line's centre
  // (linear gradients are uniform across perpendicular lines, so per-row
  // is exact for horizontal/vertical and approximate for diagonals —
  // we use per-pixel for full accuracy).

  for (var row = 0; row < h; row++) {
    var py = y + row;
    // Sample at multiple x positions? For performance use start-of-row and
    // end-of-row and check if they differ by more than 1 colour stop band.
    var tLeft  = _linearT(0,     row, w, h, cos, sin, lineLen);
    var tRight = _linearT(w - 1, row, w, h, cos, sin, lineLen);

    if (Math.abs(tLeft - tRight) < 0.005) {
      // Solid horizontal band — one fillRect call
      canvas.fillRect(x, py, w, 1, sampleStops(stops, normT((tLeft + tRight) / 2, repeating)));
    } else {
      // Need per-pixel (diagonal gradient)
      for (var col = 0; col < w; col++) {
        var t = normT(_linearT(col, row, w, h, cos, sin, lineLen), repeating);
        canvas.setPixel(x + col, py, sampleStops(stops, t));
      }
    }
  }
}

function _linearT(px: number, py: number, w: number, h: number, cos: number, sin: number, lineLen: number): number {
  // Project (px, py) relative to box centre onto the gradient direction vector.
  var cx = w / 2, cy = h / 2;
  var dx = px - cx, dy = py - cy;
  var proj = dx * sin + dy * cos;  // dot product with (sin,cos) direction
  return 0.5 + proj / lineLen;
}

// ── Radial gradient rasteriser ────────────────────────────────────────────────

function _renderRadial(
  canvas: Canvas,
  x: number, y: number, w: number, h: number,
  normCx: number, normCy: number,
  shape: 'circle' | 'ellipse',
  stops: ColorStop[],
  repeating: boolean,
): void {
  var cxPx = normCx * w;
  var cyPx = normCy * h;

  // Radii: farthest-corner (default)
  var rx = Math.max(normCx * w, (1 - normCx) * w);
  var ry = Math.max(normCy * h, (1 - normCy) * h);
  if (shape === 'circle') { rx = ry = Math.sqrt(rx * rx + ry * ry); }
  if (rx < 1) rx = 1;
  if (ry < 1) ry = 1;

  for (var row = 0; row < h; row++) {
    var py = y + row;
    for (var col = 0; col < w; col++) {
      var nx = (col - cxPx) / rx;
      var ny = (row - cyPx) / ry;
      var t  = Math.sqrt(nx * nx + ny * ny);
      canvas.setPixel(x + col, py, sampleStops(stops, normT(t, repeating)));
    }
  }
}

// ── Conic gradient rasteriser ─────────────────────────────────────────────────

function _renderConic(
  canvas: Canvas,
  x: number, y: number, w: number, h: number,
  fromDeg: number,
  normCx: number, normCy: number,
  stops: ColorStop[],
  _repeating: boolean,
): void {
  var cxPx = normCx * w;
  var cyPx = normCy * h;
  var fromRad = (fromDeg * Math.PI) / 180;

  for (var row = 0; row < h; row++) {
    var py = y + row;
    for (var col = 0; col < w; col++) {
      var dx = col - cxPx;
      var dy = row - cyPx;
      var angle = Math.atan2(dy, dx) - fromRad;
      // Normalise to [0,1]
      var t = ((angle / (2 * Math.PI)) % 1 + 1) % 1;
      canvas.setPixel(x + col, py, sampleStops(stops, t));
    }
  }
}
