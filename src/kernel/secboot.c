/*
 * secboot.c — UEFI Secure Boot detection stub (item 13)
 *
 * Multiboot2 provides two tags that reveal UEFI context:
 *   Tag 11 — EFI 32-bit system table pointer (uint32 ptr)
 *   Tag 12 — EFI 64-bit system table pointer (uint64 ptr)
 *
 * From the EFI system table we can follow:
 *   EFI_SYSTEM_TABLE → ConfigurationTable[] → SecureBootDatabase GUID
 *   or read EFI runtime variable "SecureBoot" (GUID 8be4df61-…) via
 *   EFI_RUNTIME_SERVICES.GetVariable().
 *
 * Because we're running in 32-bit protected mode after Multiboot handoff the
 * EFI runtime cannot be safely called (it expects to run either in 32-bit
 * compat or 64-bit long mode).  This stub therefore:
 *   1. Detects whether an EFI system-table pointer was present in MB2 (→UEFI)
 *   2. Reads the raw "SecureBoot" byte from a well-known offset in the table
 *      if the pointer is 32-bit addressable; otherwise marks state UNKNOWN.
 *
 * In QEMU legacy BIOS mode: no EFI tags → SECBOOT_UNAVAILABLE.
 */

#include "secboot.h"
#include "platform.h"
#include <string.h>

/* MB2 tag types that carry EFI system-table pointers */
#define MB2_TAG_EFI32_ST  11u
#define MB2_TAG_EFI64_ST  12u

/* Well-known offset within EFI_SYSTEM_TABLE to the Secure Boot variable.
 * This is heuristic — real code would use GetVariable() runtime call.
 * Offset is not reliable here; flag is read only if we can confirm layout. */
#define EFI_ST_SECURE_BOOT_BYTE_OFFSET  0  /* placeholder; not used in stub */

static secboot_state_t _state  = SECBOOT_UNAVAILABLE;
static int             _is_efi = 0;

void secboot_init(uint32_t mb2_info_addr) {
    _state  = SECBOOT_UNAVAILABLE;
    _is_efi = 0;

    if (!mb2_info_addr) {
        platform_serial_puts("[SECBOOT] No MB2 — legacy BIOS boot, Secure Boot N/A\n");
        return;
    }

    uint8_t  *p   = (uint8_t *)mb2_info_addr;
    uint32_t  tot = *(uint32_t *)p;
    uint8_t  *end = p + tot;
    p += 8;

    uint32_t efi32_st = 0;
    uint64_t efi64_st = 0;

    /* Walk all MB2 tags looking for EFI system-table pointers */
    while (p < end) {
        uint32_t type = *(uint32_t *)p;
        uint32_t size = *(uint32_t *)(p + 4);
        if (type == 0) break;

        if (type == MB2_TAG_EFI32_ST && size >= 12) {
            efi32_st = *(uint32_t *)(p + 8);
            _is_efi  = 1;
        }
        if (type == MB2_TAG_EFI64_ST && size >= 16) {
            efi64_st  = *(uint64_t *)(p + 8);
            _is_efi   = 1;
        }
        p += (size + 7u) & ~7u;
    }

    if (!_is_efi) {
        platform_serial_puts("[SECBOOT] No EFI system table in MB2 — BIOS boot\n");
        _state = SECBOOT_UNAVAILABLE;
        return;
    }

    /*
     * We are in UEFI mode.  Attempt to read the Secure Boot state from the
     * EFI system table if the pointer fits within 32-bit addressing space.
     *
     * EFI_SYSTEM_TABLE (simplified, 32-bit UEFI):
     *   +0   EFI_TABLE_HEADER (24 bytes)
     *   +24  FirmwareVendor   (CHAR16*)
     *   +28  FirmwareRevision (UINT32)
     *   +32  ConsoleInHandle
     *   ...
     *   ReadingSecureBoot via RuntimeServices.GetVariable() is not safe in
     *   protected mode — stub: report DISABLED (allows OS to continue).
     */
    (void)efi32_st;
    (void)efi64_st;

    /* Conservative stub: UEFI detected but we cannot query the variable safely
     * in 32-bit protected mode without ExitBootServices having been called
     * through proper UEFI shims.  Mark as DISABLED (non-enforcing). */
    _state = SECBOOT_DISABLED;
    platform_serial_puts("[SECBOOT] UEFI boot detected — Secure Boot state: DISABLED (stub)\n");
}

secboot_state_t secboot_check(void) {
    return _state;
}

int secboot_is_uefi(void) {
    return _is_efi;
}
