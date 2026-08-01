/*
 * Intel 8254x (e1000) Ethernet Driver Stub  (item 90)
 *
 * Provides enough structure to detect the NIC via PCI and pass raw
 * Ethernet frames to/from QuickJS.  Full packet processing lives in TS.
 *
 * Supported PCI IDs: 0x8086:0x100E (QEMU default e1000)
 */
#ifndef E1000_H
#define E1000_H

#include <stdint.h>

/* e1000 MMIO register offsets */
#define E1000_REG_CTRL    0x0000u  /* Device Control        */
#define E1000_REG_STATUS  0x0008u  /* Device Status         */
#define E1000_REG_ICR     0x00C0u  /* Interrupt Cause Read  */
#define E1000_REG_IMS     0x00D0u  /* Interrupt Mask Set    */
#define E1000_REG_IMC     0x00D8u  /* Interrupt Mask Clear  */
#define E1000_REG_RCTL    0x0100u  /* Receive Control       */
#define E1000_REG_TCTL    0x0400u  /* Transmit Control      */
#define E1000_REG_RDBAL   0x2800u  /* RX Desc Base Lo       */
#define E1000_REG_RDLEN   0x2808u  /* RX Desc Ring Length   */
#define E1000_REG_RDH     0x2810u  /* RX Desc Head          */
#define E1000_REG_RDT     0x2818u  /* RX Desc Tail          */
#define E1000_REG_TDBAL   0x3800u  /* TX Desc Base Lo       */
#define E1000_REG_TDLEN   0x3808u  /* TX Desc Ring Length   */
#define E1000_REG_TDH     0x3810u  /* TX Desc Head          */
#define E1000_REG_TDT     0x3818u  /* TX Desc Tail          */
#define E1000_REG_RAL     0x5400u  /* Receive Address Low   */
#define E1000_REG_RAH     0x5404u  /* Receive Address High  */

/* Descriptor ring sizes (must be multiple of 8) */
#define E1000_NUM_RX_DESC  32
#define E1000_NUM_TX_DESC  32
#define E1000_PACKET_SIZE  2048u

/* Receive descriptor (legacy format, 16 bytes) */
typedef struct {
    uint64_t buffer_addr;
    uint16_t length;
    uint16_t checksum;
    uint8_t  status;
    uint8_t  errors;
    uint16_t special;
} __attribute__((packed)) e1000_rx_desc_t;

/* Transmit descriptor (legacy format, 16 bytes) */
typedef struct {
    uint64_t buffer_addr;
    uint16_t length;
    uint8_t  cso;
    uint8_t  cmd;
    uint8_t  status;
    uint8_t  css;
    uint16_t special;
} __attribute__((packed)) e1000_tx_desc_t;

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Initialise the e1000 NIC.  mmio_base = BAR0 physical address (mapped 1:1).
 * Returns 0 on success, -1 if device not usable.
 */
int  e1000_init(uint32_t mmio_base);

/** Returns 1 if an e1000 was successfully initialised, 0 otherwise. */
int  e1000_present(void);

/** Copy a raw Ethernet frame into buf (max buf_len bytes).
 *  Returns number of bytes received, 0 if no frame ready, -1 on error.   */
int  e1000_recv(uint8_t *buf, uint16_t buf_len);

/** Transmit a raw Ethernet frame.  Returns 0 on success, -1 on error.    */
int  e1000_send(const uint8_t *buf, uint16_t len);

/** Read the 6-byte MAC address into mac[6]. */
void e1000_get_mac(uint8_t mac[6]);

#endif /* E1000_H */
