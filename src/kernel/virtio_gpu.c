/*
 * virtio_gpu.c  —  Legacy PCI VirtIO GPU driver (item 68)
 *
 * Sets up two split-ring virtqueues (controlq, cursorq) and exposes a
 * synchronous ctrl submit function.  All GPU command construction and
 * framebuffer management live in TypeScript (src/os/ui/).
 */

#include "virtio_gpu.h"
#include "pci.h"
#include "io.h"
#include "platform.h"
#include <stdint.h>
#include <string.h>

/* ── Queue parameters ────────────────────────────────────────────────────── */
#define VGPU_QUEUE_SIZE  32u     /* power-of-two; small for control queue     */
#define VGPU_PAGE_SIZE   4096u

/* Virtqueue ring struct mirrors (layout matches legacy virtio spec v0.9.5) */
typedef struct __attribute__((packed)) {
    uint64_t addr;
    uint32_t len;
    uint16_t flags;
    uint16_t next;
} vgpu_desc_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    uint16_t ring[VGPU_QUEUE_SIZE];
} vgpu_avail_t;

typedef struct __attribute__((packed)) {
    uint32_t id;
    uint32_t len;
} vgpu_used_elem_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    vgpu_used_elem_t ring[VGPU_QUEUE_SIZE];
} vgpu_used_t;

/* Ring layout per queue:
 *   Page 0: descriptors (32×16 = 512 bytes) + avail (4+32×2 = 68) = 580 bytes
 *   Pad to page 1 (4096-580 = 3516 bytes padding)
 *   Page 1: used ring (4 + 32×8 = 260 bytes)
 * Total per queue: 2 pages = 8192 bytes
 */
#define VGPU_SZ_DESC   (VGPU_QUEUE_SIZE * sizeof(vgpu_desc_t))
#define VGPU_SZ_AVAIL  (4u + VGPU_QUEUE_SIZE * 2u)
#define VGPU_AVAIL_OFF VGPU_SZ_DESC
#define VGPU_USED_OFF  VGPU_PAGE_SIZE
#define VGPU_RING_SZ   (2u * VGPU_PAGE_SIZE)   /* per queue */

static uint8_t _ctrlq_mem  [VGPU_RING_SZ] __attribute__((aligned(VGPU_PAGE_SIZE)));
static uint8_t _cursorq_mem[VGPU_RING_SZ] __attribute__((aligned(VGPU_PAGE_SIZE)));

#define _ctrlq_desc  ((vgpu_desc_t *)   _ctrlq_mem)
#define _ctrlq_avail ((vgpu_avail_t *)  (_ctrlq_mem  + VGPU_AVAIL_OFF))
#define _ctrlq_used  ((vgpu_used_t *)   (_ctrlq_mem  + VGPU_USED_OFF))

#define _cursorq_desc  ((vgpu_desc_t *)  _cursorq_mem)
#define _cursorq_avail ((vgpu_avail_t *)(_cursorq_mem + VGPU_AVAIL_OFF))

/* Device state */
static uint16_t _vgpu_iobase     = 0;
static int      _vgpu_present    = 0;
static uint16_t _ctrlq_avail_idx = 0;
static uint16_t _ctrlq_used_last = 0;
static uint16_t _ctrlq_desc_idx  = 0;

/* Virtring flags */
#define VRF_NEXT  0x01u
#define VRF_WRITE 0x02u   /* device-writable */

static int _setup_queue(uint16_t iobase, uint16_t qidx, uint8_t *ring_mem) {
    outw((uint16_t)(iobase + VGPU_REG_QUEUE_SEL), qidx);
    uint16_t qsz = inw((uint16_t)(iobase + VGPU_REG_QUEUE_SIZE));
    if (qsz == 0) return -1;
    memset(ring_mem, 0, VGPU_RING_SZ);
    outl((uint16_t)(iobase + VGPU_REG_QUEUE_PFN),
         (uint32_t)ring_mem / VGPU_PAGE_SIZE);
    return 0;
}

