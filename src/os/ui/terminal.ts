/**
 * JSOS Terminal
 *
 * Full terminal emulator implemented in TypeScript over raw VGA primitives.
 * This replaces ALL of the old terminal.c logic  scrolling, character
 * processing, colour state, scrollback buffer, and readline are here.
 * The C layer only writes individual VGA cells.
 */

import { Color } from '../core/kernel.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

var VGA_W = 80;
var VGA_H = 25;
var SCROLLBACK = 200;

// A row is stored as Uint16Array of VGA cells: (colorByte<<8)|charCode
type Row = Uint16Array;

function blankRow(color: number): Row {
  var r = new Uint16Array(VGA_W);
  var cell = ((color & 0xFF) << 8) | 0x20; // space
  for (var i = 0; i < VGA_W; i++) r[i] = cell;
  return r;
}

export class Terminal {
  // Logical cursor tracked in JavaScript
  private _row = 0;
  private _col = 0;
  // colorByte = (bg<<4)|fg
  private _color = 0x07; // light-grey on black

  // Screen mirror (what is currently on screen)
  private _screen: Row[] = [];

  // Scrollback ring buffer
  private _sb: Row[] = [];
  private _sbWrite = 0;
  private _sbCount = 0;

  // Scroll-view state
  private _viewOffset = 0;

  readonly width = VGA_W;
  readonly height = VGA_H;

  constructor() {
    for (var i = 0; i < VGA_H; i++) this._screen.push(blankRow(0x07));
    for (var i = 0; i < SCROLLBACK; i++) this._sb.push(new Uint16Array(VGA_W));
  }

  //  Colour management 

  setColor(fg: number, bg: number = Color.BLACK): void {
    this._color = ((bg & 0x7) << 4) | (fg & 0xF);
  }

  getColor(): number { return this._color; }

  /** Push a new colour; returns the old colorByte for popColor() */
  pushColor(fg: number, bg: number = Color.BLACK): number {
    var saved = this._color;
    this.setColor(fg, bg);
    return saved;
  }

  /** Restore a color byte previously returned by pushColor() */
  popColor(saved: number): void {
    this._color = saved & 0xFF;
  }

  //  Low-level cell write 

  private _put(row: number, col: number, ch: string, color: number): void {
    var cell = ((color & 0xFF) << 8) | (ch.charCodeAt(0) & 0xFF);
    this._screen[row][col] = cell;
    kernel.vgaPut(row, col, ch, color);
  }

  //  Scrolling 

  private _scroll(): void {
    // Push evicted top row into scrollback ring
    var dst = this._sb[this._sbWrite];
    var src = this._screen[0];
    for (var c = 0; c < VGA_W; c++) dst[c] = src[c];
    this._sbWrite = (this._sbWrite + 1) % SCROLLBACK;
    if (this._sbCount < SCROLLBACK) this._sbCount++;

    // Shift screen buffer up and update VGA
    for (var r = 0; r < VGA_H - 1; r++) {
      var from = this._screen[r + 1];
      var to   = this._screen[r];
      for (var c = 0; c < VGA_W; c++) to[c] = from[c];
      kernel.vgaCopyRow(r, r + 1);
    }

    // Clear bottom row
    var blank = ((this._color & 0xFF) << 8) | 0x20;
    var last = this._screen[VGA_H - 1];
    for (var c = 0; c < VGA_W; c++) last[c] = blank;
    kernel.vgaFillRow(VGA_H - 1, ' ', this._color);

    this._row = VGA_H - 1;
  }

  //  Character output 

  /**
   * Internal: process one character for VGA output only.
   * Does NOT write to serial and does NOT update the hardware cursor.
   * Call putchar() for interactive single-char I/O, or let print()/println()
   * batch serial + cursor for bulk text (1 C call each vs N per character).
   */
  private _putchar_vga(ch: string): void {
    var code = ch.charCodeAt(0);
    if (code === 10) {        // \n  newline
      this._col = 0;
      this._row++;
      if (this._row >= VGA_H) this._scroll();

    } else if (code === 13) { // \r  carriage return
      this._col = 0;

    } else if (code === 8) {  // \b  backspace
      if (this._col > 0) {
        this._col--;
        this._put(this._row, this._col, ' ', this._color);
      }

    } else if (code === 9) {  // \t  tab to next 8-col boundary
      var next = (this._col + 8) & ~7;
      if (next >= VGA_W) {
        this._col = 0; this._row++;
        if (this._row >= VGA_H) this._scroll();
      } else {
        while (this._col < next) { this._put(this._row, this._col, ' ', this._color); this._col++; }
      }

    } else {                  // printable
      this._put(this._row, this._col, ch, this._color);
      this._col++;
      if (this._col >= VGA_W) {
        this._col = 0; this._row++;
        if (this._row >= VGA_H) this._scroll();
      }
    }
  }

