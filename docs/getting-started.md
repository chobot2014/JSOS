# Getting Started: Build JSOS from Source
**Item 883**

This guide explains how to build JSOS on a Linux host (or WSL2 on Windows).

---

## Prerequisites

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y \
  gcc make qemu-system-i386 qemu-system-x86 \
  grub-pc-bin grub-efi-amd64-bin grub-efi-ia32-bin \
  genisoimage xorriso mtools parted dosfstools \
  nodejs npm

# Node.js 20+ required
node --version   # should be >= 20
```

---

## Clone and Setup

```bash
git clone https://github.com/jsos/jsos.git
cd jsos
npm install
```

---

## Build the OS

### Quick build (recommended)

```bash
npm run build
# Produces: build/bundle.js (the JS bundle) and build/jsos.iso
```

### Manual step-by-step

```bash
# 1. Compile the TypeScript OS layer
npx tsc -p src/os/tsconfig.json

# 2. Bundle JS
node scripts/bundle-hybrid.js

# 3. Embed the JS bundle into the kernel binary
node scripts/embed-js.js build/bundle.js src/kernel/embedded_js.h

# 4. Compile the C kernel
make -C src/kernel

# 5. Create the bootable ISO
bash scripts/build.sh
```

---

## Run in QEMU

```bash
# BIOS boot (i686)
qemu-system-i386 -cdrom build/jsos.iso -m 256M -serial stdio

# UEFI boot (x86_64)
qemu-system-x86_64 -cdrom build/jsos.iso -m 256M \
  -bios /usr/share/ovmf/OVMF.fd -serial stdio

# With networking
qemu-system-i386 -cdrom build/jsos.iso -m 256M -serial stdio \
  -net nic,model=e1000 -net user
```

---

## Run Tests

```bash
# Unit tests (Node.js, no QEMU needed)
node build/js/test/suite.js

# Integration tests (requires QEMU)
bash scripts/test.sh

# Windows (PowerShell)
.\test-windows.ps1
```

---

## Project Structure

```
src/
  kernel/      — C: minimal hardware I/O (ports, IRQs, DMA)
  os/
    core/      — OS boot & system call dispatcher (TypeScript)
    process/   — Scheduler, VMM, debugger (TypeScript)
    fs/        — VFS, ext4, overlayfs, ISO9660 (TypeScript)
    net/       — TCP/IP stack, DNS, HTTP (TypeScript)
    ipc/       — Pipes, channels (TypeScript)
    audio/     — Drivers, decoder, mixer, sys.audio API (TypeScript)
    ui/        — Terminal, REPL, WM (TypeScript)
    users/     — User management (TypeScript)
    apps/
      browser/ — Full web browser (TypeScript)
      terminal/ — Terminal app
      ...
    test/      — Unit & integration tests
build/         — Compiled output
docs/          — Architecture and API documentation
scripts/       — Build & test scripts
iso/           — GRUB configuration
```

---

## Development Workflow

```bash
# Watch mode: rebuild JS on change
npm run watch

# TypeScript type checking only (fast)
npx tsc -p src/os/tsconfig.json --noEmit

# Lint
npm run lint

# Run QEMU interactively after build
npm run dev
```

---

## Writing Your First JSOS App

All applications are TypeScript. Create `src/os/apps/hello/index.ts`:

```typescript
// Hello World JSOS App
import { terminal } from '../terminal/index.js';

export function main(): void {
  terminal.writeLine('Hello from JSOS!');
  terminal.writeLine(`Time: ${new Date().toISOString()}`);

  // Read a file
  sys.fs.readText('/etc/hostname').then(name => {
    terminal.writeLine(`Running on: ${name.trim()}`);
  });
}
```

Register it in `src/os/ui/commands.ts`:

```typescript
register('hello', () => import('../apps/hello/index.js').then(m => m.main()));
```

Then rebuild and run — your app is available in the JSOS REPL as `hello`.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `grub-mkimage: not found` | Install `grub-pc-bin` |
| `xorriso: not found` | Install `xorriso` or use `build-iso-noXorriso.sh` |
| QEMU: black screen | Add `-serial stdio` and check COM1 output |
| TypeScript errors | Run `npx tsc --noEmit`; baseline of ~79 pre-existing errors is OK |
| Bundle too large | Check `build/bundle.js` size; use tree-shaking flags in `bundle-hybrid.js` |

---

*For further reading see [docs/architecture.md](architecture.md) and [docs/internals.md](internals.md).*
