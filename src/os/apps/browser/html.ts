import type {
  HtmlToken, ParseResult, RenderNode, InlineSpan, BlockType,
  WidgetBlueprint, WidgetKind, FormState, CSSProps, ScriptRecord, DecodedImage,
} from './types.js';
import { parseInlineStyle } from './css.js';
import { isGradient } from './gradient.js';
import { type CSSRule, computeElementStyle, getPseudoContent } from './stylesheet.js';
import { renderSVG } from './svg.js';

// ── HTML5 Named Entity Table (items 350–351) ──────────────────────────────────
// ISO 8859-1, HTML 4 + common HTML5 named character references.

const _ENTITIES: Record<string, string> = {
  // Essential
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // Spaces / invisible
  nbsp: '\u00A0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  zwnj: '\u200C', zwj: '\u200D', lrm: '\u200E', rlm: '\u200F',
  // Latin-1 supplement
  iexcl: '\u00A1', cent: '\u00A2', pound: '\u00A3', curren: '\u00A4',
  yen: '\u00A5', brvbar: '\u00A6', sect: '\u00A7', uml: '\u00A8',
  copy: '\u00A9', ordf: '\u00AA', laquo: '\u00AB', not: '\u00AC',
  shy: '\u00AD', reg: '\u00AE', macr: '\u00AF', deg: '\u00B0',
  plusmn: '\u00B1', sup2: '\u00B2', sup3: '\u00B3', acute: '\u00B4',
  micro: '\u00B5', para: '\u00B6', middot: '\u00B7', cedil: '\u00B8',
  sup1: '\u00B9', ordm: '\u00BA', raquo: '\u00BB', frac14: '\u00BC',
  frac12: '\u00BD', frac34: '\u00BE', iquest: '\u00BF',
  Agrave: '\u00C0', Aacute: '\u00C1', Acirc: '\u00C2', Atilde: '\u00C3',
  Auml: '\u00C4', Aring: '\u00C5', AElig: '\u00C6', Ccedil: '\u00C7',
  Egrave: '\u00C8', Eacute: '\u00C9', Ecirc: '\u00CA', Euml: '\u00CB',
  Igrave: '\u00CC', Iacute: '\u00CD', Icirc: '\u00CE', Iuml: '\u00CF',
  ETH: '\u00D0', Ntilde: '\u00D1', Ograve: '\u00D2', Oacute: '\u00D3',
  Ocirc: '\u00D4', Otilde: '\u00D5', Ouml: '\u00D6', times: '\u00D7',
  Oslash: '\u00D8', Ugrave: '\u00D9', Uacute: '\u00DA', Ucirc: '\u00DB',
  Uuml: '\u00DC', Yacute: '\u00DD', THORN: '\u00DE', szlig: '\u00DF',
  agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2', atilde: '\u00E3',
  auml: '\u00E4', aring: '\u00E5', aelig: '\u00E6', ccedil: '\u00E7',
  egrave: '\u00E8', eacute: '\u00E9', ecirc: '\u00EA', euml: '\u00EB',
  igrave: '\u00EC', iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF',
  eth: '\u00F0', ntilde: '\u00F1', ograve: '\u00F2', oacute: '\u00F3',
  ocirc: '\u00F4', otilde: '\u00F5', ouml: '\u00F6', divide: '\u00F7',
  oslash: '\u00F8', ugrave: '\u00F9', uacute: '\u00FA', ucirc: '\u00FB',
  uuml: '\u00FC', yacute: '\u00FD', thorn: '\u00FE', yuml: '\u00FF',
  // Greek
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398',
  Iota: '\u0399', Kappa: '\u039A', Lambda: '\u039B', Mu: '\u039C',
  Nu: '\u039D', Xi: '\u039E', Omicron: '\u039F', Pi: '\u03A0',
  Rho: '\u03A1', Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5',
  Phi: '\u03A6', Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9',
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4',
  epsilon: '\u03B5', zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8',
  iota: '\u03B9', kappa: '\u03BA', lambda: '\u03BB', mu: '\u03BC',
  nu: '\u03BD', xi: '\u03BE', omicron: '\u03BF', pi: '\u03C0',
  rho: '\u03C1', sigmaf: '\u03C2', sigma: '\u03C3', tau: '\u03C4',
  upsilon: '\u03C5', phi: '\u03C6', chi: '\u03C7', psi: '\u03C8',
  omega: '\u03C9', thetasym: '\u03D1', upsih: '\u03D2', piv: '\u03D6',
  // General punctuation / typography
  bull: '\u2022', hellip: '\u2026', prime: '\u2032', Prime: '\u2033',
  oline: '\u203E', frasl: '\u2044',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  sbquo: '\u201A', ldquo: '\u201C', rdquo: '\u201D', bdquo: '\u201E',
  dagger: '\u2020', Dagger: '\u2021', trade: '\u2122',
  lsaquo: '\u2039', rsaquo: '\u203A',
  // Letterlike / math
  weierp: '\u2118', image: '\u2111', real: '\u211C', alefsym: '\u2135',
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193',
  harr: '\u2194', crarr: '\u21B5',
  lArr: '\u21D0', uArr: '\u21D1', rArr: '\u21D2', dArr: '\u21D3', hArr: '\u21D4',
  forall: '\u2200', part: '\u2202', exist: '\u2203', empty: '\u2205',
  nabla: '\u2207', isin: '\u2208', notin: '\u2209', ni: '\u220B',
  prod: '\u220F', sum: '\u2211', minus: '\u2212', lowast: '\u2217',
  radic: '\u221A', prop: '\u221D', infin: '\u221E', ang: '\u2220',
  and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222A',
  int: '\u222B', there4: '\u2234', sim: '\u223C', cong: '\u2245',
  asymp: '\u2248', ne: '\u2260', equiv: '\u2261', le: '\u2264', ge: '\u2265',
  sub: '\u2282', sup: '\u2283', nsub: '\u2284', sube: '\u2286', supe: '\u2287',
  oplus: '\u2295', otimes: '\u2297', perp: '\u22A5', sdot: '\u22C5',
  // Shapes / suits
  loz: '\u25CA', spades: '\u2660', clubs: '\u2663', hearts: '\u2665',
  diams: '\u2666',
  // Geometric / misc
  lceil: '\u2308', rceil: '\u2309', lfloor: '\u230A', rfloor: '\u230B',
  lang: '\u2329', rang: '\u232A',
  // OE / special letters
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161',
  Yuml: '\u0178', fnof: '\u0192', circ: '\u02C6', tilde: '\u02DC',
};

/**
 * Decode HTML entities in a raw text node.
 * Handles named entities, decimal &#NNN; and hex &#xNNN; references.
 * O(n log m) — single regex pass over text + Map lookup.
 */
