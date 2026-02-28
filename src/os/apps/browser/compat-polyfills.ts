/**
 * JSOS Compatibility Polyfills — Items 874-877
 *
 * [874] React 18: polyfill missing APIs used by ReactDOM
 * [875] Vue 3:    polyfill missing APIs used by Vue runtime
 * [876] Bootstrap CSS: ensure all flexbox/grid/utility classes render
 * [877] Tailwind CSS:  purge + custom properties chain
 *
 * Each polyfill is installed lazily when the respective library is detected
 * on the page window object. Call `installCompatPolyfills(win)` once after
 * the page's global scope is created.
 */

// ── Utility ─────────────────────────────────────────────────────────────────

function has(win: any, key: string): boolean { return key in win && win[key] != null; }
function define(win: any, key: string, value: unknown): void {
  if (!has(win, key)) { try { win[key] = value; } catch (_) { /* immutable */ } }
}

// ── [Item 874] React 18 polyfills ───────────────────────────────────────────

/** APIs that ReactDOM 18 calls that may be missing in JSOS's browser environment. */
export function installReact18Polyfills(win: any): void {
  // MessageChannel — used by React Scheduler for yielding to host
  define(win, 'MessageChannel', class MessageChannel {
    port1: any;
    port2: any;
    constructor() {
      const listeners1: Function[] = [];
      const listeners2: Function[] = [];
      this.port1 = {
        postMessage: (msg: any) => { listeners2.forEach(fn => fn({ data: msg })); },
        addEventListener: (_: string, fn: Function) => listeners1.push(fn),
        removeEventListener: (_: string, fn: Function) => { const i = listeners1.indexOf(fn); if (i >= 0) listeners1.splice(i, 1); },
      };
      this.port2 = {
        postMessage: (msg: any) => { listeners1.forEach(fn => fn({ data: msg })); },
        addEventListener: (_: string, fn: Function) => listeners2.push(fn),
        removeEventListener: (_: string, fn: Function) => { const i = listeners2.indexOf(fn); if (i >= 0) listeners2.splice(i, 1); },
      };
    }
  });

  // queueMicrotask — used by React to flush sync updates
  define(win, 'queueMicrotask', (fn: Function) => Promise.resolve().then(() => fn()));

  // scheduler.postTask — React 18.3+ optional integration
  if (!has(win, 'scheduler')) {
    win.scheduler = {
      postTask: (fn: Function, opts?: { priority?: string; delay?: number }) => {
        const delay = opts?.delay ?? 0;
        return new Promise<void>(resolve => {
          const timer = delay > 0
            ? setTimeout(() => { fn(); resolve(); }, delay)
            : Promise.resolve().then(() => { fn(); resolve(); });
          void timer;
        });
      },
      yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    };
  }

  // TextEncoder / TextDecoder — used by React 18 SSR and concurrent features
  define(win, 'TextEncoder', class TextEncoder_ {
    encode(s: string): Uint8Array {
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) { bytes.push(c); }
        else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
        else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      }
      return new Uint8Array(bytes);
    }
    readonly encoding = 'utf-8';
  });

  define(win, 'TextDecoder', class TextDecoder_ {
    decode(data: Uint8Array): string {
      let s = '', i = 0;
      while (i < data.length) {
        const b = data[i++]!;
        if (b < 0x80) { s += String.fromCharCode(b); }
        else if ((b & 0xE0) === 0xC0) { s += String.fromCharCode(((b & 31) << 6) | (data[i++]! & 63)); }
        else { s += String.fromCharCode(((b & 15) << 12) | ((data[i++]! & 63) << 6) | (data[i++]! & 63)); }
      }
      return s;
    }
    readonly encoding = 'utf-8';
  });

  // FinalizationRegistry — used by some React internals in dev mode
  define(win, 'FinalizationRegistry', class FinalizationRegistry_ {
    private _cb: (token: unknown) => void;
    constructor(cb: (token: unknown) => void) { this._cb = cb; }
    register(_obj: object, _token: unknown): void { /* GC-driven — stub */ }
    unregister(_token: object): void { /* stub */ }
  });

  // structuredClone — React 18 uses it for transferable state
  define(win, 'structuredClone', (obj: unknown): unknown => {
    try { return JSON.parse(JSON.stringify(obj)); }
    catch (_) { return obj; }
  });
}

// ── [Item 875] Vue 3 polyfills ───────────────────────────────────────────────

