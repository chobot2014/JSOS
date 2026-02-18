# Kernel API (`kernel.*`)

The `kernel` object is a global injected by the C runtime before any JavaScript runs. It is the direct bridge between JavaScript and bare-metal hardware.

All functions are registered in `src/kernel/quickjs_binding.c` and typed in `src/os/kernel.ts`.

---

## Terminal

### `kernel.print(message: string): void`
Print `message` to the VGA terminal followed by a newline.

```js
kernel.print('Hello, world!')
```

### `kernel.printRaw(message: string): void`
Print `message` to the VGA terminal with **no newline**. Use this for inline output (prompts, colour blocks, progress bars).

```js
kernel.printRaw('Loading')
for (var i = 0; i < 5; i++) { sleep(100); kernel.printRaw('.') }
kernel.print('')  // newline
```

### `kernel.putchar(char: string): void`
Print a single character. Equivalent to `kernel.printRaw(char[0])`.

### `kernel.clear(): void`
Clear the entire screen (fills with spaces at current colour, moves cursor to 0,0).

```js
kernel.clear()
```

---

## Colors & Cursor

### `kernel.setColor(fg: number, bg: number): void`
Set the foreground and background colour for all subsequent output.

```js
kernel.setColor(14, 0)   // Yellow on Black
kernel.print('Warning!')
kernel.setColor(7, 0)    // restore Light Grey on Black
```

