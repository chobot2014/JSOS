
#include "timer.h"
#include "irq.h"
#include "io.h"
#include "watchdog.h"
#include <stddef.h>

/* PIT ports */
#define PIT_CHANNEL0  0x40
#define PIT_COMMAND   0x43

/* PIT base frequency */
#define PIT_BASE_FREQ 1193180

/* Timer state */
static volatile uint32_t timer_ticks = 0;
static uint32_t timer_freq = 0;

/* Preemption counter — incremented every IRQ0, read+reset by js_sched_tick()
 * in quickjs_binding.c.  JS can call kernel.schedTick() at any safe point to
 * discover how many ticks elapsed and voluntarily run the scheduler hook.    */
volatile uint32_t _preempt_counter = 0;

/* IRQ0 handler - timer interrupt */
static void timer_irq_handler(void) {
    timer_ticks++;
    _preempt_counter++;
    watchdog_tick();    /* decrement watchdog countdown every ms (item 107) */
}

void timer_initialize(uint32_t frequency_hz) {
    timer_freq = frequency_hz;
    timer_ticks = 0;
    
    /* Calculate the divisor */
    uint32_t divisor = PIT_BASE_FREQ / frequency_hz;
    
    /* Send command byte: channel 0, lobyte/hibyte, rate generator */
    outb(PIT_COMMAND, 0x36);
    
    /* Send divisor */
    outb(PIT_CHANNEL0, (uint8_t)(divisor & 0xFF));
    outb(PIT_CHANNEL0, (uint8_t)((divisor >> 8) & 0xFF));
    
    /* Install timer IRQ handler (IRQ 0) */
    irq_install_handler(0, timer_irq_handler);
}

uint32_t timer_get_ticks(void) {
    return timer_ticks;
}

uint32_t timer_get_ms(void) {
    if (timer_freq == 0) return 0;
    return (timer_ticks * 1000) / timer_freq;
}

void timer_sleep(uint32_t ms) {
    uint32_t target = timer_get_ms() + ms;
    while (timer_get_ms() < target) {
        __asm__ volatile ("hlt");  /* Wait for next interrupt */
    }
}

/* ── TSC Calibration  (item 46) ─────────────────────────────────────────── */
/*
 * Measure how many TSC ticks elapse during a known PIT interval (10 ms).
 * Must be called after timer_initialize() so that PIT IRQs are running.
 */

static uint32_t _tsc_hz = 0;

static inline uint64_t _rdtsc(void) {
    uint32_t lo, hi;
    __asm__ volatile ("rdtsc" : "=a"(lo), "=d"(hi));
    return ((uint64_t)hi << 32) | lo;
}

uint64_t timer_read_tsc(void) { return _rdtsc(); }
uint32_t timer_tsc_hz(void)   { return _tsc_hz;  }

void timer_calibrate_tsc(void) {
    /* Gate: sleep for 20 ms using PIT tick counter, measure TSC delta */
    uint32_t cal_ms = 20u;
    uint64_t t0 = _rdtsc();
    timer_sleep(cal_ms);
    uint64_t t1 = _rdtsc();
    uint64_t delta = t1 - t0;
    /* tsc_hz = delta_tsc / elapsed_ms * 1000 */
    _tsc_hz = (uint32_t)((delta * 1000u) / cal_ms);
}

/* ── RTC  (item 50) ─────────────────────────────────────────────────────── */
/*
 * CMOS RTC via I/O ports 0x70 (address) + 0x71 (data).
 * Register map:
 *   0x00 Seconds   0x02 Minutes   0x04 Hours
 *   0x07 Day       0x08 Month     0x09 Year (2-digit)
 *   0x0B Status B  (bit 2 = Binary mode, bit 1 = 24h mode)
 *   0x32 Century   (many BIOSes; not universal)
 *
 * Values may be BCD or binary depending on Status B bit 2.
 */

#define CMOS_ADDR  0x70
#define CMOS_DATA  0x71

static uint8_t _cmos_read(uint8_t reg) {
    outb(CMOS_ADDR, reg);
    io_wait();
    return inb(CMOS_DATA);
}

static inline uint8_t _bcd_to_bin(uint8_t b) {
    return (uint8_t)(((b >> 4) * 10u) + (b & 0x0Fu));
}

/* Check if RTC is currently in update cycle */
static int _rtc_updating(void) {
    outb(CMOS_ADDR, 0x0A);
    io_wait();
    return (int)(inb(CMOS_DATA) & 0x80);
}

