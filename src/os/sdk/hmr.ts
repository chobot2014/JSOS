/**
 * JSOS Hot Module Replacement — Item 802
 *
 * HMR enables live-reload of TypeScript modules within a running JSOS instance
 * without requiring a full system restart.
 *
 * Architecture:
 *   FileWatcher → detects changed .ts files
 *   Transpiler  → compiles changed module to JS
 *   ModuleReloader → patches the live module registry + notifies subscribers
 *   HMRBoundary → per-module accept() callbacks (like webpack HMR API)
 *
 * Module invalidation propagates up the dependency graph until a boundary
 * (a module that called hmr.accept()) absorbs the update.
 */

import { transpileTS, buildModuleGraph } from './build.js';

// ── File watcher ──────────────────────────────────────────────────────────────

interface WatchEvent {
  type: 'create' | 'modify' | 'delete';
  path: string;
  timestamp: number;
}

type WatchHandler = (events: WatchEvent[]) => void;

class FileWatcher {
  private _watched = new Set<string>();
  private _handlers: WatchHandler[] = [];
  private _pollInterval: ReturnType<typeof setInterval> | null = null;
  private _snapshots = new Map<string, number>(); // path → mtime

  private _readMtime: (path: string) => number;

  constructor(readMtime: (path: string) => number) {
    this._readMtime = readMtime;
  }

  watch(path: string): void {
    this._watched.add(path);
    try { this._snapshots.set(path, this._readMtime(path)); } catch { /* */ }
  }

  unwatch(path: string): void { this._watched.delete(path); this._snapshots.delete(path); }

  onEvent(handler: WatchHandler): void { this._handlers.push(handler); }

  start(intervalMs = 500): void {
    if (this._pollInterval) return;
    this._pollInterval = setInterval(() => this._poll(), intervalMs);
  }

  stop(): void {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
  }

  private _poll(): void {
    const events: WatchEvent[] = [];
    for (const path of this._watched) {
      let mtime = 0;
      try { mtime = this._readMtime(path); } catch { /* deleted */ }
      const prev = this._snapshots.get(path) ?? -1;
      if (mtime === 0 && prev > 0) {
        events.push({ type: 'delete', path, timestamp: Date.now() });
        this._snapshots.delete(path);
      } else if (mtime > 0 && prev === -1) {
        events.push({ type: 'create', path, timestamp: Date.now() });
        this._snapshots.set(path, mtime);
      } else if (mtime !== prev) {
        events.push({ type: 'modify', path, timestamp: Date.now() });
        this._snapshots.set(path, mtime);
      }
    }
    if (events.length > 0) for (const h of this._handlers) h(events);
  }
}

// ── Module registry ───────────────────────────────────────────────────────────

interface LiveModule {
  path: string;
  exports: Record<string, unknown>;
  hotData: Record<string, unknown>;  // persistent data across reloads
  acceptHandlers: Array<(newExports: Record<string, unknown>) => void>;
  deps: string[];
  dependents: Set<string>;          // inverse dependency edge
}

class ModuleRegistry {
  private _modules = new Map<string, LiveModule>();

  register(path: string, deps: string[] = []): LiveModule {
    if (!this._modules.has(path)) {
      this._modules.set(path, {
        path, exports: {}, hotData: {}, acceptHandlers: [], deps, dependents: new Set(),
      });
      // Build inverse edges
      for (const dep of deps) {
        const depMod = this._modules.get(dep);
        if (depMod) depMod.dependents.add(path);
      }
    }
    return this._modules.get(path)!;
  }

  get(path: string): LiveModule | undefined { return this._modules.get(path); }

  /** Topological invalidation: return set of modules that need reload */
  invalidate(changedPath: string): string[] {
    const toReload = new Set<string>();
    const queue: string[] = [changedPath];
    while (queue.length) {
      const p = queue.shift()!;
      if (toReload.has(p)) continue;
      toReload.add(p);
      const mod = this._modules.get(p);
      if (!mod) continue;
      // Propagate to dependents UNLESS this module has an accept() boundary
      if (mod.acceptHandlers.length === 0 || p !== changedPath) {
        for (const dep of mod.dependents) queue.push(dep);
      }
    }
    return [...toReload];
  }

  all(): string[] { return [...this._modules.keys()]; }
}

// ── HMR API (module-side) ─────────────────────────────────────────────────────

export interface HMRContext {
  /** Accept updates for this module (hot boundary) */
  accept(callback?: (newExports: Record<string, unknown>) => void): void;
  /** Accept updates from a specific dependency */
  acceptDep(dep: string, callback: (newExports: Record<string, unknown>) => void): void;
  /** Invalidate this module (force full reload) */
  invalidate(): void;
  /** Dispose — run cleanup before module is replaced */
  dispose(callback: () => void): void;
  /** Persistent data that survives hot reloads */
  readonly data: Record<string, unknown>;
}

// ── HMR Engine ────────────────────────────────────────────────────────────────

interface HMRConfig {
  readFile: (path: string) => string | null;
  readMtime: (path: string) => number;
  evalModule: (code: string, path: string, exports: Record<string, unknown>) => void;
}

