/*
 * JSOS PS/2 Mouse Driver
 *
 * Handles IRQ12 (PS/2 mouse). Decodes 3-byte packets into relative (dx, dy)
 * motion and button state. Maintains a small circular queue of decoded packets.
 *
 * All cursor management, absolute position accumulation, and event dispatch
 * are done in TypeScript (wm.ts). This C layer only provides the raw packets.
 */

#ifndef MOUSE_H
#define MOUSE_H

#include <stdint.h>

typedef struct {
    int8_t  dx;       /* signed relative motion in X */
    int8_t  dy;       /* signed relative motion in Y (positive = up in PS/2) */
    uint8_t buttons;  /* bit0=left, bit1=right, bit2=middle */
    int8_t  scroll;   /* scroll wheel delta: >0 = up, <0 = down (0 if no wheel) */
} mouse_packet_t;

/* Initialise PS/2 mouse and register IRQ12 handler */
void mouse_initialize(void);

/* Pop next decoded packet from the queue.
 * Returns 1 on success (packet filled), 0 if queue is empty. */
int mouse_read(mouse_packet_t *out);

/* IRQ12 handler — called by IRQ dispatch */
void mouse_irq_handler(void);

#endif /* MOUSE_H */
