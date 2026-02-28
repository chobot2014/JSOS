/**
 * jQuery / Angular / WebAssembly Compatibility Shims
 * Item 878 — jQuery 3.x polyfills
 * Item 879 — Angular polyfills
 * Item 880 — WebAssembly API stub
 *
 * These shims fill the gaps between what JSOS's browser engine provides
 * and what popular frameworks expect at startup.
 * They are designed to be loaded before any framework code runs.
 */

// ── jQuery 3.x polyfills (item 878) ───────────────────────────────────────

export function installJQueryPolyfills(win: any): void {
  // jQuery queries the XMLHttpRequest constructor at import time
  if (!win.XMLHttpRequest) {
    win.XMLHttpRequest = class XMLHttpRequestStub {
      readyState = 0;
      status = 0;
      statusText = '';
      responseText = '';
      response: any = null;
      onreadystatechange: ((ev: any) => void) | null = null;
      onload: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      ontimeout: ((ev: any) => void) | null = null;

      _headers: Record<string, string> = {};
      _method = 'GET';
      _url = '';

      open(method: string, url: string): void { this._method = method; this._url = url; }
      setRequestHeader(k: string, v: string): void { this._headers[k.toLowerCase()] = v; }
      getResponseHeader(k: string): string | null { return null; }
      getAllResponseHeaders(): string { return ''; }

      send(body?: string | null): void {
        const self = this;
        const sys: any = (win as any).__sys;
        if (!sys) { self.status = 0; self.onerror?.({ type: 'error' }); return; }
        try {
          const resp = sys.net.httpRequest(self._method, self._url, self._headers, body ?? '');
          self.readyState = 4;
          self.status = resp.status;
          self.statusText = String(resp.status);
          self.responseText = resp.body;
          self.response = resp.body;
          self.onreadystatechange?.({ type: 'readystatechange' });
          self.onload?.({ type: 'load' });
        } catch (err) {
          self.readyState = 4;
          self.status = 0;
          self.onerror?.({ type: 'error', error: err });
        }
      }

      abort(): void {}
    };
  }

  // jQuery uses document.defaultView
  if (win.document && !win.document.defaultView) {
    win.document.defaultView = win;
  }

  // jQuery feature detects CSS transitions via the style object
  if (win.document && !win.document.body?.style) {
    const style = win.document.body?.style ?? {};
    const transitions = ['transition','webkitTransition','MozTransition','OTransition'];
    for (const t of transitions) if (!(t in style)) (style as any)[t] = '';
  }

  // jQuery .offset() uses getBoundingClientRect
  if (win.document && !win.document.documentElement?.getBoundingClientRect) {
    if (win.document.documentElement) {
      win.document.documentElement.getBoundingClientRect = () =>
        ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
    }
  }

  // jQuery checks window.JSON
  if (!win.JSON) win.JSON = JSON;

  // jQuery checks window.performance
  if (!win.performance) {
    win.performance = { now: () => Date.now(), mark() {}, measure() {}, getEntriesByName: () => [] };
  }
}

// ── Angular polyfills (item 879) ───────────────────────────────────────────

export function installAngularPolyfills(win: any): void {
  // Angular requires Zone.js's __Zone_disable_XHR — let it exist
  win.__Zone_disable_XHR = (win.__Zone_disable_XHR as boolean | undefined) ?? false;

  // Angular uses CustomEvent
  if (!win.CustomEvent) {
    win.CustomEvent = class CustomEvent extends (win.Event ?? class Event {
      type: string; bubbles: boolean; cancelable: boolean;
      constructor(type: string, init: any = {}) {
        this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
      }
      }) {
      detail: any;
      constructor(type: string, init: any = {}) { super(type, init); this.detail = init.detail ?? null; }
    };
  }

  // Angular uses MutationObserver
  if (!win.MutationObserver) {
    win.MutationObserver = class MutationObserverStub {
      constructor(private _cb: (records: any[], observer: any) => void) {}
      observe(_target: any, _opts: any) {}
      disconnect() {}
      takeRecords(): any[] { return []; }
    };
  }

  // Angular uses Symbol.iterator
  if (typeof Symbol === 'undefined') {
    (win as any).Symbol = { iterator: '@@iterator', hasInstance: '@@hasInstance' };
  }

  // Angular Universal / SSR needs process-like object
  if (!win.process) {
    win.process = { env: {}, platform: 'browser', browser: true, nextTick: (fn: () => void) => win.setTimeout(fn, 0) };
  }

  // Angular uses ngDevMode
  if (!('ngDevMode' in win)) (win as any).ngDevMode = false;

  // Angular uses requestAnimationFrame via platform-browser
  if (!win.requestAnimationFrame) {
    let id = 0;
    win.requestAnimationFrame = (cb: (ts: number) => void) => win.setTimeout(() => cb(Date.now()), 16);
    win.cancelAnimationFrame  = (h: number) => win.clearTimeout(h);
  }
}

