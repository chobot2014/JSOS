/*
 * JSOS JIT Compiler — pool allocator and call trampoline (Phase 11)
 *
 * All BSS memory on this bare-metal x86 target is execute+read+write;
 * the flat GDT code segment covers the full 4 GB physical address space.
 * No mprotect or page-table manipulation is required.
 */

#include "jit.h"
#include <string.h>

/* ── Pool layout (12 MB total) ──────────────────────────────────────────── */

#define JIT_POOL_SIZE     (12u * 1024u * 1024u)  /* 12 MB total              */
#define JIT_MAIN_SIZE     (8u  * 1024u * 1024u)  /* 8 MB for main runtime    */
#define JIT_PROC_SLOTS    8u
#define JIT_PROC_SIZE     (512u * 1024u)          /* 512 KB per child process */

_Static_assert(JIT_MAIN_SIZE + JIT_PROC_SLOTS * JIT_PROC_SIZE == JIT_POOL_SIZE,
               "JIT pool partition sizes do not add up");

/* 16-byte aligned so the first allocation is instruction-cache-line-aligned. */
static uint8_t  __attribute__((aligned(16))) _jit_pool[JIT_POOL_SIZE];
static uint32_t _jit_main_used = 0;
static uint32_t _jit_proc_used[JIT_PROC_SLOTS];

/* ── Public API ──────────────────────────────────────────────────────────── */

void *jit_alloc(size_t size) {
    if (size == 0 || size > JIT_ALLOC_MAX) return NULL;
    size_t aligned = (size + 15u) & ~15u;
    if (_jit_main_used + aligned > JIT_MAIN_SIZE) return NULL;
    void *p = (void *)(_jit_pool + _jit_main_used);
    _jit_main_used += (uint32_t)aligned;
    return p;
}

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

void jit_proc_reset(int id) {
    if (id >= 0 && (unsigned)id < JIT_PROC_SLOTS)
        _jit_proc_used[id] = 0;
}

uint32_t jit_proc_used_bytes(int id) {
    if (id < 0 || (unsigned)id >= JIT_PROC_SLOTS) return 0;
    return _jit_proc_used[id];
}

void jit_write(void *dst, const uint8_t *src, size_t len) {
    if (!dst || !src || len == 0) return;
    /*
     * x86 has coherent instruction and data caches; a plain memcpy is all
     * that is required to make freshly written machine code executable.
     * (A CPUID serialisation or MFENCE is not needed on modern Intel/AMD.)
     */
    memcpy(dst, src, len);
}

int32_t jit_call_i4(void *fn, int32_t a0, int32_t a1, int32_t a2, int32_t a3) {
    typedef int32_t (*fn_t)(int32_t, int32_t, int32_t, int32_t);
    return ((fn_t)fn)(a0, a1, a2, a3);
}

int32_t jit_call_i8(void *fn,
                    int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5, int32_t a6, int32_t a7) {
    typedef int32_t (*fn_t)(int32_t, int32_t, int32_t, int32_t,
                            int32_t, int32_t, int32_t, int32_t);
    return ((fn_t)fn)(a0, a1, a2, a3, a4, a5, a6, a7);
}

uint32_t jit_used_bytes(void) {
    return _jit_main_used;
}

/*
 * Reset the main JIT pool bump pointer to zero, reclaiming all 8 MB.
 * The caller is responsible for clearing all jit_native_ptr fields in
 * JSFunctionBytecode structs before calling this — otherwise stale native
 * pointers will be called on re-entry.  (TypeScript QJSJITHook does this.)
 */
void jit_main_reset(void) {
    _jit_main_used = 0;
}
