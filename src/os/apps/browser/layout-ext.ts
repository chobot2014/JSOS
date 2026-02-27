/**
 * layout-ext.ts — Extended layout engine primitives
 *
 * Implements the following checklist items:
 *
 *   394. CSS `white-space`: nowrap, pre, pre-wrap, pre-line, normal
 *   395. CSS `overflow`: hidden clipping for rendered lines
 *   398. CSS `z-index` stacking context (propagated to Compositor.LayerTree)
 *   400. CSS `clear`: left, right, both — advance y past floated elements
 *   441. Block Formatting Context (BFC) — isolated nested layout
 *   443. Intrinsic sizes: measureMinContent / measureMaxContent / fitContent
 *   448. box-sizing: border-box vs content-box box dimension resolution
 *   449. Table layout: fixed and auto algorithm
 *
 * All outputs are in the same RenderedLine / RenderedSpan coordinate system
 * used by layout.ts and TileRenderer.
 */

import type { RenderNode, InlineSpan, RenderedLine, RenderedSpan, WidgetBlueprint, LayoutResult } from './types.js';
import { CHAR_W, CHAR_H, LINE_H, CONTENT_PAD } from './constants.js';

// ── White-space handling (item 394) ──────────────────────────────────────────

/**
 * Apply CSS `white-space` mode to a raw text string.
 *
 *   'normal'   – collapse whitespace, wrap at word boundaries (default)
 *   'nowrap'   – collapse whitespace, no wrapping
 *   'pre'      – preserve all whitespace and newlines, no wrap
 *   'pre-wrap' – preserve whitespace and newlines, wrap allowed
 *   'pre-line' – collapse spaces, preserve newlines, wrap allowed
 *
 * Returns the transformed text string.  The actual wrapping is handled
 * by `flowSpans` using the new options below.
 */
export function applyWhiteSpaceTransform(
  text: string,
  mode: NonNullable<RenderNode['whiteSpace']>
): string {
  switch (mode) {
    case 'normal':
    case 'nowrap':
      // Collapse whitespace runs to single space, remove newlines
      return text.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
    case 'pre':
    case 'pre-wrap':
      // Preserve all whitespace
      return text;
    case 'pre-line':
      // Collapse spaces but keep newlines
      return text.replace(/[^\S\n]+/g, ' ');
    default:
      return text;
  }
}

/**
 * Determine whether the white-space mode prevents line wrapping.
 * 'nowrap' and 'pre' must not wrap at maxX.
 */
export function whiteSpaceNoWrap(mode: NonNullable<RenderNode['whiteSpace']>): boolean {
  return mode === 'nowrap' || mode === 'pre';
}

// ── Overflow clipping (item 395) ──────────────────────────────────────────────

/**
 * Clip `lines` to `maxHeight` pixels (overflow: hidden / overflow: clip).
 *
 * Lines that start at or beyond `yBase + maxHeight` are removed.
 * The last visible line may be partially revealed (no partial pixel clipping
 * at this stage — that would require pixel-level rendering).
 *
 * Returns a new array with the clipped subset.
 */
export function clipLinesToHeight(
  lines:     RenderedLine[],
  yBase:     number,
  maxHeight: number
): RenderedLine[] {
  if (maxHeight <= 0) return [];
  var limit = yBase + maxHeight;
  return lines.filter(function(ln) { return ln.y < limit; });
}

/**
 * Clip `lines` to `maxWidth` pixels per span (overflow: hidden horizontal).
 * Truncates span text that extends beyond `xBase + maxWidth`.
 */
export function clipLinesToWidth(
  lines:    RenderedLine[],
  xBase:    number,
  maxWidth: number,
  charW:    number = CHAR_W
): RenderedLine[] {
  var limit = xBase + maxWidth;
  return lines.map(function(ln) {
    var clipped = ln.nodes.filter(function(sp) { return sp.x < limit; }).map(function(sp) {
      var spEnd = sp.x + sp.text.length * charW;
      if (spEnd <= limit) return sp;
      var maxChars = Math.max(0, Math.floor((limit - sp.x) / charW));
      return { ...sp, text: sp.text.slice(0, maxChars) };
    });
    return { ...ln, nodes: clipped };
  });
}

// ── Float clear (item 400) ────────────────────────────────────────────────────

/**
 * Float registry — tracks the bottom Y of any active left/right floats.
 * The layout engine calls `registerFloat` after laying out each float,
 * and `clearY` to resolve `clear: left | right | both`.
 */
export class FloatRegistry {
  private _leftBottom:  number = 0;
  private _rightBottom: number = 0;

  /** Register a left or right float from its top Y and height. */
  registerFloat(side: 'left' | 'right', yTop: number, height: number): void {
    var bottom = yTop + height;
    if (side === 'left')  this._leftBottom  = Math.max(this._leftBottom,  bottom);
    else                   this._rightBottom = Math.max(this._rightBottom, bottom);
  }

