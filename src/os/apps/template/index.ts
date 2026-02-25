/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                    JSOS APPLICATION TEMPLATE                           │
 * │                                                                         │
 * │  Copy this directory to src/os/apps/<your-app-name>/index.ts           │
 * │  then wire it into commands.ts (g.myApp + _appRegistry entry).         │
 * │                                                                         │
 * │  Every app is a plain object / class that satisfies the App interface: │
 * │    name, onMount, onUnmount, onKey, onMouse, render                     │
 * │    (optional) onFocus, onBlur, onResize                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Available imports for every app:
 *
 *   import { os }                    from '../../core/sdk.js';
 *     os.fs        — filesystem read/write/list/mkdir …
 *     os.net       — socket create/connect/send/recv …
 *     os.disk      — FAT32/FAT16 persistent storage (available() check first)
 *     os.clipboard — read() / write(text)
 *     os.wm        — openWindow / closeWindow / getWindows / markDirty …
 *     os.process   — spawn(code, name?) / list()
 *     os.ipc       — pipe() / signals.handle() / mq.send() …
 *     os.users     — whoami() / login() / addUser() …
 *     os.system    — uptime / ticks / pid / memInfo() / screenWidth() …
 *     os.spawn     — register named coroutine step for async work
 *     os.fetchAsync— non-blocking HTTP/HTTPS → FetchResponse
 *
 *   import { Canvas, Colors }        from '../../ui/canvas.js';
 *     All 2-D drawing is done by calling methods on the Canvas object
 *     passed to render().  The canvas is already sized to the window
 *     content area — do NOT create your own Canvas.
 *
 *   import { type App, type WMWindow, type KeyEvent, type MouseEvent }
 *          from '../../ui/wm.js';
 *
 *   declare var kernel: import('../../core/kernel.js').KernelAPI;
 *     Direct kernel calls (getTicks, serialPut, sleep…) — use sparingly.
 *
 * Rendering contract
 * ──────────────────
 * • render() is called every WM frame (~60 fps).
 * • Return TRUE only when you actually changed pixels — the WM skips the
 *   expensive composite+flip when all apps return false.
 * • Use the _dirty flag pattern (set it on state changes, clear it inside
 *   render after drawing) to avoid redundant work.
 *
 * Input contract
 * ──────────────
 * • onKey receives { key, ch, type:'down'|'up'|'press', shift, ctrl, alt }.
 * • onMouse receives { x, y, dx, dy, buttons, type:'down'|'up'|'move' }.
 *   x/y are RELATIVE to the top-left of the window CONTENT area.
 *
 * Lifecycle
 * ─────────
 * 1. new MyApp() or myAppSingleton
 * 2. onMount(win)       — save the window handle; initialise state
 * 3. onFocus?()         — called when window becomes active
 * 4. render(canvas) …  — called every frame; draw if _dirty
 * 5. onKey / onMouse … — handle user input; set _dirty = true
 * 6. onBlur?()          — window lost focus
 * 7. onResize?(w, h)    — content area resized
 * 8. onUnmount()        — window closed; release resources
 */

import { os }             from '../../core/sdk.js';
import { Canvas, Colors } from '../../ui/canvas.js';
import {
  type App,
  type WMWindow,
  type KeyEvent,
  type MouseEvent,
} from '../../ui/wm.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ─────────────────────────────────────────────────────────────────────────────
// 1.  App state  (module-scope so the singleton keeps state between frames)
// ─────────────────────────────────────────────────────────────────────────────

var _win:    WMWindow | null = null;    // set in onMount, cleared in onUnmount
var _dirty   = true;                   // set true → render will redraw
var _focused = false;                  // true when this window has keyboard focus
var _counter = 0;                      // example piece of app state

// ─────────────────────────────────────────────────────────────────────────────
// 2.  Drawing helper (optional — inline into render for simple apps)
// ─────────────────────────────────────────────────────────────────────────────

