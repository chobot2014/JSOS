# JSOS Application SDK — Product Requirements Document

**Status:** Draft  
**Date:** 2026-02-24  
**Scope:** Everything an app developer needs from `import { os } from '../../core/sdk.js'`

---

## 1. Purpose and Constraints

The SDK is the **only** public surface that application code touches. It must:

- Hide every internal module (`scheduler`, `fs`, `net`, `wm`, `ipc`, `processManager`, `kernel`, …)
- Be fully typed with no `any` in the public API
- Work in both windowed (WM) mode and headless/text mode (null-checks handled internally)
- Be pure TypeScript — no new C required unless noted explicitly
- Be tree-shakeable: inactive namespaces should not bloat bundle output

All items are implementable in `src/os/core/sdk.ts` (or small helper files imported there) unless a **C binding** note is given.

---

## 2. What Is Already Implemented

| `os.*` path | Status |
|---|---|
| `os.fs.read / write / list / mkdir / exists / cwd / cd / rm` | ✅ Done |
| `os.disk.available / read / write / list / mkdir / exists / rm` | ✅ Done |
| `os.system.uptime / ticks / pid / hostname / memory / uname` | ✅ Done |
| `os.system.screenWidth / screenHeight` | ✅ Done |
| `os.process.spawn / list / all / kill / SIG / setAlgorithm / getAlgorithm` | ✅ Done |
| `os.ipc` (pipes, signals, message queues) | ✅ Done (exposed as `os.ipc`) |
| `os.users.whoami / login / logout / list / create` | ✅ Done |
| `os.clipboard.read / write` | ✅ Done |
| `os.wm.available / openWindow / closeWindow / focus / getWindows / getFocused / markDirty / screenWidth / screenHeight` | ✅ Done |
| `os.fetchAsync` | ✅ Done |
| `os.spawn / os.cancel` (raw coroutine) | ✅ Done |

---

## 3. Gaps — Grouped by Priority

---

### P0 — Blocking: Every real app needs these

---

#### 3.1 `os.timer` — Timers and intervals

**Problem:** There is zero timer API. Apps currently poll `os.system.ticks()` manually inside `render()` or register raw coroutines. This is a well-known footgun that produces frame-rate-coupled timeouts and makes async logic impossible to express cleanly.

**Implementation:** Pure TypeScript. Maintain a module-level list of pending timers. Drive them from the WM tick (or, in text mode, from the main loop). The coroutine mechanism in `threadManager` is the right substrate.

```typescript
os.timer.setTimeout(fn: () => void, ms: number): number
os.timer.setInterval(fn: () => void, ms: number): number
os.timer.clearTimeout(id: number): void
os.timer.clearInterval(id: number): void
os.timer.clearAll(): void   // used in onUnmount to clean up pending timers
```

**Edge cases:**
- IDs must be globally unique across `set*` calls (not reused until explicitly cleared)
- A cleared timer that already fired must not error
- Granularity on bare metal is ~10 ms (PIT tick); document this

---

#### 3.2 `os.path` — Path manipulation

**Problem:** Every app inlines ad-hoc string manipulation for paths. There is no canonical join, dirname, or extension extraction — and they all differ subtly.

**Implementation:** Pure string math. No kernel calls.

```typescript
os.path.join(...parts: string[]): string
// ('/', 'etc', 'passwd')     → '/etc/passwd'
// ('/foo/', '/bar')           → '/bar'          (absolute right-hand wins)
// ('foo', '../bar')           → 'bar'           (normalises ..)

os.path.dirname(path: string): string
// '/etc/passwd' → '/etc'
// '/etc'        → '/'
// 'foo'         → '.'

os.path.basename(path: string, ext?: string): string
// '/etc/passwd'         → 'passwd'
// '/etc/passwd', '.txt' → 'passwd'  (strips ext if matches)
// '/etc/foo.txt', '.txt'→ 'foo'

os.path.ext(path: string): string
// '/etc/foo.txt' → '.txt'
// '/etc/foo'     → ''

os.path.resolve(base: string, ...parts: string[]): string
// starts from base (usually os.fs.cwd()), resolves the rest

os.path.isAbsolute(path: string): boolean
os.path.normalize(path: string): string   // collapse //, /./, /../
os.path.relative(from: string, to: string): string
// ('/etc', '/etc/passwd') → 'passwd'
// ('/usr', '/etc/passwd') → '../etc/passwd'
```

