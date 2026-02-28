/**
 * JSOS Browser Web Platform APIs — Items 551/552/617/618
 *
 * Implements:
 *   - Item 551: Web Components lifecycle (customElements, shadow DOM)
 *   - Item 552: Worklet API (CSS.paintWorklet, AudioWorklet, LayoutWorklet)
 *   - Item 617: IME (Input Method Editor) for CJK input
 *   - Item 618: Form autofill manager
 */

import { CSS as CSSHoudini } from './advanced-css';

// ── Item 551: Web Components ──────────────────────────────────────────────────

export interface CustomElementDefinition {
  name: string;
  constructor: CustomElementConstructor;
  observedAttributes?: string[];
  extends?: string;  // 'built-in extends'
}

export interface CustomElementConstructor {
  new(): HTMLCustomElement;
  observedAttributes?: string[];
}

export abstract class HTMLCustomElement {
  // Element data
  tagName: string = '';
  attributes = new Map<string, string>();
  children: HTMLCustomElement[] = [];
  shadowRoot: ShadowRoot | null = null;
  _connected = false;
  _initialized = false;

  // Lifecycle callbacks
  connectedCallback?(): void;
  disconnectedCallback?(): void;
  adoptedCallback?(): void;
  attributeChangedCallback?(name: string, oldValue: string | null, newValue: string | null): void;

  // Shadow DOM
  attachShadow(init: { mode: 'open' | 'closed' }): ShadowRoot {
    this.shadowRoot = new ShadowRoot(this, init.mode);
    return this.shadowRoot;
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void {
    const old = this.attributes.get(name) ?? null;
    this.attributes.set(name, value);
    const def = customElements._getDefinition(this.tagName);
    if (def?.observedAttributes?.includes(name)) {
      this.attributeChangedCallback?.(name, old, value);
    }
  }
  removeAttribute(name: string): void {
    const old = this.attributes.get(name) ?? null;
    this.attributes.delete(name);
    const def = customElements._getDefinition(this.tagName);
    if (def?.observedAttributes?.includes(name)) {
      this.attributeChangedCallback?.(name, old, null);
    }
  }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }

  // Simulate DOM attachment
  _connect(): void {
    if (!this._connected) {
      this._connected = true;
      this.connectedCallback?.();
    }
  }

  _disconnect(): void {
    if (this._connected) {
      this._connected = false;
      this.disconnectedCallback?.();
    }
  }
}

export class ShadowRoot {
  host: HTMLCustomElement;
  mode: 'open' | 'closed';
  innerHTML = '';
  children: HTMLCustomElement[] = [];

  constructor(host: HTMLCustomElement, mode: 'open' | 'closed') {
    this.host = host;
    this.mode = mode;
  }
}

/** Custom Elements Registry */
class CustomElementRegistry {
  private _definitions = new Map<string, CustomElementDefinition>();
  private _whenDefined = new Map<string, Array<() => void>>();

  /** Register a custom element */
  define(name: string, constructor: CustomElementConstructor, options?: { extends?: string }): void {
    if (!name.includes('-')) {
      throw new Error(`Custom element name must contain a hyphen: "${name}"`);
    }
    if (this._definitions.has(name)) {
      throw new Error(`Custom element already defined: "${name}"`);
    }
    const def: CustomElementDefinition = {
      name,
      constructor,
      observedAttributes: constructor.observedAttributes ?? [],
      extends: options?.extends,
    };
    this._definitions.set(name, def);

    // Resolve whenDefined promises
    this._whenDefined.get(name)?.forEach(cb => cb());
    this._whenDefined.delete(name);
  }

  /** Get the constructor for a custom element */
  get(name: string): CustomElementConstructor | undefined {
    return this._definitions.get(name)?.constructor;
  }

  /** Returns a Promise that resolves when the element is defined */
  whenDefined(name: string): Promise<CustomElementConstructor> {
    if (this._definitions.has(name)) {
      return Promise.resolve(this._definitions.get(name)!.constructor);
    }
    return new Promise<CustomElementConstructor>(resolve => {
      if (!this._whenDefined.has(name)) this._whenDefined.set(name, []);
      this._whenDefined.get(name)!.push(() => resolve(this._definitions.get(name)!.constructor));
    });
  }

