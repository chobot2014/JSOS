# JSOS Browser Engine Audit — High-Impact Rendering Gaps

> **Goal:** Identify the improvements that make the BIGGEST difference for rendering
> real websites (Google, Wikipedia, news sites, web apps).

---

## Summary of Findings

| Category | HIGH | MEDIUM | LOW | Total |
|----------|------|--------|-----|-------|
| 1. CSS Parsed but NOT Used | 5 | 8 | 6 | 19 |
| 2. Missing CSS Features | 4 | 5 | 3 | 12 |
| 3. HTML/DOM Gaps | 2 | 3 | 2 | 7 |
| 4. JS Runtime Gaps | 5 | 4 | 3 | 12 |
| 5. Layout Algorithm Gaps | 4 | 3 | 2 | 9 |
| **TOTAL** | **20** | **23** | **16** | **59** |

---

## 1. CSS Properties Parsed but NOT Used in Layout/Render

### 1.1 `opacity` — NOT APPLIED during paint (**HIGH**)

- **Gap:** `opacity` is parsed in `css.ts:~L650`, stored in `CSSProps.opacity`, carried to `RenderNode.opacity`, emitted in `BoxDecoration` by `layout.ts:~L1010`, but the `index.ts` paint pass paints backgrounds/text at full opacity. No alpha-blending is applied.
- **Why it matters:** Nearly every modern website uses `opacity` for fade-ins, hover effects, overlay dimming, modal backdrops, and disabled-state indicators. Google search results use opacity transitions for lazy-loaded sections. Wikipedia uses it for image overlays.
- **Impact:** HIGH — visible rendering error on most sites
- **Effort:** medium — need to premultiply alpha on fill colors and text colors when `opacity < 1`
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L650)
  - Stored: [types.ts](src/os/apps/browser/types.ts#L214) (`BoxDecoration.opacity`)
  - Layout annotates: [layout.ts](src/os/apps/browser/layout.ts#L1010)
  - Paint ignores it: [index.ts](src/os/apps/browser/index.ts#L961) (`line.boxDeco` block — no opacity handling)

### 1.2 `text-shadow` — parsed, never rendered (**HIGH**)

- **Gap:** Parsed in `css.ts:~L790` → `CSSProps.textShadow`. Mapped in `stylesheet.ts:~L1000`. Never read in `layout.ts`, `render.ts`, or `index.ts` paint loops.
- **Why it matters:** Google, GitHub, and many news sites use subtle text-shadows for readability. Button labels commonly have `text-shadow: 0 1px 0 rgba(0,0,0,.1)`.
- **Impact:** HIGH — affects text legibility on dark backgrounds; buttons look flat
- **Effort:** medium — need to blit text offset + blurred then blit normal text on top
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L790)
  - Not used in: [index.ts](src/os/apps/browser/index.ts#L1080) (text rendering loop)

### 1.3 `filter` (blur, brightness, contrast, etc.) — parsed, never applied (**MEDIUM**)

- **Gap:** Parsed in `css.ts:~L810` → `CSSProps.filter`. Never consumed in layout or paint.
- **Why it matters:** `filter: blur()` is used for background blurring on modals/overlays. `filter: brightness()` and `filter: grayscale()` are used for disabled-state and image effects.
- **Impact:** MEDIUM — modals look wrong; disabled images render normally
- **Effort:** large — blur requires convolution kernel on pixel data
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L810)
  - Never referenced in layout.ts or render.ts

### 1.4 `clip-path` — parsed, never applied (**MEDIUM**)

- **Gap:** Parsed in `css.ts` → `CSSProps.clipPath`. Never consumed.
- **Why it matters:** Used for shaped containers (circles, polygons), avatar chips, decorative cuts.
- **Impact:** MEDIUM — avatars/chips look rectangular instead of rounded/shaped
- **Effort:** large — requires rasterizing clip geometry and masking
- **Code locations:** [css.ts](src/os/apps/browser/css.ts#L815)

### 1.5 `backdrop-filter` — parsed, never applied (**MEDIUM**)

- **Gap:** Parsed → `CSSProps.backdropFilter`. Never consumed.
- **Why it matters:** iOS-style frosted glass effect on modals, navigation bars, toasts. Common in Material You designs.
- **Impact:** MEDIUM — modals/navbars render without blur behind them
- **Effort:** large — requires reading pixels behind the element and applying blur
- **Code locations:** [css.ts](src/os/apps/browser/css.ts#L820)

### 1.6 `mix-blend-mode` — parsed, never applied (**LOW**)

- **Gap:** Parsed → `CSSProps.mixBlendMode`. Never consumed in paint.
- **Why it matters:** Used for decorative image compositing, text over images.
- **Impact:** LOW — mostly decorative
- **Effort:** large

### 1.7 `column-count` / `column-width` — parsed, never laid out (**HIGH**)

- **Gap:** Parsed in `css.ts:~L855` → `CSSProps.columnCount`, `CSSProps.columnWidth`. Layout treats elements as single-column blocks.
- **Why it matters:** Wikipedia articles use multi-column for reference lists. News sites use multi-column for article previews.
- **Impact:** HIGH — wide blocks of text run full-width instead of splitting
- **Effort:** medium — flow spans into N columns of `contentWidth/N`
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L855)
  - Not consumed in: [layout.ts](src/os/apps/browser/layout.ts) (no multi-column flow logic)

### 1.8 `line-clamp` / `-webkit-line-clamp` — parsed, never enforced (**HIGH**)

- **Gap:** Parsed → `CSSProps.lineClamp`. Never checked in layout. Text overflows without truncation.
- **Why it matters:** Google search results, product cards, news headlines all use `-webkit-line-clamp: 2-3` to truncate previews. Without it, cards overflow or expand unexpectedly.
- **Impact:** HIGH — card layouts break; search result snippets are unbounded
- **Effort:** small — count output lines per block; truncate + add "…" when exceeded
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L860)
  - flowSpans has `textOverflow: ellipsis` but only for single-line: [layout.ts](src/os/apps/browser/layout.ts#L105)

### 1.9 `object-fit` / `object-position` — parsed, never applied to images (**MEDIUM**)

- **Gap:** Parsed → `CSSProps.objectFit`, `CSSProps.objectPosition`. Image widgets use natural/CSS dimensions but don't apply object-fit scaling.
- **Why it matters:** `object-fit: cover` is used universally for hero images, avatar thumbnails, product photos. Without it, images stretch/squish.
- **Impact:** MEDIUM — images distort or overflow container
- **Effort:** small — adjust image decode/blit to crop/letterbox based on fit mode
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L870)
  - Image widget layout: [layout.ts](src/os/apps/browser/layout.ts#L1175)

### 1.10 `background-size` / `background-position` — parsed, partially used (**MEDIUM**)

- **Gap:** Parsed → `CSSProps.backgroundSize`, `CSSProps.backgroundPosition`. Background image tiling exists in `index.ts:~L1050` (repeating tile) but `background-size: cover/contain` and `background-position: center` are not applied.
- **Why it matters:** Hero sections, card backgrounds, banner images all rely on `background-size: cover; background-position: center`.
- **Impact:** MEDIUM — background images tile at natural size instead of filling/covering
- **Effort:** medium — scale decoded image to container dimensions based on size mode
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L880)
  - Tile paint (no sizing): [index.ts](src/os/apps/browser/index.ts#L1050)

### 1.11 `outline` / `outline-offset` — parsed, never rendered (**MEDIUM**)

- **Gap:** Parsed → `CSSProps.outlineStyle`, `CSSProps.outlineOffset`. Never painted.
- **Why it matters:** Focus indicators for accessibility (`outline: 2px solid blue`). Without them, keyboard-navigated sites have no visible focus ring.
- **Impact:** MEDIUM — accessibility issue; focus states invisible
- **Effort:** small — draw a rect around the element with offset
- **Code locations:** [css.ts](src/os/apps/browser/css.ts#L885)

### 1.12 `list-style-type` extended types — partially used (**LOW**)

- **Gap:** `list-style-type` is parsed and the `li` block type renders bullets, but only `disc` (•) is rendered. `decimal`, `lower-alpha`, `upper-roman`, etc. are not differentiated.
- **Why it matters:** Ordered lists on Wikipedia render with bullets instead of numbers.
- **Impact:** LOW — visual nuance
- **Effort:** small — check list-style-type and emit `1.`, `a.`, `I.` prefixes
- **Code locations:**
  - li rendering: [layout.ts](src/os/apps/browser/layout.ts#L380)
  - CSS parsing: [css.ts](src/os/apps/browser/css.ts#L500)

### 1.13 `font-family` — parsed but rendering is monospace-only (**MEDIUM**)

- **Gap:** `font-family` is parsed into `CSSProps.fontFamily` and stored, but `TextAtlas` renders everything in a fixed 8×16 monospace bitmap font. No proportional font support.
- **Why it matters:** All web text renders in monospace, which drastically changes layout widths (proportional text is ~40% narrower) and visual appearance.
- **Impact:** MEDIUM — changes character of every page; layout widths are wrong
- **Effort:** large — requires a proportional font rasterizer or pre-rasterized proportional glyph set
- **Code locations:**
  - Atlas: [render.ts](src/os/apps/browser/render.ts#L20) (monospace 8×16 glyphs)
  - Font scale: [css.ts](src/os/apps/browser/css.ts#L230) (`font-size` → `fontScale`)

### 1.14 `transition-*` / `animation-*` — parsed, AnimationCompositor exists but limited (**MEDIUM**)

- **Gap:** Properties are parsed in `css.ts`. An `AnimationCompositor` exists in `render.ts:~L300` for transform/opacity animations, but CSS transitions (hover → new value) and `@keyframes` animations don't trigger visual interpolation. `@keyframes` blocks are skipped during stylesheet parsing.
- **Why it matters:** Hover effects, dropdown menus, page-load animations, loading spinners all use transitions/animations.
- **Impact:** MEDIUM — hover effects snap instead of easing; no loading spinners
- **Effort:** large — requires animation frame loop, property interpolation engine
- **Code locations:**
  - Parsed: [css.ts](src/os/apps/browser/css.ts#L830)
  - Compositor: [render.ts](src/os/apps/browser/render.ts#L280)
  - `@keyframes` skipped: [stylesheet.ts](src/os/apps/browser/stylesheet.ts#L760)

### 1.15 `vertical-align` — parsed but only used for table cells (**LOW**)

- **Gap:** Parsed → `CSSProps.verticalAlign`. Used in table cell alignment but not for inline elements (subscript/superscript positioning, image alignment in text).
- **Why it matters:** Inline images, icons, emoji that need `vertical-align: middle` float at baseline.
- **Impact:** LOW — misaligned inline images/icons
- **Effort:** medium

### 1.16 `cursor` — parsed but does nothing (**LOW**)

- **Gap:** Parsed → `CSSProps.cursor`. The OS-level cursor is always the system default.
- **Why it matters:** `cursor: pointer` on clickable elements helps users identify interactive areas.
- **Impact:** LOW — usability issue
- **Effort:** small — pass cursor value to the window manager
- **Code locations:** [css.ts](src/os/apps/browser/css.ts#L900)

### 1.17 `user-select: none` — parsed but no text selection exists (**LOW**)

- **Gap:** Parsed → `CSSProps.userSelect`. Since the browser has no text selection mechanism, it's inherently a no-op.
- **Impact:** LOW — no user-visible effect
- **Effort:** N/A until text selection is implemented

### 1.18 `appearance: none` — parsed but widget rendering is hardcoded (**LOW**)

- **Gap:** Parsed → `CSSProps.appearance`. Widget rendering in `appearance.ts` always draws platform-style inputs regardless.
- **Why it matters:** Custom-styled form controls (flat buttons, borderless inputs) still look like OS widgets.
- **Impact:** LOW — visual inconsistency for custom forms
- **Effort:** medium — check `appearance: none` and use CSS-driven styling instead
- **Code locations:** [appearance.ts](src/os/apps/browser/appearance.ts#L84)

### 1.19 `visibility: hidden` — parsed and partially working (**LOW already handled**)

- **Gap:** Actually works! `visibility: hidden` is handled in `html.ts:~L810` by pushing transparent-color spans (color `0x00000000`), and `render.ts:L699` skips rendering transparent spans. Layout space is correctly reserved.
- **Status:** ✅ Working

---

## 2. Missing CSS Features with High Real-World Usage

### 2.1 No inline-level box model (**HIGH**)

- **Gap:** The layout engine only has block-level boxes (RenderNode with `type: 'block'`). Inline spans (`InlineSpan`) carry text + formatting but don't support width, height, padding, margin, border, or background at the per-span level. `display: inline-block` is parsed and partially handled (promoted to `float: left`).
- **Why it matters:** `<span>` elements with padding, background-color, border-radius (tags, badges, chips, pills) are ubiquitous. Google search result URLs are colored spans. Navigation menu items are inline-blocks with padding.
- **Impact:** HIGH — badges/pills/tags lose their boxes; nav items collapse
- **Effort:** large — requires inline box model in `flowSpans` (InlineSpan needs box metric fields)
- **Code locations:**
  - InlineSpan definition: [types.ts](src/os/apps/browser/types.ts#L40)
  - flowSpans: [layout.ts](src/os/apps/browser/layout.ts#L50)
  - inline-block → float hack: [html.ts](src/os/apps/browser/html.ts#L1590)

### 2.2 No `overflow: scroll/auto` scrollable sub-containers (**HIGH**)

- **Gap:** `overflow: hidden` is implemented as a clip rect in index.ts. But `overflow: scroll` and `overflow: auto` are treated identically to `overflow: hidden` — content is clipped without scrollbars, and there's no way for the user to scroll within sub-containers.
- **Why it matters:** Dropdown menus, sidebars, code blocks, chat windows, and feed panels all use scrollable containers. Without this, long content is simply cut off.
- **Impact:** HIGH — long dropdown menus, sidebars, and code blocks are truncated
- **Effort:** large — requires per-element scroll state, scrollbar rendering, input handling
- **Code locations:**
  - Overflow clip: [index.ts](src/os/apps/browser/index.ts#L1027) (`overflowHidden` clip rect)
  - Layout: [layout.ts](src/os/apps/browser/layout.ts#L920) (same treatment for scroll/auto/hidden)

### 2.3 No `display: contents` in flex/grid child counting (**MEDIUM**)

- **Gap:** `display: contents` is partially handled — the element generates no box and its children render as siblings. But in flex/grid containers, the element's children may not be counted as direct flex items, breaking flex layout for nested `display: contents` wrappers.
- **Why it matters:** React fragments often become `display: contents` wrappers in flex containers.
- **Impact:** MEDIUM — React/framework layouts may have incorrect flex item boundaries
- **Effort:** medium — when popping a `display: contents` element, skip the container child boundary logic
- **Code locations:**
  - display:contents handling: [html.ts](src/os/apps/browser/html.ts#L1570) (`if (_disp === 'contents') break;`)

### 2.4 No `@keyframes` animation support (**MEDIUM**)

- **Gap:** `@keyframes` blocks are skipped during stylesheet parsing (`parseStylesheet` skips non-media at-rule blocks). No keyframe storage, no animation playback engine.
- **Why it matters:** Loading spinners, skeleton screens, fade-in effects, slide-in animations all use `@keyframes`. Without them, loading states appear frozen.
- **Impact:** MEDIUM — loading spinners don't spin; skeletons don't pulse
- **Effort:** large
- **Code locations:** [stylesheet.ts](src/os/apps/browser/stylesheet.ts#L760) (skips `@keyframes` blocks)

### 2.5 No `@font-face` support (**MEDIUM**)

- **Gap:** `@font-face` blocks are skipped in stylesheet parsing. All text renders in the built-in monospace bitmap font.
- **Why it matters:** Custom web fonts are used by virtually all modern sites for branding and icon fonts (FontAwesome, Material Icons).
- **Impact:** MEDIUM — icon fonts render as gibberish characters or nothing
- **Effort:** large — requires font file fetching, parsing, and glyph rasterization
- **Code locations:** [stylesheet.ts](src/os/apps/browser/stylesheet.ts#L760)

### 2.6 No CSS custom property (`var()`) dynamic updates from JS (**HIGH**)

- **Gap:** CSS custom properties (`--var-name`) and `var()` are parsed and resolved at CSS computation time (static). But when JS dynamically sets `element.style.setProperty('--color', 'red')`, the computed styles of descendant elements that reference `var(--color)` don't update.
- **Why it matters:** Theme switching (dark mode), dynamic accent colors, and design tokens all use custom properties updated via JS. Google, YouTube, and most SPAs rely on this pattern.
- **Impact:** HIGH — theme changes via JS don't propagate; design tokens stay stale
- **Effort:** medium — need to track custom property dependencies and trigger re-computation
- **Code locations:**
  - var() resolution: [css.ts](src/os/apps/browser/css.ts#L140) (`_resolveVar`)
  - Style recomputation: [stylesheet.ts](src/os/apps/browser/stylesheet.ts#L1050) (`computeElementStyle`)

### 2.7 No CSS `position: sticky` scrolling behavior (**MEDIUM**)

- **Gap:** `position: sticky` is parsed and handled in layout as a static + relative offset clamped to viewport bounds. But the clamping is done once at layout time, not dynamically during scroll. Sticky headers don't follow the user during scrolling.
- **Why it matters:** Sticky navigation bars, table headers, sidebar TOCs are common on every site.
- **Impact:** MEDIUM — sticky headers scroll away instead of sticking
- **Effort:** medium — recalculate sticky positions on scroll events
- **Code locations:**
  - Sticky layout: [layout.ts](src/os/apps/browser/layout.ts#L920) (viewport clamping)

### 2.8 No `writing-mode` / `direction: rtl` (**MEDIUM**)

- **Gap:** Parsed as accepted no-ops. Text always renders left-to-right, top-to-bottom.
- **Why it matters:** Arabic, Hebrew, and Persian websites are entirely RTL. Chinese/Japanese vertical text exists.
- **Impact:** MEDIUM — international sites render incorrectly
- **Effort:** large

### 2.9 Unicode text rendering above ASCII (**HIGH**)

- **Gap:** `TextAtlas` in `render.ts` covers ASCII `0x20–0x9F` (128 glyphs). Unicode above this range is mapped to ASCII equivalents: bullets→`*`, em-dash→`-`, smart quotes→`'`. Characters without mappings (CJK, Cyrillic, extended Latin, emoji, diacritics) render as nothing.
- **Why it matters:** Wikipedia articles in non-English languages, UTF-8 site content with accented characters (café, résumé), currency symbols (€, £, ¥), and virtually any international content is unreadable.
- **Impact:** HIGH — international content is blank; even common symbols (€, ©, ™) disappear
- **Effort:** medium — expand atlas to cover Latin-1 Supplement (0xA0-0xFF) and common mathematical/currency symbols; large for full Unicode
- **Code locations:**
  - Atlas mapping: [render.ts](src/os/apps/browser/render.ts#L40) (`_COMMON_UNICODE_MAP`)
  - Glyph range: [render.ts](src/os/apps/browser/render.ts#L10) (`0x20..0x9F`)

---

## 3. HTML/DOM Gaps Causing Rendering Failures

### 3.1 `<iframe>` renders as placeholder text (**HIGH**)

- **Gap:** `<iframe>` elements render as `[🖼️ iframe: url]` placeholder text. No embedded document loading or rendering occurs.
- **Why it matters:** YouTube embeds, Google Maps, ads, social media embeds, payment forms — all use iframes. Google search results embed video previews in iframes.
- **Impact:** HIGH — embedded content is invisible; YouTube/Maps show placeholder text
- **Effort:** large — requires recursive page load, render, and compositor isolation
- **Code locations:** [html.ts](src/os/apps/browser/html.ts#L1070) (`case 'iframe'`)

### 3.2 `<canvas>` element renders as placeholder but JS API is stub (**HIGH**)

- **Gap:** HTML renders `<canvas>` as `[canvas 300×150]` placeholder. The JS runtime provides complete `getContext('2d')` / `getContext('webgl')` stubs that return no-op methods. A real `canvas2d.ts` exists but it's unclear if it's wired up for actual pixel output that gets composited into the page.
- **Why it matters:** Charts (Chart.js, D3), interactive graphics, image editors, games, Google Charts — all use canvas.
- **Impact:** HIGH — data visualizations are blank
- **Effort:** large — requires real 2D rasterizer + compositor integration
- **Code locations:**
  - HTML: [html.ts](src/os/apps/browser/html.ts#L1085)
  - JS stub: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1810) (WebGL/2d stubs)
  - Real canvas: [canvas2d.ts](src/os/apps/browser/canvas2d.ts)

### 3.3 `<video>` / `<audio>` render as placeholders (**MEDIUM**)

- **Gap:** `<video>` → `▶️ [video: url]`, `<audio>` → `♪ [audio: url]`.
- **Why it matters:** Media playback is a major web use case. An `audio-element.ts` file exists.
- **Impact:** MEDIUM — media content not accessible
- **Effort:** large — requires media decoder integration
- **Code locations:** [html.ts](src/os/apps/browser/html.ts#L1075)

### 3.4 `<dialog>` element not rendered specially (**MEDIUM**)

- **Gap:** `<dialog>` is treated as a generic block div. No modal overlay, no backdrop, no `showModal()` API.
- **Why it matters:** Modern sites use `<dialog>` for cookie banners, login modals, confirmation dialogs.
- **Impact:** MEDIUM — dialog content renders inline instead of as a modal overlay
- **Effort:** medium

### 3.5 Shadow DOM (`attachShadow`) is structural only (**MEDIUM**)

- **Gap:** JS `attachShadow` creates an isolated `_StubElement` subtree, but its content is never rendered into the visible page. Web Components that render into shadow DOM produce no visual output.
- **Why it matters:** YouTube, GitHub, and many Google products use Web Components with Shadow DOM.
- **Impact:** MEDIUM — Web Components are blank
- **Effort:** large — requires shadow tree traversal during HTML→RenderNode conversion

### 3.6 `<img>` with `srcset` / responsive images — partial (**LOW**)

- **Gap:** `srcset` is parsed and the first URL is extracted, but viewport-based selection (`1x`, `2x`, `w` descriptors) is not applied. Always uses the first entry.
- **Why it matters:** Sites serve different resolution images; may get unnecessarily large or small images.
- **Impact:** LOW — images still load, just not optimal resolution
- **Effort:** small
- **Code locations:** [html.ts](src/os/apps/browser/html.ts#L1445)

### 3.7 No `<slot>` / template instantiation from JS (**LOW**)

- **Gap:** `<template>` content is stored in `templates` map but never used. `<slot>` is a no-op.
- **Why it matters:** Web Components use slots for content distribution.
- **Impact:** LOW — only affects Web Component-heavy sites
- **Effort:** medium

---

## 4. JS Runtime Gaps Causing Scripts to Crash

### 4.1 `getBoundingClientRect()` returns heuristic values, not real layout (**HIGH**)

- **Gap:** Returns hardcoded sizes based on tag name (DIV=1024×20, SPAN=textLength*8, INPUT=200×30, etc.) with `x:0, y:0, top:0, left:0` always. Real layout positions are never fed back.
- **Why it matters:** JS code that measures elements for positioning (tooltips, dropdowns, infinite scroll triggers, intersection calculations, virtualized lists) gets wrong values and breaks.
- **Impact:** HIGH — tooltips positioned at wrong locations; virtual lists break; lazy-loading triggers at wrong scroll position
- **Effort:** medium — `updateLayoutRects` in `PageJS` interface exists but needs integration: map element IDs to their actual layout coordinates
- **Code locations:**
  - Stub: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L648) (`getBoundingClientRect`)
  - Layout rect interface: [types.ts](src/os/apps/browser/types.ts#L10) (`PageJS.updateLayoutRects`)

### 4.2 `getComputedStyle()` returns inline style, not cascade result (**HIGH**)

- **Gap:** Returns the element's `el.style` object with defaults. Does NOT return the actual computed style from the CSS cascade (stylesheet rules, inherited properties, etc.).
- **Why it matters:** Frameworks check `getComputedStyle(el).display` to detect visibility, measure font-size for layout calculations, read animation state, etc. Wrong values cause logic branches to fail.
- **Impact:** HIGH — framework visibility checks fail; animation libraries can't read current state
- **Effort:** medium — need to bridge the stylesheet computeElementStyle result back to JS
- **Code locations:** [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1052) (`getComputedStyle`)

### 4.3 DOM mutations don't reliably trigger re-render with correct CSS (**HIGH**)

- **Gap:** When JS adds/removes elements or changes classes, `_domDirty` is set, and the parent process re-parses `<body>.innerHTML` to rebuild the render tree. However, this round-trip serializes the DOM to HTML, losing:
  1. Event listeners attached by JS
  2. Dynamic state (focus, scroll position)
  3. JS-authored CSS class changes may not trigger proper stylesheet re-matching if the innerHTML serialization drops intermediate state
- **Why it matters:** SPAs like React, Vue, Angular constantly mutate the DOM. The innerHTML round-trip is lossy and slow, making reactive applications unreliable.
- **Impact:** HIGH — SPAs lose state on re-render; interactive UIs break
- **Effort:** large — implement incremental DOM-to-RenderNode sync instead of innerHTML round-trip
- **Code locations:**
  - _domDirty flag: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L628)
  - innerHTML serializer: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L630) (`_serHTML`)
  - Re-parse trigger: main browser loop reads _domDirty and re-parses

### 4.4 `addEventListener` event types limited in page dispatch (**HIGH**)

- **Gap:** The child runtime has a full `EventTarget` implementation with `addEventListener` / `dispatchEvent` / event bubbling. However, the page bridge only dispatches these event types FROM the parent: `click`, `change`, `input`, `keydown`, `submit`, `load`, `focus`, `blur`, `mouse`, `resize`. Missing: `scroll`, `wheel`, `touchstart/move/end`, `pointerdown/move/up`, `contextmenu`, `dragstart/drop`, `paste`, `copy`, `animationend`, `transitionend`, `DOMContentLoaded` (partial), `hashchange`.
- **Why it matters:** `scroll` events power infinite scroll, parallax, sticky header logic. `DOMContentLoaded` is how most scripts initialize. `pointer*` events are the modern standard for mouse/touch.
- **Impact:** HIGH — scroll handlers don't fire; pointer events don't fire; many scripts fail to initialize
- **Effort:** small — add scroll/wheel/pointer/DOMContentLoaded to the bridge dispatch
- **Code locations:**
  - PageJS interface: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L30) (`fireClick`, `fireChange`, etc.)
  - Missing events not in the interface

### 4.5 `fetch()` Response doesn't support streaming / ReadableStream (**MEDIUM**)

- **Gap:** `fetch()` relays to parent via message queue and returns the entire body as base64. The `response.body` getter returns a `ReadableStream` that delivers the entire body in one `read()` call. No true streaming — large downloads block until complete.
- **Why it matters:** Streaming JSON parsing, Server-Sent Events over fetch, large file downloads. Not critical for most page renders.
- **Impact:** MEDIUM — large API responses block; no streaming support
- **Effort:** medium

### 4.6 `Web Workers` are no-op stubs (**MEDIUM**)

- **Gap:** `Worker` constructor exists but `postMessage` does nothing. No actual worker thread is created.
- **Why it matters:** Some sites offload work to workers (WASM compilation, heavy computation). Without workers, `new Worker()` silently fails.
- **Impact:** MEDIUM — worker-dependent features silently fail
- **Effort:** large — requires spawning another JS context with message passing
- **Code locations:** [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1800)

### 4.7 `WebSocket` immediately errors (**MEDIUM**)

- **Gap:** `WebSocket` constructor immediately transitions to `readyState=3` (CLOSED) and fires `onerror` + `onclose`. No actual WebSocket connection.
- **Why it matters:** Chat applications, live dashboards, real-time collaboration tools use WebSocket.
- **Impact:** MEDIUM — real-time features non-functional
- **Effort:** large — requires TCP stack integration
- **Code locations:** [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1340)

### 4.8 `document.cookie` reactive but no actual HTTP cookie header integration (**MEDIUM**)

- **Gap:** `document.cookie` getter/setter works reactively in JS, but cookies don't flow to/from HTTP request headers. The cookie jar is per-tab isolated.
- **Why it matters:** Authentication state, session tracking, CSRF tokens — all rely on cookies being sent with requests.
- **Impact:** MEDIUM — authenticated sessions don't work across fetch requests
- **Effort:** medium — include `_cookieStr` in fetch request headers and parse Set-Cookie from responses

### 4.9 No `window.history.pushState` / `popstate` navigation (**LOW**)

- **Gap:** `history.pushState` and `history.replaceState` are stubs. No actual history stack management. `popstate` events never fire.
- **Why it matters:** SPA navigation (React Router, Vue Router) uses pushState. Without it, SPA page transitions don't update the URL or enable back-button navigation.
- **Impact:** LOW — SPAs navigate but URL doesn't update; back button doesn't work
- **Effort:** medium

### 4.10 `Canvas 2D` drawing operations are no-ops in child runtime (**MEDIUM**)

- **Gap:** Despite `canvas2d.ts` existing with real drawing logic, the child runtime's `getContext('2d')` returns all-noop methods. The actual canvas bridge (`getCanvasBuffers` in PageJS) needs to be wired up.
- **Why it matters:** Chart libraries, image manipulation, custom UI renderers all use Canvas 2D.
- **Impact:** MEDIUM — charts/graphs are blank
- **Effort:** medium — bridge child canvas state to parent canvas2d.ts implementation
- **Code locations:**
  - Stub: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1810)
  - Real implementation: [canvas2d.ts](src/os/apps/browser/canvas2d.ts)

### 4.11 No `IntersectionObserver` callback with real visibility (**LOW**)

- **Gap:** `IntersectionObserver.observe()` immediately calls back with `isIntersecting: true, intersectionRatio: 1` for every element. No real visibility tracking.
- **Why it matters:** Lazy image loading, infinite scroll triggers, ad viewability.
- **Impact:** LOW — all images load eagerly (may be desirable); ad scripts may over-report
- **Effort:** medium — feed real layout rect data to observer callbacks

### 4.12 `MutationObserver` partially works (**LOW already handled**)

- **Gap:** Actually works! MutationObserver is fully implemented with attribute, childList, and characterData tracking via `_dispatchMO`. ✅ Working.

---

## 5. Layout Algorithm Improvements for Common Bugs

### 5.1 No intrinsic sizing (`min-content`, `max-content`, `fit-content`) (**HIGH**)

- **Gap:** `parseLengthPx` doesn't handle `min-content`, `max-content`, or `fit-content()` keywords. Elements with `width: fit-content` get width 0 or default to full container width.
- **Why it matters:** Buttons with `width: fit-content` size to their text. Auto-sizing containers use `max-content`. Without these, buttons either stretch full-width or collapse.
- **Impact:** HIGH — buttons stretch full-width; auto-sized containers break
- **Effort:** medium — `min-content` = narrowest word; `max-content` = no-wrap line; `fit-content` = clamp
- **Code locations:**
  - Length parser: [css.ts](src/os/apps/browser/css.ts#L180) (`parseLengthPx`)
  - Width resolution: [layout.ts](src/os/apps/browser/layout.ts#L290)

### 5.2 No percentage height resolution against containing block (**HIGH**)

- **Gap:** `heightPct` is parsed (e.g., `height: 50%`) but layout doesn't resolve it against the containing block's height. Elements with percentage heights get no explicit height.
- **Why it matters:** Full-screen sections (`height: 100%`), split-pane layouts (`height: 50%`), hero banners.
- **Impact:** HIGH — full-height sections collapse; split layouts don't divide
- **Effort:** medium — pass containing block height through layout recursion
- **Code locations:**
  - heightPct stored: [types.ts](src/os/apps/browser/types.ts#L120)
  - Not resolved in: [layout.ts](src/os/apps/browser/layout.ts#L290)

### 5.3 Margin collapsing only between top-level siblings (**MEDIUM**)

- **Gap:** Margin collapsing is implemented between adjacent block siblings in `layout.ts:~L290` (`marginTop` collapses with previous sibling's `marginBottom`). But parent-child margin collapsing (first child's `marginTop` collapses with parent's `marginTop`) is not implemented.
- **Why it matters:** Without parent-child collapsing, nested elements have double margins, causing excessive whitespace.
- **Impact:** MEDIUM — paragraphs inside divs have extra space at top
- **Effort:** small — check if parent has no border/padding/overflow and collapse first child's margin
- **Code locations:** [layout.ts](src/os/apps/browser/layout.ts#L290)

### 5.4 No `gap` support in block/inline layout (only flex/grid) (**MEDIUM**)

- **Gap:** `gap` (and `row-gap` / `column-gap`) is implemented for flex and grid containers but not for column layouts or general block spacing.
- **Impact:** MEDIUM — multi-column gap doesn't work
- **Effort:** small — when implementing multi-column, use column-gap for gutter width

### 5.5 Float clearing edge cases (**MEDIUM**)

- **Gap:** `float: left/right` is implemented with basic text wrapping. But `clear: both` only inserts a line break — it doesn't drop below all outstanding floats. Also, floats don't properly establish a new block formatting context for their children.
- **Why it matters:** Classic float-based layouts (sidebar + content) may overlap instead of stacking.
- **Impact:** MEDIUM — float-based layouts may have content overlap
- **Effort:** medium — track float extents and advance Y past all cleared floats
- **Code locations:** [layout.ts](src/os/apps/browser/layout.ts#L350) (float handling)

### 5.6 Flex `flex-basis: auto` doesn't use content size (**HIGH**)

- **Gap:** When `flex-basis` is `auto` or unset, flex items should use their content's intrinsic width as the basis for flex calculations. Currently, items without explicit `flex-basis` or `width` start with basis=0, causing them to collapse when `flex-shrink` is applied.
- **Why it matters:** Most flex layouts rely on `flex: 1 1 auto` or `flex: 0 0 auto` where the basis is "whatever the content needs." If basis=0, text-heavy flex items collapse.
- **Impact:** HIGH — flex items with content but no explicit width collapse
- **Effort:** medium — pre-measure content intrinsic width and use as flex-basis when auto
- **Code locations:** [layout.ts](src/os/apps/browser/layout.ts#L600) (flex layout section)

### 5.7 No `z-index` stacking context rendering (**MEDIUM**)

- **Gap:** `z-index` is parsed and stored on positioned elements, and used for sort order in the absolute/fixed rendering pass. But there's no true stacking context — elements with `z-index` don't create isolated compositing layers that paint in z-order. Overlapping positioned elements may paint in DOM order rather than z-order.
- **Why it matters:** Modals, dropdowns, tooltips rely on high z-index to overlay content.
- **Impact:** MEDIUM — overlapping elements paint in wrong order
- **Effort:** medium — sort positioned elements by z-index before painting
- **Code locations:** [layout.ts](src/os/apps/browser/layout.ts#L935) (z-index sort)

### 5.8 No `calc()` with mixed units (**LOW**)

- **Gap:** `calc()` is parsed and evaluated in `css.ts:~L190`, supporting `+`, `-`, `*`, `/`. But mixed-unit expressions like `calc(100% - 20px)` require knowing the containing block size at resolution time. Currently, `%` inside `calc()` resolves to 0 because the container width isn't available during CSS parsing.
- **Why it matters:** `calc(100% - 2 * var(--padding))` is extremely common for full-width-minus-padding layouts.
- **Impact:** LOW (percentage-based calc already partially works for some properties where width is known)
- **Effort:** medium — defer calc resolution to layout time when container width is known
- **Code locations:** [css.ts](src/os/apps/browser/css.ts#L190) (`_evalCalc`)

### 5.9 `aspect-ratio` only applied with explicit width (**LOW**)

- **Gap:** `aspect-ratio` is checked in layout when an element has an explicit width to compute height. But when only height is set, width isn't derived from aspect-ratio. And when neither dimension is set, aspect-ratio has no effect.
- **Why it matters:** Responsive images and video containers use `aspect-ratio: 16/9` to reserve space before content loads.
- **Impact:** LOW — content reflow when images load
- **Effort:** small
- **Code locations:** [layout.ts](src/os/apps/browser/layout.ts#L310)

---

## Priority Implementation Plan

### Tier 1 — Quick Wins (small effort, HIGH impact)

1. **Line-clamp enforcement** (§1.8) — count lines, truncate + "…"
2. **Scroll/wheel/DOMContentLoaded events** (§4.4) — add to bridge dispatch
3. **Intrinsic sizing keywords** (§5.1) — `fit-content`, `min-content`, `max-content`
4. **Flex-basis: auto** from content (§5.6) — pre-measure content width
5. **Percentage height resolution** (§5.2) — pass container height
6. **List-style-type numbers** (§1.12) — `1.` / `a.` / `I.` prefix for `<ol>`

### Tier 2 — Medium Effort, HIGH Impact

7. **Opacity rendering** (§1.1) — premultiply alpha on colors
8. **Unicode glyph expansion** (§2.9) — Latin-1 Supplement + symbols
9. **`getBoundingClientRect` real values** (§4.1) — wire layout rects to JS
10. **`getComputedStyle` from cascade** (§4.2) — bridge CSS computation
11. **CSS custom property dynamic updates** (§2.6) — track var() dependencies
12. **Multi-column layout** (§1.7) — flow into N columns

### Tier 3 — Large Effort, HIGH Impact

13. **Inline-level box model** (§2.1) — padding/margin/border on inline elements
14. **DOM mutation sync** (§4.3) — incremental RenderNode update vs innerHTML
15. **`overflow: scroll`** (§2.2) — scrollable sub-containers
16. **Canvas 2D bridge** (§4.10) — connect canvas2d.ts to child runtime~
17. **`<iframe>` rendering** (§3.1) — recursive page load

### Tier 4 — Polish & Completeness

18. Text-shadow rendering (§1.2)
19. CSS transitions/animations (§1.14, §2.4)
20. Proportional fonts (§1.13)
21. Filter effects (§1.3)
22. `position: sticky` on scroll (§2.7)
23. Web Workers (§4.6)
24. WebSocket (§4.7)
25. Shadow DOM rendering (§3.5)
