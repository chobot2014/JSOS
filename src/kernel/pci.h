#ifndef PCI_H
#define PCI_H

#include <stdint.h>

/* PCI configuration space access via I/O ports 0xCF8/0xCFC */

static inline uint32_t pci_cfg_read32(uint8_t bus, uint8_t dev,
                                       uint8_t fn, uint8_t reg) {
    uint32_t addr = 0x80000000u
                  | ((uint32_t)bus  << 16)
                  | ((uint32_t)dev  << 11)
                  | ((uint32_t)fn   <<  8)
                  | (reg & 0xFC);
    __asm__ volatile ("outl %0, %1" :: "a"(addr),    "Nd"((uint16_t)0xCF8));
    uint32_t val;
    __asm__ volatile ("inl %1, %0"  : "=a"(val) : "Nd"((uint16_t)0xCFC));
    return val >> ((reg & 3) * 8);
}

static inline uint16_t pci_cfg_read16(uint8_t bus, uint8_t dev,
                                       uint8_t fn, uint8_t reg) {
    return (uint16_t)(pci_cfg_read32(bus, dev, fn, reg & ~1u) >> ((reg & 1) * 8));
}

static inline void pci_cfg_write32(uint8_t bus, uint8_t dev,
                                    uint8_t fn, uint8_t reg, uint32_t val) {
    uint32_t addr = 0x80000000u
                  | ((uint32_t)bus  << 16)
                  | ((uint32_t)dev  << 11)
                  | ((uint32_t)fn   <<  8)
                  | (reg & 0xFC);
    __asm__ volatile ("outl %0, %1" :: "a"(addr), "Nd"((uint16_t)0xCF8));
    __asm__ volatile ("outl %0, %1" :: "a"(val),  "Nd"((uint16_t)0xCFC));
}

/* PCI device descriptor returned by pci_find_device */
typedef struct {
    uint8_t  bus, dev, fn;
    uint16_t vendor_id;
    uint16_t device_id;
    uint8_t  class_code;
    uint8_t  subclass;
    /* BAR0..BAR5 decoded values */
    uint32_t bar[6];
    uint8_t  bar_is_io[6];    /* 1 = I/O port, 0 = memory-mapped */
    uint8_t  irq_line;
} pci_device_t;

/**
 * Scan all PCI buses looking for the first device matching vendor:device.
 * Returns 1 on success + fills *out; returns 0 if not found.
 */
int pci_find_device(uint16_t vendor, uint16_t device, pci_device_t *out);

/**
 * Enable bus-mastering on a PCI device (needed for DMA).
 */
void pci_enable_busmaster(const pci_device_t *dev);

#endif /* PCI_H */
