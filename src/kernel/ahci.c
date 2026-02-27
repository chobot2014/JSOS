/*
 * ahci.c — SATA AHCI HBA C register layer (item 83)
 *
 * C responsibility: PCI enumeration, BAR5 MMIO mapping, raw reg read/write.
 * TypeScript responsibility: all FIS construction, port state machines,
 * command list management, and data transfer scheduling.
 */

#include "ahci.h"
#include "pci.h"
#include "timer.h"
#include "io.h"
#include <stdint.h>

static volatile uint32_t *_hba   = 0;
static uint32_t           _hba_phys = 0u;
static int                _present  = 0;

/* ── MMIO helpers ─────────────────────────────────────────────────────────── */

uint32_t ahci_hba_read32(uint32_t reg) {
    if (!_hba) return 0u;
    return _hba[reg >> 2u];
}

void ahci_hba_write32(uint32_t reg, uint32_t val) {
    if (!_hba) return;
    _hba[reg >> 2u] = val;
    (void)_hba[reg >> 2u];   /* flush */
}

uint32_t ahci_port_read32(uint8_t port, uint32_t reg) {
    uint32_t off = 0x100u + (uint32_t)port * 0x80u + reg;
    return ahci_hba_read32(off);
}

void ahci_port_write32(uint8_t port, uint32_t reg, uint32_t val) {
    uint32_t off = 0x100u + (uint32_t)port * 0x80u + reg;
    ahci_hba_write32(off, val);
}

/* ── PCI enumeration ──────────────────────────────────────────────────────── */

int ahci_init(void) {
    /* Scan PCI for class=01, sub=06, prog-if=01 (AHCI 1.0) */
    for (uint8_t bus = 0u; bus < 255u && !_present; bus++) {
        for (uint8_t dev = 0u; dev < 32u && !_present; dev++) {
            for (uint8_t fn = 0u; fn < 8u; fn++) {
                uint32_t id = pci_config_read(bus, dev, fn, 0u);
                if ((id & 0xFFFFu) == 0xFFFFu) { if (!fn) break; continue; }
                uint32_t class = pci_config_read(bus, dev, fn, 0x08u);
                /* Check class 01, sub 06, prog-if 01 */
                if ((class >> 8u) != AHCI_PCI_CLASS_AHCI) {
                    /* Some AHCI controllers use sub=06 prog-if=00; also check */
                    if ((class >> 8u) != 0x010600u) {
                        uint8_t hdr = (uint8_t)(pci_config_read(bus, dev, fn, 0x0Cu) >> 16u);
                        if (!(hdr & 0x80u) && fn == 0u) break;
                        continue;
                    }
                }
                /* Found: BAR5 is the AHCI ABAR (MMIO) */
                pci_device_t pdev = { bus, dev, fn,
                    (uint16_t)(id & 0xFFFFu), (uint16_t)(id >> 16u),
                    {0,0,0,0,0,0}, 0, 0 };
                uint32_t bar5 = pci_config_read(bus, dev, fn, 0x24u);
                _hba_phys = bar5 & 0xFFFFF000u;
                _hba      = (volatile uint32_t *)_hba_phys;
                pci_enable_busmaster(&pdev);
                _present  = 1;
                break;
            }
        }
    }
    if (!_present) return -1;
    return ahci_enable();
}

int ahci_present(void) { return _present; }

uint32_t ahci_hba_base(void) { return _hba_phys; }

/* ── AHCI enable ──────────────────────────────────────────────────────────── */

int ahci_enable(void) {
    /* Set GHC.AHCI_EN (bit 31) */
    uint32_t ghc = ahci_hba_read32(AHCI_REG_GHC);
    ghc |= AHCI_GHC_AHCI_EN;
    ahci_hba_write32(AHCI_REG_GHC, ghc);

    /* Clear pending interrupts */
    ahci_hba_write32(AHCI_REG_IS, 0xFFFFFFFFu);

    return 0;
}

/* ── Port helpers ─────────────────────────────────────────────────────────── */

uint32_t ahci_ports_implemented(void) {
    return ahci_hba_read32(AHCI_REG_PI);
}

int ahci_port_device_present(uint8_t port) {
    uint32_t ssts = ahci_port_read32(port, AHCI_PORT_SSTS);
    return ((ssts & 0xFu) == AHCI_SSTS_DET_PRESENT);
}

uint32_t ahci_port_signature(uint8_t port) {
    return ahci_port_read32(port, AHCI_PORT_SIG);
}
