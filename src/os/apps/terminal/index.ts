/**
 * JSOS Terminal App — Phase 3
 *
 * Wraps the existing text Terminal + REPL as a WM App so they run in a
 * window when the framebuffer is active.
 *
 * The Terminal renders characters into its sub-Canvas using the BitmapFont
 * instead of into VGA memory.  The REPL logic is unchanged.
 *
 * This app is always resident — its window cannot be fully closed (only
 * minimised). It serves as the OS escape hatch.
 */

import { os, Canvas, Colors, defaultFont, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';
import terminal from '../../ui/terminal.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Simple canvas-based text buffer ───────────────────────────────────────

const CHAR_W = 8;
const CHAR_H = 8;

class CanvasTerminal {
  private _canvas:  Canvas;
  private _cols:    number;
  private _rows:    number;
  private _row = 0;
  private _col = 0;
  private _fgColor = Colors.LIGHT_GREY;
  private _bgColor = 0xFF111111;

  constructor(canvas: Canvas) {
    this._canvas = canvas;
    this._cols   = Math.floor(canvas.width  / CHAR_W);
    this._rows   = Math.floor(canvas.height / CHAR_H);
    this.clear();
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  setColor(fg: number): void { this._fgColor = fg; }

  clear(): void {
    this._canvas.clear(this._bgColor);
    this._row = 0;
    this._col = 0;
  }

  print(text: string): void {
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') {
        this._col = 0;
        this._nextLine();
      } else if (ch === '\r') {
        this._col = 0;
      } else if (ch === '\b') {
        if (this._col > 0) {
          this._col--;
          this._canvas.fillRect(this._col * CHAR_W, this._row * CHAR_H,
                                CHAR_W, CHAR_H, this._bgColor);
        }
      } else {
        this._canvas.fillRect(this._col * CHAR_W, this._row * CHAR_H,
                              CHAR_W, CHAR_H, this._bgColor);
        defaultFont.renderChar(this._canvas,
                               this._col * CHAR_W, this._row * CHAR_H,
                               ch, this._fgColor);
        this._col++;
        if (this._col >= this._cols) {
          this._col = 0;
          this._nextLine();
        }
      }
    }
  }

  println(text: string): void {
    this.print(text + '\n');
  }

  private _nextLine(): void {
    this._row++;
    if (this._row >= this._rows) {
      this._scrollUp();
    }
  }

  private _scrollUp(): void {
    var cw = this._canvas.width;
    var rowPixels = CHAR_H;
    // Blit rows up
    for (var r = 0; r < this._rows - 1; r++) {
      this._canvas.blit(
        this._canvas,
        0, (r + 1) * rowPixels,  // src
        0, r * rowPixels,         // dst
        cw, rowPixels
      );
    }
    // Clear last row
    this._canvas.fillRect(0, (this._rows - 1) * rowPixels, cw, rowPixels, this._bgColor);
    this._row = this._rows - 1;
  }

  /** Draw (show=true) or erase (show=false) a 2-px underline cursor at the current position. */
  drawCursor(show: boolean): void {
    var cx = this._col * CHAR_W;
    var cy = this._row * CHAR_H + CHAR_H - 2;
    this._canvas.fillRect(cx, cy, CHAR_W, 2, show ? Colors.LIGHT_GREY : this._bgColor);
  }
}

// VGA colour-index (0-15) → ARGB pixel colour for CanvasTerminal
const VGA_TO_ARGB: number[] = [
  Colors.BLACK,     0xFF0000AA,        Colors.GREEN,       Colors.CYAN,
  Colors.RED,       Colors.MAGENTA,    Colors.ORANGE,      Colors.LIGHT_GREY,
  Colors.DARK_GREY, 0xFF5555FF,        Colors.LIGHT_GREEN, Colors.LIGHT_CYAN,
  Colors.LIGHT_RED, 0xFFFF55FF,        Colors.YELLOW,      Colors.WHITE,
];

// ── TerminalApp ────────────────────────────────────────────────────────────

export class TerminalApp implements App {
  readonly name = 'Terminal';
  private _term: CanvasTerminal | null = null;
  private _win:  WMWindow | null = null;
  private _inputBuf = '';
  private _dirty = true;   // track whether canvas has been modified
  private _blinkMs  = 0;   // accumulated ms since last cursor phase change
  private _blinkOn  = true; // current cursor visibility state
  private _lastTick = 0;   // kernel.getTicks() at last render call

