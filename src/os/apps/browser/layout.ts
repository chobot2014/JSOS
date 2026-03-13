import type { PixelColor } from '../../core/sdk.js';
import type { RenderNode, InlineSpan, RenderedSpan, RenderedLine, WidgetBlueprint, PositionedWidget, LayoutResult, BoxDecoration } from './types.js';
import {
  CHAR_W, CHAR_H, LINE_H, CONTENT_PAD,
  WIDGET_INPUT_H, WIDGET_BTN_H, WIDGET_CHECK_SZ, WIDGET_SELECT_H,
  CLR_BODY, CLR_LINK, CLR_BOLD, CLR_ITALIC, CLR_CODE, CLR_CODE_BG,
  CLR_DEL, CLR_MARK_TXT, CLR_PRE_TXT, CLR_H1, CLR_H2, CLR_H3,
  CLR_QUOTE_TXT,
} from './constants.js';
import { getLayoutCache, setLayoutCache, layoutFingerprint, getBlockLayoutCache, setBlockLayoutCache, blockFingerprint, type BlockLayoutCache } from './cache.js';
import { layoutGrid, layoutTable } from './layout-ext.js';

// ── CSS transform translate parser ───────────────────────────────────────────
/**
 * Extract the net [tx, ty] pixel translation from a CSS transform string.
 * Handles: translate(x,y), translateX(x), translateY(y), translate3d(x,y,z).
 * Units: px, %, em (1em=16px). Ignores rotate/scale (visual only, not position-affecting here).
 * Returns [0, 0] if no translate or unparseable.
 */
function _parseCSSTranslate(t: string): [number, number] {
  var tx = 0, ty = 0;
  var re = /(translateX|translateY|translate3d|translate)\(([^)]*)\)/g;
  var m: RegExpExecArray | null;
  var _parsePx = function(s: string): number {
    s = s.trim();
    if (s.endsWith('px')) return parseFloat(s);
    if (s.endsWith('em')) return parseFloat(s) * 16;
    if (s.endsWith('%'))  return 0; // cannot resolve % without element size — skip
    return parseFloat(s) || 0;
  };
  while ((m = re.exec(t)) !== null) {
    var fn   = m[1]!;
    var args = m[2]!.split(',');
    if (fn === 'translateX') { tx += _parsePx(args[0] ?? '0'); }
    else if (fn === 'translateY') { ty += _parsePx(args[0] ?? '0'); }
    else if (fn === 'translate' || fn === 'translate3d') {
      tx += _parsePx(args[0] ?? '0');
      ty += _parsePx(args[1] ?? '0');
    }
  }
  return [tx, ty];
}

// ── Inline word-flow layout ───────────────────────────────────────────────────

