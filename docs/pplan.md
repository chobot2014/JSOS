# JSOS Audit Parallelization Plan

## Purpose

Systematically audit `docs/1000-things.md` to find every item that is already
implemented but not yet marked `✓`. The file has ~1130 items across 35 sections.
This plan divides the work across 9 read agents (Phase 1) and 9 write agents
(Phase 2), coordinated by a single orchestrator.

---

## How the Audit Works

Each item in `1000-things.md` follows one of two patterns:

```
847. [P0] JIT: compile hot functions ...          ← NOT marked (plain [Px])
88.  [P0 ✓] Virtio-net: C signals RX ...         ← ALREADY marked (has ✓)
```

An agent's job is to:
1. Read the unmarked items in its assigned section range.
2. Search the corresponding source files for real working code (not stubs, not
   TODOs, not commented-out blocks).
3. For each item that IS implemented, produce a replacement line:
   `N. [Px ✓] <original description> — <brief location note>`.
4. Return that list to the orchestrator. Write nothing to disk.

**Verification rule:** An item may only be marked ✓ if working code can be
pointed to by file + rough line/function. "It probably exists" is not enough.

---

## Phase 1 — Parallel Research (9 agents, read-only)

All 9 agents run simultaneously. None of them touch `1000-things.md`.
Each agent returns a JSON array of findings:

```json
[
  {
    "item": 847,
    "oldLine": "847. [P0] JIT: compile hot functions to x86-32 ...",
    "newLine": "847. [P0 ✓] JIT: compile hot functions to x86-32 ... — JIT_THRESHOLD=100 in process/qjs-jit.ts; _jit_hook_impl fires per call_count in kernel/quickjs_binding.c"
  }
]
```

### Agent A — Kernel / Boot / QuickJS Binding

**Doc sections:** §1 Kernel/Boot (items 1–110), §2 QuickJS Binding (items 111–127)

**Source files to read:**
```
src/kernel/boot.s
src/kernel/kernel.c
src/kernel/irq.c
src/kernel/irq_asm.s
src/kernel/timer.c
src/kernel/keyboard.c
src/kernel/mouse.c
src/kernel/pci.c
src/kernel/platform.c
src/kernel/ata.c
src/kernel/virtio_net.c
src/kernel/quickjs_binding.c
src/kernel/memory.c
src/kernel/syscalls.c
src/kernel/jit.c
```

**Focus:** Which boot/hardware items actually work? Which C bindings are wired?
Check for: IDT setup, PIC init, PIT frequency, ATA polling vs IRQ, keyboard
scancode tables, PCI multi-function, serial output, JIT hook reentrancy guards,
`JS_SetMemoryLimit`, `JS_SetMaxStackSize`, per-process runtime isolation.

**Already marked (skip):** 77, 88, 89, 96, 103, 111, 112, 114, 115, 117.

---

### Agent B — Process Manager / Scheduler / JIT

**Doc sections:** §4 Process Manager (items 145–167), §28a JIT Speed (items 847–876)

**Source files to read:**
```
src/os/process/scheduler.ts
src/os/process/process.ts
src/os/process/signals.ts
src/os/process/init.ts
src/os/process/jit.ts
src/os/process/jit-os.ts
src/os/process/qjs-jit.ts
src/os/process/jsprocess.ts
```

**Focus:** Scheduling algorithms, fork/exec/waitpid, signal delivery, PID
management, JIT tier architecture, type specialization, deopt/recompile,
register allocator (or lack thereof), OSR, inline caches.

**Already marked (skip):** 150, 151, 155, 159, 847, 850, 857, 863.

---

### Agent C — Network Stack (TCP/UDP/IP/ARP)

**Doc sections:** §7.1–7.5 Network (items 222–269), §7.5 UDP (items 270–275),
§28e Network Performance (items 922–942)

**Source files to read:**
```
src/os/net/net.ts
```

`net.ts` is ~1400 lines. Read it fully.

**Focus:** ARP table (TTL? gratuitous ARP? pending TX queue?), IP fragmentation,
TTL-exceeded ICMP, TCP state machine completeness (RST, FIN, TIME_WAIT, Nagle,
persist timer, zero-window probe, fast retransmit, RTO backoff), UDP bind
collision, broadcasting, keepalive, SACK, window scaling, TCP listen backlog,
SO_REUSEADDR, network performance items.

**Already marked (skip):** 232, 234, 235, 249, 250, 251, 252, 253, 254, 261.

---

### Agent D — DNS / TLS / HTTP / Crypto

