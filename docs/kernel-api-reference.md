# JSOS Kernel API Documentation
**Item 881** — All C-exported symbols documented

## Overview

The JSOS kernel exposes a thin set of C functions as "hardware primitives" to the TypeScript layer via `quickjs_binding.c`. Everything above this line is implemented in TypeScript.

---

## Memory

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.readPhys(addr, len)` | `(addr: number, len: number) => Uint8Array` | Read `len` bytes from physical address `addr`. |
| `kernel.writePhys(addr, data)` | `(addr: number, data: Uint8Array) => void` | Write bytes to physical address. DMA-safe. |
| `kernel.physMap(phys, len)` | `(phys: bigint, len: number) => Uint8Array` | Map a physical region into the JS linear heap; returns a live view. |
| `kernel.allocPages(n)` | `(n: number) => number` | Allocate `n` contiguous 4 KB physical pages; returns base address. |
| `kernel.freePages(addr, n)` | `(addr: number, n: number) => void` | Return pages to the physical allocator. |
| `memory_alloc_pages(n)` | C: `uint32_t memory_alloc_pages(uint32_t n)` | Internal allocator used by the JS binding layer. |
| `memory_free_pages(addr, n)` | C: `void memory_free_pages(uint32_t addr, uint32_t n)` | Free pages. |

---

## I/O Ports

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.inb(port)` | `(port: number) => number` | Read 8-bit I/O port. |
| `kernel.inw(port)` | `(port: number) => number` | Read 16-bit I/O port. |
| `kernel.inl(port)` | `(port: number) => number` | Read 32-bit I/O port. |
| `kernel.outb(port, val)` | `(port: number, val: number) => void` | Write 8-bit I/O port. |
| `kernel.outw(port, val)` | `(port: number, val: number) => void` | Write 16-bit I/O port. |
| `kernel.outl(port, val)` | `(port: number, val: number) => void` | Write 32-bit I/O port. |

---

## Interrupts & Timers

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.registerIRQ(irq, cb)` | `(irq: number, cb: () => void) => void` | Register a TypeScript callback for hardware IRQ `irq`. |
| `kernel.unregisterIRQ(irq)` | `(irq: number) => void` | Remove the IRQ handler. |
| `kernel.setInterval(cb, ms)` | `(cb: () => void, ms: number) => number` | Kernel timer (backed by PIT). Returns handle. |
| `kernel.clearInterval(id)` | `(id: number) => void` | Cancel a kernel timer. |
| `kernel.setTimeout(cb, ms)` | `(cb: () => void, ms: number) => number` | One-shot kernel timer. |
| `kernel.clearTimeout(id)` | `(id: number) => void` | Cancel a one-shot timer. |
| `kernel.uptimeMs()` | `() => number` | Milliseconds since boot (from PIT). |

---

## PCI Bus

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.pciEnumerate()` | `() => PCIDevice[]` | Return list of all PCI devices found. |
| `kernel.pciReadConfig(bus, dev, fn, off)` | `(bus, dev, fn, off: number) => number` | Read 32-bit PCI config space dword. |
| `kernel.pciWriteConfig(bus, dev, fn, off, val)` | 5-arg write | Write PCI config dword. |
| `kernel.pciMapBar(bus, dev, fn, barIdx)` | `(...) => number` | Map a BAR and return its MMIO base address. |

---

## Serial / Debug Output

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.serialWrite(s)` | `(s: string) => void` | Write string to COM1 (debug). |
| `kernel.serialRead()` | `() => string` | Read available bytes from COM1. |

---

## CPUID / Platform Info

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.cpuidInfo()` | `() => CPUIDInfo` | Returns CPUID feature flags (SSE2, AES, AVX, etc.). |
| `kernel.rdmsr(msr)` | `(msr: bigint) => bigint` | Read model-specific register. |
| `kernel.wrmsr(msr, val)` | `(msr: bigint, val: bigint) => void` | Write model-specific register. |
| `kernel.rdtsc()` | `() => bigint` | Read timestamp counter. |

---

## Audio (AC97 / Intel HDA)

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.ac97WriteBuffer(ptr, len)` | `(ptr: number, len: number) => void` | DMA a PCM buffer to AC97 output. |
| `kernel.hdaOpenStream(sampleRate, channels, bits)` | `(...) => number` | Open HDA stream; returns stream handle. |
| `kernel.hdaWriteBuffer(handle, ptr, len)` | `(handle, ptr, len: number) => void` | Feed PCM data into HDA stream. |
| `kernel.virtioSoundOpen(sampleRate, channels)` | `(...) => number` | Open virtio-snd output. |
| `kernel.virtioSoundWrite(handle, ptr, len)` | `(handle, ptr, len) => void` | Write audio to virtio-snd. |

---

## Network (E1000 / RTL8139)

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.netSend(frame)` | `(frame: Uint8Array) => void` | Transmit raw Ethernet frame. |
| `kernel.netRecv()` | `() => Uint8Array \| null` | Poll receive ring; returns one frame or null. |
| `kernel.netMacAddr()` | `() => Uint8Array` | Return 6-byte MAC address. |

---

## VGA / Framebuffer

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.fbWrite(x, y, w, h, pixels)` | `(x, y, w, h: number, pixels: Uint32Array) => void` | Blit RGBA pixels to framebuffer. |
| `kernel.fbSetMode(w, h, bpp)` | `(w, h, bpp: number) => void` | Switch VGA/VESA mode. |
| `kernel.vgaTextChar(row, col, char, attr)` | `(row, col, char, attr: number) => void` | Write a character in VGA text mode. |

---

## Storage (ATA / NVMe)

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.ataRead(drive, lba, sectors)` | `(drive, lba, sectors: number) => Uint8Array` | Synchronous LBA read. |
| `kernel.ataWrite(drive, lba, data)` | `(drive, lba: number, data: Uint8Array) => void` | Synchronous LBA write. |
| `kernel.nvmeRead(ns, lba, count)` | `(ns, lba, count: number) => Uint8Array` | NVMe namespace read. |
| `kernel.nvmeWrite(ns, lba, data)` | `(ns, lba: number, data: Uint8Array) => void` | NVMe namespace write. |

---

## JIT Engine

| Symbol | Signature | Description |
|--------|-----------|-------------|
| `kernel.jitCompile(bytecode)` | `(bc: Uint8Array) => CompiledFn` | JIT-compile QuickJS bytecode to native x86. |
| `kernel.jitFlushCache()` | `() => void` | Flush the native code cache (after code size overflow). |

---

*This file is autogenerated — see `src/kernel/quickjs_binding.c` for the canonical C source.*
