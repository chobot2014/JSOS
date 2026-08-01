/**
 * JSOS Browser Extensions + Sync — Items 640 + 641
 *
 * Item 640: BrowserSyncManager — bookmarks/history backup to a remote endpoint
 * Item 641: UserscriptEngine — @userscript runner with GM_* API stubs
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  folderId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface SyncCredentials {
  endpoint: string;  // e.g. "https://sync.example.com"
  token: string;
}

// ───────────────────────────────────────────────────────────────────────────────
//  Item 640 — BrowserSyncManager
// ───────────────────────────────────────────────────────────────────────────────

interface SyncDelta<T> {
  added: T[];
  updated: T[];
  deleted: string[];
  timestamp: number;
}

class BrowserSyncManager {
  private _lastSyncTs = 0;

  /**
   * Sync bookmarks bidirectionally with the remote endpoint.
   * Uses a simple "last-write-wins + delta" strategy.
   */
  async syncBookmarks(creds: SyncCredentials, local: Bookmark[]): Promise<Bookmark[]> {
    const delta = this._buildBookmarkDelta(local);
    const remote = await this._push(creds, 'bookmarks', delta);
    const merged = this._mergeBookmarks(local, remote as SyncDelta<Bookmark>);
    this._lastSyncTs = Date.now();
    return merged;
  }

  /**
   * Sync browsing history (upload only — history is not pulled from remote).
   */
  async syncHistory(creds: SyncCredentials, local: HistoryEntry[]): Promise<void> {
    const delta: SyncDelta<HistoryEntry> = {
      added: local.filter(e => e.visitedAt > this._lastSyncTs),
      updated: [],
      deleted: [],
      timestamp: Date.now(),
    };
    await this._push(creds, 'history', delta);
    this._lastSyncTs = Date.now();
  }

  /** Push a named collection delta to the remote endpoint. */
  async push<T>(creds: SyncCredentials, collection: string, items: T[]): Promise<void> {
    const delta: SyncDelta<T> = { added: items, updated: [], deleted: [], timestamp: Date.now() };
    await this._push(creds, collection, delta);
  }

  /** Pull the latest state of a named collection. */
  async pull<T>(creds: SyncCredentials, collection: string): Promise<T[]> {
    try {
      return await this._fetch<T>(creds, collection);
    } catch {
      return [];
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _buildBookmarkDelta(local: Bookmark[]): SyncDelta<Bookmark> {
    const added = local.filter(b => b.createdAt > this._lastSyncTs);
    const updated = local.filter(b => b.updatedAt > this._lastSyncTs && b.createdAt <= this._lastSyncTs);
    return { added, updated, deleted: [], timestamp: Date.now() };
  }

  private _mergeBookmarks(local: Bookmark[], remote: SyncDelta<Bookmark>): Bookmark[] {
    const map = new Map<string, Bookmark>();
    for (const b of local) map.set(b.id, b);
    // Apply remote additions / updates
    for (const b of [...remote.added, ...remote.updated]) {
      const existing = map.get(b.id);
      if (!existing || b.updatedAt >= existing.updatedAt) map.set(b.id, b);
    }
    // Apply remote deletions
    for (const id of remote.deleted) map.delete(id);
    return Array.from(map.values());
  }

  private async _push<T>(creds: SyncCredentials, collection: string, delta: SyncDelta<T>): Promise<unknown> {
    const body = JSON.stringify(delta);
    const url = `${creds.endpoint}/api/sync/${collection}`;
    const resp = await (globalThis as any).fetch?.(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!resp?.ok) throw new Error(`Sync push failed: ${resp?.status}`);
    return resp.json();
  }

  private async _fetch<T>(creds: SyncCredentials, collection: string): Promise<T[]> {
    const url = `${creds.endpoint}/api/sync/${collection}?since=${this._lastSyncTs}`;
    const resp = await (globalThis as any).fetch?.(url, {
      headers: { 'Authorization': `Bearer ${creds.token}` },
    });
    if (!resp?.ok) throw new Error(`Sync pull failed: ${resp?.status}`);
    return resp.json() as Promise<T[]>;
  }

  /** Serialize sync state to JSON string for VFS storage */
  serialize(bookmarks: Bookmark[], history: HistoryEntry[]): string {
    return JSON.stringify({ bookmarks, history, lastSyncTs: this._lastSyncTs });
  }

  /** Restore sync state from JSON string */
  deserialize(json: string): { bookmarks: Bookmark[]; history: HistoryEntry[] } {
    try {
      const parsed = JSON.parse(json);
      this._lastSyncTs = parsed.lastSyncTs ?? 0;
      return { bookmarks: parsed.bookmarks ?? [], history: parsed.history ?? [] };
    } catch {
      return { bookmarks: [], history: [] };
    }
  }
}

export const browserSync = new BrowserSyncManager();

// ───────────────────────────────────────────────────────────────────────────────
//  Item 641 — UserscriptEngine
// ───────────────────────────────────────────────────────────────────────────────

/** Parsed Greasemonkey/Violentmonkey/Tampermonkey manifest block */
export interface UserscriptManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  include: string[];
  exclude: string[];
  match: string[];
  require: string[];
  grant: string[];
  runAt: 'document-start' | 'document-body' | 'document-end' | 'document-idle';
  noframes?: boolean;
  sandbox?: string;
}

