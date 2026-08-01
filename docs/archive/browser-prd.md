# JSOS Browser — Product Requirements Document

**Version:** 1.0  
**Date:** February 24, 2026  
**Branch:** `browser-js`  
**Status:** Active Development

---

## 1. Vision

The JSOS Browser is a native, full-featured web browser written entirely in TypeScript, running directly on the JSOS kernel with no host OS, no Electron, no separate browser process. It is the flagship application that proves the JSOS thesis: **TypeScript as the operating system**.

The target is a browser capable of rendering text-heavy public web content (Wikipedia, documentation sites, news articles, Hacker News) correctly, executing moderate JavaScript, and serving as the primary interface for JSOS-native web applications. It is not a Chrome clone — it is the best browser possible given the hardware constraints of a bare-metal QuickJS runtime.

---

## 2. Current State (Baseline)

The following is implemented and shipping on `browser-js`:

| Module | File | Lines | Status |
|---|---|---|---|
| HTML tokeniser + parser | `html.ts` | 819 | ✅ Working |
| DOM (`VDocument`, `VElement`, `VEvent`) | `dom.ts` | 574 | ✅ Working |
| Inline CSS parser | `css.ts` | 132 | ✅ Working — inline `style=""` only |
| Word-flow layout engine | `layout.ts` | 275 | ✅ Working — inline flow only |
| JS runtime (`window`, `document`, `console`) | `jsruntime.ts` | 648 | ✅ Working |
| Browser app shell | `index.ts` | 1,259 | ✅ Working |
| About pages / JSON viewer | `pages.ts` | 132 | ✅ Working |
| TCP/IP stack (Ethernet→ARP→IPv4→TCP) | `net.ts` | 1,086 | ✅ Working |
| TLS 1.2/1.3 partial | `tls.ts` | 558 | ⚠️ Partial |
| HTTP/1.1 client | `http.ts` | 259 | ✅ Working |
| DNS resolver | `dns.ts` | 197 | ✅ Working |
| DHCP client | `dhcp.ts` | 216 | ✅ Working |
| Crypto (HMAC, SHA, AES) | `crypto.ts` | 535 | ✅ Working |
| 32-bit pixel framebuffer | `canvas.ts` | 682 | ✅ Working |
| Window manager | `wm.ts` | 1,014 | ✅ Working |

### Known Gaps (Current)

- CSS is **inline `style=""` attributes only** — no stylesheets, no selectors, no cascade
- Layout is **block + text flow only** — no float, no flex, no grid, no positioned elements
- **No image decoding** — PNG/JPEG/WebP/GIF all show placeholder boxes
- **No proportional fonts** — fixed 8×8 CP437 bitmap only
- **No JIT** — QuickJS interpretes everything; JS-heavy pages are slow
- TLS: no client certificates, no session resumption, limited cipher support
- HTTP: no HTTP/2, no persistent connections, no caching layer

---

## 3. Goals and Non-Goals

### Goals

- Render Wikipedia, MDN, Hacker News, and similar document-centric sites correctly
- Execute moderate JavaScript (vanilla DOM manipulation, fetch, JSON, form submission)
- Support HTTPS for all navigation (complete TLS 1.2 + TLS 1.3)
- Display inline images (PNG and JPEG minimum)
- Navigate history, bookmarks, tabs (multiple pages in tabs)
- Find-in-page, keyboard-first navigation
- JSOS-native application platform (custom `jsos://` protocol)

### Non-Goals

