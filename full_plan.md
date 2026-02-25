# JSOS Full Browser + JIT Implementation Plan

> **Principle:** TypeScript IS the OS. C code exists only to provide raw hardware
> I/O primitives — pure, stateless, architecture-agnostic. Every algorithm, every
> data structure, every policy lives in TypeScript.

---

## What Exists Today

| Component | Status | Notes |
|---|---|---|
| HTML tokenizer + parser | ✅ Working | `html.ts` — tag soup tolerant |
| Virtual DOM | ✅ Working | `dom.ts` — VDocument / VElement / VText |
| Basic CSS (inline only) | ⚠️ Partial | `style` attribute parsed; no box model |
| Layout engine | ⚠️ Minimal | `layout.ts` — fixed 8×8 character grid only |
| Page JS execution | ✅ Working | `jsruntime.ts` via QuickJS |
| Canvas pixel buffer | ✅ Working | `canvas.ts` — 32-bit BGRA |
| `requestAnimationFrame` | ✅ Working | Driven by `tick()` in BrowserApp |
| `performance.now()` | ✅ Working | PIT-based millisecond timer |
| `fetch()` | ✅ Working | Returns real `Promise`; needs AbortController |
| `localStorage` / `sessionStorage` | ⚠️ In-memory | Not VFS-backed; lost on reboot |
| `querySelector` / `querySelectorAll` | ✅ Working | Simple CSS selector subset |
| `Proxy` / `Reflect` | ✅ Working | Passed through to QuickJS |
| `addEventListener` bubbling | ✅ Working | Capture phase silently ignored |
| `classList` | ⚠️ Working | Re-parses class string on every call |
| `style` proxy | ✅ Working | Per-element `CSSStyleDeclaration` proxy |
| `atob` / `btoa` | ✅ Working | Pure TS |
| `DOMParser` | ✅ Working | Delegates to `html.ts` |
| `MutationObserver` | ❌ Stub | `.observe()` is a no-op |
| `queueMicrotask` | ❌ Wrong | Implemented as `setTimeout(fn, 0)` — fires 16 ms late |
| `MessageChannel` | ❌ Missing | Not in `win` object |
| `TextEncoder` / `TextDecoder` | ❌ Missing | — |
| `structuredClone` | ❌ Missing | — |
| `getBoundingClientRect` | ❌ Missing | No layout geometry at all |
| `offsetWidth` / `offsetHeight` | ❌ Missing | — |
| `isConnected` / `contains` / `dataset` | ❌ Missing | — |
| `window.innerWidth` / `innerHeight` | ❌ Missing | — |
| `document.readyState` | ❌ Missing | — |
| Canvas 2D API (`<canvas>`) | ❌ Missing | No `getContext('2d')` |
| CSS box model (%, flex, position) | ❌ Missing | Fixed grid only |
| CSS transitions / animations | ❌ Missing | — |
| Variable-width fonts | ❌ Missing | 8×8 bitmap only |
| JIT for page JS | ❌ Missing | QuickJS interprets everything |
| Rendering batching | ❌ Missing | N mutations → N full rerenders |
| Incremental layout | ❌ Missing | Full layout recalc every frame |
| Damage rectangles | ❌ Missing | Entire viewport cleared every frame |
| JIT image blit | ✅ Partial | `jit-canvas.ts` exists; not wired to image decode path |

---

## SPA Compatibility Audit

### What Works Today in Page JS

- `class`, `extends`, static methods, `#privateField`
- `async` / `await`, `Promise`, `Promise.all`, `Promise.allSettled`
- `Proxy`, `Reflect`, `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry`
- All ES2023 data structures: `Map`, `Set`, `Array`, typed arrays, `ArrayBuffer`
- Optional chaining `?.`, nullish coalescing `??`, logical assignment `&&=`
- Template literals, destructuring, spread, generators
- `JSON.parse` / `JSON.stringify`
- `Math.*`, `parseInt`, `parseFloat`, `Number.*`, `BigInt`
- `fetch()` with real Promise returned (real network via virtio-net)
- `requestAnimationFrame` — driven by PIT, fires at ~60 fps
- `performance.now()` — microsecond precision via PIT
- `querySelector` / `querySelectorAll` — basic CSS selectors
- `innerHTML` set and get, `textContent` set and get
- `createElement`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`
- `addEventListener` / `removeEventListener` — bubbling phase only
- `dispatchEvent` (synthetic events, bubbling)
- `classList.add` / `remove` / `toggle` / `contains`
- `style.foo = value` — per-element style proxy
- `atob` / `btoa`, `DOMParser`, `URL`, `URLSearchParams`

### Correctness Blockers (must fix before SPAs run at all)

| API | Impact | Affected Frameworks |
|---|---|---|
| `getBoundingClientRect` returns nothing | Popover / tooltip / dropdown placement broken | All UI libs |
| `offsetWidth` / `offsetHeight` missing | Scroll management broken | React-Virtual, AG-Grid |
| `isConnected` missing | React 18 `useInsertionEffect` guard fails | React 18 |
| `node.contains()` missing | React 18 event delegation check fails | React 18 |
| `dataset` missing | Common data-* attribute access pattern | Vue, SvelteKit |
| `window.innerWidth` / `innerHeight` missing | Responsive code breaks | Any responsive SPA |
| `document.readyState` missing | DOMContentLoaded guard fires never / always | Many SPAs |
| `MessageChannel` missing | React 18 `scheduleCallback` scheduler broken | React 18 |
| `TextEncoder` / `TextDecoder` missing | Binary data, crypto, encoding broken | Many |
| Capture phase silently ignored | React 18 captures `onClickCapture` at root | React 18 |
| `MutationObserver.observe()` no-op | `@tanstack/query` cache invalidation broken | TanStack, Vue reactivity |
| `queueMicrotask` fires as macrotask | Promise resolution order wrong, tearing | React 18, Vue 3 |
| `structuredClone` missing | State management cloning broken | Redux Toolkit, Zustand |

### Performance Killers

| Issue | Current Cost | Fix |
|---|---|---|
| N mutations → N full rerenders | Each `setState` call = full serialize+parse+layout+blit | Batch to RAF (Phase 1, item 3) |
| `serializeDOM()` + `parseHTML()` per frame | O(nodes) × 2 string allocations per frame | Eliminate round-trip (Phase 1, item 4) |
| `getElementById` is O(N) walk | O(N) per reconciler lookup | ID index Map (Phase 1, item 5) |
| `nextSibling` / `previousSibling` is O(N) | `indexOf()` on children array | Linked-list nodes (Phase 1, item 5) |
| `VClassList._clss()` re-parses on every call | O(classes) per class check | Cache as `Set<string>` (Phase 1, item 6) |
| Full viewport blit every frame | Even unchanged pixels redrawn | Damage rectangles (Phase 2, item 5) |
| Image decode: double for-loop `setPixel` | O(W×H) JS calls per frame | JIT blit row (Phase 2, item 3) |

---

## Phase 1 — DOM Correctness & Runtime APIs

> **Goal:** A compiled React 18 or Vue 3 SPA loads and runs correctly.
> **Target:** ~5 weeks.

Priority order: correctness fixes first, then missing APIs, then performance helpers.

---

### 1.1 Batch Mutations to RAF

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/apps/browser/index.ts`

Current behaviour: every DOM mutation in `execScript()` calls `checkDirty()` which
immediately calls `doRerender()` — a full serialize → parse → layout → blit cycle.

**Fix:**
```typescript
// jsruntime.ts: remove immediate checkDirty() call after mutations
// index.ts tick():
tick(now: number): void {
  this.pageJS.tick(now);        // drains RAF + timers; mutations accumulate
  this.pageJS.flushMicrotasks(); // drain microtask queue
  if (this._dirty) {
    this._dirty = false;
    this.doRerender();           // one rerender per frame, after all JS runs
  }
}
```

Add `flushSync(fn)` on `win` for React `flushSync` / `act()` support:
```typescript
win.flushSync = (fn: () => void) => {
  fn();
  if (this._dirty) { this._dirty = false; this.doRerender(); }
};
```

