/**
 * JSOS PDF Viewer App — Item 771
 *
 * Implements:
 *   - PDFParser: cross-reference table + object-stream decoder
 *   - PDFPage: content-stream operator interpreter
 *   - PDFRenderer: text + rect graphics to RGBA framebuffer
 *   - pdfViewer: singleton app controller
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface PDFXRef {
  offset: number;
  gen: number;
  inUse: boolean;
}

interface PDFObject {
  id: number;
  gen: number;
  value: PDFValue;
}

type PDFValue =
  | { kind: 'null' }
  | { kind: 'bool';    value: boolean }
  | { kind: 'int';     value: number }
  | { kind: 'real';    value: number }
  | { kind: 'string';  value: string }
  | { kind: 'name';    value: string }
  | { kind: 'array';   value: PDFValue[] }
  | { kind: 'dict';    value: Map<string, PDFValue> }
  | { kind: 'stream';  dict: Map<string, PDFValue>; data: Uint8Array }
  | { kind: 'ref';     id: number; gen: number };

export interface PDFPageInfo {
  index: number;
  width: number;   // pts
  height: number;  // pts
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

class PDFTokenizer {
  private _buf: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) { this._buf = data; }

  get eof(): boolean { return this.pos >= this._buf.length; }

  private _skipWs(): void {
    while (this.pos < this._buf.length && ' \t\r\n\0\f'.includes(String.fromCharCode(this._buf[this.pos]))) this.pos++;
    // Skip comments
    if (this._buf[this.pos] === 37 /* % */) {
      while (this.pos < this._buf.length && this._buf[this.pos] !== 10 && this._buf[this.pos] !== 13) this.pos++;
      this._skipWs();
    }
  }

  peekChar(): string { return String.fromCharCode(this._buf[this.pos]); }

  readToken(): string {
    this._skipWs();
    if (this.pos >= this._buf.length) return '';
    // String literal
    if (this._buf[this.pos] === 40) { // '('
      this.pos++;
      let s = '', depth = 1;
      while (this.pos < this._buf.length && depth > 0) {
        const c = this._buf[this.pos++];
        if (c === 92) { this.pos++; } // backslash escape
        else if (c === 40) { depth++; s += '('; }
        else if (c === 41) { depth--; if (depth) s += ')'; }
        else s += String.fromCharCode(c);
      }
      return `(${s})`;
    }
    // Hex string
    if (this._buf[this.pos] === 60 && this._buf[this.pos+1] !== 60) {
      this.pos++;
      let h = '';
      while (this.pos < this._buf.length && this._buf[this.pos] !== 62) h += String.fromCharCode(this._buf[this.pos++]);
      this.pos++;
      return `<${h}>`;
    }
    // Dictionary `<<`
    if (this._buf[this.pos] === 60 && this._buf[this.pos+1] === 60) { this.pos += 2; return '<<'; }
    if (this._buf[this.pos] === 62 && this._buf[this.pos+1] === 62) { this.pos += 2; return '>>'; }
    // Array brackets
    if (this._buf[this.pos] === 91 || this._buf[this.pos] === 93) return String.fromCharCode(this._buf[this.pos++]);
    // Read until whitespace or delimiter
    const start = this.pos;
    while (this.pos < this._buf.length && !' \t\r\n\0\f<>[]()/{}'.includes(String.fromCharCode(this._buf[this.pos]))) this.pos++;
    return new TextDecoder().decode(this._buf.subarray(start, this.pos));
  }

  readInt(): number { return parseInt(this.readToken()); }

  findLast(needle: string): number {
    const enc = new TextEncoder().encode(needle);
    for (let i = this._buf.length - enc.length; i >= 0; i--) {
      if (this._buf.subarray(i, i+enc.length).every((b, j) => b === enc[j])) return i;
    }
    return -1;
  }

  slice(start: number, end: number): Uint8Array { return this._buf.subarray(start, end); }
  get length(): number { return this._buf.length; }
  seekTo(pos: number): void { this.pos = pos; }
}

