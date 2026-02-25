# JSOS Before-JIT OS Architecture Updates

**Goal:** Refactor the OS so every app runs in its own isolated child runtime
before the JIT lands. This ensures JIT compilation targets app code in the
right place from day one, and gives the OS a clean kernel/userspace boundary.

---

## Why This Must Happen First

The JIT plan correctly handles child runtimes (deferred compilation, partitioned
pool, per-slot reclaim on `procDestroy`). But currently all apps run in the
**main runtime** alongside the OS kernel. If JIT lands now:

- A `fib()` hot loop in the terminal app gets JIT-compiled in the kernel heap
- The browser's page scripts run in the kernel heap (`new Function()` in main runtime)
- A buggy or malicious page can corrupt the kernel's 50 MB memory space
- Moving apps to child runtimes later means re-testing everything JIT-related

Do this refactor first. The JIT plan does not change; it just lands in the
right place.

---

## Current Architecture (Problem)

```
Main runtime (50 MB) — JavaScript kernel + everything else
├── OS kernel (scheduler, init, syscalls, IPC broker)
├── Window manager + compositor
├── Terminal app     ← Canvas object in main GC heap; render() in main runtime
├── Editor app       ← Canvas object in main GC heap; render() in main runtime
├── File manager     ← Canvas object in main GC heap; render() in main runtime
├── Browser chrome   ← Canvas object in main GC heap; render() in main runtime
│     └── Page JS via new Function() ← SAME GC HEAP AS KERNEL
└── System monitor   ← Canvas object in main GC heap; render() in main runtime
```

All app code and all canvas pixel buffers live in the single 50 MB main runtime
GC heap. A crashing app can corrupt the kernel's allocations. A hot browser
page script accumulates `call_count` against the kernel's own function objects.
A memory-leaking app gradually starves the kernel's 50 MB pool.

---

## Target Architecture

```
Main runtime (50 MB) — kernel only
├── Boot / init
├── Cooperative scheduler (procTick round-robin — already in wm._tickChildProcs)
├── Window manager / compositor
│     reads app BSS render slabs → ChildProcApp proxies → composites to screen Canvas → flip()
├── FS driver
├── Input routing (keyboard/mouse → focused app event queue)
└── JIT service (deferred child JIT, Step 11 of JIT plan)

Child runtimes (4 MB each, up to 8)
├── Terminal app    → 2 MB BSS render slab + event queue
├── Editor app      → 2 MB BSS render slab + event queue
├── File manager    → 2 MB BSS render slab + event queue
├── Browser chrome  → 2 MB BSS render slab + event queue
│     └── Page JS via new Function() ← browser's 4MB GC heap, not kernel
├── System monitor  → 2 MB BSS render slab + event queue
└── (user-spawned worker processes — no render slab, IPC only)
```

---

## Phase A: Shared Framebuffer Rendering Infrastructure

> **IMPORTANT — actual rendering model:**  
> JSOS does NOT use VGA mode (8bpp at 0xA0000) or C-level `kernel.fillRect`
> calls. The system uses a **32-bit BGRA linear framebuffer**. A `Canvas` is a
> JavaScript `Uint32Array` owned by the QuickJS GC. Apps draw via TypeScript
> instance methods (`canvas.fillRect()`, `canvas.drawText()`, etc.). When a
> frame is complete, `canvas.flip()` calls `kernel.fbBlit(arrayBuffer, x, y, w, h)`
> which calls C's `platform_fb_blit(uint32_t*, x, y, w, h)` for the actual
> hardware write. There is no intermediate VGA memory, no `kernel.fillRect` C
> function, and no 8bpp pixel format anywhere in the pipeline.

**The key problem:** A child runtime's Canvas `Uint32Array` lives in the child's
4 MB QuickJS GC heap. The main-runtime WM cannot directly dereference a live
QuickJS value from a different runtime (different GC, different heap pointer
space). We need a **stable, physically-addressed BSS slab** that serves as the
pixel surface — accessible by pointer from both runtimes without GC entanglement.

