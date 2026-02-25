# JSOS SDK — Remaining Implementation Plan

**Date:** 2026-02-24  
**Branch:** `full`  
**Status:** Ready to implement — everything below is pure TypeScript unless noted.

---

## Quick summary

| # | Item | Files touched | Effort | Notes |
|---|---|---|---|---|
| 1 | `os.time` | sdk.ts | S | Uses `kernel.inb(0x70/0x71)` — no C needed |
| 2 | `os.net` raw sockets | sdk.ts | M | Wraps existing `net.connectAsync/connectPoll/recvBytesNB` |
| 3 | `os.net.getMACAddress` / `online` | sdk.ts | XS | `net.mac`, `net.ip`, `net.nicReady` already public |
| 4 | `os.storage` | sdk.ts | XS | Disk-first, VFS fallback — 8 methods |
| 5 | `os.debug` | sdk.ts | S | Serial + WM overlay; `os.debug.log/warn/error/assert/inspect/measure/trace` |
| 6 | `os.canvas.painter()` | canvas.ts + sdk.ts | M | Rounded rects, circles, scrollbar, progress, button, checkbox, text-wrap |
| 7 | `os.theme` | sdk.ts | S | Dark/light/hacker/retro palettes; `Colors` updated from active theme |
| 8 | `os.audio` | sdk.ts | S | PC speaker via `kernel.outb(0x43/0x42/0x61)` — no C needed |
| 9 | `os.wm` remaining gaps | sdk.ts + wm.ts | M | move/resize/bringToFront/setCloseable/showContextMenu/showMenuBar |
| 10 | `os.wm.dialog` additions | sdk.ts | M | filePicker + colorPicker inline App objects |
| 11 | `os.process` helpers | sdk.ts | S | current/wait/setName/setPriority/onSignal |
| 12 | `os.fs.watch()` | sdk.ts + filesystem.ts | S | Hook array on VFS writes/rm/mkdir |
| 13 | `os.prefs.onChange()` | sdk.ts | XS | Add to existing forApp() return object |
| 14 | Type exports | sdk.ts | XS | ProcessContext, ProcessState, RawSocket, ServerSocket, CanvasPainter, Theme |
| 15 | `os.anim` | sdk.ts | S | Frame-based animation: start/stop/lerp/ease* — needed for transitions |
| 16 | `os.canvas.drawGradient` | canvas.ts + sdk.ts | M | Linear/radial gradient fill — required for Aero/Deco look |
| 17 | `os.wm.setCursor` | sdk.ts + wm.ts | XS | Pointer/text/resize cursor shapes |
| 18 | `os.canvas.drawSprite` | canvas.ts | S | Pixel-art icon/sprite rendering |
| 19 | `os.wm.getTaskbarHeight()` | sdk.ts | XS | Trivial but needed by every full-height app |
| 20 | `os.wm.setOpacity` | sdk.ts + wm.ts | XS | Per-window alpha for glass effects |
| 21 | `os.wm.openModal` | sdk.ts + wm.ts | S | True modal — blocks input to all other windows |

---

## 1 — `os.time`

**Problem:** No wall-clock. Only `os.system.ticks()` (relative since boot).  
**Approach:** Read CMOS RTC directly via `kernel.inb(0x70)` / `kernel.inb(0x71)`. No new C needed. Fall back to boot-epoch + uptime estimate in QEMU if RTC is not readable.

```typescript
os.time.now(): number                  // ms since Unix epoch
os.time.date(): { year, month, day, hour, minute, second }
os.time.format(ms: number, fmt: string): string
// Tokens: YYYY MM DD HH mm ss ddd(3-letter day) DDD(full day)
os.time.since(ms: number): string      // 'just now' | '3s ago' | '2m ago' | '1h ago' | '3d ago'
os.time.duration(ms: number): string   // '1:23:04' or '03:12'
```

