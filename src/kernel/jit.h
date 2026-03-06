/*
 * JSOS JIT Compiler — C interface
 *
 * Provides the primitives used by the TypeScript JIT runtime:
 *
 *   jit_alloc          — carve RWX memory from the 64 MB main BSS pool.
 *   jit_proc_alloc     — carve memory from a per-child 4 MB slab.
 *   jit_write          — bulk-copy machine code bytes into a JIT region.
 *   jit_call_i4    — call a JIT-compiled cdecl function with ≤4 int32 args.
 *   jit_used_bytes — diagnostic: bytes consumed in the pool.
 *   jit_set_write_mode — switch JIT pool to write mode (W^X).
 *   jit_set_exec_mode  — switch JIT pool to execute mode (W^X).
 *
 * W^X enforcement:
 *   The pool starts in WRITE mode.  Before calling JIT code, the runtime
 *   must switch to EXEC mode.  Before writing new code, switch to WRITE.
 *   Mode transitions are auto-performed for convenience (jit_write
 *   auto-switches to WRITE; jit_call_* auto-switch to EXEC).
 *
 * Pool layout: 128 MB total (64 MB main + 16 × 4 MB child slabs).
 */

#ifndef JIT_H
#define JIT_H

#include <stdint.h>
#include <stddef.h>

/* Maximum size of a single JIT allocation (64 KB). */
#define JIT_ALLOC_MAX  (64u * 1024u)

/*
 * Allocate `size` bytes of execute+read+write memory from the JIT pool.
 * Allocations are 16-byte aligned.  Returns NULL on failure (pool exhausted
 * or size > JIT_ALLOC_MAX).  There is no free — the pool is bump-allocated.
 */
void *jit_alloc(size_t size);

/*
 * Copy `len` bytes of machine code from `src` into `dst`.
 * `dst` must have been returned by jit_alloc().
 * On x86 (coherent I/D caches) a plain memcpy is sufficient.
 */
void jit_write(void *dst, const uint8_t *src, size_t len);

/*
 * Call the JIT-compiled function at `fn` with four 32-bit integer arguments
 * using the cdecl calling convention.  The function is expected to return
 * an int32 in EAX.  Unused arguments should be passed as 0.
 */
int32_t jit_call_i4(void *fn, int32_t a0, int32_t a1, int32_t a2, int32_t a3);

/*
 * Call the JIT-compiled function at `fn` with eight 32-bit integer arguments
 * using the cdecl calling convention.  Required for functions with 5–8 parameters
 * (e.g. fillRect, blitAlphaRect).  Unused arguments should be passed as 0.
 */
int32_t jit_call_i8(void *fn,
                    int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                    int32_t a4, int32_t a5, int32_t a6, int32_t a7);

/*
 * Call a JIT-compiled float64 function (x87 double-cdecl, up to 4 double args).
 * All args and the return value are IEEE-754 doubles.
 */
double jit_call_d4(void *fn, double a0, double a1, double a2, double a3);

/*
 * Return the number of bytes currently consumed in the main JIT pool.
 * The main pool capacity is 64 MB (67,108,864 bytes).
 */
uint32_t jit_used_bytes(void);

/*
 * Reset the main JIT pool bump pointer to zero, reclaiming all 64 MB.
 * Must only be called AFTER the TypeScript JIT manager has cleared all
 * live jit_native_ptr fields via kernel.setJITNative(addr, 0).
 */
void jit_main_reset(void);

/* Per-child-process JIT allocation and reclaim */
void    *jit_proc_alloc(int proc_id, size_t size);  /* allocate from child partition */
void     jit_proc_reset(int proc_id);               /* O(1) reclaim on procDestroy   */
uint32_t jit_proc_used_bytes(int proc_id);          /* diagnostic                    */

/* ── W^X state management ──────────────────────────────────────────────── */

/*
 * Switch the JIT pool into write mode.  After this call, jit_write() is
 * permitted.  When paging is enabled, PTEs are set to RW.
 */
void jit_set_write_mode(void);

/*
 * Switch the JIT pool into execute mode.  After this call, jit_call_*()
 * will dispatch.  When paging is enabled, PTEs are set to RO.
 */
void jit_set_exec_mode(void);

/*
 * Return current mode: 0 = WRITE, 1 = EXEC.
 */
int jit_get_mode(void);

/*
 * Return the total number of W↔X mode transitions (diagnostic).
 */
uint32_t jit_wx_transition_count(void);

#endif /* JIT_H */