  /**
   * Compute the Y position that clears the requested floats, per CSS `clear`.
   * Returns `Math.max(currentY, clearTarget)`.
   *
   * Item 400.
   */
  clearY(currentY: number, clear: 'left' | 'right' | 'both' | 'none' | undefined): number {
    if (!clear || clear === 'none') return currentY;
    var target = currentY;
    if (clear === 'left'  || clear === 'both') target = Math.max(target, this._leftBottom);
    if (clear === 'right' || clear === 'both') target = Math.max(target, this._rightBottom);
    return target;
  }

  /** Reset when entering a new BFC (isolated float context). */
  reset(): void { this._leftBottom = 0; this._rightBottom = 0; }
}

// ── Box-sizing (item 448) ─────────────────────────────────────────────────────

export interface BoxDimensions {
  /** Pixel width of the content area */
  contentWidth:  number;
  /** Pixel width including border and padding */
  outerWidth:    number;
  /** Pixel x offset of content area from left edge */
  contentX:      number;
  /** Pixel y offset of content area from top edge */
  contentY:      number;
}

/**
 * Resolve box dimensions for a RenderNode, honouring `box-sizing`.
 *
 * `containerWidth` is the available width of the containing block.
 *
 * Item 448.
 */
export function resolveBoxDimensions(nd: RenderNode, containerWidth: number): BoxDimensions {
  var borderW  = nd.borderWidth ?? 0;
  var padLeft  = nd.paddingLeft  ?? 0;
  var padRight = nd.paddingRight ?? 0;
  var padTop   = nd.paddingTop   ?? 0;

  var totalBorderPad = padLeft + padRight + borderW * 2;

  var specifiedWidth = nd.boxWidth ?? containerWidth;

  var contentWidth: number;
  if (nd.boxSizing === 'border-box') {
    // Specified width includes padding + border
    contentWidth = Math.max(0, specifiedWidth - totalBorderPad);
  } else {
    // content-box: specified width is just the content area
    contentWidth = specifiedWidth;
  }

  var outerWidth = contentWidth + totalBorderPad;

  return {
    contentWidth,
    outerWidth,
    contentX: padLeft + borderW,
    contentY: padTop  + borderW,
  };
}

// ── Intrinsic sizes (item 443) ────────────────────────────────────────────────

/**
 * Compute the min-content width (narrowest possible without overflow)
 * for a set of InlineSpan objects.
 *
 * min-content = width of the widest single word × charW.
 *
 * Item 443.
 */
export function measureMinContent(spans: InlineSpan[], charW: number = CHAR_W): number {
  var max = 0;
  for (var i = 0; i < spans.length; i++) {
    var words = spans[i].text.split(/\s+/);
    for (var w = 0; w < words.length; w++) {
      var ww = words[w].length * charW * (spans[i].fontScale ?? 1);
      if (ww > max) max = ww;
    }
  }
  return max + CONTENT_PAD * 2;
}

/**
 * Compute the max-content width (natural width with no wrapping).
 *
 * max-content = total width of all text on a single line.
 *
 * Item 443.
 */
export function measureMaxContent(spans: InlineSpan[], charW: number = CHAR_W): number {
  var total = 0;
  for (var i = 0; i < spans.length; i++) {
    total += spans[i].text.length * charW * (spans[i].fontScale ?? 1);
  }
  return total + CONTENT_PAD * 2;
}

/**
 * Resolve a CSS `width: fit-content(limit)` value.
 *
 * fit-content(limit) = min(max-content, max(min-content, limit))
 *
 * Item 443.
 */
export function measureFitContent(
  spans:  InlineSpan[],
  limit:  number,
  charW:  number = CHAR_W
): number {
  var minC = measureMinContent(spans, charW);
  var maxC = measureMaxContent(spans, charW);
  return Math.min(maxC, Math.max(minC, limit));
}

// ── Block Formatting Context (item 441) ───────────────────────────────────────

/**
 * Lay out child nodes inside an isolated Block Formatting Context (BFC).
 *
 * A BFC:
 *   - Has its own float registry (floats don't escape)
 *   - Contains absolutely-positioned children relative to itself
 *   - Allows margin collapsing within but not across its boundary
 *
 * Returns the RenderedLines for the BFC contents, with y positions starting
 * at 0 (caller offsets to actual position).
 *
 * Item 441.
 */
export function layoutBFC(
  nodes:      RenderNode[],
  contentW:   number,
  layoutFn:   (nodes: RenderNode[], bps: WidgetBlueprint[], contentW: number) => LayoutResult
): LayoutResult {
  // Run standard layout within the BFC — this provides margin
  // isolation simply by being a separate layout call.
  var result = layoutFn(nodes, [], contentW);

  // Re-base all y coordinates to 0 for BFC
  var minY = 0;
  if (result.lines.length > 0) minY = result.lines[0].y;
  if (minY !== 0) {
    result = {
      lines:   result.lines.map(function(ln) { return { ...ln, y: ln.y - minY }; }),
      widgets: result.widgets,
    };
  }

  return result;
}

