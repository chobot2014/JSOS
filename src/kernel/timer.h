#ifndef TIMER_H
#define TIMER_H

#include <stdint.h>

/* PIT frequency.  Changing this value requires updating MS_TO_TICKS below. */
#define TIMER_HZ  1000u

/*
 * Convert milliseconds to PIT tick counts.
 * At TIMER_HZ=1000 each tick is exactly 1 ms, so ticks == ms.
 * Returns a minimum of 1 tick so that zero-delay timers still fire.
 */
#define MS_TO_TICKS(ms)  ((uint32_t)((ms) > 0u ? (ms) : 1u))

/* Initialize the PIT (Programmable Interval Timer) */
void timer_initialize(uint32_t frequency_hz);

/* Get the number of ticks since boot */
uint32_t timer_get_ticks(void);

/* Get approximate milliseconds since boot */
uint32_t timer_get_ms(void);

/* Sleep for a given number of milliseconds (busy-wait) */
void timer_sleep(uint32_t ms);

/* TSC calibration (item 46)
 * Runs after timer_initialize().  Measures TSC ticks per PIT ms.
 * After this call, timer_read_tsc() and timer_tsc_hz() are valid.            */
void     timer_calibrate_tsc(void);
uint64_t timer_read_tsc(void);         /* raw RDTSC value                     */
uint32_t timer_tsc_hz(void);           /* TSC cycles per second (calibrated)  */

/* RTC read (item 50)  — read-only, CMOS-backed wall-clock                    */
typedef struct {
    uint8_t  seconds;   /* 0-59  */
    uint8_t  minutes;   /* 0-59  */
    uint8_t  hours;     /* 0-23  */
    uint8_t  day;       /* 1-31  */
    uint8_t  month;     /* 1-12  */
    uint16_t year;      /* e.g. 2025 */
} rtc_time_t;

void rtc_read(rtc_time_t *out);
/* Unix-epoch seconds approximation from RTC (no leap-second awareness)       */
uint32_t rtc_unix_time(void);

/* High-resolution time since boot (item 48)
 * Both functions use the calibrated TSC.  If calibration has not run yet
 * they fall back to ms-granularity PIT tick counts.                          */
uint64_t timer_gettime_ns(void);   /* nanoseconds since boot                  */
uint64_t timer_uptime_us(void);    /* microseconds since boot                 */

/* NTP wall-clock (item 51)
 * timer_set_wall_clock() stores a Unix epoch seconds value supplied by the
 * NTP client (TypeScript).  timer_get_wall_clock() returns the stored value
 * plus elapsed seconds since it was set so subsequent calls advance.
 * Returns rtc_unix_time() if no NTP sync has occurred.                       */
void     timer_set_wall_clock(uint32_t unix_epoch_seconds);
uint32_t timer_get_wall_clock(void);

/* Deferred-preemption counter — incremented by IRQ0, reset by js_sched_tick() */
extern volatile uint32_t _preempt_counter;

#endif /* TIMER_H */
