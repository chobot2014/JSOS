/**
 * jit.ts — x86-32 Method JIT Compiler for JSOS  (Phase 11)
 *
 * Compiles a restricted JavaScript integer subset to native x86-32 cdecl
 * machine code, stored in the kernel JIT pool via kernel.jitAlloc /
 * kernel.jitWrite, and invoked via kernel.jitCallI.
 *
 * ─── Supported language subset ────────────────────────────────────────────────
 *
 *   function name(a, b, c, d)        up to 4 int32 parameters
 *   var x = expr;                    int32 local variables (stack-allocated)
 *   return expr;
 *   x = expr;  x += expr; etc.       assignment operators
 *   +  -  *  /  %                    arithmetic (truncates toward zero)
 *   &  |  ^  ~  <<  >>  >>>          bitwise
 *   <  >  <=  >=  ===  !==           comparison (yields 0 or 1)
 *   &&  ||  !                        logical (short-circuit)
 *   if (cond) { } else { }
 *   while (cond) { }
 *   for (var i = 0; i < n; i = i+1)
 *   break; continue;
 *   mem32[addr]                      32-bit little-endian physical memory r/w
 *   mem8[addr]                       8-bit physical memory r/w
 *   Math.imul(a, b)                  inlined 32-bit signed multiply
 *   Math.abs(x)                      inlined branchless absolute value
 *
 * All values are 32-bit signed integers.  No floats, no objects, no closures.
 * Note: use `i = i + 1` instead of `i++` (pre/post-increment not supported).
 *
 * ─── Calling convention ───────────────────────────────────────────────────────
 *
 *   cdecl x86-32:  args pushed right-to-left; return value in EAX; caller
 *   cleans the stack.  EBX/ESI/EDI/EBP callee-saved (not used by codegen).
 *
 * ─── Quick example ────────────────────────────────────────────────────────────
 *
 *   var fill = JIT.compile(`
 *     function fillPixels(dst, color, w, h) {
 *       var n = w * h;
 *       var i = 0;
 *       while (i < n) {
 *         mem32[dst + i * 4] = color;
 *         i = i + 1;
 *       }
 *       return 0;
 *     }
 *   `);
 *   if (fill) fill(frameAddr, 0xFFFF0000, 1024, 768);  // fills 786 432 pixels natively
 */

declare var kernel: any;

// ─── Tokeniser ────────────────────────────────────────────────────────────────

type TT =
  | 'num' | 'ident' | 'eof'
  | '+' | '-' | '*' | '/' | '%'
  | '&' | '|' | '^' | '~'
  | '<<' | '>>' | '>>>'
  | '&&' | '||' | '!'
  | '=' | '+=' | '-=' | '*=' | '/=' | '%='
  | '&=' | '|=' | '^=' | '<<=' | '>>='
  | '==' | '===' | '!=' | '!=='
  | '<' | '>' | '<=' | '>='
  | '(' | ')' | '{' | '}' | '[' | ']'
  | ';' | ',' | '.' | 'kw';

interface Tok { type: TT; value: string; }

const _KW = new Set([
  'function', 'var', 'return', 'if', 'else',
  'while', 'for', 'break', 'continue',
]);

function _tokenise(src: string): Tok[] {
  var toks: Tok[] = [];
  var i = 0; var n = src.length;
  while (i < n) {
    // skip whitespace
    while (i < n && src.charCodeAt(i) <= 32) i++;
    if (i >= n) break;
    // line comment
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++; continue;
    }
    // block comment
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    var c = src[i];
    // numbers (decimal or 0x hex)
    if (c >= '0' && c <= '9') {
      var s = '';
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        s = src[i] + src[i + 1]; i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i])) s += src[i++];
      } else {
        while (i < n && src[i] >= '0' && src[i] <= '9') s += src[i++];
      }
      toks.push({ type: 'num', value: s }); continue;
    }
    // identifiers / keywords
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
      var id = '';
      while (i < n) {
        var cc = src[i];
        if ((cc >= 'a' && cc <= 'z') || (cc >= 'A' && cc <= 'Z') ||
            (cc >= '0' && cc <= '9') || cc === '_' || cc === '$')
          id += src[i++];
        else break;
      }
      toks.push({ type: _KW.has(id) ? 'kw' : 'ident', value: id }); continue;
    }
    // three-char operators
    var t3 = src.slice(i, i + 3);
    if (t3 === '>>>' || t3 === '===' || t3 === '!==' || t3 === '<<=' || t3 === '>>=') {
      toks.push({ type: t3 as TT, value: t3 }); i += 3; continue;
    }
    // two-char operators
    var t2 = src.slice(i, i + 2);
    var t2map: Record<string, TT> = {
      '<<': '<<', '>>': '>>', '&&': '&&', '||': '||',
      '<=': '<=', '>=': '>=', '==': '==', '!=': '!=',
      '+=': '+=', '-=': '-=', '*=': '*=', '/=': '/=',
      '%=': '%=', '&=': '&=', '|=': '|=', '^=': '^=',
    };
    if (t2map[t2]) { toks.push({ type: t2map[t2], value: t2 }); i += 2; continue; }
    // single-char
    var singles = '+-*/%&|^~=<>(){}[];,.!';
    if (singles.indexOf(c) >= 0) {
      toks.push({ type: c as TT, value: c }); i++; continue;
    }
    i++; // skip unknown char
  }
  toks.push({ type: 'eof', value: '' });
  return toks;
}

