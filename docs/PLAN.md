# JSOS — Active Plan

**Branch:** `JIT-DESKTOP-5`  
**Date:** 2026-03-06  
**Focus:** Blazing fast — JS execution, GC, rendering pipeline, profiling, workers.

---

## What Just Shipped (JIT-DESKTOP-5)

All P0/P1 JIT items are done and running on bare metal:

| Done | What |
|---|---|
| ✅ | QuickJS → x86-32 JIT compiler (`qjs-jit.ts`) |
| ✅ | Inline caches: property read + write, shape guards |
| ✅ | Type specialization: Int32 + Float64 (x87 FPU) |
| ✅ | Register allocator (EBX hot-local promotion) |
| ✅ | On-stack replacement (OSR) mid-loop entry |
| ✅ | Deopt trampolines + deopt log page |
| ✅ | Profile-guided inlining (PGI, SpeculativeInliner) |
| ✅ | Dead code elimination, typeof-guard elimination |
| ✅ | Escape analysis pass |
| ✅ | Code cache (256-entry, 2 MB, serialize/deserialize) |
| ✅ | Array IC + typed-array fast path |
| ✅ | Tiered compilation (interpreter → tier-1 → tier-2) |
| ✅ | 64 JIT kernels operational |
| ✅ | JIT canvas: fillBuffer, fillRect, blitRow, blitAlphaRow, glyphRow |
| ✅ | Incremental layout, damage rectangles, scroll blit |
| ✅ | Per-block layout sub-cache (BlockLayoutCache) |
| ✅ | Compositor + AnimationCompositor (bypass layout/paint for transform/opacity) |
| ✅ | Tile dirty-bit renderer (TileDirtyBits + TileRenderer) |
| ✅ | TLS session tickets + 0-RTT resumption |
| ✅ | HTTP/2 + HPACK + server push |
| ✅ | HTTP keep-alive pool, DNS TTL cache |
| ✅ | ResourceCache (mem L1 + disk L2) |
| ✅ | GC stubs: IncrementalGC, ObjectPool, ArrayBufferPool, StringInterning |
| ✅ | Web Workers (WorkerImpl, MessageChannel, postMessage) |
| ✅ | PerformanceObserver, paint/frame/resource timing |
| ✅ | CSS @font-face, clip-path, mask, filter |

---

## Phase 1 — JIT Compiler P2 Completions

The P2 compiler passes are currently stubs. Making them real closes most of the remaining gap vs V8.

**Files:** `src/os/process/qjs-jit.ts`

| # | Task | Stub location | What to implement |
|---|---|---|---|
| 1.1 | **Loop Invariant Code Motion (LICM)** | `LICMPass.analyze()` returns empty set | Real SSA-lite loop analysis: identify loop headers via backward-jump scan (already in `BytecodePreAnalysis.loopHeaders`); any `OP_get_field` / `OP_get_var` not written inside the loop body is invariant; hoist before loop header |
| 1.2 | **Constant folding** | `ConstantFolder.fold()` detects but never patches | Consecutive `OP_push_i32; OP_push_i32; OP_add/sub/mul` → single `OP_push_i32(result)`; use `kernel.qjsPatchBc()` to write folded value; handle `Math.PI`, `Math.E`, `Math.LN2` as known constants |
| 1.3 | **Range analysis / bounds-check elimination** | `RangeAnalysis.analyze()` returns empty map | Track min/max of loop induction variable via loop-header pattern; if `i` ∈ `[0, arr.length)` provably, emit array IC without bounds-check guard |
| 1.4 | **`arguments` object elimination** | `ArgumentsElimPass.canEliminate()` detects, codegen ignores | When `canEliminate()` is true: skip `create_arguments_object` in prologue, patch `OP_ARGUMENTS` (0x37) to `OP_undefined`, saves 1 alloc + GC pressure per call |
| 1.5 | **`Promise` fast path** | `PromiseFastPath.isApplicable()` stub | Detect async function whose single `await` is at the tail; skip suspended-generator object allocation; resolve continuation directly via `_drainMicrotasks()` inline |
| 1.6 | **`async/await` desugaring opt** | `AsyncDesugar.desugar()` stub | Linear async function (single tail await): rewrite as regular function returning `Promise.resolve(value).then(continuation)` — eliminates one generator state machine per call |

---

## Phase 2 — GC: Make the Stubs Real

The GC classes in `src/os/process/gc.ts` are architecturally complete but the core algorithms are placeholders. This is the biggest source of frame stutter on JS-heavy pages.

**File:** `src/os/process/gc.ts`

