# JSOS JIT & Browser Capability Plan

**Date:** 2026-06-09  
**Status:** Active roadmap  
**Principle:** TypeScript IS the OS — C exists only for raw hardware I/O primitives.

---

## Background

The JSOS JIT (`src/os/process/jit.ts`) is an x86-32 cdecl code-generator targeting int32
inner loops at the OS level. It is **not** a general-purpose JS JIT — it accelerates pixel
operations, memory scans, and numeric kernels that TypeScript cannot run fast enough for
smooth rendering at 60 fps on bare metal.

### What Exists Today

| Component | State | Location |
|---|---|---|
| JIT pool (C) — 256KB BSS | ✅ | `src/kernel/jit.c` / `jit.h` |
| `jitAlloc` / `jitWrite` / `jitCallI` (4-param) | ✅ | kernel primitives |
| `jitCallI8` (8-param cdecl) | ✅ | added Phase 11b |
| `physAddrOf(ab)` — stable ArrayBuffer pointer | ✅ | `quickjs_binding.c` |
| `jit.ts` — full TS-side compiler | ✅ | ternary, dowhile, Math.min/max/clz32, indirect call, JITProfiler |
| `jit-canvas.ts` — pixel-op library | ✅ | fillBuffer, fillRect, blitRow, blitAlphaRow, glyphRow |
| `canvas.ts` JIT fast-paths | ✅ | clear, fillRect, blit, blitAlpha |
| HTML tokenizer + VDocument DOM | ✅ | `html.ts`, `dom.ts` |
| Block + inline layout engine | ✅ | `layout.ts` — hardcoded 8×8 monospace |
| Page JS execution via QuickJS | ✅ | `jsruntime.ts` — `new Function()` |
| Fixed 8px font, no CSS box model | ❌ (gap) | see Phase 1 |
| Canvas 2D API | ❌ (gap) | see Phase 1 |
| Mutation batching / incremental layout | ❌ (gap) | see Phase 1.9 |
| Damage rects / scroll blit / JIT image blit | ❌ (gap) | see Phase 1.9 |
| `getBoundingClientRect` / `offsetWidth/Height` / layout feedback | ❌ (gap) | see Phase 1.10 |
| `queueMicrotask` correct ordering / `MessageChannel` / `TextEncoder` | ❌ (gap) | see Phase 1.11 |
| QuickJS bytecode → x86 JIT | ❌ (gap) | see Phase 2 |

### Why Two Separate Phases

**Phase 1** (browser infrastructure) unblocks the vast majority of real-world SPAs. Most
SPA rendering bottlenecks are CSS layout and Canvas 2D draw-calls, not JS execution
speed. These are pure TypeScript additions — no C code changes, no QuickJS internals.
Estimated effort: 6–8 weeks. ROI per hour: very high.

**Phase 2** (QuickJS bytecode JIT) provides V8-style acceleration of website JS itself.
It requires patching QuickJS internals, implementing a type-speculation system, and a
deoptimisation path. Estimated effort: 12–16 weeks minimum. ROI per hour: lower — only
compute-heavy SPA logic benefits; DOM, layout, and rendering are already TypeScript.
**Do Phase 1 first.**

---

## SPA Compatibility Audit

A full code audit of `dom.ts`, `jsruntime.ts`, and `index.ts` against what React 18,
Vue 3, Angular 17, and Svelte 5 actually call at runtime.

### What Already Works (no changes needed)

| API | Status | Notes |
|---|---|---|
| `Proxy` / `Reflect` / `WeakMap` / `WeakSet` | ✅ | Vue 3 reactive() works |
| `element.classList` (full API) | ✅ | add/remove/toggle/contains/replace |
| `element.style` as live Proxy | ✅ | camelCase and hyphen-case both work |
| Event bubbling + `stopPropagation` | ✅ | complete capture-less model |
| `requestAnimationFrame` / `cancelAnimationFrame` | ✅ | drained in tick() |
| `performance.now()` | ✅ | boot-relative ms |
| `crypto.randomUUID()` / `getRandomValues()` | ✅ | |
| `localStorage` / `sessionStorage` | ✅ | in-memory; VFS backing planned in 1.7 |
| `fetch()` returning real Promise | ✅ | os.fetchAsync under the hood |
| `MutationObserver` / `IntersectionObserver` / `ResizeObserver` | ⚠️ | classes exist, `observe()` is no-op |
| `queueMicrotask` | ⚠️ | exists but fires as macrotask — see 1.11.1 |
| `innerHTML` / `outerHTML` / `insertAdjacentHTML` | ✅ | |
| `document.createElement` / `createTextNode` / `createDocumentFragment` | ✅ | |
| `appendChild` / `removeChild` / `insertBefore` / `replaceChild` | ✅ | all mark `_dirty` |
| `querySelector` / `querySelectorAll` | ✅ | CSS3 selectors, compound, pseudo |
| `document.cookie` | ✅ | |
| `atob` / `btoa` | ✅ | |
| `structuredClone` | ⚠️ | JSON round-trip — loses `Date`/`Map`/`Set`/`undefined` |
| `Symbol`, `Map`, `Set`, `BigInt` | ✅ | QuickJS natives, passed through |
| `DOMParser` | ✅ | backed by `buildDOM()` |

### What Is Missing or Broken (will prevent frameworks from running)

#### Correctness Blockers

| Gap | Impact | Fix |
|---|---|---|
| `getBoundingClientRect()` — NOT on `VElement` | Floating UI, Popper.js, all dropdown/tooltip libs | Phase 1.10 |
| `offsetWidth/offsetHeight/offsetTop/offsetLeft` — NOT on `VElement` | jQuery, Bootstrap JS, many form libs | Phase 1.10 |
| `clientWidth/clientHeight/scrollHeight/scrollTop` — NOT on `VElement` | Virtual scroll, infinite list | Phase 1.10 |
| `isConnected` — NOT on `VNode` | React DOM checks this before attaching refs | Phase 1.10 |
| `node.contains(other)` — NOT on `VNode` | React uses `document.contains(target)` in event delegation | Phase 1.10 |
| `element.dataset` — NOT on `VElement` | `data-*` attribute access via `.dataset.foo` | Phase 1.10 |
| `window.innerWidth` / `window.innerHeight` — NOT in `win` | Responsive components query viewport size | Phase 1.11 |
| `document.readyState` — NOT on `VDocument` | Some frameworks check `'complete'` before init | Phase 1.11 |
| `document.activeElement` — NOT on `VDocument` | Form libraries, `focus` management | Phase 1.11 |
| `MessageChannel` / `MessagePort` — NOT in `win` | React 18 scheduler's primary yield mechanism | Phase 1.11 |
| `TextEncoder` / `TextDecoder` — NOT in `win` | Binary data, many utility libs | Phase 1.11 |
| `addEventListener` capture phase (`{ capture: true }`) — ignored | React 17+ uses capture delegation on root | Phase 1.11 |
| `MutationObserver.observe()` is a no-op | React DOM's synchronous flush signal doesn't fire | Phase 1.8 |
| `queueMicrotask` fires as macrotask (next tick) | Vue 3 `nextTick()` timing is one frame late | Phase 1.11 |

#### Performance Killers (correct but slow)

| Gap | Impact | Fix |
|---|---|---|
| `VClassList._clss()` re-parses class string on every call | O(N×C) for React reconciler toggling N class names | Phase 1.10 |
| `getElementById` is `_walk()` — O(page size) | Called in every React reconciler update cycle | Phase 1.10 |
| `nextSibling`/`previousSibling` call `indexOf` on childNodes | O(N) per traversal — React Fiber walks siblings | Phase 1.10 |
| N style mutations per frame → N `_dirty` flags | Each `el.style.color=` triggers rerender unless 1.9.1 is done | Phase 1.9 |
| `innerHTML` setter calls `_parseFragment` (full reparse) | React's `dangerouslySetInnerHTML` is a hot path | Phase 1.10 |

---

## Phase 1 — Browser Infrastructure

> Goal: Make JSOS render real-world SPAs. Every item here is pure TypeScript.

### 1.1 CSS Box Model

**Problem:** `layout.ts` uses hardcoded pixel constants (`CHAR_W=8`, `CHAR_H=8`,
`LINE_H=13`, `CONTENT_PAD=8`). There is no concept of `width: 50%`, `padding: 16px`,
`margin: auto`, `max-width`, or `display: flex`. Every element is laid out with
fixed-width character-grid arithmetic.

**Files to modify:**
- `src/os/apps/browser/constants.ts` — add viewport width / DPI abstraction
- `src/os/apps/browser/types.ts` — add `CSSBox` type (content/padding/margin/border rects)
- `src/os/apps/browser/layout.ts` — new box model pass before `layoutNodes`
- `src/os/apps/browser/dom.ts` — parse `style=` attributes into structured `CSSProperties`

**Implementation plan:**

