/*
 * JSOS PCI Bus Scanner
 *
 * Provides: pci_find_device() for locating NIC / storage / etc.
 * C code is purely hardware access — no OS logic.
 */

#include "pci.h"
#include <string.h>

int pci_find_device(uint16_t vendor, uint16_t device, pci_device_t *out) {
    for (int bus = 0; bus < 256; bus++) {
        for (int dev = 0; dev < 32; dev++) {
            /* Check function 0 first */
            uint32_t id = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, 0, 0);
            if ((id & 0xffff) == 0xffff) continue; /* no device */

            uint8_t hdr_type = (uint8_t)(pci_cfg_read32((uint8_t)bus, (uint8_t)dev, 0, 0x0C) >> 16);
            int num_fn = (hdr_type & 0x80) ? 8 : 1;

            for (int fn = 0; fn < num_fn; fn++) {
                uint32_t vid_did = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, (uint8_t)fn, 0x00);
                if ((vid_did & 0xffff) != vendor) continue;
                if (((vid_did >> 16) & 0xffff) != device) continue;

                /* Found it — fill out descriptor */
                out->bus       = (uint8_t)bus;
                out->dev       = (uint8_t)dev;
                out->fn        = (uint8_t)fn;
                out->vendor_id = vendor;
                out->device_id = device;

                uint32_t cc = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, (uint8_t)fn, 0x08);
                out->class_code = (uint8_t)(cc >> 24);
                out->subclass   = (uint8_t)(cc >> 16);

                /* Decode BARs 0..5 */
                for (int b = 0; b < 6; b++) {
                    uint32_t raw = pci_cfg_read32((uint8_t)bus, (uint8_t)dev, (uint8_t)fn,
                                                   (uint8_t)(0x10 + b * 4));
                    out->bar_is_io[b] = raw & 1;
                    out->bar[b] = raw & (out->bar_is_io[b] ? ~3u : ~15u);
                }

                out->irq_line = (uint8_t)pci_cfg_read32((uint8_t)bus, (uint8_t)dev, (uint8_t)fn, 0x3C);
                return 1;
            }
        }
    }
    return 0;
}

void pci_enable_busmaster(const pci_device_t *dev) {
    uint32_t cmd = pci_cfg_read32(dev->bus, dev->dev, dev->fn, 0x04);
    cmd |= (1u << 2); /* Bus Master Enable */
    cmd |= (1u << 0); /* I/O Space Enable */
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, 0x04, cmd);
}
