/*
 * JSOS ACPI Subsystem  (items 11, 105, 106)
 *
 * Detects the RSDP, walks the RSDT/XSDT to find the FADT, extracts the
 * PM1 control register addresses + SLP_TYP values for S5 shutdown, and
 * provides acpi_shutdown() / acpi_reboot().
 *
 * C code — hardware access only; no OS policy.
 */

#include "acpi.h"
#include "io.h"
#include "platform.h"
#include <string.h>
#include <stddef.h>

acpi_info_t acpi_info;

/* ── Checksum helper ─────────────────────────────────────────────────────── */
static uint8_t _checksum(const void *ptr, size_t len) {
    const uint8_t *b = (const uint8_t *)ptr;
    uint8_t sum = 0;
    for (size_t i = 0; i < len; i++) sum += b[i];
    return sum;
}

/* ── RSDP search ─────────────────────────────────────────────────────────── */

static acpi_rsdp_v1_t *_try_rsdp(uint32_t addr) {
    acpi_rsdp_v1_t *r = (acpi_rsdp_v1_t *)addr;
    if (memcmp(r->signature, "RSD PTR ", 8) != 0) return NULL;
    if (_checksum(r, sizeof(acpi_rsdp_v1_t)) != 0) return NULL;
    return r;
}

static acpi_rsdp_v1_t *_scan_range(uint32_t start, uint32_t end) {
    /* Signature is aligned to 16-byte boundary */
    for (uint32_t a = start; a < end; a += 16) {
        acpi_rsdp_v1_t *r = _try_rsdp(a);
        if (r) return r;
    }
    return NULL;
}

/* ── Multiboot2 RSDP tag fast path ──────────────────────────────────────── */
#define MB2_TAG_RSDP_V1  14u
#define MB2_TAG_RSDP_V2  15u

static acpi_rsdp_v1_t *_find_rsdp_mb2(uint32_t mb2_addr) {
    if (!mb2_addr) return NULL;
    uint8_t *p   = (uint8_t *)mb2_addr;
    uint32_t tot = *(uint32_t *)p;
    uint8_t *end = p + tot;
    p += 8;
    while (p < end) {
        uint32_t type = *(uint32_t *)p;
        uint32_t size = *(uint32_t *)(p + 4);
        if (type == 0) break;
        if (type == MB2_TAG_RSDP_V1 || type == MB2_TAG_RSDP_V2) {
            return _try_rsdp((uint32_t)(p + 8));
        }
        p += (size + 7u) & ~7u;
    }
    return NULL;
}

/* ── SDT entry walk ──────────────────────────────────────────────────────── */
static void _parse_fadt(uint32_t fadt_addr) {
    if (!fadt_addr) return;
    acpi_fadt_t *f = (acpi_fadt_t *)fadt_addr;
    acpi_info.fadt_address  = fadt_addr;
    acpi_info.pm1a_cnt_blk  = f->pm1a_cnt_blk;
    acpi_info.pm1b_cnt_blk  = f->pm1b_cnt_blk;

    /* PM_TMR_BLK is at byte offset 76 in the FADT (ACPI spec §5.2.9).
     * We read it directly from the raw FADT bytes to avoid struct-layout
     * dependency (our acpi_fadt_t is a minimal excerpt).                  */
    const uint8_t *raw = (const uint8_t *)fadt_addr;
    acpi_info.pm_tmr_blk = *(const uint32_t *)(raw + 76u);

    /* Byte 112 (FADT_LENGTH >= 244 for ACPI 2+) has flags; bit 8 = TMR_VAL_EXT
     * (32-bit timer).  Default to 24-bit if table is too short.           */
    uint32_t fadt_len = ((acpi_sdt_hdr_t *)fadt_addr)->length;
    if (fadt_len > 112u) {
        uint32_t flags = *(const uint32_t *)(raw + 112u);
        acpi_info.pm_tmr_32 = (uint8_t)((flags >> 8u) & 1u);
    } else {
        acpi_info.pm_tmr_32 = 0u;   /* assume 24-bit */
    }
}

/* Walk RSDT (32-bit physical addresses after the header) */
static void _walk_rsdt(uint32_t rsdt_addr) {
    if (!rsdt_addr) return;
    acpi_sdt_hdr_t *h = (acpi_sdt_hdr_t *)rsdt_addr;
    if (h->length < sizeof(acpi_sdt_hdr_t)) return;
    int entries = (int)((h->length - sizeof(acpi_sdt_hdr_t)) / 4);
    uint32_t *ptrs = (uint32_t *)((uint8_t *)h + sizeof(acpi_sdt_hdr_t));
    for (int i = 0; i < entries; i++) {
        acpi_sdt_hdr_t *entry = (acpi_sdt_hdr_t *)ptrs[i];
        if (!entry) continue;
        if (memcmp(entry->signature, "FACP", 4) == 0)
            _parse_fadt(ptrs[i]);
    }
}

/* ── S5 sleep type parse from DSDT ──────────────────────────────────────── */
/* Simplified: scan DSDT for AML pattern \_S5_ package containing SLP_TYP.
 * Full AML parsing is complex; we look for the 4-byte signature and read
 * the two Byte-prefixed values that follow the package opcode.              */
