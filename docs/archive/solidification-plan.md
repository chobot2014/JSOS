# JSOS Solidification Plan
## Prereqs before any new app work

---

## 1. Current System State (as of Feb 2026)

### ✅ Working subsystems

| Subsystem | File(s) | Status |
|---|---|---|
| Boot sequence | `core/main.ts` | Phases 1–9 boot clean; serial log confirms each milestone |
| VGA text terminal | `ui/terminal.ts` | Color, cursor, scroll, bold, clear |
| Framebuffer canvas | `ui/canvas.ts` | 32-bit ARGB pixel ops, rect, text (8×8 bitmap font), blit |
| Window manager | `ui/wm.ts` | Create/close/drag/resize windows, taskbar, cursor, z-order |
| In-memory VFS | `fs/filesystem.ts` | Full Unix tree, mkdir/read/write/rm/stat, mounts |
| procFS | `fs/proc.ts` | /proc/meminfo, /proc/cpuinfo, /proc/net/dev, /proc/net/tcp, /proc/net/route live data |
| devFS | `fs/dev.ts` | /dev/null, /dev/zero, /dev/urandom, /dev/tty, /dev/stdin |
| romFS | `fs/romfs.ts` | Read-only bundled resources (bible.txt etc.) |
| FAT16 / FAT32 | `storage/fat16.ts`, `storage/fat32.ts` | Auto-format on blank disk, read/write, mount at /disk |
| Physical allocator | `process/physalloc.ts` | Bitmap alloc, 4 KB pages, 320 MB kernel reserve |
| VMM / paging | `process/vmm.ts` | Hardware paging via kernel, mmap, mmap test passes |
| Thread manager | `process/threads.ts` | Cooperative coroutines, TID 0 (idle) / TID 1 (repl), tick |
| Scheduler façade | `process/scheduler.ts` | POSIX PIDs 0/1/2 (idle/kernel/init), signal delivery on tick |
| Signals | `process/signals.ts` | SIG constants, handler registration, deliverPending |
| sync primitives | `process/sync.ts` | Mutex, Condvar, Semaphore (cooperative, no preemption) |
| POSIX process | `process/process.ts` | fork/exec/waitpid façade |
| JSProcess | `process/jsprocess.ts` | Isolated QuickJS child runtimes, send/recv, shared buffers |
| FD table | `core/fdtable.ts` | open/close/read/write/seek/ioctl/pipe/dup, socket descs, VFS path descs |
| Syscall interface | `core/syscalls.ts` | open/read/write/close/lseek/mmap/brk/socket/connect/bind/listen/send/recv |
| Init system | `process/init.ts` | Service registry, runlevels 1–5, startService/stopService, listServices |
| IPC | `ipc/ipc.ts` | Pipe (ring-buffer), SignalDispatcher, MessageQueue, IPCManager |
| User accounts | `users/users.ts` | /etc/passwd, login/logout/whoami, root + user accounts |
| virtio-net | C `virtio_net.c` | PCI discovery, virtqueue setup, Rx/Tx DMA |
| Network stack | `net/net.ts` | ARP, IPv4, ICMP, UDP, TCP (3WH, ESTABLISHED, FIN), sockets |
| DHCP | `net/dhcp.ts` | Discover/Offer/Request/ACK; acquires IP/mask/gateway/DNS |
| DNS | `net/dns.ts` | Sync resolve + async coroutine pipeline, caching, cancellation |
| TLS 1.3 | `net/tls.ts` | Handshake, HKDF, X25519 (SW), AES-GCM-128 |
| HTTPS | `net/http.ts` | GET/POST, header parse, chunked transfer, redirect follow |
| Crypto | `net/crypto.ts` | SHA-256, HMAC, HKDF, X25519, AES-GCM |
| REPL (text) | `ui/repl.ts` | tickCoroutines + pollNIC each iteration, history |
| REPL commands | `ui/commands.ts` | 80+ globals: ls/cat/ps/top/services/mem/net/test/run/… |
| App SDK | `core/sdk.ts` | os.fs, os.net, os.system, os.spawn, os.cancel, os.process, os.ipc, os.users |
| Browser app | `apps/browser.ts` | HTML render, forms, images (BMP), TLS fetch, history, find |
| Terminal app | `apps/terminal-app.ts` | VGA-style terminal window in WM |
| Editor app | `apps/editor-app.ts` | Fullscreen text editor |

