/**
 * JSOS GBM (Generic Buffer Manager) Shim — Phase 8
 *
 * Chromium's DRM path allocates GPU-visible buffers through libgbm before
 * calling DRM dumb-buffer ioctls.  JSOS doesn't have a GPU or a real GBM,
 * so we provide a minimal static shim that routes all allocations to the
 * JSOS VMM (Phase 4) and exposes the same symbol names that Chromium links
 * against.
 *
 * Symbol coverage: only the 8 GBM entry points that Chromium actually calls
 * through its Ozone/DRM GBM backend are implemented.  Any others return NULL.
 *
 * Build: compiled as lib/gbm-jsos/libgbm.a and injected into the Chromium
 * link via -lgbm before the system's real libgbm so the linker picks us up.
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* ── JSOS VMM C bindings ─────────────────────────────────────────────── */

extern uint32_t jsos_vmm_alloc(uint32_t size, uint32_t alignment);
extern void     jsos_vmm_free(uint32_t addr, uint32_t size);

/* ── Opaque GBM structs ──────────────────────────────────────────────── */

struct gbm_device {
  int   drm_fd;
  void* reserved;
};

struct gbm_surface {
  struct gbm_device* device;
  uint32_t           width;
  uint32_t           height;
  uint32_t           format;
  uint32_t           flags;
};

struct gbm_bo {
  struct gbm_device* device;
  uint32_t           width;
  uint32_t           height;
  uint32_t           format;
  uint32_t           stride;
  uint32_t           handle;
  uint32_t           addr;   /* JSOS VMM physical address */
  void*              map_ptr;
};

/* ── GBM implementation ──────────────────────────────────────────────── */

struct gbm_device* gbm_create_device(int fd) {
  uint32_t addr = jsos_vmm_alloc(sizeof(struct gbm_device), 4);
  if (!addr) return (struct gbm_device*)0;
  struct gbm_device* dev = (struct gbm_device*)addr;
  dev->drm_fd  = fd;
  dev->reserved = (void*)0;
  return dev;
}

void gbm_device_destroy(struct gbm_device* gbm) {
  if (gbm) jsos_vmm_free((uint32_t)gbm, sizeof(struct gbm_device));
}

int gbm_device_get_fd(struct gbm_device* gbm) {
  return gbm ? gbm->drm_fd : -1;
}

const char* gbm_device_get_backend_name(struct gbm_device* gbm) {
  (void)gbm;
  return "jsos";
}

struct gbm_surface* gbm_surface_create(struct gbm_device* gbm,
                                        uint32_t width, uint32_t height,
                                        uint32_t format, uint32_t flags) {
  uint32_t addr = jsos_vmm_alloc(sizeof(struct gbm_surface), 4);
  if (!addr) return (struct gbm_surface*)0;
  struct gbm_surface* surf = (struct gbm_surface*)addr;
  surf->device = gbm;
  surf->width  = width;
  surf->height = height;
  surf->format = format;
  surf->flags  = flags;
  return surf;
}

void gbm_surface_destroy(struct gbm_surface* surf) {
  if (surf) jsos_vmm_free((uint32_t)surf, sizeof(struct gbm_surface));
}

struct gbm_bo* gbm_surface_lock_front_buffer(struct gbm_surface* surf) {
  if (!surf) return (struct gbm_bo*)0;
  uint32_t size  = surf->width * surf->height * 4;  /* 32-bit BGRA */
  uint32_t paddr = jsos_vmm_alloc(sizeof(struct gbm_bo) + size, 4096);
  if (!paddr) return (struct gbm_bo*)0;

  struct gbm_bo* bo = (struct gbm_bo*)paddr;
  bo->device = surf->device;
  bo->width  = surf->width;
  bo->height = surf->height;
  bo->format = surf->format;
  bo->stride = surf->width * 4;
  bo->handle = (uint32_t)bo ^ 0xdeadbabe;
  bo->addr   = paddr + sizeof(struct gbm_bo);
  bo->map_ptr = (void*)0;
  return bo;
}

void gbm_surface_release_buffer(struct gbm_surface* surf, struct gbm_bo* bo) {
  (void)surf;
  if (bo) {
    uint32_t size = bo->width * bo->height * 4;
    jsos_vmm_free((uint32_t)bo, sizeof(struct gbm_bo) + size);
  }
}

void* gbm_bo_map(struct gbm_bo* bo,
                 uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                 uint32_t flags, uint32_t* stride, void** map_data) {
  (void)x; (void)y; (void)width; (void)height; (void)flags;
  if (!bo) return (void*)0;
  *stride   = bo->stride;
  *map_data = (void*)bo;
  bo->map_ptr = (void*)bo->addr;
  return bo->map_ptr;
}

void gbm_bo_unmap(struct gbm_bo* bo, void* map_data) {
  (void)map_data;
  if (bo) bo->map_ptr = (void*)0;
}

uint32_t gbm_bo_get_width(struct gbm_bo* bo)  { return bo ? bo->width  : 0; }
uint32_t gbm_bo_get_height(struct gbm_bo* bo) { return bo ? bo->height : 0; }
uint32_t gbm_bo_get_stride(struct gbm_bo* bo) { return bo ? bo->stride : 0; }
uint32_t gbm_bo_get_handle_u32(struct gbm_bo* bo) { return bo ? bo->handle : 0; }
uint32_t gbm_bo_get_format(struct gbm_bo* bo) { return bo ? bo->format : 0; }