  /** Upgrade a DOM tree (instantiate any defined custom elements found) */
  upgrade(element: HTMLCustomElement): void {
    const def = this._definitions.get(element.tagName.toLowerCase());
    if (def) {
      const instance = new def.constructor();
      Object.assign(element, instance);
      if (!element._initialized) {
        element._initialized = true;
        element._connect();
      }
    }
    for (const child of element.children) this.upgrade(child);
  }

  /** Create a new custom element from a tag name */
  createElement(tagName: string): HTMLCustomElement | null {
    const def = this._definitions.get(tagName.toLowerCase());
    if (!def) return null;
    const el = new def.constructor();
    el.tagName = tagName.toUpperCase();
    return el;
  }

  /** @internal */
  _getDefinition(tagName: string): CustomElementDefinition | undefined {
    return this._definitions.get(tagName.toLowerCase());
  }

  /** List all defined element names */
  get definedElements(): string[] {
    return [...this._definitions.keys()];
  }
}

/** Global custom elements registry (matches browser API) */
export const customElements = new CustomElementRegistry();

// ── Item 552: Worklet API ─────────────────────────────────────────────────────

export interface WorkletGlobalScope {
  registerPaint?: (name: string, cls: unknown) => void;
  registerLayout?: (name: string, cls: unknown) => void;
  registerProcessor?: (name: string, cls: unknown) => void;
}

export interface WorkletModule {
  url: string;
  scope: WorkletGlobalScope;
}

abstract class BaseWorklet {
  protected _modules: WorkletModule[] = [];