**Effort:** 1 day. **ROI:** Highest — eliminates the N×render-per-frame problem.

---

### 1.2 Eliminate Serialize / Reparse Round-Trip

**Files:** `src/os/apps/browser/index.ts`, `src/os/apps/browser/jsruntime.ts`

Current hot path: `doRerender()` → `serializeDOM(doc)` → string → `parseHTML(bodyHTML)` → new VDocument → layout → blit.

**Fix:** Change `PageCallbacks.rerender` signature from `string` to `VDocument`:

```typescript
// Before:
interface PageCallbacks { rerender(bodyHTML: string): void; }

// After:
interface PageCallbacks { rerender(doc: VDocument): void; }

// jsruntime.ts — pass the live doc reference:
this.cb.rerender(this.doc);

// index.ts — receive VDocument directly:
rerender(doc: VDocument): void {
  this._layout = this._layoutEngine.computeLayout(doc, this._viewport);
  this._blit(this._layout);
}
```

Eliminates two O(page-size) string allocations and the entire `parseHTML()` call
from the hot path.

**Effort:** 2 days. **ROI:** Very high — eliminates the biggest per-frame allocation.

---

### 1.3 `addEventListener` Capture Phase

**Files:** `src/os/apps/browser/dom.ts`

React 18 installs a root `capture: true` listener for its synthetic event delegation.
Without capture phase, the entire React event system is broken.

```typescript
// In VElement (dom.ts):
private _bubbleHandlers  = new Map<string, Set<EventListener>>();
private _captureHandlers = new Map<string, Set<EventListener>>();

addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions | boolean) {
  const capture = typeof opts === 'boolean' ? opts : (opts?.capture ?? false);
  const map = capture ? this._captureHandlers : this._bubbleHandlers;
  if (!map.has(type)) map.set(type, new Set());
  map.get(type)!.add(fn);
}

removeEventListener(type: string, fn: EventListener, opts?: EventListenerOptions | boolean) {
  const capture = typeof opts === 'boolean' ? opts : (opts?.capture ?? false);
  const map = capture ? this._captureHandlers : this._bubbleHandlers;
  map.get(type)?.delete(fn);
}
```

**Dispatch (3-phase):**
1. Collect ancestors from target to root
2. Capture phase: walk root→target, fire `_captureHandlers`
3. Target: fire both capture and bubble handlers
4. Bubble phase: walk target→root, fire `_bubbleHandlers`

**Effort:** 2 days.

---

### 1.4 `queueMicrotask` Correct Ordering

**Files:** `src/os/apps/browser/jsruntime.ts`

React 18 and Vue 3 depend heavily on microtasks running synchronously after each
task, before the next task or paint. `setTimeout(fn, 0)` fires 16 ms later.

```typescript
// jsruntime.ts:
private _microtaskQueue: (() => void)[] = [];

private _flushMicrotasks(): void {
  while (this._microtaskQueue.length > 0) {
    const tasks = this._microtaskQueue.splice(0);
    for (const fn of tasks) fn();
  }
}
```

Install on `win`:
```typescript
win.queueMicrotask = (fn: () => void) => this._microtaskQueue.push(fn);
```

Drain `_flushMicrotasks()` at the end of:
- Every `execScript()` call
- Every timer callback
- Every `requestAnimationFrame` callback

**Effort:** 1 day.

---

### 1.5 `MessageChannel` / `MessagePort`

**Files:** `src/os/apps/browser/jsruntime.ts`

React 18's scheduler (`react-dom/scheduler`) uses `MessageChannel` for async
`scheduleCallback`. Without it, `ReactDOM.render` fails silently.

```typescript
class MessagePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private _other!: MessagePort;

  postMessage(data: unknown): void {
    const other = this._other;
    setTimeout_(() => other.onmessage?.({ data } as MessageEvent), 0);
  }
  start() {}
  close() {}
}

class MessageChannel {
  port1 = new MessagePort();
  port2 = new MessagePort();
  constructor() {
    (this.port1 as any)._other = this.port2;
    (this.port2 as any)._other = this.port1;
  }
}

win.MessageChannel = MessageChannel;
```

**Effort:** 1 day.

---

### 1.6 `MutationObserver` Functional Callbacks

**Files:** `src/os/apps/browser/dom.ts`, `src/os/apps/browser/jsruntime.ts`

Currently `observe()` is a no-op. Vue 3 reactivity, `@tanstack/query`, and many
other libraries use `MutationObserver` as the signal to flush pending updates.

**On `VDocument`:**
```typescript
_observers: Array<{ target: VNode; cb: MutationCallback; opts: MutationObserverInit }> = [];

_notify(mutation: MutationRecord): void {
  for (const obs of this._observers) {
    if (/* target matches */ this._isAncestorOrEqual(obs.target, mutation.target)) {
      obs._pending.push(mutation);
    }
  }
}

_flushObservers(): void {
  for (const obs of this._observers) {
    if (obs._pending.length > 0) {
      const records = obs._pending.splice(0);
      obs.cb(records, obs._observer);
    }
  }
}
```

Call `_notify()` inside every DOM mutation method (`appendChild`, `removeChild`,
`setAttribute`, `textContent = ...`). Call `_flushObservers()` once per `tick()`
after RAF callbacks but before the dirty check.

**Effort:** 3 days.

---

### 1.7 `window.innerWidth` / `innerHeight` / `devicePixelRatio`

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/apps/browser/index.ts`

```typescript
// Add to PageCallbacks:
interface PageCallbacks {
  getViewportWidth(): number;
  getViewportHeight(): number;
}

// index.ts — implement:
getViewportWidth(): number { return this._viewport.width; }
getViewportHeight(): number { return this._viewport.height; }

// jsruntime.ts — install on win:
Object.defineProperty(win, 'innerWidth',  { get: () => this.cb.getViewportWidth() });
Object.defineProperty(win, 'innerHeight', { get: () => this.cb.getViewportHeight() });
win.devicePixelRatio = 1;
```

**Effort:** 0.5 days.

---

### 1.8 `document.readyState` + `activeElement`

**Files:** `src/os/apps/browser/dom.ts`, `src/os/apps/browser/jsruntime.ts`

```typescript
// VDocument:
readyState: 'loading' | 'interactive' | 'complete' = 'loading';
activeElement: VElement | null = null;

// jsruntime.ts init sequence:
await execScript(html);        // inline scripts
doc.readyState = 'interactive';
dispatchEvent(new Event('DOMContentLoaded'));
doc.readyState = 'complete';
dispatchEvent(new Event('load'));
```

**Effort:** 0.5 days.

---

### 1.9 `isConnected` / `contains()` / `dataset` / `offsetParent`

**Files:** `src/os/apps/browser/dom.ts`

```typescript
// VNode:
get isConnected(): boolean {
  let n: VNode | null = this;
  while (n) { if (n === this._document) return true; n = n.parentNode; }
  return false;
}

contains(other: VNode | null): boolean {
  let n = other;
  while (n) { if (n === this) return true; n = n.parentNode; }
  return false;
}

// VElement:
get dataset(): Record<string, string> {
  return new Proxy({}, {
    get: (_, key: string) => this.getAttribute('data-' + camelToKebab(key)) ?? undefined,
    set: (_, key: string, value: string) => { this.setAttribute('data-' + camelToKebab(key), value); return true; },
    has: (_, key: string) => this.hasAttribute('data-' + camelToKebab(key)),
  });
}

get offsetParent(): VElement | null {
  let n = this.parentElement;
  while (n) {
    const pos = n.style?.position;
    if (pos === 'relative' || pos === 'absolute' || pos === 'fixed' || n.tagName === 'BODY') return n;
    n = n.parentElement;
  }
  return null;
}
```

**Effort:** 0.5 days.

---

### 1.10 O(1) DOM Lookups (Linked-List Siblings + ID Index)

**Files:** `src/os/apps/browser/dom.ts`

Current: `getElementById` = O(N) `_walk()`. `nextSibling` = `indexOf` on children array.

**Linked-list siblings on `VNode`:**
```typescript
class VNode {
  _next: VNode | null = null;   // nextSibling
  _prev: VNode | null = null;   // previousSibling

