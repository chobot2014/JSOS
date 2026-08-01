/*
 * ahci.h — SATA AHCI C register layer (item 83)
 *
 * C maps the HBA MMIO registers (Generic Host Control + per-port registers).
 * TypeScript implements FIS construction, command list management, and
 * port state machines.
 *
 * ARCHITECTURE CONSTRAINT: All AHCI protocol logic lives in TypeScript.
 */
#ifndef AHCI_H
#define AHCI_H

#include <stdint.h>

/* ── PCI identity ───────────────────────────────────────────────────────── */
#define AHCI_PCI_CLASS 0x0101u   /* Mass Storage, IDE (AHCI often 0x010601) */
#define AHCI_PCI_CLASS_AHCI 0x010601u

/* ── AHCI Generic Host Control registers (HBA MMIO base + offset) ───────── */
#define AHCI_REG_CAP        0x0000u  /* Host Capabilities */
#define AHCI_REG_GHC        0x0004u  /* Global Host Control */
#define AHCI_REG_IS         0x0008u  /* Interrupt Status */
#define AHCI_REG_PI         0x000Cu  /* Ports Implemented */
#define AHCI_REG_VS         0x0010u  /* Version */
#define AHCI_REG_CCC_CTL    0x0014u  /* Command Completion Coalescing Control */
#define AHCI_REG_CAP2       0x0024u  /* Host Capabilities Extended */
#define AHCI_REG_BOHC       0x0028u  /* BIOS/OS Handoff Control */

/* GHC bits */
#define AHCI_GHC_RESET      (1u << 0)   /* HBA Reset */
#define AHCI_GHC_IE         (1u << 1)   /* Interrupt Enable */
#define AHCI_GHC_AHCI_EN    (1u << 31)  /* AHCI Enable */

/* CAP bits */
#define AHCI_CAP_NP_MASK    0x1Fu        /* Number of Ports − 1 */
#define AHCI_CAP_NCS_SHIFT  8u           /* Number of Command Slots − 1 */
#define AHCI_CAP_NCS_MASK   (0x1Fu << AHCI_CAP_NCS_SHIFT)

/* ── Per-port register offsets (base = HBA_BASE + 0x100 + port*0x80) ───── */
#define AHCI_PORT_CLB       0x00u   /* Command List Base Address (lo) */
#define AHCI_PORT_CLBU      0x04u   /* Command List Base (hi 32 bits) */
#define AHCI_PORT_FB        0x08u   /* FIS Base Address */
#define AHCI_PORT_FBU       0x0Cu
#define AHCI_PORT_IS        0x10u   /* Interrupt Status */
#define AHCI_PORT_IE        0x14u   /* Interrupt Enable */
#define AHCI_PORT_CMD       0x18u   /* Command and Status */
#define AHCI_PORT_TFD       0x20u   /* Task File Data (STS/ERR) */
#define AHCI_PORT_SIG       0x24u   /* Signature */
#define AHCI_PORT_SSTS      0x28u   /* SATA Status (SCR0/SStatus) */
#define AHCI_PORT_SCTL      0x2Cu   /* SATA Control */
#define AHCI_PORT_SERR      0x30u   /* SATA Error */
#define AHCI_PORT_SACT      0x34u   /* SATA Active (for NCQ) */
#define AHCI_PORT_CI        0x38u   /* Command Issue */

/* PORT CMD bits */
#define AHCI_PORT_CMD_ST    (1u << 0)   /* Start (DMA engine on) */
#define AHCI_PORT_CMD_SUD   (1u << 1)   /* Spin-Up Device */
#define AHCI_PORT_CMD_POD   (1u << 2)   /* Power On Device */
#define AHCI_PORT_CMD_CLO   (1u << 3)   /* Command List Override */
#define AHCI_PORT_CMD_FRE   (1u << 4)   /* FIS Receive Enable */
#define AHCI_PORT_CMD_FR    (1u << 14)  /* FIS Receive Running */
#define AHCI_PORT_CMD_CR    (1u << 15)  /* Command List Running */

/* PORT SSTS: DET field bits [3:0] */
#define AHCI_SSTS_DET_PRESENT 0x3u   /* Device present and PHY comms established */

/* Port signature values */
#define AHCI_SIG_ATA        0x00000101u   /* ATA device */
#define AHCI_SIG_ATAPI      0xEB140101u   /* ATAPI device */
#define AHCI_SIG_SEMB       0xC33C0101u   /* Enclosure management bridge */
#define AHCI_SIG_PM         0x96690101u   /* Port multiplier */

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Find and initialise the first AHCI HBA via PCI class 0x010601.
 * Returns 0 on success, -1 if not found.
 * (item 83)
 */
int ahci_init(void);

/**
 * Returns 1 if an AHCI controller is present and ready.
 */
int ahci_present(void);

/**
 * Return the HBA MMIO base address (physical, 32-bit).
 * TypeScript maps this to perform register reads/writes.
 */
uint32_t ahci_hba_base(void);

/**
 * Read a 32-bit HBA register at byte offset `reg`.
 */
uint32_t ahci_hba_read32(uint32_t reg);

/**
 * Write a 32-bit HBA register.
 */
void ahci_hba_write32(uint32_t reg, uint32_t val);

/**
 * Read a 32-bit port register.
 * @param port  Port number (0-based, must be < number of ports).
 * @param reg   Port register offset (AHCI_PORT_xxx).
 */
uint32_t ahci_port_read32(uint8_t port, uint32_t reg);

/**
 * Write a 32-bit port register.
 */
void ahci_port_write32(uint8_t port, uint32_t reg, uint32_t val);

/**
 * Return the bitmask of implemented ports (from PI register).
 */
uint32_t ahci_ports_implemented(void);

/**
 * Check if a port has a device attached (SSTS.DET == 3).
 */
int ahci_port_device_present(uint8_t port);

/**
 * Return port signature (AHCI_SIG_ATA / AHCI_SIG_ATAPI).
 */
uint32_t ahci_port_signature(uint8_t port);

/**
 * Enable AHCI mode (GHC.AHCI_EN) and clear pending interrupts.
 */
int ahci_enable(void);

#endif /* AHCI_H */
