/*
 * usb_hid.h — USB HID keyboard and mouse driver (items 58, 59)
 *
 * Items covered:
 *   58 — USB HID keyboard: report parser, key mappings, boot protocol
 *   59 — USB HID mouse: report parser, button + relative movement
 *
 * Hooks into the JSOS USB host stack (usb.c) via interrupt IN endpoint
 * polling.  The HID report parser converts raw HID reports to the same
 * events consumed by the PS/2 keyboard / mouse paths.
 */
#ifndef USB_HID_H
#define USB_HID_H

#include <stdint.h>

/* ── HID keyboard report (boot-protocol, 8-byte) ────────────────────────── */
typedef struct {
    uint8_t modifier;   /* Modifier keys bitmask (Shift/Ctrl/Alt/GUI) */
    uint8_t reserved;
    uint8_t keycodes[6]; /* Up to 6 simultaneous keys (HID usage codes) */
} __attribute__((packed)) usb_hid_kbd_report_t;

/* Modifier bitmask bits */
#define HID_MOD_LCTRL   (1u << 0)
#define HID_MOD_LSHIFT  (1u << 1)
#define HID_MOD_LALT    (1u << 2)
#define HID_MOD_LGUI    (1u << 3)
#define HID_MOD_RCTRL   (1u << 4)
#define HID_MOD_RSHIFT  (1u << 5)
#define HID_MOD_RALT    (1u << 6)
#define HID_MOD_RGUI    (1u << 7)

/* ── HID mouse report (boot-protocol, 3-byte) ────────────────────────────── */
typedef struct {
    uint8_t buttons;   /* bit 0=left, 1=right, 2=middle */
    int8_t  dx;        /* relative X movement */
    int8_t  dy;        /* relative Y movement */
} __attribute__((packed)) usb_hid_mouse_report_t;

/* ── API ─────────────────────────────────────────────────────────────────── */

/* usb_hid_init() — scan USB devices for HID class interfaces.
 * Returns number of HID devices found (may be 0). */
int usb_hid_init(void);

/* usb_hid_kbd_present() — 1 if a USB HID keyboard was found. */
int usb_hid_kbd_present(void);

/* usb_hid_mouse_present() — 1 if a USB HID mouse was found. */
int usb_hid_mouse_present(void);

/* usb_hid_kbd_poll(report) — fetch latest keyboard report.
 * Returns 1 if new data, 0 if no change. */
int usb_hid_kbd_poll(usb_hid_kbd_report_t *report);

/* usb_hid_mouse_poll(report) — fetch latest mouse report.
 * Returns 1 if new data, 0 if no change. */
int usb_hid_mouse_poll(usb_hid_mouse_report_t *report);

/* usb_hid_kbd_process() — convert latest report to kernel key event
 * (calls keyboard_handle_key() for each new key press/release). */
void usb_hid_kbd_process(void);

/* usb_hid_mouse_process() — convert latest report to kernel mouse event
 * (calls mouse_handle_move() + mouse_handle_buttons()). */
void usb_hid_mouse_process(void);

/* Translate HID usage code → PS/2 scancode (for compatibility layer). */
uint8_t usb_hid_usage_to_scancode(uint8_t usage);

#endif /* USB_HID_H */
