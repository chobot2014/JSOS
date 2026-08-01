/*
 * Kernel Watchdog Timer (item 107)
 */
#include "watchdog.h"
#include "platform.h"
#include "timer.h"
#include <stdint.h>

static uint32_t _timeout_ticks = 0;    /* initial countdown                */
static uint32_t _remaining     = 0;    /* ticks until panic                */
static int      _armed         = 0;

void watchdog_init(uint32_t timeout_ms) {
    _timeout_ticks = MS_TO_TICKS(timeout_ms);
    _remaining     = _timeout_ticks;
    _armed         = 1;
}

void watchdog_kick(void) {
    _remaining = _timeout_ticks;
}

void watchdog_disable(void) {
    _armed = 0;
}

/* Called from IRQ0 each timer tick */
void watchdog_tick(void) {
    if (!_armed) return;
    if (_remaining == 0) {
        platform_panic("Watchdog timeout");
    }
    _remaining--;
}