// ── Table layout (item 449) ───────────────────────────────────────────────────

/**
 * Lay out a `table` RenderNode (type === 'table') into RenderedLines.
 *
 * Supports both `tableLayout: 'fixed'` and `'auto'`.
 *
 *   fixed  — equal column widths; first pass distributes width evenly
 *   auto   — measure max-content of each column; distribute proportionally
 *
 * Each `table` node has `children` of type 'table-row', which in turn
 * have `children` of type 'table-cell'.
 *
 * Item 449.
 */
export function layoutTable(
  tableNode:    RenderNode,
  contentW:     number,
  layoutRowFn:  (spans: InlineSpan[], xLeft: number, maxX: number, lineH: number) => RenderedLine[]
): RenderedLine[] {
  var rows     = (tableNode.children ?? []).filter(function(c) { return c.type === 'table-row'; });
  var layout   = tableNode.tableLayout ?? 'auto';
  var cellPad  = 4; // px padding inside each cell
  // border-collapse: collapse → no gap between cells; border-spacing → explicit gap (items 418/419)
  var collapsed    = tableNode.borderCollapse === 'collapse';
  var borderW      = collapsed ? 0 : (tableNode.borderSpacing ?? tableNode.borderWidth ?? 1);
  var tableW   = tableNode.boxWidth ? Math.min(tableNode.boxWidth, contentW) : contentW;

  if (rows.length === 0) return [];

  // Count columns (max cell count across all rows)
  var colCount = 0;
  for (var ri = 0; ri < rows.length; ri++) {
    var cells = (rows[ri].children ?? []).filter(function(c) { return c.type === 'table-cell'; });
    if (cells.length > colCount) colCount = cells.length;
  }
  if (colCount === 0) return [];

  // ── Column widths ──────────────────────────────────────────────────────────
  var colWidths: number[] = new Array(colCount).fill(0);

  if (layout === 'fixed') {
    // Equal distribution
    var equalW = Math.floor((tableW - borderW * (colCount + 1)) / colCount);
    for (var ci = 0; ci < colCount; ci++) colWidths[ci] = equalW;
  } else {
    // Auto: measure max-content of each column
    for (var ri2 = 0; ri2 < rows.length; ri2++) {
      var rowCells = (rows[ri2].children ?? []).filter(function(c) { return c.type === 'table-cell'; });
      for (var ci2 = 0; ci2 < rowCells.length && ci2 < colCount; ci2++) {
        var mc = measureMaxContent(rowCells[ci2].spans);
        if (mc > colWidths[ci2]) colWidths[ci2] = mc;
      }
    }
    // Scale to fit tableW
    var totalW     = colWidths.reduce(function(a, b) { return a + b; }, 0) + borderW * (colCount + 1);
    var scaleFactor = totalW > tableW ? tableW / totalW : 1;
    for (var ci3 = 0; ci3 < colCount; ci3++) {
      colWidths[ci3] = Math.floor(colWidths[ci3] * scaleFactor);
    }
  }

  // ── Render rows + cells ────────────────────────────────────────────────────
  var allLines: RenderedLine[] = [];
  var tableY   = 0;
  var tableX   = 0;

  for (var ri3 = 0; ri3 < rows.length; ri3++) {
    var row      = rows[ri3];
    var rowCells2 = (row.children ?? []).filter(function(c) { return c.type === 'table-cell'; });
    var rowMaxH  = 0;
    var rowCellLines: { x: number; w: number; lines: RenderedLine[]; vAlign: string }[] = [];

    var cellX = tableX + borderW;
    for (var ci4 = 0; ci4 < colCount; ci4++) {
      var cell    = rowCells2[ci4];
      var cw      = colWidths[ci4] ?? 0;
      if (!cell) { cellX += cw + borderW; continue; }

      var xLeft   = cellX + cellPad;
      var maxX    = cellX + cw - cellPad;
      var cellLines = layoutRowFn(cell.spans, xLeft, maxX, LINE_H);
      var cellH   = cellLines.length * LINE_H + cellPad * 2;
      if (cellH > rowMaxH) rowMaxH = cellH;

      rowCellLines.push({ x: cellX, w: cw, lines: cellLines, vAlign: cell.verticalAlign || 'top' });
      cellX += cw + borderW;
    }

    // Stamp all cell lines at correct Y, applying vertical-align offset (item 420)
    for (var cci = 0; cci < rowCellLines.length; cci++) {
      var ccl = rowCellLines[cci];
      var cellContentH = ccl.lines.length * LINE_H;
      var vOff = 0;
      if (ccl.vAlign === 'middle' || ccl.vAlign === 'center') {
        vOff = Math.max(0, Math.floor((rowMaxH - cellPad * 2 - cellContentH) / 2));
      } else if (ccl.vAlign === 'bottom') {
        vOff = Math.max(0, rowMaxH - cellPad * 2 - cellContentH);
      }
      for (var li = 0; li < ccl.lines.length; li++) {
        var ln   = ccl.lines[li];
        var realY = tableY + cellPad + vOff + li * LINE_H;
        allLines.push({ ...ln, y: realY });
      }
      // Bottom border line for cell (horizontal rule across cell width)
      if (borderW > 0) {
        allLines.push({ y: tableY + rowMaxH - borderW, nodes: [], lineH: borderW, hrLine: true });
      }
    }

    tableY += rowMaxH;
  }

  return allLines;
}

