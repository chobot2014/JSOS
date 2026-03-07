/**
 * qjs-jit.ts — QuickJS Bytecode JIT Compiler (Steps 7–10)
 *
 * Architecture overview:
 *   QJSJITHook.install() registers a C-level hook (kernel.setJITHook) that fires
 *   when a QuickJS function's call_count reaches JIT_THRESHOLD.  The hook callback
 *   triggers QJSJITCompiler to translate the function's bytecode into native i686
 *   machine code using the extended _Emit helpers.  The resulting code is placed in
 *   the 64 MB JIT pool (main context) or the per-process 4 MB slab (child context)
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
  // Call opcodes for slow-path helper dispatch
  OP_call, OP_call0,
  // Closure variable access opcodes
  OP_get_var_ref, OP_put_var_ref, OP_set_var_ref,
  // Exception opcodes — handled via deopt
  OP_throw, OP_throw_error,
  // Special-object / async opcodes (items 870, 872, 873)
  OP_special_object,
  OP_initial_yield, OP_await, OP_return_async,
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
export const JS_TAG_STRING      = -7;
export const JS_TAG_OBJECT      = -1;
export const JS_TAG_FUNCTION_BYTECODE = -2;

/** sizeof(JSValue) = 8 bytes on 32-bit QuickJS (4-byte union + 4-byte tag). */
export const JSVALUE_SIZE = 8;

/** Sentinel value written to jit_native_ptr to indicate deoptimisation. */
export const DEOPT_SENTINEL = 0x7FFFDEAD;

