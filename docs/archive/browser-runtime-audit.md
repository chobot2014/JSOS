# JSOS Browser Runtime Audit — Google.com & YouTube.com Compatibility

**Date**: 2026-03-06  
**Files audited**: `jsruntime.ts` (7220 lines), `dom.ts` (3033 lines), `css.ts` (1161 lines), `layout.ts` (1298 lines), `layout-ext.ts`, `perf.ts`

---

## PRIORITY 1 — Critical for Google.com (will crash or produce blank page)

### 1.1 `window.postMessage` is a no-op
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L5571)
- **Issue**: `postMessage: (_data: unknown, _origin?: string): void => {}` — completely empty
- **Impact**: Google uses `postMessage` extensively for cross-frame communication, ad frames, and consent dialogs. Without it, the consent flow and many Google services will silently fail.
- **Fix**: Dispatch a `MessageEvent` on `window` asynchronously with `data`, `origin`, `source` fields.

### 1.2 `crypto.subtle` is a stub returning empty Promises
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L3953-L3971)
- **Issue**: `digest()`, `encrypt()`, `decrypt()`, `sign()`, `verify()`, `generateKey()`, `importKey()`, `exportKey()`, `deriveKey()`, `deriveBits()`, `wrapKey()`, `unwrapKey()` all return `Promise.resolve({})` or similar meaningless values.
- **Impact**: Google uses `crypto.subtle.digest('SHA-256', ...)` for integrity checks, session tokens, and CSP. YouTube uses it for DRM-related operations.
- **Fix**: At minimum implement `digest()` with real SHA-256/SHA-1 hashing. Other methods can remain stubs.

### 1.3 Custom Elements `upgrade()` is a no-op
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4056)
- **Issue**: `upgrade(_root: unknown): void {}` — does nothing
- **Impact**: When `customElements.define()` is called *after* elements already exist in the DOM, those pre-existing elements need to be upgraded. YouTube defines components lazily, so elements parsed from HTML before `define()` is called remain inert.
- **Fix**: Implement `upgrade()` to walk the subtree, find matching tag names, and re-instantiate via the registered constructor.

### 1.4 Custom Elements — construction and callbacks ARE partially implemented ✅
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L5930-L5945) (createElement), [L6938-L6957](src/os/apps/browser/jsruntime.ts#L6938) (ceInsertHook)
- **Status**: `createElement()` checks `_ceRegistry` and calls `new Ctor()` ✅. `_ceInsertHook` fires `connectedCallback` on DOM insertion ✅. Prototype methods are copied for elements not created via CE constructor ✅.
- **Remaining gaps**:
  - `upgrade()` is empty (see 1.3)
  - `attributeChangedCallback` + `observedAttributes` not wired — attribute mutations won't notify the CE
  - `disconnectedCallback` invocation not verified on removal
  - `adoptedCallback` not implemented
  - Elements parsed from HTML before `define()` are NOT upgraded automatically

### 1.5 Shadow DOM is minimal — no style encapsulation
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1671-L1692)
- **Issue**: `attachShadow()` creates a child `VElement` with `_isShadowRoot = true` but:
  - No style scoping — stylesheets inside shadow roots leak out and vice versa
  - `mode: 'closed'` doesn't prevent `shadowRoot` access (always returns it)
  - `adoptedStyleSheets` array exists but is never applied by `getComputedStyle`
  - No `innerHTML` parsing into shadow root content
- **Impact**: YouTube and Google use Shadow DOM extensively for encapsulated components.
- **Fix**: `getComputedStyle` must scope CSS cascade to shadow boundaries. `adoptedStyleSheets` must be consulted.

### 1.6 `<template>` content is handled but shadow DOM styles aren't scoped
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1066-L1080)
- **Status**: Template `.content` fragment works ✅, cloning works ✅, serialization works ✅
- **Issue**: When template content is cloned into a shadow root, the styles aren't scoped.

