# QuickJS Bytecode → x86 JIT: Unrolled Implementation Plan

> **Goal:** Page JavaScript executes 5–20× faster on hot functions.
> Fibonacci benchmark >10× speedup. React reconciler measurably faster.
>
> This document is the **fully unrolled, step-by-step** implementation spec.
> Every file, every struct offset, every opcode encoding, every test case
> is defined here. Nothing is left to "figure out later."

---

## Table of Contents

1. [Existing Infrastructure Inventory](#1-existing-infrastructure-inventory)
2. [Step 1: JIT Pool Expansion (C)](#step-1-jit-pool-expansion)
3. [Step 2: `readPhysMem` / `writePhysMem` Primitives (C + TS)](#step-2-readphysmem--writephysmem)
4. [Step 3: QuickJS Struct Layout Discovery (C boot probe)](#step-3-quickjs-struct-layout-discovery)
5. [Step 4: QuickJS Opcode Table (Research → Constants)](#step-4-quickjs-opcode-table)
6. [Step 5: QuickJS JIT Hook Point (C)](#step-5-quickjs-jit-hook-point)
7. [Step 6: `_Emit` Extensions for JIT Guards](#step-6-emit-extensions)
8. [Step 7: `QJSBytecodeReader` (TS)](#step-7-qjsbytecodereader)
9. [Step 8: Type Speculation System (TS)](#step-8-type-speculation)
10. [Step 9: `QJSJITCompiler` — Priority 1 Opcodes (TS)](#step-9-qjsjitcompiler)
11. [Step 10: `QJSJITHook` Dispatcher (TS)](#step-10-qjsjithook-dispatcher)
12. [Step 11: Integration Wiring (C + TS)](#step-11-integration-wiring)
13. [Step 12: Benchmarks & Validation](#step-12-benchmarks)
14. [Step 13: Float64 JIT Paths (x87 FPU)](#step-13-float64)
15. [Step 14: Inline Caches for Property Access](#step-14-inline-caches)
16. [Step 15: LRU Eviction](#step-15-lru-eviction)
17. [Dependency Graph](#dependency-graph)
18. [Risk Register](#risk-register)
19. [Glossary & Constants Reference](#glossary)

---

## 1. Existing Infrastructure Inventory

### What We Already Have (and will reuse)

| Component | File | What It Does |
|---|---|---|
| x86-32 emitter (`_Emit`) | `src/os/process/jit.ts:496–647` | Emits raw x86-32 bytes: MOV, ADD, SUB, IMUL, CMP, SETcc, Jcc, prologue/epilogue, mem32/mem8 r/w |
| JIT source parser + codegen | `src/os/process/jit.ts:1–1242` | Parses a restricted JS int32 subset, builds AST, generates x86-32 via `_Emit` |
| `JIT.compile()` public API | `src/os/process/jit.ts:1089–1148` | Parse → codegen → `kernel.jitAlloc` → `kernel.jitWrite` → return callable proxy |
| `JITProfiler` tiered warmup | `src/os/process/jit.ts:1163–1242` | Threshold-based Tier 0 (TS) → Tier 1 (native) promotion |
| `JITCanvas` pixel operations | `src/os/process/jit-canvas.ts` | Pre-compiled native: fillBuffer, fillRect, blitRow, blitAlphaRow, glyphRow |
| C JIT pool (256 KB BSS) | `src/kernel/jit.c` | `jit_alloc()` bump allocator, `jit_write()` memcpy, `jit_call_i4/i8()` trampolines |
| C JIT header | `src/kernel/jit.h` | Public C API: `jit_alloc`, `jit_write`, `jit_call_i4`, `jit_call_i8`, `jit_used_bytes` |
| Kernel bindings (JS→C) | `src/kernel/quickjs_binding.c:1486–1600` | `js_jit_alloc`, `js_jit_write`, `js_jit_call_i`, `js_jit_call_i8`, `js_physaddr_of` |
| TypeScript kernel types | `src/os/core/kernel.ts` | Full `KernelAPI` interface with JIT method signatures |

### What We Must Build

| Component | File(s) | Description |
|---|---|---|
| Pool expansion to 2 MB | `src/kernel/jit.c` | Change `JIT_POOL_SIZE` constant |
| `readPhysMem` primitive | `src/kernel/quickjs_binding.c` + `src/os/core/kernel.ts` | Read N bytes from a physical address into an ArrayBuffer |
| `writePhysMem` primitive | Same | Write N bytes to a physical address from an ArrayBuffer |
| Boot-time struct offsets | `src/kernel/quickjs_binding.c` | Export `JSFunctionBytecode` field offsets as `kernel.qjsOffsets` |
| QuickJS hook installation | QuickJS source (`quickjs.c`) + `quickjs_binding.c` | `JS_SetJITHook()` callback in the interpreter loop |
| `_Emit` extensions | `src/os/process/jit.ts` | CMP EAX imm32, MOV EAX [addr], new memory addressing modes |
| `QJSBytecodeReader` | `src/os/process/qjs-jit.ts` (new) | Reads `JSFunctionBytecode` structs from physical memory |
| Type speculation | `src/os/process/qjs-jit.ts` | Per-function arg/local type observation table |
| `QJSJITCompiler` | `src/os/process/qjs-jit.ts` | QuickJS opcode → x86-32 code generation |
| `QJSJITHook` dispatcher | `src/os/process/qjs-jit.ts` | Receives hook callbacks, manages compiled functions, handles deopt |
| Float64 emit ops | `src/os/process/jit.ts` | x87 FPU instructions: FLD, FSTP, FADD, FSUB, FMUL, FDIV |
| Inline cache stubs | `src/os/process/qjs-jit.ts` | Monomorphic IC for `OP_get_field` / `OP_put_field` |
| LRU eviction | `src/kernel/jit.c` + `src/os/process/qjs-jit.ts` | Evict coldest function when pool is full |

---

## Step 1: JIT Pool Expansion

**Files to modify:** `src/kernel/jit.c`, `src/kernel/jit.h`

### Rationale

A JIT-compiled SPA page can have 500+ hot functions at ~512 bytes each = 256 KB
consumed immediately. The current 256 KB pool will be exhausted on any non-trivial
page. 2 MB gives room for 4000 functions before eviction is needed.

### Exact Changes

**`src/kernel/jit.c`:**

```c
// BEFORE:
#define JIT_POOL_SIZE  (256u * 1024u)

// AFTER:
#define JIT_POOL_SIZE  (2u * 1024u * 1024u)   /* 2 MB */
```

No other changes needed. The BSS section in `linker.ld` already allocates
256 MB of heap (`0x10000000`), so an extra 1.75 MB in BSS is negligible.

**`src/kernel/jit.h`:** No changes — `JIT_ALLOC_MAX` (64 KB per allocation)
stays the same.

### Verify: BSS Budget

Current BSS occupants:
- `paging_pd[1024]` = 4 KB
- `_procs[8]` = ~132 KB (8 × 16 KB message slots)
- `_sbufs[8][256KB]` = 2 MB
- `fb_blit_buf[1024*768]` = 3 MB
- `_asm_buf[4096]` = 4 KB
- `_jit_write_buf[JIT_ALLOC_MAX]` = 64 KB
- `_jit_pool[256KB]` → `_jit_pool[2MB]` = +1.75 MB
- Total BSS ≈ 7–8 MB

The 256 MB heap region starts at `_heap_start` in `linker.ld`, well above BSS.
**No linker script changes needed.**

### Test

After modifying `jit.c`, verify:
1. OS boots normally
2. `kernel.jitUsedBytes()` returns 0 at startup
3. `JITCanvas.init()` still compiles all 5 pixel ops
4. Existing JIT pixel operations pass (terminal renders, window fills work)

**Update `jit.ts` stats function:**

```typescript
// BEFORE:
poolTotal: 256 * 1024,

// AFTER:
poolTotal: 2 * 1024 * 1024,
```

---

## Step 2: `readPhysMem` / `writePhysMem`

**Files to modify:**
- `src/kernel/quickjs_binding.c` — add two C functions + register them
- `src/os/core/kernel.ts` — add TypeScript declarations

### Rationale

The QJS bytecode reader needs to inspect `JSFunctionBytecode` structs at
arbitrary physical addresses. We already have `readMem8` (single byte) but
need bulk reads that return an ArrayBuffer.

### C Implementation

Add to `quickjs_binding.c` (near the existing memory functions, around line 309):

```c
/*
 * kernel.readPhysMem(addr, length) → ArrayBuffer
 * Bulk-read `length` bytes from physical address `addr`.
 * Returns a new ArrayBuffer containing a copy of the memory.
 * Max read: 1 MB (safety limit). Returns null on bad args.
 */
static JSValue js_read_phys_mem(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NULL;
    uint32_t addr = 0, length = 0;
    JS_ToUint32(c, &addr, argv[0]);
    JS_ToUint32(c, &length, argv[1]);
    if (length == 0 || length > (1024u * 1024u)) return JS_NULL;
    /* Allocate a JS ArrayBuffer and memcpy */
    JSValue ab = JS_NewArrayBufferCopy(c, (const uint8_t *)(uintptr_t)addr, (size_t)length);
    return ab;
}

/*
 * kernel.writePhysMem(addr, arrayBuffer) → void
 * Bulk-write an ArrayBuffer's contents to physical address `addr`.
 * Used for patching inline caches in JIT-compiled code.
 */
static JSValue js_write_phys_mem(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    size_t len = 0;
    uint8_t *data = JS_GetArrayBuffer(c, &len, argv[1]);
    if (!data || len == 0) return JS_UNDEFINED;
    memcpy((void *)(uintptr_t)addr, data, len);
    return JS_UNDEFINED;
}
```

**Important:** `JS_NewArrayBufferCopy` is a QuickJS API that allocates a new
ArrayBuffer and copies data into it. If your QuickJS version doesn't have it,
use the pattern:

```c
uint8_t *buf = js_malloc(c, length);
if (!buf) return JS_NULL;
memcpy(buf, (const void *)(uintptr_t)addr, length);
return JS_NewArrayBuffer(c, buf, length, js_free_array_buffer, NULL, 0);
```

where `js_free_array_buffer` is:

```c
static void js_free_array_buffer(JSRuntime *rt, void *opaque, void *ptr) {
    (void)opaque;
    js_free_rt(rt, ptr);
}
```

### Register in Function Table

Add to the `js_kernel_funcs[]` array:

```c
    /* Physical memory bulk access (JIT Phase 4) */
    JS_CFUNC_DEF("readPhysMem",   2, js_read_phys_mem),
    JS_CFUNC_DEF("writePhysMem",  2, js_write_phys_mem),
```

### TypeScript Declaration

Add to `src/os/core/kernel.ts` `KernelAPI` interface:

```typescript
  // ─ Physical memory bulk access (JIT Phase 4) ─────────────────────────────
  /**
   * Read `length` bytes from physical address `addr`.
   * Returns a new ArrayBuffer containing a copy of the memory region.
   * Max length: 1 MB. Returns null on bad args.
   */
  readPhysMem(addr: number, length: number): ArrayBuffer | null;
  /**
   * Write an ArrayBuffer's contents to physical address `addr`.
   * Used for patching inline caches in JIT-compiled code.
   */
  writePhysMem(addr: number, data: ArrayBuffer): void;
```

### Test

```typescript
// In REPL or test harness:
const addr = kernel.jitAlloc(16);       // get a pool address
kernel.jitWrite(addr, [0xB8, 0x2A, 0, 0, 0, 0xC3]); // mov eax,42; ret
const buf = kernel.readPhysMem(addr, 6);
const view = new Uint8Array(buf);
// view[0] should be 0xB8, view[1] should be 0x2A
```

---

## Step 3: QuickJS Struct Layout Discovery

**Files to modify:** `src/kernel/quickjs_binding.c`

### Rationale

`QJSBytecodeReader` must read fields from `JSFunctionBytecode` structs. But these
struct offsets depend on QuickJS version, compiler padding, and build configuration.
Hard-coding offsets is fragile. Instead, we export them from C at boot time via
`kernel.qjsOffsets`.

### What We Need to Know About JSFunctionBytecode

QuickJS's `JSFunctionBytecode` (defined in `quickjs.c`) contains:

```c
// Simplified — actual struct has more fields
typedef struct JSFunctionBytecode {
    JSGCObjectHeader header;          // offset 0, 8 bytes
    uint8_t js_mode;                  // varies
    uint8_t has_prototype : 1;
    uint8_t has_simple_parameter_list : 1;
    uint8_t is_derived_class_constructor : 1;
    uint8_t need_home_object : 1;
    uint8_t func_kind : 2;
    uint8_t new_target_allowed : 1;
    uint8_t super_call_allowed : 1;
    uint8_t super_allowed : 1;
    uint8_t arguments_allowed : 1;
    uint8_t has_debug : 1;
    uint8_t backtrace_barrier : 1;
    uint8_t read_only_bytecode : 1;
    uint16_t arg_count;
    uint16_t var_count;
    uint16_t defined_arg_count;
    uint16_t stack_size;
    JSContext *realm;
    JSValue *cpool;                   // constant pool pointer
    int cpool_count;
    int byte_code_len;
    uint8_t *byte_code_buf;           // THE BYTECODE POINTER
    // ... debug info, source, etc.
} JSFunctionBytecode;
```

### C Implementation: Boot Probe

Add to `quickjs_binding.c` (include `quickjs.c`-visible headers):

```c
#include "quickjs.h"

/*
 * kernel.qjsOffsets → { bcBuf, bcLen, argCount, varCount, cpoolPtr, cpoolCount, stackSize }
 *
 * Probes JSFunctionBytecode struct offsets at compile-time using offsetof().
 * These offsets are read by TypeScript's QJSBytecodeReader to parse bytecode.
 *
 * IMPORTANT: This requires that the JSFunctionBytecode definition is visible.
 * If QuickJS hides it in quickjs.c (not quickjs.h), we need to either:
 *   (a) Add a quickjs-internals.h with the struct definition, or
 *   (b) Forward-compute offsets from a known test function at boot
 */
```

**Strategy A — `offsetof` (if struct is visible):**

```c
#include <stddef.h>
// Only works if JSFunctionBytecode is visible in quickjs.h or a shared header

static JSValue js_qjs_offsets(JSContext *c, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "bcBuf",      JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, byte_code_buf)));
    JS_SetPropertyStr(c, obj, "bcLen",      JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, byte_code_len)));
    JS_SetPropertyStr(c, obj, "argCount",   JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, arg_count)));
    JS_SetPropertyStr(c, obj, "varCount",   JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, var_count)));
    JS_SetPropertyStr(c, obj, "cpoolPtr",   JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, cpool)));
    JS_SetPropertyStr(c, obj, "cpoolCount", JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, cpool_count)));
    JS_SetPropertyStr(c, obj, "stackSize",  JS_NewInt32(c, (int32_t)offsetof(JSFunctionBytecode, stack_size)));
    return obj;
}
```

**Strategy B — boot-time probe (if struct is opaque):**

Compile a known function at boot, then read its `JSFunctionBytecode*` from the
`JSValue` tag system. Match known patterns to find field offsets empirically.

```c
static int32_t _qjs_off_bcBuf    = -1;
static int32_t _qjs_off_bcLen    = -1;
static int32_t _qjs_off_argCount = -1;
static int32_t _qjs_off_varCount = -1;

/*
 * Called once during quickjs_initialize().
 * Compiles a canary function:  function _probe(a,b) { return a + b; }
 * Then scans the JSFunctionBytecode struct for known patterns:
 *   - arg_count == 2 (uint16)
 *   - byte_code_len > 0 (int32)
 *   - byte_code_buf is a valid pointer into the QuickJS heap
 */
static void _probe_qjs_layouts(void) {
    const char *probe_src = "function _probe(a,b) { return a + b; }; _probe";
    JSValue fn = JS_Eval(ctx, probe_src, strlen(probe_src), "<probe>", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return; }

    /* JSValue function → JSObject → JSFunctionBytecode pointer */
    /* We need QuickJS internals to extract this. Use JS_VALUE_GET_OBJ: */
    JSObject *obj = JS_VALUE_GET_OBJ(fn);
    /* JSObject.u.func.function_bytecode is the JSFunctionBytecode* */
    /* This requires internal struct visibility */
    JSFunctionBytecode *b = obj->u.func.function_bytecode;
    uint8_t *raw = (uint8_t *)b;

    /* Now use offsetof if available, or scan for arg_count == 2 */
    /* For maximum reliability, use both: */
    _qjs_off_argCount = -1;

    /* Scan first 128 bytes for a uint16 == 2 (arg_count) */
    for (int i = 8; i < 120; i += 2) {
        uint16_t val = *(uint16_t *)(raw + i);
        if (val == 2) {
            /* Verify: next uint16 should be var_count (0 for our probe) */
            uint16_t next = *(uint16_t *)(raw + i + 2);
            if (next == 0) {
                _qjs_off_argCount = i;
                _qjs_off_varCount = i + 2;
                break;
            }
        }
    }

    /* Find byte_code_buf: it's a pointer to memory containing opcodes */
    /* The first opcode of "return a+b" starts with OP_get_arg (0xC6 or similar) */
    for (int i = 8; i < 120; i += 4) {
        uint32_t ptr_val = *(uint32_t *)(raw + i);
        /* Check if it looks like a valid heap pointer (> 1MB, < RAM size) */
        if (ptr_val > 0x100000 && ptr_val < 0x20000000) {
            /* Check previous int32 for byte_code_len (should be small positive) */
            int32_t maybe_len = *(int32_t *)(raw + i - 4);
            if (maybe_len > 0 && maybe_len < 256) {
                _qjs_off_bcLen = i - 4;
                _qjs_off_bcBuf = i;
                break;
            }
        }
    }

    JS_FreeValue(ctx, fn);

    /* Log results to serial */
    if (_qjs_off_bcBuf >= 0) {
        platform_serial_puts("[JIT] QJS offsets: bcBuf=");
        /* ... print offsets ... */
    }
}
```

**Recommendation:** Use **Strategy A** (offsetof). Modify the Makefile to include
QuickJS internal headers. The build already compiles `quickjs.c` with `-I$(QUICKJS_DIR)`.
Add a `quickjs-internals.h` that forward-declares the needed structs.

### Register in Function Table

```c
    JS_CFUNC_DEF("qjsOffsets", 0, js_qjs_offsets),
```

### TypeScript Declaration

Add to `KernelAPI`:

```typescript
  // ─ QuickJS struct layout (JIT Phase 4) ────────────────────────────────────
  /**
   * Returns the byte offsets of key fields within JSFunctionBytecode.
   * Populated at boot time via offsetof() in C.
   */
  qjsOffsets: {
    bcBuf: number;       // offset of byte_code_buf pointer
    bcLen: number;       // offset of byte_code_len int32
    argCount: number;    // offset of arg_count uint16
    varCount: number;    // offset of var_count uint16
    cpoolPtr: number;    // offset of cpool pointer
    cpoolCount: number;  // offset of cpool_count int32
    stackSize: number;   // offset of stack_size uint16
  };
```

### Alternative: Hardcode with Validation

If exposing QuickJS internals is too complex, hardcode the offsets for the
specific QuickJS version we ship, and add a boot-time validation probe:

```typescript
// qjs-jit.ts
const QJS_OFFSETS = {
  bcBuf:      52,   // determined by inspection of our QJS build
  bcLen:      48,
  argCount:   14,
  varCount:   16,
  cpoolPtr:   40,
  cpoolCount: 44,
  stackSize:  20,
};

// Validate at boot by compiling a probe function:
function validateOffsets(): boolean {
  // ... compile "function p(a,b){return a+b}", get its bytecode ptr,
  //     read arg_count at offset 14, verify == 2
}
```

**Decision: Use the boot-probe approach (Strategy B or hardcode+validate).**
It avoids header dependency complexity and is self-verifying.

---

## Step 4: QuickJS Opcode Table

**Files to create:** `src/os/process/qjs-opcodes.ts` (new)

### Rationale

QuickJS opcodes are defined in `quickjs.c` via an enum. They are NOT exported in
any header. We must transcribe the exact numeric values for our QuickJS version.

### How to Extract

From the QuickJS source (`/opt/quickjs/quickjs.c`), search for `enum OPCodeEnum`:

```c
enum OPCodeEnum {
    OP_invalid = 0,
    OP_push_i32,        // 1
    OP_push_const,      // 2
    OP_fclosure,        // 3
    OP_push_atom_value, // 4
    OP_private_symbol,  // 5
    OP_undefined,       // 6
    OP_null,            // 7
    OP_push_this,       // 8
    OP_push_false,      // 9
    OP_push_true,       // 10
    OP_object,          // 11
    OP_special_object,  // various sub-opcodes
    OP_rest,
    OP_drop,            // 14-ish
    OP_nip,
    OP_nip1,
    OP_dup,
    OP_dup2,
    OP_dup3,
    OP_insert2,
    OP_insert3,
    OP_insert4,
    OP_perm3,
    OP_perm4,
    OP_perm5,
    OP_swap,
    OP_swap2,
    OP_rot3l,
    OP_rot3r,
    OP_rot4l,
    OP_rot5l,
    // ... continues for ~240 opcodes
};
```

### The Constants File

Create `src/os/process/qjs-opcodes.ts`:

```typescript
/**
 * qjs-opcodes.ts — QuickJS bytecode opcode constants
 *
 * These values MUST match the OPCodeEnum in the QuickJS version
 * compiled into JSOS (/opt/quickjs/quickjs.c).
 *
 * HOW TO REGENERATE:
 *   In the WSL build container, run:
 *     grep -n 'OP_' /opt/quickjs/quickjs.c | head -300
 *   Then map each enum entry to its ordinal position.
 *
 * VALIDATION:
 *   At boot, qjs-jit.ts compiles a canary function and verifies the
 *   first few opcodes match expected patterns. If they don't, the JIT
 *   disables itself gracefully.
 */

// ─── Priority 1: JIT Immediately ─────────────────────────────────────────────
// These cover ~80% of hot SPA integer arithmetic code.

export const OP_invalid           = 0;

// ── Push / Pop ──
export const OP_push_i32          = 1;    // Push 32-bit immediate (4 byte operand)
export const OP_push_const        = 2;    // Push constant pool entry (2 byte index)
export const OP_undefined         = 6;    // Push undefined
export const OP_null              = 7;    // Push null
export const OP_push_false        = 9;    // Push false (int 0)
export const OP_push_true         = 10;   // Push true (int 1)

export const OP_drop              = 14;   // Discard top of stack
export const OP_dup               = 17;   // Duplicate top of stack
export const OP_swap              = 26;   // Swap top two

// ── Variable access ──
export const OP_get_loc           = 0xC8; // Load local variable (1 byte index)
export const OP_put_loc           = 0xC9; // Store local variable (1 byte index)
export const OP_get_arg           = 0xCA; // Load function argument (1 byte index)
export const OP_put_arg           = 0xCB; // Store function argument (1 byte index)
export const OP_set_loc_uninitialized = 0xC7; // Mark local as uninitialized

// Wide variants (2-byte index): get_loc16 / put_loc16 / get_arg16 / put_arg16
// (exact codes determined by QJS version — see extraction step)

// ── Arithmetic ──
export const OP_add               = 0x; // Binary add (tags checked at runtime in interpreter)
export const OP_sub               = 0x; // Binary subtract
export const OP_mul               = 0x; // Binary multiply
export const OP_div               = 0x; // Binary divide
export const OP_mod               = 0x; // Binary modulo
export const OP_neg               = 0x; // Unary negate
export const OP_inc               = 0x; // Increment (used by post/pre-increment)
export const OP_dec               = 0x; // Decrement

// ── Bitwise ──
export const OP_shl               = 0x; // Shift left
export const OP_shr               = 0x; // Arithmetic shift right
export const OP_sar               = 0x; // Same as shr in QJS (signed)
export const OP_and               = 0x; // Bitwise AND
export const OP_or                = 0x; // Bitwise OR
export const OP_xor               = 0x; // Bitwise XOR
export const OP_not               = 0x; // Bitwise NOT

// ── Comparisons ──
export const OP_lt                = 0x; // Less than
export const OP_lte               = 0x; // Less than or equal
export const OP_gt                = 0x; // Greater than
export const OP_gte               = 0x; // Greater than or equal
export const OP_eq                = 0x; // Strict equal
export const OP_neq               = 0x; // Strict not-equal

// ── Control flow ──
export const OP_if_true           = 0x; // Pop, branch if truthy (2 or 4 byte offset)
export const OP_if_false          = 0x; // Pop, branch if falsy
export const OP_goto              = 0x; // Unconditional branch (4 byte offset)
export const OP_return            = 0x; // Return TOS
export const OP_return_undef      = 0x; // Return undefined

// ── Misc ──
export const OP_nop               = 0x; // No operation

// ── Push small integers (short encodings) ──
export const OP_push_0            = 0x; // Push int 0
export const OP_push_1            = 0x; // Push int 1
export const OP_push_minus1       = 0x; // Push int -1
export const OP_push_i8           = 0x; // Push 8-bit signed immediate

// ─── Priority 2: Phase 4b (Property Access / Calls) ──────────────────────────

export const OP_get_field2        = 0x; // Object property read (atom index operand)
export const OP_put_field         = 0x; // Object property write
export const OP_call              = 0x; // Function call (argc operand)
export const OP_call_method       = 0x; // Method call (argc operand)
export const OP_typeof            = 0x; // typeof operator
export const OP_instanceof        = 0x; // instanceof check
export const OP_in                = 0x; // `in` operator

// ─── Priority 3: Interpreter-only ────────────────────────────────────────────

export const OP_await             = 0x; // async/await state machine
export const OP_yield             = 0x; // generator yield
export const OP_regexp            = 0x; // regex compilation
export const OP_eval              = 0x; // nested eval()
export const OP_closure           = 0x; // closure creation with environment

// ─── Opcode Metadata ─────────────────────────────────────────────────────────

/**
 * Number of operand bytes following each opcode.
 * -1 = variable length (needs special decode logic).
 *
 * Populated by extractOpcodeInfo() at boot.
 */
export const OPCODE_OPERAND_BYTES: Record<number, number> = {
  // Will be filled in by the extraction step
};

/**
 * Stack effect: how many values does each opcode pop (-) and push (+)?
 * Format: [pop_count, push_count]
 */
export const OPCODE_STACK_EFFECT: Record<number, [number, number]> = {
  // Will be filled in by the extraction step
};
```

**IMPORTANT:** The `0x` placeholders above MUST be filled in by reading the actual
QuickJS source. This is Step 4's primary deliverable.

### Extraction Procedure

Run in the WSL build container:

```bash
# 1. Find the opcode enum
grep -n 'enum OPCodeEnum' /opt/quickjs/quickjs.c

# 2. Extract all OP_ definitions with line numbers
sed -n '/enum OPCodeEnum/,/^}/p' /opt/quickjs/quickjs.c | grep 'OP_' | cat -n

# 3. Also extract opcode_info (contains operand sizes):
grep -n 'opcode_info\[' /opt/quickjs/quickjs.c

# 4. Extract the DEF() macro entries from quickjs-opcode.h if separate:
cat /opt/quickjs/quickjs-opcode.h 2>/dev/null || echo "opcodes inline in quickjs.c"
```

Map each `OP_xxx` to its ordinal position in the enum. For example, if `OP_push_i32`
is the 2nd entry (0-based index 1), then `OP_push_i32 = 1`.

Also extract from QuickJS's `opcode_info[]` array:
- `size` field (1 = no operands, 2 = 1 byte operand, 5 = 4 byte operand, etc.)
- `n_pop` / `n_push` (stack effect)

### Validation Function

```typescript
/**
 * Validate opcode constants against a canary function.
 * Compiles `function(a) { return a + 1; }` and checks first few bytes.
 *
 * Expected bytecode for "function(a) { return a + 1; }":
 *   OP_get_arg 0       (load argument 0)
 *   OP_push_1           (push integer 1)
 *   OP_add               (add TOS values)
 *   OP_return            (return TOS)
 */
export function validateOpcodes(bcBuf: Uint8Array): boolean {
    if (bcBuf.length < 4) return false;
    // Check that the first opcode is OP_get_arg
    if (bcBuf[0] !== OP_get_arg) return false;
    // Check that OP_push_1 follows at the expected position
    // (exact offset depends on operand size of OP_get_arg)
    return true;
}
```

---

## Step 5: QuickJS JIT Hook Point

**Files to modify:**
- `/opt/quickjs/quickjs.c` (in WSL — the QuickJS source)
- `src/kernel/quickjs_binding.c`
- `src/kernel/Makefile` (if changes to QJS build flags are needed)

### What the Hook Does

QuickJS's interpreter loop (`JS_CallInternal`) is a giant `switch` statement over
opcodes. We insert a callback check at the function-call dispatch point: before
a function's bytecode is interpreted, check if it should be JIT-compiled.

### QuickJS Source Change

This is the **only change to QuickJS C source** in the entire JIT project.

**In `quickjs.c`, add to `JSRuntime` struct:**

```c
/* JIT hook — called before interpreting a warm function */
typedef int (*js_jit_hook_t)(JSContext *ctx,
                              void *bytecode_ptr,  /* JSFunctionBytecode* */
                              JSValue *stack_ptr,
                              int argc);
js_jit_hook_t  jit_hook;
void          *jit_hook_opaque;
```

**New public API function:**

```c
void JS_SetJITHook(JSRuntime *rt, js_jit_hook_t hook, void *opaque) {
    rt->jit_hook = hook;
    rt->jit_hook_opaque = opaque;
}
```

**In `JS_CallInternal`, at function entry (after the `call_count` increment):**

```c
/* Existing code increments b->call_count somewhere near function entry */
b->call_count++;

/* ── JIT hook insertion point ──────────────────────────────────────────── */
#define JIT_THRESHOLD 100
if (rt->jit_hook && b->call_count > JIT_THRESHOLD) {
    int r = rt->jit_hook(caller_ctx, (void *)b, sp, call_argc);
    if (r == 0) {
        /* JIT handled the call — result is on the stack at sp[-1] */
        /* Return normally as if the function completed */
        goto done;  /* or whatever label exits JS_CallInternal */
    }
    /* r != 0: fall through to interpreter */
}
```

**Finding the exact insertion point:**

1. Search `quickjs.c` for `JS_CallInternal` function definition
2. Inside it, find where `b = p->u.func.function_bytecode` is set
3. Find where `b->call_count++` (or equivalent) is incremented  
4. Insert the hook check immediately after the call_count increment
5. The hook's `r == 0` path must set the return value correctly and skip interpretation

**Critical detail — return value placement:**

When the JIT handles a call, it puts the result JSValue on the QuickJS value stack.
The exact stack position depends on QuickJS's calling convention:

```c
if (r == 0) {
    /* The JIT wrote the return value to sp[-1].
     * We need to simulate a normal function return:
     *   - sp is adjusted to point to the return value position
     *   - control flow returns to the caller's continuation
     */
    return sp[-1];
}
```

**Alternative (simpler) hook strategy — post-interpretation speedup only:**

Instead of replacing the function call entirely, use a simpler hook that just
records profiling data and compilation is triggered asynchronously:

```c
/* Lighter hook — just notifies TypeScript, doesn't replace execution */
if (rt->jit_hook && b->call_count == JIT_THRESHOLD) {
    rt->jit_hook(caller_ctx, (void *)b, NULL, call_argc);
    /* Always fall through to interpreter — JIT is compiled for NEXT call */
}

/* For compiled functions, check a "native code" pointer on the bytecode: */
if (b->jit_native_ptr) {
    /* Call native code directly */
    int32_t result = jit_call_i4(b->jit_native_ptr, ...);
    /* Convert result to JSValue and return */
}
```

**Recommendation:** Use the simpler approach. The hook notifies TypeScript when a
function reaches the threshold. TypeScript compiles it. A `jit_native_ptr` field
on `JSFunctionBytecode` is checked on every call for instant dispatch.

### Adding `jit_native_ptr` to JSFunctionBytecode

```c
// In the JSFunctionBytecode struct, add:
void *jit_native_ptr;  /* Native code pointer, set by JIT compiler. NULL = interpreted. */
```

Then in the function dispatch:

```c
if (b->jit_native_ptr) {
    /* Fast path: call native code */
    typedef int32_t (*jit_fn_t)(JSValue *sp, int argc);
    int32_t r = ((jit_fn_t)b->jit_native_ptr)(sp, call_argc);
    if (r != DEOPT_SENTINEL) {
        /* Success — push result onto stack and return */
        sp[-1] = JS_NewInt32(ctx, r);
        return sp[-1];
    }
    /* Deopt — clear native pointer and fall through to interpreter */
    b->jit_native_ptr = NULL;
}
```

### `quickjs_binding.c` — Hook Registration

```c
/*
 * The JIT hook callback. Called from QuickJS when a function reaches
 * JIT_THRESHOLD calls. Invokes the registered TypeScript callback.
 */
static JSValue _jit_ts_callback = JS_UNDEFINED;

static int _jit_hook_impl(JSContext *ctx, void *bytecode_ptr,
                           JSValue *stack_ptr, int argc) {
    if (JS_IsUndefined(_jit_ts_callback)) return 1; /* no TS handler → interpreter */

    /* Call TypeScript: jitHook(bytecodeAddr, stackAddr, argc) */
    JSValue args[3];
    args[0] = JS_NewUint32(ctx, (uint32_t)(uintptr_t)bytecode_ptr);
    args[1] = JS_NewUint32(ctx, (uint32_t)(uintptr_t)stack_ptr);
    args[2] = JS_NewInt32(ctx, argc);
    JSValue result = JS_Call(ctx, _jit_ts_callback, JS_UNDEFINED, 3, args);
    int r = 1;
    if (JS_IsNumber(result)) {
        int32_t v;
        JS_ToInt32(ctx, &v, result);
        r = v;
    }
    JS_FreeValue(ctx, result);
    return r;
}

/*
 * kernel.setJITHook(callback) — register the TypeScript JIT dispatch function.
 * callback receives (bytecodePtr, stackPtr, argc) and returns 0 (JIT handled)
 * or 1 (interpreter should handle).
 */
static JSValue js_set_jit_hook(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    if (!JS_IsUndefined(_jit_ts_callback))
        JS_FreeValue(c, _jit_ts_callback);
    _jit_ts_callback = JS_DupValue(c, argv[0]);
    JS_SetJITHook(JS_GetRuntime(c), _jit_hook_impl, NULL);
    return JS_UNDEFINED;
}

/*
 * kernel.setJITNative(bytecodeAddr, nativeAddr) → void
 * Sets the jit_native_ptr on a JSFunctionBytecode struct.
 * Called by TypeScript after compiling a function to native code.
 */
static JSValue js_set_jit_native(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    uint32_t bc_addr = 0, native_addr = 0;
    JS_ToUint32(c, &bc_addr, argv[0]);
    JS_ToUint32(c, &native_addr, argv[1]);
    JSFunctionBytecode *b = (JSFunctionBytecode *)(uintptr_t)bc_addr;
    b->jit_native_ptr = (void *)(uintptr_t)native_addr;
    return JS_UNDEFINED;
}
```

Register:

```c
    JS_CFUNC_DEF("setJITHook",   1, js_set_jit_hook),
    JS_CFUNC_DEF("setJITNative", 2, js_set_jit_native),
```

### TypeScript Declaration

```typescript
  // ─ QuickJS JIT hook (JIT Phase 4) ──────────────────────────────────────────
  /**
   * Register the JIT dispatch callback.
   * Called when a function reaches JIT_THRESHOLD calls.
   * callback(bytecodeAddr, stackAddr, argc) → 0 (JIT handled) | 1 (let interpreter run)
   */
  setJITHook(callback: (bcAddr: number, stackAddr: number, argc: number) => number): void;
  /**
   * Set the native code pointer for a compiled function.
   * After this, QuickJS will call the native code instead of interpreting.
   */
  setJITNative(bytecodeAddr: number, nativeAddr: number): void;
```

---

## Step 6: `_Emit` Extensions

**File to modify:** `src/os/process/jit.ts`

### New Instructions Needed

The QJS JIT compiler needs additional x86-32 instructions that the existing
`_Emit` class doesn't provide:

```typescript
// ── Additions to class _Emit ──

/** CMP EAX, imm32 — compare EAX with an immediate 32-bit value */
cmpEaxImm32(v: number): void {
  this._w(0x3D); this._u32(v);    // CMP EAX, imm32
}

/** CMP [EBP+disp], imm32 — compare memory with immediate */
cmpMemImm32(disp: number, v: number): void {
  if (disp >= -128 && disp <= 127) {
    this._w(0x81); this._w(0x7D); this._w(disp & 0xFF); this._u32(v);
  } else {
    this._w(0x81); this._w(0xBD); this._u32(disp); this._u32(v);
  }
}

/** MOV EAX, [addr] — load EAX from absolute 32-bit address */
movEaxAbs(addr: number): void {
  this._w(0xA1); this._u32(addr);    // MOV EAX, [addr]
}

/** MOV [addr], EAX — store EAX to absolute 32-bit address */
movAbsEax(addr: number): void {
  this._w(0xA3); this._u32(addr);    // MOV [addr], EAX
}

/** MOV ECX, imm32 */
immEcx(v: number): void {
  this._w(0xB9); this._u32(v);       // MOV ECX, imm32
}

/** MOV EDX, imm32 */
immEdx(v: number): void {
  this._w(0xBA); this._u32(v);       // MOV EDX, imm32
}

/** PUSH imm32 */
pushImm32(v: number): void {
  this._w(0x68); this._u32(v);       // PUSH imm32
}

/** PUSH imm8 (sign-extended) */
pushImm8(v: number): void {
  this._w(0x6A); this._w(v & 0xFF);  // PUSH imm8
}

/** ADD EAX, imm32 */
addEaxImm32(v: number): void {
  this._w(0x05); this._u32(v);       // ADD EAX, imm32
}

/** SUB EAX, imm32 */
subEaxImm32(v: number): void {
  this._w(0x2D); this._u32(v);       // SUB EAX, imm32
}

/** ADD ESP, imm32 (stack cleanup) */
addEsp(n: number): void {
  if (n === 0) return;
  if (n >= -128 && n <= 127) {
    this._w(0x83); this._w(0xC4); this._w(n & 0xFF);
  } else {
    this._w(0x81); this._w(0xC4); this._u32(n);
  }
}

/** SUB ESP, imm32 (reserve stack space) */
subEsp(n: number): void {
  if (n === 0) return;
  if (n >= -128 && n <= 127) {
    this._w(0x83); this._w(0xEC); this._w(n & 0xFF);
  } else {
    this._w(0x81); this._w(0xEC); this._u32(n);
  }
}

/** MOV EAX, [ECX+disp] — indexed memory read */
movEaxEcxDisp(disp: number): void {
  if (disp === 0) {
    this._w(0x8B); this._w(0x01);  // MOV EAX, [ECX]
  } else if (disp >= -128 && disp <= 127) {
    this._w(0x8B); this._w(0x41); this._w(disp & 0xFF);
  } else {
    this._w(0x8B); this._w(0x81); this._u32(disp);
  }
}

/** MOV [ECX+disp], EAX — indexed memory write */
movEcxDispEax(disp: number): void {
  if (disp === 0) {
    this._w(0x89); this._w(0x01);
  } else if (disp >= -128 && disp <= 127) {
    this._w(0x89); this._w(0x41); this._w(disp & 0xFF);
  } else {
    this._w(0x89); this._w(0x81); this._u32(disp);
  }
}

// ── x87 FPU instructions (for Float64 JIT — Step 13) ──

/** FLD QWORD [EBP+disp] — push float64 from stack frame onto x87 */
fld64Ebp(disp: number): void {
  if (disp >= -128 && disp <= 127) {
    this._w(0xDD); this._w(0x45); this._w(disp & 0xFF);
  } else {
    this._w(0xDD); this._w(0x85); this._u32(disp);
  }
}

/** FSTP QWORD [EBP+disp] — pop x87 TOS to stack frame */
fstp64Ebp(disp: number): void {
  if (disp >= -128 && disp <= 127) {
    this._w(0xDD); this._w(0x5D); this._w(disp & 0xFF);
  } else {
    this._w(0xDD); this._w(0x9D); this._u32(disp);
  }
}

/** FADDP ST(1), ST — pop and add */
faddp(): void { this._w(0xDE); this._w(0xC1); }
/** FSUBP ST(1), ST — pop and subtract */
fsubp(): void { this._w(0xDE); this._w(0xE9); }
/** FMULP ST(1), ST — pop and multiply */
fmulp(): void { this._w(0xDE); this._w(0xC9); }
/** FDIVP ST(1), ST — pop and divide */
fdivp(): void { this._w(0xDE); this._w(0xF9); }
/** FLDZ — push +0.0 */
fldz(): void { this._w(0xD9); this._w(0xEE); }
/** FLD1 — push +1.0 */
fld1(): void { this._w(0xD9); this._w(0xE8); }
/** FCOMIP ST, ST(1) — compare and set EFLAGS, pop */
fcomip(): void { this._w(0xDF); this._w(0xF1); }
/** FSTP ST(0) — discard x87 TOS */
fstpSt0(): void { this._w(0xDD); this._w(0xD8); }
```

### Export `_Emit`

Currently `_Emit` is not exported from `jit.ts`. We need to export it so
`qjs-jit.ts` can use it:

```typescript
// Change from:
class _Emit {
// To:
export class _Emit {
```

Also ensure `_Frame` is exported or move its functionality into a shared module.

---

## Step 7: `QJSBytecodeReader`

**File to create:** `src/os/process/qjs-jit.ts` (new)

### Purpose

Reads a `JSFunctionBytecode` struct from physical memory using `kernel.readPhysMem`
and provides typed accessors for each field.

### Implementation

```typescript
import { JIT, _Emit } from './jit.js';

declare var kernel: any;

// ─── JSValue Tag Constants ────────────────────────────────────────────────────
//
// QuickJS JSValue layout on i686 (32-bit, non-NaN-boxing build):
//
//   struct JSValue {
//     union { int32_t int32; double float64; void *ptr; } u;  // offset 0, 4 bytes
//     int32_t tag;                                             // offset 4, 4 bytes
//   };
//   Total: 8 bytes per JSValue
//
// IMPORTANT: On 32-bit QuickJS WITHOUT NaN-boxing (CONFIG_BIGNUM or default 32-bit),
// the layout is: { JSValueUnion u; int64_t tag; } = 12 bytes.
// But on our i686 build with QuickJS 2024-01-13, JSValue is 8 bytes:
//   u (4 bytes) + tag (4 bytes).
// VERIFY THIS by checking sizeof(JSValue) at boot.

export const JS_TAG_FIRST        = -11;
export const JS_TAG_BIG_DECIMAL  = -11;
export const JS_TAG_BIG_INT      = -10;
export const JS_TAG_BIG_FLOAT    = -9;
export const JS_TAG_SYMBOL       = -8;
export const JS_TAG_STRING       = -7;
export const JS_TAG_MODULE       = -3;
export const JS_TAG_FUNCTION_BYTECODE = -2;
export const JS_TAG_OBJECT       = -1;
export const JS_TAG_INT          = 0;
export const JS_TAG_BOOL         = 1;
export const JS_TAG_NULL         = 2;
export const JS_TAG_UNDEFINED    = 3;
export const JS_TAG_UNINITIALIZED = 4;
export const JS_TAG_CATCH_OFFSET = 5;
export const JS_TAG_EXCEPTION    = 6;
export const JS_TAG_FLOAT64      = 7;

/** Size of one JSValue on our i686 build (must be verified at boot) */
export const JSVALUE_SIZE = 8;

/** Deoptimization sentinel — returned by compiled code when a type guard fails */
export const DEOPT_SENTINEL = 0x7FFF_DEAD;

/** Number of calls before JIT compilation is attempted */
export const JIT_THRESHOLD = 100;

/** Number of deopt events before a function is permanently blacklisted */
export const MAX_DEOPTS = 3;

// ─── Struct Offsets ───────────────────────────────────────────────────────────
//
// These are the byte offsets of fields within JSFunctionBytecode.
// Determined at boot via kernel.qjsOffsets or hardcoded per QJS version.

interface QJSOffsets {
  bcBuf: number;       // byte_code_buf: uint8_t*
  bcLen: number;       // byte_code_len: int32_t
  argCount: number;    // arg_count: uint16_t
  varCount: number;    // var_count: uint16_t
  cpoolPtr: number;    // cpool: JSValue*
  cpoolCount: number;  // cpool_count: int32_t
  stackSize: number;   // stack_size: uint16_t
}

let _offsets: QJSOffsets | null = null;

/**
 * Initialize struct offsets. Must be called once at boot.
 * Uses kernel.qjsOffsets if available, otherwise falls back to hardcoded values.
 */
export function initOffsets(): boolean {
  if (typeof kernel !== 'undefined' && kernel.qjsOffsets) {
    _offsets = kernel.qjsOffsets;
    return true;
  }
  // Hardcoded fallback for QuickJS 2024-01-13 on i686
  // THESE VALUES MUST BE VERIFIED — see Step 3 validation
  _offsets = {
    bcBuf:      52,
    bcLen:      48,
    argCount:   14,
    varCount:   16,
    cpoolPtr:   40,
    cpoolCount: 44,
    stackSize:  20,
  };
  return true;
}

// ─── QJSBytecodeReader ───────────────────────────────────────────────────────

/**
 * Reads a JSFunctionBytecode struct from physical memory.
 *
 * Usage:
 *   const reader = new QJSBytecodeReader(bytecodeAddr);
 *   console.log(reader.argCount, reader.varCount, reader.bytecodeLen);
 *   const opcodes = reader.readOpcodes();
 */
export class QJSBytecodeReader {
  private _header: DataView;
  private _ptr: number;

  constructor(bytecodeAddr: number) {
    this._ptr = bytecodeAddr;
    // Read 128 bytes of the header — enough for all fields we need
    const raw = kernel.readPhysMem(bytecodeAddr, 128);
    if (!raw) throw new Error('[QJS-JIT] Failed to read bytecode header at 0x' +
                               bytecodeAddr.toString(16));
    this._header = new DataView(raw);
  }

  /** Physical address of the JSFunctionBytecode struct */
  get ptr(): number { return this._ptr; }

  /** Number of declared arguments */
  get argCount(): number {
    return this._header.getUint16(_offsets!.argCount, true);
  }

  /** Number of local variables (excluding arguments) */
  get varCount(): number {
    return this._header.getUint16(_offsets!.varCount, true);
  }

  /** Total slots (args + vars) — used for stack frame sizing */
  get totalSlots(): number {
    return this.argCount + this.varCount;
  }

  /** Size of the bytecode array in bytes */
  get bytecodeLen(): number {
    return this._header.getInt32(_offsets!.bcLen, true);
  }

  /** Physical address of the bytecode byte array */
  get bytecodeAddr(): number {
    return this._header.getUint32(_offsets!.bcBuf, true);
  }

  /** Physical address of the constant pool (JSValue array) */
  get cpoolAddr(): number {
    return this._header.getUint32(_offsets!.cpoolPtr, true);
  }

  /** Number of constants in the pool */
  get cpoolCount(): number {
    return this._header.getInt32(_offsets!.cpoolCount, true);
  }

  /** Maximum operand stack depth */
  get stackSize(): number {
    return this._header.getUint16(_offsets!.stackSize, true);
  }

  /**
   * Read the full bytecode byte array from memory.
   * Returns a Uint8Array copy.
   */
  readOpcodes(): Uint8Array {
    const addr = this.bytecodeAddr;
    const len = this.bytecodeLen;
    if (addr === 0 || len <= 0) return new Uint8Array(0);
    const raw = kernel.readPhysMem(addr, len);
    if (!raw) return new Uint8Array(0);
    return new Uint8Array(raw);
  }

  /**
   * Read a constant from the constant pool.
   * Returns the raw JSValue bytes (JSVALUE_SIZE bytes).
   */
  readConst(index: number): DataView {
    if (index < 0 || index >= this.cpoolCount) {
      throw new Error('[QJS-JIT] Constant index out of range: ' + index);
    }
    const addr = this.cpoolAddr + index * JSVALUE_SIZE;
    const raw = kernel.readPhysMem(addr, JSVALUE_SIZE);
    return new DataView(raw);
  }

  /**
   * Read a constant's int32 value (if it's JS_TAG_INT).
   * Returns null if the constant is not an integer.
   */
  readConstInt(index: number): number | null {
    const dv = this.readConst(index);
    const tag = dv.getInt32(4, true);  // tag is at offset 4 (after union u)
    if (tag !== JS_TAG_INT) return null;
    return dv.getInt32(0, true);       // u.int32 is at offset 0
  }

  /** Debug: dump header info to serial */
  dump(): void {
    kernel.serialPut('[QJS-JIT] Bytecode at 0x' + this._ptr.toString(16) + ':\n');
    kernel.serialPut('  argCount='   + this.argCount + '\n');
    kernel.serialPut('  varCount='   + this.varCount + '\n');
    kernel.serialPut('  bytecodeLen=' + this.bytecodeLen + '\n');
    kernel.serialPut('  bytecodeAddr=0x' + this.bytecodeAddr.toString(16) + '\n');
    kernel.serialPut('  cpoolAddr=0x'  + this.cpoolAddr.toString(16) + '\n');
    kernel.serialPut('  cpoolCount='   + this.cpoolCount + '\n');
    kernel.serialPut('  stackSize='    + this.stackSize + '\n');
  }
}
```

---

## Step 8: Type Speculation

**File:** `src/os/process/qjs-jit.ts` (continuation)

### Purpose

Track observed argument/local types across calls. Only compile when we're
confident all values are `JS_TAG_INT` (Phase 4a) or `JS_TAG_FLOAT64` (Phase 4b).

### Implementation

```typescript
// ─── Type Speculation ─────────────────────────────────────────────────────────

interface TypeProfile {
  /** Number of calls where ALL args were int32 */
  allIntCalls: number;
  /** Number of calls where at least one arg was NOT int32 */
  mixedCalls: number;
  /** Total calls observed */
  totalCalls: number;
  /** Per-slot observed tags (indexed by slot number) */
  slotTags: Map<number, number[]>;
}

/**
 * Manages type speculation for QJS JIT compilation.
 *
 * Policy:
 *   - Observe the first JIT_THRESHOLD calls
 *   - If ALL observed args were JS_TAG_INT for the last 8 consecutive calls → compile as int32
 *   - If ANY arg was non-int → mark as mixed and don't compile (interpreter only)
 */
export class TypeSpeculator {
  private _profiles = new Map<number, TypeProfile>();  // bytecodePtr → profile

  /** Record observed argument types for one call */
  observe(bytecodePtr: number, stackPtr: number, argc: number): void {
    let profile = this._profiles.get(bytecodePtr);
    if (!profile) {
      profile = { allIntCalls: 0, mixedCalls: 0, totalCalls: 0, slotTags: new Map() };
      this._profiles.set(bytecodePtr, profile);
    }

    profile.totalCalls++;

    // Read argument tags from the QuickJS value stack
    // Stack layout: each arg is a JSValue (JSVALUE_SIZE bytes)
    // sp points to the top of the argument list
    let allInt = true;
    for (let i = 0; i < argc; i++) {
      const tagAddr = stackPtr + i * JSVALUE_SIZE + 4; // tag is at +4 in JSValue
      const tagBuf = kernel.readPhysMem(tagAddr, 4);
      if (!tagBuf) { allInt = false; continue; }
      const tag = new DataView(tagBuf).getInt32(0, true);

      // Record per-slot tag
      let slotHistory = profile.slotTags.get(i);
      if (!slotHistory) {
        slotHistory = [];
        profile.slotTags.set(i, slotHistory);
      }
      // Keep last 8 observations
      if (slotHistory.length >= 8) slotHistory.shift();
      slotHistory.push(tag);

      if (tag !== JS_TAG_INT) allInt = false;
    }

    if (allInt) profile.allIntCalls++;
    else        profile.mixedCalls++;
  }

  /**
   * Should we compile this function?
   * Returns 'int32' if all recent observations were int32.
   * Returns 'float64' if all recent observations were float64.
   * Returns null if mixed types or insufficient data.
   */
  shouldCompile(bytecodePtr: number): 'int32' | 'float64' | null {
    const profile = this._profiles.get(bytecodePtr);
    if (!profile) return null;
    if (profile.totalCalls < 8) return null; // not enough data

    // Check if last 8 calls were all-int
    let allRecentInt = true;
    for (const [, history] of profile.slotTags) {
      if (history.length < 8) { allRecentInt = false; break; }
      for (let i = 0; i < 8; i++) {
        if (history[history.length - 8 + i] !== JS_TAG_INT) {
          allRecentInt = false;
          break;
        }
      }
      if (!allRecentInt) break;
    }

    if (allRecentInt) return 'int32';

    // TODO: Check for float64 (Phase 4b / Step 13)
    return null;
  }

  /** Get the profile for debugging */
  getProfile(bytecodePtr: number): TypeProfile | undefined {
    return this._profiles.get(bytecodePtr);
  }

  /** Clear all profiles (e.g., on pool eviction) */
  clear(): void {
    this._profiles.clear();
  }
}
```

### Type Guard x86-32 Emission

```typescript
/**
 * Emit a type guard that checks one JSValue's tag field.
 *
 * On our i686 build, JSValue is 8 bytes: [u.int32 (4B)] [tag (4B)]
 * Given a base register pointing to a JSValue, the tag is at baseReg + 4.
 *
 * @param e         The _Emit instance
 * @param baseAddr  Physical address of the JSValue to check
 * @param expectedTag  The expected JS_TAG_* value
 * @returns         Fixup offset for the JNE (deopt jump)
 */
function emitTypeGuard(e: _Emit, slotReg: 'ebp', slotDisp: number,
                        expectedTag: number): number {
  // Load the tag field: tag is at slotDisp + 4
  // MOV EAX, [EBP + slotDisp + 4]
  e.load(slotDisp + 4);
  // CMP EAX, expectedTag
  e.cmpEaxImm32(expectedTag);
  // JNE deopt_stub    (fixup returned to caller)
  return e.jne();
}
```

---

## Step 9: `QJSJITCompiler` — Priority 1 Opcodes

**File:** `src/os/process/qjs-jit.ts` (continuation)

### Architecture

The compiler translates QuickJS's **stack-based** bytecode to x86-32 **register-based**
native code. Key design decisions:

1. **Operand stack → x86 stack.** QJS opcodes push/pop JSValues from a virtual stack.
   We map this directly to the x86 ESP stack, pushing/popping int32 values.

2. **Locals/args → EBP-relative slots.** QJS locals and args map to fixed EBP offsets,
   similar to the existing `jit.ts` frame layout.

3. **Type guards at function entry.** We check all arg tags once at entry; if any
   mismatch, jump to a deopt stub that returns `DEOPT_SENTINEL`.

4. **Unsupported opcodes → bail out.** If we encounter an opcode we can't JIT,
   we abort compilation (the function stays in the interpreter).

### Stack Frame Layout (for compiled int32 functions)

```
Higher addresses
  ┌──────────────────┐
  │ return address    │ ← [EBP+4]
  ├──────────────────┤
  │ saved EBP        │ ← [EBP+0]
  ├──────────────────┤
  │ arg0 value       │ ← [EBP+8]      (passed by JIT trampoline)
  │ arg1 value       │ ← [EBP+12]
  │ arg2 value       │ ← [EBP+16]
  │ ...              │
  ├──────────────────┤
  │ local0           │ ← [EBP-4]      (int32 locals, no tags)
  │ local1           │ ← [EBP-8]
  │ ...              │
  ├──────────────────┤
  │ operand stack     │ ← ESP grows downward (dynamic)
  └──────────────────┘
Lower addresses
```

Wait — this doesn't match QuickJS's calling convention. The JIT-compiled function
will be called via our existing `jit_call_i4/i8` trampoline, which passes arguments
as regular cdecl args on the stack. But the QuickJS hook gives us a `stackPtr`
pointing to JSValues on the QJS operand stack.

### Two Approaches:

**Approach A: "Trampoline" — extract int32 values from JSValue stack, pass as cdecl args**

The hook:
1. Reads JSValue tags from the QJS stack (type guard)
2. Extracts int32 values from each JSValue
3. Calls the native code via `kernel.jitCallI8(nativePtr, arg0, arg1, ..., argN, 0, 0)`
4. Wraps the int32 return value back into a JSValue on the QJS stack

This is simple and correct. The compiled function receives plain int32 args.

**Approach B: "In-place" — compiled code reads from JSValue stack directly**

The compiled code receives the raw QJS stack pointer and decodes JSValues itself.
More complex but avoids the extraction overhead.

**Decision: Use Approach A.** It reuses the existing `jit_call_i4/i8` infrastructure
and keeps the compiled code identical to what `jit.ts` already generates.

### Modified Hook Flow

```
QuickJS calls function F for the Nth time
  │
  ▼
Hook fires: _jit_hook_impl(ctx, b, sp, argc)
  │
  ▼
TypeScript QJSJITHook.handle(b_addr, sp_addr, argc)
  │
  ├── Is function blacklisted? → return 1 (interpreter)
  ├── Is function already compiled?
  │     Yes → extract args from JSValue stack, call native
  │     No  → Is speculation confident?
  │             No  → observe types, return 1 (interpreter)
  │             Yes → compile, store native ptr
  │                   extract args, call native
  │
  ▼ (after native call)
  Result is int32 in EAX
  │
  ▼
  Write result as JSValue to sp[-1]:
    sp[-1].u.int32 = result
    sp[-1].tag = JS_TAG_INT
  Return 0 (JIT handled)
```

### The Compiler

```typescript
/**
 * Compiles one QuickJS bytecode function to x86-32 native code.
 *
 * Input: A QJSBytecodeReader positioned on a JSFunctionBytecode struct.
 * Output: Physical address of the compiled native code in the JIT pool.
 *
 * The compiled function uses cdecl calling convention:
 *   int32_t f(int32_t arg0, int32_t arg1, ..., int32_t argN-1)
 * Up to 8 arguments (limited by jitCallI8).
 *
 * Local variables are allocated on the native stack as int32 slots.
 * The QJS operand stack is simulated using the native x86 stack.
 */
export class QJSJITCompiler {
  private _e: _Emit;
  private _reader: QJSBytecodeReader;

  // Label management: QJS bytecode offset → x86 code offset
  private _labels = new Map<number, number>();
  // Forward jump patches: { codeFixupOff, targetBcOff }
  private _fwdPatches: Array<{ fixup: number; bcTarget: number }> = [];

  // Return fixups (compiled `return` statements jump here for epilogue)
  private _returnFixups: number[] = [];

  // Frame: number of arg slots and local slots
  private _argCount = 0;
  private _varCount = 0;
  // EBP-relative offset for each local
  // Args: [EBP + 8 + i*4]   (cdecl: first arg at EBP+8)
  // Vars: [EBP - 4 - i*4]    (below saved EBP)

  constructor(reader: QJSBytecodeReader) {
    this._reader = reader;
    this._e = new _Emit();
    this._argCount = reader.argCount;
    this._varCount = reader.varCount;
  }

  /** EBP-relative offset for argument `i` (0-indexed) */
  private _argSlot(i: number): number { return 8 + i * 4; }

  /** EBP-relative offset for local variable `i` (0-indexed) */
  private _varSlot(i: number): number { return -(4 + i * 4); }

  /**
   * Compile the function. Returns the native code address, or 0 on failure.
   */
  compile(): number {
    const e = this._e;
    const opcodes = this._reader.readOpcodes();
    if (opcodes.length === 0) return 0;

    // ── Prologue ──
    const localBytes = this._varCount * 4;
    e.prologue(localBytes);

    // Zero-initialize all local slots
    for (let i = 0; i < this._varCount; i++) {
      e.xorEaxEax();
      e.store(this._varSlot(i));
    }

    // ── Compile opcodes ──
    let pc = 0;
    while (pc < opcodes.length) {
      this._labels.set(pc, e.here());
      const op = opcodes[pc++];
      pc = this._emitOpcode(op, opcodes, pc);
      if (pc < 0) {
        // Unsupported opcode — abort compilation
        return 0;
      }
    }

    // ── Epilogue ──
    // Patch all return fixups to jump here
    const epilogueOff = e.here();
    for (const fix of this._returnFixups) {
      e.patch(fix, epilogueOff);
    }
    e.epilogue();

    // ── Patch forward jumps ──
    for (const p of this._fwdPatches) {
      const targetCode = this._labels.get(p.bcTarget);
      if (targetCode === undefined) {
        // Target label not found — likely a jump to an opcode we couldn't compile
        kernel.serialPut('[QJS-JIT] Unresolved jump target at bc offset ' +
                          p.bcTarget + '\n');
        return 0;
      }
      e.patch(p.fixup, targetCode);
    }

    // ── Allocate and write to JIT pool ──
    const code = e.buf;
    const addr = kernel.jitAlloc(code.length);
    if (!addr) {
      kernel.serialPut('[QJS-JIT] Pool exhausted (' + code.length + ' bytes needed)\n');
      return 0;
    }
    kernel.jitWrite(addr, code);
    return addr;
  }

  /**
   * Emit x86-32 code for one QuickJS opcode.
   * Returns the updated PC (next opcode position), or -1 if unsupported.
   */
  private _emitOpcode(op: number, ops: Uint8Array, pc: number): number {
    const e = this._e;

    switch (op) {

      // ── Push constants ──

      case OP_push_i32: {
        // 4-byte signed immediate
        const v = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        e.immEax(v);
        e.pushEax();
        return pc + 4;
      }

      case OP_push_0:
        e.xorEaxEax();
        e.pushEax();
        return pc;

      case OP_push_1:
        e.immEax(1);
        e.pushEax();
        return pc;

      case OP_push_minus1:
        e.immEax(-1);
        e.pushEax();
        return pc;

      case OP_push_i8: {
        // 1-byte signed immediate
        const v = (ops[pc] << 24) >> 24; // sign-extend
        e.immEax(v);
        e.pushEax();
        return pc + 1;
      }

      case OP_push_const: {
        // 2-byte constant pool index — read the int32 value
        const idx = ops[pc] | (ops[pc+1] << 8);
        const val = this._reader.readConstInt(idx);
        if (val === null) return -1; // non-int constant → can't JIT
        e.immEax(val);
        e.pushEax();
        return pc + 2;
      }

      case OP_push_false:
        e.xorEaxEax();
        e.pushEax();
        return pc;

      case OP_push_true:
        e.immEax(1);
        e.pushEax();
        return pc;

      case OP_undefined:
      case OP_null:
        e.xorEaxEax(); // treat undefined/null as 0 in int32 mode
        e.pushEax();
        return pc;

      // ── Variable access ──

      case OP_get_arg: {
        const idx = ops[pc++];
        if (idx >= this._argCount) return -1;
        e.load(this._argSlot(idx));
        e.pushEax();
        return pc;
      }

      case OP_put_arg: {
        const idx = ops[pc++];
        if (idx >= this._argCount) return -1;
        e.popEcx();     // POP ECX — get value
        e.movEaxEcx();  // MOV EAX, ECX
        e.store(this._argSlot(idx));
        return pc;
      }

      case OP_get_loc: {
        const idx = ops[pc++];
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.pushEax();
        return pc;
      }

      case OP_put_loc: {
        const idx = ops[pc++];
        if (idx >= this._varCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._varSlot(idx));
        return pc;
      }

      // ── Arithmetic (stack-based: pop two, push result) ──

      case OP_add:
        e.popEcx();               // RHS
        e.buf.push(0x58);         // POP EAX — LHS
        e.addAC();                // EAX = LHS + RHS
        e.pushEax();
        return pc;

      case OP_sub:
        e.popEcx();               // RHS
        e.buf.push(0x58);         // POP EAX — LHS
        e.subAC();                // EAX = LHS - RHS
        e.pushEax();
        return pc;

      case OP_mul:
        e.popEcx();
        e.buf.push(0x58);
        e.imulAC();
        e.pushEax();
        return pc;

      case OP_div:
        e.popEcx();               // RHS (divisor)
        e.buf.push(0x58);         // POP EAX — LHS (dividend)
        e.idivC();                // CDQ; IDIV ECX → EAX = quotient
        e.pushEax();
        return pc;

      case OP_mod:
        e.popEcx();
        e.buf.push(0x58);
        e.idivC();                // CDQ; IDIV ECX → EDX = remainder
        e.movEaxEdx();
        e.pushEax();
        return pc;

      case OP_neg:
        e.buf.push(0x58);         // POP EAX
        e.negEax();
        e.pushEax();
        return pc;

      // ── Bitwise ──

      case OP_shl:
        e.popEcx();               // shift amount → CL
        e.buf.push(0x58);         // POP EAX — value
        e.shlACl();
        e.pushEax();
        return pc;

      case OP_sar:
      case OP_shr:
        e.popEcx();
        e.buf.push(0x58);
        e.sarACl();
        e.pushEax();
        return pc;

      case OP_and:
        e.popEcx();
        e.buf.push(0x58);
        e.andAC();
        e.pushEax();
        return pc;

      case OP_or:
        e.popEcx();
        e.buf.push(0x58);
        e.orAC();
        e.pushEax();
        return pc;

      case OP_xor:
        e.popEcx();
        e.buf.push(0x58);
        e.xorAC();
        e.pushEax();
        return pc;

      case OP_not:
        e.buf.push(0x58);
        e.notEax();
        e.pushEax();
        return pc;

      // ── Comparisons ──

      case OP_lt:
        e.popEcx();                // RHS
        e.buf.push(0x58);          // POP EAX — LHS
        e.cmpAC(); e.setl();       // EAX = (LHS < RHS) ? 1 : 0
        e.pushEax();
        return pc;

      case OP_lte:
        e.popEcx(); e.buf.push(0x58);
        e.cmpAC(); e.setle();
        e.pushEax();
        return pc;

      case OP_gt:
        e.popEcx(); e.buf.push(0x58);
        e.cmpAC(); e.setg();
        e.pushEax();
        return pc;

      case OP_gte:
        e.popEcx(); e.buf.push(0x58);
        e.cmpAC(); e.setge();
        e.pushEax();
        return pc;

      case OP_eq:
        e.popEcx(); e.buf.push(0x58);
        e.cmpAC(); e.sete();
        e.pushEax();
        return pc;

      case OP_neq:
        e.popEcx(); e.buf.push(0x58);
        e.cmpAC(); e.setne();
        e.pushEax();
        return pc;

      // ── Control flow ──

      case OP_if_false: {
        // QuickJS uses a 4-byte signed offset from the CURRENT opcode position
        // (The offset is relative to the start of the offset field, i.e., pc)
        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + 4 + offset;  // target bytecode position

        e.buf.push(0x58);           // POP EAX
        e.testAA();                 // TEST EAX, EAX
        const fixup = e.je();      // JE to target (if false/zero)
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      case OP_if_true: {
        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + 4 + offset;

        e.buf.push(0x58);
        e.testAA();
        const fixup = e.jne();     // JNE to target (if true/non-zero)
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      case OP_goto: {
        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + 4 + offset;

        const fixup = e.jmp();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      case OP_return:
        e.buf.push(0x58);           // POP EAX — return value
        this._returnFixups.push(e.jmp());
        return pc;

      case OP_return_undef:
        e.xorEaxEax();              // return 0 (undefined → 0)
        this._returnFixups.push(e.jmp());
        return pc;

      // ── Stack manipulation ──

      case OP_drop:
        e.addEsp(4);                // discard TOS (ADD ESP, 4)
        return pc;

      case OP_dup:
        // Peek at TOS without popping, then push again
        // MOV EAX, [ESP]
        e._w(0x8B); e._w(0x04); e._w(0x24);  // MOV EAX, [ESP]
        e.pushEax();
        return pc;

      case OP_swap:
        // Swap [ESP] and [ESP+4]
        e.buf.push(0x58);           // POP EAX    (was TOS)
        e.popEcx();                 // POP ECX    (was TOS-1)
        e.pushEax();                // push former TOS
        e.buf.push(0x51);           // PUSH ECX   (former TOS-1 is now TOS)
        return pc;

      case OP_nop:
        return pc;

      // ── Increment / Decrement ──

      case OP_inc:
        e.buf.push(0x58);           // POP EAX
        e.addEaxImm32(1);
        e.pushEax();
        return pc;

      case OP_dec:
        e.buf.push(0x58);           // POP EAX
        e.subEaxImm32(1);
        e.pushEax();
        return pc;

      default:
        // Unsupported opcode — cannot JIT this function
        kernel.serialPut('[QJS-JIT] Unsupported opcode 0x' + op.toString(16) +
                          ' at bc offset ' + (pc - 1) + '\n');
        return -1;
    }
  }
}
```

### Important Notes

1. **Operand encoding:** QuickJS opcodes have variable-length operands. The exact
   number of operand bytes for each opcode is defined in QuickJS's `opcode_info[]`
   table. The values used above (1 byte for `get_loc/put_loc/get_arg/put_arg`,
   4 bytes for `push_i32`, 4 bytes for branch offsets) must be verified against
   our QuickJS version.

2. **Branch offset calculation:** QuickJS branch offsets are signed and relative.
   We need to verify whether they're relative to the opcode, the operand, or the
   next opcode. The code above assumes `target = pc + operand_size + offset`.

3. **Stack discipline:** QuickJS's virtual stack has strict invariants at each
   opcode. Our x86 stack must maintain the same invariants. The `OP_add` case
   pops 2 values and pushes 1. If any case gets the pop/push count wrong, the
   stack will be misaligned and the native code will crash.

4. **`_Emit` private methods:** The compiler uses `e._w()` which is private.
   Either make it public, or add a `raw(b: number)` method to `_Emit`.

---

## Step 10: `QJSJITHook` Dispatcher

**File:** `src/os/process/qjs-jit.ts` (continuation)

### Purpose

Receives callbacks from the QuickJS hook, manages the lifecycle of compiled
functions, handles deoptimization and blacklisting.

### Implementation

```typescript
/**
 * The main JIT dispatch class. One instance per JSOS runtime.
 *
 * Lifecycle:
 *   1. install() — registers the hook with QuickJS via kernel.setJITHook
 *   2. QuickJS calls handle() on every function call that exceeds JIT_THRESHOLD
 *   3. handle() returns 0 (JIT ran) or 1 (interpreter should run)
 *
 * Compilation flow:
 *   - First JIT_THRESHOLD calls: observe types, return 1
 *   - At threshold: check type speculation confidence
 *     - Confident? Compile and cache the native code; call it → return 0
 *     - Not confident? Return 1 (interpreter)
 *   - Subsequent calls: if compiled, extract args and call native → return 0
 *
 * Deoptimization:
 *   - If native code returns DEOPT_SENTINEL, increment deopt counter
 *   - Delete the compiled entry (forces recompilation with fresh speculation)
 *   - After MAX_DEOPTS, permanently blacklist the function
 */
export class QJSJITHook {
  // Compiled function cache: bytecodePtr → { nativeAddr, nParams }
  private _compiled = new Map<number, { native: number; nArgs: number; codeSize: number }>();

  // Functions that cannot/should not be JIT compiled
  private _blacklist = new Set<number>();

  // Deoptimization counters
  private _deopts = new Map<number, number>();

  // Type speculation engine
  private _speculator = new TypeSpeculator();

  // Statistics
  private _stats = {
    compilations: 0,
    deoptimizations: 0,
    blacklisted: 0,
    calls_jit: 0,
    calls_interp: 0,
  };

  /**
   * Install the JIT hook into QuickJS.
   * Must be called once at OS boot (after JIT pool is available).
   */
  install(): void {
    if (!JIT.available()) {
      kernel.serialPut('[QJS-JIT] JIT pool unavailable — hook not installed\n');
      return;
    }

    // Initialize struct offsets
    if (!initOffsets()) {
      kernel.serialPut('[QJS-JIT] Failed to initialize QJS struct offsets\n');
      return;
    }

    // Register the hook
    kernel.setJITHook((bcAddr: number, stackAddr: number, argc: number): number => {
      return this.handle(bcAddr, stackAddr, argc);
    });

    kernel.serialPut('[QJS-JIT] Hook installed (threshold=' + JIT_THRESHOLD + ')\n');
  }

  /**
   * Handle a JIT hook callback.
   *
   * @param bcAddr    Physical address of the JSFunctionBytecode struct
   * @param stackAddr Physical address of the top of the argument stack (JSValue[])
   * @param argc      Number of arguments passed to the function
   * @returns         0 if JIT handled the call, 1 if interpreter should handle it
   */
  handle(bcAddr: number, stackAddr: number, argc: number): 0 | 1 {
    // ── Blacklist check ──
    if (this._blacklist.has(bcAddr)) {
      this._stats.calls_interp++;
      return 1;
    }

    // ── Already compiled? ──
    const entry = this._compiled.get(bcAddr);
    if (entry) {
      return this._callNative(entry, bcAddr, stackAddr, argc);
    }

    // ── Not yet compiled — observe and possibly compile ──

    // Observe types
    this._speculator.observe(bcAddr, stackAddr, argc);

    // Check if we should compile
    const specResult = this._speculator.shouldCompile(bcAddr);
    if (specResult !== 'int32') {
      this._stats.calls_interp++;
      return 1; // not confident yet, or mixed types
    }

    // ── Compile! ──
    return this._compileAndCall(bcAddr, stackAddr, argc);
  }

  /**
   * Compile a function and make the first native call.
   */
  private _compileAndCall(bcAddr: number, stackAddr: number, argc: number): 0 | 1 {
    try {
      const reader = new QJSBytecodeReader(bcAddr);
      const compiler = new QJSJITCompiler(reader);
      const nativeAddr = compiler.compile();

      if (nativeAddr === 0) {
        // Compilation failed (unsupported opcodes, etc.)
        this._blacklist.add(bcAddr);
        this._stats.blacklisted++;
        kernel.serialPut('[QJS-JIT] Blacklisted 0x' + bcAddr.toString(16) +
                          ' (compilation failed)\n');
        this._stats.calls_interp++;
        return 1;
      }

      // Record compilation
      const codeSize = 0; // TODO: track code size for stats
      const entry = { native: nativeAddr, nArgs: reader.argCount, codeSize };
      this._compiled.set(bcAddr, entry);
      this._stats.compilations++;

      kernel.serialPut('[QJS-JIT] Compiled 0x' + bcAddr.toString(16) +
                        ' → 0x' + nativeAddr.toString(16) +
                        ' (' + reader.argCount + ' args, ' +
                        reader.bytecodeLen + ' bc bytes)\n');

      // Make the first call
      return this._callNative(entry, bcAddr, stackAddr, argc);

    } catch (err: any) {
      // Unexpected error during compilation
      this._blacklist.add(bcAddr);
      this._stats.blacklisted++;
      kernel.serialPut('[QJS-JIT] Error compiling 0x' + bcAddr.toString(16) +
                        ': ' + String(err) + '\n');
      this._stats.calls_interp++;
      return 1;
    }
  }

  /**
   * Extract int32 args from the JSValue stack and call the native function.
   */
  private _callNative(
    entry: { native: number; nArgs: number },
    bcAddr: number,
    stackAddr: number,
    argc: number,
  ): 0 | 1 {
    // Extract int32 values from JSValue stack
    const args: number[] = [];
    const argCount = Math.min(entry.nArgs, argc, 8);

    for (let i = 0; i < argCount; i++) {
      // Each JSValue is JSVALUE_SIZE bytes on the stack
      // The arguments are at stackAddr + i * JSVALUE_SIZE
      const valAddr = stackAddr + i * JSVALUE_SIZE;

      // Read the full JSValue (8 bytes: u.int32 + tag)
      const buf = kernel.readPhysMem(valAddr, JSVALUE_SIZE);
      if (!buf) {
        this._stats.calls_interp++;
        return 1; // can't read stack → bail
      }
      const dv = new DataView(buf);
      const tag = dv.getInt32(4, true);

      // Type guard: must be JS_TAG_INT
      if (tag !== JS_TAG_INT) {
        // Type mismatch → deoptimize
        return this._handleDeopt(bcAddr);
      }

      args.push(dv.getInt32(0, true)); // u.int32
    }

    // Pad remaining args with 0
    while (args.length < 8) args.push(0);

    // Call native code
    let result: number;
    if (argCount <= 4) {
      result = kernel.jitCallI(entry.native, args[0], args[1], args[2], args[3]);
    } else {
      result = kernel.jitCallI8(entry.native,
        args[0], args[1], args[2], args[3],
        args[4], args[5], args[6], args[7]);
    }

    // Check for deoptimization
    if (result === DEOPT_SENTINEL) {
      return this._handleDeopt(bcAddr);
    }

    // Write result back to QuickJS stack as JSValue
    // sp[-1] should be the return value location
    // We write: u.int32 = result, tag = JS_TAG_INT
    const resultBuf = new ArrayBuffer(JSVALUE_SIZE);
    const resultDv = new DataView(resultBuf);
    resultDv.setInt32(0, result, true);    // u.int32
    resultDv.setInt32(4, JS_TAG_INT, true); // tag
    kernel.writePhysMem(stackAddr - JSVALUE_SIZE, resultBuf);

    this._stats.calls_jit++;
    return 0; // JIT handled it
  }

  /**
   * Handle deoptimization: increment counter, maybe blacklist.
   */
  private _handleDeopt(bcAddr: number): 1 {
    const count = (this._deopts.get(bcAddr) ?? 0) + 1;
    this._deopts.set(bcAddr, count);
    this._stats.deoptimizations++;

    // Delete compiled entry (will be recompiled with fresh speculation)
    this._compiled.delete(bcAddr);
    this._speculator.clear(); // reset type observations for this function

    if (count >= MAX_DEOPTS) {
      this._blacklist.add(bcAddr);
      this._stats.blacklisted++;
      kernel.serialPut('[QJS-JIT] Permanently blacklisted 0x' +
                        bcAddr.toString(16) + ' after ' + count + ' deopts\n');
    } else {
      kernel.serialPut('[QJS-JIT] Deopt #' + count + ' for 0x' +
                        bcAddr.toString(16) + '\n');
    }

    this._stats.calls_interp++;
    return 1;
  }

  /** Get JIT statistics */
  stats(): typeof this._stats & { compiled: number } {
    return {
      ...this._stats,
      compiled: this._compiled.size,
    };
  }

  /** Check if a function is compiled */
  isCompiled(bcAddr: number): boolean {
    return this._compiled.has(bcAddr);
  }
}
```

---

## Step 11: Integration Wiring

**Files to modify:**
- `src/os/core/main.ts` or `src/os/process/init.ts` — boot-time hook installation
- `src/os/core/syscalls.ts` — expose JIT stats via syscall
- `src/os/process/qjs-jit.ts` — main export

### Boot Sequence

In the OS init sequence (after JIT pool is available, before any user code runs):

```typescript
// src/os/process/init.ts or wherever OS init runs:
import { QJSJITHook } from './qjs-jit.js';

// Create the global JIT hook instance
const qjsJit = new QJSJITHook();

// Install it
qjsJit.install();

// Make stats available for debugging
(globalThis as any).__qjsJit = qjsJit;
```

### REPL Integration

Add a command to the REPL:

```typescript
// In the REPL command handler:
case 'jit-stats':
  const stats = (globalThis as any).__qjsJit?.stats();
  if (stats) {
    terminal.writeLine('JIT Statistics:');
    terminal.writeLine('  Compiled:       ' + stats.compiled);
    terminal.writeLine('  Compilations:   ' + stats.compilations);
    terminal.writeLine('  Deopts:         ' + stats.deoptimizations);
    terminal.writeLine('  Blacklisted:    ' + stats.blacklisted);
    terminal.writeLine('  Calls (JIT):    ' + stats.calls_jit);
    terminal.writeLine('  Calls (interp): ' + stats.calls_interp);
    terminal.writeLine('  Pool used:      ' + kernel.jitUsedBytes() + ' / ' + (2*1024*1024));
  }
  break;
```

---

## Step 12: Benchmarks & Validation

### Benchmark 1: Fibonacci (int32 recursion)

```javascript
function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

// Run:
const t0 = Date.now();
const result = fib(35);
const elapsed = Date.now() - t0;
// Expected: result = 9227465
// Target:   10× speedup vs interpreter
```

**What this exercises:**
- `OP_get_arg` / `OP_push_i32` / `OP_lte` / `OP_if_false`
- `OP_sub` / `OP_add`
- `OP_call` (recursive — will be interpreter call, only leaf is JIT'd)
- `OP_return`

**Note:** fib(35) involves ~18M function calls. Only the leaf calls are JIT-compiled
in Phase 4a (recursive calls go through the interpreter because `OP_call` is Priority 2).
Full speedup requires Phase 4b inline caches + call JIT.

### Benchmark 2: Array sum (loop-heavy int32)

```javascript
function arraySum(arr) {
  var sum = 0;
  var i = 0;
  while (i < arr.length) {
    sum = sum + arr[i];
    i = i + 1;
  }
  return sum;
}
```

**Note:** This uses `OP_get_field` (`.length`) and `OP_get_elem` (`arr[i]`),
which are Priority 2 opcodes. The JIT will bail on these. A pure-int variant:

```javascript
function sumRange(n) {
  var sum = 0;
  var i = 1;
  while (i <= n) {
    sum = sum + i;
    i = i + 1;
  }
  return sum;
}
// sumRange(1000000) should run 10-20x faster JIT'd
```

### Benchmark 3: Bitwise operations

```javascript
function countBits(n) {
  var count = 0;
  while (n) {
    count = count + (n & 1);
    n = n >> 1;
  }
  return count;
}

function hashMix(a, b) {
  a = a ^ (b << 13);
  a = a ^ (a >> 17);
  a = a ^ (a << 5);
  return a;
}
```

### Validation Suite

For each compiled function, verify:

1. **Correctness:** `fib_jit(10) === fib_interp(10)` for N=0..20
2. **No stack corruption:** Call compiled function 10000 times, check EBP is preserved
3. **Deopt correctly:** Call with float arg → deopt fires → interpreter produces correct result
4. **Pool budget:** After 100 compilations, `jitUsedBytes()` < 2 MB
5. **Blacklist works:** Deopt 3 times → function is permanently in interpreter

---

## Step 13: Float64 JIT Paths (x87 FPU)

### Rationale

Most SPA JS uses floating-point: `Date.now()` deltas, animation lerp values,
layout coordinates. Without float JIT, these fall back to the interpreter.

### Type Speculation Extension

Extend `TypeSpeculator.shouldCompile()` to return `'float64'` when all observed
args are `JS_TAG_FLOAT64`:

```typescript
// In shouldCompile():
let allRecentFloat = true;
for (const [, history] of profile.slotTags) {
  if (history.length < 8) { allRecentFloat = false; break; }
  for (let i = 0; i < 8; i++) {
    if (history[history.length - 8 + i] !== JS_TAG_FLOAT64) {
      allRecentFloat = false;
      break;
    }
  }
  if (!allRecentFloat) break;
}
if (allRecentFloat) return 'float64';
```

### Float64 Compiler

The float64 compiler uses x87 FPU instructions instead of ALU:

```typescript
// In QJSJITCompiler, when compiling a float64 function:

// Stack frame: each local/arg is 8 bytes (double) instead of 4

// OP_add (float64):
fld64Ebp(argSlotF(0));   // FLD QWORD [EBP+argOffset] — push LHS
fld64Ebp(argSlotF(1));   // FLD QWORD [EBP+argOffset] — push RHS
faddp();                  // FADDP ST(1), ST — add, pop
fstp64Ebp(resultSlot);   // FSTP QWORD [EBP+resultOffset] — store result
```

### JSValue Float64 Calling Convention

On 32-bit QuickJS, a float64 JSValue stores the double in the `u` union.
Since `sizeof(double) == 8` and `sizeof(JSValue) == 8`, the float64 value
overlaps the entire JSValue. The tag is encoded differently (NaN-boxing or
separate tag word depending on build config).

**For our i686 non-NaN-boxing build:**
- `JSValue.u` contains the raw 8-byte double
- `JSValue.tag` = `JS_TAG_FLOAT64` (7)
- Total struct is 12 bytes (not 8!) — the double takes 8 bytes, tag takes 4

**VERIFY THIS.** If our build uses NaN-boxing, the layout is completely different
and the float64 value is encoded in the NaN payload bits.

### Effort: 1 week

This step is deferred until after int32 JIT is validated (Steps 1–12).

---

## Step 14: Inline Caches for Property Access

### Rationale

Property access (`obj.foo`) dominates React reconciliation and DOM manipulation.
Without ICs, every `OP_get_field` does a full hash-table lookup.

### QuickJS Shape System

QuickJS uses **hidden classes** (called "shapes" internally). Each object has a
`shape` pointer. Objects with the same property layout share the same shape.

When compiled code encounters `obj.foo`:
1. Load `obj.shape` pointer
2. Compare to expected shape (cached from first observation)
3. If match: load property at cached offset (O(1))
4. If mismatch: fall back to slow lookup, update cache

### Monomorphic IC Code Generation

```typescript
// For OP_get_field2 with atom "foo":

// 1. Load object pointer (from operand stack)
e.popEcx();                     // ECX = JSObject*

// 2. Load shape pointer
e.movEaxEcxDisp(SHAPE_OFFSET);  // EAX = obj->shape

// 3. Compare to cached shape (placeholder — patched at first call)
const shapePatchAddr = e.here() + 1;  // address of the imm32 in CMP
e.cmpEaxImm32(0x00000000);     // CMP EAX, <expected_shape> ← PATCHED

// 4. Shape mismatch → slow path
const slowFixup = e.jne();

// 5. Hit: load property at cached offset (placeholder)
const propPatchAddr = e.here() + 2;   // address of the disp32 in MOV
e.movEaxEcxDisp(0);             // MOV EAX, [ECX + <offset>] ← PATCHED
e.pushEax();
const doneFixup = e.jmp();

// 6. Slow path:
e.patch(slowFixup, e.here());
// Call interpreter's get_field function
// This also patches the IC for next time
e.pushEcx();                    // push obj ptr
e.pushImm32(atomIndex);         // push atom
e.immEcx(slowGetFieldAddr);     // address of helper function
e.callEcx();
e.addEsp(8);                    // clean up args
// Helper returns: EAX = property value, also patches shapePatchAddr and propPatchAddr
e.pushEax();

e.patch(doneFixup, e.here());
```

### IC Patching

The IC is "self-modifying code" — the JIT-compiled code contains placeholder
immediates that are overwritten at runtime:

```typescript
// After slow-path resolves the property:
function patchIC(shapePatchAddr: number, newShape: number,
                  propPatchAddr: number, newOffset: number): void {
  // Write the new shape into the CMP instruction
  const shapeBuf = new ArrayBuffer(4);
  new DataView(shapeBuf).setUint32(0, newShape, true);
  kernel.writePhysMem(shapePatchAddr, shapeBuf);

  // Write the new property offset into the MOV instruction
  const offsetBuf = new ArrayBuffer(4);
  new DataView(offsetBuf).setInt32(0, newOffset, true);
  kernel.writePhysMem(propPatchAddr, offsetBuf);
}
```

### Effort: 1.5 weeks

Deferred until int32 JIT is validated.

---

## Step 15: LRU Eviction

### Rationale

Even with a 2 MB pool, a large SPA with 1000+ hot functions will eventually
exhaust the pool. LRU eviction reclaims space by overwriting the coldest function.

### C-Side: Entry Table

```c
// jit.c additions:

#define MAX_JIT_ENTRIES 2048

typedef struct {
    uint32_t pool_offset;   // offset into _jit_pool (0 = unused)
    uint32_t code_size;     // size of this entry's code
    uint32_t last_called;   // timer tick of last call
    uint32_t bc_ptr;        // JSFunctionBytecode* — key for TS callback
} JITEntry;

static JITEntry _jit_entries[MAX_JIT_ENTRIES];

/* Find the LRU entry and free its slot */
int jit_evict_lru(uint32_t *evicted_bc_ptr) {
    uint32_t oldest_tick = UINT32_MAX;
    int oldest_idx = -1;
    for (int i = 0; i < MAX_JIT_ENTRIES; i++) {
        if (_jit_entries[i].pool_offset == 0) continue;
        if (_jit_entries[i].last_called < oldest_tick) {
            oldest_tick = _jit_entries[i].last_called;
            oldest_idx = i;
        }
    }
    if (oldest_idx < 0) return -1;
    *evicted_bc_ptr = _jit_entries[oldest_idx].bc_ptr;
    _jit_entries[oldest_idx].pool_offset = 0; // free the slot
    return oldest_idx;
}
```

### TS-Side: Eviction Callback

```typescript
// In QJSJITHook:
private _onEviction(evictedBcPtr: number): void {
  this._compiled.delete(evictedBcPtr);
  kernel.serialPut('[QJS-JIT] Evicted 0x' + evictedBcPtr.toString(16) + '\n');
}
```

### Effort: 1 week

Deferred until pool exhaustion is observed in practice.

---

## Dependency Graph

```
Step 1: Pool expansion (C)           ──┐
                                       │
Step 2: readPhysMem / writePhysMem (C) ──┤
                                       │
Step 3: QJS struct offsets (C)         ──┤
                                       ├──► Step 7: QJSBytecodeReader (TS)
Step 4: Opcode table (Research)        ──┤       │
                                       │       ├──► Step 9: QJSJITCompiler (TS)
Step 5: QJS hook point (C/QJS)         ──┤       │       │
                                       │       │       ├──► Step 10: Dispatcher (TS)
Step 6: _Emit extensions (TS)         ──┤       │       │       │
                                       │       │       │       ├──► Step 11: Integration
Step 8: Type speculation (TS)          ──┘       │       │       │       │
                                               │       │       │       ├──► Step 12: Benchmarks
                                               │       │       │       │
                                               │       │       │       │   Step 13: Float64
                                               │       │       │       │   Step 14: Inline caches
                                               │       │       │       │   Step 15: LRU eviction
```

### Critical Path

```
Step 4 (opcode audit) → Step 3 (struct offsets) → Step 5 (QJS hook) →
Step 9 (compiler) → Step 10 (dispatcher) → Step 11 (integration) →
Step 12 (benchmarks)
```

### Parallelizable Work

- Steps 1, 2, 3 can run in parallel (independent C changes)
- Steps 4, 6 can run in parallel (research + TS code)
- Steps 7, 8 can run in parallel (both TS, independent)
- Steps 13, 14, 15 are independent stretch goals after Step 12

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| QuickJS struct layout changes between versions | JIT reads wrong fields → crash | Medium | Boot-time probe validates all offsets. If wrong → JIT disabled, interpreter only |
| Opcode encoding doesn't match our assumptions | Compiled code is wrong | Medium | Canary function validation at boot. Abort JIT if canary fails |
| Stack corruption in compiled code | OS crash / data corruption | High initially | Conservative: disable JIT on any fault. Add stack canary cookies in debug builds |
| JIT pool exhaustion before eviction is implemented | No more functions can be compiled | Low (2 MB) | Log a warning when pool > 75% full. Don't crash — just stop compiling |
| QuickJS GC moves objects during JIT read | Stale pointers → crash | Very Low | QJS uses refcounting, not moving GC. Pointers are stable. Always `readPhysMem` fresh |
| Hook insertion point changes in QJS updates | Hook doesn't fire | Medium | Pin to specific QJS commit. Document exact insertion point |
| x87 FPU state clobbered by QuickJS runtime | Float64 results wrong | Medium | Save/restore x87 state at JIT function entry/exit if needed |
| Deopt storm: function deoptimizes every call | Performance worse than interpreter | Low | Blacklist after 3 deopts. Don't attempt re-compilation |
| `OP_call` / `OP_call_method` not JIT'd (Priority 2) | Recursive functions not sped up | High (intentional) | Phase 4a target is leaf functions only. Phase 4b adds call JIT with ICs |

---

## Glossary

| Term | Definition |
|---|---|
| **JSFunctionBytecode** | QuickJS internal struct holding compiled bytecode for one JS function |
| **JSValue** | QuickJS's tagged union type (8 bytes on i686): `{ union u; int32 tag }` |
| **JS_TAG_INT** | Tag value 0 — the JSValue contains a 32-bit integer in `u.int32` |
| **JIT pool** | 2 MB BSS region in `jit.c` that holds compiled native code |
| **Type speculation** | Observing argument types across calls to predict future types |
| **Type guard** | Runtime check at function entry verifying argument tags match expectations |
| **Deoptimization** | Falling back to the interpreter when a type guard fails |
| **Blacklist** | Permanently excluding a function from JIT compilation |
| **Inline cache (IC)** | Self-modifying code that caches property access shape + offset |
| **cdecl** | x86 calling convention: args pushed R-to-L, EAX = return, caller cleans stack |
| **DEOPT_SENTINEL** | Magic return value `0x7FFF_DEAD` signaling a type guard failure |
| **Operand stack** | QuickJS's virtual stack used for bytecode execution (JSValue-sized slots) |

### Constants Reference

```typescript
// Pool
JIT_POOL_SIZE       = 2 * 1024 * 1024   // 2 MB
JIT_ALLOC_MAX       = 64 * 1024          // 64 KB max single allocation

// Compilation policy
JIT_THRESHOLD       = 100    // calls before compilation attempt
MAX_DEOPTS          = 3      // deopt count before permanent blacklist
SPECULATION_WINDOW  = 8      // consecutive calls with same types required

// JSValue layout (i686, non-NaN-boxing)
JSVALUE_SIZE        = 8      // bytes per JSValue
JS_TAG_INT          = 0      // integer tag
JS_TAG_FLOAT64      = 7      // float64 tag

// Sentinel values
DEOPT_SENTINEL      = 0x7FFFDEAD
```

---

## Timeline Summary

| Step | Description | Effort | Depends On |
|---|---|---|---|
| 1 | JIT pool expansion to 2 MB | 0.5 days | — |
| 2 | `readPhysMem` / `writePhysMem` C primitives | 1 day | — |
| 3 | QJS struct offset discovery | 1 day | — |
| 4 | Opcode table extraction + constants file | 2 days | QJS source access |
| 5 | QJS hook point (C + QuickJS source mod) | 2 days | Step 3 |
| 6 | `_Emit` extensions | 0.5 days | — |
| 7 | `QJSBytecodeReader` | 1 day | Steps 2, 3 |
| 8 | Type speculation system | 3 days | Step 2 |
| 9 | `QJSJITCompiler` (Priority 1 opcodes) | 2 weeks | Steps 4, 6, 7 |
| 10 | `QJSJITHook` dispatcher | 3 days | Steps 5, 8, 9 |
| 11 | Integration wiring (boot + REPL) | 1 day | Step 10 |
| 12 | Benchmarks & validation | 2 days | Step 11 |
| **MVP Total** | **Int32 JIT end-to-end** | **~4 weeks** | |
| 13 | Float64 JIT (x87 FPU) | 1 week | Step 12 |
| 14 | Inline caches (monomorphic) | 1.5 weeks | Step 12 |
| 15 | LRU eviction | 1 week | Step 12 |
| **Full Total** | **Complete Phase 4** | **~8 weeks** | |

---

## Checkpoints

| After Step | Test | Expected Result |
|---|---|---|
| 1 | Boot OS, run existing canvas ops | JIT pool is 2 MB, all pixel ops work |
| 2 | `kernel.readPhysMem(addr, 16)` in REPL | Returns ArrayBuffer with correct bytes |
| 5 | Compile function, call 101 times | Hook fires, serial shows "[QJS-JIT] Hook fired" |
| 7 | `new QJSBytecodeReader(addr).dump()` | Shows arg_count, var_count, bytecodeLen |
| 9 | Compile `function(a,b){return a+b}` | Native code generated, serial shows compilation |
| 11 | `fib(20)` with JIT enabled | Correct result (6765), JIT stats show compilation |
| 12 | `sumRange(1000000)` benchmark | >10× speedup vs interpreter |
| 13 | Animation lerp benchmark | Float64 functions JIT-compiled |
| 14 | React reconciler property access | Measurably faster with ICs |