**Doc sections:** §7.6 DNS (items 276–287), §7.7 TLS (items 288–300),
§7.8 HTTP (items 301–322), §8 TLS/Crypto (items 323–348)

**Source files to read:**
```
src/os/net/dns.ts
src/os/net/tls.ts
src/os/net/crypto.ts
src/os/net/http.ts
src/os/net/dhcp.ts
src/os/net/deflate.ts
```

**Focus:** DNS retry logic, AAAA records, CNAME chains, `/etc/hosts`,
multiple nameservers, TLS 1.3 only vs 1.2 fallback, SNI, certificate
validation (none currently?), ALPN, session tickets, AES-GCM tag verification,
X25519 key exchange, RSA/ECDSA verify, ChaCha20-Poly1305, HKDF, SHA-384,
HTTP chunked decode, Content-Length vs Transfer-Encoding precedence,
redirect loop detection, cookie jar, ETag cache, multipart/form-data.

**Already marked (skip):** 276, 277, 278, 279, 281, 282, 289, 301, 302, 303,
304, 305, 306, 317, 326.

---

### Agent E1 — Browser JS Runtime / DOM API

**Doc sections:** §13 Browser JS Runtime (items 497–552),
§14 Browser DOM API (items 553–592)

**Source files to read:**
```
src/os/apps/browser/jsruntime.ts   ← very large (~3800 lines), read in chunks
src/os/apps/browser/dom.ts         ← large (~2000 lines)
src/os/apps/browser/workers.ts
src/os/apps/browser/perf.ts
src/os/apps/browser/cache.ts
```

**Focus:** window APIs (`location`, `history`, `localStorage`, `sessionStorage`,
`IndexedDB`), Fetch/Headers/Request/Response, AbortController, Promise variants,
MutationObserver, IntersectionObserver, ResizeObserver, all event types
(Keyboard/Mouse/Input/Focus/Submit/Wheel/Touch/Pointer/Drag/Clipboard),
DOMContentLoaded/readyState, script type="module", dynamic import(), Worker,
BroadcastChannel, WebSocket, Notification, Intl, WeakRef/FinalizationRegistry,
DOM manipulation methods, classList, CSSOM, Range, Selection, DocumentFragment.

**Already marked (skip):** 497–551 (most are already ✓), 553–589 (most are ✓).
Focus on the gaps — the unmarked ones in those ranges.

---

### Agent E2 — Browser HTML Parser / CSS Engine

**Doc sections:** §9 HTML Parser (items 349–372),
§10 CSS Engine (items 373–440)

**Source files to read:**
```
src/os/apps/browser/html.ts
src/os/apps/browser/css.ts
src/os/apps/browser/stylesheet.ts
```

**Focus:** Entity tables, void elements, script/style CDATA, textarea/pre
whitespace, implicit tag closing, `<base href>`, `<picture>/<source>`,
CSS at-rules (@media, @import, @supports, @keyframes), specificity, pseudo-
classes/elements, inheritance, `!important`, shorthand expansion, `calc()`,
custom properties, transitions, transforms, `background` shorthand, grid/flex
properties, `contain`, `color-mix()`.

**Already marked (skip):** 350–356, 359, 364, 366, 373–413, 417, 431, 435, 440.

---

### Agent E3 — Browser Layout / Rendering / Forms / Navigation / Performance

**Doc sections:** §11 Layout (items 441–470), §12 Rendering (items 471–496),
§15 Forms (items 593–618), §16 Navigation (items 619–641),
§28c Layout Perf (items 891–904), §28d Render Perf (items 905–921),
§28f CSS Perf (items 943–952), §28g JS/Event Perf (items 953–965),
§28h Benchmarking (items 966–977)

**Source files to read:**
```
src/os/apps/browser/layout.ts
src/os/apps/browser/index.ts
src/os/apps/browser/cache.ts
src/os/apps/browser/perf.ts
```

**Focus:** BFC/IFC, width/height auto, margin collapsing, float, position
static/relative/absolute/fixed, `<li>` marker, flexbox, absolute positioning,
OOF layout, form elements (input types, textarea, select, submit), form
serialization, tab navigation, bookmarks, find-in-page, back/forward history,
image decode/cache, performance.now, rAF, rIC, MutationObserver flush timing,
dirty-rect tracking, double buffering.

**Already marked (skip):** 442, 444–447, 450, 451, 453, 454, 456, 475, 488,
593–604, 619–633, 637–638, 891, 896, 897, 905, 906, 911, 923, 926, 933, 934,
936, 943–946, 953–959, 962–964, 966–968, 971.

