/**
 * 
 *                     JSOS APPLICATION TEMPLATE                           
 *                                                                          
 *   Copy this directory to src/os/apps/<your-app-name>/index.ts           
 *   then wire it into commands.ts (_appRegistry entry).                   
 *                                                                          
 *   Extend BaseApp instead of implementing App directly.                  
 *   BaseApp handles all lifecycle boilerplate so you only need to write:   
 *     onKey, onMouse, render  (and optionally onInit / onDestroy)          
 * 
 *
 * Available imports from the SDK (single import line for everything):
 *
 *   import { os, Canvas, Colors, BaseApp,
 *            TabBar, Sidebar, ListView, ProgressBar, Button, TextInput,
 *            drawSection, drawRow,
 *            type KeyEvent, type MouseEvent, type WMWindow }
 *          from '../../core/sdk.js';
 *
 *   os.fs         filesystem read/write/list/mkdir 
 *   os.net        socket create/connect/send/recv, fetchAsync 
 *   os.disk       FAT32 persistent storage (check os.disk.available() first)
 *   os.clipboard  read() / write(text)
 *   os.wm         openWindow / closeWindow / getWindows / markDirty 
 *   os.process    spawn(code, name?) / list()
 *   os.ipc        pipe() / signals.handle() / mq.send() 
 *   os.users      whoami() / login() / addUser() 
 *   os.system     uptime / ticks / pid / memInfo() / screenWidth() 
 *   os.theme      current() / set(name) / list() 
 *
 * Widget library (use these instead of hand-coding common UI):
 *   BaseApp       abstract base; extend it, override onKey/onMouse/render
 *   TabBar        horizontal tab strip (new TabBar(['Tab 1', 'Tab 2']))
 *   Sidebar       vertical category list (new Sidebar(['Item 1', 'Item 2']))
 *   ListView      scrollable selectable list (new ListView(['a', 'b', 'c']))
 *   ProgressBar   static helper: ProgressBar.render(canvas, x, y, w, h, 0.65)
 *   Button        clickable button (new Button('OK', x, y, w, h))
 *   TextInput     single-line editable field (new TextInput(x, y, w, h))
 *   drawSection   section header with underline
 *   drawRow       key-value info row
 *
 * Rendering contract
 * 
 *  render() is called every WM frame (~60 fps).
 *  Return TRUE only when you actually changed pixels.
 *  Use this._dirty (from BaseApp).  Set it in onKey/onMouse via invalidate().
 *  Do NOT create a new Canvas  draw into the one passed to render().
 *
 * Input contract
 * 
 *  onKey receives { key, ch, type:'down'|'up'|'press', shift, ctrl, alt }.
 *  onMouse receives { x, y, dx, dy, buttons, type:'down'|'up'|'move' }.
 *   x/y are RELATIVE to the top-left of the window CONTENT area.
 *
 * Lifecycle
 * 
 * 1. new TemplateApp()
 * 2. onMount(win)     BaseApp saves _win, sets _dirty=true, calls onInit()
 * 3. onInit()         YOUR code  set up initial state, load saved data
 * 4. render(canvas)    called every frame; draw if _dirty
 * 5. onKey / onMouse   handle input; call invalidate() when state changes
 * 6. onDestroy()      YOUR code  save state, release resources
 * 7. onUnmount()      BaseApp clears _win / _focused
 */

import {
  os, Canvas, Colors, BaseApp,
  type KeyEvent, type MouseEvent,
} from '../../core/sdk.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

//  TemplateApp 

class TemplateApp extends BaseApp {
  // Required: display name used by the WM / taskbar
  readonly name = 'Template App';

  //  App state 
  private _counter = 0;

  //  Lifecycle hooks (optional  override instead of onMount/onUnmount) 

  /** Called after onMount  initialise state, load saved data, etc. */
  onInit(): void {
    // Example: restore from persistent disk storage
    // if (os.disk.available()) {
    //   var saved = os.disk.read('/apps/template/state.json');
    //   if (saved) this._counter = JSON.parse(saved).counter ?? 0;
    // }
  }

  /** Called before onUnmount  save state, release timers/sockets, etc. */
  onDestroy(): void {
    // Example: persist state on close
    // if (os.disk.available()) {
    //   os.disk.write('/apps/template/state.json', JSON.stringify({ counter: this._counter }));
    // }
  }

  //  Input handling 

  /**
   * key event dispatched when this window has focus.
   * event.type: 'down' | 'up' | 'press'
   * event.key:  'Enter', 'Backspace', 'ArrowUp', 'a', '+',  (DOM key name)
   * event.ch:   printable character string ('' for non-printable)
   */
  onKey(ev: KeyEvent): void {
    if (ev.type !== 'down') return;
    switch (ev.key) {
      case '+': case '=':
        this._counter++;
        this.invalidate();   //  marks dirty; BaseApp handles the rest
        break;
      case '-':
        this._counter--;
        this.invalidate();
        break;
      case 'r': case 'R':
        this._counter = 0;
        this.invalidate();
        break;
      case 'q': case 'Q':
      case 'Escape':
        if (this._win) os.wm.closeWindow(this._win.id);
        break;
    }
  }

  /**
   * mouse event relative to window content area.
   * event.type:    'down' | 'up' | 'move'
   * event.x / .y: pixels from content area top-left
   * event.buttons: bitmask (bit 0 = left button)
   */
  onMouse(ev: MouseEvent): void {
    if (ev.type === 'down' && (ev.buttons & 1)) {
      this._counter++;
      this.invalidate();
    }
  }

  //  Rendering 

  /**
   * Draw the window content.
   * Return TRUE only when pixels actually changed  returning false constantly
   * is free; returning true forces a screen composite + flip.
   */
  render(canvas: Canvas): boolean {
    if (!this._dirty) return false;
    this._dirty = false;

    var w = canvas.width;
    var h = canvas.height;

    // Background
    canvas.clear(Colors.EDITOR_BG);

    // Title / header bar
    canvas.fillRect(0, 0, w, 24, 0xFF1A2A3A);
    canvas.drawText(8, 4, this.name + '    counter: ' + this._counter,
      this._focused ? Colors.WHITE : Colors.LIGHT_GREY);

    // Centred message
    var msg = 'Press +/- or click to change the counter';
    canvas.drawText(Math.max(0, (w - msg.length * 8) >> 1), (h >> 1) - 8,
      msg, Colors.DARK_GREY);

    // Coloured value display
    var valStr = String(this._counter);
    canvas.fillRect((w - 60) >> 1, (h >> 1) + 8, 60, 20, 0xFF2255AA);
    canvas.drawText(((w - valStr.length * 8) >> 1), (h >> 1) + 12, valStr, Colors.WHITE);

    // Status bar
    canvas.fillRect(0, h - 18, w, 18, 0xFF111920);
    canvas.drawText(8, h - 14, '+/- change  |  R reset  |  Q close', Colors.DARK_GREY);

    return true;
  }
}

/**
 * Export a singleton for apps that should only ever have one window open.
 * For apps that can be opened multiple times (e.g. editor with a file path),
 * export the class and instantiate it in the factory:
 *   factory: (path) => new TemplateApp(path)
 */
export const templateApp = new TemplateApp();
