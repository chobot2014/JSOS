# JSOS — Operating System Implementation

> **The Inviolable Architecture Principle**
>
> **TypeScript IS the operating system. C is not.**
>
> C code exists solely to translate bare-metal hardware signals into generic primitives
> that JavaScript can consume. Every algorithm, every data structure, every policy —
> scheduling, memory management, filesystems, network protocols, window layout,
> security — lives in TypeScript. This is not a preference. It is the definition of
> what JSOS is.

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      JSOS Architecture                           │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │            Applications (TypeScript)                        │ │
│  │   Browser · Terminal · Editor · File Manager                │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │            System Services (TypeScript)                     │ │
│  │   Init · Users · IPC · Window Manager · Commands            │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │                 OS Core (TypeScript)                        │ │
│  │   Scheduler · VMM · VFS · TCP/IP · TLS · Canvas            │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │         QuickJS ES2023 Runtime (C, unmodified)              │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │    Hardware Abstraction Layer (C — primitives only)         │ │
│  │  VGA/FB · PS/2 · PIT · ATA · virtio-net · PCI · Paging     │ │
│  ├──────────────────────────────────────────────────────────────┤ │
│  │                  x86 Bare Metal                             │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## The C Code Rule

| ✅ C MAY do | ❌ C may NOT do |
|---|---|
| Read/write I/O ports | Scheduling algorithms |
| Write pixels to a framebuffer address | Filesystem metadata |
| Decode a PS/2 packet to dx/dy/buttons | Network protocol parsing |
| Send/receive a raw Ethernet frame | Memory allocation strategies |
| Handle the CPU interrupt entry point | Device-specific logic beyond raw I/O |
| Set up paging hardware registers | Page fault policy |

If it can be written in TypeScript, it must be written in TypeScript.

---

## What Is Built

### Boot & Core

| Component | File |
|---|---|
| Boot (multiboot1, GDT, IDT, PIC) | `src/kernel/boot.s`, `kernel.c` |
| QuickJS ES2023 integration | `src/kernel/quickjs_binding.c` |
| VGA text mode 80×25 | `src/kernel/platform.c` |
| PS/2 keyboard driver | `src/kernel/keyboard.c` |
| PS/2 mouse driver | `src/kernel/mouse.c` |
| PIT timer 100Hz | `src/kernel/timer.c` |
| IRQ routing | `src/kernel/irq.c` |
| Serial COM1 debug output | `src/kernel/platform.c` |
| PCI bus enumeration | `src/kernel/pci.c` |
| Terminal emulator | `src/os/ui/terminal.ts` |
| JavaScript REPL | `src/os/ui/repl.ts` |
| Text editor | `src/os/ui/editor.ts` |
| REPL command registry | `src/os/ui/commands.ts` |
| Syscall interface | `src/os/core/syscalls.ts` |
| Init / runlevel system | `src/os/process/init.ts` |

### Storage

| Component | File |
|---|---|
| ATA PIO driver (C primitive) | `src/kernel/ata.c` |
| Block device + 64-sector LRU cache | `src/os/storage/block.ts` |
| FAT16 read/write + auto-format | `src/os/storage/fat16.ts` |
| FAT32 read/write + auto-format | `src/os/storage/fat32.ts` |
| ROM filesystem (bundled resources) | `src/os/fs/romfs.ts` |

### Filesystem

| Component | File |
|---|---|
| In-memory VFS with mount points | `src/os/fs/filesystem.ts` |
| /proc virtual filesystem | `src/os/fs/proc.ts` |
| /dev device nodes | `src/os/fs/dev.ts` |
| Persistent disk at /disk (FAT32 primary, FAT16 fallback) | `src/os/core/main.ts` |

### Memory Management

| Component | File |
|---|---|
| Physical page frame allocator (bitmap) | `src/os/process/physalloc.ts` |
| Virtual memory manager + mmap/mprotect | `src/os/process/vmm.ts` |
| Hardware paging (CR3, CR4.PSE, TLB flush) | `src/kernel/quickjs_binding.c` |

