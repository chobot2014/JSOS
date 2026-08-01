/*
 * cdc_ecm.c — USB CDC-ECM Ethernet stub (item 93)
 */
#include "cdc_ecm.h"
#include "platform.h"
#include <string.h>

static int _present = 0;
static uint8_t _mac[6] = {0x52,0x54,0x00,0xEE,0xCE,0xCE};

int cdc_ecm_init(void) {
    platform_boot_print("[CDC-ECM] Stub: USB bulk pipe TX/RX not implemented\n");
    _present = 0;
    return -1;
}
int cdc_ecm_present(void)                    { return _present; }
int cdc_ecm_link_up(void)                    { return 0; }
int cdc_ecm_get_mac(uint8_t mac6[6])         { if (!mac6) return -1; memcpy(mac6, _mac, 6); return _present ? 0 : -1; }
int cdc_ecm_send(const void *b, uint16_t l)  { (void)b;(void)l; return -1; }
int cdc_ecm_recv(void *b, uint16_t m)        { (void)b;(void)m; return 0; }