export interface RegisteredUserscript {
  id: string;
  manifest: UserscriptManifest;
  code: string;
  enabled: boolean;
}

/** GM_* value store (per-script) */
export type GMStorage = Map<string, string>;

/** Minimal GM API surface presented to each script */
export interface GMApi {
  GM_getValue(key: string, defaultValue?: string): string | undefined;
  GM_setValue(key: string, value: string): void;
  GM_deleteValue(key: string): void;
  GM_listValues(): string[];
  GM_xmlhttpRequest(details: GMXhrDetails): void;
  GM_openInTab(url: string, options?: { active?: boolean }): void;
  GM_notification(text: string, title?: string): void;
  GM_setClipboard(text: string): void;
  GM_log(...args: unknown[]): void;
  GM_info: { script: UserscriptManifest; scriptMetaStr: string };
  unsafeWindow: typeof globalThis;
}

export interface GMXhrDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  onload?: (resp: { status: number; responseText: string; responseHeaders: string }) => void;
  onerror?: (err: { error: string }) => void;
}

export class UserscriptEngine {
  private _scripts = new Map<string, RegisteredUserscript>();
  private _storage = new Map<string, GMStorage>(); // scriptId → key-value store
  private _nextId = 1;

  /** Parse the ==UserScript== block from raw script source */
  parseManifest(source: string): UserscriptManifest {
    const meta: UserscriptManifest = {
      name: 'Unnamed Script',
      version: '1.0',
      include: [],
      exclude: [],
      match: [],
      require: [],
      grant: [],
      runAt: 'document-end',
    };
    const block = source.match(/==UserScript==([\s\S]*?)==\/UserScript==/);
    if (!block) return meta;
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*\/\/\s*@(\S+)\s+(.*)\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      switch (key) {
        case 'name': meta.name = value; break;
        case 'version': meta.version = value; break;
        case 'description': meta.description = value; break;
        case 'author': meta.author = value; break;
        case 'include': meta.include.push(value); break;
        case 'exclude': meta.exclude.push(value); break;
        case 'match': meta.match.push(value); break;
        case 'require': meta.require.push(value); break;
        case 'grant': meta.grant.push(value); break;
        case 'run-at':
        case 'runAt':
          meta.runAt = value as UserscriptManifest['runAt']; break;
        case 'noframes': meta.noframes = true; break;
        case 'sandbox': meta.sandbox = value; break;
      }
    }
    return meta;
  }

  /** Register a userscript (manifest may be omitted and parsed from code) */
  registerScript(code: string, manifest?: UserscriptManifest): string {
    const m = manifest ?? this.parseManifest(code);
    const id = `script-${this._nextId++}`;
    this._scripts.set(id, { id, manifest: m, code, enabled: true });
    this._storage.set(id, new Map());
    return id;
  }

  unregisterScript(id: string): boolean { return this._scripts.delete(id); }
  enableScript(id: string, enabled: boolean): void {
    const s = this._scripts.get(id);
    if (s) s.enabled = enabled;
  }

  listScripts(): RegisteredUserscript[] { return Array.from(this._scripts.values()); }

  /**
   * Return whether the script matches the given URL.
   * Supports @match / @include patterns with glob-like * and wildcards.
   */
  matchUrl(pattern: string, url: string): boolean {
    // Convert glob/userscript pattern to regex
    if (pattern === '*' || pattern === '<all_urls>') return true;
    // @match pattern: scheme://hostname/path with * wildcards
    try {
      const regStr = '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$';
      return new RegExp(regStr).test(url);
    } catch {
      return false;
    }
  }

  /** Check if a script should run on the current URL */
  shouldRun(script: RegisteredUserscript, url: string): boolean {
    if (!script.enabled) return false;
    const { include, exclude, match } = script.manifest;
    // Exclude overrides everything
    if (exclude.some(p => this.matchUrl(p, url))) return false;
    // Must match at least one include/match
    const patterns = [...include, ...match];
    if (patterns.length === 0) return true; // no restriction
    return patterns.some(p => this.matchUrl(p, url));
  }

  /**
   * Execute all enabled scripts that match the given URL.
   * Scripts are sandboxed via `new Function(...)` closures.
   */
  async runMatchingScripts(url: string, docWindow?: typeof globalThis): Promise<void> {
    for (const script of this._scripts.values()) {
      if (!this.shouldRun(script, url)) continue;
      try {
        await this._execute(script, docWindow ?? globalThis);
      } catch (err) {
        console.error(`[UserscriptEngine] Error in "${script.manifest.name}":`, err);
      }
    }
  }

  /** Execute a single script */
  private async _execute(script: RegisteredUserscript, win: typeof globalThis): Promise<void> {
    const gmApi = this._buildGMApi(script, win);
    const args = Object.keys(gmApi);
    const vals = Object.values(gmApi);

    // Strip the ==UserScript== header comment before executing
    const code = script.code.replace(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/m, '');

    // Wrap in IIFE, inject GM_ globals as parameters
    const wrapped = [
      '(async function(' + args.join(', ') + ') {',
      '"use strict";',
      code,
      '})(' + args.map((_, i) => '__gmVals[' + i + ']').join(', ') + ')',
    ].join('\n');

    try {
      const fn = new Function('__gmVals', wrapped);
      await fn(vals);
    } catch (err) {
      throw new Error(`Script "${script.manifest.name}" execution error: ${err}`);
    }
  }

  private _buildGMApi(script: RegisteredUserscript, win: typeof globalThis): GMApi {
    const store = this._storage.get(script.id) ?? new Map<string, string>();

    return {
      GM_getValue: (key: string, def?: string) => store.get(key) ?? def,
      GM_setValue: (key: string, value: string) => { store.set(key, String(value)); },
      GM_deleteValue: (key: string) => { store.delete(key); },
      GM_listValues: () => Array.from(store.keys()),
      GM_xmlhttpRequest: (details: GMXhrDetails) => {
        const method = details.method ?? 'GET';
        const fetchFn = (win as any).fetch ?? (globalThis as any).fetch;
        if (!fetchFn) { details.onerror?.({ error: 'fetch not available' }); return; }
        fetchFn(details.url, { method, headers: details.headers, body: details.data })
          .then(async (resp: any) => {
            const text = await resp.text();
            const headers = Array.from(resp.headers?.entries?.() ?? [])
              .map(([k, v]: [string, string]) => `${k}: ${v}`)
              .join('\r\n');
            details.onload?.({ status: resp.status, responseText: text, responseHeaders: headers });
          })
          .catch((e: unknown) => details.onerror?.({ error: String(e) }));
      },
      GM_openInTab: (url: string, _opts?: { active?: boolean }) => {
        // JSOS: signal browser to open new tab
        (win as any).__jsosOpenTab?.(url);
      },
      GM_notification: (text: string, title?: string) => {
        console.log(`[GM_notification] ${title ?? ''}: ${text}`);
      },
      GM_setClipboard: (text: string) => {
        (win as any).navigator?.clipboard?.writeText?.(text);
      },
      GM_log: (...args: unknown[]) => console.log('[GM_log]', ...args),
      GM_info: {
        script: script.manifest,
        scriptMetaStr: `// ==UserScript==\n// @name ${script.manifest.name}\n// ==/UserScript==`,
      },
      unsafeWindow: win,
    };
  }

  /** Serialize all scripts + storage to JSON (for VFS persistence) */
  serialize(): string {
    const scripts: Array<{
      id: string; manifest: UserscriptManifest; code: string; enabled: boolean;
      storage: Array<[string, string]>;
    }> = [];
    for (const [id, script] of this._scripts) {
      const store = this._storage.get(id) ?? new Map();
      scripts.push({ ...script, storage: Array.from(store.entries()) });
    }
    return JSON.stringify({ scripts, nextId: this._nextId });
  }

  /** Restore from JSON */
  deserialize(json: string): void {
    try {
      const data = JSON.parse(json);
      this._nextId = data.nextId ?? 1;
      for (const s of data.scripts ?? []) {
        this._scripts.set(s.id, { id: s.id, manifest: s.manifest, code: s.code, enabled: s.enabled });
        this._storage.set(s.id, new Map(s.storage ?? []));
      }
    } catch {
      // ignore parse errors
    }
  }
}

