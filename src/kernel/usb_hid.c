/*
 * usb_hid.c — USB HID keyboard and mouse driver (items 58, 59)
 *
 * Stub implementation.  A real implementation would use the USB host
 * controller (XHCI/EHCI/OHCI) interrupt IN pipe polling, but the current
 * USB stack (usb.c) only handles device enumeration.  These stubs provide
 * the API surface so TypeScript can call kernel.usbHidKbdPresent() etc.
 */
#include "usb_hid.h"
#include "keyboard.h"
#include "mouse.h"
#include "platform.h"
#include <stddef.h>
#include <string.h>

/* HID Usage → PS/2 XT scancode translation table (basic US layout subset). */
static const uint8_t _hid_to_sc[256] = {
    /* 0x00-0x03 */ 0,0,0,0,
    /* 0x04 A-Z  */ 0x1E,0x30,0x2E,0x20,0x12,0x21,0x22,0x23,0x17,0x24,
                    0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1F,0x14,
                    0x16,0x2F,0x11,0x2D,0x15,0x2C,
    /* 0x1E 1-9,0*/ 0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,
    /* 0x28 Enter/Esc/BS/Tab/Space */ 0x1C,0x01,0x0E,0x0F,0x39,
    /* 0x2D -/=/[/] */ 0x0C,0x0D,0x1A,0x1B,
    /* 0x31 \;'/`,./ */ 0x2B,0x27,0x28,0x29,0x33,0x34,0x35,
    /* 0x38 F1-F12 */ 0x3B,0x3C,0x3D,0x3E,0x3F,0x40,0x41,0x42,0x43,0x44,0x57,0x58,
};

static int _kbd_present = 0;
static int _mouse_present = 0;
static usb_hid_kbd_report_t   _last_kbd   = {0};
static usb_hid_mouse_report_t _last_mouse = {0};

int usb_hid_init(void) {
    /* Stub: check for USB-class HID devices via usb_device_class_present(). */
    /* TODO: enumerate USB devices via usb.c once interrupt pipes are implemented */
    platform_boot_print("[USB-HID] Stub: no interrupt pipe polling yet\n");
    _kbd_present   = 0;
    _mouse_present = 0;
    return 0;
}

int usb_hid_kbd_present(void)   { return _kbd_present; }
int usb_hid_mouse_present(void) { return _mouse_present; }

int usb_hid_kbd_poll(usb_hid_kbd_report_t *report) {
    if (!report || !_kbd_present) return 0;
    *report = _last_kbd;
    return 0;  /* No new data in stub */
}

int usb_hid_mouse_poll(usb_hid_mouse_report_t *report) {
    if (!report || !_mouse_present) return 0;
    *report = _last_mouse;
    return 0;
}

void usb_hid_kbd_process(void) {
    /* Stub: would call keyboard_handle_key() for each new/released key. */
}

void usb_hid_mouse_process(void) {
    /* Stub: would call mouse driver with dx/dy/button state. */
}

uint8_t usb_hid_usage_to_scancode(uint8_t usage) {
    return _hid_to_sc[usage];
}
