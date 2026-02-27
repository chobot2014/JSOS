import type { CSSProps } from './types.js';

// ── CSS Custom Properties (CSS variables) ─────────────────────────────────────

/** Page-level CSS variable registry. Cleared on each navigation. */
var _cssVars: Record<string, string> = Object.create(null);

/** Reset all CSS variables (call when navigating to a new page). */
export function resetCSSVars(): void { _cssVars = Object.create(null); }

/** Bulk-register CSS variables (use for :root / html / body declarations). */
export function setCSSVar(name: string, value: string): void { _cssVars[name] = value; }

/**
 * Scan a CSS text block for `--name: value` declarations and register them.
 * Works with raw CSS text from :root{} blocks etc.
 */
export function registerCSSVarBlock(block: string): void {
  var lines = block.split(';');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line.startsWith('--')) continue;
    var colon = line.indexOf(':');
    if (colon < 0) continue;
    var name = line.slice(0, colon).trim();
    var val  = line.slice(colon + 1).trim();
    if (name && val) _cssVars[name] = val;
  }
}

/**
 * Resolve `var(--name)` and `var(--name, fallback)` references in a CSS value.
 * Returns the substituted string (unchanged if no var() present).
 */
export function resolveCSSVars(value: string): string {
  if (value.indexOf('var(') < 0) return value;
  return value.replace(/var\(\s*(--[^,)]+)\s*(?:,\s*([^)]+))?\s*\)/g,
    (_: string, name: string, fallback: string | undefined) => {
      var resolved = _cssVars[name.trim()];
      if (resolved !== undefined) return resolveCSSVars(resolved.trim());  // recursive
      return fallback !== undefined ? resolveCSSVars(fallback.trim()) : '';
    });
}

// ── Named CSS colors ──────────────────────────────────────────────────────────

var _CSS_NAMED: Record<string, number> = {
  black:0xFF000000, white:0xFFFFFFFF, red:0xFFFF0000, green:0xFF008000,
  blue:0xFF0000FF, yellow:0xFFFFFF00, orange:0xFFFFA500, purple:0xFF800080,
  pink:0xFFFFC0CB, cyan:0xFF00FFFF, magenta:0xFFFF00FF, gray:0xFF808080,
  grey:0xFF808080, silver:0xFFC0C0C0, maroon:0xFF800000, navy:0xFF000080,
  teal:0xFF008080, olive:0xFF808000, lime:0xFF00FF00, aqua:0xFF00FFFF,
  fuchsia:0xFFFF00FF, brown:0xFFA52A2A, coral:0xFFFF7F50, crimson:0xFFDC143C,
  darkblue:0xFF00008B, darkgreen:0xFF006400, darkred:0xFF8B0000,
  deepskyblue:0xFF00BFFF, dimgray:0xFF696969, dodgerblue:0xFF1E90FF,
  firebrick:0xFFB22222, forestgreen:0xFF228B22, gold:0xFFFFD700,
  hotpink:0xFFFF69B4, indianred:0xFFCD5C5C, indigo:0xFF4B0082,
  khaki:0xFFF0E68C, lavender:0xFFE6E6FA, lightblue:0xFFADD8E6,
  lightcoral:0xFFF08080, lightcyan:0xFFE0FFFF, lightgray:0xFFD3D3D3,
  lightgreen:0xFF90EE90, lightyellow:0xFFFFFFE0, limegreen:0xFF32CD32,
  mediumblue:0xFF0000CD, mediumorchid:0xFFBA55D3, mediumpurple:0xFF9370DB,
  mediumseagreen:0xFF3CB371, midnightblue:0xFF191970, mintcream:0xFFF5FFFA,
  moccasin:0xFFFFE4B5, orangered:0xFFFF4500, palegreen:0xFF98FB98,
  peachpuff:0xFFFFDAB9, plum:0xFFDDA0DD, powderblue:0xFFB0E0E6,
  royalblue:0xFF4169E1, saddlebrown:0xFF8B4513, salmon:0xFFFA8072,
  sandybrown:0xFFF4A460, seagreen:0xFF2E8B57, sienna:0xFFA0522D,
  skyblue:0xFF87CEEB, slateblue:0xFF6A5ACD, slategray:0xFF708090,
  springgreen:0xFF00FF7F, steelblue:0xFF4682B4, tan:0xFFD2B48C,
  thistle:0xFFD8BFD8, tomato:0xFFFF6347, turquoise:0xFF40E0D0,
  violet:0xFFEE82EE, wheat:0xFFF5DEB3, yellowgreen:0xFF9ACD32,
  transparent:0x00000000, rebeccapurple:0xFF663399,
  // Extended named colors
  aliceblue:0xFFF0F8FF, antiquewhite:0xFFFAEBD7, azure:0xFFF0FFFF,
  beige:0xFFF5F5DC, bisque:0xFFFFE4C4, blanchedalmond:0xFFFFEBCD,
  blueviolet:0xFF8A2BE2, burlywood:0xFFDEB887, cadetblue:0xFF5F9EA0,
  chartreuse:0xFF7FFF00, chocolate:0xFFD2691E, cornflowerblue:0xFF6495ED,
  cornsilk:0xFFFFF8DC, darkgray:0xFFA9A9A9, darkgrey:0xFFA9A9A9,
  darkcyan:0xFF008B8B, darkkhaki:0xFFBDB76B, darkmagenta:0xFF8B008B,
  darkolivegreen:0xFF556B2F, darkorange:0xFFFF8C00, darkorchid:0xFF9932CC,
  darksalmon:0xFFE9967A, darkseagreen:0xFF8FBC8F, darkslateblue:0xFF483D8B,
  darkslategray:0xFF2F4F4F, darkturquoise:0xFF00CED1, darkviolet:0xFF9400D3,
  deeppink:0xFFFF1493, floralwhite:0xFFFFFAF0, gainsboro:0xFFDCDCDC,
  ghostwhite:0xFFF8F8FF, goldenrod:0xFFDAA520, greenyellow:0xFFADFF2F,
  honeydew:0xFFF0FFF0, ivory:0xFFFFFFF0, lavenderblush:0xFFFFF0F5,
  lawngreen:0xFF7CFC00, lemonchiffon:0xFFFFFACD, lightgoldenrodyellow:0xFFFAFAD2,
  lightgrey:0xFFD3D3D3, lightpink:0xFFFFB6C1, lightsalmon:0xFFFFA07A,
  lightseagreen:0xFF20B2AA, lightslategray:0xFF778899, lightsteelblue:0xFFB0C4DE,
  linen:0xFFFAF0E6, mediumaquamarine:0xFF66CDAA, mediumspringgreen:0xFF00FA9A,
  mediumturquoise:0xFF48D1CC, mediumvioletred:0xFFC71585, mistyrose:0xFFFFE4E1,
  navajowhite:0xFFFFDEAD, oldlace:0xFFFDF5E6, olivedrab:0xFF6B8E23,
  palegoldenrod:0xFFEEE8AA, paleturquoise:0xFFAFEEEE, palevioletred:0xFFDB7093,
  papayawhip:0xFFFFEFD5, peru:0xFFCD853F, rosybrown:0xFFBC8F8F,
  seashell:0xFFFFF5EE, slategrey:0xFF708090, snow:0xFFFFFAFA,
  whitesmoke:0xFFF5F5F5,
};

/**
 * Sentinel value returned by parseCSSColor for the `currentColor` keyword.
 * The renderer must substitute the element's own `color` value when it encounters this.
 */
export const CSS_CURRENT_COLOR = 0x01FEFCFC >>> 0;

/**
 * Parse a CSS color string (named, #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba())
 * and return it as a 32-bit ARGB pixel value, or undefined if unrecognised.
 */
