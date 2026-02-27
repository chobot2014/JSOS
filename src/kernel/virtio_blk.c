/*
 * virtio_blk.c  —  Legacy PCI VirtIO block device driver (item 81)
 *
 * Follows the same legacy virtio pattern as virtio_net.c.
 * Queue size: 64 descriptors.
 * Single transfer in-flight at a time (no async pipelining — TypeScript
 * scheduler handles concurrency above this layer).
 */

#include "virtio_blk.h"
#include "pci.h"
#include "io.h"
#include "platform.h"
#include "memory.h"
#include <stdint.h>
#include <string.h>

/* ── Virtqueue geometry ──────────────────────────────────────────────────── */
#define VBLK_QUEUE_SIZE_DEF  64u
#define VBLK_PAGE_SIZE       4096u

/* Virtqueue descriptor flags */
#define VRING_F_NEXT         0x01u
#define VRING_F_WRITE        0x02u   /* device writes (data-in) */

/* ── Virtqueue entry structs ─────────────────────────────────────────────── */
typedef struct __attribute__((packed)) {
    uint64_t addr;
    uint32_t len;
    uint16_t flags;
    uint16_t next;
} vring_desc_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    uint16_t ring[VBLK_QUEUE_SIZE_DEF];
    uint16_t used_event;
} vring_avail_t;

typedef struct __attribute__((packed)) {
    uint32_t id;
    uint32_t len;
} vring_used_elem_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    vring_used_elem_t ring[VBLK_QUEUE_SIZE_DEF];
    uint16_t avail_event;
} vring_used_t;

/* ── Queue layout (single 3-page allocation) ──────────────────────────────
 *  Page 0: descriptor table  (64 × 16 = 1024 bytes)
 *  Page 0 cont: avail ring   (4 + 64×2 = 132 bytes; total so far 1156 bytes)
 *  Pad to page 1 boundary (4096): 2940 bytes padding
 *  Page 1+: used ring        (4 + 64×8 = 516 bytes)
 * ─────────────────────────────────────────────────────────────────────────── */
#define SZ_DESC       (VBLK_QUEUE_SIZE_DEF * sizeof(vring_desc_t))  /* 1024 */
#define SZ_AVAIL      (4u + VBLK_QUEUE_SIZE_DEF * 2u)               /*  132 */
#define AVAIL_OFFSET  SZ_DESC
#define USED_OFFSET   VBLK_PAGE_SIZE    /* used ring starts at second page   */
#define RING_TOTAL    (2u * VBLK_PAGE_SIZE)

/* Aligned ring buffer — use BSS for predictable physical address            */
static uint8_t _ring_mem[RING_TOTAL] __attribute__((aligned(VBLK_PAGE_SIZE)));

#define _desc  ((vring_desc_t *)  _ring_mem)
#define _avail ((vring_avail_t *)(_ring_mem + AVAIL_OFFSET))
#define _used  ((vring_used_t *) (_ring_mem + USED_OFFSET))

/* Device state */
static uint16_t _vblk_iobase    = 0;
static int      _vblk_present   = 0;
static uint64_t _vblk_sectors   = 0;
static uint16_t _avail_idx      = 0;  /* next slot in avail ring             */
static uint16_t _used_idx_last  = 0;  /* last used.idx we've seen            */

/* Header + status buffers for transfer (one in-flight at a time) */
static virtio_blk_req_hdr_t _req_hdr;
static uint8_t              _req_status;

