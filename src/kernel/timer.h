#ifndef TIMER_H
#define TIMER_H

#include <stdint.h>

/* Initialize the PIT (Programmable Interval Timer) */
void timer_initialize(uint32_t frequency_hz);

/* Get the number of ticks since boot */
uint32_t timer_get_ticks(void);

/* Get approximate milliseconds since boot */
uint32_t timer_get_ms(void);

/* Sleep for a given number of milliseconds (busy-wait) */
void timer_sleep(uint32_t ms);

#endif /* TIMER_H */
