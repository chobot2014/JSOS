# JSOS Browser: Make Every Website Work

## Philosophy

**Zero site-specific hacks.** A proper browser renders any valid HTML/CSS correctly because it implements the specs, not because it has profiles for popular sites.

---

## What to Delete First

| Item | File | Lines | Why |
|------|------|-------|-----|
| `_siteProfiles` array | jit-browser.ts L523-571 | Google/HN/GitHub profiles | Site-specific optimization hacks |
| `getSiteProfile()` caller | jsruntime.ts L6188-6196 | Profile application code | Applies per-site mutation batching |
| `_detectSPAFramework()` | jit-browser.ts L259-319 | Framework fingerprinting | Dead code — detects but applies nothing |
| Entire `compat-polyfills.ts` | compat-polyfills.ts | 248 lines | All duplicate stubs that CONFLICT with jsruntime.ts real impls (`getComputedStyle`, `MutationObserver`, `ResizeObserver`, `matchMedia`, `CSS.supports` all have real implementations that these stubs overwrite/conflict with) |
| Entire `framework-polyfills.ts` | framework-polyfills.ts | 263 lines | Fake `XMLHttpRequest`, fake `process` object, no-op `WebAssembly` — every one either conflicts with the real impl or creates wrong behavior |
| Hardcoded start URL | index.ts L234 | `news.ycombinator.com` | Replace with `about:blank` or a settings-driven homepage |
| Chrome UA spoofing | jsruntime.ts L409-497 | Fake Chrome 120 identity | Should identify as JSOS. Sites that UA-sniff will serve generic HTML which we actually need |

---

## Architecture Fixes (do alongside Tier 1-2)

### A.1 — Unify CSS matching

`stylesheet.ts/matchesSingleSel` (rightmost-only) and `dom.ts/_matchSel` (full combinators) must converge. Either: (a) pass VElement to `computeElementStyle` and use `_matchSel`, or (b) lift `_matchCombinator` logic into `matchesSingleSel` with parent chain. Option (a) requires refactoring `computeElementStyle` signature to take a VElement instead of `(tag, id, cls, attrs)`.

### A.2 — Remove polyfill conflict files

Delete `compat-polyfills.ts` and `framework-polyfills.ts`. Every API they stub already has a real (or better) implementation in jsruntime.ts. The polyfills actively break things by overwriting real impls with weaker stubs.

### A.3 — Two-pass architecture: layout → DOM position writeback

Add a post-layout phase that walks the layout tree and writes `{x, y, width, height}` back to each VElement. This is the single biggest structural change — it connects the layout engine to the DOM API that JavaScript reads.

---

## Tier 1 — Critical (makes pages render legibly)

| # | Task | File(s) | What to Do | Impact |
|---|------|---------|-----------|--------|
| **1.1** | **Connect font.ts to render.ts** | render.ts, font.ts | `TextAtlas._rasterize()` currently generates checkerboard placeholder glyphs. Replace with `BitmapFontFace.rasterize()` which already exists and renders real VGA 8×8 glyphs with anti-aliasing. Wire `FontRegistry.resolve()` into `TextAtlas.blitChar()`. | **All text becomes legible** |
| **1.2** | **Feed layout positions back to DOM** | dom.ts, html.ts, layout.ts | After layout pass, store each element's computed `{x, y, width, height}` on its VElement. `getBoundingClientRect()`, `offsetWidth`, `offsetHeight`, `clientWidth`, `clientHeight`, `scrollWidth`, `scrollHeight`, `offsetTop`, `offsetLeft` must return real values from layout. | **Every framework that queries element sizes stops breaking** (React, Vue, Popper, tooltips, dropdowns, intersection observers, drag-and-drop) |
| **1.3** | **Fix stylesheet.ts matchesSingleSel to use full combinators** | stylesheet.ts | Currently extracts only the rightmost compound selector, ignoring parent/ancestor context. Replace with a call to dom.ts `_matchSel()` — the full combinator engine already exists. Need to pass the actual VElement to `computeElementStyle` so it can use the real selector matcher. | **All CSS rules with `.parent .child`, `div > span`, `h1 + p` etc. match correctly** |
| **1.4** | **Implement flex-direction: column** | layout.ts | The row flex algorithm exists. Add column: swap width↔height axes, lay children vertically, apply cross-axis (horizontal) alignment. | **~40% of flex layouts on modern sites** |
| **1.5** | **Implement flex-wrap** | layout.ts | After computing hypothetical main sizes, check if sum > container main size. If so, start new flex line. Lay out each line independently, then stack lines in cross direction. | **Responsive flex grids (Bootstrap, Tailwind flex-wrap)** |
| **1.6** | **Implement justify-content** | layout.ts | After placing flex items, distribute remaining space: `flex-start` (default), `flex-end`, `center`, `space-between`, `space-around`, `space-evenly`. | **Flex item spacing on every modern site** |

