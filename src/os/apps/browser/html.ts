import type {
  HtmlToken, ParseResult, RenderNode, InlineSpan, BlockType,
  WidgetBlueprint, WidgetKind, FormState, CSSProps, ScriptRecord,
} from './types.js';
import { parseInlineStyle } from './css.js';
import { type CSSRule, computeElementStyle, getPseudoContent } from './stylesheet.js';

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
      if (tok) tokens.push(tok);
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
  var linkHref    = '';
  var linkDepth   = 0;
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
    nodes.push(blk);
    inlineSpans = [];
  }

  function pushSpan(text: string): void {
    if (!text) return;
    if (inTableCell) { tableCellBuf += text; return; }
    if (skipDepth > 0) return;
    var sp: InlineSpan = { text };
    if (linkHref)                          sp.href      = linkHref;
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
    if (hasPseudo) {
      var pseudo = getPseudoContent(tag, id, cls, attrs, sheets);
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
              iTypeStr === 'search' || iTypeStr === 'tel'   || iTypeStr === 'date' ||
              iTypeStr === 'time'   || iTypeStr === 'color' || iTypeStr === 'range' ||
              iTypeStr === 'datetime-local' || iTypeStr === 'month' || iTypeStr === 'week') {
            iType = 'text';
          }

          var bp: WidgetBlueprint = {
            kind: iType, name: iName, value: iValue,
            checked: iChecked, disabled: iDisabled, readonly: iReadonly,
            formIdx: curFormIdx, cols: iSize || 20,
          };
          if (iType === 'radio') bp.radioGroup = iName;
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
          if (linkDepth === 0) linkHref = '';
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
  return { nodes, title, forms, widgets, baseURL, scripts, styles, styleLinks };
}