function _decodeEntities(raw: string): string {
  return raw.replace(/&(?:([a-zA-Z][a-zA-Z0-9]*)|#([0-9]{1,7})|#x([0-9a-fA-F]{1,6}));/g,
    (_m: string, name: string, dec: string, hex: string): string => {
      if (name) { var r = _ENTITIES[name]; return r !== undefined ? r : _m; }
      if (dec)  return String.fromCodePoint(parseInt(dec, 10));
      if (hex)  return String.fromCodePoint(parseInt(hex, 16));
      return _m;
    });
}

// ── Tokeniser ─────────────────────────────────────────────────────────────────

export function tokenise(html: string): HtmlToken[] {
  var tokens: HtmlToken[] = [];
  var n = html.length;
  var i = 0;

  function skipWS(): void {
    while (i < n && (html[i] === ' ' || html[i] === '\t' ||
                     html[i] === '\n' || html[i] === '\r')) i++;
  }
  function readAttrValue(): string {
    if (i >= n) return '';
    if (html[i] === '"' || html[i] === "'") {
      var q = html[i++]; var v = '';
      while (i < n && html[i] !== q) v += html[i++];
      if (i < n) i++;
      return v;
    }
    var v2 = '';
    while (i < n && html[i] !== '>' && html[i] !== ' ' &&
           html[i] !== '\t' && html[i] !== '\n') v2 += html[i++];
    return v2;
  }
  function readTag(): HtmlToken | null {
    i++;
    var close = false;
    if (html[i] === '/') { close = true; i++; }
    if (html[i] === '!' || html[i] === '?') {
      while (i < n && html[i] !== '>') i++;
      if (i < n) i++;
      return null;
    }
    var tag = '';
    while (i < n && html[i] !== '>' && html[i] !== '/' &&
           html[i] !== ' ' && html[i] !== '\t' && html[i] !== '\n')
      tag += html[i++];
    tag = tag.toLowerCase();
    var attrs = new Map<string, string>();
    skipWS();
    while (i < n && html[i] !== '>' && html[i] !== '/') {
      var nm = '';
      while (i < n && html[i] !== '=' && html[i] !== '>' &&
             html[i] !== '/' && html[i] !== ' ' &&
             html[i] !== '\t' && html[i] !== '\n') nm += html[i++];
      nm = nm.toLowerCase().trim();
      skipWS();
      var vl = '';
      if (i < n && html[i] === '=') { i++; skipWS(); vl = readAttrValue(); }
      if (nm) attrs.set(nm, vl);
      skipWS();
    }
    var self = false;
    if (i < n && html[i] === '/') { self = true; i++; }
    if (i < n && html[i] === '>') i++;
    var kind: 'open' | 'close' | 'self' = close ? 'close' : (self ? 'self' : 'open');
    return { kind, tag, text: '', attrs };
  }

  while (i < n) {
    if (html[i] === '<') {
      var tok = readTag();
      if (tok) {
        tokens.push(tok);
        // ── Raw-text elements: <script> and <style> ─────────────────────────
        // Per HTML5 spec, content inside these elements must NOT be parsed as
        // HTML — '<' and '&' are literal characters until the matching close
        // tag.  Without this, `rafId <= 0` would be parsed as a tag '<= 0…>'
        // and the script content would be silently corrupted.
        if (tok.kind === 'open' && (tok.tag === 'script' || tok.tag === 'style')) {
          var closeTag = '</' + tok.tag;
          var htmlLC = html.toLowerCase();
          var closeIdx = htmlLC.indexOf(closeTag, i);
          var rawEnd = closeIdx >= 0 ? closeIdx : n;
          var rawContent = html.slice(i, rawEnd);
          if (rawContent) {
            // No entity decoding — script/style content is raw text
            tokens.push({ kind: 'text', tag: '', text: rawContent, attrs: new Map() });
          }
          i = rawEnd; // advance past raw content; close tag parsed next
        }
      }
    } else {
      var start = i;
      while (i < n && html[i] !== '<') i++;
      var raw = html.slice(start, i);
      var dec = _decodeEntities(raw);
      tokens.push({ kind: 'text', tag: '', text: dec, attrs: new Map() });
    }
  }
  return tokens;
}

// ── HTML parser ───────────────────────────────────────────────────────────────

export function parseHTML(html: string, sheets: CSSRule[] = []): ParseResult {
  var tokens   = tokenise(html);
  var nodes:   RenderNode[]      = [];
  var title    = '';
  var forms:   FormState[]       = [];
  var widgets: WidgetBlueprint[] = [];
  var scripts: ScriptRecord[]    = [];
  var styles:  string[]          = [];
  var styleLinks: string[]       = [];
  var baseURL  = '';
  var favicon  = '';   // href from <link rel="icon"> (item 628)

  // ── DOCTYPE quirks mode detection (item 349) ───────────────────────────────
  // Standards mode requires a valid HTML5 DOCTYPE: <!DOCTYPE html>.
  // Anything else (no DOCTYPE, legacy DOCTYPE) triggers quirks mode.
  var _dtMatch = /<!DOCTYPE\s+html\s*>/i.test(html.slice(0, 512));
  var quirksMode = !_dtMatch;

  // ── Template element support (item 357) ──────────────────────────────────── 
  var templates: Map<string, RenderNode[]> = new Map();
  var inTemplate     = false;
  var templateId     = '';
  var templateNodes: RenderNode[] = [];

  // ── CSS counter state (item 434) ─────────────────────────────────────────
  // Tracks named counter values for counter-reset / counter-increment / counter()
  var _counters = new Map<string, number>();

  function _applyCounters(css: { counterReset?: string; counterIncrement?: string }): void {
    if (css.counterReset) {
      var resets = css.counterReset.trim().split(/\s+/);
      for (var _ri = 0; _ri < resets.length; _ri += 1) {
        var _rn = resets[_ri]!;
        if (!_rn || _rn === 'none') continue;
        var _rv = (resets[_ri + 1] !== undefined && /^-?\d+$/.test(resets[_ri + 1]!))
          ? (parseInt(resets[++_ri]!, 10)) : 0;
        _counters.set(_rn, _rv);
      }
    }
    if (css.counterIncrement) {
      var incs = css.counterIncrement.trim().split(/\s+/);
      for (var _ii = 0; _ii < incs.length; _ii += 1) {
        var _in = incs[_ii]!;
        if (!_in || _in === 'none') continue;
        var _iv = (incs[_ii + 1] !== undefined && /^-?\d+$/.test(incs[_ii + 1]!))
          ? (parseInt(incs[++_ii]!, 10)) : 1;
        _counters.set(_in, (_counters.get(_in) ?? 0) + _iv);
      }
    }
  }

  var inTitle      = false;
  var inPre        = false;
  var inHead       = false;
  var inScript     = false;
  var inScriptType = '';
  var inScriptSrc  = '';
  var inScriptBuf  = '';
  var inStyle      = false;
  var inStyleBuf   = '';
  var skipUntilClose = '';  // skip all content until this close tag (iframe, video, etc.)
  // ── SVG inline tracking (item 371) ───────────────────────────────────────
  var inSVG      = false;
  var svgDepth   = 0;
  var svgBuf     = '';
  var svgWidth   = 300;
  var svgHeight  = 150;
  var bold      = 0;
  var italic    = 0;
  var codeInl   = 0;
  var del       = 0;
  var mark      = 0;
  var underline = 0;
  var listDepth = 0;
  var skipDepth = 0;   // CSS display:none depth

  // CSS inline style stack — pushed/popped on styled elements
  var cssStack: CSSProps[] = [];
  var curCSS:   CSSProps   = {};

  function pushCSS(p: CSSProps): void {
    cssStack.push({ ...curCSS });
    // ── Text / font ────────────────────────────────────────────────────────
    if (p.color     !== undefined) curCSS.color     = p.color;
    if (p.bgColor   !== undefined) curCSS.bgColor   = p.bgColor;
    if (p.bold      !== undefined) curCSS.bold      = p.bold;
    if (p.italic    !== undefined) curCSS.italic    = p.italic;
    if (p.underline !== undefined) curCSS.underline = p.underline;
    if (p.strike    !== undefined) curCSS.strike    = p.strike;
    if (p.align     !== undefined) curCSS.align     = p.align;
    if (p.hidden) { curCSS.hidden = true; skipDepth++; }
    else if (p.hidden === false && curCSS.hidden) { curCSS.hidden = false; skipDepth = Math.max(0, skipDepth - 1); }
    if (p.fontScale     !== undefined) curCSS.fontScale     = p.fontScale;
    if (p.fontFamily    !== undefined) curCSS.fontFamily    = p.fontFamily;
    if (p.fontWeight    !== undefined) curCSS.fontWeight    = p.fontWeight;
    if (p.lineHeight    !== undefined) curCSS.lineHeight    = p.lineHeight;
    if (p.letterSpacing !== undefined) curCSS.letterSpacing = p.letterSpacing;
    if (p.wordSpacing   !== undefined) curCSS.wordSpacing   = p.wordSpacing;
    if (p.textTransform !== undefined) curCSS.textTransform = p.textTransform;
    if (p.textDecoration !== undefined) curCSS.textDecoration = p.textDecoration;
    if (p.textOverflow  !== undefined) curCSS.textOverflow  = p.textOverflow;
    if (p.whiteSpace    !== undefined) curCSS.whiteSpace    = p.whiteSpace;
    if (p.verticalAlign !== undefined) curCSS.verticalAlign = p.verticalAlign;
    if (p.listStyleType !== undefined) curCSS.listStyleType = p.listStyleType;
    // ── Layout ─────────────────────────────────────────────────────────────
    if (p.display      !== undefined) curCSS.display      = p.display;
    if (p.boxSizing    !== undefined) curCSS.boxSizing    = p.boxSizing;
    if (p.float        !== undefined) curCSS.float        = p.float;
    if (p.width        !== undefined) curCSS.width        = p.width;
    if (p.height       !== undefined) curCSS.height       = p.height;
    if (p.minWidth     !== undefined) curCSS.minWidth     = p.minWidth;
    if (p.minHeight    !== undefined) curCSS.minHeight    = p.minHeight;
    if (p.maxWidth     !== undefined) curCSS.maxWidth     = p.maxWidth;
    if (p.maxHeight    !== undefined) curCSS.maxHeight    = p.maxHeight;
    if (p.paddingTop    !== undefined) curCSS.paddingTop    = p.paddingTop;
    if (p.paddingRight  !== undefined) curCSS.paddingRight  = p.paddingRight;
    if (p.paddingBottom !== undefined) curCSS.paddingBottom = p.paddingBottom;
    if (p.paddingLeft   !== undefined) curCSS.paddingLeft   = p.paddingLeft;
    if (p.marginTop    !== undefined) curCSS.marginTop    = p.marginTop;
    if (p.marginRight  !== undefined) curCSS.marginRight  = p.marginRight;
    if (p.marginBottom !== undefined) curCSS.marginBottom = p.marginBottom;
    if (p.marginLeft   !== undefined) curCSS.marginLeft   = p.marginLeft;
    // ── Border / visual ────────────────────────────────────────────────────
    if (p.borderWidth  !== undefined) curCSS.borderWidth  = p.borderWidth;
    if (p.borderStyle  !== undefined) curCSS.borderStyle  = p.borderStyle;
    if (p.borderColor  !== undefined) curCSS.borderColor  = p.borderColor;
    if (p.borderRadius !== undefined) curCSS.borderRadius = p.borderRadius;
    if (p.opacity      !== undefined) curCSS.opacity      = p.opacity;
    if (p.boxShadow    !== undefined) curCSS.boxShadow    = p.boxShadow;
    if (p.textShadow   !== undefined) curCSS.textShadow   = p.textShadow;
    // ── Position ───────────────────────────────────────────────────────────
    if (p.position !== undefined) curCSS.position = p.position;
    if (p.top      !== undefined) curCSS.top      = p.top;
    if (p.right    !== undefined) curCSS.right    = p.right;
    if (p.bottom   !== undefined) curCSS.bottom   = p.bottom;
    if (p.left     !== undefined) curCSS.left     = p.left;
    if (p.zIndex   !== undefined) curCSS.zIndex   = p.zIndex;
    if (p.overflow !== undefined) curCSS.overflow = p.overflow;
    // ── Flex ───────────────────────────────────────────────────────────────
    if (p.flexDirection  !== undefined) curCSS.flexDirection  = p.flexDirection;
    if (p.flexWrap       !== undefined) curCSS.flexWrap       = p.flexWrap;
    if (p.justifyContent !== undefined) curCSS.justifyContent = p.justifyContent;
    if (p.alignItems     !== undefined) curCSS.alignItems     = p.alignItems;
    if (p.flexGrow       !== undefined) curCSS.flexGrow       = p.flexGrow;
    if (p.flexShrink     !== undefined) curCSS.flexShrink     = p.flexShrink;
    if (p.flexBasis      !== undefined) curCSS.flexBasis      = p.flexBasis;
    if (p.alignSelf      !== undefined) curCSS.alignSelf      = p.alignSelf;
    if (p.order          !== undefined) curCSS.order          = p.order;
    if (p.gap            !== undefined) curCSS.gap            = p.gap;
    // ── Transform / cursor ─────────────────────────────────────────────────
    if (p.transform     !== undefined) curCSS.transform     = p.transform;
    if (p.cursor        !== undefined) curCSS.cursor        = p.cursor;
    if (p.pointerEvents !== undefined) curCSS.pointerEvents = p.pointerEvents;
    // ── Background extras ──────────────────────────────────────────────────
    if (p.backgroundImage    !== undefined) curCSS.backgroundImage    = p.backgroundImage;
    if (p.backgroundSize     !== undefined) curCSS.backgroundSize     = p.backgroundSize;
    if (p.backgroundPosition !== undefined) curCSS.backgroundPosition = p.backgroundPosition;
    if (p.backgroundRepeat   !== undefined) curCSS.backgroundRepeat   = p.backgroundRepeat;
  }
  function popCSS(): void {
    if (cssStack.length > 0) {
      // Inject ::after content before restoring parent CSS
      var afterTxt = curCSS._pseudoAfter;
      if (afterTxt) pushSpan(afterTxt);
      var prev = cssStack[cssStack.length - 1]!;
      if (curCSS.hidden && !prev.hidden) skipDepth = Math.max(0, skipDepth - 1);
      curCSS = cssStack.pop()!;
    }
  }

  var inlineSpans: InlineSpan[]       = [];
  var linkHref     = '';
  var linkDownload = '';   // <a download> attribute hint (item 636)
  var linkDepth    = 0;
  var openBlock:  RenderNode | null   = null;

  // Form tracking
  var curFormIdx   = -1;
  var inSelect     = false;
  var selectOpts:  string[] = [];
  var selectVals:  string[] = [];
  var selectSel    = 0;
  var inTextarea   = false;
  var textareaWip: WidgetBlueprint | null = null;

  // ── Table tracking ──────────────────────────────────────────────────────────
  var inTable       = false;
  var tableRows:    Array<Array<{ text: string; head: boolean }>> = [];
  var tableCurRow:  Array<{ text: string; head: boolean }> = [];
  var tableCellBuf  = '';
  var inTableCell   = false;
  var tableCellHead = false;

  // Track open <p> tags for implicit auto-close (HTML5 tree builder rule, item 359)
  var pOpen = 0;
  // Tags that implicitly close an open <p>
  var P_CLOSERS = new Set([
    'p', 'div', 'article', 'section', 'header', 'footer', 'aside', 'main', 'nav',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote',
    'details', 'summary', 'dl', 'dt', 'dd', 'table', 'hr', 'figure', 'figcaption',
    'form', 'fieldset', 'address', 'menu',
  ]);
  function autoClosePIfOpen(): void {
    if (pOpen > 0) { popCSS(); pOpen--; flushInline(); if (openBlock) { nodes.push(openBlock); openBlock = null; } }
  }

  // <picture> element tracking (item 366)
  var inPicture      = false;
  var pictureSources: string[] = [];  // collected src URLs from <source> tags

  var BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside',
    'figure', 'figcaption', 'address', 'details', 'dd', 'dt', 'caption',
  ]);

  function flushInline(): void {
    if (!inlineSpans.length) return;
    var merged: InlineSpan[] = [];
    for (var mi = 0; mi < inlineSpans.length; mi++) {
      var sp   = inlineSpans[mi];
      var prev = merged[merged.length - 1];
      if (prev && prev.href      === sp.href &&
          prev.bold      === sp.bold      && prev.italic    === sp.italic    &&
          prev.code      === sp.code      && prev.del       === sp.del       &&
          prev.mark      === sp.mark      && prev.underline === sp.underline &&
          prev.color     === sp.color) {
        prev.text += sp.text;
      } else {
        merged.push({ ...sp });
      }
    }
    var blk: RenderNode = { type: 'block', spans: merged };
    if (curCSS.bgColor   !== undefined) blk.bgColor     = curCSS.bgColor;
    if (curCSS.backgroundImage && isGradient(curCSS.backgroundImage)) blk.bgGradient = curCSS.backgroundImage;
    // CSS background-image url() — extract URL for deferred image fetch (item 386)
    if (curCSS.backgroundImage && !isGradient(curCSS.backgroundImage)) {
      var _bgUrlM = curCSS.backgroundImage.match(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/);
      if (_bgUrlM && _bgUrlM[1]) blk.bgImage = _bgUrlM[1];
    }
    if (curCSS.float && curCSS.float !== 'none') blk.float = curCSS.float;
    if (curCSS.marginTop)               blk.marginTop   = curCSS.marginTop;
    if (curCSS.marginBottom)            blk.marginBottom = curCSS.marginBottom;
    if (curCSS.marginLeft)              blk.marginLeft   = curCSS.marginLeft;
    if (curCSS.marginRight)             blk.marginRight  = curCSS.marginRight;
    if (curCSS.paddingLeft)             blk.paddingLeft  = curCSS.paddingLeft;
    if (curCSS.paddingRight)            blk.paddingRight  = curCSS.paddingRight;
    if (curCSS.paddingTop)              blk.paddingTop    = curCSS.paddingTop;
    if (curCSS.paddingBottom)           blk.paddingBottom = curCSS.paddingBottom;
    if (curCSS.align)                   blk.textAlign    = curCSS.align;
    if (curCSS.width  && curCSS.width > 0) blk.boxWidth  = curCSS.width;
    if (curCSS.height && curCSS.height > 0) blk.height   = curCSS.height;
    if (curCSS.minHeight !== undefined) blk.minHeight  = curCSS.minHeight;
    if (curCSS.maxHeight !== undefined) blk.maxHeight  = curCSS.maxHeight;
    if (curCSS.borderRadius !== undefined) blk.borderRadius = curCSS.borderRadius;
    if (curCSS.borderWidth  !== undefined) blk.borderWidth  = curCSS.borderWidth;
    if (curCSS.borderColor  !== undefined) blk.borderColor  = curCSS.borderColor;
    if (curCSS.borderStyle  !== undefined) blk.borderStyle  = curCSS.borderStyle;
    if (curCSS.opacity  !== undefined) blk.opacity  = curCSS.opacity;
    if (curCSS.boxShadow)              blk.boxShadow  = curCSS.boxShadow;
    if (curCSS.position && curCSS.position !== 'static') {
      blk.position = curCSS.position;
      if (curCSS.top    !== undefined) blk.posTop    = curCSS.top;
      if (curCSS.right  !== undefined) blk.posRight  = curCSS.right;
      if (curCSS.bottom !== undefined) blk.posBottom = curCSS.bottom;
      if (curCSS.left   !== undefined) blk.posLeft   = curCSS.left;
      if (curCSS.zIndex !== undefined) blk.zIndex    = curCSS.zIndex;
    }
    if (curCSS.overflow !== undefined) blk.overflow  = curCSS.overflow;
    if (curCSS.textOverflow !== undefined) blk.textOverflow = curCSS.textOverflow; // item 465
    if (curCSS.whiteSpace !== undefined) blk.whiteSpace = curCSS.whiteSpace;
    if (curCSS.textTransform !== undefined) blk.textTransform = curCSS.textTransform;
    if (curCSS.lineHeight !== undefined) blk.lineHeight = curCSS.lineHeight;
    if (curCSS.flexDirection)  blk.flexDirection  = curCSS.flexDirection;
    if (curCSS.flexWrap)       blk.flexWrap       = curCSS.flexWrap;
    if (curCSS.justifyContent) blk.justifyContent = curCSS.justifyContent;
    if (curCSS.alignItems)     blk.alignItems     = curCSS.alignItems;
    if (curCSS.gap !== undefined) blk.gap          = curCSS.gap;
    if (curCSS.flexGrow  !== undefined) blk.flexGrow  = curCSS.flexGrow;
    if (curCSS.alignSelf !== undefined) blk.alignSelf = curCSS.alignSelf;
    if (curCSS.order     !== undefined) blk.order     = curCSS.order;
    // Grid container (items 404-405)
    if (curCSS.display === 'grid' || curCSS.display === 'inline-grid') {
      blk.type = 'grid';
    }
    if (curCSS.gridTemplateColumns) blk.gridTemplateColumns = curCSS.gridTemplateColumns;
    if (curCSS.gridTemplateRows)    blk.gridTemplateRows    = curCSS.gridTemplateRows;
    if (curCSS.gridTemplateAreas)   blk.gridTemplateAreas   = curCSS.gridTemplateAreas;
    if (curCSS.gridAutoColumns)     blk.gridAutoColumns     = curCSS.gridAutoColumns;
    if (curCSS.gridAutoRows)        blk.gridAutoRows        = curCSS.gridAutoRows;
    if (curCSS.gridAutoFlow)        blk.gridAutoFlow        = curCSS.gridAutoFlow;
    if (curCSS.rowGap    !== undefined) blk.rowGap    = curCSS.rowGap;
    if (curCSS.columnGap !== undefined) blk.columnGap = curCSS.columnGap;
    if (curCSS.justifyItems) blk.justifyItems = curCSS.justifyItems;
    // Grid item placement
    if (curCSS.gridColumn)      blk.gridColumn      = curCSS.gridColumn;
    if (curCSS.gridRow)         blk.gridRow         = curCSS.gridRow;
    if (curCSS.gridColumnStart) blk.gridColumnStart = curCSS.gridColumnStart;
    if (curCSS.gridColumnEnd)   blk.gridColumnEnd   = curCSS.gridColumnEnd;
    if (curCSS.gridRowStart)    blk.gridRowStart    = curCSS.gridRowStart;
    if (curCSS.gridRowEnd)      blk.gridRowEnd      = curCSS.gridRowEnd;
    if (curCSS.gridArea)        blk.gridArea        = curCSS.gridArea;
    // Table, text props (items 418-421)
    if (curCSS.tableLayout)                    blk.tableLayout    = curCSS.tableLayout;
    if (curCSS.borderCollapse !== undefined)   blk.borderCollapse = curCSS.borderCollapse;
    if (curCSS.borderSpacing  !== undefined)   blk.borderSpacing  = curCSS.borderSpacing;
    if (curCSS.verticalAlign  !== undefined)   blk.verticalAlign  = curCSS.verticalAlign;
    if (curCSS.wordBreak      !== undefined)   blk.wordBreak      = curCSS.wordBreak;
    if (curCSS.overflowWrap   !== undefined)   blk.overflowWrap   = curCSS.overflowWrap;
    // Cursor / pointer-events (items 415, 416)
    if (curCSS.cursor        !== undefined)   blk.cursor        = curCSS.cursor;
    if (curCSS.pointerEvents !== undefined)   blk.pointerEvents = curCSS.pointerEvents;
    nodes.push(blk);
    inlineSpans = [];
  }

  function pushSpan(text: string): void {
    if (!text) return;
    if (inTableCell) { tableCellBuf += text; return; }
    if (skipDepth > 0) return;
    var sp: InlineSpan = { text };
    if (linkHref)                          sp.href      = linkHref;
    if (linkDownload)                      sp.download  = linkDownload;   // item 636
    if (bold > 0      || curCSS.bold)      sp.bold      = true;
    if (italic > 0    || curCSS.italic)    sp.italic    = true;
    if (codeInl > 0)                       sp.code      = true;
    if (del > 0       || curCSS.strike)    sp.del       = true;
    if (mark > 0)                          sp.mark      = true;
    if (underline > 0 || curCSS.underline) sp.underline = true;
    if (curCSS.color !== undefined && !linkHref) sp.color = curCSS.color;
    if (openBlock) { openBlock.spans.push(sp); }
    else           { inlineSpans.push(sp); }
  }

  function pushWidget(bp: WidgetBlueprint): void {
    flushInline();
    if (openBlock) { nodes.push(openBlock); openBlock = null; }
    widgets.push(bp);
    nodes.push({ type: 'widget', spans: [], widget: bp });
  }

  // Apply combined sheet + inline style for an element; push to CSS stack.
  // Also injects ::before generated content span if applicable.
  function applyStyle(tag: string, attrs: Map<string, string>): boolean {
    var id  = attrs.get('id')    || '';
    var cls = (attrs.get('class') || '').split(/\s+/).filter(Boolean);
    var inl = attrs.get('style') || '';
    var hasPseudo = sheets.length > 0;
    if (!inl && !hasPseudo) { cssStack.push({ ...curCSS }); return false; }
    var ep = computeElementStyle(tag, id, cls, attrs, curCSS, sheets, inl);
    // Apply counter-reset / counter-increment from computed style (item 434)
    _applyCounters(ep);
    if (hasPseudo) {
      var pseudo = getPseudoContent(tag, id, cls, attrs, sheets, undefined, _counters);
      if (pseudo.before) ep._pseudoBefore = pseudo.before;
      if (pseudo.after)  ep._pseudoAfter  = pseudo.after;
    }
    pushCSS(ep);
    // Inject ::before span immediately (before element content)
    if (curCSS._pseudoBefore) pushSpan(curCSS._pseudoBefore);
    return true;
  }

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];

    if (inScript) {
      if (tok.kind === 'close' && tok.tag === 'script') {
        if (inScriptBuf.trim()) {
          scripts.push({ inline: true, src: '', code: inScriptBuf, type: inScriptType || 'text/javascript' });
        }
        inScript = false; inScriptBuf = ''; inScriptSrc = ''; inScriptType = '';
      } else if (tok.kind === 'text') {
        inScriptBuf += tok.text;
      }
      continue;
    }
    if (inStyle) {
      if (tok.kind === 'close' && tok.tag === 'style') {
        if (inStyleBuf.trim()) styles.push(inStyleBuf);
        inStyleBuf = ''; inStyle = false;
      } else if (tok.kind === 'text') {
        inStyleBuf += tok.text;
      }
      continue;
    }
    if (skipUntilClose) { if (tok.kind === 'close' && tok.tag === skipUntilClose) skipUntilClose = ''; continue; }

    // ── SVG inline rendering (item 371) ────────────────────────────────────
    // Collect all tokens inside <svg>…</svg>, re-serialize, and render via renderSVG().
    if (inSVG) {
      if (tok.kind === 'close' && tok.tag === 'svg') {
        svgDepth--;
        svgBuf += '</svg>';
        if (svgDepth === 0) {
          inSVG = false;
          var _svgDecoded: DecodedImage | null = null;
          try { _svgDecoded = renderSVG(svgBuf, svgWidth || 300, svgHeight || 150); } catch (_e) {}
          if (_svgDecoded) {
            var _svgBP: WidgetBlueprint = {
              kind: 'img', name: '', value: '', checked: false, disabled: false, readonly: false, formIdx: curFormIdx,
              imgSrc: 'svg:inline', imgNatW: _svgDecoded.w, imgNatH: _svgDecoded.h,
              preloadedImage: _svgDecoded,
            };
            pushWidget(_svgBP);
          }
        }
      } else if (tok.kind === 'open') {
        if (tok.tag === 'svg') svgDepth++;
        var _svgOpen = '<' + tok.tag;
        tok.attrs.forEach(function(v, k) { _svgOpen += ' ' + k + '="' + v.replace(/"/g, '&quot;') + '"'; });
        svgBuf += _svgOpen + '>';
      } else if (tok.kind === 'self') {
        var _svgSelf = '<' + tok.tag;
        tok.attrs.forEach(function(v, k) { _svgSelf += ' ' + k + '="' + v.replace(/"/g, '&quot;') + '"'; });
        svgBuf += _svgSelf + '/>';
      } else if (tok.kind === 'close') {
        svgBuf += '</' + tok.tag + '>';
      } else if (tok.kind === 'text') {
        svgBuf += tok.text;
      }
      continue;
    }
    // Detect opening <svg> tag and start inline SVG collection
    if (tok.kind === 'open' && tok.tag === 'svg') {
      flushInline();
      inSVG     = true;
      svgDepth  = 1;
      svgWidth  = parseInt(tok.attrs.get('width')  || '300', 10) || 300;
      svgHeight = parseInt(tok.attrs.get('height') || '150', 10) || 150;
      svgBuf    = '<svg';
      tok.attrs.forEach(function(v, k) { svgBuf += ' ' + k + '="' + v.replace(/"/g, '&quot;') + '"'; });
      svgBuf   += '>';
      continue;
    }

    // ── <template> element (item 357) ─────────────────────────────────────
    // Content inside <template> is parsed into a detached document fragment
    // and stored in `templates` by the element's `id`; not rendered.
    if (inTemplate) {
      if (tok.kind === 'close' && tok.tag === 'template') {
        templates.set(templateId, templateNodes);
        inTemplate = false; templateId = ''; templateNodes = [];
      }
      // Collect text tokens as a simple text block for the template fragment
      if (tok.kind === 'text' && tok.text.trim()) {
        templateNodes.push({ type: 'block', spans: [{ text: tok.text, color: undefined as any }] });
      }
      continue;
    }
    if (tok.kind === 'open' && tok.tag === 'template') {
      inTemplate = true;
      templateId = tok.attrs.get('id') || `tpl_${templates.size}`;
      templateNodes = [];
      continue;
    }

    // ── text inside <select> options or <textarea> ────────────────────────
    if (inSelect) {
      if (tok.kind === 'text') {
        if (selectOpts.length > 0) selectOpts[selectOpts.length - 1] += tok.text.trim();
      } else if (tok.kind === 'open' && tok.tag === 'option') {
        var optVal    = tok.attrs.get('value') || '';
        var isSel     = tok.attrs.has('selected');
        if (isSel) selectSel = selectOpts.length;
        selectOpts.push('');
        selectVals.push(optVal);
      } else if ((tok.kind === 'close' || tok.kind === 'self') && tok.tag === 'select') {
        inSelect = false;
        if (textareaWip) {
          textareaWip.options = selectOpts;
          textareaWip.optVals = selectVals;
          textareaWip.selIdx  = selectSel;
          textareaWip = null;
        }
      }
      continue;
    }

    if (inTextarea) {
      if (tok.kind === 'text' && textareaWip) {
        textareaWip.value += tok.text;
      } else if (tok.kind === 'close' && tok.tag === 'textarea') {
        inTextarea = false; textareaWip = null;
      }
      continue;
    }

    if (tok.kind === 'open' || tok.kind === 'self') {
      if (skipDepth > 0) {
        // Still need to pushCSS for any styled hidden element so pops balance
        applyStyle(tok.tag, tok.attrs);
        continue;
      }

      switch (tok.tag) {
        // ── Document structure ──────────────────────────────────────────────
        case 'head':   inHead   = true;  break;
        case 'body':   inHead   = false; break;
        case 'html':   break;
        case 'title':  inTitle  = true;  break;
        case 'script': {
          inScriptType = tok.attrs.get('type') || 'text/javascript';
          inScriptSrc  = tok.attrs.get('src')  || '';
          if (inScriptSrc) {
            scripts.push({ inline: false, src: inScriptSrc, code: '', type: inScriptType });
            // content (if any) is still buffered but won't be used
          }
          inScript = true;
          break;
        }
        case 'style':  inStyle = true; inStyleBuf = ''; break;

        case 'base': {
          var bHref = tok.attrs.get('href');
          if (bHref) baseURL = bHref;
          break;
        }
        case 'meta': break;  // ignored
        case 'link': {
          var lRel = (tok.attrs.get('rel') || '').toLowerCase();
          if (lRel === 'stylesheet') {
            var lHref = tok.attrs.get('href') || '';
            if (lHref) styleLinks.push(lHref);
          }
          // Favicon from <link rel="icon"> or <link rel="shortcut icon"> (item 628)
          if ((lRel === 'icon' || lRel === 'shortcut icon') && !favicon) {
            var iconHref = tok.attrs.get('href') || '';
            if (iconHref) favicon = iconHref;
          }
          break;
        }

        // ── Embedded media / replaced elements ─────────────────────────────────────────
        case 'iframe': {
          var ifSrc  = tok.attrs.get('src') || 'about:blank';
          var ifW    = tok.attrs.get('width')  || '';
          var ifH    = tok.attrs.get('height') || '';
          var ifDims = (ifW || ifH) ? ' (' + (ifW || '?') + '\xD7' + (ifH || '?') + ')' : '';
          flushInline();
          nodes.push({ type: 'block', spans: [{ text: '[\uD83D\uDDBC\uFE0F iframe: ' + ifSrc + ifDims + ']', code: true }] });
          skipUntilClose = 'iframe'; break;
        }
        case 'video': {
          var vidSrc = tok.attrs.get('src') || '';
          nodes.push({ type: 'block', spans: [{ text: '\u25B6\uFE0F [video' + (vidSrc ? ': ' + vidSrc : '') + ']', code: true }] });
          skipUntilClose = 'video'; break;
        }
        case 'audio': {
          var audSrc = tok.attrs.get('src') || '';
          pushSpan('\u266A [audio' + (audSrc ? ': ' + audSrc : '') + ']');
          skipUntilClose = 'audio'; break;
        }
        case 'canvas': {
          var cnW = tok.attrs.get('width')  || '300';
          var cnH = tok.attrs.get('height') || '150';
          flushInline();
          nodes.push({ type: 'block', spans: [{ text: '[canvas ' + cnW + '\xD7' + cnH + ']', code: true }] });
          break;
        }
        case 'noscript': {
          skipUntilClose = 'noscript'; break;  // We have JS, so skip noscript fallback content
        }
        case 'object': case 'embed': case 'noembed': {
          var objType = tok.attrs.get('type') || tok.tag;
          pushSpan('[' + objType + ']');
          skipUntilClose = tok.tag; break;
        }

        // ── Inline formatting ───────────────────────────────────────────────
        case 'strong': case 'b':
          applyStyle(tok.tag, tok.attrs); bold++;    break;
        case 'em': case 'i':
          applyStyle(tok.tag, tok.attrs); italic++;  break;
        case 'code': case 'tt': case 'kbd': case 'samp':
          applyStyle(tok.tag, tok.attrs); codeInl++; break;
        case 'del': case 's':
          applyStyle(tok.tag, tok.attrs); del++;     break;
        case 'mark':
          applyStyle(tok.tag, tok.attrs); mark++;    break;
        case 'u':
          applyStyle(tok.tag, tok.attrs); underline++; break;

        case 'sup':  applyStyle(tok.tag, tok.attrs); pushSpan('^');  break;
        case 'sub':  applyStyle(tok.tag, tok.attrs); break;
        case 'abbr': applyStyle(tok.tag, tok.attrs); break;
        case 'bdi':  applyStyle(tok.tag, tok.attrs); break;
        case 'bdo':  applyStyle(tok.tag, tok.attrs); break;
        case 'cite': applyStyle(tok.tag, tok.attrs); italic++; break;
        case 'var':  applyStyle(tok.tag, tok.attrs); italic++; break;
        case 'q':    applyStyle(tok.tag, tok.attrs); pushSpan('\u201C'); break;

        case 'span': applyStyle(tok.tag, tok.attrs); break;
        case 'font': applyStyle(tok.tag, tok.attrs); break;

        // ── Links ───────────────────────────────────────────────────────────
        case 'a': {
          applyStyle(tok.tag, tok.attrs);
          var href = tok.attrs.get('href') || '';
          if (href && !href.startsWith('javascript:')) {
            linkHref = href;
            // Parse download attribute (item 636): value is filename hint, empty=use URL filename
            if (tok.attrs.has('download')) {
              // Use the attribute value as filename; empty value means derive from URL
              var dlVal = tok.attrs.get('download') || '';
              linkDownload = dlVal || href.split('?')[0]!.split('/').pop() || 'download';
            } else {
              linkDownload = '';
            }
          }
          linkDepth++;
          break;
        }

        // ── Headings ────────────────────────────────────────────────────────
        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6': {
          autoClosePIfOpen();
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.tag, tok.attrs);
          var hAlign = curCSS.align;
          openBlock = { type: tok.tag as BlockType, spans: [], textAlign: hAlign };
          break;
        }

        // ── Preformatted ────────────────────────────────────────────────────
        case 'pre':  applyStyle(tok.tag, tok.attrs); flushInline(); inPre = true; break;

        // ── Line break / rule ────────────────────────────────────────────────
        case 'br':
          if (inPre) { nodes.push({ type: 'pre',  spans: [{ text: '' }] }); }
          else {
            if (openBlock) { nodes.push(openBlock); openBlock = null; }
            else            flushInline();
          }
          break;
        case 'hr':
          flushInline();
          nodes.push({ type: 'hr', spans: [] });
          break;
        case 'wbr': break;  // ignored

        // ── Progress / Meter / Output ────────────────────────────────────────────────────
        case 'progress': {
          var pgVal = parseFloat(tok.attrs.get('value') || '0');
          var pgMax = parseFloat(tok.attrs.get('max') || '100');
          var pgFrac = Math.max(0, Math.min(1, pgMax > 0 ? pgVal / pgMax : 0));
          var pgFilled = Math.round(pgFrac * 20);
          pushSpan('[' + '\u2588'.repeat(pgFilled) + '\u2591'.repeat(20 - pgFilled) + '] ' + Math.round(pgFrac * 100) + '%');
          break;
        }
        case 'meter': {
          var mtVal  = parseFloat(tok.attrs.get('value') || '0');
          var mtMin  = parseFloat(tok.attrs.get('min')   || '0');
          var mtMax2 = parseFloat(tok.attrs.get('max')   || '1');
          var mtFrac = Math.max(0, Math.min(1, mtMax2 > mtMin ? (mtVal - mtMin) / (mtMax2 - mtMin) : 0));
          var mtFilled = Math.round(mtFrac * 16);
          pushSpan('[' + '\u2593'.repeat(mtFilled) + '\u2591'.repeat(16 - mtFilled) + '] ' + mtVal);
          break;
        }
        case 'output': applyStyle(tok.tag, tok.attrs); break;

        // ── Fieldset / Legend ──────────────────────────────────────────────────────
        case 'fieldset':
          applyStyle(tok.tag, tok.attrs); flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          nodes.push({ type: 'hr', spans: [] }); break;
        case 'legend': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.tag, tok.attrs);
          openBlock = { type: 'h4', spans: [] };
          break;
        }

        // ── Lists ────────────────────────────────────────────────────────────
        case 'ul': case 'ol':
          applyStyle(tok.tag, tok.attrs); flushInline(); listDepth++; break;
        case 'li': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.tag, tok.attrs);
          var liAlign = curCSS.align;
          openBlock = { type: 'li', spans: [], indent: Math.max(0, listDepth - 1), textAlign: liAlign };
          break;
        }

        // ── Blockquote ───────────────────────────────────────────────────────
        case 'blockquote': {
          autoClosePIfOpen();
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.tag, tok.attrs);
          openBlock = { type: 'blockquote', spans: [], indent: 1 };
          break;
        }

        // ── <details> / <summary> ────────────────────────────────────────────
        // Details are always "open" (no JS toggle). Summary becomes a heading.
        case 'details':
          applyStyle(tok.tag, tok.attrs); flushInline();
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'summary': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.tag, tok.attrs);
          openBlock = { type: 'summary', spans: [] };
          break;
        }

        // ── Forms ────────────────────────────────────────────────────────────
        case 'form': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          var fAction  = tok.attrs.get('action') || '';
          var fMethod  = (tok.attrs.get('method') || 'get').toLowerCase() as 'get' | 'post';
          var fEnctype = tok.attrs.get('enctype') || 'application/x-www-form-urlencoded';
          curFormIdx   = forms.length;
          forms.push({ action: fAction, method: fMethod, enctype: fEnctype });
          break;
        }

        // ── <input> ──────────────────────────────────────────────────────────
        case 'input': {
          var iType     = (tok.attrs.get('type') || 'text').toLowerCase() as WidgetKind;
          var iName     = tok.attrs.get('name')     || '';
          var iValue    = tok.attrs.get('value')    || '';
          var iChecked  = tok.attrs.has('checked');
          var iDisabled = tok.attrs.has('disabled');
          var iReadonly = tok.attrs.has('readonly');
          var iSizeStr  = tok.attrs.get('size') || '';
          var iSize     = iSizeStr ? parseInt(iSizeStr, 10) : 0;
          var iPlaceh   = tok.attrs.get('placeholder') || '';
          if (!iValue && iPlaceh) iValue = iPlaceh;

          if (iType === 'hidden') {
            widgets.push({
              kind: 'hidden', name: iName, value: iValue,
              checked: false, disabled: false, readonly: false, formIdx: curFormIdx,
            });
            break;
          }
          if ((iType as string) === 'image') iType = 'submit';
          // Normalize novel input types to renderable equivalents
          var iTypeStr = iType as string;
          if (iTypeStr === 'number' || iTypeStr === 'email' || iTypeStr === 'url' ||
              iTypeStr === 'tel'   || iTypeStr === 'date' ||
              iTypeStr === 'time'  || iTypeStr === 'color' || iTypeStr === 'range' ||
              iTypeStr === 'datetime-local' || iTypeStr === 'month' || iTypeStr === 'week') {
            iType = 'text';
          }

          var bp: WidgetBlueprint = {
            kind: iType, name: iName, value: iValue,
            checked: iChecked, disabled: iDisabled, readonly: iReadonly,
            formIdx: curFormIdx, cols: iSize || 20,
          };
          if (iType === 'radio') bp.radioGroup = iName;
          // ── Validation attributes (item 603) ────────────────────────────────
          if (tok.attrs.has('required'))  bp.required   = true;
          var minLenA = tok.attrs.get('minlength');
          if (minLenA)  bp.minLength  = parseInt(minLenA, 10) || 0;
          var maxLenA = tok.attrs.get('maxlength');
          if (maxLenA)  bp.maxLength  = parseInt(maxLenA, 10) || 0;
          var patA = tok.attrs.get('pattern');
          if (patA)  bp.pattern = patA;
          var minA = tok.attrs.get('min');
          if (minA)  bp.inputMin  = minA;
          var maxA = tok.attrs.get('max');
          if (maxA)  bp.inputMax  = maxA;
          bp.inputType    = (tok.attrs.get('type') || 'text').toLowerCase();
          bp.placeholder  = iPlaceh || undefined;
          pushWidget(bp);
          break;
        }

        // ── <select> ─────────────────────────────────────────────────────────
        case 'select': {
          var sBp: WidgetBlueprint = {
            kind: 'select', name: tok.attrs.get('name') || '',
            value: '', checked: false, disabled: tok.attrs.has('disabled'),
            readonly: false, formIdx: curFormIdx,
            options: [], optVals: [], selIdx: 0,
          };
          textareaWip = sBp;
          inSelect    = true;
          selectOpts  = []; selectVals = []; selectSel = 0;
          pushWidget(sBp);
          break;
        }

        // ── <textarea> ───────────────────────────────────────────────────────
        case 'textarea': {
          var rows = parseInt(tok.attrs.get('rows') || '4', 10) || 4;
          var cols = parseInt(tok.attrs.get('cols') || '40', 10) || 40;
          var taBp: WidgetBlueprint = {
            kind: 'textarea', name: tok.attrs.get('name') || '',
            value: tok.attrs.get('placeholder') || '',
            checked: false, disabled: tok.attrs.has('disabled'),
            readonly: tok.attrs.has('readonly'), formIdx: curFormIdx, rows, cols,
          };
          textareaWip = taBp; inTextarea = true;
          pushWidget(taBp);
          break;
        }

        // ── <button> ─────────────────────────────────────────────────────────
        case 'button': {
          var bType = (tok.attrs.get('type') || 'submit').toLowerCase();
          var bKind: WidgetKind = bType === 'reset' ? 'reset' : 'submit';
          pushWidget({
            kind: bKind, name: tok.attrs.get('name') || '',
            value: tok.attrs.get('value') || 'Submit',
            checked: false, disabled: tok.attrs.has('disabled'),
            readonly: false, formIdx: curFormIdx,
          });
          break;
        }

        // ── <img> ────────────────────────────────────────────────────────────
        case 'img': {
          var iSrc  = tok.attrs.get('src')    || '';
          var iAlt  = tok.attrs.get('alt')    || '';
          var iWStr = tok.attrs.get('width')  || '0';
          var iHStr = tok.attrs.get('height') || '0';
          var iNatW = parseInt(iWStr, 10) || 0;
          var iNatH = parseInt(iHStr, 10) || 0;
          // If inside <picture>, prefer the first collected <source> srcset URL
          if (inPicture && pictureSources.length > 0) iSrc = pictureSources[0];
          // Inline images with data: src are valid — keep the src as-is
          pushWidget({
            kind: 'img', name: '', value: iAlt,
            checked: false, disabled: false, readonly: false, formIdx: -1,
            imgSrc: iSrc, imgAlt: iAlt, imgNatW: iNatW, imgNatH: iNatH,
          });
          break;
        }

        // ── Picture element + source srcset (item 366) ─────────────────────────
        case 'picture':
          inPicture = true; pictureSources = []; break;
        case 'source': {
          // Collect the first usable URL from srcset or src
          var srcset = tok.attrs.get('srcset') || tok.attrs.get('src') || '';
          if (srcset) {
            // srcset format: "url [descriptor], url [descriptor], ..."
            // Pick the first URL (simplest selection, ignores viewport descriptors)
            var firstSrc = srcset.split(',')[0].trim().split(/\s+/)[0];
            if (firstSrc) pictureSources.push(firstSrc);
          }
          break;
        }

        // ── Table ─────────────────────────────────────────────────────────────
        case 'table':
          applyStyle(tok.tag, tok.attrs); flushInline();
          inTable = true; tableRows = []; tableCurRow = []; tableCellBuf = ''; inTableCell = false;
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'thead': case 'tbody': case 'tfoot': break;
        case 'tr':
          if (inTable && (inTableCell || tableCurRow.length > 0)) {
            if (inTableCell) { tableCurRow.push({ text: tableCellBuf.trim(), head: tableCellHead }); inTableCell = false; }
            tableRows.push(tableCurRow); tableCurRow = [];
          }
          flushInline();
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'th':
          applyStyle(tok.tag, tok.attrs); bold++;
          if (inTable) { inTableCell = true; tableCellHead = true; tableCellBuf = ''; } else pushSpan('| ');
          break;
        case 'td':
          applyStyle(tok.tag, tok.attrs);
          if (inTable) { inTableCell = true; tableCellHead = false; tableCellBuf = ''; } else pushSpan('| ');
          break;
        case 'colgroup': case 'col': break;

        // ── Default block ─────────────────────────────────────────────────────
        default: {
          if (BLOCK_TAGS.has(tok.tag)) {
            // Implicitly close any open <p> (HTML5 item 359)
            if (P_CLOSERS.has(tok.tag)) autoClosePIfOpen();
            applyStyle(tok.tag, tok.attrs);
            if (tok.tag === 'p') pOpen++;  // track for implicit close
            flushInline();
            if (openBlock) { nodes.push(openBlock); openBlock = null; }
            nodes.push({ type: 'p-break', spans: [] });
          }
          break;
        }
      }

    } else if (tok.kind === 'close') {
      if (skipDepth > 0) {
        var hs2 = tok.attrs ? tok.attrs.get('style') : undefined;
        popCSS(); continue;
      }

      switch (tok.tag) {
        case 'head':  inHead  = false; break;
        case 'title': inTitle = false; break;
        case 'html': case 'body': break;

        case 'strong': case 'b':  bold    = Math.max(0, bold    - 1); popCSS(); break;
        case 'em':     case 'i':  italic  = Math.max(0, italic  - 1); popCSS(); break;
        case 'code': case 'tt': case 'kbd': case 'samp':
          codeInl = Math.max(0, codeInl - 1); popCSS(); break;
        case 'del':    case 's':  del     = Math.max(0, del     - 1); popCSS(); break;
        case 'mark':              mark    = Math.max(0, mark    - 1); popCSS(); break;
        case 'u':                 underline = Math.max(0, underline - 1); popCSS(); break;
        case 'sup':  popCSS(); break;
        case 'sub':  popCSS(); break;
        case 'abbr': popCSS(); break;
        case 'bdi':  popCSS(); break;
        case 'bdo':  popCSS(); break;
        case 'cite': italic = Math.max(0, italic - 1); popCSS(); break;
        case 'var':  italic = Math.max(0, italic - 1); popCSS(); break;
        case 'q':    pushSpan('\u201D'); popCSS(); break;
        case 'span': popCSS(); break;
        case 'font': popCSS(); break;

        case 'a':
          linkDepth = Math.max(0, linkDepth - 1);
          if (linkDepth === 0) { linkHref = ''; linkDownload = ''; }  // item 636
          popCSS(); break;

        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'p': {
          // Explicit </p>: only pop CSS if it wasn't already auto-closed
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          if (pOpen > 0) { popCSS(); pOpen--; }
          break;
        }

        case 'li':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          popCSS(); break;

        case 'blockquote':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'ul': case 'ol':
          listDepth = Math.max(0, listDepth - 1);
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'picture':
          inPicture = false; pictureSources = []; break;

        case 'pre':
          inPre = false;
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'summary':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'details':
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;

        case 'form':
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          curFormIdx = -1; break;

        case 'button': break;

        case 'fieldset':
          flushInline();
          nodes.push({ type: 'hr', spans: [] });
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;
        case 'legend':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          popCSS(); break;
        case 'output': popCSS(); break;
        case 'progress': case 'meter': break;

        case 'th':
          bold = Math.max(0, bold - 1);
          if (inTable && inTableCell) { tableCurRow.push({ text: tableCellBuf.trim(), head: true }); inTableCell = false; } else pushSpan('  ');
          popCSS(); break;
        case 'td':
          if (inTable && inTableCell) { tableCurRow.push({ text: tableCellBuf.trim(), head: false }); inTableCell = false; } else pushSpan('  ');
          popCSS(); break;
        case 'table': {
          if (inTable) {
            if (inTableCell) { tableCurRow.push({ text: tableCellBuf.trim(), head: tableCellHead }); inTableCell = false; }
            if (tableCurRow.length > 0) { tableRows.push(tableCurRow); tableCurRow = []; }
            inTable = false;
            if (tableRows.length > 0) {
              var numCols = 0;
              for (var tri = 0; tri < tableRows.length; tri++) { if (tableRows[tri].length > numCols) numCols = tableRows[tri].length; }
              var colW: number[] = [];
              for (var ci = 0; ci < numCols; ci++) colW[ci] = 3;
              for (var tri2 = 0; tri2 < tableRows.length; tri2++) {
                for (var ci2 = 0; ci2 < tableRows[tri2].length; ci2++) {
                  var cw = tableRows[tri2][ci2].text.length + 2;
                  if (cw > colW[ci2]) colW[ci2] = cw;
                }
              }
              var hbar = function(l: string, m: string, r: string, x: string): string {
                return l + colW.map(function(w) { return m.repeat(w); }).join(x) + r;
              };
              var dataRow = function(cells: Array<{text: string; head: boolean}>): string {
                var s = '\u2502';
                for (var ci3 = 0; ci3 < numCols; ci3++) {
                  var c = cells[ci3] ? cells[ci3].text : '';
                  s += ' ' + c + ' '.repeat(Math.max(0, colW[ci3] - c.length - 1)) + '\u2502';
                }
                return s;
              };
              nodes.push({ type: 'pre', spans: [{ text: hbar('\u250C', '\u2500', '\u2510', '\u252C') }] });
              for (var tri3 = 0; tri3 < tableRows.length; tri3++) {
                if (tri3 > 0) {
                  var prevHead = tableRows[tri3 - 1].some(function(cc) { return cc.head; });
                  var nxtHead  = tableRows[tri3].some(function(cc)  { return cc.head; });
                  if (prevHead && !nxtHead) {
                    nodes.push({ type: 'pre', spans: [{ text: hbar('\u255E', '\u2550', '\u2561', '\u256A') }] });
                  } else {
                    nodes.push({ type: 'pre', spans: [{ text: hbar('\u251C', '\u2500', '\u2524', '\u253C') }] });
                  }
                }
                nodes.push({ type: 'pre', spans: [{ text: dataRow(tableRows[tri3]) }] });
              }
              nodes.push({ type: 'pre', spans: [{ text: hbar('\u2514', '\u2500', '\u2518', '\u2534') }] });
            }
            tableRows = []; tableCurRow = [];
          }
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;
        }
        case 'thead': case 'tbody': case 'tfoot': break;

        default:
          if (BLOCK_TAGS.has(tok.tag)) {
            flushInline();
            if (openBlock) { nodes.push(openBlock); openBlock = null; }
            nodes.push({ type: 'p-break', spans: [] });
            popCSS();
          }
          break;
      }

    } else {
      // ── Text token ─────────────────────────────────────────────────────────
      var txt = tok.text;
      if (inTitle) { title += txt.replace(/\s+/g, ' ').trim(); continue; }
      if (inHead || skipDepth > 0) continue;

      if (inPre) {
        var preLines = txt.split('\n');
        for (var pl = 0; pl < preLines.length; pl++) {
          var lastNode = nodes[nodes.length - 1];
          if (pl === 0 && lastNode && lastNode.type === 'pre' && lastNode.spans.length === 1) {
            lastNode.spans[0].text += preLines[pl];
          } else {
            nodes.push({ type: 'pre', spans: [{ text: preLines[pl] }] });
          }
          if (pl < preLines.length - 1) {
            nodes.push({ type: 'pre', spans: [{ text: '' }] });
          }
        }
        continue;
      }

      txt = txt.replace(/[\r\n\t]+/g, ' ');
      if (inTableCell) { tableCellBuf += txt; continue; }
      if (!txt.trim()) continue;
      pushSpan(txt);
    }
  }

  flushInline();
  return { nodes, title, forms, widgets, baseURL, scripts, styles, styleLinks, quirksMode, templates, favicon };
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 358] WHATWG HTML5 Tokenizer State Machine
//
// Implements the full WHATWG Living Standard tokenizer states:
//   https://html.spec.whatwg.org/multipage/parsing.html#tokenization
//
// States implemented:
//   DATA, TAG_OPEN, END_TAG_OPEN, TAG_NAME, BEFORE_ATTR_NAME, ATTR_NAME,
//   BEFORE_ATTR_VALUE, ATTR_VALUE_DOUBLE/SINGLE/UNQUOTED, AFTER_ATTR_VALUE,
//   SELF_CLOSING, MARKUP_DECL_OPEN, COMMENT_START, COMMENT, COMMENT_END,
//   DOCTYPE, RAWTEXT (for <script>/<style>), RCDATA (for <textarea>/<title>),
//   CHARACTER_REFERENCE (numeric &#…; and named &…; refs).
//
// The tokenizer feeds tokens to the tree construction stage which implements
// the insertion mode state machine (Items 360–362).
// ════════════════════════════════════════════════════════════════════════════

