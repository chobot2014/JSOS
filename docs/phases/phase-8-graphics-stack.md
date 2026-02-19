# Phase 8 — Graphics Stack

## Goal

Provide a software OpenGL ES / Vulkan rendering backend that Chromium can
drive without a real GPU, and expose it through the DRM/KMS device interface
that Chromium's Ozone layer expects.

---

## Prerequisites

- Phase 3 complete (Canvas + framebuffer blit)
- Phase 4 complete (mmap — SwiftShader needs it for shader compilation)
- Phase 5 complete (threads — SwiftShader uses multiple worker threads)
- Phase 6 complete (POSIX: mprotect needed for JIT, /dev/dri/card0 as VFS mount)

---

## The C Code Rule Applied Here

SwiftShader is a third-party library in `lib/`. JSOS provides it with platform
primitives (memory allocation, thread creation, pixel output) via TypeScript
APIs. The DRM/KMS shim is a TypeScript `FileDescription` class — no new C.

---

## 8a — SwiftShader (lib/swiftshader/)

SwiftShader is Google's production software Vulkan/OpenGL ES renderer. It runs
entirely on the CPU — no GPU required. It is **not part of JSOS**; it lives in
`lib/` and is compiled as a static archive.

```
lib/
  swiftshader/
    src/           SwiftShader source (C++)
    include/       Vulkan/OpenGL ES headers
    jsos/
      Platform.cpp    platform abstraction implementation for JSOS
      Thread.cpp      thread creation bridge
      Memory.cpp      memory allocation bridge
```

### Platform Bridges (lib/swiftshader/jsos/)

SwiftShader requires platform abstractions for memory, threads, and display.
We provide these by calling JSOS TypeScript APIs through a minimal C++ bridge.

#### Memory Bridge

```cpp
// jsos/Memory.cpp
void* allocateMemory(size_t size, int alignment) {
  // Calls vmm.mmap via C binding
  return reinterpret_cast<void*>(jsos_vmm_alloc(size, alignment));
}
void freeMemory(void* ptr, size_t size) {
  jsos_vmm_free(ptr, size);
}
// For JIT shader compilation — needs PROT_EXEC:
void* allocateJITBuffer(size_t size) {
  return reinterpret_cast<void*>(jsos_vmm_alloc_exec(size));
}
```

#### Thread Bridge

```cpp
// jsos/Thread.cpp
typedef void (*ThreadFunc)(void*);
OS::Thread createThread(ThreadFunc fn, void* arg) {
  // Calls TypeScript ThreadManager.createKernelThread via C binding
  return jsos_thread_create(fn, arg);
}
```

#### Display Bridge

```cpp
// jsos/Platform.cpp — framebuffer presentation
void presentFrame(const void* pixels, int width, int height) {
  // Calls platform_fb_blit() directly (no JS round-trip needed)
  platform_fb_blit((uint32_t*)pixels, 0, 0, width, height);
}
```

### TypeScript: SwiftShader Initialisation (src/os/graphics/swiftshader.ts)

```typescript
class SwiftShaderBackend {
  // Called at boot to configure SwiftShader platform bridges
  init(width: number, height: number): void

  // Returns the Vulkan VkInstance handle (a number — opaque pointer)
  createVkInstance(): number

  // Returns the VkDevice handle
  createVkDevice(instance: number): number

  // Swap chain present — copies SwiftShader render target to Canvas
  present(): void
}
```

---

## 8b — DRM/KMS Shim

Chromium's Linux display layer (ozone/platform/drm) opens `/dev/dri/card0` and
uses DRM/KMS `ioctl` calls to configure display modes and flip framebuffers.

We implement `/dev/dri/card0` as a TypeScript `FileDescription` that intercepts
these ioctls and routes them to our Canvas / SwiftShader.

### Relevant DRM/KMS ioctls Chromium uses