---

### Agent F — REPL / Terminal / Built-in APIs / Init / Package Manager / GUI

**Doc sections:** §17 REPL/Terminal (items 642–687),
§18 Built-in API Functions (items 688–741),
§20 Init System (items 716–727), §21 Package Manager (items 728–741),
§22 GUI/Window System (items 742–766), §23 Applications (items 767–785),
§24 Developer Tools (items 786–802)

**Source files to read:**
```
src/os/ui/terminal.ts
src/os/ui/wm.ts
src/os/ui/commands.ts
src/os/ui/repl.ts
src/os/core/sdk.ts
src/os/core/pkgmgr.ts
src/os/process/init.ts
```

**Focus:** ANSI SGR (bold, italic, underline — what's parsed vs silently
consumed?), cursor movement CSI, scrollback buffer, readline (Ctrl+C, Ctrl+U,
history), tab completion, REPL startup scripts, pretty-print/inspect/doc,
all `g.*` functions (ls/cd/ps/kill/spawn/top/ping/etc.), window drag/resize/
z-order/maximize/minimize, taskbar, dialog boxes, init respawn, service
manager, package install/remove/update, sandbox, text editor app.

**Already marked (skip):** 642–652, 659–665, 666, 688–741, 716–740, 742–756,
767–768, 786, 788–789.

---

### Agent G — IPC / Users / Security / VMM / Misc

**Doc sections:** §6 IPC (items 207–221), §3 VMM (items 128–144),
§19 Users & Security (items 742b–759b), §33 Misc (items 919–945),
§34 Hardening (items 946–958)

**Source files to read:**
```
src/os/ipc/ipc.ts
src/os/users/users.ts
src/os/core/sdk.ts       (ipc/users surface)
src/os/core/fdtable.ts
src/os/core/config.ts
src/os/core/locale.ts
src/os/core/timezone.ts
src/os/fs/filesystem.ts  (VMA/memory sections)
```

**Focus:** Pipe/named-pipe/channel/event-bus implementations, shared memory,
sleep/interval timers, select/multiplex, VMM allocate/free/COW/demand paging,
`/proc/meminfo`, user store, password hashing, login/session, capability flags,
audit log, timezone/locale APIs, `/etc/config.json`, PRNG entropy seeding,
sys.config get/set, fs.watch, session log.

**Already marked (skip):** 138, 169, 170, 173, 174, 176, 180, 182, 184–189,
196, 207, 208, 211, 212, 214, 215, 742b–757b, 919–927, 930–932, 934.

---

## Phase 2 — Batch Writes (after all Phase 1 agents complete)

### Pre-write: Deduplication & Merge

Before writing anything:
1. Collect all findings lists from the 9 agents into one master list.
2. Check for duplicate item numbers — if two agents found the same item, keep
   the one with the more precise location note.
3. Verify no item that is already marked `✓` is in the list (would corrupt it).
4. Group findings by section to create non-overlapping write batches.

### Write Batches (can run in parallel since line ranges don't overlap)

```
Batch 1:  Items from §1–2     (lines ~14–155)    ← Agent A findings
Batch 2:  Items from §3–4     (lines ~156–215)   ← Agent G + B findings
Batch 3:  Items from §5–6     (lines ~215–265)   ← Agent G + D findings
Batch 4:  Items from §7–8     (lines ~265–410)   ← Agent C + D findings
Batch 5:  Items from §9–12    (lines ~410–570)   ← Agent E2 + E3 findings
Batch 6:  Items from §13–16   (lines ~570–645)   ← Agent E1 + E3 findings
Batch 7:  Items from §17–24   (lines ~640–1015)  ← Agent F findings
Batch 8:  Items from §19,§33  (lines ~850–950)   ← Agent G findings
Batch 9:  Items from §28a-h   (lines ~1080–1165) ← Agent B + E3 findings
```

Each batch uses `multi_replace_string_in_file` with as many replacements as
there are findings in that section — all in a single tool call.

---

## Phase 3 — Validation (single agent, sequential)

After all write batches complete:

```
1. grep_search docs/1000-things.md for "✓" — count total marked items.
2. grep_search for any line matching [P0] or [P1] (without ✓) — spot-check
   5-10 randomly to confirm they are genuinely not implemented.
3. grep_search for any malformed lines (e.g., double ✓, missing —, broken
   item numbers) that might have been introduced by writes.
4. Report final totals: X items marked ✓ out of ~1130 total.
```

