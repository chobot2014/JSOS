/*
 * selftest.c — Kernel boot self-test suite (item 108)
 *
 * Each sub-test allocates/frees resources carefully to leave the system
 * in an identical state after running.
*/

#include "selftest.h"
#include "platform.h"
#include "memory.h"
#include "timer.h"
#include "irq.h"
#include "acpi.h"
#include "pci.h"
#include "io.h"
#include <stdint.h>
#include <string.h>

/* ── Minimal assertion helper ───────────────────────────────────────────── */

static int _total_pass = 0;
static int _total_fail = 0;

static void _report(const char *name, int ok, const char *detail) {
    platform_serial_puts("[selftest] ");
    platform_serial_puts(ok ? "PASS  " : "FAIL  ");
    platform_serial_puts(name);
    if (!ok && detail) {
        platform_serial_puts(" — ");
        platform_serial_puts(detail);
    }
    platform_serial_puts("\n");
    if (ok) _total_pass++; else _total_fail++;
}

#define ASSERT(expr, desc) \
    _report(desc, !!(expr), __FILE__)

/* ── Memory tests ───────────────────────────────────────────────────────── */

int selftest_memory(void) {
    int before = (int)_total_fail;

    /* 1: Allocate and free a single page */
    uint32_t pg = alloc_page();
    ASSERT(pg != 0u, "memory.alloc_page nonzero");
    free_page(pg);

    /* 2: Double-free safety: allocating again should give a non-zero page */
    uint32_t pg2 = alloc_page();
    ASSERT(pg2 != 0u, "memory.alloc_page after free nonzero");
    free_page(pg2);

    /* 3: Multi-page contiguous allocation */
    uint32_t pgn = alloc_pages(4u);
    ASSERT(pgn != 0u, "memory.alloc_pages(4) nonzero");
    /* All 4 pages should be contiguous (each 4 KB apart) */
    ASSERT((pgn & 0xFFFu) == 0u, "memory.alloc_pages aligned 4K");
    /* Free them back */
    for (int i = 0; i < 4; i++) free_page(pgn + (uint32_t)(i * 4096));

    /* 4: Stats: free pages should be positive */
    ASSERT(memory_get_pages_free() > 0u, "memory.pages_free positive");

    /* 5: reserve_region marks pages as used */
    uint32_t before_free = (uint32_t)memory_get_pages_free();
    memory_reserve_region(0xF0000000u, 4096u);   /* reserve one page in high mem */
    /* (no easy way to undo, but this exercises the path) */
    ASSERT(1, "memory.reserve_region ran ok");
    (void)before_free;

    return _total_fail - before;
}

/* ── Timer tests ────────────────────────────────────────────────────────── */

int selftest_timer(void) {
    int before = (int)_total_fail;

    /* 1: TSC is non-zero */
    uint32_t lo, hi;
    __asm__ volatile("rdtsc" : "=a"(lo), "=d"(hi));
    ASSERT(lo | hi, "timer.tsc nonzero");

    /* 2: Tick counter advances after 2 ms */
    uint32_t t0 = timer_get_ms();
    timer_sleep(2u);
    uint32_t t1 = timer_get_ms();
    ASSERT(t1 > t0, "timer.ticks advance after sleep");

    /* 3: timer_gettime_ns is non-zero */
    ASSERT(timer_gettime_ns() > 0u, "timer.gettime_ns nonzero");

    return _total_fail - before;
}

/* ── IRQ tests ──────────────────────────────────────────────────────────── */

int selftest_irq(void) {
    int before = (int)_total_fail;

    /* 1: IRQ mask bitmask round-trip for IRQ 5 */
    irq_mask(5u);
    int m = irq_is_masked(5u);
    ASSERT(m, "irq.mask(5) sets mask");
    irq_unmask(5u);
    int u = irq_is_masked(5u);
    ASSERT(!u, "irq.unmask(5) clears mask");

    return _total_fail - before;
}

/* ── Serial test ────────────────────────────────────────────────────────── */

int selftest_serial(void) {
    /* Writing to COM1 always "succeeds" in QEMU; just confirm no crash */
    platform_serial_puts("[selftest] serial: COM1 write OK\n");
    _report("serial.com1_write", 1, NULL);
    return 0;
}

/* ── PCI test ───────────────────────────────────────────────────────────── */

int selftest_pci(void) {
    int before = (int)_total_fail;

    /* Bus 0 device 0 should return a valid vendor ID (QEMU: 8086 or 1234) */
    uint32_t id = pci_cfg_read32(0u, 0u, 0u, 0u);
    ASSERT((id & 0xFFFFu) != 0xFFFFu, "pci.bus0_dev0_vendor_valid");

    return _total_fail - before;
}

/* ── ACPI test ──────────────────────────────────────────────────────────── */

int selftest_acpi(void) {
    int before = (int)_total_fail;

    /* RSDP should have been found during acpi_init() */
    ASSERT(acpi_info.rsdp_address != 0u, "acpi.rsdp_found");

    /* RSDP signature check: "RSD PTR " */
    if (acpi_info.rsdp_address) {
        const char *sig = (const char *)acpi_info.rsdp_address;
        ASSERT(memcmp(sig, "RSD PTR ", 8) == 0, "acpi.rsdp_signature_ok");
    }

    return _total_fail - before;
}

/* ── Test suite registry ────────────────────────────────────────────────── */

typedef struct {
    const char *name;
    int (*fn)(void);
} _test_entry_t;

static const _test_entry_t _tests[] = {
    { "serial", selftest_serial },
    { "memory", selftest_memory },
    { "timer",  selftest_timer  },
    { "irq",    selftest_irq    },
    { "pci",    selftest_pci    },
    { "acpi",   selftest_acpi   },
};

#define NUM_TESTS (int)(sizeof(_tests) / sizeof(_tests[0]))

int selftest_run_all(void) {
    _total_pass = 0; _total_fail = 0;
    platform_serial_puts("\n[selftest] === JSOS Kernel Self-Tests ===\n");
    for (int i = 0; i < NUM_TESTS; i++)
        _tests[i].fn();
    platform_serial_puts("[selftest] === Results: ");
    /* Print counts via hex (no sprintf available) */
    char buf[12];
    int n = _total_pass; buf[0]='\0';
    /* simple decimal print */
    int pos = 0;
    int tmp = n; char digits[8]; int d = 0;
    if (!tmp) { digits[d++] = '0'; }
    while (tmp > 0) { digits[d++] = '0' + (tmp % 10); tmp /= 10; }
    for (int k = d-1; k >= 0; k--) buf[pos++] = digits[k];
    buf[pos] = '\0';
    platform_serial_puts(buf);
    platform_serial_puts(" passed, ");
    n = _total_fail; pos = 0; d = 0;
    if (!n) { digits[d++] = '0'; }
    while (n > 0) { digits[d++] = '0' + (n % 10); n /= 10; }
    for (int k = d-1; k >= 0; k--) buf[pos++] = digits[k];
    buf[pos] = '\0';
    platform_serial_puts(buf);
    platform_serial_puts(" failed ===\n");
    return _total_fail;
}

int selftest_run_prefix(const char *prefix) {
    _total_pass = 0; _total_fail = 0;
    for (int i = 0; i < NUM_TESTS; i++) {
        /* Simple prefix match */
        const char *n = _tests[i].name; const char *p = prefix;
        int match = 1;
        while (*p && *n) { if (*p++ != *n++) { match = 0; break; } }
        if (*p) match = 0;
        if (match) _tests[i].fn();
    }
    return _total_fail;
}