```
Step 1: CSS property parser
  - parseInlineStyle(s: string): CSSProperties
  - parseStylesheet(css: string): Map<string, CSSProperties>
  - Properties needed: width, height, min/max-width/height, padding, margin,
    display (block/inline/flex/none), position, top, left, right, bottom,
    z-index, color, background-color, font-size, text-align, flex-direction,
    flex-wrap, align-items, justify-content, gap, overflow, border-radius

Step 2: Computed style resolver
  - resolveComputedStyle(el: VElement, parent: ComputedStyle, viewport: Rect): ComputedStyle
  - Cascade: user-agent defaults → stylesheet → inline style
  - % widths resolved against parent content box
  - margin: auto resolved at block level

Step 3: Block formatting context (BFC) pass
  - Replace current layoutNodes() with a BFC that produces Rect per element
  - Block elements: stack vertically, margin-collapse
  - Inline elements: delegate to existing flowSpans() (keep word-wrap logic)

Step 4: Flex container support
  - detectFlexChildren(el): FlexItem[]
  - distributeFlexSpace(items, container): Rect[] — flex-grow/shrink basis
  - align-items: center/flex-start/flex-end/stretch

Step 5: Stacking contexts (position: absolute/fixed + z-index)
  - Collect positioned elements into a layer list during layout pass
  - Render in z-index order in BrowserApp.draw()
  - position: fixed anchors to viewport, not scroll offset
```

**Testing:** Load a Bootstrap grid page. The 12-column `col-md-*` system uses only
`%` widths and padding. If the grid renders, the box model is working.

---

### 1.2 Canvas 2D API (`CanvasRenderingContext2D`)

**Problem:** `document.createElement('canvas')` returns a `VElement` with no drawing
surface. Real SPAs use `<canvas>` for charts (Chart.js, D3), game loops, and image
manipulation. The existing `Canvas` class in `canvas.ts` has the pixel primitives
needed — it just needs a standard W3C wrapper.

**Files to create:**
- `src/os/apps/browser/canvas2d.ts` — `Canvas2DContext` class

**Files to modify:**
- `src/os/apps/browser/jsruntime.ts` — wire `createElement('canvas')` to `Canvas2DContext`
- `src/os/apps/browser/index.ts` — composite off-screen canvas buffers into page framebuffer

**API surface to implement (in priority order):**

```typescript
// Tier 1 — needed by all charting libraries
ctx.fillStyle: string              // '#rrggbb' | 'rgba(r,g,b,a)' | 'transparent'
ctx.strokeStyle: string
ctx.lineWidth: number
ctx.font: string                   // parse size + family, map to bitmap font
ctx.textAlign: string
ctx.globalAlpha: number
ctx.fillRect(x, y, w, h)
ctx.clearRect(x, y, w, h)
ctx.strokeRect(x, y, w, h)
ctx.fillText(text, x, y)
ctx.measureText(text): { width: number }
ctx.beginPath()
ctx.closePath()
ctx.moveTo(x, y)
ctx.lineTo(x, y)
ctx.arc(x, y, r, startAngle, endAngle, ccw?)
ctx.rect(x, y, w, h)
ctx.fill()
ctx.stroke()
ctx.save()
ctx.restore()

// Tier 2 — needed by D3, more advanced charts
ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)
ctx.quadraticCurveTo(cpx, cpy, x, y)
ctx.setLineDash(segments)
ctx.createLinearGradient(x0, y0, x1, y1): CanvasGradient
ctx.createRadialGradient(x0, y0, r0, x1, y1, r1): CanvasGradient
ctx.translate(x, y)
ctx.scale(sx, sy)
ctx.rotate(angle)
ctx.transform(a, b, c, d, e, f)
ctx.setTransform(a, b, c, d, e, f)

// Tier 3 — image manipulation
ctx.getImageData(x, y, w, h): ImageData
ctx.putImageData(imageData, x, y)
ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
```

**Rasterization backend:** All draw calls write into a `Canvas` instance
(from `canvas.ts`). Line/arc/bezier rasterizers implemented in TypeScript
(Bresenham line, midpoint circle, de Casteljau subdivision). No C code needed.

**JIT integration:** Hot `fillRect` and pixel-fill loops inside `Canvas2DContext`
can use `JITCanvas` (already compiled at `jit-canvas.ts`) for the inner scan-line
loop. The `arc()` point-generation loop is a good candidate for a new JIT kernel.

**Transform stack:** Maintain a `DOMMatrix[]` stack. All draw calls pre-multiply
coordinates through the current matrix before rasterizing. Integer coordinates after
transform go directly to JIT pixel fill; fractional coordinates use the TypeScript
anti-aliasing path.

---

### 1.3 `<canvas>` Element Lifecycle in the Browser App

**Problem:** The browser compositor currently flattens all rendering into one 32-bit
BGRA buffer. Off-screen `<canvas>` elements need their own backing `Canvas` objects
that get composited into the page at draw time.

**Files to modify:**
- `src/os/apps/browser/index.ts` — maintain a `Map<VElement, Canvas>` of live canvases;
  composite them at their layout-computed `(x, y)` position each frame
- `src/os/apps/browser/jsruntime.ts` — `HTMLCanvasElement` shim:
  ```typescript
  const el = doc.createElement('canvas');
  el.width = 300;
  el.height = 150;
  const ctx = el.getContext('2d');   // returns Canvas2DContext
  ```

**Compositing order:** Static page content (text, boxes) → `<canvas>` elements in DOM
order → fixed-position overlays.

---

### 1.4 CSS Transitions and Animations

**Problem:** SPAs rely on CSS `transition` and `@keyframes animation` for feedback
(button hover, modal slide-in, spinner). Without these, UIs appear broken.

**Files to modify:**
- `src/os/apps/browser/jsruntime.ts` — hook `tick(nowMs)` to advance all active
  transitions each frame
- `src/os/apps/browser/dom.ts` — add `_transitions: Map<string, TransitionState>` to
  `VElement`
- `src/os/apps/browser/types.ts` — add `TransitionState`, `KeyframeAnimation` types

**Implementation plan:**

```typescript
interface TransitionState {
  property: string;       // 'opacity' | 'transform' | 'background-color' etc.
  from: string;           // CSS value at start
  to: string;             // CSS value at end
  duration: number;       // ms
  easing: EasingFn;       // linear | ease | ease-in | ease-out | ease-in-out | cubic-bezier
  startTime: number;      // ms timestamp
}

// tick() loop:
for (const [el, transitions] of activeTransitions) {
  for (const t of transitions) {
    const progress = easing((nowMs - t.startTime) / t.duration);
    el.style[t.property] = interpolate(t.from, t.to, progress);
  }
}
```

The `os.anim` SDK module (item 15 in `remaining.md`) provides the `lerp`/`ease*`
functions needed here — implement that first.

---

### 1.5 Variable-Width Font Rendering

**Problem:** All text rendering uses a fixed 8×8 bitmap font (`CHAR_W=8`). This makes
every page look like a 1980s terminal. Real SPAs expect proportional text with at
least a few font sizes.

**Files to modify:**
- `src/os/apps/browser/constants.ts` — replace `CHAR_W` with `measureText(ch, size)`
- `src/os/ui/canvas.ts` — `drawGlyph()` must accept a font-size parameter
- `src/os/apps/browser/layout.ts` — word-wrap must call `measureText()` per character

**Minimum viable approach (no font files needed):**
- Embed a 16×8 bitmap font for 16px body text (scale up the existing 8×8 by 2×)
- Embed a 8×4 compressed font for 12px small text
- Boldface by duplicating each column
- CSS `font-size` values map to one of: small (8px), body (13px), large (16px), xlarge (24px)

**Stretch goal:** Parse a PSF2 or BDF font file from VFS and render glyphs at any size
using the existing `drawGlyph()` infrastructure. This requires only TypeScript — load
font data from disk, build a glyph metric table, scale with nearest-neighbor for
integer sizes and bilinear for fractional.

---

### 1.6 `fetch()` and XHR Improvements

**Problem:** The `fetch()` implementation in `jsruntime.ts` is synchronous — it blocks
the QuickJS VM during network I/O. SPAs expect `fetch()` to be truly async (returns
a Promise that resolves on a future tick).

**Files to modify:**
- `src/os/apps/browser/jsruntime.ts`:
  - Change `fetch()` shim to return a real `Promise` object
  - Drive resolution through `tick()` — check `net.recvBytesNB()` each frame
  - Add `AbortController` / `AbortSignal` support
  - Add `Response.json()`, `Response.text()`, `Response.blob()`
  - Support `Content-Type: application/json` auto-parse

**Rationale:** Most React/Vue apps do `useEffect(() => { fetch(...).then(...) }, [])`.
If `fetch()` blocks, the component never re-renders.

---

### 1.7 `localStorage` and `sessionStorage`

**Problem:** Many SPAs persist state to `localStorage`. Currently undefined.

**Implementation:**
- `localStorage` → backed by `/home/browser_storage.json` on the VFS
  (read on `createPageJS()`, write on `setItem()`)
- `sessionStorage` → in-memory `Map`, cleared when page navigates away
- Quota: 5MB (VFS limit)
- Both implement the Web Storage API: `getItem`, `setItem`, `removeItem`, `clear`, `key`, `length`

