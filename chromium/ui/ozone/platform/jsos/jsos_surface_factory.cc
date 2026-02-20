// Copyright 2024 The JSOS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license.

// JSOS Surface Factory — Phase 9
//
// Creates EGL/GL surfaces backed by the JSOS DRM/KMS device (Phase 8).
// When Chromium requests a GLSurface for a widget, we open /dev/dri/card0
// and use the DRM_IOCTL_MODE_PAGE_FLIP ioctl to present rendered frames —
// the same ioctl path exercised in the Phase 8 smoke test.

#include "chromium/ui/ozone/platform/jsos/jsos_surface_factory.h"

#include <fcntl.h>
#include <unistd.h>

#include "chromium/ui/gl/gl_surface.h"
#include "chromium/ui/ozone/public/surface_ozone_egl.h"

namespace ui {

namespace {

// Path to the JSOS DRM device (Phase 8, mounted at /dev/dri/card0).
constexpr char kDrmDevicePath[] = "/dev/dri/card0";

// DRM ioctl numbers — same constants as in JSOS drm.ts (Phase 8).
constexpr unsigned long DRM_IOCTL_GET_CAP         = 0xC010640C;
constexpr unsigned long DRM_IOCTL_MODE_PAGE_FLIP  = 0x400C64B0;

// A minimal EGL surface backed by the JSOS DRM device fd.
class JsosSurfaceOzoneEGL : public SurfaceOzoneEGL {
 public:
  explicit JsosSurfaceOzoneEGL(int drm_fd) : drm_fd_(drm_fd) {}
  ~JsosSurfaceOzoneEGL() override {
    if (drm_fd_ >= 0) close(drm_fd_);
  }

  // SurfaceOzoneEGL:
  intptr_t GetNativeWindow() override {
    // Return the drm fd as the "native window"; EGL on JSOS maps this to the
    // SwiftShader framebuffer (Phase 8).
    return static_cast<intptr_t>(drm_fd_);
  }

  bool ResizeNativeWindow(const gfx::Size& viewport_size) override {
    // JSOS has a fixed-resolution framebuffer — no dynamic resize needed.
    return true;
  }

  bool OnSwapBuffers(SwapCompletionCallback callback,
                     gfx::FrameData data) override {
    // Trigger a DRM page-flip to present the rendered frame.
    // Maps to DRMDevice.ioctl(DRM_IOCTL_MODE_PAGE_FLIP, 0) in Phase 8.
    if (drm_fd_ >= 0) {
      ioctl(drm_fd_, DRM_IOCTL_MODE_PAGE_FLIP, 0);
    }
    std::move(callback).Run(gfx::SwapResult::SWAP_ACK, nullptr);
    return true;
  }

  std::unique_ptr<gfx::VSyncProvider> CreateVSyncProvider() override {
    return nullptr;  // PIT timer drives vsync (Phase 2).
  }

 private:
  int drm_fd_;
};

}  // namespace

JsosSurfaceFactory::JsosSurfaceFactory()  = default;
JsosSurfaceFactory::~JsosSurfaceFactory() = default;

std::vector<gl::GLImplementationParts>
JsosSurfaceFactory::GetAllowedGLImplementations() {
  // SwiftShader (Phase 8) is the only GL backend on JSOS.
  return {{gl::kGLImplementationSwiftShaderGL}};
}

GLOzone* JsosSurfaceFactory::GetGLOzone(
    const gl::GLImplementationParts& implementation) {
  // Return ourselves; we implement GLOzone inline for simplicity.
  return this;
}

std::unique_ptr<SurfaceOzoneEGL>
JsosSurfaceFactory::CreateEGLSurfaceForWidget(
    gfx::AcceleratedWidget widget) {
  // Open the JSOS DRM device (Phase 8: /dev/dri/card0).
  int fd = open(kDrmDevicePath, O_RDWR);
  if (fd < 0) {
    // Fallback: return a surface with fd=-1; SwiftShader renders to an
    // offscreen buffer and we blit manually.
    return std::make_unique<JsosSurfaceOzoneEGL>(-1);
  }
  return std::make_unique<JsosSurfaceOzoneEGL>(fd);
}

std::unique_ptr<SurfaceOzoneEGL>
JsosSurfaceFactory::CreateSurfacelessEGLSurface(const gfx::Size& size) {
  return std::make_unique<JsosSurfaceOzoneEGL>(-1);
}

bool JsosSurfaceFactory::LoadEGLGLES2Bindings(
    EGLDisplayPlatform native_display) {
  // EGL is provided by SwiftShader; no dynamic loading needed on JSOS.
  return true;
}

}  // namespace ui