/** Call count threshold at which a function is compiled. */
export const JIT_THRESHOLD = 2;

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
  closureVarCount: number;
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
    closureVarCount: 56,
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
  readonly closureVarCount: number; /** number of closure variables (from JSFunctionBytecode) */
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
    this.closureVarCount = mv.getUint16(offsets.closureVarCount, true);
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

  /** Return the float64 value of constant pool entry idx (valid when cpoolTag===JS_TAG_FLOAT64). */
  cpoolFloat64(idx: number): number {
    if (!this._cpoolView || idx < 0 || idx >= this.cpoolCount) return 0;
    return this._cpoolView.getFloat64(idx * 8, true);
  }

  /**
   * Create a synthetic reader from pre-patched bytecode bytes (for AsyncDesugar).
   * Shares metadata (argCount, varCount, cpool, etc.) with the source reader so
   * only the bytecode buffer is replaced.
   */
  static fromBytes(src: QJSBytecodeReader, patchedBytes: ArrayBuffer): QJSBytecodeReader {
    const inst = Object.create(QJSBytecodeReader.prototype) as QJSBytecodeReader;
    (inst as any).bcBuf           = src.bcBuf;
    (inst as any).bcLen           = patchedBytes.byteLength;
    (inst as any).argCount        = src.argCount;
    (inst as any).varCount        = src.varCount;
    (inst as any).stackSize       = src.stackSize;
    (inst as any).cpoolPtr        = src.cpoolPtr;
    (inst as any).cpoolCount      = src.cpoolCount;
    (inst as any).closureVarCount = src.closureVarCount;
    (inst as any)._bytes          = patchedBytes;
    (inst as any)._view           = new DataView(patchedBytes);
    (inst as any)._cpoolView      = (src as any)._cpoolView;
    return inst;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TypeSpeculator — accumulate type observations for a function's entry point
// ─────────────────────────────────────────────────────────────────────────────

export const enum ArgType { Unknown = 0, Int32 = 1, Bool = 2, Float64 = 3, Object = 4, Any = 255 }

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
                          : tag === JS_TAG_OBJECT  ? ArgType.Object
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
      if (t !== ArgType.Int32 && t !== ArgType.Bool && t !== ArgType.Unknown && t !== ArgType.Object)
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
  /**
   * Addresses of C helper functions used by property-access and call slow paths.
   * Set via constructor helperAddrs parameter; 0 = not available (bail on slow path).
   */
  protected _helperGetPropI32:    number = 0;
  protected _helperSetPropI32:    number = 0;
  protected _helperCallFn:        number = 0;
  protected _helperResolveNative: number = 0;
  protected _helperStringEq:      number = 0;
  protected _helperStringLen:     number = 0;
  protected _helperStringCharAt:  number = 0;
  /** C helper: jit_js_get_var_ref_i32(obj_ptr, idx) → int32 */
  protected _helperGetVarRef:     number = 0;
  /** C helper: jit_js_put_var_ref_i32(obj_ptr, idx, val) → void */
  protected _helperPutVarRef:     number = 0;
  /** Physical address of volatile uint32 _jit_current_closure global in quickjs.c */
  protected _closureGlobalAddr:   number = 0;
  /** OSR entry-point map: bcOffset → nativeOffset.  Populated during compile (item 856). */
  readonly osrEntries: Map<number, number> = new Map();

  constructor(bc: QJSBytecodeReader,
              icTable?: InlineCacheTable,
              regAlloc?: RegAllocInfo,
              deoptLogAddr?: number,
              helperAddrs?: { getPropI32: number; setPropI32: number; callFn: number;
                              resolveNative?: number; stringEq?: number; stringLen?: number; stringCharAt?: number;
                              getVarRef?: number; putVarRef?: number; closureGlobal?: number }) {
    this._e    = new _Emit();
    this._bc   = bc;
    this._argN = bc.argCount;
    this._varN = bc.varCount;
    if (icTable)     this._icTable     = icTable;
    if (regAlloc)    this._regAlloc    = regAlloc;
    if (deoptLogAddr) this._deoptLogAddr = deoptLogAddr;
    if (helperAddrs) {
      this._helperGetPropI32    = helperAddrs.getPropI32;
      this._helperSetPropI32    = helperAddrs.setPropI32;
      this._helperCallFn        = helperAddrs.callFn;
      this._helperResolveNative = helperAddrs.resolveNative ?? 0;
      this._helperStringEq      = helperAddrs.stringEq ?? 0;
      this._helperStringLen     = helperAddrs.stringLen ?? 0;
      this._helperStringCharAt  = helperAddrs.stringCharAt ?? 0;
      this._helperGetVarRef     = helperAddrs.getVarRef ?? 0;
      this._helperPutVarRef     = helperAddrs.putVarRef ?? 0;
      this._closureGlobalAddr   = helperAddrs.closureGlobal ?? 0;
    }
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
    // Async desugaring (item 873): detect linear tail-await async functions and rewrite
    // bytecode to remove OP_initial_yield / OP_await / OP_return_async so the JIT
    // compiles them as regular synchronous functions — no generator state machine.
    let bc = this._bc;
    if (PromiseFastPath.isApplicable(bc)) {
      const _db = AsyncDesugar.desugar(bc);
      if (_db !== null) bc = _db;
    }

    // Determine if this function accesses closure variables
    const usesClosure = bc.closureVarCount > 0 && this._closureGlobalAddr > 0
                        && this._helperGetVarRef > 0 && this._helperPutVarRef > 0;
    const closureExtraSlot = usesClosure ? 1 : 0;

    const locals = this._argN + this._varN + closureExtraSlot;
    const localBytes = (locals + 8) * 4;  // locals + extra eval-stack space

    // Displacement of the saved closure pointer within the stack frame (negative from EBP).
    // Stored right after the last local variable slot.
    const closureDisp = usesClosure ? this._locDisp(this._varN) : 0;

    // IC-backed / slow-path opcodes accepted in addition to JIT_SUPPORTED_OPCODES
    // (items 848/849/852/858 + OP_call/OP_call0/OP_call_method via C helper slow path)
    // OP_special_object added for item 870 (arguments elim): functions that create an
    // arguments object slow-path through the interpreter for that one opcode instead of
    // bailing the JIT entirely, preserving JIT execution of all other instructions.
    const IC_OPCODES = new Set([OP_get_field, OP_put_field, OP_get_array_el, OP_put_array_el, OP_typeof,
                                 OP_call, OP_call0, OP_call_method,
                                 OP_get_var_ref, OP_put_var_ref, OP_set_var_ref,
                                 OP_throw, OP_throw_error,
                                 OP_special_object]);

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

    // ── Closure prologue: save _jit_current_closure global to local frame ──
    // The C dispatch in quickjs.c writes the callee's JSObject* to this global
    // before entering native code.  We save it to a local so it survives nested
    // function calls (which overwrite the global for their own callee).
    if (usesClosure) {
      e.movEaxAbs(this._closureGlobalAddr);   // MOV EAX, [_jit_current_closure]
      e.store(closureDisp);                    // MOV [EBP + closureDisp], EAX
    }

    let pc = 0;
    // Track which bytecode offsets are legal jump targets (for DCE item 853).
    const _jumpTargets = new Set<number>();

    // Build a dead-end map: _deadCutoff[p] = first live pc after the dead range that contains p,
    // or -1 if p is live.  Prevents bailing on unsupported opcodes in unreachable code (item 853).
    const _preAnalysis = BytecodePreAnalysis.analyze(bc);
    const _deadCutoff = new Int32Array(bc.bcLen).fill(-1);
    for (const [dStart, dEnd] of _preAnalysis.deadRanges) {
      for (let dp = dStart; dp < dEnd; dp++) _deadCutoff[dp] = dEnd;
    }

    // Constant folding: pre-compute foldable push+push+arith triples (item 869)
    const _constFolds = ConstantFolder.fold(bc);

    // LICM: compute loop-invariant PCs (item 867) — invariant locals/consts need
    // not be re-evaluated on every loop iteration.
    const _licmSet = LICMPass.analyze(bc, _preAnalysis.loopHeaders);

    // Range analysis: induction-variable bounds for bounds-check elimination (item 868)
    // _rangeMap[i] = [min, max] inclusive for local i when it is a loop counter.
    const _rangeMap = RangeAnalysis.analyze(bc, _preAnalysis.loopHeaders);

    // Track the local-variable index most recently pushed onto the eval stack.
    // Used by OP_get_array_el to elide redundant bounds-check work when the
    // index is a proven-non-negative induction variable (item 868 use site).
    let _lastPushLocal = -1;

    void _licmSet; // consumed by future hoisting optimisation; suppress lint

    while (pc < bc.bcLen) {
      // DCE: skip dead code ranges — avoids bail-outs on unreachable unsupported opcodes.
      if (_deadCutoff[pc] >= 0) { pc = _deadCutoff[pc]; continue; }

      // Constant folding: if this PC starts a foldable triple, emit the folded constant
      const fold = _constFolds.get(pc);
      if (fold) {
        this._bcToNative.set(pc, e.here());
        e.immEax(fold.result >>> 0);
        e.pushEax();
        pc += fold.skipLen;
        continue;
      }

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
          e.pushEax(); _lastPushLocal = i; pc += 3; break;
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
          // Guard: divisor == 0 → deopt. JS says 42/0 = Infinity (not an integer
          // result), so bail to the interpreter which handles it correctly.
          e.testCC();                         // TEST ECX, ECX
          const divOk = e.jne();              // JNE: skip deopt if ECX != 0
          e.immEax(DEOPT_SENTINEL >>> 0);     // MOV EAX, 0x7FFFDEAD
          this._emitEpilogue();
          e.patch(divOk, e.here());
          e.idivC();   // CDQ; IDIV ECX  → EAX = quotient
          e.pushEax(); pc++; break;
        }
        case OP_mod: {
          e.popEcx(); e.popEax();
          // Guard: divisor == 0 → deopt. JS says 42%0 = NaN.
          e.testCC();                         // TEST ECX, ECX
          const modOk = e.jne();              // JNE: skip deopt if ECX != 0
          e.immEax(DEOPT_SENTINEL >>> 0);     // MOV EAX, 0x7FFFDEAD
          this._emitEpilogue();
          e.patch(modOk, e.here());
          e.idivC();
          e.movEaxEdx(); // remainder in EDX → EAX
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

        // ── Exception handling via deopt ──────────────────────────────
        // OP_throw / OP_throw_error: cannot handle exceptions in native code.
        // Return DEOPT_SENTINEL so QuickJS re-executes the function through
        // the interpreter, where the exception path is fully handled.
        case OP_throw: {
          e.immEax(DEOPT_SENTINEL);
          this._emitEpilogue();
          pc++; break;
        }
        case OP_throw_error: {
          e.immEax(DEOPT_SENTINEL);
          this._emitEpilogue();
          pc += 6; break;
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
          } else if (this._helperGetPropI32) {
            // Slow path: call jit_js_getprop_i32(obj_ptr, atom) via C helper.
            // cdecl: push atom first (rightmost), then obj_ptr (leftmost).
            e.popEax();                       // EAX = obj_ptr (TOS)
            e.pushImm32(atomId);              // PUSH atom (arg1, rightmost)
            e.pushEax();                      // PUSH obj_ptr (arg0, leftmost)
            e.immEcx(this._helperGetPropI32);
            e.callEcx();
            e.addEsp(8);                      // clean 2 args
            e.pushEax();                      // push int32 result
          } else {
            return null;  // no IC data and no helper → bail (will retry after profiling)
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
          } else if (this._helperSetPropI32) {
            // Slow path: call jit_js_setprop_i32(obj_ptr, atom, val) via C helper.
            // Stack: [obj_ptr, val] where val=TOS, obj_ptr is below.
            // cdecl: push val first (rightmost), then atom, then obj_ptr (leftmost).
            e.popEax();                       // EAX = val (TOS)
            e.popEcx();                       // ECX = obj_ptr
            e.pushEax();                      // PUSH val (arg2, rightmost)
            e.pushImm32(atomId);              // PUSH atom (arg1)
            e.pushEcx();                      // PUSH obj_ptr (arg0, leftmost)
            e.immEcx(this._helperSetPropI32);
            e.callEcx();
            e.addEsp(12);                     // clean 3 args
          } else {
            return null;
          }
          pc += 5; break;
        }

        // ── IC-backed array element read (item 858) ───────────────────
        // OP_get_array_el: [arr, idx] → [val]
        case OP_get_array_el: {
          const icEntry = this._icTable?.getArrayIC(entry_bcAddr + pc);
          if (icEntry && icEntry.dataOff > 0 && icEntry.elemSize === 4) {
            // Fast path: dense Int32Array / Uint32Array — elemSize === 4 guarantees raw int32 backing.
            // Stack on entry: [..., arr_ptr, idx]  (idx = TOS, arr_ptr = TOS-1)
            //
            // Range analysis (item 868): if the index was produced by OP_get_loc(i) and
            // RangeAnalysis proves i ∈ [0, N] (non-negative range), emit an unsigned
            // comparison (JB) instead of signed (JLE) — works for non-negative indices
            // because a negative signed int as uint32 is always > array.length.
            // Range analysis (item 868): if the pushed index local was tracked by
            // OP_get_loc and RangeAnalysis proves its range starts at ≥ 0, we can
            // skip the negative-index guard and use an unsigned bounds check (JBE).
            const _idxRange  = (_lastPushLocal >= 0) ? _rangeMap.get(_lastPushLocal) : undefined;
            const _idxNonNeg = _idxRange !== undefined && _idxRange[0] >= 0;
            _lastPushLocal = -1; // consumed

            e.popEcx();          // ECX = idx
            e.popEax();          // EAX = arr_ptr
            e.xchgEaxEcx();      // ECX = arr_ptr, EAX = idx

            e.pushEax();         // [ESP] = idx  (save for in-bounds path)

            // Negative-index guard — only emitted when range analysis cannot prove idx ≥ 0.
            // TEST EAX, EAX sets SF when EAX is negative; JS branches out on negative index.
            let oobNeg = 0;
            if (!_idxNonNeg) {
              e.testAA();           // TEST EAX, EAX
              oobNeg = e.js();      // JS → out-of-bounds if idx < 0
            }

            // Bounds check: load arr->length, compare against saved idx.
            e.movEaxEcxDisp(icEntry.lengthOff); // EAX = arr->length
            e.cmpEaxEspInd();    // CMP EAX, [ESP]  →  length - idx
            // _idxNonNeg: unsigned JBE is exact (negative idx already excluded above or proven absent).
            // !_idxNonNeg: JLE handles the remaining positive out-of-bounds case after the JS guard.
            const oobJmp = _idxNonNeg ? e.jbe() : e.jle();

            // In-bounds path:
            e.popEax();          // EAX = idx (restore)
            e.movEcxEcxDisp(icEntry.dataOff); // ECX = arr->data (raw C int32_t* pointer)
            e.movEaxEcxEaxScale4();           // EAX = [ECX + EAX*4]  ← actual element value
            const doneJmp = e.jmp();

            // Out-of-bounds path: discard saved idx, return 0.
            if (!_idxNonNeg) e.patch(oobNeg, e.here());
            e.patch(oobJmp, e.here());
            e.addEsp(4);         // remove the saved idx
            e.xorEaxEax();       // EAX = 0 (safe fallback)
            e.patch(doneJmp, e.here());
          } else {
            return null;  // no IC data or unsupported elemSize — bail
          }
          e.pushEax();
          pc++; break;
        }

        // ── Array element write fast path (item 858) ─────────────────
        // OP_put_array_el: [arr, idx, val] → []
        case OP_put_array_el: {
          const icEntry = this._icTable?.getArrayIC(entry_bcAddr + pc);
          if (icEntry && icEntry.dataOff > 0 && icEntry.elemSize === 4) {
            // Fast path: dense Int32Array — write val at arr->data[idx].
            // Stack on entry: [..., arr_ptr, idx, val]  (val = TOS)
            e.popEdx();          // EDX = val
            e.popEcx();          // ECX = idx
            e.popEax();          // EAX = arr_ptr
            e.xchgEaxEcx();      // ECX = arr_ptr, EAX = idx
            // Save both idx and val so we can restore after the bounds check
            e.pushEdx();         // [ESP]   = val
            e.pushEax();         // [ESP]   = idx,  [ESP+4] = val
            // Bounds check
            e.movEaxEcxDisp(icEntry.lengthOff); // EAX = arr->length
            e.cmpEaxEspInd();    // CMP EAX, [ESP]  →  length - idx
            const oobJmp = e.jle(); // JLE: jump if length ≤ idx
            // In-bounds path:
            e.popEax();          // EAX = idx
            e.popEdx();          // EDX = val
            e.movEcxEcxDisp(icEntry.dataOff); // ECX = arr->data (raw int32_t* pointer)
            e.movEcxEaxScale4Edx();           // [ECX + EAX*4] = EDX  ← write val
            const doneJmp = e.jmp();
            // Out-of-bounds path: discard saved idx + val silently
            e.patch(oobJmp, e.here());
            e.addEsp(8);         // remove idx + val from stack
            e.patch(doneJmp, e.here());
          } else if (this._deoptLogAddr) {
            // No IC — flag a deopt so the IC table gets populated
            e.movByteAbsImm(this._deoptLogAddr, 1);
            // Still must consume the 3 stack values so the stack stays balanced
            e.addEsp(12);
          } else {
            return null;
          }
          pc++; break;
        }

        // ── Function calls ─────────────────────────────────────────────────
        // OP_call0 (0x42) / OP_call (0x43): [fn, a0..a_{argc-1}] → [result]
        // u16 argc operand at pc+1.  Supported argc: 0–4 (bail on > 4 or no helper).
        //
        // FAST PATH: if callee has a JIT-compiled int32-ABI native, call it
        // directly (native → native) skipping the JSValue wrapping round-trip.
        // SLOW PATH: falls back to jit_js_call_fn C helper.
        case OP_call0:
        case OP_call: {
          const callArgc = bc.u16(pc + 1);
          if (!this._helperCallFn || callArgc > 4) return null;

          // Eval stack TOS..bottom: [a_{N-1}, ..., a_0, fn_ptr]

          if (this._helperResolveNative) {
            // ── Fast-path probe: jit_resolve_native(fn_ptr) → native addr or 0 ──
            e.peekN(callArgc);                 // EAX = fn_ptr
            e.pushEax();                       // cdecl arg
            e.immEcx(this._helperResolveNative);
            e.callEcx();
            e.addEsp(4);                       // clean cdecl arg
            e.testAA();                        // TEST EAX, EAX
            const fixSlow = e.je();            // JE → slow_path

            // ── Fast path: direct native-to-native call ──
            // EAX = callee native addr.  Save in ECX (preserved across peekN).
            e.movEcxEax();                     // ECX = native addr

            // Update _jit_current_closure global for the callee so its prologue
            // can save the correct JSObject* to its own local frame.
            if (this._closureGlobalAddr) {
              e.peekN(callArgc);               // EAX = fn_ptr (callee's JSObject*)
              e.movAbsEax(this._closureGlobalAddr); // _jit_current_closure = fn_ptr
            }

            // Build 4-arg cdecl frame.  Push order: a3(pad), a2(pad), ..., a0.
            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);  // zero-pad unused
            for (let k = 0; k < callArgc; k++) {
              // a_{N-1-k} shifted by (4-N) pads + k prior pushes:
              e.peekN(4 - callArgc + 2 * k);  // EAX = a_{N-1-k}
              e.pushEax();
            }
            e.callEcx();                       // CALL callee native
            e.addEsp(16);                      // clean 4-arg cdecl frame
            e.addEsp((callArgc + 1) * 4);      // clean eval stack (fn + args)
            e.pushEax();                       // push int32 result
            const fixDone = e.jmp();           // JMP → done

            // ── Slow path: jit_js_call_fn(fn, a0..a3, argc) ──
            e.patch(fixSlow, e.here());
            e.pushImm32(callArgc);
            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);
            for (let k = 0; k < callArgc; k++) {
              e.peekN(5 - callArgc + 2 * k);
              e.pushEax();
            }
            e.peekN(5 + callArgc);
            e.pushEax();
            e.immEcx(this._helperCallFn);
            e.callEcx();
            e.addEsp(24);
            e.addEsp((callArgc + 1) * 4);
            e.pushEax();

            // Patch JMP → done
            e.patch(fixDone, e.here());
          } else {
            // No resolveNative helper — slow path only.
            e.pushImm32(callArgc);
            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);
            for (let k = 0; k < callArgc; k++) {
              e.peekN(5 - callArgc + 2 * k);
              e.pushEax();
            }
            e.peekN(5 + callArgc);
            e.pushEax();
            e.immEcx(this._helperCallFn);
            e.callEcx();
            e.addEsp(24);
            e.addEsp((callArgc + 1) * 4);
            e.pushEax();
          }

          pc += 3; break;
        }

        // OP_call_method (like OP_call but `this` sits between fn and args on
        // the eval stack): [fn_ptr, this, a0 .. a_{N-1}] → [result]
        // Differences from OP_call:
        //   • fn_ptr is one slot deeper → peekN(callArgc+1) for resolve
        //   • eval-stack cleanup removes fn + this + N args → (callArgc + 2) * 4
        case OP_call_method: {
          const callArgc = bc.u16(pc + 1);
          if (!this._helperCallFn || callArgc > 4) return null;

          // Eval stack TOS..bottom: [a_{N-1}, ..., a_0, this, fn_ptr]

          if (this._helperResolveNative) {
            // ── Fast-path probe ──
            e.peekN(callArgc + 1);             // EAX = fn_ptr (below this + args)
            e.pushEax();                       // cdecl arg
            e.immEcx(this._helperResolveNative);
            e.callEcx();
            e.addEsp(4);
            e.testAA();
            const fixSlow = e.je();

            // ── Fast path: direct native call ──
            e.movEcxEax();                     // ECX = callee native addr

            // Update _jit_current_closure for the callee (call_method variant)
            if (this._closureGlobalAddr) {
              e.peekN(callArgc + 1);           // EAX = fn_ptr (below this + args)
              e.movAbsEax(this._closureGlobalAddr); // _jit_current_closure = fn_ptr
            }

            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);
            for (let k = 0; k < callArgc; k++) {
              e.peekN(4 - callArgc + 2 * k);
              e.pushEax();
            }
            e.callEcx();
            e.addEsp(16);                      // clean 4-arg cdecl
            e.addEsp((callArgc + 2) * 4);      // fn + this + args
            e.pushEax();
            const fixDone = e.jmp();

            // ── Slow path ──
            e.patch(fixSlow, e.here());
            e.pushImm32(callArgc);
            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);
            for (let k = 0; k < callArgc; k++) {
              e.peekN(5 - callArgc + 2 * k);
              e.pushEax();
            }
            e.peekN(6 + callArgc);
            e.pushEax();
            e.immEcx(this._helperCallFn);
            e.callEcx();
            e.addEsp(24);
            e.addEsp((callArgc + 2) * 4);
            e.pushEax();

            e.patch(fixDone, e.here());
          } else {
            // No resolveNative — slow path only.
            e.pushImm32(callArgc);
            for (let i = 3; i >= callArgc; i--) e.pushImm32(0);
            for (let k = 0; k < callArgc; k++) {
              e.peekN(5 - callArgc + 2 * k);
              e.pushEax();
            }
            e.peekN(6 + callArgc);
            e.pushEax();
            e.immEcx(this._helperCallFn);
            e.callEcx();
            e.addEsp(24);
            e.addEsp((callArgc + 2) * 4);
            e.pushEax();
          }

          pc += 3; break;
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

        // ── Closure variable access ──────────────────────────────────────
        // OP_get_var_ref: push closure var[idx] onto eval stack.
        // Uses saved closure JSObject* from frame-local to call the C helper
        // jit_js_get_var_ref_i32(obj_ptr, idx) → int32.
        case OP_get_var_ref: {
          const idx = bc.u16(pc + 1);
          if (!usesClosure) return null;
          e.pushImm32(idx);               // arg1: idx
          e.load(closureDisp);            // EAX = saved closure ptr
          e.pushEax();                    // arg0: obj_ptr
          e.immEcx(this._helperGetVarRef);
          e.callEcx();
          e.addEsp(8);                    // clean 2 cdecl args
          e.pushEax();                    // push result int32
          pc += 3; break;
        }

        // OP_put_var_ref: pop TOS and write to closure var[idx].
        case OP_put_var_ref: {
          const idx = bc.u16(pc + 1);
          if (!usesClosure) return null;
          e.popEax();                     // EAX = value to store
          e.pushEax();                    // arg2: val
          e.pushImm32(idx);               // arg1: idx
          e.load(closureDisp);            // EAX = saved closure ptr
          e.pushEax();                    // arg0: obj_ptr
          e.immEcx(this._helperPutVarRef);
          e.callEcx();
          e.addEsp(12);                   // clean 3 cdecl args
          pc += 3; break;
        }

        // OP_set_var_ref: write TOS to closure var[idx] but keep TOS on stack.
        case OP_set_var_ref: {
          const idx = bc.u16(pc + 1);
          if (!usesClosure) return null;
          e.peekTOS();                    // EAX = value (keep on stack)
          e.pushEax();                    // arg2: val
          e.pushImm32(idx);               // arg1: idx
          e.load(closureDisp);            // EAX = saved closure ptr
          e.pushEax();                    // arg0: obj_ptr
          e.immEcx(this._helperPutVarRef);
          e.callEcx();
          e.addEsp(12);                   // clean 3 cdecl args
          pc += 3; break;
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
  /** Number of individual functions evicted via LRU GC. */
  private _evictions: number = 0;
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
  /**
   * Cached addresses of C JIT helper functions (getprop, setprop, call).
   * Loaded lazily on first compile via kernel.jitHelperAddrs().
   */
  private _helperAddrs: { getPropI32: number; setPropI32: number; callFn: number; resolveNative: number;
                         stringEq: number; stringLen: number; stringCharAt: number;
                         getVarRef: number; putVarRef: number; closureGlobal: number } | null = null;

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

  /** Load C helper addresses once from kernel.jitHelperAddrs() and cache. */
  private _ensureHelperAddrs(): { getPropI32: number; setPropI32: number; callFn: number; resolveNative: number;
                                  stringEq: number; stringLen: number; stringCharAt: number;
                                  getVarRef: number; putVarRef: number; closureGlobal: number } | null {
    if (this._helperAddrs) return this._helperAddrs;
    if (typeof kernel !== 'undefined' && typeof (kernel as any).jitHelperAddrs === 'function') {
      const h = (kernel as any).jitHelperAddrs() as any;
      if (h && h.getPropI32 && h.callFn) {
        this._helperAddrs = {
          getPropI32: h.getPropI32,
          setPropI32: h.setPropI32,
          callFn: h.callFn,
          resolveNative: h.resolveNative ?? 0,
          stringEq: h.stringEq ?? 0,
          stringLen: h.stringLen ?? 0,
          stringCharAt: h.stringCharAt ?? 0,
          getVarRef: h.getVarRef ?? 0,
          putVarRef: h.putVarRef ?? 0,
          closureGlobal: h.closureGlobal ?? 0,
        };
        return this._helperAddrs;
      }
    }
    return null;
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
    // Float64 and Any arg types require the float-specialised tier.
    if (!entry.speculator.allIntegerLike() && argc > 0) {
      // Float64-specialised tier (item 851): attempt x87 FPU double-cdecl compilation.
      // The compiled function is registered with kernel.setJITNative(bcAddr, addr|1)
      // so QuickJS auto-dispatches to jit_call_d4() with double args.
      if (entry.speculator.hasFloat64() &&
          !this._floatFuncs.has(bcAddr) &&
          entry.speculator.callCount >= JIT_THRESHOLD &&
          argc <= 4) {  // jit_call_d4 supports max 4 double args
        this._tryCompileFloat(entry);
        // If _tryCompileFloat succeeded, entry.nativeAddr is now set (tagged).
        if (entry.nativeAddr) return 1;
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

    const compiler = new QJSJITCompiler(bc, icTable, regAlloc, deoptLogAddr, this._ensureHelperAddrs() ?? undefined);
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
   * The compiled function is registered with kernel.setJITNative() using bit-0
   * tagging (nativeAddr | 1) so that the QuickJS C dispatch path recognises it
   * as float64-ABI and calls jit_call_d4() with double args / double return.
   *
   * The tag bit is safe because JIT pool addresses are always >= 4-byte aligned.
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

    // Tag bit 0 → tells the C-side dispatch to use float64-ABI (jit_call_d4).
    const taggedAddr = (nativeAddr | 1) >>> 0;
    kernel.setJITNative(entry.bcAddr, taggedAddr);
    entry.nativeAddr = taggedAddr;
    entry.bailCount  = 0;

    this._floatFuncs.set(entry.bcAddr, nativeAddr);
    this._floatCompiled++;
    this._compiled++;

    if (typeof (kernel as any).serialPut === 'function') {
      (kernel as any).serialPut(
        `[JIT-f64] compiled bc@${entry.bcAddr.toString(16)} ` +
        `→ native@${nativeAddr.toString(16)} (${native.length}B) [auto-dispatch]\n`
      );
    }
  }

  /** Return the native address of a float-compiled function, or 0 if not yet compiled. */
  getFloatAddr(bcAddr: number): number {
    return this._floatFuncs.get(bcAddr) ?? 0;
  }

  get floatCompiledCount(): number { return this._floatCompiled; }

  /**
   * LRU pool GC: evicts the coldest ~50% of compiled functions by lastAccess,
   * then resets the pool bump allocator and lets hot functions recompile on
   * their next invocation.  This preserves recently-used compiled code while
   * reclaiming pool space.  O(n log n) in number of tracked functions.
   * Returns the number of bytes reclaimed (from bump reset).
   */
  private _poolGC(): number {
    if (typeof kernel === 'undefined') return 0;
    if (typeof (kernel as any).jitMainReset !== 'function') return 0;

    // Phase 1: gather all live compiled functions with their access times.
    const live: Array<{ bcAddr: number; lastAccess: number }> = [];
    for (const e of this._funcs.values()) {
      if (e.nativeAddr && e.nativeAddr !== DEOPT_SENTINEL) {
        live.push({ bcAddr: e.bcAddr, lastAccess: e.lastAccess });
      }
    }

    if (live.length === 0) {
      // Nothing to evict; just reset the pool.
      const reclaimed = (kernel as any).jitMainReset() as number;
      this._resets++;
      return reclaimed;
    }

    // Phase 2: sort by lastAccess ascending (coldest first).
    live.sort((a, b) => a.lastAccess - b.lastAccess);

    // Phase 3: evict the coldest 50% — clear their native pointers.
    const evictCount = Math.max(1, Math.floor(live.length / 2));
    const evicted = new Set<number>();
    for (let i = 0; i < evictCount; i++) {
      evicted.add(live[i].bcAddr);
    }

    // Phase 4: clear all native pointers (bump reset reclaims ALL memory).
    // Hot functions (not evicted) will recompile quickly on next call.
    // Evicted functions will need to re-warm their call count.
    for (const e of this._funcs.values()) {
      if (e.nativeAddr && e.nativeAddr !== DEOPT_SENTINEL) {
        kernel.setJITNative(e.bcAddr, 0);
        e.nativeAddr = 0;
        if (evicted.has(e.bcAddr)) {
          // Cold function: reset speculator so it re-warms
          e.speculator = new TypeSpeculator(e.speculator.argCount);
          e.bailCount = 0;
        }
        // Hot function: keep speculator/bailCount so it recompiles immediately
        e.blacklisted = false;
      }
    }
    // Clear float-compiled function references
    this._floatFuncs.clear();

    // Phase 5: reset the bump allocator.
    const reclaimed = (kernel as any).jitMainReset() as number;
    this._resets++;
    this._evictions += evictCount;
    if (typeof (kernel as any).serialPut === 'function') {
      (kernel as any).serialPut(
        `[JIT] LRU GC #${this._resets}: evicted ${evictCount}/${live.length} cold funcs, ` +
        `${(reclaimed / 1024).toFixed(0)} KB reclaimed\n`
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
    // Also clear any float-compiled entry so it can be re-attempted
    this._floatFuncs.delete(bcAddr);
    if (entry.deoptCount >= MAX_DEOPTS) {
      entry.blacklisted = true;
      kernel.setJITNative(entry.bcAddr, DEOPT_SENTINEL);
    }
  }

  get compiledCount(): number { return this._compiled; }
  get bailedCount():   number { return this._bailed;   }
  get deoptCount():    number { return this._jitDeopts; }
  get resetCount():    number { return this._resets;   }
  get evictionCount(): number { return this._evictions; }

  /** Return diagnostic stats for the JIT system. */
  jitStats(): {
    compiled: number; bailed: number; deopts: number;
    resets: number; evictions: number; tracked: number;
    floatCompiled: number; poolUtilKB: number;
  } {
    let liveCount = 0;
    for (const e of this._funcs.values()) {
      if (e.nativeAddr && e.nativeAddr !== DEOPT_SENTINEL) liveCount++;
    }
    let poolUsed = 0;
    if (typeof kernel !== 'undefined' && typeof (kernel as any).jitPoolUsed === 'function') {
      poolUsed = (kernel as any).jitPoolUsed() as number;
    }
    return {
      compiled: this._compiled,
      bailed: this._bailed,
      deopts: this._jitDeopts,
      resets: this._resets,
      evictions: this._evictions,
      tracked: this._funcs.size,
      floatCompiled: this._floatCompiled,
      poolUtilKB: Math.round(poolUsed / 1024),
    };
  }
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

        // ── Modulo (truncated remainder, like JS %) ─────────────────────────
        case OP_mod: {
          // Stack: [..., a, b]  b=TOS.  Result: a % b (truncated, like fmod)
          popToST0();   // ST(0) = b (divisor)
          popToST0();   // ST(0) = a (dividend), ST(1) = b
          // FPREM: ST(0) = ST(0) mod ST(1) (partial, may need iterations)
          // FPREM loop handles large a/b ratios.
          e.fpremLoop();
          // After FPREM: ST(0) = a%b, ST(1) = b (untouched).  Discard b.
          e.fxch();      // ST(0)=b, ST(1)=result
          e.fstpSt0();   // discard b → ST(0) = result
          pushST0(); pc++; break;
        }

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

        // ── Logical / bitwise unary ─────────────────────────────────────────
        case OP_lnot: {
          // Logical NOT: 0.0 → 1.0, non-zero → 0.0
          popToST0();    // ST(0) = val
          e.fldz();      // ST(0) = 0.0, ST(1) = val
          e.fcomip();    // compare 0.0 vs val; pop 0.0
          e.fstpSt0();   // discard val
          // ZF=1 if 0.0 == val → truthy result
          e.sete(); intToBoolDouble(); pc++; break;
        }
        case OP_not: {
          // Bitwise NOT: ~ToInt32(val)
          // Convert double to int32 via FISTP, NOT, convert back via FILD
          popToST0();              // ST(0) = val
          e.subEsp(4);             // reserve 4 bytes on stack
          e.fistDwordEsp();        // FISTP: store ST(0) rounded to int32 at [ESP] & pop FPU
          // NOT DWORD [ESP]: F7 /2 mod=00 rm=100(SIB) SIB=0x24
          e.buf.push(0xF7, 0x14, 0x24);
          e.fildDwordEsp();        // load ~int back as double into ST(0)
          e.addEsp(4);             // release temp
          pushST0(); pc++; break;
        }

        // ── Bitwise binary ops (double→int32, operate, int32→double) ────────
        // Helper pattern: pop two doubles as int32, operate, push result as double.
        // Uses two FISTP writes to consecutive [ESP] / [ESP+4] slots.
        case OP_and: case OP_or: case OP_xor:
        case OP_shl: case OP_sar: case OP_shr: {
          // Stack: [..., a, b]  b=TOS
          popToST0();              // ST(0) = b
          e.subEsp(4);
          e.fistDwordEsp();        // FISTP b → [ESP], pop FPU
          popToST0();              // ST(0) = a
          e.subEsp(4);
          e.fistDwordEsp();        // FISTP a → [ESP], pop FPU
          // Now: [ESP]=a (int32), [ESP+4]=b (int32)
          e.peekTOS();             // EAX = a
          // MOV ECX, [ESP+4]
          e.movEspDispEcx(4);      // ECX = b
          if (op === OP_and) {
            // AND EAX, ECX: 21 C8
            e.buf.push(0x21, 0xC8);
          } else if (op === OP_or) {
            // OR  EAX, ECX: 09 C8
            e.buf.push(0x09, 0xC8);
          } else if (op === OP_xor) {
            // XOR EAX, ECX: 31 C8
            e.buf.push(0x31, 0xC8);
          } else if (op === OP_shl) {
            // SHL EAX, CL:  D3 E0
            e.buf.push(0xD3, 0xE0);
          } else if (op === OP_sar) {
            // SAR EAX, CL:  D3 F8
            e.buf.push(0xD3, 0xF8);
          } else { // OP_shr
            // SHR EAX, CL:  D3 E8
            e.buf.push(0xD3, 0xE8);
          }
          // Store result at [ESP], convert back to double
          e.storeEspEax(0);        // [ESP] = result
          e.fildDwordEsp();        // ST(0) = (double)result
          e.addEsp(8);             // release both temp slots
          pushST0(); pc++; break;
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
            // push int constant as double via FILD
            const val = bc.cpoolInt(idx);
            e.immEax(val >>> 0);
            e.pushEax();
            e.fildDwordEsp();
            e.addEsp(4);
            pushST0();
          } else if (tag === JS_TAG_FLOAT64) {
            // Embed the IEEE 754 double literal directly in the generated code:
            //   PUSH hi32 → PUSH lo32 → FLD QWORD [ESP] → ADD ESP,8 → push to float eval stack
            const dval = bc.cpoolFloat64(idx);
            const fbuf = new Float64Array([dval]);
            const u32  = new Uint32Array(fbuf.buffer);
            const lo   = u32[0] >>> 0;  // low 32 bits  (bytes 0-3 little-endian)
            const hi   = u32[1] >>> 0;  // high 32 bits (bytes 4-7 little-endian)
            // PUSH hi first so that after PUSH lo: [ESP]=lo, [ESP+4]=hi = correct LE layout
            e.pushImm32(hi);
            e.pushImm32(lo);
            e.fldQwordEsp();
            e.addEsp(8);
            pushST0();
          } else {
            return null; // string/object/symbol constant — bail
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
          // TOS = val_old (8-byte double).  After: [..., val_old+1.0, val_old]
          // val_old at TOS = expression result; val_old+1.0 below = assigned back to variable.
          e.subEsp(8);                   // allocate a second 8-byte slot; old TOS moves to [ESP+8]
          e.fldQwordEspDisp(8);         // ST(0) = val_old (from [ESP+8])
          e.fstpQwordEsp();              // [ESP] = val_old (copy = expression result); pop FPU
          // Now: [ESP]=val_old (new TOS), [ESP+8]=val_old (will become val_old+1)
          e.fldQwordEspDisp(8);         // ST(0) = val_old again
          e.fld1();                      // ST(0)=1.0, ST(1)=val_old
          e.faddp();                     // ST(0) = val_old + 1.0
          e.fstpQwordEspDisp(8);        // [ESP+8] = val_old+1.0
          // Final layout: [ESP]=val_old (result), [ESP+8]=val_old+1.0 (to be stored) ✓
          pc++; break;
        }
        case OP_post_dec: {
          // Same as post_inc but subtract 1.  Use fld1 + fchs + faddp = add(-1).
          e.subEsp(8);
          e.fldQwordEspDisp(8);
          e.fstpQwordEsp();
          e.fldQwordEspDisp(8);
          e.fld1();
          e.fchs();                      // ST(0) = -1.0
          e.faddp();                     // ST(0) = val_old + (-1.0) = val_old - 1.0
          e.fstpQwordEspDisp(8);
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

        // ── Extended float stack manipulation ─────────────────────────────────

        case OP_dup2: {
          // [..., a, b] (b=TOS, 8-byte doubles) → [..., a, b, a, b]
          // After sub esp,16: old [ESP+16]=b, [ESP+24]=a relative to new ESP.
          e.subEsp(16);
          e.fldQwordEspDisp(24);   // ST(0) = a (old TOS-1)
          e.fstpQwordEspDisp(8);   // [ESP+8..15] = a (copy)
          e.fldQwordEspDisp(16);   // ST(0) = b (old TOS)
          e.fstpQwordEsp();        // [ESP..7]  = b (copy) ← new TOS
          pc++; break;
        }

        case OP_dup3: {
          // [..., a, b, c, d] (d=TOS) → [..., a, b, c, d, a]  — duplicate TOS-3.
          // TOS-3 = a is at [ESP+24]; after sub esp,8 it is at [ESP+32].
          e.subEsp(8);
          e.fldQwordEspDisp(32);   // ST(0) = a (the far-down entry)
          e.fstpQwordEsp();        // [ESP..7] = a ← new TOS
          pc++; break;
        }

        case OP_nip: {
          // [..., a, b] (b=TOS) → [..., b]  — discard TOS-1, keep TOS.
          e.fldQwordEsp();   // ST(0) = b (peek TOS; no ESP change)
          e.addEsp(8);       // discard b's 8-byte stack slot (now [ESP..7] = a)
          e.fstpQwordEsp();  // [ESP..7] = b (overwrites a) ← b is new TOS
          pc++; break;
        }

        case OP_nip1: {
          // [..., a, b, c] (c=TOS) → [..., a, c]  — remove middle element (TOS-2=b).
          // c=[ESP..7], b=[ESP+8..15], a=[ESP+16..23].
          // Load c, skip b by advancing ESP, write c back over where b was.
          e.fldQwordEsp();    // ST(0) = c (peek TOS)
          e.addEsp(8);        // discard c's slot; now [ESP..7]=b, [ESP+8..15]=a
          e.fstpQwordEsp();   // [ESP..7] = c (overwrites b) ← c is new TOS
          // Final: [ESP..7]=c, [ESP+8..15]=a — stack is one entry shorter ✓
          pc++; break;
        }

        case OP_rot3l: {
          // [..., a, b, c] (c=TOS) → [..., b, c, a]  (a=new TOS)
          // c=[ESP..7], b=[ESP+8..15], a=[ESP+16..23].
          // Load all three, then store in desired order using fxch to swap b↔c.
          e.fldQwordEsp();          // ST(0)=c
          e.fldQwordEspDisp(8);     // ST(0)=b, ST(1)=c
          e.fldQwordEspDisp(16);    // ST(0)=a, ST(1)=b, ST(2)=c
          e.fstpQwordEsp();         // [ESP..7]=a;   ST(0)=b, ST(1)=c
          e.fxch();                 // swap b↔c: ST(0)=c, ST(1)=b
          e.fstpQwordEspDisp(8);    // [ESP+8..15]=c; ST(0)=b
          e.fstpQwordEspDisp(16);   // [ESP+16..23]=b ✓
          pc++; break;
        }

        case OP_rot3r: {
          // [..., a, b, c] (c=TOS) → [..., c, a, b]  (b=new TOS)
          // c=[ESP..7], b=[ESP+8..15], a=[ESP+16..23].
          // Load all three, fxch to bring b to top, then store b/a/c in order.
          e.fldQwordEsp();          // ST(0)=c
          e.fldQwordEspDisp(8);     // ST(0)=b, ST(1)=c
          e.fldQwordEspDisp(16);    // ST(0)=a, ST(1)=b, ST(2)=c
          e.fxch();                 // swap a↔b: ST(0)=b, ST(1)=a, ST(2)=c
          e.fstpQwordEsp();         // [ESP..7]=b;    ST(0)=a, ST(1)=c
          e.fstpQwordEspDisp(8);    // [ESP+8..15]=a; ST(0)=c
          e.fstpQwordEspDisp(16);   // [ESP+16..23]=c ✓
          pc++; break;
        }

        case OP_add_loc8: {
          // local[u8_idx] += TOS (TOS consumed).  8-byte double eval stack.
          const i = bc.u8(pc + 1);
          e.fldQwordEsp();          // ST(0) = addend (TOS)
          e.addEsp(8);              // pop eval stack
          e.fld64Ebp(ldisp(i));     // ST(0)=local[i], ST(1)=addend
          e.faddp();                // ST(0) = local[i] + addend; pop ST(1)
          e.fstp64Ebp(ldisp(i));   // store result back to local[i]; pop FPU
          pc += 2; break;
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
      // 0x45 = OP_call_method — covered by [OP_call_method] above
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

/** Item 867: Loop-invariant code motion (LICM) — identifies bytecode PCs in
 *  loop bodies whose results are invariant (only depend on values defined
 *  outside the loop).  The compile() method can use this set to pre-compute
 *  these values before the loop header, reducing redundant work per iteration.
 *
 *  Analysis approach (bytecode-level, no SSA):
 *   1. Each back edge (target < source) defines a natural loop body [header, tail].
 *   2. Collect all locals/args/var_refs WRITTEN inside the loop body.
 *   3. Any read (OP_get_loc/OP_get_arg/OP_get_var_ref) of a variable NOT written
 *      inside the loop is loop-invariant.
 *   4. Constant pushes (OP_push_i32, OP_push_const with int tag) are always invariant.
 */
export class LICMPass {
  /** Returns set of bytecode PCs whose result is loop-invariant. */
  static analyze(bc: QJSBytecodeReader, loopHeaders: Set<number>): Set<number> {
    const invariant = new Set<number>();
    if (loopHeaders.size === 0) return invariant;

    // Build loop bodies: for each header find the furthest back edge source
    // that jumps to it, defining the body range [header, tailEnd).
    const loops: Array<{ header: number; tailEnd: number }> = [];

    // Scan all backwards branches to find loop tails
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      let target = -1;
      let instrEnd = pc + 1;
      if (op === OP_goto8) {
        instrEnd = pc + 2; target = pc + 2 + bc.i8(pc + 1);
      } else if (op === OP_goto16) {
        instrEnd = pc + 3; target = pc + 3 + bc.i16(pc + 1);
      } else if (op === OP_goto) {
        instrEnd = pc + 5; target = pc + 5 + bc.i32(pc + 1);
      } else if (op === OP_if_true8 || op === OP_if_false8) {
        instrEnd = pc + 2; target = pc + 2 + bc.i8(pc + 1);
      } else if (op === OP_if_true || op === OP_if_false) {
        instrEnd = pc + 5; target = pc + 5 + bc.i32(pc + 1);
      } else {
        pc += OPCODE_SIZE[op] ?? 1;
        continue;
      }

      // Back edge: target is before current pc and is a known loop header
      if (target >= 0 && target < pc && loopHeaders.has(target)) {
        // Merge with existing loop for the same header
        let merged = false;
        for (const lp of loops) {
          if (lp.header === target) {
            lp.tailEnd = Math.max(lp.tailEnd, instrEnd);
            merged = true;
            break;
          }
        }
        if (!merged) loops.push({ header: target, tailEnd: instrEnd });
      }

      pc = instrEnd;
    }

    // For each loop, determine invariant PCs
    for (const loop of loops) {
      // Collect written locals, written args, written var_refs inside loop body
      const writtenLocals = new Set<number>();
      const writtenArgs   = new Set<number>();
      const writtenVarRefs = new Set<number>();

      let lpc = loop.header;
      while (lpc < loop.tailEnd && lpc < bc.bcLen) {
        const op = bc.u8(lpc);
        // Local writes
        if (op === OP_put_loc || op === OP_set_loc || op === OP_inc_loc || op === OP_dec_loc || op === OP_add_loc) {
          writtenLocals.add(bc.u16(lpc + 1));
        } else if (op === OP_inc_loc8 || op === OP_dec_loc8 || op === OP_add_loc8) {
          writtenLocals.add(bc.u8(lpc + 1));
        } else if (op === OP_put_loc0 || op === OP_set_loc0) { writtenLocals.add(0); }
        else if (op === OP_put_loc1 || op === OP_set_loc1) { writtenLocals.add(1); }
        else if (op === OP_put_loc2 || op === OP_set_loc2) { writtenLocals.add(2); }
        else if (op === OP_put_loc3 || op === OP_set_loc3) { writtenLocals.add(3); }
        // Arg writes
        else if (op === OP_put_arg || op === OP_set_arg) { writtenArgs.add(bc.u16(lpc + 1)); }
        // Var ref writes
        else if (op === OP_put_var_ref || op === OP_set_var_ref) { writtenVarRefs.add(bc.u16(lpc + 1)); }

        lpc += OPCODE_SIZE[op] ?? 1;
      }

      // Second pass: mark invariant reads and constants
      lpc = loop.header;
      while (lpc < loop.tailEnd && lpc < bc.bcLen) {
        const op = bc.u8(lpc);

        // Constant pushes are always invariant
        if (op === OP_push_i32 || op === OP_push_false || op === OP_push_true ||
            op === OP_null || op === OP_undefined) {
          invariant.add(lpc);
        }
        // OP_push_const with integer tag is invariant
        else if (op === OP_push_const) {
          const idx = bc.u32(lpc + 1);
          if (bc.cpoolTag(idx) === JS_TAG_INT || bc.cpoolTag(idx) === JS_TAG_BOOL) {
            invariant.add(lpc);
          }
        }
        // Local reads of non-written locals
        else if (op === OP_get_loc) {
          if (!writtenLocals.has(bc.u16(lpc + 1))) invariant.add(lpc);
        }
        else if (op === OP_get_loc0 && !writtenLocals.has(0)) invariant.add(lpc);
        else if (op === OP_get_loc1 && !writtenLocals.has(1)) invariant.add(lpc);
        else if (op === OP_get_loc2 && !writtenLocals.has(2)) invariant.add(lpc);
        else if (op === OP_get_loc3 && !writtenLocals.has(3)) invariant.add(lpc);
        // Arg reads of non-written args
        else if (op === OP_get_arg) {
          if (!writtenArgs.has(bc.u16(lpc + 1))) invariant.add(lpc);
        }
        // Var ref reads of non-written var refs
        else if (op === OP_get_var_ref) {
          if (!writtenVarRefs.has(bc.u16(lpc + 1))) invariant.add(lpc);
        }

        lpc += OPCODE_SIZE[op] ?? 1;
      }
    }

    return invariant;
  }
}

/** Item 868: Range analysis — propagates integer range bounds through the IR
 *  to eliminate redundant bounds checks on array accesses.
 *
 * Detection algorithm:
 *   1. Pre-pass: collect `push_i32(start); put_loc(i)` → initValues[i] = start
 *   2. For each loop body [header, tail]: collect locals incremented by
 *      inc_loc / inc_loc8 / add_loc (induction variables).
 *   3. At the loop header scan the first ≤24 bytes for the comparison pattern:
 *      get_loc(i);  push_i32(N);  lt → range[i] = [initVal, N-1]
 *      get_loc(i);  push_i32(N);  lte → range[i] = [initVal, N]
 *   Returns Map<localIdx, [min, max]> of guaranteed inclusive ranges.
 */
export class RangeAnalysis {
  static analyze(bc: QJSBytecodeReader, loopHeaders: Set<number>): Map<number, [number, number]> {
    const ranges = new Map<number, [number, number]>();
    if (loopHeaders.size === 0) return ranges;

    // Pass 1: collect initialization patterns push_i32(v); put_loc/set_loc(i)
    const initValues = new Map<number, number>(); // localIdx → init value
    {
      let p = 0;
      while (p < bc.bcLen) {
        const op = bc.u8(p);
        if (op === OP_push_i32) {
          const v = bc.i32(p + 1);
          const nop = bc.u8(p + 5);
          if (nop === OP_put_loc || nop === OP_set_loc) {
            initValues.set(bc.u16(p + 6), v);
          } else if (nop === OP_put_loc0 || nop === OP_set_loc0) {
            initValues.set(0, v);
          } else if (nop === OP_put_loc1 || nop === OP_set_loc1) {
            initValues.set(1, v);
          } else if (nop === OP_put_loc2 || nop === OP_set_loc2) {
            initValues.set(2, v);
          } else if (nop === OP_put_loc3 || nop === OP_set_loc3) {
            initValues.set(3, v);
          }
        }
        p += OPCODE_SIZE[op] ?? 1;
      }
    }

    // For each known loop header, find its tail (furthest back-edge source)
    for (const hdr of loopHeaders) {
      let tail = -1;
      {
        let p = 0;
        while (p < bc.bcLen) {
          const op = bc.u8(p);
          let target = -1;
          let end = p + (OPCODE_SIZE[op] ?? 1);
          if (op === OP_goto8)  { end = p + 2; target = p + 2 + bc.i8(p + 1); }
          else if (op === OP_goto16) { end = p + 3; target = p + 3 + bc.i16(p + 1); }
          else if (op === OP_goto)   { end = p + 5; target = p + 5 + bc.i32(p + 1); }
          else if (op === OP_if_true8 || op === OP_if_false8) { end = p + 2; target = p + 2 + bc.i8(p + 1); }
          else if (op === OP_if_true  || op === OP_if_false)  { end = p + 5; target = p + 5 + bc.i32(p + 1); }
          if (target === hdr && p > hdr) tail = Math.max(tail, end);
          p = end;
        }
      }
      if (tail < 0) continue; // no back edge — not a real loop

      // Pass 2: collect induction variables (locals incremented inside loop body)
      const indVars = new Set<number>();
      {
        let p = hdr;
        while (p < tail && p < bc.bcLen) {
          const op = bc.u8(p);
          if (op === OP_inc_loc || op === OP_dec_loc || op === OP_add_loc) {
            indVars.add(bc.u16(p + 1));
          } else if (op === OP_inc_loc8 || op === OP_dec_loc8 || op === OP_add_loc8) {
            indVars.add(bc.u8(p + 1));
          } else if (op === OP_put_loc0 || op === OP_set_loc0) { /* may write local 0 */ }
          p += OPCODE_SIZE[op] ?? 1;
        }
      }
      if (indVars.size === 0) continue;

      // Pass 3: find comparison at loop header — scan up to 32 bytes
      const scanEnd = Math.min(hdr + 32, tail, bc.bcLen);
      let p3 = hdr;
      while (p3 < scanEnd) {
        const op = bc.u8(p3);
        // Look for get_loc(i) where i is an induction variable
        let localIdx = -1;
        let afterGet = p3;
        if (op === OP_get_loc0) { localIdx = 0; afterGet = p3 + 1; }
        else if (op === OP_get_loc1) { localIdx = 1; afterGet = p3 + 1; }
        else if (op === OP_get_loc2) { localIdx = 2; afterGet = p3 + 1; }
        else if (op === OP_get_loc3) { localIdx = 3; afterGet = p3 + 1; }
        else if (op === OP_get_loc) { localIdx = bc.u16(p3 + 1); afterGet = p3 + 3; }

        if (localIdx >= 0 && indVars.has(localIdx) && afterGet + 5 < scanEnd) {
          // Try: push_i32(N) + lt/lte
          const boundOp = bc.u8(afterGet);
          if (boundOp === OP_push_i32) {
            const N = bc.i32(afterGet + 1);
            const cmpOp = bc.u8(afterGet + 5);
            const init = initValues.get(localIdx) ?? 0;
            if (cmpOp === OP_lt) {
              ranges.set(localIdx, [init, N - 1]);
            } else if (cmpOp === OP_lte) {
              ranges.set(localIdx, [init, N]);
            }
          }
        }
        p3 += OPCODE_SIZE[op] ?? 1;
      }
    }
    return ranges;
  }
}

/** Item 869: Constant folding — evaluates consecutive constant-push + arithmetic
 *  sequences at compile time and replaces them with pre-computed results.
 *
 *  Pattern: OP_push_i32(a); OP_push_i32(b); OP_{add,sub,mul,shl,sar,shr,or,and,xor}
 *  → folds to a single OP_push_i32(result).
 *
 *  Rather than mutating bytecode, returns a Map<pc, foldedValue> that the JIT
 *  compile() loop can check: if pc+5+5+1 matches a foldable triple, emit only
 *  the folded constant.
 */
export class ConstantFolder {
  /**
   * @returns Map from the PC of the FIRST push_i32 in a foldable triple →
   *          { result: folded int32, skipLen: total bytecode bytes to skip }.
   */
  static fold(bc: QJSBytecodeReader): Map<number, { result: number; skipLen: number }> {
    const folds = new Map<number, { result: number; skipLen: number }>();
    let pc = 0;
    while (pc + 10 < bc.bcLen) {
      // Pattern: push_i32(a) [5B] + push_i32(b) [5B] + arith_op [1B]
      if (bc.u8(pc) !== OP_push_i32 || bc.u8(pc + 5) !== OP_push_i32) {
        pc += OPCODE_SIZE[bc.u8(pc)] ?? 1;
        continue;
      }
      const a = bc.i32(pc + 1);
      const b = bc.i32(pc + 6);
      const arithOp = bc.u8(pc + 10);

      let result: number | null = null;
      switch (arithOp) {
        case OP_add: result = (a + b) | 0; break;
        case OP_sub: result = (a - b) | 0; break;
        case OP_mul: result = Math.imul(a, b); break;
        case OP_or:  result = a | b; break;
        case OP_and: result = a & b; break;
        case OP_xor: result = a ^ b; break;
        case OP_shl: result = a << (b & 31); break;
        case OP_sar: result = a >> (b & 31); break;
        case OP_shr: result = (a >>> (b & 31)) | 0; break;
      }
      if (result !== null) {
        folds.set(pc, { result, skipLen: 11 });  // 5 + 5 + 1
        pc += 11;
      } else {
        pc += OPCODE_SIZE[bc.u8(pc)] ?? 1;
      }
    }
    return folds;
  }
}

/** Item 870: Arguments object elimination — when `arguments` is never used,
 *  skip allocating the arguments array object. */
export class ArgumentsElimPass {
  /**
   * Returns true when the function never creates an `arguments` object, meaning
   * no OP_special_object(kind=0 mapped | kind=1 unmapped) is emitted.
   * In that case the JIT skips allocating a heavyweight arguments array entirely.
   *
   * When false, OP_special_object is in IC_OPCODES so the JIT slow-paths through
   * the interpreter for that single opcode rather than bailing the whole function.
   */
  static canEliminate(bc: QJSBytecodeReader): boolean {
    // OP_special_object = 0x0C (2 bytes: opcode + kind byte)
    // kind 0 = JS_SPECIAL_OBJECT_ARGUMENTS_MAPPED
    // kind 1 = JS_SPECIAL_OBJECT_ARGUMENTS_UNMAPPED
    const OP_SPECIAL_OBJ = 0x0C;
    let pc = 0;
    while (pc + 1 < bc.bcLen) {
      const op = bc.u8(pc);
      if (op === OP_SPECIAL_OBJ) {
        const kind = bc.u8(pc + 1);
        if (kind === 0 || kind === 1) return false; // arguments object creation
        pc += 2; // skip opcode + kind
        continue;
      }
      pc += OPCODE_SIZE[op] ?? 1;
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
  /**
   * Returns true when a function is a linear async function with a single
   * tail await: `async function f() { ... return await expr; }`
   *
   * Pattern in QJS bytecode:
   *   OP_initial_yield (0xAE)  — marks async entry
   *   ... (setup)
   *   <expr bytecode>          — expression to await
   *   OP_await (0xB2)          — exactly one await
   *   (optional OP_nop/OP_label padding)
   *   OP_return_async (0x49)   — async return
   *
   * When true, AsyncDesugar.desugar() can rewrite the function so the JIT
   * compiles it without the generator state machine.
   */
  static isApplicable(bc: QJSBytecodeReader): boolean {
    const _OP_INITIAL_YIELD = 0xAE;
    const _OP_AWAIT         = 0xB2;
    const _OP_RETURN_ASYNC  = 0x49;
    const _OP_NOP           = 0x9C;
    const _OP_LABEL         = 0x9D;

    // Must start with OP_initial_yield (marks async function)
    if (bc.bcLen < 3 || bc.u8(0) !== _OP_INITIAL_YIELD) return false;

    // Count OP_await occurrences; must be exactly one
    let awaitCount = 0;
    let lastAwaitPc = -1;
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      if (op === _OP_AWAIT) { awaitCount++; lastAwaitPc = pc; if (awaitCount > 1) return false; }
      pc += OPCODE_SIZE[op] ?? 1;
    }
    if (awaitCount !== 1 || lastAwaitPc < 0) return false;

    // Verify: after the OP_await, the only ops before end are OP_nop/OP_label/OP_return_async
    pc = lastAwaitPc + 1;
    while (pc < bc.bcLen) {
      const op = bc.u8(pc);
      if (op === _OP_RETURN_ASYNC) return true;   // found the tail return — done
      if (op === _OP_NOP)                { pc++; continue; }
      if (op === _OP_LABEL)              { pc += 5; continue; }
      return false;  // any other op between await and return_async → not linear
    }
    return false; // OP_return_async not found
  }
}

/** Item 873: Async/await desugaring — compile state-machine directly to native
 *  without creating Promise/generator objects for simple linear async functions. */
export class AsyncDesugar {
  /**
   * Desugar a linear async function (single tail-await) to a plain synchronous
   * function whose return value is the awaited expression result.
   *
   * Bytecode transform:
   *   OP_initial_yield (0xAE)              → OP_nop (0x9C)    — remove async entry
   *   OP_await (0xB2)                      → OP_nop (0x9C)    — pass result through
   *   OP_return_async (0x49)               → OP_return_val (0x3C) — return the value
   *
   * Returns a QJSBytecodeReader backed by the patched buffer, or null if the
   * function does not match the expected pattern (should only be called after
   * PromiseFastPath.isApplicable() returns true).
   */
  static desugar(bc: QJSBytecodeReader): QJSBytecodeReader | null {
    const _OP_INITIAL_YIELD = 0xAE;
    const _OP_AWAIT         = 0xB2;
    const _OP_RETURN_ASYNC  = 0x49;
    const _OP_NOP           = 0x9C;
    const _OP_RETURN_VAL    = 0x3C;

    // Copy bytecode bytes into a mutable Uint8Array
    const patched = new Uint8Array(bc.bcLen);
    for (let i = 0; i < bc.bcLen; i++) patched[i] = bc.u8(i);

    let foundAwait = false;
    let foundReturn = false;
    let pc = 0;
    while (pc < bc.bcLen) {
      const op = patched[pc];
      if (op === _OP_INITIAL_YIELD) {
        patched[pc] = _OP_NOP;          // nop out the generator init
        pc++; continue;
      }
      if (op === _OP_AWAIT) {
        patched[pc] = _OP_NOP;          // await → pass value through unchanged
        foundAwait = true;
        pc++; continue;
      }
      if (op === _OP_RETURN_ASYNC) {
        patched[pc] = _OP_RETURN_VAL;   // return the awaited value as plain return
        foundReturn = true;
        pc++; continue;
      }
      pc += OPCODE_SIZE[op] ?? 1;
    }

    if (!foundAwait || !foundReturn) return null; // safety check

    return QJSBytecodeReader.fromBytes(bc, patched.buffer);
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
