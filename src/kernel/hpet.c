/*
 * hpet.c  —  High Precision Event Timer implementation (item 47)
 *
 * C code responsibility: MMIO register access only.
 * Timer algorithms, nanosecond clock, alarm queues → TypeScript.
 */

#include "hpet.h"
#include "platform.h"
#include <stdint.h>

/* HPET state */
static volatile uint32_t *_hpet_base32 = (volatile uint32_t *)0uL; /* mapped base */
static uint32_t  _hpet_freq    = 0;    /* Hz                                   */
static uint64_t  _hpet_period  = 0;    /* femtoseconds per tick                */

/* Read a 64-bit HPET register by accessing two 32-bit halves.
 * The HPET spec allows 32-bit reads of 64-bit registers.                    */
static uint64_t _hpet_read64(uint32_t offset) {
    uint32_t lo = _hpet_base32[(offset + 0) / 4];
    uint32_t hi = _hpet_base32[(offset + 4) / 4];
    return ((uint64_t)hi << 32) | (uint64_t)lo;
}

/* Write a 64-bit HPET register (low 32 bits only — sufficient for config). */
static void _hpet_write32(uint32_t offset, uint32_t val) {
    _hpet_base32[offset / 4] = val;
}

int hpet_init(uint32_t mmio_base) {
    if (!mmio_base) return -1;

    _hpet_base32 = (volatile uint32_t *)mmio_base;

    /* Read General Capabilities register (64-bit, offset 0) */
    uint64_t gcap  = _hpet_read64(HPET_REG_GCAP_ID);

    /* Counter period is in femtoseconds (1e-15 s), stored in bits [63:32] */
    _hpet_period = gcap >> 32;
    if (_hpet_period == 0 || _hpet_period > 0x05F5E100uLL) {
        /* Period > 100 ns is implausible; HPET not present */
        _hpet_base32 = (volatile uint32_t *)0uL;
        return -1;
    }

    /* Frequency [Hz] = 10^15 / period [fs]
     * Use 32-bit math only (period is typically ~69 841 279 fs ≈ 14.3 MHz).
     * Split: freq = 1_000_000_000 / (period / 1_000_000) but avoid integer 
     * truncation issues — multiply the dividend up first.                   */
    uint64_t freq64 = 1000000000000000ULL / _hpet_period;  /* exact Hz     */
    _hpet_freq = (freq64 > 0xFFFFFFFFuLL) ? 0xFFFFFFFFu : (uint32_t)freq64;

    /* Disable the main counter, clear legacy replacement mode               */
    _hpet_write32(HPET_REG_GEN_CONFIG, 0);
    _hpet_write32(HPET_REG_MAIN_CNT,   0);    /* reset counter to 0         */
    _hpet_write32(HPET_REG_MAIN_CNT + 4, 0);

    /* Enable main counter (not legacy mode)                                 */
    _hpet_write32(HPET_REG_GEN_CONFIG, HPET_CONFIG_ENABLE);

    platform_serial_puts("[HPET] initialised, freq=");
    /* Quick ASCII decimal print for freq */
    char buf[12];
    uint32_t f = _hpet_freq;
    int i = 0;
    if (f == 0) { buf[i++] = '0'; }
    else {
        char tmp[10]; int t = 0;
        while (f > 0) { tmp[t++] = '0' + (f % 10); f /= 10; }
        while (t > 0) buf[i++] = tmp[--t];
    }
    buf[i++] = ' '; buf[i++] = 'H'; buf[i++] = 'z'; buf[i++] = '\n';
    buf[i] = '\0';
    platform_serial_puts(buf);

    return 0;
}

uint64_t hpet_read_counter(void) {
    if (!_hpet_base32) return 0;
    return _hpet_read64(HPET_REG_MAIN_CNT);
}

uint32_t hpet_read_counter32(void) {
    if (!_hpet_base32) return 0;
    return _hpet_base32[HPET_REG_MAIN_CNT / 4];
}

uint32_t hpet_frequency(void) {
    return _hpet_freq;
}

uint64_t hpet_ticks_to_ns(uint64_t ticks) {
    if (_hpet_freq == 0) return 0;
    /* ns = ticks * 1e9 / freq
     * Split to avoid overflow: seconds part + sub-second part            */
    uint64_t sec_ticks = ticks / (uint64_t)_hpet_freq;
    uint64_t rem_ticks = ticks % (uint64_t)_hpet_freq;
    return sec_ticks * 1000000000ULL
           + (rem_ticks * 1000000000ULL) / (uint64_t)_hpet_freq;
}
