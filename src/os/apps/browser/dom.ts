/**
 * dom.ts — Minimal virtual DOM for JSOS browser JavaScript support
 *
 * Provides:
 *   buildDOM(html) → VDocument  (parse HTML string into VNode tree)
 *   serializeDOM(doc) → string  (serialize body back to HTML for re-parse)
 *   Full DOM API surface: VElement, VDocument, VEvent, CSS style proxy, classList
 *   CSS selector engine: #id .class tag [attr] compound descendant child comma
 */

import { bumpStyleGeneration } from './cache.js';

// ── HTML Sanitizer (item 370) ─────────────────────────────────────────────────
/**
 * Strip dangerous content from an HTML string before injecting via innerHTML.
 * Removes: <script>, <style> elements; on* event-handler attributes;
 *          javascript: href/src/action/xlink:href values.
 *
 * This is a defence-in-depth measure — JSOS already controls the JS sandbox,
 * but third-party content placed via innerHTML should not be able to inject
 * additional script execution or exfiltrate data.
 *
 * Item 370.
 */
export function sanitizeHTML(html: string): string {
  // 1. Remove entire <script>…</script> and <style>…</style> blocks (case-insensitive, greedy)
  var s = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '');

  // 2. Strip on* event-handler attributes from all tags
  //    Matches: onclick="...", onhover='...', onerror (unquoted), etc.
  s = s.replace(/(<[^>]+?)\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi,
                function(_m: string, p1: string) { return p1; });

  // 3. Neutralise javascript: URIs in href, src, action, xlink:href
  s = s.replace(/((?:href|src|action|xlink:href)\s*=\s*)(['"])\s*javascript:[^'"]*\2/gi,
                function(_m: string, attr: string, q: string) { return attr + q + 'about:blank' + q; });

  return s;
}

// ── Events ────────────────────────────────────────────────────────────────────

export class VEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  target: VNode | null = null;
  currentTarget: VNode | null = null;
  _stopProp = false;        // stops bubbling to parent nodes
  _stopImmediate = false;   // also stops other handlers on same node
  _data: Record<string, unknown> = {};   // extra data for input/change etc.
  timeStamp: number = Date.now();
  isTrusted: boolean = false;
  eventPhase: number = 0;  // 0=none, 1=capture, 2=at-target, 3=bubble

  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type      = type;
    this.bubbles   = init?.bubbles    ?? true;
    this.cancelable= init?.cancelable ?? true;
  }
  preventDefault():            void { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation():           void { this._stopProp = true; }
  stopImmediatePropagation(): void { this._stopProp = true; this._stopImmediate = true; }
  /** Legacy initEvent() for compatibility with document.createEvent() */
  initEvent(type: string, bubbles = false, cancelable = false): void {
    this.type = type; this.bubbles = bubbles; this.cancelable = cancelable;
  }
  composedPath(): VNode[] { 
    var path: VNode[] = [];
    if (this.target) { var n: VNode | null = this.target as VNode; while (n) { path.push(n); n = n.parentNode; } }
    return path;
  }
}

// ── EventTarget base class (item 871) ─────────────────────────────────────────
// VNode extends this so that `el instanceof EventTarget` passes.
// Used by jsruntime.ts: `EventTarget: VEventTarget` in the window object.

export class VEventTarget {
  _handlers:        Map<string, Array<(e: VEvent) => void>> = new Map();
  _captureHandlers: Map<string, Array<(e: VEvent) => void>> = new Map();
  addEventListener(type: string, fn: ((e: VEvent) => void) | { handleEvent(e: VEvent): void } | null, options?: boolean | { capture?: boolean; once?: boolean; passive?: boolean; signal?: unknown }): void {
    if (!fn) return;
    var handler = typeof fn === 'function' ? fn : (e: VEvent) => (fn as any).handleEvent(e);
    var once    = typeof options === 'object' && options !== null ? options.once : false;
    var capture = typeof options === 'boolean' ? options : (typeof options === 'object' && options !== null ? (options.capture ?? false) : false);
    var wrapped = once ? (e: VEvent) => { this.removeEventListener(type, wrapped); handler(e); } : handler;
    (wrapped as any)._original = fn;
    var map = capture ? this._captureHandlers : this._handlers;
    var arr = map.get(type); if (!arr) { arr = []; map.set(type, arr); }
    if (!arr.some((f: any) => f === wrapped || (f as any)._original === fn)) arr.push(wrapped);
  }
  removeEventListener(type: string, fn: ((e: VEvent) => void) | { handleEvent(e: VEvent): void } | null, options?: boolean | { capture?: boolean }): void {
    if (!fn) return;
    var capture = typeof options === 'boolean' ? options : (typeof options === 'object' && options !== null ? (options?.capture ?? false) : false);
    var map = capture ? this._captureHandlers : this._handlers;
    var arr = map.get(type);
    if (arr) { var i = arr.findIndex((f: any) => f === fn || (f as any)._original === fn); if (i >= 0) arr.splice(i, 1); }
  }
  dispatchEvent(ev: VEvent): boolean {
    this._fireList(ev);
    return !ev.defaultPrevented;
  }
  _fireList(ev: VEvent): void {
    var arr = this._handlers.get(ev.type);
    if (arr) { for (var fn of [...arr]) { try { fn(ev); } catch (_) {} if (ev._stopImmediate) break; } }
  }
}

// ── VNode base ────────────────────────────────────────────────────────────────

export class VNode extends VEventTarget {
  // ── Node type constants (item 582) ─────────────────────────────────────────
  static readonly ELEMENT_NODE                = 1;
  static readonly ATTRIBUTE_NODE              = 2;
  static readonly TEXT_NODE                   = 3;
  static readonly CDATA_SECTION_NODE          = 4;
  static readonly PROCESSING_INSTRUCTION_NODE = 7;
  static readonly COMMENT_NODE                = 8;
  static readonly DOCUMENT_NODE               = 9;
  static readonly DOCUMENT_TYPE_NODE          = 10;
  static readonly DOCUMENT_FRAGMENT_NODE      = 11;

  // Instance aliases so frameworks can do `node.ELEMENT_NODE`
  readonly ELEMENT_NODE                = 1;
  readonly ATTRIBUTE_NODE              = 2;
  readonly TEXT_NODE                   = 3;
  readonly CDATA_SECTION_NODE          = 4;
  readonly PROCESSING_INSTRUCTION_NODE = 7;
  readonly COMMENT_NODE                = 8;
  readonly DOCUMENT_NODE               = 9;
  readonly DOCUMENT_TYPE_NODE          = 10;
  readonly DOCUMENT_FRAGMENT_NODE      = 11;

  nodeType = 1;
  nodeName = '';
  parentNode: VNode | null = null;
  childNodes: VNode[] = [];
  ownerDocument: VDocument | null = null;
  _handlers:        Map<string, Array<(e: VEvent) => void>> = new Map();
  _captureHandlers: Map<string, Array<(e: VEvent) => void>> = new Map();

  get firstChild():      VNode | null { return this.childNodes[0] ?? null; }
  get lastChild():       VNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling():     VNode | null { var i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : -1; return i >= 0 ? (this.parentNode!.childNodes[i + 1] ?? null) : null; }
  get previousSibling(): VNode | null { var i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : -1; return i > 0  ? (this.parentNode!.childNodes[i - 1] ?? null) : null; }

  appendChild(child: VNode): VNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [], previousSibling: this.childNodes[this.childNodes.length - 2] ?? null, nextSibling: null });
    }
    return child;
  }
  removeChild(child: VNode): VNode {
    var i = this.childNodes.indexOf(child);
    if (i >= 0) {
      var prev = this.childNodes[i - 1] ?? null; var next = this.childNodes[i + 1] ?? null;
      this.childNodes.splice(i, 1); child.parentNode = null;
      if (this.ownerDocument) {
        this.ownerDocument._dirty = true;
        this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [child], previousSibling: prev, nextSibling: next });
      }
    }
    return child;
  }
  insertBefore(newNode: VNode, ref: VNode | null): VNode {
    if (!ref) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    var i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(newNode);
    newNode.parentNode = this; newNode.ownerDocument = this.ownerDocument;
    this.childNodes.splice(i, 0, newNode);
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: [newNode], removedNodes: [], previousSibling: this.childNodes[i - 1] ?? null, nextSibling: ref });
    }
    return newNode;
  }
  replaceChild(newNode: VNode, oldNode: VNode): VNode {
    var i = this.childNodes.indexOf(oldNode);
    if (i < 0) return oldNode;
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    oldNode.parentNode = null; newNode.parentNode = this; newNode.ownerDocument = this.ownerDocument;
    this.childNodes[i] = newNode;
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: [newNode], removedNodes: [oldNode], previousSibling: this.childNodes[i - 1] ?? null, nextSibling: this.childNodes[i + 1] ?? null });
    }
    return oldNode;
  }
  cloneNode(deep = false): VNode {
    var c = new VNode(); (c as any).nodeType = this.nodeType; (c as any).nodeName = this.nodeName;
    if (deep) { for (var ch of this.childNodes) { var cc = ch.cloneNode(true); cc.parentNode = c; c.childNodes.push(cc); } }
    return c;
  }
  addEventListener(type: string, fn: ((e: VEvent) => void) | { handleEvent(e: VEvent): void } | null, options?: boolean | { capture?: boolean; once?: boolean; passive?: boolean; signal?: unknown }): void {
    if (!fn) return;
    var handler = typeof fn === 'function' ? fn : (e: VEvent) => (fn as any).handleEvent(e);
    var once    = typeof options === 'object' ? options.once : false;
    var capture = typeof options === 'boolean' ? options : (typeof options === 'object' ? (options.capture ?? false) : false);
    var wrapped = once ? (e: VEvent) => { this.removeEventListener(type, wrapped); handler(e); } : handler;
    (wrapped as any)._original = fn; // for removeEventListener matching
    var map = capture ? this._captureHandlers : this._handlers;
    var arr = map.get(type); if (!arr) { arr = []; map.set(type, arr); }
    if (!arr.some(f => f === wrapped || (f as any)._original === fn)) arr.push(wrapped);
  }
  removeEventListener(type: string, fn: ((e: VEvent) => void) | { handleEvent(e: VEvent): void } | null, options?: boolean | { capture?: boolean }): void {
    if (!fn) return;
    var capture = typeof options === 'boolean' ? options : (typeof options === 'object' ? (options?.capture ?? false) : false);
    var map = capture ? this._captureHandlers : this._handlers;
    var arr = map.get(type);
    if (arr) { var i = arr.findIndex(f => f === fn || (f as any)._original === fn); if (i >= 0) arr.splice(i, 1); }
  }
  dispatchEvent(ev: VEvent): boolean {
    ev.target = this;
    // Build path: [root, ..., grandparent, parent]
    var path: VNode[] = [];
    var p: VNode | null = this.parentNode;
    while (p) { path.unshift(p); p = p.parentNode; }
    // ── Capture phase: root → parent ─────────────────────────────────────
    ev.eventPhase = 1;
    for (var ci = 0; ci < path.length; ci++) {
      if (ev._stopProp) break;
      var capNode = path[ci];
      ev.currentTarget = capNode;
      var capArr = capNode._captureHandlers.get(ev.type);
      if (capArr) { for (var cfn of [...capArr]) { try { cfn(ev); } catch (_) {} if (ev._stopImmediate) break; } }
    }
    // ── At-target phase ──────────────────────────────────────────────────
    if (!ev._stopProp) {
      ev.eventPhase = 2;
      // Fire capture handlers registered on the target itself first
      var capAt = this._captureHandlers.get(ev.type);
      if (capAt) { for (var cf of [...capAt]) { try { cf(ev); } catch (_) {} if (ev._stopImmediate) break; } }
      if (!ev._stopImmediate) this._fireList(ev);
    }
    // ── Bubble phase: parent → root ──────────────────────────────────────
    if (ev.bubbles && !ev._stopProp) {
      ev.eventPhase = 3;
      for (var bi = path.length - 1; bi >= 0; bi--) {
        if (ev._stopProp) break;
        ev.currentTarget = path[bi];
        path[bi]._fireList(ev);
      }
    }
    ev.eventPhase = 0;
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
  _fireList(ev: VEvent): void {
    ev.currentTarget = this;
    var arr = this._handlers.get(ev.type);
    if (arr) { for (var fn of [...arr]) { try { fn(ev); } catch(_) {} if (ev._stopImmediate) break; } }
  }
  get textContent(): string {
    if (this.nodeType === 3) return (this as any).data || '';
    return this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(v: string) {
    var removedNodes = this.childNodes.slice();
    this.childNodes = [];
    if (v) { var t = new VText(v); t.parentNode = this; t.ownerDocument = this.ownerDocument; this.childNodes.push(t); }
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: this.childNodes.slice(), removedNodes, previousSibling: null, nextSibling: null });
    }
  }
  /** Removes this node from its parent. */
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
  /** Returns true if this node is in a document (has ownerDocument set). */
  get isConnected(): boolean { return this.ownerDocument !== null; }
  /** Checks if this node contains another (inclusive). */
  contains(other: VNode | null): boolean {
    if (!other) return false;
    var n: VNode | null = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  getRootNode(): VNode { var n: VNode = this; while (n.parentNode) n = n.parentNode; return n; }
  /** True if this is the exact same node instance as other. */
  isSameNode(other: VNode | null): boolean { return this === other; }
  /** True if two nodes have the same structure and attributes. */
  isEqualNode(other: VNode | null): boolean {
    if (!other) return false;
    if (this.nodeType !== other.nodeType) return false;
    if (this.nodeName !== other.nodeName) return false;
    if (this.childNodes.length !== other.childNodes.length) return false;
    for (var i = 0; i < this.childNodes.length; i++) {
      if (!this.childNodes[i].isEqualNode(other.childNodes[i])) return false;
    }
    return true;
  }
  /** compareDocumentPosition bitmask. */
  compareDocumentPosition(other: VNode): number {
    if (this === other) return 0;
    // 20 = PRECEDING | CONTAINS, 10 = FOLLOWING | CONTAINED_BY
    if (this.contains(other)) return 20;
    if (other.contains(this)) return 10;
    return 1; // DISCONNECTED
  }
  /** Merge adjacent text nodes and remove empty text nodes. */
  normalize(): void {
    var i = 0;
    while (i < this.childNodes.length) {
      var ch = this.childNodes[i];
      if (ch.nodeType === 3) {
        // merge with next text nodes
        var text = (ch as any).data || '';
        var j = i + 1;
        while (j < this.childNodes.length && this.childNodes[j].nodeType === 3) {
          text += (this.childNodes[j] as any).data || '';
          j++;
        }
        if (j > i + 1) { (ch as any).data = text; this.childNodes.splice(i + 1, j - i - 1); }
        if (!text) { this.childNodes.splice(i, 1); continue; }
      } else {
        ch.normalize();
      }
      i++;
    }
  }
}

// ── VText ─────────────────────────────────────────────────────────────────────

