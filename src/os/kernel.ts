/**
 * JSOS Kernel Bindings
 * TypeScript declarations for the C kernel API exposed through QuickJS
 * These functions are injected as globals by the kernel before JS execution
 */

/** Color constants matching VGA hardware colors */
export const enum Color {
  BLACK = 0,
  BLUE = 1,
  GREEN = 2,
  CYAN = 3,
  RED = 4,
  MAGENTA = 5,
  BROWN = 6,
  LIGHT_GREY = 7,
  DARK_GREY = 8,
  LIGHT_BLUE = 9,
  LIGHT_GREEN = 10,
  LIGHT_CYAN = 11,
  LIGHT_RED = 12,
  LIGHT_MAGENTA = 13,
  YELLOW = 14,
  WHITE = 15,
}

export interface MemoryInfo {
  total: number;
  free: number;
  used: number;
}

export interface CursorPosition {
  row: number;
  col: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface KernelColors {
  BLACK: number;
  BLUE: number;
  GREEN: number;
  CYAN: number;
  RED: number;
  MAGENTA: number;
  BROWN: number;
  LIGHT_GREY: number;
  DARK_GREY: number;
  LIGHT_BLUE: number;
  LIGHT_GREEN: number;
  LIGHT_CYAN: number;
  LIGHT_RED: number;
  LIGHT_MAGENTA: number;
  YELLOW: number;
  WHITE: number;
}

/** The kernel object injected by the C runtime */
export interface KernelAPI {
  // Terminal
  print(message: string): void;
  printRaw(message: string): void;
  putchar(char: string): void;
  clear(): void;
  
  // Colors & cursor
  setColor(fg: number, bg: number): void;
  getColor(): number;
  setCursor(row: number, col: number): void;
  getCursor(): CursorPosition;
  getScreenSize(): ScreenSize;
  colors: KernelColors;
  
  // Memory
  getMemoryInfo(): MemoryInfo;
  
  // Keyboard
  readKey(): string;
  waitKey(): string;
  waitKeyEx(): { ch: string; ext: number };
  hasKey(): boolean;
  readline(): string;
  
  // Timer
  getTicks(): number;
  getUptime(): number;
  sleep(ms: number): void;
  
  // System
  halt(): void;
  reboot(): void;
  
  // Eval
  eval(code: string): string;
  
  // Port I/O
  inb(port: number): number;
  outb(port: number, value: number): void;

  // Scrollback view (PgUp/PgDown support)
  // Key codes: UP=0x80 DOWN=0x81 LEFT=0x82 RIGHT=0x83
  //            HOME=0x84 END=0x85 PAGEUP=0x86 PAGEDOWN=0x87 DELETE=0x88
  scrollUp(n?: number): void;    // scroll view up N lines (default 20)
  scrollDown(n?: number): void;  // scroll view down N lines (default 20)
  resumeLive(): void;            // snap back to live view instantly
  getViewOffset(): number;       // 0 = live; N = scrolled N lines up

  // Direct VGA row write — no cursor/scroll side-effects (for editor)
  // colorByte = (bg << 4) | fg  (bg 0-7 to avoid blink)
  drawRow(row: number, text: string, colorByte: number): void;
}

// Declare the global kernel object
declare var kernel: KernelAPI;
