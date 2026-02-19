# Phase 6 — POSIX Layer

## Goal

Implement enough of the POSIX standard that compiled C/C++ programs — and in
particular Chromium's `base/` library — can link against JSOS system headers
and run. This is the largest single phase and is the gateway to Phase 9.

---

## Prerequisites

- Phase 4 complete (real paging, mmap/mprotect)
- Phase 5 complete (threads, sync primitives)
- Phase 2 complete (FAT16 for persistent ELF storage)

---

## 6a — Process Model: fork / exec / waitpid

### fork

`fork()` creates a child process with a copy of the parent's address space.
In Phase 4 terms, this means cloning the page directory (copy-on-write ideally,
or a full eager copy to start).

```c
// New C primitive — clones the page directory:
kernel.cloneAddressSpace(): number
// Allocates a new page directory, copies all present PTEs,
// returns the new CR3 value.
// TypeScript manages what happens after the clone.
```

TypeScript `fork()` implementation:

```typescript
function fork(): number {    // returns 0 in child, child PID in parent
  const childCR3 = kernel.cloneAddressSpace()
  const child = new Process({
    ppid: currentProcess.pid,
    addressSpace: new AddressSpace(childCR3),
    fdTable: currentProcess.fdTable.clone(),
    signalHandlers: { ...currentProcess.signalHandlers },
    threads: [ currentThread.clone() ]
  })
  processManager.register(child)
  return isParent ? child.pid : 0
}
```

### exec

`execve(path, argv, envp)` loads an ELF binary (Phase 6g) into the current
process's address space (replacing it), sets up a new stack with argv/envp,
and jumps to the ELF entry point.

```typescript
function execve(path: string, argv: string[], envp: string[]): never {
  const elf = loadELF(vfs.readFile(path)!)    // Phase 6g
  currentProcess.addressSpace.reset()          // unmap everything
  elf.loadSegments(currentProcess.addressSpace)
  const stack = setupStack(argv, envp)
  kernel.jumpToUserMode(elf.entry, stack)      // C primitive below
}
```

```c
// C primitive — switch to ring 3 at given address:
kernel.jumpToUserMode(eip: number, esp: number): void
// Sets up iret frame: EIP, CS=user_cs, EFLAGS, ESP, SS=user_ss
// Never returns.
```

### waitpid

```typescript
function waitpid(pid: number, options: number): { pid: number, status: number } {
  // Block until target child (or any child if pid=-1) changes state
  // Pure TypeScript — uses processManager and signalManager
}
```

---

## 6b — File Descriptor Table (src/os/core/fdtable.ts)

Unified fd table in TypeScript over all I/O backends. Every process has its
own `FDTable` (cloned on fork).

```typescript
interface FileDescription {
  // Abstract file — every open fd points to one of these
  read(count: number): Uint8Array
  write(data: Uint8Array): number
  seek(offset: number, whence: number): number
  ioctl(request: number, arg?: number): number
  stat(): FileStat
  poll(): { readable: boolean; writable: boolean; error: boolean }
  close(): void
}

class FDTable {
  // Backend implementations:
  // VFSFileDescription    → in-memory + FAT16 files
  // PipeDescription       → ring buffer pipe
  // SocketDescription     → TCP/UDP socket (Phase 7)
  // ProcDescription       → /proc/self/...
  // DevDescription        → /dev/null, /dev/zero, /dev/urandom, /dev/fb0

  open(path: string, flags: number, mode?: number): number    // returns fd
  close(fd: number): void
  read(fd: number, count: number): Uint8Array
  write(fd: number, data: Uint8Array): number
  seek(fd: number, offset: number, whence: number): number
  dup(fd: number): number
  dup2(oldfd: number, newfd: number): number
  fcntl(fd: number, cmd: number, arg?: number): number
  ioctl(fd: number, request: number, arg?: number): number
  fstat(fd: number): FileStat
  stat(path: string): FileStat

  // I/O multiplexing
  select(read: number[], write: number[], except: number[],
         timeout: number): { read: number[]; write: number[]; except: number[] }
  epoll_create(): number
  epoll_ctl(epfd: number, op: number, fd: number, event: EpollEvent): void
  epoll_wait(epfd: number, maxEvents: number, timeout: number): EpollEvent[]

  // Fork support
  clone(): FDTable
}
```

