import type { PixelColor } from '../../core/sdk.js';
import type { RenderNode, InlineSpan, RenderedSpan, RenderedLine, WidgetBlueprint, PositionedWidget, LayoutResult } from './types.js';
import {
  CHAR_W, CHAR_H, LINE_H, CONTENT_PAD,
  WIDGET_INPUT_H, WIDGET_BTN_H, WIDGET_CHECK_SZ, WIDGET_SELECT_H,
  CLR_BODY, CLR_LINK, CLR_BOLD, CLR_ITALIC, CLR_CODE, CLR_CODE_BG,
  CLR_DEL, CLR_MARK_TXT, CLR_PRE_TXT, CLR_H1, CLR_H2, CLR_H3,
  CLR_QUOTE_TXT,
} from './constants.js';

// ── Inline word-flow layout ───────────────────────────────────────────────────

export function flowSpans(
  spans:    InlineSpan[],
  xLeft:    number,
  maxX:     number,
  lineH:    number,
  baseClr:  PixelColor,
  opts?: { preBg?: boolean; quoteBg?: boolean; quoteBar?: boolean; bgColor?: number }
): RenderedLine[] {
  var lines:   RenderedLine[] = [];
  var curLine: RenderedSpan[] = [];
  var curX = xLeft;

  function spanColor(sp: InlineSpan): PixelColor {
    if (sp.color !== undefined) return sp.color;
    if (sp.href)   return CLR_LINK;
    if (sp.mark)   return CLR_MARK_TXT;
    if (sp.del)    return CLR_DEL;
    if (sp.code)   return CLR_CODE;
    if (sp.italic) return CLR_ITALIC;
    if (sp.bold)   return CLR_BOLD;
    return baseClr;
  }

  function commitLine(): void {
    var ln: RenderedLine = { y: 0, nodes: curLine, lineH };
    if (opts?.preBg)    ln.preBg    = true;
    if (opts?.quoteBg)  ln.quoteBg  = true;
    if (opts?.quoteBar) ln.quoteBar = true;
    if (opts?.bgColor)  ln.bgColor  = opts.bgColor;
    lines.push(ln);
    curLine = []; curX = xLeft;
  }

  function addWord(word: string, sp: InlineSpan): void {
    var clr  = spanColor(sp);
    var nspc = curX > xLeft;
    var spcW = nspc ? CHAR_W : 0;
    if (curX + spcW + word.length * CHAR_W > maxX && curX > xLeft) {
      commitLine(); nspc = false; spcW = 0;
    }
    while (word.length > 0) {
      var avail = Math.max(1, Math.floor((maxX - curX - spcW) / CHAR_W));
      if (avail <= 0 && curX > xLeft) {
        commitLine(); nspc = false; spcW = 0;
        avail = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W));
      }
      var chunk   = word.slice(0, avail);
      var display = (nspc ? ' ' : '') + chunk;
      var rsp: RenderedSpan = { x: curX, text: display, color: clr };
      if (sp.href)      rsp.href      = sp.href;
      if (sp.bold)      rsp.bold      = true;
      if (sp.del)       rsp.del       = true;
      if (sp.mark)      rsp.mark      = true;
      if (sp.code)      rsp.codeBg    = true;
      if (sp.underline) rsp.underline = true;
      curLine.push(rsp);
      curX  += display.length * CHAR_W;
      word   = word.slice(chunk.length);
      nspc   = false; spcW = 0;
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

// ── Block layout engine ───────────────────────────────────────────────────────

var _widgetCounter = 0;

export function layoutNodes(
  nodes:    RenderNode[],
  bps:      WidgetBlueprint[],
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
        : [{ text: '(untitled)', bold: true, color: undefined as (number | undefined) }];
      commit(flowSpans(hSpans, xLeft, maxX, lhH, hClr));
      blank(level <= 2 ? LINE_H >> 1 : 2);
      continue;
    }

    // <summary> renders like an <h3> but with a ▶ prefix
    if (nd.type === 'summary') {
      if (y > CONTENT_PAD) blank(LINE_H >> 1);
      var prefix: InlineSpan = { text: '\u25B6 ', bold: true };
      var sSpans = [prefix, ...nd.spans.map(s => ({ ...s, bold: true }))];
      commit(flowSpans(sSpans, xLeft, maxX, LINE_H + 4, CLR_H3));
      blank(2); continue;
    }

    if (nd.type === 'li') {
      var depth    = (nd.indent || 0) + 1;
      var bxLeft   = xLeft + (depth - 1) * (CHAR_W * 3);
      var txLeft   = bxLeft + CHAR_W * 3;
      var bullets  = ['\u2022', '\u25E6', '\u25AA'];
      var bullet   = (bullets[Math.min(depth - 1, 2)] || '\u2022') + ' ';
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
      var bqLeft = xLeft + CHAR_W * 4;
      commit(flowSpans(nd.spans, bqLeft, maxX - CHAR_W * 2, LINE_H, CLR_QUOTE_TXT,
                       { quoteBg: true, quoteBar: true }));
      blank(LINE_H >> 1); continue;
    }

    if (nd.type === 'block') {
      var bgColor = nd.bgColor;
      commit(flowSpans(nd.spans, xLeft, maxX, LINE_H, CLR_BODY,
                       bgColor ? { bgColor } : undefined));
      continue;
    }

    // ── Widgets ───────────────────────────────────────────────────────────────
    if (nd.type === 'widget' && nd.widget) {
      var bp = nd.widget;
      if (bp.kind === 'hidden') continue;

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
        case 'button': {
          var btnLabel = bp.value || (bp.kind === 'reset' ? 'Reset' : 'Submit');
          ww = btnLabel.length * CHAR_W + 24;
          wh = WIDGET_BTN_H;
          break;
        }
        case 'checkbox':
        case 'radio':
          ww = WIDGET_CHECK_SZ + CHAR_W * 2;
          wh = WIDGET_CHECK_SZ;
          break;
        case 'select': {
          var longestOpt = 8;
          for (var oi = 0; oi < wOpts.length; oi++) {
            if (wOpts[oi].length > longestOpt) longestOpt = wOpts[oi].length;
          }
          ww = longestOpt * CHAR_W + 24;
          wh = WIDGET_SELECT_H;
          break;
        }
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
          ww = (bp.cols || 20) * CHAR_W + 8;
          wh = WIDGET_INPUT_H;
      }

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
