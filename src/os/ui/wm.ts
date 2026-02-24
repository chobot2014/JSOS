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
import { threadManager } from '../process/threads.js';

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
  /** Render into canvas.  Return true if anything was redrawn, false to skip composite. */
  render(canvas: Canvas): boolean;
  /** Called when this window becomes the focused (active) window. */
  onFocus?(): void;
  /** Called when this window loses focus. */
  onBlur?(): void;
  /** Called when the window content area is resized. */
  onResize?(width: number, height: number): void;
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

  // Dirty tracking — skip composite+flip when nothing has changed
  private _wmDirty     = true;   // set on cursor move, input, drag, clock change
  private _lastClockMin = -1;    // track minute for clock redraw

  // Drag state
  private _dragging: number | null = null;
  private _dragOffX = 0;
  private _dragOffY = 0;
  // Mouse capture — app window that receives all events while button is held
  private _mouseCapture: number | null = null;
  private _clipboard: string = '';

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
    if (opts.app.onFocus) opts.app.onFocus();
    return win;
  }

  focusWindow(id: number): void {
    if (this._focused === id) return;
    var prevId = this._focused;
    for (var i = 0; i < this._windows.length; i++) {
      if (this._windows[i].id === id) {
        // Notify old focused app
        if (prevId !== null) {
          var prev = this._findWindow(prevId);
          if (prev && prev.app.onBlur) prev.app.onBlur();
        }
        this._focused = id;
        // Move to top of stack
        var win = this._windows.splice(i, 1)[0];
        this._windows.push(win);
        if (win.app.onFocus) win.app.onFocus();
        this._wmDirty = true;
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

  // ── Clipboard ──────────────────────────────────────────────────────────

  getClipboard(): string { return this._clipboard; }
  setClipboard(text: string): void { this._clipboard = text; this._wmDirty = true; }

  // ── Query ──────────────────────────────────────────────────────────────

  getWindows(): WMWindow[] { return this._windows.slice(); }

  getFocused(): WMWindow | null {
    if (this._focused === null) return null;
    return this._findWindow(this._focused) || null;
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────

  tick(): void {
    this._pollInput();
    this._tickChildProcs();
    threadManager.tickCoroutines();
    this._composite();
  }
  /** Mark the WM as needing a repaint (call from app code or external events). */
  markDirty(): void { this._wmDirty = true; }

  /**
   * Pump every live child JS process each frame.
   * This drives Promise/async resolution and fires onMessage callbacks
   * without any user code needing to manually call p.tick().
   * Cost is negligible when no processes are running (empty procList).
   */
  private _tickChildProcs(): void {
    var list = kernel.procList();
    for (var i = 0; i < list.length; i++) {
      kernel.procTick(list[i].id);
    }
  }
  // ── Input dispatch ─────────────────────────────────────────────────────

  private _pollInput(): void {
    // Drain mouse queue
    for (var i = 0; i < 8; i++) {
      var pkt = kernel.readMouse();
      if (!pkt) break;
      var prevX = this._cursorX;
      var prevY = this._cursorY;
      this._cursorX = Math.max(0, Math.min(this._screen.width  - 1, this._cursorX + pkt.dx));
      this._cursorY = Math.max(0, Math.min(this._screen.height - 1, this._cursorY + pkt.dy));
      if (this._cursorX !== prevX || this._cursorY !== prevY) this._wmDirty = true;

      var btn1     = pkt.buttons & 1;
      var prevBtn1 = this._prevButtons & 1;

      // ── Title bar drag ────────────────────────────────────────────────────
      if (pkt.buttons & 1) {
        if (this._dragging !== null) {
          var dw = this._findWindow(this._dragging);
          if (dw) {
            dw.x = this._cursorX - this._dragOffX;
            dw.y = this._cursorY - this._dragOffY;
            this._wmDirty = true;
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
                this._wmDirty = true;
              }
              break;
            }
          }
        }
      } else {
        this._dragging = null;
      }

      // ── Dispatch mouse events to app content area ─────────────────────────
      if (this._dragging === null) {
        // Find topmost non-minimised window whose content area is under cursor
        var hitWin: WMWindow | null = null;
        for (var hj = this._windows.length - 1; hj >= 0; hj--) {
          var hw = this._windows[hj];
          if (hw.minimised) continue;
          if (this._cursorX >= hw.x && this._cursorX < hw.x + hw.width &&
              this._cursorY >= hw.y + TITLE_H && this._cursorY < hw.y + hw.height) {
            hitWin = hw; break;
          }
        }

        // Button down in content area: focus window + start capture
        if (btn1 && !prevBtn1 && hitWin) {
          this._mouseCapture = hitWin.id;
          this.focusWindow(hitWin.id);
        }

        // Determine dispatch target: captured window, or window under cursor
        var dispWin: WMWindow | null = hitWin;
        if (this._mouseCapture !== null) {
          var cw = this._findWindow(this._mouseCapture);
          if (cw) dispWin = cw;
        }

        // Release capture after recording dispatch target
        if (!btn1 && prevBtn1) {
          this._mouseCapture = null;
        }

        if (dispWin) {
          var evType: 'move' | 'down' | 'up';
          if      (btn1 && !prevBtn1)  evType = 'down';
          else if (!btn1 && prevBtn1)  evType = 'up';
          else                         evType = 'move';
          dispWin.app.onMouse({
            x:       this._cursorX - dispWin.x,
            y:       this._cursorY - (dispWin.y + TITLE_H),
            dx:      this._cursorX - prevX,
            dy:      this._cursorY - prevY,
            buttons: pkt.buttons,
            type:    evType,
          });
          // For move events the app's render() return value signals dirty;
          // only force a WM composite on discrete button state changes.
          if (evType !== 'move') this._wmDirty = true;
        }
      } else {
        this._mouseCapture = null;   // dragging window — cancel any app capture
      }

      this._prevButtons = pkt.buttons;
    }

    // Drain keyboard to focused window (readKeyEx checks ext keys + chars)
    for (var k = 0; k < 32; k++) {
      var kev = kernel.readKeyEx();
      if (!kev) break;
      var focused = this.getFocused();
      if (focused) {
        focused.app.onKey(kev);
        this._wmDirty = true;
      }
    }

    // Drain virtio-net RX ring — keep the TCP/IP stack ticking every frame.
    net.pollNIC();
  }

  // ── Compositing ────────────────────────────────────────────────────────

  private _composite(): void {
    var s = this._screen;

    // Check clock — dirty on minute boundary
    var ticks = kernel.getTicks();
    var mins = Math.floor(ticks / 6000) % 60;
    if (mins !== this._lastClockMin) { this._lastClockMin = mins; this._wmDirty = true; }

    // Let apps render; if any redrew OR WM has pending changes, do a full composite.
    var anyDirty = this._wmDirty;
    for (var ai = 0; ai < this._windows.length; ai++) {
      var wi = this._windows[ai];
      if (!wi.minimised && wi.app.render(wi.canvas)) anyDirty = true;
    }

    if (!anyDirty) return;   // ★ nothing changed — skip expensive composite+flip
    this._wmDirty = false;

    // 1. Desktop background
    s.clear(Colors.DESKTOP_BG);

    // 2. Draw windows bottom-to-top
    for (var i = 0; i < this._windows.length; i++) {
      var win = this._windows[i];
      if (win.minimised) continue;

      var focused = (win.id === this._focused);

      // Let app render into its sub-canvas (already called above for dirty check)
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
export function getWM(): WindowManager {
  if (!wm) throw new Error('WindowManager not yet initialised');
  return wm;
}
