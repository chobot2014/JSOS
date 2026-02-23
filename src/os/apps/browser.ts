/**
 * JSOS Browser — Native TypeScript HTML browser
 *
 * Full feature set:
 *   • HTML: h1–h6, p, a, ul/ol/li (nested), pre/code, blockquote, hr, table
 *   • Inline: <strong><em><code><del><mark> — mixed styles, word wrap
 *   • Forms: <form> GET/POST, <input> text/password/submit/reset/checkbox/radio/hidden
 *           <textarea>, <select>/<option>, <button>
 *   • Images: HTTP/HTTPS fetch, BMP 24/32-bit decode, pixel rendering; placeholder for others
 *   • Navigation: back/forward, history, bookmarks (Ctrl+D), view source (about:source)
 *   • Find in page: Ctrl+F, n/N cycle, Esc close
 *   • Keyboard: Ctrl+L URL, Ctrl+R reload, PgUp/PgDn, Home/End, Tab cycles form widgets
 *   • Status bar: link hover, load status, scroll %
 *   • Redirect following 3xx (max 5 hops)
 */

import { Canvas, Colors, type PixelColor } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';
import { dnsResolve } from '../net/dns.js';
import { httpGet, httpsGet, httpPost, httpsPost } from '../net/http.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Layout constants ──────────────────────────────────────────────────────────

const TOOLBAR_H   = 30;
const STATUSBAR_H = 14;
const FINDBAR_H   = 22;
const CHAR_W      = 8;
const CHAR_H      = 8;
const LINE_H      = 13;
const CONTENT_PAD = 8;

// ── Color palette ─────────────────────────────────────────────────────────────

const CLR_BG         = 0xFFFFFFFF;
const CLR_TOOLBAR_BG = 0xFFE8EAED;
const CLR_TOOLBAR_BD = 0xFFCDCDD3;
const CLR_STATUS_BG  = 0xFFF1F3F4;
const CLR_STATUS_TXT = 0xFF555555;
const CLR_URL_BG     = 0xFFFFFFFF;
const CLR_URL_FOCUS  = 0xFF1A73E8;
const CLR_BTN_BG     = 0xFFDADCE0;
const CLR_BTN_TXT    = 0xFF333333;
const CLR_LINK       = 0xFF1558D6;
const CLR_LINK_HOV   = 0xFF063099;
const CLR_VISITED    = 0xFF7C1DBF;
const CLR_H1         = 0xFF1A1A1A;
const CLR_H2         = 0xFF222288;
const CLR_H3         = 0xFF334499;
const CLR_BODY       = 0xFF202020;
const CLR_BOLD       = 0xFF000000;
const CLR_ITALIC     = 0xFF333388;
const CLR_CODE       = 0xFFBB3300;
const CLR_CODE_BG    = 0xFFF0F0F0;
const CLR_DEL        = 0xFF888888;
const CLR_MARK_BG    = 0xFFFFEE88;
const CLR_MARK_TXT   = 0xFF664400;
const CLR_PRE_BG     = 0xFFF6F8FA;
const CLR_PRE_TXT    = 0xFF24292E;
const CLR_HR         = 0xFF999999;
const CLR_QUOTE_BG   = 0xFFF6F6FF;
const CLR_QUOTE_BAR  = 0xFFBBBBDD;
const CLR_QUOTE_TXT  = 0xFF444466;
const CLR_FIND_BG    = 0xFFFFFFCC;
const CLR_FIND_MATCH = 0xFFFFCC00;
const CLR_FIND_CUR   = 0xFFFF8800;
const CLR_FIND_TXT   = 0xFF333333;
const CLR_FIND_BD    = 0xFFCCCC88;

// Widget colors
const CLR_INPUT_BG   = 0xFFFFFFFF;
const CLR_INPUT_BD   = 0xFF888888;
const CLR_INPUT_FOCUS= 0xFF1A73E8;
const CLR_INPUT_TXT  = 0xFF111111;
const CLR_BTN_SUB_BG = 0xFF4285F4;
const CLR_BTN_SUB_TXT= 0xFFFFFFFF;
const CLR_BTN_RST_BG = 0xFFEEEEEE;
const CLR_CHECK_FILL = 0xFF4285F4;
const CLR_IMG_PH_BG  = 0xFFEEEEEE;
const CLR_IMG_PH_BD  = 0xFFCCCCCC;
const CLR_IMG_PH_TXT = 0xFF888888;
const CLR_SEL_BG     = 0xFFFFFFFF;
const CLR_SEL_ARROW  = 0xFF555555;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedURL {
  protocol: 'http' | 'https' | 'about';
  host: string;
  port: number;
  path: string;
  raw: string;
}

interface InlineSpan {
  text:    string;
  href?:   string;
  bold?:   boolean;
  italic?: boolean;
  code?:   boolean;
  del?:    boolean;
  mark?:   boolean;
}

type BlockType =
  | 'block' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'hr' | 'li' | 'pre' | 'p-break' | 'blockquote' | 'widget';

interface RenderNode {
  type:    BlockType;
  spans:   InlineSpan[];
  indent?: number;
  widget?: WidgetBlueprint;
}

interface RenderedSpan {
  x:          number;
  text:       string;
  color:      PixelColor;
  href?:      string;
  bold?:      boolean;
  del?:       boolean;
  mark?:      boolean;
  codeBg?:    boolean;
  searchHit?: boolean;
  hitIdx?:    number;
}

interface RenderedLine {
  y:          number;
  nodes:      RenderedSpan[];
  lineH:      number;
  preBg?:     boolean;
  quoteBg?:   boolean;
  quoteBar?:  boolean;
  hrLine?:    boolean;
}

interface HistoryEntry { url: string; title: string; }

// ── Widget / Form types ───────────────────────────────────────────────────────

type WidgetKind =
  | 'text' | 'password' | 'submit' | 'reset' | 'button'
  | 'checkbox' | 'radio' | 'select' | 'textarea' | 'file' | 'hidden'
  | 'img';

interface WidgetBlueprint {
  kind:      WidgetKind;
  name:      string;
  value:     string;
  checked:   boolean;
  disabled:  boolean;
  readonly:  boolean;
  formIdx:   number;       // index into FormState[]
  options?:  string[];     // select option labels
  optVals?:  string[];     // select option values
  selIdx?:   number;       // initially selected option
  rows?:     number;       // textarea rows
  cols?:     number;       // textarea cols / input size
  imgSrc?:   string;       // img src
  imgAlt?:   string;
  imgNatW?:  number;       // natural width from HTML attr
  imgNatH?:  number;
  radioGroup?: string;     // name used for radio grouping
}

/** A widget after layout — knows its position in page space. */
interface PositionedWidget extends WidgetBlueprint {
  id:   number;
  px:   number;   // page x
  py:   number;   // page y
  pw:   number;   // width
  ph:   number;   // height
  // mutable runtime state
  curValue:  string;
  curChecked: boolean;
  curSelIdx:  number;
  cursorPos:  number;   // text cursor
  imgData:    Uint32Array | null;
  imgLoaded:  boolean;
}

interface FormState {
  action:  string;
  method:  'get' | 'post';
  enctype: string;
}

// ── Widget sizing constants ───────────────────────────────────────────────────

const WIDGET_INPUT_H  = 18;
const WIDGET_BTN_H    = 20;
const WIDGET_CHECK_SZ = 12;
const WIDGET_INPUT_W  = 180;  // default text input width
const WIDGET_AREA_H   = 60;   // default textarea height
const WIDGET_SELECT_H = 18;

// ── Byte array → string (chunked, avoids O(n²) concat) ───────────────────────
function bytesArrToStr(b: number[]): string {
  var CHUNK = 8192;
  if (b.length <= CHUNK) return String.fromCharCode.apply(null, b);
  var parts: string[] = [];
  for (var i = 0; i < b.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, b.slice(i, i + CHUNK)));
  }
  return parts.join('');
}

// ── URL parser ────────────────────────────────────────────────────────────────

function parseURL(raw: string): ParsedURL | null {
  raw = raw.trim();
  if (!raw) return null;
  if (raw.startsWith('about:')) {
    return { protocol: 'about', host: '', port: 0, path: raw.slice(6), raw };
  }
  var proto: 'http' | 'https';
  var rest: string;
  if (raw.startsWith('https://'))     { proto = 'https'; rest = raw.slice(8); }
  else if (raw.startsWith('http://')) { proto = 'http';  rest = raw.slice(7); }
  else {
    if (!raw.includes('/')) raw = raw + '/';
    raw = 'https://' + raw;
    proto = 'https'; rest = raw.slice(8);
  }
  var slash    = rest.indexOf('/');
  var hostPort = slash < 0 ? rest : rest.slice(0, slash);
  var path     = slash < 0 ? '/'  : rest.slice(slash) || '/';
  var colon    = hostPort.lastIndexOf(':');
  var host: string;
  var port: number;
  if (colon > 0) {
    host = hostPort.slice(0, colon);
    port = parseInt(hostPort.slice(colon + 1), 10) || (proto === 'https' ? 443 : 80);
  } else {
    host = hostPort;
    port = proto === 'https' ? 443 : 80;
  }
  if (!host) return null;
  return { protocol: proto, host, port, path, raw };
}

// ── URL encode / decode ────────────────────────────────────────────────────────

function urlEncode(s: string): string {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.' || c === '~') {
      out += c;
    } else if (c === ' ') {
      out += '+';
    } else {
      var code = s.charCodeAt(i);
      out += '%' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase();
    }
  }
  return out;
}

function encodeFormData(fields: Array<{name: string; value: string}>): number[] {
  var parts: string[] = [];
  for (var i = 0; i < fields.length; i++) {
    parts.push(urlEncode(fields[i].name) + '=' + urlEncode(fields[i].value));
  }
  var str = parts.join('&');
  var out = new Array(str.length);
  for (var j = 0; j < str.length; j++) out[j] = str.charCodeAt(j) & 0xFF;
  return out;
}

// ── BMP image decoder ─────────────────────────────────────────────────────────

interface DecodedImage {
  w:    number;
  h:    number;
  data: Uint32Array | null;  // 0xAARRGGBB pixels, null = decode failed
}

