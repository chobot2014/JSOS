import type { PixelColor } from '../../core/sdk.js';
import type { RenderNode, InlineSpan, RenderedSpan, RenderedLine, WidgetBlueprint, PositionedWidget, LayoutResult } from './types.js';
import {
  CHAR_W, CHAR_H, LINE_H, CONTENT_PAD,
  WIDGET_INPUT_H, WIDGET_BTN_H, WIDGET_CHECK_SZ, WIDGET_SELECT_H,
  CLR_BODY, CLR_LINK, CLR_BOLD, CLR_ITALIC, CLR_CODE, CLR_CODE_BG,
  CLR_DEL, CLR_MARK_TXT, CLR_PRE_TXT, CLR_H1, CLR_H2, CLR_H3,
  CLR_QUOTE_TXT,
} from './constants.js';
import { getLayoutCache, setLayoutCache, layoutFingerprint } from './cache.js';
import { layoutGrid } from './layout-ext.js';

// ── Inline word-flow layout ───────────────────────────────────────────────────

export function flowSpans(
  spans:    InlineSpan[],
  xLeft:    number,
  maxX:     number,
  lineH:    number,
  baseClr:  PixelColor,
  opts?: { preBg?: boolean; quoteBg?: boolean; quoteBar?: boolean; bgColor?: number; bgGradient?: string }
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
    if (opts?.bgGradient) ln.bgGradient = opts.bgGradient;
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
  // ─ Cache check ─
  var fp  = layoutFingerprint(nodes, contentW);
  var hit = getLayoutCache(fp);
  if (hit) return hit;
  var result = _layoutNodesImpl(nodes, bps, contentW);
  setLayoutCache(fp, result);
  return result;
}

