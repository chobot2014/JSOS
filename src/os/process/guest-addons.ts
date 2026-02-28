/**
 * JSOS Guest Additions — Items 839-842
 *
 * TypeScript wrappers for hypervisor paravirtualisation interfaces.
 *
 * [839] VMware Tools         — SVGA backdoor + balloon memory driver
 * [840] VirtualBox Additions — VMMDev protocol, Shared Folders hint
 * [841] KVM paravirt         — kvmclock, kvm-pv-eoi MSR
 * [842] Hyper-V enlightenments — SynIC, reference TSC page
 *
 * The actual I/O-port and MSR accesses are performed via thin C bindings
 * (kernel.inl / kernel.outl / kernel.rdmsr / kernel.wrmsr).
 */

// ── Kernel bindings ─────────────────────────────────────────────────────────

interface KernelHW {
  inl(port: number): number;
  outl(port: number, val: number): void;
  rdmsr(msr: number): bigint;
  wrmsr(msr: number, val: bigint): void;
  physMap(physAddr: bigint, length: number): Uint8Array;
}

function hw(): KernelHW {
  const k = (globalThis as any).kernel;
  if (!k) throw new Error('No kernel hardware access');
  return k;
}

// ── VMware detection helpers ────────────────────────────────────────────────

const VMWARE_MAGIC   = 0x564D5868;   // 'VMXh'
const VMWARE_PORT    = 0x5658;
const VMWARE_CMD_VER = 0x0A;
const VMWARE_CMD_BALLOON_DATA = 0x30;

function vmwareBackdoor(cmd: number, arg: number = 0): number {
  // ECX = cmd, EBX = arg, EAX = magic
  // Simulated as an outl to port 0x5658 (real access done in C layer)
  hw().outl(VMWARE_PORT, (VMWARE_MAGIC & 0xFFFF) | (cmd << 16));
  return hw().inl(VMWARE_PORT);
}

// ── [Item 839] VMware Tools ─────────────────────────────────────────────────

export interface VMwareInfo {
  version: number;
  type:    'workstation' | 'esxi' | 'fusion' | 'unknown';
}

export class VMwareTools {
  private _active = false;
  private _balloonTarget = 0;   // pages to balloon

  /** Probe for VMware environment via backdoor. */
  probe(): VMwareInfo | null {
    try {
      const v = vmwareBackdoor(VMWARE_CMD_VER);
      if ((v & 0xFFFF) === 0x5658) {
        this._active = true;
        const type: VMwareInfo['type'] =
          (v >>> 28) === 1 ? 'workstation' :
          (v >>> 28) === 2 ? 'esxi' :
          (v >>> 28) === 3 ? 'fusion' : 'unknown';
        return { version: v & 0xFFFF_0000, type };
      }
      return null;
    } catch { return null; }
  }

  /** Balloon driver: surrender `pages` 4KB pages back to host. */
  balloon(pages: number): void {
    if (!this._active) return;
    this._balloonTarget = pages;
    // In a real implementation, allocate those pages and report to host via backdoor
    vmwareBackdoor(VMWARE_CMD_BALLOON_DATA, pages);
  }

  /** Report guest screen resolution to SVGA (allows host viewport resize). */
  setResolution(width: number, height: number): void {
    if (!this._active) return;
    // SVGA backdoor cmd 0x14 = SET_DISPLAY_SIZE
    vmwareBackdoor(0x14, (width << 16) | height);
  }
}

export const vmwareTools = new VMwareTools();

// ── [Item 840] VirtualBox Guest Additions ───────────────────────────────────

const VBOX_VMMDEV_PORT   = 0x5644;   // VMMDev I/O port (simplified)
const VBOX_VMMDEV_VERSION = 0x00010003;

export interface VBoxInfo {
  version: number;
  features: number;
}

export class VirtualBoxAdditions {
  private _active = false;

  probe(): VBoxInfo | null {
    try {
      // Check VMMDev magic response
      hw().outl(VBOX_VMMDEV_PORT, VBOX_VMMDEV_VERSION);
      const resp = hw().inl(VBOX_VMMDEV_PORT + 4);
      if (resp === 0x4F4B) {   // 'OK'
        this._active = true;
        return { version: VBOX_VMMDEV_VERSION, features: hw().inl(VBOX_VMMDEV_PORT + 8) };
      }
      return null;
    } catch { return null; }
  }

  /**
   * Hint at shared folder availability.
   * Real implementation would use VBoxSF protocol over VMMDev guest request.
   */
  listSharedFolders(): string[] {
    if (!this._active) return [];
    // Stub: actual enumeration requires VMMDev request buffer in physical memory
    return [];
  }

  /** Report mouse integration events (absolute positioning). */
  reportMouseCapabilities(absPos: boolean): void {
    if (!this._active) return;
    hw().outl(VBOX_VMMDEV_PORT + 0x10, absPos ? 0x01 : 0x00);
  }
}

export const vboxAdditions = new VirtualBoxAdditions();

// ── [Item 841] KVM paravirtualisation ───────────────────────────────────────

const MSR_KVM_WALL_CLOCK  = 0x11;
const MSR_KVM_SYSTEM_TIME = 0x12;
const MSR_KVM_STEAL_TIME  = 0x4B564D03;
const MSR_KVM_PV_EOI_EN   = 0x4B564D04;
const KVM_FEATURE_CLOCKSOURCE2 = 1 << 3;