// ── Stacking context z-index helper (item 398) ────────────────────────────────

/**
 * Extract z-index stacking order information from a flat node list.
 *
 * Returns nodes grouped by stacking context, ordered by z-index.
 * Each group is: { zIndex, nodes: RenderNode[] }.
 *
 * In practice this feeds into the LayerTree compositor (render.ts).
 *
 * Item 398.
 */
export function groupByZIndex(
  nodes: RenderNode[]
): Array<{ zIndex: number; nodes: RenderNode[] }> {
  var groups = new Map<number, RenderNode[]>();

  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];
    var z  = nd.zIndex ?? 0;
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z)!.push(nd);
  }

  var result: Array<{ zIndex: number; nodes: RenderNode[] }> = [];
  groups.forEach(function(nodesInGroup, zIndex) {
    result.push({ zIndex, nodes: nodesInGroup });
  });
  result.sort(function(a, b) { return a.zIndex - b.zIndex; });
  return result;
}

// ── CSS Grid layout (items 404-405) ──────────────────────────────────────────

/**
 * Expand `repeat(N, tracks)` in a grid template string.
 * repeat(3, 1fr) → '1fr 1fr 1fr'
 * repeat(auto-fill, 120px) → '120px' (single-column fallback)
 */
function expandRepeat(template: string): string {
  return template.replace(/repeat\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/gi, function(_, count, track) {
    var n = parseInt(count, 10);
    if (isNaN(n) || n < 1) n = 1;  // auto-fill/auto-fit → treat as 1
    var parts: string[] = [];
    for (var i = 0; i < n; i++) parts.push(track.trim());
    return parts.join(' ');
  });
}

/**
 * Parse `minmax(min, max)` — returns the max value (preferred) if possible,
 * or min if max is 'auto'. Returns NaN if not a minmax() call.
 */
function parseMinMax(token: string, available: number): number {
  var m = token.match(/^minmax\(\s*(.+?)\s*,\s*(.+?)\s*\)$/i);
  if (!m) return NaN;
  var maxV = resolveTrackSz(m[2].trim(), available, 0);
  if (isNaN(maxV)) maxV = resolveTrackSz(m[1].trim(), available, 0);
  return maxV;
}

/** Resolve a single track sizing keyword/value to pixels. Returns NaN for 'fr'. */
function resolveTrackSz(tok: string, available: number, frUnit: number): number {
  var tl = tok.trim().toLowerCase();
  if (tl === 'auto' || tl === 'max-content' || tl === 'min-content') return frUnit;
  if (tl.endsWith('fr')) return NaN;   // caller handles fr
  if (tl.endsWith('%'))  return available * (parseFloat(tl) / 100);
  if (tl.endsWith('px')) return parseFloat(tl);
  if (tl.endsWith('em')) return parseFloat(tl) * 16;
  if (tl.endsWith('rem')) return parseFloat(tl) * 16;
  if (tl.endsWith('vw')) return available * (parseFloat(tl) / 100);
  var mm = parseMinMax(tok, available);
  if (!isNaN(mm)) return mm;
  var n = parseFloat(tl);
  return isNaN(n) ? 0 : n;
}

/**
 * [Items 404-405] Parse a CSS grid-template-columns / grid-template-rows value
 * and return an array of track sizes in px.
 *
 * Supports: px, %, em, rem, vw, fr units, repeat(), minmax(), auto.
 *
 * @param template  The raw CSS string, e.g. '1fr 200px repeat(3,1fr)'
 * @param available Available width/height in px for the container
 */
