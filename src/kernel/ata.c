/*
 * ATA PIO Mode Driver
 *
 * Raw sector read/write for the primary ATA controller using PIO mode.
 * No DMA, no IRQs — polling only.  Suitable for bare-metal single-threaded use.
 *
 * Primary bus:  I/O 0x1F0-0x1F7, control 0x3F6
 * Supports LBA28, master drive, up to 8 sectors per call.
 *
 * C code mandate: only hardware I/O primitives live here.
 * All caching, FS logic, and OS policy lives in TypeScript.
 */

#include "ata.h"
#include "io.h"
#include <stdint.h>
#include <stddef.h>

/* ── I/O port map (primary bus) ─────────────────────────────────────────── */
#define ATA_DATA         0x1F0  /* 16-bit data register                      */
#define ATA_ERROR        0x1F1  /* read: error register                      */
#define ATA_FEATURES     0x1F1  /* write: features                           */
#define ATA_SECTOR_COUNT 0x1F2
#define ATA_LBA_LO       0x1F3
#define ATA_LBA_MID      0x1F4
#define ATA_LBA_HI       0x1F5
#define ATA_DRIVE_HEAD   0x1F6
#define ATA_STATUS       0x1F7  /* read: status                              */
#define ATA_COMMAND      0x1F7  /* write: command                            */
#define ATA_ALT_STATUS   0x3F6  /* read: alternate status (no IRQ clear)     */
#define ATA_DEV_CTRL     0x3F6  /* write: device control                     */

/* ── Status register bits ───────────────────────────────────────────────── */
#define ATA_SR_BSY  0x80  /* Busy — drive is working, ignore other bits      */
#define ATA_SR_DRDY 0x40  /* Drive Ready                                     */
#define ATA_SR_DRQ  0x08  /* Data Request — data transfer ready              */
#define ATA_SR_ERR  0x01  /* Error — check error register                    */

/* ── ATA commands ───────────────────────────────────────────────────────── */
#define ATA_CMD_READ_PIO   0x20
#define ATA_CMD_WRITE_PIO  0x30
#define ATA_CMD_CACHE_FLUSH 0xE7
#define ATA_CMD_IDENTIFY   0xEC

static int ata_drive_present = 0;

/* ── Internal helpers ───────────────────────────────────────────────────── */

/* 400 ns delay via four reads of the alt-status register (≈ 1 µs each) */
static void ata_delay400ns(void) {
    inb(ATA_ALT_STATUS);
    inb(ATA_ALT_STATUS);
    inb(ATA_ALT_STATUS);
    inb(ATA_ALT_STATUS);
}

/**
 * Wait until BSY clears and (optionally) DRQ sets.
 * Returns the final status byte, or 0xFF on timeout.
 */
static uint8_t ata_wait(int wait_drq) {
    uint8_t status;
    int timeout = 0x100000;

    do {
        status = inb(ATA_STATUS);
        if (--timeout <= 0) return 0xFF; /* timeout */
    } while (status & ATA_SR_BSY);

    if (wait_drq) {
        timeout = 0x100000;
        while (!((status = inb(ATA_STATUS)) & ATA_SR_DRQ)) {
            if (status & ATA_SR_ERR) return status;
            if (--timeout <= 0)      return 0xFF;
        }
    }
    return status;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

void ata_initialize(void) {
    /* Software reset: set SRST bit, hold, then clear */
    outb(ATA_DEV_CTRL, 0x04);
    ata_delay400ns();
    outb(ATA_DEV_CTRL, 0x00);
    ata_delay400ns();

    /* Floating bus check — if status reads 0xFF there is no controller */
    if (inb(ATA_STATUS) == 0xFF) {
        ata_drive_present = 0;
        return;
    }

    /* Select master drive in LBA mode */
    outb(ATA_DRIVE_HEAD, 0xE0);
    ata_delay400ns();

    /* Send IDENTIFY to confirm a drive is present */
    outb(ATA_COMMAND, ATA_CMD_IDENTIFY);
    ata_delay400ns();

    uint8_t status = inb(ATA_STATUS);
    if (status == 0x00 || status == 0xFF) {
        ata_drive_present = 0;
        return;
    }

    /* Wait for BSY to clear; read and discard IDENTIFY data */
    uint8_t st = ata_wait(1);
    if ((st & (ATA_SR_ERR | ATA_SR_BSY)) == 0 && (st & ATA_SR_DRQ)) {
        /* Consume the 256-word IDENTIFY response */
        for (int i = 0; i < 256; i++) inw(ATA_DATA);
        ata_drive_present = 1;
    } else {
        ata_drive_present = 0;
    }
}

int ata_present(void) {
    return ata_drive_present;
}

int ata_read28(uint32_t lba, uint8_t count, uint16_t *buf) {
    if (!ata_drive_present || count == 0 || count > 8) return -1;

    if (ata_wait(0) == 0xFF) return -1;

    /* LBA28 setup: select master, set address */
    outb(ATA_DRIVE_HEAD,    (uint8_t)(0xE0 | ((lba >> 24) & 0x0F)));
    outb(ATA_SECTOR_COUNT,  count);
    outb(ATA_LBA_LO,        (uint8_t)( lba        & 0xFF));
    outb(ATA_LBA_MID,       (uint8_t)((lba >>  8) & 0xFF));
    outb(ATA_LBA_HI,        (uint8_t)((lba >> 16) & 0xFF));
    outb(ATA_COMMAND,       ATA_CMD_READ_PIO);

    for (int s = 0; s < count; s++) {
        uint8_t st = ata_wait(1);
        if (st == 0xFF || (st & ATA_SR_ERR)) return -1;

        /* Read 256 × 16-bit words = 512 bytes */
        uint16_t *dst = buf + (size_t)s * 256;
        for (int i = 0; i < 256; i++) dst[i] = inw(ATA_DATA);

        ata_delay400ns();
    }
    return 0;
}

int ata_write28(uint32_t lba, uint8_t count, const uint16_t *buf) {
    if (!ata_drive_present || count == 0 || count > 8) return -1;

    if (ata_wait(0) == 0xFF) return -1;

    outb(ATA_DRIVE_HEAD,    (uint8_t)(0xE0 | ((lba >> 24) & 0x0F)));
    outb(ATA_SECTOR_COUNT,  count);
    outb(ATA_LBA_LO,        (uint8_t)( lba        & 0xFF));
    outb(ATA_LBA_MID,       (uint8_t)((lba >>  8) & 0xFF));
    outb(ATA_LBA_HI,        (uint8_t)((lba >> 16) & 0xFF));
    outb(ATA_COMMAND,       ATA_CMD_WRITE_PIO);

    for (int s = 0; s < count; s++) {
        uint8_t st = ata_wait(1);
        if (st == 0xFF || (st & ATA_SR_ERR)) return -1;

        const uint16_t *src = buf + (size_t)s * 256;
        for (int i = 0; i < 256; i++) outw(ATA_DATA, src[i]);

        ata_delay400ns();

        /* Flush write cache after each sector */
        outb(ATA_COMMAND, ATA_CMD_CACHE_FLUSH);
        if (ata_wait(0) == 0xFF) return -1;
    }
    return 0;
}
