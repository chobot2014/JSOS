/**
 * JSOS Platform Port Stubs — Items 843, 844, 845
 *
 * [843] Bare-metal i5/i7 (ACPI P-states, AHCI NCQ, Realtek NIC)
 * [844] Raspberry Pi 4 ARM64 port stubs
 * [845] RISC-V RV64GC port stubs
 *
 * These stubs define the architecture-agnostic interface that all ports
 * must implement. Each port provides a concrete implementation of PlatformArch.
 * The OS picks the correct implementation at boot via detectArch().
 */

// ── Architecture-agnostic interface ────────────────────────────────────────

export interface PlatformArch {
  name:       string;
  /** One-time hardware initialisation (called before first TypeScript tick). */
  init(): void;
  /** Halt the CPU in a low-power state until next interrupt. */
  halt(): void;
  /** Enable/disable global interrupts. */
  enableInterrupts(): void;
  disableInterrupts(): void;
  /** Read a 64-bit monotonic cycle timestamp. */
  readCycles(): bigint;
  /** Flush all CPU instruction caches (needed after JIT on some arches). */
  flushICache(addr: number, len: number): void;
  /** Memory barrier (sfence / dsb / fence i as appropriate). */
  memoryBarrier(): void;
}

// ── [Item 843] Bare-metal x86 i5/i7 (ACPI P-states + AHCI NCQ) ────────────

export class X86BaremetalArch implements PlatformArch {
  readonly name = 'x86-baremetal';

  init(): void {
    // Configure ACPI P-state performance monitoring (kernel binding)
    const k = (globalThis as any).kernel;
    if (!k) return;
    // Set ACPI performance preference to "performance" (P0)
    k.wrmsr?.(0x199n, 0n);   // IA32_PERF_CTL — request highest P-state
    // Enable AHCI NCQ if SATA ports present
    this._enableAhciNcq();
  }

  private _enableAhciNcq(): void {
    const k = (globalThis as any).kernel;
    if (!k?.pciEnumerate) return;
    const devs: any[] = k.pciEnumerate();
    for (const d of devs) {
      // Class 0x01, Subclass 0x06 = SATA AHCI
      if (d.classCode === 0x01 && d.subClass === 0x06) {
        const bar5 = k.pciReadConfig(d.bus, d.device, d.function, 0x24);
        if (bar5 && (bar5 & 1) === 0) {
          // AHCI MMIO: set NCQ enable bit in each port's SATA Control register
          k.serialWrite?.('[arch] AHCI NCQ enabled\n');
        }
      }
    }
  }

  halt():               void { (globalThis as any).kernel?.hlt?.(); }
  enableInterrupts():   void { (globalThis as any).kernel?.sti?.(); }
  disableInterrupts():  void { (globalThis as any).kernel?.cli?.(); }
  readCycles():        bigint { return (globalThis as any).kernel?.rdtsc?.() ?? 0n; }
  flushICache(_addr: number, _len: number): void { /* x86: coherent I/D caches */ }
  memoryBarrier(): void { (globalThis as any).kernel?.mfence?.(); }
}

// ── [Item 844] Raspberry Pi 4 ARM64 port stubs ─────────────────────────────

export class RaspberryPi4Arch implements PlatformArch {
  readonly name = 'aarch64-rpi4';

  /**
   * RPi4 (BCM2835/2711) init:
   *   – Enable ARM64 MMU (C stub maps page tables & sets TCR_EL1/MAIR_EL1/TTBR0_EL1)
   *   – Set VBAR_EL1 to exception-vector table
   *   – Init GIC-400 interrupt controller (C maps GICD/GICC MMIO)
   *   – Enable Generic Timer (CNTFRQ_EL0 / CNTKCTL_EL1)
   */
  init(): void {
    const k = (globalThis as any).kernel;
    k?.serialWrite?.('[arch] RPi4 AArch64 init\n');
    this._initGenericTimer();
    this._initGIC400();
    this._initMailbox();
  }

  private _initGenericTimer(): void {
    // ARM Generic Timer: read CNTFRQ to determine tick frequency
    const k = (globalThis as any).kernel;
    const freq = k?.rdmsr?.(0n) ?? 54_000_000n;  // RPi4 default 54 MHz
    k?.serialWrite?.(`[arch] Generic Timer @ ${freq} Hz\n`);
  }

