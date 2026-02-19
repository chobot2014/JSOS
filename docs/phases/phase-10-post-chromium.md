# Phase 10 — Post-Chromium Hardening

## Goal

Transform JSOS from a working Chromium host into a robust general-purpose
operating system. This phase is a collection of parallel workstreams that
can be tackled in any order after Phase 9 ships.

---

## Prerequisites

Phase 9 complete (Chromium boots and renders pages).

---

## 10a — Multi-Core Support (SMP)

### Current State

Single core only. `ThreadManager` assumes one CPU. No synchronisation between
CPUs is needed (no spinlocks, no memory barriers beyond what x86 provides
for free on a single processor).

### Goal

Boot all CPUs advertised by the APIC. Each core runs its own scheduler loop.
Shared data structures are protected by spinlocks.

### C Additions

```c
// apic.c — new file:
void apic_init(void);                  // map LAPIC MMIO, enable local APIC
void apic_send_ipi(int cpu, int vec);  // send inter-processor interrupt
int  apic_cpu_count(void);             // number of CPUs from MADT ACPI table
void apic_ap_startup(void);            // AP (non-boot CPU) entry point in boot.s

// QuickJS bindings:
kernel.cpuCount(): number
kernel.apicSendIPI(cpu: number, vec: number): void
kernel.currentCPU(): number           // reads LAPIC ID
```

### TypeScript Additions

```typescript
// src/os/process/smp.ts
class PerCoreScheduler {
  // Each core has its own ready queue
  // Work stealing: idle core can steal from busy core's tail
  cpuId: number
  readyQueue: Thread[]
  currentThread: Thread
}

// src/os/process/spinlock.ts
class SpinLock {
  // Uses kernel.atomicCAS() C primitive (cmpxchg instruction)
  acquire(): void
  release(): void
}
```

All shared kernel data structures (process table, VMM, fd tables) gain
spinlock protection for Phase 10 SMP. TypeScript objects are the lock holders.

---

## 10b — JSOS Sandbox

### Goal

Chromium runs with `--no-sandbox` in Phase 9. Phase 10 implements JSOS-native
process isolation so Chromium renderer processes are sandboxed without Linux
namespaces or seccomp.

### Mechanism

- Each renderer process gets its own independent address space (Phase 4 VMM)
- Renderer runs at ring 3 — cannot execute privileged instructions
- Syscall filter: TypeScript `SyscallFilter` class allows/denies each syscall
  per process policy
- IPC to browser process only via Phase 6 socketpair

```typescript
class SyscallFilter {
  private policy: Map<number, 'allow' | 'deny' | FilterFn>

  static rendererPolicy(): SyscallFilter {
    // Chromium renderer needs: read, write, mmap, clock_gettime, futex
    // Deny: fork, exec, open (except pre-opened fds), network sockets
  }

  check(pid: number, syscallNr: number, args: number[]): boolean
}
```

The filter runs in the syscall dispatch path (Phase 6 `syscalls.ts`) — pure
TypeScript, no new C.

---

## 10c — Package Manager

Simple package system for installing apps and libraries from a package repository
over HTTPS (Phase 7 TLS).

```typescript
// src/os/pkg/pkg.ts
interface Package {
  name: string
  version: string
  dependencies: string[]
  files: PackageFile[]        // path → content
}

class PackageManager {
  async install(name: string, version?: string): Promise<void>
  async remove(name: string): Promise<void>
  async update(): Promise<void>                  // refresh index
  async list(): Promise<Package[]>               // installed packages
  async search(query: string): Promise<Package[]>

  // Package registry URL (configurable):
  registryURL: string
}
```

Global REPL API: `pkg.install('my-app')`, `pkg.list()`, `pkg.remove('my-app')`.

Packages are ELF binaries or TypeScript scripts stored on `/disk/packages/`.

---

## 10d — Window Manager v2

Improvements over the Phase 3 WM:

```typescript
class WindowManagerV2 extends WindowManager {
  // Multiple virtual desktops
  createDesktop(): Desktop
  switchDesktop(id: number): void
  moveWindowToDesktop(winId: number, desktopId: number): void

  // Window snapping
  snapWindow(id: number, side: 'left' | 'right' | 'top' | 'bottom'): void

  // Compositor effects (TypeScript only — no GPU needed with SwiftShader)
  setWindowOpacity(id: number, alpha: number): void
  animateWindow(id: number, animation: WMAnimation): void

  // Tiling mode
  setLayout(desktop: Desktop, layout: 'tiling' | 'floating'): void
}
```

---

## 10e — Audio

### Hardware Targets

- **Intel HDA (High Definition Audio)** — most common on real hardware
- **AC97** — supported by QEMU `-soundhw ac97`
- **virtio-sound** — QEMU virtio audio device (simplest)