function decodeBMP(bytes: number[]): DecodedImage | null {
  if (bytes.length < 54) return null;
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4D) return null;   // "BM"

  function le32(off: number): number {
    return bytes[off] | (bytes[off+1] << 8) | (bytes[off+2] << 16) | (bytes[off+3] << 24);
  }
  function le16(off: number): number {
    return bytes[off] | (bytes[off+1] << 8);
  }

  var pixOff  = le32(10);
  var hdrSize = le32(14);
  var bmpW    = le32(18);
  var bmpH    = le32(22);
  var bpp     = le16(28);
  var topDown = false;
  if (bmpH < 0) { bmpH = -bmpH; topDown = true; }

  if (bmpW <= 0 || bmpH <= 0 || bmpW > 4096 || bmpH > 4096) return null;
  if (bpp !== 24 && bpp !== 32) return null;

  var bytesPerPixel = bpp >> 3;
  var rowStride     = (bmpW * bytesPerPixel + 3) & ~3;   // padded to 4 bytes
  var expectedSize  = pixOff + rowStride * bmpH;
  if (bytes.length < expectedSize) return null;

  var data = new Uint32Array(bmpW * bmpH);
  for (var row = 0; row < bmpH; row++) {
    var srcRow  = topDown ? row : (bmpH - 1 - row);
    var rowOff  = pixOff + srcRow * rowStride;
    var dstRow  = row * bmpW;
    for (var col = 0; col < bmpW; col++) {
      var p = rowOff + col * bytesPerPixel;
      var b = bytes[p];
      var g = bytes[p + 1];
      var r = bytes[p + 2];
      var a = bpp === 32 ? bytes[p + 3] : 0xFF;
      data[dstRow + col] = (a << 24) | (r << 16) | (g << 8) | b;
    }
  }
  return { w: bmpW, h: bmpH, data };
}

// ── HTML tokeniser ────────────────────────────────────────────────────────────

interface HtmlToken {
  kind:  'text' | 'open' | 'close' | 'self';
  tag:   string;
  text:  string;
  attrs: Map<string, string>;
}

// ── HTML entity decoder (single-pass, avoids 20+ sequential string copies) ───
function decodeHTMLEntities(raw: string): string {
  if (raw.indexOf('&') < 0) return raw;
  return raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    function(_m: string, dec: string, hex: string, name: string): string {
      if (dec)  return String.fromCharCode(parseInt(dec, 10));
      if (hex)  return String.fromCharCode(parseInt(hex, 16));
      switch (name) {
        case 'amp':    return '&';
        case 'lt':     return '<';
        case 'gt':     return '>';
        case 'quot':   return '"';
        case 'apos':   return "'";
        case 'nbsp':   return ' ';
        case 'mdash':  return '-';
        case 'ndash':  return '-';
        case 'hellip': return '...';
        case 'laquo':  return '<<';
        case 'raquo':  return '>>';
        case 'copy':   return '(c)';
        case 'reg':    return '(R)';
        case 'trade':  return '(TM)';
        case 'ldquo':  return '"';
        case 'rdquo':  return '"';
        case 'lsquo':  return "'";
        case 'rsquo':  return "'";
        case 'bull':   return '*';
        case 'middot': return '*';
        default:       return _m;
      }
    });
}

function tokenise(html: string): HtmlToken[] {
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
      var q = html[i++];
      var vs = i;
      while (i < n && html[i] !== q) i++;
      var v = html.slice(vs, i);
      if (i < n) i++;
      return v;
    }
    var vs2 = i;
    while (i < n && html[i] !== '>' && html[i] !== ' ' &&
           html[i] !== '\t' && html[i] !== '\n') i++;
    return html.slice(vs2, i);
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
    var tagS = i;
    while (i < n && html[i] !== '>' && html[i] !== '/' &&
           html[i] !== ' ' && html[i] !== '\t' && html[i] !== '\n')
      i++;
    var tag = html.slice(tagS, i).toLowerCase();
    var attrs = new Map<string, string>();
    skipWS();
    while (i < n && html[i] !== '>' && html[i] !== '/') {
      var nmS = i;
      while (i < n && html[i] !== '=' && html[i] !== '>' &&
             html[i] !== '/' && html[i] !== ' ' &&
             html[i] !== '\t' && html[i] !== '\n') i++;
      var nm = html.slice(nmS, i).toLowerCase().trim();
      skipWS();
      var vl = '';
      if (i < n && html[i] === '=') { i++; skipWS(); vl = readAttrValue(); }
      if (nm) attrs.set(nm, vl);
      skipWS();
    }
    var self = false;
    if (i < n && html[i] === '/') { self = true; i++; }
    if (i < n && html[i] === '>') i++;
    var kind: 'open'|'close'|'self' = close ? 'close' : (self ? 'self' : 'open');
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
      tokens.push({ kind: 'text', tag: '', text: decodeHTMLEntities(raw), attrs: new Map() });
    }
  }
  return tokens;
}

// ── HTML parser ───────────────────────────────────────────────────────────────

interface ParseResult {
  nodes:    RenderNode[];
  title:    string;
  forms:    FormState[];
  widgets:  WidgetBlueprint[];  // in order of appearance
}

function parseHTML(html: string): ParseResult {
  var tokens   = tokenise(html);
  var nodes:   RenderNode[]      = [];
  var title    = '';
  var forms:   FormState[]       = [];
  var widgets: WidgetBlueprint[] = [];

  var inTitle  = false;
  var inPre    = false;
  var inHead   = false;
  var inScript = false;
  var inStyle  = false;
  var bold     = 0;
  var italic   = 0;
  var codeInl  = 0;
  var del      = 0;
  var mark     = 0;
  var listDepth= 0;

  var inlineSpans: InlineSpan[] = [];
  var linkHref  = '';
  var linkDepth = 0;
  var openBlock: RenderNode | null = null;

  // Form tracking
  var curFormIdx  = -1;
  var inSelect    = false;
  var selectOpts:  string[] = [];
  var selectVals:  string[] = [];
  var selectSel    = 0;
  var inTextarea   = false;
  var textareaWip: WidgetBlueprint | null = null;

  var BLOCK_TAGS = new Set([
    'p','div','section','article','main','header','footer','nav','aside',
    'figure','address','details','summary','dd','dt','caption',
  ]);

  function flushInline(): void {
    if (!inlineSpans.length) return;
    var merged: InlineSpan[] = [];
    for (var mi = 0; mi < inlineSpans.length; mi++) {
      var sp = inlineSpans[mi];
      var prev = merged[merged.length - 1];
      if (prev && prev.href === sp.href && prev.bold === sp.bold &&
          prev.italic === sp.italic && prev.code === sp.code &&
          prev.del === sp.del && prev.mark === sp.mark) {
        prev.text += sp.text;
      } else {
        merged.push({ ...sp });
      }
    }
    nodes.push({ type: 'block', spans: merged });
    inlineSpans = [];
  }

  function pushSpan(text: string): void {
    if (!text) return;
    var sp: InlineSpan = { text };
    if (linkHref)    sp.href   = linkHref;
    if (bold   > 0)  sp.bold   = true;
    if (italic > 0)  sp.italic = true;
    if (codeInl > 0) sp.code   = true;
    if (del    > 0)  sp.del    = true;
    if (mark   > 0)  sp.mark   = true;
    if (openBlock) { openBlock.spans.push(sp); }
    else           { inlineSpans.push(sp); }
  }

  function pushWidget(bp: WidgetBlueprint): void {
    flushInline();
    if (openBlock) { nodes.push(openBlock); openBlock = null; }
    var idx = widgets.length;
    widgets.push(bp);
    nodes.push({ type: 'widget', spans: [], widget: bp });
  }

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];

    if (inScript) { if (tok.kind === 'close' && tok.tag === 'script') inScript = false; continue; }
    if (inStyle)  { if (tok.kind === 'close' && tok.tag === 'style')  inStyle  = false; continue; }

    // ── text inside <select> options or <textarea> ──────────────────────────
    if (inSelect) {
      if (tok.kind === 'text') {
        if (selectOpts.length > 0) {
          selectOpts[selectOpts.length - 1] += tok.text.trim();
        }
      } else if (tok.kind === 'open' && tok.tag === 'option') {
        var optVal = tok.attrs.get('value') || '';
        var isSelected = tok.attrs.has('selected');
        if (isSelected) selectSel = selectOpts.length;
        selectOpts.push('');
        selectVals.push(optVal);
      } else if ((tok.kind === 'close' || tok.kind === 'self') && tok.tag === 'select') {
        inSelect = false;
        // Widget was already pushed with empty options; update it via pending idx
        if (textareaWip) {
          textareaWip.options   = selectOpts;
          textareaWip.optVals   = selectVals;
          textareaWip.selIdx    = selectSel;
          textareaWip.curSelIdx = selectSel;
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
      switch (tok.tag) {
        case 'head':   inHead   = true;  break;
        case 'body':   inHead   = false; break;
        case 'title':  inTitle  = true;  break;
        case 'script': inScript = true;  break;
        case 'style':  inStyle  = true;  break;

        case 'strong': case 'b':  bold++;    break;
        case 'em':     case 'i':  italic++;  break;
        case 'code':   case 'tt': codeInl++; break;
        case 'del':    case 's':  del++;     break;
        case 'mark':              mark++;    break;
        case 'u': case 'sup': case 'sub': case 'abbr': case 'span': break;

        case 'a':
          linkHref = tok.attrs.get('href') || '';
          linkDepth++;
          break;

        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6':
          flushInline();
          openBlock = { type: tok.tag as BlockType, spans: [] };
          break;

        case 'pre': flushInline(); inPre = true; break;

        case 'br':
          if (inPre) { nodes.push({ type: 'pre', spans: [{ text: '' }] }); }
          else {
            if (openBlock) { nodes.push(openBlock); openBlock = null; }
            else            flushInline();
          }
          break;

        case 'hr': flushInline(); nodes.push({ type: 'hr', spans: [] }); break;

        case 'ul': case 'ol': flushInline(); listDepth++; break;
        case 'li':
          flushInline();
          openBlock = { type: 'li', spans: [], indent: Math.max(0, listDepth - 1) };
          break;

        case 'blockquote':
          flushInline();
          openBlock = { type: 'blockquote', spans: [], indent: 1 };
          break;

        // ── Forms ────────────────────────────────────────────────────────────
        case 'form': {
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          var fAction  = tok.attrs.get('action') || '';
          var fMethod  = (tok.attrs.get('method') || 'get').toLowerCase() as 'get'|'post';
          var fEnctype = tok.attrs.get('enctype') || 'application/x-www-form-urlencoded';
          curFormIdx   = forms.length;
          forms.push({ action: fAction, method: fMethod, enctype: fEnctype });
          break;
        }
        case '/form':
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          curFormIdx = -1;
          break;

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

          if (iType === 'hidden') {
            // Hidden inputs — no UI, still register for form submission
            widgets.push({
              kind: 'hidden', name: iName, value: iValue,
              checked: false, disabled: false, readonly: false, formIdx: curFormIdx,
            });
            break;
          }

          if (iType === 'image') iType = 'submit';  // treat image buttons as submit

          var bp: WidgetBlueprint = {
            kind: iType, name: iName, value: iValue,
            checked: iChecked, disabled: iDisabled, readonly: iReadonly,
            formIdx: curFormIdx,
            cols: iSize || 20,
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
          // We'll fill options as we parse inner <option> tags
          textareaWip = sBp;
          inSelect    = true;
          selectOpts  = [];
          selectVals  = [];
          selectSel   = 0;
          pushWidget(sBp);
          break;
        }

        // ── <textarea> ───────────────────────────────────────────────────────
        case 'textarea': {
          var rows  = parseInt(tok.attrs.get('rows') || '4', 10) || 4;
          var cols  = parseInt(tok.attrs.get('cols') || '40', 10) || 40;
          var taBp: WidgetBlueprint = {
            kind: 'textarea', name: tok.attrs.get('name') || '',
            value: '', checked: false, disabled: tok.attrs.has('disabled'),
            readonly: tok.attrs.has('readonly'), formIdx: curFormIdx,
            rows, cols,
          };
          textareaWip = taBp;
          inTextarea  = true;
          pushWidget(taBp);
          break;
        }

        // ── <button> ─────────────────────────────────────────────────────────
        case 'button': {
          var bType  = (tok.attrs.get('type') || 'submit').toLowerCase();
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
          var iSrc   = tok.attrs.get('src')    || '';
          var iAlt   = tok.attrs.get('alt')    || '';
          var iWStr  = tok.attrs.get('width')  || '0';
          var iHStr  = tok.attrs.get('height') || '0';
          var iNatW  = parseInt(iWStr, 10)  || 0;
          var iNatH  = parseInt(iHStr, 10)  || 0;
          pushWidget({
            kind: 'img', name: '', value: iAlt,
            checked: false, disabled: false, readonly: false, formIdx: -1,
            imgSrc: iSrc, imgAlt: iAlt, imgNatW: iNatW, imgNatH: iNatH,
          });
          break;
        }

        // ── Table ─────────────────────────────────────────────────────────────
        case 'table': flushInline(); nodes.push({ type: 'p-break', spans: [] }); break;
        case 'tr':    flushInline(); nodes.push({ type: 'p-break', spans: [] }); break;
        case 'th':    bold++; pushSpan('| '); break;
        case 'td':    pushSpan('| '); break;

        default:
          if (BLOCK_TAGS.has(tok.tag)) {
            flushInline();
            nodes.push({ type: 'p-break', spans: [] });
          }
          break;
      }

    } else if (tok.kind === 'close') {
      switch (tok.tag) {
        case 'head':  inHead  = false; break;
        case 'title': inTitle = false; break;

        case 'strong': case 'b':  bold    = Math.max(0, bold    - 1); break;
        case 'em':     case 'i':  italic  = Math.max(0, italic  - 1); break;
        case 'code':   case 'tt': codeInl = Math.max(0, codeInl - 1); break;
        case 'del':    case 's':  del     = Math.max(0, del     - 1); break;
        case 'mark':              mark    = Math.max(0, mark    - 1); break;

        case 'a':
          linkDepth = Math.max(0, linkDepth - 1);
          if (linkDepth === 0) linkHref = '';
          break;

        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          nodes.push({ type: 'p-break', spans: [] });
          break;

        case 'li':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          break;

        case 'blockquote':
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          break;

        case 'ul': case 'ol':
          listDepth = Math.max(0, listDepth - 1);
          nodes.push({ type: 'p-break', spans: [] });
          break;

        case 'pre': inPre = false; nodes.push({ type: 'p-break', spans: [] }); break;

        case 'form':
          flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          curFormIdx = -1;
          break;

        case 'button': break;  // button text was already pushed in open handler

        case 'th': bold = Math.max(0, bold - 1); pushSpan('  '); break;
        case 'td': pushSpan('  '); break;
        case 'table':
          pushSpan('|'); flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          break;

        default:
          if (BLOCK_TAGS.has(tok.tag)) {
            flushInline();
            nodes.push({ type: 'p-break', spans: [] });
          }
          break;
      }
    } else {
      // text token
      var txt = tok.text;
      if (inTitle) { title += txt.replace(/\s+/g, ' ').trim(); continue; }
      if (inHead)  continue;

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
      if (!txt.trim()) continue;
      pushSpan(txt);
    }
  }

  flushInline();
  return { nodes, title, forms, widgets };
}