  get nextSibling(): VNode | null { return this._next; }
  get previousSibling(): VNode | null { return this._prev; }
}
```

Update `appendChild`, `insertBefore`, `removeChild` to maintain `_next`/`_prev`
pointers on the node being inserted / removed and its neighbors.

**ID index on `VDocument`:**
```typescript
class VDocument {
  _idIndex = new Map<string, VElement>();

  getElementById(id: string): VElement | null {
    return this._idIndex.get(id) ?? null;
  }
}
```

Update `setAttribute('id', v)` and `removeAttribute('id')` to maintain `_idIndex`.

**Effort:** 2 days.

---

### 1.11 `VClassList` Caching

**Files:** `src/os/apps/browser/dom.ts`

```typescript
class VClassList {
  private _raw = '';
  private _cache: Set<string> | null = null;

  private _set(): Set<string> {
    if (!this._cache) this._cache = new Set(this._raw.split(/\s+/).filter(Boolean));
    return this._cache;
  }

  private _invalidate() { this._cache = null; }

  // Called only when setAttribute('class', v) is called:
  _update(raw: string) { this._raw = raw; this._invalidate(); }

  contains(cls: string): boolean { return this._set().has(cls); }
  add(...classes: string[])    { classes.forEach(c => this._set().add(c));    this._sync(); }
  remove(...classes: string[]) { classes.forEach(c => this._set().delete(c)); this._sync(); }
  toggle(cls: string, force?: boolean): boolean { /* ... */ this._sync(); return ...; }

  private _sync() { this._raw = [...this._set()].join(' '); this._invalidate(); }
}
```

**Effort:** 0.5 days.

---

### 1.12 `getBoundingClientRect` (zeros until Phase 3)

**Files:** `src/os/apps/browser/dom.ts`, `src/os/apps/browser/layout.ts`

Returns `{ top:0, left:0, width:0, height:0, ... }` now so the call doesn't throw.
Once Phase 3 (CSS box model) is complete, `layout.ts` will populate `_renderedRect`
on each `VElement` during layout, and this getter reads that value.

```typescript
class VElement {
  _renderedRect: DOMRect = { top:0, left:0, right:0, bottom:0, width:0, height:0, x:0, y:0 };

  getBoundingClientRect(): DOMRect {
    return { ...this._renderedRect };
  }
  get offsetWidth():  number { return this._renderedRect.width; }
  get offsetHeight(): number { return this._renderedRect.height; }
  get clientWidth():  number { return this._renderedRect.width; }
  get clientHeight(): number { return this._renderedRect.height; }
}
```

**Effort:** 1 day (skeleton). Real values: depends on Phase 3.

---

### 1.13 `TextEncoder` / `TextDecoder`

**Files:** `src/os/apps/browser/jsruntime.ts` (or new `src/os/net/encoding.ts`)

Pure TypeScript UTF-8 implementation:

```typescript
class TextEncoder {
  encode(str: string): Uint8Array {
    const buf: number[] = [];
    for (let i = 0; i < str.length; ) {
      let cp = str.codePointAt(i)!;
      i += cp > 0xFFFF ? 2 : 1;
      if      (cp < 0x80)   buf.push(cp);
      else if (cp < 0x800)  buf.push(0xC0|(cp>>6), 0x80|(cp&0x3F));
      else if (cp < 0x10000) buf.push(0xE0|(cp>>12), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F));
      else                   buf.push(0xF0|(cp>>18), 0x80|((cp>>12)&0x3F), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F));
    }
    return new Uint8Array(buf);
  }
  readonly encoding = 'utf-8';
}
```

`TextDecoder` mirrors the above in reverse. Install on `win`.

**Effort:** 1 day.

---

### 1.14 `structuredClone`

**Files:** `src/os/apps/browser/jsruntime.ts`

Recursive deep clone handling: `Date`, `Map`, `Set`, `ArrayBuffer`, typed arrays,
circular references via `WeakMap`.

```typescript
function structuredClone<T>(value: T): T {
  const seen = new WeakMap();
  function clone(v: unknown): unknown {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return seen.get(v as object);
    if (v instanceof Date)        return new Date(v.getTime());
    if (v instanceof ArrayBuffer) return v.slice(0);
    if (v instanceof Map)  { const m = new Map(); seen.set(v, m); v.forEach((val, k) => m.set(clone(k), clone(val))); return m; }
    if (v instanceof Set)  { const s = new Set(); seen.set(v, s); v.forEach(val => s.add(clone(val))); return s; }
    if (Array.isArray(v))  { const a: unknown[] = []; seen.set(v, a); v.forEach((x, i) => { a[i] = clone(x); }); return a; }
    const obj: Record<string, unknown> = {};
    seen.set(v, obj);
    for (const k of Object.keys(v as object)) obj[k] = clone((v as any)[k]);
    return obj;
  }
  return clone(value) as T;
}
win.structuredClone = structuredClone;
```

**Effort:** 1 day.

---

### 1.15 `localStorage` / `sessionStorage` VFS-Backed

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/fs/filesystem.ts`

Current: in-memory `Map` — data lost on reboot.

**Fix:** Persist to `/home/browser_storage.json` via the VFS at load / on `setItem`.

```typescript
class VFSStorage implements Storage {
  private _path: string;
  private _data: Record<string, string> = {};

  constructor(path: string) {
    this._path = path;
    try { this._data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
  }

  setItem(key: string, value: string): void {
    this._data[key] = value;
    this._flush();
  }
  getItem(key: string): string | null { return this._data[key] ?? null; }
  removeItem(key: string): void { delete this._data[key]; this._flush(); }
  clear(): void { this._data = {}; this._flush(); }
  key(n: number): string | null { return Object.keys(this._data)[n] ?? null; }
  get length(): number { return Object.keys(this._data).length; }

  private _flush(): void {
    fs.writeFileSync(this._path, JSON.stringify(this._data));
  }
}

win.localStorage  = new VFSStorage('/home/browser_storage.json');
win.sessionStorage = new VFSStorage('/tmp/browser_session.json');
```

**Effort:** 2 days.

---