---

#### 3.3 `os.fs` missing operations

**Problem:** `os.fs` has no `stat`, `rename`, `append`, or `copy`. You can't build a file manager that shows file sizes, rename a file, or append logs.

```typescript
os.fs.stat(path: string): { size: number; isDir: boolean; mtime: number } | null
// mtime = kernel ticks at last write (best effort)

os.fs.rename(from: string, to: string): boolean
// returns false if source not found or dest parent doesn't exist

os.fs.append(path: string, data: string): boolean
// creates if not present; appends otherwise

os.fs.copy(src: string, dst: string): boolean
// copies file only (not recursive); returns false if src not found

os.fs.isDir(path: string): boolean
// convenience: stat(path)?.isDir ?? false

os.fs.readLines(path: string): string[] | null
// convenience: read(path)?.split('\n') ?? null

os.fs.writeLines(path: string, lines: string[]): boolean
// convenience: write(path, lines.join('\n'))

os.fs.readJSON<T>(path: string): T | null
// JSON.parse with try/catch; returns null on parse error or missing file

os.fs.writeJSON(path: string, value: unknown, pretty?: boolean): boolean
// JSON.stringify; returns write result
```

**Note:** `stat` requires the underlying `VirtualFS.stat()` to be wired up. Currently `fs.list()` returns `{ name, type, size? }` entries — `stat` should derive from that where possible.

---

#### 3.4 `os.env` — Environment variables

**Problem:** There is no environment variable system. Apps hardcode paths and configuration. `PATH`, `HOME`, `USER`, `TERM`, `EDITOR` all need to exist somewhere.

**Implementation:** A simple in-memory `Map<string, string>` initialised from `/etc/environment` at boot. No kernel support needed.

```typescript
os.env.get(key: string): string | undefined
os.env.set(key: string, value: string): void
os.env.delete(key: string): void
os.env.all(): Record<string, string>
os.env.expand(template: string): string
// '$HOME/foo' → '/home/user/foo', '${TERM}' → 'xterm-color'
```

**Standard variables defined at boot:**
```
HOME=/home/user    (updated on os.users.login())
USER=root          (updated on os.users.login())
PATH=/bin:/usr/bin
TERM=jsos-vga
EDITOR=edit
HOSTNAME=(from /etc/hostname)
SHELL=/bin/repl
```

---

### P1 — High: Needed for non-trivial apps

---

#### 3.5 `os.prefs` — Per-app persistent preferences

**Problem:** Apps that need to persist settings (theme, font size, last-open file, …) must manually manage JSON files. There is no namespacing, no default merging, no change notification.

**Implementation:** Reads/writes `/etc/prefs/<appName>.json` via `os.fs` (falls back to `os.disk` if available). Deserialises on first read per session; writes on `set()`.

```typescript
os.prefs.get(key: string): unknown
os.prefs.get<T>(key: string, fallback: T): T
os.prefs.set(key: string, value: unknown): void
os.prefs.delete(key: string): void
os.prefs.all(): Record<string, unknown>
os.prefs.reset(): void          // delete all keys for this app
os.prefs.flush(): void          // force-write to disk right now
os.prefs.onChange(key: string, cb: (value: unknown) => void): () => void
// returns an unsubscribe function
```

**App scoping:** The prefs namespace is automatically scoped to the calling app's name. Since apps are modules, pass the app name at init time:
```typescript
// In an app file:
var prefs = os.prefs.forApp('file-manager');
prefs.get('sortOrder', 'name');
prefs.set('showHidden', true);
```

The current `os.prefs` (unscoped) uses the calling window's title, or `'global'` outside a window.

---

#### 3.6 `os.apps` — App registry and launcher

