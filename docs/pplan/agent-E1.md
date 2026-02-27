# Agent E1 — Browser JS Runtime / DOM API

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

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

## Already Marked — Skip These

Sections §13–14 have many already-`✓` items. Read `1000-things.md` lines 570–645
first to identify the exact gaps before searching source files.

---

## Tips

- `jsruntime.ts` is very large. Use `grep_search` first to locate class/function
  names, then `read_file` around those lines.
- Look for `window.__` and `globalThis.__` registrations.
- Workers are in `workers.ts` — check `postMessage`, `onmessage`, `terminate`.