/** Tokenizer states (WHATWG §13.2.5) */
const enum TokState {
  DATA = 0,
  RCDATA,                 // <textarea>, <title>
  RAWTEXT,                // <script>, <style>
  SCRIPT_DATA,
  TAG_OPEN,
  END_TAG_OPEN,
  TAG_NAME,
  RCDATA_LT,
  RAWTEXT_LT,
  BEFORE_ATTR_NAME,
  ATTR_NAME,
  AFTER_ATTR_NAME,
  BEFORE_ATTR_VALUE,
  ATTR_VALUE_DOUBLE,
  ATTR_VALUE_SINGLE,
  ATTR_VALUE_UNQUOTED,
  AFTER_ATTR_VALUE,
  SELF_CLOSING_START_TAG,
  BOGUS_COMMENT,
  MARKUP_DECL_OPEN,
  COMMENT_START,
  COMMENT_START_DASH,
  COMMENT,
  COMMENT_LT_SIGN,
  COMMENT_END_DASH,
  COMMENT_END,
  DOCTYPE,
  CHAR_REF,
}

/** Pending token being built during tokenization. */
interface TokBuf {
  kind:  'start' | 'end' | 'comment' | 'doctype' | 'text';
  tag:   string;
  attrs: Map<string, string>;
  text:  string;
  self:  boolean;
  force_quirks: boolean;
}

