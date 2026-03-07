# JIT Everywhere: The JSOS Performance & Containerization Master Plan

**Date:** March 5, 2026
**Branch:** JIT-DESKTOP-5
**Goal:** YouTube.com loads, plays, and feels fast. Every hot path is JIT-compiled. Every execution context is properly isolated.

---

## The Three Pillars

| Pillar | Problem Today | Target State |
|--------|---------------|--------------|
| **JIT Everywhere** | JIT only covers hand-written int32 functions and ~30 QuickJS opcodes. Page JS runs interpreted. | Every hot function auto-compiles. Float64, objects, strings, closures all have native fast-paths. |
| **Proper Containerization** | Browser JS runs in the same QuickJS context as the OS. No memory isolation. Polyfill files conflict with real implementations. | Each tab is an isolated execution context. Process-level isolation for child apps. Sandboxed syscall policies enforced. |
| **YouTube-Grade Rendering** | Layout is block+inline flow only. No grid. Weak flex. Fixed 8×8 font. No video. No WebAssembly. | Full flexbox+grid layout. Proportional fonts. `<video>`/MSE playback. Web Components. Enough DOM/CSS fidelity that YouTube's player initializes. |

---

## Part 1: JIT Everywhere

### 1.1 — Complete the QuickJS Bytecode JIT (qjs-jit.ts)

The hook infrastructure is in place (`JSOS_JIT_HOOK` in quickjs.c, `QJSJITHook` dispatcher in qjs-jit.ts). The compiler handles ~30 integer opcodes. **The gap is huge** — real-world JS uses float64, objects, strings, closures, and exceptions constantly.

#### 1.1.1 Float64 Tier (Priority: CRITICAL)

**Status:** x87 FPU emit helpers exist in `_Emit` (FLD/FSTP/FADD/FSUB/FMUL/FDIV). `jit_call_d4` trampoline exists in C. Not wired into bytecode compilation.

**Tasks:**
1. Add type speculation to `QJSJITCompiler` — track whether each local/arg is always int32 or always float64 across observed calls
2. Emit dual-path code: integer fast-path with type-guard, float64 fallback via x87 FPU
3. Wire `OP_add`/`OP_sub`/`OP_mul`/`OP_div` to emit float64 versions when speculation says "always float"
4. Handle int→float promotion at call boundaries (FILD for int32→ST0)
5. Handle float→int truncation for bitwise ops (FISTTP)
6. Add `Math.floor`, `Math.ceil`, `Math.round`, `Math.sqrt` (FSQRT), `Math.sin`/`Math.cos` (FSIN/FCOS) as inlined x87 intrinsics
7. Benchmark: `fib(35)` with float args should be within 2× of int32 path

**Files:** `src/os/process/qjs-jit.ts`, `src/os/process/jit.ts` (_Emit), `src/os/process/qjs-opcodes.ts`

#### 1.1.2 Object Property Access — Inline Caches (Priority: CRITICAL)

**Status:** `OP_get_field`/`OP_put_field` bail out. Property access is the #1 bottleneck for any real JS.

**Tasks:**
1. Implement monomorphic inline caches (ICs) for `OP_get_field` / `OP_put_field`
2. Each IC site: emit a shape-check guard (compare JSObject.shape pointer against cached shape)
3. On shape match: load/store at cached byte offset (single MOV instruction)
4. On shape miss: call a slow-path C helper that updates the IC (self-modifying code via `kernel.writePhysMem`)
5. Add polymorphic IC fallback (2–4 shape entries) for megamorphic sites
6. Track IC miss rates in `_jitStats` for diagnostic output

**Generated code pattern (monomorphic IC):**
```
  ; OP_get_field "x" — inline cache site
  MOV ECX, [ESP]              ; ECX = JSObject*
  CMP [ECX + shape_offset], <cached_shape>  ; shape guard
  JNE .slow_path
  MOV EAX, [ECX + <cached_prop_offset>]     ; fast load
  JMP .done
.slow_path:
  PUSH <ic_site_addr>         ; self-patch address
  PUSH <atom>                 ; property name atom
  PUSH ECX                    ; object
  CALL _ic_miss_handler       ; C helper patches the IC
  ADD ESP, 12
.done:
```

**Files:** `src/os/process/qjs-jit.ts`, `src/kernel/quickjs_binding.c` (IC miss handler)

#### 1.1.3 Array Element Access (Priority: HIGH)

**Status:** `OP_get_array_el`/`OP_put_array_el` are stubbed in qjs-jit.ts with basic SIB-addressing for dense int arrays.

**Tasks:**
1. Emit bounds-check guard (CMP index, [array + length_offset]; JAE slow_path)
2. For dense arrays: emit SIB-addressed load/store (`MOV EAX, [base + index*8]` for JSValue arrays)
3. Handle typed arrays (Int32Array, Uint8Array, Float64Array) with specialized load/store widths
4. Typed array fast-path: skip tag check, direct memory access to backing ArrayBuffer
5. Out-of-bounds / sparse array → deopt to interpreter

**Files:** `src/os/process/qjs-jit.ts`

#### 1.1.4 Function Calls (Priority: HIGH)

**Status:** `OP_call` / `OP_call0` / `OP_call_method` bail out. Every function call goes through the interpreter.

**Tasks:**
1. For calls to already-JIT-compiled functions: emit direct `CALL <native_addr>` (monomorphic call site)
2. For polymorphic call sites: emit indirect call through `jit_native_ptr` field check
3. Handle argument count mismatch (push undefined for missing args, ignore excess)
4. Emit proper callee-save register preservation around calls
5. Inline small known functions (< 32 bytes of native code) at call sites
6. Wire `OP_call_method` to extract the function from the object and dispatch

