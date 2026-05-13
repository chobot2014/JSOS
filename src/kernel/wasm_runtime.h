/*
 * JSOS WASM Runtime — public API
 *
 * Provides a WebAssembly MVP interpreter with an x86-32 JIT back-end.
 * All OS logic lives in C; TypeScript accesses WASM through kernel.*() bindings
 * defined in quickjs_binding.c (wasmInstantiate / wasmJitCompile / wasmCall).
 *
 * Capabilities:
 *   - Parse WASM MVP binaries (type, function, memory, export, code sections)
 *   - Interpret any WASM MVP module via a stack machine
 *   - JIT-compile i32 functions to native x86-32 using the existing jit_alloc() pool
 *   - Support up to WASM_MAX_INSTANCES concurrent live modules
 *   - Expose linear memory as a stable BSS slab (no-copy ArrayBuffer in JS)
 */

#ifndef WASM_RUNTIME_H
#define WASM_RUNTIME_H

#include <stdint.h>
#include <stddef.h>

/* ── Limits ─────────────────────────────────────────────────────────────── */
#define WASM_MAX_INSTANCES  4       /* concurrent live modules                */
#define WASM_MAX_TYPES      48      /* function type signatures per module     */
#define WASM_MAX_FUNCS      96      /* functions per module                    */
#define WASM_MAX_EXPORTS    32      /* exported names per module               */
#define WASM_MAX_PARAMS     8       /* max params per function signature       */
#define WASM_MAX_RESULTS    1       /* WASM MVP: at most 1 result              */
#define WASM_MAX_LOCALS     24      /* max non-param local vars per function   */
#define WASM_PAGES_DEFAULT  64      /* 64 × 64 KB = 4 MB linear memory        */
#define WASM_PAGE_SIZE      65536
#define WASM_MEM_SIZE       (WASM_PAGES_DEFAULT * WASM_PAGE_SIZE)  /* 1 MB    */

/* ── Public API ─────────────────────────────────────────────────────────── */

/*
 * wasm_runtime_init() — initialise BSS structures (idempotent).
 * Call once during kernel boot before any WASM API is used.
 */
void wasm_runtime_init(void);

/*
 * wasm_instantiate(binary, size) → instance id (0–3) or -1 on parse error.
 * Parses the WASM binary, sets up linear memory, and registers exports.
 * The binary is not retained after this call returns.
 */
int wasm_instantiate(const uint8_t *binary, uint32_t size);

/*
 * wasm_free(inst_id) — release an instance slot.
 * The native code in the JIT pool is NOT freed (pool is bump-allocated).
 */
void wasm_free(int inst_id);

/*
 * wasm_jit_compile(inst_id, func_idx) → native x86-32 address or 0.
 * JIT-compiles the specified function to x86-32 machine code using jit_alloc().
 * Returns 0 if the function signature uses types the JIT does not support
 * (i64, f32, f64) or if the function body exceeds buffer limits.
 * The caller should patch the result into JSFunctionBytecode.jit_native_ptr
 * via kernel.setJITNative() if needed, or call directly via kernel.jitCallI().
 */
uint32_t wasm_jit_compile(int inst_id, uint32_t func_idx);

/*
 * wasm_call(inst_id, func_idx, args, nargs) → int32 result (0 on exception/void).
 * Interprets a WASM function.  Used when a function is not JIT-compiled yet
 * or when the function uses types not supported by the JIT back-end.
 */
int32_t wasm_call(int inst_id, uint32_t func_idx,
                  const int32_t *args, int nargs);

/*
 * wasm_get_memory(inst_id, out_size) → pointer to linear memory slab or NULL.
 * The pointer is stable (BSS), valid for the lifetime of the instance.
 * *out_size is set to WASM_MEM_SIZE (1 MB) when the instance has memory.
 */
uint8_t *wasm_get_memory(int inst_id, uint32_t *out_size);

/*
 * wasm_export_count(inst_id) → number of exports, or 0.
 */
int wasm_export_count(int inst_id);

/*
 * wasm_export_info(inst_id, export_idx, out_name, out_func_idx) → 1 on success.
 * out_name must point to at least 64 bytes; out_func_idx receives the index.
 */
int wasm_export_info(int inst_id, int export_idx,
                     char *out_name, uint32_t *out_func_idx);

/*
 * wasm_func_param_count(inst_id, func_idx) → number of i32 params.
 */
int wasm_func_param_count(int inst_id, uint32_t func_idx);

#endif /* WASM_RUNTIME_H */
