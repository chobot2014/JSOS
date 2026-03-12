# Browser Rendering Engineering Plan

**Date:** 2025-01-XX  
**Branch:** JIT-DESKTOP-8  
**Last commit:** eae2095 (SVG rendering fixes)  
**Goal:** Render Google.com (and modern websites) with visible, usable content

---

## Current State

The JSOS browser can:
- Fetch pages over HTTPS/H2 (TLS 1.3, ALPN)
- Parse HTML into a token stream and build render nodes
- Parse CSS (803 rules from Google, with `var()`, `calc()`, media queries, `@supports`)
- Execute inline JavaScript (via QuickJS ES2023 sandboxed child runtime)
- Layout with flexbox, grid, block/inline flow
- Render SVG icons, text, backgrounds, borders, gradients
- Composite to a 1024×768 framebuffer at 32bpp

**The problem:** Google.com renders almost completely blank — only 3–4 SVG icons are visible. No search bar, no logo text, no buttons, no links.

**Why:** Pass1 (no CSS) produces 114 render nodes. Pass2 (with CSS) produces **4 nodes**. Google's CSS hides nearly all static HTML content with `display:none`, expecting JavaScript to dynamically build and reveal the UI. Our JS runtime executes some inline scripts but cannot fully run Google's XJS bundle (times out at 15s), so the page stays hidden.

---

## Root Cause Analysis

### The 114 → 4 Node Drop

Google serves HTML structured for a JavaScript-driven SPA:

1. Most `<div>` elements have classes like `.gb_*`, `.hp*`, `.o3j99` that are set to
   `display:none` in Google's CSS.
2. JavaScript is expected to add/remove classes, create DOM nodes, and call
   `element.style.display = ''` to reveal content.
3. Our JS runtime *does* execute inline scripts, but Google's main external script
   (`xjs.hd.en.*.js`, ~200KB) times out because the H2 fetch for it hits a dedup
   queue collision or the script itself is too complex to eval in time.
4. Without that script, the page stays in its CSS-hidden initial state.

### The `<noscript>` Fallback — Broken in 3 Places

Google provides `<noscript>` content with a functional search page for browsers
without JavaScript. This is exactly what we should render when our JS can't fully
execute the page scripts. But `<noscript>` is broken:

| # | Bug | File | Line |
|---|-----|------|------|
| 1 | `NOSCRIPT:"none"` in `_defaultDisplayMap` — JS runtime's `getComputedStyle` returns `display:none` for noscript elements, which triggers CSS-based hiding during re-render | `jsruntime.ts` | 1051 |
| 2 | `noscript` in `_RAW_TEXT` set — the DOM fragment parser treats noscript content as raw text instead of parsing it as child HTML elements, so `innerHTML` operations on noscript produce flat text, not DOM nodes | `dom.ts` | 3001 |
| 3 | The HTML parser `case 'noscript'` is a no-op `break` — it doesn't skip or render differently; it relies on CSS to determine visibility. But since CSS may hide it (via the display map or Google's own CSS rules), the children get skipped in pass2. | `html.ts` | 1000 |

### What Google.com Actually Needs

In priority order, the page needs:

1. **`<noscript>` fallback to render** — Google serves a complete search interface
   inside `<noscript>` that includes the logo, search bar, and basic links.
2. **CSS `display:none` on noscript overridden** — either by treating noscript as
   `display:block` in the UA stylesheet, or by forcibly not hiding its children.
3. **External script loading** — the XJS bundle needs to actually arrive and execute.
   Currently it either times out (15s) or the H2 dedup queue drops it.
4. **DOM mutation from JS** — when scripts run, they call `document.createElement`,
   `element.classList.add/remove`, `element.style.display = ''`, etc. These APIs
   exist but the re-render pipeline may not trigger layout recalculation.
5. **Font metrics** — all text renders in a fixed bitmap font (8×16). Google's CSS
   sizes elements based on web font metrics (Google Sans). Layout width/height
   calculations are off because our character widths don't match.

---

## Engineering Work Items

### P0 — Critical: Make Content Visible

#### P0.1: Fix `<noscript>` Rendering (Est: 2 hours)

**Files:** `html.ts`, `dom.ts`, `jsruntime.ts`

1. **Remove `noscript` from `_RAW_TEXT`** in `dom.ts` line 3001 — its content is HTML,
   not raw text.
2. **Change `NOSCRIPT:"none"` → `NOSCRIPT:"block"`** in `jsruntime.ts` line 1051 —
   since our JS runtime can't fully execute modern page scripts, noscript content
   should be visible. This aligns with the principle that a browser that can't run
   JS should show noscript content.
