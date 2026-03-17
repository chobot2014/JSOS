/*
 * usb_msc.h — USB Mass Storage Class (BOT) driver stub (item 85)
 *
 * Provides block device access to USB thumb drives and external USB HDDs
 * via the Bulk-Only Transport (BOT) protocol over the USB host stack.
 */
#ifndef USB_MSC_H
#define USB_MSC_H

#include <stdint.h>

typedef struct {
    uint8_t  lun;            /* Logical Unit Number (0-based) */
    uint32_t block_count;    /* Total 512-byte sectors */
    uint16_t block_size;     /* Block size in bytes (usually 512) */
    char     vendor[9];      /* INQUIRY vendor string (null-terminated) */
    char     product[17];    /* INQUIRY product string */
} usb_msc_info_t;

/* usb_msc_init() — enumerate USB bulk devices; returns count found (0=none). */
int usb_msc_init(void);

/* usb_msc_present(index) — 1 if USB mass storage device <index> is ready. */
int usb_msc_present(uint8_t index);

/* usb_msc_get_info(index, info) — fill info struct. Returns 0 OK or -1. */
int usb_msc_get_info(uint8_t index, usb_msc_info_t *info);

/* usb_msc_read(index, lba, count, buf) — read sectors via SCSI READ(10).
 * Returns 0 OK, < 0 on error. */
int usb_msc_read(uint8_t index, uint32_t lba, uint16_t count, void *buf);

/* usb_msc_write(index, lba, count, buf) — write sectors via SCSI WRITE(10). */
int usb_msc_write(uint8_t index, uint32_t lba, uint16_t count, const void *buf);

/* usb_msc_sector_count(index) — total sectors; 0 if not present. */
uint32_t usb_msc_sector_count(uint8_t index);

#endif /* USB_MSC_H */
