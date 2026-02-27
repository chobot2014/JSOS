# Agent E2 — Browser HTML Parser / CSS Engine

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §9 HTML Parser | 349–372 |
| §10 CSS Engine | 373–440 |

---

## Source Files to Read

```
src/os/apps/browser/html.ts
src/os/apps/browser/css.ts
src/os/apps/browser/stylesheet.ts   ← may not exist; check
```

---

## Focus Areas

**HTML Parser (§9):**
- Named entity table: `&nbsp;`, `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`
  — and the full ~2000-entry HTML5 named character reference table?
- Numeric character references: `&#xHHHH;`, `&#NNNN;`
- Void elements: `<br>`, `<img>`, `<hr>`, `<input>`, `<meta>`, `<link>` — no closing tag required
- Script and style CDATA handling (`</script>` search, not tag-soup parsing)
- `<textarea>` and `<pre>` — preserve whitespace
- Implicit tag closing: `</p>` before new block, `</li>` before new `<li>`
- `<template>` element — parsed but not rendered
- `<canvas>` element — declared?
- `<base href>` — affects relative URL resolution
- `<picture>` / `<source>` srcset handling
- `<details>` / `<summary>`
- SVG inline parsing — likely minimal or absent
- MathML — likely absent
- `doctype` detection — affects quirks mode?
- Character encoding detection (`<meta charset>`, BOM)

**CSS Engine (§10):**
- At-rules: `@media`, `@import`, `@supports`, `@keyframes`, `@font-face`, `@layer`
- Media query parsing: `min-width`, `max-width`, `orientation`, `prefers-color-scheme`
- Specificity calculation: inline > ID > class > element
- Pseudo-classes: `:hover`, `:focus`, `:active`, `:visited`, `:first-child`,
  `:last-child`, `:nth-child(n)`, `:not()`, `:is()`, `:where()`, `:has()`
- Pseudo-elements: `::before`, `::after`, `::placeholder`, `::selection`,
  `::first-line`, `::first-letter`
- Cascade and `!important`
- CSS custom properties (`--foo: bar`, `var(--foo)`)
- `calc()` — arithmetic with mixed units
- `clamp()`, `min()`, `max()`
- `color-mix()`, `oklch()`, `lab()`
- CSS transitions: `transition-property`, `transition-duration`, `transition-timing-function`
- CSS animations: `@keyframes`, `animation-name`, `animation-duration`
- CSS transforms: `translate`, `rotate`, `scale`, `matrix`, `perspective`
- `background` shorthand (color + image + position + size + repeat + origin + clip)
- Flexbox properties (all of them: `flex-direction`, `flex-wrap`, `gap`, `align-items`, etc.)
- Grid properties (`grid-template-columns`, `fr`, `minmax`, `span`, `grid-area`)
- `contain`: `layout`, `paint`, `style`, `size`
- `aspect-ratio`
- Logical properties (`margin-inline`, `padding-block`)
- CSS `env()` variables

---

## Already Marked — Skip These

```
350, 351, 352, 353, 354, 355, 356, 359, 364, 366,
373, 374, 375, 376, 377, 378, 379, 380, 381, 382,
383, 384, 385, 386, 387, 388, 389, 390, 391, 392,
393, 394, 395, 396, 397, 398, 399, 400, 401, 402,
403, 404, 405, 406, 407, 408, 409, 410, 411, 412,
413, 417, 431, 435, 440
```

---

## Tips

- `html.ts` likely has a tokenizer/parser class — look for `HTMLParser`, `tokenize()`,
  `parseHTML()` as entry points.
- `css.ts` likely has a `CSSParser` class and a `StyleSheet` or `CSSOM` structure.
- For pseudo-classes, search for `':hover'`, `':nth-child'`, `':not'` as string literals.
- For at-rules, search for `'@media'`, `'@keyframes'`.