  // ── Input history (items 642–644) ─────────────────────────────────────────
  private _history:    string[] = [];   // oldest at index 0
  private _historyPos: number   = -1;  // -1 = no traversal, 0..n-1 = browsing
  private _historyDraft = '';          // saved live input while browsing

  onMount(win: WMWindow): void {
    this._win  = win;
    this._term = new CanvasTerminal(win.canvas);
    this._dirty = true;
    this._loadHistory();
    this._printWelcome();
    this._printPrompt();
  }

  onUnmount(): void {
    this._term = null;
    this._win  = null;
  }

  onKey(event: KeyEvent): void {
    if (!this._term) return;
    var ch  = event.ch;
    var key = event.key;
    this._dirty = true;
    // Reset cursor blink phase on keystroke so cursor is immediately visible
    this._blinkMs = 0;
    this._blinkOn = true;

    // ── History navigation (items 642–643) ─────────────────────────────────
    if (key === 'ArrowUp') {
      if (this._history.length === 0) return;
      if (this._historyPos < 0) {
        // Start browsing: save the current draft
        this._historyDraft = this._inputBuf;
        this._historyPos   = this._history.length - 1;
      } else if (this._historyPos > 0) {
        this._historyPos--;
      }
      this._replaceInput(this._history[this._historyPos]);
      return;
    }
    if (key === 'ArrowDown') {
      if (this._historyPos < 0) return;
      if (this._historyPos < this._history.length - 1) {
        this._historyPos++;
        this._replaceInput(this._history[this._historyPos]);
      } else {
        // Reached the bottom — restore draft
        this._historyPos = -1;
        this._replaceInput(this._historyDraft);
      }
      return;
    }

    // Any non-arrow input exits history browsing mode
    this._historyPos = -1;

    if (ch === '\n' || ch === '\r') {
      this._term.print('\n');
      var cmd = this._inputBuf.trim();
      this._eval(cmd);
      // Push to history (skip empty and duplicate of last entry)
      if (cmd && (this._history.length === 0 || this._history[this._history.length - 1] !== cmd)) {
        this._history.push(cmd);
        if (this._history.length > 500) this._history.shift();  // cap history size
        this._saveHistory();
      }
      this._inputBuf = '';
      this._printPrompt();
    } else if (ch === '\b') {
      if (this._inputBuf.length > 0) {
        this._inputBuf = this._inputBuf.slice(0, -1);
        this._term.print('\b');
      }
    } else if (ch >= ' ') {
      this._inputBuf += ch;
      this._term.print(ch);
    }
  }

  /** Erase the current input on screen and replace with newVal. */
  private _replaceInput(newVal: string): void {
    if (!this._term) return;
    // Erase existing input with backspaces
    for (var i = 0; i < this._inputBuf.length; i++) this._term.print('\b');
    // Print new value
    this._inputBuf = newVal;
    this._term.print(newVal);
  }

  /** Load history from persistent storage (/home/.repl_history). */
  private _loadHistory(): void {
    try {
      var raw = os.fs.read('/home/.repl_history');
      if (raw) {
        var lines = raw.split('\n').filter(function(l: string) { return l.trim().length > 0; });
        this._history = lines.slice(-500);
        this._historyPos = -1;
      }
    } catch (_) {}
  }

  /** Save history to persistent storage (/home/.repl_history). */
  private _saveHistory(): void {
    try {
      os.fs.write('/home/.repl_history', this._history.join('\n'));
    } catch (_) {}
  }

  onMouse(event: MouseEvent): void {
    // [Item 673] OSC 8 hyperlink click: map pixel → VGA cell, look up link
    if (event.type === 'click') {
      var col = Math.floor(event.x / CHAR_W);
      var row = Math.floor(event.y / CHAR_H);
      var url = terminal.getLinkAt(row, col);
      if (url) {
        // Open URL in browser app if available
        try { (os as any).browser?.navigate(url); } catch (_) {}
      }
    }
  }

