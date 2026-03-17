/*
 * USB Host Controller Driver Stubs  (items 92, 93)
 *
 * Full USB stack lives in TypeScript.  C layer provides minimal UHCI/OHCI/XHCI
 * detection via PCI and a raw port-reset primitive.
 *
 * PCI class 0x0C, subclass 0x03 = USB controller
 *   prog-if 0x00 = UHCI
 *   prog-if 0x10 = OHCI
 *   prog-if 0x20 = EHCI
 *   prog-if 0x30 = xHCI
 */
#ifndef USB_H
#define USB_H

#include <stdint.h>

typedef enum {
    USB_HC_NONE  = 0,
    USB_HC_UHCI  = 1,
    USB_HC_OHCI  = 2,
    USB_HC_EHCI  = 3,
    USB_HC_XHCI  = 4,
} usb_hc_type_t;

typedef struct {
    usb_hc_type_t type;
    uint32_t      mmio_base;   /* BAR0 (MMIO) physical address for OHCI/EHCI/xHCI */
    uint16_t      io_base;     /* BAR4 I/O base for UHCI                          */
    uint8_t       irq;
} usb_hc_t;

/** Detect the first USB host controller via PCI.  Returns 1 if found. */
int  usb_hc_detect(usb_hc_t *out);

/** Issue a USB port reset on port `port_num` (0-based).  HC-type-aware. */
void usb_port_reset(const usb_hc_t *hc, int port_num);

#endif /* USB_H */