**Problem:** There is no standard app registry. The REPL's `open` command has a hardcoded switch statement. There is no way to install a third-party app or discover what's installed.

**Implementation:** A module-scope `Map<string, AppEntry>`. Registration happens at module load time (apps call `os.apps.register(...)` in their module body). Launching delegates to `os.wm.openWindow`.

```typescript
interface AppManifest {
  name:        string;           // 'file-manager'
  displayName: string;           // 'File Manager'
  icon?:       string;           // /res/icons/file-manager.png (future)
  category?:   'system' | 'utility' | 'game' | 'other';
  minWidth?:   number;           // default window width
  minHeight?:  number;           // default window height
}

os.apps.register(manifest: AppManifest, factory: (args?: string[]) => App): void
os.apps.unregister(name: string): void
os.apps.list(): AppManifest[]
os.apps.launch(name: string, args?: string[]): WMWindow | null
os.apps.isRegistered(name: string): boolean
```

---

#### 3.7 `os.wm` — Missing window management calls

**Problem:** The `WindowManager` class already implements `minimiseWindow`, `_toggleMaximise`, `setTitle`, and move/resize logic — but none of these are exposed in the SDK.

```typescript
// These are already on WMWindow struct but only internally writable:
os.wm.setTitle(id: number, title: string): void
os.wm.minimize(id: number): void
os.wm.restore(id: number): void
os.wm.maximize(id: number): void
os.wm.getState(id: number): 'normal' | 'minimized' | 'maximized' | null
os.wm.move(id: number, x: number, y: number): void
os.wm.resize(id: number, width: number, height: number): void
os.wm.bringToFront(id: number): void   // already in WM as focusWindow; alias
os.wm.setCloseable(id: number, closeable: boolean): void
```

---

#### 3.8 `os.wm.dialog` — Built-in dialog windows

**Problem:** There is no standard alert/confirm/prompt. Every app rolls its own modal layer, or skips dialogs entirely and silently fails.

**Implementation:** Small internal `App` classes that open transient borderless windows. They call a callback on close.

```typescript
os.wm.dialog.alert(
  message: string,
  opts?: { title?: string; width?: number }
): void

os.wm.dialog.confirm(
  message: string,
  callback: (ok: boolean) => void,
  opts?: { title?: string; okLabel?: string; cancelLabel?: string }
): void

os.wm.dialog.prompt(
  question: string,
  callback: (value: string | null) => void,
  opts?: { title?: string; defaultValue?: string; placeholder?: string }
): void

os.wm.dialog.filePicker(
  callback: (path: string | null) => void,
  opts?: { title?: string; startDir?: string; filter?: string; mode?: 'open' | 'save' }
): void

os.wm.dialog.colorPicker(
  callback: (color: number | null) => void,   // ARGB
  opts?: { title?: string; initial?: number }
): void
```

All dialogs are modal (WM blocks key events to other windows until closed).

---

#### 3.9 `os.notify` — Toast notifications

**Problem:** Apps have no way to surface short status messages outside their own window. Network events, file saves, and errors are all silently swallowed or printed to the REPL.

**Implementation:** WM renders a small overlay bar at the bottom of the screen. Messages auto-dismiss after `durationMs`.

```typescript
os.notify(
  message: string,
  opts?: {
    level?:      'info' | 'success' | 'warn' | 'error';
    durationMs?: number;    // default 3000
    icon?:       string;    // future: path to 8×8 icon
  }
): number   // notification id

os.notify.dismiss(id: number): void
os.notify.dismissAll(): void
```

---

### P2 — Medium: Needed for a proper developer experience

---

#### 3.10 `os.text` — Text encoding and formatting

**Problem:** There is no Base64, URL encoding, UTF-8 transcoding, or printf-style formatting. `crypto.ts` has Base64 but it's private. Every app re-invents hex dumps, padding, and number formatting.

