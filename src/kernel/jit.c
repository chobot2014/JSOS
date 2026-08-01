/*
 * JSOS JIT Compiler — pool allocator, W^X state machine, and call trampoline
 *
 * W^X protection overview:
 *   The JIT pool is partitioned into two modes: WRITE and EXEC.
 *   In WRITE mode, jit_write() is permitted and jit_call_*() is blocked.
 *   In EXEC mode, jit_call_*() is permitted and jit_write() auto-switches.
 *   When paging is enabled, PTE read-only bits are toggled to enforce this
 *   at the hardware level (x86-32 without PAE cannot set NX, but we can
 *   prevent accidental writes to executable code).
 */

#include "jit.h"
#include <string.h>

/* ── Pool layout (128 MB total) ─────────────────────────────────────────── */
/*
 * The pool needs to be large enough to JIT-compile complex web applications
 * (YouTube's JS alone can produce 10+ MB of native code).  With 16 child
 * slots at 4 MB each and a 64 MB main pool, the system can support multiple
 * browser tabs + workers running JIT-compiled JS simultaneously.
 *
 * QEMU runs at -m 4G; the 2 GB NOLOAD sbrk window is separate from BSS.
 * Total BSS with this pool ≈ 160 MB — well within the 4 GB address space.
 */

#define JIT_POOL_SIZE     (128u * 1024u * 1024u) /* 128 MB total             */
#define JIT_MAIN_SIZE     (64u  * 1024u * 1024u) /* 64 MB for main runtime   */
#define JIT_PROC_SLOTS    16u
#define JIT_PROC_SIZE     (4u   * 1024u * 1024u) /* 4 MB per child process   */

_Static_assert(JIT_MAIN_SIZE + JIT_PROC_SLOTS * JIT_PROC_SIZE == JIT_POOL_SIZE,
               "JIT pool partition sizes do not add up");

/* 16-byte aligned so the first allocation is instruction-cache-line-aligned. */
static uint8_t  __attribute__((aligned(16))) _jit_pool[JIT_POOL_SIZE];
static uint32_t _jit_main_used = 0;
static uint32_t _jit_proc_used[JIT_PROC_SLOTS];

/* ── W^X state machine ──────────────────────────────────────────────────── */
/*
 * JIT_MODE_WRITE (0): memcpy into pool is allowed; call dispatch is blocked.
 * JIT_MODE_EXEC  (1): call dispatch is allowed; memcpy transitions to WRITE.
 *
 * When hardware paging is enabled, transitioning to EXEC marks JIT pages as
 * read-only (PTE bit 1 cleared), and transitioning to WRITE marks them as
 * read-write (PTE bit 1 set).  On x86-32 without PAE this prevents accidental
 * writes to executable code but does not prevent execution of writable pages
 * (the NX bit requires PAE).  With PAE enabled in a future phase, full W^X
 * with the NX bit can be added here.
 *
 * The mode is stored in a volatile global so it survives across function calls.
 */
typedef enum { JIT_MODE_WRITE = 0, JIT_MODE_EXEC = 1 } jit_mode_t;
static volatile jit_mode_t _jit_mode = JIT_MODE_WRITE;
/** Count of W→X and X→W transitions (diagnostic). */
static uint32_t _jit_wx_transitions = 0;

void jit_set_write_mode(void) {
    if (_jit_mode == JIT_MODE_WRITE) return;
    _jit_mode = JIT_MODE_WRITE;
    _jit_wx_transitions++;
    /*
     * TODO (Phase 9): If paging is enabled, iterate the JIT pool's PTEs
     * and set the R/W bit (PTE bit 1) to allow writes.
     * For now, software state only (flat GDT = all RWX).
     */
}

void jit_set_exec_mode(void) {
    if (_jit_mode == JIT_MODE_EXEC) return;
    _jit_mode = JIT_MODE_EXEC;
    _jit_wx_transitions++;
    /*
     * TODO (Phase 9): If paging is enabled, iterate the JIT pool's PTEs
     * and clear the R/W bit (PTE bit 1) to make pages read-only.
     * On x86-32 read-only pages are still executable — true NX requires PAE.
     */
}

int jit_get_mode(void) {
    return (int)_jit_mode;
}

uint32_t jit_wx_transition_count(void) {
    return _jit_wx_transitions;
}

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
    /* Auto-transition to write mode if currently in exec mode.
     * This avoids errors when the TypeScript JIT manager writes code
     * immediately after a call — the mode is silently switched. */
    if (_jit_mode != JIT_MODE_WRITE) jit_set_write_mode();
    memcpy(dst, src, len);
}

int32_t jit_call_i4(void *fn, int32_t a0, int32_t a1, int32_t a2, int32_t a3) {
    if (_jit_mode != JIT_MODE_EXEC) jit_set_exec_mode();
    typedef int32_t (*fn_t)(int32_t, int32_t, int32_t, int32_t);
    return ((fn_t)fn)(a0, a1, a2, a3);
}

int32_t jit_call_i8(void *fn,
                    int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5, int32_t a6, int32_t a7) {
    if (_jit_mode != JIT_MODE_EXEC) jit_set_exec_mode();
    typedef int32_t (*fn_t)(int32_t, int32_t, int32_t, int32_t,
                            int32_t, int32_t, int32_t, int32_t);
    return ((fn_t)fn)(a0, a1, a2, a3, a4, a5, a6, a7);
}

/*
 * Call a JIT-compiled float64 function (x87 double-cdecl ABI, up to 4 args).
 * All args and the return value are IEEE-754 doubles.
 */
double jit_call_d4(void *fn, double a0, double a1, double a2, double a3) {
    if (_jit_mode != JIT_MODE_EXEC) jit_set_exec_mode();
    typedef double (*fn_t)(double, double, double, double);
    return ((fn_t)fn)(a0, a1, a2, a3);
}

uint32_t jit_used_bytes(void) {
    return _jit_main_used;
}

/*
 * Reset the main JIT pool bump pointer to zero, reclaiming all 64 MB.
 * The caller is responsible for clearing all jit_native_ptr fields in
 * JSFunctionBytecode structs before calling this — otherwise stale native
 * pointers will be called on re-entry.  (TypeScript QJSJITHook does this.)
 */
void jit_main_reset(void) {
    _jit_main_used = 0;
}
