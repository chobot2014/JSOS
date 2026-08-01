/**
 * kvm.ts — KVM Hypervisor Control for JSOS
 *
 * TypeScript VMM control logic for running hardware-assisted virtual machines.
 * The C kernel side exposes low-level VMX instructions (VMLAUNCH/VMRESUME,
 * VPID, EPT) via `kernel.kvm*` bindings; this module provides the TypeScript
 * policy / state-machine layer that implements the guest lifecycle.
 *
 * Items covered:
 *   942. [P3] KVM: C exposes VMLAUNCH/VMRESUME; TypeScript implements VMM
 *             control logic (vCPU create/run/stop, memory map, I/O intercepts)
 *
 * Architecture:
 *   ┌─────────────────────────────────────────┐
 *   │          KvmVm (TypeScript)              │
 *   │  createVcpu / addMemoryRegion / run      │
 *   │  I/O intercept dispatch (port & MMIO)    │
 *   └──────────────┬──────────────────────────┘
 *                  │  kernel.kvmVmCreate / kvmVcpuRun …
 *   ┌──────────────▼──────────────────────────┐
 *   │         C VMX kernel layer               │
 *   │  VMCS allocation, EPT tables, VMLAUNCH   │
 *   └─────────────────────────────────────────┘
 */

// ─── Kernel Bindings (provided by quickjs_binding.c) ─────────────────────────

declare const kernel: {
  /** Returns true if VMX extensions are available on this CPU. */
  kvmAvailable(): boolean;
  /** Allocate a new VM context. Returns an opaque VM handle or -1 on failure. */
  kvmVmCreate(): number;
  /** Destroy a VM and free all VMCS/EPT structures. */
  kvmVmDestroy(vmHandle: number): void;
  /** Allocate a vCPU within a VM context. Returns vCPU handle or -1. */
  kvmVcpuCreate(vmHandle: number): number;
  /**
   * Map a guest-physical region to host-physical memory.
   * @param vmHandle  VM handle
   * @param gpa       Guest physical address (page-aligned)
   * @param size      Region size in bytes (page-aligned)
   * @param hpa       Host physical address (page-aligned)
   * @param writable  Allow guest writes
   */
  kvmMapMemory(vmHandle: number, gpa: number, size: number, hpa: number, writable: boolean): number;
  /**
   * Run the vCPU until an exit condition.
   * Returns an exit reason code (see KvmExitReason).
   */
  kvmVcpuRun(vcpuHandle: number): number;
  /** Read a guest register. regId matches KvmReg enum. */
  kvmGetReg(vcpuHandle: number, regId: number): number;
  /** Write a guest register. */
  kvmSetReg(vcpuHandle: number, regId: number, value: number): void;
  /** Read the I/O exit info: { port, size, isWrite, data }. */
  kvmGetIoInfo(vcpuHandle: number): { port: number; size: number; isWrite: boolean; data: number };
  /** Read the MMIO exit info: { gpa, size, isWrite, data }. */
  kvmGetMmioInfo(vcpuHandle: number): { gpa: number; size: number; isWrite: boolean; data: number };
  /** Set the data value for a pending I/O/MMIO read. */
  kvmSetIoData(vcpuHandle: number, data: number): void;
  /** Inject a virtual IRQ into a vCPU. vector = 0–255. */
  kvmInjectIrq(vcpuHandle: number, vector: number): void;
  /** Destroy a vCPU. */
  kvmVcpuDestroy(vcpuHandle: number): void;
};

// ─── Enums ────────────────────────────────────────────────────────────────────

/** Exit reason codes returned by kvmVcpuRun(). */
export const enum KvmExitReason {
  IO         = 2,   // Port I/O intercept
  MMIO       = 6,   // MMIO intercept
  HLT        = 5,   // Guest executed HLT
  EXCEPTION  = 3,   // Guest exception (e.g. triple fault)
  HYPERCALL  = 11,  // VMCALL / hypercall
  SHUTDOWN   = 8,   // Guest shutdown / triple fault
}