### Multitasking

| Component | File |
|---|---|
| Kernel thread model (priority round-robin) | `src/os/process/threads.ts` |
| Mutex / CondVar / Semaphore | `src/os/process/sync.ts` |
| Process manager: fork / exec / waitpid / VMA tracking | `src/os/process/process.ts` |
| Signals (POSIX subset) | `src/os/process/signals.ts` |
| ELF32 parser + loader | `src/os/process/elf.ts` |
| Unified fd table + epoll | `src/os/core/fdtable.ts` |
| Pipes + socketpair | `src/os/core/fdtable.ts` |
| Preemptive scheduler hook (100Hz C→TS) | `src/kernel/quickjs_binding.c` |
| Multi-process QuickJS pool (8 isolated runtimes) | `src/kernel/quickjs_binding.c` |
| Shared memory buffers (zero-copy ArrayBuffer) | `src/kernel/quickjs_binding.c` |

### Networking

| Component | File |
|---|---|
| virtio-net NIC driver (C primitive) | `src/kernel/virtio_net.c` |
| Full TCP/IP stack: Ethernet→ARP→IPv4→TCP/UDP/ICMP | `src/os/net/net.ts` |
| DHCP client | `src/os/net/dhcp.ts` |
| DNS resolver | `src/os/net/dns.ts` |
| TLS 1.3 client (X25519 + AES-128-GCM-SHA256) | `src/os/net/tls.ts` |
| Crypto primitives (SHA256, HMAC, HKDF, AES-GCM, X25519) | `src/os/net/crypto.ts` |
| HTTP/HTTPS client | `src/os/net/http.ts` |

### Graphics & UI

| Component | File |
|---|---|
| VESA framebuffer negotiate + blit (C primitive) | `src/kernel/platform.c` |
| Pixel Canvas (32-bit BGRA, 8×8 bitmap font) | `src/os/ui/canvas.ts` |
| Window manager (z-order, drag, resize, taskbar, cursor) | `src/os/ui/wm.ts` |
| Windowed terminal app | `src/os/apps/terminal-app.ts` |
| Windowed editor app | `src/os/apps/editor-app.ts` |
| Native HTML browser (HTML parser + HTTP/HTTPS + scrolling) | `src/os/apps/browser.ts` |

### Users & IPC

| Component | File |
|---|---|
| User / group management | `src/os/users/users.ts` |
| IPC: pipes, message queues, signals | `src/os/ipc/ipc.ts` |

---

## Project File Structure

```
src/
  kernel/              C — hardware primitives only
    boot.s / crt0.s    multiboot entry point
    kernel.c           GDT, IDT, PIC initialisation
    quickjs_binding.c  ALL kernel.* JS bindings
    ata.c / ata.h      ATA PIO block device
    platform.c         VGA text, VESA framebuffer, serial
    keyboard.c         PS/2 keyboard (IRQ1)
    mouse.c            PS/2 mouse (IRQ12)
    irq.c / irq_asm.s  interrupt dispatch, ISR stubs
    timer.c            PIT 100Hz
    memory.c           physical memory detection
    pci.c / pci.h      PCI bus enumeration
    virtio_net.c       virtio-net NIC
    linker.ld          memory layout
    Makefile

  os/                  TypeScript — the actual operating system
    core/
      kernel.ts        C binding declarations (sole TS↔C contract)
      main.ts          boot sequence, hardware init, REPL entry
      syscalls.ts      POSIX syscall interface
      fdtable.ts       unified fd table, pipes, epoll
    process/
      threads.ts       kernel thread model, priority round-robin
      sync.ts          Mutex, CondVar, Semaphore
      process.ts       fork / exec / waitpid / VMA tracking
      signals.ts       signal delivery (POSIX subset)
      elf.ts           ELF32 parser + loader
      vmm.ts           virtual memory manager, mmap, mprotect
      physalloc.ts     physical page bitmap allocator
      scheduler.ts     cooperative scheduler
      init.ts          init + service manager
    fs/
      filesystem.ts    in-memory VFS with mount points
      proc.ts          /proc filesystem
      dev.ts           /dev device nodes
      romfs.ts         bundled read-only resources
    storage/
      block.ts         block device abstraction + 64-sector LRU cache
      fat16.ts         FAT16 read/write + auto-format
      fat32.ts         FAT32 read/write + auto-format
    net/
      net.ts           full TCP/IP stack (loopback + virtio-net)
      dhcp.ts          DHCP client
      dns.ts           DNS resolver
      tls.ts           TLS 1.3 client
      crypto.ts        SHA256, HMAC, HKDF, AES-GCM, X25519
      http.ts          HTTP/HTTPS client
    ui/
      terminal.ts      terminal emulator (VGA text + windowed)
      repl.ts          JavaScript REPL
      editor.ts        fullscreen text editor
      canvas.ts        pixel Canvas, 32-bit color, 8×8 bitmap font
      wm.ts            window manager
      commands.ts      REPL global command registry
    apps/
      terminal-app.ts  windowed terminal app
      browser.ts       native HTML browser app
      editor-app.ts    windowed editor app
    users/
      users.ts         user / group management
    ipc/
      ipc.ts           IPC: pipes, message queues, signals
```

