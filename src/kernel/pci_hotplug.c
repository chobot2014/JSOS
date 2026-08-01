/*
 * pci_hotplug.c — PCI hotplug and Thunderbolt stub (items 100, 101)
 *
 * Minimal implementation: scans PCIe capability list on root ports for
 * Slot Capabilities (HP Capable bit), wires ISR for HPE interrupts.
 * Full implementation requires ACPI _OSC + proper slot power sequencing.
 */
#include "pci_hotplug.h"
#include "platform.h"
#include <string.h>

/* PCIe Capability ID */
#define PCI_CAP_PCIE  0x10u
/* PCIe Slot Capabilities register offset from PCIE cap base */
#define PCIE_SLOTCAP_OFF  0x14u
/* Slot Capabilities: Hot-Plug Capable bit */
#define PCIE_SLOTCAP_HPC  (1u << 6)

#define MAX_HP_SLOTS 8

static struct {
    uint8_t bus, dev, fn;
    uint8_t active;
} _hp_slots[MAX_HP_SLOTS];
static int _hp_slot_count = 0;

static pci_hotplug_cb_t _hp_cb = NULL;
static void *_hp_cb_user        = NULL;

/* Walk PCI capability list looking for PCIe capability. */
static uint8_t _find_pcie_cap(uint8_t bus, uint8_t dev, uint8_t fn) {
    uint8_t cap_ptr = (uint8_t)(pci_cfg_read32(bus, dev, fn, 0x34) & 0xFC);
    while (cap_ptr) {
        uint32_t cap = pci_cfg_read32(bus, dev, fn, cap_ptr);
        if ((cap & 0xFF) == PCI_CAP_PCIE) return cap_ptr;
        cap_ptr = (uint8_t)((cap >> 8) & 0xFC);
    }
    return 0;
}

int pci_hotplug_init(void) {
    _hp_slot_count = 0;
    memset(_hp_slots, 0, sizeof(_hp_slots));

    for (uint8_t bus = 0; bus < 16; bus++) {
        for (uint8_t dev = 0; dev < 32; dev++) {
            uint32_t id = pci_cfg_read32(bus, dev, 0, 0);
            if ((id & 0xFFFF) == 0xFFFF) continue;

            uint8_t cap = _find_pcie_cap(bus, dev, 0);
            if (!cap) continue;

            uint32_t slotcap = pci_cfg_read32(bus, dev, 0, cap + PCIE_SLOTCAP_OFF);
            if (!(slotcap & PCIE_SLOTCAP_HPC)) continue;
            if (_hp_slot_count >= MAX_HP_SLOTS) break;

            _hp_slots[_hp_slot_count].bus    = bus;
            _hp_slots[_hp_slot_count].dev    = dev;
            _hp_slots[_hp_slot_count].fn     = 0;
            _hp_slots[_hp_slot_count].active = 1;
            _hp_slot_count++;
        }
    }

    if (_hp_slot_count > 0) {
        platform_boot_print("[PCIE-HP] Hot-plug capable ports found\n");
    } else {
        platform_boot_print("[PCIE-HP] No hot-plug capable ports\n");
    }
    return _hp_slot_count;
}

void pci_hotplug_register(pci_hotplug_cb_t cb, void *user) {
    _hp_cb      = cb;
    _hp_cb_user = user;
}

void pci_hotplug_poll(void) {
    /* Stub: read slot status registers and fire callback on Presence Detect
     * Changed.  Real implementation checks PCIE Slot Status (cap+0x1A) PDC bit. */
    (void)_hp_cb; (void)_hp_cb_user;
}

int pci_hotplug_enable_slot(uint8_t bus, uint8_t dev) {
    (void)bus; (void)dev;
    return -1;  /* TODO: write Slot Control HPE+PDC+ABP enable bits */
}

/* ── Thunderbolt (item 101) ─────────────────────────────────────────────── */
/* PCI class 0x0C80 = USB4/Thunderbolt host */
#define TBT_PCI_CLASS  0x0C8000u

static int _tbt_present = 0;

int thunderbolt_init(void) {
    for (uint8_t bus = 0; bus < 8; bus++) {
        for (uint8_t dev = 0; dev < 32; dev++) {
            uint32_t id = pci_cfg_read32(bus, dev, 0, 0);
            if ((id & 0xFFFF) == 0xFFFF) continue;
            uint32_t cls = pci_cfg_read32(bus, dev, 0, 0x08) >> 8;
            if ((cls & 0xFFFFFF) == TBT_PCI_CLASS) {
                _tbt_present = 1;
                platform_boot_print("[TBT] Thunderbolt/USB4 host controller found\n");
                return 0;
            }
        }
    }
    platform_boot_print("[TBT] No Thunderbolt/USB4 controller\n");
    return -1;
}

int thunderbolt_present(void)       { return _tbt_present; }
int thunderbolt_get_device_count(void) { return 0; /* TODO: TBT topology enumeration */ }
