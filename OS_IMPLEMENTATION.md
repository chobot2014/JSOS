# JSOS — Operating System Implementation Plan

## The Inviolable Architecture Principle

**TypeScript IS the operating system. C is not.**

C code exists solely to translate bare-metal hardware signals into generic primitives
that JavaScript can consume. Every algorithm, every data structure, every policy —
scheduling, memory management, filesystems, network protocols, window layout,
security — lives in TypeScript. This is not a preference. It is the definition of
what JSOS is.

```
┌──────────────────────────────────────────────────────────────────┐
│                      JSOS Architecture                           │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                  Applications (TypeScript)                 │  │
│  │   Terminal · Browser · Editor · File Manager · Games ...  │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │                  System Services (TypeScript)              │  │
│  │   Init · Users · IPC · Logging · Package Manager          │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │                    OS Core (TypeScript)                    │  │
│  │   Scheduler · VMM · FS · TCP/IP · Window Manager          │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │              QuickJS ES2023 Runtime (C, unmodified)        │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │        Hardware Abstraction Layer (C — primitives only)    │  │
│  │   VGA/FB · Keyboard · Mouse · Timer · ATA · NIC · PCI     │  │
│  ├────────────────────────────────────────────────────────────┤  │
│  │                    x86 Bare Metal                          │  │
└──────────────────────────────────────────────────────────────────┘
```

### The C Code Rule

| ✅ C MAY do | ❌ C may NOT do |
|---|---|
| Read/write I/O ports | Scheduling algorithms |
| Write pixels to a framebuffer address | File system metadata |
| Decode a PS/2 packet to dx/dy/buttons | Network protocol parsing |
| Send/receive a raw Ethernet frame | Memory allocation strategies |
| Handle the CPU's interrupt entry point | Device-specific logic beyond raw I/O |
| Set up paging registers | Page fault policy |

If it can be written in TypeScript, it must be written in TypeScript.

Third-party C/C++ libraries (NetSurf, SwiftShader, etc.) live in `lib/` and are
treated as opaque hardware-like dependencies — they are never considered part of
the JSOS operating system itself.

---

## Current Status (Phase 1 + Phase 2 complete)

### Phase 1 — Core Infrastructure ✅

| Component | File | Status |
|---|---|---|
| Boot (multiboot1, GDT, IDT, PIC) | `src/kernel/boot.s`, `kernel.c` | ✅ |
| QuickJS ES2023 integration | `src/kernel/quickjs_binding.c` | ✅ |
| VGA text mode 80×25 | `src/kernel/platform.c` | ✅ |
| PS/2 keyboard driver | `src/kernel/keyboard.c` | ✅ |
| PIT timer 100Hz | `src/kernel/timer.c` | ✅ |
| IRQ/interrupt routing | `src/kernel/irq.c` | ✅ |
| Serial (COM1) debug output | `src/kernel/platform.c` | ✅ |
| TypeScript terminal emulator | `src/os/ui/terminal.ts` | ✅ |
| Full-screen REPL with history | `src/os/ui/repl.ts` | ✅ |
| Text editor | `src/os/ui/editor.ts` | ✅ |
| In-memory VFS + /proc | `src/os/fs/filesystem.ts`, `proc.ts` | ✅ |
| Process scheduler (TS, simulated) | `src/os/process/scheduler.ts` | ✅ |
| Virtual memory manager (TS) | `src/os/process/vmm.ts` | ✅ |
| Init / runlevel system | `src/os/process/init.ts` | ✅ |
| Syscall interface | `src/os/core/syscalls.ts` | ✅ |
| User/group system | `src/os/users/users.ts` | ✅ |
| IPC (pipes, signals, message queues) | `src/os/ipc/ipc.ts` | ✅ |
| TCP/IP stack in TypeScript | `src/os/net/net.ts` | ✅ (loopback only) |

### Phase 2 — Storage & I/O ✅