function _makeTag(): TokBuf {
  return { kind: 'start', tag: '', attrs: new Map(), text: '', self: false, force_quirks: false };
}

/**
 * [Item 358] WHATWG HTML5 tokenizer.
 *
 * Produces an array of `HtmlToken` using a faithful state machine following
 * the WHATWG HTML living standard.  Handles:
 *   - All attribute forms: `checked`, `href="x"`, `href='x'`, `href=x`
 *   - Character references in data and attribute values: `&amp;`, `&#160;`, `&#xA0;`
 *   - Comments <!-- ... -->
 *   - DOCTYPE declarations
 *   - RAWTEXT elements (<script>, <style>, <xmp>, <noframes>, <noembed>)
 *   - RCDATA elements (<textarea>, <title>)
 *   - Self-closing tags
 *
 * Falls back to the existing `tokenise()` for callers that don't need the
 * full state machine.  Use `tokeniseWHATWG()` for spec-compliant parsing.
 */
export function tokeniseWHATWG(html: string): HtmlToken[] {
  var tokens: HtmlToken[] = [];
  var state: TokState = TokState.DATA;
  var i = 0;
  var n = html.length;
  var cur: TokBuf = _makeTag();
  var curAttrName  = '';
  var curAttrValue = '';
  var tempBuf  = '';     // for char refs / RAWTEXT end tag match
  var returnState: TokState = TokState.DATA;
  var textBuf  = '';     // accumulated text for DATA state
  var rawtextElem = ''; // which RAWTEXT element we're in

  /** Flush any pending text as a text token. */
  function flushText() {
    if (textBuf) {
      tokens.push({ kind: 'text', tag: '', text: _decodeEntities(textBuf), attrs: new Map() });
      textBuf = '';
    }
  }

  /** Save the current attribute into the pending token. */
  function flushAttr() {
    if (curAttrName) {
      if (!cur.attrs.has(curAttrName)) cur.attrs.set(curAttrName, curAttrValue);
    }
    curAttrName = ''; curAttrValue = '';
  }

  /** Emit the pending tag token. */
  function emitTag() {
    flushText();
    flushAttr();
    var kind: 'open' | 'close' | 'self' =
      cur.kind === 'end' ? 'close' : (cur.self ? 'self' : 'open');
    tokens.push({ kind, tag: cur.tag, text: '', attrs: cur.attrs });
    // Switch to RAWTEXT/RCDATA for special elements
    if (cur.kind === 'start') {
      var t = cur.tag;
      if (t === 'script' || t === 'style' || t === 'xmp' ||
          t === 'noframes' || t === 'noembed') {
        state = TokState.RAWTEXT; rawtextElem = t; return;
      }
      if (t === 'textarea' || t === 'title') {
        state = TokState.RCDATA; rawtextElem = t; return;
      }
    }
    state = TokState.DATA;
  }

  function emitComment() {
    flushText();
    // Comments are discarded (no comment token type in HtmlToken).
    cur = _makeTag(); state = TokState.DATA;
  }

  while (i < n) {
    var ch = html[i];

    switch (state) {

      case TokState.DATA:
        if (ch === '&') {
          returnState = TokState.DATA; state = TokState.CHAR_REF; i++; break;
        }
        if (ch === '<') { state = TokState.TAG_OPEN; i++; break; }
        textBuf += ch; i++; break;

      // @ts-ignore TS2678: state is assigned RCDATA at line ~1393 (TypeScript misses loop re-entry)
      case TokState.RCDATA:
        // In RCDATA, only </rawtextElem> ends the state.
        if (ch === '<') {
          var peek = html.slice(i, i + 2 + rawtextElem.length + 1);
          if (peek.toLowerCase() === '</' + rawtextElem + '>') {
            flushText(); i += 2 + rawtextElem.length + 1;
            tokens.push({ kind: 'close', tag: rawtextElem, text: '', attrs: new Map() });
            state = TokState.DATA; break;
          }
        }
        textBuf += ch; i++; break;

      // @ts-ignore TS2678: state is assigned RAWTEXT at line ~1393 (TypeScript misses loop re-entry)
      case TokState.RAWTEXT:
        if (ch === '<') {
          var rawendPeek = html.slice(i, i + 2 + rawtextElem.length + 1);
          if (rawendPeek.toLowerCase() === '</' + rawtextElem + '>') {
            flushText(); i += 2 + rawtextElem.length + 1;
            tokens.push({ kind: 'close', tag: rawtextElem, text: '', attrs: new Map() });
            state = TokState.DATA; break;
          }
        }
        textBuf += ch; i++; break;

      case TokState.TAG_OPEN:
        if (ch === '!') { state = TokState.MARKUP_DECL_OPEN; i++; break; }
        if (ch === '/') { cur = _makeTag(); cur.kind = 'end'; state = TokState.END_TAG_OPEN; i++; break; }
        if (ch === '?') { state = TokState.BOGUS_COMMENT; i++; break; }
        if (ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z') {
          cur = _makeTag(); cur.kind = 'start';
          cur.tag = ch.toLowerCase(); state = TokState.TAG_NAME; i++; break;
        }
        // Anything else: emit '<' as data
        textBuf += '<'; state = TokState.DATA; break;

      case TokState.END_TAG_OPEN:
        if (ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z') {
          cur.tag = ch.toLowerCase(); state = TokState.TAG_NAME; i++; break;
        }
        if (ch === '>') { state = TokState.DATA; i++; break; }
        state = TokState.BOGUS_COMMENT; i++; break;

      case TokState.TAG_NAME:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') {
          state = TokState.BEFORE_ATTR_NAME; i++; break;
        }
        if (ch === '/') { state = TokState.SELF_CLOSING_START_TAG; i++; break; }
        if (ch === '>') { emitTag(); i++; break; }
        cur.tag += ch.toLowerCase(); i++; break;

      case TokState.BEFORE_ATTR_NAME:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') { i++; break; }
        if (ch === '/' || ch === '>') { state = TokState.AFTER_ATTR_NAME; break; }
        curAttrName = ''; curAttrValue = '';
        state = TokState.ATTR_NAME; break;

      case TokState.ATTR_NAME:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') {
          state = TokState.AFTER_ATTR_NAME; i++; break;
        }
        if (ch === '/') { flushAttr(); state = TokState.SELF_CLOSING_START_TAG; i++; break; }
        if (ch === '=') { state = TokState.BEFORE_ATTR_VALUE; i++; break; }
        if (ch === '>') { flushAttr(); emitTag(); i++; break; }
        curAttrName += ch.toLowerCase(); i++; break;

      case TokState.AFTER_ATTR_NAME:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') { i++; break; }
        if (ch === '/') { flushAttr(); state = TokState.SELF_CLOSING_START_TAG; i++; break; }
        if (ch === '=') { state = TokState.BEFORE_ATTR_VALUE; i++; break; }
        if (ch === '>') { flushAttr(); emitTag(); i++; break; }
        flushAttr(); curAttrName = ch.toLowerCase(); state = TokState.ATTR_NAME; i++; break;

      case TokState.BEFORE_ATTR_VALUE:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') { i++; break; }
        if (ch === '"') { state = TokState.ATTR_VALUE_DOUBLE; i++; break; }
        if (ch === "'") { state = TokState.ATTR_VALUE_SINGLE; i++; break; }
        if (ch === '>') { flushAttr(); emitTag(); i++; break; }
        state = TokState.ATTR_VALUE_UNQUOTED; break;

      case TokState.ATTR_VALUE_DOUBLE:
        if (ch === '"') { flushAttr(); state = TokState.AFTER_ATTR_VALUE; i++; break; }
        if (ch === '&') { returnState = TokState.ATTR_VALUE_DOUBLE; state = TokState.CHAR_REF; i++; break; }
        curAttrValue += ch; i++; break;

      case TokState.ATTR_VALUE_SINGLE:
        if (ch === "'") { flushAttr(); state = TokState.AFTER_ATTR_VALUE; i++; break; }
        if (ch === '&') { returnState = TokState.ATTR_VALUE_SINGLE; state = TokState.CHAR_REF; i++; break; }
        curAttrValue += ch; i++; break;

      case TokState.ATTR_VALUE_UNQUOTED:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') {
          flushAttr(); state = TokState.BEFORE_ATTR_NAME; i++; break;
        }
        if (ch === '&') { returnState = TokState.ATTR_VALUE_UNQUOTED; state = TokState.CHAR_REF; i++; break; }
        if (ch === '>') { flushAttr(); emitTag(); i++; break; }
        curAttrValue += ch; i++; break;

      case TokState.AFTER_ATTR_VALUE:
        if (ch === '\t' || ch === '\n' || ch === '\f' || ch === ' ') {
          state = TokState.BEFORE_ATTR_NAME; i++; break;
        }
        if (ch === '/') { state = TokState.SELF_CLOSING_START_TAG; i++; break; }
        if (ch === '>') { emitTag(); i++; break; }
        // Parse error: reconsume in BEFORE_ATTR_NAME
        state = TokState.BEFORE_ATTR_NAME; break;

      case TokState.SELF_CLOSING_START_TAG:
        if (ch === '>') { cur.self = true; emitTag(); i++; break; }
        state = TokState.BEFORE_ATTR_NAME; break;

      case TokState.MARKUP_DECL_OPEN: {
        var rest = html.slice(i);
        if (rest.startsWith('--')) {
          cur = _makeTag(); cur.kind = 'comment'; cur.text = '';
          state = TokState.COMMENT_START; i += 2; break;
        }
        if (rest.slice(0, 7).toUpperCase() === 'DOCTYPE') {
          state = TokState.DOCTYPE; i += 7; break;
        }
        state = TokState.BOGUS_COMMENT; i++; break;
      }

      case TokState.COMMENT_START:
        if (ch === '-') { state = TokState.COMMENT_START_DASH; i++; break; }
        if (ch === '>') { emitComment(); i++; break; }
        state = TokState.COMMENT; break;

      case TokState.COMMENT_START_DASH:
        if (ch === '-') { state = TokState.COMMENT_END; i++; break; }
        if (ch === '>') { emitComment(); i++; break; }
        cur.text += '-'; state = TokState.COMMENT; break;

      case TokState.COMMENT:
        if (ch === '-') { state = TokState.COMMENT_END_DASH; i++; break; }
        if (ch === '<') { cur.text += ch; state = TokState.COMMENT_LT_SIGN; i++; break; }
        cur.text += ch; i++; break;

      case TokState.COMMENT_LT_SIGN:
        cur.text += ch; i++;
        state = TokState.COMMENT; break;

      case TokState.COMMENT_END_DASH:
        if (ch === '-') { state = TokState.COMMENT_END; i++; break; }
        cur.text += '-' + ch; state = TokState.COMMENT; i++; break;

      case TokState.COMMENT_END:
        if (ch === '>') { emitComment(); i++; break; }
        if (ch === '-') { cur.text += '-'; i++; break; }
        cur.text += '--' + ch; state = TokState.COMMENT; i++; break;

      case TokState.DOCTYPE:
        // Skip DOCTYPE content until '>'
        if (ch === '>') { state = TokState.DATA; i++; break; }
        i++; break;

      case TokState.BOGUS_COMMENT:
        if (ch === '>') { state = TokState.DATA; i++; break; }
        i++; break;

      case TokState.CHAR_REF: {
        // Character reference: &…; in data or attribute values
        var refEnd = html.indexOf(';', i);
        if (refEnd === -1 || refEnd - i > 32) {
          // Not a valid ref; emit '&'
          if (returnState === TokState.DATA) textBuf += '&';
          else curAttrValue += '&';
          state = returnState; break;
        }
        var ref = html.slice(i, refEnd);
        i = refEnd + 1;
        var decoded = _decodeCharRef(ref);
        if (returnState === TokState.DATA) textBuf += decoded;
        else curAttrValue += decoded;
        state = returnState; break;
      }

      default:
        i++; break;
    }
  }

  flushText();
  return tokens;
}

