/**
 * dom.ts — Minimal virtual DOM for JSOS browser JavaScript support
 *
 * Provides:
 *   buildDOM(html) → VDocument  (parse HTML string into VNode tree)
 *   serializeDOM(doc) → string  (serialize body back to HTML for re-parse)
 *   Full DOM API surface: VElement, VDocument, VEvent, CSS style proxy, classList
 *   CSS selector engine: #id .class tag [attr] compound descendant child comma
 */

// ── Events ────────────────────────────────────────────────────────────────────

export class VEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented = false;
  target: VNode | null = null;
  currentTarget: VNode | null = null;
  _stopProp = false;
  _data: Record<string, unknown> = {};   // extra data for input/change etc.

  constructor(type: string, init?: { bubbles?: boolean; cancelable?: boolean }) {
    this.type      = type;
    this.bubbles   = init?.bubbles    ?? true;
    this.cancelable= init?.cancelable ?? true;
  }
  preventDefault():            void { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation():           void { this._stopProp = true; }
  stopImmediatePropagation(): void { this._stopProp = true; }
}

// ── VNode base ────────────────────────────────────────────────────────────────

export class VNode {
  nodeType = 1;
  nodeName = '';
  parentNode: VNode | null = null;
  childNodes: VNode[] = [];
  ownerDocument: VDocument | null = null;
  _handlers: Map<string, Array<(e: VEvent) => void>> = new Map();

  get firstChild():      VNode | null { return this.childNodes[0] ?? null; }
  get lastChild():       VNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling():     VNode | null { var i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : -1; return i >= 0 ? (this.parentNode!.childNodes[i + 1] ?? null) : null; }
  get previousSibling(): VNode | null { var i = this.parentNode ? this.parentNode.childNodes.indexOf(this) : -1; return i > 0  ? (this.parentNode!.childNodes[i - 1] ?? null) : null; }

  appendChild(child: VNode): VNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    if (this.ownerDocument) this.ownerDocument._dirty = true;
    return child;
  }
  removeChild(child: VNode): VNode {
    var i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; if (this.ownerDocument) this.ownerDocument._dirty = true; }
    return child;
  }
  insertBefore(newNode: VNode, ref: VNode | null): VNode {
    if (!ref) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    var i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(newNode);
    newNode.parentNode = this; newNode.ownerDocument = this.ownerDocument;
    this.childNodes.splice(i, 0, newNode);
    if (this.ownerDocument) this.ownerDocument._dirty = true;
    return newNode;
  }
  replaceChild(newNode: VNode, oldNode: VNode): VNode {
    var i = this.childNodes.indexOf(oldNode);
    if (i < 0) return oldNode;
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    oldNode.parentNode = null; newNode.parentNode = this; newNode.ownerDocument = this.ownerDocument;
    this.childNodes[i] = newNode;
    if (this.ownerDocument) this.ownerDocument._dirty = true;
    return oldNode;
  }
  cloneNode(deep = false): VNode {
    var c = new VNode(); (c as any).nodeType = this.nodeType; (c as any).nodeName = this.nodeName;
    if (deep) { for (var ch of this.childNodes) { var cc = ch.cloneNode(true); cc.parentNode = c; c.childNodes.push(cc); } }
    return c;
  }
  addEventListener(type: string, fn: (e: VEvent) => void): void {
    var arr = this._handlers.get(type); if (!arr) { arr = []; this._handlers.set(type, arr); }
    if (!arr.includes(fn)) arr.push(fn);
  }
  removeEventListener(type: string, fn: (e: VEvent) => void): void {
    var arr = this._handlers.get(type); if (arr) { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  }
  dispatchEvent(ev: VEvent): boolean {
    ev.target = this; this._fireList(ev);
    if (ev.bubbles && !ev._stopProp && this.parentNode) {
      var cur: VNode | null = this.parentNode;
      while (cur && !ev._stopProp) { ev.currentTarget = cur; cur._fireList(ev); cur = cur.parentNode; }
    }
    return !ev.defaultPrevented;
  }
  _fireList(ev: VEvent): void {
    ev.currentTarget = this;
    var arr = this._handlers.get(ev.type);
    if (arr) { for (var fn of [...arr]) { try { fn(ev); } catch(_) {} if (ev._stopProp) break; } }
  }
  get textContent(): string {
    if (this.nodeType === 3) return (this as any).data || '';
    return this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v) { var t = new VText(v); t.parentNode = this; t.ownerDocument = this.ownerDocument; this.childNodes.push(t); }
    if (this.ownerDocument) this.ownerDocument._dirty = true;
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
}

