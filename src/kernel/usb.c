/*
 * USB Host Controller Stubs (items 92, 93)
 */
#include "usb.h"
#include "pci.h"
#include "io.h"
#include "platform.h"

int usb_hc_detect(usb_hc_t *out) {
    if (!out) return 0;
    /* Scan PCI for class=0x0C subclass=0x03 */
    for (int bus = 0; bus < 256; bus++) {
        for (int dev = 0; dev < 32; dev++) {
            uint32_t id = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, 0, 0);
            if ((id & 0xFFFF) == 0xFFFF) continue;
            uint32_t cc = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, 0, 0x08);
            uint8_t cls = (uint8_t)(cc >> 24);
            uint8_t sub = (uint8_t)(cc >> 16);
            uint8_t pi  = (uint8_t)(cc >>  8);
            if (cls != 0x0Cu || sub != 0x03u) continue;
            out->irq = (uint8_t)pci_cfg_read32((uint8_t)bus,(uint8_t)dev,0,0x3C);
            switch (pi) {
                case 0x00:
                    out->type    = USB_HC_UHCI;
                    out->io_base = (uint16_t)(pci_cfg_read32((uint8_t)bus,(uint8_t)dev,0,0x20) & ~3u);
                    break;
                case 0x10:
                    out->type      = USB_HC_OHCI;
                    out->mmio_base = pci_cfg_read32((uint8_t)bus,(uint8_t)dev,0,0x10) & ~15u;
                    break;
                case 0x20:
                    out->type      = USB_HC_EHCI;
                    out->mmio_base = pci_cfg_read32((uint8_t)bus,(uint8_t)dev,0,0x10) & ~15u;
                    break;
                case 0x30:
                    out->type      = USB_HC_XHCI;
                    out->mmio_base = pci_cfg_read32((uint8_t)bus,(uint8_t)dev,0,0x10) & ~15u;
                    break;
                default:
                    out->type = USB_HC_NONE;
            }
            platform_serial_puts("[USB] HC detected\n");
            return 1;
        }
    }
    return 0;
}

void usb_port_reset(const usb_hc_t *hc, int port_num) {
    if (!hc) return;
    if (hc->type == USB_HC_UHCI) {
        /* UHCI PORTSC: bit 9 = reset */
        uint16_t portsc = (uint16_t)(hc->io_base + 0x10 + port_num * 2);
        outw(portsc, inw(portsc) | (1u << 9));
        /* Hold reset for 50 ms */
        for (volatile int t = 0; t < 5000000; t++);
        outw(portsc, inw(portsc) & ~(1u << 9));
    }
    /* OHCI/EHCI/xHCI port reset left as stubs — full logic in TypeScript */
}
