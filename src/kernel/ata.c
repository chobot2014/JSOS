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

static int      ata_drive_present  = 0;
static uint32_t ata_total_sectors  = 0;

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

    /* Wait for BSY to clear; read IDENTIFY data */
    uint8_t st = ata_wait(1);
    if ((st & (ATA_SR_ERR | ATA_SR_BSY)) == 0 && (st & ATA_SR_DRQ)) {
        uint16_t id[256];
        for (int i = 0; i < 256; i++) id[i] = inw(ATA_DATA);
        /* Words 60-61: LBA28 addressable sector count (little-endian pair) */
        ata_total_sectors = ((uint32_t)id[61] << 16) | (uint32_t)id[60];
        ata_drive_present = 1;
    } else {
        ata_drive_present = 0;
    }
}

int ata_present(void) {
    return ata_drive_present;
}

uint32_t ata_sector_count(void) {
    return ata_total_sectors;
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

/* ── IRQ-driven PIO transfers (item 78) ─────────────────────────────────── */
/*
 * The ATA device raises IRQ14 (primary bus) when a PIO data transfer is
 * ready.  We use a simple volatile semaphore: irq_handler sets it, callers
 * spin-wait (hlt) until it fires.
 */

#include "irq.h"

static volatile int _ata_irq_fired = 0;
static int          _irq_mode      = 0;

static void _ata_irq14_handler(void) {
    /* Read status to clear the interrupt at the drive side */
    (void)inb(ATA_STATUS);
    _ata_irq_fired = 1;
}

void ata_enable_irq(void) {
    /* nIEN = 0 → enable device IRQ output */
    outb(ATA_DEV_CTRL, 0x00);
    ata_delay400ns();
    irq_install_handler(14, _ata_irq14_handler);
    _irq_mode = 1;
}

static int _ata_wait_irq(void) {
    int timeout = 5000; /* 5 seconds worth of 1 ms sleeps */
    _ata_irq_fired = 0;
    while (!_ata_irq_fired && --timeout > 0)
        __asm__ volatile ("hlt");
    return _ata_irq_fired ? 0 : -1;
}

int ata_read28_irq(uint32_t lba, uint8_t count, uint16_t *buf) {
    if (!ata_drive_present || count == 0 || count > 8) return -1;
    if (ata_wait(0) == 0xFF) return -1;

    outb(ATA_DRIVE_HEAD,   (uint8_t)(0xE0 | ((lba >> 24) & 0x0F)));
    outb(ATA_SECTOR_COUNT, count);
    outb(ATA_LBA_LO,       (uint8_t)( lba        & 0xFF));
    outb(ATA_LBA_MID,      (uint8_t)((lba >>  8) & 0xFF));
    outb(ATA_LBA_HI,       (uint8_t)((lba >> 16) & 0xFF));
    outb(ATA_COMMAND,      ATA_CMD_READ_PIO);

    for (int s = 0; s < count; s++) {
        if (_ata_wait_irq() != 0) return -1;
        uint8_t st = inb(ATA_STATUS);
        if (st & ATA_SR_ERR) return -1;
        uint16_t *dst = buf + (size_t)s * 256;
        for (int i = 0; i < 256; i++) dst[i] = inw(ATA_DATA);
        ata_delay400ns();
    }
    return 0;
}

int ata_write28_irq(uint32_t lba, uint8_t count, const uint16_t *buf) {
    if (!ata_drive_present || count == 0 || count > 8) return -1;
    if (ata_wait(0) == 0xFF) return -1;

    outb(ATA_DRIVE_HEAD,   (uint8_t)(0xE0 | ((lba >> 24) & 0x0F)));
    outb(ATA_SECTOR_COUNT, count);
    outb(ATA_LBA_LO,       (uint8_t)( lba        & 0xFF));
    outb(ATA_LBA_MID,      (uint8_t)((lba >>  8) & 0xFF));
    outb(ATA_LBA_HI,       (uint8_t)((lba >> 16) & 0xFF));
    outb(ATA_COMMAND,      ATA_CMD_WRITE_PIO);

    for (int s = 0; s < count; s++) {
        /* Write needs DRQ first — wait without IRQ */
        uint8_t st = ata_wait(1);
        if (st == 0xFF || (st & ATA_SR_ERR)) return -1;
        const uint16_t *src = buf + (size_t)s * 256;
        for (int i = 0; i < 256; i++) outw(ATA_DATA, src[i]);
        ata_delay400ns();
        /* cache flush generates another IRQ/completion */
        outb(ATA_COMMAND, ATA_CMD_CACHE_FLUSH);
        if (_ata_wait_irq() != 0) return -1;
    }
    return 0;
}

/* ── Bus Master IDE DMA (item 79) ───────────────────────────────────────── */
/*
 * Bus Master IDE DMA uses a Physical Region Descriptor Table (PRDT).
 * Each PRDT entry is 8 bytes:
 *   [0..3] physical base address of buffer
 *   [4..5] byte count (0 means 64 KB)
 *   [6..7] flags: bit 15 = EOT (End Of Table)
 *
 * BMI I/O registers (relative to bmi_base):
 *   +0  Command  (bit 0 = Start/Stop DMA, bit 3 = Write to mem / Read from mem)
 *   +2  Status   (bit 0 = DMA active, bit 1 = DMA error, bit 2 = IRQ)
 *   +4  PRDT address (physical, 4-byte aligned)
 */

#define BMI_CMD   0
#define BMI_STS   2
#define BMI_PRDT  4

/* A PRDT with a single entry can transfer up to 64 KB */
typedef struct {
    uint32_t phys_base;
    uint16_t byte_count;  /* 0 = 64 KB */
    uint16_t flags;       /* bit 15 = EOT */
} __attribute__((packed)) prdt_entry_t;

/* We keep one static PRDT entry for simplicity */
static prdt_entry_t _prdt[1] __attribute__((aligned(4)));
static uint16_t     _bmi_base = 0;

int ata_dma_init(uint16_t bmi_base) {
    if (!bmi_base) return -1;
    _bmi_base = bmi_base;
    /* Clear status flags */
    outb((uint16_t)(_bmi_base + BMI_STS),
         inb((uint16_t)(_bmi_base + BMI_STS)) | 0x06u);
    return 0;
}

int ata_dma_read28(uint32_t lba, uint8_t count,
                   uint32_t buf_phys, uint32_t buf_bytes) {
    if (!_bmi_base || !ata_drive_present) return -1;
    if (count == 0 || buf_bytes == 0) return -1;

    /* Stop any ongoing DMA */
    outb((uint16_t)(_bmi_base + BMI_CMD), 0x00);

    /* Build PRDT */
    _prdt[0].phys_base  = buf_phys;
    _prdt[0].byte_count = (uint16_t)(buf_bytes >= 65536u ? 0 : buf_bytes);
    _prdt[0].flags      = 0x8000u; /* EOT */

    /* Load PRDT address into BMI */
    outl((uint16_t)(_bmi_base + BMI_PRDT), (uint32_t)&_prdt[0]);

    /* Clear error + IRQ status bits */
    outb((uint16_t)(_bmi_base + BMI_STS),
         inb((uint16_t)(_bmi_base + BMI_STS)) | 0x06u);

    /* Issue LBA28 READ DMA command to drive */
    outb(ATA_DRIVE_HEAD,   (uint8_t)(0xE0 | ((lba >> 24) & 0x0F)));
    outb(ATA_SECTOR_COUNT, count);
    outb(ATA_LBA_LO,       (uint8_t)( lba        & 0xFF));
    outb(ATA_LBA_MID,      (uint8_t)((lba >>  8) & 0xFF));
    outb(ATA_LBA_HI,       (uint8_t)((lba >> 16) & 0xFF));
    outb(ATA_COMMAND,      0xC8u); /* READ DMA */

    /* Start DMA (bit 0 = start, read direction = bit 3 clear) */
    outb((uint16_t)(_bmi_base + BMI_CMD), 0x01u);

    /* Wait for IRQ or timeout */
    if (_ata_wait_irq() != 0) {
        outb((uint16_t)(_bmi_base + BMI_CMD), 0x00);
        return -1;
    }

    /* Stop DMA engine */
    outb((uint16_t)(_bmi_base + BMI_CMD), 0x00);

    uint8_t sts = inb((uint16_t)(_bmi_base + BMI_STS));
    if (sts & 0x02u) return -1; /* DMA error */

    return 0;
}

/* ══ ATAPI packet command interface (item 80) ═══════════════════════════════
 *
 * ATAPI devices (CD-ROM, DVD) sit on an ATA bus and accept 12-byte command
 * packets via the PACKET command (0xA0).  Detection uses IDENTIFY PACKET
 * DEVICE (0xA1) which is distinct from regular ATA IDENTIFY (0xEC).
 *
 * Architecture: C handles the raw PACKET→PIO data transfer cycle.
 * TypeScript builds command packets (READ(10), READ CAPACITY, etc.) and
 * interprets returned data.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Cached ATAPI detection result: -1=unknown, 0=ATA, 1=ATAPI */
static int _atapi_detected = -1;

int ata_is_atapi(void) {
    if (_atapi_detected != -1) return _atapi_detected;

    /* Select master drive */
    outb(ATA_DRIVE_HEAD, 0xA0u);
    for (int i = 0; i < 4; i++) inb(ATA_ALT_STATUS);  /* 400ns delay */

    /* Issue IDENTIFY PACKET DEVICE */
    outb(ATA_COMMAND, 0xA1u);
    for (int i = 0; i < 4; i++) inb(ATA_ALT_STATUS);

    /* Quick BSY poll (50 ms) */
    int timeout = 50000;
    while ((inb(ATA_STATUS) & ATA_SR_BSY) && --timeout > 0);
    if (timeout == 0) { _atapi_detected = -1; return -1; }

    /* If ERR=1, device is not ATAPI */
    if (inb(ATA_STATUS) & 0x01u) { _atapi_detected = 0; return 0; }

    /* Check signature bytes LBA_MID / LBA_HI for ATAPI: 0x14 / 0xEB */
    uint8_t mid = inb(ATA_LBA_MID);
    uint8_t hi  = inb(ATA_LBA_HI);
    _atapi_detected = (mid == 0x14u && hi == 0xEBu) ? 1 : 0;
    return _atapi_detected;
}

int ata_atapi_send_packet(const uint8_t *packet12,
                          void *data_in, uint16_t buf_len) {
    if (!packet12) return -1;

    /* Select master, DMA=0, OVL=0 */
    outb(ATA_DRIVE_HEAD, 0xA0u);
    for (int i = 0; i < 4; i++) inb(ATA_ALT_STATUS);

    /* Write maximum byte count for PIO transfer */
    outb(ATA_FEATURES,     0x00u);   /* no DMA */
    outb(ATA_SECTOR_COUNT, 0x00u);
    outb(ATA_LBA_LO,       0x00u);
    outb(ATA_LBA_MID,      (uint8_t)( buf_len       & 0xFFu));
    outb(ATA_LBA_HI,       (uint8_t)((buf_len >> 8) & 0xFFu));

    /* Issue PACKET command */
    outb(ATA_COMMAND, 0xA0u);
    for (int i = 0; i < 4; i++) inb(ATA_ALT_STATUS);

    /* Wait for DRQ (device ready for packet) */
    int timeout = 100000;
    uint8_t status;
    do {
        status = inb(ATA_STATUS);
        if (status & 0x01u) return -1;  /* ERR set */
    } while ((status & ATA_SR_BSY) && --timeout > 0);
    if (timeout == 0 || !(status & ATA_SR_DRQ)) return -1;

    /* Write the 12-byte command packet as 6 × 16-bit words */
    const uint16_t *pw = (const uint16_t *)packet12;
    for (int i = 0; i < 6; i++) outw(ATA_DATA, pw[i]);

    if (!data_in || buf_len == 0) return 0;   /* non-data command */

    /* Wait for DRQ with data available */
    timeout = 100000;
    do {
        status = inb(ATA_STATUS);
        if (status & 0x01u) return -1;
    } while ((status & ATA_SR_BSY) && --timeout > 0);
    if (timeout == 0 || !(status & ATA_SR_DRQ)) return -1;

    /* Read PIO data */
    uint16_t actual = (uint16_t)((inb(ATA_LBA_HI) << 8) | inb(ATA_LBA_MID));
    uint16_t to_read = (actual < buf_len) ? actual : buf_len;
    uint16_t *dst = (uint16_t *)data_in;
    for (uint16_t i = 0; i < to_read / 2; i++) dst[i] = inw(ATA_DATA);

    return 0;
}