### A1 — Per-App 32bpp Render Buffers

Add a dedicated BSS array of render surfaces, one per child slot, sized for
32-bit BGRA pixels at the maximum supported window content resolution.

**Size calculation:**  
- 800×500 content area @ 32bpp (4 bytes/pixel) = 1,600,000 bytes ≈ 1.56 MB  
- Round up to 2 MB to allow 1024×512 windows with no reallocation

```c
/* quickjs_binding.c */
#define RENDER_BUF_BYTES  (2 * 1024 * 1024)   /* 2 MB — 1024×512 @ 32bpp */
static uint8_t _app_render_bufs[JSPROC_MAX][RENDER_BUF_BYTES]
               __attribute__((aligned(4096)));
```

Expose the slab to the child runtime as an **ArrayBuffer** backed by the raw
BSS pointer (no copy, zero allocations):

```c
/* kernel.getRenderBuffer() — child runtime only.
   Returns an ArrayBuffer wrapping this slot's BSS render surface. */
static JSValue js_child_get_render_buf(JSContext *c,
                                       JSValue this_val,
                                       int argc, JSValue *argv) {
    int slot = _cur_proc;   /* set by js_proc_tick before child runs */
    if (slot < 0 || slot >= JSPROC_MAX) return JS_EXCEPTION;
    void *ptr = _app_render_bufs[slot];
    return JS_NewArrayBuffer(c, ptr, RENDER_BUF_BYTES,
                             NULL, NULL, 0 /* not shared ownership */);
}
```

Also expose to the **main runtime** for WM use:

```c
/* kernel.getProcRenderBuffer(id) — main runtime only.
   Returns an ArrayBuffer wrapping slot `id`'s BSS render surface. */
static JSValue js_get_proc_render_buf(JSContext *c,
                                      JSValue this_val,
                                      int argc, JSValue *argv) {
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX) return JS_EXCEPTION;
    void *ptr = _app_render_bufs[id];
    return JS_NewArrayBuffer(c, ptr, RENDER_BUF_BYTES,
                             NULL, NULL, 0);
}
```

### A2 — Canvas Class in Child Runtime (External Backing Buffer)

The child app must be able to draw using the same Canvas API it uses today
(fillRect, drawText, etc.) but targeting the BSS render surface rather than a
GC-allocated Uint32Array.

**Approach:** Extend the existing `Canvas` TypeScript class to accept an
optional external `ArrayBuffer` as its pixel backing:

```typescript
/* src/os/ui/canvas.ts */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private _buf: Uint32Array;
  private _external: boolean;

  constructor(width: number, height: number, externalBuf?: ArrayBuffer) {
    this.width  = width;
    this.height = height;
    if (externalBuf) {
      this._buf = new Uint32Array(externalBuf, 0, width * height);
      this._external = true;
    } else {
      this._buf = new Uint32Array(width * height);
      this._external = false;
    }
  }

  /** flip() is a no-op for external-backed canvases — WM reads the BSS
   *  slab directly without any fbBlit call from the child side. */
  flip(): void {
    if (!this._external) {
      /* normal path: blit this._buf to hardware framebuffer */
      kernel.fbBlit(this._buf.buffer, 0, 0, this.width, this.height);
    }
    /* external path: pixels are already visible in the BSS slab — NOP */
  }

  /* fillRect, drawText, drawPixel, blit, etc. — unchanged, all write to
   * this._buf regardless of whether it is external or GC-owned. */
}
```

The child app initialises its canvas once at startup:

```typescript
/* Child app boilerplate (runs inside child QuickJS runtime) */
const renderBuf = kernel.getRenderBuffer();          // BSS ArrayBuffer
const W = kernel.getWidth();
const H = kernel.getHeight();
const canvas = new Canvas(W, H, renderBuf);   // draws directly into BSS

function frame(): void {
  const ev = kernel.pollEvent();
  if (ev) handleEvent(ev);

  canvas.clear(0xFF111111);
  canvas.drawText(10, 10, 'Hello', 0xFFFFFFFF);
  /* flip() is a NOP — WM reads BSS slab each frame automatically */

  kernel.windowCommand({ type: 'renderReady' });
  kernel.setTimeout(16, frame);
}
kernel.setTimeout(0, frame);
```