**Implementation notes:**
- `_rtcRead(reg)` = `kernel.outb(0x70, reg); return kernel.inb(0x71);`
- BCD decode: `(b >> 4) * 10 + (b & 0xF)`
- CMOS registers: 0x00=sec, 0x02=min, 0x04=hour, 0x06=dow, 0x07=day, 0x08=month, 0x09=year, 0x32=century
- Cache the read-at-boot Unix epoch offset; subsequent `now()` = epoch + uptime delta
- Re-read RTC on each `date()` call (cheap, <1 µs)

---

## 2 — `os.net` raw sockets

**Problem:** Only `os.net.fetch()` exists. No way to write custom TCP clients/servers.  
**Approach:** Coroutine-driven async wrapper around `net.connectAsync`, `net.connectPoll`, `net.recvBytesNB`, `net.send`, `net.closeSocket`.

```typescript
export interface RawSocket {
  readonly id:        number;
  readonly connected: boolean;
  write(data: string | number[]): void;
  read(maxBytes?: number): string;           // Latin-1 decode
  readBytes(maxBytes?: number): number[];
  available(): number;
  close(): void;
}

os.net.connect(
  host: string,
  port: number,
  callback: (sock: RawSocket | null, error?: string) => void,
  opts?: { tls?: boolean; timeoutMs?: number }
): number   // coroutine id — os.process.cancel() to abort

os.net.getMACAddress(): string | null   // '52:54:00:12:34:56' or null
os.net.online(): boolean                // true when DHCP leased (net.leased || net.nicReady)
```

**Implementation notes:**
- `os.net.connect` uses same DNS → `connectAsync` → `connectPoll` coroutine pattern as fetchAsync
- `RawSocket.available()` polls `recvBytesNB` without consuming; buffers in closure
- TLS opt: wraps connection in same `TLSSocket` path as fetch coroutine
- `os.net.getMACAddress()` = `(net as any).mac` (already a public field on NetworkStack)
- `os.net.online()` = `!!(net as any).leased || !!(net as any).nicReady`

---

## 3 — `os.storage`

**Problem:** Apps manually branch on `os.fs.disk.available()`.  
**Approach:** One unified read/write surface: try disk, fall back to VFS in RAM.

```typescript
os.storage.read(path: string): string | null
os.storage.write(path: string, data: string): boolean
os.storage.append(path: string, data: string): boolean
os.storage.exists(path: string): boolean
os.storage.list(path?: string): string[]
os.storage.rm(path: string): boolean
os.storage.isPersistent(): boolean       // === os.fs.disk.available()
os.storage.readJSON<T>(path: string): T | null
os.storage.writeJSON(path: string, value: unknown, pretty?: boolean): boolean
os.storage.mkdir(path: string): boolean
```

**Implementation notes:**
- All methods: `_diskStorage.available() ? disk.op(...) : fs.op(...)`
- `list()` returns string[] of names (not full entry objects)

---

## 4 — `os.debug`

**Problem:** Apps spam `print()` polluting the REPL.  
**Approach:** Structured channel to `/dev/serial` (always) + WM debug overlay if available.

```typescript
os.debug.log(...args: unknown[]): void
os.debug.warn(...args: unknown[]): void
os.debug.error(...args: unknown[]): void
os.debug.assert(cond: boolean, message?: string): void  // throws on false
os.debug.trace(): string                                 // Error().stack
os.debug.inspect(value: unknown, depth?: number): string // util.inspect-like
os.debug.measure(label: string, fn: () => void): number  // returns elapsed ms
os.debug.breakpoint(): void                              // serialPut('BREAKPOINT\n')
os.debug.heapSnapshot(): { total: number; free: number; used: number }
```

**Implementation notes:**
- All `log/warn/error` call `kernel.serialPut('[DEBUG] ...\n')` + `_emitEvent('debug:line', ...)`
- `inspect()`: JSON.stringify with replacer for circular refs; depth limits object expansion
- `assert()` `throws new Error('Assertion failed: ' + message)` with stack attached
- `measure()`: `var t0 = kernel.getUptime(); fn(); return kernel.getUptime() - t0;`

---

## 5 — `os.canvas.painter()`