export class VText extends VNode {
  nodeType = 3; nodeName = '#text'; data: string;
  constructor(d: string) { super(); this.data = d; }
  cloneNode(_deep = false): VText { return new VText(this.data); }
  get nodeValue(): string { return this.data; }
  set nodeValue(v: string) { this.data = v; if (this.ownerDocument) this.ownerDocument._dirty = true; }
  get textContent(): string { return this.data; }
  set textContent(v: string) { this.data = v; if (this.ownerDocument) this.ownerDocument._dirty = true; }
  get length(): number { return this.data.length; }
  get wholeText(): string { return this.data; }
  splitText(offset: number): VText {
    var before = this.data.slice(0, offset); var after = this.data.slice(offset);
    this.data = before;
    var newNode = new VText(after); newNode.ownerDocument = this.ownerDocument; newNode.parentNode = this.parentNode;
    if (this.parentNode) {
      var idx = this.parentNode.childNodes.indexOf(this); if (idx >= 0) this.parentNode.childNodes.splice(idx + 1, 0, newNode as any);
    }
    if (this.ownerDocument) this.ownerDocument._dirty = true;
    return newNode;
  }
  substringData(offset: number, count: number): string { return this.data.slice(offset, offset + count); }
  appendData(data: string): void { this.data += data; if (this.ownerDocument) this.ownerDocument._dirty = true; }
  insertData(offset: number, data: string): void { this.data = this.data.slice(0, offset) + data + this.data.slice(offset); if (this.ownerDocument) this.ownerDocument._dirty = true; }
  deleteData(offset: number, count: number): void { this.data = this.data.slice(0, offset) + this.data.slice(offset + count); if (this.ownerDocument) this.ownerDocument._dirty = true; }
  replaceData(offset: number, count: number, data: string): void { this.data = this.data.slice(0, offset) + data + this.data.slice(offset + count); if (this.ownerDocument) this.ownerDocument._dirty = true; }
}

// ── VStyleMap + proxy ─────────────────────────────────────────────────────────

export class VStyleMap {
  _map: Map<string, string> = new Map();
  _owner: VElement;
  constructor(owner: VElement) { this._owner = owner; }
  setProperty(prop: string, val: string, _priority?: string): void {
    var p = prop.trim(), v = val.trim();
    this._map.set(p, v);
    this._owner._dirtyLayout = true; // item 891
    bumpStyleGeneration();           // item 944 — invalidate computed style cache
    //  • Setting -webkit-X / -moz-X / -ms-X also sets canonical X
    //  • Setting canonical X also sets -webkit-X so old WebKit checks don't break
    var _vendors = ['-webkit-', '-moz-', '-ms-', '-o-'];
    var _toStd: string | null = null;
    for (var _vp of _vendors) {
      if (p.startsWith(_vp)) { _toStd = p.slice(_vp.length); break; }
    }
    if (_toStd !== null) {
      if (!this._map.has(_toStd)) this._map.set(_toStd, v);
    } else if (!p.startsWith('-')) {
      var _wk = '-webkit-' + p;
      if (!this._map.has(_wk)) this._map.set(_wk, v);
    }
    if (this._owner.ownerDocument) {
      this._owner.ownerDocument._dirty = true;
      this._owner.ownerDocument._queueMutation({ type: 'attributes', target: this._owner, attributeName: 'style', attributeNamespace: null, oldValue: null });
    }
  }
  getPropertyValue(prop: string): string {
    var p = prop.trim();
    var r = this._map.get(p);
    if (r !== undefined) return r;
    // Fallback: try vendor-prefix variants
    var _vendors2 = ['-webkit-', '-moz-', '-ms-', '-o-'];
    for (var _vp2 of _vendors2) {
      if (p.startsWith(_vp2)) {
        r = this._map.get(p.slice(_vp2.length)); if (r !== undefined) return r;
      } else {
        r = this._map.get(_vp2 + p); if (r !== undefined) return r;
      }
    }
    return '';
  }
  getPropertyPriority(_prop: string): string { return ''; }  // !important not tracked
  removeProperty(prop: string): string {
    var old = this._map.get(prop.trim()) || '';
    this._map.delete(prop.trim());
    this._owner._dirtyLayout = true; // item 891
    bumpStyleGeneration();           // item 944
    if (this._owner.ownerDocument) {
      this._owner.ownerDocument._dirty = true;
      this._owner.ownerDocument._queueMutation({ type: 'attributes', target: this._owner, attributeName: 'style', attributeNamespace: null, oldValue: null });
    }
    return old;
  }
  get length(): number { return this._map.size; }
  item(index: number): string { return [...this._map.keys()][index] ?? ''; }
  [Symbol.iterator](): Iterator<string> { return this._map.keys(); }
  get cssText(): string { var p: string[] = []; this._map.forEach((v, k) => p.push(k + ':' + v)); return p.join(';'); }
  set cssText(v: string) {
    this._map.clear();
    v.split(';').forEach(p => { var ci = p.indexOf(':'); if (ci >= 0) this._map.set(p.slice(0, ci).trim(), p.slice(ci + 1).trim()); });
    this._owner._dirtyLayout = true; // item 891
    bumpStyleGeneration();           // item 944
    if (this._owner.ownerDocument) {
      this._owner.ownerDocument._dirty = true;
      this._owner.ownerDocument._queueMutation({ type: 'attributes', target: this._owner, attributeName: 'style', attributeNamespace: null, oldValue: null });
    }
  }
}

function _jsToCss(js: string): string { return js.replace(/[A-Z]/g, m => '-' + m.toLowerCase()); }

export function makeStyleProxy(sm: VStyleMap): any {
  return new Proxy(sm, {
    get(t: any, k: string) { if (typeof (t as any)[k] !== 'undefined' && (k === '_map' || k === '_owner' || k === 'setProperty' || k === 'getPropertyValue' || k === 'getPropertyPriority' || k === 'removeProperty' || k === 'cssText' || k === 'length' || k === 'item')) return (t as any)[k]; if (typeof k === 'string' && k !== '') return t.getPropertyValue(_jsToCss(k)); return undefined; },
    set(t: any, k: string, v: string) { if (k === 'cssText') { t.cssText = v; return true; } if (k !== '_map' && k !== '_owner') { t.setProperty(_jsToCss(k), v); } return true; },
  });
}

// ── VClassList ────────────────────────────────────────────────────────────────