| ioctl | Request | Our Implementation |
|---|---|---|
| `DRM_IOCTL_GET_CAP` | Check DRM capabilities | Return appropriate caps |
| `DRM_IOCTL_MODE_GETRESOURCES` | Query connectors/CRTCs | Return one CRTC, one connector |
| `DRM_IOCTL_MODE_GETCRTC` | Get CRTC state | Return our WM canvas dimensions |
| `DRM_IOCTL_MODE_GETCONNECTOR` | Get connector modes | Return our framebuffer resolution |
| `DRM_IOCTL_MODE_ADDFB2` | Add framebuffer | Allocate Canvas backing memory |
| `DRM_IOCTL_MODE_PAGE_FLIP` | Present frame | Call `canvas.flip()` |
| `DRM_IOCTL_MODE_CREATE_DUMB` | Create dumb buffer | Allocate pixel buffer via vmm |
| `DRM_IOCTL_MODE_MAP_DUMB` | Get mmap offset | Return buffer address |

### TypeScript Implementation (src/os/fs/drm.ts)

```typescript
class DRMDevice implements FileDescription {
  private crtcs: DRMCrtc[]   = [new DRMCrtc(0, this.canvas.width, this.canvas.height)]
  private connectors: DRMConnector[] = [new DRMConnector(0, this.crtcs[0])]
  private framebuffers: Map<number, DRMFramebuffer> = new Map()

  constructor(private canvas: Canvas) {}

  ioctl(request: number, arg: number): number {
    switch (request) {
      case DRM_IOCTL_GET_CAP:         return this.getCapability(arg)
      case DRM_IOCTL_MODE_GETRESOURCES: return this.getResources(arg)
      case DRM_IOCTL_MODE_GETCRTC:    return this.getCrtc(arg)
      case DRM_IOCTL_MODE_GETCONNECTOR: return this.getConnector(arg)
      case DRM_IOCTL_MODE_ADDFB2:     return this.addFramebuffer(arg)
      case DRM_IOCTL_MODE_PAGE_FLIP:  return this.pageFlip(arg)
      case DRM_IOCTL_MODE_CREATE_DUMB: return this.createDumb(arg)
      case DRM_IOCTL_MODE_MAP_DUMB:   return this.mapDumb(arg)
      default: return -EINVAL
    }
  }

  private pageFlip(arg: number): number {
    // Chromium has written pixels into the dumb buffer via mmap.
    // Copy them to our Canvas and call flip().
    const fb = this.framebuffers.get(readU32(arg, 0))!
    this.canvas.blitRaw(fb.pixels, 0, 0, fb.width, fb.height)
    this.canvas.flip()
    return 0
  }
}
```

### VFS Registration

```typescript
// In main.ts Phase 8 init:
vfs.mount('/dev/dri', new DRMDirectory(new DRMDevice(screenCanvas)))
```

---

## GBM (Generic Buffer Manager) — minimal shim

Chromium's DRM path also uses `libgbm` to allocate GPU-visible buffers. We
provide a minimal static shim that routes allocations to `vmm.mmap`.

```c
// lib/gbm-jsos/gbm.c — implements just what Chromium calls:
struct gbm_device *gbm_create_device(int fd) { ... }
struct gbm_surface *gbm_surface_create(...) { ... }
struct gbm_bo *gbm_surface_lock_front_buffer(...) { ... }
void *gbm_bo_map(struct gbm_bo *bo, ...) { ... }
```

---

## New TypeScript Files

| File | Description |
|---|---|
| `src/os/graphics/swiftshader.ts` | SwiftShader init + TypeScript platform bridge |
| `src/os/fs/drm.ts` | DRM/KMS ioctl shim as FileDescription |

## Third-Party Libraries Added

| Library | Location | Purpose |
|---|---|---|
| SwiftShader | `lib/swiftshader/` | Software Vulkan/OpenGL ES |
| libgbm shim | `lib/gbm-jsos/` | GBM buffer allocation stub |

## No New C Primitives

Phase 8 adds no new `kernel.*` bindings. SwiftShader's platform bridges call
existing APIs: `platform_fb_blit`, Phase 4 vmm, Phase 5 thread creation.

---

## Test Oracle

```
[SERIAL] SwiftShader: Vulkan device created
[SERIAL] DRM: /dev/dri/card0 ready (1024x768)
[SERIAL] OpenGL ES 3.1 test: triangle rendered to framebuffer: PASS
[SERIAL] DRM page flip: PASS
```

---

## What Phase 8 Does NOT Do

- ❌ No hardware GPU support (SwiftShader CPU-only — sufficient for Chromium)
- ❌ No Wayland compositor (Chromium uses Ozone, which talks directly to DRM)
- ❌ No Vulkan WSI extensions beyond what Chromium requires
- ❌ No hardware video decode
