/**
 * render.ts — AssemblyScript hot-path pixel rendering
 *
 * Framebuffer is a 32bpp ARGB/XRGB flat buffer in linear memory.
 * All coordinates are in pixels; `fbPtr` is the byte offset of pixel (0,0).
 *
 * These functions are called from the TypeScript compositor via wasm-runtime.ts.
 * They avoid all JS allocation and run at near-native speed via the WASM JIT.
 */

// ── Colour helpers ───────────────────────────────────────────────────────────

@inline function r(c: u32): u32 { return (c >> 16) & 0xff; }
@inline function g(c: u32): u32 { return (c >>  8) & 0xff; }
@inline function b(c: u32): u32 { return  c        & 0xff; }
@inline function a(c: u32): u32 { return (c >> 24) & 0xff; }
@inline function pack(ra: u32, ga: u32, ba: u32, aa: u32): u32 {
  return (aa << 24) | (ra << 16) | (ga << 8) | ba;
}

// ── Solid fill ───────────────────────────────────────────────────────────────

/**
 * fillRect — fill a rectangle with a solid colour.
 * `fbPtr`  = byte offset of framebuffer pixel (0,0)
 * `stride` = bytes per row (width * 4)
 * `x,y,w,h` = rectangle in pixels
 * `color`  = 0xAARRGGBB
 */
export function fillRect(
  fbPtr: i32, stride: i32,
  x: i32, y: i32, w: i32, h: i32,
  color: u32
): void {
  for (let row: i32 = 0; row < h; row++) {
    const rowPtr: i32 = fbPtr + (y + row) * stride + x * 4;
    for (let col: i32 = 0; col < w; col++) {
      store<u32>(rowPtr + col * 4, color);
    }
  }
}

/**
 * fillRectAlpha — alpha-blend `color` over existing pixels.
 */
export function fillRectAlpha(
  fbPtr: i32, stride: i32,
  x: i32, y: i32, w: i32, h: i32,
  color: u32
): void {
  const sa: u32 = a(color);
  if (sa === 0) return;
  if (sa === 255) { fillRect(fbPtr, stride, x, y, w, h, color); return; }
  const ia: u32 = 255 - sa;
  const sr: u32 = r(color); const sg: u32 = g(color); const sb: u32 = b(color);
  for (let row: i32 = 0; row < h; row++) {
    const rowPtr: i32 = fbPtr + (y + row) * stride + x * 4;
    for (let col: i32 = 0; col < w; col++) {
      const dst: u32 = load<u32>(rowPtr + col * 4);
      const nr: u32 = (sr * sa + r(dst) * ia) / 255;
      const ng: u32 = (sg * sa + g(dst) * ia) / 255;
      const nb: u32 = (sb * sa + b(dst) * ia) / 255;
      store<u32>(rowPtr + col * 4, pack(nr, ng, nb, 255));
    }
  }
}

// ── Blit ─────────────────────────────────────────────────────────────────────

/**
 * blitCopy — copy a rectangle from `srcPtr` to `dstPtr` (no alpha blending).
 */
export function blitCopy(
  srcPtr: i32, srcStride: i32,
  dstPtr: i32, dstStride: i32,
  sx: i32, sy: i32, dx: i32, dy: i32,
  w: i32, h: i32
): void {
  for (let row: i32 = 0; row < h; row++) {
    const sp: i32 = srcPtr + (sy + row) * srcStride + sx * 4;
    const dp: i32 = dstPtr + (dy + row) * dstStride + dx * 4;
    for (let col: i32 = 0; col < w; col++) {
      store<u32>(dp + col * 4, load<u32>(sp + col * 4));
    }
  }
}

/**
 * blitAlpha — alpha-blend src rectangle over dst.
 */