// ─── AST ──────────────────────────────────────────────────────────────────────

type Expr =
  | { k: 'num';    v: number }
  | { k: 'ident';  name: string }
  | { k: 'binop';  op: string; l: Expr; r: Expr }
  | { k: 'unop';   op: string; x: Expr }
  | { k: 'assign'; op: string; l: Expr; r: Expr }
  | { k: 'mem32';  addr: Expr }
  | { k: 'mem8';   addr: Expr }
  | { k: 'imul';   a: Expr; b: Expr }
  | { k: 'iabs';   x: Expr };

type Stmt =
  | { k: 'var';    name: string; init: Expr | null }
  | { k: 'expr';   e: Expr }
  | { k: 'return'; e: Expr | null }
  | { k: 'if';     cond: Expr; then: Stmt[]; els: Stmt[] }
  | { k: 'while';  cond: Expr; body: Stmt[] }
  | { k: 'for';    init: Stmt | null; cond: Expr | null; update: Expr | null; body: Stmt[] }
  | { k: 'block';  body: Stmt[] }
  | { k: 'break' }
  | { k: 'continue' };

interface FnDecl { name: string; params: string[]; body: Stmt[]; }

// ─── Parser ───────────────────────────────────────────────────────────────────

function _parse(toks: Tok[]): FnDecl {
  var pos = 0;
  function peek(): Tok { return toks[pos] || { type: 'eof', value: '' }; }
  function eat(): Tok  { return toks[pos++] || { type: 'eof', value: '' }; }
  function expect(v: string): void {
    var t = eat();
    if (t.value !== v) throw new Error('[JIT] Expected "' + v + '", got "' + t.value + '"');
  }
  function eatIf(v: string): boolean {
    if (peek().value === v) { eat(); return true; } return false;
  }
  function eatSemi(): void { eatIf(';'); }

  function parseExprList(): Expr[] {
    var args: Expr[] = [];
    if (peek().value === ')') return args;
    args.push(parseAssign());
    while (eatIf(',')) args.push(parseAssign());
    return args;
  }

  function parsePrimary(): Expr {
    var t = peek();
    // numeric literal
    if (t.type === 'num') {
      eat();
      var nv = t.value.startsWith('0x') || t.value.startsWith('0X')
        ? parseInt(t.value, 16) : parseInt(t.value, 10);
      return { k: 'num', v: nv };
    }
    // parenthesised expression
    if (t.value === '(') { eat(); var e = parseAssign(); expect(')'); return e; }
    // prefix unary operators
    if (t.value === '~') { eat(); return { k: 'unop', op: '~', x: parsePrimary() }; }
    if (t.value === '!') { eat(); return { k: 'unop', op: '!', x: parsePrimary() }; }
    if (t.value === '-') { eat(); return { k: 'unop', op: '-', x: parsePrimary() }; }
    // identifiers (variables, Math.*,  mem32/mem8)
    if (t.type === 'ident' || t.type === 'kw') {
      eat();
      // mem32[addr] / mem8[addr]
      if ((t.value === 'mem32' || t.value === 'mem8') && peek().value === '[') {
        eat(); var addr = parseAssign(); expect(']');
        return { k: t.value as 'mem32' | 'mem8', addr };
      }
      // Math.imul / Math.abs
      if (t.value === 'Math' && peek().value === '.') {
        eat(); var method = eat().value;
        expect('(');
        if (method === 'imul') {
          var a = parseAssign(); expect(','); var b = parseAssign(); expect(')');
          return { k: 'imul', a, b };
        }
        if (method === 'abs') {
          var x = parseAssign(); expect(')');
          return { k: 'iabs', x };
        }
        // fallback: ignore other Math methods, return 0
        parseExprList(); expect(')');
        return { k: 'num', v: 0 };
      }
      // plain identifier
      return { k: 'ident', name: t.value };
    }
    throw new Error('[JIT] Unexpected token: "' + t.value + '"');
  }

  function parseMul(): Expr {
    var l = parsePrimary();
    while (peek().value === '*' || peek().value === '/' || peek().value === '%') {
      var op = eat().value; var r = parsePrimary();
      l = { k: 'binop', op, l, r };
    }
    return l;
  }
  function parseAdd(): Expr {
    var l = parseMul();
    while (peek().value === '+' || peek().value === '-') {
      var op = eat().value; var r = parseMul();
      l = { k: 'binop', op, l, r };
    }
    return l;
  }
  function parseShift(): Expr {
    var l = parseAdd();
    while (peek().type === '<<' || peek().type === '>>' || peek().type === '>>>') {
      var op = eat().value; var r = parseAdd();
      l = { k: 'binop', op, l, r };
    }
    return l;
  }
  function parseRel(): Expr {
    var l = parseShift();
    while (peek().type === '<' || peek().type === '>' ||
           peek().type === '<=' || peek().type === '>=') {
      var op = eat().value; var r = parseShift();
      l = { k: 'binop', op, l, r };
    }
    return l;
  }
  function parseEq(): Expr {
    var l = parseRel();
    while (peek().type === '===' || peek().type === '!==' ||
           peek().type === '==' || peek().type === '!=') {
      var op = eat().value; var r = parseRel();
      l = { k: 'binop', op, l, r };
    }
    return l;
  }
  function parseBitAnd(): Expr {
    var l = parseEq();
    while (peek().type === '&' && peek().value === '&') {
      eat(); var r = parseEq(); l = { k: 'binop', op: '&', l, r };
    }
    return l;
  }
  function parseBitXor(): Expr {
    var l = parseBitAnd();
    while (peek().type === '^') { eat(); var r = parseBitAnd(); l = { k: 'binop', op: '^', l, r }; }
    return l;
  }
  function parseBitOr(): Expr {
    var l = parseBitXor();
    while (peek().type === '|' && peek().value === '|') {
      eat(); var r = parseBitXor(); l = { k: 'binop', op: '|', l, r };
    }
    return l;
  }
  function parseLogAnd(): Expr {
    var l = parseBitOr();
    while (peek().type === '&&') { eat(); var r = parseBitOr(); l = { k: 'binop', op: '&&', l, r }; }
    return l;
  }
  function parseLogOr(): Expr {
    var l = parseLogAnd();
    while (peek().type === '||') { eat(); var r = parseLogAnd(); l = { k: 'binop', op: '||', l, r }; }
    return l;
  }
  function parseAssign(): Expr {
    var l = parseLogOr();
    var ops = ['=','+=','-=','*=','/=','%=','&=','|=','^=','<<=','>>='];
    var pt = peek().type as string;
    if (ops.indexOf(pt) >= 0 || ops.indexOf(peek().value) >= 0) {
      var op = eat().value; var r = parseAssign();
      return { k: 'assign', op, l, r };
    }
    return l;
  }

  function parseBlock(): Stmt[] {
    expect('{');
    var body: Stmt[] = [];
    while (peek().value !== '}' && peek().type !== 'eof') body.push(parseStmt());
    expect('}');
    return body;
  }

  function parseStmt(): Stmt {
    var t = peek();
    if (t.value === '{') { return { k: 'block', body: parseBlock() }; }
    if (t.value === 'var') {
      eat(); var name = eat().value;
      var init: Expr | null = null;
      if (eatIf('=')) init = parseAssign();
      eatSemi();
      return { k: 'var', name, init };
    }
    if (t.value === 'return') {
      eat();
      var re: Expr | null = null;
      if (peek().value !== ';' && peek().value !== '}' && peek().type !== 'eof')
        re = parseAssign();
      eatSemi();
      return { k: 'return', e: re };
    }
    if (t.value === 'if') {
      eat(); expect('('); var cond = parseAssign(); expect(')');
      var then: Stmt[];
      if (peek().value === '{') then = parseBlock();
      else then = [parseStmt()];
      var els: Stmt[] = [];
      if (eatIf('else')) {
        if (peek().value === '{') els = parseBlock();
        else els = [parseStmt()];
      }
      return { k: 'if', cond, then, els };
    }
    if (t.value === 'while') {
      eat(); expect('('); var cond = parseAssign(); expect(')');
      var body: Stmt[];
      if (peek().value === '{') body = parseBlock();
      else body = [parseStmt()];
      return { k: 'while', cond, body };
    }
    if (t.value === 'for') {
      eat(); expect('(');
      var finit: Stmt | null = null;
      if (peek().value !== ';') finit = parseStmt(); else eatSemi();
      var fcond: Expr | null = null;
      if (peek().value !== ';') fcond = parseAssign();
      eatSemi();
      var fupd: Expr | null = null;
      if (peek().value !== ')') fupd = parseAssign();
      expect(')');
      var fbody: Stmt[];
      if (peek().value === '{') fbody = parseBlock();
      else fbody = [parseStmt()];
      return { k: 'for', init: finit, cond: fcond, update: fupd, body: fbody };
    }
    if (t.value === 'break')    { eat(); eatSemi(); return { k: 'break' }; }
    if (t.value === 'continue') { eat(); eatSemi(); return { k: 'continue' }; }
    // expression statement
    var es = parseAssign(); eatSemi();
    return { k: 'expr', e: es };
  }

  expect('function');
  var fname = eat().value;
  expect('(');
  var params: string[] = [];
  if (peek().value !== ')') {
    params.push(eat().value);
    while (eatIf(',')) params.push(eat().value);
  }
  expect(')');
  var fbody2 = parseBlock();
  return { name: fname, params, body: fbody2 };
}