| # | Task | What to implement |
|---|---|---|
| 2.1 | **`IncrementalGC.slice(budgetMs)`** | Real tri-color mark-sweep: gray worklist, time-check every 64 objects, suspend at budget. Currently a single-pass full pause. |
| 2.2 | **`IncrementalGC.minorGC()`** | Cheney semi-space copy for the young generation (< 0.5 ms). Evacuate survivors to old gen. |
| 2.3 | **`WriteBarrier.write(owner, target)`** | Dijkstra barrier: if `owner` is black and `target` is white, regrays `target`. Wire `RememberedSet` to track old→young pointers for generational correctness. |
| 2.4 | **`NurserySizeTuner.feedback(pauseMs)`** | If last minor GC pause > 0.3 ms, halve nursery next cycle. If pause < 0.1 ms, grow by 25%. Default nursery = 4 MB, old = 128 MB. |
| 2.5 | **`ObjectPool<T>` hot path** | Wire `acquire()`/`release()` into VNode/VElement allocation in `dom.ts` — avoids allocating a new object per DOM mutation. Already has the pool; needs call sites. |
| 2.6 | **`ArrayBufferPool` call sites** | Wire into `net/http.ts` recv buffers and `audio/index.ts` PCM buffers — the two hottest allocation sites outside the browser. |

---

## Phase 3 — Rendering: Real 60fps Pipeline

The compositor and tile renderer exist but are not fully wired into the browser's main paint loop.

**Files:** `src/os/apps/browser/render.ts`, `src/os/apps/browser/index.ts`

| # | Task | What to implement |
|---|---|---|
| 3.1 | **Tile dirty integration** | `TileRenderer` exists but `_drawContent()` in `index.ts` still clears the full viewport. Replace clear+full-paint with: mark dirty tiles from `_damage` rect, call `TileRenderer.paintDirtyTiles()`, skip clean tiles. |
| 3.2 | **Text atlas pre-warm** | `TextAtlas` pre-rasterizes ASCII 0x20–0x9F on page load. Currently re-rasterizes glyphs on first use per page. Call `TextAtlas.prewarm()` during `_initPage()`. |
| 3.3 | **Compositor: transform/opacity bypass** | `AnimationCompositor` exists. Wire it so `transform` and `opacity` CSS animations tick via `_tickTransitions()` → compositor → blit, without calling `doRerender()` (no layout, no paint). Gate on `_damage` being empty. |
| 3.4 | **Border/shadow cache call sites** | `BorderShadowCache` pre-rasterizes. Wire into `_drawElement()` for elements with `border` or `box-shadow` so repeat paint of the same element is a cache hit. |
| 3.5 | **Double-buffer vsync** | Render to an off-screen buffer; flip to framebuffer exactly on PIT 60 Hz tick. Eliminates screen tearing on fast pages. |
| 3.6 | **Solid-fill fast path** | For elements with solid `background-color` and no overlapping children, use `Compositor.solidFillLayer()` — skip full compositing pass. |

---

## Phase 4 — TSC Timing + Profiling Infrastructure

| # | Task | File | What to implement |
|---|---|---|---|
| 4.1 | **RDTSC `performance.now()`** | `kernel/quickjs_binding.c`, `apps/browser/perf.ts` | `js_rdtsc()` binding returns TSC as `[lo, hi]` pair; `BrowserPerformance.now()` converts via measured TSC-to-ms ratio (calibrated against PIT at boot). Sub-microsecond resolution. |
| 4.2 | **JIT profiler API** | `process/qjs-jit.ts`, `core/sdk.ts` | `sys.jit.stats()` returns `{compiled, deoptCount, icMisses, cacheHits, topFunctions: [{name, calls, nativeAddr}[]]}`. Read from `PGIManager` + `InlineCacheTable` + `JITCodeCache`. |
| 4.3 | **GC profiler API** | `process/gc.ts`, `core/sdk.ts` | `sys.mem.gcStats()` returns `{minorPauses: number[], majorPauses: number[], totalFreedBytes, liveObjects, poolHitRate}`. Wire from `IncrementalGC` instrumentation. |
| 4.4 | **Layout profiler** | `apps/browser/layout.ts` | Per-subtree layout timing: `performance.mark()` before/after each block's layout; `_layoutStats` accumulates per-tag-id. `sys.browser.layoutStats()` returns hot nodes. |
| 4.5 | **ASCII flame graph** | `core/sdk.ts`, `ui/repl.ts` | `sys.perf.flame()` collects 100 ms of call-site samples from JIT profiler; renders ASCII flame chart to terminal (width = 80 chars, depth = call stack). |

---

## Phase 5 — SDK Gaps

Remaining `os.*` API surface from the Feb 24 plan that was not yet implemented.

**File:** `src/os/core/sdk.ts` (unless noted)

