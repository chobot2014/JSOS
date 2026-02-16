/**
 * JSOS Terminal Module
 * High-level terminal abstraction over kernel VGA primitives
 */

import { Color, ScreenSize } from './kernel.js';

declare var kernel: import('./kernel.js').KernelAPI;

export class Terminal {
  private savedColor: number = 0;

  get screenSize(): ScreenSize {
    return kernel.getScreenSize();
  }

  /** Print text with a newline */
  println(text: string = ''): void {
    kernel.print(text);
  }

  /** Print text without a newline */
  print(text: string): void {
    kernel.printRaw(text);
  }

  /** Clear the entire screen */
  clear(): void {
    kernel.clear();
  }

  /** Set foreground and background colors */
  setColor(fg: number, bg: number = Color.BLACK): void {
    kernel.setColor(fg, bg);
  }

  /** Save current color and set a new one */
  pushColor(fg: number, bg: number = Color.BLACK): void {
    this.savedColor = kernel.getColor();
    kernel.setColor(fg, bg);
  }

  /** Restore previously saved color */
  popColor(): void {
    kernel.setColor(this.savedColor & 0x0F, (this.savedColor >> 4) & 0x0F);
  }

  /** Print colored text, then restore color */
  colorPrint(text: string, fg: number, bg: number = Color.BLACK): void {
    this.pushColor(fg, bg);
    kernel.printRaw(text);
    this.popColor();
  }

  /** Print colored text with newline */
  colorPrintln(text: string, fg: number, bg: number = Color.BLACK): void {
    this.pushColor(fg, bg);
    kernel.print(text);
    this.popColor();
  }

  /** Print a horizontal rule */
  rule(char: string = '-', width: number = 0): void {
    var w = width || this.screenSize.width;
    var line = '';
    for (var i = 0; i < w; i++) {
      line += char;
    }
    this.println(line);
  }

  /** Set cursor position */
  setCursor(row: number, col: number): void {
    kernel.setCursor(row, col);
  }

  /** Print text centered on the screen */
  printCentered(text: string): void {
    var pad = Math.floor((this.screenSize.width - text.length) / 2);
    var spaces = '';
    for (var i = 0; i < pad; i++) spaces += ' ';
    this.println(spaces + text);
  }

  /** Print a table row */
  printRow(columns: string[], widths: number[]): void {
    var row = '';
    for (var i = 0; i < columns.length; i++) {
      var col = columns[i] || '';
      var w = widths[i] || 10;
      // Pad or truncate to width
      if (col.length > w) {
        col = col.substring(0, w - 1) + '.';
      }
      while (col.length < w) {
        col += ' ';
      }
      row += col;
    }
    this.println(row);
  }

  /** Read a line of input from the user */
  readLine(prompt: string = ''): string {
    if (prompt) {
      this.print(prompt);
    }
    return kernel.readline();
  }

  /** Wait for a single keypress */
  waitKey(): string {
    return kernel.waitKey();
  }

  /** Check if a key is available */
  hasKey(): boolean {
    return kernel.hasKey();
  }

  /** Poll for a key (non-blocking) */
  pollKey(): string {
    return kernel.readKey();
  }

  /** Print a success message */
  success(text: string): void {
    this.colorPrint('[OK] ', Color.LIGHT_GREEN);
    this.println(text);
  }

  /** Print an error message */
  error(text: string): void {
    this.colorPrint('[ERR] ', Color.LIGHT_RED);
    this.println(text);
  }

  /** Print a warning message */
  warn(text: string): void {
    this.colorPrint('[WARN] ', Color.YELLOW);
    this.println(text);
  }

  /** Print an info message */
  info(text: string): void {
    this.colorPrint('[INFO] ', Color.LIGHT_CYAN);
    this.println(text);
  }

  /** Print a debug message */
  debug(text: string): void {
    this.colorPrint('[DBG] ', Color.DARK_GREY);
    this.println(text);
  }
}

const terminal = new Terminal();
export default terminal;
