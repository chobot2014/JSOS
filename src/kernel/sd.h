/*
 * sd.h — SD/MMC card driver stub (item 84)
 *
 * Implements the SPI/SDIO layer for SD card access.  Current stub provides
 * the block-device API; a real implementation would target the SDHCI PCI
 * controller class 0x080500 (Base Class 8, Sub-Class 5).
 */
#ifndef SD_H
#define SD_H

#include <stdint.h>

/* SD card info */
typedef struct {
    uint8_t  present;       /* 1 if card detected */
    uint8_t  sdhc;          /* 1 if SDHC/SDXC (block-addressed) */
    uint32_t block_count;   /* Total 512-byte blocks */
    uint8_t  csd[16];       /* Raw CSD register (128-bit) */
} sd_card_info_t;

/* sd_init() — scan for SDHCI controller; initialise card if present.
 * Returns 0 on success, -1 if no controller/card. */
int sd_init(void);

/* sd_present() — 1 if a card was initialised successfully. */
int sd_present(void);

/* sd_get_info(info) — fill card information struct. Returns 0 OK or -1. */
int sd_get_info(sd_card_info_t *info);

/* sd_read_block(lba, buf) — read one 512-byte block. Returns 0 OK. */
int sd_read_block(uint32_t lba, void *buf);

/* sd_write_block(lba, buf) — write one 512-byte block. Returns 0 OK. */
int sd_write_block(uint32_t lba, const void *buf);

/* sd_sector_count() — total number of 512-byte sectors; 0 if not present. */
uint32_t sd_sector_count(void);

#endif /* SD_H */
