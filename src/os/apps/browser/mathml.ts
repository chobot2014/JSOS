/**
 * JSOS Browser MathML Renderer — Item 372
 *
 * Parses MathML XML markup and renders it to a software framebuffer
 * using box-layout geometry. Supports the core MathML 3 element set.
 */

// ── MathNode types ────────────────────────────────────────────────────────────

export type MathNodeType =
  | 'math' | 'mrow' | 'mfrac' | 'msup' | 'msub' | 'msubsup'
  | 'msqrt' | 'mroot' | 'mo' | 'mn' | 'mi' | 'mtext' | 'mspace'
  | 'mover' | 'munder' | 'munderover' | 'mtable' | 'mtr' | 'mtd'
  | 'mstyle' | 'mphantom' | 'mpadded' | 'merror' | 'menclose'
  | 'mfenced' | 'mmultiscripts' | '#text';

export interface MathNode {
  type: MathNodeType;
  attrs: Record<string, string>;
  children: MathNode[];
  text?: string; // for #text nodes
}

// ── Layout metrics ────────────────────────────────────────────────────────────

export interface MathBox {
  width: number;
  height: number;
  depth: number;     // distance below baseline
  baseline: number;  // distance above bottom to baseline
}

// ── MathML Parser ─────────────────────────────────────────────────────────────

/**
 * Minimal recursive-descent XML parser — handles well-formed MathML fragments.
 * Supports element nodes, text nodes, and attributes.
 */
export function parseMathML(xml: string): MathNode {
  let pos = 0;

  function skipWs(): void {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  }

  function parseName(): string {
    const start = pos;
    while (pos < xml.length && /[a-zA-Z0-9:_\-.]/.test(xml[pos])) pos++;
    return xml.slice(start, pos);
  }

  function parseAttrValue(): string {
    const q = xml[pos]; pos++; // opening quote
    const start = pos;
    while (pos < xml.length && xml[pos] !== q) pos++;
    const val = xml.slice(start, pos);
    pos++; // closing quote
    return val;
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    while (pos < xml.length) {
      skipWs();
      if (xml[pos] === '>' || xml[pos] === '/') break;
      const name = parseName();
      if (!name) { pos++; continue; }
      skipWs();
      if (xml[pos] === '=') { pos++; skipWs(); attrs[name] = parseAttrValue(); }
      else attrs[name] = 'true';
    }
    return attrs;
  }

  function parseText(): MathNode | null {
    const start = pos;
    while (pos < xml.length && xml[pos] !== '<') pos++;
    const text = xml.slice(start, pos).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ');
    if (!text.trim()) return null;
    return { type: '#text', attrs: {}, children: [], text };
  }

  function parseNode(): MathNode | null {
    skipWs();
    if (pos >= xml.length) return null;

    if (xml[pos] !== '<') {
      return parseText();
    }

    pos++; // consume '<'

    // Comment or CDATA or processing instruction — skip
    if (xml[pos] === '!' || xml[pos] === '?') {
      while (pos < xml.length && xml[pos] !== '>') pos++;
      pos++; return null;
    }

    // Closing tag — caller will handle
    if (xml[pos] === '/') return null;

    const tag = parseName() as MathNodeType;
    const attrs = parseAttrs();
    skipWs();

    // Self-closing
    if (xml[pos] === '/') {
      pos += 2; // '/>'
      return { type: tag, attrs, children: [] };
    }

    pos++; // '>'

    const children: MathNode[] = [];
    while (pos < xml.length) {
      skipWs();
      if (xml[pos] === '<' && xml[pos+1] === '/') {
        // consume closing tag
        while (pos < xml.length && xml[pos] !== '>') pos++;
        pos++; break;
      }
      const child = parseNode();
      if (child) children.push(child);
    }

    return { type: tag, attrs, children };
  }

  // Skip XML declaration if present
  if (xml.trimStart().startsWith('<?')) {
    while (pos < xml.length && xml[pos] !== '>') pos++;
    pos++;
  }

  const root = parseNode();
  return root ?? { type: 'math', attrs: {}, children: [] };
}

// ── Layout Engine ─────────────────────────────────────────────────────────────