### Standard File Descriptors

On process creation:
- fd 0 = stdin (terminal read)
- fd 1 = stdout (terminal write)
- fd 2 = stderr (terminal write, red highlight)

---

## 6c — Pipes and socketpair

```typescript
function pipe(): [number, number] {  // [readFd, writeFd]
  const buf = new RingBuffer(65536)
  const readDesc  = new PipeReadDescription(buf)
  const writeDesc = new PipeWriteDescription(buf)
  return [fdTable.insert(readDesc), fdTable.insert(writeDesc)]
}

function socketpair(): [number, number] {  // bidirectional pair
  // Used by Chromium for renderer↔browser IPC
  const [a, b] = [new RingBuffer(65536), new RingBuffer(65536)]
  return [fdTable.insert(new BiPipeDescription(a, b)),
          fdTable.insert(new BiPipeDescription(b, a))]
}
```

---

## 6d — Signals (src/os/process/signals.ts)

```typescript
const SIG = {
  SIGHUP:  1,  SIGINT:  2,  SIGQUIT: 3,  SIGILL: 4,
  SIGTRAP: 5,  SIGABRT: 6,  SIGFPE:  8,  SIGKILL: 9,
  SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGUSR1: 10, SIGUSR2: 12,
}

class SignalManager {
  // send signal to process
  send(pid: number, sig: number): void

  // per-process signal handler registration
  handle(pid: number, sig: number,
         handler: 'default' | 'ignore' | Function): void

  // signal mask (per-thread)
  mask(tids: number, sigs: number[]): void
  unmask(tids: number, sigs: number[]): void

  // Deliver pending signals to a process before it returns to user mode
  deliverPending(pid: number): void
}
```

### Page Fault → SIGSEGV

```c
// Page fault handler in irq.c:
extern void js_page_fault(uint32_t fault_addr, uint32_t error_code);
// TypeScript decides: map new page (demand paging) or deliver SIGSEGV.
```

```typescript
function handlePageFault(addr: number, errorCode: number): void {
  const vma = findVMA(currentProcess, addr)
  if (vma && vma.prot & PROT_READ) {
    // Demand-page: allocate physical frame, map, return
    physAlloc.alloc(1)
    // ...
  } else {
    signalManager.send(currentProcess.pid, SIG.SIGSEGV)
  }
}
```

---

## 6e — /proc and /dev Virtual Files

All implemented as `FileDescription` subclasses in TypeScript, registered as
VFS mounts.

### /proc entries

| Path | Description |
|---|---|
| `/proc/self` | symlink to `/proc/[pid]` |
| `/proc/self/maps` | virtual memory areas (Chromium sandbox reads this) |
| `/proc/self/status` | process status (Name, Pid, VmRSS, …) |
| `/proc/self/cmdline` | null-separated argv |
| `/proc/self/fd/` | directory of open fds (symlinks) |
| `/proc/[pid]/...` | same for any pid |
| `/proc/cpuinfo` | `processor: 0`, `model name: JSOS x86` |
| `/proc/meminfo` | MemTotal, MemFree, Cached |

### /dev entries

| Path | Description |
|---|---|
| `/dev/null` | discards all writes, reads return EOF |
| `/dev/zero` | reads return infinite zero bytes |
| `/dev/urandom` | reads return pseudo-random bytes (xorshift128+) |
| `/dev/fb0` | framebuffer — ioctl for FBIOGET_VSCREENINFO, mmap for pixels |
| `/dev/input/mouse0` | mouse event stream (Phase 3 PS/2 data) |
| `/dev/tty` | current process's controlling terminal |
| `/dev/stdin`, `/dev/stdout`, `/dev/stderr` | fd 0/1/2 aliases |

---

## 6f — POSIX Time

```typescript
// Based on PIT tick counter from kernel.getTicks() + real-time offset set at boot

function clock_gettime(clockId: number): { sec: number; nsec: number } {
  const ticks = kernel.getTicks()
  if (clockId === CLOCK_MONOTONIC) {
    const ns = ticks * 10_000_000   // 100Hz → 10ms per tick
    return { sec: Math.floor(ns / 1e9), nsec: ns % 1e9 }
  }
  if (clockId === CLOCK_REALTIME) {
    // Add epoch offset (user can set via RTC read or NTP — Phase 7)
    return { sec: realTimeEpoch + Math.floor(ticks / 100), nsec: ... }
  }
}

function gettimeofday(): { sec: number; usec: number }
function nanosleep(req: { sec: number; nsec: number }): void
  // Calls threadManager.sleepThread for duration
```

