/**
 * JSOS Pluggable Filesystem Driver API
 *
 * [Item 202] Filesystem driver registration and auto-detection framework.
 *
 * Allows new filesystem types to be registered at runtime (just like Linux's
 * `register_filesystem()`).  A driver provides:
 *   - `probe(device)`  — returns true if it recognises the on-device superblock
 *   - `mount(device, opts)` — returns a `VFSMount` instance ready for use
 *   - `format(device, opts)` — (optional) create a new empty filesystem
 *
 * Usage:
 *   fsDriverRegistry.register(ext4Driver);
 *   fsDriverRegistry.register(iso9660Driver);
 *   const mount = await fsDriverRegistry.detectAndMount(myDevice);
 *   const drivers = fsDriverRegistry.list();
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Shared types ──────────────────────────────────────────────────────────────

/** Minimal block-device interface that every FS driver receives. */
export interface FSBlockDevice {
  /** Device name / path, e.g. '/dev/sda1'. */
  readonly name: string;
  /** Logical block size in bytes (typically 512 or 4096). */
  readonly blockSize: number;
  /** Total number of logical blocks. */
  readonly blockCount: number;
  /** Read `count` blocks starting at `lba` into a Uint8Array. */
  readBlocks(lba: number, count: number): Uint8Array | Promise<Uint8Array>;
  /** Write a Uint8Array to `count` blocks starting at `lba` (optional). */
  writeBlocks?(lba: number, data: Uint8Array): void | Promise<void>;
  /** true if the device is read-only. */
  readonly readOnly: boolean;
}

/** Opaque mount handle returned by `FSDriver.mount()`. */
export interface VFSMount {
  readonly mountPoint: string;
  readonly readOnly: boolean;
  readonly fsType: string;
  unmount(): void | Promise<void>;
}

/** Options passed to mount / format. */
export interface FSMountOptions {
  readOnly?:    boolean;
  mountPoint?:  string;
  /** Driver-specific extra options, e.g. `{ encoding: 'utf8', journalSize: 8 }`. */
  [key: string]: unknown;
}

// ── FSDriverDescriptor ────────────────────────────────────────────────────────

/**
 * [Item 202] Filesystem driver descriptor — the object you register.
 */
export interface FSDriverDescriptor {
  /** Unique filesystem type name, e.g. 'ext4', 'vfat', 'iso9660'. */
  readonly name: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Priority when multiple drivers probe successfully — higher wins. */
  readonly priority?: number;

  /**
   * Return true if this driver recognises the superblock/signature on `device`.
   * Must be non-destructive (read-only probe).
   */
  probe(device: FSBlockDevice): boolean | Promise<boolean>;

  /**
   * Mount the filesystem on `device` and return a VFSMount.
   * Called after `probe()` succeeds.
   */
  mount(device: FSBlockDevice, opts: FSMountOptions): VFSMount | Promise<VFSMount>;

  /**
   * (Optional) Format `device` as this filesystem type.
   */
  format?(device: FSBlockDevice, opts: FSMountOptions): void | Promise<void>;
}

// ── FSDriverRegistry ──────────────────────────────────────────────────────────

export interface MountResult {
  mount:  VFSMount;
  driver: FSDriverDescriptor;
}

/**
 * [Item 202] Central registry for pluggable filesystem drivers.
 *
 * Drivers are stored in priority order (highest priority first).
 * `detectAndMount()` probes all registered drivers in order and uses
 * the first that succeeds.
 */
export class FSDriverRegistry {
  private _drivers: FSDriverDescriptor[] = [];

  /**
   * Register a filesystem driver.
   * Drivers with higher `priority` (default 0) are tried first during auto-detection.
   */
  register(driver: FSDriverDescriptor): void {
    // Remove any existing driver with the same name
    this._drivers = this._drivers.filter(function(d) { return d.name !== driver.name; });
    // Insert in priority order (descending)
    var priority = driver.priority ?? 0;
    var idx = this._drivers.findIndex(function(d) { return (d.priority ?? 0) < priority; });
    if (idx === -1) {
      this._drivers.push(driver);
    } else {
      this._drivers.splice(idx, 0, driver);
    }
  }