const FONT_RATIO = 0.6;  // approximate char width / font size
const SQRT_OVERHEAD = 4; // pixels for radical symbol overhead
const FRAC_GAP = 2;      // pixels between numerator/denominator and fraction bar
const SCRIPT_SCALE = 0.7;

export function layoutMathNode(node: MathNode, fontSize: number): MathBox {
  switch (node.type) {
    case '#text': return layoutText(node.text ?? '', fontSize);
    case 'math':
    case 'mrow':
    case 'mfenced':
    case 'menclose': return layoutRow(node.children, fontSize);
    case 'mfrac':    return layoutFrac(node, fontSize);
    case 'msup':     return layoutScript(node, fontSize, 'sup');
    case 'msub':     return layoutScript(node, fontSize, 'sub');
    case 'msubsup':  return layoutSubSup(node, fontSize);
    case 'msqrt':    return layoutSqrt(node, fontSize);
    case 'mroot':    return layoutRoot(node, fontSize);
    case 'mover':    return layoutOver(node, fontSize);
    case 'munder':   return layoutUnder(node, fontSize);
    case 'munderover': return layoutUnderOver(node, fontSize);
    case 'mtable':   return layoutTable(node, fontSize);
    case 'mtr': case 'mtd': return layoutRow(node.children, fontSize);
    case 'mspace':   return layoutSpace(node, fontSize);
    case 'mstyle': {
      const sz = node.attrs.mathsize ? parseFontSize(node.attrs.mathsize, fontSize) : fontSize;
      return layoutRow(node.children, sz);
    }
    case 'mphantom': {
      const box = layoutRow(node.children, fontSize);
      return { ...box }; // same size, invisible
    }
    default:
      return layoutText(node.text ?? collectText(node), fontSize);
  }
}

function layoutText(text: string, fontSize: number): MathBox {
  const width = text.length * fontSize * FONT_RATIO;
  const depth = fontSize * 0.2;
  const height = fontSize;
  return { width, height, depth, baseline: height - depth };
}

function layoutRow(children: MathNode[], fontSize: number): MathBox {
  if (!children.length) return { width: 0, height: fontSize, depth: 0, baseline: fontSize };
  let width = 0, maxAbove = 0, maxDepth = 0;
  for (const child of children) {
    const b = layoutMathNode(child, fontSize);
    width += b.width;
    maxAbove = Math.max(maxAbove, b.baseline);
    maxDepth = Math.max(maxDepth, b.depth);
  }
  return { width, height: maxAbove + maxDepth, depth: maxDepth, baseline: maxAbove };
}

function layoutFrac(node: MathNode, fontSize: number): MathBox {
  const num = node.children[0] ? layoutMathNode(node.children[0], fontSize * 0.85) : { width:20, height:fontSize/2, depth:0, baseline:fontSize/2 };
  const den = node.children[1] ? layoutMathNode(node.children[1], fontSize * 0.85) : { width:20, height:fontSize/2, depth:0, baseline:fontSize/2 };
  const width = Math.max(num.width, den.width) + 4;
  const barY = fontSize * 0.25; // fraction bar position relative to baseline
  const above = num.height + FRAC_GAP + 1;
  const below = den.height + FRAC_GAP + 1;
  return { width, height: above + below, depth: below - barY, baseline: above + barY };
}

function layoutScript(node: MathNode, fontSize: number, type: 'sup' | 'sub'): MathBox {
  const base = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:fontSize, height:fontSize, depth:0, baseline:fontSize };
  const scriptFontSize = fontSize * SCRIPT_SCALE;
  const script = node.children[1] ? layoutMathNode(node.children[1], scriptFontSize) : { width:0, height:0, depth:0, baseline:0 };
  const width = base.width + script.width;
  if (type === 'sup') {
    const above = base.baseline + script.height * 0.7;
    const below = base.depth;
    return { width, height: above + below, depth: below, baseline: above };
  } else {
    const above = base.baseline;
    const below = base.depth + script.height * 0.6;
    return { width, height: above + below, depth: below, baseline: above };
  }
}