**Problem:** Apps reinvent rounded rects, scrollbars, progress bars on every canvas.  
**Approach:** Add primitives to `canvas.ts` (`fillCircle`, `fillRoundRect`, `drawRoundRect`). Expose stateless `CanvasPainter` wrapper via `os.canvas.painter(canvas)`.

### New methods on `Canvas` class (canvas.ts):

```typescript
fillCircle(cx: number, cy: number, r: number, color: PixelColor): void  // midpoint
drawCircle(cx: number, cy: number, r: number, color: PixelColor): void
fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: PixelColor): void
drawRoundRect(x: number, y: number, w: number, h: number, r: number, color: PixelColor): void
```

### CanvasPainter (sdk.ts):

```typescript
export interface CanvasPainter {
  readonly canvas: Canvas;
  fill(color: PixelColor): void;
  fillRect(x,y,w,h, color): void;
  strokeRect(x,y,w,h, color): void;
  fillRoundRect(x,y,w,h, r, color): void;
  strokeRoundRect(x,y,w,h, r, color): void;
  fillCircle(cx,cy,r, color): void;
  strokeCircle(cx,cy,r, color): void;
  drawLine(x0,y0,x1,y1, color): void;
  drawText(x,y,text,color, font?): void;
  drawTextWrap(x,y,maxW,text,color, lineH?): number;  // returns y after last line
  measureText(text: string): { width: number; height: number };
  drawScrollbar(x,y,h,total,visible,offset, color?): void;
  drawProgressBar(x,y,w,h,fraction, fgColor?,bgColor?): void;
  drawButton(x,y,w,h,label, pressed?,fgColor?,bgColor?): void;
  drawCheckbox(x,y,checked, label?,color?): void;
}

os.canvas.painter(canvas: Canvas): CanvasPainter
os.canvas.create(w: number, h: number): Canvas  // allocate an offscreen canvas
```

**Implementation notes:**
- `CanvasPainter` is a thin class wrapping `Canvas` — all methods delegate
- `drawScrollbar`: fills track rect, computes thumb position from total/visible/offset
- `drawButton`: fillRoundRect bg + drawText centered; `pressed` darkens bg
- `drawTextWrap`: splits on spaces, respects maxW per line using measureText

---

## 6 — `os.theme`

**Problem:** Every app hardcodes ARGB. No user-changeable appearance.  
**Approach:** Module-level theme map + current name. `Colors` re-export includes theme colors.

```typescript
export interface Theme {
  name: string;
  bg, fg, accent, titleBg, titleFg, taskbarBg,
  selBg, selFg, warnFg, errorFg, successFg, mutedFg, border: number; // all ARGB
}

os.theme.current(): Theme
os.theme.get(key: keyof Theme): number    // os.theme.get('accent')
os.theme.set(name: string): void          // emits 'theme:change' event
os.theme.list(): string[]
os.theme.register(theme: Theme): void
```

**Built-in themes:** `dark` (default, matches current Colors), `light`, `hacker` (green/black), `retro` (CGA).

---

## 7 — `os.audio`

**Problem:** No audio at all.  
**Approach:** PC speaker via PIT channel 2. Already possible with `kernel.outb` — no new C needed.

```typescript
os.audio.beep(freqHz: number, durationMs?: number): void   // default 440 Hz, 200 ms
os.audio.tone(freqHz: number): void    // sustain until silence()
os.audio.silence(): void
os.audio.playSequence(notes: Array<{ freq: number; ms: number }>, callback?: () => void): number  // returns timer id
os.audio.isAvailable(): boolean        // always true on i686; checks via kernel.inb(0x61)
```

**Implementation notes (pure port I/O, no C):**
```
tone(f):
  var divisor = Math.round(1193182 / f) & 0xFFFF;
  kernel.outb(0x43, 0xB6);                       // PIT ch2, square wave
  kernel.outb(0x42, divisor & 0xFF);              // low byte
  kernel.outb(0x42, (divisor >> 8) & 0xFF);       // high byte
  kernel.outb(0x61, kernel.inb(0x61) | 0x03);    // enable gate + speaker

silence():
  kernel.outb(0x61, kernel.inb(0x61) & 0xFC);    // clear bits 0+1
```
- `beep(f, ms)`: `tone(f)` + `os.timer.setTimeout(silence, ms)`
- `playSequence(notes, cb)`: recursively chain timeouts; return first id

