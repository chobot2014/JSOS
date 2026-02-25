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
import { scheduler } from '../process/scheduler.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Event types ────────────────────────────────────────────────────────────

export interface KeyEvent {
  /** Raw character from kernel (printable or control char, '' for ext keys). */
  ch: string;
  /** Non-zero numeric code for special/extended keys (use `key` for portable apps). */
  ext: number;
  /** DOM-style key name: 'ArrowUp', 'Enter', 'Backspace', 'a', 'A', 'F1' …
   *  Ctrl+letter gives key='A'–'Z' with ctrl=true. */
  key: string;
  /** Always 'down' — this platform only reports key-down events. */
  type: 'down';
  /** True for Ctrl+A–Z codes (\x01–\x1a, excluding Tab/Enter/Backspace/Esc). */
  ctrl: boolean;
  /** Not provided by this hardware; always false. */
  shift: boolean;
  /** Not provided by this hardware; always false. */
  alt: boolean;
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
  /** Alpha 0–255. 255 = fully opaque (default). 0 = hidden. */
  opacity: number;
  app: App;
}

/** Context menu item. */
export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
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

const TITLE_H     = 22;   /* pixels — title bar height    */
const TASKBAR_H   = 28;   /* pixels — taskbar height      */
const RESIZE_GRIP = 10;   /* pixels — resize corner area  */
const MIN_WIN_W   = 160;
const MIN_WIN_H   = 80;
const BTN_W       = 14;   /* title bar button width        */
const BTN_M       = 2;    /* margin between buttons        */
const TITLE_COLOR         = Colors.TITLE_BG;
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

  // Title-bar drag
  private _dragging: number | null = null;
  private _dragOffX = 0;
  private _dragOffY = 0;

  // Resize drag (bottom-right corner grip)
  private _resizing:    number | null = null;
  private _resizeStartX = 0;
  private _resizeStartY = 0;
  private _resizeStartW = 0;
  private _resizeStartH = 0;

  // Saved sizes for maximise/restore
  private _savedSizes = new Map<number, { x: number; y: number; w: number; h: number }>();

  // Mouse capture — app window that receives all events while button is held
  private _mouseCapture: number | null = null;
  private _clipboard: string = '';

  // Cursor shape
  private _cursorShape: string = 'default';

  // Modal: id of the topmost modal window (null = no modal active)
  private _modalWinId: number | null = null;

  // Context menu state
  private _contextMenu: { x: number; y: number; items: MenuItem[] } | null = null;

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
      opacity:   255,
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
        if (this._focused    === id) {
          this._focused = this._windows.length > 0
            ? this._windows[this._windows.length - 1].id
            : null;
        }
        if (this._mouseCapture === id) this._mouseCapture = null;
        if (this._dragging     === id) this._dragging     = null;
        if (this._resizing     === id) this._resizing     = null;
        if (this._modalWinId   === id) this._modalWinId   = null;
        return;
      }
    }
  }

  minimiseWindow(id: number): void {
    var win = this._findWindow(id);
    if (!win || win.minimised) return;
    if (win.app.onBlur) win.app.onBlur();
    win.minimised = true;
    if (this._mouseCapture === id) this._mouseCapture = null;
    if (this._dragging     === id) this._dragging     = null;
    if (this._resizing     === id) this._resizing     = null;
    if (this._focused === id) {
      var next: WMWindow | undefined;
      for (var i = this._windows.length - 1; i >= 0; i--) {
        if (!this._windows[i].minimised && this._windows[i].id !== id) {
          next = this._windows[i]; break;
        }
      }
      this._focused = next ? next.id : null;
      if (next && next.app.onFocus) next.app.onFocus();
    }
    this._wmDirty = true;
  }

  restoreWindow(id: number): void {
    var win = this._findWindow(id);
    if (!win || !win.minimised) return;
    win.minimised = false;
    this.focusWindow(id);
    this._wmDirty = true;
  }

  /** Public wrapper — maximise if normal, restore if already maximised. */
  maximiseWindow(id: number): void {
    var win = this._findWindow(id);
    if (!win) return;
    this._toggleMaximise(win);
    this._wmDirty = true;
  }

  /** Update the title bar text of a window. */
  setTitle(id: number, title: string): void {
    var win = this._findWindow(id);
    if (!win) return;
    win.title = title;
    this._wmDirty = true;
  }

  /** Move a window to (x, y). */
  moveWindow(id: number, x: number, y: number): void {
    var win = this._findWindow(id);
    if (!win || win.maximised) return;
    win.x = x; win.y = y;
    this._wmDirty = true;
  }

  /** Resize a window's content area. */
  resizeWindow(id: number, w: number, h: number): void {
    var win = this._findWindow(id);
    if (!win || win.maximised) return;
    w = Math.max(MIN_WIN_W, w);
    h = Math.max(MIN_WIN_H, h);
    win.width  = w;
    win.height = h + TITLE_H;
    win.canvas = new Canvas(w, h);
    if (win.app.onResize) win.app.onResize(w, h);
    this._wmDirty = true;
  }

  /** Bring a window to the top of the z-order without changing keyboard focus. */
  bringToFront(id: number): void {
    for (var i = 0; i < this._windows.length; i++) {
      if (this._windows[i].id === id) {
        var win = this._windows.splice(i, 1)[0];
        this._windows.push(win);
        this._wmDirty = true;
        return;
      }
    }
  }

  /** Allow or disallow the user from closing a window via the X button. */
  setCloseable(id: number, closeable: boolean): void {
    var win = this._findWindow(id);
    if (!win) return;
    win.closeable = closeable;
    this._wmDirty = true;
  }

  /** Set per-window opacity (0 = invisible, 255 = fully opaque). */
  setWindowOpacity(id: number, opacity: number): void {
    var win = this._findWindow(id);
    if (!win) return;
    win.opacity = Math.max(0, Math.min(255, opacity));
    this._wmDirty = true;
  }

  /** Change the cursor shape. */
  setCursorShape(shape: string): void {
    this._cursorShape = shape;
    this._wmDirty = true;
  }

  /** Taskbar height in pixels. */
  get taskbarH(): number { return TASKBAR_H; }

  /**
   * Open a modal window.  While it is open all input is directed exclusively to it.
   * When the modal window is closed, normal input routing resumes.
   */
  openModal(opts: {
    title: string;
    app: App;
    width: number;
    height: number;
  }): WMWindow {
    var win = this.createWindow({ ...opts, closeable: true });
    this._modalWinId = win.id;
    return win;
  }

  /**
   * Show a right-click context menu at (x, y).
   * Dismissed when an item is activated, or the user clicks elsewhere.
   */
  showContextMenu(x: number, y: number, items: MenuItem[]): void {
    this._contextMenu = { x, y, items: items.slice() };
    this._wmDirty = true;
  }

  /** Dismiss the active context menu without firing any action. */
  dismissContextMenu(): void {
    if (this._contextMenu) { this._contextMenu = null; this._wmDirty = true; }
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
    scheduler.tick();                 // process-level accounting, signals, time-slice
    threadManager.tickCoroutines();   // cooperative fetch / async coroutines
    this._composite();
  }
  /** Mark the WM as needing a repaint (call from app code or external events). */
  markDirty(): void { this._wmDirty = true; }

  /**
   * Pump every live child JS process each frame.
   * This drives Promise/async resolution and fires onMessage callbacks
   * without any user code needing to manually call p.tick().
   * Guard: skip the kernel.procList() allocation entirely when no children exist.
   */
  private _tickChildProcs(): void {
    var list = kernel.procList();
    if (list.length === 0) return;
    for (var i = 0; i < list.length; i++) {
      kernel.procTick(list[i].id);
    }
  }
  // ── Input dispatch ─────────────────────────────────────────────────────

  private _pollInput(): void {
    // ── Drain mouse queue ─────────────────────────────────────────────────────
    for (var i = 0; i < 8; i++) {
      var pkt = kernel.readMouse();
      if (!pkt) break;
      var prevX = this._cursorX;
      var prevY = this._cursorY;
      this._cursorX = Math.max(0, Math.min(this._screen.width  - 1, this._cursorX + pkt.dx));
      this._cursorY = Math.max(0, Math.min(this._screen.height - 1, this._cursorY + pkt.dy));
      var cx = this._cursorX;
      var cy = this._cursorY;
      if (cx !== prevX || cy !== prevY) this._wmDirty = true;

      var btn1     = pkt.buttons & 1;
      var prevBtn1 = this._prevButtons & 1;

      if (btn1) {
        // ── Active drag ──────────────────────────────────────────────────────
        if (this._dragging !== null) {
          var dw = this._findWindow(this._dragging);
          if (dw) {
            dw.x = cx - this._dragOffX;
            dw.y = Math.max(0, cy - this._dragOffY);
            this._wmDirty = true;
          }
        // ── Active resize ────────────────────────────────────────────────────
        } else if (this._resizing !== null) {
          var rw = this._findWindow(this._resizing);
          if (rw) {
            rw.width  = Math.max(MIN_WIN_W, this._resizeStartW + cx - this._resizeStartX);
            rw.height = Math.max(MIN_WIN_H + TITLE_H, this._resizeStartH + cy - this._resizeStartY);
            this._wmDirty = true;
          }
        // ── New mouse-down ───────────────────────────────────────────────────
        } else if (!prevBtn1) {
          var consumed = false;

          // 0. Context-menu click?
          if (this._contextMenu) {
            var hitItem = this._hitContextMenuItem(cx, cy);
            if (hitItem && !hitItem.disabled && hitItem.action) hitItem.action();
            this._contextMenu = null;
            this._wmDirty = true;
            consumed = true;
          }

          if (!consumed) {
          var barY = this._screen.height - TASKBAR_H;
          if (cy >= barY) {
            var btnX = 58;
            for (var bi = 0; bi < this._windows.length; bi++) {
              var wb = this._windows[bi];
              if (cx >= btnX && cx < btnX + 90 && cy >= barY + 3 && cy < barY + TASKBAR_H - 3) {
                if (wb.minimised) {
                  this.restoreWindow(wb.id);
                } else if (wb.id === this._focused) {
                  this.minimiseWindow(wb.id);
                } else {
                  this.focusWindow(wb.id);
                }
                consumed = true;
                break;
              }
              btnX += 95;
            }
          }

          // 2. Window hit scan (top-most first)
          if (!consumed) {
            for (var j = this._windows.length - 1; j >= 0; j--) {
              var w = this._windows[j];
              if (w.minimised) continue;

              // 2a. Resize grip (bottom-right corner)?
              if (!w.maximised &&
                  cx >= w.x + w.width - RESIZE_GRIP && cx < w.x + w.width &&
                  cy >= w.y + w.height - RESIZE_GRIP && cy < w.y + w.height) {
                this.focusWindow(w.id);
                this._resizing      = w.id;
                this._resizeStartX  = cx;
                this._resizeStartY  = cy;
                this._resizeStartW  = w.width;
                this._resizeStartH  = w.height;
                consumed = true;
                break;
              }

              // 2b. Title bar?
              if (cx >= w.x && cx < w.x + w.width &&
                  cy >= w.y && cy < w.y + TITLE_H) {
                this.focusWindow(w.id);
                var btnBase = w.x + w.width;
                if (w.closeable && cx >= btnBase - 18 && cx <= btnBase - 4 &&
                    cy >= w.y + 4 && cy <= w.y + TITLE_H - 4) {
                  this.closeWindow(w.id);
                } else if (cx >= btnBase - 34 && cx <= btnBase - 20 &&
                           cy >= w.y + 4 && cy <= w.y + TITLE_H - 4) {
                  this._toggleMaximise(w);
                } else if (cx >= btnBase - 50 && cx <= btnBase - 36 &&
                           cy >= w.y + 4 && cy <= w.y + TITLE_H - 4) {
                  this.minimiseWindow(w.id);
                } else {
                  this._dragging  = w.id;
                  this._dragOffX  = cx - w.x;
                  this._dragOffY  = cy - w.y;
                  this._wmDirty   = true;
                }
                consumed = true;
                break;
              }

              // 2c. Content area?
              if (cx >= w.x && cx < w.x + w.width &&
                  cy >= w.y + TITLE_H && cy < w.y + w.height) {
                this._mouseCapture = w.id;
                this.focusWindow(w.id);
                consumed = true;
                break;
              }
            }
          }
          } // end if (!consumed) — outer context-menu guard

        } // end else if (!prevBtn1) — new-mouse-down handler

      } else {
        // ── Button released ──────────────────────────────────────────────────
        if (this._resizing !== null) {
          var rw2 = this._findWindow(this._resizing);
          if (rw2) {
            var newCW = rw2.width;
            var newCH = rw2.height - TITLE_H;
            if (rw2.canvas.width !== newCW || rw2.canvas.height !== newCH) {
              rw2.canvas = new Canvas(newCW, newCH);
              if (rw2.app.onResize) rw2.app.onResize(newCW, newCH);
            }
          }
          this._resizing = null;
          this._wmDirty  = true;
        }
        this._dragging = null;
      }

      // ── Dispatch mouse events to app content area ─────────────────────────
      if (this._dragging === null && this._resizing === null) {
        var hitWin: WMWindow | null = null;
        for (var hj = this._windows.length - 1; hj >= 0; hj--) {
          var hw = this._windows[hj];
          if (hw.minimised) continue;
          if (cx >= hw.x && cx < hw.x + hw.width &&
              cy >= hw.y + TITLE_H && cy < hw.y + hw.height) {
            hitWin = hw; break;
          }
        }
        var dispWin: WMWindow | null = hitWin;
        if (this._mouseCapture !== null) {
          var cw = this._findWindow(this._mouseCapture);
          if (cw && !cw.minimised) dispWin = cw;
        }
        if (!btn1 && prevBtn1) this._mouseCapture = null;

        if (dispWin) {
          var evType: 'move' | 'down' | 'up';
          if      (btn1 && !prevBtn1)  evType = 'down';
          else if (!btn1 && prevBtn1)  evType = 'up';
          else                         evType = 'move';
          try {
            dispWin.app.onMouse({
              x:       cx - dispWin.x,
              y:       cy - (dispWin.y + TITLE_H),
              dx:      cx - prevX,
              dy:      cy - prevY,
              buttons: pkt.buttons,
              type:    evType,
            });
          } catch (_e) {}
          if (evType !== 'move') this._wmDirty = true;
        }
      } else {
        this._mouseCapture = null;
      }

      this._prevButtons = pkt.buttons;
    }

    // ── Drain keyboard to focused window ──────────────────────────────────────
    var focused = this.getFocused();
    // If a modal is active, redirect all keyboard input to the modal window
    if (this._modalWinId !== null) {
      var modalWin = this._findWindow(this._modalWinId);
      if (modalWin) focused = modalWin;
    }
    if (focused) {
      for (var k = 0; k < 32; k++) {
        var raw = kernel.readKeyEx();
        if (!raw) break;
        try { focused.app.onKey(this._makeKeyEvent(raw)); } catch (_e) {}
        this._wmDirty = true;
      }
    } else {
      // Still drain the queue even when no window is focused
      for (var k = 0; k < 32; k++) { if (!kernel.readKeyEx()) break; }
    }

    // ── Pump network stack ────────────────────────────────────────────────────
    net.pollNIC();
  }

  /** Convert raw kernel {ch, ext} into the portable KeyEvent format. */
  private _makeKeyEvent(raw: { ch: string; ext: number }): KeyEvent {
    var ch  = raw.ch;
    var ext = raw.ext;
    var key = '';
    var ctrl = false;

    if (ext !== 0) {
      if      (ext === 0x80) key = 'ArrowUp';
      else if (ext === 0x81) key = 'ArrowDown';
      else if (ext === 0x82) key = 'ArrowLeft';
      else if (ext === 0x83) key = 'ArrowRight';
      else if (ext === 0x84) key = 'Home';
      else if (ext === 0x85) key = 'End';
      else if (ext === 0x86) key = 'PageUp';
      else if (ext === 0x87) key = 'PageDown';
      else if (ext === 0x88) key = 'Delete';
      else if (ext >= 0x90 && ext <= 0x9B) key = 'F' + (ext - 0x8F);
      else key = 'Ext' + ext.toString(16).toUpperCase();
    } else if (ch === '\n' || ch === '\r') {
      key = 'Enter';
    } else if (ch === '\b' || ch === '\x7f') {
      key = 'Backspace';
    } else if (ch === '\t') {
      key = 'Tab';
    } else if (ch === '\x1b') {
      key = 'Escape';
    } else if (ch.length === 1) {
      var code = ch.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        // Ctrl+A(1) … Ctrl+Z(26) — but Tab(9), Enter(10/13), Esc(27) already handled
        ctrl = true;
        key  = String.fromCharCode(code + 64);
      } else {
        key = ch;
      }
    } else {
      key = ch;
    }

    return { ch, ext, key, type: 'down', ctrl, shift: false, alt: false };
  }

  /** Toggle maximised state; saves/restores geometry and rebuilds content canvas. */
  private _toggleMaximise(win: WMWindow): void {
    if (win.maximised) {
      var saved = this._savedSizes.get(win.id);
      if (saved) {
        win.x = saved.x;  win.y = saved.y;
        win.width = saved.w;  win.height = saved.h;
        this._savedSizes.delete(win.id);
      }
      win.maximised = false;
    } else {
      this._savedSizes.set(win.id, { x: win.x, y: win.y, w: win.width, h: win.height });
      win.x = 0;  win.y = 0;
      win.width  = this._screen.width;
      win.height = this._screen.height - TASKBAR_H;
      win.maximised = true;
    }
    var newCW = win.width;
    var newCH = win.height - TITLE_H;
    win.canvas = new Canvas(newCW, newCH);
    if (win.app.onResize) win.app.onResize(newCW, newCH);
    this._wmDirty = true;
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
      if (!wi.minimised) {
        try { if (wi.app.render(wi.canvas)) anyDirty = true; } catch (_e) {}
      }
    }

    if (!anyDirty) return;   // ★ nothing changed — skip expensive composite+flip
    this._wmDirty = false;

    // 1. Desktop background
    s.clear(Colors.DESKTOP_BG);

    // 2. Draw windows bottom-to-top
    //    When a modal is active: draw all non-modal windows first, then apply
    //    the dim overlay, then draw the modal window on top.
    var modalWin: WMWindow | null = null;
    if (this._modalWinId !== null) {
      for (var ii = 0; ii < this._windows.length; ii++) {
        if (this._windows[ii].id === this._modalWinId) { modalWin = this._windows[ii]; break; }
      }
    }

    var drawOneWindow = (win: WMWindow): void => {
      if (win.minimised) return;
      if (win.opacity === 0) return;
      var focused = (win.id === this._focused);

      // Title bar
      s.fillRect(win.x, win.y, win.width, TITLE_H,
                 focused ? FOCUSED_TITLE_COLOR : TITLE_COLOR);
      // Title text (truncate to avoid overlapping buttons)
      var maxTitleChars = Math.floor((win.width - 58) / 8);
      var title = win.title.length > maxTitleChars
        ? win.title.substring(0, maxTitleChars)
        : win.title;
      s.drawText(win.x + 6, win.y + 5, title, Colors.WHITE);

      // Title bar buttons (right→left: close, max, min)
      var bb = win.x + win.width;
      // Close
      if (win.closeable) {
        s.fillRect(bb - 18, win.y + 4, BTN_W, TITLE_H - 8, 0xFFCC3333);
        s.drawText(bb - 14, win.y + 6, 'X', Colors.WHITE);
      }
      // Maximise
      s.fillRect(bb - 34, win.y + 4, BTN_W, TITLE_H - 8, focused ? 0xFF226622 : 0xFF1A441A);
      s.drawText(bb - 31, win.y + 6, win.maximised ? '\u25a4' : '\u25a1', Colors.LIGHT_GREY);
      // Minimise
      s.fillRect(bb - 50, win.y + 4, BTN_W, TITLE_H - 8, focused ? 0xFF664422 : 0xFF442D17);
      s.drawText(bb - 47, win.y + 6, '_', Colors.LIGHT_GREY);

      // Content area
      s.fillRect(win.x, win.y + TITLE_H, win.width, win.height - TITLE_H, 0xFF111111);

      // Blit window canvas (clamped to actual canvas dimensions to handle mid-resize)
      var contentH = win.height - TITLE_H;
      var blitW = Math.min(win.width, win.canvas.width);
      var blitH = Math.min(contentH, win.canvas.height);
      if (win.opacity >= 255) {
        s.blit(win.canvas, 0, 0, win.x, win.y + TITLE_H, blitW, blitH);
      } else {
        s.blitAlpha(win.canvas, 0, 0, win.x, win.y + TITLE_H, blitW, blitH, win.opacity);
      }

      // Resize grip: three diagonal lines at bottom-right
      var gx = win.x + win.width - 1;
      var gy = win.y + win.height - 1;
      var gc = focused ? 0xFF6688AA : 0xFF445566;
      s.drawLine(gx - 8, gy, gx, gy - 8, gc);
      s.drawLine(gx - 5, gy, gx, gy - 5, gc);
      s.drawLine(gx - 2, gy, gx, gy - 2, gc);

      // Window border
      s.drawRect(win.x, win.y, win.width, win.height,
                 focused ? 0xFF5599CC : 0xFF445566);
    };

    for (var i = 0; i < this._windows.length; i++) {
      var win = this._windows[i];
      if (win.id === this._modalWinId) continue; // modal drawn last
      drawOneWindow(win);
    }

    // Apply dim overlay after all non-modal windows, before modal
    if (modalWin !== null) {
      var buf = s.getBuffer();
      var screenH = s.height - TASKBAR_H;
      for (var dy2 = 0; dy2 < screenH; dy2++) {
        for (var dx2 = (dy2 & 1); dx2 < s.width; dx2 += 2) {
          var pidx = dy2 * s.width + dx2;
          var px2  = buf[pidx];
          buf[pidx] = ((px2 >> 1) & 0x7F7F7F7F) | 0xFF000000;
        }
      }
      drawOneWindow(modalWin);
    }

    // 3. Taskbar
    this._drawTaskbar();

    // 4. Context menu (above taskbar if present)
    if (this._contextMenu) {
      this._drawContextMenu();
    }

    // 5. Mouse cursor
    this._drawCursor();

    // 6. Flip to framebuffer
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
    if (this._cursorShape === 'none') return;

    var buf = this._screen.getBuffer();
    var sw  = this._screen.width;
    var sh  = this._screen.height;
    var cx  = this._cursorX;
    var cy  = this._cursorY;
    var BLACK = 0xFF000000;
    var WHITE = 0xFFFFFFFF;

    if (this._cursorShape === 'crosshair') {
      // Simple 9×9 crosshair
      for (var i = -4; i <= 4; i++) {
        if (i === 0) continue;
        var px = cx + i, py = cy;
        if (px >= 0 && px < sw && py >= 0 && py < sh) buf[py * sw + px] = WHITE;
        px = cx; py = cy + i;
        if (px >= 0 && px < sw && py >= 0 && py < sh) buf[py * sw + px] = WHITE;
      }
      if (cx >= 0 && cx < sw && cy >= 0 && cy < sh) buf[cy * sw + cx] = BLACK;
      return;
    }

    if (this._cursorShape === 'text') {
      // I-beam: vertical bar with serifs
      var ibH = 14, ibY = cy - ibH / 2;
      for (var iy = 0; iy < ibH; iy++) {
        var py2 = Math.floor(ibY + iy);
        if (py2 < 0 || py2 >= sh) continue;
        if (iy === 0 || iy === ibH - 1) {
          // serifs
          for (var ix = -2; ix <= 2; ix++) {
            var px2 = cx + ix;
            if (px2 >= 0 && px2 < sw) buf[py2 * sw + px2] = WHITE;
          }
        } else {
          if (cx >= 0 && cx < sw) buf[py2 * sw + cx] = WHITE;
        }
      }
      return;
    }

    if (this._cursorShape === 'pointer') {
      // Simple pointing hand (hollow) — reuse arrow but offset slightly
      // Fall through to default arrow for now
    }

    // Default / resize cursors: use the arrow sprite
    // Write directly into the screen buffer — avoids 209 individual setPixel()
    // calls (each with a bounds-check + _bgra() call) per frame.
    for (var row = 0; row < CURSOR_H; row++) {
      var py3 = cy + row;
      if (py3 < 0 || py3 >= sh) continue;
      var rowBase = py3 * sw;
      for (var col = 0; col < CURSOR_W; col++) {
        var v = CURSOR_PIXELS[row * CURSOR_W + col];
        if (v === 0) continue;
        var px3 = cx + col;
        if (px3 < 0 || px3 >= sw) continue;
        buf[rowBase + px3] = v === 1 ? BLACK : WHITE;
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

  private _drawContextMenu(): void {
    var cm = this._contextMenu!;
    var s  = this._screen;
    var ITEM_H = 16;
    var PAD    = 6;
    var W      = 140;

    // Calculate height (separator = 5px, normal item = ITEM_H)
    var totalH = PAD;
    for (var k = 0; k < cm.items.length; k++) {
      totalH += cm.items[k].separator ? 5 : ITEM_H;
    }
    totalH += PAD;

    // Clamp to screen
    var mx = Math.min(cm.x, s.width  - W   - 2);
    var my = Math.min(cm.y, s.height - totalH - 2);

    // Background + border
    s.fillRect(mx, my, W, totalH, 0xFF2A2A3A);
    s.drawRect(mx, my, W, totalH, 0xFF5599CC);

    var cy = my + PAD;
    for (var i = 0; i < cm.items.length; i++) {
      var item = cm.items[i];
      if (item.separator) {
        s.fillRect(mx + 4, cy + 2, W - 8, 1, 0xFF445566);
        cy += 5;
        continue;
      }
      // Hover highlight: item under cursor?
      var cx2 = this._cursorX, cy2 = this._cursorY;
      var hover = cx2 >= mx && cx2 < mx + W && cy2 >= cy && cy2 < cy + ITEM_H;
      if (hover && !item.disabled) s.fillRect(mx + 1, cy, W - 2, ITEM_H, 0xFF2255AA);
      s.drawText(mx + 8, cy + 4, item.label,
                 item.disabled ? 0xFF667788 : Colors.WHITE);
      cy += ITEM_H;
    }
  }

  private _hitContextMenuItem(cx: number, cy: number): MenuItem | null {
    var cm = this._contextMenu;
    if (!cm) return null;
    var ITEM_H = 16, PAD = 6, W = 140;
    var totalH = PAD;
    for (var k = 0; k < cm.items.length; k++) {
      totalH += cm.items[k].separator ? 5 : ITEM_H;
    }
    totalH += PAD;
    var mx = Math.min(cm.x, this._screen.width  - W   - 2);
    var my = Math.min(cm.y, this._screen.height - totalH - 2);
    var iy = my + PAD;
    for (var i = 0; i < cm.items.length; i++) {
      var item = cm.items[i];
      if (item.separator) { iy += 5; continue; }
      if (cx >= mx && cx < mx + W && cy >= iy && cy < iy + ITEM_H) return item;
      iy += ITEM_H;
    }
    return null;
  }
}

/** Singleton WM instance — created by main.ts after framebuffer detection. */
export let wm: WindowManager | null = null;
export function setWM(instance: WindowManager): void { wm = instance; }
export function getWM(): WindowManager {
  if (!wm) throw new Error('WindowManager not yet initialised');
  return wm;
}
