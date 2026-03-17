/*
 * secboot.h — UEFI Secure Boot detection stub (item 13)
 *
 * On BIOS-booted systems (QEMU default) this always returns 0.
 * On UEFI-booted systems the Multiboot2 EFI system-table pointer tags (11/12)
 * expose the firmware's Secure Boot variable.
 */
#ifndef SECBOOT_H
#define SECBOOT_H

#include <stdint.h>

/* Secure Boot state returned by secboot_check() */
typedef enum {
    SECBOOT_UNAVAILABLE = 0,  /* No EFI / Secure Boot not supported */
    SECBOOT_DISABLED    = 1,  /* EFI present but Secure Boot disabled */
    SECBOOT_ENABLED     = 2,  /* EFI present AND Secure Boot enabled */
} secboot_state_t;

/*
 * Initialise Secure Boot detection from the Multiboot2 info block.
 * Must be called after the MB2 info pointer is available.
 * Call once from kernel_main() before starting QuickJS.
 *
 * @param mb2_info_addr  Physical address of the MB2 information structure
 *                       (0 when booting without Multiboot2).
 */
void secboot_init(uint32_t mb2_info_addr);

/*
 * Return the current Secure Boot state (result of last secboot_init()).
 */
secboot_state_t secboot_check(void);

/*
 * Return non-zero if the kernel was loaded with UEFI (EFI system table found
 * in the MB2 tags), zero on legacy BIOS boot.
 */
int secboot_is_uefi(void);

#endif /* SECBOOT_H */