### 1.16 `fetch()` Improvements

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/net/http.ts`

`fetch()` already returns a real `Promise` via virtio-net + TCP stack. Add:
- `AbortController` / `AbortSignal` (signal passed to fetch cancels the TCP stream)
- `Response.blob()` returning a `Blob` backed by `ArrayBuffer`
- `Response.arrayBuffer()` for binary downloads
- `credentials`, `mode`, `cache` options (ignore if not applicable, do not throw)

**Effort:** 1 week.

---

### Phase 1 Summary

| Item | Description | Effort |
|---|---|---|
| 1.1 | Batch mutations to RAF | 1 day |
| 1.2 | Eliminate serialize/reparse round-trip | 2 days |
| 1.3 | `addEventListener` capture phase | 2 days |
| 1.4 | `queueMicrotask` correct ordering | 1 day |
| 1.5 | `MessageChannel` / `MessagePort` | 1 day |
| 1.6 | `MutationObserver` functional | 3 days |
| 1.7 | `window.innerWidth` / `innerHeight` | 0.5 days |
| 1.8 | `document.readyState` / `activeElement` | 0.5 days |
| 1.9 | `isConnected` / `contains` / `dataset` / `offsetParent` | 0.5 days |
| 1.10 | O(1) DOM lookups (linked-list + ID index) | 2 days |
| 1.11 | `VClassList` caching | 0.5 days |
| 1.12 | `getBoundingClientRect` skeleton | 1 day |
| 1.13 | `TextEncoder` / `TextDecoder` | 1 day |
| 1.14 | `structuredClone` | 1 day |
| 1.15 | `localStorage` VFS-backed | 2 days |
| 1.16 | `fetch()` improvements | 1 week |
| **Total** | | **~5 weeks** |

**Checkpoint:** After Phase 1 — **TodoMVC React 18** and **Vue 3 TodoMVC** should
both load and run correctly.

---

## Phase 2 — Rendering Pipeline Acceleration

> **Goal:** React `setState` loop renders at 60 fps. Image-heavy pages scroll
> without tearing.
> **Target:** ~4 weeks (overlaps with late Phase 1).

---

### 2.1 JIT Image Blit

**Files:** `src/os/apps/browser/index.ts`, `src/os/process/jit-canvas.ts`

Current `_drawImage()` uses a double for-loop calling `setPixel()` per pixel —
O(W×H) JS function calls per frame.

`jit-canvas.ts` already has `JITCanvas.blitRow()` — a JIT-compiled row blit.
Wire it in:

```typescript
// index.ts _drawImage():
_drawImage(img: DecodedImage, x: number, y: number): void {
  const jc = this._jitCanvas;  // lazily initialized JITCanvas
  for (let row = 0; row < img.height; row++) {
    jc.blitRow(
      this._canvas.bufferPhysAddr,     // dest physical address
      img.dataPhysAddr,                // src physical address
      x + (y + row) * this._viewport.width, // dest offset (pixels)
      row * img.width,                 // src offset (pixels)
      img.width                        // pixel count
    );
  }
}
```

**Effort:** 2 days.

---

### 2.2 Scroll Blit (Partial Viewport Shift)

**Files:** `src/os/apps/browser/index.ts`, `src/os/ui/canvas.ts`

Detect scroll-only frame (same DOM, only `scrollTop` changed). Instead of full repaint:
1. Shift the pixel buffer up or down by `deltaY` pixels using a `memcpy`-style JIT kernel
2. Repaint only the newly exposed strip at the top or bottom

```typescript
// canvas.ts:
scrollBlit(deltaY: number, width: number, height: number): void {
  if (deltaY === 0) return;
  const pixelShift = Math.abs(deltaY) * width;
  const src = deltaY > 0 ? 0 : pixelShift;
  const dst = deltaY > 0 ? pixelShift : 0;
  const count = width * height - pixelShift;
  // JIT row-copy loop: count pixels from src to dst
  for (let row = 0; row < Math.abs(deltaY); row++) {
    this._jit.blitRow(this._physAddr, this._physAddr, dst / 4 + row * width, src / 4 + row * width, width);
  }
}
```

**Effort:** 3 days.

---

### 2.3 Incremental Layout (Dirty Subtree Only)

**Files:** `src/os/apps/browser/layout.ts`, `src/os/apps/browser/dom.ts`

Add a `_layoutDirty` flag to `VElement`. Set it when:
- `style` attribute changes
- `className` changes
- Children are added / removed

In `layout.ts`, skip unchanged subtrees:
```typescript
function computeLayout(el: VElement, parentBox: Box): LayoutResult {
  if (!el._layoutDirty && el._cachedLayout) return el._cachedLayout;
  // ... full layout logic ...
  el._layoutDirty = false;
  el._cachedLayout = result;
  return result;
}
```

**Effort:** 1 week (proper dirty propagation is subtle).

---

### 2.4 Damage Rectangles

**Files:** `src/os/apps/browser/index.ts`, `src/os/ui/canvas.ts`

Track which screen region actually changed each frame. Only blit that region to
the VGA framebuffer.

```typescript
// index.ts:
private _damage: { x: number; y: number; w: number; h: number } | null = null;

_expandDamage(rect: DOMRect): void {
  if (!this._damage) { this._damage = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }; return; }
  const x = Math.min(this._damage.x, rect.left);
  const y = Math.min(this._damage.y, rect.top);
  this._damage = {
    x, y,
    w: Math.max(this._damage.x + this._damage.w, rect.right) - x,
    h: Math.max(this._damage.y + this._damage.h, rect.bottom) - y,
  };
}
```

After layout, call `canvas.setClip(damage)` so `fillRect` / `blit` only write
within the damage region. Clear `_damage` at the start of each `tick()`.

**Effort:** 1 week.

---

### 2.5 JIT Line Rasterizer

**Files:** `src/os/apps/browser/index.ts`, `src/os/process/jit-canvas.ts`

Replace the per-pixel JS rasterizer with a JIT-compiled span-fill kernel:

```typescript
// Descriptor per span: [destOffset, color, length]
// JIT kernel reads packed descriptors from an ArrayBuffer and fills the pixel buffer.

const _SRC_DRAW_SPANS = `
  function drawSpans(dest, spans, count) {
    for (var i = 0; i < count; i++) {
      var base   = i * 3;
      var offset = spans[base];
      var color  = spans[base + 1];
      var len    = spans[base + 2];
      for (var j = 0; j < len; j++) dest[offset + j] = color;
    }
  }
`;
```

Compile `drawSpans` with the JIT compiler at browser startup. Each layout pass
generates a flat `Int32Array` of span descriptors; one JIT call fills all spans.

**Effort:** 2 weeks (span generation from layout boxes is complex).

---

### Phase 2 Summary

| Item | Description | Effort |
|---|---|---|
| 2.1 | JIT image blit | 2 days |
| 2.2 | Scroll blit | 3 days |
| 2.3 | Incremental layout (dirty subtree) | 1 week |
| 2.4 | Damage rectangles | 1 week |
| 2.5 | JIT line rasterizer | 2 weeks |
| **Total** | | **~4 weeks** |

**Checkpoint:** After Phase 2 — React `setState` loop renders at 60 fps (was ~5 fps).
Image-heavy pages scroll without tearing.

---

## Phase 3 — CSS Layout & Canvas 2D

> **Goal:** Bootstrap 5 columns render correctly. Chart.js line chart renders.
> **Target:** ~14 weeks (the most complex phase).

---

### 3.1 CSS Box Model

**File:** `src/os/apps/browser/layout.ts` (major rewrite), new `src/os/apps/browser/css.ts`

This is the largest single item in the plan. The existing fixed 8×8 grid layout
must be replaced by a real CSS layout engine.

**`css.ts` — Style Resolution:**
```typescript
// Parse inline style attribute:
function parseInlineStyle(attr: string): CSSStyleDeclaration { /* ... */ }

// Parse <style> sheet:
function parseStylesheet(css: string): StyleRule[] { /* ... */ }

// Resolve computed style for an element (cascade + inheritance):
function resolveComputedStyle(el: VElement, rules: StyleRule[], parent: ComputedStyle): ComputedStyle { /* ... */ }
```

**`layout.ts` — Block Formatting Context (BFC):**

Implementation tiers:
1. **Tier 1** (required for React apps): `display: block/inline`, `width/height` (px + %), `padding`, `margin`, `border-box`, `box-sizing`
2. **Tier 2** (required for Bootstrap): `display: flex`, `flex-direction`, `justify-content`, `align-items`, `flex-wrap`, `flex: N`
3. **Tier 3** (required for complex SPAs): `position: relative/absolute/fixed`, `z-index`, stacking contexts, `overflow: hidden/scroll`, `float`

Once Phase 3.1 is complete, `VElement._renderedRect` is populated with real pixel
values, and `getBoundingClientRect()` (Phase 1.12) returns correct geometry.

**Effort:** 3 weeks (Tier 1 + 2).

---

### 3.2 Canvas 2D API

**New file:** `src/os/apps/browser/canvas2d.ts`

`<canvas>` elements need `getContext('2d')` returning a `CanvasRenderingContext2D`.

**Tier 1 (required for basic Chart.js):**
```typescript
class Canvas2DContext {
  fillStyle: string | CanvasGradient = '#000';
  strokeStyle: string = '#000';
  lineWidth: number = 1;
  font: string = '10px sans-serif';
  textAlign: 'left' | 'center' | 'right' = 'left';
  textBaseline: 'alphabetic' | 'top' | 'middle' | 'bottom' = 'alphabetic';