---

## 2. Solidification Checklist

These are the concrete tasks to complete **before writing any new app code**.
Items are ordered by priority. Each is a self-contained, verifiable change.

### 2A. App interface — add missing lifecycle events

**File:** `src/os/ui/wm.ts`

The `App` interface is missing `onFocus` / `onBlur` / `onResize`. Every complex app needs to know when it gains/loses keyboard focus and when its window is resized.

```typescript
// Current
export interface App {
  readonly name: string;
  onMount(win: WMWindow): void;
  onUnmount(): void;
  onKey(event: KeyEvent): void;
  onMouse(event: MouseEvent): void;
  render(canvas: Canvas): boolean;
}

// Target
export interface App {
  readonly name: string;
  onMount(win: WMWindow): void;
  onUnmount(): void;
  onFocus?(): void;          // ← called when window gains focus
  onBlur?(): void;           // ← called when window loses focus
  onResize?(w: number, h: number): void;  // ← called after window resize
  onKey(event: KeyEvent): void;
  onMouse(event: MouseEvent): void;
  render(canvas: Canvas): boolean;
}
```

WM must call `onFocus`/`onBlur` when `_focused` changes, and `onResize` after any resize drag completes.

---

### 2B. SDK — add os.disk

**File:** `src/os/core/sdk.ts`

Apps have no clean way to persist data to the FAT disk. `g._diskFS` is a raw hack. Add an `os.disk` namespace that wraps the active disk driver.

```typescript
os.disk = {
  read(path: string): string | null;
  write(path: string, data: string): boolean;
  mkdir(path: string): boolean;
  list(path?: string): Array<{ name: string; type: string; size: number }>;
  exists(path: string): boolean;
  rm(path: string): boolean;
  available(): boolean;   // false if no disk is mounted
};
```

Implementation reads from `(globalThis as any)._diskFS` (the live FAT driver).

---

### 2C. WM — clipboard (shared string between apps)

**File:** `src/os/ui/wm.ts`

No inter-app clipboard exists. Add a simple string clipboard to the WM singleton:

```typescript
class WindowManager {
  private _clipboard: string = '';
  setClipboard(text: string): void { this._clipboard = text; }
  getClipboard(): string { return this._clipboard; }
}
```

Expose via `os.clipboard.read()` / `os.clipboard.write()` in the SDK.

---

### 2D. Self-test coverage expansion

**File:** `src/os/ui/commands.ts` (`g.test`)

Current `test()` function covers 8 items. Expand to cover all major subsystems:

- **net:** socket create, UDP inbox open/close
- **disk:** write/read/rm on /disk if available
- **IPC:** pipe write/read roundtrip  
- **signals:** register handler, deliver, cleanup
- **proc FS:** `/proc/net/dev`, `/proc/net/tcp` readable
- **devFS:** `/dev/null` readable, `/dev/urandom` gives bytes
- **scheduler:** `getAllProcesses()` returns ≥ 3 entries
- **physAlloc:** `freePages()` > 0
- **init:** `listServices()` returns ≥ 10 services

---

### 2E. Boot — make network probe non-blocking

**File:** `src/os/core/main.ts`

The DNS → TCP → HTTPS boot probe calls `dnsResolve('example.com')` synchronously. On a real machine with slow DHCP/DNS this blocks boot for multiple seconds. The DHCP/DNS steps are already guarded by if-chains that fall through correctly, but the TCP connect and TLS tests add extra round-trip latency even when they succeed.