3. **In `html.ts`, force noscript content to render** — in the `case 'noscript'`
   handler, suppress `skipDepth` for noscript children regardless of CSS rules.
   This ensures Google's CSS cannot hide the noscript fallback.
4. **Add `<noscript>` as a block-level element** — ensure `pushCSS` treats it like
   a `<div>` and doesn't inherit parent `display:none`.

**Validation:** Pass2 should produce >4 nodes for Google.com. The noscript search
interface should be visible in the screenshot.

#### P0.2: Debug the CSS Rules Hiding Content (Est: 3 hours)

**Files:** `html.ts`, `stylesheet.ts`

1. **Add diagnostic logging** — when `skipDepth` transitions from 0 to 1 (first
   hide), log the element tag, classes, and the CSS rule that set `display:none`.
   This tells us exactly which CSS rules are causing the 114→4 drop.
2. **Audit the specific rules** — determine whether it's Google's CSS or our CSS
   matching that's too aggressive.
3. **Consider a UA stylesheet override** — add a user-agent `display:block` for
   common structural elements (`div`, `span`, `form`, `input`, etc.) that Google's
   CSS hides, but only when JS execution is considered incomplete.

**Validation:** Log output identifies the exact CSS rules. After fix, >20 nodes survive pass2.

#### P0.3: Fix External Script Loading (Est: 4 hours)

**Files:** `index.ts`, `jsruntime.ts`, network stack

1. **Debug the H2 fetch dedup collision** — the log shows `[fetch] dedup hit for
   www.google.com/xjs/_/js/k=xjs...` which means a second request for the same URL
   is being deduped but the original never completes. Fix the dedup logic to ensure
   callbacks fire when the original request finishes.
2. **Increase the external script timeout** — 15s may not be enough given network +
   TLS + H2 overhead on bare metal. Consider 30s or 60s.
3. **Add script loading progress logs** — log when external script bytes arrive, so
   we can distinguish between "never received" and "received but failed to eval".

**Validation:** The XJS bundle downloads and begins execution. Log shows
`[JS eval] ... xjs.*.js` instead of timeout.

---

### P1 — High Impact: Make Content Correct

#### P1.1: JS-Triggered Re-render Pipeline (Est: 4 hours)

**Files:** `jsruntime.ts`, `index.ts`

When JavaScript modifies the DOM (adds/removes elements, changes classes, modifies
styles), the browser needs to re-layout and re-paint. Currently:
- `MutationObserver` fires but doesn't trigger layout.
- `element.style.display = ''` updates the style map but doesn't recalculate layout.
- `innerHTML` parses and inserts nodes but doesn't trigger re-render.

**Work:**
1. Add a "dirty" flag to the document that gets set on any DOM mutation.
2. After each JS script/eval completes, if the document is dirty, re-run pass2 and
   re-layout.
3. Batch mutations (don't re-render on every single DOM change — wait for microtask
   queue to flush).

#### P1.2: Proportional Font Metrics (Est: 6 hours)

**Files:** `layout.ts`, `layout-ext.ts`, text rendering

All text uses 8px-wide monospace characters. Real websites size elements based on
proportional font metrics. This causes:
- Search bars too wide or too narrow
- Buttons with wrong padding
- Text wrapping at wrong positions

**Work:**
1. Implement a proportional font width table (can be hardcoded for a standard
   sans-serif — no font loading needed initially).
2. Update `textWidth` JIT kernel and `CHAR_W` usage in layout to use proportional
   widths.
3. Update `LINE_H` to be CSS-configurable (currently hardcoded at 16px).

#### P1.3: Image Format Support Audit (Est: 2 hours)

**Files:** Image decoding pipeline

Google serves PNG, JPEG, WebP, and base64-encoded inline images. Verify:
1. PNG decoding works (it does — confirmed via SVG icons).
2. JPEG decoding works.
3. WebP decoding works (or gracefully falls back).
4. Base64 data URLs are decoded and rendered.

---

### P2 — Correctness: Make It Look Right

#### P2.1: CSS `position: absolute/fixed` Rendering (Est: 4 hours)

**Files:** `layout.ts`

Google uses absolute/fixed positioning for:
- The search suggestions dropdown
- The settings menu
- The "Sign in" button positioning

Currently, positioned elements are laid out in normal flow (no offset from
containing block).

#### P2.2: `overflow: hidden` and Clipping (Est: 3 hours)

**Files:** `index.ts` (paint), `layout.ts`

Elements with `overflow: hidden` should clip child content. Currently, children
render outside their parent's bounds, causing visual glitches.

#### P2.3: CSS `box-shadow` and `border-radius` Polish (Est: 3 hours)

**Files:** `index.ts` (paint)

The Google search bar has `border-radius` and `box-shadow`. Both are parsed but
rendering may be incomplete (no rounded corner clipping, simplified shadow).