/** Decode a single character reference (without leading & or trailing ;). */
function _decodeCharRef(ref: string): string {
  if (ref[0] === '#') {
    var code: number;
    if (ref[1] === 'x' || ref[1] === 'X') code = parseInt(ref.slice(2), 16);
    else code = parseInt(ref.slice(1), 10);
    if (!isNaN(code) && code > 0) return String.fromCodePoint(code);
    return '&' + ref + ';';
  }
  return (_ENTITIES as Record<string, string>)[ref] ?? ('&' + ref + ';');
}

// ════════════════════════════════════════════════════════════════════════════
// [Items 360–361] Foster Parenting Algorithm
//
// When HTML content is misnested inside <table> elements the spec requires
// "foster parenting": misplaced nodes are inserted before the table element
// rather than inside it.
//
// Ref: https://html.spec.whatwg.org/multipage/parsing.html#foster-parent
// ════════════════════════════════════════════════════════════════════════════

/** A minimal DOM-like node for the tree construction stage. */
export interface TreeNode {
  tag:        string;      // element tag name, '' for text, '#comment' for comments
  attrs:      Map<string, string>;
  children:   TreeNode[];
  parent:     TreeNode | null;
  text?:      string;      // for text nodes
  /** Marks this node as the foster-parent target (content placed before table). */
  fosterSlot?: boolean;
}

