# Agent F — REPL / Terminal / Built-in APIs / Init / UI

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §17 REPL & Terminal | 642–687 |
| §18 Built-in API Functions | 688–715 |
| §20 Init System | 716–727 |
| §21 Package Manager | 728–741 |
| §22 GUI / Window System | 742–766 |
| §23 Applications | 767–785 |
| §24 Developer Tools | 786–802 |

---

## Source Files to Read

```
src/os/ui/terminal.ts
src/os/ui/wm.ts           ← window manager
src/os/ui/commands.ts     ← shell built-ins: ls, cd, ps, kill, ping, etc.
src/os/ui/repl.ts         ← REPL engine
src/os/core/sdk.ts        ← g.* namespace: g.ls, g.ps, g.spawn, g.top, etc.
src/os/core/pkgmgr.ts     ← package manager
src/os/process/init.ts    ← init/supervisor
```

---

## Focus Areas

**REPL & Terminal (§17):**
- ANSI SGR codes: bold, dim, italic, underline, blink, reverse, strikethrough
- 8-colour and 256-colour modes (`;38;5;N` and `38;2;R;G;B`)
- Cursor movement CSI: up/down/left/right/absolute (`\x1b[A`, `\x1b[H`)
- Erase line (`\x1b[K`), erase display (`\x1b[J`)
- Scrollback buffer size and scroll commands
- Readline: `Ctrl+C` (SIGINT), `Ctrl+D` (EOF), `Ctrl+U` (clear line),
  `Ctrl+W` (delete word), `Ctrl+L` (clear screen)
- History: `Arrow-Up/Down`, persistence across sessions
- Tab completion: commands, file paths
- REPL startup scripts (`~/.jsostrc` or similar)
- `inspect()` / pretty-print
- `doc()` / help system
- Multi-line input (detect incomplete expression)

**Built-in APIs (§18) — `g.*` namespace:**
- `g.ls()`, `g.cd()`, `g.pwd()`
- `g.ps()`, `g.kill(pid, sig)`, `g.spawn(cmd)`
- `g.top()` — live process monitor
- `g.ping(host)`, `g.nslookup(host)`, `g.ifconfig()`
- `g.cat(file)`, `g.write(file, data)`, `g.rm(file)`, `g.mkdir(path)`
- `g.wget(url)`, `g.curl(url, opts)`
- `g.env()`, `g.setenv(k, v)`
- `g.date()`, `g.uptime()`
- `g.mount()`, `g.umount()`
- `g.chmod()`, `g.chown()`
- `g.man(cmd)` / help docs
- `g.bench(fn)` — micro-benchmark helper

**Init System (§20):**
- Service start/stop/restart
- Respawn crashed services (how many retries? backoff?)
- Dependency ordering
- `/etc/init.d/` service scripts or equivalent
- Runlevels or targets

**Package Manager (§21):**
- `g.pkg.install(name)`, `g.pkg.remove(name)`, `g.pkg.update()`
- Package registry (local filesystem or network?)
- Dependency resolution
- Sandbox for installed packages

**GUI / WM (§22):**
- Window creation with title bar + borders
- Drag to move, drag border to resize
- Z-order (`bringToFront`, `sendToBack`)
- Maximize / minimize / restore
- Taskbar with window list
- Desktop icons
- System dialogs: alert, confirm, prompt, file-open, color-picker

**Applications (§23):**
- Text editor (with syntax highlighting?)
- File manager
- Image viewer
- System monitor (`top` style)
- Calculator
- Calendar

**Developer Tools (§24):**
- Console (JS REPL integrated in browser tab)
- DOM inspector
- Network inspector (request/response log)
- Performance profiler
- Source viewer

---

## Already Marked — Skip These

Read `1000-things.md` for sections §17–24 first to see exact current state.
Known previously-marked ranges: 642–665, 688–715 (check for gaps).