function layoutSubSup(node: MathNode, fontSize: number): MathBox {
  const base = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:fontSize, height:fontSize, depth:0, baseline:fontSize };
  const sf = fontSize * SCRIPT_SCALE;
  const sub = node.children[1] ? layoutMathNode(node.children[1], sf) : { width:0, height:0, depth:0, baseline:0 };
  const sup = node.children[2] ? layoutMathNode(node.children[2], sf) : { width:0, height:0, depth:0, baseline:0 };
  const width = base.width + Math.max(sub.width, sup.width);
  const above = base.baseline + sup.height * 0.7;
  const below = base.depth + sub.height * 0.6;
  return { width, height: above + below, depth: below, baseline: above };
}

function layoutSqrt(node: MathNode, fontSize: number): MathBox {
  const inner = layoutRow(node.children, fontSize);
  return {
    width: inner.width + fontSize + 4,
    height: inner.height + SQRT_OVERHEAD,
    depth: inner.depth,
    baseline: inner.baseline + SQRT_OVERHEAD,
  };
}

function layoutRoot(node: MathNode, fontSize: number): MathBox {
  const inner = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:20, height:fontSize, depth:0, baseline:fontSize };
  // index (degree)
  return {
    width: inner.width + fontSize + 8,
    height: inner.height + SQRT_OVERHEAD,
    depth: inner.depth,
    baseline: inner.baseline + SQRT_OVERHEAD,
  };
}

function layoutOver(node: MathNode, fontSize: number): MathBox {
  const base = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:20, height:fontSize, depth:0, baseline:fontSize };
  const over = node.children[1] ? layoutMathNode(node.children[1], fontSize * 0.75) : { width:0, height:0, depth:0, baseline:0 };
  const width = Math.max(base.width, over.width);
  return { width, height: base.height + over.height + 2, depth: base.depth, baseline: base.baseline + over.height + 2 };
}

function layoutUnder(node: MathNode, fontSize: number): MathBox {
  const base = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:20, height:fontSize, depth:0, baseline:fontSize };
  const under = node.children[1] ? layoutMathNode(node.children[1], fontSize * 0.75) : { width:0, height:0, depth:0, baseline:0 };
  const width = Math.max(base.width, under.width);
  return { width, height: base.height + under.height + 2, depth: base.depth + under.height + 2, baseline: base.baseline };
}

function layoutUnderOver(node: MathNode, fontSize: number): MathBox {
  const base = node.children[0] ? layoutMathNode(node.children[0], fontSize) : { width:20, height:fontSize, depth:0, baseline:fontSize };
  const under = node.children[1] ? layoutMathNode(node.children[1], fontSize * 0.75) : { width:0, height:0, depth:0, baseline:0 };
  const over = node.children[2] ? layoutMathNode(node.children[2], fontSize * 0.75) : { width:0, height:0, depth:0, baseline:0 };
  const width = Math.max(base.width, under.width, over.width);
  return {
    width,
    height: base.height + under.height + over.height + 4,
    depth: base.depth + under.height + 2,
    baseline: base.baseline + over.height + 2,
  };
}

function layoutTable(node: MathNode, fontSize: number): MathBox {
  const rows = node.children.filter(c => c.type === 'mtr');
  if (!rows.length) return { width: 0, height: 0, depth: 0, baseline: fontSize };
  let totalH = 0, maxW = 0;
  for (const row of rows) {
    const cells = row.children.filter(c => c.type === 'mtd');
    const rowH = cells.reduce((h, cell) => Math.max(h, layoutMathNode(cell, fontSize).height), fontSize);
    const rowW = cells.reduce((w, cell) => w + layoutMathNode(cell, fontSize).width + 8, 0);
    totalH += rowH + 4;
    maxW = Math.max(maxW, rowW);
  }
  return { width: maxW, height: totalH, depth: 0, baseline: totalH };
}

function layoutSpace(node: MathNode, fontSize: number): MathBox {
  const w = node.attrs.width ? parseFontSize(node.attrs.width, fontSize) : fontSize * 0.5;
  return { width: w, height: fontSize, depth: 0, baseline: fontSize };
}

