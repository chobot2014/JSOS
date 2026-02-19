# Phase 1 — Core Infrastructure ✅ COMPLETE

## Goal

Bootstrap a bare-metal i686 machine into a working TypeScript runtime with a
full-screen REPL, in-memory filesystem, simulated process/memory management, a
complete TCP/IP stack, IPC, and user management — all in TypeScript running on
QuickJS.

---

## Status: COMPLETE

All components listed below are built, tested, and passing the headless QEMU
serial-log test.

---

## C Primitives Provided (src/kernel/)

These are the ONLY C functions the OS layer depends on. All are exposed via the
`kernel.*` binding namespace in `quickjs_binding.c`.

| Binding | C Source | Description |
|---|---|---|
| `kernel.print(str)` | `platform.c` | Write string to VGA text buffer |
| `kernel.serialPrint(str)` | `platform.c` | Write string to COM1 serial port |
| `kernel.readKey()` | `keyboard.c` | Drain next scancode from keyboard queue |
| `kernel.getTicks()` | `timer.c` | Read PIT tick counter (100 Hz) |
| `kernel.readPort(port)` | `platform.c` | Read byte from x86 I/O port |
| `kernel.writePort(port, val)` | `platform.c` | Write byte to x86 I/O port |
| `kernel.memRead(addr)` | `platform.c` | Read 32-bit value from physical address |
| `kernel.memWrite(addr, val)` | `platform.c` | Write 32-bit value to physical address |

### Boot Sequence (C)

1. `boot.s` — multiboot1 header, sets up stack, calls `kmain`
2. `kernel.c` — initialises GDT, IDT, PIC, remaps IRQs, enables interrupts
3. `quickjs_binding.c` — creates QuickJS runtime (8 MB heap, 6 MB limit),
   registers all `kernel.*` bindings, loads bundled JavaScript from
   `embedded_js.h`, calls `main()` in TypeScript

---

## TypeScript OS Layer (src/os/)

### Core (src/os/core/)

#### kernel.ts
TypeScript declarations for every `kernel.*` C binding. Single source of truth
for the C/TS interface. No logic — only type-safe wrappers.

```typescript
declare namespace kernel {
  function print(s: string): void
  function serialPrint(s: string): void
  function readKey(): number | null          // scancode or null
  function getTicks(): number                // PIT tick count
  function readPort(port: number): number
  function writePort(port: number, val: number): void
  function memRead(addr: number): number
  function memWrite(addr: number, val: number): void
}
```

#### main.ts
Entry point called by the QuickJS runtime after binding registration.
- Initialises all OS subsystems in dependency order
- Registers global `sys`, `fs`, `disk`, `net`, `proc` APIs on the JS global
- Starts the init system
- Launches the REPL

#### syscalls.ts
POSIX-style syscall interface. TypeScript enum of error codes (EPERM, ENOENT,
EACCES, …). All OS APIs return `{success: boolean, value?, errno?}`.

---

### Process Management (src/os/process/)

#### scheduler.ts
Pure TypeScript process scheduler. No real context switching — cooperative
yielding only (Phase 5 adds preemption).

```typescript
type ProcessState = 'ready' | 'running' | 'blocked' | 'terminated' | 'waiting'

class Process {
  pid: number
  ppid: number
  name: string
  state: ProcessState
  priority: number           // 0 (highest) – 19 (lowest)
  createdAt: number          // ticks
  cpuTime: number
  memoryUsage: number
}

class ProcessScheduler {
  create(name: string, fn: Function, priority?: number): Process
  terminate(pid: number): void
  block(pid: number): void
  unblock(pid: number): void
  yield(): void              // cooperative yield
  tick(): void               // called by timer IRQ handler
  getAll(): Process[]
  getByPid(pid: number): Process | null
}
```

Scheduling algorithms available: round-robin (default), priority, FIFO.
All algorithms are pure TypeScript — the scheduler is fully unit-testable
without any hardware.

#### vmm.ts
Virtual memory manager. **Simulated** in Phase 1 — tracks allocations in a
TypeScript map. Phase 4 replaces with real page table management.

