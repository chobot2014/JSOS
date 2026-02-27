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

/* ── MSI (Message Signalled Interrupts) ────────────────────────────────── */

#define PCI_CAP_ID_MSI    0x05
#define PCI_STATUS_CAP    0x10   /* bit 4 of PCI Status: Capabilities List */

int pci_find_msi_cap(const pci_device_t *dev, uint8_t *cap_offset) {
    /* Check that the device supports the capabilities list (Status bit 4). */
    uint32_t status = pci_cfg_read32(dev->bus, dev->dev, dev->fn, 0x04);
    if (!((status >> 16) & PCI_STATUS_CAP)) return 0;

    /* Capabilities pointer lives at offset 0x34 (bits 7:2 of byte). */
    uint8_t cap_ptr = (uint8_t)(pci_cfg_read32(dev->bus, dev->dev, dev->fn, 0x34) & 0xFC);

    int guard = 64; /* prevent infinite loop on bad firmware */
    while (cap_ptr && guard-- > 0) {
        uint32_t cap_dw = pci_cfg_read32(dev->bus, dev->dev, dev->fn, cap_ptr);
        uint8_t cap_id   = (uint8_t)(cap_dw & 0xFF);
        uint8_t cap_next = (uint8_t)((cap_dw >> 8) & 0xFC);
        if (cap_id == PCI_CAP_ID_MSI) {
            *cap_offset = cap_ptr;
            return 1;
        }
        cap_ptr = cap_next;
    }
    return 0;
}

void pci_enable_msi(const pci_device_t *dev, uint32_t msg_addr, uint16_t msg_data) {
    uint8_t cap = 0;
    if (!pci_find_msi_cap(dev, &cap)) return;

    /* MSI Control register is at cap+0x02 (16-bit). */
    uint32_t ctrl_dw = pci_cfg_read32(dev->bus, dev->dev, dev->fn, cap);
    uint16_t ctrl = (uint16_t)(ctrl_dw >> 16);

    /* Write 32-bit message address to cap+0x04. */
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, (uint8_t)(cap + 0x04), msg_addr);

    /* If 64-bit capable (bit 7 of ctrl) message data is at cap+0x0C, else cap+0x08. */
    uint8_t data_off = (ctrl & (1u << 7)) ? (uint8_t)(cap + 0x0C) : (uint8_t)(cap + 0x08);
    uint32_t data_dw = pci_cfg_read32(dev->bus, dev->dev, dev->fn, data_off);
    data_dw = (data_dw & 0xFFFF0000u) | (uint32_t)msg_data;
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, data_off, data_dw);

    /* Enable MSI: set bit 0 of Control, clear multi-message enable (bits 4:1). */
    ctrl = (ctrl & ~0x000Fu) | 0x0001u;
    ctrl_dw = (ctrl_dw & 0x0000FFFFu) | ((uint32_t)ctrl << 16);
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, cap, ctrl_dw);
}

/* ── 64-bit BAR support (item 97) ───────────────────────────────────────── */

int pci_bar_is_64(const pci_device_t *dev, int b) {
    if (b < 0 || b > 4) return 0;
    uint32_t raw = pci_cfg_read32(dev->bus, dev->dev, dev->fn,
                                   (uint8_t)(0x10 + b * 4));
    /* Bit 0 = I/O space; bits 2:1 = 0b10 means 64-bit */
    if (raw & 1u) return 0; /* I/O BAR */
    return ((raw >> 1) & 3u) == 2;
}

uint64_t pci_bar64(const pci_device_t *dev, int b) {
    if (b < 0 || b > 4) return 0;
    uint32_t lo = pci_cfg_read32(dev->bus, dev->dev, dev->fn,
                                  (uint8_t)(0x10 + b * 4));
    uint32_t hi = pci_cfg_read32(dev->bus, dev->dev, dev->fn,
                                  (uint8_t)(0x10 + (b + 1) * 4));
    return ((uint64_t)hi << 32) | (lo & ~0xFu);
}

/* ── PCIe ECAM (item 98) ────────────────────────────────────────────────── */
/*
 * PCIe Enhanced Configuration Access Mechanism (ECAM) maps 4 KB per
 * function into MMIO:
 *   base + (bus << 20) | (dev << 15) | (fn << 12) | reg
 * The base address comes from the ACPI MCFG table.
 */

static uint32_t _ecam_base = 0;

void pci_ecam_set_base(uint32_t ecam_phys_base) {
    _ecam_base = ecam_phys_base;
}

static volatile uint32_t *_ecam_ptr(uint8_t bus, uint8_t dev, uint8_t fn, uint16_t reg) {
    uint32_t offset = ((uint32_t)bus  << 20)
                    | ((uint32_t)dev  << 15)
                    | ((uint32_t)fn   << 12)
                    | (reg & 0xFFCu);
    return (volatile uint32_t *)(_ecam_base + offset);
}

uint32_t pci_ecam_read32(uint8_t bus, uint8_t dev, uint8_t fn, uint16_t reg) {
    if (!_ecam_base) return 0xFFFFFFFFu;
    return *_ecam_ptr(bus, dev, fn, reg);
}

void pci_ecam_write32(uint8_t bus, uint8_t dev, uint8_t fn, uint16_t reg, uint32_t val) {
    if (!_ecam_base) return;
    *_ecam_ptr(bus, dev, fn, reg) = val;
}

/* ── PCI Power Management (items 99, 100) ───────────────────────────────── */
#define PCI_CAP_ID_PM  0x01

static uint8_t _find_pm_cap(const pci_device_t *dev) {
    uint32_t status = pci_cfg_read32(dev->bus, dev->dev, dev->fn, 0x04);
    if (!((status >> 16) & 0x10u)) return 0;
    uint8_t ptr = (uint8_t)(pci_cfg_read32(dev->bus, dev->dev, dev->fn, 0x34) & 0xFC);
    int g = 64;
    while (ptr && g-- > 0) {
        uint32_t dw = pci_cfg_read32(dev->bus, dev->dev, dev->fn, ptr);
        if ((dw & 0xFF) == PCI_CAP_ID_PM) return ptr;
        ptr = (uint8_t)((dw >> 8) & 0xFC);
    }
    return 0;
}

int pci_pm_set_d0(const pci_device_t *dev) {
    uint8_t pm = _find_pm_cap(dev);
    if (!pm) return -1;
    uint32_t pmcs = pci_cfg_read32(dev->bus, dev->dev, dev->fn, (uint8_t)(pm + 4));
    pmcs = (pmcs & ~0x03u);   /* D0 = bits [1:0] = 0 */
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, (uint8_t)(pm + 4), pmcs);
    return 0;
}

int pci_pm_set_d3(const pci_device_t *dev) {
    uint8_t pm = _find_pm_cap(dev);
    if (!pm) return -1;
    uint32_t pmcs = pci_cfg_read32(dev->bus, dev->dev, dev->fn, (uint8_t)(pm + 4));
    pmcs = (pmcs & ~0x03u) | 0x03u;  /* D3hot = bits [1:0] = 3 */
    pci_cfg_write32(dev->bus, dev->dev, dev->fn, (uint8_t)(pm + 4), pmcs);
    return 0;
}
