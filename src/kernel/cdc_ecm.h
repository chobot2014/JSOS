/*
 * cdc_ecm.h — USB CDC-ECM Ethernet stub (item 93)
 * cdc_ecm.c — USB CDC-ECM Ethernet stub (item 93)
 *
 * CDC-ECM (Ethernet Control Model) allows USB devices to present as a NIC.
 * This stub provides the API surface; real implementation needs USB bulk
 * pipe TX/RX support in usb.c.
 */
#ifndef CDC_ECM_H
#define CDC_ECM_H

#include <stdint.h>

/* cdc_ecm_init() — look for CDC-ECM device; returns 0 if found, -1 if not. */
int cdc_ecm_init(void);

/* cdc_ecm_present() — 1 if a CDC-ECM interface is active. */
int cdc_ecm_present(void);

/* cdc_ecm_get_mac(mac6) — fills 6-byte MAC address. */
int cdc_ecm_get_mac(uint8_t mac6[6]);

/* cdc_ecm_send(buf, len) — enqueue an Ethernet frame for TX. Returns 0 OK. */
int cdc_ecm_send(const void *buf, uint16_t len);

/* cdc_ecm_recv(buf, max_len) — read a received Ethernet frame.
 * Returns frame length, 0 if no frame ready, < 0 on error. */
int cdc_ecm_recv(void *buf, uint16_t max_len);

/* cdc_ecm_link_up() — 1 if network link is up. */
int cdc_ecm_link_up(void);

#endif /* CDC_ECM_H */