export function parseCSSColor(val: string): number | undefined {
  val = val.trim().toLowerCase();
  if (val === 'currentcolor') return CSS_CURRENT_COLOR;
  if (_CSS_NAMED[val] !== undefined) return _CSS_NAMED[val];
  if (val.startsWith('#')) {
    var hex = val.slice(1);
    if (hex.length === 3) {
      return 0xFF000000 | (parseInt(hex[0]+hex[0], 16) << 16) |
             (parseInt(hex[1]+hex[1], 16) << 8) | parseInt(hex[2]+hex[2], 16);
    }
    if (hex.length === 6) return 0xFF000000 | (parseInt(hex, 16) & 0xFFFFFF);
    if (hex.length === 8) return parseInt(hex, 16) >>> 0;
  }
  var m = val.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m) {
    var aa = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 255) : 255;
    return ((aa & 0xFF) << 24 | (parseInt(m[1]) & 0xFF) << 16 | (parseInt(m[2]) & 0xFF) << 8 | (parseInt(m[3]) & 0xFF)) >>> 0;
  }
  var mh = val.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)/);
  if (mh) {
    var hh = parseFloat(mh[1]) % 360; var ss = parseFloat(mh[2]) / 100; var ll = parseFloat(mh[3]) / 100;
    var aha = mh[4] !== undefined ? Math.round(parseFloat(mh[4]) * 255) : 255;
    var cc = ss * Math.min(ll, 1 - ll);
    var fh = (n: number) => { var k2 = (n + hh / 30) % 12; return Math.round((ll - cc * Math.max(-1, Math.min(k2 - 3, 9 - k2, 1))) * 255); };
    return ((aha & 0xFF) << 24 | fh(0) << 16 | fh(8) << 8 | fh(4)) >>> 0;
  }
  // CSS Color Level 4: space-separated hsl(h s% l% / a) or hsl(h s% l%)
  var mh2 = val.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (mh2) {
    var hh2 = parseFloat(mh2[1]) % 360; var ss2 = parseFloat(mh2[2]) / 100; var ll2 = parseFloat(mh2[3]) / 100;
    var aha2 = mh2[4] !== undefined ? (mh2[4].endsWith('%') ? Math.round(parseFloat(mh2[4]) * 2.55) : Math.round(parseFloat(mh2[4]) * 255)) : 255;
    var cc2 = ss2 * Math.min(ll2, 1 - ll2);
    var fh2 = (n: number) => { var k3 = (n + hh2 / 30) % 12; return Math.round((ll2 - cc2 * Math.max(-1, Math.min(k3 - 3, 9 - k3, 1))) * 255); };
    return ((aha2 & 0xFF) << 24 | fh2(0) << 16 | fh2(8) << 8 | fh2(4)) >>> 0;
  }
  // CSS Color Level 4: space-separated rgb(r g b / a) or rgb(r g b)
  var mr2 = val.match(/^rgba?\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (mr2) {
    var _chan = (s: string) => s.endsWith('%') ? Math.round(parseFloat(s) * 2.55) : parseInt(s);
    var rr = _chan(mr2[1]); var gg = _chan(mr2[2]); var bb2 = _chan(mr2[3]);
    var aa2 = mr2[4] !== undefined ? (mr2[4].endsWith('%') ? Math.round(parseFloat(mr2[4]) * 2.55) : Math.round(parseFloat(mr2[4]) * 255)) : 255;
    return ((aa2 & 0xFF) << 24 | (rr & 0xFF) << 16 | (gg & 0xFF) << 8 | (bb2 & 0xFF)) >>> 0;
  }
  // hwb(h w% b% / a) — W3C HWB model
  var mhwb = val.match(/^hwb\(\s*([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (mhwb) {
    var hwbH = parseFloat(mhwb[1]) / 360; var hwbW = parseFloat(mhwb[2]) / 100; var hwbB = parseFloat(mhwb[3]) / 100;
    var hwbA = mhwb[4] !== undefined ? (mhwb[4].endsWith('%') ? Math.round(parseFloat(mhwb[4]) * 2.55) : Math.round(parseFloat(mhwb[4]) * 255)) : 255;
    // Normalize if w+b > 1
    if (hwbW + hwbB >= 1) { var s3 = hwbW + hwbB; hwbW /= s3; hwbB /= s3; }
    var hwbI = Math.floor(hwbH * 6); var hwbF = hwbH * 6 - hwbI;
    var hwbRot = (hwbI & 1) ? 1 - hwbF : hwbF;
    var hwbV = (n3: number) => Math.round((n3 * (1 - hwbW - hwbB) + hwbW) * 255);
    var hwbR: number, hwbG: number, hwbBB: number;
    switch (hwbI % 6) {
      case 0: hwbR = hwbV(1); hwbG = hwbV(hwbRot); hwbBB = hwbV(0); break;
      case 1: hwbR = hwbV(hwbRot); hwbG = hwbV(1); hwbBB = hwbV(0); break;
      case 2: hwbR = hwbV(0); hwbG = hwbV(1); hwbBB = hwbV(hwbRot); break;
      case 3: hwbR = hwbV(0); hwbG = hwbV(hwbRot); hwbBB = hwbV(1); break;
      case 4: hwbR = hwbV(hwbRot); hwbG = hwbV(0); hwbBB = hwbV(1); break;
      default: hwbR = hwbV(1); hwbG = hwbV(0); hwbBB = hwbV(hwbRot); break;
    }
    return ((hwbA & 0xFF) << 24 | (hwbR & 0xFF) << 16 | (hwbG & 0xFF) << 8 | (hwbBB & 0xFF)) >>> 0;
  }
  // oklch(l c h / a) — approximate to RGB via oklab → linear sRGB conversion
  var moklch = val.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (moklch) {
    var okL = moklch[1].endsWith('%') ? parseFloat(moklch[1]) / 100 : parseFloat(moklch[1]);
    var okC = parseFloat(moklch[2]); var okH = parseFloat(moklch[3]) * Math.PI / 180;
    var okA = moklch[4] !== undefined ? (moklch[4].endsWith('%') ? Math.round(parseFloat(moklch[4]) * 2.55) : Math.round(parseFloat(moklch[4]) * 255)) : 255;
    // Convert oklch → oklab
    var okLabA = okC * Math.cos(okH); var okLabB = okC * Math.sin(okH);
    // Oklab → linear sRGB (approximate)
    var ll3 = okL + 0.3963377774 * okLabA + 0.2158037573 * okLabB;
    var mm = okL - 0.1055613458 * okLabA - 0.0638541728 * okLabB;
    var ss3 = okL - 0.0894841775 * okLabA - 1.2914855480 * okLabB;
    var ll4 = ll3 * ll3 * ll3; var mm2 = mm * mm * mm; var ss4 = ss3 * ss3 * ss3;
    var okRLin =  4.0767416621 * ll4 - 3.3077115913 * mm2 + 0.2309699292 * ss4;
    var okGLin = -1.2684380046 * ll4 + 2.6097574011 * mm2 - 0.3413193965 * ss4;
    var okBLin = -0.0041960863 * ll4 - 0.7034186147 * mm2 + 1.7076147010 * ss4;
    // Linear → gamma sRGB
    var gammaC = (x: number) => { var v = Math.max(0, Math.min(1, x)); return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1/2.4) - 0.055) * 255); };
    return ((okA & 0xFF) << 24 | gammaC(okRLin) << 16 | gammaC(okGLin) << 8 | gammaC(okBLin)) >>> 0;
  }
  // lab(l a b / alpha) — CIELAB approximate conversion
  var mlab = val.match(/^lab\(\s*([\d.]+%?)\s+([-\d.]+)\s+([-\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (mlab) {
    var labL = mlab[1].endsWith('%') ? parseFloat(mlab[1]) : parseFloat(mlab[1]);
    var labA2 = parseFloat(mlab[2]); var labB2 = parseFloat(mlab[3]);
    var labAlpha = mlab[4] !== undefined ? (mlab[4].endsWith('%') ? Math.round(parseFloat(mlab[4]) * 2.55) : Math.round(parseFloat(mlab[4]) * 255)) : 255;
    var fy = (labL + 16) / 116; var fx = labA2 / 500 + fy; var fz = fy - labB2 / 200;
    var D65 = [0.95047, 1.0, 1.08883];
    var _cube = (t: number) => t > 0.206897 ? t * t * t : (t - 16/116) / 7.787;
    var Xn = D65[0] * _cube(fx); var Yn = D65[1] * _cube(fy); var Zn = D65[2] * _cube(fz);
    var rLin2 =  3.2406 * Xn - 1.5372 * Yn - 0.4986 * Zn;
    var gLin2 = -0.9689 * Xn + 1.8758 * Yn + 0.0415 * Zn;
    var bLin2 =  0.0557 * Xn - 0.2040 * Yn + 1.0570 * Zn;
    var gC2 = (x: number) => { var v = Math.max(0, Math.min(1, x)); return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1/2.4) - 0.055) * 255); };
    return ((labAlpha & 0xFF) << 24 | gC2(rLin2) << 16 | gC2(gLin2) << 8 | gC2(bLin2)) >>> 0;
  }
  // lch(l c h / alpha) — CIELCh polar form of CIELAB
  var mlch = val.match(/^lch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/);
  if (mlch) {
    var lchL = parseFloat(mlch[1]); var lchC = parseFloat(mlch[2]); var lchH = parseFloat(mlch[3]) * Math.PI / 180;
    // Convert to LAB then reuse lab() logic inline
    return parseCSSColor('lab(' + lchL + ' ' + (lchC * Math.cos(lchH)).toFixed(4) + ' ' + (lchC * Math.sin(lchH)).toFixed(4) + (mlch[4] ? ' / ' + mlch[4] : '') + ')') ?? 0xFF808080;
  }
  // color(display-p3 r g b / a) — approximate as sRGB (gamut mapping not critical for rendering)
  var mcolorFn = val.match(/^color\(\s*(?:display-p3|srgb|srgb-linear|a98-rgb|prophoto-rgb|rec2020)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)(?:\s*\/\s*([\d.]+))?\s*\)/);
  if (mcolorFn) {
    var cr = Math.round(Math.max(0, Math.min(1, parseFloat(mcolorFn[1]))) * 255);
    var cg = Math.round(Math.max(0, Math.min(1, parseFloat(mcolorFn[2]))) * 255);
    var cb2 = Math.round(Math.max(0, Math.min(1, parseFloat(mcolorFn[3]))) * 255);
    var ca = mcolorFn[4] !== undefined ? Math.round(parseFloat(mcolorFn[4]) * 255) : 255;
    return ((ca & 0xFF) << 24 | (cr & 0xFF) << 16 | (cg & 0xFF) << 8 | (cb2 & 0xFF)) >>> 0;
  }
  // color-mix(in <space>, <color1> [<pct1>], <color2> [<pct2>]) — sRGB mix approximation
  // e.g. color-mix(in srgb, red 40%, blue) or color-mix(in oklch, #fff, #000 30%)
  var mcm = val.match(/^color-mix\(\s*in\s+\S+\s*,\s*(.+?)\s*,\s*(.+?)\s*\)$/);
  if (mcm) {
    // Parse each part: color [percentage]
    var _parseCMPart = (part: string): [number | undefined, number] => {
      var pm = part.trim().match(/^(.*?)\s+([\d.]+)%\s*$/);
      if (pm) return [parseCSSColor(pm[1].trim()), parseFloat(pm[2]) / 100];
      return [parseCSSColor(part.trim()), 0.5];
    };
    var [c1, p1] = _parseCMPart(mcm[1]);
    var [c2, p2] = _parseCMPart(mcm[2]);
    if (c1 === undefined) c1 = 0xFF000000;
    if (c2 === undefined) c2 = 0xFF000000;
    // Normalize percentages
    if (p1 === 0.5 && p2 === 0.5) { p1 = 0.5; p2 = 0.5; }
    else if (p2 === 0.5) { p2 = 1 - p1; }
    else if (p1 === 0.5) { p1 = 1 - p2; }
    var _cm = (ch1: number, ch2: number, w1: number, w2: number) => Math.round(((ch1 * w1 + ch2 * w2) / (w1 + w2)));
    var cmR = _cm((c1 >>> 16) & 0xFF, (c2 >>> 16) & 0xFF, p1, p2);
    var cmG = _cm((c1 >>> 8)  & 0xFF, (c2 >>> 8)  & 0xFF, p1, p2);
    var cmB = _cm( c1         & 0xFF,  c2         & 0xFF, p1, p2);
    var cmA = _cm((c1 >>> 24) & 0xFF, (c2 >>> 24) & 0xFF, p1, p2);
    return ((cmA & 0xFF) << 24 | (cmR & 0xFF) << 16 | (cmG & 0xFF) << 8 | (cmB & 0xFF)) >>> 0;
  }
}

/**
 * Evaluate a simple CSS `calc()` expression.
 * Handles: px arithmetic, %, em (1em=16px), rem (1rem=16px).
 * Returns NaN if expression is too complex to evaluate.
 */
export function evalCalc(expr: string): number {
  var s = expr.replace(/calc\(/g, '(').replace(/\s+/g, ' ').trim();
  // Replace env(safe-area-inset-*) and other env() calls with 0 (no safe area in OS)
  s = s.replace(/env\([^)]*\)/g, '0');
  // Replace var(--*) CSS custom properties with 0 (no runtime value available here)
  s = s.replace(/var\(--[^)]*\)/g, '0');
  // Replace unit suffixes with numeric px values
  s = s.replace(/([\d.]+)rem/g, (_m: string, n: string) => String(parseFloat(n) * 16));
  s = s.replace(/([\d.]+)em/g,  (_m: string, n: string) => String(parseFloat(n) * 16));
  s = s.replace(/([\d.]+)px/g,  (_m: string, n: string) => n);
  s = s.replace(/([\d.]+)pt/g,  (_m: string, n: string) => String(parseFloat(n) * 1.333));
  // Allow only safe characters: digits, spaces, +-*/(). 
  if (/[^0-9.+\-*/ ()%]/.test(s)) return NaN;
  try { return Function('"use strict"; return (' + s + ')')() as number; }
  catch { return NaN; }
}