// ── Inline word-flow layout ───────────────────────────────────────────────────

function flowSpans(
  spans:   InlineSpan[],
  xLeft:   number,
  maxX:    number,
  lineH:   number,
  baseClr: PixelColor,
  opts?: { preBg?: boolean; quoteBg?: boolean; quoteBar?: boolean; }
): RenderedLine[] {
  var lines:   RenderedLine[] = [];
  var curLine: RenderedSpan[] = [];
  var curX = xLeft;

  function spanColor(sp: InlineSpan): PixelColor {
    if (sp.href)   return CLR_LINK;
    if (sp.mark)   return CLR_MARK_TXT;
    if (sp.del)    return CLR_DEL;
    if (sp.code)   return CLR_CODE;
    if (sp.italic) return CLR_ITALIC;
    if (sp.bold)   return CLR_BOLD;
    return baseClr;
  }
  function commitLine(): void {
    lines.push({ y: 0, nodes: curLine, lineH,
                 preBg: opts?.preBg, quoteBg: opts?.quoteBg, quoteBar: opts?.quoteBar });
    curLine = []; curX = xLeft;
  }
  function addWord(word: string, sp: InlineSpan): void {
    var clr = spanColor(sp);
    var nspc = curX > xLeft;
    var spcW = nspc ? CHAR_W : 0;
    if (curX + spcW + word.length * CHAR_W > maxX && curX > xLeft) {
      commitLine(); nspc = false; spcW = 0;
    }
    while (word.length > 0) {
      var avail = Math.max(1, Math.floor((maxX - curX - spcW) / CHAR_W));
      if (avail <= 0 && curX > xLeft) { commitLine(); nspc = false; spcW = 0;
        avail = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W)); }
      var chunk   = word.slice(0, avail);
      var display = (nspc ? ' ' : '') + chunk;
      var rsp: RenderedSpan = { x: curX, text: display, color: clr };
      if (sp.href)   rsp.href   = sp.href;
      if (sp.bold)   rsp.bold   = true;
      if (sp.del)    rsp.del    = true;
      if (sp.mark)   rsp.mark   = true;
      if (sp.code)   rsp.codeBg = true;
      curLine.push(rsp);
      curX += display.length * CHAR_W;
      word = word.slice(chunk.length); nspc = false; spcW = 0;
    }
  }

  for (var si = 0; si < spans.length; si++) {
    var sp    = spans[si];
    var parts = sp.text.split('\n');
    for (var pi = 0; pi < parts.length; pi++) {
      if (pi > 0) { commitLine(); }
      var part = parts[pi];
      if (!part) continue;
      var words = part.split(' ');
      for (var wi = 0; wi < words.length; wi++) {
        var word = words[wi];
        if (!word) { if (curX > xLeft) curX += CHAR_W; continue; }
        addWord(word, sp);
      }
    }
  }
  if (curLine.length > 0) commitLine();
  return lines;
}

// ── Layout engine ─────────────────────────────────────────────────────────────

interface LayoutResult {
  lines:   RenderedLine[];
  widgets: PositionedWidget[];
}

var _widgetCounter = 0;

function layoutNodes(
  nodes:   RenderNode[],
  bps:     WidgetBlueprint[],
  contentW: number
): LayoutResult {
  var lines:   RenderedLine[]     = [];
  var widgets: PositionedWidget[] = [];
  var y     = CONTENT_PAD;
  var xLeft = CONTENT_PAD;
  var maxX  = contentW - CONTENT_PAD;

  function blank(h: number): void {
    lines.push({ y, nodes: [], lineH: h }); y += h;
  }
  function commit(newLines: RenderedLine[]): void {
    for (var k = 0; k < newLines.length; k++) {
      newLines[k].y = y; y += newLines[k].lineH; lines.push(newLines[k]);
    }
  }

  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];

    if (nd.type === 'p-break') { blank(LINE_H >> 1); continue; }

    if (nd.type === 'hr') {
      lines.push({ y, nodes: [], lineH: 3, hrLine: true }); y += 8; continue;
    }

    if (nd.type === 'pre') {
      var preText  = nd.spans[0]?.text ?? '';
      var maxPreCh = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W));
      lines.push({ y, nodes: [{ x: xLeft, text: preText.slice(0, maxPreCh), color: CLR_PRE_TXT }],
                   lineH: LINE_H, preBg: true });
      y += LINE_H; continue;
    }

    if (/^h[1-6]$/.test(nd.type)) {
      var level = parseInt(nd.type[1]!, 10);
      var hClr  = level === 1 ? CLR_H1 : level === 2 ? CLR_H2 : CLR_H3;
      var lhH   = level <= 2 ? LINE_H + 8 : level <= 4 ? LINE_H + 4 : LINE_H + 2;
      if (y > CONTENT_PAD) blank(level <= 2 ? LINE_H : LINE_H >> 1);
      var hSpans = nd.spans.length > 0
        ? nd.spans.map(s => ({ ...s, bold: true }))
        : [{ text: '(untitled)', bold: true }];
      commit(flowSpans(hSpans, xLeft, maxX, lhH, hClr));
      blank(level <= 2 ? LINE_H >> 1 : 2); continue;
    }

    if (nd.type === 'li') {
      var depth   = (nd.indent || 0) + 1;
      var bxLeft  = xLeft + (depth - 1) * (CHAR_W * 3);
      var txLeft  = bxLeft + CHAR_W * 3;
      var bullets = ['•', '◦', '▪'];
      var bullet  = (bullets[Math.min(depth - 1, 2)] || '•') + ' ';
      var bulletR: RenderedSpan = { x: bxLeft, text: bullet, color: CLR_BODY };
      if (nd.spans.length === 0) {
        lines.push({ y, nodes: [bulletR], lineH: LINE_H }); y += LINE_H;
      } else {
        var itemLines = flowSpans(nd.spans, txLeft, maxX, LINE_H, CLR_BODY);
        if (itemLines.length > 0) itemLines[0].nodes.unshift(bulletR);
        else itemLines = [{ y: 0, nodes: [bulletR], lineH: LINE_H }];
        commit(itemLines);
      }
      continue;
    }

    if (nd.type === 'blockquote') {
      var bqLeft  = xLeft + CHAR_W * 4;
      commit(flowSpans(nd.spans, bqLeft, maxX - CHAR_W * 2, LINE_H, CLR_QUOTE_TXT,
                       { quoteBg: true, quoteBar: true }));
      blank(LINE_H >> 1); continue;
    }

    if (nd.type === 'block') {
      commit(flowSpans(nd.spans, xLeft, maxX, LINE_H, CLR_BODY)); continue;
    }

    // ── Widgets ───────────────────────────────────────────────────────────────
    if (nd.type === 'widget' && nd.widget) {
      var bp = nd.widget;

      // Hidden fields take no screen space
      if (bp.kind === 'hidden') continue;

      // Compute widget dimensions
      var ww = 0; var wh = 0;
      var wOpts = bp.options || [];

      switch (bp.kind) {
        case 'text':
        case 'password':
          ww = (bp.cols || 20) * CHAR_W + 8;
          wh = WIDGET_INPUT_H;
          break;
        case 'submit':
        case 'reset':
        case 'button':
          var btnLabel = bp.value || (bp.kind === 'reset' ? 'Reset' : 'Submit');
          ww = btnLabel.length * CHAR_W + 24;
          wh = WIDGET_BTN_H;
          break;
        case 'checkbox':
        case 'radio':
          ww = WIDGET_CHECK_SZ + CHAR_W * 2;
          wh = WIDGET_CHECK_SZ;
          break;
        case 'select':
          var longestOpt = 8;
          for (var oi = 0; oi < wOpts.length; oi++) {
            if (wOpts[oi].length > longestOpt) longestOpt = wOpts[oi].length;
          }
          ww = longestOpt * CHAR_W + 24;
          wh = WIDGET_SELECT_H;
          break;
        case 'textarea':
          ww = Math.min((bp.cols || 40) * CHAR_W + 8, maxX - xLeft);
          wh = (bp.rows || 4) * LINE_H + 4;
          break;
        case 'img':
          ww = bp.imgNatW || 200;
          wh = bp.imgNatH || 100;
          if (ww > maxX - xLeft) {
            var scale = (maxX - xLeft) / ww;
            ww = Math.floor(ww * scale);
            wh = Math.floor(wh * scale);
          }
          break;
        default:
          ww = WIDGET_INPUT_W; wh = WIDGET_INPUT_H;
      }

      // Place widget — leave spacing
      if (bp.kind !== 'checkbox' && bp.kind !== 'radio') {
        if (y > CONTENT_PAD) { blank(4); }
      }

      var pw: PositionedWidget = {
        ...bp,
        id: ++_widgetCounter,
        px: xLeft, py: y, pw: ww, ph: wh,
        curValue:   bp.value   || '',
        curChecked: bp.checked || false,
        curSelIdx:  bp.selIdx  || 0,
        cursorPos:  (bp.value || '').length,
        imgData:    null,
        imgLoaded:  false,
      };
      widgets.push(pw);

      // Reserve space in line list (blank sentinel)
      lines.push({ y, nodes: [], lineH: wh + 4 });
      y += wh + 4;

      if (bp.kind !== 'checkbox' && bp.kind !== 'radio') {
        blank(4);
      }
      continue;
    }
  }

  return { lines, widgets };
}