---

## 8 — `os.wm` remaining gaps

**Problem:** Several WM capabilities exist internally but aren't exposed.  
**New methods needed in `wm.ts`:**

```typescript
// wm.ts additions:
moveWindow(id: number, x: number, y: number): void
resizeWindow(id: number, w: number, h: number): void
bringToFront(id: number): void   // re-order _windows array
setCloseable(id: number, v: boolean): void
showContextMenu(x: number, y: number, items: MenuItem[]): void
// Renders a transient overlay menu; closes on select/escape/click-away
```

**sdk.ts additions:**
```typescript
os.wm.move(id, x, y): void
os.wm.resize(id, w, h): void
os.wm.bringToFront(id): void
os.wm.setCloseable(id, v): void
os.wm.showContextMenu(x, y, items: MenuItem[]): void
```

**MenuItem interface (exported from sdk.ts):**
```typescript
export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  children?: MenuItem[];
}
```

**Context menu implementation:**
- Module-level `_contextMenu: { x,y, items, winId } | null`
- WM renders it as a floating rect above all windows in `_composite()`
- Mouse events: if context menu open, consume all clicks (dispatch or close)
- Key Escape closes

---

## 9 — `os.wm.dialog` additions

### `filePicker`
- Opens App window showing `os.fs.list()` tree
- Single-click highlights; double-click or Enter selects
- Breadcrumb path bar at top
- Cancel button + Escape close with `null`

### `colorPicker`
- 16×8 color swatch grid from Colors palette
- Click to select, preview box, OK/Cancel
- Returns selected ARGB number or null

---

## 10 — `os.process` helpers

```typescript
os.process.current(): ProcessContext   // find by pid === os.system.pid()
os.process.wait(pid, callback: (exitCode: number) => void): void
// polls scheduler.getLiveProcesses() via setInterval; callback when pid gone
os.process.setName(name: string): void  // scheduler.setProcessName(pid, name) if available
os.process.setPriority(priority: number): void  // 0–10 scale
os.process.onSignal(sig: number, handler: () => void): () => void  // calls ipc.signal.on
```

---

## 11 — `os.fs.watch()`

**Problem:** No change notification.  
**Approach:** Module-level watch registry. VFS patched at SDK init to call watchers after write/rm/mkdir.

```typescript
os.fs.watch(
  path: string,
  callback: (event: 'change' | 'delete' | 'create', path: string) => void
): () => void   // returns unsubscribe
```

**Implementation:**
- `var _fsWatchers: Map<string, Array<WatchCB>>` module-level
- After SDK init: monkey-patch `fs.writeFile`, `fs.rm`, `fs.mkdir` to call `_fireWatch` after original
- `_fireWatch(path, event)`: check all registered watcher paths; fire if path starts-with watcher prefix

---

## 12 — `os.prefs.onChange()`

Add to forApp() return object:
```typescript
onChange(key: string, cb: (value: unknown) => void): () => void
// subscribes via os.events.on('prefs:change') filtered by app+key
```

`set()` already should emit `'prefs:change'` — add that emit call.

---

## 13 — Missing type exports (sdk.ts)

```typescript
export type { ProcessContext, ProcessState } from '../process/scheduler.js';
export type { RawSocket }                   // defined inline in sdk.ts
export interface CanvasPainter { ... }      // defined inline in sdk.ts
export interface Theme { ... }              // defined inline in sdk.ts
export interface MenuItem { ... }           // defined inline in sdk.ts
```

---

## 15 — `os.anim`

**Problem:** No way to schedule smooth frame-rate animation. Apps call `os.timer.setTimeout` in a loop which approximates ~10 fps (PIT tick rate) but has no lerp/ease helpers.  
**Approach:** Thin wrapper over `os.system.ticks()` + scheduled coroutine. Easing fns are pure math.

