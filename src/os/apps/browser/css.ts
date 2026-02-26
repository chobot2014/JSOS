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
 * Parse an inline `style="..."` attribute string into a CSSProps bag.
 * Only properties that affect text/block rendering are extracted.
 */
export function parseInlineStyle(style: string): CSSProps {
  var p: CSSProps = {};
  var decls = style.split(';');
  for (var di = 0; di < decls.length; di++) {
    var col = decls[di].indexOf(':');
    if (col < 0) continue;
    var prop = decls[di].slice(0, col).trim().toLowerCase();
    var val  = decls[di].slice(col + 1).trim();

    // Register CSS custom property
    if (prop.startsWith('--')) { _cssVars[prop] = val; continue; }

    // Resolve var() references before processing
    val = resolveCSSVars(val);
    var vl   = val.toLowerCase();
    switch (prop) {
      case 'color': {
        var c = parseCSSColor(vl);
        if (c !== undefined) p.color = c;
        break;
      }
      case 'background-color':
      case 'background': {
        var bg = parseCSSColor(vl.split(' ')[0]!);
        if (bg !== undefined) p.bgColor = bg;
        break;
      }
      case 'font-weight':
        if (vl === 'bold' || vl === 'bolder' || parseInt(vl) >= 600) p.bold = true;
        break;
      case 'font-style':
        if (vl === 'italic' || vl === 'oblique') p.italic = true;
        break;
      case 'text-decoration':
        if (vl.indexOf('underline')    >= 0) p.underline = true;
        if (vl.indexOf('line-through') >= 0) p.strike    = true;
        break;
      case 'text-align':
        if (vl === 'center' || vl === 'right' || vl === 'left')
          p.align = vl as 'left' | 'center' | 'right';
        break;
      case 'display':
        if (vl === 'none')                             p.hidden  = true;
        else if (vl === 'flex' || vl === 'inline-flex') p.display = vl as 'flex';
        else if (vl === 'grid')                        p.display = 'grid';
        else if (vl === 'inline-block')                p.display = 'inline-block';
        break;
      case 'visibility': if (vl === 'hidden' || vl === 'collapse') p.hidden = true; break;
      case 'float':
        if (vl === 'left' || vl === 'right') p.float = vl;
        break;
      case 'padding-left': case 'padding-inline-start': {
        var plv = parseFloat(vl); if (plv > 0) p.paddingLeft = plv;
        break;
      }
      case 'padding-right': case 'padding-inline-end': {
        var prv = parseFloat(vl); if (prv > 0) p.paddingRight = prv;
        break;
      }
      case 'padding-top': {
        var ptv = parseFloat(vl); if (ptv > 0) p.paddingTop = ptv;
        break;
      }
      case 'padding-bottom': {
        var pbv = parseFloat(vl); if (pbv > 0) p.paddingBottom = pbv;
        break;
      }
      case 'padding': {
        var pavg = parseFloat(vl); if (pavg > 0) {
          p.paddingTop = pavg; p.paddingBottom = pavg;
          p.paddingLeft = pavg; p.paddingRight = pavg;
        }
        break;
      }
      case 'margin-top': {
        var mtv = parseFloat(vl); if (!isNaN(mtv) && mtv > 0) p.marginTop = mtv;
        break;
      }
      case 'margin-bottom': {
        var mbv = parseFloat(vl); if (!isNaN(mbv) && mbv > 0) p.marginBottom = mbv;
        break;
      }
      case 'width': {
        if (vl !== 'auto' && vl !== '100%') { var wv = parseFloat(vl); if (wv > 0) p.width = wv; }
        break;
      }
      case 'max-width': {
        if (vl !== 'none') { var mwv = parseFloat(vl); if (mwv > 0) p.maxWidth = mwv; }
        break;
      }
      case 'font-size': {
        // Map CSS font-size to fontScale: <12px=0.75, 12-15=1, 16-23=2, >=24=3
        var fsv = parseFloat(vl);
        if (!isNaN(fsv)) {
          // Handle em/rem — treat 1em = 16px
          if (vl.endsWith('em')) fsv = fsv * 16;
          else if (vl.endsWith('%')) fsv = (fsv / 100) * 16;
          p.fontScale = fsv < 12 ? 0.75 : fsv < 16 ? 1 : fsv < 24 ? 2 : 3;
        } else if (vl === 'small' || vl === 'x-small') { p.fontScale = 0.75; }
        else if (vl === 'medium') { p.fontScale = 1; }
        else if (vl === 'large' || vl === 'x-large') { p.fontScale = 2; }
        else if (vl === 'xx-large') { p.fontScale = 3; }
        break;
      }
      case 'opacity': {
        // Opacity < 0.15 hides; we keep it simple
        var opv = parseFloat(vl);
        if (!isNaN(opv) && opv < 0.15) p.hidden = true;
        break;
      }
    }
  }
  return p;
}