export class VClassList {
  _owner: VElement;
  constructor(owner: VElement) { this._owner = owner; }
  _clss(): string[] { return (this._owner.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(a: string[]): void { this._owner.setAttribute('class', a.join(' ')); }
  contains(c: string): boolean { return this._clss().includes(c); }
  add(...cs: string[]):    void { var a = this._clss(); for (var c of cs) if (!a.includes(c)) a.push(c); this._set(a); }
  remove(...cs: string[]): void { this._set(this._clss().filter(x => !cs.includes(x))); }
  toggle(c: string, force?: boolean): boolean { var a = this._clss(); var i = a.indexOf(c); if (force === true || (force === undefined && i < 0)) { if (i < 0) a.push(c); this._set(a); return true; } if (i >= 0) { a.splice(i, 1); this._set(a); } return false; }
  replace(old: string, n: string): boolean { var a = this._clss(); var i = a.indexOf(old); if (i >= 0) { a[i] = n; this._set(a); return true; } return false; }
  get value(): string { return this._owner.getAttribute('class') || ''; }
  [Symbol.iterator]() { return this._clss()[Symbol.iterator](); }
  get length(): number { return this._clss().length; }
  item(n: number): string | null { return this._clss()[n] ?? null; }
  entries(): IterableIterator<[number, string]> { return (this._clss() as string[]).entries() as IterableIterator<[number, string]>; }
  values(): IterableIterator<string> { return (this._clss() as string[]).values() as IterableIterator<string>; }
  forEach(fn: (value: string, key: number, parent: VClassList) => void): void { this._clss().forEach((v, i) => fn(v, i, this)); }
  toString(): string { return this.value; }
  keys(): IterableIterator<number> { return (this._clss() as string[]).keys() as IterableIterator<number>; }
  supports(_token: string): boolean { return false; }
}

// ── VElement ──────────────────────────────────────────────────────────────────

/** Monotonically increasing element UID — used as computed style cache key (item 944). */
var _elemUidCounter = 0;

export class VElement extends VNode {
  tagName:   string;
  _attrs:    Map<string, string> = new Map();
  style:     any;        // Proxy to VStyleMap
  _style:    VStyleMap;
  classList: VClassList;
  _onHandlers: Record<string, ((e: VEvent) => void) | null> = {};
  /** Unique numeric ID — stable across the element's lifetime (item 944 cache key). */
  _cuid: number = ++_elemUidCounter;
  /** True when attributes/style changed since last layout pass (item 891). */
  _dirtyLayout: boolean = true;

  constructor(tag: string) {
    super(); this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
    this._style = new VStyleMap(this); this.style = makeStyleProxy(this._style);
    this.classList = new VClassList(this);
  }

  // Common attribute shortcuts
  get id():        string  { return this._attrs.get('id')    || ''; }  set id(v: string)        { this.setAttribute('id', v); }
  get className(): string  { return this._attrs.get('class') || ''; } set className(v: string) { this.setAttribute('class', v); }
  get href():      string  { return this._attrs.get('href')  || ''; } set href(v: string)      { this.setAttribute('href', v); }
  get src():       string  { return this._attrs.get('src')   || ''; } set src(v: string)       { this.setAttribute('src', v); }
  get value():     string  { return this._attrs.get('value') || ''; } set value(v: string)     { this.setAttribute('value', v); }
  get type():      string  { return this._attrs.get('type')  || ''; } set type(v: string)      { this.setAttribute('type', v); }
  get name():      string  { return this._attrs.get('name')  || ''; } set name(v: string)      { this.setAttribute('name', v); }
  get alt():       string  { return this._attrs.get('alt')   || ''; }
  get disabled():  boolean { return this._attrs.has('disabled'); }     set disabled(v: boolean)  { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get checked():   boolean { return this._attrs.has('checked'); }      set checked(v: boolean)   { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  _indeterminate = false;
  get indeterminate(): boolean { return this._indeterminate; }
  set indeterminate(v: boolean) { this._indeterminate = v; }
  get hidden():    boolean { var s = this._style._map.get('display'); return s === 'none' || this._attrs.has('hidden'); }
  set hidden(v: boolean)  { if (v) this._style.setProperty('display', 'none'); else this._style.removeProperty('display'); }
  get title():     string  { return this._attrs.get('title') || ''; }  set title(v: string)     { this.setAttribute('title', v); }
  get placeholder(): string { return this._attrs.get('placeholder') || ''; }

  // contentEditable / editing properties
  get contentEditable(): string { return this._attrs.get('contenteditable') ?? 'inherit'; }
  set contentEditable(v: string) { if (v === 'inherit') this.removeAttribute('contenteditable'); else this.setAttribute('contenteditable', v); }
  get isContentEditable(): boolean { var ce = this.getAttribute('contenteditable'); return ce === 'true' || ce === ''; }
  get tabIndex(): number { return parseInt(this._attrs.get('tabindex') ?? '-1', 10); }
  set tabIndex(v: number) { this.setAttribute('tabindex', String(v)); }
  get draggable(): boolean { return this._attrs.get('draggable') === 'true'; }
  set draggable(v: boolean) { this.setAttribute('draggable', String(v)); }
  get spellcheck(): boolean { return this._attrs.get('spellcheck') !== 'false'; }
  set spellcheck(v: boolean) { this.setAttribute('spellcheck', String(v)); }
  get autofocus(): boolean { return this._attrs.has('autofocus'); }
  set autofocus(v: boolean) { if (v) this.setAttribute('autofocus', ''); else this.removeAttribute('autofocus'); }
  get translate(): boolean { return this._attrs.get('translate') !== 'no'; }
  set translate(v: boolean) { this.setAttribute('translate', v ? 'yes' : 'no'); }
  get inert(): boolean { return this._attrs.has('inert'); }
  set inert(v: boolean) { if (v) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
  get enterKeyHint(): string { return this._attrs.get('enterkeyhint') ?? ''; }
  set enterKeyHint(v: string) { this.setAttribute('enterkeyhint', v); }
  get inputMode(): string { return this._attrs.get('inputmode') ?? ''; }
  set inputMode(v: string) { this.setAttribute('inputmode', v); }
  get lang(): string { return this._attrs.get('lang') ?? ''; }
  set lang(v: string) { this.setAttribute('lang', v); }
  get dir(): string { return this._attrs.get('dir') ?? ''; }
  set dir(v: string) { this.setAttribute('dir', v); }
  get slot(): string { return this._attrs.get('slot') ?? ''; }
  set slot(v: string) { this.setAttribute('slot', v); }
  get accessKey(): string { return this._attrs.get('accesskey') ?? ''; }
  set accessKey(v: string) { this.setAttribute('accesskey', v); }
  get accessKeyLabel(): string { return this._attrs.get('accesskey') ?? ''; }
  get part(): { add(...p: string[]): void; remove(...p: string[]): void; contains(p: string): boolean; toString(): string; value: string } {
    return {
      get value() { return ''; },
      add() {}, remove() {}, contains() { return false; }, toString() { return ''; },
    };
  }

  // on* property handlers
  get onclick():  ((e: VEvent) => void) | null { return this._onHandlers['click']  ?? null; }
  set onclick(fn: ((e: VEvent) => void) | null) { this._setOn('click', fn); }
  get onchange(): ((e: VEvent) => void) | null { return this._onHandlers['change'] ?? null; }
  set onchange(fn: ((e: VEvent) => void) | null) { this._setOn('change', fn); }
  get onsubmit(): ((e: VEvent) => void) | null { return this._onHandlers['submit'] ?? null; }
  set onsubmit(fn: ((e: VEvent) => void) | null) { this._setOn('submit', fn); }
  get oninput():  ((e: VEvent) => void) | null { return this._onHandlers['input']  ?? null; }
  set oninput(fn: ((e: VEvent) => void) | null) { this._setOn('input', fn); }
  get onkeydown():((e: VEvent) => void) | null { return this._onHandlers['keydown'] ?? null; }
  set onkeydown(fn: ((e: VEvent) => void) | null) { this._setOn('keydown', fn); }
  get onkeyup():  ((e: VEvent) => void) | null { return this._onHandlers['keyup']  ?? null; }
  set onkeyup(fn: ((e: VEvent) => void) | null) { this._setOn('keyup', fn); }
  get onfocus():  ((e: VEvent) => void) | null { return this._onHandlers['focus']  ?? null; }
  set onfocus(fn: ((e: VEvent) => void) | null) { this._setOn('focus', fn); }
  get onblur():   ((e: VEvent) => void) | null { return this._onHandlers['blur']   ?? null; }
  set onblur(fn: ((e: VEvent) => void) | null) { this._setOn('blur', fn); }
  get onload():   ((e: VEvent) => void) | null { return this._onHandlers['load']   ?? null; }
  set onload(fn: ((e: VEvent) => void) | null) { this._setOn('load', fn); }
  _setOn(ev: string, fn: ((e: VEvent) => void) | null): void {
    var old = this._onHandlers[ev]; if (old) this.removeEventListener(ev, old);
    this._onHandlers[ev] = fn; if (fn) this.addEventListener(ev, fn);
  }

  getAttribute(name: string): string | null { var v = this._attrs.get(name.toLowerCase()); return v !== undefined ? v : null; }
  setAttribute(name: string, value: string): void {
    var lname = name.toLowerCase();
    var oldValue = this._attrs.get(lname) ?? null;
    this._attrs.set(lname, String(value));
    this._dirtyLayout = true; // item 891
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'attributes', target: this, attributeName: lname, attributeNamespace: null, oldValue });
    }
  }
  removeAttribute(name: string): void {
    var lname = name.toLowerCase();
    var oldValue = this._attrs.get(lname) ?? null;
    this._attrs.delete(lname);
    this._dirtyLayout = true; // item 891
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'attributes', target: this, attributeName: lname, attributeNamespace: null, oldValue });
    }
  }
  hasAttribute(name: string): boolean { return this._attrs.has(name.toLowerCase()); }
  getAttributeNames(): string[] { return [...this._attrs.keys()]; }
  /** element.attributes — live NamedNodeMap-like object (item 566) */
  get attributes(): any {
    var self = this;
    var attrObjs = () => [...self._attrs.entries()].map(([k, v]) => ({ name: k, localName: k, value: v, specified: true, ownerElement: self, prefix: null, namespaceURI: null }));
    return new Proxy({}, {
      get(_t, k) {
        var arr = attrObjs();
        if (k === 'length') return arr.length;
        if (k === 'item') return (i: number) => arr[i] ?? null;
        if (k === 'getNamedItem') return (n: string) => arr.find(a => a.name === n.toLowerCase()) ?? null;
        if (k === 'setNamedItem') return (a: { name: string; value: string }) => { self.setAttribute(a.name, a.value); return null; };
        if (k === 'removeNamedItem') return (n: string) => { self.removeAttribute(n); return null; };
        if (k === Symbol.iterator) return function* () { yield* arr; };
        if (typeof k === 'string') {
          var idx = parseInt(k, 10);
          if (!isNaN(idx)) return arr[idx] ?? undefined;
          return arr.find(a => a.name === k) ?? undefined;
        }
        return undefined;
      },
      has(_t, k) {
        var arr = attrObjs();
        if (k === 'length' || k === 'item' || k === 'getNamedItem' || k === 'setNamedItem' || k === 'removeNamedItem' || k === Symbol.iterator) return true;
        if (typeof k === 'string') { var idx = parseInt(k, 10); if (!isNaN(idx)) return idx < arr.length; return arr.some(a => a.name === k); }
        return false;
      },
    });
  }
  // Namespaced attribute variants — ignore namespace, treat as plain attributes
  getAttributeNS(_ns: string | null, name: string): string | null { return this.getAttribute(name); }
  setAttributeNS(_ns: string | null, name: string, value: string): void { this.setAttribute(name, value); }
  removeAttributeNS(_ns: string | null, name: string): void { this.removeAttribute(name); }
  hasAttributeNS(_ns: string | null, name: string): boolean { return this.hasAttribute(name); }
  getAttributeNode(name: string): { name: string; value: string; specified: boolean } | null {
    var v = this.getAttribute(name); return v !== null ? { name, value: v, specified: true } : null;
  }
  setAttributeNode(attr: { name: string; value: string }): null { this.setAttribute(attr.name, attr.value); return null; }
  removeAttributeNode(attr: { name: string; value: string }): void { this.removeAttribute(attr.name); }
  // ARIA property shortcuts (used by accessibility tools and React-ARIA)
  get role(): string { return this.getAttribute('role') || ''; }
  set role(v: string) { this.setAttribute('role', v); }
  get ariaLabel(): string | null { return this.getAttribute('aria-label'); }
  set ariaLabel(v: string | null) { if (v !== null) this.setAttribute('aria-label', v); else this.removeAttribute('aria-label'); }
  get ariaHidden(): string | null { return this.getAttribute('aria-hidden'); }
  set ariaHidden(v: string | null) { if (v !== null) this.setAttribute('aria-hidden', v); else this.removeAttribute('aria-hidden'); }
  get ariaDisabled(): string | null { return this.getAttribute('aria-disabled'); }
  set ariaDisabled(v: string | null) { if (v !== null) this.setAttribute('aria-disabled', v); else this.removeAttribute('aria-disabled'); }
  get ariaExpanded(): string | null { return this.getAttribute('aria-expanded'); }
  set ariaExpanded(v: string | null) { if (v !== null) this.setAttribute('aria-expanded', v); else this.removeAttribute('aria-expanded'); }
  get ariaSelected(): string | null { return this.getAttribute('aria-selected'); }
  set ariaSelected(v: string | null) { if (v !== null) this.setAttribute('aria-selected', v); else this.removeAttribute('aria-selected'); }
  get ariaChecked(): string | null { return this.getAttribute('aria-checked'); }
  set ariaChecked(v: string | null) { if (v !== null) this.setAttribute('aria-checked', v); else this.removeAttribute('aria-checked'); }
  get ariaBusy(): string | null { return this.getAttribute('aria-busy'); }
  set ariaBusy(v: string | null) { if (v !== null) this.setAttribute('aria-busy', v); else this.removeAttribute('aria-busy'); }
  get ariaLive(): string | null { return this.getAttribute('aria-live'); }
  set ariaLive(v: string | null) { if (v !== null) this.setAttribute('aria-live', v); else this.removeAttribute('aria-live'); }
  get ariaAtomic(): string | null { return this.getAttribute('aria-atomic'); }
  set ariaAtomic(v: string | null) { if (v !== null) this.setAttribute('aria-atomic', v); else this.removeAttribute('aria-atomic'); }
  get ariaPressed(): string | null { return this.getAttribute('aria-pressed'); }
  set ariaPressed(v: string | null) { if (v !== null) this.setAttribute('aria-pressed', v); else this.removeAttribute('aria-pressed'); }
  get ariaValueNow(): string | null { return this.getAttribute('aria-valuenow'); }
  set ariaValueNow(v: string | null) { if (v !== null) this.setAttribute('aria-valuenow', v); else this.removeAttribute('aria-valuenow'); }
  get ariaValueMin(): string | null { return this.getAttribute('aria-valuemin'); }
  set ariaValueMin(v: string | null) { if (v !== null) this.setAttribute('aria-valuemin', v); else this.removeAttribute('aria-valuemin'); }
  get ariaValueMax(): string | null { return this.getAttribute('aria-valuemax'); }
  set ariaValueMax(v: string | null) { if (v !== null) this.setAttribute('aria-valuemax', v); else this.removeAttribute('aria-valuemax'); }
  get ariaValueText(): string | null { return this.getAttribute('aria-valuetext'); }
  set ariaValueText(v: string | null) { if (v !== null) this.setAttribute('aria-valuetext', v); else this.removeAttribute('aria-valuetext'); }
  get ariaRequired(): string | null { return this.getAttribute('aria-required'); }
  set ariaRequired(v: string | null) { if (v !== null) this.setAttribute('aria-required', v); else this.removeAttribute('aria-required'); }
  get ariaReadOnly(): string | null { return this.getAttribute('aria-readonly'); }
  set ariaReadOnly(v: string | null) { if (v !== null) this.setAttribute('aria-readonly', v); else this.removeAttribute('aria-readonly'); }
  toggleAttribute(name: string, force?: boolean): boolean {
    if (force === true || (force === undefined && !this.hasAttribute(name))) { this.setAttribute(name, ''); return true; }
    this.removeAttribute(name); return false;
  }

  get innerHTML(): string { return _serialize(this.childNodes); }
  set innerHTML(html: string) {
    var removedNodes = this.childNodes.slice();
    this.childNodes = [];
    if (html) {
      // Sanitize before parsing to strip scripts/event-handlers (item 370)
      var frag = _parseFragment(sanitizeHTML(html), this.ownerDocument);
      for (var c of frag) { c.parentNode = this; c.ownerDocument = this.ownerDocument; }
      this.childNodes = frag;
    }
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: this.childNodes.slice(), removedNodes, previousSibling: null, nextSibling: null });
    }
  }
  get outerHTML(): string { return _serializeEl(this); }
  set outerHTML(html: string) {
    if (!this.parentNode) return;
    var frag = _parseFragment(html, this.ownerDocument);
    for (var n of frag) this.parentNode.insertBefore(n, this);
    this.parentNode.removeChild(this);
  }
  insertAdjacentHTML(pos: string, html: string): void {
    var p = pos.toLowerCase();
    var frag = _parseFragment(html, this.ownerDocument);
    if (p === 'beforeend') { for (var n of frag) this.appendChild(n); }
    else if (p === 'afterbegin') { for (var n2 of frag.reverse()) this.insertBefore(n2, this.firstChild); }
    else if (this.parentNode) {
      if (p === 'afterend') {
        // Capture nextSibling before loop; insertions must not shift the target
        var _ref = this.nextSibling as VElement | null;
        for (var n3 of frag) this.parentNode.insertBefore(n3, _ref);
      } else { // beforebegin
        for (var n4 of frag) this.parentNode.insertBefore(n4, this);
      }
    }
  }
  insertAdjacentText(pos: string, text: string): void { this.insertAdjacentHTML(pos, _escapeText(text)); }
  insertAdjacentElement(pos: string, el: VElement): VElement | null { this.insertAdjacentHTML(pos, _serializeEl(el)); return el; }

  /** Append multiple nodes or strings (coerced to Text nodes). */
  append(...nodes: (VNode | string)[]): void {
    for (var n of nodes) {
      if (typeof n === 'string') { var t = new VText(n); t.ownerDocument = this.ownerDocument; this.appendChild(t); }
      else this.appendChild(n);
    }
  }

  /** Prepend multiple nodes or strings before first child. */
  prepend(...nodes: (VNode | string)[]): void {
    var ref = this.firstChild;
    for (var n of nodes) {
      var node: VNode = typeof n === 'string' ? (() => { var t = new VText(n); t.ownerDocument = this.ownerDocument; return t; })() : n;
      this.insertBefore(node, ref);
    }
  }

  /** Replace all children. */
  replaceChildren(...nodes: (VNode | string)[]): void {
    this.childNodes = [];
    if (this.ownerDocument) this.ownerDocument._dirty = true;
    this.append(...nodes);
  }

  /** Insert nodes before this element in its parent. */
  before(...nodes: (VNode | string)[]): void {
    if (!this.parentNode) return;
    for (var n of nodes) {
      var node: VNode = typeof n === 'string' ? (() => { var t = new VText(n); t.ownerDocument = this.ownerDocument; return t; })() : n;
      this.parentNode.insertBefore(node, this);
    }
  }

  /** Insert nodes after this element in its parent. */
  after(...nodes: (VNode | string)[]): void {
    if (!this.parentNode) return;
    var ref: VNode | null = this.nextSibling;
    for (var n of nodes) {
      var node2: VNode = typeof n === 'string' ? (() => { var t = new VText(n); t.ownerDocument = this.ownerDocument; return t; })() : n;
      this.parentNode.insertBefore(node2, ref);
    }
  }

  /** Replace this element with the given nodes. */
  replaceWith(...nodes: (VNode | string)[]): void {
    if (!this.parentNode) return;
    this.before(...nodes);
    this.parentNode!.removeChild(this);
  }

  get children(): VElement[] { return this.childNodes.filter(c => c instanceof VElement) as VElement[]; }
  get childElementCount(): number { return this.children.length; }
  get firstElementChild(): VElement | null { return this.children[0] ?? null; }
  get lastElementChild():  VElement | null { return this.children[this.children.length - 1] ?? null; }

  matches(sel: string): boolean { return _matchSel(sel.trim(), this); }
  closest(sel: string): VElement | null { var el: VElement | null = this; while (el) { if (el.matches(sel)) return el; el = el.parentNode as VElement | null; } return null; }
  querySelectorAll(sel: string): VElement[] { var res: VElement[] = []; _walk(this, el => { if (_matchSel(sel, el)) res.push(el); }); return res; }
  querySelector(sel: string): VElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  getElementsByTagName(tag: string): VElement[] { var t = tag.toUpperCase(); var res: VElement[] = []; _walk(this, el => { if (t === '*' || el.tagName === t) res.push(el); }); return res; }
  getElementsByClassName(cls: string): VElement[] { var clss = cls.split(/\s+/); var res: VElement[] = []; _walk(this, el => { var ec = (el.getAttribute('class') || '').split(/\s+/); if (clss.every(c => ec.includes(c))) res.push(el); }); return res; }
  cloneNode(deep = false): VElement {
    var c = new VElement(this.tagName);
    this._attrs.forEach((v, k) => c._attrs.set(k, v));
    c._style._map = new Map(this._style._map);
    if (deep) { for (var ch of this.childNodes) { var cc = ch.cloneNode(true); cc.parentNode = c; c.childNodes.push(cc); } }
    return c;
  }

  // Convenience getters used by forms
  get form(): VElement | null { return this.closest('form'); }
  get elements(): VElement[] { return this.querySelectorAll('input,textarea,select,button'); }

  // ── <select> element API (item 601) ──────────────────────────────────────
  /** Returns all <option> children for <select> and <datalist> elements. */
  get options(): VElement[] { return this.querySelectorAll('option'); }
  get selectedOptions(): VElement[] { return this.options.filter(o => (o as any).selected || o.hasAttribute('selected')); }
  get multiple(): boolean { return this._attrs.has('multiple'); }
  set multiple(v: boolean) { if (v) this.setAttribute('multiple', ''); else this.removeAttribute('multiple'); }
  /** selectedIndex: first selected option index, or -1 if none. Stored as _selectedIndex for mutation. */
  get selectedIndex(): number {
    var _si = (this as any)._selectedIndex;
    if (typeof _si === 'number') return _si;
    var opts = this.options;
    for (var i = 0; i < opts.length; i++) { if ((opts[i] as any).selected || opts[i].hasAttribute('selected')) return i; }
    return opts.length > 0 ? 0 : -1;
  }
  set selectedIndex(v: number) {
    (this as any)._selectedIndex = v;
    var opts = this.options;
    for (var i = 0; i < opts.length; i++) { (opts[i] as any).selected = (i === v); }
    if (this.ownerDocument) this.ownerDocument._dirty = true;
  }

  // ── <template> element (item 584 adjacent) ────────────────────────────────
  /** HTMLTemplateElement.content — returns the document fragment of the template */
  get content(): VElement {
    if (this.tagName.toLowerCase() !== 'template') return this;
    var frag = new VElement('#document-fragment');
    frag.nodeType = 11;
    frag.ownerDocument = this.ownerDocument;
    for (var ch of this.childNodes) { frag.childNodes.push(ch); }
    return frag;
  }
  focus(_opts?: { preventScroll?: boolean }): void {
    var doc = this.ownerDocument;
    if (doc && doc._activeElement !== this) {
      var prev = doc._activeElement;
      doc._activeElement = this;
      if (prev) { var blurEv = new VEvent('blur', { bubbles: false, cancelable: false }); (blurEv as any).relatedTarget = this; prev.dispatchEvent(blurEv); var focusoutEv = new VEvent('focusout', { bubbles: true, cancelable: false }); (focusoutEv as any).relatedTarget = this; prev.dispatchEvent(focusoutEv); }
      var focusEv = new VEvent('focus', { bubbles: false, cancelable: false }); (focusEv as any).relatedTarget = prev; this.dispatchEvent(focusEv);
      var focusinEv = new VEvent('focusin', { bubbles: true, cancelable: false }); (focusinEv as any).relatedTarget = prev; this.dispatchEvent(focusinEv);
    }
  }
  blur(): void {
    var doc = this.ownerDocument;
    if (doc && doc._activeElement === this) {
      doc._activeElement = null;
      var blurEv = new VEvent('blur', { bubbles: false, cancelable: false }); this.dispatchEvent(blurEv);
      var focusoutEv = new VEvent('focusout', { bubbles: true, cancelable: false }); this.dispatchEvent(focusoutEv);
    }
  }
  click(): void { this.dispatchEvent(new VEvent('click')); }
  submit(): void { this.dispatchEvent(new VEvent('submit')); }
  reset(): void {
    // Reset all fields to their default values
    _walk(this, n => {
      if (n instanceof VElement) {
        var tag = n.tagName.toLowerCase();
        if (tag === 'input') {
          var type = (n.getAttribute('type') || 'text').toLowerCase();
          if (type === 'checkbox' || type === 'radio') {
            if (n.hasAttribute('checked')) (n as any).checked = true; else (n as any).checked = false;
          } else {
            (n as any).value = n.getAttribute('value') || '';
          }
        } else if (tag === 'textarea') {
          (n as any).value = n.textContent || '';
        } else if (tag === 'select') {
          (n as any).selectedIndex = 0;
        }
      }
    });
    this.dispatchEvent(new VEvent('reset'));
  }
  requestSubmit(_submitter?: unknown): void { this.submit(); }

  // Form serialization (item 604) — returns URLSearchParams string
  serializeForm(): string {
    var pairs: string[] = [];
    _walk(this, n => {
      if (!(n instanceof VElement)) return;
      var tag = n.tagName.toLowerCase();
      if (tag === 'input') {
        var type = (n.getAttribute('type') || 'text').toLowerCase();
        var name = n.getAttribute('name');
        if (!name || n.hasAttribute('disabled')) return;
        if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return;
        if (type === 'checkbox' || type === 'radio') {
          if ((n as any).checked) pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent((n as any).value || 'on'));
        } else {
          pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent((n as any).value || ''));
        }
      } else if (tag === 'textarea') {
        var name = n.getAttribute('name');
        if (name && !n.hasAttribute('disabled')) pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent((n as any).value || n.textContent || ''));
      } else if (tag === 'select') {
        var name = n.getAttribute('name');
        if (!name || n.hasAttribute('disabled')) return;
        var si = (n as any).selectedIndex ?? 0;
        var opts = n.querySelectorAll('option');
        if (opts[si]) pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent((opts[si] as any).value ?? opts[si].textContent ?? ''));
      }
    });
    return pairs.join('&');
  }

  // checkValidity for form — iterate all fields
  checkFormValidity(): boolean {
    var valid = true;
    _walk(this, n => {
      if (n instanceof VElement) {
        var tag = n.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (!n.checkValidity()) { valid = false; }
        }
      }
    });
    return valid;
  }

  // Form-specific property shorthands (HTMLFormElement)
  get action(): string  { return this._attrs.get('action') || ''; }  set action(v: string)  { this.setAttribute('action', v); }
  get method(): string  { return this._attrs.get('method') || 'get'; } set method(v: string)  { this.setAttribute('method', v); }
  get enctype(): string { return this._attrs.get('enctype') || 'application/x-www-form-urlencoded'; } set enctype(v: string) { this.setAttribute('enctype', v); }
  get encoding(): string { return this.enctype; } set encoding(v: string) { this.enctype = v; }
  get noValidate(): boolean { return this._attrs.has('novalidate'); } set noValidate(v: boolean) { if (v) this.setAttribute('novalidate', ''); else this.removeAttribute('novalidate'); }
  get acceptCharset(): string { return this._attrs.get('accept-charset') || ''; }
  // elements getter already defined above (in form-input area)

  // <label> htmlFor — reads/writes the `for` attribute
  get htmlFor(): string { return this._attrs.get('for') || ''; }
  set htmlFor(v: string) { this.setAttribute('for', v); }
  get control(): VElement | null {
    var id = this.htmlFor; if (!id || !this.ownerDocument) return null;
    return this.ownerDocument.getElementById(id);
  }

  // Input / form-control common properties
  get autocomplete(): string { return this._attrs.get('autocomplete') || ''; }
  set autocomplete(v: string) { this.setAttribute('autocomplete', v); }
  get list(): VElement | null {
    var id = this._attrs.get('list'); if (!id || !this.ownerDocument) return null;
    return this.ownerDocument.getElementById(id);
  }

  // Form-override attributes on <input>, <button>, <select>, <textarea>
  get formAction(): string  { return this._attrs.get('formaction') || ''; }  set formAction(v: string)  { this.setAttribute('formaction', v); }
  get formMethod(): string  { return this._attrs.get('formmethod') || ''; }  set formMethod(v: string)  { this.setAttribute('formmethod', v); }
  get formEnctype(): string { return this._attrs.get('formenctype') || ''; } set formEnctype(v: string) { this.setAttribute('formenctype', v); }
  get formNoValidate(): boolean { return this._attrs.has('formnovalidate'); } set formNoValidate(v: boolean) { if (v) this.setAttribute('formnovalidate', ''); else this.removeAttribute('formnovalidate'); }
  get formTarget(): string  { return this._attrs.get('formtarget') || ''; }  set formTarget(v: string)  { this.setAttribute('formtarget', v); }

  // HTMLInputElement/HTMLButtonElement — `defaultValue` and `defaultChecked`
  get defaultValue(): string { return this._attrs.get('value') || ''; }
  set defaultValue(v: string) { this.setAttribute('value', v); }
  get defaultChecked(): boolean { return this._attrs.has('checked'); }
  set defaultChecked(v: boolean) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }

  // HTMLInputElement-like — scrollIntoView etc.
  scrollIntoView(): void {}

  // ── Layout/size stubs needed by many JS frameworks ────────────────────────────

  /** Approximate bounding rect — used by JS frameworks checking visibility. */
  getBoundingClientRect(): { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number } {
    // Return a plausible rect so visibility checks don't all return zero
    return { x: 0, y: 0, width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20 };
  }
  get offsetWidth():  number { return 200; }
  get offsetHeight(): number { return 20; }
  get offsetTop():    number { return 0; }
  get offsetLeft():   number { return 0; }
  get offsetParent(): VElement | null { return this.parentNode instanceof VElement ? this.parentNode as VElement : null; }
  get clientWidth():  number { return 200; }
  get clientHeight(): number { return 20; }
  get clientTop():    number { return 0; }
  get clientLeft():   number { return 0; }
  scrollTop = 0;
  scrollLeft = 0;
  get scrollWidth():  number { return 200; }
  get scrollHeight(): number { return 20; }

  /** Returns an array of DOMRect objects for each CSS border box of the element. */
  getClientRects(): Array<{ x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }> {
    return [this.getBoundingClientRect()];
  }

  /** CSS Typed OM — computedStyleMap() — checked by CSS Houdini and some frameworks */
  computedStyleMap(): any {
    var self = this;
    return {
      get(prop: string): unknown {
        var val = self._style.getPropertyValue(prop);
        return val ? { value: parseFloat(val) || 0, unit: val.replace(/[\d.\-]/g, '').trim() || '', toString() { return val; } } : undefined;
      },
      has(prop: string): boolean { return !!self._style.getPropertyValue(prop); },
      getAll(_prop: string): unknown[] { return []; },
      forEach(_fn: unknown): void {},
      entries() { return [][Symbol.iterator](); },
      keys() { return [][Symbol.iterator](); },
      values() { return [][Symbol.iterator](); },
      [Symbol.iterator]() { return [][Symbol.iterator](); },
      size: 0,
    };
  }

  // ── Pointer capture stubs (item 527) ──────────────────────────────────────────
  setPointerCapture(_pointerId: number): void {}
  releasePointerCapture(_pointerId: number): void {}
  hasPointerCapture(_pointerId: number): boolean { return false; }

  // ── Constraint Validation API (item 615) ──────────────────────────────────────
  _validationMessage = '';
  checkValidity(): boolean {
    var tag = this.tagName.toLowerCase();
    var isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (!isField) return true;
    if (this.hasAttribute('disabled')) return true;
    var val: string = (this as any).value ?? '';
    var type = (this.getAttribute('type') || 'text').toLowerCase();
    // required
    if (this.hasAttribute('required') && !val.trim()) return false;
    // minlength
    var minLen = this.getAttribute('minlength');
    if (minLen !== null && val.length > 0 && val.length < parseInt(minLen, 10)) return false;
    // maxlength
    var maxLen = this.getAttribute('maxlength');
    if (maxLen !== null && val.length > parseInt(maxLen, 10)) return false;
    // pattern
    var pat = this.getAttribute('pattern');
    if (pat && val) { try { if (!new RegExp('^(?:' + pat + ')$').test(val)) return false; } catch(_) {} }
    // type-specific
    if (val && type === 'email') { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return false; }
    if (val && type === 'url') { try { new URL(val); } catch(_) { return false; } }
    if (val && (type === 'number' || type === 'range')) {
      var num = parseFloat(val);
      if (isNaN(num)) return false;
      var min = this.getAttribute('min'); if (min !== null && num < parseFloat(min)) return false;
      var max = this.getAttribute('max'); if (max !== null && num > parseFloat(max)) return false;
    }
    if (this._validationMessage) return false;
    return true;
  }
  reportValidity(): boolean { return this.checkValidity(); }
  setCustomValidity(msg: string): void { this._validationMessage = msg; }
  get validationMessage(): string {
    if (this._validationMessage) return this._validationMessage;
    if (!this.checkValidity()) {
      var type = (this.getAttribute('type') || 'text').toLowerCase();
      var val: string = (this as any).value ?? '';
      if (this.hasAttribute('required') && !val.trim()) return 'Please fill in this field.';
      var minLen = this.getAttribute('minlength');
      if (minLen && val.length < parseInt(minLen, 10)) return 'Please lengthen this text.';
      if (this.getAttribute('pattern')) return 'Please match the requested format.';
      if (type === 'email') return 'Please enter an email address.';
      if (type === 'url') return 'Please enter a URL.';
      if (type === 'number') return 'Please enter a valid number.';
      return 'Invalid value.';
    }
    return '';
  }
  get validity(): ValidityState {
    var tag = this.tagName.toLowerCase();
    var isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (!isField) return { valid: true, valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false, tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, badInput: false, customError: false } as ValidityState;
    var val: string = (this as any).value ?? '';
    var type = (this.getAttribute('type') || 'text').toLowerCase();
    var valueMissing  = this.hasAttribute('required') && !val.trim();
    var minLen = this.getAttribute('minlength');
    var maxLen = this.getAttribute('maxlength');
    var tooShort = !!(minLen && val.length > 0 && val.length < parseInt(minLen, 10));
    var tooLong  = !!(maxLen && val.length > parseInt(maxLen, 10));
    var pat = this.getAttribute('pattern');
    var patternMismatch = !!(pat && val && (() => { try { return !new RegExp('^(?:' + pat + ')$').test(val); } catch(_) { return false; } })());
    var typeMismatch = !!(val && (
      (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) ||
      (type === 'url'   && (() => { try { new URL(val); return false; } catch(_) { return true; } })())
    ));
    var num = parseFloat(val); var isNum = type === 'number' || type === 'range';
    var rangeUnderflow = !!(isNum && val && !isNaN(num) && (() => { var min = this.getAttribute('min'); return min !== null && num < parseFloat(min); })());
    var rangeOverflow  = !!(isNum && val && !isNaN(num) && (() => { var max = this.getAttribute('max'); return max !== null && num > parseFloat(max); })());
    var customError = this._validationMessage.length > 0;
    var valid = !valueMissing && !typeMismatch && !patternMismatch && !tooLong && !tooShort && !rangeUnderflow && !rangeOverflow && !customError;
    return { valid, valueMissing, typeMismatch, patternMismatch, tooLong, tooShort, rangeUnderflow, rangeOverflow, stepMismatch: false, badInput: false, customError } as ValidityState;
  }
  get willValidate(): boolean {
    var tag = this.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  // ── Selection (text input) API ────────────────────────────────────────────────
  _selectionStart = 0; _selectionEnd = 0; _selectionDirection = 'none';
  get selectionStart(): number | null { return this._selectionStart; }
  set selectionStart(v: number | null) { this._selectionStart = v ?? 0; }
  get selectionEnd(): number | null { return this._selectionEnd; }
  set selectionEnd(v: number | null) { this._selectionEnd = v ?? 0; }
  get selectionDirection(): string | null { return this._selectionDirection; }
  set selectionDirection(v: string | null) { this._selectionDirection = v ?? 'none'; }
  setSelectionRange(start: number, end: number, direction?: string): void {
    this._selectionStart = start; this._selectionEnd = end; this._selectionDirection = direction ?? 'none';
  }
  setRangeText(replacement: string, start?: number, end?: number, _selectMode?: string): void {
    var v = this.value ?? '';
    var s = start ?? this._selectionStart; var e = end ?? this._selectionEnd;
    this.value = v.slice(0, s) + replacement + v.slice(e);
    this._selectionStart = this._selectionEnd = s + replacement.length;
  }
  select(): void { this._selectionStart = 0; this._selectionEnd = (this.value ?? '').length; }

  // ── Web Animations API stub (item 585) ────────────────────────────────────────
  animate(_keyframes: unknown[], _opts?: unknown): { finish(): void; cancel(): void; pause(): void; play(): void; reverse(): void; addEventListener(): void; removeEventListener(): void; finished: Promise<unknown> } {
    return { finish() {}, cancel() {}, pause() {}, play() {}, reverse() {}, addEventListener() {}, removeEventListener() {}, finished: Promise.resolve(undefined) };
  }
  getAnimations(): unknown[] { return []; }

  // ── requestPointerLock / exitPointerLock ──────────────────────────────────────
  requestPointerLock(): void {}
  requestFullscreen(_opts?: unknown): Promise<void> { return Promise.resolve(); }

  // ── scroll helpers ────────────────────────────────────────────────────────────
  scroll(xOrOpts?: number | { top?: number; left?: number }, y?: number): void {
    if (typeof xOrOpts === 'object') { this.scrollTop = xOrOpts?.top ?? this.scrollTop; this.scrollLeft = xOrOpts?.left ?? this.scrollLeft; }
    else { this.scrollLeft = xOrOpts ?? 0; this.scrollTop = y ?? 0; }
  }
  scrollBy(xOrOpts?: number | { top?: number; left?: number }, dy?: number): void {
    if (typeof xOrOpts === 'object') { this.scrollTop += xOrOpts?.top ?? 0; this.scrollLeft += xOrOpts?.left ?? 0; }
    else { this.scrollLeft += xOrOpts ?? 0; this.scrollTop += dy ?? 0; }
  }

  // ── HTMLMediaElement stubs (audio/video) ──────────────────────────────────
  // These live on VElement so that querySelector('video') etc. work out of the box.
  _paused = true;
  _currentTime = 0;
  _volume = 1;
  _muted = false;
  _playbackRate = 1;
  _defaultPlaybackRate = 1;
  _duration = NaN;
  _ended = false;
  _readyStateMedia = 0;   // HAVE_NOTHING
  _networkState = 0;      // NETWORK_EMPTY

  play(): Promise<void> {
    this._paused = false; this._ended = false;
    this.dispatchEvent(new VEvent('play', { bubbles: false }));
    return Promise.resolve();
  }
  pause(): void {
    if (!this._paused) { this._paused = true; this.dispatchEvent(new VEvent('pause', { bubbles: false })); }
  }
  load(): void { this._paused = true; this._currentTime = 0; this.dispatchEvent(new VEvent('emptied', { bubbles: false })); }
  canPlayType(_type: string): '' | 'maybe' | 'probably' { return ''; }
  get paused(): boolean { return this._paused; }
  get ended(): boolean  { return this._ended; }
  get seeking(): boolean { return false; }
  get duration(): number { return this._duration; }
  get currentTime(): number { return this._currentTime; }
  set currentTime(v: number) { this._currentTime = v; }
  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = Math.max(0, Math.min(1, v)); }
  get muted(): boolean { return this._muted || this.hasAttribute('muted'); }
  set muted(v: boolean) { this._muted = v; }
  get playbackRate(): number { return this._playbackRate; }
  set playbackRate(v: number) { this._playbackRate = v; }
  get defaultPlaybackRate(): number { return this._defaultPlaybackRate; }
  set defaultPlaybackRate(v: number) { this._defaultPlaybackRate = v; }
  get readyStateMedia(): number { return this._readyStateMedia; }
  get networkState(): number { return this._networkState; }
  get loop(): boolean { return this.hasAttribute('loop'); }
  set loop(v: boolean) { if (v) this.setAttribute('loop', ''); else this.removeAttribute('loop'); }
  get autoplay(): boolean { return this.hasAttribute('autoplay'); }
  set autoplay(v: boolean) { if (v) this.setAttribute('autoplay', ''); else this.removeAttribute('autoplay'); }
  get controls(): boolean { return this.hasAttribute('controls'); }
  set controls(v: boolean) { if (v) this.setAttribute('controls', ''); else this.removeAttribute('controls'); }
  get preload(): string { return this.getAttribute('preload') || 'auto'; }
  set preload(v: string) { this.setAttribute('preload', v); }
  get buffered(): any { return { length: 0, start(_i: number) { return 0; }, end(_i: number) { return 0; } }; }
  get played(): any   { return { length: 0, start(_i: number) { return 0; }, end(_i: number) { return 0; } }; }
  get seekable(): any { return { length: 0, start(_i: number) { return 0; }, end(_i: number) { return 0; } }; }
  get videoWidth():  number { return parseInt(this.getAttribute('width') || '0', 10); }
  get videoHeight(): number { return parseInt(this.getAttribute('height') || '0', 10); }
  get textTracks(): any { return { length: 0, addEventListener() {}, removeEventListener() {} }; }
  get audioTracks(): any { return { length: 0 }; }
  get videoTracks(): any { return { length: 0 }; }
  addTextTrack(_kind: string, _label?: string, _lang?: string): any { return { kind: _kind, label: _label || '', language: _lang || '', mode: 'disabled', cues: [], addCue() {}, removeCue() {} }; }
  fastSeek(time: number): void { this._currentTime = time; }
  getStartDate(): Date { return new Date(0); }
  // Constants
  static readonly HAVE_NOTHING         = 0;
  static readonly HAVE_METADATA        = 1;
  static readonly HAVE_CURRENT_DATA    = 2;
  static readonly HAVE_FUTURE_DATA     = 3;
  static readonly HAVE_ENOUGH_DATA     = 4;
  static readonly NETWORK_EMPTY        = 0;
  static readonly NETWORK_IDLE         = 1;
  static readonly NETWORK_LOADING      = 2;
  static readonly NETWORK_NO_SOURCE    = 3;

  get dataset(): Record<string, string> {
    var self = this;
    return new Proxy({} as Record<string, string>, {
      get(_t: Record<string, string>, k: string): string | undefined {
        var attr = 'data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        return self.getAttribute(attr) ?? undefined;
      },
      set(_t: Record<string, string>, k: string, v: string): boolean {
        var attr = 'data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        self.setAttribute(attr, String(v));
        return true;
      },
      has(_t: Record<string, string>, k: string): boolean {
        return self.hasAttribute('data-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
      },
    });
  }

  // ── Shadow DOM stub ─────────────────────────────────────────────────────────

  _shadowRoot: VElement | null = null;
  attachShadow(_opts: { mode: string }): VElement { this._shadowRoot = this; return this; }
  get shadowRoot(): VElement | null { return this._shadowRoot; }
  adoptedStyleSheets: unknown[] = [];

  // ── next/prev element sibling ─────────────────────────────────────────────────

  get nextElementSibling(): VElement | null {
    var sib = this.nextSibling;
    while (sib) { if (sib instanceof VElement) return sib as VElement; sib = sib.nextSibling; }
    return null;
  }
  get previousElementSibling(): VElement | null {
    var sib = this.previousSibling;
    while (sib) { if (sib instanceof VElement) return sib as VElement; sib = sib.previousSibling; }
    return null;
  }

  // ── Namespace / SVG properties ────────────────────────────────────────────────

  get namespaceURI(): string | null {
    var tag = this.tagName;
    if (tag === 'SVG' || this._attrs.get('xmlns') === 'http://www.w3.org/2000/svg') return 'http://www.w3.org/2000/svg';
    if (tag === 'MATH') return 'http://www.w3.org/1998/Math/MathML';
    return 'http://www.w3.org/1999/xhtml';
  }
  get localName(): string { return this.tagName.toLowerCase(); }
  get prefix(): string | null { return null; }
  get ownerSVGElement(): VElement | null {
    var p: VNode | null = this.parentNode;
    while (p) { if (p instanceof VElement && p.tagName === 'SVG') return p; p = p.parentNode; }
    return null;
  }
  get viewportElement(): VElement | null { return this.ownerSVGElement; }

  // ── outerText / innerText ─────────────────────────────────────────────────────
  get outerText(): string { return this.textContent || ''; }
  set outerText(v: string) { if (this.parentNode) { var t = new VText(v); t.parentNode = this.parentNode; t.ownerDocument = this.ownerDocument; var idx = this.parentNode.childNodes.indexOf(this as any); if (idx >= 0) this.parentNode.childNodes.splice(idx, 1, t as any); } }

  /**
   * innerText: layout-aware text content.
   * Getter returns visible text content with block elements separated by \n
   * and <br> converted to \n.  Setter replaces children with text nodes,
   * converting \n sequences to <br> elements.
   */
  get innerText(): string {
    // Block-level tags that produce newlines
    var BLOCK = new Set(['div','p','h1','h2','h3','h4','h5','h6','li','tr','blockquote','pre','article','section','header','footer','aside','main','nav','figure','figcaption','dl','dt','dd']);
    function walk(node: VNode): string {
      if (node instanceof VText) return (node as VText).data || '';
      if (!(node instanceof VElement)) return '';
      var el = node as VElement;
      var tag = el.tagName.toLowerCase();
      if (tag === 'br') return '\n';
      // Skip hidden / script / style elements
      if (tag === 'script' || tag === 'style' || tag === 'head') return '';
      var style = el.getAttribute('style') || '';
      if (style.indexOf('display:none') >= 0 || style.indexOf('display: none') >= 0 ||
          style.indexOf('visibility:hidden') >= 0) return '';
      var parts = '';
      for (var c of el.childNodes) parts += walk(c);
      if (BLOCK.has(tag)) parts = '\n' + parts + '\n';
      return parts;
    }
    var raw = walk(this);
    // Collapse multiple newlines to at most 2, trim leading/trailing
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }
  set innerText(v: string) {
    var removed = this.childNodes.slice();
    this.childNodes = [];
    // Split on \n and interleave <br> elements
    var parts = String(v).split('\n');
    for (var pi = 0; pi < parts.length; pi++) {
      var txt = new VText(parts[pi]!); txt.ownerDocument = this.ownerDocument; txt.parentNode = this;
      this.childNodes.push(txt as any);
      if (pi < parts.length - 1) {
        var br = new VElement('br'); br.ownerDocument = this.ownerDocument; br.parentNode = this;
        this.childNodes.push(br as any);
      }
    }
    if (this.ownerDocument) {
      this.ownerDocument._dirty = true;
      this.ownerDocument._queueMutation({ type: 'childList', target: this, addedNodes: this.childNodes.slice(), removedNodes: removed, previousSibling: null, nextSibling: null });
    }
  }
}