  /** Output a single character with immediate serial mirror and cursor update.
   *  Use this for interactive character-by-character I/O (readline echo, etc.). */
  putchar(ch: string): void {
    if (this._viewOffset !== 0) this.resumeLive();
    kernel.serialPut(ch);          // serial mirror
    this._putchar_vga(ch);         // VGA
    kernel.vgaSetCursor(this._row, this._col);  // cursor
  }

  /** Print a string (no automatic newline).
   *  Batches serial into 1 C call and cursor into 1 C call regardless of length. */
  print(text: string): void {
    if (this._viewOffset !== 0) this.resumeLive();
    kernel.serialPut(text);   // 1 serial call for the whole string
    for (var i = 0; i < text.length; i++) this._putchar_vga(text[i]);
    kernel.vgaSetCursor(this._row, this._col);   // 1 cursor update at end
  }

  /** Print a string followed by a newline */
  println(text: string = ''): void {
    this.print(text + '\n');
  }

  /** Print with a temporary colour, then restore */
  colorPrint(text: string, fg: number, bg: number = Color.BLACK): void {
    var saved = this.pushColor(fg, bg);
    this.print(text);
    this.popColor(saved);
  }

  /** Print with a temporary colour + newline */
  colorPrintln(text: string, fg: number, bg: number = Color.BLACK): void {
    var saved = this.pushColor(fg, bg);
    this.println(text);
    this.popColor(saved);
  }

  //  Screen control 

  clear(): void {
    kernel.vgaFill(' ', 0x07);
    for (var r = 0; r < VGA_H; r++) {
      var row = this._screen[r];
      for (var c = 0; c < VGA_W; c++) row[c] = 0x0720;
    }
    this._row = 0; this._col = 0; this._color = 0x07;
    this._viewOffset = 0;
    kernel.vgaSetCursor(0, 0);
  }

  setCursor(row: number, col: number): void {
    this._row = row; this._col = col;
    kernel.vgaSetCursor(row, col);
  }

  getCursor(): { row: number; col: number } { return { row: this._row, col: this._col }; }

  get screenSize(): { width: number; height: number } { return { width: VGA_W, height: VGA_H }; }

  //  Direct row write (editor / full-screen use) 
  /** Write 80 chars directly to a VGA row without cursor or scroll side-effects */
  drawRow(row: number, text: string, colorByte: number): void {
    kernel.vgaDrawRow(row, text, colorByte);
    // Keep screen mirror in sync so scrollback is accurate
    var r = this._screen[row];
    for (var c = 0; c < VGA_W; c++) {
      var ch = c < text.length ? text.charCodeAt(c) : 0x20;
      r[c] = ((colorByte & 0xFF) << 8) | (ch & 0xFF);
    }
  }

  //  Scrollback view 

  scrollViewUp(n: number = 20): void {
    if (this._sbCount === 0) return;
    if (this._viewOffset === 0) {
      kernel.vgaHideCursor();
    }
    this._viewOffset += n;
    if (this._viewOffset > this._sbCount) this._viewOffset = this._sbCount;
    this._renderScrollback();
  }

  scrollViewDown(n: number = 20): void {
    if (this._viewOffset === 0) return;
    this._viewOffset -= n;
    if (this._viewOffset < 0) this._viewOffset = 0;
    if (this._viewOffset === 0) this._restoreLive();
    else this._renderScrollback();
  }

  resumeLive(): void {
    if (this._viewOffset === 0) return;
    this._viewOffset = 0;
    this._restoreLive();
  }

  getViewOffset(): number { return this._viewOffset; }