// ── WebAssembly stub (item 880) ────────────────────────────────────────────

export function installWebAssemblyPolyfill(win: any): void {
  if (win.WebAssembly) return; // already present

  // Stub the WebAssembly global so feature-detection code doesn't throw
  const WebAssembly: any = {
    // Validation
    validate(bytes: BufferSource): boolean {
      // Check for WASM magic number: \0asm
      const ba = new Uint8Array(bytes instanceof ArrayBuffer ? bytes : (bytes as any).buffer);
      return ba[0] === 0x00 && ba[1] === 0x61 && ba[2] === 0x73 && ba[3] === 0x6d;
    },

    // Compilation (async)
    async compile(bytes: BufferSource): Promise<WebAssemblyModule> {
      if (!WebAssembly.validate(bytes)) throw new TypeError('Invalid WASM module');
      return new WebAssemblyModule(bytes);
    },

    async compileStreaming(source: Promise<any>): Promise<WebAssemblyModule> {
      const resp = await source;
      const buf  = await resp.arrayBuffer();
      return WebAssembly.compile(buf);
    },

    // Instantiation
    async instantiate(bytes: BufferSource | WebAssemblyModule, imports?: object): Promise<any> {
      const mod = bytes instanceof WebAssemblyModule ? bytes : await WebAssembly.compile(bytes as BufferSource);
      const inst = new WebAssemblyInstance(mod, imports);
      return { module: mod, instance: inst };
    },

    async instantiateStreaming(source: Promise<any>, imports?: object): Promise<any> {
      const resp = await source;
      const buf  = await resp.arrayBuffer();
      return WebAssembly.instantiate(buf, imports);
    },

    Module: null as any,
    Instance: null as any,
    Memory: null as any,
    Table: null as any,
    Global: null as any,
    CompileError: class extends Error { name = 'CompileError'; },
    LinkError:    class extends Error { name = 'LinkError'; },
    RuntimeError: class extends Error { name = 'RuntimeError'; },
  };

  // Module class
  class WebAssemblyModule {
    _bytes: BufferSource;
    constructor(bytes: BufferSource) { this._bytes = bytes; }
    static exports(_mod: WebAssemblyModule): WebAssemblyExportDescriptor[] { return []; }
    static imports(_mod: WebAssemblyModule): WebAssemblyImportDescriptor[] { return []; }
    static customSections(_mod: WebAssemblyModule, _name: string): ArrayBuffer[] { return []; }
  }

  // Instance class — placeholder with no-op exports
  class WebAssemblyInstance {
    exports: Record<string, any> = {};
    constructor(_mod: WebAssemblyModule, _imports?: object) {}
  }

  // Memory class
  class WebAssemblyMemory {
    buffer: ArrayBuffer;
    constructor(init: { initial: number; maximum?: number }) {
      this.buffer = new ArrayBuffer(init.initial * 65536);
    }
    grow(delta: number): number {
      const prev = this.buffer.byteLength / 65536;
      const newBuf = new ArrayBuffer((prev + delta) * 65536);
      new Uint8Array(newBuf).set(new Uint8Array(this.buffer));
      this.buffer = newBuf;
      return prev;
    }
  }

  // Table class
  class WebAssemblyTable {
    length: number;
    _data: any[];
    constructor(init: { initial: number; element: string; maximum?: number }) {
      this.length = init.initial;
      this._data = new Array(init.initial).fill(null);
    }
    get(index: number): any { return this._data[index]; }
    set(index: number, value: any): void { this._data[index] = value; }
    grow(delta: number): number {
      const prev = this.length;
      this._data.push(...new Array(delta).fill(null));
      this.length += delta;
      return prev;
    }
  }

  // Global class
  class WebAssemblyGlobal {
    value: any;
    constructor(_desc: { value: string; mutable?: boolean }, v?: any) { this.value = v; }
    valueOf(): any { return this.value; }
  }

  WebAssembly.Module   = WebAssemblyModule;
  WebAssembly.Instance = WebAssemblyInstance;
  WebAssembly.Memory   = WebAssemblyMemory;
  WebAssembly.Table    = WebAssemblyTable;
  WebAssembly.Global   = WebAssemblyGlobal;

  win.WebAssembly = WebAssembly;
}

type WebAssemblyExportDescriptor = { name: string; kind: string };
type WebAssemblyImportDescriptor = { name: string; module: string; kind: string };

// ── Master installer ───────────────────────────────────────────────────────

export function installFrameworkPolyfills(win: any): void {
  installJQueryPolyfills(win);
  installAngularPolyfills(win);
  installWebAssemblyPolyfill(win);
}