// ── VRange ────────────────────────────────────────────────────────────────────
// DOM Range API (item 580) — full surface for SPA/framework compatibility

export class VRange {
  startContainer: VNode | null = null;
  startOffset: number = 0;
  endContainer: VNode | null = null;
  endOffset: number = 0;
  collapsed: boolean = true;
  commonAncestorContainer: VNode | null = null;

  private _updateCollapsed(): void {
    this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset;
    // commonAncestorContainer: walk up from startContainer and endContainer to find common ancestor
    if (this.startContainer === this.endContainer) {
      this.commonAncestorContainer = this.startContainer;
    } else if (this.startContainer) {
      // Simple approximation: use parentNode of startContainer
      this.commonAncestorContainer = this.startContainer.parentNode ?? this.startContainer;
    }
  }

  setStart(node: VNode, offset: number): void {
    this.startContainer = node; this.startOffset = offset; this._updateCollapsed();
  }
  setEnd(node: VNode, offset: number): void {
    this.endContainer = node; this.endOffset = offset; this._updateCollapsed();
  }
  setStartBefore(node: VNode): void {
    var p = node.parentNode; if (!p) return;
    this.startContainer = p; this.startOffset = p.childNodes.indexOf(node as any);
    this._updateCollapsed();
  }
  setStartAfter(node: VNode): void {
    var p = node.parentNode; if (!p) return;
    this.startContainer = p; this.startOffset = p.childNodes.indexOf(node as any) + 1;
    this._updateCollapsed();
  }
  setEndBefore(node: VNode): void {
    var p = node.parentNode; if (!p) return;
    this.endContainer = p; this.endOffset = p.childNodes.indexOf(node as any);
    this._updateCollapsed();
  }
  setEndAfter(node: VNode): void {
    var p = node.parentNode; if (!p) return;
    this.endContainer = p; this.endOffset = p.childNodes.indexOf(node as any) + 1;
    this._updateCollapsed();
  }
  selectNode(node: VNode): void {
    this.setStartBefore(node); this.setEndAfter(node);
  }
  selectNodeContents(node: VNode): void {
    this.startContainer = node; this.startOffset = 0;
    this.endContainer = node; this.endOffset = node.childNodes.length;
    this._updateCollapsed();
  }
  collapse(toStart = true): void {
    if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
    else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    this.collapsed = true;
    this.commonAncestorContainer = this.startContainer;
  }
  cloneRange(): VRange {
    var r = new VRange();
    r.startContainer = this.startContainer; r.startOffset = this.startOffset;
    r.endContainer = this.endContainer; r.endOffset = this.endOffset;
    r.collapsed = this.collapsed; r.commonAncestorContainer = this.commonAncestorContainer;
    return r;
  }
  detach(): void { this.startContainer = this.endContainer = this.commonAncestorContainer = null; }
  toString(): string {
    if (this.startContainer instanceof VText) return (this.startContainer as VText).data.slice(this.startOffset, this.endOffset);
    if (this.startContainer instanceof VElement) {
      var texts: string[] = [];
      _walk(this.startContainer as VElement, (n: VNode) => { if (n instanceof VText) texts.push((n as VText).data); });
      return texts.join('');
    }
    return '';
  }
  // Content manipulation — stub implementations that are safe (no-ops or minimal)
  deleteContents(): void {}
  extractContents(): any { return { nodeType: 11, childNodes: [], appendChild() {}, querySelectorAll() { return []; } }; }
  cloneContents(): any { return this.extractContents(); }
  insertNode(node: VNode): void {
    var sc = this.startContainer;
    if (!sc) return;
    if (sc instanceof VText) {
      // Split text node and insert before the second half
      var t = sc as VText;
      var parent = t.parentNode; if (!parent) return;
      var after = t.splitText(this.startOffset);
      var idx = parent.childNodes.indexOf(after as any);
      parent.childNodes.splice(idx, 0, node as any);
      node.parentNode = parent; node.ownerDocument = t.ownerDocument;
    } else if (sc.childNodes) {
      var ref = sc.childNodes[this.startOffset] ?? null;
      (sc as any).insertBefore(node, ref);
    }
  }
  surroundContents(node: VElement): void {
    var sc = this.startContainer; if (!sc || !sc.parentNode) return;
    var p = sc.parentNode;
    var idx = p.childNodes.indexOf(sc as any);
    if (idx >= 0) { p.childNodes.splice(idx, 1, node as any); node.parentNode = p; node.ownerDocument = p.ownerDocument; node.appendChild(sc); }
  }
  isPointInRange(node: VNode, _offset: number): boolean { return node === this.startContainer || node === this.endContainer; }
  compareBoundaryPoints(_how: number, _sourceRange: VRange): number { return 0; }
  comparePoint(_node: VNode, _offset: number): number { return 0; }
  getBoundingClientRect(): DOMRect { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() { return {}; } } as DOMRect; }
  getClientRects(): DOMRect[] { return []; }
  createContextualFragment(html: string): any {
    var doc = (this.startContainer?.ownerDocument ?? null) as any;
    var nodes = _parseFragment(html, doc);
    var frag = { nodeType: 11, childNodes: nodes as any[], ownerDocument: doc, querySelectorAll: (sel: string) => _matchSel ? nodes.filter((n: VNode) => n instanceof VElement && _matchSel(sel, n as VElement)) : [] };
    nodes.forEach((n: VNode) => { n.parentNode = frag as any; });
    return frag;
  }
}