- Passing the full WPT test suite
- WebGL / WebGPU / canvas 2D hardware acceleration
- Web Workers / SharedArrayBuffer / WASM
- CSS animations / transitions / transforms
- Media playback (audio/video)
- Chrome DevTools-equivalent developer tools (a basic inspector is acceptable)
- OAuth / SSO / complex cookie flows (a cookie jar is acceptable)

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     BrowserApp (index.ts)               │
│  Navigation · History · Bookmarks · Tabs · Find         │
├───────────────┬──────────────────┬──────────────────────┤
│  CSS Engine   │   Layout Engine  │   JS Runtime         │
│  (css.ts)     │   (layout.ts)    │   (jsruntime.ts)     │
│               │                  │                      │
│  Stylesheet   │   Block model    │   window / document  │
│  Selector     │   Flex / Float   │   fetch / XHR        │
│  Cascade      │   Positioned     │   setTimeout / RAF   │
│  Computed     │   Tables         │   MutationObserver   │
├───────────────┴──────────────────┴──────────────────────┤
│                  HTML Parser (html.ts)                  │
│  Tokeniser · Tree builder · Script collection           │
├─────────────────────────────────────────────────────────┤
│                  DOM (dom.ts)                           │
│  VDocument · VElement · VText · VEvent                 │
│  Mutation tracking · Serialisation                      │
├─────────────────────────────────────────────────────────┤
│              Network Stack (net/, http.ts)              │
│  TCP · TLS · HTTP/1.1 · DNS · DHCP · Crypto            │
├─────────────────────────────────────────────────────────┤
│           JSOS Kernel (C + QuickJS runtime)            │
│  Framebuffer · Keyboard · Mouse · Ethernet driver      │
└─────────────────────────────────────────────────────────┘
```

---

## 5. Feature Roadmap

Features are grouped into four phases. Each phase ships a demonstrably better browser.

---

### Phase B1 — CSS Foundation  *(highest leverage)*

**Goal:** render styled text-heavy pages correctly. Wikipedia should look like Wikipedia.

#### B1.1 Stylesheet Parser

- Parse `<style>` tags and `<link rel="stylesheet">` external sheets
- Tokenise CSS into rules: `selector { property: value; ... }`
- Support: type selectors (`p`, `h1`), class selectors (`.foo`), ID selectors (`#bar`), descendant combinator (` `), child combinator (`>`), comma-grouped selectors (`a, b`)
- Inline `<style>` is applied before external sheets (already spec-compliant order)

**New file:** `src/os/apps/browser/stylesheet.ts`

```typescript
export interface CSSRule {
  selectors: string[];          // pre-split on comma
  props:     CSSProps;
}
export function parseStylesheet(text: string): CSSRule[];
export function matchesSelector(el: VElement, sel: string): boolean;
```

#### B1.2 Specificity + Cascade

- Compute specificity as `[id, class, type]` triple
- Build a `ComputedStyle` map keyed by `VElement` identity
- Cascade order: user-agent defaults → `<link>` sheets (document order) → `<style>` blocks → inline `style=""` attribute
- Inherited properties: `color`, `font-weight`, `font-style`, `text-align`, `visibility`

**New file:** `src/os/apps/browser/cascade.ts`

```typescript
export type ComputedStyleMap = Map<VElement, CSSProps>;
export function computeStyles(
  dom: VDocument,
  sheets: CSSRule[],
  inlineStyles: Map<VElement, CSSProps>
): ComputedStyleMap;
```

#### B1.3 Box Model Properties

Extend `CSSProps` and `parseInlineStyle` / stylesheet parser to handle:

| Property | Values |
|---|---|
| `display` | `block`, `inline`, `inline-block`, `none`, `flex`, `list-item` |
| `margin` / `margin-top` etc. | px, em (1em = 16px), % (of container width) |
| `padding` / `padding-top` etc. | px, em, % |
| `border` / `border-width` | px — render as solid line in border-color |
| `border-color` | any CSS color |
| `border-radius` | px — clamp corners in the pixel renderer |
| `width` / `max-width` / `min-width` | px, %, `auto` |
| `height` / `max-height` | px, `auto` |
| `line-height` | px, unitless multiplier |
| `font-size` | px, named sizes (`small`, `large`, etc.) — maps to 8×8, 8×12, 8×16 stepping |
| `font-weight` | `bold`, `normal`, 100–900 |
| `font-style` | `italic`, `normal` |
| `text-decoration` | `underline`, `line-through`, `none` |
| `text-align` | `left`, `center`, `right`, `justify` |
| `vertical-align` | `top`, `middle`, `bottom`, `baseline` |
| `background-color` | any CSS color |
| `color` | any CSS color |
| `overflow` | `visible`, `hidden`, `scroll`, `auto` |
| `position` | `static`, `relative`, `absolute`, `fixed`, `sticky` |
| `top` / `right` / `bottom` / `left` | px, %, `auto` |
| `z-index` | integer |
| `opacity` | 0–1 — blend against background |
| `list-style-type` | `disc`, `circle`, `square`, `decimal`, `none` |
| `cursor` | `pointer`, `default`, `text` — update mouse cursor rendering |