---

## 6g — ELF Loader (src/os/process/elf.ts)

Loads ELF32 executables and shared objects from the VFS into a new address space.

```typescript
interface ELFInfo {
  entry: number               // virtual entry point
  segments: ELFSegment[]
  interpreter?: string        // /lib/ld-jsos.so if dynamic
  soname?: string
  needed: string[]            // required shared libraries
}

interface ELFSegment {
  type: number               // PT_LOAD = 1
  vaddr: number
  filesz: number
  memsz: number
  flags: number              // PF_R|PF_W|PF_X
  data: Uint8Array
}

class ELFLoader {
  parse(data: Uint8Array): ELFInfo

  load(info: ELFInfo, space: AddressSpace): void {
    // For each PT_LOAD segment:
    //   1. Allocate physical frames (memsz rounded up to pages)
    //   2. Map at vaddr with flags from segment
    //   3. Copy filesz bytes of data, zero-fill remaining (memsz - filesz)
  }

  // Static executables only in Phase 6.
  // Dynamic linking (.so) deferred to Phase 9 (Chromium is fully static).
}
```

---

## POSIX syscall table (src/os/core/syscalls.ts additions)

| Syscall | Implementation |
|---|---|
| `fork` | 6a + kernel.cloneAddressSpace |
| `execve` | 6a + ELFLoader + kernel.jumpToUserMode |
| `waitpid` | 6a |
| `exit`, `exit_group` | ProcessManager |
| `getpid`, `getppid`, `gettid` | ProcessManager |
| `open`, `close`, `read`, `write` | FDTable |
| `lseek`, `pread`, `pwrite` | FDTable |
| `dup`, `dup2` | FDTable |
| `pipe`, `pipe2` | 6c |
| `fcntl`, `ioctl` | FDTable |
| `stat`, `fstat`, `lstat` | VFS |
| `mkdir`, `rmdir`, `unlink`, `rename` | VFS |
| `getcwd`, `chdir` | ProcessManager |
| `mmap`, `munmap`, `mprotect`, `brk` | VMM (Phase 4) |
| `clone` (thread create) | ThreadManager (Phase 5) |
| `futex` | over Phase 5 Mutex |
| `kill`, `sigaction`, `sigprocmask` | SignalManager |
| `clock_gettime`, `gettimeofday`, `nanosleep` | 6f |
| `select`, `epoll_*` | FDTable |
| `socket`, `connect`, `bind`, etc. | Phase 7 |

---

## New C Primitives Added in Phase 6

| Binding | Description |
|---|---|
| `kernel.cloneAddressSpace()` | Clone current page directory |
| `kernel.jumpToUserMode(eip, esp)` | iret to ring 3 |
| `kernel.getPageFaultAddr()` | Read CR2 (called by page fault handler) |

---

## New TypeScript Files

| File | Description |
|---|---|
| `src/os/core/fdtable.ts` | Unified file descriptor table |
| `src/os/process/signals.ts` | Signal delivery and masking |
| `src/os/process/elf.ts` | ELF32 loader |
| `src/os/fs/dev.ts` | /dev virtual filesystem |
| `src/os/process/process.ts` | Process class (upgrades scheduler.ts Process) |

---

## Test Oracle

```
[SERIAL] POSIX layer initialised
[SERIAL] fork/exec test: child PID 2 ran and exited with code 0
[SERIAL] pipe roundtrip test: PASS
[SERIAL] /proc/self/maps: 4 regions
[SERIAL] ELF loader: hello_world executed, printed "Hello, World!"
[SERIAL] REPL ready
```

---

## What Phase 6 Does NOT Do

- ❌ No dynamic linking (.so files) — Chromium is static; .so deferred post-Phase 9
- ❌ No POSIX threads via `pthread` header directly — Phase 7 libc wraps
- ❌ No `ptrace` or `/proc/[pid]/mem` write (needed for debuggers, not Chromium)
- ❌ No namespace/cgroups (Chromium sandbox is disabled, Phase 10)
- ❌ No `sendfile`, `splice`, `io_uring`