```typescript
// Encoding
os.text.encodeUTF8(str: string): number[]
os.text.decodeUTF8(bytes: number[]): string
os.text.encodeBase64(data: string | number[]): string
os.text.decodeBase64(b64: string): string
os.text.encodeHex(data: string | number[]): string
os.text.decodeHex(hex: string): number[]
os.text.encodeURL(str: string): string      // %xx escaping
os.text.decodeURL(str: string): string

// Formatting
os.text.format(template: string, ...args: unknown[]): string
// '%s loaded %d files in %.2f ms', 'App', 3, 0.41  → 'App loaded 3 files in 0.41 ms'
// Supports: %s %d %i %f %x %o %b %% and width/precision modifiers

os.text.pad(s: string, width: number, char?: string, right?: boolean): string
// pad('7', 3, '0') → '007'   pad('hi', 5) → 'hi   '

os.text.bytes(n: number): string
// 1023 → '1023 B', 1024 → '1 KB', 1048576 → '1 MB'

os.text.pluralise(n: number, singular: string, plural?: string): string
// (1, 'file') → '1 file'   (3, 'file') → '3 files'

os.text.truncate(s: string, maxLen: number, suffix?: string): string
// ('hello world', 8, '…') → 'hello w…'

os.text.wrapWords(s: string, cols: number): string[]
// returns array of lines, breaking at word boundaries
```

---

#### 3.11 `os.time` — Wall-clock and date formatting

**Problem:** There is no wall-clock API. `os.system.ticks()` gives only relative time; there is no way to display "12:34 PM" or "2026-02-24".

**Implementation:** On bare metal the PC's CMOS RTC is accessible via I/O port `0x70`/`0x71`. Reading BCD registers gives year/month/day/hour/minute/second. This needs **one small C binding** (`kernel_rtc_read() → { y,m,d,h,min,s }`). Until that is added, fall back to boot-time estimation via ticks.

```typescript
os.time.now(): number
// milliseconds since Unix epoch (from RTC when available, else ticks-based estimate)

os.time.date(): { year: number; month: number; day: number; hour: number; minute: number; second: number }
// { year: 2026, month: 2, day: 24, hour: 12, minute: 34, second: 56 }

os.time.format(ms: number, fmt: string): string
// fmt tokens: YYYY MM DD HH mm ss ddd DDD
// os.time.format(os.time.now(), 'YYYY-MM-DD HH:mm:ss') → '2026-02-24 12:34:56'
// os.time.format(os.time.now(), 'HH:mm')               → '12:34'

os.time.since(ms: number): string
// Human-readable elapsed:  'just now', '3s ago', '2m ago', '1h ago', '3d ago'

os.time.duration(ms: number): string
// '1:23:04' or '03:12' (mm:ss if < 1h)
```

**C binding required:** `kernel.getRTCDate()` — reads CMOS RTC via ports `0x70/0x71`, returns packed BCD fields. Fallback to ticks estimate if not available.

---

#### 3.12 `os.crypto` — Expose existing crypto primitives

**Problem:** `net/crypto.ts` already implements SHA-256, HMAC-SHA-256, AES-128-GCM, and X25519 — but none of it is exposed to app code. Apps can't hash a password, generate a session token, or do any local crypto.

**Implementation:** Just re-export and wrap. Zero new code.

```typescript
os.crypto.sha256(data: string | number[]): string          // hex digest
os.crypto.sha256Bytes(data: string | number[]): number[]   // raw 32 bytes
os.crypto.hmacSHA256(key: string, data: string): string    // hex
os.crypto.randomBytes(n: number): number[]
// uses kernel.rand32() (hardware RNG if available, LCG fallback)

os.crypto.aesEncrypt(key: number[], iv: number[], data: number[]): number[]
os.crypto.aesDecrypt(key: number[], iv: number[], data: number[]): number[] | null
// null on auth failure (GCM tag mismatch)

os.crypto.uuid(): string
// xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx from randomBytes()
```

---

#### 3.13 `os.events` — Application event bus

**Problem:** There is no pub/sub mechanism for decoupled app-to-app and system-to-app communication. Apps that want to react to system events (disk mounted, network up, theme changed) are forced to poll.

**Implementation:** Module-scope `Map<string, Set<listener>>`. Zero kernel involvement.