  clearRect(x: number, y: number, w: number, h: number): void { /* fill with transparent */ }
  fillRect(x: number, y: number, w: number, h: number): void { /* solid fill */ }
  strokeRect(x: number, y: number, w: number, h: number): void { /* outline */ }
  beginPath(): void { this._path = []; }
  moveTo(x: number, y: number): void { /* ... */ }
  lineTo(x: number, y: number): void { /* ... */ }
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void { /* ... */ }
  closePath(): void { /* ... */ }
  fill(): void { /* rasterize _path with fillStyle */ }
  stroke(): void { /* rasterize _path with strokeStyle */ }
  fillText(text: string, x: number, y: number, maxWidth?: number): void { /* blit glyph run */ }
  measureText(text: string): TextMetrics { /* proportional width */ }
  save(): void { this._stack.push(this._state()); }
  restore(): void { const s = this._stack.pop(); if (s) this._applyState(s); }
}
```

**Tier 2 (stretch — Chart.js gradients, transforms):**
- `createLinearGradient`, `createRadialGradient`, `addColorStop`
- `setTransform`, `transform`, `translate`, `scale`, `rotate`
- `globalAlpha`, `globalCompositeOperation`
- Bézier curves: `bezierCurveTo`, `quadraticCurveTo`

**Tier 3 (advanced):**
- `getImageData`, `putImageData`, `createImageData`
- `drawImage` from `<img>` element or another `<canvas>`
- `clip()`, `isPointInPath()`
- `createPattern`

**Effort:** Tier 1 = 2 weeks; Tier 2 = 1 week; Tier 3 = 1 week.

---

### 3.3 `<canvas>` Compositing

**Files:** `src/os/apps/browser/index.ts`

Each `<canvas>` element needs its own off-screen pixel buffer. BrowserApp maintains
a `Map<VElement, Canvas>` keyed by canvas VElement.

```typescript
private _canvasBuffers = new Map<VElement, Canvas>();

_getOrCreateBuffer(el: VElement): Canvas {
  let c = this._canvasBuffers.get(el);
  if (!c) {
    c = new Canvas(parseInt(el.getAttribute('width') ?? '300'),
                   parseInt(el.getAttribute('height') ?? '150'));
    this._canvasBuffers.set(el, c);
  }
  return c;
}
```

During compositing, draw each canvas buffer at the element's `_renderedRect`
position onto the main viewport buffer (requires Phase 3.1 for position).

**Effort:** 1 week.

---

### 3.4 CSS Transitions

**Files:** `src/os/apps/browser/index.ts`, new `src/os/apps/browser/css-transition.ts`

```typescript
interface TransitionState {
  el: VElement;
  property: string;
  from: number;
  to: number;
  duration: number;   // ms
  easing: EasingFn;
  startTime: number;  // performance.now()
}

// index.ts tick():
_tickTransitions(now: number): void {
  for (const t of this._transitions) {
    const progress = Math.min(1, (now - t.startTime) / t.duration);
    const value = t.from + (t.to - t.from) * t.easing(progress);
    t.el.style.setProperty(t.property, value + 'px');
    if (progress >= 1) this._transitions.delete(t);
  }
}
```

Set `_dirty = true` whenever any transition is active, so the frame loop rerenders.

**Effort:** 1 week.

---

### 3.5 Variable-Width Fonts

**Files:** `src/os/apps/browser/index.ts`, `src/os/ui/terminal.ts`

The current 8×8 bitmap font cannot render proportional text. Options:

**Option A (fast):** Pre-render glyph widths for the existing bitmap font. Create
a scaled bitmap at 16×16 for headings. Uses existing glyph data.

**Option B (full):** Load a PSF2 or BDF bitmap font from the VFS at startup.
BDF files contain per-glyph advance widths and bitmaps.

Implementation:
```typescript
interface Glyph { bitmap: Uint8Array; width: number; height: number; advance: number; bearingX: number; }
class BitmapFont {
  glyphs = new Map<number, Glyph>(); // codePoint → Glyph
  measureText(text: string): number { /* sum advance widths */ }
  renderGlyph(cp: number, canvas: Canvas, x: number, y: number): void { /* blit glyph bitmap */ }
}
```

**Effort:** 1 week (Option A) or 2 weeks (Option B with BDF loader).

---

### Phase 3 Summary

| Item | Description | Effort |
|---|---|---|
| 3.1 | CSS box model (Tier 1+2: block, flex) | 3 weeks |
| 3.2 | Canvas 2D API (Tier 1+2) | 3 weeks |
| 3.3 | `<canvas>` compositing | 1 week |
| 3.4 | CSS transitions | 1 week |
| 3.5 | Variable-width fonts | 1–2 weeks |
| **Total** | | **~10 weeks** |

**Checkpoints:**
- After 3.1: Bootstrap 5 layout renders columns correctly. `getBoundingClientRect`
  returns real values. Floating UI dropdowns appear in correct position.
- After 3.2: Chart.js line chart renders.
- After full Phase 3: A compiled React 18 + React-DOM SPA runs at a smooth framerate
  with correct visual layout.

---

## Phase 4 — QuickJS Bytecode → x86 JIT

> **Goal:** Page JavaScript executes 5–20× faster on hot functions.
> Fibonacci benchmark >10× speedup. React reconciler measurably faster.
> **Target:** ~8 weeks after Phase 1 is stable.

This phase implements a true JIT compiler for the JavaScript code running inside
QuickJS. It is entirely separate from the existing int32 JIT (which is used for
OS-level hot loops like pixel blitting). The two JIT systems share the same pool
allocator and `_Emit` infrastructure.

---

### Architecture Overview

```
Page JS source
      │
      ▼ (at page load, one time)
QuickJS bytecode (JSFunctionBytecode)
      │
      │ interpreted by QuickJS for first N calls
      │
      ▼ (after JIT_THRESHOLD calls of a function)
JIT hook fires (js_jit_hook_t, registered in JS_SetJITHook)
      │
      ▼
QJSBytecodeReader  ──reads bytecode + constant pool from memory
      │
      ▼
Type speculation check  ──all args/locals observed as JS_TAG_INT?
      │ yes                             │ no (mixed types)
      ▼                                 ▼
QJSJITCompiler.compile()         remain in interpreter
      │
      ├── emitPrologue (cdecl frame setup)
      ├── emitTypeGuards (check each arg tag == JS_TAG_INT)
      │                  ──if mismatch: jmp deopt_stub
      ├── for each opcode:
      │     emitOpcode() ──int32 arithmetic ops → x86 ALU
      │     (unknown op → emitDeopt())
      └── emitEpilogue (return value on stack)
      │
      ▼
native code ptr stored in compiled Map
      │
      ▼ (next call to this function)
JIT hook calls kernel.jitCallI8(nativePtr, stackPtr, argc, ...)
      │
      ▼ (if DEOPT_SENTINEL returned)
blacklist function, fall back to interpreter permanently
```

---

### 4.1 QuickJS Hook Point

**File to modify (C):** `/opt/quickjs/quickjs.c` in WSL

This is the **only C code change in Phase 4**. It follows the C Code Rule: it is
a pure callback registration and invocation primitive. No scheduling logic in C.

```c
/* Add to JSRuntime struct: */
typedef int (*js_jit_hook_t)(JSContext *ctx,
                              JSFunctionBytecode *b,
                              JSValue *sp,
                              int argc);
js_jit_hook_t  jit_hook;
void          *jit_hook_opaque;

/* New public API: */
void JS_SetJITHook(JSRuntime *rt, js_jit_hook_t hook, void *opaque);

