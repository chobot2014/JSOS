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
| C JIT pool (256 KB BSS → 12 MB) | `src/kernel/jit.c` | `jit_alloc()` bump allocator, `jit_write()` memcpy, `jit_call_i4/i8()` trampolines |
| C JIT header | `src/kernel/jit.h` | Public C API: `jit_alloc`, `jit_write`, `jit_call_i4`, `jit_call_i8`, `jit_used_bytes` |
| Kernel bindings (JS→C) | `src/kernel/quickjs_binding.c:1486–1600` | `js_jit_alloc`, `js_jit_write`, `js_jit_call_i`, `js_jit_call_i8`, `js_physaddr_of` |
| TypeScript kernel types | `src/os/core/kernel.ts` | Full `KernelAPI` interface with JIT method signatures |

### What We Must Build

| Component | File(s) | Description |
|---|---|---|
| Pool expansion to 12 MB | `src/kernel/jit.c` | Change `JIT_POOL_SIZE` / partition constants |
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
page. 8 MB for the main runtime holds thousands of compiled functions before
LRU eviction (Step 15) is needed; 512 KB per child slot handles a full game
engine or physics sim with 200+ hot functions and room to spare.

### Exact Changes

**`src/kernel/jit.c`:**

The pool is expanded to **12 MB** and **partitioned** so child runtimes each get
a fixed region that can be instantly reclaimed on `procDestroy`:

```
 _jit_pool (12 MB BSS)
 ├── [0 .. 8 MB)           Main runtime  — OS kernel, apps, browser page JS
 ├── [8MB .. 8MB+512KB)    Child slot 0
 ├── [8MB+512KB .. +1MB)   Child slot 1
 │   …
 └── [8MB+7×512KB .. 12MB)  Child slot 7

 Pool sizing rationale:
   Main (8 MB): never freed; OS runs indefinitely. 200+ hot functions at
   ~500–2000 bytes each = several MB before LRU eviction kicks in.
   Per-child (512 KB): a game engine or physics sim has 200+ hot functions.
   At ~200–500 bytes/function that is ~100 KB; 512 KB gives 5× headroom.
   Physical RAM: both test scripts run QEMU at `-m 4G` (4 GB); there is no
   meaningful RAM constraint. BSS + QuickJS heaps total well under 256 MB
   (see BSS budget below). The 12 MB JIT pool is sized for coverage, not RAM.
```

```c
/* ── Pool layout ─────────────────────────────────────────────────────────── */
#define JIT_POOL_SIZE     (12u * 1024u * 1024u)  /* 12 MB total             */
#define JIT_MAIN_SIZE     (8u  * 1024u * 1024u)  /* 8 MB for main runtime   */
#define JIT_PROC_SLOTS    8u
#define JIT_PROC_SIZE     (512u * 1024u)          /* 512 KB per child proc   */

/* Sanity: main + all child slots must fit in pool */
_Static_assert(JIT_MAIN_SIZE + JIT_PROC_SLOTS * JIT_PROC_SIZE == JIT_POOL_SIZE,
               "JIT pool partition sizes do not add up");

static uint8_t  __attribute__((aligned(16))) _jit_pool[JIT_POOL_SIZE];
static uint32_t _jit_main_used = 0;
static uint32_t _jit_proc_used[JIT_PROC_SLOTS];

/* ── Main runtime allocation (unchanged API) ─────────────────────────────── */
void *jit_alloc(size_t size) {
    if (size == 0 || size > JIT_ALLOC_MAX) return NULL;
    size_t aligned = (size + 15u) & ~15u;
    if (_jit_main_used + aligned > JIT_MAIN_SIZE) return NULL;
    void *p = (void *)(_jit_pool + _jit_main_used);
    _jit_main_used += (uint32_t)aligned;
    return p;
}

/* ── Child process allocation ────────────────────────────────────────────── */
void *jit_proc_alloc(int id, size_t size) {
    if (id < 0 || (unsigned)id >= JIT_PROC_SLOTS) return NULL;
    if (size == 0 || size > JIT_ALLOC_MAX) return NULL;
    size_t aligned = (size + 15u) & ~15u;
    if (_jit_proc_used[id] + aligned > JIT_PROC_SIZE) return NULL;
    uint32_t base = JIT_MAIN_SIZE + (uint32_t)id * JIT_PROC_SIZE;
    void *p = (void *)(_jit_pool + base + _jit_proc_used[id]);
    _jit_proc_used[id] += (uint32_t)aligned;
    return p;
}

/* ── Child process pool reclaim (called by procDestroy) ──────────────────── */
/* O(1): just reset the write pointer. No fragmentation, no free list needed. */
void jit_proc_reset(int id) {
    if (id >= 0 && (unsigned)id < JIT_PROC_SLOTS)
        _jit_proc_used[id] = 0;
}

uint32_t jit_used_bytes(void)      { return _jit_main_used; }
uint32_t jit_proc_used_bytes(int id) {
    if (id < 0 || (unsigned)id >= JIT_PROC_SLOTS) return 0;
    return _jit_proc_used[id];
}
```

**`src/kernel/jit.h`:** Add declarations for the new functions:

```c
/* Per-child-process JIT allocation and reclaim */
void    *jit_proc_alloc(int proc_id, size_t size);
void     jit_proc_reset(int proc_id);          /* call from procDestroy    */
uint32_t jit_proc_used_bytes(int proc_id);     /* diagnostic               */
```

`JIT_ALLOC_MAX` (64 KB per allocation) stays the same — a single function
is never larger than 64 KB.

### Verify: BSS Budget

Current BSS occupants (after Step 1 lands):

| Array | Source | Size |
|---|---|---|
| `stack` (boot.s) | boot.s | 32 KB |
| `memory_pool[1MB]` | memory.c | 1 MB (dead — `memory_initialize()` called but `memory_allocate()` never called) |
| `ata_sector_buf[256×8]` uint16_t | quickjs_binding.c | 4 KB |
| `paging_pd[1024]` uint32_t | quickjs_binding.c | 4 KB |
| `_procs[JSPROC_MAX]` JSProc_t | quickjs_binding.c | **~256 KB** (rt+ctx+used 12 B + inbox[8×2052] + 3 ints + outbox[8×2052] + 3 ints = 32,868 B × 8 = 263 KB; the plan formerly said "132 KB" counting only inbox) |
| `_sbufs[8][256KB]` | quickjs_binding.c | 2 MB |
| `fb_blit_buf[1024×768]` uint32_t | quickjs_binding.c | 3 MB |
| `_asm_buf[4096]` (static local) | quickjs_binding.c | 4 KB |
| `_user_pds[32][1024]` uint32_t | quickjs_binding.c | 128 KB |
| `_net_recv_buf[1514]` + `_net_send_buf[1514]` | quickjs_binding.c | ~3 KB |
| `_es[2056]` + `_rs[2056]` (static locals) | quickjs_binding.c | ~4 KB |
| `_jit_write_buf[JIT_ALLOC_MAX]` (static local) | quickjs_binding.c line 1498 | 64 KB — slow-path buffer for `kernel.jitWrite(addr, number[])` |
| `rx_bufs[256][2048]` + `tx_bufs[256][2048]` | virtio_net.c | 1 MB each = **1 MB** total |
| `_jit_pool[256KB]` → **`_jit_pool[12MB]`** after Step 1 | jit.c | **12 MB** |
| **Total BSS after Step 1** | | **~19.5 MB** |

Derivation: 0.032 + 1 + 0.004 + 0.004 + 0.256 + 2 + 3 + 0.004 + 0.128 + 0.003 + 0.004 + 0.064 + 1 + 12 = **19.503 MB**

> **Note on `_jit_write_buf`:** This is the slow-path staging buffer for the
> *existing* `kernel.jitWrite(addr, number[])` binding — it is not replaced by
> `writePhysMem`. The fast path (ArrayBuffer argument) bypasses it entirely.
> It already lives in BSS; Step 1 does not add it.

> **Note on `memory_pool`:** `memory.c`'s 1 MB pool is zeroed at boot by
> `memory_initialize()` but `memory_allocate()` is never called anywhere.
> It is dead BSS weight. It counts in the physical address map but does not
> affect correctness.

No additional C-side staging buffer needs to be added. The TypeScript `_Emit`
class assembles machine code into a JS ArrayBuffer (QuickJS heap), then
`kernel.writePhysMem(addr, buf)` `memcpy`s it directly into the `_jit_pool`
slot. BSS is stable at **~19.5 MB** through all remaining JIT steps.

> **Cross-reference:** `before_jit_os_updates.md` adds BSS ~43.7 MB more before the JIT lands.
> Child heaps: up to **1 GB** each (32-bit i686 ceiling); stack: 256 KB; heap window: **2 GB NOLOAD**.
> Real peak (browser + 1-2 light children): ~1-1.3 GB. Heap window covers this with room to spare.
> `_heap_start` ≈ 46.7 MB; `_heap_end` ≈ 2.05 GB;
> `KERNEL_END_FRAME` = 655,360 frames = **2.5 GB** — ~450 MB above `_heap_end`.
> physAlloc returns 2.5 GB – ~3 GB = ~512 MB user page frames (3 GB is the
> 32-bit physical RAM ceiling with 4 GB QEMU; top 1 GB is MMIO/PCI).

The 256 MB heap region starts at `_heap_start` in `linker.ld`, well above BSS.
With QEMU at 4 GB there is no address-space concern.
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
poolTotal: 12 * 1024 * 1024,
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

### JSFunctionBytecode Struct Layout (VERIFIED)

QuickJS's `JSFunctionBytecode` (defined in `quickjs.c` lines 620–659) with
**verified offsets** extracted via `offsetof()` on our i686-elf-gcc cross-compiler:

```c
typedef struct JSFunctionBytecode {
    JSGCObjectHeader header;          // offset 0, sizeof=16 (0x10)
    uint8_t js_mode;                  // offset 16
    uint8_t has_prototype : 1;        // bitfields in byte 17
    uint8_t has_simple_parameter_list : 1;
    uint8_t is_derived_class_constructor : 1;
    uint8_t need_home_object : 1;
    uint8_t func_kind : 2;
    uint8_t new_target_allowed : 1;
    uint8_t super_call_allowed : 1;
    uint8_t super_allowed : 1;        // bitfields in byte 18
    uint8_t arguments_allowed : 1;
    uint8_t has_debug : 1;
    uint8_t read_only_bytecode : 1;
    uint8_t is_direct_or_indirect_eval : 1;
    uint8_t *byte_code_buf;           // offset 20 (0x14) — THE BYTECODE POINTER
    int byte_code_len;                // offset 24 (0x18)
    JSAtom func_name;                 // offset 28 (0x1C)
    JSBytecodeVarDef *vardefs;        // offset 32 (0x20)
    JSClosureVar *closure_var;        // offset 36 (0x24)
    uint16_t arg_count;               // offset 40 (0x28)
    uint16_t var_count;               // offset 42 (0x2A)
    uint16_t defined_arg_count;       // offset 44 (0x2C)
    uint16_t stack_size;              // offset 46 (0x2E)
    uint16_t var_ref_count;           // offset 48
    JSContext *realm;                 // offset 52 (0x34)
    JSValue *cpool;                   // offset 56 (0x38) — constant pool pointer
    int cpool_count;                  // offset 60 (0x3C)
    int closure_var_count;            // offset 64
    struct {                          // offset 68 (0x44)
        JSAtom filename;
        int source_len;
        int pc2line_len;
        uint8_t *pc2line_buf;
        char *source;
    } debug;
} JSFunctionBytecode;                 // sizeof = 88 (0x58)
```

**Also verified:**
- `sizeof(JSGCObjectHeader)` = **16** (0x10)
- `sizeof(JSObject)` = **40** (0x28)
- `offsetof(JSObject, shape)` = **20** (0x14)

### Offset Summary Table (VERIFIED — do not guess)

| Field            | Offset (dec) | Offset (hex) | Type       |
|------------------|-------------|-------------|------------|
| byte_code_buf    | 20          | 0x14        | uint8_t*   |
| byte_code_len    | 24          | 0x18        | int32_t    |
| func_name        | 28          | 0x1C        | JSAtom     |
| vardefs          | 32          | 0x20        | ptr        |
| closure_var      | 36          | 0x24        | ptr        |
| arg_count        | 40          | 0x28        | uint16_t   |
| var_count        | 42          | 0x2A        | uint16_t   |
| defined_arg_count| 44          | 0x2C        | uint16_t   |
| stack_size       | 46          | 0x2E        | uint16_t   |
| realm            | 52          | 0x34        | JSContext*  |
| cpool            | 56          | 0x38        | JSValue*   |
| cpool_count      | 60          | 0x3C        | int32_t    |
| debug            | 68          | 0x44        | struct     |

> **Extraction method:** Compiled `probe-offsets.c` appended to `quickjs.c` inside
> the `jsos-builder` docker container using `i686-elf-gcc -m32 -ffreestanding -O2`.
> Values read via `i686-elf-objdump -s -j .rodata` from the resulting `.o` file.

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

**Strategy A — `offsetof` (VERIFIED — use this):**

Since `JSFunctionBytecode` is defined inside `quickjs.c` (not exported in
`quickjs.h`), and our `quickjs_binding.c` is compiled separately, we **cannot**
use `offsetof()` at compile time in `quickjs_binding.c`. However, because we have
extracted the exact offsets from our pinned QuickJS version, we hardcode them
with a boot-time validation probe.

```c
#include <stddef.h>

/* Verified offsets for our QuickJS build (bellard/quickjs HEAD, i686-elf-gcc).
 * Extracted via probe-offsets.c + i686-elf-objdump.
 * MUST be re-verified if QuickJS is updated. */
static JSValue js_qjs_offsets(JSContext *c, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "bcBuf",      JS_NewInt32(c, 20));  /* 0x14 */
    JS_SetPropertyStr(c, obj, "bcLen",      JS_NewInt32(c, 24));  /* 0x18 */
    JS_SetPropertyStr(c, obj, "funcName",   JS_NewInt32(c, 28));  /* 0x1C */
    JS_SetPropertyStr(c, obj, "argCount",   JS_NewInt32(c, 40));  /* 0x28 */
    JS_SetPropertyStr(c, obj, "varCount",   JS_NewInt32(c, 42));  /* 0x2A */
    JS_SetPropertyStr(c, obj, "stackSize",  JS_NewInt32(c, 46));  /* 0x2E */
    JS_SetPropertyStr(c, obj, "cpoolPtr",   JS_NewInt32(c, 56));  /* 0x38 */
    JS_SetPropertyStr(c, obj, "cpoolCount", JS_NewInt32(c, 60));  /* 0x3C */
    JS_SetPropertyStr(c, obj, "realm",      JS_NewInt32(c, 52));  /* 0x34 */
    JS_SetPropertyStr(c, obj, "debug",      JS_NewInt32(c, 68));  /* 0x44 */
    JS_SetPropertyStr(c, obj, "structSize", JS_NewInt32(c, 88));  /* 0x58 */
    /* JSObject layout (for inline caches) */
    JS_SetPropertyStr(c, obj, "objShape",   JS_NewInt32(c, 20));  /* 0x14 */
    JS_SetPropertyStr(c, obj, "objSize",    JS_NewInt32(c, 40));  /* 0x28 */
    JS_SetPropertyStr(c, obj, "gcHeaderSize", JS_NewInt32(c, 16)); /* 0x10 */
    return obj;
}
```