**Files:** `src/os/process/qjs-jit.ts`, `src/kernel/quickjs_binding.c`

#### 1.1.5 String Operations (Priority: HIGH)

**Status:** No string ops are JIT-compiled. Every `+` on strings goes through the interpreter.

**Tasks:**
1. Detect string concatenation pattern (`OP_add` where both operands are `JS_TAG_STRING`)
2. Emit call to a C helper `_jit_string_concat(JSContext*, JSValue, JSValue) → JSValue`
3. Add `OP_typeof` native path (read tag, switch to string constant)
4. String comparison (`===`) via C helper for now (length check + memcmp)
5. `String.prototype.charCodeAt` / `String.prototype.length` as IC-able property accesses

**Files:** `src/os/process/qjs-jit.ts`, `src/kernel/quickjs_binding.c`

#### 1.1.6 Closure & Scope Access (Priority: MEDIUM)

**Status:** `OP_get_var_ref` / `OP_put_var_ref` (closure variable access) bail out.

**Tasks:**
1. Read closure variable references from `JSFunctionBytecode.closure_var` array
2. For closed-over variables: emit indirect load through the closure's `var_refs` pointer chain
3. Handle upvalue boxing (JSVarRef → JSValue indirection)
4. Optimize common pattern: single-level closure (function inside function) with direct pointer chase

**Files:** `src/os/process/qjs-jit.ts`

#### 1.1.7 Exception Handling (Priority: MEDIUM)

**Status:** Any function with try/catch/finally bails out.

**Tasks:**
1. Emit `setjmp`-style deopt points at try boundaries
2. On exception: restore ESP/EBP from saved frame, jump to catch handler
3. `OP_throw` → call C helper that sets the QuickJS exception state and returns to interpreter
4. For functions without try/catch: no overhead (current behavior)

**Files:** `src/os/process/qjs-jit.ts`, `src/kernel/quickjs_binding.c`

#### 1.1.8 LRU Eviction & Pool Management (Priority: MEDIUM)

**Status:** Pool is bump-allocated. No eviction. 64 MB fills up on complex sites with many tabs.

**Tasks:**
1. Add a compiled-function registry: `Map<bcAddr, { nativeAddr, size, lastCallTick, callCount }>`
2. When `jit_alloc` returns NULL (pool full): find the coldest N functions by `lastCallTick`
3. Clear their `jit_native_ptr` via `kernel.setJITNative(bcAddr, 0)` (reverts to interpreter)
4. Compact or reset the pool region (bump reset is fastest; requires evicting ALL functions in that region)
5. Add `jit_main_reset()` (already exists) path for catastrophic pool exhaustion
6. Diagnostic: `jitStats()` shows eviction count, hit rate, pool utilization

**Files:** `src/os/process/qjs-jit.ts`, `src/kernel/jit.c`

---

### 1.2 — JIT-Accelerate the Browser Engine

The browser has the most to gain from JIT because it runs the most JS.

#### 1.2.1 Delete Conflicting Polyfill Files (Priority: CRITICAL — Do First)

**Status:** `compat-polyfills.ts` and `framework-polyfills.ts` actively break the browser by overwriting real implementations with weaker stubs.

**Tasks:**
1. Delete `src/os/apps/browser/compat-polyfills.ts` (248 lines)
2. Delete `src/os/apps/browser/framework-polyfills.ts` (263 lines)
3. Remove all imports/calls to `installCompatPolyfills()` and `installFrameworkPolyfills()` from `jsruntime.ts`
4. Verify: `getComputedStyle`, `MutationObserver`, `ResizeObserver`, `matchMedia`, `CSS.supports` — all should use the real implementations already in jsruntime.ts

**Files:** `src/os/apps/browser/compat-polyfills.ts` (DELETE), `src/os/apps/browser/framework-polyfills.ts` (DELETE), `src/os/apps/browser/jsruntime.ts`

#### 1.2.2 Delete Site-Specific Hacks (Priority: CRITICAL — Do First)

**Status:** `_siteProfiles` in jit-browser.ts contains per-site mutation batching hacks for Google/HN/GitHub. `_detectSPAFramework()` fingerprints frameworks but does nothing.

**Tasks:**
1. Remove `_siteProfiles` array and `getSiteProfile()` from `jit-browser.ts`
2. Remove `_detectSPAFramework()` dead code
3. Remove Chrome UA spoofing from `jsruntime.ts` — identify as `JSOS/1.0`
4. Remove hardcoded start URL (`news.ycombinator.com`) — default to `about:blank`

**Files:** `src/os/apps/browser/jit-browser.ts`, `src/os/apps/browser/jsruntime.ts`, `src/os/apps/browser/index.ts`

#### 1.2.3 JIT-Compile DOM Hot-Paths (Priority: HIGH)

**Status:** `JITDOMOps` in jit-browser.ts pre-compiles string hash and canvas clear. More hot-paths needed.

**Tasks:**
1. JIT-compile `_walk()` tree traversal (dom.ts) — it's called on every DOM mutation
2. JIT-compile selector matching inner loop (the character-by-character comparison)
3. JIT-compile event dispatch path (bubble walk up ancestor chain)
4. Pre-compile `textContent` extraction (recursive text concatenation for `innerText`)
5. Wire QJS JIT auto-compilation for all browser JS: ensure `JIT_THRESHOLD` is low enough (currently 2) that hot page functions compile quickly

**Files:** `src/os/apps/browser/jit-browser.ts`, `src/os/apps/browser/dom.ts`

#### 1.2.4 JIT-Compile Layout Hot-Paths (Priority: HIGH)

**Status:** Layout is pure TypeScript. Word-flow measurement is O(n) per character.