// ── VDocument ─────────────────────────────────────────────────────────────────

export class VDocument extends VNode {
  nodeType = 9; nodeName = '#document';
  _title = '';
  _dirty = false;
  _cookie = '';
  _activeElement: VElement | null = null;
  _styleSheets: unknown[] = [];
  _currentScript: VElement | null = null;  // set by jsruntime while executing <script>
  _mutationQueue: unknown[] = [];           // queued mutation records for MutationObserver
  head: VElement;
  body: VElement;
  documentElement: VElement;

  get currentScript(): VElement | null { return this._currentScript; }

  /** Enqueue a mutation record (called by VNode/VElement mutation methods). */
  _queueMutation(rec: unknown): void { this._mutationQueue.push(rec); }

  constructor() {
    super(); this.ownerDocument = this;
    var html = new VElement('html'); html.ownerDocument = this; html.parentNode = this; this.documentElement = html; this.childNodes = [html];
    var head = new VElement('head'); head.ownerDocument = this; head.parentNode = html; this.head = head;
    var body = new VElement('body'); body.ownerDocument = this; body.parentNode = html; this.body = body;
    html.childNodes = [head, body];
  }

  get title(): string { return this._title; }
  set title(v: string) { this._title = v; this._dirty = true; }
  get cookie(): string { return this._cookie; }
  set cookie(v: string) {
    var eq = v.indexOf('='); var k = eq >= 0 ? v.slice(0, eq).trim() : v.trim(); var vl = eq >= 0 ? v.slice(eq + 1).split(';')[0].trim() : '';
    var pairs = this._cookie.split(';').map(p => p.trim()).filter(Boolean); var found = false;
    for (var i = 0; i < pairs.length; i++) { if (pairs[i].split('=')[0].trim() === k) { pairs[i] = k + '=' + vl; found = true; break; } }
    if (!found) pairs.push(k + '=' + vl); this._cookie = pairs.join('; ');
  }
  get body_(): VElement { return this.body; }