| Component | File | Status |
|---|---|---|
| ATA PIO driver (C — read/write primitives) | `src/kernel/ata.c` | ✅ |
| Block device abstraction + 64-sector LRU cache | `src/os/storage/block.ts` | ✅ |
| FAT16 filesystem (full read/write, auto-format) | `src/os/storage/fat16.ts` | ✅ |
| `disk.*` REPL API | `src/os/core/main.ts` | ✅ |

### Current Limits

| Resource | Value | Required for Chromium |
|---|---|---|
| Heap | 8 MB (static, linker.ld) | ~512 MB minimum |
| QuickJS memory limit | 6 MB | N/A (Chromium uses its own V8) |
| CPU mode | Protected mode, single core, cooperative | Preemptive, multicore |
| Scheduling | Simulated in TS (no real context switch) | Real preemption |
| Paging | Flat (no real page tables) | Required for mmap, JIT, sandbox |
| Threads | None | Chromium needs 20–50 at idle |
| Display | VGA text 80×25 | VESA/GOP pixel framebuffer |
| Mouse | None | Required |
| Networking | Loopback only | Real NIC + TLS |

---

## Phase 3 — Pixel Graphics, Mouse & First Browser

**Goal:** Replace VGA text mode with a pixel framebuffer. Add mouse input. Render
real HTML/CSS via NetSurf's library stack. The REPL/terminal becomes a windowed
application that is always available alongside other apps.

**The C Code Rule applied:** All window layout, event dispatch, rendering decisions,
and application logic remain in TypeScript. C adds three new primitives:
framebuffer blit, mouse packet read, and raw Ethernet send/receive.

### 3a — VESA Framebuffer (C)

Change the multiboot header to request a graphics mode (1024×768×32 or best
available) from GRUB. GRUB fills in a `multiboot_info` framebuffer structure —
physical address, width, height, pitch, bits-per-pixel. The C layer reads this
at boot time and exposes primitives:

```c
// New in platform.c / platform.h:
void platform_fb_init(multiboot_info_t *mbi);  // parse FB descriptor
void platform_fb_blit(uint32_t *buf, int x, int y, int w, int h);
void platform_fb_get_info(int *w, int *h, int *pitch, int *bpp);
// New kernel.* bindings:
kernel.fbInfo()                    // → {width, height, pitch, bpp}
kernel.fbBlit(pixels, x, y, w, h) // write pixel array to screen
```

Serial output is preserved for diagnostics. VGA text fallback stays if GRUB
reports no framebuffer.

### 3b — Canvas API (TypeScript — src/os/ui/canvas.ts)

Built entirely on `kernel.fbBlit`. No C logic.

```typescript
class Canvas {
  fillRect(x, y, w, h, color: number): void
  drawRect(x, y, w, h, color: number): void
  drawLine(x0, y0, x1, y1, color: number): void
  drawText(x, y, text: string, font: BitmapFont, color: number): void
  blit(src: Canvas, sx, sy, dx, dy, w, h): void
  flip(): void                    // double-buffer swap to framebuffer
}

class BitmapFont {
  // 8×16 PC bitmap font embedded as a data array (~4KB)
  // Renders any ASCII string to pixel data
}
```

### 3c — PS/2 Mouse Driver (C)

IRQ12 handler reads 3-byte PS/2 packets and accumulates delta/button state.
One new binding:

```c
// New in keyboard.c (or mouse.c):
kernel.readMouse()   // → {dx, dy, buttons} or null
```

Button debounce, movement accumulation, and cursor rendering are TypeScript.

### 3d — Window Manager (TypeScript — src/os/ui/wm.ts)

All layout, z-order, event routing, and rendering in TypeScript.

```typescript
class WindowManager {
  createWindow(opts: {title, x, y, width, height, app: App}): Window
  focusWindow(id: number): void
  moveWindow(id: number, dx, dy): void
  closeWindow(id: number): void
  dispatch(event: MouseEvent | KeyEvent): void
  render(): void   // composites all windows to Canvas, calls flip()
}

// Desktop always shows a taskbar with running apps.
// Terminal app is always resident — cannot be fully closed, only minimised.
```