// ─── Variable pre-scan (collect all declared names) ──────────────────────────

function _collectVars(stmts: Stmt[]): string[] {
  var vars: string[] = [];
  function scan(s: Stmt): void {
    if      (s.k === 'var')   { if (vars.indexOf(s.name) < 0) vars.push(s.name); }
    else if (s.k === 'if')    { s.then.forEach(scan); s.els.forEach(scan); }
    else if (s.k === 'while') { s.body.forEach(scan); }
    else if (s.k === 'block') { s.body.forEach(scan); }
    else if (s.k === 'for')   {
      if (s.init) scan(s.init);
      s.body.forEach(scan);
    }
  }
  stmts.forEach(scan);
  return vars;
}

// ─── Stack frame ──────────────────────────────────────────────────────────────

class _Frame {
  private _slots = new Map<string, number>(); // name → EBP-relative offset
  private _next  = -4;                         // next available local slot offset

  constructor(params: string[]) {
    // cdecl: first arg at EBP+8, next at EBP+12, etc.
    for (var i = 0; i < params.length && i < 4; i++) {
      this._slots.set(params[i], 8 + i * 4);
    }
  }

  declareLocals(names: string[]): void {
    for (var ni = 0; ni < names.length; ni++) {
      var nm = names[ni];
      if (!this._slots.has(nm)) {
        this._slots.set(nm, this._next);
        this._next -= 4;
      }
    }
  }

