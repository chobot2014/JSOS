# JSOS Browser Engine Internals
**Item 888**

## Architecture

The JSOS browser (`src/os/apps/browser/`) is a full web browser implemented
in TypeScript, running directly inside the OS JavaScript environment.

## Components

### HTML Parser (`src/os/apps/browser/dom.ts`)

- Tokeniser: RegExp-based state machine covering tags, attributes, text, comments, CDATA
- Tree builder: stack-based element nesting with `<html>/<head>/<body>` implicit open
- Handles: void elements, optional close tags, malformed markup recovery
- HTML entities: `&amp; &lt; &gt; &quot; &apos;` + numeric `&#x...;`

### CSS Engine (`src/os/apps/browser/jsruntime.ts` + `advanced-css.ts`)

Included features:
- Full selector matching: type, class, ID, attribute, pseudo-class, pseudo-element, combinators
- Cascade: specificity, source order, `@layer` (item 436), `!important`
- Computed style with `var()` resolution and ancestor chain walking
- `@media`, `@supports`, `@container` queries
- `@keyframes` + `animation`, `transition`
- CSS Grid + Flexbox layout algorithms
- `clip-path`, `transform`, `opacity` compositing layers
- `@font-face` + `document.fonts` API

### Layout Engine (`src/os/apps/browser/layout.ts`)

Block / Inline / Flex / Grid layout tree. Key passes:
1. **Block formatting context** — normal flow block boxes
2. **Inline formatting context** — line boxes, text wrapping
3. **Flex formatting context** — flex container/item resolve
4. **Grid formatting context** — grid line / area resolve
5. **Paint** — background, border, text, images, compositing

### JavaScript Runtime (`jsruntime.ts`)

All page JavaScript runs inside the OS QuickJS instance (no separate VM). The
runtime injects Web APIs into the page's isolated scope object:
- `window`, `document`, `navigator`, `location`, `history`
- `fetch`, `XMLHttpRequest`, `WebSocket`
- `localStorage`, `sessionStorage`, `indexedDB` (stub)
- `requestAnimationFrame`, `setTimeout`, `setInterval`
- `MutationObserver`, `IntersectionObserver`, `ResizeObserver`
- `AudioContext` (Web Audio API)
- `Canvas2DRenderingContext`, `WebGL` (stubs)
- `Service Worker` API (stub)
- Shadow DOM, Custom Elements

### Paint (`canvas2d.ts`, `advanced-css.ts`)

- Software rasteriser: spans, scanline fill, bezier curves (for border-radius)
- Text via kernel bitmap font (VGA 8×16) + TTF glyph cache
- Image decode: JPEG (src/os/apps/browser/jpeg-decode.ts), PNG, GIF89a, WebP (stub)
- Dirty-rect tracking: only repaint changed regions per rAF frame

### Networking

Page network requests go through `sys.net.http` → TLS 1.3 → TCP → kernel Ethernet DMA.
Same-origin policy enforced in `jsruntime.ts`.

## Performance Features

- Selector specificity index (pre-sorted rule buckets, O(1) tag/class/id lookup) — item 943
- Computed style cache with style-generation counter — item 944
- Dirty-rect repaint optimisation — item 948
- `will-change: transform` layer promotion — item 900
- `IntersectionObserver` deferred off-screen computation — item 959
- Font metrics cache (ascent/descent per family+size) — item 897