  render(_canvas: Canvas): boolean {
    // Cursor blink using kernel ticks (1000 Hz = 1 ms/tick); no VGA I/O in
    // graphic mode. Toggle cursor every 500 ms and mark dirty so the WM
    // composites a new frame even when no keys have been pressed.
    var now = kernel.getTicks();
    if (this._lastTick === 0) this._lastTick = now;
    this._blinkMs += now - this._lastTick;
    this._lastTick = now;
    if (this._blinkMs >= 500) {
      this._blinkMs = 0;
      this._blinkOn = !this._blinkOn;
      this._dirty = true;
    }
    if (!this._dirty) return false;
    this._dirty = false;
    if (this._term) this._term.drawCursor(this._blinkOn);
    return true;
  }

  private _printWelcome(): void {
    if (!this._term) return;
    this._term.setColor(Colors.CYAN);
    this._term.println('JSOS Terminal (windowed mode)');
    this._term.setColor(Colors.DARK_GREY);
    this._term.println('Type JavaScript. Enter to evaluate.');
    this._term.println('');
    this._term.setColor(Colors.LIGHT_GREY);
  }

  private _printPrompt(): void {
    if (!this._term) return;
    this._term.setColor(Colors.LIGHT_GREEN);
    this._term.print('js> ');
    this._term.setColor(Colors.WHITE);
  }

  private _eval(code: string): void {
    if (!this._term || !code) return;
    const term = this._term;

    // Temporarily redirect the global terminal singleton → this CanvasTerminal
    // so commands like help(), ls(), clear() etc. print here instead of VGA memory.
    const saved = {
      print:        (terminal as any).print.bind(terminal),
      println:      (terminal as any).println.bind(terminal),
      colorPrint:   (terminal as any).colorPrint.bind(terminal),
      colorPrintln: (terminal as any).colorPrintln.bind(terminal),
      setColor:     (terminal as any).setColor.bind(terminal),
      clear:        (terminal as any).clear.bind(terminal),
    };

    // Track the "persistent" foreground colour (set by setColor / reset after colorPrint).
    // Mirrors the VGA terminal's push/pop colour behaviour.
    let curColor = Colors.LIGHT_GREY;

    (terminal as any).print        = (s: string)             => { term.setColor(curColor); term.print(s); };
    (terminal as any).println      = (s: string = '')        => { term.setColor(curColor); term.println(s); };
    (terminal as any).colorPrint   = (s: string, c: number)  => {
      term.setColor(VGA_TO_ARGB[c & 15] ?? Colors.LIGHT_GREY); term.print(s);
      term.setColor(curColor);   // restore persistent colour after, like the VGA terminal does
    };
    (terminal as any).colorPrintln = (s: string, c: number)  => {
      term.setColor(VGA_TO_ARGB[c & 15] ?? Colors.LIGHT_GREY); term.println(s);
      term.setColor(curColor);   // restore persistent colour after
    };
    (terminal as any).setColor     = (fg: number, _bg?: number) => {
      curColor = VGA_TO_ARGB[fg & 15] ?? Colors.LIGHT_GREY;
      term.setColor(curColor);
    };
    (terminal as any).clear        = () => { term.clear(); };

    // Same IIFE-sentinel eval as evalAndPrint() in repl.ts
    const exprWrapped =
      '(function(){' +
      'var __r=(' + code + ');' +
      'if(__r===undefined)return"__JSOS_UNDEF__";' +
      'if(__r===null)return"null";' +
      'if(__r instanceof Error)return String(__r);' +
      'if(__r&&typeof __r.__jsos_print__==="function"){__r.__jsos_print__();return"__JSOS_PRINTED__";}' +
      'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
      'return String(__r);' +
      '})()';

    let result = '';
    try {
      result = kernel.eval(exprWrapped);
      // Statement syntax (var/function/for/if …) — re-eval directly
      if (result.indexOf('SyntaxError') === 0) {
        result = kernel.eval(code);
      }
    } finally {
      // Always restore — even if eval throws
      (terminal as any).print        = saved.print;
      (terminal as any).println      = saved.println;
      (terminal as any).colorPrint   = saved.colorPrint;
      (terminal as any).colorPrintln = saved.colorPrintln;
      (terminal as any).setColor     = saved.setColor;
      (terminal as any).clear        = saved.clear;
    }

    if (result === '__JSOS_PRINTED__') return;                        // pretty-printer ran
    if (result === '__JSOS_UNDEF__' || result === 'undefined') return; // void return

    // Colour-code the result the same way the text-mode REPL does
    term.setColor(
      result === 'null'                                                      ? Colors.DARK_GREY   :
      result === 'true' || result === 'false'                                ? Colors.YELLOW      :
      result.indexOf('Error:') !== -1                                        ? Colors.LIGHT_RED   :
      result.length > 0 && result[0] === '"'                                 ? Colors.LIGHT_GREEN :
      result !== 'Infinity' && result !== '-Infinity' &&
        result !== 'NaN' && !isNaN(Number(result))                           ? Colors.LIGHT_CYAN  :
      Colors.WHITE
    );
    term.println(result);
    term.setColor(Colors.LIGHT_GREY);
  }
}

