/**
 * JSOS Office Suite — Items 781, 782, 783
 *
 * Item 781: Word Processor (DocumentEditor)
 * Item 782: Spreadsheet (SpreadsheetApp)
 * Item 783: Drawing App (DrawingCanvas)
 */

// ══════════════════════════════════════════════════════════════════════════════
// Item 781 — Word Processor
// ══════════════════════════════════════════════════════════════════════════════

export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type FontStyle = 'normal' | 'italic' | 'oblique';
export type FontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeThrough?: boolean;
  fontSize?: number;   // pt
  fontFamily?: string;
  color?: string;      // CSS color
  bgColor?: string;
  link?: string;
}

export interface DocParagraph {
  id: string;
  runs: TextRun[];
  align: TextAlign;
  indent: number;        // em units
  listLevel: number;     // 0 = no list
  listType: 'none' | 'bullet' | 'ordered';
  spaceBefore: number;   // pt
  spaceAfter: number;
  heading: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = normal
}

export interface DocSection {
  id: string;
  paragraphs: DocParagraph[];
  pageWidth: number;     // mm
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

export interface Document {
  id: string;
  title: string;
  sections: DocSection[];
  metadata: Record<string, string>;
  wordCount: number;
  charCount: number;
  lastModified: Date;
}

let _docSeq = 1;

function _mkParagraph(text = ''): DocParagraph {
  return {
    id: 'p' + (_docSeq++),
    runs: text ? [{ text }] : [],
    align: 'left',
    indent: 0,
    listLevel: 0,
    listType: 'none',
    spaceBefore: 0,
    spaceAfter: 6,
    heading: 0,
  };
}

export class DocumentEditor {
  private _doc: Document;
  private _cursor: { sectionIdx: number; paraIdx: number; runIdx: number; offset: number };
  private _history: Document[] = [];
  private _histPos: number = -1;

  constructor(title = 'Untitled Document') {
    const section: DocSection = {
      id: 'sec1',
      paragraphs: [_mkParagraph()],
      pageWidth: 210, pageHeight: 297,
      marginTop: 25, marginBottom: 25, marginLeft: 30, marginRight: 25,
    };
    this._doc = { id: 'doc' + (_docSeq++), title, sections: [section], metadata: {}, wordCount: 0, charCount: 0, lastModified: new Date() };
    this._cursor = { sectionIdx: 0, paraIdx: 0, runIdx: 0, offset: 0 };
    this._snapshot();
  }

  get document(): Document { return this._doc; }
  get title(): string { return this._doc.title; }
  setTitle(t: string): void { this._doc.title = t; this._touch(); }

  private _touch(): void {
    this._doc.lastModified = new Date();
    this._updateCounts();
  }

  private _updateCounts(): void {
    let chars = 0; let words = 0;
    for (const sec of this._doc.sections) {
      for (const para of sec.paragraphs) {
        for (const run of para.runs) {
          chars += run.text.length;
          words += run.text.trim().split(/\s+/).filter(Boolean).length;
        }
      }
    }
    this._doc.wordCount = words;
    this._doc.charCount = chars;
  }

  private _snapshot(): void {
    const snap = JSON.parse(JSON.stringify(this._doc));
    this._history = this._history.slice(0, this._histPos + 1);
    this._history.push(snap);
    this._histPos = this._history.length - 1;
  }

  undo(): boolean {
    if (this._histPos <= 0) return false;
    this._histPos--;
    this._doc = JSON.parse(JSON.stringify(this._history[this._histPos]));
    return true;
  }

  redo(): boolean {
    if (this._histPos >= this._history.length - 1) return false;
    this._histPos++;
    this._doc = JSON.parse(JSON.stringify(this._history[this._histPos]));
    return true;
  }

  /** Insert text at current cursor position. */
  insertText(text: string): void {
    const sec = this._doc.sections[this._cursor.sectionIdx];
    const para = sec.paragraphs[this._cursor.paraIdx];
    if (!para.runs.length) para.runs.push({ text: '' });
    const run = para.runs[this._cursor.runIdx] ?? para.runs[para.runs.length - 1];
    run.text = run.text.slice(0, this._cursor.offset) + text + run.text.slice(this._cursor.offset);
    this._cursor.offset += text.length;
    this._touch();
    this._snapshot();
  }

