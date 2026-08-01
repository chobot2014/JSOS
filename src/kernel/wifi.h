/*
 * wifi.h — WiFi driver stub (item 94)
 *
 * WiFi support via PCI PCIe WiFi card (e.g. Intel Wireless, Atheros ath9k).
 * Stub provides API surface; real driver requires firmware loading + MAC80211.
 */
#ifndef WIFI_H
#define WIFI_H

#include <stdint.h>

#define WIFI_SSID_MAX  33  /* max SSID length + NUL */
#define WIFI_KEY_MAX   65  /* max WPA2 PSK length + NUL */

typedef enum {
    WIFI_AUTH_OPEN   = 0,
    WIFI_AUTH_WEP    = 1,
    WIFI_AUTH_WPA    = 2,
    WIFI_AUTH_WPA2   = 3,
} wifi_auth_t;

typedef struct {
    char     ssid[WIFI_SSID_MAX];
    uint8_t  bssid[6];
    int8_t   rssi;          /* Signal strength in dBm */
    wifi_auth_t auth;
    uint8_t  channel;
} wifi_ap_t;

/* wifi_init() — probe PCI for supported WiFi NIC. Returns 0 if found. */
int wifi_init(void);

/* wifi_present() — 1 if a WiFi NIC was detected. */
int wifi_present(void);

/* wifi_scan(aps, max) — scan for APs; fills up to <max> entries.
 * Returns count found, < 0 on error. */
int wifi_scan(wifi_ap_t *aps, int max);

/* wifi_connect(ssid, key) — associate and authenticate.
 * key may be NULL for WIFI_AUTH_OPEN.  Returns 0 OK, -1 error. */
int wifi_connect(const char *ssid, const char *key);

/* wifi_disconnect() — disassociate from current AP. */
void wifi_disconnect(void);

/* wifi_connected() — 1 if currently associated and IP-ready. */
int wifi_connected(void);

/* wifi_get_mac(mac6) — fill 6-byte MAC. */
int wifi_get_mac(uint8_t mac6[6]);

/* wifi_rssi() — current signal strength in dBm; 0 if not connected. */
int8_t wifi_rssi(void);

#endif /* WIFI_H */
