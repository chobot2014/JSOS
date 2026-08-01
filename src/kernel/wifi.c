/*
 * wifi.c — WiFi driver stub (item 94)
 * Real implementation requires PCIe WiFi NIC PCI ID table + firmware blob loading.
 */
#include "wifi.h"
#include "platform.h"
#include <string.h>

static int _present = 0;
static uint8_t _mac[6] = {0x02,0x00,0xDE,0xAD,0xBE,0xEF};

int wifi_init(void) {
    platform_boot_print("[WIFI] Stub: no supported WiFi NIC driver\n");
    _present = 0;
    return -1;
}
int wifi_present(void)    { return _present; }
int wifi_connected(void)  { return 0; }
int8_t wifi_rssi(void)    { return 0; }
void wifi_disconnect(void){}
int wifi_get_mac(uint8_t mac6[6]) { if (!mac6) return -1; memcpy(mac6, _mac, 6); return _present ? 0 : -1; }
int wifi_scan(wifi_ap_t *aps, int max) { (void)aps; (void)max; return 0; }
int wifi_connect(const char *s, const char *k) { (void)s;(void)k; return -1; }
