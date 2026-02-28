/**
 * JSOS SDK — Item 790
 *
 * The JSOS SDK provides TypeScript type definitions, helpers, and tooling for
 * authoring JSOS applications and OS modules both from the host machine
 * (npm package scenario) and from within JSOS itself.
 *
 * This file is the main entry point for the in-OS SDK module at runtime.
 * For the npm package, this same module would be published to allow host-side
 * development with full type support.
 */

// ── Type re-exports for host-side authoring ───────────────────────────────────

/** JSOS kernel version string */
export const JSOS_VERSION = '1.0.0-alpha';

/** Application manifest (package.json-like descriptor for JSOS apps) */
export interface JSOSAppManifest {
  /** Unique reverse-domain identifier: com.example.myapp */
  id: string;
  /** Display name */
  name: string;
  version: string;
  /** Semver range of JSOS kernel required */
  jsosVersion: string;
  /** Entry point relative to the app directory */
  main: string;
  /** Requested permissions */
  permissions: JSOSPermission[];
  /** Application category for launcher */
  category?: 'system' | 'utility' | 'productivity' | 'game' | 'network' | 'media';
  /** Icon URL (relative or absolute) */
  icon?: string;
  description?: string;
  author?: string;
  license?: string;
}

/** Granular JSOS permission strings */
export type JSOSPermission =
  | 'fs.read'
  | 'fs.write'
  | 'net.connect'
  | 'net.listen'
  | 'process.spawn'
  | 'hardware.input'
  | 'hardware.display'
  | 'hardware.audio'
  | 'users.read'
  | 'users.write'
  | 'kernel.debug';

// ── App lifecycle hooks ───────────────────────────────────────────────────────

export interface AppLifecycle {
  /** Called when the app is first launched */
  onStart?(): void | Promise<void>;
  /** Called when the app is resumed from background */
  onResume?(): void | Promise<void>;
  /** Called when the app is sent to background */
  onPause?(): void | Promise<void>;
  /** Called before the app is terminated (cleanup) */
  onStop?(): void | Promise<void>;
  /** Called when the app receives an intent/IPC message */
  onMessage?(msg: unknown): void | Promise<void>;
}

// ── SDK Helper functions ──────────────────────────────────────────────────────

/** Register an app lifecycle handler */
export function registerApp(manifest: JSOSAppManifest, lifecycle: AppLifecycle): void {
  const registry = (globalThis as unknown as Record<string, unknown>).__jsosAppRegistry;
  if (typeof registry === 'object' && registry !== null && 'register' in registry) {
    (registry as { register: (m: JSOSAppManifest, l: AppLifecycle) => void }).register(manifest, lifecycle);
  }
  // Store in globalThis for hot-reload compatibility
  (globalThis as unknown as Record<string, unknown>).__currentApp = { manifest, lifecycle };
}

/** Get the current app's manifest */
export function getManifest(): JSOSAppManifest | null {
  return ((globalThis as unknown as Record<string, unknown>).__currentApp as { manifest?: JSOSAppManifest } | undefined)?.manifest ?? null;
}

// ── SDK Environment ───────────────────────────────────────────────────────────

export interface SDKEnvironment {
  version: string;
  arch: 'x86' | 'x86_64' | 'arm64' | 'wasm';
  kernel: {
    version: string;
    buildDate: string;
  };
  runtime: {
    jsEngine: 'quickjs' | 'v8' | 'hermes';
    heapSize: number;
  };
}

/** Get the current JSOS environment */
export function getEnvironment(): SDKEnvironment {
  const g = globalThis as unknown as Record<string, unknown>;
  return {
    version: JSOS_VERSION,
    arch: (g.__arch as SDKEnvironment['arch']) ?? 'x86',
    kernel: {
      version: (g.__kernelVersion as string) ?? '0.1.0',
      buildDate: (g.__kernelBuildDate as string) ?? '2026-01-01',
    },
    runtime: {
      jsEngine: (g.__jsEngine as SDKEnvironment['runtime']['jsEngine']) ?? 'quickjs',
      heapSize: (g.__heapSize as number) ?? 64 * 1024 * 1024,
    },
  };
}

// ── IPC helper ────────────────────────────────────────────────────────────────

export interface IPCMessage {
  from: string;
  to: string;
  type: string;
  payload: unknown;
  replyTo?: string;
}

export class IPCChannel {
  private _handlers = new Map<string, (msg: IPCMessage) => void>();
  private _appId: string;

  constructor(appId: string) { this._appId = appId; }

  on(type: string, handler: (msg: IPCMessage) => void): this {
    this._handlers.set(type, handler); return this;
  }

  off(type: string): this { this._handlers.delete(type); return this; }

  send(to: string, type: string, payload: unknown): void {
    const msg: IPCMessage = { from: this._appId, to, type, payload };
    const bus = (globalThis as unknown as Record<string, unknown>).__ipcBus;
    if (typeof bus === 'object' && bus !== null && 'dispatch' in bus) {
      (bus as { dispatch: (msg: IPCMessage) => void }).dispatch(msg);
    }
  }

  dispatch(msg: IPCMessage): void {
    const handler = this._handlers.get(msg.type) ?? this._handlers.get('*');
    handler?.(msg);
  }
}

// ── Storage helper ────────────────────────────────────────────────────────────

export class AppStorage {
  private _prefix: string;

  constructor(appId: string) { this._prefix = `/var/jsos/apps/${appId}/`; }

  async set(key: string, value: unknown): Promise<void> {
    const path = this._prefix + key + '.json';
    const json = JSON.stringify(value);
    const fs = (globalThis as unknown as Record<string, unknown>).fs;
    if (fs && typeof (fs as Record<string, unknown>).writeFile === 'function') {
      await (fs as { writeFile: (p: string, c: string) => Promise<void> }).writeFile(path, json);
    }
  }

  async get<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
    const path = this._prefix + key + '.json';
    try {
      const fs = (globalThis as unknown as Record<string, unknown>).fs;
      if (fs && typeof (fs as Record<string, unknown>).readFile === 'function') {
        const raw = await (fs as { readFile: (p: string) => Promise<string> }).readFile(path);
        return JSON.parse(raw) as T;
      }
    } catch { /* not found */ }
    return defaultValue;
  }

  async delete(key: string): Promise<void> {
    const path = this._prefix + key + '.json';
    const fs = (globalThis as unknown as Record<string, unknown>).fs;
    if (fs && typeof (fs as Record<string, unknown>).unlink === 'function') {
      await (fs as { unlink: (p: string) => Promise<void> }).unlink(path);
    }
  }
}

// ── Notification helper ───────────────────────────────────────────────────────

export interface Notification {
  title: string;
  body: string;
  icon?: string;
  timeout?: number;  // ms
  onClick?: () => void;
}

export function notify(n: Notification): void {
  const wm = (globalThis as unknown as Record<string, unknown>).__wm;
  if (wm && typeof (wm as Record<string, unknown>).showToast === 'function') {
    (wm as { showToast: (msg: string, t?: number) => void }).showToast(`${n.title}: ${n.body}`, n.timeout);
  }
}

// ── SDK singleton ─────────────────────────────────────────────────────────────

export const sdk = {
  version: JSOS_VERSION,
  getEnvironment,
  registerApp,
  getManifest,
  notify,
  createIPCChannel: (appId: string) => new IPCChannel(appId),
  createStorage: (appId: string) => new AppStorage(appId),
};

export default sdk;
