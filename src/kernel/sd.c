/*
 * sd.c — SD/MMC card driver stub (item 84)
 * Real SDHCI implementation deferred; provides API surface for TypeScript.
 */
#include "sd.h"
#include "pci.h"
#include "platform.h"
#include <string.h>

#define SDHCI_PCI_CLASS  0x080500u  /* Base 8 = generic, Sub 5 = SD host */

static int _sd_present = 0;
static sd_card_info_t _card = {0};

int sd_init(void) {
    /* Scan PCI for SDHCI controller */
    pci_device_t dev;
    int found = 0;
    for (uint8_t bus = 0; bus < 8 && !found; bus++) {
        for (uint8_t d = 0; d < 32 && !found; d++) {
            uint32_t id = pci_config_read(bus, d, 0, 0);
            if ((id & 0xFFFF) == 0xFFFF) continue;
            uint32_t cls = pci_config_read(bus, d, 0, 0x08) >> 8;
            if ((cls & 0xFFFFFF) == SDHCI_PCI_CLASS) {
                dev.bus = bus; dev.device = d; dev.function = 0;
                found = 1;
            }
        }
    }
    if (!found) {
        platform_boot_print("[SD] No SDHCI controller found\n");
        return -1;
    }
    /* TODO: SDHCI initialisation, card detect, CMD0/CMD8/ACMD41/CMD2/CMD3 */
    platform_boot_print("[SD] SDHCI found, card init stub (not fully implemented)\n");
    _sd_present = 0;  /* Cannot confirm card without real implementation */
    return -1;
}

int sd_present(void)       { return _sd_present; }
uint32_t sd_sector_count(void) { return _sd_present ? _card.block_count : 0; }

int sd_get_info(sd_card_info_t *out) {
    if (!out || !_sd_present) return -1;
    *out = _card;
    return 0;
}

int sd_read_block(uint32_t lba, void *buf) {
    (void)lba; (void)buf;
    return -1;  /* Stub */
}

int sd_write_block(uint32_t lba, const void *buf) {
    (void)lba; (void)buf;
    return -1;  /* Stub */
}