static void _parse_s5(uint32_t dsdt_addr) {
    if (!dsdt_addr) return;
    acpi_sdt_hdr_t *h = (acpi_sdt_hdr_t *)dsdt_addr;
    uint8_t *aml  = (uint8_t *)h + sizeof(acpi_sdt_hdr_t);
    uint8_t *aend = (uint8_t *)h + h->length - 6;
    for (uint8_t *p = aml; p < aend; p++) {
        /* "_S5_" signature in AML: 5F 53 35 5F */
        if (p[0]=='_' && p[1]=='S' && p[2]=='5' && p[3]=='_') {
            /* Expect: PkgOp(0x12) PackageSize, NumElements, BytePrefix, SLP_TYPa,
             *         BytePrefix, SLP_TYPb  */
            uint8_t *q = p + 4;
            if (q[0] == 0x08 || (q[0] == 0x10)) q++;  /* skip possible NameOp */
            if (q[0] != 0x12) continue;  /* PackageOp */
            q++;                          /* skip PackageOp */
            q++;                          /* skip PackageSize (simplified: 1 byte) */
            q++;                          /* skip NumElements */
            if (q[0] == 0x0A) { q++; acpi_info.slp_typa = (uint16_t)q[0] << 10; q++; }
            if (q[0] == 0x0A) { q++; acpi_info.slp_typb = (uint16_t)q[0] << 10; q++; }
            acpi_info.slp_valid = 1;
            return;
        }
    }
}

/* ── Public API ─────────────────────────────────────────────────────────── */

void acpi_init(uint32_t mb2_info_addr) {
    memset(&acpi_info, 0, sizeof(acpi_info));

    /* 1. Try Multiboot2 RSDP tag first */
    acpi_rsdp_v1_t *rsdp = _find_rsdp_mb2(mb2_info_addr);

    /* 2. Fall back to memory scan */
    if (!rsdp) {
        /* EBDA base is at 0x40E (segment, << 4 = physical address) */
        uint32_t ebda = (uint32_t)(*(uint16_t *)0x40Eu) << 4;
        if (ebda >= 0x80000u && ebda < 0xA0000u)
            rsdp = _scan_range(ebda, ebda + 0x400u);
    }
    if (!rsdp)
        rsdp = _scan_range(0xE0000u, 0x100000u);

    if (!rsdp) {
        platform_serial_puts("[ACPI] RSDP not found\n");
        return;
    }

    acpi_info.rsdp_address  = (uint32_t)rsdp;
    acpi_info.acpi_version  = (uint8_t)(rsdp->revision >= 2 ? 2 : 1);
    acpi_info.rsdt_address  = rsdp->rsdt_address;

    if (rsdp->revision >= 2) {
        acpi_rsdp_v2_t *r2 = (acpi_rsdp_v2_t *)rsdp;
        if (_checksum(r2, r2->length) == 0)
            acpi_info.xsdt_address = r2->xsdt_address;
    }

    platform_serial_puts("[ACPI] RSDP found, ACPI v");
    platform_serial_puts(acpi_info.acpi_version == 2 ? "2\n" : "1\n");

    _walk_rsdt(acpi_info.rsdt_address);

    /* Parse DSDT for S5 */
    if (acpi_info.fadt_address) {
        acpi_fadt_t *f = (acpi_fadt_t *)acpi_info.fadt_address;
        _parse_s5(f->dsdt);
    }
}

void acpi_shutdown(void) {
    /* Attempt ACPI S5 soft-off */
    if (acpi_info.slp_valid && acpi_info.pm1a_cnt_blk) {
        /* SLP_EN bit (bit 13) | SLP_TYPa (bits 12:10) */
        uint16_t val_a = (uint16_t)(acpi_info.slp_typa | (1u << 13));
        outw((uint16_t)acpi_info.pm1a_cnt_blk, val_a);
        if (acpi_info.pm1b_cnt_blk) {
            uint16_t val_b = (uint16_t)(acpi_info.slp_typb | (1u << 13));
            outw((uint16_t)acpi_info.pm1b_cnt_blk, val_b);
        }
    }
    /* Fallback: triple fault */
    __asm__ volatile("cli");
    /* Load a zero-length IDT, then trigger an interrupt → triple fault = reset */
    struct { uint16_t lim; uint32_t base; } __attribute__((packed)) null_idt = {0, 0};
    __asm__ volatile("lidt (%0); int $0" :: "r"(&null_idt));
    for (;;) __asm__ volatile("hlt");
}

void acpi_reboot(void) {
    /* Method 1: ACPI reset register (FADT v2 reset_reg, type 1 = I/O port 0xCF9) */
    outb(0xCF9, 0x06);      /* 0xCF9 = PCI reset; 0x06 = full reset  */
    io_wait();
    /* Method 2: Keyboard controller fast reset */
    outb(0x64, 0xFE);       /* PS/2 CMD: pulse reset line            */
    io_wait();
    /* Method 3: Triple-fault */
    struct { uint16_t lim; uint32_t base; } __attribute__((packed)) null_idt = {0, 0};
    __asm__ volatile("cli; lidt (%0); int $0" :: "r"(&null_idt));
    for (;;) __asm__ volatile("hlt");
}

/* ── ACPI PM timer (item 52) ─────────────────────────────────────────────── */

uint32_t acpi_pm_timer_blk(void) {
    return acpi_info.pm_tmr_blk;
}

uint32_t acpi_pm_timer_read(void) {
    uint32_t port = acpi_info.pm_tmr_blk;
    if (!port) return 0u;
    /* PM timer is accessed via a 32-bit I/O read; 24-bit mode ignores the top byte */
    uint32_t val;
    __asm__ volatile("inl %1, %0" : "=a"(val) : "Nd"((uint16_t)port));
    if (!acpi_info.pm_tmr_32) val &= 0x00FFFFFFu;   /* 24-bit mask */
    return val;
}