### C Primitive (one per HDA/AC97)

```c
// audio.c — new file:
void audio_init(void);
void audio_submit_buffer(uint8_t *pcm, size_t len, int sample_rate, int channels);
int  audio_buffer_free(void);    // returns bytes free in DMA ring

// QuickJS binding:
kernel.audioInit(): boolean
kernel.audioWrite(samples: number[], sampleRate: number, channels: number): void
kernel.audioFreeBytes(): number
```

C sets up the DMA ring buffer and submits PCM data to the codec. TypeScript
owns the audio mixer, sample rate conversion, and volume control.

### TypeScript Audio Stack

```typescript
// src/os/audio/audio.ts
class AudioDevice {
  sampleRate: number        // 48000 Hz
  channels: number          // 2

  write(pcm: Float32Array): void
  getLatency(): number       // ms
}

class AudioMixer {
  addTrack(track: AudioTrack): void
  removeTrack(id: number): void
  setVolume(id: number, vol: number): void   // 0.0 – 1.0
  setMasterVolume(vol: number): void
  mix(): Float32Array        // mix all active tracks, submit to AudioDevice
}
```

Chromium routes audio via `/dev/snd/pcmC0D0p` (ALSA-compatible device node)
— we implement this as a `/dev` VFSMount that pipes to `AudioDevice`.

---

## 10f — USB Support

PCI EHCI/xHCI controller. C handles the DMA ring setup and port change
interrupt. TypeScript enumerates devices and implements class drivers.

```c
// xhci.c — new file:
void xhci_init(void);
int  xhci_submit_control(int slot, usb_setup_t *setup, uint8_t *data, int len);
int  xhci_submit_bulk(int slot, int endpoint, uint8_t *data, int len);
void xhci_get_device_desc(int slot, usb_device_desc_t *out);

// QuickJS bindings:
kernel.usbInit(): boolean
kernel.usbDevices(): { slot: number; vendor: number; product: number; class: number }[]
kernel.usbControl(slot, setup, data): number[]
kernel.usbBulk(slot, ep, data): number[]
```

TypeScript class drivers (USB mass storage, HID keyboard/mouse, audio) live
in `src/os/drivers/usb/`.

---

## 10g — ACPI / Power Management

```
lib/
  acpica/    ACPI Component Architecture (Intel's reference implementation)
             used for ACPI table parsing + namespace evaluation
```

```typescript
// src/os/power/acpi.ts
class ACPIManager {
  // Managed via lib/acpica, called through C bridge:
  init(): void
  shutdown(): void            // writes to PM1A_CNT SLP_EN bit
  reboot(): void              // ACPI reboot or PS/2 controller reset
  getSleepStates(): string[]  // ['S0','S3','S4','S5']
  enterSleep(state: string): void
  getBatteryInfo(): BatteryInfo | null
}
```

---

## 10h — x86_64 Port

Port the C kernel layer to 64-bit long mode. The TypeScript layer is
**unchanged** — this is the power of the JSOS architecture.

C work required:
- `boot.s`: long mode entry (PML4, PDPT, identity map, EFER.LME, CR0.PG)
- All structs: use 64-bit types where needed (GDT descriptors, TSS)
- Calling convention: switch from cdecl to SysV AMD64 ABI
- QuickJS binding: QuickJS already supports 64-bit

TypeScript work required: none beyond testing.

---

## 10i — JSOS 1.0 Checklist

| Feature | Phase | Status |
|---|---|---|
| Chromium boots and browses the web | 9 | ☐ |
| HTTPS working | 7 | ☐ |
| Multiple browser tabs | 9 | ☐ |
| Audio in browser (YouTube, etc.) | 10e | ☐ |
| Chromium renderer sandbox | 10b | ☐ |
| Multi-core (2+ CPUs) | 10a | ☐ |
| Package manager | 10c | ☐ |
| USB keyboard + mouse | 10f | ☐ |
| Suspend/resume | 10g | ☐ |
| x86_64 build | 10h | ☐ |

---

## Implementation Priority

Recommended order within Phase 10:

1. **10c (Package manager)** — enables distributing all subsequent work
2. **10b (Sandbox)** — security baseline
3. **10d (WM v2)** — usability
4. **10e (Audio)** — content completeness
5. **10a (SMP)** — performance
6. **10g (ACPI)** — hardware support + clean shutdown
7. **10f (USB)** — peripheral support
8. **10h (x86_64)** — performance + 64-bit address space

---

## The End State: JSOS 1.0

A bare-metal operating system where:

- TypeScript implements every OS algorithm and policy
- C provides only raw hardware access primitives
- Chromium runs natively, fully sandboxed, with accelerated rendering
- All user applications are JavaScript/TypeScript
- The REPL is always one key press away
- The system boots from a USB stick on commodity x86 hardware
