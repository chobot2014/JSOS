import type {
  HtmlToken, ParseResult, RenderNode, InlineSpan, BlockType,
  WidgetBlueprint, WidgetKind, FormState, CSSProps,
} from './types.js';
import { parseInlineStyle } from './css.js';

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
      var dec = raw
        .replace(/&amp;/g,    '&')   .replace(/&lt;/g,  '<')
        .replace(/&gt;/g,     '>')   .replace(/&quot;/g, '"')
        .replace(/&#39;/g,    "'")   .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g,   ' ')   .replace(/&mdash;/g, '\u2014')
        .replace(/&ndash;/g,  '\u2013').replace(/&hellip;/g, '\u2026')
        .replace(/&laquo;/g,  '\u00AB').replace(/&raquo;/g, '\u00BB')
        .replace(/&copy;/g,   '\u00A9').replace(/&reg;/g, '\u00AE')
        .replace(/&trade;/g,  '\u2122').replace(/&ldquo;/g, '\u201C')
        .replace(/&rdquo;/g,  '\u201D').replace(/&lsquo;/g, '\u2018')
        .replace(/&rsquo;/g,  '\u2019').replace(/&bull;/g,  '\u2022')
        .replace(/&middot;/g, '\u00B7').replace(/&times;/g, '\u00D7')
        .replace(/&divide;/g, '\u00F7').replace(/&plusmn;/g, '\u00B1')
        .replace(/&deg;/g,    '\u00B0').replace(/&micro;/g, '\u00B5')
        .replace(/&para;/g,   '\u00B6').replace(/&sect;/g,  '\u00A7')
        .replace(/&dagger;/g, '\u2020').replace(/&Dagger;/g, '\u2021')
        .replace(/&loz;/g,    '\u25CA').replace(/&spades;/g, '\u2660')
        .replace(/&clubs;/g,  '\u2663').replace(/&hearts;/g, '\u2665')
        .replace(/&diams;/g,  '\u2666')
        .replace(/&#(\d+);/g,        (_m: string, nc: string) => String.fromCharCode(parseInt(nc, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_m: string, nc: string) => String.fromCharCode(parseInt(nc, 16)));
      tokens.push({ kind: 'text', tag: '', text: dec, attrs: new Map() });
    }
  }
  return tokens;
}

// ── HTML parser ───────────────────────────────────────────────────────────────