function parseFontSize(val: string, base: number): number {
  if (val.endsWith('em')) return base * parseFloat(val);
  if (val.endsWith('px')) return parseFloat(val);
  if (val === 'small') return base * 0.75;
  if (val === 'big' || val === 'large') return base * 1.25;
  return parseFloat(val) || base;
}

function collectText(node: MathNode): string {
  if (node.type === '#text') return node.text ?? '';
  return node.children.map(collectText).join('');
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export class MathMLRenderer {
  private _fb: Uint8Array;
  private _w: number;
  private _h: number;
  private _color: [number, number, number] = [0, 0, 0];

  constructor(framebuffer: Uint8Array, width: number, height: number) {
    this._fb = framebuffer;
    this._w = width;
    this._h = height;
  }

  setColor(r: number, g: number, b: number): void { this._color = [r, g, b]; }

  /** Render a MathML string at position (x, y) with the given font size */
  renderMathML(xml: string, x: number, y: number, fontSize = 16): void {
    const root = parseMathML(xml);
    this.renderNode(root, x, y, fontSize);
  }

  /** Render a parsed MathNode at position (x, y) */
  renderNode(node: MathNode, x: number, y: number, fontSize: number): void {
    switch (node.type) {
      case '#text': this._drawText(node.text ?? '', x, y, fontSize); break;
      case 'math':
      case 'mrow':
      case 'mfenced': this._renderRow(node.children, x, y, fontSize); break;
      case 'mfrac':   this._renderFrac(node, x, y, fontSize); break;
      case 'msup':    this._renderScript(node, x, y, fontSize, 'sup'); break;
      case 'msub':    this._renderScript(node, x, y, fontSize, 'sub'); break;
      case 'msubsup': this._renderSubSup(node, x, y, fontSize); break;
      case 'msqrt':   this._renderSqrt(node, x, y, fontSize); break;
      case 'mroot':   this._renderRoot(node, x, y, fontSize); break;
      case 'mover':   this._renderOver(node, x, y, fontSize); break;
      case 'munder':  this._renderUnder(node, x, y, fontSize); break;
      case 'mtable':  this._renderTable(node, x, y, fontSize); break;
      case 'mphantom': break; // invisible
      case 'mstyle': {
        const sz = node.attrs.mathsize ? parseFontSize(node.attrs.mathsize, fontSize) : fontSize;
        this._renderRow(node.children, x, y, sz);
        break;
      }
      default: this._renderRow(node.children, x, y, fontSize); break;
    }
  }

  // ── Private render helpers ─────────────────────────────────────────────────

  private _renderRow(children: MathNode[], x: number, y: number, fs: number): void {
    let cx = x;
    for (const child of children) {
      this.renderNode(child, cx, y, fs);
      cx += layoutMathNode(child, fs).width;
    }
  }

  private _renderFrac(node: MathNode, x: number, y: number, fs: number): void {
    const num = node.children[0];
    const den = node.children[1];
    const numBox = num ? layoutMathNode(num, fs * 0.85) : { width: 20, height: fs/2, depth: 0, baseline: fs/2 };
    const denBox = den ? layoutMathNode(den, fs * 0.85) : { width: 20, height: fs/2, depth: 0, baseline: fs/2 };
    const width = Math.max(numBox.width, denBox.width) + 4;
    const numX = x + (width - numBox.width) / 2;
    const denX = x + (width - denBox.width) / 2;
    const barY = y + numBox.height + FRAC_GAP;

    if (num) this.renderNode(num, numX, y, fs * 0.85);
    // Draw fraction bar
    this._drawHLine(x, barY, width);
    if (den) this.renderNode(den, denX, barY + 1 + FRAC_GAP, fs * 0.85);
  }

  private _renderScript(node: MathNode, x: number, y: number, fs: number, type: 'sup' | 'sub'): void {
    const base = node.children[0];
    const script = node.children[1];
    const baseBox = base ? layoutMathNode(base, fs) : { width: fs, height: fs, depth: 0, baseline: fs };
    if (base) this.renderNode(base, x, y, fs);
    const sf = fs * SCRIPT_SCALE;
    const sx = x + baseBox.width;
    const sy = type === 'sup' ? y - Math.round(sf * 0.5) : y + Math.round(fs * 0.4);
    if (script) this.renderNode(script, sx, sy, sf);
  }

  private _renderSubSup(node: MathNode, x: number, y: number, fs: number): void {
    const [base, sub, sup] = node.children;
    const baseBox = base ? layoutMathNode(base, fs) : { width: fs, height: fs, depth: 0, baseline: fs };
    if (base) this.renderNode(base, x, y, fs);
    const sf = fs * SCRIPT_SCALE;
    const sx = x + baseBox.width;
    if (sub) this.renderNode(sub, sx, y + Math.round(fs * 0.4), sf);
    if (sup) this.renderNode(sup, sx, y - Math.round(sf * 0.5), sf);
  }

  private _renderSqrt(node: MathNode, x: number, y: number, fs: number): void {
    const box = layoutRow(node.children, fs);
    const rx = x + fs; // content starts after radical symbol
    // Draw √ symbol
    this._drawLine(x, y + box.height - 2, x + 4, y + box.height);     // bottom-left tick
    this._drawLine(x + 4, y + box.height, x + fs - 2, y + 2);          // diagonal up
    this._drawHLine(x + fs - 2, y, box.width + 4);                     // overbar
    // Render content
    this._renderRow(node.children, rx, y + SQRT_OVERHEAD, fs);
  }

  private _renderRoot(node: MathNode, x: number, y: number, fs: number): void {
    const base = node.children[0];
    const idx = node.children[1];
    if (idx) this.renderNode(idx, x, y, fs * 0.55);
    const rx = x + fs + 4;
    if (base) {
      const box = layoutMathNode(base, fs);
      this._drawLine(rx - 4, y + box.height - 2, rx, y + box.height);
      this._drawLine(rx, y + box.height, rx + fs - 2, y + 2);
      this._drawHLine(rx + fs - 2, y, box.width + 4);
      this.renderNode(base, rx + fs, y + SQRT_OVERHEAD, fs);
    }
  }

  private _renderOver(node: MathNode, x: number, y: number, fs: number): void {
    const [base, over] = node.children;
    const overBox = over ? layoutMathNode(over, fs * 0.75) : { width: 0, height: 0, depth: 0, baseline: 0 };
    const baseBox = base ? layoutMathNode(base, fs) : { width: 0, height: 0, depth: 0, baseline: 0 };
    const baseX = x + Math.max(0, (overBox.width - baseBox.width) / 2);
    const overX = x + Math.max(0, (baseBox.width - overBox.width) / 2);
    if (over) this.renderNode(over, overX, y, fs * 0.75);
    if (base) this.renderNode(base, baseX, y + overBox.height + 2, fs);
  }

  private _renderUnder(node: MathNode, x: number, y: number, fs: number): void {
    const [base, under] = node.children;
    const baseBox = base ? layoutMathNode(base, fs) : { width: 0, height: 0, depth: 0, baseline: 0 };
    const underBox = under ? layoutMathNode(under, fs * 0.75) : { width: 0, height: 0, depth: 0, baseline: 0 };
    const baseX = x + Math.max(0, (underBox.width - baseBox.width) / 2);
    const underX = x + Math.max(0, (baseBox.width - underBox.width) / 2);
    if (base) this.renderNode(base, baseX, y, fs);
    if (under) this.renderNode(under, underX, y + baseBox.height + 2, fs * 0.75);
  }

  private _renderTable(node: MathNode, x: number, y: number, fs: number): void {
    const rows = node.children.filter(c => c.type === 'mtr');
    let cy = y;
    for (const row of rows) {
      let cx = x;
      const cells = row.children.filter(c => c.type === 'mtd');
      for (const cell of cells) {
        this._renderRow(cell.children, cx, cy, fs);
        cx += layoutMathNode(cell, fs).width + 8;
      }
      const rowH = cells.reduce((h, c) => Math.max(h, layoutMathNode(c, fs).height), fs);
      cy += rowH + 4;
    }
  }

  // ── Pixel-level drawing ────────────────────────────────────────────────────

  private _setPixel(x: number, y: number): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= this._w || y < 0 || y >= this._h) return;
    const i = (y * this._w + x) * 4;
    this._fb[i]   = this._color[0];
    this._fb[i+1] = this._color[1];
    this._fb[i+2] = this._color[2];
    this._fb[i+3] = 255;
  }

  private _drawHLine(x: number, y: number, w: number): void {
    for (let dx = 0; dx < w; dx++) this._setPixel(x + dx, y);
  }

  private _drawLine(x1: number, y1: number, x2: number, y2: number): void {
    const dx = Math.abs(x2-x1), dy = Math.abs(y2-y1);
    const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
    let err = dx - dy, cx = x1, cy = y1;
    while (true) {
      this._setPixel(cx, cy);
      if (cx === x2 && cy === y2) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
  }

  private _drawText(text: string, x: number, y: number, fontSize: number): void {
    // Use a minimal 1-bit font approximation
    // Characters are drawn as rect blocks scaled to fontSize
    const charW = Math.round(fontSize * FONT_RATIO);
    const charH = Math.round(fontSize);
    let cx = x;
    for (const ch of text) {
      // Draw character outline as filled rectangle
      const bitmap = SIMPLE_GLYPHS[ch];
      if (bitmap) {
        const scale = Math.max(1, Math.round(fontSize / 8));
        for (let row = 0; row < bitmap.length; row++) {
          const bits = bitmap[row];
          for (let col = 0; col < 5; col++) {
            if (bits & (1 << (4 - col))) {
              for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
                this._setPixel(cx + col*scale + sx, y + row*scale + sy);
              }
            }
          }
        }
      } else {
        // Fallback: draw a simple filled box for unknown chars
        for (let dy = 2; dy < charH-2; dy++) { this._setPixel(cx, y+dy); this._setPixel(cx+charW-1, y+dy); }
        for (let dx = 0; dx < charW; dx++) { this._setPixel(cx+dx, y+2); this._setPixel(cx+dx, y+charH-3); }
      }
      cx += charW;
    }
  }
}

