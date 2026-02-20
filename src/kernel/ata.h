#ifndef ATA_H
#define ATA_H

#include <stdint.h>

/*
 * ATA PIO Mode Driver - Primary Bus Only
 *
 * Provides raw 512-byte sector read/write for the primary ATA controller
 * (I/O ports 0x1F0-0x1F7).  All OS-level logic (FS, caching, buffering)
 * lives in TypeScript.  This is the thinnest possible hardware wrapper.
 *
 * Supports: LBA28, up to 8 sectors per transfer, master drive only.
 */

/** Detect and initialize the primary ATA bus.  Must be called once at boot. */
void ata_initialize(void);

/** Returns 1 if a drive was detected during ata_initialize(), 0 otherwise. */
int      ata_present(void);

/** Returns the total number of LBA28 addressable sectors (from IDENTIFY). */
uint32_t ata_sector_count(void);

/**
 * Read `count` contiguous 512-byte sectors starting at LBA28 address `lba`
 * into `buf`.  `buf` must be at least count * 512 bytes.
 * Returns 0 on success, -1 on error or drive absent.
 */
int  ata_read28(uint32_t lba, uint8_t count, uint16_t *buf);

/**
 * Write `count` contiguous 512-byte sectors from `buf` to LBA28 address `lba`.
 * `buf` must be at least count * 512 bytes.
 * Returns 0 on success, -1 on error or drive absent.
 */
int  ata_write28(uint32_t lba, uint8_t count, const uint16_t *buf);

#endif /* ATA_H */