```typescript
os.anim.start(callback: (elapsed: number, total: number) => boolean, durationMs: number): number
// callback receives (elapsedMs, totalMs); return false to cancel early. Returns anim id.
os.anim.stop(id: number): void
os.anim.lerp(a: number, b: number, t: number): number            // linear 0..1
os.anim.easeInOut(t: number): number                             // cubic ease-in-out
os.anim.easeOut(t: number): number                               // cubic ease-out
os.anim.easeIn(t: number): number                                // cubic ease-in
os.anim.spring(current: number, target: number, velocity: number, stiffness?: number, damping?: number): { value: number; velocity: number }
```

**Implementation notes:**
- `start()` spawns a coroutine loop: each iteration records ticks delta, calls cb(elapsed, duration), yields
- Easing fns are 3–5 line pure math: `easeInOut(t) = t < 0.5 ? 4*t*t*t : 1-(-2*t+2)^3/2`
- `spring()` uses Hooke's law step: `v += (target-current)*stiffness - v*damping; return { value: current+v, velocity: v }`

---

## 16 — `os.canvas.drawGradient`

**Problem:** All design system color specs use gradients; `fillRect` is solid-only.  
**Approach:** Software gradient — iterate scanlines, lerp color components per row/column.

### New methods on `Canvas` class (canvas.ts):

```typescript
drawLinearGradient(
  x: number, y: number, w: number, h: number,
  colors: Array<{ stop: number; color: PixelColor }>,
  direction?: 'horizontal' | 'vertical' | 'diagonal'
): void

drawRadialGradient(
  cx: number, cy: number, r: number,
  colors: Array<{ stop: number; color: PixelColor }>
): void
```

### Exposed via sdk.ts painter:

```typescript
os.canvas.painter(canvas).linearGradient(x, y, w, h, colorStops, dir?)
os.canvas.painter(canvas).radialGradient(cx, cy, r, colorStops)
```

**Implementation notes:**
- Color stop interpolation: for each pixel, find bracketing stops, lerp ARGB channels separately
- `drawLinearGradient` vertical: per-row color, one `fillRect(x, row, w, 1, c)` per row — fast enough at window scale
- `drawRadialGradient`: per-pixel distance from center, same interpolation — use for glows/highlights
- Alpha channel respected: allows glass overlay effect

---

## 17 — `os.wm.setCursor`

**Problem:** Always the same arrow; apps can't signal text/resize/pointer state to the user.  
**Approach:** WM already has the cursor rendering path; just need a shape selector.

```typescript
os.wm.setCursor(shape: 'default' | 'text' | 'pointer' | 'resize-nw' | 'resize-ne' | 'resize-ew' | 'resize-ns' | 'wait' | 'crosshair' | 'none'): void
```

**Implementation notes:**
- Add `_cursorShape: string` to WM; built-in pixel sprites for each shape (like existing CURSOR_PIXELS)
- `'none'` disables drawing the cursor (for fullscreen apps)
- sdk.ts: `setCursor(shape) { if (wm) wm.setCursorShape(shape); }`

---

## 18 — `os.canvas.drawSprite`

**Problem:** No way to render icons. Apps either draw ugly colored rects or raw text.  
**Approach:** Indexed pixel array (same format as WM cursor: 0=transparent, 1..N = palette entries).

```typescript
os.canvas.drawSprite(
  canvas: Canvas,
  x: number, y: number,
  sprite: number[],         // flat row-major pixel array
  width: number, height: number,
  palette: PixelColor[],    // index 0 = transparent by convention
  scale?: number            // default 1
): void
```

**Also on CanvasPainter:**
```typescript
painter.drawSprite(x, y, sprite, w, h, palette, scale?)
```

**Implementation notes:**
- Inner loop: `if (palette[idx] >> 24 !== 0) canvas.setPixel(dx, dy, palette[idx]);`
- `scale` parameter: repeat each pixel N×N times
- Canvas.setPixel / getPixel already exist internally (used by cursor code)

