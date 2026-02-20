# Architecture

## System Layers

```
┌───────────────────────────────────────────────────────────────┐
│                  Applications (TypeScript)                     │
│   browser.ts · terminal-app.ts · editor-app.ts                │
├───────────────────────────────────────────────────────────────┤
│                  System Services (TypeScript)                  │
│   init · users · ipc · wm · commands                          │
├───────────────────────────────────────────────────────────────┤
│                  OS Core (TypeScript)                          │
│   canvas · net · tls · crypto · http                          │
│   vfs · fat32 · fat16 · block · romfs                         │
│   threads · sync · process · vmm · physalloc · elf · signals  │
│   repl · terminal · editor                                    │
├───────────────────────────────────────────────────────────────┤
│                  QuickJS ES2023 (C, unmodified)                │
│              quickjs_binding.c ↔ kernel.* globals              │
├───────────────────────────────────────────────────────────────┤
│                  C Kernel (C11 / i686-elf)                     │
│   kernel.c  platform.c  keyboard.c  mouse.c  timer.c          │
│   irq.c  ata.c  virtio_net.c  pci.c  memory.c  syscalls.c    │
├───────────────────────────────────────────────────────────────┤
│                  x86 Bare Metal (Multiboot/GRUB 2)             │
│   GRUB  ·  VGA text  ·  VESA FB  ·  PS/2  ·  PIT  ·  ATA    │
│   virtio-net  ·  PCI  ·  paging registers                     │
└───────────────────────────────────────────────────────────────┘
```

---

## Boot Sequence

```
GRUB 2
 └─▶ boot.s            (multiboot header, stack setup, call kernel_main)
      └─▶ kernel.c :: main()
           ├─ terminal_initialize()   – VGA 80×25 text mode
           ├─ memory_initialize()     – heap ready
           ├─ gdt_flush()             – load GDT from irq_asm.s
           ├─ irq_initialize()        – IDT + PIC, enable interrupts
           ├─ timer_initialize(100)   – PIT at 100 Hz
           ├─ keyboard_initialize()   – IRQ1 + key queues
           ├─ mouse_initialize()      – IRQ12 + mouse packet queue
           ├─ pci_scan()              – enumerate PCI devices (finds virtio-net)
           ├─ quickjs_initialize()    – create QJS runtime + context
           │    └─ register all kernel.* C bindings as JS globals
           └─ quickjs_run_os()
                └─ JS_Eval(embedded_js_code …)
                     └─ main()  [src/os/core/main.ts]
                          ├─ mountVFS('/proc', '/dev')    – virtual filesystems
                          ├─ installRomFiles()            – bundled resources
                          ├─ fat32.mount() | fat16.mount()– persistent /disk
                          ├─ init.initialize()            – runlevel services
                          ├─ physAlloc.init()             – physical page allocator
                          ├─ vmm.enableHardwarePaging()   – CR3, CR4.PSE
                          ├─ registerSchedulerHook()      – 100Hz C→TS tick
                          ├─ fork/exec/pipe/ELF tests     – POSIX layer smoke tests
                          ├─ net.initNIC() + DHCP + DNS   – networking (if NIC present)
                          ├─ fbInfo() check
                          │   ├─ [FB present] createScreenCanvas()
                          │   │   ├─ new WindowManager()  – compositor
                          │   │   ├─ WM.createWindow(browserApp)
                          │   │   ├─ WM.createWindow(terminalApp)
                          │   │   └─ WM event loop (60fps, kernel.yield())
                          │   └─ [no FB] startRepl()      – VGA text fallback
```

---

## Source Tree

