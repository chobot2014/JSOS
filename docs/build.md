# Building JSOS

## Requirements

| Tool | Purpose | Notes |
|---|---|---|
| **Docker Desktop** | Cross-compile environment | Everything else runs inside Docker |
| **Node.js ≥ 18** | Run build scripts | Only the npm scripts; compiler is in Docker |
| **QEMU** (`qemu-system-i386`) | Run the ISO | Install separately — see below |

You do **not** need a cross-compiler, GRUB, or QuickJS installed locally. Docker handles all of that.

---

## Install QEMU (Windows)

Download the QEMU Windows installer from https://www.qemu.org/download/#windows  
Default install path: `C:\Program Files\qemu\`

Verify:
```powershell
& "C:\Program Files\qemu\qemu-system-i386.exe" --version
```

---

## Build

```powershell
npm run build
```

This runs a single Docker build that:
1. Compiles the i686-elf cross-toolchain (GCC + Binutils + Newlib) — **cached after first run**
2. Compiles QuickJS from source — **cached**
3. Copies your source files into the container
4. Runs `npm run build:local` inside Docker:
   - Babel transpiles TypeScript → ES5
   - esbuild bundles everything into `build/bundle.js`
   - `embed-js.js` turns the bundle into `src/kernel/embedded_js.h`
5. `make` builds the kernel (i686-elf-gcc, links QuickJS + newlib)
6. `grub-mkrescue` produces `/jsos.iso` inside the container
7. `docker cp` extracts it to `build/jsos.iso` on your host

**First build:** ~5–10 minutes (toolchain compilation)  
**Subsequent builds:** ~45–60 seconds (cached toolchain, rebuilds OS layer only)

Output: `build/jsos.iso` (~10 MB)

---

## Run in QEMU

```powershell
# With SDL window (recommended for interactive use)
Start-Process "C:\Program Files\qemu\qemu-system-i386.exe" `
  -ArgumentList "-cdrom build\jsos.iso -m 32 -display sdl"

# Headless (for scripted testing)
& "C:\Program Files\qemu\qemu-system-i386.exe" -cdrom build\jsos.iso -m 32 -nographic
```

### Useful QEMU flags

| Flag | Effect |
|---|---|
| `-m 32` | 32 MB RAM (minimum; can increase) |
| `-display sdl` | SDL window (keyboard focus, copy/paste) |
| `-display gtk` | GTK window alternative |
| `-nographic` | Serial output only, no window |
| `-serial stdio` | Redirect serial port to terminal |
| `-snapshot` | Discard writes (safe for testing) |

---

## npm Scripts Reference

| Script | What it does |
|---|---|
| `npm run build` | Full Docker build → `build/jsos.iso` |
| `npm run build:local` | TypeScript bundle + embed (runs inside Docker) |
| `npm run bundle` | Babel + esbuild only → `build/bundle.js` |
| `npm run clean` | Remove `build/` directory |
| `npm run docker:build` | Pre-build Docker images |
| `npm run docker:rebuild` | Rebuild Docker images from scratch (no cache) |
| `npm run docker:clean` | Remove Docker images + volumes |
| `npm run test` | Automated QEMU test (headless, via docker-compose) |

---

## Docker Architecture

Two Dockerfiles:

### `docker/build.Dockerfile`
Multi-stage build:
- **Stage 1 (`builder`):** Ubuntu base, installs cross-compiler, clones + patches QuickJS, copies source, runs full build pipeline
- **Stage 2:** Copies only `jsos.iso` to a scratch layer for extraction

```dockerfile
# Key build steps inside Docker:
RUN apt-get install -y build-essential nasm grub-common xorriso ...
RUN git clone https://github.com/bellard/quickjs /opt/quickjs
RUN npm ci && npm run build:local
RUN ./scripts/build.sh
```

### `docker/test.Dockerfile`
Extends the build image with QEMU for automated testing.

---

## Build Pipeline Detail

### 1. TypeScript → ES5 Bundle (`scripts/bundle-hybrid.js`)

Uses Babel with:
- `@babel/preset-typescript` — strip types
- `@babel/preset-env` (target: `defaults`) — downcompile to ES5
- Class-properties, optional chaining, nullish-coalescing plugins

Output: `build/bundle.js` — a single IIFE with no external dependencies.

### 2. JS Embedding (`scripts/embed-js.js`)

```bash
# Turns build/bundle.js into a C header:
echo 'const char embedded_js_code[] = "...escaped JS..."' > embedded_js.h
```

The JS source is embedded as a C string literal, byte-escaped. At runtime, `quickjs_run_os()` passes it directly to `JS_Eval()`.

### 3. Kernel Compilation (`src/kernel/Makefile`)

```makefile
CC = i686-elf-gcc
CFLAGS = -ffreestanding -O2 -Wall -std=c11
LDFLAGS = -ffreestanding -nostartfiles -lgcc -lc -lnosys -lm
```

Link order: `boot.o crt0.o irq_asm.o kernel.o quickjs_binding.o terminal.o memory.o syscalls.o math_impl.o irq.o keyboard.o timer.o quickjs.o libregexp.o libunicode.o cutils.o dtoa.o`

QuickJS sources are compiled with `-w` (warnings suppressed) and extra defines:
```makefile
-D'PRId64="lld"' -D'PRIi64="lli"' -D'PRIu64="llu"' -D'PRIx64="llx"'
```
These are needed because `inttypes.h` format macros aren't properly exposed in freestanding + newlib.

### 4. ISO Creation

```bash
mkdir -p build/iso/boot/grub
cp jsos.bin build/iso/boot/
cp iso/grub.cfg build/iso/boot/grub/
grub-mkrescue -o build/jsos.iso build/iso/
```

`iso/grub.cfg`:
```
set timeout=0
set default=0
menuentry "JSOS" {
  multiboot /boot/jsos.bin
  boot
}
```

---

## Troubleshooting

### Build fails: "Docker daemon not running"
Start Docker Desktop and retry.

### Build fails: "temp-jsos already exists"
```powershell
docker rm temp-jsos
npm run build
```

### QEMU: no display / black screen
Try `-display gtk` or omit `-display sdl` (defaults vary by OS).

### QEMU: keyboard not responding
Click inside the SDL/GTK window to give it keyboard focus.  
Press `Ctrl+Alt+G` to release the mouse pointer from QEMU.

### Build: QuickJS compile errors
The QuickJS sources in the Docker image are patched at image build time. If you're rebuilding from scratch:
```powershell
npm run docker:rebuild
```

### Out of memory in QEMU
Increase RAM: `-m 64` or `-m 128`. The JS heap is fixed at 768 KB regardless.