**Acceptance criteria:**
- Wikipedia article body renders with correct heading sizes, paragraph spacing, infobox background colours, and link colours
- MDN code blocks show correct `<pre>` background

---

### Phase B2 — Block Layout Engine

**Goal:** pages lay out like a real browser, not a text dumper.

#### B2.1 Box Tree Construction

Replace the current flat `RenderNode[]` list with a proper box tree:

```typescript
interface Box {
  type:       'block' | 'inline' | 'anonymous-block' | 'replaced';
  el?:        VElement;
  style:      CSSProps;
  children:   Box[];
  // geometry (filled by layout pass)
  x: number; y: number; w: number; h: number;
  contentW: number; contentH: number;
}
```

- `buildBoxTree(dom, computedStyles)` → `Box` (root)
- Anonymous block boxes created per CSS block-formatting-context rules
- `display:none` elements and their subtrees excluded

#### B2.2 Block Formatting Context (BFC)

- Block elements stack vertically with margin collapse
- Margin collapsing: adjacent sibling top/bottom margins collapse to the larger of the two
- Widths: `auto` fills container; explicit `px`/`%` respected; `max-width` clamps
- Heights: `auto` fits content; explicit values clip or scroll

#### B2.3 Inline Formatting Context (IFC)

Replace `flowSpans()` with a proper inline formatter:

- Line boxes with baseline alignment
- `vertical-align`: baseline, top, middle, bottom
- `white-space: nowrap` — no wrapping
- `word-break: break-all` — break anywhere
- Inline-block elements participate in flow

#### B2.4 Float Layout

- `float: left` / `float: right`
- Text/inline content wraps around floats
- `clear: left` / `clear: right` / `clear: both`
- Float clearance computed per line box

#### B2.5 Positioned Layout (Residual Pass)

After normal flow:

- `position: relative` — offset from normal-flow position
- `position: absolute` — remove from flow, position relative to nearest positioned ancestor
- `position: fixed` — position relative to viewport (recalc on scroll)
- `position: sticky` — clamp to scroll viewport top/bottom

#### B2.6 Flexbox (Subset)

Sufficient for navigation bars and cards:

- `flex-direction: row | column`
- `justify-content: flex-start | center | flex-end | space-between | space-around`
- `align-items: flex-start | center | flex-end | stretch`
- `flex-wrap: nowrap | wrap`
- `flex: 1` / `flex-grow` / `flex-shrink` / `flex-basis`
- No nested flex containers in the first iteration

#### B2.7 Table Layout (Basic)

- `display: table | table-row | table-cell`
- Fixed-layout algorithm (column widths based on first row)
- `border-collapse: collapse` — merge cell borders
- `colspan` / `rowspan` attribute support

**Acceptance criteria:**
- Hacker News front page renders with correct two-column layout
- Wikipedia infobox (floated right) renders correctly with text wrapping
- A simple Bootstrap 3 / Tailwind page lays out recognisably

---

### Phase B3 — Image Decoding

**Goal:** images display instead of placeholder boxes.

#### B3.1 PNG Decoder

Pure TypeScript PNG decoder (no native code required):

- IHDR chunk: width, height, bit depth, colour type
- Colour types: Greyscale (0), RGB (2), Palette (3), Greyscale+Alpha (4), RGBA (6)
- Filter types 0–4 (None, Sub, Up, Average, Paeth)
- DEFLATE decompression — implement INFLATE algorithm in TypeScript (or reuse existing `crypto.ts` primitives)
- Output: `Uint32Array` of 0xAARRGGBB pixels
- Interlaced PNGs: decode but skip interlace (display as non-interlaced)
- Max size per image: 2048×2048 px (memory budget)