```
src/
├── kernel/                  C kernel + QuickJS binding
│   ├── boot.s               Multiboot header, initial stack
│   ├── crt0.s               C runtime init
│   ├── irq_asm.s            GDT/IDT assembly, ISR trampolines
│   ├── kernel.c             Main entry point, hardware init
│   ├── platform.c           VGA text, VESA framebuffer, serial
│   ├── memory.c             Physical memory detection
│   ├── keyboard.c           PS/2 keyboard (IRQ1)
│   ├── mouse.c              PS/2 mouse (IRQ12)
│   ├── timer.c              PIT 100Hz
│   ├── irq.c                IDT setup, PIC remapping
│   ├── ata.c                ATA PIO block device
│   ├── pci.c                PCI bus enumeration
│   ├── virtio_net.c         virtio-net NIC driver
│   ├── syscalls.c           newlib bare-metal stubs
│   ├── math_impl.c          freestanding math
│   ├── quickjs_binding.c    ALL kernel.* JS bindings
│   ├── linker.ld            Memory layout (kernel at 1 MB)
│   └── Makefile             i686-elf-gcc build rules
│
└── os/                      TypeScript — the actual OS
    ├── core/
    │   ├── kernel.ts        C binding declarations (sole TS↔C contract)
    │   ├── main.ts          Boot sequence + entry point
    │   ├── syscalls.ts      POSIX syscall interface
    │   └── fdtable.ts       Unified fd table, pipes, epoll
    ├── process/
    │   ├── threads.ts       Kernel threads, priority round-robin
    │   ├── sync.ts          Mutex, CondVar, Semaphore
    │   ├── process.ts       fork/exec/waitpid, VMA tracking
    │   ├── signals.ts       Signal delivery (POSIX subset)
    │   ├── elf.ts           ELF32 parser + loader
    │   ├── vmm.ts           Virtual memory, mmap, mprotect
    │   ├── physalloc.ts     Physical page bitmap allocator
    │   ├── scheduler.ts     Cooperative scheduler
    │   └── init.ts          Init + runlevel manager
    ├── fs/
    │   ├── filesystem.ts    In-memory VFS with mount points
    │   ├── proc.ts          /proc filesystem
    │   ├── dev.ts           /dev device nodes
    │   └── romfs.ts         Bundled read-only resources
    ├── storage/
    │   ├── block.ts         Block device + 64-sector LRU cache
    │   ├── fat16.ts         FAT16 read/write + auto-format
    │   └── fat32.ts         FAT32 read/write + auto-format
    ├── net/
    │   ├── net.ts           Full TCP/IP stack
    │   ├── dhcp.ts          DHCP client
    │   ├── dns.ts           DNS resolver
    │   ├── tls.ts           TLS 1.3 client
    │   ├── crypto.ts        SHA256, HMAC, HKDF, AES-GCM, X25519
    │   └── http.ts          HTTP/HTTPS client
    ├── ui/
    │   ├── terminal.ts      Terminal emulator
    │   ├── repl.ts          JavaScript REPL
    │   ├── editor.ts        Fullscreen text editor
    │   ├── canvas.ts        Pixel Canvas, bitmap font
    │   ├── wm.ts            Window manager
    │   └── commands.ts      REPL command registry
    ├── apps/
    │   ├── terminal-app.ts  Windowed terminal
    │   ├── browser.ts       Native HTML browser
    │   └── editor-app.ts    Windowed editor
    ├── users/
    │   └── users.ts         User/group management
    └── ipc/
        └── ipc.ts           Pipes, message queues, signals
```

---

## How TypeScript Becomes Machine Code

```
TypeScript sources (src/os/**/*.ts)
        │
        ▼  esbuild (type-strip only, no polyfills)
build/bundle.js   (single IIFE ES2023, ~500 KB)
        │
        ▼  scripts/embed-js.js
src/kernel/embedded_js.h   (C const char array)
        │
        ▼  i686-elf-gcc -ffreestanding + QuickJS
src/kernel/jsos.bin   (ELF32, ~2 MB)
        │
        ▼  grub-mkrescue
build/jsos.iso   (~10 MB bootable ISO)
```

All of the above runs inside a **Docker container** that has:
- i686-elf cross-compiler (GCC + Binutils + Newlib)
- QuickJS source (compiled as static library)
- GRUB 2 (`grub-mkrescue`, `grub-common`, `xorriso`)
- Node 18 (for esbuild + embed scripts)

---

## Memory Map

| Region | Address | Notes |
|---|---|---|
| Kernel load | `0x00100000` | ELF loaded at 1 MB by GRUB |
| BSS heap | extends kernel | QuickJS + static alloc (256 MB configured) |
| VGA text buffer | `0x000B8000` | 4 KB (80×25×2 bytes) |
| VESA framebuffer | varies | negotiated by GRUB; typically 0xFD000000 |
| Kernel page directory | static | set up by TypeScript VMM via `kernel.setPageEntry` |
| Physical pages | above kernel | tracked by bitmap in `physalloc.ts` |
| Total QEMU RAM | — | 256 MB recommended (`-m 256`) |

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| QuickJS over V8/SpiderMonkey | Compiles to freestanding C, tiny footprint, full ES2023 |
| No libc except newlib stubs | `-ffreestanding` — only what's explicitly implemented |
| TypeScript → ES2023 (no polyfills) | type-strip only; QuickJS supports ES2023 natively |
| In-memory VFS + FAT32 | Fast volatile FS for /tmp, /proc; persistent /disk survives reboot |
| REPL as primary UI | Eliminates the shell parsing layer — the JS engine IS the interpreter |
| `kernel.waitKeyEx()` | Separate extended-key C queue so arrows never collide with printable chars |
| Loopback-first TCP/IP | Network stack works without hardware; virtio-net is purely additive |
| TLS 1.3 in pure TypeScript | No C crypto deps; X25519 + AES-GCM + SHA256 all in `crypto.ts` |
| WM over bare VGA | VESA framebuffer enables real pixel GUI; VGA text is always the fallback |
