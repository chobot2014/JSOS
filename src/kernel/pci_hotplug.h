/*
 * pci_hotplug.h — PCI hotplug and Thunderbolt stub (items 100, 101)
 *
 * Items covered:
 *   100 — PCI hotplug: detect card insertion/removal via SHPC or PCIe HPE
 *   101 — Thunderbolt / USB4 hot-plug enumeration
 *
 * Real implementation requires ACPI _OSC hotplug capability negotiation and
 * PCIe Hot-Plug Interrupt (HPE) in the port's Slot Control register.
 */
#ifndef PCI_HOTPLUG_H
#define PCI_HOTPLUG_H

#include <stdint.h>
#include "pci.h"

/* Hotplug event types */
typedef enum {
    PCI_HP_EVENT_INSERTED = 1,
    PCI_HP_EVENT_REMOVED  = 2,
    PCI_HP_EVENT_SURPRISE = 3,   /* surprise removal */
} pci_hp_event_t;

/* Hotplug callback: called when an event is detected.
 * bus/dev/fn identify the slot; event indicates what happened. */
typedef void (*pci_hotplug_cb_t)(uint8_t bus, uint8_t dev, uint8_t fn,
                                  pci_hp_event_t event, void *user);

/* ── PCI hotplug (item 100) ──────────────────────────────────────────────── */

/* pci_hotplug_init() — detect hotplug capable PCIe root ports; returns count. */
int pci_hotplug_init(void);

/* pci_hotplug_register(cb, user) — register hotplug event callback. */
void pci_hotplug_register(pci_hotplug_cb_t cb, void *user);

/* pci_hotplug_poll() — poll slot status registers for pending events.
 * Call periodically from the OS timer or IRQ. */
void pci_hotplug_poll(void);

/* pci_hotplug_enable_slot(bus, dev) — enable hot-plug on a specific PCIe port. */
int pci_hotplug_enable_slot(uint8_t bus, uint8_t dev);

/* ── Thunderbolt / USB4 (item 101) ───────────────────────────────────────── */

/* thunderbolt_init() — scan for Thunderbolt host controller (Intel JHL*/
/*                      PCI class 0x0C80 = USB4/TBT). Returns 0 if found. */
int thunderbolt_init(void);

/* thunderbolt_present() — 1 if TBT/USB4 host was detected. */
int thunderbolt_present(void);

/* thunderbolt_get_device_count() — number of TBT devices enumerated. */
int thunderbolt_get_device_count(void);

#endif /* PCI_HOTPLUG_H */