**What to bundle into each app:** The Canvas class (compiled JS), any utility
libraries the app uses, and the app entry point. The `procEval` call feeds this
bundled string to the child runtime.

### A3 — WM Compositor: Read Shared Slab via `fbBlit`

The WM's `_composite()` loop already handles compositing: it calls
`s.blit(win.canvas, ...)` to copy each window's Canvas onto the screen Canvas,
then `s.flip()` fires one `platform_fb_blit` to hardware.

For child-runtime windows, `win.canvas` does not exist as a GC object in the
main runtime anymore. Instead, the WM's "proxy App" object for a child-runtime
window overrides `render(wmCanvas)` to pull pixels from the shared BSS slab:

```typescript
/* Proxy App — lives in main runtime, represents a child-runtime app */
class ChildProcApp implements App {
  constructor(
    private readonly procId: number,
    private readonly w: number,
    private readonly h: number,
  ) {}

  render(wmCanvas: Canvas): boolean {
    /* Pull the child's BSS render slab and blit it into the WM window canvas */
    const sharedBuf = kernel.getProcRenderBuffer(this.procId);  // zero-copy
    wmCanvas.blitFromBuffer(sharedBuf, 0, 0, 0, 0, this.w, this.h);
    return true;  /* always dirty — child may have drawn anything */
  }

  onMount(_win: WMWindow): void {}
  onKey(ev: KeyEvent): void   { kernel.procSendEvent(this.procId, ev); }
  onMouse(ev: MouseEvent): void { kernel.procSendEvent(this.procId, ev); }
}
```

`Canvas.blitFromBuffer(srcBuf: ArrayBuffer, ...)` is a new overload on the
Canvas class (TypeScript) that reads a raw `Uint32Array` view of `srcBuf` and
copies pixels into `this._buf` — a pure-JS row copy with no additional syscalls.

The WM's existing `_composite()` logic, `drawOneWindow()`, `s.blit()`, and final
`s.flip()` remain **entirely unchanged** — they just see a proxy App whose
`render()` happens to populate the window Canvas from BSS rather than from app
logic running in the same runtime.

**No changes to `platform_fb_blit`, `js_fb_blit`, or any C rendering code.**

---

## Phase B: Expanded Child Kernel API

Child runtimes currently only have: `postMessage`, `pollMessage`, `getTicks`,
`getUptime`, `sleep`, `getMemoryInfo`. Apps need more.

### B1 — Canvas Class in Child Runtime (Bundle, Not C)

> **Do NOT add C-level `js_child_fill_rect` / `js_child_draw_text` etc.**
> That would duplicate the entire Canvas implementation in C. Apps already use
> the TypeScript `Canvas` class — not `kernel.fillRect` C calls. The correct
> approach is to **bundle the Canvas class JS into each app's code bundle** so
> the child runtime has a full Canvas implementation in pure JavaScript.

Apps are migrated from importing `Canvas` as a TypeScript module (main runtime)
to receiving a compiled, inlined copy of the Canvas class in their bundle.

**Build step (app bundler):** The existing `scripts/bundle-hybrid.js` is
extended to prepend the compiled `canvas.js` output (from `src/os/ui/canvas.ts`)
to every app bundle:

```
[compiled canvas.ts JS]     ← Canvas class, font data, all utilities
[compiled app code JS]      ← the app itself
```

The child runtime evaluates this bundle via `kernel.procEval(id, bundle)`.
After evaluation the `Canvas` class is available in the child's global scope.