/* In JS_CallInternal() inner loop, at function dispatch: */
if (rt->jit_hook && b->call_count > JIT_THRESHOLD) {
    int r = rt->jit_hook(ctx, b, sp, argc);
    if (r == 0) return sp[-1]; /* JIT handled it — result already on stack */
    /* r != 0: deopt or cold — fall through to interpreter */
}
```

**`quickjs_binding.c` additions:**
- `js_set_jit_hook(ctx, argc, argv)` — TypeScript calls this to install the TS dispatcher
- The dispatcher receives `(bytecodePtr, stackPtr, argc)` and returns `0` (JIT ran)
  or `1` (deopt — let interpreter handle this call)

The `JIT_THRESHOLD` constant starts at 100 (profile first, compile later).

**Effort:** 2 days.

---

### 4.2 `kernel.readPhysMem` Primitive

**Files:** `src/kernel/quickjs_binding.c`, `src/os/core/kernel.ts`

The QJS bytecode reader needs to inspect `JSFunctionBytecode` structs in memory.

**C addition to `quickjs_binding.c`:**
```c
static JSValue js_read_phys_mem(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    uint32_t ptr, length;
    JS_ToUint32(ctx, &ptr,    argv[0]);
    JS_ToUint32(ctx, &length, argv[1]);
    // Allocate a JS ArrayBuffer and memcpy `length` bytes from physical address `ptr`
    uint8_t *buf = js_malloc(ctx, length);
    memcpy(buf, (void*)(uintptr_t)ptr, length);
    return JS_NewArrayBuffer(ctx, buf, length, js_free_arraybuffer, NULL, 0);
}
```

**TypeScript kernel.ts addition:**
```typescript
readPhysMem(ptr: number, length: number): ArrayBuffer { /* calls js_read_phys_mem */ }
```

This is the only additional C primitive needed for Phase 4 beyond 4.1.

**Effort:** 1 day.

---

### 4.3 QuickJS Opcode Audit

**Research — no code changes.** Categorise all QuickJS opcodes into three priorities.

**Priority 1 — JIT immediately (cover ~80% of hot SPA code):**

| Opcode | Operation |
|---|---|
| `OP_push_i32` | Push integer constant |
| `OP_push_const` | Push constant pool entry |
| `OP_get_loc` | Load local variable |
| `OP_put_loc` | Store local variable |
| `OP_get_arg` | Load function argument |
| `OP_put_arg` | Store function argument |
| `OP_add` | Integer / string add (guarded to int) |
| `OP_sub` | Subtract |
| `OP_mul` | Multiply |
| `OP_div` | Divide |
| `OP_mod` | Modulo |
| `OP_neg` | Negate |
| `OP_shl` / `OP_shr` / `OP_sar` | Bit shifts |
| `OP_and` / `OP_or` / `OP_xor` | Bitwise |
| `OP_not` | Bitwise NOT |
| `OP_lt` / `OP_lte` / `OP_gt` / `OP_gte` / `OP_eq` / `OP_neq` | Comparisons |
| `OP_if_true` / `OP_if_false` | Conditional branches |
| `OP_goto` | Unconditional branch |
| `OP_return` / `OP_return_undef` | Function return |
| `OP_nop` | No operation |
| `OP_drop` | Discard top of stack |
| `OP_dup` | Duplicate top of stack |
| `OP_swap` | Swap top two stack values |

**Priority 2 — JIT in Phase 4b (typed array access — critical for React reconciler):**

| Opcode | Operation |
|---|---|
| `OP_get_field2` | Object property read |
| `OP_put_field` | Object property write |
| `OP_array_from` | `Array.from()` typed array shorthand |
| `OP_typeof` | `typeof` operator |
| `OP_instanceof` | `instanceof` check |
| `OP_in` | `in` operator |
| `OP_call` | Function call (with inline cache) |
| `OP_call_method` | Method call |
| `OP_define_field` | Object literal property define |

**Priority 3 — Interpreter-only (too complex or too rare to JIT):**

- `OP_await`, `OP_yield` — async / generator state machines
- `OP_regexp` — regex compilation
- `OP_with_loc` — `with` statement
- `OP_eval` — nested `eval`
- `OP_import*` — dynamic imports
- `OP_closure` — closure creation (complex environment linking)

**Effort:** 2 days (research + tabulation).

---

### 4.4 Type Speculation System

**Files:** `src/os/process/qjs-jit.ts` (new)

QuickJS `JSValue` layout on i686 (8 bytes):
```c
typedef struct {
    int32_t tag;           // JS_TAG_INT=1, JS_TAG_FLOAT64=7, JS_TAG_OBJECT=-1, ...
    union {
        int32_t int32;
        struct { int32_t lo; int32_t hi; } float64;  // little-endian
        void *ptr;
    } u;
} JSValue;                 // 8 bytes total on i686
```

**Observation side-table:**
```typescript
interface TagObservation { tag: number; count: number; totalCalls: number; }
const specTable = new Map<number, TagObservation[]>(); // bytecodePtr → [arg0, arg1, ...]
```

**Policy (conservative start):**
- Only JIT functions where ALL observed args AND ALL local slots have been
  `JS_TAG_INT` for the last N=8 consecutive calls
- Promote to JIT at `call_count > JIT_THRESHOLD` AND speculation is confident
- Track via a pre-threshold hook (lighter weight) before compilation

**Type guard emission:**
```typescript
function emitTypeGuard(emit: _Emit, stackReg: number, slotOffset: number,
                        expectedTag: number, deoptLabel: Label): void {
  emit.movEAX_mem(stackReg + slotOffset);  // load JSValue.tag word
  emit.cmpEAX_imm32(expectedTag);
  emit.jne(deoptLabel);                    // type mismatch → deopt
}
```

**Deoptimisation:**
- Each compiled function has a `deopt_stub` at the start
- If any type guard fails: increment deopt counter, return `DEOPT_SENTINEL`
- After 3 deopt events for same function: permanently blacklist (add to `Set`)

**Effort:** 1 week.

---

### 4.5 `qjs-jit.ts` — Bytecode Compiler

**New file:** `src/os/process/qjs-jit.ts`

This module is the heart of Phase 4. It extends the existing `jit.ts` infrastructure.

```typescript
import { JIT, _Emit } from './jit.js';
import { kernel } from '../core/kernel.js';

/** Reads a QuickJS JSFunctionBytecode struct fields from memory. */
class QJSBytecodeReader {
  private _buf: DataView;

  constructor(ptr: number) {
    const raw = kernel.readPhysMem(ptr, 256);  // read enough header bytes
    this._buf = new DataView(raw);
  }

  // Offsets from JSFunctionBytecode struct — determined via sizeof() in C at boot
  get bytecodePtr(): number  { return this._buf.getUint32(BYTECODE_PTR_OFFSET, true); }
  get bytecodeLen(): number  { return this._buf.getUint32(BYTECODE_LEN_OFFSET, true); }
  get localCount():  number  { return this._buf.getUint16(LOCAL_COUNT_OFFSET, true); }
  get argCount():    number  { return this._buf.getUint16(ARG_COUNT_OFFSET, true); }
  get constCount():  number  { return this._buf.getUint32(CONST_COUNT_OFFSET, true); }

  get opcodes(): Uint8Array {
    return new Uint8Array(kernel.readPhysMem(this.bytecodePtr, this.bytecodeLen));
  }
}

/** Compiles one QuickJS bytecode function to x86-32 native code. */
class QJSJITCompiler {
  private _emit: _Emit;
  private _labels = new Map<number, number>(); // bytecode offset → code offset
  private _patches: Array<{ codeOff: number; bcTarget: number }> = [];

  constructor() { this._emit = new _Emit(); }

  compile(reader: QJSBytecodeReader): number {  // returns native code ptr
    this._emitPrologue(reader.argCount, reader.localCount);
    this._emitTypeGuards(reader.argCount);

    const ops = reader.opcodes;
    let i = 0;
    while (i < ops.length) {
      this._labels.set(i, this._emit.offset);
      const op = ops[i++];
      i = this._emitOpcode(op, ops, i, reader);
    }

    this._applyPatches();
    return this._emit.link();  // jitAlloc + jitWrite → returns native ptr
  }