---

### 1.8 `MutationObserver` and `requestAnimationFrame`

**`requestAnimationFrame`** is already implemented — callbacks are queued and drained
in `tick()`. No changes needed.

**`MutationObserver` is currently a stub** — `observe()` does nothing. This breaks:
- React DOM's `scheduleMicrotask` fallback (some builds post a MutationObserver
  record as a zero-cost microtask signal)
- Libraries that use MO to detect when elements enter/leave the DOM

**Fix:** Make `observe()` actually register, and fire recorded mutations each `tick()`.

**Files to modify:** `src/os/apps/browser/jsruntime.ts`

```typescript
// Real MutationObserver backed by VDocument dirty tracking
class MutationObserver {
  private _fn: (records: MutationRecord[]) => void;
  private _targets: Map<VNode, MutationObserverInit> = new Map();
  private _pending: MutationRecord[] = [];

  constructor(fn: (records: MutationRecord[]) => void) { this._fn = fn; }

  observe(node: VNode, opts: MutationObserverInit = {}): void {
    this._targets.set(node, opts);
    // Register with the per-document observer registry
    doc._observers.push(this);
  }
  disconnect(): void {
    doc._observers = doc._observers.filter(o => o !== this);
    this._targets.clear();
  }
  takeRecords(): MutationRecord[] { var r = this._pending; this._pending = []; return r; }

  // Called by VElement mutation methods (appendChild, setAttribute, etc.)
  _notify(record: MutationRecord): void {
    if (this._targets.has(record.target as VNode) || this._targets.has(record.target.parentNode as VNode)) {
      this._pending.push(record);
    }
  }

  // Called once per tick() after DOM mutations accumulate
  _flush(): void {
    if (this._pending.length) {
      var r = this._pending.splice(0);
      try { this._fn(r); } catch(_) {}
    }
  }
}
```

**`VDocument` change:** Add `_observers: MutationObserver[]` array. Mutating methods
(`appendChild`, `setAttribute`, `textContent=`, etc.) push a `MutationRecord` to
each registered observer. `tick()` calls `_flushObservers()` before firing RAF.

**Simplification:** Only `childList` and `attributes`/`characterData` subtypes are
needed. `subtree: true` is handled by checking if the target is a descendant of any
observed node. Full W3C spec compliance is not needed — just enough for React DOM
and Vue 3 to receive their expected notifications.

---

### Phase 1 Priority Order

| # | Item | Blocks | Effort |
|---|---|---|---|
| **1.9.1** | **Batch mutations to RAF** | **All JS-driven SPAs — do first** | **XS** |
| **1.9.2** | **Eliminate serialize/reparse** | **All JS-driven SPAs** | **S** |
| **1.10.2** | **Linked-list siblings + ID index** | **React Fiber O(N²) → O(N)** | **S** |
| **1.10.3** | **VClassList caching** | **Class-toggling in reconciler** | **XS** |
| **1.10.4** | **isConnected / contains / dataset** | **React DOM refs, event delegation** | **XS** |
| **1.11.1** | **queueMicrotask correct ordering** | **Vue 3 nextTick, React 18 scheduler** | **S** |
| **1.11.2** | **MessageChannel** | **React 18 concurrent mode** | **XS** |
| **1.11.3** | **window.innerWidth/Height** | **Responsive components** | **XS** |
| **1.11.4** | **document.readyState / activeElement** | **Framework init guards** | **XS** |
| **1.11.6** | **addEventListener capture phase** | **React 17+ event delegation** | **S** |
| 1.8 | MutationObserver (functional) | React DOM flush signal | S |
| 1.6 | Async fetch / Promise | React hooks, data-driven SPAs | S |
| 1.7 | localStorage | Auth flows, settings persistence | XS |
| **1.10.1** | **getBoundingClientRect** | **Dropdowns, tooltips, focus** | **S** |
| **1.11.5** | **TextEncoder / TextDecoder** | **Binary data libs** | **S** |
| **1.11.7** | **structuredClone proper** | **State management libs** | **S** |
| **1.9.5** | **JIT image blit** | **Image-heavy pages** | **S** |
| 1.1 | CSS box model (%, flex) | Bootstrap, Tailwind grid layouts | L |
| 1.2 | Canvas 2D API | Chart.js, D3, game engines | L |
| 1.3 | `<canvas>` compositing | Canvas-heavy SPAs | M |
| 1.4 | CSS transitions | Any polished UI | M |
| 1.5 | Proportional font | Readable body text | M |
| **1.9.7** | **Scroll blit** | **All pages** | **S** |
| **1.9.3** | **Incremental layout** | **SPAs with partial updates** | **M** |
| **1.9.4** | **Damage rectangles** | **All JS-animated pages** | **M** |
| **1.9.6** | **JIT line rasterizer** | **Text-heavy pages** | **L** |

---

### 1.9 JIT-Accelerated Rendering Pipeline

> Every time page JS mutates the DOM, the current pipeline pays the full cost:
> `serializeDOM()` → `parseHTML()` → `layoutNodes()` → clear viewport → redraw every
> visible span. For a 60 fps animation loop this happens 60 times per second.
> This section targets the rendering work that **page JS drives**, not page JS itself.

#### 1.9.0 The Current Pipeline (problem statement)

```
 Page JS mutation (e.g. element.textContent = 'foo')
        │
        ▼
   doc._dirty = true
        │
  checkDirty() in execScript() / tick()
        │
        ▼
   doRerender()
        │
   serializeDOM(doc)          ← serialise entire VDocument to HTML string
        │
        ▼
   cb.rerender(bodyHTML)       ← cross into BrowserApp
        │
        ▼
   parseHTML(bodyHTML)         ← full HTML tokenise + parse
        │
        ▼
   layoutNodes(nodes, ...)     ← full block/inline layout of ALL nodes
        │
        ▼
   this._dirty = true
        │
        ▼  (next render() call)
   canvas.fillRect(0, y0, w, ch, CLR_BG)   ← clear entire content area
        │
        ▼
   for each visible RenderedLine            ← iterate every visible span
     canvas.fillRect(...)                   ← per-line backgrounds
     canvas.drawText(span.x, y, text, clr) ← one call per span
```

**Every mutation is O(page size) regardless of what changed.**

---

#### 1.9.1 Batch Mutations to RAF — Stop Immediate `doRerender()`

**Problem:** `doRerender()` is called synchronously inside `execScript()` after every
mutation. A React-style reconciler batching 50 property writes triggers 50 full
re-parses per frame.

**Fix:** Defer `doRerender()` to the end of the `tick()` RAF drain, not inside
`execScript()`. Mutations accumulate into `doc._dirty`; a single rerender fires once
per frame at most.

**Files to modify:** `src/os/apps/browser/jsruntime.ts`

```typescript
// BEFORE — called inside execScript() after every mutation:
function checkDirty(): void { if (doc._dirty) { doc._dirty = false; needsRerender = true; } }
function execScript(code: string): void {
  /* ... run code ... */
  checkDirty();
  // doRerender() may fire here — too early, too often
}

// AFTER — mutations accumulate; one rerender per tick() call at most:
function execScript(code: string): void {
  /* ... run code ... */
  // just set the flag; do not call doRerender()
  if (doc._dirty) needsRerender = true;
  doc._dirty = false;
}

// In tick():
tick(nowMs: number): void {
  // drain RAF + timers as before
  // then ONE rerender at the end:
  if (needsRerender) doRerender();
}
```

**Impact:** SPA frameworks that batch updates (React, Vue, Solid) go from N rerenders
per frame to exactly 1. This is the highest-ROI fix in the entire plan — zero new
infrastructure required, ~20 lines changed.

**`flushSync` caveat:** React provides `ReactDOM.flushSync(fn)` for synchronous
flushing. `flushSync` must trigger an immediate rerender, bypassing the deferred
batch. Implement by adding a `forceRerender()` path to `PageCallbacks` that
BrowserApp calls synchronously. `flushSync` in `jsruntime.ts` calls
`forceRerender()` then resets `needsRerender = false`.

---

#### 1.9.2 Eliminate the Serialize → Reparse Round-Trip

**Problem:** `doRerender()` calls `serializeDOM(doc)` to produce an HTML string, then
`cb.rerender(bodyHTML)` calls `parseHTML(bodyHTML)` to rebuild the node tree. This
throws away the live VDocument and rebuilds it from scratch.

**Fix:** Pass the `VDocument` itself through the rerender callback instead of going
through an HTML string. `BrowserApp` takes the document directly and calls
`layoutNodes()` on it.

**Files to modify:**
- `src/os/apps/browser/jsruntime.ts` — change `PageCallbacks.rerender` signature
- `src/os/apps/browser/index.ts` — update `_rerender` handler to accept `VDocument`
- `src/os/apps/browser/html.ts` — no change needed
- `src/os/apps/browser/dom.ts` — no change needed

