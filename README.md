# JSOS — JavaScript Operating System

**A complete operating system written in TypeScript, running on bare metal x86 hardware.**

**Every application, every OS service, every driver algorithm — TypeScript all the way down.**

JSOS compiles TypeScript to JavaScript, embeds it in a custom C kernel powered by [QuickJS](https://bellard.org/quickjs/) (a full ES2023 engine by Fabrice Bellard), and boots from a standard ISO image via GRUB. The C code handles only raw hardware I/O. Everything above that — the scheduler, memory manager, filesystem, network stack, window manager, and browser — is TypeScript running natively on bare metal.

![JSOS Demo](2026-02-18%2009-30-26.gif)

---

## What's Inside

### Window Manager + Pixel Graphics

- **VESA framebuffer** — 32-bit color pixel rendering at full screen resolution
- **Canvas API** — `drawRect`, `drawText`, `drawLine`, `blit` — everything built on a Uint32Array pixel buffer
- **8×8 bitmap font** — full printable ASCII, public-domain CP437 glyphs
- **Window manager** — drag, resize, z-order, taskbar, mouse cursor compositing
- **PS/2 mouse** — full relative motion + button tracking wired into WM event loop

### Native Browser

- **TypeScript-only browser** — no Chromium, no WebKit, no external renderer
- **Real HTTP + HTTPS** — uses the JSOS TCP/IP stack and TLS 1.3 implementation
- **HTML parser** — h1–h6, p, a, ul/ol/li, pre, hr, br, title
- **Clickable links**, scrollable content, back/forward history
- **DNS resolution** — digs the system DNS resolver at browse time
- **Built-in pages** — `about:blank`, `about:jsos`, `about:history`

### Networking

- **Full TCP/IP stack** — Ethernet → ARP → IPv4 → ICMP / UDP / TCP, written entirely in TypeScript
- **virtio-net driver** — C primitive that sends/receives raw Ethernet frames; all framing in TypeScript
- **DHCP client** — on-boot IP acquisition
- **DNS resolver** — iterative query with A-record parsing
- **TLS 1.3** — X25519 key exchange, AES-128-GCM-SHA256, SNI, no cert validation
- **HTTP/HTTPS client** — `httpGet` / `httpsGet` with header parsing and body accumulation
- **Loopback mode** — entire TCP/IP stack works without a NIC for local socket communication

### Persistent Storage

- **ATA PIO driver** — C primitive that reads/writes 512-byte sectors
- **FAT32** — auto-detected on first boot; auto-formats a blank disk
- **FAT16** — fallback for small disk images
- **64-sector LRU block cache** — sits above the ATA driver, below both FAT drivers
- **ROM filesystem** — bundled read-only files (e.g., `resources/bible.txt`) embedded in the ISO

### Memory Management

- **Physical page bitmap allocator** — tracks all 4 KB frames above the kernel image
- **Virtual memory manager** — mmap, mprotect, page table management, VMA tracking
- **Hardware paging** — CR3, CR4.PSE, TLB flush primitives called from TypeScript
- **Multi-process QuickJS pool** — up to 8 isolated JS runtimes with message-passing
- **Shared memory buffers** — zero-copy ArrayBuffer views shared across runtimes

### Multitasking

- **Kernel threads** — priority round-robin (0 = highest, 39 = idle), `createThread` / `tick`
- **Mutex / CondVar / Semaphore** — standard sync primitives, all in TypeScript
- **Preemptive scheduler hook** — 100Hz PIT fires C→TypeScript `tick()` for true preemption
- **fork / exec / waitpid** — full POSIX process model with VMA copying
- **ELF32 loader** — parses PT_LOAD segments, maps into virtual address space
- **Signals** — POSIX subset: SIGTERM, SIGKILL, SIGCHLD, SIGUSR1/2
- **Unified fd table** — file descriptors, pipes, sockets, and epoll in one table

### Filesystem

- **In-memory VFS** with pluggable mount points
- **/proc** — `version`, `uptime`, `meminfo`, `self/maps`
- **/dev** — `null`, `zero`, `urandom`, `tty`
- **/disk** — persistent FAT32/FAT16 mount, survives reboots

### JavaScript REPL

- **Direct bare-metal JavaScript execution** — no shell, no commands; everything is live JS
- **ES2023** — classes, async/await, destructuring, Map, Set, Promise, BigInt
- **Multi-line input** — `{`, `(`, `[` enter multi-line mode; auto-closes
- **Command history** — Up/Down arrow browsing
- **Auto pretty-printing** — arrays, objects, numbers formatted for the terminal
- Always reachable — even in windowed mode via the terminal window

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Applications (TypeScript)                          │
│  browser.ts · terminal-app.ts · editor-app.ts                  │
├─────────────────────────────────────────────────────────────────┤
│              OS Core (TypeScript)                               │
│  canvas · wm · net · tls · crypto · vfs · fat32 · threads      │
│  vmm · physalloc · process · fork/exec · fdtable · signals      │
├─────────────────────────────────────────────────────────────────┤
│  esbuild + type-strip → ES2023 bundle → embedded C string       │
├─────────────────────────────────────────────────────────────────┤
│              QuickJS ES2023 Engine (C)                          │
│              quickjs_binding.c ↔ kernel.* globals               │
├─────────────────────────────────────────────────────────────────┤
│              C Kernel (i686-elf)                                │
│  platform.c · keyboard.c · mouse.c · timer.c · irq.c           │
│  ata.c · virtio_net.c · pci.c · memory.c · syscalls.c          │
├─────────────────────────────────────────────────────────────────┤
│              x86 Bare Metal (Multiboot/GRUB)                    │
│              boot.s → crt0.s → kernel.c                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **Docker** — cross-compilation toolchain
- **Node.js** ≥ 18
- **QEMU** — `qemu-system-i386`

### Build & Run

```bash
npm install
npm run build      # Docker cross-compile → jsos.iso
npm run test       # Headless QEMU boot test
```

### Windows

```powershell
npm run build
npm run test:windows     # Headless QEMU test (PowerShell)
# Interactive:
& "C:\Program Files\qemu\qemu-system-i386.exe" -cdrom build\jsos.iso -m 256 -display sdl -boot d
```

---

## JavaScript API Reference

### Filesystem

```javascript
ls(path?)           // list directory (pretty-printed)
cd(path?)           // change directory
pwd()               // print working directory
cat(path)           // display file contents
mkdir(path)         // create directory
touch(path)         // create empty file
rm(path)            // remove file or empty directory
cp(src, dst)        // copy file
mv(src, dst)        // move / rename
write(path, text)   // overwrite file
append(path, text)  // append to file
find(path?, pat)    // find files (* wildcard)
stat(path)          // file info
run(path)           // execute .js file
```

### System

```javascript
ps()                // list all processes
kill(pid)           // terminate process
mem()               // memory usage with bar graph
uptime()            // system uptime
sysinfo()           // full system information
colors()            // VGA color palette demo
hostname(name?)     // get/set hostname
sleep(ms)           // sleep milliseconds
clear()             // clear screen
halt()              // power off
reboot()            // reboot
edit(path?)         // launch text editor
```

### Scripting APIs (raw data)

```javascript
// Filesystem
fs.ls(path)         // [{name, type, size}]
fs.read(path)       // string
fs.write(path, c)   // boolean
fs.mkdir(path)      // boolean
fs.rm(path)         // boolean
fs.stat(path)       // {type, size} | null
fs.exists(path)     // boolean
fs.run(path)        // eval result string

// System
sys.mem()           // {total, free, used} bytes
sys.ps()            // [{id, name, state, priority}]
sys.kill(pid)       // boolean
sys.uptime()        // milliseconds
sys.screen()        // {width, height}
sys.spawn(name)     // pid
sys.version()       // string
sys.sysinfo()       // full object

// Network
sys.browser(url?)   // open browser window (framebuffer mode only)
```

### Disk (persistent FAT32/FAT16)

```javascript
disk.ls(path?)          // list /disk directory
disk.read(path)         // read file from persistent disk
disk.write(path, text)  // write file to persistent disk
disk.mkdir(path)        // create directory on disk
disk.rm(path)           // remove file from disk
disk.stat(path)         // file info
disk.format()           // reformat disk (destructive)
```

### Terminal

```javascript
terminal.println(text)         // print with newline
terminal.print(text)           // print without newline
terminal.setColor(fg, bg)      // set colors (0-15)
terminal.pushColor(fg, bg)     // save and set
terminal.popColor(saved)       // restore
terminal.clear()               // clear screen
terminal.getCursor()           // {row, col}
terminal.setCursor(row, col)   // move cursor
```

### Kernel (raw hardware access)

```javascript
kernel.vgaPut(row, col, ch, colorByte)    // write VGA cell
kernel.vgaDrawRow(row, text, colorByte)   // write full 80-char row
kernel.vgaSetCursor(row, col)             // hardware cursor
kernel.fbInfo()                           // {width, height, pitch, bpp} | null
kernel.fbBlit(pixels, x, y, w, h)        // blit ArrayBuffer to framebuffer
kernel.readKey()                          // non-blocking key poll
kernel.readKeyEx()                        // {ch, ext} | null (includes arrows)
kernel.readMouse()                        // {dx, dy, buttons} | null
kernel.getTicks()                         // raw PIT ticks
kernel.getUptime()                        // ms since boot
kernel.sleep(ms)                          // sleep
kernel.getMemoryInfo()                    // {total, free, used}
kernel.getRamBytes()                      // total physical RAM
kernel.ataPresent()                       // ATA disk detected?
kernel.ataRead(lba, sectors)              // number[] | null
kernel.ataWrite(lba, sectors, data)       // boolean
kernel.netInit()                          // init virtio-net, true if found
kernel.netSendFrame(bytes)                // send raw Ethernet frame
kernel.netRecvFrame()                     // number[] | null
kernel.serialPut(s)                       // write to COM1
kernel.inb(port)                          // read I/O port
kernel.outb(port, val)                    // write I/O port
kernel.halt()                             // power off
kernel.reboot()                           // reboot

// Multi-process
kernel.procCreate()                       // allocate JS runtime slot (0-7)
kernel.procEval(id, code)                 // eval in child runtime
kernel.procSend(id, msg)                  // send string to child inbox
kernel.procRecv(id)                       // receive string from child
kernel.procDestroy(id)                    // free runtime slot

// Shared memory
kernel.sharedBufferCreate(size)           // allocate shared buffer
kernel.sharedBufferOpen(id)               // ArrayBuffer view
kernel.sharedBufferRelease(id)            // free slot
```

---

## How It Works

1. **TypeScript** source in `src/os/` is compiled to ES2023 (type-strip only, no polyfills)
2. The JS bundle is **embedded as a C string literal** (`embedded_js.h`) in the kernel
3. The C kernel is **cross-compiled** with `i686-elf-gcc` + newlib for bare metal i386
4. QuickJS ES2023 is compiled and linked into the kernel binary
5. The kernel binary is packaged into a **bootable ISO** with GRUB 2
6. On boot: GRUB → `boot.s` → `kernel.c` → hardware init → QuickJS → TypeScript runs

---

## Project Structure

```
src/
  kernel/            C kernel (hardware primitives only)
  os/                TypeScript OS (everything above the hardware)
    core/            kernel bindings, syscalls, fd table
    process/         threads, vmm, physalloc, process, elf, signals
    fs/              VFS, /proc, /dev, romfs
    storage/         block device, FAT32, FAT16
    net/             TCP/IP, DHCP, DNS, TLS, crypto, HTTP
    ui/              terminal, REPL, editor, canvas, WM
    apps/            browser, terminal-app, editor-app
    users/           user/group management
    ipc/             pipes, message queues
scripts/             build helpers (bundler, embed tools)
docker/              cross-compiler and test Dockerfiles
build/               compiled output (ISO, JS bundle)
docs/                documentation
resources/           bundled ROM files
```

---

## License

MIT
