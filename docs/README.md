# JSOS Documentation

**JSOS** is a bare-metal x86 operating system whose userland is entirely JavaScript (ES2023), running on the [QuickJS](https://bellard.org/quickjs/) engine embedded directly into the kernel binary.

> _"Everything is JavaScript"_  
> No shell. No interpreter prompt. Just a live JS REPL where `ls()`, `cat('/etc/hostname')`, and `2 + 2` are all equally valid.

---

## Documents

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | System layers, boot sequence, how C and JS fit together |
| [build.md](build.md) | How to build the ISO and run it in QEMU |
| [repl.md](repl.md) | Using the REPL — all globals, keyboard shortcuts, scripting examples |
| [kernel-api.md](kernel-api.md) | The `kernel` object — every C function exposed to JS |
| [filesystem.md](filesystem.md) | In-memory filesystem layout, API, and example programs |
| [internals.md](internals.md) | Deep dive: C kernel, QuickJS binding, TypeScript pipeline |

---

## Quick Start

```powershell
# Build (requires Docker)
npm run build

# Run in QEMU
& "C:\Program Files\qemu\qemu-system-i386.exe" -cdrom build\jsos.iso -m 32 -display sdl
```

## At the REPL

```
jsos:~> help()           # list all globals
jsos:~> ls()             # list current directory
jsos:~> cat('/etc/motd') # read a file
jsos:~> mem()            # memory usage
jsos:~> 2 + 2            # → 4
```

## Vital Statistics

| Property | Value |
|---|---|
| Architecture | i686 (x86 32-bit) |
| JS Engine | QuickJS ES2023 |
| JS Heap | 768 KB |
| JS Stack | 32 KB |
| Total RAM | 32 MB (QEMU default) |
| Screen | 80×25 VGA text mode |
| Kernel language | C11 |
| Userland language | TypeScript → ES5 bundle |
| Boot | GRUB 2 multiboot |
| Output | Bootable ISO (~10 MB) |