export class HMREngine {
  private _registry = new ModuleRegistry();
  private _watcher: FileWatcher;
  private _cfg: HMRConfig;
  private _disposeCallbacks = new Map<string, Array<() => void>>();
  private _acceptDepCallbacks = new Map<string, Map<string, (e: Record<string, unknown>) => void>>();
  private _stats = { updates: 0, failures: 0, lastUpdate: 0 };

  constructor(cfg: HMRConfig) {
    this._cfg = cfg;
    this._watcher = new FileWatcher(cfg.readMtime);
    this._watcher.onEvent(events => {
      for (const ev of events) {
        if (ev.type !== 'delete') this._handleChange(ev.path);
      }
    });
  }

  /** Register a module with the HMR engine */
  registerModule(path: string, deps: string[] = []): HMRContext {
    const mod = this._registry.register(path, deps);
    this._watcher.watch(path);
    for (const dep of deps) this._watcher.watch(dep);

    const self = this;
    const ctx: HMRContext = {
      accept(callback) {
        if (callback) mod.acceptHandlers.push(callback);
        else mod.acceptHandlers.push(() => {});  // boundary with no callback = accept silently
      },
      acceptDep(dep, callback) {
        const resolved = dep.startsWith('/') ? dep : dep;
        let depMap = self._acceptDepCallbacks.get(path);
        if (!depMap) { depMap = new Map(); self._acceptDepCallbacks.set(path, depMap); }
        depMap.set(resolved, callback);
      },
      invalidate() {
        self._handleChange(path);
      },
      dispose(callback) {
        let list = self._disposeCallbacks.get(path);
        if (!list) { list = []; self._disposeCallbacks.set(path, list); }
        list.push(callback);
      },
      get data() { return mod.hotData; },
    };
    return ctx;
  }

  private async _handleChange(path: string): Promise<void> {
    const toReload = this._registry.invalidate(path);
    console.log(`[HMR] ${path} changed → reloading ${toReload.length} module(s)`);

    for (const modPath of toReload) {
      const mod = this._registry.get(modPath);
      if (!mod) continue;

      // Run dispose callbacks
      const disposeList = this._disposeCallbacks.get(modPath) ?? [];
      for (const fn of disposeList) { try { fn(); } catch { /* */ } }

      // Read and transpile new source
      const source = this._cfg.readFile(modPath);
      if (!source) { console.warn(`[HMR] Could not read ${modPath}`); this._stats.failures++; continue; }

      let js: string;
      try { js = transpileTS(source); } catch (e) {
        console.error(`[HMR] Transpile error in ${modPath}:`, e);
        this._stats.failures++;
        continue;
      }

      // Keep hotData across reload (persistent state)
      const prevHotData = mod.hotData;
      const newExports: Record<string, unknown> = {};

      try {
        this._cfg.evalModule(js, modPath, newExports);
      } catch (e) {
        console.error(`[HMR] Runtime error in ${modPath} after HMR:`, e);
        this._stats.failures++;
        continue;
      }

      // Notify accept handlers
      for (const handler of mod.acceptHandlers) {
        try { handler(newExports); } catch (e) { console.error('[HMR] accept handler failed:', e); }
      }

      // Notify dependents via acceptDep
      for (const dependent of mod.dependents) {
        const depMap = this._acceptDepCallbacks.get(dependent);
        const cb = depMap?.get(modPath);
        if (cb) { try { cb(newExports); } catch { /* */ } }
      }

      // Update registry
      Object.assign(mod.exports, newExports);
      mod.hotData = prevHotData;  // restore persistent data
    }

    this._stats.updates++;
    this._stats.lastUpdate = Date.now();
  }

  start(pollIntervalMs = 500): void { this._watcher.start(pollIntervalMs); }
  stop(): void { this._watcher.stop(); }

  get stats(): { updates: number; failures: number; lastUpdate: number } {
    return { ...this._stats };
  }

  watch(path: string): void { this._watcher.watch(path); }
}

// ── Global HMR instance ───────────────────────────────────────────────────────

const _defaultReadMtime = (path: string): number => {
  try {
    const fs = (globalThis as unknown as Record<string, unknown>).fs;
    if (fs && typeof (fs as Record<string, unknown>).statSync === 'function') {
      return ((fs as { statSync: (p: string) => { mtime: number } }).statSync(path)).mtime;
    }
  } catch { /* */ }
  return Date.now();
};

const _defaultReadFile = (path: string): string | null => {
  try {
    const fs = (globalThis as unknown as Record<string, unknown>).fs;
    if (fs && typeof (fs as Record<string, unknown>).readFileSync === 'function') {
      return (fs as { readFileSync: (p: string) => string }).readFileSync(path);
    }
  } catch { /* */ }
  return null;
};

const _defaultEvalModule = (code: string, path: string, exports: Record<string, unknown>): void => {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('exports', '__filename', code + '\n//# sourceURL=' + path);
    fn(exports, path);
  } catch (e) {
    console.error('[HMR] eval error:', e);
  }
};

export const hmr = new HMREngine({
  readFile:   _defaultReadFile,
  readMtime:  _defaultReadMtime,
  evalModule: _defaultEvalModule,
});

/** Convenience: create an HMR context for a module */
export function createHMRContext(path: string, deps: string[] = []): HMRContext {
  return hmr.registerModule(path, deps);
}
