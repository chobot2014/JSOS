/*
 * hpet.h  —  High Precision Event Timer (HPET) interface (item 47)
 *
 * HPET is a 64-bit free-running counter whose frequency is specified in the
 * capabilities register and typically ranges from 10 MHz to 100 MHz.
 *
 * Usage:
 *   1. Locate the HPET MMIO base from the ACPI "HPET" table.
 *   2. Call hpet_init(mmio_base) to enable the main counter.
 *   3. Use hpet_read_counter() for timestamps and hpet_frequency() for scaling.
 *
 * Architecture constraint: C code only reads/writes MMIO registers.  All
 * higher-level timer logic (alarm queues, nanosecond clocks, etc.) lives in
 * TypeScript via the kernel.hpetRead() / kernel.hpetFreq() JS bindings.
 */

#ifndef HPET_H
#define HPET_H

#include <stdint.h>

/* HPET MMIO register offsets (from base address) */
#define HPET_REG_GCAP_ID        0x000u  /* General Capabilities + ID (64-bit) */
#define HPET_REG_GEN_CONFIG     0x010u  /* General Configuration (64-bit)      */
#define HPET_REG_GEN_INT_STATUS 0x020u  /* General Interrupt Status (64-bit)  */
#define HPET_REG_MAIN_CNT       0x0F0u  /* Main Counter Value (64-bit)         */

/* Bit definitions in HPET_REG_GCAP_ID */
#define HPET_CAP_PERIOD_SHIFT   32      /* bits [63:32] = counter period in fs */
#define HPET_CAP_NUM_TIM_SHIFT  8       /* bits [12:8]  = number of timers - 1 */
#define HPET_CAP_64BIT          (1u << 13)  /* main counter is 64-bit          */

/* Bit definitions in HPET_REG_GEN_CONFIG */
#define HPET_CONFIG_ENABLE      (1u << 0)   /* ENABLE_CNF: enable main counter  */
#define HPET_CONFIG_LEGACY      (1u << 1)   /* LEG_RT_CNF: legacy replacement  */

/* ── Public API ─────────────────────────────────────────────────────────── */

/* Initialise the HPET at the given MMIO base address (from ACPI table).
 * Enables the main counter and records the calibrated frequency.
 * Returns 0 on success, -1 if the MMIO base is zero or HPET not present.   */
int hpet_init(uint32_t mmio_base);

/* Read the current 64-bit main counter value.
 * Returns 0 if hpet_init() has not been successfully called.               */
uint64_t hpet_read_counter(void);

/* Read the 32-bit lower half of the main counter (safe on 32-bit CPUs
 * without a 64-bit MMIO atomic read).                                       */
uint32_t hpet_read_counter32(void);

/* Return the HPET frequency in Hz (e.g. 14318180 for 14.3 MHz).
 * Returns 0 if not initialised.                                             */
uint32_t hpet_frequency(void);

/* Convert a raw counter delta to nanoseconds.                               */
uint64_t hpet_ticks_to_ns(uint64_t ticks);

#endif /* HPET_H */