function _makeTreeNode(tag: string, attrs: Map<string, string>): TreeNode {
  return { tag, attrs, children: [], parent: null };
}

/** Elements that form a "table scope" for the purposes of foster parenting. */
const TABLE_SCOPE_ELEMENTS = new Set(['table', 'caption', 'colgroup', 'col', 'tbody',
  'tfoot', 'thead', 'tr', 'td', 'th', 'template', 'html']);

/**
 * [Item 360] Foster parenting algorithm.
 *
 * Returns the node that newly inserted nodes should be attached to
 * when we are in a table context and the content is not allowed inside
 * the table.
 *
 * @param stack  Current open element stack (innermost = last).
 * @param root   Document root (foster content goes before the table).
 * @returns      The foster parent node and insertion index.
 */
export function fosterParent(
  stack: TreeNode[],
  root:  TreeNode,
): { parent: TreeNode; insertBefore: TreeNode | null } {
  // Find the last <table> element in the stack
  for (var k = stack.length - 1; k >= 0; k--) {
    if (stack[k].tag === 'table') {
      // Foster parent = the parent of the <table> element, or root
      var tableNode = stack[k];
      var tp = tableNode.parent ?? root;
      return { parent: tp, insertBefore: tableNode };
    }
    if (stack[k].tag === 'template') {
      return { parent: stack[k], insertBefore: null };
    }
  }
  // No table in stack — use last open element
  return { parent: stack[stack.length - 1] ?? root, insertBefore: null };
}