function _draw(canvas: Canvas): void {
  var w = canvas.width;
  var h = canvas.height;

  // Clear background
  canvas.clear(Colors.EDITOR_BG);                        // dark blue-grey

  // Title / header bar
  canvas.fillRect(0, 0, w, 24, 0xFF1A2A3A);
  canvas.drawText(8, 4, 'My App  —  counter: ' + _counter,
    _focused ? Colors.WHITE : Colors.LIGHT_GREY);

  // A centred message
  var msg = 'Press +/- or click to change the counter';
  canvas.drawText(Math.max(0, (w - msg.length * 8) >> 1), (h >> 1) - 8,
    msg, Colors.DARK_GREY);

  // A coloured value display
  var valStr = String(_counter);
  canvas.fillRect((w - 60) >> 1, (h >> 1) + 8, 60, 20, 0xFF2255AA);
  canvas.drawText(((w - valStr.length * 8) >> 1), (h >> 1) + 12,
    valStr, Colors.WHITE);

  // Status bar
  canvas.fillRect(0, h - 18, w, 18, 0xFF111920);
  canvas.drawText(8, h - 14, '+/- change  |  R reset  |  Q close', Colors.DARK_GREY);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.  App export — this is what main.ts / commands.ts import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Singleton-pattern app.  For apps that should only have ONE window open at
 * a time, export a plain object like this.
 *
 * For apps that can be opened multiple times (e.g. a text editor) export a
 * class instead (see apps/editor/index.ts).
 */
export const templateApp: App = {
  // ── Identity ─────────────────────────────────────────────────────────────

  /**
   * Human-readable name — shown in the taskbar and used as the default
   * window title when opened via launch().
   */
  name: 'Template App',

  // ── Mandatory lifecycle ───────────────────────────────────────────────────

  /**
   * onMount — the window has been created and sized.
   * Receives the WMWindow handle which carries: id, title, x, y, width,
   * height, canvas (sized to content area), minimised, maximised, closeable.
   *
   * Save the handle; read initial size from win.canvas.
   */
  onMount(win: WMWindow): void {
    _win   = win;
    _dirty = true;
    // Example: read app state from disk on open
    // if (os.disk.available()) {
    //   var saved = os.disk.read('/apps/template/state.json');
    //   if (saved) _counter = JSON.parse(saved).counter ?? 0;
    // }
  },

  /**
   * onUnmount — the window is being closed.
   * Release event listeners, timers, open sockets, coroutines, etc.
   */
  onUnmount(): void {
    _win    = null;
    _focused = false;
    // Example: persist state on close
    // if (os.disk.available()) {
    //   os.disk.write('/apps/template/state.json', JSON.stringify({ counter: _counter }));
    // }
  },

  /**
   * onKey — key event dispatched when this window has focus.
   * event.type: 'down' | 'up' | 'press'
   * event.key:  'Enter', 'Backspace', 'ArrowUp', 'a', '+', … (like DOM KeyboardEvent.key)
   * event.ch:   printable character string ('' for non-printable)
   * event.ctrl, event.shift, event.alt: boolean modifiers
   */
  onKey(event: KeyEvent): void {
    if (event.type !== 'down') return;

    switch (event.key) {
      case '+': case '=':
        _counter++;
        _dirty = true;
        break;
      case '-':
        _counter--;
        _dirty = true;
        break;
      case 'r': case 'R':
        _counter = 0;
        _dirty = true;
        break;
      case 'q': case 'Q':
      case 'Escape':
        // Close this window programmatically
        if (_win) os.wm.closeWindow(_win.id);
        break;
    }
  },

  /**
   * onMouse — mouse event when the cursor is over (or captured by) this window.
   * event.type:    'down' | 'up' | 'move'
   * event.x / .y: pixel coords relative to the window content area
   * event.buttons: bitmask (bit 0 = left button)
   */
  onMouse(event: MouseEvent): void {
    if (event.type === 'down' && (event.buttons & 1)) {
      _counter++;
      _dirty = true;
    }
  },

  /**
   * render — draw the app's content into canvas.
   *
   * IMPORTANT: return TRUE only when you actually drew something.
   * Returning false constantly is ~free; returning true every frame is
   * expensive because it forces a full screen composite + flip.
   *
   * The canvas is ALREADY sized to the window content area.  Do not create
   * a new Canvas — draw directly into the one that is passed in.
   */
  render(canvas: Canvas): boolean {
    if (!_dirty) return false;   // nothing changed — skip composite
    _dirty = false;
    _draw(canvas);
    return true;                 // ← compositor will blit + flip
  },

  // ── Optional lifecycle ────────────────────────────────────────────────────

  /**
   * onFocus — this window just became the active (keyboard-receiving) window.
   * Redraw the title bar with the "active" colour, start a cursor blink, etc.
   */
  onFocus(): void {
    _focused = true;
    _dirty   = true;
  },

  /**
   * onBlur — this window lost focus (another window was clicked / launched).
   * Dim the title bar, pause animations, etc.
   */
  onBlur(): void {
    _focused = false;
    _dirty   = true;
  },

  /**
   * onResize — the window content area was resized to (width × height).
   * Recalculate layout, re-render.
   */
  onResize(width: number, height: number): void {
    _dirty = true;
  },
};