  createElement(tag: string): VElement { var el = new VElement(tag); el.ownerDocument = this; return el; }
  createElementNS(_ns: string, tag: string): VElement { return this.createElement(tag); }
  createTextNode(text: string): VText { var t = new VText(text); t.ownerDocument = this; return t; }
  createDocumentFragment(): VElement { var f = new VElement('#document-fragment'); f.nodeType = 11; f.ownerDocument = this; return f; }
  createAttribute(name: string): { name: string; value: string; specified: boolean; ownerElement: null } {
    return { name: name.toLowerCase(), value: '', specified: true, ownerElement: null };
  }
  createAttributeNS(_ns: string | null, qualifiedName: string): { name: string; value: string; specified: boolean; ownerElement: null } {
    return this.createAttribute(qualifiedName);
  }

  getElementById(id: string): VElement | null { var res: VElement | null = null; _walk(this.body, el => { if (!res && el.id === id) res = el; }); if (!res) _walk(this.head, el => { if (!res && el.id === id) res = el; }); return res; }
  querySelector(sel: string): VElement | null { return this.body.querySelector(sel) ?? this.head.querySelector(sel); }
  querySelectorAll(sel: string): VElement[] { return [...this.head.querySelectorAll(sel), ...this.body.querySelectorAll(sel)]; }
  getElementsByTagName(tag: string): VElement[] { return this.body.getElementsByTagName(tag); }
  getElementsByClassName(cls: string): VElement[] { return this.body.getElementsByClassName(cls); }
  getElementsByName(name: string): VElement[] { var res: VElement[] = []; _walk(this.body, el => { if (el.getAttribute('name') === name) res.push(el); }); return res; }

  write(html: string): void { this.body.innerHTML += html; }
  writeln(html: string): void { this.write(html + '\n'); }
  /** Legacy document.open() — clears body content for subsequent write() calls */
  open(): VDocument { this.body.innerHTML = ''; this.head.innerHTML = ''; return this; }
  /** Legacy document.close() — no-op in JSOS */
  close(): void {}
  // Stubs
  createComment(data: string): VNode { var n = new VNode(); (n as any).nodeType = 8; (n as any).nodeName = '#comment'; (n as any).data = data; n.ownerDocument = this; return n; }
  createProcessingInstruction(target: string, data: string): VNode {
    var n = new VNode(); (n as any).nodeType = 7; (n as any).nodeName = target; (n as any).target = target; (n as any).data = data; n.ownerDocument = this; return n;
  }
  hasFocus(): boolean { return true; }
  execCommand(_cmd: string, _show?: boolean, _val?: string): boolean { return false; }
  queryCommandState(_cmd: string): boolean { return false; }
  queryCommandEnabled(_cmd: string): boolean { return false; }
  queryCommandSupported(_cmd: string): boolean { return false; }
  designMode = 'off';
  getSelection(): unknown { return (this as any)._selectionRef ?? null; }
  /**
   * Legacy document.createEvent() + initEvent() pattern.
   * e.g. var ev = document.createEvent('Event'); ev.initEvent('click', true, true);
   */
  createEvent(type: string): VEvent {
    var ev = new VEvent('');
    // Add initEvent() for legacy compatibility
    (ev as any).initEvent = function(typeArg: string, bubbles = false, cancelable = false) {
      this.type = typeArg; this.bubbles = bubbles; this.cancelable = cancelable;
    };
    // Mouse event extra properties
    if (/mouse|pointer|click|drag|wheel/i.test(type)) {
      (ev as any).clientX = 0; (ev as any).clientY = 0; (ev as any).button = 0;
      (ev as any).initMouseEvent = function(t: string, bb: boolean, cc: boolean, _view: unknown, _detail: number, _sx: number, _sy: number, cx: number, cy: number, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, btn: number, _related: unknown) {
        this.type = t; this.bubbles = bb; this.cancelable = cc; this.clientX = cx; this.clientY = cy;
        this.ctrlKey = ctrl; this.altKey = alt; this.shiftKey = shift; this.metaKey = meta; this.button = btn;
      };
    }
    if (/keyboard/i.test(type)) {
      (ev as any).key = ''; (ev as any).keyCode = 0; (ev as any).which = 0;
      (ev as any).initKeyboardEvent = function(t: string, bb: boolean, cc: boolean, _view: unknown, key: string, _loc: number, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean) {
        this.type = t; this.bubbles = bb; this.cancelable = cc; this.key = key;
        this.ctrlKey = ctrl; this.altKey = alt; this.shiftKey = shift; this.metaKey = meta;
      };
    }
    if (/custom/i.test(type)) {
      (ev as any).detail = null;
      (ev as any).initCustomEvent = function(t: string, bb: boolean, cc: boolean, detail: unknown) {
        this.type = t; this.bubbles = bb; this.cancelable = cc; this.detail = detail;
      };
    }
    return ev;
  }
  createRange(): VRange { var r = new VRange(); r.startContainer = this.body; r.endContainer = this.body; r.commonAncestorContainer = this.body; return r; }
  importNode(node: VNode, deep = false): VNode { return node.cloneNode(deep); }
  adoptNode(node: VNode): VNode { if (node.parentNode) node.parentNode.removeChild(node); node.ownerDocument = this; return node; }

  /**
   * document.evaluate() — XPath evaluation stub (item 591).
   * Handles simple expressions like //*[@id='foo'], //tagname, /tag/tag, text().
   * Returns a minimal XPathResult-like object.
   */
  evaluate(expression: string, contextNode: VNode, _resolver?: unknown, resultType?: number, _result?: unknown): any {
    var root = contextNode instanceof VDocument ? contextNode : (contextNode ?? this);
    var nodes: VElement[] = [];
    var docRoot = root instanceof VDocument ? (root as VDocument) : this;

    // Simple XPath patterns we can handle:
    var expr = expression.trim();

    // //*[@id='X'] or //*[@id="X"]
    var idMatch = expr.match(/^\/\/\*\[@id=['"]([^'"]+)['"]\]$/);
    if (idMatch) { var found = docRoot.getElementById(idMatch[1]); if (found) nodes = [found]; }
    // //tagname or //tag[@attr='val']
    else if (expr.startsWith('//')) {
      var rest = expr.slice(2);
      var tagPart = rest.replace(/\[.*\]$/, '').split('/')[0].trim();
      if (tagPart && tagPart !== '*' && tagPart !== 'text()') {
        _walk(docRoot.body, el => { if (el.tagName === tagPart.toUpperCase()) nodes.push(el); });
        _walk(docRoot.head, el => { if (el.tagName === tagPart.toUpperCase()) nodes.push(el); });
      } else if (tagPart === '*') {
        _walk(docRoot.body, el => nodes.push(el));
        _walk(docRoot.head, el => nodes.push(el));
      }
    }
    // /root/or/path
    else if (expr.startsWith('/') && !expr.startsWith('//')) {
      var parts = expr.split('/').filter(Boolean);
      var cur: VElement[] = [docRoot.documentElement ?? docRoot.body];
      for (var p of parts) { cur = cur.flatMap(el => el.getElementsByTagName(p)); }
      nodes = cur;
    }

    // Build XPathResult-like object
    var _idx = 0;
    return {
      resultType:    resultType ?? 5,
      invalidIteratorState: false,
      snapshotLength: nodes.length,
      numberValue:  nodes.length,
      stringValue:  nodes.length > 0 ? (nodes[0].textContent || '') : '',
      booleanValue: nodes.length > 0,
      singleNodeValue: nodes[0] ?? null,
      iterateNext(): VElement | null { return _idx < nodes.length ? nodes[_idx++] : null; },
      snapshotItem(i: number): VElement | null { return nodes[i] ?? null; },
    };
  }
  elementFromPoint(_x: number, _y: number): VElement | null { return this.body; }
  elementsFromPoint(_x: number, _y: number): VElement[] { return [this.body]; }
  caretPositionFromPoint(_x: number, _y: number): null { return null; }
  exitPointerLock(): void {}
  exitFullscreen(): Promise<void> { return Promise.resolve(); }
  exitPictureInPicture(): Promise<void> { return Promise.resolve(); }
  startViewTransition(callback?: () => Promise<void> | void): any {
    var done = callback ? Promise.resolve().then(callback).catch(() => {}) : Promise.resolve();
    return { ready: Promise.resolve(), finished: done, updateCallbackDone: done, skipTransition(): void {} };
  }
  get fullscreenElement(): VElement | null { return null; }
  get pointerLockElement(): VElement | null { return null; }
  get pictureInPictureElement(): VElement | null { return null; }
  get fullscreenEnabled(): boolean { return false; }
  get pictureInPictureEnabled(): boolean { return false; }

  /** 'loading' | 'interactive' | 'complete' — set by jsruntime during page lifecycle */
  get readyState(): string { return (this as any)._readyState ?? 'complete'; }
  get activeElement(): VElement { return this._activeElement ?? this.body; }
  get styleSheets(): unknown[] { return this._styleSheets; }
  adoptedStyleSheets: unknown[] = [];
  get defaultView(): unknown { return (this as any)._defaultView ?? null; }
  get visibilityState(): string { return 'visible'; }
  /** Document.timeline — Animation timeline (used by GSAP, Framer Motion, Anime.js) */
  get timeline(): any {
    return { currentTime: Date.now(), phase: 'active' };
  }
  get hidden(): boolean { return false; }
  get domain(): string { try { return new URL((this as any)._url ?? '').hostname; } catch(_) { return ''; } }
  get URL(): string { return (this as any)._url ?? ''; }
  get documentURI(): string { return (this as any)._url ?? ''; }
  get referrer(): string { return ''; }
  get lastModified(): string { return new Date().toLocaleString(); }
  get baseURI(): string { return (this as any)._url ?? ''; }
  get contentType(): string { return 'text/html'; }
  get characterSet(): string { return 'UTF-8'; }
  get charset(): string { return 'UTF-8'; }
  get inputEncoding(): string { return 'UTF-8'; }
  get compatMode(): string { return 'CSS1Compat'; }  // always standards mode
  get documentMode(): number { return 11; }           // IE compat shim (item 867)
  get forms(): VElement[] { return this.querySelectorAll('form'); }
  get images(): VElement[] { return this.querySelectorAll('img'); }
  get links(): VElement[] { return this.querySelectorAll('a[href],area[href]'); }
  get scripts(): VElement[] { return this.querySelectorAll('script'); }

  /** document.all — legacy HTMLAllCollection (item 592) */
  get all(): any {
    var self = this;
    return new Proxy([], {
      get(_t: any, k: string) {
        var els = self.querySelectorAll('*');
        if (k === 'length') return els.length;
        if (k === 'item') return (i: number) => els[i] ?? null;
        if (k === 'namedItem') return (name: string) => self.getElementById(name) ?? self.querySelector('[name="' + name + '"]') ?? null;
        if (k === Symbol.iterator as any) return () => els[Symbol.iterator]();
        var n = parseInt(k, 10);
        if (!isNaN(n)) return els[n] ?? null;
        return undefined;
      },
    });
  }

  /** FontFaceSet — document.fonts (used by frameworks to detect font loading readiness) */
  get fonts(): any {
    return {
      status: 'loaded',
      size: 0,
      ready: Promise.resolve(this.fonts),
      check(_font: string, _text?: string): boolean { return true; },
      load(_font: string, _text?: string): Promise<unknown[]> { return Promise.resolve([]); },
      forEach(_fn: unknown): void {},
      [Symbol.iterator]() { return [][Symbol.iterator](); },
      values() { return [][Symbol.iterator](); },
      keys() { return [][Symbol.iterator](); },
      entries() { return [][Symbol.iterator](); },
      add(_face: unknown): void {},
      delete(_face: unknown): boolean { return false; },
      has(_face: unknown): boolean { return false; },
      clear(): void {},
      addEventListener() {}, removeEventListener() {},
    };
  }