  /** EBP-relative offset for a named variable. Throws on unknown names. */
  slot(name: string): number {
    if (!this._slots.has(name))
      throw new Error('[JIT] Unknown variable: "' + name + '"');
    return this._slots.get(name)!;
  }

  has(name: string): boolean { return this._slots.has(name); }

  /** Bytes needed for SUB ESP, N in the prologue. */
  get localBytes(): number {
    return this._next <= -8 ? -(this._next + 4) : 0;
  }
}

// ─── x86-32 Code Emitter ──────────────────────────────────────────────────────

class _Emit {
  buf: number[] = [];

  private _w(b: number): void { this.buf.push(b & 0xFF); }
  private _u32(v: number): void {
    v = v >>> 0;
    this.buf.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF);
  }

  here(): number { return this.buf.length; }

  // ── Load/store locals (EBP-relative) ──

  load(disp: number): void {         // MOV EAX, [EBP + disp]
    if (disp >= -128 && disp <= 127) { this._w(0x8B); this._w(0x45); this._w(disp & 0xFF); }
    else { this._w(0x8B); this._w(0x85); this._u32(disp); }
  }
  store(disp: number): void {        // MOV [EBP + disp], EAX
    if (disp >= -128 && disp <= 127) { this._w(0x89); this._w(0x45); this._w(disp & 0xFF); }
    else { this._w(0x89); this._w(0x85); this._u32(disp); }
  }

  // ── Register moves ──

  immEax(v: number): void { this._w(0xB8); this._u32(v); } // MOV EAX, imm32
  pushEax(): void { this._w(0x50); }                        // PUSH EAX
  popEcx():  void { this._w(0x59); }                        // POP ECX
  movEcxEax(): void { this._w(0x89); this._w(0xC1); }       // MOV ECX, EAX
  movEdxEax(): void { this._w(0x89); this._w(0xC2); }       // MOV EDX, EAX
  xorEaxEax(): void { this._w(0x31); this._w(0xC0); }       // XOR EAX, EAX (→ 0)

  // ── Arithmetic (EAX = LHS, ECX = RHS, result → EAX) ──

  addAC():  void { this._w(0x01); this._w(0xC8); }          // ADD EAX, ECX
  subAC():  void { this._w(0x29); this._w(0xC8); }          // SUB EAX, ECX
  imulAC(): void { this._w(0x0F); this._w(0xAF); this._w(0xC1); } // IMUL EAX, ECX
  andAC():  void { this._w(0x21); this._w(0xC8); }          // AND EAX, ECX
  orAC():   void { this._w(0x09); this._w(0xC8); }          // OR  EAX, ECX
  xorAC():  void { this._w(0x31); this._w(0xC8); }          // XOR EAX, ECX
  shlACl(): void { this._w(0xD3); this._w(0xE0); }          // SHL EAX, CL
  sarACl(): void { this._w(0xD3); this._w(0xF8); }          // SAR EAX, CL (>>)
  shrACl(): void { this._w(0xD3); this._w(0xE8); }          // SHR EAX, CL (>>>)

  // CDQ; IDIV ECX  → EAX = quotient, EDX = remainder
  idivC(): void { this._w(0x99); this._w(0xF7); this._w(0xF9); }
  // MOV EAX, EDX  (grab remainder)
  movEaxEdx(): void { this._w(0x89); this._w(0xD0); }

  negEax(): void { this._w(0xF7); this._w(0xD8); }          // NEG EAX
  notEax(): void { this._w(0xF7); this._w(0xD0); }          // NOT EAX

  // ── Branchless absolute value: CDQ; XOR EAX,EDX; SUB EAX,EDX ──
  absEax(): void {
    this._w(0x99);                    // CDQ  (sign-extend EAX→EDX)
    this._w(0x31); this._w(0xD0);    // XOR EAX, EDX
    this._w(0x29); this._w(0xD0);    // SUB EAX, EDX
  }

  // ── Comparisons ──
  cmpAC(): void { this._w(0x39); this._w(0xC8); }           // CMP EAX, ECX
  testAA(): void { this._w(0x85); this._w(0xC0); }          // TEST EAX, EAX

  // SETcc AL then MOVZX EAX, AL
  private _setcc(cc: number): void {
    this._w(0x0F); this._w(cc); this._w(0xC0);              // SETcc AL
    this._w(0x0F); this._w(0xB6); this._w(0xC0);            // MOVZX EAX, AL
  }
  setl():  void { this._setcc(0x9C); }   // <
  setle(): void { this._setcc(0x9E); }   // <=
  setg():  void { this._setcc(0x9F); }   // >
  setge(): void { this._setcc(0x9D); }   // >=
  sete():  void { this._setcc(0x94); }   // === / ==
  setne(): void { this._setcc(0x95); }   // !== / !=

  // ── Memory access (ECX = address) ──
  rdMem32(): void { this._w(0x8B); this._w(0x01); }         // MOV EAX, [ECX]
  wrMem32(): void { this._w(0x89); this._w(0x01); }         // MOV [ECX], EAX
  rdMem8():  void { this._w(0x0F); this._w(0xB6); this._w(0x01); } // MOVZX EAX, BYTE [ECX]
  wrMem8():  void { this._w(0x88); this._w(0x01); }         // MOV BYTE [ECX], AL

  // ── Jumps (32-bit relative, returns fixup offset) ──
  jmp(): number  { this._w(0xE9); var o = this.here(); this._u32(0); return o; }
  je():  number  { this._w(0x0F); this._w(0x84); var o = this.here(); this._u32(0); return o; }
  jne(): number  { this._w(0x0F); this._w(0x85); var o = this.here(); this._u32(0); return o; }

  patch(fixupOff: number, targetOff: number): void {
    var rel = (targetOff - (fixupOff + 4)) >>> 0;
    this.buf[fixupOff]     =  rel        & 0xFF;
    this.buf[fixupOff + 1] = (rel >>  8) & 0xFF;
    this.buf[fixupOff + 2] = (rel >> 16) & 0xFF;
    this.buf[fixupOff + 3] = (rel >> 24) & 0xFF;
  }

  // ── Function prologue / epilogue ──
  prologue(localBytes: number): void {
    this._w(0x55);                    // PUSH EBP
    this._w(0x89); this._w(0xE5);    // MOV EBP, ESP
    if (localBytes > 0) {
      if (localBytes <= 127) { this._w(0x83); this._w(0xEC); this._w(localBytes); }
      else { this._w(0x81); this._w(0xEC); this._u32(localBytes); }
    }
  }
  epilogue(): void {
    this._w(0xC9);  // LEAVE  (= MOV ESP,EBP; POP EBP)
    this._w(0xC3);  // RET
  }
}