  private _emitOpcode(op: number, ops: Uint8Array, i: number, r: QJSBytecodeReader): number {
    switch (op) {
      case OP_push_i32: {
        const v = (ops[i]|(ops[i+1]<<8)|(ops[i+2]<<16)|(ops[i+3]<<24));
        this._emit.pushImm32(v);
        return i + 4;
      }
      case OP_get_loc: {
        const idx = ops[i++];
        this._emit.movEAX_EBP(-8 - idx * 8);    // local slot (JSValue, 8 bytes each)
        this._emit.push_eax();
        return i;
      }
      case OP_put_loc: {
        const idx = ops[i++];
        this._emit.pop_eax();
        this._emit.movEBP_EAX(-8 - idx * 8);
        return i;
      }
      case OP_add: {
        this._emit.pop_ecx();
        this._emit.pop_eax();
        this._emit.addEAX_ECX();
        this._emit.push_eax();
        return i;
      }
      case OP_sub: { this._emit.pop_ecx(); this._emit.pop_eax(); this._emit.subEAX_ECX(); this._emit.push_eax(); return i; }
      case OP_mul: { this._emit.pop_ecx(); this._emit.pop_eax(); this._emit.imulEAX_ECX(); this._emit.push_eax(); return i; }
      case OP_lt:  { this._emitCmp(0x9C /* setl */); return i; }  // signed less-than
      case OP_lte: { this._emitCmp(0x9E /* setle */); return i; }
      case OP_gt:  { this._emitCmp(0x9F /* setg */); return i; }
      case OP_gte: { this._emitCmp(0x9D /* setge */); return i; }
      case OP_eq:  { this._emitCmp(0x94 /* sete */); return i; }
      case OP_neq: { this._emitCmp(0x95 /* setne */); return i; }
      case OP_if_false: {
        const target = ops[i] | (ops[i+1] << 8);  // relative offset
        this._emit.pop_eax();
        this._emit.testEAX_EAX();
        this._patches.push({ codeOff: this._emit.offset + 2, bcTarget: i + 2 + target });
        this._emit.jz_rel32(0);  // patched later
        return i + 2;
      }
      case OP_goto: {
        const target = ops[i] | (ops[i+1] << 8);
        this._patches.push({ codeOff: this._emit.offset + 1, bcTarget: i + 2 + target });
        this._emit.jmp_rel32(0);
        return i + 2;
      }
      case OP_return: {
        this._emit.pop_eax();
        this._emit.emitEpilogue();
        return i;
      }
      case OP_drop: { this._emit.pop_eax(); return i; }
      case OP_dup:  { this._emit.peek_push(); return i; }
      default:
        this._emitDeopt();
        return ops.length;  // stop compilation — rest goes to interpreter
    }
  }
}

/** Hook registered with JS_SetJITHook — dispatches to compiled code. */
export class QJSJITHook {
  private _compiled  = new Map<number, number>();   // bytecodePtr → nativePtr
  private _counters  = new Map<number, number>();   // bytecodePtr → call count
  private _blacklist = new Set<number>();
  private _deopts    = new Map<number, number>();   // bytecodePtr → deopt count

  handle(bytecodePtr: number, stackPtr: number, argc: number): 0 | 1 {
    if (this._blacklist.has(bytecodePtr)) return 1;

    const count = (this._counters.get(bytecodePtr) ?? 0) + 1;
    this._counters.set(bytecodePtr, count);
    if (count < JIT_THRESHOLD) return 1;  // warming up — stay in interpreter

    let native = this._compiled.get(bytecodePtr);
    if (!native) {
      try {
        const reader   = new QJSBytecodeReader(bytecodePtr);
        native         = new QJSJITCompiler().compile(reader);
        this._compiled.set(bytecodePtr, native);
      } catch {
        this._blacklist.add(bytecodePtr);
        return 1;
      }
    }

    const result = kernel.jitCallI8(native, stackPtr, argc, 0, 0, 0, 0, 0);
    if (result === DEOPT_SENTINEL) {
      const d = (this._deopts.get(bytecodePtr) ?? 0) + 1;
      this._deopts.set(bytecodePtr, d);
      this._compiled.delete(bytecodePtr);
      if (d >= 3) this._blacklist.add(bytecodePtr);
      return 1;
    }
    return 0;
  }
}
```

**Effort:** 2 weeks.

---

### 4.6 Inline Caches for Property Access

Property access (`obj.foo`) is the dominant operation in React reconciliation and
Vue reactivity. Without inline caches, every `OP_get_field` does a full hash-table
lookup in QuickJS's shape system. Inline caches bring this to ~3 cycles per access.

**Monomorphic IC (Phase 4b):**

```
; Generated JIT code for obj.foo:
  mov eax, [esp]              ; peek object ptr (JSValue.u.ptr)
  mov ecx, [eax + SHAPE_OFF]  ; load current shape pointer
  cmp ecx, EXPECTED_SHAPE     ; shape check  ← patched at runtime
  jne slow_path               ; shape miss → deopt
  mov eax, [eax + PROP_OFF]   ; fast property load ← offset patched at runtime
  jmp done
slow_path:
  call qjs_get_field_slow     ; full interpreter lookup
  ; update EXPECTED_SHAPE and PROP_OFF by writing into JIT pool
done:
```

The JIT pool is `PROT_READ|PROT_WRITE|PROT_EXEC` — already set up in `jit.c`.
Patching is done by writing 4 bytes to the code location via `kernel.jitWrite`.

**Polymorphic IC (Phase 4c, stretch):**
- Chain up to 4 monomorphic guards
- Fall through to megamorphic slow path after 4 shapes seen

**Megamorphic:**
- >4 shapes → patch a permanent `jmp slow_path` — no further IC attempts

**Effort:** 1 week (monomorphic). Polymorphic: +0.5 weeks.

---

### 4.7 Float64 JIT Paths (x87 FPU)

Most SPA JS uses floating-point: `Date.now()` deltas, animation lerp values,
layout coordinates. The initial int32-only JIT falls back to interpreter for these.

**Approach:** Extend `_Emit` with x87 FPU opcodes.

```typescript
// In jit.ts _Emit:
fldl_m64(addr: number)  { this._w8(0xDD); this._w8(0x05); this._w32(addr); } // FLD QWORD [addr]
fstpl_m64(addr: number) { this._w8(0xDD); this._w8(0x1D); this._w32(addr); } // FSTP QWORD [addr]
fldl_esp()              { this._w8(0xDD); this._w8(0x04); this._w8(0x24); } // FLD QWORD [esp]
fstpl_esp()             { this._w8(0xDD); this._w8(0x1C); this._w8(0x24); } // FSTP QWORD [esp]
faddp()                 { this._w8(0xDE); this._w8(0xC1); }                 // FADDP st(1), st
fsubp()                 { this._w8(0xDE); this._w8(0xE9); }
fmulp()                 { this._w8(0xDE); this._w8(0xC9); }
fdivp()                 { this._w8(0xDE); this._w8(0xF9); }
fldz()                  { this._w8(0xD9); this._w8(0xEE); }                 // push +0.0
fld1()                  { this._w8(0xD9); this._w8(0xE8); }                 // push +1.0
```

Float paths are only activated when type speculation observes `JS_TAG_FLOAT64`
consistently across N calls. Integer paths still use existing ALU emit ops.
Mixed int/float functions fall back to the interpreter — no attempt to unify.

**Effort:** 1 week.

---

### 4.8 JIT Pool Expansion + LRU Eviction

**Files:** `src/kernel/jit.c`, `src/kernel/linker.ld`

Current pool: 256 KB (BSS). A JIT-compiled SPA page can have 500+ hot functions
at ~512 bytes each = 256 KB consumed immediately.

**Phase 4a:** Expand pool from `256*1024` to `2*1024*1024` (2 MB):
```c
// jit.c:
#define JIT_POOL_SIZE (2 * 1024 * 1024)
static uint8_t jit_pool[JIT_POOL_SIZE] __attribute__((aligned(4096)));
```

Verify `.bss` section in `linker.ld` has room (BSS is zero-cost at rest).

**Phase 4b — LRU Eviction:**
When pool is full, evict the compiled function with the oldest `last_called`
timestamp. Requires a fixed-size entry table alongside the code pool:
```c
typedef struct {
  uint32_t code_ptr;     // offset into jit_pool
  uint32_t code_size;
  uint32_t last_called;  // tick counter
  uint32_t bc_ptr;       // key for TypeScript side map invalidation
} JITEntry;