export function blitAlpha(
  srcPtr: i32, srcStride: i32,
  dstPtr: i32, dstStride: i32,
  sx: i32, sy: i32, dx: i32, dy: i32,
  w: i32, h: i32
): void {
  for (let row: i32 = 0; row < h; row++) {
    const sp: i32 = srcPtr + (sy + row) * srcStride + sx * 4;
    const dp: i32 = dstPtr + (dy + row) * dstStride + dx * 4;
    for (let col: i32 = 0; col < w; col++) {
      const src: u32 = load<u32>(sp + col * 4);
      const sa: u32 = a(src);
      if (sa === 0) continue;
      if (sa === 255) { store<u32>(dp + col * 4, src); continue; }
      const dst: u32 = load<u32>(dp + col * 4);
      const ia: u32 = 255 - sa;
      const nr: u32 = (r(src) * sa + r(dst) * ia) / 255;
      const ng: u32 = (g(src) * sa + g(dst) * ia) / 255;
      const nb: u32 = (b(src) * sa + b(dst) * ia) / 255;
      store<u32>(dp + col * 4, pack(nr, ng, nb, 255));
    }
  }
}

// ── Scanline ─────────────────────────────────────────────────────────────────

/**
 * drawHLine — horizontal line from (x,y) of length `w`.
 */
export function drawHLine(fbPtr: i32, stride: i32, x: i32, y: i32, w: i32, color: u32): void {
  const rowPtr: i32 = fbPtr + y * stride + x * 4;
  for (let i: i32 = 0; i < w; i++) store<u32>(rowPtr + i * 4, color);
}

/**
 * drawVLine — vertical line from (x,y) of height `h`.
 */
export function drawVLine(fbPtr: i32, stride: i32, x: i32, y: i32, h: i32, color: u32): void {
  for (let i: i32 = 0; i < h; i++) store<u32>(fbPtr + (y + i) * stride + x * 4, color);
}

/**
 * drawRect — 1-pixel-wide hollow rectangle outline.
 */
export function drawRect(
  fbPtr: i32, stride: i32,
  x: i32, y: i32, w: i32, h: i32,
  color: u32
): void {
  drawHLine(fbPtr, stride, x, y,         w, color);
  drawHLine(fbPtr, stride, x, y + h - 1, w, color);
  drawVLine(fbPtr, stride, x,         y, h, color);
  drawVLine(fbPtr, stride, x + w - 1, y, h, color);
}

// ── Scroll ────────────────────────────────────────────────────────────────────

/**
 * scrollUp — scroll the framebuffer up by `rows` pixel rows, fill bottom with `fillColor`.
 */
export function scrollUp(fbPtr: i32, stride: i32, width: i32, height: i32, rows: i32, fillColor: u32): void {
  const rowBytes: i32 = width * 4;
  // Move rows up
  for (let y: i32 = 0; y < height - rows; y++) {
    const dst: i32 = fbPtr + y * stride;
    const src: i32 = fbPtr + (y + rows) * stride;
    for (let x: i32 = 0; x < rowBytes; x++) store<u8>(dst + x, load<u8>(src + x));
  }
  // Fill bottom
  for (let y: i32 = height - rows; y < height; y++) {
    const rowPtr: i32 = fbPtr + y * stride;
    for (let x: i32 = 0; x < width; x++) store<u32>(rowPtr + x * 4, fillColor);
  }
}

// ── Glyph blit ────────────────────────────────────────────────────────────────

/**
 * blitGlyph1bpp — blit a 1-bpp glyph bitmap from `glyphPtr` to the framebuffer.
 * `glyphPtr` = byte offset of glyph bitmap (1 bit per pixel, packed, row-major)
 * `glyphW`, `glyphH` = glyph dimensions
 * `glyphStride` = bytes per glyph row
 * `fgColor`, `bgColor` = foreground / background 0xAARRGGBB (bgColor alpha=0 = transparent)
 */
export function blitGlyph1bpp(
  fbPtr: i32, fbStride: i32,
  dx: i32, dy: i32,
  glyphPtr: i32, glyphW: i32, glyphH: i32, glyphStride: i32,
  fgColor: u32, bgColor: u32
): void {
  const bgAlpha: u32 = a(bgColor);
  for (let row: i32 = 0; row < glyphH; row++) {
    const dstRow: i32 = fbPtr + (dy + row) * fbStride + dx * 4;
    const srcRow: i32 = glyphPtr + row * glyphStride;
    for (let col: i32 = 0; col < glyphW; col++) {
      const bit: u32 = (load<u8>(srcRow + (col >> 3)) >> (7 - (col & 7))) as u32 & 1;
      if (bit) {
        store<u32>(dstRow + col * 4, fgColor);
      } else if (bgAlpha > 0) {
        store<u32>(dstRow + col * 4, bgColor);
      }
    }
  }
}