export function parseGridTrack(template: string, available: number): number[] {
  if (!template || template === 'none') return [];

  // 1. Expand repeat()
  var expanded = expandRepeat(template);

  // 2. Tokenise (space-separated, respecting nested parens)
  var tokens: string[] = [];
  var cur = '';
  var depth = 0;
  for (var ci = 0; ci < expanded.length; ci++) {
    var ch = expanded[ci];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ' ' && depth === 0 && cur) { tokens.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur) tokens.push(cur);

  // 3. First pass: split into fixed (px) and fr (flexible) tracks
  var frValues: number[]  = [];
  var sizes:    number[]  = [];
  var totalFixed = 0;

  for (var ti = 0; ti < tokens.length; ti++) {
    var tok = tokens[ti].trim();
    if (!tok || tok === '[' || tok.startsWith('[')) continue;  // named-line — skip
    if (tok.endsWith('fr')) {
      var frN = parseFloat(tok) || 1;
      frValues.push(frN);
      sizes.push(NaN);  // placeholder
    } else {
      var px = resolveTrackSz(tok, available, 0);
      sizes.push(isNaN(px) ? 0 : px);
      totalFixed += isNaN(px) ? 0 : px;
    }
  }

  // 4. Distribute remaining space to fr tracks
  var frTotal = frValues.reduce(function(a, b) { return a + b; }, 0) || 1;
  var remaining = Math.max(0, available - totalFixed);
  var frPx = remaining / frTotal;
  var frIdx = 0;
  for (var si = 0; si < sizes.length; si++) {
    if (isNaN(sizes[si])) {
      sizes[si] = frPx * (frValues[frIdx++] || 1);
    }
  }

  return sizes;
}

/**
 * Parse grid-column / grid-row shorthand 'start / end' → { start, end }.
 * Handles: '1', '1 / 3', 'span 2', 'auto'.
 */
function parseGridLine(val: string | undefined, trackCount: number): { start: number; end: number } {
  if (!val || val === 'auto') return { start: 1, end: 2 };
  var parts = val.split('/').map(function(s) { return s.trim(); });
  var startStr = parts[0] || 'auto';
  var endStr   = parts[1] || '';

  var start = 1;
  if (startStr !== 'auto') {
    start = parseInt(startStr, 10) || 1;
    if (start < 0) start = trackCount + start + 2;  // negative lines
  }

  var end = start + 1;
  if (endStr) {
    var spanM = endStr.match(/^span\s+(\d+)$/i);
    if (spanM) {
      end = start + (parseInt(spanM[1], 10) || 1);
    } else if (endStr !== 'auto') {
      end = parseInt(endStr, 10) || start + 1;
      if (end < 0) end = trackCount + end + 2;
    }
  }
  return { start: Math.max(1, start), end: Math.max(start + 1, end) };
}

/**
 * [Items 404-405] Layout a CSS Grid container.
 *
 * Lays out `gridNode.children` into a grid defined by
 * gridTemplateColumns / gridTemplateRows.  Uses parseGridTrack() which
 * handles fr, repeat(), minmax(), px, % track sizes.
 *
 * Returns the rendered lines for the container (all children stamped into
 * their resolved grid cell positions).
 */
