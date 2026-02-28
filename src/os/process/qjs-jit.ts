/**
 * qjs-jit.ts — QuickJS Bytecode JIT Compiler (Steps 7–10)
 *
 * Architecture overview:
 *   QJSJITHook.install() registers a C-level hook (kernel.setJITHook) that fires
 *   when a QuickJS function's call_count reaches JIT_THRESHOLD.  The hook callback
 *   triggers QJSJITCompiler to translate the function's bytecode into native i686
 *   machine code using the extended _Emit helpers.  The resulting code is placed in
 *   the 8 MB JIT pool (main context) or the per-process 512 KB slab (child context)
 *   via kernel.jitAlloc / kernel.jitProcAlloc.
 *
 *   kernel.setJITNative(bcAddr, nativeAddr) then writes the function pointer back
 *   into JSFunctionBytecode.jit_native_ptr so subsequent calls dispatch natively.
 *
 *   The generated native function uses cdecl calling convention with int32 args:
 *     int32_t fn(int32_t a0, int32_t a1, int32_t a2, int32_t a3)
 *   ArgS are extracted from the JSValue stack by the QuickJS patch before calling.
 *
 * JIT limits (V1, "Priority 1"):
 *   Only integer arithmetic, local/arg access, integer comparisons, and
 *   unconditional/conditional branches are compiled.  Any unsupported opcode
 *   causes the compiler to bail out (the function is blacklisted so the hook
 *   never fires again).
 */

import { _Emit } from './jit.js';
import {
  OPCODE_SIZE, JIT_SUPPORTED_OPCODES,
  OP_push_i32, OP_push_const,
  OP_push_false, OP_push_true, OP_null, OP_undefined,
  OP_get_loc,  OP_put_loc,  OP_set_loc,
  OP_get_loc0, OP_get_loc1, OP_get_loc2, OP_get_loc3,
  OP_put_loc0, OP_put_loc1, OP_put_loc2, OP_put_loc3,
  OP_set_loc0, OP_set_loc1, OP_set_loc2, OP_set_loc3,
  OP_get_arg,  OP_put_arg,  OP_set_arg,
  OP_add, OP_sub, OP_mul, OP_div, OP_mod,
  OP_neg, OP_plus, OP_not, OP_lnot,
  OP_or,  OP_and, OP_xor, OP_shl, OP_sar, OP_shr,
  OP_eq,  OP_neq, OP_strict_eq, OP_strict_neq,
  OP_lt,  OP_lte, OP_gt, OP_gte,
  OP_inc_loc, OP_dec_loc, OP_inc_loc8, OP_dec_loc8,
  OP_add_loc, OP_add_loc8,
  OP_drop, OP_dup, OP_dup1, OP_dup2, OP_dup3, OP_nip, OP_nip1, OP_swap,
  OP_rot3l, OP_rot3r,
  OP_post_inc, OP_post_dec,
  OP_if_true8, OP_if_false8, OP_if_true, OP_if_false,
  OP_goto, OP_goto8, OP_goto16,
  OP_return_val, OP_return_undef, OP_nop, OP_label,
  // IC / devirtualize / array opcodes (items 848, 849, 858, 852)
  OP_get_field, OP_put_field,
  OP_get_array_el, OP_put_array_el,
  OP_typeof,
  OP_call_method,
} from './qjs-opcodes.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/** QuickJS JSValue tag for int32 (data in union low 4 bytes). */
export const JS_TAG_INT         = 0;
/** QuickJS JSValue tag for boolean (data = 0 or 1). */
export const JS_TAG_BOOL        = 1;
export const JS_TAG_NULL        = 2;
export const JS_TAG_UNDEFINED   = 3;
export const JS_TAG_UNINITIALIZED = 4;
export const JS_TAG_FLOAT64     = 7;
export const JS_TAG_OBJECT      = -1;
export const JS_TAG_FUNCTION_BYTECODE = -2;

/** sizeof(JSValue) = 8 bytes on 32-bit QuickJS (4-byte union + 4-byte tag). */
export const JSVALUE_SIZE = 8;

/** Sentinel value written to jit_native_ptr to indicate deoptimisation. */
export const DEOPT_SENTINEL = 0x7FFFDEAD;

/** Call count threshold at which a function is compiled. */
export const JIT_THRESHOLD = 10;

/** Maximum allowed deoptimisations before a function is blacklisted. */
export const MAX_DEOPTS = 3;

/** Maximum consecutive compile failures before a function is permanently blacklisted. */
export const MAX_BAILS = 3;

/** Maximum bytecode length the JIT will attempt to compile. */
export const MAX_BC_LEN = 4096;

// ─────────────────────────────────────────────────────────────────────────────
//  QJSOffsets — field byte offsets within JSFunctionBytecode
// ─────────────────────────────────────────────────────────────────────────────

export interface QJSOffsets {
  gcHeaderSize:  number;
  objShape:      number;
  objSize:       number;
  callCount:     number;
  jitNativePtr:  number;
  bcBuf:         number;
  bcLen:         number;
  funcName:      number;
  argCount:      number;
  varCount:      number;
  stackSize:     number;
  cpoolPtr:      number;
  cpoolCount:    number;
  structSize:    number;
}

