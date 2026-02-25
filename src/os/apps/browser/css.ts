import type { CSSProps } from './types.js';

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
  var m = val.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return 0xFF000000 | (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
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
      case 'display':    if (vl === 'none')                    p.hidden = true; break;
      case 'visibility': if (vl === 'hidden' || vl === 'collapse') p.hidden = true; break;
    }
  }
  return p;
}
