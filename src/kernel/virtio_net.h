#ifndef VIRTIO_NET_H
#define VIRTIO_NET_H

#include <stdint.h>

/* True once virtio_net_init() succeeds */
extern int virtio_net_ready;

/* PCI location of the found device */
extern uint8_t  virtio_net_pci_bus;
extern uint8_t  virtio_net_pci_dev;
extern uint8_t  virtio_net_pci_fn;
extern uint8_t  virtio_net_mac[6];

/**
 * Probe PCI for a virtio-net device, initialise TX/RX virtqueues.
 * Returns 1 on success, 0 if no device found.
 */
int  virtio_net_init(void);

/**
 * Send an Ethernet frame (including Ethernet header, no CRC).
 * len must be <= 1514.  May block briefly while TX queue drains.
 */
void virtio_net_send(const uint8_t *frame, uint16_t len);

/**
 * Poll the RX ring for a received frame.
 * Returns frame length (> 0) and fills buf (caller must provide >= 1514 bytes).
 * Returns 0 if no frame is ready.
 */
uint16_t virtio_net_recv(uint8_t *buf);

/**
 * Debug: return the current value of rx_vq.used.idx (how many RX frames QEMU has placed).
 */
uint16_t virtio_net_rx_used_idx(void);

/**
 * Debug: return (io_base << 16) | tx_vq_pfn for diagnostics.
 */
uint32_t virtio_net_debug_info(void);

/**
 * Debug: return (device_status << 16) | tx_vq.used.idx.
 */
uint32_t virtio_net_debug_status(void);

/**
 * Debug: return (rx_queue_size << 16) | tx_queue_size.
 */
uint32_t virtio_net_debug_queues(void);

#endif /* VIRTIO_NET_H */
