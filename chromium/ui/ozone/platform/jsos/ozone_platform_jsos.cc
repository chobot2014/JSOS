// Copyright 2024 The JSOS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license.

// JSOS Ozone Platform — Phase 9
//
// Integrates the Chromium Ozone platform with the JSOS bare-metal OS.
// The JSOS Ozone backend:
//  - Routes GL surface creation through DRM/KMS (Phase 8 /dev/dri/card0).
//  - Delivers keyboard/mouse events via the JSOS kernel bindings.
//  - Hosts PlatformWindows as JSOS WM windows.
//
// Usage: --ozone-platform=jsos

#include "chromium/ui/ozone/platform/jsos/ozone_platform_jsos.h"

#include <memory>
#include <utility>

#include "chromium/ui/events/ozone/evdev/event_factory_evdev.h"
#include "chromium/ui/ozone/platform/jsos/jsos_event_source.h"
#include "chromium/ui/ozone/platform/jsos/jsos_surface_factory.h"
#include "chromium/ui/ozone/platform/jsos/jsos_window.h"
#include "chromium/ui/ozone/public/ozone_platform.h"

namespace ui {
namespace {

class OzonePlatformJsos : public OzonePlatform {
 public:
  OzonePlatformJsos()  = default;
  ~OzonePlatformJsos() = default;

  // OzonePlatform:
  SurfaceFactoryOzone* GetSurfaceFactoryOzone() override {
    return surface_factory_.get();
  }

  OverlayManagerOzone* GetOverlayManager() override { return nullptr; }

  CursorFactoryOzone* GetCursorFactory() override { return nullptr; }

  InputController* GetInputController() override { return nullptr; }

  GpuPlatformSupportHost* GetGpuPlatformSupportHost() override {
    return nullptr;
  }

  std::unique_ptr<SystemInputInjector> CreateSystemInputInjector() override {
    return nullptr;
  }

  std::unique_ptr<PlatformWindow> CreatePlatformWindow(
      PlatformWindowDelegate* delegate,
      PlatformWindowInitProperties properties) override {
    auto window = std::make_unique<JsosWindow>(delegate, properties.bounds);
    window->Initialize();
    return window;
  }

  std::unique_ptr<display::NativeDisplayDelegate>
  CreateNativeDisplayDelegate() override {
    return nullptr;
  }

  std::unique_ptr<PlatformScreen> CreateScreen() override { return nullptr; }

  PlatformClipboard* GetPlatformClipboard() override { return nullptr; }

  PlatformGLEGLUtility* GetPlatformGLEGLUtility() override { return nullptr; }

  std::unique_ptr<InputMethod> CreateInputMethod(
      ImeKeyEventDispatcher* dispatcher,
      gfx::AcceleratedWidget widget) override {
    return nullptr;
  }

  void InitializeUI(const InitParams& params) override {
    surface_factory_ = std::make_unique<JsosSurfaceFactory>();
    event_source_    = std::make_unique<JsosEventSource>();
    event_source_->Start();
  }

  void InitializeGPU(const InitParams& params) override {
    if (!surface_factory_) {
      surface_factory_ = std::make_unique<JsosSurfaceFactory>();
    }
  }

 private:
  std::unique_ptr<JsosSurfaceFactory> surface_factory_;
  std::unique_ptr<JsosEventSource>    event_source_;
};

}  // namespace

OzonePlatform* CreateOzonePlatformJsos() {
  return new OzonePlatformJsos();
}

}  // namespace ui