---

## Coordination Rules

### Rule 1: No writes during Phase 1
Agents A–G are strictly read-only. They call `grep_search`, `read_file`,
`semantic_search`. They return data. They do not call `replace_string_in_file`
or `multi_replace_string_in_file`.

### Rule 2: Return format is strict
Each agent returns a JSON array. Every entry must have:
- `item` — integer item number
- `oldLine` — the exact current line text (used as the `oldString` in the
  replace call; must match exactly including whitespace)
- `newLine` — the replacement line with `✓` and location note appended after
  ` — `
- `confidence` — `"high"` (code directly found) or `"medium"` (inferred from
  related code). Only `"high"` items are written. `"medium"` items are flagged
  for human review.

### Rule 3: Location notes must be precise
Acceptable: `— _jit_hook_impl() sets _in_jit_hook=1 before JS_Call in kernel/quickjs_binding.c`
Not acceptable: `— implemented in quickjs_binding.c`

Location notes must include:
- The specific function or class name
- The file path (workspace-relative, no `src/os/` prefix needed if obvious)
- A brief description of what the code does that satisfies the item

### Rule 4: Do not mark stubs
A stub is code that exists but does nothing meaningful — an empty function body,
a `// TODO`, a `throw new Error('not implemented')`, or a constant that is
never used. If the item says "X works" and the code only declares X without
implementing logic, do not mark it.

### Rule 5: Do not re-verify already-marked items
Items that already contain `✓` are done. Do not re-read their source, do not
propose changes to their location notes. Skip them entirely.

### Rule 6: Sections 29–35 are low-yield
Sections 29 (Compatibility), 30 (Documentation), 31 (Install), 32 (Legal),
34 (Hardening), 35 (Release Checklist) contain mostly aspirational items with
few implemented ones. Agents should scan these quickly using grep rather than
deep file reads, looking only for items with specific API names that appear in
the codebase.

### Rule 7: Browser section is the richest
The browser (`jsruntime.ts`, `dom.ts`, `css.ts`, `layout.ts`) accounts for
~40% of all items and ~60% of already-implemented-but-unmarked items.
Agents E1/E2/E3 should be the most thorough.

---

## Agent Prompt Template

Use this prompt for each Phase 1 agent invocation:

```
You are auditing the JSOS codebase to find items in docs/1000-things.md
that are already implemented but not yet marked ✓.

YOUR ASSIGNED SECTIONS: [section names and item number ranges]
YOUR SOURCE FILES: [list of files to check]

TASK:
1. Read the assigned sections of docs/1000-things.md. Note every item that
   does NOT already have ✓ in its prefix.
2. For each unmarked item, search the assigned source files for working
   implementations. Use grep_search and read_file as needed.
3. For each item you confirm is implemented, record:
   - item number
   - exact current line text (copy verbatim)
   - replacement line with [Px ✓] and a location note after " — "
   - confidence: "high" only if you directly found the code

DO NOT write to any file. Return only the JSON findings array.

SKIP these already-marked items: [list of item numbers]

VERIFICATION RULE: Only mark "high" confidence if you can cite a specific
function/class name and file. Do not mark stubs, TODOs, or declarations
that lack implementation logic.
```

---

## Expected Throughput

Based on sessions so far:
- ~12 items marked per focused session (single-agent, sequential)
- 9 parallel agents × estimated 8–15 findings each = **72–135 new items** per run
- Estimated unmarked-but-implemented items remaining: ~80–120
- Target: complete the audit in **one full parallel run**

---

## Files Reference

```
docs/1000-things.md          ← the audit file (1430 lines, ~1130 items)
docs/pplan.md                ← this file
agents.md                    ← vision/architecture constraints

src/kernel/                  ← C code (hardware only)
src/os/core/                 ← TypeScript kernel glue (sdk, fdtable, config)
src/os/process/              ← scheduler, JIT, signals, init, pkgmgr
src/os/fs/                   ← VFS, proc, dev, buffer-cache
src/os/storage/              ← ATA block device, FAT32, FAT16
src/os/net/                  ← TCP/IP stack, TLS, HTTP, DNS, DHCP, crypto
src/os/ipc/                  ← pipes, channels, event bus, signals, timers
src/os/users/                ← auth, users, groups, capabilities
src/os/ui/                   ← terminal, WM, REPL, commands
src/os/apps/browser/         ← full browser engine (HTML/CSS/layout/render/JS)
```
