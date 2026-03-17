/*
 * kprobes.c — kprobes / ftrace-style kernel tracing (item 110)
 *
 * Implementation:
 *  1. kprobe_register():  save original byte at addr; write 0xCC (INT3).
 *  2. kprobes_bp_handler(): called by the #BP ISR 3 handler.
 *     - Look up probe at EIP-1 (INT3 is 1 byte; CPU bumps EIP past it).
 *     - Call user handler, restore orig_byte, set EFLAGS.TF for single-step.
 *  3. kprobes_db_handler(): called by the #DB ISR 1 handler (single-step).
 *     - Re-arm the INT3 (write 0xCC back).
 *     - Clear EFLAGS.TF.
 *
 * NOTE: This is single-CPU, non-preemptive.  SMP-safe probes require
 * per-CPU stop-machine which is deferred to the TypeScript SMP layer.
 */

#include "kprobes.h"
#include "platform.h"
#include "io.h"
#include <stdint.h>
#include <string.h>

/* ── Probe table ─────────────────────────────────────────────────────────── */

static kprobe_t _probes[KPROBE_MAX];

/* ── Private helpers ─────────────────────────────────────────────────────── */

static inline void _write_byte(uint32_t addr, uint8_t byte) {
    *(volatile uint8_t *)addr = byte;
}

static inline uint8_t _read_byte(uint32_t addr) {
    return *(volatile uint8_t *)addr;
}

/* Find a free slot */
static kprobe_t *_alloc_slot(void) {
    for (int i = 0; i < KPROBE_MAX; i++) {
        if (!_probes[i].addr) return &_probes[i];
    }
    return 0;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

void kprobes_init(void) {
    memset(_probes, 0, sizeof(_probes));
    /* ISR 3 (#BP) and ISR 1 (#DB) are already wired in irq_asm.s/irq.c.
     * The exception_dispatch path calls kprobes_bp_handler / kprobes_db_handler
     * when vector == 3 or vector == 1 and kprobes has a probe registered.
     * No additional IDT manipulation needed here.             */
}

kprobe_t *kprobe_register(uint32_t addr, kprobe_handler_t handler, void *user) {
    if (!addr || !handler) return 0;
    /* Check not already probed */
    if (kprobe_find(addr)) return 0;

    kprobe_t *kp = _alloc_slot();
    if (!kp) return 0;

    kp->addr      = addr;
    kp->orig_byte = _read_byte(addr);
    kp->handler   = handler;
    kp->user      = user;
    kp->armed     = 1;
    kp->hit_count = 0u;

    /* Arm: overwrite with INT3 */
    _write_byte(addr, 0xCCu);
    return kp;
}

void kprobe_unregister(kprobe_t *kp) {
    if (!kp || !kp->addr) return;
    /* Restore original byte */
    _write_byte(kp->addr, kp->orig_byte);
    kp->armed = 0;
    kp->addr  = 0u;
}

void kprobes_disable_all(void) {
    for (int i = 0; i < KPROBE_MAX; i++) {
        if (_probes[i].addr && _probes[i].armed) {
            _write_byte(_probes[i].addr, _probes[i].orig_byte);
            _probes[i].armed = 0;
        }
    }
}

kprobe_t *kprobe_find(uint32_t addr) {
    for (int i = 0; i < KPROBE_MAX; i++) {
        if (_probes[i].addr == addr) return &_probes[i];
    }
    return 0;
}

/* ── BP / DB handlers (called from exception_dispatch — not from here) ──── */

/**
 * Called by exception_dispatch when vector == 3 (#BP).
 * `eip_ptr` points to the saved EIP on the exception frame.
 * Returns 1 if handled by kprobes (resume), 0 if not a kprobe (let panic).
 */
int kprobes_bp_handler(uint32_t *eip_ptr, uint32_t *eflags_ptr) {
    /* INT3 is a single byte; CPU already incremented EIP past the 0xCC */
    uint32_t probe_addr = *eip_ptr - 1u;
    kprobe_t *kp = kprobe_find(probe_addr);
    if (!kp) return 0;   /* not ours — let exception_dispatch handle */

    kp->hit_count++;

    /* Call user handler */
    kp->handler(probe_addr, *eip_ptr, kp->user);

    /* Restore original byte so execution can proceed */
    _write_byte(probe_addr, kp->orig_byte);
    kp->armed = 0;

    /* Step back EIP to re-execute the original instruction */
    *eip_ptr = probe_addr;

    /* Set EFLAGS.TF (bit 8) to single-step; DB handler will re-arm */
    *eflags_ptr |= (1u << 8u);

    return 1;   /* handled */
}

/**
 * Called by exception_dispatch when vector == 1 (#DB) and kprobes is active.
 * Returns 1 if this was a kprobes single-step event, 0 otherwise.
 */
int kprobes_db_handler(uint32_t eip, uint32_t *eflags_ptr) {
    /* After the original instruction executes, look for any unregistered
     * probe whose addr+1 == eip (i.e. we just stepped past a 1-byte insn).
     * Real kprobes tracks "probe-in-single-step" state separately; for our
     * minimal implementation we re-arm any disarmed probe at eip-1.    */
    kprobe_t *kp = kprobe_find(eip - 1u);
    if (!kp) kp = kprobe_find(eip);   /* probe on a 2+ byte insn */
    if (!kp) return 0;

    if (!kp->armed) {
        /* Re-arm: put INT3 back */
        _write_byte(kp->addr, 0xCCu);
        kp->armed = 1;
    }

    /* Clear TF */
    *eflags_ptr &= ~(1u << 8u);
    return 1;
}

/* ── Probe dump ──────────────────────────────────────────────────────────── */

static void _hex32(uint32_t v) {
    char buf[9]; buf[8] = '\0';
    for (int i = 7; i >= 0; i--) {
        int n = v & 0xFu; v >>= 4u;
        buf[i] = (char)(n < 10 ? '0' + n : 'a' + n - 10);
    }
    platform_serial_puts(buf);
}

void kprobes_dump(void) {
    platform_serial_puts("[kprobes] active probes:\n");
    for (int i = 0; i < KPROBE_MAX; i++) {
        if (!_probes[i].addr) continue;
        platform_serial_puts("  [");
        _hex32(_probes[i].addr);
        platform_serial_puts("] armed=");
        platform_serial_puts(_probes[i].armed ? "1" : "0");
        platform_serial_puts(" hits=");
        _hex32(_probes[i].hit_count);
        platform_serial_puts("\n");
    }
}