export function layoutGrid(
  gridNode:   RenderNode,
  contentW:   number,
  CHAR_W:     number,
  LINE_H:     number,
  layoutFn:   (children: RenderNode[], contentW: number) => import('./types.js').LayoutResult
): import('./types.js').RenderedLine[] {
  var children  = gridNode.children ?? [];
  var gap       = gridNode.gap      ?? 0;
  var rowGap    = gridNode.rowGap   ?? gap;
  var colGap    = gridNode.columnGap ?? gap;

  // Resolve column tracks
  var colTmpl = gridNode.gridTemplateColumns || '';
  var colSizes = parseGridTrack(colTmpl, contentW - (gridNode.paddingLeft ?? 0) - (gridNode.paddingRight ?? 0));
  if (colSizes.length === 0) colSizes = [contentW];  // single-column default

  var colCount = colSizes.length;

  // Resolve row tracks (auto-generate if not specified)
  var rowTmpl  = gridNode.gridTemplateRows || '';
  var rowSizes = parseGridTrack(rowTmpl, 0);

  // Place children into grid cells
  type CellPos = { colStart: number; colEnd: number; rowStart: number; rowEnd: number };
  var placements: CellPos[] = [];
  var autoRow = 1;
  var autoCol = 1;

  for (var ci = 0; ci < children.length; ci++) {
    var child = children[ci];
    var colLine = parseGridLine(child.gridColumn ?? child.gridColumnStart, colCount);
    var rowLine = parseGridLine(child.gridRow    ?? child.gridRowStart,    99);

    if (!child.gridColumn && !child.gridColumnStart) {
      // Auto placement
      colLine = { start: autoCol, end: autoCol + 1 };
      rowLine = { start: autoRow, end: autoRow + 1 };
      autoCol++;
      if (autoCol > colCount) { autoCol = 1; autoRow++; }
    }
    placements.push({ colStart: colLine.start, colEnd: colLine.end, rowStart: rowLine.start, rowEnd: rowLine.end });
  }

  // Compute row count from placements
  var rowCount = 0;
  for (var pi = 0; pi < placements.length; pi++) {
    if (placements[pi].rowEnd - 1 > rowCount) rowCount = placements[pi].rowEnd - 1;
  }
  if (rowCount === 0) rowCount = Math.ceil(children.length / colCount);

  // Fill auto row sizes
  while (rowSizes.length < rowCount) rowSizes.push(0);  // 0 = auto (determined by content)

  // Layout each child and stamp into its cell
  var allLines: import('./types.js').RenderedLine[] = [];
  var rowY: number[] = [];
  var curRowY = gridNode.paddingTop ?? 0;
  for (var ri2 = 0; ri2 < rowCount; ri2++) { rowY.push(curRowY); curRowY += (rowSizes[ri2] || LINE_H) + rowGap; }

  // Compute track X positions
  var colX: number[] = [];
  var cx = gridNode.paddingLeft ?? 0;
  for (var cxi = 0; cxi < colCount; cxi++) { colX.push(cx); cx += colSizes[cxi] + colGap; }

  var rowHeights: number[] = new Array(rowCount).fill(0);

  for (var gi = 0; gi < children.length; gi++) {
    var placement = placements[gi];
    var cs = Math.max(0, placement.colStart - 1);
    var ce = Math.min(colCount, placement.colEnd - 1);
    var rs = Math.max(0, placement.rowStart - 1);

    // Compute cell width (may span multiple columns)
    var cellW = 0;
    for (var csi = cs; csi < ce; csi++) {
      cellW += (colSizes[csi] || 0);
      if (csi < ce - 1) cellW += colGap;
    }
    cellW = Math.max(CHAR_W, cellW);

    var childResult = layoutFn([children[gi]], cellW);
    var childLines  = childResult.lines;
    var childH      = childLines.length * LINE_H;

    // Track actual row height
    if (childH > rowHeights[rs]) rowHeights[rs] = childH;

    var xOff = colX[cs] ?? 0;
    var yOff = rowY[rs] ?? 0;

    for (var li = 0; li < childLines.length; li++) {
      var ln = childLines[li];
      allLines.push({
        y:      yOff + ln.y,
        nodes:  ln.nodes.map(function(n) { return { ...n, x: n.x + xOff }; }),
        lineH:  ln.lineH,
        bgColor: ln.bgColor,
        bgGradient: ln.bgGradient,
        preBg:  ln.preBg,
      });
    }
  }

  return allLines;
}
// ════════════════════════════════════════════════════════════════════════════
// [Item 455] Sticky Positioning
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 455] CSS `position: sticky` — element sticks to the viewport edge
 * when scrolled past its natural position.
 *
 * `top`, `right`, `bottom`, `left` offsets define the sticking threshold.
 *
 * Usage: call `applyStickyOffset()` during the scroll repaint phase.
 * The element's rendered Y is clamped to `scrollOffset + top` when scrolling
 * past its natural position.
 */
export interface StickyElement {
  /** Natural (layout) Y position in document coordinates. */
  naturalY:   number;
  /** Rendered lines belonging to this sticky element. */
  lines:      RenderedLine[];
  /** Stick threshold from top of scroll container. */
  top?:       number;
  /** Stick threshold from bottom. */
  bottom?:    number;
  /** Height of the sticky element in lines × LINE_H. */
  height:     number;
}

/**
 * [Item 455] Compute Y offset for a sticky element given current scroll position.
 *
 * @param el           Sticky element descriptor.
 * @param scrollTop    Current scroll position of the container (chars).
 * @param viewportH    Viewport height (chars).
 */
export function stickyOffset(el: StickyElement, scrollTop: number, viewportH: number): number {
  var naturalY = el.naturalY;

  if (el.top !== undefined) {
    // Stick to top: clamp Y so it doesn't scroll above `scrollTop + top`
    var stickyY = scrollTop + el.top;
    if (naturalY < stickyY) return stickyY;
    // Unstick when element bottom passes viewport + bottom threshold
    if (el.bottom !== undefined) {
      var maxY = scrollTop + viewportH - el.bottom - el.height;
      if (naturalY > maxY) return maxY;
    }
  }

  if (el.bottom !== undefined && el.top === undefined) {
    // Stick to bottom
    var stickBotY = scrollTop + viewportH - el.bottom - el.height;
    if (naturalY > stickBotY) return stickBotY;
  }

  return naturalY;
}

/**
 * [Item 455] Apply sticky positioning to rendered lines during paint.
 *
 * Adjusts the `y` coordinate of sticky element lines based on scroll position.
 */