export function flowSpans(
  spans:    InlineSpan[],
  xLeft:    number,
  maxX:     number,
  lineH:    number,
  baseClr:  PixelColor,
  opts?: { preBg?: boolean; quoteBg?: boolean; quoteBar?: boolean; bgColor?: number; bgGradient?: string;
           bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean;
           letterSpacing?: number; wordSpacing?: number; whiteSpace?: string; textIndent?: number;
           /** Float text wrapping (item 4.8): narrow x for the first N lines of this flow */
           floatFirstLines?: number; floatXLeft?: number; floatMaxX?: number; }
): RenderedLine[] {
  var lines:   RenderedLine[] = [];
  var curLine: RenderedSpan[] = [];
  // Active x bounds — may switch from float-narrowed to full-width after floatFirstLines
  var _floatFL  = (opts?.floatFirstLines  || 0);
  var curXLeft  = (_floatFL > 0 && opts?.floatXLeft !== undefined) ? opts.floatXLeft : xLeft;
  var curMaxX   = (_floatFL > 0 && opts?.floatMaxX  !== undefined) ? opts.floatMaxX  : maxX;
  var curX = curXLeft;
  // text-indent: offset the first line
  if (opts?.textIndent) curX += opts.textIndent;
  // white-space: nowrap prevents word wrapping (all content on one line)
  var _nowrap = opts?.whiteSpace === 'nowrap';
  // word-break: break-all splits at every character boundary (item 421)
  var _breakAll = opts?.wordBreak === 'break-all';
  // Letter/word spacing: add extra px per char/space
  var _lspc = opts?.letterSpacing || 0;
  var _wspc = opts?.wordSpacing   || 0;

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
    curLine = [];
    // After committing this line, check if float narrowing should end (item 4.8)
    if (_floatFL > 0 && lines.length >= _floatFL) {
      curXLeft = xLeft; curMaxX = maxX;
    }
    curX = curXLeft;
  }

  function addWord(word: string, sp: InlineSpan): void {
    var cw   = CHAR_W * (sp.fontScale || 1) + _lspc;  // scaled char width + letter-spacing
    var clr  = spanColor(sp);
    var nspc = curX > curXLeft;
    var spcW = nspc ? (cw + _wspc) : 0;  // space width includes word-spacing
    if (!_nowrap && curX + spcW + word.length * cw > curMaxX && curX > curXLeft) {
      commitLine(); nspc = false; spcW = 0;
    }
    while (word.length > 0) {
      var avail = _nowrap ? word.length : Math.max(1, Math.floor((curMaxX - curX - spcW) / cw));
      if (!_nowrap && avail <= 0 && curX > curXLeft) {
        commitLine(); nspc = false; spcW = 0;
        avail = Math.max(1, Math.floor((curMaxX - curXLeft) / cw));
      }
      var chunk   = word.slice(0, avail);
      var display = (nspc ? ' ' : '') + chunk;
      var rsp: RenderedSpan = { x: curX, text: display, color: clr };
      if (sp.href)      rsp.href      = sp.href;
      if (sp.download)  rsp.download  = sp.download;  // item 636
      if (sp.elId)      rsp.elId      = sp.elId;  // JS click-dispatch hit-test ID
      if (sp.noClick)   rsp.noClick   = true;     // pointer-events:none
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
          if (!word) { if (curX > xLeft) curX += CHAR_W + _wspc; continue; }
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

  // Phase 4.4 — Per-subtree layout profiling (no-op when layoutProfiler.enabled = false)
  var _lpId = '';
  if (layoutProfiler.enabled && nodes.length > 0) {
    _lpId = nodes[0].type || 'span';
    layoutProfiler.startLayout(_lpId);
  }

  // Absolutely/fixed-positioned elements collected separately (out-of-flow)
  var oofNodes: RenderNode[] = [];

  // Track consecutive blank space to cap excessive gaps
  var _consecBlank = 0;
  var _maxConsecBlank = LINE_H; // Cap blank gaps at 1 line height (13px)

  function blank(h: number): void {
    if (_consecBlank >= _maxConsecBlank) return; // Already at blank cap
    var capped = Math.min(h, _maxConsecBlank - _consecBlank);
    if (capped <= 0) return;
    lines.push({ y, nodes: [], lineH: capped }); y += capped;
    _consecBlank += capped;
  }
  function commit(newLines: RenderedLine[]): void {
    for (var k = 0; k < newLines.length; k++) {
      newLines[k].y = y; y += newLines[k].lineH; lines.push(newLines[k]);
    }
    // Reset blank tracker only if committed lines have visible text content
    for (var _ck = 0; _ck < newLines.length; _ck++) {
      if (newLines[_ck].nodes.length > 0) {
        var _hasVisible = false;
        for (var _cn = 0; _cn < newLines[_ck].nodes.length; _cn++) {
          if (newLines[_ck].nodes[_cn].text && newLines[_ck].nodes[_cn].text.trim()) {
            _hasVisible = true; break;
          }
        }
        if (_hasVisible) { _consecBlank = 0; break; }
      }
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

  // ── Active float state — narrows inline x for sibling wrap (item 4.8) ─────────
  var _activeLeftFloatLines   = 0; // remaining lines siblings must wrap around left float
  var _activeLeftFloatIndent  = 0; // px from blkLeft to reserve for left float
  var _activeRightFloatLines  = 0; // remaining lines siblings must wrap around right float
  var _activeRightFloatIndent = 0; // px from blkMaxX to reserve for right float

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
      lastBottomMargin = 0; _consecBlank = 0; continue;
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

    // ── Table layout ─────────────────────────────────────────────────────────
    if (nd.type === 'table' && nd.children) {
      var tblY = y;
      // Resolve percentage width
      var tblContentW = contentW;
      if ((nd as any)._widthPct) {
        tblContentW = Math.floor(contentW * (nd as any)._widthPct / 100);
      } else if (nd.boxWidth) {
        tblContentW = Math.min(nd.boxWidth, contentW);
      }
      (nd as any).boxWidth = tblContentW;
      var tblLines = layoutTable(
        nd, tblContentW,
        function(spans: InlineSpan[], txLeft: number, txMax: number, txLineH: number) {
          return flowSpans(spans, txLeft, txMax, txLineH, CLR_BODY);
        }
      );
      var tblMaxY = tblY;
      for (var tli = 0; tli < tblLines.length; tli++) {
        var tln = tblLines[tli];
        lines.push({ y: tblY + tln.y, nodes: tln.nodes, lineH: tln.lineH,
                     bgColor: tln.bgColor, preBg: tln.preBg });
        var tLineEnd = tblY + tln.y + (tln.lineH || LINE_H);
        if (tLineEnd > tblMaxY) tblMaxY = tLineEnd;
      }
      y = tblMaxY + (nd.marginBottom || 0);
      lastBottomMargin = nd.marginBottom || 0;
      continue;
    }

    if (nd.type === 'flex-row' && nd.children) {
      var fDir = nd.flexDirection || 'row';
      var fChildren = nd.children;
      var gap       = nd.gap ?? 8;
      var fRowY0    = y;
      var fxLeft    = xLeft + (nd.paddingLeft || 0);
      var fxAvail   = (nd.boxWidth ? Math.min(maxX, xLeft + nd.boxWidth) : maxX) - fxLeft - (nd.paddingRight || 0);
      var containerAlignItems = nd.alignItems || 'stretch';
      var justCon  = nd.justifyContent || 'flex-start';
      // Item 403: sort by 'order' property
      var fSorted = fChildren.slice().sort(function(a, b) { return (a.order ?? 0) - (b.order ?? 0); });

      // ── flex-direction: column / column-reverse ─────────────────────────────
      if (fDir === 'column' || fDir === 'column-reverse') {
        var fcColW  = fxAvail;
        var fcItems = fDir === 'column-reverse' ? fSorted.slice().reverse() : fSorted;
        var fcTotalH = 0;
        // Measure children to compute total height for justify-content
        var fcChildData: { childLines: RenderedLine[]; childH: number; childWidgets: PositionedWidget[] }[] = [];
        var fcBaseH: number[] = [];
        for (var fcci = 0; fcci < fcItems.length; fcci++) {
          var fcc = fcItems[fcci];
          var fccW = fcc.boxWidth ? Math.min(fcc.boxWidth, fcColW) : fcColW;
          var fccLines: RenderedLine[];
          var _fccWidgets: PositionedWidget[] = [];
          if (fcc.children && fcc.children.length > 0) {
            var _fccResult = _layoutNodesImpl(fcc.children, [], fccW);
            fccLines = _fccResult.lines;
            _fccWidgets = _fccResult.widgets;
          } else {
            fccLines = flowSpans(transformSpans(fcc.spans, fcc.textTransform), 0, fccW, nodeLineH(fcc), CLR_BODY,
              (fcc.bgColor !== undefined || fcc.bgGradient) ? { bgColor: fcc.bgColor, bgGradient: fcc.bgGradient } : undefined);
            // flowSpans returns all lines with y=0 — assign sequential y positions
            var _fccYPos = 0;
            for (var _fccyk = 0; _fccyk < fccLines.length; _fccyk++) {
              fccLines[_fccyk].y = _fccYPos;
              _fccYPos += fccLines[_fccyk].lineH;
            }
          }
          var fccH = fccLines.length > 0 ? (fccLines[fccLines.length - 1].y + (fccLines[fccLines.length - 1].lineH || LINE_H) - fccLines[0].y) : 0;
          // flex-basis overrides natural content height (0 = auto → use content height)
          var _fcb = fcc.flexBasis;
          var fccBaseH = (_fcb && _fcb > 0) ? _fcb : fccH;
          fcChildData.push({ childLines: fccLines, childH: fccH, childWidgets: _fccWidgets });
          fcBaseH.push(fccBaseH);
          fcTotalH += fccBaseH + (fcci < fcItems.length - 1 ? gap : 0);
        }
        // Apply flex-grow / flex-shrink to column items
        var fcContainerH = nd.height ?? 0; // Use explicit height if set
        var fcFreeH0 = fcContainerH > 0 ? fcContainerH - fcTotalH : 0;
        var fcFinalH: number[] = [];
        if (fcFreeH0 > 0) {
          var fcTotalGrow = 0;
          for (var fcg = 0; fcg < fcItems.length; fcg++) fcTotalGrow += (fcItems[fcg].flexGrow ?? 0);
          for (var fcg2 = 0; fcg2 < fcItems.length; fcg2++) {
            var fcGrow = fcItems[fcg2].flexGrow ?? 0;
            var fcExtra = fcTotalGrow > 0 ? fcFreeH0 * fcGrow / fcTotalGrow : 0;
            fcFinalH.push(Math.max(0, Math.floor(fcBaseH[fcg2] + fcExtra)));
          }
        } else if (fcFreeH0 < 0) {
          var fcTotalSF = 0;
          for (var fcs = 0; fcs < fcItems.length; fcs++) fcTotalSF += (fcItems[fcs].flexShrink ?? 1) * fcBaseH[fcs];
          for (var fcs2 = 0; fcs2 < fcItems.length; fcs2++) {
            var fcSF = (fcItems[fcs2].flexShrink ?? 1) * fcBaseH[fcs2];
            var fcRed = fcTotalSF > 0 ? (-fcFreeH0) * fcSF / fcTotalSF : 0;
            fcFinalH.push(Math.max(0, Math.floor(fcBaseH[fcs2] - fcRed)));
          }
        } else {
          for (var fcn = 0; fcn < fcItems.length; fcn++) fcFinalH.push(fcBaseH[fcn]);
        }
        // Recompute total after grow/shrink
        var fcAdjTotal = 0;
        for (var fcaj = 0; fcaj < fcFinalH.length; fcaj++) fcAdjTotal += fcFinalH[fcaj] + (fcaj < fcFinalH.length - 1 ? gap : 0);
        // Compute main-axis (vertical) free space and justify-content offsets
        var fcFreeH = fcContainerH > 0 ? Math.max(0, fcContainerH - fcAdjTotal) : 0;
        var fcStartOffset = 0, fcGapExtra = 0;
        if (fcFreeH > 0 && fcItems.length > 0) {
          if (justCon === 'center') { fcStartOffset = Math.floor(fcFreeH / 2); }
          else if (justCon === 'flex-end' || justCon === 'end') { fcStartOffset = fcFreeH; }
          else if (justCon === 'space-between' && fcItems.length > 1) { fcGapExtra = Math.floor(fcFreeH / (fcItems.length - 1)); }
          else if (justCon === 'space-around') { var fca1 = Math.floor(fcFreeH / fcItems.length); fcStartOffset = Math.floor(fca1 / 2); fcGapExtra = fca1; }
          else if (justCon === 'space-evenly') { var fca2 = Math.floor(fcFreeH / (fcItems.length + 1)); fcStartOffset = fca2; fcGapExtra = fca2; }
        }
        // Stamp children
        var fcCurY = fRowY0 + fcStartOffset;
        var fcMaxX2 = 0;
        for (var fcci2 = 0; fcci2 < fcChildData.length; fcci2++) {
          var fccD = fcChildData[fcci2];
          var fccItem = fcItems[fcci2];
          var fccW2 = fccItem.boxWidth ? Math.min(fccItem.boxWidth, fcColW) : fcColW;
          // Cross-axis (horizontal) alignment
          var fccAlignSelf = fccItem.alignSelf || containerAlignItems;
          // For center/end alignment: compute actual content width if no explicit boxWidth
          if (fccAlignSelf !== 'stretch' && !fccItem.boxWidth) {
            var _fccMaxX = 0;
            for (var _fccli = 0; _fccli < fccD.childLines.length; _fccli++) {
              var _fccl2 = fccD.childLines[_fccli];
              for (var _fccni = 0; _fccni < _fccl2.nodes.length; _fccni++) {
                var _fccn = _fccl2.nodes[_fccni];
                var _fccnEnd = _fccn.x + _fccn.text.length * CHAR_W * (_fccn.fontScale || 1);
                if (_fccnEnd > _fccMaxX) _fccMaxX = _fccnEnd;
              }
            }
            for (var _fccwi = 0; _fccwi < fccD.childWidgets.length; _fccwi++) {
              var _fccwEnd = fccD.childWidgets[_fccwi].px + fccD.childWidgets[_fccwi].pw;
              if (_fccwEnd > _fccMaxX) _fccMaxX = _fccwEnd;
            }
            if (_fccMaxX > CONTENT_PAD) fccW2 = _fccMaxX - CONTENT_PAD;
          }
          var fccCrossX = fxLeft;
          if (fccAlignSelf === 'center') fccCrossX = fxLeft + Math.floor((fcColW - fccW2) / 2);
          else if (fccAlignSelf === 'flex-end' || fccAlignSelf === 'end') fccCrossX = fxLeft + fcColW - fccW2;
          if (fccCrossX + fccW2 > fcMaxX2) fcMaxX2 = fccCrossX + fccW2;
          // Compute the position offset to stamp child lines from (CONTENT_PAD,CONTENT_PAD) into correct parent position
          var _fccFirstY = fccD.childLines.length > 0 ? fccD.childLines[0].y : CONTENT_PAD;
          for (var fccl = 0; fccl < fccD.childLines.length; fccl++) {
            var fccLine = fccD.childLines[fccl];
            var _clRelY2 = fccLine.y - _fccFirstY;
            var fccShifted = fccLine.nodes.map(function(n) { return { ...n, x: n.x + fccCrossX }; });
            lines.push({ y: fcCurY + _clRelY2, nodes: fccShifted, lineH: fccLine.lineH || LINE_H, bgColor: fccLine.bgColor, bgGradient: fccLine.bgGradient });
          }
          // Shift child widgets to parent position
          var _fccDx = fccCrossX - CONTENT_PAD;
          var _fccDy = fcCurY - _fccFirstY;
          for (var _fccwi2 = 0; _fccwi2 < fccD.childWidgets.length; _fccwi2++) {
            var _cw = fccD.childWidgets[_fccwi2];
            _cw.px += _fccDx;
            _cw.py += _fccDy;
            widgets.push(_cw);
          }
          // Advance by child content height
          fcCurY += fccD.childH;
          // Advance to the flex-allocated height (accounts for grow/shrink)
          var fccUsedH = fccD.childH;
          if (fcFinalH[fcci2] > fccUsedH) fcCurY += fcFinalH[fcci2] - fccUsedH;
          if (fcci2 < fcChildData.length - 1) fcCurY += gap + fcGapExtra;
        }
        y = fcCurY;
        lastBottomMargin = nd.marginBottom || 0;
        continue;
      }

      // ── flex-direction: row / row-reverse (default) ─────────────────────────
      if (fDir === 'row-reverse') fSorted.reverse();

      var fxUsedGap  = gap * Math.max(0, fSorted.length - 1);
      var fxFreeInit = fxAvail - fxUsedGap;
      // Two-pass flex algorithm: compute hypothetical main sizes
      // flex-basis overrides boxWidth for initial main size; 0 means auto (use boxWidth)
      var fBaseW: number[] = [];
      for (var fi = 0; fi < fSorted.length; fi++) {
        var _fb = fSorted[fi].flexBasis;
        fBaseW.push((_fb && _fb > 0) ? _fb : (fSorted[fi].boxWidth ?? 0));
      }
      var fFixedTotal = 0, flexibleCount = 0;
      for (var fi2 = 0; fi2 < fSorted.length; fi2++) {
        if (fBaseW[fi2] > 0) fFixedTotal += fBaseW[fi2];
        else flexibleCount++;
      }
      var fFlexPool = fxFreeInit - fFixedTotal;
      var fFreeSpace = flexibleCount > 0 ? fFlexPool / flexibleCount : 0;
      var fHypoW: number[] = [];
      for (var fi3 = 0; fi3 < fSorted.length; fi3++) {
        fHypoW.push(fBaseW[fi3] > 0 ? fBaseW[fi3] : Math.max(0, fFreeSpace));
      }
      var fHypoTotal = fHypoW.reduce(function(a, b) { return a + b; }, 0);
      var fFree = fxFreeInit - fHypoTotal;

      // Item 402: Apply flex-grow (positive) or flex-shrink (negative)
      var fFinalW: number[] = [];
      if (fFree >= 0) {
        var totalGrow = 0;
        for (var fi4 = 0; fi4 < fSorted.length; fi4++) totalGrow += (fSorted[fi4].flexGrow ?? 0);
        for (var fi5 = 0; fi5 < fSorted.length; fi5++) {
          var grow = fSorted[fi5].flexGrow ?? 0;
          var extra = totalGrow > 0 ? fFree * grow / totalGrow : 0;
          fFinalW.push(Math.max(0, Math.floor(fHypoW[fi5] + extra)));
        }
      } else {
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

      // flex-wrap: split into lines if content overflows
      var fDoWrap = nd.flexWrap === 'wrap' || nd.flexWrap === 'wrap-reverse';
      var fWrapLines: { items: number[]; totalMainSize: number }[] = [];
      if (fDoWrap) {
        var fWrapCur: number[] = []; var fWrapTotal = 0;
        for (var fwi = 0; fwi < fSorted.length; fwi++) {
          var fwItemW = fFinalW[fwi];
          var fwGap   = fWrapCur.length > 0 ? gap : 0;
          if (fWrapCur.length > 0 && fWrapTotal + fwGap + fwItemW > fxAvail) {
            fWrapLines.push({ items: fWrapCur.slice(), totalMainSize: fWrapTotal });
            fWrapCur = [fwi]; fWrapTotal = fwItemW;
          } else {
            fWrapCur.push(fwi); fWrapTotal += fwGap + fwItemW;
          }
        }
        if (fWrapCur.length > 0) fWrapLines.push({ items: fWrapCur, totalMainSize: fWrapTotal });
        if (nd.flexWrap === 'wrap-reverse') fWrapLines.reverse();
      } else {
        var allIdx: number[] = [];
        var allTotal = 0;
        for (var fwall = 0; fwall < fSorted.length; fwall++) { allIdx.push(fwall); allTotal += fFinalW[fwall]; }
        fWrapLines.push({ items: allIdx, totalMainSize: allTotal });
      }

      var fMaxH = 0; var fCurLineY = fRowY0;
      // ── Pass 1: Measure each wrap line ───────────────────────────────────
      var fMeasuredLines: {
        items: { x: number; cw: number; cl: RenderedLine[]; alignSelf?: string }[];
        lineMaxH: number;
        justStart: number;
        justGapExtra: number;
      }[] = [];
      var fTotalCrossSize = 0;
      for (var fwl = 0; fwl < fWrapLines.length; fwl++) {
        var fwLine = fWrapLines[fwl];
        var fwItems = fwLine.items;
        var fwMainSize = fwLine.totalMainSize + gap * Math.max(0, fwItems.length - 1);
        // justify-content: compute start offset and per-gap extra
        var fwFree = fxAvail - fwMainSize;
        var fJustStart = 0, fJustGapExtra = 0;
        if (fwFree > 0 && fwItems.length > 0) {
          if (justCon === 'center') { fJustStart = Math.floor(fwFree / 2); }
          else if (justCon === 'flex-end' || justCon === 'end') { fJustStart = fwFree; }
          else if (justCon === 'space-between' && fwItems.length > 1) { fJustGapExtra = Math.floor(fwFree / (fwItems.length - 1)); }
          else if (justCon === 'space-around') { var fsa = Math.floor(fwFree / fwItems.length); fJustStart = Math.floor(fsa / 2); fJustGapExtra = fsa; }
          else if (justCon === 'space-evenly') { var fse = Math.floor(fwFree / (fwItems.length + 1)); fJustStart = fse; fJustGapExtra = fse; }
        }
        var fCurX = fxLeft + fJustStart;
        var lineMaxH = 0;
        var fChildLines: { x: number; cw: number; cl: RenderedLine[]; alignSelf?: string; childWidgets: PositionedWidget[] }[] = [];
        // Per-line flex-grow/shrink recalculation (CSS Flexbox spec compliance)
        var fwLineWidths: number[] = [];
        if (fDoWrap && fwItems.length > 0) {
          var fwUsedGap = gap * Math.max(0, fwItems.length - 1);
          var fwBaseTotal = 0;
          for (var fwbi = 0; fwbi < fwItems.length; fwbi++) fwBaseTotal += fHypoW[fwItems[fwbi]];
          var fwLineFree = fxAvail - fwUsedGap - fwBaseTotal;
          if (fwLineFree >= 0) {
            var fwTotalGrow = 0;
            for (var fwgi = 0; fwgi < fwItems.length; fwgi++) fwTotalGrow += (fSorted[fwItems[fwgi]].flexGrow ?? 0);
            for (var fwgi2 = 0; fwgi2 < fwItems.length; fwgi2++) {
              var fwGrow2 = fSorted[fwItems[fwgi2]].flexGrow ?? 0;
              var fwExtra = fwTotalGrow > 0 ? fwLineFree * fwGrow2 / fwTotalGrow : 0;
              fwLineWidths.push(Math.max(0, Math.floor(fHypoW[fwItems[fwgi2]] + fwExtra)));
            }
          } else {
            var fwTotalSF2 = 0;
            for (var fwsi = 0; fwsi < fwItems.length; fwsi++) fwTotalSF2 += (fSorted[fwItems[fwsi]].flexShrink ?? 1) * fHypoW[fwItems[fwsi]];
            for (var fwsi2 = 0; fwsi2 < fwItems.length; fwsi2++) {
              var fwSF = (fSorted[fwItems[fwsi2]].flexShrink ?? 1) * fHypoW[fwItems[fwsi2]];
              var fwRed = fwTotalSF2 > 0 ? (-fwLineFree) * fwSF / fwTotalSF2 : 0;
              fwLineWidths.push(Math.max(0, Math.floor(fHypoW[fwItems[fwsi2]] - fwRed)));
            }
          }
        }
        for (var fci = 0; fci < fwItems.length; fci++) {
          var fIdx  = fwItems[fci];
          var fc    = fSorted[fIdx];
          var cw    = (fDoWrap && fwLineWidths.length > 0) ? fwLineWidths[fci] : fFinalW[fIdx];
          // Recursive layout: if child has nested children (block structure), lay out recursively
          var cLines: RenderedLine[];
          var _fcChildWidgets: PositionedWidget[] = [];
          if (fc.children && fc.children.length > 0) {
            var _fcResult = _layoutNodesImpl(fc.children, [], cw);
            cLines = _fcResult.lines;
            _fcChildWidgets = _fcResult.widgets;
          } else {
            var _fcFlowOpts: any = undefined;
            if (fc.bgColor !== undefined || fc.bgGradient || fc.whiteSpace === 'nowrap' || fc.wordBreak || fc.textOverflow === 'ellipsis') {
              _fcFlowOpts = {};
              if (fc.bgColor !== undefined) _fcFlowOpts.bgColor = fc.bgColor;
              if (fc.bgGradient) _fcFlowOpts.bgGradient = fc.bgGradient;
              if (fc.whiteSpace === 'nowrap') _fcFlowOpts.whiteSpace = 'nowrap';
              if (fc.wordBreak) _fcFlowOpts.wordBreak = fc.wordBreak;
              if (fc.textOverflow === 'ellipsis') _fcFlowOpts.ellipsis = true;
            }
            cLines = flowSpans(transformSpans(fc.spans, fc.textTransform), 0, cw, nodeLineH(fc), CLR_BODY, _fcFlowOpts);
            // flowSpans returns all lines with y=0 — assign sequential y positions
            // so the stamping pass can compute correct relative offsets
            var _fyPos = 0;
            for (var _fyk = 0; _fyk < cLines.length; _fyk++) {
              cLines[_fyk].y = _fyPos;
              _fyPos += cLines[_fyk].lineH;
            }
          }
          var fcAlign = fc.alignSelf || containerAlignItems;
          fChildLines.push({ x: fCurX, cw, cl: cLines, alignSelf: fcAlign, childWidgets: _fcChildWidgets });
          var childH = cLines.length > 0 ? (cLines[cLines.length - 1].y + (cLines[cLines.length - 1].lineH || LINE_H) - cLines[0].y) : 0;
          if (childH > lineMaxH) lineMaxH = childH;
          fCurX += cw + gap + fJustGapExtra;
        }
        fMeasuredLines.push({ items: fChildLines, lineMaxH: lineMaxH, justStart: fJustStart, justGapExtra: fJustGapExtra });
        fTotalCrossSize += lineMaxH + (fwl < fWrapLines.length - 1 ? gap : 0);
      }

      // ── Pass 2: align-content — distribute cross-axis free space ─────────
      var acMode = nd.alignContent || 'stretch';
      var acContainerH = nd.height ?? 0;
      var acFreeCross = acContainerH > 0 ? Math.max(0, acContainerH - fTotalCrossSize) : 0;
      var acStartOffset = 0, acGapExtra = 0;
      if (acFreeCross > 0 && fMeasuredLines.length > 0 && fDoWrap) {
        if (acMode === 'center') { acStartOffset = Math.floor(acFreeCross / 2); }
        else if (acMode === 'flex-end' || acMode === 'end') { acStartOffset = acFreeCross; }
        else if (acMode === 'space-between' && fMeasuredLines.length > 1) { acGapExtra = Math.floor(acFreeCross / (fMeasuredLines.length - 1)); }
        else if (acMode === 'space-around') { var aca1 = Math.floor(acFreeCross / fMeasuredLines.length); acStartOffset = Math.floor(aca1 / 2); acGapExtra = aca1; }
        else if (acMode === 'space-evenly') { var aca2 = Math.floor(acFreeCross / (fMeasuredLines.length + 1)); acStartOffset = aca2; acGapExtra = aca2; }
        else if (acMode === 'stretch') {
          // Stretch: distribute free space equally across line heights
          var acStretchEach = Math.floor(acFreeCross / fMeasuredLines.length);
          for (var acsi = 0; acsi < fMeasuredLines.length; acsi++) fMeasuredLines[acsi].lineMaxH += acStretchEach;
        }
      }

      // ── Pass 3: Stamp children ───────────────────────────────────────────
      fCurLineY = fRowY0 + acStartOffset;
      for (var fwl2 = 0; fwl2 < fMeasuredLines.length; fwl2++) {
        var fml = fMeasuredLines[fwl2];
        for (var fci2 = 0; fci2 < fml.items.length; fci2++) {
          var fc2  = fml.items[fci2];
          var fcH2 = fc2.cl.length > 0 ? fc2.cl.length * (fc2.cl[0]!.lineH || LINE_H) : 0;
          var crossOffset = 0;
          var fcAlignMode = fc2.alignSelf || 'stretch';
          if (fcAlignMode === 'center') { crossOffset = Math.floor((fml.lineMaxH - fcH2) / 2); }
          else if (fcAlignMode === 'flex-end' || fcAlignMode === 'end') { crossOffset = fml.lineMaxH - fcH2; }
          var _fcFirstY2 = fc2.cl.length > 0 ? fc2.cl[0].y : CONTENT_PAD;
          for (var cli2 = 0; cli2 < fc2.cl.length; cli2++) {
            var cl2 = fc2.cl[cli2]!;
            // Remap: recursive layout produces absolute y; convert to relative offset
            var _clRelY = cl2.y - _fcFirstY2;
            var shifted = cl2.nodes.map(function(n) { return { ...n, x: n.x + fc2.x }; });
            lines.push({ y: fCurLineY + crossOffset + _clRelY, nodes: shifted,
                         lineH: cl2.lineH, bgColor: cl2.bgColor, bgGradient: cl2.bgGradient, preBg: cl2.preBg,
                         boxDeco: cl2.boxDeco });
          }
          // Shift child widgets to parent position
          var _fcDx2 = fc2.x - CONTENT_PAD;
          var _fcDy2 = (fCurLineY + crossOffset) - _fcFirstY2;
          for (var _fwi2 = 0; _fwi2 < fc2.childWidgets.length; _fwi2++) {
            var _cw2 = fc2.childWidgets[_fwi2];
            _cw2.px += _fcDx2;
            _cw2.py += _fcDy2;
            widgets.push(_cw2);
          }
        }
        fCurLineY += fml.lineMaxH + gap + acGapExtra;
        if (fml.lineMaxH > fMaxH) fMaxH = fml.lineMaxH;
      }
      y = fCurLineY;
      lastBottomMargin = nd.marginBottom || 0;
      continue;
    }

    if (nd.type === 'block' || nd.type === 'aside') {
      // ── Skip empty blocks: no text, no visual properties, no height ─────────
      var _hasText = false;
      for (var _sti2 = 0; _sti2 < nd.spans.length; _sti2++) {
        if (nd.spans[_sti2].text && nd.spans[_sti2].text.trim()) { _hasText = true; break; }
      }
      if (!_hasText && !nd.bgColor && !nd.bgGradient && !nd.bgImage
          && !nd.borderWidth && !nd.boxShadow
          && !nd.minHeight && !nd.height) {
        // Empty block — collapse margins but produce no vertical space
        lastBottomMargin = Math.max(lastBottomMargin, nd.marginBottom || 0);
        continue;
      }
      // ── Margin collapsing ────────────────────────────────────────────────────
      var preMarginRaw  = nd.marginTop  || 0;
      var postMarginRaw = nd.marginBottom || 0;
      var preM  = collapseMargin(preMarginRaw);
      if (preM  > 0) blank(preM);

      var bgColor   = nd.bgColor;
      var bgGradient = nd.bgGradient;
      // Resolve percentage width against container (item 2.1)
      var _effectBoxW = nd.boxWidth || 0;
      if (nd.widthPct && nd.widthPct > 0) {
        _effectBoxW = Math.floor((contentW - CONTENT_PAD * 2) * nd.widthPct / 100);
      }
      // Clamp to min-width / max-width
      if (nd.minWidth && nd.minWidth > 0 && _effectBoxW > 0 && _effectBoxW < nd.minWidth) {
        _effectBoxW = nd.minWidth;
      }
      if (nd.maxWidth && nd.maxWidth > 0) {
        if (_effectBoxW > 0) { _effectBoxW = Math.min(_effectBoxW, nd.maxWidth); }
        else { _effectBoxW = nd.maxWidth; }
      }
      var blkLeft   = xLeft + (nd.paddingLeft ? Math.round(nd.paddingLeft / CHAR_W) * CHAR_W : 0);
      var blkRight  = nd.paddingRight ? Math.round(nd.paddingRight / CHAR_W) * CHAR_W : 0;
      var blkMaxX   = (_effectBoxW ? Math.min(maxX, xLeft + _effectBoxW) : maxX) - blkRight;
      // margin: auto centering — shift block inward when explicit width set (item 2.2)
      if (nd.centerBlock && _effectBoxW > 0) {
        var _centerOff = Math.max(0, Math.floor((contentW - _effectBoxW) / 2));
        blkLeft += _centerOff;
        blkMaxX  = blkLeft + _effectBoxW - blkRight;
      }
      // Track lines start for position:relative offset (item 2.3), position:sticky (item 2.4), and CSS transform (item 2.5)
      var _relStart  = (nd.position === 'relative' || nd.position === 'sticky' || (nd.transform && nd.transform !== 'none')) ? lines.length : -1;
      var lh        = nodeLineH(nd);
      var ndSpans   = transformSpans(nd.spans, nd.textTransform);

      // Build flow opts including bgImage (item 386) and word-break (item 421)
      function makeFlowOpts(): typeof undefined | { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean; letterSpacing?: number; wordSpacing?: number; whiteSpace?: string; textIndent?: number } {
        var o: { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean; letterSpacing?: number; wordSpacing?: number; whiteSpace?: string; textIndent?: number } = {};
        var any = false;
        if (bgColor !== undefined)  { o.bgColor = bgColor; any = true; }
        if (bgGradient)             { o.bgGradient = bgGradient; any = true; }
        if (nd.bgImage)             { o.bgImageUrl = nd.bgImage; any = true; }
        if (nd.wordBreak)           { o.wordBreak = nd.wordBreak; any = true; }
        if (nd.overflowWrap)        { o.overflowWrap = nd.overflowWrap; any = true; }
        if (nd.textOverflow === 'ellipsis') { o.ellipsis = true; any = true; }  // item 465
        if (nd.letterSpacing)       { o.letterSpacing = nd.letterSpacing; any = true; }
        if (nd.wordSpacing)         { o.wordSpacing = nd.wordSpacing; any = true; }
        if (nd.whiteSpace === 'nowrap') { o.whiteSpace = 'nowrap'; any = true; }
        if (nd.textIndent)          { o.textIndent = nd.textIndent; any = true; }
        return any ? o : undefined;
      }

      if (nd.float === 'right') {
        // Float right — out-of-flow: lay out, record extents, reset y (item 4.8)
        var asideW    = nd.boxWidth ? Math.min(nd.boxWidth, maxX - xLeft) : Math.min(maxX - xLeft, 200);
        var asideX    = maxX - asideW;
        var yBfRight  = y;
        commit(flowSpans(ndSpans, asideX + 4, maxX - 4, lh, CLR_BODY, makeFlowOpts()));
        // Record right float extents for sibling wrapping
        var _rfLines  = Math.ceil((y - yBfRight) / lh);
        _activeRightFloatLines  = Math.max(_activeRightFloatLines, _rfLines);
        _activeRightFloatIndent = Math.max(_activeRightFloatIndent, asideW + 4);
        y = yBfRight; // float is out-of-flow
      } else if (nd.float === 'left') {
        // Float left — out-of-flow: lay out, record extents, reset y (item 4.8)
        var fLeftW   = nd.boxWidth ? Math.min(nd.boxWidth, (maxX - xLeft) >> 1) : Math.min(160, (maxX - xLeft) >> 1);
        var yBfLeft  = y;
        commit(flowSpans(ndSpans, xLeft + 4, xLeft + fLeftW - 4, lh, CLR_BODY, makeFlowOpts()));
        // Record left float extents for sibling wrapping
        var _lfLines  = Math.ceil((y - yBfLeft) / lh);
        _activeLeftFloatLines   = Math.max(_activeLeftFloatLines, _lfLines);
        _activeLeftFloatIndent  = Math.max(_activeLeftFloatIndent, fLeftW + 4);
        y = yBfLeft; // float is out-of-flow
      } else {
        // Normal block flow
        var yBeforeBlock = y;
        var _blockLineStart = lines.length;
        // Apply active float indents for the first N lines (item 4.8)
        var _baseFlowOpts = makeFlowOpts();
        var _combinedOpts: Parameters<typeof flowSpans>[5] = _baseFlowOpts;
        if (_activeLeftFloatLines > 0 || _activeRightFloatLines > 0) {
          _combinedOpts = {
            ...(_baseFlowOpts || {}),
            floatFirstLines: Math.max(_activeLeftFloatLines, _activeRightFloatLines),
            floatXLeft:  _activeLeftFloatLines  > 0 ? blkLeft + _activeLeftFloatIndent  : undefined,
            floatMaxX:   _activeRightFloatLines > 0 ? blkMaxX - _activeRightFloatIndent : undefined,
          };
        }
        // Apply padding-top before block content
        if (nd.paddingTop && nd.paddingTop > 0) blank(nd.paddingTop);
        commit(flowSpans(ndSpans, blkLeft, blkMaxX, lh, CLR_BODY, _combinedOpts));
        // Apply padding-bottom after block content
        if (nd.paddingBottom && nd.paddingBottom > 0) blank(nd.paddingBottom);
        // text-align: shift committed line nodes for center / right / justify
        var _ta = nd.textAlign;
        // Auto-center narrow root-level lines (same heuristic as widget centering)
        if (!_ta && blkLeft < 20 && lines.length > _blockLineStart) {
          var _acLineW = blkMaxX - blkLeft;
          for (var _aci = _blockLineStart; _aci < lines.length; _aci++) {
            var _acLine = lines[_aci];
            if (!_acLine.nodes.length) continue;
            var _acLast = _acLine.nodes[_acLine.nodes.length - 1]!;
            var _acUsed = (_acLast.x - blkLeft) + _acLast.text.length * CHAR_W * (_acLast.fontScale || 1);
            if (_acUsed < _acLineW * 0.3) {
              var _acFree = Math.max(0, _acLineW - _acUsed);
              var _acShift = Math.floor(_acFree / 2);
              if (_acShift > 0) {
                lines[_aci] = { ..._acLine, nodes: _acLine.nodes.map(function(n) { return { ...n, x: n.x + _acShift }; }) };
              }
            }
          }
        }
        if (_ta && _ta !== 'left' && lines.length > _blockLineStart) {
          var _lineW = blkMaxX - blkLeft;
          for (var _tai = _blockLineStart; _tai < lines.length; _tai++) {
            var _taLine = lines[_tai];
            if (!_taLine.nodes.length) continue;
            // Compute used width of line content
            var _taLast = _taLine.nodes[_taLine.nodes.length - 1]!;
            var _taUsed = (_taLast.x - blkLeft) + _taLast.text.length * CHAR_W * (_taLast.fontScale || 1);
            var _taFree = Math.max(0, _lineW - _taUsed);
            var _taShift = 0;
            if (_ta === 'center') _taShift = Math.floor(_taFree / 2);
            else if (_ta === 'right') _taShift = _taFree;
            else if (_ta === 'justify' && _tai < lines.length - 1 && _taFree > 0) {
              // Justify: distribute free space across word gaps (skip last line)
              var _jNodes = _taLine.nodes;
              var _jGaps = 0;
              for (var _ji = 0; _ji < _jNodes.length; _ji++) {
                var _jt = _jNodes[_ji].text;
                if (_jt.length > 0 && _jt[0] === ' ') _jGaps++;
              }
              if (_jGaps > 0) {
                var _jExtra = _taFree / _jGaps;
                var _jAccum = 0;
                lines[_tai] = { ..._taLine, nodes: _jNodes.map(function(n) {
                  if (n.text.length > 0 && n.text[0] === ' ') _jAccum += _jExtra;
                  return { ...n, x: n.x + Math.floor(_jAccum) };
                }) };
              }
            }
            if (_taShift > 0) {
              lines[_tai] = { ..._taLine, nodes: _taLine.nodes.map(function(n) { return { ...n, x: n.x + _taShift }; }) };
            }
          }
        }
        // Consume overlap lines from active floats
        var _newBlockLines = lines.length - _blockLineStart;
        _activeLeftFloatLines  = Math.max(0, _activeLeftFloatLines  - _newBlockLines);
        _activeRightFloatLines = Math.max(0, _activeRightFloatLines - _newBlockLines);
        if (_activeLeftFloatLines  === 0) _activeLeftFloatIndent  = 0;
        if (_activeRightFloatLines === 0) _activeRightFloatIndent = 0;
        // Enforce min-height: pad with blank space if content is shorter
        if (nd.minHeight && nd.minHeight > 0 && (y - yBeforeBlock) < nd.minHeight) {
          blank(nd.minHeight - (y - yBeforeBlock));
        }
        // Enforce aspect-ratio: derive height from block width when height is not explicit
        if (nd.aspectRatio && !nd.height) {
          var _arStr = nd.aspectRatio.replace('auto', '').trim();
          var _arParts = _arStr.split('/');
          var _arNumW = parseFloat(_arParts[0]) || 0;
          var _arNumH = parseFloat(_arParts[1] || '1') || 1;
          if (_arNumW > 0) {
            var _arEffW = (nd.boxWidth && nd.boxWidth > 0) ? nd.boxWidth : (maxX - xLeft);
            var _arTargH = Math.round(_arEffW * _arNumH / _arNumW);
            if (_arTargH > 0 && (y - yBeforeBlock) < _arTargH) {
              blank(_arTargH - (y - yBeforeBlock));
            }
          }
        }
        // Enforce max-height: clip lines that overflow (remove lines past the limit)
        if (nd.maxHeight && nd.maxHeight > 0) {
          var yMaxEnd = yBeforeBlock + nd.maxHeight;
          while (lines.length > 0 && lines[lines.length - 1].y >= yMaxEnd) {
            lines.pop();
          }
          if (y > yMaxEnd) y = yMaxEnd;
        }
        // Enforce overflow:hidden / scroll / auto — clip when explicit height set
        if (nd.height && nd.height > 0
            && (nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto')) {
          var yOvEnd = yBeforeBlock + nd.height;
          while (lines.length > 0 && lines[lines.length - 1].y >= yOvEnd) {
            lines.pop();
          }
          if (y > yOvEnd) y = yOvEnd;
        }
        // Annotate first generated line with box decoration (items 3.7, 4.2)
        // border-radius, border, box-shadow, opacity — painted before text in _drawContent
        // Also emit a tracking-only record for elements with elId (enables getBoundingClientRect)
        var _hasBoxDeco = nd.borderRadius || nd.borderWidth || nd.borderColor !== undefined
                       || nd.boxShadow || nd.opacity !== undefined;
        var _needsTracking = nd.elId && lines.length > _blockLineStart && !lines[_blockLineStart].boxDeco;
        if ((_hasBoxDeco || _needsTracking) && lines.length > _blockLineStart) {
          var _blkH = y - yBeforeBlock;
          var _blkW = (blkMaxX - blkLeft) || (maxX - xLeft);
          var _deco: BoxDecoration = { x: blkLeft, w: _blkW, h: _blkH };
          if (nd.borderRadius !== undefined) _deco.borderRadius = nd.borderRadius;
          if (nd.borderWidth)  _deco.borderWidth  = nd.borderWidth;
          if (nd.borderColor !== undefined) _deco.borderColor = nd.borderColor;
          if (nd.borderStyle)  _deco.borderStyle  = nd.borderStyle;
          if (nd.boxShadow)    _deco.boxShadow    = nd.boxShadow;
          if (bgColor !== undefined) _deco.bgColor = bgColor;
          if (bgGradient)      _deco.bgGradient   = bgGradient;
          if (nd.opacity !== undefined) _deco.opacity = nd.opacity;
          // overflow:hidden: pixel-clip children to this box in paint pass (item 3.10)
          if (nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto') {
            _deco.overflowHidden = true;
          }
          lines[_blockLineStart].boxDeco = _deco;
          // Attach element ID for layout rect writeback (getBoundingClientRect etc.)
          if (nd.elId) (lines[_blockLineStart] as any)._decoElId = nd.elId;
        }
      }
      // position:relative — shift generated lines by posTop/posLeft (item 2.3)
      // position:sticky — mark lines with stickyTop for viewport clamping in paint pass (item 2.4)
      if (_relStart >= 0 && _relStart < lines.length) {
        if (nd.position === 'sticky') {
          // Sticky: stay in normal flow but mark lines for paint-time viewport clamping
          var _stickyThresh = nd.posTop ?? 0;
          for (var _sti = _relStart; _sti < lines.length; _sti++) {
            lines[_sti].stickyTop = _stickyThresh;
          }
        } else {
          var _relDX = nd.posLeft ?? (nd.posRight !== undefined ? -(nd.posRight) : 0);
          var _relDY = nd.posTop  ?? (nd.posBottom !== undefined ? -(nd.posBottom) : 0);
          // CSS transform translation — visual shift without affecting flow (item 2.5)
          if (nd.transform && nd.transform !== 'none') {
            var _tfv = _parseCSSTranslate(nd.transform);
            _relDX += _tfv[0];
            _relDY += _tfv[1];
          }
          if (_relDX !== 0 || _relDY !== 0) {
            for (var _ri = _relStart; _ri < lines.length; _ri++) {
              lines[_ri].y += _relDY;
              if (_relDX !== 0) {
                lines[_ri] = { ...lines[_ri], nodes: lines[_ri].nodes.map(function(n) { return { ...n, x: n.x + _relDX }; }) };
              }
            }
          }
        }
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
        case 'textarea': {
          var _taCols = bp.cols || 40;
          ww = Math.min(_taCols * CHAR_W + 8, maxX - xLeft);
          wh = (bp.rows || 4) * LINE_H + 4;
          // For single-row search-style textareas, widen to ~60% of available space
          if ((bp.rows || 4) <= 2 && ww < (maxX - xLeft) * 0.6) {
            ww = Math.floor((maxX - xLeft) * 0.6);
            wh = Math.max(wh, LINE_H + 10);  // Ensure minimum height for search box
          }
          break;
        }
        case 'img':
          // Skip images with no source URL (invisible/tracking pixels)
          if (!bp.imgSrc && !bp.imgAlt) { continue; }
          ww = bp.imgNatW || (bp.imgSrc ? 120 : 40);
          wh = bp.imgNatH || (bp.imgSrc ? 60 : 20);
          var _imgMaxW = maxX - xLeft;
          if (_imgMaxW < 16) _imgMaxW = 16;  // prevent negative/tiny sizes
          if (ww > _imgMaxW) {
            var scale = _imgMaxW / ww;
            ww = Math.floor(ww * scale);
            wh = Math.floor(wh * scale);
          }
          if (ww < 1) ww = 1;
          if (wh < 1) wh = 1;
          break;
        default:
          ww = (bp.cols || 20) * CHAR_W + 8;
          wh = WIDGET_INPUT_H;
      }

      // CSS width/height override (if specified via stylesheet/inline CSS)
      if (bp.cssWidth && bp.cssWidth > 0) ww = Math.min(bp.cssWidth, maxX - xLeft);
      if (bp.cssHeight && bp.cssHeight > 0) {
        // For buttons, cap CSS height to prevent oversized rendering
        if (bp.kind === 'submit' || bp.kind === 'reset' || bp.kind === 'button') {
          wh = Math.min(bp.cssHeight, WIDGET_BTN_H + 16);
        } else {
          wh = bp.cssHeight;
        }
      }
      // Cap tall narrow images (decorative icons) to reduce layout waste
      if (bp.kind === 'img' && wh > 30 && ww < 40) wh = 30;

      if (bp.kind !== 'checkbox' && bp.kind !== 'radio') {
        if (y > CONTENT_PAD) { blank(4); }
      }

      // Widget centering: respect text-align or margin:auto
      var _wpx = xLeft;
      if (nd.centerBlock && ww < (maxX - xLeft)) {
        _wpx = xLeft + Math.floor((maxX - xLeft - ww) / 2);
      } else if (nd.textAlign === 'center' && ww < (maxX - xLeft)) {
        _wpx = xLeft + Math.floor((maxX - xLeft - ww) / 2);
      } else if (nd.textAlign === 'right' && ww < (maxX - xLeft)) {
        _wpx = maxX - ww;
      } else if ((bp.kind === 'textarea' || bp.kind === 'submit' || bp.kind === 'reset' || bp.kind === 'button') && ww < (maxX - xLeft) * 0.8) {
        // Heuristic: center form widgets (search boxes, buttons) that are
        // significantly narrower than the container
        _wpx = xLeft + Math.floor((maxX - xLeft - ww) / 2);
      } else if (bp.kind === 'img' && ww < 100 && xLeft < 20 && ww < (maxX - xLeft) * 0.3) {
        // Center small images that are at the outermost container level
        _wpx = xLeft + Math.floor((maxX - xLeft - ww) / 2);
      }

      // ── Button grouping: place consecutive buttons side-by-side ──────────
      if ((bp.kind === 'submit' || bp.kind === 'reset' || bp.kind === 'button') && widgets.length > 0) {
        var prevW = widgets[widgets.length - 1];
        // After a button: y advances by ph+4 (line push), then blank(4) post-gap,
        // then blank(4) pre-gap of current = total gap of ph+12.
        var _btnGap = y - prevW.py - prevW.ph;
        if (prevW && (prevW.kind === 'submit' || prevW.kind === 'reset' || prevW.kind === 'button') && _btnGap >= 4 && _btnGap <= 16) {
          // Previous widget is a button placed recently; merge into same row
          var totalW    = prevW.pw + 8 + ww; // gap of 8px
          if (totalW < (maxX - xLeft)) {
            // Revert y to the previous button's position
            y = prevW.py;
            // Center the whole button group
            var groupX = xLeft + Math.floor((maxX - xLeft - totalW) / 2);
            prevW.px = groupX;
            _wpx = groupX + prevW.pw + 8;
            // Remove the last line entry (from the previous button)
            if (lines.length > 0) {
              lines.pop();
            }
          }
        }
      }

      var pw: PositionedWidget = {
        ...bp,
        id: ++_widgetCounter,
        px: _wpx, py: y, pw: ww, ph: wh,
        curValue:   bp.value   || '',
        curChecked: bp.checked || false,
        curSelIdx:  bp.selIdx  || 0,
        cursorPos:  (bp.value || '').length,
        imgData:    bp.preloadedImage?.data ?? null,
        imgLoaded:  bp.preloadedImage != null,
      };
      widgets.push(pw);

      // Images use tighter spacing (fill covers full area)
      var _wPad = bp.kind === 'img' ? 1 : 4;
      lines.push({ y, nodes: [], lineH: wh + _wPad });
      y += wh + _wPad;
      // Widgets are visible content — reset blank tracker, but only for non-hidden types
      if (bp.kind !== 'hidden') _consecBlank = 0;

      if (bp.kind !== 'checkbox' && bp.kind !== 'radio') {
        blank(bp.kind === 'img' ? 1 : 4);
      }
      continue;
    }
  }

  // ── Out-of-flow (position:absolute/fixed) node rendering ─────────────────
  // Sort by zIndex so higher z-index elements render on top (item 398)
  oofNodes.sort(function(a, b) { return (a.zIndex ?? 0) - (b.zIndex ?? 0); });
  for (var oi = 0; oi < oofNodes.length; oi++) {
    var oof      = oofNodes[oi];
    var oofW     = oof.boxWidth ?? (maxX - xLeft);
    // right-anchor: position from right edge of containing block
    var oofX     = oof.posLeft   !== undefined ? (xLeft + oof.posLeft)
                 : oof.posRight  !== undefined ? Math.max(xLeft, maxX - oofW - oof.posRight)
                 : xLeft;
    // bottom-anchor: position from bottom of current content (approximation)
    var oofY     = oof.posTop    !== undefined ? oof.posTop
                 : oof.posBottom !== undefined ? Math.max(0, y - (oof.height ?? nodeLineH(oof)) - oof.posBottom)
                 : y;  // no top/bottom: use static position (current flow y)
    // Apply CSS transform translate offset (visual shift, does not affect layout flow)
    if (oof.transform) {
      var _tx = _parseCSSTranslate(oof.transform);
      oofX += _tx[0];
      oofY += _tx[1];
    }
    var oofMaxX  = Math.min(oofX + oofW, maxX);
    var oofLh    = nodeLineH(oof);
    var oofSpans = transformSpans(oof.spans, oof.textTransform);
    // OOF elements may have children (e.g., a fixed-position footer with links)
    var oofLines: RenderedLine[];
    var oofWidgets: PositionedWidget[] = [];
    if (oof.children && oof.children.length > 0) {
      var _oofResult = _layoutNodesImpl(oof.children, [], oofW);
      oofLines = _oofResult.lines;
      oofWidgets = _oofResult.widgets;
    } else {
      oofLines = flowSpans(oofSpans, oofX, oofMaxX, oofLh, CLR_BODY,
                           oof.bgColor !== undefined ? { bgColor: oof.bgColor } : undefined);
    }
    // Stamp OOF lines at the computed position
    var _oofFirstY = oofLines.length > 0 ? oofLines[0].y : 0;
    for (var ol = 0; ol < oofLines.length; ol++) {
      var oofLine = oofLines[ol];
      var _oofRelY = oofLine.y - _oofFirstY;
      // For children-based layout, shift x positions to oofX
      var oofNodes2 = (oof.children && oof.children.length > 0)
        ? oofLine.nodes.map(function(n) { return { ...n, x: n.x + oofX - CONTENT_PAD }; })
        : oofLine.nodes;
      var rendLine: { y: number; nodes: typeof oofLine.nodes; lineH: number; fixedViewportY?: number; fixedViewportX?: number } =
        { y: oofY + _oofRelY, nodes: oofNodes2, lineH: oofLine.lineH };
      // position:fixed — mark lines so paint pass keeps them viewport-anchored regardless of scroll
      if (oof.position === 'fixed') {
        rendLine.fixedViewportY = oof.posTop  ?? 0;
        rendLine.fixedViewportX = oof.posLeft ?? 0;
      }
      lines.push(rendLine);
    }
    // Shift OOF child widgets to absolute position
    for (var owi = 0; owi < oofWidgets.length; owi++) {
      oofWidgets[owi].px += oofX - CONTENT_PAD;
      oofWidgets[owi].py += oofY - _oofFirstY;
      widgets.push(oofWidgets[owi]);
    }
  }

  if (_lpId) layoutProfiler.endLayout(_lpId);

  // Gap compression is done in _layoutPage (index.ts) on the final assembled result
  // rather than here, because _layoutNodesImpl is called recursively for flex children
  // and the top-level call may not see all widgets.

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