```typescript
class VirtualMemoryManager {
  allocate(size: number, flags?: MemFlags): number   // returns virtual address
  free(addr: number): void
  protect(addr: number, size: number, prot: Protection): void
  translate(virtualAddr: number): number             // → physical (simulated)
  getUsage(): { used: number; available: number }
}
```

#### init.ts
Systemd-inspired init system. Manages service dependencies, runlevels,
restart policies.

```typescript
type RunLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6   // 0=halt, 6=reboot, 3=multiuser

interface ServiceDefinition {
  name: string
  description: string
  dependencies: string[]
  start(): Promise<void>
  stop(): Promise<void>
  restart: 'always' | 'on-failure' | 'never'
}

class InitSystem {
  register(svc: ServiceDefinition): void
  start(name: string): Promise<void>
  stop(name: string): Promise<void>
  setRunlevel(level: RunLevel): Promise<void>
  status(name: string): ServiceStatus
}
```

---

### Filesystem (src/os/fs/)

#### filesystem.ts
In-memory VFS with a mountpoint dispatch layer.

```typescript
interface VFSMount {
  readFile(path: string): Uint8Array | null
  writeFile(path: string, data: Uint8Array): boolean
  readdir(path: string): string[] | null
  stat(path: string): FileStat | null
  mkdir(path: string): boolean
  unlink(path: string): boolean
}

class VirtualFileSystem {
  mount(mountpoint: string, backend: VFSMount): void
  unmount(mountpoint: string): void
  readFile(path: string): Uint8Array | null
  writeFile(path: string, data: Uint8Array): boolean
  readdir(path: string): string[] | null
  // ... all POSIX-like file operations
}
```

Paths beginning with `/mem` map to the in-memory storage.
Paths beginning with `/proc` dispatch to `proc.ts`.

#### proc.ts
`/proc` virtual filesystem. Every file is computed on-read.

| Path | Contents |
|---|---|
| `/proc/version` | JSOS version string |
| `/proc/uptime` | ticks since boot |
| `/proc/meminfo` | VMM usage stats |
| `/proc/[pid]/status` | per-process status |
| `/proc/[pid]/cmdline` | process name |

---

### Networking (src/os/net/)

#### net.ts
Full TCP/IP stack in TypeScript. Protocol implementations in descending order:

```
Ethernet frame parsing → ARP table → IPv4 routing → ICMP echo →
UDP datagrams → TCP state machine (SYN/SYN-ACK/ACK/FIN)
```

**Phase 1 status:** Loopback-only. `kernel.netSendFrame` / `kernel.netRecvFrame`
are stubbed to loop back to the same stack. Phase 7 wires real hardware.

```typescript
class TCPStack {
  // Internal: EthernetFrame → ARP/IP → TCP
  handlePacket(frame: number[]): void

  // Application API
  createSocket(): TCPSocket
  createUDPSocket(): UDPSocket
}

interface TCPSocket {
  connect(addr: string, port: number): Promise<void>
  listen(port: number): void
  accept(): Promise<TCPSocket>
  send(data: Uint8Array): void
  recv(): Promise<Uint8Array>
  close(): void
}
```

---

### IPC (src/os/ipc/)

#### ipc.ts
Four IPC mechanisms, all TypeScript:

```typescript
// Pipes: unidirectional byte streams
class Pipe {
  write(data: Uint8Array): void
  read(maxBytes: number): Uint8Array
  close(): void
}

// Signals: async notifications to processes
class SignalBus {
  send(pid: number, signal: number): void
  handle(signal: number, handler: () => void): void
}

// Message queues: typed messages with priorities
class MessageQueue {
  send(msg: Message): void
  recv(filter?: number): Message
}

// Shared memory regions (simulated in Phase 1)
class SharedMemory {
  create(size: number): number    // returns shmid
  attach(shmid: number): number   // returns virtual address
  detach(addr: number): void
}
```

---

### UI (src/os/ui/)