| # | Item | Effort | Notes |
|---|---|---|---|
| 5.1 | **`os.time`** | S | `kernel.outb(0x70, reg); kernel.inb(0x71)` CMOS RTC. `now()`, `date()`, `format()`, `since()`, `duration()`. Cache epoch at boot, subsequent `now()` = epoch + uptime delta. |
| 5.2 | **`os.net` raw sockets** | M | `RawSocket` wrapping `net.connectAsync` / `connectPoll` / `recvBytesNB`. `os.net.connect(host, port, cb, {tls?, timeoutMs?})`. Coroutine-driven, same pattern as `fetchAsync`. |
| 5.3 | **`os.canvas.drawGradient`** | M | Linear + radial gradient fill. Required for Aero glass effects. `canvas.ts` + sdk.ts. |
| 5.4 | **`os.canvas.drawSprite`** | S | Pixel-art icon/sprite blit. `canvas.ts`. |
| 5.5 | **`os.anim`** | S | `start(fn, fps)`, `stop(id)`, `lerp(a, b, t)`, `ease{In,Out,InOut}(t)`. Frame-based animation driver on top of `requestAnimationFrame`. |
| 5.6 | **`os.wm.openModal`** | S | True modal window — blocks WM input dispatch to all non-modal windows. `wm.ts` modal stack. |
| 5.7 | **`os.wm.showContextMenu`** | S | Floating popup with items + keyboard nav. Returns `Promise<item \| null>`. |
| 5.8 | **`os.wm.showMenuBar`** | M | Horizontal menu bar anchored to window top edge. Keyboard (Alt+letter) + mouse nav. |
| 5.9 | **`os.debug`** | S | `log/warn/error/assert/inspect/measure/trace`. Serial output + WM overlay panel. |
| 5.10 | **`os.prefs.onChange(key, fn)`** | XS | Subscribe to preference key changes. Add to existing `forApp()` return object. |

---

## Phase 6 — Browser Correctness Remaining

Items from the browser audit still outstanding that affect real-world pages.

| # | Task | File | Impact |
|---|---|---|---|
| 6.1 | **Delete polyfill conflict files** | `compat-polyfills.ts`, `framework-polyfills.ts` | These overwrite real impls in `jsruntime.ts` with weaker stubs — breaking sites actively. |
| 6.2 | **CSS `contain: strict`** | `apps/browser/cache.ts` | Isolate paint/size; skip full viewport damage on contained mutation. |
| 6.3 | **`@media` breakpoint listener** | `apps/browser/jsruntime.ts` | Recompute only when viewport crosses a breakpoint boundary — not on every resize. |
| 6.4 | **Flex/grid cache** | `apps/browser/layout.ts` | Cache row/column tracks; invalidate only on container-size or child-count change. |
| 6.5 | **Passive event listeners** | `apps/browser/jsruntime.ts` | Default-passive `touchstart`/`wheel` — `preventDefault()` is a no-op for these unless `{passive: false}` explicitly passed. Never block scroll. |
| 6.6 | **`localStorage` VFS-backed** | `apps/browser/jsruntime.ts` | Persist to `/var/browser/ls/<origin>.json` so storage survives reboot. |
| 6.7 | **Service Worker intercept** | `net/http.ts` | `ServiceWorkerRegistry.intercept()` wired into `fetchAsync()`. Enables offline-first PWAs. |

---

## Priority Order

```
Phase 1 (JIT P2)  ←  biggest JS speed gains, all files already exist
Phase 2 (GC)      ←  eliminates frame stutter, already architected
Phase 3 (Render)  ←  real 60fps, wiring work only
Phase 4 (Timing)  ←  enables feedback loop for the above
Phase 5 (SDK)     ←  unblocks app developers
Phase 6 (Browser) ←  compatibility, real-world page quality
```

Phases 1–3 are the performance core. Start with **Phase 1.2 (constant folding)** and **Phase 2.1 (incremental GC slicing)** — both are self-contained and have the largest observable impact.

---

## Reference Docs (still current)

| Doc | Purpose |
|---|---|
| [architecture.md](architecture.md) | System architecture diagram |
| [kernel-api-reference.md](kernel-api-reference.md) | All `kernel.*` C↔TS bindings |
| [sys-api-reference.md](sys-api-reference.md) | All `sys.*` REPL commands |
| [internals.md](internals.md) | Scheduler, VMM, IPC internals |
| [network-internals.md](network-internals.md) | TCP, TLS, HTTP/2 internals |
| [browser-internals.md](browser-internals.md) | HTML/CSS/layout/render pipeline |
| [browser-audit.md](browser-audit.md) | Current browser API coverage matrix |
| [filesystem.md](filesystem.md) | VFS, FAT16/32, ext4, btrfs |
| [security.md](security.md) | CSP, users, process isolation |
| [design-system.md](design-system.md) | UI tokens, glass/aero components |

Archived plans are in [docs/archive/](archive/).