  addModule(url: string): Promise<void> {
    // In JSOS: fetch via VFS and eval in worklet scope
    return new Promise<void>((resolve, reject) => {
      try {
        const scope = this._createScope();
        // Attempt to load via the kernel filesystem
        const fs = (globalThis as Record<string, unknown>).__jsosFS as { readFile?: (path: string) => Uint8Array } | undefined;
        if (fs?.readFile) {
          const raw = fs.readFile(url);
          const src = new TextDecoder().decode(raw);
          const fn = new Function('self', 'globalThis', src);
          fn(scope, scope);
        }
        this._modules.push({ url, scope });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  protected abstract _createScope(): WorkletGlobalScope;
}

/** CSS.paintWorklet — registers paint worklets */
class PaintWorklet extends BaseWorklet {
  private _painters = new Map<string, unknown>();

  protected _createScope(): WorkletGlobalScope {
    return {
      registerPaint: (name: string, cls: unknown) => {
        this._painters.set(name, cls);
        // Also register in Houdini CSS singleton
        CSSHoudini.paintWorklet.register({
          name,
          paint(ctx, geom, props) {
            try {
              const PainterCls = cls as new() => { paint(ctx: unknown, geom: unknown, props: unknown): void };
              new PainterCls().paint(ctx, geom, props);
            } catch (_) { /* ignore */ }
          },
        });
      },
    };
  }

  hasPainter(name: string): boolean { return this._painters.has(name); }
}

/** AudioWorklet — runs audio processing in real-time (stub) */
class AudioWorklet extends BaseWorklet {
  private _processors = new Map<string, unknown>();

  protected _createScope(): WorkletGlobalScope {
    return {
      registerProcessor: (name: string, cls: unknown) => {
        this._processors.set(name, cls);
      },
    };
  }

  createNode(name: string, options?: { numberOfInputs?: number; numberOfOutputs?: number }): AudioWorkletNode {
    return new AudioWorkletNode(name, options ?? {});
  }
}

export class AudioWorkletNode {
  name: string;
  numberOfInputs: number;
  numberOfOutputs: number;
  port: MessagePort;

  constructor(name: string, options: { numberOfInputs?: number; numberOfOutputs?: number }) {
    this.name = name;
    this.numberOfInputs  = options.numberOfInputs  ?? 1;
    this.numberOfOutputs = options.numberOfOutputs ?? 1;
    this.port = new MessagePort();
  }

  process(_inputs: Float32Array[][], _outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    return false;  // Return true to keep alive
  }
}

/** LayoutWorklet — CSS Houdini custom layout (stub) */
class LayoutWorklet extends BaseWorklet {
  private _layouts = new Map<string, unknown>();

  protected _createScope(): WorkletGlobalScope {
    return {
      registerLayout: (name: string, cls: unknown) => {
        this._layouts.set(name, cls);
      },
    };
  }
}

class MessagePort {
  private _listeners = new Map<string, Array<(e: { data: unknown }) => void>>();

  postMessage(data: unknown): void {
    this._listeners.get('message')?.forEach(cb => cb({ data }));
  }

  addEventListener(type: string, cb: (e: { data: unknown }) => void): void {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(cb);
  }

  removeEventListener(type: string, cb: (e: { data: unknown }) => void): void {
    const l = this._listeners.get(type);
    if (l) this._listeners.set(type, l.filter(f => f !== cb));
  }
}

// Attach worklets to CSS object
export const paintWorklet   = new PaintWorklet();
export const audioWorklet   = new AudioWorklet();
export const layoutWorklet  = new LayoutWorklet();

// ── Item 617: IME (Input Method Editor) for CJK ───────────────────────────────

export type IMEState = 'inactive' | 'composing' | 'committed';

export interface IMECompositionEvent {
  type: 'compositionstart' | 'compositionupdate' | 'compositionend';
  data: string;
}

export interface IMECandidate {
  text: string;
  annotation?: string;  // pronunciation annotation
  score: number;
}

/** IME input session for CJK (Chinese, Japanese, Korean) input */
export class IMEInputHandler {
  private _state: IMEState = 'inactive';
  private _buffer = '';
  private _candidates: IMECandidate[] = [];
  private _listeners: Array<(e: IMECompositionEvent) => void> = [];
  private _candidateListeners: Array<(candidates: IMECandidate[]) => void> = [];
  private _locale: string;

  constructor(locale = 'zh-CN') {
    this._locale = locale;
  }

  get state(): IMEState { return this._state; }
  get compositionString(): string { return this._buffer; }
  get candidates(): IMECandidate[] { return this._candidates; }
  get locale(): string { return this._locale; }

  /** Handle a raw key press during composition */
  handleKeyInput(char: string): boolean {
    if (this._state === 'inactive') {
      // Start composition on certain triggers based on locale
      if (this._shouldStartComposition(char)) {
        this._state = 'composing';
        this._buffer = char;
        this._emit({ type: 'compositionstart', data: '' });
        this._updateCandidates();
        this._emit({ type: 'compositionupdate', data: this._buffer });
        return true;  // consumed
      }
      return false;  // pass through
    }

    if (this._state === 'composing') {
      if (char === 'Escape') {
        this._cancel();
        return true;
      }
      if (char === 'Enter') {
        this._commit(this._buffer);
        return true;
      }
      if (char === 'Backspace') {
        if (this._buffer.length > 0) {
          this._buffer = this._buffer.slice(0, -1);
          if (this._buffer.length === 0) { this._cancel(); } else { this._updateCandidates(); this._emit({ type: 'compositionupdate', data: this._buffer }); }
        }
        return true;
      }
      if (char.length === 1 && char >= '1' && char <= '9') {
        // Select nth candidate
        const idx = parseInt(char) - 1;
        if (idx < this._candidates.length) {
          this._commit(this._candidates[idx].text);
          return true;
        }
      }
      if (char.length === 1) {
        this._buffer += char;
        this._updateCandidates();
        this._emit({ type: 'compositionupdate', data: this._buffer });
        return true;
      }
    }
    return false;
  }

  /** Select a candidate explicitly */
  selectCandidate(index: number): string | null {
    if (index < 0 || index >= this._candidates.length) return null;
    const text = this._candidates[index].text;
    this._commit(text);
    return text;
  }

  /** Add event listener */
  onComposition(cb: (e: IMECompositionEvent) => void): void { this._listeners.push(cb); }
  onCandidates(cb: (cands: IMECandidate[]) => void): void { this._candidateListeners.push(cb); }

  private _emit(e: IMECompositionEvent): void { this._listeners.forEach(l => l(e)); }

  private _shouldStartComposition(char: string): boolean {
    switch (this._locale) {
      case 'zh-CN': case 'zh-TW': return /^[a-z]$/i.test(char);  // Pinyin
      case 'ja': return /^[a-z]$/i.test(char);   // Romaji
      case 'ko': return /^[a-z]$/i.test(char);   // Romanized
      default:   return false;
    }
  }

  private _updateCandidates(): void {
    this._candidates = this._queryCandidates(this._buffer, this._locale);
    this._candidateListeners.forEach(l => l(this._candidates));
  }

  private _queryCandidates(input: string, locale: string): IMECandidate[] {
    // Stub: provide a minimal set of candidates for demonstration
    const TABLE: Record<string, IMECandidate[]> = {
      // Simplified Chinese pinyin stubs
      'n':    [{ text: '你', annotation: 'nǐ', score: 100 }, { text: '那', annotation: 'nà', score: 80 }],
      'ni':   [{ text: '你', annotation: 'nǐ', score: 100 }, { text: '你好', annotation: 'nǐhǎo', score: 90 }],
      'h':    [{ text: '好', annotation: 'hǎo', score: 100 }, { text: '和', annotation: 'hé', score: 80 }],
      'w':    [{ text: '我', annotation: 'wǒ', score: 100 }, { text: '为', annotation: 'wèi', score: 80 }],
      'wo':   [{ text: '我', annotation: 'wǒ', score: 100 }],
      'a':    [{ text: 'あ', annotation: 'a', score: 100 }, { text: '亜', annotation: 'a', score: 80 }],
      'ka':   [{ text: 'か', annotation: 'ka', score: 100 }, { text: 'カ', annotation: 'ka', score: 90 }],
    };
    void locale;
    const exact = TABLE[input.toLowerCase()];
    if (exact) return exact;
    // Prefix match
    return Object.entries(TABLE).filter(([k]) => k.startsWith(input.toLowerCase())).flatMap(([,v]) => v).slice(0, 5);
  }

  private _commit(text: string): void {
    this._state = 'committed';
    this._emit({ type: 'compositionend', data: text });
    this._buffer = '';
    this._candidates = [];
    this._state = 'inactive';
  }

  private _cancel(): void {
    this._emit({ type: 'compositionend', data: '' });
    this._state = 'inactive';
    this._buffer = '';
    this._candidates = [];
  }
}

/** IME manager singleton */
export const imeManager = {
  _handlers: new Map<string, IMEInputHandler>(),

  getHandler(elementId: string, locale = 'zh-CN'): IMEInputHandler {
    if (!this._handlers.has(elementId)) {
      this._handlers.set(elementId, new IMEInputHandler(locale));
    }
    return this._handlers.get(elementId)!;
  },

  destroyHandler(elementId: string): void {
    this._handlers.delete(elementId);
  },
};

// ── Item 618: Form autofill manager ──────────────────────────────────────────

export interface AutofillEntry {
  name: string;          // e.g. 'John Doe'
  email: string;
  phone?: string;
  address?: AutofillAddress;
  credentials?: AutofillCredential[];
}

export interface AutofillAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface AutofillCredential {
  domain: string;
  username: string;
  password: string;  // Stored as hash or encrypted in real impl
  lastUsed: number;  // timestamp
}

export type AutofillFieldType =
  | 'name' | 'email' | 'tel' | 'username' | 'current-password' | 'new-password'
  | 'street-address' | 'address-line1' | 'city' | 'postal-code' | 'country'
  | 'cc-name' | 'cc-number' | 'cc-exp' | 'cc-csc' | 'unknown';

function detectFieldType(input: {
  type?: string; name?: string; autocomplete?: string; placeholder?: string;
}): AutofillFieldType {
  const ac = input.autocomplete ?? '';
  if (ac) return ac.split(' ').pop() as AutofillFieldType;
  const name = (input.name ?? '').toLowerCase();
  const type = (input.type ?? 'text').toLowerCase();
  const ph   = (input.placeholder ?? '').toLowerCase();

  if (type === 'email' || name.includes('email') || ph.includes('email')) return 'email';
  if (type === 'tel'   || name.includes('phone') || ph.includes('phone')) return 'tel';
  if (type === 'password') return name.includes('new') ? 'new-password' : 'current-password';
  if (name.includes('user') || name.includes('login')) return 'username';
  if (name.includes('name') && !name.includes('user')) return 'name';
  if (name.includes('street') || name.includes('address')) return 'street-address';
  if (name.includes('city')) return 'city';
  if (name.includes('zip') || name.includes('postal')) return 'postal-code';
  if (name.includes('country')) return 'country';
  return 'unknown';
}

export class AutofillManager {
  private _profile: AutofillEntry | null = null;
  private _credentials: AutofillCredential[] = [];
  private _storage: Map<string, string>;

  constructor() {
    this._storage = new Map<string, string>();
    this._load();
  }

  /** Set the saved user profile */
  setProfile(profile: AutofillEntry): void {
    this._profile = profile;
    this._save();
  }

  getProfile(): AutofillEntry | null { return this._profile; }

  /** Save a credential for a domain */
  saveCredential(domain: string, username: string, password: string): void {
    const existing = this._credentials.find(c => c.domain === domain && c.username === username);
    if (existing) {
      existing.password = password;
      existing.lastUsed = Date.now();
    } else {
      this._credentials.push({ domain, username, password, lastUsed: Date.now() });
    }
    this._save();
  }

  /** Get credentials for a domain */
  getCredentials(domain: string): AutofillCredential[] {
    return this._credentials.filter(c => c.domain === domain).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** Suggest fill values for multiple form fields */
  suggestFills(fields: Array<{
    id: string; type?: string; name?: string; autocomplete?: string; placeholder?: string;
  }>, domain?: string): Map<string, string> {
    const result = new Map<string, string>();
    const creds = domain ? this.getCredentials(domain) : [];

    for (const field of fields) {
      const fieldType = detectFieldType(field);
      const profile = this._profile;

      switch (fieldType) {
        case 'name':        if (profile?.name)              result.set(field.id, profile.name); break;
        case 'email':       if (profile?.email)             result.set(field.id, profile.email); break;
        case 'tel':         if (profile?.phone)             result.set(field.id, profile.phone); break;
        case 'street-address':
        case 'address-line1': if (profile?.address?.street) result.set(field.id, profile.address.street); break;
        case 'city':        if (profile?.address?.city)     result.set(field.id, profile.address.city); break;
        case 'postal-code': if (profile?.address?.zip)      result.set(field.id, profile.address.zip); break;
        case 'country':     if (profile?.address?.country)  result.set(field.id, profile.address.country); break;
        case 'username':    if (creds[0]?.username)         result.set(field.id, creds[0].username); break;
        case 'current-password': if (creds[0]?.password)   result.set(field.id, creds[0].password); break;
        default: break;
      }
    }
    return result;
  }

  /** Generate a strong password */
  generatePassword(length = 16): string {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';
    let pw = '';
    const rng = new Uint8Array(length);
    for (let i = 0; i < length; i++) rng[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < length; i++) pw += charset[rng[i] % charset.length];
    return pw;
  }

  private _save(): void {
    try {
      this._storage.set('autofill:profile', JSON.stringify(this._profile));
      this._storage.set('autofill:credentials', JSON.stringify(this._credentials));
      // Persist to VFS if available
      const fs = (globalThis as Record<string, unknown>).__jsosFS as { writeFile?: (p: string, d: Uint8Array) => void } | undefined;
      if (fs?.writeFile) {
        const data = JSON.stringify({ profile: this._profile, credentials: this._credentials });
        fs.writeFile('/etc/browser/autofill.json', new TextEncoder().encode(data));
      }
    } catch (_) { /* ignore */ }
  }

  private _load(): void {
    try {
      const fs = (globalThis as Record<string, unknown>).__jsosFS as { readFile?: (p: string) => Uint8Array } | undefined;
      if (fs?.readFile) {
        const raw = fs.readFile('/etc/browser/autofill.json');
        const data = JSON.parse(new TextDecoder().decode(raw));
        this._profile = data.profile;
        this._credentials = data.credentials ?? [];
      }
    } catch (_) { /* ignore — no saved data */ }
  }
}

export const autofillManager = new AutofillManager();

// ── Exports ───────────────────────────────────────────────────────────────────

export const webPlatform = {
  customElements,
  paintWorklet,
  audioWorklet,
  layoutWorklet,
  imeManager,
  autofillManager,
};
