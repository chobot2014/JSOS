/*
 * virtio_gpu.h  —  VirtIO GPU driver interface (item 68)
 *
 * C code responsibility: PCI discovery, virtqueue MMIO setup, and raw command
 * submit/poll primitives.  All GPU command encoding, framebuffer management,
 * resource lifecycle, and cursor handling live in TypeScript.
 *
 * Supports: legacy PCI virtio-gpu (PCI vendor 0x1AF4, device 0x1050).
 * Two queues: controlq (index 0) for GPU commands, cursorq (index 1).
 */

#ifndef VIRTIO_GPU_H
#define VIRTIO_GPU_H

#include <stdint.h>

/* VirtIO GPU PCI IDs */
#define VIRTIO_GPU_VENDOR  0x1AF4u
#define VIRTIO_GPU_DEVICE  0x1050u

/* VirtIO PCI legacy register offsets (BAR0 I/O) */
#define VGPU_REG_HOST_FEATURES  0x00u
#define VGPU_REG_GUEST_FEATURES 0x04u
#define VGPU_REG_QUEUE_PFN      0x08u
#define VGPU_REG_QUEUE_SIZE     0x0Cu
#define VGPU_REG_QUEUE_SEL      0x0Eu
#define VGPU_REG_QUEUE_NOTIFY   0x10u
#define VGPU_REG_DEVICE_STATUS  0x12u
#define VGPU_REG_ISR_STATUS     0x13u

/* Virtio device status bits */
#define VGPU_STAT_ACKNOWLEDGE  0x01u
#define VGPU_STAT_DRIVER       0x02u
#define VGPU_STAT_DRIVER_OK    0x04u

/* virtio-gpu feature bits */
#define VIRTIO_GPU_F_VIRGL      (1u << 0)   /* 3D virgl acceleration          */
#define VIRTIO_GPU_F_EDID       (1u << 1)   /* EDID support                   */

/* ── VirtIO-GPU control command types ───────────────────────────────────── */
#define VIRTIO_GPU_CMD_GET_DISPLAY_INFO     0x0100u
#define VIRTIO_GPU_CMD_RESOURCE_CREATE_2D   0x0101u
#define VIRTIO_GPU_CMD_RESOURCE_UNREF       0x0102u
#define VIRTIO_GPU_CMD_SET_SCANOUT          0x0103u
#define VIRTIO_GPU_CMD_RESOURCE_FLUSH       0x0104u
#define VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D  0x0105u
#define VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING  0x0106u
#define VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING  0x0107u
#define VIRTIO_GPU_CMD_GET_CAPSET_INFO      0x0108u
#define VIRTIO_GPU_CMD_GET_CAPSET           0x0109u
/* Response types */
#define VIRTIO_GPU_RESP_OK_NODATA           0x1100u
#define VIRTIO_GPU_RESP_OK_DISPLAY_INFO     0x1101u
#define VIRTIO_GPU_RESP_ERR_UNSPEC          0x1200u

/* Pixel format */
#define VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM    1u
#define VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM    2u
#define VIRTIO_GPU_FORMAT_A8R8G8B8_UNORM    3u
#define VIRTIO_GPU_FORMAT_X8R8G8B8_UNORM    4u
#define VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM    67u
#define VIRTIO_GPU_FORMAT_X8B8G8R8_UNORM    68u
#define VIRTIO_GPU_FORMAT_A8B8G8R8_UNORM    121u
#define VIRTIO_GPU_FORMAT_R8G8B8X8_UNORM    134u

/* Standard header for all virtio-gpu commands */
typedef struct __attribute__((packed)) {
    uint32_t type;       /* VIRTIO_GPU_CMD_* or VIRTIO_GPU_RESP_* */
    uint32_t flags;
    uint64_t fence_id;
    uint32_t ctx_id;
    uint32_t padding;
} virtio_gpu_ctrl_hdr_t;

/* Rect used in several commands */
typedef struct __attribute__((packed)) {
    uint32_t x, y, width, height;
} virtio_gpu_rect_t;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Probe PCI for a virtio-gpu device and initialise both virtqueues.
 * Returns 0 on success, -1 if not found.
 */
int virtio_gpu_init(void);

/** Returns 1 if virtio-gpu was found during init, 0 otherwise. */
int virtio_gpu_present(void);

/** I/O base of the virtio-gpu device (for TypeScript to kick queues). */
uint16_t virtio_gpu_io_base(void);

/**
 * Submit a control command to controlq (queue 0) and spin-poll for the
 * response.
 * cmd      : pointer to the command buffer (must start with ctrl_hdr_t)
 * cmd_len  : total byte length of the command
 * resp     : response buffer (also starts with ctrl_hdr_t)
 * resp_len : byte length of the response buffer
 * Returns 0 on success (resp->type == VIRTIO_GPU_RESP_OK_*), -1 on error.
 */
int virtio_gpu_ctrl(const void *cmd,  uint32_t cmd_len,
                          void *resp, uint32_t resp_len);

#endif /* VIRTIO_GPU_H */