```typescript
type EventHandler<T = unknown> = (data: T) => void;

os.events.on<T>(event: string, handler: EventHandler<T>): () => void
// returns an unsubscribe function — MUST be called in onUnmount to avoid leaks

os.events.once<T>(event: string, handler: EventHandler<T>): void

os.events.emit<T>(event: string, data?: T): void

os.events.off(event: string, handler: EventHandler): void

os.events.listeners(event: string): number   // count of registered handlers
```

**Reserved system event names** (emitted by the OS itself):

| Event | Data type | Emitted when |
|---|---|---|
| `system:boot` | — | OS fully initialised |
| `wm:ready` | — | WM first frame rendered |
| `wm:window:open` | `{ id, title }` | Window created |
| `wm:window:close` | `{ id, title }` | Window closed |
| `wm:window:focus` | `{ id }` | Focus changed |
| `disk:mounted` | `{ type: 'fat32'\|'fat16' }` | FAT disk mounted |
| `disk:unmounted` | — | Disk unmounted |
| `net:up` | `{ ip: string }` | DHCP lease obtained |
| `net:down` | — | Network link dropped |
| `user:login` | `{ uid, name }` | User logged in |
| `user:logout` | `{ uid }` | User logged out |
| `theme:change` | `{ name }` | Theme changed |
| `prefs:change` | `{ app, key, value }` | Any pref updated |

---

#### 3.14 `os.net` — Raw socket API

**Problem:** `os.fetchAsync` is the only network primitive. There is no way to write a chat client, file transfer protocol, game server, or any custom TCP protocol.

**Implementation:** Thin async wrapper around `net.ts` primitives, driven by the existing coroutine scheduler.

```typescript
interface RawSocket {
  id:        number;
  connected: boolean;
  write(data: string | number[]): void;
  read(maxBytes?: number): string;
  readBytes(maxBytes?: number): number[];
  available(): number;          // bytes buffered for reading
  close(): void;
  onData(cb: (data: number[]) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: string) => void): void;
}

interface ServerSocket {
  port:  number;
  close(): void;
  onConnection(cb: (sock: RawSocket) => void): void;
}

os.net.connect(
  host: string,
  port: number,
  callback: (sock: RawSocket | null, err?: string) => void,
  opts?: { tls?: boolean; timeoutMs?: number }
): number   // coroutine id (cancel with os.cancel())

os.net.listen(
  port: number,
  callback: (server: ServerSocket | null, err?: string) => void
): number   // coroutine id

os.net.getIP(): string | null          // current DHCP-assigned IP, null if not up
os.net.getMACAddress(): string | null  // 'aa:bb:cc:dd:ee:ff' or null
os.net.ping(host: string, callback: (rttMs: number | null) => void): number
// null = no reply within 5 s
```

---

#### 3.15 `os.audio` — PC speaker

**Problem:** There is no audio API at all. Even a beep is impossible.

**Implementation:** PC speaker is driven by PIT channel 2 via port `0x42/0x43/0x61`. This requires **one C binding**: `kernel_speaker_on(freq_hz)` and `kernel_speaker_off()`.

```typescript
os.audio.beep(freqHz: number, durationMs: number): void
// plays a tone and auto-stops after durationMs

os.audio.tone(freqHz: number): void
// starts playing; call silence() to stop

os.audio.silence(): void

os.audio.playSequence(notes: Array<{ freq: number; ms: number }>, callback?: () => void): number
// schedules notes via os.timer; returns cancelable id

os.audio.isAvailable(): boolean
// true on bare metal with PCI speaker; false in QEMU without it
```

**C bindings required:**
- `kernel.speakerOn(freq: number): void`  — sets PIT channel 2
- `kernel.speakerOff(): void`

---

### P3 — Lower: Developer tooling and polish

---

#### 3.16 `os.debug` — In-OS debugging tools

**Problem:** There is no structured debug output channel. Apps `print()` to the REPL, which pollutes the shell. There is no way to inspect the state of a running app from another window.