See [Color Constants](#color-constants) below.

### `kernel.getColor(): number`
Return the current colour byte: `(bg << 4) | fg`.

```js
var saved = kernel.getColor()
kernel.setColor(12, 0)
kernel.print('error')
kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F)
```

### `kernel.setCursor(row: number, col: number): void`
Move the hardware cursor to `(row, col)` (0-indexed).

```js
kernel.setCursor(12, 40)   // centre of an 80×25 screen
```

### `kernel.getCursor(): { row: number; col: number }`
Return the current cursor position.

```js
var pos = kernel.getCursor()
print(pos.row + ', ' + pos.col)
```

### `kernel.getScreenSize(): { width: number; height: number }`
Return the terminal dimensions. Always `{ width: 80, height: 25 }` on standard VGA text mode.

```js
var sc = kernel.getScreenSize()
// sc.width === 80, sc.height === 25
```

---

## Color Constants

Defined as a sub-object on `kernel.colors` and also as the TypeScript `Color` enum.

| Name | Value | Description |
|---|---|---|
| `BLACK` | 0 | |
| `BLUE` | 1 | |
| `GREEN` | 2 | |
| `CYAN` | 3 | |
| `RED` | 4 | |
| `MAGENTA` | 5 | |
| `BROWN` | 6 | |
| `LIGHT_GREY` | 7 | Default text colour |
| `DARK_GREY` | 8 | |
| `LIGHT_BLUE` | 9 | |
| `LIGHT_GREEN` | 10 | |
| `LIGHT_CYAN` | 11 | |
| `LIGHT_RED` | 12 | |
| `LIGHT_MAGENTA` | 13 | |
| `YELLOW` | 14 | |
| `WHITE` | 15 | Bright white |

```js
kernel.setColor(kernel.colors.YELLOW, kernel.colors.BLACK)
kernel.print('bright!')
kernel.setColor(7, 0)
```

---

## Memory

### `kernel.getMemoryInfo(): { total: number; free: number; used: number }`
Return heap statistics in bytes.

```js
var m = kernel.getMemoryInfo()
print(Math.floor(m.free / 1024) + ' KB free')
```

The values reflect the QuickJS heap, not physical RAM.

---

## Keyboard

### `kernel.waitKey(): string`
Block until a printable key is pressed. Returns a one-character string.  
Does **not** detect arrow keys or other extended keys.

```js
kernel.print('Press any key...')
var ch = kernel.waitKey()
kernel.print('You pressed: ' + ch)
```

### `kernel.waitKeyEx(): { ch: string; ext: number }`
Block until any key is pressed (including arrow keys, function keys, etc.).

| Field | Meaning |
|---|---|
| `ch` | Printable character, or `""` if it was an extended key |
| `ext` | `0` for printable keys; extended code for special keys |

Extended key codes:

| `ext` | Key |
|---|---|
| `0x80` | Arrow Up |
| `0x81` | Arrow Down |
| `0x82` | Arrow Left (reserved) |
| `0x83` | Arrow Right (reserved) |

```js
var key = kernel.waitKeyEx()
if (key.ext === 0x80) print('UP pressed')
else if (key.ch) print('typed: ' + key.ch)
```

This is what the REPL uses internally for its readline loop.

### `kernel.readKey(): string`
Non-blocking key poll. Returns `""` if no key is available.

```js
// Busy-wait for a key
var ch = ''
while (!ch) ch = kernel.readKey()
```

### `kernel.hasKey(): boolean`
Return `true` if a key is waiting in the keyboard buffer.

```js
if (kernel.hasKey()) {
  var k = kernel.readKey()
  print('buffered key: ' + k)
}
```

### `kernel.readline(): string`
Read a full line from the keyboard (blocking, with backspace support but no history/colours). Used internally before the REPL is set up.

---

## Timer

### `kernel.getTicks(): number`
Return the raw PIT tick count. The timer runs at **100 Hz** (100 ticks/second).

```js
var start = kernel.getTicks()
sleep(1000)
print(kernel.getTicks() - start + ' ticks')  // ~100
```

### `kernel.getUptime(): number`
Return milliseconds since boot (derived from tick count).

```js
print(kernel.getUptime() + 'ms since boot')
```

### `kernel.sleep(ms: number): void`
Block for approximately `ms` milliseconds. Accuracy is limited to the PIT resolution (~10 ms per tick).

```js
kernel.sleep(500)   // pause 0.5 s
```

---

## System Control

### `kernel.halt(): void`
Execute `cli; hlt` — disable interrupts and halt the CPU. The system must be hard-reset to recover.

```js
kernel.halt()
```

### `kernel.reboot(): void`
Reboot by pulsing the PS/2 controller reset line (`outb(0x64, 0xFE)`).

```js
kernel.reboot()
```

---

## JavaScript Eval

### `kernel.eval(code: string): string`
Evaluate `code` in the **current** QuickJS context and return the result as a string.

- Exceptions are caught and returned as `"TypeError: ..."`, etc.
- Objects are converted via `JS_ToCString` (not JSON — use `JSON.stringify` in the code if needed).
- Returns `"undefined"` for statements with no return value.

```js
kernel.eval('2 + 2')              // → "4"
kernel.eval('typeof undefined')   // → "undefined"
kernel.eval('({a:1})')            // → "[object Object]"
kernel.eval('JSON.stringify({a:1})')  // → '{"a":1}'
```

> **Note:** The REPL's `evalAndPrint` wraps expressions in an IIFE to capture the return value, so it gets proper JSON output. Direct `kernel.eval` just stringifies the result.

---

## Port I/O

These are for advanced / low-level hardware hacking.

### `kernel.inb(port: number): number`
Read one byte from x86 I/O port `port`.

```js
kernel.inb(0x60)   // PS/2 data port — read last scan code
```

### `kernel.outb(port: number, value: number): void`
Write one byte to x86 I/O port `port`.

```js
kernel.outb(0x80, 0)   // POST port — harmless debug delay
```

---

## Full TypeScript Interface

```typescript
interface KernelAPI {
  // Terminal
  print(message: string): void;
  printRaw(message: string): void;
  putchar(char: string): void;
  clear(): void;

  // Colors & cursor
  setColor(fg: number, bg: number): void;
  getColor(): number;
  setCursor(row: number, col: number): void;
  getCursor(): { row: number; col: number };
  getScreenSize(): { width: number; height: number };
  colors: {
    BLACK: 0; BLUE: 1; GREEN: 2; CYAN: 3; RED: 4;
    MAGENTA: 5; BROWN: 6; LIGHT_GREY: 7; DARK_GREY: 8;
    LIGHT_BLUE: 9; LIGHT_GREEN: 10; LIGHT_CYAN: 11;
    LIGHT_RED: 12; LIGHT_MAGENTA: 13; YELLOW: 14; WHITE: 15;
  };

  // Memory
  getMemoryInfo(): { total: number; free: number; used: number };

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
}
```

---

## `console` Polyfill

The kernel also installs a basic `console` object in JavaScript during `quickjs_initialize()`:

```js
console.log(...)    // → kernel.print(args.join(' '))
console.error(...)  // → kernel.print('ERROR: ' + args.join(' '))
console.warn(...)   // → kernel.print('WARN: ' + args.join(' '))
console.clear()     // → kernel.clear()
```

And a `Date` polyfill:
```js
Date.now()          // → kernel.getUptime()  (ms since boot)
```
