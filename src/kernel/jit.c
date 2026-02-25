/*
 * JSOS JIT Compiler — pool allocator and call trampoline (Phase 11)
 *
 * All BSS memory on this bare-metal x86 target is execute+read+write;
 * the flat GDT code segment covers the full 4 GB physical address space.
 * No mprotect or page-table manipulation is required.
 */

#include "jit.h"
#include <string.h>

/* ── Static 256 KB JIT code pool ─────────────────────────────────────────── */

#define JIT_POOL_SIZE  (256u * 1024u)

/* 16-byte aligned so the first allocation is instruction-cache-line-aligned. */
static uint8_t  __attribute__((aligned(16))) _jit_pool[JIT_POOL_SIZE];
static uint32_t _jit_used = 0;

/* ── Public API ──────────────────────────────────────────────────────────── */

void *jit_alloc(size_t size) {
    if (size == 0 || size > JIT_ALLOC_MAX) return 0;

    /* Round up to 16-byte boundary for instruction-cache alignment. */
    size_t aligned = (size + 15u) & ~15u;
    if (_jit_used + aligned > JIT_POOL_SIZE) return 0;

    void *p = (void *)(_jit_pool + _jit_used);
    _jit_used += (uint32_t)aligned;
    return p;
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
    return _jit_used;
}