/**
 * Parse a CSS length value to pixels.
 * Supports: px, em, rem, pt, vw/vh (viewport 1920×1080), %, unitless.
 * Returns NaN if not a length.
 */
function _splitCSSArgs(s: string): string[] {
  var args: string[] = []; var depth = 0; var start = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { args.push(s.slice(start, i)); start = i + 1; }
  }
  args.push(s.slice(start));
  return args;
}
export function parseLengthPx(val: string, containerPx?: number): number {
  var v = val.trim();
  if (v === 'auto' || v === 'none') return 0;
  if (v.startsWith('calc(') || v.includes('calc(')) {
    var inner = v.replace(/^calc\(/, '').replace(/\)$/, '');
    return evalCalc(inner);
  }
  // min(), max(), clamp() CSS math functions (item 408)
  if (v.startsWith('min(')) {
    var ma = _splitCSSArgs(v.slice(4, -1)); var ma2 = ma.map(x => parseLengthPx(x, containerPx)).filter(x => !isNaN(x));
    return ma2.length ? Math.min(...ma2) : NaN;
  }
  if (v.startsWith('max(')) {
    var mb = _splitCSSArgs(v.slice(4, -1)); var mb2 = mb.map(x => parseLengthPx(x, containerPx)).filter(x => !isNaN(x));
    return mb2.length ? Math.max(...mb2) : NaN;
  }
  if (v.startsWith('clamp(')) {
    var mc = _splitCSSArgs(v.slice(6, -1));
    var cMin = parseLengthPx(mc[0] || '0', containerPx); var cVal = parseLengthPx(mc[1] || '0', containerPx); var cMax = parseLengthPx(mc[2] || '0', containerPx);
    return isNaN(cMin) || isNaN(cVal) || isNaN(cMax) ? NaN : Math.max(cMin, Math.min(cVal, cMax));
  }
  if (v.endsWith('px'))  return parseFloat(v);
  if (v.endsWith('rem')) return parseFloat(v) * 16;
  if (v.endsWith('em'))  return parseFloat(v) * 16;
  if (v.endsWith('pt'))  return parseFloat(v) * 1.333;
  if (v.endsWith('vw'))  return parseFloat(v) * 1920 / 100;
  if (v.endsWith('vh'))  return parseFloat(v) * 1080 / 100;
  if (v.endsWith('ch'))  return parseFloat(v) * 8;   // approx 1ch = 8px
  if (v.endsWith('%') && containerPx !== undefined)
    return parseFloat(v) * containerPx / 100;
  if (v.endsWith('%'))   return 0;  // can't resolve without container
  var n = parseFloat(v);
  return isNaN(n) ? NaN : n;
}

/**
 * Parse a CSS margin/padding shorthand (1–4 values) into [top,right,bottom,left].
 * Values returned in px. Handles keywords (auto→0).
 */
function parseBox4(val: string): [number, number, number, number] {
  var parts = val.trim().split(/\s+/);
  var t = parseLengthPx(parts[0] || '0');
  var r = parseLengthPx(parts[1] || parts[0] || '0');
  var b = parseLengthPx(parts[2] || parts[0] || '0');
  var l = parseLengthPx(parts[3] || parts[1] || parts[0] || '0');
  return [isNaN(t)?0:t, isNaN(r)?0:r, isNaN(b)?0:b, isNaN(l)?0:l];
}

/**
 * Parse an inline `style="..."` attribute string into a CSSProps bag.
 * Handles the full set of properties needed for layout + text rendering.
 */
