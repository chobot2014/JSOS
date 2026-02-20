// Copyright 2024 The JSOS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license.

// JSOS Platform Window — Phase 9
//
// Implements the Chromium PlatformWindow interface for JSOS.
// Each window corresponds to a JSOS WM window (wm.ts WindowManager).
// The window bounds are passed to the WM on creation; resize/move are
// handled through JSOS WM event callbacks.

#include "chromium/ui/ozone/platform/jsos/jsos_window.h"

#include "chromium/ui/platform_window/platform_window_delegate.h"

namespace ui {

JsosWindow::JsosWindow(PlatformWindowDelegate* delegate,
                       const gfx::Rect& bounds)
    : delegate_(delegate), bounds_(bounds) {}

JsosWindow::~JsosWindow() = default;

void JsosWindow::Initialize() {
  // Notify Chromium of the initial window bounds.
  delegate_->OnBoundsChanged({bounds_});
  delegate_->OnAcceleratedWidgetAvailable(
      static_cast<gfx::AcceleratedWidget>(1));  // single-window JSOS
}

// PlatformWindow implementation ────────────────────────────────────────────

void JsosWindow::Show(bool inactive) {
  visible_ = true;
}

void JsosWindow::Hide() {
  visible_ = false;
}

void JsosWindow::Close() {
  delegate_->OnClosed();
}

bool JsosWindow::IsVisible() const {
  return visible_;
}

void JsosWindow::PrepareForShutdown() {}

void JsosWindow::SetBoundsInPixels(const gfx::Rect& bounds) {
  bounds_ = bounds;
  delegate_->OnBoundsChanged({bounds_});
}

gfx::Rect JsosWindow::GetBoundsInPixels() const {
  return bounds_;
}

void JsosWindow::SetBoundsInDIP(const gfx::Rect& bounds) {
  SetBoundsInPixels(bounds);
}

gfx::Rect JsosWindow::GetBoundsInDIP() const {
  return bounds_;
}

void JsosWindow::SetTitle(const std::u16string& title) {
  // JSOS WM window title; set via a JSOS syscall in the future.
  (void)title;
}

void JsosWindow::SetCapture() {}
void JsosWindow::ReleaseCapture() {}
bool JsosWindow::HasCapture() const { return false; }

void JsosWindow::SetFullscreen(bool fullscreen, int64_t /*target_display_id*/) {
  // Full-screen = maximise to framebuffer size on JSOS.
  (void)fullscreen;
}

bool JsosWindow::IsFullscreen() const { return false; }

void JsosWindow::Maximize() {}
void JsosWindow::Minimize() {}
void JsosWindow::Restore() {}

PlatformWindowState JsosWindow::GetPlatformWindowState() const {
  return PlatformWindowState::kNormal;
}

void JsosWindow::Activate()   {}
void JsosWindow::Deactivate() {}

void JsosWindow::SetUseNativeFrame(bool use_native_frame) { (void)use_native_frame; }
bool JsosWindow::ShouldUseNativeFrame() const { return false; }

void JsosWindow::SetCursor(scoped_refptr<PlatformCursor> cursor) { (void)cursor; }

void JsosWindow::MoveCursorTo(const gfx::Point& location) { (void)location; }

void JsosWindow::ConfineCursorToBounds(const gfx::Rect& bounds) { (void)bounds; }

void JsosWindow::SetRestoredBoundsInDIP(const gfx::Rect& bounds) { (void)bounds; }
gfx::Rect JsosWindow::GetRestoredBoundsInDIP() const { return bounds_; }

bool JsosWindow::ShouldWindowContentsBeTransparent() const { return false; }
void JsosWindow::SetAspectRatio(const gfx::SizeF& aspect_ratio) { (void)aspect_ratio; }

void JsosWindow::SetWindowIcons(const gfx::ImageSkia& window_icon,
                                const gfx::ImageSkia& app_icon) {
  (void)window_icon; (void)app_icon;
}

void JsosWindow::SizeConstraintsChanged() {}

bool JsosWindow::IsTranslucentWindowOpacitySupported() const { return false; }

void JsosWindow::SetOpacity(float opacity) { (void)opacity; }

void JsosWindow::SetShape(std::unique_ptr<ShapeRects> native_shape,
                          const gfx::Transform& transform) {
  (void)native_shape; (void)transform;
}

void JsosWindow::SetDecorationInsets(
    const gfx::Insets* insets_px) { (void)insets_px; }

}  // namespace ui