**Canvas modifications required (Phase A2 already covers this):**
- Add `Canvas(w, h, externalBuf?: ArrayBuffer)` constructor overload
- Make `flip()` a no-op when `externalBuf` is provided
- No other changes — `fillRect`, `drawText`, `blit`, etc. are already pure JS
  that writes into `this._buf` and are unchanged

**No new C code for B1.** The only C additions are in Phase A1:
`kernel.getRenderBuffer()` (child side) and `kernel.getProcRenderBuffer(id)`
(main side). Those two C functions are all the kernel plumbing needed.

### B2 — FS Access

Apps need the filesystem. Add FS functions to the child API:

```c
JS_CFUNC_DEF("fsReadFile",   1, js_child_fs_read_file),
JS_CFUNC_DEF("fsWriteFile",  2, js_child_fs_write_file),
JS_CFUNC_DEF("fsReadDir",    1, js_child_fs_read_dir),
JS_CFUNC_DEF("fsExists",     1, js_child_fs_exists),
JS_CFUNC_DEF("fsStat",       1, js_child_fs_stat),
```

These delegate to the same underlying FS implementation used by the main runtime.
**No locking is needed** — JSOS is single-core cooperative; only one runtime
runs at a time.

### B3 — Timer API

Apps need `setTimeout` / `setInterval`. The cooperative scheduler can service
these after each `procTick`:

```c
/* kernel.setTimeout(ms) → timer id — fires on next procTick after `ms` elapsed */
JS_CFUNC_DEF("setTimeout",    2, js_child_set_timeout),
JS_CFUNC_DEF("clearTimeout",  1, js_child_clear_timeout),
JS_CFUNC_DEF("setInterval",   2, js_child_set_interval),
JS_CFUNC_DEF("clearInterval", 1, js_child_clear_interval),
```

Timer state is stored per-slot in C (`_proc_timers[JSPROC_MAX][MAX_TIMERS]`).
The scheduler checks expired timers before each `procTick` and queues the
callbacks as pending jobs in the child's runtime via a JS callback mechanism
(inject code that invokes the registered handler functions by ID).

### B4 — Event Inbox

Replace the raw string `pollMessage` with a typed event system for input:

```c
/* kernel.pollEvent() → { type, key, keyCode, mouseX, mouseY, button } | null */
JS_CFUNC_DEF("pollEvent", 0, js_child_poll_event),
```

The WM routes keyboard and mouse events to the focused app's event queue.
`pollEvent` returns the next queued event object or `null` if the queue is empty.
Apps call this in their main loop / timer callback.

### B5 — Window Commands

Apps communicate with the WM via structured outbox messages:

```typescript
// From within a child runtime — sent via kernel.windowCommand():
kernel.windowCommand({ type: 'setTitle', title: 'My App' });
kernel.windowCommand({ type: 'resize', w: 800, h: 500 });
kernel.windowCommand({ type: 'close' });
kernel.windowCommand({ type: 'renderReady' });  // "I've finished drawing this frame"
```

```c
JS_CFUNC_DEF("windowCommand", 1, js_child_window_command),
```

Serializes the command object as JSON into the child's outbox. The WM in the
main runtime polls outboxes after each compositor pass and handles commands.

---

## Phase C: App Launch Protocol

### C1 — App Manifest

Each app is described by a manifest:

```typescript
interface AppManifest {
  name: string;
  title: string;
  width: number;
  height: number;
  code: string;          // bundled JS (the compiled TypeScript app)
  singleInstance?: boolean;
}
```

### C2 — App Launcher

The WM's `launchApp(manifest)` function:

```typescript
function launchApp(manifest: AppManifest): number {
  const procId = kernel.procCreate();
  if (procId < 0) throw new Error('No free process slots');

  // Open a window backed by this process's render buffer
  const win = wm.openWindow({
    title: manifest.title,
    x: ..., y: ...,
    w: manifest.width,
    h: manifest.height,
    procId,
  });

  // Install the app's JS code into the child runtime
  kernel.procEval(procId, manifest.code);

  // Start the render/event loop for this app in the scheduler
  scheduler.register(procId);
  return procId;
}
```

