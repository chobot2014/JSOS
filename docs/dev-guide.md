# JSOS Developer Guide
**Item 889**

## Code Organization

```
src/
  kernel/       C code: hardware I/O only (I/O ports, interrupts, DMA)
  os/
    core/       Init system, kernel bindings, sys call table
    process/    Scheduler, virtual memory, signals, IPC
    fs/         VFS, ext2, ext4, zfs, tmpfs, procfs, devfs
    net/        TCP, UDP, TLS, DNS, HTTP, WebSocket
    audio/      Drivers, codecs, mixer, sys.audio API
    storage/    RAID, LVM, NVMe, partition management
    ui/         Terminal, REPL, window manager, GUI
    users/      Accounts, auth, PAM-like
    apps/       Browser, installer, npm-registry, built-in apps
    ipc/        Pipes, shared memory, semaphores, message queues
    test/       Unit + integration test suite
build/
  js/           Compiled TypeScript (mirrors src/os/)
  bundle.js     Rollup bundle (entire OS in one file)
docs/           Architecture, API refs, guides
scripts/        Build, test, ISO creation scripts
```

## Build System

TypeScript sources in `src/os/` are compiled to `build/js/` by `tsc`.
`scripts/bundle.js` uses Rollup to pack everything into `build/bundle.js`.
The kernel Makefile embeds `build/bundle.js` into `kernel.bin` via `embed-js.js`.

```bash
npm run build          # compile TypeScript
npm run bundle         # create bundle.js
make -C src/kernel     # build kernel (Linux host or Docker)
bash scripts/build.sh  # full build (TypeScript + kernel + ISO)
```

## Adding a System Call

1. **C side** (`src/kernel/syscalls.c`): register a new syscall number and handler
2. **TypeScript binding** (`src/os/core/syscalls.ts`): add typed wrapper
3. **sys.* namespace** (`src/os/core/sys.ts`): expose via `sys.<subsystem>`
4. **Document** in `docs/sys-api-reference.md`

## Debugging

### Serial Console (COM1)
All `console.log` output goes to COM1 at 115200 baud.
In QEMU: `qemu-system-i386 ... -serial stdio`

### QEMU Monitor
Press `Ctrl-A C` in QEMU to enter the monitor.
`info registers`, `x /20x 0x1000` etc.

### GDB
```bash
qemu-system-i386 ... -s -S   # waits for GDB connection on :1234
gdb build/kernel.elf -ex "target remote :1234"
```

### QuickJS Debugger
Set `kernel.debugMode = true` at runtime in the REPL to enable QuickJS bytecode dumps.

## Performance Profiling

- `sys.debug.profile(fn, iterations)` — runs fn N times and returns min/max/avg in µs
- `sys.debug.heapSnapshot()` — returns QuickJS heap statistics
- `sys.debug.interrupts()` — IRQ count table since boot

## Coding Standards

### TypeScript
```ts
// Public API functions require JSDoc
/**
 * Reads up to `length` bytes from `path` into a new Uint8Array.
 * Throws if the file does not exist or cannot be read.
 */
export function readFile(path: string, length?: number): Uint8Array { ... }
```

### Error Handling
```ts
// Use typed error objects everywhere
throw new KernelError(ErrCode.ENOENT, `readFile: ${path} not found`);
```

### Async vs Sync
- Kernel code is single-threaded; use synchronous implementations
- `async/await` is fine for user-space applications via sys.net sockets
- Never `await` inside an interrupt handler

## Kernel vs User Boundary

```
  User Application (TypeScript)
       |  sys.* API calls
       v
  sys.* wrappers  (src/os/core/sys.ts)
       |  raw syscall numbers
       v
  C syscall table  (src/kernel/syscalls.c)
       |  QuickJS JSValue callbacks
       v
  Hardware I/O functions  (src/kernel/*.c)
```

No user code can skip the sys.* layer and call C functions directly.