  createTreeWalker(root: VNode, whatToShow = 0xFFFFFFFF, filter?: { acceptNode?: (node: VNode) => number } | null): any {
    // Collect all nodes respecting whatToShow mask
    function collectNodes(node: VNode, out: VNode[]): void {
      for (var c of node.childNodes) {
        var show = false;
        if ((whatToShow & 1) && c instanceof VElement) show = true;
        else if ((whatToShow & 4) && c instanceof VText) show = true;
        else if ((whatToShow & 0x80) && (c as any).nodeType === 8) show = true;
        else if (whatToShow === 0xFFFFFFFF) show = true;
        if (show) {
          var accept = filter?.acceptNode ? filter.acceptNode(c) : 1; // FILTER_ACCEPT=1
          if (accept === 1) out.push(c);
        }
        collectNodes(c, out);
      }
    }
    var nodes: VNode[] = [root];
    collectNodes(root, nodes);
    var idx = 0;
    return {
      root,
      whatToShow,
      filter: filter ?? null,
      currentNode: root as VNode,
      nextNode(): VNode | null {
        if (idx < nodes.length - 1) { idx++; this.currentNode = nodes[idx]; return this.currentNode; }
        return null;
      },
      previousNode(): VNode | null {
        if (idx > 0) { idx--; this.currentNode = nodes[idx]; return this.currentNode; }
        return null;
      },
      firstChild(): VNode | null {
        var fc = (this.currentNode.childNodes ?? [])[0] ?? null;
        if (fc) { this.currentNode = fc; idx = nodes.indexOf(fc); } return fc;
      },
      lastChild(): VNode | null {
        var ch = this.currentNode.childNodes ?? [];
        var lc = ch[ch.length - 1] ?? null;
        if (lc) { this.currentNode = lc; idx = nodes.indexOf(lc); } return lc;
      },
      parentNode(): VNode | null {
        var p = this.currentNode.parentNode;
        if (p) { this.currentNode = p; idx = nodes.indexOf(p); } return p;
      },
      nextSibling(): VNode | null {
        var p = this.currentNode.parentNode; if (!p) return null;
        var si = p.childNodes.indexOf(this.currentNode as any);
        var ns = si >= 0 ? p.childNodes[si + 1] ?? null : null;
        if (ns) { this.currentNode = ns as VNode; idx = nodes.indexOf(ns as VNode); } return ns as VNode | null;
      },
      previousSibling(): VNode | null {
        var p = this.currentNode.parentNode; if (!p) return null;
        var si = p.childNodes.indexOf(this.currentNode as any);
        var ps2 = si > 0 ? p.childNodes[si - 1] ?? null : null;
        if (ps2) { this.currentNode = ps2 as VNode; idx = nodes.indexOf(ps2 as VNode); } return ps2 as VNode | null;
      },
    };
  }
  createNodeIterator(root: VElement, whatToShow?: number, filter?: unknown): any { return this.createTreeWalker(root, whatToShow, filter as any); }

}

// ── DOM walker + CSS selector engine ──────────────────────────────────────────

export function _walk(root: VNode, fn: (el: VElement) => void): void {
  for (var c of root.childNodes) {
    if (c instanceof VElement) { fn(c); _walk(c, fn); }
  }
}

/** Very basic CSS selector matcher — supports: tag, #id, .cls, [attr], [attr=val],
 *  compound (no space), descendant (space), child (>), comma (,), :first-child, :last-child,
 *  :nth-child(n), :not(sel), :empty, :checked, :disabled */
export function _matchSel(sel: string, el: VElement): boolean {
  // comma: any match
  if (sel.includes(',')) { return sel.split(',').some(s => _matchSel(s.trim(), el)); }
  // descendant / child combinator — walk backwards from el
  var parts = _splitCombinators(sel.trim());
  if (parts.length > 1) { return _matchCombinator(parts, el); }
  return _matchSimple(sel.trim(), el);
}

function _splitCombinators(sel: string): Array<{ comb: ' ' | '>' | '+' | '~' | ''; part: string }> {
  // tokenise into [comb, part] pairs
  var res: Array<{ comb: ' ' | '>' | '+' | '~' | ''; part: string }> = [];
  var re = /\s*([>+~]?)\s*([#.\w\-\[\]:*][^>+~ ]*)/g; var m: RegExpExecArray | null;
  while ((m = re.exec(sel)) !== null) {
    var comb = (m[1] as ' ' | '>' | '+' | '~' | '') || (res.length ? ' ' : '') as ' ' | '>' | '+' | '~' | '';
    res.push({ comb, part: m[2] });
  }
  return res;
}

function _matchCombinator(parts: Array<{ comb: string; part: string }>, el: VElement): boolean {
  var last = parts[parts.length - 1];
  if (!_matchSimple(last.part, el)) return false;
  if (parts.length === 1) return true;
  var comb = last.comb;
  var rest  = parts.slice(0, -1);
  if (comb === '>' || comb === '') {
    var parent = el.parentNode;
    if (!(parent instanceof VElement)) return false;
    if (comb === '>') return _matchCombinator(rest, parent);
    // descendant
    var anc: VElement | null = parent;
    while (anc) { if (_matchCombinator(rest, anc)) return true; anc = anc.parentNode instanceof VElement ? anc.parentNode as VElement : null; }
    return false;
  }
  if (comb === '+') { var prev = el.previousSibling; return (prev instanceof VElement) && _matchCombinator(rest, prev); }
  if (comb === '~') { var sib = el.previousSibling; while (sib) { if (sib instanceof VElement && _matchCombinator(rest, sib)) return true; sib = sib.previousSibling; } return false; }
  return false;
}

function _matchSimple(part: string, el: VElement): boolean {
  if (!part || part === '*') return true;
  var i = 0; var n = part.length;
  // tag
  if (i < n && _isIdent(part[i])) {
    var tag = ''; while (i < n && _isIdent(part[i])) tag += part[i++];
    if (tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
  }
  while (i < n) {
    var c = part[i];
    if (c === '#') { i++; var id = ''; while (i < n && _isIdent(part[i])) id += part[i++]; if (el.id !== id) return false; }
    else if (c === '.') { i++; var cls = ''; while (i < n && _isIdent(part[i])) cls += part[i++]; if (!el.classList.contains(cls)) return false; }
    else if (c === '[') {
      i++; var attr = ''; while (i < n && part[i] !== '=' && part[i] !== ']' && part[i] !== '^' && part[i] !== '$' && part[i] !== '*' && part[i] !== '~' && part[i] !== '|') attr += part[i++];
      attr = attr.trim();
      if (i < n && part[i] === ']') { i++; if (!el.hasAttribute(attr)) return false; }
      else {
        var op = ''; if (i < n && part[i] !== '=') { op = part[i++]; } if (i < n && part[i] === '=') i++;
        var q2 = ''; if (i < n && (part[i] === '"' || part[i] === "'")) { var qc = part[i++]; while (i < n && part[i] !== qc) q2 += part[i++]; if (i < n) i++; } else { while (i < n && part[i] !== ']' && part[i] !== ' ') q2 += part[i++]; }
        // Case-insensitive flag `i` — [attr=val i]
        while (i < n && part[i] === ' ') i++;
        var caseI = false; if (i < n && part[i].toLowerCase() === 'i' && (i + 1 >= n || part[i + 1] === ']')) { caseI = true; i++; }
        if (i < n && part[i] === ']') i++;
        var av = el.getAttribute(attr) || '';
        var q2c = caseI ? q2.toLowerCase() : q2; var avc = caseI ? av.toLowerCase() : av;
        if (op === '')  { if (avc !== q2c) return false; }
        else if (op === '^') { if (!avc.startsWith(q2c)) return false; }
        else if (op === '$') { if (!avc.endsWith(q2c)) return false; }
        else if (op === '*') { if (!avc.includes(q2c)) return false; }
        else if (op === '~') { if (!avc.split(/\s+/).includes(q2c)) return false; }
        else if (op === '|') { if (avc !== q2c && !avc.startsWith(q2c + '-')) return false; }
      }
    }
    else if (c === ':') {
      i++; var pseudo = ''; while (i < n && _isIdent(part[i])) pseudo += part[i++];
      var arg = ''; if (i < n && part[i] === '(') { i++; while (i < n && part[i] !== ')') arg += part[i++]; if (i < n) i++; }
      if (!_matchPseudo(pseudo, arg, el)) return false;
    }
    else { break; } // stop on unknown
  }
  return true;
}

function _matchPseudo(pseudo: string, _arg: string, el: VElement): boolean {
  var siblings = () => el.parentNode ? el.parentNode.childNodes.filter(c => c instanceof VElement) as VElement[] : [el];
  var sibsOfType = () => el.parentNode ? el.parentNode.childNodes.filter(c => c instanceof VElement && (c as VElement).tagName === el.tagName) as VElement[] : [el];
  // Helper: parse an+b → match index (1-based)
  function nthMatch(arg: string, index: number): boolean {
    var s = arg.trim().toLowerCase();
    if (s === 'odd')  { return index % 2 === 1; }
    if (s === 'even') { return index % 2 === 0; }
    var plain = parseInt(s, 10);
    if (!isNaN(plain) && s.indexOf('n') < 0) return index === plain;
    // Parse `An+B`, `An-B`, `-n+B`, `n`, `n+B`, etc.
    var m = s.match(/^(-?\d*)\s*n\s*([+-]\s*\d+)?$/);
    if (m) {
      var a = m[1] === '' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
      var bStr = m[2] ? m[2].replace(/\s/g, '') : '0';
      var b = parseInt(bStr, 10); if (isNaN(b)) b = 0;
      if (a === 0) return index === b;
      var rem = (index - b); return rem % a === 0 && rem / a >= 0;
    }
    return false;
  }
  if (pseudo === 'first-child')    return siblings()[0] === el;
  if (pseudo === 'last-child')     return siblings()[siblings().length - 1] === el;
  if (pseudo === 'only-child')     return siblings().length === 1;
  if (pseudo === 'nth-child')      { var ss = siblings(); return nthMatch(_arg, ss.indexOf(el) + 1); }
  if (pseudo === 'nth-last-child') { var ss = siblings(); return nthMatch(_arg, ss.length - ss.indexOf(el)); }
  if (pseudo === 'first-of-type')  return sibsOfType()[0] === el;
  if (pseudo === 'last-of-type')   { var st = sibsOfType(); return st[st.length - 1] === el; }
  if (pseudo === 'only-of-type')   return sibsOfType().length === 1;
  if (pseudo === 'nth-of-type')    { var st = sibsOfType(); return nthMatch(_arg, st.indexOf(el) + 1); }
  if (pseudo === 'nth-last-of-type') { var st = sibsOfType(); return nthMatch(_arg, st.length - st.indexOf(el)); }
  if (pseudo === 'empty')          return el.childNodes.filter(c => c.nodeType === 1 || (c.nodeType === 3 && (c as any).data?.trim())).length === 0;
  if (pseudo === 'checked')        return el.checked;
  if (pseudo === 'disabled')       return el.disabled;
  if (pseudo === 'enabled')        return !el.disabled;
  if (pseudo === 'required')       return el.hasAttribute('required');
  if (pseudo === 'optional')       return !el.hasAttribute('required');
  if (pseudo === 'valid')          return el.checkValidity();
  if (pseudo === 'invalid')        return !el.checkValidity();
  if (pseudo === 'placeholder-shown') { var tag2 = el.tagName.toLowerCase(); return (tag2 === 'input' || tag2 === 'textarea') && !!(el as any).value === false && el.hasAttribute('placeholder'); }
  if (pseudo === 'read-only')      return el.hasAttribute('readonly') || el.hasAttribute('disabled');
  if (pseudo === 'read-write')     return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
  if (pseudo === 'root')           return el.tagName === 'HTML';
  if (pseudo === 'target')         {
    // :target — element's id matches the URL hash
    var hash = (el.ownerDocument as any)?._locationHash ?? '';
    return !!(el.id && hash && hash.replace(/^#/, '') === el.id);
  }
  if (pseudo === 'link')           return el.tagName === 'A' && el.hasAttribute('href');
  if (pseudo === 'any-link')       return (el.tagName === 'A' || el.tagName === 'AREA') && el.hasAttribute('href');
  if (pseudo === 'visited')        return false;
  if (pseudo === 'local-link')     return (el.tagName === 'A' || el.tagName === 'AREA') && el.hasAttribute('href');
  if (pseudo === 'active')         return false;
  if (pseudo === 'hover')          return false;
  if (pseudo === 'in-range')       {
    var inTag = el.tagName.toLowerCase(); if (inTag !== 'input') return false;
    var inVal = parseFloat(el.value ?? ''); if (isNaN(inVal)) return false;
    var minA = el.getAttribute('min'); var maxA = el.getAttribute('max');
    var inMin = minA !== null ? parseFloat(minA) : -Infinity;
    var inMax = maxA !== null ? parseFloat(maxA) : Infinity;
    return inVal >= inMin && inVal <= inMax;
  }
  if (pseudo === 'out-of-range')   {
    var orTag = el.tagName.toLowerCase(); if (orTag !== 'input') return false;
    var orVal = parseFloat(el.value ?? ''); if (isNaN(orVal)) return false;
    var orMinA = el.getAttribute('min'); var orMaxA = el.getAttribute('max');
    var orMin = orMinA !== null ? parseFloat(orMinA) : -Infinity;
    var orMax = orMaxA !== null ? parseFloat(orMaxA) : Infinity;
    return orVal < orMin || orVal > orMax;
  }
  if (pseudo === 'indeterminate')  {
    var inTag2 = el.tagName.toLowerCase(); var inType = el.getAttribute('type')?.toLowerCase();
    return inTag2 === 'input' && inType === 'checkbox' && !!(el as any)._indeterminate;
  }
  if (pseudo === 'default')        return el.hasAttribute('checked') || el.hasAttribute('selected') || el.hasAttribute('default');
  if (pseudo === 'focus')          return el.ownerDocument?._activeElement === el;
  if (pseudo === 'focus-within')   { var ae = el.ownerDocument?._activeElement; return !!(ae && el.contains(ae)); }
  if (pseudo === 'focus-visible')  return el.ownerDocument?._activeElement === el;
  if (pseudo === 'not')            return !_matchSel(_arg, el);
  if (pseudo === 'is' || pseudo === 'where' || pseudo === 'matches') {
    var alts = _arg.split(',');
    return alts.some(alt => _matchSel(alt.trim(), el));
  }
  if (pseudo === 'has')            { var alts = _arg.split(','); return alts.some(alt => el.querySelectorAll(alt.trim()).length > 0); }
  if (pseudo === 'scope')          return true;  // :scope means the root element of the selector context
  if (pseudo === 'lang')           { // :lang(value) — match element's language
    var tgt = _arg.trim().toLowerCase();
    var n: any = el;
    while (n) { var l = (n._attrs as Map<string, string>)?.get('lang'); if (l !== undefined) return l.toLowerCase().startsWith(tgt); n = n.parentNode; }
    return false;
  }
  if (pseudo === 'dir')            { // :dir(ltr|rtl) — match element's directionality
    var dir = _arg.trim().toLowerCase();
    var n2: any = el;
    while (n2) { var d = (n2._attrs as Map<string, string>)?.get('dir'); if (d !== undefined) return d.toLowerCase() === dir; n2 = n2.parentNode; }
    return dir === 'ltr'; // default LTR
  }
  // pseudo-elements — don't filter elements by them
  if (pseudo === 'before' || pseudo === 'after' || pseudo === 'first-line' || pseudo === 'first-letter' || pseudo === 'selection' || pseudo === 'placeholder') return true;
  return true; // unknown pseudo — ignore
}

function _isIdent(c: string): boolean { return /[\w\-]/.test(c); }

// ── Serializer ────────────────────────────────────────────────────────────────

var _VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

export function _serialize(nodes: VNode[]): string {
  return nodes.map(n => {
    if (n instanceof VText) return _escapeText((n as VText).data);
    if (n instanceof VElement) return _serializeEl(n as VElement);
    return '';
  }).join('');
}

export function _serializeEl(el: VElement): string {
  var tag = el.tagName.toLowerCase();
  if (tag === '#fragment') return _serialize(el.childNodes);
  var attrs = '';
  el._attrs.forEach((v, k) => { attrs += ' ' + k + (v !== '' ? '="' + _escapeAttr(v) + '"' : ''); });
  // merge style
  var styleStr = el._style.cssText;
  if (styleStr) {
    var existing = el._attrs.get('style');
    if (!existing) attrs += ' style="' + _escapeAttr(styleStr) + '"';
  }
  if (_VOID.has(tag)) return '<' + tag + attrs + '>';
  return '<' + tag + attrs + '>' + _serialize(el.childNodes) + '</' + tag + '>';
}

function _escapeText(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _escapeAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

/** Serialize the document body back to an HTML string for re-parsing */
export function serializeDOM(doc: VDocument): string { return _serialize(doc.body.childNodes); }

// ── Named HTML entity table (item 350) ───────────────────────────────────────

const _HTML_ENTITIES: Record<string, string> = {
  // Basic
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // Whitespace / punctuation
  nbsp: '\u00a0', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', hellip: '\u2026', prime: '\u2032', Prime: '\u2033',
  bull: '\u2022', middot: '\u00b7', permil: '\u2030',
  // Symbols / currency
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', curren: '\u00a4',
  // Math
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3', frac12: '\u00bd',
  frac14: '\u00bc', frac34: '\u00be', micro: '\u00b5', para: '\u00b6', sect: '\u00a7',
  infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265', asymp: '\u2248',
  equiv: '\u2261', cong: '\u2245', prop: '\u221d', there4: '\u2234',
  sdot: '\u22c5', sum: '\u2211', prod: '\u220f', int: '\u222b',
  radic: '\u221a', minus: '\u2212', lowast: '\u2217', oplus: '\u2295', otimes: '\u2297',
  // Arrows
  larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193', harr: '\u2194',
  lArr: '\u21d0', uArr: '\u21d1', rArr: '\u21d2', dArr: '\u21d3', hArr: '\u21d4',
  // Shapes / specials
  spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666',
  dagger: '\u2020', Dagger: '\u2021', oline: '\u203e', frasl: '\u2044',
  // Letters with diacritics (most commonly used)
  Agrave: '\u00c0', Aacute: '\u00c1', Acirc: '\u00c2', Atilde: '\u00c3', Auml: '\u00c4', Aring: '\u00c5', AElig: '\u00c6',
  Ccedil: '\u00c7', Egrave: '\u00c8', Eacute: '\u00c9', Ecirc: '\u00ca', Euml: '\u00cb',
  Igrave: '\u00cc', Iacute: '\u00cd', Icirc: '\u00ce', Iuml: '\u00cf',
  ETH: '\u00d0', Ntilde: '\u00d1', Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5', Ouml: '\u00d6',
  Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da', Ucirc: '\u00db', Uuml: '\u00dc',
  Yacute: '\u00dd', THORN: '\u00de', szlig: '\u00df',
  agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6',
  ccedil: '\u00e7', egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  eth: '\u00f0', ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6',
  oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc',
  yacute: '\u00fd', thorn: '\u00fe', yuml: '\u00ff',
  // Greek letters
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395', Zeta: '\u0396', Eta: '\u0397',
  Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a', Lambda: '\u039b', Mu: '\u039c', Nu: '\u039d', Xi: '\u039e',
  Omicron: '\u039f', Pi: '\u03a0', Rho: '\u03a1', Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5', Phi: '\u03a6',
  Chi: '\u03a7', Psi: '\u03a8', Omega: '\u03a9',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5', zeta: '\u03b6', eta: '\u03b7',
  theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba', lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be',
  omicron: '\u03bf', pi: '\u03c0', rho: '\u03c1', sigmaf: '\u03c2', sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5',
  phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9',
  thetasym: '\u03d1', upsih: '\u03d2', piv: '\u03d6',
  // Misc
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
  fnof: '\u0192', circ: '\u02c6', tilde: '\u02dc',
  zwj: '\u200d', zwnj: '\u200c', lrm: '\u200e', rlm: '\u200f',
  forall: '\u2200', part: '\u2202', exist: '\u2203', empty: '\u2205', nabla: '\u2207',
  isin: '\u2208', notin: '\u2209', ni: '\u220b', and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a',
  sim: '\u223c', sub: '\u2282', sup: '\u2283', nsub: '\u2284', sube: '\u2286', supe: '\u2287',
  oplus2: '\u2295', image: '\u2111', real: '\u211c', weierp: '\u2118', alefsym: '\u2135',
  angle: '\u2220', and2: '\u2227', or2: '\u2228',
  lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b',
  lang: '\u27e8', rang: '\u27e9',
};

function _decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[\w]+);/gi, (_m, entity: string) => {
    if (entity[0] === '#') {
      var cp = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return isNaN(cp) ? _m : String.fromCodePoint(cp);
    }
    return _HTML_ENTITIES[entity] ?? _m;
  });
}

// ── Fragment parser (for innerHTML / insertAdjacentHTML) ──────────────────────

function _parseFragment(html: string, doc: VDocument | null): VNode[] {
  // HTML parser with raw-text element support (script/style/textarea/title)
  var _RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'noembed']);
  // Implicit self-closing: opening X closes current Y (item 359)
  var _IMPLICIT_CLOSE: Record<string, string[]> = {
    p:         ['p'],
    li:        ['li'],
    dt:        ['dt','dd'],
    dd:        ['dd','dt'],
    tr:        ['tr'],
    td:        ['td','th'],
    th:        ['th','td'],
    option:    ['option'],
    optgroup:  ['optgroup','option'],
    colgroup:  ['colgroup'],
    caption:   ['caption'],
    thead:     ['thead','tbody','tfoot'],
    tbody:     ['thead','tbody','tfoot'],
    tfoot:     ['thead','tbody','tfoot'],
  };
  var nodes: VNode[] = [];
  var stack: VElement[] = [];
  var cur = () => stack[stack.length - 1] as VElement | undefined;

  function pushText(t: string): void {
    if (!t) return;
    var vt = new VText(t); vt.ownerDocument = doc;
    var p = cur(); if (p) p.childNodes.push(vt); else nodes.push(vt); vt.parentNode = p ?? null;
  }
  function open(tag: string, attrs: Map<string, string>, self: boolean): VElement {
    // Implicit close: before opening `tag`, close tags it automatically closes (item 359)
    var _autoClose = _IMPLICIT_CLOSE[tag];
    if (_autoClose) {
      // Find the closest ancestor that would be auto-closed (only close if at same nesting)
      for (var _ac = stack.length - 1; _ac >= 0; _ac--) {
        if (_autoClose.includes(stack[_ac].tagName.toLowerCase())) { stack.splice(_ac); break; }
        // Stop looking if we hit a block-level boundary (table/ul/ol/dl/select)
        var _bt = stack[_ac].tagName.toLowerCase();
        if (/^(table|ul|ol|dl|select|div|article|section|aside|main|nav|header|footer|body)$/.test(_bt)) break;
      }
    }
    var el = new VElement(tag); el.ownerDocument = doc;
    attrs.forEach((v, k) => el._attrs.set(k, v));
    var p = cur(); if (p) { el.parentNode = p; p.childNodes.push(el); } else { nodes.push(el); }
    if (!self && !_VOID.has(tag)) stack.push(el);
    return el;
  }
  function close(tag: string): void {
    for (var k = stack.length - 1; k >= 0; k--) { if (stack[k].tagName === tag.toUpperCase()) { stack.splice(k); return; } }
  }

  // Parse a tag token starting at position `pos` (after '<'), return [tagName, attrMap, isClose, isSelf, endIndex]
  function parseTag(pos: number): [string, Map<string, string>, boolean, boolean, number] | null {
    // Find tag end, respecting quoted attribute values
    var j = pos; var inQ = ''; var endIdx = -1;
    while (j < html.length) {
      var c = html[j];
      if (inQ) { if (c === inQ) inQ = ''; j++; continue; }
      if (c === '"' || c === "'") { inQ = c; j++; continue; }
      if (c === '>') { endIdx = j; break; }
      j++;
    }
    if (endIdx < 0) return null;
    var inner = html.slice(pos, endIdx).trim();
    if (inner.startsWith('!') || inner.startsWith('?')) return ['', new Map(), false, false, endIdx + 1];
    var isClose = inner.startsWith('/'); if (isClose) inner = inner.slice(1).trimStart();
    var isSelf  = inner.endsWith('/'); if (isSelf) inner = inner.slice(0, -1);
    var tagM = inner.match(/^([\w-]+)(.*)/s);
    if (!tagM) return ['', new Map(), false, false, endIdx + 1];
    var tagName = tagM[1].toLowerCase(); var attrStr = tagM[2];
    var amap = new Map<string, string>();
    var ar = /\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g; var am: RegExpExecArray | null;
    while ((am = ar.exec(attrStr)) !== null) amap.set(am[1].toLowerCase(), _decodeEntities(am[2] ?? am[3] ?? am[4] ?? ''));
    return [tagName, amap, isClose, isSelf, endIdx + 1];
  }

  var i = 0; var n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      var res = parseTag(i + 1); if (!res) break;
      var [tagName, amap, isClose, isSelf, nextI] = res;
      i = nextI;
      if (!tagName) continue; // comment/PI
      if (isClose) { close(tagName); }
      else {
        var el = open(tagName, amap, isSelf);
        // Raw-text element: consume until </tagName>
        if (!isSelf && _RAW_TEXT.has(tagName)) {
          var closeTag = '</' + tagName; var ci = html.toLowerCase().indexOf(closeTag, i);
          var rawContent = ci >= 0 ? html.slice(i, ci) : html.slice(i);
          if (rawContent) {
            var vt = new VText(rawContent); vt.ownerDocument = doc; vt.parentNode = el; el.childNodes.push(vt);
          }
          i = ci >= 0 ? ci : html.length;
          // pop stack entry for this raw-text element
          var si = stack.indexOf(el); if (si >= 0) stack.splice(si);
          // skip the close tag
          if (ci >= 0) {
            var cend = html.indexOf('>', i); i = cend >= 0 ? cend + 1 : html.length;
          }
        }
      }
    } else {
      var start = i; while (i < n && html[i] !== '<') i++;
      var raw = html.slice(start, i);
      raw = _decodeEntities(raw);
      pushText(raw);
    }
  }
  return nodes;
}

