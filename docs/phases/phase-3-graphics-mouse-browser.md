# Phase 3 — Pixel Graphics, Mouse & First Browser

## Goal

Replace VGA text mode with a pixel framebuffer. Add mouse input. Run a real
HTML/CSS browser (NetSurf) as the first windowed application, alongside the
always-resident terminal and REPL.

**The C Code Rule applied here:** Window layout, event dispatch, all rendering
decisions, and application logic are TypeScript. C adds exactly three new
primitives: framebuffer blit, framebuffer info, and mouse packet read.

---

## Prerequisites

- Phase 1 complete (REPL, VFS, process management)
- Phase 2 complete (disk storage — NetSurf caches pages to disk)

---

## 3a — VESA/GOP Framebuffer (C)

### Multiboot2 Graphics Mode Request

Switch from multiboot1 to multiboot2 header. Add a `MULTIBOOT_TAG_TYPE_FRAMEBUFFER`
tag requesting a pixel graphics mode. GRUB then populates the `framebuffer` tag
in the boot information structure with physical address, dimensions, and
bits-per-pixel.

```c
// Multiboot2 header tag in boot.s:
.align 8
framebuffer_tag:
  .short MULTIBOOT_HEADER_TAG_FRAMEBUFFER
  .short 0
  .long 20
  .long 1024    // preferred width
  .long 768     // preferred height
  .long 32      // preferred bpp (0 = any)
```

GRUB negotiates with BIOS/UEFI and sets the best available mode. May be lower
than requested on some hardware — code must handle any width/height/bpp.

### New C Functions (platform.c)

```c
// platform.h additions:
typedef struct {
  uint32_t *address;    // physical framebuffer address (mapped identity)
  uint32_t  width;
  uint32_t  height;
  uint32_t  pitch;      // bytes per row
  uint8_t   bpp;        // bits per pixel (usually 32)
} fb_info_t;

void platform_fb_init(struct multiboot_tag_framebuffer *tag);
void platform_fb_get_info(fb_info_t *out);
void platform_fb_blit(uint32_t *src, int x, int y, int w, int h);
// src: BGRA pixel array of size w*h
```

`platform_fb_blit` is the only C function that touches the framebuffer.
All pixel data is assembled in TypeScript and passed in as an array.

### New QuickJS Bindings

```c
// In quickjs_binding.c:
kernel.fbInfo()
// → { width: number, height: number, pitch: number, bpp: number }
// Returns null if no framebuffer (serial/VGA fallback mode)

kernel.fbBlit(pixels: number[], x: number, y: number, w: number, h: number)
// pixels: flat BGRA array, length must equal w * h * 4
// Copies pixels to the physical framebuffer at (x, y)
```

**C does not decide what gets drawn. C only performs the memory copy.**

### Fallback

If GRUB reports no framebuffer (old BIOS, text-only boot), `kernel.fbInfo()`
returns `null`. The terminal then falls back to the VGA text driver from Phase 1.
The REPL always works regardless.

---

## 3b — Canvas API (TypeScript — src/os/ui/canvas.ts)

All rendering logic is in TypeScript. The Canvas class maintains a 32-bit BGRA
pixel buffer in a TypeScript `Uint32Array`. `flip()` passes it to `kernel.fbBlit`.

```typescript
type Color = number  // 0xAARRGGBB

class Canvas {
  readonly width: number
  readonly height: number
  private buffer: Uint32Array

  constructor(width: number, height: number)

  // Drawing primitives
  clear(color?: Color): void
  fillRect(x: number, y: number, w: number, h: number, color: Color): void
  drawRect(x: number, y: number, w: number, h: number, color: Color): void
  drawLine(x0: number, y0: number, x1: number, y1: number, color: Color): void
  drawCircle(cx: number, cy: number, r: number, color: Color): void
  fillCircle(cx: number, cy: number, r: number, color: Color): void

  // Text rendering
  drawText(x: number, y: number, text: string, font: BitmapFont, color: Color): void
  measureText(text: string, font: BitmapFont): { width: number; height: number }

  // Image compositing
  blit(src: Canvas, sx: number, sy: number, dx: number, dy: number,
       w: number, h: number, alpha?: boolean): void
  blitScaled(src: Canvas, dx: number, dy: number, dw: number, dh: number): void

  // Pixel access
  getPixel(x: number, y: number): Color
  setPixel(x: number, y: number, color: Color): void

  // Output
  flip(): void   // double-buffer: sends buffer to kernel.fbBlit
  flipRegion(x: number, y: number, w: number, h: number): void  // partial update
}
```

