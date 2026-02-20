/**
 * JSOS Window Manager — Phase 3
 *
 * All window layout, z-order, event routing, drag, resize, and compositing
 * are in TypeScript.  The WM polls kernel.readKey() and kernel.readMouse()
 * once per frame, dispatches events to focused/hovered windows, and
 * re-composites the scene via the Canvas API.
 *
 * Architecture:
 *   WM owns the screen Canvas (1024×768 or actual framebuffer dimensions).
 *   Each window owns a sub-Canvas for its content area.
 *   Each frame: clear desktop → draw windows → draw taskbar → draw cursor → flip screen.
 */

import { Canvas, Colors, defaultFont, createScreenCanvas, type PixelColor } from './canvas.js';
import { net } from '../net/net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Event types ────────────────────────────────────────────────────────────

export interface KeyEvent {
  ch: string;
  ext: number;  /* non-zero for special keys (KEY_UP etc.) */
}

export interface MouseEvent {
  x: number;
  y: number;
  dx: number;
  dy: number;
  buttons: number;
  type: 'move' | 'down' | 'up' | 'click';
}

// ── App interface ──────────────────────────────────────────────────────────

export interface App {
  readonly name: string;
  onMount(win: WMWindow): void;
  onUnmount(): void;
  onKey(event: KeyEvent): void;
  onMouse(event: MouseEvent): void;
  render(canvas: Canvas): void;
}

// ── Window ─────────────────────────────────────────────────────────────────

export interface WMWindow {
  id: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  canvas: Canvas;
  minimised: boolean;
  maximised: boolean;
  closeable: boolean;
  app: App;
}

// ── Cursor sprite (8×8 arrow) ─────────────────────────────────────────────

const CURSOR_W = 11;
const CURSOR_H = 19;
const CURSOR_PIXELS: number[] = [
  // 0=transparent, 1=black, 2=white
  1,0,0,0,0,0,0,0,0,0,0,
  1,1,0,0,0,0,0,0,0,0,0,
  1,2,1,0,0,0,0,0,0,0,0,
  1,2,2,1,0,0,0,0,0,0,0,
  1,2,2,2,1,0,0,0,0,0,0,
  1,2,2,2,2,1,0,0,0,0,0,
  1,2,2,2,2,2,1,0,0,0,0,
  1,2,2,2,2,2,2,1,0,0,0,
  1,2,2,2,2,2,2,2,1,0,0,
  1,2,2,2,2,2,2,2,2,1,0,
  1,2,2,2,2,2,2,2,2,2,1,
  1,2,2,2,2,2,2,1,1,1,1,
  1,2,2,2,1,2,2,1,0,0,0,
  1,2,2,1,0,1,2,2,1,0,0,
  1,2,1,0,0,1,2,2,1,0,0,
  1,1,0,0,0,0,1,2,2,1,0,
  0,0,0,0,0,0,1,2,2,1,0,
  0,0,0,0,0,0,0,1,1,0,0,
  0,0,0,0,0,0,0,0,0,0,0,
];

// ── WindowManager ─────────────────────────────────────────────────────────

const TITLE_H     = 22;   /* pixels — title bar height */
const TASKBAR_H   = 28;   /* pixels — taskbar height   */
const MIN_WIN_W   = 120;
const MIN_WIN_H   = 80;
const TITLE_COLOR = Colors.TITLE_BG;
const FOCUSED_TITLE_COLOR = 0xFF2A5F8F;

export class WindowManager {
  private _screen:  Canvas;
  private _windows: WMWindow[] = [];
  private _focused: number | null = null;
  private _nextId   = 1;

  private _cursorX = 0;
  private _cursorY = 0;
  private _prevButtons = 0;

  // Drag state
  private _dragging: number | null = null;
  private _dragOffX = 0;
  private _dragOffY = 0;

  constructor(screen: Canvas) {
    this._screen  = screen;
    this._cursorX = screen.width  >> 1;
    this._cursorY = screen.height >> 1;
  }

  get screenWidth():  number { return this._screen.width;  }
  get screenHeight(): number { return this._screen.height; }

  // ── Window lifecycle ───────────────────────────────────────────────────

