/**
 * JSOS SwiftShader Platform Bridge — Display / Framebuffer
 *
 * Routes SwiftShader framebuffer-presentation calls to the JSOS physical FB.
 *
 * After SwiftShader finishes rendering a frame into its internal tile buffer
 * it calls sw_presentFrame() with a pointer to the BGRA pixels.  We forward
 * that directly to platform_fb_blit() (Phase 3 C binding) which performs a
 * single memcpy into the VGA framebuffer — no JS round-trip required.
 *
 * This is the only display path that bypasses the TypeScript Canvas layer.
 * The TypeScript DRM page-flip path (drm.ts → swiftshader.ts → canvas.flip())
 * is used when Chromium drives rendering; this path is for direct SwiftShader
 * benchmarks and unit tests.
 */

#include <stddef.h>
#include <stdint.h>

// ── JSOS kernel C bindings ────────────────────────────────────────────────

extern "C" {
  // Phase 3 framebuffer blit — copies a BGRA Uint32Array region
  void platform_fb_blit(const uint32_t* pixels,
                        int x, int y, int width, int height);

  // Phase 3 framebuffer query
  int  platform_fb_width(void);
  int  platform_fb_height(void);
}

// ── SwiftShader display implementation ────────────────────────────────────

extern "C" {

/**
 * Present a completed frame to the physical framebuffer.
 *
 * pixels: BGRA pixel buffer, width * height * 4 bytes.
 * x, y:   destination top-left in framebuffer coordinates.
 * width, height: dimensions of the pixel buffer.
 *
 * Called by SwiftShader's EGL swap-buffers implementation after all render
 * passes have completed on the CPU tile workers.
 */
void sw_presentFrame(const void* pixels, int x, int y,
                     int width, int height) {
  platform_fb_blit(reinterpret_cast<const uint32_t*>(pixels),
                   x, y, width, height);
}

/**
 * Return the framebuffer width in pixels.
 * SwiftShader uses this to size its swap-chain images.
 */
int sw_framebufferWidth(void)  { return platform_fb_width();  }

/**
 * Return the framebuffer height in pixels.
 */
int sw_framebufferHeight(void) { return platform_fb_height(); }

} // extern "C"