**Tasks:**
1. JIT-compile `flowSpans()` inner loop (character width accumulation + line breaking)
2. JIT-compile flex main-axis distribution (sum flex-basis, distribute free space)
3. JIT-compile box decoration painting (fill rect, border strokes — already have JITCanvas primitives)
4. Pre-compile common layout patterns: "N children stacked vertically" (block flow), "N children side by side" (flex row)

**Files:** `src/os/apps/browser/jit-browser.ts`, `src/os/apps/browser/layout.ts`

#### 1.2.5 JIT-Compile CSS Cascade (Priority: MEDIUM)

**Tasks:**
1. JIT-compile specificity comparison (3-tuple compare: id > class > type)
2. JIT-compile CSS variable resolution (`var(--x)` chain walk)
3. JIT-compile computed style merge (property inheritance from parent)

**Files:** `src/os/apps/browser/jit-browser.ts`, `src/os/apps/browser/stylesheet.ts`

---

### 1.3 — JIT-Accelerate OS Kernel Subsystems

#### 1.3.1 Network Stack (Priority: HIGH)

**Tasks:**
1. JIT-compile TCP checksum calculation (currently pure TS, called on every packet)
2. JIT-compile IP header checksum (ones-complement sum of 16-bit words)
3. JIT-compile ARP table lookup (linear scan → JIT hash table)
4. JIT-compile TLS AES-GCM encrypt/decrypt hot loop (GHASH polynomial multiply)
5. Pre-compile these at boot via `JIT.compile()` — zero warmup

**Files:** `src/os/apps/browser/jit-browser.ts` (or new `src/os/net/jit-net.ts`), `src/os/net/net.ts`, `src/os/net/tls.ts`

#### 1.3.2 Framebuffer & Canvas (Priority: MEDIUM)

**Status:** JITCanvas already compiles fillBuffer, fillRect, blitRow, blitAlphaRow, glyphRow.

**Tasks:**
1. Add JIT-compiled `blitScaled()` — bilinear interpolation for image resize
2. Add JIT-compiled `blitRotated()` — for CSS transforms (future)
3. Add JIT-compiled `applyGaussianBlur()` — for box-shadow rendering
4. Add JIT-compiled `compositeOver()` — alpha-blend source over destination (Porter-Duff)

**Files:** `src/os/process/jit-canvas.ts`

#### 1.3.3 Filesystem (Priority: LOW)

**Tasks:**
1. JIT-compile FAT cluster chain walk (hot for large file reads)
2. JIT-compile directory entry name comparison (8.3 case-insensitive compare)

**Files:** `src/os/storage/fat32.ts`

---

## Part 2: Proper Containerization

### 2.1 — Browser Tab Isolation (Priority: CRITICAL)

**Problem:** All browser tabs share one JS execution context. A script on one page can see/modify another page's DOM. `window`, `document`, `localStorage` are all shared globals.

#### 2.1.1 Per-Tab Execution Context

**Tasks:**
1. Each tab gets its own `PageJS` execution scope — this is partially done (each `initPage()` call creates a fresh closure scope) but the eval context shares globals
2. Create a `BrowserTabContext` class that wraps:
   - Its own `VDocument` instance (already per-page)
   - Its own cookie jar partition (same-origin only)
   - Its own `localStorage` / `sessionStorage` partition
   - Its own timer set (setTimeout/setInterval IDs)
   - Its own console output buffer