```typescript
// In PageCallbacks:
rerender(doc: VDocument): void;   // was: rerender(bodyHTML: string): void

// In doRerender():
function doRerender(): void {
  needsRerender = false;
  if (doc.title) cb.setTitle(doc.title);
  cb.rerender(doc);               // pass the live VDocument — no serialization
}

// In BrowserApp._rerender:
private _rerender(doc: VDocument): void {
  var bps: WidgetBlueprint[] = [];
  this._pageLines = layoutNodes(doc.body.children, bps, ...);
  // bps → widgets; no parseHTML() call
  this._dirty = true;
}
```

**Impact:** Eliminates `serializeDOM()` + `parseHTML()` entirely from the hot rerender
path. For a 500-node page this saves ~2–5ms per frame on bare metal.

---

#### 1.9.3 Incremental Layout — Dirty Subtree Tracking

**Problem:** `layoutNodes()` recomputes every block from scratch on every rerender.
If a JS mutation only changes `el.textContent` on one `<p>`, all sibling blocks
still get relaid-out.

**Files to modify:**
- `src/os/apps/browser/dom.ts` — add `_layoutDirty: boolean` flag to `VElement`
- `src/os/apps/browser/layout.ts` — check flag; skip clean subtrees, return cached
  `RenderedLine[]` slices
- `src/os/apps/browser/jsruntime.ts` — mark the mutated element dirty (not the whole doc)

**Implementation plan:**
```typescript
// In VElement:
_layoutDirty = true;  // set by any property/children mutation
_cachedLines: RenderedLine[] | null = null;
_cachedHeight: number = 0;

// In layoutNodes() inner loop — per block element:
if (!node._layoutDirty && node._cachedLines) {
  // emit cached lines at new y-offset (adjust .y fields)
  y += node._cachedHeight;
  lines.push(...node._cachedLines);
  continue;
}
// else: layout normally, cache result, clear dirty flag
node._layoutDirty = false;
node._cachedLines  = computedLines;
node._cachedHeight = computedHeight;
```

**Constraint:** Sibling-dependent layout (float, negative margins, flex) must
conservatively invalidate the whole flex container when any child changes. Block
flow (the common case) is safe to cache per-element.

**Impact:** For a React SPA that updates a single counter element, layout cost drops
from O(all nodes) to O(1 element + ancestors).

---

#### 1.9.4 Damage Rectangle System — Partial Redraws

**Problem:** `render()` calls `canvas.fillRect(0, y0, w, ch, CLR_BG)` (clears the
entire content area) then redraws every visible line. If only one element changed
its text color, the whole screen is repainted.

**Files to modify:**
- `src/os/apps/browser/index.ts` — `_drawContent()` accepts an optional clip rect;
  only redraws lines whose `y` range intersects the damage rect
- `src/os/apps/browser/dom.ts` — `VElement` stores its last rendered `Rect`
  (set by layoutNodes); mutation clears it to trigger damage
- `src/os/ui/canvas.ts` — add `setClip(x, y, w, h)` / `clearClip()` — clip all
  subsequent draw calls to the rect (software scissor test in TypeScript)

```typescript
// DamageTracker in BrowserApp:
private _damageRect: Rect | null = null;

private _markDamage(el: VElement): void {
  var r = el._renderedRect;
  if (!r) { this._damageRect = null; return; }  // full repaint
  this._damageRect = this._damageRect
    ? unionRect(this._damageRect, r)
    : r;
}

// In _drawContent():
if (this._damageRect) {
  canvas.setClip(this._damageRect);
  canvas.fillRect(this._damageRect.x, ...);
  // only iterate lines overlapping damageRect
} else {
  // full repaint (scroll, resize, first paint)
}
```

**Impact:** UI updates that touch a small region (button state, text input cursor,
counter value) repaint only that rectangle. Reduces GPU→CPU→GPU blit cost per frame.

---

#### 1.9.5 JIT Image Blitting

**Problem:** `_drawImage()` in `index.ts` renders decoded images with a double
`for (row) for (col) canvas.setPixel(...)` loop. `setPixel()` is a bounds-checked
TypeScript call with `Uint32Array` indexing. For a 200×200 image this is 40,000
individual TypeScript function calls per frame it is on screen.

**Fix:** Replace with `JITCanvas.blitRow()` (already compiled at `jit-canvas.ts`).
`blitRow` takes physical addresses for source and destination rows and copies
`width` pixels in a single JIT-compiled inner loop — no TypeScript overhead.

**Files to modify:** `src/os/apps/browser/index.ts` — `_drawImage()` method

```typescript
// BEFORE:
if (wp.imgData) {
  for (var row = 0; row < wp.ph; row++)
    for (var col = 0; col < wp.pw; col++)
      canvas.setPixel(wp.px + col, wy + row, wp.imgData[row * wp.pw + col]);
}

// AFTER:
if (wp.imgData) {
  if (!wp._imgPhysAddr) wp._imgPhysAddr = JITCanvas.physAddr(wp.imgData.buffer);
  for (var row = 0; row < wp.ph; row++) {
    var srcOff = row * wp.pw;           // in uint32 units
    var dstOff = (wy + row) * canvas.width + wp.px;
    JITCanvas.blitRow(
      canvas.bufPhysAddr(), dstOff,
      wp._imgPhysAddr,      srcOff,
      wp.pw
    );
  }
}
```

**DecodedImage type change:** add `_imgPhysAddr?: number` to `PositionedWidget` in
`types.ts` to cache the physical pointer (computed once after image decode).

**Impact:** 40,000 TS calls → 200 JIT inner loops. Image rendering goes from the
single biggest per-frame cost to effectively free.

---

#### 1.9.6 JIT Line Rasterizer — Batch Span Rendering

**Problem:** The inner draw loop in `_drawContent()` calls `canvas.drawText()` once
per `RenderedSpan`. Each `drawText()` call iterates over every character in the span,
calling `drawGlyph()` per character. For a page with 80 visible lines of 5 spans
each, that is 400 TypeScript call frames per repaint just for span dispatch.

**Fix:** New JIT kernel `_SRC_DRAW_SPANS` that takes a packed descriptor array and
rasterizes an entire line of spans in one native call.

**New file additions in `jit-canvas.ts`:**
```typescript
// Packed span descriptor (7 int32 fields per span):
//   [x, y, color, glyphBufPtr, glyphBufStride, charStart, charCount]
const _SRC_DRAW_SPANS = `
function drawSpans(descPtr, nSpans, dstPtr, dstStride, fontPtr, fontStride) {
  var i = 0;
  while (i < nSpans) {
    var x      = mem[descPtr + i*7 + 0];
    var y      = mem[descPtr + i*7 + 1];
    var color  = mem[descPtr + i*7 + 2];
    var chars  = mem[descPtr + i*7 + 3];
    var nChars = mem[descPtr + i*7 + 4];
    var j = 0;
    while (j < nChars) {
      var glyph = mem[fontPtr + mem[chars + j] * fontStride];
      // 8-pixel wide glyph blit into dstPtr at (x+j*8, y)
      var row = 0;
      while (row < 8) {
        mem[dstPtr + (y+row)*dstStride + x + j*8] = (glyph >> row) & 1 ? color : 0;
        row = row + 1;
      }
      j = j + 1;
    }
    i = i + 1;
  }
}
`;
```

**Note:** The full glyph rasterizer inside the JIT is complex. A simpler first pass
is to JIT only the **background fill** phase (line `fillRect` calls for `codeBg`,
`quoteBg`, `preBg`) and keep `drawText()` in TypeScript. This cuts per-line JIT
fn calls from ~5 to ~1 for background-heavy pages.

**Files to modify:**
- `src/os/process/jit-canvas.ts` — add `_SRC_DRAW_LINE_BG` and `JITCanvas.drawLineBg()`
- `src/os/apps/browser/index.ts` — `_drawContent()` calls `JITCanvas.drawLineBg()`
  for the background rect phase, keeps `drawText()` for text

---

#### 1.9.7 Scrolling: Blit Instead of Redraw

**Problem:** When the user scrolls, `_scrollY` changes and `_dirty = true`. The
entire content area is cleared and redrawn. But scrolling is pure translation — the
pixels already exist in the framebuffer, just shifted vertically.

**Fix:** Detect that the only change is `_scrollY`. Instead of clearing the viewport,
use `JITCanvas.blitRow()` to copy the overlap region up or down by `dy` pixels, then
only repaint the newly exposed strip at the top or bottom.

**Files to modify:** `src/os/apps/browser/index.ts`