  /** Remove a driver by name. */
  unregister(name: string): boolean {
    var len = this._drivers.length;
    this._drivers = this._drivers.filter(function(d) { return d.name !== name; });
    return this._drivers.length < len;
  }

  /** Look up a driver by exact name. */
  get(name: string): FSDriverDescriptor | undefined {
    return this._drivers.find(function(d) { return d.name === name; });
  }

  /** List all registered drivers (highest priority first). */
  list(): Array<{ name: string; description: string; priority: number }> {
    return this._drivers.map(function(d) {
      return { name: d.name, description: d.description ?? '', priority: d.priority ?? 0 };
    });
  }

  /**
   * [Item 202] Mount using a specific named driver.
   */
  async mount(driverName: string, device: FSBlockDevice, opts: FSMountOptions = {}): Promise<VFSMount> {
    var driver = this.get(driverName);
    if (!driver) throw new Error('FSDriverRegistry: no driver registered for ' + driverName);
    return driver.mount(device, opts);
  }

  /**
   * [Item 202] Probe all registered drivers in priority order and mount with the
   * first that recognises `device`.  Throws if no driver matches.
   */
  async detectAndMount(device: FSBlockDevice, opts: FSMountOptions = {}): Promise<MountResult> {
    for (var i = 0; i < this._drivers.length; i++) {
      var driver = this._drivers[i];
      var recognised: boolean;
      try { recognised = !!(await driver.probe(device)); } catch (_) { recognised = false; }
      if (recognised) {
        var mount = await driver.mount(device, opts);
        return { mount, driver };
      }
    }
    throw new Error('FSDriverRegistry: no driver recognised device ' + device.name);
  }

  /**
   * Probe all drivers and return names of all that recognise the device.
   */
  async detectAll(device: FSBlockDevice): Promise<string[]> {
    var names: string[] = [];
    for (var i = 0; i < this._drivers.length; i++) {
      var d = this._drivers[i];
      try { if (await d.probe(device)) names.push(d.name); } catch (_) {}
    }
    return names;
  }

  /**
   * Format a device using the named driver.  Throws if the driver has no
   * `format()` method.
   */
  async format(driverName: string, device: FSBlockDevice, opts: FSMountOptions = {}): Promise<void> {
    var driver = this.get(driverName);
    if (!driver) throw new Error('FSDriverRegistry: no driver registered for ' + driverName);
    if (!driver.format) throw new Error('FSDriverRegistry: driver ' + driverName + ' does not support format()');
    await driver.format(device, opts);
  }
}

/** Global singleton filesystem driver registry. */
export const fsDriverRegistry = new FSDriverRegistry();

// ── NullFS: a trivial built-in driver for testing ─────────────────────────────

class NullVFSMount implements VFSMount {
  readonly mountPoint: string;
  readonly readOnly = true;
  readonly fsType   = 'nullfs';
  constructor(mp: string) { this.mountPoint = mp; }
  unmount(): void {}
}

/**
 * NullFS driver — always probes false on real devices; used for testing
 * and as a template for new driver implementations.
 */
export const nullFSDriver: FSDriverDescriptor = {
  name:        'nullfs',
  description: 'No-op null filesystem (testing only)',
  priority:    -9999,

  probe(_device: FSBlockDevice): boolean { return false; },

  mount(device: FSBlockDevice, opts: FSMountOptions): VFSMount {
    return new NullVFSMount(opts.mountPoint ?? '/mnt/null');
  },

  format(_device: FSBlockDevice, _opts: FSMountOptions): void {
    // nothing to format
  },
};

// Register the null driver so the registry is always non-empty
fsDriverRegistry.register(nullFSDriver);