### 3e — Terminal as a Windowed App

The existing `terminal.ts` and `repl.ts` become the first WM application.
They render into their window's sub-Canvas instead of the raw VGA buffer.
All existing REPL functionality (history, tab completion, multi-line, disk.*,
sys.*, etc.) is preserved.

### 3f — NetSurf Browser (lib/netsurf/)

NetSurf is the first third-party library added under `lib/`. It is explicitly
**not** part of JSOS — it is an external dependency compiled as a static archive.

```
lib/
  netsurf/           ← third-party HTML/CSS rendering library (C)
    hubbub/          ← HTML5 parser
    libcss/          ← CSS parser + cascade
    libdom/          ← DOM implementation
    libparserutils/  ← shared parsing utilities
    nsfb/            ← our custom framebuffer backend (bridges to Canvas)
```

The `nsfb` backend is written by us — it bridges NetSurf's pixel output to
our TypeScript Canvas. JavaScript execution inside web pages is routed to QuickJS.

### 3g — Memory Increase

Increase the static heap to 64 MB in `linker.ld`. Temporary — Phase 4 replaces the
static heap with a real physical page allocator. 64 MB is enough for NetSurf and
the WM compositor.

---

## Phase 4 — Real Memory Management

**Goal:** Remove the static heap from the linker script. Use all physical RAM that
GRUB reports via the multiboot memory map.

### 4a — Physical Page Allocator (TypeScript over C primitive)

```c
// New C primitive — reads multiboot memory map:
kernel.getMemoryMap()  // → [{base, length, type}]  (type 1 = usable)
```

TypeScript implements the page frame allocator — a bitmap of 4KB pages over the
usable ranges. All allocation decisions are in TypeScript.

```typescript
class PhysicalAllocator {
  alloc(pages: number): number       // returns physical address
  free(addr: number, pages: number): void
  available(): number                // bytes of free physical RAM
}
```

### 4b — Paging Enabled (C — register writes only)

```c
// C writes only the privileged registers TypeScript requests:
kernel.setPDPT(physAddr: number)                      // writes CR3
kernel.flushTLB(): void
kernel.setPageEntry(pdIdx, ptIdx, physAddr, flags)    // writes one PTE
```

TypeScript manages the page directory and page table structures entirely —
what maps where, what flags to set, when to flush. C only executes the
privileged instructions.

### 4c — Virtual Memory Manager (upgrade existing vmm.ts)

`vmm.ts` simulation becomes real. Calls the C page entry primitives and physical
allocator to create genuine virtual address mappings.

```typescript
vmm.mmap(hint, length, prot, flags): number   // actual page table manipulation
vmm.munmap(addr, length): void
vmm.mprotect(addr, length, prot): void        // needed for JIT code generation
```

### 4d — Kernel/User Split

```
0x00000000 – 0xBFFFFFFF   User space  (3 GB)
0xC0000000 – 0xFFFFFFFF   Kernel      (1 GB, identity mapped)
```

---

## Phase 5 — Preemptive Multitasking & Threads

**Goal:** Real context switching. Multiple threads with independent stacks.

### 5a — Preemptive Scheduler (C — context save/restore only)

The IRQ0 timer handler saves the full CPU state and calls a TypeScript hook.
TypeScript decides which thread runs next. C performs the `iret` to the new stack.

```c
// IRQ0 handler calls:
extern void js_scheduler_tick(void *saved_context);
// TypeScript returns the new stack pointer.
// C sets ESP and irets to it. That is ALL C does.
```

The scheduling algorithm (round-robin, priority, CFS) is entirely TypeScript.

### 5b — Thread Model (TypeScript — src/os/process/threads.ts)

