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
  buildDOM, serializeDOM, vdocToTokens, _serializeEl, _walk, _matchSel, _cePending,
  setScrollYGetter,
  setScrollToCallback,
} from './dom.js';
import type { HtmlToken } from './types.js';
import { BrowserPerformance, BrowserPerformanceObserver } from './perf.js';
import { WorkerImpl, SharedWorkerImpl, MessageChannel, BroadcastChannelImpl, tickAllWorkers } from './workers.js';
import { cookieJar } from '../../net/http.js';
import { getCachedStyle, setCachedStyle, bumpStyleGeneration, currentStyleGeneration } from './cache.js';
import { JSAudioElement, JSVideoElement } from './audio-element.js';
import { JITBrowserEngine } from './jit-browser.js';
import type { CSSAnimation, AnimationKeyframe } from './advanced-css.js';
import { sampleAnimation } from './advanced-css.js';
import { buildWSFrame, parseWSFrame } from '../../net/http.js';
import { cspAllows, logCSPViolation, type CSPPolicy } from './csp.js';
import { CanvasRenderingContext2D as Canvas2DImpl } from './canvas2d.js';

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
  /** Re-parse and re-layout the page with pre-tokenised body (item 1.2). */
  rerender(tokens: HtmlToken[]): void;
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
  fireFocus(id: string): boolean;
  fireBlur(id: string): boolean;
  fireMouse(id: string, eventType: string): boolean;
  /** [Item 950] Fire resize event and trigger media query listeners whose match state changed. */
  fireResize(width: number, height: number): boolean;
  /** Called when the page is unloaded — fires beforeunload */
  dispose(): void;
  /** Synchronously tick any pending timers (called on each render frame) */
  tick(nowMs: number): void;
  /**
   * Write layout geometry back to VElement._layoutRect so that
   * getBoundingClientRect / offsetWidth / offsetHeight etc. return real values.
   * Called by BrowserApp after each layout pass.
   */
  updateLayoutRects(rects: Map<string, { x: number; y: number; w: number; h: number }>): void;
  /** Get canvas element framebuffers for compositing into the browser viewport (item 3.3). */
  getCanvasBuffers(): Array<{ elId: string; width: number; height: number; rgba: Uint8Array }>;
  /** Fire a general window/document event (e.g. 'scroll') from BrowserApp. */
  fireEvent(type: string, detail?: number): void;
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
// Per-tab blob stores are created inside createPageJS(); this module-level
// instance is the "active" store forwarded by getBlobURLContent().
var _blobStore = new Map<string, { content: string; type: string }>();

/**
 * Look up the content of a blob: URL created via URL.createObjectURL().
 * Returns null if the URL is not found or has been revoked.
 * Delegates to the active page's blob store.
 */
export function getBlobURLContent(url: string): { content: string; type: string } | null {
  return _blobStore.get(url) ?? null;
}

// ── Main factory ──────────────────────────────────────────────────────────────

export function createPageJS(
  fullHTML:  string,
  scripts:   ScriptRecord[],
  cb:        PageCallbacks,
  cspPolicy: CSPPolicy | null = null,
): PageJS | null {

  // Skip pages with no JS
  if (scripts.length === 0) return null;

  // ── Per-tab storage isolation ─────────────────────────────────────────────
  // Each createPageJS() call gets its own localStorage, sessionStorage, and
  // blob store.  This prevents cross-tab data leakage.  The module-level
  // _localStorage / _sessionStorage / _blobStore refs are updated to point
  // to the current tab's instances so getBlobURLContent() still works.

  // Create per-tab storage instances
  _localStorage  = new VStorage();
  _sessionStorage = new VStorage();
  _blobStore = new Map<string, { content: string; type: string }>();

  // Wire scroll getter so getBoundingClientRect() returns viewport-relative coords
  setScrollYGetter(() => cb.getScrollY());
  setScrollToCallback((x, y) => cb.scrollTo(x, y));
  try {
    var _originURL  = new URL(cb.baseURL);
    var _originKey  = (_originURL.protocol.replace(':', '') + '_' +
                       _originURL.hostname + '_' +
                       (_originURL.port || (_originURL.protocol === 'https:' ? '443' : '80')))
                      .replace(/[^a-zA-Z0-9_.-]/g, '_');
    var _lsPath = '/user/localStorage/' + _originKey + '.json';
    _localStorage._path = _lsPath;
    _localStorage._load();
  } catch (_) {
    // Non-URL base (e.g. file:///...) — in-memory only
    _localStorage._path = '';
  }
  // sessionStorage is always fresh per tab (session-scoped)
  _sessionStorage._path = '';

  // Build virtual DOM from the full page HTML
  var doc = buildDOM(fullHTML);

  // Patch: ensure <body on*="..."> attributes are reflected to doc.body._attrs (item 571)
  // buildDOM redistributes body.childNodes but may not copy body element attributes.
  {
    var _bodyTagMatch = fullHTML.match(/<body([^>]*)>/i);
    if (_bodyTagMatch && _bodyTagMatch[1] && doc.body) {
      var _bodyTagAttrStr = _bodyTagMatch[1];
      var _bre = /\s+(on[\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
      var _brm: RegExpExecArray | null;
      while ((_brm = _bre.exec(_bodyTagAttrStr)) !== null) {
        var _braName = _brm[1].toLowerCase();
        var _braVal  = _brm[2] ?? _brm[3] ?? _brm[4] ?? '';
        (doc.body as any)._attrs.set(_braName, _braVal);
      }
    }
  }

  // document.readyState transitions (item 531): 'loading' → 'interactive' → 'complete'
  (doc as any)._readyState = 'loading';
  // document.compatMode (item 864) — always standards mode
  (doc as any).compatMode = 'CSS1Compat';
  // document.documentMode (item 867) — IE compat shim: return 11 (IE11 compat)
  (doc as any).documentMode = 11;
  // document.scrollingElement — read-to-cb.scrollTo hook so JS setting
  // document.documentElement.scrollTop / body.scrollTop scrolls the browser viewport
  var _scrollElHook = {
    get scrollTop(): number { return cb.getScrollY(); },
    set scrollTop(v: number) { cb.scrollTo(0, v); },
    get scrollLeft(): number { return 0; },
    set scrollLeft(_v: number) {},
  };
  (doc as any).scrollingElement = _scrollElHook;
  // Also override documentElement.scrollTop to proxy through cb
  if (doc.documentElement) {
    Object.defineProperty(doc.documentElement, 'scrollTop', {
      get() { return cb.getScrollY(); },
      set(v: number) { cb.scrollTo(0, v); },
      configurable: true,
    });
  }
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
  // Debug flag: when true, logs every script execution path and callback invocation.
  // Toggle at runtime: window.__jsDebug = false  (or true to re-enable)
  var _jsDebug = true;

  // ── Service Worker runtime state (Phase 6.7) ──────────────────────────────────
  var _swActiveScope: any   = null;  // active ServiceWorkerGlobalScope_ instance
  var _swRegistration: any  = null;  // current ServiceWorkerRegistration-like object
  var _swContainer: any     = null;  // ServiceWorkerContainer_ (set after class def)

  function setTimeout_(fn: () => void, delay: number): number {
    var id = timerSeq++;
    var fireAt = Date.now() - startTime + Math.max(0, delay);
    timers.push({ id, fn, fireAt, interval: false, delay });
    return id;
  }
  function setInterval_(fn: () => void, delay: number): number {
    var id = timerSeq++;
    var fireAt = Date.now() - startTime + Math.max(1, delay);
    timers.push({ id, fn, fireAt, interval: true, delay: Math.max(1, delay) });
    return id;
  }
  function clearTimeout_(id: number): void { timers = timers.filter(t => t.id !== id); }
  function clearInterval_(id: number): void { clearTimeout_(id); }

  // After a CPU fault recovery (longjmp) the QuickJS heap is in an
  // inconsistent state.  Any further JS execution on this heap risks a
  // fatal second fault (with _js_fault_active==0 → system halt).
  // When set, ALL page-script execution is stopped: no more callbacks,
  // timers, RAF, microtasks, or new script evals for this page.  The page
  // is effectively "Aw, Snap!"'d — only a navigation away clears the flag.
  var _pageFaulted = false;

  // ── Child-runtime page script isolation ──────────────────────────────────
  // When the coordinator runtime faults on a page script (evalGuarded →
  // sentinel -9999), we spin up an isolated child JSRuntime via
  // kernel.procCreate().  Remaining scripts execute in the child, which has
  // its own heap — any crash there is contained and the OS continues.
  //
  // Architecture:
  //   Coordinator (main JSRuntime) ─── OS kernel, browser engine, DOM, layout
  //   Child (JSRuntime via procCreate) ─── page scripts only, minimal DOM stubs
  //   IPC: kernel.procEval / procTick / procSend / procRecv (string messages)
  //
  // The child is bootstrapped with DOM stubs (document, window, navigator,
  // console, setTimeout, etc.) so page scripts can run without crashing.
  // DOM mutations in the child are relayed back via postMessage.
  var _pageChildId: number = -1;              // child proc slot (-1 = not created)
  var _useChildRuntime = false;               // activate after coordinator fault

  /** Bootstrap code evaluated in the child runtime to set up DOM stubs. */
  var _childBootstrap = [
    // ── window / self ────────────────────────────────────────────────────
    'var window = globalThis;',
    'var self = globalThis;',
    'var top = globalThis;',
    'var parent = globalThis;',
    'var frames = globalThis;',

    // ── navigator ────────────────────────────────────────────────────────
    'var navigator = {',
    '  userAgent: "Mozilla/5.0 (JSOS; x86) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",',
    '  language: "en-US", languages: ["en-US","en"],',
    '  platform: "Linux x86_64", vendor: "Google Inc.",',
    '  appName: "Netscape", appVersion: "5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",',
    '  product: "Gecko", productSub: "20030107",',
    '  cookieEnabled: true, onLine: true, webdriver: false, pdfViewerEnabled: true,',
    '  hardwareConcurrency: 1, maxTouchPoints: 0,',
    '  geolocation: { getCurrentPosition: function(_s,e) { if(e) e({code:1,message:"Not supported"}); }, watchPosition: function(_s,e) { if(e) e({code:1,message:"Not supported"}); return 0; }, clearWatch: function(){} },',
    '  mediaDevices: { getUserMedia: function(){ return Promise.reject(new Error("NotSupportedError")); }, enumerateDevices: function() { return Promise.resolve([]); }, getSupportedConstraints: function(){ return {}; }, addEventListener: function(){}, removeEventListener: function(){} },',
    '  serviceWorker: (function() {',
    '    function _mockReg(url, scope) {',
    '      var _sw = { scriptURL: url||"", state: "activated", addEventListener: function(){}, removeEventListener: function(){}, postMessage: function(){} };',
    '      return { installing: null, waiting: null, active: _sw, scope: scope||"/", updateViaCache: "imports",',
    '        update: function(){ return Promise.resolve(undefined); },',
    '        unregister: function(){ return Promise.resolve(true); },',
    '        addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return false;} };',
    '    }',
    '    var _r = _mockReg("", "/");',
    '    return {',
    '      register: function(url, opts) { return Promise.resolve(_mockReg(url, opts && opts.scope)); },',
    '      ready: Promise.resolve(_r),',
    '      controller: null,',
    '      getRegistrations: function() { return Promise.resolve([_r]); },',
    '      getRegistration: function() { return Promise.resolve(_r); },',
    '      addEventListener: function(){}, removeEventListener: function(){},',
    '      startMessages: function(){}',
    '    };',
    '  })(),',
    '  credentials: { get: function() { return Promise.resolve(null); }, create: function() { return Promise.resolve(null); } },',
    '  clipboard: { writeText: function() { return Promise.resolve(); }, readText: function() { return Promise.resolve(""); }, read: function() { return Promise.resolve([]); }, write: function() { return Promise.resolve(); } },',
    '  permissions: { query: function(d) { var n=d&&d.name?d.name.toLowerCase():""; var s=(n==="clipboard-read"||n==="clipboard-write"||n==="notifications")?"granted":"prompt"; return Promise.resolve({state:s,addEventListener:function(){},removeEventListener:function(){}}); } },',
    '  connection: { effectiveType: "4g", downlink: 10, rtt: 50, saveData: false, addEventListener: function(){}, removeEventListener: function(){} },',
    '  storage: { estimate: function() { return Promise.resolve({quota:52428800,usage:0}); }, persist: function() { return Promise.resolve(false); }, persisted: function() { return Promise.resolve(false); } },',
    '  locks: { request: function(_n,f,g) { var cb_=typeof f==="function"?f:g; return typeof cb_==="function"?Promise.resolve().then(function(){return cb_({name:_n,mode:"exclusive"});}):Promise.resolve(null); }, query: function(){ return Promise.resolve({held:[],pending:[]}); } },',
    '  sendBeacon: function() { return true; },',
    '  vibrate: function() { return false; },',
    '  share: function() { return Promise.reject(new Error("Not supported")); },',
    '  canShare: function() { return false; },',
    '  userAgentData: {',
    '    brands: [{brand:"Chromium",version:"120"},{brand:"Google Chrome",version:"120"},{brand:"Not_A Brand",version:"24"}],',
    '    mobile: false, platform: "Linux",',
    '    getHighEntropyValues: function(hints) {',
    '      var vals={architecture:"x86",bitness:"32",model:"",platform:"Linux",platformVersion:"5.15.0",uaFullVersion:"120.0.6099.71",fullVersionList:[{brand:"Chromium",version:"120.0.6099.71"},{brand:"Google Chrome",version:"120.0.6099.71"},{brand:"Not_A Brand",version:"24.0.0.0"}],wow64:false};',
    '      var r={}; for(var i=0;i<hints.length;i++) { if(hints[i] in vals) r[hints[i]]=vals[hints[i]]; } return Promise.resolve(r);',
    '    },',
    '    toJSON: function() { return {brands:this.brands,mobile:this.mobile,platform:this.platform}; }',
    '  },',
    '};',

    // ── location (read-only snapshot) ────────────────────────────────────
    'var location = {',
    '  href: "", protocol: "https:", host: "", hostname: "",',
    '  port: "", pathname: "/", search: "", hash: "", origin: "",',
    '  assign: function(){}, replace: function(){}, reload: function(){},',
    '  toString: function() { return this.href; }',
    '};',

    // ── history ──────────────────────────────────────────────────────────
    'var history = {',
    '  length: 1, state: null, scrollRestoration: "auto",',
    '  pushState: function(){}, replaceState: function(){},',
    '  back: function(){}, forward: function(){}, go: function(){}',
    '};',

    // ── screen ───────────────────────────────────────────────────────────
    'var screen = { width: 1024, height: 768, availWidth: 1024, availHeight: 768,',
    '  colorDepth: 32, pixelDepth: 32, orientation: { type: "landscape-primary", angle: 0 } };',

    // ── performance ──────────────────────────────────────────────────────
    'var performance = {',
    '  now: function() { return kernel.getUptime(); },',
    '  timing: (function() {',
    '    var t = kernel.getUptime();',
    '    return { navigationStart: t, unloadEventStart: 0, unloadEventEnd: 0,',
    '      redirectStart: 0, redirectEnd: 0, fetchStart: t,',
    '      domainLookupStart: t, domainLookupEnd: t,',
    '      connectStart: t, connectEnd: t, secureConnectionStart: t,',
    '      requestStart: t, responseStart: t + 10, responseEnd: t + 20,',
    '      domLoading: t + 20, domInteractive: t + 50,',
    '      domContentLoadedEventStart: t + 50, domContentLoadedEventEnd: t + 55,',
    '      domComplete: t + 60, loadEventStart: t + 60, loadEventEnd: t + 65,',
    '      toJSON: function() { return this; }',
    '    };',
    '  })(),',
    '  navigation: { type: 0, redirectCount: 0 },',
    '  getEntriesByType: function() { return []; },',
    '  getEntriesByName: function() { return []; },',
    '  mark: function(){}, measure: function(){}, clearMarks: function(){},',
    '  clearMeasures: function(){}, clearResourceTimings: function(){}',
    '};',

    // ── crypto ───────────────────────────────────────────────────────────
    // SHA-256 + HMAC-SHA256 helpers (used by crypto.subtle below)
    'var _K256=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,',
    '  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,',
    '  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,',
    '  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,',
    '  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,',
    '  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,',
    '  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,',
    '  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];',
    'function _toU8c(d){if(d instanceof Uint8Array)return d;if(d instanceof ArrayBuffer)return new Uint8Array(d);if(d&&ArrayBuffer.isView&&ArrayBuffer.isView(d))return new Uint8Array(d.buffer,d.byteOffset,d.byteLength);return new Uint8Array(d);}',
    'function _sha256c(data){',
    '  var H0=0x6a09e667,H1=0xbb67ae85,H2=0x3c6ef372,H3=0xa54ff53a;',
    '  var H4=0x510e527f,H5=0x9b05688c,H6=0x1f83d9ab,H7=0x5be0cd19;',
    '  var ml=data.length,padLen=((56-(ml+1)%64)+64)%64;',
    '  var buf=new Uint8Array(ml+1+padLen+8);buf.set(data);buf[ml]=0x80;',
    '  var bl=ml*8;buf[buf.length-4]=(bl>>>24)&0xff;buf[buf.length-3]=(bl>>>16)&0xff;buf[buf.length-2]=(bl>>>8)&0xff;buf[buf.length-1]=bl&0xff;',
    '  var W=new Array(64);',
    '  for(var off=0;off<buf.length;off+=64){',
    '    for(var tt=0;tt<16;tt++) W[tt]=(buf[off+tt*4]<<24)|(buf[off+tt*4+1]<<16)|(buf[off+tt*4+2]<<8)|buf[off+tt*4+3];',
    '    for(var tt=16;tt<64;tt++){var w15=W[tt-15],w2=W[tt-2];',
    '      W[tt]=(W[tt-16]+(((w15>>>7)|(w15<<25))^((w15>>>18)|(w15<<14))^(w15>>>3))+W[tt-7]+(((w2>>>17)|(w2<<15))^((w2>>>19)|(w2<<13))^(w2>>>10)))|0;}',
    '    var a=H0,b=H1,c=H2,d=H3,e=H4,f=H5,g=H6,h=H7;',
    '    for(var tt=0;tt<64;tt++){',
    '      var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));',
    '      var t1=(h+S1+((e&f)^(~e&g))+_K256[tt]+W[tt])|0;',
    '      var t2=((((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10)))+((a&b)^(a&c)^(b&c)))|0;',
    '      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;}',
    '    H0=(H0+a)|0;H1=(H1+b)|0;H2=(H2+c)|0;H3=(H3+d)|0;',
    '    H4=(H4+e)|0;H5=(H5+f)|0;H6=(H6+g)|0;H7=(H7+h)|0;}',
    '  var res=new ArrayBuffer(32),dv=new DataView(res);',
    '  dv.setUint32(0,H0>>>0);dv.setUint32(4,H1>>>0);dv.setUint32(8,H2>>>0);dv.setUint32(12,H3>>>0);',
    '  dv.setUint32(16,H4>>>0);dv.setUint32(20,H5>>>0);dv.setUint32(24,H6>>>0);dv.setUint32(28,H7>>>0);',
    '  return res;}',
    'function _hmac256c(key,data){',
    '  var bs=64,kp=key.length>bs?new Uint8Array(_sha256c(key)):key;',
    '  var k=new Uint8Array(bs);k.set(kp);',
    '  var ip=new Uint8Array(bs),op=new Uint8Array(bs);',
    '  for(var ii=0;ii<bs;ii++){ip[ii]=k[ii]^0x36;op[ii]=k[ii]^0x5c;}',
    '  var inner=new Uint8Array(bs+data.length);inner.set(ip);inner.set(data,bs);',
    '  var innerH=new Uint8Array(_sha256c(inner));',
    '  var outerB=new Uint8Array(bs+32);outerB.set(op);outerB.set(innerH,bs);',
    '  return _sha256c(outerB);}',

    'var crypto = {',
    '  getRandomValues: function(a) { for(var i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256); return a; },',
    '  randomUUID: function() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {',
    '    var r=Math.random()*16|0; return (c==="x"?r:r&3|8).toString(16); }); },',
    '  subtle: {',
    '    digest: function(alg, data) { var a=String(alg&&alg.name||alg).toUpperCase().replace(/-/g,""); if(a.indexOf("256")>=0)return Promise.resolve(_sha256c(_toU8c(data))); var len=a.indexOf("384")>=0?48:64; return Promise.resolve(new ArrayBuffer(len)); },',
    '    encrypt: function() { return Promise.resolve(new ArrayBuffer(0)); },',
    '    decrypt: function() { return Promise.resolve(new ArrayBuffer(0)); },',
    '    sign: function(alg,key,data) { var a=String(alg&&alg.name||alg).toUpperCase(); if(a.indexOf("HMAC")>=0) return Promise.resolve(_hmac256c(_toU8c(key._raw||key),_toU8c(data))); return Promise.resolve(new ArrayBuffer(32)); },',
    '    verify: function(alg,key,sig,data) { var a=String(alg&&alg.name||alg).toUpperCase(); if(a.indexOf("HMAC")>=0){var ex=new Uint8Array(_hmac256c(_toU8c(key._raw||key),_toU8c(data))),ac=_toU8c(sig);if(ex.length!==ac.length)return Promise.resolve(false);var ok=true;for(var _i=0;_i<ex.length;_i++)ok=ok&&(ex[_i]===ac[_i]);return Promise.resolve(ok);} return Promise.resolve(false); },',
    '    generateKey: function(alg, extractable, usages) { var key={type:"secret",extractable:extractable,algorithm:alg,usages:usages||[]}; return Promise.resolve(alg&&alg.name&&alg.name.indexOf("EC")>=0?{publicKey:Object.assign({},key,{type:"public"}),privateKey:Object.assign({},key,{type:"private"})}:key); },',
    '    importKey: function(fmt, keyData, alg, extractable, usages) { var raw=fmt==="raw"?_toU8c(keyData):keyData; return Promise.resolve({type:"secret",extractable:extractable,algorithm:alg,usages:usages||[],_raw:raw}); },',
    '    exportKey: function(fmt, key) { return fmt==="jwk"?Promise.resolve({kty:"oct",k:"",alg:"",key_ops:[]}):Promise.resolve(new ArrayBuffer(0)); },',
    '    deriveBits: function(alg, key, length) { return Promise.resolve(new ArrayBuffer(Math.ceil(length/8))); },',
    '    deriveKey: function(alg, key, derivedAlg, extractable, usages) { return Promise.resolve({type:"secret",extractable:extractable,algorithm:derivedAlg,usages:usages||[]}); },',
    '    wrapKey: function() { return Promise.resolve(new ArrayBuffer(0)); },',
    '    unwrapKey: function() { return Promise.resolve({type:"secret"}); },',
    '  }',,
    '};',

    // ── DOM stubs ────────────────────────────────────────────────────────
    'var _noop = function(){};',
    'var _noopArr = function(){ return []; };',
    'var _noopNull = function(){ return null; };',
    'var _noopPromise = function(){ return Promise.resolve(); };',
    'var _noopFalse = function(){ return false; };',
    'var _noopTrue = function(){ return true; };',

    // Minimal Element stub
    'function _StubElement(tag) {',
    '  this.tagName = (tag||"DIV").toUpperCase();',
    '  this.nodeName = this.tagName;',
    '  this.nodeType = 1;',
    '  this.childNodes = [];',
    '  this.children = [];',
    '  var _clsArr = [];',
    '  var _cls = {',
    '    _arr: _clsArr,',
    '    add: function() { for(var i=0;i<arguments.length;i++) { var t=String(arguments[i]); if(_clsArr.indexOf(t)<0) _clsArr.push(t); } },',
    '    remove: function() { for(var i=0;i<arguments.length;i++) { var t=String(arguments[i]); var idx=_clsArr.indexOf(t); if(idx>=0) _clsArr.splice(idx,1); } },',
    '    toggle: function(t,f) { var has=_clsArr.indexOf(t)>=0; if(f===undefined?has:f) { var idx=_clsArr.indexOf(t); if(idx>=0)_clsArr.splice(idx,1); return false; } else { if(_clsArr.indexOf(t)<0)_clsArr.push(t); return true; } },',
    '    contains: function(t) { return _clsArr.indexOf(String(t))>=0; },',
    '    replace: function(a,b) { var i=_clsArr.indexOf(a); if(i>=0){_clsArr[i]=b;return true;} return false; },',
    '    item: function(i) { return _clsArr[i]||null; },',
    '    forEach: function(cb) { _clsArr.forEach(cb); },',
    '    values: function() { return _clsArr.slice(); },',
    '    keys: function() { var r=[]; for(var i=0;i<_clsArr.length;i++) r.push(i); return r; },',
    '    entries: function() { return _clsArr.map(function(v,i){ return [i,v]; }); },',
    '    supports: function() { return true; },',
    '    get length() { return _clsArr.length; },',
    '    toString: function() { return _clsArr.join(" "); }',
    '  };',
    '  this.classList = _cls;',
    '  var _style = {};',
    '  _style.setProperty = function(k,v){ _style[k.trim()]=v; };',
    '  _style.getPropertyValue = function(k){ return _style[k.trim()]||""; };',
    '  _style.getPropertyPriority = function(){ return ""; };',
    '  _style.removeProperty = function(k){ var v=_style[k.trim()]||""; delete _style[k.trim()]; return v; };',
    '  Object.defineProperty(_style,"cssText",{get:function(){var r=[];for(var k in _style){if(typeof _style[k]==="string")r.push(k+":"+_style[k]);}return r.join(";");},set:function(t){for(var k in _style){if(typeof _style[k]==="string")delete _style[k];}String(t).split(";").forEach(function(p){var i=p.indexOf(":");if(i>0){var k2=p.slice(0,i).trim(),v=p.slice(i+1).trim();if(k2)_style[k2]=v;}});},enumerable:false,configurable:true});',
    '  _style.item = function(i){ var ks=Object.keys(_style).filter(function(k){return typeof _style[k]==="string";}); return ks[i]||""; };',
    '  this.style = _style;',
    '  this.dataset = {};',
    '  this._attrs = {};',
    '  this.textContent = "";',
    '  this.innerHTML = "";',
    '  this.innerText = "";',
    '  this.id = "";',
    '  this.parentNode = null;',
    '  this.parentElement = null;',
    '  this.nextSibling = null;',
    '  this.previousSibling = null;',
    '  this.firstChild = null;',
    '  this.lastChild = null;',
    // Form/input specific properties
    '  this.value = "";',
    '  this.defaultValue = "";',
    '  this.type = "text";',
    '  this.name = "";',
    '  this.placeholder = "";',
    '  this.disabled = false;',
    '  this.checked = false;',
    '  this.defaultChecked = false;',
    '  this.selected = false;',
    '  this.multiple = false;',
    '  this.required = false;',
    '  this.readOnly = false;',
    '  this.maxLength = -1;',
    '  this.size = 0;',
    '  this.src = "";',
    '  this.href = "";',
    '  this.alt = "";',
    '  this.rel = "";',
    '  this.target = "";',
    '  this.action = "";',
    '  this.method = "get";',
    '  this.enctype = "application/x-www-form-urlencoded";',
    '  this.accept = "";',
    '  this.action = "";',
    '  this.autocomplete = "on";',
    '  this.noValidate = false;',
    '  this.form = null;',
    '  this.validity = {valid:true,valueMissing:false,typeMismatch:false,patternMismatch:false,tooLong:false,tooShort:false,rangeUnderflow:false,rangeOverflow:false,stepMismatch:false,badInput:false,customError:false};',
    '  this.validationMessage = "";',
    // Template element content
    '  if(this.tagName==="TEMPLATE") this.content = document.createDocumentFragment();',
    '}',
    // outerHTML getter/setter
    'Object.defineProperty(_StubElement.prototype,"outerHTML",{',
    '  get:function(){ return "<"+this.tagName.toLowerCase()+">"+this.innerHTML+"</"+this.tagName.toLowerCase()+">"; },',
    '  set:function(h){ if(this.parentNode){ var tmp=document.createElement("div"); tmp.innerHTML=h; var ns=tmp.childNodes.slice(); for(var i=0;i<ns.length;i++) this.parentNode.insertBefore(ns[i],this); this.parentNode.removeChild(this); } },',
    '  configurable:true',
    '});',
    // className/classList sync
    'Object.defineProperty(_StubElement.prototype,"className",{',
    '  get:function(){ return this.classList.toString(); },',
    '  set:function(v){ this.classList._arr.length=0; String(v).split(/\\s+/).forEach(function(t){ if(t) this.classList._arr.push(t); }.bind(this)); },',
    '  configurable:true',
    '});',
    '_StubElement.prototype.getAttribute = function(n){ return this._attrs[n]||null; };',
    '_StubElement.prototype.setAttribute = function(n,v){ this._attrs[n]=String(v); _domDirty=true; };',
    '_StubElement.prototype.removeAttribute = function(n){ delete this._attrs[n]; _domDirty=true; };',
    '_StubElement.prototype.hasAttribute = function(n){ return n in this._attrs; };',
    '_StubElement.prototype.addEventListener = _noop;',
    '_StubElement.prototype.removeEventListener = _noop;',
    '_StubElement.prototype.dispatchEvent = _noopTrue;',
    // DOM change flag — checked after each script+tick to know if body HTML needs syncing
    'var _domDirty = false;',
    'function _linkAll(el){_domDirty=true;var ch=el.childNodes;el.firstChild=ch[0]||null;el.lastChild=ch[ch.length-1]||null;var _ech=[];for(var _i=0;_i<ch.length;_i++){ch[_i].previousSibling=_i>0?ch[_i-1]:null;ch[_i].nextSibling=_i<ch.length-1?ch[_i+1]:null;if(ch[_i].nodeType===1)_ech.push(ch[_i]);}for(var _j=0;_j<_ech.length;_j++){_ech[_j].previousElementSibling=_j>0?_ech[_j-1]:null;_ech[_j].nextElementSibling=_j<_ech.length-1?_ech[_j+1]:null;}el.firstElementChild=_ech[0]||null;el.lastElementChild=_ech[_ech.length-1]||null;el.childElementCount=_ech.length;el.children=_ech;}',
    // HTML serializer for innerHTML getter
    'function _serHTML(n){var t=n.nodeType;if(t===3)return (n.textContent||n.nodeValue||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");if(t===8)return "<!--"+(n.textContent||n.nodeValue||"")+"-->";if(t!==1)return "";var tag=n.tagName.toLowerCase();var a="";var _a=n._attrs||{};for(var k in _a){if(k!=="class"&&k!=="style")a+=" "+k+"=\""+String(_a[k]).replace(/&/g,"&amp;").replace(/"/g,"&quot;")+"\"";}var _cls=n.classList&&n.classList._arr&&n.classList._arr.length?n.classList._arr.join(" "):"";if(_cls)a+=" class=\""+_cls+"\"";var _st=n.style;if(_st){var _sc="";for(var _sk in _st){if(typeof _st[_sk]==="string"&&_sk!=="cssText")_sc+=_sk+":"+_st[_sk]+";";}if(_sc)a+=" style=\""+_sc.replace(/"/g,"&quot;")+"\"";} var VOID=/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;if(VOID.test(tag))return "<"+tag+a+">";var inner="";var ch=n.childNodes||[];for(var i=0;i<ch.length;i++)inner+=_serHTML(ch[i]);return "<"+tag+a+">"+inner+"</"+tag+">";}',
    // HTML parser for innerHTML setter
    'function _parseHTML(html,parent){while(parent.childNodes.length)parent.removeChild(parent.childNodes[0]);var i=0,len=html.length;var VOID=/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;var stack=[parent];while(i<len){if(html[i]==="<"){if(html[i+1]==="!"&&html[i+2]==="-"&&html[i+3]==="-"){var ce=html.indexOf("-->",i+4);if(ce<0)ce=len-3;stack[stack.length-1].appendChild({nodeType:8,textContent:html.slice(i+4,ce),nodeValue:html.slice(i+4,ce),parentNode:null,nextSibling:null,previousSibling:null});i=ce+3;continue;}if(html[i+1]==="/"){var ce2=html.indexOf(">",i+2);if(ce2<0){i++;continue;}var ct=html.slice(i+2,ce2).trim().toLowerCase();for(var j=stack.length-1;j>0;j--){if(stack[j].tagName&&stack[j].tagName.toLowerCase()===ct){stack.length=j;break;}}i=ce2+1;continue;}var ce3=html.indexOf(">",i+1);if(ce3<0){i++;continue;}var ts=html.slice(i+1,ce3);var sc=ts[ts.length-1]==="/";if(sc)ts=ts.slice(0,-1);var mo=ts.match(/^([a-zA-Z][a-zA-Z0-9:-]*)(.*)/s);if(!mo){i=ce3+1;continue;}var tn=mo[1],as=mo[2]||"";var el=document.createElement(tn);var arx=/([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|(\\S+)))?/g,am;while((am=arx.exec(as))!==null){el.setAttribute(am[1],am[2]!==undefined?am[2]:am[3]!==undefined?am[3]:am[4]!==undefined?am[4]:"");}stack[stack.length-1].appendChild(el);if(!sc&&!VOID.test(tn))stack.push(el);i=ce3+1;}else{var te=html.indexOf("<",i);if(te<0)te=len;var tx=html.slice(i,te);if(tx){var tn2=document.createTextNode(tx.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&nbsp;/g,"\\u00a0").replace(/&quot;/g,"\""));stack[stack.length-1].appendChild(tn2);}i=te;}}}',
    // querySelector/querySelectorAll helpers
    'function _stubMatch(el,tok){if(!el||el.nodeType!==1)return false;tok=tok.trim();var tag="",id="",cls=[],attrs=[];tok=tok.replace(/#([-\\w]+)/g,function(_,v){id=v;return "";}).replace(/\\.([-\\w]+)/g,function(_,v){cls.push(v);return "";}).replace(/\\[([^=\\]~|^$*]+)([~|^$*]?=)?["\']?([^"\'\\]]*)["\']?\\]/g,function(_,an,op,av){attrs.push([an,op||"",av]);return "";});tag=tok.trim();if(tag&&el.tagName.toUpperCase()!==tag.toUpperCase())return false;if(id&&el.id!==id&&!(el._attrs&&el._attrs.id===id))return false;for(var _ci=0;_ci<cls.length;_ci++){if(!el.classList||!el.classList.contains(cls[_ci]))return false;}for(var _ai=0;_ai<attrs.length;_ai++){var _at=attrs[_ai],_av=el.getAttribute?el.getAttribute(_at[0]):null;if(_at[1]==="")return _av!==null;if(_at[1]==="=")return _av===_at[2];if(_at[1]==="~=")return _av&&_av.split(/\\s+/).indexOf(_at[2])>=0;if(_at[1]==="|=")return _av&&(_av===_at[2]||_av.indexOf(_at[2]+"-")===0);if(_at[1]==="^=")return _av&&_av.indexOf(_at[2])===0;if(_at[1]==="$=")return _av&&_av.slice(-_at[2].length)===_at[2];if(_at[1]==="*=")return _av&&_av.indexOf(_at[2])>=0;}return true;}',
    'function _stubQSA(root,sel,first){var res=[];var parts=sel.trim().split(/\\s*,\\s*/);for(var _pi=0;_pi<parts.length;_pi++){var segs=parts[_pi].trim().split(/\\s+/);var last=segs[segs.length-1];var stk=[root];while(stk.length){var _nd=stk.pop();var _chn=_nd.childNodes||[];for(var _ni=_chn.length-1;_ni>=0;_ni--){if(_chn[_ni].nodeType===1)stk.push(_chn[_ni]);}if(_nd!==root&&(last==="*"||_stubMatch(_nd,last))){var _ok=true;if(segs.length>1){var _anc=_nd.parentNode;for(var _si=segs.length-2;_si>=0;_si--){var _fd=false;var _a2=_anc;while(_a2&&_a2!==root){if(_stubMatch(_a2,segs[_si])){_fd=true;_anc=_a2.parentNode;break;}_a2=_a2.parentNode;}if(!_fd){_ok=false;break;}}}if(_ok){if(first)return [_nd];res.push(_nd);}}}return first&&res.length?[res[0]]:res;}',
    '_StubElement.prototype.appendChild = function(c){ if(c.parentNode&&c.parentNode!==this) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode=this; c.parentElement=this; _linkAll(this); return c; };',
    '_StubElement.prototype.removeChild = function(c){ var i=this.childNodes.indexOf(c); if(i>=0) this.childNodes.splice(i,1); c.parentNode=null; c.parentElement=null; c.nextSibling=null; c.previousSibling=null; _linkAll(this); return c; };',
    '_StubElement.prototype.insertBefore = function(n,r){ if(!r) return this.appendChild(n); if(n.parentNode&&n.parentNode!==this) n.parentNode.removeChild(n); var i=this.childNodes.indexOf(r); if(i>=0) this.childNodes.splice(i,0,n); else this.childNodes.push(n); n.parentNode=this; n.parentElement=this; _linkAll(this); return n; };',
    '_StubElement.prototype.replaceChild = function(n,o){ if(n.parentNode&&n.parentNode!==this) n.parentNode.removeChild(n); var i=this.childNodes.indexOf(o); if(i>=0){ this.childNodes[i]=n; n.parentNode=this; n.parentElement=this; o.parentNode=null; o.parentElement=null; _linkAll(this); } return o; };',
    // innerHTML getter/setter
    'Object.defineProperty(_StubElement.prototype,"innerHTML",{get:function(){var ch=this.childNodes||[];var s="";for(var i=0;i<ch.length;i++)s+=_serHTML(ch[i]);return s;},set:function(h){_parseHTML(String(h),this);},configurable:true,enumerable:false});',
    // textContent getter/setter
    'Object.defineProperty(_StubElement.prototype,"textContent",{get:function(){function _gt(n){if(n.nodeType===3||n.nodeType===4)return n.textContent||n.nodeValue||"";if(n.nodeType!==1)return "";var t="",ch=n.childNodes||[];for(var i=0;i<ch.length;i++)t+=_gt(ch[i]);return t;}return _gt(this);},set:function(t){while(this.childNodes.length)this.removeChild(this.childNodes[0]);if(t!=null&&String(t)){this.appendChild({nodeType:3,textContent:String(t),nodeValue:String(t),parentNode:null,nextSibling:null,previousSibling:null});}},configurable:true,enumerable:false});',
    '_StubElement.prototype.cloneNode = function(deep){ var c=new _StubElement(this.tagName); var a=this._attrs||{}; for(var k in a) c.setAttribute(k,a[k]); if(this.classList&&this.classList._arr) this.classList._arr.forEach(function(v){c.classList.add(v);}); c.id=this.id; c.className=this.className; var st=this.style; if(st){for(var sk in st){if(typeof st[sk]==="string"&&sk!=="cssText")c.style[sk]=st[sk];}} if(deep){var ch=this.childNodes||[];for(var i=0;i<ch.length;i++)c.appendChild(ch[i].nodeType===1?ch[i].cloneNode(true):{nodeType:ch[i].nodeType,textContent:ch[i].textContent||"",nodeValue:ch[i].nodeValue||"",parentNode:null,nextSibling:null,previousSibling:null});} return c; };',
    '_StubElement.prototype.querySelector = function(sel){ var r=_stubQSA(this,sel,true); return r[0]||null; };',
    '_StubElement.prototype.querySelectorAll = function(sel){ return _stubQSA(this,sel,false); };',
    '_StubElement.prototype.getElementsByClassName = function(cn){ return _stubQSA(this,"."+cn.split(/\\s+/).join("."),false); };',
    '_StubElement.prototype.getElementsByTagName = function(tag){ if(tag==="*")return _stubQSA(this,"*",false);return _stubQSA(this,tag,false); };',
    '_StubElement.prototype.getElementsByTagNameNS = function(_ns,tag){ return this.getElementsByTagName(tag); };',
    '_StubElement.prototype.getBoundingClientRect = function(){ return {x:0,y:0,width:0,height:0,top:0,left:0,right:0,bottom:0,toJSON:function(){return this;}}; };',
    '_StubElement.prototype.getClientRects = function(){ return []; };',
    '_StubElement.prototype.closest = function(sel){ var n=this; while(n&&n.nodeType===1){if(_stubMatch(n,sel.trim()))return n; n=n.parentNode;} return null; };',
    '_StubElement.prototype.matches = function(sel){ return _stubMatch(this,sel.trim()); };',
    '_StubElement.prototype.contains = function(n){ if(n===this)return true; var ch=this.childNodes||[]; for(var i=0;i<ch.length;i++){if(ch[i]===n||(_StubElement.prototype.contains&&ch[i].contains&&ch[i].contains(n)))return true;} return false; };',
    '_StubElement.prototype.focus = _noop;',
    '_StubElement.prototype.blur = _noop;',
    '_StubElement.prototype.click = _noop;',
    '_StubElement.prototype.scrollIntoView = _noop;',
    '_StubElement.prototype.scrollTo = _noop;',
    '_StubElement.prototype.scrollBy = _noop;',
    '_StubElement.prototype.scroll = _noop;',
    '_StubElement.prototype.remove = function(){ if(this.parentNode) this.parentNode.removeChild(this); };',
    '_StubElement.prototype.after = function(){ for(var i=0;i<arguments.length;i++){var n=arguments[i];if(typeof n==="string"){var t=document.createTextNode(n);if(this.parentNode)this.parentNode.insertBefore(t,this.nextSibling);}else if(this.parentNode)this.parentNode.insertBefore(n,this.nextSibling);} };',
    '_StubElement.prototype.before = function(){ for(var i=0;i<arguments.length;i++){var n=arguments[i];if(typeof n==="string"){var t=document.createTextNode(n);if(this.parentNode)this.parentNode.insertBefore(t,this);}else if(this.parentNode)this.parentNode.insertBefore(n,this);} };',
    '_StubElement.prototype.prepend = function(){ for(var i=arguments.length-1;i>=0;i--){var n=arguments[i];if(typeof n==="string"){var t=document.createTextNode(n);this.insertBefore(t,this.firstChild);}else this.insertBefore(n,this.firstChild);} };',
    '_StubElement.prototype.append = function(){ for(var i=0;i<arguments.length;i++){var n=arguments[i];if(typeof n==="string"){this.appendChild(document.createTextNode(n));}else this.appendChild(n);} };',
    '_StubElement.prototype.replaceWith = function(){ var p=this.parentNode; if(!p) return; for(var i=0;i<arguments.length;i++){var n=arguments[i];if(typeof n==="string"){p.insertBefore(document.createTextNode(n),this);}else p.insertBefore(n,this);} p.removeChild(this); };',
    '_StubElement.prototype.replaceChildren = function(){ while(this.firstChild)this.removeChild(this.firstChild); this.append.apply(this,arguments); };',
    '_StubElement.prototype.insertAdjacentHTML = function(pos,html){ var tmp=document.createElement("DIV"); tmp.innerHTML=html; var ns=tmp.childNodes.slice(); pos=pos.toLowerCase(); if(pos==="beforebegin"){ for(var i=0;i<ns.length;i++) if(this.parentNode) this.parentNode.insertBefore(ns[i],this); } else if(pos==="afterbegin"){ for(var i=ns.length-1;i>=0;i--) this.insertBefore(ns[i],this.firstChild); } else if(pos==="beforeend"){ for(var i=0;i<ns.length;i++) this.appendChild(ns[i]); } else if(pos==="afterend"){ for(var i=ns.length-1;i>=0;i--) if(this.parentNode) this.parentNode.insertBefore(ns[i],this.nextSibling); } };',
    '_StubElement.prototype.insertAdjacentText = function(pos,text){ this.insertAdjacentHTML(pos, text.replace(/[<>&"]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;",\'"\':"&quot;"}[c];})); };',
    '_StubElement.prototype.insertAdjacentElement = function(pos,el){ this.insertAdjacentHTML(pos,""); return el; };',
    '_StubElement.prototype.setAttributeNS = function(_ns,n,v){ this.setAttribute(n.replace(/^[^:]+:/,""),v); };',
    '_StubElement.prototype.getAttributeNS = function(_ns,n){ return this.getAttribute(n.replace(/^[^:]+:/,"")); };',
    '_StubElement.prototype.hasAttributeNS = function(_ns,n){ return this.hasAttribute(n.replace(/^[^:]+:/,"")); };',
    '_StubElement.prototype.removeAttributeNS = function(_ns,n){ this.removeAttribute(n.replace(/^[^:]+:/,"")); };',
    '_StubElement.prototype.getAttributeNames = function(){ return Object.keys(this._attrs); };',
    '_StubElement.prototype.getRootNode = function(){ var n=this; while(n.parentNode)n=n.parentNode; return n; };',
    '_StubElement.prototype.isConnected = false;',
    // Dimensions — scrollWidth/Height/clientWidth/Height/offsetWidth/Height
    '_StubElement.prototype.scrollWidth = 0;',
    '_StubElement.prototype.scrollHeight = 0;',
    '_StubElement.prototype.clientWidth = 0;',
    '_StubElement.prototype.clientHeight = 0;',
    '_StubElement.prototype.offsetWidth = 0;',
    '_StubElement.prototype.offsetHeight = 0;',
    '_StubElement.prototype.offsetTop = 0;',
    '_StubElement.prototype.offsetLeft = 0;',
    '_StubElement.prototype.scrollTop = 0;',
    '_StubElement.prototype.scrollLeft = 0;',
    '_StubElement.prototype.clientTop = 0;',
    '_StubElement.prototype.clientLeft = 0;',
    '_StubElement.prototype.tabIndex = -1;',
    '_StubElement.prototype.draggable = false;',
    '_StubElement.prototype.hidden = false;',
    '_StubElement.prototype.dir = "";',
    '_StubElement.prototype.lang = "";',
    '_StubElement.prototype.title = "";',
    '_StubElement.prototype.accessKey = "";',
    '_StubElement.prototype.contentEditable = "false";',
    '_StubElement.prototype.isContentEditable = false;',
    '_StubElement.prototype.spellcheck = false;',
    '_StubElement.prototype.checkValidity = _noopTrue;',
    '_StubElement.prototype.reportValidity = _noopTrue;',
    '_StubElement.prototype.setCustomValidity = _noop;',
    '_StubElement.prototype.animate = function(){ return {play:_noop,pause:_noop,cancel:_noop,finish:_noop,finished:Promise.resolve(),currentTime:0,playState:"idle",effect:null,onfinish:null,oncancel:null,addEventListener:_noop,removeEventListener:_noop}; };',
    '_StubElement.prototype.requestFullscreen = _noopPromise;',
    '_StubElement.prototype.requestPointerLock = _noop;',
    '_StubElement.prototype.attachShadow = function(o){ var sr=new _StubElement("shadow-root"); sr.mode=(o&&o.mode)||"open"; sr.host=this; this.shadowRoot=sr; return sr; };',
    '_StubElement.prototype.shadowRoot = null;',
    '_StubElement.prototype.assignedSlot = null;',
    '_StubElement.prototype.slot = "";',
    '_StubElement.prototype.namespaceURI = "http://www.w3.org/1999/xhtml";',
    '_StubElement.prototype.localName = "";',
    '_StubElement.prototype.prefix = null;',
    '_StubElement.prototype.baseURI = "";',
    '_StubElement.prototype.ownerDocument = null;',
    '_StubElement.prototype.nodeValue = null;',
    '_StubElement.prototype.wholeText = "";',
    '_StubElement.prototype.nextElementSibling = null;',
    '_StubElement.prototype.previousElementSibling = null;',
    '_StubElement.prototype.firstElementChild = null;',
    '_StubElement.prototype.lastElementChild = null;',
    '_StubElement.prototype.childElementCount = 0;',
    // Text input selection methods
    '_StubElement.prototype.selectionStart = 0;',
    '_StubElement.prototype.selectionEnd = 0;',
    '_StubElement.prototype.selectionDirection = "none";',
    '_StubElement.prototype.setSelectionRange = function(s,e,d){ this.selectionStart=s; this.selectionEnd=e; this.selectionDirection=d||"none"; };',
    '_StubElement.prototype.setRangeText = function(r,s,e,sel){ var v=this.value||this.textContent||""; var start=s!==undefined?s:this.selectionStart; var end=e!==undefined?e:this.selectionEnd; var nv=v.slice(0,start)+r+v.slice(end); if(this.value!==undefined)this.value=nv; else this.textContent=nv; if(sel==="select"||sel===undefined){this.selectionStart=start;this.selectionEnd=start+r.length;} };',
    '_StubElement.prototype.select = function(){ this.selectionStart=0; this.selectionEnd=(this.value||this.textContent||"").length; };',
    // contentEditable setter with isContentEditable sync
    'Object.defineProperty(_StubElement.prototype,"contentEditable",{get:function(){return this._contentEditable||"false";},set:function(v){this._contentEditable=String(v);this.isContentEditable=(v==="true"||v==="plaintext-only");},configurable:true});',

    // FontFaceSet stub
    'var _fontFaceSet = {',
    '  load: function(f){ return Promise.resolve([]); },',
    '  check: function(){ return true; },',
    '  ready: Promise.resolve(),',
    '  status: "loaded",',
    '  forEach: _noop,',
    '  add: _noop,',
    '  delete: _noop,',
    '  clear: _noop,',
    '  addEventListener: _noop,',
    '  removeEventListener: _noop',
    '};',

    // ── HTMLElement/SVGElement/Element/Node constructor aliases ─────────
    // Many frameworks do `el instanceof HTMLElement` — alias to _StubElement
    'var HTMLElement = _StubElement;',
    'var SVGElement = _StubElement;',
    'var MathMLElement = _StubElement;',
    'var Element = _StubElement;',
    'var Node = _StubElement;',
    'var HTMLAnchorElement = _StubElement;',
    'var HTMLButtonElement = _StubElement;',
    'var HTMLCanvasElement = _StubElement;',
    'var HTMLDivElement = _StubElement;',
    'var HTMLFormElement = _StubElement;',
    'var HTMLIFrameElement = _StubElement;',
    'var HTMLImageElement = _StubElement;',
    'var HTMLInputElement = _StubElement;',
    'var HTMLLinkElement = _StubElement;',
    'var HTMLMediaElement = _StubElement;',
    'var HTMLOptionElement = _StubElement;',
    'var HTMLScriptElement = _StubElement;',
    'var HTMLSelectElement = _StubElement;',
    'var HTMLSpanElement = _StubElement;',
    'var HTMLStyleElement = _StubElement;',
    'var HTMLTableElement = _StubElement;',
    'var HTMLTextAreaElement = _StubElement;',
    'var HTMLVideoElement = _StubElement;',
    'var HTMLAudioElement = _StubElement;',
    'var HTMLBodyElement = _StubElement;',
    'var HTMLHeadElement = _StubElement;',
    'var HTMLHtmlElement = _StubElement;',
    'var HTMLMetaElement = _StubElement;',
    'var HTMLParagraphElement = _StubElement;',
    'var HTMLTemplateElement = _StubElement;',
    'var HTMLSlotElement = _StubElement;',
    'var HTMLDetailsElement = _StubElement;',
    'var HTMLDialogElement = _StubElement;',
    'var SVGSVGElement = _StubElement;',
    'var SVGGraphicsElement = _StubElement;',
    'var SVGPathElement = _StubElement;',
    'var DocumentFragment = _StubElement;',
    'var ShadowRoot = _StubElement;',
    'var Comment = function(t){return {nodeType:8,textContent:String(t||""),nodeValue:String(t||""),parentNode:null};};',
    'var Text = function(t){return {nodeType:3,textContent:String(t||""),nodeValue:String(t||""),parentNode:null};};',
    'var CDATASection = function(t){return {nodeType:4,textContent:String(t||""),nodeValue:String(t||""),parentNode:null};};',
    'var ProcessingInstruction = function(t,d){return {nodeType:7,target:t,data:d,textContent:d,parentNode:null};};',
    'var Attr = function(n,v){return {name:n,localName:n,value:v||"",nodeType:2,namespaceURI:null,prefix:null};};',
    'var Range = function(){this.collapsed=true;this.commonAncestorContainer=null;this.startContainer=null;this.endContainer=null;this.startOffset=0;this.endOffset=0;};',
    'Range.prototype.setStart=Range.prototype.setEnd=Range.prototype.setStartBefore=Range.prototype.setStartAfter=Range.prototype.setEndBefore=Range.prototype.setEndAfter=Range.prototype.collapse=Range.prototype.selectNode=Range.prototype.selectNodeContents=Range.prototype.insertNode=Range.prototype.detach=Range.prototype.surroundContents=function(){return undefined;};',
    'Range.prototype.deleteContents=Range.prototype.extractContents=Range.prototype.cloneContents=function(){return document.createDocumentFragment();};',
    'Range.prototype.cloneRange=function(){return new Range();};',
    'Range.prototype.getBoundingClientRect=function(){return {x:0,y:0,width:0,height:0,top:0,left:0,right:0,bottom:0,toJSON:function(){return this;}};};',
    'Range.prototype.getClientRects=function(){return [];};',
    'Range.prototype.createContextualFragment=function(h){return document.createDocumentFragment();};',
    'Range.prototype.toString=function(){return "";};',
    'Range.START_TO_START=0;Range.START_TO_END=1;Range.END_TO_END=2;Range.END_TO_START=3;',
    'var StaticRange=function(s){Object.assign(this,{startContainer:s.startContainer,startOffset:s.startOffset,endContainer:s.endContainer,endOffset:s.endOffset,collapsed:s.startContainer===s.endContainer&&s.startOffset===s.endOffset});};',
    'var AbstractRange=Range;',
    'var NodeIterator=function(){this.referenceNode=_docBody;this.pointerBeforeReferenceNode=false;};',
    'NodeIterator.prototype.nextNode=NodeIterator.prototype.previousNode=function(){return null;};',
    'NodeIterator.prototype.detach=function(){};',
    'var TreeWalker=function(root,whatToShow,filter){this.root=root;this.currentNode=root;this.whatToShow=whatToShow||0xFFFFFFFF;this.filter=filter||null;};',
    // Helper: does this node pass the whatToShow mask and optional filter?
    'function _twOk(n,w,f){var b=1<<((n.nodeType||1)-1);if(!(w&b))return false;if(f){var r=typeof f==="function"?f(n):(f.acceptNode?f.acceptNode(n):1);if(r===2||r===3)return false;}return true;}',
    // Depth-first descent: first matching node in subtree (pre-order)
    'function _twDesc(n,w,f){var ch=n.childNodes||[];for(var _i=0;_i<ch.length;_i++){var _n=ch[_i];if(_twOk(_n,w,f))return _n;var d=_twDesc(_n,w,f);if(d)return d;}return null;}',
    // Last-descendant helper for previousNode
    'function _twLastDesc(n,w,f){var ch=n.childNodes||[];for(var _i=ch.length-1;_i>=0;_i--){var d=_twLastDesc(ch[_i],w,f);if(d)return d;if(_twOk(ch[_i],w,f))return ch[_i];}return null;}',
    'TreeWalker.prototype.nextNode=function(){var _cur=this.currentNode,_w=this.whatToShow,_f=this.filter;'+
    'var _d=_twDesc(_cur,_w,_f);if(_d){this.currentNode=_d;return _d;}'+
    'var _node=_cur;while(_node&&_node!==this.root){var _p=_node.parentNode;if(!_p)break;var _s=_p.childNodes||[];var _idx=_s.indexOf(_node);for(var _j=_idx+1;_j<_s.length;_j++){if(_twOk(_s[_j],_w,_f)){this.currentNode=_s[_j];return _s[_j];}var _d2=_twDesc(_s[_j],_w,_f);if(_d2){this.currentNode=_d2;return _d2;}}  _node=_p;}return null;};',
    'TreeWalker.prototype.firstChild=function(){var ch=this.currentNode.childNodes||[],w=this.whatToShow,f=this.filter;for(var i=0;i<ch.length;i++){if(_twOk(ch[i],w,f)){this.currentNode=ch[i];return ch[i];}}return null;};',
    'TreeWalker.prototype.lastChild=function(){var ch=this.currentNode.childNodes||[],w=this.whatToShow,f=this.filter;for(var i=ch.length-1;i>=0;i--){if(_twOk(ch[i],w,f)){this.currentNode=ch[i];return ch[i];}}return null;};',
    'TreeWalker.prototype.nextSibling=function(){var p=this.currentNode.parentNode,w=this.whatToShow,f=this.filter;if(!p||this.currentNode===this.root)return null;var s=p.childNodes||[];var i=s.indexOf(this.currentNode);for(var j=i+1;j<s.length;j++){if(_twOk(s[j],w,f)){this.currentNode=s[j];return s[j];}}return null;};',
    'TreeWalker.prototype.previousSibling=function(){var p=this.currentNode.parentNode,w=this.whatToShow,f=this.filter;if(!p||this.currentNode===this.root)return null;var s=p.childNodes||[];var i=s.indexOf(this.currentNode);for(var j=i-1;j>=0;j--){if(_twOk(s[j],w,f)){this.currentNode=s[j];return s[j];}}return null;};',
    'TreeWalker.prototype.parentNode=function(){if(this.currentNode===this.root)return null;var n=this.currentNode.parentNode,w=this.whatToShow,f=this.filter;while(n&&n!==this.root){if(_twOk(n,w,f)){this.currentNode=n;return n;}n=n.parentNode;}return null;};',
    'TreeWalker.prototype.previousNode=function(){if(this.currentNode===this.root)return null;var p=this.currentNode.parentNode,w=this.whatToShow,f=this.filter;if(!p)return null;var s=p.childNodes||[];var i=s.indexOf(this.currentNode);for(var j=i-1;j>=0;j--){var d=_twLastDesc(s[j],w,f);var n=d||((_twOk(s[j],w,f))?s[j]:null);if(n){this.currentNode=n;return n;}}if(p!==this.root&&_twOk(p,w,f)){this.currentNode=p;return p;}return null;};',
    'var XPathResult=function(){this.numberValue=0;this.stringValue="";this.booleanValue=false;this.singleNodeValue=null;this.resultType=0;this.snapshotLength=0;};',
    'XPathResult.ANY_TYPE=0;XPathResult.NUMBER_TYPE=1;XPathResult.STRING_TYPE=2;XPathResult.BOOLEAN_TYPE=3;XPathResult.UNORDERED_NODE_ITERATOR_TYPE=4;XPathResult.ORDERED_NODE_ITERATOR_TYPE=5;XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE=6;XPathResult.ORDERED_NODE_SNAPSHOT_TYPE=7;XPathResult.ANY_UNORDERED_NODE_TYPE=8;XPathResult.FIRST_ORDERED_NODE_TYPE=9;',
    'XPathResult.prototype.iterateNext=function(){return null;};',
    'XPathResult.prototype.snapshotItem=function(){return null;};',
    'var XPathExpression=function(expr){this._expr=expr;};',
    'XPathExpression.prototype.evaluate=function(ctx,type){return new XPathResult();};',
    'var CSSStyleSheet=function(o){this._rules=[];this.disabled=false;this.href=(o&&o.href)||"";this.title=(o&&o.title)||"";this.media={};this.ownerNode=null;this.type="text/css";};',
    'CSSStyleSheet.prototype.insertRule=function(r,i){this._rules.splice(i||0,0,r);return i||0;};',
    'CSSStyleSheet.prototype.deleteRule=function(i){this._rules.splice(i,1);};',
    'CSSStyleSheet.prototype.addRule=function(sel,style,i){return this.insertRule(sel+"{"+style+"}",i);};',
    'CSSStyleSheet.prototype.removeRule=function(i){return this.deleteRule(i);};',
    'Object.defineProperty(CSSStyleSheet.prototype,"cssRules",{get:function(){return this._rules.map(function(r,i){return {cssText:r,selectorText:"",style:{}};});}});',
    'var MediaList=function(m){this._list=m?m.split(","):[]; this.mediaText=m||"";};',
    'MediaList.prototype.appendMedium=function(m){this._list.push(m); this.mediaText=this._list.join(",");};',
    'MediaList.prototype.deleteMedium=function(m){this._list=this._list.filter(function(x){return x.trim()!==m.trim();}); this.mediaText=this._list.join(",");};',
    'MediaList.prototype.item=function(i){return this._list[i]||null;};',
    'Object.defineProperty(MediaList.prototype,"length",{get:function(){return this._list.length;}});',
    'var CSSRule=function(){this.cssText="";this.type=1;this.parentStyleSheet=null;this.parentRule=null;this.style={};this.selectorText="";};',
    'CSSRule.STYLE_RULE=1;CSSRule.CHARSET_RULE=2;CSSRule.IMPORT_RULE=3;CSSRule.MEDIA_RULE=4;CSSRule.FONT_FACE_RULE=5;CSSRule.PAGE_RULE=6;CSSRule.KEYFRAMES_RULE=7;CSSRule.KEYFRAME_RULE=8;CSSRule.NAMESPACE_RULE=10;CSSRule.COUNTER_STYLE_RULE=11;CSSRule.SUPPORTS_RULE=12;',

    // document stub
    'var _docBody = new _StubElement("BODY");',
    'var _docHead = new _StubElement("HEAD");',
    'var _docEl = new _StubElement("HTML");',
    '_docEl.childNodes = [_docHead, _docBody];',
    'var document = {',
    '  nodeType: 9,',
    '  title: "",',
    '  readyState: "complete",',
    '  compatMode: "CSS1Compat",',
    '  characterSet: "UTF-8", charset: "UTF-8",',
    '  contentType: "text/html",',
    '  documentElement: _docEl,',
    '  head: _docHead,',
    '  body: _docBody,',
    '  styleSheets: [],',
    '  scripts: [],',
    '  images: [],',
    '  links: [],',
    '  forms: [],',
    '  defaultView: globalThis,',
    '  implementation: { createHTMLDocument: function(t){ return document; } },',
    '  createElement: function(t){ return new _StubElement(t); },',
    '  createElementNS: function(ns,t){ return new _StubElement(t); },',
    '  createDocumentFragment: function(){ return new _StubElement("FRAGMENT"); },',
    '  createTextNode: function(t){ var n={nodeType:3,textContent:String(t),nodeValue:String(t),parentNode:null,parentElement:null,nextSibling:null,previousSibling:null}; return n; },',
    '  createComment: function(t){ return {nodeType:8,textContent:String(t),nodeValue:String(t),parentNode:null,parentElement:null,nextSibling:null,previousSibling:null}; },',    '  createEvent: function(t){ return {type:"",target:null,bubbles:false,cancelable:false,preventDefault:_noop,stopPropagation:_noop,initEvent:function(t2){this.type=t2;}}; },',
    '  createRange: function(){ return {setStart:_noop,setEnd:_noop,collapse:_noop,cloneContents:function(){return new _StubElement("FRAGMENT");},getBoundingClientRect:function(){return{x:0,y:0,width:0,height:0,top:0,left:0,right:0,bottom:0};}}; },',
    '  createTreeWalker: function(root,whatToShow,filter){ return new TreeWalker(root,whatToShow,filter); },',
    '  createNodeIterator: function(root,whatToShow,filter){ var tw=new TreeWalker(root,whatToShow,filter); return {currentNode:root,nextNode:function(){return tw.nextNode();},previousNode:function(){return tw.previousNode();},detach:function(){}}; },',
    '  ELEMENT_NODE:1,ATTRIBUTE_NODE:2,TEXT_NODE:3,COMMENT_NODE:8,DOCUMENT_NODE:9,DOCUMENT_FRAGMENT_NODE:11,',
    '  getElementById: function(id){ var r=_stubQSA(document.body,"#"+id,true); return r[0]||null; },',
    '  getElementsByClassName: function(cn){ return _stubQSA(document.body,"."+cn.split(/\\s+/).join("."),false); },',
    '  getElementsByTagName: function(tag){ if(tag==="*")return _stubQSA(document.body,"*",false);return _stubQSA(document.body,tag,false); },',
    '  getElementsByName: function(n){ return _stubQSA(document.body,"[name=\\""+n+"\\"]",false); },',
    '  querySelector: function(sel){ var r=_stubQSA(document.body,sel,true); return r[0]||null; },',
    '  querySelectorAll: function(sel){ return _stubQSA(document.body,sel,false); },',
    '  addEventListener: _noop,',
    '  removeEventListener: _noop,',
    '  dispatchEvent: _noopTrue,',
    '  evaluate: function(){ return {iterateNext:_noopNull,snapshotLength:0,snapshotItem:_noopNull}; },',
    '  adoptNode: function(n){ return n; },',
    '  importNode: function(n){ return n; },',
    '  hasFocus: _noopTrue,',
    '  getSelection: function(){ return {rangeCount:0,toString:function(){return ""},addRange:_noop,removeAllRanges:_noop,collapse:_noop,extend:_noop,getRangeAt:function(){return null;}}; },',
    '  exitFullscreen: _noopPromise,',
    '  hidden: false,',
    '  visibilityState: "visible",',
    '  fullscreenEnabled: false,',
    '  fullscreenElement: null,',
    '  pointerLockElement: null,',
    '  pictureInPictureElement: null,',
    '  pictureInPictureEnabled: false,',
    '  timeline: null,',
    '  activeElement: _docBody,',
    '  currentScript: null,',
    '  lastModified: "",',
    '  referrer: "",',
    '  URL: typeof location!=="undefined"&&location.href||"",',
    '  documentURI: typeof location!=="undefined"&&location.href||"",',
    '  domain: "",',
    '  cookie: "",',
    '  open: function(){ return document; },',
    '  close: _noop,',
    '  write: function(s){ document.body.innerHTML += s; },',
    '  writeln: function(s){ document.body.innerHTML += s + "\\n"; },',
    '  elementFromPoint: function(){ return document.body; },',
    '  elementsFromPoint: function(){ return [document.body]; },',
    '  caretRangeFromPoint: function(){ return null; },',
    '  caretPositionFromPoint: function(){ return null; },',
    '  execCommand: function(){ return false; },',
    '  queryCommandEnabled: function(){ return false; },',
    '  queryCommandState: function(){ return false; },',
    '  queryCommandValue: function(){ return ""; },',
    '  queryCommandSupported: function(){ return false; },',
    '  createProcessingInstruction: function(t,d){ return {nodeType:7,target:t,data:d}; },',
    '  createCDATASection: function(d){ return {nodeType:4,data:d}; },',
    '  createAttribute: function(name){ return {name:name,value:"",specified:true}; },',
    '  createAttributeNS: function(ns,name){ return {name:name,value:"",specified:true}; },',
    '  getAnimations: function(){ return []; },',
    '  startViewTransition: function(cb){ if(cb) setTimeout(cb,0); return {ready:Promise.resolve(),finished:Promise.resolve(),skipTransition:_noop}; },',
    '  fonts: _fontFaceSet',
    '};',

    // ── Event constructors ───────────────────────────────────────────────
    'function Event(t,o){this.cancelBubble=false;this._stopImm=false;this.type=t||"";this.bubbles=!!(o&&o.bubbles);this.cancelable=!!(o&&o.cancelable);this.target=null;this.currentTarget=null;this.defaultPrevented=false;this.isTrusted=false;this.timeStamp=Date.now();this.eventPhase=0;this.composed=!!(o&&o.composed);}',
    'Event.prototype.preventDefault=function(){if(this.cancelable)this.defaultPrevented=true;};',
    'Event.prototype.stopPropagation=function(){this.cancelBubble=true;};',
    'Event.prototype.stopImmediatePropagation=function(){this.cancelBubble=true;this._stopImm=true;};',
    'Event.prototype.composedPath=function(){return this.target?[this.target,document,window]:[];};',
    'Event.prototype.initEvent=function(t,b,c){this.type=t;this.bubbles=!!b;this.cancelable=!!c;};',
    'Event.NONE=0;Event.CAPTURING_PHASE=1;Event.AT_TARGET=2;Event.BUBBLING_PHASE=3;',
    'function CustomEvent(t,o){Event.call(this,t,o);this.detail=(o&&o.detail)!==undefined?o.detail:null;}',
    'CustomEvent.prototype=Object.create(Event.prototype);',
    'function UIEvent(t,o){Event.call(this,t,o);this.detail=(o&&o.detail)||0;this.view=(o&&o.view)||null;}',
    'UIEvent.prototype=Object.create(Event.prototype);',
    'function MouseEvent(t,o){UIEvent.call(this,t,o);var i=o||{};this.clientX=i.clientX||0;this.clientY=i.clientY||0;this.screenX=i.screenX||0;this.screenY=i.screenY||0;this.pageX=i.pageX||0;this.pageY=i.pageY||0;this.button=i.button||0;this.buttons=i.buttons||0;this.ctrlKey=!!i.ctrlKey;this.shiftKey=!!i.shiftKey;this.altKey=!!i.altKey;this.metaKey=!!i.metaKey;this.offsetX=i.offsetX||0;this.offsetY=i.offsetY||0;this.movementX=i.movementX||0;this.movementY=i.movementY||0;this.relatedTarget=i.relatedTarget||null;}',
    'MouseEvent.prototype=Object.create(UIEvent.prototype);',
    'MouseEvent.prototype.getModifierState=function(){return false;};',
    'function PointerEvent(t,o){MouseEvent.call(this,t,o);var i=o||{};this.pointerId=i.pointerId||1;this.width=i.width||1;this.height=i.height||1;this.pressure=i.pressure||0;this.tangentialPressure=0;this.tiltX=0;this.tiltY=0;this.twist=0;this.pointerType=i.pointerType||"mouse";this.isPrimary=i.isPrimary!==undefined?i.isPrimary:true;}',
    'PointerEvent.prototype=Object.create(MouseEvent.prototype);',
    'function KeyboardEvent(t,o){UIEvent.call(this,t,o);var i=o||{};this.key=i.key||"";this.code=i.code||"";this.keyCode=i.keyCode||0;this.which=i.which||i.keyCode||0;this.charCode=i.charCode||0;this.ctrlKey=!!i.ctrlKey;this.shiftKey=!!i.shiftKey;this.altKey=!!i.altKey;this.metaKey=!!i.metaKey;this.repeat=!!i.repeat;this.isComposing=!!i.isComposing;this.location=i.location||0;}',
    'KeyboardEvent.prototype=Object.create(UIEvent.prototype);',
    'KeyboardEvent.prototype.getModifierState=function(){return false;};',
    'KeyboardEvent.DOM_KEY_LOCATION_STANDARD=0;KeyboardEvent.DOM_KEY_LOCATION_LEFT=1;KeyboardEvent.DOM_KEY_LOCATION_RIGHT=2;KeyboardEvent.DOM_KEY_LOCATION_NUMPAD=3;',
    'function InputEvent(t,o){UIEvent.call(this,t,o);var i=o||{};this.data=i.data||null;this.inputType=i.inputType||"";this.isComposing=!!i.isComposing;}',
    'InputEvent.prototype=Object.create(UIEvent.prototype);',
    'function FocusEvent(t,o){UIEvent.call(this,t,o);this.relatedTarget=(o&&o.relatedTarget)||null;}',
    'FocusEvent.prototype=Object.create(UIEvent.prototype);',
    'function WheelEvent(t,o){MouseEvent.call(this,t,o);var i=o||{};this.deltaX=i.deltaX||0;this.deltaY=i.deltaY||0;this.deltaZ=i.deltaZ||0;this.deltaMode=i.deltaMode||0;}',
    'WheelEvent.prototype=Object.create(MouseEvent.prototype);',
    'WheelEvent.DOM_DELTA_PIXEL=0;WheelEvent.DOM_DELTA_LINE=1;WheelEvent.DOM_DELTA_PAGE=2;',
    'function TouchEvent(t,o){UIEvent.call(this,t,o);var i=o||{};this.touches=i.touches||[];this.targetTouches=i.targetTouches||[];this.changedTouches=i.changedTouches||[];this.ctrlKey=!!i.ctrlKey;this.shiftKey=!!i.shiftKey;this.altKey=!!i.altKey;this.metaKey=!!i.metaKey;}',
    'TouchEvent.prototype=Object.create(UIEvent.prototype);',
    'function CompositionEvent(t,o){UIEvent.call(this,t,o);this.data=(o&&o.data)||"";}',
    'CompositionEvent.prototype=Object.create(UIEvent.prototype);',
    'function DragEvent(t,o){MouseEvent.call(this,t,o);this.dataTransfer=(o&&o.dataTransfer)||null;}',
    'DragEvent.prototype=Object.create(MouseEvent.prototype);',
    'function AnimationEvent(t,o){Event.call(this,t,o);var i=o||{};this.animationName=i.animationName||"";this.elapsedTime=i.elapsedTime||0;this.pseudoElement=i.pseudoElement||"";}',
    'AnimationEvent.prototype=Object.create(Event.prototype);',
    'function TransitionEvent(t,o){Event.call(this,t,o);var i=o||{};this.propertyName=i.propertyName||"";this.elapsedTime=i.elapsedTime||0;this.pseudoElement=i.pseudoElement||"";}',
    'TransitionEvent.prototype=Object.create(Event.prototype);',
    'function MessageEvent(t,o){Event.call(this,t,o);var i=o||{};this.data=i.data!==undefined?i.data:null;this.origin=i.origin||"";this.lastEventId=i.lastEventId||"";this.source=i.source||null;this.ports=i.ports||[];}',
    'MessageEvent.prototype=Object.create(Event.prototype);',
    'function ErrorEvent(t,o){Event.call(this,t,o);var i=o||{};this.message=i.message||"";this.filename=i.filename||"";this.lineno=i.lineno||0;this.colno=i.colno||0;this.error=i.error||null;}',
    'ErrorEvent.prototype=Object.create(Event.prototype);',
    'function StorageEvent(t,o){Event.call(this,t,o);var i=o||{};this.key=i.key||null;this.oldValue=i.oldValue||null;this.newValue=i.newValue||null;this.url=i.url||"";this.storageArea=i.storageArea||null;}',
    'StorageEvent.prototype=Object.create(Event.prototype);',
    'function HashChangeEvent(t,o){Event.call(this,t,o);var i=o||{};this.oldURL=i.oldURL||"";this.newURL=i.newURL||"";}',
    'HashChangeEvent.prototype=Object.create(Event.prototype);',
    'function PopStateEvent(t,o){Event.call(this,t,o);this.state=(o&&o.state)!==undefined?o.state:null;}',
    'PopStateEvent.prototype=Object.create(Event.prototype);',
    'function BeforeUnloadEvent(t,o){Event.call(this,t,o);this.returnValue="";}',
    'BeforeUnloadEvent.prototype=Object.create(Event.prototype);',
    'function ClipboardEvent(t,o){Event.call(this,t,o);this.clipboardData=(o&&o.clipboardData)||null;}',
    'ClipboardEvent.prototype=Object.create(Event.prototype);',
    'function SecurityPolicyViolationEvent(t,o){Event.call(this,t,o);}',
    'SecurityPolicyViolationEvent.prototype=Object.create(Event.prototype);',
    'function SubmitEvent(t,o){Event.call(this,t,o);this.submitter=(o&&o.submitter)||null;}',
    'SubmitEvent.prototype=Object.create(Event.prototype);',
    'function ToggleEvent(t,o){Event.call(this,t,o);var i=o||{};this.oldState=i.oldState||"";this.newState=i.newState||"";}',
    'ToggleEvent.prototype=Object.create(Event.prototype);',

    // ── Misc Web APIs ────────────────────────────────────────────────────
    'var MutationObserver = function(cb){ this._cb=cb; this._nodes=[]; };',
    'MutationObserver.prototype.observe = function(node,opts) { this._nodes.push({node:node,opts:opts}); };',
    'MutationObserver.prototype.disconnect = function() { this._nodes=[]; };',
    'MutationObserver.prototype.takeRecords = function() { return []; };',
    'var IntersectionObserver = function(cb,o){ this._cb=cb; this._opts=o||{}; this._els=[]; };',
    'IntersectionObserver.prototype.observe = function(el) { this._els.push(el); var self=this; setTimeout(function() { try { self._cb([{target:el,isIntersecting:true,intersectionRatio:1,boundingClientRect:el.getBoundingClientRect?el.getBoundingClientRect():{},rootBounds:null,intersectionRect:{},time:0}],self); } catch(_){} },0); };',
    'IntersectionObserver.prototype.unobserve = function(el) { var i=this._els.indexOf(el); if(i>=0) this._els.splice(i,1); };',
    'IntersectionObserver.prototype.disconnect = function() { this._els=[]; };',
    'IntersectionObserver.prototype.takeRecords = function() { return []; };',
    'var ResizeObserver = function(cb){ this._cb=cb; this._els=[]; };',
    'ResizeObserver.prototype.observe = function(el,opts) { this._els.push({el:el,opts:opts||{}}); var self=this; setTimeout(function() { try { var r=el.getBoundingClientRect?el.getBoundingClientRect():{width:0,height:0}; self._cb([{target:el,contentRect:r,borderBoxSize:[{inlineSize:r.width||0,blockSize:r.height||0}],contentBoxSize:[{inlineSize:r.width||0,blockSize:r.height||0}]}],self); } catch(_){} },0); };',
    'ResizeObserver.prototype.unobserve = function(el) { this._els=this._els.filter(function(e){return e.el!==el;}); };',
    'ResizeObserver.prototype.disconnect = function() { this._els=[]; };',
    'var queueMicrotask = function(fn) { Promise.resolve().then(fn); };',
    'var reportError = function(e) { console.error(e); };',
    // Real Base64 implementations (atob/btoa)
    'var atob = function(b64) { var chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; var out="",buf=0,bits=0; for(var i=0;i<b64.length;i++){var idx=chars.indexOf(b64[i]);if(idx<0)continue;buf=(buf<<6)|idx;bits+=6;if(bits>=8){bits-=8;out+=String.fromCharCode((buf>>bits)&0xFF);}} return out; };',
    'var btoa = function(s) { var chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; var out="",buf=0,bits=0; for(var i=0;i<s.length;i++){buf=(buf<<8)|s.charCodeAt(i);bits+=8;while(bits>=6){bits-=6;out+=chars[(buf>>bits)&63];}} if(bits>0)out+=chars[(buf<<(6-bits))&63]; while(out.length%4)out+="="; return out; };',
    '(function(){',
    '  function _sc(x,seen){',
    '    if(x===null||x===undefined||(typeof x!=="object"&&typeof x!=="function"))return x;',
    '    if(x instanceof Date)return new Date(x.getTime());',
    '    if(x instanceof RegExp)return new RegExp(x.source,x.flags);',
    '    if(x instanceof ArrayBuffer)return x.slice(0);',
    '    if(typeof ArrayBuffer!=="undefined"&&ArrayBuffer.isView&&ArrayBuffer.isView(x)){try{return new x.constructor(x);}catch(_){}}',
    '    if(typeof Map!=="undefined"&&x instanceof Map){var m=new Map();x.forEach(function(v,k){m.set(_sc(k,seen),_sc(v,seen));});return m;}',
    '    if(typeof Set!=="undefined"&&x instanceof Set){var s=new Set();x.forEach(function(v){s.add(_sc(v,seen));});return s;}',
    '    if(seen.has(x))return seen.get(x);',
    '    if(Array.isArray(x)){var a=[];seen.set(x,a);for(var i=0;i<x.length;i++)a.push(_sc(x[i],seen));return a;}',
    '    var o=Object.create(null);seen.set(x,o);',
    '    var ks=Object.getOwnPropertyNames(x);for(var j=0;j<ks.length;j++){try{o[ks[j]]=_sc(x[ks[j]],seen);}catch(_){}}',
    '    return o;',
    '  }',
    '  var structuredClone=function(v,opts){try{return _sc(v,new Map());}catch(_){try{return JSON.parse(JSON.stringify(v));}catch(__){return v;}}};',
    '})();',

    // ── window-level API ─────────────────────────────────────────────────
    'var getComputedStyle = function(el, pseudo) {',
    '  var s = (el && el.style) ? el.style : {};',
    '  var computed = {',
    '    getPropertyValue: function(k) { return s[k]||s.getPropertyValue?s.getPropertyValue(k):""; },',
    '    setProperty: function(){},',
    '    removeProperty: function(){},',
    '    display: s.display||"block",',
    '    visibility: s.visibility||"visible",',
    '    opacity: s.opacity!==undefined?s.opacity:"1",',
    '    position: s.position||"static",',
    '    top: s.top||"auto", left: s.left||"auto", right: s.right||"auto", bottom: s.bottom||"auto",',
    '    width: s.width||"auto", height: s.height||"auto",',
    '    margin: s.margin||"0px", marginTop: s.marginTop||"0px", marginRight: s.marginRight||"0px", marginBottom: s.marginBottom||"0px", marginLeft: s.marginLeft||"0px",',
    '    padding: s.padding||"0px", paddingTop: s.paddingTop||"0px", paddingRight: s.paddingRight||"0px", paddingBottom: s.paddingBottom||"0px", paddingLeft: s.paddingLeft||"0px",',
    '    fontSize: s.fontSize||"16px",',
    '    fontFamily: s.fontFamily||"sans-serif",',
    '    fontWeight: s.fontWeight||"normal",',
    '    fontStyle: s.fontStyle||"normal",',
    '    lineHeight: s.lineHeight||"normal",',
    '    color: s.color||"rgb(0, 0, 0)",',
    '    backgroundColor: s.backgroundColor||"rgba(0, 0, 0, 0)",',
    '    border: s.border||"", borderTop: s.borderTop||"", borderRight: s.borderRight||"", borderBottom: s.borderBottom||"", borderLeft: s.borderLeft||"",',
    '    borderWidth: s.borderWidth||"0px", borderStyle: s.borderStyle||"none", borderColor: s.borderColor||"currentcolor",',
    '    borderRadius: s.borderRadius||"0px",',
    '    transform: s.transform||"none",',
    '    transition: s.transition||"",',
    '    animation: s.animation||"",',
    '    overflow: s.overflow||"visible", overflowX: s.overflowX||"visible", overflowY: s.overflowY||"visible",',
    '    zIndex: s.zIndex||"auto",',
    '    float: s.float||s.cssFloat||"none",',
    '    clear: s.clear||"none",',
    '    cursor: s.cursor||"auto",',
    '    pointerEvents: s.pointerEvents||"auto",',
    '    userSelect: s.userSelect||"auto",',
    '    boxSizing: s.boxSizing||"content-box",',
    '    flex: s.flex||"", flexDirection: s.flexDirection||"row", flexWrap: s.flexWrap||"nowrap",',
    '    justifyContent: s.justifyContent||"normal", alignItems: s.alignItems||"normal", alignSelf: s.alignSelf||"auto",',
    '    gridTemplateColumns: s.gridTemplateColumns||"none", gridTemplateRows: s.gridTemplateRows||"none",',
    '    content: s.content||"normal",',
    '    outline: s.outline||"none",',
    '    boxShadow: s.boxShadow||"none",',
    '    textAlign: s.textAlign||"start",',
    '    textDecoration: s.textDecoration||"none",',
    '    whiteSpace: s.whiteSpace||"normal",',
    '    verticalAlign: s.verticalAlign||"baseline",',
    '    listStyle: s.listStyle||"none",',
    '    tableLayout: s.tableLayout||"auto",',
    '    direction: s.direction||"ltr",',
    '    writingMode: s.writingMode||"horizontal-tb",',
    '  };',
    '  return computed;',
    '};',
    'var matchMedia = function(q) {',
    '  var lq = String(q).toLowerCase();',
    '  var matches = false;',
    '  if (lq.indexOf("prefers-color-scheme") >= 0) matches = lq.indexOf("light") >= 0;',
    '  else if (lq.indexOf("prefers-reduced-motion") >= 0) matches = lq.indexOf("reduce") >= 0;',
    '  else if (lq.indexOf("max-width") >= 0 || lq.indexOf("max-device-width") >= 0) matches = true;',
    '  var lst = [];',
    '  return { matches: matches, media: q, onchange: null,',
    '    addEventListener: function(t,fn) { if(t==="change") lst.push(fn); },',
    '    removeEventListener: function(t,fn) { var i=lst.indexOf(fn); if(i>=0) lst.splice(i,1); },',
    '    addListener: function(fn) { lst.push(fn); },',
    '    removeListener: function(fn) { var i=lst.indexOf(fn); if(i>=0) lst.splice(i,1); }',
    '  };',
    '};',
    'var getSelection = function(){ return document.getSelection(); };',
    'var requestAnimationFrame = function(fn){ return setTimeout(fn, 16); };',
    'var cancelAnimationFrame = function(id){ clearTimeout(id); };',
    'var requestIdleCallback = function(fn){ return setTimeout(function(){fn({didTimeout:false,timeRemaining:function(){return 50;}});},1); };',
    'var cancelIdleCallback = function(id){ clearTimeout(id); };',

    // ── EventTarget base class ────────────────────────────────────────────
    'function EventTarget() { this._listeners = {}; }',
    'EventTarget.prototype.addEventListener = function(t,fn,opts) { if(!this._listeners) this._listeners={}; var _once=opts&&opts.once; var _fn=_once?function(e){fn.call(this,e);this.removeEventListener(t,_fn);}.bind(this):fn; if(!this._listeners[t]) this._listeners[t]=[]; this._listeners[t].push({fn:_fn,orig:fn}); };',
    'EventTarget.prototype.removeEventListener = function(t,fn) { if(!this._listeners||!this._listeners[t]) return; this._listeners[t]=this._listeners[t].filter(function(h){return h.orig!==fn&&h.fn!==fn;}); };',
    'EventTarget.prototype.dispatchEvent = function(ev) { if(!this._listeners) this._listeners={}; var _type=ev.type; ev.target=ev.target||this; ev.currentTarget=this; var _oh=this["on"+_type]; if(typeof _oh==="function")try{_oh.call(this,ev);}catch(_){} var _ls=this._listeners[_type]; if(_ls){var _lsc=_ls.slice();for(var _li=0;_li<_lsc.length;_li++){if(ev._stopImm)break;try{_lsc[_li].fn.call(this,ev);}catch(_){}}} if(ev.bubbles&&!ev.cancelBubble){var _ep=this.parentNode;while(_ep&&!ev.cancelBubble){ev.currentTarget=_ep;var _poh=_ep["on"+_type];if(typeof _poh==="function")try{_poh.call(_ep,ev);}catch(_){}if(_ep._listeners&&_ep._listeners[_type]){var _pls=_ep._listeners[_type].slice();for(var _pli=0;_pli<_pls.length;_pli++){if(ev._stopImm||ev.cancelBubble)break;try{_pls[_pli].fn.call(_ep,ev);}catch(_){}}} _ep=_ep.parentNode;}} return !ev.defaultPrevented; };',
    // Copy EventTarget methods to _StubElement (overrides the _noop placeholders set at construction)
    '_StubElement.prototype.addEventListener = EventTarget.prototype.addEventListener;',
    '_StubElement.prototype.removeEventListener = EventTarget.prototype.removeEventListener;',
    '_StubElement.prototype.dispatchEvent = EventTarget.prototype.dispatchEvent;',
    '[_docEl,_docHead,_docBody].forEach(function(e){if(e&&!e._listeners)e._listeners={};});',

    // ── DOMException stub ─────────────────────────────────────────────────
    'function DOMException(msg,name){ this.message=msg||""; this.name=name||"Error"; this.code=0; }',
    'DOMException.prototype = Object.create(Error.prototype);',
    'DOMException.INDEX_SIZE_ERR=1;DOMException.HIERARCHY_REQUEST_ERR=3;DOMException.WRONG_DOCUMENT_ERR=4;',
    'DOMException.INVALID_CHARACTER_ERR=5;DOMException.NOT_FOUND_ERR=8;DOMException.NOT_SUPPORTED_ERR=9;',
    'DOMException.INVALID_STATE_ERR=11;DOMException.SYNTAX_ERR=12;DOMException.INVALID_ACCESS_ERR=15;',
    'DOMException.TYPE_MISMATCH_ERR=17;DOMException.SECURITY_ERR=18;DOMException.NETWORK_ERR=19;',
    'DOMException.ABORT_ERR=20;DOMException.URL_MISMATCH_ERR=21;DOMException.QUOTA_EXCEEDED_ERR=22;',
    'DOMException.TIMEOUT_ERR=23;DOMException.INVALID_NODE_TYPE_ERR=24;DOMException.DATA_CLONE_ERR=25;',

    // ── DOMParser / XMLSerializer ─────────────────────────────────────────
    'function DOMParser(){ }',
    'DOMParser.prototype.parseFromString = function(str, type) {',
    '  var doc2 = { documentElement: new _StubElement("HTML"), body: new _StubElement("BODY"), head: new _StubElement("HEAD"), querySelector: _noopNull, querySelectorAll: _noopArr, getElementById: _noopNull };',
    '  doc2.body.innerHTML = str;',
    '  return doc2;',
    '};',
    'function XMLSerializer(){ }',
    'XMLSerializer.prototype.serializeToString = function(n){ return n&&n.outerHTML||n&&n.innerHTML||""; };',

    // ── TextEncoder / TextDecoder ─────────────────────────────────────────
    'if(typeof TextEncoder==="undefined"){',
    '  var TextEncoder=function(){ this.encoding="utf-8"; };',
    '  TextEncoder.prototype.encode=function(s){ var bytes=[]; s=String(s||""); for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<0x80)bytes.push(c);else if(c<0x800){bytes.push(0xC0|(c>>6),0x80|(c&0x3F));}else{bytes.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F));}} return new Uint8Array(bytes); };',
    '  TextEncoder.prototype.encodeInto=function(s,buf){ var enc=this.encode(s); buf.set(enc); return {read:s.length,written:enc.length}; };',
    '}',
    'if(typeof TextDecoder==="undefined"){',
    '  var TextDecoder=function(e){ this.encoding=e||"utf-8"; this.fatal=false; this.ignoreBOM=false; };',
    '  TextDecoder.prototype.decode=function(buf){ if(!buf) return ""; var bytes=buf instanceof Uint8Array?buf:new Uint8Array(buf); var out=""; for(var i=0;i<bytes.length;){var b=bytes[i];if(b<0x80){out+=String.fromCharCode(b);i++;}else if((b&0xE0)===0xC0){out+=String.fromCharCode(((b&0x1F)<<6)|(bytes[i+1]&0x3F));i+=2;}else{out+=String.fromCharCode(((b&0x0F)<<12)|((bytes[i+1]&0x3F)<<6)|(bytes[i+2]&0x3F));i+=3;}} return out; };',
    '}',

    // ── Performance API ───────────────────────────────────────────────────
    'var performance = (function(){',
    '  var _t0 = Date.now();',
    '  var _marks = {}; var _entries = [];',
    '  return {',
    '    now: function(){ return Date.now()-_t0; },',
    '    timeOrigin: _t0,',
    '    mark: function(n){ var e={entryType:"mark",name:n,startTime:Date.now()-_t0,duration:0}; _marks[n]=e; _entries.push(e); },',
    '    measure: function(n,a,b){ var s=_marks[a]?_marks[a].startTime:0; var e2=_marks[b]?_marks[b].startTime:(Date.now()-_t0); _entries.push({entryType:"measure",name:n,startTime:s,duration:e2-s}); },',
    '    clearMarks: function(n){ if(n)delete _marks[n]; else _marks={}; },',
    '    clearMeasures: _noop,',
    '    getEntries: function(){ return _entries.slice(); },',
    '    getEntriesByType: function(t){ return _entries.filter(function(e){return e.entryType===t;}); },',
    '    getEntriesByName: function(n){ return _entries.filter(function(e){return e.name===n;}); },',
    '    navigation: {type:0,redirectCount:0},',
    '    timing: {navigationStart:_t0,responseEnd:_t0,domInteractive:_t0,domContentLoadedEventEnd:_t0,domComplete:_t0,loadEventStart:_t0,loadEventEnd:_t0},',
    '    memory: {jsHeapSizeLimit:2147483648,usedJSHeapSize:4000000,totalJSHeapSize:8000000},',
    '    eventCounts: new Map(),',
    '    setResourceTimingBufferSize: _noop,',
    '    clearResourceTimings: _noop,',
    '    addEventListener: _noop, removeEventListener: _noop',
    '  };',
    '})();',

    // ── PerformanceObserver ───────────────────────────────────────────────
    'function PerformanceObserver(cb){ this._cb=cb; }',
    'PerformanceObserver.prototype.observe = _noop;',
    'PerformanceObserver.prototype.disconnect = _noop;',
    'PerformanceObserver.prototype.takeRecords = function(){ return []; };',
    'PerformanceObserver.supportedEntryTypes = ["mark","measure","navigation","resource","longtask","paint","largest-contentful-paint","layout-shift","first-input"];',

    // ── BroadcastChannel ─────────────────────────────────────────────────
    'function BroadcastChannel(name){ this.name=name; this.onmessage=null; this._ls=[]; }',
    'BroadcastChannel.prototype.postMessage = _noop;',
    'BroadcastChannel.prototype.close = _noop;',
    'BroadcastChannel.prototype.addEventListener = _noop;',
    'BroadcastChannel.prototype.removeEventListener = _noop;',

    // ── MessageChannel / MessagePort ─────────────────────────────────────
    'function MessagePort(){ this._ls=[]; this.onmessage=null; this.onmessageerror=null; }',
    'MessagePort.prototype.postMessage = _noop;',
    'MessagePort.prototype.start = _noop;',
    'MessagePort.prototype.close = _noop;',
    'MessagePort.prototype.addEventListener = _noop;',
    'MessagePort.prototype.removeEventListener = _noop;',
    'function MessageChannel(){ this.port1=new MessagePort(); this.port2=new MessagePort(); }',

    // ── PromiseRejectionEvent ─────────────────────────────────────────────
    'function PromiseRejectionEvent(t,o){ Event.call(this,t,o); this.promise=(o&&o.promise)||Promise.resolve(); this.reason=(o&&o.reason)||undefined; }',
    'PromiseRejectionEvent.prototype = Object.create(Event.prototype);',

    // ── DataTransfer / DataTransferItem ───────────────────────────────────
    'function DataTransferItemList(){ this._items=[]; }',
    'DataTransferItemList.prototype.length = 0;',
    'DataTransferItemList.prototype.add = _noop;',
    'DataTransferItemList.prototype.remove = _noop;',
    'DataTransferItemList.prototype.clear = _noop;',
    'function DataTransfer(){ this.items=new DataTransferItemList(); this.types=[]; this.files=[]; this.effectAllowed="none"; this.dropEffect="none"; }',
    'DataTransfer.prototype.getData = function(){ return ""; };',
    'DataTransfer.prototype.setData = _noop;',
    'DataTransfer.prototype.clearData = _noop;',
    'DataTransfer.prototype.setDragImage = _noop;',

    // ── FileReader stub ───────────────────────────────────────────────────
    'function FileReader(){ this.readyState=0; this.result=null; this.error=null; this.onload=null; this.onerror=null; this.onprogress=null; this.onabort=null; this.onloadend=null; this.onloadstart=null; }',
    'FileReader.EMPTY=0;FileReader.LOADING=1;FileReader.DONE=2;',
    'FileReader.prototype.readAsText=function(b){ var self=this; self.readyState=2; self.result=""; setTimeout(function(){if(self.onload)self.onload({target:self});if(self.onloadend)self.onloadend({target:self});},0); };',
    'FileReader.prototype.readAsDataURL=function(b){ var self=this; self.readyState=2; self.result="data:text/plain;base64,"; setTimeout(function(){if(self.onload)self.onload({target:self});if(self.onloadend)self.onloadend({target:self});},0); };',
    'FileReader.prototype.readAsArrayBuffer=function(b){ var self=this; self.readyState=2; self.result=new ArrayBuffer(0); setTimeout(function(){if(self.onload)self.onload({target:self});if(self.onloadend)self.onloadend({target:self});},0); };',
    'FileReader.prototype.abort=function(){ this.readyState=2; if(this.onabort) this.onabort({target:this}); };',
    'FileReader.prototype.addEventListener=_noop;',
    'FileReader.prototype.removeEventListener=_noop;',

    // ── NodeFilter (tree walker constants) ────────────────────────────────
    'var NodeFilter = { SHOW_ALL:0xFFFFFFFF, SHOW_ELEMENT:1, SHOW_TEXT:4, SHOW_COMMENT:128,',
    '  FILTER_ACCEPT:1, FILTER_REJECT:2, FILTER_SKIP:3 };',

    // ── window.onerror / onunhandledrejection ─────────────────────────────
    'var onerror = null;',
    'var onunhandledrejection = null;',
    'var onbeforeunload = null;',
    'var onpagehide = null;',
    'var onpageshow = null;',
    'var onpopstate = null;',
    'var onhashchange = null;',
    'var onstorage = null;',
    'var onoffline = null;',
    'var ononline = null;',
    'var onresize = null;',
    'var onscroll = null;',
    'var onload = null;',
    'var onDOMContentLoaded = null;',

    // ── CSS object ──────────────────────────────────────────────────────
    'var CSS = {',
    '  supports: function(p, v) {',
    '    if (typeof v !== "undefined") return true;',
    '    var s = String(p);',
    '    if (s.indexOf("(") < 0) return true;',
    '    if (s.toLowerCase().indexOf("not ") === 1) return false;',
    '    return true;',
    '  },',
    '  escape: function(v) {',
    '    return String(v).replace(/[\\x00-\\x1f\\x7f]/g, "").replace(/^(-?\\d)/, "\\\\$1").replace(/([!"#$%&\'()*+,./:;<=>?@[\\]^`{|}~])/g, "\\\\$1");',
    '  },',
    '  registerProperty: function() {},',
    '  paintWorklet: { addModule: function() {} },',
    '  highlights: new Map(),',
    '};',

    // ── WebSocket stub ───────────────────────────────────────────────────
    'var WebSocket = function(url, protocols) {',
    '  this.url = String(url); this.readyState = 0; this.bufferedAmount = 0;',
    '  this.extensions = ""; this.protocol = "";',
    '  this.binaryType = "blob";',
    '  this.onopen = null; this.onclose = null; this.onerror = null; this.onmessage = null;',
    '  this._listeners = {};',
    '  var self = this;',
    '  setTimeout(function() {',
    '    self.readyState = 3;',
    '    if (self.onerror) try { self.onerror({type:"error",message:"WebSocket not supported in sandboxed context"}); } catch(_) {}',
    '    if (self.onclose) try { self.onclose({type:"close",code:1001,reason:"",wasClean:false}); } catch(_) {}',
    '  }, 0);',
    '};',
    'WebSocket.prototype.send = function(data) { if(this.readyState!==1) throw new DOMException("WebSocket is not open","InvalidStateError"); };',
    'WebSocket.prototype.close = function(code, reason) { this.readyState=3; };',
    'WebSocket.prototype.addEventListener = function(t,cb,o){ (this._listeners[t]||(this._listeners[t]=[])).push(cb); };',
    'WebSocket.prototype.removeEventListener = function(t,cb){ if(this._listeners[t]) this._listeners[t]=this._listeners[t].filter(function(x){return x!==cb;}); };',
    'WebSocket.prototype.dispatchEvent = function(e){ var ls=this._listeners[e.type]||[]; ls.forEach(function(x){try{x(e);}catch(_){}}); return !e.defaultPrevented; };',
    'WebSocket.CONNECTING=0; WebSocket.OPEN=1; WebSocket.CLOSING=2; WebSocket.CLOSED=3;',

    // ── WebAssembly stub ─────────────────────────────────────────────────
    'var WebAssembly = (typeof WebAssembly !== "undefined") ? WebAssembly : {',
    '  compile: function(b) { return Promise.reject(new Error("WebAssembly not supported")); },',
    '  compileStreaming: function(r) { return Promise.reject(new Error("WebAssembly not supported")); },',
    '  instantiate: function(m, i) { return Promise.reject(new Error("WebAssembly not supported")); },',
    '  instantiateStreaming: function(r, i) { return Promise.reject(new Error("WebAssembly not supported")); },',
    '  validate: function(b) { return false; },',
    '  Module: function() { throw new Error("WebAssembly not supported"); },',
    '  Instance: function() { throw new Error("WebAssembly not supported"); },',
    '  Memory: function(d) { this.buffer = new ArrayBuffer((d&&d.initial||1)*65536); },',
    '  Table: function(d) { this.length = (d&&d.initial||0); this.get=function(){return null;}; this.set=function(){}; this.grow=function(){}; },',
    '  Global: function(d,v) { this.value = v||0; },',
    '  Tag: function() {},',
    '  Exception: function() {},',
    '};',

    // ── EventSource stub ─────────────────────────────────────────────────
    'var EventSource = function(url, opts) {',
    '  this.url = String(url); this.readyState = 0; this.withCredentials = !!(opts&&opts.withCredentials);',
    '  this.onopen = null; this.onmessage = null; this.onerror = null;',
    '  this._listeners = {};',
    '  var self = this;',
    '  setTimeout(function() {',
    '    self.readyState = 2;',
    '    if (self.onerror) try { self.onerror({type:"error"}); } catch(_) {}',
    '  }, 0);',
    '};',
    'EventSource.CONNECTING=0; EventSource.OPEN=1; EventSource.CLOSED=2;',
    'EventSource.prototype.close = function() { this.readyState = 2; };',
    'EventSource.prototype.addEventListener = function(t,cb){ (this._listeners[t]||(this._listeners[t]=[])).push(cb); };',
    'EventSource.prototype.removeEventListener = function(t,cb){ if(this._listeners[t]) this._listeners[t]=this._listeners[t].filter(function(x){return x!==cb;}); };',
    'EventSource.prototype.dispatchEvent = function(e){ var ls=this._listeners[e.type]||[]; ls.forEach(function(x){try{x(e);}catch(_){}}); return true; };',

    // ── navigator.deviceMemory ───────────────────────────────────────────
    'if(!("deviceMemory" in navigator)) { try { Object.defineProperty(navigator,"deviceMemory",{value:4,writable:false,configurable:true}); } catch(_) { navigator.deviceMemory=4; } }',
    'if(!("keyboard" in navigator)) { navigator.keyboard = { getLayoutMap:function(){return Promise.resolve(new Map());}, lock:function(){return Promise.resolve();}, unlock:function(){} }; }',
    'if(!("wakeLock" in navigator)) { navigator.wakeLock = { request:function(){return Promise.reject(new Error("WakeLock not supported"));} }; }',
    'if(!("xr" in navigator)) { navigator.xr = { isSessionSupported:function(){return Promise.resolve(false);}, requestSession:function(){return Promise.reject(new Error("XR not supported"));} }; }',
    'if(!("hid" in navigator)) { navigator.hid = { requestDevice:function(){return Promise.resolve([]);}, getDevices:function(){return Promise.resolve([]); }, addEventListener:function(){}, removeEventListener:function(){} }; }',
    'if(!("usb" in navigator)) { navigator.usb = { requestDevice:function(){return Promise.reject(new Error("USB not supported"));}, getDevices:function(){return Promise.resolve([]);}, addEventListener:function(){}, removeEventListener:function(){} }; }',
    'if(!("serial" in navigator)) { navigator.serial = { requestPort:function(){return Promise.reject(new Error("Serial not supported"));}, getPorts:function(){return Promise.resolve([]);}, addEventListener:function(){}, removeEventListener:function(){} }; }',
    'if(!("bluetooth" in navigator)) { navigator.bluetooth = { requestDevice:function(){return Promise.reject(new Error("Bluetooth not supported"));}, getAvailability:function(){return Promise.resolve(false);}, addEventListener:function(){}, removeEventListener:function(){} }; }',

    // ── visualViewport ──────────────────────────────────────────────────
    'var visualViewport = {',
    '  width: 1024, height: 768,',
    '  offsetLeft: 0, offsetTop: 0,',
    '  pageLeft: 0, pageTop: 0,',
    '  scale: 1,',
    '  addEventListener: function(){}, removeEventListener: function(){}',
    '};',

    // ── trustedTypes ────────────────────────────────────────────────────
    'var trustedTypes = {',
    '  createPolicy: function(name, rules) {',
    '    return { name: name,',
    '      createHTML: rules && rules.createHTML ? rules.createHTML : function(s) { return s; },',
    '      createScript: rules && rules.createScript ? rules.createScript : function(s) { return s; },',
    '      createScriptURL: rules && rules.createScriptURL ? rules.createScriptURL : function(s) { return s; } };',
    '  },',
    '  isHTML: function() { return false; },',
    '  isScript: function() { return false; },',
    '  isScriptURL: function() { return false; },',
    '  defaultPolicy: null,',
    '  emptyHTML: "",',
    '  emptyScript: "",',
    '  getAttributeType: function() { return null; },',
    '  getPropertyType: function() { return null; },',
    '  getPolicyNames: function() { return []; },',
    '};',

    // ── scheduler ───────────────────────────────────────────────────────
    'var scheduler = {',
    '  postTask: function(fn, opts) { var d = opts && opts.delay ? opts.delay : 0; return new Promise(function(resolve) { setTimeout(function() { resolve(fn()); }, d); }); },',
    '  yield: function() { return Promise.resolve(); },',
    '};',

    // ── Viewport ─────────────────────────────────────────────────────────
    'var innerWidth = 1024, innerHeight = 768;',
    'var outerWidth = 1024, outerHeight = 768;',
    'var devicePixelRatio = 1;',
    'var scrollX = 0, scrollY = 0, pageXOffset = 0, pageYOffset = 0;',
    'var scrollTo = _noop, scrollBy = _noop, scroll = _noop;',
    'var alert = function(m){ console.log("[alert] "+m); };',
    'var confirm = function(){ return false; };',
    'var prompt = function(m,d){ return d||""; };',
    'var close = _noop, focus = _noop, blur = _noop;',
    'var open = function(){ return null; };',
    'var print = _noop;',

    // ── Storage stubs ────────────────────────────────────────────────────
    'var _makeStorage = function(){',
    '  var d={};',
    '  return{',
    '    getItem:function(k){return d[k]||null;},',
    '    setItem:function(k,v){d[k]=String(v);},',
    '    removeItem:function(k){delete d[k];},',
    '    clear:function(){d={};},',
    '    key:function(n){return Object.keys(d)[n]||null;},',
    '    get length(){return Object.keys(d).length;}',
    '  };',
    '};',
    'var localStorage = _makeStorage();',
    'var sessionStorage = _makeStorage();',

    // ── fetch stub (relays to coordinator via postMessage) ───────────────
    'var fetch = function(url, opts) {',
    '  return Promise.resolve({',
    '    ok: true, status: 200, statusText: "OK",',
    '    headers: { get: function() { return null; } },',
    '    text: function() { return Promise.resolve(""); },',
    '    json: function() { return Promise.resolve({}); },',
    '    arrayBuffer: function() { return Promise.resolve(new ArrayBuffer(0)); },',
    '    blob: function() { return Promise.resolve(new Blob([])); },',
    '    clone: function() { return this; }',
    '  });',
    '};',

    // ── XMLHttpRequest stub ──────────────────────────────────────────────
    'function XMLHttpRequest() {',
    '  this.readyState=0; this.status=0; this.statusText="";',
    '  this.responseText=""; this.response=null; this.responseType="";',
    '  this.withCredentials=false; this.timeout=0;',
    '  this._hdrs={}; this._rhdrs={};',
    '}',
    'XMLHttpRequest.prototype.open=function(m,u){this._m=m;this._u=u;this.readyState=1;};',
    'XMLHttpRequest.prototype.send=function(){this.readyState=4;this.status=200;if(this.onreadystatechange)this.onreadystatechange();if(this.onload)this.onload();};',
    'XMLHttpRequest.prototype.abort=_noop;',
    'XMLHttpRequest.prototype.setRequestHeader=function(k,v){this._hdrs[k]=v;};',
    'XMLHttpRequest.prototype.getResponseHeader=function(k){return this._rhdrs[k]||null;};',
    'XMLHttpRequest.prototype.getAllResponseHeaders=function(){return"";};',
    'XMLHttpRequest.prototype.addEventListener=_noop;',
    'XMLHttpRequest.prototype.removeEventListener=_noop;',
    'XMLHttpRequest.UNSENT=0;XMLHttpRequest.OPENED=1;XMLHttpRequest.HEADERS_RECEIVED=2;',
    'XMLHttpRequest.LOADING=3;XMLHttpRequest.DONE=4;',

    // ── AbortController / AbortSignal ─────────────────────────────────────
    'var AbortController=(function(){',
    '  function AC(){',
    '    var _ls=[]; var _me=this;',
    '    this.signal={aborted:false,reason:undefined,onabort:null,_ls:_ls,',
    '      addEventListener:function(t,fn){if(t==="abort"&&fn&&_ls.indexOf(fn)<0)_ls.push(fn);},',
    '      removeEventListener:function(t,fn){var i=_ls.indexOf(fn);if(i>=0)_ls.splice(i,1);},',
    '      throwIfAborted:function(){if(this.aborted){var e=this.reason;throw e!==undefined?e:new DOMException("The operation was aborted.","AbortError");}},',
    '      dispatchEvent:function(e){if(e&&e.type==="abort"){if(typeof this.onabort==="function")try{this.onabort(e);}catch(_){}for(var i=0;i<_ls.length;i++)try{_ls[i](e);}catch(_){}}},',
    '    };',
    '    this.abort=function(r){',
    '      if(_me.signal.aborted)return;',
    '      _me.signal.aborted=true;',
    '      _me.signal.reason=r!==undefined?r:new DOMException("The user aborted a request.","AbortError");',
    '      _me.signal.dispatchEvent({type:"abort",target:_me.signal});',
    '    };',
    '  }',
    '  return AC;',
    '})();',
    'var AbortSignal={',
    '  abort:function(r){var c=new AbortController();c.abort(r);return c.signal;},',
    '  timeout:function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException("TimeoutError","TimeoutError"));},ms);return c.signal;},',
    '  any:function(sigs){var c=new AbortController();for(var i=0;i<sigs.length;i++){var s=sigs[i];if(s.aborted){c.abort(s.reason);break;}s.addEventListener("abort",function(){if(!c.signal.aborted)c.abort(this.reason);});}return c.signal;}',
    '};',

    // ── URL / URLSearchParams ────────────────────────────────────────────
    // (QJS built-in URL class should be available, but add fallbacks)
    'if(typeof URLSearchParams==="undefined"){',
    '  var URLSearchParams=function(init){this._p=[];if(typeof init==="string"){init.replace(/^\\?/,"").split("&").forEach(function(p){var kv=p.split("=");if(kv[0])this._p.push([decodeURIComponent(kv[0]),decodeURIComponent(kv[1]||"")]);}.bind(this));}};',
    '  URLSearchParams.prototype.get=function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;};',
    '  URLSearchParams.prototype.set=function(k,v){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k){this._p[i][1]=v;return;}this._p.push([k,v]);};',
    '  URLSearchParams.prototype.has=function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return true;return false;};',
    '  URLSearchParams.prototype.delete=function(k){this._p=this._p.filter(function(p){return p[0]!==k;});};',
    '  URLSearchParams.prototype.toString=function(){return this._p.map(function(p){return encodeURIComponent(p[0])+"="+encodeURIComponent(p[1]);}).join("&");};',
    '  URLSearchParams.prototype.forEach=function(cb){this._p.forEach(function(p){cb(p[1],p[0]);});};',
    '}',

    // ── Blob / FormData stubs ────────────────────────────────────────────
    'if(typeof Blob==="undefined"){',
    '  var Blob=function(parts,opts){this.size=0;this.type=(opts&&opts.type)||"";};',
    '  Blob.prototype.text=function(){return Promise.resolve("");};',
    '  Blob.prototype.arrayBuffer=function(){return Promise.resolve(new ArrayBuffer(0));};',
    '}',
    'if(typeof FormData==="undefined"){',
    '  var FormData=function(){this._d=[];};',
    '  FormData.prototype.append=function(k,v){this._d.push([k,v]);};',
    '  FormData.prototype.get=function(k){for(var i=0;i<this._d.length;i++)if(this._d[i][0]===k)return this._d[i][1];return null;};',
    '  FormData.prototype.has=function(k){for(var i=0;i<this._d.length;i++)if(this._d[i][0]===k)return true;return false;};',
    '}',

    // ── Headers / Request / Response stubs ───────────────────────────────
    'if(typeof Headers==="undefined"){',
    '  var Headers=function(init){this._h={};if(init)for(var k in init)this._h[k.toLowerCase()]=init[k];};',
    '  Headers.prototype.get=function(k){return this._h[k.toLowerCase()]||null;};',
    '  Headers.prototype.set=function(k,v){this._h[k.toLowerCase()]=v;};',
    '  Headers.prototype.has=function(k){return k.toLowerCase() in this._h;};',
    '  Headers.prototype.forEach=function(cb){for(var k in this._h)cb(this._h[k],k);};',
    '}',

    // ── Image constructor ────────────────────────────────────────────────
    'var Image = function(w,h){ var e=new _StubElement("IMG"); e.width=w||0; e.height=h||0; return e; };',

    // ── Notification stub ────────────────────────────────────────────────
    'function Notification(title, opts) { this.title = title; this.body = (opts&&opts.body)||""; this.icon = (opts&&opts.icon)||""; this.onclick = null; this.onclose = null; this.onerror = null; }',
    'Notification.permission = "granted";',
    'Notification.requestPermission = function() { return Promise.resolve("granted"); };',
    'Notification.prototype.close = _noop;',
    'Notification.prototype.addEventListener = _noop;',
    'Notification.prototype.removeEventListener = _noop;',

    // ── caches (Cache Storage API) stub ──────────────────────────────────
    'var caches = (function() {',
    '  var _store = {};',
    '  function _Cache() { this._entries = {}; }',
    '  _Cache.prototype.put = function(req,resp) { this._entries[typeof req==="string"?req:req.url] = resp; return Promise.resolve(); };',
    '  _Cache.prototype.match = function(req) { return Promise.resolve(this._entries[typeof req==="string"?req:req.url]||null); };',
    '  _Cache.prototype.matchAll = function() { return Promise.resolve(Object.values(this._entries)); };',
    '  _Cache.prototype.delete = function(req) { delete this._entries[typeof req==="string"?req:req.url]; return Promise.resolve(true); };',
    '  _Cache.prototype.keys = function() { return Promise.resolve(Object.keys(this._entries)); };',
    '  _Cache.prototype.addAll = function() { return Promise.resolve(); };',
    '  _Cache.prototype.add = function() { return Promise.resolve(); };',
    '  return {',
    '    open: function(n) { if(!_store[n]) _store[n]=new _Cache(); return Promise.resolve(_store[n]); },',
    '    has: function(n) { return Promise.resolve(n in _store); },',
    '    delete: function(n) { delete _store[n]; return Promise.resolve(true); },',
    '    keys: function() { return Promise.resolve(Object.keys(_store)); },',
    '    match: function(req) { for(var n in _store) { var e=_store[n]._entries[typeof req==="string"?req:req.url]; if(e) return Promise.resolve(e); } return Promise.resolve(null); }',
    '  };',
    '})();',

    // ── indexedDB stub ───────────────────────────────────────────────────
    'var indexedDB = (function() {',
    '  function IDBRequest(result) { this.result=result; this.error=null; this.readyState="done"; this.onsuccess=null; this.onerror=null; }',
    '  function _fire(req) { setTimeout(function(){ if(req.error && req.onerror) req.onerror({target:req}); else if(req.onsuccess) req.onsuccess({target:req}); }, 0); }',
    '  function IDBOpenDBRequest(name) { IDBRequest.call(this,null); this._name=name; this.onupgradeneeded=null; this.onblocked=null; }',
    '  IDBOpenDBRequest.prototype = Object.create(IDBRequest.prototype);',
    '  var _dbs = {};',
    '  return {',
    '    open: function(name, ver) {',
    '      var req = new IDBOpenDBRequest(name);',
    '      setTimeout(function() {',
    '        if (!_dbs[name]) { _dbs[name] = { _stores:{}, _ver: ver||1 }; if(req.onupgradeneeded) { var db2={createObjectStore:function(sn,opts){_dbs[name]._stores[sn]={_data:{},keyPath:(opts&&opts.keyPath)||null};return {createIndex:_noop};},objectStoreNames:{contains:function(sn){return sn in _dbs[name]._stores;}},transaction:function(){return {objectStore:function(){return {};}}},name:name,version:_dbs[name]._ver}; try{req.onupgradeneeded({target:req,result:db2});}catch(_){} } }',
    '        req.result = {name:name,version:_dbs[name]._ver,objectStoreNames:{contains:function(sn){return sn in _dbs[name]._stores;}},transaction:function(){return {objectStore:function(sn){var s=_dbs[name]._stores[sn]||{};return{get:function(k){var r=new IDBRequest(s._data?s._data[k]:undefined);_fire(r);return r;},put:function(v,k){if(s._data){s._data[k||v[s.keyPath||"id"]]=v;}var r=new IDBRequest(k);_fire(r);return r;},add:function(v,k){return this.put(v,k);},delete:function(k){if(s._data)delete s._data[k];var r=new IDBRequest(undefined);_fire(r);return r;},getAll:function(){var r=new IDBRequest(s._data?Object.values(s._data):[]);_fire(r);return r;},getAllKeys:function(){var r=new IDBRequest(s._data?Object.keys(s._data):[]);_fire(r);return r;},count:function(){var r=new IDBRequest(s._data?Object.keys(s._data).length:0);_fire(r);return r;},createIndex:_noop,index:function(){ return {get:function(){var r=new IDBRequest(null);_fire(r);return r;},getAll:function(){var r=new IDBRequest([]);_fire(r);return r;}};}};},abort:_noop,commit:_noop,addEventListener:_noop,removeEventListener:_noop,oncomplete:null,onerror:null}; }, close:_noop, addEventListener:_noop, removeEventListener:_noop};',
    '        if(req.onsuccess) req.onsuccess({target:req});',
    '      }, 0);',
    '      return req;',
    '    },',
    '    deleteDatabase: function(name) { delete _dbs[name]; var req=new IDBRequest(undefined); setTimeout(function(){if(req.onsuccess)req.onsuccess({target:req});},0); return req; },',
    '    cmp: function(a, b) { return a<b?-1:a>b?1:0; }',
    '  };',
    '})();',

    // ── console shim (ensure full console API in child) ──────────────────
    'if (typeof console === "undefined" || !console.warn) {',
    '  var console = (function() {',
    '    function _log(lvl, args) { try { print("[" + lvl + "] " + Array.prototype.join.call(args, " ")); } catch(_) {} }',
    '    return { log:function(){_log("log",arguments);}, warn:function(){_log("warn",arguments);}, error:function(){_log("error",arguments);}, info:function(){_log("info",arguments);}, debug:function(){_log("debug",arguments);}, trace:function(){_log("trace",arguments);}, group:function(){}, groupCollapsed:function(){}, groupEnd:function(){}, time:function(){}, timeEnd:function(){}, timeLog:function(){}, assert:function(c,m){if(!c)_log("assert",[m||"Assertion failed"]);}, table:function(){}, count:function(){}, countReset:function(){}, clear:function(){} };',
    '  })();',
    '}',

    // ── Worker / SharedWorker stubs ──────────────────────────────────────
    'var Worker = function(url, opts) {',
    '  this.onmessage = null; this.onerror = null; this.onmessageerror = null;',
    '  this._url = String(url); this._listeners = {};',
    '};',
    'Worker.prototype.postMessage = function(data, transfer) {};',
    'Worker.prototype.terminate = function() {};',
    'Worker.prototype.addEventListener = function(t, cb) { (this._listeners[t]||(this._listeners[t]=[])).push(cb); };',
    'Worker.prototype.removeEventListener = function(t, cb) { if(this._listeners[t]) this._listeners[t]=this._listeners[t].filter(function(x){return x!==cb;}); };',
    'Worker.prototype.dispatchEvent = function(e) { var ls=this._listeners[e.type]||[]; ls.forEach(function(cb){try{cb(e);}catch(_){};}); return true; };',
    'var SharedWorker = function(url, opts) {',
    '  this.port = { postMessage:function(){}, start:function(){}, close:function(){}, onmessage:null, addEventListener:function(){}, removeEventListener:function(){} };',
    '  this.onerror = null; this.addEventListener = function(){}; this.removeEventListener = function(){};',
    '};',

    // ── ImageData / OffscreenCanvas / ImageBitmap ────────────────────────
    'var ImageData = function(widthOrData, heightOrWidth, heightOrAttrs) {',
    '  if(widthOrData instanceof Uint8ClampedArray) { this.data=widthOrData; this.width=heightOrWidth||0; this.height=heightOrAttrs||0; }',
    '  else { this.width=widthOrData||0; this.height=heightOrWidth||0; this.data=new Uint8ClampedArray(this.width*this.height*4); }',
    '  this.colorSpace="srgb";',
    '};',
    'var createImageBitmap = function(src, sx, sy, sw, sh, opts) {',
    '  return Promise.resolve({ width:sw||src.width||0, height:sh||src.height||0, close:function(){} });',
    '};',
    'var OffscreenCanvas = function(w, h) {',
    '  this.width=w||0; this.height=h||0;',
    '  var _noop=function(){};',
    '  this.getContext = function(type) {',
    '    if(type==="2d") return {canvas:this,drawImage:_noop,fillRect:_noop,clearRect:_noop,fillText:_noop,strokeText:_noop,measureText:function(t){return{width:t.length*6};},beginPath:_noop,fill:_noop,stroke:_noop,save:_noop,restore:_noop,translate:_noop,scale:_noop,rotate:_noop,transform:_noop,setTransform:_noop,putImageData:_noop,getImageData:function(x,y,w,h){return new ImageData(w,h);},createImageData:function(w,h){return new ImageData(w,h);},createLinearGradient:function(){return{addColorStop:_noop};},createRadialGradient:function(){return{addColorStop:_noop};},getLineDash:function(){return[];},setLineDash:_noop,fillStyle:"",strokeStyle:"",lineWidth:1,font:"10px sans-serif",textAlign:"start",textBaseline:"alphabetic",globalAlpha:1,globalCompositeOperation:"source-over",imageSmoothingEnabled:true,imageSmoothingQuality:"low"};',
    '    return null;',
    '  };',
    '  this.transferToImageBitmap = function() { return {width:this.width,height:this.height,close:function(){}}; };',
    '  this.convertToBlob = function(opts) { return Promise.resolve(new Blob()); };',
    '  this.addEventListener = _noop; this.removeEventListener = _noop;',
    '};',

    // ── AudioContext / Web Audio API stubs ────────────────────────────────
    'var AudioContext = function(opts) {',
    '  var _noop=function(){return undefined;};',
    '  this.state = "suspended"; this.sampleRate = (opts&&opts.sampleRate)||44100;',
    '  this.currentTime = 0; this.baseLatency = 0; this.outputLatency = 0;',
    '  this.destination = { channelCount:2, channelCountMode:"explicit", numberOfInputs:1, numberOfOutputs:0, connect:_noop, disconnect:_noop };',
    '  this.listener = { positionX:{value:0}, positionY:{value:0}, positionZ:{value:0}, forwardX:{value:0}, forwardY:{value:0}, forwardZ:{value:-1} };',
    '  var _makeNode = function() { return {connect:_noop,disconnect:_noop,start:_noop,stop:_noop,gain:{value:1},frequency:{value:440},detune:{value:0},playbackRate:{value:1},buffer:null,loop:false,loopStart:0,loopEnd:0,type:"sine",threshold:{value:-100},knee:{value:30},ratio:{value:12},attack:{value:0},release:{value:0.25},reduction:0,onended:null,channelCount:2,channelCountMode:"max",channelInterpretation:"speakers",numberOfInputs:1,numberOfOutputs:1,context:this}; }.bind(this);',
    '  this.createOscillator = _makeNode; this.createGain = _makeNode; this.createBiquadFilter = _makeNode;',
    '  this.createBufferSource = _makeNode; this.createDynamicsCompressor = _makeNode;',
    '  this.createAnalyser = function(){var n=_makeNode();n.fftSize=2048;n.frequencyBinCount=1024;n.minDecibels=-100;n.maxDecibels=-30;n.smoothingTimeConstant=0.8;n.getByteFrequencyData=_noop;n.getFloatFrequencyData=_noop;n.getByteTimeDomainData=_noop;n.getFloatTimeDomainData=_noop;return n;};',
    '  this.createMediaStreamSource = _makeNode; this.createMediaElementSource = _makeNode;',
    '  this.createChannelSplitter = _makeNode; this.createChannelMerger = _makeNode;',
    '  this.createConvolver = _makeNode; this.createDelay = _makeNode; this.createPanner = _makeNode; this.createStereoPanner = _makeNode; this.createWaveShaper = _makeNode;',
    '  this.createBuffer = function(c,len,sr){ return {numberOfChannels:c,length:len,sampleRate:sr,duration:len/sr,getChannelData:function(){return new Float32Array(len);},copyFromChannel:_noop,copyToChannel:_noop}; };',
    '  this.decodeAudioData = function(b,ok,err){ try{if(ok)ok(this.createBuffer(2,44100,this.sampleRate));} catch(e){if(err)err(e);} return Promise.resolve(this.createBuffer(2,44100,this.sampleRate)); };',
    '  this.resume = function(){ this.state="running"; return Promise.resolve(); };',
    '  this.suspend = function(){ this.state="suspended"; return Promise.resolve(); };',
    '  this.close = function(){ this.state="closed"; return Promise.resolve(); };',
    '  this.createPeriodicWave = function(){ return {}; };',
    '  this.addEventListener = _noop; this.removeEventListener = _noop;',
    '};',
    'var AudioContext_=AudioContext;',
    'var webkitAudioContext = AudioContext;',
    'var OfflineAudioContext = function(c,len,sr){AudioContext.call(this,{sampleRate:sr});this.length=len;this.startRendering=function(){return Promise.resolve(this.createBuffer(c,len,sr));};};',

    // ── Streams API stubs (ReadableStream, WritableStream, TransformStream) ──
    '(function(){',
    '  if(typeof ReadableStream==="undefined"){',
    '    var ReadableStream=function(src,s){ this._src=src||{}; this._q=[]; this._done=false; this._readers=[]; if(src&&src.start) try{src.start({enqueue:function(c){this._q.push(c);}.bind(this),close:function(){this._done=true;}.bind(this),error:function(e){this._err=e;}.bind(this),desiredSize:1});}catch(_){}};',
    '    ReadableStream.prototype.getReader=function(o){',
    '      var st=this,q=st._q,locked=false;',
    '      return {read:function(){',
    '        if(q.length) return Promise.resolve({value:q.shift(),done:false});',
    '        if(st._done) return Promise.resolve({value:undefined,done:true});',
    '        if(st._err) return Promise.reject(st._err);',
    '        if(st._src&&st._src.pull){try{st._src.pull({enqueue:function(c){q.push(c);},close:function(){st._done=true;},error:function(e){st._err=e;},desiredSize:1});}catch(_){}}',
    '        if(q.length) return Promise.resolve({value:q.shift(),done:false});',
    '        return Promise.resolve({value:undefined,done:true});',
    '      },cancel:function(r){st._done=true;return Promise.resolve();},releaseLock:function(){}};',
    '    };',
    '    ReadableStream.prototype.cancel=function(){this._done=true;return Promise.resolve();};',
    '    ReadableStream.prototype.pipeTo=function(ws,o){var rd=this.getReader(),wr=ws&&ws.getWriter?ws.getWriter():{write:function(){return Promise.resolve();},close:function(){return Promise.resolve();}};function pump(){return rd.read().then(function(r){if(r.done)return wr.close();return wr.write(r.value).then(pump);});}return pump();};',
    '    ReadableStream.prototype.pipeThrough=function(tf,o){return tf.readable||new ReadableStream();};',
    '    ReadableStream.prototype.tee=function(){return [new ReadableStream(),new ReadableStream()];};',
    '    Object.defineProperty(ReadableStream.prototype,"locked",{get:function(){return false;}});',
    '    var WritableStream=function(sink,s){this._sink=sink||{};this._closed=false;};',
    '    WritableStream.prototype.getWriter=function(){var sink=this._sink,st=this;return{write:function(c){if(sink.write)try{return Promise.resolve(sink.write(c,{}));}catch(e){return Promise.reject(e);}return Promise.resolve();},close:function(){st._closed=true;if(sink.close)try{return Promise.resolve(sink.close());}catch(e){return Promise.reject(e);}return Promise.resolve();},abort:function(r){st._closed=true;if(sink.abort)try{sink.abort(r);}catch(_){}return Promise.resolve();},releaseLock:function(){}};};',
    '    WritableStream.prototype.abort=function(r){this._closed=true;return Promise.resolve();};',
    '    WritableStream.prototype.close=function(){this._closed=true;return Promise.resolve();};',
    '    Object.defineProperty(WritableStream.prototype,"locked",{get:function(){return false;}});',
    '    var TransformStream=function(t,ws,rs){',
    '      var self=this; var _q=[]; var _closed=false;',
    '      var ctrl={enqueue:function(c){_q.push(c);},terminate:function(){_closed=true;},error:function(){_closed=true;}};',
    '      if(t&&t.start)try{t.start(ctrl);}catch(_){}',
    '      self.readable=new ReadableStream({pull:function(c){while(_q.length)c.enqueue(_q.shift());if(_closed)c.close();}});',
    '      self.writable=new WritableStream({write:function(ch){if(t&&t.transform)try{t.transform(ch,ctrl);}catch(_){}else _q.push(ch);},flush:function(){if(t&&t.flush)try{t.flush(ctrl);}catch(_){}}});',
    '    };',
    '    var CompressionStream=function(fmt){this.readable=new ReadableStream({start:function(c){this._c=c;}.bind(this)});this.writable=new WritableStream({write:function(ch){}.bind(this)});};',
    '    var DecompressionStream=CompressionStream;',
    '    var ByteLengthQueuingStrategy=function(o){this.highWaterMark=o.highWaterMark||1;this.size=function(c){return c.byteLength||1;};};',
    '    var CountQueuingStrategy=function(o){this.highWaterMark=o.highWaterMark||1;this.size=function(){return 1;};};',
    '    void 0;',
    '  }',
    '})();',

    // ── customElements stub ──────────────────────────────────────────────
    'var customElements = (function() {',
    '  var _registry = {};',
    '  var _pending = {};',
    '  return {',
    '    define: function(name, ctor, opts) {',
    '      _registry[name] = ctor;',
    '      if (_pending[name]) { _pending[name].forEach(function(r){ r(ctor); }); delete _pending[name]; }',
    '    },',
    '    get: function(name) { return _registry[name] || undefined; },',
    '    whenDefined: function(name) {',
    '      if (_registry[name]) return Promise.resolve(_registry[name]);',
    '      return new Promise(function(resolve) { (_pending[name]||(_pending[name]=[])).push(resolve); });',
    '    },',
    '    upgrade: function(root) {',
    '      function _walk(el) {',
    '        if (!el || !el.tagName) return;',
    '        var name = el.tagName.toLowerCase();',
    '        var ctor = _registry[name];',
    '        if (ctor && !el._ceUpgraded) {',
    '          el._ceUpgraded = true;',
    '          try { ctor.call(el); } catch(_) {}',
    '          if (typeof el.connectedCallback === "function") try { el.connectedCallback(); } catch(_) {}',
    '        }',
    '        var ch = el.childNodes || el.children || [];',
    '        for (var i=0;i<ch.length;i++) _walk(ch[i]);',
    '        if (el.shadowRoot) _walk(el.shadowRoot);',
    '      }',
    '      _walk(root || document.documentElement);',
    '    },',
    '    getName: function(ctor) {',
    '      for (var k in _registry) if (_registry[k]===ctor) return k;',
    '      return null;',
    '    }',
    '  };',
    '})();',

    // ── Canvas / WebGL context stubs ─────────────────────────────────────
    '_StubElement.prototype.getContext = function(type, attrs) {',
    '  if (type === "2d") {',
    '    var _noop = function(){}, _noopNull = function(){return null;};',
    '    var _state = { fillStyle:"black", strokeStyle:"black", lineWidth:1, lineCap:"butt",',
    '      lineJoin:"miter", miterLimit:10, shadowOffsetX:0, shadowOffsetY:0, shadowBlur:0,',
    '      shadowColor:"transparent", globalAlpha:1, globalCompositeOperation:"source-over",',
    '      font:"10px sans-serif", textAlign:"start", textBaseline:"alphabetic",',
    '      direction:"ltr", imageSmoothingEnabled:true, imageSmoothingQuality:"low",',
    '      filter:"none" };',
    '    return Object.assign({',
    '      canvas: this,',
    '      drawImage:_noop, fillRect:_noop, clearRect:_noop, strokeRect:_noop,',
    '      fillText:_noop, strokeText:_noop,',
    '      measureText: function(t){ return {width:t.length*6,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2,actualBoundingBoxLeft:0,actualBoundingBoxRight:t.length*6,fontBoundingBoxAscent:12,fontBoundingBoxDescent:4,emHeightAscent:10,emHeightDescent:2,hangingBaseline:6,alphabeticBaseline:0,ideographicBaseline:-2}; },',
    '      beginPath:_noop, closePath:_noop, moveTo:_noop, lineTo:_noop,',
    '      arc:_noop, arcTo:_noop, ellipse:_noop,',
    '      quadraticCurveTo:_noop, bezierCurveTo:_noop, rect:_noop, roundRect:_noop,',
    '      fill:_noop, stroke:_noop, clip:_noop, isPointInPath:function(){return false;}, isPointInStroke:function(){return false;},',
    '      save:_noop, restore:_noop,',
    '      scale:_noop, rotate:_noop, translate:_noop, transform:_noop, setTransform:_noop, resetTransform:_noop,',
    '      getTransform: function(){ return {a:1,b:0,c:0,d:1,e:0,f:0,isIdentity:true,inverse:function(){return this;},multiply:function(){return this;},scale:function(){return this;},translate:function(){return this;},rotate:function(){return this;}}; },',
    '      createLinearGradient: function(){ return {addColorStop:_noop}; },',
    '      createRadialGradient: function(){ return {addColorStop:_noop}; },',
    '      createConicGradient: function(){ return {addColorStop:_noop}; },',
    '      createPattern: _noopNull,',
    '      createImageData: function(w,h){ return {width:w,height:h,data:new Uint8ClampedArray(w*h*4),colorSpace:"srgb"}; },',
    '      getImageData: function(x,y,w,h){ return {width:w,height:h,data:new Uint8ClampedArray(w*h*4),colorSpace:"srgb"}; },',
    '      putImageData:_noop,',
    '      getLineDash: function(){ return []; }, setLineDash:_noop, lineDashOffset:0,',
    '      drawFocusIfNeeded:_noop, scrollPathIntoView:_noop,',
    '      createPath2D: function(){ return {addPath:_noop}; },',
    '      canvas: this',
    '    }, _state);',
    '  }',
    '  if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {',
    '    var _g = function(){}, _gNull = function(){return null;}, _gArr = function(){return [];}, _gZero = function(){return 0;};',
    '    return {',
    '      canvas: this, drawingBufferWidth:0, drawingBufferHeight:0,',
    '      getExtension: _gNull, getSupportedExtensions: _gArr,',
    '      getParameter: _gZero, getError: _gZero,',
    '      createBuffer:_gNull, bindBuffer:_g, bufferData:_g, bufferSubData:_g, deleteBuffer:_g,',
    '      createTexture:_gNull, bindTexture:_g, texImage2D:_g, texParameteri:_g, deleteTexture:_g, activeTexture:_g, generateMipmap:_g,',
    '      createShader:_gNull, shaderSource:_g, compileShader:_g, getShaderParameter:function(){return true;}, getShaderInfoLog:function(){return "";}, deleteShader:_g,',
    '      createProgram:_gNull, attachShader:_g, linkProgram:_g, getProgramParameter:function(){return true;}, getProgramInfoLog:function(){return "";}, useProgram:_g, deleteProgram:_g,',
    '      getAttribLocation:function(){return -1;}, getUniformLocation:_gNull,',
    '      enableVertexAttribArray:_g, disableVertexAttribArray:_g, vertexAttribPointer:_g,',
    '      uniform1f:_g, uniform1i:_g, uniform2f:_g, uniform2i:_g, uniform3f:_g, uniform3i:_g, uniform4f:_g, uniform4i:_g,',
    '      uniformMatrix2fv:_g, uniformMatrix3fv:_g, uniformMatrix4fv:_g,',
    '      drawArrays:_g, drawElements:_g,',
    '      clear:_g, clearColor:_g, clearDepth:_g, clearStencil:_g,',
    '      enable:_g, disable:_g, blendFunc:_g, depthFunc:_g, stencilFunc:_g,',
    '      viewport:_g, scissor:_g, colorMask:_g, depthMask:_g,',
    '      createFramebuffer:_gNull, bindFramebuffer:_g, framebufferTexture2D:_g, deleteFramebuffer:_g,',
    '      createRenderbuffer:_gNull, bindRenderbuffer:_g, renderbufferStorage:_g, framebufferRenderbuffer:_g, deleteRenderbuffer:_g,',
    '      readPixels:_g, finish:_g, flush:_g,',
    '      ARRAY_BUFFER:34962, ELEMENT_ARRAY_BUFFER:34963, STATIC_DRAW:35044, DYNAMIC_DRAW:35048,',
    '      FLOAT:5126, UNSIGNED_BYTE:5121, UNSIGNED_SHORT:5123, UNSIGNED_INT:5125, INT:5124, BYTE:5120, SHORT:5122,',
    '      TRIANGLES:4, TRIANGLE_STRIP:5, TRIANGLE_FAN:6, LINES:1, LINE_STRIP:3, POINTS:0,',
    '      VERTEX_SHADER:35633, FRAGMENT_SHADER:35889,',
    '      TEXTURE_2D:3553, TEXTURE_CUBE_MAP:34067, TEXTURE0:33984,',
    '      LINEAR:9729, NEAREST:9728, REPEAT:10497, CLAMP_TO_EDGE:33071,',
    '      COLOR_ATTACHMENT0:36064, FRAMEBUFFER:36160, RENDERBUFFER:36161,',
    '      DEPTH_TEST:2929, BLEND:3042, CULL_FACE:2884, SCISSOR_TEST:3089,',
    '      RGB:6407, RGBA:6408, DEPTH_COMPONENT:6402, UNSIGNED_INT_24_8:34042,',
    '      COLOR_BUFFER_BIT:16384, DEPTH_BUFFER_BIT:256, STENCIL_BUFFER_BIT:1024',
    '    };',
    '  }',
    '  if (type === "bitmaprenderer") { return { canvas: this, transferFromImageBitmap: function(){} }; }',
    '  return null;',
    '};',
    '_StubElement.prototype.toDataURL = function(type, quality) { return "data:image/png;base64,"; };',
    '_StubElement.prototype.toBlob = function(cb) { if(cb) cb(null); };',
    '_StubElement.prototype.transferControlToOffscreen = function() { return new _StubElement("canvas"); };',
    '_StubElement.prototype.captureStream = function() { return { getTracks:function(){return[];}, addTrack:function(){}, removeTrack:function(){}, getVideoTracks:function(){return[];}, getAudioTracks:function(){return[];} }; };',

    // ── Mark child runtime as ready ──────────────────────────────────────
    'var __jsos_child_ready = true;',

    // ── Intl stub (if QJS doesn't have full Intl) ─────────────────────────
    '(function(){',
    '  if(typeof Intl==="undefined") var Intl={};',
    '  if(!Intl.NumberFormat){',
    '    Intl.NumberFormat=function(_l,o){this._o=o||{};};',
    '    Intl.NumberFormat.prototype.format=function(n){',
    '      var o=this._o; var s=String(n);',
    '      if(o.style==="currency") return (o.currency||"$")+s;',
    '      if(o.style==="percent") return (n*100).toFixed(o.maximumFractionDigits||0)+"%";',
    '      if(typeof o.minimumFractionDigits==="number") s=Number(n).toFixed(o.minimumFractionDigits);',
    '      if(typeof o.maximumFractionDigits==="number") s=Number(n).toFixed(o.maximumFractionDigits);',
    '      if(o.useGrouping!==false){var parts=s.split("."); var int=parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,","); s=parts[1]?int+"."+parts[1]:int;}',
    '      return s;',
    '    };',
    '    Intl.NumberFormat.prototype.formatToParts=function(n){return [{type:"integer",value:this.format(n)}];};',
    '    Intl.NumberFormat.prototype.resolvedOptions=function(){return {locale:"en-US",numberingSystem:"latn",style:"decimal",useGrouping:true};};',
    '    Intl.NumberFormat.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.DateTimeFormat){',
    '    Intl.DateTimeFormat=function(_l,o){this._o=o||{};};',
    '    Intl.DateTimeFormat.prototype.format=function(d){',
    '      if(!(d instanceof Date)) d=new Date(d);',
    '      var o=this._o;',
    '      if(o.dateStyle==="short"||(!o.year&&!o.month&&!o.day&&!o.hour&&!o.minute)) return d.toLocaleDateString();',
    '      if(o.timeStyle==="short") return d.toLocaleTimeString();',
    '      return d.toLocaleString();',
    '    };',
    '    Intl.DateTimeFormat.prototype.formatToParts=function(d){return [{type:"literal",value:this.format(d)}];};',
    '    Intl.DateTimeFormat.prototype.resolvedOptions=function(){return {locale:"en-US",calendar:"gregory",timeZone:"UTC"};};',
    '    Intl.DateTimeFormat.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.Collator){',
    '    Intl.Collator=function(){};',
    '    Intl.Collator.prototype.compare=function(a,b){return a<b?-1:a>b?1:0;};',
    '    Intl.Collator.prototype.resolvedOptions=function(){return {locale:"en",collation:"default",sensitivity:"variant"};};',
    '    Intl.Collator.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.PluralRules){',
    '    Intl.PluralRules=function(){};',
    '    Intl.PluralRules.prototype.select=function(n){return n===1?"one":"other";};',
    '    Intl.PluralRules.prototype.selectRange=function(s,e){return e===1?"one":"other";};',
    '    Intl.PluralRules.prototype.resolvedOptions=function(){return {locale:"en",pluralCategories:["one","other"],type:"cardinal"};};',
    '    Intl.PluralRules.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.RelativeTimeFormat){',
    '    Intl.RelativeTimeFormat=function(){};',
    '    Intl.RelativeTimeFormat.prototype.format=function(v,u){return Math.abs(v)+" "+u+(Math.abs(v)!==1?"s":"")+(v<0?" ago":" from now");};',
    '    Intl.RelativeTimeFormat.prototype.formatToParts=function(v,u){return [{type:"literal",value:this.format(v,u)}];};',
    '    Intl.RelativeTimeFormat.prototype.resolvedOptions=function(){return {locale:"en",style:"long",numeric:"always"};};',
    '    Intl.RelativeTimeFormat.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.ListFormat){',
    '    Intl.ListFormat=function(){};',
    '    Intl.ListFormat.prototype.format=function(l){return Array.prototype.join.call(l,", ");};',
    '    Intl.ListFormat.prototype.formatToParts=function(l){return l.map(function(v){return {type:"element",value:v};});};',
    '    Intl.ListFormat.prototype.resolvedOptions=function(){return {locale:"en",type:"conjunction",style:"long"};};',
    '    Intl.ListFormat.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.Segmenter){',
    '    Intl.Segmenter=function(){};',
    '    Intl.Segmenter.prototype.segment=function(s){',
    '      var chars=[...s],idx=0,segs=chars.map(function(c){var r={segment:c,index:idx,input:s};idx+=c.length;return r;});',
    '      return {[Symbol.iterator]:function(){var i=0;return {next:function(){return i<segs.length?{value:segs[i++],done:false}:{value:undefined,done:true};}};},containing:function(p){return segs.find(function(x){return p>=x.index&&p<x.index+x.segment.length;})||null;}};',
    '    };',
    '    Intl.Segmenter.prototype.resolvedOptions=function(){return {locale:"en",granularity:"grapheme"};};',
    '    Intl.Segmenter.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.DisplayNames){',
    '    Intl.DisplayNames=function(_l,o){this._o=o||{};};',
    '    Intl.DisplayNames.prototype.of=function(c){return c;};',
    '    Intl.DisplayNames.prototype.resolvedOptions=function(){return {locale:"en",style:"long",type:this._o.type||"region",fallback:"code"};};',
    '    Intl.DisplayNames.supportedLocalesOf=function(){return ["en-US"];};',
    '  }',
    '  if(!Intl.getCanonicalLocales) Intl.getCanonicalLocales=function(l){return Array.isArray(l)?l:[l];};',
    '  if(!Intl.supportedValuesOf) Intl.supportedValuesOf=function(k){return [];};',
    '})();',

    // ── v8/Node.js compatibility shims ────────────────────────────────────
    'if(!Error.captureStackTrace) Error.captureStackTrace=function(o){o.stack=new Error().stack||"";};',
    'if(!Error.prototype.captureStackTrace) Error.prototype.captureStackTrace=function(){this.stack=new Error().stack||"";};',
    'Error.stackTraceLimit=50;',
    // process stub (Node.js compat — many bundled libs check typeof process)
    'var process={env:{NODE_ENV:"production",NODE_DEBUG:""},browser:true,version:"v18.0.0",versions:{node:"18.0.0"},platform:"linux",arch:"x86",argv:[],argv0:"node",execArgv:[],pid:1,ppid:0,exitCode:0,hrtime:function(prev){var n=Date.now();return prev?[0,Math.max(0,(n-prev[0]*1000-prev[1]/1e6)*1e6|0)]:[(n/1000)|0,(n%1000)*1e6|0];},nextTick:function(fn){Promise.resolve().then(fn);},on:function(){return process;},off:function(){return process;},emit:function(){},exit:function(){},abort:function(){},cwd:function(){return "/";},chdir:function(){},umask:function(){return 0o022;},binding:function(){throw new Error("binding not available");},stdout:{write:function(s){console.log(s);return true;},end:_noop,on:function(){return this;},removeListener:function(){},writableEnded:false},stderr:{write:function(s){console.error(s);return true;},end:_noop,on:function(){return this;},removeListener:function(){},writableEnded:false},stdin:{on:function(){return this;},removeListener:function(){},read:function(){return null;}}};',
    // global stub (some code does `var x = global || globalThis || window`)
    'var global = globalThis;',
    // Symbol shims for ES6 iterators if needed
    'if(!Symbol.observable) try{Object.defineProperty(Symbol,"observable",{value:Symbol("observable")});}catch(_){}',
    'if(!Symbol.asyncIterator) try{Object.defineProperty(Symbol,"asyncIterator",{value:Symbol.for("Symbol.asyncIterator")});}catch(_){}',
    // Array.prototype.at polyfill (ES2022)
    'if(!Array.prototype.at) Array.prototype.at=function(i){return i>=0?this[i]:this[this.length+i];};',
    'if(!String.prototype.at) String.prototype.at=function(i){return i>=0?this[i]:this[this.length+i];};',
    'if(!TypedArray) {} ; try{ if(!Int8Array.prototype.at) Int8Array.prototype.at=Array.prototype.at; }catch(_){}',
    // Object.hasOwn (ES2022)
    'if(!Object.hasOwn) Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k);};',
    // Array grouping (ES2024)
    'if(!Array.prototype.group && !Object.groupBy) { try{ Object.groupBy=function(arr,fn){var r={};for(var i=0;i<arr.length;i++){var k=fn(arr[i],i);if(!r[k])r[k]=[];r[k].push(arr[i]);}return r;}; Map.groupBy=function(arr,fn){var r=new Map();for(var i=0;i<arr.length;i++){var k=fn(arr[i],i);if(!r.has(k))r.set(k,[]);r.get(k).push(arr[i]);}return r;}; }catch(_){} }',
    // Promise.withResolvers (ES2024)
    'if(!Promise.withResolvers) Promise.withResolvers=function(){var res,rej;var p=new Promise(function(rv,rj){res=rv;rej=rj;});return{promise:p,resolve:res,reject:rej};};',
    // Promise.try (TC39 Stage 4 - Chrome 134+)
    'if(!Promise.try) Promise.try=function(fn){try{return Promise.resolve(fn());}catch(e){return Promise.reject(e);}};',
    // Array ES2023 non-mutating methods
    'if(!Array.prototype.toReversed) Array.prototype.toReversed=function(){return this.slice().reverse();};',
    'if(!Array.prototype.toSorted) Array.prototype.toSorted=function(fn){return this.slice().sort(fn);};',
    'if(!Array.prototype.toSpliced) Array.prototype.toSpliced=function(s,d){var a=this.slice();a.splice.apply(a,[s,d||0].concat(Array.prototype.slice.call(arguments,2)));return a;};',
    'if(!Array.prototype.with) Array.prototype.with=function(i,v){var a=this.slice();a[i<0?a.length+i:i]=v;return a;};',
    'if(!Array.prototype.findLast) Array.prototype.findLast=function(fn){for(var i=this.length-1;i>=0;i--){if(fn(this[i],i,this))return this[i];}return undefined;};',
    'if(!Array.prototype.findLastIndex) Array.prototype.findLastIndex=function(fn){for(var i=this.length-1;i>=0;i--){if(fn(this[i],i,this))return i;}return -1;};',
    'if(!Array.fromAsync) Array.fromAsync=function(iterable,mapFn){return Promise.resolve().then(function(){var r=[];for(var v of iterable){if(mapFn)r.push(mapFn(v));else r.push(v);}return r;});};',
    // String ES2021+ methods
    'if(!String.prototype.replaceAll) String.prototype.replaceAll=function(s,r){return this.split(s).join(typeof r==="function"?r(s):r);};',
    'if(!String.prototype.trimStart) String.prototype.trimStart=function(){return this.replace(/^\\s+/,"");};',
    'if(!String.prototype.trimEnd) String.prototype.trimEnd=function(){return this.replace(/\\s+$/,"");};',
    // Object.fromEntries (ES2019)
    'if(!Object.fromEntries) Object.fromEntries=function(it){var o={};for(var e of it)o[e[0]]=e[1];return o;};',
    // Error.cause support
    'if(!("cause" in new Error())) { var _NativeError=Error; Error=function(m,o){var e=new _NativeError(m);if(o&&o.cause!==undefined)e.cause=o.cause;return e;};Error.prototype=_NativeError.prototype;Error.captureStackTrace=_NativeError.captureStackTrace;} ',
    // Iterator helpers (TC39 stage 3+, used by some frameworks)
    'if(typeof Iterator!=="undefined"&&!Iterator.prototype.toArray){try{Iterator.prototype.toArray=function(){var r=[];for(var v of this)r.push(v);return r;};Iterator.prototype.map=function(f){var self=this;return{[Symbol.iterator]:function(){return self;},next:function(){var n=self.next();return n.done?n:{done:false,value:f(n.value)};},toArray:Iterator.prototype.toArray};}{}}catch(_){}}',
    // WeakRef shim if missing
    'if(typeof WeakRef==="undefined"){ var WeakRef=function(o){this._r=o;}; WeakRef.prototype.deref=function(){return this._r;}; }',
    // FinalizationRegistry shim  
    'if(typeof FinalizationRegistry==="undefined"){ var FinalizationRegistry=function(){}; FinalizationRegistry.prototype.register=function(){}; FinalizationRegistry.prototype.unregister=function(){}; }',
    // queueMicrotask double-define guard
    'if(typeof queueMicrotask==="undefined") var queueMicrotask=function(fn){Promise.resolve().then(fn);};',
    // window.postMessage — dispatch a MessageEvent asynchronously on the global scope
    'var _msgListeners=[];',
    'var postMessage=function(data,targetOrigin,transfer){',
    '  setTimeout(function(){',
    '    var init={data:data,origin:typeof location!=="undefined"?location.origin:"",source:globalThis,lastEventId:"",ports:transfer||[]};',
    '    var ev;',
    '    try{ev=new MessageEvent("message",init);}catch(_){ev=Object.assign(Object.create({type:"message",bubbles:false,cancelable:false}),init);}',
    '    if(typeof onmessage==="function")try{onmessage(ev);}catch(_){}',
    '    for(var _i=0;_i<_msgListeners.length;_i++)try{_msgListeners[_i](ev);}catch(_){}',
    '  },0);',
    '};',
    // Patch globalThis.addEventListener to intercept "message" listeners for postMessage
    '(function(){',
    '  var _origAEL = typeof addEventListener !== "undefined" ? addEventListener : null;',
    '  var _origREL = typeof removeEventListener !== "undefined" ? removeEventListener : null;',
    '  globalThis.addEventListener = function(type, fn, opts) {',
    '    if(type==="message") { if(fn && _msgListeners.indexOf(fn)<0) _msgListeners.push(fn); return; }',
    '    if(_origAEL) _origAEL.call(this, type, fn, opts);',
    '  };',
    '  globalThis.removeEventListener = function(type, fn, opts) {',
    '    if(type==="message") { var i=_msgListeners.indexOf(fn); if(i>=0)_msgListeners.splice(i,1); return; }',
    '    if(_origREL) _origREL.call(this, type, fn, opts);',
    '  };',
    '})();',
    // MessageChannel / MessagePort
    'if(typeof MessageChannel==="undefined"){',
    '  var MessagePort=function(){this._listeners=[];this._other=null;this.onmessage=null;};',
    '  MessagePort.prototype.postMessage=function(data){',
    '    var self=this; var other=this._other;',
    '    if(other) setTimeout(function(){',
    '      var ev={type:"message",data:data,ports:[]};',
    '      if(typeof other.onmessage==="function")try{other.onmessage(ev);}catch(_){}',
    '      for(var i=0;i<other._listeners.length;i++)try{other._listeners[i](ev);}catch(_){}',
    '    },0);',
    '  };',
    '  MessagePort.prototype.start=function(){};',
    '  MessagePort.prototype.close=function(){this._other=null;};',
    '  MessagePort.prototype.addEventListener=function(t,fn){if(t==="message"&&fn&&this._listeners.indexOf(fn)<0)this._listeners.push(fn);};',
    '  MessagePort.prototype.removeEventListener=function(t,fn){var i=this._listeners.indexOf(fn);if(i>=0)this._listeners.splice(i,1);};',
    '  var MessageChannel=function(){',
    '    this.port1=new MessagePort(); this.port2=new MessagePort();',
    '    this.port1._other=this.port2; this.port2._other=this.port1;',
    '  };',
    '}',
    // BroadcastChannel
    'if(typeof BroadcastChannel==="undefined"){',
    '  var _bcChannels={};',
    '  var BroadcastChannel=function(name){',
    '    this.name=name; this.onmessage=null; this._listeners=[];',
    '    (_bcChannels[name]||(_bcChannels[name]=[])).push(this);',
    '  };',
    '  BroadcastChannel.prototype.postMessage=function(data){',
    '    var name=this.name,self=this,chs=_bcChannels[name]||[];',
    '    setTimeout(function(){',
    '      for(var i=0;i<chs.length;i++){',
    '        if(chs[i]===self)continue;',
    '        var ev={type:"message",data:data};',
    '        if(typeof chs[i].onmessage==="function")try{chs[i].onmessage(ev);}catch(_){}',
    '        for(var j=0;j<chs[i]._listeners.length;j++)try{chs[i]._listeners[j](ev);}catch(_){}',
    '      }',
    '    },0);',
    '  };',
    '  BroadcastChannel.prototype.close=function(){var chs=_bcChannels[this.name]||[];var i=chs.indexOf(this);if(i>=0)chs.splice(i,1);};',
    '  BroadcastChannel.prototype.addEventListener=function(t,fn){if(t==="message"&&fn&&this._listeners.indexOf(fn)<0)this._listeners.push(fn);};',
    '  BroadcastChannel.prototype.removeEventListener=function(t,fn){var i=this._listeners.indexOf(fn);if(i>=0)this._listeners.splice(i,1);};',
    '}'
  ].join('\n');

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
  var _rerenderCount = 0;
  function doRerender(): void {
    needsRerender = false;
    // Update title if changed
    if (doc.title) cb.setTitle(doc.title);
    var _bodyTokens = vdocToTokens(doc);
    _rerenderCount++;
    cb.rerender(_bodyTokens);
    // Rebuild the DOM from the new HTML so subsequent JS keeps working
    // (we keep the existing doc object but sync values back from serialized form)
  }

  // ── CORS (Cross-Origin Resource Sharing) enforcement ─────────────────────
  // Phase 2.1.2: enforce same-origin policy on fetch()/XMLHttpRequest.
  var _pageOrigin: string = '';
  {
    // Extract origin from base URL without using URL class (not available in OS context)
    var _poSchEnd = cb.baseURL.indexOf('://');
    if (_poSchEnd >= 0) {
      var _poScheme = cb.baseURL.slice(0, _poSchEnd);
      var _poRest   = cb.baseURL.slice(_poSchEnd + 3);
      var _poSlash  = _poRest.indexOf('/');
      var _poHost   = _poSlash >= 0 ? _poRest.slice(0, _poSlash) : _poRest;
      // Strip default ports
      if (_poScheme === 'https' && _poHost.endsWith(':443')) _poHost = _poHost.slice(0, -4);
      else if (_poScheme === 'http' && _poHost.endsWith(':80')) _poHost = _poHost.slice(0, -3);
      _pageOrigin = _poScheme + '://' + _poHost;
    }
  }

  /** Check if a URL is same-origin as the current page. */
  function _isSameOrigin(url: string): boolean {
    if (!_pageOrigin) return true; // about:blank etc = all same-origin
    var schEnd = url.indexOf('://');
    if (schEnd < 0) return true; // relative URL = same-origin
    var scheme = url.slice(0, schEnd);
    var rest2  = url.slice(schEnd + 3);
    var slash  = rest2.indexOf('/');
    var host   = slash >= 0 ? rest2.slice(0, slash) : rest2;
    // Strip query/fragment from host
    var qm = host.indexOf('?'); if (qm >= 0) host = host.slice(0, qm);
    var hh = host.indexOf('#'); if (hh >= 0) host = host.slice(0, hh);
    // Strip default ports
    if (scheme === 'https' && host.endsWith(':443')) host = host.slice(0, -4);
    else if (scheme === 'http' && host.endsWith(':80')) host = host.slice(0, -3);
    return (scheme + '://' + host) === _pageOrigin;
  }

  /** Check CORS response headers for a cross-origin fetch/XHR.
   *  Returns true if the response is allowed. */
  function _checkCORS(respHeaders: { get(k: string): string | null }): boolean {
    var acao = respHeaders.get('access-control-allow-origin');
    if (!acao) return false;
    return acao === '*' || acao === _pageOrigin;
  }

  /** Add Origin and Referer headers to outgoing cross-origin requests. */
  function _addCORSHeaders(headers: Record<string, string>, url: string): void {
    if (!_isSameOrigin(url) && _pageOrigin) {
      headers['origin'] = headers['origin'] || _pageOrigin;
    }
    // Referer: the current page URL (stripped of fragment)
    if (cb.baseURL && !headers['referer']) {
      var _ref = cb.baseURL;
      var _hashIdx = _ref.indexOf('#');
      if (_hashIdx >= 0) _ref = _ref.slice(0, _hashIdx);
      headers['referer'] = _ref;
    }
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
    var enctype = ((form as any).enctype || (form as VElement).getAttribute?.('enctype') || 'application/x-www-form-urlencoded').toLowerCase();
    var actionURL = action.startsWith('http') ? action : _resolveURL(action, _baseHref);
    if (method === 'get') {
      actionURL += (actionURL.includes('?') ? '&' : '?') + serialized;
      cb.navigate(actionURL);
    } else {
      var _postBody: string;
      var _postHeaders: Record<string, string>;
      if (enctype === 'multipart/form-data') {
        var _mfd = new FormData_(form as VElement);
        var _mfBoundary = '----JSFormBoundary' + Math.random().toString(36).slice(2);
        var _mfParts: string[] = [];
        for (var _mfField of _mfd._fields) {
          var _mfDisp = 'Content-Disposition: form-data; name="' + _mfField[0] + '"';
          if (_mfField[2] !== undefined) _mfDisp += '; filename="' + _mfField[2] + '"';
          _mfParts.push('--' + _mfBoundary + '\r\n' + _mfDisp + '\r\n\r\n' + _mfField[1] + '\r\n');
        }
        _postBody = _mfParts.join('') + '--' + _mfBoundary + '--\r\n';
        _postHeaders = { 'Content-Type': 'multipart/form-data; boundary=' + _mfBoundary };
      } else if (enctype === 'text/plain') {
        var _tpParts: string[] = [];
        var _tpFd = new FormData_(form as VElement);
        for (var _tpField of _tpFd._fields) _tpParts.push(_tpField[0] + '=' + _tpField[1]);
        _postBody = _tpParts.join('\r\n');
        _postHeaders = { 'Content-Type': 'text/plain' };
      } else {
        _postBody = serialized;
        _postHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
      }
      // POST — use fetchAsync, then navigate if redirect returned
      os.fetchAsync(actionURL, (resp: any) => {
        if (resp && resp.status >= 300 && resp.status < 400 && resp.headers?.location) {
          cb.navigate(resp.headers.location);
        } else if (resp) {
          cb.navigate(actionURL);
        }
      }, { method: 'POST', body: _postBody, headers: _postHeaders });
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
      // SPA route change — prefetch the new URL's likely resources
      try { JITBrowserEngine.prefetchURL(url); } catch(_) {}
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
    userAgent:  'Mozilla/5.0 (JSOS; x86) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform:   'Linux x86_64',
    language:   'en-US',
    languages:  ['en-US', 'en'],
    vendor:     'Google Inc.',
    appName:    'Netscape',
    appVersion: '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    product:    'Gecko',
    productSub: '20030107',
    oscpu:      'Linux i686',
    buildID:    '20181001000000',
    cookieEnabled: true,
    onLine:     true,
    hardwareConcurrency: 1,
    maxTouchPoints: 0,
    geolocation: { getCurrentPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); }, watchPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); return 0; }, clearWatch() {} },
    clipboard: {
      readText(): Promise<string> {
        // Read from WM system clipboard
        try { return Promise.resolve(os.clipboard.read()); } catch (_e) { return Promise.resolve(''); }
      },
      writeText(t: string): Promise<void> {
        try { os.clipboard.write(t); return Promise.resolve(); } catch (_e) { return Promise.resolve(); }
      },
      read(): Promise<unknown[]> {
        // Return as ClipboardItem array
        try {
          var _txt = os.clipboard.read();
          return Promise.resolve([new ClipboardItem_({ 'text/plain': new Blob([_txt], { type: 'text/plain' }) })]);
        } catch (_e) { return Promise.resolve([]); }
      },
      write(items: unknown[]): Promise<void> {
        // Extract first text/plain item and write to clipboard
        try {
          var _item = (items as ClipboardItem_[])[0];
          if (_item && typeof _item.getType === 'function') {
            return _item.getType('text/plain').then(function(blob: Blob) {
              return (blob as any).text ? (blob as any).text() : Promise.resolve('');
            }).then(function(t: string) { os.clipboard.write(t); });
          }
        } catch (_e) {}
        return Promise.resolve();
      },
    },
    permissions: {
      query(desc: { name: string }): Promise<{ state: string; addEventListener(): void; removeEventListener(): void }> {
        // Grant clipboard read/write (we own the clipboard) and push notifications.
        // All other permissions default to 'prompt'.
        var _pname = desc && desc.name ? desc.name.toLowerCase() : '';
        var _state = (_pname === 'clipboard-read' || _pname === 'clipboard-write' ||
                      _pname === 'notifications'  || _pname === 'persistent-storage' ||
                      _pname === 'geolocation') ? 'granted' : 'prompt';
        return Promise.resolve({ state: _state, addEventListener() {}, removeEventListener() {} });
      },
    },
    mediaDevices: {
      getUserMedia(_c: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); },
      getDisplayMedia(_c?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); },
      enumerateDevices(): Promise<unknown[]> { return Promise.resolve([]); },
      getSupportedConstraints(): object { return {}; },
      addEventListener(_t: string, _fn: unknown): void {},
      removeEventListener(_t: string, _fn: unknown): void {},
    },
    get serviceWorker(): any {
      // Lazily returns the ServiceWorkerContainer_ instance (defined later in the closure)
      return _swContainer || {
        ready: new Promise(() => {}), controller: null,
        register() { return Promise.reject(new DOMException('SW not ready', 'InvalidStateError')); },
        getRegistration() { return Promise.resolve(undefined); },
        getRegistrations() { return Promise.resolve([]); },
        addEventListener() {}, removeEventListener() {}, startMessages() {},
      };
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
      // Origin Private File System (OPFS) (Chrome 86+)
      getDirectory(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'OPFS not supported')); },
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
        { brand: 'Not_A Brand', version: '24' },
      ],
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
        var vals: Record<string, unknown> = {
          architecture: 'x86', bitness: '32', model: '', platform: 'Linux',
          platformVersion: '5.15.0', uaFullVersion: '120.0.6099.71',
          fullVersionList: [
            { brand: 'Chromium', version: '120.0.6099.71' },
            { brand: 'Google Chrome', version: '120.0.6099.71' },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
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
    // User Activation API (Chrome 72+)
    userActivation: { hasBeenActive: false, isActive: false },
    hasStorageAccess(): Promise<boolean> { return Promise.resolve(true); },
    requestStorageAccess(): Promise<void> { return Promise.resolve(); },
    // Battery Status API (Chrome 38+)
    getBattery(): Promise<unknown> {
      return Promise.resolve({
        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0,
        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
        addEventListener(_t: string, _fn: unknown): void {},
        removeEventListener(_t: string, _fn: unknown): void {},
      });
    },
    // App Badge API (Chrome 81+)
    setAppBadge(_count?: number): Promise<void> { return Promise.resolve(); },
    clearAppBadge(): Promise<void> { return Promise.resolve(); },
    // Related Apps API (Chrome 80+)
    getInstalledRelatedApps(): Promise<unknown[]> { return Promise.resolve([]); },
    // Media Session API (Chrome 57+)
    mediaSession: {
      metadata: null as any,
      playbackState: 'none' as string,
      setActionHandler(_action: string, _handler: unknown): void {},
      setPositionState(_state?: unknown): void {},
      setMicrophoneActive(_active: boolean): void {},
      setCameraActive(_active: boolean): void {},
    },
    // WebGPU Device API (Chrome 113+) -- stub for feature detection
    gpu: {
      requestAdapter(_opts?: unknown): Promise<null> { return Promise.resolve(null); },
      getPreferredCanvasFormat(): string { return 'bgra8unorm'; },
      wgslLanguageFeatures: new Set<string>(),
    },
    /** Contacts API - Android Chrome 80+, not available on desktop */
    contacts: {
      getProperties(): Promise<string[]> { return Promise.resolve(['name', 'email', 'tel', 'address', 'icon']); },
      select(_props: string[], _opts?: unknown): Promise<unknown[]> { return Promise.reject(new DOMException('Not supported', 'NotSupportedError')); },
    },
  };

  // ── window.screen ─────────────────────────────────────────────────────────

  var screen = {
    width: 1024, height: 768, availWidth: 1024, availHeight: 768,
    availLeft: 0, availTop: 0,
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

  // â”€â”€ ToggleEvent (Chrome 120+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class ToggleEvent extends VEvent {

    oldState: string; newState: string;

    constructor(type: string, init?: { oldState?: string; newState?: string; bubbles?: boolean; cancelable?: boolean }) {

      super(type, init); this.oldState = init?.oldState ?? ''; this.newState = init?.newState ?? '';

    }

  }



  // â”€â”€ Highlight API (Chrome 105+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class Highlight_ extends Set<unknown> {

    priority: number = 0;

    type: string = 'highlight';

  }



  // â”€â”€ CloseWatcher (Chrome 120+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class CloseWatcher_ extends VEventTarget {

    onclose: ((e: VEvent) => void) | null = null;

    oncancel: ((e: VEvent) => void) | null = null;

    requestClose(): void { var e = new VEvent('close'); if (this.onclose) this.onclose(e); }

    close(): void { this.requestClose(); }

    destroy(): void {}

  }



  // â”€â”€ EyeDropper (Chrome 95+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class EyeDropper_ {

    open(_signal?: unknown): Promise<{ sRGBHex: string }> {

      return Promise.reject(new DOMException('NotSupportedError', 'EyeDropper not supported'));

    }

  }



  // â”€â”€ MediaStreamTrack (stub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class MediaStreamTrack_ extends VEventTarget {

    kind: string = 'video'; id: string = ''; label: string = '';

    enabled: boolean = true; muted: boolean = false; readyState: string = 'ended';

    contentHint: string = '';

    onmute: ((e: VEvent) => void) | null = null;

    onunmute: ((e: VEvent) => void) | null = null;

    onended: ((e: VEvent) => void) | null = null;

    stop(): void { this.readyState = 'ended'; }

    getSettings(): object { return {}; }

    getCapabilities(): object { return {}; }

    getConstraints(): object { return {}; }

    applyConstraints(_c?: unknown): Promise<void> { return Promise.resolve(); }

    clone(): MediaStreamTrack_ { return new MediaStreamTrack_(); }

  }



  // â”€â”€ MediaStream (stub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class MediaStream_ extends VEventTarget {

    id: string = Math.random().toString(36).slice(2);

    active: boolean = false;

    _tracks: MediaStreamTrack_[] = [];

    constructor(tracks?: MediaStreamTrack_[]) { super(); if (tracks) this._tracks = [...tracks]; }

    getTracks(): MediaStreamTrack_[] { return [...this._tracks]; }

    getAudioTracks(): MediaStreamTrack_[] { return this._tracks.filter(t => t.kind === 'audio'); }

    getVideoTracks(): MediaStreamTrack_[] { return this._tracks.filter(t => t.kind === 'video'); }

    getTrackById(id: string): MediaStreamTrack_ | null { return this._tracks.find(t => t.id === id) ?? null; }

    addTrack(t: MediaStreamTrack_): void { if (!this._tracks.includes(t)) this._tracks.push(t); }

    removeTrack(t: MediaStreamTrack_): void { this._tracks = this._tracks.filter(x => x !== t); }

    clone(): MediaStream_ { return new MediaStream_(this._tracks.map(t => t.clone())); }

  }



  // â”€â”€ MediaRecorder (stub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class MediaRecorder_ extends VEventTarget {

    state: string = 'inactive'; mimeType: string = '';

    videoBitsPerSecond: number = 0; audioBitsPerSecond: number = 0;

    stream: MediaStream_; ondataavailable: ((e: unknown) => void) | null = null;

    onstop: ((e: VEvent) => void) | null = null;

    onstart: ((e: VEvent) => void) | null = null;

    onerror: ((e: unknown) => void) | null = null;

    onpause: ((e: VEvent) => void) | null = null;

    onresume: ((e: VEvent) => void) | null = null;

    constructor(stream: MediaStream_, _opts?: unknown) { super(); this.stream = stream; }

    start(_timeslice?: number): void { this.state = 'recording'; }

    stop(): void { this.state = 'inactive'; }

    pause(): void { this.state = 'paused'; }

    resume(): void { this.state = 'recording'; }

    requestData(): void {}

    static isTypeSupported(_mime: string): boolean { return false; }

  }



  // â”€â”€ WebTransport (stub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class WebTransport_ {

    readonly ready: Promise<void>;

    readonly closed: Promise<{ closeCode: number; reason: string }>;

    constructor(_url: string, _opts?: unknown) {

      this.ready = Promise.reject(new DOMException('NotSupportedError', 'WebTransport not supported'));

      this.closed = Promise.reject(new DOMException('NotSupportedError', 'WebTransport not supported'));

    }

    close(_info?: unknown): void {}

    createBidirectionalStream(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }

    createUnidirectionalStream(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }

  }



  // â”€â”€ SpeechRecognition (stub) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class SpeechRecognition_ extends VEventTarget {

    lang: string = ''; continuous: boolean = false; interimResults: boolean = false;

    maxAlternatives: number = 1; grammars: any = null;

    onresult: ((e: unknown) => void) | null = null;

    onerror: ((e: unknown) => void) | null = null;

    onend: ((e: VEvent) => void) | null = null;

    onstart: ((e: VEvent) => void) | null = null;

    onnomatch: ((e: unknown) => void) | null = null;

    start(): void {

      setTimeout_(() => {

        if (this.onerror) this.onerror({ error: 'not-allowed', message: 'Speech recognition not supported' });

        if (this.onend) this.onend(new VEvent('end'));

      }, 0);

    }

    stop(): void {} abort(): void {}

  }



  // â”€â”€ SpeechGrammar / SpeechGrammarList (stubs) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class SpeechGrammar_ { src: string = ''; weight: number = 1; }

  class SpeechGrammarList_ {

    _list: SpeechGrammar_[] = [];

    get length(): number { return this._list.length; }

    item(idx: number): SpeechGrammar_ { return this._list[idx]; }

    addFromURI(_src: string, _weight?: number): void {}

    addFromString(_str: string, _weight?: number): void {}

  }



  // â”€â”€ MediaMetadata (Chrome 57+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class MediaMetadata_ {

    title: string; artist: string; album: string; artwork: unknown[];

    constructor(init?: { title?: string; artist?: string; album?: string; artwork?: unknown[] }) {

      this.title = init?.title ?? ''; this.artist = init?.artist ?? '';

      this.album = init?.album ?? ''; this.artwork = init?.artwork ?? [];

    }

  }

  // â”€â”€ PromiseRejectionEvent (Chrome 49+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // URLPattern (Chrome 95+)
  class URLPattern_ {
    hash: string = '*'; hostname: string = '*'; password: string = '*';
    pathname: string = '*'; port: string = '*'; protocol: string = '*';
    search: string = '*'; username: string = '*';
    constructor(input?: string | Record<string,string>, _basePath?: string) {
      if (typeof input === 'object' && input) { Object.assign(this, input); }
    }
    test(_input?: string | Record<string,string>): boolean { return false; }
    exec(_input?: string | Record<string,string>): unknown { return null; }
  }

  class PromiseRejectionEvent extends VEvent {

    promise: Promise<unknown>; reason: unknown;

    constructor(type: string, init: { promise: Promise<unknown>; reason: unknown; bubbles?: boolean; cancelable?: boolean }) {

      super(type, init); this.promise = init.promise; this.reason = init.reason;

    }

  }



  // â”€â”€ FormDataEvent (Chrome 77+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class FormDataEvent extends VEvent {

    formData: FormData_;

    constructor(type: string, init: { formData: FormData_; bubbles?: boolean; cancelable?: boolean }) {

      super(type, init); this.formData = init.formData;

    }

  }



  // â”€â”€ DeviceMotionEvent / DeviceOrientationEvent (sensor APIs) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class DeviceMotionEvent extends VEvent {

    acceleration: unknown = null; accelerationIncludingGravity: unknown = null;

    rotationRate: unknown = null; interval: number = 0;

    constructor(type: string, init?: any) { super(type, init); Object.assign(this, init ?? {}); }

    static requestPermission(): Promise<string> { return Promise.resolve('denied'); }

  }

  class DeviceOrientationEvent extends VEvent {

    alpha: number | null = null; beta: number | null = null; gamma: number | null = null; absolute: boolean = false;

    constructor(type: string, init?: any) { super(type, init); Object.assign(this, init ?? {}); }

    static requestPermission(): Promise<string> { return Promise.resolve('denied'); }

  }



  // â”€â”€ ViewTransition (Chrome 111+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  class ViewTransition_ {

    ready: Promise<void> = Promise.resolve();

    finished: Promise<void> = Promise.resolve();

    updateCallbackDone: Promise<void> = Promise.resolve();

    skipTransition(): void {}

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
      for (var fn of arr) {
        _callGuarded(fn, ev);
      }
      return !ev.defaultPrevented;
    }
  }

  // ── CSS object (item 553) ──────────────────────────────────────────────────

  /** CSS Houdini Properties & Values API Level 1 — @property rule registry. */
  var _cssPropertyRegistry = new Map<string, { syntax: string; inherits: boolean; initialValue: string }>();

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
    registerProperty(descriptor: { name: string; syntax?: string; inherits: boolean; initialValue?: string }): void {
      if (descriptor && descriptor.name && descriptor.name.startsWith('--')) {
        _cssPropertyRegistry.set(descriptor.name, {
          syntax: descriptor.syntax || '*',
          inherits: descriptor.inherits !== false,
          initialValue: descriptor.initialValue ?? '',
        });
      }
    },
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

      // ── Service Worker fetch intercept (Phase 6.7) ────────────────────────────
      if (_swActiveScope) {
        try {
          var _swReq = new Request_(urlStr, opts as any);
          var _swRespP = (_swActiveScope as ServiceWorkerGlobalScope_)._interceptFetch(_swReq);
          if (_swRespP !== null) {
            // SW called respondWith() — use its promise as the fetch result
            _swRespP.then(resolve as (v: unknown) => void, reject);
            return;
          }
        } catch (_swErr) { /* SW handler threw — fall through to network */ }
      }

      var method = (opts?.method || 'GET').toUpperCase();
      var extraHeaders: Record<string, string> = {};
      if (opts?.headers) {
        if (opts.headers instanceof Headers_) opts.headers.forEach((v: string, k: string) => { extraHeaders[k] = v; });
        else Object.assign(extraHeaders, opts.headers);
      }
      var bodyStr: string | undefined;
      if (opts?.body) {
        if (opts.body instanceof FormData_) {
          // Per Fetch spec: FormData body uses multipart/form-data encoding (item 2.10)
          var _boundary = '----JSFormBoundary' + Math.random().toString(36).slice(2);
          var _parts: string[] = [];
          for (var _fdEntry of opts.body._fields) {
            var _fdName = _fdEntry[0], _fdVal = _fdEntry[1], _fdFilename = _fdEntry[2];
            var _dispHdr = 'Content-Disposition: form-data; name="' + _fdName + '"';
            if (_fdFilename !== undefined) {
              _dispHdr += '; filename="' + _fdFilename + '"';
              _parts.push('--' + _boundary + '\r\n' + _dispHdr + '\r\nContent-Type: application/octet-stream\r\n\r\n' + _fdVal + '\r\n');
            } else {
              _parts.push('--' + _boundary + '\r\n' + _dispHdr + '\r\n\r\n' + _fdVal + '\r\n');
            }
          }
          bodyStr = _parts.join('') + '--' + _boundary + '--\r\n';
          extraHeaders['content-type'] = extraHeaders['content-type'] ||
            'multipart/form-data; boundary=' + _boundary;
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

      // CORS: add Origin and Referer headers for cross-origin requests
      _addCORSHeaders(extraHeaders, urlStr);
      var _fetchCrossOrigin = !_isSameOrigin(urlStr);
      var _fetchMode = opts?.mode || (_fetchCrossOrigin ? 'cors' : 'same-origin');

      // CSP connect-src enforcement
      if (cspPolicy && !cspAllows(cspPolicy, 'connect-src', urlStr, _pageOrigin, false, false)) {
        logCSPViolation('connect-src', urlStr, cb.baseURL);
        reject(new TypeError('[CSP] blocked fetch to ' + urlStr));
        return;
      }

      var aborted = false;
      if (signal) {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason ?? new Error('AbortError')); });
      }
      // Use deduplicated fetch for GET requests to avoid redundant network I/O
      // (SPAs with code-splitting, React.lazy, Suspense trigger duplicate GETs)
      var _fetchFn = (method === 'GET' && JITBrowserEngine.ready)
        ? JITBrowserEngine.deduplicatedFetch
        : (u: string, c: (r: any, e?: string) => void, o?: any) => os.fetchAsync(u, c, o);
      _fetchFn(urlStr, (resp: FetchResponse | null, err?: string) => {
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
          type: _fetchCrossOrigin ? 'cors' : 'basic',
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
        // CORS enforcement: cross-origin responses without CORS headers are blocked
        if (_fetchCrossOrigin && _fetchMode !== 'no-cors' && !_checkCORS(respHeaders)) {
          reject(new TypeError('CORS error: no Access-Control-Allow-Origin header on ' + urlStr));
          return;
        }
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
      if (this.onreadystatechange) _callGuarded(this.onreadystatechange, { target: this });
    }

    send(body?: string | FormData_ | null): void {
      if (this._aborted) return;
      var self = this;
      try { if (self.onloadstart) self.onloadstart({ target: self }); } catch(_) {}
      var lsListeners = self._listeners.get('loadstart');
      if (lsListeners) for (var _lsf of lsListeners) try { _lsf({ target: self }); } catch(_) {}
      var bodyStr: string | undefined;
      if (body instanceof FormData_) {
        var pairs: string[] = [];
        body.forEach((v, k) => pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)));
        bodyStr = pairs.join('&');
        self._headers['content-type'] = self._headers['content-type'] || 'application/x-www-form-urlencoded';
      } else if (body) { bodyStr = String(body); }

      // Inject stored cookies (same as fetch API does)
      try {
        var _xhrU = new URL(self._url);
        var _xhrCk = cookieJar.getCookieHeader(_xhrU.hostname, _xhrU.pathname, _xhrU.protocol === 'https:');
        if (_xhrCk) self._headers['cookie'] = self._headers['cookie'] || _xhrCk;
      } catch (_) {}

      // CORS: add Origin/Referer headers for cross-origin XHR
      _addCORSHeaders(self._headers, self._url);
      var _xhrCrossOrigin = !_isSameOrigin(self._url);

      // CSP connect-src enforcement for XHR
      if (cspPolicy && !cspAllows(cspPolicy, 'connect-src', self._url, _pageOrigin, false, false)) {
        logCSPViolation('connect-src', self._url, cb.baseURL);
        self.status = 0;
        try { if (self.onerror) self.onerror({ target: self }); } catch(_) {}
        return;
      }

      // Timeout enforcement: abort and fire ontimeout if response takes too long
      var _xhrTimer: any = null;
      if (self.timeout > 0) {
        _xhrTimer = setTimeout(() => {
          if (self._aborted) return;
          self._aborted = true;
          self.status = 0;
          var toEv = { target: self };
          try { if (self.ontimeout) self.ontimeout(toEv); } catch(_) {}
          var toListeners = self._listeners.get('timeout');
          if (toListeners) for (var _tf of toListeners) try { _tf(toEv); } catch(_) {}
          try { if (self.onloadend) self.onloadend(toEv); } catch(_) {}
          var leListeners = self._listeners.get('loadend');
          if (leListeners) for (var _lef2 of leListeners) try { _lef2(toEv); } catch(_) {}
        }, self.timeout);
      }

      os.fetchAsync(this._url, (resp: FetchResponse | null, _err?: string) => {
        if (_xhrTimer !== null) { clearTimeout(_xhrTimer); _xhrTimer = null; }
        if (self._aborted) return;
        if (resp) {
          self.status = resp.status; self.statusText = String(resp.status);
          self.responseURL = self._url;
          resp.headers.forEach((v: string, k: string) => { self._responseHeaders[k.toLowerCase()] = v; });
          // CORS: block cross-origin XHR responses without CORS headers
          if (_xhrCrossOrigin && !_checkCORS({ get: (k: string) => self._responseHeaders[k.toLowerCase()] ?? null })) {
            self.status = 0; self._setState(4);
            var corsErr = { target: self };
            try { if (self.onerror) self.onerror(corsErr); } catch(_) {}
            var corsErrListeners = self._listeners.get('error');
            if (corsErrListeners) for (var _cef of corsErrListeners) try { _cef(corsErr); } catch(_) {}
            return;
          }
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
          var pgListeners = self._listeners.get('progress');
          if (pgListeners) for (var _pgf of pgListeners) try { _pgf(ev); } catch(_) {}
          try { if (self.onload)      self.onload(ev); }      catch(_) {}
          var ldListeners = self._listeners.get('load');
          if (ldListeners) for (var _ldf of ldListeners) try { _ldf(ev); } catch(_) {}
          try { if (self.onloadend)   self.onloadend(ev); }   catch(_) {}
          var leListeners2 = self._listeners.get('loadend');
          if (leListeners2) for (var _lef3 of leListeners2) try { _lef3(ev); } catch(_) {}
        } else {
          self.status = 0; self._setState(4);
          var errEv = { target: self };
          try { if (self.onerror)   self.onerror(errEv); } catch(_) {}
          var errListeners = self._listeners.get('error');
          if (errListeners) for (var _ef of errListeners) try { _ef(errEv); } catch(_) {}
          try { if (self.onloadend) self.onloadend(errEv); } catch(_) {}
          var leListeners3 = self._listeners.get('loadend');
          if (leListeners3) for (var _lef4 of leListeners3) try { _lef4(errEv); } catch(_) {}
        }
        var rsListeners = self._listeners.get('readystatechange');
        if (rsListeners) for (var fn of rsListeners) try { fn({ target: self }); } catch(_) {}
      }, { method: this._method, headers: this._headers, body: bodyStr });
    }

    abort(): void {
      this._aborted = true; this.status = 0; this.readyState = 0;
      var ev = { target: this };
      try { if (this.onabort)   this.onabort(ev); }   catch(_) {}
      try { if (this.onloadend) this.onloadend(ev); }  catch(_) {}
    }

    addEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      // Only push to the _listeners array; never overwrite the on* shortcut
      // properties — those may be set independently by the page and both must fire.
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
      } else if (b instanceof MediaSource_) {
        // Store MediaSource reference; fire 'sourceopen' async so video.src=url works
        _blobStore.set(url, { content: '', type: 'mediasource', _ms: b } as any);
        Promise.resolve().then(() => {
          b.readyState = 'open';
          b.dispatchEvent(new VEvent('sourceopen'));
        });
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
    stream(): ReadableStream_ {
      var content = this._parts.join('');
      // Return a ReadableStream that yields the blob content as a Uint8Array chunk
      var _done = false;
      var bytes = new Uint8Array(content.length);
      for (var _bi = 0; _bi < content.length; _bi++) bytes[_bi] = content.charCodeAt(_bi) & 0xff;
      return new ReadableStream_({ start(ctrl: any) { ctrl.enqueue(bytes); ctrl.close(); } });
    }
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
      var on = (this as any)['on' + type]; if (typeof on === 'function') _callGuarded(on, ev);
      var lst = this._listeners.get(type); if (lst) for (var fn of lst) _callGuarded(fn, ev);
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
      _callGuardedCtx('mutation(' + r.length + ')', this._fn, r, this);
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
    _prevState = new WeakMap<VElement, { intersecting: boolean; ratio: number }>();
    constructor(fn: (entries: unknown[], obs: IntersectionObserverImpl) => void, opts?: { threshold?: number }) {
      this._fn = fn; this._threshold = opts?.threshold ?? 0;
    }
    observe(el: unknown): void {
      if (el instanceof VElement) {
        if (!this._elements.includes(el)) this._elements.push(el);
        if (!_ioObservers.includes(this)) _ioObservers.push(this);
        // Fire initial entry on next tick (browsers always deliver initial state)
        var self = this;
        setTimeout_(function() {
          var vH = ((win['innerHeight'] as number) || 768);
          var vW = ((win['innerWidth']  as number) || 1024);
          self._tickOne(el as VElement, vH, vW, true /* force initial fire */);
        }, 0);
      }
    }
    unobserve(el: unknown): void {
      this._elements = this._elements.filter(e => e !== el);
      if (el instanceof VElement) this._prevState.delete(el);
    }
    disconnect(): void {
      this._elements = [];
      var _ii = _ioObservers.indexOf(this);
      if (_ii >= 0) _ioObservers.splice(_ii, 1);
    }
    _tickOne(el: VElement, viewportH: number, viewportW: number, forceInitial = false): void {
      var rect = el.getBoundingClientRect?.() ?? { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 };
      var intersecting = rect.bottom > 0 && rect.top < viewportH &&
                         rect.right  > 0 && rect.left < viewportW;
      var iTop    = Math.max(rect.top,    0);
      var iBottom = Math.min(rect.bottom, viewportH);
      var iLeft   = Math.max(rect.left,   0);
      var iRight  = Math.min(rect.right,  viewportW);
      var iArea   = (iBottom > iTop && iRight > iLeft) ? (iBottom - iTop) * (iRight - iLeft) : 0;
      var elArea  = (rect.height * rect.width) || 1;
      var ratio   = Math.min(1, iArea / elArea);
      var threshold = this._threshold || 0;
      var isAbove   = ratio >= threshold;
      var prev      = this._prevState.get(el);
      // Only fire if state changed, or if this is the initial observation
      if (!forceInitial && prev && prev.intersecting === isAbove) return;
      this._prevState.set(el, { intersecting: isAbove, ratio });
      _callGuardedCtx('intersection', this._fn, [{
        isIntersecting: isAbove,
        intersectionRatio: ratio,
        boundingClientRect: rect,
        intersectionRect:   { top: iTop, left: iLeft, bottom: iBottom, right: iRight, width: iRight - iLeft, height: iBottom - iTop },
        rootBounds:         { top: 0, left: 0, bottom: viewportH, right: viewportW, width: viewportW, height: viewportH },
        target: el,
        time: _perf.now(),
      }], this);
    }
    /** Called by tick to fire entries for elements whose intersection state has changed. */
    _tick(viewportH: number, viewportW = 1024): void {
      for (var el of this._elements) this._tickOne(el, viewportH, viewportW);
    }
  }

  var _ioObservers: IntersectionObserverImpl[] = [];

  // ── ResizeObserver ────────────────────────────────────────────────────────

  class ResizeObserverImpl {
    _fn:       (entries: unknown[]) => void;
    _elements: VElement[] = [];
    _lastSizes = new WeakMap<VElement, { w: number; h: number }>();
    constructor(fn: (entries: unknown[]) => void) { this._fn = fn; }
    observe(el: unknown): void   {
      if (el instanceof VElement) {
        if (!this._elements.includes(el)) this._elements.push(el);
        // Register in the global tick list (idempotent)
        if (!_roObservers.includes(this)) _roObservers.push(this);
        // Fire initial callback on next tick (browsers always deliver one entry on observe)
        var self = this;
        setTimeout_(function() {
          var r = (el as VElement).getBoundingClientRect?.() ?? { width: 0, height: 0, top: 0, left: 0, right: 200, bottom: 20, x: 0, y: 0 };
          self._lastSizes.set(el as VElement, { w: r.width, h: r.height });
          try { self._fn([{ target: el, contentRect: r,
            borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }],
            contentBoxSize:[{ inlineSize: r.width, blockSize: r.height }] }]); } catch (_) {}
        }, 0);
      }
    }
    unobserve(el: unknown): void { this._elements = this._elements.filter(e => e !== el); }
    disconnect(): void {
      this._elements = [];
      var _ri = _roObservers.indexOf(this);
      if (_ri >= 0) _roObservers.splice(_ri, 1);
    }
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
      if (entries.length > 0) _callGuardedCtx('resize(' + entries.length + ')', this._fn, entries);
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
      for (var fn of this._listeners) _callGuardedCtx('mql', fn, ev);
    }
    static timeout(ms: number): AbortSignalImpl {
      var s = new AbortSignalImpl();
      setTimeout_(() => s._abort(new DOMException('TimeoutError', 'TimeoutError')), ms);
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
    _txn: IDBTransaction_ | null = null; // back-ref for oncomplete tracking
    _succeed(r: unknown): void { this.result = r; this.readyState = 'done'; if (this.onsuccess) setTimeout(() => { try { this.onsuccess!({ target: this }); } catch(_) {} }, 0); this._txn?._requestDone(); }
    _fail(e: Error): void { this.error = e; this.readyState = 'done'; if (this.onerror) setTimeout(() => { try { this.onerror!({ target: this }); } catch(_) {} }, 0); this._txn?._requestDone(); }
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (type === 'success') this.onsuccess = fn; if (type === 'error') this.onerror = fn; }
    removeEventListener(): void {}
  }

  /** IDBKeyRange — wraps a lower/upper bound pair for IndexedDB cursor filtering */
  class IDBKeyRange_ {
    lower: unknown; upper: unknown; lowerOpen: boolean; upperOpen: boolean;
    constructor(lower: unknown, upper: unknown, lowerOpen: boolean, upperOpen: boolean) {
      this.lower = lower; this.upper = upper; this.lowerOpen = lowerOpen; this.upperOpen = upperOpen;
    }
    includes(key: unknown): boolean {
      if (this.lower !== undefined) {
        var cmpL = _idbCmp(key, this.lower);
        if (cmpL < 0 || (cmpL === 0 && this.lowerOpen)) return false;
      }
      if (this.upper !== undefined) {
        var cmpU = _idbCmp(key, this.upper);
        if (cmpU > 0 || (cmpU === 0 && this.upperOpen)) return false;
      }
      return true;
    }
    static only(v: unknown): IDBKeyRange_ { return new IDBKeyRange_(v, v, false, false); }
    static lowerBound(v: unknown, open = false): IDBKeyRange_ { return new IDBKeyRange_(v, undefined, open, false); }
    static upperBound(v: unknown, open = false): IDBKeyRange_ { return new IDBKeyRange_(undefined, v, false, open); }
    static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): IDBKeyRange_ {
      return new IDBKeyRange_(lower, upper, lowerOpen, upperOpen);
    }
  }
  /** IDB key comparison: numbers < dates < strings < binary */
  function _idbCmp(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    var sa = typeof a === 'string' ? a : String(a);
    var sb = typeof b === 'string' ? b : String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  /** Return true if key satisfies range (null range = all keys pass) */
  function _idbInRange(key: unknown, range: unknown): boolean {
    if (!range || !(range instanceof IDBKeyRange_)) return true;
    return range.includes(key);
  }

  class IDBObjectStore_ {
    _name: string; _db: IDBDatabase_; _data: Map<unknown, unknown>; _txn: IDBTransaction_ | null = null;
    constructor(name: string, db: IDBDatabase_, txn?: IDBTransaction_) { this._name = name; this._db = db; this._data = db._stores.get(name) ?? new Map(); db._stores.set(name, this._data); this._txn = txn ?? null; }
    _req(): IDBRequest_ { var r = new IDBRequest_(); r._txn = this._txn; if (this._txn) this._txn._pending++; return r; }
    put(value: unknown, key?: unknown): IDBRequest_ { var r = this._req(); var k = key ?? (typeof value === 'object' && value ? (value as any)[this._db._keyPaths.get(this._name) ?? 'id'] : undefined) ?? Date.now(); this._data.set(k, value); r._succeed(k); return r; }
    add(value: unknown, key?: unknown): IDBRequest_ { return this.put(value, key); }
    get(key: unknown): IDBRequest_ { var r = this._req(); r._succeed(this._data.get(key)); return r; }
    getAll(range?: unknown, count?: unknown): IDBRequest_ { var r = this._req(); var maxN = typeof count === 'number' ? count : Infinity; var vals: unknown[] = []; this._data.forEach((v, k) => { if (vals.length < maxN && _idbInRange(k, range)) vals.push(v); }); r._succeed(vals); return r; }
    getAllKeys(range?: unknown, count?: unknown): IDBRequest_ { var r = this._req(); var maxN = typeof count === 'number' ? count : Infinity; var keys: unknown[] = []; this._data.forEach((_v, k) => { if (keys.length < maxN && _idbInRange(k, range)) keys.push(k); }); r._succeed(keys); return r; }
    delete(key: unknown): IDBRequest_ { var r = this._req(); this._data.delete(key); r._succeed(undefined); return r; }
    clear(): IDBRequest_ { var r = this._req(); this._data.clear(); r._succeed(undefined); return r; }
    count(range?: unknown): IDBRequest_ { var r = this._req(); var n = 0; this._data.forEach((_v, k) => { if (_idbInRange(k, range)) n++; }); r._succeed(n); return r; }
    index(name: string): IDBIndex_ { return new IDBIndex_(name, this._db, this._txn); }
    openCursor(range?: unknown, dir?: string): IDBRequest_ {
      var r = this._req();
      var entries = [...this._data.entries()].filter(([k]) => _idbInRange(k, range));
      if (dir === 'prev' || dir === 'prevunique') entries.reverse();
      var i = 0;
      function _makeCursor(): unknown {
        if (i >= entries.length) return null;
        var [k, v] = entries[i]!;
        return { key: k, primaryKey: k, value: v,
          continue() { i++; r.result = _makeCursor(); if (r.onsuccess) setTimeout(() => r.onsuccess!({ target: r }), 0); },
          advance(n: number) { i += n; r.result = _makeCursor(); if (r.onsuccess) setTimeout(() => r.onsuccess!({ target: r }), 0); },
          update(newVal: unknown): IDBRequest_ { entries[i]![1] = newVal; entries[i] && r['_storeRef']?.put(newVal, k); return new IDBRequest_(); },
          delete(): IDBRequest_ { entries.splice(i, 1); return new IDBRequest_(); },
        };
      }
      r.result = _makeCursor();
      setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
      return r;
    }
    openKeyCursor(range?: unknown, dir?: string): IDBRequest_ { return this.openCursor(range, dir); }
    createIndex(name: string, _keyPath: string, _opts?: unknown): IDBIndex_ { return new IDBIndex_(name, this._db, this._txn); }
  }

  class IDBIndex_ {
    _name: string; _db: IDBDatabase_; _txn: IDBTransaction_ | null;
    constructor(name: string, db: IDBDatabase_, txn?: IDBTransaction_ | null) { this._name = name; this._db = db; this._txn = txn ?? null; }
    get(key: unknown): IDBRequest_ { var r = new IDBRequest_(); r._txn = this._txn; if (this._txn) this._txn._pending++;
      // Search all stores for matching indexed key
      var found: unknown = undefined;
      this._db._stores.forEach(m => { m.forEach((v: unknown) => { if (typeof v === 'object' && v && (v as any)[this._name] === key && found === undefined) found = v; }); });
      r._succeed(found); return r; }
    getAll(_range?: unknown): IDBRequest_ { var r = new IDBRequest_(); r._txn = this._txn; if (this._txn) this._txn._pending++;
      var all: unknown[] = [];
      this._db._stores.forEach(m => { m.forEach((v: unknown) => { if (typeof v === 'object' && v && Object.prototype.hasOwnProperty.call(v, this._name)) all.push(v); }); });
      r._succeed(all); return r; }
    openCursor(_range?: unknown): IDBRequest_ { var r = new IDBRequest_(); r._txn = this._txn; if (this._txn) this._txn._pending++;
      r.result = null; setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0); return r; }
    count(): IDBRequest_ { var r = new IDBRequest_(); r._txn = this._txn; if (this._txn) this._txn._pending++; r._succeed(0); return r; }
  }

  class IDBTransaction_ {
    _db: IDBDatabase_; _mode: string; _pending = 0; _fireScheduled = false;
    constructor(db: IDBDatabase_, _storeNames: string[], mode: string) { this._db = db; this._mode = mode; }
    objectStore(name: string): IDBObjectStore_ { return new IDBObjectStore_(name, this._db, this); }
    oncomplete: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onabort: ((ev: unknown) => void) | null = null;
    _requestDone(): void {
      this._pending = Math.max(0, this._pending - 1);
      if (this._pending === 0 && !this._fireScheduled) {
        this._fireScheduled = true;
        // Use a 0-delay timeout so all same-tick onsuccess handlers run first
        setTimeout(() => {
          if (this.oncomplete) try { this.oncomplete({ target: this }); } catch(_) {}
        }, 0);
      }
    }
    abort(): void { if (this.onabort) try { this.onabort({ target: this }); } catch(_) {} }
    commit(): void { if (this.oncomplete) try { this.oncomplete({ target: this }); } catch(_) {} }
    addEventListener(type: string, fn: (ev: unknown) => void): void { if (type === 'complete') this.oncomplete = fn; if (type === 'error') this.onerror = fn; if (type === 'abort') this.onabort = fn; }
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
    Segmenter: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      segment(str: string): Iterable<{ segment: string; index: number; input: string }> {
        // Grapheme cluster approximation: split into individual characters
        var chars = [...str];
        var idx = 0;
        var segs = chars.map(ch => {
          var s = { segment: ch, index: idx, input: str };
          idx += ch.length;
          return s;
        });
        return { [Symbol.iterator]() { var i = 0; return { next() { return i < segs.length ? { value: segs[i++], done: false } : { value: undefined, done: true }; } }; } } as any;
      }
      resolvedOptions(): object { return { locale: 'en', granularity: 'grapheme' }; }
      static supportedLocalesOf(): string[] { return ['en']; }
    },
    DisplayNames: class {
      _opts: any;
      constructor(_loc?: unknown, opts?: any) { this._opts = opts || {}; }
      of(code: string): string | undefined { return code; }
      resolvedOptions(): object { return { locale: 'en', style: 'long', type: this._opts?.type || 'region', fallback: 'code' }; }
      static supportedLocalesOf(): string[] { return ['en']; }
    },
    DurationFormat: class {
      constructor(_loc?: unknown, _opts?: unknown) {}
      format(d: Record<string, number>): string { return JSON.stringify(d); }
      formatToParts(_d: unknown): Array<{type: string; value: string}> { return []; }
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
    /** @layer ordering — names in cascade order (earlier = lower priority) */
    _layerOrder?: string[];

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
        } else if (lhdr.startsWith('@property')) {
          // CSS Houdini @property rule — register in _cssPropertyRegistry for var() fallbacks
          var _propName = lhdr.replace('@property', '').trim();
          if (_propName.startsWith('--')) {
            var _propBody = body2.trim();
            var _syntax   = (_propBody.match(/syntax\s*:\s*["']?([^;'"]+)["']?\s*;/) || [])[1] || '*';
            var _inherits = /inherits\s*:\s*true/i.test(_propBody);
            var _initVal  = (_propBody.match(/initial-value\s*:\s*([^;]+)\s*;/) || [])[1] || '';
            _cssPropertyRegistry.set(_propName, {
              syntax: _syntax.trim(),
              inherits: _inherits,
              initialValue: _initVal.trim(),
            });
          }
        } else if (!lhdr.startsWith('@')) {
          // CSS nesting: if body2 contains nested {} blocks, flatten them
          if (body2.indexOf('{') >= 0) {
            this._flattenNested(hdr, body2.trim());
          } else {
            var sr2 = new CSSStyleRule_(hdr, body2.trim()); sr2.parentStyleSheet = this; this.cssRules.push(sr2); this._idxRule(sr2);
          }
        }
      }
      bumpStyleGeneration(); // item 944 — new rules indexed, invalidate computed style cache
    }

    /** Flatten CSS nesting: `parent { decls; & .child { decls2 } }` → flat rules.
     *  Handles `&` combinator and implicit descendant combinator (item 948). */
    _flattenNested(parentSel: string, body: string): void {
      var declBuf = '';
      var i = 0;
      while (i < body.length) {
        // Find next `{` at depth-0 (which starts a nested rule)
        var nest = -1;
        var tempDepth = 0;
        for (var ti = i; ti < body.length; ti++) {
          if (body[ti] === '{') { if (tempDepth === 0) { nest = ti; break; } tempDepth++; }
          else if (body[ti] === '}') { if (tempDepth > 0) tempDepth--; }
        }
        if (nest < 0) {
          // No more nested blocks — rest is declarations
          declBuf += body.slice(i);
          break;
        }
        // Everything from i up to the selector start is declarations
        var prefix = body.slice(i, nest);
        // Split: last `;` separates declarations from the nested selector
        var lastSemi = prefix.lastIndexOf(';');
        if (lastSemi >= 0) {
          declBuf += prefix.slice(0, lastSemi + 1);
          var nestedSel = prefix.slice(lastSemi + 1).trim();
        } else {
          var nestedSel = prefix.trim();
        }
        // Find matching `}` for this nested block
        var depth3 = 1; var k3 = nest + 1;
        while (k3 < body.length && depth3 > 0) {
          if (body[k3] === '{') depth3++;
          else if (body[k3] === '}') depth3--;
          k3++;
        }
        var nestedBody = body.slice(nest + 1, k3 - 1);
        i = k3;
        if (!nestedSel) continue;
        // Handle @media / @supports nested inside a rule (CSS nesting level 4)
        var lns = nestedSel.toLowerCase();
        if (lns.startsWith('@media') || lns.startsWith('@supports') || lns.startsWith('@container')) {
          // Wrap the parent selector inside the at-rule: @media x { parent { nestedBody } }
          var wrappedBody = parentSel + ' { ' + nestedBody + ' }';
          var innerWrap = new CSSStyleSheet_(); innerWrap._parseText(nestedSel + ' { ' + wrappedBody + ' }');
          for (var wi = 0; wi < innerWrap.cssRules.length; wi++) { this.cssRules.push(innerWrap.cssRules[wi]); }
          continue;
        }
        // Resolve `&` combinator; if no `&`, use descendant combinator
        var resolvedSel: string;
        if (nestedSel.indexOf('&') >= 0) {
          // Replace each `&` with the parent selector (handles `&:hover`, `&.active`, `html &`, etc.)
          resolvedSel = nestedSel.replace(/&/g, parentSel);
        } else {
          resolvedSel = parentSel + ' ' + nestedSel;
        }
        // Recursively flatten nested rules
        if (nestedBody.indexOf('{') >= 0) {
          this._flattenNested(resolvedSel, nestedBody.trim());
        } else {
          var nr2 = new CSSStyleRule_(resolvedSel, nestedBody.trim()); nr2.parentStyleSheet = this; this.cssRules.push(nr2); this._idxRule(nr2);
        }
      }
      // Emit accumulated declarations as a flat rule for parentSel
      var cleanDecls = declBuf.trim();
      if (cleanDecls) {
        var flatRule = new CSSStyleRule_(parentSel, cleanDecls); flatRule.parentStyleSheet = this; this.cssRules.push(flatRule); this._idxRule(flatRule);
      }
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

  // -- OfflineAudioContext stub -----------------------------------------------
  class OfflineAudioContext_ extends AudioNode_ {
    length: number; numberOfChannels: number; sampleRate: number;
    constructor(channelsOrOpts: number | { numberOfChannels: number; length: number; sampleRate: number }, length?: number, sampleRate?: number) {
      super();
      if (typeof channelsOrOpts === 'object') {
        this.numberOfChannels = channelsOrOpts.numberOfChannels; this.length = channelsOrOpts.length; this.sampleRate = channelsOrOpts.sampleRate;
      } else { this.numberOfChannels = channelsOrOpts; this.length = length ?? 0; this.sampleRate = sampleRate ?? 44100; }
    }
    startRendering(): Promise<unknown> { return Promise.resolve(null); }
    resume(): Promise<void> { return Promise.resolve(); }
    suspend(_sec: number): Promise<void> { return Promise.resolve(); }
    createBuffer(_ch: number, _len: number, _sr: number): unknown { return null; }
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
    // Audio Worklet (Chrome 66+)
    audioWorklet = { addModule(_url: string): Promise<void> { return Promise.resolve(); } };
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
  (doc as any).pictureInPictureEnabled = false;
  (doc as any).pictureInPictureElement = null;

  // ── EventSource (Server-Sent Events) — real streaming SSE implementation ───

  interface _SSEEntry {
    sse:        EventSource_;
    sock:       import('../../core/sdk.js').RawSocket | null;
    buf:        number[];
    headerDone: boolean;
    headerBuf:  string;
    lineBuf:    string;
    dataBuf:    string;
    eventType:  string;
    lastId:     string;
    retryMs:    number;
    retryAt:    number;  // kernel uptime ms when to reconnect (0 = not pending)
  }

  var _sseSockets: _SSEEntry[] = [];

  function _sseFireEvent(sse: EventSource_, type: string, extra?: Record<string, unknown>): void {
    var ev = Object.assign({ type, target: sse }, extra || {});
    var arr = (sse as any)._listeners as Map<string, Array<(e: unknown) => void>>;
    if (arr) { var fns = arr.get(type); if (fns) for (var _fn of fns) _callGuardedCtx('sse:' + type, _fn, ev); }
    var onFn = (sse as any)['on' + type];
    if (typeof onFn === 'function') _callGuardedCtx('sse:' + type, onFn, ev);
  }

  function _sseConnect(entry: _SSEEntry): void {
    var sse = entry.sse;
    var rawUrl = sse.url.startsWith('http') ? sse.url : _resolveURL(sse.url, _baseHref);
    var _sm = rawUrl.match(/^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^]*)?$/i);
    if (!_sm) { sse.readyState = 2; _sseFireEvent(sse, 'error', { message: 'Invalid SSE URL: ' + rawUrl }); return; }
    var _stls  = _sm[1].toLowerCase() === 'https';
    var _shost = _sm[2];
    var _sport = _sm[3] ? parseInt(_sm[3]) : (_stls ? 443 : 80);
    var _spath = _sm[4] || '/';
    sse.readyState = 0; // CONNECTING
    (os.net as any).connect(_shost, _sport, function(sock: import('../../core/sdk.js').RawSocket | null, err?: string) {
      if (!sock) {
        sse.readyState = 2;
        entry.retryAt = (typeof kernel !== 'undefined' ? kernel.getUptime() : 0) + entry.retryMs;
        _sseFireEvent(sse, 'error', { message: err || 'SSE connection failed' });
        return;
      }
      entry.sock       = sock;
      entry.buf        = [];
      entry.headerDone = false;
      entry.headerBuf  = '';
      entry.lineBuf    = '';
      entry.dataBuf    = '';
      entry.eventType  = 'message';
      entry.retryAt    = 0;
      // Send HTTP/1.1 GET for SSE
      var _hosthdr = _sport === (_stls ? 443 : 80) ? _shost : (_shost + ':' + _sport);
      var _req = 'GET ' + _spath + ' HTTP/1.1\r\n' +
        'Host: ' + _hosthdr + '\r\n' +
        'Accept: text/event-stream\r\n' +
        'Cache-Control: no-cache\r\n' +
        'Connection: keep-alive\r\n' +
        (entry.lastId ? 'Last-Event-ID: ' + entry.lastId + '\r\n' : '') +
        '\r\n';
      sock.write(_req);
      if (!_sseSockets.includes(entry)) _sseSockets.push(entry);
    }, { timeoutMs: 10000 });
  }

  function _tickSSE(): void {
    var _now = typeof kernel !== 'undefined' ? kernel.getUptime() : 0;
    for (var _si = _sseSockets.length - 1; _si >= 0; _si--) {
      var _e = _sseSockets[_si];
      var _sse = _e.sse;
      // Handle reconnect timer for closed entries
      if (_sse.readyState === 2) {
        if (_e.retryAt > 0 && _now >= _e.retryAt) { _e.retryAt = 0; _sseConnect(_e); }
        continue;
      }
      // Check socket health
      if (!_e.sock || !_e.sock.connected) {
        _sse.readyState = 2;
        _e.retryAt = _now + _e.retryMs;
        _sseFireEvent(_sse, 'error', { message: 'SSE connection lost' });
        _sseSockets.splice(_si, 1);
        continue;
      }
      var _avail = _e.sock.available();
      if (_avail <= 0) continue;
      var _newBytes = _e.sock.readBytes(_avail);
      for (var _b of _newBytes) _e.buf.push(_b);
      // Convert buf to string
      var _raw = ''; for (var _bc of _e.buf) _raw += String.fromCharCode(_bc); _e.buf = [];
      if (!_e.headerDone) {
        _e.headerBuf += _raw;
        var _dEnd = _e.headerBuf.indexOf('\r\n\r\n');
        if (_dEnd >= 0) {
          var _statusLine = _e.headerBuf.split('\r\n')[0];
          if (_statusLine.indexOf(' 200') >= 0) {
            _e.headerDone = true;
            _sse.readyState = 1; // OPEN
            _sseFireEvent(_sse, 'open');
            // Bytes after headers go into line buffer
            _e.lineBuf = _e.headerBuf.slice(_dEnd + 4);
            _e.headerBuf = '';
          } else {
            _sse.readyState = 2;
            _e.retryAt = _now + _e.retryMs;
            _sseFireEvent(_sse, 'error', { message: 'SSE HTTP error: ' + _statusLine });
            _e.sock.close();
            _sseSockets.splice(_si, 1);
          }
        }
        continue;
      }
      // Append to line buffer and parse SSE fields
      _e.lineBuf += _raw;
      var _lines = _e.lineBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      _e.lineBuf = _lines.pop() ?? '';
      for (var _li = 0; _li < _lines.length; _li++) {
        var _line = _lines[_li];
        if (_line === '') {
          // Blank line = dispatch event
          if (_e.dataBuf !== '') {
            var _data = _e.dataBuf.endsWith('\n') ? _e.dataBuf.slice(0, -1) : _e.dataBuf;
            _sseFireEvent(_sse, _e.eventType, { data: _data, lastEventId: _e.lastId, origin: _sse.url, ports: [] });
            _e.dataBuf = ''; _e.eventType = 'message';
          }
        } else if (_line.charAt(0) === ':') {
          // Comment — skip
        } else {
          var _col = _line.indexOf(':');
          var _field = _col >= 0 ? _line.slice(0, _col) : _line;
          var _val   = _col >= 0 ? (_line.charAt(_col + 1) === ' ' ? _line.slice(_col + 2) : _line.slice(_col + 1)) : '';
          if      (_field === 'data')  { _e.dataBuf   += _val + '\n'; }
          else if (_field === 'event') { _e.eventType  = _val || 'message'; }
          else if (_field === 'id')    { _e.lastId     = _val; }
          else if (_field === 'retry') { var _ms = parseInt(_val); if (!isNaN(_ms)) _e.retryMs = _ms; }
        }
      }
    }
  }

  class EventSource_ {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    CONNECTING = 0; OPEN = 1; CLOSED = 2;
    readyState = 0;
    url: string; withCredentials: boolean;
    onopen:    ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onerror:   ((e: unknown) => void) | null = null;
    _listeners: Map<string, Array<(ev: unknown) => void>> = new Map();
    _entry: _SSEEntry;
    constructor(url: string, init?: { withCredentials?: boolean }) {
      this.url = url; this.withCredentials = init?.withCredentials ?? false;
      this._entry = {
        sse: this, sock: null, buf: [], headerDone: false, headerBuf: '',
        lineBuf: '', dataBuf: '', eventType: 'message', lastId: '', retryMs: 3000, retryAt: 0,
      };
      _sseConnect(this._entry);
    }
    addEventListener(type: string, fn: (ev: unknown) => void): void {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: (ev: unknown) => void): void {
      var _arr = this._listeners.get(type);
      if (_arr) { var _idx = _arr.indexOf(fn); if (_idx >= 0) _arr.splice(_idx, 1); }
    }
    dispatchEvent(_ev: unknown): boolean { return true; }
    close(): void {
      this.readyState = 2;
      if (this._entry.sock) { try { this._entry.sock.close(); } catch (_) {} }
      var _idx2 = _sseSockets.indexOf(this._entry);
      if (_idx2 >= 0) _sseSockets.splice(_idx2, 1);
    }
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

  // ── WebSocket (item 542) — real TCP + HTTP Upgrade implementation ─────────

  /** Active WebSocket connections polled each tick. */
  interface _WSEntry {
    ws:          WebSocket_;
    sock:        import('../../core/sdk.js').RawSocket;
    recvBuf:     number[];
    upgraded:    boolean;   // HTTP 101 received
    headerBuf:   string;    // raw text before upgrade
    fragOpcode:  number;    // current fragment opcode (for continuation frames)
    fragBuf:     number[];  // accumulated fragment payload
    pingInterval?: ReturnType<typeof setInterval_> | number;
  }
  var _wsSockets: _WSEntry[] = [];

  /** Generate a random base64 Sec-WebSocket-Key (16 bytes). */
  function _wsKey(): string {
    var b = '';
    for (var i = 0; i < 16; i++) b += String.fromCharCode(Math.floor(Math.random() * 256));
    // base64-encode 16 bytes
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var j = 0; j < b.length; j += 3) {
      var c1 = b.charCodeAt(j), c2 = b.charCodeAt(j+1) || 0, c3 = b.charCodeAt(j+2) || 0;
      var n = (c1 << 16) | (c2 << 8) | c3;
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] +
             (j+1 < b.length ? chars[(n >> 6) & 63] : '=') +
             (j+2 < b.length ? chars[n & 63] : '=');
    }
    return out;
  }

  /** Dispatch synthetic event to a WebSocket object. */
  function _wsFireEvent(ws: WebSocket_, type: string, extra?: Record<string, unknown>): void {
    var ev = Object.assign({ type, target: ws }, extra || {});
    var arr = (ws as any)._listeners as Map<string, Array<(e: unknown) => void>>;
    if (arr) { var fns = arr.get(type); if (fns) for (var fn of fns) _callGuardedCtx('ws:' + type, fn, ev); }
    var onFn = (ws as any)['on' + type];
    if (typeof onFn === 'function') _callGuardedCtx('ws:' + type, onFn, ev);
  }

  /** Poll all active WebSocket connections for incoming data. */
  function _tickWebSockets(): void {
    for (var _wsi = _wsSockets.length - 1; _wsi >= 0; _wsi--) {
      var entry = _wsSockets[_wsi];
      var ws    = entry.ws;
      var sock  = entry.sock;
      if (!sock.connected) {
        // Socket closed unexpectedly
        if (ws.readyState < 3) {
          ws.readyState = 3;
          _wsFireEvent(ws, 'close', { code: 1006, reason: 'Connection dropped', wasClean: false });
        }
        _wsSockets.splice(_wsi, 1);
        continue;
      }
      var avail = sock.available();
      if (avail <= 0) continue;
      var newBytes = sock.readBytes(avail);
      for (var b of newBytes) entry.recvBuf.push(b);

      if (!entry.upgraded) {
        // Convert bytes to string and look for HTTP 101
        var hStr = '';
        for (var hb of entry.recvBuf) hStr += String.fromCharCode(hb);
        entry.headerBuf += hStr;
        entry.recvBuf = [];
        var dblCRLF = entry.headerBuf.indexOf('\r\n\r\n');
        if (dblCRLF >= 0) {
          var statusLine = entry.headerBuf.split('\r\n')[0];
          if (statusLine.indexOf('101') >= 0) {
            entry.upgraded = true;
            ws.readyState = 1; // OPEN
            _wsFireEvent(ws, 'open');
            // Any bytes after headers go into recvBuf
            var remainder = entry.headerBuf.slice(dblCRLF + 4);
            for (var i = 0; i < remainder.length; i++) entry.recvBuf.push(remainder.charCodeAt(i));
            entry.headerBuf = '';
          } else {
            // Not a 101 — connection failed
            ws.readyState = 3;
            _wsFireEvent(ws, 'error', { message: 'WebSocket upgrade failed: ' + statusLine });
            _wsFireEvent(ws, 'close', { code: 1006, reason: 'Upgrade failed', wasClean: false });
            sock.close();
            _wsSockets.splice(_wsi, 1);
          }
        }
        continue;
      }

      // Parse WebSocket frames from recvBuf
      while (entry.recvBuf.length > 0) {
        var frame = parseWSFrame(entry.recvBuf);
        if (!frame) break;
        var totalLen = frame.headerLen + (frame.masked ? 4 : 0) + frame.payloadLen;
        if (entry.recvBuf.length < frame.headerLen + (frame.masked ? 4 : 0) + frame.payloadLen) break;
        var payloadStart = frame.headerLen + (frame.masked ? 4 : 0);
        var payload2 = entry.recvBuf.slice(payloadStart, payloadStart + frame.payloadLen);
        if (frame.masked && frame.maskKey.length === 4) {
          for (var mi = 0; mi < payload2.length; mi++) payload2[mi] ^= frame.maskKey[mi % 4];
        }
        entry.recvBuf = entry.recvBuf.slice(totalLen);

        var opcode = frame.opcode;
        if (!frame.fin || opcode === 0x0) {
          // Fragment handling
          if (opcode !== 0x0) entry.fragOpcode = opcode;
          for (var fb of payload2) entry.fragBuf.push(fb);
          if (!frame.fin) continue;
          // Final fragment — reassemble
          opcode = entry.fragOpcode;
          payload2 = entry.fragBuf;
          entry.fragBuf = [];
        }

        if (opcode === 0x1 || opcode === 0x2) {
          // Text or binary
          var msgData: string | ArrayBuffer;
          if (opcode === 0x1) {
            var s2 = ''; for (var sc = 0; sc < payload2.length; sc++) s2 += String.fromCharCode(payload2[sc]);
            msgData = s2;
          } else {
            var ab = new ArrayBuffer(payload2.length);
            var view = new Uint8Array(ab);
            for (var vi = 0; vi < payload2.length; vi++) view[vi] = payload2[vi];
            msgData = ws.binaryType === 'arraybuffer' ? ab : new Blob([ab]) as unknown as ArrayBuffer;
          }
          ws.bufferedAmount = 0;
          _wsFireEvent(ws, 'message', { data: msgData, origin: ws.url, lastEventId: '', ports: [] });
        } else if (opcode === 0x8) {
          // Close frame
          var closeCode2 = payload2.length >= 2 ? (payload2[0] << 8) | payload2[1] : 1000;
          var closeReason2 = '';
          for (var cr = 2; cr < payload2.length; cr++) closeReason2 += String.fromCharCode(payload2[cr]);
          ws.readyState = 3;
          _wsFireEvent(ws, 'close', { code: closeCode2, reason: closeReason2, wasClean: true });
          sock.close();
          _wsSockets.splice(_wsi, 1);
        } else if (opcode === 0x9) {
          // Ping — send pong
          var pongFrame = buildWSFrame(0xA, payload2);
          sock.write(pongFrame);
        }
        // 0xA = Pong — ignored
      }
    }
  }

  class WebSocket_ {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0;
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
      var self = this;
      // Parse ws:// or wss:// URL
      var parsed = _parseWsUrl(url);
      if (!parsed) {
        setTimeout_(() => {
          self.readyState = 3;
          _wsFireEvent(self, 'error', { message: 'Invalid WebSocket URL: ' + url });
          _wsFireEvent(self, 'close', { code: 1006, reason: 'Invalid URL', wasClean: false });
        }, 0);
        return;
      }
      var { host, port, path, tls } = parsed;
      // Connect via os.net.connect
      (os.net as any).connect(host, port, function(sock: import('../../core/sdk.js').RawSocket | null, err?: string) {
        if (!sock) {
          self.readyState = 3;
          _wsFireEvent(self, 'error', { message: err || 'Connection failed' });
          _wsFireEvent(self, 'close', { code: 1006, reason: err || 'Connection failed', wasClean: false });
          return;
        }
        // Send HTTP Upgrade request
        var key = _wsKey();
        var hosthdr = port === (tls ? 443 : 80) ? host : (host + ':' + port);
        var protos = Array.isArray(protocols) ? protocols.join(', ') : (protocols || '');
        var req = 'GET ' + path + ' HTTP/1.1\r\n' +
          'Host: ' + hosthdr + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          (protos ? 'Sec-WebSocket-Protocol: ' + protos + '\r\n' : '') +
          '\r\n';
        sock.write(req);
        _wsSockets.push({
          ws: self, sock, recvBuf: [], upgraded: false, headerBuf: '',
          fragOpcode: 0, fragBuf: [],
        });
      }, { timeoutMs: 8000 });
    }

    send(data: string | ArrayBuffer | Blob): void {
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      var payload: number[] = [];
      var entry = _wsSockets.find(function(e) { return e.ws === this; }, this);
      if (!entry) return;
      if (typeof data === 'string') {
        for (var i = 0; i < data.length; i++) payload.push(data.charCodeAt(i) & 0xFF);
        entry.sock.write(buildWSFrame(0x1, payload));
      } else if (data instanceof ArrayBuffer) {
        var view2 = new Uint8Array(data);
        for (var j = 0; j < view2.length; j++) payload.push(view2[j]);
        entry.sock.write(buildWSFrame(0x2, payload));
      }
    }
    close(code = 1000, reason = ''): void {
      if (this.readyState === 0 || this.readyState === 1) {
        this.readyState = 2;
        var entry2 = _wsSockets.find(function(e) { return e.ws === this; }, this);
        if (entry2) {
          var closePayload: number[] = [(code >> 8) & 0xFF, code & 0xFF];
          for (var i = 0; i < reason.length; i++) closePayload.push(reason.charCodeAt(i) & 0xFF);
          entry2.sock.write(buildWSFrame(0x8, closePayload));
        }
        var self = this;
        setTimeout_(() => {
          self.readyState = 3;
          if (entry2) { entry2.sock.close(); _wsSockets.splice(_wsSockets.indexOf(entry2), 1); }
          _wsFireEvent(self, 'close', { code, reason, wasClean: code === 1000 });
        }, 0);
      }
    }
    addEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type)!.push(fn);
    }
    removeEventListener(type: string, fn: (ev: unknown) => void, _opts?: unknown): void {
      var arr = this._listeners.get(type); if (arr) { var i2 = arr.indexOf(fn); if (i2 >= 0) arr.splice(i2, 1); }
    }
    dispatchEvent(ev: { type: string }): boolean {
      _wsFireEvent(this, ev.type, ev as Record<string, unknown>); return true;
    }
  }

  /** Parse a WebSocket URL into host, port, path, tls. Returns null if invalid. */
  function _parseWsUrl(url: string): { host: string; port: number; path: string; tls: boolean } | null {
    var m = url.match(/^(wss?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?(\?.*)?$/i);
    if (!m) return null;
    var tls  = m[1].toLowerCase() === 'wss';
    var host = m[2];
    var port = m[3] ? parseInt(m[3]) : (tls ? 443 : 80);
    var path = (m[4] || '/') + (m[5] || '');
    return { host, port, path, tls };
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
    // ── Pseudo-element shortcut (::before / ::after) ────────────────────────
    if (_pseudoElt && typeof _pseudoElt === 'string' && _pseudoElt.trim()) {
      var _pNorm = _pseudoElt.trim().replace(/^:{1}([a-z])/, '::$1'); // :before → ::before
      var _pMerged = new Map<string, string>();
      function _walkPseudo(rules: any[]): void {
        for (var _pr of rules) {
          if (!_pr) continue;
          if (_pr.type === 1 && _pr.selectorText) {
            var _pSels = (_pr.selectorText as string).split(',');
            var _pMaxSpec = -1;
            for (var _psi = 0; _psi < _pSels.length; _psi++) {
              var _pSel = _pSels[_psi].trim();
              // Match selectors ending with ::before / ::after (also single-colon variants)
              var _pEnd = _pSel.endsWith(_pNorm) || _pSel.endsWith(_pNorm.replace('::', ':'));
              if (!_pEnd) continue;
              var _pBase = _pSel.slice(0, _pSel.lastIndexOf(':')).replace(/:$/, '').trim() || '*';
              try {
                if (_matchSel(_pBase, el)) {
                  var _pSp = _calcSpecificity(_pSel);
                  if (_pSp > _pMaxSpec) _pMaxSpec = _pSp;
                }
              } catch (_) {}
            }
            if (_pMaxSpec >= 0) {
              for (var _ppk in _pr.style) {
                if (_ppk !== 'cssText' && _pr.style[_ppk]) _pMerged.set(_ppk, _pr.style[_ppk]);
              }
              if (_pr.important) (_pr.important as Set<string>).forEach((k: string) => {
                if (_pr.style[k]) _pMerged.set(k, _pr.style[k]);
              });
            }
          } else if ((_pr.type === 4 || _pr.type === 12) && _pr.cssRules) {
            _walkPseudo(_pr.cssRules);
          }
        }
      }
      for (var _pShI = 0; _pShI < doc._styleSheets.length; _pShI++) {
        var _pSh = doc._styleSheets[_pShI] as any;
        if (!_pSh || _pSh.disabled) continue;
        _walkPseudo(_pSh.cssRules ?? []);
      }
      var _pResult: any = Object.create(null);
      _pMerged.forEach((v, k) => { _pResult[k] = v; });
      _pResult.content = _pResult.content || 'none';
      _pResult.display = _pResult.display || 'inline';
      _pResult.getPropertyValue = (p: string) => _pResult[p] || '';
      _pResult.setProperty = (_p: string, _v: string) => {};
      return _pResult;
    }
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

    // Also include adoptedStyleSheets (Constructable Stylesheets API: LitElement, Shadow DOM, etc.)
    var _adoptedSS = (doc as any)._adoptedStyleSheets as unknown[];
    if (Array.isArray(_adoptedSS)) {
      for (var _asi = 0; _asi < _adoptedSS.length; _asi++) {
        var _aSheet = _adoptedSS[_asi] as any as CSSStyleSheet_;
        if (!_aSheet || _aSheet.disabled) continue;
        walkRules(_aSheet.cssRules ?? []);
      }
    }

    // Also walk shadow root adoptedStyleSheets if element is inside one (Shadow DOM scoping)
    var _shadowRoot: any = null;
    {
      var _n: any = el;
      while (_n) {
        var _rn: any = _n.getRootNode ? _n.getRootNode() : null;
        if (_rn && _rn !== _n && _rn.mode && _rn !== doc) { _shadowRoot = _rn; break; }
        _n = _n.parentNode;
      }
    }
    if (_shadowRoot) {
      var _srSS = _shadowRoot.adoptedStyleSheets as unknown[] | undefined;
      if (Array.isArray(_srSS)) {
        for (var _sri = 0; _sri < _srSS.length; _sri++) {
          var _srSheet = _srSS[_sri] as any as CSSStyleSheet_;
          if (!_srSheet || _srSheet.disabled) continue;
          walkRules(_srSheet.cssRules ?? []);
        }
      }
      // Also walk <style> elements inside the shadow root
      var _srStyles = (_shadowRoot as any)._styleSheets as CSSStyleSheet_[] | undefined;
      if (Array.isArray(_srStyles)) {
        for (var _srsi = 0; _srsi < _srStyles.length; _srsi++) {
          var _srSSheet = _srStyles[_srsi];
          if (!_srSSheet || (_srSSheet as any).disabled) continue;
          walkRules((_srSSheet as any).cssRules ?? []);
        }
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
      // Use CSS.registerProperty() / @property initialValue as last resort
      if (fallback === '' || fallback === undefined) {
        var _reg = _cssPropertyRegistry.get(name);
        if (_reg && _reg.initialValue) return _reg.initialValue;
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

  // ── CSS Transitions engine (Tier 4.3) ─────────────────────────────────────

  interface _CSSTransition {
    el:         VElement;
    prop:       string;      // CSS property name (kebab-case)
    fromVal:    string;
    toVal:      string;
    startMs:    number;
    durationMs: number;
    easing:     string;     // 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
    done:       boolean;
  }

  var _activeTrans: _CSSTransition[] = [];
  var _transRunning = false;

  /** Apply cubic-bezier easing approximations. */
  function _cssEase(t: number, fn: string): number {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    switch (fn) {
      case 'ease':         { var u = 1-t; return 3*u*u*t*0.1 + 3*u*t*t*0.9 + t*t*t; }
      case 'ease-in':      return t * t;
      case 'ease-out':     { var v = 1-t; return 1 - v*v; }
      case 'ease-in-out':  return t < 0.5 ? 2*t*t : 1 - 2*(1-t)*(1-t);
      default:             return t; // linear
    }
  }

  /** Interpolate a single CSS value string from `a` to `b` at progress `p` (0-1). */
  function _lerpCSSValue(a: string, b: string, p: number): string {
    if (a === b) return b;
    // Color: #rrggbb or rgb(r,g,b)
    function _hexToRGB(h: string): [number,number,number] | null {
      h = h.trim();
      var m6 = h.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      if (m6) return [parseInt(m6[1],16), parseInt(m6[2],16), parseInt(m6[3],16)];
      var m3 = h.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
      if (m3) return [parseInt(m3[1]+m3[1],16), parseInt(m3[2]+m3[2],16), parseInt(m3[3]+m3[3],16)];
      var mr = h.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (mr) return [+mr[1], +mr[2], +mr[3]];
      return null;
    }
    var ca = _hexToRGB(a), cb2 = _hexToRGB(b);
    if (ca && cb2) {
      var r = Math.round(ca[0] + (cb2[0]-ca[0])*p);
      var g = Math.round(ca[1] + (cb2[1]-ca[1])*p);
      var bl = Math.round(ca[2] + (cb2[2]-ca[2])*p);
      return 'rgb('+r+','+g+','+bl+')';
    }
    // Numeric+unit: e.g. "120px", "0.5", "50%"
    var ma = a.match(/^(-?[\d.]+)([a-z%]*)$/i);
    var mb = b.match(/^(-?[\d.]+)([a-z%]*)$/i);
    if (ma && mb) {
      var va = parseFloat(ma[1]), vb = parseFloat(mb[1]);
      var unit = mb[2] || ma[2] || '';
      var interp = va + (vb - va) * p;
      // Round to 3 decimal places for cleanliness
      return (Math.round(interp * 1000) / 1000) + unit;
    }
    return p < 0.5 ? a : b;
  }

  /** Parse `transition` shorthand into per-property descriptors.
   *  Returns a map of propertyName → {duration, easing}.
   *  Handles: "property duration easing" or "property duration" or comma-separated list. */
  function _parseTransition(css: string): Map<string, { durationMs: number; easing: string }> {
    var result = new Map<string, { durationMs: number; easing: string }>();
    if (!css || css === 'none' || css === 'initial') return result;
    var parts = css.split(',');
    for (var _pi = 0; _pi < parts.length; _pi++) {
      var tokens = parts[_pi].trim().split(/\s+/);
      var prop = tokens[0] || 'all';
      var dur  = 0;
      var ease = 'ease';
      for (var _ti = 1; _ti < tokens.length; _ti++) {
        var tok = tokens[_ti];
        if (tok.endsWith('ms'))  { dur  = parseFloat(tok); continue; }
        if (tok.endsWith('s'))   { dur  = parseFloat(tok) * 1000; continue; }
        if (tok === 'linear' || tok === 'ease' || tok.startsWith('ease-') || tok.startsWith('cubic-bezier')) { ease = tok; continue; }
      }
      if (dur > 0) result.set(prop, { durationMs: dur, easing: ease });
    }
    return result;
  }

  // ── CSS Animations engine (Tier 4.4 / @keyframes) ─────────────────────────

  /** Running animations: keyed by element, value = CSSAnimation */
  var _activeAnims = new Map<VElement, CSSAnimation>();
  var _lastAnimScanGen = -1;

  /** Look up a @keyframes rule by name from all loaded stylesheets. */
  function _getKeyframesRule(name: string): AnimationKeyframe[] | null {
    for (var _ssi = 0; _ssi < doc._styleSheets.length; _ssi++) {
      var _sh = doc._styleSheets[_ssi] as any;
      if (!_sh || !_sh.cssRules) continue;
      for (var _ri = 0; _ri < _sh.cssRules.length; _ri++) {
        var _r = _sh.cssRules[_ri] as any;
        if (_r && _r.type === 7 && _r.name === name && _r.cssRules) {
          var _kfs: AnimationKeyframe[] = [];
          for (var _ki = 0; _ki < _r.cssRules.length; _ki++) {
            var _kf = _r.cssRules[_ki] as any;
            if (!_kf || !_kf.keyText) continue;
            var _offsets: number[] = [];
            var _ks = _kf.keyText.split(',');
            for (var _kti = 0; _kti < _ks.length; _kti++) {
              var _kt = _ks[_kti].trim().toLowerCase();
              if (_kt === 'from') _offsets.push(0);
              else if (_kt === 'to') _offsets.push(1);
              else { var _pct = parseFloat(_kt); if (!isNaN(_pct)) _offsets.push(_pct / 100); }
            }
            var _props: Record<string, string | number> = {};
            var _kfSt = _kf.style as any;
            if (_kfSt && _kfSt._map) {
              (_kfSt._map as Map<string, string>).forEach(function(v: string, k: string) { _props[k] = v; });
            } else if (_kfSt && _kfSt.cssText) {
              _kfSt.cssText.split(';').forEach(function(decl: string) {
                var _ci = decl.indexOf(':');
                if (_ci >= 0) _props[decl.slice(0, _ci).trim()] = decl.slice(_ci + 1).trim();
              });
            }
            for (var _oi = 0; _oi < _offsets.length; _oi++) {
              _kfs.push({ offset: _offsets[_oi], properties: Object.assign({}, _props) });
            }
          }
          _kfs.sort(function(a, b) { return a.offset - b.offset; });
          return _kfs;
        }
      }
    }
    return null;
  }

  /** Parse the `animation` shorthand into a CSSAnimation, or null if not applicable. */
  function _parseAnimationProp(animStr: string, nowMs: number): CSSAnimation | null {
    if (!animStr || animStr === 'none') return null;
    var tokens = animStr.trim().split(/\s+/);
    var name = '';
    var duration = 300;
    var delay = 0;
    var durationSet = false;
    var iterations: number | 'infinite' = 1;
    var direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse' = 'normal';
    var fillMode: 'none' | 'forwards' | 'backwards' | 'both' = 'none';
    for (var _ai = 0; _ai < tokens.length; _ai++) {
      var tok = tokens[_ai];
      var tl = tok.toLowerCase();
      if (tl.endsWith('ms'))       { var ms2 = parseFloat(tok); if (!durationSet) { duration = ms2; durationSet = true; } else { delay = ms2; } }
      else if (tl.endsWith('s'))   { var s2 = parseFloat(tok)*1000; if (!durationSet) { duration = s2; durationSet = true; } else { delay = s2; } }
      else if (tl === 'infinite')  { iterations = 'infinite'; }
      else if (tl === 'normal' || tl === 'reverse' || tl === 'alternate' || tl === 'alternate-reverse') { direction = tl as 'normal' | 'reverse' | 'alternate' | 'alternate-reverse'; }
      else if (tl === 'forwards' || tl === 'backwards' || tl === 'both') { fillMode = tl as 'forwards' | 'backwards' | 'both'; }
      else if (/^[\d.]+$/.test(tok)) { iterations = parseFloat(tok) || 1; }
      else if (tl !== 'linear' && !tl.startsWith('ease') && !tl.startsWith('cubic-bezier') && !tl.startsWith('step') && tl !== 'none') { name = tok; }
    }
    if (!name || name === 'none') return null;
    var kfs = _getKeyframesRule(name);
    if (!kfs || kfs.length < 2) return null;
    return { id: name, keyframes: kfs, duration, delay, iterations, direction, fillMode, startTime: nowMs } as CSSAnimation;
  }

  /** Scan the whole DOM for elements with `animation` CSS, update _activeAnims. */
  function _scanAnimations(nowMs: number): void {
    _lastAnimScanGen = currentStyleGeneration();
    function _walkAnimEl(node: VNode): void {
      if (node.nodeType === 1) {
        var el2 = node as VElement;
        if (!_activeAnims.has(el2)) {
          var cs2 = getComputedStyle(el2);
          var animCss = cs2.getPropertyValue('animation') || cs2.getPropertyValue('animation-name') || '';
          if (animCss && animCss !== 'none') {
            var anim = _parseAnimationProp(animCss, nowMs);
            if (anim) _activeAnims.set(el2, anim);
          }
        }
        for (var ci = 0; ci < node.childNodes.length; ci++) _walkAnimEl(node.childNodes[ci]);
      } else {
        for (var cj = 0; cj < node.childNodes.length; cj++) _walkAnimEl(node.childNodes[cj]);
      }
    }
    if (doc.documentElement) _walkAnimEl(doc.documentElement);
  }

  /** Advance active CSS animations; called from tick(). */
  function _tickAnimations(nowMs: number): void {
    if (_activeAnims.size === 0) return;
    var toDelete: VElement[] = [];
    _activeAnims.forEach(function(anim, el2) {
      var values = sampleAnimation(anim, nowMs);
      if (values === null) {
        // Done — check fill-mode
        if (anim.fillMode === 'forwards' || anim.fillMode === 'both') {
          // Keep final-frame values (already set); don't delete from map yet
          return;
        }
        toDelete.push(el2);
        try {
          var _aevt = new VEvent('animationend', { bubbles: true, cancelable: false });
          (_aevt as any).animationName = anim.id; (_aevt as any).elapsedTime = anim.duration / 1000;
          el2.dispatchEvent(_aevt);
        } catch(_) {}
        return;
      }
      var changed = false;
      for (var _pk in values) {
        var _pv = String(values[_pk]);
        if (el2._style._map.get(_pk) !== _pv) { el2._style._map.set(_pk, _pv); changed = true; }
      }
      if (changed) {
        el2._dirtyLayout = true; bumpStyleGeneration(); doc._dirty = true; needsRerender = true;
      }
    });
    for (var _di = 0; _di < toDelete.length; _di++) _activeAnims.delete(toDelete[_di]);
  }

  /** Advance active CSS transitions; called from tick(). Returns true if any transition is live. */
  function _tickTransitions(nowMs: number): boolean {
    if (_activeTrans.length === 0) return false;
    var stillActive = false;
    for (var _ti2 = 0; _ti2 < _activeTrans.length; _ti2++) {
      var tr = _activeTrans[_ti2];
      if (tr.done) continue;
      var elapsed2 = nowMs - tr.startMs;
      var progress = Math.min(1, elapsed2 / tr.durationMs);
      var easedP   = _cssEase(progress, tr.easing);
      var interped = _lerpCSSValue(tr.fromVal, tr.toVal, easedP);
      // Apply directly to _map (bypassing hook to avoid recursion)
      tr.el._style._map.set(tr.prop, interped);
      tr.el._dirtyLayout = true;
      bumpStyleGeneration();
      doc._dirty = true;
      if (progress >= 1) {
        tr.done = true;
        // Fire transitionend event
        try {
          var _tevt = new VEvent('transitionend', { bubbles: true, cancelable: false });
          ((_tevt as any) as any).propertyName = tr.prop;
          ((_tevt as any) as any).elapsedTime = tr.durationMs / 1000;
          tr.el.dispatchEvent(_tevt);
        } catch(_) {}
      } else {
        stillActive = true;
      }
    }
    // Clean up done transitions
    _activeTrans = _activeTrans.filter(function(t) { return !t.done; });
    if (_activeTrans.length > 0) needsRerender = true;
    return stillActive;
  }

  // ── Performance (real W3C Performance Timeline) ──────────────────────────

  var _perf = new BrowserPerformance();
  var performance: BrowserPerformance = _perf;

  // ── Microtask queue ───────────────────────────────────────────────────────
  // True microtask ordering: drain before each macrotask fires.

  var _microtaskQueue: Array<() => void> = [];

  function queueMicrotask_(fn: () => void): void { _microtaskQueue.push(fn); }

  function _drainMicrotasks(): void {
    if (_pageFaulted) return;  // heap dirty — do not run any more JS
    var limit = 1000;
    while (_microtaskQueue.length > 0 && limit-- > 0) {
      var fn = _microtaskQueue.shift()!;
      _callGuarded(fn);  // re-arms _js_fault_active so JIT bugs in Promise callbacks are recoverable
      if (_pageFaulted) { _microtaskQueue.length = 0; return; }
    }
    // Also drain native QuickJS Promise jobs (e.g. Promise.then() callbacks)
    // This is required because QuickJS's job queue is not drained automatically
    // between JS function calls - only JS_ExecutePendingJob() drains it.
    // drainJobs is now fault-guarded on the C side; a negative return means
    // a fault occurred during Promise job execution.
    try {
      var _djr = (kernel as any).drainJobs();
      if (_djr < 0) {
        _pageFaulted = true;
        cb.log('[JS] page faulted during microtask drain — stopping all page script execution');
      }
    } catch(_) {}
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
    // scheduler.wait(ms) -- Chrome 124+
    wait(ms: number): Promise<void> {
      return new Promise<void>(resolve => setTimeout_(resolve, ms));
    },
  };

  // -- TaskController / TaskSignal (Prioritized Task Scheduling API) ---------

  class TaskController_ {

    _priority: string;

    signal: any;

    constructor(opts?: { priority?: string }) {

      this._priority = opts?.priority ?? 'user-visible';

      var self2 = this;

      this.signal = {

        get priority() { return self2._priority; },

        aborted: false,

        onprioritychange: null as any,

        addEventListener(_t: string, _fn: unknown): void {},

        removeEventListener(_t: string, _fn: unknown): void {},

      };

    }

    setPriority(priority: string): void { this._priority = priority; }

    abort(_reason?: unknown): void { this.signal.aborted = true; }

  }



  // -- documentPictureInPicture (Chrome 116+) --------------------------------

  var documentPictureInPicture = {

    requestWindow(_opts?: { width?: number; height?: number }): Promise<unknown> {

      return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError'));

    },

    window: null as unknown,

    onenter: null as unknown,

    addEventListener(_t: string, _fn: unknown): void {},

    removeEventListener(_t: string, _fn: unknown): void {},

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

  // ── SHA-256 implementation for crypto.subtle.digest ───────────────────────

  function _sha256(data: Uint8Array): ArrayBuffer {
    var K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    var H0 = 0x6a09e667, H1 = 0xbb67ae85, H2 = 0x3c6ef372, H3 = 0xa54ff53a;
    var H4 = 0x510e527f, H5 = 0x9b05688c, H6 = 0x1f83d9ab, H7 = 0x5be0cd19;
    var ml = data.length;
    var padLen = ((56 - (ml + 1) % 64) + 64) % 64;
    var buf = new Uint8Array(ml + 1 + padLen + 8);
    buf.set(data); buf[ml] = 0x80;
    var bl = ml * 8;
    buf[buf.length - 4] = (bl >>> 24) & 0xff;
    buf[buf.length - 3] = (bl >>> 16) & 0xff;
    buf[buf.length - 2] = (bl >>>  8) & 0xff;
    buf[buf.length - 1] =  bl         & 0xff;
    var W = new Array<number>(64);
    for (var off = 0; off < buf.length; off += 64) {
      for (var t = 0; t < 16; t++)
        W[t] = (buf[off+t*4]!<<24)|(buf[off+t*4+1]!<<16)|(buf[off+t*4+2]!<<8)|buf[off+t*4+3]!;
      for (var t = 16; t < 64; t++) {
        var w15=W[t-15]!,w2=W[t-2]!;
        var s0=((w15>>>7)|(w15<<25))^((w15>>>18)|(w15<<14))^(w15>>>3);
        var s1=((w2>>>17)|(w2<<15))^((w2>>>19)|(w2<<13))^(w2>>>10);
        W[t]=(W[t-16]!+s0+W[t-7]!+s1)|0;
      }
      var a=H0,b=H1,c=H2,d=H3,e=H4,f=H5,g=H6,h=H7;
      for (var t = 0; t < 64; t++) {
        var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
        var ch=(e&f)^(~e&g);
        var t1=(h+S1+ch+K[t]!+W[t]!)|0;
        var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
        var maj=(a&b)^(a&c)^(b&c);
        var t2=(S0+maj)|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H0=(H0+a)|0;H1=(H1+b)|0;H2=(H2+c)|0;H3=(H3+d)|0;
      H4=(H4+e)|0;H5=(H5+f)|0;H6=(H6+g)|0;H7=(H7+h)|0;
    }
    var res = new ArrayBuffer(32);
    var dv = new DataView(res);
    dv.setUint32(0,H0); dv.setUint32(4,H1); dv.setUint32(8,H2); dv.setUint32(12,H3);
    dv.setUint32(16,H4); dv.setUint32(20,H5); dv.setUint32(24,H6); dv.setUint32(28,H7);
    return res;
  }

  // ── HMAC-SHA256 / HMAC-SHA512 for crypto.subtle.sign/verify ─────────────

  function _hmacSHA256(key: Uint8Array, data: Uint8Array): ArrayBuffer {
    var blockSz = 64;
    var kp: Uint8Array = key.length > blockSz ? new Uint8Array(_sha256(key)) : key;
    var k = new Uint8Array(blockSz); k.set(kp);
    var ipad = new Uint8Array(blockSz), opad = new Uint8Array(blockSz);
    for (var i = 0; i < blockSz; i++) { ipad[i] = k[i]! ^ 0x36; opad[i] = k[i]! ^ 0x5c; }
    var inner = new Uint8Array(blockSz + data.length);
    inner.set(ipad); inner.set(data, blockSz);
    var innerHash = new Uint8Array(_sha256(inner));
    var outer = new Uint8Array(blockSz + 32);
    outer.set(opad); outer.set(innerHash, blockSz);
    return _sha256(outer);
  }

  function _sha512(data: Uint8Array): ArrayBuffer {
    // SHA-512 round constants (first 80)
    var K512: number[][] = [
      [0x428a2f98,0xd728ae22],[0x71374491,0x23ef65cd],[0xb5c0fbcf,0xec4d3b2f],[0xe9b5dba5,0x8189dbbc],
      [0x3956c25b,0xf348b538],[0x59f111f1,0xb605d019],[0x923f82a4,0xaf194f9b],[0xab1c5ed5,0xda6d8118],
      [0xd807aa98,0xa3030242],[0x12835b01,0x45706fbe],[0x243185be,0x4ee4b28c],[0x550c7dc3,0xd5ffb4e2],
      [0x72be5d74,0xf27b896f],[0x80deb1fe,0x3b1696b1],[0x9bdc06a7,0x25c71235],[0xc19bf174,0xcf692694],
      [0xe49b69c1,0xefbe4786],[0x0fc19dc6,0x8b8cd5b5],[0x240ca1cc,0x77ac9c65],[0x2de92c6f,0x592b0275],
      [0x4a7484aa,0x6ea6e483],[0x5cb0a9dc,0xbd41fbd4],[0x76f988da,0x831153b5],[0x983e5152,0xee66dfab],
      [0xa831c66d,0x2db43210],[0xb00327c8,0x98fb213f],[0xbf597fc7,0xbeef0ee4],[0xc6e00bf3,0x3da88fc2],
      [0xd5a79147,0x930aa725],[0x06ca6351,0xe003826f],[0x14292967,0x0a0e6e70],[0x27b70a85,0x46d22ffc],
      [0x2e1b2138,0x5c26c926],[0x4d2c6dfc,0x5ac42aed],[0x53380d13,0x9d95b3df],[0x650a7354,0x8baf63de],
      [0x766a0abb,0x3c77b2a8],[0x81c2c92e,0x47edaee6],[0x92722c85,0x1482353b],[0xa2bfe8a1,0x4cf10364],
      [0xa81a664b,0xbc423001],[0xc24b8b70,0xd0f89791],[0xc76c51a3,0x0654be30],[0xd192e819,0xd6ef5218],
      [0xd6990624,0x5565a910],[0xf40e3585,0x5771202a],[0x106aa070,0x32bbd1b8],[0x19a4c116,0xb8d2d0c8],
      [0x1e376c08,0x5141ab53],[0x2748774c,0xdf8eeb99],[0x34b0bcb5,0xe19b48a8],[0x391c0cb3,0xc5c95a63],
      [0x4ed8aa4a,0xe3418acb],[0x5b9cca4f,0x7763e373],[0x682e6ff3,0xd6b2b8a3],[0x748f82ee,0x5defb2fc],
      [0x78a5636f,0x43172f60],[0x84c87814,0xa1f0ab72],[0x8cc70208,0x1a6439ec],[0x90befffa,0x23631e28],
      [0xa4506ceb,0xde82bde9],[0xbef9a3f7,0xb2c67915],[0xc67178f2,0xe372532b],[0xca273ece,0xea26619c],
      [0xd186b8c7,0x21c0c207],[0xeada7dd6,0xcde0eb1e],[0xf57d4f7f,0xee6ed178],[0x06f067aa,0x72176fba],
      [0x0a637dc5,0xa2c898a6],[0x113f9804,0xbef90dae],[0x1b710b35,0x131c471b],[0x28db77f5,0x23047d84],
      [0x32caab7b,0x40c72493],[0x3c9ebe0a,0x15c9bebc],[0x431d67c4,0x9c100d4c],[0x4cc5d4be,0xcb3e42b6],
      [0x597f299c,0xfc657e2a],[0x5fcb6fab,0x3ad6faec],[0x6c44198c,0x4a475817],[0x00000000,0x00000000],
    ];
    // Init hash values (high/low 32-bit pairs for h0-h7)
    var H = [
      [0x6a09e667,0xf3bcc908],[0xbb67ae85,0x84caa73b],[0x3c6ef372,0xfe94f82b],[0xa54ff53a,0x5f1d36f1],
      [0x510e527f,0xade682d1],[0x9b05688c,0x2b3e6c1f],[0x1f83d9ab,0xfb41bd6b],[0x5be0cd19,0x137e2179],
    ];
    var ml = data.length;
    // Padding: message length in bits is 128-bit — we only support < 2^53 bytes
    var padLen = ((112 - (ml + 1) % 128 + 128) % 128);
    var buf = new Uint8Array(ml + 1 + padLen + 16);
    buf.set(data); buf[ml] = 0x80;
    var blBits = ml * 8;
    // Write 128-bit length big-endian — only 53 bits significant
    var dv5 = new DataView(buf.buffer);
    dv5.setUint32(buf.length - 4, blBits >>> 0, false);
    dv5.setUint32(buf.length - 8, Math.floor(blBits / 0x100000000), false);
    // Process each 128-byte block
    var W5 = new Array<number[]>(80);
    for (var b5 = 0; b5 < buf.length; b5 += 128) {
      for (var t5 = 0; t5 < 16; t5++) {
        var hi5 = dv5.getUint32(b5 + t5 * 8, false);
        var lo5 = dv5.getUint32(b5 + t5 * 8 + 4, false);
        W5[t5] = [hi5, lo5];
      }
      for (var t5 = 16; t5 < 80; t5++) {
        var w15h=W5[t5-15]![0]!, w15l=W5[t5-15]![1]!;
        var w2h=W5[t5-2]![0]!, w2l=W5[t5-2]![1]!;
        var sig0h=(((w15h>>>1)|(w15l<<31))^((w15h>>>8)|(w15l<<24))^(w15h>>>7))|0;
        var sig0l=(((w15l>>>1)|(w15h<<31))^((w15l>>>8)|(w15h<<24))^((w15l>>>7)|(w15h<<25)))|0;
        var sig1h=(((w2h>>>19)|(w2l<<13))^((w2h<<3)|(w2l>>>29))^(w2h>>>6))|0;
        var sig1l=(((w2l>>>19)|(w2h<<13))^((w2l<<3)|(w2h>>>29))^((w2l>>>6)|(w2h<<26)))|0;
        var addl = (W5[t5-16]![1]! + sig0l + W5[t5-7]![1]! + sig1l)|0;
        var addh = (W5[t5-16]![0]! + sig0h + W5[t5-7]![0]! + sig1h + (((W5[t5-16]![1]!>>>0)+(sig0l>>>0)+(W5[t5-7]![1]!>>>0)+(sig1l>>>0)) >= 0x100000000 ? 1 : 0))|0;
        W5[t5] = [addh, addl];
      }
      var ah=H[0]![0]!,al=H[0]![1]!,bh=H[1]![0]!,bl2=H[1]![1]!;
      var ch5=H[2]![0]!,cl5=H[2]![1]!,dh=H[3]![0]!,dl5=H[3]![1]!;
      var eh=H[4]![0]!,el5=H[4]![1]!,fh=H[5]![0]!,fl5=H[5]![1]!;
      var gh5=H[6]![0]!,gl5=H[6]![1]!,hh=H[7]![0]!,hl5=H[7]![1]!;
      for (var t5 = 0; t5 < 80; t5++) {
        var S1h=((eh>>>14)|(el5<<18))^((eh>>>18)|(el5<<14))^((eh<<23)|(el5>>>9));
        var S1l=((el5>>>14)|(eh<<18))^((el5>>>18)|(eh<<14))^((el5<<23)|(eh>>>9));
        var chh_=(eh&fh)^(~eh&gh5); var chl_=(el5&fl5)^(~el5&gl5);
        var t1l_=( hl5+S1l+chl_+K512[t5]![1]!+W5[t5]![1]! )|0;
        var carry1=(((hl5>>>0)+(S1l>>>0)+(chl_>>>0)+(K512[t5]![1]!>>>0)+(W5[t5]![1]!>>>0))>=0x100000000)?1:0;
        var t1h_=( hh+S1h+chh_+K512[t5]![0]!+W5[t5]![0]!+carry1 )|0;
        var S0h=((ah>>>28)|(al<<4))^((ah<<30)|(al>>>2))^((ah<<25)|(al>>>7));
        var S0l=((al>>>28)|(ah<<4))^((al<<30)|(ah>>>2))^((al<<25)|(ah>>>7));
        var majh_=(ah&bh)^(ah&ch5)^(bh&ch5); var majl_=(al&bl2)^(al&cl5)^(bl2&cl5);
        var t2l_=(S0l+majl_)|0; var t2h_=(S0h+majh_+(((S0l>>>0)+(majl_>>>0))>=0x100000000?1:0))|0;
        hh=gh5;hl5=gl5; gh5=fh;gl5=fl5; fh=eh;fl5=el5;
        el5=(dl5+t1l_)|0; eh=(dh+t1h_+(((dl5>>>0)+(t1l_>>>0))>=0x100000000?1:0))|0;
        dh=ch5;dl5=cl5; ch5=bh;cl5=bl2; bh=ah;bl2=al;
        al=(t1l_+t2l_)|0; ah=(t1h_+t2h_+(((t1l_>>>0)+(t2l_>>>0))>=0x100000000?1:0))|0;
      }
      H[0]=[( H[0]![0]!+ah)|0,( H[0]![1]!+al)|0];
      H[1]=[( H[1]![0]!+bh)|0,( H[1]![1]!+bl2)|0];
      H[2]=[( H[2]![0]!+ch5)|0,( H[2]![1]!+cl5)|0];
      H[3]=[( H[3]![0]!+dh)|0,( H[3]![1]!+dl5)|0];
      H[4]=[( H[4]![0]!+eh)|0,( H[4]![1]!+el5)|0];
      H[5]=[( H[5]![0]!+fh)|0,( H[5]![1]!+fl5)|0];
      H[6]=[( H[6]![0]!+gh5)|0,( H[6]![1]!+gl5)|0];
      H[7]=[( H[7]![0]!+hh)|0,( H[7]![1]!+hl5)|0];
    }
    var res512 = new ArrayBuffer(64);
    var dv512 = new DataView(res512);
    for (var pi = 0; pi < 8; pi++) { dv512.setUint32(pi*8, H[pi]![0]!, false); dv512.setUint32(pi*8+4, H[pi]![1]!, false); }
    return res512;
  }

  function _hmacSHA512(key: Uint8Array, data: Uint8Array): ArrayBuffer {
    var blockSz = 128;
    var kp: Uint8Array = key.length > blockSz ? new Uint8Array(_sha512(key)) : key;
    var k = new Uint8Array(blockSz); k.set(kp);
    var ipad = new Uint8Array(blockSz), opad = new Uint8Array(blockSz);
    for (var i = 0; i < blockSz; i++) { ipad[i] = k[i]! ^ 0x36; opad[i] = k[i]! ^ 0x5c; }
    var inner = new Uint8Array(blockSz + data.length);
    inner.set(ipad); inner.set(data, blockSz);
    var innerHash = new Uint8Array(_sha512(inner));
    var outer = new Uint8Array(blockSz + 64);
    outer.set(opad); outer.set(innerHash, blockSz);
    return _sha512(outer);
  }

  // ── AES-GCM pure-TS (256-bit key) ────────────────────────────────────────
  // Based on AES specification (Rijndael) + GCM/GHASH

  var _AES_SBOX = new Uint8Array([
    99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,
    202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,
    183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,
    4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,
    9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,
    83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,
    208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,
    81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,
    205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,
    96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,
    224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,
    231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,
    186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,
    112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,
    225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,
    140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22,
  ]);
  var _AES_RCON = new Uint8Array([0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]);

  function _aesKeyExpand(key: Uint8Array): Uint32Array {
    var W = new Uint32Array(60); // supports 256-bit (14 rounds = 60 words)
    var nk = key.length / 4; // 4, 6, or 8
    var nr = nk + 6;
    for (var i2 = 0; i2 < nk; i2++) {
      W[i2] = (key[i2*4]!<<24)|(key[i2*4+1]!<<16)|(key[i2*4+2]!<<8)|key[i2*4+3]!;
    }
    for (var i2 = nk; i2 < 4*(nr+1); i2++) {
      var temp = W[i2-1]!;
      if (i2 % nk === 0) {
        temp = (((_AES_SBOX[(temp>>>16)&0xff]!<<24)|(_AES_SBOX[(temp>>>8)&0xff]!<<16)|
                 (_AES_SBOX[temp&0xff]!<<8)|_AES_SBOX[(temp>>>24)&0xff]!) ^ (_AES_RCON[(i2/nk)-1]!<<24))|0;
      } else if (nk > 6 && i2 % nk === 4) {
        temp = (_AES_SBOX[(temp>>>24)&0xff]!<<24)|(_AES_SBOX[(temp>>>16)&0xff]!<<16)|
               (_AES_SBOX[(temp>>>8)&0xff]!<<8)|_AES_SBOX[temp&0xff]!;
      }
      W[i2] = W[i2-nk]! ^ temp;
    }
    return W;
  }

  function _xtime(x: number): number { return x & 0x80 ? (((x << 1) ^ 0x1b) & 0xff) : (x << 1) & 0xff; }
  function _gmul(a: number, b: number): number {
    var p = 0;
    for (var i2 = 0; i2 < 8; i2++) { if (b & 1) p ^= a; var hi = a & 0x80; a = (a << 1) & 0xff; if (hi) a ^= 0x1b; b >>= 1; }
    return p;
  }

  function _aesEncryptBlock(state: Uint8Array, W: Uint32Array, nk: number): Uint8Array {
    var nr = nk + 6;
    var s = new Uint8Array(state);
    // AddRoundKey (round 0)
    for (var c3 = 0; c3 < 4; c3++) { var rk = W[c3]!; s[c3*4]^=(rk>>>24)&0xff; s[c3*4+1]^=(rk>>>16)&0xff; s[c3*4+2]^=(rk>>>8)&0xff; s[c3*4+3]^=rk&0xff; }
    for (var rnd = 1; rnd <= nr; rnd++) {
      // SubBytes
      for (var si = 0; si < 16; si++) s[si] = _AES_SBOX[s[si]!]!;
      // ShiftRows
      var t0=s[1]! ;s[1]=s[5]! ;s[5]=s[9]! ;s[9]=s[13]!;s[13]=t0;
      var t1=s[2]! ;var t2=s[6]! ;s[2]=s[10]!;s[6]=s[14]!;s[10]=t1 ;s[14]=t2;
      var t3=s[15]!;s[15]=s[11]!;s[11]=s[7]! ;s[7]=s[3]! ;s[3]=t3;
      // MixColumns (skip last round)
      if (rnd < nr) {
        for (var c3 = 0; c3 < 4; c3++) {
          var s0=s[c3*4]!,s1=s[c3*4+1]!,s2=s[c3*4+2]!,s3=s[c3*4+3]!;
          s[c3*4]  =_gmul(2,s0)^_gmul(3,s1)^s2^s3;
          s[c3*4+1]=s0^_gmul(2,s1)^_gmul(3,s2)^s3;
          s[c3*4+2]=s0^s1^_gmul(2,s2)^_gmul(3,s3);
          s[c3*4+3]=_gmul(3,s0)^s1^s2^_gmul(2,s3);
        }
      }
      // AddRoundKey
      for (var c3 = 0; c3 < 4; c3++) {
        var rk = W[rnd*4+c3]!;
        s[c3*4]^=(rk>>>24)&0xff; s[c3*4+1]^=(rk>>>16)&0xff; s[c3*4+2]^=(rk>>>8)&0xff; s[c3*4+3]^=rk&0xff;
      }
    }
    return s;
  }

  /** Increment 128-bit big-endian counter (last 32 bits as CTR per GCM spec) */
  function _gcmIncr(ctr: Uint8Array): void {
    for (var i2 = 15; i2 >= 12; i2--) { ctr[i2] = (ctr[i2]! + 1) & 0xff; if (ctr[i2] !== 0) break; }
  }

  /** GHASH for AES-GCM (finite-field multiplication in GF(2^128)) */
  function _ghash(H: Uint8Array, data: Uint8Array): Uint8Array {
    var X = new Uint8Array(16);
    for (var i2 = 0; i2 < data.length; i2 += 16) {
      var block = data.slice(i2, i2 + 16);
      for (var j = 0; j < 16; j++) X[j] ^= block[j] ?? 0;
      // GF(2^128) multiply X by H
      var Z = new Uint8Array(16); var V = new Uint8Array(H);
      for (var j = 0; j < 128; j++) {
        if ((X[Math.floor(j/8)]! >> (7 - j%8)) & 1) for (var k2 = 0; k2 < 16; k2++) Z[k2] ^= V[k2]!;
        var lsb = V[15]! & 1;
        for (var k2 = 15; k2 > 0; k2--) V[k2] = ((V[k2]! >>> 1) | ((V[k2-1]! & 1) << 7)) & 0xff;
        V[0] = (V[0]! >>> 1) & 0xff;
        if (lsb) V[0]! ^= 0xe1;
      }
      X = Z;
    }
    return X;
  }

  /** AES-GCM encrypt: returns IV(12) + ciphertext + authTag(16) */
  function _aesGcmEncrypt(keyBytes: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): ArrayBuffer {
    var nk = keyBytes.length / 4;
    var W = _aesKeyExpand(keyBytes);
    // H = AES(K, 0^128)
    var Hblk = _aesEncryptBlock(new Uint8Array(16), W, nk);
    // J0 = IV || 0^31 || 1 (for 96-bit IV)
    var J0 = new Uint8Array(16); J0.set(iv); J0[15] = 1;
    var ctr = new Uint8Array(J0);
    // Encrypt plaintext with CTR mode (starting at J0+1)
    _gcmIncr(ctr);
    var ct = new Uint8Array(plaintext.length);
    for (var i2 = 0; i2 < plaintext.length; i2 += 16) {
      var ks = _aesEncryptBlock(new Uint8Array(ctr), W, nk);
      for (var j = 0; j < 16 && i2+j < plaintext.length; j++) ct[i2+j] = plaintext[i2+j]! ^ ks[j]!;
      _gcmIncr(ctr);
    }
    // GHASH auth tag
    var padCt = ct.length % 16 ? new Uint8Array(Math.ceil(ct.length/16)*16) : ct;
    if (padCt !== ct) padCt.set(ct);
    var padAad = aad.length % 16 ? new Uint8Array(Math.ceil(aad.length/16)*16) : aad;
    if (padAad !== aad) padAad.set(aad);
    var lenBuf = new Uint8Array(16);
    var dv2 = new DataView(lenBuf.buffer);
    dv2.setUint32(4, aad.length * 8, false); dv2.setUint32(12, ct.length * 8, false);
    var ghashInput = new Uint8Array(padAad.length + padCt.length + 16);
    ghashInput.set(padAad); ghashInput.set(padCt, padAad.length); ghashInput.set(lenBuf, padAad.length + padCt.length);
    var S = _ghash(Hblk, ghashInput);
    // Tag = AES(K, J0) XOR S
    var tag = _aesEncryptBlock(new Uint8Array(J0), W, nk);
    for (var i2 = 0; i2 < 16; i2++) tag[i2] ^= S[i2]!;
    var out = new Uint8Array(ct.length + 16);
    out.set(ct); out.set(tag, ct.length);
    return out.buffer;
  }

  /** AES-GCM decrypt: input is ciphertext+tag(16); returns plaintext or throws */
  function _aesGcmDecrypt(keyBytes: Uint8Array, iv: Uint8Array, cipherWithTag: Uint8Array, aad: Uint8Array): ArrayBuffer {
    if (cipherWithTag.length < 16) throw new DOMException('Invalid ciphertext', 'OperationError');
    var ct = cipherWithTag.slice(0, cipherWithTag.length - 16);
    var tagIn = cipherWithTag.slice(cipherWithTag.length - 16);
    var nk = keyBytes.length / 4;
    var W = _aesKeyExpand(keyBytes);
    var Hblk = _aesEncryptBlock(new Uint8Array(16), W, nk);
    var J0 = new Uint8Array(16); J0.set(iv); J0[15] = 1;
    // Verify tag
    var padCt = ct.length % 16 ? new Uint8Array(Math.ceil(ct.length/16)*16) : ct;
    if (padCt !== ct) padCt.set(ct);
    var padAad = aad.length % 16 ? new Uint8Array(Math.ceil(aad.length/16)*16) : aad;
    if (padAad !== aad) padAad.set(aad);
    var lenBuf = new Uint8Array(16);
    var dv2 = new DataView(lenBuf.buffer);
    dv2.setUint32(4, aad.length * 8, false); dv2.setUint32(12, ct.length * 8, false);
    var ghashInput = new Uint8Array(padAad.length + padCt.length + 16);
    ghashInput.set(padAad); ghashInput.set(padCt, padAad.length); ghashInput.set(lenBuf, padAad.length + padCt.length);
    var S = _ghash(Hblk, ghashInput);
    var tagExpected = _aesEncryptBlock(new Uint8Array(J0), W, nk);
    for (var i2 = 0; i2 < 16; i2++) tagExpected[i2] ^= S[i2]!;
    var tagOk = true; for (var i2 = 0; i2 < 16; i2++) if (tagIn[i2] !== tagExpected[i2]) { tagOk = false; break; }
    if (!tagOk) throw new DOMException('The operation failed for an operation-specific reason', 'OperationError');
    // Decrypt (same CTR)
    var ctr = new Uint8Array(J0); _gcmIncr(ctr);
    var pt = new Uint8Array(ct.length);
    for (var i2 = 0; i2 < ct.length; i2 += 16) {
      var ks = _aesEncryptBlock(new Uint8Array(ctr), W, nk);
      for (var j = 0; j < 16 && i2+j < ct.length; j++) pt[i2+j] = ct[i2+j]! ^ ks[j]!;
      _gcmIncr(ctr);
    }
    return pt.buffer;
  }

  /** Convert digest input to Uint8Array */
  function _toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array((data as any).buffer, (data as any).byteOffset, (data as any).byteLength);
    if (typeof data === 'string') {
      var enc = new Array<number>();
      for (var i = 0; i < data.length; i++) {
        var cp = data.charCodeAt(i);
        if (cp < 0x80) enc.push(cp);
        else if (cp < 0x800) { enc.push(0xc0|(cp>>6), 0x80|(cp&0x3f)); }
        else { enc.push(0xe0|(cp>>12), 0x80|((cp>>6)&0x3f), 0x80|(cp&0x3f)); }
      }
      return new Uint8Array(enc);
    }
    return new Uint8Array(0);
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
    // crypto.subtle — real SHA-256, real HMAC-SHA256/SHA512, real AES-GCM (item 949)
    subtle: {
      digest(algo: unknown, data: unknown): Promise<ArrayBuffer> {
        var name = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        name = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
        var bytes = _toBytes(data);
        if (name === 'SHA256') return Promise.resolve(_sha256(bytes));
        if (name === 'SHA512') return Promise.resolve(_sha512(bytes));
        // SHA-1: 20 bytes, SHA-384: 48 bytes
        var sz = name.includes('512') ? 64 : name.includes('384') ? 48 : name.includes('1') ? 20 : 32;
        return Promise.resolve(new ArrayBuffer(sz));
      },
      sign(algo: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
        var algoName = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        algoName = algoName.toUpperCase().replace(/[^A-Z0-9]/g, '');
        var keyBytes = (key as any)?._raw as Uint8Array | undefined;
        var dataBytes = _toBytes(data);
        if (algoName === 'HMAC' || algoName.startsWith('HMAC')) {
          if (!keyBytes) keyBytes = new Uint8Array(32); // fallback zero key
          var hashAlgo = ((algo as any)?.hash?.name || (algo as any)?.hash || 'SHA-256').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (hashAlgo === 'SHA512') return Promise.resolve(_hmacSHA512(keyBytes, dataBytes));
          return Promise.resolve(_hmacSHA256(keyBytes, dataBytes));
        }
        return Promise.resolve(new ArrayBuffer(64));
      },
      verify(algo: unknown, key: unknown, sig: unknown, data: unknown): Promise<boolean> {
        var algoName = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        algoName = algoName.toUpperCase().replace(/[^A-Z0-9]/g, '');
        var keyBytes = (key as any)?._raw as Uint8Array | undefined;
        var dataBytes = _toBytes(data);
        var sigBytes = _toBytes(sig);
        if (algoName === 'HMAC' || algoName.startsWith('HMAC')) {
          if (!keyBytes) keyBytes = new Uint8Array(32);
          var hashAlgo = ((algo as any)?.hash?.name || (algo as any)?.hash || 'SHA-256').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
          var expected = new Uint8Array(hashAlgo === 'SHA512' ? _hmacSHA512(keyBytes, dataBytes) : _hmacSHA256(keyBytes, dataBytes));
          if (expected.length !== sigBytes.length) return Promise.resolve(false);
          var ok = true; for (var vi = 0; vi < expected.length; vi++) if (expected[vi] !== sigBytes[vi]) { ok = false; break; }
          return Promise.resolve(ok);
        }
        return Promise.resolve(false);
      },
      encrypt(algo: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
        var algoName = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        if (/aes.?gcm/i.test(algoName)) {
          var keyBytes = (key as any)?._raw as Uint8Array | undefined;
          if (!keyBytes) return Promise.resolve(new ArrayBuffer(16));
          var iv = _toBytes((algo as any)?.iv || new Uint8Array(12));
          var aad = _toBytes((algo as any)?.additionalData || new Uint8Array(0));
          try { return Promise.resolve(_aesGcmEncrypt(keyBytes, iv, _toBytes(data), aad)); }
          catch(e) { return Promise.reject(e); }
        }
        return Promise.resolve(new ArrayBuffer(16));
      },
      decrypt(algo: unknown, key: unknown, data: unknown): Promise<ArrayBuffer> {
        var algoName = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        if (/aes.?gcm/i.test(algoName)) {
          var keyBytes = (key as any)?._raw as Uint8Array | undefined;
          if (!keyBytes) return Promise.resolve(new ArrayBuffer(0));
          var iv = _toBytes((algo as any)?.iv || new Uint8Array(12));
          var aad = _toBytes((algo as any)?.additionalData || new Uint8Array(0));
          try { return Promise.resolve(_aesGcmDecrypt(keyBytes, iv, _toBytes(data), aad)); }
          catch(e) { return Promise.reject(e); }
        }
        return Promise.resolve(new ArrayBuffer(0));
      },
      generateKey(algo: unknown, extr: boolean, usages: string[]): Promise<unknown> {
        var algoName = typeof algo === 'string' ? algo : (algo as any)?.name || '';
        var keyLen = (algo as any)?.length || ((algo as any)?.modulusLength) || 256;
        var rawKey = new Uint8Array(keyLen >> 3 || 32);
        for (var gi = 0; gi < rawKey.length; gi++) rawKey[gi] = Math.floor(Math.random() * 256) | 0;
        var ck = { type: 'secret', algorithm: algo, extractable: extr, usages, _raw: rawKey };
        if (/ec|rsa/i.test(algoName)) {
          return Promise.resolve({ privateKey: { type:'private', algorithm:algo, extractable:extr, usages, _raw:rawKey }, publicKey: { type:'public', algorithm:algo, extractable:extr, usages, _raw:rawKey } });
        }
        return Promise.resolve(ck);
      },
      importKey(fmt: unknown, kd: unknown, algo: unknown, extr: boolean, usages: string[]): Promise<unknown> {
        var rawBytes: Uint8Array;
        if (fmt === 'raw' && (kd instanceof ArrayBuffer || ArrayBuffer.isView(kd))) {
          rawBytes = _toBytes(kd);
        } else if (fmt === 'jwk' && typeof kd === 'object' && kd) {
          // Extract key bytes from JWK k field (base64url)
          var kStr = (kd as any).k || '';
          var bin = atob(kStr.replace(/-/g,'+').replace(/_/g,'/') + '=='.slice(0,(4-kStr.length%4)%4));
          rawBytes = new Uint8Array(bin.length); for (var ii = 0; ii < bin.length; ii++) rawBytes[ii] = bin.charCodeAt(ii);
        } else {
          rawBytes = new Uint8Array(32);
        }
        return Promise.resolve({ type: 'secret', algorithm: algo, extractable: extr, usages, _raw: rawBytes });
      },
      exportKey(fmt: unknown, key: unknown): Promise<unknown> {
        var raw = (key as any)?._raw as Uint8Array | undefined;
        if (fmt === 'raw') return Promise.resolve(raw ? raw.buffer : new ArrayBuffer(0));
        if (fmt === 'jwk') {
          var b64 = raw ? btoa(String.fromCharCode(...Array.from(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'') : '';
          return Promise.resolve({ kty:'oct', k:b64, alg:'HS256', key_ops:(key as any)?.usages||[] });
        }
        return Promise.resolve({});
      },
      deriveKey(_algo: unknown, _base: unknown, _der: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages, _raw: new Uint8Array(32) }); },
      deriveBits(_algo: unknown, _base: unknown, _len: number): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(_len >> 3)); },
      wrapKey(_fmt: unknown, _key: unknown, _wk: unknown, _algo: unknown): Promise<ArrayBuffer> { return Promise.resolve(new ArrayBuffer(32)); },
      unwrapKey(_fmt: unknown, _d: unknown, _uk: unknown, _a1: unknown, _a2: unknown, _extr: boolean, _usages: string[]): Promise<unknown> { return Promise.resolve({ type: 'secret', algorithm: {}, extractable: _extr, usages: _usages, _raw: new Uint8Array(32) }); },
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
  var _ceWhenDefined: Map<string, Array<(ctor: unknown) => void>> = new Map();
  var customElementsAPI = {
    define(name: string, ctor: unknown, _opts?: unknown): void {
      var lower = name.toLowerCase();
      _ceRegistry.set(lower, ctor);
      // Resolve any pending whenDefined promises
      var waiters = _ceWhenDefined.get(lower);
      if (waiters) { waiters.forEach(fn => { try { fn(ctor); } catch(_) {} }); _ceWhenDefined.delete(lower); }
    },
    get(name: string): unknown | undefined { return _ceRegistry.get(name.toLowerCase()); },
    whenDefined(name: string): Promise<unknown> {
      var lower = name.toLowerCase();
      if (_ceRegistry.has(lower)) return Promise.resolve(_ceRegistry.get(lower));
      return new Promise<unknown>(function(resolve) {
        var arr = _ceWhenDefined.get(lower);
        if (!arr) { arr = []; _ceWhenDefined.set(lower, arr); }
        arr.push(resolve);
      });
    },
    upgrade(root: unknown): void {
      function _walk(el: any): void {
        if (!el || !el.tagName) return;
        var tag = el.tagName.toLowerCase();
        var cctor = _ceRegistry.get(tag);
        if (cctor && !el._ceUpgraded) {
          el._ceUpgraded = true;
          var proto = (cctor as any).prototype;
          if (proto) {
            // Copy CE prototype methods onto the element if not already set
            for (var _k in proto) {
              if (!(el[_k] !== undefined && el.hasOwnProperty(_k))) {
                try { el[_k] = proto[_k]; } catch(_) {}
              }
            }
            if (typeof el.connectedCallback === 'function') {
              try { el.connectedCallback(); } catch (err) {}
            }
          }
        }
        var ch: any[] = el.childNodes || [];
        for (var _i = 0; _i < ch.length; _i++) _walk(ch[_i]);
        if (el.shadowRoot) _walk(el.shadowRoot);
      }
      _walk((root as VElement) || doc.documentElement);
    },
    getName(_ctor: unknown): string | null {
      for (var [k, v] of _ceRegistry) { if (v === _ctor) return k; }
      return null;
    },
  };

  // ── Streams API (ReadableStream, WritableStream, TransformStream) ─────────
  // Minimal stubs — complete enough for feature-detection by frameworks.

  // â”€â”€ WebCodecs (Chrome 94+) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ── Media Source Extensions (MSE, Chrome 31+) ─────────────────────────────
  // Used by YouTube, Netflix, Twitch etc. for adaptive bitrate streaming.
  class TimeRanges_ {
    _ranges: [number, number][];
    constructor(ranges: [number, number][] = []) { this._ranges = ranges; }
    get length(): number { return this._ranges.length; }
    start(i: number): number { return this._ranges[i]?.[0] ?? 0; }
    end(i:   number): number { return this._ranges[i]?.[1] ?? 0; }
  }
  class SourceBuffer_ extends VEventTarget {
    mode: string = 'segments'; updating: boolean = false;
    buffered: TimeRanges_ = new TimeRanges_();
    timestampOffset = 0; appendWindowStart = 0; appendWindowEnd = Infinity;
    audioTracks: unknown[] = []; videoTracks: unknown[] = []; textTracks: unknown[] = [];
    onupdatestart: ((e: VEvent) => void) | null = null;
    onupdate:      ((e: VEvent) => void) | null = null;
    onupdateend:   ((e: VEvent) => void) | null = null;
    onerror:       ((e: VEvent) => void) | null = null;
    onabort:       ((e: VEvent) => void) | null = null;
    appendBuffer(_data: unknown): void {
      this.updating = true;
      this.dispatchEvent(new VEvent('updatestart'));
      Promise.resolve().then(() => {
        this.updating = false;
        this.dispatchEvent(new VEvent('update'));
        this.dispatchEvent(new VEvent('updateend'));
      });
    }
    remove(_start: number, _end: number): void {}
    abort(): void { this.updating = false; this.dispatchEvent(new VEvent('abort')); }
    changeType(_type: string): void {}
  }
  class MediaSource_ extends VEventTarget {
    readyState: 'closed' | 'open' | 'ended' = 'closed';
    duration: number = NaN;
    sourceBuffers: SourceBuffer_[] = [];
    activeSourceBuffers: SourceBuffer_[] = [];
    onsourceopen:  ((e: VEvent) => void) | null = null;
    onsourceended: ((e: VEvent) => void) | null = null;
    onsourceclose: ((e: VEvent) => void) | null = null;
    static isTypeSupported(mimeType: string): boolean {
      var m = mimeType.toLowerCase();
      return m.startsWith('video/mp4') || m.startsWith('video/webm') ||
             m.startsWith('audio/mp4') || m.startsWith('audio/aac') ||
             m.startsWith('audio/mpeg') || m.startsWith('audio/webm');
    }
    addSourceBuffer(_type: string): SourceBuffer_ {
      var sb = new SourceBuffer_();
      this.sourceBuffers.push(sb); this.activeSourceBuffers.push(sb);
      return sb;
    }
    removeSourceBuffer(sb: SourceBuffer_): void {
      this.sourceBuffers = this.sourceBuffers.filter(s => s !== sb);
      this.activeSourceBuffers = this.activeSourceBuffers.filter(s => s !== sb);
    }
    endOfStream(_reason?: string): void {
      this.readyState = 'ended'; this.dispatchEvent(new VEvent('sourceended'));
    }
    clearLiveSeekableRange(): void {}
    setLiveSeekableRange(_start: number, _end: number): void {}
  }

  class VideoColorSpace_ {
    fullRange = false; matrix = "rgb"; primaries = "bt709"; transfer = "iec61966-2-1";
    constructor(_init?: unknown) {}
    toJSON(): unknown { return { fullRange: this.fullRange, matrix: this.matrix, primaries: this.primaries, transfer: this.transfer }; }
  }
  class EncodedVideoChunk_ {
    type: string; timestamp: number; duration: number | null; byteLength: number;
    constructor(init: any) { this.type = init?.type ?? "key"; this.timestamp = init?.timestamp ?? 0; this.duration = init?.duration ?? null; this.byteLength = (init?.data?.byteLength ?? 0); }
    copyTo(_dest: unknown): void {}
  }
  class EncodedAudioChunk_ {
    type: string; timestamp: number; duration: number | null; byteLength: number;
    constructor(init: any) { this.type = init?.type ?? "key"; this.timestamp = init?.timestamp ?? 0; this.duration = init?.duration ?? null; this.byteLength = (init?.data?.byteLength ?? 0); }
    copyTo(_dest: unknown): void {}
  }
  class VideoFrame_ {
    codedWidth = 0; codedHeight = 0; displayWidth = 0; displayHeight = 0;
    timestamp: number; duration: number | null; colorSpace: VideoColorSpace_;
    constructor(_init: unknown, opts?: any) {
      this.timestamp = opts?.timestamp ?? 0; this.duration = opts?.duration ?? null;
      this.colorSpace = new VideoColorSpace_();
    }
    allocationSize(_opts?: unknown): number { return this.codedWidth * this.codedHeight * 4; }
    copyTo(_dest: unknown, _opts?: unknown): Promise<unknown> { return Promise.resolve([]); }
    clone(): VideoFrame_ { return new VideoFrame_(null, { timestamp: this.timestamp }); }
    close(): void {}
  }
  class AudioData_ {
    format = "f32"; sampleRate = 48000; numberOfFrames = 0; numberOfChannels = 1;
    duration = 0; timestamp: number;
    constructor(init: any) { this.timestamp = init?.timestamp ?? 0; }
    allocationSize(_opts?: unknown): number { return this.numberOfFrames * 4; }
    copyTo(_dest: unknown, _opts?: unknown): void {}
    clone(): AudioData_ { return new AudioData_({ timestamp: this.timestamp }); }
    close(): void {}
  }
  // Helper: is a codec string a known video/audio type?
  function _wcIsVideoSupported(cfg: any): boolean {
    var c = (cfg?.codec ?? '').toLowerCase();
    return c.startsWith('vp8') || c.startsWith('vp09') || c.startsWith('vp9') ||
           c.startsWith('avc1') || c.startsWith('av01') || c.startsWith('hev1') ||
           c.startsWith('hvc1') || c.startsWith('theora');
  }
  function _wcIsAudioSupported(cfg: any): boolean {
    var c = (cfg?.codec ?? '').toLowerCase();
    return c.startsWith('opus') || c.startsWith('vorbis') || c.startsWith('mp4a') ||
           c.startsWith('aac') || c.startsWith('flac') || c.startsWith('pcm');
  }
  class VideoDecoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0; _init: any; _cfg: any = null;
    constructor(init: any) { super(); this._init = init; }
    configure(cfg: unknown): void { this.state = "configured"; this._cfg = cfg; }
    decode(chunk: unknown): void {
      if (this.state !== 'configured' || !this._init?.output) return;
      var outCb = this._init.output;
      Promise.resolve().then(() => {
        var frame = new VideoFrame_(null, { timestamp: (chunk as any)?.timestamp ?? 0 });
        frame.codedWidth = 1; frame.codedHeight = 1; frame.displayWidth = 1; frame.displayHeight = 1;
        try { outCb(frame); } catch (_) {}
      });
    }
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; this._cfg = null; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(cfg: unknown): Promise<unknown> {
      var ok = _wcIsVideoSupported(cfg as any);
      return Promise.resolve({ supported: ok, config: ok ? cfg : undefined });
    }
  }
  class VideoEncoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; encodeQueueSize = 0;
    constructor(_init: any) { super(); }
    configure(_cfg: unknown): void { this.state = "configured"; }
    encode(_frame: unknown, _opts?: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(cfg: unknown): Promise<unknown> {
      var ok = _wcIsVideoSupported(cfg as any);
      return Promise.resolve({ supported: ok, config: ok ? cfg : undefined });
    }
  }
  class AudioDecoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; decodeQueueSize = 0; _init: any; _cfg: any = null;
    constructor(init: any) { super(); this._init = init; }
    configure(cfg: unknown): void { this.state = "configured"; this._cfg = cfg; }
    decode(chunk: unknown): void {
      if (this.state !== 'configured' || !this._init?.output) return;
      var outCb = this._init.output;
      Promise.resolve().then(() => {
        var data = new AudioData_({ timestamp: (chunk as any)?.timestamp ?? 0 });
        try { outCb(data); } catch (_) {}
      });
    }
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; this._cfg = null; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(cfg: unknown): Promise<unknown> {
      var ok = _wcIsAudioSupported(cfg as any);
      return Promise.resolve({ supported: ok, config: ok ? cfg : undefined });
    }
  }
  class AudioEncoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; encodeQueueSize = 0;
    constructor(_init: any) { super(); }
    configure(_cfg: unknown): void { this.state = "configured"; }
    encode(_data: unknown, _opts?: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(cfg: unknown): Promise<unknown> {
      var ok = _wcIsAudioSupported(cfg as any);
      return Promise.resolve({ supported: ok, config: ok ? cfg : undefined });
    }
  }
  class ImageTrack_ {
    animated = false; frameCount = 1; repetitionCount = 0; selected = true;
  }
  class ImageTrackList_ {
    length = 0; selectedIndex = -1; selectedTrack: ImageTrack_ | null = null;
    ready: Promise<void> = Promise.resolve();
    [Symbol.iterator](): Iterator<ImageTrack_> { return ([] as ImageTrack_[])[Symbol.iterator](); }
  }
  class ImageDecoder_ {
    complete = false; type = ""; tracks = new ImageTrackList_();
    constructor(_init: unknown) {}
    decode(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    reset(): void {} close(): void {}
    static isTypeSupported(_t: string): Promise<boolean> { return Promise.resolve(false); }
  }
  // Navigation API event constructors (Chrome 102+)
  class NavigateEvent_ extends VEvent {
    canIntercept: boolean; destination: unknown; downloadRequest: string | null;
    formData: FormData | null; hashChange: boolean; info: unknown;
    navigationType: string; signal: AbortSignal;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.canIntercept = init.canIntercept ?? false; this.destination = init.destination ?? null;
      this.downloadRequest = init.downloadRequest ?? null; this.formData = init.formData ?? null;
      this.hashChange = init.hashChange ?? false; this.info = init.info ?? undefined;
      this.navigationType = init.navigationType ?? "push";
      this.signal = init.signal ?? new AbortController().signal;
    }
    intercept(_opts?: unknown): void {}
    scroll(): void {}
  }
  class NavigationCurrentEntryChangeEvent_ extends VEvent {
    from: unknown; navigationType: string | null;
    constructor(type: string, init: any = {}) {
      super(type, init); this.from = init.from ?? null; this.navigationType = init.navigationType ?? null;
    }
  }
  // Scroll-driven animations (Chrome 115+)
  class ScrollTimeline_ {
    axis: string; source: unknown | null;
    constructor(opts: any = {}) { this.axis = opts.axis ?? "block"; this.source = opts.source ?? null; }
    get currentTime(): unknown {
      // Return CSS percentage (0–100) representing how far the page has scrolled
      var scrollY = cb.getScrollY();
      var docEl = (win['document'] as any)?.documentElement;
      var docH = docEl?.scrollHeight || 768;
      var viewH = ((win['innerHeight'] as number) || 768);
      var maxScroll = Math.max(1, docH - viewH);
      return { value: Math.min(100, Math.max(0, (scrollY / maxScroll) * 100)), unit: 'percent' };
    }
  }
  class ViewTimeline_ {
    axis: string; subject: unknown | null; startOffset: unknown; endOffset: unknown;
    constructor(opts: any = {}) {
      this.axis = opts.axis ?? "block"; this.subject = opts.subject ?? null;
      this.startOffset = null; this.endOffset = null;
    }
    get currentTime(): unknown {
      // Approximate scroll progress relative to viewport size
      var scrollY = cb.getScrollY();
      var viewH = ((win['innerHeight'] as number) || 768);
      return { value: Math.min(100, Math.max(0, (scrollY / Math.max(1, viewH)) * 100)), unit: 'percent' };
    }
  }
  // Reporting API (Chrome 69+)
  class ReportingObserver_ {
    _cb: (reports: unknown[], obs: ReportingObserver_) => void;
    constructor(cb: (reports: unknown[], obs: ReportingObserver_) => void, _opts?: unknown) { this._cb = cb; }
    observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; }
  }
  // ContactsManager (Android Chrome 80+)
  class ContactsManager_ {
    getProperties(): Promise<string[]> { return Promise.resolve(["name", "email", "tel", "address", "icon"]); }
    select(_props: string[], _opts?: unknown): Promise<unknown[]> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
  }
  // PictureInPictureWindow
  class PictureInPictureWindow_ extends VEventTarget {
    width = 0; height = 0;
    onresize: ((ev: VEvent) => void) | null = null;
  }
  // PushManager / PushSubscription (Chrome 42+)
  class PushSubscription_ {
    endpoint = ""; expirationTime: number | null = null;
    options = { applicationServerKey: null as unknown, userVisibleOnly: true };
    getKey(_name: string): ArrayBuffer | null { return null; }
    toJSON(): unknown { return { endpoint: this.endpoint, expirationTime: this.expirationTime, keys: {} }; }
    unsubscribe(): Promise<boolean> { return Promise.resolve(false); }
  }
  class PushManager_ {
    permissionState(_opts?: unknown): Promise<string> { return Promise.resolve("denied"); }
    subscribe(_opts?: unknown): Promise<PushSubscription_> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    getSubscription(): Promise<PushSubscription_ | null> { return Promise.resolve(null); }
  }
  // SyncManager / PeriodicSyncManager (Chrome 49+/80+)
  class SyncManager_ {
    register(_tag: string): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    getTags(): Promise<string[]> { return Promise.resolve([]); }
  }
  class PeriodicSyncManager_ {
    register(_tag: string, _opts?: unknown): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    unregister(_tag: string): Promise<void> { return Promise.resolve(); }
    getTags(): Promise<string[]> { return Promise.resolve([]); }
  }
  // PageRevealEvent (Chrome 123+)
  class PageRevealEvent_ extends VEvent {
    viewTransition: unknown | null;
    constructor(type: string, init: any = {}) { super(type, init); this.viewTransition = init.viewTransition ?? null; }
  }
  // SnapEvent (CSS Scroll Snap, Chrome 129+)
  class SnapEvent_ extends VEvent {
    snapTargetBlock: unknown | null; snapTargetInline: unknown | null;
    constructor(type: string, init: any = {}) {
      super(type, init); this.snapTargetBlock = init.snapTargetBlock ?? null; this.snapTargetInline = init.snapTargetInline ?? null;
    }
  }
  // CSSPropertyRule (Houdini Properties & Values, Chrome 85+)
  class CSSPropertyRule_ extends CSSRule_ {
    name = ""; syntax = "*"; inherits = false; initialValue: string | null = null;
    constructor(init: any = {}) {
      super(); this.name = init.name ?? ""; this.syntax = init.syntax ?? "*";
      this.inherits = init.inherits ?? false; this.initialValue = init.initialValue ?? null;
    }
  }
  // ResizeObserverSize (Chrome 84+)
  class ResizeObserverSize_ {
    blockSize: number; inlineSize: number;
    constructor(inline = 0, block = 0) { this.inlineSize = inline; this.blockSize = block; }
  }
  // TransformStreamDefaultController
  class TransformStreamDefaultController_ {
    desiredSize: number | null = 1;
    enqueue(_chunk: unknown): void {}
    error(_reason?: unknown): void {}
    terminate(): void {}
  }
  // ScreenOrientation (Chrome 38+)
  class ScreenOrientation_ extends VEventTarget {
    angle = 0; type = "landscape-primary";
    onchange: ((ev: VEvent) => void) | null = null;
    lock(_orientation: string): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    unlock(): void {}
  }
  // CSS Typed OM stubs (Chrome 66+)
  class CSSStyleValue_ {
    toString(): string { return ""; }
    static parse(_p: string, _v: string): CSSStyleValue_ { return new CSSStyleValue_(); }
    static parseAll(_p: string, _v: string): CSSStyleValue_[] { return []; }
  }
  class CSSNumericValue_ extends CSSStyleValue_ {
    value = 0; unit = "";
    constructor(v = 0, u = "") { super(); this.value = v; this.unit = u; }
    add(..._vals: unknown[]): CSSNumericValue_ { return this; }
    sub(..._vals: unknown[]): CSSNumericValue_ { return this; }
    mul(..._vals: unknown[]): CSSNumericValue_ { return this; }
    div(..._vals: unknown[]): CSSNumericValue_ { return this; }
    min(..._vals: unknown[]): CSSNumericValue_ { return this; }
    max(..._vals: unknown[]): CSSNumericValue_ { return this; }
    equals(..._vals: unknown[]): boolean { return false; }
    to(_unit: string): CSSNumericValue_ { return this; }
    toSum(..._units: string[]): CSSNumericValue_ { return this; }
    type(): unknown { return {}; }
  }
  class CSSUnitValue_ extends CSSNumericValue_ {
    constructor(value: number, unit: string) { super(value, unit); }
    toString(): string { return `${this.value}${this.unit}`; }
  }
  class CSSKeywordValue_ extends CSSStyleValue_ {
    value: string;
    constructor(v: string) { super(); this.value = v; }
    toString(): string { return this.value; }
  }
  class StylePropertyMap_ {
    _map = new Map<string, CSSStyleValue_>();
    get(property: string): CSSStyleValue_ | undefined { return this._map.get(property); }
    getAll(property: string): CSSStyleValue_[] { var v = this._map.get(property); return v ? [v] : []; }
    has(property: string): boolean { return this._map.has(property); }
    set(property: string, ...values: unknown[]): void { this._map.set(property, values[0] as CSSStyleValue_); }
    append(_property: string, ..._values: unknown[]): void {}
    delete(property: string): void { this._map.delete(property); }
    clear(): void { this._map.clear(); }
    forEach(fn: (v: CSSStyleValue_, k: string, m: StylePropertyMap_) => void): void { this._map.forEach((v, k) => fn(v, k, this)); }
    get size(): number { return this._map.size; }
    entries(): IterableIterator<[string, CSSStyleValue_]> { return this._map.entries(); }
    keys(): IterableIterator<string> { return this._map.keys(); }
    values(): IterableIterator<CSSStyleValue_> { return this._map.values(); }
    [Symbol.iterator](): IterableIterator<[string, CSSStyleValue_]> { return this._map.entries(); }
  }
  // Sanitizer API (Chrome 105+)
  class Sanitizer_ {
    _config: unknown;
    constructor(config?: unknown) { this._config = config; }
    sanitize(_input: unknown): unknown { return _input; }
    sanitizeFor(_element: string, _input: string): unknown { return null; }
    getConfiguration(): unknown { return this._config ?? {}; }
    static getDefaultConfiguration(): unknown { return {}; }
  }
  // Trusted Types stubs (Chrome 83+)
  class TrustedHTML_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedScript_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedScriptURL_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedTypePolicy_ {
    name: string;
    constructor(name: string, _rules: unknown) { this.name = name; }
    createHTML(input: string, ..._args: unknown[]): TrustedHTML_ { return new TrustedHTML_(input); }
    createScript(input: string, ..._args: unknown[]): TrustedScript_ { return new TrustedScript_(input); }
    createScriptURL(input: string, ..._args: unknown[]): TrustedScriptURL_ { return new TrustedScriptURL_(input); }
  }
  class TrustedTypePolicyFactory_ {
    _policies = new Map<string, TrustedTypePolicy_>();
    defaultPolicy: TrustedTypePolicy_ | null = null;
    emptyHTML: TrustedHTML_ = new TrustedHTML_("");
    emptyScript: TrustedScript_ = new TrustedScript_("");
    createPolicy(name: string, rules?: unknown): TrustedTypePolicy_ {
      var p = new TrustedTypePolicy_(name, rules ?? {});
      this._policies.set(name, p);
      if (name === "default") this.defaultPolicy = p;
      return p;
    }
    isHTML(val: unknown): val is TrustedHTML_ { return val instanceof TrustedHTML_; }
    isScript(val: unknown): val is TrustedScript_ { return val instanceof TrustedScript_; }
    isScriptURL(val: unknown): val is TrustedScriptURL_ { return val instanceof TrustedScriptURL_; }
    getAttributeType(_tagName: string, _attr: string, _ns?: string): string | null { return null; }
    getPropertyType(_tagName: string, _prop: string, _ns?: string): string | null { return null; }
    getPolicyNames(): string[] { return [...this._policies.keys()]; }
    getTypeMapping(_ns?: string): unknown { return {}; }
  }
  // MessagePort (Chrome 1+) - needed for MessageChannel
  class MessagePort_ extends VEventTarget {
    onmessage: ((ev: VEvent) => void) | null = null;
    onmessageerror: ((ev: VEvent) => void) | null = null;
    _other: MessagePort_ | null = null;
    postMessage(data: unknown, _transfer?: unknown): void {
      var port = this._other;
      if (!port) return;
      var ev = new VEvent("message", { bubbles: false, cancelable: false });
      (ev as any).data = data; (ev as any).source = null; (ev as any).lastEventId = ""; (ev as any).origin = "";
      setTimeout_(() => { try { port!.dispatchEvent(ev); } catch(_) {} }, 0);
    }
    start(): void {}
    close(): void {}
  }
  // WakeLockSentinel (Screen Wake Lock API, Chrome 84+)
  class WakeLockSentinel_ extends VEventTarget {
    released = false; type = "screen";
    onrelease: ((ev: VEvent) => void) | null = null;
    release(): Promise<void> { this.released = true; return Promise.resolve(); }
  }
  // LockManager (Web Locks API, Chrome 69+)
  class Lock_ {
    mode: string; name: string;
    constructor(name: string, mode: string) { this.name = name; this.mode = mode; }
  }
  class LockManager_ {
    request(name: string, cbOrOptions: unknown, cb?: (lock: Lock_) => unknown): Promise<unknown> {
      var theCb = typeof cbOrOptions === "function" ? cbOrOptions as (lock: Lock_) => unknown : cb;
      var opts: any = typeof cbOrOptions === "object" && cbOrOptions !== null ? cbOrOptions : {};
      var mode = opts.mode ?? "exclusive";
      if (!theCb) return Promise.resolve();
      var lock = new Lock_(name, mode);
      try { var result = (theCb as any)(lock); return Promise.resolve(result); } catch(e) { return Promise.reject(e); }
    }
    query(): Promise<unknown> { return Promise.resolve({ held: [], pending: [] }); }
  }
  // CacheStorage / Cache (Service Worker Caches API, Chrome 43+)
  class Cache_ {
    _entries: Map<string, unknown> = new Map();
    match(request: unknown, _opts?: unknown): Promise<unknown> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      return Promise.resolve(this._entries.get(url) ?? undefined);
    }
    matchAll(request?: unknown, _opts?: unknown): Promise<unknown[]> {
      if (!request) return Promise.resolve([...this._entries.values()]);
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      var v = this._entries.get(url); return Promise.resolve(v ? [v] : []);
    }
    add(_request: unknown): Promise<void> { return Promise.resolve(); }
    addAll(_requests: unknown[]): Promise<void> { return Promise.resolve(); }
    put(request: unknown, _response: unknown): Promise<void> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      this._entries.set(url, _response); return Promise.resolve();
    }
    delete(request: unknown, _opts?: unknown): Promise<boolean> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      return Promise.resolve(this._entries.delete(url));
    }
    keys(_request?: unknown, _opts?: unknown): Promise<unknown[]> { return Promise.resolve([...this._entries.keys()]); }
  }
  class CacheStorage_ {
    _caches: Map<string, Cache_> = new Map();
    match(request: unknown, opts?: unknown): Promise<unknown> {
      for (var cache of this._caches.values()) {
        var url = typeof request === "string" ? request : (request as any)?.url ?? "";
        if (cache._entries.has(url)) return cache.match(request, opts);
      }
      return Promise.resolve(undefined);
    }
    has(cacheName: string): Promise<boolean> { return Promise.resolve(this._caches.has(cacheName)); }
    open(cacheName: string): Promise<Cache_> {
      if (!this._caches.has(cacheName)) this._caches.set(cacheName, new Cache_());
      return Promise.resolve(this._caches.get(cacheName)!);
    }
    delete(cacheName: string): Promise<boolean> { return Promise.resolve(this._caches.delete(cacheName)); }
    keys(): Promise<string[]> { return Promise.resolve([...this._caches.keys()]); }
  }
  // ── Service Worker Fetch intercept (Phase 6.7) ──────────────────────────────

  /** FetchEvent delivered to SW fetch handlers via respondWith(). */
  class FetchEvent_ extends VEvent {
    request: Request_;
    _respondWithPromise: Promise<unknown> | null = null;
    _responded = false;
    constructor(request: Request_) {
      super('fetch');
      this.request = request;
    }
    respondWith(responsePromise: Promise<unknown>): void {
      this._responded = true;
      this._respondWithPromise = Promise.resolve(responsePromise);
    }
    waitUntil(_promise: Promise<unknown>): void { /* SW lifecycle bookkeeping, noop */ }
    get clientId(): string { return ''; }
    get resultingClientId(): string { return ''; }
    get handled(): Promise<undefined> { return Promise.resolve(undefined); }
  }

  /** ExtendableEvent for SW install / activate lifecycle. */
  class ExtendableEvent_ extends VEvent {
    waitUntil(_promise: Promise<unknown>): void { /* noop */ }
  }

  /**
   * Simulated ServiceWorkerGlobalScope — the `self` context in which SW scripts
   * are eval'd.  addEventListener('fetch', handler) is stored here;
   * _interceptFetch() is called by fetchAPI to dispatch FetchEvent_.
   */
  class ServiceWorkerGlobalScope_ extends VEventTarget {
    _swScriptURL: string;
    _swScope: string;
    caches = new CacheStorage_();
    clients = {
      claim():                           Promise<void>      { return Promise.resolve(); },
      get(_id: string):                  Promise<unknown>   { return Promise.resolve(null); },
      matchAll(_opts?: unknown):         Promise<unknown[]> { return Promise.resolve([]); },
      openWindow(_url: string):          Promise<unknown>   { return Promise.resolve(null); },
    };
    registration: unknown = null;
    constructor(scriptURL: string, scope: string) {
      super();
      this._swScriptURL = scriptURL;
      this._swScope = scope;
    }
    skipWaiting():                       Promise<void>      { return Promise.resolve(); }
    importScripts(..._urls: string[]):   void               { /* intentional no-op: dynamic imports not supported */ }
    /** SW's own network requests bypass the SW intercept to avoid infinite recursion. */
    fetch(url: string, opts?: any):      Promise<unknown>   { return fetchAPI(url, opts); }
    /** Dispatch a FetchEvent; return respondWith() promise when set, else null. */
    _interceptFetch(request: Request_): Promise<unknown> | null {
      var _handlers = this._handlers.get('fetch');
      if (!_handlers || _handlers.length === 0) return null;
      var _ev = new FetchEvent_(request);
      this._fireList(_ev as VEvent);
      return _ev._responded ? _ev._respondWithPromise : null;
    }
  }

  // ── ServiceWorkerContainer — full implementation ──────────────────────────────
  class ServiceWorkerContainer_ extends VEventTarget {
    controller:        unknown | null = null;
    ready:             Promise<unknown>;
    _readyResolve!:    (val: unknown) => void;
    oncontrollerchange: ((ev: VEvent) => void) | null = null;
    onmessage:          ((ev: VEvent) => void) | null = null;
    onmessageerror:     ((ev: VEvent) => void) | null = null;
    constructor() {
      super();
      this.ready = new Promise<unknown>(resolve => { this._readyResolve = resolve; });
    }
    register(scriptURL: string, options?: { scope?: string }): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        try {
          var scope = (options && options.scope) ? options.scope : '/';
          var fullUrl = _resolveURL(scriptURL, _baseHref);
          // Fetch the SW script via the real network (bypasses SW intercept)
          os.fetchAsync(fullUrl, (resp: any, err: any) => {
            if (err || !resp) {
              reject(new DOMException('Failed to fetch SW script: ' + (err || 'no response'), 'AbortError'));
              return;
            }
            try {
              var swText: string = resp.bodyText || resp.body || '';
              var swScope = new ServiceWorkerGlobalScope_(fullUrl, scope);
              // Build SW registration object
              var reg: any = {
                scope, installing: null, waiting: null,
                active: { scriptURL: fullUrl, state: 'activated', addEventListener() {}, postMessage() {} },
                navigationPreload: new NavigationPreloadManager_(),
                unregister(): Promise<boolean> {
                  _swActiveScope = null; _swRegistration = null;
                  if (_swContainer) _swContainer.controller = null;
                  return Promise.resolve(true);
                },
                update(): Promise<unknown> { return Promise.resolve(reg); },
                addEventListener(t: string, fn: any) { swScope.addEventListener(t, fn); },
                removeEventListener(t: string, fn: any) { swScope.removeEventListener(t, fn); },
              };
              swScope.registration = reg;
              _swActiveScope = swScope;
              _swRegistration = reg;
              this.controller = reg.active;
              // Eval the SW script with `self` bound to the ServiceWorkerGlobalScope_
              // New Function is safe here: already inside QuickJS sandbox
              var _swFn = new Function(
                'self', 'caches', 'skipWaiting', 'clients', 'importScripts',
                'fetch', 'FetchEvent', 'ExtendableEvent',
                '"use strict";\n' + swText
              );
              _swFn(
                swScope,
                swScope.caches,
                swScope.skipWaiting.bind(swScope),
                swScope.clients,
                swScope.importScripts.bind(swScope),
                fetchAPI,
                FetchEvent_,
                ExtendableEvent_,
              );
              // Fire install then activate lifecycle events
              swScope.dispatchEvent(new ExtendableEvent_('install') as VEvent);
              swScope.dispatchEvent(new ExtendableEvent_('activate') as VEvent);
              // Notify the page of controller change
              this._readyResolve(reg);
              this.dispatchEvent(new VEvent('controllerchange'));
              if (this.oncontrollerchange) this.oncontrollerchange(new VEvent('controllerchange'));
              resolve(reg);
            } catch (evalErr) {
              _swActiveScope = null; _swRegistration = null;
              reject(new Error('ServiceWorker script error: ' + String(evalErr)));
            }
          }, { method: 'GET' });
        } catch (ex) {
          reject(ex);
        }
      });
    }
    getRegistration(_scope?: string): Promise<unknown> { return Promise.resolve(_swRegistration); }
    getRegistrations(): Promise<unknown[]>             { return Promise.resolve(_swRegistration ? [_swRegistration] : []); }
    startMessages(): void {}
  }
  // Instantiate after class definition so the navigator getter can find it
  _swContainer = new ServiceWorkerContainer_();
  // PaymentRequest (Chrome 60+) â€” stub so feature detection works
  class PaymentRequest_ extends VEventTarget {
    id = ""; shippingAddress: unknown | null = null; shippingOption: string | null = null; shippingType: string | null = null;
    onshippingaddresschange: ((ev: VEvent) => void) | null = null;
    onshippingoptionchange: ((ev: VEvent) => void) | null = null;
    onpaymentmethodchange: ((ev: VEvent) => void) | null = null;
    constructor(_methodData: unknown, _details: unknown, _options?: unknown) { super(); }
    show(_details?: unknown): Promise<unknown> { return Promise.reject(new DOMException("Payment not supported", "NotSupportedError")); }
    abort(): Promise<void> { return Promise.resolve(); }
    canMakePayment(): Promise<boolean> { return Promise.resolve(false); }
    hasEnrolledInstrument(): Promise<boolean> { return Promise.resolve(false); }
    static canMakePayment(_data: unknown): Promise<boolean> { return Promise.resolve(false); }
  }
  // PublicKeyCredential / CredentialsContainer (WebAuthn, Chrome 67+)
  class Credential_ {
    id = ""; type = "";
  }
  class PublicKeyCredential_ extends Credential_ {
    rawId: ArrayBuffer = new ArrayBuffer(0);
    response: unknown = {};
    authenticatorAttachment: string | null = null;
    getClientExtensionResults(): unknown { return {}; }
    toJSON(): unknown { return {}; }
    static isConditionalMediationAvailable(): Promise<boolean> { return Promise.resolve(false); }
    static isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> { return Promise.resolve(false); }
    static parseCreationOptionsFromJSON(_opts: unknown): unknown { return _opts; }
    static parseRequestOptionsFromJSON(_opts: unknown): unknown { return _opts; }
  }
  class CredentialsContainer_ {
    get(_options?: unknown): Promise<Credential_ | null> { return Promise.resolve(null); }
    create(_options?: unknown): Promise<Credential_ | null> { return Promise.reject(new DOMException("Credentials not supported", "NotSupportedError")); }
    store(_credential: unknown): Promise<Credential_> { return Promise.reject(new DOMException("Credentials not supported", "NotSupportedError")); }
    preventSilentAccess(): Promise<void> { return Promise.resolve(); }
  }
  // XR (WebXR Device API, Chrome 79+) â€” minimal stubs
  class XRSystem_ extends VEventTarget {
    ondevicechange: ((ev: VEvent) => void) | null = null;
    isSessionSupported(_mode: string): Promise<boolean> { return Promise.resolve(false); }
    requestSession(_mode: string, _opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException("WebXR not supported", "NotSupportedError")); }
  }
  class XRSession_ extends VEventTarget {
    renderState: unknown = {}; inputSources: unknown[] = [];
    visibilityState = "hidden"; frameRate: number | null = null;
    onend: ((ev: VEvent) => void) | null = null;
    onselect: ((ev: VEvent) => void) | null = null;
    onselectstart: ((ev: VEvent) => void) | null = null;
    onselectend: ((ev: VEvent) => void) | null = null;
    onsqueeze: ((ev: VEvent) => void) | null = null;
    updateRenderState(_state?: unknown): void {}
    requestReferenceSpace(_type: string): Promise<unknown> { return Promise.reject(new DOMException("WebXR not supported", "NotSupportedError")); }
    requestAnimationFrame(_callback: (time: number, frame: unknown) => void): number { return 0; }
    cancelAnimationFrame(_id: number): void {}
    end(): Promise<void> { return Promise.resolve(); }
  }
  // BarcodeDetector / Shape Detection API (Chrome 83+)
  class BarcodeDetector_ {
    constructor(_opts?: unknown) {}
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
    static getSupportedFormats(): Promise<string[]> { return Promise.resolve([]); }
  }
  class FaceDetector_ {
    constructor(_opts?: unknown) {}
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
  }
  class TextDetector_ {
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
  }
  // NavigationPreloadManager (Service Worker, Chrome 62+)
  class NavigationPreloadManager_ {
    enable(): Promise<void> { return Promise.resolve(); }
    disable(): Promise<void> { return Promise.resolve(); }
    setHeaderValue(_value: string): Promise<void> { return Promise.resolve(); }
    getState(): Promise<unknown> { return Promise.resolve({ enabled: false, headerValue: "true" }); }
  }  class ReadableStreamDefaultReader_ {
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

  // -- ReadableStreamBYOBReader (stub) --------------------------------
  class ReadableStreamBYOBReader_ {
    _reader: ReadableStreamDefaultReader_;
    constructor(stream: ReadableStream_) {
      this._reader = (stream as any).getReader ? (stream as any).getReader() : new ReadableStreamDefaultReader_(stream);
    }
    read(_view: ArrayBufferView): Promise<{ done: boolean; value: ArrayBufferView | undefined }> {
      return this._reader.read() as any;
    }
    cancel(_reason?: unknown): Promise<void> { return this._reader.cancel(_reason); }
    releaseLock(): void { this._reader.releaseLock(); }
    get closed(): Promise<void> { return this._reader.closed; }
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
  // structuredClone — real implementation: handles Date, Map, Set, ArrayBuffer,
  // typed arrays, RegExp, and circular references via WeakMap.
  function _structuredClone<T>(value: T): T {
    const seen = new WeakMap<object, unknown>();
    function _clone(v: unknown): unknown {
      if (v === null || typeof v !== 'object' && typeof v !== 'function') return v;
      if (typeof v === 'function') return undefined; // functions not clonable
      const o = v as object;
      if (seen.has(o)) return seen.get(o);
      if (v instanceof Date)        { const d = new Date((v as Date).getTime()); seen.set(o, d); return d; }
      if (v instanceof RegExp)      { const r = new RegExp((v as RegExp).source, (v as RegExp).flags); seen.set(o, r); return r; }
      if (v instanceof ArrayBuffer) { const b = (v as ArrayBuffer).slice(0); seen.set(o, b); return b; }
      if (ArrayBuffer.isView(v))    {
        const src = v as ArrayBufferView;
        const buf = (src.buffer as ArrayBuffer).slice(src.byteOffset, src.byteOffset + src.byteLength);
        const C = (src as any).constructor as { new(b: ArrayBuffer): ArrayBufferView };
        const t = new C(buf); seen.set(o, t); return t;
      }
      if (v instanceof Map) {
        const m = new Map<unknown, unknown>(); seen.set(o, m);
        (v as Map<unknown, unknown>).forEach((val, k) => m.set(_clone(k), _clone(val)));
        return m;
      }
      if (v instanceof Set) {
        const s = new Set<unknown>(); seen.set(o, s);
        (v as Set<unknown>).forEach(val => s.add(_clone(val)));
        return s;
      }
      if (Array.isArray(v)) {
        const a: unknown[] = new Array((v as unknown[]).length);
        seen.set(o, a);
        for (let i = 0; i < (v as unknown[]).length; i++) a[i] = _clone((v as unknown[])[i]);
        return a;
      }
      const obj: Record<string, unknown> = Object.create(Object.getPrototypeOf(v));
      seen.set(o, obj);
      for (const k of Object.keys(v)) obj[k] = _clone((v as Record<string, unknown>)[k]);
      return obj;
    }
    return _clone(value) as T;
  }
  if (typeof structuredClone === 'undefined') {
    (globalThis as any).structuredClone = _structuredClone;
  }
  // String.prototype.trimStart / trimEnd (ES2019) – belt-and-suspenders
  if (typeof (String.prototype as any).trimStart !== 'function') {
    (String.prototype as any).trimStart = function(this: string) { return this.replace(/^\s+/, ''); };
    (String.prototype as any).trimEnd   = function(this: string) { return this.replace(/\s+$/, ''); };
  }
  // Array.prototype.toReversed / toSorted / toSpliced / with (ES2023 non-mutating)
  if (typeof (Array.prototype as any).toReversed !== 'function') {
    (Array.prototype as any).toReversed = function(this: unknown[]) { return this.slice().reverse(); };
  }
  if (typeof (Array.prototype as any).toSorted !== 'function') {
    (Array.prototype as any).toSorted = function(this: unknown[], compareFn?: (a: unknown, b: unknown) => number) { return this.slice().sort(compareFn); };
  }
  if (typeof (Array.prototype as any).toSpliced !== 'function') {
    (Array.prototype as any).toSpliced = function(this: unknown[], start: number, deleteCount?: number, ...items: unknown[]) {
      var copy = this.slice(); copy.splice(start, deleteCount ?? copy.length - start, ...items); return copy;
    };
  }
  if (typeof (Array.prototype as any).with !== 'function') {
    (Array.prototype as any).with = function(this: unknown[], index: number, value: unknown) {
      var copy = this.slice(); copy[index < 0 ? this.length + index : index] = value; return copy;
    };
  }
  // TypedArray.prototype.at (ES2022) – applies to all typed array prototypes
  (function() {
    var _typedProtos = [
      Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array,
    ];
    for (var i = 0; i < _typedProtos.length; i++) {
      if (typeof (_typedProtos[i].prototype as any).at !== 'function') {
        (_typedProtos[i].prototype as any).at = function(this: { length: number; [k: number]: unknown }, n: number) {
          var idx = n < 0 ? this.length + n : n; return this[idx];
        };
      }
    }
  })();
  // Array.prototype.group / Object.groupBy (Chrome 117 / ES2024)
  if (typeof (Object as any).groupBy !== 'function') {
    (Object as any).groupBy = function<T>(iterable: Iterable<T>, keyFn: (v: T) => PropertyKey): Record<PropertyKey, T[]> {
      var result: Record<PropertyKey, T[]> = Object.create(null);
      for (var item of iterable) { var key = keyFn(item); (result[key] = result[key] || []).push(item); }
      return result;
    };
    (Map as any).groupBy = function<T>(iterable: Iterable<T>, keyFn: (v: T) => unknown): Map<unknown, T[]> {
      var result = new Map<unknown, T[]>();
      for (var item of iterable) { var key = keyFn(item); if (!result.has(key)) result.set(key, []); result.get(key)!.push(item); }
      return result;
    };
  }
  // Promise.any (ES2021) — in case QJS build is missing it
  if (typeof Promise.any !== 'function') {
    (Promise as any).any = function<T>(promises: Iterable<Promise<T>>): Promise<T> {
      var arr = Array.from(promises);
      return new Promise<T>((resolve, reject) => {
        var errs: unknown[] = []; var remaining = arr.length;
        if (remaining === 0) { reject(new (AggregateError_ as any)([], 'All promises were rejected')); return; }
        arr.forEach((p, i) => Promise.resolve(p).then(resolve, (e) => { errs[i] = e; if (--remaining === 0) reject(new (AggregateError_ as any)(errs, 'All promises were rejected')); }));
      });
    };
  }
  // Promise.allSettled (ES2020) polyfill

  if (typeof Promise.allSettled !== 'function') {

    (Promise as any).allSettled = function<T>(promises: Iterable<Promise<T>>) {

      var arr = Array.from(promises);

      return Promise.all(arr.map((p: Promise<T>) => Promise.resolve(p).then(

        (value: T) => ({ status: 'fulfilled' as const, value }),

        (reason: unknown) => ({ status: 'rejected' as const, reason })

      )));

    };

  }

  // Array.fromAsync (ES2024) polyfill

  if (typeof (Array as any).fromAsync !== 'function') {

    (Array as any).fromAsync = async function fromAsync(source: any, mapFn?: any): Promise<any[]> {

      var result: any[] = []; var i = 0;

      if (source && typeof source[Symbol.asyncIterator] === 'function') {

        for await (var item of source) { result.push(mapFn ? await mapFn(item, i++) : item); }

      } else {

        for (var item2 of source) { var resolved = await item2; result.push(mapFn ? await mapFn(resolved, i++) : resolved); }

      }

      return result;

    };

  }

  // Promise.try (ES2025) polyfill

  if (typeof (Promise as any).try !== 'function') {

    (Promise as any).try = function promiseTry(fn: () => any): Promise<any> {

      return new Promise((resolve, reject) => { try { resolve(fn()); } catch (e) { reject(e); } });

    };

  }  // Error.cause support (ES2022) — QJS 2021 may not pass it through
  if (typeof Error !== 'undefined' && !(new Error('', { cause: 'x' } as any) as any).cause) {
    var _OrigError = Error;
    (globalThis as any).Error = function Error(msg?: string, opts?: { cause?: unknown }) {
      var e = new _OrigError(msg);
      if (opts && 'cause' in opts) (e as any).cause = opts.cause;
      return e;
    };
    (globalThis as any).Error.prototype = _OrigError.prototype;
  }

  // ── RTCPeerConnection stub (item 541) ─────────────────────────────────────

  // Iterator.from (ES2025 Stage 3) polyfill
  if (typeof (Iterator as any).from !== 'function') {
    (Iterator as any).from = function from(iterable: Iterable<unknown>) {
      return (iterable as any)[Symbol.iterator]();
    };
  }

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
  (doc as any)._osClipboard = { read: () => { try { return os.clipboard.read(); } catch(_) { return ''; } }, write: (t: string) => { try { os.clipboard.write(t); } catch(_) {} } };

  // ── HTMLCanvasElement (real 2D context — item 3.3) ───────────────────────

  // Track all live canvas elements for compositing into the browser viewport
  var _canvasElements: HTMLCanvas[] = [];

  class HTMLCanvas {
    width = 300; height = 150;
    _ctx: Canvas2DImpl | null = null;
    _elId: string = '';  // element ID for layout rect lookup
    getContext(type: string): any {
      if (type !== '2d') return null;
      if (this._ctx) return this._ctx;
      this._ctx = new Canvas2DImpl(this.width, this.height);
      if (_canvasElements.indexOf(this) < 0) _canvasElements.push(this);
      return this._ctx;
    }
    toDataURL(_type?: string): string {
      if (this._ctx) return this._ctx.toDataURL(_type);
      return 'data:image/png;base64,';
    }
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
    HTMLVideoElement:    JSVideoElement,
    HTMLAudioElement:    JSAudioElement,
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
    IDBKeyRange:   IDBKeyRange_,

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

    // Speech
    speechSynthesis: _speechSynthesis,

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
    postMessage: (data: unknown, _origin?: string): void => {
      // Self-post: asynchronously dispatch a MessageEvent on this window
      setTimeout_(() => {
        var ev = new VEvent('message', { bubbles: false, cancelable: false });
        (ev as any).data    = data;
        (ev as any).origin  = win.origin || '';
        (ev as any).source  = win;
        (ev as any).lastEventId = '';
        (ev as any).ports   = [];
        // invoke window.onmessage if set
        if (typeof win.onmessage === 'function') {
          try { (win.onmessage as any)(ev); } catch(_) {}
        }
        // dispatch to window addEventListener('message') listeners
        try { win.dispatchEvent(ev); } catch(_) {}
      }, 0);
    },
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

    // Standard JS globals (in case scripts shadow these).
    // Note: 'null' is intentionally omitted — it is a language literal and
    // including it as a window key causes "missing formal parameter" errors
    // in new Function() because the string "null" is a reserved word.
    undefined, NaN, Infinity, isFinite, isNaN, parseFloat, parseInt,
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
    structuredClone: _structuredClone,
    // React 18 / ReactDOM.flushSync — run fn then synchronously commit DOM changes
    flushSync: (fn: () => void): void => {
      try { fn(); } catch(e) { _fireScriptError(e); }
      _drainMicrotasks();
      checkDirty();
      if (needsRerender) doRerender();
    },

    // -- New event / media / speech constructors ---------------------------------
    ToggleEvent,
    Highlight: Highlight_,
    CloseWatcher: CloseWatcher_,
    EyeDropper: EyeDropper_,
    MediaStream: MediaStream_,
    MediaStreamTrack: MediaStreamTrack_,
    MediaRecorder: MediaRecorder_,
    WebTransport: WebTransport_,
    SpeechRecognition: SpeechRecognition_,
    webkitSpeechRecognition: SpeechRecognition_,
    SpeechGrammar: SpeechGrammar_,
    SpeechGrammarList: SpeechGrammarList_,
    webkitSpeechGrammarList: SpeechGrammarList_,
    MediaMetadata: MediaMetadata_,

    // -- Prioritized Task Scheduling / Picture-in-Picture -----------------------
    TaskController: TaskController_,
    TaskPriorityChangeEvent: VEvent,
    documentPictureInPicture,

    // -- CSS rule constructors (additional) ------------------------------------
    CSSContainerRule: CSSContainerRule_,
    CSSLayerBlockRule: CSSRule_,
    CSSLayerStatementRule: CSSRule_,

    // -- Launch Queue API (Chrome 98+) -----------------------------------------
    launchQueue: {
      _handlers: [] as any[],
      setConsumer(fn: (launchParams: unknown) => void): void { this._handlers = [fn]; },
    },

    // -- PerformanceEntry subclass constructors (instanceof checks) ------------
    PerformanceEntry: Object,
    PerformanceMark: Object,
    PerformanceMeasure: Object,
    PerformanceResourceTiming: Object,
    PerformanceNavigationTiming: Object,
    PerformancePaintTiming: Object,
    PerformanceLongTaskTiming: Object,
    PerformanceEventTiming: Object,

    // -- Cookie Store API (Chrome 87+) -----------------------------------------
    cookieStore: {
      get(name: string): Promise<unknown> { return Promise.resolve(null); },
      getAll(_name?: string): Promise<unknown[]> { return Promise.resolve([]); },
      set(_name: string, _value?: string): Promise<void> { return Promise.resolve(); },
      delete(_name: string): Promise<void> { return Promise.resolve(); },
      onchange: null as any,
      addEventListener(_t: string, _fn: unknown): void {},
      removeEventListener(_t: string, _fn: unknown): void {},
    },

    // -- WebGPU stub (Chrome 113+) -- not supported but stub for feature detect --
    // navigator.gpu is on navigator, handled below; this is for GPU types
    GPUValidationError: Object,
    GPUOutOfMemoryError: Object,
    GPUPipelineError: Object,

    // -- ReadableStreamBYOBReader (Chrome 89+) ---------------------------------
    ReadableStreamBYOBReader: ReadableStreamBYOBReader_,

    // -- IDB constructors (for instanceof checks) --------------------------------
    IDBRequest: IDBRequest_,
    IDBOpenDBRequest: IDBRequest_,
    IDBDatabase: IDBDatabase_,
    IDBTransaction: IDBTransaction_,
    IDBObjectStore: IDBObjectStore_,
    IDBCursor: Object,
    IDBCursorWithValue: Object,
    IDBIndex: Object,

    // -- Additional event constructors ------------------------------------
    PromiseRejectionEvent,
    FormDataEvent,
    DeviceMotionEvent,
    DeviceOrientationEvent,

    // -- ViewTransition API -----------------------------------------------
    ViewTransition: ViewTransition_,

    // -- Window Controls Overlay (Chrome 93+ PWA) -------------------------
    windowControlsOverlay: {
      visible: false,
      getTitlebarAreaRect(): DOMRect_ { return new DOMRect_(0, 0, 0, 0); },
      ongeometrychange: null as any,
      addEventListener(_t: string, _fn: unknown): void {},
      removeEventListener(_t: string, _fn: unknown): void {},
    },

    // -- Screen Details API (Chrome 100+) - multi-screen -------------------
    getScreenDetails(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'Not supported')); },

    // -- SVG / MathML element constructors (for instanceof) ---------------
    SVGElement: VElement,
    SVGSVGElement: VElement,
    SVGPathElement: VElement,
    MathMLElement: VElement,

    // -- DOM node constructors (for instanceof) ---------------------------
    Text: VNode,
    CDATASection: VNode,
    Comment: VNode,
    Attr: Object,
    NodeFilter: { SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1, SHOW_TEXT: 0x4, SHOW_COMMENT: 0x80, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    TreeWalker: Object,
    NodeIterator: Object,
    Selection: Object,

    // -- Audio Worklet (Chrome 66+) ----------------------------------------
    AudioWorkletNode: AudioNode_,
    OfflineAudioContext: AudioContext_,

    // -- URLPattern (Chrome 95+) ------------------------------------------
    URLPattern: URLPattern_,

    // -- FileSystem API (for instanceof/feature detect) --------------------
    FileSystemHandle: Object,
    FileSystemFileHandle: Object,
    FileSystemDirectoryHandle: Object,
    FileSystemWritableFileStream: Object,

    // -- MSE (Media Source Extensions, Chrome 31+) ----------------------------
    MediaSource:  MediaSource_,
    SourceBuffer: SourceBuffer_,
    TimeRanges:   TimeRanges_,

    // -- WebCodecs (Chrome 94+) -----------------------------------------------
    VideoDecoder:       VideoDecoder_,
    VideoEncoder:       VideoEncoder_,
    AudioDecoder:       AudioDecoder_,
    AudioEncoder:       AudioEncoder_,
    ImageDecoder:       ImageDecoder_,
    ImageTrack:         ImageTrack_,
    ImageTrackList:     ImageTrackList_,
    VideoFrame:         VideoFrame_,
    AudioData:          AudioData_,
    VideoColorSpace:    VideoColorSpace_,
    EncodedVideoChunk:  EncodedVideoChunk_,
    EncodedAudioChunk:  EncodedAudioChunk_,

    // -- Navigation API events (Chrome 102+) ----------------------------------
    NavigateEvent:                     NavigateEvent_,
    NavigationCurrentEntryChangeEvent: NavigationCurrentEntryChangeEvent_,

    // -- Scroll-driven animations (Chrome 115+) -------------------------------
    ScrollTimeline: ScrollTimeline_,
    ViewTimeline:   ViewTimeline_,

    // -- Reporting API (Chrome 69+) -------------------------------------------
    ReportingObserver: ReportingObserver_,

    // -- Contacts (Android Chrome 80+) ----------------------------------------
    ContactsManager: ContactsManager_,

    // -- PictureInPicture -----------------------------------------------------
    PictureInPictureWindow: PictureInPictureWindow_,
    PictureInPictureEvent:  VEvent,

    // -- Push / Background Sync -----------------------------------------------
    PushManager:          PushManager_,
    PushSubscription:     PushSubscription_,
    PushMessageData:      Object,
    PushEvent:            VEvent,
    SyncManager:          SyncManager_,
    PeriodicSyncManager:  PeriodicSyncManager_,

    // -- PageRevealEvent / SnapEvent ------------------------------------------
    PageRevealEvent: PageRevealEvent_,
    SnapEvent:       SnapEvent_,

    // -- CSS Houdini ----------------------------------------------------------
    CSSPropertyRule:    CSSPropertyRule_,
    ResizeObserverSize: ResizeObserverSize_,

    // -- Streams writers/controllers ------------------------------------------
    WritableStreamDefaultWriter:       WritableStreamDefaultWriter_,
    TransformStreamDefaultController:  TransformStreamDefaultController_,

    // -- ScreenOrientation (Chrome 38+) ----------------------------------------
    ScreenOrientation: ScreenOrientation_,

    // -- CSS Typed OM (Chrome 66+) ---------------------------------------------
    CSSStyleValue:    CSSStyleValue_,
    CSSNumericValue:  CSSNumericValue_,
    CSSUnitValue:     CSSUnitValue_,
    CSSKeywordValue:  CSSKeywordValue_,
    StylePropertyMap: StylePropertyMap_,

    // -- Sanitizer API (Chrome 105+) ------------------------------------
    Sanitizer: Sanitizer_,

    // -- Trusted Types (Chrome 83+) -------------------------------------
    TrustedHTML:              TrustedHTML_,
    TrustedScript:            TrustedScript_,
    TrustedScriptURL:         TrustedScriptURL_,
    TrustedTypePolicy:        TrustedTypePolicy_,
    TrustedTypePolicyFactory: TrustedTypePolicyFactory_,
    trustedTypes:             new TrustedTypePolicyFactory_(),

    // -- MessagePort --------------------------------------------------
    MessagePort: MessagePort_,

    // -- WakeLock (Chrome 84+) -----------------------------------------
    WakeLockSentinel: WakeLockSentinel_,

    // -- Web Locks (Chrome 69+) ----------------------------------------
    Lock:        Lock_,
    LockManager: LockManager_,

    // -- CacheStorage / Cache (Chrome 43+) ----------------------------
    caches:       new CacheStorage_(),
    Cache:        Cache_,
    CacheStorage: CacheStorage_,

    // -- ServiceWorkerContainer ----------------------------------------
    ServiceWorkerContainer: ServiceWorkerContainer_,

    // -- PaymentRequest (Chrome 60+) -----------------------------------
    PaymentRequest:           PaymentRequest_,
    PaymentResponse:          Object,
    PaymentMethodChangeEvent: VEvent,

    // -- WebAuthn (Chrome 67+) ----------------------------------------
    Credential:           Credential_,
    PublicKeyCredential:  PublicKeyCredential_,
    CredentialsContainer: CredentialsContainer_,

    // -- WebXR (Chrome 79+) -------------------------------------------
    XRSystem:         XRSystem_,
    XRSession:        XRSession_,
    XRRigidTransform: Object,
    XRFrame:          Object,

    // -- Shape Detection API (Chrome 83+) -----------------------------
    BarcodeDetector: BarcodeDetector_,
    FaceDetector:    FaceDetector_,
    TextDetector:    TextDetector_,

    // -- NavigationPreloadManager (Chrome 62+) ------------------------
    NavigationPreloadManager: NavigationPreloadManager_,
  };

  // ── Patch Date to use real wall clock (CMOS RTC via os.time.now()) ────────
  // QuickJS's native Date.now() returns 0 because gettimeofday() is not wired to
  // the RTC. We proxy Date so all page-script date/time operations are correct.
  {
    var _nativeDate = Date;
    var _patchedDate = new Proxy(_nativeDate, {
      apply(_tgt, _this, args) {
        // Date() called as a function returns a string like real browsers
        return new _nativeDate(args.length === 0 ? os.time.now() : args[0]).toString();
      },
      construct(_tgt, args) {
        if (args.length === 0) return new _nativeDate(os.time.now());
        return Reflect.construct(_nativeDate, args);
      },
      get(tgt, prop) {
        if (prop === 'now') return () => os.time.now();
        var val = (tgt as any)[prop];
        if (typeof val === 'function') return val.bind(tgt);
        return val;
      },
    });
    win['Date'] = _patchedDate;
  }

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
  // Also intercept dynamic <script> injection (SPAs, ad libs, analytics)

  {
    var _origCreateElement = doc.createElement.bind(doc);
    doc.createElement = function(tag: string) {
      if (tag.toLowerCase() === 'canvas') return new HTMLCanvas() as any;
      // ── Custom Elements: instantiate registered constructor ────────────────
      var _ceTag = tag.toLowerCase();
      if (_ceRegistry.has(_ceTag)) {
        var _ceCtor = _ceRegistry.get(_ceTag) as new () => VElement;
        _cePending.tag = _ceTag;
        try {
          var _ceInst = new _ceCtor() as VElement;
          _ceInst.ownerDocument = doc;
          _cePending.tag = '';
          return _ceInst;
        } catch (_ceErr) {
          _cePending.tag = '';
          // Fall through to normal element creation
        }
      }
      var el = _origCreateElement(tag);
      // Intercept dynamic <script> element injection — when SPAs/frameworks
      // create a <script> with .src and append it, we fetch+execute it.
      if (tag.toLowerCase() === 'script') {
        var _scriptSrc = '';
        var _scriptText = '';
        Object.defineProperty(el, 'src', {
          get() { return _scriptSrc; },
          set(v: string) {
            _scriptSrc = v;
            // Defer execution until the element is appended to the document
          },
          configurable: true,
        });
        Object.defineProperty(el, 'text', {
          get() { return _scriptText; },
          set(v: string) { _scriptText = v; },
          configurable: true,
        });
        // Monkey-patch: when this script element is appended to document,
        // actually load and execute it (SPA dynamic script injection)
        var _origAppend = el.appendChild ? el.appendChild.bind(el) : null;
        var _scriptEl = el;
        // We hook via a flag checked in doc.body.appendChild / doc.head.appendChild
        (el as any)._isDynamicScript = true;
        (el as any)._onAttach = function() {
          if (_scriptSrc) {
            loadExternalScript(_scriptSrc, function(code?: string) {
              if (code) {
                var loadEv = new VEvent('load');
                try { _scriptEl.dispatchEvent(loadEv); } catch(_) {}
              } else {
                var errEv = new VEvent('error');
                try { _scriptEl.dispatchEvent(errEv); } catch(_) {}
              }
            }, false);
          } else if (_scriptText) {
            execScript(_scriptText);
            var loadEv2 = new VEvent('load');
            try { _scriptEl.dispatchEvent(loadEv2); } catch(_) {}
          }
        };
      }
      // ── Intercept dynamic <style> element injection (CSS-in-JS, runtime styles)
      if (tag.toLowerCase() === 'style') {
        var _dynStyleText = '';
        var _dynStyleSheet: CSSStyleSheet_ | null = null;
        var _patchStyleText = function(v: string): void {
          _dynStyleText = v;
          if (_dynStyleSheet) {
            _dynStyleSheet._parseText(v);
            doc._dirty = true;
          }
        };
        Object.defineProperty(el, 'textContent', {
          get(): string { return _dynStyleText; },
          set(v: string) { _patchStyleText(String(v)); },
          configurable: true,
        });
        Object.defineProperty(el, 'innerHTML', {
          get(): string { return _dynStyleText; },
          set(v: string) { _patchStyleText(String(v)); },
          configurable: true,
        });
        Object.defineProperty(el, 'sheet', {
          get(): CSSStyleSheet_ | null { return _dynStyleSheet; },
          configurable: true,
        });
        (el as any)._isDynamicStyle = true;
        (el as any)._attachDynSheet = function(): void {
          if (_dynStyleSheet) return; // already attached
          _dynStyleSheet = new CSSStyleSheet_();
          (_dynStyleSheet as any).ownerNode = el;
          _dynStyleSheet._parseText(_dynStyleText);
          doc._styleSheets.push(_dynStyleSheet);
          doc._dirty = true;
        };
      }
      return el;
    };
  }

  // ── Patch appendChild/insertBefore to detect dynamic <script>/<style>/<link> ──
  {
    // Handle a node immediately after it's inserted into the DOM
    var _handleInsertedNode = function(child: any): void {
      // Dynamic <script> injection (SPAs, analytics)
      if (child && (child as any)._isDynamicScript && (child as any)._onAttach) {
        (child as any)._onAttach();
        (child as any)._isDynamicScript = false; // prevent double-execution
      }
      // Dynamic <style> injection (CSS-in-JS: emotion, styled-components, MUI, etc.)
      if (child && (child as any)._isDynamicStyle && typeof (child as any)._attachDynSheet === 'function') {
        (child as any)._attachDynSheet();
        (child as any)._isDynamicStyle = false; // prevent double-registration
      }
      // Dynamic <link rel="stylesheet"> injection (lazy-loaded CSS, analytics widgets)
      if (child && child.tagName && child.tagName.toLowerCase() === 'link') {
        var _lkRel = (child.getAttribute ? child.getAttribute('rel') : '') || '';
        if (String(_lkRel).toLowerCase().includes('stylesheet')) {
          var _lkSheet = new CSSStyleSheet_();
          (_lkSheet as any).ownerNode = child;
          doc._styleSheets.push(_lkSheet);
          var _lkHref = (child.getAttribute ? child.getAttribute('href') : '') || '';
          if (_lkHref) {
            (function(_sh: CSSStyleSheet_, _el: any, _href: string) {
              var _url = _href.startsWith('http') ? _href : _resolveURL(_href, _baseHref);
              os.fetchAsync(_url, (resp: FetchResponse | null) => {
                if (resp && resp.status === 200) {
                  _sh._parseText(resp.bodyText);
                  doc._dirty = true;
                  try { _el.dispatchEvent(new VEvent('load')); } catch(_) {}
                } else {
                  try { _el.dispatchEvent(new VEvent('error')); } catch(_) {}
                }
              });
            })(_lkSheet, child, String(_lkHref));
          }
        }
      }
    };

    var _hookAppendChild = function(parent: any): void {
      if (!parent) return;
      var _origAppend2 = parent.appendChild.bind(parent);
      parent.appendChild = function(child: any) {
        var result = _origAppend2(child);
        _handleInsertedNode(child);
        return result;
      };
      if (parent.insertBefore) {
        var _origInsert = parent.insertBefore.bind(parent);
        parent.insertBefore = function(newChild: any, refChild: any) {
          var result = _origInsert(newChild, refChild);
          _handleInsertedNode(newChild);
          return result;
        };
      }
    };
    if (doc.head) _hookAppendChild(doc.head);
    if (doc.body) _hookAppendChild(doc.body);
    _hookAppendChild(doc.documentElement);
  }

  // ── Wire on* attribute handlers ───────────────────────────────────────────

  function wireHandlers(root: VElement, _ctx: Record<string, unknown>): void {
    _walk(root, el => {
      var onAttrs = ['onclick','onchange','oninput','onsubmit','onkeydown','onkeyup',
                     'onfocus','onblur','onmouseover','onmouseout','onmouseenter','onmouseleave',
                     'ondblclick','oncontextmenu','onresize','onscroll','onload'];
      for (var attr of onAttrs) {
        var code = el.getAttribute(attr); if (!code) continue;
        (function(evName: string, evCode: string, elem: VElement) {
          var handler = _makeHandler(evCode);
          if (handler) {
            var evType = evName.slice(2); // strip 'on'
            elem.addEventListener(evType, handler);
          }
        })(attr, code, el);
      }
    });
  }

  // ── Page-script execution scope ────────────────────────────────────────────
  // A Proxy over `win` that simulates a browser's global object for page scripts.
  //
  //  • has()  → always true: `with(_winScope)` channels ALL identifier lookups
  //              through here first, mirroring how real browsers resolve globals.
  //  • get()  → return win[key] if present, else fall back to the QJS global
  //              (Math, Promise, ArrayBuffer, …) so built-ins remain accessible.
  //  • set()  → write directly to win so bare `gbar = {}` persists as window.gbar
  //              across subsequent scripts — exactly like a real browser's global.
  //
  // Using with(Proxy) instead of new Function(...Object.keys(win)) eliminates the
  // "missing formal parameter" class of errors (reserved words, dotted names, …)
  // and makes dynamically-added window properties visible without re-enumeration.
  var _winScope: any = new Proxy(win as any, {
    has(_t: any, _k: any): boolean { return true; },
    get(t: any, k: string): any    { return (k in t) ? t[k] : (globalThis as any)[k]; },
    set(t: any, k: string, v: any): boolean { t[k] = v; return true; },
  });

  // ── Stage-2 global bridge ─────────────────────────────────────────────────
  // QJS rejects class declarations (static blocks, extends, private fields,
  // any class body) inside with() blocks. When stage-1 falls through to stage-2
  // we run `new Function(code).call(win)`, where `this` = win but bare identifier
  // lookups still go through globalThis — NOT win.
  //
  // To fix this we define configurable getters/setters on QJS's globalThis for
  // every win property not already present there.  After bridging:
  //   • bare `document` resolves to win.document ✓
  //   • bare `console` resolves to win.console ✓
  //   • bare `fetch` resolves to win.fetch ✓
  //   • bare `window.foo = bar` → sets on win ✓ (window getter returns win)
  //   • Existing QJS builtins (Math, Array, Promise …) are left intact ✓
  //
  // Bindings are removed in dispose() so they don't outlive the page.
  var _bridgedKeys: string[] = [];
  // Bridge only essential properties to globalThis.  Bridging ALL ~423 win keys
  // causes QJS's global object shape tree to grow so large that the inline
  // cache / shape lookup code dereferences stale pointers → #PF.
  // We only bridge the subset that scripts commonly access as bare identifiers.
  var _essentialBridgeKeys = [
    'document', 'window', 'self', 'top', 'parent', 'frames',
    'navigator', 'location', 'history', 'screen',
    'console', 'performance', 'crypto',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
    'getComputedStyle', 'matchMedia', 'getSelection',
    'alert', 'confirm', 'prompt', 'close', 'focus', 'blur',
    'scrollTo', 'scrollBy', 'scroll', 'scrollX', 'scrollY',
    'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
    'pageXOffset', 'pageYOffset', 'devicePixelRatio',
    'localStorage', 'sessionStorage',
    'atob', 'btoa', 'structuredClone',
    'CustomEvent', 'Event', 'MutationObserver', 'ResizeObserver',
    'IntersectionObserver', 'URL', 'URLSearchParams',
    'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
    'TextEncoder', 'TextDecoder', 'Blob', 'File', 'FileReader',
    'FormData', 'URLPattern',
    'FontFace', 'FontFaceSet',
    'HTMLElement', 'Element', 'Node', 'Document', 'DocumentFragment',
    'NodeList', 'DOMParser', 'Range', 'Selection', 'TreeWalker',
    'CSSStyleSheet', 'CSSStyleDeclaration',
    'Image', 'Audio', 'MediaQueryList',
    'Worker', 'SharedWorker', 'MessageChannel', 'MessagePort',
    'BroadcastChannel', 'Notification',
    'queueMicrotask', 'reportError',
  ];
  function _bridgeToGlobal() {
    for (var _bi = 0; _bi < _essentialBridgeKeys.length; _bi++) {
      var _bk = _essentialBridgeKeys[_bi];
      if (_bk in (globalThis as any)) continue;
      if (!(_bk in (win as any))) continue;  // skip if win doesn't have it
      try {
        (globalThis as any)[_bk] = (win as any)[_bk];
        _bridgedKeys.push(_bk);
      } catch(_) {}
    }
  }
  _bridgeToGlobal(); // initial bridge at page startup
  function _unbridgeFromGlobal(): void {
    for (var _ui = 0; _ui < _bridgedKeys.length; _ui++) {
      try { delete (globalThis as any)[_bridgedKeys[_ui]]; } catch(_) {}
    }
    _bridgedKeys = [];
  }

  // ── JS source prep for `with()` execution wrapper ────────────────────────
  //
  // QuickJS 2025-09-13 supports all ES2022/2023 syntax natively (static blocks,
  // ergonomic brand checks, reserved-word property keys, private fields, etc.).
  // We must NOT try to "fix" valid syntax – transforming it only introduces bugs.
  //
  // The ONLY preparation needed for the with(__s__){} wrapper is:
  //   1. Strip hashbang (#!) – QJS allows it in top-level scripts but not inside
  //      a function body (which is what new Function() creates).
  //   2. Strip `'use strict'` / `"use strict"` directives – with() is forbidden
  //      in strict-mode code.  Inside the with(){} block the directive is just an
  //      expression statement so it never activates strict mode anyway; stripping
  //      it prevents edge-cases where the engine sees it as a directive.
  //
  // Scripts that still fail stage-1 parsing (e.g. class static-init blocks
  // inside with() which QJS rejects at the parser level) fall through to stage-2
  // which runs the RAW untouched code without any wrapper.

  function _prepareForWith(raw: string): string {
    // Strip hashbang
    var s = (raw.charCodeAt(0) === 35 && raw.charCodeAt(1) === 33)
      ? raw.replace(/^#!.*/, '') : raw;
    // Strip leading 'use strict' directive
    s = s.replace(/^\s*(?:'use strict'|"use strict")\s*;?/, '');
    // Replace dynamic import() — QJS rejects native import() inside new Function()
    s = s.replace(/\bimport\s*\(/g, '__jsos_dynamic_import__(');
    return s;
  }

  // Compile an inline event-handler string. `event` is the implicit argument
  // injected by addEventListener; all other globals come from _winScope.
  function _makeHandler(code: string): ((e: VEvent) => void) | null {
    var src = _prepareForWith(code);
    try {
      var fn = new Function('__s__', 'event',
        'with(__s__){' + src + '}') as (s: any, e: VEvent) => void;
      return (e: VEvent) => {
        try { fn(_winScope, e); } catch(err) { cb.log('[JS handler err] ' + String(err)); }
        checkDirty();
      };
    } catch(e) {
      // with() failed (e.g. class body inside handler) — run without scope proxy
      try {
        var raw2 = code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33
          ? code.replace(/^#!.*/, '') : code;
        var fn2 = new Function('event', raw2) as (e: VEvent) => void;
        return (e: VEvent) => {
          try { fn2.call(win, e); } catch(err) { cb.log('[JS handler err] ' + String(err)); }
          checkDirty();
        };
      } catch(e2) {
        cb.log('[JS compile err] ' + String(e2) + '  code: ' + src.slice(0, 80));
        return null;
      }
    }
  }

  // ── Execute a script code string in the window context ────────────────────

  function _fireScriptError(e: any): void {
    var msg = String(e);
    // Include stack trace when available — critical for diagnosing JIT crashes
    var stack = (e && typeof e === 'object' && typeof e.stack === 'string')
      ? '\n  ' + e.stack.replace(/\n/g, '\n  ') : '';
    cb.log('[JS error] ' + msg + stack);
    // window.onerror(message, source, lineno, colno, error)
    var onErr = (win as any).onerror;
    if (typeof onErr === 'function') {
      try { onErr(msg, _baseHref || '', 0, 0, e); } catch(_) {}
    }
    // Dispatch ErrorEvent on window first (many sites use window.addEventListener('error', ...))
    var errEv = new VEvent('error', { bubbles: false, cancelable: true });
    (errEv as any).error = e;
    (errEv as any).message = msg;
    (errEv as any).filename = _baseHref || '';
    (errEv as any).lineno = 0;
    (errEv as any).colno = 0;
    try { (win['dispatchEvent'] as (e: VEvent) => void)(errEv); } catch(_) {}
    try { doc.dispatchEvent(errEv); } catch(_) {}
  }

  // Helper: call fn with CPU-fault protection so JIT bugs in callbacks
  // (RAF / timers / event listeners) throw catchable JS errors instead of
  // halting the OS.  Falls back to a plain try/catch when the C binding is
  // unavailable (e.g. unit-test environments).
  function _callGuarded(fn: (...a: any[]) => any, ...args: any[]): void {
    if (_pageFaulted) return;  // heap is dirty — no more JS execution
    if (typeof (kernel as any).callGuarded === 'function') {
      try {
        var _r = (kernel as any).callGuarded(fn, ...args);
        // callGuarded returns -9999 sentinel on CPU fault recovery.
        // No JS exception is thrown — the C recovery path avoids all
        // heap allocation to prevent secondary faults from half-init'd
        // QJS objects.  We detect the sentinel here instead.
        if (_r === -9999 || _r === true) {
          _pageFaulted = true;
          cb.log('[JS] page faulted (callGuarded sentinel) — stopping all page JS');
        }
      } catch(e) {
        var _eMsg = String(e);
        if (_eMsg.indexOf('CPU fault') >= 0 || _eMsg.indexOf('InternalError') >= 0) {
          _pageFaulted = true;
          cb.log('[JS] page faulted (exception) — stopping all page JS');
        } else {
          _fireScriptError(e);
        }
      }
    } else {
      try { (fn as any)(...args); } catch(e) { _fireScriptError(e); }
    }
  }

  // Context-tagged version of _callGuarded: logs which callback type is about
  // to fire (when _jsDebug is on) so errors in _fireScriptError can be correlated
  // to the triggering callback in the serial log.
  function _callGuardedCtx(ctx: string, fn: (...a: any[]) => any, ...args: any[]): void {
    if (_pageFaulted) return;  // heap dirty — skip
    if (_jsDebug) cb.log('[jscb] ' + ctx);
    _callGuarded(fn, ...args);
  }

  function execScript(code: string, scriptURL?: string): void {
    // After a fault recovery the coordinator heap is dirty — but if we have a
    // child runtime available, scripts can still run there safely.
    if (_pageFaulted && !_useChildRuntime) return;

    // ── CSP enforcement ──────────────────────────────────────────────────────
    if (cspPolicy) {
      var _isInline = !scriptURL;
      if (_isInline) {
        if (!cspAllows(cspPolicy, 'script-src', cb.baseURL, _pageOrigin, true, false)) {
          logCSPViolation('script-src', '(inline)', cb.baseURL);
          cb.log('[CSP] blocked inline script');
          return;
        }
      } else {
        if (!cspAllows(cspPolicy, 'script-src', scriptURL!, _pageOrigin, false, false)) {
          logCSPViolation('script-src', scriptURL!, cb.baseURL);
          cb.log('[CSP] blocked script: ' + scriptURL);
          return;
        }
      }
    }

    // ── Script size guard ──────────────────────────────────────────────────────
    // Always use kernel.evalGuarded when available — the JIT can generate bad
    // native code from ANY script (inline or external, large or tiny) and a
    // CPU fault with _js_fault_active == 0 halts the OS.  We want the setjmp
    // frame up for every eval, not just external/large scripts.
    var _useGuarded = typeof (kernel as any).evalGuarded === 'function';
    if (code.length > 2 * 1024 * 1024) {
      cb.log('[JS exec] oversized-skip ' + (code.length / 1024 / 1024).toFixed(1) + 'MB ' + (scriptURL || '(inline)'));
      return;
    }
    // ── Guarded execution path ───────────────────────────────────────────────
    // Previously this called kernel.evalGuarded(rawCode) which ran the page
    // script as a JS_Eval in the OS global context.  That caused heap corruption
    // because page `var` declarations and property sets landed directly on
    // ctx->global_obj (the OS's own QJS heap object), and the _bridgeToGlobal()
    // getter/setter descriptors on that same object confused QuickJS's property
    // table writer → #PF at 0x726F6D71 (a live JSString in the OS heap).
    //
    // NEW ARCHITECTURE (Phase 1):
    // Page scripts run in an ISOLATED child JSRuntime (via kernel.procCreate).
    // The child has its own heap — any crash there is contained and the OS
    // continues.  The coordinator runtime (this one) never runs untrusted code.
    //
    // Flow:
    //   1. Create child runtime (once per page)
    //   2. Bootstrap with DOM stubs (document, window, navigator, etc.)
    //   3. Inject page URL context (location.href, document.URL, etc.)
    //   4. Run each page script via kernel.procEval(childId, code)
    //   5. Drain async jobs via kernel.procTick(childId)
    //   6. On dispose(), kernel.procDestroy(childId)
    //
    // If procCreate is unavailable, falls back to evalGuarded with
    // essential-keys bridge (80 keys, plain assignment).
    if (_useGuarded) {
      // ── Child-runtime path (PREFERRED) ─────────────────────────────────
      if (_useChildRuntime || typeof (kernel as any).procCreate === 'function') {
        // Lazily create the child runtime on first script execution
        if (_pageChildId < 0) {
          try {
            _pageChildId = (kernel as any).procCreate();
          } catch(_) { _pageChildId = -1; }
          if (_pageChildId >= 0) {
            cb.log('[JS] child runtime created (slot ' + _pageChildId + ')');
            // Bootstrap the child with DOM stubs
            var _bsResult = (kernel as any).procEval(_pageChildId, _childBootstrap);
            if (typeof _bsResult === 'string' && _bsResult.indexOf('Error') === 0) {
              cb.log('[JS] child bootstrap error: ' + _bsResult.slice(0, 200));
              (kernel as any).procDestroy(_pageChildId);
              _pageChildId = -1;
            } else {
              // Inject page-specific context (URL, origin, etc.)
              var _locCtx = [
                'location.href = ' + JSON.stringify(_effectiveHref()) + ';',
                'location.protocol = ' + JSON.stringify(_locPart('protocol')) + ';',
                'location.host = ' + JSON.stringify(_locPart('host')) + ';',
                'location.hostname = ' + JSON.stringify(_locPart('hostname')) + ';',
                'location.port = ' + JSON.stringify(_locPart('port')) + ';',
                'location.pathname = ' + JSON.stringify(_locPart('pathname')) + ';',
                'location.search = ' + JSON.stringify(_locPart('search')) + ';',
                'location.hash = ' + JSON.stringify(_locPart('hash')) + ';',
                'location.origin = ' + JSON.stringify(_locPart('origin')) + ';',
                'document.URL = ' + JSON.stringify(_effectiveHref()) + ';',
                'document.referrer = ' + JSON.stringify(cb.baseURL) + ';',
                'document.domain = ' + JSON.stringify(_locPart('hostname')) + ';',
              ].join('\n');
              (kernel as any).procEval(_pageChildId, _locCtx);
              _useChildRuntime = true;
              cb.log('[JS] child runtime ready');
            }
          } else {
            cb.log('[JS] procCreate failed — falling back to evalGuarded');
          }
        }
        // Execute the script in the child runtime
        if (_pageChildId >= 0) {
          cb.log('[JS exec] child-runtime ' + (code.length / 1024).toFixed(1) + 'KB ' + (scriptURL || '(inline)'));
          var _guardedCode = code;
          if (_guardedCode.charCodeAt(0) === 35 && _guardedCode.charCodeAt(1) === 33)
            _guardedCode = _guardedCode.replace(/^#!.*/, '');
          // Strip 'use strict' — not needed in child global context
          _guardedCode = _guardedCode.replace(/^\s*(?:'use strict'|"use strict")\s*;?/, '');
          try {
            var _childResult = (kernel as any).procEval(_pageChildId, _guardedCode);
            // procEval returns "Error: ..." on exception in the child
            if (typeof _childResult === 'string' && _childResult.indexOf('Error') === 0) {
              cb.log('[JS child error] ' + _childResult.slice(0, 300));
              // If it was a CPU fault, the child heap is corrupted — destroy
              // and create a fresh one for remaining scripts
              if (_childResult.indexOf('CPU fault') >= 0) {
                cb.log('[JS] child runtime faulted — recycling');
                try { (kernel as any).procDestroy(_pageChildId); } catch(_) {}
                _pageChildId = -1;
                // Will be recreated on next execScript call
                return;
              }
            }
            // Drain async jobs (Promise.then, setTimeout callbacks, etc.)
            var _tickResult = (kernel as any).procTick(_pageChildId);
            // procTick returns -1 on fault recovery
            if (_tickResult < 0) {
              cb.log('[JS] child runtime faulted during tick — recycling');
              try { (kernel as any).procDestroy(_pageChildId); } catch(_) {}
              _pageChildId = -1;
              return;
            }
            // ── DOM bridge: sync child body HTML → main runtime ───────────
            // Check if any DOM mutations happened in the child during script+tick
            try {
              var _dirtyFlag = (kernel as any).procEval(_pageChildId,
                '(function(){var d=_domDirty;_domDirty=false;return d?"y":"n";})()');
              if (_dirtyFlag === 'y' || _dirtyFlag === '"y"') {
                var _childBodyHTML: any = (kernel as any).procEval(_pageChildId,
                  'try{document.body?document.body.innerHTML:""}catch(_e){""}');
                // procEval of a string expr returns the value as a string (possibly with quotes)
                if (typeof _childBodyHTML === 'string') {
                  // Strip surrounding quotes if returned as JSON string
                  if (_childBodyHTML.length >= 2 && _childBodyHTML[0] === '"')
                    _childBodyHTML = JSON.parse(_childBodyHTML);
                  var _prevCBH: string = (doc as any)._childBodyHTML || '';
                  if (_childBodyHTML !== _prevCBH && _childBodyHTML.length > 20) {
                    (doc as any)._childBodyHTML = _childBodyHTML;
                    cb.log('[DOM bridge] applying child body HTML (' +
                      (_childBodyHTML.length / 1024).toFixed(1) + 'KB)');
                    try {
                      doc.body.innerHTML = _childBodyHTML;
                      doc._dirty = true;
                    } catch (_applyErr) {
                      cb.log('[DOM bridge] apply error: ' + String(_applyErr));
                    }
                  }
                }
              }
            } catch (_bridgeErr) {
              // Ignore bridge errors — not critical
            }
            // Collect any messages from the child (DOM mutations, etc.)
            var _childMsg: string | null;
            while ((_childMsg = (kernel as any).procRecv(_pageChildId)) !== null) {
              // Future: process structured mutation messages
            }
          } catch(e) {
            cb.log('[JS child exec error] ' + String(e));
          }
          return;
        }
        // Fall through to evalGuarded if child creation failed
      }

      // ── EvalGuarded fallback path ──────────────────────────────────────
      cb.log('[JS exec] guarded ' + (code.length / 1024).toFixed(1) + 'KB ' + (scriptURL || '(inline)'));
      _bridgeToGlobal();
      var _guardedCode2 = code;
      if (_guardedCode2.charCodeAt(0) === 35 && _guardedCode2.charCodeAt(1) === 33)
        _guardedCode2 = _guardedCode2.replace(/^#!.*/, '');
      try {
        var _evalResult = (kernel as any).evalGuarded(_guardedCode2);
        if (_evalResult === -9999) {
          _pageFaulted = true;
          _useChildRuntime = true;  // switch to child runtime for remaining scripts
          cb.log('[JS] page faulted (evalGuarded sentinel) — switching to child runtime');
        }
      } catch(e) {
        var _eMsg = String(e);
        if (_eMsg.indexOf('CPU fault') >= 0 || _eMsg.indexOf('InternalError') >= 0) {
          _pageFaulted = true;
          _useChildRuntime = true;
          cb.log('[JS] page faulted (exception) — switching to child runtime');
        } else {
          _fireScriptError(e);
        }
      }
      if (!_pageFaulted) {
        _bridgeToGlobal(); // pick up any new globals the script created
        _drainMicrotasks();
        checkDirty();
      }
      return;
    }

    // ── JIT script cache: check for pre-compiled Function ────────────────────
    var _cachedURL = scriptURL || _baseHref + '#exec';
    if (JITBrowserEngine.ready) {
      var cached = JITBrowserEngine.getCachedScript(code, _cachedURL);
      if (cached) {
        if (_jsDebug) cb.log('[JS exec] cached ' + (code.length / 1024).toFixed(1) + 'KB ' + _cachedURL);
        try {
          _callGuardedCtx('cached:' + _cachedURL.slice(-40), cached.bind(win));
          _bridgeToGlobal();
          checkDirty();
          return;
        } catch(e) { _fireScriptError(e); checkDirty(); return; }
      }
    }

    // ── Mutation batching: coalesce DOM changes during script execution ──────
    JITBrowserEngine.beginMutationBatch();

    // Stage 1: run inside with(_winScope) so scripts resolve identifiers through
    // the window proxy (bare globals, property writes, etc.)
    // We strip hashbang and 'use strict' because:
    //  - hashbang is not valid inside a function body
    //  - 'use strict' would make the function strict, and with() is illegal in strict mode
    var src1 = _prepareForWith(code);
    var stage1Err: any = null;
    if (_jsDebug) cb.log('[JS exec] stage1 ' + (code.length / 1024).toFixed(1) + 'KB ' + (scriptURL || '(inline)'));
    try {
      var fn = new Function('__s__',
        'with(__s__){\n' + src1 + '\n}') as (s: any) => void;
      // Cache the compiled function for re-use on back/forward navigation
      if (JITBrowserEngine.ready) JITBrowserEngine.cacheScript(code, _cachedURL, fn, false);
      _callGuardedCtx('stage1:' + (scriptURL || '(inline)').slice(-40), fn, _winScope);
      _bridgeToGlobal();  // capture any new win properties set by this script
      var _batchDirty = JITBrowserEngine.endMutationBatch();
      checkDirty();
      return;
    } catch (e) {
      var msg = String(e);
      if (msg.indexOf('SyntaxError') === -1) {
        // Runtime error — report and return. No point retrying with raw code.
        _fireScriptError(e);
        JITBrowserEngine.endMutationBatch();
        checkDirty();
        return;
      }
      stage1Err = e;
    }
    // Stage 2 fallback
    cb.log('[JS exec] stage2-fallback ' + (code.length / 1024).toFixed(1) + 'KB ' + (scriptURL || '(inline)') + ' (stage1: ' + String(stage1Err) + ')');
    _bridgeToGlobal();
    var raw2 = (code.charCodeAt(0) === 35 && code.charCodeAt(1) === 33)
      ? code.replace(/^#!.*/, '') : code;
    try {
      var fn2 = new Function(raw2) as () => void;
      // Cache the stage-2 fallback function too
      if (JITBrowserEngine.ready) JITBrowserEngine.cacheScript(code, _cachedURL, fn2, false);
      _callGuardedCtx('stage2:' + (scriptURL || '(inline)').slice(-40), fn2.bind(win));
    } catch (e2) {
      // Both stage 1 and stage 2 failed — report the stage-2 error since it
      // applies to the raw (un-wrapped) code and is more meaningful to the page.
      _fireScriptError(e2);
    }
    _bridgeToGlobal();  // capture any new win properties set by this script
    JITBrowserEngine.endMutationBatch();
    checkDirty();
  }


  // ── Load external scripts synchronously via fetchAsync ───────────────────

  function loadExternalScript(src: string, done: (code?: string) => void, noAutoExec = false): void {
    var url = src.startsWith('http') ? src : _resolveURL(src, _baseHref);
    cb.log('[JS] loadExternalScript: ' + url.slice(0, 120));
    // Use deduplicated fetch to avoid redundant network requests for the same
    // script URL (common in SPAs with code-splitting / React.lazy / Suspense).
    JITBrowserEngine.deduplicatedFetch(url, (resp: FetchResponse | null, _err?: string) => {
      if (resp && resp.status === 200) {
        if (!noAutoExec) execScript(resp.bodyText, url);
        done(resp.bodyText);
      } else {
        cb.log('[JS] failed to load script (' + (resp ? resp.status : 'null') + '): ' + url);
        done(undefined);
      }
    });
  }

  // ── Run all collected scripts sequentially ────────────────────────────────

  // Module registry for basic import() support (item 534)
  var _moduleCache: Map<string, unknown> = new Map();

  // importmap registry — populated by <script type="importmap"> tags
  var _importMap: Map<string, string> = new Map();

  /** Resolve a module specifier through the importmap, then against baseHref. */
  function _resolveModuleSpecifier(specifier: string, fromURL?: string): string {
    // 1. importmap bare-specifier lookup
    if (_importMap.has(specifier)) return _importMap.get(specifier)!;
    // 2. Prefix match ("lit/" → "https://cdn.skypack.dev/lit/")
    for (var _entry of Array.from(_importMap.entries())) {
      var _key = _entry[0];
      if (_key.endsWith('/') && specifier.startsWith(_key)) {
        return _entry[1] + specifier.slice(_key.length);
      }
    }
    // 3. Relative/absolute URL
    var base = fromURL || _baseHref;
    try { return new URL(specifier, base).href; } catch(_) { return specifier; }
  }

  /** Minimal fetch helper — wraps os.fetchAsync with error normalization. */
  function _fetchURL(url: string, cb2: (err: string | null, text?: string) => void): void {
    try {
      os.fetchAsync(url, function(resp: FetchResponse | null, err?: string) {
        if (resp && resp.status >= 200 && resp.status < 300) cb2(null, resp.bodyText);
        else cb2(err || 'HTTP ' + (resp ? resp.status : 0));
      });
    } catch(e) { cb2(String(e)); }
  }

  /** Parse all static import/export-from specifiers in module code for pre-loading. */
  function _parseStaticImportSpecifiers(code: string): string[] {
    var specs: string[] = [];
    var re1 = /^[ \t]*import\s+(?:type\s+)?(?:(?:[\w$*{][^'"]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
    var re2 = /^[ \t]*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm;
    var m: RegExpExecArray | null;
    while ((m = re1.exec(code)) !== null) { if (m[1] && !m[1].startsWith('data:')) specs.push(m[1]); }
    while ((m = re2.exec(code)) !== null) { if (m[1] && !m[1].startsWith('data:')) specs.push(m[1]); }
    return specs;
  }

  /**
   * Transform ES module syntax so it can run inside new Function().
   * Static imports → synchronous __get_module__(resolvedURL) lookups (deps already loaded).
   * Exports → assignments to __esm_exports.
   */
  function _transformModuleCode(code: string, moduleURL: string): string {
    var ctr = 0;
    var header = 'var import_meta_url = ' + JSON.stringify(moduleURL) + ';\n' +
                 'var import_meta = { url: import_meta_url, env: { MODE: "production", PROD: true, DEV: false, BASE_URL: "/" }, resolve: function(s) { return s; } };\n' +
                 'var __esm_exports = {};\n';

    var out = code.replace(/\bimport\.meta\b/g, 'import_meta');
    // dynamic import() → __jsos_dynamic_import__()
    out = out.replace(/\bimport\s*\(/g, '__jsos_dynamic_import__(');

    // ── Static imports → synchronous cache lookups ────────────────────────
    var _namedExports: string[] = [];  // collect names from inline export decls
    out = out.replace(
      /^([ \t]*)import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{\s*([^}]*)\s*\})?\s*(?:\*\s+as\s+([\w$]+)\s+)?(?:from\s+)?(['"][^'"]+['"])\s*;?/gm,
      function(_full: string, _ind: string, typeOnly: string|undefined,
               defaultBind: string|undefined, namedBinds: string|undefined,
               namespaceBind: string|undefined, specifierQuoted: string): string {
        // import type { ... } → strip entirely
        if (typeOnly && !defaultBind && !namespaceBind) return '/* import type stripped */\n';
        var spec = specifierQuoted.slice(1, -1);
        var resolved = _resolveModuleSpecifier(spec, moduleURL);
        var varN = '__esm_m' + (ctr++) + '__';
        var lines = 'var ' + varN + ' = __get_module__(' + JSON.stringify(resolved) + ');\n';
        if (defaultBind) lines += 'var ' + defaultBind + ' = (' + varN + '["default"] !== undefined ? ' + varN + '["default"] : ' + varN + ');\n';
        if (namedBinds) {
          namedBinds.split(',').forEach(function(b: string) {
            b = b.trim(); if (!b || b === 'type') return;
            var pts = b.split(/\s+as\s+/); var src = pts[0].trim(); var local = (pts[1] || pts[0]).trim();
            if (src && src !== 'type' && local) lines += 'var ' + local + ' = ' + varN + '[' + JSON.stringify(src) + '];\n';
          });
        }
        if (namespaceBind) lines += 'var ' + namespaceBind + ' = ' + varN + ';\n';
        if (!defaultBind && !namedBinds && !namespaceBind) lines += '// side-effect import: ' + spec + '\n';
        return lines;
      }
    );

    // ── Re-exports: export * from 'mod' (optionally as NS) ───────────────
    out = out.replace(/^[ \t]*export\s+\*\s+(?:as\s+([\w$]+)\s+)?from\s+(['"][^'"]+['"])\s*;?/gm,
      function(_: string, ns: string|undefined, sq: string): string {
        var resolved = _resolveModuleSpecifier(sq.slice(1,-1), moduleURL);
        var varN = '__esm_m' + (ctr++) + '__';
        if (ns) return 'var ' + varN + ' = __get_module__(' + JSON.stringify(resolved) + ');\n__esm_exports[' + JSON.stringify(ns) + '] = ' + varN + ';\n';
        return 'var ' + varN + ' = __get_module__(' + JSON.stringify(resolved) + ');\nObject.assign(__esm_exports, ' + varN + ');\n';
      });

    // ── Re-exports: export { a, b as B } from 'mod' ──────────────────────
    out = out.replace(/^[ \t]*export\s+\{([^}]*)\}\s+from\s+(['"][^'"]+['"])\s*;?/gm,
      function(_: string, binds: string, sq: string): string {
        var resolved = _resolveModuleSpecifier(sq.slice(1,-1), moduleURL);
        var varN = '__esm_m' + (ctr++) + '__';
        var result = 'var ' + varN + ' = __get_module__(' + JSON.stringify(resolved) + ');\n';
        binds.split(',').forEach(function(b: string) {
          b = b.trim(); if (!b) return;
          var pts = b.split(/\s+as\s+/); var src = pts[0].trim(); var exported = (pts[1] || pts[0]).trim();
          if (src && exported) result += '__esm_exports[' + JSON.stringify(exported) + '] = ' + varN + '[' + JSON.stringify(src) + '];\n';
        });
        return result;
      });

    // ── Local re-exports: export { a, b as B } (no 'from') ───────────────
    out = out.replace(/^[ \t]*export\s+\{([^}]*)\}\s*;?/gm,
      function(_: string, binds: string): string {
        var result = '';
        binds.split(',').forEach(function(b: string) {
          b = b.trim(); if (!b) return;
          var pts = b.split(/\s+as\s+/); var local = pts[0].trim(); var exported = (pts[1] || pts[0]).trim();
          if (local && exported) result += '__esm_exports[' + JSON.stringify(exported) + '] = ' + local + ';\n';
        });
        return result;
      });

    // ── export default expr ────────────────────────────────────────────────
    out = out.replace(/^([ \t]*)export\s+default\s+/gm, '$1__esm_exports["default"] = ');

    // ── export const/let/var NAME → strip export, collect name ───────────
    out = out.replace(/^([ \t]*)export\s+(const|let|var)\s+([\w$]+)/gm,
      function(_: string, ind: string, kw: string, name: string): string {
        _namedExports.push(name); return ind + kw + ' ' + name;
      });

    // ── export function/class/async function NAME → strip export, collect name
    out = out.replace(/^([ \t]*)export\s+(async\s+function|function|class)\s+([\w$]+)/gm,
      function(_: string, ind: string, kw: string, name: string): string {
        _namedExports.push(name); return ind + kw + ' ' + name;
      });

    // ── Remaining bare export keyword (safety net) ────────────────────────
    out = out.replace(/^[ \t]*export\s+/gm, '');

    // ── Append named export registrations at end ──────────────────────────
    var trailer = _namedExports.length > 0
      ? '\n' + _namedExports.map(function(n: string) {
          return 'if (typeof ' + n + ' !== "undefined") __esm_exports[' + JSON.stringify(n) + '] = ' + n + ';';
        }).join('\n') + '\n'
      : '';

    return header + out + trailer;
  }

  /**
   * Dynamic import() implementation — recursively pre-loads all static dependencies
   * before executing any module, then executes once and caches the exports.
   */
  function __jsos_dynamic_import__(specifier: string, fromURL?: string): Promise<Record<string, unknown>> {
    var resolved = _resolveModuleSpecifier(specifier, fromURL || _baseHref);
    if (_moduleCache.has(resolved)) return Promise.resolve(_moduleCache.get(resolved) as Record<string, unknown>);

    // In-progress guard — prevents duplicate parallel fetches of the same module
    var _inProgressKey = '__loading__' + resolved;
    if ((_moduleCache as any)[_inProgressKey]) return (_moduleCache as any)[_inProgressKey] as Promise<Record<string, unknown>>;

    var loading: Promise<Record<string, unknown>> = new Promise<Record<string, unknown>>(function(resolve, reject) {
      _fetchURL(resolved, function(err: string | null, text?: string) {
        if (err || !text) {
          cb.log('[JS] module fetch failed: ' + resolved + (err ? ' (' + err + ')' : ''));
          reject(new Error('Failed to import: ' + resolved));
          return;
        }

        // Pre-load ALL static dependencies before executing this module
        var depSpecs = _parseStaticImportSpecifiers(text);
        var depPromises: Promise<unknown>[] = depSpecs.map(function(spec: string) {
          return __jsos_dynamic_import__(spec, resolved).catch(function(e: unknown) {
            cb.log('[JS] dep load failed: ' + spec + ' (' + String(e) + ')');
          });
        });

        Promise.all(depPromises).then(function() {
          // All deps are now in _moduleCache — transform and execute synchronously
          if (_moduleCache.has(resolved)) { resolve(_moduleCache.get(resolved) as Record<string, unknown>); return; }
          var transformed = _transformModuleCode(text, resolved);
          var __get_module__ = function(url: string): Record<string, unknown> {
            return (_moduleCache.get(url) as Record<string, unknown>) ?? ({} as Record<string, unknown>);
          };
          try {
            var wrapFn = new Function('__jsos_dynamic_import__', '__get_module__',
              transformed + '\nreturn __esm_exports;') as
              (di: typeof __jsos_dynamic_import__, gm: typeof __get_module__) => Record<string, unknown>;
            var esm_exports = wrapFn.call(win, __jsos_dynamic_import__, __get_module__);
            _moduleCache.set(resolved, esm_exports);
            resolve(esm_exports);
          } catch(e) {
            _fireScriptError(e);
            _moduleCache.set(resolved, {});
            resolve({});
          }
        }).catch(function(e: unknown) { _fireScriptError(e); reject(e); });
      });
    });

    (_moduleCache as any)[_inProgressKey] = loading;
    loading.then(
      function() { delete (_moduleCache as any)[_inProgressKey]; },
      function() { delete (_moduleCache as any)[_inProgressKey]; }
    );
    return loading;
  }

  function runScripts(idx: number): void {
    if (idx >= scripts.length) {
      (doc as any)._readyState = 'interactive';

      // Wire <body on*="..."> attribute event handlers to window (item 571)
      // Real browsers treat <body onload>, <body onDOMContentLoaded>, etc. as
      // window-level event handlers, not body element handlers.
      var _bodyEl = doc.body as any;
      if (_bodyEl) {
        var _bodyEventAttrs = ['onload', 'onunload', 'onbeforeunload', 'onpagehide', 'onpageshow',
          'onhashchange', 'onpopstate', 'onstorage', 'onmessage', 'onerror', 'onresize', 'onscroll',
          'onoffline', 'ononline', 'onfocus', 'onblur'];
        for (var _bae = 0; _bae < _bodyEventAttrs.length; _bae++) {
          var _bAttr = _bodyEventAttrs[_bae];
          var _bAttrVal = typeof _bodyEl.getAttribute === 'function' ? _bodyEl.getAttribute(_bAttr) : null;
          if (_bAttrVal && !(win as any)[_bAttr]) {
            var _bHandler = _makeHandler(_bAttrVal);
            if (_bHandler) {
              (win as any)[_bAttr] = _bHandler;
            }
          }
        }
      }

      var dclEv = new VEvent('DOMContentLoaded', { bubbles: true });
      doc.dispatchEvent(dclEv);
      (doc as any)._readyState = 'complete';
      var loadEv = new VEvent('load');
      (win['dispatchEvent'] as (e: VEvent) => void)(loadEv);
      doc.dispatchEvent(loadEv);

      // ── SPA detection: analyse loaded scripts for framework fingerprints ──
      var _loadedSources: string[] = [];
      for (var _si = 0; _si < scripts.length; _si++) {
        if (scripts[_si].code) _loadedSources.push(scripts[_si].code);
      }
      // (SPA detection removed — detectSPA is a no-op)

      // (site-specific mutation batch removed — no endMutationBatch needed)

      // ── Prefetch visible links for instant navigation ─────────────────────
      try {
        var _links = doc.querySelectorAll('a[href]');
        var _prefetchCount = 0;
        for (var _li = 0; _li < _links.length && _prefetchCount < 5; _li++) {
          var _lHref = (_links[_li] as VElement).getAttribute('href');
          if (_lHref && _lHref.startsWith('http') && _lHref.indexOf(_locPart('hostname')) >= 0) {
            JITBrowserEngine.prefetchURL(_lHref);
            _prefetchCount++;
          }
        }
      } catch(_) {}

      checkDirty();
      if (needsRerender) doRerender();
      return;
    }
    var s = scripts[idx];

    // importmap — populate _importMap before any scripts run
    if (s.type && s.type.trim().toLowerCase() === 'importmap') {
      if (s.inline && s.code) {
        try {
          var _im = JSON.parse(s.code) as { imports?: Record<string, string> };
          if (_im && _im.imports) Object.keys(_im.imports).forEach(function(k) { _importMap.set(k, (_im.imports as any)[k]); });
        } catch(_imErr) { cb.log('[importmap parse error] ' + String(_imErr)); }
      }
      runScripts(idx + 1); return;
    }

    // Skip non-JS script types (but allow 'module')
    if (s.type && !s.type.match(/javascript|ecmascript|module|text$/i)) {
      runScripts(idx + 1); return;
    }

    var isModule = !!(s.type && s.type.toLowerCase().includes('module'));

    if (s.inline) {
      if (isModule) {
        // Inline module: pre-load static deps then execute
        var _iModURL = _baseHref + '#inline-' + idx;
        var _iDepSpecs = _parseStaticImportSpecifiers(s.code);
        var _iDeps = _iDepSpecs.map(function(spec: string) {
          return __jsos_dynamic_import__(spec, _iModURL).catch(function(e: unknown) {
            cb.log('[JS] inline module dep failed: ' + spec + ' (' + String(e) + ')');
          });
        });
        Promise.all(_iDeps).then(function() {
          var _iTrans = _transformModuleCode(s.code, _iModURL);
          var _iGet = function(url: string): Record<string, unknown> {
            return (_moduleCache.get(url) as Record<string, unknown>) ?? ({} as Record<string, unknown>);
          };
          try {
            var _iFn = new Function('__jsos_dynamic_import__', '__get_module__', _iTrans) as
              (di: typeof __jsos_dynamic_import__, gm: typeof _iGet) => void;
            _callGuardedCtx('inline-module#' + idx, _iFn.bind(win), __jsos_dynamic_import__, _iGet);
          } catch(e) { _fireScriptError(e); }
          checkDirty();
          runScripts(idx + 1);
        });
      } else {
        execScript(s.code);
        _drainMicrotasks();  // drain Promise jobs after each inline script
        runScripts(idx + 1);
      }
    } else {
      if (isModule) {
        // External module: full ESM loader (pre-loads deps recursively)
        __jsos_dynamic_import__(s.src, _baseHref).then(function() {
          checkDirty();
          runScripts(idx + 1);
        }).catch(function(e: unknown) {
          _fireScriptError(e);
          runScripts(idx + 1);
        });
      } else {
        loadExternalScript(s.src, function() { runScripts(idx + 1); }, false);
      }
    }
  }


  // ── Wire handlers then kick off script execution ──────────────────────────

  // Post-win wiring: connect doc back to win and page URL
  (doc as any)._defaultView = win;
  (doc as any)._url = cb.baseURL;
  (doc as any)._selectionRef = _selection;
  // Wire OS clipboard so execCommand('copy'/'paste') works
  (doc as any)._osClipboard = { read: () => { try { return os.clipboard.read(); } catch(_) { return ''; } }, write: (t: string) => { try { os.clipboard.write(t); } catch(_) {} } };

  // Wire document.adoptedStyleSheets (Constructable Stylesheets — LitElement, Shadow DOM, etc.)
  Object.defineProperty(doc, 'adoptedStyleSheets', {
    get(): unknown[] { return (doc as any)._adoptedStyleSheets ?? []; },
    set(sheets: unknown[]): void {
      (doc as any)._adoptedStyleSheets = Array.isArray(sheets) ? sheets : [];
      bumpStyleGeneration();
      doc._dirty = true;
    },
    configurable: true,
  });

  // Wire document.cookie to the shared cookie jar (items 303-304)
  Object.defineProperty(doc, 'cookie', {
    get(): string {
      try { var _du = new URL(_effectiveHref()); return cookieJar.getDocumentCookies(_du.hostname, _du.pathname); } catch(_) { return ''; }
    },
    set(v: string): void {
      cb.log('[browser] document.cookie set: ' + String(v).slice(0, 80));
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

  // Expose dynamic-import helper on win so both stage-1 (with(_winScope)) and
  // stage-2 (globalThis bridge) scripts can call it as a bare identifier.
  (win as any).__jsos_dynamic_import__ = __jsos_dynamic_import__;
  // Expose debug flag so pages / REPL can toggle: window.__jsDebug = false
  Object.defineProperty(win, '__jsDebug', {
    get() { return _jsDebug; },
    set(v: boolean) { _jsDebug = !!v; cb.log('[jscb] debug ' + (_jsDebug ? 'ON' : 'OFF')); },
    configurable: true, enumerable: false,
  });

  // ── Dynamic script injection: auto-execute <script> elements added to DOM ─
  // Modern pages (Google, React apps, etc.) insert <script src="..."> via JS.
  // Without this hook they fetch resources but never execute any JS.
  doc._scriptInsertHook = function(scriptEl: VElement): void {
    if (disposed) return;
    // Prevent double-execution (e.g. element moved between containers)
    if ((scriptEl as any)._jsrExecuted) return;
    (scriptEl as any)._jsrExecuted = true;
    // Ignore non-JS content types
    var typeAttr = (scriptEl.getAttribute('type') || '').toLowerCase().trim();
    if (typeAttr && typeAttr !== 'text/javascript' && typeAttr !== 'application/javascript' &&
        typeAttr !== 'module' && typeAttr !== 'text/ecmascript' && typeAttr !== 'application/ecmascript') {
      return;
    }
    var srcAttr = scriptEl.getAttribute('src');
    if (srcAttr) {
      // External script: fetch and execute asynchronously via existing machinery
      loadExternalScript(srcAttr, function(code?: string): void {
        if (disposed) return;
        checkDirty();
        if (needsRerender) doRerender();
        var evType = (code !== undefined) ? 'load' : 'error';
        var ev = new VEvent(evType, { bubbles: false, cancelable: false });
        scriptEl.dispatchEvent(ev);
        var handler = (scriptEl as any)[evType === 'load' ? 'onload' : 'onerror'];
        if (typeof handler === 'function') { try { handler(ev); } catch(_) {} }
      }, false /* auto-exec inside loadExternalScript */);
    } else {
      // Inline script: execute text content synchronously
      var code = scriptEl.textContent || '';
      if (code.trim()) {
        execScript(code);
        _drainMicrotasks();
        checkDirty();
        if (needsRerender) doRerender();
      }
    }
  };

  cb.log('[browser] loading ' + scripts.length + ' script(s) for ' + (cb.baseURL || '').slice(0, 80));

  // ── Custom Elements: connectedCallback / disconnectedCallback hook ────────
  doc._ceInsertHook = function(el: VElement): void {
    if (disposed) return;
    var tagLower = el.tagName.toLowerCase();
    var ceCtor = _ceRegistry.get(tagLower);
    if (!ceCtor) return;
    // Check if the element is a CE instance (has connectedCallback)
    var cb2 = (el as any).connectedCallback;
    if (typeof cb2 === 'function') {
      try { cb2.call(el); } catch (err) { cb.log('[ce] connectedCallback error: ' + String(err)); }
    } else {
      // The element was created by _origCreateElement (not CE ctor) — upgrade it
      // by copying methods from the prototype
      var proto = (ceCtor as any).prototype;
      if (proto) {
        var ccFn = proto.connectedCallback;
        if (typeof ccFn === 'function') {
          try { ccFn.call(el); } catch (err) { cb.log('[ce] connectedCallback error: ' + String(err)); }
        }
      }
    }
  };

  // ── CSS Transitions: intercept inline style mutations (Tier 4.3) ──────────
  doc._styleSetHook = function(el: VElement, prop: string, oldVal: string, newVal: string): boolean {
    if (disposed) return false;
    // Get the computed transition for this element
    var cs = getComputedStyle(el);
    var transCss = cs['transition'] || cs.getPropertyValue('transition') || '';
    if (!transCss || transCss === 'none') return false;
    var tmap = _parseTransition(transCss);
    var entry = tmap.get(prop) || tmap.get('all');
    if (!entry || entry.durationMs <= 0) return false;
    // Cancel any existing transition for this prop+el
    for (var _ati = 0; _ati < _activeTrans.length; _ati++) {
      var _at = _activeTrans[_ati];
      if (_at.el === el && _at.prop === prop) { _at.done = true; }
    }
    // Use current animated value as fromVal if there's an in-progress transition
    var actualFrom = el._style._map.get(prop) || oldVal || cs.getPropertyValue(prop) || '0';
    _activeTrans.push({
      el, prop, fromVal: actualFrom, toVal: newVal,
      startMs: _perf.now(), durationMs: entry.durationMs, easing: entry.easing, done: false,
    });
    needsRerender = true;
    return true; // handled; don't apply immediately
  };

  // Phase 0 cleanup: conflicting polyfill files deleted — jsruntime.ts now
  // provides all Web Platform APIs directly; no external shim layers.

  // Site-specific optimization profiles removed — general-purpose implementation
  // now handles all sites via proper web-standards compliance.

  // ── Flush script cache on full navigation (not back/forward) ──────────────
  // The cache persists across session to accelerate revisits, but we flush if
  // the origin has changed to avoid stale closures with wrong window refs.
  // (Within same origin, cached Functions get re-bound correctly.)

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
    fireFocus(id: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id);
        if (!el) return;
        var ev = new VEvent('focus', { bubbles: false, cancelable: false });
        el.dispatchEvent(ev);
        var ev2 = new VEvent('focusin', { bubbles: true, cancelable: false });
        el.dispatchEvent(ev2);
      });
    },
    fireBlur(id: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id);
        if (!el) return;
        var ev = new VEvent('blur', { bubbles: false, cancelable: false });
        el.dispatchEvent(ev);
        var ev2 = new VEvent('focusout', { bubbles: true, cancelable: false });
        el.dispatchEvent(ev2);
      });
    },
    fireMouse(id: string, eventType: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id);
        if (!el) return;
        var ev = new VEvent(eventType, { bubbles: true, cancelable: true });
        (ev as any).clientX = 0; (ev as any).clientY = 0;
        (ev as any).pageX = 0; (ev as any).pageY = 0;
        (ev as any).button = 0; (ev as any).buttons = 0;
        el.dispatchEvent(ev);
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
      _unbridgeFromGlobal();
      timers = []; rafCallbacks = [];
      // Destroy child runtime if active
      if (_pageChildId >= 0) {
        try { (kernel as any).procDestroy(_pageChildId); } catch(_) {}
        cb.log('[JS] child runtime destroyed (slot ' + _pageChildId + ')');
        _pageChildId = -1;
        _useChildRuntime = false;
      }
      // Close active WebSocket connections
      for (var _wsd = 0; _wsd < _wsSockets.length; _wsd++) {
        var _wse = _wsSockets[_wsd];
        try { _wse.sock.close(); } catch(_) {}
        _wse.ws.readyState = 3;
      }
      _wsSockets.length = 0;
      // Log JIT browser engine stats for perf monitoring
      if (JITBrowserEngine.ready) {
        var _bs = JITBrowserEngine.stats();
        cb.log('[jit-browser] scripts cached=' + _bs.scriptCacheEntries +
          ' hitRate=' + ((_bs.scriptCacheHitRate * 100) | 0) + '%' +
          ' fetchDedup=' + ((_bs.fetchDedupRate * 100) | 0) + '%' +
          ' spa=' + _bs.spaFramework);
      }
      // fire beforeunload
      try { var ev = new VEvent('beforeunload'); doc.dispatchEvent(ev); } catch(_) {}
      // Per-tab cleanup: clear blob URLs, sessionStorage
      _blobStore.clear();
      _sessionStorage._data.clear();
    },
    tick(nowMs: number): void {
      if (disposed) return;
      var frameStart = _perf.now();
      // Fire RAF callbacks
      if (rafCallbacks.length) {
        var cbs = rafCallbacks.splice(0);
        for (var r of cbs) {
          _callGuardedCtx('raf#' + r.id, r.fn, nowMs);
          _drainMicrotasks();
        }
        checkDirty();
        if (needsRerender) doRerender();  // flush DOM changes made by RAF handlers
      }
      // Fire elapsed timers (drain microtasks after each)
      var elapsed = nowMs;
      var fired = false;
      for (var i = timers.length - 1; i >= 0; i--) {
        var t = timers[i];
        if (elapsed >= t.fireAt) {
          _callGuardedCtx((t.interval ? 'interval' : 'timeout') + '#' + t.id + '(' + t.delay + 'ms)', t.fn);
          _drainMicrotasks();
          if (t.interval) { t.fireAt = elapsed + t.delay; }
          else { timers.splice(i, 1); }
          fired = true;
        }
      }
      if (fired) { checkDirty(); if (needsRerender) doRerender(); }
      // Advance CSS transitions
      if (_activeTrans.length > 0) {
        _tickTransitions(nowMs);
        checkDirty();
        if (needsRerender) doRerender();
      }
      // Advance CSS @keyframes animations
      if (currentStyleGeneration() !== _lastAnimScanGen) _scanAnimations(nowMs);
      if (_activeAnims.size > 0) {
        _tickAnimations(nowMs);
        checkDirty();
        if (needsRerender) doRerender();
      }
      // Pump Intersection and Resize Observers (use real viewport height)
      var viewH = ((win['innerHeight'] as number) || 768);
      var viewW = ((win['innerWidth']  as number) || 1024);
      for (var io of _ioObservers) io._tick(viewH, viewW);
      for (var ro of _roObservers) ro._tick();
      // Poll WebSocket connections for incoming data
      if (_wsSockets.length > 0) _tickWebSockets();
      // Poll EventSource / SSE streams
      if (_sseSockets.length > 0) _tickSSE();
      // Pump all Web Workers
      tickAllWorkers();
      // Record frame timing
      _perf.recordFrame(frameStart, _perf.now() - frameStart);
    },
    updateLayoutRects(rects: Map<string, { x: number; y: number; w: number; h: number }>): void {
      // Walk all VElements that have a data-jsos-el attribute and update their _layoutRect
      // This enables getBoundingClientRect / offsetWidth / offsetHeight to return real values
      rects.forEach(function(rect, elId) {
        var el = doc.querySelector('[data-jsos-el="' + elId + '"]');
        if (!el) el = doc.querySelector('#' + elId) as VElement | null;
        if (el) {
          (el as VElement)._layoutRect = rect;
        }
      });
    },
    getCanvasBuffers(): Array<{ elId: string; width: number; height: number; rgba: Uint8Array }> {
      var result: Array<{ elId: string; width: number; height: number; rgba: Uint8Array }> = [];
      for (var ci = 0; ci < _canvasElements.length; ci++) {
        var c = _canvasElements[ci];
        if (c._ctx) {
          result.push({ elId: c._elId, width: c.width, height: c.height, rgba: c._ctx.framebuffer });
        }
      }
      return result;
    },
    fireEvent(type: string, _detail?: number): void {
      // Dispatch generic window/document events (e.g. 'scroll') from host to page JS
      var ev = new VEvent(type, { bubbles: type !== 'scroll' });
      (win['dispatchEvent'] as (e: VEvent) => void)(ev);
      if (type === 'scroll') {
        doc.dispatchEvent(new VEvent('scroll', { bubbles: false }));
        // Also update document.documentElement.scrollTop
        try { (doc.documentElement as any)._scrollTop = _detail ?? 0; } catch(_) {}
      }
      checkDirty();
      if (needsRerender) doRerender();
    },
  };
}
