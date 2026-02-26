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
    var cw   = CHAR_W * (sp.fontScale || 1);  // scaled char width
    var clr  = spanColor(sp);
    var nspc = curX > xLeft;
    var spcW = nspc ? cw : 0;
    if (curX + spcW + word.length * cw > maxX && curX > xLeft) {
      commitLine(); nspc = false; spcW = 0;
    }
    while (word.length > 0) {
      var avail = Math.max(1, Math.floor((maxX - curX - spcW) / cw));
      if (avail <= 0 && curX > xLeft) {
        commitLine(); nspc = false; spcW = 0;
        avail = Math.max(1, Math.floor((maxX - xLeft) / cw));
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
      if (sp.fontScale) rsp.fontScale = sp.fontScale;
      curLine.push(rsp);
      curX  += display.length * cw;
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
      var preDisp  = preText.length > maxPreCh
        ? preText.slice(0, maxPreCh - 1) + '\u00BB'   // » truncation marker
        : preText;
      lines.push({ y, nodes: [{ x: xLeft, text: preDisp, color: CLR_PRE_TXT }],
                   lineH: LINE_H, preBg: true });
      y += LINE_H; continue;
    }

    if (/^h[1-6]$/.test(nd.type)) {
      var level  = parseInt(nd.type[1]!, 10);
      var hClr   = level === 1 ? CLR_H1 : level === 2 ? CLR_H2 : CLR_H3;
      var hScale = level === 1 ? 3 : level <= 3 ? 2 : 1;
      var lhH    = 8 * hScale + 4;
      if (y > CONTENT_PAD) blank(level <= 2 ? LINE_H * hScale : LINE_H >> 1);
      var hSpans = nd.spans.length > 0
        ? nd.spans.map(s => ({ ...s, bold: true, fontScale: hScale }))
        : [{ text: '(untitled)', bold: true, fontScale: hScale, color: undefined as (number | undefined) }];
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

    if (nd.type === 'block' || nd.type === 'aside') {
      // Pre-margin
      var preMargin  = nd.marginTop  ? Math.max(1, Math.round(nd.marginTop  / LINE_H)) * LINE_H >> 1 : 0;
      var postMargin = nd.marginBottom ? Math.max(1, Math.round(nd.marginBottom / LINE_H)) * LINE_H >> 1 : 0;
      if (preMargin  > 0) blank(preMargin);

      var bgColor   = nd.bgColor;
      var blkLeft   = xLeft + (nd.paddingLeft ? Math.round(nd.paddingLeft / CHAR_W) * CHAR_W : 0);
      var blkMaxX   = maxX;

      if (nd.float === 'right') {
        // Float right: render as a visually boxed right-side block
        var asideW   = Math.min(maxX - xLeft, 200);  // cap aside to 200px
        var asideX   = maxX - asideW;
        var borderY0 = y;
        commit(flowSpans(nd.spans, asideX + 4, maxX - 4, LINE_H, CLR_BODY,
                         bgColor ? { bgColor } : undefined));
        // Draw border around the aside block
        lines.push({ y: borderY0, nodes: [], lineH: 0 }); // spacer marker
        blank(2);
      } else if (nd.float === 'left') {
        // Float left: render as an indented aside
        var fLeftW = Math.min(160, (maxX - xLeft) >> 1);
        commit(flowSpans(nd.spans, xLeft + 4, xLeft + fLeftW - 4, LINE_H, CLR_BODY,
                         bgColor ? { bgColor } : undefined));
        blank(2);
      } else {
        commit(flowSpans(nd.spans, blkLeft, blkMaxX, LINE_H, CLR_BODY,
                         bgColor ? { bgColor } : undefined));
      }
      if (postMargin > 0) blank(postMargin);
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