```typescript
os.debug.log(...args: unknown[]): void
// Writes to /dev/debug (serial in text mode, WM debug overlay in windowed mode)

os.debug.warn(...args: unknown[]): void
os.debug.error(...args: unknown[]): void

os.debug.assert(condition: boolean, message?: string): void
// throws if condition is false; message includes file/line from stack trace

os.debug.trace(): string
// returns a formatted stack trace string (QuickJS Error.stack)

os.debug.inspect(value: unknown, depth?: number): string
// pretty-print an object like util.inspect in Node.js

os.debug.measure(label: string, fn: () => void): number
// runs fn(), returns elapsed ms, logs 'label: Xms' to debug channel

os.debug.breakpoint(): void
// emits a serial line 'JSOS BREAKPOINT <stack>' — useful with QEMU monitor

os.debug.heapSnapshot(): { total: number; used: number; gcCount: number }
// wraps kernel.getMemoryInfo(); useful for leak tracking
```

---

#### 3.17 `os.canvas` — Higher-level 2D drawing helpers

**Problem:** `Canvas` is a low-level pixel buffer. Every app reimplements rounded rectangles, scrollbars, text with wrapping, and progress bars.

**Implementation:** A stateless `CanvasPainter` wrapper that takes a `Canvas` and exposes richer primitives. Can live in `sdk.ts` or a separate `ui-kit.ts` re-exported from sdk.

```typescript
interface CanvasPainter {
  // Shapes
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  drawRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  fillCircle(cx: number, cy: number, radius: number, color: number): void;
  drawCircle(cx: number, cy: number, radius: number, color: number): void;
  drawEllipse(cx: number, cy: number, rx: number, ry: number, color: number): void;
  fill(color: number): void;  // alias for clear() using any color

  // Text
  drawText(x: number, y: number, text: string, color: number, font?: BitmapFont): void;
  drawTextWrapped(x: number, y: number, w: number, text: string, color: number, lineH?: number): number;
  // returns the y position after last line
  measureText(text: string, font?: BitmapFont): { width: number; height: number };

  // Widget primitives
  drawScrollbar(x: number, y: number, h: number, total: number, visible: number, offset: number, color?: number): void;
  drawProgressBar(x: number, y: number, w: number, h: number, fraction: number, fgColor?: number, bgColor?: number): void;
  drawButton(x: number, y: number, w: number, h: number, label: string, pressed?: boolean): void;
  drawCheckbox(x: number, y: number, checked: boolean, label?: string): void;

  // Images (future: once image loading exists)
  // drawImage(x, y, img): void

  // Access underlying canvas
  readonly canvas: Canvas;
}

os.canvas.painter(canvas: Canvas): CanvasPainter
```

---

#### 3.18 `os.theme` — System-wide colour themes

**Problem:** Every app hardcodes ARGB colours. There is no way for a user to change the OS appearance without editing source files.

```typescript
interface Theme {
  name:       string;
  bg:         number;   // ARGB
  fg:         number;
  accent:     number;
  titleBg:    number;
  titleFg:    number;
  taskbarBg:  number;
  selBg:      number;
  selFg:      number;
  warnFg:     number;
  errorFg:    number;
  successFg:  number;
  mutedFg:    number;
  border:     number;
}

os.theme.current(): Theme
os.theme.set(name: string): void      // emits 'theme:change' event
os.theme.list(): string[]
os.theme.register(theme: Theme): void
os.theme.get(key: keyof Theme): number   // os.theme.get('accent')
```

**Built-in themes:** `'dark'` (current default), `'light'`, `'hacker'` (green on black), `'retro'` (CGA palette).

---

#### 3.19 `os.storage` — Unified storage abstraction

**Problem:** Apps must manually decide between `os.fs` (volatile RAM-backed) and `os.disk` (persistent FAT, optional). There is no single "give me a file that persists if possible and falls back to RAM" API.

```typescript
os.storage.read(path: string): string | null
// tries disk first, then fs

os.storage.write(path: string, data: string): boolean
// writes to disk if available, otherwise fs; returns false only on hard failure

os.storage.append(path: string, data: string): boolean
os.storage.exists(path: string): boolean
os.storage.list(path: string): string[]
os.storage.rm(path: string): boolean
os.storage.isPersistent(): boolean   // true when os.disk.available()
os.storage.readJSON<T>(path: string): T | null
os.storage.writeJSON(path: string, value: unknown): boolean
```