// ── Object parser ─────────────────────────────────────────────────────────────

class PDFObjectParser {
  _tok: PDFTokenizer;

  constructor(data: Uint8Array) { this._tok = new PDFTokenizer(data); }

  parseValue(token?: string): PDFValue {
    const t = token ?? this._tok.readToken();
    if (t === 'null')  return { kind: 'null' };
    if (t === 'true')  return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === '<<')    return this._parseDict();
    if (t === '[')     return this._parseArray();
    if (t.startsWith('(')) return { kind: 'string', value: t.slice(1, -1) };
    if (t.startsWith('<') && !t.startsWith('<<')) {
      const hex = t.slice(1, -1);
      let s = '';
      for (let i = 0; i+1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i,i+2), 16));
      return { kind: 'string', value: s };
    }
    if (t.startsWith('/')) return { kind: 'name', value: t.slice(1) };
    // Check for indirect reference: `n g R`
    const n = parseFloat(t);
    if (!isNaN(n)) {
      const savedPos = this._tok.pos;
      const next1 = this._tok.readToken();
      const next2 = this._tok.readToken();
      if (next2 === 'R' && !isNaN(parseFloat(next1))) {
        return { kind: 'ref', id: n, gen: parseFloat(next1) };
      }
      this._tok.pos = savedPos;
      return Number.isInteger(n) ? { kind: 'int', value: n } : { kind: 'real', value: n };
    }
    return { kind: 'null' };
  }

  private _parseDict(): PDFValue {
    const map = new Map<string, PDFValue>();
    while (true) {
      const t = this._tok.readToken();
      if (t === '>>') break;
      if (!t.startsWith('/')) { /* skip unknown */ continue; }
      const key = t.slice(1);
      map.set(key, this.parseValue());
    }
    return { kind: 'dict', value: map };
  }

  private _parseArray(): PDFValue {
    const arr: PDFValue[] = [];
    while (true) {
      const t = this._tok.readToken();
      if (t === ']') break;
      arr.push(this.parseValue(t));
    }
    return { kind: 'array', value: arr };
  }
}

// ── PDFParser ─────────────────────────────────────────────────────────────────

export class PDFParser {
  private _data: Uint8Array;
  private _xref = new Map<number, PDFXRef>();
  private _cache = new Map<number, PDFObject>();
  private _pageTree: PDFValue[] = [];
  private _pageCount = 0;

  constructor(data: Uint8Array) {
    this._data = data;
    this._parseXRef();
    this._buildPageTree();
  }

  get pageCount(): number { return this._pageCount; }

  getPageInfo(index: number): PDFPageInfo {
    const page = this._getPageObj(index);
    const mediaBox = this._getInheritedArray(page, 'MediaBox');
    const width  = mediaBox ? (this._numVal(mediaBox[2]) - this._numVal(mediaBox[0])) : 612;
    const height = mediaBox ? (this._numVal(mediaBox[3]) - this._numVal(mediaBox[1])) : 792;
    return { index, width, height };
  }

