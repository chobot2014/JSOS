/**
 * wasm-runtime.ts — TypeScript API for the JSOS WASM Runtime
 *
 * Architecture:
 *   The JSOS WASM runtime lives entirely in the kernel (wasm_runtime.c).
 *   It provides a WASM MVP binary parser, a stack interpreter, and an x86-32
 *   JIT compiler that integrates with the existing jit_alloc() pool.
 *
 *   This module is a thin ergonomic wrapper over the raw kernel.wasm* calls,
 *   providing a WebAssembly-Web-API-like interface so that JSOS code can use
 *   WASM modules without dealing with integer IDs or manual JIT calls.
 *
 * Usage:
 *   // Compile AssemblyScript / WASM binary to Uint8Array, then:
 *   const inst = await WasmInstance.instantiate(buffer);
 *   if (!inst) throw new Error('WASM load failed');
 *
 *   // Option A: interpreted (always works, slower)
 *   const result = inst.call(inst.exportIndex('add'), 3, 5);
 *
 *   // Option B: JIT-compiled (i32-only functions, ~10× faster)
 *   const nativeAddr = inst.jitCompile(inst.exportIndex('add'));
 *   const result2 = kernel.jitCallI(nativeAddr, 3, 5, 0, 0);
 *
 * JIT compatibility:
 *   Only functions whose params and return type are all i32 can be JIT'd.
 *   wasmJitCompile() returns 0 for unsupported functions; the TypeScript API
 *   automatically falls back to the interpreter in that case.
 *
 * Memory access:
 *   inst.memory is a direct-mapped ArrayBuffer over the 1 MB linear memory
 *   slab in kernel BSS.  Reads and writes go directly to physical memory.
 *
 * Calling convention (JIT functions):
 *   cdecl, ≤ 4 i32 parameters.  Use kernel.jitCallI(addr, a0, a1, a2, a3).
 */

declare const kernel: {
  wasmInstantiate(buf: ArrayBuffer): {
    id: number;
    memAddr: number;
    memSize: number;
    memory: ArrayBuffer | null;
    exports: Array<{ name: string; funcIdx: number; paramCount: number }>;
  } | null;
  wasmJitCompile(id: number, funcIdx: number): number;
  wasmCall(id: number, funcIdx: number, a0: number, a1: number, a2: number, a3: number): number;
  wasmFree(id: number): void;
  jitCallI(addr: number, a0: number, a1: number, a2: number, a3: number): number;
};

/** A compiled export function, exposing both interpreted and JIT call paths */
export interface WasmExport {
  readonly name: string;
  readonly funcIdx: number;
  readonly paramCount: number;
  /** Native x86-32 address after JIT compilation, or 0 if not yet JIT'd / unsupported */
  nativeAddr: number;
  /** Call via JIT if available, otherwise fall back to interpreter */
  call(...args: number[]): number;
}

/**
 * WasmInstance wraps a single WASM module instance loaded into the kernel.
 *
 * Instances occupy one of 4 kernel slots (WASM_MAX_INSTANCES = 4).
 * Always call `.free()` when done to release the slot for reuse.
 */
export class WasmInstance {
  /** Kernel instance slot (0-3) */
  readonly id: number;
  /** Direct-mapped 1 MB linear memory (ArrayBuffer over kernel BSS) */
  readonly memory: ArrayBuffer | null;
  /** Named exports from the WASM module */
  readonly exports: ReadonlyMap<string, WasmExport>;

  private _freed = false;

  private constructor(
    id: number,
    memory: ArrayBuffer | null,
    exports: Map<string, WasmExport>,
  ) {
    this.id = id;
    this.memory = memory;
    this.exports = exports;
  }

  /**
   * Parse and instantiate a WASM MVP binary.
   * Returns null if the kernel has no free instance slot or the binary is invalid.
   *
   * @param buffer  ArrayBuffer containing a raw WASM binary (\0asm version 1)
   */
  static instantiate(buffer: ArrayBuffer): WasmInstance | null {
    const raw = kernel.wasmInstantiate(buffer);
    if (!raw || raw.id < 0) return null;

    const id = raw.id;
    const memory = raw.memory ?? null;

    const exportsMap = new Map<string, WasmExport>();
    for (const ex of raw.exports) {
      const { name, funcIdx, paramCount } = ex;
      // Capture mutable nativeAddr in a closure so `call` always sees the latest value
      const entry: WasmExport = {
        name,
        funcIdx,
        paramCount,
        nativeAddr: 0,
        call(...args: number[]): number {
          const a0 = args[0] | 0;
          const a1 = args[1] | 0;
          const a2 = args[2] | 0;
          const a3 = args[3] | 0;
          if (entry.nativeAddr) {
            return kernel.jitCallI(entry.nativeAddr, a0, a1, a2, a3);
          }
          return kernel.wasmCall(id, funcIdx, a0, a1, a2, a3);
        },
      };
      exportsMap.set(name, entry);
    }

    return new WasmInstance(id, memory, exportsMap);
  }