### BitmapFont

Embedded 8×16 PC bitmap font (VGA BIOS font, public domain, ~4 KB as a
TypeScript data array). Each character is 16 bytes, one bit per pixel.

```typescript
class BitmapFont {
  static readonly DEFAULT: BitmapFont    // 8×16 VGA font
  static readonly SMALL:   BitmapFont    // 6×10 compact variant

  readonly charWidth: number
  readonly charHeight: number

  render(canvas: Canvas, x: number, y: number, ch: string, color: Color): void
}
```

No TrueType/FreeType in Phase 3. Bitmap fonts only (Phase 9 may add FreeType
from lib/ for the browser chrome).

---

## 3c — PS/2 Mouse Driver (C)

IRQ12 accumulates 3-byte PS/2 packets. C decodes relative motion and button
state into a small struct exposed via one binding.

```c
// mouse.c (new file, or added to keyboard.c):
typedef struct {
  int8_t  dx, dy;    // signed relative motion this packet
  uint8_t buttons;   // bit 0=left, 1=right, 2=middle
} mouse_packet_t;

// Circular buffer of decoded packets:
void mouse_irq_handler(void);         // called by IRQ12

// New QuickJS binding:
kernel.readMouse()
// → { dx: number, dy: number, buttons: number } | null
// Returns null when queue is empty
```

**All cursor management in TypeScript:**
- Absolute position accumulated from dx/dy in the WM
- Cursor clamped to screen bounds by TypeScript
- Cursor sprite rendered by Canvas into the WM composite
- Click/drag/hover state maintained by TypeScript event system

---

## 3d — Window Manager (TypeScript — src/os/ui/wm.ts)

All layout, z-order, event routing, drag, resize, and compositing in TypeScript.
WM polls `kernel.readKey()` and `kernel.readMouse()` once per frame, dispatches
events to focused/hovered windows, and re-composites the scene.

```typescript
interface App {
  readonly name: string
  onMount(window: Window): void
  onUnmount(): void
  onKey(event: KeyEvent): void
  onMouse(event: MouseEvent): void
  render(canvas: Canvas): void
}

interface Window {
  id: number
  title: string
  x: number; y: number
  width: number; height: number
  canvas: Canvas          // sub-canvas for this window's content
  minimised: boolean
  maximised: boolean
  closeable: boolean
}

class WindowManager {
  // Lifecycle
  createWindow(opts: {
    title: string; x?: number; y?: number
    width: number; height: number
    app: App
    closeable?: boolean     // default true
  }): Window

  focusWindow(id: number): void
  closeWindow(id: number): void
  minimiseWindow(id: number): void
  maximiseWindow(id: number): void

  // Per-frame
  tick(): void        // poll input → dispatch events → composite → flip

  // Query
  getWindows(): Window[]
  getFocused(): Window | null
}
```

### Desktop Composition

Each frame:
1. Draw desktop background (solid colour or wallpaper Canvas)
2. Draw all windows bottom-to-top (z-order stack)
3. Draw window title bars (WM-drawn chrome)
4. Draw taskbar across bottom
5. Draw mouse cursor sprite at absolute position
6. Call `screen.flip()` once

### Taskbar

- Fixed 24px bar at bottom of screen
- One button per open window; click focuses/restores
- Clock on right reading `kernel.getTicks()` converted to HH:MM
- "JSOS" start button on left (future: app launcher)

---

## 3e — Terminal as Windowed App

`terminal.ts` and `repl.ts` remain unchanged in logic. A thin adapter wraps
them as an `App` implementation, routing keyboard events and rendering to their
window's sub-Canvas instead of the VGA framebuffer.

```typescript
class TerminalApp implements App {
  private term: Terminal
  private repl: REPL

  onMount(win: Window): void {
    this.term = new Terminal(win.canvas)
    this.repl = new REPL(this.term)
    this.repl.start()
  }

  onKey(e: KeyEvent): void {
    this.repl.handleKey(e.scancode)
  }

  render(canvas: Canvas): void {
    // terminal already renders directly to win.canvas — no-op here
  }
}
```

**The terminal app is always resident.** It cannot be fully closed — only
minimised. It is the OS escape hatch. This is enforced in WM:

```typescript
// wm.ts
if (window.app instanceof TerminalApp) {
  window.closeable = false   // close button disabled
}
```

---

## 3f — NetSurf Browser (lib/netsurf/)

NetSurf is a third-party HTML/CSS rendering library. It lives in `lib/` and is
**not part of JSOS** — it is compiled separately and linked as a static archive.