export function parseInlineStyle(style: string): CSSProps {
  var p: CSSProps = {};
  var important: Set<string> | undefined;

  // Split on ; but respect nested parens (e.g. calc(), rgba())
  var decls: string[] = [];
  var depth = 0; var start = 0;
  for (var ci = 0; ci <= style.length; ci++) {
    var ch = style[ci];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ';' || ci === style.length) && depth === 0) {
      var piece = style.slice(start, ci).trim();
      if (piece) decls.push(piece);
      start = ci + 1;
    }
  }

  for (var di = 0; di < decls.length; di++) {
    var col = decls[di].indexOf(':');
    if (col < 0) continue;
    var prop = decls[di].slice(0, col).trim().toLowerCase();
    var raw  = decls[di].slice(col + 1).trim();

    // Register CSS custom property
    if (prop.startsWith('--')) { _cssVars[prop] = raw; continue; }

    // Strip !important flag
    var isImportant = false;
    var val = raw;
    if (val.toLowerCase().endsWith('!important')) {
      isImportant = true;
      val = val.slice(0, val.length - 10).trim();
    } else if (val.toLowerCase().includes('!important')) {
      isImportant = true;
      val = val.replace(/\s*!important\s*$/i, '').trim();
    }

    // Resolve var() references before processing
    val = resolveCSSVars(val);
    var vl = val.toLowerCase().trim();

    // Handle global keywords — track in _inherit/_initial sets for cascade resolution
    if (vl === 'inherit' || vl === 'unset') {
      if (!p._inherit) p._inherit = new Set();
      p._inherit.add(prop);
      if (isImportant) { if (!important) important = new Set(); important.add(prop); }
      continue;
    }
    if (vl === 'initial' || vl === 'revert') {
      if (!p._initial) p._initial = new Set();
      p._initial.add(prop);
      if (isImportant) { if (!important) important = new Set(); important.add(prop); }
      continue;
    }

    var matched = true;
    switch (prop) {
      // ── Colors ────────────────────────────────────────────────────────────
      case 'color': {
        var c = parseCSSColor(vl);
        if (c !== undefined) p.color = c; break;
      }
      case 'background-color': {
        var bg = parseCSSColor(vl);
        if (bg !== undefined) p.bgColor = bg; break;
      }
      case 'background': {
        // background shorthand — color, url, position [/ size], repeat, attachment
        // 0. Detect gradient functions (item 487): linear/radial/conic-gradient(...)
        var gradM = val.match(/((?:repeating-)?(?:linear|radial|conic)-gradient\s*\([^)]*(?:\([^)]*\)[^)]*)*\))/i);
        if (gradM) { p.backgroundImage = gradM[1]; }
        // 1. Extract url(...)
        var urlM = val.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i);
        if (urlM) p.backgroundImage = 'url(' + urlM[1] + ')';
        // Work on a version with url() stripped for token parsing
        var bgNoUrl = val.replace(/url\([^)]*\)/gi, '').trim();
        // 2. background-size in "pos / size" notation
        var bgsM = bgNoUrl.match(/(?:^|\s)((?:left|right|center|top|bottom|[\d.]+(?:px|%|em|rem)?)\s+)+\s*\/\s*(.+?)(?:\s+(?:no-repeat|repeat[^\s]*|fixed|scroll|local)|$)/i);
        if (bgsM) p.backgroundSize = bgsM[2].trim();
        // 3. Extract repeat keyword
        var bgRepM = bgNoUrl.match(/\b(no-repeat|repeat-x|repeat-y|repeat|round|space)\b/i);
        if (bgRepM) p.backgroundRepeat = bgRepM[1].toLowerCase();
        // 4. Extract attachment keyword
        var bgAttM = bgNoUrl.match(/\b(fixed|scroll|local)\b/i);
        if (bgAttM) p.backgroundAttachment = bgAttM[1].toLowerCase();
        // 5. Try to find position keywords / values (before size)
        var posBefore = bgsM ? bgNoUrl.slice(0, bgNoUrl.indexOf('/')) : bgNoUrl;
        var posM = posBefore.match(/\b(left|right|center|top|bottom)\b/i);
        if (posM) { p.backgroundPosition = posM[0].toLowerCase(); }
        else {
          var pctM = posBefore.match(/(\d+(?:\.\d+)?%)\s+(\d+(?:\.\d+)?%)/);
          if (pctM) p.backgroundPosition = pctM[1] + ' ' + pctM[2];
        }
        // 6. Find color (last non-url/position/repeat token, try each token)
        var bgParts = bgNoUrl.replace(/\b(no-repeat|repeat[^\s]*|fixed|scroll|local)\b/gi, '').split(/\s+/);
        for (var bpi = 0; bpi < bgParts.length; bpi++) {
          var bgCol = parseCSSColor(bgParts[bpi].toLowerCase());
          if (bgCol !== undefined) { p.bgColor = bgCol; break; }
        }
        break;
      }
      case 'background-image': {
        p.backgroundImage = val; break;
      }
      case 'background-size':       { p.backgroundSize       = val; break; }
      case 'background-position':   { p.backgroundPosition   = val; break; }
      case 'background-repeat':     { p.backgroundRepeat     = val; break; }
      case 'background-attachment': { p.backgroundAttachment = vl;  break; }
      case 'background-clip':       { p.backgroundClip       = vl;  break; }
      case 'background-origin':     { p.backgroundOrigin     = vl;  break; }
      case '-webkit-background-clip': { if (!p.backgroundClip) p.backgroundClip = vl; break; }

      // ── Font / text ───────────────────────────────────────────────────────
      case 'font-weight': {
        var fw = parseInt(vl);
        if (!isNaN(fw)) { p.fontWeight = fw; p.bold = fw >= 600; }
        else if (vl === 'bold' || vl === 'bolder') { p.bold = true; p.fontWeight = 700; }
        else if (vl === 'normal' || vl === 'lighter') { p.bold = false; p.fontWeight = 400; }
        break;
      }
      case 'font-style': {
        if (vl === 'italic' || vl === 'oblique') p.italic = true;
        else if (vl === 'normal') p.italic = false;
        break;
      }
      case 'font-family': { p.fontFamily = val; break; }
      case 'font-size': {
        // Map to fontScale buckets: <12=0.75, 12-15=1, 16-23=2, >=24=3
        var fsv = parseLengthPx(vl);
        if (!isNaN(fsv) && fsv > 0) {
          p.fontScale = fsv < 12 ? 0.75 : fsv < 16 ? 1 : fsv < 24 ? 2 : 3;
        } else {
          if (vl === 'small' || vl === 'x-small' || vl === 'xs') p.fontScale = 0.75;
          else if (vl === 'medium' || vl === 'normal') p.fontScale = 1;
          else if (vl === 'large' || vl === 'x-large') p.fontScale = 2;
          else if (vl === 'xx-large' || vl === 'xxx-large') p.fontScale = 3;
          else if (vl === 'smaller') p.fontScale = 0.75;
          else if (vl === 'larger')  p.fontScale = 2;
        }
        break;
      }
      case 'line-height': {
        if (vl !== 'normal') {
          var lhv = parseFloat(vl);
          if (!isNaN(lhv)) {
            // unitless: treat as multiplier of 16px
            if (!vl.endsWith('px') && !vl.endsWith('em') && !vl.endsWith('rem') && lhv < 10)
              lhv = lhv * 16;
            else lhv = parseLengthPx(vl) || lhv;
            p.lineHeight = lhv;
          }
        }
        break;
      }
      case 'letter-spacing': {
        var lsv = parseLengthPx(vl);
        if (!isNaN(lsv)) p.letterSpacing = lsv; break;
      }
      case 'word-spacing': {
        var wsv = parseLengthPx(vl);
        if (!isNaN(wsv)) p.wordSpacing = wsv; break;
      }
      case 'font': {
        // font shorthand: [style] [variant] [weight] [size][/line-height] family
        var fpw = vl.match(/\b(bold|bolder|lighter|\d00)\b/);
        if (fpw) { var fwn = parseInt(fpw[1]); p.bold = isNaN(fwn) ? fpw[1]==='bold' : fwn>=600; }
        var fpit = vl.match(/\b(italic|oblique)\b/);
        if (fpit) p.italic = true;
        var fpsz = vl.match(/\b(\d+(?:\.\d+)?(?:px|pt|em|rem|%))\b/);
        if (fpsz) {
          var fszv = parseLengthPx(fpsz[1]);
          if (!isNaN(fszv)) p.fontScale = fszv < 12 ? 0.75 : fszv < 16 ? 1 : fszv < 24 ? 2 : 3;
          // Family is everything after the "size[/line-height]" part
          var afterSize = vl.slice(vl.indexOf(fpsz[1]) + fpsz[1].length);
          // Skip /line-height if present
          afterSize = afterSize.replace(/^\s*\/\s*[\d.]+(?:px|em|rem|%|)\s*/, '').trim();
          if (afterSize.length > 0) p.fontFamily = afterSize;
        }
        break;
      }
      case 'text-decoration': {
        if (vl === 'none') { p.underline = false; p.strike = false; }
        if (vl.includes('underline'))    p.underline = true;
        if (vl.includes('line-through')) p.strike    = true;
        p.textDecoration = val; break;
      }
      case 'text-decoration-line': {
        if (vl.includes('underline'))    p.underline = true;
        if (vl.includes('line-through')) p.strike    = true;
        break;
      }
      case 'text-align': {
        if (vl === 'center' || vl === 'right' || vl === 'left' || vl === 'justify')
          p.align = vl as 'left' | 'center' | 'right' | 'justify';
        break;
      }
      case 'text-transform': {
        if (vl === 'uppercase' || vl === 'lowercase' || vl === 'capitalize' || vl === 'none')
          p.textTransform = vl as CSSProps['textTransform'];
        break;
      }
      case 'text-overflow': {
        if (vl === 'ellipsis') p.textOverflow = 'ellipsis';
        else p.textOverflow = 'clip'; break;
      }
      case 'white-space': {
        if (vl === 'normal' || vl === 'nowrap' || vl === 'pre' || vl === 'pre-wrap' || vl === 'pre-line')
          p.whiteSpace = vl as CSSProps['whiteSpace'];
        break;
      }
      case 'vertical-align': { p.verticalAlign = vl; break; }
      case 'list-style-type': { p.listStyleType = vl; break; }
      case 'list-style': {
        if (vl.includes('none')) p.listStyleType = 'none';
        else if (vl.includes('disc')) p.listStyleType = 'disc';
        else if (vl.includes('decimal')) p.listStyleType = 'decimal';
        break;
      }

      // ── Display / visibility ──────────────────────────────────────────────
      case 'display': {
        if (vl === 'none') p.hidden = true;
        else {
          p.hidden = false;
          if (vl === 'flex' || vl === 'inline-flex' || vl === 'grid' ||
              vl === 'inline-block' || vl === 'inline' || vl === 'block' ||
              vl === 'table' || vl === 'table-row' || vl === 'table-cell')
            p.display = vl as CSSProps['display'];
        }
        break;
      }
      case 'visibility': {
        if (vl === 'hidden' || vl === 'collapse') { p.visibility = vl as CSSProps['visibility']; p.hidden = true; }
        else { p.visibility = 'visible'; p.hidden = false; }
        break;
      }
      case 'opacity': {
        var opv = parseFloat(vl);
        if (!isNaN(opv)) { p.opacity = Math.max(0, Math.min(1, opv)); if (opv < 0.05) p.hidden = true; }
        break;
      }

      // ── Box sizing ────────────────────────────────────────────────────────
      case 'box-sizing': {
        if (vl === 'border-box' || vl === 'content-box') p.boxSizing = vl; break;
      }

      // ── Dimensions ────────────────────────────────────────────────────────
      case 'width': {
        if (vl !== 'auto') { var wv = parseLengthPx(vl); if (!isNaN(wv) && wv > 0) p.width = wv; } break;
      }
      case 'height': {
        if (vl !== 'auto') { var hv = parseLengthPx(vl); if (!isNaN(hv) && hv > 0) p.height = hv; } break;
      }
      case 'min-width': {
        var mnwv = parseLengthPx(vl); if (!isNaN(mnwv)) p.minWidth = mnwv; break;
      }
      case 'min-height': {
        var mnhv = parseLengthPx(vl); if (!isNaN(mnhv)) p.minHeight = mnhv; break;
      }
      case 'max-width': {
        if (vl !== 'none') { var mxwv = parseLengthPx(vl); if (!isNaN(mxwv) && mxwv > 0) p.maxWidth = mxwv; } break;
      }
      case 'max-height': {
        if (vl !== 'none') { var mxhv = parseLengthPx(vl); if (!isNaN(mxhv) && mxhv > 0) p.maxHeight = mxhv; } break;
      }

      // ── Padding ───────────────────────────────────────────────────────────
      case 'padding': {
        var [pt4,pr4,pb4,pl4] = parseBox4(val);
        p.paddingTop = pt4; p.paddingRight = pr4; p.paddingBottom = pb4; p.paddingLeft = pl4; break;
      }
      case 'padding-top':    case 'padding-block-start':  { var ptv = parseLengthPx(vl); if (!isNaN(ptv)) p.paddingTop    = ptv; break; }
      case 'padding-right':  case 'padding-inline-end':   { var prv2 = parseLengthPx(vl); if (!isNaN(prv2)) p.paddingRight  = prv2; break; }
      case 'padding-bottom': case 'padding-block-end':    { var pbv = parseLengthPx(vl); if (!isNaN(pbv)) p.paddingBottom = pbv; break; }
      case 'padding-left':   case 'padding-inline-start': { var plv = parseLengthPx(vl); if (!isNaN(plv)) p.paddingLeft   = plv; break; }
      case 'padding-block':  { var [ptb,_prb,pbb] = parseBox4(val); p.paddingTop = ptb; p.paddingBottom = pbb; break; }
      case 'padding-inline': { var [_pti,pri,_pbi,pli] = parseBox4(val); p.paddingRight = pri; p.paddingLeft = pli; break; }

      // ── Margin ────────────────────────────────────────────────────────────
      case 'margin': {
        var [mt4,mr4,mb4,ml4] = parseBox4(val);
        p.marginTop = mt4; p.marginRight = mr4; p.marginBottom = mb4; p.marginLeft = ml4; break;
      }
      case 'margin-top':    case 'margin-block-start':  { var mtv = parseLengthPx(vl); if (!isNaN(mtv)) p.marginTop    = mtv; break; }
      case 'margin-right':  case 'margin-inline-end':   { var mrv = parseLengthPx(vl); if (!isNaN(mrv)) p.marginRight  = mrv; break; }
      case 'margin-bottom': case 'margin-block-end':    { var mbv = parseLengthPx(vl); if (!isNaN(mbv)) p.marginBottom = mbv; break; }
      case 'margin-left':   case 'margin-inline-start': { var mlv = parseLengthPx(vl); if (!isNaN(mlv)) p.marginLeft   = mlv; break; }
      case 'margin-block':  { var [mtb2,_mrb2,mbb2] = parseBox4(val); p.marginTop = mtb2; p.marginBottom = mbb2; break; }
      case 'margin-inline': { var [_mti2,mri2,_mbi2,mli2] = parseBox4(val); p.marginRight = mri2; p.marginLeft = mli2; break; }

      // ── Border ────────────────────────────────────────────────────────────
      case 'border': {
        // border: [width] [style] [color]
        var bparts2 = val.trim().split(/\s+/);
        for (var bpi2 = 0; bpi2 < bparts2.length; bpi2++) {
          var bp2 = bparts2[bpi2].toLowerCase();
          var bwv = parseLengthPx(bp2);
          if (!isNaN(bwv)) { p.borderWidth = bwv; continue; }
          var bcc = parseCSSColor(bp2); if (bcc !== undefined) { p.borderColor = bcc; continue; }
          if (bp2 === 'solid' || bp2 === 'dashed' || bp2 === 'dotted' || bp2 === 'double' || bp2 === 'none' || bp2 === 'hidden') p.borderStyle = bp2;
        }
        break;
      }
      case 'border-width': case 'border-top-width': case 'border-right-width':
      case 'border-bottom-width': case 'border-left-width': {
        var bwv2 = parseLengthPx(vl); if (!isNaN(bwv2)) p.borderWidth = bwv2; break;
      }
      case 'border-style': { p.borderStyle = vl; break; }
      case 'border-color': { var bcv = parseCSSColor(vl); if (bcv !== undefined) p.borderColor = bcv; break; }
      case 'border-radius': {
        // 1–4 values supported; store as single for now, expand corners if multiple
        var brParts = val.trim().split(/\s+/);
        var br1 = parseLengthPx(brParts[0] || '0');
        p.borderRadius = isNaN(br1) ? 0 : br1;
        p.borderTopLeftRadius     = isNaN(parseLengthPx(brParts[0] || '0')) ? 0 : parseLengthPx(brParts[0] || '0');
        p.borderTopRightRadius    = isNaN(parseLengthPx(brParts[1] || brParts[0] || '0')) ? 0 : parseLengthPx(brParts[1] || brParts[0] || '0');
        p.borderBottomRightRadius = isNaN(parseLengthPx(brParts[2] || brParts[0] || '0')) ? 0 : parseLengthPx(brParts[2] || brParts[0] || '0');
        p.borderBottomLeftRadius  = isNaN(parseLengthPx(brParts[3] || brParts[1] || brParts[0] || '0')) ? 0 : parseLengthPx(brParts[3] || brParts[1] || brParts[0] || '0');
        break;
      }
      case 'border-top-left-radius':     { var br2 = parseLengthPx(vl); if (!isNaN(br2)) { p.borderTopLeftRadius    = br2; p.borderRadius = br2; } break; }
      case 'border-top-right-radius':    { var br3 = parseLengthPx(vl); if (!isNaN(br3)) p.borderTopRightRadius    = br3; break; }
      case 'border-bottom-right-radius': { var br4 = parseLengthPx(vl); if (!isNaN(br4)) p.borderBottomRightRadius = br4; break; }
      case 'border-bottom-left-radius':  { var br5 = parseLengthPx(vl); if (!isNaN(br5)) p.borderBottomLeftRadius  = br5; break; }
      case 'outline': {
        var oparts = val.trim().split(/\s+/);
        for (var opi = 0; opi < oparts.length; opi++) {
          var op2 = oparts[opi].toLowerCase();
          var owv = parseLengthPx(op2);
          if (!isNaN(owv)) { p.outlineWidth = owv; continue; }
          var occ = parseCSSColor(op2); if (occ !== undefined) p.outlineColor = occ;
        }
        break;
      }
      case 'outline-width': { var owv2 = parseLengthPx(vl); if (!isNaN(owv2)) p.outlineWidth = owv2; break; }
      case 'outline-color': { var occ2 = parseCSSColor(vl); if (occ2 !== undefined) p.outlineColor = occ2; break; }
      case 'outline-style':  { p.outlineStyle = vl; break; }
      case 'outline-offset': { var oofsV = parseLengthPx(vl); if (!isNaN(oofsV)) p.outlineOffset = oofsV; break; }
      case 'caret-color':    { var ccc = parseCSSColor(vl); if (ccc !== undefined) p.caretColor = ccc; break; }
      case 'accent-color':   { var acc = parseCSSColor(vl); if (acc !== undefined) p.accentColor = acc; break; }
      case 'font-stretch':   { p.fontStretch = vl; break; }
      case 'font-feature-settings': case '-webkit-font-feature-settings': break; // no-op
      case 'font-variant-numeric': case 'font-variant-ligatures': case 'font-variant-alternates': break; // no-op
      case 'tab-size': case '-moz-tab-size': { var tsv = parseInt(vl); if (!isNaN(tsv)) p.tabSize = tsv; break; }
      case 'line-break': { p.lineBreak = vl; break; }
      case 'list-style-position': { if (vl === 'inside' || vl === 'outside') p.listStylePosition = vl; break; }
      case 'list-style-image':    { p.listStyleImage = val; break; }
      case 'word-break': {
        if (vl === 'break-all' || vl === 'break-word' || vl === 'keep-all' || vl === 'normal')
          p.wordBreak = vl as CSSProps['wordBreak']; break;
      }
      case 'overflow-wrap': case 'word-wrap': {
        if (vl === 'break-word' || vl === 'anywhere') p.overflowWrap = vl as CSSProps['overflowWrap'];
        else p.overflowWrap = 'normal'; break;
      }
      case 'table-layout': {
        if (vl === 'fixed') p.tableLayout = 'fixed'; else p.tableLayout = 'auto'; break;
      }
      case 'border-collapse': {
        if (vl === 'collapse' || vl === 'separate') p.borderCollapse = vl; break;
      }
      case 'border-spacing': {
        var bsv2 = parseLengthPx(vl); if (!isNaN(bsv2)) p.borderSpacing = bsv2; break;
      }
      case 'user-select': case '-webkit-user-select': case '-moz-user-select': case '-ms-user-select': {
        if (vl === 'none' || vl === 'text' || vl === 'all') p.userSelect = vl as CSSProps['userSelect'];
        else p.userSelect = 'auto'; break;
      }
      case 'appearance': case '-webkit-appearance': case '-moz-appearance': {
        p.appearance = vl; break;
      }
      // ── Generated content / counters ─────────────────────────────────────
      case 'content': { p.content = val; break; }
      case 'counter-reset':     { p.counterReset     = val; break; }
      case 'counter-increment': { p.counterIncrement = val; break; }

      // ── Image / media ─────────────────────────────────────────────────────
      case 'object-fit': {
        if (vl === 'fill' || vl === 'contain' || vl === 'cover' || vl === 'none' || vl === 'scale-down')
          p.objectFit = vl as CSSProps['objectFit']; break;
      }
      case 'object-position': { p.objectPosition = val; break; }
      case 'aspect-ratio': { p.aspectRatio = vl !== 'auto' ? val : undefined; break; }
      case 'image-rendering': { p.imageRendering = vl; break; }

      // ── Multi-column (item 457) ────────────────────────────────────────────
      case 'column-count': {
        if (vl === 'auto') p.columnCount = 'auto';
        else { var ccv = parseInt(vl); if (!isNaN(ccv) && ccv > 0) p.columnCount = ccv; }
        break;
      }
      case 'column-width': {
        if (vl === 'auto') p.columnWidth = 'auto';
        else { var cwv = parseLengthPx(vl); if (!isNaN(cwv)) p.columnWidth = cwv; }
        break;
      }
      case 'columns': {
        // shorthand: column-count column-width (either order)
        var colParts = vl.split(/\s+/);
        for (var cpi = 0; cpi < colParts.length; cpi++) {
          var cpv = colParts[cpi]!;
          if (cpv === 'auto') continue;
          var cpwv = parseLengthPx(cpv);
          if (!isNaN(cpwv) && (cpv.includes('px') || cpv.includes('em') || cpv.includes('rem')))
            p.columnWidth = cpwv;
          else { var cpcv = parseInt(cpv); if (!isNaN(cpcv) && cpcv > 0) p.columnCount = cpcv; }
        }
        break;
      }

      // ── Text (extended) ───────────────────────────────────────────────────
      case 'text-indent': { var tiv = parseLengthPx(vl); if (!isNaN(tiv)) p.textIndent = tiv; break; }
      case 'text-align-last': {
        if (vl==='auto'||vl==='left'||vl==='center'||vl==='right'||vl==='justify'||vl==='start'||vl==='end')
          p.textAlignLast = vl as CSSProps['textAlignLast'];
        break;
      }
      case 'font-variant': case 'font-variant-caps': { p.fontVariant = vl; break; }
      case 'font-kerning': {
        if (vl === 'normal' || vl === 'none') p.fontKerning = vl; else p.fontKerning = 'auto'; break;
      }
      case 'hyphens': case '-webkit-hyphens': case '-ms-hyphens': {
        if (vl === 'none' || vl === 'manual' || vl === 'auto') p.hyphens = vl; break;
      }
      case '-webkit-line-clamp': case 'line-clamp': {
        if (vl !== 'none') { var lcv = parseInt(vl); if (!isNaN(lcv) && lcv > 0) p.lineClamp = lcv; }
        else p.lineClamp = undefined;
        break;
      }
      case 'quotes': { p.quotes = val; break; }

      // ── Layout / interaction helpers ──────────────────────────────────────
      case 'isolation': { p.isolation = vl === 'isolate' ? 'isolate' : 'auto'; break; }
      case 'touch-action': { p.touchAction = vl; break; }
      case 'color-scheme': { p.colorScheme = val; break; }

      // ── SVG CSS properties ────────────────────────────────────────────────
      case 'fill':         { p.fill        = val; break; }
      case 'stroke':       { p.stroke      = val; break; }
      case 'stroke-width': {
        var swv2 = parseLengthPx(vl); if (!isNaN(swv2)) p.strokeWidth = swv2; break;
      }

      // ── Accepted no-ops (property known but not yet rendered) ─────────────
      case 'text-rendering':             break; // rendering hint
      case 'text-size-adjust':           break; // mobile zoom hint
      case '-webkit-text-size-adjust':   break;
      case '-ms-text-size-adjust':       break;
      case 'break-before':               break; // column/page break hint
      case 'break-after':                break;
      case 'break-inside':               break;
      case 'page-break-before':          break;
      case 'page-break-after':           break;
      case 'page-break-inside':          break;
      case 'box-decoration-break':       break;
      case '-webkit-overflow-scrolling': break; // legacy iOS momentum scroll
      case 'scrollbar-width':            break; // custom scrollbar
      case 'scrollbar-color':            break;
      case 'scrollbar-gutter':           break;
      case 'scroll-behavior':            break;
      case 'scroll-snap-type':           break;
      case 'scroll-snap-align':          break;
      case 'scroll-snap-stop':           break;
      case 'scroll-margin':              break;
      case 'scroll-padding':             break;
      case 'overscroll-behavior':        break;
      case 'overscroll-behavior-x':      break;
      case 'overscroll-behavior-y':      break;
      case '-webkit-font-smoothing':     break; // antialiasing hint
      case '-moz-osx-font-smoothing':    break;
      case 'font-optical-sizing':        break;
      case 'font-synthesis':             break;
      case 'forced-color-adjust':        break; // Windows HCM
      case 'print-color-adjust':         break;
      case 'color-interpolation':        break; // SVG hint
      case 'shape-rendering':            break; // SVG hint
      case 'dominant-baseline':          break; // SVG text
      case 'text-anchor':                break; // SVG text
      case 'paint-order':                break; // SVG paint order
      case 'marker': case 'marker-start': case 'marker-end': case 'marker-mid': break;
      case 'writing-mode':               break; // vertical text stub
      case 'direction':                  break; // RTL/LTR stub
      case 'unicode-bidi':               break; // BiDi stub
      case 'caption-side':               break; // table stub
      case 'empty-cells':                break; // table stub
      case 'speak':                      break; // aural CSS
      // ── Modern/experimental no-ops ────────────────────────────────────────
      case 'content-visibility':         break; // rendering optimization
      case 'contain-intrinsic-size':     break;
      case 'contain-intrinsic-width':    break;
      case 'contain-intrinsic-height':   break;
      // Note: 'contain', 'mix-blend-mode', 'backdrop-filter' handled below with real logic
      case 'text-wrap':                  break; // text-wrap: balance/pretty
      case 'text-wrap-mode':             break;
      case 'text-wrap-style':            break;
      case 'text-box':                   break; // CSS text-box-trim
      case 'text-box-trim':              break;
      case 'text-box-edge':              break;
      case 'text-spacing-trim':          break;
      case 'anchor-name':                break; // CSS anchor positioning
      case 'anchor-scope':               break;
      case 'position-anchor':            break;
      case 'position-area':              break;
      case 'position-try':               break;
      case 'position-try-fallbacks':     break;
      case 'position-visibility':        break;
      case 'field-sizing':               break; // CSS form sizing
      case 'interpolate-size':           break; // intrinsic size animations
      case 'counter-set':                break; // CSS counter-set
      case 'user-modify':                break; // legacy editable
      case '-webkit-user-modify':        break;
      case 'rotate':                     break; // individual transform props (stored in transform)
      case 'scale':                      break;
      case 'translate':                  break;
      case 'offset':                     break; // motion path
      case 'offset-path':                break;
      case 'offset-distance':            break;
      case 'offset-rotate':              break;
      case 'offset-anchor':              break;
      case 'motion-path':                break;
      case 'shape-outside':              break; // float shapes
      case 'shape-margin':               break;
      case 'shape-image-threshold':      break;
      case '-webkit-tap-highlight-color': break; // iOS tap highlight
      case '-webkit-touch-callout':      break;
      case 'orphans': case 'widows':     break; // paged media
      case 'image-orientation':          break;
      case 'image-resolution':           break;
      case 'text-underline-offset':      break;
      case 'text-underline-position':    break;
      case 'text-decoration-thickness':  break;
      case 'text-decoration-skip-ink':   break;
      case 'text-emphasis':              break;
      case 'text-emphasis-color':        break;
      case 'text-emphasis-style':        break;
      case 'text-emphasis-position':     break;
      case '-webkit-text-stroke':        break;
      case '-webkit-text-stroke-width':  break;
      case '-webkit-text-stroke-color':  break;
      case '-webkit-text-fill-color':    break;
      case 'background-blend-mode':      break;
      case 'mask': case 'mask-image': case 'mask-size': case 'mask-repeat':
      case 'mask-position': case 'mask-composite': case 'mask-mode': break;
      case 'clip':                       break; // legacy clip rect()
      case 'all':                        break; // CSS reset shorthand
      case 'perspective':                break; // 3D perspective
      case 'perspective-origin':         break;
      case 'transform-style':            break; // flat / preserve-3d
      case 'transform-box':              break;
      case 'backface-visibility':        break;
      case '-webkit-backface-visibility': break;
      case '-webkit-perspective':        break;
      case '-webkit-transform-style':    break;
      case 'border-image':               break; // border image shorthand
      case 'border-image-source':        break;
      case 'border-image-slice':         break;
      case 'border-image-width':         break;
      case 'border-image-outset':        break;
      case 'border-image-repeat':        break;
      case 'column-rule':                break; // column rule between columns
      case 'column-rule-color':          break;
      case 'column-rule-style':          break;
      case 'column-rule-width':          break;
      case 'column-fill':                break;
      case 'column-span':                break;
      case '-webkit-column-count':       break;
      case '-webkit-column-width':       break;
      case '-webkit-column-rule':        break;
      case '-moz-column-count':          break;
      case '-moz-column-width':          break;
      case '-moz-column-rule':           break;
      case 'math-style': case 'math-depth': break; // MathML
      case 'page': case 'size': break; // @page rules
      case 'speak-as': break; // aural extended
      case 'nav-up': case 'nav-down': case 'nav-left': case 'nav-right': break; // D-pad nav

      // border-[side] shorthands: map to unified border props (renderer uses single border)
      case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': {
        var bsparts = val.trim().split(/\s+/);
        for (var bspi = 0; bspi < bsparts.length; bspi++) {
          var bsp = bsparts[bspi].toLowerCase();
          if (bsp === 'none' || bsp === 'hidden') { p.borderWidth = 0; p.borderStyle = bsp; continue; }
          var bswv = parseLengthPx(bsp);
          if (!isNaN(bswv)) { p.borderWidth = bswv; continue; }
          var bscc = parseCSSColor(bsp); if (bscc !== undefined) { p.borderColor = bscc; continue; }
          if (bsp === 'solid' || bsp === 'dashed' || bsp === 'dotted' || bsp === 'double') p.borderStyle = bsp;
        }
        break;
      }
      case 'border-top-color': case 'border-right-color': case 'border-bottom-color': case 'border-left-color': {
        var bscv = parseCSSColor(vl); if (bscv !== undefined) p.borderColor = bscv; break;
      }
      case 'border-top-style': case 'border-right-style': case 'border-bottom-style': case 'border-left-style': {
        if (vl === 'none' || vl === 'hidden') { p.borderWidth = 0; p.borderStyle = vl; }
        else if (vl === 'solid' || vl === 'dashed' || vl === 'dotted' || vl === 'double') p.borderStyle = vl;
        break;
      }

      // ── Position ──────────────────────────────────────────────────────────
      case 'position': {
        if (vl === 'static' || vl === 'relative' || vl === 'absolute' || vl === 'fixed' || vl === 'sticky')
          p.position = vl as CSSProps['position']; break;
      }
      case 'top':    { if (vl !== 'auto') { var tv = parseLengthPx(vl); if (!isNaN(tv)) p.top    = tv; } break; }
      case 'right':  { if (vl !== 'auto') { var rv = parseLengthPx(vl); if (!isNaN(rv)) p.right  = rv; } break; }
      case 'bottom': { if (vl !== 'auto') { var bv = parseLengthPx(vl); if (!isNaN(bv)) p.bottom = bv; } break; }
      case 'left':   { if (vl !== 'auto') { var lv = parseLengthPx(vl); if (!isNaN(lv)) p.left   = lv; } break; }
      case 'z-index': {
        if (vl !== 'auto') { var zv = parseInt(vl); if (!isNaN(zv)) p.zIndex = zv; } break;
      }
      case 'float': {
        if (vl === 'left' || vl === 'right') p.float = vl;
        else if (vl === 'none') p.float = 'none'; break;
      }
      case 'clear': {
        if (vl === 'left' || vl === 'right' || vl === 'both') p.clear = vl as CSSProps['clear'];
        else p.clear = 'none'; break;
      }

      // ── Overflow ──────────────────────────────────────────────────────────
      case 'overflow': {
        if (vl === 'visible' || vl === 'hidden' || vl === 'scroll' || vl === 'auto')
          p.overflow = vl; break;
      }
      case 'overflow-x': {
        if (vl === 'visible' || vl === 'hidden' || vl === 'scroll' || vl === 'auto')
          p.overflowX = vl; break;
      }
      case 'overflow-y': {
        if (vl === 'visible' || vl === 'hidden' || vl === 'scroll' || vl === 'auto')
          p.overflowY = vl; break;
      }

      // ── Shadow / visual effects ───────────────────────────────────────────
      case 'box-shadow':  { p.boxShadow  = vl === 'none' ? undefined : val; break; }
      case 'text-shadow': { p.textShadow = vl === 'none' ? undefined : val; break; }
      case 'filter': case '-webkit-filter': {
        p.filter = vl === 'none' ? undefined : val; break;
      }
      case 'clip-path': case '-webkit-clip-path': {
        p.clipPath = vl === 'none' ? undefined : val; break;
      }
      case 'backdrop-filter': case '-webkit-backdrop-filter': {
        p.backdropFilter = vl === 'none' ? undefined : val; break;
      }
      case 'mix-blend-mode': { p.mixBlendMode = vl === 'normal' ? undefined : vl; break; }
      case 'resize': {
        if (vl === 'none' || vl === 'both' || vl === 'horizontal' || vl === 'vertical')
          p.resize = vl as CSSProps['resize'];
        else p.resize = 'none'; break;
      }
      case 'will-change': { p.willChange = vl === 'auto' ? undefined : val; break; }
      case 'contain':     { p.contain = vl === 'none' ? undefined : val; break; }

      // ── Transform / transition ────────────────────────────────────────────
      case 'transform':         { p.transform        = val; break; }
      case 'transform-origin':  { p.transformOrigin  = val; break; }
      case '-webkit-transform-origin': { if (!p.transformOrigin) p.transformOrigin = val; break; }
      case 'transition':        { p.transition        = val; break; }
      case 'transition-property':        { p.transitionProperty        = val; break; }
      case 'transition-duration':        { p.transitionDuration        = val; break; }
      case 'transition-timing-function': { p.transitionTimingFunction  = val; break; }
      case 'transition-delay':           { p.transitionDelay           = val; break; }
      case '-webkit-transition':                    { if (!p.transition)       p.transition       = val; break; }
      case '-webkit-transition-property':           { if (!p.transitionProperty) p.transitionProperty = val; break; }
      case '-webkit-transition-duration':           { if (!p.transitionDuration) p.transitionDuration = val; break; }
      case '-webkit-transition-timing-function':    { if (!p.transitionTimingFunction) p.transitionTimingFunction = val; break; }
      case '-webkit-transition-delay':              { if (!p.transitionDelay)    p.transitionDelay    = val; break; }
      case 'animation':         { p.animation         = val; break; }
      case 'animation-name':             { p.animationName            = val; break; }
      case 'animation-duration':         { p.animationDuration        = val; break; }
      case 'animation-timing-function':  { p.animationTimingFunction  = val; break; }
      case 'animation-delay':            { p.animationDelay           = val; break; }
      case 'animation-iteration-count':  { p.animationIterationCount  = val; break; }
      case 'animation-direction':        { p.animationDirection       = val; break; }
      case 'animation-fill-mode':        { p.animationFillMode        = val; break; }
      case 'animation-play-state':       { p.animationPlayState       = val; break; }
      case '-webkit-animation':                   { if (!p.animation) p.animation = val; break; }
      case '-webkit-animation-name':              { if (!p.animationName) p.animationName = val; break; }
      case '-webkit-animation-duration':          { if (!p.animationDuration) p.animationDuration = val; break; }
      case '-webkit-animation-timing-function':   { if (!p.animationTimingFunction) p.animationTimingFunction = val; break; }
      case '-webkit-animation-delay':             { if (!p.animationDelay) p.animationDelay = val; break; }
      case '-webkit-animation-iteration-count':   { if (!p.animationIterationCount) p.animationIterationCount = val; break; }
      case '-webkit-animation-direction':         { if (!p.animationDirection) p.animationDirection = val; break; }
      case '-webkit-animation-fill-mode':         { if (!p.animationFillMode) p.animationFillMode = val; break; }
      case '-webkit-animation-play-state':        { if (!p.animationPlayState) p.animationPlayState = val; break; }

      // ── Cursor / pointer events ───────────────────────────────────────────
      case 'cursor':         { p.cursor        = vl; break; }
      case 'pointer-events': {
        if (vl === 'none') p.pointerEvents = 'none';
        else p.pointerEvents = 'auto'; break;
      }

      // ── Flexbox ───────────────────────────────────────────────────────────
      case 'flex': {
        // flex: [flex-grow] [flex-shrink] [flex-basis]  OR  flex: none/auto
        if (vl === 'none') { p.flexGrow = 0; p.flexShrink = 0; p.flexBasis = 0; }
        else if (vl === 'auto') { p.flexGrow = 1; p.flexShrink = 1; p.flexBasis = 0; }
        else {
          var fparts = vl.split(/\s+/);
          var fg = parseFloat(fparts[0] || '0'); if (!isNaN(fg)) p.flexGrow = fg;
          var fs = parseFloat(fparts[1] || '1'); if (!isNaN(fs)) p.flexShrink = fs;
          var fb = parseLengthPx(fparts[2] || '0'); if (!isNaN(fb)) p.flexBasis = fb;
        }
        break;
      }
      case 'flex-grow':   { var fgv = parseFloat(vl); if (!isNaN(fgv)) p.flexGrow   = fgv; break; }
      case 'flex-shrink': { var fsv2 = parseFloat(vl); if (!isNaN(fsv2)) p.flexShrink = fsv2; break; }
      case 'flex-basis':  { if (vl !== 'auto') { var fbv = parseLengthPx(vl); if (!isNaN(fbv)) p.flexBasis = fbv; } break; }
      case 'flex-direction': {
        if (vl === 'row' || vl === 'row-reverse' || vl === 'column' || vl === 'column-reverse')
          p.flexDirection = vl as CSSProps['flexDirection']; break;
      }
      case 'flex-wrap': {
        if (vl === 'nowrap' || vl === 'wrap' || vl === 'wrap-reverse') p.flexWrap = vl; break;
      }
      case 'flex-flow': {
        // Shorthand for flex-direction + flex-wrap
        var ffparts = vl.split(/\s+/);
        for (var ffi = 0; ffi < ffparts.length; ffi++) {
          var ffp = ffparts[ffi];
          if (ffp === 'row' || ffp === 'row-reverse' || ffp === 'column' || ffp === 'column-reverse')
            p.flexDirection = ffp as CSSProps['flexDirection'];
          else if (ffp === 'nowrap' || ffp === 'wrap' || ffp === 'wrap-reverse')
            p.flexWrap = ffp as CSSProps['flexWrap'];
        }
        break;
      }
      case 'justify-content': { p.justifyContent = vl; break; }
      case 'align-items':     { p.alignItems     = vl; break; }
      case 'align-content':   { p.alignContent   = vl; break; }
      case 'align-self':      { p.alignSelf      = vl; break; }
      case 'order':           { var ov = parseInt(vl); if (!isNaN(ov)) p.order = ov; break; }
      case 'gap': case 'grid-gap': {
        var [gv,_gv2] = parseBox4(val);
        p.gap = isNaN(gv) ? 0 : gv; break;
      }
      case 'row-gap':    case 'grid-row-gap':    { var rgv = parseLengthPx(vl); if (!isNaN(rgv)) p.rowGap    = rgv; break; }
      case 'column-gap': case 'grid-column-gap': { var cgv = parseLengthPx(vl); if (!isNaN(cgv)) p.columnGap = cgv; break; }

      // ── Grid ──────────────────────────────────────────────────────────────
      case 'grid-template-columns': { p.gridTemplateColumns = val; break; }
      case 'grid-template-rows':    { p.gridTemplateRows    = val; break; }
      case 'grid-template-areas':   { p.gridTemplateAreas   = val; break; }
      case 'grid-auto-columns':     { p.gridAutoColumns     = val; break; }
      case 'grid-auto-rows':        { p.gridAutoRows        = val; break; }
      case 'grid-auto-flow':        { p.gridAutoFlow        = val; break; }
      case 'grid-column':           { p.gridColumn          = val; break; }
      case 'grid-row':              { p.gridRow             = val; break; }
      case 'grid-column-start':     { p.gridColumnStart     = val; break; }
      case 'grid-column-end':       { p.gridColumnEnd       = val; break; }
      case 'grid-row-start':        { p.gridRowStart        = val; break; }
      case 'grid-row-end':          { p.gridRowEnd          = val; break; }
      case 'grid-area':             { p.gridArea            = val; break; }
      case 'grid-template': case 'grid': break;  // complex shorthand — no-op silencer
      case 'justify-items':  { p.justifyItems  = vl; break; }
      case 'justify-self':   { p.justifySelf   = vl; break; }
      case 'place-items':    { p.placeItems    = val; break; }
      case 'place-content':  { p.placeContent  = val; break; }
      case 'place-self':     { p.placeSelf     = val; break; }

      // ── Vendor prefixes → standard property aliases ───────────────────────
      case '-webkit-flex-direction': case '-moz-flex-direction':
        { var vfp = vl; if (vfp==='row'||vfp==='column'||vfp==='row-reverse'||vfp==='column-reverse') p.flexDirection = vfp as CSSProps['flexDirection']; break; }
      case '-webkit-align-items': case '-ms-flex-align':
        p.alignItems = vl; break;
      case '-webkit-justify-content': case '-ms-flex-pack':
        p.justifyContent = vl; break;
      case '-webkit-flex-wrap': p.flexWrap = vl as CSSProps['flexWrap']; break;
      case '-webkit-transform': if (!p.transform) p.transform = val; break;
      case '-webkit-border-radius': case '-moz-border-radius': {
        var vbr = parseLengthPx(vl); if (!isNaN(vbr)) p.borderRadius = vbr; break;
      }
      case '-webkit-box-shadow': case '-moz-box-shadow':
        if (!p.boxShadow && vl !== 'none') p.boxShadow = val; break;

      default: matched = false; break;
    }
    if (isImportant && matched) {
      if (!important) important = new Set();
      important.add(prop);
    }
  }
  if (important) p.important = important;
  return p;
}