export const terminalApp = new TerminalApp();

// ── Terminal Tabs (Item 654) ──────────────────────────────────────────────────

/** A lightweight record for one terminal tab. */
interface TerminalTab {
  id: number;
  title: string;
  inputBuf: string;
  history: string[];
  historyPos: number;
}

/**
 * [Item 654] TerminalTabManager — manages multiple independent terminal
 * tabs.  Ctrl+T opens a new tab, Ctrl+W closes the active tab, and
 * Ctrl+Tab / Ctrl+Shift+Tab cycle through open tabs.
 *
 * Each tab gets its own input buffer and command history so switching back
 * and forth does not clobber the user's work-in-progress.
 */
export class TerminalTabManager {
  private _tabs: TerminalTab[] = [];
  private _activeId: number    = 0;
  private _nextId: number      = 1;

  constructor() { this._newTab(); }       // always starts with one tab

  /** Number of open tabs. */
  get count(): number { return this._tabs.length; }

  /** ID of the currently active tab. */
  get activeId(): number { return this._activeId; }

  /** Open a fresh tab and make it active. */
  openTab(): TerminalTab {
    var tab = this._newTab();
    return tab;
  }

  /** Close the tab with `id`.  Switches to the previous tab when possible.
   *  Ignored when only one tab is open. */
  closeTab(id: number): void {
    if (this._tabs.length <= 1) return;
    var idx = this._tabs.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return;
    this._tabs.splice(idx, 1);
    if (this._activeId === id) {
      var nextIdx = Math.max(0, idx - 1);
      this._activeId = this._tabs[nextIdx].id;
    }
  }

  /** Activate the next tab (wraps around). */
  nextTab(): TerminalTab {
    var idx = this._tabs.findIndex((t) => t.id === this._activeId);
    var nextIdx = (idx + 1) % this._tabs.length;
    this._activeId = this._tabs[nextIdx].id;
    return this._tabs[nextIdx];
  }

  /** Activate the previous tab (wraps around). */
  prevTab(): TerminalTab {
    var idx = this._tabs.findIndex((t) => t.id === this._activeId);
    var prevIdx = (idx - 1 + this._tabs.length) % this._tabs.length;
    this._activeId = this._tabs[prevIdx].id;
    return this._tabs[prevIdx];
  }

  /** Return the active tab record. */
  activeTab(): TerminalTab {
    return this._tabs.find((t) => t.id === this._activeId)!;
  }

  /** Return a shallow copy of all tab records (for rendering a tab bar). */
  listTabs(): TerminalTab[] { return this._tabs.slice(); }

  /** Rename a tab. */
  renameTab(id: number, title: string): void {
    var tab = this._tabs.find(function(t) { return t.id === id; });
    if (tab) tab.title = title;
  }

  /** Handle a key event; returns `true` when the key was consumed. */
  handleKey(key: string, ctrlKey: boolean): boolean {
    if (!ctrlKey) return false;
    if (key === 't' || key === 'T') { this.openTab();  return true; }
    if (key === 'w' || key === 'W') { this.closeTab(this._activeId); return true; }
    if (key === 'Tab')              { this.nextTab();  return true; }
    return false;
  }

  private _newTab(): TerminalTab {
    var tab: TerminalTab = {
      id: this._nextId++,
      title: 'Terminal ' + this._tabs.length,
      inputBuf: '',
      history: [],
      historyPos: -1,
    };
    this._tabs.push(tab);
    this._activeId = tab.id;
    return tab;
  }
}

export const terminalTabManager = new TerminalTabManager();

