/**
 * JSOS sys.devices TypeScript API
 *
 * Implements:
 *   - [Item 175] VFS ioctl dispatch: sys.devices.ioctl(path, cmd, arg)
 *   - [Item 183] sys.devices API: enumerate hardware and driver state
 *   - [Item 186] Block device request queue + elevator I/O scheduler
 *
 * Pure TypeScript — C code only provides raw register I/O primitives.
 * All scheduling algorithms and device bookkeeping live here.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── ioctl command codes (Linux-compatible where applicable) ───────────────────
export const TIOCGWINSZ = 0x5413;   // Get terminal window size
export const TIOCSWINSZ = 0x5414;   // Set terminal window size
export const FIONREAD   = 0x541b;   // Get number of bytes available
export const BLKGETSIZE = 0x1260;   // Get block device size (in 512-byte sectors)
export const BLKBSZGET  = 0x80041260; // Get block device block size
export const EVIOCGNAME = 0x82004506; // Get device name (input devices)

// ── Device descriptor ─────────────────────────────────────────────────────────

/** Type of hardware device, as seen by sys.devices. */
export type DeviceClass =
  | 'block'       // disk, SSD, NVMe, USB mass storage
  | 'char'        // keyboard, mouse, serial, terminal
  | 'net'         // Ethernet, Wi-Fi, loopback adapter
  | 'gpu'         // graphics/framebuffer
  | 'audio'       // sound card
  | 'usb'         // USB host/device (non-HID)
  | 'platform';   // ACPI, PCI, embedded SoC peripherals

/** Driver state for a device. */
export type DriverState = 'bound' | 'unbound' | 'failed' | 'initializing';

/** [Item 183] Descriptor for a hardware device visible in sys.devices. */
export interface DeviceDescriptor {
  /** Unique system-wide device ID (bus address + slot, e.g. "pci:0:1:0"). */
  id:           string;
  /** Friendly name (driver may fill this in, e.g. "Intel e1000 Ethernet"). */
  name:         string;
  /** Device class. */
  class:        DeviceClass;
  /** Driver currently managing this device. */
  driver:       string;
  /** Driver binding state. */
  state:        DriverState;
  /** Vendor ID (PCI VID), or 0 for non-PCI devices. */
  vendorId:     number;
  /** Device ID (PCI DID), or 0. */
  deviceId:     number;
  /** IRQ line, or -1 if not interrupt-driven or unknown. */
  irq:          number;
  /** Memory-mapped I/O base address, or 0. */
  mmioBase:     number;
  /** I/O port base address, or 0. */
  ioBase:       number;
  /** Additional driver-specific properties. */
  properties:   Map<string, string>;
}

// ── ioctl handler registry ────────────────────────────────────────────────────

/** Handler function type for ioctl commands on a specific device path. */
export type IoctlHandler = (cmd: number, arg: number | object) => number | object | null;

/** [Item 175] VFS ioctl dispatch table: maps device paths to their handlers. */
class IoctlRegistry {
  private handlers = new Map<string, IoctlHandler>();

  /** Register an ioctl handler for a device path (e.g. '/dev/tty'). */
  register(path: string, handler: IoctlHandler): void {
    this.handlers.set(path, handler);
  }

  /**
   * [Item 175] Dispatch an ioctl call to the registered driver handler.
   *
   * Each path maps to a TypeScript handler.  If no handler is registered,
   * returns -ENOTTY (25).
   */
  dispatch(path: string, cmd: number, arg: number | object): number | object | null {
    var h = this.handlers.get(path);
    if (!h) {
      // Try prefix match (e.g. /dev/tty → /dev/tty0)
      for (var [p, ph] of this.handlers) {
        if (path.startsWith(p)) { h = ph; break; }
      }
    }
    if (!h) return -25;  // -ENOTTY
    try {
      return h(cmd, arg);
    } catch (_) {
      return -5;  // -EIO
    }
  }
}

export const ioctlRegistry = new IoctlRegistry();

// Built-in ioctl handlers ──────────────────────────────────────────────────────