```typescript
private _prevScrollY = 0;

private _drawContent(canvas: Canvas): void {
  var dy = this._scrollY - this._prevScrollY;
  this._prevScrollY = this._scrollY;

  if (Math.abs(dy) < this._contentH() && !this._fullRepaint) {
    // Blit the overlap: shift existing pixels dy rows
    var overlap = this._contentH() - Math.abs(dy);
    var physAddr = canvas.bufPhysAddr();
    if (dy > 0) {
      // scrolling down — copy rows [dy..contentH] to [0..contentH-dy]
      for (var r = 0; r < overlap; r++)
        JITCanvas.blitRow(physAddr, (TOOLBAR_H + r) * canvas.width,
                          physAddr, (TOOLBAR_H + r + dy) * canvas.width,
                          canvas.width);
    } else {
      // scrolling up — copy rows [0..contentH+dy] to [-dy..contentH]
      for (var r = overlap - 1; r >= 0; r--)
        JITCanvas.blitRow(physAddr, (TOOLBAR_H + r - dy) * canvas.width,
                          physAddr, (TOOLBAR_H + r) * canvas.width,
                          canvas.width);
    }
    // only paint the newly exposed strip
    this._drawStrip(canvas, dy > 0 ? this._scrollY + overlap : this._scrollY, Math.abs(dy));
    return;
  }
  // full repaint (first draw, resize, or large jump)
  this._fullRepaintContent(canvas);
}
```