### 1.7 Service Worker `register()` rejects immediately
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4447-L4459)
- **Issue**: `register()` → `Promise.reject(NotSupportedError)`. `ready` never resolves.
- **Impact**: Google.com and YouTube both attempt to register service workers. The rejection will trigger error handlers that may abort initialization. Some Google code checks `'serviceWorker' in navigator` for feature detection.
- **Fix**: Return a mock registration object that resolves instead of rejecting. `ready` should resolve with a mock registration.

---

## PRIORITY 2 — High Impact (visible breakage, missing content)

### 2.1 `getComputedStyle` doesn't handle pseudo-elements
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L3353)
- **Issue**: The `_pseudoElt` parameter is accepted but ignored. `::before`, `::after` styles are never returned.
- **Impact**: Google uses `getComputedStyle(el, '::before')` for icon rendering via CSS content property. Returns wrong values.

### 2.2 `Blob.stream()` returns null
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1912)
- **Issue**: `stream(): unknown { return null; }` — should return a `ReadableStream`.
- **Impact**: Modern APIs that consume Blob content via streaming will break.

### 2.3 `CompressionStream` / `DecompressionStream` are pass-through stubs
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4684)
- **Issue**: Data passes through unchanged; no actual gzip/deflate/brotli compression.
- **Impact**: Google serves compressed data and expects the browser to decompress.

### 2.4 `IndexedDB` is in-memory only, no persistence
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L2261-L2340)
- **Status**: Working in-memory implementation with objectStore, transactions, cursors ✅
- **Issue**: Data lost on navigation/reload. No real `IDBIndex` (`.index()` returns `this`). `IDBKeyRange` is trivial.
- **Impact**: Google stores session data, preferences, and analytics in IDB. Lost on reload.

### 2.5 `DOMParser.parseFromString` ignores MIME type
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L3977)
- **Issue**: `_type` parameter is ignored; always parses as HTML. XML/SVG parsing needed for some Google features.

### 2.6 `Intl` API uses minimal stubs when native `Intl` is unavailable
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L2344-L2390)
- **Issue**: `DateTimeFormat`, `NumberFormat`, `Collator`, `PluralRules`, `RelativeTimeFormat`, `ListFormat` are all stub classes with trivial `format()` methods. `resolvedOptions()` returns `{}`.
- **Impact**: Google UI heavily localizes dates, numbers, and lists. Will display raw/ugly values.

### 2.7 `matchMedia` evaluates against fixed 1024×768 viewport
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L5154-L5210)
- **Status**: Good coverage of media features: width, height, aspect-ratio, orientation, color-scheme, reduced-motion ✅  
- **Issue**: Hardcoded to 1024×768 instead of using actual viewport. `addListener`/`addEventListener` for change events may not fire on resize.
- **Minor fix**: Use actual viewport dimensions from css.ts `getViewport()`.

### 2.8 Web Animations API is a no-op stub
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1472-L1497)
- **Issue**: `element.animate()` returns stub object: `reverse()`, `updatePlaybackRate()`, `commitStyles()`, `persist()`, `addEventListener()`, `removeEventListener()` are all empty. `finished` promise never resolves.
- **Impact**: Google uses CSS animations via the Web Animations API for UI transitions. Animations won't complete, can stall JS waiting on `.finished`.
- **Fix**: At minimum make `finished` resolve immediately.

### 2.9 `document.fonts` is a no-op stub
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L2135-L2148)
- **Issue**: `add()`, `delete()`, `clear()`, `forEach()`, `has()` are all no-ops. `ready` resolves but the set is empty. `check()` always succeeds.
- **Impact**: Google loads custom fonts and waits on `document.fonts.ready`. Layout may proceed with wrong font metrics.

---

## PRIORITY 3 — Medium Impact (degraded UX, non-fatal errors)

### 3.1 `window.postMessage` self-messaging (L5571) — see P1.1