  private _restoreLive(): void {
    for (var r = 0; r < VGA_H; r++) {
      var row = this._screen[r];
      for (var c = 0; c < VGA_W; c++) {
        var cell = row[c];
        kernel.vgaPut(r, c, String.fromCharCode(cell & 0xFF), (cell >> 8) & 0xFF);
      }
    }
    kernel.vgaShowCursor();
    kernel.vgaSetCursor(this._row, this._col);
  }

  private _renderScrollback(): void {
    for (var r = 0; r < VGA_H; r++) {
      var tapeIdx = r + this._sbCount - this._viewOffset;
      if (tapeIdx < 0) {
        kernel.vgaFillRow(r, ' ', 0x07);
      } else if (tapeIdx < this._sbCount) {
        var sbAbs = this._sbWrite - this._sbCount + tapeIdx;
        var idx = ((sbAbs % SCROLLBACK) + SCROLLBACK) % SCROLLBACK;
        var buf = this._sb[idx];
        for (var c = 0; c < VGA_W; c++) {
          var cell = buf[c];
          kernel.vgaPut(r, c, String.fromCharCode(cell & 0xFF), (cell >> 8) & 0xFF);
        }
      } else {
        var liveR = tapeIdx - this._sbCount;
        if (liveR < VGA_H) {
          var live2 = this._screen[liveR];
          for (var c = 0; c < VGA_W; c++) {
            var cell2 = live2[c];
            kernel.vgaPut(r, c, String.fromCharCode(cell2 & 0xFF), (cell2 >> 8) & 0xFF);
          }
        }
      }
    }
  }

  //  readline (moved from C) 
  /**
   * Read a line with echo, backspace, Ctrl+C and Ctrl+U support.
   * Returns the line without the trailing newline.
   */
  readLine(prompt: string = ''): string {
    if (prompt) this.print(prompt);
    var line = '';
    for (;;) {
      var ev = kernel.waitKeyEx();
      if (ev.ext !== 0) continue; // ignore special keys in readline
      var code = ev.ch.charCodeAt(0);
      if (code === 13 || code === 10) {  // Enter
        this.putchar('\n'); break;
      } else if (code === 8 || code === 127) {  // Backspace
        if (line.length > 0) {
          line = line.slice(0, -1);
          this.putchar('\b'); this.putchar(' '); this.putchar('\b');
        }
      } else if (code === 3) {   // Ctrl+C
        this.println('^C'); return '';
      } else if (code === 21) {  // Ctrl+U
        while (line.length > 0) {
          line = line.slice(0, -1);
          this.putchar('\b'); this.putchar(' '); this.putchar('\b');
        }
      } else if (code >= 32 && code < 127) {
        line += ev.ch; this.putchar(ev.ch);
      }
    }
    return line;
  }

  //  Convenience helpers 

  rule(char: string = '-', width: number = VGA_W): void {
    var line = '';
    for (var i = 0; i < width; i++) line += char;
    this.println(line);
  }

  printCentered(text: string): void {
    var pad = Math.floor((VGA_W - text.length) / 2);
    var sp = ''; for (var i = 0; i < pad; i++) sp += ' ';
    this.println(sp + text);
  }

  printRow(columns: string[], widths: number[]): void {
    var row = '';
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i] || '';
      var w = widths[i] || 10;
      if (col.length > w) col = col.substring(0, w - 1) + '.';
      while (col.length < w) col += ' ';
      row += col;
    }
    this.println(row);
  }

  waitKey(): string  { return kernel.waitKey(); }
  hasKey(): boolean  { return kernel.hasKey(); }
  pollKey(): string  { return kernel.readKey(); }

  success(text: string): void { this.colorPrint('[OK] ',   Color.LIGHT_GREEN); this.println(text); }
  error(text: string):   void { this.colorPrint('[ERR] ',  Color.LIGHT_RED);   this.println(text); }
  warn(text: string):    void { this.colorPrint('[WARN] ', Color.YELLOW);      this.println(text); }
  info(text: string):    void { this.colorPrint('[INFO] ', Color.LIGHT_CYAN);  this.println(text); }
  debug(text: string):   void { this.colorPrint('[DBG] ',  Color.DARK_GREY);   this.println(text); }
}

const terminal = new Terminal();
export default terminal;