---

#### 3.20 `os.process` — Missing process helpers

```typescript
os.process.current(): ProcessContext
// === os.process.all().find(p => p.pid === os.system.pid())

os.process.wait(pid: number, callback: (exitCode: number) => void): void
// fires callback when target pid reaches 'terminated' state

os.process.setName(name: string): void
// rename current process in the process table (useful for app identification)

os.process.setPriority(priority: number): void
// 0 = lowest, 10 = real-time; affects round-robin slice length

os.process.onSignal(sig: number, handler: () => void): () => void
// register signal handler for current process; returns unsub function
// convenience wrapper around os.ipc.signal (which already exists)
```

---

#### 3.21 `os.fs` — Watch / change notification

**Problem:** Two apps that have the same file open (e.g. an editor and a file manager) cannot detect external modifications.

```typescript
os.fs.watch(path: string, callback: (event: 'change' | 'delete' | 'create', path: string) => void): () => void
// returns unsubscribe. Internally: the VFS mutates call this hook after every write/rm/mkdir.
// Works for directory watches too (fires on any child change)
```

---

## 4. Type Exports Required

These types are public API — they must be exported from `sdk.ts`:

```typescript
export type { ProcessContext, ProcessState, SchedulingAlgorithm } from './scheduler.js'
export type { FetchOptions, FetchResponse }                        // already done
export type { RawSocket, ServerSocket }                            // new in §3.14
export type { CanvasPainter }                                      // new in §3.17
export type { Theme }                                              // new in §3.18
export type { AppManifest }                                        // new in §3.6
```

---

## 5. Implementation Order (Recommended)

| Phase | Items | Effort | Value |
|---|---|---|---|
| **1 — Core utilities** | `os.timer`, `os.path`, `os.fs.stat/rename/append/copy`, `os.env` | ~1 day | Unblocks every existing app |
| **2 — UX layer** | `os.wm` extra methods, `os.wm.dialog`, `os.notify`, `os.events` | ~1 day | Makes apps feel native |
| **3 — Data & encoding** | `os.text`, `os.crypto`, `os.storage`, `os.prefs`, `os.time` | ~1 day | Needed for persistence + net apps |
| **4 — App system** | `os.apps`, `os.theme`, `os.canvas.painter`, `os.debug` | ~1 day | Developer experience + extensibility |
| **5 — I/O expansion** | `os.net` raw sockets, `os.audio`, `os.fs.watch`, `os.process.wait/onSignal` | ~2 days | Requires C stubs for audio + RTC |

---

## 6. C Bindings Required (Phase 5 only)

All P0–P2 items are pure TypeScript. Only these two P3 items need new C:

| Feature | C function | Port(s) |
|---|---|---|
| `os.time` wall clock | `kernel_rtc_read()` in `timer.c` | `0x70`, `0x71` (CMOS RTC) |
| `os.audio.tone` | `kernel_speaker_on(freq)` / `kernel_speaker_off()` in `timer.c` | PIT channel 2: `0x42`, `0x43`, `0x61` |

---

## 7. Breaking Changes and Migration

None of the new additions break existing apps. All new namespaces are additive. The only risky change is `os.fs.stat` — if the underlying `VirtualFS` doesn't expose a stat-like method, `os.fs.stat` will need to approximate using `os.fs.list()` on the parent directory, which changes semantics for root-level files. Document the fallback explicitly in the implementation.

---

## 8. Testing Notes

All P0–P2 items are unit-testable without QEMU since they are pure TypeScript. The test harness should:

1. Stub `kernel.getTicks()` to return a controllable counter
2. Run `os.timer.setTimeout` tests by manually advancing the tick counter
3. Test `os.path.*` with a comprehensive table of inputs/outputs
4. Test `os.fs.*` against the in-memory VFS (already instantiated in the test build)

P3 audio and RTC tests require actual QEMU boot and serial log scanning.
