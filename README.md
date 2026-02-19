# JSOS — JavaScript Operating System

**A complete operating system written in TypeScript, running on bare metal x86 hardware.**

**All applications run natively in JavaScript/TypeScript - no other languages needed.**

JSOS compiles TypeScript to JavaScript, embeds it in a custom C kernel powered by [QuickJS](https://bellard.org/quickjs/) (a full ES2023 engine by Fabrice Bellard), and boots from a standard ISO image via GRUB. The result is a real, interactive OS where **everything is JavaScript** — the filesystem, process management, terminal, networking, and **all applications** are written in TypeScript/JavaScript and run natively on bare metal.

![JSOS Demo](2026-02-18%2009-30-26.gif)

![Architecture: TypeScript → ES2023 → QuickJS → C Kernel → x86 Bare Metal](https://img.shields.io/badge/stack-TypeScript→ES2023→QuickJS→C→x86-blue)

---

## Features

### Live JavaScript REPL
- **Direct bare-metal JavaScript execution** — no shell, no commands, everything is JavaScript
- **ES2023 support** — classes, arrow functions, async/await, destructuring, Map, Set, Promise, etc.
- **Global functions** for all OS operations (filesystem, processes, memory, etc.)
- **Multi-line input** — `{`, `(`, `[` enter multi-line mode
- **Command history** — Up/Down arrows to browse
- **Auto-pretty printing** — results display beautifully formatted

### JavaScript Filesystem API
- **Unix-like hierarchy** — `/bin`, `/etc`, `/home`, `/tmp`, `/var`, `/proc`, `/dev`
- **Full path operations** — `ls()`, `cd()`, `cat()`, `mkdir()`, `rm()`, `cp()`, `mv()`, `write()`, `append()`
- **Pattern matching** — `find()` with `*` wildcards
- **File execution** — `run()` evaluates `.js` files
- **Pre-loaded examples** in `/bin/` (hello.js, sysinfo.js, colors.js)

### Process Management
- **Process listing** — `ps()` shows all running processes
- **Process creation** — `sys.spawn()` creates new processes
- **Process termination** — `kill(pid)` terminates processes
- **System monitoring** — memory usage, uptime, process count

### Terminal & Display
- **VGA text-mode terminal** — 80×25 with hardware cursor and 16 colors
- **Color functions** — `colors()` shows palette, `terminal.setColor()` for custom colors
- **Screen operations** — `clear()`, cursor positioning, scrolling
- **Text editor** — `edit()` launches fullscreen editor (^S save, ^Q quit)

### Kernel Features
- **PS/2 keyboard driver** — full US layout, special keys, interrupts
- **Programmable Interval Timer** — 100Hz ticks, uptime tracking, `sleep()`
- **Memory management** — 1MB pool with allocation tracking
- **IDT/PIC interrupt system** — proper IRQ handling with GDT and PIC remapping
- **QuickJS ES2023 engine** — full JavaScript runtime on bare metal
- **Platform abstraction** — clean separation of hardware operations

### Kernel API (accessible from TypeScript)
```typescript
// VGA Display (raw hardware access)
kernel.vgaPut(row, col, ch, colorByte)     // Write char at position
kernel.vgaGet(row, col)                    // Read VGA cell
kernel.vgaDrawRow(row, text, colorByte)    // Write full row
kernel.vgaCopyRow(dst, src)                // Copy row
kernel.vgaFillRow(row, ch, colorByte)      // Fill row
kernel.vgaFill(ch, colorByte)              // Fill entire screen
kernel.vgaSetCursor(row, col)              // Move hardware cursor
kernel.vgaHideCursor()                     // Hide cursor
kernel.vgaShowCursor()                     // Show cursor
kernel.getScreenSize()                     // Returns {width: 80, height: 25}

// Keyboard Input
kernel.readKey()                           // Non-blocking key poll
kernel.waitKey()                           // Blocking single key
kernel.waitKeyEx()                         // Blocking with extended info
kernel.hasKey()                            // Check if key ready

// System
kernel.getTicks()                          // Raw timer ticks
kernel.getUptime()                         // Milliseconds since boot
kernel.sleep(ms)                           // Sleep N milliseconds
kernel.getMemoryInfo()                     // Returns {total, free, used}
kernel.halt()                              // Power off
kernel.reboot()                            // Reboot system
kernel.eval(code)                          // Evaluate JavaScript

// Low-level I/O
kernel.inb(port)                           // Read I/O port
kernel.outb(port, val)                     // Write I/O port
kernel.callNative(addr, ...)               // Call native code
kernel.readMem8(addr)                      // Read physical memory
kernel.writeMem8(addr, val)                // Write physical memory

// Constants
kernel.colors.BLACK, kernel.colors.WHITE, etc.
kernel.KEY_UP, kernel.KEY_DOWN, kernel.KEY_F1, etc.
```

---

## Applications: Everything in JavaScript

**All applications run natively in JavaScript/TypeScript** - no compilation, no separate runtimes, no foreign function interfaces.

### System Applications
```javascript
// File Manager - pure JavaScript
function listDirectory(path) {
  return fs.readdir(path).map(file => ({
    name: file,
    size: fs.stat(file).size,
    type: fs.isDirectory(file) ? 'directory' : 'file'
  }));
}

// Process Monitor - pure JavaScript
function showProcesses() {
  return sys.processes().map(proc => ({
    pid: proc.pid,
    name: proc.name,
    cpu: proc.cpuUsage,
    memory: proc.memoryUsage
  }));
}
```

### User Applications
```javascript
// Text Editor - pure JavaScript
class TextEditor {
  constructor() {
    this.buffer = [];
    this.cursor = { x: 0, y: 0 };
  }

  insert(text) {
    // Direct hardware access through TypeScript APIs
    terminal.setCursor(this.cursor.x, this.cursor.y);
    terminal.print(text);
  }

  save(filename) {
    fs.writeFile(filename, this.buffer.join('\n'));
  }
}
```

### Network Applications
```javascript
// HTTP Client - pure JavaScript
async function fetch(url) {
  const socket = sys.net.createSocket();
  await socket.connect(url, 80);

  socket.write(`GET / HTTP/1.1\r\nHost: ${url}\r\n\r\n`);

  const response = await socket.read();
  return parseHttpResponse(response);
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 TypeScript OS Layer              │
│  main.ts → repl.ts → filesystem.ts → system.ts   │
│  terminal.ts → editor.ts → kernel.ts             │
├─────────────────────────────────────────────────┤
│        Babel + esbuild → ES2023 Bundle           │
│       (type-strip only — no polyfills!)          │
├─────────────────────────────────────────────────┤
│            QuickJS Engine (ES2023, C)            │
│        quickjs_binding.c ↔ kernel APIs           │
├─────────────────────────────────────────────────┤
│               C Kernel (i686-elf)                │
│  platform.c │ keyboard.c │ timer.c │ irq.c       │
│  memory.c   │ syscalls.c │ io.h   │ math_impl.c │
├─────────────────────────────────────────────────┤
│         x86 Bare Metal (Multiboot/GRUB)          │
│            boot.s → crt0.s → kernel.c            │
└─────────────────────────────────────────────────┘
```

**Applications run directly in the TypeScript OS Layer** - no separate runtimes, no compilation, pure JavaScript/TypeScript from bare metal to user interface.

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

## JavaScript API Reference

### Filesystem Functions
```javascript
ls(path?)           // List directory contents (pretty-printed)
cd(path?)           // Change directory (~ = /home/user)
pwd()               // Print working directory
cat(path)           // Display file contents
mkdir(path)         // Create directory
touch(path)         // Create empty file
rm(path)            // Remove file or empty directory
cp(src, dst)        // Copy file
mv(src, dst)        // Move/rename file
write(path, text)   // Overwrite file
append(path, text)  // Append to file
find(path?, pat)    // Find files (* wildcards)
stat(path)          // File/directory info
run(path)           // Execute .js file
```

### System Functions
```javascript
ps()                // List all processes (pretty-printed)
kill(pid)           // Terminate process
mem()               // Memory usage with bar graph
uptime()            // System uptime
sysinfo()           // Full system information
colors()            // VGA color palette demo
hostname(name?)     // Get/set hostname
sleep(ms)           // Sleep milliseconds
clear()             // Clear screen
halt()              // Power off
reboot()             // Reboot system
edit(path?)         // Launch text editor
```

### Scripting APIs (Raw Data)
```javascript
// Filesystem (returns plain data)
fs.ls(path)         // Array of {name, type, size}
fs.read(path)       // File contents string
fs.write(path, c)   // Boolean success
fs.append(path, c)  // Boolean success
fs.mkdir(path)      // Boolean success
fs.rm(path)         // Boolean success
fs.cp(src, dst)     // Boolean success
fs.mv(src, dst)     // Boolean success
fs.stat(path)       // {type, size, permissions} or null
fs.exists(path)     // Boolean
fs.isDir(path)      // Boolean
fs.isFile(path)     // Boolean
fs.pwd()            // Current directory string
fs.cd(path)         // Boolean success
fs.find(path, pat)  // Array of matching paths
fs.run(path)        // Eval result string

// System (returns plain data)
sys.mem()           // {total, free, used} in bytes
sys.ps()            // Array of {id, name, state, priority}
sys.kill(pid)       // Boolean success
sys.uptime()        // Milliseconds number
sys.screen()        // {width: 80, height: 25}
sys.spawn(name)     // Process ID number
sys.sleep(ms)       // undefined
sys.hostname(n?)    // Get/set hostname string
sys.version()       // Version string
sys.sysinfo()       // Full system object
sys.reboot()        // undefined
sys.halt()          // undefined
```

### Terminal & Display
```javascript
terminal.println(text)           // Print with newline
terminal.print(text)             // Print without newline
terminal.setColor(fg, bg)        // Set colors (0-15)
terminal.pushColor(fg, bg)       // Save and set colors
terminal.popColor(saved)         // Restore colors
terminal.clear()                 // Clear screen
terminal.getCursor()             // {row, col}
terminal.setCursor(row, col)     // Move cursor
terminal.colors                  // Color constants object
```

### REPL Functions
```javascript
help()              // Show this help
echo(...)           // Print arguments
print(value)        // Print a value
history()           // Show input history
printable(data, fn) // Custom pretty-printer
```

### Example Session

```
JSOS System Information
  QuickJS ES2023  |  i686  |  Bare Metal
  Type help() to see all available functions

> help()
JSOS  —  everything is JavaScript
QuickJS ES2023 on bare-metal i686
Type help() to see all available functions

Filesystem functions:
  ls(path?)            list directory
  cd(path?)            change directory  (~ = /home/user)
  pwd()                print working directory
  cat(path)            print file contents
  mkdir(path)          create directory
  touch(path)          create empty file
  rm(path)             remove file or empty dir
  cp(src, dst)         copy file
  mv(src, dst)         move / rename
  write(path, text)    overwrite file
  append(path, text)   append to file
  find(path?, pat)     find files  (* wildcard)
  stat(path)           file info
  run(path)            execute a .js file

System functions:
  ps()                 process list
  kill(pid)            terminate process
  mem()                memory usage + bar
  uptime()             system uptime
  sysinfo()            full system summary
  colors()             VGA color palette
  hostname(name?)      show or set hostname
  sleep(ms)            sleep N milliseconds
  clear()              clear the screen
  halt()               power off
  reboot()             reboot
  edit(path?)          fullscreen text editor  (^S save  ^Q quit)

> ls('/bin')
  /bin
    hello.js      27B
    sysinfo.js    147B
    colors.js     308B

> run('/bin/hello.js')
Hello, World!

> sysinfo()
JSOS System Information
  os       : JSOS v1.0.0
  hostname : jsos
  arch     : i686 (x86 32-bit)
  runtime  : QuickJS ES2023
  screen   : 80x25 VGA text
  memory   : 1048576 KB total, 1047552 KB free
  uptime   : 1250s
  procs    : 1

> ps()
  PID  NAME                 STATE     PRI
  ---  ------------------   -------   ---
    0  repl                 running   0

> mem()
Memory
  total : 1024 KB
  used  : 1 KB
  free  : 1023 KB
  [##..................................................]  0%

> ls().filter(f => f.name.endsWith('.js')).map(f => f.name)
[ "hello.js", "sysinfo.js", "colors.js" ]
```
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
    platform.c             # VGA/platform abstraction layer
    platform.h             # Platform API declarations
    keyboard.c             # PS/2 keyboard driver (IRQ1, US layout)
    timer.c                # PIT timer driver (IRQ0, 100 Hz)
    irq.c                  # IDT/PIC interrupt system
    irq_asm.s              # Assembly ISR stubs + GDT
    memory.c               # Memory pool allocator
    quickjs_binding.c      # JS ↔ kernel bridge (QuickJS API)
    syscalls.c             # Newlib system call stubs
    math_impl.c            # Math library (sin, cos, sqrt, etc.)
    io.h                   # Port I/O (inb/outb)
    linker.ld              # Linker script (loads at 1MB)
    Makefile               # Cross-compile with i686-elf-gcc
  os/                      # TypeScript OS layer
    main.ts                # Boot sequence + REPL entry point
    repl.ts                # JavaScript REPL with history
    terminal.ts            # Terminal abstraction (colors, cursor)
    filesystem.ts          # In-memory Unix-like filesystem
    system.ts              # Process manager
    editor.ts              # Fullscreen text editor
    kernel.ts              # TypeScript declarations for kernel API
scripts/
    bundle-hybrid.js       # Babel + esbuild bundler (TS → ES2023)
    build.sh               # Full kernel + ISO build
    embed-js.js            # Embeds JS bundle as C string literal
docker/
    build.Dockerfile       # Cross-compiler toolchain (GCC + newlib + QuickJS)
    test.Dockerfile        # QEMU test environment
```

---

## How It Works

1. **TypeScript** source files in `src/os/` are compiled to ES2023 JavaScript (type-strip only, no polyfills)
2. The JS bundle is **embedded as a C string literal** in the kernel
3. The C kernel is **cross-compiled** with `i686-elf-gcc` + newlib for bare metal i386
4. QuickJS ES2023 engine is compiled and linked into the kernel binary
5. The kernel binary is packaged into a **bootable ISO** with GRUB
6. On boot: GRUB → `boot.s` → `kernel.c` → Platform init → QuickJS → **TypeScript REPL runs directly**

The entire OS is a single JavaScript REPL where all system functionality is exposed as global functions. No traditional shell or command parsing — everything is live JavaScript execution on bare metal hardware.

---

## License

MIT
