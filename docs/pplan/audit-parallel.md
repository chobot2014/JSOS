# Audit: 1000-Things Parallelization Protocol

**Task:** Mark every already-implemented item in `docs/1000-things.md` as `✓`.  
**File:** `c:\DEV\JSOS\docs\1000-things.md` — 1430 lines, ~1130 items, 35 sections.  
**Current state:** See [state.md](state.md).

---

## Item Format

```
847. [P0] JIT: compile hot functions ...        ← NOT marked
88.  [P0 ✓] Virtio-net: C signals RX ...       ← already done
```

Target text for a new mark:
```
847. [P0 ✓] JIT: compile hot functions ... — JIT_THRESHOLD=100 in process/qjs-jit.ts
```

---

## Three-Phase Protocol

### Phase 1 — Parallel Research (9 agents, read-only)

All agents run simultaneously. **No agent writes to any file.**  
Each agent returns a strict JSON array (see [Agent Contract](#agent-contract)).

```
Agent A  →  src/kernel/*.c         →  §1–2  (items 1–127)
Agent B  →  src/os/process/        →  §4, §28a (items 145–167, 847–876)
Agent C  →  src/os/net/net.ts      →  §7 (items 222–275)
Agent D  →  net/{dns,tls,http,…}   →  §7.6–8 (items 276–348)
Agent E1 →  browser/{jsruntime,dom,workers}.ts  →  §13–14 (items 497–592)
Agent E2 →  browser/{html,css}.ts  →  §9–10 (items 349–440)
Agent E3 →  browser/{layout,index,perf,cache}.ts  →  §11–12, §15–16, §28c-h
Agent F  →  ui/, core/sdk.ts       →  §17–24 (items 642–802)
Agent G  →  ipc/, users/, core/    →  §3, §6, §19 (items 128–144, 207–221)
```

### Phase 2 — Coordinated Batch Writes

After **all** Phase 1 agents complete:

1. Collect all JSON findings into a master list.
2. Deduplicate — if two agents found the same item, keep the more precise note.
3. Filter out `"confidence": "medium"` items (flag for human review instead).
4. Group by section → 9 non-overlapping line-range batches.
5. Each batch runs `multi_replace_string_in_file` in a single call.

**Non-overlapping write batches (line ranges are approximate):**

| Batch | Sections | Lines |
|-------|----------|-------|
| 1 | §1–2 | ~14–155 |
| 2 | §3–4 | ~156–215 |
| 3 | §5–6 | ~215–265 |
| 4 | §7–8 | ~265–410 |
| 5 | §9–12 | ~410–570 |
| 6 | §13–16 | ~570–645 |
| 7 | §17–24 | ~645–815 |
| 8 | §19/§33 | ~850–950 |
| 9 | §28a–h | ~1080–1165 |

### Phase 3 — Validation

Single sequential agent:
1. `grep_search` for `✓` — count total marked items.
2. `grep_search` for `[P0]` without `✓` — spot-check 5–10 for genuine gaps.
3. Scan for malformed lines: double `✓`, missing ` — `, broken item numbers.
4. Report totals to `state.md`.

---

## Agent Contract

Every Phase 1 agent must return this exact JSON shape:

```json
[
  {
    "item": 847,
    "oldLine": "847. [P0] JIT: compile hot functions to x86-32 ...",
    "newLine": "847. [P0 ✓] JIT: compile hot functions to x86-32 ... — JIT_THRESHOLD=100 in process/qjs-jit.ts",
    "confidence": "high"
  }
]
```

Fields:
- `item` — integer item number
- `oldLine` — verbatim current line text (used directly as `oldString`)
- `newLine` — replacement with `[Px ✓]` and ` — <location note>` appended
- `confidence` — `"high"` (code directly read) or `"medium"` (inferred)

**Only `"high"` confidence items proceed to Phase 2 writes.**

---

## Verification Standard

An item may be marked `✓` only when **all three** of these are true:

1. **Function/class exists** — you can name the specific function or class
2. **Logic is implemented** — it's not an empty body, stub, or TODO
3. **File is readable** — you found it by reading the actual source, not guessing

### Anti-patterns — do NOT mark these

| Pattern | Example |
|---------|---------|
| Empty function | `function handleFrag() {}` |
| TODO comment | `// TODO: implement fragmentation` |
| Declaration only | `declare function foo(): void` |
| Referenced but absent | Config mentions `TmpFS` but no `TmpFS` class exists |
| Partially working | `deopt()` exists but `MAX_DEOPTS` guard is missing |

---

## Agent Prompt Template

```
You are auditing the JSOS codebase to find items in docs/1000-things.md
that are already implemented but not yet marked ✓.

YOUR SECTIONS: [section names and item ranges from your agent-X.md]
YOUR SOURCE FILES: [file list from your agent-X.md]

STEPS:
1. Read your assigned sections of docs/1000-things.md. List every item
   that does NOT already have ✓ in its prefix.
2. For each unmarked item, search only your assigned source files.
3. For confirmed implementations, record oldLine, newLine, confidence.

RULES:
- DO NOT write to any file. Return JSON only.
- confidence "high" = you read the specific code. "medium" = inferred.
- Location note must name the function/class and file.
- Skip stubs, TODOs, empty bodies.
- Skip already-marked items (listed in your spec file).

Return a JSON array of findings. Nothing else.
```

---

## Expected Yield

Based on sessions completed so far:
- ~12 items marked per focused single-agent session
- 9 parallel agents × ~8–15 findings each = **72–135 new items per run**
- Estimated remaining unmarked-but-implemented: **80–120 items**
- Target: **complete in one full parallel run**
