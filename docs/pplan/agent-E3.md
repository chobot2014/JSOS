# Agent E3 — Browser Layout / Rendering / Forms / Navigation / Performance

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §11 Layout Engine | 441–470 |
| §12 Rendering | 471–496 |
| §15 Forms | 593–618 |
| §16 Navigation | 619–641 |
| §28c Layout Perf | 891–904 |
| §28d Render Perf | 905–921 |
| §28f CSS Perf | 943–952 |
| §28g JS/Event Perf | 953–965 |
| §28h Benchmarking | 966–977 |

---

## Source Files to Read

```
src/os/apps/browser/layout.ts
src/os/apps/browser/index.ts     ← browser main; navigation, tab management
src/os/apps/browser/perf.ts      ← performance.now, marks, measures
src/os/apps/browser/cache.ts     ← image cache, resource cache, HTTP cache
```

---

## Focus Areas

**Layout (§11):**
- Block Formatting Context (BFC): when triggered, margin collapsing rules
- Inline Formatting Context (IFC): line boxes, baseline alignment
- Width/height `auto` calculation
- Min/max width/height constraints
- Margin collapsing edge cases (nested, empty blocks)
- Float: left/right, clearing (`clear: both`), float intrusion into line boxes
- `position: static/relative/absolute/fixed`
- `z-index` stacking contexts
- `overflow: hidden/scroll/auto`
- `<li>` list marker positioning
- Flexbox layout algorithm (already partially done — find gaps)
- Grid layout algorithm
- Absolute positioning containing block calculation
- Out-of-flow layout coordination
- `writing-mode` / RTL — likely absent

**Rendering / Painting (§12):**
- Stacking context paint order (background → outline → block children →
  float children → inline children → positioned children)
- Image decode and display (`<img src>`)
- Image cache (avoid re-decode on same URL)
- Text rendering: font selection, fallback fonts, kerning
- SVG rendering — likely absent or minimal
- `<canvas>` 2D context — likely absent or minimal
- Dirty-rect tracking (only repaint changed regions)
- Double buffering
- z-index respecting paint order

**Forms (§15):**
- `<input type="text/password/email/number/checkbox/radio/file/hidden/submit/reset/button/range/date/color">`
- `<textarea>`, `<select>/<option>/<optgroup>`
- `<label for>` association
- Required field validation, pattern validation, custom validity
- Form `action` submit — GET vs POST
- `application/x-www-form-urlencoded` encoding
- `multipart/form-data` encoding
- Autofocus, tabindex

**Navigation (§16):**
- Address bar input + URL parsing + navigate
- Back / Forward button (history stack)
- Bookmark storage and retrieval
- Find-in-page (Ctrl+F)
- Page title update (`document.title`)
- `window.open()`, `window.close()`
- Download attribute on `<a>`

**Performance (§28c–h):**
- `performance.now()` with sub-millisecond resolution
- `performance.mark()`, `performance.measure()`, `performance.getEntries()`
- `requestAnimationFrame` timing accuracy
- `requestIdleCallback` with deadline
- Paint/layout timing (`PerformanceObserver` with `paint`/`layout-shift` entries)
- Incremental layout (only re-layout dirty subtrees)
- Style invalidation scope
- JS event loop integration with layout/render pipeline

---

## Already Marked — Skip These

```
442, 444, 445, 446, 447, 450, 451, 453, 454, 456, 475, 488,
593, 594, 595, 596, 597, 598, 599, 600, 601, 602, 603, 604,
619, 620, 621, 622, 623, 624, 625, 626, 627, 628, 629, 630,
631, 632, 633, 637, 638,
891, 896, 897, 905, 906, 911, 923, 926, 933, 934, 936,
943, 944, 945, 946, 953, 954, 955, 956, 957, 958, 959,
962, 963, 964, 966, 967, 968, 971
```
