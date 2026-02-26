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
 * Parse a CSS color string (named, #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba())
 * and return it as a 32-bit ARGB pixel value, or undefined if unrecognised.
 */
export function parseCSSColor(val: string): number | undefined {
  val = val.trim().toLowerCase();
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
  return undefined;
}

/**
 * Evaluate a simple CSS `calc()` expression.
 * Handles: px arithmetic, %, em (1em=16px), rem (1rem=16px).
 * Returns NaN if expression is too complex to evaluate.
 */
export function evalCalc(expr: string): number {
  var s = expr.replace(/calc\(/g, '(').replace(/\s+/g, ' ').trim();
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

    // Handle global keywords
    if (vl === 'inherit' || vl === 'initial' || vl === 'unset' || vl === 'revert') {
      // Mark as explicit reset — let cascade handle it via !important tracking
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
        // background shorthand — extract first color token, ignore image/pos/size
        var bgParts = val.split(/\s+/);
        for (var bpi = 0; bpi < bgParts.length; bpi++) {
          var bgCol = parseCSSColor(bgParts[bpi].toLowerCase());
          if (bgCol !== undefined) { p.bgColor = bgCol; break; }
        }
        // Also check for url(...)
        var urlM = val.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i);
        if (urlM) p.backgroundImage = 'url(' + urlM[1] + ')';
        break;
      }
      case 'background-image': {
        p.backgroundImage = val; break;
      }
      case 'background-size':     { p.backgroundSize     = val; break; }
      case 'background-position': { p.backgroundPosition = val; break; }
      case 'background-repeat':   { p.backgroundRepeat   = val; break; }

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
        if (fpsz) { var fszv = parseLengthPx(fpsz[1]); if (!isNaN(fszv)) p.fontScale = fszv < 12 ? 0.75 : fszv < 16 ? 1 : fszv < 24 ? 2 : 3; }
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
      case 'outline-style': break; // stored as part of border render — ignored separately
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
      case 'animation':         { p.animation         = val; break; }

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
      case 'grid-column':           { p.gridColumn          = val; break; }
      case 'grid-row':              { p.gridRow             = val; break; }
      case 'grid-area':             { p.gridArea            = val; break; }

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
