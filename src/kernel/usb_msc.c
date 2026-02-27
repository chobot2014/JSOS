/*
 * usb_msc.c — USB Mass Storage Class driver stub (item 85)
 */
#include "usb_msc.h"
#include "platform.h"

int usb_msc_init(void) {
    platform_boot_print("[USB-MSC] Stub: bulk-only transport not implemented\n");
    return 0;
}
int usb_msc_present(uint8_t index)                           { (void)index; return 0; }
uint32_t usb_msc_sector_count(uint8_t index)                 { (void)index; return 0; }
int usb_msc_get_info(uint8_t index, usb_msc_info_t *info)   { (void)index; (void)info; return -1; }
int usb_msc_read(uint8_t i, uint32_t lba, uint16_t n, void *b)      { (void)i;(void)lba;(void)n;(void)b; return -1; }
int usb_msc_write(uint8_t i, uint32_t lba, uint16_t n, const void *b){ (void)i;(void)lba;(void)n;(void)b; return -1; }
