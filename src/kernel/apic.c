/*
 * apic.c — Local APIC + I/O APIC driver
 *
 * Items implemented:
 *   24  Local APIC enable; PIC 8259 disable
 *   28  I/O APIC RedTable: all ISA IRQs 0–15 mapped to vectors 32–47
 *   30  x2APIC mode enable + MSR-based EOI
 *   31  Inter-processor interrupts (IPI) via ICR
 *   49  APIC timer: calibrated periodic mode against PIT
 *
 * ARCHITECTURE CONSTRAINT: This file contains only C-level MMIO/MSR
 * register access.  All scheduling policy lives in TypeScript.
 */

#include "apic.h"
#include "io.h"
#include "timer.h"          /* timer_sleep_ms() for calibration */
#include <stdint.h>

/* ── LAPIC MMIO base ─────────────────────────────────────────────────────── */

static volatile uint32_t *_lapic = (volatile uint32_t *)0xFEE00000u;
static uint32_t           _lapic_phys = 0xFEE00000u;

static inline uint32_t _lapic_rd(uint32_t off) {
    return _lapic[off >> 2u];
}

static inline void _lapic_wr(uint32_t off, uint32_t val) {
    _lapic[off >> 2u] = val;
    (void)_lapic[off >> 2u];    /* flush write */
}

uint32_t apic_base_addr(void)
{
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0x1Bu));
    (void)hi;
    return lo & 0xFFFFF000u;
}

/* ── Local APIC (item 24) ───────────────────────────────────────────────── */

void apic_init(void)
{
    _lapic_phys = apic_base_addr();
    if (_lapic_phys)
        _lapic = (volatile uint32_t *)_lapic_phys;

    /* Disable legacy 8259 PIC: mask all IRQs on both chips */
    outb(0xA1, 0xFF);   /* slave  */
    io_wait();
    outb(0x21, 0xFF);   /* master */
    io_wait();

    /* Enable this LAPIC via the Spurious Interrupt Vector Register */
    _lapic_wr(LAPIC_SVR, LAPIC_SVR_ENABLE | LAPIC_SPURIOUS_VEC);

    /* Accept all interrupt classes: TPR = 0 */
    _lapic_wr(LAPIC_TPR, 0u);

    /* Clear any pending errors */
    _lapic_wr(LAPIC_ESR, 0u);
    _lapic_wr(LAPIC_ESR, 0u);

    /* Mask all local LVT entries except timer (handled separately) */
    _lapic_wr(LAPIC_LVT_LINT0,   LAPIC_LVT_MASKED);
    _lapic_wr(LAPIC_LVT_LINT1,   LAPIC_LVT_MASKED);
    _lapic_wr(LAPIC_LVT_THERMAL, LAPIC_LVT_MASKED);
    _lapic_wr(LAPIC_LVT_PERF,    LAPIC_LVT_MASKED);
    _lapic_wr(LAPIC_LVT_ERROR,   0x30u);   /* vector 0x30 for APIC errors */
}

void apic_eoi(void)
{
    _lapic_wr(LAPIC_EOI, 0u);
}

uint32_t apic_local_id(void)
{
    return _lapic_rd(LAPIC_ID) >> 24u;
}

/* ── APIC timer (item 49) ───────────────────────────────────────────────── */

#define APIC_TIMER_VECTOR   0x20u   /* reuse IRQ0 vector slot */
#define APIC_CAL_MS         10u     /* calibration window */

static uint32_t _ticks_per_ms = 0u;

void apic_timer_calibrate(void)
{
    /* Use the divide-by-16 configuration */
    _lapic_wr(LAPIC_TIMER_DCR, LAPIC_DCR_DIV16);

    /* Load max initial count and let the PIT fire after CAL_MS ms */
    _lapic_wr(LAPIC_LVT_TIMER, LAPIC_LVT_MASKED);  /* mask during calibration */
    _lapic_wr(LAPIC_TIMER_ICR, 0xFFFFFFFFu);

    /* Wait for calibration window using existing PIT-based sleep */
    timer_sleep_ms(APIC_CAL_MS);

    /* Read remaining count */
    uint32_t remaining = _lapic_rd(LAPIC_TIMER_CCR);
    uint32_t elapsed   = 0xFFFFFFFFu - remaining;

    _ticks_per_ms = elapsed / APIC_CAL_MS;

    /* Stop the timer */
    _lapic_wr(LAPIC_TIMER_ICR, 0u);
}

void apic_timer_start_periodic(uint32_t ms)
{
    if (!_ticks_per_ms) return;   /* not calibrated */
    _lapic_wr(LAPIC_TIMER_DCR, LAPIC_DCR_DIV16);
    _lapic_wr(LAPIC_LVT_TIMER, APIC_TIMER_VECTOR | LAPIC_TIMER_PERIODIC);
    _lapic_wr(LAPIC_TIMER_ICR, _ticks_per_ms * ms);
}

void apic_timer_stop(void)
{
    _lapic_wr(LAPIC_LVT_TIMER, LAPIC_LVT_MASKED);
    _lapic_wr(LAPIC_TIMER_ICR, 0u);
}

uint32_t apic_timer_ticks_per_ms(void)
{
    return _ticks_per_ms;
}