// ── Minimal glyph set for math symbols ────────────────────────────────────────
// 5-wide, 7-tall bitmaps. One row = 5 bits (bit4 = left)

const SIMPLE_GLYPHS: Record<string, number[]> = {
  '+': [0,4,4,31,4,4,0],
  '-': [0,0,0,31,0,0,0],
  '=': [0,0,31,0,31,0,0],
  '×': [0,17,10,4,10,17,0],
  '÷': [0,4,0,31,0,4,0],
  '∑': [31,16,8,12,8,16,31],
  '∏': [31,17,17,17,17,17,17],
  '∫': [6,8,8,8,8,8,6],
  '√': [0,3,4,4,20,8,16],
  '∞': [0,0,10,21,10,0,0],
  '≤': [0,15,8,14,8,8,15],
  '≥': [0,30,1,14,1,1,30],
  '≠': [0,2,31,4,31,8,0],
  '∈': [7,8,8,14,8,8,7],
  '∉': [7,10,12,14,12,10,7],
  '⊂': [6,8,8,8,8,8,6],
  '∪': [17,17,17,17,17,17,14],
  '∩': [14,17,17,17,17,17,17],
  '∀': [14,17,17,31,17,17,17],
  '∃': [31,16,30,16,16,16,31],
  '′': [6,4,4,0,0,0,0],
  '(': [2,4,8,8,8,4,2],
  ')': [8,4,2,2,2,4,8],
  '[': [14,8,8,8,8,8,14],
  ']': [14,2,2,2,2,2,14],
  '{': [6,8,8,16,8,8,6],
  '}': [12,2,2,1,2,2,12],
  '|': [4,4,4,4,4,4,4],
  ' ': [0,0,0,0,0,0,0],
};
// Add alphanumerics
for (let i = 0; i < 10; i++) {
  SIMPLE_GLYPHS[String(i)] = [0,0,0,0,0,0,0]; // placeholder
}
for (let c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') {
  SIMPLE_GLYPHS[c] = [0,0,0,0,0,0,0]; // placeholder — real font in canvas2d.ts
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const mathml = {
  parseMathML,
  layoutMathNode,
  MathMLRenderer,
};
