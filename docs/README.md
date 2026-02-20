# JSOS Documentation

**JSOS** is a bare-metal x86 operating system where TypeScript IS the OS. Every algorithm, every data structure, every policy lives in TypeScript running on the [QuickJS](https://bellard.org/quickjs/) ES2023 engine embedded in the kernel binary. C code handles only raw hardware I/O.

> _"Everything is JavaScript"_  
> No shell. Just a live JS REPL where `ls()`, `cat('/etc/hostname')`, `disk.write('/notes', 'hi')`, and `2 + 2` are equally valid.

---

## Documents

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | System layers, boot sequence, how C and TypeScript fit together |
| [build.md](build.md) | How to build the ISO and run it in QEMU |
| [repl.md](repl.md) | Using the REPL — all globals, keyboard shortcuts, scripting examples |
| [kernel-api.md](kernel-api.md) | The `kernel` object — C hardware primitives exposed to JS |
| [filesystem.md](filesystem.md) | VFS layout, /proc, /dev, /disk (persistent FAT32), API and examples |
| [internals.md](internals.md) | Deep dive: C kernel, QuickJS binding, TypeScript build pipeline |

For the complete feature list and component table see [../OS_IMPLEMENTATION.md](../OS_IMPLEMENTATION.md).

---

## Quick Start

```powershell
# Build (requires Docker)
npm run build

# Headless test
npm run test:windows

# Interactive (256 MB RAM, framebuffer enabled)
& "C:\Program Files\qemu\qemu-system-i386.exe" `
    -cdrom build\jsos.iso -m 256 -display sdl -boot d `
    -drive file=build\disk.img,format=raw
```

## At the REPL

```
jsos:~> help()                    # list all globals
jsos:~> ls()                      # list current directory
jsos:~> cat('/etc/motd')          # read a file
jsos:~> disk.write('/hi', 'hey')  # write to persistent /disk
jsos:~> mem()                     # memory usage
jsos:~> sys.browser('https://example.com')  # open browser (framebuffer)
```

## Vital Statistics

| Property | Value |
|---|---|
| Architecture | i686 (x86 32-bit) |
| JS Engine | QuickJS ES2023 |
| Kernel language | C11 |
| OS language | TypeScript → ES2023 bundle |
| Boot | GRUB 2 multiboot |
| Display | VGA 80×25 text fallback; VESA 32-bit framebuffer (1024×768+) |
| Persistent storage | ATA → FAT32 / FAT16 |
| Networking | virtio-net → TCP/IP → TLS 1.3 → HTTP/HTTPS |
| Output | Bootable ISO (~10 MB) |