#### terminal.ts
VGA text mode terminal emulator. 80×25 grid. Supports ANSI escape codes for
colour and cursor movement. Wraps `kernel.print` with a proper state machine.

```typescript
class Terminal {
  print(text: string): void
  println(text: string): void
  clear(): void
  setCursor(x: number, y: number): void
  setColor(fg: Color, bg: Color): void
  getSize(): { cols: number; rows: number }
}
```

#### repl.ts
Full-featured REPL:
- Command history (up/down arrows, persistent in `/mem/repl_history`)
- Tab completion for global APIs (`sys.*`, `fs.*`, `disk.*`, `net.*`)
- Multi-line input (trailing `\` continues)
- Expression evaluation via QuickJS `eval()`
- Pretty-printing of returned values

#### editor.ts
Nano-inspired full-screen text editor.
- Opens any VFS path
- Basic cut/copy/paste
- Ctrl+S save, Ctrl+X exit
- Syntax coloring for `.ts` and `.js` files

---

### Users (src/os/users/)

#### users.ts
Unix-style user/group model.

```typescript
interface User {
  uid: number; gid: number
  username: string
  passwordHash: string      // SHA-256 hex
  homeDir: string
  shell: string
  groups: number[]
}

class UserManager {
  addUser(opts: Partial<User>): User
  authenticate(username: string, password: string): boolean
  getUser(uid: number): User | null
  getByName(username: string): User | null
  setPassword(uid: number, newPassword: string): void
  addGroup(name: string): number          // returns gid
  addUserToGroup(uid: number, gid: number): void
}
```

Root user (uid=0) is created at init. Default user `jsos` (uid=1000).

---

## File List

```
src/kernel/
  boot.s                 multiboot1 entry, stack setup, calls kmain
  crt0.s                 C runtime zero-init
  kernel.c               GDT, IDT, PIC, IRQ init, calls JS
  quickjs_binding.c      ALL kernel.* bindings — the only C/JS bridge
  quickjs_binding.h
  embedded_js.h          bundled JS (generated by build)
  keyboard.c             PS/2 IRQ1 scancode decoder
  keyboard.h
  timer.c                PIT 100 Hz setup and tick counter
  timer.h
  irq.c                  IRQ dispatch table
  irq.h
  irq_asm.s              interrupt stubs
  platform.c             VGA text, serial COM1, port I/O, phys mem R/W
  platform.h
  memory.c               physical memory query helpers
  memory.h
  minimal_libc.c         snprintf, memcpy, memset — no system libc
  minimal_libc.h
  math_impl.c            soft-float for QuickJS
  linker.ld              8 MB static heap, entry at 1 MB
  Makefile

src/os/
  core/
    kernel.ts            C binding declarations
    main.ts              OS entry point
    syscalls.ts          POSIX syscall interface + errno
  process/
    scheduler.ts         process scheduler
    vmm.ts               virtual memory manager (simulated)
    init.ts              init / runlevel system
  fs/
    filesystem.ts        in-memory VFS
    proc.ts              /proc filesystem
  net/
    net.ts               full TCP/IP stack (loopback)
  ipc/
    ipc.ts               pipes, signals, message queues, shared mem
  ui/
    terminal.ts          VGA text terminal emulator
    repl.ts              JavaScript REPL
    editor.ts            full-screen text editor
  users/
    users.ts             user / group management
  tsconfig.json
```

---

## Test Oracle

Headless QEMU test (test-windows.ps1 / test-wsl.sh) confirms:

```
[SERIAL] JSOS booting...
[SERIAL] QuickJS runtime initialized
[SERIAL] OS kernel started
[SERIAL] Init system ready
[SERIAL] REPL ready
```

All five lines must appear in `test-output/serial.log` within the timeout.

---

## What Phase 1 Does NOT Do

- ❌ No real context switching (scheduler is cooperative simulation)
- ❌ No page tables (VMM is a flat map simulation)
- ❌ No real networking (TCP/IP runs over loopback stub)
- ❌ No persistent storage (Phase 2)
- ❌ No pixel graphics or mouse (Phase 3)