```typescript
class Thread {
  tid: number; pid: number
  stack: number        // physical address of thread stack
  state: 'ready' | 'running' | 'blocked' | 'dead'
  savedContext: CPUContext
}
class ThreadManager {
  createThread(entryPoint: number, stackSize?: number): Thread
  exitThread(tid: number): void
  blockThread(tid: number): void
  unblockThread(tid: number): void
}
```

### 5c — TSS (Task State Segment)

Minimal C write of the TSS descriptor and ESP0 field for ring 0/3 transitions.
TypeScript tracks the TSS structure.

### 5d — Synchronisation Primitives (TypeScript)

```typescript
class Mutex    { lock(): void; unlock(): void; tryLock(): boolean }
class Condvar  { wait(m: Mutex): void; signal(): void; broadcast(): void }
class Semaphore { acquire(): void; release(): void }
```

These underpin `pthread_mutex`, `pthread_cond`, `sem_t` in the POSIX layer.

---

## Phase 6 — POSIX Layer

**Goal:** Enough POSIX that compiled C/C++ programs (and Chromium's `base/`)
can link against JSOS and run. This is the largest single phase.

### 6a — Process Model: fork / exec / wait

```c
// C primitive — clones the page directory (copy-on-write):
kernel.cloneAddressSpace(): number   // returns new CR3
```

TypeScript implements `fork()` semantics: duplicate fd table, signal handlers,
thread list. `exec()` loads an ELF binary into a fresh address space.
`waitpid()` is pure TypeScript.

### 6b — File Descriptors (src/os/core/fdtable.ts)

Unified fd table in TypeScript over all backends: in-memory FS, FAT16 disk,
pipes, sockets, `/proc`, `/dev`.

```typescript
class FDTable {
  open(path: string, flags: number): number
  close(fd: number): void
  read(fd: number, buf: number[], count: number): number
  write(fd: number, buf: number[], count: number): number
  dup2(oldfd: number, newfd: number): number
  fcntl(fd: number, cmd: number, arg?: number): number
  ioctl(fd: number, request: number, arg?: number): number
  seek(fd: number, offset: number, whence: number): number
  select(fds: number[], timeout: number): number[]
  epoll_create / epoll_ctl / epoll_wait(...)
}
```

### 6c — Pipes and socketpair

`pipe()` creates a ring-buffer pair wired into the fd table. `socketpair()` is
bidirectional. These are how Chromium's renderer and browser processes communicate.

### 6d — Signals (src/os/process/signals.ts)

```typescript
const SIGNALS = {
  SIGCHLD: 17, SIGSEGV: 11, SIGTERM: 15,
  SIGPIPE: 13, SIGALRM: 14, SIGUSR1: 10, SIGUSR2: 12,
}
class SignalManager {
  send(pid: number, sig: number): void
  handle(sig: number, handler: Function): void
  mask(sigs: number[]): void
}
```

Page fault → SIGSEGV: C reads the faulting address and calls into TypeScript.
TypeScript decides whether to deliver SIGSEGV or handle the fault (demand paging).

### 6e — /proc and /dev Virtual Files

`/proc/self/maps`, `/proc/self/status` — needed by Chromium's sandbox.
`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/fb0`, `/dev/input/mouse0`.
All VFSMount handlers in TypeScript.

### 6f — POSIX Time

`clock_gettime(CLOCK_REALTIME)`, `clock_gettime(CLOCK_MONOTONIC)`,
`gettimeofday` — TypeScript reading the PIT tick counter.

### 6g — ELF Loader (TypeScript — src/os/process/elf.ts)

Parses ELF32 headers, loads PT_LOAD segments into new address space pages,
resolves shared library dependencies. Entry point returned to the execve caller.

---

## Phase 7 — Real Networking

**Goal:** Working TCP/IP sockets visible to userspace. Chromium's network stack
and certificate verification rely on raw sockets.

### 7a — Ethernet Driver (C — packet primitives only)

- **virtio-net** — for QEMU (PCI device 0x1000). Simpler.
- **Intel E1000** — for real hardware.

```c
kernel.netSendFrame(frameBytes: number[]): void
kernel.netRecvFrame(): number[] | null    // null = queue empty
kernel.netMacAddress(): number[]          // 6-byte MAC
```

### 7b — TCP/IP Stack (upgrade existing net.ts)

`src/os/net/net.ts` already has a complete TCP/IP implementation in TypeScript
(Ethernet → ARP → IPv4 → ICMP → UDP → TCP) running in loopback-only mode.
Phase 7b wires it to `kernel.netSendFrame` / `kernel.netRecvFrame`.
No protocol logic moves to C.

### 7c — Berkeley Sockets API (src/os/net/sockets.ts)

```typescript
socket(domain, type, protocol): number
bind(fd, addr, port): void
connect(fd, addr, port): void
listen(fd, backlog): void
accept(fd): number
send(fd, data): number
recv(fd, len): number[]
setsockopt / getsockopt
```

All socket fds integrate with Phase 6b's FDTable so `select`/`epoll` work.

### 7d — DHCP + DNS

DHCP client (UDP broadcast 67/68) and DNS resolver (UDP) in TypeScript.
Both registered as init system services.

### 7e — TLS (lib/mbedtls/)

mbedTLS compiled as a static library under `lib/mbedtls/`. Treated as an opaque
external dependency. JSOS provides I/O callbacks and entropy (`/dev/urandom`).

---

## Phase 8 — Graphics Stack

**Goal:** A rendering backend Chromium can drive.

### 8a — SwiftShader (lib/swiftshader/)

Google's SwiftShader is a CPU-based Vulkan/OpenGL ES renderer. No GPU required.
Lives in `lib/swiftshader/` — compiled as a static archive, not part of JSOS.

JSOS provides SwiftShader's platform abstraction:
- Memory allocation → Phase 4 vmm
- Thread creation → Phase 5 ThreadManager
- Pixel output → Phase 3 Canvas framebuffer

### 8b — DRM/KMS shim

Chromium's `ozone` display layer expects `/dev/dri/card0` and DRM/KMS ioctls.
We implement this as a VFSMount in TypeScript that adapts `Canvas.flip()` into
the ioctl protocol Chromium expects.

---

## Phase 9 — Chromium Port

**Goal:** Chromium compiles against JSOS and boots to a browser window.

### 9a — Build System Integration

```
chromium/build/config/jsos/
  BUILD.gn          — toolchain definition (i686-elf-gcc)
  platform.gni      — JSOS-specific feature flags
```

Key build flags:
```
target_os = "jsos"
is_component_build = false      # static binary, no .so files
use_ozone = true
ozone_platform = "jsos"
use_swiftshader = true
use_alsa = false
use_dbus = false
use_system_libdrm = false
```

### 9b — Ozone Platform Backend

Chromium's Ozone abstraction is the display/input layer. `OzonePlatformJSOS`:
- `GetSurfaceFactoryOzone()` → our framebuffer blit
- `GetPlatformEventSource()` → our keyboard/mouse event stream
- Window management → our Phase 3 WM

### 9c — base/ POSIX Compatibility

Audit every `base/files/`, `base/process/`, `base/threading/` call against Phase 6.
Each gap is patched in our POSIX layer — never by modifying Chromium source.

### 9d — Sandbox Disabled Initially

Chromium's Linux sandbox uses `seccomp-bpf` and namespaces — not on JSOS.
Initial boot uses `--no-sandbox`. JSOS address-space sandbox is post-1.0.

### 9e — Static Link

One binary: Chromium + POSIX layer + SwiftShader + mbedTLS + TCP/IP stack.
~200 MB stripped. Loaded by the ELF loader from FAT16 disk.

---

## Phase 10 — Post-Chromium Hardening

- **Multi-core (SMP):** APIC enumeration, per-core schedulers, spinlocks
- **JSOS Sandbox:** Address-space isolation using Phase 4/5 primitives
- **Package Manager:** `pkg.install('my-app')` from disk or network
- **Window Manager v2:** Multiple desktops, snapping, compositor effects
- **Audio:** AC97/HDA DMA ring buffer (C primitive), mixer in TypeScript
- **USB:** xHCI/EHCI stack
- **ACPI:** Power management via ACPICA lib under `lib/`
- **64-bit (x86_64):** Port C kernel to long mode; TypeScript layer unchanged

---

## File Structure

```
src/
  kernel/              C — hardware primitives only
    boot.s             multiboot entry, GDT setup
    ata.c / ata.h      ATA PIO primitives
    platform.c         VGA text + serial + framebuffer blits
    keyboard.c         PS/2 keyboard + mouse IRQ decode
    irq.c              interrupt entry, context save, calls TS hook
    timer.c            PIT programming, tick counter
    memory.c           physical memory detection (multiboot → JS)
    quickjs_binding.c  ALL kernel.* JS bindings — the only JS/C bridge
    Makefile
    linker.ld

  os/                  TypeScript — the actual operating system
    core/
      kernel.ts        TypeScript interface for all kernel.* bindings
      main.ts          boot sequence, global API setup
      syscalls.ts      POSIX syscall interface
      fdtable.ts       [Phase 6] unified file descriptor table
    process/
      scheduler.ts     scheduling algorithms
      vmm.ts           virtual memory manager
      init.ts          runlevel init + service management
      threads.ts       [Phase 5] thread lifecycle
      elf.ts           [Phase 6] ELF binary loader
      signals.ts       [Phase 6] signal delivery
    fs/
      filesystem.ts    in-memory VFS + mountpoint dispatch
      proc.ts          /proc virtual filesystem
      dev.ts           [Phase 6] /dev virtual filesystem
    storage/
      block.ts         block device abstraction + LRU cache
      fat16.ts         FAT16 read/write driver
    net/
      net.ts           full TCP/IP stack (loopback until Phase 7)
      sockets.ts       [Phase 7] POSIX socket API
    ui/
      terminal.ts      terminal emulator
      repl.ts          JavaScript REPL (always preserved)
      editor.ts        full-screen text editor
      canvas.ts        [Phase 3] pixel Canvas over framebuffer
      wm.ts            [Phase 3] window manager
    users/
      users.ts         user/group management
    ipc/
      ipc.ts           pipes, signals, message queues
    security/          [Phase 6+] sandbox, capabilities

lib/                   Third-party libraries (NOT part of JSOS)
  netsurf/             HTML/CSS rendering (Phase 3f)
  mbedtls/             TLS (Phase 7e)
  swiftshader/         Software OpenGL/Vulkan (Phase 8a)
```

---

## Implementation Rules

1. **C is for hardware, TypeScript is for logic.** When in doubt: TypeScript.
2. **New C primitives require a `kernel.ts` declaration** before anything ships.
3. **Third-party libraries go in `lib/`** and are never imported directly by `src/os/`.
   A TypeScript adapter in `src/os/` bridges them.
4. **Each phase builds and boots cleanly on its own.** No phase may break the REPL.
5. **The REPL is always preserved.** Terminal is the OS escape hatch — always reachable.
6. **Serial log is the test oracle.** Headless QEMU tests pass when serial contains
   the expected boot sequence. No phase ships without a passing headless test.
7. **`disk.*` API is stable from Phase 2 onward.** User scripts must keep working.

---

## Capability Checklist Toward Chromium

| Capability | Phase | Done |
|---|---|---|
| Boots to REPL | 1 | ✅ |
| Persistent FAT16 disk | 2 | ✅ |
| Pixel framebuffer (VESA) | 3a | ☐ |
| Canvas + bitmap font renderer | 3b | ☐ |
| Mouse input (PS/2) | 3c | ☐ |
| Window manager | 3d | ☐ |
| Windowed terminal app | 3e | ☐ |
| NetSurf HTML browser | 3f | ☐ |
| 64MB+ addressable heap | 3g | ☐ |
| Real physical page allocator | 4a | ☐ |
| Paging / mmap / mprotect | 4b–4c | ☐ |
| Kernel/user address split | 4d | ☐ |
| Preemptive scheduling | 5a | ☐ |
| Kernel threads (pthreads) | 5b | ☐ |
| Mutexes / condvars / semaphores | 5d | ☐ |
| fork / exec / waitpid | 6a | ☐ |
| File descriptors + select/epoll | 6b | ☐ |
| Pipes + socketpair | 6c | ☐ |
| Signals (SIGCHLD, SIGSEGV, …) | 6d | ☐ |
| /proc/self/maps, /dev/urandom | 6e | ☐ |
| ELF loader | 6g | ☐ |
| Real Ethernet driver (virtio-net) | 7a | ☐ |
| TCP/IP wired to hardware | 7b | ☐ |
| POSIX sockets + epoll | 7c | ☐ |
| TLS (mbedTLS) | 7e | ☐ |
| SwiftShader software GL | 8a | ☐ |
| DRM/KMS shim (/dev/dri/card0) | 8b | ☐ |
| Chromium GN build target | 9a | ☐ |
| Chromium Ozone JSOS backend | 9b | ☐ |
| **Chromium boots to browser window** | **9e** | **☐** |

## Core Architecture

```
┌─────────────────────────────────────────────────┐
│                TypeScript OS Layer               │
│  ┌─────────────────────────────────────────┐     │
│  │         System Services                 │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐     │     │
│  │  │  Init   │ │ Logging │ │ Config  │     │     │
│  │  └─────────┘ └─────────┘ └─────────┘     │     │
│  └─────────────────────────────────────────┘     │
│  ┌─────────────────────────────────────────┐     │
│  │         Core OS Components              │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐     │     │
│  │  │ Process │ │ Virtual │ │ Device  │     │     │
│  │  │Scheduler│ │ Memory  │ │ Manager │     │     │
│  │  └─────────┘ └─────────┘ └─────────┘     │     │
│  └─────────────────────────────────────────┘     │
│  ┌─────────────────────────────────────────┐     │
│  │         System Call Interface           │     │
│  └─────────────────────────────────────────┘     │
├─────────────────────────────────────────────────┤
│            QuickJS Engine (ES2023, C)            │
├─────────────────────────────────────────────────┤
│               C Kernel (i686-elf)                │
└─────────────────────────────────────────────────┘
```

## Implemented Components ✅

### 1. System Call Interface (`syscalls.ts`)
- **Complete POSIX-style syscall interface**
- **Error handling with errno codes**
- **Type-safe syscall definitions**
- **Process, memory, file, and system operations**

### 2. Process Scheduler (`scheduler.ts`)
- **Multiple scheduling algorithms**: Round-robin, priority, real-time
- **Process states**: ready, running, blocked, terminated, waiting
- **Context switching and time slicing**
- **Process creation, termination, and management**

### 3. Virtual Memory Manager (`vmm.ts`)
- **Page table management**
- **Virtual-to-physical address translation**
- **Memory protection and permissions**
- **Memory-mapped I/O support**
- **Dynamic memory allocation**

### 4. Init System (`init.ts`)
- **System initialization and shutdown**
- **Service management with dependencies**
- **Runlevel system (0-6)**
- **Service restart policies**
- **Systemd-like service architecture**

## Components Ready for Implementation 🚧

### 5. Device Management Framework
```typescript
// Planned: src/os/device_manager.ts
interface DeviceDriver {
  name: string;
  type: 'block' | 'character' | 'network';
  probe(): boolean;
  init(): Promise<void>;
  shutdown(): Promise<void>;
}
```

### 6. Persistent Storage Layer
```typescript
// Planned: src/os/storage.ts
interface BlockDevice {
  read(block: number, count: number): Promise<Uint8Array>;
  write(block: number, data: Uint8Array): Promise<void>;
  getBlockSize(): number;
  getTotalBlocks(): number;
}
```

### 7. Advanced File System
```typescript
// Planned: src/os/fs_advanced.ts
interface FilePermissions {
  owner: { read: boolean; write: boolean; execute: boolean };
  group: { read: boolean; write: boolean; execute: boolean };
  other: { read: boolean; write: boolean; execute: boolean };
}
```

### 8. Inter-Process Communication
```typescript
// Planned: src/os/ipc.ts
interface Pipe {
  read(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
}
```

### 9. Security & User Management
```typescript
// Planned: src/os/security/users.ts
interface User {
  uid: number;
  gid: number;
  username: string;
  homeDirectory: string;
  shell: string;
}
```

### 10. Networking Stack
```typescript
// Planned: src/os/net/tcp.ts
interface TCPSocket {
  connect(host: string, port: number): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): void;
}
```

## Integration Points

### Updating Main Entry Point
The `main.ts` needs to be updated to initialize the new OS components:

```typescript
// src/os/main.ts
import { init } from './init.js';
import { scheduler } from './scheduler.js';
import { vmm } from './vmm.js';

// Initialize core OS components
async function initializeOS() {
  console.log('Initializing JSOS Operating System...');

  // Start virtual memory manager
  // Start process scheduler
  // Initialize system calls

  // Start init system
  await init.initialize();

  // Start the REPL
  startRepl();
}
```

### Enhanced Global API
Extend the global `sys` object with new OS features:

```typescript
// Add to global system object
declare global {
  var sys: {
    // Existing functions...
    scheduler: typeof scheduler;
    vmm: typeof vmm;
    init: typeof init;
    // New OS APIs...
  };
}
```

## Testing Strategy

### Unit Tests
```typescript
// test/syscalls.test.ts
describe('System Calls', () => {
  test('fork creates new process', () => {
    const result = syscalls.fork();
    expect(result.success).toBe(true);
  });
});
```

### Integration Tests
```typescript
// test/os-integration.test.ts
describe('OS Integration', () => {
  test('full system boot', async () => {
    await init.initialize();
    expect(init.getCurrentRunlevel()).toBe(3);
  });
});
```

## Performance Considerations

1. **Memory Management**: Implement garbage collection coordination
2. **Process Scheduling**: Optimize context switching overhead
3. **File I/O**: Implement buffering and caching
4. **Network**: Optimize packet processing

## Security Features

1. **Memory Protection**: Prevent buffer overflows
2. **Process Isolation**: Separate address spaces
3. **File Permissions**: Access control
4. **Network Security**: Firewall and encryption

## Future Enhancements

### Phase 2: Storage & I/O (2 weeks)
- Disk driver implementation
- File system with permissions
- Device hot-plugging

### Phase 3: Communication & Security (2 weeks)
- IPC mechanisms
- User authentication
- Access control

### Phase 4: Networking (3 weeks)
- TCP/IP stack
- Socket API
- HTTP services

### Phase 5: System Services (2 weeks)
- Logging system
- Configuration management
- Package management

### Phase 6: Applications & GUI (3 weeks)
- Window system
- GUI applications
- Performance optimization

## Development Workflow

1. **Implement core components** in TypeScript
2. **Add unit tests** for each component
3. **Integrate with existing kernel** bindings
4. **Test in QEMU** environment
5. **Performance profiling** and optimization

## Conclusion

JSOS now has the foundation of a **complete operating system** with:
- ✅ Modern process management
- ✅ Virtual memory system
- ✅ System call interface
- ✅ Service management
- ✅ Proper initialization

The remaining components follow the same pattern: implement in TypeScript, integrate with the kernel, and expose through the global API. This creates a **true operating system** where everything from the scheduler to the network stack is written in TypeScript, running on bare metal via QuickJS.</content>
<parameter name="filePath">c:\DEV\JSOS\OS_IMPLEMENTATION.md