export function parseHTML(html: string): ParseResult {
  var tokens   = tokenise(html);
  var nodes:   RenderNode[]      = [];
  var title    = '';
  var forms:   FormState[]       = [];
  var widgets: WidgetBlueprint[] = [];
  var baseURL  = '';

  var inTitle   = false;
  var inPre     = false;
  var inHead    = false;
  var inScript  = false;
  var inStyle   = false;
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
    if (p.color     !== undefined) curCSS.color     = p.color;
    if (p.bgColor   !== undefined) curCSS.bgColor   = p.bgColor;
    if (p.bold)      curCSS.bold      = true;
    if (p.italic)    curCSS.italic    = true;
    if (p.underline) curCSS.underline = true;
    if (p.strike)    curCSS.strike    = true;
    if (p.align)     curCSS.align     = p.align;
    if (p.hidden)  { curCSS.hidden    = true; skipDepth++; }
  }
  function popCSS(): void {
    if (cssStack.length > 0) {
      var prev = { ...curCSS };
      curCSS = cssStack.pop()!;
      if (prev.hidden && !curCSS.hidden) skipDepth = Math.max(0, skipDepth - 1);
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
    nodes.push({ type: 'block', spans: merged });
    inlineSpans = [];
  }

  function pushSpan(text: string): void {
    if (!text) return;
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

  // Apply style attr and push to CSS stack; returns whether style was present
  function applyStyle(attrs: Map<string, string>): boolean {
    var s = attrs.get('style');
    if (!s) { cssStack.push({ ...curCSS }); return false; }  // still push for balance
    pushCSS(parseInlineStyle(s));
    return true;
  }

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];

    if (inScript) { if (tok.kind === 'close' && tok.tag === 'script') inScript = false; continue; }
    if (inStyle)  { if (tok.kind === 'close' && tok.tag === 'style')  inStyle  = false; continue; }

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
        var hs = tok.attrs.get('style');
        if (hs) pushCSS(parseInlineStyle(hs)); else cssStack.push({ ...curCSS });
        continue;
      }

      switch (tok.tag) {
        // ── Document structure ──────────────────────────────────────────────
        case 'head':   inHead   = true;  break;
        case 'body':   inHead   = false; break;
        case 'html':   break;
        case 'title':  inTitle  = true;  break;
        case 'script': inScript = true;  break;
        case 'style':  inStyle  = true;  break;

        case 'base': {
          var bHref = tok.attrs.get('href');
          if (bHref) baseURL = bHref;
          break;
        }
        case 'meta': break;  // ignored
        case 'link': break;  // ignored

        // ── Inline formatting ───────────────────────────────────────────────
        case 'strong': case 'b':
          applyStyle(tok.attrs); bold++;    break;
        case 'em': case 'i':
          applyStyle(tok.attrs); italic++;  break;
        case 'code': case 'tt': case 'kbd': case 'samp':
          applyStyle(tok.attrs); codeInl++; break;
        case 'del': case 's':
          applyStyle(tok.attrs); del++;     break;
        case 'mark':
          applyStyle(tok.attrs); mark++;    break;
        case 'u':
          applyStyle(tok.attrs); underline++; break;

        case 'sup':  applyStyle(tok.attrs); pushSpan('^');  break;
        case 'sub':  applyStyle(tok.attrs); break;
        case 'abbr': applyStyle(tok.attrs); break;
        case 'bdi':  applyStyle(tok.attrs); break;
        case 'bdo':  applyStyle(tok.attrs); break;
        case 'cite': applyStyle(tok.attrs); italic++; break;
        case 'var':  applyStyle(tok.attrs); italic++; break;
        case 'q':    applyStyle(tok.attrs); pushSpan('\u201C'); break;

        case 'span': applyStyle(tok.attrs); break;
        case 'font': applyStyle(tok.attrs); break;

        // ── Links ───────────────────────────────────────────────────────────
        case 'a': {
          var aStyle = tok.attrs.get('style');
          if (aStyle) pushCSS(parseInlineStyle(aStyle)); else cssStack.push({ ...curCSS });
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
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          var hAlign = tok.attrs.get('style') ? parseInlineStyle(tok.attrs.get('style')!).align : undefined;
          openBlock = { type: tok.tag as BlockType, spans: [], textAlign: hAlign };
          applyStyle(tok.attrs);
          break;
        }

        // ── Preformatted ────────────────────────────────────────────────────
        case 'pre':  applyStyle(tok.attrs); flushInline(); inPre = true; break;

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

        // ── Lists ────────────────────────────────────────────────────────────
        case 'ul': case 'ol':
          applyStyle(tok.attrs); flushInline(); listDepth++; break;
        case 'li': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          var liAlign = tok.attrs.get('style') ? parseInlineStyle(tok.attrs.get('style')!).align : undefined;
          applyStyle(tok.attrs);
          openBlock = { type: 'li', spans: [], indent: Math.max(0, listDepth - 1), textAlign: liAlign };
          break;
        }

        // ── Blockquote ───────────────────────────────────────────────────────
        case 'blockquote': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.attrs);
          openBlock = { type: 'blockquote', spans: [], indent: 1 };
          break;
        }

        // ── <details> / <summary> ────────────────────────────────────────────
        // Details are always "open" (no JS toggle). Summary becomes a heading.
        case 'details':
          applyStyle(tok.attrs); flushInline();
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'summary': {
          flushInline();
          if (openBlock) { nodes.push(openBlock); openBlock = null; }
          applyStyle(tok.attrs);
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
          // Inline images with data: src are valid — keep the src as-is
          pushWidget({
            kind: 'img', name: '', value: iAlt,
            checked: false, disabled: false, readonly: false, formIdx: -1,
            imgSrc: iSrc, imgAlt: iAlt, imgNatW: iNatW, imgNatH: iNatH,
          });
          break;
        }

        // ── Table ─────────────────────────────────────────────────────────────
        case 'table':
          applyStyle(tok.attrs); flushInline();
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'thead': case 'tbody': case 'tfoot': break;
        case 'tr':
          flushInline();
          nodes.push({ type: 'p-break', spans: [] }); break;
        case 'th':
          applyStyle(tok.attrs); bold++; pushSpan('| '); break;
        case 'td':
          applyStyle(tok.attrs); pushSpan('| '); break;
        case 'colgroup': case 'col': break;

        // ── Default block ─────────────────────────────────────────────────────
        default: {
          if (BLOCK_TAGS.has(tok.tag)) {
            var bStyle = tok.attrs.get('style');
            if (bStyle) pushCSS(parseInlineStyle(bStyle)); else cssStack.push({ ...curCSS });
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

        case 'th': bold = Math.max(0, bold - 1); pushSpan('  '); popCSS(); break;
        case 'td': pushSpan('  '); popCSS(); break;
        case 'table':
          pushSpan('|'); flushInline();
          nodes.push({ type: 'p-break', spans: [] });
          popCSS(); break;
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
      if (!txt.trim()) continue;
      pushSpan(txt);
    }
  }

  flushInline();
  return { nodes, title, forms, widgets, baseURL };
}