3. On tab close: fully tear down the context, clear all timers, release all fetch connections
4. Same-origin policy: `document.cookie`, `localStorage`, `XMLHttpRequest` — all scoped to origin

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/apps/browser/index.ts`

#### 2.1.2 Cross-Origin Isolation

**Tasks:**
1. Enforce same-origin policy on `fetch()` / `XMLHttpRequest`:
   - Same-origin: full access
   - Cross-origin: check `Access-Control-Allow-Origin` header (CORS)
   - No header: block response body, fire `onerror`
2. Prevent cross-origin `<script>` from accessing the host page's DOM (currently they can via shared eval scope)
3. Add `Origin` header to outgoing requests
4. Implement `Referer` header based on navigation source

**Files:** `src/os/apps/browser/jsruntime.ts`, `src/os/net/http.ts`

#### 2.1.3 Content Security Policy (CSP)

**Tasks:**
1. Parse `Content-Security-Policy` response header
2. Enforce `script-src`: block inline scripts and eval() if policy demands
3. Enforce `style-src`: block inline styles if policy demands
4. Enforce `img-src`, `media-src`, `connect-src`: block loads from disallowed origins
5. Report violations to `report-uri` if specified

**Files:** New `src/os/apps/browser/csp.ts`, `src/os/apps/browser/jsruntime.ts`

---

### 2.2 — Process Isolation (Priority: HIGH)

**Problem:** Child processes (QuickJS runtimes) share the same physical address space. A malicious child could read kernel memory via raw pointer arithmetic.

#### 2.2.1 Memory Isolation via Paging

**Status:** VMM and paging infrastructure exists (`process/vmm.ts`, kernel paging in C). User page directories exist (`_user_pds[32]`). Not enforced for child JS processes.

**Tasks:**
1. When `kernel.procCreate()` allocates a child slot, create a dedicated page directory
2. Map only the child's heap + stack + JIT slab into its address space
3. Unmap kernel memory, other children's memory, and the main JIT pool from the child's page directory
4. Switch CR3 (page directory base) before entering the child's QuickJS context
5. Restore CR3 on return to the main OS context
6. **Key constraint:** On i686 flat model with GDT covering 4GB, we need to actually enforce page-level protection bits (U/S bit in page table entries)

**Files:** `src/kernel/quickjs_binding.c`, `src/os/process/vmm.ts`, `src/os/process/jsprocess.ts`

#### 2.2.2 JIT Pool Containerization (Priority: CRITICAL)

**Status:** JIT pool is **partitioned but NOT isolated**. `jit.c` allocates 128 MB BSS: 64 MB main + 16×4 MB child slabs. Each child gets its own bump-allocated slab via `jit_proc_alloc(id, size)`, and slabs are reset on `procDestroy`. However, all 128 MB is contiguous RWX memory with no page-level protection. Any process with `kernel.readPhysMem()` access can read/write the main pool and every other child's compiled native code.

**Attack surface:**
- `kernel.readPhysMem(jit_pool_base, 128MB)` → read all compiled native code from every process
- `kernel.writePhysMem(other_child_slab_addr, shellcode)` → inject code into another process's JIT slab
- `jit_call_i4(forged_ptr, ...)` → execute arbitrary memory address (the C trampoline trusts the pointer blindly)
- IC miss handler in `qjs-jit.ts` uses `writePhysMem` for self-modifying code patches — not scoped to own slab

**Tasks:**
1. **Page-isolate JIT slabs:** When building a child's page directory (2.2.1), map ONLY that child's 4 MB slab as executable. The main 64 MB pool and other children's slabs must be unmapped (not present) in the child's address space.
2. **Validate JIT trampoline targets:** Before `jit_call_i4/i8/d4`, verify the function pointer falls within the calling process's JIT slab range. Add bounds check in `quickjs_binding.c`:
   ```c
   // In jit_call_i4 wrapper:
   uint32_t fn_addr = (uint32_t)fn;
   uint32_t slab_base = JIT_MAIN_SIZE + (uint32_t)current_proc_id * JIT_PROC_SIZE;
   uint32_t slab_end  = slab_base + JIT_PROC_SIZE;
   if (fn_addr < (uint32_t)_jit_pool + slab_base || fn_addr >= (uint32_t)_jit_pool + slab_end)
       return DEOPT_SENTINEL;  // reject out-of-bounds call
   ```
3. **Restrict `readPhysMem`/`writePhysMem` for sandboxed processes:** The `'sandbox'` profile (browser tabs) must NOT have access to `readPhysMem`, `writePhysMem`, `jitAlloc`, or `jitProcAlloc`. Only the JIT hook (`QJSJITHook`) running in the main context should call these.
4. **Scope IC self-modifying code to own slab:** The inline-cache miss handler that uses `writePhysMem` to patch native code must validate that the target address falls within the current process's JIT slab before writing.
5. **Separate kernel JIT helpers from user-callable APIs:** Split kernel bindings so that child QuickJS contexts see `jitProcAlloc(size)` (auto-scoped to their process ID) but NOT `jitAlloc()` (main pool) or `jitWrite()` (arbitrary address).
6. **Browser tab contexts get ZERO JIT kernel access:** Tab JS runtimes run inside the main QuickJS's `jsruntime.ts` sandbox — they must never see `kernel.jitAlloc`, `kernel.readPhysMem`, etc. The JIT hook fires for the main and child QuickJS runtimes only, not for eval'd page scripts.

**Files:** `src/kernel/jit.c`, `src/kernel/jit.h`, `src/kernel/quickjs_binding.c`, `src/os/process/qjs-jit.ts`, `src/os/core/syscall-policy.ts`

#### 2.2.3 Syscall Policy Enforcement

**Status:** `syscall-policy.ts` and `sandbox.ts` exist with full pledge-style allowlists. Not wired into child process creation.

**Tasks:**
1. Apply `SyscallPolicy` to every child process by default (profile: `'standard'`)
2. Browser tab JS contexts get profile: `'sandbox'` (no fs, no proc, no raw net, no raw mem)
3. Expose `sys.pledge()` for self-sandboxing (process drops privileges, cannot re-escalate)
4. Log policy violations to `/var/log/security` (in-memory VFS)
5. Audit: `sandboxManager.getViolations(pid)` returns recent denials
6. `readPhysMem` and `writePhysMem` restricted to `'privileged'` profile only (blocks all child processes and all browser tab contexts)

**Files:** `src/os/core/syscall-policy.ts`, `src/os/users/sandbox.ts`, `src/os/process/init.ts`, `src/os/ui/wm.ts`

#### 2.2.4 Resource Limits

**Status:** `scheduler.ts` has `ProcessResourceLimits` (maxCPU, maxMemory, maxOpenFiles, maxChildProcesses). Not enforced.

**Tasks:**
1. Enforce `maxMemory`: track heap usage per child (QuickJS has `JS_GetMemoryUsage`); kill or OOM-signal the child if exceeded
2. Enforce `maxCPU`: per-process CPU time accounting; after limit, deliver SIGXCPU then SIGKILL
3. Enforce `maxOpenFiles`: FD table size limit per process
4. Enforce `maxChildProcesses`: prevent fork-bombs
5. Default limits for browser tab contexts: 64 MB heap, 5s CPU per script execution, 32 open connections

**Files:** `src/os/process/scheduler.ts`, `src/os/process/jsprocess.ts`, `src/os/core/fdtable.ts`

---

### 2.3 — IPC Hardening (Priority: MEDIUM)

**Status:** IPC pipes use shared ring buffers. Message queues have no access control.

**Tasks:**
1. Validate message sizes at the kernel boundary (max 2048 bytes per message, already enforced)
2. Add sender PID authentication to IPC messages (receiver can verify `msg.senderPid`)
3. Named pipes: enforce filesystem-style permissions (owner/group/other rwx)
4. Shared buffers (`_sbufs`): each buffer assigned to a specific process pair, others cannot access
5. Add `IPC.createChannel(pid1, pid2)` that returns a capability-secured pipe

**Files:** `src/os/ipc/ipc.ts`, `src/kernel/quickjs_binding.c`

---

## Part 3: YouTube-Grade Rendering

### 3.0 — What YouTube.com Requires

YouTube's player page needs:
- **Flexbox + Grid layout** (the entire page is CSS Grid with flex children)
- **Custom Elements / Web Components** (`<ytd-app>`, `<ytd-page-manager>`, etc.)
- **Shadow DOM** (every YouTube component uses shadow roots)
- **ES Modules** (`<script type="module">` with dynamic `import()`)
- **Fetch API + Streams** (video segment loading via MSE)
- **`<video>` element with Media Source Extensions**
- **CSS Custom Properties** (YouTube's design system is 100% CSS vars)
- **IntersectionObserver** (lazy loading of thumbnails and comments)
- **ResizeObserver** (responsive layout adjustments)
- **requestAnimationFrame** (video player animation loop)
- **Proper CORS** (API calls to `youtube.com` from `www.youtube.com`)
- **Service Worker** (offline caching — optional, page works without it)

### 3.1 — Layout Engine: Flexbox Completion (Priority: CRITICAL)

**Status:** Basic flex-direction: row works. Missing: column, wrap, gap, align-items, justify-content, flex-grow/shrink.

#### Tasks:
1. **flex-direction: column** — swap width↔height axes in the flex algorithm
2. **flex-wrap** — detect line overflow, break into multiple flex lines, stack in cross direction
3. **justify-content** — distribute free space: flex-start, flex-end, center, space-between, space-around, space-evenly
4. **align-items / align-self** — cross-axis alignment: stretch (default), flex-start, flex-end, center, baseline
5. **flex-grow / flex-shrink** — distribute positive/negative free space proportionally
6. **flex-basis** — initial main size before growing/shrinking (replaces width/height on flex items)
7. **gap / row-gap / column-gap** — insert spacing between flex items (already parsed in css.ts)
8. **order** — re-sort flex items before layout without changing DOM order
9. **align-content** — multi-line flex cross-axis alignment (for flex-wrap)

**Files:** `src/os/apps/browser/layout.ts`, `src/os/apps/browser/layout-ext.ts`

### 3.2 — Layout Engine: CSS Grid (Priority: HIGH)

**Status:** `layoutGrid()` exists in layout-ext.ts. Needs completion.

#### Tasks:
1. **grid-template-columns / grid-template-rows** — parse track definitions (px, fr, auto, minmax, repeat)
2. **Fractional units (fr)** — distribute remaining space after fixed tracks
3. **grid-column / grid-row** — place items explicitly (span, start/end line numbers)
4. **Auto-placement algorithm** — place items that don't have explicit positions
5. **gap / row-gap / column-gap** — spacing between grid tracks
6. **Named grid areas** — `grid-template-areas` + `grid-area` property
7. **minmax() / auto-fill / auto-fit** — responsive grid track sizing
8. **align-items / justify-items** — grid item alignment within cells

**Files:** `src/os/apps/browser/layout-ext.ts`, `src/os/apps/browser/layout.ts`

### 3.3 — Layout: Positioning & Sizing (Priority: HIGH)

#### Tasks:
1. **position: relative** — offset element by top/left/bottom/right after normal flow
2. **position: absolute** — position relative to nearest positioned ancestor
3. **position: fixed** — position relative to viewport (sticky at offset during scroll)
4. **position: sticky** — normal flow until scroll threshold, then fixed
5. **Percentage widths/heights** — resolve against parent's content box
6. **margin: auto centering** — distribute auto margins to center block elements
7. **min-width / max-width / min-height / max-height** — clamp computed dimensions
8. **calc()** — evaluate calc expressions with resolved context values
9. **viewport units (vw, vh, vmin, vmax)** — resolve against viewport dimensions
10. **z-index + stacking contexts** — paint order based on z-index within stacking contexts

**Files:** `src/os/apps/browser/layout.ts`, `src/os/apps/browser/css.ts`

### 3.4 — CSS Cascade & Selectors (Priority: HIGH)

#### Tasks:
1. **Unify selector matching** — merge `matchesSingleSel` (rightmost only) with `_matchSel` (full combinators) into one correct implementation
2. **Pseudo-classes** — `:hover`, `:focus`, `:active`, `:first-child`, `:last-child`, `:nth-child(n)`, `:not()`, `:is()`, `:where()`, `:has()`
3. **Pseudo-elements** — `::before`, `::after` (with `content` property), `::placeholder`
4. **@media queries** — parse and evaluate `@media` blocks based on viewport size
5. **@supports queries** — parse and evaluate `@supports` blocks
6. **CSS nesting** (`& .child {}`) — modern CSS syntax flattening
7. **@layer cascade ordering** — cascade layers for specificity management
8. **!important** handling — separate important/normal cascade layers
9. **Shorthand property expansion** — `margin: 10px 20px` → individual margin-top/right/bottom/left

**Files:** `src/os/apps/browser/stylesheet.ts`, `src/os/apps/browser/css.ts`, `src/os/apps/browser/html.ts`

### 3.5 — Typography (Priority: HIGH)

**Status:** Fixed 8×8 CP437 bitmap font. Everything looks like a terminal.

#### Tasks:
1. **Proportional font rendering** — replace `CHAR_W` constant with per-glyph advance widths
2. **Font loading** — parse `@font-face` rules, fetch .woff2/.ttf files, extract glyph outlines
3. **TrueType/OpenType rasterizer** — render glyph outlines to bitmaps at requested sizes (scanline rasterizer)
4. **Font fallback chain** — if glyph not in primary font, try next in `font-family` list
5. **Built-in default fonts** — embed a minimal proportional font (e.g., 12px sans-serif from bitmap data) in ROM
6. **line-height** — computed from font metrics (ascent + descent + external leading)
7. **text-decoration** — underline, strikethrough, overline rendering with correct positioning
8. **text-transform** — uppercase, lowercase, capitalize
9. **letter-spacing / word-spacing** — adjust inter-glyph and inter-word gaps
10. **Unicode / emoji** — at minimum: Latin-1 supplement, common Unicode blocks

**Files:** `src/os/apps/browser/font.ts`, `src/os/apps/browser/render.ts`, `src/os/apps/browser/layout.ts`

### 3.6 — DOM Completion (Priority: HIGH)

#### Tasks:
1. **Custom Elements v1** — `customElements.define()`, constructor call on createElement, `connectedCallback`, `disconnectedCallback`, `attributeChangedCallback`, `adoptedCallback`, element upgrade
2. **Shadow DOM** — `attachShadow({mode})`, style encapsulation, `<slot>` element, slot assignment, composed event path
3. **ES Modules** — `<script type="module">`, static `import` / `export` rewriting to CommonJS-style, dynamic `import()` as async fetch+eval
4. **MutationObserver** — real implementation exists; verify it fires on all DOM mutations
5. **IntersectionObserver** — track element visibility relative to viewport scroll position
6. **ResizeObserver** — track element size changes (fire after layout pass)
7. **TreeWalker / NodeIterator** — DOM traversal APIs
8. **Range / Selection** — text selection APIs
9. **DOMParser** — wire to existing `buildDOM()` for `text/html`, add `text/xml` support
10. **Trusted Types** — `TrustedHTML`, `TrustedScript`, `TrustedScriptURL` (basic enforcement)

**Files:** `src/os/apps/browser/dom.ts`, `src/os/apps/browser/jsruntime.ts`

### 3.7 — Rendering Pipeline (Priority: HIGH)

#### Tasks:
1. **Image display** — blit decoded PNG/JPEG/WebP/GIF pixel data at layout position (decoders exist)
2. **border-radius** — clip corners with pre-rasterized elliptical masks
3. **box-shadow** — paint blurred offset rectangle behind element
4. **CSS gradients** — linear-gradient, radial-gradient color interpolation
5. **overflow: hidden** — clip rect stack during paint pass
6. **opacity** — alpha-blend element's entire painted region
7. **CSS transforms** — translate, scale, rotate (affine 2D transform matrix)
8. **CSS transitions** — interpolate property values over time on change
9. **CSS animations** — `@keyframes` parsing, property sampling per frame
10. **`<canvas>` 2D context** — path operations, drawImage, fillText, compositing modes

**Files:** `src/os/apps/browser/render.ts`, `src/os/apps/browser/advanced-css.ts`, `src/os/apps/browser/canvas2d.ts`

### 3.8 — Networking Upgrades (Priority: HIGH)

#### Tasks:
1. **HTTP/2** — HPACK header compression, stream multiplexing, server push
2. **WebSocket** — HTTP Upgrade handshake, frame parsing (text/binary/ping/pong/close), mask/unmask
3. **Fetch API completion** — all HTTP methods (PUT/DELETE/PATCH/HEAD/OPTIONS), proper redirect handling (301→GET, 307→preserve), streaming `ReadableStream` body
4. **FormData** — multipart/form-data encoding for file uploads
5. **CORS enforcement** — preflight OPTIONS requests, `Access-Control-*` header checking
6. **Server-Sent Events (SSE)** — `EventSource` API with chunked response streaming
7. **TLS 1.3 completion** — session resumption, 0-RTT, certificate validation (warn-only)
8. **Connection pooling** — keep-alive connection reuse for same origin

**Files:** `src/os/net/http.ts`, `src/os/net/tls.ts`, `src/os/apps/browser/jsruntime.ts`

### 3.9 — Video & Media (Priority: MEDIUM-HIGH for YouTube)

#### Tasks:
1. **`<video>` element** — basic HTMLVideoElement API (play, pause, currentTime, duration, volume)
2. **Media Source Extensions (MSE)** — `MediaSource`, `SourceBuffer`, append/remove ranges
3. **Video decoding** — VP9 software decoder (TypeScript) or proxy through a native decoder helper
4. **Audio decoding** — AAC/Opus decoder (audio subsystem already exists in `src/os/audio/`)
5. **AV sync** — synchronize audio playback with video frame presentation
6. **Adaptive bitrate** — DASH/HLS manifest parsing, quality switching based on bandwidth
7. **Fullscreen API** — `requestFullscreen()` / `exitFullscreen()` via WM maximize

**Files:** `src/os/apps/browser/audio-element.ts`, new `src/os/apps/browser/video.ts`, new `src/os/apps/browser/mse.ts`

### 3.10 — Storage APIs (Priority: MEDIUM)

#### Tasks:
1. **localStorage** — per-origin persistent storage (backed by VFS `/var/local-storage/<origin>/`)
2. **sessionStorage** — per-tab in-memory storage (cleared on tab close)
3. **IndexedDB** — object store with indexes (in-memory B-tree, optional disk persistence)
4. **Cache API** — request/response cache for Service Worker (in-memory, LRU eviction)
5. **Cookies** — SameSite enforcement, Secure flag checking, domain/path scoping

**Files:** `src/os/apps/browser/jsruntime.ts`, new `src/os/apps/browser/storage.ts`

---

## Part 4: Execution Order & Dependencies

### Phase 0: Cleanup (Week 1)
*Remove the broken stuff before building new stuff.*

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 0.1 | Delete compat-polyfills.ts | — | 1 hour |
| 0.2 | Delete framework-polyfills.ts | — | 1 hour |
| 0.3 | Remove site-specific hacks from jit-browser.ts | — | 2 hours |
| 0.4 | Remove Chrome UA spoofing | — | 1 hour |
| 0.5 | Remove hardcoded start URL | — | 30 min |

### Phase 1: JIT Foundation (Weeks 2-4)
*Make the QuickJS bytecode JIT compile real-world JS.*

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 1.1 | Float64 type speculation + x87 codegen | — | 3 days |
| 1.2 | Object property inline caches | — | 5 days |
| 1.3 | Array element access fast-paths | — | 3 days |
| 1.4 | Function call compilation | 1.2 | 4 days |
| 1.5 | String operation helpers | — | 2 days |
| 1.6 | Closure/scope access | — | 2 days |
| 1.7 | LRU eviction | — | 2 days |

### Phase 2: Layout Engine (Weeks 3-6)
*Can run in parallel with Phase 1.*

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 2.1 | Flexbox completion (all 9 properties) | — | 5 days |
| 2.2 | CSS Grid basic | — | 5 days |
| 2.3 | Positioning (relative/absolute/fixed/sticky) | — | 3 days |
| 2.4 | Percentage sizing + margin auto + calc() | — | 3 days |
| 2.5 | min/max dimensions + z-index stacking | 2.3 | 2 days |

### Phase 3: CSS & Selectors (Weeks 4-6)

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 3.1 | Unify selector matching | — | 3 days |
| 3.2 | Pseudo-classes (:hover, :focus, :nth-child, etc.) | 3.1 | 3 days |
| 3.3 | @media queries | — | 2 days |
| 3.4 | !important + shorthand expansion | — | 2 days |
| 3.5 | CSS custom properties cascade fix | 3.1 | 1 day |

### Phase 4: Browser Containerization (Weeks 5-7)
*Isolation makes multi-tab browsing safe.*

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 4.1 | Per-tab execution context | — | 4 days |
| 4.2 | Same-origin policy + CORS | — | 3 days |
| 4.3 | CSP enforcement | 4.2 | 2 days |
| 4.4 | Process memory isolation (CR3 switch) | — | 5 days |
| 4.5 | Syscall policy enforcement for children | — | 2 days |
| 4.6 | Resource limits enforcement | 4.5 | 2 days |

### Phase 5: DOM & Web APIs (Weeks 6-9)

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 5.1 | Custom Elements v1 | — | 4 days |
| 5.2 | Shadow DOM | 5.1 | 5 days |
| 5.3 | ES Modules (import/export rewriting) | — | 3 days |
| 5.4 | WebSocket | — | 3 days |
| 5.5 | IntersectionObserver + ResizeObserver | 2.1 | 2 days |

### Phase 6: Typography & Rendering (Weeks 7-10)

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 6.1 | Proportional font rasterizer | — | 5 days |
| 6.2 | @font-face loading | 6.1 | 3 days |
| 6.3 | Image compositing in paint pass | — | 2 days |
| 6.4 | border-radius + box-shadow | — | 3 days |
| 6.5 | Gradient rendering | — | 2 days |
| 6.6 | overflow: hidden clipping | — | 1 day |
| 6.7 | CSS transitions + animations | — | 4 days |

### Phase 7: Networking & Media (Weeks 9-12)

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 7.1 | HTTP/2 (HPACK + streams) | — | 5 days |
| 7.2 | Fetch API completion | — | 2 days |
| 7.3 | Connection pooling | — | 2 days |
| 7.4 | `<video>` element + MSE | — | 7 days |
| 7.5 | VP9 / AAC decoders | 7.4 | 10 days |
| 7.6 | AV sync | 7.4, 7.5 | 3 days |

### Phase 8: JIT Hot-Path Acceleration (Weeks 10-12)
*After the features exist, JIT-compile their inner loops.*

| # | Task | Depends On | Effort |
|---|------|-----------|--------|
| 8.1 | JIT TCP/IP checksum | — | 1 day |
| 8.2 | JIT AES-GCM inner loop | — | 2 days |
| 8.3 | JIT layout flowSpans | Phase 2 | 2 days |
| 8.4 | JIT DOM tree walk | — | 1 day |
| 8.5 | JIT image scaling / blitting | 6.3 | 2 days |

---

## Part 5: Metrics & Validation

### Performance Targets

| Benchmark | Current | Target | How |
|-----------|---------|--------|-----|
| `fib(35)` interpreted | ~12s | <1s | QJS bytecode JIT (int32 path) |
| `fib(35)` float | ~12s | <2s | QJS bytecode JIT (float64 path) |
| Simple page load (Wikipedia article) | ~4s | <1s | JIT + layout + CSS cascade |
| Complex page load (YouTube homepage) | Crashes/blank | Renders with video thumbnails | Everything in this plan |
| DOM operations (1000 createElement + appendChild) | ~800ms | <100ms | Inline caches + JIT call dispatch |
| TCP throughput (large file download) | ~2 MB/s | ~10 MB/s | JIT checksum + connection pooling |
| CSS cascade (1000 rules × 500 elements) | ~3s | <200ms | JIT selector matching |

### Validation Checkpoints

| Checkpoint | Criteria | After Phase |
|------------|----------|-------------|
| **V1: JIT Basics** | fib(35) < 1s. Object property access via IC. | Phase 1 |
| **V2: Layout** | Wikipedia renders with correct heading sizes, indentation, floating infobox. | Phase 2-3 |
| **V3: Isolation** | Two tabs open simultaneously with different origins. No data leakage. | Phase 4 |
| **V4: Modern Web** | A page using Custom Elements + Shadow DOM renders correctly. | Phase 5 |
| **V5: Pretty** | Text is proportional. Images display. Rounded corners visible. Gradients paint. | Phase 6 |
| **V6: YouTube** | youtube.com homepage loads. Video player UI renders. Thumbnails display. | Phase 7 |
| **V7: Playback** | A YouTube video plays (with audio) for at least 30 seconds. | Phase 7 |

---

## Part 6: Architecture Principles

### 6.1 — No Site-Specific Hacks, Ever

The previous codebase had `_siteProfiles` with per-domain mutation batching tuning. **This is the wrong approach.** A proper browser renders any valid HTML/CSS correctly because it implements the specs. If YouTube doesn't work, the fix is in the layout engine or DOM implementation, not in a YouTube-specific workaround.

### 6.2 — JIT Compilation is Transparent

Application code never needs to know about the JIT. The QJS hook automatically compiles hot functions. `JIT.compile()` for pre-compiled hot-paths is an optimization, not a requirement — the TypeScript fallback must always work correctly.

### 6.3 — C Code Stays Minimal

Per the JSOS mandate: C code exists only for hardware access primitives. The JIT pool allocator (`jit.c`), the call trampolines (`jit_call_i4/i8/d4`), the QuickJS hook installation, and the IC miss handler — that's it. All compilation logic, all optimization decisions, all scheduling — TypeScript.

### 6.4 — Test Everything

Every new JIT opcode gets a unit test: compile a function using that opcode, call it, verify the result. Every layout feature gets a test case: construct a DOM tree with known CSS, run layout, verify pixel positions. Every isolation boundary gets a penetration test: attempt to read cross-origin data, verify it's blocked.

### 6.5 — Incremental Progress

Each phase ships a measurably better system. Don't try to implement all of YouTube's requirements at once. Ship flexbox → ship grid → ship Custom Elements → ship video. Each step should pass its validation checkpoint before moving to the next.

---

## Appendix A: Memory Budget

### BSS Layout (static, zeroed at boot)

| Region | Old Size | New Size | Notes |
|--------|----------|----------|-------|
| JIT pool — main | 8 MB | **64 MB** | OS TypeScript + browser engine hot-paths |
| JIT pool — children | 8 × 512 KB = 4 MB | **16 × 4 MB = 64 MB** | Per-tab/worker native code |
| **JIT total** | **12 MB** | **128 MB** | YouTube's JS alone can produce 10+ MB native |
| Render surfaces | 8 × 3 MB = 24 MB | 16 × 3 MB = **48 MB** | 1024×768 @ 32bpp per child |
| Shared buffers | 2 MB | 2 MB | IPC slabs |
| FB blit buffer | 3 MB | 3 MB | Framebuffer compositing |
| Page directories | 128 KB | 128 KB | 32 × 4 KB |
| Kernel heap | 1 MB | 1 MB | Bump allocator |
| **BSS total** | **~43 MB** | **~183 MB** | |

### Why 128 MB for JIT?

- YouTube's `player.js` is ~1 MB minified. Native x86 expands 3-10×. → **3-10 MB just for the player**
- YouTube's page framework (Polymer, `ytd-*` components) adds another **2-5 MB compiled**
- The JSOS OS runtime itself has thousands of TypeScript functions to compile
- With float64 support, IC stubs, exception handlers, and inlined calls — function prologue/epilogue overhead grows significantly
- Pool GC exists (reset + recompile) but frequent GC kills performance. More pool = fewer GC pauses
- 4 MB per child = ~80-100 complex JIT-compiled functions per tab, which is realistic for a single-page app

### Minimum QEMU RAM

| Config | RAM | Use Case |
|--------|-----|----------|
| Development / testing | `-m 4G` | Full system with multiple tabs |
| Demo / minimal | `-m 512M` | Single tab, limited child processes |
| Legacy (pre-JIT) | `-m 256M` | No longer sufficient for JIT-everywhere |

The 2 GB NOLOAD sbrk window is **separate** from BSS and holds the QuickJS heap. With `-m 4G`, there is 4 GB of address space minus ~183 MB BSS minus sbrk allocations — plenty of headroom.

---

## Appendix B: File Inventory

### Files to DELETE
- `src/os/apps/browser/compat-polyfills.ts` — conflicts with real implementations
- `src/os/apps/browser/framework-polyfills.ts` — conflicts with real implementations

### Files to CREATE
- `src/os/apps/browser/csp.ts` — Content Security Policy parser + enforcer
- `src/os/apps/browser/storage.ts` — localStorage/sessionStorage/IndexedDB
- `src/os/apps/browser/video.ts` — HTMLVideoElement implementation
- `src/os/apps/browser/mse.ts` — Media Source Extensions
- `src/os/net/jit-net.ts` — JIT-compiled network hot-paths

### Files with MAJOR Changes
- `src/os/process/qjs-jit.ts` — float64, inline caches, call compilation, closures
- `src/os/process/jit.ts` — new _Emit helpers for IC patching
- `src/os/apps/browser/layout.ts` — flexbox completion, positioning
- `src/os/apps/browser/layout-ext.ts` — CSS Grid completion
- `src/os/apps/browser/stylesheet.ts` — selector unification, @media
- `src/os/apps/browser/jsruntime.ts` — Custom Elements, Shadow DOM, ES Modules, WebSocket
- `src/os/apps/browser/dom.ts` — Shadow DOM, custom element lifecycle
- `src/os/apps/browser/render.ts` — border-radius, box-shadow, gradients, opacity
- `src/os/apps/browser/font.ts` — proportional font rasterizer
- `src/os/apps/browser/index.ts` — per-tab context, navigation
- `src/os/apps/browser/jit-browser.ts` — remove hacks, add real JIT hot-paths
- `src/os/net/http.ts` — HTTP/2, WebSocket, connection pooling, CORS
- `src/os/net/tls.ts` — session resumption, 0-RTT
- `src/kernel/quickjs_binding.c` — IC miss handler, process isolation CR3 switching

---

**This is the plan. No shortcuts. No hacks. JIT everything. Isolate everything. Render everything.**