### Library Layout

```
lib/
  netsurf/
    hubbub/             HTML5 parser (C)
    libcss/             CSS2.1 + partial CSS3 parser and cascade (C)
    libdom/             DOM Level 1-3 implementation (C)
    libparserutils/     shared parsing utilities used by hubbub + libcss (C)
    libnsfb/            NetSurf framebuffer abstraction (C)
    nsfb-jsos/          OUR adapter: libnsfb backend → TypeScript Canvas (C+TS)
```

### JSOS libnsfb Backend (nsfb-jsos/)

This is the ONLY code we write in the netsurf tree — an libnsfb backend that
translates NetSurf's blit/plot calls into `kernel.fbBlit` calls.

```c
// nsfb-jsos/jsos_surface.c
static bool jsos_initialise(libnsfb_t *fb) {
  // tells NetSurf our screen dimensions from kernel.fbInfo()
}

static bool jsos_finalise(libnsfb_t *fb) { }

static bool jsos_blit(libnsfb_t *fb, libnsfb_update_t *rect, ...) {
  // calls platform_fb_blit() with the updated pixel region
}
```

### JavaScript Execution Inside Web Pages

NetSurf's JS engine is normally disabled or uses SpiderMonkey. We configure it
to call through to QuickJS via a bridge so web page scripts run in the same
runtime as the OS.

### TypeScript Browser App (src/os/apps/browser.ts)

```typescript
class BrowserApp implements App {
  private url: string = 'about:blank'
  private history: string[] = []

  navigate(url: string): void
  back(): void; forward(): void
  reload(): void

  onKey(e: KeyEvent): void   // routes to URL bar or page
  render(canvas: Canvas): void
}
```

Address bar, back/forward buttons, and loading indicator are drawn by
our TypeScript Canvas — not by NetSurf.

---

## 3g — Memory Increase

Increase the static heap in `linker.ld` from 8 MB to 64 MB.

```ld
/* linker.ld — Phase 3 */
_heap_size = 64M;   /* was 8M */
```

This is temporary. Phase 4 replaces the static heap with a real physical page
allocator that uses all RAM reported by GRUB. 64 MB is enough for:
- QuickJS TypeScript runtime: ~2 MB
- WM compositor buffers (1024×768×4 × 2): ~6 MB
- NetSurf rendering: ~20 MB
- Browser page cache: ~10 MB
- System headroom: ~26 MB

---

## New C Primitives Summary

| Binding | File | Description |
|---|---|---|
| `kernel.fbInfo()` | `platform.c` | Framebuffer dimensions/address from multiboot |
| `kernel.fbBlit(px, x, y, w, h)` | `platform.c` | Copy pixel data to framebuffer |
| `kernel.readMouse()` | `mouse.c` | Next PS/2 mouse packet or null |

---

## New TypeScript Files

| File | Description |
|---|---|
| `src/os/ui/canvas.ts` | Canvas class + BitmapFont |
| `src/os/ui/wm.ts` | Window Manager |
| `src/os/apps/browser.ts` | NetSurf browser app wrapper |
| `src/os/apps/terminal-app.ts` | Terminal/REPL wrapped as WM App |

---

## Third-Party Libraries Added

| Library | Location | Purpose |
|---|---|---|
| NetSurf + hubbub + libcss + libdom | `lib/netsurf/` | HTML/CSS rendering |
| libnsfb + jsos backend | `lib/netsurf/nsfb-jsos/` | Framebuffer bridge |

---

## Build Changes

- Switch to multiboot2 header
- Add `-DPHASE3` compile flag to enable framebuffer init path
- `Makefile` gains netsurf static lib target
- `bundle-*.js` unchanged — TypeScript build is unaffected
- `linker.ld`: heap 8M → 64M

---

## Test Oracle

Serial log after Phase 3 boot:

```
[SERIAL] Framebuffer: 1024x768x32 at 0xFD000000
[SERIAL] Window manager started
[SERIAL] Terminal app launched
[SERIAL] REPL ready (windowed mode)
```

VGA text fallback (no framebuffer):

```
[SERIAL] No framebuffer — falling back to VGA text
[SERIAL] REPL ready (text mode)
```

---

## What Phase 3 Does NOT Do

- ❌ No hardware-accelerated rendering (SwiftShader — Phase 8)
- ❌ No TrueType fonts (bitmap only)
- ❌ No multi-process isolation (NetSurf runs in kernel address space)
- ❌ No real HTTPS (TLS — Phase 7)
- ❌ No video / WebGL in the browser