/**
 * [Item 361] Insert a node using foster parenting (for table text nodes).
 *
 * Text nodes inside a `<table>` that are not whitespace-only must be
 * foster-parented before the table according to the WHATWG spec.
 *
 * @param node   The node to insert.
 * @param stack  Open element stack.
 * @param root   Document root.
 */
export function fosterInsert(node: TreeNode, stack: TreeNode[], root: TreeNode): void {
  var fp = fosterParent(stack, root);
  node.parent = fp.parent;
  if (fp.insertBefore) {
    var idx = fp.parent.children.indexOf(fp.insertBefore);
    if (idx >= 0) { fp.parent.children.splice(idx, 0, node); return; }
  }
  fp.parent.children.push(node);
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 362] Full Insertion Mode State Machine
//
// Implements the tree construction dispatcher that routes each token to the
// appropriate "insertion mode" handler.
//
// Modes implemented (WHATWG §13.2.6):
//   initial, before_html, before_head, in_head, in_head_noscript,
//   after_head, in_body, text, in_table, in_table_text,
//   in_caption, in_column_group, in_table_body, in_row, in_cell,
//   in_select, in_select_in_table, in_template, after_body,
//   in_frameset, after_frameset, after_after_body.
// ════════════════════════════════════════════════════════════════════════════

const enum InsertionMode {
  INITIAL = 0,
  BEFORE_HTML,
  BEFORE_HEAD,
  IN_HEAD,
  IN_HEAD_NOSCRIPT,
  AFTER_HEAD,
  IN_BODY,
  TEXT,
  IN_TABLE,
  IN_TABLE_TEXT,
  IN_CAPTION,
  IN_COLUMN_GROUP,
  IN_TABLE_BODY,
  IN_ROW,
  IN_CELL,
  IN_SELECT,
  IN_SELECT_IN_TABLE,
  IN_TEMPLATE,
  AFTER_BODY,
  IN_FRAMESET,
  AFTER_FRAMESET,
  AFTER_AFTER_BODY,
}

// Elements that cause foster parenting in table context
const FOSTER_PARENT_TRIGGERS = new Set([
  'caption', 'col', 'colgroup', 'frame', 'head', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr',
]);

// Block elements that implicitly close a <p> element
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details',
  'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol',
  'p', 'section', 'summary', 'table', 'ul',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'form',
]);

// Void elements (no end tag)
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * [Item 362] HTML tree construction using the full insertion mode state machine.
 *
 * Accepts the token stream from `tokeniseWHATWG()` and builds a minimal
 * TreeNode DOM.  The resulting tree can then be walked by the render pipeline.
 *
 * Handles foster parenting for tables (items 360–361) and the major insertion
 * mode transitions defined in the WHATWG spec.
 */
