# JSOS — Active Plan Index

Each file in this folder is a self-contained context plan for one task or agent.
Open the relevant file before starting work. Update `state.md` as you go.

---

## Active Tasks

| File | Task | Status |
|------|------|--------|
| [audit-parallel.md](audit-parallel.md) | Parallel audit of `1000-things.md` — protocol, phases, rules | 🟡 in-progress |
| [state.md](state.md) | Running state tracker — what's marked, what's confirmed ✗ | 🟡 in-progress |

## Agent Specs (Phase 1 — Read-Only)

| File | Agent | Covers |
|------|-------|--------|
| [agent-A.md](agent-A.md) | A — Kernel/Boot | `src/kernel/*.c` · §1–2 (items 1–127) |
| [agent-B.md](agent-B.md) | B — Process/JIT | `src/os/process/` · §4, §28a (items 145–167, 847–876) |
| [agent-C.md](agent-C.md) | C — TCP/UDP/IP | `src/os/net/net.ts` · §7 (items 222–275) |
| [agent-D.md](agent-D.md) | D — DNS/TLS/HTTP | `net/{dns,tls,http,crypto}.ts` · §7.6–8 (items 276–348) |
| [agent-E1.md](agent-E1.md) | E1 — Browser JS Runtime | `jsruntime.ts`, `dom.ts`, `workers.ts` · §13–14 (items 497–592) |
| [agent-E2.md](agent-E2.md) | E2 — HTML/CSS | `html.ts`, `css.ts` · §9–10 (items 349–440) |
| [agent-E3.md](agent-E3.md) | E3 — Layout/Render/Forms | `layout.ts`, `index.ts`, `perf.ts` · §11–12, §15–16, §28c-h |
| [agent-F.md](agent-F.md) | F — REPL/Terminal/UI | `ui/`, `core/sdk.ts` · §17–24 (items 642–802) |
| [agent-G.md](agent-G.md) | G — IPC/Users/VMM | `ipc/`, `users/`, `core/` · §3, §6, §19 |

## How to Use

1. **Start a task** → open its `.md` file, read the context, update status.
2. **Phase 1 (research)** → run agents against their assigned source files.  
   Each agent returns JSON only — no file writes.
3. **Phase 2 (write)** → merge findings, call `multi_replace_string_in_file`
   per section batch. Update `state.md`.
4. **Phase 3 (validate)** → grep for `✓` count, spot-check unmarked items.

See [audit-parallel.md](audit-parallel.md) for the full protocol.
