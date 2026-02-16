# JSOS — JavaScript Operating System

**A complete operating system written in TypeScript, running on bare metal x86 hardware.**

JSOS compiles TypeScript to JavaScript, embeds it in a custom C kernel powered by [QuickJS](https://bellard.org/quickjs/) (a full ES2023 engine by Fabrice Bellard), and boots from a standard ISO image via GRUB. The result is a real, interactive OS where every user-facing feature — the shell, the filesystem, the REPL, process management — is written in TypeScript.

![Architecture: TypeScript → ES2023 → QuickJS → C Kernel → x86 Bare Metal](https://img.shields.io/badge/stack-TypeScript→ES2023→QuickJS→C→x86-blue)

---

## Features

### Interactive Shell
- Full command-line shell with 25+ built-in commands
- Colored prompt with hostname and working directory
- Command history
- Tab-style categorized help system

### JavaScript REPL
- Live JavaScript evaluation on bare metal
- Multi-line mode for complex expressions
- Direct access to `kernel.*` APIs from the REPL
- Syntax-highlighted output (numbers, strings, errors, etc.)

### In-Memory Filesystem
- Unix-like path hierarchy (`/bin`, `/etc`, `/home`, `/tmp`, `/var`, `/proc`, `/dev`)
- Full path resolution with `.`, `..`, `~` support
- File operations: `ls`, `cd`, `cat`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `write`, `find`, `stat`
- Pre-loaded example JavaScript programs in `/bin/`

### Kernel Features
- **VGA text-mode terminal** — 80×25 with scrolling, hardware cursor, and 16 colors
- **PS/2 keyboard driver** — IRQ-driven with full US layout, shift, ctrl, caps lock
- **Programmable Interval Timer** — 100 Hz tick, uptime tracking, `sleep()` support
- **IDT/PIC interrupt system** — Proper IRQ handling with GDT and PIC remapping
- **Memory management** — 1MB pool with allocation tracking
- **QuickJS engine** — Full ES2023 support (classes, arrow functions, async/await, destructuring, Map, Set, Promise, etc.)

### Kernel API (accessible from TypeScript)
```typescript
kernel.print(msg)           // Print with newline
kernel.printRaw(msg)        // Print without newline
kernel.clear()              // Clear screen
kernel.setColor(fg, bg)     // Set VGA colors (0-15)
kernel.getColor()           // Get current color
kernel.setCursor(row, col)  // Move cursor
kernel.getCursor()          // Get cursor position
kernel.getScreenSize()      // Returns {width: 80, height: 25}
kernel.getMemoryInfo()      // Returns {total, free, used}
kernel.readline()           // Blocking line input from keyboard
kernel.waitKey()            // Wait for single keypress
kernel.hasKey()             // Check if key available
kernel.readKey()            // Non-blocking key poll
kernel.getUptime()          // Milliseconds since boot
kernel.getTicks()           // Raw timer ticks
kernel.sleep(ms)            // Sleep for N milliseconds
kernel.eval(code)           // Evaluate JavaScript code
kernel.halt()               // Halt the CPU
kernel.reboot()             // Reboot the system
kernel.inb(port)            // Read I/O port
kernel.outb(port, val)      // Write I/O port
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 TypeScript OS Layer              │
│  main.ts → shell.ts → repl.ts                   │
│  terminal.ts  filesystem.ts  system.ts           │
├─────────────────────────────────────────────────┤
│        Babel + esbuild → ES2023 Bundle           │
│       (type-strip only — no polyfills!)          │
├─────────────────────────────────────────────────┤
│            QuickJS Engine (ES2023, C)            │
│        quickjs_binding.c ↔ kernel APIs           │
├─────────────────────────────────────────────────┤
│               C Kernel (i686-elf)                │
│  terminal.c │ keyboard.c │ timer.c │ irq.c       │
│  memory.c   │ syscalls.c │ io.h   │ math_impl.c │
├─────────────────────────────────────────────────┤
│         x86 Bare Metal (Multiboot/GRUB)          │
│            boot.s → crt0.s → kernel.c            │
└─────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- **Docker** (for the cross-compilation toolchain)
- **Node.js** ≥ 18
- **QEMU** (for testing — `qemu-system-i386`)

### Build & Run

```bash
# Install dependencies
npm install

# Build the ISO (compiles TypeScript, cross-compiles kernel, creates bootable ISO)
npm run build

# Test in QEMU
npm run test
```

### Development Workflow

```bash
# Build TypeScript only (fast iteration)
npm run build:local

# Full build + test
npm run dev

# Interactive QEMU session (with keyboard input)
npm run test:interactive

# Windows: Test with local QEMU
npm run test:windows
```

---

## Shell Commands

| Category | Commands |
|----------|----------|
| **Filesystem** | `ls`, `cd`, `pwd`, `cat`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `write`, `find`, `stat` |
| **System** | `mem`, `uptime`, `ps`, `sysinfo`, `date`, `hostname`, `test` |
| **JavaScript** | `js` (REPL), `eval <expr>`, `run <file.js>` |
| **Terminal** | `clear`, `echo`, `colors`, `sleep`, `motd`, `history` |
| **Power** | `reboot`, `halt`, `shutdown` |

### Example Session

```
jsos:/$ help
jsos:/$ sysinfo
jsos:/$ ls /bin
hello.js        colors.js       sysinfo.js
jsos:/$ run /bin/hello.js
Hello, World!
jsos:/$ js
js> 2 + 2
4
js> kernel.getMemoryInfo()
{"total":1048576,"free":1000000,"used":48576}
js> for (var i=0; i<16; i++) { kernel.setColor(i,0); kernel.printRaw("X"); }
js> .exit
jsos:/$ eval Math.PI * 2
6.283185307179586
```

---

## Project Structure

```
src/
  kernel/                  # C kernel (bare metal)
    boot.s                 # Multiboot entry point
    crt0.s                 # C runtime startup
    kernel.c               # Main kernel init
    terminal.c             # VGA text mode driver (80×25, scrolling, cursor)
    keyboard.c             # PS/2 keyboard driver (IRQ1, US layout)
    timer.c                # PIT timer driver (IRQ0, 100 Hz)
    irq.c                  # IDT/PIC interrupt system
    irq_asm.s              # Assembly ISR stubs + GDT
    memory.c               # Memory pool allocator
    quickjs_binding.c      # JS ↔ kernel bridge (QuickJS API, 22 functions)
    syscalls.c             # Newlib system call stubs
    math_impl.c            # Math library (sin, cos, sqrt, etc.)
    io.h                   # Port I/O (inb/outb)
    linker.ld              # Linker script (loads at 1MB)
    Makefile               # Cross-compile with i686-elf-gcc
  os/                      # TypeScript OS layer
    main.ts                # Boot sequence + entry point
    shell.ts               # Interactive shell (25+ commands)
    repl.ts                # JavaScript REPL
    terminal.ts            # Terminal abstraction (colors, formatting)
    filesystem.ts          # In-memory Unix-like filesystem
    system.ts              # Process manager
    kernel.ts              # TypeScript type declarations for kernel API
scripts/
    bundle-hybrid.js       # Babel + esbuild bundler (TS → ES2023, type-strip only)
    build.sh               # Full kernel + ISO build
    embed-js.sh            # Embeds JS bundle as C string literal
docker/
    build.Dockerfile       # Cross-compiler toolchain (binutils + GCC + newlib + QuickJS)
    test.Dockerfile        # QEMU test environment
```

---

## How It Works

1. **TypeScript** source files in `src/os/` have types stripped via Babel and are bundled with esbuild (ES2023 target — no polyfills needed!)
2. The JS bundle is **embedded as a C string literal** in `embedded_js.h`
3. The C kernel is **cross-compiled** with `i686-elf-gcc` + newlib for bare metal i386
4. QuickJS is compiled from source and linked into the kernel binary
5. The kernel binary is packaged into a **bootable ISO** with GRUB
6. On boot: GRUB → `boot.s` → `kernel.c` → GDT → IDT/PIC → Timer → Keyboard → QuickJS → **your TypeScript code runs**

---

## License

MIT