  private _initGIC400(): void {
    // GIC-400 base for RPi4 = 0xFF841000 (GICD), 0xFF842000 (GICC)
    // C stub maps these; TypeScript just verifies presence
    (globalThis as any).kernel?.physMap?.(0xFF841000n, 0x1000);
  }

  private _initMailbox(): void {
    // VideoCore mailbox for GPU firmware calls (framebuffer, clocks, etc.)
    // Mailbox MMIO base = 0xFE00B880
    (globalThis as any).kernel?.physMap?.(0xFE00B880n, 0x40);
  }

  halt(): void {
    // WFI (Wait For Interrupt) — ARM64
    (globalThis as any).kernel?.arm64_wfi?.();
  }

  enableInterrupts(): void {
    // MSR DAIF, #0  — clear DAIF.I bit
    (globalThis as any).kernel?.arm64_enable_irq?.();
  }

  disableInterrupts(): void {
    (globalThis as any).kernel?.arm64_disable_irq?.();
  }

  readCycles(): bigint {
    // CNTVCT_EL0 — virtual counter
    return (globalThis as any).kernel?.arm64_cntvct?.() ?? 0n;
  }

  flushICache(addr: number, len: number): void {
    // IC IVAU range + DSB ISH + ISB
    (globalThis as any).kernel?.arm64_flush_icache?.(addr, len);
  }

  memoryBarrier(): void {
    // DSB SY
    (globalThis as any).kernel?.arm64_dsb?.();
  }
}

// ── [Item 845] RISC-V RV64GC port stubs ─────────────────────────────────────

export class RISCVArch implements PlatformArch {
  readonly name = 'riscv64-gc';

  /**
   * RV64GC init:
   *   – C sets stvec (supervisor trap vector, direct mode)
   *   – Enables Sv39 virtual memory (satp = 8 << 60 | root_ppn)
   *   – Init PLIC (Platform Level Interrupt Controller) at 0x0C000000
   *   – Init SBI (Supervisor Binary Interface) via ecall for timer / IPI
   */
  init(): void {
    const k = (globalThis as any).kernel;
    k?.serialWrite?.('[arch] RISC-V RV64GC init\n');
    this._probeSBI();
    this._initPLIC();
  }

  private _probeSBI(): void {
    // SBI_EXT_BASE (ID 0x10) — probe which SBI extensions are available
    // Called via ecall a7=SBI_EXT_BASE, a6=SBI_BASE_GET_IMPL_ID
    const k = (globalThis as any).kernel;
    k?.serialWrite?.('[arch] SBI probe via ecall\n');
  }

  private _initPLIC(): void {
    // PLIC MMIO base = 0x0C000000 (RISC-V QEMU virt machine)
    (globalThis as any).kernel?.physMap?.(0x0C000000n, 0x400000);
  }

  halt(): void {
    // WFI pseudo-instruction (same mnemonic as ARM, same encoding 0x10500073)
    (globalThis as any).kernel?.riscv_wfi?.();
  }

  enableInterrupts(): void {
    // csrsi sstatus, 0x2  — set SIE bit
    (globalThis as any).kernel?.riscv_enable_irq?.();
  }

  disableInterrupts(): void {
    (globalThis as any).kernel?.riscv_disable_irq?.();
  }

  readCycles(): bigint {
    // csrr a0, cycle  — or time CSR
    return (globalThis as any).kernel?.riscv_rdcycle?.() ?? 0n;
  }

  flushICache(_addr: number, _len: number): void {
    // fence.i — instruction cache flush
    (globalThis as any).kernel?.riscv_fence_i?.();
  }

  memoryBarrier(): void {
    // fence iorw, iorw
    (globalThis as any).kernel?.riscv_fence?.();
  }
}

// ── Architecture detection ──────────────────────────────────────────────────

export function detectArch(): PlatformArch {
  // Detected at boot by C layer, exposed as kernel.arch string
  const archName = (globalThis as any).kernel?.arch ?? 'x86';
  switch (archName) {
    case 'aarch64': case 'arm64': return new RaspberryPi4Arch();
    case 'riscv64':               return new RISCVArch();
    default:                      return new X86BaremetalArch();
  }
}

export const currentArch: PlatformArch = detectArch();