**Fix:** Wrap the TCP connect test and HTTPS test in a `try/catch` with a short explicit timeout (already done via `kernel.getTicks()` deadline in `net.connect`). This is currently fine; just verify that `kernel.sleep(1)` inside the TCP connect loop doesn't block indefinitely when QEMU drops packets. No code change needed if this is already solid — just verify in test.

---

### 2F. WM — window `onResize` resize drag completion

**File:** `src/os/ui/wm.ts`

After a resize drag completes (mouse-up after `_resizing`), the window's content canvas should be re-created at the new size and `app.onResize(newW, newH)` called. Currently the canvas stays at the original size.

```typescript
// In _handleMouseUp, after resize drag ends:
if (win.app?.onResize) win.app.onResize(win.width, win.height);
win.canvas = new Canvas(win.width, win.height);
win.dirty = true;
```

---

### 2G. SDK — add os.clipboard

**File:** `src/os/core/sdk.ts`

Add after the `users` section:

```typescript
clipboard: {
  read(): string { return (getWM() as any)?.getClipboard() ?? ''; },
  write(text: string): void { (getWM() as any)?.setClipboard(text); },
},
```

Requires importing `getWM` from `wm.ts`.

---

### 2H. Expand JSDoc on SDK public surface

**File:** `src/os/core/sdk.ts`

Every `os.*` property needs a one-line JSDoc comment with parameter types and return value. This is the canonical API reference for all future app development.

Priority order: `os.fs`, `os.net.fetchAsync`, `os.system`, `os.disk`.

---

## 3. App Contract (canonical spec)

This is the **complete, authoritative definition** of an JSOS app. All current and future apps must conform to this interface.

### 3A. The `App` interface

```typescript
export interface App {
  /** Unique name shown in the taskbar and window title bar. */
  readonly name: string;

  /**
   * Called once when the app is placed into a WM window.
   * The `win` reference is permanent — the app keeps it for the lifetime of the window.
   * Initialize all internal state here; do NOT render.
   */
  onMount(win: WMWindow): void;

  /**
   * Called once when the window is destroyed (user closes or `wm.closeWindow(id)` is called).
   * Release all resources, cancel any running coroutines.
   */
  onUnmount(): void;

  /**
   * Called when this window becomes the focused (foreground) window.
   * Keyboard events will now be routed here.
   * Optional — default is no-op.
   */
  onFocus?(): void;

  /**
   * Called when this window loses focus (another window is clicked).
   * Optional — default is no-op.
   */
  onBlur?(): void;

  /**
   * Called after the user finishes dragging a resize handle.
   * The app should re-layout its content to fit the new dimensions.
   * Optional — default is no-op.
   */
  onResize?(width: number, height: number): void;

  /**
   * Called for every key press while this window is focused.
   * `event.ch` is a printable character or empty string.
   * `event.ext` is non-zero for special keys (KEY_UP, KEY_DOWN, KEY_ENTER, …).
   */
  onKey(event: KeyEvent): void;

  /**
   * Called for every mouse event over this window's content area.
   * Coordinates are local to the window's top-left corner.
   */
  onMouse(event: MouseEvent): void;

  /**
   * Draw the app's content into `canvas`.
   * Called every WM frame (~50 fps) when the window is visible and not minimised.
   * Return `true` if anything was actually redrawn (triggers composite).
   * Return `false` to skip the composite pass for this frame (no change).
   * Apps must NOT block in render — all async work runs via `os.spawn` coroutines.
   */
  render(canvas: Canvas): boolean;
}
```

### 3B. App construction pattern

Every app is a singleton object (not a class instance created per-window). The WM calls `app.onMount(win)` to bind it to a window:

```typescript
// Pattern: object with private state captured in module scope
let _win: WMWindow | null = null;
let _dirty = true;

export const myApp: App = {
  name: 'MyApp',

  onMount(win) {
    _win = win;
    _dirty = true;
  },

  onUnmount() {
    _win = null;
  },

  onKey(ev) {
    // process input, set _dirty = true
  },

  onMouse(ev) {
    // process mouse, set _dirty = true
  },

  render(canvas) {
    if (!_dirty) return false;
    _dirty = false;
    // draw into canvas
    return true;
  },
};
```

