/*
 * JSOS PS/2 Mouse Driver
 *
 * Initialises the PS/2 auxiliary device (mouse), installs an IRQ12 handler,
 * and maintains a circular queue of decoded 3-byte packets.
 *
 * TypeScript (wm.ts) reads packets via kernel.readMouse() and accumulates
 * absolute cursor position from the relative dx/dy values.
 *
 * Reference: https://wiki.osdev.org/Mouse_Input
 */

#include "mouse.h"
#include "irq.h"
#include "io.h"
#include <stddef.h>

/* PS/2 controller ports */
#define PS2_DATA    0x60
#define PS2_STATUS  0x64   /* read: status register */
#define PS2_CMD     0x64   /* write: command register */

/* PS/2 commands */
#define PS2_CMD_ENABLE_AUX   0xA8
#define PS2_CMD_WRITE_AUX    0xD4

/* Mouse command bytes */
#define MOUSE_SET_DEFAULTS   0xF6
#define MOUSE_ENABLE_REPORT  0xF4

/* Circular packet queue */
#define QUEUE_SIZE 32

static mouse_packet_t _queue[QUEUE_SIZE];
static volatile int   _head = 0;
static volatile int   _tail = 0;

/* Accumulate partial 3-byte PS/2 packet */
static uint8_t  _raw[3];
static volatile int _byte_idx = 0;

/* ── PS/2 helpers ────────────────────────────────────────────────────────── */

static void ps2_wait_write(void) {
    int timeout = 100000;
    while (--timeout && (inb(PS2_STATUS) & 0x02));
}

static void ps2_wait_read(void) {
    int timeout = 100000;
    while (--timeout && !(inb(PS2_STATUS) & 0x01));
}

static void mouse_write(uint8_t cmd) {
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_WRITE_AUX);   /* tell controller next byte is for mouse */
    ps2_wait_write();
    outb(PS2_DATA, cmd);
}

static uint8_t mouse_read_byte(void) {
    ps2_wait_read();
    return inb(PS2_DATA);
}

/* ── IRQ12 handler ───────────────────────────────────────────────────────── */

void mouse_irq_handler(void) {
    uint8_t byte = inb(PS2_DATA);

    /* First byte of a packet must have bit 3 set (always-1 bit).
     * Re-synchronise if we're at index 0 and the byte looks wrong. */
    if (_byte_idx == 0 && !(byte & 0x08)) {
        /* Discard — desync */
        irq_send_eoi(12);
        return;
    }

    _raw[_byte_idx++] = byte;

    if (_byte_idx == 3) {
        _byte_idx = 0;

        uint8_t flags = _raw[0];

        /* Overflow bits set → discard packet */
        if (flags & 0xC0) {
            irq_send_eoi(12);
            return;
        }

        mouse_packet_t pkt;
        pkt.buttons = flags & 0x07;

        /* dx: raw value + sign extension from flags bit 4 */
        int dx = (int)_raw[1];
        if (flags & 0x10) dx |= ~0xFF;   /* sign-extend */
        pkt.dx = (int8_t)dx;

        /* dy: raw; PS/2 Y axis is inverted relative to screen */
        int dy = (int)_raw[2];
        if (flags & 0x20) dy |= ~0xFF;   /* sign-extend */
        pkt.dy = (int8_t)(-dy);           /* invert Y for screen coords */

        int next_tail = (_tail + 1) % QUEUE_SIZE;
        if (next_tail != _head) {         /* not full */
            _queue[_tail] = pkt;
            _tail = next_tail;
        }
    }

    irq_send_eoi(12);
}

/* ── Public API ──────────────────────────────────────────────────────────── */

void mouse_initialize(void) {
    /* Enable PS/2 auxiliary port */
    ps2_wait_write();
    outb(PS2_CMD, PS2_CMD_ENABLE_AUX);

    /* Set defaults and enable packet streaming */
    mouse_write(MOUSE_SET_DEFAULTS);
    mouse_read_byte(); /* ACK */

    mouse_write(MOUSE_ENABLE_REPORT);
    mouse_read_byte(); /* ACK */

    /* Register IRQ12 handler */
    irq_install_handler(12, mouse_irq_handler);
}

int mouse_read(mouse_packet_t *out) {
    if (_head == _tail) return 0;   /* empty */
    *out = _queue[_head];
    _head = (_head + 1) % QUEUE_SIZE;
    return 1;
}