---

## Tier 2 — High (makes pages look correct)

| # | Task | File(s) | What to Do | Impact |
|---|------|---------|-----------|--------|
| **2.1** | **Percentage-based widths** | layout.ts | When `width` is `X%`, resolve against parent's content width (after padding). Same for `height`, `min-width`, `max-width`, `min-height`, `max-height`. Already parsed by css.ts. | **Every responsive layout** |
| **2.2** | **`margin: auto` centering** | layout.ts | For block elements with explicit width: `margin-left: auto` + `margin-right: auto` → center horizontally. For flex items: `margin: auto` absorbs free space. | **Most common centering technique on the web** |
| **2.3** | **position: relative offset** | layout.ts | After normal flow layout, offset the element by `top`/`left`/`bottom`/`right`. Don't affect other elements' positions. | **Extremely common — used for minor adjustments, dropdown positioning** |
| **2.4** | **position: absolute/fixed right/bottom anchoring** | layout.ts | Currently only handles `top`/`left`. Add: if `right` is set, `x = container.width - element.width - right`. Same for `bottom`. | **Modals, fixed navbars, FABs, tooltips** |
| **2.5** | **Wire CSS custom properties into the cascade** | jsruntime.ts `getComputedStyle`, html.ts | After computing all matched rules, resolve `var(--xxx)` references using `resolveCSSVars()` from css.ts. Build a property map from ancestor chain. | **Every modern design system (Tailwind, MUI, Chakra, Radix, shadcn)** |
| **2.6** | **flex gap** | layout.ts | Parse `gap`/`row-gap`/`column-gap` (already in css.ts). Insert gap between flex items in main axis, between flex lines in cross axis. | **Modern flex layouts — `gap` replaced margins for spacing** |
| **2.7** | **min-width/max-width/min-height/max-height enforcement** | layout.ts | After computing width/height, clamp: `finalWidth = max(minWidth, min(maxWidth, computedWidth))`. | **Responsive constraints — `max-width: 1200px` for page containers** |
| **2.8** | **Support all HTTP methods** | jsruntime.ts, sdk.ts | Widen `FetchOptions.method` from `'GET' | 'POST'` to `string`. Pass through to SDK. The SDK already uses `opts.method` directly in the request line. | **REST APIs (PUT, DELETE, PATCH, HEAD, OPTIONS)** |
| **2.9** | **Redirect method demotion** | sdk.ts | For 301/302/303: change method to GET, drop body. For 307/308: preserve method and body. Set `redirected = true` on response. | **Form submissions, API redirects** |
| **2.10** | **multipart/form-data encoding** | jsruntime.ts | When `FormData` body is sent, generate proper `multipart/form-data` with boundary. Encode each field as a MIME part. Support `File`/`Blob` entries. | **File upload forms** |

---

## Tier 3 — Medium (makes SPAs and complex sites work)