// ── VText ─────────────────────────────────────────────────────────────────────

export class VText extends VNode {
  nodeType = 3; nodeName = '#text'; data: string;
  constructor(d: string) { super(); this.data = d; }
  cloneNode(_deep = false): VText { return new VText(this.data); }
}

// ── VStyleMap + proxy ─────────────────────────────────────────────────────────

export class VStyleMap {
  _map: Map<string, string> = new Map();
  _owner: VElement;
  constructor(owner: VElement) { this._owner = owner; }
  setProperty(prop: string, val: string): void { this._map.set(prop.trim(), val.trim()); if (this._owner.ownerDocument) this._owner.ownerDocument._dirty = true; }
  getPropertyValue(prop: string): string { return this._map.get(prop.trim()) || ''; }
  removeProperty(prop: string): void { this._map.delete(prop.trim()); if (this._owner.ownerDocument) this._owner.ownerDocument._dirty = true; }
  get cssText(): string { var p: string[] = []; this._map.forEach((v, k) => p.push(k + ':' + v)); return p.join(';'); }
  set cssText(v: string) {
    this._map.clear();
    v.split(';').forEach(p => { var ci = p.indexOf(':'); if (ci >= 0) this._map.set(p.slice(0, ci).trim(), p.slice(ci + 1).trim()); });
    if (this._owner.ownerDocument) this._owner.ownerDocument._dirty = true;
  }
}

function _jsToCss(js: string): string { return js.replace(/[A-Z]/g, m => '-' + m.toLowerCase()); }