// ── DOM builder from full HTML string ─────────────────────────────────────────

export function buildDOM(html: string): VDocument {
  var doc  = new VDocument();
  // We inject content directly into body/head based on where tags appear
  var frag = _parseFragment(html, doc);

  // Redistribute: find <html>/<head>/<body> wrapper if present, else dump into body
  var htmlEl = frag.find(n => n instanceof VElement && (n as VElement).tagName === 'HTML') as VElement | undefined;
  if (htmlEl) {
    for (var c of htmlEl.childNodes) {
      if (c instanceof VElement) {
        if (c.tagName === 'HEAD') { for (var hc of c.childNodes) { hc.parentNode = doc.head; hc.ownerDocument = doc; doc.head.childNodes.push(hc); } }
        else if (c.tagName === 'BODY') { for (var bc of c.childNodes) { bc.parentNode = doc.body; bc.ownerDocument = doc; doc.body.childNodes.push(bc); } }
      }
    }
  } else {
    // no wrapper — everything goes in body, except <head> contents
    var inHead = false;
    for (var node of frag) {
      if (node instanceof VElement && node.tagName === 'HEAD') {
        inHead = true; for (var hc2 of node.childNodes) { hc2.parentNode = doc.head; hc2.ownerDocument = doc; doc.head.childNodes.push(hc2); } continue;
      }
      if (node instanceof VElement && node.tagName === 'BODY') {
        inHead = false; for (var bc2 of node.childNodes) { bc2.parentNode = doc.body; bc2.ownerDocument = doc; doc.body.childNodes.push(bc2); } continue;
      }
      if (!inHead) { node.parentNode = doc.body; node.ownerDocument = doc; doc.body.childNodes.push(node); }
    }
  }

  // Extract <title>
  var titles = doc.head.getElementsByTagName('title');
  if (titles[0]) doc._title = titles[0].textContent;

  return doc;
}

// ── Event performance optimizations ──────────────────────────────────────────

/** [Item 955] EventDelegator — attach a single listener to a root element and
 *  route events to handlers registered for CSS selectors.  Much cheaper than
 *  one listener per leaf node. */
export class EventDelegator {
  private _root: VElement;
  private _handlers: Array<{ selector: string; handler: (evt: VEvent, target: VElement) => void }> = [];

  constructor(root: VElement) { this._root = root; }

  /** Register `handler` for all elements under the root matching `selector`. */
  on(selector: string, handler: (evt: VEvent, target: VElement) => void): this {
    this._handlers.push({ selector, handler });
    return this;
  }

  /** Dispatch an event through the delegator.  Walk the event path from
   *  `target` upward to the root; the first matching selector wins. */
  dispatch(evt: VEvent, target: VElement): void {
    var node: VElement | null = target;
    while (node && node !== (this._root.parentNode as VElement | null)) {
      var n = node;
      for (var i = 0; i < this._handlers.length; i++) {
        var entry = this._handlers[i];
        if (this._root.querySelectorAll(entry.selector).indexOf(n) !== -1) {
          entry.handler(evt, n);
          if ((evt as any)._stopProp) return;
        }
      }
      node = n.parentNode instanceof VElement ? n.parentNode : null;
    }
  }

  /** Remove all delegated handlers. */
  off(): void { this._handlers = []; }
}

/** [Item 960] PassiveEventRegistry — track whether each event listener was
 *  registered with the `passive` option.  Passive listeners may not call
 *  `preventDefault()`.  This lets the engine skip cancelability checks and
 *  start scrolling/painting without waiting for the listener to return. */
export class PassiveEventRegistry {
  /** Map of listener function → is-passive flag. */
  private _map: Map<Function, boolean> = new Map();

  /** Register a listener with its passive flag. */
  register(listener: Function, passive: boolean): void {
    this._map.set(listener, passive);
  }

  /** Unregister a listener. */
  unregister(listener: Function): void { this._map.delete(listener); }

  /** Return true if `listener` is passive (i.e. may not call preventDefault). */
  isPassive(listener: Function): boolean {
    return this._map.get(listener) ?? false;
  }

  /** Invoke `listener` with `evt`, enforcing the passive contract. */
  invoke(listener: Function, evt: VEvent): void {
    var passive = this.isPassive(listener);
    if (passive) {
      // Stub out preventDefault so the listener cannot cancel the event
      var origPreventDefault = (evt as any).preventDefault;
      (evt as any).preventDefault = function() {
        // no-op — passive listener may not cancel
      };
      try { listener(evt); }
      finally { (evt as any).preventDefault = origPreventDefault; }
    } else {
      listener(evt);
    }
  }
}

/** Shared passive event registry used by VElement.addEventListener when the
 *  `passive` option is specified. */
export const passiveEventRegistry = new PassiveEventRegistry();
