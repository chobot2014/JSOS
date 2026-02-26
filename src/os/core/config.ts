/**
 * JSOS System Configuration (items 920, 924)
 *
 * Loads /etc/config.json on first access; provides typed get/set API.
 * All OS components can import { config } from './config.js' to read
 * machine-level settings (hostname, locale, timezone, display resolution, …).
 *
 * Default values are merged over the file so the OS always boots even when
 * the config file is absent or partially populated.
 *
 * Architecture constraint: no C code — pure TypeScript, VFS-backed.
 */

import fs from '../fs/filesystem.js';

/** Default machine configuration shipped with the OS image. */
const DEFAULTS: Record<string, unknown> = {
  hostname:   'jsos-machine',
  locale:     'en-US',
  timezone:   'UTC',
  keymap:     'us',
  screenW:    1024,
  screenH:    768,
  colorDepth: 32,
  dnsServers: ['8.8.8.8', '8.8.4.4'],
  ntpServer:  'pool.ntp.org',
  logLevel:   'info',
  autoLogin:  '',
};

const CONFIG_PATH = '/etc/config.json';
const FSTAB_PATH  = '/etc/fstab.json';

/** Default /etc/fstab.json – in-memory VFS only for now. */
const DEFAULT_FSTAB = [
  { device: 'rootfs', mountpoint: '/',     fstype: 'jsfs', options: 'rw' },
  { device: 'tmpfs',  mountpoint: '/tmp',  fstype: 'tmpfs', options: 'rw,noexec' },
  { device: 'devfs',  mountpoint: '/dev',  fstype: 'devfs', options: 'ro' },
  { device: 'procfs', mountpoint: '/proc', fstype: 'procfs', options: 'ro' },
];

type ConfigValue = string | number | boolean | string[] | null;

class SystemConfig {
  private _data: Record<string, unknown> = {};
  private _loaded = false;

  /** Ensure config is loaded from VFS (lazy, called on first access). */
  private _ensureLoaded(): void {
    if (this._loaded) return;
    this._loaded = true;
    // Merge defaults first
    for (var k in DEFAULTS) this._data[k] = DEFAULTS[k];
    // Try to load from VFS
    try {
      var raw = fs.readFile(CONFIG_PATH);
      if (raw) {
        var parsed = JSON.parse(raw) as Record<string, unknown>;
        for (var key in parsed) this._data[key] = parsed[key];
      }
    } catch (_) {}
    // Bootstrap fstab if not present
    try {
      if (!fs.readFile(FSTAB_PATH)) {
        this._mkdirSafe('/etc');
        fs.writeFile(FSTAB_PATH, JSON.stringify(DEFAULT_FSTAB, null, 2));
      }
    } catch (_) {}
  }

  private _mkdirSafe(path: string): void {
    try { fs.mkdir(path); } catch (_) {}
  }

  /**
   * Read a config value.
   * @param key    Dot-separated key path (e.g. 'network.dns.primary')
   * @param def    Default value if key is absent
   */
  get<T extends ConfigValue = string>(key: string, def?: T): T {
    this._ensureLoaded();
    var parts = key.split('.');
    var node: unknown = this._data;
    for (var i = 0; i < parts.length; i++) {
      if (node === null || typeof node !== 'object') return def as T;
      node = (node as Record<string, unknown>)[parts[i]];
    }
    return (node !== undefined ? node : def) as T;
  }

  /**
   * Write a config value and persist to /etc/config.json.
   * Supports dot-separated nested keys.
   */
  set(key: string, value: ConfigValue): void {
    this._ensureLoaded();
    var parts = key.split('.');
    var node = this._data;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
        node[parts[i]] = {};
      }
      node = node[parts[i]] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
    this._persist();
  }

  /** Return a shallow copy of all config entries. */
  getAll(): Record<string, unknown> {
    this._ensureLoaded();
    return { ...this._data };
  }

  /** Remove a key from config and persist. */
  delete(key: string): void {
    this._ensureLoaded();
    delete this._data[key];
    this._persist();
  }

  /** Force reload from /etc/config.json. */
  reload(): void {
    this._loaded = false;
    this._ensureLoaded();
  }

  private _persist(): void {
    try {
      this._mkdirSafe('/etc');
      fs.writeFile(CONFIG_PATH, JSON.stringify(this._data, null, 2));
    } catch (_) {}
  }
}

/** Singleton machine configuration instance. */
export var config = new SystemConfig();

/** Convenience: get the machine hostname. */
export function getHostname(): string {
  return config.get<string>('hostname', 'jsos-machine');
}

/** Convenience: get the configured DNS server list. */
export function getDnsServers(): string[] {
  return config.get<string[]>('dnsServers', ['8.8.8.8', '8.8.4.4']);
}

/** Convenience: get the timezone string (IANA format). */
export function getTimezone(): string {
  return config.get<string>('timezone', 'UTC');
}
