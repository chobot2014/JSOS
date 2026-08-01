/*
 * selftest.h — Kernel boot self-test suite (item 108)
 *
 * Activated when the kernel command line includes "--selftest".
 * All test results are logged to COM1 serial port.
 *
 * ARCHITECTURE CONSTRAINT: Only C-level hardware tests live here.
 * All OS-level test infrastructure (test runners, assertions, mocking)
 * lives in TypeScript via the test framework in src/os/.
 */
#ifndef SELFTEST_H
#define SELFTEST_H

#include <stdint.h>

/* ── Test result ────────────────────────────────────────────────────────── */
typedef struct {
    const char *name;       /* short test name */
    int         passed;     /* 1 = PASS, 0 = FAIL */
    const char *detail;     /* optional failure detail message */
} selftest_result_t;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Run all registered kernel self-tests.
 * Should be called from kernel_main() early in boot if `--selftest` cmdline
 * flag is present (use cmdline_has("selftest") to check).
 * Logs each test's PASS/FAIL status to COM1.
 * Returns the number of failed tests (0 = all passed).
 */
int selftest_run_all(void);

/**
 * Run only the tests matching the given prefix (e.g. "memory", "timer").
 * Returns the failed-test count.
 */
int selftest_run_prefix(const char *prefix);

/* ── Built-in test categories ───────────────────────────────────────────── */

/* Physical memory allocator tests (alloc/free/guard pages) */
int selftest_memory(void);

/* Timer tests: PIT tick count, TSC monotonicity */
int selftest_timer(void);

/* PIC / interrupt tests: IRQ mask/unmask round-trip */
int selftest_irq(void);

/* Serial output test (always passes, confirms COM1 is writable) */
int selftest_serial(void);

/* PCI enumeration sanity check */
int selftest_pci(void);

/* ACPI table validity check (checksum, RSDP magic) */
int selftest_acpi(void);

#endif /* SELFTEST_H */