export function buildTreeWHATWG(tokens: HtmlToken[]): TreeNode {
  var root: TreeNode = _makeTreeNode('#document', new Map());
  var stack: TreeNode[] = [];
  var mode: InsertionMode = InsertionMode.INITIAL;
  var originalMode: InsertionMode = InsertionMode.INITIAL;
  var headNode: TreeNode | null = null;
  var tableTextBuf: string[] = [];  // accumulated text in IN_TABLE_TEXT mode
  var templateModeStack: InsertionMode[] = [];

  /** The current insertion target (top of stack, or root). */
  function currentNode(): TreeNode {
    return stack.length > 0 ? stack[stack.length - 1] : root;
  }

  /** Insert an element and push to stack. */
  function insertElement(tag: string, attrs: Map<string, string>): TreeNode {
    var node = _makeTreeNode(tag, attrs);
    node.parent = currentNode();
    currentNode().children.push(node);
    if (!VOID_ELEMENTS.has(tag)) stack.push(node);
    return node;
  }

  /** Insert a text node at the current location, with foster parenting if in table mode. */
  function insertText(text: string): void {
    if (!text) return;
    var target = currentNode();
    // Foster parenting: text in table context goes before the table
    if ((mode === InsertionMode.IN_TABLE || mode === InsertionMode.IN_TABLE_BODY ||
         mode === InsertionMode.IN_ROW) && text.trim()) {
      var textNode: TreeNode = { tag: '#text', attrs: new Map(), children: [], parent: null, text };
      fosterInsert(textNode, stack, root);
      return;
    }
    // Merge adjacent text nodes
    var last = target.children[target.children.length - 1];
    if (last && last.tag === '#text') { last.text = (last.text ?? '') + text; return; }
    var tn: TreeNode = { tag: '#text', attrs: new Map(), children: [], parent: target, text };
    target.children.push(tn);
  }

  /** Pop elements from the stack until `tag` is popped. */
  function popUntil(tag: string): void {
    while (stack.length > 0) {
      var top = stack.pop()!;
      if (top.tag === tag) break;
    }
  }

  /** Close implied tags (e.g., <p> before a block-level element). */
  function closeImplied(stopAt: string = ''): void {
    var IMPLIED_CLOSE = new Set(['dd', 'dt', 'li', 'optgroup', 'option',
      'p', 'rb', 'rp', 'rt', 'rtc', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
    while (stack.length > 0) {
      var top = stack[stack.length - 1];
      if (top.tag === stopAt) break;
      if (!IMPLIED_CLOSE.has(top.tag)) break;
      stack.pop();
    }
  }

  /** Check if `tag` is in the stack (for in-scope checks). */
  function hasInScope(tag: string): boolean {
    var SCOPE_MARKERS = new Set(['applet', 'caption', 'html', 'table', 'td',
      'th', 'marquee', 'object', 'template']);
    for (var si = stack.length - 1; si >= 0; si--) {
      if (stack[si].tag === tag) return true;
      if (SCOPE_MARKERS.has(stack[si].tag)) return false;
    }
    return false;
  }

  /** hasInTableScope: for table-specific scope checks. */
  function hasInTableScope(tag: string): boolean {
    var TABLE_MARKERS = new Set(['html', 'table', 'template']);
    for (var si = stack.length - 1; si >= 0; si--) {
      if (stack[si].tag === tag) return true;
      if (TABLE_MARKERS.has(stack[si].tag)) return false;
    }
    return false;
  }

  // ── Process each token ──────────────────────────────────────────────────

  for (var ti = 0; ti < tokens.length; ti++) {
    var tok = tokens[ti];

    switch (mode) {

      case InsertionMode.INITIAL:
        if (tok.kind === 'text' && !tok.text.trim()) break; // ignore whitespace
        mode = InsertionMode.BEFORE_HTML; ti--; break;     // reprocess

      case InsertionMode.BEFORE_HTML:
        if (tok.kind === 'open' && tok.tag === 'html') {
          var htmlNode = insertElement('html', tok.attrs);
          mode = InsertionMode.BEFORE_HEAD;
        } else {
          // Create implicit <html>
          insertElement('html', new Map());
          mode = InsertionMode.BEFORE_HEAD; ti--;
        }
        break;

      case InsertionMode.BEFORE_HEAD:
        if (tok.kind === 'text' && !tok.text.trim()) break;
        if (tok.kind === 'open' && tok.tag === 'head') {
          headNode = insertElement('head', tok.attrs);
          mode = InsertionMode.IN_HEAD;
        } else {
          headNode = insertElement('head', new Map());
          mode = InsertionMode.IN_HEAD; ti--;
        }
        break;

      case InsertionMode.IN_HEAD:
        if (tok.kind === 'text' && !tok.text.trim()) { insertText(tok.text); break; }
        if (tok.kind === 'open') {
          var ht = tok.tag;
          if (ht === 'title' || ht === 'style' || ht === 'script' ||
              ht === 'noscript' || ht === 'meta' || ht === 'link' ||
              ht === 'base' || ht === 'template') {
            insertElement(ht, tok.attrs); break;
          }
        }
        if (tok.kind === 'close' && tok.tag === 'head') {
          popUntil('head'); mode = InsertionMode.AFTER_HEAD; break;
        }
        // Anything else: pop head implicitly
        if (!(tok.kind === 'open' && tok.tag === 'head')) {
          popUntil('head'); mode = InsertionMode.AFTER_HEAD; ti--;
        }
        break;

      case InsertionMode.AFTER_HEAD:
        if (tok.kind === 'text' && !tok.text.trim()) { insertText(tok.text); break; }
        if (tok.kind === 'open' && tok.tag === 'body') {
          insertElement('body', tok.attrs); mode = InsertionMode.IN_BODY; break;
        }
        insertElement('body', new Map()); mode = InsertionMode.IN_BODY; ti--;
        break;

      case InsertionMode.IN_BODY:
        if (tok.kind === 'text') { insertText(tok.text); break; }

        if (tok.kind === 'open') {
          var bt = tok.tag;

          // Close open <p> before block elements
          if (P_CLOSERS.has(bt) && hasInScope('p')) { popUntil('p'); }

          if (bt === 'table') {
            insertElement(bt, tok.attrs); mode = InsertionMode.IN_TABLE; break;
          }
          if (bt === 'li') {
            // Close any open <li>
            for (var osi = stack.length - 1; osi >= 0; osi--) {
              if (stack[osi].tag === 'li') { popUntil('li'); break; }
              if (P_CLOSERS.has(stack[osi].tag) && stack[osi].tag !== 'address' && stack[osi].tag !== 'div' && stack[osi].tag !== 'p') break;
            }
            insertElement(bt, tok.attrs); break;
          }
          if (bt === 'select') { insertElement(bt, tok.attrs); mode = InsertionMode.IN_SELECT; break; }
          if (bt === 'frameset') { mode = InsertionMode.IN_FRAMESET; break; }
          insertElement(bt, tok.attrs);
          break;
        }

        if (tok.kind === 'close' || tok.kind === 'self') {
          var ct = tok.tag;
          if (ct === 'body' || ct === 'html') {
            mode = InsertionMode.AFTER_BODY; break;
          }
          if (ct === 'p') {
            if (!hasInScope('p')) insertElement('p', new Map()); // implied open
            popUntil('p'); break;
          }
          if (hasInScope(ct)) { closeImplied(ct); popUntil(ct); }
          break;
        }
        break;

      case InsertionMode.TEXT:
        if (tok.kind === 'text') { insertText(tok.text); break; }
        if (tok.kind === 'close') { popUntil(tok.tag); mode = originalMode; break; }
        break;

      case InsertionMode.IN_TABLE:
        if (tok.kind === 'text') {
          // Accumulate text; flush via foster parenting (item 361)
          tableTextBuf.push(tok.text);
          mode = InsertionMode.IN_TABLE_TEXT;
          break;
        }
        if (tok.kind === 'open') {
          var tt = tok.tag;
          if (tt === 'caption') { insertElement(tt, tok.attrs); mode = InsertionMode.IN_CAPTION; break; }
          if (tt === 'colgroup' || tt === 'col') { insertElement(tt, tok.attrs); mode = InsertionMode.IN_COLUMN_GROUP; break; }
          if (tt === 'tbody' || tt === 'tfoot' || tt === 'thead') {
            insertElement(tt, tok.attrs); mode = InsertionMode.IN_TABLE_BODY; break;
          }
          if (tt === 'tr') {
            // Implied tbody
            insertElement('tbody', new Map()); mode = InsertionMode.IN_TABLE_BODY; ti--; break;
          }
          if (tt === 'td' || tt === 'th') {
            // Implied tbody + tr
            insertElement('tbody', new Map()); insertElement('tr', new Map());
            mode = InsertionMode.IN_ROW; ti--; break;
          }
          if (tt === 'table') {
            // Nested table: pop until old table and reprocess
            if (hasInTableScope('table')) { popUntil('table'); } ti--; break;
          }
          // Foster parent everything else (item 360)
          var fpNode = _makeTreeNode(tt, tok.attrs);
          fosterInsert(fpNode, stack, root);
          break;
        }
        if (tok.kind === 'close' && tok.tag === 'table') {
          if (hasInTableScope('table')) { popUntil('table'); }
          mode = InsertionMode.IN_BODY; break;
        }
        break;

      case InsertionMode.IN_TABLE_TEXT: {
        // [Item 361] Flush accumulated table text with foster parenting
        if (tok.kind === 'text') { tableTextBuf.push(tok.text); break; }
        var combined = tableTextBuf.join('');
        tableTextBuf = [];
        if (combined.trim()) {
          // Non-whitespace text: foster parent it before the table (item 361)
          var ftNode: TreeNode = { tag: '#text', attrs: new Map(), children: [], parent: null, text: combined };
          fosterInsert(ftNode, stack, root);
        } else {
          insertText(combined);
        }
        mode = InsertionMode.IN_TABLE; ti--;
        break;
      }

      case InsertionMode.IN_CAPTION:
        if (tok.kind === 'close' && tok.tag === 'caption') {
          if (hasInTableScope('caption')) { closeImplied(); popUntil('caption'); }
          mode = InsertionMode.IN_TABLE; break;
        }
        // Treat like IN_BODY
        mode = InsertionMode.IN_BODY; ti--;
        break;

      case InsertionMode.IN_COLUMN_GROUP:
        if (tok.kind === 'open' && tok.tag === 'col') { insertElement('col', tok.attrs); break; }
        if (tok.kind === 'close' && tok.tag === 'colgroup') { popUntil('colgroup'); mode = InsertionMode.IN_TABLE; break; }
        if (tok.kind === 'close' && tok.tag === 'col') break; // parse error, ignore
        popUntil('colgroup'); mode = InsertionMode.IN_TABLE; ti--;
        break;

      case InsertionMode.IN_TABLE_BODY:
        if (tok.kind === 'open' && tok.tag === 'tr') {
          insertElement('tr', tok.attrs); mode = InsertionMode.IN_ROW; break;
        }
        if (tok.kind === 'open' && (tok.tag === 'td' || tok.tag === 'th')) {
          insertElement('tr', new Map()); mode = InsertionMode.IN_ROW; ti--; break;
        }
        if (tok.kind === 'close') {
          var tbt = tok.tag;
          if (tbt === 'tbody' || tbt === 'tfoot' || tbt === 'thead') {
            if (hasInTableScope(tbt)) { popUntil(tbt); mode = InsertionMode.IN_TABLE; } break;
          }
          if (tbt === 'table') { mode = InsertionMode.IN_TABLE; ti--; break; }
        }
        break;

      case InsertionMode.IN_ROW:
        if (tok.kind === 'open' && (tok.tag === 'td' || tok.tag === 'th')) {
          insertElement(tok.tag, tok.attrs); mode = InsertionMode.IN_CELL; break;
        }
        if (tok.kind === 'close') {
          var rct = tok.tag;
          if (rct === 'tr') { if (hasInTableScope('tr')) { closeImplied(); popUntil('tr'); } mode = InsertionMode.IN_TABLE_BODY; break; }
          if (rct === 'table') { mode = InsertionMode.IN_TABLE_BODY; ti--; break; }
        }
        break;

      case InsertionMode.IN_CELL:
        if (tok.kind === 'close' && (tok.tag === 'td' || tok.tag === 'th')) {
          closeImplied(); popUntil(tok.tag); mode = InsertionMode.IN_ROW; break;
        }
        // Treat other content like IN_BODY
        mode = InsertionMode.IN_BODY; ti--;
        break;

      case InsertionMode.IN_SELECT:
        if (tok.kind === 'open' && tok.tag === 'option') { insertElement('option', tok.attrs); break; }
        if (tok.kind === 'close' && tok.tag === 'option') { popUntil('option'); break; }
        if (tok.kind === 'close' && tok.tag === 'select') { popUntil('select'); mode = InsertionMode.IN_BODY; break; }
        if (tok.kind === 'text') { insertText(tok.text); break; }
        break;

      case InsertionMode.IN_SELECT_IN_TABLE:
        if (tok.kind === 'close' && tok.tag === 'select') { popUntil('select'); mode = InsertionMode.IN_TABLE; break; }
        mode = InsertionMode.IN_SELECT; ti--;
        break;

      case InsertionMode.IN_TEMPLATE:
        if (templateModeStack.length > 0) {
          mode = templateModeStack.pop()!; ti--;
        }
        break;

      case InsertionMode.AFTER_BODY:
        if (tok.kind === 'close' && tok.tag === 'html') { mode = InsertionMode.AFTER_AFTER_BODY; break; }
        break;

      case InsertionMode.AFTER_AFTER_BODY:
        // Ignore (or parse error)
        break;

      case InsertionMode.IN_FRAMESET:
        if (tok.kind === 'open' && tok.tag === 'frameset') { insertElement('frameset', tok.attrs); break; }
        if (tok.kind === 'open' && tok.tag === 'frame') { insertElement('frame', tok.attrs); break; }
        if (tok.kind === 'close' && tok.tag === 'frameset') {
          if (stack.length > 1) popUntil('frameset');
          mode = InsertionMode.AFTER_FRAMESET; break;
        }
        break;

      case InsertionMode.AFTER_FRAMESET:
        if (tok.kind === 'close' && tok.tag === 'html') { mode = InsertionMode.AFTER_AFTER_BODY; break; }
        break;

      default:
        break;
    }
  }

  return root;
}

/**
 * [Item 362] Convert a TreeNode DOM to the RenderNode[] format expected by the
 * JSOS browser's render pipeline.
 *
 * This bridges the WHATWG tree construction output (TreeNode) back to the
 * existing `ParseResult` format used by `parseHTML()`.
 */
export function treeToRenderNodes(root: TreeNode): HtmlToken[] {
  var tokens: HtmlToken[] = [];
  function walk(node: TreeNode): void {
    if (node.tag === '#text') {
      tokens.push({ kind: 'text', tag: '', text: node.text ?? '', attrs: new Map() });
      return;
    }
    if (node.tag === '#comment' || node.tag === '#document') {
      for (var c of node.children) walk(c);
      return;
    }
    tokens.push({ kind: 'open', tag: node.tag, text: '', attrs: node.attrs });
    for (var ch of node.children) walk(ch);
    tokens.push({ kind: 'close', tag: node.tag, text: '', attrs: new Map() });
  }
  walk(root);
  return tokens;
}

/**
 * [Items 358, 360–362] Full spec-compliant HTML parse pipeline.
 *
 * 1. Tokenises with the WHATWG state machine (`tokeniseWHATWG`).
 * 2. Builds a tree with foster parenting and insertion mode state machine
 *    (`buildTreeWHATWG`).
 * 3. Converts back to the token stream accepted by `parseHTML()`.
 *
 * Usage:
 *   ```ts
 *   const tokens = parseHTMLWHATWG(rawHtml);
 *   const result = parseHTML(tokens.map(t => t), styles);  // re-use existing render pipeline
 *   ```
 */
export function tokeniseAndBuildTree(html: string): HtmlToken[] {
  var tokens = tokeniseWHATWG(html);
  var tree   = buildTreeWHATWG(tokens);
  return treeToRenderNodes(tree);
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 365] Incremental HTML parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 365] IncrementalHTMLParser — parse HTML in chunks without blocking
 * rendering on slow networks.
 *
 * Usage:
 * ```typescript
 * const parser = new IncrementalHTMLParser();
 * // Feed chunks as they arrive (e.g. from a streaming HTTP response)
 * parser.feed('<html><body><h1>Hell');
 * const partialTokens = parser.flush(); // tokens parsed so far
 * parser.feed('o!</h1></body></html>');
 * const finalTokens = parser.flush();
 * parser.end();
 * ```
 *
 * The parser buffers partial tags across chunk boundaries so that a tag
 * split across two chunks is correctly assembled before tokenisation.
 * This allows the browser to progressively render content as it arrives,
 * rather than blocking until the full document is loaded.
 *
 * Implementation notes:
 * - The parser maintains a carry buffer for incomplete tags
 * - Each call to `flush()` returns new tokens since last flush
 * - `end()` forces parsing of any remaining buffered text
 * - `allTokens()` returns the complete token stream so far
 * - Script/style content is buffered until the closing tag is seen
 */
export class IncrementalHTMLParser {
  private _buf    = '';   // accumulated unflushed HTML
  private _tokens: HtmlToken[] = [];  // all tokens parsed so far
  private _seenTokenIdx = 0;  // index of last token returned by flush()

  /**
   * Feed a chunk of HTML text to the parser.
   * @param chunk  Next chunk from the network stream
  */
  feed(chunk: string): void {
    this._buf += chunk;
  }

  /**
   * Parse as much complete content from the buffer as possible.
   *
   * Returns only the *new* tokens since the last `flush()` call.
   * Incomplete tags at the end of the buffer are left for the next chunk.
   */
  flush(): HtmlToken[] {
    // Find the last position that is definitely parseable (not mid-tag).
    // Strategy: find the last '>' and parse up to there. Leave the rest
    // in the buffer as it may be an incomplete tag.
    var safeEnd = this._buf.lastIndexOf('>');
    var parseStr: string;
    if (safeEnd === -1) {
      // No complete tags yet — no new tokens
      return [];
    }
    parseStr    = this._buf.slice(0, safeEnd + 1);
    this._buf   = this._buf.slice(safeEnd + 1);

    // Tokenize the safe portion using the WHATWG tokeniser
    var newTokens = tokeniseWHATWG(parseStr);
    this._tokens.push(...newTokens);

    // Return only the tokens not yet returned by a previous flush()
    var result = this._tokens.slice(this._seenTokenIdx);
    this._seenTokenIdx = this._tokens.length;
    return result;
  }

  /**
   * Signal end of input stream. Flushes any remaining buffered content.
   * After `end()` is called, `flush()` will always return an empty array.
   */
  end(): HtmlToken[] {
    // Parse remaining buffer even if it ends mid-tag
    if (this._buf.length > 0) {
      var remaining = tokeniseWHATWG(this._buf);
      this._buf = '';
      this._tokens.push(...remaining);
    }
    var result = this._tokens.slice(this._seenTokenIdx);
    this._seenTokenIdx = this._tokens.length;
    return result;
  }

  /**
   * Returns all tokens accumulated so far (including unflushed).
   * Useful to get the complete DOM after the stream has finished.
   */
  allTokens(): HtmlToken[] {
    return this._tokens.slice();
  }

  /**
   * Build a complete DOM tree from all tokens parsed so far.
   * Equivalent to calling `buildTreeWHATWG(this.allTokens())`.
   */
  buildTree(): TreeNode {
    return buildTreeWHATWG(this._tokens);
  }

  /**
   * Reset the parser to its initial state.
   */
  reset(): void {
    this._buf           = '';
    this._tokens        = [];
    this._seenTokenIdx  = 0;
  }

  /**
   * Returns how many characters are currently buffered (not yet parsed).
   * Useful for progress reporting.
   */
  get bufferedBytes(): number {
    return this._buf.length;
  }

  /**
   * Returns the total number of tokens parsed so far.
   */
  get tokenCount(): number {
    return this._tokens.length;
  }
}

/**
 * Convenience function: create an IncrementalHTMLParser that calls a callback
 * each time new tokens are available, enabling progressive page rendering.
 *
 * @param onTokens  Callback invoked with new tokens after each feed()
 * @returns         The parser instance (feed chunks to it)
 */
export function createStreamingParser(
  onTokens: (newTokens: HtmlToken[], allTokens: HtmlToken[]) => void
): IncrementalHTMLParser {
  var parser = new IncrementalHTMLParser();
  var origFeed = parser.feed.bind(parser);

  // Monkey-patch feed to auto-flush and call the callback
  (parser as any).feed = function(chunk: string): void {
    origFeed(chunk);
    var newToks = parser.flush();
    if (newToks.length > 0) {
      onTokens(newToks, parser.allTokens());
    }
  };

  return parser;
}

