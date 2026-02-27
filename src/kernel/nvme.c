/*
 * nvme.c — NVMe C register layer (item 82)
 *
 * All NVMe protocol logic (admin queue state machines, command building,
 * completion handling, namespace management) is in TypeScript.  This C
 * module provides only:
 *  - PCI enumeration and BAR0 MMIO setup
 *  - Raw 32/64-bit MMIO register read/write
 *  - Controller reset sequence (CC.EN handshake)
 *  - Doorbell ring helpers
 */

#include "nvme.h"
#include "pci.h"
#include "io.h"
#include "timer.h"
#include <stdint.h>
#include <string.h>

static volatile uint32_t *_nvme_bar0 = 0;
static uint32_t           _nvme_bar0_addr = 0;
static int                _nvme_found = 0;

/* ── MMIO helpers ───────────────────────────────────────────────────────── */

uint32_t nvme_read32(uint32_t reg) {
    if (!_nvme_bar0) return 0u;
    return _nvme_bar0[reg >> 2u];
}

void nvme_write32(uint32_t reg, uint32_t val) {
    if (!_nvme_bar0) return;
    _nvme_bar0[reg >> 2u] = val;
    (void)_nvme_bar0[reg >> 2u];    /* flush */
}

uint64_t nvme_read_cap(void) {
    if (!_nvme_bar0) return 0ull;
    uint32_t lo = _nvme_bar0[NVME_REG_CAP >> 2u];
    uint32_t hi = _nvme_bar0[(NVME_REG_CAP >> 2u) + 1u];
    return ((uint64_t)hi << 32u) | lo;
}

/* ── PCI enumeration and init ───────────────────────────────────────────── */

int nvme_init(void) {
    /* Enumerate PCI for an NVMe controller (class=01, sub=08, prog=02) */
    pci_device_t dev;
    int found = 0;
    /* Scan all buses/devices/functions for NVMe class code */
    for (uint8_t bus = 0u; bus < 255u && !found; bus++) {
        for (uint8_t d = 0u; d < 32u && !found; d++) {
            for (uint8_t fn = 0u; fn < 8u; fn++) {
                uint32_t id = pci_config_read(bus, d, fn, 0u);
                if ((id & 0xFFFFu) == 0xFFFFu) { if (!fn) break; continue; }
                uint32_t class = pci_config_read(bus, d, fn, 0x08u);
                /* class byte=31:24, sub=23:16, prog=15:8 */
                if ((class >> 8u) == 0x010802u) {
                    dev.bus = bus; dev.dev = d; dev.fn = fn;
                    dev.vendor = id & 0xFFFFu;
                    dev.device = id >> 16u;
                    /* Read BAR0 (32-bit; for 64-bit we would also read BAR1) */
                    uint32_t bar0 = pci_config_read(bus, d, fn, 0x10u);
                    /* BAR0 for NVMe is always MMIO */
                    _nvme_bar0_addr = bar0 & 0xFFFFFFF0u;
                    _nvme_bar0 = (volatile uint32_t *)_nvme_bar0_addr;
                    /* Check BAR[2:1]=00 → 32-bit; or =10 → 64-bit */
                    if ((bar0 & 0x6u) == 0x4u) {
                        /* 64-bit BAR: combine with BAR1 */
                        uint32_t bar1 = pci_config_read(bus, d, fn, 0x14u);
                        (void)bar1; /* upper 32 bits; use only lower 32 on 32-bit OS */
                    }
                    pci_enable_busmaster(&dev);
                    _nvme_found = 1;
                    found = 1;
                    break;
                }
                /* Check for multi-function via header type bit 7 */
                uint32_t hdr = pci_config_read(bus, d, fn, 0x0Cu);
                if (!(hdr & 0x800000u) && fn == 0u) break;
            }
        }
    }
    return _nvme_found ? 0 : -1;
}

int nvme_present(void) {
    return _nvme_found;
}

uint32_t nvme_bar0(void) {
    return _nvme_bar0_addr;
}

/* ── Controller reset and enable (item 82) ──────────────────────────────── */

#define NVME_TIMEOUT_MS  5000u   /* 5 second controller enable timeout */

int nvme_controller_reset(void) {
    /* Step 1: Disable controller (CC.EN = 0) */
    uint32_t cc = nvme_read32(NVME_REG_CC);
    cc &= ~NVME_CC_EN;
    nvme_write32(NVME_REG_CC, cc);

    /* Step 2: Wait for CSTS.RDY = 0 (controller quiesced) */
    uint32_t ms = 0u;
    while (ms < NVME_TIMEOUT_MS) {
        if (!(nvme_read32(NVME_REG_CSTS) & NVME_CSTS_RDY)) break;
        timer_sleep_ms(1u);
        ms++;
    }
    if (ms >= NVME_TIMEOUT_MS) return -1;
    return 0;
}

int nvme_enable(void) {
    /* Configure and enable: CSS=NVM, MPS=4KB, IOSQES=64B, IOCQES=16B */
    uint32_t cc = NVME_CC_EN | NVME_CC_CSS_NVM | NVME_CC_MPS_4K
                | NVME_CC_AMS_RR | NVME_CC_IOSQES_64 | NVME_CC_IOCQES_16;
    nvme_write32(NVME_REG_CC, cc);

    /* Wait for CSTS.RDY = 1 */
    uint32_t ms = 0u;
    while (ms < NVME_TIMEOUT_MS) {
        uint32_t csts = nvme_read32(NVME_REG_CSTS);
        if (csts & NVME_CSTS_CFS) return -1;   /* fatal error */
        if (csts & NVME_CSTS_RDY) break;
        timer_sleep_ms(1u);
        ms++;
    }
    return (ms < NVME_TIMEOUT_MS) ? 0 : -1;
}

/* ── Doorbell helpers ───────────────────────────────────────────────────── */

uint32_t nvme_doorbell_stride(void) {
    /* CAP.DSTRD [35:32]: stride = 4 << DSTRD bytes */
    uint64_t cap = nvme_read_cap();
    uint32_t dstrd = (uint32_t)((cap >> 32u) & 0xFu);
    return 4u << dstrd;
}

void nvme_ring_admin_sq(uint16_t tail) {
    /* Admin SQ doorbell is at BAR0 + 0x1000 */
    uint32_t db_off = 0x1000u;
    nvme_write32(db_off, tail);
}

void nvme_ring_admin_cq(uint16_t head) {
    /* Admin CQ doorbell = SQ doorbell offset + stride */
    uint32_t stride = nvme_doorbell_stride();
    uint32_t db_off = 0x1000u + stride;
    nvme_write32(db_off, head);
}