**New file:** `src/os/apps/browser/img-png.ts`

```typescript
export function decodePNG(bytes: Uint8Array): DecodedImage;
```

#### B3.2 JPEG Decoder

Baseline JPEG (covers >95% of web images):

- SOF0 (baseline DCT), SOF2 (progressive — decode as baseline)
- Huffman decoding, 8×8 DCT blocks, dequantisation, IDCT
- YCbCr → RGB colour conversion
- 1, 3 channel support; 4:4:4, 4:2:2, 4:2:0 chroma subsampling
- Output: same `DecodedImage` type
- Max size: 2048×2048 px

**New file:** `src/os/apps/browser/img-jpeg.ts`

```typescript
export function decodeJPEG(bytes: Uint8Array): DecodedImage;
```

#### B3.3 GIF Decoder (Minimum)

- GIF87a + GIF89a
- LZW decompression
- Single frame only (animated GIF: render first frame)
- Output: `DecodedImage`

**New file:** `src/os/apps/browser/img-gif.ts`

#### B3.4 WebP (Opt-in)

- Lossy WebP — VP8 bitstream decode
- Lossless WebP — VP8L decode
- Complexity: high. Implement only if JPEG + PNG cover the target sites adequately

#### B3.5 Image Scaling

Once decoded, the image must fit in its layout box:

- Nearest-neighbour scaling (fast, pixelated — acceptable for now)
- Bilinear scaling for images scaled down to <50% of natural size
- `object-fit: contain | cover | fill` — respected when set

#### B3.6 Image Cache

- LRU cache keyed by URL, capacity: 8 MB total pixel data
- Entry: `{ url, data: Uint32Array | null, natW, natH, ts }`
- Images fetched asynchronously; page re-renders when an image arrives
- `cache-control: no-cache` respected (skips LRU, re-fetches)

**Acceptance criteria:**
- A Wikipedia article with an infobox image renders the image correctly
- A photo-heavy article (e.g. a species page) loads and displays all images within 5 seconds on the QEMU network

---

### Phase B4 — Fonts

**Goal:** text is readable at multiple sizes and looks like a browser rather than a terminal.

#### B4.1 Bitmap Font Sizes

Extend the existing 8×8 CP437 font approach to three sizes:

| Logical size | Grid | Used for |
|---|---|---|
| Small | 6×10 | `font-size: small`, `<sub>`, `<sup>` |
| Normal | 8×14 | Default body text |
| Large | 10×18 | `<h3>`, `<h4>` |
| X-Large | 12×22 | `<h2>` |
| XX-Large | 16×28 | `<h1>` |

Fonts are embedded in the kernel bundle as CP437-subset bitmap arrays. No external font files needed.

#### B4.2 Bold Variant

For each size, generate a bold variant by shifting the glyph 1 pixel right and OR-ing (pixel doubling in the x direction). This is equivalent to what many 1990s terminal emulators did and is visually acceptable.

#### B4.3 Italic Slant

Apply a 2-pixel horizontal shear over the glyph height to produce a synthetic italic for any size.

#### B4.4 Proportional Glyph Widths (Opt-in)

If proportional text is required for better layout accuracy:

- Each glyph stores an advance width (4–12 px for an 8-wide font)
- IFC line-box calculation uses advance widths instead of fixed `CHAR_W`
- Only implement if the fixed-width layout produces unacceptable wrapping

#### B4.5 Unicode Coverage (Minimum)

Current font covers ASCII 0x20–0x7E. Extend to cover:

- Latin-1 Supplement (0x00A0–0x00FF) — covers most European languages
- General Punctuation (0x2000–0x206F) — em-dash, smart quotes, ellipsis
- Arrows (0x2190–0x21FF)
- Mathematical Operators (0x2200–0x22FF)
- Currency symbols (£ € ¥ ₩ ₽ ₿)
- Box-drawing characters (already in CP437, needed for table borders)
- CJK: out of scope (font memory budget would explode)