  /** Press Enter — split current paragraph. */
  insertParagraph(): void {
    const sec = this._doc.sections[this._cursor.sectionIdx];
    const newPara = _mkParagraph();
    sec.paragraphs.splice(this._cursor.paraIdx + 1, 0, newPara);
    this._cursor.paraIdx++;
    this._cursor.runIdx = 0;
    this._cursor.offset = 0;
    this._touch();
    this._snapshot();
  }

  /** Apply formatting to current run. */
  applyFormat(fmt: Partial<TextRun>): void {
    const sec  = this._doc.sections[this._cursor.sectionIdx];
    const para = sec.paragraphs[this._cursor.paraIdx];
    if (!para.runs.length) para.runs.push({ text: '' });
    const run = para.runs[this._cursor.runIdx] ?? para.runs[0];
    Object.assign(run, fmt);
    this._touch();
    this._snapshot();
  }

  /** Apply paragraph-level formatting. */
  applyParaFormat(fmt: Partial<DocParagraph>): void {
    const sec  = this._doc.sections[this._cursor.sectionIdx];
    const para = sec.paragraphs[this._cursor.paraIdx];
    Object.assign(para, fmt);
    this._touch();
    this._snapshot();
  }

  moveCursor(sectionIdx: number, paraIdx: number, runIdx: number, offset: number): void {
    this._cursor = { sectionIdx, paraIdx, runIdx, offset };
  }

  /** Export to plain text. */
  toPlainText(): string {
    const lines: string[] = [];
    for (const sec of this._doc.sections) {
      for (const para of sec.paragraphs) {
        lines.push(para.runs.map(function(r) { return r.text; }).join(''));
      }
    }
    return lines.join('\n');
  }

  /** Very lightweight HTML export. */
  toHTML(): string {
    const parts: string[] = ['<html><body>'];
    for (const sec of this._doc.sections) {
      for (const para of sec.paragraphs) {
        const tag = para.heading > 0 ? `h${para.heading}` : 'p';
        const text = para.runs.map(function(r) {
          let s = r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          if (r.bold) s = `<b>${s}</b>`;
          if (r.italic) s = `<i>${s}</i>`;
          if (r.underline) s = `<u>${s}</u>`;
          if (r.link) s = `<a href="${r.link}">${s}</a>`;
          return s;
        }).join('');
        parts.push(`<${tag} style="text-align:${para.align}">${text}</${tag}>`);
      }
    }
    parts.push('</body></html>');
    return parts.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Item 782 — Spreadsheet
// ══════════════════════════════════════════════════════════════════════════════

export type CellValue = string | number | boolean | null;

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  numberFormat?: string;  // e.g. '#,##0.00', 'YYYY-MM-DD'
  bgColor?: string;
  color?: string;
  fontSize?: number;
}

export interface Cell {
  value: CellValue;
  formula?: string;    // raw formula string e.g. '=SUM(A1:A10)'
  computed: CellValue; // result after formula evaluation
  format: CellFormat;
  error?: string;
}

export interface SheetRange {
  startRow: number; startCol: number;
  endRow: number;   endCol: number;
}

export class Sheet {
  readonly name: string;
  private _cells: Map<string, Cell> = new Map();
  private _colWidths: Map<number, number> = new Map();
  private _rowHeights: Map<number, number> = new Map();
  private _frozenRows: number = 0;
  private _frozenCols: number = 0;

  constructor(name: string) { this.name = name; }

  private _key(row: number, col: number): string { return `${row},${col}`; }

  /** Get or create a cell at (row, col) — 0-based. */
  cell(row: number, col: number): Cell {
    const k = this._key(row, col);
    let c = this._cells.get(k);
    if (!c) {
      c = { value: null, computed: null, format: {} };
      this._cells.set(k, c);
    }
    return c;
  }

  set(row: number, col: number, value: CellValue, formula?: string): void {
    const c = this.cell(row, col);
    c.value = value;
    if (formula) c.formula = formula;
    c.computed = c.formula ? this._evalFormula(c.formula, row, col) : value;
  }