| # | Task | File(s) | What to Do | Impact |
|---|------|---------|-----------|--------|
| **3.1** | **Custom Elements (`customElements.define`)** | jsruntime.ts | Replace stub with: registry of tag→class mappings, call `constructor()` on createElement, call `connectedCallback()` on appendChild, `attributeChangedCallback` on setAttribute, upgrade existing elements. | **All Web Component libraries (Lit, Shoelace, FAST, Ionic)** |
| **3.2** | **Shadow DOM** | dom.ts | `attachShadow({mode})` must create an isolated subtree. Styles inside shadow roots don't leak out, external styles don't leak in unless `:host`/`::slotted`. `<slot>` projects light DOM children into shadow tree. | **Web Components rendering** |
| **3.3** | **WebSocket implementation** | jsruntime.ts | Implement WS handshake (HTTP Upgrade with `Sec-WebSocket-Key`), 2-byte frame header parsing, mask/unmask, opcode handling (text/binary/ping/pong/close), data delivery to `onmessage`. Use existing TCP socket + TLS infrastructure. | **Chat apps, live data, collaborative editing** |
| **3.4** | **`line-height` in layout** | layout.ts | Replace fixed `LINE_H` constant with computed `line-height` from CSS. Affects vertical spacing of all inline content. | **Vertical rhythm of all text content** |
| **3.5** | **Proportional font metric support in layout** | layout.ts, font.ts | Replace `CHAR_W` constant with per-character advance widths from `FontMetrics.measureText()`. Use variable-width glyph data. | **Text no longer looks like a terminal** |
| **3.6** | **`calc()` in layout dimensions** | layout.ts, css.ts | `calc()` parsing already exists in css.ts. Wire the evaluator into layout: when a CSS length is a `calc()` expression, evaluate with the resolved context (parent width for %, font-size for em, viewport for vw/vh). | **`width: calc(100% - 2rem)` patterns everywhere** |
| **3.7** | **border-radius rendering** | render.ts | When painting box backgrounds/borders, clip corners to elliptical arcs. Pre-rasterize corner masks for common radii, composite with alpha blending. | **Rounded corners on buttons, cards, avatars — used on virtually every site** |
| **3.8** | **Image compositing in paint pass** | render.ts, html.ts | Images are decoded (PNG/JPEG/GIF/WebP decoders exist). During paint, blit decoded pixel data into the framebuffer at the element's layout position. Respect `object-fit`, `width`/`height` attributes. | **`<img>` tags actually display images** |
| **3.9** | **text-decoration rendering** | render.ts | Draw underline (1px line at baseline+1), strikethrough (at x-height/2), overline (at ascent). Use `text-decoration-color`, `text-decoration-style` (solid, dashed, dotted, wavy). | **Links need underlines, `<del>` needs strikethrough** |
| **3.10** | **overflow:hidden pixel clipping** | render.ts | During paint, maintain a clip rect stack. When an element has `overflow: hidden`, push its content rect as a clip. Skip pixels outside clip. | **Cards, containers, image crops — extremely common** |
| **3.11** | **XHR cookie injection** | jsruntime.ts | In `XMLHttpRequest.send()`, inject cookies from the cookie jar (same as `fetchAPI` does). | **jQuery AJAX, legacy enterprise apps** |
| **3.12** | **XHR timeout enforcement** | jsruntime.ts | Start a timer on `send()`. If response not received within `this.timeout` ms, abort and fire `ontimeout`. | **Apps that set XHR timeouts** |
| **3.13** | **XHR addEventListener fix** | jsruntime.ts | Current `addEventListener` overwrites previous listener. Use an array/map of listeners per event type. | **Any code adding multiple XHR event listeners** |

---

## Tier 4 — Polish (handles edge cases, improves fidelity)