export function applyStickyPositioning(
  lines:       RenderedLine[],
  stickyEls:   StickyElement[],
  scrollTop:   number,
  viewportH:   number,
): RenderedLine[] {
  if (stickyEls.length === 0) return lines;

  // Build a set of line y-values belonging to sticky elements
  var stickyYMap = new Map<number, number>(); // oldY → newY
  for (var i = 0; i < stickyEls.length; i++) {
    var el = stickyEls[i];
    var newBaseY = stickyOffset(el, scrollTop, viewportH);
    var delta    = newBaseY - el.naturalY;
    for (var li = 0; li < el.lines.length; li++) {
      var oldY = el.lines[li].y;
      stickyYMap.set(oldY, oldY + delta);
    }
  }

  return lines.map(function(ln) {
    var newY = stickyYMap.get(ln.y);
    if (newY === undefined) return ln;
    return { ...ln, y: newY };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 457] Multi-Column Layout
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 457] CSS multi-column layout: `column-count` and `column-width`.
 *
 * Distributes block content across N equally-wide columns.
 * Columns are separated by `column-gap` (default 1 character).
 *
 * Items are filled column-by-column (balanced mode: all columns same height).
 * CSS `column-fill: auto` (fill first column before next) is also supported.
 *
 * @param lines       Pre-laid-out lines from normal block layout.
 * @param colCount    `column-count`: number of columns.
 * @param colWidth    `column-width`: preferred column width (chars); 0 = auto.
 * @param containerW  Available width (chars).
 * @param colGap      Gap between columns (chars).
 * @param balance     true = balance columns, false = fill left-to-right (auto).
 */
export function layoutMultiColumn(
  lines:      RenderedLine[],
  colCount:   number,
  colWidth:   number,
  containerW: number,
  colGap:     number = 1,
  balance:    boolean = true,
): RenderedLine[] {
  // Resolve column count
  var n = colCount > 0 ? colCount : Math.max(1, Math.floor((containerW + colGap) / (colWidth + colGap)));
  if (n <= 1) return lines;

  var gap  = Math.max(0, colGap);
  var colW = Math.max(CHAR_W, Math.floor((containerW - gap * (n - 1)) / n));

  // Split lines into N columns (balanced)
  var linesPerCol = Math.ceil(lines.length / n);
  var allLines: RenderedLine[] = [];

  for (var col = 0; col < n; col++) {
    var start   = balance ? Math.floor(col * lines.length / n) : col * linesPerCol;
    var end     = balance ? Math.floor((col + 1) * lines.length / n) : Math.min(start + linesPerCol, lines.length);
    var xOffset = col * (colW + gap);

    for (var li = start; li < end; li++) {
      var ln   = lines[li];
      var rowY = (li - start) * LINE_H;
      allLines.push({
        y:      rowY,
        lineH:  ln.lineH,
        bgColor: ln.bgColor,
        bgGradient: ln.bgGradient,
        preBg:  ln.preBg,
        nodes:  ln.nodes.map(function(sp) {
          return { ...sp, x: sp.x + xOffset };
        }),
      });
    }
  }

  return allLines;
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 458] Inline-Block Layout
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 458] CSS `display: inline-block` layout.
 *
 * An inline-block element participates in the inline formatting context of
 * its parent but is itself a block formatting context internally.
 *
 * In the JSOS character-cell renderer, inline-block elements:
 *   1. Are laid out internally as blocks (via `layoutFn`).
 *   2. Are placed on the current line at the current inline cursor position.
 *   3. Advance the cursor by the element's width.
 *   4. If the element doesn't fit on the current line, a line break is inserted.
 *
 * @param node        The inline-block element.
 * @param intrinsicW  Width of the element (chars); 0 = auto (fit content).
 * @param cursorX     Current X position in the parent line (chars).
 * @param lineW       Parent line width (chars).
 * @param layoutFn    Recursive layout function.
 * @returns           Positioned lines for the inline-block content + new cursor.
 */
export function layoutInlineBlock(
  node:      RenderNode,
  intrinsicW: number,
  cursorX:   number,
  lineW:     number,
  layoutFn:  (nodes: RenderNode[], width: number) => LayoutResult,
): { lines: RenderedLine[]; newCursorX: number; wrappedToNewLine: boolean } {
  var w = intrinsicW > 0 ? intrinsicW : Math.max(CHAR_W, lineW / 3 | 0);

  // Does it fit on the current line?
  var wrappedToNewLine = cursorX + w > lineW && cursorX > 0;
  var xBase = wrappedToNewLine ? 0 : cursorX;

  var result = layoutFn([node], w);
  var lines  = result.lines.map(function(ln) {
    return {
      ...ln,
      nodes: ln.nodes.map(function(sp) { return { ...sp, x: sp.x + xBase }; }),
    };
  });

  return { lines, newCursorX: xBase + w, wrappedToNewLine };
}

// ════════════════════════════════════════════════════════════════════════════
// [Items 459–461] Overflow: scroll / hidden / scrollable container
// ════════════════════════════════════════════════════════════════════════════