  get(row: number, col: number): CellValue {
    return this._cells.get(this._key(row, col))?.computed ?? null;
  }

  format(row: number, col: number, fmt: Partial<CellFormat>): void {
    Object.assign(this.cell(row, col).format, fmt);
  }

  setColWidth(col: number, width: number): void { this._colWidths.set(col, width); }
  setRowHeight(row: number, height: number): void { this._rowHeights.set(row, height); }
  setFrozen(rows: number, cols: number): void { this._frozenRows = rows; this._frozenCols = cols; }
  get frozenRows(): number { return this._frozenRows; }
  get frozenCols(): number { return this._frozenCols; }

  /** Simple formula evaluator supporting SUM, AVERAGE, MIN, MAX, COUNT, IF. */
  private _evalFormula(formula: string, _row: number, _col: number): CellValue {
    if (!formula.startsWith('=')) return formula;
    const expr = formula.slice(1).trim().toUpperCase();
    const cellRef = /^([A-Z]+)(\d+)$/;
    const rangeRef = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/;
    const colIndex = (s: string) => s.split('').reduce(function(a, c) { return a * 26 + c.charCodeAt(0) - 64; }, 0) - 1;

    const resolveRange = (match: RegExpMatchArray) => {
      const r1 = parseInt(match[2]) - 1; const c1 = colIndex(match[1]);
      const r2 = parseInt(match[4]) - 1; const c2 = colIndex(match[3]);
      const vals: number[] = [];
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
        const v = this.get(r, c);
        if (typeof v === 'number') vals.push(v);
      }
      return vals;
    };

    try {
      // SUM(range)
      const sumM = expr.match(/^SUM\(([^)]+)\)$/);
      if (sumM) {
        const rm = sumM[1].match(rangeRef);
        if (!rm) return null;
        return resolveRange(rm).reduce(function(a, b) { return a + b; }, 0);
      }
      // AVERAGE(range)
      const avgM = expr.match(/^AVERAGE\(([^)]+)\)$/);
      if (avgM) {
        const rm = avgM[1].match(rangeRef);
        if (!rm) return null;
        const vals = resolveRange(rm);
        return vals.length ? vals.reduce(function(a, b) { return a + b; }, 0) / vals.length : null;
      }
      // MIN/MAX(range)
      const minM = expr.match(/^MIN\(([^)]+)\)$/);
      if (minM) { const rm = minM[1].match(rangeRef); if (!rm) return null; const v = resolveRange(rm); return v.length ? Math.min(...v) : null; }
      const maxM = expr.match(/^MAX\(([^)]+)\)$/);
      if (maxM) { const rm = maxM[1].match(rangeRef); if (!rm) return null; const v = resolveRange(rm); return v.length ? Math.max(...v) : null; }
      // COUNT(range)
      const cntM = expr.match(/^COUNT\(([^)]+)\)$/);
      if (cntM) { const rm = cntM[1].match(rangeRef); if (!rm) return null; return resolveRange(rm).length; }
      // Direct cell ref
      const cr = expr.match(cellRef);
      if (cr) { return this.get(parseInt(cr[2]) - 1, colIndex(cr[1])); }
      // Literal number
      const n = parseFloat(expr);
      if (!isNaN(n)) return n;
    } catch (_) {}
    return null;
  }

  /** Export sheet as CSV. */
  toCSV(maxRow = 100, maxCol = 26): string {
    const rows: string[] = [];
    for (let r = 0; r < maxRow; r++) {
      let hasData = false;
      const cols: string[] = [];
      for (let c = 0; c < maxCol; c++) {
        const v = this.get(r, c);
        if (v !== null) hasData = true;
        const s = v === null ? '' : String(v);
        cols.push(s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
      }
      if (!hasData && r > 0) break;
      rows.push(cols.join(','));
    }
    return rows.join('\n');
  }

  /** All used cells as (row, col, value) tuples. */
  usedCells(): Array<{ row: number; col: number; value: CellValue }> {
    const result: Array<{ row: number; col: number; value: CellValue }> = [];
    this._cells.forEach(function(cell, key) {
      if (cell.value !== null) {
        const [r, c] = key.split(',').map(Number);
        result.push({ row: r, col: c, value: cell.computed });
      }
    });
    return result;
  }
}

