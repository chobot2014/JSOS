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

import { Canvas, Colors, defaultFont } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

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
    try {
      var result = kernel.eval(code);
      this._term.setColor(Colors.YELLOW);
      this._term.println(result || 'undefined');
      this._term.setColor(Colors.LIGHT_GREY);
    } catch (e) {
      this._term.setColor(Colors.LIGHT_RED);
      this._term.println('Error: ' + String(e));
      this._term.setColor(Colors.LIGHT_GREY);
    }
  }
}

export const terminalApp = new TerminalApp();