int virtio_gpu_init(void) {
    pci_device_t dev;
    if (pci_find_device(VIRTIO_GPU_VENDOR, VIRTIO_GPU_DEVICE, &dev) != 0) {
        platform_serial_puts("[VGPU] No virtio-gpu device found\n");
        return -1;
    }

    uint16_t iobase = (uint16_t)(dev.bar[0] & ~0x3u);
    if (!iobase) return -1;
    _vgpu_iobase = iobase;

    pci_enable_busmaster(&dev);

    /* VirtIO initialization sequence */
    outb((uint16_t)(iobase + VGPU_REG_DEVICE_STATUS), 0x00u);  /* reset */
    outb((uint16_t)(iobase + VGPU_REG_DEVICE_STATUS), VGPU_STAT_ACKNOWLEDGE);
    outb((uint16_t)(iobase + VGPU_REG_DEVICE_STATUS),
         (uint8_t)(VGPU_STAT_ACKNOWLEDGE | VGPU_STAT_DRIVER));

    /* Accept all features (no virgl for now) */
    uint32_t host_feat = inl((uint16_t)(iobase + VGPU_REG_HOST_FEATURES));
    host_feat &= ~(uint32_t)VIRTIO_GPU_F_VIRGL;   /* don't claim 3D */
    outl((uint16_t)(iobase + VGPU_REG_GUEST_FEATURES), host_feat);

    /* Set up controlq (0) and cursorq (1) */
    if (_setup_queue(iobase, 0, _ctrlq_mem)   != 0) return -1;
    if (_setup_queue(iobase, 1, _cursorq_mem) != 0) return -1;

    outb((uint16_t)(iobase + VGPU_REG_DEVICE_STATUS),
         (uint8_t)(VGPU_STAT_ACKNOWLEDGE | VGPU_STAT_DRIVER | VGPU_STAT_DRIVER_OK));

    _vgpu_present    = 1;
    _ctrlq_avail_idx = 0;
    _ctrlq_used_last = 0;
    _ctrlq_desc_idx  = 0;
    platform_serial_puts("[VGPU] virtio-gpu ready\n");
    return 0;
}

int virtio_gpu_present(void)   { return _vgpu_present; }
uint16_t virtio_gpu_io_base(void) { return _vgpu_iobase; }

int virtio_gpu_ctrl(const void *cmd,  uint32_t cmd_len,
                          void *resp, uint32_t resp_len) {
    if (!_vgpu_present || !cmd || !resp) return -1;

    /* Two-descriptor chain: [cmd (read)] → [resp (write)] */
    uint8_t d0 = (uint8_t)(_ctrlq_desc_idx % VGPU_QUEUE_SIZE);
    uint8_t d1 = (uint8_t)((d0 + 1) % VGPU_QUEUE_SIZE);

    _ctrlq_desc[d0].addr  = (uint64_t)(uint32_t)cmd;
    _ctrlq_desc[d0].len   = cmd_len;
    _ctrlq_desc[d0].flags = VRF_NEXT;
    _ctrlq_desc[d0].next  = d1;

    _ctrlq_desc[d1].addr  = (uint64_t)(uint32_t)resp;
    _ctrlq_desc[d1].len   = resp_len;
    _ctrlq_desc[d1].flags = VRF_WRITE;
    _ctrlq_desc[d1].next  = 0;

    /* Post to avail ring */
    uint16_t ai = _ctrlq_avail->idx % VGPU_QUEUE_SIZE;
    _ctrlq_avail->ring[ai] = d0;
    __asm__ volatile("" ::: "memory");
    _ctrlq_avail->idx++;
    _ctrlq_desc_idx = (uint16_t)(_ctrlq_desc_idx + 2);

    /* Kick controlq */
    outw((uint16_t)(_vgpu_iobase + VGPU_REG_QUEUE_NOTIFY), 0);

    /* Spin-poll used ring for our response (timeout ~200ms) */
    int timeout = 200000;
    while (_ctrlq_used->idx == _ctrlq_used_last && --timeout > 0)
        __asm__ volatile("pause");
    _ctrlq_used_last = _ctrlq_used->idx;

    if (timeout == 0) return -1;

    /* Check response type */
    virtio_gpu_ctrl_hdr_t *r = (virtio_gpu_ctrl_hdr_t *)resp;
    return (r->type >= 0x1100u && r->type < 0x1200u) ? 0 : -1;
}
