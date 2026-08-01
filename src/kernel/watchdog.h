/*
 * Kernel Watchdog Timer  (item 107)
 *
 * Software watchdog using PIT channel 2 + beeper port (0x61).
 * A separate PIT-tick-based countdown is decremented by IRQ0.
 * If watchdog_kick() is not called before the counter reaches zero,
 * platform_panic() is triggered.
 *
 * Timeout is configurable at init time.
 */
#ifndef WATCHDOG_H
#define WATCHDOG_H

#include <stdint.h>

/** Initialise the watchdog with a timeout_ms period.  Starts armed.         */
void watchdog_init(uint32_t timeout_ms);

/** Reset the watchdog countdown.  Call periodically to prevent firing.      */
void watchdog_kick(void);

/** Disable the watchdog permanently.                                         */
void watchdog_disable(void);

/** Called from IRQ0 handler (timer tick) — checks countdown, panics if 0.   */
void watchdog_tick(void);

#endif /* WATCHDOG_H */