**Acceptance criteria:**
- An MDN article heading renders visibly larger than body text
- Bold links in Wikipedia navigation sidebars render bold
- The Euro sign `€` and em-dash `—` render correctly

---

### Phase B5 — JavaScript Engine Enhancements

**Goal:** run more real-world scripts correctly; improve interactivity.

#### B5.1 `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`

The current js runtime wires `setTimeout` and `setInterval` through the WM frame loop. Verify and fix:

- Correct `this` binding when callback is an arrow function vs. named function
- `clearTimeout` / `clearInterval` must cancel pending timers
- Minimum delay is 1 WM frame (≈20 ms at 50 fps)
- Nested `setTimeout(fn, 0)` must not starve rendering

#### B5.2 `requestAnimationFrame`

- `requestAnimationFrame(cb)` → calls `cb(DOMHighResTimeStamp)` before the next paint
- Cancel with `cancelAnimationFrame(id)`
- Drives CSS animation polyfills and vanilla JS animation loops

#### B5.3 `fetch` API

Build a spec-compliant `fetch()` on top of `http.ts`:

```typescript
interface Response {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

fetch(url: string, init?: RequestInit): Promise<Response>
```

- `RequestInit`: method, headers, body, credentials (`omit` | `same-origin`)
- `Headers` class: `get`, `set`, `has`, `append`
- Redirects followed (max 5)
- CORS: same-origin only; no preflight (JSOS is a single-user OS with no browser security model)
- `credentials: 'include'` — attach cookies (cookie jar, see B5.6)

#### B5.4 `XMLHttpRequest`

For older-style pages that don't use `fetch`:

- `open(method, url, async)` — `async=false` is allowed (blocks the frame loop for the duration)
- `send(body?)`
- `onreadystatechange`, `readyState`, `status`, `responseText`, `responseXML`
- `setRequestHeader`, `getResponseHeader`, `getAllResponseHeaders`
- `abort()`

#### B5.5 `MutationObserver`

Track DOM mutations produced by scripts and trigger re-render:

```typescript
new MutationObserver(cb).observe(node, {
  childList: true,
  attributes: true,
  characterData: true,
  subtree: true,
})
```

Batch notifications per microtask checkpoint; fire before next paint.

#### B5.6 Cookie Jar

- `document.cookie` getter/setter
- Persisted in ROMFS / FAT partition under `/data/cookies.json`
- `Set-Cookie` header parsing: `name=val; Path=/; HttpOnly; SameSite=Lax`
- `HttpOnly` cookies never exposed to `document.cookie`
- Session cookies cleared on browser restart
- Max 50 cookies total (memory budget)

#### B5.7 `localStorage` / `sessionStorage`

- `setItem`, `getItem`, `removeItem`, `clear`, `key`, `length`
- `localStorage` persisted to `/data/localstorage/<host>.json`
- `sessionStorage` in-memory, cleared on tab close
- Max 512 KB per host

#### B5.8 `console` API Improvements

Route all console output to the JSOS debug serial port and to an in-browser console drawer:

```typescript
console.log | info | warn | error | debug | group | groupEnd | table | time | timeEnd
```

Toggle console drawer with `F12`.

#### B5.9 `URL` and `URLSearchParams`

```typescript
new URL('https://example.com/foo?a=1&b=2')
new URLSearchParams('a=1&b=2')
```

These are used heavily by modern fetch-based code.

#### B5.10 `Proxy` and `Reflect`

QuickJS supports both natively. Expose them without wrapper — just ensure they're not accidentally shadowed in the page context.

---

### Phase B6 — Navigation + UX

**Goal:** browser feels complete as a day-to-day tool.

#### B6.1 Tabbed Browsing