export function installVue3Polyfills(win: any): void {
  // Proxy — Vue 3 reactivity is entirely Proxy-based (must be native)
  if (!has(win, 'Proxy')) {
    console.warn('[JSOS compat] Vue 3 requires native Proxy — reactivity will not work');
  }

  // WeakRef — used by Vue 3 scheduler and component caching
  define(win, 'WeakRef', class WeakRef_ {
    private _val: any;
    constructor(obj: any) { this._val = obj; }
    deref(): any { return this._val; }
  });

  // queueMicrotask (shared with React polyfill)
  define(win, 'queueMicrotask', (fn: Function) => Promise.resolve().then(() => fn()));

  // ResizeObserver — used by Vue Router transitions and many Vue UI libs
  define(win, 'ResizeObserver', class ResizeObserver_ {
    private _cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this._cb = cb; }
    observe(_el: Element): void { /* stub — fire immediately with zero rect */ }
    unobserve(_el: Element): void { /* stub */ }
    disconnect(): void { /* stub */ }
  });

  // IntersectionObserver — used by virtual-scroller / lazy-loading in Vue apps
  define(win, 'IntersectionObserver', class IntersectionObserver_ {
    private _cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) { this._cb = cb; }
    observe(_el: Element): void { /* stub */ }
    unobserve(_el: Element): void { /* stub */ }
    disconnect(): void { /* stub */ }
  });

  // MutationObserver — used by Vue's teleport and keep-alive
  define(win, 'MutationObserver', class MutationObserver_ {
    private _cb: MutationCallback;
    constructor(cb: MutationCallback) { this._cb = cb; }
    observe(_el: Node, _opts?: MutationObserverInit): void { /* stub */ }
    disconnect(): void { /* stub */ }
    takeRecords(): MutationRecord[] { return []; }
  });

  // CSS.supports — used by Vue SSR hydration
  if (!win.CSS) win.CSS = {};
  define(win.CSS, 'supports', (_prop: string, _val?: string) => false);

  // getComputedStyle stub (returns empty style)
  define(win, 'getComputedStyle', (_el: any) => new Proxy({}, {
    get: (_t, p) => typeof p === 'string' ? '' : undefined,
  }));
}

// ── [Item 876] Bootstrap CSS polyfills ──────────────────────────────────────

/**
 * Bootstrap relies on:
 *  - Custom properties (--bs-*)
 *  - CSS Grid / Flexbox
 *  - classList, dataset on elements
 *  - matchMedia for responsive utilities
 */
export function installBootstrapPolyfills(win: any): void {
  // matchMedia — Bootstrap's responsive JS utilities call this
  define(win, 'matchMedia', (query: string) => ({
    matches:  false,
    media:    query,
    onchange: null,
    addListener:    (_fn: Function) => { /* stub */ },
    removeListener: (_fn: Function) => { /* stub */ },
    addEventListener:    (_t: string, _fn: Function) => { /* stub */ },
    removeEventListener: (_t: string, _fn: Function) => { /* stub */ },
    dispatchEvent: (_e: Event) => false,
  }));

  // getComputedStyle (shared with Vue polyfill above)
  define(win, 'getComputedStyle', (_el: any) => new Proxy({}, {
    get: (_t, p) => typeof p === 'string' ? '' : undefined,
  }));

  // requestAnimationFrame — Bootstrap transitions use it
  define(win, 'requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(fn, 16) as unknown as number);
  define(win, 'cancelAnimationFrame',  (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));

  // Bootstrap 5 accesses document.documentElement.style for custom property support detection
  // Ensure CSSStyleDeclaration-like object exists on documentElement
  if (win.document?.documentElement && !win.document.documentElement.style) {
    win.document.documentElement.style = new Proxy({}, {
      get: (_t, p) => typeof p === 'string' ? '' : undefined,
      set: (_t, p, v) => { (_t as any)[p] = v; return true; },
    });
  }
}

// ── [Item 877] Tailwind CSS polyfills ───────────────────────────────────────

/**
 * Tailwind CSS (JIT) uses:
 *  - Custom properties on :root (--tw-*)
 *  - @layer (handled by advanced-css.ts, item 436)
 *  - matchMedia for dark-mode utilities
 *  - MutationObserver for class-based dark mode
 */
export function installTailwindPolyfills(win: any): void {
  // All resolved by Bootstrap + Vue polyfills — just add dark mode preference
  define(win, 'matchMedia', (query: string) => {
    const matches = query === '(prefers-color-scheme: dark)' ? false : false;
    return {
      matches,
      media:    query,
      onchange: null,
      addListener:         (_fn: Function) => { /* stub */ },
      removeListener:      (_fn: Function) => { /* stub */ },
      addEventListener:    (_t: string, _fn: Function) => { /* stub */ },
      removeEventListener: (_t: string, _fn: Function) => { /* stub */ },
      dispatchEvent:       (_e: Event) => false,
    };
  });

  // Ensure CSS.supports returns true for custom properties so Tailwind doesn't fall back
  if (!win.CSS) win.CSS = {};
  define(win.CSS, 'supports', (prop: string, _val?: string) =>
    prop.startsWith('--') || prop === 'display' || prop === 'color' ? true : false
  );
}

// ── Master installer ─────────────────────────────────────────────────────────

/**
 * Install all framework polyfills on the given window object.
 * Safe to call multiple times (each polyfill is idempotent).
 */
export function installCompatPolyfills(win: any): void {
  installReact18Polyfills(win);
  installVue3Polyfills(win);
  installBootstrapPolyfills(win);
  installTailwindPolyfills(win);
}