export class SpreadsheetApp {
  private _sheets: Sheet[] = [];
  private _activeIdx: number = 0;
  readonly title: string;

  constructor(title = 'Untitled Spreadsheet') {
    this.title = title;
    this._sheets.push(new Sheet('Sheet1'));
  }

  addSheet(name: string): Sheet {
    const s = new Sheet(name);
    this._sheets.push(s);
    return s;
  }

  removeSheet(name: string): void {
    const idx = this._sheets.findIndex(function(s) { return s.name === name; });
    if (idx >= 0 && this._sheets.length > 1) this._sheets.splice(idx, 1);
    if (this._activeIdx >= this._sheets.length) this._activeIdx = this._sheets.length - 1;
  }

  sheet(name: string): Sheet | undefined { return this._sheets.find(function(s) { return s.name === name; }); }
  get activeSheet(): Sheet { return this._sheets[this._activeIdx]; }
  setActiveSheet(name: string): void {
    const idx = this._sheets.findIndex(function(s) { return s.name === name; });
    if (idx >= 0) this._activeIdx = idx;
  }

  sheets(): Sheet[] { return this._sheets.slice(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// Item 783 — Drawing App (Canvas 2D)
// ══════════════════════════════════════════════════════════════════════════════

export type DrawingTool = 'pen' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'text' | 'fill' | 'select' | 'move';

export interface DrawPoint { x: number; y: number; }

export interface DrawStyle {
  strokeColor: string;
  fillColor: string;
  lineWidth: number;
  opacity: number;       // 0.0–1.0
  lineDash: number[];    // e.g. [5, 5]
  fontFamily: string;
  fontSize: number;
}

export type Shape =
  | { type: 'path';    points: DrawPoint[]; style: DrawStyle; }
  | { type: 'line';    x1: number; y1: number; x2: number; y2: number; style: DrawStyle; }
  | { type: 'rect';    x: number; y: number; w: number; h: number; style: DrawStyle; }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number; style: DrawStyle; }
  | { type: 'text';    x: number; y: number; text: string; style: DrawStyle; }
  | { type: 'image';   x: number; y: number; w: number; h: number; src: string; };

export interface DrawingLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  shapes: Shape[];
}

export class DrawingCanvas {
  private _layers: DrawingLayer[] = [];
  private _activeLayerId: string;
  private _tool: DrawingTool = 'pen';
  private _style: DrawStyle;
  private _history: DrawingLayer[][] = [];
  private _histPos: number = -1;
  private _width: number;
  private _height: number;
  private _selection: { x: number; y: number; w: number; h: number } | null = null;

  constructor(width = 800, height = 600) {
    this._width = width;
    this._height = height;
    const layer: DrawingLayer = { id: 'layer1', name: 'Layer 1', visible: true, locked: false, opacity: 1, shapes: [] };
    this._layers.push(layer);
    this._activeLayerId = layer.id;
    this._style = { strokeColor: '#000000', fillColor: 'transparent', lineWidth: 2, opacity: 1, lineDash: [], fontFamily: 'sans-serif', fontSize: 16 };
    this._snapshot();
  }

  get width(): number { return this._width; }
  get height(): number { return this._height; }
  get tool(): DrawingTool { return this._tool; }
  get style(): DrawStyle { return { ...this._style }; }
  get selection(): { x: number; y: number; w: number; h: number } | null { return this._selection; }

  setTool(tool: DrawingTool): void { this._tool = tool; }
  setStyle(style: Partial<DrawStyle>): void { Object.assign(this._style, style); }

  addLayer(name: string): DrawingLayer {
    const id = 'layer' + Date.now();
    const l: DrawingLayer = { id, name, visible: true, locked: false, opacity: 1, shapes: [] };
    this._layers.push(l);
    return l;
  }

  removeLayer(id: string): void {
    if (this._layers.length <= 1) return;
    this._layers = this._layers.filter(function(l) { return l.id !== id; });
    if (this._activeLayerId === id) this._activeLayerId = this._layers[this._layers.length - 1].id;
  }

  setActiveLayer(id: string): void { this._activeLayerId = id; }

