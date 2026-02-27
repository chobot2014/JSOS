/*
 * gamepad.h — Gamepad and touch input stubs (items 63, 64)
 *
 * Items covered:
 *   63 — Gamepad / joystick input via USB HID gamepad class
 *   64 — Touch screen input (USB, I2C HID-over-USB, or virtio-input)
 *
 * Both are stubs providing a clean API for TypeScript to consume input events.
 */
#ifndef GAMEPAD_H
#define GAMEPAD_H

#include <stdint.h>

/* ── Gamepad state (item 63) ─────────────────────────────────────────────── */
#define GAMEPAD_BTN_A       (1u << 0)
#define GAMEPAD_BTN_B       (1u << 1)
#define GAMEPAD_BTN_X       (1u << 2)
#define GAMEPAD_BTN_Y       (1u << 3)
#define GAMEPAD_BTN_L1      (1u << 4)
#define GAMEPAD_BTN_R1      (1u << 5)
#define GAMEPAD_BTN_SELECT  (1u << 8)
#define GAMEPAD_BTN_START   (1u << 9)
#define GAMEPAD_BTN_DPAD_U  (1u << 12)
#define GAMEPAD_BTN_DPAD_D  (1u << 13)
#define GAMEPAD_BTN_DPAD_L  (1u << 14)
#define GAMEPAD_BTN_DPAD_R  (1u << 15)

typedef struct {
    uint16_t buttons;   /* Bitmask of pressed buttons */
    int16_t  lx, ly;    /* Left stick: -32768 to 32767 */
    int16_t  rx, ry;    /* Right stick */
    uint8_t  lt, rt;    /* Left/right triggers: 0-255 */
} gamepad_state_t;

/* ── Touch input (item 64) ───────────────────────────────────────────────── */
#define TOUCH_MAX_POINTS  5  /* Multi-touch up to 5 simultaneous contacts */

typedef struct {
    uint8_t  id;         /* Contact ID */
    uint8_t  active;     /* 1 if finger down */
    uint16_t x;          /* X in pixels */
    uint16_t y;          /* Y in pixels */
    uint16_t pressure;   /* 0-1023 (optional) */
} touch_point_t;

/* ── API ─────────────────────────────────────────────────────────────────── */

/* gamepad_init() — scan for USB HID gamepad; returns count of gamepads found. */
int gamepad_init(void);

/* gamepad_present(index) — 1 if gamepad <index> is connected. */
int gamepad_present(uint8_t index);

/* gamepad_read(index, state) — read current state. Returns 0 OK, -1 not found. */
int gamepad_read(uint8_t index, gamepad_state_t *state);

/* gamepad_rumble(index, low_hz, high_hz, duration_ms) — force feedback stub. */
int gamepad_rumble(uint8_t index, uint8_t low_hz, uint8_t high_hz, uint16_t ms);

/* touch_init() — scan for touch devices. Returns count. */
int touch_init(void);

/* touch_present() — 1 if touch screen is available. */
int touch_present(void);

/* touch_read(points, max_points) — fills up to max_points contacts.
 * Returns number of active contacts. */
int touch_read(touch_point_t *points, int max_points);

#endif /* GAMEPAD_H */