  createWindow(opts: {
    title: string;
    x?: number;
    y?: number;
    width: number;
    height: number;
    app: App;
    closeable?: boolean;
  }): WMWindow {
    var contentH = opts.height;
    var winX = (opts.x !== undefined) ? opts.x : (this._screen.width  - opts.width)  >> 1;
    var winY = (opts.y !== undefined) ? opts.y : (this._screen.height - opts.height - TASKBAR_H) >> 1;

    var win: WMWindow = {
      id:        this._nextId++,
      title:     opts.title,
      x:         winX,
      y:         winY,
      width:     opts.width,
      height:    contentH + TITLE_H,
      canvas:    new Canvas(opts.width, contentH),
      minimised: false,
      maximised: false,
      closeable: (opts.closeable !== false),
      app:       opts.app,
    };

    this._windows.push(win);
    this._focused = win.id;
    opts.app.onMount(win);
    return win;
  }

  focusWindow(id: number): void {
    for (var i = 0; i < this._windows.length; i++) {
      if (this._windows[i].id === id) {
        this._focused = id;
        // Move to top of stack
        var win = this._windows.splice(i, 1)[0];
        this._windows.push(win);
        return;
      }
    }
  }

  closeWindow(id: number): void {
    for (var i = 0; i < this._windows.length; i++) {
      var win = this._windows[i];
      if (win.id === id) {
        win.app.onUnmount();
        this._windows.splice(i, 1);
        if (this._focused === id) {
          this._focused = this._windows.length > 0
            ? this._windows[this._windows.length - 1].id
            : null;
        }
        return;
      }
    }
  }

  minimiseWindow(id: number): void {
    var win = this._findWindow(id);
    if (win) win.minimised = true;
  }

  // ── Query ──────────────────────────────────────────────────────────────

  getWindows(): WMWindow[] { return this._windows.slice(); }

