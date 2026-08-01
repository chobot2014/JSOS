/*
 * kprobes.h — kprobes / ftrace-style kernel function tracing (item 110)
 *
 * Minimal kprobes implementation:
 *  - Register a probe at a kernel function address
 *  - On first execution after registration, INT3 fires ISR 3
 *  - ISR 3 handler calls the kprobe callback then single-steps over the
 *    saved original byte (using INT1 hardware single-step)
 *  - Probe can be disabled/removed cleanly
 *
 * ARCHITECTURE CONSTRAINT: All tracing analysis logic lives in TypeScript.
 * This C module only provides the mechanism (byte patching + INT3 handler).
 */
#ifndef KPROBES_H
#define KPROBES_H

#include <stdint.h>

/* ── Probe callback ─────────────────────────────────────────────────────── */
/**
 * Called synchronously (in interrupt context!) when the probe fires.
 * @param addr    Address of the probed instruction.
 * @param eip     EIP at probe entry (= addr).
 * @param user    Opaque pointer registered with the probe.
 */
typedef void (*kprobe_handler_t)(uint32_t addr, uint32_t eip, void *user);

/* ── kprobe descriptor ──────────────────────────────────────────────────── */
#define KPROBE_MAX  32   /* maximum simultaneous probes */

typedef struct {
    uint32_t         addr;      /* probe site address (0 = slot free) */
    uint8_t          orig_byte; /* original byte at addr (saved on arm) */
    kprobe_handler_t handler;   /* called when INT3 fires */
    void            *user;      /* user data passed to handler */
    int              armed;     /* 1 = INT3 is patched in, 0 = disabled */
    uint32_t         hit_count; /* number of times the probe has fired */
} kprobe_t;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Initialise the kprobes subsystem.  Must be called after IDT is set up
 * (after irq_initialize()).  Installs #BP (INT3) and #DB (INT1) handlers
 * that forward to the kprobes engine.
 */
void kprobes_init(void);

/**
 * Register and arm a kprobe at the given kernel address.
 * Saves the original byte, writes 0xCC (INT3) in its place.
 * @returns Pointer to the probe descriptor, or NULL if KPROBE_MAX is reached.
 */
kprobe_t *kprobe_register(uint32_t addr, kprobe_handler_t handler, void *user);

/**
 * Disarm a probe: restore the original byte.  The descriptor is freed.
 */
void kprobe_unregister(kprobe_t *kp);

/**
 * Disarm all probes (useful during shutdown or panic).
 */
void kprobes_disable_all(void);

/**
 * Lookup the kprobe registered at addr (0 if none).
 */
kprobe_t *kprobe_find(uint32_t addr);

/**
 * Dump all registered probes to COM1 serial port.
 */
void kprobes_dump(void);

#endif /* KPROBES_H */
