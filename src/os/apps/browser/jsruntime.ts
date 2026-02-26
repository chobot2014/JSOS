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
  VDocument, VElement, VEvent, VText,
  buildDOM, serializeDOM, _walk,
} from './dom.js';

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

// ── Storage (per-origin, in-memory) ──────────────────────────────────────────

class VStorage {
  _data: Map<string, string> = new Map();
  get length(): number { return this._data.size; }
  setItem(k: string, v: string): void { this._data.set(String(k), String(v)); }
  getItem(k: string): string | null { return this._data.get(String(k)) ?? null; }
  removeItem(k: string): void { this._data.delete(String(k)); }
  clear(): void { this._data.clear(); }
  key(n: number): string | null { return [...this._data.keys()][n] ?? null; }
}

var _localStorage  = new VStorage();
var _sessionStorage = new VStorage();

// ── Main factory ──────────────────────────────────────────────────────────────

export function createPageJS(
  fullHTML:  string,
  scripts:   ScriptRecord[],
  cb:        PageCallbacks,
): PageJS | null {

  // Skip pages with no JS
  if (scripts.length === 0) return null;

  // Build virtual DOM from the full page HTML
  var doc = buildDOM(fullHTML);

  // Timer machinery
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
  function checkDirty(): void { if (doc._dirty) { doc._dirty = false; needsRerender = true; } }

  // Re-render helper
  function doRerender(): void {
    needsRerender = false;
    // Update title if changed
    if (doc.title) cb.setTitle(doc.title);
    cb.rerender(serializeDOM(doc));
    // Rebuild the DOM from the new HTML so subsequent JS keeps working
    // (we keep the existing doc object but sync values back from serialized form)
  }

  // ── window.location ────────────────────────────────────────────────────────

  var location = {
    get href(): string { return cb.baseURL; },
    set href(v: string) { cb.navigate(v); },
    assign(url: string)  { cb.navigate(url); },
    replace(url: string) { cb.navigate(url); },
    reload()             { cb.navigate(cb.baseURL); },
    get pathname(): string { try { return new URL(cb.baseURL).pathname; } catch(_) { return '/'; } },
    get hostname(): string { try { return new URL(cb.baseURL).hostname; } catch(_) { return ''; } },
    get protocol(): string { try { return new URL(cb.baseURL).protocol; } catch(_) { return 'http:'; } },
    get host():     string { try { return new URL(cb.baseURL).host;     } catch(_) { return ''; } },
    get search():   string { try { return new URL(cb.baseURL).search;   } catch(_) { return ''; } },
    get hash():     string { try { return new URL(cb.baseURL).hash;     } catch(_) { return ''; } },
    toString():     string { return cb.baseURL; },
  };

  // ── window.history ─────────────────────────────────────────────────────────

  var history = {
    _stack: [cb.baseURL], _pos: 0,
    get length(): number { return this._stack.length; },
    pushState(_state: unknown, _title: string, url: string) { this._stack.push(url); this._pos = this._stack.length - 1; location.href = url; },
    replaceState(_state: unknown, _title: string, url: string) { this._stack[this._pos] = url; },
    back()    { if (this._pos > 0) { this._pos--; cb.navigate(this._stack[this._pos]); } },
    forward() { if (this._pos < this._stack.length - 1) { this._pos++; cb.navigate(this._stack[this._pos]); } },
    go(delta: number) { var t = this._pos + delta; if (t >= 0 && t < this._stack.length) { this._pos = t; cb.navigate(this._stack[this._pos]); } },
  };

  // ── window.navigator ───────────────────────────────────────────────────────

  var navigator = {
    userAgent:  'JSOS Browser/1.0 (QuickJS)',
    platform:   'JSOS',
    language:   'en-US',
    languages:  ['en-US'],
    cookieEnabled: true,
    onLine:     true,
    geolocation: { getCurrentPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); }, watchPosition(_s: unknown, e: ((err: unknown) => void) | undefined) { if (e) e({ code: 1, message: 'Not supported' }); return 0; }, clearWatch() {} },
    sendBeacon() { return false; },
  };

  // ── window.screen ─────────────────────────────────────────────────────────

  var screen = { width: 1024, height: 768, availWidth: 1024, availHeight: 768, colorDepth: 32, pixelDepth: 32 };

  // ── CustomEvent ───────────────────────────────────────────────────────────

  class CustomEvent extends VEvent {
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown; bubbles?: boolean; cancelable?: boolean }) {
      super(type, init); this.detail = init?.detail ?? null;
    }
  }

  // ── fetch API ─────────────────────────────────────────────────────────────

  function fetchAPI(url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
    return new Promise((resolve, reject) => {
      os.fetchAsync(url, (resp: FetchResponse | null, err?: string) => {
        if (!resp) { reject(new Error(err || 'fetch failed')); return; }
        var text  = resp.bodyText;
        var hdrs  = resp.headers;
        resolve({
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          statusText: String(resp.status),
          headers: { get: (k: string) => hdrs.get(k) ?? null, has: (k: string) => hdrs.get(k) !== null },
          text()   { return Promise.resolve(text); },
          json()   { return Promise.resolve(JSON.parse(text)); },
          blob()   { return Promise.resolve(new Blob([text])); },
          arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); },
          clone()  { return this; },
        });
      }, opts ? { method: (opts.method || 'GET') as 'GET' | 'POST', headers: opts.headers } : undefined);
    });
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────────

  class XMLHttpRequest {
    readyState = 0; status = 0; statusText = ''; responseText = ''; responseXML = null; response: any = null;
    responseType = ''; withCredentials = false; timeout = 0;
    onreadystatechange: (() => void) | null = null;
    onload:    (() => void) | null = null;
    onerror:   (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    _method = 'GET'; _url = ''; _headers: Record<string, string> = {};

    open(method: string, url: string, _async = true): void { this._method = method; this._url = url; this.readyState = 1; }
    setRequestHeader(k: string, v: string): void { this._headers[k] = v; }
    getResponseHeader(k: string): string | null { return null; }
    getAllResponseHeaders(): string { return ''; }
    send(_body?: string | null): void {
      var self = this;
      os.fetchAsync(this._url, (resp: FetchResponse | null, _err?: string) => {
        if (resp) {
          self.status = resp.status; self.statusText = String(resp.status);
          self.responseText = resp.bodyText; self.response = resp.bodyText;
          self.readyState = 4;
        } else {
          self.status = 0; self.readyState = 4;
        }
        try { if (self.onreadystatechange) self.onreadystatechange(); } catch(_) {}
        try { if (resp && self.onload) self.onload(); else if (!resp && self.onerror) self.onerror(); } catch(_) {}
      }, { method: this._method as 'GET' | 'POST', headers: this._headers });
    }
    abort(): void { this.readyState = 0; }
    addEventListener(type: string, fn: () => void): void {
      if (type === 'load')    this.onload    = fn;
      if (type === 'error')   this.onerror   = fn;
      if (type === 'timeout') this.ontimeout = fn;
    }
  }

  // ── console ───────────────────────────────────────────────────────────────

  var console_ = {
    log(...a: unknown[]):   void { cb.log('[JS log] ' + a.map(String).join(' ')); },
    info(...a: unknown[]):  void { cb.log('[JS info] ' + a.map(String).join(' ')); },
    warn(...a: unknown[]):  void { cb.log('[JS warn] ' + a.map(String).join(' ')); },
    error(...a: unknown[]): void { cb.log('[JS err] ' + a.map(String).join(' ')); },
    debug(...a: unknown[]): void { cb.log('[JS dbg] ' + a.map(String).join(' ')); },
    table(v: unknown):      void { cb.log('[JS tbl] ' + JSON.stringify(v)); },
    time(_l?: string):      void {},
    timeEnd(_l?: string):   void {},
    group():                void {},
    groupEnd():             void {},
    clear():                void {},
  };

  // ── Blob / URL ────────────────────────────────────────────────────────────

  class Blob {
    _parts: string[]; type: string;
    constructor(parts: string[] = [], opts?: { type?: string }) { this._parts = parts; this.type = opts?.type || ''; }
    text(): Promise<string> { return Promise.resolve(this._parts.join('')); }
    size = 0;
  }

  var URL_ = {
    createObjectURL(_b: Blob): string { return 'blob:jsos/fake'; },
    revokeObjectURL(_u: string): void {},
    parse(url: string, base?: string): URL | null { try { return new URL(url, base); } catch(_) { return null; } },
  };

  // ── MutationObserver (stub) ───────────────────────────────────────────────

  class MutationObserver {
    _fn: (mutations: unknown[]) => void;
    constructor(fn: (mutations: unknown[]) => void) { this._fn = fn; }
    observe(_node: unknown, _opts?: unknown): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return []; }
  }

  // ── IntersectionObserver (stub) ───────────────────────────────────────────

  class IntersectionObserver {
    constructor(_fn: unknown, _opts?: unknown) {}
    observe(_el: unknown): void {}
    unobserve(_el: unknown): void {}
    disconnect(): void {}
  }

  // ── ResizeObserver (stub) ─────────────────────────────────────────────────

  class ResizeObserver {
    constructor(_fn: unknown) {}
    observe(_el: unknown): void {}
    unobserve(_el: unknown): void {}
    disconnect(): void {}
  }

  // ── window.getComputedStyle stub ──────────────────────────────────────────

  function getComputedStyle(el: VElement): any {
    return new Proxy({}, {
      get(_t, k: string) {
        if (typeof k !== 'string') return undefined;
        if (k === 'getPropertyValue') return (p: string) => el._style.getPropertyValue(p);
        return el._style.getPropertyValue(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
      },
    });
  }

  // ── window.requestAnimationFrame / cancelAnimationFrame ───────────────────

  var rafCallbacks: Array<{ id: number; fn: (ts: number) => void }> = [];
  var rafSeq = 1;
  function requestAnimationFrame(fn: (ts: number) => void): number { var id = rafSeq++; rafCallbacks.push({ id, fn }); return id; }
  function cancelAnimationFrame(id: number): void { rafCallbacks = rafCallbacks.filter(r => r.id !== id); }

  // ── Performance ───────────────────────────────────────────────────────────

  var _t0 = Date.now();
  var performance = { now(): number { return Date.now() - _t0; }, mark() {}, measure() {}, getEntriesByName() { return []; }, getEntriesByType() { return []; } };

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
    subtle: { digest() { return Promise.reject(new Error('not supported')); }, sign() { return Promise.reject(new Error('not supported')); } },
  };

  // ── DOMParser stub ────────────────────────────────────────────────────────

  class DOMParser {
    parseFromString(html: string, _type: string) { return buildDOM(html); }
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

    // DOM constructors
    Event:              VEvent,
    CustomEvent,
    MutationObserver,
    IntersectionObserver,
    ResizeObserver,
    DOMParser,
    TextEncoder: TextEncoder_,
    TextDecoder: TextDecoder_,
    HTMLCanvasElement: HTMLCanvas,

    // Viewport
    innerWidth: 1024, innerHeight: 768,
    outerWidth: 1024, outerHeight: 768,
    devicePixelRatio: 1,
    screenX: 0, screenY: 0, pageXOffset: 0, pageYOffset: 0,

    // Storage
    localStorage:  _localStorage,
    sessionStorage: _sessionStorage,

    // Misc
    console: console_,
    Blob,
    URL: URL_,
    URLSearchParams,
    FormData,
    Headers: Map,
    AbortController: class { signal = { aborted: false }; abort() { this.signal.aborted = true; } },

    // Utilities
    getComputedStyle,
    matchMedia: (_q: string) => ({ matches: false, media: _q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    open:     (_url: string) => { win.location = { href: _url }; cb.navigate(_url); return null; },
    close:    () => {},
    focus:    () => {},
    blur:     () => {},
    scrollTo: (x: number, y: number) => cb.scrollTo(x, y),
    scrollBy: (_x: number, dy: number) => cb.scrollTo(0, cb.getScrollY() + dy),
    scroll:   (x: number, y: number) => cb.scrollTo(x, y),
    alert:    (msg: unknown) => cb.alert(String(msg ?? '')),
    confirm:  (msg: unknown): boolean => cb.confirm(String(msg ?? '')),
    prompt:   (msg: unknown, def: unknown): string => cb.prompt(String(msg ?? ''), String(def ?? '')),
    print:    () => {},
    postMessage: () => {},
    dispatchEvent: (ev: VEvent) => doc.dispatchEvent(ev),
    addEventListener:    (t: string, fn: (e: VEvent) => void) => doc.addEventListener(t, fn),
    removeEventListener: (t: string, fn: (e: VEvent) => void) => doc.removeEventListener(t, fn),

    // Standard JS globals (in case scripts shadow these)
    undefined, null: null, NaN, Infinity, isFinite, isNaN, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    JSON, Math, Date, RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError,
    Promise, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect,
    Array, Object, String, Number, Boolean, BigInt,
    ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array,
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
    queueMicrotask: (fn: () => void) => setTimeout_( fn, 0),
    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v)),
  };

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
    }
    checkDirty();
  }

  // ── Load external scripts synchronously via fetchAsync ───────────────────

  function loadExternalScript(src: string, done: () => void): void {
    var url = src.startsWith('http') ? src : (cb.baseURL.replace(/\/[^/]*$/, '/') + src);
    os.fetchAsync(url, (resp: FetchResponse | null, _err?: string) => {
      if (resp && resp.status === 200) execScript(resp.bodyText);
      else cb.log('[JS] failed to load script: ' + url);
      done();
    });
  }

  // ── Run all collected scripts sequentially ────────────────────────────────

  function runScripts(idx: number): void {
    if (idx >= scripts.length) {
      // All scripts done — fire DOMContentLoaded, then load
      var dclEv = new VEvent('DOMContentLoaded', { bubbles: true });
      doc.dispatchEvent(dclEv);
      var loadEv = new VEvent('load');
      (win['dispatchEvent'] as (e: VEvent) => void)(loadEv);  // window.onload
      doc.dispatchEvent(loadEv);
      checkDirty();
      if (needsRerender) doRerender();
      return;
    }
    var s = scripts[idx];
    if (s.type && !s.type.match(/javascript|ecmascript|module|text$/i)) {
      runScripts(idx + 1); return; // skip non-JS scripts
    }
    if (s.inline) {
      execScript(s.code);
      runScripts(idx + 1);
    } else {
      loadExternalScript(s.src, () => runScripts(idx + 1));
    }
  }

  // ── Wire handlers then kick off script execution ──────────────────────────

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
        var ev = new VEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(ev);
      });
    },
    fireChange(id: string, newValue: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id); if (!el) return;
        el._attrs.set('value', newValue);
        var ev = new VEvent('change', { bubbles: true }); ev._data['value'] = newValue; el.dispatchEvent(ev);
      });
    },
    fireInput(id: string, newValue: string): boolean {
      return fireAndCheck(() => {
        var el = findEl(id); if (!el) return;
        el._attrs.set('value', newValue);
        var ev = new VEvent('input', { bubbles: true }); ev._data['value'] = newValue; el.dispatchEvent(ev);
      });
    },
    fireKeydown(id: string, key: string, keyCode: number): boolean {
      return fireAndCheck(() => {
        var el = findEl(id) ?? doc.body; if (!el) return;
        var ev: any = new VEvent('keydown', { bubbles: true, cancelable: true });
        ev.key = key; ev.keyCode = keyCode; ev.which = keyCode; ev.code = 'Key' + key.toUpperCase();
        el.dispatchEvent(ev);
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
    dispose(): void {
      disposed = true;
      timers = []; rafCallbacks = [];
      // fire beforeunload
      try { var ev = new VEvent('beforeunload'); doc.dispatchEvent(ev); } catch(_) {}
    },
    tick(nowMs: number): void {
      if (disposed) return;
      // Fire RAF callbacks
      if (rafCallbacks.length) {
        var cbs = rafCallbacks.splice(0);
        for (var r of cbs) { try { r.fn(nowMs); } catch(_) {} }
        checkDirty();
      }
      // Fire elapsed timers
      var elapsed = nowMs;
      var fired = false;
      for (var i = timers.length - 1; i >= 0; i--) {
        var t = timers[i];
        if (elapsed >= t.fireAt) {
          try { t.fn(); } catch(_) {}
          if (t.interval) { t.fireAt = elapsed + t.delay; }
          else { timers.splice(i, 1); }
          fired = true;
        }
      }
      if (fired) { checkDirty(); if (needsRerender) doRerender(); }
    },
  };
}