// ─── Code generator ───────────────────────────────────────────────────────────

interface _LoopMeta {
  continueFixups: number[];
  breakFixups:    number[];
  continueTarget: number;   // offset of continue target (set after body, before update)
}

function _codegen(fn: FnDecl): number[] {
  var e = new _Emit();
  var frame = new _Frame(fn.params);
  var locals = _collectVars(fn.body);
  frame.declareLocals(locals);

  // We emit the prologue twice: once with a placeholder, then we'll overwrite
  // once we know localBytes. But since we scan vars first, we already know.
  e.prologue(frame.localBytes);

  var loopStack: _LoopMeta[] = [];
  var returnFixups: number[] = [];

  // ── Expression code generation → result in EAX ──────────────────────────

  function genExpr(ex: Expr): void {
    switch (ex.k) {

      case 'num':
        e.immEax(ex.v);
        break;

      case 'ident':
        e.load(frame.slot(ex.name));
        break;

      case 'mem32':
        genExpr(ex.addr);
        e.movEcxEax();
        e.rdMem32();
        break;

      case 'mem8':
        genExpr(ex.addr);
        e.movEcxEax();
        e.rdMem8();
        break;

      case 'imul':
        genExpr(ex.a);
        e.pushEax();
        genExpr(ex.b);
        e.popEcx();
        // EAX = b, ECX = a … IMUL is commutative
        e.imulAC();
        break;

      case 'iabs':
        genExpr(ex.x);
        e.absEax();
        break;

      case 'unop':
        genExpr(ex.x);
        if      (ex.op === '-') e.negEax();
        else if (ex.op === '~') e.notEax();
        else if (ex.op === '!') {
          // !x → (x === 0) ? 1 : 0
          e.testAA();
          e.sete();
        }
        break;

      case 'binop': {
        var op = ex.op;
        // Short-circuit logical operators
        if (op === '&&') {
          genExpr(ex.l);
          e.testAA();
          var jf = e.je();           // if LHS == 0, skip RHS
          genExpr(ex.r);
          e.testAA();
          e.setne();
          e.patch(jf, e.here());
          break;
        }
        if (op === '||') {
          genExpr(ex.l);
          e.testAA();
          var jt = e.jne();          // if LHS != 0, skip RHS
          genExpr(ex.r);
          e.testAA();
          e.setne();
          var jend = e.jmp();
          e.patch(jt, e.here());
          e.immEax(1);               // LHS was truthy → result = 1
          e.patch(jend, e.here());
          break;
        }

        // Standard binary:
        //   eval LHS → EAX; PUSH EAX
        //   eval RHS → EAX; MOV ECX, EAX; POP EAX
        //   → EAX = LHS, ECX = RHS  (correct for all ops below)
        genExpr(ex.l);
        e.pushEax();                   // save LHS
        genExpr(ex.r);                 // EAX = RHS
        e.movEcxEax();                 // ECX = RHS
        e.buf.push(0x58);              // POP EAX → EAX = LHS
        // Now: EAX = LHS, ECX = RHS
        switch (op) {
          case '+':   e.addAC();  break;
          case '-':   e.subAC();  break;          // EAX = LHS - RHS ✓
          case '*':   e.imulAC(); break;
          case '/':   e.idivC();  break;          // CDQ; IDIV ECX; EAX = quotient
          case '%':   e.idivC(); e.movEaxEdx(); break; // remainder in EDX → EAX
          case '&':   e.andAC(); break;
          case '|':   e.orAC();  break;
          case '^':   e.xorAC(); break;
          case '<<':  e.shlACl(); break;          // SHL EAX, CL (CL = low byte of ECX = RHS)
          case '>>':  e.sarACl(); break;
          case '>>>':
            // zero-extend EAX first (unsigned): MOV ECX,ECX already has RHS count;
            // SHR treats EAX as unsigned 32-bit shift
            e.shrACl(); break;
          case '<':
            e.cmpAC(); e.setl();  break;          // CMP EAX(LHS), ECX(RHS)
          case '>':
            e.cmpAC(); e.setg();  break;
          case '<=':
            e.cmpAC(); e.setle(); break;
          case '>=':
            e.cmpAC(); e.setge(); break;
          case '===': case '==':
            e.cmpAC(); e.sete();  break;
          case '!==': case '!=':
            e.cmpAC(); e.setne(); break;
          default:
            e.xorEaxEax(); // unsupported op → 0
        }
        break;
      }

      case 'assign': {
        var aop = ex.op;
        if (aop === '=') {
          genExpr(ex.r);              // EAX = rhs
          _storeLVal(ex.l);
        } else {
          // Compound: EAX = (lhs op rhs), then store back.
          // Pattern: eval lhs → PUSH; eval rhs → MOV ECX,EAX; POP EAX (0x58)
          //          → EAX = lhs, ECX = rhs; apply op; store.
          genExpr(ex.l);              // EAX = current lhs
          e.pushEax();                // save lhs on stack
          genExpr(ex.r);              // EAX = rhs
          e.movEcxEax();              // ECX = rhs
          e.buf.push(0x58);           // POP EAX = lhs  (0x58 = POP EAX, not POP ECX)
          // Now: EAX = lhs, ECX = rhs  ✓
          var baseOp = aop.slice(0, -1);
          switch (baseOp) {
            case '+':   e.addAC();  break;
            case '-':   e.subAC();  break;
            case '*':   e.imulAC(); break;
            case '/':   e.idivC();  break;
            case '%':   e.idivC(); e.movEaxEdx(); break;
            case '&':   e.andAC(); break;
            case '|':   e.orAC();  break;
            case '^':   e.xorAC(); break;
            case '<<':  e.shlACl(); break;
            case '>>':  e.sarACl(); break;
            case '>>>': e.shrACl(); break;
            default: break;
          }
          _storeLVal(ex.l);
        }
        break;
      }
    }
  }

  // Store EAX to an l-value. Uses PUSH/POP so addr sub-expressions use ECX/EDX freely.
  function _storeLVal(target: Expr): void {
    if (target.k === 'ident') {
      e.store(frame.slot(target.name));
    } else if (target.k === 'mem32' || target.k === 'mem8') {
      // EAX = value to write.
      // PUSH EAX (save value); eval addr → EAX; MOV ECX,EAX (addr); POP EAX (value); write.
      e.pushEax();                    // [ESP] = value
      genExpr(target.addr);           // EAX = addr (may freely use ECX/EDX)
      e.movEcxEax();                  // ECX = addr
      e.buf.push(0x58);               // POP EAX = value  (0x58 = POP EAX)
      // Now: EAX = value, ECX = addr  ✓
      if (target.k === 'mem32') e.wrMem32();
      else                       e.wrMem8();
    }
  }

  // genAssign: called by genStmt for top-level assignment expressions.
  function genAssign(ex: Expr): void {
    genExpr(ex);   // case 'assign' in genExpr handles everything correctly
  }

  // ─── Statement code generation ────────────────────────────────────────────

  function genStmts(stmts: Stmt[]): void {
    for (var si = 0; si < stmts.length; si++) genStmt(stmts[si]);
  }

  function genStmt(stmt: Stmt): void {
    switch (stmt.k) {
      case 'var':
        if (stmt.init) {
          genExpr(stmt.init);
          e.store(frame.slot(stmt.name));
        }
        break;

      case 'expr':
        if (stmt.e.k === 'assign') genAssign(stmt.e);
        else                       genExpr(stmt.e);
        break;

      case 'return':
        if (stmt.e) genExpr(stmt.e);
        else        e.xorEaxEax();
        // Jump to epilogue (will be patched)
        var rfix = e.jmp();
        returnFixups.push(rfix);
        break;

      case 'if': {
        genExpr(stmt.cond);
        e.testAA();
        var jElse = e.je();        // jump to else if false
        genStmts(stmt.then);
        if (stmt.els.length > 0) {
          var jEnd = e.jmp();      // jump over else
          e.patch(jElse, e.here());
          genStmts(stmt.els);
          e.patch(jEnd, e.here());
        } else {
          e.patch(jElse, e.here());
        }
        break;
      }

      case 'while': {
        var meta: _LoopMeta = { continueFixups: [], breakFixups: [], continueTarget: -1 };
        loopStack.push(meta);
        var loopStart = e.here();
        genExpr(stmt.cond);
        e.testAA();
        meta.breakFixups.push(e.je());   // exit if false
        genStmts(stmt.body);
        meta.continueTarget = e.here();
        // Patch continues
        for (var ci = 0; ci < meta.continueFixups.length; ci++)
          e.patch(meta.continueFixups[ci], meta.continueTarget);
        e.patch(e.jmp(), loopStart);     // loop back
        var loopEnd = e.here();
        for (var bi = 0; bi < meta.breakFixups.length; bi++)
          e.patch(meta.breakFixups[bi], loopEnd);
        loopStack.pop();
        break;
      }

      case 'for': {
        var fmeta: _LoopMeta = { continueFixups: [], breakFixups: [], continueTarget: -1 };
        loopStack.push(fmeta);
        if (stmt.init) genStmt(stmt.init);
        var fStart = e.here();
        if (stmt.cond) {
          genExpr(stmt.cond);
          e.testAA();
          fmeta.breakFixups.push(e.je());  // exit if cond false
        }
        genStmts(stmt.body);
        fmeta.continueTarget = e.here();
        // Patch continues to land here (before update)
        for (var fci = 0; fci < fmeta.continueFixups.length; fci++)
          e.patch(fmeta.continueFixups[fci], fmeta.continueTarget);
        if (stmt.update) {
          if (stmt.update.k === 'assign') genAssign(stmt.update);
          else genExpr(stmt.update);
        }
        e.patch(e.jmp(), fStart);         // loop back to condition
        var fEnd = e.here();
        for (var fbi = 0; fbi < fmeta.breakFixups.length; fbi++)
          e.patch(fmeta.breakFixups[fbi], fEnd);
        loopStack.pop();
        break;
      }

      case 'block':
        genStmts(stmt.body);
        break;

      case 'break':
        if (loopStack.length > 0)
          loopStack[loopStack.length - 1].breakFixups.push(e.jmp());
        break;

      case 'continue':
        if (loopStack.length > 0) {
          var lm = loopStack[loopStack.length - 1];
          if (lm.continueTarget >= 0)     e.patch(e.jmp(), lm.continueTarget);
          else                            lm.continueFixups.push(e.jmp());
        }
        break;
    }
  }

  genStmts(fn.body);

  // Patch all return fixups to the epilogue
  var epilogueOff = e.here();
  for (var ri = 0; ri < returnFixups.length; ri++)
    e.patch(returnFixups[ri], epilogueOff);

  e.epilogue();
  return e.buf;
}