// ── Built-in pages ────────────────────────────────────────────────────────────

function aboutJsosHTML(): string {
  return [
    '<h1>JSOS Browser</h1>',
    '<p>Welcome to the JSOS native TypeScript browser — running on bare metal,',
    'built entirely in TypeScript with no Chromium or external runtimes.</p>',

    '<h2>About JSOS</h2>',
    '<p><strong>JSOS</strong> is an operating system written entirely in TypeScript',
    'running on a bare-metal i686 PC via QuickJS (ES2023).</p>',
    '<blockquote>TypeScript is not a guest in this OS — TypeScript <em>IS</em> the OS.</blockquote>',

    '<h2>Browser Features</h2>',
    '<ul>',
    '<li><strong>HTML</strong>: h1–h6, p, a, ul/ol (nested), pre/code, blockquote, hr, table, img</li>',
    '<li><strong>Inline styling</strong>: &lt;strong&gt;, &lt;em&gt;, &lt;code&gt;, &lt;del&gt;, &lt;mark&gt;</li>',
    '<li><strong>Forms</strong>: &lt;input&gt; text/password/submit/reset/checkbox/radio,',
    '&lt;textarea&gt;, &lt;select&gt;, &lt;button&gt; — GET and POST</li>',
    '<li><strong>Images</strong>: BMP decode + pixel render; placeholder for other formats</li>',
    '<li><strong>Networking</strong>: DNS, HTTP/1.1, HTTPS via TLS 1.3</li>',
    '<li><strong>Find in page</strong>: Ctrl+F, n/N cycle, Esc close</li>',
    '<li><strong>Bookmarks</strong>: Ctrl+D to save</li>',
    '</ul>',

    '<h2>Keyboard Shortcuts</h2>',
    '<ul>',
    '<li><code>Ctrl+L</code> — focus URL bar</li>',
    '<li><code>Ctrl+R</code> — reload</li>',
    '<li><code>Ctrl+D</code> — bookmark page</li>',
    '<li><code>Ctrl+F</code> — find in page</li>',
    '<li><code>Tab</code> — cycle form fields</li>',
    '<li><code>b / f</code> — back / forward</li>',
    '<li><code>Space / PgDn</code> — scroll down</li>',
    '<li><code>PgUp</code> — scroll up</li>',
    '<li><code>Home / End</code> — top / bottom</li>',
    '</ul>',

    '<h2>Demo Form</h2>',
    '<form action="about:jsos" method="get">',
    '<p>Name: <input type="text" name="name" value=""></p>',
    '<p>Password: <input type="password" name="pw" value=""></p>',
    '<p>Remember me: <input type="checkbox" name="remember" value="1"></p>',
    '<p>Colour: <input type="radio" name="clr" value="red"> Red',
    '  <input type="radio" name="clr" value="blue" checked> Blue</p>',
    '<p>Version:',
    '<select name="ver">',
    '<option value="1">JSOS 1.0</option>',
    '<option value="2" selected>JSOS 2.0</option>',
    '</select></p>',
    '<p>Comment:<br><textarea name="comment" rows="3" cols="40">Type here...</textarea></p>',
    '<p><input type="submit" value="Submit"> <input type="reset" value="Reset"></p>',
    '</form>',

    '<h2>Links</h2>',
    '<ul>',
    '<li><a href="about:history">Browsing history</a></li>',
    '<li><a href="about:bookmarks">Bookmarks</a></li>',
    '<li><a href="about:source">View page source</a></li>',
    '<li><a href="about:blank">Blank page</a></li>',
    '</ul>',
  ].join('\n');
}

function errorHTML(url: string, reason: string): string {
  return [
    '<h1>Cannot reach this page</h1>',
    '<p><strong>' + url + '</strong></p>',
    '<p>' + reason + '</p>',
    '<hr>',
    '<p><a href="about:jsos">JSOS Browser Home</a></p>',
  ].join('\n');
}

// ── Browser App ───────────────────────────────────────────────────────────────

export class BrowserApp implements App {
  readonly name = 'Browser';

  private _win:           WMWindow | null = null;
  private _urlInput       = 'about:jsos';
  private _urlBarFocus    = true;
  private _cursorBlink    = 0;

  private _history:       HistoryEntry[] = [];
  private _histIdx        = -1;
  private _visited        = new Set<string>();
  private _bookmarks:     HistoryEntry[] = [];

  private _pageTitle      = 'JSOS Browser';
  private _pageURL        = 'about:jsos';
  private _pageSource     = '';
  private _pageLines:     RenderedLine[] = [];
  private _scrollY        = 0;
  private _maxScrollY     = 0;
  private _loading        = false;
  private _status         = '';
  private _dirty          = true;
  private _hoverHref      = '';

  // Form / widget state
  private _forms:         FormState[]     = [];
  private _widgets:       PositionedWidget[] = [];
  private _focusedWidget  = -1;   // index into _widgets, -1 = none

  // Image cache: maps src URL → decoded image (null data = placeholder)
  private _imgCache       = new Map<string, DecodedImage | null>();
  private _imgsFetching   = false;

  // Find in page
  private _findMode       = false;
  private _findQuery      = '';
  private _findHits:      Array<{ lineIdx: number; spanIdx: number }> = [];
  private _findCur        = 0;

  // Deferred load
  private _pendingLoad:      string | null = null;
  private _pendingLoadReady  = false;
  private _pendingNavPush    = false;
  private _redirectDepth     = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onMount(win: WMWindow): void {
    this._win = win;
    this._navigate('about:jsos');
  }