### C3 — App Boilerplate (child runtime side)

The app bundle begins with the compiled Canvas class (from Phase B1 bundling),
so `Canvas` is available globally. The app then initialises its canvas using
the BSS shared render slab (Phase A2) and runs a timer-driven frame loop:

```typescript
/* --- Injected by launcher before app code (via procEval) ---
 * Available globals: Canvas (from bundled canvas.js)
 * Available kernel calls: getRenderBuffer(), getWidth(), getHeight(),
 *   pollEvent(), windowCommand(), setTimeout(), clearTimeout() */

const W = kernel.getWidth();
const H = kernel.getHeight();
const canvas = new Canvas(W, H, kernel.getRenderBuffer());
/* canvas.flip() is now a NOP — WM reads the BSS slab directly */

kernel.windowCommand({ type: 'setTitle', title: 'Terminal' });

function frame(): void {
  /* Drain event queue */
  let ev: any;
  while ((ev = kernel.pollEvent()) !== null) {
    handleEvent(ev);
  }

  /* Draw frame directly into BSS slab — no flip() needed */
  canvas.clear(0xFF111111);
  canvas.drawText(10, 10, 'Hello from child runtime', 0xFFFFFFFF);

  /* Signal WM: pixels are ready (marks WM dirty, triggers composite) */
  kernel.windowCommand({ type: 'renderReady' });
  kernel.setTimeout(16, frame);   /* ~60 fps */
}
kernel.setTimeout(0, frame);
```

---

## Phase D: Browser App Isolation

With the browser running in its own child runtime:

- Page JS runs via `new Function()` **inside the browser's child heap** (4 MB)
- A runaway page can exhaust the browser's 4 MB heap → browser crashes and is
  restarted, OS continues running
- Page JS that hits `JIT_THRESHOLD` gets compiled into the browser child's
  512 KB JIT pool partition — hot page animations, game loops, etc. benefit
  from JIT without touching the kernel

The browser's `jsruntime.ts` (`createPageJS`) requires no changes — it already
uses `new Function()` for sandboxing. The only change is that it runs inside a
child runtime instead of the main runtime.

---

## Phase E: Scheduler Update

> **The main event loop already works.** `main.ts` runs:
> ```typescript
> for (;;) {
>   kernel.yield();       // unblock sleeping JS threads
>   wmInst.tick();        // full frame pipeline
>   kernel.sleep(16);     // hlt until next PIT tick
> }
> ```
> `wm.tick()` already calls `_tickChildProcs()` → `kernel.procTick(id)` for
> every live child process, as well as `threadManager.tickCoroutines()` for
> async coroutines and `scheduler.tick()` for time-slice accounting.
>
> **Do NOT replace this loop** — it is correct. Phase E is an additive pass
> that bolts three missing pieces onto the existing `wm.tick()` pipeline.

### E1 — Input Routing to Focused Child App

Currently `_pollInput()` dispatches keyboard/mouse events to `win.app.onKey(ev)`
and `win.app.onMouse(ev)`. For a `ChildProcApp` (Phase A3 proxy), the proxy's
`onKey` / `onMouse` implementations call `kernel.procSendEvent(procId, ev)` (a
new C function that serialises the event as JSON and pushes it into the child's
event queue). The child calls `kernel.pollEvent()` to dequeue.

**Changes to `wm.ts`:** zero — `onKey/onMouse` on the proxy App already do
the right thing (see Phase A3). `_pollInput()` is unchanged.

**Changes to `quickjs_binding.c`:**
- `js_proc_send_event(id, jsonStr)` — push a serialised event into
  `_proc_event_queues[id]`, a small ring buffer (16 slots of 256 bytes)
- `js_child_poll_event()` — dequeue the next entry and parse it into a JS object

### E2 — Window Command Processing

After `_tickChildProcs()`, scan each live child's outbox for window commands:

```typescript
/* wm.ts — _tickChildProcs() extended */
private _tickChildProcs(): void {
  var list = kernel.procList();
  if (list.length === 0) return;
  for (var i = 0; i < list.length; i++) {
    kernel.procTick(list[i].id);
    serviceTimers(list[i].id);         // Phase B3 — NOP until B3 is done
    this._processWindowCommands(list[i].id);
  }
}

private _processWindowCommands(procId: number): void {
  var cmd: any;
  while ((cmd = kernel.procDequeueWindowCommand(procId)) !== null) {
    switch (cmd.type) {
      case 'setTitle':
        const win = this._findWindowByProc(procId);
        if (win) { win.title = cmd.title; this._wmDirty = true; }
        break;
      case 'close':
        this._closeWindowByProc(procId);
        break;
      case 'renderReady':
        /* pixels already in BSS slab — no action needed; _composite()
         * reads the slab on every frame anyway via the ChildProcApp proxy */
        this._wmDirty = true;
        break;
    }
  }
}
```

**`kernel.procDequeueWindowCommand(id)`** — new C function, mirrors
`js_child_window_command` enqueue on the child side.

### E3 — Timer Service (depends on B3)

After `kernel.procTick(id)`, check `_proc_timers[id]` for expired entries.
For each expired timer, inject the callback invocation into the child's pending
job queue via a small `JS_Eval` of `"__timerFire(" + timerId + ")"` where
`__timerFire` is a global set up in the child's init script.

This is Phase B3's implementation detail — include it in the same PR.

### E4 — `threadManager.tickCoroutines()` Must Stay

The existing `wm.tick()` calls `threadManager.tickCoroutines()` to drive
cooperative `fetch()` and async coroutines in the main runtime. This call
**must not be removed** during any scheduler refactor. Phase E's additions (E1,
E2, E3) are all inserted around existing calls, never replacing them.

**Updated `wm.tick()` (final, with all phases applied):**

```typescript
tick(): void {
  this._pollInput();
  this._tickChildProcs();     // procTick + timer service + window commands (E2/E3)
  scheduler.tick();
  threadManager.tickCoroutines();   // ← must stay — drives async/fetch
  this._composite();
}
```

---

## Migration Order

| Step | What | Risk |
|---|---|---|
| A1 | BSS render slabs + `getRenderBuffer` / `getProcRenderBuffer` C functions | Low — additive C |
| A2 | Canvas external-buffer constructor + NOP flip | Low — additive TypeScript |
| A3 | `ChildProcApp` proxy + `Canvas.blitFromBuffer` | Medium — new WM path |
| B1 | App bundler prepends canvas.js (build tooling only) | Low — no runtime change |
| B2 | Child FS API | Low — additive |
| B3 | Child timer API | Medium — scheduler integration |
| B4 | Child event API (`pollEvent`, `procSendEvent`) | Medium — new input path |
| B5 | Window commands (`windowCommand`, `procDequeueWindowCommand`) | Low — additive |
| C1–C3 | App launch protocol + `launchApp()` | High — touches every app |
| D | Browser isolation | Medium — browser refactor |
| E2/E3 | `_processWindowCommands` + timer service in `_tickChildProcs` | Low — additive |

**Suggested order:** A1 → A2 → A3 → B1 → B2 → B4 → B5 → E2 → C (migrate
apps one at a time, terminal first) → B3 → E3 → D

Phase E1 (input routing) is implicit in A3: `ChildProcApp.onKey` calls
`kernel.procSendEvent`. Implement B4 and B5 before migrating any app.

Migrate apps one at a time. Keep the original direct-render TypeScript app path
working in parallel until every app is ported and the `main.ts` boot sequence
is updated to use `launchApp()` instead of importing app modules directly.

---

## What Does NOT Change

- The JIT plan (`jit-unrolled-plan.md`) is unchanged — it already handles child
  runtimes correctly via the deferred JIT mechanism and partitioned pool.
- QuickJS is unchanged — no new source modifications beyond what the JIT plan
  already specifies.