// ─── JIT cache ────────────────────────────────────────────────────────────────

interface _CacheEntry {
  addr:  number;       // kernel JIT pool address
  bytes: number;       // size of compiled code
}

var _cache = new Map<string, _CacheEntry>();
var _compiled = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

export const JIT = {
  /**
   * Returns true if the kernel JIT primitives are available.
   * (They are always present in JSOS, but may be absent in test environments.)
   */
  available(): boolean {
    return typeof kernel !== 'undefined' &&
           typeof kernel.jitAlloc === 'function';
  },

  /**
   * Compile a JS function source string to native x86-32 code.
   *
   * Returns a callable proxy function that invokes the compiled native code
   * via kernel.jitCallI.  Returns null if compilation or allocation fails.
   *
   * The result is cached by source text; re-compiling the same source is free.
   */
  compile(src: string): ((a0?: number, a1?: number, a2?: number, a3?: number) => number) | null {
    // Cache hit?
    var cached = _cache.get(src);
    if (cached) {
      var caddr = cached.addr;
      return function(a0?: number, a1?: number, a2?: number, a3?: number): number {
        return kernel.jitCallI(caddr, a0 || 0, a1 || 0, a2 || 0, a3 || 0);
      };
    }

    // Parse
    var fn: FnDecl;
    try {
      fn = _parse(_tokenise(src));
    } catch (pe: any) {
      kernel.serialPut('[JIT] parse error: ' + String(pe) + '\n');
      return null;
    }

    // Generate machine code
    var bytes: number[];
    try {
      bytes = _codegen(fn);
    } catch (ce: any) {
      kernel.serialPut('[JIT] codegen error: ' + String(ce) + '\n');
      return null;
    }

    if (!JIT.available()) {
      // No kernel JIT support — fall back to eval()
      kernel.serialPut('[JIT] kernel.jitAlloc unavailable — running interpreted\n');
      return null;
    }

    // Allocate pool space
    var addr = kernel.jitAlloc(bytes.length);
    if (!addr) {
      kernel.serialPut('[JIT] pool exhausted (' + bytes.length + ' bytes needed)\n');
      return null;
    }

    // Write machine code
    kernel.jitWrite(addr, bytes);
    _cache.set(src, { addr, bytes: bytes.length });
    _compiled++;

    kernel.serialPut('[JIT] compiled "' + fn.name + '" → 0x' +
      addr.toString(16) + ' (' + bytes.length + ' bytes)\n');

    return function(a0?: number, a1?: number, a2?: number, a3?: number): number {
      return kernel.jitCallI(addr, a0 || 0, a1 || 0, a2 || 0, a3 || 0);
    };
  },

  /**
   * Compile and immediately call.  Useful for one-shot native operations.
   * Returns undefined if compilation fails.
   */
  run(src: string, a0 = 0, a1 = 0, a2 = 0, a3 = 0): number | undefined {
    var fn = JIT.compile(src);
    return fn ? fn(a0, a1, a2, a3) : undefined;
  },

  /**
   * Stat snapshot: how many functions compiled, bytes used in pool.
   */
  stats(): { compiled: number; poolUsed: number; poolTotal: number } {
    return {
      compiled:  _compiled,
      poolUsed:  JIT.available() ? kernel.jitUsedBytes() : 0,
      poolTotal: 256 * 1024,
    };
  },

  /**
   * Flush the in-memory source→address cache (addresses in the kernel pool
   * are permanent).  Call this only if you need to re-compile changed source
   * (e.g. during development).
   */
  flushCache(): void {
    _cache.clear();
  },
};

export default JIT;