// /dev/tty — terminal control
ioctlRegistry.register('/dev/tty', function(cmd, arg) {
  if (cmd === TIOCGWINSZ) {
    var w = typeof kernel !== 'undefined' && kernel.screenWidth  != null ? kernel.screenWidth  : 80;
    var h = typeof kernel !== 'undefined' && kernel.screenHeight != null ? kernel.screenHeight : 25;
    return { ws_col: Math.floor(w / 8), ws_row: Math.floor(h / 16), ws_xpixel: w, ws_ypixel: h };
  }
  return -25;
});

// /dev/null — no-op ioctl
ioctlRegistry.register('/dev/null', function(_cmd, _arg) { return 0; });

// ── sys.devices device registry ──────────────────────────────────────────────

/** [Item 183] Global hardware device registry (comparable to Linux /sys). */
class SysDevices {
  private registry = new Map<string, DeviceDescriptor>();

  /** Register a hardware device after probing/enumeration. */
  registerDevice(desc: DeviceDescriptor): void {
    this.registry.set(desc.id, desc);
  }

  /** Unregister a device (hot-unplug). */
  removeDevice(id: string): void {
    this.registry.delete(id);
  }

  /** Update a device's driver state. */
  setState(id: string, state: DriverState): void {
    var d = this.registry.get(id);
    if (d) d.state = state;
  }

  /** List all registered devices, optionally filtered by class. */
  list(cls?: DeviceClass): DeviceDescriptor[] {
    var all = Array.from(this.registry.values());
    return cls ? all.filter(function(d) { return d.class === cls; }) : all;
  }

  /** Find a device by ID. */
  get(id: string): DeviceDescriptor | undefined {
    return this.registry.get(id);
  }

  /**
   * [Item 175] VFS ioctl: dispatch an ioctl for the device at `path`.
   *
   * Example:
   *   sys.devices.ioctl('/dev/tty', TIOCGWINSZ, 0)
   *   → { ws_col: 80, ws_row: 25, ws_xpixel: 640, ws_ypixel: 400 }
   */
  ioctl(path: string, cmd: number, arg: number | object = 0): number | object | null {
    return ioctlRegistry.dispatch(path, cmd, arg);
  }

  /** Return a summary of all devices, suitable for a /sys virtual FS. */
  snapshot(): string {
    var lines: string[] = [];
    this.registry.forEach(function(d) {
      lines.push(`${d.id}: ${d.class} "${d.name}" driver=${d.driver} state=${d.state}`);
      if (d.vendorId) lines.push(`  vendor=${d.vendorId.toString(16)} device=${d.deviceId.toString(16)}`);
      if (d.irq >= 0) lines.push(`  irq=${d.irq}`);
      if (d.ioBase)   lines.push(`  ioport=0x${d.ioBase.toString(16)}`);
      d.properties.forEach(function(v, k) { lines.push(`  ${k}=${v}`); });
    });
    return lines.join('\n');
  }
}

/** [Item 183] Singleton sys.devices handle. */
export const sysDevices = new SysDevices();

// ── Block device layer: request queue + elevator I/O scheduler (Item 186) ─────

/** A single block I/O request (read or write). */
export interface BlockRequest {
  id:       number;     // unique request ID
  op:       'read' | 'write';
  sector:   number;     // LBA start sector (512-byte aligned)
  count:    number;     // number of sectors
  data:     Uint8Array; // [write] data to write; [read] buffer to fill
  resolve:  (err: number) => void;  // callback on completion (0 = success)
  priority: number;     // 0 = normal, 1 = high (barrier/sync)
}

/** Return type for elevator scheduler: next request to issue. */
type ElevatorResult = BlockRequest | null;

/**
 * [Item 186] Block device request queue with C-SCAN elevator scheduler.
 *
 * The C-SCAN (Circular SCAN) elevator provides uniform wait times across the
 * disk:
 *   - Requests are served in ascending sector order
 *   - When the head reaches the end, it jumps back to the lowest pending sector
 *   - This avoids the "far end starvation" of basic SCAN
 *
 * All scheduling logic lives in TypeScript; C code just submits raw I/O.
 */
export class BlockRequestQueue {
  private queue:   BlockRequest[] = [];
  private nextId   = 1;
  private headPos  = 0;      // current head sector (C-SCAN state)
  private active   = false;  // true while processing a request