/** Guest register identifiers. */
export const enum KvmReg {
  RAX = 0, RBX = 1, RCX = 2, RDX = 3,
  RSI = 4, RDI = 5, RSP = 6, RBP = 7,
  R8  = 8, R9  = 9, R10 = 10, R11 = 11,
  R12 = 12, R13 = 13, R14 = 14, R15 = 15,
  RIP = 16, RFLAGS = 17,
  CS = 18,  DS = 19, ES = 20, FS = 21, GS = 22, SS = 23,
  CR0 = 24, CR2 = 25, CR3 = 26, CR4 = 27,
}

// ─── KvmVcpu ──────────────────────────────────────────────────────────────────

/** Represents a single virtual CPU. */
export class KvmVcpu {
  readonly vcpuHandle: number;
  readonly id:         number;
  private  _vm:        KvmVm;
  running  = false;

  constructor(handle: number, id: number, vm: KvmVm) {
    this.vcpuHandle = handle;
    this.id         = id;
    this._vm        = vm;
  }

  /** Read a guest register. */
  getReg(reg: KvmReg): number { return kernel.kvmGetReg(this.vcpuHandle, reg); }
  /** Write a guest register. */
  setReg(reg: KvmReg, value: number): void { kernel.kvmSetReg(this.vcpuHandle, reg, value); }

  /** Inject a hardware interrupt vector into this vCPU. */
  injectIrq(vector: number): void { kernel.kvmInjectIrq(this.vcpuHandle, vector); }

  /**
   * Run until an I/O or HLT exit, then return.
   * VM dispatch loop calls this in a tight loop.
   */
  runOnce(): KvmExitReason {
    return kernel.kvmVcpuRun(this.vcpuHandle) as KvmExitReason;
  }

  destroy(): void {
    kernel.kvmVcpuDestroy(this.vcpuHandle);
  }
}

// ─── I/O Intercept Registry ───────────────────────────────────────────────────

export type IoReadHandler  = (port: number, size: number) => number;
export type IoWriteHandler = (port: number, size: number, data: number) => void;
export type MmioReadHandler  = (gpa: number, size: number) => number;
export type MmioWriteHandler = (gpa: number, size: number, data: number) => void;

interface PortHandlers { read?: IoReadHandler; write?: IoWriteHandler; }
interface MmioRegion   { base: number; size: number; read?: MmioReadHandler; write?: MmioWriteHandler; }

// ─── KvmMemoryRegion ─────────────────────────────────────────────────────────

export interface KvmMemoryRegion {
  /** Guest physical address. */
  gpa:      number;
  /** Host physical address. */
  hpa:      number;
  /** Size in bytes. */
  size:     number;
  writable: boolean;
}

// ─── KvmVm ────────────────────────────────────────────────────────────────────

/**
 * KvmVm — a full hardware-assisted virtual machine.
 *
 * Example (run a 16-bit real-mode binary at 0x7C00):
 *
 *   const vm = new KvmVm();
 *   if (!vm.init()) throw new Error('No VMX support');
 *   vm.addMemoryRegion({ gpa: 0, hpa: physBuffer, size: 1 * 1024 * 1024, writable: true });
 *   const vcpu = vm.createVcpu();
 *   vcpu.setReg(KvmReg.CS,  0x0000);
 *   vcpu.setReg(KvmReg.RIP, 0x7C00);
 *   vm.onPortWrite(0x80, (port, sz, data) => { ... });   // I/O port intercept
 *   await vm.run();
 */
export class KvmVm {
  private _vmHandle   = -1;
  private _vcpus:     KvmVcpu[] = [];
  private _ports:     Map<number, PortHandlers> = new Map();
  private _mmioRegions: MmioRegion[] = [];
  private _running    = false;
  private _stopFlag   = false;
  private _memoryMap: KvmMemoryRegion[] = [];

  /** Number of vCPUs currently in this VM. */
  get vcpuCount(): number { return this._vcpus.length; }

  /** All mapped memory regions. */
  get memoryMap(): KvmMemoryRegion[] { return [...this._memoryMap]; }

  /**
   * Initialize the VM.  Returns false if VMX is not available or
   * the kernel allocation fails.
   */
  init(): boolean {
    if (!kernel.kvmAvailable()) return false;
    this._vmHandle = kernel.kvmVmCreate();
    return this._vmHandle >= 0;
  }

