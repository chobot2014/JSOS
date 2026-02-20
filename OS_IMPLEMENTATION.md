# JSOS — Operating System Implementation Plan

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
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │               Applications (TypeScript)                    │  │
│  │   Terminal · Browser · Editor · File Manager · Games ...   │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │               System Services (TypeScript)                 │  │
│  │   Init · Users · IPC · Logging · Package Manager           │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                   OS Core (TypeScript)                     │  │
│  │   Scheduler · VMM · FS · TCP/IP · Window Manager           │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │            QuickJS ES2023 Runtime (C, unmodified)          │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │       Hardware Abstraction Layer (C — primitives only)     │  │
│  │   VGA/FB · Keyboard · Mouse · Timer · ATA · NIC · PCI      │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                    x86 Bare Metal                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## The C Code Rule

| ✅ C MAY do | ❌ C may NOT do |
|---|---|
| Read/write I/O ports | Scheduling algorithms |
| Write pixels to a framebuffer address | File system metadata |
| Decode a PS/2 packet to dx/dy/buttons | Network protocol parsing |
| Send/receive a raw Ethernet frame | Memory allocation strategies |
| Handle the CPU interrupt entry point | Device-specific logic beyond raw I/O |
| Set up paging registers | Page fault policy |

If it can be written in TypeScript, it must be written in TypeScript.
Third-party C/C++ libraries live in `lib/` — they are never part of the OS.

---

## Phase Index

| Phase | Name | Status | Detail |
|---|---|---|---|
| 1 | Core Infrastructure | ✅ Complete | [phase-1-core-infrastructure.md](phases/phase-1-core-infrastructure.md) |
| 2 | Storage & I/O | ✅ Complete | [phase-2-storage-io.md](phases/phase-2-storage-io.md) |
| 3 | Graphics, Mouse & Browser | ✅ Complete | [phase-3-graphics-mouse-browser.md](phases/phase-3-graphics-mouse-browser.md) |
| 4 | Real Memory Management | ✅ Complete | [phase-4-memory-management.md](phases/phase-4-memory-management.md) |
| 5 | Preemptive Multitasking | ✅ Complete | [phase-5-preemptive-multitasking.md](phases/phase-5-preemptive-multitasking.md) |
| 6 | POSIX Layer | ✅ Complete | [phase-6-posix-layer.md](phases/phase-6-posix-layer.md) |
| 7 | Real Networking | ✅ Complete | [phase-7-networking.md](phases/phase-7-networking.md) |
| 8 | Graphics Stack (SwiftShader) | ✅ Complete | [phase-8-graphics-stack.md](phases/phase-8-graphics-stack.md) |
| 9 | Chromium Port | ☐ | [phase-9-chromium-port.md](phases/phase-9-chromium-port.md) |
| 10 | Post-Chromium Hardening | ☐ | [phase-10-post-chromium.md](phases/phase-10-post-chromium.md) |

---

## Current State (Phases 1 + 2 Complete)

### Phase 1 ✅ — Core Infrastructure

| Component | File |
|---|---|
| Boot (multiboot1, GDT, IDT, PIC) | `src/kernel/boot.s`, `kernel.c` |
| QuickJS ES2023 integration | `src/kernel/quickjs_binding.c` |
| VGA text mode 80×25 | `src/kernel/platform.c` |
| PS/2 keyboard driver | `src/kernel/keyboard.c` |
| PIT timer 100Hz | `src/kernel/timer.c` |
| IRQ routing | `src/kernel/irq.c` |
| Serial COM1 debug | `src/kernel/platform.c` |
| Terminal emulator | `src/os/ui/terminal.ts` |
| JavaScript REPL | `src/os/ui/repl.ts` |
| Text editor | `src/os/ui/editor.ts` |
| In-memory VFS + /proc | `src/os/fs/filesystem.ts`, `proc.ts` |
| Process scheduler (simulated) | `src/os/process/scheduler.ts` |
| Virtual memory manager (simulated) | `src/os/process/vmm.ts` |
| Init / runlevel system | `src/os/process/init.ts` |
| Syscall interface | `src/os/core/syscalls.ts` |
| User/group system | `src/os/users/users.ts` |
| IPC (pipes, signals, queues) | `src/os/ipc/ipc.ts` |
| Full TCP/IP stack | `src/os/net/net.ts` (loopback only) |

### Phase 2 ✅ — Storage & I/O

| Component | File |
|---|---|
| ATA PIO driver (C primitives) | `src/kernel/ata.c` |
| Block device + 64-sector LRU cache | `src/os/storage/block.ts` |
| FAT16 read/write + auto-format | `src/os/storage/fat16.ts` |
| `disk.*` REPL API | `src/os/core/main.ts` |

### Current Limits

| Resource | Now | Needed for Chromium |
|---|---|---|
| Heap | 8 MB static | ~512 MB |
| Scheduling | Cooperative simulation | Real preemption |
| Paging | Flat (no page tables) | mmap, mprotect, JIT |
| Threads | None | 2050 at idle |
| Display | VGA text 8025 | Pixel framebuffer |
| Networking | Loopback only | Real NIC + TLS |

---

## Project File Structure