---

## 19 — `os.wm.getTaskbarHeight()`

Trivial:
```typescript
os.wm.getTaskbarHeight(): number   // returns TASKBAR_H (28) or 0 in text mode
```

sdk.ts: `getTaskbarHeight() { return wm ? (wm as any)._taskbarH ?? 28 : 0; }` — or expose a getter on WM.

---

## 20 — `os.wm.setOpacity`

**Problem:** Per-window alpha for glass effects is not exposed.  
**Approach:** Add `opacity: number` (0–255, default 255) to `WMWindow`; compositor multiplies canvas alpha.

```typescript
os.wm.setOpacity(id: number, opacity: number): void   // 0=invisible, 255=solid
```

**Implementation notes:**
- Add `opacity: number = 255` to WMWindow struct
- In `_composite()`: when blitting a window canvas onto screen, multiply alpha channel of each pixel by `win.opacity / 255`
- sdk.ts: `setOpacity(id, v) { if (wm) wm.setWindowOpacity(id, v); }`

---

## 21 — `os.wm.openModal`

**Problem:** `wm.dialog*` fakes modal by using `closeable: false` but all other windows still receive input.  
**Approach:** Add `modal: boolean` to WMWindow; WM routes all input events exclusively to the topmost modal window.

```typescript
os.wm.openModal(opts: {
  title: string;
  app: App;
  width: number;
  height: number;
}): WMWindow | null
```

**Implementation notes:**
- `createWindow({ ..., modal: true })` — WM sets `_modalWinId`
- In event dispatch: if `_modalWinId !== null`, send key/mouse events only to that window
- When modal window closes: clear `_modalWinId`
- Renders a semi-transparent overlay behind modal window (darken desktop)

---

## Implementation order (updated)

| Step | Items | Description |
|---|---|---|
| **A** | 14, 3, 4 | Type exports + os.storage + os.debug — no dependencies, pure TS |
| **B** | 1, 7, 15 | os.time + os.audio + os.anim — timer/port-IO primitives |
| **C** | 2 | os.net raw socket connect — uses existing net.ts async machinery |
| **D** | 5, 16, 18 | os.canvas.painter + gradient + sprite — canvas.ts gets new primitives |
| **E** | 6 | os.theme |
| **F** | 8, 17, 19, 20, 21 | os.wm gaps — move/resize/bringToFront/contextMenu + setCursor + getTaskbarHeight + setOpacity + openModal |
| **G** | 9 | os.wm.dialog filePicker + colorPicker |
| **H** | 10, 11, 12 | os.process helpers + os.fs.watch + os.prefs.onChange |
| **I** | Build + test | `npm run build`, verify TypeScript clean, QEMU smoke test |

---

## Files changed

| File | Changes |
|---|---|
| `src/os/core/sdk.ts` | os.time, os.net.connect/online/getMACAddress, os.storage, os.debug, os.canvas, os.theme, os.audio, os.anim, os.process helpers, os.fs.watch, os.prefs.onChange, type exports, wm.setCursor/getTaskbarHeight/setOpacity/openModal |
| `src/os/ui/canvas.ts` | fillCircle/drawCircle/fillRoundRect/drawRoundRect/drawLinearGradient/drawRadialGradient/drawSprite |
| `src/os/ui/wm.ts` | moveWindow/resizeWindow/bringToFront/setCloseable/setCursorShape/setWindowOpacity/openModal/showContextMenu + context menu composite + opacity blending + modal input guard |

No new C code required.

---

## Estimated bundle size impact

Current: ~4812 KB  
Expected after all additions: ~5100–5200 KB (+290–390 KB)  
Breakdown: canvas primitives +12 KB, painter +18 KB, gradient/sprite +15 KB, theme +5 KB, time +4 KB, audio +3 KB, anim +4 KB, debug +5 KB, net sockets +25 KB, storage +3 KB, dialog additions +20 KB, wm gaps +20 KB, modal/opacity/cursor +10 KB.
