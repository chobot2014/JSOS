/*
 * apic.h — Local APIC + I/O APIC interface
 *
 * Items implemented here:
 *   24  APIC initialisation (local APIC + I/O APIC)
 *   28  IOAPIC RedTable programming for all ISA IRQs
 *   30  x2APIC support
 *   31  SMP: inter-processor interrupts (IPI)
 *   49  APIC timer for per-CPU preemption
 */
#ifndef APIC_H
#define APIC_H

#include <stdint.h>

/* ── LAPIC MMIO register offsets ────────────────────────────────────────── */
#define LAPIC_ID            0x020u
#define LAPIC_VER           0x030u
#define LAPIC_TPR           0x080u
#define LAPIC_APR           0x090u
#define LAPIC_PPR           0x0A0u
#define LAPIC_EOI           0x0B0u
#define LAPIC_LDR           0x0D0u
#define LAPIC_DFR           0x0E0u
#define LAPIC_SVR           0x0F0u
#define LAPIC_ISR_BASE      0x100u
#define LAPIC_IRR_BASE      0x200u
#define LAPIC_ESR           0x280u
#define LAPIC_ICR_LO        0x300u
#define LAPIC_ICR_HI        0x310u
#define LAPIC_LVT_TIMER     0x320u
#define LAPIC_LVT_THERMAL   0x330u
#define LAPIC_LVT_PERF      0x340u
#define LAPIC_LVT_LINT0     0x350u
#define LAPIC_LVT_LINT1     0x360u
#define LAPIC_LVT_ERROR     0x370u
#define LAPIC_TIMER_ICR     0x380u  /* initial count */
#define LAPIC_TIMER_CCR     0x390u  /* current count */
#define LAPIC_TIMER_DCR     0x3E0u  /* divide config */

/* SVR */
#define LAPIC_SVR_ENABLE    (1u << 8)
#define LAPIC_SPURIOUS_VEC  0xFFu

/* ICR delivery modes / shortcuts */
#define LAPIC_ICR_FIXED         0x000000u
#define LAPIC_ICR_DELIVER_STAT  (1u << 12)          /* delivery pending */
#define LAPIC_ICR_ALLEXSELF     (3u << 18)          /* all-excluding-self shorthand */

/* LVT timer mode bits */
#define LAPIC_TIMER_PERIODIC    (1u << 17)
#define LAPIC_LVT_MASKED        (1u << 16)

/* APIC timer divide values for DCR */
#define LAPIC_DCR_DIV1      0x0Bu
#define LAPIC_DCR_DIV16     0x03u

/* ── I/O APIC register indices ──────────────────────────────────────────── */
#define IOAPIC_REGSEL       0x00u   /* index register (byte offset in MMIO) */
#define IOAPIC_WIN          0x10u   /* data window */
#define IOAPIC_REG_ID       0x00u
#define IOAPIC_REG_VER      0x01u
#define IOAPIC_REDTBL_BASE  0x10u   /* REDTBL[n] = 0x10 + 2*n (lo), 0x10+2*n+1 (hi) */

/* ── API ─────────────────────────────────────────────────────────────────── */

/* Local APIC (item 24) */
void     apic_init(void);                       /* enable LAPIC, mask PIC 8259 */
void     apic_eoi(void);                        /* send end-of-interrupt */
uint32_t apic_local_id(void);                   /* read ID field */
uint32_t apic_base_addr(void);                  /* physical base from MSR */

/* APIC timer (item 49) */
void     apic_timer_calibrate(void);            /* calibrate ticks/ms using PIT */
void     apic_timer_start_periodic(uint32_t ms);/* arm periodic mode */
void     apic_timer_stop(void);                 /* mask LVT_TIMER */
uint32_t apic_timer_ticks_per_ms(void);         /* cached calibration result */

/* I/O APIC (item 28) */
void     ioapic_init(uint32_t mmio_base);       /* init + map ISA IRQs 0-15 */
void     ioapic_mask_irq(uint8_t irq);
void     ioapic_unmask_irq(uint8_t irq);
void     ioapic_route_irq(uint8_t irq, uint8_t vector, uint8_t dest_lapic_id);

/* x2APIC (item 30) */
int      apic_x2_supported(void);              /* CPUID 1 ECX bit 21 */
void     apic_x2_enable(void);                 /* set IA32_APIC_BASE bit 10 */
void     apic_x2_eoi(void);                    /* WRMSR 0x80B, 0 */

/* IPI (item 31) */
void     apic_send_ipi(uint8_t dest_lapic_id, uint8_t vector);
void     apic_send_ipi_allexself(uint8_t vector);
void     apic_send_init_ipi(uint8_t dest_id);
void     apic_send_startup_ipi(uint8_t dest_id, uint8_t page); /* page = trampoline >> 12 */

#endif /* APIC_H */