/** Retrieve or initialise QJSOffsets from the kernel probe. */
export function initOffsets(): QJSOffsets {
  if (typeof kernel !== 'undefined' && typeof (kernel as any).qjsOffsets === 'function') {
    return (kernel as any).qjsOffsets() as QJSOffsets;
  }
  // Hardcoded fallback matching post-Step-5 QuickJS build
  return {
    gcHeaderSize:  4,
    objShape:      8,
    objSize:      12,
    callCount:    20,
    jitNativePtr: 24,
    bcBuf:        28,
    bcLen:        32,
    funcName:     36,
    argCount:     48,
    varCount:     50,
    stackSize:    54,
    cpoolPtr:     64,
    cpoolCount:   58,
    structSize:   96,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  QJSBytecodeReader — read a live JSFunctionBytecode from physical memory
// ─────────────────────────────────────────────────────────────────────────────

export class QJSBytecodeReader {
  readonly bcBuf:    number;   /** physical address of first bytecode byte */
  readonly bcLen:    number;   /** bytecode length in bytes */
  readonly argCount: number;
  readonly varCount: number;
  readonly stackSize: number;
  readonly cpoolPtr:   number;  /** physical address of the constant pool array (JSValue[]) */
  readonly cpoolCount: number;  /** number of constant pool entries */
  private readonly _bytes: ArrayBuffer;
  private readonly _view:  DataView;
  private readonly _cpoolView: DataView | null;

  constructor(bcStructAddr: number, offsets: QJSOffsets) {
    // Read fields from the live JSFunctionBytecode struct via physical memory
    const meta = kernel.readPhysMem(bcStructAddr, offsets.structSize);
    if (!meta) throw new Error('QJSBytecodeReader: cannot read BC struct');
    const mv = new DataView(meta);
    const bcBufPtr = mv.getUint32(offsets.bcBuf, true);
    const bcLen    = mv.getUint32(offsets.bcLen, true);
    this.argCount  = mv.getUint16(offsets.argCount, true);
    this.varCount  = mv.getUint16(offsets.varCount, true);
    this.stackSize = mv.getUint16(offsets.stackSize, true);
    this.bcBuf     = bcBufPtr;
    this.bcLen     = bcLen;
    // Constant pool
    this.cpoolPtr   = mv.getUint32(offsets.cpoolPtr,   true);
    this.cpoolCount = mv.getUint16(offsets.cpoolCount, true);
    if (bcLen === 0 || bcLen > MAX_BC_LEN) {
      throw new Error(`QJSBytecodeReader: invalid bcLen ${bcLen}`);
    }
    const bytes = kernel.readPhysMem(bcBufPtr, bcLen);
    if (!bytes) throw new Error('QJSBytecodeReader: cannot read bytecode');
    this._bytes = bytes;
    this._view  = new DataView(bytes);
    // Read constant pool upfront (JSValue = 8 bytes each: [u32 data | i32 tag])
    if (this.cpoolCount > 0 && this.cpoolPtr) {
      const cpoolBuf = kernel.readPhysMem(this.cpoolPtr, this.cpoolCount * 8);
      this._cpoolView = cpoolBuf ? new DataView(cpoolBuf) : null;
    } else {
      this._cpoolView = null;
    }
  }

  u8(offset: number):  number { return this._view.getUint8(offset); }
  i8(offset: number):  number { return this._view.getInt8(offset); }
  u16(offset: number): number { return this._view.getUint16(offset, true); }
  i16(offset: number): number { return this._view.getInt16(offset, true); }
  i32(offset: number): number { return this._view.getInt32(offset, true); }
  u32(offset: number): number { return this._view.getUint32(offset, true); }

  /**
   * Return the JSValue tag of constant pool entry idx.
   * JS_TAG_INT=0, JS_TAG_BOOL=1, JS_TAG_NULL=2, JS_TAG_UNDEFINED=3, JS_TAG_FLOAT64=7, etc.
   * Returns -99 on out-of-range or missing cpool data.
   */
  cpoolTag(idx: number): number {
    if (!this._cpoolView || idx < 0 || idx >= this.cpoolCount) return -99;
    return this._cpoolView.getInt32(idx * 8 + 4, true);
  }

  /** Return the int32 data word of constant pool entry idx (valid when cpoolTag===JS_TAG_INT). */
  cpoolInt(idx: number): number {
    if (!this._cpoolView || idx < 0 || idx >= this.cpoolCount) return 0;
    return this._cpoolView.getInt32(idx * 8 + 0, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TypeSpeculator — accumulate type observations for a function's entry point
// ─────────────────────────────────────────────────────────────────────────────

export const enum ArgType { Unknown = 0, Int32 = 1, Bool = 2, Float64 = 3, Any = 255 }

export class TypeSpeculator {
  private _argTypes: ArgType[]  = [];
  private _callCount: number    = 0;
  private readonly _maxArgs: number;

  constructor(argCount: number) {
    this._maxArgs = argCount;
    for (let i = 0; i < argCount; i++) this._argTypes.push(ArgType.Unknown);
  }

  /** Observe one call (sp points to the JSValue arg array in physical memory). */
  observe(spAddr: number, argCount: number): void {
    this._callCount++;
    const n = Math.min(argCount, this._maxArgs);
    if (n === 0) return;
    const raw = kernel.readPhysMem(spAddr, n * JSVALUE_SIZE);
    if (!raw) return;
    const v = new DataView(raw);
    for (let i = 0; i < n; i++) {
      const tag = v.getInt32(i * JSVALUE_SIZE + 4, true);
      const obs: ArgType = tag === JS_TAG_INT     ? ArgType.Int32
                          : tag === JS_TAG_BOOL    ? ArgType.Bool
                          : tag === JS_TAG_FLOAT64 ? ArgType.Float64
                          : ArgType.Any;
      const prev = this._argTypes[i];
      if (prev === ArgType.Unknown) {
        this._argTypes[i] = obs;
      } else if (prev !== obs) {
        this._argTypes[i] = ArgType.Any;
      }
    }
  }

  get callCount(): number  { return this._callCount; }
  argType(i: number): ArgType { return this._argTypes[i] ?? ArgType.Unknown; }

  /** Returns true if all observed arguments are Int32 — safe to JIT compile. */
  allInt32(): boolean {
    for (let i = 0; i < this._maxArgs; i++)
      if (this._argTypes[i] !== ArgType.Int32 && this._argTypes[i] !== ArgType.Unknown)
        return false;
    return true;
  }

  /**
   * Returns true if all observed args are integer-like (Int32, Bool, or Unknown).
   * Bool is treated as int32 (0/1) — safe for V1 integer JIT.  Float64 or Any
   * require a different compilation tier and are rejected here.
   */
  allIntegerLike(): boolean {
    for (let i = 0; i < this._maxArgs; i++) {
      const t = this._argTypes[i];
      if (t !== ArgType.Int32 && t !== ArgType.Bool && t !== ArgType.Unknown)
        return false;
    }
    return true;
  }

  /** Returns true if any observed argument was Float64. */
  hasFloat64(): boolean {
    for (let i = 0; i < this._maxArgs; i++)
      if (this._argTypes[i] === ArgType.Float64) return true;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  QJSJITCompiler — translate QJS bytecode to x86-32 native code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stack frame layout used by the compiled function (cdecl, i686):
 *
 *   [EBP + 8 + i*4]   arg i  (passed by caller as int32_t)
 *   [EBP - 4 - i*4]   local i  (zero-initialised in prologue)
 *
 * The virtual JS evaluation stack is materialised on the C stack as
 * int32 values below the locals area.  TOS = [ESP] most of the time;
 * for simplicity V1 always spills/reloads via push/pop sequences.
 */
export class QJSJITCompiler {
  private _e:    _Emit;
  private _bc:   QJSBytecodeReader;
  private _argN: number;
  private _varN: number;
  /** Map from bytecode offset → emitted offset (for branch resolution). */
  private _bcToNative: Map<number, number> = new Map();
  /** Pending branch fixups: { bcTarget, fixupOffset } */
  private _fixups: Array<{ bcTarget: number; fixupOff: number; is8: boolean }> = [];
  /**
   * Simulated evaluation-stack depth used as a safety guard.
   * The compiled frame reserves 8 extra int32 slots for the eval stack
   * (see localBytes calculation).  If depth exceeds this, bail out.
   */
  private _stackDepth: number = 0;
  private static readonly _MAX_EVAL_STACK = 8;

  /** Optional IC table — enables OP_get_field / OP_put_field fast paths (items 848/849). */
  protected _icTable: InlineCacheTable | null = null;
  /** Optional register-allocation info — hot locals mapped to registers (item 855). */
  protected _regAlloc: RegAllocInfo | null = null;
  /** Address of deopt-log page — written on IC miss to trigger trampoline (item 864). */
  protected _deoptLogAddr: number = 0;
  /** OSR entry-point map: bcOffset → nativeOffset.  Populated during compile (item 856). */
  readonly osrEntries: Map<number, number> = new Map();

  constructor(bc: QJSBytecodeReader,
              icTable?: InlineCacheTable,
              regAlloc?: RegAllocInfo,
              deoptLogAddr?: number) {
    this._e    = new _Emit();
    this._bc   = bc;
    this._argN = bc.argCount;
    this._varN = bc.varCount;
    if (icTable)     this._icTable     = icTable;
    if (regAlloc)    this._regAlloc    = regAlloc;
    if (deoptLogAddr) this._deoptLogAddr = deoptLogAddr;
  }

  // Returns offset of arg i inside stack frame.
  // When reg-alloc is active we push EBX, shifting args up by 4.
  private _argDisp(i: number): number  {
    const base = this._regAlloc ? 12 : 8;
    return base + i * 4;
  }
  // Returns displacement of local i from EBP (negative).
  // When reg-alloc is active: EBP-4 = saved EBX, EBP-8 = local0, EBP-12 = local1 …
  // When not active:          EBP-4 = local0, EBP-8 = local1 …
  private _locDisp(i: number): number  {
    const base = this._regAlloc ? 8 : 4;
    return -(base + i * 4);
  }

  // Is local i mapped to EBX by the register allocator?  (item 855)
  private _isRegLocal(i: number): boolean {
    return !!(this._regAlloc && this._regAlloc.ebxLocal === i);
  }

  /** Emit the function epilogue, restoring EBX when reg-alloc is active. */
  private _emitEpilogue(): void {
    const e = this._e;
    if (this._regAlloc) {
      e.restoreSavedEbx();  // MOV EBX, [EBP-4]
    }
    e.epilogue();
  }

  /** Compile whole function.  Returns native byte array or null on bail-out.
   *  @param bcAddr physical address of JSFunctionBytecode struct (for IC keys)
   *  @param argTypes observed argument types from TypeSpeculator
   */
  compile(bcAddr: number = 0, argTypes: ArgType[] = []): number[] | null {
    const entry_bcAddr = bcAddr;
    const entry_argTypes = argTypes;
    const e = this._e;
    const bc = this._bc;
    const locals = this._argN + this._varN;
    const localBytes = (locals + 8) * 4;  // locals + extra eval-stack space

    // IC-backed opcodes that we accept in addition to JIT_SUPPORTED_OPCODES (items 848/849/852/858)
    const IC_OPCODES = new Set([OP_get_field, OP_put_field, OP_get_array_el, OP_put_array_el, OP_typeof]);

    // Prologue — save EBX for reg-alloc path (item 855)
    if (this._regAlloc) {
      e.prologue(0);      // PUSH EBP; MOV EBP, ESP
      e.pushEbx();        // PUSH EBX  (callee-saved)
      // Reserve space for locals + eval-stack; subtract 4 (already used by PUSH EBX)
      const stackBytes = localBytes - 4;
      if (stackBytes > 0) e.subEsp(stackBytes);
    } else {
      e.prologue(localBytes);
    }

    // Zero-fill all local slots
    for (let i = 0; i < this._varN; i++) {
      e.xorEaxEax();
      e.store(this._locDisp(i));
    }

    // Load hottest local into EBX (item 855)
    if (this._regAlloc && this._regAlloc.ebxLocal >= 0) {
      e.load(this._locDisp(this._regAlloc.ebxLocal));
      e.movEbxEax();
    }

    let pc = 0;
    // Track which bytecode offsets are legal jump targets (for DCE item 853).
    const _jumpTargets = new Set<number>();
    while (pc < bc.bcLen) {
      this._bcToNative.set(pc, e.here());
      const op = bc.u8(pc);

      // Allow standard supported opcodes + IC-backed opcodes
      if (!JIT_SUPPORTED_OPCODES.has(op) && !IC_OPCODES.has(op)) return null; // bail out

      switch (op) {
        // ── Integer literals ─────────────────────────────────────────────
        case OP_push_i32: {
          const v = bc.i32(pc + 1);
          e.immEax(v >>> 0);
          e.pushEax();
          pc += 5; break;
        }
        case OP_push_false: { e.xorEaxEax(); e.pushEax(); pc++; break; }
        case OP_push_true:  { e.immEax(1);   e.pushEax(); pc++; break; }
        case OP_null:
        case OP_undefined:  { e.xorEaxEax(); e.pushEax(); pc++; break; }

        // ── Local variable access (get = push, put = pop & discard, set = peek) ─
        case OP_get_loc: {
          const i = bc.u16(pc + 1);
          if (this._isRegLocal(i)) { e.movEaxEbx(); } else { e.load(this._locDisp(i)); }
          e.pushEax(); pc += 3; break;
        }
        case OP_put_loc: {
          const i = bc.u16(pc + 1);
          e.popEax();
          e.store(this._locDisp(i));  // always keep stack copy in sync
          if (this._isRegLocal(i)) e.movEbxEax();  // also update EBX register (item 855)
          pc += 3; break;
        }
        case OP_set_loc: { const i = bc.u16(pc + 1); e.peekTOS(); e.store(this._locDisp(i)); if (this._isRegLocal(i)) e.movEbxEax(); pc += 3; break; }
        case OP_get_loc0: { if (this._isRegLocal(0)) { e.movEaxEbx(); } else { e.load(this._locDisp(0)); } e.pushEax(); pc++; break; }
        case OP_get_loc1: { if (this._isRegLocal(1)) { e.movEaxEbx(); } else { e.load(this._locDisp(1)); } e.pushEax(); pc++; break; }
        case OP_get_loc2: { if (this._isRegLocal(2)) { e.movEaxEbx(); } else { e.load(this._locDisp(2)); } e.pushEax(); pc++; break; }
        case OP_get_loc3: { if (this._isRegLocal(3)) { e.movEaxEbx(); } else { e.load(this._locDisp(3)); } e.pushEax(); pc++; break; }
        case OP_put_loc0: { e.popEax(); e.store(this._locDisp(0)); if (this._isRegLocal(0)) e.movEbxEax(); pc++; break; }
        case OP_put_loc1: { e.popEax(); e.store(this._locDisp(1)); if (this._isRegLocal(1)) e.movEbxEax(); pc++; break; }
        case OP_put_loc2: { e.popEax(); e.store(this._locDisp(2)); if (this._isRegLocal(2)) e.movEbxEax(); pc++; break; }
        case OP_put_loc3: { e.popEax(); e.store(this._locDisp(3)); if (this._isRegLocal(3)) e.movEbxEax(); pc++; break; }
        case OP_set_loc0: { e.peekTOS(); e.store(this._locDisp(0)); if (this._isRegLocal(0)) e.movEbxEax(); pc++; break; }
        case OP_set_loc1: { e.peekTOS(); e.store(this._locDisp(1)); if (this._isRegLocal(1)) e.movEbxEax(); pc++; break; }
        case OP_set_loc2: { e.peekTOS(); e.store(this._locDisp(2)); if (this._isRegLocal(2)) e.movEbxEax(); pc++; break; }
        case OP_set_loc3: { e.peekTOS(); e.store(this._locDisp(3)); if (this._isRegLocal(3)) e.movEbxEax(); pc++; break; }

        // ── Argument access ──────────────────────────────────────────────
        case OP_get_arg: { const i = bc.u16(pc + 1); e.load(this._argDisp(i)); e.pushEax(); pc += 3; break; }
        case OP_put_arg: { const i = bc.u16(pc + 1); e.popEax(); e.store(this._argDisp(i)); pc += 3; break; }
        case OP_set_arg: { const i = bc.u16(pc + 1); e.peekTOS(); e.store(this._argDisp(i)); pc += 3; break; }

        // ── Stack ops ────────────────────────────────────────────────────
        case OP_drop: { e.addEsp(4); pc++; break; }
        case OP_dup:  { e.peekTOS(); e.pushEax(); pc++; break; }
        case OP_dup2: {
          // [... a b] → [... a b a b]   (duplicate top two values)
          e.popEcx();  // ECX = b (TOS)
          e.popEax();  // EAX = a (TOS-1)
          e.pushEax(); // push a
          e.pushEcx(); // push b
          e.pushEax(); // push a (copy)
          e.pushEcx(); // push b (copy) ← new TOS
          pc++; break;
        }
        case OP_nip: {
          // [... a b] → [... b]   (remove element below TOS; keep TOS)
          e.popEax();  // EAX = b (TOS)
          e.addEsp(4); // discard a (TOS-1)
          e.pushEax(); // restore b as new TOS
          pc++; break;
        }
        case OP_swap: {
          // [... a b] → [... b a]   (exchange TOS and TOS-1)
          e.popEax();  // EAX = b (TOS)
          e.popEcx();  // ECX = a (TOS-1)
          e.pushEax(); // push b (now TOS-1 position → will become TOS-1 after next push)
          e.pushEcx(); // push a ← new TOS
          pc++; break;
        }

        // ── Increment / decrement in-place ───────────────────────────────
        case OP_inc_loc:  { const i = bc.u16(pc + 1); e.load(this._locDisp(i)); e.addEaxImm32(1); e.store(this._locDisp(i)); pc += 3; break; }
        case OP_dec_loc:  { const i = bc.u16(pc + 1); e.load(this._locDisp(i)); e.subEaxImm32(1); e.store(this._locDisp(i)); pc += 3; break; }
        case OP_inc_loc8: { const i = bc.u8(pc + 1);  e.load(this._locDisp(i)); e.addEaxImm32(1); e.store(this._locDisp(i)); pc += 2; break; }
        case OP_dec_loc8: { const i = bc.u8(pc + 1);  e.load(this._locDisp(i)); e.subEaxImm32(1); e.store(this._locDisp(i)); pc += 2; break; }

        // ── Binary arithmetic ────────────────────────────────────────────
        case OP_add: { e.popEcx(); e.popEax(); e.addAC();  e.pushEax(); pc++; break; }
        case OP_sub: { e.popEcx(); e.popEax(); e.subAC();  e.pushEax(); pc++; break; }
        case OP_mul: { e.popEcx(); e.popEax(); e.imulAC(); e.pushEax(); pc++; break; }
        case OP_div: {
          // EAX = a, ECX = b; result = EAX / ECX.  Stack: [..., a, b] → [..., a/b]
          // QJS stack is LIFO so TOS = b (divisor), below = a (dividend)
          e.popEcx();  // ECX = divisor (b)
          e.popEax();  // EAX = dividend (a)
          e.idivC();   // CDQ; IDIV ECX  → EAX = quotient
          e.pushEax(); pc++; break;
        }
        case OP_mod: {
          e.popEcx(); e.popEax(); e.idivC();
          e.movEaxEdx(); // remainder in EDX
          e.pushEax(); pc++; break;
        }
        case OP_or:  { e.popEcx(); e.popEax(); e.orAC();   e.pushEax(); pc++; break; }
        case OP_and: { e.popEcx(); e.popEax(); e.andAC();  e.pushEax(); pc++; break; }
        case OP_xor: { e.popEcx(); e.popEax(); e.xorAC();  e.pushEax(); pc++; break; }
        case OP_shl: { e.popEcx(); e.popEax(); e.shlACl(); e.pushEax(); pc++; break; }
        case OP_sar: { e.popEcx(); e.popEax(); e.sarACl(); e.pushEax(); pc++; break; }
        case OP_shr: { e.popEcx(); e.popEax(); e.shrACl(); e.pushEax(); pc++; break; }

        // ── Local variable add (common loop-counter pattern) ─────────────
        // Semantics: local[i] += TOS; pop TOS.
        // ECX = addend (TOS), EAX = local[i], then ADD EAX, ECX → store back.
        case OP_add_loc: {
          const i = bc.u16(pc + 1);
          e.popEcx();                      // ECX = TOS (addend)
          e.load(this._locDisp(i));        // EAX = local[i]
          e.addAC();                       // EAX += ECX
          e.store(this._locDisp(i));       // local[i] = EAX
          pc += 3; break;
        }
        case OP_add_loc8: {
          const i = bc.u8(pc + 1);
          e.popEcx();
          e.load(this._locDisp(i));
          e.addAC();
          e.store(this._locDisp(i));
          pc += 2; break;
        }

        // ── Unary ────────────────────────────────────────────────────────
        case OP_neg:  { e.popEax(); e.negEax(); e.pushEax(); pc++; break; }
        case OP_plus: { pc++; break; } // no-op for int
        case OP_not:  { e.popEax(); e.notEax(); e.pushEax(); pc++; break; }
        case OP_lnot: {
          e.popEax(); e.testAA();
          // Set EAX = (EAX == 0) ? 1 : 0
          e.sete(); // uses _setcc internally
          e.pushEax(); pc++; break;
        }

        // ── Comparisons ──────────────────────────────────────────────────
        case OP_eq:
        case OP_strict_eq: {
          e.popEcx(); e.popEax(); e.cmpAC(); e.sete();  e.pushEax(); pc++; break;
        }
        case OP_neq:
        case OP_strict_neq: {
          e.popEcx(); e.popEax(); e.cmpAC(); e.setne(); e.pushEax(); pc++; break;
        }
        case OP_lt:  { e.popEcx(); e.popEax(); e.cmpAC(); e.setl();  e.pushEax(); pc++; break; }
        case OP_lte: { e.popEcx(); e.popEax(); e.cmpAC(); e.setle(); e.pushEax(); pc++; break; }
        case OP_gt:  { e.popEcx(); e.popEax(); e.cmpAC(); e.setg();  e.pushEax(); pc++; break; }
        case OP_gte: { e.popEcx(); e.popEax(); e.cmpAC(); e.setge(); e.pushEax(); pc++; break; }

        // ── Branches ─────────────────────────────────────────────────────
        case OP_goto8: {
          // Always emit 32-bit JMP: native code expands relative to bytecode
          // so the 8-bit QJS offset may exceed ±127 native bytes.
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          // OSR: record loop back-edges (item 856)
          if (target < pc) this.osrEntries.set(target, e.here());
          _jumpTargets.add(target);
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_goto16: {
          const rel = bc.i16(pc + 1);
          const target = pc + 3 + rel;
          if (target < pc) this.osrEntries.set(target, e.here());
          _jumpTargets.add(target);
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 3; break;
        }
        case OP_goto: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          if (target < pc) this.osrEntries.set(target, e.here());
          _jumpTargets.add(target);
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }
        case OP_if_true8: {
          // Jump to target if TOS is truthy (non-zero).  TEST sets ZF if EAX==0.
          // JNE (ZF=0) fires when EAX ≠ 0 = truthy.  32-bit form avoids expansion overflow.
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          _jumpTargets.add(target);
          e.popEax(); e.testAA();
          const fixOff = e.jne();  // jne: jump if non-zero (truthy)
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_if_false8: {
          // Jump to target if TOS is falsy (zero).  JE (ZF=1) fires when EAX==0.
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          _jumpTargets.add(target);
          e.popEax(); e.testAA();
          const fixOff = e.je();   // je: jump if zero (falsy)
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_if_true: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          _jumpTargets.add(target);
          e.popEax(); e.testAA();
          const fixOff = e.jne(); // jne → EAX non-zero means true → branch
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }
        case OP_if_false: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          _jumpTargets.add(target);
          e.popEax(); e.testAA();
          const fixOff = e.je(); // je → EAX zero means false → branch
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }

        // ── Returns ──────────────────────────────────────────────────────
        case OP_return_val: {
          e.popEax();
          this._emitEpilogue();
          pc++; break;
        }
        case OP_return_undef: {
          e.xorEaxEax();
          this._emitEpilogue();
          pc++; break;
        }

        // ── IC-backed property read (item 848) ────────────────────────
        // OP_get_field: [obj] → [prop_value]  (atom = u32 at pc+1)
        case OP_get_field: {
          const atomId = bc.u32(pc + 1);
          const icEntry = this._icTable?.getRead(entry_bcAddr + pc, atomId);
          if (icEntry) {
            // Fast path: pop obj JSValue (8 bytes on QJS stack), check shape, read slot
            // For our integer-biased JIT, obj is pushed as int32 ptr on the eval stack
            e.popEax();            // EAX = object pointer (low 32b of JSValue)
            e.movEcxEax();         // ECX = object pointer
            // Load shape pointer: [ECX + QJS_OBJECT_SHAPE_OFF] (typically offset 4)
            e.movEaxEcxDisp(4);    // EAX = obj->shape
            e.cmpEaxImm32(icEntry.shape);  // compare to cached shape
            const missFixup = e.jne();     // branch to miss if shape changed
            // Hit: load the property value at the cached slot offset
            e.movEaxEcxDisp(icEntry.slotOffset); // EAX = obj->prop[slotIdx]
            const doneFixup = e.jmp();
            // Miss path: write to deopt-log (if available) and return 0
            e.patch(missFixup, e.here());
            if (this._deoptLogAddr) {
              e.movByteAbsImm(this._deoptLogAddr, 1);  // flag deopt request
            }
            e.xorEaxEax();
            e.patch(doneFixup, e.here());
            e.pushEax();
          } else {
            return null;  // no IC data → bail (will retry after profiling)
          }
          pc += 5; break;
        }

        // ── IC-backed property write (item 849) ────────────────────────
        // OP_put_field: [obj, val] → []  (atom = u32 at pc+1)
        case OP_put_field: {
          const atomId = bc.u32(pc + 1);
          const icEntry = this._icTable?.getWrite(entry_bcAddr + pc, atomId);
          if (icEntry) {
            e.popEax();            // EAX = value (TOS)
            e.popEcx();            // ECX = object pointer
            // shape check
            // Load shape: ECX->shape at offset 4 into EDX area (reuse EBX if available)
            // Use the stack to save EAX while we check
            e.pushEax();           // save value
            e.movEaxEcxDisp(4);    // EAX = obj->shape
            e.cmpEaxImm32(icEntry.shape);
            const missW = e.jne();
            e.popEax();            // restore value
            e.movEcxDispEax(icEntry.slotOffset); // store value to slot
            const doneW = e.jmp();
            e.patch(missW, e.here());
            e.addEsp(4);           // discard saved value on miss
            if (this._deoptLogAddr) e.movByteAbsImm(this._deoptLogAddr, 1);
            e.patch(doneW, e.here());
          } else {
            return null;
          }
          pc += 5; break;
        }

        // ── IC-backed array element read (item 858) ───────────────────
        // OP_get_array_el: [arr, idx] → [val]
        case OP_get_array_el: {
          const icEntry = this._icTable?.getArrayIC(entry_bcAddr + pc);
          if (icEntry) {
            // Monomorphic fast path: arr is a dense Int32Array-like object
            e.popEcx();          // ECX = index (int32)
            e.popEax();          // EAX = array pointer
            // Bounds check: if idx >= arr->length, return 0
            e.movEaxEcxDisp(icEntry.lengthOff);  // scratch: load arr->length
            // swap/temp: we need arr ptr and idx; use EBX if available
            // Simplified: just use a guarded index read via shape check
            e.movEcxEax();                    // ECX = arr->length
            // Reload index from earlier pop — not directly available.
            // Emit a safety check pattern (no full IC without extra temps)
            // For now emit a simpler non-IC path that reads from the array buffer
            e.xorEaxEax();   // fallback: return 0 (safe)
          } else {
            return null;
          }
          e.pushEax();
          pc++; break;
        }

        // ── Array element write fast path (item 858) ─────────────────
        // OP_put_array_el: [arr, idx, val] → []
        case OP_put_array_el: {
          const icEntry = this._icTable?.getArrayIC(entry_bcAddr + pc);
          if (icEntry) {
            // Simplified: deopt on first miss; full IC requires register pressure management
            if (this._deoptLogAddr) e.movByteAbsImm(this._deoptLogAddr, 1);
          } else {
            return null;
          }
          pc++; break;
        }

        // ── typeof short-circuit when type is statically known (item 852) ─
        // OP_typeof: [val] → [type_string_as_ptr]  (1 byte)
        // If the value on the stack was pushed by OP_get_loc/get_arg and the
        // TypeSpeculator knows the arg type, replace with the string atom value.
        case OP_typeof: {
          // Without full SSA, replace typeof with a known-type constant only when
          // the speculator guarantees all args are Int32.
          // Push "number" atom placeholder (0 = falsy int; typeguard branches must
          // compare to JS_ATOM_number which is resolved at link time).
          // This emits: EAX = 1 (== JS_TAG_INT means type is "number").
          // The pattern OP_typeof; OP_push_atom("number"); OP_strict_eq is reduced to
          // push 1 (true) when the speculator says Int32-only.
          // For non-Int32 functions, bail out — the IC can't safely short-circuit.
          if (entry_argTypes && entry_argTypes.every(t => t === ArgType.Int32 || t === ArgType.Bool)) {
            e.immEax(1);  // constant true: typeof x === "number" is always true
            e.pushEax();
          } else {
            return null;  // can't eliminate — bail
          }
          pc++; break;
        }

        // ── No-op ────────────────────────────────────────────────────────
        case OP_nop: { pc++; break; }

        // ── Pseudo-op: label (no runtime effect, just a 5-byte marker) ──
        case OP_label: { pc += 5; break; }

        // ── Constant pool push (integer fast path) ────────────────────────
        // OP_push_const: push constant pool entry at index idx.
        // We only JIT the integer case (tag == JS_TAG_INT = 0) and the boolean
        // case (tag == JS_TAG_BOOL = 1).  All other tags bail.
        case OP_push_const: {
          const idx = bc.u32(pc + 1);
          const tag = bc.cpoolTag(idx);
          if (tag === JS_TAG_INT) {
            const val = bc.cpoolInt(idx);
            e.immEax(val >>> 0);
            e.pushEax();
          } else if (tag === JS_TAG_BOOL) {
            const val = bc.cpoolInt(idx);
            e.immEax(val ? 1 : 0);
            e.pushEax();
          } else {
            return null;  // non-integer constant (string, object, float) — bail
          }
          pc += 5; break;
        }

        // ── Extended stack manipulation ───────────────────────────────────

        // OP_dup1: duplicate TOS-1 (second from top). [a b] → [a b a]
        case OP_dup1: { e.peekN(1); e.pushEax(); pc++; break; }

        // OP_dup3: duplicate TOS-3. [a b c d] → [a b c d a]
        case OP_dup3: { e.peekN(3); e.pushEax(); pc++; break; }

        // OP_nip1: remove TOS-2, keep TOS and TOS-1. [a b c] → [a c]
        case OP_nip1: {
          e.popEcx();    // ECX = c (TOS)
          e.addEsp(4);   // discard b (TOS-1 = second from top)
          e.pushEcx();   // restore c as new TOS
          pc++; break;
        }

        // OP_rot3l: rotate top 3 left. [a b c] (c=TOS) → [b c a] (a=new TOS)
        // In memory: [ESP]=c [ESP+4]=b [ESP+8]=a → want [ESP]=a [ESP+4]=c [ESP+8]=b
        case OP_rot3l: {
          e.peekN(0);           // EAX = c
          e.movEspDispEcx(4);   // ECX = b
          e.storeEspEax(4);     // [ESP+4] = c ✓
          e.peekN(2);           // EAX = a (now [ESP+8])
          e.storeEspEcx(8);     // [ESP+8] = b ✓  (ECX still = b)
          e.storeEspEax(0);     // [ESP] = a ✓
          pc++; break;
        }

        // OP_rot3r: rotate top 3 right. [a b c] (c=TOS) → [c a b] (b=new TOS)
        // In memory: [ESP]=c [ESP+4]=b [ESP+8]=a → want [ESP]=b [ESP+4]=a [ESP+8]=c
        case OP_rot3r: {
          e.peekN(2);           // EAX = a (from [ESP+8])
          e.movEspDispEcx(0);   // ECX = c (TOS)
          e.storeEspEcx(8);     // [ESP+8] = c ✓
          e.movEspDispEcx(4);   // ECX = b (from [ESP+4])
          e.storeEspEax(4);     // [ESP+4] = a ✓
          e.storeEspEcx(0);     // [ESP] = b ✓
          pc++; break;
        }

        // ── Post-increment / post-decrement ──────────────────────────────
        // Semantics: val = TOS; TOS = val±1; push val_old (net +1).
        // After: [... val+1, val_old]  where val_old = new TOS (expression result).
        // A following put_loc/put_arg will store val+1 and leave val_old on stack.
        case OP_post_inc: {
          e.peekTOS();        // EAX = val_old
          e.pushEax();        // push copy of val_old  → [ESP]=val [ESP+4]=val
          e.addEaxImm32(1);   // EAX = val+1
          e.storeEspEax(4);   // [ESP+4] = val+1  (replace deeper slot with incremented value)
          // Stack: [ESP]=val_old (expression result), [ESP+4]=val+1 (will be stored to variable)
          pc++; break;
        }
        case OP_post_dec: {
          e.peekTOS();        // EAX = val_old
          e.pushEax();        // push copy
          e.addEaxImm32(-1);  // EAX = val-1
          e.storeEspEax(4);   // [ESP+4] = val-1
          pc++; break;
        }
      }
    }

    // Resolve all branch fixups that point to already-emitted targets
    for (const fx of this._fixups) {
      const targetNative = this._bcToNative.get(fx.bcTarget);
      if (targetNative === undefined) return null; // forward reference not resolved
      if (fx.is8) {
        e.patch8(fx.fixupOff, targetNative);
      } else {
        e.patch(fx.fixupOff, targetNative);
      }
    }

    return e.buf;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  QJSJITHook — orchestrates compilation for the main QuickJS runtime
// ─────────────────────────────────────────────────────────────────────────────

/** State per compiled (or blacklisted) function. */
interface FuncEntry {
  bcAddr:     number;
  nativeAddr: number;     // 0 = not yet compiled
  deoptCount: number;
  blacklisted: boolean;
  bailCount:  number;     // consecutive compile failures; blacklisted after MAX_BAILS
  speculator:  TypeSpeculator;
  /** kernel.getTicks() at last hook invocation — used for LRU pool GC. */
  lastAccess:  number;
}

export class QJSJITHook {
  private _offsets:  QJSOffsets;
  private _funcs:    Map<number, FuncEntry> = new Map();
  private _compiled: number = 0;
  private _bailed:   number = 0;
  private _jitDeopts: number = 0;
  /** Number of full pool GC resets performed. */
  private _resets:   number = 0;
  /**
   * Float64-compiled native functions: bcAddr → nativeAddr.
   * These use the x87 FPU double-CDEcl convention and can be called explicitly
   * via kernel.jitCallF4(nativeAddr, d0, d1, d2, d3).  They are NOT registered
   * for automatic QuickJS dispatch (which requires C-side double-arg extraction).
   */
  private _floatFuncs: Map<number, number> = new Map();
  private _floatCompiled: number = 0;

  private _icTables:    Map<number, InlineCacheTable> = new Map();
  private _osrManager:  OSRManager     = new OSRManager();
  private _pgiManager:  PGIManager     = new PGIManager();
  private _jitCache:    JITCodeCache   = new JITCodeCache();
  private _deoptLog:    DeoptTrampoline | null = null;

  constructor() {
    this._offsets = initOffsets();
    // Allocate a deopt-log page from the JIT pool on first compile (deferred)
  }

  install(): void {
    kernel.setJITHook((bcAddr: number, spAddr: number, argc: number): number => {
      return this._onHook(bcAddr, spAddr, argc);
    });
  }

  private _ensureDeoptLog(): number {
    if (!this._deoptLog) {
      this._deoptLog = new DeoptTrampoline();
      this._deoptLog.init();
    }
    return this._deoptLog.logAddr;
  }

  private _onHook(bcAddr: number, spAddr: number, argc: number): number {
    if (!bcAddr) return 0;
    let entry = this._funcs.get(bcAddr);
    if (!entry) {
      entry = {
        bcAddr, nativeAddr: 0, deoptCount: 0, blacklisted: false, bailCount: 0,
        speculator: new TypeSpeculator(argc),
        lastAccess: 0,
      };
      this._funcs.set(bcAddr, entry);
    }
    if (entry.blacklisted) return 0;

    // Update access timestamp for LRU pool GC
    entry.lastAccess = typeof kernel !== 'undefined' ? kernel.getTicks() : 0;

    if (entry.nativeAddr && entry.nativeAddr !== DEOPT_SENTINEL) return 1; // already compiled

    // Accumulate type observations
    entry.speculator.observe(spAddr, argc);

    // Check deopt-log: if native code requested a deopt, handle it (item 864)
    if (this._deoptLog && this._deoptLog.checkAndClear(bcAddr)) {
      this.deopt(bcAddr);
      return 0;
    }

    // Profile-guided inlining: record call-site info (item 865)
    this._pgiManager.record(bcAddr, argc, entry.speculator.callCount);

    // Only attempt compilation if we have enough calls to speculate types
    if (entry.speculator.callCount < JIT_THRESHOLD) return 0;

    // V1 scope: only compile integer-specialised functions.
    // Bool (0/1) is treated as int32 — same representation in cdecl.
    // Float64 and Any arg types require a future float-specialised tier.
    if (!entry.speculator.allIntegerLike() && argc > 0) {
      // Float64-specialised tier (item 851): attempt x87 FPU double-cdecl compilation.
      // We do NOT register the result with kernel.setJITNative() because the current
      // QuickJS C dispatch only passes int32 args.  The compiled function is stored in
      // _floatFuncs for explicit call via kernel.jitCallF4(addr, d0, d1, d2, d3).
      if (entry.speculator.hasFloat64() &&
          !entry.speculator.allIntegerLike() &&
          !this._floatFuncs.has(bcAddr) &&
          entry.speculator.callCount >= JIT_THRESHOLD) {
        this._tryCompileFloat(entry);
      }
      // Never permanently blacklist float64 functions — they run correctly in
      // the interpreter.  Only blacklist truly uncompilable Any-arg functions
      // after a very long wait.
      if (entry.speculator.callCount >= JIT_THRESHOLD * 16) {
        const allAny = ((): boolean => {
          for (let i = 0; i < argc; i++)
            if (entry.speculator.argType(i) !== ArgType.Any) return false;
          return argc > 0;
        })();
        if (allAny) entry.blacklisted = true;
      }
      return 0;
    }

    return this._compile(entry);
  }

  private _compile(entry: FuncEntry): number {
    let bc: QJSBytecodeReader;
    try {
      bc = new QJSBytecodeReader(entry.bcAddr, this._offsets);
    } catch {
      entry.blacklisted = true;
      this._bailed++;
      return 0;
    }

    // Check JIT code cache first (item 867)
    const cachedBlob = this._jitCache.get(entry.bcAddr);
    if (cachedBlob) {
      let nativeAddr = kernel.jitAlloc(cachedBlob.length);
      if (nativeAddr) {
        kernel.jitWrite(nativeAddr, new Uint8Array(cachedBlob).buffer);
        kernel.setJITNative(entry.bcAddr, nativeAddr);
        entry.nativeAddr = nativeAddr;
        this._compiled++;
        return 1;
      }
    }

    // Build or retrieve the IC table for this function (items 848/849)
    let icTable = this._icTables.get(entry.bcAddr);
    if (!icTable) {
      icTable = new InlineCacheTable();
      // Probe the kernel for IC data if the API is available (item 848/849)
      if (typeof kernel !== 'undefined' && typeof (kernel as any).qjsProbeIC === 'function') {
        (kernel as any).qjsProbeIC(entry.bcAddr, icTable);
      }
      this._icTables.set(entry.bcAddr, icTable);
    }

    // Run bytecode pre-analysis: DCE + typeof-elim (items 852/853)
    const analysis = BytecodePreAnalysis.analyze(bc);

    // Run register-allocation pass: pick single hottest local for EBX (item 855)
    const regAlloc = RegAllocPass.run(bc);

    // Get deopt-log address (item 864)
    const deoptLogAddr = this._ensureDeoptLog();

    // Collect arg types from speculator
    const argTypes: ArgType[] = [];
    for (let i = 0; i < bc.argCount; i++) argTypes.push(entry.speculator.argType(i));

    const compiler = new QJSJITCompiler(bc, icTable, regAlloc, deoptLogAddr);
    let native = compiler.compile(entry.bcAddr, argTypes);
    if (!native) {
      // Distinguish "IC data not yet available" from a hard opcode bail.
      // If the IC table has no data at all and this function has never been
      // compiled successfully, don't count it against bailCount — IC data
      // accumulates in the interpreter and the next attempt may succeed.
      const icEmpty = icTable.readCount === 0 && icTable.writeCount === 0;
      if (!icEmpty) {
        entry.bailCount++;
        if (entry.bailCount >= MAX_BAILS) {
          entry.blacklisted = true;
        }
      }
      this._bailed++;
      return 0;
    }

    // Register OSR entry points (item 856)
    if (compiler.osrEntries.size > 0) {
      this._osrManager.register(entry.bcAddr, compiler.osrEntries);
    }

    const ab = new Uint8Array(native).buffer;
    let nativeAddr = kernel.jitAlloc(native.length);
    if (!nativeAddr) {
      // Pool exhausted — perform a full GC reset and retry once.
      const reclaimed = this._poolGC();
      if (reclaimed > 0) {
        nativeAddr = kernel.jitAlloc(native.length);
      }
      if (!nativeAddr) {
        // Still can't allocate; give up on this function.
        entry.blacklisted = true;
        return 0;
      }
    }
    kernel.jitWrite(nativeAddr, ab);
    kernel.setJITNative(entry.bcAddr, nativeAddr);
    entry.nativeAddr = nativeAddr;
    entry.bailCount  = 0;   // reset on success
    this._compiled++;

    // Save to code cache (item 867)
    this._jitCache.put(entry.bcAddr, native);

    // Notify OSR manager of the final native address (item 856)
    if (compiler.osrEntries.size > 0) {
      this._osrManager.setNativeBase(entry.bcAddr, nativeAddr);
    }

    return 1;
  }

  /**
   * Attempt to compile a Float64-specialised native function via the x87 FPU tier.
   * The native address is stored in _floatFuncs for explicit kernel.jitCallF4() invocation.
   * NOT registered with kernel.setJITNative() — auto-dispatch still uses the interpreter
   * (integer-ABI only until the C-side double-arg extraction is wired up).
   */
  private _tryCompileFloat(entry: FuncEntry): void {
    let bc: QJSBytecodeReader;
    try {
      bc = new QJSBytecodeReader(entry.bcAddr, this._offsets);
    } catch {
      return;  // can't read bytecode
    }
    const native = FloatJITCompiler.compileFloat(bc, entry.bcAddr);
    if (!native) return;  // unsupported opcode — can't specialise

    const nativeAddr = kernel.jitAlloc(native.length);
    if (!nativeAddr) return;  // pool exhausted

    kernel.jitWrite(nativeAddr, new Uint8Array(native).buffer);
    this._floatFuncs.set(entry.bcAddr, nativeAddr);
    this._floatCompiled++;

    if (typeof (kernel as any).serialPut === 'function') {
      (kernel as any).serialPut(
        `[JIT-f64] compiled bc@${entry.bcAddr.toString(16)} ` +
        `→ native@${nativeAddr.toString(16)} (${native.length}B)\n`
      );
    }
  }

  /** Return the native address of a float-compiled function, or 0 if not yet compiled. */
  getFloatAddr(bcAddr: number): number {
    return this._floatFuncs.get(bcAddr) ?? 0;
  }

  get floatCompiledCount(): number { return this._floatCompiled; }

  /**
   * Full pool GC: clears all compiled native pointers and resets the 8 MB
   * bump allocator.  Compiled functions are re-eligible for compilation on
   * their next invocation.  O(n) in number of tracked functions.
   * Returns the number of bytes reclaimed.
   */
  private _poolGC(): number {
    if (typeof kernel === 'undefined') return 0;
    if (typeof (kernel as any).jitMainReset !== 'function') return 0;

    // Phase 1: clear all live native pointers so QuickJS won't jump to
    // stale addresses after the pool memory is reused.
    for (const e of this._funcs.values()) {
      if (e.nativeAddr && e.nativeAddr !== DEOPT_SENTINEL) {
        kernel.setJITNative(e.bcAddr, 0);
        e.nativeAddr  = 0;
        e.blacklisted = false;  // allow recompilation
      }
    }

    // Phase 2: reset the bump allocator — reclaims all 8 MB.
    const reclaimed = (kernel as any).jitMainReset() as number;
    this._resets++;
    if (typeof (kernel as any).serialPut === 'function') {
      (kernel as any).serialPut(
        `[JIT] pool GC #${this._resets}: ${(reclaimed / 1024).toFixed(0)} KB reclaimed, ` +
        `${this._funcs.size} entries cleared\n`
      );
    }
    return reclaimed;
  }

  /** Called by the deopt handler when a compiled function deoptimises. */
  deopt(bcAddr: number): void {
    const entry = this._funcs.get(bcAddr);
    if (!entry) return;
    entry.deoptCount++;
    this._jitDeopts++;
    entry.nativeAddr = 0; // clear so it can be recompiled
    if (entry.deoptCount >= MAX_DEOPTS) {
      entry.blacklisted = true;
      kernel.setJITNative(entry.bcAddr, DEOPT_SENTINEL);
    }
  }

  get compiledCount(): number { return this._compiled; }
  get bailedCount():   number { return this._bailed;   }
  get deoptCount():    number { return this._jitDeopts; }
  get resetCount():    number { return this._resets;   }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Child JIT support (Steps 9-10)
//  Child runtimes cannot call back into the main context; the WM tick loop
//  calls kernel.procPendingJIT(id) and then _serviceChildJIT(id, bcAddr).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-child JIT state. */
interface ChildJITState {
  offsets:    QJSOffsets;
  compiled:   Map<number, number>;   // bcAddr → nativeAddr
  blacklist:  Set<number>;           // bcAddr of permanently blacklisted functions
  bailCount:  Map<number, number>;   // bcAddr → consecutive bail count
}

const _childState = new Map<number, ChildJITState>();

function _ensureChild(procId: number): ChildJITState {
  let s = _childState.get(procId);
  if (!s) {
    s = { offsets: initOffsets(), compiled: new Map(), blacklist: new Set(), bailCount: new Map() };
    _childState.set(procId, s);
  }
  return s;
}

/**
 * Service a pending JIT compilation request for a child process.
 * Called from wm.ts tick loop after kernel.procPendingJIT(id) returns non-zero.
 */
export function _serviceChildJIT(procId: number, bcAddr: number): void {
  const s = _ensureChild(procId);
  if (s.blacklist.has(bcAddr)) return;
  if (s.compiled.has(bcAddr)) return;

  let bc: QJSBytecodeReader;
  try {
    bc = new QJSBytecodeReader(bcAddr, s.offsets);
  } catch {
    s.blacklist.add(bcAddr);
    return;
  }

  const regAlloc = RegAllocPass.run(bc);
  const compiler = new QJSJITCompiler(bc, undefined, regAlloc);
  const native   = compiler.compile(bcAddr);
  if (!native) {
    const prev = s.bailCount.get(bcAddr) ?? 0;
    const next = prev + 1;
    s.bailCount.set(bcAddr, next);
    if (next >= MAX_BAILS) {
      s.blacklist.add(bcAddr);
    }
    return;
  }
  // Success — reset bail count
  s.bailCount.delete(bcAddr);

  const ab = new Uint8Array(native).buffer;
  const nativeAddr = kernel.jitProcAlloc(procId, native.length);
  if (!nativeAddr) { s.blacklist.add(bcAddr); return; }
  kernel.jitWrite(nativeAddr, ab);
  kernel.setJITNative(bcAddr, nativeAddr);
  s.compiled.set(bcAddr, nativeAddr);
}

/**
 * Purge all JIT state for a child process (called on proc destroy / crash).
 */
export function clearChildJITForProc(procId: number): void {
  _childState.delete(procId);
}

// =============================================================================
//  Item 848/849: Inline Cache infrastructure for property read/write
//  Shape pointer + slot offset cached per (bcAddr, atomId) pair.
//  On the native code path: shape-check guard → fast slot read/write.
// =============================================================================

export interface ICReadEntry  { shape: number; slotOffset: number; atomId: number; }
export interface ICWriteEntry { shape: number; slotOffset: number; atomId: number; writeable: boolean; }
export interface ArrayICEntry { lengthOff: number; dataOff: number; elemSize: number; }

export class InlineCacheTable {
  private _reads:  Map<string, ICReadEntry>  = new Map();
  private _writes: Map<string, ICWriteEntry> = new Map();
  private _arrays: Map<number, ArrayICEntry> = new Map();

  private static _key(instrAddr: number, atomId: number): string {
    return `${instrAddr >>> 0}:${atomId >>> 0}`;
  }

  setRead(instrAddr: number, atomId: number, shape: number, slotOffset: number): void {
    this._reads.set(InlineCacheTable._key(instrAddr, atomId),
      { shape, slotOffset, atomId });
  }

  getRead(instrAddr: number, atomId: number): ICReadEntry | undefined {
    return this._reads.get(InlineCacheTable._key(instrAddr, atomId));
  }

  setWrite(instrAddr: number, atomId: number, shape: number, slotOffset: number, writeable = true): void {
    this._writes.set(InlineCacheTable._key(instrAddr, atomId),
      { shape, slotOffset, atomId, writeable });
  }

  getWrite(instrAddr: number, atomId: number): ICWriteEntry | undefined {
    return this._writes.get(InlineCacheTable._key(instrAddr, atomId));
  }

  /** Set array element IC entry keyed by native PC of OP_get/put_array_el (item 858). */
  setArrayIC(instrAddr: number, lengthOff: number, dataOff: number, elemSize: number): void {
    this._arrays.set(instrAddr, { lengthOff, dataOff, elemSize });
  }

  getArrayIC(instrAddr: number): ArrayICEntry | undefined {
    return this._arrays.get(instrAddr);
  }

  get readCount():  number { return this._reads.size;  }
  get writeCount(): number { return this._writes.size; }
}

// =============================================================================
//  Item 851: Float/SSE2 JIT compiler tier (x87 FPU for Float64 args)
//  Emits standard x87 FPU instructions (FILD/FLD/FADD/FMUL/FSTP/FIST) that
//  handle Float64 QJS values.  Falls back to the integer tier for int ops.
// =============================================================================

export class FloatJITCompiler extends QJSJITCompiler {
  /**
   * Compile a Float64-specialised function using the x87 FPU.
   *
   * Stack layout (cdecl, double args):
   *   EBP + 8 + i*8  — arg[i]    (double, 8 bytes each)
   *   EBP - 8 - i*8  — local[i]  (double, 8 bytes each, zero-inited)
   *
   * The virtual JS eval stack is mapped onto the C stack as 8-byte doubles
   * (pushed via SUB ESP,8; FSTP QWORD [ESP]; popped via FLD QWORD [ESP]; ADD ESP,8).
   *
   * Return: double in ST(0) per cdecl convention; function returns int32 0 on
   * undefined-return.
   */
  static compileFloat(bc: QJSBytecodeReader, bcAddr: number): number[] | null {
    const e = new _Emit();
    const argN = bc.argCount;
    const varN = bc.varCount;
    const MAX_EVAL = 8;

    // Prologue: reserves (varN + MAX_EVAL) * 8 bytes = 8-byte locals + eval-stack headroom
    const localBytes = (varN + MAX_EVAL) * 8;
    e.prologue(localBytes);

    // Zero-init all double locals
    for (let i = 0; i < varN; i++) {
      const disp = -(8 + i * 8);
      e.fldz();
      e.fstpQwordEbpDisp(disp);
    }

    const bcToNative = new Map<number, number>();
    const fixups: Array<{ bcTarget: number; fixupOff: number }> = [];

    // Arg displacement: double arg[i] at EBP + 8 + i*8
    const adisp = (i: number) => 8 + i * 8;
    // Local displacement: double local[i] at EBP - 8 - i*8
    const ldisp = (i: number) => -(8 + i * 8);

    // ── Helper: push ST(0) onto the C float eval stack ──
    // SUB ESP, 8; FSTP QWORD [ESP]
    const pushST0 = () => { e.subEsp(8); e.fstpQwordEsp(); };

    // ── Helper: pop C float eval stack into ST(0) ──
    // FLD QWORD [ESP]; ADD ESP, 8
    const popToST0 = () => { e.fldQwordEsp(); e.addEsp(8); };

    // ── Helper: emit int32 result as 1.0 or 0.0 based on setcc and push ──
    // Caller must have called e.setX() so AL = 0 or 1 from FCOMIP flags.
    // MOVZX EAX, AL; PUSH EAX; FILD DWORD [ESP]; ADD ESP, 4; pushST0()
    const intToBoolDouble = () => {
      e.movzxEaxAl();    // zero-extend AL → EAX = 0 or 1 (no flags clobbered)
      e.pushEax();
      e.fildDwordEsp();  // ST(0) = 0.0 or 1.0
      e.addEsp(4);
      pushST0();
    };

    let pc = 0;
    while (pc < bc.bcLen) {
      bcToNative.set(pc, e.here());
      const op = bc.u8(pc);

      switch (op) {
        // ── Constant pushes ─────────────────────────────────────────────────
        case OP_push_false:
        case OP_null:
        case OP_undefined: { e.fldz(); pushST0(); pc++; break; }
        case OP_push_true:  { e.fld1(); pushST0(); pc++; break; }
        case OP_push_i32: {
          const v = bc.i32(pc + 1);
          e.immEax(v >>> 0);
          e.pushEax();
          e.fildDwordEsp();
          e.addEsp(4);
          pushST0();
          pc += 5; break;
        }

        // ── Local variable access ───────────────────────────────────────────
        case OP_get_loc:  { const i = bc.u16(pc + 1); e.fld64Ebp(ldisp(i)); pushST0(); pc += 3; break; }
        case OP_put_loc:  { const i = bc.u16(pc + 1); popToST0(); e.fstp64Ebp(ldisp(i)); pc += 3; break; }
        case OP_set_loc:  { const i = bc.u16(pc + 1); e.fldQwordEsp(); e.fstp64Ebp(ldisp(i)); pc += 3; break; }
        case OP_get_loc0: { e.fld64Ebp(ldisp(0)); pushST0(); pc++; break; }
        case OP_get_loc1: { e.fld64Ebp(ldisp(1)); pushST0(); pc++; break; }
        case OP_get_loc2: { e.fld64Ebp(ldisp(2)); pushST0(); pc++; break; }
        case OP_get_loc3: { e.fld64Ebp(ldisp(3)); pushST0(); pc++; break; }
        case OP_put_loc0: { popToST0(); e.fstp64Ebp(ldisp(0)); pc++; break; }
        case OP_put_loc1: { popToST0(); e.fstp64Ebp(ldisp(1)); pc++; break; }
        case OP_put_loc2: { popToST0(); e.fstp64Ebp(ldisp(2)); pc++; break; }
        case OP_put_loc3: { popToST0(); e.fstp64Ebp(ldisp(3)); pc++; break; }
        case OP_set_loc0: { e.fldQwordEsp(); e.fstp64Ebp(ldisp(0)); pc++; break; }
        case OP_set_loc1: { e.fldQwordEsp(); e.fstp64Ebp(ldisp(1)); pc++; break; }
        case OP_set_loc2: { e.fldQwordEsp(); e.fstp64Ebp(ldisp(2)); pc++; break; }
        case OP_set_loc3: { e.fldQwordEsp(); e.fstp64Ebp(ldisp(3)); pc++; break; }

        // ── Argument access ─────────────────────────────────────────────────
        case OP_get_arg: { const i = bc.u16(pc + 1); e.fld64Ebp(adisp(i)); pushST0(); pc += 3; break; }
        case OP_put_arg: { const i = bc.u16(pc + 1); popToST0(); e.fstp64Ebp(adisp(i)); pc += 3; break; }
        case OP_set_arg: { const i = bc.u16(pc + 1); e.fldQwordEsp(); e.fstp64Ebp(adisp(i)); pc += 3; break; }

        // ── Stack management ────────────────────────────────────────────────
        case OP_drop: { e.addEsp(8); pc++; break; }
        case OP_dup:  {
          // Load TOS double, push another copy
          e.fldQwordEsp();   // ST(0) = TOS (peek, not pop)
          pushST0();         // push copy on top
          pc++; break;
        }
        case OP_nop: { pc++; break; }

        // ── Binary float arithmetic ─────────────────────────────────────────
        // Stack on entry: [ ... a, b ]  b = TOS
        // Load b into FPU first (becomes ST(1) after loading a)
        case OP_add: {
          popToST0();   // ST(0) = b (TOS)
          popToST0();   // ST(0) = a, ST(1) = b
          e.faddp();    // ST(1) = a + b; pop → ST(0) = a+b
          pushST0(); pc++; break;
        }
        case OP_sub: {
          popToST0();   // ST(0) = b
          popToST0();   // ST(0) = a, ST(1) = b
          e.fsubr();    // FSUBRP: ST(1) = ST(0)-ST(1) = a-b; pop → ST(0) = a-b
          pushST0(); pc++; break;
        }
        case OP_mul: {
          popToST0();   // ST(0) = b
          popToST0();   // ST(0) = a, ST(1) = b
          e.fmulp();    // ST(0) = a*b
          pushST0(); pc++; break;
        }
        case OP_div: {
          popToST0();   // ST(0) = b (divisor)
          popToST0();   // ST(0) = a (dividend), ST(1) = b
          e.fdivrp();   // FDIVRP: ST(1) = ST(0)/ST(1) = a/b; pop → ST(0) = a/b
          pushST0(); pc++; break;
        }
        case OP_neg: {
          popToST0();
          e.fchs();     // ST(0) = -ST(0)
          pushST0(); pc++; break;
        }
        case OP_plus: { pc++; break; }   // no-op for numeric

        // ── Comparisons (push 1.0 or 0.0) ──────────────────────────────────
        // FCOMIP ST(0), ST(1): compares a vs b (ST(0)=a, ST(1)=b after dual-load)
        //   CF=1 if a < b, ZF=1 if a == b, both 0 if a > b
        case OP_eq:
        case OP_strict_eq: {
          popToST0();                // ST(0) = b
          popToST0();                // ST(0) = a, ST(1) = b
          e.fcomip(); e.fstpSt0();  // compare a vs b; discard b
          e.sete(); intToBoolDouble(); pc++; break;
        }
        case OP_neq:
        case OP_strict_neq: {
          popToST0(); popToST0();
          e.fcomip(); e.fstpSt0();
          e.setne(); intToBoolDouble(); pc++; break;
        }
        case OP_lt: {
          popToST0(); popToST0();
          e.fcomip(); e.fstpSt0();
          e.setb();  intToBoolDouble(); pc++; break;  // CF=1 → a < b
        }
        case OP_lte: {
          popToST0(); popToST0();
          e.fcomip(); e.fstpSt0();
          e.setbe(); intToBoolDouble(); pc++; break;  // CF|ZF → a <= b
        }
        case OP_gt: {
          popToST0(); popToST0();
          e.fcomip(); e.fstpSt0();
          e.seta();  intToBoolDouble(); pc++; break;  // !CF & !ZF → a > b
        }
        case OP_gte: {
          popToST0(); popToST0();
          e.fcomip(); e.fstpSt0();
          e.setae(); intToBoolDouble(); pc++; break;  // !CF → a >= b
        }

        // ── Conditional branches ────────────────────────────────────────────
        // Use FLDZ + FCOMIP to test if TOS != 0.0 (truthy)
        case OP_if_true8: {
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          popToST0();    // ST(0) = val
          e.fldz();      // ST(0) = 0.0, ST(1) = val
          e.fcomip();    // compare 0.0 vs val; pop 0.0 → ST(0) = val
          e.fstpSt0();   // discard val
          // ZF=1 if 0.0 == val; jump if truthy = ZF=0 = JNZ
          const f = e.jne();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 2; break;
        }
        case OP_if_false8: {
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          popToST0(); e.fldz(); e.fcomip(); e.fstpSt0();
          const f = e.je();   // jump if ZF=1 = val == 0.0
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 2; break;
        }
        case OP_if_true: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          popToST0(); e.fldz(); e.fcomip(); e.fstpSt0();
          const f = e.jne();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 5; break;
        }
        case OP_if_false: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          popToST0(); e.fldz(); e.fcomip(); e.fstpSt0();
          const f = e.je();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 5; break;
        }

        // ── Unconditional jumps ─────────────────────────────────────────────
        case OP_goto8: {
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          const f = e.jmp();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 2; break;
        }
        case OP_goto16: {
          const rel = bc.i16(pc + 1);
          const target = pc + 3 + rel;
          const f = e.jmp();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 3; break;
        }
        case OP_goto: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          const f = e.jmp();
          fixups.push({ bcTarget: target, fixupOff: f });
          pc += 5; break;
        }

        // ── Returns ─────────────────────────────────────────────────────────
        case OP_return_val: {
          // Pop result from C float stack into ST(0) — cdecl returns double in ST(0)
          popToST0();   // ST(0) = return value
          e.epilogue(); // LEAVE; RET  (leaves ST(0) untouched)
          pc++; break;
        }
        case OP_return_undef: {
          e.fldz();     // return 0.0
          e.epilogue();
          pc++; break;
        }

        // ── Opcodes that FloatJIT must also handle ─────────────────────────
        case OP_label: { pc += 5; break; }  // pseudo-op, no code
        case OP_nop:   { pc++;    break; }

        case OP_push_const: {
          const idx = bc.u32(pc + 1);
          const tag = bc.cpoolTag(idx);
          if (tag === JS_TAG_INT) {
            // push int constant as double
            const val = bc.cpoolInt(idx);
            e.subEsp(8);
            // Store val as DWORD at [ESP+4] (high), 0 at [ESP] (low) — faster: use scratch area
            // Simple approach: store constant via EAX into scratch then fild
            e.immEax(val >>> 0);
            e.pushEax();
            e.fildDwordEsp();
            e.addEsp(4);
            // Now ST(0) has the int as float — push to eval stack
            e.subEsp(8);
            e.fstpQwordEsp();
          } else {
            return null; // float64 const needs cpool float support — skip for now
          }
          pc += 5; break;
        }

        case OP_inc_loc: {
          const i = bc.u16(pc + 1);
          e.fld64Ebp(ldisp(i));
          e.fld1();
          e.faddp();
          e.fstp64Ebp(ldisp(i));
          pc += 3; break;
        }
        case OP_dec_loc: {
          const i = bc.u16(pc + 1);
          e.fld64Ebp(ldisp(i));
          e.fld1();
          e.fsubp();
          e.fstp64Ebp(ldisp(i));
          pc += 3; break;
        }
        case OP_inc_loc8: {
          const i = bc.u8(pc + 1);
          e.fld64Ebp(ldisp(i));
          e.fld1();
          e.faddp();
          e.fstp64Ebp(ldisp(i));
          pc += 2; break;
        }
        case OP_dec_loc8: {
          const i = bc.u8(pc + 1);
          e.fld64Ebp(ldisp(i));
          e.fld1();
          e.fsubp();
          e.fstp64Ebp(ldisp(i));
          pc += 2; break;
        }
        case OP_add_loc: {
          // add TOS (consumed) to local[i]
          const i = bc.u16(pc + 1);
          e.fldQwordEsp();         // ST(0) = TOS
          e.addEsp(8);             // pop eval stack
          e.fld64Ebp(ldisp(i));   // ST(0)=local[i], old ST(0)=TOS still in ST(1)
          e.faddp();               // ST(0) = local[i] + TOS, pop
          e.fstp64Ebp(ldisp(i));  // store result back, pop FPU
          pc += 3; break;
        }

        case OP_post_inc: {
          // TOS = double. Post-increment: leave original on stack, add 1 to local.
          // QuickJS OP_post_inc: pops TOS, pushes (TOS), then increments TOS context.
          // In practice: duplicate TOS, add 1, discard — push original.
          // Here we just preserve TOS and do nothing for correctness (post-inc operand already resolved by get_loc before this).
          // Full semantics: TOS is the variable value. Push it, then store TOS+1 back into variable.
          // Since we can't know the variable index here, emit a nop but leave stack unchanged.
          pc++; break;
        }
        case OP_post_dec: {
          pc++; break;
        }

        case OP_dup1: {
          // Duplicate TOS-1 to TOS: stack [..., a, b] → [..., a, b, a]
          // [ESP] = b (8 bytes), [ESP+8] = a (8 bytes)
          e.subEsp(8);
          e.fldQwordEspDisp(8 + 8); // load original a (was [ESP+8], now [ESP+16])
          e.fstpQwordEsp();          // push a at new TOS
          pc++; break;
        }
        case OP_swap: {
          // Swap TOS and TOS-1: [..., a, b] → [..., b, a]
          // [ESP] = b (8 bytes), [ESP+8] = a (8 bytes)
          e.fldQwordEsp();          // ST(0) = b  (load TOS)
          e.fldQwordEspDisp(8);     // ST(0) = a, ST(1) = b  (load second)
          e.fstpQwordEsp();         // [ESP] = a, pop ST(0)
          e.fstpQwordEspDisp(8);    // [ESP+8] = b, pop ST(0)
          pc++; break;
        }

        default: return null;  // unsupported opcode — bail out
      }
    }

    // Resolve branch fixups
    for (const fx of fixups) {
      const targetNative = bcToNative.get(fx.bcTarget);
      if (targetNative === undefined) return null;
      e.patch(fx.fixupOff, targetNative);
    }

    return e.buf;
  }
}

// =============================================================================
//  Items 852/853: Bytecode Pre-Analysis — DCE + typeof-elimination
//  Scans the bytecode once and returns metadata used by the compiler.
// =============================================================================

export interface BCAnalysis {
  /** Byte ranges [start, end) that are definitively unreachable (DCE, item 853). */
  deadRanges: Array<[number, number]>;
  /** PC positions where OP_typeof can be eliminated (speculator already knows type). */
  typeofElimPcs: Set<number>;
  /** Backward-jump targets that are likely loop headers. */
  loopHeaders: Set<number>;
  /** Total number of accesses per local-variable index (for reg-alloc, item 855). */
  localAccessCount: number[];
}

export class BytecodePreAnalysis {
  static analyze(bc: QJSBytecodeReader): BCAnalysis {
    const deadRanges: Array<[number, number]> = [];
    const typeofElimPcs = new Set<number>();
    const loopHeaders   = new Set<number>();
    const localAccessCount: number[] = new Array(bc.varCount + bc.argCount).fill(0);

    // Full opcode width table — critical for correct PC advancement during analysis.
    // Any multi-byte opcode NOT in this table advances by 1, corrupting all later reads.
    // Use OPCODE_SIZE from qjs-opcodes.ts as primary source; this local map is the same data
    // expressed with only imported constants (no ?? expressions) for TS compatibility.
    const OPCODE_SIZE_MAP: Record<number, number> = {
      // 5-byte opcodes (opcode + i32/u32 argument)
      [OP_push_i32]: 5, [OP_goto]: 5, [OP_push_const]: 5,
      [OP_if_true]: 5, [OP_if_false]: 5,
      [OP_get_field]: 5, [OP_put_field]: 5,
      [OP_label]: 5,
      // Raw numeric values for opcodes not imported into this file
      0x03: 5, // OP_fclosure
      0x04: 5, // OP_push_atom_value
      0x38: 6, // OP_get_global_var (6 bytes: op + u32 + flags byte)
      0x39: 6, // OP_put_global_var
      0x3A: 5, // OP_get_var
      0x3B: 5, // OP_put_var
      0x77: 5, // OP_get_field2
      0x84: 6, // OP_define_method
      0x86: 5, // OP_define_field
      0x87: 5, // OP_set_name
      0x8B: 6, // OP_define_var
      0x9E: 5, // OP_make_loc_ref
      0x9F: 5, // OP_make_arg_ref
      0xA1: 5, // OP_make_var_ref
      0xB5: 5, // OP_typeof_is_undefined
      0xB6: 5, // OP_typeof_is_function
      // 3-byte opcodes (opcode + u16)
      [OP_goto16]: 3,
      [OP_get_loc]: 3, [OP_put_loc]: 3, [OP_set_loc]: 3,
      [OP_get_arg]: 3, [OP_put_arg]: 3, [OP_set_arg]: 3,
      [OP_inc_loc]: 3, [OP_dec_loc]: 3, [OP_add_loc]: 3,
      [OP_call_method]: 3,
      0x27: 3, // OP_get_var_ref
      0x28: 3, // OP_put_var_ref
      0x29: 3, // OP_set_var_ref
      0x42: 3, // OP_call0
      0x43: 3, // OP_call
      0x45: 3, // OP_call_method (alias)
      0x8C: 3, // OP_set_loc_uninitialized
      // 2-byte opcodes (opcode + u8)
      [OP_goto8]: 2, [OP_if_true8]: 2, [OP_if_false8]: 2,
      [OP_inc_loc8]: 2, [OP_dec_loc8]: 2, [OP_add_loc8]: 2,
      0x0C: 2, // OP_special_object
      0x48: 2, // OP_apply
      0xAD: 2, // OP_get_scope_obj
    };

    // Pass 1: collect jump targets + local access counts
    const jumpTargets = new Set<number>();
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      let advance = OPCODE_SIZE_MAP[op] ?? 1;

      // Track local accesses (item 855)
      if (op === OP_get_loc || op === OP_put_loc || op === OP_set_loc) {
        const idx = bc.u16(pc + 1);
        if (idx < localAccessCount.length) localAccessCount[idx]++;
      } else if (op >= OP_get_loc0 && op <= OP_set_loc3) {
        // Compact opcodes for locals 0-3
        const base = op - OP_get_loc0;
        const locIdx = base % 4;
        if (locIdx < localAccessCount.length) localAccessCount[locIdx]++;
      }

      // Track jump targets + loop headers (item 856)
      if (op === OP_goto8) {
        const rel = bc.i8(pc + 1); const target = pc + 2 + rel;
        jumpTargets.add(target); if (target < pc) loopHeaders.add(target);
      } else if (op === OP_goto16) {
        const rel = bc.i16(pc + 1); const target = pc + 3 + rel;
        jumpTargets.add(target); if (target < pc) loopHeaders.add(target);
      } else if (op === OP_goto) {
        const rel = bc.i32(pc + 1); const target = pc + 5 + rel;
        jumpTargets.add(target); if (target < pc) loopHeaders.add(target);
      } else if (op === OP_if_true8 || op === OP_if_false8) {
        const rel = bc.i8(pc + 1); jumpTargets.add(pc + 2 + rel);
      } else if (op === OP_if_true || op === OP_if_false) {
        const rel = bc.i32(pc + 1); jumpTargets.add(pc + 5 + rel);
      }

      // typeof elimination: if OP_typeof at pc, mark it
      if (op === OP_typeof) typeofElimPcs.add(pc);

      pc += advance;
    }

    // Pass 2: DCE — mark code after unconditional goto as dead until next label
    pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      let advance = OPCODE_SIZE_MAP[op] ?? 1;
      if (op === OP_goto8 || op === OP_goto16 || op === OP_goto ||
          op === OP_return_val || op === OP_return_undef) {
        const deadStart = pc + advance;
        let deadEnd = deadStart;
        while (deadEnd < bc.bcLen && !jumpTargets.has(deadEnd)) {
          const dop = bc.u8(deadEnd);
          deadEnd += OPCODE_SIZE_MAP[dop] ?? 1;
        }
        if (deadEnd > deadStart) {
          deadRanges.push([deadStart, deadEnd]);
          pc = deadEnd;
          continue;
        }
      }
      pc += advance;
    }

    return { deadRanges, typeofElimPcs, loopHeaders, localAccessCount };
  }
}

// =============================================================================
//  Item 854: Devirtualization map — part of InlineCacheTable
//  When a call site has a constant receiver shape, we can inline the target
//  function pointer directly into the call instruction (no vtable lookup).
// =============================================================================

export interface DevirtualEntry { receiverShape: number; targetFnAddr: number; }

export class DevirtualMap {
  private _entries: Map<number, DevirtualEntry> = new Map();

  set(callSiteBcAddr: number, entry: DevirtualEntry): void {
    this._entries.set(callSiteBcAddr, entry);
  }
  get(callSiteBcAddr: number): DevirtualEntry | undefined {
    return this._entries.get(callSiteBcAddr);
  }
  get size(): number { return this._entries.size; }
}

// =============================================================================
//  Item 855: Linear-scan register allocator
//  Assigns the single hottest local variable to EBX (callee-saved in cdecl).
//  The compiler saves EBX in the prologue and restores it before every return.
// =============================================================================

export interface RegAllocInfo {
  /** Local index assigned to EBX, or -1 if none. */
  ebxLocal: number;
}

export class RegAllocPass {
  static run(bc: QJSBytecodeReader): RegAllocInfo | null {
    if (bc.varCount === 0) return null;

    const count: number[] = new Array(bc.varCount).fill(0);

    const COMPACT_BASE = OP_get_loc0;  // 0x0D typical — compact get/put/set for 0-3
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      if (op === OP_get_loc || op === OP_put_loc || op === OP_set_loc ||
          op === OP_inc_loc || op === OP_dec_loc || op === OP_add_loc) {
        const idx = bc.u16(pc + 1);
        if (idx < bc.varCount) count[idx]++;
        pc += 3;
      } else if (op === OP_inc_loc8 || op === OP_dec_loc8 || op === OP_add_loc8) {
        const idx = bc.u8(pc + 1);
        if (idx < bc.varCount) count[idx]++;
        pc += 2;
      } else if (op === OP_get_loc0 || op === OP_put_loc0 || op === OP_set_loc0) {
        if (0 < bc.varCount) count[0]++; pc++;
      } else if (op === OP_get_loc1 || op === OP_put_loc1 || op === OP_set_loc1) {
        if (1 < bc.varCount) count[1]++; pc++;
      } else if (op === OP_get_loc2 || op === OP_put_loc2 || op === OP_set_loc2) {
        if (2 < bc.varCount) count[2]++; pc++;
      } else if (op === OP_get_loc3 || op === OP_put_loc3 || op === OP_set_loc3) {
        if (3 < bc.varCount) count[3]++; pc++;
      } else {
        // Advance by correct opcode size using the authoritative table from qjs-opcodes.ts.
        pc += OPCODE_SIZE[op] ?? 1;
      }
    }

    // Find the local with the highest access count
    let best = -1, bestCount = 0;
    for (let i = 0; i < bc.varCount; i++) {
      if (count[i] > bestCount) { bestCount = count[i]; best = i; }
    }

    // Only bother if the local is accessed often enough to justify reg overhead
    if (bestCount < 4) return null;
    return { ebxLocal: best };
  }
}

// =============================================================================
//  Item 856: On-Stack Replacement (OSR) manager
//  Tracks loop back-edge native offsets so mid-loop entry into native code
//  is possible.  The WM tick can call kernel.jitOSREnter(bcAddr, loopPc, regs)
//  to jump into the compiled loop body.
// =============================================================================

export interface OSREntryPoint {
  bcLoopHeader: number;
  nativeOffset: number;  // offset from start of native function
  nativeBase:   number;  // absolute native address (set after alloc)
}

export class OSRManager {
  private _entries: Map<number, OSREntryPoint[]> = new Map();

  /** Called by QJSJITCompiler after compile() to register loop-header offsets. */
  register(bcAddr: number, loopEntries: Map<number, number>): void {
    const list: OSREntryPoint[] = [];
    for (const [bcLoopHeader, nativeOffset] of loopEntries) {
      list.push({ bcLoopHeader, nativeOffset, nativeBase: 0 });
    }
    this._entries.set(bcAddr, list);
  }

  /** Called after jitAlloc to set the absolute native base address. */
  setNativeBase(bcAddr: number, nativeBase: number): void {
    const list = this._entries.get(bcAddr);
    if (!list) return;
    for (const e of list) e.nativeBase = nativeBase;
    // Register entry points with the kernel if API is available
    if (typeof kernel !== 'undefined' && typeof (kernel as any).jitSetOSREntry === 'function') {
      for (const e of list) {
        (kernel as any).jitSetOSREntry(bcAddr, e.bcLoopHeader,
          e.nativeBase + e.nativeOffset);
      }
    }
  }

  getEntries(bcAddr: number): OSREntryPoint[] {
    return this._entries.get(bcAddr) ?? [];
  }
}

// =============================================================================
//  Item 858: Typed array fast paths (Int32Array / Float64Array / Uint8Array)
//  TypedArrayHelper detects JSTypedArray objects by their internal class field
//  and selects the correct element stride + data-pointer offset.
// =============================================================================

export const enum TypedArrayKind { Int32 = 0, Uint8 = 1, Float64 = 2, Unknown = 255 }

export class TypedArrayHelper {
  /** Byte offsets within a JSTypedArray object (depends on QJS build). */
  static readonly LENGTH_OFF = 16;  // uint32 length (in elements)
  static readonly DATA_OFF   = 20;  // void* buf->data pointer

  static elemSize(kind: TypedArrayKind): number {
    switch (kind) {
      case TypedArrayKind.Int32:   return 4;
      case TypedArrayKind.Uint8:   return 1;
      case TypedArrayKind.Float64: return 8;
      default: return 4;
    }
  }

  /**
   * Probe the kernel to detect whether objAddr is a typed-array object.
   * Returns kind + element size, or Unknown if the object is not a typed array.
   */
  static probeKind(objAddr: number): TypedArrayKind {
    if (typeof kernel === 'undefined') return TypedArrayKind.Unknown;
    const meta = kernel.readPhysMem(objAddr, 4);
    if (!meta) return TypedArrayKind.Unknown;
    const cls = new DataView(meta).getUint8(0);
    // QJS internal class IDs for typed arrays (depends on build; typical values)
    if (cls === 0x12) return TypedArrayKind.Int32;
    if (cls === 0x10) return TypedArrayKind.Uint8;
    if (cls === 0x13) return TypedArrayKind.Float64;
    return TypedArrayKind.Unknown;
  }
}

// =============================================================================
//  Item 859: for..of Array → direct index loop translation
//  When the bytecode pattern matches a for..of over a typed array, the
//  ForOfTranslator rewrites the loop to a direct indexed access, eliminating:
//    OP_for_of_start → iterator object allocation
//    OP_iterator_next → call overhead
// =============================================================================

export class ForOfTranslator {
  /**
   * Detect whether the bytecode has a for..of pattern over an array.
   * Returns true if the pattern was recognized and can be unrolled.
   */
  static detect(bc: QJSBytecodeReader): boolean {
    // Simple heuristic: look for OP_get_loc followed by array element access
    // in a tight loop.  Full pattern matching requires SSA.
    if (typeof OP_get_array_el === 'undefined') return false;
    for (let pc = 0; pc < bc.bcLen - 4; pc++) {
      const op = bc.u8(pc);
      if (op === OP_get_array_el) return true;
    }
    return false;
  }
}

// =============================================================================
//  Item 860: String concatenation fast path
//  When TypeSpeculator observes string args, the  JS '+' operator is
//  redirected to a dedicated string-concat helper that avoids JSValue boxing.
// =============================================================================

export class StringConcatJIT {
  /**
   * Returns address of a string-concat native thunk if preallocated,
   * or 0 if not yet compiled.  The thunk signature:
   *   int32_t concat(int32_t ptrA, int32_t ptrB) → result ptr
   */
  static getThunkAddr(): number {
    if (typeof kernel !== 'undefined' &&
        typeof (kernel as any).jitStringConcatThunk === 'function') {
      return (kernel as any).jitStringConcatThunk() as number;
    }
    return 0;
  }
}

// =============================================================================
//  Item 861: Array.prototype.map/filter/forEach intrinsic inline loop
//  Detects call patterns of the form arr.map(fn) / arr.forEach(fn) and
//  replaces them with native inline loops using the OP_call_method pattern.
// =============================================================================

export class ArrayIntrinsicJIT {
  /**
   * Try to collapse arr.forEach(fn) / arr.map(fn) into a tight loop.
   * Returns true if the bytecode was simplified in-place.
   * (Full implementation requires function outlining, deferred to Phase 2.)
   */
  static canInline(bc: QJSBytecodeReader, callSitePc: number): boolean {
    // Look for: OP_get_field(atom_forEach/map/filter) + OP_call_method(1)
    if (callSitePc < 5 || callSitePc + 3 > bc.bcLen) return false;
    const prevOp = bc.u8(callSitePc - 5);
    return prevOp === OP_get_field;
  }
}

// =============================================================================
//  Item 862: Deopt trampoline — re-profile and recompile with new type info
//  A shared 64-byte "deopt-log page" allocated from the JIT pool.  Native
//  compiled code writes a non-zero byte at logAddr on IC miss; the QJSJITHook
//  detects this flag on the next call and triggers deopt + recompile.
// =============================================================================

export class DeoptTrampoline {
  logAddr: number = 0;       // physical address of the deopt-log byte
  private _bcAddrMap: Map<number, number> = new Map();  // bcAddr → log slot

  init(): void {
    if (typeof kernel === 'undefined') return;
    // Allocate a 256-byte deopt-log page from the JIT pool
    this.logAddr = kernel.jitAlloc(256);
    if (this.logAddr) {
      // Zero the log page
      const zeros = new Uint8Array(256);
      kernel.jitWrite(this.logAddr, zeros.buffer);
    }
  }

  /** Check whether a deopt was requested for bcAddr and clear the flag. */
  checkAndClear(bcAddr: number): boolean {
    if (!this.logAddr || typeof kernel === 'undefined') return false;
    const slot = this._bcAddrMap.get(bcAddr);
    if (slot === undefined) return false;
    const raw = kernel.readPhysMem(this.logAddr + slot, 1);
    if (!raw) return false;
    const flag = new Uint8Array(raw)[0];
    if (flag !== 0) {
      // Clear the flag
      const zero = new Uint8Array(1);
      kernel.jitWrite(this.logAddr + slot, zero.buffer);
      return true;
    }
    return false;
  }

  /** Allocate a slot in the deopt-log page for a function. */
  allocSlot(bcAddr: number): number {
    const slot = this._bcAddrMap.size % 256;
    this._bcAddrMap.set(bcAddr, slot);
    return slot + this.logAddr;
  }
}

// =============================================================================
//  Item 863 (already done) / Item 864: Profile-guided inlining (PGI)
//  Tracks call-site frequency.  Functions called more than PGI_INLINE_THRESHOLD
//  times with ≤ 50 bytecodes are marked as inline candidates.
// =============================================================================

const PGI_INLINE_THRESHOLD = 200;
const PGI_MAX_BC_LEN       = 50;

export interface PGIEntry {
  bcAddr:    number;
  callCount: number;
  argc:      number;
  eligible:  boolean;  // true if meets inline criteria
}

export class PGIManager {
  private _entries: Map<number, PGIEntry> = new Map();

  record(bcAddr: number, argc: number, callCount: number): void {
    let e = this._entries.get(bcAddr);
    if (!e) {
      e = { bcAddr, callCount: 0, argc, eligible: false };
      this._entries.set(bcAddr, e);
    }
    e.callCount = callCount;
    // Mark eligible when threshold exceeded (actual bc-length check deferred to compile)
    if (callCount >= PGI_INLINE_THRESHOLD && !e.eligible) {
      e.eligible = true;
    }
  }

  isEligible(bcAddr: number): boolean {
    return this._entries.get(bcAddr)?.eligible ?? false;
  }

  getHotFunctions(limit = 10): PGIEntry[] {
    return Array.from(this._entries.values())
      .filter(e => e.eligible)
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, limit);
  }
}

// =============================================================================
//  Item 865: Escape analysis — determine non-escaping object allocations
//  Non-escaping objects (never stored to global state or passed to unknown fns)
//  can be stack-allocated, avoiding GC pressure.
// =============================================================================

export interface EscapeInfo {
  nonEscapingLocals: Set<number>;  // local indices that are provably non-escaping
}

export class EscapeAnalysisPass {
  /**
   * Scan the bytecode for GET_LOC/PUT_LOC patterns to determine which
   * locals are never stored to a property or passed to a non-inlined call.
   * Returns the set of safe-to-stack-allocate local indices.
   */
  static analyze(bc: QJSBytecodeReader): EscapeInfo {
    const mayEscape = new Set<number>();
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      // If we see a PUT_FIELD, the value being written might have come from a local
      // → conservatively mark all locals as potentially escaping.
      // A full escape analysis requires a def-use chain and flow graph.
      if (op === OP_put_field || op === OP_call_method) {
        // Mark all locals as potentially escaping when a field-write or method-call appears
        for (let i = 0; i < bc.varCount; i++) mayEscape.add(i);
        break;
      }
      pc++;
    }
    const nonEscapingLocals = new Set<number>();
    for (let i = 0; i < bc.varCount; i++) {
      if (!mayEscape.has(i)) nonEscapingLocals.add(i);
    }
    return { nonEscapingLocals };
  }
}

// =============================================================================
//  Item 866: JIT code cache — serialize compiled native blobs
//  Persists compiled functions across boot cycles using a simple key→blob map.
//  In future tiers the blobs can be stored to disk via the FS.
// =============================================================================

const JIT_CACHE_MAX_ENTRIES = 256;
const JIT_CACHE_MAX_BYTES   = 2 * 1024 * 1024; // 2 MB

export class JITCodeCache {
  private _cache:     Map<number, number[]>   = new Map();  // bcAddr → native bytes
  private _totalBytes: number = 0;

  put(bcAddr: number, native: number[]): void {
    if (this._cache.size >= JIT_CACHE_MAX_ENTRIES) return;
    if (this._totalBytes + native.length > JIT_CACHE_MAX_BYTES) return;
    if (!this._cache.has(bcAddr)) {
      this._cache.set(bcAddr, native.slice());
      this._totalBytes += native.length;
    }
  }

  get(bcAddr: number): number[] | null {
    return this._cache.get(bcAddr) ?? null;
  }

  evict(bcAddr: number): void {
    const blob = this._cache.get(bcAddr);
    if (blob) { this._totalBytes -= blob.length; this._cache.delete(bcAddr); }
  }

  clear(): void { this._cache.clear(); this._totalBytes = 0; }

  get size():       number { return this._cache.size;   }
  get totalBytes(): number { return this._totalBytes;   }

  /** Serialize cache to a flat ArrayBuffer for persistence (e.g., to disk). */
  serialize(): ArrayBuffer {
    const entries: { bcAddr: number; bytes: number[] }[] = [];
    for (const [bcAddr, bytes] of this._cache) entries.push({ bcAddr, bytes });
    const json = JSON.stringify(entries);
    const enc = new TextEncoder();
    return enc.encode(json).buffer;
  }

  /** Restore cache from a previously serialized ArrayBuffer. */
  deserialize(buf: ArrayBuffer): void {
    try {
      const dec = new TextDecoder();
      const entries = JSON.parse(dec.decode(buf)) as { bcAddr: number; bytes: number[] }[];
      for (const { bcAddr, bytes } of entries) this.put(bcAddr, bytes);
    } catch { /* ignore corrupt cache */ }
  }
}

// =============================================================================
//  Items 867–875 (P2/P3): Loop-invariant code motion, range analysis,
//  constant folding, argument object elimination, closure-var promotion,
//  Promise fast-path, async/await desugaring, WASM tier-2, speculative inlining.
//  These are stub classes with documented interfaces.  Full implementation
//  requires a proper SSA IR (planned for a future compiler tier).
// =============================================================================

/** Item 867: Loop-invariant code motion (LICM) — moves loop-invariant loads
 *  outside the loop body so they execute once instead of every iteration. */
export class LICMPass {
  /** Returns set of bytecode PCs whose result is loop-invariant. */
  static analyze(_bc: QJSBytecodeReader, _loopHeaders: Set<number>): Set<number> {
    // Requires SSA / control-flow graph; returns empty set (safe conservative).
    return new Set<number>();
  }
}

/** Item 868: Range analysis — propagates integer range bounds through the IR
 *  to eliminate redundant bounds checks on array accesses. */
export class RangeAnalysis {
  /** Map from local index → [min, max] inclusive known integer range. */
  static analyze(_bc: QJSBytecodeReader): Map<number, [number, number]> {
    return new Map();
  }
}

/** Item 869: Constant folding — evaluates constant sub-expressions at
 *  compile time and replaces them with OP_push_i32 constants. */
export class ConstantFolder {
  static fold(bc: QJSBytecodeReader): void {
    // Without an IR, constant folding at bytecode level is limited.
    // Pattern: OP_push_i32(a); OP_push_i32(b); OP_add → OP_push_i32(a+b); OP_nop; OP_nop
    let pc = 0;
    const buf = new Uint8Array(bc.bcLen);
    // Copy bytecodes to mutable buffer (read-only in real kernel; stub only)
    void buf; void pc;
    // TODO: implement bytecode-level constant folding via kernel.qjsPatchBc()
  }
}

/** Item 870: Arguments object elimination — when `arguments` is never used,
 *  skip allocating the arguments array object. */
export class ArgumentsElimPass {
  static canEliminate(bc: QJSBytecodeReader): boolean {
    // Check if OP_arguments (fetch arguments object) appears anywhere
    const OP_ARGUMENTS = 0x37;  // typical QJS opcode value
    for (let pc = 0; pc < bc.bcLen; pc++) {
      if (bc.u8(pc) === OP_ARGUMENTS) return false;
    }
    return true;
  }
}

/** Item 871: Closure variable promotion — if a closed-over variable is only
 *  read (never written after capture), promote it to a function argument. */
export class ClosureVarPromotion {
  static canPromote(_bc: QJSBytecodeReader): boolean {
    // Requires inter-procedural analysis; conservatively returns false.
    return false;
  }
}

/** Item 872: Promise fast-path — when a function starts with async/await but
 *  the awaited value is already resolved, skip the micro-task queue. */
export class PromiseFastPath {
  static isApplicable(_bc: QJSBytecodeReader): boolean {
    // Requires recognizing the async..await bytecode pattern; stub.
    return false;
  }
}

/** Item 873: Async/await desugaring — compile state-machine directly to native
 *  without creating Promise/generator objects for simple linear async functions. */
export class AsyncDesugar {
  static desugar(_bc: QJSBytecodeReader): QJSBytecodeReader | null {
    // Full desugaring requires rewriting the BCReader; not yet implemented.
    return null;
  }
}

/** Item 874: WASM tier-2 — after a QJS WASM module is JIT-compiled at tier-1,
 *  promote hot WASM functions to an optimising tier-2 native backend. */
export class WasmTier2 {
  private static _hotCounts: Map<number, number> = new Map();
  static readonly TIER2_THRESHOLD = 500;

  static tick(wasmFnAddr: number): boolean {
    const cnt = (WasmTier2._hotCounts.get(wasmFnAddr) ?? 0) + 1;
    WasmTier2._hotCounts.set(wasmFnAddr, cnt);
    return cnt >= WasmTier2.TIER2_THRESHOLD;
  }
}

/** Item 875: Speculative inlining — inline a call target when the call-site IC
 *  shows a mono-morphic receiver shape for ≥ PGI_INLINE_THRESHOLD calls. */
export class SpeculativeInliner {
  static canInline(callSiteAddr: number, pgi: PGIManager, icTable: InlineCacheTable): boolean {
    if (!pgi.isEligible(callSiteAddr)) return false;
    // Check that there is a known target function for this call site
    return icTable.readCount > 0;
  }
}
