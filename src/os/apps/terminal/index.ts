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

import { Canvas, Colors, defaultFont, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';
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

  onMount(win: WMWindow): void {
    this._win  = win;
    this._term = new CanvasTerminal(win.canvas);
    this._dirty = true;
    this._printWelcome();
    this._printPrompt();
  }

  onUnmount(): void {
    this._term = null;
    this._win  = null;
  }

  onKey(event: KeyEvent): void {
    if (!this._term) return;
    var ch = event.ch;
    if (!ch || ch.length === 0) return;
    this._dirty = true;   // any keystroke modifies the canvas

    if (ch === '\n' || ch === '\r') {
      this._term.print('\n');
      this._eval(this._inputBuf.trim());
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

  onMouse(_event: MouseEvent): void { /* no-op for terminal */ }

  render(_canvas: Canvas): boolean {
    // Terminal writes directly into win.canvas during onKey() / print().
    // Here we just signal whether it's been modified since the last frame.
    if (!this._dirty) return false;
    this._dirty = false;
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