- The main runtime's existing `canvas.ts` API is unchanged for OS/WM code.
  Only the constructor gains an optional `externalBuf` parameter.
- IPC ring buffers (`procSend`/`procRecv`) remain for user-spawned worker
  processes. The new event/window-command system is layered on top, used only
  by apps managed by the WM.
- The main event loop in `main.ts` is unchanged: `kernel.yield(); wmInst.tick(); kernel.sleep(16)`.
- `wm.tick()` call order is unchanged: `_pollInput → _tickChildProcs → scheduler.tick → threadManager.tickCoroutines → _composite`. Phase E adds processing *within* `_tickChildProcs`, not after `_composite`.
- `platform_fb_blit` and all C rendering infrastructure are unchanged.
- The main runtime's existing kernel API is unchanged — only additions.

---

## Memory Budget After This Refactor

> **Pixel format note:** Render buffers are 32-bit BGRA (4 bytes/pixel).
> Previous plan revision used an incorrect 8bpp model with 512 KB buffers.

| Region | Size | Notes |
|---|---|---|
| Main runtime JS heap (`JS_SetMemoryLimit`) | 50 MB | software cap |
| 8× child app runtimes (`JS_SetMemoryLimit`) | 8× 4 MB = 32 MB | software cap |
| App render buffers BSS (32bpp) (`_app_render_bufs`) | 8× 2 MB = **16 MB** | added by this plan |
| Shared memory buffers BSS (`_sbufs`) | 8× 256 KB = **2 MB** | existing |
| JIT pool BSS (`_jit_pool`) | **12 MB** | expanded by jit-unrolled-plan Step 1 |
| `fb_blit_buf` BSS (`uint32_t[1024×768]`) | **3 MB** | slow-path blit fallback |
| `_procs[8]` BSS (inbox + outbox ring buffers) | **~256 KB** | 32,868 B × 8 slots |
| `memory_pool[1MB]` (`memory.c`) | **1 MB** | dead — `memory_allocate()` never called; zeroed at boot by `memory_initialize()` |
| `_user_pds[32][1024]` uint32_t (`quickjs_binding.c`) | **128 KB** | user-mode page directory pool |
| `rx_bufs[256][2048]` + `tx_bufs[256][2048]` (`virtio_net.c`) | **1 MB** | virtio-net DMA ring buffers |
| `_jit_write_buf[JIT_ALLOC_MAX]` (`quickjs_binding.c`) | **64 KB** | slow-path buffer for `kernel.jitWrite(addr, number[])` |
| Other BSS (stack 32 KB, `paging_pd` 4 KB, `ata_sector_buf` 4 KB, `_asm_buf` 4 KB, net bufs ~3 KB, IPC strings ~4 KB, keyboard ~256 B) | **~52 KB** | |
| **Total BSS** | **~35.5 MB** | |
| **Total QuickJS heap reservation** | **82 MB** | |
| **Combined** | **~117.5 MB** | |

Derivation of BSS total:
16 + 2 + 12 + 3 + 0.256 + 1 + 0.128 + 1 + 0.064 + 0.052 = **35.5 MB**

`_heap_start` (kernel load 1 MB + code/data ~2 MB + BSS ~35.5 MB) ≈ **~38.5 MB**
`_heap_end` = `_heap_start` + 256 MB ≈ **~294.5 MB**
`KERNEL_END_FRAME` = 81,920 × 4096 = **320 MB** — physAlloc bitmap starts above `_heap_end` ✓
Safety margin: 320 − 294.5 = **~25.5 MB**

**QEMU already runs at `-m 4G`.** See `scripts/test.sh` and
`scripts/test-interactive.sh`. There is no memory constraint requiring
changes to QEMU flags, linker script, or child heap sizes.

The QuickJS memory limits (50 MB main, 4 MB per child) are software caps
enforced by `JS_SetMemoryLimit` — they bound GC heap growth, not physical
page allocation. All figures above fit trivially within 4 GB.