void rtc_read(rtc_time_t *out) {
    if (!out) return;

    /* Spin until we catch a stable reading (not mid-update) */
    uint8_t last_sec, sec;
    do { while (_rtc_updating()); sec = _cmos_read(0x00); } while (0);
    do {
        last_sec = sec;
        while (_rtc_updating());
        sec = _cmos_read(0x00);
    } while (sec != last_sec);

    uint8_t statb   = _cmos_read(0x0B);
    int     is_bin  = (statb & 0x04) != 0;
    int     is24    = (statb & 0x02) != 0;

    uint8_t s  = _cmos_read(0x00);
    uint8_t mn = _cmos_read(0x02);
    uint8_t h  = _cmos_read(0x04);
    uint8_t d  = _cmos_read(0x07);
    uint8_t mo = _cmos_read(0x08);
    uint8_t yr = _cmos_read(0x09);
    uint8_t cy = _cmos_read(0x32);  /* century — may be 0 on some BIOSes */

    if (!is_bin) {
        s  = _bcd_to_bin(s);
        mn = _bcd_to_bin(mn);
        h  = _bcd_to_bin(h  & 0x7Fu) | (uint8_t)(h  & 0x80u);
        d  = _bcd_to_bin(d);
        mo = _bcd_to_bin(mo);
        yr = _bcd_to_bin(yr);
        cy = (cy && cy != 0xFF) ? _bcd_to_bin(cy) : 0u;
    }

    /* Normalise 12h → 24h if needed */
    if (!is24 && (h & 0x80u)) {
        h = (uint8_t)(((h & 0x7Fu) + 12u) % 24u);
    }

    uint16_t year;
    if (cy && cy != 0xFFu)
        year = (uint16_t)((uint16_t)cy * 100u + yr);
    else
        year = (uint16_t)(yr < 80u ? 2000u + yr : 1900u + yr);

    out->seconds = s;
    out->minutes = mn;
    out->hours   = h & 0x7Fu;
    out->day     = d;
    out->month   = mo;
    out->year    = year;
}

uint32_t rtc_unix_time(void) {
    rtc_time_t t;
    rtc_read(&t);

    /* Simplified Gregorian → Unix epoch (no leap seconds) */
    uint32_t y = t.year;
    uint32_t m = t.month;
    uint32_t d = t.day;

    if (m <= 2u) { y--; m += 12u; }
    uint32_t a = y / 100u;
    uint32_t b = 2u - a + a / 4u;
    uint32_t jdn = (uint32_t)(365.25f * (float)(y + 4716))
                 + (uint32_t)(30.6001f * (float)(m + 1))
                 + d + b - 1524u;
    /* Julian Day Number to Unix epoch: JDN 2440588 = 1970-01-01 */
    uint32_t days_since_epoch = jdn - 2440588u;
    return days_since_epoch * 86400u
           + (uint32_t)t.hours   * 3600u
           + (uint32_t)t.minutes * 60u
           +  t.seconds;
}

/* ── High-resolution time (item 48) ─────────────────────────────────────── */

uint64_t timer_gettime_ns(void) {
    uint32_t hz = _tsc_hz;  /* calibrated TSC Hz (0 if not yet calibrated) */
    if (hz > 0u) {
        uint64_t tsc = timer_read_tsc();
        /* tsc / hz gives seconds; multiply first to avoid losing sub-second res.
         * t_ns = tsc * 1_000_000_000 / hz
         * To avoid 64-bit overflow (tsc * 1e9 may overflow): split into seconds
         * and remainder. */
        uint64_t sec = tsc / (uint64_t)hz;
        uint64_t rem = tsc % (uint64_t)hz;
        return sec * 1000000000ULL + (rem * 1000000000ULL) / (uint64_t)hz;
    }
    /* Fallback: PIT ticks at 1 ms resolution */
    return (uint64_t)timer_ticks * 1000000ULL;
}

uint64_t timer_uptime_us(void) {
    uint32_t hz = _tsc_hz;
    if (hz > 0u) {
        uint64_t tsc = timer_read_tsc();
        uint64_t sec = tsc / (uint64_t)hz;
        uint64_t rem = tsc % (uint64_t)hz;
        return sec * 1000000ULL + (rem * 1000000ULL) / (uint64_t)hz;
    }
    return (uint64_t)timer_ticks * 1000ULL;
}