  /** Enqueue a new block I/O request and return a promise for completion. */
  enqueue(op: 'read' | 'write', sector: number, count: number,
          data: Uint8Array, priority = 0): Promise<number> {
    return new Promise<number>((resolve) => {
      this.queue.push({ id: this.nextId++, op, sector, count, data, resolve, priority });
      if (!this.active) this._dispatch();
    });
  }

  /** C-SCAN elevator: pick the next request with the lowest sector ≥ head,
   *  wrapping around if none. High-priority requests always go first. */
  private _pick(): ElevatorResult {
    if (this.queue.length === 0) return null;

    // High-priority barrier requests always drain first
    for (var i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority > 0) {
        return this.queue.splice(i, 1)[0];
      }
    }

    // Find lowest sector ≥ headPos
    var bestIdx = -1;
    var bestSec = Infinity;
    for (var j = 0; j < this.queue.length; j++) {
      var s = this.queue[j].sector;
      if (s >= this.headPos && s < bestSec) { bestSec = s; bestIdx = j; }
    }

    // C-SCAN wrap-around: pick smallest sector overall
    if (bestIdx === -1) {
      bestSec = Infinity;
      for (var k = 0; k < this.queue.length; k++) {
        var sk = this.queue[k].sector;
        if (sk < bestSec) { bestSec = sk; bestIdx = k; }
      }
    }

    if (bestIdx === -1) return null;
    return this.queue.splice(bestIdx, 1)[0];
  }

  /** Dispatch the next pending request via the registered block driver. */
  private _dispatch(): void {
    var req = this._pick();
    if (!req) { this.active = false; return; }
    this.active  = true;
    this.headPos = req.sector;

    var self = this;
    // Call the low-level block I/O function registered for this queue.
    // By default this is a no-op (returns 0 = success) until a real driver
    // is registered via setDriver().
    var result = this._driver ? this._driver(req) : 0;
    if (result instanceof Promise) {
      result.then(function(err: number) { req.resolve(err); self.active = false; self._dispatch(); });
    } else {
      req.resolve(result);
      this.active = false;
      this._dispatch();
    }
  }

  /** (Optional) Current depth of the queue. */
  get depth(): number { return this.queue.length; }

  /** (Optional) Current head position. */
  get headSector(): number { return this.headPos; }

  /** Merge adjacent reads (read-ahead hints). Returns new queue length. */
  coalesce(): number {
    // Sort by sector, then merge adjacent reads
    this.queue.sort(function(a, b) { return a.sector - b.sector; });
    for (var i = this.queue.length - 1; i > 0; i--) {
      var cur  = this.queue[i];
      var prev = this.queue[i - 1];
      if (cur.op === 'read' && prev.op === 'read' &&
          prev.sector + prev.count === cur.sector) {
        // Merge cur into prev
        var merged = new Uint8Array(prev.count * 512 + cur.count * 512);
        merged.set(prev.data.slice(0, prev.count * 512), 0);
        merged.set(cur.data.slice(0, cur.count * 512), prev.count * 512);
        prev.count += cur.count;
        prev.data   = merged;
        this.queue.splice(i, 1);
      }
    }
    return this.queue.length;
  }

  private _driver: ((req: BlockRequest) => number | Promise<number>) | null = null;

  /** Register the low-level block I/O driver for this queue. */
  setDriver(fn: (req: BlockRequest) => number | Promise<number>): void {
    this._driver = fn;
  }
}

/** Default block device request queue (for primary disk '/dev/sda'). */
export const blockQueue = new BlockRequestQueue();

// Register block device as a sys.devices entry at boot
sysDevices.registerDevice({
  id: 'pci:0:1:1', name: 'ATA Primary Drive (sda)',
  class: 'block', driver: 'ata', state: 'bound',
  vendorId: 0, deviceId: 0, irq: 14, mmioBase: 0, ioBase: 0x1f0,
  properties: new Map([['dev', 'sda'], ['sectors', '2097152'], ['sector_size', '512']]),
});

/** Convenience: read sectors from the primary block device via the queue. */
export function blockRead(sector: number, count: number): Promise<Uint8Array> {
  var buf = new Uint8Array(count * 512);
  return blockQueue.enqueue('read', sector, count, buf).then(function(err) {
    if (err !== 0) return new Uint8Array(0);
    return buf;
  });
}