/* ── I/O APIC (item 28) ─────────────────────────────────────────────────── */

static volatile uint32_t *_ioapic = (volatile uint32_t *)0xFEC00000u;

static uint32_t _io_rd(uint8_t reg)
{
    _ioapic[IOAPIC_REGSEL >> 2u] = reg;
    return _ioapic[IOAPIC_WIN >> 2u];
}

static void _io_wr(uint8_t reg, uint32_t val)
{
    _ioapic[IOAPIC_REGSEL >> 2u] = reg;
    _ioapic[IOAPIC_WIN >> 2u]    = val;
}

void ioapic_init(uint32_t mmio_base)
{
    if (mmio_base) _ioapic = (volatile uint32_t *)mmio_base;

    /* Route all 16 ISA IRQs to vectors 32–47, masked, edge/high-active,
     * fixed delivery, destination = LAPIC ID 0.                          */
    for (uint8_t irq = 0u; irq < 16u; irq++) {
        uint8_t reg_lo = (uint8_t)(IOAPIC_REDTBL_BASE + 2u * irq);
        uint8_t reg_hi = reg_lo + 1u;
        _io_wr(reg_hi, 0u);                               /* dest = LAPIC 0 */
        _io_wr(reg_lo, (uint32_t)(32u + irq) | LAPIC_LVT_MASKED);
    }
}

void ioapic_mask_irq(uint8_t irq)
{
    uint8_t reg = (uint8_t)(IOAPIC_REDTBL_BASE + 2u * irq);
    _io_wr(reg, _io_rd(reg) | LAPIC_LVT_MASKED);
}

void ioapic_unmask_irq(uint8_t irq)
{
    uint8_t reg = (uint8_t)(IOAPIC_REDTBL_BASE + 2u * irq);
    _io_wr(reg, _io_rd(reg) & ~LAPIC_LVT_MASKED);
}

void ioapic_route_irq(uint8_t irq, uint8_t vector, uint8_t dest_lapic_id)
{
    uint8_t reg_lo = (uint8_t)(IOAPIC_REDTBL_BASE + 2u * irq);
    uint8_t reg_hi = reg_lo + 1u;
    /* Write hi first (destination), then lo (unmasked + vector) */
    _io_wr(reg_hi, (uint32_t)dest_lapic_id << 24u);
    _io_wr(reg_lo, (uint32_t)vector);     /* unmasked, fixed, edge, high-active */
}

/* ── x2APIC (item 30) ───────────────────────────────────────────────────── */

int apic_x2_supported(void)
{
    uint32_t ecx = 0u;
    __asm__ volatile("cpuid" : "=c"(ecx) : "a"(1u) : "ebx", "edx");
    return (int)((ecx >> 21u) & 1u);
}

void apic_x2_enable(void)
{
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0x1Bu));
    lo |= (1u << 10u);  /* EXTD bit: enable x2APIC */
    __asm__ volatile("wrmsr" : : "c"(0x1Bu), "a"(lo), "d"(hi));
}

void apic_x2_eoi(void)
{
    /* x2APIC EOI via MSR 0x80B */
    __asm__ volatile("wrmsr" : : "c"(0x80Bu), "a"(0u), "d"(0u));
}

/* ── IPI (item 31) ──────────────────────────────────────────────────────── */

void apic_send_ipi(uint8_t dest_lapic_id, uint8_t vector)
{
    /* Write destination first, then command (writing ICR_LO triggers send) */
    _lapic_wr(LAPIC_ICR_HI, (uint32_t)dest_lapic_id << 24u);
    _lapic_wr(LAPIC_ICR_LO, (uint32_t)vector | LAPIC_ICR_FIXED);
    /* Spin until delivery status clears (bit 12) */
    for (int i = 0; i < 10000; i++) {
        if (!(_lapic_rd(LAPIC_ICR_LO) & LAPIC_ICR_DELIVER_STAT)) break;
        io_wait();
    }
}

void apic_send_ipi_allexself(uint8_t vector)
{
    _lapic_wr(LAPIC_ICR_HI, 0u);
    _lapic_wr(LAPIC_ICR_LO, (uint32_t)vector | LAPIC_ICR_ALLEXSELF);
}

void apic_send_init_ipi(uint8_t dest_id)
{
    _lapic_wr(LAPIC_ICR_HI, (uint32_t)dest_id << 24u);
    /* INIT delivery mode = 0b101 << 8, assert level */
    _lapic_wr(LAPIC_ICR_LO, 0x00004500u);
    for (int i = 0; i < 20000; i++) {
        if (!(_lapic_rd(LAPIC_ICR_LO) & LAPIC_ICR_DELIVER_STAT)) break;
        io_wait();
    }
}

void apic_send_startup_ipi(uint8_t dest_id, uint8_t page)
{
    _lapic_wr(LAPIC_ICR_HI, (uint32_t)dest_id << 24u);
    /* Startup IPI: delivery mode = 0b110 << 8 */
    _lapic_wr(LAPIC_ICR_LO, 0x00004600u | page);
    for (int i = 0; i < 10000; i++) {
        if (!(_lapic_rd(LAPIC_ICR_LO) & LAPIC_ICR_DELIVER_STAT)) break;
        io_wait();
    }
}