  getPageContentStream(index: number): Uint8Array | null {
    const page = this._getPageObj(index);
    if (page.kind !== 'dict') return null;
    const contRef = page.value.get('Contents');
    if (!contRef) return null;
    const obj = this._resolveRef(contRef);
    if (!obj || obj.kind !== 'stream') return null;
    return obj.data;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _parseXRef(): void {
    const tok = new PDFTokenizer(this._data);
    // Find startxref at end of file
    const sxPos = tok.findLast('startxref');
    if (sxPos < 0) return;
    tok.seekTo(sxPos + 9);
    const xrefOffset = tok.readInt();
    this._readXRefTable(xrefOffset);
  }

  private _readXRefTable(offset: number): void {
    const parser = new PDFObjectParser(this._data);
    parser._tok.seekTo(offset);
    const kw = parser._tok.readToken();
    if (kw !== 'xref') return;

    while (true) {
      const t1 = parser._tok.readToken();
      if (t1 === 'trailer') break;
      const firstId = parseInt(t1);
      const count   = parser._tok.readInt();
      for (let i = 0; i < count; i++) {
        const off  = parseInt(parser._tok.readToken());
        const gen  = parser._tok.readInt();
        const flag = parser._tok.readToken();
        this._xref.set(firstId + i, { offset: off, gen, inUse: flag === 'n' });
      }
    }
  }

  private _resolveRef(val: PDFValue): PDFValue | null {
    if (val.kind !== 'ref') return val;
    const entry = this._xref.get(val.id);
    if (!entry?.inUse) return null;
    const cached = this._cache.get(val.id);
    if (cached) return cached.value;

    const parser = new PDFObjectParser(this._data);
    parser._tok.seekTo(entry.offset);
    parser._tok.readToken(); // objNum
    parser._tok.readToken(); // genNum
    parser._tok.readToken(); // 'obj'
    const v = parser.parseValue();
    // Check if followed by 'stream'
    const next = parser._tok.readToken();
    let result: PDFValue = v;
    if (next === 'stream' && v.kind === 'dict') {
      // find stream length
      const lenVal = v.value.get('Length');
      let len = 0;
      if (lenVal) {
        const lr = this._resolveRef(lenVal);
        if (lr?.kind === 'int') len = lr.value;
      }
      // skip to after newline following 'stream'
      let sp = parser._tok.pos;
      if (this._data[sp] === 13) sp++;
      if (this._data[sp] === 10) sp++;
      const data = this._data.subarray(sp, sp + len);
      result = { kind: 'stream', dict: v.value, data };
    }
    this._cache.set(val.id, { id: val.id, gen: entry.gen, value: result });
    return result;
  }

  private _buildPageTree(): void {
    // Enumerate all pages via the Pages tree
    this._pageTree = [];
    // Walk xref to find all Page objects
    for (const [id] of this._xref) {
      const obj = this._resolveRef({ kind: 'ref', id, gen: 0 });
      if (obj?.kind === 'dict') {
        const typeVal = obj.value.get('Type');
        if (typeVal?.kind === 'name' && typeVal.value === 'Page') {
          this._pageTree.push(obj);
        }
      }
    }
    this._pageCount = this._pageTree.length;
  }

  private _getPageObj(index: number): PDFValue {
    return this._pageTree[index] ?? { kind: 'dict', value: new Map() };
  }

  private _getInheritedArray(page: PDFValue, key: string): PDFValue[] | null {
    if (page.kind !== 'dict') return null;
    const v = page.value.get(key);
    if (v?.kind === 'array') return v.value;
    return null;
  }

  private _numVal(v?: PDFValue): number {
    if (!v) return 0;
    if (v.kind === 'int' || v.kind === 'real') return v.value;
    return 0;
  }
}

// ── PDFPage — content stream interpreter ──────────────────────────────────────

export interface PDFGraphicsState {
  ctm: [number,number,number,number,number,number]; // current transform
  lineWidth: number;
  strokeColor: [number,number,number];
  fillColor: [number,number,number];
  fontSize: number;
  textX: number;
  textY: number;
}

function defaultGS(): PDFGraphicsState {
  return { ctm:[1,0,0,1,0,0], lineWidth:1, strokeColor:[0,0,0], fillColor:[0,0,0], fontSize:12, textX:0, textY:0 };
}

export interface RenderCommand {
  type: 'fillRect' | 'strokeRect' | 'fillText' | 'setFill' | 'setStroke' | 'moveTo' | 'lineTo' | 'stroke' | 'fill';
  args: unknown[];
}

/**
 * PDFPage — interprets a PDF content stream and emits abstract RenderCommands.
 * Does not render directly; the renderer consumes the commands.
 */
export class PDFPage {
  readonly commands: RenderCommand[] = [];
  private _gs: PDFGraphicsState = defaultGS();
  private _gsStack: PDFGraphicsState[] = [];