export function makeStyleProxy(sm: VStyleMap): any {
  return new Proxy(sm, {
    get(t: any, k: string) { if (typeof (t as any)[k] !== 'undefined' && (k === '_map' || k === '_owner' || k === 'setProperty' || k === 'getPropertyValue' || k === 'removeProperty' || k === 'cssText')) return (t as any)[k]; return t.getPropertyValue(_jsToCss(k)); },
    set(t: any, k: string, v: string) { if (k === 'cssText') { t.cssText = v; return true; } t.setProperty(_jsToCss(k), v); return true; },
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
  replace(old: string, n: string): void { var a = this._clss(); var i = a.indexOf(old); if (i >= 0) { a[i] = n; this._set(a); } }
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

export class VElement extends VNode {
  tagName:   string;
  _attrs:    Map<string, string> = new Map();
  style:     any;        // Proxy to VStyleMap
  _style:    VStyleMap;
  classList: VClassList;
  _onHandlers: Record<string, ((e: VEvent) => void) | null> = {};

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
  get hidden():    boolean { var s = this._style._map.get('display'); return s === 'none' || this._attrs.has('hidden'); }
  set hidden(v: boolean)  { if (v) this._style.setProperty('display', 'none'); else this._style.removeProperty('display'); }
  get title():     string  { return this._attrs.get('title') || ''; }  set title(v: string)     { this.setAttribute('title', v); }
  get placeholder(): string { return this._attrs.get('placeholder') || ''; }

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
  setAttribute(name: string, value: string): void { this._attrs.set(name.toLowerCase(), String(value)); if (this.ownerDocument) this.ownerDocument._dirty = true; }
  removeAttribute(name: string): void { this._attrs.delete(name.toLowerCase()); if (this.ownerDocument) this.ownerDocument._dirty = true; }
  hasAttribute(name: string): boolean { return this._attrs.has(name.toLowerCase()); }
  getAttributeNames(): string[] { return [...this._attrs.keys()]; }
  toggleAttribute(name: string, force?: boolean): boolean {
    if (force === true || (force === undefined && !this.hasAttribute(name))) { this.setAttribute(name, ''); return true; }
    this.removeAttribute(name); return false;
  }

  get innerHTML(): string { return _serialize(this.childNodes); }
  set innerHTML(html: string) {
    this.childNodes = [];
    if (html) {
      var frag = _parseFragment(html, this.ownerDocument);
      for (var c of frag) { c.parentNode = this; c.ownerDocument = this.ownerDocument; }
      this.childNodes = frag;
    }
    if (this.ownerDocument) this.ownerDocument._dirty = true;
  }
  get outerHTML(): string { return _serializeEl(this); }
  set outerHTML(html: string) {
    if (!this.parentNode) return;
    var frag = _parseFragment(html, this.ownerDocument);
    for (var n of frag) this.parentNode.insertBefore(n, this);
    this.parentNode.removeChild(this);
  }
  insertAdjacentHTML(pos: string, html: string): void {
    var frag = _parseFragment(html, this.ownerDocument);
    if (pos === 'beforeend') { for (var n of frag) this.appendChild(n); }
    else if (pos === 'afterbegin') { for (var n2 of frag.reverse()) this.insertBefore(n2, this.firstChild); }
    else if (this.parentNode) {
      for (var n3 of (pos === 'beforebegin' ? frag : frag)) {
        if (pos === 'beforebegin') this.parentNode.insertBefore(n3, this);
        else this.parentNode.insertBefore(n3, this.nextSibling);
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
  focus(): void { /* visual focus managed by BrowserApp */ }
  blur(): void {}
  click(): void { this.dispatchEvent(new VEvent('click')); }
  submit(): void { this.dispatchEvent(new VEvent('submit')); }

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

  // ── dataset: data-* attribute access ─────────────────────────────────────────

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

  attachShadow(_opts: { mode: string }): VElement { return this; }

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
}

// ── VDocument ─────────────────────────────────────────────────────────────────

export class VDocument extends VNode {
  nodeType = 9; nodeName = '#document';
  _title = '';
  _dirty = false;
  _cookie = '';
  head: VElement;
  body: VElement;
  documentElement: VElement;

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
  createDocumentFragment(): VElement { var f = new VElement('#fragment'); f.ownerDocument = this; return f; }

  getElementById(id: string): VElement | null { var res: VElement | null = null; _walk(this.body, el => { if (!res && el.id === id) res = el; }); if (!res) _walk(this.head, el => { if (!res && el.id === id) res = el; }); return res; }
  querySelector(sel: string): VElement | null { return this.body.querySelector(sel) ?? this.head.querySelector(sel); }
  querySelectorAll(sel: string): VElement[] { return [...this.head.querySelectorAll(sel), ...this.body.querySelectorAll(sel)]; }
  getElementsByTagName(tag: string): VElement[] { return this.body.getElementsByTagName(tag); }
  getElementsByClassName(cls: string): VElement[] { return this.body.getElementsByClassName(cls); }
  getElementsByName(name: string): VElement[] { var res: VElement[] = []; _walk(this.body, el => { if (el.getAttribute('name') === name) res.push(el); }); return res; }

  write(html: string): void { this.body.innerHTML += html; }
  writeln(html: string): void { this.write(html + '\n'); }
  // Stubs
  createComment(data: string): VNode { var n = new VNode(); (n as any).nodeType = 8; (n as any).data = data; n.ownerDocument = this; return n; }
  hasFocus(): boolean { return true; }
  execCommand(_cmd: string, _show?: boolean, _val?: string): boolean { return false; }
  getSelection(): null { return null; }
  createRange(): any { return { selectNodeContents() {}, collapse() {}, toString() { return ''; }, commonAncestorContainer: null }; }
  importNode(node: VNode, deep = false): VNode { return node.cloneNode(deep); }
  adoptNode(node: VNode): VNode { if (node.parentNode) node.parentNode.removeChild(node); node.ownerDocument = this; return node; }

  get readyState(): string { return 'complete'; }
  get activeElement(): VElement { return this.body; }
  get visibilityState(): string { return 'visible'; }
  get hidden(): boolean { return false; }

  createTreeWalker(root: VElement, _whatToShow?: number, _filter?: unknown): any {
    var nodes: VNode[] = [];
    var idx = 0;
    _walk(root, el => nodes.push(el));
    return {
      currentNode: root as VNode,
      nextNode(): VNode | null { if (idx < nodes.length) { this.currentNode = nodes[idx++]; return this.currentNode; } return null; },
      previousNode(): VNode | null { if (idx > 1) { this.currentNode = nodes[--idx - 1]; return this.currentNode; } return null; },
      firstChild(): VNode | null { return root.firstChild; },
      parentNode(): VNode | null { return null; },
    };
  }
  createNodeIterator(root: VElement, _whatToShow?: number): any { return this.createTreeWalker(root, _whatToShow); }
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
        var q2 = ''; if (i < n && (part[i] === '"' || part[i] === "'")) { var qc = part[i++]; while (i < n && part[i] !== qc) q2 += part[i++]; if (i < n) i++; } else { while (i < n && part[i] !== ']') q2 += part[i++]; }
        if (i < n && part[i] === ']') i++;
        var av = el.getAttribute(attr) || '';
        if (op === '')  { if (av !== q2) return false; }
        else if (op === '^') { if (!av.startsWith(q2)) return false; }
        else if (op === '$') { if (!av.endsWith(q2)) return false; }
        else if (op === '*') { if (!av.includes(q2)) return false; }
        else if (op === '~') { if (!av.split(/\s+/).includes(q2)) return false; }
        else if (op === '|') { if (av !== q2 && !av.startsWith(q2 + '-')) return false; }
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
  if (pseudo === 'first-child')  return siblings()[0] === el;
  if (pseudo === 'last-child')   return siblings()[siblings().length - 1] === el;
  if (pseudo === 'only-child')   return siblings().length === 1;
  if (pseudo === 'nth-child')    { var n = parseInt(_arg, 10); return siblings()[n - 1] === el; }
  if (pseudo === 'nth-last-child') { var a = siblings(); var n2 = parseInt(_arg, 10); return a[a.length - n2] === el; }
  if (pseudo === 'empty')        return el.childNodes.length === 0;
  if (pseudo === 'checked')      return el.checked;
  if (pseudo === 'disabled')     return el.disabled;
  if (pseudo === 'not')          return !_matchSel(_arg, el);
  if (pseudo === 'focus')        return false; // we don't track real focus on VElement
  if (pseudo === 'hover')        return false;
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

// ── Fragment parser (for innerHTML / insertAdjacentHTML) ──────────────────────

function _parseFragment(html: string, doc: VDocument | null): VNode[] {
  // minimal re-entrant parser — doesn't handle scripts/styles, just structure
  var nodes: VNode[] = [];
  var stack: VElement[] = [];
  var cur = () => stack[stack.length - 1] as VElement | undefined;

  function pushText(t: string): void {
    var vt = new VText(t); vt.ownerDocument = doc;
    var p = cur(); if (p) p.childNodes.push(vt); else nodes.push(vt); vt.parentNode = p ?? null;
  }
  function open(tag: string, attrs: Map<string, string>, self: boolean): void {
    var el = new VElement(tag); el.ownerDocument = doc;
    attrs.forEach((v, k) => el._attrs.set(k, v));
    var p = cur(); if (p) { el.parentNode = p; p.childNodes.push(el); } else { nodes.push(el); }
    if (!self && !_VOID.has(tag)) stack.push(el);
  }
  function close(tag: string): void {
    for (var i = stack.length - 1; i >= 0; i--) { if (stack[i].tagName === tag.toUpperCase()) { stack.splice(i); return; } }
  }

  var i = 0; var n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      var end = html.indexOf('>', i); if (end < 0) break;
      var inner = html.slice(i + 1, end).trim();
      if (inner.startsWith('!') || inner.startsWith('?')) { i = end + 1; continue; }
      var isClose = inner.startsWith('/'); if (isClose) inner = inner.slice(1);
      var isSelf  = inner.endsWith('/'); if (isSelf) inner = inner.slice(0, -1);
      var tagM = inner.match(/^([\w-]+)(.*)/s);
      if (!tagM) { i = end + 1; continue; }
      var tagName = tagM[1].toLowerCase();
      var attrStr = tagM[2];
      // parse attrs
      var amap = new Map<string, string>();
      var ar = /\s+([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g; var am: RegExpExecArray | null;
      while ((am = ar.exec(attrStr)) !== null) amap.set(am[1], am[2] ?? am[3] ?? am[4] ?? '');
      if (isClose) close(tagName); else open(tagName, amap, isSelf);
      i = end + 1;
    } else {
      var start = i; while (i < n && html[i] !== '<') i++;
      var raw = html.slice(start, i);
      raw = raw.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/&#(\d+);/g, (_,nc) => String.fromCharCode(+nc)).replace(/&#x([0-9a-f]+);/gi, (_,nc) => String.fromCharCode(parseInt(nc,16)));
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