```
src/
  kernel/              C  hardware primitives only
    boot.s / crt0.s    multiboot entry
    kernel.c           GDT, IDT, PIC
    quickjs_binding.c  ALL kernel.* JS bindings
    ata.c / ata.h      ATA PIO (Phase 2)
    platform.c         VGA, serial, framebuffer (Phase 3)
    keyboard.c         PS/2 keyboard + mouse
    irq.c / irq_asm.s  interrupt handling
    timer.c            PIT 100Hz
    memory.c           physical memory query
    virtio_net.c       NIC  virtio (Phase 7)
    e1000.c            NIC  Intel E1000 (Phase 7)
    linker.ld          memory layout
    Makefile

  os/                  TypeScript  the actual operating system
    core/
      kernel.ts        C binding type declarations
      main.ts          OS boot + global API
      syscalls.ts      POSIX syscall interface
      fdtable.ts       unified fd table (Phase 6)
    process/
      scheduler.ts     scheduling algorithms
      vmm.ts           virtual memory manager
      init.ts          init + service management
      physalloc.ts     physical page allocator (Phase 4)
      threads.ts       thread model (Phase 5)
      sync.ts          mutex / condvar / semaphore (Phase 5)
      elf.ts           ELF loader (Phase 6)
      signals.ts       signal delivery (Phase 6)
    fs/
      filesystem.ts    in-memory VFS
      proc.ts          /proc filesystem
      dev.ts           /dev filesystem (Phase 6)
      drm.ts           DRM/KMS shim (Phase 8)
    storage/
      block.ts         block device + LRU cache
      fat16.ts         FAT16 driver
    net/
      net.ts           full TCP/IP stack
      sockets.ts       POSIX socket API (Phase 7)
      dhcp.ts          DHCP client (Phase 7)
      dns.ts           DNS resolver (Phase 7)
      tls.ts           TLS wrapper (Phase 7)
    ui/
      terminal.ts      terminal emulator
      repl.ts          JavaScript REPL (always preserved)
      editor.ts        text editor
      canvas.ts        pixel Canvas (Phase 3)
      wm.ts            window manager (Phase 3)
    graphics/
      swiftshader.ts   SwiftShader init bridge (Phase 8)
    audio/
      audio.ts         audio mixer (Phase 10)
    apps/
      browser.ts       NetSurf browser app (Phase 3)
      chromium-app.ts  Chromium WM wrapper (Phase 9)
    users/
      users.ts         user/group management
    ipc/
      ipc.ts           IPC mechanisms

lib/                   Third-party libraries  NOT part of JSOS
  netsurf/             HTML/CSS rendering (Phase 3)
  mbedtls/             TLS (Phase 7)
  swiftshader/         Software Vulkan/OpenGL ES (Phase 8)
  gbm-jsos/            GBM buffer shim (Phase 8)
  acpica/              ACPI tables (Phase 10)
```

---

## Implementation Rules

1. **C is for hardware, TypeScript is for logic.** If in doubt: TypeScript.
2. **New C primitives require a `kernel.ts` declaration** before shipping.
3. **Third-party libraries go in `lib/`** and are bridged by a TypeScript adapter.
   They are never imported directly by `src/os/`.
4. **Each phase builds and boots cleanly on its own.** No phase may break the REPL.
5. **The REPL is always preserved.** It is the OS escape hatch — always reachable.
6. **Serial log is the test oracle.** Headless QEMU test must pass before any phase ships.
7. **`disk.*` API is stable from Phase 2 onward.** User scripts must keep working.

---

## Capability Checklist

| Capability | Phase | Done |
|---|---|---|
| Boots to REPL | 1 | ✅ |
| Persistent FAT16 disk | 2 | ✅ |
| Pixel framebuffer (VESA) | 3 | ☐ |
| Canvas + bitmap font | 3 | ☐ |
| Mouse input (PS/2) | 3 | ☐ |
| Window manager | 3 | ☐ |
| Windowed terminal | 3 | ☐ |
| NetSurf HTML browser | 3 | ☐ |
| 64MB+ heap | 3 | ☐ |
| Real physical allocator | 4 | ☐ |
| Paging / mmap / mprotect | 4 | ☐ |
| Kernel/user address split | 4 | ☐ |
| Preemptive scheduling | 5 | ☐ |
| Kernel threads | 5 | ☐ |
| Mutex / condvar / semaphore | 5 | ☐ |
| fork / exec / waitpid | 6 | ☐ |
| Unified fd table + epoll | 6 | ☐ |
| Pipes + socketpair | 6 | ☐ |
| Signals | 6 | ☐ |
| /proc/self/maps, /dev/urandom | 6 | ☐ |
| ELF loader | 6 | ☐ |
| Real Ethernet (virtio-net) | 7 | ☐ |
| TCP/IP wired to hardware | 7 | ☐ |
| POSIX sockets + epoll | 7 | ☐ |
| TLS (mbedTLS) | 7 | ☐ |
| SwiftShader software GL | 8 | ☐ |
| DRM/KMS shim (/dev/dri/card0) | 8 | ☐ |
| Chromium GN build target | 9 | ☐ |
| Chromium Ozone backend | 9 | ☐ |
| **Chromium boots to browser window** | **9** | **☐** |
| SMP multi-core | 10 | ☐ |
| JSOS sandbox | 10 | ☐ |
| Package manager | 10 | ☐ |
| Audio | 10 | ☐ |
| USB | 10 | ☐ |
| x86_64 port | 10 | ☐ |
