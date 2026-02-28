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
  opts?: { preBg?: boolean; quoteBg?: boolean; quoteBar?: boolean; bgColor?: number; bgGradient?: string;
           bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean }
): RenderedLine[] {
  var lines:   RenderedLine[] = [];
  var curLine: RenderedSpan[] = [];
  var curX = xLeft;
  // word-break: break-all splits at every character boundary (item 421)
  var _breakAll = opts?.wordBreak === 'break-all';

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
    if (opts?.preBg)      ln.preBg      = true;
    if (opts?.quoteBg)    ln.quoteBg    = true;
    if (opts?.quoteBar)   ln.quoteBar   = true;
    if (opts?.bgColor)    ln.bgColor    = opts.bgColor;
    if (opts?.bgGradient) ln.bgGradient = opts.bgGradient;
    if (opts?.bgImageUrl) ln.bgImageUrl = opts.bgImageUrl;
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
      if (sp.download)  rsp.download  = sp.download;  // item 636
      if (sp.bold)      rsp.bold      = true;
      if (sp.italic)    rsp.italic    = true;
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
      if (_breakAll) {
        // word-break: break-all — treat each char as its own unit (item 421)
        var chars = part.split('');
        for (var ci = 0; ci < chars.length; ci++) {
          if (chars[ci] === ' ') {
            if (curX > xLeft) curX += CHAR_W * (sp.fontScale || 1);
          } else {
            addWord(chars[ci]!, sp);
          }
        }
      } else {
        var words = part.split(' ');
        for (var wi = 0; wi < words.length; wi++) {
          var word = words[wi];
          if (!word) { if (curX > xLeft) curX += CHAR_W; continue; }
          addWord(word, sp);
        }
      }
    }
  }
  if (curLine.length > 0) commitLine();

  // text-overflow: ellipsis (item 465) — keep only first line, append "..."
  if (opts?.ellipsis && lines.length > 1) {
    var firstLine = lines[0]!;
    var maxChars  = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W));
    // Truncate all spans on the first line to fit + "..."
    var totalChars = 0;
    var clippedNodes: RenderedSpan[] = [];
    for (var ei = 0; ei < firstLine.nodes.length; ei++) {
      var en = firstLine.nodes[ei]!;
      var remaining = maxChars - 3 - totalChars; // reserve 3 for "..."
      if (remaining <= 0) break;
      var trimmed = en.text.slice(0, remaining);
      clippedNodes.push({ ...en, text: trimmed });
      totalChars += trimmed.length;
    }
    // Append "..." spanning at current position
    if (clippedNodes.length > 0) {
      var lastNode = clippedNodes[clippedNodes.length - 1]!;
      var dotX     = lastNode.x + lastNode.text.length * CHAR_W;
      clippedNodes.push({ x: dotX, text: '...', color: lastNode.color });
    }
    lines = [{ ...firstLine, nodes: clippedNodes }];
  }

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

      // Build flow opts including bgImage (item 386) and word-break (item 421)
      function makeFlowOpts(): typeof undefined | { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean } {
        var o: { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean } = {};
        var any = false;
        if (bgColor !== undefined)  { o.bgColor = bgColor; any = true; }
        if (bgGradient)             { o.bgGradient = bgGradient; any = true; }
        if (nd.bgImage)             { o.bgImageUrl = nd.bgImage; any = true; }
        if (nd.wordBreak)           { o.wordBreak = nd.wordBreak; any = true; }
        if (nd.overflowWrap)        { o.overflowWrap = nd.overflowWrap; any = true; }
        if (nd.textOverflow === 'ellipsis') { o.ellipsis = true; any = true; }  // item 465
        return any ? o : undefined;
      }

      if (nd.float === 'right') {
        // Float right: render as a visually boxed right-side block
        var asideW   = nd.boxWidth ? Math.min(nd.boxWidth, maxX - xLeft) : Math.min(maxX - xLeft, 200);
        var asideX   = maxX - asideW;
        var borderY0 = y;
        commit(flowSpans(ndSpans, asideX + 4, maxX - 4, lh, CLR_BODY, makeFlowOpts()));
        lines.push({ y: borderY0, nodes: [], lineH: 0 });
        blank(2);
      } else if (nd.float === 'left') {
        // Float left: render as an indented aside
        var fLeftW = nd.boxWidth ? Math.min(nd.boxWidth, (maxX - xLeft) >> 1) : Math.min(160, (maxX - xLeft) >> 1);
        commit(flowSpans(ndSpans, xLeft + 4, xLeft + fLeftW - 4, lh, CLR_BODY, makeFlowOpts()));
        blank(2);
      } else {
        // Normal block flow
        commit(flowSpans(ndSpans, blkLeft, blkMaxX, lh, CLR_BODY, makeFlowOpts()));
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
        imgData:    bp.preloadedImage?.data ?? null,
        imgLoaded:  bp.preloadedImage != null,
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

// ── Layout optimization classes ──────────────────────────────────────────────

/** [Item 893] CSS `contain: layout` — isolate a subtree so its layout cannot
 *  affect ancestors.  A contained box is treated as a fresh independent block. */
export class LayoutContainment {
  private _contained: Set<string> = new Set();

  /** Mark a node (by its DOM id) as layout-contained. */
  contain(id: string): void { this._contained.add(id); }

  /** Remove layout containment for a node. */
  release(id: string): void { this._contained.delete(id); }

  /** Return true when `id` is in a contained subtree — layout engine should
   *  not propagate size/position changes past this boundary. */
  isContained(id: string): boolean { return this._contained.has(id); }

  /** Wrap a layout function so it cannot escape the containment boundary. */
  runContained<T>(id: string, fn: () => T): T {
    this.contain(id);
    try { return fn(); }
    finally { this.release(id); }
  }
}

/** [Item 895] Cache computed flex/grid track sizes so identical containers
 *  skip the full measurement pass on subsequent frames. */
export class FlexGridTrackCache {
  private _cache: Map<string, number[]> = new Map();

  /** Compute a stable key from column/row count and available space. */
  private _key(nodeId: string, trackCount: number, availPx: number): string {
    return `${nodeId}:${trackCount}:${availPx}`;
  }

  /** Return cached track sizes, or null on cache miss. */
  get(nodeId: string, trackCount: number, availPx: number): number[] | null {
    return this._cache.get(this._key(nodeId, trackCount, availPx)) ?? null;
  }

  /** Store computed track sizes. */
  set(nodeId: string, trackCount: number, availPx: number, tracks: number[]): void {
    this._cache.set(this._key(nodeId, trackCount, availPx), tracks.slice());
  }

  /** Invalidate all entries for a specific node (e.g. on style change). */
  invalidate(nodeId: string): void {
    for (var k of Array.from(this._cache.keys())) {
      if (k.startsWith(nodeId + ':')) this._cache.delete(k);
    }
  }

  clear(): void { this._cache.clear(); }
}

/** [Item 898] Cache the containing-block rectangle for absolutely/fixed
 *  positioned elements to avoid re-walking ancestors every layout pass. */
export class ContainingBlockCache {
  private _cache: Map<string, { x: number; y: number; w: number; h: number }> = new Map();

  get(nodeId: string) { return this._cache.get(nodeId) ?? null; }

  set(nodeId: string, rect: { x: number; y: number; w: number; h: number }): void {
    this._cache.set(nodeId, rect);
  }

  /** Invalidate when an ancestor's geometry changes. */
  invalidate(nodeId: string): void { this._cache.delete(nodeId); }

  invalidateAll(): void { this._cache.clear(); }
}

/** [Item 901] Enforce a per-frame layout budget (default 4 ms).
 *  When the budget is exceeded the layout engine can defer expensive subtrees. */
export class LayoutBudget {
  private _budgetMs: number;
  private _start: number = 0;

  constructor(budgetMs: number = 4) {
    this._budgetMs = budgetMs;
  }

  begin(): void { this._start = Date.now(); }

  /** Returns true when the budget has NOT been exceeded. */
  ok(): boolean { return (Date.now() - this._start) < this._budgetMs; }

  /** Remaining milliseconds (clamped to 0). */
  remaining(): number { return Math.max(0, this._budgetMs - (Date.now() - this._start)); }

  /** Reset budget with an optional new limit. */
  reset(budgetMs?: number): void {
    if (budgetMs !== undefined) this._budgetMs = budgetMs;
    this._start = Date.now();
  }
}

/** [Item 903] Fast path for CSS grid auto-placement in dense packing mode.
 *  Skips full backtracking search when all items have span=1. */
export class GridAutoPlacementFastPath {
  /** Place `count` implicit items into `cols` columns (dense order).
   *  Returns array of {col, row} positions (0-indexed). */
  static place(cols: number, count: number): Array<{ col: number; row: number }> {
    var result: Array<{ col: number; row: number }> = [];
    for (var i = 0; i < count; i++) {
      result.push({ col: i % cols, row: Math.floor(i / cols) });
    }
    return result;
  }

  /** Determine whether the fast path is applicable for a grid spec. */
  static applicable(spanMax: number, autoFlow: string): boolean {
    return spanMax <= 1 && autoFlow === 'dense';
  }
}

/** [Item 904] Schedule flex/grid subtree layouts as microtasks so multiple
 *  independent subtrees can be prepared concurrently (cooperative, not truly
 *  parallel — JS is single-threaded, but we yield between subtrees). */
export class ParallelLayoutScheduler {
  private _queue: Array<() => void> = [];
  private _running = false;

  enqueue(task: () => void): void {
    this._queue.push(task);
    if (!this._running) this._flush();
  }

  private _flush(): void {
    this._running = true;
    var run = (): void => {
      if (this._queue.length === 0) { this._running = false; return; }
      var task = this._queue.shift()!;
      task();
      // Yield to the event loop so rendering can interleave
      Promise.resolve().then(run);
    };
    Promise.resolve().then(run);
  }

  /** Drain all queued tasks synchronously (for tests / end-of-frame flush). */
  flushSync(): void {
    while (this._queue.length > 0) { var t = this._queue.shift()!; t(); }
    this._running = false;
  }
}

/** [Item 972] Layout profiler — records per-subtree timing so hot paths can be
 *  identified.  Call `startLayout(id)` before laying out a node and
 *  `endLayout(id)` afterwards; `report()` returns sorted timings. */
export class LayoutProfiler {
  private _starts: Map<string, number> = new Map();
  private _totals: Map<string, number> = new Map();
  private _counts: Map<string, number> = new Map();
  enabled = false;

  startLayout(id: string): void {
    if (!this.enabled) return;
    this._starts.set(id, Date.now());
  }

  endLayout(id: string): void {
    if (!this.enabled) return;
    var s = this._starts.get(id);
    if (s === undefined) return;
    var elapsed = Date.now() - s;
    this._totals.set(id, (this._totals.get(id) ?? 0) + elapsed);
    this._counts.set(id, (this._counts.get(id) ?? 0) + 1);
    this._starts.delete(id);
  }

  report(): Array<{ id: string; totalMs: number; count: number; avgMs: number }> {
    var rows: Array<{ id: string; totalMs: number; count: number; avgMs: number }> = [];
    this._totals.forEach((totalMs, id) => {
      var count = this._counts.get(id) ?? 1;
      rows.push({ id, totalMs, count, avgMs: totalMs / count });
    });
    rows.sort(function(a, b) { return b.totalMs - a.totalMs; });
    return rows;
  }

  reset(): void {
    this._starts.clear();
    this._totals.clear();
    this._counts.clear();
  }
}

// Singleton exports for easy consumption by the layout engine
export const layoutContainment      = new LayoutContainment();
export const flexGridTrackCache     = new FlexGridTrackCache();
export const containingBlockCache   = new ContainingBlockCache();
export const layoutBudget           = new LayoutBudget(4);
export const gridAutoPlacement      = GridAutoPlacementFastPath;
export const parallelLayoutScheduler = new ParallelLayoutScheduler();
export const layoutProfiler         = new LayoutProfiler();

// ── Additional layout optimizations ──────────────────────────────────────────

/** [Item 894] ReadWriteBatcher — group DOM reads before writes to prevent
 *  forced synchronous layouts (layout thrashing).
 *
 *  Usage: call `read(fn)` for any DOM measurement, `write(fn)` for any DOM
 *  mutation.  The batcher will run all reads first, then all writes, in a
 *  single scheduled flush — ensuring the layout engine only runs once. */
export class ReadWriteBatcher {
  private _reads:  Array<() => void> = [];
  private _writes: Array<() => void> = [];
  private _scheduled = false;

  /** Queue a DOM read (measurement) callback. */
  read(fn: () => void): void {
    this._reads.push(fn);
    this._schedule();
  }

  /** Queue a DOM write (mutation) callback. */
  write(fn: () => void): void {
    this._writes.push(fn);
    this._schedule();
  }

  /** Flush reads then writes immediately (called by the frame scheduler). */
  flush(): void {
    this._scheduled = false;
    var reads  = this._reads.splice(0);
    var writes = this._writes.splice(0);
    // Reads first — they observe the pre-mutation state without triggering relayout
    for (var i = 0; i < reads.length; i++) reads[i]();
    // Then writes — only one layout pass needed
    for (var j = 0; j < writes.length; j++) writes[j]();
  }

  private _schedule(): void {
    if (!this._scheduled) {
      this._scheduled = true;
      Promise.resolve().then(() => this.flush());
    }
  }
}

export const readWriteBatcher = new ReadWriteBatcher();

// ── Compositor Layer Tree — Items 899 / 900 ───────────────────────────────────

/** Reasons a node may be promoted to its own compositor layer. */
export type LayerPromotionReason =
  | 'position-fixed'
  | 'transform'
  | 'opacity'
  | 'will-change'
  | 'z-index-stacking'
  | 'canvas'
  | 'video';

/** A compositor layer entry. */
export interface CompositorLayer {
  nodeId: string;
  reasons: LayerPromotionReason[];
  /** Estimated memory cost in bytes (width × height × 4). */
  memoryCost: number;
}

/**
 * [Item 899 / 900] CompositorLayerTree — tracks which DOM nodes have been
 * promoted to compositor layers and why.
 *
 *  - `position: fixed` / `position: sticky` (item 899)
 *  - `transform`, `opacity` animated properties (item 899)
 *  - `will-change: transform` (item 900) — explicit promotion hint
 *
 * The paint engine consults `isPromoted(id)` to decide whether to draw a
 * node into its own offscreen surface and composite rather than repaint.
 */
export class CompositorLayerTree {
  private _layers: Map<string, CompositorLayer> = new Map();

  /** Promote a node to a compositor layer with the given reason(s).
   *  If the node is already promoted, the new reason is merged in. */
  promote(nodeId: string, reason: LayerPromotionReason, w = 0, h = 0): void {
    var existing = this._layers.get(nodeId);
    if (existing) {
      if (existing.reasons.indexOf(reason) === -1) existing.reasons.push(reason);
    } else {
      this._layers.set(nodeId, {
        nodeId,
        reasons: [reason],
        memoryCost: w * h * 4,
      });
    }
  }

  /** Demote a node (e.g. when `will-change` is removed). */
  demote(nodeId: string): void {
    this._layers.delete(nodeId);
  }

  /** Return true when `nodeId` has been promoted. */
  isPromoted(nodeId: string): boolean {
    return this._layers.has(nodeId);
  }

  /** Return all reasons for promotion, or empty array. */
  reasons(nodeId: string): LayerPromotionReason[] {
    return this._layers.get(nodeId)?.reasons ?? [];
  }

  /** Total estimated VRAM usage of all promoted layers (bytes). */
  totalMemory(): number {
    var total = 0;
    this._layers.forEach(function(l) { total += l.memoryCost; });
    return total;
  }

  /** All promoted layers (for DevTools layer panel). */
  all(): CompositorLayer[] {
    return Array.from(this._layers.values());
  }

  /** Scan a style object and auto-promote based on CSS properties.
   *  Call this after a style change is applied. */
  applyStyle(nodeId: string, style: Record<string, string>, w = 0, h = 0): void {
    var pos = style['position'];
    if (pos === 'fixed' || pos === 'sticky') this.promote(nodeId, 'position-fixed', w, h);

    var wc = style['will-change'] ?? '';
    if (wc.indexOf('transform') !== -1) this.promote(nodeId, 'will-change', w, h);  // [Item 900]
    if (wc.indexOf('opacity') !== -1)   this.promote(nodeId, 'opacity', w, h);

    if (style['transform'] && style['transform'] !== 'none') this.promote(nodeId, 'transform', w, h);
    if (style['opacity'] !== undefined && style['opacity'] !== '1') this.promote(nodeId, 'opacity', w, h);
  }
}

export const compositorLayerTree = new CompositorLayerTree();

// ── Partial Style Invalidation — Item 902 ────────────────────────────────────

/** Cache-key prefix for selector-based style invalidation groups. */
type InvalidationGroup = 'nth-child' | 'attr' | 'class' | 'id' | 'pseudo';

/**
 * [Item 902] StyleInvalidationTracker — fine-grained style invalidation.
 *
 *  Instead of triggering a full style recalc when any attribute changes,
 *  nodes are grouped by the selector types that affect them.  When an
 *  attribute mutates only the matching group is re-evaluated.
 *
 *  Groups:
 *    - 'nth-child'  — `:nth-child`, `:first-child`, `:last-child`
 *    - 'attr'       — `[attr]`, `[attr=val]` attribute selectors
 *    - 'class'      — `.className` selectors
 *    - 'id'         — `#id` selectors
 *    - 'pseudo'     — `:hover`, `:focus`, `:active`, `:checked`
 */
export class StyleInvalidationTracker {
  private _groups: Map<InvalidationGroup, Set<string>> = new Map();
  private _dirty:  Set<InvalidationGroup> = new Set();

  /** Register `nodeId` into the given invalidation group. */
  registerNode(nodeId: string, groups: InvalidationGroup[]): void {
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!this._groups.has(g)) this._groups.set(g, new Set());
      this._groups.get(g)!.add(nodeId);
    }
  }

  /** Unregister from all groups (on node removal). */
  unregisterNode(nodeId: string): void {
    this._groups.forEach(function(set) { set.delete(nodeId); });
  }

  /** Mark an invalidation group as dirty (e.g. after an attribute mutation). */
  invalidate(group: InvalidationGroup): void { this._dirty.add(group); }

  /** Return the set of node IDs that need style recalc and reset the dirty set.
   *  Only nodes in the dirtied groups are returned — others skip recalc. */
  flush(): Set<string> {
    var affected = new Set<string>();
    this._dirty.forEach((g) => {
      (this._groups.get(g) ?? new Set()).forEach(function(id) { affected.add(id); });
    });
    this._dirty.clear();
    return affected;
  }

  /** True when any group is pending recalc. */
  get hasDirty(): boolean { return this._dirty.size > 0; }
}

export const styleInvalidationTracker = new StyleInvalidationTracker();

