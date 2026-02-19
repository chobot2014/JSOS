/**
 * JSOS Kernel Bindings
 *
 * TypeScript declarations for the raw platform API exposed by QuickJS.
 * This is the ONLY interface between JavaScript and hardware.
 * All higher-level OS behaviour (terminal, readline, scrollback) is in TypeScript.
 */

/** VGA colour indices (0-15) */
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

export interface MemoryInfo { total: number; free: number; used: number; }
export interface ScreenSize  { width: number; height: number; }
export interface CursorPosition { row: number; col: number; }

export interface KernelColors {
  BLACK: number; BLUE: number; GREEN: number; CYAN: number;
  RED: number; MAGENTA: number; BROWN: number; LIGHT_GREY: number;
  DARK_GREY: number; LIGHT_BLUE: number; LIGHT_GREEN: number;
  LIGHT_CYAN: number; LIGHT_RED: number; LIGHT_MAGENTA: number;
  YELLOW: number; WHITE: number;
}

/**
 * Raw platform API injected by the C kernel into the QuickJS global scope.
 * Only hardware primitives live here  no string formatting, no state.
 */
export interface KernelAPI {
  //  VGA raw cell access 
  /** Write one character at (row, col) with colorByte = (bg<<4)|fg */
  vgaPut(row: number, col: number, ch: string, colorByte: number): void;
  /** Read VGA cell: (colorByte<<8) | charCode */
  vgaGet(row: number, col: number): number;
  /** Write exactly 80 chars to a row; shorter text is space-padded */
  vgaDrawRow(row: number, text: string, colorByte: number): void;
  /** Copy srcRow to dstRow directly in VGA buffer */
  vgaCopyRow(dstRow: number, srcRow: number): void;
  /** Fill a single row with ch + colorByte */
  vgaFillRow(row: number, ch: string, colorByte: number): void;
  /** Fill the entire 8025 VGA buffer */
  vgaFill(ch: string, colorByte: number): void;
  /** Move the hardware blinking cursor */
  vgaSetCursor(row: number, col: number): void;
  /** Hide hardware cursor (entering raw/full-screen mode) */
  vgaHideCursor(): void;
  /** Show hardware cursor */
  vgaShowCursor(): void;
  /** Returns {width: 80, height: 25} */
  getScreenSize(): ScreenSize;
  /** Screen width (80) */
  screenWidth: number;
  /** Screen height (25) */
  screenHeight: number;

  //  Keyboard (raw, no echo) 
  /** Non-blocking poll; returns '' when nothing is ready */
  readKey(): string;
  /** Blocking; waits for next printable character */
  waitKey(): string;
  /** Blocking; returns {ch, ext}  ext != 0 for special/extended keys */
  waitKeyEx(): { ch: string; ext: number };
  /** Returns true if a keypress is queued */
  hasKey(): boolean;

  //  Timer 
  getTicks(): number;
  getUptime(): number;   /* milliseconds since boot */
  sleep(ms: number): void;

  //  Memory 
  getMemoryInfo(): MemoryInfo;

  //  Port I/O 
  inb(port: number): number;
  outb(port: number, value: number): void;

  //  Native code execution 
  /** Call a void C/ASM function at the given 32-bit address */
  callNative(addr: number): void;
  /** Call a C/ASM function at addr with up to 3 int32 args; returns int32 */
  callNativeI(addr: number, a0?: number, a1?: number, a2?: number): number;
  /** Read one byte from a physical memory address */
  readMem8(addr: number): number;
  /** Write one byte to a physical memory address */
  writeMem8(addr: number, value: number): void;

  //  System 
  halt(): void;
  reboot(): void;
  /** Evaluate a JS string in the global QuickJS context; returns result as string */
  eval(code: string): string;
  /** Write a string to the serial port (COM1) — appears on QEMU -serial stdio */
  serialPut(s: string): void;
  /** Read one byte from COM1; returns -1 if no data available */
  serialGetchar(): number;

  // ─ ATA block device ─────────────────────────────────────────────────────
  /** Returns true if an ATA drive was detected at boot */
  ataPresent(): boolean;
  /**
   * Read `sectors` (1-8) sectors starting at `lba`.
   * Returns a flat byte array of length `sectors * 512`, or null on error.
   */
  ataRead(lba: number, sectors: number): number[] | null;
  /**
   * Write `sectors` (1-8) sectors starting at `lba`.
   * `data` must be a flat byte array of exactly `sectors * 512` bytes.
   * Returns true on success.
   */
  ataWrite(lba: number, sectors: number, data: number[]): boolean;

  //  Constants 
  colors: KernelColors;
  KEY_UP: number;    KEY_DOWN: number;   KEY_LEFT: number;  KEY_RIGHT: number;
  KEY_HOME: number;  KEY_END: number;    KEY_PAGEUP: number; KEY_PAGEDOWN: number;
  KEY_DELETE: number;
  KEY_F1: number; KEY_F2: number; KEY_F3: number;  KEY_F4: number;
  KEY_F5: number; KEY_F6: number; KEY_F7: number;  KEY_F8: number;
  KEY_F9: number; KEY_F10: number; KEY_F11: number; KEY_F12: number;
}

declare var kernel: KernelAPI;