- Up to 8 simultaneous tabs
- Tab bar rendered above the toolbar
- Each tab has independent history, page state, scroll position, JS runtime, and image cache
- `Ctrl+T` — new tab
- `Ctrl+W` — close current tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab` — cycle tabs
- `Ctrl+1` through `Ctrl+8` — jump to tab N
- Middle-click on link — open in new tab (or `Ctrl+Click`)
- Tab title updates from `<title>` and `document.title`; favicon placeholder (letter icon)

#### B6.2 Download Manager

- Links to non-HTML resources (PDF, ZIP, binary) trigger a download
- Download progress shown in status bar
- Files saved to `/downloads/` on the FAT partition
- `Content-Disposition: attachment` header respected

#### B6.3 Bookmarks

- Currently implemented as session-only. Persist to `/data/bookmarks.json`
- `Ctrl+D` — bookmark current page
- Bookmarks bar (optional row below toolbar, toggle with `Ctrl+Shift+B`)
- Bookmark manager page: `jsos://bookmarks`

#### B6.4 History

- Persist session history to `/data/history.json` (last 500 entries)
- History page: `jsos://history` — searchable list
- `Ctrl+H` opens history page

#### B6.5 Settings Page

`jsos://settings`:

- Home page URL
- Default search engine (DuckDuckGo Lite, Google, custom)
- Image loading: always / never / on JSOS-native only
- JavaScript: enabled / disabled
- Font size: small / normal / large
- Proxy: HTTP proxy host:port
- Clear cookies / clear localStorage / clear history buttons

#### B6.6 Address Bar Improvements

- History-based autocomplete (dropdown, max 8 suggestions)
- Search shortcut: typing a non-URL term navigates to `{searchEngine}?q={term}`
- `Ctrl+L` or `F6` — focus address bar
- `Escape` — cancel edit, restore current URL
- Lock icon shown for HTTPS pages (green) / HTTP pages (grey)

#### B6.7 Find in Page

Already implemented. Improvements:

- Case-insensitive match (currently case-sensitive)
- Hit count shown: "3 of 17"
- Wrap-around with visual indicator
- `Ctrl+F` opens, `Escape` closes, `Enter` / `Shift+Enter` cycle

#### B6.8 Reader Mode

`jsos://reader?url=<url>` — strip chrome, extract main content using a heuristic:

- Use `<article>`, `<main>`, or the largest text block
- Display with generous `max-width`, `line-height: 1.6`, user-chosen font size
- Toggle with `Ctrl+Shift+R`

#### B6.9 Source View

`view-source:<url>` protocol — fetch the URL and display raw HTML with syntax highlighting (tag names in blue, attributes in orange, strings in green, comments in grey).

---

### Phase B7 — Network & Security

**Goal:** HTTPS just works; site credentials survive sessions.

#### B7.1 Complete TLS 1.2

Fill the gaps in `tls.ts`:

- `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256` — primary cipher (already partial)
- `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`
- `TLS_RSA_WITH_AES_128_CBC_SHA256` — fallback
- Session tickets (RFC 5077) — avoid full handshake on revisit
- SNI (`server_name` extension) — already likely present, verify
- Certificate chain verification — check `not_before` / `not_after` against system clock; verify signature chain up to a hardcoded CA bundle

#### B7.2 TLS 1.3

- `TLS_AES_128_GCM_SHA256` and `TLS_AES_256_GCM_SHA384`
- `TLS_CHACHA20_POLY1305_SHA256`
- 0-RTT early data: do not send (security risk without replay protection)
- Key schedule: HKDF-SHA256 / HKDF-SHA384

#### B7.3 CA Bundle

Embed a minimal CA bundle (≈50 roots) as a static TypeScript constant:

- Let's Encrypt ISRG Root X1 (covers ~60% of HTTPS sites)
- DigiCert, Comodo/Sectigo, GlobalSign, Amazon, Google Trust roots
- Compiled into the bundle at build time from Mozilla's CA list

#### B7.4 HTTP/1.1 Keep-Alive

- `Connection: keep-alive` — reuse TCP connections for same-host requests
- Connection pool: max 6 connections per host
- Timeout: 30 s idle

#### B7.5 HTTP Caching

