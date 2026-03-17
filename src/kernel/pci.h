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

/**
 * Walk the PCI capability list looking for the MSI capability (ID 0x05).
 * Returns 1 and sets *cap_offset to the byte offset of the MSI header in
 * PCI config space; returns 0 if MSI is not present or capabilities are not
 * supported.
 */
int pci_find_msi_cap(const pci_device_t *dev, uint8_t *cap_offset);

/**
 * Enable MSI interrupts on a PCI device.
 *   msg_addr  — the 32-bit physical message address written to the device
 *               (typically 0xFEExxxxx on x86; APIC ID is encoded there).
 *   msg_data  — the 16-bit data word; low 8 bits are the IDT vector,
 *               bits 14-15 select delivery mode / trigger.
 * Does nothing if the device does not expose an MSI capability.
 */
void pci_enable_msi(const pci_device_t *dev, uint32_t msg_addr, uint16_t msg_data);

/* ── 64-bit BAR detection (item 97) ─────────────────────────────────────── */
/**
 * Decode a 64-bit memory BAR.  BAR n must have bits [2:1] = 0b10 (64-bit).
 * Returns the full 64-bit base address (upper 32 bits from BARn+1).
 * bar_index must be 0, 1, 2, 3, or 4 (BARn+1 must exist).
 */
uint64_t pci_bar64(const pci_device_t *dev, int bar_index);

/** Returns 1 if BAR at bar_index is a 64-bit memory BAR. */
int pci_bar_is_64(const pci_device_t *dev, int bar_index);

/* ── PCIe Enhanced Config Access (ECAM) (item 98) ──────────────────────── */
/**
 * Set the ECAM MMIO base address (read from ACPI MCFG table).
 * All subsequent pci_ecam_read32/write32 calls use this base.
 */
void pci_ecam_set_base(uint32_t ecam_phys_base);

/** Read a 32-bit DWORD from PCIe extended config space via ECAM MMIO.
 *  reg can be 0x000..0xFFC (4096-byte config space, vs 256 bytes for legacy). */
uint32_t pci_ecam_read32 (uint8_t bus, uint8_t dev, uint8_t fn, uint16_t reg);
void     pci_ecam_write32(uint8_t bus, uint8_t dev, uint8_t fn, uint16_t reg, uint32_t val);

/* ── PCI Power Management (items 99, 100) ────────────────────────────────── */
/** Set device to D0 (fully-on) power state.  Returns 0 on success. */
int pci_pm_set_d0(const pci_device_t *dev);
/** Set device to D3hot (off) power state.  Returns 0 on success.  */
int pci_pm_set_d3(const pci_device_t *dev);

#endif /* PCI_H */