function _layoutNodesImpl(
  nodes:    RenderNode[],
  bps:      WidgetBlueprint[],
  contentW: number
): LayoutResult {
  var lines:   RenderedLine[]     = [];
  var widgets: PositionedWidget[] = [];
  var y     = CONTENT_PAD;
  var xLeft = CONTENT_PAD;
  var maxX  = contentW - CONTENT_PAD;

  // Absolutely/fixed-positioned elements collected separately (out-of-flow)
  var oofNodes: RenderNode[] = [];

  function blank(h: number): void {
    lines.push({ y, nodes: [], lineH: h }); y += h;
  }
  function commit(newLines: RenderedLine[]): void {
    for (var k = 0; k < newLines.length; k++) {
      newLines[k].y = y; y += newLines[k].lineH; lines.push(newLines[k]);
    }
  }

  // ── Text transform helper ────────────────────────────────────────────────────
  function applyTextTransform(text: string, transform: string | undefined): string {
    if (!transform || transform === 'none') return text;
    if (transform === 'uppercase')  return text.toUpperCase();
    if (transform === 'lowercase')  return text.toLowerCase();
    if (transform === 'capitalize') return text.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    return text;
  }

  // ── Apply text transform to span array ──────────────────────────────────────
  function transformSpans(spans: InlineSpan[], tt: string | undefined): InlineSpan[] {
    if (!tt || tt === 'none') return spans;
    return spans.map(function(sp) {
      return sp.text ? { ...sp, text: applyTextTransform(sp.text, tt) } : sp;
    });
  }

  // ── Resolve line height for a node ──────────────────────────────────────────
  function nodeLineH(nd: RenderNode): number {
    return nd.lineHeight ? Math.max(LINE_H, Math.round(nd.lineHeight)) : LINE_H;
  }

  // ── Margin collapsing: last bottom margin collapses with next top margin ─────
  var lastBottomMargin = 0;
  function collapseMargin(newTop: number): number {
    // Collapsed margin = max of the two; only positive margins collapse
    var collapsed = Math.max(lastBottomMargin, newTop);
    lastBottomMargin = 0;
    return collapsed;
  }

  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];

    // ── Out-of-flow: absolute / fixed positioned elements ─────────────────────
    if (nd.position === 'absolute' || nd.position === 'fixed') {
      oofNodes.push(nd); continue;
    }

    if (nd.type === 'p-break') {
      lastBottomMargin = Math.max(lastBottomMargin, LINE_H >> 1);
      continue;
    }

    if (nd.type === 'hr') {
      lines.push({ y, nodes: [], lineH: 3, hrLine: true }); y += 8;
      lastBottomMargin = 0; continue;
    }

    if (nd.type === 'pre') {
      var preText  = nd.spans[0]?.text ?? '';
      var rawLines = preText.split('\n');
      var maxPreCh = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W));
      for (var pli = 0; pli < rawLines.length; pli++) {
        var preDisp = rawLines[pli].length > maxPreCh
          ? rawLines[pli].slice(0, maxPreCh - 1) + '\u00BB'
          : rawLines[pli];
        lines.push({ y, nodes: [{ x: xLeft, text: preDisp || ' ', color: CLR_PRE_TXT }],
                     lineH: LINE_H, preBg: true });
        y += LINE_H;
      }
      lastBottomMargin = 0; continue;
    }

    if (/^h[1-6]$/.test(nd.type)) {
      var level  = parseInt(nd.type[1]!, 10);
      var hClr   = level === 1 ? CLR_H1 : level === 2 ? CLR_H2 : CLR_H3;
      var hScale = level === 1 ? 3 : level <= 3 ? 2 : 1;
      var lhH    = 8 * hScale + 4;
      var hPre   = collapseMargin(level <= 2 ? LINE_H * hScale : LINE_H >> 1);
      if (y > CONTENT_PAD && hPre > 0) blank(hPre);
      var hSpans = (nd.spans.length > 0 ? nd.spans : [{ text: nd.type.toUpperCase(), color: undefined as (number | undefined) }])
        .map(function(s) { return { ...s, text: applyTextTransform(s.text, nd.textTransform), bold: true, fontScale: hScale }; });
      commit(flowSpans(hSpans, xLeft, maxX, lhH, hClr));
      lastBottomMargin = level <= 2 ? LINE_H >> 1 : 2;
      continue;
    }

    // <summary> renders like an <h3> but with a ▶ prefix
    if (nd.type === 'summary') {
      var sTop = collapseMargin(LINE_H >> 1);
      if (y > CONTENT_PAD && sTop > 0) blank(sTop);
      var prefix: InlineSpan = { text: '\u25B6 ', bold: true };
      var sSpans = [prefix, ...nd.spans.map(function(s) { return { ...s, text: applyTextTransform(s.text, nd.textTransform), bold: true }; })];
      commit(flowSpans(sSpans, xLeft, maxX, LINE_H + 4, CLR_H3));
      lastBottomMargin = 2; continue;
    }

    if (nd.type === 'li') {
      var depth    = (nd.indent || 0) + 1;
      var bxLeft   = xLeft + (depth - 1) * (CHAR_W * 3);
      var txLeft   = bxLeft + CHAR_W * 3;
      // List style type from CSS
      var lstType  = (nd as RenderNode & { listStyleType?: string }).listStyleType;
      var bullets  = ['\u2022', '\u25E6', '\u25AA'];
      var bullet   = lstType === 'decimal' ? (String(i) + '. ') :
                     lstType === 'none' ? '' :
                     (bullets[Math.min(depth - 1, 2)] || '\u2022') + ' ';
      var liSpans  = transformSpans(nd.spans, nd.textTransform);
      var lineHere = nodeLineH(nd);
      if (bullet) {
        var bulletR: RenderedSpan = { x: bxLeft, text: bullet, color: CLR_BODY };
        if (liSpans.length === 0) {
          lines.push({ y, nodes: [bulletR], lineH: lineHere }); y += lineHere;
        } else {
          var itemLines = flowSpans(liSpans, txLeft, maxX, lineHere, CLR_BODY);
          if (itemLines.length > 0) itemLines[0].nodes.unshift(bulletR);
          else itemLines = [{ y: 0, nodes: [bulletR], lineH: lineHere }];
          commit(itemLines);
        }
      } else if (liSpans.length > 0) {
        commit(flowSpans(liSpans, txLeft, maxX, lineHere, CLR_BODY));
      }
      lastBottomMargin = 0; continue;
    }

    if (nd.type === 'blockquote') {
      var bqLeft    = xLeft + CHAR_W * 4;
      var bqSpans   = transformSpans(nd.spans, nd.textTransform);
      var bqTop     = collapseMargin(nd.marginTop || 0);
      if (bqTop > 0) blank(bqTop);
      commit(flowSpans(bqSpans, bqLeft, maxX - CHAR_W * 2, nodeLineH(nd), CLR_QUOTE_TXT,
                       { quoteBg: true, quoteBar: true }));
      lastBottomMargin = nd.marginBottom || (LINE_H >> 1);
      continue;
    }

    // ── CSS Grid layout (items 404-405) ──────────────────────────────────────
    if (nd.type === 'grid' && nd.children) {
      var gGridY = y;
      var gLines = layoutGrid(
        nd, maxX, CHAR_W, LINE_H,
        function(ch: RenderNode[], cw: number) { return _layoutNodesImpl(ch, [], cw); }
      );
      var gMaxY = gGridY;
      for (var gli = 0; gli < gLines.length; gli++) {
        var gln = gLines[gli];
        lines.push({ y: gGridY + gln.y, nodes: gln.nodes, lineH: gln.lineH,
                     bgColor: gln.bgColor, bgGradient: gln.bgGradient, preBg: gln.preBg });
        var gLineEnd = gGridY + gln.y + (gln.lineH || LINE_H);
        if (gLineEnd > gMaxY) gMaxY = gLineEnd;
      }
      y = gMaxY + (nd.marginBottom || 0);
      lastBottomMargin = nd.marginBottom || 0;
      continue;
    }

    if (nd.type === 'flex-row' && nd.children) {
      // ── Flex-row: render children side by side ─────────────────────────────
      var fChildren = nd.children;
      var gap       = nd.gap ?? 8;
      var fRowY0    = y;
      var maxChildH = 0;
      var fxLeft    = xLeft + (nd.paddingLeft || 0);
      var fxAvail   = (nd.boxWidth ? Math.min(maxX, xLeft + nd.boxWidth) : maxX) - fxLeft - (nd.paddingRight || 0);
      // Item 403: sort by 'order' property (stable sort, default order=0)
      var fSorted = fChildren.slice().sort(function(a, b) {
        return (a.order ?? 0) - (b.order ?? 0);
      });
      // Compute base sizes: explicit boxWidth if set, else a «1 grow unit» placeholder
      var fxUsedGap = gap * Math.max(0, fSorted.length - 1);
      var fxFreeInit = fxAvail - fxUsedGap;
      // Two-pass flex algorithm (simplified): compute hypothetical main sizes
      var fBaseW: number[] = [];
      var fHypoW: number[] = [];
      for (var fi = 0; fi < fSorted.length; fi++) {
        var fBase = fSorted[fi].boxWidth ?? 0; // 0 = no explicit width
        fBaseW.push(fBase);
      }
      // Total explicit widths + remaining free space distributed via grow/shrink
      var fFixedTotal = 0;
      var flexibleCount = 0;
      for (var fi2 = 0; fi2 < fSorted.length; fi2++) {
        if (fBaseW[fi2] > 0) fFixedTotal += fBaseW[fi2];
        else flexibleCount++;
      }
      var fFlexPool = fxFreeInit - fFixedTotal;
      var fFreeSpace = fFlexPool;
      if (flexibleCount > 0) fFreeSpace = fFlexPool / flexibleCount; // even base for flex items
      // Assign hypothetical widths
      for (var fi3 = 0; fi3 < fSorted.length; fi3++) {
        fHypoW.push(fBaseW[fi3] > 0 ? fBaseW[fi3] : Math.max(0, fFreeSpace));
      }
      // Compute free space after hypothetical sizes
      var fHypoTotal = fHypoW.reduce(function(a, b) { return a + b; }, 0);
      var fFree = fxFreeInit - fHypoTotal;
      // Item 402: Apply flex-grow (positive free space) or flex-shrink (negative)
      var fFinalW: number[] = [];
      if (fFree >= 0) {
        // Positive free space → distribute via flex-grow
        var totalGrow = 0;
        for (var fi4 = 0; fi4 < fSorted.length; fi4++) totalGrow += (fSorted[fi4].flexGrow ?? 0);
        for (var fi5 = 0; fi5 < fSorted.length; fi5++) {
          var grow = fSorted[fi5].flexGrow ?? 0;
          var extra = totalGrow > 0 ? fFree * grow / totalGrow : 0;
          fFinalW.push(Math.max(0, Math.floor(fHypoW[fi5] + extra)));
        }
      } else {
        // Negative free space → shrink via flex-shrink
        var totalShrinkFactor = 0;
        for (var fi6 = 0; fi6 < fSorted.length; fi6++) {
          totalShrinkFactor += (fSorted[fi6].flexShrink ?? 1) * fHypoW[fi6];
        }
        for (var fi7 = 0; fi7 < fSorted.length; fi7++) {
          var shrinkFactor = (fSorted[fi7].flexShrink ?? 1) * fHypoW[fi7];
          var reduction = totalShrinkFactor > 0 ? (-fFree) * shrinkFactor / totalShrinkFactor : 0;
          fFinalW.push(Math.max(0, Math.floor(fHypoW[fi7] - reduction)));
        }
      }
      var fCurX = fxLeft;
      var fChildLines: { x: number; cw: number; cl: RenderedLine[]; alignSelf?: string }[] = [];
      var containerAlignItems = nd.alignItems || 'stretch';
      // Collect each child's rendered lines
      for (var fci = 0; fci < fSorted.length; fci++) {
        var fc    = fSorted[fci];
        var cw    = fFinalW[fci];
        var cLines = flowSpans(transformSpans(fc.spans, fc.textTransform), 0, cw, nodeLineH(fc), CLR_BODY,
                               (fc.bgColor !== undefined || fc.bgGradient) ? { bgColor: fc.bgColor, bgGradient: fc.bgGradient } : undefined);
        // Item 403: record per-item alignSelf for cross-axis placement
        var fcAlign = fc.alignSelf || containerAlignItems;
        fChildLines.push({ x: fCurX, cw, cl: cLines, alignSelf: fcAlign });
        var childH = cLines.length * nodeLineH(fc);
        if (childH > maxChildH) maxChildH = childH;
        fCurX += cw + gap;
      }
      // Stamp child lines at their x-offset, applying alignSelf vertical placement
      for (var fci2 = 0; fci2 < fChildLines.length; fci2++) {
        var fc2   = fChildLines[fci2];
        var fcH2  = fc2.cl.length > 0 ? fc2.cl.length * (fc2.cl[0]!.lineH || LINE_H) : 0;
        // Compute cross-axis (vertical) offset based on alignSelf / alignItems
        var crossOffset = 0;
        var fcAlignMode = fc2.alignSelf || 'stretch';
        if (fcAlignMode === 'center') {
          crossOffset = Math.floor((maxChildH - fcH2) / 2);
        } else if (fcAlignMode === 'flex-end' || fcAlignMode === 'end') {
          crossOffset = maxChildH - fcH2;
        } else if (fcAlignMode === 'baseline') {
          crossOffset = 0; // approximate: top of first line
        }
        // 'flex-start', 'start', 'stretch', default → crossOffset = 0
        for (var cli2 = 0; cli2 < fc2.cl.length; cli2++) {
          var cl2 = fc2.cl[cli2]!;
          var shifted = cl2.nodes.map(function(n) { return { ...n, x: n.x + fc2.x }; });
          lines.push({ y: fRowY0 + crossOffset + cli2 * (cl2.lineH || LINE_H), nodes: shifted,
                       lineH: cl2.lineH, bgColor: cl2.bgColor, bgGradient: cl2.bgGradient, preBg: cl2.preBg });
        }
      }
      y = fRowY0 + maxChildH;
      lastBottomMargin = nd.marginBottom || 0;
      continue;
    }

    if (nd.type === 'block' || nd.type === 'aside') {
      // ── Margin collapsing ────────────────────────────────────────────────────
      var preMarginRaw  = nd.marginTop  || 0;
      var postMarginRaw = nd.marginBottom || 0;
      var preM  = collapseMargin(preMarginRaw);
      if (preM  > 0) blank(preM);

      var bgColor   = nd.bgColor;
      var bgGradient = nd.bgGradient;
      var blkLeft   = xLeft + (nd.paddingLeft ? Math.round(nd.paddingLeft / CHAR_W) * CHAR_W : 0);
      var blkRight  = nd.paddingRight ? Math.round(nd.paddingRight / CHAR_W) * CHAR_W : 0;
      var blkMaxX   = (nd.boxWidth ? Math.min(maxX, xLeft + nd.boxWidth) : maxX) - blkRight;
      var lh        = nodeLineH(nd);
      var ndSpans   = transformSpans(nd.spans, nd.textTransform);

      if (nd.float === 'right') {
        // Float right: render as a visually boxed right-side block
        var asideW   = nd.boxWidth ? Math.min(nd.boxWidth, maxX - xLeft) : Math.min(maxX - xLeft, 200);
        var asideX   = maxX - asideW;
        var borderY0 = y;
        commit(flowSpans(ndSpans, asideX + 4, maxX - 4, lh, CLR_BODY,
                         (bgColor !== undefined || bgGradient) ? { bgColor, bgGradient } : undefined));
        lines.push({ y: borderY0, nodes: [], lineH: 0 });
        blank(2);
      } else if (nd.float === 'left') {
        // Float left: render as an indented aside
        var fLeftW = nd.boxWidth ? Math.min(nd.boxWidth, (maxX - xLeft) >> 1) : Math.min(160, (maxX - xLeft) >> 1);
        commit(flowSpans(ndSpans, xLeft + 4, xLeft + fLeftW - 4, lh, CLR_BODY,
                         (bgColor !== undefined || bgGradient) ? { bgColor, bgGradient } : undefined));
        blank(2);
      } else {
        // Normal block flow
        var flowOpts = (bgColor !== undefined || bgGradient) ? { bgColor, bgGradient } : undefined;
        commit(flowSpans(ndSpans, blkLeft, blkMaxX, lh, CLR_BODY, flowOpts));
      }
      lastBottomMargin = postMarginRaw;
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

  // ── Out-of-flow (position:absolute/fixed) node rendering ─────────────────
  for (var oi = 0; oi < oofNodes.length; oi++) {
    var oof      = oofNodes[oi];
    var oofX     = oof.posLeft !== undefined ? (xLeft + oof.posLeft) : xLeft;
    var oofY     = oof.posTop  !== undefined ? oof.posTop : 0;
    var oofMaxX  = oof.boxWidth ? Math.min(oofX + oof.boxWidth, maxX) : maxX;
    var oofLh    = nodeLineH(oof);
    var oofSpans = transformSpans(oof.spans, oof.textTransform);
    var oofLines = flowSpans(oofSpans, oofX, oofMaxX, oofLh, CLR_BODY,
                             oof.bgColor !== undefined ? { bgColor: oof.bgColor } : undefined);
    for (var ol = 0; ol < oofLines.length; ol++) {
      var oofLine = oofLines[ol];
      lines.push({ y: oofY, nodes: oofLine.nodes, lineH: oofLine.lineH });
      oofY += oofLine.lineH;
    }
  }

  return { lines, widgets };
}