### 3C. App SDK access

Apps **must only** import from `core/sdk.js`:

```typescript
import { os, type FetchResponse } from '../core/sdk.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';
import { Canvas, Colors } from '../ui/canvas.js';
```

Apps **must not** import directly from:
- `net/net.ts`, `net/dns.ts`, `net/http.ts`, `net/tls.ts`
- `process/*.ts`
- `fs/filesystem.ts`
- `ipc/ipc.ts`
- `users/users.ts`

These are all exposed through `os.*` at the right abstraction level.

### 3D. Rendering contract

- **No blocking in render.** All I/O runs in coroutines started with `os.spawn()`.
- **Dirty flag pattern.** Only return `true` from `render()` when the canvas actually changed, to avoid burning GPU bandwidth on unchanged frames.
- **Canvas is pre-clipped.** The canvas passed to `render()` is exactly the window's content area (excluding title bar). Do not draw outside its bounds.
- **Coordinate origin.** `(0, 0)` is the top-left of the content area.

### 3E. Async fetch pattern

```typescript
// Correct: use os.spawn for fetch
let _result: FetchResponse | null = null;
let _loading = false;

function loadURL(url: string) {
  if (_loading) return;
  _loading = true;
  _result  = null;
  _dirty   = true;

  os.spawn(function*(resolve) {
    var res = yield* os.net.fetchAsync(url);
    _result  = res;
    _loading = false;
    _dirty   = true;
  });
}
```

---

## 4. SDK Surface (canonical reference)

Every function apps are allowed to call. This is the contract. Anything not listed here requires an SDK addition (section 2B/2C/2G) before use.

### `os.fs` — Virtual filesystem

| Method | Returns | Description |
|---|---|---|
| `os.fs.read(path)` | `string \| null` | Read file text |
| `os.fs.write(path, text)` | `boolean` | Write/create file |
| `os.fs.append(path, text)` | `boolean` | Append to file |
| `os.fs.rm(path)` | `boolean` | Delete file or empty dir |
| `os.fs.mkdir(path)` | `boolean` | Create directory tree |
| `os.fs.list(path?)` | `Array<{name,type,size}>` | Directory listing |
| `os.fs.exists(path)` | `boolean` | Path exists |
| `os.fs.isDir(path)` | `boolean` | Is a directory |
| `os.fs.stat(path)` | `object \| null` | File metadata |
| `os.fs.cwd()` | `string` | Current directory |
| `os.fs.cd(path)` | `boolean` | Change directory |

### `os.disk` — Persistent FAT disk *(to be added: 2B)*

| Method | Returns | Description |
|---|---|---|
| `os.disk.available()` | `boolean` | FAT disk mounted |
| `os.disk.read(path)` | `string \| null` | Read from /disk |
| `os.disk.write(path, data)` | `boolean` | Write to /disk |
| `os.disk.list(path?)` | `Array<{name,type,size}>` | List /disk dir |
| `os.disk.mkdir(path)` | `boolean` | Create dir on /disk |
| `os.disk.rm(path)` | `boolean` | Remove from /disk |
| `os.disk.exists(path)` | `boolean` | Path exists on /disk |

### `os.net` — Networking

| Method | Returns | Description |
|---|---|---|
| `os.net.fetchAsync(url, opts?)` | `AsyncGenerator<FetchResponse>` | HTTPS/HTTP fetch |
| `os.net.ip()` | `string` | Current IP address |
| `os.net.online()` | `boolean` | NIC present and DHCP leased |

### `os.system` — System info

| Method | Returns | Description |
|---|---|---|
| `os.system.uptime()` | `number` | Milliseconds since boot |
| `os.system.ticks()` | `number` | PIT tick count |
| `os.system.pid()` | `number` | Current PID |
| `os.system.hostname()` | `string` | /etc/hostname |
| `os.system.memory()` | `{total,free,used}` | Bytes |
| `os.system.uname()` | `{sysname,release,machine}` | OS ident |