  getFocused(): WMWindow | null {
    if (this._focused === null) return null;
    return this._findWindow(this._focused) || null;
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────

  tick(): void {
    this._pollInput();
    this._composite();
  }

  // ── Input dispatch ─────────────────────────────────────────────────────

  private _pollInput(): void {
    // Drain mouse queue
    for (var i = 0; i < 8; i++) {
      var pkt = kernel.readMouse();
      if (!pkt) break;
      this._cursorX = Math.max(0, Math.min(this._screen.width  - 1, this._cursorX + pkt.dx));
      this._cursorY = Math.max(0, Math.min(this._screen.height - 1, this._cursorY + pkt.dy));

      // Handle drag
      if (pkt.buttons & 1) {
        if (this._dragging !== null) {
          var dw = this._findWindow(this._dragging);
          if (dw) {
            dw.x = this._cursorX - this._dragOffX;
            dw.y = this._cursorY - this._dragOffY;
          }
        } else if (!(this._prevButtons & 1)) {
          // Mouse down — check title bar hit
          for (var j = this._windows.length - 1; j >= 0; j--) {
            var w = this._windows[j];
            if (w.minimised) continue;
            if (this._cursorX >= w.x && this._cursorX < w.x + w.width &&
                this._cursorY >= w.y && this._cursorY < w.y + TITLE_H) {
              this.focusWindow(w.id);
              // Close button
              if (w.closeable &&
                  this._cursorX >= w.x + w.width - 18 &&
                  this._cursorX <= w.x + w.width - 4 &&
                  this._cursorY >= w.y + 4 &&
                  this._cursorY <= w.y + TITLE_H - 4) {
                this.closeWindow(w.id);
              } else {
                this._dragging = w.id;
                this._dragOffX = this._cursorX - w.x;
                this._dragOffY = this._cursorY - w.y;
              }
              break;
            }
          }
        }
      } else {
        this._dragging = null;
      }

      this._prevButtons = pkt.buttons;
    }

    // Drain keyboard to focused window
    for (var k = 0; k < 32; k++) {
      var ch = kernel.readKey();
      if (!ch) break;
      var focused = this.getFocused();
      if (focused) {
        focused.app.onKey({ ch: ch, ext: 0 });
      }
    }

    // Drain virtio-net RX ring — keep the TCP/IP stack ticking every frame.
    net.pollNIC();
  }

  // ── Compositing ────────────────────────────────────────────────────────

  private _composite(): void {
    var s = this._screen;

    // 1. Desktop background
    s.clear(Colors.DESKTOP_BG);

    // 2. Draw windows bottom-to-top
    for (var i = 0; i < this._windows.length; i++) {
      var win = this._windows[i];
      if (win.minimised) continue;

      var focused = (win.id === this._focused);

      // Let app render into its sub-canvas
      win.app.render(win.canvas);

      // Title bar
      s.fillRect(win.x, win.y, win.width, TITLE_H,
                 focused ? FOCUSED_TITLE_COLOR : TITLE_COLOR);
      s.drawText(win.x + 6, win.y + 5, win.title, Colors.WHITE);

      // Close button
      if (win.closeable) {
        s.fillRect(win.x + win.width - 18, win.y + 4, 14, TITLE_H - 8, 0xFFCC3333);
        s.drawText(win.x + win.width - 14, win.y + 6, 'X', Colors.WHITE);
      }

      // Content area shadow
      s.fillRect(win.x, win.y + TITLE_H, win.width, win.height - TITLE_H, 0xFF111111);

      // Blit window content canvas onto screen
      var contentH = win.height - TITLE_H;
      s.blit(win.canvas, 0, 0, win.x, win.y + TITLE_H, win.width, contentH);

      // Window border
      s.drawRect(win.x, win.y, win.width, win.height,
                 focused ? 0xFF5599CC : 0xFF445566);
    }

    // 3. Taskbar
    this._drawTaskbar();

    // 4. Mouse cursor
    this._drawCursor();

    // 5. Flip to framebuffer
    s.flip();
  }

  private _drawTaskbar(): void {
    var s = this._screen;
    var barY = s.height - TASKBAR_H;

    s.fillRect(0, barY, s.width, TASKBAR_H, Colors.TASKBAR_BG);
    s.drawLine(0, barY, s.width, barY, 0xFF334455);

    // "JSOS" start button
    s.fillRect(2, barY + 3, 50, TASKBAR_H - 6, Colors.DARK_BLUE);
    s.drawRect(2, barY + 3, 50, TASKBAR_H - 6, 0xFF5577AA);
    s.drawText(8, barY + 9, 'JSOS', Colors.WHITE);

    // Window buttons
    var btnX = 58;
    for (var i = 0; i < this._windows.length; i++) {
      var win = this._windows[i];
      var active = (win.id === this._focused && !win.minimised);
      s.fillRect(btnX, barY + 3, 90, TASKBAR_H - 6,
                 active ? 0xFF2255AA : 0xFF223344);
      s.drawRect(btnX, barY + 3, 90, TASKBAR_H - 6, 0xFF445566);
      // Truncate long window titles
      var title = win.title.length > 10 ? win.title.substring(0, 10) + '…' : win.title;
      s.drawText(btnX + 4, barY + 9, title, Colors.WHITE);
      btnX += 95;
    }

    // Clock (ticks-based): crude HH:MM
    var ticks = kernel.getTicks();
    var totalSecs = Math.floor(ticks / 100);
    var mins = Math.floor(totalSecs / 60) % 60;
    var hours = Math.floor(totalSecs / 3600) % 24;
    var hh = (hours < 10 ? '0' : '') + hours;
    var mm = (mins  < 10 ? '0' : '') + mins;
    s.drawText(s.width - 50, barY + 9, hh + ':' + mm, Colors.LIGHT_GREY);
  }

  private _drawCursor(): void {
    for (var row = 0; row < CURSOR_H; row++) {
      for (var col = 0; col < CURSOR_W; col++) {
        var v = CURSOR_PIXELS[row * CURSOR_W + col];
        if (v === 0) continue;
        var color = v === 1 ? Colors.BLACK : Colors.WHITE;
        this._screen.setPixel(this._cursorX + col, this._cursorY + row, color);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private _findWindow(id: number): WMWindow | undefined {
    for (var i = 0; i < this._windows.length; i++) {
      if (this._windows[i].id === id) return this._windows[i];
    }
    return undefined;
  }
}

/** Singleton WM instance — created by main.ts after framebuffer detection. */
export let wm: WindowManager | null = null;
export function setWM(instance: WindowManager): void { wm = instance; }