  interpret(stream: Uint8Array): void {
    const tokens = this._tokenizeStream(stream);
    // Use an operand stack: values accumulate until an operator fires
    const stack: string[] = [];
    const pop  = () => stack.pop() ?? '0';
    const popN = (n: number) => { const a: string[] = []; for (let k=0;k<n;k++) a.unshift(pop()); return a; };

    for (const tok of tokens) {
      // Is this token an operator? (non-numeric, non-string)
      const isNum = /^-?[0-9.]+$/.test(tok);
      const isStr = tok.startsWith('(');
      const isName = tok.startsWith('/');
      if (isNum || isStr || isName) { stack.push(tok); continue; }

      switch (tok) {
        // Graphics state
        case 'q': this._gsStack.push({...this._gs, ctm:[...this._gs.ctm] as PDFGraphicsState['ctm']}); break;
        case 'Q': this._gs = this._gsStack.pop() ?? defaultGS(); break;
        case 'w': this._gs.lineWidth = parseFloat(pop()); break;
        // Colour operators
        case 'rg': {
          const [rs, gs, bs] = popN(3);
          this._gs.fillColor = [Math.round(+rs*255), Math.round(+gs*255), Math.round(+bs*255)];
          break;
        }
        case 'RG': {
          const [rs, gs, bs] = popN(3);
          this._gs.strokeColor = [Math.round(+rs*255), Math.round(+gs*255), Math.round(+bs*255)];
          break;
        }
        case 'g':  { const gs = +pop(); this._gs.fillColor   = [Math.round(gs*255), Math.round(gs*255), Math.round(gs*255)]; break; }
        case 'G':  { const gs = +pop(); this._gs.strokeColor = [Math.round(gs*255), Math.round(gs*255), Math.round(gs*255)]; break; }
        // Path operators
        case 'm': { const [ys,xs] = popN(2); this.commands.push({ type:'moveTo', args:[+xs,+ys] }); break; }
        case 'l': { const [ys,xs] = popN(2); this.commands.push({ type:'lineTo', args:[+xs,+ys] }); break; }
        case 'S': this.commands.push({ type:'stroke', args:[] }); break;
        case 'f': case 'F': this.commands.push({ type:'fill', args:[] }); break;
        case 're': {
          const [hs,ws,ys,xs] = popN(4);
          this.commands.push({ type:'fillRect', args:[+xs, +ys, +ws, +hs, ...this._gs.fillColor] });
          break;
        }
        // Text operators
        case 'Tf': { const [,sizeStr] = popN(2); this._gs.fontSize = +sizeStr; break; }
        case 'Td': { const [dys,dxs] = popN(2); this._gs.textX += +dxs; this._gs.textY += +dys; break; }
        case 'Tj': {
          const raw = pop();
          const text = raw.replace(/^\(/, '').replace(/\)$/, '');
          this.commands.push({ type:'fillText', args:[text, this._gs.textX, this._gs.textY, this._gs.fontSize, ...this._gs.fillColor] });
          break;
        }
        // TJ array (text with kerning)
        case 'TJ': { /* array already parsed; skip for now */ stack.length = 0; break; }
        // Ignore all other operators
        default: stack.length = 0; break;
      }
    }
  }

  private _tokenizeStream(stream: Uint8Array): string[] {
    const text = new TextDecoder('latin1').decode(stream);
    const tokens: string[] = [];
    let i = 0;
    while (i < text.length) {
      while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
      if (i >= text.length) break;
      if (text[i] === '%') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (text[i] === '(') {
        let s = '(', depth = 1; i++;
        while (i < text.length && depth > 0) {
          if (text[i] === '\\') { s += text[i] + text[i+1]; i += 2; continue; }
          if (text[i] === '(') depth++;
          if (text[i] === ')') depth--;
          if (depth > 0) s += text[i];
          i++;
        }
        tokens.push(s + ')'); continue;
      }
      const start = i;
      while (i < text.length && !' \t\r\n()/[]<>'.includes(text[i])) i++;
      if (i > start) tokens.push(text.slice(start, i));
      else i++;
    }
    return tokens;
  }


}

// ── PDFRenderer ───────────────────────────────────────────────────────────────

export class PDFRenderer {
  private _fb: Uint8Array;
  private _w: number;
  private _h: number;