  /** Map a physical memory region into the guest address space. */
  addMemoryRegion(region: KvmMemoryRegion): void {
    var rc = kernel.kvmMapMemory(
      this._vmHandle, region.gpa, region.size, region.hpa, region.writable);
    if (rc < 0) throw new Error('kvmMapMemory failed: ' + rc);
    this._memoryMap.push(region);
  }

  /** Create a new vCPU in this VM. */
  createVcpu(): KvmVcpu {
    var h = kernel.kvmVcpuCreate(this._vmHandle);
    if (h < 0) throw new Error('kvmVcpuCreate failed');
    var vcpu = new KvmVcpu(h, this._vcpus.length, this);
    this._vcpus.push(vcpu);
    return vcpu;
  }

  /** Register a read handler for an I/O port. */
  onPortRead(port: number, fn: IoReadHandler): void {
    var h = this._ports.get(port) ?? {};
    h.read = fn;
    this._ports.set(port, h);
  }

  /** Register a write handler for an I/O port. */
  onPortWrite(port: number, fn: IoWriteHandler): void {
    var h = this._ports.get(port) ?? {};
    h.write = fn;
    this._ports.set(port, h);
  }

  /** Register MMIO read/write handlers for a guest-physical memory region. */
  addMmioRegion(base: number, size: number,
                readFn?: MmioReadHandler, writeFn?: MmioWriteHandler): void {
    this._mmioRegions.push({ base, size, read: readFn, write: writeFn });
  }

  /**
   * Run the VM until halted or stopped.
   * Runs vCPU 0 in a synchronous loop; for SMP use runVcpuAsync() per vCPU.
   */
  async run(): Promise<void> {
    if (this._vcpus.length === 0) throw new Error('No vCPUs');
    this._running  = true;
    this._stopFlag = false;
    var vcpu        = this._vcpus[0];

    while (!this._stopFlag) {
      var reason = vcpu.runOnce();
      this._handleExit(vcpu, reason);
      if (reason === KvmExitReason.HLT || reason === KvmExitReason.SHUTDOWN) break;
      // Yield control briefly to avoid starving JS event loop
      await new Promise<void>(r => setTimeout(r, 0));
    }
    this._running = false;
  }

  /** Stop a running VM gracefully. */
  stop(): void { this._stopFlag = true; }

  get isRunning(): boolean { return this._running; }

  private _handleExit(vcpu: KvmVcpu, reason: KvmExitReason): void {
    if (reason === KvmExitReason.IO) {
      var io  = kernel.kvmGetIoInfo(vcpu.vcpuHandle);
      var hdl = this._ports.get(io.port);
      if (io.isWrite) {
        if (hdl?.write) hdl.write(io.port, io.size, io.data);
      } else {
        var val = 0xffffffff;
        if (hdl?.read) val = hdl.read(io.port, io.size);
        kernel.kvmSetIoData(vcpu.vcpuHandle, val);
      }
    } else if (reason === KvmExitReason.MMIO) {
      var mio  = kernel.kvmGetMmioInfo(vcpu.vcpuHandle);
      var reg = this._mmioRegions.find(r => mio.gpa >= r.base && mio.gpa < r.base + r.size);
      if (mio.isWrite) {
        if (reg?.write) reg.write(mio.gpa, mio.size, mio.data);
      } else {
        var mval = 0;
        if (reg?.read) mval = reg.read(mio.gpa, mio.size);
        kernel.kvmSetIoData(vcpu.vcpuHandle, mval);
      }
    }
    // HLT, SHUTDOWN, EXCEPTION: caller breaks the loop
  }

  /** Destroy all vCPUs and the VM context. */
  destroy(): void {
    this._stopFlag = true;
    for (var i = 0; i < this._vcpus.length; i++) this._vcpus[i].destroy();
    this._vcpus = [];
    if (this._vmHandle >= 0) {
      kernel.kvmVmDestroy(this._vmHandle);
      this._vmHandle = -1;
    }
  }
}

/** True when the host CPU supports VMX and the kernel has KVM enabled. */
export function kvmAvailable(): boolean {
  try { return kernel.kvmAvailable(); }
  catch (_) { return false; }
}
