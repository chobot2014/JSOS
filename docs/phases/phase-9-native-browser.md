# Phase 9: JSOS Native Browser

## Overview

Phase 9 delivers the JSOS native TypeScript browser — a fully featured web browser written
100% in TypeScript, running natively on the JSOS kernel.

**No Chromium. No external runtimes. TypeScript IS the browser.**

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      JSOS Browser (TS)                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  BrowserApp (src/os/apps/browser.ts)                   │ │
│  │   URL bar · History · Tabs · Scroll · Link clicking    │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                        │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │  HTML Parser + Layout Engine                           │ │
│  │   tokenise() · parseHTML() · layoutNodes() · wrapText()│ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                        │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │  JSOS Network Stack                                    │ │
│  │   dnsResolve() · httpGet() · httpsGet()                │ │
│  └──────────────────┬──────────────────────────────────────┘ │
│                     │                                        │
│  ┌──────────────────▼──────────────────────────────────────┐ │
│  │  Canvas / WM (Phase 3 / 8)                             │ │
│  │   fillRect · drawText · drawLine · flip()              │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Components

### `src/os/apps/browser.ts`

The entire browser in one TypeScript file, ~600 lines:

| Component        | Description |
|------------------|-------------|
| `parseURL()`     | URL parser — handles `http://`, `https://`, `about:`, relative paths |
| `tokenise()`     | HTML tokeniser — produces a flat list of open/close/text tokens |
| `parseHTML()`    | Builds a `RenderNode[]` tree from tokens |
| `wrapText()`     | Word-wraps text to a column limit |
| `layoutNodes()`  | Converts `RenderNode[]` to `RenderedLine[]` with absolute `y` offsets |
| `BrowserApp`     | WM `App` class: toolbar, content, status bar, events, navigation |

### HTML support

Tags rendered natively:

| Tag | Rendering |
|-----|-----------|
| `<h1>`–`<h6>` | Coloured headings with extra line spacing |
| `<p>`, `<div>` | Paragraph breaks |
| `<a href>` | Underlined links, clickable, visited tracking |
| `<ul>`, `<ol>`, `<li>` | Bullet list items |
| `<br>`, `<hr>` | Line break, horizontal rule |
| `<pre>`, `<code>` | Monospace background |
| `<title>` | Window/tab title |

HTML entities decoded: `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` `&nbsp;` `&#NNN;`

### Navigation

- **Back / Forward** buttons (mouse click or `b`/`f` keys)
- **Reload** (`R` button)
- **URL bar** — click or press `/` or `l` to focus; Enter to navigate
- **History** — `about:history` shows full browsing history with clickable links
- **Redirect following** — single-level 3xx redirect support

### Built-in pages

| URL | Content |
|-----|---------|
| `about:blank` | Empty page |
| `about:jsos` | JSOS browser home page |
| `about:history` | Browsing history |

### Network fetch flow

```
navigate(url)
  └─ parseURL()               → { protocol, host, port, path }
  └─ dnsResolve(host)         → IP address (UDP/RFC 1035 in TS)
  └─ httpGet / httpsGet       → HttpResponse { status, headers, body }
  └─ parseHTML(body)          → RenderNode[]
  └─ layoutNodes()            → RenderedLine[]
  └─ canvas.drawText/fillRect → pixels on screen
```

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Enter (in URL bar) | Navigate to URL |
| Esc | Unfocus URL bar |
| `/` or `l` | Focus URL bar |
| `b` | Back |
| `f` | Forward |
| Space | Scroll down one page |
| Arrow Up/Down | Scroll |

## REPL integration

```javascript
// Navigate from the REPL
sys.browser('http://example.com')
```

## Init service (runlevel 5)

The browser is registered as a runlevel-5 JS service in `init.ts`:

```typescript
{
  name:        'browser',
  description: 'JSOS native TypeScript browser',
  executable:  '/bin/browser.js',
  runlevel:    5,
  dependencies: ['network', 'display'],
}
```

## What was removed (from Phase 9 Chromium port plan)

| Removed | Why |
|---------|-----|
| `chromium/` directory | Entire C++ Ozone/DRM/GL platform port — no longer needed |
| `lib/gbm-jsos/` | GBM shim (Chromium GPU buffer allocation) — no longer needed |
| `lib/swiftshader/` | C++ SwiftShader bridge stubs — no longer needed |
| `src/os/apps/chromium-app.ts` | Chromium splash screen WM app — replaced by `browser.ts` |
| `init.ts` chromium service | ELF exec `/disk/chromium` — replaced by JS browser service |
| `main.ts` `sys.launch_chromium()` | REPL launcher — replaced by `sys.browser()` |

The SwiftShader TypeScript backend (`src/os/graphics/swiftshader.ts`) and the DRM shim
(`src/os/fs/drm.ts`) are retained — they serve the WM compositing and graphics stack.

## Design principle

> TypeScript is not a guest in this OS — TypeScript IS the OS.
>
> And every application, including the browser, runs natively in TypeScript.