  onUnmount(): void {
    this._win = null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onKey(event: KeyEvent): void {
    var ch  = event.ch;
    var ext = event.ext;

    // ── Find bar ────────────────────────────────────────────────────────────
    if (this._findMode) {
      if (ch === '\x1b') { this._clearFind(); return; }
      if (ch === '\n' || ch === '\r') { this._cycleFind(1); return; }
      if (ch === 'n') { this._cycleFind(1);  return; }
      if (ch === 'N') { this._cycleFind(-1); return; }
      if (ch === '\b') { this._findQuery = this._findQuery.slice(0, -1); }
      else if (ch >= ' ') { this._findQuery += ch; }
      this._doFind(); this._dirty = true; return;
    }

    // ── Focused form widget ──────────────────────────────────────────────────
    if (this._focusedWidget >= 0) {
      var fw = this._widgets[this._focusedWidget];
      if (fw) {
        if (this._handleWidgetKey(fw, ch, ext)) return;
      }
    }

    // ── URL bar ──────────────────────────────────────────────────────────────
    if (this._urlBarFocus) {
      if (ch === '\x0c') { this._urlInput = ''; this._dirty = true; return; }
      if (ch === '\n' || ch === '\r') {
        var raw = this._urlInput.trim();
        if (raw) {
          this._pendingLoad = raw; this._pendingNavPush = true;
          this._pendingLoadReady = false; this._loading = true; this._dirty = true;
        }
        return;
      }
      if (ch === '\b')   { this._urlInput = this._urlInput.slice(0, -1); this._dirty = true; return; }
      if (ch === '\x1b') { this._urlBarFocus = false; this._dirty = true; return; }
      if (ch >= ' ')     { this._urlInput += ch; this._dirty = true; return; }
      return;
    }

    // ── Tab — cycle focused widget ──────────────────────────────────────────
    if (ch === '\t') {
      this._cycleFocusedWidget(1); return;
    }

    // ── Content scroll / navigation ─────────────────────────────────────────
    if (ext) {
      if (ext === 0x48) { this._scrollBy(-LINE_H * 3);         return; }
      if (ext === 0x50) { this._scrollBy( LINE_H * 3);         return; }
      if (ext === 0x4B) { this._goBack();                       return; }
      if (ext === 0x4D) { this._goForward();                    return; }
      if (ext === 0x49) { this._scrollBy(-this._contentH());    return; }
      if (ext === 0x51) { this._scrollBy( this._contentH());    return; }
      if (ext === 0x47) { this._scrollBy(-this._maxScrollY);    return; }
      if (ext === 0x4F) { this._scrollBy( this._maxScrollY);    return; }
    }

    if (ch === '\x0c') { this._urlBarFocus = true; this._urlInput = this._pageURL; this._dirty = true; return; }
    if (ch === '\x12') { this._reload(); return; }
    if (ch === '\x04') { this._addBookmark(); return; }
    if (ch === '\x06') { this._openFind(); return; }

    if (ch === ' ')           { this._scrollBy( this._contentH()); return; }
    if (ch === 'b' || ch === 'B') { this._goBack();    return; }
    if (ch === 'f' || ch === 'F') { this._goForward(); return; }
    if (ch === 'r' || ch === 'R') { this._reload();    return; }
    if (ch === '/' || ch === 'l') { this._urlBarFocus = true; this._dirty = true; return; }
  }

  onMouse(event: MouseEvent): void {
    if (!this._win) return;

    var contentY0 = TOOLBAR_H;
    var contentY1 = this._win.height - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);

    if (event.type === 'down') {
      // Toolbar buttons
      if (event.y >= 5 && event.y <= 24) {
        if (event.x >= 4  && event.x <= 25) { this._goBack();    return; }
        if (event.x >= 28 && event.x <= 49) { this._goForward(); return; }
        if (event.x >= 52 && event.x <= 73) { this._reload();    return; }
        if (event.x > 76) { this._urlBarFocus = true; this._dirty = true; return; }
      }

      // Scrollbar click
      if (this._maxScrollY > 0 && event.x >= this._win.width - 10 &&
          event.y >= contentY0 && event.y < contentY1) {
        var chh  = contentY1 - contentY0;
        var frac = (event.y - contentY0) / chh;
        this._scrollY = Math.round(frac * this._maxScrollY);
        this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY));
        this._dirty = true; return;
      }

