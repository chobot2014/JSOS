/**
 * JSOS Chromium App — Phase 9
 *
 * WM application wrapper for the Chromium browser.
 * Displays a "Chromium Loading…" splash screen in the WM window while
 * exec() prepares the ring-3 ELF process.  Once the DRM/Ozone backend is
 * active it renders directly via SwiftShader page-flip, bypassing this app.
 */

import { Canvas, Colors, defaultFont } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Internal state ────────────────────────────────────────────────────────

const SPINNER = ['|', '/', '-', '\\'];

let _win: WMWindow | null = null;
let _tick = 0;
let _launched = false;

// ── Splash renderer ───────────────────────────────────────────────────────

function drawSplash(canvas: Canvas): void {
  var w  = canvas.width;
  var h  = canvas.height;
  var cx = Math.floor(w / 2);
  var cy = Math.floor(h / 2);

  // Chrome-ish dark background
  canvas.clear(0xFF202124);

  // Chromium logo placeholder — three coloured horizontal stripes
  var barW = Math.min(160, Math.floor(w * 2 / 3));
  var barH = 10;
  var bx   = cx - Math.floor(barW / 2);
  canvas.fillRect(bx, cy - 40,               barW, barH, 0xFFDB4437); // red
  canvas.fillRect(bx, cy - 40 + barH,        barW, barH, 0xFF0F9D58); // green
  canvas.fillRect(bx, cy - 40 + barH * 2,    barW, barH, 0xFF4285F4); // blue
  canvas.fillRect(bx, cy - 40 + barH * 3,    barW, barH, 0xFFFBBC05); // yellow

  // Spinner
  var sp = SPINNER[(_tick >> 3) & 3];
  canvas.drawText(cx - 4, cy + 10, sp, Colors.WHITE, defaultFont);

  // Loading text
  var dotsN = ((_tick >> 3) & 3);
  var dots  = '.'.repeat(dotsN + 1);
  canvas.drawText(cx - 60, cy + 26, 'Chromium loading' + dots, Colors.LIGHT_GREY, defaultFont);
  canvas.drawText(cx - 72, cy + 42, 'ELF / ring-3 / Ozone/JSOS', Colors.DARK_GREY, defaultFont);
}

// ── App implementation ────────────────────────────────────────────────────

export const chromiumApp: App = {
  name: 'Chromium',

  onMount(win: WMWindow): void {
    _win      = win;
    _tick     = 0;
    _launched = false;
    drawSplash(win.canvas);
    kernel.serialPut('ChromiumApp: mounted — splash displayed\n');
  },

  onUnmount(): void {
    _win      = null;
    _launched = false;
    kernel.serialPut('ChromiumApp: unmounted\n');
  },

  onKey(_event: KeyEvent): void {
    // Key events before launch are swallowed; Ozone polls directly after exec.
  },

  onMouse(_event: MouseEvent): void {
    // Mouse events before launch are swallowed; Ozone polls directly after exec.
  },

  render(canvas: Canvas): void {
    if (_launched) return;   // Ozone/DRM owns the framebuffer — hands off
    _tick++;
    // Animate every 8 frames (~15 fps at 100 Hz PIT).
    if ((_tick & 7) === 0) drawSplash(canvas);
  },
};

/**
 * Signal the app that exec() has successfully transferred to ring-3.
 * Called by main.ts after syscalls.exec() returns (or is about to iret).
 */
export function chromiumLaunched(): void {
  _launched = true;
  kernel.serialPut('ChromiumApp: ELF exec active — DRM/Ozone owns canvas\n');
}