- `Cache-Control: max-age=N` — serve from memory cache if fresh
- `ETag` / `Last-Modified` — conditional requests (`If-None-Match`, `If-Modified-Since`)
- Cache store: in-memory, max 4 MB total
- `Pragma: no-cache` and `Cache-Control: no-cache` bypass cache

#### B7.6 Redirect Handling

- 301, 302, 303, 307, 308 — follow automatically
- Max 10 redirects; error page on loop
- 307/308 preserve method and body
- Update address bar to final URL

#### B7.7 Mixed Content

- HTTPS page loading HTTP sub-resources: block by default (show warning)
- Override available in settings: "Allow mixed content"

---

### Phase B8 — Developer Tools (Inspector)

**Goal:** build JSOS-native apps in the browser.

`F12` toggles the inspector drawer (bottom 40% of window):

#### B8.1 Console Tab

- Already described in B5.8
- Input REPL: evaluate JS in the current page context

#### B8.2 Elements Tab

- Tree view of live DOM (indented, collapsible)
- Click node → highlight in page (draw red rect overlay)
- Click in page → select node in tree
- Computed style panel: shows resolved CSS values for selected element

#### B8.3 Network Tab

- Log of all fetch/XHR/image requests
- Columns: URL, method, status, type, size, timing
- Click → details: request/response headers, response body preview

#### B8.4 Storage Tab

- `localStorage` viewer: table of key/value for current origin, editable
- Cookie viewer: table of cookies for current origin

---

### Phase B9 — JSOS-Native Application Platform

**Goal:** JSOS apps delivered as web pages with full OS access.

#### B9.1 `jsos://` Protocol

Pages served from the ROMFS / FAT partition under `/apps/`:

```
jsos://system-monitor  →  /apps/system-monitor/index.html
jsos://file-manager    →  /apps/file-manager/index.html
jsos://settings        →  /apps/settings/index.html
jsos://repl            →  /apps/repl/index.html
```

#### B9.2 `window.jsos` API

Pages served from `jsos://` origins get access to a privileged API:

```typescript
interface JSOSPageAPI {
  // Filesystem
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<{ size: number; isDir: boolean }>;
    mkdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };
  // Processes
  proc: {
    list(): ProcessInfo[];
    kill(pid: number): void;
    spawn(code: string): number;
  };
  // System
  sys: {
    memoryInfo(): { total: number; used: number; free: number };
    uptime(): number;
    reboot(): void;
  };
  // UI — open browser tabs / child windows
  openTab(url: string): void;
  notify(title: string, body: string): void;
}
```

Unavailable to `http://` / `https://` origin pages.

#### B9.3 App Manifest

`/apps/<name>/manifest.json`:

```json
{
  "name": "System Monitor",
  "icon": "📊",
  "entrypoint": "index.html",
  "permissions": ["fs", "proc", "sys"]
}
```

#### B9.4 App Launcher Page

`jsos://home` — grid of installed app icons, each linking to its `jsos://` URL.

---

## 6. Performance Targets

| Metric | Target |
|---|---|
| Wikipedia article parse + layout | < 500 ms |
| Wikipedia article first paint | < 2 s (on QEMU virtio-net) |
| PNG image decode (256×256) | < 100 ms |
| PNG image decode (1024×768) | < 1 s |
| JPEG decode (640×480, baseline) | < 300 ms |
| JS page (`document.getElementById`, `innerHTML`) | < 50 ms per frame |
| Scroll frame rate | ≥ 30 fps (one `fbBlit` per frame) |
| TLS handshake (ECDHE) | < 2 s |
| DNS lookup (cached) | < 1 ms |
| DNS lookup (network) | < 500 ms |

---

## 7. Memory Budget

The QuickJS heap is capped at 50 MB by the kernel. Browser memory use:

| Component | Budget |
|---|---|
| Current page DOM + layout | 2 MB |
| Image LRU cache | 8 MB |
| HTTP response cache | 4 MB |
| JS runtime heap (page scripts) | 8 MB |
| Stylesheet cache | 512 KB |
| Cookie jar + localStorage | 1 MB |
| Font bitmaps | 256 KB |
| History / bookmarks | 64 KB |
| **Total** | **≈ 24 MB** |