| # | Task | File(s) | What to Do | Impact |
|---|------|---------|-----------|--------|
| **4.1** | **CSS gradient rendering** | render.ts, css.ts | `linear-gradient()`, `radial-gradient()` parsing already exists. During paint: interpolate colors along the gradient axis, write to background pixels. | **Button backgrounds, hero sections, depth effects** |
| **4.2** | **box-shadow rendering** | render.ts | Parse `box-shadow` (already in css.ts). Paint shadow as offset+blurred rectangle behind the element. Gaussian blur approximation with box blur. | **Card elevations, modal overlays** |
| **4.3** | **CSS transitions** | jsruntime.ts, advanced-css.ts | On style changes, if property is in `transition` list: interpolate from old→new value over `transition-duration` with `transition-timing-function`. Already have easing + keyframe sampling infrastructure. | **Hover effects, menu animations, smooth state changes** |
| **4.4** | **CSS animations** | jsruntime.ts, advanced-css.ts | Parse `@keyframes` from stylesheets (currently skipped). On elements with `animation` property, sample keyframes each tick, apply interpolated values. Fire `animationstart/end/iteration` events. | **Loading spinners, attention effects, page entrance animations** |
| **4.5** | **Streaming responses / ReadableStream** | jsruntime.ts | Instead of buffering entire response then wrapping, feed chunks as they arrive from the socket. Expose `ReadableStream` constructor. | **SSE, streaming JSON, large file download progress** |
| **4.6** | **Viewport units in layout** | layout.ts | `vw`, `vh`, `vmin`, `vmax` — resolve against the browser viewport dimensions (already known). Wire into css.ts `parseLength()` resolution. | **Full-screen hero sections, viewport-relative sizing** |
| **4.7** | **Table colspan/rowspan in layout** | layout.ts | Attributes are parsed but not applied. During column width calculation, span the cell across N columns. Allocate row height accounting for rowspan. | **Complex data tables** |
| **4.8** | **Float text wrapping** | layout.ts | Currently floats are visual approximations. Real float: register float rect in `FloatRegistry` (already exists in layout-ext.ts), narrow the available inline width for subsequent lines that overlap the float's vertical range. | **Pre-flexbox layouts, image+text float patterns** |
| **4.9** | **UA string honesty** | jsruntime.ts L409 | Change to `'JSOS/1.0'` (minimal). Drop fake Chrome Client Hints. Websites serve generic HTML which is what we need — we're not Chrome-compatible enough for Chrome-specific codepaths. | **Receive simpler HTML from servers** |
| **4.10** | **`@font-face` loading in CSS parser** | stylesheet.ts, css-extras.ts | Parse `@font-face` blocks (currently skipped in `parseStylesheet`). Fetch the font file, register in `FontRegistry`. Use `document.fonts.ready` promise. | **Custom web fonts** |
| **4.11** | **`structuredClone` proper implementation** | jsruntime.ts | Current uses `JSON.parse(JSON.stringify())`. Handle `Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`, `Blob`, circular references, `Error` objects. | **Correct data cloning for postMessage, IndexedDB** |
| **4.12** | **`DOMParser`/`XMLSerializer` completion** | jsruntime.ts | Wire `DOMParser.parseFromString('text/html')` to the existing `buildDOM()` in dom.ts. `'text/xml'` can return a simplified XML document. | **Framework SSR hydration, SVG manipulation** |

---

## Tier 5 — Future (hardening, specs compliance)

| # | Task | Impact |
|---|------|--------|
| **5.1** | Service Worker (fetch interception, offline cache) | PWAs |
| **5.2** | `<iframe>` rendering with isolated execution contexts | Embedded content, OAuth flows |
| **5.3** | Content-Security-Policy enforcement | Security |
| **5.4** | Certificate validation (even if warn-only) | HTTPS trust |
| **5.5** | Unicode/emoji text rendering (beyond ASCII) | Non-English sites |
| **5.6** | IndexedDB persistence (currently in-memory only) | Apps that store data client-side |
| **5.7** | `SameSite` cookie attribute enforcement | Auth security |
| **5.8** | CSS `@layer` cascade ordering (currently all rules treated as unlayered) | Modern cascade management |
| **5.9** | CSS nesting (`& .child {}`) | Modern CSS syntax |
| **5.10** | `<canvas>` 2D context completion (path operations, compositing) | Canvas-heavy apps (charts, games) |

---

## Execution Order

- **Phase 1 (foundations):** A.2 → A.1 → 1.1 → 1.2/A.3 → 1.3
- **Phase 2 (layout core):** 1.4 → 1.5 → 1.6 → 2.1 → 2.2 → 2.3 → 2.4
- **Phase 3 (CSS + rendering):** 2.5 → 2.6 → 2.7 → 3.7 → 3.8 → 3.9 → 3.10
- **Phase 4 (networking):** 2.8 → 2.9 → 2.10 → 3.3 → 3.11 → 3.12 → 3.13
- **Phase 5 (advanced):** 3.1 → 3.2 → 3.4 → 3.5 → 3.6
- **Phase 6 (polish):** 4.1-4.12 as time permits