**Boot-time validation probe (to verify offsets haven't shifted):**

```c
/*
 * Called once during quickjs_initialize().
 * Compiles a canary function: function _probe(a,b) { return a + b; }
 * Then reads arg_count at the known offset and verifies it equals 2.
 * If mismatch → disable JIT and log an error.
 */
static void _validate_qjs_offsets(JSContext *ctx) {
    const char *probe_src = "function _probe(a,b) { return a + b; }; _probe";
    JSValue fn = JS_Eval(ctx, probe_src, strlen(probe_src), "<probe>", JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return; }

    JSObject *obj = JS_VALUE_GET_OBJ(fn);
    JSFunctionBytecode *b = obj->u.func.function_bytecode;
    uint8_t *raw = (uint8_t *)b;

    /* Verify arg_count at offset 40 (0x28) == 2 */
    uint16_t arg_count = *(uint16_t *)(raw + 40);
    if (arg_count != 2) {
        platform_serial_puts("[JIT] WARNING: QJS offset mismatch! arg_count at +40 = ");
        /* ... print value ... */
        platform_serial_puts(" (expected 2). JIT disabled.\n");
    } else {
        platform_serial_puts("[JIT] QJS struct offsets validated OK\n");
    }

    /* Also verify byte_code_buf at offset 20 is a valid pointer */
    uint32_t bc_ptr = *(uint32_t *)(raw + 20);
    if (bc_ptr < 0x100000 || bc_ptr > 0x20000000) {
        platform_serial_puts("[JIT] WARNING: byte_code_buf looks invalid\n");
    }

    JS_FreeValue(ctx, fn);
}
```

**Decision: Use hardcoded offsets (verified) + boot-time validation.**
This avoids header dependency complexity, is self-verifying, and the offsets
are pinned to our exact QuickJS commit.

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
   * Hardcoded from verified probe, validated at boot.
   *
   * Verified values for our QuickJS build:
   *   bcBuf=20, bcLen=24, argCount=40, varCount=42,
   *   cpoolPtr=56, cpoolCount=60, stackSize=46
   */
  qjsOffsets: {
    bcBuf: number;       // offset 20 (0x14) — byte_code_buf pointer
    bcLen: number;       // offset 24 (0x18) — byte_code_len int32
    funcName: number;    // offset 28 (0x1C) — func_name JSAtom
    argCount: number;    // offset 40 (0x28) — arg_count uint16
    varCount: number;    // offset 42 (0x2A) — var_count uint16
    stackSize: number;   // offset 46 (0x2E) — stack_size uint16
    cpoolPtr: number;    // offset 56 (0x38) — cpool pointer
    cpoolCount: number;  // offset 60 (0x3C) — cpool_count int32
    realm: number;       // offset 52 (0x34) — realm JSContext*
    debug: number;       // offset 68 (0x44) — debug struct
    structSize: number;  // 88 (0x58) — sizeof(JSFunctionBytecode)
    objShape: number;    // offset 20 (0x14) in JSObject — shape pointer
    objSize: number;     // 40 (0x28) — sizeof(JSObject)
    gcHeaderSize: number;// 16 (0x10) — sizeof(JSGCObjectHeader)
  };
```

### Alternative: Hardcode with Validation (THIS IS THE CHOSEN APPROACH)

The offsets below are verified against our pinned QuickJS commit via
`probe-offsets.c` compiled with `i686-elf-gcc -m32 -ffreestanding`:

```typescript
// qjs-jit.ts
const QJS_OFFSETS = {
  bcBuf:      20,    // 0x14 — byte_code_buf pointer
  bcLen:      24,    // 0x18 — byte_code_len int32
  funcName:   28,    // 0x1C — func_name JSAtom
  argCount:   40,    // 0x28 — arg_count uint16
  varCount:   42,    // 0x2A — var_count uint16
  stackSize:  46,    // 0x2E — stack_size uint16
  cpoolPtr:   56,    // 0x38 — cpool JSValue*
  cpoolCount: 60,    // 0x3C — cpool_count int32
  realm:      52,    // 0x34 — realm JSContext*
  structSize: 88,    // 0x58 — sizeof(JSFunctionBytecode)
};

// Validate at boot by compiling a probe function:
function validateOffsets(): boolean {
  // Compile "function p(a,b){return a+b}", get its bytecode ptr,
  // read arg_count at offset 40, verify == 2
  // read byte_code_buf at offset 20, verify it's a valid heap pointer
  // read byte_code_len at offset 24, verify > 0 and < 256
}
```

> **Note:** The original plan guessed `bcBuf=52, bcLen=48, argCount=14, varCount=16,
> cpoolPtr=40, cpoolCount=44, stackSize=20`. All were wrong. The verified values
> are significantly different because the struct layout has bitfields, padding,
> and JSGCObjectHeader is 16 bytes (not 8).

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

### The Constants File (ALL VALUES VERIFIED)

Create `src/os/process/qjs-opcodes.ts`:

```typescript
/**
 * qjs-opcodes.ts — QuickJS bytecode opcode constants
 *
 * These values are VERIFIED against our QuickJS build (bellard/quickjs HEAD,
 * copyright 2017-2025) compiled with i686-elf-gcc inside the jsos-builder
 * docker container.
 *
 * Extracted from quickjs-opcode.h via scripts/extract-opcodes.py.
 * Total opcodes: 263 (enum values 0x00–0x106).
 *
 * HOW TO REGENERATE:
 *   docker run --rm -v "${PWD}/scripts:/tmp/scripts" jsos-builder \
 *     python3 /tmp/scripts/extract-opcodes.py
 *
 * VALIDATION:
 *   At boot, qjs-jit.ts compiles a canary function and verifies the
 *   first few opcodes match expected patterns. If they don't, the JIT
 *   disables itself gracefully.
 *
 * OPCODE FORMAT in quickjs-opcode.h:
 *   DEF(name, size, n_pop, n_push, f)
 *   - size:   total instruction bytes (opcode + operands)
 *   - n_pop:  values popped from operand stack
 *   - n_push: values pushed to operand stack
 *   - f:      flags (fmt: none, loc, arg, loc8, label, label_u16, etc.)
 */

// ─── Priority 1: JIT Immediately ─────────────────────────────────────────────
// These cover ~80% of hot SPA integer arithmetic code.

export const OP_invalid           = 0x00;  // size=1

// ── Push / Pop ──
export const OP_push_i32          = 0x01;  // size=5, push 32-bit immediate (4-byte operand)
export const OP_push_const        = 0x02;  // size=5, push constant pool entry (4-byte index)
export const OP_fclosure          = 0x03;  // size=5
export const OP_push_atom_value   = 0x04;  // size=5
export const OP_private_symbol    = 0x05;  // size=5
export const OP_undefined         = 0x06;  // size=1, push undefined
export const OP_null              = 0x07;  // size=1, push null
export const OP_push_this         = 0x08;  // size=1
export const OP_push_false        = 0x09;  // size=1, push false (int 0)
export const OP_push_true         = 0x0A;  // size=1, push true (int 1)

export const OP_object            = 0x0B;  // size=1
export const OP_special_object    = 0x0C;  // size=2
export const OP_rest              = 0x0D;  // size=3
export const OP_drop              = 0x0E;  // size=1, discard TOS
export const OP_nip               = 0x0F;  // size=1
export const OP_nip1              = 0x10;  // size=1
export const OP_dup               = 0x11;  // size=1, duplicate TOS
export const OP_dup2              = 0x12;  // size=1
export const OP_dup3              = 0x13;  // size=1
export const OP_insert2           = 0x14;  // size=1
export const OP_insert3           = 0x15;  // size=1
export const OP_insert4           = 0x16;  // size=1
export const OP_perm3             = 0x17;  // size=1
export const OP_perm4             = 0x18;  // size=1
export const OP_perm5             = 0x19;  // size=1
export const OP_swap              = 0x1A;  // size=1  [NOTE: was 0x1B in prior notes, recheck]
export const OP_swap2             = 0x1B;  // size=1
export const OP_rot3l             = 0x1C;  // size=1
export const OP_rot3r             = 0x1D;  // size=1
export const OP_rot4l             = 0x1E;  // size=1
export const OP_rot5l             = 0x1F;  // size=1

// ── Function calls ──
export const OP_call              = 0x22;  // size=3, fmt=npop, argc operand (2 bytes)
export const OP_tail_call         = 0x23;  // size=3, fmt=npop
export const OP_call_method       = 0x24;  // size=3, fmt=npop
export const OP_tail_call_method  = 0x25;  // size=3, fmt=npop
export const OP_array_from        = 0x26;  // size=3, fmt=npop
export const OP_apply             = 0x27;  // size=3

export const OP_return            = 0x28;  // size=1, return TOS
export const OP_return_undef      = 0x29;  // size=1, return undefined

// ── Variable access (2-byte index, fmt=loc/arg) ──
export const OP_get_loc           = 0x55;  // size=3, fmt=loc, load local (uint16 index)
export const OP_put_loc           = 0x56;  // size=3, fmt=loc, store local
export const OP_set_loc           = 0x57;  // size=3, fmt=loc, set local (no pop)
export const OP_get_arg           = 0x58;  // size=3, fmt=arg, load argument (uint16 index)
export const OP_put_arg           = 0x59;  // size=3, fmt=arg, store argument
export const OP_set_arg           = 0x5A;  // size=3, fmt=arg, set argument (no pop)
export const OP_set_loc_uninitialized = 0x5E;  // size=3, fmt=loc

// ── Property access ──
export const OP_get_field         = 0x3D;  // size=5, fmt=atom, object property read
export const OP_get_field2        = 0x3E;  // size=5, fmt=atom, property read (keep obj)
export const OP_put_field         = 0x3F;  // size=5, fmt=atom, object property write
export const OP_get_array_el      = 0x43;  // size=1
export const OP_put_array_el     = 0x46;  // size=1

// ── Control flow (4-byte signed offset, fmt=label) ──
export const OP_if_false          = 0x68;  // size=5, fmt=label, pop & branch if falsy
export const OP_if_true           = 0x69;  // size=5, fmt=label, pop & branch if truthy
export const OP_goto              = 0x6A;  // size=5, fmt=label, unconditional branch

// ── Unary operators ──
export const OP_neg               = 0x8A;  // size=1, unary negate
export const OP_plus              = 0x8B;  // size=1, unary plus (ToNumber)
export const OP_dec               = 0x8C;  // size=1, decrement
export const OP_inc               = 0x8D;  // size=1, increment
export const OP_post_dec          = 0x8E;  // size=1
export const OP_post_inc          = 0x8F;  // size=1

// ── Fast local inc/dec (1-byte index, fmt=loc8) ──
export const OP_dec_loc           = 0x90;  // size=2, fmt=loc8
export const OP_inc_loc           = 0x91;  // size=2, fmt=loc8
export const OP_add_loc           = 0x92;  // size=2, fmt=loc8

export const OP_not               = 0x93;  // size=1, bitwise NOT
export const OP_lnot              = 0x94;  // size=1, logical NOT
export const OP_typeof            = 0x95;  // size=1

// ── Binary operators ──
export const OP_mul               = 0x98;  // size=1
export const OP_div               = 0x99;  // size=1
export const OP_mod               = 0x9A;  // size=1
export const OP_add               = 0x9B;  // size=1
export const OP_sub               = 0x9C;  // size=1
export const OP_pow               = 0x9D;  // size=1

// ── Bitwise operators ──
export const OP_shl               = 0x9E;  // size=1, shift left
export const OP_sar               = 0x9F;  // size=1, arithmetic shift right (signed)
export const OP_shr               = 0xA0;  // size=1, logical shift right (unsigned)

// ── Comparison operators ──
export const OP_lt                = 0xA1;  // size=1
export const OP_lte               = 0xA2;  // size=1
export const OP_gt                = 0xA3;  // size=1
export const OP_gte               = 0xA4;  // size=1
export const OP_instanceof        = 0xA5;  // size=1
export const OP_in                = 0xA6;  // size=1

export const OP_eq                = 0xA7;  // size=1, == (abstract equality)
export const OP_neq               = 0xA8;  // size=1, !=
export const OP_strict_eq         = 0xA9;  // size=1, ===
export const OP_strict_neq        = 0xAA;  // size=1, !==

// ── Bitwise binary ──
export const OP_and               = 0xAB;  // size=1
export const OP_xor               = 0xAC;  // size=1
export const OP_or                = 0xAD;  // size=1

export const OP_nop               = 0xB1;  // size=1

// ──── SHORT OPCODES (optimized encodings) ────────────────────────────────────
// These are compact versions of common operations.
// They are only emitted when SHORT_OPCODES is enabled (default).

// ── Push small integers ──
export const OP_push_minus1       = 0xC5;  // size=1, push int -1
export const OP_push_0            = 0xC6;  // size=1, push int 0
export const OP_push_1            = 0xC7;  // size=1, push int 1
export const OP_push_2            = 0xC8;  // size=1, push int 2
export const OP_push_3            = 0xC9;  // size=1, push int 3
export const OP_push_4            = 0xCA;  // size=1, push int 4
export const OP_push_5            = 0xCB;  // size=1, push int 5
export const OP_push_6            = 0xCC;  // size=1, push int 6
export const OP_push_7            = 0xCD;  // size=1, push int 7
export const OP_push_i8           = 0xCE;  // size=2, push 8-bit signed immediate
export const OP_push_i16          = 0xCF;  // size=3, push 16-bit signed immediate

export const OP_push_const8       = 0xD0;  // size=2, push cpool entry (1-byte index)
export const OP_fclosure8         = 0xD1;  // size=2

// ── Short variable access (1-byte index, fmt=loc8) ──
export const OP_push_empty_string = 0xD2;  // size=1
export const OP_get_loc8          = 0xD3;  // size=2, fmt=loc8, load local (uint8 index)
export const OP_put_loc8          = 0xD4;  // size=2, fmt=loc8, store local
export const OP_set_loc8          = 0xD5;  // size=2, fmt=loc8, set local (no pop)

// ── Zero-operand variable access (index baked into opcode) ──
export const OP_get_loc0          = 0xD6;  // size=1, load local 0
export const OP_get_loc1          = 0xD7;  // size=1, load local 1
export const OP_get_loc2          = 0xD8;  // size=1, load local 2
export const OP_get_loc3          = 0xD9;  // size=1, load local 3
export const OP_put_loc0          = 0xDA;  // size=1, store local 0
export const OP_put_loc1          = 0xDB;  // size=1, store local 1
export const OP_put_loc2          = 0xDC;  // size=1, store local 2
export const OP_put_loc3          = 0xDD;  // size=1, store local 3
export const OP_set_loc0          = 0xDE;  // size=1
export const OP_set_loc1          = 0xDF;  // size=1
export const OP_set_loc2          = 0xE0;  // size=1
export const OP_set_loc3          = 0xE1;  // size=1
export const OP_get_arg0          = 0xE2;  // size=1, load argument 0
export const OP_get_arg1          = 0xE3;  // size=1, load argument 1
export const OP_get_arg2          = 0xE4;  // size=1, load argument 2
export const OP_get_arg3          = 0xE5;  // size=1, load argument 3
export const OP_put_arg0          = 0xE6;  // size=1, store argument 0
export const OP_put_arg1          = 0xE7;  // size=1, store argument 1
export const OP_put_arg2          = 0xE8;  // size=1, store argument 2
export const OP_put_arg3          = 0xE9;  // size=1, store argument 3
export const OP_set_arg0          = 0xEA;  // size=1
export const OP_set_arg1          = 0xEB;  // size=1
export const OP_set_arg2          = 0xEC;  // size=1
export const OP_set_arg3          = 0xED;  // size=1

export const OP_get_length        = 0xFA;  // size=1

// ── Short branch instructions ──
export const OP_if_false8         = 0xFB;  // size=2, fmt=label8, 1-byte signed offset
export const OP_if_true8          = 0xFC;  // size=2, fmt=label8
export const OP_goto8             = 0xFD;  // size=2, fmt=label8
export const OP_goto16            = 0xFE;  // size=3, fmt=label16, 2-byte signed offset

// ─── Priority 2: Phase 4b (Interpreter-only for now) ─────────────────────────

export const OP_await             = 0x6D;  // async/await state machine
export const OP_yield             = 0x6C;  // generator yield

// ─── Opcode Metadata (VERIFIED) ──────────────────────────────────────────────

/**
 * Operand size in bytes for each opcode (total instruction size - 1).
 * 0 = no operand (size=1), 1 = 1-byte operand (size=2), etc.
 *
 * CRITICAL for the bytecode reader: it must skip the correct number of
 * bytes after each opcode to find the next one.
 */
export const OPCODE_SIZE: Record<number, number> = {
  // size=1 (no operand)
  [0x00]: 1, // OP_invalid
  [0x06]: 1, [0x07]: 1, [0x08]: 1, [0x09]: 1, [0x0A]: 1, // undefined, null, push_this, push_false, push_true
  [0x0B]: 1, // object
  [0x0E]: 1, [0x0F]: 1, [0x10]: 1, // drop, nip, nip1
  [0x11]: 1, [0x12]: 1, [0x13]: 1, // dup, dup2, dup3
  [0x14]: 1, [0x15]: 1, [0x16]: 1, // insert2, insert3, insert4
  [0x17]: 1, [0x18]: 1, [0x19]: 1, // perm3, perm4, perm5
  [0x1A]: 1, [0x1B]: 1, // swap, swap2
  [0x1C]: 1, [0x1D]: 1, [0x1E]: 1, [0x1F]: 1, // rot3l, rot3r, rot4l, rot5l
  [0x28]: 1, [0x29]: 1, // return, return_undef
  [0x43]: 1, [0x46]: 1, // get_array_el, put_array_el
  [0x8A]: 1, [0x8B]: 1, [0x8C]: 1, [0x8D]: 1, [0x8E]: 1, [0x8F]: 1, // neg..post_inc
  [0x93]: 1, [0x94]: 1, [0x95]: 1, // not, lnot, typeof
  [0x98]: 1, [0x99]: 1, [0x9A]: 1, [0x9B]: 1, [0x9C]: 1, [0x9D]: 1, // mul..pow
  [0x9E]: 1, [0x9F]: 1, [0xA0]: 1, // shl, sar, shr
  [0xA1]: 1, [0xA2]: 1, [0xA3]: 1, [0xA4]: 1, // lt, lte, gt, gte
  [0xA5]: 1, [0xA6]: 1, // instanceof, in
  [0xA7]: 1, [0xA8]: 1, [0xA9]: 1, [0xAA]: 1, // eq, neq, strict_eq, strict_neq
  [0xAB]: 1, [0xAC]: 1, [0xAD]: 1, // and, xor, or
  [0xB1]: 1, // nop
  // Short opcodes (size=1)
  [0xC5]: 1, [0xC6]: 1, [0xC7]: 1, [0xC8]: 1, [0xC9]: 1, [0xCA]: 1, [0xCB]: 1, [0xCC]: 1, [0xCD]: 1, // push_minus1..push_7
  [0xD2]: 1, // push_empty_string
  [0xD6]: 1, [0xD7]: 1, [0xD8]: 1, [0xD9]: 1, // get_loc0..3
  [0xDA]: 1, [0xDB]: 1, [0xDC]: 1, [0xDD]: 1, // put_loc0..3
  [0xDE]: 1, [0xDF]: 1, [0xE0]: 1, [0xE1]: 1, // set_loc0..3
  [0xE2]: 1, [0xE3]: 1, [0xE4]: 1, [0xE5]: 1, // get_arg0..3
  [0xE6]: 1, [0xE7]: 1, [0xE8]: 1, [0xE9]: 1, // put_arg0..3
  [0xEA]: 1, [0xEB]: 1, [0xEC]: 1, [0xED]: 1, // set_arg0..3
  [0xFA]: 1, // get_length

  // size=2 (1-byte operand)
  [0x0C]: 2, // special_object
  [0x90]: 2, [0x91]: 2, [0x92]: 2, // dec_loc, inc_loc, add_loc
  [0xCE]: 2, // push_i8
  [0xD0]: 2, // push_const8
  [0xD1]: 2, // fclosure8
  [0xD3]: 2, [0xD4]: 2, [0xD5]: 2, // get_loc8, put_loc8, set_loc8
  [0xFB]: 2, [0xFC]: 2, [0xFD]: 2, // if_false8, if_true8, goto8

  // size=3 (2-byte operand)
  [0x0D]: 3, // rest
  [0x22]: 3, [0x23]: 3, [0x24]: 3, [0x25]: 3, [0x26]: 3, [0x27]: 3, // call..apply
  [0x55]: 3, [0x56]: 3, [0x57]: 3, // get_loc, put_loc, set_loc
  [0x58]: 3, [0x59]: 3, [0x5A]: 3, // get_arg, put_arg, set_arg
  [0x5E]: 3, // set_loc_uninitialized
  [0xCF]: 3, // push_i16
  [0xFE]: 3, // goto16

  // size=5 (4-byte operand)
  [0x01]: 5, // push_i32
  [0x02]: 5, // push_const
  [0x03]: 5, // fclosure
  [0x04]: 5, // push_atom_value
  [0x05]: 5, // private_symbol
  [0x3D]: 5, [0x3E]: 5, [0x3F]: 5, // get_field, get_field2, put_field
  [0x68]: 5, [0x69]: 5, [0x6A]: 5, // if_false, if_true, goto
};

/**
 * Stack effect: [pop_count, push_count] for each opcode.
 * Only Priority 1 opcodes are listed here.
 */
export const OPCODE_STACK_EFFECT: Record<number, [number, number]> = {
  [0x01]: [0, 1], // push_i32: push 1
  [0x06]: [0, 1], // undefined
  [0x07]: [0, 1], // null
  [0x09]: [0, 1], [0x0A]: [0, 1], // push_false, push_true
  [0x0E]: [1, 0], // drop: pop 1
  [0x11]: [0, 1], // dup: net +1 (peek+push)
  [0x1A]: [0, 0], // swap: net 0
  [0x28]: [1, 0], // return: pop 1
  [0x29]: [0, 0], // return_undef: nothing
  [0x55]: [0, 1], [0x58]: [0, 1], // get_loc, get_arg: push 1
  [0x56]: [1, 0], [0x59]: [1, 0], // put_loc, put_arg: pop 1
  [0x57]: [0, 0], [0x5A]: [0, 0], // set_loc, set_arg: peek (no pop)
  [0x68]: [1, 0], [0x69]: [1, 0], // if_false, if_true: pop 1
  [0x6A]: [0, 0], // goto: nothing
  [0x8A]: [1, 1], [0x8C]: [1, 1], [0x8D]: [1, 1], // neg, dec, inc
  [0x93]: [1, 1], [0x94]: [1, 1], // not, lnot
  [0x98]: [2, 1], [0x99]: [2, 1], [0x9A]: [2, 1], // mul, div, mod
  [0x9B]: [2, 1], [0x9C]: [2, 1], // add, sub
  [0x9E]: [2, 1], [0x9F]: [2, 1], [0xA0]: [2, 1], // shl, sar, shr
  [0xA1]: [2, 1], [0xA2]: [2, 1], [0xA3]: [2, 1], [0xA4]: [2, 1], // lt, lte, gt, gte
  [0xA7]: [2, 1], [0xA8]: [2, 1], [0xA9]: [2, 1], [0xAA]: [2, 1], // eq, neq, strict_eq, strict_neq
  [0xAB]: [2, 1], [0xAC]: [2, 1], [0xAD]: [2, 1], // and, xor, or
  // Short push opcodes
  [0xC5]: [0, 1], [0xC6]: [0, 1], [0xC7]: [0, 1], [0xC8]: [0, 1], // push_minus1..push_2
  [0xC9]: [0, 1], [0xCA]: [0, 1], [0xCB]: [0, 1], [0xCC]: [0, 1], [0xCD]: [0, 1], // push_3..push_7
  [0xCE]: [0, 1], [0xCF]: [0, 1], // push_i8, push_i16
  [0xD3]: [0, 1], [0xD4]: [1, 0], [0xD5]: [0, 0], // get_loc8, put_loc8, set_loc8
  [0xD6]: [0, 1], [0xD7]: [0, 1], [0xD8]: [0, 1], [0xD9]: [0, 1], // get_loc0..3
  [0xDA]: [1, 0], [0xDB]: [1, 0], [0xDC]: [1, 0], [0xDD]: [1, 0], // put_loc0..3
  [0xE2]: [0, 1], [0xE3]: [0, 1], [0xE4]: [0, 1], [0xE5]: [0, 1], // get_arg0..3
  [0xE6]: [1, 0], [0xE7]: [1, 0], [0xE8]: [1, 0], [0xE9]: [1, 0], // put_arg0..3
  [0xFB]: [1, 0], [0xFC]: [1, 0], // if_false8, if_true8
  [0xFD]: [0, 0], [0xFE]: [0, 0], // goto8, goto16
};
```

> **CRITICAL CORRECTION from original plan:**
> The original plan assumed `OP_get_loc=0xC8` and `OP_get_arg=0xCA` with
> 1-byte operands. The actual values are `OP_get_loc=0x55` (size=3, 2-byte
> uint16 index) and `OP_get_arg=0x58` (size=3, 2-byte uint16 index).
>
> QuickJS has **three** encoding levels for variable access:
> 1. `get_loc0`..`get_loc3` (0xD6–0xD9) — zero operand, index baked into opcode
> 2. `get_loc8` (0xD3) — 1-byte uint8 index
> 3. `get_loc` (0x55) — 2-byte uint16 index
>
> The JIT compiler **must handle all three levels** for each operation.
> Same pattern applies to put_loc, set_loc, get_arg, put_arg, set_arg.

### Extraction Procedure (COMPLETED)

Opcodes were extracted from the `jsos-builder` docker container using
`scripts/extract-opcodes.py` which parses `quickjs-opcode.h`:

```bash
# This has already been done. To re-extract:
docker run --rm -v "${PWD}/scripts:/tmp/scripts" jsos-builder \
  python3 /tmp/scripts/extract-opcodes.py

# Output: all 263 opcodes with hex values, sizes, pop/push counts, and format strings
```

The opcodes are defined in a separate file `quickjs-opcode.h` (not inline in
`quickjs.c`), using `DEF()` and `def()` macros:
- `DEF(name, size, n_pop, n_push, f)` — standard opcodes
- `def(name, size, n_pop, n_push, f)` — short opcodes (only when `SHORT_OPCODES` enabled)

### Validation Function (Updated with verified opcodes)

```typescript
/**
 * Validate opcode constants against a canary function.
 * Compiles `function(a) { return a + 1; }` and checks first few bytes.
 *
 * Expected bytecode for "function(a) { return a + 1; }":
 *   OP_get_arg0       (0xE2) — load argument 0 (short form, no operand)
 *   OP_push_1         (0xC7) — push integer 1 (short form)
 *   OP_add            (0x9B) — add TOS values
 *   OP_return          (0x28) — return TOS
 *
 * NOTE: QuickJS will likely emit the short forms (get_arg0, push_1)
 * rather than the long forms (get_arg + uint16 index).
 */
export function validateOpcodes(bcBuf: Uint8Array): boolean {
    if (bcBuf.length < 4) return false;
    // Check first opcode: should be OP_get_arg0 (0xE2)
    if (bcBuf[0] !== 0xE2) {
        // Might be OP_get_arg (0x58) + uint16(0x0000) for the long form
        if (bcBuf[0] !== 0x58) return false;
    }
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

### QuickJS Source Changes (VERIFIED)

This is the **only change to QuickJS C source** in the entire JIT project.

**Key finding:** QuickJS has **no existing `call_count` field** on
`JSFunctionBytecode`. We must add one. Searching for `call_count`, `jit_count`,
`hot_count`, and `exec_count` in `quickjs.c` returned zero results.

**Interpreter loop structure (VERIFIED):**

The interpreter is `JS_CallInternal()` at line 17356 of `quickjs.c`.
The function uses a computed goto dispatch table (when `DIRECT_DISPATCH` is enabled):

```c
static JSValue JS_CallInternal(JSContext *caller_ctx, JSValueConst func_obj,
                               JSValueConst this_obj, JSValueConst new_target,
                               int argc, JSValue *argv, int flags)
{
    ...
    #if !DIRECT_DISPATCH
    #define SWITCH(pc)      switch (opcode = *pc++)
    #define CASE(op)        case op
    #else
    static const void * const dispatch_table[256] = {
      #define DEF(id, size, n_pop, n_push, f) && case_OP_ ## id,
      ...
    };
    #define SWITCH(pc)      goto *dispatch_table[opcode = *pc++];
    #define CASE(op)        case_ ## op
    #endif
    ...
}
```

**Insertion point (line ~17437 of quickjs.c):**

After `b = p->u.func.function_bytecode` is set (line ~17437) and before the
stack frame is set up, insert the hook check:

```c
    b = p->u.func.function_bytecode;

    /* ── JIT hook insertion point ──────────────────────────────────── */
    b->call_count++;
    if (rt->jit_hook && b->call_count == JIT_THRESHOLD) {
        rt->jit_hook(caller_ctx, (void *)b, argv, argc);
        /* Always fall through to interpreter on first trigger.
         * The hook compiles the function for NEXT time. */
    }
    if (b->jit_native_ptr) {
        /* Fast path: function has been JIT-compiled.
         * Call native code, bypassing the interpreter entirely. */
        typedef JSValue (*jit_fn_t)(JSContext *ctx, JSValue *argv, int argc);
        JSValue result = ((jit_fn_t)b->jit_native_ptr)(caller_ctx, argv, argc);
        if (likely(!JS_IsException(result))) {
            return result;
        }
        /* Exception / deopt → clear native pointer, fall through */
        b->jit_native_ptr = NULL;
    }
    /* ── End JIT hook ──────────────────────────────────────────────── */

    if (unlikely(argc < b->arg_count || (flags & JS_CALL_FLAG_COPY_ARGV))) {
```

**In `JSFunctionBytecode` struct (quickjs.c line 620), add two fields:**

```c
    // Add after the bitfield block and before byte_code_buf:
    uint32_t call_count;      /* JIT: incremented on each call */
    void *jit_native_ptr;     /* JIT: native code pointer (NULL = interpreted) */
```

> **IMPORTANT:** Adding these fields changes the struct layout, which invalidates
> all our verified offsets! After adding `call_count` (4 bytes) and
> `jit_native_ptr` (4 bytes), all fields from `byte_code_buf` onward shift by 8 bytes.
>
> **Updated offsets after adding JIT fields (at offset 20, adding 8 bytes):**
> | Field            | Old Offset | New Offset |
> |------------------|-----------|-----------|
> | call_count       | —         | 20 (0x14) NEW |
> | jit_native_ptr   | —         | 24 (0x18) NEW |
> | byte_code_buf    | 20 (0x14) | 28 (0x1C) |
> | byte_code_len    | 24 (0x18) | 32 (0x20) |
> | func_name        | 28 (0x1C) | 36 (0x24) |
> | vardefs          | 32 (0x20) | 40 (0x28) |
> | closure_var      | 36 (0x24) | 44 (0x2C) |
> | arg_count        | 40 (0x28) | 48 (0x30) |
> | var_count        | 42 (0x2A) | 50 (0x32) |
> | defined_arg_count| 44 (0x2C) | 52 (0x34) |
> | stack_size       | 46 (0x2E) | 54 (0x36) |
> | realm            | 52 (0x34) | 60 (0x3C) |
> | cpool            | 56 (0x38) | 64 (0x40) |
> | cpool_count      | 60 (0x3C) | 68 (0x44) |
> | debug            | 68 (0x44) | 76 (0x4C) |
> | sizeof           | 88 (0x58) | 96 (0x60) |
>
> **After modifying the struct, re-run the probe to get exact values.**
> The +8 shift is a prediction; actual padding may differ.

**In `JSRuntime` struct, add:**

```c
/* JIT hook — called when a function reaches JIT_THRESHOLD calls */
typedef int (*js_jit_hook_t)(JSContext *ctx,
                              void *bytecode_ptr,  /* JSFunctionBytecode* */
                              JSValue *argv,
                              int argc);
js_jit_hook_t  jit_hook;
```

**Public API function:**

```c
void JS_SetJITHook(JSRuntime *rt, js_jit_hook_t hook) {
    rt->jit_hook = hook;
}

#define JIT_THRESHOLD 100
```

### `call_count` and `jit_native_ptr` Fields

Both fields are added to `JSFunctionBytecode` as described above.
The `call_count` field is initialized to 0 by QuickJS's allocator (calloc/js_mallocz).
The `jit_native_ptr` field is initialized to NULL.

### `quickjs_binding.c` — Hook Registration

```c
/*
 * The JIT hook callback. Called from QuickJS when a function reaches
 * JIT_THRESHOLD calls. Invokes the registered TypeScript callback.
 */
static JSValue _jit_ts_callback = JS_UNDEFINED;

static int _jit_hook_impl(JSContext *ctx, void *bytecode_ptr,
                           JSValue *stack_ptr, int argc) {
    /* SAFETY: this hook is only for the main runtime.
     * Child runtimes use _jit_hook_child (deferred mechanism). */
    if (JS_GetRuntime(ctx) != rt) return 1;
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

### Multiple QuickJS Runtimes — Full JIT Architecture

**JSOS uses multiple simultaneous QuickJS runtimes as its process model.**
Understanding this is essential to getting JIT right.

#### Runtime Tiers

| | Main runtime | Child runtimes |
|---|---|---|
| Created by | `quickjs_initialize()` | `kernel.procCreate()` → `_procs[0..7]` |
| Memory limit | 50 MB | up to **1 GB each** — covers Gmail/Docs/Maps/heavy SPAs; 32-bit i686 hard ceiling (~3 GB phys RAM); 4 GB+ tabs need 64-bit kernel; 2 GB NOLOAD heap window; real peak ~1-1.3 GB with cooperative scheduling |
| Stack limit | 1 MB (QuickJS default) | **256 KB** (recursive HTML parser / deeply nested JS) |
| What runs in it | OS kernel, WM, services, REPL | **All user apps** (terminal, editor, browser, file manager, monitor) + worker processes |
| Kernel API | Full | Expanded (FS, timers, events, window commands, render buffer — see before_jit_os_updates.md) |
| JIT pool region | First 8 MB | 512 KB slot per index (after Step 1) |
| JIT hook | Direct (synchronous) | Deferred (async via `procPendingJIT`) |

**Why child runtimes need JIT too:** JSOS uses cooperative multitasking.
Each child runtime gets a time slice (typically ~5ms via PIT interrupt). A
child doing CPU-heavy work (pathfinding, compression, physics, game logic)
runs at interpreter speed during its slice and accomplishes very little per
tick. JIT can make that same slice 10–50× more productive. Child runtimes
ARE the OS's user processes — they absolutely want JIT.

#### Why the Main Runtime Hook Cannot Be Used for Children

The main-runtime hook calls `JS_Call(ctx, _jit_ts_callback, …)` where both
`ctx` and `_jit_ts_callback` belong to the main runtime's GC heap. When a
child's hook fires, the `ctx` passed in is the **child's** context. Calling
`JS_Call(child_ctx, main_runtime_callback, …)` mixes GC heaps — undefined
behavior, almost certainly a crash.

#### Solution: Deferred JIT for Child Runtimes

Child runtimes use a **C-level deferred mechanism** instead of a synchronous
TypeScript callback:

```
Child function hits JIT_THRESHOLD
         │
         ▼
_jit_hook_child() fires (C, inside JS_Eval / JS_ExecutePendingJob)
         │  stores _jit_proc_pending[id] = { bytecode_ptr, pending=1 }
         │  returns 1 → interpreter handles this call
         ▼
JS_Eval / procTick returns to TypeScript
         │
         ▼
TypeScript: addr = kernel.procPendingJIT(id)   ← new kernel function
         │  returns bytecode physical addr, clears pending flag
         ▼
TypeScript JIT compiler (main runtime) reads bytecode via readPhysMem()
         │  readPhysMem is physical memory access — runtime-agnostic
         ▼
compiler.compile() → JIT pool partition for this child slot
         │  kernel.jitProcAlloc(id, size) instead of kernel.jitAlloc(size)
         ▼
kernel.setJITNative(bcAddr, nativeAddr)
         │  writes physical address — runtime-agnostic
         ▼
Next call to that function in child runtime hits jit_native_ptr fast path
         │  native code runs directly
```

#### New C State in `quickjs_binding.c`

```c
/* Pending deferred JIT requests from child runtimes.
 * Set by _jit_hook_child, cleared by js_proc_pending_jit. */
static struct {
    void *bytecode_ptr;
    int   pending;
} _jit_proc_pending[JSPROC_MAX];

/* Child runtime JIT hook — deferred, no cross-heap calls */
static int _jit_hook_child(JSContext *ctx, void *bytecode_ptr,
                            JSValue *stack_ptr, int argc) {
    (void)stack_ptr; (void)argc;
    JSRuntime *child_rt = JS_GetRuntime(ctx);
    for (int i = 0; i < JSPROC_MAX; i++) {
        if (_procs[i].rt == child_rt) {
            /* Only record one pending request at a time per slot.
             * If a previous request hasn't been serviced yet, drop this one —
             * the function will trigger again on the next JIT_THRESHOLD hit. */
            if (!_jit_proc_pending[i].pending) {
                _jit_proc_pending[i].bytecode_ptr = bytecode_ptr;
                _jit_proc_pending[i].pending = 1;
            }
            break;
        }
    }
    return 1; /* always let interpreter handle this call */
}
```

Register the child hook in `js_proc_create`, after `JS_SetInterruptHandler`:

```c
    JS_SetJITHook(p->rt, _jit_hook_child);
```

Clear pending and reclaim pool in `js_proc_destroy`:

```c
    _jit_proc_pending[id].pending = 0;
    _jit_proc_pending[id].bytecode_ptr = NULL;
    jit_proc_reset(id);   /* O(1) pool reclaim */
```

#### New Kernel API Functions

**`kernel.procPendingJIT(id)`** — called by TypeScript after each `procTick`:

```c
/* kernel.procPendingJIT(id) → bytecodeAddr or 0 if no pending request */
static JSValue js_proc_pending_jit(JSContext *c, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewUint32(c, 0);
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used)
        return JS_NewUint32(c, 0);
    if (!_jit_proc_pending[id].pending)
        return JS_NewUint32(c, 0);
    uint32_t addr = (uint32_t)(uintptr_t)_jit_proc_pending[id].bytecode_ptr;
    _jit_proc_pending[id].pending = 0;  /* consume the request */
    return JS_NewUint32(c, addr);
}
```

**`kernel.jitProcAlloc(id, size)`** — allocates from child's pool partition:

```c
/* kernel.jitProcAlloc(id, size) → address in child's JIT pool partition, or 0 */
static JSValue js_jit_proc_alloc(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NewUint32(c, 0);
    int32_t id = 0, size = 0;
    JS_ToInt32(c, &id, argv[0]);
    JS_ToInt32(c, &size, argv[1]);
    void *p = jit_proc_alloc(id, (size_t)size);
    return JS_NewUint32(c, (uint32_t)(uintptr_t)p);
}
```

Register both:
```c
    JS_CFUNC_DEF("procPendingJIT", 1, js_proc_pending_jit),
    JS_CFUNC_DEF("jitProcAlloc",   2, js_jit_proc_alloc),
```

Add TypeScript declarations in `kernel.ts`:
```typescript
  /** Check if a child runtime has a pending JIT compilation request.
   *  Returns the bytecodeAddr to compile, or 0 if none. Clears the flag. */
  procPendingJIT(id: number): number;
  /** Allocate `size` bytes from child slot `id`'s JIT pool partition. */
  jitProcAlloc(id: number, size: number): number;
```

#### Safety: Main Runtime Guard in `_jit_hook_impl`

`_jit_hook_impl` (the main runtime hook) must never fire for a child runtime.
Since `JS_SetJITHook` is only called with `_jit_hook_child` for child runtimes,
this cannot happen — but add a guard anyway:

```c
static int _jit_hook_impl(JSContext *ctx, void *bytecode_ptr,
                           JSValue *stack_ptr, int argc) {
    /* SAFETY: this hook is only for the main runtime */
    if (JS_GetRuntime(ctx) != rt) return 1;
    if (JS_IsUndefined(_jit_ts_callback)) return 1;
    /* … rest unchanged … */
}
```

#### `call_count` Overhead in Child Runtimes

Adding `call_count` + `jit_native_ptr` to `JSFunctionBytecode` costs +8 bytes
per function in every runtime. A 4 MB child with a few hundred functions
adds ~2–3 KB overhead — negligible. The `jit_native_ptr` field starts NULL;
before JIT compilation it will always be NULL for most child functions, so
the hot-path check (`if (b->jit_native_ptr)`) is a correctly-predicted
branch-not-taken — no measurable cost until the function is actually compiled.

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

// ─── JSValue Tag Constants (VERIFIED — NaN-boxing on i686) ────────────────────
//
// QuickJS JSValue layout on i686 (32-bit, NaN-boxing build):
//
//   JS_NAN_BOXING is ENABLED on i686 because !JS_PTR64 (not a 64-bit pointer arch).
//   JSValue is a uint64_t (8 bytes total), with tag encoded in upper 32 bits:
//
//   typedef uint64_t JSValue;
//
//   Bit layout (little-endian in memory):
//     Bytes [0:4] = lower 32 bits = int32 value OR lower part of pointer/double
//     Bytes [4:8] = upper 32 bits = tag
//
//   Accessors (from quickjs.h):
//     JS_VALUE_GET_TAG(v) = (int)((v) >> 32)
//     JS_VALUE_GET_INT(v) = (int)(v)
//     JS_MKVAL(tag, val)  = (((uint64_t)(tag) << 32) | (uint32_t)(val))
//
//   In MEMORY on little-endian x86-32:
//     offset 0: int32 value (u.int32)   ← lower 32 bits
//     offset 4: int32 tag               ← upper 32 bits
//
//   This means reading a JSValue from memory as two 32-bit LE reads gives:
//     dv.getInt32(0, true) → the int32 value
//     dv.getInt32(4, true) → the tag
//
//   sizeof(JSValue) = 8 bytes (VERIFIED on i686-elf-gcc)
//
//   Float64 encoding:  If JS_VALUE_GET_TAG(v) >= JS_TAG_FLOAT64 (tag=8 or higher),
//   the entire uint64_t IS the IEEE 754 double (with some NaN bits used for tagging).
//   JS_TAG_IS_FLOAT64(tag) = ((unsigned)((tag) - JS_TAG_FIRST) >= (JS_TAG_FLOAT64 - JS_TAG_FIRST))
//

export const JS_TAG_FIRST        = -9;     // VERIFIED
export const JS_TAG_SYMBOL       = -8;     // VERIFIED
export const JS_TAG_STRING       = -7;     // VERIFIED
export const JS_TAG_OBJECT       = -1;     // VERIFIED
export const JS_TAG_INT          = 0;      // VERIFIED
export const JS_TAG_BOOL         = 1;      // VERIFIED
export const JS_TAG_NULL         = 2;      // VERIFIED
export const JS_TAG_UNDEFINED    = 3;      // VERIFIED
export const JS_TAG_UNINITIALIZED = 4;     // VERIFIED
export const JS_TAG_CATCH_OFFSET = 5;      // VERIFIED
export const JS_TAG_EXCEPTION    = 6;      // VERIFIED
export const JS_TAG_SHORT_BIG_INT = 7;     // VERIFIED (new in recent QuickJS)
export const JS_TAG_FLOAT64      = 8;      // VERIFIED (NaN-boxing sentinel)

// NOTE: JS_TAG_BIG_DECIMAL, JS_TAG_BIG_INT, JS_TAG_BIG_FLOAT are REMOVED
// in this QuickJS version. Short big ints use JS_TAG_SHORT_BIG_INT = 7.
// Full BigInt uses a heap-allocated object with JS_TAG_OBJECT.

/** Size of one JSValue on our i686 NaN-boxing build (VERIFIED) */
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
  // Hardcoded fallback — VERIFIED for our QuickJS build on i686-elf-gcc
  // NOTE: These are PRE-JIT-FIELDS offsets. After adding call_count and
  // jit_native_ptr to JSFunctionBytecode, ALL offsets shift by +8 bytes.
  // The values below assume the JIT fields have been added.
  _offsets = {
    bcBuf:      28,   // 0x1C (was 20 before adding 8 bytes of JIT fields)
    bcLen:      32,   // 0x20 (was 24)
    argCount:   48,   // 0x30 (was 40)
    varCount:   50,   // 0x32 (was 42)
    cpoolPtr:   64,   // 0x40 (was 56)
    cpoolCount: 68,   // 0x44 (was 60)
    stackSize:  54,   // 0x36 (was 46)
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
export interface QJSJITCompilerOptions {
  /**
   * Custom pool allocator. Defaults to kernel.jitAlloc (main runtime pool).
   * Pass kernel.jitProcAlloc.bind(null, procId) for child runtime compilation.
   */
  alloc?: (size: number) => number;
}

export class QJSJITCompiler {
  private _e: _Emit;
  private _reader: QJSBytecodeReader;
  private _alloc: (size: number) => number;

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

  constructor(reader: QJSBytecodeReader, opts?: QJSJITCompilerOptions) {
    this._reader = reader;
    this._e = new _Emit();
    this._argCount = reader.argCount;
    this._varCount = reader.varCount;
    // Default: allocate from main runtime pool
    this._alloc = opts?.alloc ?? ((size: number) => kernel.jitAlloc(size));
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
    // Uses this._alloc: main pool for main runtime, child partition for processes.
    const code = e.buf;
    const addr = this._alloc(code.length);
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

      // ── Push constants (all variants) ──

      case OP_push_i32: {
        // 4-byte signed immediate
        const v = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        e.immEax(v);
        e.pushEax();
        return pc + 4;
      }

      case OP_push_0: case OP_push_minus1:
      case OP_push_1: case OP_push_2: case OP_push_3:
      case OP_push_4: case OP_push_5: case OP_push_6: case OP_push_7: {
        // Short push: value derived from opcode
        // push_minus1=0xC5, push_0=0xC6, push_1=0xC7, ..., push_7=0xCD
        const v = op - OP_push_0;  // -1, 0, 1, 2, ..., 7
        if (v === 0) {
          e.xorEaxEax();
        } else {
          e.immEax(v);
        }
        e.pushEax();
        return pc;
      }

      case OP_push_i8: {
        // 1-byte signed immediate
        const v = (ops[pc] << 24) >> 24; // sign-extend
        e.immEax(v);
        e.pushEax();
        return pc + 1;
      }

      case OP_push_i16: {
        // 2-byte signed immediate
        const v = (ops[pc] | (ops[pc+1] << 8)) << 16 >> 16; // sign-extend
        e.immEax(v);
        e.pushEax();
        return pc + 2;
      }

      case OP_push_const: {
        // 4-byte constant pool index
        const idx = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const val = this._reader.readConstInt(idx);
        if (val === null) return -1; // non-int constant → can't JIT
        e.immEax(val);
        e.pushEax();
        return pc + 4;
      }

      case OP_push_const8: {
        // 1-byte constant pool index (short form)
        const idx = ops[pc];
        const val = this._reader.readConstInt(idx);
        if (val === null) return -1;
        e.immEax(val);
        e.pushEax();
        return pc + 1;
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

      // ── Variable access (3 encoding levels per operation) ──

      // get_arg: 3 levels
      case OP_get_arg: {
        // Long form: 2-byte uint16 index
        const idx = ops[pc] | (ops[pc+1] << 8);
        if (idx >= this._argCount) return -1;
        e.load(this._argSlot(idx));
        e.pushEax();
        return pc + 2;
      }
      case OP_get_arg0: case OP_get_arg1: case OP_get_arg2: case OP_get_arg3: {
        // Zero-operand form: index baked into opcode
        const idx = op - OP_get_arg0;
        if (idx >= this._argCount) return -1;
        e.load(this._argSlot(idx));
        e.pushEax();
        return pc;
      }

      case OP_put_arg: {
        const idx = ops[pc] | (ops[pc+1] << 8);
        if (idx >= this._argCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._argSlot(idx));
        return pc + 2;
      }
      case OP_put_arg0: case OP_put_arg1: case OP_put_arg2: case OP_put_arg3: {
        const idx = op - OP_put_arg0;
        if (idx >= this._argCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._argSlot(idx));
        return pc;
      }

      // get_loc: 3 levels
      case OP_get_loc: {
        // Long form: 2-byte uint16 index
        const idx = ops[pc] | (ops[pc+1] << 8);
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.pushEax();
        return pc + 2;
      }
      case OP_get_loc8: {
        // Short form: 1-byte uint8 index
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.pushEax();
        return pc + 1;
      }
      case OP_get_loc0: case OP_get_loc1: case OP_get_loc2: case OP_get_loc3: {
        // Zero-operand form: index baked into opcode
        const idx = op - OP_get_loc0;
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.pushEax();
        return pc;
      }

      case OP_put_loc: {
        const idx = ops[pc] | (ops[pc+1] << 8);
        if (idx >= this._varCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._varSlot(idx));
        return pc + 2;
      }
      case OP_put_loc8: {
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._varSlot(idx));
        return pc + 1;
      }
      case OP_put_loc0: case OP_put_loc1: case OP_put_loc2: case OP_put_loc3: {
        const idx = op - OP_put_loc0;
        if (idx >= this._varCount) return -1;
        e.popEcx();
        e.movEaxEcx();
        e.store(this._varSlot(idx));
        return pc;
      }

      // set_loc (store without popping TOS)
      case OP_set_loc: {
        const idx = ops[pc] | (ops[pc+1] << 8);
        if (idx >= this._varCount) return -1;
        // Peek at TOS: MOV EAX, [ESP]
        e._w(0x8B); e._w(0x04); e._w(0x24);
        e.store(this._varSlot(idx));
        return pc + 2;
      }
      case OP_set_loc8: {
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e._w(0x8B); e._w(0x04); e._w(0x24);
        e.store(this._varSlot(idx));
        return pc + 1;
      }

      // inc_loc / dec_loc / add_loc (1-byte index, fmt=loc8)
      case OP_inc_loc: {
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.addEaxImm32(1);
        e.store(this._varSlot(idx));
        return pc + 1;
      }
      case OP_dec_loc: {
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e.load(this._varSlot(idx));
        e.subEaxImm32(1);
        e.store(this._varSlot(idx));
        return pc + 1;
      }
      case OP_add_loc: {
        // TOS += local[idx] — pops TOS, adds local, pushes result
        const idx = ops[pc];
        if (idx >= this._varCount) return -1;
        e.buf.push(0x58);           // POP EAX (value to add)
        e.pushEax();                // save it
        e.load(this._varSlot(idx)); // load local
        e.popEcx();                 // get saved value
        e.addAC();                  // EAX = local + value
        e.store(this._varSlot(idx));// store back
        e.pushEax();                // push result
        return pc + 1;
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
        // VERIFIED: QuickJS branch offset semantics:
        //   The SWITCH macro does `opcode = *pc++`, so at this point `pc` points
        //   to the first operand byte (byte after the opcode).
        //
        //   OP_goto:     pc += (int32_t)get_u32(pc);
        //     → offset is signed, relative to operand start (pc)
        //     → target bytecode address = operand_start + offset
        //
        //   OP_if_true:  pc += 4; if (truthy) pc += (int32_t)get_u32(pc-4) - 4;
        //     → equivalent: target = operand_start + offset
        //     (it advances past the operand first, then jumps back offset-4)
        //
        //   OP_goto8:    pc += (int8_t)pc[0];
        //     → offset relative to operand start
        //
        //   OP_if_true8: pc += 1; if (truthy) pc += (int8_t)pc[-1] - 1;
        //     → equivalent: target = operand_start + offset
        //
        //   CONCLUSION: All branch offsets are signed, relative to the operand
        //   start (the byte immediately after the opcode byte).
        //
        //   In our compiler, `pc` tracks the operand position (we already consumed
        //   the opcode byte), so:
        //     targetBc = pc + offset
        //   (NOT pc + operand_size + offset)

        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + offset;  // offset relative to operand start

        e.buf.push(0x58);           // POP EAX
        e.testAA();                 // TEST EAX, EAX
        const fixup = e.je();      // JE to target (if false/zero)
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      case OP_if_true: {
        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + offset;  // offset relative to operand start

        e.buf.push(0x58);
        e.testAA();
        const fixup = e.jne();     // JNE to target (if true/non-zero)
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      case OP_goto: {
        const offset = ops[pc] | (ops[pc+1] << 8) | (ops[pc+2] << 16) | (ops[pc+3] << 24);
        const targetBc = pc + offset;  // offset relative to operand start

        const fixup = e.jmp();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 4;
      }

      // ── Short branch instructions (MUST HANDLE — QuickJS optimizer emits these) ──

      case OP_if_false8: {
        const offset = (ops[pc] << 24) >> 24; // sign-extend 8-bit
        const targetBc = pc + offset;  // offset relative to operand start
        e.buf.push(0x58);
        e.testAA();
        const fixup = e.je();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 1;
      }

      case OP_if_true8: {
        const offset = (ops[pc] << 24) >> 24;
        const targetBc = pc + offset;
        e.buf.push(0x58);
        e.testAA();
        const fixup = e.jne();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 1;
      }

      case OP_goto8: {
        const offset = (ops[pc] << 24) >> 24;
        const targetBc = pc + offset;
        const fixup = e.jmp();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 1;
      }

      case OP_goto16: {
        const offset = (ops[pc] | (ops[pc+1] << 8)) << 16 >> 16; // sign-extend 16-bit
        const targetBc = pc + offset;
        const fixup = e.jmp();
        this._fwdPatches.push({ fixup, bcTarget: targetBc });
        return pc + 2;
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

1. **Operand encoding (VERIFIED):** QuickJS opcodes have variable-length operands.
   The exact instruction sizes are defined in `quickjs-opcode.h` via the `DEF()`
   macro's `size` parameter. Key findings:
   - `get_loc`/`put_loc`/`get_arg`/`put_arg` (0x55–0x5A): **size=3** (1 opcode + 2-byte uint16 index)
   - `get_loc8`/`put_loc8` (0xD3–0xD5): **size=2** (1 opcode + 1-byte uint8 index)
   - `get_loc0`..`get_loc3` (0xD6–0xD9): **size=1** (index baked into opcode, no operand)
   - `push_i32` (0x01): **size=5** (1 opcode + 4-byte int32)
   - `push_const` (0x02): **size=5** (1 opcode + 4-byte uint32 cpool index)
   - `push_const8` (0xD0): **size=2** (1 opcode + 1-byte uint8 cpool index)
   - `if_false`/`if_true`/`goto` (0x68–0x6A): **size=5** (1 opcode + 4-byte signed offset)
   - `if_false8`/`if_true8`/`goto8` (0xFB–0xFD): **size=2** (1 opcode + 1-byte signed offset)
   - `goto16` (0xFE): **size=3** (1 opcode + 2-byte signed offset)
   - `call`/`call_method` (0x22, 0x24): **size=3** (1 opcode + 2-byte argc)

   The compiler **must** handle all three encoding levels for variable access;
   QuickJS's bytecode optimizer aggressively uses short forms.

2. **Branch offset calculation (VERIFIED):** All QuickJS branch offsets are
   **signed, relative to the operand start** (the byte immediately after the
   opcode byte). This was confirmed by reading the interpreter loop in `quickjs.c`:
   - `OP_goto`:     `pc += (int32_t)get_u32(pc);` — offset from operand start
   - `OP_if_true`:  `pc += 4; if (res) pc += (int32_t)get_u32(pc-4) - 4;` — same
   - `OP_goto8`:    `pc += (int8_t)pc[0];` — offset from operand start
   - `OP_if_true8`: `pc += 1; if (res) pc += (int8_t)pc[-1] - 1;` — same
   
   The `get_u32()` function is defined in `cutils.h` as a simple packed struct read.

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

// Install it — registers hook on the main runtime only
qjsJit.install();

// Make stats available for debugging
(globalThis as any).__qjsJit = qjsJit;
```

### Process Scheduler Integration

The cooperative scheduler calls `kernel.procTick(id)` for each child runtime
on every scheduler tick. **Immediately after each procTick**, check for a
pending deferred JIT request and service it using the main-runtime JIT
compiler:

```typescript
// In the scheduler tick loop (wherever procTick is called):
function schedulerTick(procId: number): void {
  // Run the child for one time slice
  kernel.procTick(procId);

  // Service any deferred JIT compilation request from this child
  const pendingBC = kernel.procPendingJIT(procId);
  if (pendingBC !== 0) {
    _serviceChildJIT(procId, pendingBC);
  }
}

/**
 * Compile a function from a child runtime and install the native code.
 * Runs entirely in the main runtime's context — no cross-heap issues.
 * The JIT compiler is runtime-agnostic: it reads bytecode via readPhysMem
 * (physical address access) so it doesn't care which runtime owns the data.
 */
function _serviceChildJIT(procId: number, bcAddr: number): void {
  try {
    const reader = new QJSBytecodeReader(bcAddr);
    const compiler = new QJSJITCompiler(reader, {
      // Use the child's pool partition instead of the main pool
      alloc: (size: number) => kernel.jitProcAlloc(procId, size),
    });
    const nativeAddr = compiler.compile();
    if (nativeAddr !== 0) {
      kernel.setJITNative(bcAddr, nativeAddr);
    }
  } catch (e) {
    // Compilation failed — function stays interpreted; not fatal
    kernel.serialPut('[QJS-JIT] Child proc ' + procId + ' compile failed: ' + e + '\n');
  }
}
```

The `alloc` option threads through to `_Emit` construction — `QJSJITCompiler`
needs a small change to accept an optional allocator override so it writes
into the child's partition rather than the main pool. See Step 9 for
`QJSJITCompiler` constructor signature.

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
    terminal.writeLine('  Pool used:      ' + kernel.jitUsedBytes() + ' / ' + (8*1024*1024) + ' (main)');
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
4. **Pool budget:** After 100 compilations, `jitUsedBytes()` < 8 MB (main pool limit)
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

### JSValue Float64 Calling Convention (NaN-boxing — VERIFIED)

On our i686 QuickJS build, `JS_NAN_BOXING` is **enabled**. JSValue is a
`uint64_t` (8 bytes). Float64 values are stored directly as the uint64_t:

- If `JS_VALUE_GET_TAG(v) >= JS_TAG_FLOAT64` (i.e., tag >= 8), the entire
  uint64_t is treated as an IEEE 754 double.
- The float64 value **IS** the JSValue — no separate tag/union split.
- To check if a JSValue is a float64:
  `JS_TAG_IS_FLOAT64(tag) = ((unsigned)((tag) - JS_TAG_FIRST) >= (JS_TAG_FLOAT64 - JS_TAG_FIRST))`
  where `JS_TAG_FIRST=-9` and `JS_TAG_FLOAT64=8`.

**In memory (little-endian x86-32):**
- For int32 values: bytes[0:4] = int32 value, bytes[4:8] = tag (0..7)
- For float64 values: bytes[0:8] = full IEEE 754 double representation
  - The upper 32 bits naturally encode as a "tag" >= 8 for most float64 values
  - NaN payload bits distinguish float64 from other tagged values

**Implication for JIT:** To read/write float64 JSValues, the JIT code must
treat the full 8 bytes as a double. The tag/value split only applies to
non-float types (int, bool, null, undefined, object, string).

Since `sizeof(JSValue) == 8` and `sizeof(double) == 8`, there is NO struct
overhead. The JSValue and double occupy the same 8 bytes.

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
e.movEaxEcxDisp(20);            // EAX = obj->shape  (JSObject.shape offset = 20 / 0x14 — VERIFIED)

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

Even with an 8 MB main pool, a long-running OS instance with thousands of hot
functions across many apps will eventually exhaust the pool. LRU eviction
reclaims space by overwriting the coldest function.

Note: child process pools (512 KB per slot) are fully reclaimed by O(1) reset
on `procDestroy` — LRU is only needed for the main runtime's persistent pool.

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
| JIT pool exhaustion before eviction is implemented | No more functions can be compiled | Low (8 MB main / 512 KB per child) | Log a warning when pool > 75% full. Don't crash — just stop compiling |
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
| **JSValue** | QuickJS's NaN-boxed value type (8 bytes on i686): `uint64_t`. Tag in upper 32 bits, int32 value in lower 32 bits. Float64 values stored directly as the full uint64_t. |
| **JS_TAG_INT** | Tag value 0 — the JSValue contains a 32-bit integer in the lower 32 bits |
| **JIT pool** | 12 MB BSS region in `jit.c` — 8 MB main runtime + 8×512 KB child slots |
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
// Pool layout (partitioned)
JIT_POOL_SIZE       = 12 * 1024 * 1024  // 12 MB total BSS
JIT_MAIN_SIZE       = 8 * 1024 * 1024   // 8 MB — main runtime (never freed)
JIT_PROC_SLOTS      = 8                  // JSPROC_MAX child slots
JIT_PROC_SIZE       = 512 * 1024         // 512 KB per child slot (reclaimed on procDestroy)
JIT_ALLOC_MAX       = 64 * 1024          // 64 KB max single allocation

// Compilation policy
JIT_THRESHOLD       = 100    // calls before compilation attempt
MAX_DEOPTS          = 3      // deopt count before permanent blacklist
SPECULATION_WINDOW  = 8      // consecutive calls with same types required

// JSValue layout (i686, NaN-boxing — VERIFIED)
JSVALUE_SIZE        = 8      // bytes per JSValue (uint64_t)
JS_TAG_INT          = 0      // integer tag (upper 32 bits)
JS_TAG_BOOL         = 1      // boolean tag
JS_TAG_NULL         = 2      // null tag
JS_TAG_UNDEFINED    = 3      // undefined tag
JS_TAG_FLOAT64      = 8      // float64 tag threshold (tag >= 8 means float64)
JS_TAG_OBJECT       = -1     // object tag (0xFFFFFFFF in upper 32 bits)
JS_TAG_STRING       = -7     // string tag

// JSObject layout (VERIFIED)
JSOBJECT_SHAPE_OFF  = 20     // 0x14 — JSObject.shape offset
SIZEOF_JSOBJECT     = 40     // 0x28

// Sentinel values
DEOPT_SENTINEL      = 0x7FFFDEAD
```

---

## Timeline Summary

| Step | Description | Effort | Depends On |
|---|---|---|---|
| 1 | JIT pool expansion to 12 MB | 0.5 days | — |
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
| 1 | Boot OS, run existing canvas ops | JIT pool is 12 MB, all pixel ops work |
| 2 | `kernel.readPhysMem(addr, 16)` in REPL | Returns ArrayBuffer with correct bytes |
| 5 | Compile function, call 101 times | Hook fires, serial shows "[QJS-JIT] Hook fired" |
| 7 | `new QJSBytecodeReader(addr).dump()` | Shows arg_count, var_count, bytecodeLen |
| 9 | Compile `function(a,b){return a+b}` | Native code generated, serial shows compilation |
| 11 | `fib(20)` with JIT enabled | Correct result (6765), JIT stats show compilation |
| 12 | `sumRange(1000000)` benchmark | >10× speedup vs interpreter |
| 13 | Animation lerp benchmark | Float64 functions JIT-compiled |
| 14 | React reconciler property access | Measurably faster with ICs |
