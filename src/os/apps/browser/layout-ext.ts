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
  var borderW  = tableNode.borderWidth ?? 1;
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
    var rowCellLines: { x: number; w: number; lines: RenderedLine[] }[] = [];

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

      rowCellLines.push({ x: cellX, w: cw, lines: cellLines });
      cellX += cw + borderW;
    }

    // Stamp all cell lines at correct Y
    for (var cci = 0; cci < rowCellLines.length; cci++) {
      var ccl = rowCellLines[cci];
      for (var li = 0; li < ccl.lines.length; li++) {
        var ln   = ccl.lines[li];
        var realY = tableY + cellPad + li * LINE_H;
        allLines.push({ ...ln, y: realY });
      }
      // Bottom border line for cell (horizontal rule across cell width)
      allLines.push({ y: tableY + rowMaxH - borderW, nodes: [], lineH: borderW, hrLine: true });
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