This leaves ≈ 26 MB headroom for the kernel, OS services, and other apps.

---

## 8. File Layout (Target)

```
src/os/apps/browser/
  index.ts          — BrowserApp shell (existing, extended)
  types.ts          — all interfaces (existing, extended)
  constants.ts      — layout + colour constants (existing, extended)
  css.ts            — color + inline style parser (existing)
  stylesheet.ts     — NEW: <style> / <link> CSS parser
  cascade.ts        — NEW: specificity + computed style resolution
  html.ts           — HTML tokeniser + parser (existing)
  dom.ts            — virtual DOM (existing, extended)
  layout.ts         — NEW: full box model layout engine (replaces current)
  jsruntime.ts      — JS page runtime (existing, extended)
  pages.ts          — about: pages (existing)
  utils.ts          — URL, base64, encoding (existing)
  img-png.ts        — NEW: pure-TS PNG decoder
  img-jpeg.ts       — NEW: pure-TS JPEG decoder
  img-gif.ts        — NEW: pure-TS GIF decoder
  img-cache.ts      — NEW: LRU image cache + async fetch
  http-cache.ts     — NEW: HTTP response cache
  cookie.ts         — NEW: cookie jar
  storage.ts        — NEW: localStorage + sessionStorage
  tabs.ts           — NEW: multi-tab state manager
  inspector.ts      — NEW: F12 developer tools
  reader.ts         — NEW: reader mode extractor
```

---

## 9. Prioritised Backlog

In strict priority order:

1. **B1** — CSS stylesheet parser + cascade + box model properties
2. **B3.1** — PNG decoder (single most impactful image format)
3. **B2** — Full block layout engine
4. **B5.3** — `fetch` API cleanup + `Promise` plumbing
5. **B7.1** — Complete TLS 1.2 with certificate verification
6. **B3.2** — JPEG decoder
7. **B6.1** — Tabs
8. **B4** — Multi-size bitmap fonts
9. **B5.6** — Cookie jar
10. **B7.4** — HTTP keep-alive + connection pool
11. **B6.2** — Downloads
12. **B7.2** — TLS 1.3
13. **B5.1–B5.5** — JS runtime completeness
14. **B8** — Developer tools
15. **B9** — JSOS-native app platform
16. **B6.8** — Reader mode
17. **B3.3** — GIF decoder
18. **B2.6** — Flexbox

---

## 10. Acceptance Test Sites

These sites form the browser's integration test suite, manually verified after each phase:

| Site | Minimum pass criteria |
|---|---|
| `https://en.wikipedia.org/wiki/JavaScript` | Text renders, infobox visible, links work |
| `https://developer.mozilla.org/en-US/docs/Web/HTML` | Code blocks, navigation sidebar readable |
| `https://news.ycombinator.com` | Posts + scores + links visible |
| `https://lite.duckduckgo.com/lite` | Search form works, results navigate correctly |
| `https://text.npr.org` | Full article text renders |
| `jsos://about` | JSOS about page (existing) |
| `jsos://system-monitor` | Process list, memory bar (Phase B9) |
| `data:text/html,<h1>Hello</h1>` | Inline `data:` URL renders |
| `view-source:https://example.com` | Source view with syntax highlight |

---

## 11. Out of Scope (Explicitly)

- Adobe Flash, Java Applets, Silverlight — not relevant
- Service Workers — require background process + Cache API, exceeds memory budget
- WebSockets — could be added later as a thin wrapper over `net.ts` TCP
- WebRTC — requires STUN/TURN, out of scope for v1
- CSS Grid (full) — implement flexbox first, grid is lower ROI for doc-centric sites
- `<video>` / `<audio>` — no codec, no audio driver
- Shadow DOM — too complex for the current renderer model
- Custom elements / Web Components — deferred
- PWA / manifest install — deferred post Phase B9

---

*This document is maintained in `docs/browser-prd.md`. Update it as phases complete or requirements change.*