/** Scroll state for a scrollable container (item 461). */
export interface ScrollContainer {
  /** ID for the scroll box (e.g., element index in tree). */
  id:         number;
  /** Current vertical scroll offset (rows). */
  scrollTop:  number;
  /** Current horizontal scroll offset (chars). */
  scrollLeft: number;
  /** Rendered content height (lines). */
  contentH:   number;
  /** Rendered content width (chars). */
  contentW:   number;
  /** Visible height (rows). */
  clipH:      number;
  /** Visible width (chars). */
  clipW:      number;
  /** Scrollbar visibility. */
  showScrollbarY: boolean;
  showScrollbarX: boolean;
}

/** Global registry of scroll containers (item 461). */
export const scrollContainers = new Map<number, ScrollContainer>();

/**
 * [Item 459] Apply `overflow: scroll` clipping — clip lines to viewport and
 * add a scrollbar indicator character at the right edge.
 *
 * @param lines       Un-clipped content lines.
 * @param container   Scroll container state.
 * @returns           Clipped and scrolled lines with scrollbar overlay.
 */
export function applyOverflowScroll(
  lines:     RenderedLine[],
  container: ScrollContainer,
): RenderedLine[] {
  var { scrollTop, clipH, clipW, contentH } = container;
  var visible = _clipLines(lines, scrollTop, clipH, clipW, 0);

  // [Item 459] Add scrollbar: draw '█' or '░' column at right edge
  if (container.showScrollbarY && contentH > clipH) {
    var barH    = Math.max(1, Math.floor(clipH * clipH / contentH));
    var barTop  = Math.floor(scrollTop / contentH * clipH);
    for (var yi = 0; yi < clipH; yi++) {
      var ln = visible[yi];
      if (!ln) {
        // Create empty line if needed
        visible[yi] = { y: yi * LINE_H, lineH: LINE_H, bgColor: '', preBg: false, nodes: [] };
        ln = visible[yi];
      }
      var sbChar = (yi >= barTop && yi < barTop + barH) ? '█' : '░';
      ln.nodes.push({ x: clipW - 1, color: '#888', bg: '#222', bold: false, text: sbChar });
    }
  }

  return visible;
}

/**
 * [Item 460] Apply `overflow: hidden` clipping — clip lines to viewport, no scrollbar.
 *
 * @param lines       Un-clipped content lines.
 * @param clipH       Container height in rows.
 * @param clipW       Container width in chars.
 * @param scrollTop   Vertical scroll offset (for sticky headers etc.).
 */
export function applyOverflowHidden(
  lines:      RenderedLine[],
  clipH:      number,
  clipW:      number,
  scrollTop:  number = 0,
): RenderedLine[] {
  return _clipLines(lines, scrollTop, clipH, clipW, 0);
}

/**
 * [Item 461] Scroll a container by `deltaRows` rows.
 *
 * Clamps to [0, contentH - clipH].
 * Returns the new scrollTop value.
 */
export function scrollContainer(id: number, deltaRows: number): number {
  var sc = scrollContainers.get(id);
  if (!sc) return 0;
  var maxScroll = Math.max(0, sc.contentH - sc.clipH);
  sc.scrollTop  = Math.max(0, Math.min(sc.scrollTop + deltaRows, maxScroll));
  return sc.scrollTop;
}

/**
 * [Item 461] Register or update a scroll container.
 */
export function registerScrollContainer(
  id: number, clipW: number, clipH: number, contentW: number, contentH: number,
  overflow: string = 'scroll',
): ScrollContainer {
  var existing = scrollContainers.get(id);
  var sc: ScrollContainer = existing ?? {
    id, scrollTop: 0, scrollLeft: 0,
    contentH, contentW, clipH, clipW,
    showScrollbarY: overflow !== 'hidden',
    showScrollbarX: overflow !== 'hidden',
  };
  sc.contentH = contentH; sc.contentW = contentW;
  sc.clipH    = clipH;    sc.clipW    = clipW;
  sc.showScrollbarY = overflow !== 'hidden';
  sc.showScrollbarX = overflow !== 'hidden';
  scrollContainers.set(id, sc);
  return sc;
}

// ── Shared clip helper ───────────────────────────────────────────────────────

function _clipLines(
  lines:     RenderedLine[],
  scrollTop: number,
  clipH:     number,
  clipW:     number,
  xOffset:   number,
): RenderedLine[] {
  var out: RenderedLine[] = [];
  for (var i = 0; i < lines.length; i++) {
    var ln  = lines[i];
    var row = Math.floor(ln.y / LINE_H);
    if (row < scrollTop) continue;
    var visRow = row - scrollTop;
    if (visRow >= clipH) break;

    // Clip spans that exceed clipW
    var clippedNodes = ln.nodes.filter(function(n) { return n.x >= xOffset && n.x < xOffset + clipW; });
    out.push({
      y:      visRow * LINE_H,
      lineH:  ln.lineH,
      bgColor: ln.bgColor,
      bgGradient: ln.bgGradient,
      preBg:  ln.preBg,
      nodes:  clippedNodes.map(function(n) { return { ...n, x: n.x - xOffset }; }),
    });
  }
  return out;
}