### `os.spawn` / `os.cancel` — Coroutines

| Function | Description |
|---|---|
| `os.spawn(gen)` → `id` | Register generator-based coroutine; advanced one step per WM tick |
| `os.cancel(id)` | Cancel a running coroutine |

### `os.clipboard` *(to be added: 2C/2G)*

| Method | Description |
|---|---|
| `os.clipboard.read()` | Return current clipboard string |
| `os.clipboard.write(text)` | Set clipboard string |

### `os.process` — Isolated runtimes

| Method | Description |
|---|---|
| `os.process.spawn(code, name?)` | Create isolated QuickJS child runtime |
| `os.process.list()` | List all live child processes |

### `os.ipc` — Inter-process communication

| Method | Description |
|---|---|
| `os.ipc.createPipe(rfd, wfd)` | Create a byte-stream pipe |
| `os.ipc.send(to, type, payload)` | Send a typed message to a PID |
| `os.ipc.recv(pid, type?)` | Receive next message for a PID |

### `os.users` — Accounts

| Method | Description |
|---|---|
| `os.users.login(name, pass)` | Authenticate |
| `os.users.logout()` | Clear session |
| `os.users.whoami()` | Current user info |
| `os.users.list()` | All accounts |

---

## 5. Apps to Build (prioritized)

These are the apps to work on in order. Each depends on the solidification tasks above being complete first.

### App 1: File Manager
**Priority:** High — proves SDK and WM together  
**Features:**
- Two-pane layout: VFS tree left, directory listing right
- Click to navigate, Enter to open file in editor
- Copy/move/rename/delete via buttons and Ctrl shortcuts
- Preview pane for .txt files (use `os.fs.read`)
- Disk tab switches to `os.disk` namespace
- Status bar: free space, item count, selection size

### App 2: Text Editor (replace current `EditorApp`)
**Priority:** High — replaces partial existing implementation  
**Features:**
- Multi-file tabs (buffer per file)
- Ctrl+S save to VFS or disk, Ctrl+O open
- Find/replace (Ctrl+F / Ctrl+H)
- Syntax highlight for .ts/.js (token colorizer)
- Line numbers, cursor pos in status bar
- Auto-indent, bracket matching

### App 3: System Monitor
**Priority:** Medium — validates live data (procFS, scheduler, physAlloc)  
**Features:**
- Top-half: CPU/memory bar graphs updated live (~2s refresh)
- Bottom-half: process list table (from `ps()` data)
- Click process to send SIGTERM
- Network tab: rx/tx bytes/packets from `/proc/net/dev`
- Disk tab: FAT stats (used/free sectors)

### App 4: Terminal Emulator (replace current `TerminalApp`)
**Priority:** Medium  
**Features:**
- VT100-style terminal: cursor, colors, scroll, clear
- Runs the REPL inside the WM window
- History via up/down arrows
- Paste from clipboard (Ctrl+V)
- Multiple terminal windows (each with its own REPL state)

### App 5: Settings
**Priority:** Low  
**Features:**
- Display: hostname, theme color, font size
- Network: show IP/MAC/DNS, manual DHCP refresh
- Users: add/remove accounts, change password
- About: OS version, build info, uptime

---

## 6. Execution Order

```
2A  App interface (onFocus/onBlur/onResize)       ← do first (apps depend on it)
2B  SDK: os.disk                                   ← do second (apps need persistence)
2C  WM: clipboard string                           ← short
2G  SDK: os.clipboard                              ← short (depends on 2C)
2F  WM: onResize canvas rebuild                    ← short
2D  test() expansion                               ← validates everything
2H  JSDoc on SDK                                   ← last (polish)

───── solidification complete ─────

App 1:  File Manager
App 2:  Text Editor
App 3:  System Monitor
App 4:  Terminal Emulator
App 5:  Settings
```

Each solidification step should be followed by `npm run bundle` + headless boot test to confirm no regressions before proceeding to the next.
