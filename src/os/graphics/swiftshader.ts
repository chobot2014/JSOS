/**
 * JSOS SwiftShader Backend — Phase 8
 *
 * Software Vulkan / OpenGL ES renderer.
 *
 * Production architecture: SwiftShader (lib/swiftshader/) is compiled as a
 * static archive and linked against JSOS.  TypeScript platform bridges in
 * lib/swiftshader/jsos/ route memory allocation, thread creation, and
 * framebuffer presentation back to JSOS TypeScript APIs.
 *
 * This module: pure TypeScript software rasterizer that implements the same
 * public API that Phase 9 Chromium will call.  Produces pixel-correct output
 * on bare metal without any GPU.
 */

import type { Canvas } from '../ui/canvas.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Opaque Vulkan handle types ─────────────────────────────────────────────
export type VkInstance = number;
export type VkDevice   = number;
export type VkImage    = number;

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Pack RGBA 0-255 components into a Uint32Array-compatible pixel word.
 * Format: 0xAARRGGBB — stored in LE memory as B,G,R,A bytes which is the
 * BGRA layout expected by kernel.fbBlit / Canvas.flip().
 */
function packRGBA(r: number, g: number, b: number, a: number): number {
  return ((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

// ── Barycentric / scanline rasterizer ─────────────────────────────────────

interface Vertex {
  x: number; y: number;       // screen space (pixels)
  r: number; g: number; b: number;  // 0-255
}

/** Signed 2D edge function — positive when (px,py) is to the left of AB. */
function edgeFn(ax: number, ay: number, bx: number, by: number,
                px: number, py: number): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

/**
 * Rasterize a single triangle into `buf` using barycentric coordinates.
 * Returns the number of pixels written.
 */
function rasterizeTriangle(buf: Uint32Array, width: number, height: number,
                            v0: Vertex, v1: Vertex, v2: Vertex): number {
  var minX = Math.max(0,         Math.floor(Math.min(v0.x, v1.x, v2.x)));
  var minY = Math.max(0,         Math.floor(Math.min(v0.y, v1.y, v2.y)));
  var maxX = Math.min(width  - 1, Math.ceil( Math.max(v0.x, v1.x, v2.x)));
  var maxY = Math.min(height - 1, Math.ceil( Math.max(v0.y, v1.y, v2.y)));

  var area = edgeFn(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y);
  if (Math.abs(area) < 0.5) return 0; // degenerate

  var invArea = 1.0 / area;
  var pixels  = 0;

  for (var py = minY; py <= maxY; py++) {
    for (var px = minX; px <= maxX; px++) {
      var cx = px + 0.5;
      var cy = py + 0.5;

      // Barycentric weights for P w.r.t. each vertex
      var w0 = edgeFn(v1.x, v1.y, v2.x, v2.y, cx, cy);
      var w1 = edgeFn(v2.x, v2.y, v0.x, v0.y, cx, cy);
      var w2 = edgeFn(v0.x, v0.y, v1.x, v1.y, cx, cy);

      if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
        var rr = (w0 * v0.r + w1 * v1.r + w2 * v2.r) * invArea;
        var gg = (w0 * v0.g + w1 * v1.g + w2 * v2.g) * invArea;
        var bb = (w0 * v0.b + w1 * v1.b + w2 * v2.b) * invArea;

        buf[py * width + px] = packRGBA(
          Math.min(255, Math.max(0, rr | 0)),
          Math.min(255, Math.max(0, gg | 0)),
          Math.min(255, Math.max(0, bb | 0)),
          0xff,
        );
        pixels++;
      }
    }
  }
  return pixels;
}

// ── SwiftShader backend ────────────────────────────────────────────────────

export class SwiftShaderBackend {
  private _canvas:       Canvas | null       = null;
  private _renderTarget: Uint32Array | null  = null;
  private _nextHandle:   number              = 1;
  private _vkInstance:   VkInstance          = 0;
  private _vkDevice:     VkDevice            = 0;
  private _width:        number              = 0;
  private _height:       number              = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Attach to the JSOS screen canvas and allocate the off-screen render target.
   * Must be called once after the WM canvas is created (main.ts Phase 8 boot).
   */
  init(canvas: Canvas): void {
    this._canvas       = canvas;
    this._width        = canvas.width;
    this._height       = canvas.height;
    this._renderTarget = new Uint32Array(this._width * this._height);
    kernel.serialPut('SwiftShader: init ' + this._width + 'x' + this._height + '\n');
  }

  // ── Vulkan instance API ────────────────────────────────────────────────

  /** vkCreateInstance — allocates and returns an opaque instance handle. */
  createVkInstance(): VkInstance {
    this._vkInstance = this._nextHandle++;
    kernel.serialPut('SwiftShader: Vulkan instance created (handle=' + this._vkInstance + ')\n');
    return this._vkInstance;
  }

  /** vkCreateDevice — allocates and returns an opaque logical-device handle. */
  createVkDevice(instance: VkInstance): VkDevice {
    if (instance !== this._vkInstance) {
      kernel.serialPut('SwiftShader: createVkDevice: invalid instance\n');
      return 0;
    }
    this._vkDevice = this._nextHandle++;
    kernel.serialPut('SwiftShader: Vulkan device created (handle=' + this._vkDevice + ')\n');
    return this._vkDevice;
  }

  // ── OpenGL ES 3.1 draw API ─────────────────────────────────────────────

  /**
   * glClearColor + glClear(GL_COLOR_BUFFER_BIT) combined.
   * Fills the entire render target with a solid RGBA colour (0-1 floats).
   */
  glClearColor(r: number, g: number, b: number, a: number): void {
    if (!this._renderTarget) return;
    this._renderTarget.fill(packRGBA(
      Math.min(255, Math.max(0, (r * 255) | 0)),
      Math.min(255, Math.max(0, (g * 255) | 0)),
      Math.min(255, Math.max(0, (b * 255) | 0)),
      Math.min(255, Math.max(0, (a * 255) | 0)),
    ));
  }

  /**
   * Draw a single triangle.
   *
   * Vertices are in Normalised Device Coordinates (−1…+1 on both axes).
   * X=-1 is the left edge; Y=+1 is the top edge (GL convention).
   * Colors are 0…1 floats (r, g, b) per vertex; interpolated linearly.
   *
   * Returns the number of pixels rasterized (≥ 0 on success, 0 on
   * degenerate triangle or uninitialised renderer).
   */
  glDrawTriangle(
    x0: number, y0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, r2: number, g2: number, b2: number,
  ): number {
    if (!this._renderTarget) return 0;
    var w = this._width, h = this._height;
    // NDC → screen space
    var sx = function(ndc: number) { return (ndc + 1) * 0.5 * w; };
    var sy = function(ndc: number) { return (1 - (ndc + 1) * 0.5) * h; };

    return rasterizeTriangle(this._renderTarget, w, h,
      { x: sx(x0), y: sy(y0), r: r0 * 255, g: g0 * 255, b: b0 * 255 },
      { x: sx(x1), y: sy(y1), r: r1 * 255, g: g1 * 255, b: b1 * 255 },
      { x: sx(x2), y: sy(y2), r: r2 * 255, g: g2 * 255, b: b2 * 255 },
    );
  }

  /**
   * Blit a raw BGRA Uint32Array render target into the renderer.
   * Used by the DRM page-flip path: Chromium writes pixels via mmap'd
   * dumb buffers; we copy them here before calling present().
   */
  blitRaw(pixels: Uint32Array, x: number, y: number,
          srcWidth: number, srcHeight: number): void {
    if (!this._renderTarget) return;
    var dstW = this._width;
    for (var row = 0; row < srcHeight; row++) {
      var dstY = y + row;
      if (dstY < 0 || dstY >= this._height) continue;
      for (var col = 0; col < srcWidth; col++) {
        var dstX = x + col;
        if (dstX >= 0 && dstX < dstW) {
          this._renderTarget[dstY * dstW + dstX] = pixels[row * srcWidth + col];
        }
      }
    }
  }

  /**
   * Swap-chain present: copy the render target to the Canvas pixel buffer
   * and call canvas.flip() to push to the physical framebuffer.
   *
   * In production: SwiftShader fills the Uint32Array via mmap and we do a
   * single memcpy here.  In this pure-TS implementation the rasterizer
   * writes directly into the same array, so present() is zero-copy into
   * the canvas.
   */
  present(): void {
    if (!this._canvas || !this._renderTarget) return;
    var dst   = this._canvas.getBuffer();
    var total = this._width * this._height;
    // Direct copy — both arrays use the same 0xAARRGGBB / BGRA encoding.
    for (var i = 0; i < total; i++) dst[i] = this._renderTarget[i];
    this._canvas.flip();
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get isInitialised(): boolean { return this._vkDevice > 0; }
  get width():  number { return this._width;  }
  get height(): number { return this._height; }
  get vkInstance(): VkInstance { return this._vkInstance; }
  get vkDevice():   VkDevice   { return this._vkDevice;   }
}

/** Process-global singleton, wired to the screen canvas at Phase 8 boot. */
export const swiftShader = new SwiftShaderBackend();