#### P2.4: `transform` Rendering (Est: 6 hours)

**Files:** Layout + paint pipeline

CSS `transform: translate/scale/rotate` is parsed and stored but never applied
during painting. Google uses transforms for hover effects and layout.

#### P2.5: `@font-face` and Web Fonts (Est: 8 hours)

**Files:** Font loading + text rendering

Currently all text is a single 8×16 bitmap font. Web fonts require:
1. Fetching font files (WOFF2/WOFF/TTF)
2. Parsing TrueType/OpenType tables (or a simpler bitmap-from-vector approach)
3. Caching parsed glyphs
4. Using correct metrics for layout

This is a large effort but dramatically improves visual fidelity.

---

### P3 — Future: Full Browser Engine

These are tracked for completeness but not required for Google.com:

| Item | Effort | Notes |
|------|--------|-------|
| Shadow DOM style encapsulation | 4h | Google search bar uses it |
| CSS Animations runtime | 8h | Interpolate properties over time |
| CSS Transitions runtime | 4h | Smooth hover/focus effects |
| `filter` / `backdrop-filter` rendering | 6h | Blur, drop-shadow, etc. |
| Canvas 2D drawing operations | 8h | Google Doodles, charts |
| `window.matchMedia` change events | 2h | Responsive layout recalculation |
| WebSocket transport | 4h | Real-time apps |
| RTL text / `writing-mode` | 6h | Internationalization |
| `clip-path` rendering | 4h | Shaped clipping |
| Selection API / copy-paste | 4h | Text selection, clipboard |

---

## What We Already Have (Don't Rebuild)

The audit reveals the browser is much more complete than expected:

- **DOM APIs:** `createElement`, `appendChild`, `innerHTML`, `classList`, `querySelector/All`,
  `closest`, `matches`, `cloneNode`, `insertAdjacentHTML`, `MutationObserver`,
  `IntersectionObserver`, `ResizeObserver`, `CustomEvent`, `dispatchEvent`,
  `addEventListener` with capture/bubble, `Range`, `DOMParser`, Custom Elements,
  Service Workers, `structuredClone`
- **CSS:** `var()`, `calc()`, `min/max/clamp()`, 100+ color functions (`oklch`, `color-mix`,
  `hwb`, `lab`, `lch`), `@media`, `@supports`, `@container`, `@layer`, CSS nesting,
  `!important`, `inherit/initial/unset/revert`, `::before/::after` with counters,
  flexbox, grid, specificity, `[attr]` selectors (all operators + case-insensitive),
  `:not()`, `:is()`, `:where()`, `:has()`, `:nth-child()`, pseudo-classes
- **Network:** TLS 1.3, H2 multiplexing, fetch API with CORS/CSP, XMLHttpRequest,
  Streams API, Service Worker fetch interception
- **JS Runtime:** QuickJS ES2023, child runtime sandboxing, `setTimeout/setInterval`,
  `requestAnimationFrame`, `fetch`, `structuredClone`, Proxy, WeakRef, async/await

---

## Implementation Order

```
Week 1: P0.1 (noscript fix) → P0.2 (CSS debug) → P0.3 (script loading)
         └─ Validate with screenshot automation after each fix

Week 2: P1.1 (re-render pipeline) → P1.2 (font metrics) → P1.3 (image audit)

Week 3+: P2.x items by impact
```

Each fix should be:
1. Implemented
2. Built (`npm run build`)
3. Screenshot captured (`.\scripts\screenshot.ps1`)
4. Compared to previous screenshot
5. Committed if positive delta

---

## Success Metrics

| Milestone | Metric |
|-----------|--------|
| **M1: Content visible** | Google.com pass2 produces >20 render nodes. Search bar or logo visible in screenshot. |
| **M2: Functional search** | Search input field rendered. Text entry works. Form submission navigates. |
| **M3: Visual parity** | Google.com recognizable as Google. Colors, layout, spacing approximately correct. |
| **M4: Comparable to Lynx** | Content parity with text-based browser (all text, links, forms visible). |
| **M5: Modern rendering** | Rounded corners, shadows, gradients, proper font rendering. |

---

## Screenshot Automation

The `scripts/screenshot.ps1` tool enables automated iteration:

```powershell
# Default: wait for CSS parse, 5s paint delay
.\scripts\screenshot.ps1

# Custom marker and delay
.\scripts\screenshot.ps1 -WaitFor "rerender.*done" -Delay 10

# Keep QEMU running for manual inspection
.\scripts\screenshot.ps1 -KeepRunning
```

Output: `test-output/screenshot.png` (1024×768)

---

*This document should be updated as fixes are implemented and new issues are discovered.*