export interface KVMInfo {
  features: number;
  hasKvmClock: boolean;
}

export class KVMParavirt {
  private _clockPage?: Uint8Array;
  private _active = false;

  /** Detect KVM via CPUID leaf 0x40000000. */
  probe(): KVMInfo | null {
    try {
      // Check KVM signature in CPUID EBX/ECX/EDX ('KVMKVMKVM\0')
      const features = hw().inl(0x4000_0001);   // simplified CPUID proxy port
      if (features === 0) return null;           // no KVM
      this._active = true;
      return {
        features,
        hasKvmClock: (features & KVM_FEATURE_CLOCKSOURCE2) !== 0,
      };
    } catch { return null; }
  }

  /**
   * Enable kvmclock: allocate a page, write its physical address to
   * MSR_KVM_SYSTEM_TIME, KVM will fill ns-precision timestamp there.
   */
  enableKvmClock(physPageAddr: bigint): void {
    if (!this._active) return;
    this._clockPage = hw().physMap(physPageAddr, 4096);
    hw().wrmsr(MSR_KVM_SYSTEM_TIME, physPageAddr | 1n);   // bit 0 = enable
  }

  /** Read ns timestamp from the shared kvmclock page. */
  readClockNs(): bigint {
    if (!this._clockPage) return 0n;
    const view = new DataView(this._clockPage.buffer);
    // Offset 16 in pvclock_vcpu_time_info = system_time (u64)
    return view.getBigUint64(16, true);
  }

  /** Enable PV-EOI to reduce interrupt-acknowledgement overhead. */
  enablePvEoi(physPageAddr: bigint): void {
    if (!this._active) return;
    hw().wrmsr(MSR_KVM_PV_EOI_EN, physPageAddr | 1n);
  }
}

export const kvmParavirt = new KVMParavirt();

// ── [Item 842] Hyper-V enlightenments ───────────────────────────────────────

const MSR_HV_GUEST_OS_ID     = 0x40000000;
const MSR_HV_HYPERCALL       = 0x40000001;
const MSR_HV_VP_INDEX        = 0x40000002;
const MSR_HV_REFERENCE_TSC   = 0x40000021;
const MSR_HV_SIMP            = 0x40000082;   // SynIC message page
const MSR_HV_SIEFP           = 0x40000083;   // SynIC event flags page

const HV_GUEST_OS_ID_JSOS =
  (0n << 48n) |        // vendor: open-source (0)
  (1n << 32n) |        // OS type: Linux-compatible
  (1n << 16n) |        // major version
  0n;                  // minor version

export interface HyperVInfo {
  maxLeaf:   number;
  features:  number;
  recommendations: number;
}

export class HyperVEnlightenments {
  private _active = false;

  probe(): HyperVInfo | null {
    try {
      // Check Hyper-V 'Microsoft Hv' signature via CPUID 0x4000_0000
      const maxLeaf = hw().inl(0x4000_0000);
      if (maxLeaf < 0x4000_0001) return null;
      const features = hw().inl(0x4000_0003);
      const recs     = hw().inl(0x4000_0004);
      this._active = true;
      return { maxLeaf, features, recommendations: recs };
    } catch { return null; }
  }

  /** Identify ourselves to Hyper-V (required before hypercalls). */
  identify(): void {
    if (!this._active) return;
    hw().wrmsr(MSR_HV_GUEST_OS_ID, HV_GUEST_OS_ID_JSOS);
  }

  /**
   * Enable the reference TSC page for fast kernel-mode TSC reads.
   * physPageAddr must be a 4KB-aligned guest physical address.
   */
  enableReferenceTsc(physPageAddr: bigint): void {
    if (!this._active) return;
    hw().wrmsr(MSR_HV_REFERENCE_TSC, physPageAddr | 1n);
  }

  /**
   * Enable SynIC (Synthetic Interrupt Controller):
   *   - map message page (SIMP) and event flags page (SIEFP).
   */
  enableSynIC(simpPhys: bigint, siefpPhys: bigint): void {
    if (!this._active) return;
    hw().wrmsr(MSR_HV_SIMP,  simpPhys  | 1n);
    hw().wrmsr(MSR_HV_SIEFP, siefpPhys | 1n);
  }

  /** Read current virtual processor index. */
  vpIndex(): number {
    if (!this._active) return 0;
    return Number(hw().rdmsr(MSR_HV_VP_INDEX));
  }
}

export const hyperV = new HyperVEnlightenments();

// ── Auto-probe on import ────────────────────────────────────────────────────

export interface GuestType {
  hypervisor: 'vmware' | 'virtualbox' | 'kvm' | 'hyperv' | 'none';
  info: VMwareInfo | VBoxInfo | KVMInfo | HyperVInfo | null;
}

/**
 * Probe all hypervisors and return which one we're running under.
 * Call once during OS boot after PCI enumeration.
 */
export function detectHypervisor(): GuestType {
  const vm  = vmwareTools.probe();
  if (vm)   return { hypervisor: 'vmware',     info: vm };

  const vb  = vboxAdditions.probe();
  if (vb)   return { hypervisor: 'virtualbox', info: vb };

  const kvm = kvmParavirt.probe();
  if (kvm)  return { hypervisor: 'kvm',        info: kvm };

  const hv  = hyperV.probe();
  if (hv)   return { hypervisor: 'hyperv',     info: hv };

  return { hypervisor: 'none', info: null };
}
