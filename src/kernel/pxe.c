/*
 * pxe.c — PXE / network boot detection stub (item 17)
 *
 * PXE detection strategy:
 *   1. Check Multiboot2 command-line tag (type 1) for "--pxeboot" flag.
 *   2. Check BIOS Data Area for the PXENV+ and !PXE structures that a
 *      network ROM would have left behind (segment:offset scan at 0x9FC00
 *      and within 0xC0000–0xFFFFF option ROM space).
 *   3. If either is found, attempt to read the DHCP ACK cached at well-known
 *      real-mode segment (typically 0x0000:0x7C00 + offsets).
 *
 * In QEMU with BIOS the PXENV+ structure is present when booting from the
 * virtio-net NIC emulated PXE ROM.  The network card EFI driver exposes PXE
 * through EFI_PXE_BASE_CODE_PROTOCOL instead.
 *
 * This implementation provides stub/detection-only behaviour; actual
 * TFTP transfers are deferred to the JavaScript network stack (item 51).
 */

#include "pxe.h"
#include "platform.h"
#include <string.h>
#include <stddef.h>

/* MB2 tag type for command line */
#define MB2_TAG_CMDLINE 1u

/* PXENV+ signature and PXE (!PXE) signature */
static const char  PXENV_SIG[6] = "PXENV+";
static const char  BANG_PXE_SIG[4] = "!PXE";

static int            _is_netboot = 0;
static pxe_boot_info_t _info;

/* ── Checksum helper ────────────────────────────────────────────────────── */
static uint8_t _checksum(const uint8_t *p, uint32_t len) {
    uint8_t s = 0;
    for (uint32_t i = 0; i < len; i++) s += p[i];
    return s;
}

/* ── MB2 cmdline helper ─────────────────────────────────────────────────── */
static int _cmdline_has_pxe(uint32_t mb2_info_addr) {
    if (!mb2_info_addr) return 0;
    uint8_t  *p   = (uint8_t *)mb2_info_addr;
    uint32_t  tot = *(uint32_t *)p;
    uint8_t  *end = p + tot;
    p += 8;
    while (p < end) {
        uint32_t type = *(uint32_t *)p;
        uint32_t size = *(uint32_t *)(p + 4);
        if (type == 0) break;
        if (type == MB2_TAG_CMDLINE && size > 8) {
            const char *cmd = (const char *)(p + 8);
            if (strstr(cmd, "pxeboot") || strstr(cmd, "--netboot"))
                return 1;
        }
        p += (size + 7u) & ~7u;
    }
    return 0;
}

/* ── BIOS memory scan for PXENV+/!PXE ──────────────────────────────────── */
/* Scan a region of physical memory for the PXE signature on paragraph boundary */
static int _scan_pxe_sig(uint32_t base, uint32_t limit) {
    for (uint32_t addr = base; addr < limit; addr += 16) {
        const uint8_t *p = (const uint8_t *)addr;
        /* PXENV+ structure: signature "PXENV+" at offset 0, length at +8 */
        if (memcmp(p, PXENV_SIG, 6) == 0) {
            uint8_t length = p[8];
            if (length >= 26 && _checksum(p, length) == 0) {
                platform_serial_puts("[PXE] PXENV+ structure found\n");
                return 1;
            }
        }
        /* !PXE structure: signature at offset 0, length at +4 */
        if (memcmp(p, BANG_PXE_SIG, 4) == 0) {
            uint8_t length = p[4];
            if (length >= 0x58 && _checksum(p, length) == 0) {
                platform_serial_puts("[PXE] !PXE structure found\n");
                return 1;
            }
        }
    }
    return 0;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

void pxe_init(uint32_t mb2_info_addr) {
    memset(&_info, 0, sizeof(_info));
    _is_netboot = 0;

    /* Check 1: explicit cmdline flag */
    if (_cmdline_has_pxe(mb2_info_addr)) {
        _is_netboot = 1;
        platform_serial_puts("[PXE] Detected via cmdline flag\n");
    }

    /* Check 2: scan BIOS option ROM space (0xC0000 – 0xFFFFF) for PXENV+ */
    if (!_is_netboot) {
        if (_scan_pxe_sig(0xC0000, 0x100000)) {
            _is_netboot = 1;
        }
    }

    /* Check 3: scan BDA extension area just below 640 KB */
    if (!_is_netboot) {
        uint16_t ebda_seg = *(volatile uint16_t *)0x40E;
        if (ebda_seg) {
            uint32_t ebda = (uint32_t)ebda_seg << 4;
            if (_scan_pxe_sig(ebda, ebda + 1024)) {
                _is_netboot = 1;
            }
        }
    }

    if (_is_netboot) {
        /*
         * Populate stub lease info.
         * A real implementation would read the DHCP ACK from the !PXE structure
         * (at offset 0x30 in !PXE → CachedInfo pointer) which points to a PXENV_GET_CACHED_INFO buffer.
         * Stub: leave IPs zeroed; boot_file from cmdline if present.
         */
        _info.valid = 1;
        /* Try to read server name from cmdline (--tftp=IP:file format) */
        /* Stub: leave zeros */
        platform_serial_puts("[PXE] Network boot detected\n");
    } else {
        platform_serial_puts("[PXE] Local boot\n");
    }
}

int pxe_is_netboot(void) {
    return _is_netboot;
}

const pxe_boot_info_t *pxe_get_info(void) {
    return &_info;
}

int pxe_tftp_get(const char *filename, void *buf, uint32_t *len) {
    (void)filename; (void)buf; (void)len;
    /* Stub: actual TFTP via UDP is implemented in the TypeScript network stack */
    if (!_is_netboot) return -1;
    platform_serial_puts("[PXE] pxe_tftp_get() stub — use JS net.tftp() instead\n");
    return -1;
}