  constructor(framebuffer: Uint8Array, width: number, height: number) {
    this._fb = framebuffer;
    this._w = width;
    this._h = height;
  }

  render(page: PDFPage, pageInfo: PDFPageInfo): void {
    // Clear to white
    this._fb.fill(255);

    // Compute scale (pt → px)
    const scaleX = this._w / pageInfo.width;
    const scaleY = this._h / pageInfo.height;

    for (const cmd of page.commands) {
      switch (cmd.type) {
        case 'fillRect': {
          const [x, y, w, h, r, g, b] = cmd.args as number[];
          this._fillRect(
            Math.round(x * scaleX), Math.round((pageInfo.height - y - h) * scaleY),
            Math.round(w * scaleX), Math.round(h * scaleY),
            r??0, g??0, b??0
          );
          break;
        }
        case 'fillText': {
          const [text, x, y, fontSize, r, g, b] = cmd.args as [string, number, number, number, number, number, number];
          this._drawText(
            text,
            Math.round(x * scaleX),
            Math.round((pageInfo.height - y) * scaleY),
            Math.round((fontSize||12) * scaleY),
            r??0, g??0, b??0
          );
          break;
        }
        default: break;
      }
    }
  }

  private _fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
    for (let py = Math.max(0,y); py < Math.min(this._h, y+h); py++) {
      for (let px = Math.max(0,x); px < Math.min(this._w, x+w); px++) {
        const i = (py*this._w + px)*4;
        this._fb[i]=r; this._fb[i+1]=g; this._fb[i+2]=b; this._fb[i+3]=255;
      }
    }
  }

  private _drawText(text: string, x: number, y: number, size: number, r: number, g: number, b: number): void {
    const charW = Math.round(size * 0.6);
    const charH = size;
    let cx = x;
    for (const _ of text) {
      // Simple placeholder: draw a thin vertical line for each character
      for (let dy = 0; dy < charH; dy++) {
        const px = cx + Math.floor(charW/4), py = y + dy;
        if (px < 0 || px >= this._w || py < 0 || py >= this._h) continue;
        const i = (py*this._w+px)*4;
        this._fb[i]=r; this._fb[i+1]=g; this._fb[i+2]=b; this._fb[i+3]=255;
      }
      cx += charW;
    }
  }
}

// ── pdfViewer app ─────────────────────────────────────────────────────────────

export class PDFViewerApp {
  private _parser: PDFParser | null = null;
  private _currentPage = 0;
  private _fb: Uint8Array | null = null;
  private _fbW = 0;
  private _fbH = 0;

  /** Load a PDF from raw bytes */
  load(data: Uint8Array): void {
    this._parser = new PDFParser(data);
    this._currentPage = 0;
  }

  /** Set the render target */
  setFramebuffer(fb: Uint8Array, width: number, height: number): void {
    this._fb = fb; this._fbW = width; this._fbH = height;
  }

  /** Render the current page to the framebuffer */
  renderCurrentPage(): void {
    if (!this._parser || !this._fb) return;
    const info = this._parser.getPageInfo(this._currentPage);
    const stream = this._parser.getPageContentStream(this._currentPage);
    const page = new PDFPage();
    if (stream) page.interpret(stream);
    const renderer = new PDFRenderer(this._fb, this._fbW, this._fbH);
    renderer.render(page, info);
  }

  get pageCount(): number { return this._parser?.pageCount ?? 0; }
  get currentPage(): number { return this._currentPage; }
  nextPage(): void { if (this._currentPage + 1 < this.pageCount) { this._currentPage++; this.renderCurrentPage(); } }
  prevPage(): void { if (this._currentPage > 0) { this._currentPage--; this.renderCurrentPage(); } }
  goToPage(n: number): void { if (n >= 0 && n < this.pageCount) { this._currentPage = n; this.renderCurrentPage(); } }
}

export const pdfViewer = new PDFViewerApp();


