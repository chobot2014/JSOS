// Copyright 2024 The JSOS Authors. All rights reserved.
#ifndef UI_OZONE_PLATFORM_JSOS_JSOS_WINDOW_H_
#define UI_OZONE_PLATFORM_JSOS_JSOS_WINDOW_H_

#include <memory>
#include <string>

#include "chromium/ui/gfx/geometry/rect.h"
#include "chromium/ui/platform_window/platform_window.h"

namespace ui {

class PlatformWindowDelegate;

// Implements PlatformWindow for the JSOS bare-metal OS.
// Phase 9: wraps a JSOS WM window; delegates rendering to JSOS SwiftShader.
class JsosWindow : public PlatformWindow {
 public:
  JsosWindow(PlatformWindowDelegate* delegate, const gfx::Rect& bounds);
  ~JsosWindow() override;

  // Called after construction to notify the delegate of initial state.
  void Initialize();

  // PlatformWindow:
  void Show(bool inactive = false) override;
  void Hide() override;
  void Close() override;
  bool IsVisible() const override;
  void PrepareForShutdown() override;
  void SetBoundsInPixels(const gfx::Rect& bounds) override;
  gfx::Rect GetBoundsInPixels() const override;
  void SetBoundsInDIP(const gfx::Rect& bounds) override;
  gfx::Rect GetBoundsInDIP() const override;
  void SetTitle(const std::u16string& title) override;
  void SetCapture() override;
  void ReleaseCapture() override;
  bool HasCapture() const override;
  void SetFullscreen(bool fullscreen, int64_t target_display_id) override;
  bool IsFullscreen() const override;
  void Maximize() override;
  void Minimize() override;
  void Restore() override;
  PlatformWindowState GetPlatformWindowState() const override;
  void Activate() override;
  void Deactivate() override;
  void SetUseNativeFrame(bool use_native_frame) override;
  bool ShouldUseNativeFrame() const override;
  void SetCursor(scoped_refptr<PlatformCursor> cursor) override;
  void MoveCursorTo(const gfx::Point& location) override;
  void ConfineCursorToBounds(const gfx::Rect& bounds) override;
  void SetRestoredBoundsInDIP(const gfx::Rect& bounds) override;
  gfx::Rect GetRestoredBoundsInDIP() const override;
  bool ShouldWindowContentsBeTransparent() const override;
  void SetAspectRatio(const gfx::SizeF& aspect_ratio) override;
  void SetWindowIcons(const gfx::ImageSkia& window_icon,
                      const gfx::ImageSkia& app_icon) override;
  void SizeConstraintsChanged() override;
  bool IsTranslucentWindowOpacitySupported() const override;
  void SetOpacity(float opacity) override;
  void SetShape(std::unique_ptr<ShapeRects> native_shape,
                const gfx::Transform& transform) override;
  void SetDecorationInsets(const gfx::Insets* insets_px) override;

 private:
  PlatformWindowDelegate* delegate_;
  gfx::Rect               bounds_;
  bool                    visible_ = false;
};

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_JSOS_JSOS_WINDOW_H_