  /**
   * Look up a named export.  Returns the export or null if not found.
   */
  getExport(name: string): WasmExport | null {
    return this.exports.get(name) ?? null;
  }

  /**
   * Call a function by name.  JIT is used if already compiled, otherwise interpreted.
   * Returns 0 if the export does not exist.
   */
  callByName(name: string, ...args: number[]): number {
    const ex = this.exports.get(name);
    if (!ex) return 0;
    return ex.call(...args);
  }

  /**
   * JIT-compile a named export.
   * Returns the native address on success (> 0), or 0 if not supported / failed.
   * After a successful compile subsequent calls via `callByName` / `WasmExport.call`
   * automatically use the native code path.
   *
   * @param name  Exported function name
   */
  jitCompile(name: string): number {
    if (this._freed) return 0;
    const ex = this.exports.get(name);
    if (!ex) return 0;
    if (ex.nativeAddr) return ex.nativeAddr;
    const addr = kernel.wasmJitCompile(this.id, ex.funcIdx);
    if (addr) ex.nativeAddr = addr;
    return addr;
  }

  /**
   * JIT-compile all i32-only exports in the module.
   * Silently skips exports that use unsupported types.
   *
   * @returns Number of functions successfully JIT-compiled
   */
  jitCompileAll(): number {
    if (this._freed) return 0;
    let compiled = 0;
    for (const [, ex] of this.exports) {
      if (ex.nativeAddr) { compiled++; continue; }
      const addr = kernel.wasmJitCompile(this.id, ex.funcIdx);
      if (addr) { ex.nativeAddr = addr; compiled++; }
    }
    return compiled;
  }

  /**
   * Interpreted call by function index (lower-level, bypass export table).
   */
  callByIndex(funcIdx: number, a0 = 0, a1 = 0, a2 = 0, a3 = 0): number {
    if (this._freed) return 0;
    return kernel.wasmCall(this.id, funcIdx, a0, a1, a2, a3);
  }

  /**
   * Release the kernel instance slot.  The instance object must not be used after this.
   */
  free(): void {
    if (this._freed) return;
    kernel.wasmFree(this.id);
    this._freed = true;
  }

  /** Returns true if this instance has been freed. */
  get isFreed(): boolean { return this._freed; }
}

/**
 * Convenience wrapper: instantiate a WASM binary and JIT-compile all exports.
 *
 * @param buffer   Raw WASM binary
 * @param jitAll   If true (default), JIT-compile all compatible exports immediately
 */
export function loadWasm(buffer: ArrayBuffer, jitAll = true): WasmInstance | null {
  const inst = WasmInstance.instantiate(buffer);
  if (!inst) return null;
  if (jitAll) inst.jitCompileAll();
  return inst;
}

/**
 * Benchmark helper: returns calls-per-second for a named WASM export.
 * Runs for ~100 ms using the performance counter.
 *
 * @param inst    Live WasmInstance
 * @param name    Export name to benchmark
 * @param args    Arguments to pass on each call
 */
export function benchmarkWasm(
  inst: WasmInstance,
  name: string,
  ...args: number[]
): { interpreted: number; jit: number } {
  const ex = inst.getExport(name);
  if (!ex) return { interpreted: 0, jit: 0 };

  const SAMPLES = 10_000;

  // Interpreted baseline (temporarily disable native path)
  const savedAddr = ex.nativeAddr;
  ex.nativeAddr = 0;
  const t0 = Date.now();
  for (let i = 0; i < SAMPLES; i++) ex.call(...args);
  const interpMs = Math.max(Date.now() - t0, 1);
  ex.nativeAddr = savedAddr;

  // JIT path (compile if needed)
  if (!ex.nativeAddr) inst.jitCompile(name);
  const t1 = Date.now();
  for (let i = 0; i < SAMPLES; i++) ex.call(...args);
  const jitMs = Math.max(Date.now() - t1, 1);

  return {
    interpreted: Math.round(SAMPLES / (interpMs / 1000)),
    jit:         Math.round(SAMPLES / (jitMs  / 1000)),
  };
}