/** Convenience: write sectors to the primary block device via the queue. */
export function blockWrite(sector: number, data: Uint8Array): Promise<number> {
  return blockQueue.enqueue('write', sector, Math.ceil(data.length / 512), data);
}

// ─────────────────────────────────────────────────────────────────────────────
//  HotplugManager — items 939 & 940
//  TypeScript hotplug manager: event-based device arrival / departure.
//  C fires an IRQ on USB/PCI device attach; kernel.hotplugEvent() calls
//  HotplugManager.dispatch() to fan out to registered TypeScript handlers.
// ─────────────────────────────────────────────────────────────────────────────

export type HotplugEvent = 'add' | 'remove' | 'change';

export interface HotplugDevice {
  /** Bus-qualified identifier (e.g. 'usb:1-2.3', 'pci:0:3:0'). */
  id:          string;
  /** Human-readable name. */
  name:        string;
  /** Device class (same as DeviceDescriptor.class). */
  class:       DeviceClass;
  /** Kernel driver bound to the device (may be empty if none). */
  driver:      string;
  /** Extra key-value properties reported by the kernel at attachment time. */
  properties:  Map<string, string>;
}

type HotplugHandler = (event: HotplugEvent, device: HotplugDevice) => void;

/**
 * HotplugManager — singleton that tracks device arrival and departure events.
 *
 * Usage:
 *   hotplugManager.on('add',    (ev, dev) => { ... });
 *   hotplugManager.on('remove', (ev, dev) => { ... });
 *
 * The C kernel fires `kernel.hotplugDispatch(eventStr, { id, name, ... })`
 * which is bound to `hotplugManager.dispatch()` via the kernel init hook.
 */
export class HotplugManager {
  private _handlers = new Map<HotplugEvent | '*', HotplugHandler[]>();
  private _devices  = new Map<string, HotplugDevice>();

  /** Register a handler for a specific event type, or '*' for all events. */
  on(event: HotplugEvent | '*', handler: HotplugHandler): void {
    var list = this._handlers.get(event);
    if (!list) { list = []; this._handlers.set(event, list); }
    list.push(handler);
  }

  /** Remove a previously registered handler. */
  off(event: HotplugEvent | '*', handler: HotplugHandler): void {
    var list = this._handlers.get(event);
    if (!list) return;
    var idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Return all currently attached devices (snapshot). */
  listAttached(): HotplugDevice[] {
    return Array.from(this._devices.values());
  }

  /** Return the attached device with the given id, or null. */
  getDevice(id: string): HotplugDevice | null {
    return this._devices.get(id) ?? null;
  }

  /**
   * Dispatch a hotplug event.  Called from the C kernel binding
   * `kernel.hotplugDispatch(event, id, name, class, driver, props)`.
   */
  dispatch(event: HotplugEvent, device: HotplugDevice): void {
    if (event === 'add') {
      this._devices.set(device.id, device);
      // Also register with sysDevices if class is known
      sysDevices.registerDevice({
        id:         device.id,
        name:       device.name,
        class:      device.class,
        driver:     device.driver,
        state:      'bound',
        vendorId:   0, deviceId: 0, irq: 0, mmioBase: 0, ioBase: 0,
        properties: device.properties,
      });
    } else if (event === 'remove') {
      this._devices.delete(device.id);
    }

    // Fan-out to specific-event handlers, then '*' handlers
    var specific = this._handlers.get(event);
    if (specific) { for (var i = 0; i < specific.length; i++) specific[i](event, device); }
    var all = this._handlers.get('*');
    if (all) { for (var j = 0; j < all.length; j++) all[j](event, device); }
  }

  /**
   * Simulate USB device arrival (for testing / manual trigger).
   * Mirrors what the C USB IRQ handler would supply.
   */
  simulateUsb(event: HotplugEvent, usbPath: string, name: string,
              driver: string = 'usb-generic',
              props: Record<string, string> = {}): void {
    var propMap = new Map<string, string>(Object.entries(props));
    this.dispatch(event, { id: 'usb:' + usbPath, name, class: 'char', driver, properties: propMap });
  }
}

/** Singleton hotplug manager. */
export const hotplugManager = new HotplugManager();