      if (event.y >= contentY0 && event.y < contentY1) {
        var cy = event.y - contentY0 + this._scrollY;
        var cx = event.x;

        // Hit test widgets first
        var widgetIdx = this._hitTestWidget(cx, cy);
        if (widgetIdx >= 0) {
          this._handleWidgetClick(widgetIdx, cx, cy); return;
        }

        // Hit test links
        var href = this._hitTestLink(cx, cy);
        if (href) {
          var resolved = this._resolveHref(href);
          this._visited.add(resolved);
          this._urlBarFocus = false;
          this._pendingLoad = resolved; this._pendingNavPush = true;
          this._pendingLoadReady = false; this._loading = true; this._dirty = true;
          return;
        }

        // Defocus widget on empty click
        if (this._focusedWidget >= 0) { this._focusedWidget = -1; this._dirty = true; }
        this._urlBarFocus = false; this._dirty = true;
      }
    }

    // Hover
    if (event.y >= contentY0 && event.y < contentY1) {
      var cy2  = event.y - contentY0 + this._scrollY;
      var newH = this._hitTestLink(event.x, cy2);
      if (newH !== this._hoverHref) { this._hoverHref = newH; this._dirty = true; }
    } else if (this._hoverHref) {
      this._hoverHref = ''; this._dirty = true;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(canvas: Canvas): boolean {
    this._cursorBlink++;
    if ((this._cursorBlink & 31) === 0) this._dirty = true;

    if (this._pendingLoad !== null) {
      if (!this._pendingLoadReady) {
        this._pendingLoadReady = true; this._dirty = true;
        this._drawToolbar(canvas);
        this._drawContent(canvas);
        this._drawStatusBar(canvas);
        if (this._findMode) this._drawFindBar(canvas);
        return true;
      } else {
        var pu = this._pendingLoad!;
        var ph = this._pendingNavPush;
        this._pendingLoad = null; this._pendingLoadReady = false;
        if (ph) { this._navigate(pu); }
        else    { this._redirectDepth = 0; this._load(pu); }
      }
    }

    if (!this._dirty) return false;
    this._dirty = false;

    this._drawToolbar(canvas);
    this._drawContent(canvas);
    this._drawStatusBar(canvas);
    if (this._findMode) this._drawFindBar(canvas);
    return true;
  }

  private _contentH(): number {
    if (!this._win) return 400;
    return this._win.height - TOOLBAR_H - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);
  }

  private _drawToolbar(canvas: Canvas): void {
    var w = canvas.width;
    canvas.fillRect(0, 0, w, TOOLBAR_H, CLR_TOOLBAR_BG);
    canvas.drawLine(0, TOOLBAR_H - 1, w, TOOLBAR_H - 1, CLR_TOOLBAR_BD);

    canvas.fillRect(4, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(10, 11, '<', this._histIdx > 0 ? CLR_BTN_TXT : CLR_HR);

    canvas.fillRect(28, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(35, 11, '>', this._histIdx < this._history.length - 1 ? CLR_BTN_TXT : CLR_HR);

    canvas.fillRect(52, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(58, 11, this._loading ? 'X' : 'R', CLR_BTN_TXT);

    var urlX = 76;
    var urlW = w - urlX - 4;
    canvas.fillRect(urlX, 5, urlW, 20, CLR_URL_BG);
    canvas.drawRect(urlX, 5, urlW, 20, this._urlBarFocus ? CLR_URL_FOCUS : CLR_TOOLBAR_BD);

    var display  = this._urlBarFocus ? this._urlInput : this._pageURL;
    var maxChars = Math.max(1, Math.floor((urlW - 8) / CHAR_W));
    var showTxt  = display.length > maxChars ? display.slice(display.length - maxChars) : display;
    canvas.drawText(urlX + 4, 12, showTxt, CLR_BODY);

    if (this._urlBarFocus && (this._cursorBlink >> 4) % 2 === 0) {
      var ccx = urlX + 4 + showTxt.length * CHAR_W;
      if (ccx <= urlX + urlW - 4) canvas.fillRect(ccx, 10, 1, CHAR_H, CLR_BODY);
    }
  }

  private _drawContent(canvas: Canvas): void {
    var w   = canvas.width;
    var ch  = this._contentH();
    var y0  = TOOLBAR_H;

    canvas.fillRect(0, y0, w, ch, CLR_BG);

    if (this._loading) {
      canvas.drawText(CONTENT_PAD, y0 + 20, 'Loading  ' + this._pageURL + ' ...', CLR_STATUS_TXT);
      return;
    }

    // Draw text lines — binary-search for the first line that intersects the viewport
    // (lines are laid out top-to-bottom with monotonically increasing y values).
    var _bsLo = 0, _bsHi = this._pageLines.length;
    while (_bsLo < _bsHi) {
      var _bsMid = (_bsLo + _bsHi) >> 1;
      if (this._pageLines[_bsMid].y + this._pageLines[_bsMid].lineH <= this._scrollY)
        _bsLo = _bsMid + 1;
      else
        _bsHi = _bsMid;
    }
    for (var i = _bsLo; i < this._pageLines.length; i++) {
      var line  = this._pageLines[i];
      var lineY = line.y - this._scrollY;
      if (lineY > ch) break;

      var absY = y0 + lineY;

      if (line.hrLine) {
        canvas.fillRect(CONTENT_PAD, absY + 1, w - CONTENT_PAD * 2, 1, CLR_HR); continue;
      }
      if (line.quoteBg) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, CLR_QUOTE_BG);
        canvas.fillRect(CONTENT_PAD, absY - 1, 3, line.lineH + 1, CLR_QUOTE_BAR);
      }
      if (line.preBg) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, CLR_PRE_BG);
      }

      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (!span.text) continue;
        var clr = span.color;
        if (span.href) {
          clr = this._visited.has(span.href) ? CLR_VISITED
              : span.href === this._hoverHref ? CLR_LINK_HOV : CLR_LINK;
        }
        if (span.codeBg) canvas.fillRect(span.x - 1, absY - 1, span.text.length * CHAR_W + 2, CHAR_H + 2, CLR_CODE_BG);
        if (span.mark)   canvas.fillRect(span.x, absY - 1, span.text.length * CHAR_W, CHAR_H + 2, CLR_MARK_BG);
        if (span.searchHit) {
          var hc = span.hitIdx === this._findCur ? CLR_FIND_CUR : CLR_FIND_MATCH;
          canvas.fillRect(span.x, absY - 1, span.text.length * CHAR_W, CHAR_H + 2, hc);
        }
        canvas.drawText(span.x, absY, span.text, clr);
        if (span.bold) canvas.drawText(span.x + 1, absY, span.text, clr);
        if (span.href) canvas.drawLine(span.x, absY + CHAR_H, span.x + span.text.length * CHAR_W, absY + CHAR_H, clr);
        if (span.del) {
          var mY = absY + Math.floor(CHAR_H / 2);
          canvas.drawLine(span.x, mY, span.x + span.text.length * CHAR_W, mY, CLR_DEL);
        }
      }
    }

    // Draw widgets
    this._drawWidgets(canvas, y0, ch);

    // Scrollbar
    if (this._maxScrollY > 0 && ch > 0) {
      var trackH  = ch - 4;
      var thumbH  = Math.max(12, Math.floor(trackH * ch / (ch + this._maxScrollY)));
      var thumbY0 = Math.floor((trackH - thumbH) * this._scrollY / this._maxScrollY);
      canvas.fillRect(w - 8, y0 + 2, 6, trackH, CLR_TOOLBAR_BG);
      canvas.fillRect(w - 8, y0 + 2 + thumbY0, 6, thumbH, CLR_BTN_BG);
      canvas.drawRect(w - 8, y0 + 2 + thumbY0, 6, thumbH, CLR_TOOLBAR_BD);
    }
  }

  private _drawWidgets(canvas: Canvas, y0: number, ch: number): void {
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var w = this._widgets[wi];
      var wy = y0 + w.py - this._scrollY;
      if (wy + w.ph < y0 || wy > y0 + ch) continue;

      var focused = (wi === this._focusedWidget);

      switch (w.kind) {
        case 'text':
        case 'password':
          this._drawInputField(canvas, w, wy, focused); break;
        case 'textarea':
          this._drawTextarea(canvas, w, wy, focused); break;
        case 'submit':
        case 'reset':
        case 'button':
          this._drawButton(canvas, w, wy); break;
        case 'checkbox':
          this._drawCheckbox(canvas, w, wy); break;
        case 'radio':
          this._drawRadio(canvas, w, wy); break;
        case 'select':
          this._drawSelect(canvas, w, wy, focused); break;
        case 'img':
          this._drawImage(canvas, w, wy); break;
      }
    }
  }

  private _drawInputField(canvas: Canvas, w: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(w.px, wy, w.pw, w.ph, CLR_INPUT_BG);
    canvas.drawRect(w.px, wy, w.pw, w.ph, bdClr);

    var maxCh  = Math.max(1, Math.floor((w.pw - 8) / CHAR_W));
    var disp   = w.kind === 'password' ? '*'.repeat(w.curValue.length) : w.curValue;
    // Show end of value if too long
    var showStr = disp.length > maxCh ? disp.slice(disp.length - maxCh) : disp;
    canvas.drawText(w.px + 4, wy + 5, showStr, CLR_INPUT_TXT);

    if (focused && (this._cursorBlink >> 4) % 2 === 0) {
      var cursorX = w.px + 4 + Math.min(w.cursorPos, maxCh) * CHAR_W;
      canvas.fillRect(cursorX, wy + 4, 1, CHAR_H, CLR_INPUT_TXT);
    }
  }

  private _drawTextarea(canvas: Canvas, w: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(w.px, wy, w.pw, w.ph, CLR_INPUT_BG);
    canvas.drawRect(w.px, wy, w.pw, w.ph, bdClr);

    var maxCh  = Math.max(1, Math.floor((w.pw - 8) / CHAR_W));
    var rows   = w.rows || 4;
    var lines  = w.curValue.split('\n');
    for (var ri = 0; ri < Math.min(rows, lines.length); ri++) {
      var lineStr = lines[ri].slice(0, maxCh);
      canvas.drawText(w.px + 4, wy + 4 + ri * LINE_H, lineStr, CLR_INPUT_TXT);
    }

    if (focused && (this._cursorBlink >> 4) % 2 === 0) {
      // Simple cursor at end
      var lastLine = lines[Math.min(rows - 1, lines.length - 1)] || '';
      var tx = w.px + 4 + Math.min(lastLine.length, maxCh) * CHAR_W;
      var ty = wy + 4 + (Math.min(lines.length, rows) - 1) * LINE_H;
      canvas.fillRect(tx, ty, 1, CHAR_H, CLR_INPUT_TXT);
    }
  }

  private _drawButton(canvas: Canvas, w: PositionedWidget, wy: number): void {
    var bgClr  = w.kind === 'reset' || w.kind === 'button' ? CLR_BTN_RST_BG : CLR_BTN_SUB_BG;
    var txtClr = w.kind === 'reset' || w.kind === 'button' ? CLR_BTN_TXT    : CLR_BTN_SUB_TXT;
    var label  = w.curValue || (w.kind === 'reset' ? 'Reset' : 'Submit');
    canvas.fillRect(w.px, wy, w.pw, w.ph, bgClr);
    canvas.drawRect(w.px, wy, w.pw, w.ph, CLR_INPUT_BD);
    var tx = w.px + Math.floor((w.pw - label.length * CHAR_W) / 2);
    var ty = wy + Math.floor((w.ph - CHAR_H) / 2);
    canvas.drawText(tx, ty, label, txtClr);
  }

  private _drawCheckbox(canvas: Canvas, w: PositionedWidget, wy: number): void {
    var sz = WIDGET_CHECK_SZ;
    canvas.fillRect(w.px, wy, sz, sz, CLR_INPUT_BG);
    canvas.drawRect(w.px, wy, sz, sz, CLR_INPUT_BD);
    if (w.curChecked) {
      canvas.fillRect(w.px + 2, wy + 2, sz - 4, sz - 4, CLR_CHECK_FILL);
      canvas.drawText(w.px + 2, wy + 2, 'v', CLR_BTN_SUB_TXT);
    }
    if (w.curValue) {
      canvas.drawText(w.px + sz + 4, wy + 2, w.curValue, CLR_BODY);
    }
  }

  private _drawRadio(canvas: Canvas, w: PositionedWidget, wy: number): void {
    var sz = WIDGET_CHECK_SZ;
    canvas.fillRect(w.px, wy, sz, sz, CLR_INPUT_BG);
    canvas.drawRect(w.px, wy, sz, sz, CLR_INPUT_BD);
    if (w.curChecked) {
      canvas.fillRect(w.px + 3, wy + 3, sz - 6, sz - 6, CLR_CHECK_FILL);
    }
    if (w.curValue) {
      canvas.drawText(w.px + sz + 4, wy + 2, w.curValue, CLR_BODY);
    }
  }

  private _drawSelect(canvas: Canvas, w: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(w.px, wy, w.pw, w.ph, CLR_SEL_BG);
    canvas.drawRect(w.px, wy, w.pw, w.ph, bdClr);

    var opts   = w.options || [];
    var selIdx = w.curSelIdx;
    var label  = opts[selIdx] || '';
    var maxCh  = Math.max(1, Math.floor((w.pw - 20) / CHAR_W));
    canvas.drawText(w.px + 4, wy + 5, label.slice(0, maxCh), CLR_INPUT_TXT);

    // Dropdown arrow
    canvas.drawText(w.px + w.pw - 14, wy + 5, 'v', CLR_SEL_ARROW);
    canvas.drawLine(w.px + w.pw - 16, wy, w.px + w.pw - 16, wy + w.ph, CLR_INPUT_BD);
  }

  private _drawImage(canvas: Canvas, w: PositionedWidget, wy: number): void {
    if (!w.imgLoaded && !this._imgsFetching) {
      // Placeholder
      canvas.fillRect(w.px, wy, w.pw, w.ph, CLR_IMG_PH_BG);
      canvas.drawRect(w.px, wy, w.pw, w.ph, CLR_IMG_PH_BD);
      var alt = w.imgAlt || w.imgSrc || '';
      if (alt) {
        var maxC = Math.max(1, Math.floor((w.pw - 8) / CHAR_W));
        canvas.drawText(w.px + 4, wy + Math.max(0, Math.floor((w.ph - CHAR_H) / 2)),
                        ('[' + alt + ']').slice(0, maxC), CLR_IMG_PH_TXT);
      }
      return;
    }

    if (w.imgData) {
      // Fast path: bulk Uint32Array.set() per row — imgData is already in
      // native canvas format (0xAARRGGBB), no per-pixel conversion needed.
      canvas.blitPixelsDirect(w.imgData, w.pw, w.ph, w.px, wy);
    } else {
      // Failed fetch placeholder
      canvas.fillRect(w.px, wy, w.pw, w.ph, CLR_IMG_PH_BG);
      canvas.drawRect(w.px, wy, w.pw, w.ph, 0xFFFF9999);
      var errMsg = 'Image unavailable';
      canvas.drawText(w.px + 4, wy + Math.floor((w.ph - CHAR_H) / 2), errMsg, 0xFFCC4444);
    }
  }

  private _drawStatusBar(canvas: Canvas): void {
    var w  = canvas.width;
    var y0 = canvas.height - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);
    canvas.fillRect(0, y0, w, STATUSBAR_H, CLR_STATUS_BG);
    canvas.drawLine(0, y0, w, y0, CLR_TOOLBAR_BD);
    var txt = this._hoverHref ? 'Link: ' + this._hoverHref : (this._status || this._pageTitle);
    if (!this._hoverHref && this._maxScrollY > 0) {
      txt += '  (' + Math.round(100 * this._scrollY / this._maxScrollY) + '%)';
    }
    canvas.drawText(4, y0 + 3, txt.slice(0, Math.floor((w - 8) / CHAR_W)), CLR_STATUS_TXT);
  }

  private _drawFindBar(canvas: Canvas): void {
    var w  = canvas.width;
    var y0 = canvas.height - STATUSBAR_H - FINDBAR_H;
    canvas.fillRect(0, y0, w, FINDBAR_H, CLR_FIND_BG);
    canvas.drawLine(0, y0, w, y0, CLR_FIND_BD);
    canvas.drawText(4, y0 + 7, 'Find:', CLR_FIND_TXT);
    var ix = 4 + 6 * CHAR_W;
    var iw = Math.min(200, w - ix - 30 * CHAR_W);
    canvas.fillRect(ix - 2, y0 + 4, iw + 4, FINDBAR_H - 8, CLR_URL_BG);
    canvas.drawRect(ix - 2, y0 + 4, iw + 4, FINDBAR_H - 8, CLR_FIND_BD);
    var mq = Math.floor(iw / CHAR_W);
    var sq = this._findQuery.length > mq ? this._findQuery.slice(-mq) : this._findQuery;
    canvas.drawText(ix, y0 + 7, sq, CLR_FIND_TXT);
    if ((this._cursorBlink >> 4) % 2 === 0) {
      canvas.fillRect(ix + sq.length * CHAR_W, y0 + 6, 1, CHAR_H, CLR_FIND_TXT);
    }
    var htxt = this._findHits.length > 0
      ? (this._findCur + 1) + ' / ' + this._findHits.length
      : (this._findQuery ? 'No matches' : '');
    var hx = ix + iw + 8;
    canvas.drawText(hx, y0 + 7, htxt, CLR_STATUS_TXT);
    canvas.drawText(hx + htxt.length * CHAR_W + 12, y0 + 7, 'n/N next/prev  Esc close', CLR_HR);
  }

  // ── Widget interaction ─────────────────────────────────────────────────────

  private _hitTestWidget(cx: number, cy: number): number {
    for (var i = 0; i < this._widgets.length; i++) {
      var w = this._widgets[i];
      if (cx >= w.px && cx < w.px + w.pw + 20 &&   // +20 for label text next to checkbox
          cy >= w.py && cy < w.py + w.ph) {
        return i;
      }
    }
    return -1;
  }

  private _handleWidgetClick(idx: number, cx: number, cy: number): void {
    var w = this._widgets[idx];
    if (w.disabled) return;

    switch (w.kind) {
      case 'text':
      case 'password':
      case 'textarea':
        this._focusedWidget = idx;
        this._urlBarFocus   = false;
        w.cursorPos = w.curValue.length;
        this._dirty = true;
        break;

      case 'submit':
      case 'button':
        this._submitForm(w.formIdx, w.name, w.curValue);
        break;

      case 'reset':
        this._resetForm(w.formIdx);
        break;

      case 'checkbox':
        w.curChecked = !w.curChecked;
        this._dirty = true;
        break;

      case 'radio':
        // Uncheck all radios in same group and same form
        for (var ri = 0; ri < this._widgets.length; ri++) {
          var rw = this._widgets[ri];
          if (rw.kind === 'radio' && rw.name === w.name && rw.formIdx === w.formIdx) {
            rw.curChecked = (ri === idx);
          }
        }
        this._dirty = true;
        break;

      case 'select':
        // Cycle through options on click
        var opts = w.options || [];
        if (opts.length > 0) {
          w.curSelIdx = (w.curSelIdx + 1) % opts.length;
          this._dirty = true;
        }
        this._focusedWidget = idx;
        break;
    }
  }

  private _handleWidgetKey(w: PositionedWidget, ch: string, ext: number): boolean {
    if (w.disabled || w.readonly) return false;

    switch (w.kind) {
      case 'text':
      case 'password': {
        if (ext === 0x4B) {  // Left
          w.cursorPos = Math.max(0, w.cursorPos - 1); this._dirty = true; return true;
        }
        if (ext === 0x4D) {  // Right
          w.cursorPos = Math.min(w.curValue.length, w.cursorPos + 1); this._dirty = true; return true;
        }
        if (ext === 0x47) { w.cursorPos = 0; this._dirty = true; return true; }  // Home
        if (ext === 0x4F) { w.cursorPos = w.curValue.length; this._dirty = true; return true; }  // End
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\n' || ch === '\r') { this._submitForm(w.formIdx, '', ''); return true; }
        if (ch === '\b') {
          if (w.cursorPos > 0) {
            w.curValue  = w.curValue.slice(0, w.cursorPos - 1) + w.curValue.slice(w.cursorPos);
            w.cursorPos = Math.max(0, w.cursorPos - 1);
            this._dirty = true;
          }
          return true;
        }
        if (ch >= ' ') {
          w.curValue  = w.curValue.slice(0, w.cursorPos) + ch + w.curValue.slice(w.cursorPos);
          w.cursorPos++;
          this._dirty = true;
          return true;
        }
        return false;
      }

      case 'textarea': {
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\b') {
          if (w.curValue.length > 0) { w.curValue = w.curValue.slice(0, -1); this._dirty = true; }
          return true;
        }
        if (ch === '\n' || ch === '\r') {
          w.curValue += '\n'; this._dirty = true; return true;
        }
        if (ch >= ' ') { w.curValue += ch; this._dirty = true; return true; }
        return false;
      }

      case 'select': {
        var opts = w.options || [];
        if (ext === 0x48 || ch === 'k') {  // Up
          w.curSelIdx = Math.max(0, w.curSelIdx - 1); this._dirty = true; return true;
        }
        if (ext === 0x50 || ch === 'j') {  // Down
          w.curSelIdx = Math.min(opts.length - 1, w.curSelIdx + 1); this._dirty = true; return true;
        }
        if (ch === '\x1b' || ch === '\t') { this._cycleFocusedWidget(1); return true; }
        return false;
      }

      case 'checkbox':
        if (ch === ' ' || ch === '\n' || ch === '\r') {
          w.curChecked = !w.curChecked; this._dirty = true; return true;
        }
        return false;

      case 'radio':
        if (ch === ' ' || ch === '\n' || ch === '\r') {
          for (var ri = 0; ri < this._widgets.length; ri++) {
            var rw = this._widgets[ri];
            if (rw.kind === 'radio' && rw.name === w.name && rw.formIdx === w.formIdx) {
              rw.curChecked = (this._widgets[ri] === w);
            }
          }
          this._dirty = true; return true;
        }
        return false;

      case 'submit':
      case 'button':
        if (ch === '\n' || ch === '\r' || ch === ' ') {
          this._submitForm(w.formIdx, w.name, w.curValue); return true;
        }
        return false;

      case 'reset':
        if (ch === '\n' || ch === '\r' || ch === ' ') { this._resetForm(w.formIdx); return true; }
        return false;
    }
    return false;
  }

  private _cycleFocusedWidget(dir: number): void {
    var total = this._widgets.length;
    if (total === 0) return;
    var next = (this._focusedWidget + dir + total) % total;
    // Skip non-interactive widgets
    var tries = 0;
    while (tries < total) {
      var wk = this._widgets[next].kind;
      if (wk !== 'hidden' && wk !== 'img') {
        this._focusedWidget = next; this._dirty = true; return;
      }
      next = (next + dir + total) % total; tries++;
    }
  }

  // ── Form submission ────────────────────────────────────────────────────────

  private _submitForm(formIdx: number, submitName: string, submitValue: string): void {
    var form = this._forms[formIdx];
    if (!form) {
      // Formless submit — just navigate current URL
      this._reload(); return;
    }

    // Collect field values
    var fields: Array<{name: string; value: string}> = [];
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var w = this._widgets[wi];
      if (w.formIdx !== formIdx) continue;
      if (w.disabled) continue;

      switch (w.kind) {
        case 'text':
        case 'password':
        case 'textarea':
          if (w.name) fields.push({ name: w.name, value: w.curValue });
          break;
        case 'checkbox':
          if (w.curChecked && w.name) fields.push({ name: w.name, value: w.curValue || '1' });
          break;
        case 'radio':
          if (w.curChecked && w.name) fields.push({ name: w.name, value: w.curValue });
          break;
        case 'select': {
          var vals = w.optVals || [];
          var val  = vals[w.curSelIdx] !== undefined ? vals[w.curSelIdx] : (w.options || [])[w.curSelIdx] || '';
          if (w.name) fields.push({ name: w.name, value: val });
          break;
        }
        case 'hidden':
          if (w.name) fields.push({ name: w.name, value: w.curValue });
          break;
      }
    }

    // Add submit button name/value if named
    if (submitName) fields.push({ name: submitName, value: submitValue });

    var action  = form.action || this._pageURL;
    var resolved = this._resolveHref(action);

    if (form.method === 'post') {
      this._submitPost(resolved, fields);
    } else {
      // GET: append query string
      var qs = fields.map(f => urlEncode(f.name) + '=' + urlEncode(f.value)).join('&');
      var url = resolved + (resolved.includes('?') ? '&' : '?') + qs;
      this._pendingLoad = url; this._pendingNavPush = true;
      this._pendingLoadReady = false; this._loading = true; this._dirty = true;
    }
  }

  private _submitPost(url: string, fields: Array<{name: string; value: string}>): void {
    var body      = encodeFormData(fields);
    var parsed    = parseURL(url);
    if (!parsed || parsed.protocol === 'about') { this._showError(url, 'Cannot POST to ' + url); return; }

    this._status = 'Submitting form...';
    this._loading = true; this._dirty = true;

    var ip: string | null = null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host)) {
      ip = parsed.host;
    } else {
      try { ip = dnsResolve(parsed.host); } catch (_e) { ip = null; }
    }
    if (!ip) { this._showError(url, 'DNS failed for ' + parsed.host); return; }

    var resp: import('../net/http.js').HttpResponse | null = null;
    try {
      if (parsed.protocol === 'https') {
        var r = httpsPost(parsed.host, ip, parsed.port, parsed.path, body);
        resp = r.response;
      } else {
        resp = httpPost(parsed.host, ip, parsed.port, parsed.path, body);
      }
    } catch (_e2) { resp = null; }

    if (!resp) { this._showError(url, 'POST failed'); return; }

    // Push POST result as a new history entry
    this._histIdx++;
    this._history.splice(this._histIdx);
    this._history.push({ url, title: url });

    var bodyStr = bytesArrToStr(resp.body);
    this._pageSource = bodyStr;
    this._showHTML(bodyStr, '', url);
    this._status = 'POST ' + resp.status + '  ' + ip;
  }

  private _resetForm(formIdx: number): void {
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var w = this._widgets[wi];
      if (w.formIdx !== formIdx) continue;
      w.curValue   = w.value;
      w.curChecked = w.checked;
      w.curSelIdx  = w.selIdx || 0;
      w.cursorPos  = w.value.length;
    }
    this._dirty = true;
  }

  // ── Image fetching ────────────────────────────────────────────────────────

  private _fetchImages(): void {
    this._imgsFetching = true;
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var w = this._widgets[wi];
      if (w.kind !== 'img' || w.imgLoaded) continue;
      var src = w.imgSrc || '';
      if (!src) { w.imgLoaded = true; w.imgData = null; continue; }

      if (this._imgCache.has(src)) {
        var cached = this._imgCache.get(src)!;
        if (cached) {
          w.imgData   = cached.data;
          w.pw        = cached.w;
          w.ph        = cached.h;
        } else {
          w.imgData = null;
        }
        w.imgLoaded = true;
        continue;
      }

      // Fetch the image
      var decoded = this._fetchImage(src);
      this._imgCache.set(src, decoded);
      if (decoded) {
        w.imgData = decoded.data;
        w.pw      = decoded.w;
        w.ph      = decoded.h;
      } else {
        w.imgData = null;
      }
      w.imgLoaded = true;
    }
    this._imgsFetching = false;
    this._dirty = true;
  }

  private _fetchImage(src: string): DecodedImage | null {
    var resolved = this._resolveHref(src);
    var parsed   = parseURL(resolved);
    if (!parsed || parsed.protocol === 'about') return null;

    var ip: string | null = null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host)) {
      ip = parsed.host;
    } else {
      try { ip = dnsResolve(parsed.host); } catch (_e) { ip = null; }
    }
    if (!ip) return null;

    var resp: import('../net/http.js').HttpResponse | null = null;
    try {
      if (parsed.protocol === 'https') {
        var r = httpsGet(parsed.host, ip, parsed.port, parsed.path);
        resp = r.response;
      } else {
        resp = httpGet(parsed.host, ip, parsed.port, parsed.path);
      }
    } catch (_e2) { resp = null; }

    if (!resp || resp.status !== 200 || resp.body.length < 2) return null;

    // Try BMP
    if (resp.body[0] === 0x42 && resp.body[1] === 0x4D) {
      var bmp = decodeBMP(resp.body);
      if (bmp) return bmp;
    }

    return null;  // unsupported format — placeholder will be shown
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private _navigate(url: string): void {
    this._redirectDepth = 0;
    this._histIdx++;
    this._history.splice(this._histIdx);
    this._history.push({ url, title: url });
    this._load(url);
  }

  private _resolveHref(href: string): string {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('about:')) {
      return href;
    }
    if (href.startsWith('//')) {
      return (this._pageURL.startsWith('https://') ? 'https' : 'http') + ':' + href;
    }
    if (href.startsWith('/')) {
      var p = parseURL(this._pageURL);
      if (!p) return href;
      var ps = (p.protocol === 'http' && p.port === 80) ||
               (p.protocol === 'https' && p.port === 443) ? '' : ':' + p.port;
      return p.protocol + '://' + p.host + ps + href;
    }
    return this._pageURL.replace(/\/[^/]*$/, '/') + href;
  }

  private _goBack(): void {
    if (this._histIdx <= 0) return;
    this._histIdx--;
    this._scheduleLoad(this._history[this._histIdx].url, false);
  }

  private _goForward(): void {
    if (this._histIdx >= this._history.length - 1) return;
    this._histIdx++;
    this._scheduleLoad(this._history[this._histIdx].url, false);
  }

  private _reload(): void {
    this._scheduleLoad(this._pageURL, false);
  }

  private _scheduleLoad(url: string, push: boolean): void {
    this._pendingLoad = url; this._pendingNavPush = push;
    this._pendingLoadReady = false; this._loading = true; this._dirty = true;
  }

  private _scrollBy(delta: number): void {
    this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + delta));
    this._dirty = true;
  }

  private _hitTestLink(x: number, cy: number): string {
    // Binary search — lines are sorted by ascending y (layout is top-to-bottom).
    var lo = 0, hi = this._pageLines.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var line = this._pageLines[mid];
      if (cy < line.y) {
        hi = mid - 1;
      } else if (cy >= line.y + line.lineH) {
        lo = mid + 1;
      } else {
        // cy falls inside this line — check spans
        for (var j = 0; j < line.nodes.length; j++) {
          var span = line.nodes[j];
          if (span.href && x >= span.x && x <= span.x + span.text.length * CHAR_W) {
            return span.href;
          }
        }
        return '';
      }
    }
    return '';
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────

  private _addBookmark(): void {
    for (var bi = 0; bi < this._bookmarks.length; bi++) {
      if (this._bookmarks[bi].url === this._pageURL) {
        this._status = 'Already bookmarked'; this._dirty = true; return;
      }
    }
    this._bookmarks.push({ url: this._pageURL, title: this._pageTitle });
    this._status = 'Bookmarked: ' + this._pageTitle; this._dirty = true;
  }

  private _bookmarksHTML(): string {
    if (!this._bookmarks.length) {
      return '<h1>Bookmarks</h1><p>No bookmarks yet. Press <code>Ctrl+D</code> to bookmark a page.</p>';
    }
    var ls = ['<h1>Bookmarks</h1><ul>'];
    for (var i = 0; i < this._bookmarks.length; i++) {
      var bk = this._bookmarks[i];
      ls.push('<li><a href="' + bk.url + '">' + (bk.title || bk.url) + '</a></li>');
    }
    ls.push('</ul>');
    return ls.join('\n');
  }

  // ── Find in page ──────────────────────────────────────────────────────────

  private _openFind(): void {
    this._findMode  = true; this._findQuery = '';
    this._findHits  = []; this._findCur = 0;
    this._clearSearchHighlights(); this._dirty = true;
  }

  private _clearFind(): void {
    this._findMode = false; this._clearSearchHighlights(); this._dirty = true;
  }

  private _clearSearchHighlights(): void {
    for (var i = 0; i < this._pageLines.length; i++) {
      var ns = this._pageLines[i].nodes;
      for (var j = 0; j < ns.length; j++) { delete ns[j].searchHit; delete ns[j].hitIdx; }
    }
  }

  private _doFind(): void {
    this._clearSearchHighlights(); this._findHits = [];
    if (!this._findQuery) return;
    var q = this._findQuery.toLowerCase(); var idx = 0;
    for (var i = 0; i < this._pageLines.length; i++) {
      var ns = this._pageLines[i].nodes;
      for (var j = 0; j < ns.length; j++) {
        if (ns[j].text.toLowerCase().indexOf(q) >= 0) {
          ns[j].searchHit = true; ns[j].hitIdx = idx;
          this._findHits.push({ lineIdx: i, spanIdx: j }); idx++;
        }
      }
    }
    this._findCur = 0;
    if (this._findHits.length > 0) this._scrollToFindHit();
  }

  private _cycleFind(dir: number): void {
    if (!this._findHits.length) return;
    this._findCur = (this._findCur + dir + this._findHits.length) % this._findHits.length;
    this._scrollToFindHit(); this._dirty = true;
  }

  private _scrollToFindHit(): void {
    if (this._findCur >= this._findHits.length) return;
    var hit  = this._findHits[this._findCur];
    var line = this._pageLines[hit.lineIdx];
    if (!line) return;
    var ch = this._contentH();
    if (line.y < this._scrollY || line.y + line.lineH > this._scrollY + ch) {
      this._scrollY = Math.max(0, line.y - Math.floor(ch / 3));
    }
    this._dirty = true;
  }

  // ── HTTP fetch + layout ───────────────────────────────────────────────────

  private _load(rawURL: string): void {
    this._pageURL    = rawURL;
    this._urlInput   = rawURL;
    this._loading    = true;
    this._scrollY    = 0;
    this._hoverHref  = '';
    this._status     = 'Loading...';
    this._dirty      = true;
    this._focusedWidget = -1;

    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].url = rawURL;
    }

    var parsed = parseURL(rawURL);
    if (!parsed) { this._showError(rawURL, 'Invalid URL'); return; }

    if (parsed.protocol === 'about') {
      var html = '';
      switch (parsed.path) {
        case 'blank':     html = '';                        break;
        case 'jsos':      html = aboutJsosHTML();           break;
        case 'history':   html = this._historyHTML();       break;
        case 'bookmarks': html = this._bookmarksHTML();     break;
        case 'source':    html = this._sourceHTML();        break;
        default:          html = errorHTML(rawURL, 'Unknown about: page'); break;
      }
      this._pageSource = html;
      this._showHTML(html, parsed.path, rawURL);
      return;
    }

    this._status = 'Resolving ' + parsed.host + '...'; this._dirty = true;
    var ip: string | null = null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host)) { ip = parsed.host; }
    else { try { ip = dnsResolve(parsed.host); } catch (_e) { ip = null; } }
    if (!ip) { this._showError(rawURL, 'DNS lookup failed for ' + parsed.host); return; }

    kernel.serialPut('[browser] ' + parsed.host + ' -> ' + ip + '\n');
    this._status = 'Connecting to ' + ip + '...'; this._dirty = true;

    var resp: import('../net/http.js').HttpResponse | null = null;
    try {
      if (parsed.protocol === 'https') {
        var tr = httpsGet(parsed.host, ip, parsed.port, parsed.path);
        if (!tr.tlsOk) kernel.serialPut('[browser] TLS handshake failed\n');
        resp = tr.response;
      } else {
        resp = httpGet(parsed.host, ip, parsed.port, parsed.path);
      }
    } catch (_e2) { resp = null; }

    if (!resp) { this._showError(rawURL, 'Connection failed: ' + ip + ':' + parsed.port); return; }
    kernel.serialPut('[browser] HTTP ' + resp.status + ' ' + resp.body.length + 'B\n');

    if (resp.status >= 300 && resp.status < 400) {
      var loc = resp.headers.get('location') || '';
      if (loc && this._redirectDepth < 5) {
        this._redirectDepth++;
        kernel.serialPut('[browser] redirect ' + this._redirectDepth + ' -> ' + loc + '\n');
        this._load(this._resolveHref(loc)); return;
      } else if (loc) { this._showError(rawURL, 'Too many redirects'); return; }
    }

    if (resp.status < 200 || resp.status >= 400) {
      this._showError(rawURL, 'HTTP ' + resp.status + ' error'); return;
    }

    var bodyStr = bytesArrToStr(resp.body);
    this._pageSource = bodyStr;

    var ct = resp.headers.get('content-type') || 'text/html';
    if (ct.indexOf('text/html') >= 0 || ct.indexOf('application/xhtml') >= 0) {
      this._showHTML(bodyStr, '', rawURL);
    } else {
      this._showPlainText(bodyStr, rawURL);
    }
    this._status = 'HTTP ' + resp.status + '  ' + ip + '  ' + resp.body.length + ' B';
  }

  private _showHTML(html: string, fallbackTitle: string, url: string): void {
    var r = parseHTML(html);
    this._forms = r.forms;
    this._layoutPage(r.nodes, r.widgets, r.title || fallbackTitle || url, url);
  }

  private _showPlainText(text: string, url: string): void {
    var pnodes: RenderNode[] = text.split('\n').map(l => ({
      type: 'pre' as BlockType, spans: [{ text: l }],
    }));
    this._forms = [];
    this._layoutPage(pnodes, [], url, url);
  }

  private _showError(url: string, reason: string): void {
    kernel.serialPut('[browser] error: ' + reason + '\n');
    var r = parseHTML(errorHTML(url, reason));
    this._forms = r.forms;
    this._layoutPage(r.nodes, r.widgets, 'Error', url);
    this._status = reason;
  }

  private _layoutPage(
    nodes: RenderNode[], bps: WidgetBlueprint[],
    title: string, url: string): void {
    this._loading    = false;
    this._pageTitle  = title;
    this._pageURL    = url;
    this._urlInput   = url;
    this._scrollY    = 0;

    var w = this._win ? this._win.canvas.width : 800;
    var lr = layoutNodes(nodes, bps, w);
    this._pageLines = lr.lines;
    this._widgets   = lr.widgets;

    var contentH = this._contentH();
    var last     = this._pageLines[this._pageLines.length - 1];
    var totalH   = last ? last.y + last.lineH + CONTENT_PAD : 0;
    // Account for widget extents
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wbot = this._widgets[wi].py + this._widgets[wi].ph + CONTENT_PAD;
      if (wbot > totalH) totalH = wbot;
    }
    this._maxScrollY = Math.max(0, totalH - contentH);

    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].title = title;
    }

    if (this._findMode && this._findQuery) this._doFind();

    // Kick off image fetching (synchronous but deferred until after first paint)
    var hasImages = this._widgets.some(wg => wg.kind === 'img' && !wg.imgLoaded);
    if (hasImages) {
      // Will be fetched on next render after page is displayed
      this._dirty = true;
    }

    this._dirty = true;
  }

  private _historyHTML(): string {
    if (!this._history.length) return '<h1>History</h1><p>No pages visited yet.</p>';
    var ls = ['<h1>Browsing History</h1><ul>'];
    for (var i = this._history.length - 1; i >= 0; i--) {
      var e = this._history[i];
      ls.push('<li><a href="' + e.url + '">' + (e.title || e.url) + '</a></li>');
    }
    ls.push('</ul>');
    return ls.join('\n');
  }

  private _sourceHTML(): string {
    if (!this._pageSource) {
      return '<h1>Page Source</h1><p>No source — navigate to a page first.</p>';
    }
    var esc = this._pageSource.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<h1>Page Source: ' + this._pageURL + '</h1><pre>' + esc + '</pre>';
  }
}

export const browserApp = new BrowserApp();