int virtio_blk_init(void) {
    /* Find PCI vendor=0x1AF4 device=0x1001 (legacy virtio-blk) */
    pci_device_t dev;
    if (pci_find_device(0x1AF4, 0x1001, &dev) != 0) {
        platform_serial_puts("[VBLK] No virtio-blk device found\n");
        return -1;
    }

    uint16_t iobase = (uint16_t)(dev.bar[0] & ~0x3u);
    if (!iobase) return -1;
    _vblk_iobase = iobase;

    /* PCI bus master enable */
    pci_enable_busmaster(&dev);

    /* Virtio negotiation sequence */
    outb((uint16_t)(iobase + VBLK_DEVICE_STATUS), 0x00u);  /* reset */
    outb((uint16_t)(iobase + VBLK_DEVICE_STATUS), VBLK_STAT_ACKNOWLEDGE);
    outb((uint16_t)(iobase + VBLK_DEVICE_STATUS),
         (uint8_t)(VBLK_STAT_ACKNOWLEDGE | VBLK_STAT_DRIVER));

    /* Read host features, accept all */
    outl((uint16_t)(iobase + VBLK_GUEST_FEATURES),
         inl((uint16_t)(iobase + VBLK_HOST_FEATURES)));

    /* Read sector count from device config */
    uint32_t cap_lo = inl((uint16_t)(iobase + VBLK_CFG_CAPACITY_LO));
    uint32_t cap_hi = inl((uint16_t)(iobase + VBLK_CFG_CAPACITY_HI));
    _vblk_sectors = ((uint64_t)cap_hi << 32) | cap_lo;

    /* Set up queue 0 */
    outw((uint16_t)(iobase + VBLK_QUEUE_SEL), 0);
    uint16_t qsz = inw((uint16_t)(iobase + VBLK_QUEUE_SIZE));
    if (qsz == 0) { return -1; }
    /* Cap at our maximum and use 0 = use device's size */
    (void)qsz;

    /* Zero ring memory and register with device */
    memset(_ring_mem, 0, RING_TOTAL);
    outl((uint16_t)(iobase + VBLK_QUEUE_PFN),
         (uint32_t)_ring_mem / VBLK_PAGE_SIZE);

    /* Signal driver ready */
    outb((uint16_t)(iobase + VBLK_DEVICE_STATUS),
         (uint8_t)(VBLK_STAT_ACKNOWLEDGE | VBLK_STAT_DRIVER | VBLK_STAT_DRIVER_OK));

    _vblk_present  = 1;
    _avail_idx     = 0;
    _used_idx_last = 0;
    platform_serial_puts("[VBLK] virtio-blk ready\n");
    return 0;
}

int virtio_blk_present(void) { return _vblk_present; }

uint64_t virtio_blk_sector_count(void) { return _vblk_sectors; }

uint16_t virtio_blk_io_base(void) { return _vblk_iobase; }

int virtio_blk_transfer(uint32_t type, uint64_t sector,
                        void *buf, uint32_t count) {
    if (!_vblk_present || !buf || count == 0) return -1;

    /* Build 3-descriptor chain: [header] → [data] → [status] */
    _req_hdr.type   = type;
    _req_hdr.ioprio = 0;
    _req_hdr.sector = sector;
    _req_status     = 0xFF;  /* "not done" sentinel */

    /* Descriptor 0: request header (read by device) */
    uint8_t d0 = (uint8_t)(_avail_idx % VBLK_QUEUE_SIZE_DEF);
    uint8_t d1 = (uint8_t)((d0 + 1) % VBLK_QUEUE_SIZE_DEF);
    uint8_t d2 = (uint8_t)((d0 + 2) % VBLK_QUEUE_SIZE_DEF);

    _desc[d0].addr  = (uint64_t)(uint32_t)&_req_hdr;
    _desc[d0].len   = sizeof(_req_hdr);
    _desc[d0].flags = VRING_F_NEXT;
    _desc[d0].next  = d1;

    /* Descriptor 1: data buffer (read=device writes, write=device reads) */
    _desc[d1].addr  = (uint64_t)(uint32_t)buf;
    _desc[d1].len   = count * 512u;
    _desc[d1].flags = (uint16_t)(VRING_F_NEXT |
                       (type == VIRTIO_BLK_T_IN ? VRING_F_WRITE : 0));
    _desc[d1].next  = d2;

    /* Descriptor 2: status byte (device writes result) */
    _desc[d2].addr  = (uint64_t)(uint32_t)&_req_status;
    _desc[d2].len   = 1;
    _desc[d2].flags = VRING_F_WRITE;
    _desc[d2].next  = 0;

    /* Post descriptor chain to avail ring */
    uint16_t ai = _avail->idx % VBLK_QUEUE_SIZE_DEF;
    _avail->ring[ai] = d0;
    __asm__ volatile("" ::: "memory");   /* memory barrier */
    _avail->idx++;
    _avail_idx = (uint16_t)(_avail_idx + 3);

    /* Kick queue 0 */
    outw((uint16_t)(_vblk_iobase + VBLK_QUEUE_NOTIFY), 0);

    /* Spin-poll used ring for completion (timeout ~500ms at PIT 1kHz) */
    int timeout = 500000;
    while (_req_status == 0xFFu && --timeout > 0)
        __asm__ volatile("pause");

    if (timeout == 0 || _req_status != VIRTIO_BLK_S_OK) return -1;
    return 0;
}