  get activeLayer(): DrawingLayer | undefined { return this._layers.find(l => l.id === this._activeLayerId); }

  layers(): DrawingLayer[] { return this._layers.slice(); }

  drawShape(shape: Shape): void {
    const layer = this.activeLayer;
    if (!layer || layer.locked) return;
    layer.shapes.push(shape);
    this._snapshot();
  }

  drawPath(points: DrawPoint[]): void {
    this.drawShape({ type: 'path', points, style: { ...this._style } });
  }

  drawLine(x1: number, y1: number, x2: number, y2: number): void {
    this.drawShape({ type: 'line', x1, y1, x2, y2, style: { ...this._style } });
  }

  drawRect(x: number, y: number, w: number, h: number): void {
    this.drawShape({ type: 'rect', x, y, w, h, style: { ...this._style } });
  }

  drawEllipse(cx: number, cy: number, rx: number, ry: number): void {
    this.drawShape({ type: 'ellipse', cx, cy, rx, ry, style: { ...this._style } });
  }

  drawText(x: number, y: number, text: string): void {
    this.drawShape({ type: 'text', x, y, text, style: { ...this._style } });
  }

  placeImage(x: number, y: number, w: number, h: number, src: string): void {
    this.drawShape({ type: 'image', x, y, w, h, src });
  }

  select(x: number, y: number, w: number, h: number): void {
    this._selection = { x, y, w, h };
  }

  clearSelection(): void { this._selection = null; }

  deleteSelected(): void {
    if (!this._selection) return;
    const sel = this._selection;
    const layer = this.activeLayer;
    if (!layer) return;
    layer.shapes = layer.shapes.filter(function(s) {
      if (s.type === 'rect') { return !(s.x >= sel.x && s.y >= sel.y && s.x + s.w <= sel.x + sel.w && s.y + s.h <= sel.y + sel.h); }
      return true;
    });
    this._snapshot();
  }

  clearLayer(id?: string): void {
    const l = id ? this._layers.find(function(x) { return x.id === id; }) : this.activeLayer;
    if (l) { l.shapes = []; this._snapshot(); }
  }

  private _snapshot(): void {
    const snap = JSON.parse(JSON.stringify(this._layers));
    this._history = this._history.slice(0, this._histPos + 1);
    this._history.push(snap);
    this._histPos = this._history.length - 1;
  }

  undo(): boolean {
    if (this._histPos <= 0) return false;
    this._histPos--;
    this._layers = JSON.parse(JSON.stringify(this._history[this._histPos]));
    return true;
  }

  redo(): boolean {
    if (this._histPos >= this._history.length - 1) return false;
    this._histPos++;
    this._layers = JSON.parse(JSON.stringify(this._history[this._histPos]));
    return true;
  }

  /** Export all visible layers as a flat SVG. */
  toSVG(): string {
    const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${this._width}" height="${this._height}">`];
    for (const layer of this._layers) {
      if (!layer.visible) continue;
      parts.push(`<g opacity="${layer.opacity}">`);
      for (const s of layer.shapes) {
        const st = (s as { style?: DrawStyle }).style;
        const style = st ? `stroke="${st.strokeColor}" fill="${st.fillColor}" stroke-width="${st.lineWidth}" opacity="${st.opacity}"` : '';
        switch (s.type) {
          case 'rect':    parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${style}/>`); break;
          case 'ellipse': parts.push(`<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${style}/>`); break;
          case 'line':    parts.push(`<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" ${style}/>`); break;
          case 'text':    parts.push(`<text x="${s.x}" y="${s.y}" font-family="${st?.fontFamily}" font-size="${st?.fontSize}" ${style}>${s.text}</text>`); break;
          case 'path': {
            const d = s.points.map(function(p, i) { return `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`; }).join(' ');
            parts.push(`<path d="${d}" fill="none" ${style}/>`);
            break;
          }
          case 'image':   parts.push(`<image x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" href="${s.src}"/>`); break;
        }
      }
      parts.push('</g>');
    }
    parts.push('</svg>');
    return parts.join('\n');
  }
}

export const documentEditor = new DocumentEditor();
export const spreadsheetApp = new SpreadsheetApp();
export const drawingCanvas  = new DrawingCanvas();
