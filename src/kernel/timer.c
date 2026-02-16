
#include "timer.h"
#include "irq.h"
#include "io.h"
#include <stddef.h>

/* PIT ports */
#define PIT_CHANNEL0  0x40
#define PIT_COMMAND   0x43

/* PIT base frequency */
#define PIT_BASE_FREQ 1193180

/* Timer state */
static volatile uint32_t timer_ticks = 0;
static uint32_t timer_freq = 0;

/* IRQ0 handler - timer interrupt */
static void timer_irq_handler(void) {
    timer_ticks++;
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
