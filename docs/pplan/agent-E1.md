# Agent E1 — Browser JS Runtime / DOM API

**STATUS: COMPLETE ✓** — Audited 2026-03-02.  
Result: 3 new ✓ items (537, 539, 547). All unconfirmed items in §13–14 are NOT implemented.  
New NOT items recorded in `state.md`.

**One-shot agent. Read source files and directly mark all implemented items in `docs/1000-things.md`.**

## Your Job

1. Read each source file listed below.
2. For every item in your assigned sections (§13–14 — items 497–592), determine whether it is implemented.
3. Use `multi_replace_string_in_file` to edit `docs/1000-things.md` directly — mark each implemented item with `✓` and append a short evidence note.
4. Do **not** return JSON. Do **not** wait for a coordinator. Just implement all the markings and stop.

### Mark format

```
Before: 510. [P0] Browser: window.location.href ...
After:  510. [P0 ✓] Browser: window.location.href ... — LocationObject in jsruntime.ts line 234
```

Only mark items you are **confident** are implemented (you found the code). Skip items you cannot confirm.  
Items already marked `✓` — leave them alone.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §13 Browser JS Runtime | 497–552 |
| §14 Browser DOM API | 553–592 |

---

## Source Files to Read

```
src/os/apps/browser/jsruntime.ts   ← very large (~3800 lines); read in 200-line chunks
src/os/apps/browser/dom.ts         ← large (~2000 lines)
src/os/apps/browser/workers.ts
src/os/apps/browser/perf.ts        ← performance.now, rAF, rIC
src/os/apps/browser/cache.ts       ← localStorage, sessionStorage, Cache API
```

---

## Focus Areas

**Window / Global APIs (§13):**
- `window.location` — href, hostname, pathname, search, hash, origin; `assign()`, `replace()`, `reload()`
- `window.history` — `pushState`, `replaceState`, `back()`, `forward()`, `go()`, `state`
- `localStorage` / `sessionStorage` — `getItem`, `setItem`, `removeItem`, `clear()`, `key()`, `length`
- `IndexedDB` — `open`, `transaction`, `objectStore`, `get/put/delete/getAll`, cursor, index
- `Fetch` / `Headers` / `Request` / `Response` — full Web Fetch API
- `AbortController` / `AbortSignal`
- `URL` constructor, `URLSearchParams`
- `Blob` / `File` / `FileReader`
- `FormData`
- `WebSocket` — full state machine (CONNECTING/OPEN/CLOSING/CLOSED)
- `Notification` API
- `BroadcastChannel`
- `MessageChannel` / `MessagePort`

**Browser Timers & Async:**
- `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`
- `requestAnimationFrame` / `cancelAnimationFrame`
- `requestIdleCallback` / `cancelIdleCallback`
- `queueMicrotask`
- `Promise.all`, `Promise.race`, `Promise.allSettled`, `Promise.any`
- `MutationObserver` — `observe()`, `disconnect()`, `takeRecords()`
- `IntersectionObserver`
- `ResizeObserver`
- `WeakRef` / `FinalizationRegistry`
- Dynamic `import()`
- `type="module"` script loading

**DOM API (§14):**
- `document.createElement`, `createTextNode`, `createDocumentFragment`, `createComment`
- `appendChild`, `insertBefore`, `replaceChild`, `removeChild`, `cloneNode`
- `querySelector`, `querySelectorAll`, `getElementById`, `getElementsByClassName`,
  `getElementsByTagName`
- `element.setAttribute`, `getAttribute`, `removeAttribute`, `hasAttribute`
- `element.classList` — `add`, `remove`, `toggle`, `contains`, `replace`
- `element.dataset`
- `element.innerHTML`, `outerHTML`, `textContent`, `innerText`
- `element.style` — inline CSS via CSSStyleDeclaration
- All event types: `Keyboard`, `Mouse`, `Input`, `Focus`, `Submit`, `Wheel`,
  `Touch`, `Pointer`, `Drag`, `Clipboard`, `Custom`
- `addEventListener`, `removeEventListener`, `dispatchEvent`
- Event bubbling / capturing / `stopPropagation` / `preventDefault`
- `DOMContentLoaded`, `document.readyState`
- `Range` / `Selection`
- `DocumentFragment`
- Shadow DOM (`attachShadow`, `shadowRoot`)
- CSSOM: `getComputedStyle`, `element.getBoundingClientRect`, `element.offsetWidth/Height`

---

## Already Confirmed

Sections §13–14 already have many `✓` items in `docs/1000-things.md`. Read lines 570–645 of that file first to identify the gaps, then search source files for those specific items.

## Tips

- `jsruntime.ts` is very large. Use `grep_search` first to locate class/function
  names, then `read_file` around those lines.
- Look for `window.__` and `globalThis.__` registrations.
- Workers are in `workers.ts` — check `postMessage`, `onmessage`, `terminate`.