### 3.2 `AudioContext` / `OfflineAudioContext` are full stubs
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L2788-L2862)
- **Status**: All node types (`createOscillator`, `createBufferSource`, `createGain`, `createBiquadFilter`, `createAnalyser`, `createConvolver`, `createDelay`, `createDynamicsCompressor`, `createWaveShaper`, `createScriptProcessor`, `createPanner`, `createStereoPanner`, `createChannelSplitter`, `createChannelMerger`, `createMediaElementSource`, `createMediaStreamSource`, `createMediaStreamDestination`) return stub nodes.
- **Impact**: YouTube's audio visualization and volume control break silently.

### 3.3 `RTCPeerConnection` is a stub
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4977-L5060)
- **Issue**: `createOffer()` → empty SDP. `setLocalDescription()`, `setRemoteDescription()` do nothing. `createDataChannel()` returns minimal stub.
- **Impact**: YouTube live streaming and WebRTC features won't work.

### 3.4 `Selection` API is minimal
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L5064)
- **Issue**: `window.getSelection()` returns a single static selection object. `getRangeAt()`, `addRange()`, `removeAllRanges()` work but don't update visual selection.
- **Impact**: Text selection-dependent features (copy, context menus) may misbehave.

### 3.5 Canvas 2D `getContext('2d')` returns a no-op context
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L2940-L2990)
- **Issue**: All drawing methods are no-ops. `getImageData()` returns empty data. `measureText()` returns estimated widths.
- **Impact**: Google's CAPTCHA, charts, and image manipulation won't render. YouTube thumbnails that use canvas processing will fail.

### 3.6 `document.execCommand()` always returns false
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1999)
- **Issue**: `execCommand(_cmd, _show, _val)` → `false`. Used for clipboard operations in older code paths.
- **Impact**: Copy/paste via `document.execCommand('copy')` fails.

### 3.7 `Cache API` (Service Worker caches) is fully stubbed
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L2879-L2886)
- **Issue**: `caches.open()` returns mock cache where `match()` always returns `undefined`.
- **Impact**: Offline/caching strategies fail silently.

### 3.8 Layout sizing stubs
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1257-L1320)
- **Issue**: `offsetWidth`/`offsetHeight` return layout rect if available else hardcoded 200/20. `clientWidth`/`clientHeight` similarly. `clientTop`/`clientLeft` always return 0. `getClientRects()` returns single rect.
- **Status**: These work if layout has run ✅, but pre-layout they return wrong defaults.

### 3.9 Pointer capture stubs
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1367-L1370)
- **Issue**: `setPointerCapture()`, `releasePointerCapture()` → no-op. `hasPointerCapture()` → false.
- **Impact**: Drag interactions on Google/YouTube sliders or video scrubber may not work.

