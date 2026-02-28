/**
 * jsruntime.ts — JavaScript execution engine for the JSOS browser
 *
 * After the HTML parser collects <script> tags, this module:
 *  1. Builds a virtual DOM from the raw HTML (dom.ts)
 *  2. Constructs a browser-like global context (window, document, console, …)
 *  3. Executes each script via eval() inside that context
 *  4. Wires on* HTML attributes (onclick="foo()") to runtime eval handlers
 *  5. Provides a PageJS handle that BrowserApp uses to fire events (click, input,
 *     change, keydown) back into running scripts, and detects mutations for re-render
 *
 *  All I/O goes through callbacks passed by BrowserApp, keeping this module
 *  decoupled from the OS layer.
 */

import { os } from '../../core/sdk.js';
import type { FetchResponse } from '../../core/sdk.js';
import {
  VDocument, VElement, VEvent, VNode, VText, VRange, VEventTarget,
  buildDOM, serializeDOM, _serializeEl, _walk, _matchSel,
} from './dom.js';
import { BrowserPerformance, BrowserPerformanceObserver } from './perf.js';
import { WorkerImpl, SharedWorkerImpl, MessageChannel, BroadcastChannelImpl, tickAllWorkers } from './workers.js';
import { cookieJar } from '../../net/http.js';
import { getCachedStyle, setCachedStyle, bumpStyleGeneration, currentStyleGeneration } from './cache.js';

// ── Script record (collected by html.ts during parsing) ───────────────────────

export interface ScriptRecord {
  inline: boolean;
  src:    string;   // for external scripts — absolute or root-relative URL
  code:   string;   // for inline scripts — the source text
  type:   string;   // mime-type, default 'text/javascript'
}

// ── Callbacks from BrowserApp into the runtime ────────────────────────────────

export interface PageCallbacks {
  navigate(url: string): void;
  setTitle(title: string): void;
  alert(msg: string): void;
  confirm(msg: string): boolean;
  prompt(msg: string, def: string): string;
  /** Re-parse and re-layout the page with the new HTML body. */
  rerender(bodyHTML: string): void;
  /** Write a line to the OS debug console (forward console.log etc.) */
  log(msg: string): void;
  /** Read or write the widget value for the given element id. */
  getWidgetValue(id: string): string | undefined;
  setWidgetValue(id: string, value: string): void;
  /** Get current scroll position */
  getScrollY(): number;
  /** Set scroll position */
  scrollTo(x: number, y: number): void;
  /** Base URL for resolving relative external script URLs */
  baseURL: string;
}

// ── PageJS handle returned to BrowserApp ─────────────────────────────────────

export interface PageJS {
  /** Fire a UI event from BrowserApp into the JS page. Returns true if re-render needed. */
  fireClick(id: string): boolean;
  fireChange(id: string, newValue: string): boolean;
  fireInput(id: string, newValue: string): boolean;
  fireKeydown(id: string, key: string, keyCode: number): boolean;
  fireSubmit(formId: string): boolean;
  fireLoad(): boolean;
  /** [Item 950] Fire resize event and trigger media query listeners whose match state changed. */
  fireResize(width: number, height: number): boolean;
  /** Called when the page is unloaded — fires beforeunload */
  dispose(): void;
  /** Synchronously tick any pending timers (called on each render frame) */
  tick(nowMs: number): void;
}

// ── Timer state ───────────────────────────────────────────────────────────────

interface TimerEntry {
  id:       number;
  fn:       () => void;
  fireAt:   number;   // ms timestamp
  interval: boolean;
  delay:    number;
}

// ── Storage (per-origin, in-memory + optional VFS persistence) ───────────────

class VStorage {
  _data: Map<string, string> = new Map();
  _path: string = '';   // set to VFS path to enable persistence
  /** Called with (key, oldValue, newValue) when items change; null for clear(). */
  _listener: ((key: string | null, old: string | null, nxt: string | null) => void) | null = null;

  /** Load from VFS. Silently no-ops if path not set or file missing. */
  _load(): void {
    if (!this._path) return;
    try {
      var raw = os.fs.read(this._path);
      if (!raw) return;
      var obj = JSON.parse(raw);
      this._data.clear();
      for (var k in obj) {
        if (typeof k === 'string' && typeof obj[k] === 'string') {
          this._data.set(k, obj[k]);
        }
      }
    } catch (_) {}
  }

  /** Persist current data to VFS. Silently no-ops if path not set. */
  _save(): void {
    if (!this._path) return;
    try {
      var obj: Record<string, string> = {};
      this._data.forEach((v, k) => { obj[k] = v; });
      // Ensure parent directory exists
      var dir = this._path.slice(0, this._path.lastIndexOf('/'));
      if (dir) try { os.fs.mkdir(dir); } catch (_) {}
      os.fs.write(this._path, JSON.stringify(obj));
    } catch (_) {}
  }

  get length(): number { return this._data.size; }
  setItem(k: string, v: string): void {
    var sk = String(k), sv = String(v);
    var old = this._data.get(sk) ?? null;
    this._data.set(sk, sv); this._save();
    if (old !== sv) try { this._listener?.(sk, old, sv); } catch (_) {}
  }
  getItem(k: string): string | null { return this._data.get(String(k)) ?? null; }
  removeItem(k: string): void {
    var sk = String(k);
    var old = this._data.get(sk) ?? null;
    this._data.delete(sk); this._save();
    if (old !== null) try { this._listener?.(sk, old, null); } catch (_) {}
  }
  clear(): void {
    this._data.clear(); this._save();
    try { this._listener?.(null, null, null); } catch (_) {}
  }
  key(n: number): string | null { return [...this._data.keys()][n] ?? null; }
}

var _localStorage  = new VStorage();
var _sessionStorage = new VStorage();

// ── Blob object URL store (item 639) ─────────────────────────────────────────
// Maps blob: URLs → { content: string; type: string }
var _blobStore = new Map<string, { content: string; type: string }>();

/**
 * Look up the content of a blob: URL created via URL.createObjectURL().
 * Returns null if the URL is not found or has been revoked.
 */
export function getBlobURLContent(url: string): { content: string; type: string } | null {
  return _blobStore.get(url) ?? null;
}

// ── Main factory ──────────────────────────────────────────────────────────────

