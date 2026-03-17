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

/* ── IRQ-driven mode (item 78) ───────────────────────────────────────────── */
/**
 * Enable IRQ-driven transfers on the primary ATA bus (IRQ 14).
 * Must be called after ata_initialize() and after IRQ subsystem is up.
 * Subsequent ata_read28_irq() / ata_write28_irq() will block via IRQ semaphore
 * instead of busy-polling status.
 */
void ata_enable_irq(void);

/* IRQ-driven read/write — same semantics as PIO variants but yield on IRQ.  */
int  ata_read28_irq (uint32_t lba, uint8_t count, uint16_t *buf);
int  ata_write28_irq(uint32_t lba, uint8_t count, const uint16_t *buf);

/* ── Bus Master DMA (item 79) ────────────────────────────────────────────── */
/**
 * Detect and initialise Bus Master IDE DMA for the primary ATA channel.
 * Requires pci_find_device(class=0x01, subclass=0x01) to have been called.
 * Returns 0 if BMI was found and initialised, -1 otherwise.
 */
int  ata_dma_init(uint16_t bmi_base);   /* bmi_base = PCI BAR4 I/O address  */

/**
 * DMA read `count` sectors (max 255) to a physical buffer.
 * `buf_phys` must be 4-byte aligned and < 64 KB in size.
 * Returns 0 on success, -1 on error.
 */
int  ata_dma_read28 (uint32_t lba, uint8_t count,
                     uint32_t buf_phys, uint32_t buf_bytes);

/* ── ATAPI packet command interface (item 80) ───────────────────────────── *
 *
 * ATAPI (ATA Packet Interface) sends 12-byte command packets using the
 * PACKET command (0xA0) on the ATA bus.  Common uses: CD-ROM read (READ(10)),
 * disc eject (START/STOP UNIT), media capacity (READ CAPACITY).
 *
 * TypeScript implements the ATAPI command layer (packet construction and
 * sense-data parsing).  C exposes the raw packet→data transfer primitive.
 *
 * Returns 0 on success, -1 on error/timeout or no ATAPI device.
 */

/**
 * Detect whether the primary master is an ATAPI device (CD-ROM, DVD, etc.).
 * Returns 1 if ATAPI, 0 if ATA, -1 if nothing present.
 */
int ata_is_atapi(void);

/**
 * Send a 12-byte ATAPI command packet to the primary master ATAPI device.
 * If `data_in` is non-NULL, read up to `buf_len` bytes of PIO data response.
 * If `data_in` is NULL, this is a non-data command.
 * Returns 0 on success, -1 on DRQ timeout or error.
 */
int ata_atapi_send_packet(const uint8_t *packet12,
                          void *data_in, uint16_t buf_len);

#endif /* ATA_H */