### 3.10 `element.scrollIntoView()` is a no-op
- **File**: [dom.ts](src/os/apps/browser/dom.ts#L1227)
- **Issue**: `scrollIntoView(_opts?)` → `{}` (does nothing)
- **Impact**: Google search results page auto-scrolls to sections. YouTube comments auto-scroll.

---

## PRIORITY 4 — Low Impact (feature detection, edge cases)

### 4.1 Navigator API stubs that are fine for feature detection
These stubs correctly exist and won't crash Google/YouTube:
- `navigator.credentials` (WebAuthn) — rejects correctly ✅ [L617](src/os/apps/browser/jsruntime.ts#L617)
- `navigator.hid` — rejects correctly ✅ [L624](src/os/apps/browser/jsruntime.ts#L624)
- `navigator.usb` — rejects correctly ✅ [L630](src/os/apps/browser/jsruntime.ts#L630)
- `navigator.bluetooth` — rejects correctly ✅ [L636](src/os/apps/browser/jsruntime.ts#L636)
- `navigator.serial` — rejects correctly ✅ [L643](src/os/apps/browser/jsruntime.ts#L643)
- `navigator.wakeLock` — rejects correctly ✅ [L649](src/os/apps/browser/jsruntime.ts#L649)
- `navigator.mediaSession` — no-op ✅ [L672](src/os/apps/browser/jsruntime.ts#L672)
- `navigator.connection` — returns sensible defaults ✅ [L576](src/os/apps/browser/jsruntime.ts#L576)
- `navigator.sendBeacon()` — actually uses `fetchAsync` ✅ [L569](src/os/apps/browser/jsruntime.ts#L569)
- `navigator.geolocation` — errors correctly ✅ [L538](src/os/apps/browser/jsruntime.ts#L538)
- `navigator.permissions.query()` — returns `'denied'` ✅ [L546](src/os/apps/browser/jsruntime.ts#L546)

### 4.2 Payment, XR, Gamepad stubs — correct for feature detection
- `PaymentRequest` — `.canMakePayment()` → false ✅ [L4461](src/os/apps/browser/jsruntime.ts#L4461)
- `XRSystem` — minimal stubs ✅ [L4495](src/os/apps/browser/jsruntime.ts#L4495)
- `getGamepads()` → empty array ✅ [L5439](src/os/apps/browser/jsruntime.ts#L5439)

### 4.3 `visualViewport` stub
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L1293-L1300)
- **Issue**: Returns a static object. `addEventListener` is no-op. `resize`/`scroll` events never fire.
- **Impact**: Google may miscalculate viewport on mobile-detection paths.

### 4.4 CSS Typed OM stubs
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4273)
- **Status**: `CSSStyleValue`, `CSSUnitValue`, `CSSKeywordValue`, `StylePropertyMap` exist but are minimal.
- **Impact**: Only affects cutting-edge CSS Houdini usage.

### 4.5 Trusted Types stubs
- **File**: [jsruntime.ts](src/os/apps/browser/jsruntime.ts#L4327)
- **Status**: `TrustedTypePolicy`, `TrustedTypePolicyFactory` exist with basic `createPolicy()`.
- **Impact**: Google uses Trusted Types for security — these stubs let code pass without enforcing.

### 4.6 Media stubs (MediaStream, MediaRecorder, SpeechRecognition)
- `MediaStreamTrack` [L969](src/os/apps/browser/jsruntime.ts#L969): Feature detection stub ✅
- `MediaStream` [L1001](src/os/apps/browser/jsruntime.ts#L1001): Feature detection stub ✅
- `MediaRecorder` [L1031](src/os/apps/browser/jsruntime.ts#L1031): Feature detection stub ✅
- `SpeechRecognition` [L1095](src/os/apps/browser/jsruntime.ts#L1095): Fires error correctly ✅
- `SpeechSynthesis` [L2866](src/os/apps/browser/jsruntime.ts#L2866): Returns empty voices ✅

---

## CSS.ts Audit

### CSS Functions — Implementation Status
| Function | Status | File:Line |
|----------|--------|-----------|
| `calc()` | ✅ Implemented | [css.ts#L259-L290](src/os/apps/browser/css.ts#L259) |
| `var()` | ✅ Implemented with recursion | [css.ts#L42-L51](src/os/apps/browser/css.ts#L42) |
| `min()` | ✅ Implemented | [css.ts#L313](src/os/apps/browser/css.ts#L313) |
| `max()` | ✅ Implemented | [css.ts#L317](src/os/apps/browser/css.ts#L317) |
| `clamp()` | ✅ Implemented | [css.ts#L321](src/os/apps/browser/css.ts#L321) |
| `rgb()/rgba()` | ✅ Implemented | [css.ts#L110+](src/os/apps/browser/css.ts#L110) |
| `hsl()/hsla()` | ✅ Implemented | [css.ts#L130+](src/os/apps/browser/css.ts#L130) |
| `oklch()` | ✅ Implemented | [css.ts#L196+](src/os/apps/browser/css.ts#L196) |
| `oklab()` | ✅ Implemented | [css.ts#L212+](src/os/apps/browser/css.ts#L212) |
| `color()` | ✅ Implemented | [css.ts#L225+](src/os/apps/browser/css.ts#L225) |
| `env()` | ❌ Missing | — |

### CSS Properties — Parsed but NOT Rendered (no-ops)
These properties are accepted by the parser but have `break;` and do nothing:

**Text/Layout direction** ([css.ts#L854-L858](src/os/apps/browser/css.ts#L854)):
- `writing-mode`, `direction`, `unicode-bidi` — RTL/vertical text broken
- `caption-side`, `empty-cells` — table display affected

**Scroll behavior** ([css.ts#L832-L842](src/os/apps/browser/css.ts#L832)):
- `scroll-behavior`, `scroll-snap-type`, `scroll-snap-align`, `scroll-snap-stop`, `scroll-margin`, `scroll-padding`, `overscroll-behavior`

**Modern text** ([css.ts#L866-L872](src/os/apps/browser/css.ts#L866)):
- `text-wrap`, `text-wrap-mode`, `text-wrap-style`, `text-box-trim`

**Positioning** ([css.ts#L876-L882](src/os/apps/browser/css.ts#L876)):
- `anchor-name`, `anchor-scope`, `position-anchor`, `position-area`, `position-try` — CSS anchor positioning fully absent

**3D transforms** ([css.ts#L926-L933](src/os/apps/browser/css.ts#L926)):
- `perspective`, `perspective-origin`, `transform-style`, `backface-visibility` — 3D not rendered

**Masks** ([css.ts#L920-L921](src/os/apps/browser/css.ts#L920)):
- `mask`, `mask-image`, `mask-size`, `mask-repeat`, `mask-position`, `mask-composite`

**Border images** ([css.ts#L936-L941](src/os/apps/browser/css.ts#L936)):
- `border-image` and all sub-properties

**Individual transforms** ([css.ts#L888-L890](src/os/apps/browser/css.ts#L888)):
- `rotate`, `scale`, `translate` — individual transform properties not mapped to `transform`

**Motion path** ([css.ts#L891-L896](src/os/apps/browser/css.ts#L891)):
- `offset`, `offset-path`, `offset-distance`, `offset-rotate`, `offset-anchor`

**Float shapes** ([css.ts#L897-L899](src/os/apps/browser/css.ts#L897)):
- `shape-outside`, `shape-margin`, `shape-image-threshold`

### CSS @-rules
| Rule | Status |
|------|--------|
| `@media` | ✅ Evaluated | 
| `@supports` | ✅ Evaluated |
| `@keyframes` | ✅ Parsed & applied via animation engine |
| `@font-face` | ✅ Parsed, not rendered (text-mode) |
| `@import` | ✅ Parsed |
| `@container` | ✅ Parsed & evaluated |
| `@layer` | ✅ Cascade ordering implemented |
| `@page` | ❌ No-op |
| `@counter-style` | ❌ Missing |
| `@property` | ❌ Not registered dynamically |

---

## Layout.ts Audit

### Layout Modes — Status
| Mode | Status | Notes |
|------|--------|-------|
| Block flow | ✅ Implemented | Full block layout |
| Inline flow | ✅ Implemented | Word wrapping, letter/word spacing |
| Flexbox (row) | ✅ Implemented | grow/shrink/basis, wrap, justify, align |
| Flexbox (column) | ✅ Implemented | Full flex-direction support |
| CSS Grid | ✅ Implemented | Via layout-ext.ts: `repeat()`, `minmax()`, `auto-fill/auto-fit`, `fr`, named areas, line-based placement |
| Table | ✅ Implemented | Via layout-ext.ts: colspan/rowspan, column widths |
| Float (left/right) | ✅ Implemented | Out-of-flow + text wrapping for N lines |
| Clear (left/right/both) | ✅ Parsed | css.ts L1008 |
| Position: absolute | ✅ Implemented | Out-of-flow with top/left/right/bottom |
| Position: fixed | ✅ Implemented | Same as absolute |
| Position: sticky | ⚠️ Parsed only | Not actually sticky during scroll |
| Position: relative | ✅ Implemented | Offset applied post-layout |
| text-overflow: ellipsis | ✅ Implemented | Single-line truncation |
| word-break: break-all | ✅ Implemented | Character-level breaks |
| line-clamp | ✅ Parsed | Limited rendering |

### Missing Layout Features
1. **Multi-column layout** — `column-count`, `column-width` parsed but not laid out
2. **Sticky positioning** — parsed but no scroll-aware sticking behavior
3. **Float clear integration** — `clear` is parsed but clear behavior may not push past floats correctly
4. **Subgrid** — not supported
5. **Container queries** — parsed and evaluated but container size may not reflect actual rendered size

---

## DOM.ts Audit

### ✅ Working Well
- `classList` — Full `DOMTokenList` with add/remove/toggle/contains/replace/forEach ✅
- `dataset` — Proxy-based data-* attribute access ✅ [L1651](src/os/apps/browser/dom.ts#L1651)
- `className` get/set ✅ [L619](src/os/apps/browser/dom.ts#L619)
- `getBoundingClientRect()` — returns layout rect ✅ [L1267](src/os/apps/browser/dom.ts#L1267)
- `offsetWidth`/`offsetHeight` — from layout ✅ [L1275-L1276](src/os/apps/browser/dom.ts#L1275)
- `scrollWidth`/`scrollHeight` ✅ [L1300-L1301](src/os/apps/browser/dom.ts#L1300)
- `checkVisibility()` — checks display/visibility/opacity ✅ [L1330](src/os/apps/browser/dom.ts#L1330)
- `checkValidity()` — form validation ✅ [L1375](src/os/apps/browser/dom.ts#L1375)
- `validity` state object ✅ [L1425](src/os/apps/browser/dom.ts#L1425)
- `attachShadow()` ✅ [L1672](src/os/apps/browser/dom.ts#L1672)
- `<template>` content fragment ✅ [L1066](src/os/apps/browser/dom.ts#L1066)
- `<slot>` assignedNodes/assignedElements ✅ [L1233-L1250](src/os/apps/browser/dom.ts#L1233)
- `slot` distribution in serialization ✅ [L2542-L2556](src/os/apps/browser/dom.ts#L2542)
- Selector matching (ID, class, attribute, combinators, pseudo-classes) ✅ [L2348+](src/os/apps/browser/dom.ts#L2348)
- `querySelector`/`querySelectorAll` ✅
- `cloneNode(deep)` ✅ [L1022+](src/os/apps/browser/dom.ts#L1022)
- `innerHTML` get/set ✅ [L842+](src/os/apps/browser/dom.ts#L842)
- `outerHTML` get/set ✅
- `insertAdjacentHTML` ✅
- `createTreeWalker` ✅
- ARIA properties (30+ aria-* attributes) ✅ [L1529+](src/os/apps/browser/dom.ts#L1529)
- HTMLMediaElement stubs (video/audio basics) ✅ [L1582+](src/os/apps/browser/dom.ts#L1582)
- `document.evaluate()` — XPath stub ✅ [L2043](src/os/apps/browser/dom.ts#L2043)
- `document.startViewTransition()` ✅ [L2097](src/os/apps/browser/dom.ts#L2097)

### ⚠️ Stubs / Incomplete in DOM
| Feature | Line | Issue |
|---------|------|-------|
| `element.animate()` | [dom.ts#L1472](src/os/apps/browser/dom.ts#L1472) | Returns stub; `finished` won't resolve |
| `setPointerCapture()` | [dom.ts#L1368](src/os/apps/browser/dom.ts#L1368) | No-op |
| `releasePointerCapture()` | [dom.ts#L1369](src/os/apps/browser/dom.ts#L1369) | No-op |
| `requestPointerLock()` | [dom.ts#L1508](src/os/apps/browser/dom.ts#L1508) | No-op |
| `scrollIntoView()` | [dom.ts#L1227](src/os/apps/browser/dom.ts#L1227) | No-op |
| `showPicker()` | [dom.ts#L1231](src/os/apps/browser/dom.ts#L1231) | No-op |
| `assignedSlot` | [dom.ts#L1255](src/os/apps/browser/dom.ts#L1255) | Always null |
| `contentWindow` (iframe) | [dom.ts#L624](src/os/apps/browser/dom.ts#L624) | Always null |
| `contentDocument` (iframe) | [dom.ts#L626](src/os/apps/browser/dom.ts#L626) | Always null |
| `naturalWidth/Height` | [dom.ts#L632-L634](src/os/apps/browser/dom.ts#L632) | Always 0 |
| `canPlayType()` (media) | [dom.ts#L1604](src/os/apps/browser/dom.ts#L1604) | Always `''` |
| `VRange` (selection) | [dom.ts#L1856-L1885](src/os/apps/browser/dom.ts#L1856) | Content manipulation stubbed |
| `document.execCommand()` | [dom.ts#L1999](src/os/apps/browser/dom.ts#L1999) | Always false |
| `caretPositionFromPoint()` | [dom.ts#L2094](src/os/apps/browser/dom.ts#L2094) | Always null |
| `ElementInternals` | [dom.ts#L1514-L1522](src/os/apps/browser/dom.ts#L1514) | Stub formValue/validity |
| `ShadowRoot.adoptedStyleSheets` | [dom.ts#L1692](src/os/apps/browser/dom.ts#L1692) | Array exists, not used |
| `classList.supports()` | [dom.ts#L585](src/os/apps/browser/dom.ts#L585) | Always false |
| `relList` (link/anchor) | [dom.ts#L628](src/os/apps/browser/dom.ts#L628) | Static empty tokenlist |

---

## jsruntime.ts — Complete Stub/No-op Inventory

### Feature Detection Stubs (acceptable)
These exist purely to prevent crashes and return correct "not supported" signals:
- WebGPU [L680](src/os/apps/browser/jsruntime.ts#L680), [L5702](src/os/apps/browser/jsruntime.ts#L5702)
- WebTransport [L1069](src/os/apps/browser/jsruntime.ts#L1069)
- File System Access API [L5442](src/os/apps/browser/jsruntime.ts#L5442)
- EyeDropper [L950](src/os/apps/browser/jsruntime.ts#L950)

### Functional Stubs That Need Fixing for Google/YouTube

| API | Line | Status | Google/YT Need |
|-----|------|--------|----------------|
| `window.postMessage` | [L5571](src/os/apps/browser/jsruntime.ts#L5571) | No-op | **CRITICAL** |
| `crypto.subtle.*` | [L3953-L3971](src/os/apps/browser/jsruntime.ts#L3953) | Fake promises | **CRITICAL** |
| `customElements.upgrade()` | [L4056](src/os/apps/browser/jsruntime.ts#L4056) | No-op | **CRITICAL** for YT |
| Custom element construction | [L5930](src/os/apps/browser/jsruntime.ts#L5930) | ✅ Works in createElement | OK (upgrade() missing) |
| `ServiceWorker.register()` | [L4455](src/os/apps/browser/jsruntime.ts#L4455) | Rejects | **HIGH** |
| `document.cookie` | [L6817-L6824](src/os/apps/browser/jsruntime.ts#L6817) | ✅ Working with cookieJar | OK |
| `window.performance` | [L3816-L3819](src/os/apps/browser/jsruntime.ts#L3816) | ✅ Real BrowserPerformance | OK |
| `navigator.serviceWorker` | [L556](src/os/apps/browser/jsruntime.ts#L556) | ✅ Exists | OK (but register rejects) |
| `history.pushState` | [L495](src/os/apps/browser/jsruntime.ts#L495) | ✅ Working | OK |
| `history.replaceState` | [L514](src/os/apps/browser/jsruntime.ts#L514) | ✅ Working | OK |
| `localStorage` | [L5448](src/os/apps/browser/jsruntime.ts#L5448) | ✅ Persisted to FS | OK |
| `sessionStorage` | [L5449](src/os/apps/browser/jsruntime.ts#L5449) | ✅ Per-tab | OK |
| `matchMedia` | [L5520](src/os/apps/browser/jsruntime.ts#L5520) | ✅ Evaluates queries | OK |
| `getComputedStyle` | [L5516](src/os/apps/browser/jsruntime.ts#L5516) | ✅ Full cascade | OK (pseudo missing) |
| `MutationObserver` | [L5359](src/os/apps/browser/jsruntime.ts#L5359) | ✅ Working | OK |
| `IntersectionObserver` | [L5360](src/os/apps/browser/jsruntime.ts#L5360) | ✅ Working | OK |
| `ResizeObserver` | [L5361](src/os/apps/browser/jsruntime.ts#L5361) | ✅ Working | OK |
| `customElements (registry)` | [L5386](src/os/apps/browser/jsruntime.ts#L5386) | ⚠️ define/get/whenDefined/createElement work | upgrade() + attributeChangedCallback missing |
| `ShadowRoot` | [dom.ts#L1671](src/os/apps/browser/dom.ts#L1671) | ⚠️ Exists but no style scoping | Degraded |
| `<template>` element | [dom.ts#L1066](src/os/apps/browser/dom.ts#L1066) | ✅ Working | OK |
| `<slot>` | [dom.ts#L1233](src/os/apps/browser/dom.ts#L1233) | ⚠️ Basic | No `slotchange` event |

---

## Top 10 Fixes for Google.com + YouTube.com (Prioritized)

1. **`window.postMessage` — implement self-messaging** [jsruntime.ts#L5571](src/os/apps/browser/jsruntime.ts#L5571)  
   Dispatch `MessageEvent` with `data`, `origin`, `source` on `window` asynchronously.

2. **Custom Elements — implement `upgrade()` and remaining lifecycle** [jsruntime.ts#L4056](src/os/apps/browser/jsruntime.ts#L4056)  
   `upgrade()` must walk DOM tree and upgrade matching elements. Wire `attributeChangedCallback` + `observedAttributes` so attribute mutations notify CEs.

3. **Shadow DOM style scoping in `getComputedStyle`** [jsruntime.ts#L3353](src/os/apps/browser/jsruntime.ts#L3353)  
   Styles from shadow root stylesheets should only apply within that shadow; document styles shouldn't leak in (except inherited properties).

4. **`ServiceWorker.register()` — resolve with mock instead of rejecting** [jsruntime.ts#L4455](src/os/apps/browser/jsruntime.ts#L4455)  
   Return a resolved promise with a mock `ServiceWorkerRegistration`. Make `ready` resolve.

5. **`crypto.subtle.digest()` — implement real SHA-256** [jsruntime.ts#L3953](src/os/apps/browser/jsruntime.ts#L3953)  
   Google uses this for CSP integrity checks. Implement at least SHA-256 and SHA-1.

6. **`element.animate().finished` — resolve the promise** [dom.ts#L1472](src/os/apps/browser/dom.ts#L1472)  
   At minimum, make the `.finished` promise resolve after the configured duration. Google code `await el.animate(...).finished` will hang otherwise.

7. **`Blob.stream()` — return a real ReadableStream** [jsruntime.ts#L1912](src/os/apps/browser/jsruntime.ts#L1912)  
   Return a `ReadableStream` that yields the blob's content.

8. **`getComputedStyle` pseudo-element support** [jsruntime.ts#L3353](src/os/apps/browser/jsruntime.ts#L3353)  
   At least handle `::before` and `::after` by looking up content/display from matched rules with pseudo-selector.

9. **`scrollIntoView()` — scroll viewport** [dom.ts#L1227](src/os/apps/browser/dom.ts#L1227)  
   Use the element's layout rect to call `cb.scrollTo()`.

10. **`IndexedDB` persistence** [jsruntime.ts#L2261](src/os/apps/browser/jsruntime.ts#L2261)  
    Wire IDB data to filesystem for cross-session persistence. Google/YouTube store preferences and session state here.

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Intentional feature-detection stubs (acceptable) | ~25 |
| Functional stubs that need implementation | ~15 |
| Critical blockers for Google/YT | 6 |
| CSS properties parsed but not rendered | ~60 |
| CSS properties fully handled | ~80 |
| DOM methods that are no-ops | ~20 |
| DOM methods working correctly | ~100+ |
| Layout modes implemented | 6/7 (missing multi-column) |
