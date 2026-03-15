import type { PixelColor } from '../../core/sdk.js';
import type { RenderNode, InlineSpan, RenderedSpan, RenderedLine, WidgetBlueprint, PositionedWidget, LayoutResult, BoxDecoration } from './types.js';
import {
  CHAR_W, CHAR_H, LINE_H, CONTENT_PAD,
  WIDGET_INPUT_H, WIDGET_BTN_H, WIDGET_CHECK_SZ, WIDGET_SELECT_H,
  CLR_BODY, CLR_LINK, CLR_BOLD, CLR_ITALIC, CLR_CODE, CLR_CODE_BG,
  CLR_DEL, CLR_MARK_TXT, CLR_PRE_TXT, CLR_H1, CLR_H2, CLR_H3,
  CLR_QUOTE_TXT, CLR_HR,
} from './constants.js';
import { getLayoutCache, setLayoutCache, layoutFingerprint, getBlockLayoutCache, setBlockLayoutCache, blockFingerprint, type BlockLayoutCache } from './cache.js';
import { getViewport } from './css.js';
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
           lineClamp?: number;
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
  // white-space: nowrap / pre prevents word wrapping (all content on one line)
  var _wsMode2 = opts?.whiteSpace || 'normal';
  var _nowrap = _wsMode2 === 'nowrap' || _wsMode2 === 'pre';
  // white-space: pre / pre-wrap — preserve consecutive spaces (don't collapse to single space)
  var _preserveSpaces = _wsMode2 === 'pre' || _wsMode2 === 'pre-wrap';
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
      if (sp.underlineColor !== undefined) rsp.underlineColor = sp.underlineColor;
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
        if (_preserveSpaces) {
          // pre / pre-wrap: preserve all spaces literally
          for (var _pci = 0; _pci < part.length; ) {
            // Collect runs of non-space characters as words
            if (part[_pci] === ' ') {
              // Emit each space as a visible character
              addWord(' ', sp);
              _pci++;
            } else {
              var _wEnd = _pci;
              while (_wEnd < part.length && part[_wEnd] !== ' ') _wEnd++;
              addWord(part.slice(_pci, _wEnd), sp);
              _pci = _wEnd;
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
  }
  if (curLine.length > 0) commitLine();

  // text-overflow: ellipsis (item 465) — truncate to fit + "..." (R14: also handle single-line)
  if (opts?.ellipsis) {
    var _ellMaxW = maxX - xLeft;
    var _needEllipsis = lines.length > 1;
    // Single line overflow: check if content exceeds available width
    if (!_needEllipsis && lines.length === 1) {
      var _lineW = 0;
      for (var _ewi = 0; _ewi < lines[0].nodes.length; _ewi++) {
        var _en2 = lines[0].nodes[_ewi];
        _lineW = Math.max(_lineW, _en2.x + _en2.text.length * CHAR_W);
      }
      if (_lineW > xLeft + _ellMaxW) _needEllipsis = true;
    }
    if (_needEllipsis) {
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
  }

  // -webkit-line-clamp: truncate to N lines, append "..." on the last visible line
  if (opts?.lineClamp && opts.lineClamp > 0 && lines.length > opts.lineClamp) {
    lines = lines.slice(0, opts.lineClamp);
    var _clLast = lines[lines.length - 1]!;
    var _clMaxC = Math.max(1, Math.floor((maxX - xLeft) / CHAR_W));
    var _clTotal = 0;
    var _clNodes: RenderedSpan[] = [];
    for (var _cli = 0; _cli < _clLast.nodes.length; _cli++) {
      var _cln = _clLast.nodes[_cli]!;
      var _clRem = _clMaxC - 3 - _clTotal;
      if (_clRem <= 0) break;
      var _clTrim = _cln.text.slice(0, _clRem);
      _clNodes.push({ ..._cln, text: _clTrim });
      _clTotal += _clTrim.length;
    }
    if (_clNodes.length > 0) {
      var _clLastN = _clNodes[_clNodes.length - 1]!;
      var _clDotX  = _clLastN.x + _clLastN.text.length * CHAR_W;
      _clNodes.push({ x: _clDotX, text: '...', color: _clLastN.color });
    }
    lines[lines.length - 1] = { ..._clLast, nodes: _clNodes };
  }

  return lines;
}

// ── Roman numeral helper ──────────────────────────────────────────────────────
function _toRomanLower(n: number): string {
  if (n <= 0 || n > 3999) return String(n);
  var _rv = [['', 'i','ii','iii','iv','v','vi','vii','viii','ix'],
             ['', 'x','xx','xxx','xl','l','lx','lxx','lxxx','xc'],
             ['', 'c','cc','ccc','cd','d','dc','dcc','dccc','cm'],
             ['', 'm','mm','mmm']];
  return (_rv[3][Math.floor(n/1000)] || '') + (_rv[2][Math.floor(n%1000/100)] || '') +
         (_rv[1][Math.floor(n%100/10)] || '') + (_rv[0][n%10] || '');
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
  var _maxConsecBlank = 60; // Allow CSS margins/padding to create reasonable spacing

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
    // CSS2.1 §8.3.1: adjacent margin collapsing (R17)
    var a = lastBottomMargin, b = newTop;
    lastBottomMargin = 0;
    if (a >= 0 && b >= 0) return Math.max(a, b);       // both positive → max
    if (a < 0 && b < 0) return Math.min(a, b);         // both negative → most negative
    return a + b;                                        // mixed → sum
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
      var liIdx    = (nd as RenderNode & { listItemIndex?: number }).listItemIndex || 1;
      var bullets  = ['\u2022', '\u25E6', '\u25AA'];
      var bullet   = '';
      if (lstType === 'decimal') { bullet = String(liIdx) + '. '; }
      else if (lstType === 'lower-alpha' || lstType === 'lower-latin') { bullet = String.fromCharCode(96 + ((liIdx - 1) % 26) + 1) + '. '; }
      else if (lstType === 'upper-alpha' || lstType === 'upper-latin') { bullet = String.fromCharCode(64 + ((liIdx - 1) % 26) + 1) + '. '; }
      else if (lstType === 'lower-roman') { bullet = _toRomanLower(liIdx) + '. '; }
      else if (lstType === 'upper-roman') { bullet = _toRomanLower(liIdx).toUpperCase() + '. '; }
      else if (lstType === 'lower-greek') { bullet = String.fromCharCode(0x03B1 + ((liIdx - 1) % 24)) + '. '; }
      else if (lstType === 'disc') { bullet = '\u2022 '; }
      else if (lstType === 'circle') { bullet = '\u25E6 '; }
      else if (lstType === 'square') { bullet = '\u25AA '; }
      else if (lstType === 'none') { bullet = ''; }
      else { bullet = (bullets[Math.min(depth - 1, 2)] || '\u2022') + ' '; }
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
        },
        function(ch: RenderNode[], cw: number) { return _layoutNodesImpl(ch, [], cw); }
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
      var gap       = nd.gap ?? 0;
      var _fxYBeforeBox = y; // R21: track flex container start for boxDeco
      var _fxLinesStart = lines.length; // R21: first line index for boxDeco
      // R21: padding-top for flex containers
      if (nd.paddingTop && nd.paddingTop > 0) {
        lines.push({ y, nodes: [], lineH: nd.paddingTop }); y += nd.paddingTop;
      }
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
          // flex-basis: >= 0 means explicit value; < 0 or undefined means auto (use content height)
          var _fcb = fcc.flexBasis;
          var fccBaseH = (_fcb !== undefined && _fcb >= 0) ? _fcb : fccH;
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
            lines.push({ y: fcCurY + _clRelY2, nodes: fccShifted, lineH: fccLine.lineH || LINE_H, bgColor: fccLine.bgColor, bgGradient: fccLine.bgGradient, preBg: fccLine.preBg, boxDeco: fccLine.boxDeco });
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
        // R21: padding-bottom for flex container (column)
        if (nd.paddingBottom && nd.paddingBottom > 0) {
          lines.push({ y, nodes: [], lineH: nd.paddingBottom }); y += nd.paddingBottom;
        }
        // R21: min-height enforcement for flex container
        if (nd.minHeight && nd.minHeight > 0 && (y - _fxYBeforeBox) < nd.minHeight) {
          var _fxMinPad = nd.minHeight - (y - _fxYBeforeBox);
          // Cap empty flex containers (no visible children) to prevent huge invisible spacers
          var _fxHasVisContent = false;
          for (var _fxci = _fxLinesStart; _fxci < lines.length; _fxci++) {
            if (lines[_fxci].nodes.length > 0) { _fxHasVisContent = true; break; }
          }
          if (!_fxHasVisContent && !nd.bgColor && !nd.bgGradient && _fxMinPad > 40) _fxMinPad = 40;
          lines.push({ y, nodes: [], lineH: _fxMinPad }); y += _fxMinPad;
        }
        // R21: boxDeco — render background, border, shadow, opacity on flex containers
        if (lines.length > _fxLinesStart) {
          var _fxH2 = y - _fxYBeforeBox;
          var _fxW2 = (nd.boxWidth ? nd.boxWidth : (maxX - xLeft));
          var _fxDeco2: BoxDecoration = { x: xLeft, w: _fxW2, h: _fxH2 };
          if (nd.borderRadius !== undefined) _fxDeco2.borderRadius = nd.borderRadius;
          if (nd.borderWidth) _fxDeco2.borderWidth = nd.borderWidth;
          if (nd.borderColor !== undefined) _fxDeco2.borderColor = nd.borderColor;
          if (nd.borderStyle) _fxDeco2.borderStyle = nd.borderStyle;
          if (nd.borderTopWidth) _fxDeco2.borderTopWidth = nd.borderTopWidth;
          if (nd.borderRightWidth) _fxDeco2.borderRightWidth = nd.borderRightWidth;
          if (nd.borderBottomWidth) _fxDeco2.borderBottomWidth = nd.borderBottomWidth;
          if (nd.borderLeftWidth) _fxDeco2.borderLeftWidth = nd.borderLeftWidth;
          if (nd.borderTopColor !== undefined) _fxDeco2.borderTopColor = nd.borderTopColor;
          if (nd.borderRightColor !== undefined) _fxDeco2.borderRightColor = nd.borderRightColor;
          if (nd.borderBottomColor !== undefined) _fxDeco2.borderBottomColor = nd.borderBottomColor;
          if (nd.borderLeftColor !== undefined) _fxDeco2.borderLeftColor = nd.borderLeftColor;
          if (nd.boxShadow) _fxDeco2.boxShadow = nd.boxShadow;
          if (nd.bgColor !== undefined) _fxDeco2.bgColor = nd.bgColor;
          if (nd.bgGradient) _fxDeco2.bgGradient = nd.bgGradient;
          if (nd.opacity !== undefined) _fxDeco2.opacity = nd.opacity;
          if (nd.textShadow) _fxDeco2.textShadow = nd.textShadow;
          if (nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto') _fxDeco2.overflowHidden = true;
          if (nd.elId) (lines[_fxLinesStart] as any)._decoElId = nd.elId;
          lines[_fxLinesStart].boxDeco = _fxDeco2;
        }
        lastBottomMargin = nd.marginBottom || 0;
        continue;
      }

      // ── flex-direction: row / row-reverse (default) ─────────────────────────
      if (fDir === 'row-reverse') fSorted.reverse();

      var fxUsedGap  = gap * Math.max(0, fSorted.length - 1);
      var fxFreeInit = fxAvail - fxUsedGap;
      // Two-pass flex algorithm: compute hypothetical main sizes
      // flex-basis: >= 0 means explicit value; < 0 or undefined means auto (use boxWidth or content width)
      var fBaseW: number[] = [];
      for (var fi = 0; fi < fSorted.length; fi++) {
        var _fb = fSorted[fi].flexBasis;
        var _fbExplicit = _fb !== undefined && _fb >= 0;
        var _bw = _fbExplicit ? _fb : (fSorted[fi].boxWidth ?? 0);
        // flex-basis: auto — when no explicit basis or width, measure content intrinsic width
        if (!_fbExplicit && _bw === 0 && fSorted[fi].spans && fSorted[fi].spans.length > 0) {
          var _cw0 = 0;
          for (var _cwi = 0; _cwi < fSorted[fi].spans.length; _cwi++) {
            _cw0 += fSorted[fi].spans[_cwi].text.length * CHAR_W * (fSorted[fi].spans[_cwi].fontScale || 1);
          }
          _bw = Math.ceil(_cw0);
        }
        fBaseW.push(_bw);
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
            // text-align shifting for inline-only flex children (R17)
            var _fcTA = fc.textAlign;
            if (_fcTA && _fcTA !== 'left' && cLines.length > 0) {
              for (var _fai = 0; _fai < cLines.length; _fai++) {
                var _faLine = cLines[_fai];
                if (!_faLine.nodes.length) continue;
                var _faLast = _faLine.nodes[_faLine.nodes.length - 1];
                var _faUsed = _faLast.x + _faLast.text.length * CHAR_W * (_faLast.fontScale || 1);
                var _faFree = Math.max(0, cw - _faUsed);
                var _faShift = _fcTA === 'center' ? Math.floor(_faFree / 2) : (_fcTA === 'right' ? _faFree : 0);
                if (_faShift > 0) {
                  cLines[_fai] = { ..._faLine, nodes: _faLine.nodes.map(function(n) { return { ...n, x: n.x + _faShift }; }) };
                }
              }
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
          var fcH2 = fc2.cl.length > 0
            ? (fc2.cl[fc2.cl.length - 1].y + (fc2.cl[fc2.cl.length - 1].lineH || LINE_H) - fc2.cl[0].y)
            : 0;
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
      // R21: padding-bottom for flex container (row)
      if (nd.paddingBottom && nd.paddingBottom > 0) {
        lines.push({ y, nodes: [], lineH: nd.paddingBottom }); y += nd.paddingBottom;
      }
      // R21: min-height enforcement for flex container
      if (nd.minHeight && nd.minHeight > 0 && (y - _fxYBeforeBox) < nd.minHeight) {
        var _fxMinPad3 = nd.minHeight - (y - _fxYBeforeBox);
        // Cap empty flex containers to prevent huge invisible spacers
        var _fxHasVisContent3 = false;
        for (var _fxci3 = _fxLinesStart; _fxci3 < lines.length; _fxci3++) {
          if (lines[_fxci3].nodes.length > 0) { _fxHasVisContent3 = true; break; }
        }
        if (!_fxHasVisContent3 && !nd.bgColor && !nd.bgGradient && _fxMinPad3 > 40) _fxMinPad3 = 40;
        lines.push({ y, nodes: [], lineH: _fxMinPad3 }); y += _fxMinPad3;
      }
      // R21: boxDeco — render background, border, shadow, opacity on flex containers
      if (lines.length > _fxLinesStart) {
        var _fxH3 = y - _fxYBeforeBox;
        var _fxW3 = (nd.boxWidth ? nd.boxWidth : (maxX - xLeft));
        var _fxDeco3: BoxDecoration = { x: xLeft, w: _fxW3, h: _fxH3 };
        if (nd.borderRadius !== undefined) _fxDeco3.borderRadius = nd.borderRadius;
        if (nd.borderWidth) _fxDeco3.borderWidth = nd.borderWidth;
        if (nd.borderColor !== undefined) _fxDeco3.borderColor = nd.borderColor;
        if (nd.borderStyle) _fxDeco3.borderStyle = nd.borderStyle;
        if (nd.borderTopWidth) _fxDeco3.borderTopWidth = nd.borderTopWidth;
        if (nd.borderRightWidth) _fxDeco3.borderRightWidth = nd.borderRightWidth;
        if (nd.borderBottomWidth) _fxDeco3.borderBottomWidth = nd.borderBottomWidth;
        if (nd.borderLeftWidth) _fxDeco3.borderLeftWidth = nd.borderLeftWidth;
        if (nd.borderTopColor !== undefined) _fxDeco3.borderTopColor = nd.borderTopColor;
        if (nd.borderRightColor !== undefined) _fxDeco3.borderRightColor = nd.borderRightColor;
        if (nd.borderBottomColor !== undefined) _fxDeco3.borderBottomColor = nd.borderBottomColor;
        if (nd.borderLeftColor !== undefined) _fxDeco3.borderLeftColor = nd.borderLeftColor;
        if (nd.boxShadow) _fxDeco3.boxShadow = nd.boxShadow;
        if (nd.bgColor !== undefined) _fxDeco3.bgColor = nd.bgColor;
        if (nd.bgGradient) _fxDeco3.bgGradient = nd.bgGradient;
        if (nd.opacity !== undefined) _fxDeco3.opacity = nd.opacity;
        if (nd.textShadow) _fxDeco3.textShadow = nd.textShadow;
        if (nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto') _fxDeco3.overflowHidden = true;
        if (nd.elId) (lines[_fxLinesStart] as any)._decoElId = nd.elId;
        lines[_fxLinesStart].boxDeco = _fxDeco3;
      }
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
          && !nd.borderTopWidth && !nd.borderBottomWidth && !nd.borderLeftWidth && !nd.borderRightWidth
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
      // Negative margin: pull content upward (overlap previous content)
      else if (preMarginRaw < 0) { y += preMarginRaw; }

      // CSS clear — advance past active floats on the cleared side(s) (R9)
      if (nd.clear) {
        if ((nd.clear === 'left' || nd.clear === 'both') && _activeLeftFloatLines > 0) {
          blank(_activeLeftFloatLines * LINE_H);
          _activeLeftFloatLines = 0; _activeLeftFloatIndent = 0;
        }
        if ((nd.clear === 'right' || nd.clear === 'both') && _activeRightFloatLines > 0) {
          blank(_activeRightFloatLines * LINE_H);
          _activeRightFloatLines = 0; _activeRightFloatIndent = 0;
        }
      }

      var bgColor   = nd.bgColor;
      var bgGradient = nd.bgGradient;
      // Resolve percentage width against container (item 2.1)
      var _effectBoxW = nd.boxWidth || 0;
      if (nd.widthPct && nd.widthPct > 0) {
        _effectBoxW = Math.floor((contentW - CONTENT_PAD * 2) * nd.widthPct / 100);
      }
      // Intrinsic sizing keywords: fit-content / min-content / max-content
      if (!_effectBoxW && nd.widthKeyword) {
        var _intrW = 0;
        for (var _iwi = 0; _iwi < nd.spans.length; _iwi++) {
          _intrW += nd.spans[_iwi].text.length * CHAR_W * (nd.spans[_iwi].fontScale || 1);
        }
        _intrW = Math.ceil(_intrW) + (nd.paddingLeft || 0) + (nd.paddingRight || 0);
        if (nd.widthKeyword === 'fit-content') {
          _effectBoxW = Math.min(_intrW, contentW - CONTENT_PAD * 2);
        } else if (nd.widthKeyword === 'max-content') {
          _effectBoxW = _intrW;
        } else if (nd.widthKeyword === 'min-content') {
          // min-content: narrowest word
          var _minW = CHAR_W;
          for (var _mwi = 0; _mwi < nd.spans.length; _mwi++) {
            var _words = nd.spans[_mwi].text.split(' ');
            for (var _mwj = 0; _mwj < _words.length; _mwj++) {
              var _ww = _words[_mwj].length * CHAR_W * (nd.spans[_mwi].fontScale || 1);
              if (_ww > _minW) _minW = _ww;
            }
          }
          _effectBoxW = Math.ceil(_minW) + (nd.paddingLeft || 0) + (nd.paddingRight || 0);
        }
      }
      // Resolve percentage height against viewport (containing block approximation)
      if (!nd.height && nd.heightPct && nd.heightPct > 0) {
        nd.height = Math.floor(getViewport().h * nd.heightPct / 100);
      }
      // Clamp to min-width / max-width
      // min-width applies even to auto-width blocks: compute auto width from container
      if (nd.minWidth && nd.minWidth > 0) {
        var _autoW = _effectBoxW > 0 ? _effectBoxW : (maxX - xLeft);
        if (_autoW < nd.minWidth) _effectBoxW = nd.minWidth;
      }
      if (nd.maxWidth && nd.maxWidth > 0) {
        if (_effectBoxW > 0) { _effectBoxW = Math.min(_effectBoxW, nd.maxWidth); }
        else {
          // auto width: only constrain if max-width is narrower than available space
          var _avail = maxX - xLeft;
          if (nd.maxWidth < _avail) _effectBoxW = nd.maxWidth;
        }
      }
      // box-sizing: border-box — specified width includes padding + border
      if (nd.boxSizing === 'border-box' && _effectBoxW > 0) {
        var _bbPad = (nd.paddingLeft || 0) + (nd.paddingRight || 0) + (nd.borderWidth || 0) * 2;
        _effectBoxW = Math.max(0, _effectBoxW - _bbPad);
      }
      var blkLeft   = xLeft + (nd.paddingLeft || 0) + (nd.marginLeft || 0);
      var blkRight  = (nd.paddingRight || 0) + (nd.marginRight || 0);
      var blkMaxX   = (_effectBoxW ? Math.min(maxX, xLeft + (nd.marginLeft || 0) + _effectBoxW) : maxX) - blkRight;
      // margin: auto centering — shift block inward when explicit width set (item 2.2)
      // R19: use available width (maxX - xLeft) instead of contentW to avoid CONTENT_PAD offset error
      if (nd.centerBlock && _effectBoxW > 0) {
        var _availCenter = maxX - xLeft;
        var _centerOff = Math.max(0, Math.floor((_availCenter - _effectBoxW) / 2));
        blkLeft = xLeft + _centerOff;
        blkMaxX  = blkLeft + _effectBoxW - blkRight;
      }
      // Track lines start for position:relative offset (item 2.3), position:sticky (item 2.4), and CSS transform (item 2.5)
      var _relStart  = (nd.position === 'relative' || nd.position === 'sticky' || (nd.transform && nd.transform !== 'none')) ? lines.length : -1;
      var lh        = nodeLineH(nd);
      var ndSpans   = transformSpans(nd.spans, nd.textTransform);

      // Build flow opts including bgImage (item 386) and word-break (item 421)
      function makeFlowOpts(): typeof undefined | { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean; letterSpacing?: number; wordSpacing?: number; whiteSpace?: string; textIndent?: number; lineClamp?: number } {
        var o: { bgColor?: number; bgGradient?: string; bgImageUrl?: string; wordBreak?: string; overflowWrap?: string; ellipsis?: boolean; letterSpacing?: number; wordSpacing?: number; whiteSpace?: string; textIndent?: number; lineClamp?: number } = {};
        var any = false;
        if (bgColor !== undefined)  { o.bgColor = bgColor; any = true; }
        if (bgGradient)             { o.bgGradient = bgGradient; any = true; }
        if (nd.bgImage)             { o.bgImageUrl = nd.bgImage; any = true; }
        if (nd.wordBreak)           { o.wordBreak = nd.wordBreak; any = true; }
        if (nd.overflowWrap)        { o.overflowWrap = nd.overflowWrap; any = true; }
        if (nd.textOverflow === 'ellipsis') { o.ellipsis = true; any = true; }  // item 465
        if (nd.letterSpacing)       { o.letterSpacing = nd.letterSpacing; any = true; }
        if (nd.wordSpacing)         { o.wordSpacing = nd.wordSpacing; any = true; }
        if (nd.whiteSpace && nd.whiteSpace !== 'normal') { o.whiteSpace = nd.whiteSpace; any = true; }
        if (nd.textIndent)          { o.textIndent = nd.textIndent; any = true; }
        if (nd.lineClamp)           { o.lineClamp = nd.lineClamp; any = true; }
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
        // ── Multi-column layout (CSS column-count / column-width) ──────────
        var _colCount = nd.columnCount || 0;
        var _colWidth = nd.columnWidth || 0;
        var _colGapPx = nd.columnGap ?? 16; // default 1em ≈ 16px
        var _availW   = blkMaxX - blkLeft;
        if (!_colCount && _colWidth > 0) {
          // Derive column count from column-width hint
          _colCount = Math.max(1, Math.floor((_availW + _colGapPx) / (_colWidth + _colGapPx)));
        }
        if (_colCount > 1) {
          // Lay out into N columns
          var _colW = Math.floor((_availW - (_colCount - 1) * _colGapPx) / _colCount);
          // Flow all spans in full width first to get total lines
          var _mcAllLines = flowSpans(ndSpans, 0, _colW, lh, CLR_BODY, _baseFlowOpts);
          // Distribute lines across columns
          var _linesPerCol = Math.ceil(_mcAllLines.length / _colCount);
          if (_linesPerCol < 1) _linesPerCol = 1;
          var _mcY0 = y;
          var _mcMaxH = 0;
          for (var _mci = 0; _mci < _colCount; _mci++) {
            var _mcStart = _mci * _linesPerCol;
            var _mcEnd   = Math.min(_mcStart + _linesPerCol, _mcAllLines.length);
            if (_mcStart >= _mcAllLines.length) break;
            var _mcXOff  = blkLeft + _mci * (_colW + _colGapPx);
            var _mcColY  = _mcY0;
            for (var _mcj = _mcStart; _mcj < _mcEnd; _mcj++) {
              var _mcLine = _mcAllLines[_mcj];
              var _mcShifted = _mcLine.nodes.map(function(n) { return { ...n, x: n.x + _mcXOff }; });
              lines.push({ y: _mcColY, nodes: _mcShifted, lineH: _mcLine.lineH,
                           bgColor: _mcLine.bgColor, bgGradient: _mcLine.bgGradient,
                           preBg: _mcLine.preBg, boxDeco: _mcLine.boxDeco });
              _mcColY += _mcLine.lineH || lh;
            }
            var _mcColH = _mcColY - _mcY0;
            if (_mcColH > _mcMaxH) _mcMaxH = _mcColH;
          }
          y = _mcY0 + _mcMaxH;
        } else {
          // Block with children but no text spans — recursively lay out children
          if (ndSpans.length === 0 && nd.children && nd.children.length > 0) {
            var _blkCW = blkMaxX - blkLeft + CONTENT_PAD * 2;
            var _childResult = _layoutNodesImpl(nd.children, [], _blkCW);
            // Stamp child lines into parent coordinate space
            var _blkFirstY = _childResult.lines.length > 0 ? _childResult.lines[0].y : CONTENT_PAD;
            for (var _cri = 0; _cri < _childResult.lines.length; _cri++) {
              var _crl = _childResult.lines[_cri];
              var _crRelY = _crl.y - _blkFirstY;
              var _crShifted = _crl.nodes.map(function(n) { return { ...n, x: n.x + blkLeft - CONTENT_PAD }; });
              lines.push({ y: y + _crRelY, nodes: _crShifted, lineH: _crl.lineH, bgColor: _crl.bgColor, bgGradient: _crl.bgGradient, preBg: _crl.preBg, boxDeco: _crl.boxDeco });
            }
            var _blkLastLine = _childResult.lines.length > 0 ? _childResult.lines[_childResult.lines.length - 1] : null;
            var _blkChildH = _blkLastLine ? (_blkLastLine.y + (_blkLastLine.lineH || LINE_H) - _blkFirstY) : 0;
            y += _blkChildH;
            // Stamp child widgets
            for (var _cwi = 0; _cwi < _childResult.widgets.length; _cwi++) {
              var _cww = _childResult.widgets[_cwi];
              _cww.px += blkLeft - CONTENT_PAD;
              _cww.py += y - _blkChildH - _blkFirstY;
              widgets.push(_cww);
            }
          } else {
            commit(flowSpans(ndSpans, blkLeft, blkMaxX, lh, CLR_BODY, _combinedOpts));
          }
        }
        // Apply padding-bottom after block content
        if (nd.paddingBottom && nd.paddingBottom > 0) blank(nd.paddingBottom);
        // text-align: shift committed line nodes for center / right / justify
        var _ta = nd.textAlign;
        // Removed auto-centering heuristic — CSS text-align handles alignment
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
        // Cap empty blocks (no text produced) — prevent huge invisible spacers (e.g., Google's centering divs)
        var _blockHasContent = lines.length > _blockLineStart;
        var _blockCapH = 40; // max height for empty blocks with no visual content
        if (nd.minHeight && nd.minHeight > 0 && (y - yBeforeBlock) < nd.minHeight) {
          var _effMinH = nd.minHeight;
          if (!_blockHasContent && !nd.bgColor && !nd.bgGradient && !nd.bgImage && _effMinH > _blockCapH) _effMinH = _blockCapH;
          blank(_effMinH - (y - yBeforeBlock));
        }
        // Enforce explicit CSS height: pad with blank space if content is shorter (R22)
        if (nd.height && nd.height > 0 && (y - yBeforeBlock) < nd.height) {
          var _effH = nd.height;
          if (!_blockHasContent && !nd.bgColor && !nd.bgGradient && !nd.bgImage && _effH > _blockCapH) _effH = _blockCapH;
          blank(_effH - (y - yBeforeBlock));
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
        // Enforce overflow:hidden / scroll / auto — clip when explicit height or max-height set (R14)
        if ((nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto')) {
          var _ovH = nd.height && nd.height > 0 ? nd.height : (nd.maxHeight && nd.maxHeight > 0 ? nd.maxHeight : 0);
          if (_ovH > 0) {
            var yOvEnd = yBeforeBlock + _ovH;
            while (lines.length > 0 && lines[lines.length - 1].y >= yOvEnd) {
              lines.pop();
            }
            if (y > yOvEnd) y = yOvEnd;
          }
        }
        // Annotate first generated line with box decoration (items 3.7, 4.2)
        // border-radius, border, box-shadow, opacity — painted before text in _drawContent
        // Also emit a tracking-only record for elements with elId (enables getBoundingClientRect)
        var _hasBoxDeco = nd.borderRadius || nd.borderWidth || nd.borderColor !== undefined
                       || nd.boxShadow || nd.opacity !== undefined || nd.textShadow
                       || nd.outlineWidth
                       || nd.borderTopWidth || nd.borderRightWidth || nd.borderBottomWidth || nd.borderLeftWidth
                       || nd.overflow === 'hidden' || nd.overflow === 'scroll' || nd.overflow === 'auto'
                       || (bgColor !== undefined && bgColor !== 0xFFFFFFFF)
                       || !!bgGradient;
        var _needsTracking = nd.elId && lines.length > _blockLineStart && !lines[_blockLineStart].boxDeco;
        if ((_hasBoxDeco || _needsTracking) && lines.length > _blockLineStart) {
          var _blkH = y - yBeforeBlock;
          // Box decoration should cover the full box including padding (not just content area)
          var _decoX = xLeft + (nd.marginLeft || 0);
          var _decoW = (_effectBoxW > 0) ? _effectBoxW : (maxX - _decoX - (nd.marginRight || 0));
          var _deco: BoxDecoration = { x: _decoX, w: _decoW, h: _blkH };
          if (nd.borderRadius !== undefined) _deco.borderRadius = nd.borderRadius;
          if (nd.borderWidth)  _deco.borderWidth  = nd.borderWidth;
          if (nd.borderColor !== undefined) _deco.borderColor = nd.borderColor;
          if (nd.borderStyle)  _deco.borderStyle  = nd.borderStyle;
          // Per-side border
          if (nd.borderTopWidth)    _deco.borderTopWidth    = nd.borderTopWidth;
          if (nd.borderRightWidth)  _deco.borderRightWidth  = nd.borderRightWidth;
          if (nd.borderBottomWidth) _deco.borderBottomWidth = nd.borderBottomWidth;
          if (nd.borderLeftWidth)   _deco.borderLeftWidth   = nd.borderLeftWidth;
          if (nd.borderTopColor    !== undefined) _deco.borderTopColor    = nd.borderTopColor;
          if (nd.borderRightColor  !== undefined) _deco.borderRightColor  = nd.borderRightColor;
          if (nd.borderBottomColor !== undefined) _deco.borderBottomColor = nd.borderBottomColor;
          if (nd.borderLeftColor   !== undefined) _deco.borderLeftColor   = nd.borderLeftColor;
          if (nd.boxShadow)    _deco.boxShadow    = nd.boxShadow;
          if (bgColor !== undefined) _deco.bgColor = bgColor;
          if (bgGradient)      _deco.bgGradient   = bgGradient;
          if (nd.opacity !== undefined) _deco.opacity = nd.opacity;
          if (nd.textShadow) _deco.textShadow = nd.textShadow;
          if (nd.outlineWidth) {
            _deco.outlineWidth = nd.outlineWidth;
            if (nd.outlineColor !== undefined) _deco.outlineColor = nd.outlineColor;
            if (nd.outlineOffset !== undefined) _deco.outlineOffset = nd.outlineOffset;
          }
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
      // Skip file input widgets — rarely visible on initial page load (hidden upload panels)
      if (bp.kind === 'file') continue;
      // Skip upload-panel submit buttons — these are from hidden interactive panels
      if ((bp.kind === 'submit' || bp.kind === 'button') && bp.value) {
        var _btnTxt = bp.value.toLowerCase();
        if (_btnTxt.indexOf('upload') >= 0 || _btnTxt.indexOf('remove file') >= 0) continue;
      }

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
      // R22: Resolve percentage width against available container
      if (!bp.cssWidth && bp.cssWidthPct && bp.cssWidthPct > 0) {
        var _pctW = Math.floor((maxX - xLeft) * bp.cssWidthPct / 100);
        // For inline SVG icons: don't expand percentage width beyond natural SVG dimensions
        // (prevents tiny 24×24 icons from being blown up to 976×976)
        if (bp.imgSrc === 'svg:inline' && bp.imgNatW && bp.imgNatW > 0 && _pctW > bp.imgNatW * 2) {
          _pctW = bp.imgNatW;
        }
        bp.cssWidth = _pctW;
      }
      var _cssWSet = !!(bp.cssWidth && bp.cssWidth > 0);
      var _cssHSet = !!(bp.cssHeight && bp.cssHeight > 0);
      if (_cssWSet) ww = Math.min(bp.cssWidth!, maxX - xLeft);
      if (_cssHSet) {
        // For buttons, cap CSS height to prevent oversized rendering
        if (bp.kind === 'submit' || bp.kind === 'reset' || bp.kind === 'button') {
          wh = Math.min(bp.cssHeight!, WIDGET_BTN_H + 16);
        } else {
          wh = bp.cssHeight!;
        }
      }
      // R20: Maintain image aspect ratio when CSS sets only one dimension
      if (bp.kind === 'img' && bp.imgNatW && bp.imgNatH && bp.imgNatW > 0 && bp.imgNatH > 0) {
        if (_cssWSet && !_cssHSet) wh = Math.round(ww * bp.imgNatH / bp.imgNatW);
        else if (_cssHSet && !_cssWSet) ww = Math.min(Math.round(wh * bp.imgNatW / bp.imgNatH), maxX - xLeft);
      }

      // object-fit: adjust image dimensions when CSS constrains the container
      if (bp.kind === 'img' && bp.objectFit && bp.imgNatW && bp.imgNatH) {
        var _ofNatW = bp.imgNatW, _ofNatH = bp.imgNatH;
        var _ofFit = bp.objectFit;
        if (_ofFit === 'contain' || _ofFit === 'scale-down') {
          // Scale to fit within ww×wh maintaining aspect ratio
          var _ofScaleW = ww / _ofNatW, _ofScaleH = wh / _ofNatH;
          var _ofScale = Math.min(_ofScaleW, _ofScaleH);
          if (_ofFit === 'scale-down') _ofScale = Math.min(_ofScale, 1); // don't enlarge
          ww = Math.floor(_ofNatW * _ofScale);
          wh = Math.floor(_ofNatH * _ofScale);
        } else if (_ofFit === 'cover') {
          // Scale to cover ww×wh — crop overflow (layout uses the CSS dimensions)
          // Image data will be cropped during blitting; layout just ensures container sizing
        } else if (_ofFit === 'none') {
          // Natural size, clipped to container
          ww = Math.min(_ofNatW, ww);
          wh = Math.min(_ofNatH, wh);
        }
        // 'fill' = default stretch behavior (no adjustment needed)
      }
      // Cap extremely tall narrow images (decorative icons) to reduce layout waste (R22: relaxed threshold)
      if (bp.kind === 'img' && wh > 200 && ww < 20 && !_cssHSet) wh = 200;

      // Clamp minimum widget dimensions — prevent negative or zero sizes
      if (ww < 1) ww = 1;
      if (wh < 1) wh = 1;

      // Skip effectively invisible widgets (< 2px in both dimensions)
      if (ww < 2 && wh < 2) continue;
      // Skip submit/button widgets that are too small to display meaningfully
      if ((bp.kind === 'submit' || bp.kind === 'button') && ww < 8) continue;

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
    // R23: Resolve percentage width/height for absolute/fixed elements against containing block
    var _oofContW = maxX - xLeft;
    var oofW     = oof.boxWidth ?? _oofContW;
    if (!oof.boxWidth && oof.widthPct && oof.widthPct > 0) {
      oofW = Math.floor(_oofContW * oof.widthPct / 100);
    }
    if (!oof.height && oof.heightPct && oof.heightPct > 0) {
      oof.height = Math.floor(getViewport().h * oof.heightPct / 100);
    }
    // When both left AND right are specified (no explicit width), derive width from container
    if (!oof.boxWidth && !oof.widthPct && oof.posLeft !== undefined && oof.posRight !== undefined) {
      oofW = Math.max(0, _oofContW - oof.posLeft - oof.posRight);
    }
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
      var rendLine: { y: number; nodes: typeof oofLine.nodes; lineH: number; fixedViewportY?: number; fixedViewportX?: number; bgColor?: number; bgGradient?: string; boxDeco?: BoxDecoration } =
        { y: oofY + _oofRelY, nodes: oofNodes2, lineH: oofLine.lineH };
      // Carry through bgColor/bgGradient/boxDeco from child layout
      if (oofLine.bgColor !== undefined) rendLine.bgColor = oofLine.bgColor;
      if (oofLine.bgGradient) rendLine.bgGradient = oofLine.bgGradient;
      if (oofLine.boxDeco) rendLine.boxDeco = oofLine.boxDeco;
      // position:fixed — mark lines so paint pass keeps them viewport-anchored regardless of scroll
      if (oof.position === 'fixed') {
        rendLine.fixedViewportY = oof.posTop  ?? 0;
        rendLine.fixedViewportX = oof.posLeft ?? 0;
      }
      lines.push(rendLine);
    }
    // R23: boxDeco for OOF element itself (border, border-radius, box-shadow, background)
    var _oofTotalH = oofLines.length > 0
      ? (oofLines[oofLines.length - 1].y + (oofLines[oofLines.length - 1].lineH || LINE_H) - (oofLines[0].y))
      : (oof.height || LINE_H);
    if (oof.height && oof.height > _oofTotalH) _oofTotalH = oof.height;
    var _hasOofDeco = oof.borderRadius !== undefined || oof.borderWidth || oof.boxShadow
      || oof.borderTopWidth || oof.borderBottomWidth || oof.borderLeftWidth || oof.borderRightWidth
      || oof.bgColor !== undefined || oof.bgGradient || oof.opacity !== undefined;
    if (_hasOofDeco && oofLines.length > 0) {
      var _oofDecoIdx = lines.length - oofLines.length; // first OOF line in the output
      var _oofDeco: BoxDecoration = { x: oofX, w: oofW, h: _oofTotalH };
      if (oof.borderRadius !== undefined) _oofDeco.borderRadius = oof.borderRadius;
      if (oof.borderWidth) _oofDeco.borderWidth = oof.borderWidth;
      if (oof.borderColor !== undefined) _oofDeco.borderColor = oof.borderColor;
      if (oof.borderStyle) _oofDeco.borderStyle = oof.borderStyle;
      if (oof.borderTopWidth) _oofDeco.borderTopWidth = oof.borderTopWidth;
      if (oof.borderRightWidth) _oofDeco.borderRightWidth = oof.borderRightWidth;
      if (oof.borderBottomWidth) _oofDeco.borderBottomWidth = oof.borderBottomWidth;
      if (oof.borderLeftWidth) _oofDeco.borderLeftWidth = oof.borderLeftWidth;
      if (oof.borderTopColor !== undefined) _oofDeco.borderTopColor = oof.borderTopColor;
      if (oof.borderRightColor !== undefined) _oofDeco.borderRightColor = oof.borderRightColor;
      if (oof.borderBottomColor !== undefined) _oofDeco.borderBottomColor = oof.borderBottomColor;
      if (oof.borderLeftColor !== undefined) _oofDeco.borderLeftColor = oof.borderLeftColor;
      if (oof.boxShadow) _oofDeco.boxShadow = oof.boxShadow;
      if (oof.bgColor !== undefined) _oofDeco.bgColor = oof.bgColor;
      if (oof.bgGradient) _oofDeco.bgGradient = oof.bgGradient;
      if (oof.opacity !== undefined) _oofDeco.opacity = oof.opacity;
      if (oof.overflow === 'hidden' || oof.overflow === 'scroll' || oof.overflow === 'auto') _oofDeco.overflowHidden = true;
      lines[_oofDecoIdx].boxDeco = _oofDeco;
    }
    // Shift OOF child widgets to absolute position
    for (var owi = 0; owi < oofWidgets.length; owi++) {
      oofWidgets[owi].px += oofX - CONTENT_PAD;
      oofWidgets[owi].py += oofY - _oofFirstY;
      widgets.push(oofWidgets[owi]);
    }
  }

  if (_lpId) layoutProfiler.endLayout(_lpId);

  // ── Post-layout fixup: propagate bgColor into blank lines between same-bg blocks ──
  // In real browsers, parent container backgrounds fill gaps between children.
  // Since our layout flattens the tree, blank lines between blocks lose the parent's bg.
  // Fix: if a blank line sits between two lines with the same bgColor, inherit it.
  if (lines.length > 2) {
    // Sort indices by y for proximity check (lines should already be mostly sorted)
    for (var _bgfi = 1; _bgfi < lines.length - 1; _bgfi++) {
      var _bgLine = lines[_bgfi];
      if (_bgLine.nodes.length > 0) continue; // Not a blank line
      if (_bgLine.bgColor !== undefined) continue; // Already has bgColor
      // Look for previous and next non-blank lines with bgColor
      var _prevBg: number | undefined;
      for (var _bgp = _bgfi - 1; _bgp >= 0 && _bgp >= _bgfi - 10; _bgp--) {
        if (lines[_bgp].bgColor !== undefined) { _prevBg = lines[_bgp].bgColor; break; }
      }
      if (_prevBg === undefined) continue;
      var _nextBg: number | undefined;
      for (var _bgn = _bgfi + 1; _bgn < lines.length && _bgn <= _bgfi + 10; _bgn++) {
        if (lines[_bgn].bgColor !== undefined) { _nextBg = lines[_bgn].bgColor; break; }
      }
      if (_nextBg !== undefined && _nextBg === _prevBg) {
        _bgLine.bgColor = _prevBg;
      }
    }
  }

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

