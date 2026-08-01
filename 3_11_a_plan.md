# 3/11 Performance Plan A — Extreme Speed Pass

## Objective
Implement all high-ROI performance improvements identified in the full OS audit
to maximize JS execution speed, reduce scheduling latency, and improve memory
allocation efficiency.

## Batch 1 — Quick Wins (constants & thresholds)

### 1. Raise JIT_THRESHOLD 2 → 50
**File:** `src/os/process/qjs-jit.ts:90`
**Why:** Threshold of 2 compiles virtually every function including cold startup
code, one-shot initializers, and error handlers.  This wastes JIT pool memory
and compilation CPU time on code that will never recoup the cost.  V8 uses ~1000
interpreter ticks; SpiderMonkey ~100.  50 is aggressive enough for a bare-metal
OS where we want fast warmup, but avoids compiling throwaway functions.

### 2. Lower scheduler timeSlice 10 → 3 frames
**File:** `src/os/process/scheduler.ts:187`
**Why:** At ~50 fps, 10 frames = ~200 ms quantum — a CPU-bound process blocks
all other processes and the WM for 200 ms before preemption.  Linux CFS uses
4–6 ms.  3 frames (~60 ms) is still generous but eliminates the worst-case
200 ms jank.

### 3. Lower procTick job limit 256 → 32
**File:** `src/kernel/quickjs_binding.c:1919`
**Why:** Each procTick drains up to 256 pending async jobs serially.  A process
with rapid Promise.resolve() chains monopolises the CPU for 256 job executions
before yielding.  32 jobs per tick is enough for progress while keeping latency
under control.

### 4. Raise MAX_BC_LEN 4096 → 16384
**File:** `src/os/process/qjs-jit.ts:99`
**Why:** Browser rendering code, complex parsers, and bundled modules often
exceed 4096 bytes of bytecode.  The function silently falls back to
interpretation.  16384 covers most real-world functions.

### 5. JIT pool GC eviction 50% → 25%
**File:** `src/os/process/qjs-jit.ts:1670`
**Why:** Evicting 50% of compiled functions is over-aggressive — causes
redundant recompilation of warm-but-not-hot functions.  25% eviction retains
more compiled code while still freeing pool space.

## Batch 2 — JIT Register Allocation (ESI + EDI)

### 6. Extend RegAllocInfo to track ESI and EDI locals
**File:** `src/os/process/qjs-jit.ts:2601–2655`
**Why:** x86-32 has 3 callee-saved registers (EBX, ESI, EDI).  Currently only
EBX is used for the hottest local.  Each additional register local eliminates
2 memory operations (load + store) per access.  For a typical 3-local loop,
this removes ~60% of memory traffic.

**Changes:**
- Extend `RegAllocInfo` with `esiLocal` and `ediLocal` fields
- Extend `RegAllocPass.run()` to find 2nd/3rd hottest locals
- Add `_Emit` helpers: `movEaxEsi`, `movEaxEdi`, `movEsiEbpDisp`, etc.
- Update `_isRegLocal()` to check all 3 registers
- Update prologue/epilogue to save/restore ESI/EDI
- Update `OP_get_loc`/`OP_put_loc`/`OP_set_loc` emission to use the right register

## Batch 3 — O(1) Physical Page Allocator

### 7. Replace O(n) linear scan with free-page stack
**File:** `src/os/process/vmm.ts:653–667`
**Why:** Current allocator iterates all pages (131K for 512 MB RAM) on every
allocation.  A free-page stack gives O(1) alloc and O(1) free — standard in
all real OS kernels.

**Changes:**
- Initialize a `freePageStack: number[]` with all pages at construction time
- `allocatePhysicalPage()` → `pop()` from stack (O(1))
- `freePhysicalPage()` → `push()` to stack (O(1))
- Remove `allocatedPhysicalPages` Set (no longer needed for allocation)

## Batch 4 — Event-Driven Main Loop

### 8. Replace fixed 8 ms sleep with adaptive sleep
**File:** `src/os/core/main.ts:406`
**Why:** `kernel.sleep(8)` wastes CPU when idle (wakes 125x/sec to do nothing)
and limits responsiveness when busy (can't process frames faster than 125 fps).
Adaptive sleep: 1 ms when work was done (fast poll), 16 ms when idle (save power).

### 9. Decouple scheduler.tick() from WM frame rate
**File:** `src/os/core/main.ts:379`
**Why:** Process scheduling decisions happen only at WM frame rate (~50 fps =
~20 ms intervals).  Running scheduler.tick() from the _tickFn at 1 ms polling
when active halves worst-case scheduling latency.

**Change:** Already accomplished if we lower sleep to 1 ms when active — the
scheduler tick runs on every main loop iteration regardless of WM frame timing.
The WM's own internal frame throttling handles render frequency.

## Implementation Order

1. Constants & thresholds (items 1–5) — all one-line edits
2. _Emit register helpers (ESI/EDI instructions)
3. RegAllocPass extension (3-register allocation)
4. QJSJITCompiler prologue/epilogue + get/put/set local updates
5. O(1) page allocator
6. Adaptive main loop sleep
7. Build, test, commit

## Expected Impact

| Change | Metric | Before | After |
|--------|--------|--------|-------|
| JIT threshold 50 | Pool waste | ~95% cold funcs | ~20% cold funcs |
| Time slice 3 | Worst-case latency | 200 ms | 60 ms |
| procTick 32 | Promise storm block | 256 jobs | 32 jobs |
| 3-reg alloc | Memory ops/loop | 6 loads+stores | 0–2 loads+stores |
| O(1) page alloc | Page fault latency | O(131K) | O(1) |
| Adaptive sleep | Idle CPU | 125 wakes/sec | ~62 wakes/sec |
| MAX_BC_LEN 16K | JIT coverage | Small funcs only | Most real JS |
| Pool GC 25% | Recompilation waste | 50% evicted | 25% evicted |
