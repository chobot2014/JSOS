# JSOS Browser Implementation Audit

**Scope**: Full audit of `src/os/apps/browser/` — what is implemented, stubbed, and missing for modern website compatibility (google.com, youtube.com, etc.)

**Files audited**: jsruntime.ts (7220 lines), dom.ts (3033), css.ts (1161), html.ts (2442), layout.ts (1298), canvas2d.ts (881), workers.ts (~500), svg.ts (649), types.ts (516), advanced-css.ts (1223), webplatform.ts (697)

---

## Table of Contents

1. [JavaScript Web APIs](#1-javascript-web-apis)
2. [DOM API Coverage](#2-dom-api-coverage)
3. [CSS Features](#3-css-features)
4. [HTML Parsing & Rendering](#4-html-parsing--rendering)
5. [Layout Engine](#5-layout-engine)
6. [Networking & Fetching](#6-networking--fetching)
7. [Graphics & Media](#7-graphics--media)
8. [Critical Gaps for google.com / youtube.com](#8-critical-gaps)

---

## 1. JavaScript Web APIs

### ✅ IMPLEMENTED (Functional)

| API | Location | Notes |
|-----|----------|-------|
| **`setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`** | jsruntime.ts | Timer heap, synchronously ticked per frame |
| **`requestAnimationFrame`/`cancelAnimationFrame`** | jsruntime.ts | Mapped to timer system |
| **`requestIdleCallback`/`cancelIdleCallback`** | jsruntime.ts | |
| **`queueMicrotask`** | jsruntime.ts | |
| **`console.log/warn/error/info/debug/dir/table/group/time/assert/trace/count`** | jsruntime.ts | Full console API |
| **`localStorage` / `sessionStorage`** | jsruntime.ts VStorage class | Per-tab, VFS persistence, StorageEvent |
| **`fetch()`** | jsruntime.ts fetchAPI | Full: CORS, CSP, cookies, AbortSignal, ReadableStream body, redirect follow, blob:/data: URLs |
| **`XMLHttpRequest`** | jsruntime.ts | Full: open/send/abort, responseType (text/json/document/arraybuffer/blob), events, sync mode, withCredentials, getAllResponseHeaders |
| **`WebSocket`** | jsruntime.ts WebSocket_ | **REAL TCP**: frame encode/decode (buildWSFrame/parseWSFrame), text/binary, ping/pong, close handshake |
| **`URL` / `URLSearchParams`** | jsruntime.ts | Full parsing, toString, searchParams |
| **`Headers`** | jsruntime.ts Headers_ | get/set/has/delete/append/forEach/entries/keys/values |
| **`Request` / `Response`** | jsruntime.ts | Body methods: text(), json(), arrayBuffer(), blob(), clone(), headers, ok, status, url, redirected |
| **`FormData`** | jsruntime.ts FormData_ | append/set/get/getAll/has/delete/entries/keys/values/forEach |
| **`Blob` / `File`** | jsruntime.ts | Blob: size, type, text(), arrayBuffer(), slice(), stream(). File: name, lastModified |
| **`URL.createObjectURL` / `revokeObjectURL`** | jsruntime.ts | Per-tab blob store |
| **`TextEncoder` / `TextDecoder`** | jsruntime.ts | Real UTF-8 encode/decode |
| **`crypto.getRandomValues`** | jsruntime.ts | Real random via kernel |
| **`crypto.randomUUID`** | jsruntime.ts | Real UUID v4 |
| **`structuredClone`** | jsruntime.ts | Full deep clone with circular reference detection, Map/Set/Date/RegExp/ArrayBuffer/TypedArray support |
| **`performance.now()` / `performance.mark/measure/getEntries`** | perf.ts | PerformanceObserver with entryTypes |
| **`MutationObserver`** | dom.ts | Fully wired — _queueMutation on all tree/attribute/characterData mutations, observe/disconnect/takeRecords |
| **`IntersectionObserver`** | jsruntime.ts | Stub that fires callback immediately with isIntersecting:true |
| **`ResizeObserver`** | jsruntime.ts | Stub that fires callback once with contentRect |
| **`matchMedia()`** | jsruntime.ts | Full media query evaluation: width, height, aspect-ratio, orientation, prefers-color-scheme, prefers-reduced-motion, hover, pointer, display-mode, prefers-contrast, forced-colors, any-pointer, any-hover, color-gamut, dynamic-range. addListener/removeListener/addEventListener |
| **`getComputedStyle()`** | jsruntime.ts | Full CSS cascade: specificity, @media/@supports/@container/@layer, !important, inheritance, var() resolution, proxy cache |
| **`CSSStyleSheet`** | jsruntime.ts CSSStyleSheet_ | insertRule, deleteRule, replace, replaceSync, cssRules, _parseText handles @charset/@namespace/@import/@media/@keyframes/@supports/@container/@layer/@font-face |
| **CSS Rule Classes** | jsruntime.ts | CSSStyleRule_, CSSMediaRule_, CSSKeyframesRule_, CSSSupportsRule_, CSSContainerRule_, CSSFontFaceRule_, CSSImportRule_, CSSLayerBlockRule_ |
| **CSS Transitions** | jsruntime.ts | Property interpolation, easing functions (ease/linear/ease-in/out/in-out/cubic-bezier/steps), transitionend event |
| **CSS Animations** | jsruntime.ts + advanced-css.ts | @keyframes playback, animationend event, sampleAnimation() |
| **`Web Workers`** | workers.ts WorkerImpl | Real isolated QuickJS runtimes via kernel.procCreate/procEval, postMessage (JSON clone), terminate, message pumping per tick |
| **`SharedWorker`** | workers.ts SharedWorkerImpl | Shared by URL+name key, MessagePort-based API |
| **`MessageChannel` / `MessagePort`** | workers.ts | Full spec: paired ports, start()/close(), auto-start on onmessage set, async delivery via setTimeout |
| **`BroadcastChannel`** | workers.ts BroadcastChannelImpl | In-process fan-out by name |
| **`AbortController` / `AbortSignal`** | jsruntime.ts | abort(), reason, throwIfAborted, addEventListener, onabort, any(), timeout() |
| **`CustomEvent`** | jsruntime.ts | detail property |
| **Event subclasses** (30+) | jsruntime.ts | MouseEvent, PointerEvent, WheelEvent, KeyboardEvent, InputEvent, FocusEvent, CompositionEvent, TouchEvent, DragEvent, ErrorEvent, MessageEvent, StorageEvent, HashChangeEvent, PopStateEvent, PageTransitionEvent, AnimationEvent, TransitionEvent, BeforeUnloadEvent, SubmitEvent, ClipboardEvent, GamepadEvent, SecurityPolicyViolationEvent, ToggleEvent, PromiseRejectionEvent, FormDataEvent, DeviceMotionEvent, DeviceOrientationEvent |
| **`DOMException`** | jsruntime.ts | name, code, message, proper constants |
| **`DOMRect` / `DOMPoint` / `DOMMatrix`** | jsruntime.ts | Full geometry implementations |
| **`ReadableStream` / `WritableStream` / `TransformStream`** | jsruntime.ts | Functional with getReader/getWriter, pipeThrough, pipeTo, tee |
| **`Web Locks API`** | jsruntime.ts | navigator.locks.request/query — functional in-process lock manager |
| **`CustomElementRegistry`** | jsruntime.ts + webplatform.ts | define/get/whenDefined/upgrade/getName, connectedCallback lifecycle |
| **`history.pushState/replaceState/back/forward/go`** | jsruntime.ts | Full History API with state, popstate events |
| **`location` object** | jsruntime.ts | href, protocol, host, hostname, pathname, search, hash, origin, assign, replace, reload |
| **`navigator` properties** | jsruntime.ts | userAgent, language, platform, cookieEnabled, onLine, hardwareConcurrency, maxTouchPoints, mediaDevices, clipboard, sendBeacon, getBattery, connection, storage, permissions, serviceWorker, share, canShare, vibrate, getGamepads, requestMediaKeySystemAccess, mediaCapabilities, locks, credentials, usb, serial, hid, bluetooth |
| **`screen` object** | jsruntime.ts | width, height, availWidth, availHeight, colorDepth, pixelDepth, orientation |
| **`document.cookie`** | dom.ts + jsruntime.ts | Full get/set with key=value parsing, per-origin cookie jar |
| **JS Polyfills** | jsruntime.ts | Object.fromEntries/hasOwn/groupBy, Array.at/flat/flatMap/findLast/toReversed/toSorted/toSpliced/with/fromAsync, String.replaceAll/at/trimStart/trimEnd, Promise.allSettled/any/withResolvers/try, WeakRef, FinalizationRegistry, Iterator.from, TypedArray.at, Error.cause, globalThis, AggregateError |
| **`Highlight` API** | jsruntime.ts | CSS Custom Highlight API |
| **`CloseWatcher`** | jsruntime.ts | requestClose, cancel event |

### ⚡ STUBBED (API surface exists, minimal/no real functionality)

| API | Location | What's missing |
|-----|----------|---------------|
| **`crypto.subtle`** | jsruntime.ts | Returns rejected promises for all methods (digest, encrypt, sign, etc.) |
| **`IndexedDB`** | jsruntime.ts | In-memory Map-based stores; no persistence, no indexes, no cursors, no proper IDBKeyRange |
| **`CacheStorage` / Cache** | jsruntime.ts | In-memory Map; match/put/keys work, no real HTTP cache semantics |
| **`ServiceWorker`** | jsruntime.ts | navigator.serviceWorker.register returns resolved promise, no actual SW execution |
| **`EventSource` (SSE)** | jsruntime.ts | Stub: fires open event, no actual streaming connection |
| **`AudioContext` / Web Audio** | jsruntime.ts | Extensive API surface (createOscillator/Gain/Analyser/BiquadFilter/Convolver/Delay/Panner/StereoPanner/DynamicsCompressor/WaveShaper, createBuffer/BufferSource, decodeAudioData), but **no actual audio output** |
| **`SpeechSynthesis`** | jsruntime.ts | speak/cancel/pause/resume/getVoices — no real TTS |
| **`SpeechRecognition`** | jsruntime.ts | start/stop/abort — no real recognition |
| **`MediaStream` / `MediaRecorder`** | jsruntime.ts | Full API surface, no real capture |
| **`RTCPeerConnection` (WebRTC)** | jsruntime.ts | createOffer/Answer, createDataChannel, setLocalDescription, addIceCandidate — no real ICE/DTLS |
| **`Notification`** | jsruntime.ts | requestPermission always "granted", show no-op |
| **`Geolocation`** | jsruntime.ts | getCurrentPosition returns fixed coordinates |
| **`Payment Request`** | jsruntime.ts | show() returns rejected promise |
| **`WebAuthn`** | jsruntime.ts | navigator.credentials.create/get return rejected promises |
| **`IntersectionObserver`** | jsruntime.ts | Always reports intersecting immediately |
| **`ResizeObserver`** | jsruntime.ts | Fires once with initial rect, no subsequent observation |
| **`HTMLMediaElement` (audio/video)** | dom.ts VElement | play()/pause()/load()/canPlayType() — no real media playback |
| **`Web Animations API`** | dom.ts VElement.animate() | Returns Animation-like object with play/pause/cancel, no real visual animation |
| **`PointerLock` / `Fullscreen`** | dom.ts | requestPointerLock/requestFullscreen — no-ops |
| **Web Codecs** | jsruntime.ts | VideoEncoder/Decoder/AudioEncoder/Decoder — stub constructors |
| **WebXR** | jsruntime.ts | navigator.xr — stub isSessionSupported returns false |
| **Shape Detection** | jsruntime.ts | BarcodeDetector/FaceDetector/TextDetector — stubs |
| **Trusted Types** | jsruntime.ts | trustedTypes.createPolicy — basic wrapper |
| **Push API** | jsruntime.ts | PushManager.subscribe returns rejected |
| **Background Sync** | jsruntime.ts | SyncManager.register returns resolved |
| **CSS Typed OM** | dom.ts | computedStyleMap/attributeStyleMap — basic get/set, no real CSSUnitValue |
| **Scroll-driven Animations** | jsruntime.ts | ScrollTimeline/ViewTimeline — constructor stubs |

### ❌ MISSING (Not implemented at all)

| API | Impact |
|-----|--------|
| **`WebGL` / `WebGL2`** | Canvas `getContext('webgl')` returns null. **Blocks**: YouTube player UI effects, Google Maps, 3D visualizations |
| **`OffscreenCanvas`** | Not available |
| **`SharedArrayBuffer` / `Atomics`** | Some cross-origin isolation features |
| **`Intl` (full)** | No DateTimeFormat, NumberFormat, Collator, PluralRules — **Blocks**: Google's locale-aware formatting |
| **`WebGPU`** | Not implemented |
| **`File System Access API`** | No showOpenFilePicker/showSaveFilePicker |
| **`Clipboard API` (full)** | navigator.clipboard exists but read/write are stubs |
| **`Screen Wake Lock`** | |
| **`Web NFC` / `Web Bluetooth` / `Web USB` / `Web Serial` / `Web HID`** | Stubs only |
| **`EyeDropper`** | |
| **`Barcode Detection`** | Stubs |
| **`Content Index`** | |
| **`Contact Picker`** | |

---

## 2. DOM API Coverage

### ✅ IMPLEMENTED

| Feature | Location | Notes |
|---------|----------|-------|
| **Node tree manipulation** | dom.ts VNode | appendChild, removeChild, insertBefore, replaceChild, DocumentFragment support |
| **O(1) sibling linked lists** | dom.ts | _prevSib/_nextSib for fast traversal |
| **Event system (full 3-phase)** | dom.ts VNode | capture → at-target → bubble, stopPropagation, stopImmediatePropagation, preventDefault, once/passive/signal options |
| **cloneNode (deep/shallow)** | dom.ts VNode | Template _content support |
| **textContent get/set** | dom.ts VNode | |
| **remove(), isConnected, contains(), getRootNode()** | dom.ts VNode | |
| **isSameNode(), isEqualNode()** | dom.ts VNode | |
| **compareDocumentPosition** | dom.ts VNode | Full bitmask (PRECEDING/FOLLOWING/CONTAINS/CONTAINED_BY) |
| **normalize()** | dom.ts VNode | Merge adjacent text nodes |
| **CharacterData API** | dom.ts VText | splitText, substringData, appendData, insertData, deleteData, replaceData, length, wholeText |
| **CSSStyleDeclaration** | dom.ts VStyleMap + Proxy | setProperty/getPropertyValue/getPropertyPriority/removeProperty, cssText, vendor prefix normalization, transition hooks |
| **DOMTokenList** | dom.ts VClassList | contains/add/remove/toggle/replace/value/length/item/entries/values/forEach/keys, Symbol.iterator |
| **Element property shortcuts** | dom.ts VElement | id, className, href, src, srcdoc, value, type, name, alt, disabled, checked, hidden, title, placeholder |
| **contentEditable / editing** | dom.ts VElement | contentEditable, isContentEditable, tabIndex, draggable, spellcheck, autofocus, translate, inert |
| **Popover API** (Chrome 114+) | dom.ts VElement | popover get/set, showPopover(), hidePopover(), togglePopover() |
| **Dialog API** | dom.ts VElement | open, showModal(), show(), close() with close event |
| **ARIA IDL attributes** (15+) | dom.ts VElement | role, ariaLabel, ariaHidden, ariaDisabled, ariaExpanded, ariaSelected, ariaChecked, ariaBusy, ariaLive, ariaAtomic, ariaPressed, ariaValueNow/Min/Max/Text, ariaRequired, ariaReadOnly |
| **on\* event handlers** | dom.ts VElement | onclick, onchange, onsubmit, oninput, onkeydown, onkeyup, onfocus, onblur, onload |
| **Attribute API** | dom.ts VElement | get/set/remove/has/toggle/getAttributeNames, NamedNodeMap(Proxy), namespaced variants (NS), attribute nodes |
| **innerHTML / outerHTML** | dom.ts VElement | get/set with sanitization, template content support |
| **setHTMLUnsafe() / getHTML()** | dom.ts VElement | Chrome 124/125 APIs |
| **insertAdjacentHTML/Text/Element** | dom.ts VElement | All 4 positions |
| **DOM manipulation helpers** | dom.ts VElement | append, prepend, replaceChildren, before, after, replaceWith |
| **children / childElementCount / firstElementChild / lastElementChild** | dom.ts VElement | |
| **CSS selectors: matches(), closest(), querySelector(All)** | dom.ts VElement | Fast paths for #id, tag, .class |
| **getElementsByTagName / ClassName** | dom.ts VElement | |
| **Form API** | dom.ts VElement | form, elements, options, selectedOptions, multiple, selectedIndex, serializeForm (URLSearchParams) |
| **Template element** | dom.ts VElement | content (DocumentFragment), innerHTML for template |
| **focus() / blur() / click() / submit() / reset()** | dom.ts VElement | Proper event dispatching (focus/blur/focusin/focusout) |
| **requestSubmit()** | dom.ts VElement | |
| **Constraint Validation API** | dom.ts VElement | checkValidity, reportValidity, setCustomValidity, validationMessage, validity (all ValidityState flags), willValidate |
| **Selection API** | dom.ts VElement | selectionStart/End/Direction, setSelectionRange, setRangeText, select |
| **Layout rect writeback** | dom.ts VElement | getBoundingClientRect (real _layoutRect), offsetWidth/Height/Top/Left/Parent, clientWidth/Height/Top/Left, scrollTop/Left/Width/Height with scroll events, getClientRects |
| **dataset** | dom.ts VElement | Proxy-based data-* attribute access |
| **Shadow DOM** | dom.ts VElement | attachShadow (open/closed), shadowRoot, host, mode, adoptedStyleSheets |
| **innerText / outerText** | dom.ts VElement | Layout-aware: block newlines, br→\n, skip hidden/script/style |
| **attachInternals()** | dom.ts VElement | ElementInternals: full ARIA mixin, states Set, form/validity access |
| **HTMLImageElement** | dom.ts VElement | naturalWidth/Height, complete, currentSrc, loading, decode() |
| **DOM Range** | dom.ts VRange | Full API: setStart/End, selectNode/Contents, collapse, cloneRange, deleteContents, extractContents, cloneContents, insertNode (text splitting), surroundContents, isPointInRange, compareBoundaryPoints, comparePoint, getBoundingClientRect, getClientRects, createContextualFragment |
| **Document** | dom.ts VDocument | createElement/NS, createTextNode, createDocumentFragment, createAttribute/NS, getElementById (O(1) lazy index), querySelector/All, getElementsByTagName/ClassName/Name, write/writeln/open/close, createComment, createProcessingInstruction, createEvent (legacy initEvent/initMouseEvent/initKeyboardEvent/initCustomEvent), createRange, importNode, adoptNode, evaluate (XPath stub: //*[@id], //tag, /path), elementFromPoint, elementsFromPoint, startViewTransition (Chrome 111+), createTreeWalker (full), createNodeIterator |
| **Document properties** | dom.ts VDocument | title, cookie, activeElement, styleSheets, adoptedStyleSheets, defaultView, doctype, readyState, visibilityState ('visible'), hidden (false), characterSet, compatMode, contentType, domain, URL, documentURI, referrer, lastModified, baseURI, forms, images, links, scripts, all (legacy HTMLAllCollection), timeline, fullscreenEnabled, pictureInPictureEnabled |
| **Storage Access API** | dom.ts VDocument | hasStorageAccess, requestStorageAccess, requestStorageAccessFor |
| **FontFaceSet** | dom.ts VDocument | document.fonts: ready promise, check, load, add, delete |
| **Event delegation** | dom.ts EventDelegator | Single root listener, CSS selector routing |
| **Passive event enforcement** | dom.ts PassiveEventRegistry | |

### ✅ CSS Selector Engine (dom.ts `_matchSel`)

**Selectors**: tag, #id, .class, [attr] operators (=, ^=, $=, *=, ~=, |=, case-insensitive i flag), compound, descendant, child (>), adjacent (+), general sibling (~), comma lists

**Pseudo-classes** (35+): `:first-child`, `:last-child`, `:only-child`, `:nth-child(An+B/odd/even)`, `:nth-last-child`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type`, `:nth-last-of-type`, `:empty`, `:checked`, `:disabled`, `:enabled`, `:required`, `:optional`, `:valid`, `:invalid`, `:placeholder-shown`, `:read-only`, `:read-write`, `:root`, `:target`, `:link`, `:any-link`, `:visited` (false), `:active` (false), `:hover` (tracked via _hoveredId), `:in-range`, `:out-of-range`, `:indeterminate`, `:default`, `:focus`, `:focus-within`, `:focus-visible`, `:not()`, `:is()/:where()/:matches()`, `:has()`, `:scope`, `:lang()`, `:dir()`, `:host`, `:host-context`

**Pseudo-elements**: `::before`, `::after`, `::first-line`, `::first-letter`, `::selection`, `::placeholder` (pass-through)

### ❌ MISSING DOM APIs

| API | Impact |
|-----|--------|
| **`TreeWalker` filter callback (whatToShow bitwise)** | Implemented but simplified |
| **`NodeIterator`** | Basic implementation |
| **`Range` geometry** | getBoundingClientRect returns fallback, not real layout |
| **`Selection` API (window.getSelection)** | getSelection() returns stub |
| **Proper `document.evaluate` (XPath)** | Only handles 3 trivial patterns |
| **`MutationObserver` attribute filter** | attributeFilter option may not be fully honored |

---

## 3. CSS Features

### ✅ IMPLEMENTED (css.ts `parseInlineStyle` ~600 lines + jsruntime.ts cascade)

#### Colors
- Named (100+), hex (#rgb/#rrggbb/#rrggbbaa/#rgba)
- `rgb()`/`rgba()` (comma and space syntax)
- `hsl()`/`hsla()` with conversion
- `oklch()` with full Oklab→sRGB conversion
- `lab()` (CIELAB→XYZ→sRGB), `lch()` (polar CIELAB)
- `hwb()` with conversion
- `color()` function (display-p3, srgb, srgb-linear, a98-rgb, prophoto-rgb, rec2020)
- `color-mix()` with percentage mixing
- `currentColor`, `transparent`

#### Values & Units
- All length units: px, rem, em, pt, vw, vh, svh/dvh/lvh, svw/dvw/lvw, vmin, vmax, ch (8px), ex (8px), %
- `calc()`, `min()`, `max()`, `clamp()` — full CSS math
- `env()` → 0, `var()` → 0 fallback
- `!important` detection and tracking

#### Box Model
- `box-sizing` (border-box / content-box)
- `width` (px and %), `height`, `min-width`, `min-height`, `max-width`, `max-height`
- `padding` shorthand + individual sides + logical properties (block-start/end, inline-start/end) + `padding-block`/`padding-inline`
- `margin` shorthand + individual + logical + `margin: auto` centering detection
- `border` shorthand + width/style/color + individual sides + `border-radius` (1-4 corners) + individual corner radii
- `outline` + outline-width/color/style/offset

#### Text & Fonts
- `font-weight` (numeric + keywords), `font-style`, `font-family`, `font-size` (px→fontScale buckets), `font` shorthand
- `line-height`, `letter-spacing`, `word-spacing`
- `text-decoration` / `text-decoration-line` (underline, line-through)
- `text-align`, `text-transform`, `text-overflow`, `white-space`, `vertical-align`, `word-break`, `overflow-wrap`/`word-wrap`
- `text-indent`, `text-align-last`, `font-variant`, `font-kerning`, `hyphens`, `-webkit-line-clamp`/`line-clamp`, `quotes`
- `list-style-type`, `list-style`, `list-style-position`, `list-style-image`

#### Display & Layout
- `display`: none/flex/inline-flex/grid/inline-block/inline/block/table/table-row/table-cell
- `visibility`, `opacity`
- `position`: static/relative/absolute/fixed/sticky
- `top`/`right`/`bottom`/`left`, `z-index`
- `float`, `clear`
- `overflow` / `overflow-x` / `overflow-y`

#### Flexbox (FULL)
- `flex` shorthand, `flex-grow`, `flex-shrink`, `flex-basis`
- `flex-direction`, `flex-wrap`, `flex-flow`
- `justify-content` (flex-start/end/center/space-between/space-around/space-evenly)
- `align-items`, `align-content`, `align-self`
- `order`, `gap`, `row-gap`, `column-gap`

#### Grid (Parsed, layout basic)
- `grid-template-columns`/`rows`/`areas`
- `grid-auto-columns`/`rows`/`flow`
- `grid-column`/`row` (start/end), `grid-area`
- `justify-items`/`justify-self`, `place-items`/`content`/`self`

#### Background
- `background` shorthand (gradient/url/position/size/repeat/attachment/color extraction)
- `background-image`, `background-size`, `background-position`, `background-repeat`
- `background-attachment`, `background-clip`, `background-origin`
- `-webkit-background-clip` (text clip)

#### Visual Effects
- `box-shadow`, `text-shadow`
- `filter` / `-webkit-filter` (blur, brightness, contrast, grayscale, hue-rotate, invert, opacity, saturate, sepia, drop-shadow — **real pixel operations** in advanced-css.ts)
- `clip-path` (inset, circle, ellipse, polygon, path — **real clipping** in advanced-css.ts)
- `backdrop-filter` (real Gaussian blur + filter chain)
- `mix-blend-mode` (12 blend modes: multiply, screen, overlay, darken, lighten, color-dodge/burn, hard/soft-light, difference, exclusion)
- `transform`, `transform-origin`
- `transition` (all longhands) with real interpolation engine
- `animation` (all longhands) with @keyframes playback

#### Multi-column
- `column-count`, `column-width`, `columns` shorthand

#### Vendor Prefixes (Mapped to standard)
- `-webkit-flex-direction`, `-webkit-align-items`, `-ms-flex-align`, `-webkit-justify-content`, `-ms-flex-pack`, `-webkit-flex-wrap`, `-webkit-transform`, `-webkit-border-radius`, `-webkit-box-shadow`, `-moz-box-shadow`

#### CSS Cascade (jsruntime.ts)
- Specificity calculation (ID > class > tag)
- @media, @supports, @container, @layer evaluation
- `!important` override
- Inheritance chain
- `var()` resolution with fallback values
- Per-element computed style proxy cache with generation tracking

#### CSS @-rules (jsruntime.ts CSSStyleSheet_)
- `@charset`, `@namespace`, `@import`, `@media`, `@keyframes`, `@supports`, `@container`, `@layer`, `@font-face`

### ⚡ CSS PARSED BUT NOT RENDERED

| Property | Status |
|----------|--------|
| `transform` | Parsed, stored; **no visual rotation/scale/translate in paint** (position:relative offset only) |
| `z-index` | Parsed; **no z-order paint sorting** (items paint in DOM order) |
| `position: sticky` | Parsed; **treated as relative** (no scroll-sticking) |
| `background-image: url(...)` | Parsed, stored; **rendered as colored rect, no image fetch/paint** |
| `background: linear-gradient(...)` | Parsed; **gradient string stored, not rasterized in layout** |
| `@font-face` | Parsed; **no font loading or rendering with custom fonts** |
| `grid-template-columns: repeat(...)` | Parsed as string; **no repeat() track expansion in grid layout** |
| `writing-mode` / `direction` / `unicode-bidi` | Recognized no-ops |
| `scroll-snap-*` | Recognized no-ops |
| `content-visibility` | Recognized no-op |
| `anchor positioning` | Recognized no-op |
| `mask-*` / `perspective` / `3D transform` | Recognized no-ops |

### ❌ CSS MISSING

| Feature | Impact |
|---------|--------|
| **CSS Variables** (`var()`) in parsing | var() in raw values is replaced with 0/fallback; no actual custom property inheritance tree |
| **`@media` in stylesheets** | Evaluated in cascade, but `@media print` / `@media screen` toggles may be incomplete |
| **`@container` queries (real)** | Container query conditions are evaluated, but container width measurement may not match spec |
| **`@property`** | Not supported |
| **CSS Nesting** | Not supported (native `&` syntax) |
| **`@scope`** | Not supported |
| **`@starting-style`** | Not supported |
| **`@view-transition`** | Not supported |
| **Subgrid** | Not supported |
| **`color-scheme: dark`** | Parsed but no real dark mode rendering |

---

## 4. HTML Parsing & Rendering

### ✅ IMPLEMENTED

| Feature | Location | Notes |
|---------|----------|-------|
| **WHATWG HTML5 Tokenizer** | html.ts `tokeniseWHATWG()` | 27 states (DATA, RCDATA, RAWTEXT, TAG_OPEN, END_TAG_OPEN, TAG_NAME, all ATTR states, SELF_CLOSING, MARKUP_DECL_OPEN, COMMENT, DOCTYPE, CHAR_REF) |
| **Character references** | html.ts | `&amp;`, `&#160;`, `&#xA0;` named + numeric |
| **RAWTEXT** | html.ts | For script/style/xmp/noframes/noembed |
| **RCDATA** | html.ts | For textarea/title |
| **WHATWG Tree Builder** | html.ts `buildTreeWHATWG()` | 22 insertion modes (INITIAL through AFTER_AFTER_BODY) |
| **Foster parenting** | html.ts | Misplaced content before table moved correctly |
| **Implicit tag closing** | html.ts | P_CLOSERS, closeImplied for p/li/dd/dt/option/optgroup |
| **Implied elements** | html.ts | Auto-insert html, head, body, tbody, tr |
| **In-scope checks** | html.ts | hasInScope, hasInTableScope |
| **Streaming HTML parser** | html.ts IncrementalHTMLParser | feed()/flush()/end() for progressive rendering |
| **All block elements** | html.ts | div, p, section, article, nav, main, header, footer, aside, h1-h6, blockquote, pre, figure, figcaption, details, summary |
| **All inline elements** | html.ts | span, a, strong/b, em/i, code, del/s, mark, u, sub, sup, small, abbr, cite, q, time, kbd, var, samp |
| **Tables** | html.ts | table/thead/tbody/tfoot/tr/th/td, colspan, rowspan, cellspacing, cellpadding, bgcolor |
| **Forms** | html.ts | input (text/password/search/submit/reset/button/checkbox/radio/file/hidden), select/option, textarea, button, with validation attributes (required, minLength, maxLength, pattern, min, max) |
| **Lists** | html.ts | ol/ul/li with nesting depth, CSS list-style-type |
| **Links** | html.ts | a[href] tracking with download attribute |
| **Images** | html.ts | img (via widget blueprint), picture/source srcset |
| **Template element** | html.ts | `<template>` content fragment handling |
| **Inline SVG** | html.ts | Collects SVG tokens, renders via svg.ts renderSVG() |
| **CSS counters** | html.ts | counter-reset, counter-increment, counter() function |
| **::before / ::after** | html.ts | Pseudo-element content injection |
| **Style cascade** | html.ts | Processes `<style>` blocks, inline styles, external stylesheet integration |
| **Quirks mode detection** | html.ts | Based on DOCTYPE presence |
| **Favicon extraction** | html.ts | `<link rel="icon">` href capture |
| **Base URL** | html.ts | `<base href>` support |

### ❌ HTML MISSING

| Feature | Impact |
|---------|--------|
| **`<iframe>` rendering** | contentWindow/Document return null; **no nested browsing context** — **MAJOR for google.com** (ads, widgets, OAuth) |
| **`<video>` / `<audio>` playback** | Elements exist as stubs, no real media pipeline — **BLOCKS youtube.com core** |
| **`<canvas>` in HTML** | Canvas 2D exists but not wired as an HTML element in the parser flow |
| **`<math>` (MathML)** | mathml.ts exists but likely not integrated into parser |
| **`<slot>` distribution** | Implemented in webplatform.ts but may not be connected to main parser |
| **Custom elements** | Registry exists but parser doesn't auto-upgrade custom tags |
| **`srcset` / `sizes`** (full) | Basic srcset in `<picture>` only; no responsive image selection |

---

## 5. Layout Engine

### ✅ IMPLEMENTED (layout.ts)

| Feature | Notes |
|---------|-------|
| **Block flow** | Normal block layout with margin collapsing |
| **Inline flow** | Word wrapping (flowSpans), word-break: break-all, letter-spacing, word-spacing |
| **Text overflow: ellipsis** | |
| **Heading levels** (h1-h6) | Scaled font sizes, proper spacing |
| **Lists** (ordered/unordered) | Bullets (•, ◦, ▪), decimal numbering, nesting |
| **Blockquote** | Indented with quote bar |
| **Preformatted text** | Line-based rendering |
| **Horizontal rule** | |
| **Float left/right** | Out-of-flow positioning with sibling wrap-around tracking |
| **Flexbox (row/column)** | Full: flex-grow/shrink/basis, justify-content (6 modes), align-items/self (5 modes), align-content (7 modes), flex-wrap/wrap-reverse, order sorting |
| **Flexbox column direction** | Full grow/shrink in column mode |
| **CSS Grid** | Via layoutGrid() — basic grid placement |
| **Table layout** | Via layoutTable() — column width distribution, colspan/rowspan |
| **Absolute/Fixed positioning** | Out-of-flow: top/right/bottom/left, right-anchored, bottom-anchored |
| **Relative positioning** | posTop/posLeft offset of generated lines |
| **margin: auto centering** | Block centering with explicit width |
| **Percentage widths** | Resolved against container |
| **min-width / max-width / min-height / max-height** | |
| **overflow: hidden/scroll/auto** | Line clipping when explicit height set |
| **Box decorations** | border-radius, border-width/color/style, box-shadow, opacity, background-color/gradient annotation on rendered lines |
| **Widget layout** | Text inputs, buttons, checkboxes, radio buttons, selects, textareas, images — all positioned with proper dimensions |
| **Text transforms** | uppercase, lowercase, capitalize applied during layout |
| **Line height** | nodeLineH() with configurable per-node |

### ✅ Layout Optimization Classes (layout.ts)

| Class | Purpose |
|-------|---------|
| `LayoutContainment` | CSS `contain: layout` isolation |
| `FlexGridTrackCache` | Cache computed flex/grid track sizes |
| `ContainingBlockCache` | Cache containing-block rect for positioned elements |
| `LayoutBudget` | 4ms per-frame budget with early-out |
| `GridAutoPlacementFastPath` | Fast dense auto-placement for span=1 items |
| `ParallelLayoutScheduler` | Cooperative microtask scheduling for subtrees |
| `LayoutProfiler` | Per-subtree timing for hot path identification |
| `ReadWriteBatcher` | Read-before-write batching to prevent layout thrashing |
| `CompositorLayerTree` | Layer promotion tracking (position:fixed, transform, opacity, will-change) |
| `StyleInvalidationTracker` | Fine-grained invalidation groups (nth-child, attr, class, id, pseudo) |

### ❌ LAYOUT MISSING

| Feature | Impact |
|---------|--------|
| **Grid repeat() / fr units** | grid-template-columns parsed as string; no repeat()/fr/minmax() track sizing |
| **Grid auto-flow: row dense** | GridAutoPlacementFastPath exists for simple cases only |
| **Grid subgrid** | Not implemented |
| **CSS transforms in paint** | Stored but not applied visually (no rotation/scale/skew rendering) |
| **z-index stacking** | No stacking context sorting — DOM order only |
| **Sticky positioning** | Parsed, treated as relative |
| **Multi-column layout** | column-count/width parsed, no actual column splitting |
| **Writing modes** (vertical text) | Not implemented |
| **Inline-block** | Parsed, falls through to block |
| **Table border-collapse** | Not implemented |
| **CSS Shapes** (shape-outside) | Not implemented |

---

## 6. Networking & Fetching

### ✅ IMPLEMENTED

| Feature | Notes |
|---------|-------|
| **HTTP fetch** | Via os.fetchAsync — full request/response cycle |
| **CORS enforcement** | Same-origin policy check on fetch/XHR |
| **CSP enforcement** | script-src, style-src, img-src, connect-src, default-src |
| **Cookie handling** | Per-origin cookie jar, Set-Cookie parsing, Cookie header injection |
| **Redirect following** | 301/302/303/307/308 with method adjustment |
| **Request/Response bodies** | text, json, arrayBuffer, blob, formData |
| **AbortSignal integration** | fetch/XHR respect abort signals |
| **WebSocket (real TCP)** | Frame encoding/decoding, text/binary, ping/pong, close handshake |
| **External CSS fetch** | `<link rel="stylesheet">` fetched and applied |
| **External script fetch** | `<script src>` fetched and executed |
| **sendBeacon** | Via navigator.sendBeacon |
| **data: / blob: URLs** | Handled in fetch and script loading |

### ❌ NETWORKING MISSING

| Feature | Impact |
|---------|--------|
| **HTTP/2 / HTTP/3** | Single-request-at-a-time only |
| **Streaming responses** | ReadableStream body exists but backed by full response text |
| **Content-Encoding (gzip/br)** | No decompression |
| **Full CORS preflight** | OPTIONS request not sent |
| **Service Worker fetch interception** | SW registered but doesn't intercept |
| **Cache-Control / ETag** | No HTTP caching headers honored |

---

## 7. Graphics & Media

### ✅ IMPLEMENTED

| Feature | Location | Notes |
|---------|----------|-------|
| **Canvas 2D** | canvas2d.ts | Full software rasterizer: fillRect, strokeRect, clearRect, fill (scanline), stroke (Bresenham), arc, bezier curves, quadratic curves, roundRect |
| **Canvas transforms** | canvas2d.ts | translate, scale, rotate, setTransform, resetTransform, save/restore |
| **Canvas gradients** | canvas2d.ts | createLinearGradient, createRadialGradient, addColorStop, sampleAt |
| **Canvas patterns** | canvas2d.ts | createPattern |
| **Canvas text** | canvas2d.ts | fillText with 5×7 bitmap font, measureText, textAlign, textBaseline |
| **Canvas images** | canvas2d.ts | drawImage (3/5/9-arg overloads), nearest-neighbour scaling, BitmapCache (LRU 256) |
| **Canvas ImageData** | canvas2d.ts | createImageData, getImageData, putImageData |
| **Canvas clipping** | canvas2d.ts | clip() via rasterized mask |
| **Canvas line dash** | canvas2d.ts | setLineDash, getLineDash, lineDashOffset |
| **Canvas compositing** | canvas2d.ts | globalAlpha, globalCompositeOperation |
| **Path2D** | canvas2d.ts | moveTo, lineTo, closePath, rect, arc, quadraticCurveTo, bezierCurveTo, addPath |
| **SVG rendering** | svg.ts | rect, circle, ellipse, line, polyline, polygon, path (M/L/H/V/Z/C/Q/A), text, g (groups), transform, fill, stroke, stroke-width, opacity, viewBox, SVG→pixel buffer |
| **Image decoders** | img-png.ts, img-jpeg.ts, img-gif.ts, img-webp.ts | Separate decoder modules |
| **CSS filters (pixel-level)** | advanced-css.ts | blur (Gaussian), brightness, contrast, grayscale, hue-rotate, invert, opacity, saturate, sepia, drop-shadow |
| **CSS clip-path** | advanced-css.ts | inset, circle, ellipse, polygon, path — point-in-shape testing |
| **CSS backdrop-filter** | advanced-css.ts | Full pipeline: blur + filter chain on backdrop content |
| **CSS blend modes** | advanced-css.ts | 12 modes: multiply, screen, overlay, darken, lighten, color-dodge/burn, hard/soft-light, difference, exclusion |

### ❌ GRAPHICS MISSING

| Feature | Impact |
|---------|--------|
| **WebGL / WebGL2** | `getContext('webgl')` returns null |
| **Real font rendering** | All text is terminal character grid (monospace). No TrueType/OpenType, no anti-aliasing, no variable fonts |
| **CSS gradient rendering** | Gradient strings parsed but not rasterized to pixels in the layout/paint path |
| **CSS transform rendering** | transform values stored but never applied to pixel output |
| **Video playback** | No media pipeline |
| **Audio playback** | AudioContext API exists, no real audio output |
| **Image scaling in layout** | Images rendered at natural size or HTML attribute size, no CSS object-fit in paint |

---

## 8. Critical Gaps for google.com / youtube.com

### google.com Compatibility

| Requirement | Status | Blocker Level |
|-------------|--------|---------------|
| Basic HTML/CSS rendering | ✅ Works | — |
| Search form submission | ✅ Works | — |
| `fetch()` for search API | ✅ Works | — |
| CSS Flexbox layout | ✅ Works | — |
| CSS Grid (results) | ⚠️ Partial (no fr/repeat) | Medium |
| `<iframe>` (ads, widgets) | ❌ Missing | High |
| Service Worker | ⚡ Stub | Low |
| Web fonts (`@font-face`) | ❌ Missing | Medium |
| `Intl.NumberFormat` | ❌ Missing | Medium |
| CSS transforms (animations) | ⚡ Parsed, not rendered | Medium |
| `IntersectionObserver` (lazy load) | ⚡ Always-intersecting stub | Low |

### youtube.com Compatibility

| Requirement | Status | Blocker Level |
|-------------|--------|---------------|
| HTML5 `<video>` playback | ❌ Missing | **CRITICAL** |
| Media Source Extensions (MSE) | ❌ Missing | **CRITICAL** |
| Encrypted Media Extensions (EME) | ❌ Missing | **CRITICAL** |
| WebGL (player UI) | ❌ Missing | High |
| `IndexedDB` (offline data) | ⚡ In-memory only | Medium |
| `crypto.subtle` (DRM checks) | ⚡ All methods reject | High |
| `<iframe>` (embed player) | ❌ Missing | High |
| Web Components (custom player) | ⚡ Partial | Medium |
| CSS Grid (layout) | ⚠️ Partial | Medium |
| WebSocket (live chat) | ✅ Works | — |
| Service Worker (offline) | ⚡ Stub | Low |
| `ResizeObserver` (responsive) | ⚡ Fire-once stub | Medium |
| `requestAnimationFrame` | ✅ Works | — |
| History API | ✅ Works | — |

### Top 10 Priorities for Modern Web Compatibility

1. **`<iframe>` support** — nested browsing contexts (google.com ads, youtube.com embeds, OAuth flows)
2. **`<video>`/`<audio>` playback** — real media pipeline (youtube.com core requirement)
3. **WebGL** — `getContext('webgl')` returning a functional context
4. **Real font rendering** — TrueType/OpenType with anti-aliasing (everything looks broken without proportional fonts)
5. **CSS transforms in paint** — visual rotation/scale/translate
6. **CSS Grid `repeat()`/`fr` units** — modern layouts rely on this
7. **`crypto.subtle`** — at least SHA-256 digest
8. **`Intl` APIs** — DateTimeFormat, NumberFormat, Collator
9. **`z-index` stacking order** — proper paint ordering
10. **`@font-face` loading** — web font support

---

## Summary Statistics

| Category | Implemented | Stubbed | Missing |
|----------|-------------|---------|---------|
| JS Web APIs | ~60 | ~25 | ~15 |
| DOM API surface | ~95% | ~3% | ~2% |
| CSS Properties (parsed) | ~200+ | ~50 (no-ops) | ~20 |
| CSS Properties (rendered) | ~120 | — | ~100 |
| HTML Elements | ~80 | ~10 | ~5 |
| Layout modes | 5 (block/inline/flex/grid/table) | — | 2 (multi-col, writing-mode) |
| Graphics APIs | Canvas 2D (full), SVG (basic) | — | WebGL, fonts, video |

**Total estimated codebase**: ~18,000+ lines of TypeScript across 36+ files in `src/os/apps/browser/`

**Overall assessment**: JSOS has an impressively comprehensive browser implementation for an OS-level project. The DOM, CSS cascade, event system, and selector engine are production-grade. The main blockers for real-world websites are: (1) no `<iframe>` support, (2) no media playback, (3) terminal-based text rendering instead of real fonts, and (4) CSS visual effects (transforms, z-index) being parsed but not painted.
