/*
 * virtio_blk.h  —  VirtIO block device driver interface (item 81)
 *
 * C code responsibility: map the virtqueue MMIO registers and provide the
 * raw sector-buffer handoff to the TypeScript driver.  TypeScript implements
 * the virtio ring-buffer state machine, error handling, and block scheduling.
 *
 * Supports: legacy PCI virtio-blk (PCI vendor 0x1AF4, device 0x1001).
 */

#ifndef VIRTIO_BLK_H
#define VIRTIO_BLK_H

#include <stdint.h>

/* VirtIO PCI legacy registers (I/O BAR0 offsets) */
#define VBLK_HOST_FEATURES   0x00u  /* 32-bit RO: host feature bits           */
#define VBLK_GUEST_FEATURES  0x04u  /* 32-bit WO: guest feature bits          */
#define VBLK_QUEUE_PFN       0x08u  /* 32-bit RW: queue physical addr >> 12   */
#define VBLK_QUEUE_SIZE      0x0Cu  /* 16-bit RO: queue entry count           */
#define VBLK_QUEUE_SEL       0x0Eu  /* 16-bit WO: select queue index          */
#define VBLK_QUEUE_NOTIFY    0x10u  /* 16-bit WO: kick queue N                */
#define VBLK_DEVICE_STATUS   0x12u  /* 8-bit  RW: device status register      */
#define VBLK_ISR_STATUS      0x13u  /* 8-bit  RO: interrupt status (clears)   */

/* Device-specific config (starts at 0x14 for legacy) */
#define VBLK_CFG_CAPACITY_LO 0x14u  /* lower 32 bits of 64-bit sector count   */
#define VBLK_CFG_CAPACITY_HI 0x18u  /* upper 32 bits; ignore on 32-bit hosts  */
#define VBLK_CFG_SEG_MAX     0x1Cu  /* max segments per request               */
#define VBLK_CFG_GEOMETRY    0x20u  /* disk geometry (cylinders, heads, etc.) */
#define VBLK_CFG_BLK_SIZE    0x28u  /* block size (typically 512)             */

/* Virtio device status bits */
#define VBLK_STAT_ACKNOWLEDGE  0x01u
#define VBLK_STAT_DRIVER       0x02u
#define VBLK_STAT_DRIVER_OK    0x04u
#define VBLK_STAT_FAILED       0x80u

/* Feature bits used by JSOS */
#define VBLK_F_BARRIER         (1u << 0)   /* device supports barriers        */
#define VBLK_F_SIZE_MAX        (1u << 1)   /* max segment size field valid     */
#define VBLK_F_SEG_MAX         (1u << 2)   /* max segment count field valid    */
#define VBLK_F_RO              (1u << 5)   /* device is read-only              */

/* VirtIO block request types */
#define VIRTIO_BLK_T_IN        0u    /* read  */
#define VIRTIO_BLK_T_OUT       1u    /* write */
#define VIRTIO_BLK_T_FLUSH     4u    /* flush write cache                      */

/* VirtIO block request header (placed in first descriptor) */
typedef struct __attribute__((packed)) {
    uint32_t type;    /* VIRTIO_BLK_T_* */
    uint32_t ioprio;  /* request priority (ignored) */
    uint64_t sector;  /* starting sector (512-byte units) */
} virtio_blk_req_hdr_t;

/* VirtIO block status byte (placed in last writable descriptor) */
#define VIRTIO_BLK_S_OK        0u    /* success                                */
#define VIRTIO_BLK_S_IOERR     1u    /* I/O error                              */
#define VIRTIO_BLK_S_UNSUPP    2u    /* unsupported request                    */

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Probe PCI for a VirtIO block device (vendor=0x1AF4, device=0x1001), obtain
 * its I/O BAR, and initialise the virtqueue ring.
 * Returns 0 on success, -1 if no device found.
 */
int virtio_blk_init(void);

/** Returns 1 if a virtio-blk device was found, 0 otherwise. */
int virtio_blk_present(void);

/** Total sector count (512-byte sectors) reported by the device config. */
uint64_t virtio_blk_sector_count(void);

/**
 * Submit a virtio-blk request and spin-poll until completion.
 * type     : VIRTIO_BLK_T_IN or VIRTIO_BLK_T_OUT
 * sector   : starting LBA
 * buf      : data buffer (must be valid physical memory)
 * count    : number of 512-byte sectors
 * Returns 0 on success, -1 on error.
 *
 * NOTE: TypeScript implements the async multi-request queue;
 * this function provides the single-shot synchronous transfer primitive.
 */
int virtio_blk_transfer(uint32_t type, uint64_t sector,
                        void *buf, uint32_t count);

/** Convenience wrappers */
static inline int virtio_blk_read (uint64_t sector, void *buf, uint32_t n)
    { return virtio_blk_transfer(VIRTIO_BLK_T_IN,  sector, buf, n); }
static inline int virtio_blk_write(uint64_t sector, const void *buf, uint32_t n)
    { return virtio_blk_transfer(VIRTIO_BLK_T_OUT, sector, (void *)buf, n); }

/** I/O base register (PCI BAR0) — available for TypeScript to read via
 *  kernel.virtioBlkBase() so the TS driver can directly notify the queue.  */
uint16_t virtio_blk_io_base(void);

#endif /* VIRTIO_BLK_H */