export function createPageJS(
  fullHTML:  string,
  scripts:   ScriptRecord[],
  cb:        PageCallbacks,
): PageJS | null {

  // Skip pages with no JS
  if (scripts.length === 0) return null;

  // ── Initialise per-origin localStorage (item 500) ─────────────────────────
  // Derive a VFS-safe origin key from the base URL (e.g. "http_example.com_80")
  try {
    var _originURL  = new URL(cb.baseURL);
    var _originKey  = (_originURL.protocol.replace(':', '') + '_' +
                       _originURL.hostname + '_' +
                       (_originURL.port || (_originURL.protocol === 'https:' ? '443' : '80')))
                      .replace(/[^a-zA-Z0-9_.-]/g, '_');
    var _lsPath = '/user/localStorage/' + _originKey + '.json';
    if (_localStorage._path !== _lsPath) {
      _localStorage._data.clear();
      _localStorage._path = _lsPath;
      _localStorage._load();
    }
  } catch (_) {
    // Non-URL base (e.g. file:///...) — in-memory only
    _localStorage._path = '';
    _localStorage._data.clear();
  }
  // sessionStorage is always cleared on new page load (session-scoped)
  _sessionStorage._data.clear();
  _sessionStorage._path = '';

  // Build virtual DOM from the full page HTML
  var doc = buildDOM(fullHTML);
  // document.readyState transitions (item 531): 'loading' → 'interactive' → 'complete'
  (doc as any)._readyState = 'loading';
  // document.compatMode (item 864) — always standards mode
  (doc as any).compatMode = 'CSS1Compat';
  // document.documentMode (item 867) — IE compat shim: return 11 (IE11 compat)
  (doc as any).documentMode = 11;
  (doc as any).characterSet = 'UTF-8';
  (doc as any).charset = 'UTF-8';
  // doc._styleSheets populated later after CSSStyleSheet_ class is defined

  // ── <base href> support (item 364) ───────────────────────────────────────
  // Extract effective base URL from <base href="..."> if present in the document.
  var _baseHref: string = cb.baseURL;
  {
    var _baseEl = doc.querySelector('base[href]') as any;
    if (_baseEl) {
      var _bh = _baseEl.getAttribute('href');
      if (_bh) {
        // Resolve against page URL in case it is relative
        try { _baseHref = new URL(_bh, cb.baseURL).href; } catch(_) { _baseHref = _bh; }
      }
    }
  }

  var timers: TimerEntry[] = [];
  var timerSeq = 1;
  var startTime = Date.now();

  function setTimeout_(fn: () => void, delay: number): number {
    var id = timerSeq++;
    timers.push({ id, fn, fireAt: Date.now() - startTime + Math.max(0, delay), interval: false, delay });
    return id;
  }
  function setInterval_(fn: () => void, delay: number): number {
    var id = timerSeq++;
    timers.push({ id, fn, fireAt: Date.now() - startTime + Math.max(1, delay), interval: true, delay: Math.max(1, delay) });
    return id;
  }
  function clearTimeout_(id: number): void { timers = timers.filter(t => t.id !== id); }
  function clearInterval_(id: number): void { clearTimeout_(id); }

  // Mutation flag — reset after re-render check
  var needsRerender = false;
  function checkDirty(): void {
    if (doc._dirty) {
      doc._dirty = false;
      needsRerender = true;
      // Flush queued mutation records (or a synthetic fallback if none)
      var records = doc._mutationQueue.length > 0
        ? doc._mutationQueue.splice(0)
        : [{ type: 'childList', target: doc, addedNodes: [], removedNodes: [] }];
      _flushMutationObservers(records);
    }
  }

  // Re-render helper
  function doRerender(): void {
    needsRerender = false;
    // Update title if changed
    if (doc.title) cb.setTitle(doc.title);
    cb.rerender(serializeDOM(doc));
    // Rebuild the DOM from the new HTML so subsequent JS keeps working
    // (we keep the existing doc object but sync values back from serialized form)
  }

  // ── Form action/method wiring (items 602, 604) ─────────────────────────────
  // Intercept submit events that bubble to the document and handle action navigation.
  doc.addEventListener('submit', (ev: VEvent) => {
    if (ev.defaultPrevented) return;
    var form = ev.target as VElement | null;
    if (!form) return;
    var action  = (form as any).action  || '';
    if (!action) return;  // no action — leave to script handlers
    var method  = ((form as any).method  || 'get').toLowerCase();
    var noVal   = (form as any).noValidate;
    // Validate unless novalidate
    if (!noVal && !(form as any).checkFormValidity && form.querySelectorAll) {
      // fall back: iterate fields
    }
    if (!noVal && typeof (form as any).checkFormValidity === 'function') {
      if (!(form as any).checkFormValidity()) { ev.preventDefault(); return; }
    }
    var serialized = typeof (form as any).serializeForm === 'function' ? (form as any).serializeForm() : '';
    var actionURL = action.startsWith('http') ? action : _resolveURL(action, _baseHref);
    if (method === 'get') {
      actionURL += (actionURL.includes('?') ? '&' : '?') + serialized;
      cb.navigate(actionURL);
    } else {
      // POST — use fetchAsync, then navigate if redirect returned
      os.fetchAsync(actionURL, (resp: any) => {
        if (resp && resp.status >= 300 && resp.status < 400 && resp.headers?.location) {
          cb.navigate(resp.headers.location);
        } else if (resp) {
          // Navigate to action URL with response body rendered
          cb.navigate(actionURL);
        }
      }, { method: 'POST', body: serialized, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    }
  });

  // ── window.location ────────────────────────────────────────────────────────

  // ── window.location ───────────────────────────────────────────────────────

  // Tracks URL overridden by pushState/replaceState/hash setter (without real navigation)
  var _locationHrefOverride: string | null = null;
  function _effectiveHref(): string { return _locationHrefOverride ?? cb.baseURL; }
  function _locPart(part: 'pathname'|'hostname'|'protocol'|'host'|'search'|'hash'|'port'|'origin'): string {
    try { return (new URL(_effectiveHref()) as any)[part]; }
    catch(_) { return part === 'pathname' ? '/' : part === 'protocol' ? 'http:' : part === 'origin' ? 'null' : ''; }
  }

  var location = {
    get href(): string { return _effectiveHref(); },
    set href(v: string) { cb.navigate(v); },
    assign(url: string)  { cb.navigate(url); },
    replace(url: string) { cb.navigate(url); },
    reload()             { cb.navigate(_effectiveHref()); },
    get pathname(): string { return _locPart('pathname'); },
    get hostname(): string { return _locPart('hostname'); },
    get protocol(): string { return _locPart('protocol'); },
    get host():     string { return _locPart('host'); },
    get search():   string { return _locPart('search'); },
    get hash():     string { return _locPart('hash'); },
    set hash(v: string) {
      var oldHash = location.hash;
      var newHash = v ? (v.startsWith('#') ? v : '#' + v) : '';
      if (oldHash !== newHash) {
        var oldHref = _effectiveHref();
        var newHref = oldHref.replace(/#.*$/, '') + newHash;
        _locationHrefOverride = newHref;
        try {
          var hcev = new HashChangeEvent('hashchange', { bubbles: false, cancelable: false, oldURL: oldHref, newURL: newHref });
          (win['dispatchEvent'] as (e: VEvent) => void)(hcev);
        } catch (_) {}
      }
    },
    get port():     string { return _locPart('port'); },
    get origin():   string { return _locPart('origin'); },
    toString():     string { return _effectiveHref(); },
  };

  // ── window.history ─────────────────────────────────────────────────────────

  function _firePopState(state: unknown): void {
    var ev = new VEvent('popstate', { bubbles: false, cancelable: false });
    (ev as any).state = state ?? null;
    // win may not exist yet at definition time but will be set by time back/forward is called
    try { (win['dispatchEvent'] as (e: VEvent) => void)(ev); } catch(_) {}
  }

  var history = {
    _stack: [cb.baseURL], _pos: 0, _states: [null as unknown],
    scrollRestoration: 'auto' as 'auto' | 'manual',
    get length(): number { return this._stack.length; },
    get state(): unknown { return this._states[this._pos] ?? null; },
    pushState(state: unknown, _title: string, url: string) {
      var oldHref = _locationHrefOverride ?? cb.baseURL;
      this._stack.splice(this._pos + 1); this._states.splice(this._pos + 1);
      this._stack.push(url); this._states.push(state);
      this._pos = this._stack.length - 1;
      // Update URL without triggering navigation (SPA routing)
      _locationHrefOverride = url;
      // Fire hashchange if only the hash component changed
      try {
        var oldU = new URL(oldHref); var newU = new URL(url, oldHref);
        if (oldU.origin === newU.origin && oldU.pathname === newU.pathname &&
            oldU.search === newU.search && oldU.hash !== newU.hash) {
          var hcev2 = new HashChangeEvent('hashchange', { bubbles: false, cancelable: false, oldURL: oldHref, newURL: url });
          (win['dispatchEvent'] as (e: VEvent) => void)(hcev2);
        }
      } catch (_) {}
    },
    replaceState(state: unknown, _title: string, url: string) {
      this._stack[this._pos] = url; this._states[this._pos] = state;
      _locationHrefOverride = url;
    },
    back()    { if (this._pos > 0) { this._pos--; cb.navigate(this._stack[this._pos]); _firePopState(this._states[this._pos]); } },
    forward() { if (this._pos < this._stack.length - 1) { this._pos++; cb.navigate(this._stack[this._pos]); _firePopState(this._states[this._pos]); } },
    go(delta: number) { var t = this._pos + delta; if (t >= 0 && t < this._stack.length) { this._pos = t; cb.navigate(this._stack[this._pos]); _firePopState(this._states[this._pos]); } },
  };

  // ── window.navigator ───────────────────────────────────────────────────────

  var navigator = {
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 JSOS/1.0',
    platform:   'Linux x86_64',
    language:   'en-US',
    languages:  ['en-US', 'en'],
    vendor:     'JSOS',
    appName:    'Netscape',
    appVersion: '5.0 (X11)',
    product:    'Gecko',
    cookieEnabled: true,
    onLine:     true,
    hardwareConcurrency: 1,
    maxTouchPoints: 0,
    geolocation: { getCurrentPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); }, watchPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); return 0; }, clearWatch() {} },
    clipboard: {
      readText(): Promise<string> { return Promise.reject(new DOMException('NotAllowedError')); },
      writeText(_t: string): Promise<void> { return Promise.resolve(); },
      read(): Promise<unknown[]> { return Promise.reject(new DOMException('NotAllowedError')); },
      write(_items: unknown[]): Promise<void> { return Promise.resolve(); },
    },
    permissions: {
      query(_desc: { name: string }): Promise<{ state: string }> { return Promise.resolve({ state: 'denied', addEventListener() {}, removeEventListener() {} } as any); },
    },
    mediaDevices: {
      getUserMedia(_c: unknown): Promise<unknown> { return Promise.reject(new Error('NotSupportedError')); },
      enumerateDevices(): Promise<unknown[]> { return Promise.resolve([]); },
      getSupportedConstraints(): object { return {}; },
    },
    serviceWorker: {
      register(_url: string): Promise<unknown> { return Promise.reject(new Error('Not supported')); },
      ready: Promise.reject(new Error('Not supported')),
      controller: null,
      getRegistrations(): Promise<unknown[]> { return Promise.resolve([]); },
      addEventListener() {}, removeEventListener() {},
    },
    sendBeacon(url: string, data?: unknown): boolean {
      try {
        // Fire-and-forget POST; fetchAPI is defined later in closure but valid at call time
        var beaconURL = url ? _resolveURL(url, _baseHref) : '';
        if (!beaconURL) return false;
        var body = (data == null) ? undefined : (typeof data === 'string' ? data : JSON.stringify(data));
        os.fetchAsync(beaconURL, () => {}, { method: 'POST', body: body ?? '', headers: { 'Content-Type': 'text/plain' } });
        return true;
      } catch (_) { return false; }
    },
    vibrate()   { return false; },
    share(_d?: unknown): Promise<void> { return Promise.reject(new Error('Not supported')); },
    canShare(_d?: unknown): boolean { return false; },
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false, addEventListener() {}, removeEventListener() {} },
    storage: {
      estimate(): Promise<{quota: number; usage: number}> { return Promise.resolve({ quota: 1024 * 1024 * 50, usage: 0 }); },
      persist(): Promise<boolean> { return Promise.resolve(false); },
      persisted(): Promise<boolean> { return Promise.resolve(false); },
    },
    locks: {
      request(_name: string, fnOrOpts: unknown, fn?: unknown): Promise<unknown> {
        var cb_ = typeof fnOrOpts === 'function' ? fnOrOpts : fn;
        return typeof cb_ === 'function' ? Promise.resolve().then(() => (cb_ as Function)({ name: _name, mode: 'exclusive' })) : Promise.resolve(null);
      },
      query(): Promise<{held: unknown[]; pending: unknown[]}> { return Promise.resolve({ held: [], pending: [] }); },
    },
    // User-Agent Client Hints API (navigator.userAgentData) — used by React DevTools, Angular, Vite
    userAgentData: {
      brands: [
        { brand: 'Chromium', version: '120' },
        { brand: 'Google Chrome', version: '120' },
        { brand: 'JSOS', version: '1' },
      ],
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
        var vals: Record<string, unknown> = {
          architecture: 'x86', bitness: '64', model: '', platform: 'Linux',
          platformVersion: '1.0', uaFullVersion: '120.0.0.0',
          fullVersionList: [
            { brand: 'Chromium', version: '120.0.0.0' },
            { brand: 'Google Chrome', version: '120.0.0.0' },
            { brand: 'JSOS', version: '1.0.0' },
          ],
          wow64: false,
        };
        var result: Record<string, unknown> = {};
        for (var h of hints) { if (h in vals) result[h] = vals[h]; }
        return Promise.resolve(result);
      },
      toJSON(): object {
        return { brands: this.brands, mobile: this.mobile, platform: this.platform };
      },
    },
    webdriver: false,        // navigator.webdriver — set false so sites don't detect automation
    pdfViewerEnabled: true,  // navigator.pdfViewerEnabled
    // Web Authentication API stub — lets sites detect presence without crashing
    credentials: {
      get(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); },
      create(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); },
      store(_cred: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); },
      preventSilentAccess(): Promise<void> { return Promise.resolve(); },
    },
    // Web HID API stub (item 541) — checked by many modern web apps
    hid: {
      getDevices(): Promise<unknown[]> { return Promise.resolve([]); },
      requestDevice(_opts?: unknown): Promise<unknown[]> { return Promise.reject(new DOMException('NotSupportedError')); },
      addEventListener(_t: string, _l: unknown) {}, removeEventListener(_t: string, _l: unknown) {},
    },
    // Web USB API stub (item 541)
    usb: {
      getDevices(): Promise<unknown[]> { return Promise.resolve([]); },
      requestDevice(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); },
      addEventListener(_t: string, _l: unknown) {}, removeEventListener(_t: string, _l: unknown) {},
    },
    // Web Bluetooth API stub
    bluetooth: {
      getAvailability(): Promise<boolean> { return Promise.resolve(false); },
      requestDevice(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); },
      getDevices(): Promise<unknown[]> { return Promise.resolve([]); },
      addEventListener(_t: string, _l: unknown) {}, removeEventListener(_t: string, _l: unknown) {},
    },
    // Web Serial API stub
    serial: {
      getPorts(): Promise<unknown[]> { return Promise.resolve([]); },
      requestPort(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); },
      addEventListener(_t: string, _l: unknown) {}, removeEventListener(_t: string, _l: unknown) {},
    },
    // Wake Lock API stub
    wakeLock: {
      request(_type?: string): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); },
    },
  };

  // ── window.screen ─────────────────────────────────────────────────────────

  var screen = {
    width: 1024, height: 768, availWidth: 1024, availHeight: 768,
    colorDepth: 32, pixelDepth: 32,
    // Screen Orientation API
    orientation: {
      type: 'landscape-primary' as string,
      angle: 0 as number,
      onchange: null as ((e: unknown) => void) | null,
      lock(_orientation: string): Promise<void> { return Promise.resolve(); },
      unlock(): void {},
      addEventListener() {}, removeEventListener() {},
    },
  };

  // ── CustomEvent ───────────────────────────────────────────────────────────

  class CustomEvent extends VEvent {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown; bubbles?: boolean; cancelable?: boolean }) {
      super(type, init); this.detail = init?.detail ?? null;
    }
  }

  // ── Event subclass hierarchy (item 520-529) ───────────────────────────────

  class UIEvent extends VEvent {
    detail: number; view: unknown;
    constructor(type: string, init?: any) { super(type, init); this.detail = init?.detail ?? 0; this.view = init?.view ?? null; }
  }

  class MouseEvent extends UIEvent {
    clientX: number; clientY: number; screenX: number; screenY: number;
    pageX: number; pageY: number; offsetX: number; offsetY: number; x: number; y: number;
    button: number; buttons: number; relatedTarget: unknown;
    ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
    constructor(type: string, init?: any) {
      super(type, init);
      this.clientX = init?.clientX ?? 0; this.clientY = init?.clientY ?? 0;
      this.screenX = init?.screenX ?? 0; this.screenY = init?.screenY ?? 0;
      this.pageX = init?.pageX ?? 0; this.pageY = init?.pageY ?? 0;
      this.offsetX = init?.offsetX ?? 0; this.offsetY = init?.offsetY ?? 0;
      this.x = this.clientX; this.y = this.clientY;
      this.button = init?.button ?? 0; this.buttons = init?.buttons ?? 0;
      this.relatedTarget = init?.relatedTarget ?? null;
      this.ctrlKey = init?.ctrlKey ?? false; this.shiftKey = init?.shiftKey ?? false;
      this.altKey = init?.altKey ?? false; this.metaKey = init?.metaKey ?? false;
    }
    getModifierState(_k: string): boolean { return false; }
  }

  class PointerEvent extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    width: number; height: number; pressure: number; tangentialPressure: number;
    tiltX: number; tiltY: number; twist: number;
    constructor(type: string, init?: any) {
      super(type, init);
      this.pointerId = init?.pointerId ?? 1; this.pointerType = init?.pointerType ?? 'mouse';
      this.isPrimary = init?.isPrimary ?? true;
      this.width = init?.width ?? 1; this.height = init?.height ?? 1;
      this.pressure = init?.pressure ?? 0; this.tangentialPressure = init?.tangentialPressure ?? 0;
      this.tiltX = init?.tiltX ?? 0; this.tiltY = init?.tiltY ?? 0; this.twist = init?.twist ?? 0;
    }
    getCoalescedEvents(): PointerEvent[] { return []; }
    getPredictedEvents(): PointerEvent[] { return []; }
  }

  class WheelEvent extends MouseEvent {
    deltaX: number; deltaY: number; deltaZ: number; deltaMode: number;
    static DOM_DELTA_PIXEL = 0; static DOM_DELTA_LINE = 1; static DOM_DELTA_PAGE = 2;
    constructor(type: string, init?: any) {
      super(type, init);
      this.deltaX = init?.deltaX ?? 0; this.deltaY = init?.deltaY ?? 0;
      this.deltaZ = init?.deltaZ ?? 0; this.deltaMode = init?.deltaMode ?? 0;
    }
  }

  class KeyboardEvent extends UIEvent {
    key: string; code: string; keyCode: number; which: number; charCode: number; location: number;
    repeat: boolean; isComposing: boolean;
    ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
    static DOM_KEY_LOCATION_STANDARD = 0; static DOM_KEY_LOCATION_LEFT = 1;
    static DOM_KEY_LOCATION_RIGHT = 2; static DOM_KEY_LOCATION_NUMPAD = 3;
    constructor(type: string, init?: any) {
      super(type, init);
      this.key = init?.key ?? ''; this.code = init?.code ?? '';
      this.keyCode = init?.keyCode ?? 0; this.which = init?.which ?? this.keyCode;
      this.charCode = init?.charCode ?? 0; this.location = init?.location ?? 0;
      this.repeat = init?.repeat ?? false; this.isComposing = init?.isComposing ?? false;
      this.ctrlKey = init?.ctrlKey ?? false; this.shiftKey = init?.shiftKey ?? false;
      this.altKey = init?.altKey ?? false; this.metaKey = init?.metaKey ?? false;
    }
    getModifierState(_k: string): boolean { return false; }
  }

  class InputEvent extends UIEvent {
    data: string | null; inputType: string; isComposing: boolean;
    constructor(type: string, init?: any) {
      super(type, init);
      this.data = init?.data ?? null; this.inputType = init?.inputType ?? ''; this.isComposing = init?.isComposing ?? false;
    }
    getTargetRanges(): unknown[] { return []; }
  }

  class FocusEvent extends UIEvent {
    relatedTarget: unknown;
    constructor(type: string, init?: any) { super(type, init); this.relatedTarget = init?.relatedTarget ?? null; }
  }

  class CompositionEvent extends UIEvent {
    data: string;
    constructor(type: string, init?: any) { super(type, init); this.data = init?.data ?? ''; }
  }

  class TouchEvent extends UIEvent {
    touches: unknown[]; targetTouches: unknown[]; changedTouches: unknown[];
    ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
    constructor(type: string, init?: any) {
      super(type, init);
      this.touches = init?.touches ?? []; this.targetTouches = init?.targetTouches ?? []; this.changedTouches = init?.changedTouches ?? [];
      this.ctrlKey = init?.ctrlKey ?? false; this.shiftKey = init?.shiftKey ?? false;
      this.altKey = init?.altKey ?? false; this.metaKey = init?.metaKey ?? false;
    }
  }

  class DragEvent extends MouseEvent {
    dataTransfer: { getData(_f: string): string; setData(_f: string, _v: string): void; files: unknown[]; types: string[] };
    constructor(type: string, init?: any) {
      super(type, init);
      this.dataTransfer = init?.dataTransfer ?? { getData: () => '', setData: () => {}, files: [], types: [] };
    }
  }

  class ErrorEvent extends VEvent {
    message: string; filename: string; lineno: number; colno: number; error: unknown;
    constructor(type: string, init?: any) {
      super(type, init);
      this.message = init?.message ?? ''; this.filename = init?.filename ?? '';
      this.lineno = init?.lineno ?? 0; this.colno = init?.colno ?? 0; this.error = init?.error ?? null;
    }
  }

  class MessageEvent extends VEvent {
    data: unknown; origin: string; lastEventId: string; source: unknown; ports: unknown[];
    constructor(type: string, init?: any) {
      super(type, init);
      this.data = init?.data ?? null; this.origin = init?.origin ?? ''; this.lastEventId = init?.lastEventId ?? '';
      this.source = init?.source ?? null; this.ports = init?.ports ?? [];
    }
  }

  class StorageEvent extends VEvent {
    key: string | null; oldValue: string | null; newValue: string | null; url: string; storageArea: unknown;
    constructor(type: string, init?: any) {
      super(type, init);
      this.key = init?.key ?? null; this.oldValue = init?.oldValue ?? null; this.newValue = init?.newValue ?? null;
      this.url = init?.url ?? ''; this.storageArea = init?.storageArea ?? null;
    }
  }

  class HashChangeEvent extends VEvent {
    oldURL: string; newURL: string;
    constructor(type: string, init?: any) { super(type, init); this.oldURL = init?.oldURL ?? ''; this.newURL = init?.newURL ?? ''; }
  }

  class PopStateEvent extends VEvent {
    state: unknown;
    constructor(type: string, init?: any) { super(type, init); this.state = init?.state ?? null; }
  }

  class PageTransitionEvent extends VEvent {
    persisted: boolean;
    constructor(type: string, init?: any) { super(type, init); this.persisted = init?.persisted ?? false; }
  }

  class AnimationEvent extends VEvent {
    animationName: string; elapsedTime: number; pseudoElement: string;
    constructor(type: string, init?: any) {
      super(type, init); this.animationName = init?.animationName ?? ''; this.elapsedTime = init?.elapsedTime ?? 0; this.pseudoElement = init?.pseudoElement ?? '';
    }
  }

  class TransitionEvent extends VEvent {
    propertyName: string; elapsedTime: number; pseudoElement: string;
    constructor(type: string, init?: any) {
      super(type, init); this.propertyName = init?.propertyName ?? ''; this.elapsedTime = init?.elapsedTime ?? 0; this.pseudoElement = init?.pseudoElement ?? '';
    }
  }

  class BeforeUnloadEvent extends VEvent {
    returnValue: string = '';
    constructor(type: string, init?: any) { super(type, init); }
  }

  class SubmitEvent extends VEvent {
    submitter: unknown;
    constructor(type: string, init?: any) { super(type, init); this.submitter = init?.submitter ?? null; }
  }

  class ClipboardEvent extends VEvent {
    clipboardData: { getData(_f: string): string; setData(_f: string, _v: string): void; files: unknown[]; types: string[] } | null;
    constructor(type: string, init?: any) { super(type, init); this.clipboardData = init?.clipboardData ?? null; }
  }

  class GamepadEvent extends VEvent {
    gamepad: unknown;
    constructor(type: string, init?: any) { super(type, init); this.gamepad = init?.gamepad ?? null; }
  }

  class SecurityPolicyViolationEvent extends VEvent {
    documentURI = ''; referrer = ''; blockedURI = ''; effectiveDirective = ''; violatedDirective = ''; originalPolicy = ''; sourceFile = ''; sample = ''; disposition = 'enforce'; statusCode = 0; lineNumber = 0; columnNumber = 0;
    constructor(type: string, init?: any) { super(type, init); Object.assign(this, init ?? {}); }
  }

  class EventTarget_ {
    _listeners: Map<string, Array<(e: VEvent) => void>> = new Map();
    addEventListener(type: string, fn: (e: VEvent) => void): void {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: (e: VEvent) => void): void {
      var arr = this._listeners.get(type); if (!arr) return;
      this._listeners.set(type, arr.filter(f => f !== fn));
    }
    dispatchEvent(ev: VEvent): boolean {
      var arr = this._listeners.get(ev.type); if (!arr) return true;
      for (var fn of arr) fn(ev); return !ev.defaultPrevented;
    }
  }

  // ── CSS object (item 553) ──────────────────────────────────────────────────

  var CSS_ = {
    supports(_prop: string, _val?: string): boolean { return true; }, // optimistic stub
    escape(str: string): string {
      return str.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~]/g, m => '\\' + m)
                .replace(/^\d/, m => '\\3' + m + ' ');
    },
    px(n: number): string { return n + 'px'; },
    em(n: number): string { return n + 'em'; },
    rem(n: number): string { return n + 'rem'; },
    percent(n: number): string { return n + '%'; },
    number(n: number): string { return String(n); },
    /** CSS.registerProperty() — CSS Houdini Properties & Values API Level 1 */
    registerProperty(_descriptor: { name: string; syntax?: string; inherits: boolean; initialValue?: string }): void {},
    /** CSS.paintWorklet — Houdini Paint API stub */
    paintWorklet: { addModule(_url: string): Promise<void> { return Promise.resolve(); } },
    /** CSS.layoutWorklet — Houdini Layout API stub */
    layoutWorklet: { addModule(_url: string): Promise<void> { return Promise.resolve(); } },
    /** CSS.animationWorklet — Houdini Animation Worklet stub */
    animationWorklet: { addModule(_url: string): Promise<void> { return Promise.resolve(); } },
  };

  // ── visualViewport stub (item 462) ────────────────────────────────────────

  var _visualViewport = {
    width: 1024, height: 768, offsetLeft: 0, offsetTop: 0,
    pageLeft: 0, pageTop: 0, scale: 1,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };

  // ── DOMException ─────────────────────────────────────────────────────────

  class DOMException extends Error {
    code: number; name: string;
    constructor(message: string, name = 'DOMException') {
      super(message); this.name = name;
      const codes: Record<string,number> = { IndexSizeError:1, HierarchyRequestError:3, WrongDocumentError:4, InvalidCharacterError:5, NotFoundError:8, NotSupportedError:9, InvalidStateError:11, SyntaxError:12, InvalidModificationError:13, NamespaceError:14, InvalidAccessError:15, TypeMismatchError:17, SecurityError:18, NetworkError:19, AbortError:20, URLMismatchError:21, QuotaExceededError:22, TimeoutError:23, InvalidNodeTypeError:24, DataCloneError:25, NotAllowedError:0 };
      this.code = codes[name] ?? 0;
    }
  }

  /** Create a minimal ReadableStream-like body from a string (used by fetch response .body). */
  function _makeBodyStream(bodyText: string): any {
    var consumed = false;
    return {
      get locked() { return consumed; },
      getReader(): any {
        var done = false;
        consumed = true;
        return {
          read(): Promise<any> {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            var enc = new TextEncoder();
            return Promise.resolve({ done: false, value: enc.encode(bodyText) });
          },
          releaseLock(): void {},
          cancel(): Promise<void> { done = true; return Promise.resolve(); },
          get closed(): Promise<void> { return Promise.resolve(); },
        };
      },
      cancel(): Promise<void> { consumed = true; return Promise.resolve(); },
      pipeTo(dest: any): Promise<void> {
        var enc = new TextEncoder();
        try { var w = dest.getWriter(); w.write(enc.encode(bodyText)); w.close(); } catch(_) {}
        return Promise.resolve();
      },
      tee(): [any, any] { return [_makeBodyStream(bodyText), _makeBodyStream(bodyText)]; },
    };
  }

  // ── Request class (item 506) ──────────────────────────────────────────────

  class Request_ {
    url: string; method: string; headers: Headers_; body: any;
    mode: string; credentials: string; cache: string; redirect: string;
    referrer: string; keepalive: boolean; signal: AbortSignalImpl | null;
    bodyUsed = false;
    constructor(input: string | Request_, init?: { method?: string; headers?: any; body?: any; mode?: string; credentials?: string; cache?: string; redirect?: string; referrer?: string; keepalive?: boolean; signal?: AbortSignalImpl }) {
      if (input instanceof Request_) {
        this.url = input.url; this.method = input.method; this.headers = new Headers_(input.headers);
        this.body = input.body; this.mode = input.mode; this.credentials = input.credentials;
        this.cache = input.cache; this.redirect = input.redirect; this.referrer = input.referrer;
        this.keepalive = input.keepalive; this.signal = input.signal;
      } else {
        this.url = String(input); this.method = (init?.method || 'GET').toUpperCase();
        this.headers  = init?.headers instanceof Headers_ ? init.headers : new Headers_(init?.headers);
        this.body       = init?.body ?? null;
        this.mode       = init?.mode       ?? 'cors';
        this.credentials = init?.credentials ?? 'same-origin';
        this.cache      = init?.cache      ?? 'default';
        this.redirect   = init?.redirect   ?? 'follow';
        this.referrer   = init?.referrer   ?? 'about:client';
        this.keepalive  = init?.keepalive  ?? false;
        this.signal     = init?.signal     ?? null;
      }
    }
    clone(): Request_ { return new Request_(this); }
    text():        Promise<string>      { return Promise.resolve(String(this.body ?? '')); }
    json():        Promise<unknown>     { return this.text().then(t => JSON.parse(t)); }
    arrayBuffer(): Promise<ArrayBuffer> { var s = String(this.body ?? ''); var ab = new ArrayBuffer(s.length); var v = new Uint8Array(ab); for (var i = 0; i < s.length; i++) v[i] = s.charCodeAt(i) & 0xff; return Promise.resolve(ab); }
    blob():        Promise<Blob>        { return Promise.resolve(new Blob([String(this.body ?? '')])); }
    formData():    Promise<FormData_>   { return Promise.resolve(new FormData_()); }
  }

  // ── Response class (item 506) ─────────────────────────────────────────────

  class Response_ {
    status: number; statusText: string; ok: boolean; headers: Headers_;
    type: string; url: string; redirected: boolean; body: any; bodyUsed = false;
    _text: string;
    constructor(body?: string | null | Blob | ArrayBuffer | FormData_, init?: { status?: number; statusText?: string; headers?: any }) {
      this.status     = init?.status ?? 200;
      this.statusText = init?.statusText ?? (this.status === 200 ? 'OK' : String(this.status));
      this.ok         = this.status >= 200 && this.status < 300;
      this.headers    = init?.headers instanceof Headers_ ? init.headers : new Headers_(init?.headers);
      this.type       = 'default'; this.url = ''; this.redirected = false;
      this._text      = body == null ? '' : (typeof body === 'string' ? body : '');
      this.body       = _makeBodyStream(this._text);
    }
    clone(): Response_ { return Object.assign(new Response_(this._text, { status: this.status, statusText: this.statusText, headers: this.headers }), { type: this.type, url: this.url, redirected: this.redirected }); }
    text():        Promise<string>      { return Promise.resolve(this._text); }
    json():        Promise<unknown>     { try { return Promise.resolve(JSON.parse(this._text)); } catch(e) { return Promise.reject(e); } }
    blob():        Promise<Blob>        { return Promise.resolve(new Blob([this._text], { type: this.headers.get('content-type') || '' })); }
    arrayBuffer(): Promise<ArrayBuffer> { var s = this._text; var ab = new ArrayBuffer(s.length); var v = new Uint8Array(ab); for (var i = 0; i < s.length; i++) v[i] = s.charCodeAt(i) & 0xff; return Promise.resolve(ab); }
    formData():    Promise<FormData_>   { return Promise.resolve(new FormData_()); }
    static error(): Response_ { var r = new Response_(null, { status: 0, statusText: '' }); r.type = 'error'; return r; }
    static redirect(url: string, status = 302): Response_ { var r = new Response_(null, { status }); r.headers.set('location', url); return r; }
    static json(data: unknown, init?: { status?: number; statusText?: string; headers?: any }): Response_ {
      var r = new Response_(JSON.stringify(data), init); r.headers.set('content-type', 'application/json'); return r;
    }
  }

  function fetchAPI(url: string | Request_ | { url?: string; href?: string; toString(): string }, opts?: { method?: string; body?: string | FormData_; headers?: Record<string, string> | Headers_; signal?: AbortSignalImpl; mode?: string; credentials?: string; cache?: string; redirect?: string; referrer?: string; keepalive?: boolean }): Promise<any> {
    // Allow fetching a Request object — merge its fields with any overriding opts
    if (url instanceof Request_) {
      var req = url as Request_;
      opts = Object.assign({ method: req.method, headers: req.headers, body: req.body, signal: req.signal }, opts as any);
      url = req.url;
    }
    var urlStr = typeof url === 'string' ? url : (url as any).href || (url as any).url || String(url);
    return new Promise((resolve, reject) => {
      var signal = opts?.signal;
      if (signal?.aborted) { reject(signal.reason ?? new Error('AbortError')); return; }

      // ── data: URL support (item 638) ──────────────────────────────────────
      if (urlStr.startsWith('data:')) {
        var commaIdx = urlStr.indexOf(',');
        if (commaIdx < 0) { reject(new Error('Invalid data URL')); return; }
        var meta = urlStr.slice(5, commaIdx); // e.g. "text/plain;base64" or "text/html"
        var data = urlStr.slice(commaIdx + 1);
        var isBase64 = meta.endsWith(';base64');
        var mimeType = isBase64 ? meta.slice(0, -7) : meta;
        if (!mimeType) mimeType = 'text/plain;charset=US-ASCII';
        var text2 = isBase64 ? atob(data) : decodeURIComponent(data);
        var respHeaders2 = new Headers_(); respHeaders2.set('content-type', mimeType);
        resolve({
          ok: true, status: 200, statusText: 'OK', headers: respHeaders2, redirected: false, type: 'basic', url: urlStr,
          text():        Promise<string>      { return Promise.resolve(text2); },
          json():        Promise<unknown>     { try { return Promise.resolve(JSON.parse(text2)); } catch(e2) { return Promise.reject(e2); } },
          blob():        Promise<Blob>        { return Promise.resolve(new Blob([text2], { type: mimeType })); },
          arrayBuffer(): Promise<ArrayBuffer> { var ab2 = new ArrayBuffer(text2.length); var v2 = new Uint8Array(ab2); for (var ii = 0; ii < text2.length; ii++) v2[ii] = text2.charCodeAt(ii) & 0xff; return Promise.resolve(ab2); },
          formData():    Promise<FormData_>   { return Promise.resolve(new FormData_()); },
          clone() { return Object.assign({}, this); }, bodyUsed: false,
          get body() { return _makeBodyStream(text2); },
        });
        return;
      }

      var method = (opts?.method || 'GET').toUpperCase() as 'GET' | 'POST';
      var extraHeaders: Record<string, string> = {};
      if (opts?.headers) {
        if (opts.headers instanceof Headers_) opts.headers.forEach((v: string, k: string) => { extraHeaders[k] = v; });
        else Object.assign(extraHeaders, opts.headers);
      }
      var bodyStr: string | undefined;
      if (opts?.body) {
        if (opts.body instanceof FormData_) {
          var pairs: string[] = [];
          opts.body.forEach((v: string, k: string) => pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)));
          bodyStr = pairs.join('&');
          extraHeaders['content-type'] = extraHeaders['content-type'] || 'application/x-www-form-urlencoded';
        } else {
          bodyStr = String(opts.body);
        }
      }
      // Inject stored cookies (items 303-304)
      try {
        var _cu = new URL(urlStr);
        var _ch = cookieJar.getCookieHeader(_cu.hostname, _cu.pathname, _cu.protocol === 'https:');
        if (_ch) extraHeaders['cookie'] = extraHeaders['cookie'] || _ch;
      } catch (_) {}

      var aborted = false;
      if (signal) {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason ?? new Error('AbortError')); });
      }
      os.fetchAsync(urlStr, (resp: FetchResponse | null, err?: string) => {
        if (aborted) return;
        if (!resp) { reject(new Error(err || 'fetch failed')); return; }
        var text  = resp.bodyText;
        var respHeaders = new Headers_();
        resp.headers.forEach((v: string, k: string) => respHeaders.set(k, v));
        // Process Set-Cookie headers (items 303-304)
        var sc = respHeaders.get('set-cookie');
        if (sc) {
          try {
            var _su = new URL(urlStr);
            var _scOrigin = { host: _su.hostname, path: _su.pathname, secure: _su.protocol === 'https:' };
            var _scVals = sc.split('\n');
            for (var _sci = 0; _sci < _scVals.length; _sci++) {
              if (_scVals[_sci].trim()) cookieJar.setCookie(_scVals[_sci].trim(), _scOrigin);
            }
          } catch (_) {}
        }
        var response: any = {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: String(resp.status),
          headers: respHeaders,
          redirected: false,
          type: 'basic',
          url: urlStr,
          text():        Promise<string>      { return Promise.resolve(text); },
          json():        Promise<unknown>     { try { return Promise.resolve(JSON.parse(text)); } catch(e) { return Promise.reject(e); } },
          blob():        Promise<Blob>        { return Promise.resolve(new Blob([text], { type: respHeaders.get('content-type') || '' })); },
          arrayBuffer(): Promise<ArrayBuffer> {
            var ab = new ArrayBuffer(text.length);
            var view = new Uint8Array(ab);
            for (var i = 0; i < text.length; i++) view[i] = text.charCodeAt(i) & 0xff;
            return Promise.resolve(ab);
          },
          formData():    Promise<FormData_>   { return Promise.resolve(new FormData_()); },
          clone()        { return Object.assign({}, this); },
          bodyUsed: false,
          get body()     { return _makeBodyStream(text); },
        };
        resolve(response);
      }, { method, headers: extraHeaders, body: bodyStr });
    });
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────────

  class XMLHttpRequest {
    static UNSENT = 0; static OPENED = 1; static HEADERS_RECEIVED = 2; static LOADING = 3; static DONE = 4;
    readyState = 0; status = 0; statusText = ''; responseText = ''; responseXML = null; response: any = null;
    responseType = ''; withCredentials = false; timeout = 0; responseURL = '';
    onreadystatechange: ((ev?: unknown) => void) | null = null;
    onload:      ((ev?: unknown) => void) | null = null;
    onerror:     ((ev?: unknown) => void) | null = null;
    ontimeout:   ((ev?: unknown) => void) | null = null;
    onprogress:  ((ev?: unknown) => void) | null = null;
    onloadstart: ((ev?: unknown) => void) | null = null;
    onloadend:   ((ev?: unknown) => void) | null = null;
    onabort:     ((ev?: unknown) => void) | null = null;
    upload = { addEventListener() {}, removeEventListener() {}, onprogress: null, onload: null, onerror: null };
    _method = 'GET'; _url = ''; _headers: Record<string, string> = {};
    _responseHeaders: Record<string, string> = {}; _aborted = false;
    _listeners: Map<string, Array<(e: unknown) => void>> = new Map();

    open(method: string, url: string, _async = true, _user?: string, _pass?: string): void {
      this._method = method; this._url = url; this.readyState = 1; this._aborted = false;
      this._responseHeaders = {};
      this._setState(1);
    }
    setRequestHeader(k: string, v: string): void { this._headers[k.toLowerCase()] = v; }
    getResponseHeader(k: string): string | null { return this._responseHeaders[k.toLowerCase()] ?? null; }
    getAllResponseHeaders(): string { return Object.entries(this._responseHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n'); }
    overrideMimeType(_mime: string): void {}

    _setState(state: number): void {
      this.readyState = state;
      try { if (this.onreadystatechange) this.onreadystatechange({ target: this }); } catch(_) {}
    }

    send(body?: string | FormData_ | null): void {
      if (this._aborted) return;
      var self = this;
      try { if (self.onloadstart) self.onloadstart({ target: self }); } catch(_) {}
      var bodyStr: string | undefined;
      if (body instanceof FormData_) {
        var pairs: string[] = [];
        body.forEach((v, k) => pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)));
        bodyStr = pairs.join('&');
        self._headers['content-type'] = self._headers['content-type'] || 'application/x-www-form-urlencoded';
      } else if (body) { bodyStr = String(body); }

      os.fetchAsync(this._url, (resp: FetchResponse | null, _err?: string) => {
        if (self._aborted) return;
        if (resp) {
          self.status = resp.status; self.statusText = String(resp.status);
          self.responseURL = self._url;
          resp.headers.forEach((v: string, k: string) => { self._responseHeaders[k.toLowerCase()] = v; });
          self._setState(2); // HEADERS_RECEIVED
          self._setState(3); // LOADING
          self.responseText = resp.bodyText;
          self.response = self.responseType === 'json' ? (() => { try { return JSON.parse(resp.bodyText); } catch(_) { return null; } })()
            : self.responseType === 'arraybuffer' ? (() => { var ab = new ArrayBuffer(resp.bodyText.length); var v = new Uint8Array(ab); for (var i = 0; i < resp.bodyText.length; i++) v[i] = resp.bodyText.charCodeAt(i) & 0xff; return ab; })()
            : self.responseType === 'blob' ? new Blob([resp.bodyText], { type: self._responseHeaders['content-type'] || '' })
            : resp.bodyText;
          self._setState(4); // DONE
          var ev = { target: self, loaded: resp.bodyText.length, total: resp.bodyText.length, lengthComputable: true };
          try { if (self.onprogress)  self.onprogress(ev); }  catch(_) {}
          try { if (self.onload)      self.onload(ev); }      catch(_) {}
          try { if (self.onloadend)   self.onloadend(ev); }   catch(_) {}
        } else {
          self.status = 0; self._setState(4);
          var errEv = { target: self };
          try { if (self.onerror)   self.onerror(errEv); } catch(_) {}
          try { if (self.onloadend) self.onloadend(errEv); } catch(_) {}
        }
        var listeners = self._listeners.get('readystatechange');
        if (listeners) for (var fn of listeners) try { fn({ target: self }); } catch(_) {}
      }, { method: this._method as 'GET' | 'POST', headers: this._headers, body: bodyStr });
    }

    abort(): void {
      this._aborted = true; this.status = 0; this.readyState = 0;
      var ev = { target: this };
      try { if (this.onabort)   this.onabort(ev); }   catch(_) {}
      try { if (this.onloadend) this.onloadend(ev); }  catch(_) {}
    }

    addEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      var ltype = type.toLowerCase();
      if (ltype === 'load')        this.onload           = fn as any;
      else if (ltype === 'error')  this.onerror          = fn as any;
      else if (ltype === 'abort')  this.onabort          = fn as any;
      else if (ltype === 'timeout') this.ontimeout       = fn as any;
      else if (ltype === 'progress') this.onprogress     = fn as any;
      else if (ltype === 'loadstart') this.onloadstart   = fn as any;
      else if (ltype === 'loadend')   this.onloadend     = fn as any;
      else if (ltype === 'readystatechange') this.onreadystatechange = fn as any;
      var arr = this._listeners.get(type); if (!arr) { arr = []; this._listeners.set(type, arr); }
      if (!arr.includes(fn)) arr.push(fn);
    }
    removeEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      var arr = this._listeners.get(type); if (arr) { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    }
  }

  // ── console ───────────────────────────────────────────────────────────────

  function _fmt(v: unknown): string {
    if (v === null) return 'null'; if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }

  var _consoleCounts: Map<string, number> = new Map();
  var _consoleTimers: Map<string, number> = new Map();

  var console_ = {
    log(...a: unknown[]):   void { cb.log('[JS] ' + a.map(_fmt).join(' ')); },
    info(...a: unknown[]):  void { cb.log('[JS info] ' + a.map(_fmt).join(' ')); },
    warn(...a: unknown[]):  void { cb.log('[JS warn] ' + a.map(_fmt).join(' ')); },
    error(...a: unknown[]): void { cb.log('[JS err] ' + a.map(_fmt).join(' ')); },
    debug(...a: unknown[]): void { cb.log('[JS dbg] ' + a.map(_fmt).join(' ')); },
    dir(v: unknown, _opts?: unknown): void { cb.log('[JS dir] ' + _fmt(v)); },
    dirxml(v: unknown):     void { cb.log('[JS dir] ' + _fmt(v)); },
    table(v: unknown):      void {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        var keys = Object.keys(v[0] as object);
        cb.log('[JS tbl] ' + keys.join(' | '));
        for (var row of v) cb.log('[JS tbl] ' + keys.map(k => String((row as any)[k] ?? '')).join(' | '));
      } else { cb.log('[JS tbl] ' + _fmt(v)); }
    },
    assert(cond: boolean, ...a: unknown[]): void { if (!cond) cb.log('[JS assert] ' + (a.length ? a.map(_fmt).join(' ') : 'Assertion failed')); },
    count(label = 'default'): void { var n = (_consoleCounts.get(label) ?? 0) + 1; _consoleCounts.set(label, n); cb.log('[JS] ' + label + ': ' + n); },
    countReset(label = 'default'): void { _consoleCounts.set(label, 0); },
    time(label = 'default'): void { _consoleTimers.set(label, Date.now()); },
    timeEnd(label = 'default'): void { var t = _consoleTimers.get(label); if (t !== undefined) cb.log('[JS] ' + label + ': ' + (Date.now() - t) + 'ms'); _consoleTimers.delete(label); },
    timeLog(label = 'default'): void { var t = _consoleTimers.get(label); if (t !== undefined) cb.log('[JS] ' + label + ': ' + (Date.now() - t) + 'ms'); },
    group(...a: unknown[]):     void { cb.log('[JS grp] ' + (a.length ? a.map(_fmt).join(' ') : '')); },
    groupCollapsed(...a: unknown[]): void { cb.log('[JS grp] ' + (a.length ? a.map(_fmt).join(' ') : '')); },
    groupEnd():             void {},
    trace(...a: unknown[]): void { cb.log('[JS trace] ' + a.map(_fmt).join(' ')); },
    clear():                void {},
  };

  // ── url resolution helper ─────────────────────────────────────────────────

  function _resolveURL(href: string, base: string): string {
    if (/^[a-z][a-z0-9+\-.]*:/.test(href)) return href;  // absolute URL
    var m = /^(([a-z][a-z0-9+\-.]*:)?\/\/[^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(base);
    if (!m) return href;
    var origin = m[1] || '';
    var basePath = m[3] || '/';
    if (href.startsWith('//')) return (m[2] || 'http:') + href;
    if (href.startsWith('/')) return origin + href;
    if (href.startsWith('#')) return origin + basePath + (m[4] || '') + href;
    if (href.startsWith('?')) return origin + basePath + href;
    var dir = basePath.replace(/\/[^/]*$/, '/');
    var parts = (dir + href).split('/'); var res: string[] = [];
    for (var p of parts) { if (p === '..') res.pop(); else if (p !== '.') res.push(p); }
    return origin + res.join('/');
  }

  // ── URLSearchParams (item 507) ────────────────────────────────────────────

  class URLSearchParamsImpl {
    _pairs: Array<[string, string]> = [];
    constructor(init?: string | URLSearchParamsImpl | Array<[string, string]> | Record<string, string>) {
      if (!init) return;
      if (typeof init === 'string') {
        var s = init.startsWith('?') ? init.slice(1) : init;
        for (var pair of s.split('&')) {
          if (!pair) continue;
          var eq = pair.indexOf('=');
          if (eq >= 0) this._pairs.push([decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' ')), decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))]);
          else this._pairs.push([decodeURIComponent(pair.replace(/\+/g, ' ')), '']);
        }
      } else if (init instanceof URLSearchParamsImpl) {
        this._pairs = [...init._pairs];
      } else if (Array.isArray(init)) {
        for (var item of init) this._pairs.push([String(item[0]), String(item[1])]);
      } else {
        for (var [k2, v2] of Object.entries(init as Record<string, string>)) this._pairs.push([k2, String(v2)]);
      }
    }
    get size(): number { return this._pairs.length; }
    append(k: string, v: string): void { this._pairs.push([k, v]); }
    set(k: string, v: string): void {
      var found = false;
      this._pairs = this._pairs.filter(p => { if (p[0] === k) { if (!found) { found = true; p[1] = v; return true; } return false; } return true; });
      if (!found) this._pairs.push([k, v]);
    }
    get(k: string): string | null { var p = this._pairs.find(p2 => p2[0] === k); return p ? p[1] : null; }
    getAll(k: string): string[] { return this._pairs.filter(p => p[0] === k).map(p => p[1]); }
    has(k: string, v?: string): boolean { return v !== undefined ? this._pairs.some(p => p[0] === k && p[1] === v) : this._pairs.some(p => p[0] === k); }
    delete(k: string, v?: string): void { this._pairs = v !== undefined ? this._pairs.filter(p => !(p[0] === k && p[1] === v)) : this._pairs.filter(p => p[0] !== k); }
    sort(): void { this._pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
    keys():    IterableIterator<string> { return this._pairs.map(p => p[0])[Symbol.iterator](); }
    values():  IterableIterator<string> { return this._pairs.map(p => p[1])[Symbol.iterator](); }
    entries(): IterableIterator<[string, string]> { return (this._pairs as Array<[string, string]>)[Symbol.iterator](); }
    forEach(fn: (v: string, k: string, self: URLSearchParamsImpl) => void): void { for (var [k, v] of this._pairs) fn(v, k, this); }
    [Symbol.iterator]() { return this.entries(); }
    toString(): string { return this._pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
  }

  // ── URL class (item 506) ──────────────────────────────────────────────────

  class URLImpl {
    _protocol = ''; _username = ''; _password = ''; _hostname = ''; _port = '';
    _pathname = '/'; _search = ''; _hash = ''; _host = '';

    constructor(href: string, base?: string) {
      if (!href) throw new TypeError('Invalid URL: empty');
      var h = (typeof base === 'string' && base) ? _resolveURL(href, base) : href;
      this._parseStr(h);
    }

    _parseStr(href: string): void {
      // hash
      var hi = href.indexOf('#');
      if (hi >= 0) { this._hash = href.slice(hi); href = href.slice(0, hi); } else { this._hash = ''; }
      // search
      var qi = href.indexOf('?');
      if (qi >= 0) { this._search = href.slice(qi); href = href.slice(0, qi); } else { this._search = ''; }
      // protocol
      var pi = href.indexOf('://');
      if (pi >= 0) { this._protocol = href.slice(0, pi + 1); href = href.slice(pi + 3); }
      else if (href.startsWith('//')) { this._protocol = 'http:'; href = href.slice(2); }
      else if (href.startsWith('data:') || href.startsWith('blob:') || href.startsWith('javascript:')) {
        var ci = href.indexOf(':'); this._protocol = href.slice(0, ci + 1); this._pathname = href.slice(ci + 1);
        this._host = ''; this._hostname = ''; this._port = ''; return;
      }
      else { throw new TypeError('Invalid URL: ' + href); }
      // split host/path
      var si = href.indexOf('/');
      var hostPart = si >= 0 ? href.slice(0, si) : href;
      this._pathname = si >= 0 ? href.slice(si) : '/';
      // credentials
      var ai = hostPart.lastIndexOf('@');
      if (ai >= 0) {
        var cred = hostPart.slice(0, ai).split(':');
        this._username = decodeURIComponent(cred[0] ?? ''); this._password = decodeURIComponent(cred[1] ?? '');
        hostPart = hostPart.slice(ai + 1);
      }
      // port
      var portI = hostPart.lastIndexOf(':');
      if (portI >= 0 && !hostPart.startsWith('[')) { this._hostname = hostPart.slice(0, portI).toLowerCase(); this._port = hostPart.slice(portI + 1); }
      else { this._hostname = hostPart.toLowerCase(); this._port = ''; }
      this._host = this._hostname + (this._port ? ':' + this._port : '');
    }

    _recompute(): void { /* href is computed on get */ }

    get href(): string {
      var auth = this._username ? encodeURIComponent(this._username) + (this._password ? ':' + encodeURIComponent(this._password) : '') + '@' : '';
      return this._protocol + '//' + auth + this._host + this._pathname + this._search + this._hash;
    }
    set href(v: string) { this._parseStr(v); }
    get protocol(): string { return this._protocol; }
    set protocol(v: string) { this._protocol = v.endsWith(':') ? v : v + ':'; }
    get username(): string { return this._username; }
    set username(v: string) { this._username = v; }
    get password(): string { return this._password; }
    set password(v: string) { this._password = v; }
    get host(): string { return this._host; }
    get hostname(): string { return this._hostname; }
    set hostname(v: string) { this._hostname = v.toLowerCase(); this._host = this._hostname + (this._port ? ':' + this._port : ''); }
    get port(): string { return this._port; }
    set port(v: string) { this._port = v; this._host = this._hostname + (v ? ':' + v : ''); }
    get pathname(): string { return this._pathname; }
    set pathname(v: string) { this._pathname = v.startsWith('/') ? v : '/' + v; }
    get search(): string { return this._search; }
    set search(v: string) { this._search = v ? (v.startsWith('?') ? v : '?' + v) : ''; }
    get hash(): string { return this._hash; }
    set hash(v: string) { this._hash = v ? (v.startsWith('#') ? v : '#' + v) : ''; }
    get origin(): string { return this._protocol + '//' + this._host; }
    get searchParams(): URLSearchParamsImpl {
      // Return a live URLSearchParams that writes back to this URL's _search on mutation
      var sp = new URLSearchParamsImpl(this._search ? this._search.slice(1) : '');
      var urlRef = this;
      function syncBack(): void { urlRef._search = sp._pairs.length ? '?' + sp.toString() : ''; }
      var orig_set     = sp.set.bind(sp);
      var orig_append  = sp.append.bind(sp);
      var orig_delete  = sp.delete.bind(sp);
      var orig_sort    = sp.sort.bind(sp);
      sp.set    = (k: string, v: string) => { orig_set(k, v); syncBack(); };
      sp.append = (k: string, v: string) => { orig_append(k, v); syncBack(); };
      sp.delete = (k: string, v?: string) => { orig_delete(k, v); syncBack(); };
      sp.sort   = () => { orig_sort(); syncBack(); };
      return sp;
    }
    toString(): string { return this.href; }
    toJSON(): string { return this.href; }

    static createObjectURL(b: unknown): string {
      var url = 'blob:jsos/' + Math.random().toString(36).slice(2);
      if (b instanceof Blob) {
        // Store blob content for browser navigation (item 639)
        _blobStore.set(url, { content: b._parts.join(''), type: b.type || 'text/html' });
      }
      return url;
    }
    static revokeObjectURL(u: string): void { _blobStore.delete(u); }
    static canParse(url: string, base?: string): boolean { try { new URLImpl(url, base); return true; } catch (_) { return false; } }
    static parse(url: string, base?: string): URLImpl | null { try { return new URLImpl(url, base); } catch (_) { return null; } }
  }

  // ── Blob / File ───────────────────────────────────────────────────────────

  class Blob {
    _parts: string[]; type: string; size: number;
    constructor(parts: (string | Uint8Array | ArrayBuffer)[] = [], opts?: { type?: string }) {
      this.type = opts?.type || '';
      this._parts = parts.map(p => typeof p === 'string' ? p : typeof TextDecoder_ !== 'undefined' ? new TextDecoder_().decode(p instanceof ArrayBuffer ? new Uint8Array(p) : p) : '');
      this.size = this._parts.reduce((s, p) => s + p.length, 0);
    }
    text(): Promise<string> { return Promise.resolve(this._parts.join('')); }
    arrayBuffer(): Promise<ArrayBuffer> { var s = this._parts.join(''); var b = new ArrayBuffer(s.length); var v = new Uint8Array(b); for (var i = 0; i < s.length; i++) v[i] = s.charCodeAt(i) & 0xff; return Promise.resolve(b); }
    slice(start = 0, end?: number, contentType = ''): Blob { var s = this._parts.join('').slice(start, end); return new Blob([s], { type: contentType || this.type }); }
    stream(): unknown { return null; }
  }

  class File extends Blob {
    name: string; lastModified: number;
    constructor(parts: (string | Uint8Array | ArrayBuffer)[], name: string, opts?: { type?: string; lastModified?: number }) {
      super(parts, opts); this.name = name; this.lastModified = opts?.lastModified ?? Date.now();
    }
  }

  // ── FileList stub (item 531 adjacent) ─────────────────────────────────────

  class FileList_ {
    _files: File[];
    constructor(files: File[] = []) { this._files = files; }
    get length(): number { return this._files.length; }
    item(index: number): File | null { return this._files[index] ?? null; }
    [Symbol.iterator](): Iterator<File> { return this._files[Symbol.iterator](); }
  }

  // ── FileReader (item 531) ─────────────────────────────────────────────────

  class FileReader_ {
    static EMPTY  = 0; static LOADING = 1; static DONE = 2;
    EMPTY  = 0; LOADING = 1; DONE = 2;
    readyState = 0;
    result: string | ArrayBuffer | null = null;
    error: DOMException | null = null;
    onload:       ((ev: any) => void) | null = null;
    onerror:      ((ev: any) => void) | null = null;
    onabort:      ((ev: any) => void) | null = null;
    onloadstart:  ((ev: any) => void) | null = null;
    onloadend:    ((ev: any) => void) | null = null;
    onprogress:   ((ev: any) => void) | null = null;
    _aborted = false;
    _listeners: Map<string, Array<(ev: any) => void>> = new Map();

    addEventListener(type: string, fn: (ev: any) => void): void {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: (ev: any) => void): void {
      var lst = this._listeners.get(type); if (!lst) return;
      this._listeners.set(type, lst.filter(f => f !== fn));
    }
    _fire(type: string, extra?: Record<string, unknown>): void {
      var ev = { type, target: this, loaded: 0, total: 0, lengthComputable: false, ...extra };
      var on = (this as any)['on' + type]; if (typeof on === 'function') on.call(this, ev);
      var lst = this._listeners.get(type); if (lst) for (var fn of lst) fn.call(this, ev);
    }

    _read(blob: Blob, asArrayBuffer: boolean, encoding?: string): void {
      this.readyState = 1; this._aborted = false; this._fire('loadstart');
      blob.text().then(text => {
        if (this._aborted) { this.result = null; this.readyState = 2; this._fire('abort'); this._fire('loadend'); return; }
        if (asArrayBuffer) {
          var ab = new ArrayBuffer(text.length);
          var v = new Uint8Array(ab);
          for (var i = 0; i < text.length; i++) v[i] = text.charCodeAt(i) & 0xff;
          this.result = ab;
        } else {
          this.result = text;
        }
        this.readyState = 2; this._fire('load'); this._fire('loadend');
      }).catch(err => {
        this.error = err instanceof DOMException ? err : new DOMException(String(err));
        this.readyState = 2; this._fire('error'); this._fire('loadend');
      });
    }

    readAsText(blob: Blob, _encoding = 'utf-8'): void { this._read(blob, false, _encoding); }
    readAsArrayBuffer(blob: Blob): void { this._read(blob, true); }
    readAsBinaryString(blob: Blob): void { this._read(blob, false); }
    readAsDataURL(blob: Blob): void {
      blob.arrayBuffer().then(ab => {
        if (this._aborted) { this.result = null; this.readyState = 2; this._fire('abort'); this._fire('loadend'); return; }
        var bytes = new Uint8Array(ab);
        var b64 = btoa(String.fromCharCode(...bytes));
        this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + b64;
        this.readyState = 2; this._fire('load'); this._fire('loadend');
      }).catch(err => {
        this.error = err instanceof DOMException ? err : new DOMException(String(err));
        this.readyState = 2; this._fire('error'); this._fire('loadend');
      });
    }
    abort(): void { this._aborted = true; }
  }

  var URL_ = URLImpl;

  // ── FormData (item 503) ───────────────────────────────────────────────

  class FormData_ {
    _fields: Array<[string, string, string?]> = [];
    constructor(form?: VElement) {
      if (form) {
        var inputs = form.querySelectorAll('input,textarea,select');
        for (var el of inputs) {
          var nm = el.getAttribute('name'); if (!nm) continue;
          var tp = (el.getAttribute('type') || '').toLowerCase();
          if ((tp === 'checkbox' || tp === 'radio') && !el.checked) continue;
          this._fields.push([nm, el.value ?? '']);
        }
      }
    }
    append(name: string, value: string, filename?: string): void { this._fields.push([name, String(value), filename]); }
    set(name: string, value: string, filename?: string): void {
      this._fields = this._fields.filter(f => f[0] !== name);
      this._fields.push([name, String(value), filename]);
    }
    get(name: string): string | null { var f = this._fields.find(f2 => f2[0] === name); return f ? f[1] : null; }
    getAll(name: string): string[] { return this._fields.filter(f => f[0] === name).map(f => f[1]); }
    has(name: string): boolean { return this._fields.some(f => f[0] === name); }
    delete(name: string): void { this._fields = this._fields.filter(f => f[0] !== name); }
    entries(): IterableIterator<[string, string]> { return (this._fields.map(f => [f[0], f[1]] as [string, string]))[Symbol.iterator](); }
    keys():    IterableIterator<string> { return (this._fields.map(f => f[0]))[Symbol.iterator](); }
    values():  IterableIterator<string> { return (this._fields.map(f => f[1]))[Symbol.iterator](); }
    forEach(fn: (value: string, name: string, fd: FormData_) => void): void { for (var f of this._fields) fn(f[1], f[0], this); }
    [Symbol.iterator]() { return this.entries(); }
  }

  // ── Headers (item 508) ───────────────────────────────────────────────────

  class Headers_ {
    _map: Map<string, string> = new Map();
    constructor(init?: Record<string, string> | Array<[string, string]> | Headers_) {
      if (init instanceof Headers_) { init._map.forEach((v, k) => this._map.set(k, v)); }
      else if (Array.isArray(init)) { for (var kv of (init as Array<[string, string]>)) this.append(kv[0], kv[1]); }
      else if (init) { for (var k in init) this.append(k, (init as Record<string, string>)[k]); }
    }
    get(name: string): string | null    { return this._map.get(name.toLowerCase()) ?? null; }
    set(name: string, value: string): void { this._map.set(name.toLowerCase(), String(value)); }
    append(name: string, value: string): void {
      var k = name.toLowerCase(); var ex = this._map.get(k);
      this._map.set(k, ex !== undefined ? ex + ', ' + value : String(value));
    }
    delete(name: string): void         { this._map.delete(name.toLowerCase()); }
    has(name: string): boolean          { return this._map.has(name.toLowerCase()); }
    entries(): IterableIterator<[string, string]> { return this._map.entries(); }
    keys():    IterableIterator<string>  { return this._map.keys(); }
    values():  IterableIterator<string>  { return this._map.values(); }
    forEach(fn: (value: string, name: string, h: Headers_) => void): void { this._map.forEach((v, k) => fn(v, k, this)); }
    [Symbol.iterator]() { return this._map.entries(); }
  }

  // ── MutationObserver ─────────────────────────────────────────────────────

  var _mutationObservers: MutationObserverImpl[] = [];

  interface MutationObsRecord { target: VElement; subtree?: boolean; childList?: boolean; attributes?: boolean; attributeFilter?: string[]; characterData?: boolean; attributeOldValue?: boolean; characterDataOldValue?: boolean; }

  class MutationObserverImpl {
    _fn:      (mutations: unknown[], obs: MutationObserverImpl) => void;
    _records: unknown[] = [];
    _active   = false;
    _watching: MutationObsRecord[] = [];
    constructor(fn: (mutations: unknown[], obs: MutationObserverImpl) => void) { this._fn = fn; }
    observe(node: unknown, opts?: Partial<MutationObsRecord>): void {
      this._active = true;
      var rec: MutationObsRecord = {
        target:            node as VElement,
        subtree:           !!(opts as any)?.subtree,
        childList:         !!(opts as any)?.childList,
        attributes:        !!(opts as any)?.attributes,
        attributeFilter:   (opts as any)?.attributeFilter,
        characterData:     !!(opts as any)?.characterData,
        attributeOldValue: !!(opts as any)?.attributeOldValue,
        characterDataOldValue: !!(opts as any)?.characterDataOldValue,
      };
      // Remove existing record for same node, then add updated
      this._watching = this._watching.filter(w => w.target !== node);
      this._watching.push(rec);
      if (!_mutationObservers.includes(this)) _mutationObservers.push(this);
    }
    disconnect(): void {
      this._active = false; this._watching = [];
      var i = _mutationObservers.indexOf(this);
      if (i >= 0) _mutationObservers.splice(i, 1);
    }
    takeRecords(): unknown[] { var r = this._records; this._records = []; return r; }
    _flush(): void {
      if (!this._active || this._records.length === 0) return;
      var r = this._records; this._records = [];
      try { this._fn(r, this); } catch (_) {}
    }
    _shouldRecord(mut: any): boolean {
      if (this._watching.length === 0) return true; // no targets = observe all (legacy compat)
      for (var w of this._watching) {
        var tgt = w.target as VElement | null;
        var matches = false;
        if (tgt === mut.target) {
          matches = true;
        } else if (w.subtree && tgt) {
          // Check if mut.target is a descendant of tgt
          var n: any = mut.target;
          while (n) { if (n === tgt) { matches = true; break; } n = n.parentNode; }
        }
        if (!matches) continue;
        // Check type filter
        if (mut.type === 'childList' && w.childList) return true;
        if (mut.type === 'attributes' && w.attributes) {
          if (!w.attributeFilter || w.attributeFilter.includes(mut.attributeName)) return true;
        }
        if (mut.type === 'characterData' && w.characterData) return true;
      }
      return false;
    }
    _record(rec: unknown): void { if (this._shouldRecord(rec)) this._records.push(rec); }
  }

  function _flushMutationObservers(mutations: unknown[]): void {
    if (_mutationObservers.length === 0 || mutations.length === 0) return;
    for (var o of _mutationObservers) {
      for (var m of mutations) o._record(m);
      o._flush();
    }
  }

  // ── IntersectionObserver ─────────────────────────────────────────────────

  class IntersectionObserverImpl {
    _fn:       (entries: unknown[], obs: IntersectionObserverImpl) => void;
    _elements: VElement[] = [];
    _threshold: number;
    constructor(fn: (entries: unknown[], obs: IntersectionObserverImpl) => void, opts?: { threshold?: number }) {
      this._fn = fn; this._threshold = opts?.threshold ?? 0;
    }
    observe(el: unknown): void   { if (el instanceof VElement) this._elements.push(el); }
    unobserve(el: unknown): void { this._elements = this._elements.filter(e => e !== el); }
    disconnect(): void           { this._elements = []; }
    /** Called by tick to fire entries for elements that have entered the viewport. */
    _tick(viewportH: number): void {
      if (this._elements.length === 0) return;
      var entries: unknown[] = [];
      for (var el of this._elements) {
        var rect = el.getBoundingClientRect?.() ?? { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
        var intersecting = rect.bottom > 0 && rect.top < viewportH;
        entries.push({
          isIntersecting: intersecting,
          intersectionRatio: intersecting ? 1 : 0,
          boundingClientRect: rect,
          intersectionRect:   rect,
          rootBounds:         { top: 0, left: 0, bottom: viewportH, right: 1024, width: 1024, height: viewportH },
          target: el,
          time: _perf.now(),
        });
      }
      if (entries.length > 0) try { this._fn(entries, this); } catch (_) {}
    }
  }

  var _ioObservers: IntersectionObserverImpl[] = [];

  // ── ResizeObserver ────────────────────────────────────────────────────────

  class ResizeObserverImpl {
    _fn:       (entries: unknown[]) => void;
    _elements: VElement[] = [];
    _lastSizes = new WeakMap<VElement, { w: number; h: number }>();
    constructor(fn: (entries: unknown[]) => void) { this._fn = fn; }
    observe(el: unknown): void   { if (el instanceof VElement) this._elements.push(el); }
    unobserve(el: unknown): void { this._elements = this._elements.filter(e => e !== el); }
    disconnect(): void           { this._elements = []; }
    _tick(): void {
      var entries: unknown[] = [];
      for (var el of this._elements) {
        var r = el.getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, left: 0 };
        var prev = this._lastSizes.get(el);
        if (!prev || prev.w !== r.width || prev.h !== r.height) {
          this._lastSizes.set(el, { w: r.width, h: r.height });
          entries.push({ target: el, contentRect: r,
            borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }],
            contentBoxSize:[{ inlineSize: r.width, blockSize: r.height }] });
        }
      }
      if (entries.length > 0) try { this._fn(entries); } catch (_) {}
    }
  }

  var _roObservers: ResizeObserverImpl[] = [];

  // ── AbortController / AbortSignal (item 540) ──────────────────────────────

  class AbortSignalImpl {
    aborted = false;
    reason: unknown = undefined;
    onabort: ((ev: unknown) => void) | null = null;
    _listeners: Array<(ev: unknown) => void> = [];
    addEventListener(_type: string, fn: (ev: unknown) => void, _opts?: unknown): void { this._listeners.push(fn); }
    removeEventListener(_type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      this._listeners = this._listeners.filter(f => f !== fn);
    }
    throwIfAborted(): void { if (this.aborted) throw this.reason; }
    _abort(reason?: unknown): void {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason !== undefined ? reason : new Error('AbortError');
      var ev = { type: 'abort', target: this };
      if (this.onabort) try { this.onabort(ev); } catch (_) {}
      for (var fn of this._listeners) try { fn(ev); } catch (_) {}
    }
    static timeout(ms: number): AbortSignalImpl {
      var s = new AbortSignalImpl();
      setTimeout(() => s._abort(new Error('TimeoutError')), ms);
      return s;
    }
    static abort(reason?: unknown): AbortSignalImpl {
      var s = new AbortSignalImpl();
      s._abort(reason);
      return s;
    }
  }

  class AbortControllerImpl {
    signal = new AbortSignalImpl();
    abort(reason?: unknown): void { this.signal._abort(reason); }
  }

  // ── IndexedDB stub (item 502) ─────────────────────────────────────────────

  class IDBRequest_ { result: unknown = undefined; error: unknown = null; readyState = 'pending'; onsuccess: ((ev: unknown) => void) | null = null; onerror: ((ev: unknown) => void) | null = null;
    _succeed(r: unknown): void { this.result = r; this.readyState = 'done'; if (this.onsuccess) setTimeout(() => { try { this.onsuccess!({ target: this }); } catch(_) {} }, 0); }
    _fail(e: Error): void { this.error = e; this.readyState = 'done'; if (this.onerror) setTimeout(() => { try { this.onerror!({ target: this }); } catch(_) {} }, 0); }
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (type === 'success') this.onsuccess = fn; if (type === 'error') this.onerror = fn; }
    removeEventListener(): void {}
  }

  class IDBObjectStore_ {
    _name: string; _db: IDBDatabase_; _data: Map<unknown, unknown>;
    constructor(name: string, db: IDBDatabase_) { this._name = name; this._db = db; this._data = db._stores.get(name) ?? new Map(); db._stores.set(name, this._data); }
    put(value: unknown, key?: unknown): IDBRequest_ { var r = new IDBRequest_(); var k = key ?? (typeof value === 'object' && value ? (value as any)[this._db._keyPaths.get(this._name) ?? 'id'] : undefined) ?? Date.now(); this._data.set(k, value); r._succeed(k); return r; }
    add(value: unknown, key?: unknown): IDBRequest_ { return this.put(value, key); }
    get(key: unknown): IDBRequest_ { var r = new IDBRequest_(); r._succeed(this._data.get(key)); return r; }
    getAll(_range?: unknown, _count?: unknown): IDBRequest_ { var r = new IDBRequest_(); r._succeed([...this._data.values()]); return r; }
    getAllKeys(_range?: unknown, _count?: unknown): IDBRequest_ { var r = new IDBRequest_(); r._succeed([...this._data.keys()]); return r; }
    delete(key: unknown): IDBRequest_ { var r = new IDBRequest_(); this._data.delete(key); r._succeed(undefined); return r; }
    clear(): IDBRequest_ { var r = new IDBRequest_(); this._data.clear(); r._succeed(undefined); return r; }
    count(_range?: unknown): IDBRequest_ { var r = new IDBRequest_(); r._succeed(this._data.size); return r; }
    index(_name: string): IDBObjectStore_ { return this; }
    openCursor(_range?: unknown, _dir?: string): IDBRequest_ { var r = new IDBRequest_(); var vals = [...this._data.entries()]; var i = 0; var cursor = vals.length > 0 ? { key: vals[0][0], value: vals[0][1], continue() { i++; r.result = i < vals.length ? ({ key: vals[i][0], value: vals[i][1], continue: cursor!.continue } as unknown) : null; if (r.onsuccess) setTimeout(() => r.onsuccess!({ target: r }), 0); } } : null; r.result = cursor; setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
    createIndex(_name: string, _keyPath: string, _opts?: unknown): IDBObjectStore_ { return this; }
  }

  class IDBTransaction_ {
    _db: IDBDatabase_; _mode: string;
    constructor(db: IDBDatabase_, _storeNames: string[], mode: string) { this._db = db; this._mode = mode; }
    objectStore(name: string): IDBObjectStore_ { return new IDBObjectStore_(name, this._db); }
    oncomplete: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onabort: ((ev: unknown) => void) | null = null;
    abort(): void {}
    commit(): void {}
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (type === 'complete') this.oncomplete = fn; if (type === 'error') this.onerror = fn; }
    removeEventListener(): void {}
  }

  class IDBDatabase_ {
    name: string; version: number; _stores: Map<string, Map<unknown, unknown>> = new Map(); _keyPaths: Map<string, string> = new Map();
    objectStoreNames: { contains(n: string): boolean } = { contains: (n: string) => this._stores.has(n) };
    onversionchange: ((ev: unknown) => void) | null = null;
    constructor(name: string, version: number) { this.name = name; this.version = version; }
    createObjectStore(name: string, opts?: { keyPath?: string; autoIncrement?: boolean }): IDBObjectStore_ {
      if (!this._stores.has(name)) this._stores.set(name, new Map());
      if (opts?.keyPath) this._keyPaths.set(name, opts.keyPath);
      return new IDBObjectStore_(name, this);
    }
    deleteObjectStore(name: string): void { this._stores.delete(name); }
    transaction(storeNames: string | string[], mode = 'readonly'): IDBTransaction_ {
      return new IDBTransaction_(this, typeof storeNames === 'string' ? [storeNames] : storeNames, mode);
    }
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  // Simple in-memory IDB registry
  var _idbDatabases = new Map<string, IDBDatabase_>();
  var _indexedDB = {
    open(name: string, version = 1): IDBRequest_ {
      var r = new IDBRequest_();
      var existing = _idbDatabases.get(name);
      var db: IDBDatabase_;
      if (!existing) {
        db = new IDBDatabase_(name, version);
        _idbDatabases.set(name, db);
        // Fire onupgradeneeded synchronously (after microtask)
        setTimeout(() => {
          if ((r as any).onupgradeneeded) try { (r as any).onupgradeneeded({ target: r, oldVersion: 0, newVersion: version }); } catch(_) {}
          r._succeed(db);
        }, 0);
      } else {
        db = existing;
        setTimeout(() => r._succeed(db), 0);
      }
      return Object.assign(r, { onupgradeneeded: null as ((ev: unknown) => void) | null });
    },
    deleteDatabase(name: string): IDBRequest_ { var r = new IDBRequest_(); _idbDatabases.delete(name); r._succeed(undefined); return r; },
    databases(): Promise<Array<{ name: string; version: number }>> { return Promise.resolve([..._idbDatabases.values()].map(d => ({ name: d.name, version: d.version }))); },
    cmp(a: unknown, b: unknown): number { return a < b ? -1 : a > b ? 1 : 0; },
  };

  // ── Intl stub (item 546) ──────────────────────────────────────────────────

  var Intl_: any = (typeof Intl !== 'undefined') ? Intl : {
    DateTimeFormat: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      format(d: Date): string { return d instanceof Date ? d.toLocaleString() : String(d); }
      formatToParts(d: Date): Array<{type: string; value: string}> { return [{ type: 'literal', value: String(d) }]; }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    NumberFormat: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      format(n: number): string { return String(n); }
      formatToParts(n: number): Array<{type: string; value: string}> { return [{ type: 'integer', value: String(n) }]; }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    Collator: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    PluralRules: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      select(n: number): string { return n === 1 ? 'one' : 'other'; }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    RelativeTimeFormat: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      format(v: number, u: string): string { return `${Math.abs(v)} ${u}${Math.abs(v) !== 1 ? 's' : ''} ${v < 0 ? 'ago' : 'from now'}`; }
      formatToParts(v: number, u: string): Array<{type: string; value: string}> { return [{ type: 'literal', value: this.format(v, u) }]; }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    ListFormat: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      format(list: string[]): string { return list.join(', '); }
      formatToParts(list: string[]): Array<{type: string; value: string}> { return list.map(v => ({ type: 'element', value: v })); }
      resolvedOptions(): object { return {}; }
      static supportedLocalesOf(): string[] { return []; }
    },
    getCanonicalLocales(locales: string | string[]): string[] { return Array.isArray(locales) ? locales : [locales]; },
    supportedValuesOf(_key: string): string[] { return []; },
  };

  // ── CSSStyleSheet O(1) rule index helper (item 943) ───────────────────────
  // Extracts the "key selector" from a complex selector — the rightmost simple
  // selector part that is most selective (#id > .class > tag > *).
  // Used to bucket CSSStyleRule_ entries so getComputedStyle can look up only
  // rules that COULD match the element instead of scanning the full rule list.
  function _getRuleIndexKey(sel: string): string {
    // 1. Strip pseudo-elements and pseudo-classes (keep :not content for specificity)
    var s = sel.replace(/::?[a-z][a-z-]*(?:\([^)]*\))?/gi, '')
               .replace(/\[[^\]]*\]/g, '')  // remove attribute selectors
               .trim();
    // 2. Split on combinators (space, >, +, ~) and take the last component
    var parts = s.split(/\s+|\s*[>+~]\s*/);
    var last = (parts[parts.length - 1] || s).trim();
    // 3. Priority: #id > .class > tag > *
    var idM = last.match(/#([\w-]+)/);
    if (idM) return '#' + idM[1];
    var clsM = last.match(/\.([\w-]+)/);
    if (clsM) return '.' + clsM[1];
    var tagM = last.match(/^([a-z][\w-]*)/i);
    if (tagM && tagM[1].toLowerCase() !== '*') return tagM[1].toLowerCase();
    return '*'; // universal
  }

  // ── CSSStyleSheet (items 578-579) ─────────────────────────────────────────

  class CSSStyleSheet_ {
    cssRules: Array<CSSRule_ | CSSStyleRule_ | CSSMediaRule_ | CSSKeyframesRule_> = [];
    href: string | null = null;
    ownerNode:  unknown = null;
    disabled = false;
    media: { mediaText: string; length: number } = { mediaText: '', length: 0 };
    type = 'text/css';
    _pendingImports: string[] = [];
    /** O(1) rule index: key → CSSStyleRule_[] (item 943) */
    _ruleIdx: Map<string, CSSStyleRule_[]> = new Map();

    /** Add or remove a CSSStyleRule_ from the bucket index.
     * Buckets are kept sorted ascending by _spec (item 946: pre-sorted rule list). */
    _idxRule(r: CSSStyleRule_, remove = false): void {
      var sels = r.selectorText.split(',');
      var seen = new Set<string>();
      for (var i = 0; i < sels.length; i++) {
        var key = _getRuleIndexKey(sels[i].trim());
        if (seen.has(key)) continue; seen.add(key);
        if (remove) {
          var lst = this._ruleIdx.get(key);
          if (lst) { var ii = lst.indexOf(r); if (ii >= 0) lst.splice(ii, 1); }
        } else {
          var lst2 = this._ruleIdx.get(key);
          if (!lst2) { lst2 = []; this._ruleIdx.set(key, lst2); }
          // Insert in ascending _spec order (item 946: pre-sorted for cascade)
          var ins = lst2.length;
          while (ins > 0 && lst2[ins - 1]!._spec > r._spec) ins--;
          lst2.splice(ins, 0, r);
        }
      }
    }

    insertRule(rule: string, index = 0): number {
      var clampedIdx = Math.max(0, Math.min(index, this.cssRules.length));
      var mMedia = rule.trim().match(/^@media\s+([^{]+)\{([\s\S]*)\}\s*$/);
      var mKf    = rule.trim().match(/^@keyframes\s+(\S+)/);
      var rulObj: CSSRule_;
      if (mMedia) { rulObj = new CSSMediaRule_(mMedia[1].trim()); }
      else if (mKf) { rulObj = new CSSKeyframesRule_(mKf[1]); }
      else { var bIdx = rule.indexOf('{'); rulObj = bIdx >= 0 ? new CSSStyleRule_(rule.slice(0, bIdx).trim(), rule.slice(bIdx + 1).replace(/}$/, '').trim()) : new CSSStyleRule_(rule, ''); }
      rulObj.parentStyleSheet = this;
      this.cssRules.splice(clampedIdx, 0, rulObj);
      if (rulObj instanceof CSSStyleRule_) this._idxRule(rulObj as CSSStyleRule_);
      bumpStyleGeneration(); // item 944
      return clampedIdx;
    }
    deleteRule(index: number): void {
      if (index >= 0 && index < this.cssRules.length) {
        var removed = this.cssRules[index];
        this.cssRules.splice(index, 1);
        if (removed instanceof CSSStyleRule_) this._idxRule(removed as CSSStyleRule_, true);
        bumpStyleGeneration(); // item 944
      }
    }
    // Legacy IE methods
    addRule(selector: string, cssText: string, index?: number): number {
      return this.insertRule(selector + ' { ' + cssText + ' }', index ?? this.cssRules.length);
    }
    removeRule(index = 0): void { this.deleteRule(index); }
    replace(text: string): Promise<CSSStyleSheet_> { this._parseText(text); return Promise.resolve(this); }
    replaceSync(text: string): void { this._parseText(text); }

    _parseText(text: string): void {
      this.cssRules = []; this._pendingImports = [];
      // Strip block comments
      var stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
      var i = 0; var L = stripped.length;
      while (i < L) {
        // Skip whitespace
        while (i < L && stripped.charCodeAt(i) <= 32) i++;
        if (i >= L) break;
        // @charset / @namespace — skip to ;
        if (/^@(?:charset|namespace)\b/i.test(stripped.slice(i))) {
          var sc = stripped.indexOf(';', i); i = sc >= 0 ? sc + 1 : L; continue;
        }
        // @import — no block, ends with ;
        if (/^@import\b/i.test(stripped.slice(i))) {
          var sc2 = stripped.indexOf(';', i);
          var importSrc = stripped.slice(i, sc2 >= 0 ? sc2 + 1 : L);
          var urlM = importSrc.match(/@import\s+(?:url\(\s*)?['"]?([^'"()\s;]+)['"]?\s*\)?/i);
          if (urlM) { var ir2 = new CSSImportRule_(urlM[1]); ir2.parentStyleSheet = this; this.cssRules.push(ir2); this._pendingImports.push(urlM[1]); }
          i = sc2 >= 0 ? sc2 + 1 : L; continue;
        }
        // Find opening brace (or ; for property-less rules)
        var brace = -1; var j = i;
        while (j < L) {
          if (stripped[j] === '{') { brace = j; break; }
          if (stripped[j] === ';') { j++; break; }
          j++;
        }
        if (brace < 0) { i = j; continue; }
        // Collect selectors/at-rule header
        var hdr = stripped.slice(i, brace).trim();
        // Find matching closing brace (handles nesting)
        var depth2 = 1; var k = brace + 1;
        while (k < L && depth2 > 0) {
          if (stripped[k] === '{') depth2++;
          else if (stripped[k] === '}') depth2--;
          k++;
        }
        var body2 = stripped.slice(brace + 1, k - 1);
        i = k;
        if (!hdr) continue;
        var lhdr = hdr.toLowerCase();
        if (lhdr.startsWith('@media')) {
          var mr2 = new CSSMediaRule_(hdr.slice(6).trim()); mr2.parentStyleSheet = this;
          var inner2 = new CSSStyleSheet_(); inner2._parseText(body2); mr2.cssRules = inner2.cssRules;
          this.cssRules.push(mr2);
        } else if (lhdr.startsWith('@keyframes') || lhdr.startsWith('@-webkit-keyframes')) {
          var kr2 = new CSSKeyframesRule_(hdr.replace(/@-?(?:webkit-)?keyframes\s*/i, '').trim());
          kr2.parentStyleSheet = this;
          // Parse individual keyframe stops from body2
          var kfBody = body2.trim();
          var kfi = 0;
          while (kfi < kfBody.length) {
            while (kfi < kfBody.length && kfBody[kfi] <= ' ') kfi++;
            var kfSel = '';
            while (kfi < kfBody.length && kfBody[kfi] !== '{') kfSel += kfBody[kfi++];
            kfSel = kfSel.trim();
            if (kfi >= kfBody.length) break;
            kfi++; // consume {
            var kfDeclaration = '';
            var kfDepth = 1;
            while (kfi < kfBody.length && kfDepth > 0) {
              if (kfBody[kfi] === '{') kfDepth++;
              else if (kfBody[kfi] === '}') kfDepth--;
              if (kfDepth > 0) kfDeclaration += kfBody[kfi];
              kfi++;
            }
            if (kfSel) {
              var kfRule = new CSSKeyframeRule_(kfSel, kfDeclaration.trim());
              kfRule.parentStyleSheet = this; (kfRule as any).parentRule = kr2;
              kr2.cssRules.push(kfRule);
            }
          }
          this.cssRules.push(kr2);
        } else if (lhdr.startsWith('@supports')) {
          var sp2 = new CSSSupportsRule_(hdr.slice(9).trim()); sp2.parentStyleSheet = this;
          var inner3 = new CSSStyleSheet_(); inner3._parseText(body2); sp2.cssRules = inner3.cssRules;
          this.cssRules.push(sp2);
        } else if (lhdr.startsWith('@container')) {
          // [Item 438] @container queries
          var ctrHdr = hdr.slice(10).trim();
          var ctr2 = new CSSContainerRule_(ctrHdr); ctr2.parentStyleSheet = this;
          var inner5 = new CSSStyleSheet_(); inner5._parseText(body2); ctr2.cssRules = inner5.cssRules;
          this.cssRules.push(ctr2);
        } else if (lhdr.startsWith('@layer')) {
          // [Item 436] @layer cascade layers — proper layer-order tracking
          // Spec: unlayered styles win; among layers, later wins over earlier;
          // within a layer, later declaration wins.
          var layerName436 = lhdr.replace('@layer', '').trim();
          // Statement form: "@layer reset, base, theme;" (no body)
          if (!body2 || body2.trim() === '') {
            // Layer ordering declaration — register names in order
            layerName436.split(',').map((n: string) => n.trim()).filter(Boolean).forEach((n: string) => {
              if (!this._layerOrder) this._layerOrder = [];
              if (!this._layerOrder.includes(n)) this._layerOrder.push(n);
            });
          } else {
            // Block form: "@layer theme { ... }"
            if (!this._layerOrder) this._layerOrder = [];
            var lname = layerName436 || `__anon_${this._layerOrder.length}__`;
            if (!this._layerOrder.includes(lname)) this._layerOrder.push(lname);
            var innerLayer = new CSSStyleSheet_(); innerLayer._parseText(body2);
            var layerIdx = this._layerOrder.indexOf(lname);
            // Tag each inner rule with layerIndex for cascade resolution
            for (var lri = 0; lri < innerLayer.cssRules.length; lri++) {
              var lr = innerLayer.cssRules[lri] as any;
              lr._layerIndex = layerIdx;   // lower index = earlier layer = lower priority
              this.cssRules.push(lr);
            }
          }
        } else if (lhdr.startsWith('@font-face')) {
          var ffr2 = new CSSFontFaceRule_(body2.trim()); ffr2.parentStyleSheet = this; this.cssRules.push(ffr2);
          // Register font family so document.fonts is aware of it (item 430)
          var ffFamily = (ffr2.style as any)['font-family'];
          var ffSrc    = (ffr2.style as any)['src'];
          if (ffFamily) {
            var cleanFamily = ffFamily.replace(/^['"]|['"]$/g, '');
            var ff3 = new FontFace_(cleanFamily, ffSrc || '');
            _documentFonts.add(ff3);
          }
        } else if (!lhdr.startsWith('@')) {
          var sr2 = new CSSStyleRule_(hdr, body2.trim()); sr2.parentStyleSheet = this; this.cssRules.push(sr2); this._idxRule(sr2);
        }
      }
      bumpStyleGeneration(); // item 944 — new rules indexed, invalidate computed style cache
    }
  }

  // Pseudo-type for canvas context so TS doesn't complain
  type CSSStyleDeclarationStub = Record<string, string>;

  // ── CSS vendor prefix normalisation (item 866) ────────────────────────────
  // Maps common -webkit-/-moz- prefixed properties to their standard name.
  // If a rule sets a vendor-prefixed property we also set the standard name
  // (if not already set) so layout/render code only needs to check standard names.
  var _VENDOR_PREFIX_RE = /^-(?:webkit|moz|ms|o)-(.+)$/;
  function _normalizeCSSProp(prop: string): string {
    var m = _VENDOR_PREFIX_RE.exec(prop);
    return m ? m[1] : prop;
  }

  /** Set a CSS property and its vendor-normalised alias on a style object. */
  function _setCSSProp(styleObj: any, prop: string, val: string): void {
    styleObj[prop] = val;                       // keep original (required by getPropertyValue)
    var std = _normalizeCSSProp(prop);
    if (std !== prop && !styleObj[std]) {        // only fill standard if not yet set
      styleObj[std] = val;
    }
  }

  // ── CSS Rule subclasses (items 580-582) ───────────────────────────────────

  /** CSSRule — base class for all CSS rules */
  class CSSRule_ {
    static STYLE_RULE      = 1; static MEDIA_RULE   = 4; static FONT_FACE_RULE  = 5;
    static PAGE_RULE       = 6; static IMPORT_RULE   = 3; static CHARSET_RULE    = 2;
    static KEYFRAMES_RULE  = 7; static KEYFRAME_RULE = 8; static SUPPORTS_RULE   = 12;
    type = 0; cssText = ''; parentStyleSheet: CSSStyleSheet_ | null = null; parentRule: CSSRule_ | null = null;
  }

  /** CSSStyleRule — element-matched style rule (type=1) */
  class CSSStyleRule_ extends CSSRule_ {
    type = 1;
    selectorText = '';
    important: Set<string> | undefined;
    style: CSSStyleDeclarationStub & { cssText: string } = { cssText: '' } as any;
    /** Pre-computed max specificity across all comma-separated selectors (item 946). */
    _spec: number = 0;
    constructor(selector: string, body: string) {
      super();
      this.selectorText = selector;
      this.cssText = selector + ' { ' + body + ' }';
      // Compute max specificity for this rule once at construction (item 946)
      var selsForSpec = selector.split(',');
      for (var _si = 0; _si < selsForSpec.length; _si++) {
        var _s = selsForSpec[_si].trim();
        if (_s) { var _sp = _calcSpecificity(_s); if (_sp > this._spec) this._spec = _sp; }
      }
      // Populate style with property: value pairs; track !important
      body.split(';').forEach(pair => {
        var idx = pair.indexOf(':');
        if (idx < 0) return;
        var prop = pair.slice(0, idx).trim();
        var raw  = pair.slice(idx + 1).trim();
        if (!prop) return;
        var isImp = /!\s*important\s*$/i.test(raw);
        var val = isImp ? raw.replace(/!\s*important\s*$/i, '').trim() : raw;
        _setCSSProp(this.style as any, prop, val);
        if (isImp) { if (!this.important) this.important = new Set(); this.important.add(prop); }
      });
      this.style.cssText = body;
    }
  }

  /** CSSMediaRule — @media rule (type=4) */
  class CSSMediaRule_ extends CSSRule_ {
    type = 4;
    media: { mediaText: string; length: number; appendMedium(m: string): void; deleteMedium(m: string): void } = {
      mediaText: '', length: 0, appendMedium() {}, deleteMedium() {},
    };
    cssRules: CSSRule_[] = [];
    conditionText = '';
    constructor(conditionText: string) {
      super();
      this.conditionText = conditionText;
      this.media.mediaText = conditionText;
      this.cssText = '@media ' + conditionText + ' { }';
    }
    insertRule(rule: string, index = 0): number { this.cssRules.splice(index, 0, new CSSStyleRule_(rule, '')); return index; }
    deleteRule(index: number): void { this.cssRules.splice(index, 1); }
  }

  /** CSSKeyframesRule — @keyframes rule (type=7) */
  class CSSKeyframesRule_ extends CSSRule_ {
    type = 7;
    name = '';
    cssRules: CSSRule_[] = [];
    constructor(name: string) { super(); this.name = name; this.cssText = '@keyframes ' + name + ' { }'; }
    appendRule(rule: string): void { this.cssRules.push(new CSSStyleRule_(rule, '')); }
    deleteRule(select: string): void { this.cssRules = this.cssRules.filter(r => (r as any).keyText !== select); }
    findRule(select: string): CSSRule_ | null { return this.cssRules.find(r => (r as any).keyText === select) ?? null; }
  }

  /** CSSKeyframeRule — individual keyframe stop (type=8, e.g. "0%" or "from") */
  class CSSKeyframeRule_ extends CSSRule_ {
    type = 8;
    keyText = '';
    style: { cssText: string } & Record<string, string> = { cssText: '' } as any;
    constructor(keyText: string, body?: string) {
      super();
      this.keyText = keyText;
      if (body) {
        body.split(';').forEach(pair => {
          var ci = pair.indexOf(':'); if (ci < 0) return;
          var p2 = pair.slice(0, ci).trim();
          var v  = pair.slice(ci + 1).replace(/!\s*important\s*$/i, '').trim();
          if (p2 && v) _setCSSProp(this.style as any, p2, v);
        });
        this.style.cssText = body;
      }
      this.cssText = keyText + ' { ' + (this.style.cssText || '') + ' }';
    }
  }

  /** CSSSupportRule — @supports rule (type=12) */
  class CSSSupportsRule_ extends CSSRule_ {
    type = 12;
    conditionText = '';
    cssRules: CSSRule_[] = [];
    constructor(conditionText: string) { super(); this.conditionText = conditionText; this.cssText = '@supports ' + conditionText + ' { }'; }
    insertRule(rule: string, index = 0): number { this.cssRules.splice(index, 0, new CSSStyleRule_(rule, '')); return index; }
    deleteRule(index: number): void { this.cssRules.splice(index, 1); }
  }

  /** CSSContainerRule — @container rule [Item 438] (type=15) */
  class CSSContainerRule_ extends CSSRule_ {
    type = 15;
    containerName = '';
    conditionText = '';
    cssRules: CSSRule_[] = [];
    constructor(header: string) {
      super();
      // Header is like: "sidebar (min-width: 300px)" or "(min-width: 500px)"
      var parenIdx = header.indexOf('(');
      if (parenIdx > 0) {
        this.containerName = header.slice(0, parenIdx).trim();
        this.conditionText = header.slice(parenIdx).trim();
      } else {
        this.conditionText = header.trim();
      }
      this.cssText = '@container ' + header + ' { }';
    }
    insertRule(rule: string, index = 0): number { this.cssRules.splice(index, 0, new CSSStyleRule_(rule, '')); return index; }
    deleteRule(index: number): void { this.cssRules.splice(index, 1); }
  }

  /** CSSFontFaceRule — @font-face rule (type=5) */
  class CSSFontFaceRule_ extends CSSRule_ {
    type = 5;
    style: CSSStyleDeclarationStub & { cssText: string; 'font-family'?: string; src?: string } = { cssText: '' } as any;
    constructor(body?: string) {
      super();
      if (body) {
        body.split(';').forEach(pair => {
          var ci = pair.indexOf(':'); if (ci < 0) return;
          var p2 = pair.slice(0, ci).trim().toLowerCase();
          var v  = pair.slice(ci + 1).replace(/!\s*important\s*$/i, '').trim();
          if (p2 && v) (this.style as any)[p2] = v;
        });
        this.style.cssText = body;
      }
    }
  }

  /** CSSImportRule — @import rule (type=3) */
  class CSSImportRule_ extends CSSRule_ {
    type = 3;
    href = '';
    media: { mediaText: string } = { mediaText: '' };
    styleSheet: CSSStyleSheet_ | null = null;
    constructor(href: string) { super(); this.href = href; this.cssText = '@import url(' + href + ')'; }
  }

  class DocumentFragment_ extends VElement {
    constructor() { super('#document-fragment'); this.nodeType = 11; }
  }

  // ── AudioContext / Web Audio API stub ─────────────────────────────────────
  // Many sites check `window.AudioContext || window.webkitAudioContext`.
  // We provide a stub that accepts method calls without throwing.

  class AudioNode_ {
    context: any; numberOfInputs = 1; numberOfOutputs = 1; channelCount = 2;
    channelCountMode = 'max'; channelInterpretation = 'speakers';
    connect(_dest: unknown): unknown { return _dest; }
    disconnect(): void {}
    addEventListener() {} removeEventListener() {}
  }

  class AudioParam_ {
    value = 0; defaultValue = 0; minValue = -3.4e38; maxValue = 3.4e38;
    automationRate = 'a-rate';
    setValueAtTime(v: number): this { this.value = v; return this; }
    linearRampToValueAtTime(v: number): this { this.value = v; return this; }
    exponentialRampToValueAtTime(v: number): this { this.value = v; return this; }
    setTargetAtTime(v: number): this { this.value = v; return this; }
    setValueCurveAtTime(): this { return this; }
    cancelScheduledValues(): this { return this; }
    cancelAndHoldAtCurrentValue(): this { return this; }
  }

  class AudioContext_ extends AudioNode_ {
    state: 'suspended' | 'running' | 'closed' = 'suspended';
    sampleRate = 44100;
    currentTime = 0;
    baseLatency = 0;
    outputLatency = 0;
    get destination(): AudioNode_ { return new AudioNode_(); }
    get listener(): any { return { positionX: new AudioParam_(), positionY: new AudioParam_(), positionZ: new AudioParam_(), forwardX: new AudioParam_(), forwardY: new AudioParam_(), forwardZ: new AudioParam_(), upX: new AudioParam_(), upY: new AudioParam_(), upZ: new AudioParam_() }; }
    createGain(): any { var n: any = new AudioNode_(); n.gain = new AudioParam_(); n.gain.value = 1; return n; }
    createOscillator(): any { var n: any = new AudioNode_(); n.type = 'sine'; n.frequency = new AudioParam_(); n.frequency.value = 440; n.detune = new AudioParam_(); n.start = function() {}; n.stop = function() {}; return n; }
    createBufferSource(): any { var n: any = new AudioNode_(); n.buffer = null; n.loop = false; n.loopStart = 0; n.loopEnd = 0; n.playbackRate = new AudioParam_(); n.playbackRate.value = 1; n.detune = new AudioParam_(); n.onended = null; n.start = function() {}; n.stop = function() {}; return n; }
    createDynamicsCompressor(): any { var n: any = new AudioNode_(); ['threshold','knee','ratio','attack','release'].forEach(p => n[p] = new AudioParam_()); n.reduction = 0; return n; }
    createBiquadFilter(): any { var n: any = new AudioNode_(); n.type = 'lowpass'; n.frequency = new AudioParam_(); n.frequency.value = 350; n.detune = new AudioParam_(); n.Q = new AudioParam_(); n.Q.value = 1; n.gain = new AudioParam_(); n.getFrequencyResponse = function() {}; return n; }
    createStereoPanner(): any { var n: any = new AudioNode_(); n.pan = new AudioParam_(); return n; }
    createPanner(): any { var n: any = new AudioNode_(); ['positionX','positionY','positionZ','orientationX','orientationY','orientationZ'].forEach(p => n[p] = new AudioParam_()); n.panningModel = 'equalpower'; n.distanceModel = 'inverse'; n.refDistance = 1; n.maxDistance = 10000; n.rolloffFactor = 1; n.coneInnerAngle = 360; n.coneOuterAngle = 0; n.coneOuterGain = 0; return n; }
    createAnalyser(): any { var n: any = new AudioNode_(); n.fftSize = 2048; n.frequencyBinCount = 1024; n.minDecibels = -100; n.maxDecibels = -30; n.smoothingTimeConstant = 0.8; n.getByteFrequencyData = function() {}; n.getByteTimeDomainData = function() {}; n.getFloatFrequencyData = function() {}; n.getFloatTimeDomainData = function() {}; return n; }
    createDelay(_maxDelay?: number): any { var n: any = new AudioNode_(); n.delayTime = new AudioParam_(); return n; }
    createWaveShaper(): any { var n: any = new AudioNode_(); n.curve = null; n.oversample = 'none'; return n; }
    createConvolver(): any { var n: any = new AudioNode_(); n.buffer = null; n.normalize = true; return n; }
    createChannelSplitter(_channels?: number): AudioNode_ { return new AudioNode_(); }
    createChannelMerger(_channels?: number): AudioNode_ { return new AudioNode_(); }
    createScriptProcessor(_bufferSize?: number, _inChannels?: number, _outChannels?: number): any { var n: any = new AudioNode_(); n.onaudioprocess = null; return n; }
    createMediaElementSource(_el: unknown): AudioNode_ { return new AudioNode_(); }
    createMediaStreamSource(_stream: unknown): AudioNode_ { return new AudioNode_(); }
    createMediaStreamDestination(): any { return { stream: null, ...new AudioNode_() }; }
    createBuffer(_channels: number, _length: number, _sampleRate: number): any { return { numberOfChannels: _channels, length: _length, sampleRate: _sampleRate, duration: _length / (_sampleRate || 44100), getChannelData(_ch: number) { return new Float32Array(_length || 0); }, copyFromChannel() {}, copyToChannel() {} }; }
    decodeAudioData(_buf: unknown, success?: (buf: unknown) => void, _err?: (e: unknown) => void): Promise<unknown> {
      var dummy = this.createBuffer(2, 44100, 44100);
      if (success) { try { success(dummy); } catch(_) {} }
      return Promise.resolve(dummy);
    }
    resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
    suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
    close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
    getOutputTimestamp(): { contextTime: number; performanceTime: number } { return { contextTime: 0, performanceTime: 0 }; }
  }

  // ── speech synthesis stub ─────────────────────────────────────────────────

  var _speechSynthesis = {
    pending: false, speaking: false, paused: false,
    onvoiceschanged: null as ((e: unknown) => void) | null,
    getVoices(): unknown[] { return []; },
    speak(_utt: unknown): void {},
    cancel(): void {},
    pause(): void  { this.paused = true; },
    resume(): void { this.paused = false; },
    addEventListener() {}, removeEventListener() {},
  };

  // ── Cache API stub (window.caches) ────────────────────────────────────────

  var _caches = {
    open(_name: string): Promise<unknown> { return Promise.resolve({ put() { return Promise.resolve(); }, match() { return Promise.resolve(undefined); }, delete() { return Promise.resolve(false); }, keys() { return Promise.resolve([]); }, add() { return Promise.resolve(); }, addAll() { return Promise.resolve(); } }); },
    match(_req: unknown): Promise<unknown> { return Promise.resolve(undefined); },
    has(_name: string): Promise<boolean> { return Promise.resolve(false); },
    delete(_name: string): Promise<boolean> { return Promise.resolve(false); },
    keys(): Promise<string[]> { return Promise.resolve([]); },
  };

  // ── SpeechSynthesisUtterance ──────────────────────────────────────────────

  class SpeechSynthesisUtterance_ {
    text = ''; lang = 'en-US'; voice = null; volume = 1; rate = 1; pitch = 1;
    onstart = null; onend = null; onerror = null; onpause = null; onresume = null; onmark = null; onboundary = null;
    constructor(text?: string) { if (text !== undefined) this.text = text; }
    addEventListener() {} removeEventListener() {}
  }

  // ── ClipboardItem ─────────────────────────────────────────────────────────

  class ClipboardItem_ {
    _items: Map<string, Blob>;
    constructor(items: Record<string, Blob | Promise<Blob>>) {
      this._items = new Map();
      for (var [type, data] of Object.entries(items)) {
        if (data instanceof Blob) this._items.set(type, data);
      }
    }
    get types(): string[] { return [...this._items.keys()]; }
    getType(type: string): Promise<Blob> {
      var b = this._items.get(type);
      return b ? Promise.resolve(b) : Promise.reject(new Error('Type not found'));
    }
  }

  // ── FontFace ──────────────────────────────────────────────────────────────

  class FontFace_ {
    family: string; style = 'normal'; weight = 'normal'; stretch = 'normal';
    unicodeRange = 'U+0-10FFFF'; variant = 'normal'; featureSettings = 'normal';
    display = 'auto'; status: 'unloaded' | 'loading' | 'loaded' | 'error' = 'unloaded';
    loaded: Promise<FontFace_>;
    _resolve!: (f: FontFace_) => void;
    constructor(family: string, _source?: string | ArrayBuffer | ArrayBufferView, _descriptors?: object) {
      this.family = family;
      this.loaded = new Promise(res => { this._resolve = res; });
    }
    load(): Promise<FontFace_> {
      this.status = 'loaded';
      if (this._resolve) this._resolve(this);
      return Promise.resolve(this);
    }
  }

  // ── FontFaceSet (document.fonts) ──────────────────────────────────────────

  class FontFaceSet_ {
    _fonts: Set<FontFace_> = new Set();
    ready: Promise<FontFaceSet_> = Promise.resolve(this);
    status: 'loading' | 'loaded' = 'loaded';
    onloading:     null = null;
    onloadingdone: null = null;
    onloadingerror: null = null;
    get size(): number { return this._fonts.size; }
    add(font: FontFace_): FontFaceSet_ { this._fonts.add(font); return this; }
    delete(font: FontFace_): boolean { return this._fonts.delete(font); }
    has(font: FontFace_): boolean { return this._fonts.has(font); }
    clear(): void { this._fonts.clear(); }
    forEach(fn: (font: FontFace_, set: FontFaceSet_) => void): void { this._fonts.forEach(f => fn(f, this)); }
    [Symbol.iterator](): Iterator<FontFace_> { return this._fonts[Symbol.iterator](); }
    values(): IterableIterator<FontFace_> { return this._fonts.values(); }
    keys(): IterableIterator<FontFace_> { return this._fonts.keys(); }
    entries(): IterableIterator<[FontFace_, FontFace_]> { return this._fonts.entries(); }
    check(_font: string, _text?: string): boolean { return true; }
    load(_font: string, _text?: string): Promise<FontFace_[]> { return Promise.resolve([]); }
    addEventListener(_t: string, _fn: unknown): void {}
    removeEventListener(_t: string, _fn: unknown): void {}
  }

  var _documentFonts = new FontFaceSet_();
  (doc as any).fonts = _documentFonts;

  // ── EventSource (Server-Sent Events) ─────────────────────────────────────

  class EventSource_ {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    CONNECTING = 0; OPEN = 1; CLOSED = 2;
    readyState = 2; // closed by default (no keep-alive networking)
    url: string; withCredentials: boolean;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(url: string, init?: { withCredentials?: boolean }) {
      this.url = url; this.withCredentials = init?.withCredentials ?? false;
    }
    close(): void { this.readyState = 2; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true; }
  }

  // ── OffscreenCanvas ───────────────────────────────────────────────────────

  class OffscreenCanvas_ {
    width: number; height: number;
    constructor(w: number, h: number) { this.width = w; this.height = h; }
    getContext(type: string): unknown {
      if (type === '2d') return new (HTMLCanvas.prototype as any).getContext.bind({ width: this.width, height: this.height, _canvas: this })('2d');
      return null;
    }
    transferToImageBitmap(): unknown { return { width: this.width, height: this.height, close() {} }; }
    convertToBlob(_opts?: unknown): Promise<Blob> { return Promise.resolve(new Blob([], { type: 'image/png' })); }
    addEventListener() {} removeEventListener() {}
  }

  // ── DOMRect / DOMRectReadOnly / DOMPoint / DOMMatrix ─────────────────────

  class DOMRect_ {
    x: number; y: number; width: number; height: number;
    constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; }
    get top()    { return this.y; }
    get left()   { return this.x; }
    get right()  { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
    toJSON(): object { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, left: this.left, right: this.right, bottom: this.bottom }; }
    static fromRect(rect?: { x?: number; y?: number; width?: number; height?: number }): DOMRect_ {
      return new DOMRect_(rect?.x ?? 0, rect?.y ?? 0, rect?.width ?? 0, rect?.height ?? 0);
    }
  }
  // DOMRectReadOnly is identical in behavior
  var DOMRectReadOnly_ = DOMRect_;

  class DOMPoint_ {
    x: number; y: number; z: number; w: number;
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    toJSON(): object { return { x: this.x, y: this.y, z: this.z, w: this.w }; }
    matrixTransform(_m?: unknown): DOMPoint_ { return new DOMPoint_(this.x, this.y, this.z, this.w); }
    static fromPoint(p?: { x?: number; y?: number; z?: number; w?: number }): DOMPoint_ {
      return new DOMPoint_(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0, p?.w ?? 1);
    }
  }

  class DOMMatrix_ {
    // Identity matrix (column-major as per spec, but we store flat)
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    m11 = 1; m12 = 0; m13 = 0; m14 = 0;
    m21 = 0; m22 = 1; m23 = 0; m24 = 0;
    m31 = 0; m32 = 0; m33 = 1; m34 = 0;
    m41 = 0; m42 = 0; m43 = 0; m44 = 1;
    is2D = true; isIdentity = true;
    constructor(_init?: string | number[]) {}
    translate(tx = 0, ty = 0, _tz = 0): DOMMatrix_ { var m = new DOMMatrix_(); m.e = tx; m.f = ty; m.m41 = tx; m.m42 = ty; return m; }
    scale(sx = 1, sy?: number, _sz = 1, _ox = 0, _oy = 0, _oz = 0): DOMMatrix_ { var m = new DOMMatrix_(); m.a = sx; m.d = sy ?? sx; m.m11 = sx; m.m22 = sy ?? sx; return m; }
    rotate(_angle = 0, _ry = 0, _rz = 0): DOMMatrix_ { return new DOMMatrix_(); }
    multiply(_m: DOMMatrix_): DOMMatrix_ { return new DOMMatrix_(); }
    inverse(): DOMMatrix_ { return new DOMMatrix_(); }
    flipX(): DOMMatrix_ { var m = new DOMMatrix_(); m.a = -1; m.m11 = -1; return m; }
    flipY(): DOMMatrix_ { var m = new DOMMatrix_(); m.d = -1; m.m22 = -1; return m; }
    transformPoint(p: DOMPoint_): DOMPoint_ { return new DOMPoint_(this.a * p.x + this.c * p.y + this.e, this.b * p.x + this.d * p.y + this.f, p.z, p.w); }
    toFloat32Array(): Float32Array { return new Float32Array([this.m11, this.m12, this.m13, this.m14, this.m21, this.m22, this.m23, this.m24, this.m31, this.m32, this.m33, this.m34, this.m41, this.m42, this.m43, this.m44]); }
    toFloat64Array(): Float64Array { return new Float64Array([this.m11, this.m12, this.m13, this.m14, this.m21, this.m22, this.m23, this.m24, this.m31, this.m32, this.m33, this.m34, this.m41, this.m42, this.m43, this.m44]); }
    toJSON(): object { return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f, is2D: this.is2D }; }
    toString(): string { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
    static fromMatrix(m?: Partial<DOMMatrix_>): DOMMatrix_ { var dm = new DOMMatrix_(); if (m) Object.assign(dm, m); return dm; }
    static fromFloat32Array(arr: Float32Array): DOMMatrix_ { var m = new DOMMatrix_(); m.m11 = arr[0] ?? 1; m.m12 = arr[1] ?? 0; m.m22 = arr[5] ?? 1; return m; }
  }
  var DOMMatrixReadOnly_ = DOMMatrix_;

  // ── WebSocket stub (item 542) ─────────────────────────────────────────────

  class WebSocket_ {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 3; // CLOSED by default (no real TCP available from runtime)
    url: string; protocol: string; binaryType = 'blob';
    bufferedAmount = 0; extensions = '';
    onopen:    ((ev: unknown) => void) | null = null;
    onclose:   ((ev: unknown) => void) | null = null;
    onmessage: ((ev: unknown) => void) | null = null;
    onerror:   ((ev: unknown) => void) | null = null;
    _listeners: Map<string, Array<(ev: unknown) => void>> = new Map();

    constructor(url: string, protocols?: string | string[]) {
      this.url = url;
      this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '');
      this.readyState = 0; // CONNECTING
      // Attempt connection via os.tcpConnect if available, else fire error
      var self = this;
      setTimeout(() => {
        if ((os as any).webSocketConnect) {
          try { (os as any).webSocketConnect(url, protocols, self); return; } catch (_) {}
        }
        // Fallback: immediately fire error + close
        self.readyState = 3;
        var errEv = { type: 'error', target: self };
        if (self.onerror) try { self.onerror(errEv); } catch(_) {}
        for (var fn of (self._listeners.get('error') ?? [])) try { fn(errEv); } catch(_) {}
        var closeEv = { type: 'close', target: self, code: 1006, reason: 'Connection failed', wasClean: false };
        if (self.onclose) try { self.onclose(closeEv); } catch(_) {}
        for (var fn2 of (self._listeners.get('close') ?? [])) try { fn2(closeEv); } catch(_) {}
      }, 0);
    }

    send(_data: string | ArrayBuffer | Blob): void {
      if (this.readyState !== 1) throw new Error('WebSocket is not open');
    }
    close(code = 1000, reason = ''): void {
      if (this.readyState === 0 || this.readyState === 1) {
        this.readyState = 2;
        setTimeout(() => {
          this.readyState = 3;
          var closeEv = { type: 'close', target: this, code, reason, wasClean: code === 1000 };
          if (this.onclose) try { this.onclose(closeEv); } catch(_) {}
          for (var fn of (this._listeners.get('close') ?? [])) try { fn(closeEv); } catch(_) {}
        }, 0);
      }
    }
    addEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
      if (type === 'open')    this.onopen    = fn;
      if (type === 'close')   this.onclose   = fn;
      if (type === 'message') this.onmessage = fn;
      if (type === 'error')   this.onerror   = fn;
    }
    removeEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      var arr = this._listeners.get(type); if (arr) { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    }
    dispatchEvent(ev: { type: string }): boolean {
      var arr = this._listeners.get(ev.type); if (arr) for (var fn of arr) try { fn(ev); } catch(_) {}
      return true;
    }
  }

  // ── Promise polyfills (item 510) ──────────────────────────────────────────

  // QuickJS 2023+ usually includes these, but polyfill if absent
  var _PromiseAllSettled: (promises: Promise<unknown>[]) => Promise<Array<{ status: string; value?: unknown; reason?: unknown }>> =
    (typeof (Promise as any).allSettled === 'function')
    ? (promises: Promise<unknown>[]) => (Promise as any).allSettled(promises)
    : (promises: Promise<unknown>[]) => Promise.all(promises.map(p => Promise.resolve(p).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))));

  var _PromiseAny: (promises: Promise<unknown>[]) => Promise<unknown> =
    (typeof (Promise as any).any === 'function')
    ? (promises: Promise<unknown>[]) => (Promise as any).any(promises)
    : (promises: Promise<unknown>[]) => new Promise((resolve, reject) => {
        var errors: unknown[] = []; var pending = promises.length; var _AE2: any = typeof (globalThis as any).AggregateError !== 'undefined' ? (globalThis as any).AggregateError : Error;
        if (pending === 0) { reject(new _AE2('All promises were rejected')); return; }
        promises.forEach((p, i) => Promise.resolve(p).then(resolve, err => { errors[i] = err; if (--pending === 0) reject(new _AE2('All promises were rejected')); }));
      });

  // AggregateError polyfill if QuickJS doesn't have it
  var AggregateError_: new (errors: unknown[], message?: string) => { errors: unknown[]; message: string } = typeof (globalThis as any).AggregateError !== 'undefined'
    ? (globalThis as any).AggregateError
    : class AggErr extends Error {
        errors: unknown[];
        constructor(errors: unknown[], message?: string) { super(message); this.errors = errors; this.name = 'AggregateError'; }
      };

  // ── window.getComputedStyle — full CSS cascade (item 577) ────────────────

  // CSS inherited properties set (used for 'unset' keyword resolution in getComputedStyle)
  var _CSS_INHERITED = new Set(['color','font','font-family','font-size','font-style','font-variant','font-weight',
    'font-stretch','line-height','letter-spacing','word-spacing','text-align','text-indent','text-transform',
    'white-space','word-break','overflow-wrap','word-wrap','list-style','list-style-type','list-style-position',
    'cursor','direction','visibility','caption-side','border-collapse','border-spacing','empty-cells',
    'quotes','orphans','widows','page-break-inside','pointer-events']);

  // Calculate CSS specificity as a numeric score (a*10000 + b*100 + c)
  // where a=IDs, b=classes/attrs/pseudoClasses, c=elements/pseudoElements
  function _calcSpecificity(sel: string): number {
    // Remove :not() contents (contributes inner selector specificity) and :is()/:where()
    var s = sel.replace(/:not\(([^)]*)\)/g, ' $1').replace(/:(?:is|where)\([^)]*\)/g, '');
    var a = (s.match(/#[\w-]+/g) || []).length;
    var b = (s.match(/\.([\w-]+)|\[[\w-]+|\:(?!not|is|where|has|nth-child|nth-of-type|nth-last-child|nth-last-of-type)[a-z-]+/g) || []).length;
    var c = (s.match(/(?:^|\s|>|\+|~)([a-z][\w-]*)|::[a-z-]+/g) || []).length;
    return a * 10000 + b * 100 + c;
  }

  /** Computed style proxy cache — keyed per-element, invalidated by style generation (item 944). */
  var _csProxyCache = new WeakMap<VElement, { gen: number; proxy: any }>();

  function getComputedStyle(el: VElement, _pseudoElt?: string | null): any {
    // ── Computed style cache check (item 944) ───────────────────────────────────
    var _csGen = currentStyleGeneration();
    var _csHit = _csProxyCache.get(el);
    if (_csHit && _csHit.gen === _csGen) return _csHit.proxy;
    // ── Full computation below ──────────────────────────────────────────────────
    // Collect all matching rules with specificity for proper cascade ordering
    // Each entry: { specificity, sourceOrder, layerIndex, style, important: Set<string> }
    var matched: Array<{ spec: number; order: number; layerIdx: number; style: any; important: Set<string> | undefined }> = [];
    var order = 0;

    function collectRule(rule: any, spec: number): void {
      // [Item 436] _layerIndex: undefined / -1 means "unlayered" (highest cascade priority)
      var lIdx: number = (rule._layerIndex !== undefined && rule._layerIndex >= 0) ? rule._layerIndex : 0x7FFFFFFF;
      matched.push({ spec, order: order++, layerIdx: lIdx, style: rule.style, important: rule.important as Set<string> | undefined });
    }

    function walkRules(rules: Array<any>): void {
      for (var rule of rules) {
        if (!rule) continue;
        if (rule.type === 1 && rule.selectorText) {
          // CSSStyleRule — test each comma-separated selector, take max specificity
          var sels = (rule.selectorText as string).split(',');
          var maxSpec = -1;
          for (var s = 0; s < sels.length; s++) {
            var selTrim = sels[s].trim();
            try { if (_matchSel(selTrim, el)) { var sp = _calcSpecificity(selTrim); if (sp > maxSpec) maxSpec = sp; } } catch (_) {}
          }
          if (maxSpec >= 0) collectRule(rule, maxSpec);
        } else if (rule.type === 4 && rule.cssRules) {
          // @media — evaluate condition against viewport (item 373)
          var mCond: string = rule.conditionText || (rule.media && rule.media.mediaText) || '';
          if (!mCond || _evalMediaQuery(mCond)) walkRules(rule.cssRules);
        } else if (rule.type === 12 && rule.cssRules) {
          // @supports — evaluate condition; default permissive for unknown props
          var sCond: string = rule.conditionText || '';
          var sMatches = !sCond || (typeof CSS_ !== 'undefined' ? CSS_.supports(sCond) : true);
          if (sMatches) walkRules(rule.cssRules);
        } else if (rule.type === 15 && rule.cssRules) {
          // [Item 438] @container — evaluate size condition against containing block
          var cCond: string = (rule as any).conditionText || '';
          var cName: string = (rule as any).containerName || '';
          if (!cCond || _evalContainerQuery(el, cName, cCond)) walkRules(rule.cssRules);
        }
      }
    }

    // Walk all document stylesheets — use O(1) index for flat rules (item 943)
    for (var si = 0; si < doc._styleSheets.length; si++) {
      var sheet = doc._styleSheets[si] as any as CSSStyleSheet_;
      if (sheet.disabled) continue;
      var idx = sheet._ruleIdx;
      if (idx && idx.size > 0) {
        // Build candidate bucket keys from this element: #id, .class..., tag, *
        var buckets: string[] = ['*'];
        if (el.tagName) buckets.push(el.tagName.toLowerCase());
        if (el.id) buckets.push('#' + el.id);
        var elCls = el.className ? (el.className as string).split(/\s+/).filter(Boolean) : [];
        for (var ci = 0; ci < elCls.length; ci++) if (elCls[ci]) buckets.push('.' + elCls[ci]);
        // Collect candidate rules from relevant buckets (de-duplicated)
        var seen943 = new Set<CSSStyleRule_>();
        for (var bi = 0; bi < buckets.length; bi++) {
          var bkt = idx.get(buckets[bi]);
          if (!bkt) continue;
          for (var bri = 0; bri < bkt.length; bri++) {
            var br = bkt[bri];
            if (seen943.has(br)) continue; seen943.add(br);
            // Verify full selector match (handles compound selectors, combinators, etc.)
            var bSels = (br.selectorText as string).split(',');
            var bMaxSpec = -1;
            for (var bs = 0; bs < bSels.length; bs++) {
              var bSelTrim = bSels[bs].trim();
              try { if (_matchSel(bSelTrim, el)) { var bSp = _calcSpecificity(bSelTrim); if (bSp > bMaxSpec) bMaxSpec = bSp; } } catch (_) {}
            }
            if (bMaxSpec >= 0) collectRule(br, bMaxSpec);
          }
        }
        // Still walk @media and @supports blocks (their nested rules are not in the flat index)
        for (var msi = 0; msi < sheet.cssRules.length; msi++) {
          var mRule = sheet.cssRules[msi] as any;
          if (!mRule) continue;
          if (mRule.type === 4 && mRule.cssRules) {
            var mCond2: string = mRule.conditionText || (mRule.media && mRule.media.mediaText) || '';
            if (!mCond2 || _evalMediaQuery(mCond2)) walkRules(mRule.cssRules);
          } else if (mRule.type === 12 && mRule.cssRules) {
            var sCond2: string = mRule.conditionText || '';
            var sm2 = !sCond2 || (typeof CSS_ !== 'undefined' ? CSS_.supports(sCond2) : true);
            if (sm2) walkRules(mRule.cssRules);
          }
        }
      } else {
        // Fallback: linear walk (sheet had no indexed rules, e.g. all @media)
        walkRules(sheet.cssRules ?? []);
      }
    }

    // Sort: normal rules by layer (earlier layers first), then specificity, then source order
    // [Item 436] unlayered rules (layerIdx=0x7FFFFFFF) sort last = highest cascade priority
    matched.sort((a, b2) => {
      if (a.layerIdx !== b2.layerIdx) return a.layerIdx - b2.layerIdx;
      return a.spec !== b2.spec ? a.spec - b2.spec : a.order - b2.order;
    });

    // Apply matched rules in cascade order; !important props tracked separately
    var merged = new Map<string, string>();
    var importantMerged = new Map<string, string>();

    for (var mi = 0; mi < matched.length; mi++) {
      var m = matched[mi];
      var ruleStyle = m.style;
      if (!ruleStyle || typeof ruleStyle !== 'object') continue;
      for (var p in ruleStyle) {
        if (p === 'cssText') continue;
        var v = ruleStyle[p]; if (!v) continue;
        if (m.important && m.important.has(p)) importantMerged.set(p, v);
        else merged.set(p, v);
      }
    }

    // !important always wins; merge on top of normal
    importantMerged.forEach((v, p) => merged.set(p, v));

    // Inline el._style overrides stylesheet rules (inline !important would win but we treat all inline as highest)
    var inlineMap = (el._style as any)._map as Map<string, string> | undefined;
    if (inlineMap) { inlineMap.forEach((v, p) => { if (v) merged.set(p, v); }); }

    // CSS custom property (var()) resolver — walks ancestor chain
    // First collect --* vars from this element's matched rules + inline into localVars
    var localVars = new Map<string, string>();
    merged.forEach((v, p) => { if (p.startsWith('--')) localVars.set(p, v); });
    if (inlineMap) { inlineMap.forEach((v, p) => { if (p.startsWith('--') && v) localVars.set(p, v); }); }
    (el as any)._cssVarCache = localVars; // cache for ancestor resolution of descendants

    function resolveVar(name: string, fallback: string): string {
      // Check this element's own vars (from sheet rules + inline)
      var lv = localVars.get(name); if (lv !== undefined) return lv;
      // Walk ancestors
      var n: VElement | null = el.parentNode instanceof VElement ? el.parentNode as VElement : null;
      while (n) {
        var vc = (n as any)._cssVarCache as Map<string, string> | undefined;
        if (vc) { var vvc = vc.get(name); if (vvc !== undefined) return vvc; }
        var vm = (n._style as any)._map as Map<string, string> | undefined;
        if (vm) { var vv = vm.get(name); if (vv !== undefined) return vv; }
        n = n.parentNode instanceof VElement ? n.parentNode as VElement : null;
      }
      return fallback !== undefined ? fallback : '';
    }
    function resolveValue(val: string): string {
      if (!val || val.indexOf('var(') === -1) return val;
      return val.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/g,
        (_m: string, name: string, fb: string) => resolveVar(name, fb || ''));
    }

    // item 945: resolve all var() references once at cascade time so the proxy
    // getter can return already-resolved values without repeated substitution.
    merged.forEach((v, p) => {
      if (v && v.indexOf('var(') !== -1) merged.set(p, resolveValue(v));
    });

    // Resolve `inherit` keyword by walking parent chain
    function resolveInherit(prop: string): string {
      var n: VElement | null = el.parentNode instanceof VElement ? el.parentNode as VElement : null;
      while (n) {
        var pm = (n._style as any)._map as Map<string, string> | undefined;
        if (pm) { var pv = pm.get(prop); if (pv && pv !== 'inherit') return resolveValue(pv); }
        n = n.parentNode instanceof VElement ? n.parentNode as VElement : null;
      }
      return '';
    }

    function resolve(prop: string): string {
      var raw = merged.get(prop) ?? '';
      if (!raw) return '';
      var kw = raw.trim().toLowerCase();
      if (kw === 'inherit') return resolveInherit(prop);
      if (kw === 'initial' || kw === 'revert') return '';
      if (kw === 'unset') return _CSS_INHERITED.has(prop) ? resolveInherit(prop) : '';
      return resolveValue(raw);
    }

    var _csProxy944 = new Proxy({} as Record<string, string>, {
      get(_t, k: string) {
        if (typeof k !== 'string') return undefined;
        if (k === 'getPropertyValue')   return (p: string) => resolve(p);
        if (k === 'getPropertyPriority') return (_p: string) => '';
        if (k === 'setProperty' || k === 'removeProperty') return () => {};
        if (k === 'cssText') { var parts: string[] = []; merged.forEach((v, p) => parts.push(p + ': ' + v)); return parts.join('; '); }
        if (k === 'length') return merged.size;
        return resolve((k as string).replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
      },
    });
    _csProxyCache.set(el, { gen: _csGen, proxy: _csProxy944 }); // item 944: cache proxy
    return _csProxy944;
  }

  // ── window.requestAnimationFrame / cancelAnimationFrame ───────────────────

  var rafCallbacks: Array<{ id: number; fn: (ts: number) => void }> = [];
  var rafSeq = 1;
  function requestAnimationFrame(fn: (ts: number) => void): number { var id = rafSeq++; rafCallbacks.push({ id, fn }); return id; }
  function cancelAnimationFrame(id: number): void { rafCallbacks = rafCallbacks.filter(r => r.id !== id); }

  // ── Performance (real W3C Performance Timeline) ──────────────────────────

  var _perf = new BrowserPerformance();
  var performance: BrowserPerformance = _perf;

  // ── Microtask queue ───────────────────────────────────────────────────────
  // True microtask ordering: drain before each macrotask fires.

  var _microtaskQueue: Array<() => void> = [];

  function queueMicrotask_(fn: () => void): void { _microtaskQueue.push(fn); }

  function _drainMicrotasks(): void {
    var limit = 1000;
    while (_microtaskQueue.length > 0 && limit-- > 0) {
      var fn = _microtaskQueue.shift()!;
      try { fn(); } catch (_) {}
    }
  }

  // ── Scheduler (postTask) ──────────────────────────────────────────────────

  var scheduler = {
    postTask(fn: () => void, opts?: { priority?: string; delay?: number }): Promise<void> {
      var delay = opts?.delay ?? 0;
      return new Promise<void>((resolve, reject) => {
        setTimeout_(() => {
          try { fn(); resolve(); } catch (e) { reject(e); }
        }, delay);
      });
    },
    yield(): Promise<void> {
      return new Promise<void>(resolve => setTimeout_(resolve, 0));
    },
  };

  // ── requestIdleCallback / cancelIdleCallback (item 545) ───────────────────
  var _idleCbs = new Map<number, number>(); var _idleCbNext = 1;
  function requestIdleCallback(fn: (deadline: { timeRemaining(): number; didTimeout: boolean }) => void, opts?: { timeout?: number }): number {
    var id = _idleCbNext++;
    var deadline = { timeRemaining(): number { return 50; }, didTimeout: false };
    var timer = setTimeout_(() => { _idleCbs.delete(id); try { fn(deadline); } catch (_) {} }, opts?.timeout ?? 1);
    _idleCbs.set(id, timer);
    return id;
  }
  function cancelIdleCallback(id: number): void {
    var timer = _idleCbs.get(id); if (timer != null) { clearTimeout_(timer); _idleCbs.delete(id); }
  }

  // ── window.crypto (basic) ─────────────────────────────────────────────────

  var crypto = {
    getRandomValues(buf: Uint8Array): Uint8Array {
      for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256) | 0;
      return buf;
    },
    randomUUID(): string {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    },
    // crypto.subtle stub (item 341) — returns valid Promises, not implemented fully
    subtle: {
      digest(_algo: unknown, _data: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(32)); },
      sign(_algo: unknown, _key: unknown, _data: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(64)); },
      verify(_algo: unknown, _key: unknown, _sig: unknown, _data: unknown): Promise<boolean> { return Promise.resolve(false); },
      encrypt(_algo: unknown, _key: unknown, _data: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(16)); },
      decrypt(_algo: unknown, _key: unknown, _data: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(16)); },
      generateKey(_algo: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages }); },
      importKey(_fmt: unknown, _kd: unknown, _algo: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages }); },
      exportKey(_fmt: unknown, _key: unknown): Promise<unknown> { return Promise.resolve({}); },
      deriveKey(_algo: unknown, _base: unknown, _der: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages }); },
      deriveBits(_algo: unknown, _base: unknown, _len: number): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(_len >> 3)); },
      wrapKey(_fmt: unknown, _key: unknown, _wk: unknown, _algo: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(32)); },
      unwrapKey(_fmt: unknown, _d: unknown, _uk: unknown, _a1: unknown, _a2: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages }); },
    },
  };

  // ── DOMParser stub ────────────────────────────────────────────────────────

  class DOMParser {
    parseFromString(html: string, _type: string) { return buildDOM(html); }
  }

  // ── XMLSerializer ─────────────────────────────────────────────────────────
  // Serializes a DOM node back to an HTML/XML string.

  class XMLSerializer {
    serializeToString(node: VElement | any): string {
      if (!node) return '';
      // Full document
      if (node.nodeType === 9) {
        return '<!DOCTYPE html>' + _serializeEl(node.documentElement ?? node.body);
      }
      // Element or fragment
      if (node instanceof VElement) return _serializeEl(node);
      // Text node
      if (node.nodeType === 3) return (node as any).data || '';
      // Comment
      if (node.nodeType === 8) return '<!--' + ((node as any).data || '') + '-->';
      return '';
    }
  }

  // ── document.implementation ───────────────────────────────────────────────
  // Basic DOMImplementation stub (needed by many framework feature detections).

  var _docImplementation = {
    hasFeature(_feature: string, _version?: string): boolean { return false; },
    createDocumentType(_qualifier: string, _publicId: string, _systemId: string): any {
      return { nodeType: 10, name: _qualifier, publicId: _publicId, systemId: _systemId };
    },
    createDocument(_namespace: string | null, _qualifiedName: string, _doctype?: any): VDocument {
      return buildDOM('');
    },
    createHTMLDocument(title?: string): VDocument {
      var d = buildDOM('<!DOCTYPE html><html><head>' + (title ? '<title>' + title + '</title>' : '') + '</head><body></body></html>');
      return d;
    },
  };
  (doc as any).implementation = _docImplementation;

  // ── WeakRef + FinalizationRegistry stubs (item 548) ──────────────────────

  class WeakRefImpl<T extends object> {
    _ref: T;
    constructor(target: T) { this._ref = target; }
    deref(): T | undefined { return this._ref; }
  }

  class FinalizationRegistryImpl<T> {
    _fn: (value: T) => void;
    constructor(fn: (value: T) => void) { this._fn = fn; }
    register(_target: object, _value: T, _token?: object): void {}
    unregister(_token: object): void {}
  }

  // ── Custom Elements registry stub (item 550) ──────────────────────────────

  var _ceRegistry: Map<string, unknown> = new Map();
  var customElementsAPI = {
    define(name: string, ctor: unknown, _opts?: unknown): void { _ceRegistry.set(name.toLowerCase(), ctor); },
    get(name: string): unknown | undefined { return _ceRegistry.get(name.toLowerCase()); },
    whenDefined(_name: string): Promise<unknown> { return Promise.resolve(undefined); },
    upgrade(_root: unknown): void {},
    getName(_ctor: unknown): string | null {
      for (var [k, v] of _ceRegistry) { if (v === _ctor) return k; }
      return null;
    },
  };

  // ── Streams API (ReadableStream, WritableStream, TransformStream) ─────────
  // Minimal stubs — complete enough for feature-detection by frameworks.

  class ReadableStreamDefaultReader_ {
    _stream: any;
    _done = false;
    constructor(stream: any) { this._stream = stream; }
    read(): Promise<{ done: boolean; value: unknown }> {
      var chunk = this._stream._chunks ? this._stream._chunks.shift() : undefined;
      if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
      return Promise.resolve({ done: true, value: undefined });
    }
    releaseLock(): void { this._stream._reader = null; }
    cancel(_reason?: unknown): Promise<void> { this._done = true; return Promise.resolve(); }
    get closed(): Promise<void> { return Promise.resolve(); }
  }

  class ReadableStream_ {
    locked = false;
    _chunks: unknown[] = [];
    _reader: ReadableStreamDefaultReader_ | null = null;
    constructor(underlyingSource?: { start?: (controller: any) => void; pull?: (controller: any) => void; cancel?: (reason?: unknown) => void } | null, _queuingStrategy?: unknown) {
      if (underlyingSource?.start) {
        var controller = {
          enqueue: (chunk: unknown) => this._chunks.push(chunk),
          close: () => {},
          error: (_e: unknown) => {},
          desiredSize: 1,
        };
        try { underlyingSource.start(controller); } catch(_) {}
      }
    }
    getReader(): ReadableStreamDefaultReader_ {
      this.locked = true;
      this._reader = new ReadableStreamDefaultReader_(this);
      return this._reader;
    }
    cancel(_reason?: unknown): Promise<void> { return Promise.resolve(); }
    pipeTo(_dest: unknown, _opts?: unknown): Promise<void> { return Promise.resolve(); }
    pipeThrough(_transform: unknown): ReadableStream_ { return new ReadableStream_(); }
    tee(): [ReadableStream_, ReadableStream_] { return [new ReadableStream_(), new ReadableStream_()]; }
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      var reader = this.getReader();
      return {
        next(): Promise<IteratorResult<unknown>> { return reader.read() as Promise<IteratorResult<unknown>>; },
        return(): Promise<IteratorResult<unknown>> { reader.releaseLock(); return Promise.resolve({ done: true, value: undefined }); },
      };
    }
    static from(_asyncIterable: unknown): ReadableStream_ { return new ReadableStream_(); }
  }

  class WritableStreamDefaultWriter_ {
    _stream: any;
    constructor(stream: any) { this._stream = stream; }
    write(_chunk: unknown): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
    abort(_reason?: unknown): Promise<void> { return Promise.resolve(); }
    releaseLock(): void {}
    get closed(): Promise<void> { return Promise.resolve(); }
    get ready(): Promise<void> { return Promise.resolve(); }
    get desiredSize(): number | null { return 1; }
  }

  class WritableStream_ {
    locked = false;
    constructor(_underlyingSink?: unknown, _queuingStrategy?: unknown) {}
    getWriter(): WritableStreamDefaultWriter_ { this.locked = true; return new WritableStreamDefaultWriter_(this); }
    abort(_reason?: unknown): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
    get closed(): Promise<void> { return Promise.resolve(); }
  }

  class TransformStream_ {
    readable: ReadableStream_;
    writable: WritableStream_;
    constructor(_transformer?: unknown, _readableStrategy?: unknown, _writableStrategy?: unknown) {
      this.readable = new ReadableStream_();
      this.writable = new WritableStream_();
    }
  }

  class CountQueuingStrategy_ {
    highWaterMark: number;
    constructor(init: { highWaterMark: number }) { this.highWaterMark = init.highWaterMark; }
    size(_chunk: unknown): number { return 1; }
  }

  class ByteLengthQueuingStrategy_ {
    highWaterMark: number;
    constructor(init: { highWaterMark: number }) { this.highWaterMark = init.highWaterMark; }
    size(chunk: ArrayBufferView): number { return chunk.byteLength; }
  }

  // ── TextEncoderStream / TextDecoderStream (item 545 adjacent) ────────────

  class TextEncoderStream_ {
    readonly encoding = 'utf-8';
    readable: ReadableStream_;
    writable: WritableStream_;
    constructor() {
      var chunks: Uint8Array[] = [];
      this.readable = new ReadableStream_();
      this.writable = new WritableStream_({
        write(chunk: string) {
          // inline utf-8 encode
          var out: number[] = [];
          for (var i = 0; i < chunk.length; ) {
            var cp = chunk.codePointAt(i)!;
            if (cp < 0x80) { out.push(cp); i++; }
            else if (cp < 0x800) { out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63)); i++; }
            else if (cp < 0x10000) { out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); i++; }
            else { out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); i += 2; }
          }
          chunks.push(new Uint8Array(out));
        },
      });
    }
  }

  class TextDecoderStream_ {
    readonly encoding: string;
    readable: ReadableStream_;
    writable: WritableStream_;
    constructor(label = 'utf-8') {
      this.encoding = label;
      var _chunks: string[] = [];
      this.readable = new ReadableStream_();
      this.writable = new WritableStream_({
        write(chunk: Uint8Array | string) {
          if (typeof chunk === 'string') { _chunks.push(chunk); return; }
          // Simple Latin-1 passthrough (full UTF-8 decode not needed for stub)
          var s = '';
          for (var ci = 0; ci < chunk.length; ci++) s += String.fromCharCode(chunk[ci]);
          _chunks.push(s);
        },
      });
    }
  }

  // ── CompressionStream / DecompressionStream (item 545 adjacent) ──────────
  // Stubs — pass data through unchanged; real compression not yet implemented.

  class CompressionStream_ {
    readonly format: string;
    readable: ReadableStream_;
    writable: WritableStream_;
    constructor(format: string) {
      this.format = format;
      var _buf: Uint8Array[] = [];
      this.readable = new ReadableStream_({ start() {} });
      this.writable = new WritableStream_({ write(chunk: Uint8Array) { _buf.push(chunk); } });
    }
  }

  class DecompressionStream_ {
    readonly format: string;
    readable: ReadableStream_;
    writable: WritableStream_;
    constructor(format: string) {
      this.format = format;
      var _buf: Uint8Array[] = [];
      this.readable = new ReadableStream_({ start() {} });
      this.writable = new WritableStream_({ write(chunk: Uint8Array) { _buf.push(chunk); } });
    }
  }

  // ── TextEncoder / TextDecoder ─────────────────────────────────────────────

  class TextEncoder_ {
    readonly encoding = 'utf-8';
    encode(str: string): Uint8Array {
      var out: number[] = [];
      for (var i = 0; i < str.length; ) {
        var cp = str.codePointAt(i)!;
        if (cp < 0x80) { out.push(cp); i++; }
        else if (cp < 0x800) { out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63)); i++; }
        else if (cp < 0x10000) { out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); i++; }
        else { out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); i += 2; }
      }
      return new Uint8Array(out);
    }
    encodeInto(str: string, dest: Uint8Array): { read: number; written: number } {
      var enc = this.encode(str); var n = Math.min(enc.length, dest.length);
      dest.set(enc.subarray(0, n)); return { read: n, written: n };
    }
  }

  class TextDecoder_ {
    readonly encoding: string;
    constructor(enc = 'utf-8') { this.encoding = enc.toLowerCase(); }
    decode(buf?: Uint8Array | ArrayBuffer | null): string {
      if (!buf) return '';
      var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
      var out = ''; var i = 0;
      while (i < bytes.length) {
        var b = bytes[i];
        if (b < 0x80) { out += String.fromCharCode(b); i++; }
        else if ((b & 0xE0) === 0xC0) { out += String.fromCodePoint(((b & 0x1F) << 6) | (bytes[i+1] & 0x3F)); i += 2; }
        else if ((b & 0xF0) === 0xE0) { out += String.fromCodePoint(((b & 0x0F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F)); i += 3; }
        else if ((b & 0xF8) === 0xF0) { out += String.fromCodePoint(((b & 0x07) << 18) | ((bytes[i+1] & 0x3F) << 12) | ((bytes[i+2] & 0x3F) << 6) | (bytes[i+3] & 0x3F)); i += 4; }
        else { out += '\uFFFD'; i++; }
      }
      return out;
    }
  }

  // ── Patch Promise with polyfills if not natively available (item 510) ────
  if (typeof (Promise as any).allSettled !== 'function') (Promise as any).allSettled = _PromiseAllSettled;
  if (typeof (Promise as any).any        !== 'function') (Promise as any).any        = _PromiseAny;
  // Promise.withResolvers (ES2024) polyfill
  if (typeof (Promise as any).withResolvers !== 'function') {
    (Promise as any).withResolvers = function() {
      var resolve: (v: unknown) => void, reject: (r: unknown) => void;
      var promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve: resolve!, reject: reject! };
    };
  }

  // ── JavaScript built-in polyfills ─────────────────────────────────────────
  // Object.fromEntries (ES2019) — might be missing in older QJS
  if (typeof (Object as any).fromEntries !== 'function') {
    (Object as any).fromEntries = (entries: Iterable<[PropertyKey, unknown]>) => {
      var obj: Record<PropertyKey, unknown> = {};
      for (var [k, v] of entries as any) obj[k] = v;
      return obj;
    };
  }
  // Array.prototype.at (ES2022)
  if (typeof (Array.prototype as any).at !== 'function') {
    (Array.prototype as any).at = function(this: unknown[], n: number) { var i = n < 0 ? this.length + n : n; return this[i]; };
  }
  // Array.prototype.flat (ES2019)
  if (typeof (Array.prototype as any).flat !== 'function') {
    (Array.prototype as any).flat = function(this: unknown[], depth = 1): unknown[] {
      var flat = (arr: unknown[], d: number): unknown[] => d > 0 ? arr.reduce<unknown[]>((acc, v) => acc.concat(Array.isArray(v) ? flat(v, d - 1) : [v]), []) : arr.slice();
      return flat(this, depth);
    };
  }
  // Array.prototype.flatMap (ES2019)
  if (typeof (Array.prototype as any).flatMap !== 'function') {
    (Array.prototype as any).flatMap = function(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => unknown) { return (this as any).flat(1).map ? this.map(fn).flat(1) : this.map(fn); };
  }
  // String.prototype.replaceAll (ES2021)
  if (typeof (String.prototype as any).replaceAll !== 'function') {
    (String.prototype as any).replaceAll = function(this: string, search: string | RegExp, replacement: string | ((match: string) => string)) {
      if (search instanceof RegExp) { if (!search.flags.includes('g')) throw new TypeError('replaceAll called with non-global RegExp'); return this.replace(search, replacement as string); }
      return this.split(search as string).join(typeof replacement === 'function' ? replacement(search as string) : (replacement as string));
    };
  }
  // String.prototype.at (ES2022)
  if (typeof (String.prototype as any).at !== 'function') {
    (String.prototype as any).at = function(this: string, n: number) { var i = n < 0 ? this.length + n : n; return this[i]; };
  }
  // Array.prototype.findLast / findLastIndex (ES2023)
  if (typeof (Array.prototype as any).findLast !== 'function') {
    (Array.prototype as any).findLast = function(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => boolean) { for (var i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return this[i]; return undefined; };
  }
  if (typeof (Array.prototype as any).findLastIndex !== 'function') {
    (Array.prototype as any).findLastIndex = function(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => boolean) { for (var i = this.length - 1; i >= 0; i--) if (fn(this[i], i, this)) return i; return -1; };
  }
  // Object.hasOwn (ES2022)
  if (typeof (Object as any).hasOwn !== 'function') {
    (Object as any).hasOwn = (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key);
  }
  // structuredClone basic polyfill if missing
  if (typeof structuredClone === 'undefined') {
    (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
  }

  // ── RTCPeerConnection stub (item 541) ─────────────────────────────────────

  class RTCPeerConnection_ {
    localDescription: unknown = null; remoteDescription: unknown = null;
    signalingState = 'closed'; connectionState = 'closed'; iceConnectionState = 'closed'; iceGatheringState = 'complete';
    onicecandidate: ((ev: unknown) => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    ondatachannel: ((ev: unknown) => void) | null = null;
    onnegotiationneeded: ((ev: unknown) => void) | null = null;
    oniceconnectionstatechange: ((ev: unknown) => void) | null = null;
    onicegatheringstatechange: ((ev: unknown) => void) | null = null;
    onsignalingstatechange: ((ev: unknown) => void) | null = null;
    onconnectionstatechange: ((ev: unknown) => void) | null = null;
    _listeners: Map<string, Array<(ev: unknown) => void>> = new Map();

    constructor(_config?: unknown) {}
    createOffer(_opts?: unknown): Promise<{ type: string; sdp: string }> { return Promise.resolve({ type: 'offer', sdp: '' }); }
    createAnswer(_opts?: unknown): Promise<{ type: string; sdp: string }> { return Promise.resolve({ type: 'answer', sdp: '' }); }
    setLocalDescription(_desc: unknown): Promise<void> { return Promise.resolve(); }
    setRemoteDescription(_desc: unknown): Promise<void> { return Promise.resolve(); }
    addIceCandidate(_candidate?: unknown): Promise<void> { return Promise.resolve(); }
    addTrack(_track: unknown, ..._streams: unknown[]): unknown { return {}; }
    removeTrack(_sender: unknown): void {}
    addTransceiver(_trackOrKind: unknown, _init?: unknown): unknown { return { sender: {}, receiver: {}, direction: 'inactive', stop() {} }; }
    getTransceivers(): unknown[] { return []; }
    getSenders(): unknown[] { return []; }
    getReceivers(): unknown[] { return []; }
    getStats(): Promise<Map<string, unknown>> { return Promise.resolve(new Map()); }
    createDataChannel(label: string, _opts?: unknown): unknown {
      return { label, readyState: 'open', send() {}, close() {}, onmessage: null, onopen: null, onclose: null, onerror: null, addEventListener() {}, removeEventListener() {} };
    }
    close(): void { this.connectionState = 'closed'; this.signalingState = 'closed'; }
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type)!.push(fn); }
    removeEventListener(type: string, fn: (ev: unknown) => void): void { var arr = this._listeners.get(type); if (arr) { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); } }
    static generateCertificate(_keygenAlgorithm: unknown): Promise<unknown> { return Promise.resolve({}); }
  }

  class RTCSessionDescription_ {
    type: string; sdp: string;
    constructor(init: { type: string; sdp: string }) { this.type = init.type; this.sdp = init.sdp; }
    toJSON() { return { type: this.type, sdp: this.sdp }; }
  }

  class RTCIceCandidate_ {
    candidate: string; sdpMid: string | null; sdpMLineIndex: number | null;
    constructor(init: { candidate?: string; sdpMid?: string; sdpMLineIndex?: number } = {}) {
      this.candidate = init.candidate ?? ''; this.sdpMid = init.sdpMid ?? null; this.sdpMLineIndex = init.sdpMLineIndex ?? null;
    }
    toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; }
  }

  // ── Notification API (item 538) ────────────────────────────────────────────

  class Notification_ {
    static permission: string = 'default';
    static maxActions = 2;
    title: string; body: string; icon: string; tag: string; silent: boolean;
    onclick: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onshow:  ((ev: unknown) => void) | null = null;

    constructor(title: string, opts?: { body?: string; icon?: string; tag?: string; silent?: boolean }) {
      this.title = title;
      this.body = opts?.body ?? ''; this.icon = opts?.icon ?? ''; this.tag = opts?.tag ?? ''; this.silent = opts?.silent ?? false;
      if (Notification_.permission === 'granted') {
        cb.log('[Notification] ' + title + (this.body ? ': ' + this.body : ''));
        setTimeout(() => { if (this.onshow) try { this.onshow({}); } catch(_) {} }, 0);
      }
    }
    close(): void { if (this.onclose) try { this.onclose({}); } catch(_) {} }
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (type === 'click') this.onclick = fn; if (type === 'close') this.onclose = fn; }
    removeEventListener(): void {}

    static requestPermission(): Promise<string> {
      Notification_.permission = 'granted'; // Auto-grant in OS context
      return Promise.resolve('granted');
    }
  }

  // ── Selection API stub (item 581) ─────────────────────────────────────────

  var _selectionRanges: VRange[] = [];
  var _selection: {
    type: string; rangeCount: number; isCollapsed: boolean;
    anchorNode: VElement | null; anchorOffset: number; focusNode: VElement | null; focusOffset: number;
    getRangeAt(i: number): VRange | null;
    addRange(range: VRange): void;
    removeAllRanges(): void;
    removeRange(range: VRange): void;
    collapse(node: VElement | null, offset?: number): void;
    collapseToStart(): void;
    collapseToEnd(): void;
    toString(): string;
    selectAllChildren(node: VElement): void;
    containsNode(node: VElement, partlyContained?: boolean): boolean;
    deleteFromDocument(): void;
    extend(node: VElement, offset?: number): void;
    setBaseAndExtent(anchorNode: VElement, anchorOffset: number, focusNode: VElement, focusOffset: number): void;
    modify(alter: string, direction: string, granularity: string): void;
  } = {
    type: 'None', rangeCount: 0, isCollapsed: true,
    anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
    getRangeAt(i: number): VRange | null { return _selectionRanges[i] ?? null; },
    addRange(range: VRange): void {
      _selectionRanges = [range];
      this.rangeCount = 1; this.type = range.collapsed ? 'Caret' : 'Range';
      this.anchorNode = range.startContainer as VElement | null; this.anchorOffset = range.startOffset;
      this.focusNode  = range.endContainer as VElement | null;   this.focusOffset  = range.endOffset;
      this.isCollapsed = range.collapsed;
    },
    removeAllRanges(): void { _selectionRanges = []; this.rangeCount = 0; this.type = 'None'; this.isCollapsed = true; },
    removeRange(range: VRange): void { _selectionRanges = _selectionRanges.filter(r => r !== range); this.rangeCount = _selectionRanges.length; },
    collapse(node: VElement | null, offset = 0): void {
      var r = new VRange(); if (node) { r.setStart(node, offset); r.collapse(true); } this.addRange(r);
    },
    collapseToStart(): void { if (_selectionRanges[0]) { _selectionRanges[0].collapse(true); this.addRange(_selectionRanges[0]); } },
    collapseToEnd(): void { if (_selectionRanges[0]) { _selectionRanges[0].collapse(false); this.addRange(_selectionRanges[0]); } },
    toString(): string { return _selectionRanges.map(r => r.toString()).join(''); },
    selectAllChildren(node: VElement): void { var r = new VRange(); r.selectNodeContents(node); this.addRange(r); },
    containsNode(node: VElement, _partlyContained = false): boolean { return _selectionRanges.some(r => r.startContainer === node || r.endContainer === node); },
    deleteFromDocument(): void { _selectionRanges.forEach(r => r.deleteContents()); this.removeAllRanges(); },
    extend(node: VElement, offset = 0): void { if (_selectionRanges[0]) { _selectionRanges[0].setEnd(node, offset); this.addRange(_selectionRanges[0]); } },
    setBaseAndExtent(aNode: VElement, aOffset: number, fNode: VElement, fOffset: number): void {
      var r = new VRange(); r.setStart(aNode, aOffset); r.setEnd(fNode, fOffset); this.addRange(r);
    },
    modify(_alter: string, _direction: string, _granularity: string): void {},
  };
  // Wire document.getSelection() to the same selection object (item 581)
  (doc as any)._selectionRef = _selection;

  // ── HTMLCanvasElement (2D context stub) ───────────────────────────────────

  class HTMLCanvas {
    width = 300; height = 150;
    _ctx: any = null;
    getContext(type: string): any {
      if (type !== '2d') return null;
      if (this._ctx) return this._ctx;
      var noop = () => {}; var self = this;
      this._ctx = {
        canvas: this,
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
        font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
        shadowBlur: 0, shadowColor: 'transparent', shadowOffsetX: 0, shadowOffsetY: 0,
        lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0,
        globalCompositeOperation: 'source-over',
        save: noop, restore: noop,
        scale: noop, rotate: noop, translate: noop, transform: noop, setTransform: noop, resetTransform: noop,
        clearRect: noop, fillRect: noop, strokeRect: noop,
        beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
        bezierCurveTo: noop, quadraticCurveTo: noop, arc: noop, arcTo: noop, ellipse: noop, rect: noop,
        fill: noop, stroke: noop, clip: noop,
        fillText: noop, strokeText: noop,
        measureText: (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 }),
        drawImage: noop, putImageData: noop,
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (x: number, y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createPattern: () => ({}), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
        setLineDash: noop, getLineDash: () => [],
        isPointInPath: () => false, isPointInStroke: () => false,
        get width() { return self.width; }, get height() { return self.height; },
      };
      return this._ctx;
    }
    toDataURL(_type?: string): string { return 'data:image/png;base64,'; }
    toBlob(cb: (b: Blob | null) => void): void { cb(null); }
    getBoundingClientRect() { return { x:0, y:0, width:this.width, height:this.height, top:0, left:0, right:this.width, bottom:this.height }; }
  }

  // ── Image() / Audio() constructors ─────────────────────────────────────
  class _Image_ extends VElement {
    constructor(width?: number, height?: number) {
      super('img');
      if (width  !== undefined) this.setAttribute('width',  String(width));
      if (height !== undefined) this.setAttribute('height', String(height));
    }
  }
  class _Audio_ extends VElement {
    constructor(src?: string) {
      super('audio');
      if (src) this.setAttribute('src', src);
    }
  }

  // ── matchMedia helper (item 373) ─────────────────────────────────────────
  // Evaluate a CSS media query string against a fixed 1024×768 viewport.
  function _evalMediaQuery(query: string): boolean {
    var q = query.trim().toLowerCase();
    // Comma-separated OR
    if (q.includes(',')) return q.split(',').some(part => _evalMediaQuery(part.trim()));
    // 'not' prefix
    var negated = false;
    if (q.startsWith('not ')) { negated = true; q = q.slice(4).trim(); }
    // Strip leading media type: screen, print, all
    var result = _evalMQCore(q);
    return negated ? !result : result;
  }
  function _evalMQCore(q: string): boolean {
    // Pure media type
    if (q === 'screen') return true;
    if (q === 'print')  return false;
    if (q === 'all')    return true;
    if (q === 'speech') return false;
    // Strip media type prefix like "screen and (...)"
    var andIdx = q.indexOf(' and ');
    if (andIdx > 0) {
      var mtype = q.slice(0, andIdx).trim();
      if (mtype === 'screen' || mtype === 'all') { q = q.slice(andIdx + 5).trim(); }
      else if (mtype === 'print' || mtype === 'speech') return false;
    }
    // Evaluate individual feature queries inside parens — all parts ANDed
    var w = 1024, h = 768;
    var parts = q.match(/\([^)]+\)/g) || [q];
    return parts.every(part => {
      var inner = part.replace(/^\(|\)$/g, '').trim();
      // min-width / max-width
      var mw = inner.match(/^(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?$/);
      if (mw) { var v = parseFloat(mw[2]); return mw[1] === 'min' ? w >= v : w <= v; }
      // min-height / max-height
      var mh = inner.match(/^(min|max)-height\s*:\s*([\d.]+)(px|em|rem)?$/);
      if (mh) { var v = parseFloat(mh[2]); return mh[1] === 'min' ? h >= v : h <= v; }
      // aspect-ratio
      var ar = inner.match(/^(min-|max-)?aspect-ratio\s*:\s*(\d+)\s*\/\s*(\d+)$/);
      if (ar) { var ratio = parseInt(ar[2]) / parseInt(ar[3]); var actual = w / h; return ar[1] === 'min-' ? actual >= ratio : ar[1] === 'max-' ? actual <= ratio : Math.abs(actual - ratio) < 0.01; }
      // orientation
      if (inner === 'orientation: portrait')  return h >= w;
      if (inner === 'orientation: landscape') return w > h;
      // prefers-color-scheme
      if (inner === 'prefers-color-scheme: light') return true;
      if (inner === 'prefers-color-scheme: dark')  return false;
      // prefers-reduced-motion
      if (inner === 'prefers-reduced-motion: no-preference') return true;
      if (inner === 'prefers-reduced-motion: reduce')        return false;
      // prefers-contrast
      if (inner === 'prefers-contrast: no-preference') return true;
      if (inner.startsWith('prefers-contrast:'))       return false;
      // color
      if (inner === 'color')               return true;
      if (inner.match(/^color:\s*\d+$/))   return true;
      if (inner.match(/^min-color:/))      return true;
      if (inner === 'color-gamut: srgb')   return true;
      if (inner.startsWith('color-gamut')) return false;
      // hover / pointer
      if (inner === 'hover: none')    return false;
      if (inner === 'hover: hover')   return true;
      if (inner === 'pointer: fine')  return true;
      if (inner === 'pointer: coarse')return false;
      if (inner === 'pointer: none')  return false;
      // display-mode
      if (inner === 'display-mode: browser')  return true;
      if (inner.startsWith('display-mode:'))  return false;
      // Unknown — be permissive
      return true;
    });
  }

  /** [Item 438] Evaluate a CSS @container query condition against the element's container.
   *  Looks up the named container element (or nearest block ancestor) and checks its size. */
  function _evalContainerQuery(el: VElement, containerName: string, conditionText: string): boolean {
    // Walk ancestors to find the named container (or any container)
    var ancestor: VElement | null = el.parentNode as VElement | null;
    while (ancestor && ancestor.tagName) {
      var ct = (ancestor as any)._cssCache?.['container-type'] || (ancestor as any)._cssCache?.['containerType'];
      var cn = (ancestor as any)._cssCache?.['container-name'] || (ancestor as any)._cssCache?.['containerName'] || '';
      if (ct || cn) {
        if (!containerName || cn === containerName || cn.split(/\s+/).indexOf(containerName) >= 0) break;
      }
      ancestor = ancestor.parentNode as VElement | null;
    }
    // Estimate container size: use rendered width heuristic or fall back to viewport
    var cw = 1024, ch = 768;
    if (ancestor && (ancestor as any)._renderedWidth)  cw = (ancestor as any)._renderedWidth;
    if (ancestor && (ancestor as any)._renderedHeight) ch = (ancestor as any)._renderedHeight;
    // Parse the condition text (same logic as _evalMQCore but for container dims)
    var innerCond = conditionText.replace(/^\(|\)$/g, '');
    var cparts = innerCond.match(/\([^)]+\)/g) || [innerCond];
    return cparts.every(part => {
      var inner = part.replace(/^\(|\)$/g, '').trim().toLowerCase();
      var mw2 = inner.match(/^(min|max)-width\s*:\s*([\d.]+)(px|em|rem)?$/);
      if (mw2) { var v2 = parseFloat(mw2[2]); return mw2[1] === 'min' ? cw >= v2 : cw <= v2; }
      var mh2 = inner.match(/^(min|max)-height\s*:\s*([\d.]+)(px|em|rem)?$/);
      if (mh2) { var v3 = parseFloat(mh2[2]); return mh2[1] === 'min' ? ch >= v3 : ch <= v3; }
      var ar2 = inner.match(/^(min-|max-)?aspect-ratio\s*:\s*(\d+)\s*\/\s*(\d+)$/);
      if (ar2) { var rat2 = parseInt(ar2[2]) / parseInt(ar2[3]); var act2 = cw / ch; return ar2[1] === 'min-' ? act2 >= rat2 : ar2[1] === 'max-' ? act2 <= rat2 : Math.abs(act2 - rat2) < 0.01; }
      return true;  // unknown — permissive
    });
  }

  // [Item 950] Registry of all MediaQueryList objects so we can fire their listeners on resize
  var _mqlRegistry: Array<{ mql: any; lastMatches: boolean }> = [];

  function _checkMediaListeners(): void {
    for (var entry of _mqlRegistry) {
      var nowMatches = entry.mql.matches as boolean;
      if (nowMatches !== entry.lastMatches) {
        entry.lastMatches = nowMatches;
        var evt = { matches: nowMatches, media: entry.mql.media as string };
        // Fire onchange handler
        if (typeof entry.mql.onchange === 'function') { try { entry.mql.onchange(evt); } catch(_) {} }
        // Fire all addEventListener/addListener listeners (access via internal ref)
        var ls = (entry.mql as any)._listeners as Array<(e: unknown) => void> | undefined;
        if (ls) { for (var fn of ls) { try { fn(evt); } catch(_) {} } }
      }
    }
  }

  function _makeMediaQueryList(q: string): any {
    var listeners: Array<(ev: {matches: boolean; media: string}) => void> = [];
    var mql: any = {
      get matches() { return _evalMediaQuery(q); },
      media: q,
      onchange: null as ((ev: unknown) => void) | null,
      _listeners: listeners,
      addEventListener(_type: string, fn: (ev: unknown) => void): void { listeners.push(fn as any); },
      removeEventListener(_type: string, fn: (ev: unknown) => void): void { var i = listeners.indexOf(fn as any); if (i >= 0) listeners.splice(i, 1); },
      addListener(fn: (ev: unknown) => void)    { listeners.push(fn as any); },    // legacy
      removeListener(fn: (ev: unknown) => void) { var i = listeners.indexOf(fn as any); if (i >= 0) listeners.splice(i, 1); }, // legacy
    };
    _mqlRegistry.push({ mql, lastMatches: _evalMediaQuery(q) });
    return mql;
  }

  // ── Build the global window object ────────────────────────────────────────

  var win: Record<string, unknown> = {
    // Self-references
    get window()    { return win; },
    get self()      { return win; },
    get globalThis(){ return win; },
    get top()       { return win; },
    get parent()    { return win; },
    get frames()    { return win; },
    get length()    { return 0; },
    opener:         null,          // no popup parent
    frameElement:   null,          // not embedded in a frame

    // Core globals
    document: doc,
    location,
    history,
    navigator,
    screen,
    performance,
    crypto,

    // Timers
    setTimeout:   setTimeout_,
    setInterval:  setInterval_,
    clearTimeout: clearTimeout_,
    clearInterval:clearInterval_,

    // Animation
    requestAnimationFrame,
    cancelAnimationFrame,

    // Networking
    fetch:           fetchAPI,
    XMLHttpRequest,
    Request:         Request_,
    Response:        Response_,

    // DOM constructors
    Event:              VEvent,
    UIEvent,
    CustomEvent,
    MouseEvent,
    PointerEvent,
    WheelEvent,
    KeyboardEvent,
    InputEvent,
    FocusEvent,
    CompositionEvent,
    TouchEvent,
    DragEvent,
    ErrorEvent,
    MessageEvent,
    StorageEvent,
    HashChangeEvent,
    PopStateEvent,
    PageTransitionEvent,
    AnimationEvent,
    TransitionEvent,
    BeforeUnloadEvent,
    SubmitEvent,
    ClipboardEvent,
    GamepadEvent,
    SecurityPolicyViolationEvent,
    EventTarget: VEventTarget,  // VNode extends VEventTarget → instanceof EventTarget works (item 871)
    DOMException,
    MutationObserver:    MutationObserverImpl,
    IntersectionObserver: IntersectionObserverImpl,
    ResizeObserver:       ResizeObserverImpl,
    PerformanceObserver:  BrowserPerformanceObserver,
    Worker:               WorkerImpl,
    SharedWorker:         SharedWorkerImpl,
    MessageChannel,
    BroadcastChannel:     BroadcastChannelImpl,
    DOMParser,
    XMLSerializer,
    TextEncoder: TextEncoder_,
    TextDecoder: TextDecoder_,
    HTMLCanvasElement: HTMLCanvas,
    // Streams API
    ReadableStream:  ReadableStream_,
    WritableStream:  WritableStream_,
    TransformStream: TransformStream_,
    ReadableStreamDefaultReader: ReadableStreamDefaultReader_,
    CountQueuingStrategy:    CountQueuingStrategy_,
    ByteLengthQueuingStrategy: ByteLengthQueuingStrategy_,
    // Transform streams (item 545 adjacent)
    TextEncoderStream:     TextEncoderStream_,
    TextDecoderStream:     TextDecoderStream_,
    CompressionStream:     CompressionStream_,
    DecompressionStream:   DecompressionStream_,

    // Custom Elements
    customElements:      customElementsAPI,
    HTMLElement:         VElement,
    HTMLMediaElement:    VElement,    // HTMLMediaElement constructor alias
    HTMLInputElement:    VElement,
    HTMLSelectElement:   VElement,
    HTMLTextAreaElement: VElement,
    HTMLFormElement:     VElement,
    HTMLButtonElement:   VElement,
    HTMLAnchorElement:   VElement,
    HTMLImageElement:    VElement,
    // Image() constructor shorthand
    Image: _Image_,
    // Audio() constructor shorthand
    Audio: _Audio_,
    HTMLDivElement:      VElement,
    HTMLSpanElement:     VElement,
    HTMLParagraphElement: VElement,
    HTMLHeadingElement:  VElement,
    HTMLScriptElement:   VElement,
    HTMLLinkElement:     VElement,
    HTMLMetaElement:     VElement,
    HTMLTableElement:    VElement,
    HTMLTableRowElement: VElement,
    HTMLTableCellElement: VElement,
    HTMLLIElement:       VElement,
    HTMLUListElement:    VElement,
    HTMLOListElement:    VElement,
    HTMLPreElement:      VElement,
    HTMLVideoElement:    VElement,
    HTMLAudioElement:    VElement,
    HTMLCanvasElement2:  VElement,
    Node:                VNode,        // base class for Element, Document, Text, etc.
    Element:             VElement,
    Document:            VDocument,    // document instanceof Document checks (item 873)
    HTMLCollection:      Array,
    NodeList:            Array,
    DocumentFragment:    DocumentFragment_,
    Range:               VRange,       // new Range() and instanceof Range checks (item 580)
    StaticRange:         VRange,       // StaticRange alias
    WeakRef:             WeakRefImpl,
    FinalizationRegistry: FinalizationRegistryImpl,

    // Viewport
    innerWidth: 1024, innerHeight: 768,
    outerWidth: 1024, outerHeight: 768,
    devicePixelRatio: 1,
    screenX: 0, screenY: 0,
    screenLeft: 0, screenTop: 0,
    get scrollX() { return 0; },
    get scrollY() { return cb.getScrollY(); },
    get pageXOffset() { return 0; },
    get pageYOffset() { return cb.getScrollY(); },

    // Gamepad API stub (item 63 / 541)
    getGamepads(): unknown[] { return []; },

    // File System Access API stubs
    showOpenFilePicker(_opts?: unknown): Promise<unknown[]> { return Promise.reject(new DOMException('NotSupportedError')); },
    showSaveFilePicker(_opts?: unknown): Promise<unknown>  { return Promise.reject(new DOMException('NotSupportedError')); },
    showDirectoryPicker(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); },

    // Storage
    localStorage:  _localStorage,
    sessionStorage: _sessionStorage,
    indexedDB:     _indexedDB,
    IDBKeyRange:   { only: (v: unknown) => v, lowerBound: (v: unknown) => v, upperBound: (v: unknown) => v, bound: (l: unknown) => l },

    // Misc
    console: console_,
    Blob,
    File,
    FileReader:      FileReader_,
    FileList:        FileList_,
    URL: URL_,
    URLSearchParams: URLSearchParamsImpl,
    FormData:        FormData_,
    Headers: Headers_,
    AbortController: AbortControllerImpl,
    AbortSignal:     AbortSignalImpl,
    WebSocket:       WebSocket_,
    CSSStyleSheet:   CSSStyleSheet_,
    // CSS rule constructors (items 580-582)
    CSSRule:          CSSRule_,
    CSSStyleRule:     CSSStyleRule_,
    CSSMediaRule:     CSSMediaRule_,
    CSSKeyframesRule: CSSKeyframesRule_,
    CSSKeyframeRule:  CSSKeyframeRule_,   // individual keyframe stop (type=8)
    CSSSupportsRule:  CSSSupportsRule_,
    CSSFontFaceRule:  CSSFontFaceRule_,
    CSSImportRule:    CSSImportRule_,
    AggregateError:  AggregateError_,
    RTCPeerConnection:      RTCPeerConnection_,
    RTCSessionDescription:  RTCSessionDescription_,
    RTCIceCandidate:        RTCIceCandidate_,
    Notification:           Notification_,

    // Web Audio API
    AudioContext: AudioContext_,
    webkitAudioContext: AudioContext_,   // Safari legacy alias
    AudioBuffer:     AudioContext_.prototype.createBuffer,
    AudioNode:       AudioNode_,
    AudioParam:      AudioParam_,
    SpeechSynthesisUtterance: SpeechSynthesisUtterance_,

    // Clipboard & Fonts
    ClipboardItem:    ClipboardItem_,
    FontFace:         FontFace_,
    FontFaceSet:      FontFaceSet_,

    // EventSource (SSE)
    EventSource: EventSource_,

    // OffscreenCanvas
    OffscreenCanvas: OffscreenCanvas_,

    // Geometry primitives (DOMRect, DOMPoint, DOMMatrix)
    DOMRect:          DOMRect_,
    DOMRectReadOnly:  DOMRectReadOnly_,
    DOMPoint:         DOMPoint_,
    DOMPointReadOnly: DOMPoint_,
    DOMMatrix:        DOMMatrix_,
    DOMMatrixReadOnly: DOMMatrixReadOnly_,

    // XPathResult constants — used with document.evaluate()
    XPathResult: { ANY_TYPE: 0, NUMBER_TYPE: 1, STRING_TYPE: 2, BOOLEAN_TYPE: 3, UNORDERED_NODE_ITERATOR_TYPE: 4, ORDERED_NODE_ITERATOR_TYPE: 5, UNORDERED_NODE_SNAPSHOT_TYPE: 6, ORDERED_NODE_SNAPSHOT_TYPE: 7, ANY_UNORDERED_NODE_TYPE: 8, FIRST_ORDERED_NODE_TYPE: 9 },

    // Speech + Cache
    speechSynthesis: _speechSynthesis,
    caches: _caches,

    // Utilities
    getComputedStyle,
    CSS:          CSS_,
    visualViewport: _visualViewport,
    getSelection: (): unknown => _selection,   // window.getSelection (item 581)
    matchMedia: (q: string) => _makeMediaQueryList(q),
    open:     (url?: string, _target?: string, _features?: string) => { if (url && url !== 'about:blank') cb.navigate(url); return null; },
    close:    () => {},
    stop:     () => {},    // cancel page load
    find:     (_str?: string): boolean => false,
    focus:    () => {},
    blur:     () => {},
    moveTo:   (_x: number, _y: number): void => {},
    moveBy:   (_dx: number, _dy: number): void => {},
    resizeTo: (_w: number, _h: number): void => {},
    resizeBy: (_dw: number, _dh: number): void => {},
    scrollTo: (x: number, y: number) => cb.scrollTo(x, y),
    scrollBy: (_x: number, dy: number) => cb.scrollTo(0, cb.getScrollY() + dy),
    scroll:   (x: number, y: number) => cb.scrollTo(x, y),
    alert:    (msg: unknown) => cb.alert(String(msg ?? '')),
    confirm:  (msg: unknown): boolean => cb.confirm(String(msg ?? '')),
    prompt:   (msg: unknown, def: unknown): string => cb.prompt(String(msg ?? ''), String(def ?? '')),
    print:    () => {},
    name:          '',           // window.name (item 865)
    status:        '',           // window.status (item 865)
    defaultStatus: '',           // window.defaultStatus (item 865)
    onpopstate: null as unknown,   // window.onpopstate (item 499)
    onerror: null as unknown,      // window.onerror
    /** Navigation API (Chrome 102+, item 712) */
    navigation: {
      currentEntry: { url: cb.baseURL, id: '1', index: 0, sameDocument: true, getState() { return undefined; } },
      entries(): any[] { return [(win as any).navigation.currentEntry]; },
      navigate(url: string): { committed: Promise<void>; finished: Promise<void> } {
        cb.navigate(url);
        return { committed: Promise.resolve(), finished: Promise.resolve() };
      },
      back():    { committed: Promise<void>; finished: Promise<void> } { history.back();    return { committed: Promise.resolve(), finished: Promise.resolve() }; },
      forward(): { committed: Promise<void>; finished: Promise<void> } { history.forward(); return { committed: Promise.resolve(), finished: Promise.resolve() }; },
      traverseTo(_key: string): { committed: Promise<void>; finished: Promise<void> } { return { committed: Promise.resolve(), finished: Promise.resolve() }; },
      onnavigate: null as any,
      onnavigatesuccess: null as any,
      onnavigateerror: null as any,
      oncurrententrychange: null as any,
      addEventListener(_t: string, _fn: unknown) {}, removeEventListener(_t: string, _fn: unknown) {},
    },
    onunhandledrejection: null as unknown,
    onrejectionhandled:   null as unknown,
    onstorage: null as unknown,
    onoffline: null as unknown,
    ononline:  null as unknown,
    onbeforeunload: null as unknown,
    onhashchange: null as unknown,
    onpagehide: null as unknown,
    onpageshow: null as unknown,
    onmessage:  null as unknown,
    onmessageerror: null as unknown,
    postMessage: (_data: unknown, _origin?: string): void => {},
    // reportError — report an error to the console and fire window error event
    reportError(err: unknown): void {
      cb.log('[reportError] ' + String(err));
      var ev = new VEvent('error', { bubbles: false, cancelable: true });
      (ev as any).error = err; (ev as any).message = String(err);
      try { doc.dispatchEvent(ev); } catch(_) {}
    },
    // createImageBitmap — returns a resolved promise with a stub ImageBitmap
    createImageBitmap(_image: unknown, _sxOrOpts?: unknown, _sy?: number, _sw?: number, _sh?: number): Promise<unknown> {
      var bm = { width: 0, height: 0, close() {} };
      return Promise.resolve(bm);
    },
    // Secure context flags (item 548 adjacent — needed for crypto.subtle, clipboard, etc.)
    isSecureContext: true,          // treat JSOS as a secure context
    crossOriginIsolated: false,     // no SharedArrayBuffer isolation
    // Trusted Types stub — checked by CSP-strict apps to see if API exists
    trustedTypes: null as unknown,
    // origin — used by service workers and fetch
    get origin(): string { try { return new URL_(cb.baseURL).origin; } catch(_) { return 'null'; } },
    dispatchEvent: (ev: VEvent) => {
      // Also invoke window.on<type> handler if set (item 530)
      var onProp = 'on' + ev.type;
      var handler = (win as any)[onProp];
      if (typeof handler === 'function') { try { handler(ev); } catch(_) {} }
      return doc.dispatchEvent(ev);
    },
    addEventListener:    (t: string, fn: (e: VEvent) => void) => doc.addEventListener(t, fn),
    removeEventListener: (t: string, fn: (e: VEvent) => void) => doc.removeEventListener(t, fn),

    // Standard JS globals (in case scripts shadow these)
    undefined, null: null, NaN, Infinity, isFinite, isNaN, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Intl: Intl_,
    JSON, Math, Date, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError,
    Promise, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect,
    Array, Object, String, Number, Boolean, BigInt,
    ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, Uint8ClampedArray, DataView,
    BigInt64Array: (typeof BigInt64Array !== 'undefined') ? BigInt64Array : undefined,
    BigUint64Array: (typeof BigUint64Array !== 'undefined') ? BigUint64Array : undefined,
    SharedArrayBuffer: (typeof SharedArrayBuffer !== 'undefined') ? SharedArrayBuffer : undefined,
    Atomics: (typeof Atomics !== 'undefined') ? Atomics : undefined,
    atob: (b64: string): string => {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var out = ''; var buf = 0; var bits = 0;
      for (var i = 0; i < b64.length; i++) {
        var idx = chars.indexOf(b64[i]); if (idx < 0) continue;
        buf = (buf << 6) | idx; bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xFF); }
      }
      return out;
    },
    btoa: (s: string): string => {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var out = ''; var buf = 0; var bits = 0;
      for (var i = 0; i < s.length; i++) {
        buf = (buf << 8) | s.charCodeAt(i); bits += 8;
        while (bits >= 6) { bits -= 6; out += chars[(buf >> bits) & 63]; }
      }
      if (bits > 0) out += chars[(buf << (6 - bits)) & 63];
      while (out.length % 4) out += '='; return out;
    },
    queueMicrotask: queueMicrotask_,
    scheduler,
    requestIdleCallback,
    cancelIdleCallback,
    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v)),
  };

  // ── Wire localStorage/sessionStorage → `storage` events (item 500) ────────
  function _makeStorageListener(area: VStorage): (key: string | null, old: string | null, nxt: string | null) => void {
    return (key: string | null, old: string | null, nxt: string | null) => {
      var ev = new StorageEvent('storage', {
        bubbles: false, cancelable: false,
        key, oldValue: old, newValue: nxt,
        url: cb.baseURL, storageArea: area,
      });
      try { (win['dispatchEvent'] as (e: VEvent) => void)(ev); } catch (_) {}
    };
  }
  _localStorage._listener   = _makeStorageListener(_localStorage);
  _sessionStorage._listener = _makeStorageListener(_sessionStorage);

  // ── Patch doc.createElement to return HTMLCanvas for <canvas> ─────────────

  {
    var _origCreateElement = doc.createElement.bind(doc);
    doc.createElement = function(tag: string) {
      if (tag.toLowerCase() === 'canvas') return new HTMLCanvas() as any;
      return _origCreateElement(tag);
    };
  }

  // ── Wire on* attribute handlers ───────────────────────────────────────────

  function wireHandlers(root: VElement, ctx: Record<string, unknown>): void {
    _walk(root, el => {
      var onAttrs = ['onclick','onchange','oninput','onsubmit','onkeydown','onkeyup',
                     'onfocus','onblur','onmouseover','onmouseout','onmouseenter','onmouseleave',
                     'ondblclick','oncontextmenu','onresize','onscroll','onload'];
      for (var attr of onAttrs) {
        var code = el.getAttribute(attr); if (!code) continue;
        (function(evName: string, evCode: string, elem: VElement) {
          var handler = _makeHandler(evCode, ctx);
          if (handler) {
            var evType = evName.slice(2); // strip 'on'
            elem.addEventListener(evType, handler);
          }
        })(attr, code, el);
      }
    });
  }

  function _makeHandler(code: string, ctx: Record<string, unknown>): ((e: VEvent) => void) | null {
    try {
      var fn = new Function(...Object.keys(ctx), 'event', code);
      return (e: VEvent) => {
        try { fn(...Object.values(ctx), e); } catch(err) { cb.log('[JS handler err] ' + String(err)); }
        checkDirty();
      };
    } catch(e) {
      cb.log('[JS compile err] ' + String(e) + '  code: ' + code.slice(0, 80));
      return null;
    }
  }

  // ── Execute a script code string in the window context ────────────────────

  function execScript(code: string): void {
    try {
      // Build a function with all window properties as named parameters
      var keys = Object.keys(win);
      var fn   = new Function(...keys, '"use strict";\n' + code);
      fn(...keys.map(k => win[k]));
    } catch (e) {
      cb.log('[JS error] ' + String(e));
      // Fire window.onerror and window error event (item 530)
      var onErr = (win as any).onerror;
      if (typeof onErr === 'function') {
        try { onErr(String(e), '', 0, 0, e); } catch(_) {}
      }
      var errEv = new VEvent('error', { bubbles: false, cancelable: true });
      (errEv as any).error = e; (errEv as any).message = String(e);
      try { doc.dispatchEvent(errEv); } catch(_) {}
    }
    checkDirty();
  }

  // ── Load external scripts synchronously via fetchAsync ───────────────────

  function loadExternalScript(src: string, done: (code?: string) => void, noAutoExec = false): void {
    var url = src.startsWith('http') ? src : _resolveURL(src, _baseHref);
    os.fetchAsync(url, (resp: FetchResponse | null, _err?: string) => {
      if (resp && resp.status === 200) {
        if (!noAutoExec) execScript(resp.bodyText);
        done(resp.bodyText);
      } else {
        cb.log('[JS] failed to load script: ' + url);
        done(undefined);
      }
    });
  }

  // ── Run all collected scripts sequentially ────────────────────────────────

  // Module registry for basic import() support (item 534)
  var _moduleCache: Map<string, unknown> = new Map();

  function _transformModuleCode(code: string, moduleURL: string): string {
    // Inject import.meta.url and transform basic ES module syntax for New Function context
    var header = 'var import_meta_url = ' + JSON.stringify(moduleURL) + ';\n' +
                  'var import_meta = { url: import_meta_url, resolve: function(s) { return s; } };\n' +
                  'var __esm_exports = {};\n';
    // Replace `import.meta` with our injected variable
    var transformed = code.replace(/\bimport\.meta\b/g, 'import_meta');
    // Strip bare top-level import statements (import x from 'y'; import { a } from 'b';)
    // Replace with empty comment so line numbers are preserved-ish and stack traces show origin
    transformed = transformed.replace(/^[ \t]*import\s+(?:type\s+)?(?:[\w{},*\s]+from\s+)?['"][^'"]*['"]\s*;?[ \t]*/gm, '/* import stripped */ ');
    // Strip export keywords from top-level declarations
    transformed = transformed.replace(/^[ \t]*export\s+default\s+/gm, '__esm_exports.default = ');
    transformed = transformed.replace(/^[ \t]*export\s+(const|let|var|function|class|async)\s+/gm, (_m: string, kw: string) => kw + ' ');
    transformed = transformed.replace(/^[ \t]*export\s+\{[^}]*\}\s*;?/gm, '');
    return header + transformed;
  }

  function runScripts(idx: number): void {
    if (idx >= scripts.length) {
      // All scripts done — fire DOMContentLoaded (interactive), then load (complete)
      (doc as any)._readyState = 'interactive';
      var dclEv = new VEvent('DOMContentLoaded', { bubbles: true });
      doc.dispatchEvent(dclEv);
      (doc as any)._readyState = 'complete';
      var loadEv = new VEvent('load');
      (win['dispatchEvent'] as (e: VEvent) => void)(loadEv);  // window.onload
      doc.dispatchEvent(loadEv);
      checkDirty();
      if (needsRerender) doRerender();
      return;
    }
    var s = scripts[idx];
    // Skip non-JS scripts (but include module)
    if (s.type && !s.type.match(/javascript|ecmascript|module|text$/i)) {
      runScripts(idx + 1); return;
    }
    var isModule = s.type && s.type.toLowerCase().includes('module');
    if (s.inline) {
      var code = isModule ? _transformModuleCode(s.code, _baseHref + '#script-' + idx) : s.code;
      execScript(code);
      runScripts(idx + 1);
    } else {
      var scriptBaseURL = _resolveURL(s.src, _baseHref);
      loadExternalScript(s.src, (loadedCode?: string) => {
        if (isModule && loadedCode) {
          execScript(_transformModuleCode(loadedCode, scriptBaseURL));
        }
        runScripts(idx + 1);
      }, !!isModule);
    }
  }


  // ── Wire handlers then kick off script execution ──────────────────────────

  // Post-win wiring: connect doc back to win and page URL
  (doc as any)._defaultView = win;
  (doc as any)._url = cb.baseURL;
  (doc as any)._selectionRef = _selection;

  // Wire document.cookie to the shared cookie jar (items 303-304)
  Object.defineProperty(doc, 'cookie', {
    get(): string {
      try { var _du = new URL(_effectiveHref()); return cookieJar.getDocumentCookies(_du.hostname, _du.pathname); } catch(_) { return ''; }
    },
    set(v: string): void {
      try { var _du = new URL(_effectiveHref()); cookieJar.setFromPage(String(v), _du.hostname, _du.pathname); } catch(_) {}
    },
    configurable: true,
  });

  // Populate doc.styleSheets from <style> and <link rel="stylesheet"> (item 579)
  {
    // Helper: fetch and merge @import-ed CSS files (item 374)
    function _processImports(sheet: CSSStyleSheet_, baseURL: string): void {
      if (!sheet._pendingImports.length) return;
      var imports = sheet._pendingImports.slice(); sheet._pendingImports = [];
      for (var _ii = 0; _ii < imports.length; _ii++) {
        (function(_impURL: string) {
          var _absURL = _impURL.startsWith('http') ? _impURL : _resolveURL(_impURL, baseURL);
          os.fetchAsync(_absURL, (resp: FetchResponse | null) => {
            if (resp && resp.status === 200) {
              var _impSheet = new CSSStyleSheet_(); _impSheet._parseText(resp.bodyText);
              // Prepend imported rules before the sheet's own rules
              sheet.cssRules = (_impSheet.cssRules as any[]).concat(sheet.cssRules);
              // Recursively process @imports from the imported sheet
              _processImports(_impSheet, _absURL);
              doc._dirty = true;
            }
          });
        })(imports[_ii]);
      }
    }

    var _styleTags2 = doc.querySelectorAll('style');
    for (var _stEl2 of _styleTags2) {
      var _sheet2 = new CSSStyleSheet_(); _sheet2.ownerNode = _stEl2;
      _sheet2._parseText(_stEl2.textContent || ''); doc._styleSheets.push(_sheet2);
      _processImports(_sheet2, _baseHref);
    }
    var _linkTags2 = doc.querySelectorAll('link[rel]');
    for (var _lnEl2 of _linkTags2) {
      if ((_lnEl2.getAttribute('rel') || '').toLowerCase().includes('stylesheet')) {
        var _lnSheet2 = new CSSStyleSheet_(); _lnSheet2.href = _lnEl2.getAttribute('href') || null; _lnSheet2.ownerNode = _lnEl2; doc._styleSheets.push(_lnSheet2);
        // Async-fetch the CSS content and parse when ready
        (function (_sheet: CSSStyleSheet_, _lnEl: VElement) {
          var _cssHref = _lnEl.getAttribute('href') || '';
          if (_cssHref) {
            var _cssURL = _cssHref.startsWith('http') ? _cssHref : _resolveURL(_cssHref, _baseHref);
            os.fetchAsync(_cssURL, (resp: FetchResponse | null) => {
              if (resp && resp.status === 200) {
                _sheet._parseText(resp.bodyText);
                _processImports(_sheet, _cssURL);
                doc._dirty = true;
                try { _lnEl.dispatchEvent(new VEvent('load')); } catch(_) {}
              } else {
                try { _lnEl.dispatchEvent(new VEvent('error')); } catch(_) {}
              }
            });
          }
        })(_lnSheet2, _lnEl2);
      }
    }
  }

  wireHandlers(doc.body, win);
  wireHandlers(doc.head, win);
  runScripts(0);

  // ── PageJS interface returned to BrowserApp ───────────────────────────────

  var disposed = false;

  function findEl(id: string): VElement | null {
    if (!id) return null;
    var el = doc.getElementById(id);
    if (!el) el = doc.querySelector('[name="' + id + '"]');
    return el;
  }

  function fireAndCheck(fn: () => void): boolean {
    if (disposed) return false;
    fn();
    checkDirty();
    if (needsRerender) { doRerender(); return true; }
    return false;
  }

  return {
    fireClick(id: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id); if (!el) return;
        // mousedown → mouseup → click sequence
        for (var et of ['mousedown', 'mouseup', 'click'] as const) {
          var ev: any = new VEvent(et, { bubbles: true, cancelable: true });
          ev.button = 0; ev.buttons = et === 'mouseup' ? 0 : 1;
          ev.clientX = 0; ev.clientY = 0; ev.screenX = 0; ev.screenY = 0;
          ev.ctrlKey = false; ev.shiftKey = false; ev.altKey = false; ev.metaKey = false;
          ev.getModifierState = (_k: string) => false;
          el.dispatchEvent(ev);
        }
      });
    },
    fireChange(id: string, newValue: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id); if (!el) return;
        el._attrs.set('value', newValue);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') el.value = newValue;
        var ev: any = new VEvent('change', { bubbles: true }); ev.target = el; el.dispatchEvent(ev);
      });
    },
    fireInput(id: string, newValue: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id); if (!el) return;
        el._attrs.set('value', newValue);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = newValue;
        var ev: any = new VEvent('input', { bubbles: true }); ev.target = el; ev.data = newValue.slice(-1); ev.inputType = 'insertText'; el.dispatchEvent(ev);
      });
    },
    fireKeydown(id: string, key: string, keyCode: number): boolean {
      return fireAndCheck(() => {
        var el = findEl(id) ?? doc.body; if (!el) return;
        var ev: any = new VEvent('keydown', { bubbles: true, cancelable: true });
        ev.key = key; ev.code = 'Key' + key.toUpperCase();
        ev.keyCode = keyCode; ev.which = keyCode; ev.charCode = keyCode;
        ev.location = 0; ev.repeat = false; ev.isComposing = false;
        ev.ctrlKey = false; ev.shiftKey = false; ev.altKey = false; ev.metaKey = false;
        ev.getModifierState = (_k: string) => false;
        el.dispatchEvent(ev);
        // Also fire keypress and keyup for compatibility
        var evup: any = new VEvent('keyup', { bubbles: true, cancelable: false });
        evup.key = key; evup.code = ev.code; evup.keyCode = keyCode; evup.which = keyCode;
        evup.charCode = 0; evup.location = 0; evup.repeat = false;
        evup.ctrlKey = false; evup.shiftKey = false; evup.altKey = false; evup.metaKey = false;
        evup.getModifierState = (_k: string) => false;
        el.dispatchEvent(evup);
      });
    },
    fireSubmit(formId: string): boolean {
      return fireAndCheck(() => {
        var el = formId ? findEl(formId) : doc.querySelector('form');
        if (!el) return;
        var ev = new VEvent('submit', { bubbles: true, cancelable: true }); el.dispatchEvent(ev);
      });
    },
    fireLoad(): boolean {
      return fireAndCheck(() => {
        var ev = new VEvent('load'); doc.dispatchEvent(ev);
      });
    },
    fireResize(width: number, height: number): boolean {
      // [Item 950] Update viewport dimensions, fire resize event, check MQL listeners
      win['innerWidth']  = width;
      win['outerWidth']  = width;
      win['innerHeight'] = height;
      win['outerHeight'] = height;
      _checkMediaListeners();
      return fireAndCheck(() => {
        var ev = new VEvent('resize'); doc.dispatchEvent(ev);
      });
    },
    dispose(): void {
      disposed = true;
      timers = []; rafCallbacks = [];
      // fire beforeunload
      try { var ev = new VEvent('beforeunload'); doc.dispatchEvent(ev); } catch(_) {}
    },
    tick(nowMs: number): void {
      if (disposed) return;
      var frameStart = _perf.now();
      // Fire RAF callbacks
      if (rafCallbacks.length) {
        var cbs = rafCallbacks.splice(0);
        for (var r of cbs) {
          try { r.fn(nowMs); } catch(_) {}
          _drainMicrotasks();
        }
        checkDirty();
      }
      // Fire elapsed timers (drain microtasks after each)
      var elapsed = nowMs;
      var fired = false;
      for (var i = timers.length - 1; i >= 0; i--) {
        var t = timers[i];
        if (elapsed >= t.fireAt) {
          try { t.fn(); } catch(_) {}
          _drainMicrotasks();
          if (t.interval) { t.fireAt = elapsed + t.delay; }
          else { timers.splice(i, 1); }
          fired = true;
        }
      }
      if (fired) { checkDirty(); if (needsRerender) doRerender(); }
      // Pump Intersection and Resize Observers
      var viewH = 768;
      for (var io of _ioObservers) io._tick(viewH);
      for (var ro of _roObservers) ro._tick();
      // Pump all Web Workers
      tickAllWorkers();
      // Record frame timing
      _perf.recordFrame(frameStart, _perf.now() - frameStart);
    },
  };
}
