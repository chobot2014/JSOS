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
  OP_push_i32, OP_push_false, OP_push_true, OP_null, OP_undefined,
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
  OP_drop, OP_dup, OP_dup2, OP_nip, OP_swap,
  OP_if_true8, OP_if_false8, OP_if_true, OP_if_false,
  OP_goto, OP_goto8, OP_goto16,
  OP_return_val, OP_return_undef, OP_nop,
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
export const JIT_THRESHOLD = 100;

/** Maximum allowed deoptimisations before a function is blacklisted. */
export const MAX_DEOPTS = 3;

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
  private readonly _bytes: ArrayBuffer;
  private readonly _view:  DataView;

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
    if (bcLen === 0 || bcLen > MAX_BC_LEN) {
      throw new Error(`QJSBytecodeReader: invalid bcLen ${bcLen}`);
    }
    const bytes = kernel.readPhysMem(bcBufPtr, bcLen);
    if (!bytes) throw new Error('QJSBytecodeReader: cannot read bytecode');
    this._bytes = bytes;
    this._view  = new DataView(bytes);
  }

  u8(offset: number):  number { return this._view.getUint8(offset); }
  i8(offset: number):  number { return this._view.getInt8(offset); }
  u16(offset: number): number { return this._view.getUint16(offset, true); }
  i16(offset: number): number { return this._view.getInt16(offset, true); }
  i32(offset: number): number { return this._view.getInt32(offset, true); }
  u32(offset: number): number { return this._view.getUint32(offset, true); }
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

  constructor(bc: QJSBytecodeReader) {
    this._e    = new _Emit();
    this._bc   = bc;
    this._argN = bc.argCount;
    this._varN = bc.varCount;
  }

  // Returns offset of arg i inside stack frame
  private _argDisp(i: number): number  { return 8 + i * 4; }
  // Returns offset of local i inside stack frame (negative from EBP)
  private _locDisp(i: number): number  { return -(4 + i * 4); }

  /** Compile whole function.  Returns native byte array or null on bail-out. */
  compile(): number[] | null {
    const e = this._e;
    const bc = this._bc;
    const locals = this._argN + this._varN;
    const localBytes = (locals + 8) * 4;  // locals + extra eval-stack space

    e.prologue(localBytes);

    // Zero-fill all local slots
    for (let i = 0; i < this._varN; i++) {
      e.xorEaxEax();
      e.store(this._locDisp(i));
    }

    let pc = 0;
    while (pc < bc.bcLen) {
      this._bcToNative.set(pc, e.here());
      const op = bc.u8(pc);

      if (!JIT_SUPPORTED_OPCODES.has(op)) return null; // bail out

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
        case OP_get_loc: { const i = bc.u16(pc + 1); e.load(this._locDisp(i)); e.pushEax(); pc += 3; break; }
        case OP_put_loc: { const i = bc.u16(pc + 1); e.popEax();               e.store(this._locDisp(i)); pc += 3; break; }
        case OP_set_loc: { const i = bc.u16(pc + 1); e.peekTOS();              e.store(this._locDisp(i)); pc += 3; break; }
        case OP_get_loc0: { e.load(this._locDisp(0)); e.pushEax(); pc++; break; }
        case OP_get_loc1: { e.load(this._locDisp(1)); e.pushEax(); pc++; break; }
        case OP_get_loc2: { e.load(this._locDisp(2)); e.pushEax(); pc++; break; }
        case OP_get_loc3: { e.load(this._locDisp(3)); e.pushEax(); pc++; break; }
        case OP_put_loc0: { e.popEax(); e.store(this._locDisp(0)); pc++; break; }
        case OP_put_loc1: { e.popEax(); e.store(this._locDisp(1)); pc++; break; }
        case OP_put_loc2: { e.popEax(); e.store(this._locDisp(2)); pc++; break; }
        case OP_put_loc3: { e.popEax(); e.store(this._locDisp(3)); pc++; break; }
        case OP_set_loc0: { e.peekTOS(); e.store(this._locDisp(0)); pc++; break; }
        case OP_set_loc1: { e.peekTOS(); e.store(this._locDisp(1)); pc++; break; }
        case OP_set_loc2: { e.peekTOS(); e.store(this._locDisp(2)); pc++; break; }
        case OP_set_loc3: { e.peekTOS(); e.store(this._locDisp(3)); pc++; break; }

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
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_goto16: {
          const rel = bc.i16(pc + 1);
          const target = pc + 3 + rel;
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 3; break;
        }
        case OP_goto: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          const fixOff = e.jmp();
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }
        case OP_if_true8: {
          // Jump to target if TOS is truthy (non-zero).  TEST sets ZF if EAX==0.
          // JNE (ZF=0) fires when EAX ≠ 0 = truthy.  32-bit form avoids expansion overflow.
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          e.popEax(); e.testAA();
          const fixOff = e.jne();  // jne: jump if non-zero (truthy)
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_if_false8: {
          // Jump to target if TOS is falsy (zero).  JE (ZF=1) fires when EAX==0.
          const rel = bc.i8(pc + 1);
          const target = pc + 2 + rel;
          e.popEax(); e.testAA();
          const fixOff = e.je();   // je: jump if zero (falsy)
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 2; break;
        }
        case OP_if_true: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          e.popEax(); e.testAA();
          const fixOff = e.jne(); // jne → EAX non-zero means true → branch
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }
        case OP_if_false: {
          const rel = bc.i32(pc + 1);
          const target = pc + 5 + rel;
          e.popEax(); e.testAA();
          const fixOff = e.je(); // je → EAX zero means false → branch
          this._fixups.push({ bcTarget: target, fixupOff: fixOff, is8: false });
          pc += 5; break;
        }

        // ── Returns ──────────────────────────────────────────────────────
        case OP_return_val: {
          e.popEax();
          e.epilogue();
          pc++; break;
        }
        case OP_return_undef: {
          e.xorEaxEax();
          e.epilogue();
          pc++; break;
        }

        // ── No-op ────────────────────────────────────────────────────────
        case OP_nop: { pc++; break; }

        default: return null; // unsupported — bail out
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

  constructor() {
    this._offsets = initOffsets();
  }

  install(): void {
    kernel.setJITHook((bcAddr: number, spAddr: number, argc: number): number => {
      return this._onHook(bcAddr, spAddr, argc);
    });
  }

  private _onHook(bcAddr: number, spAddr: number, argc: number): number {
    if (!bcAddr) return 0;
    let entry = this._funcs.get(bcAddr);
    if (!entry) {
      entry = {
        bcAddr, nativeAddr: 0, deoptCount: 0, blacklisted: false,
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

    // Only attempt compilation if we have enough calls to speculate types
    if (entry.speculator.callCount < JIT_THRESHOLD) return 0;

    // V1 scope: only compile integer-specialised functions.
    // Bool (0/1) is treated as int32 — same representation in cdecl.
    // Float64 and Any arg types require a future float-specialised tier.
    if (!entry.speculator.allIntegerLike() && argc > 0) {
      // Float64-only functions may stabilise later; give them 4× threshold
      // before permanently giving up.
      if (entry.speculator.callCount >= JIT_THRESHOLD * 4) {
        entry.blacklisted = true;
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

    const compiler = new QJSJITCompiler(bc);
    const native   = compiler.compile();
    if (!native) {
      entry.blacklisted = true;
      this._bailed++;
      return 0;
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
    this._compiled++;
    return 1;
  }

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
  blacklist:  Set<number>;           // bcAddr of bailed functions
}

const _childState = new Map<number, ChildJITState>();

function _ensureChild(procId: number): ChildJITState {
  let s = _childState.get(procId);
  if (!s) {
    s = { offsets: initOffsets(), compiled: new Map(), blacklist: new Set() };
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

  const compiler = new QJSJITCompiler(bc);
  const native   = compiler.compile();
  if (!native) {
    s.blacklist.add(bcAddr);
    return;
  }

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