export const userscriptEngine = new UserscriptEngine();

// ── Extension API surface ─────────────────────────────────────────────────────

/** Minimal chrome.* / browser.* extension API stub */
export const chromeExtensionAPI = {
  storage: {
    local: {
      _data: new Map<string, unknown>(),
      get(keys: string | string[], cb?: (result: Record<string, unknown>) => void): void {
        const ks = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const k of ks) result[k] = chromeExtensionAPI.storage.local._data.get(k);
        cb?.(result);
      },
      set(items: Record<string, unknown>, cb?: () => void): void {
        for (const [k, v] of Object.entries(items)) chromeExtensionAPI.storage.local._data.set(k, v);
        cb?.();
      },
      remove(keys: string | string[], cb?: () => void): void {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) chromeExtensionAPI.storage.local._data.delete(k);
        cb?.();
      },
    },
    sync: {
      get: (_k: unknown, cb?: (r: Record<string, unknown>) => void) => cb?.({}),
      set: (_i: unknown, cb?: () => void) => cb?.(),
    },
  },
  tabs: {
    query(_filter: unknown, cb: (tabs: unknown[]) => void): void { cb([]); },
    create(props: { url?: string }): void { console.log('[chrome.tabs.create]', props.url); },
    sendMessage(_tabId: number, _msg: unknown, cb?: (resp: unknown) => void): void { cb?.(null); },
  },
  runtime: {
    id: 'jsos-extension',
    sendMessage(_msg: unknown, cb?: (resp: unknown) => void): void { cb?.(null); },
    onMessage: {
      _listeners: [] as Array<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void>,
      addListener(fn: (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void): void {
        chromeExtensionAPI.runtime.onMessage._listeners.push(fn);
      },
    },
    getManifest(): unknown { return { name: 'JSOS Ext', version: '1.0' }; },
  },
  notifications: {
    create(_id: string, options: { title: string; message: string }): void {
      console.log(`[chrome.notifications] ${options.title}: ${options.message}`);
    },
  },
};

export const browserExt = {
  browserSync,
  userscriptEngine,
  chromeExtensionAPI,
};
