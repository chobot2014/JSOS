// Copyright 2024 The JSOS Authors. All rights reserved.
#ifndef UI_OZONE_PLATFORM_JSOS_JSOS_SURFACE_FACTORY_H_
#define UI_OZONE_PLATFORM_JSOS_JSOS_SURFACE_FACTORY_H_

#include <memory>
#include <vector>

#include "chromium/ui/ozone/public/gl_ozone.h"
#include "chromium/ui/ozone/public/surface_factory_ozone.h"

namespace ui {

// Surface factory for the JSOS Ozone platform.
// Creates EGL surfaces backed by /dev/dri/card0 (Phase 8 DRM device).
// GL rendering is handled by SwiftShader (Phase 8).
class JsosSurfaceFactory : public SurfaceFactoryOzone, public GLOzone {
 public:
  JsosSurfaceFactory();
  ~JsosSurfaceFactory() override;

  // SurfaceFactoryOzone:
  std::vector<gl::GLImplementationParts> GetAllowedGLImplementations() override;
  GLOzone* GetGLOzone(
      const gl::GLImplementationParts& implementation) override;

  // GLOzone:
  std::unique_ptr<SurfaceOzoneEGL> CreateEGLSurfaceForWidget(
      gfx::AcceleratedWidget widget) override;
  std::unique_ptr<SurfaceOzoneEGL> CreateSurfacelessEGLSurface(
      const gfx::Size& size) override;
  bool LoadEGLGLES2Bindings(EGLDisplayPlatform native_display) override;
};

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_JSOS_JSOS_SURFACE_FACTORY_H_
