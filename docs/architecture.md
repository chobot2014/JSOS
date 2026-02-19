# Architecture

## System Layers

```
┌──────────────────────────────────────────────────────────┐
│                     USER INTERFACE                        │
│         JavaScript REPL  (src/os/repl.ts)                │
│   ls()  cd()  cat()  ps()  mem()  help()  …              │
├──────────────────────────────────────────────────────────┤
│                      OS LAYER  (TypeScript)               │
│  main.ts        – entry point, global setup, banner       │
│  repl.ts        – readline, eval, multiline, history      │
│  filesystem.ts  – in-memory Unix-like VFS                 │
│  system.ts      – process table, SystemManager            │
│  terminal.ts    – colour print helpers                    │
│  kernel.ts      – TypeScript types for the kernel object  │
├──────────────────────────────────────────────────────────┤
│                  JAVASCRIPT ENGINE                         │
│              QuickJS ES2023  (bellard/quickjs)            │
│         768 KB heap  ·  32 KB stack  ·  no GC pauses      │
├──────────────────────────────────────────────────────────┤
│                  BINDING LAYER  (C)                        │
│         quickjs_binding.c  –  kernel.* globals            │
│   25 functions: print, clear, setColor, waitKeyEx,        │
│   getMemoryInfo, sleep, halt, reboot, eval, inb/outb …    │
├──────────────────────────────────────────────────────────┤
│                    C KERNEL  (C11 / i686-elf)             │
│  kernel.c     – main(), boot sequence                     │
│  terminal.c   – VGA text-mode driver (0xB8000)            │
│  memory.c     – bump allocator + free-list                │
│  keyboard.c   – PS/2 IRQ1 driver, extended-key queue      │
│  timer.c      – PIT 100 Hz, tick counter, sleep()         │
│  irq.c / irq_asm.s – IDT, PIC, ISR stubs                 │
│  syscalls.c   – newlib stubs (write, sbrk, …)            │
│  math_impl.c  – freestanding math polyfills               │
├──────────────────────────────────────────────────────────┤
│                    HARDWARE  (i686 bare metal)             │
│   GRUB 2 multiboot  ·  VGA  ·  PS/2 keyboard  ·  PIT     │
└──────────────────────────────────────────────────────────┘
```

---

## Boot Sequence

```
GRUB 2
 └─▶ boot.s            (multiboot header, stack setup, call kernel_main)
      └─▶ kernel.c :: main()
           ├─ terminal_initialize()   – set up VGA text buffer
           ├─ memory_initialize()     – heap ready
           ├─ gdt_flush()             – load GDT from irq_asm.s
           ├─ irq_initialize()        – IDT + PIC, enable interrupts
           ├─ timer_initialize(100)   – PIT at 100 Hz
           ├─ keyboard_initialize()   – IRQ1 handler, key queues
           ├─ quickjs_initialize()    – create QJS runtime + context
           │    └─ register kernel.* C functions as JS globals
           └─ quickjs_run_os()
                └─ JS_Eval(embedded_js_code …)
                     └─ main()  [src/os/main.ts]
                          ├─ setupConsole()    – console.log → VGA
                          ├─ setupGlobals()    – ls, cd, cat, ps, … as globals
                          ├─ printBanner()     – JSOS ASCII art
                          └─ startRepl()       – infinite REPL loop
```

---

## Source Tree

```
src/
├── kernel/                 C kernel + QuickJS binding
│   ├── boot.s              Multiboot header, initial stack
│   ├── crt0.s              C runtime init (calls main)
│   ├── irq_asm.s           GDT/IDT assembly, ISR trampolines
│   ├── kernel.c            Main entry point
│   ├── terminal.c / .h     VGA 80×25 text-mode driver
│   ├── memory.c / .h       Heap allocator
│   ├── keyboard.c          PS/2 driver (char + extended queues)
│   ├── timer.c             PIT, tick counter, timer_sleep()
│   ├── irq.c               IDT setup, PIC remapping
│   ├── syscalls.c          newlib bare-metal stubs
│   ├── math_impl.c         freestanding math (sin, cos, sqrt …)
│   ├── quickjs_binding.c   JS ↔ C bridge — all kernel.* functions
│   ├── quickjs_binding.h
│   ├── linker.ld           Linker script (1 MB load address)
│   └── Makefile            i686-elf-gcc build rules
│
└── os/                     TypeScript userland
    ├── main.ts             Entry point, global setup, banner
    ├── repl.ts             REPL loop, readline, eval, history
    ├── filesystem.ts       In-memory VFS (FileSystem class)
    ├── system.ts           Process table (SystemManager class)
    ├── terminal.ts         Colour print helpers
    ├── kernel.ts           TypeScript types for kernel.*
    └── tsconfig.json       TS config (ES5 target, no emit)
```

---

## How TypeScript Becomes Machine Code

```
TypeScript sources (src/os/*.ts)
        │
        ▼  Babel  (@babel/preset-typescript + preset-env)
ES5 JavaScript
        │
        ▼  esbuild  (bundle-hybrid.js)
build/bundle.js   (single IIFE, ~200 KB)
        │
        ▼  embed-js.js
src/kernel/embedded_js.h   (C char array)
        │
        ▼  i686-elf-gcc -ffreestanding
src/kernel/jsos.bin   (ELF)
        │
        ▼  grub-mkrescue
build/jsos.iso   (~10 MB bootable ISO)
```

All of the above runs inside a **Docker container** that has:
- i686-elf cross-compiler (GCC + Binutils + Newlib)
- QuickJS source (cloned, patched, compiled as library)
- GRUB 2 (`grub-mkrescue`, `grub-common`, `xorriso`)
- Node 18 (for Babel/esbuild)

---

## Memory Map

| Region | Address | Size |
|---|---|---|
| Kernel load | `0x00100000` | — |
| QuickJS heap | dynamic | 768 KB max |
| QuickJS stack | dynamic | 32 KB max |
| VGA text buffer | `0x000B8000` | 4 KB (80×25×2 bytes) |
| Total QEMU RAM | — | 32 MB (`-m 32`) |

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| QuickJS over V8/SpiderMonkey | Compiles to freestanding C, tiny footprint, full ES2023 |
| No libc except newlib stubs | `-ffreestanding` — only what's explicitly implemented |
| TypeScript → ES5 | QuickJS supports ES2023 but the transpile step catches type errors at build time |
| In-memory filesystem | No disk driver needed; survives a full OS without persistent storage |
| REPL as primary UI | Eliminates the shell parsing layer — the JS engine IS the command interpreter |
| `kernel.waitKeyEx()` | Separate C-level extended-key queue so arrow keys never collide with printable chars |