**Impact:** Mouse-wheel scrolling becomes a `memcpy`-equivalent of ~20 row blits
(exposed strip) instead of a full redraw of every visible line. This is the
standard technique used by all production browser compositors (macOS CALayer,
Chrome's compositor thread).

---

#### Phase 1.9 Priority Order

| # | Item | Effort | Impact |
|---|---|---|---|
| 1.9.1 | Batch mutations to RAF | XS (1 day) | Eliminates N rerenders/frame → 1 |
| 1.9.2 | Eliminate serialize/reparse | S (2 days) | Saves 2–5ms per rerender |
| 1.9.5 | JIT image blit | S (2 days) | 40k TS calls → 200 JIT loops |
| 1.9.7 | Scroll blit | S (3 days) | Scrolling becomes near-free |
| 1.9.3 | Incremental layout | M (1 week) | Layout cost → O(changed nodes) |
| 1.9.4 | Damage rectangles | M (1 week) | Partial redraws |
| 1.9.6 | JIT line rasterizer | L (2 weeks) | Batch text rendering |

Do 1.9.1 and 1.9.2 first — together they take 3 days and deliver the majority of
the frame-rate improvement for JS-driven SPAs. The rest are additive optimisations.

---

### 1.10 DOM Performance Internals

> These are correctness and performance fixes inside `dom.ts` and `jsruntime.ts` that
> do not require any new browser feature — they make the existing DOM implementation
> fast enough and correct enough for frameworks to run against.

#### 1.10.1 `getBoundingClientRect()` and Layout Geometry APIs

**Problem:** `getBoundingClientRect()` does not exist on `VElement`. This is the
number-one cause of broken SPA components:
- **Floating UI** (used by Radix UI, Headless UI, shadcn/ui) — needs real element coords
  for dropdown/tooltip placement
- **Popper.js** — same
- **React's focus management** (`element.getBoundingClientRect()` before `focus()`)
- **Intersection detection**, virtual scroll, sticky headers

**Dependency:** Requires Phase 1.1 (CSS box model) to give every `VElement` a real
layout rect. Until then, returns zeros — at least without crashing.

**Files to modify:** `src/os/apps/browser/dom.ts`, `src/os/apps/browser/layout.ts`

```typescript
// Added to VElement after Phase 1.1:
_renderedRect: { x: number; y: number; w: number; h: number } | null = null;

getBoundingClientRect(): DOMRect {
  var r = this._renderedRect;
  if (!r) return { x:0, y:0, width:0, height:0, top:0, left:0, right:0, bottom:0 };
  // Adjust for scroll position (from BrowserApp via a shared ref)
  var scrollY = this.ownerDocument?._scrollY ?? 0;
  var top  = r.y - scrollY + TOOLBAR_H;
  return { x: r.x, y: top, width: r.w, height: r.h,
           top, left: r.x, right: r.x + r.w, bottom: top + r.h,
           toJSON() { return this; } };
}

// Geometry shorthands — all derived from _renderedRect:
get offsetWidth():  number { return this._renderedRect?.w ?? 0; }
get offsetHeight(): number { return this._renderedRect?.h ?? 0; }
get offsetTop():    number { return this._renderedRect?.y ?? 0; }
get offsetLeft():   number { return this._renderedRect?.x ?? 0; }
get clientWidth():  number { return this._renderedRect?.w ?? 0; }
get clientHeight(): number { return this._renderedRect?.h ?? 0; }
get scrollHeight(): number { return this._renderedRect?.h ?? 0; }  // stub until overflow layout
get scrollWidth():  number { return this._renderedRect?.w ?? 0; }
```

**`layout.ts` change:** After computing each block's pixel rect, write it back:
```typescript
nodeEl._renderedRect = { x: blockX, y: absoluteY, w: blockW, h: blockH };
```

**Phase 1.1 dependency note:** Before 1.1, all rects are zero. After 1.1, rects are
real. The API exists in both phases — it just returns zeros before layout is real.

---

#### 1.10.2 Fast DOM Lookups (ID index + sibling linking)

**Problem:** `getElementById()` calls `_walk()` — O(entire DOM). React's reconciler
calls `getElementById` (via refs) on every reconcile cycle. On a 500-node page this
is O(500) per reconcile pass.

`nextSibling`/`previousSibling` call `Array.indexOf(child)` on the parent's
`childNodes` — O(N) per traversal. React Fiber's sibling-chain walk is O(N²).

**Files to modify:** `src/os/apps/browser/dom.ts`

**Fix 1 — ID index:**
```typescript
// In VDocument:
_idIndex: Map<string, VElement> = new Map();

// In VElement.setAttribute():
if (name === 'id') {
  if (this.ownerDocument) {
    if (oldId) this.ownerDocument._idIndex.delete(oldId);
    if (value) this.ownerDocument._idIndex.set(value, this);
  }
}

// getElementById becomes O(1):
getElementById(id: string): VElement | null {
  return this._idIndex.get(id) ?? null;
}
```

**Fix 2 — Linked-list siblings:**
Replace `childNodes.indexOf(this)` in `nextSibling`/`previousSibling` with
direct `_next`/`_prev` pointers maintained by `appendChild`/`insertBefore`/
`removeChild`. O(1) sibling traversal.

```typescript
class VNode {
  _next: VNode | null = null;  // nextSibling
  _prev: VNode | null = null;  // previousSibling

  get nextSibling():     VNode | null { return this._next; }
  get previousSibling(): VNode | null { return this._prev; }
}

// appendChild updates:
child._prev = this.lastChild;
if (this.lastChild) (this.lastChild as any)._next = child;
child._next = null;
```

**Impact:** React Fiber sibling traversal goes from O(N²) to O(N). `getElementById`
goes from O(page size) to O(1). Critical for large component trees.

---

#### 1.10.3 `VClassList` Caching

**Problem:** `VClassList._clss()` calls `this._owner.getAttribute('class')` and
`split(/\s+/)` on every `add/remove/toggle/contains` call. React's class reconciler
calls `classList.contains()` + `classList.add()` + `classList.remove()` in a tight
loop over the class diff.

**Fix:** Cache the `Set<string>` on the `VClassList` instance, invalidated only when
`setAttribute('class', ...)` is called:
```typescript
class VClassList {
  _cache: Set<string> | null = null;

  _clssSet(): Set<string> {
    if (!this._cache) {
      this._cache = new Set(
        (this._owner.getAttribute('class') || '').split(/\s+/).filter(Boolean)
      );
    }
    return this._cache;
  }
  _invalidate(): void { this._cache = null; }  // called by setAttribute('class')

  contains(c: string): boolean { return this._clssSet().has(c); }
  add(...cs: string[]): void {
    var s = this._clssSet();
    var changed = false;
    for (var c of cs) { if (!s.has(c)) { s.add(c); changed = true; } }
    if (changed) this._sync();
  }
  // ... remove, toggle: update Set directly, then _sync()
  _sync(): void {
    this._owner._attrs.set('class', [...this._clssSet()].join(' '));
    if (this._owner.ownerDocument) this._owner.ownerDocument._dirty = true;
  }
}
```

**Impact:** Class toggling becomes O(1) per operation instead of O(class string length).
For a React component that diffs 10 classes on 50 nodes per render, this is ~500 string
parse+split calls saved per frame.

---

#### 1.10.4 `isConnected`, `contains()`, `dataset`

Small but critical properties that frameworks check before operating on nodes:

**`isConnected`** (React DOM uses this before attaching fiber refs):
```typescript
get isConnected(): boolean {
  var n: VNode | null = this;
  while (n) { if (n === this.ownerDocument) return true; n = n.parentNode; }
  return false;
}
```

**`contains(other)`** (React event delegation: `document.contains(event.target)`):
```typescript
contains(other: VNode | null): boolean {
  var n: VNode | null = other;
  while (n) { if (n === this) return true; n = n.parentNode; }
  return false;
}
```

**`element.dataset`** (Svelte and some Vue libs use `data-*` for component metadata):
```typescript
get dataset(): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get: (_, k: string) => this.getAttribute('data-' + _camelToDash(String(k))) ?? undefined,
    set: (_, k: string, v: string) => { this.setAttribute('data-' + _camelToDash(String(k)), v); return true; },
    has: (_, k: string) => this.hasAttribute('data-' + _camelToDash(String(k))),
  });
}
function _camelToDash(s: string) { return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase()); }
```

**`element.offsetParent`** (used by some layout measurement utilities):
```typescript
get offsetParent(): VElement | null {
  var n = this.parentNode;
  while (n) { if (n instanceof VElement) return n; n = n.parentNode; }
  return null;
}
```

---

#### Phase 1.10 Effort: 1 week

All items are pure `dom.ts` / `layout.ts` changes. No C. No new architecture.
Do 1.10.2 (linked-list siblings + ID index) first — it is the single biggest
correctness+performance item with zero user-visible API surface change.

---

### 1.11 Missing Browser Runtime APIs

> These are entries in the `win` global object in `jsruntime.ts` that modern SPA
> frameworks depend on but are currently absent or broken.

#### 1.11.1 `queueMicrotask` — Correct Microtask Ordering

**Problem:** `queueMicrotask` is currently `(fn) => setTimeout_(fn, 0)`. This makes
it a **macrotask** — it fires on the NEXT `tick()` call (~16ms later). The spec
requires microtasks to drain **before** returning to the event loop, i.e., before the
next macro task.

**Impact on frameworks:**
- **Vue 3 `nextTick()`**: implemented as `Promise.resolve().then(fn)`. QuickJS
  drains its own Promise job queue natively between top-level calls, so Vue's
  `nextTick` actually works correctly **if** `JS_ExecutePendingJob` is called
  after each timer/RAF callback in `tick()`. Verify this is done in
  `quickjs_binding.c`.
- **React 18 scheduler**: uses `queueMicrotask` directly for its `scheduleCallback`
  microtask lane. If this fires 16ms late, concurrent mode is degraded.
- **`Promise.then()` chains**: QuickJS handles these natively and they drain
  automatically — this is correct already.

**Fix:** Maintain a separate `microtaskQueue: Array<() => void>` that drains
**synchronously** at the end of each `execScript()`, timer callback, and RAF
callback — not on the next tick:

```typescript
var microtaskQueue: Array<() => void> = [];

function queueMicrotask_(fn: () => void): void { microtaskQueue.push(fn); }

function drainMicrotasks(): void {
  // drain in a loop in case microtasks enqueue more microtasks
  while (microtaskQueue.length) {
    var q = microtaskQueue.splice(0);
    for (var fn of q) { try { fn(); } catch(_) {} }
  }
}

// Called after each execScript(), timer fn(), and rAF callback:
function execScript(code: string): void {
  /* ... */
  drainMicrotasks();
}
```

**Note:** Native QuickJS `Promise.then()` microtasks are drained by the QuickJS
runtime itself (via `JS_ExecutePendingJob`) — they don't go through this queue.
This queue is only for the JS-land `queueMicrotask(fn)` calls.

---

#### 1.11.2 `MessageChannel` / `MessagePort`

**Problem:** React 18's scheduler (`scheduler.development.js`) uses `MessageChannel`
as its primary yield mechanism:
```js
const channel = new MessageChannel();
const port = channel.port2;
channel.port1.onmessage = performWorkUntilDeadline;
schedulePerformWorkUntilDeadline = () => { port.postMessage(null); };
```
Without `MessageChannel`, React 18 falls back to `setTimeout(fn, 0)` which is
functional but fire on the next tick (same as the current behavior).

**Fix:** Implement `MessageChannel` as two connected ports:
```typescript
class MessagePort {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  _partner: MessagePort | null = null;
  postMessage(data: unknown): void {
    var partner = this._partner;
    if (partner?.onmessage) {
      // Enqueue as a macrotask (fires on next tick — equivalent to setTimeout 0)
      setTimeout_(() => { try { partner!.onmessage!({ data }); } catch(_) {} }, 0);
    }
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
    if (type === 'message') this.onmessage = fn;
  }
  start(): void {}
  close(): void { this._partner = null; }
}

class MessageChannel {
  port1: MessagePort;
  port2: MessagePort;
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._partner = this.port2;
    this.port2._partner = this.port1;
  }
}
```

Add `MessageChannel` and `MessagePort` to the `win` object.

---

#### 1.11.3 `window.innerWidth` / `innerHeight` / `devicePixelRatio`

Every responsive SPA queries `window.innerWidth` to adapt layout. Currently absent
from `win`. Fix: add to `win` with dynamic access to the WMWindow size:

```typescript
// In win object:
get innerWidth():  number { return cb.getViewportWidth();  },
get innerHeight(): number { return cb.getViewportHeight(); },
get outerWidth():  number { return cb.getViewportWidth();  },
get outerHeight(): number { return cb.getViewportHeight(); },
devicePixelRatio: 1,
```

Add `getViewportWidth()/getViewportHeight()` to `PageCallbacks` — BrowserApp
returns `this._win?.width ?? 800` and `this._contentH()`.

---

#### 1.11.4 `document.readyState`, `document.activeElement`

```typescript
// In VDocument:
_readyState: 'loading' | 'interactive' | 'complete' = 'loading';
get readyState(): string { return this._readyState; }

_activeElement: VElement | null = null;
get activeElement(): VElement | null { return this._activeElement ?? this.body; }
```

Set `doc._readyState = 'interactive'` after DOM parsing, `'complete'` after all
scripts run and `DOMContentLoaded` fires. Many frameworks gate initialization
behind `document.readyState === 'complete'`.

---

#### 1.11.5 `TextEncoder` / `TextDecoder`

Used by binary data processing, WASM interop, and many utility libraries. Pure JS
implementation is fine for UTF-8:

```typescript
class TextEncoder {
  readonly encoding = 'utf-8';
  encode(s: string): Uint8Array {
    var bytes: number[] = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0|(c>>6)); bytes.push(0x80|(c&63)); }
      else { bytes.push(0xE0|(c>>12)); bytes.push(0x80|((c>>6)&63)); bytes.push(0x80|(c&63)); }
    }
    return new Uint8Array(bytes);
  }
}

class TextDecoder {
  readonly encoding: string;
  constructor(enc = 'utf-8') { this.encoding = enc; }
  decode(buf: Uint8Array): string {
    var s = ''; var i = 0;
    while (i < buf.length) {
      var b = buf[i++];
      if (b < 0x80) s += String.fromCharCode(b);
      else if ((b & 0xE0) === 0xC0) { s += String.fromCharCode(((b&31)<<6)|(buf[i++]&63)); }
      else { s += String.fromCharCode(((b&15)<<12)|((buf[i++]&63)<<6)|(buf[i++]&63)); }
    }
    return s;
  }
}
```

---

#### 1.11.6 `addEventListener` Capture Phase

React 17+ attaches all events to the root container in **capture** phase
(`el.addEventListener(type, fn, { capture: true })`). The current `VNode.addEventListener`
ignores the third argument — all listeners are treated as bubble-phase.

**Fix:** Add a separate `_captureHandlers` map to `VNode` and update `dispatchEvent`
to first walk DOWN the ancestor chain (capture), then walk UP (bubble):

```typescript
class VNode {
  _handlers: Map<string, Array<...>> = new Map();         // bubble
  _captureHandlers: Map<string, Array<...>> = new Map();  // capture

  addEventListener(type: string, fn: Fn, opts?: boolean | { capture?: boolean }): void {
    var capture = opts === true || (opts as any)?.capture === true;
    var map = capture ? this._captureHandlers : this._handlers;
    // ... same as before
  }

  dispatchEvent(ev: VEvent): boolean {
    ev.target = this;
    // 1. Collect ancestor chain (excluding target)
    var path: VNode[] = [];
    var n: VNode | null = this.parentNode;
    while (n) { path.push(n); n = n.parentNode; }
    // 2. Capture phase: fire _captureHandlers top-down
    for (var i = path.length - 1; i >= 0 && !ev._stopProp; i--) {
      ev.currentTarget = path[i]; path[i]._fireCaptureList(ev);
    }
    // 3. Target phase
    if (!ev._stopProp) this._fireList(ev);
    // 4. Bubble phase
    if (ev.bubbles) {
      for (var j = 0; j < path.length && !ev._stopProp; j++) {
        ev.currentTarget = path[j]; path[j]._fireList(ev);
      }
    }
    return !ev.defaultPrevented;
  }
}
```

**Impact:** React 17+ event delegation (which uses capture on the root) fires
correctly instead of being silently ignored.

---

#### 1.11.7 `structuredClone` — Proper Implementation

The current `JSON.parse(JSON.stringify(v))` implementation silently corrupts
state that contains `Date`, `Map`, `Set`, `undefined`, `ArrayBuffer`, or circular
references. Zustand, Redux Toolkit, and Pinia all use `structuredClone` for
state snapshots.

**Fix:** Implement a proper recursive clone in TypeScript:
```typescript
function structuredClone_(v: unknown, seen = new Map()): unknown {
  if (v === null || typeof v !== 'object' && typeof v !== 'function') return v;
  if (seen.has(v)) return seen.get(v);
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (v instanceof Map) {
    var m = new Map(); seen.set(v, m);
    v.forEach((val, k) => m.set(structuredClone_(k, seen), structuredClone_(val, seen)));
    return m;
  }
  if (v instanceof Set) {
    var s = new Set(); seen.set(v, s);
    v.forEach(val => s.add(structuredClone_(val, seen))); return s;
  }
  if (v instanceof ArrayBuffer) { var ab = v.slice(0); seen.set(v, ab); return ab; }
  if (ArrayBuffer.isView(v)) { var tv = (v as any).constructor.from(v); seen.set(v, tv); return tv; }
  if (Array.isArray(v)) {
    var a: unknown[] = []; seen.set(v, a);
    for (var i = 0; i < v.length; i++) a.push(structuredClone_(v[i], seen)); return a;
  }
  var o: Record<string, unknown> = {}; seen.set(v, o);
  for (var k2 in v as any) { if (Object.prototype.hasOwnProperty.call(v, k2)) o[k2] = structuredClone_((v as any)[k2], seen); }
  return o;
}
```

---

#### Phase 1.11 Effort: 1 week

All items are additions to `jsruntime.ts` and `dom.ts`. No C. The biggest-impact
fixes are 1.11.1 (`queueMicrotask`) and 1.11.2 (`MessageChannel`) since they
unblock React 18 concurrent features and Vue 3 batching.

---

## Phase 2 — QuickJS Bytecode → x86 JIT

> Goal: Accelerate website JS itself (not just rendering). V8-style tiered compilation
> inside JSOS without replacing QuickJS.

### 2.0 Architecture Overview

```
Page JS source code
       │
       ▼
  QuickJS compiler
       │  (already happens today)
       ▼
 QuickJS bytecode (JSFunctionBytecode)
       │
       ├─── Cold path: QuickJS interpreter (unchanged, always works)
       │
       └─── Hot path (NEW — Phase 2):
                  │
                  ▼
           Hotness counter
          (per bytecode function)
                  │
         exceeds threshold?
                  │
                  ▼
         QJS Bytecode Reader
        (reads JSFunctionBytecode)
                  │
                  ▼
          Type Speculation
        (int? float? string? object?)
                  │
                  ▼
        x86-32 Code Generator
       (extends _Emit from jit.ts)
                  │
                  ▼
       Native code in JIT pool
      (jitAlloc / jitWrite — reused)
                  │
                  ▼
     Deopt guard at entry point
    (re-enter interpreter on mismatch)
```

**Key insight:** QuickJS uses **tagged values** (NaN-boxing on 64-bit, tag+union on
32-bit). On i686, a `JSValue` is `{ int32_t tag; union { int32_t i32; float64_t f64; void* ptr } }`.
The JIT must emit a type check at function entry for every parameter and at every
operation that could produce a heap pointer.

---

### 2.1 QuickJS Opcode Audit

QuickJS bytecode is documented in `quickjs.c` (function `dump_byte_code()`).
The opcodes needed for numeric SPAs are a small subset:

**Priority 1 — integer arithmetic (maps directly to existing JIT emit ops):**
```
OP_add, OP_sub, OP_mul, OP_div, OP_mod
OP_neg, OP_inc, OP_dec
OP_shl, OP_shr, OP_sar, OP_and, OP_or, OP_xor, OP_not
OP_lt, OP_lte, OP_gt, OP_gte, OP_eq, OP_neq, OP_strict_eq, OP_strict_neq
OP_if_true, OP_if_false, OP_goto
OP_push_i32, OP_push_const (int)
OP_get_loc, OP_put_loc, OP_get_arg, OP_put_arg
OP_return
```

**Priority 2 — array access (needed for typed array hot loops):**
```
OP_get_field2     (typed array element read)
OP_put_field2     (typed array element write)
OP_array_from     (create array)
OP_push_atom_value
```

**Priority 3 — calls and closures (complex, phase 2b):**
```
OP_call, OP_call_method
OP_get_field (property access — requires inline cache)
OP_put_field
OP_define_field
OP_closure
```

**Out of scope for Phase 2:**
- `OP_await`, `OP_yield` — async/generator state machines
- `OP_regexp` — regex compilation
- `OP_with_loc` — `with` statement
- `OP_eval` — nested eval
- `OP_import*` — dynamic imports

---

### 2.2 Hook Point in QuickJS

QuickJS does not currently have a JIT callback. We need to add one.
**This is the only C code change in Phase 2.** It follows the C Code Rule:
it is a pure I/O primitive — a callback registration and invocation — with
no scheduling logic.

**File to modify:** `/opt/quickjs/quickjs.c` (WSL)

```c
/* Add to JSRuntime struct: */
typedef int (*js_jit_hook_t)(JSContext *ctx,
                              JSFunctionBytecode *b,
                              JSValue *sp,
                              int argc);
js_jit_hook_t jit_hook;
void *jit_hook_opaque;

/* Add public API: */
void JS_SetJITHook(JSRuntime *rt,
                   js_jit_hook_t hook,
                   void *opaque);

/* In JS_CallInternal() hot loop, after hotness counter exceeds threshold: */
if (rt->jit_hook && b->call_count > JIT_THRESHOLD) {
    int r = rt->jit_hook(ctx, b, sp, argc);
    if (r == 0) return sp[-1]; /* JIT handled it, result on stack */
    /* r != 0: fall through to interpreter */
}
```

**`quickjs_binding.c` additions:**
- `js_set_jit_hook(ctx, hookFn)` — called from TypeScript to install the TS-side dispatcher
- The dispatcher receives `(functionBytecodePtr, stackPtr, argc)` and returns 0 (JIT ran)
  or 1 (deopt, let interpreter handle)

---

### 2.3 Type Speculation System

QuickJS i686 `JSValue` layout:
```c
typedef struct {
    int32_t tag;        /* JS_TAG_INT=1, JS_TAG_FLOAT64=7, JS_TAG_OBJECT=-1, ... */
    union {
        int32_t int32;
        /* float64 stored as two int32s on i686 */
        struct { int32_t lo; int32_t hi; } float64;
        void *ptr;
    } u;
} JSValue;  /* 8 bytes on i686 */
```

**Type guard emission (per function entry):**
```typescript
// In qjs-jit.ts
function emitTypeGuard(reg: Reg, expectedTag: number, deoptLabel: Label): void {
  // mov eax, [reg + 0]     ; load tag word
  // cmp eax, expectedTag
  // jne deoptLabel          ; type mismatch → deopt
}
```

**Speculation policy (start conservative):**
- Only JIT functions where ALL args and locals are observed as `JS_TAG_INT` for
  the last N calls (N = 8 by default)
- Track observation counts in a side table (`Map<bytecodePtr, TagObservation[]>`)
  maintained by the interpreter hook (installed before JIT threshold is reached)
- Promote to JIT only when all slots are 100% int for N consecutive calls

**Deoptimisation entry:**
- Each JIT-compiled function starts with a type-guard preamble
- If any guard fails: increment deopt counter, fall back to QuickJS interpreter
- After 3 deopt events: permanently blacklist function from JIT (mark in side table)

---

### 2.4 New File: `qjs-jit.ts`

**Location:** `src/os/process/qjs-jit.ts`

This module extends the existing JIT infrastructure:

```typescript
import { JIT, _Emit } from './jit.js';

/** Reads a QuickJS JSFunctionBytecode struct from memory. */
class QJSBytecodeReader {
  constructor(private ptr: number) {}
  get opcodes(): Uint8Array { /* read via kernel.readPhysMem() */ }
  get constantPool(): QJSValue[] { /* ... */ }
  get localCount(): number { /* ... */ }
  get argCount(): number { /* ... */ }
}

/** Compiles one QuickJS bytecode function to x86-32 native code. */
class QJSJITCompiler {
  private emit = new _Emit();

  compile(reader: QJSBytecodeReader): number /* native code ptr */ {
    this.emitPrologue(reader.argCount, reader.localCount);
    this.emitTypeGuards(reader.argCount);
    for (const op of reader.opcodes) {
      this.emitOpcode(op);
    }
    return this.emit.link(); // → jitAlloc + jitWrite
  }

  private emitOpcode(op: QJSOp): void {
    switch (op.code) {
      case OP_add: this.emit.addEAX_ECX(); break;
      case OP_push_i32: this.emit.pushImm32(op.imm); break;
      case OP_get_loc: this.emit.movEAX_EBP(localOffset(op.idx)); break;
      case OP_if_false: this.emit.testEAX_EAX(); this.emit.jz(op.target); break;
      /* ... */
      default: this.emitDeopt(); break; // unknown op → deopt
    }
  }
}

/** JITProfiler hook for QuickJS — installed via JS_SetJITHook. */
export class QJSJITHook {
  private compiled = new Map<number, number>(); // bytecodePtr → nativePtr
  private counters = new Map<number, number>(); // bytecodePtr → call count
  private blacklist = new Set<number>();

  handle(bytecodePtr: number, stackPtr: number, argc: number): 0 | 1 {
    if (this.blacklist.has(bytecodePtr)) return 1;
    const count = (this.counters.get(bytecodePtr) ?? 0) + 1;
    this.counters.set(bytecodePtr, count);

    if (count < JIT_THRESHOLD) return 1; // still warming up

    let native = this.compiled.get(bytecodePtr);
    if (!native) {
      try {
        const reader = new QJSBytecodeReader(bytecodePtr);
        native = new QJSJITCompiler().compile(reader);
        this.compiled.set(bytecodePtr, native);
      } catch {
        this.blacklist.add(bytecodePtr);
        return 1;
      }
    }

    // call native code; result written to stackPtr
    const result = kernel.jitCallI8(native, stackPtr, argc, 0, 0, 0, 0, 0);
    if (result === DEOPT_SENTINEL) {
      // type mismatch — blacklist after 3 deopt events
      this.compiled.delete(bytecodePtr);
      return 1;
    }
    return 0; // success
  }
}
```

---

### 2.5 Inline Caches for Property Access

Property access (`obj.foo`) is the dominant operation in most SPAs. Without inline
caches (ICs), every `OP_get_field` must do a full hash-table lookup in QuickJS's
shape system.

**Monomorphic inline cache (Phase 2b):**
```
; Generated JIT code for obj.foo:
  mov eax, [stackTop]         ; load object ptr
  mov ecx, [eax + SHAPE_OFFSET] ; load shape pointer
  cmp ecx, EXPECTED_SHAPE     ; shape check (patched at runtime)
  jne slow_path               ; deopt on shape mismatch
  mov eax, [eax + PROP_OFFSET] ; fast property load (offset patched at runtime)
  jmp done
slow_path:
  call qjs_get_field_slow     ; full interpreter lookup
  ; patch EXPECTED_SHAPE and PROP_OFFSET for next call
done:
```

The "patching" here works by writing directly into the JIT pool (the pool is
`PROT_READ|PROT_WRITE|PROT_EXEC` — already set up in `jit.c`).

**Polymorphic inline cache (Phase 2c, stretch):**
- PIC: chain of monomorphic guards, fall through to slow path
- Megamorphic threshold: >4 shapes → permanent slow path

---

### 2.6 `kernel.readPhysMem` Primitive

The QJS bytecode reader needs to read QuickJS internal structs from memory.

**Files to modify:**
- `src/kernel/quickjs_binding.c` — add `js_read_phys_mem(ctx, argc, argv)`:
  ```c
  // Args: (ptr: uint32, length: uint32) → ArrayBuffer
  // Copies `length` bytes from physical address `ptr` into a new JS ArrayBuffer.
  ```
- `src/os/core/kernel.ts` — add `readPhysMem(ptr: number, length: number): ArrayBuffer`

This is the only additional C primitive needed for Phase 2 (beyond the hook in 2.2).
It is a pure memory read — no logic.

---

### 2.7 JIT Pool Expansion

The current JIT pool is 256KB. A JIT-compiled SPA page can easily have 500+ hot
functions. At ~512 bytes per compiled function (aggressive estimate), that's 256KB
consumed immediately.

**Files to modify:**
- `src/kernel/jit.c` — increase `JIT_POOL_SIZE` from `256*1024` to `2*1024*1024` (2MB)
- `src/kernel/linker.ld` — verify `.bss` section accommodates the larger pool
- `src/kernel/kernel.c` — update any size constants

**Alternative (Phase 2b):** Implement JIT code eviction — LRU eviction of cold
compiled functions when the pool is full. Track `last_called` timestamp per entry.

---

### 2.8 Float64 Support (Phase 2b)

Most SPA JS uses floating-point: `Date.now()`, animation lerp values, layout
coordinates. The current int32 JIT has no float support.

**Approach:** Use the x87 FPU (already available on i686 targets). Add float emit
ops to `_Emit` in `jit.ts`:
```typescript
fldl_m64(addr: number)   // FLD QWORD PTR [addr]
fstpl_m64(addr: number)  // FSTP QWORD PTR [addr]
faddp()                  // FADDP
fsubp()                  // FSUBP
fmulp()                  // FMULP
fdivp()                  // FDIVP
```

Float paths are only taken when the type speculation system observes `JS_TAG_FLOAT64`
consistently. Integer paths still use the existing int32 emit infrastructure.
Mixed int/float functions fall back to the interpreter.

---

### Phase 2 Dependency Order

```
2.6 readPhysMem primitive       (C — 1 day)
      │
      ▼
2.1 Opcode audit                (research — 2 days)
      │
      ▼
2.2 QuickJS hook point          (C — 2 days, only C change)
      │
      ├──► 2.3 Type speculation system    (TS — 1 week)
      │          │
      │          ▼
      │    2.4 qjs-jit.ts skeleton       (TS — 2 weeks)
      │          │
      │          ├──► 2.5 Inline caches  (TS — 1 week)
      │          │
      │          └──► 2.8 Float64 paths  (TS — 1 week)
      │
      └──► 2.7 Pool expansion            (C — half day)
```

**Minimum viable Phase 2:** Items 2.1 + 2.2 + 2.3 + 2.4 (int32 only, no ICs, no float).
This is enough to see JIT speedup on numeric benchmarks (fibonacci, sort, mandelbrot).
Adds ~4 weeks of work after Phase 1 is complete.

---

## Summary Timeline

| Phase | Item | Effort | Cumulative |
|---|---|---|---|
| **1.9.1** | Batch mutations to RAF (highest ROI) | 1 day | 0.2w |
| **1.9.2** | Eliminate serialize/reparse round-trip | 2 days | 0.6w |
| **1.10.2** | Linked-list siblings + ID index | 2 days | 1w |
| **1.10.3** | VClassList caching | 0.5 days | 1.1w |
| **1.10.4** | isConnected / contains / dataset | 0.5 days | 1.2w |
| **1.11.1** | queueMicrotask correct ordering | 1 day | 1.4w |
| **1.11.2** | MessageChannel / MessagePort | 1 day | 1.6w |
| **1.11.3** | window.innerWidth/Height/devicePixelRatio | 0.5 days | 1.7w |
| **1.11.4** | document.readyState / activeElement | 0.5 days | 1.8w |
| **1.11.6** | addEventListener capture phase | 2 days | 2.2w |
| **1.8** | MutationObserver functional callbacks | 3 days | 2.8w |
| **1.6** | Async fetch + Promise | 1 week | 3.8w |
| **1.7** | localStorage (VFS-backed) | 2 days | 4.2w |
| **1.10.1** | getBoundingClientRect (zeros until 1.1) | 1 day | 4.4w |
| **1.11.5** | TextEncoder / TextDecoder | 1 day | 4.6w |
| **1.11.7** | structuredClone proper implementation | 1 day | 4.8w |
| **1.9.5** | JIT image blit | 2 days | 5.2w |
| **1.9.7** | Scroll blit | 3 days | 5.8w |
| **1.1** | CSS box model (%, flex) | 3 weeks | 8.8w |
| **1.2** | Canvas 2D API (Tier 1) | 2 weeks | 10.8w |
| **1.3** | `<canvas>` compositing | 1 week | 11.8w |
| **1.4** | CSS transitions | 1 week | 12.8w |
| **1.5** | Proportional font | 1 week | 13.8w |
| **1.9.3** | Incremental layout (dirty subtree) | 1 week | 14.8w |
| **1.9.4** | Damage rectangles + partial redraws | 1 week | 15.8w |
| **1.2b** | Canvas 2D Tier 2 (gradients, transforms) | 1 week | 16.8w |
| **1.9.6** | JIT line rasterizer | 2 weeks | 18.8w |
| **2.1–2.4** | QJS bytecode JIT (int32, no IC) | 4 weeks | 22.8w |
| **2.5** | Inline caches | 1 week | 23.8w |
| **2.7** | Pool expansion + eviction | 1 week | 24.8w |
| **2.8** | Float64 JIT paths | 1 week | 25.8w |

**Checkpoint SPAs to validate each phase:**
- After 1.9.1 + 1.9.2 + 1.10.x + 1.11.x (first 5 weeks): **TodoMVC React 18** should
  run correctly — hooks, state, effects, event delegation all working
- After above + 1.6 + 1.8: **Vue 3 TodoMVC** should work — reactivity, nextTick,
  MutationObserver signal all functional
- After 1.9.1 + 1.9.2: React `setState` loop should render at 60 fps (was ~5 fps)
- After 1.9.5 + 1.9.7: Image-heavy pages scroll without tearing
- After 1.1 + 1.10.1 (real getBCR): Floating UI dropdowns appear in correct position
- After 1.1: Bootstrap 5 layout renders columns correctly
- After 1.2: Chart.js line chart renders
- After full Phase 1: A compiled React + React-DOM SPA at smooth framerate
- After Phase 2 MVP: Fibonacci benchmark >10× speedup over interpreter
- After 2.5: React reconciler shows measurable speedup on property-access workloads