---

## Implementation Rules

1. **C is for hardware, TypeScript is for logic.** If in doubt: TypeScript.
2. **New C primitives require a `kernel.ts` declaration** before they are callable from TypeScript.
3. **The REPL is always preserved.** It is the OS escape hatch — reachable in both text and windowed modes.
4. **Serial log is the test oracle.** Headless QEMU must boot and print expected output before any change ships.
5. **`disk.*` and `/disk` are stable.** User scripts that write to persistent storage must survive reboots.
6. **Loopback-first networking.** The TCP/IP stack works without a NIC; virtio-net is always additive.

---

## Capability Roster

| Capability | Done |
|---|---|
| Boots to REPL (VGA text mode) | ✅ |
| 8×8 bitmap font, full printable ASCII | ✅ |
| VESA pixel framebuffer | ✅ |
| Canvas pixel rendering (32-bit color) | ✅ |
| PS/2 mouse input | ✅ |
| Window manager (drag, resize, z-order, taskbar) | ✅ |
| Windowed terminal | ✅ |
| Windowed editor | ✅ |
| Native HTML browser (HTTP + HTTPS) | ✅ |
| In-memory VFS with mount points | ✅ |
| /proc virtual filesystem | ✅ |
| /dev device nodes | ✅ |
| Persistent FAT16 disk | ✅ |
| Persistent FAT32 disk (auto-detected) | ✅ |
| ROM filesystem (bundled resources) | ✅ |
| Physical page frame allocator | ✅ |
| Hardware paging (CR3, CR4.PSE, TLB) | ✅ |
| Virtual memory manager (mmap, mprotect) | ✅ |
| Kernel threads (priority round-robin) | ✅ |
| Mutex / CondVar / Semaphore | ✅ |
| Preemptive scheduler hook (100Hz C→TS) | ✅ |
| fork / exec / waitpid | ✅ |
| Unified fd table + epoll | ✅ |
| Pipes + socketpair | ✅ |
| Signals (POSIX subset) | ✅ |
| ELF32 loader | ✅ |
| Multi-process QuickJS pool (8 isolated runtimes) | ✅ |
| Zero-copy shared memory buffers | ✅ |
| TCP/IP stack (loopback) | ✅ |
| virtio-net NIC driver | ✅ |
| DHCP client | ✅ |
| DNS resolver | ✅ |
| TLS 1.3 (X25519 + AES-128-GCM-SHA256) | ✅ |
| HTTP/HTTPS client | ✅ |
| PCI bus enumeration | ✅ |
| User / group management | ✅ |
| IPC (pipes, message queues) | ✅ |
| Init + runlevel service manager | ✅ |