static JITEntry jit_entries[MAX_JIT_ENTRIES]; // MAX_JIT_ENTRIES = 1024
```

Eviction signals TypeScript via a new `js_jit_evict_callback` to remove the
entry from `QJSJITHook._compiled`.

**Effort:** Pool expansion = 0.5 days. LRU eviction = 1 week.

---

### 4.9 Dependency Order

```
4.2 readPhysMem         (C — 1 day)
      │
      ├──► 4.3 Opcode audit       (research — 2 days)
      │           │
      │           ▼
      ├──► 4.1 QuickJS hook point (C — 2 days)
      │           │
      │           ├──► 4.4 Type speculation   (TS — 1 week)
      │           │           │
      │           │           ▼
      │           │    4.5 qjs-jit.ts         (TS — 2 weeks)
      │           │           │
      │           │           ├──► 4.6 Inline caches (TS — 1 week)
      │           │           │
      │           │           └──► 4.7 Float64 paths (TS — 1 week)
      │           │
      │           └──► 4.8 Pool expansion      (C — 0.5 days → 1 week)
      │
      └──► Phase 1 complete (prerequisite)
```

**Minimum Viable Phase 4:** Items 4.1 + 4.2 + 4.3 + 4.4 + 4.5 (int32 only, no ICs,
no float). Enough to show JIT speedup on arithmetic benchmarks. ~4 weeks of work.

**Full Phase 4** (ICs + float): adds ~3 more weeks.

---

### Phase 4 Summary

| Item | Description | Effort |
|---|---|---|
| 4.1 | QuickJS hook point (only C change) | 2 days |
| 4.2 | `kernel.readPhysMem` primitive | 1 day |
| 4.3 | Opcode audit (Priority 1/2/3) | 2 days |
| 4.4 | Type speculation system | 1 week |
| 4.5 | `qjs-jit.ts` bytecode compiler (int32) | 2 weeks |
| 4.6 | Inline caches (monomorphic + polymorphic) | 1.5 weeks |
| 4.7 | Float64 via x87 FPU | 1 week |
| 4.8 | Pool expansion (2 MB) + LRU eviction | 1.5 weeks |
| **Total** | | **~8 weeks** |

**Checkpoints:**
- After 4.5 (int32 MVP): Fibonacci benchmark >10× speedup over interpreter
- After 4.6 (ICs): React reconciler property access measurably faster
- After 4.7 (float64): Animation lerp values, `Date.now()` deltas JIT-compiled
- After 4.8 (pool eviction): SPA with 1000+ functions runs without pool exhaustion

---

## Summary Timeline

| Phase | Item | Description | Effort | Cumulative |
|---|---|---|---|---|
| **1** | 1.1 | Batch mutations to RAF | 1 day | 0.2w |
| **1** | 1.2 | Eliminate serialize/reparse | 2 days | 0.6w |
| **1** | 1.3 | addEventListener capture phase | 2 days | 1.0w |
| **1** | 1.4 | queueMicrotask correct ordering | 1 day | 1.2w |
| **1** | 1.5 | MessageChannel / MessagePort | 1 day | 1.4w |
| **1** | 1.6 | MutationObserver functional | 3 days | 2.0w |
| **1** | 1.7 | window.innerWidth / innerHeight | 0.5 days | 2.1w |
| **1** | 1.8 | document.readyState / activeElement | 0.5 days | 2.2w |
| **1** | 1.9 | isConnected / contains / dataset | 0.5 days | 2.3w |
| **1** | 1.10 | O(1) DOM lookups (linked-list + ID index) | 2 days | 2.7w |
| **1** | 1.11 | VClassList caching | 0.5 days | 2.8w |
| **1** | 1.12 | getBoundingClientRect skeleton | 1 day | 3.0w |
| **1** | 1.13 | TextEncoder / TextDecoder | 1 day | 3.2w |
| **1** | 1.14 | structuredClone | 1 day | 3.4w |
| **1** | 1.15 | localStorage VFS-backed | 2 days | 3.8w |
| **1** | 1.16 | fetch() improvements | 1 week | 4.8w |
| **2** | 2.1 | JIT image blit | 2 days | 5.2w |
| **2** | 2.2 | Scroll blit | 3 days | 5.8w |
| **2** | 2.3 | Incremental layout (dirty subtree) | 1 week | 6.8w |
| **2** | 2.4 | Damage rectangles | 1 week | 7.8w |
| **2** | 2.5 | JIT line rasterizer | 2 weeks | 9.8w |
| **3** | 3.1 | CSS box model (Tier 1+2) | 3 weeks | 12.8w |
| **3** | 3.2 | Canvas 2D API (Tier 1+2) | 3 weeks | 15.8w |
| **3** | 3.3 | `<canvas>` compositing | 1 week | 16.8w |
| **3** | 3.4 | CSS transitions | 1 week | 17.8w |
| **3** | 3.5 | Variable-width fonts | 1 week | 18.8w |
| **4** | 4.1 | QuickJS hook point (C) | 2 days | 19.2w |
| **4** | 4.2 | readPhysMem kernel primitive | 1 day | 19.4w |
| **4** | 4.3 | Opcode audit | 2 days | 19.8w |
| **4** | 4.4 | Type speculation system | 1 week | 20.8w |
| **4** | 4.5 | qjs-jit.ts bytecode compiler | 2 weeks | 22.8w |
| **4** | 4.6 | Inline caches | 1.5 weeks | 24.3w |
| **4** | 4.7 | Float64 via x87 FPU | 1 week | 25.3w |
| **4** | 4.8 | Pool expansion + LRU eviction | 1.5 weeks | 26.8w |

**Total: ~27 weeks** (with some Phase 2 overlapping Phase 1, and Phase 4 starting
after Phase 1 milestones are stable).

---

## Checkpoint SPAs

| Milestone | Target SPA | What Must Work |
|---|---|---|
| After Phase 1 (items 1.1–1.6) | **TodoMVC React 18** | Hooks, state, effects, event delegation, MessageChannel scheduler |
| After Phase 1 (items 1.6–1.8) | **Vue 3 TodoMVC** | Reactivity, nextTick, MutationObserver signal |
| After Phase 1 complete | **Zustand + Vite counter** | structuredClone, queueMicrotask ordering, rAF 60 fps |
| After Phase 2 (2.1–2.2) | React `setState` loop | 60 fps rendering (was ~5 fps) |
| After Phase 2 (2.2) | Image-heavy page | Scroll without tearing |
| After Phase 3.1 | **Bootstrap 5 page** | Column layout renders correctly |
| After Phase 3.1 + 1.12 real values | **Floating UI dropdown** | Popover appears at correct position |
| After Phase 3.2 | **Chart.js line chart** | Canvas 2D renders data |
| After full Phase 3 | **React + React-DOM SPA** | Correct visual layout at smooth framerate |
| After Phase 4.5 (int32 MVP JIT) | Fibonacci benchmark | >10× speedup over interpreter |
| After Phase 4.6 (ICs) | React reconciler | Measurable speedup on property-access workloads |
| After Phase 4.7 (float64) | Animation benchmark | `requestAnimationFrame` lerp JIT-compiled |
| After Phase 4.8 (pool eviction) | Large SPA (1000+ fns) | No pool exhaustion after extended use |

---

## What Stays Out of Scope

The following items from the JSOS backlog are **not included in this plan** because
they are not required for browser/SPA functionality:

- `os.time` — system clock / NTP sync
- `os.audio` — audio driver / Web Audio API
- `os.video` — video decoder
- `os.usb` — USB device support
- Package management / AppStore
- Multi-user / login system
- Process isolation / memory protection between processes
- Network services (DNS server, DHCP server, SSH daemon)
- ARM / RISC-V port

These are valid future items but tracked separately.
