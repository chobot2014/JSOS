# Agent B — Process Manager / Scheduler / JIT

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §4 Process Manager | 145–167 |
| §28a JIT Speed | 847–876 |

---

## Source Files to Read

```
src/os/process/scheduler.ts
src/os/process/process.ts
src/os/process/signals.ts
src/os/process/init.ts
src/os/process/jit.ts
src/os/process/jit-os.ts        ← lines 8–20: 3-tier JIT architecture docs
src/os/process/qjs-jit.ts       ← 762 lines; TypeSpeculator, deopt, JIT_THRESHOLD
src/os/process/jsprocess.ts
```

---

## Focus Areas

**Process Manager (§4):**
- `fork()` copy semantics — does it duplicate FDTable via `clone()`? address space?
- `exec()` — replaces current process image? argument passing?
- `waitpid()` — blocking wait, SIGCHLD delivery
- PID allocation and recycling
- `/proc/[pid]/` entries: `stat`, `cmdline`, `maps`, `fd/`
- Process groups and sessions (`setpgrp`, `setsid`)
- `proc.setScheduler()` (real-time policy) — is this exposed via system call?

**JIT (§28a):**
- `JIT_THRESHOLD` value (doc says 1000, actual is 100 — already confirmed)
- Inline caches for property reads/writes — look for `IC_` prefix or property cache
- Float/SSE2 JIT ops — look for `XMM` register usage in generated code
- Dead code elimination — look for `DCE` or `eliminateDead` in JIT passes
- Register allocator — look for `RegisterAllocator` or `regAlloc`
- On-stack replacement (OSR) — look for `osr` or `OnStackReplacement`
- JIT for loops — look for loop-header detection/back-edge optimization
- `DEOPT_SENTINEL = 0x7FFFDEAD` (already confirmed, check neighbors)

---

## Already Marked — Skip These

```
150, 151, 155, 159, 847, 850, 857, 863
```

---

## Notes from Prior Work

- **Item 847** (JIT threshold): `qjs-jit.ts` line 72 `JIT_THRESHOLD = 100`.
- **Item 850** (integer type specialization): `TypeSpeculator.allIntegerLike()` lines 173–232.
- **Item 857** (3-tier JIT): documented at `jit-os.ts` lines 8–20.
- **Item 863** (deopt): `deopt()` lines 682–691, `MAX_DEOPTS=3`, `DEOPT_SENTINEL=0x7FFFDEAD`.
- **Items 848/849** (inline caches): NOT found in prior search. Very likely not implemented.
- **Items 851/852/853/855/856** (float SSE, DCE, reg allocator, OSR): NOT found. Likely absent.
- **Item 160** (real-time scheduler `proc.setScheduler()`): `setAlgorithm()` exists internally
  but is NOT exposed as a process syscall. Do not mark 160.
