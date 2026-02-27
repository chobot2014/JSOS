/*
 * JSOS ACPI RSDP Detection  (item 11)
 *
 * Scans the two standard RSDP search areas as defined by the ACPI 6.5 spec:
 *   1. Extended BIOS Data Area (EBDA): search first 1 KiB on 16-byte boundary.
 *   2. BIOS ROM area 0xE0000–0xFFFFF: search on 16-byte boundaries.
 *
 * Also supports the Multiboot2 RSDP tag (types 14 and 15) as a fast path.
 *
 * C code — direct physical memory access, no OS logic.
 */

#ifndef ACPI_H
#define ACPI_H

#include <stdint.h>

/* ACPI Root System Description Pointer (RSDP) versions */
#define ACPI_RSDP_SIG  "RSD PTR "  /* 8-byte signature */

/* RSDP v1 structure (ACPI 1.0) */
typedef struct {
    char     signature[8];
    uint8_t  checksum;
    char     oem_id[6];
    uint8_t  revision;      /* 0 = ACPI 1.0, 2 = ACPI 2.0+ */
    uint32_t rsdt_address;  /* 32-bit physical address of RSDT */
} __attribute__((packed)) acpi_rsdp_v1_t;

/* RSDP v2 extension (ACPI 2.0+) follows immediately after v1 */
typedef struct {
    acpi_rsdp_v1_t v1;
    uint32_t length;
    uint64_t xsdt_address;  /* 64-bit physical address of XSDT */
    uint8_t  ext_checksum;
    uint8_t  reserved[3];
} __attribute__((packed)) acpi_rsdp_v2_t;

/* ACPI Generic Address Structure (GAS) */
typedef struct {
    uint8_t  space_id;      /* 0=system memory, 1=system I/O */
    uint8_t  bit_width;
    uint8_t  bit_offset;
    uint8_t  access_size;
    uint64_t address;
} __attribute__((packed)) acpi_gas_t;

/* ACPI table header shared by all SDTs */
typedef struct {
    char     signature[4];
    uint32_t length;
    uint8_t  revision;
    uint8_t  checksum;
    char     oem_id[6];
    char     oem_table_id[8];
    uint32_t oem_revision;
    uint32_t creator_id;
    uint32_t creator_revision;
} __attribute__((packed)) acpi_sdt_hdr_t;

/* FADT fields needed for PM1a/PM1b shutdown */
typedef struct {
    acpi_sdt_hdr_t hdr;
    uint32_t firmware_ctrl;
    uint32_t dsdt;
    uint8_t  reserved[4];    /* int_model + skipped fields */
    uint8_t  preferred_pm_profile;
    uint16_t sci_int;
    uint32_t smi_cmd;
    uint8_t  acpi_enable;
    uint8_t  acpi_disable;
    uint8_t  s4bios_req;
    uint8_t  pstate_cnt;
    uint32_t pm1a_evt_blk;
    uint32_t pm1b_evt_blk;
    uint32_t pm1a_cnt_blk;   /* PM1a control block port */
    uint32_t pm1b_cnt_blk;   /* PM1b control block port (0 if not present) */
    /* ... many more fields follow ... */
} __attribute__((packed)) acpi_fadt_t;

/** ACPI state populated by acpi_init(). */
typedef struct {
    uint32_t rsdp_address;     /* physical address of RSDP (0 = not found) */
    uint8_t  acpi_version;     /* 1 or 2                                   */
    uint32_t rsdt_address;     /* RSDT physical address                    */
    uint64_t xsdt_address;     /* XSDT physical address (v2 only)          */
    uint32_t fadt_address;     /* FADT physical address (0 = not found)    */
    uint32_t pm1a_cnt_blk;     /* PM1a control block I/O port              */
    uint32_t pm1b_cnt_blk;     /* PM1b control block I/O port (may be 0)  */
    uint16_t slp_typa;         /* SLP_TYP value for S5 in PM1a             */
    uint16_t slp_typb;         /* SLP_TYP value for S5 in PM1b             */
    int      slp_valid;        /* 1 if S5 shutdown values were found       */
    uint32_t pm_tmr_blk;       /* PM timer I/O port (0 if absent, item 52) */
    uint8_t  pm_tmr_32;        /* 1 = 32-bit timer; 0 = 24-bit timer       */
} acpi_info_t;

extern acpi_info_t acpi_info;

/**
 * Scan for the RSDP and parse essential ACPI tables.
 * Must be called after the physical memory identity mapping is available
 * (i.e. in kernel main(), early on).
 * @param mb2_info_addr  Multiboot2 boot info pointer (used as fast path;
 *                       pass 0 if not available).
 */
void acpi_init(uint32_t mb2_info_addr);

/**
 * Perform a clean ACPI S5 (soft-off) shutdown.
 * Writes to the PM1 control registers; does not return on success.
 * Falls back to a triple-fault CPU reset if ACPI is unavailable.
 */
void acpi_shutdown(void) __attribute__((noreturn));

/**
 * Perform a system reset via ACPI reset register or keyboard controller.
 * Does not return.
 */
void acpi_reboot(void) __attribute__((noreturn));

/**
 * Read the ACPI PM timer counter (item 52).
 * Returns the raw 24- or 32-bit counter value; 0 if PM timer is unavailable.
 * Frequency = 3,579,545 Hz (ACPI spec §4.8.3).
 */
uint32_t acpi_pm_timer_read(void);

/**
 * Return the PM timer I/O base port; 0 if unavailable.
 */
uint32_t acpi_pm_timer_blk(void);

#endif /* ACPI_H */
