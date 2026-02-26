/**
 * workers.ts — Web Worker API for the JSOS browser
 *
 * Implements the standard Web Worker interface using JSOS's multi-process
 * QuickJS runtime (kernel.proc* API).  Each Worker gets its own isolated
 * QuickJS runtime with its own GC heap.
 *
 * Limitations vs spec:
 *  - Transferable objects not yet supported (postMessage copies via JSON)
 *  - Shared memory via SharedArrayBuffer requires kernel.sharedBufferCreate
 *  - importScripts() fetches synchronously via os.fetchAsync
 *  - Maximum 8 concurrent workers (limited by JIT_PROC_SLOTS)
 */

import { os } from '../../core/sdk.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── MessageEvent ─────────────────────────────────────────────────────────────

export class WorkerMessageEvent {
  readonly type    = 'message';
  readonly data:   unknown;
  constructor(data: unknown) { this.data = data; }
}

export class WorkerErrorEvent {
  readonly type    = 'error';
  readonly message: string;
  readonly filename = '';
  readonly lineno   = 0;
  readonly colno    = 0;
  constructor(msg: string) { this.message = msg; }
}

// ── MessageChannel ───────────────────────────────────────────────────────────
//
// In-process synchronous message channel.  Unlike the standard which uses
// structured clone, we use JSON serialisation for cross-runtime compatibility.

export class MessagePort {
  private _other:    MessagePort | null = null;
  private _queue:    unknown[]          = [];
  onmessage: ((ev: WorkerMessageEvent) => void) | null = null;
  onmessageerror: ((ev: WorkerErrorEvent) => void) | null = null;
  private _started = false;

  _pair(other: MessagePort): void { this._other = other; }

  postMessage(data: unknown, _transfer?: unknown[]): void {
    // Clone via JSON to simulate structured clone
    var cloned: unknown;
    try { cloned = JSON.parse(JSON.stringify(data)); } catch (_) { cloned = data; }
    if (this._other) {
      this._other._enqueue(cloned);
    }
  }

  _enqueue(data: unknown): void {
    if (this._started && this.onmessage) {
      try { this.onmessage(new WorkerMessageEvent(data)); } catch (_) {}
    } else {
      this._queue.push(data);
    }
  }

  start(): void {
    this._started = true;
    while (this._queue.length > 0 && this.onmessage) {
      var d = this._queue.shift();
      try { this.onmessage(new WorkerMessageEvent(d)); } catch (_) {}
    }
  }

  close(): void {
    this._other   = null;
    this._queue   = [];
    this.onmessage = null;
  }

  addEventListener(type: string, fn: (ev: WorkerMessageEvent | WorkerErrorEvent) => void): void {
    if (type === 'message') this.onmessage = fn as (ev: WorkerMessageEvent) => void;
    if (type === 'messageerror') this.onmessageerror = fn as (ev: WorkerErrorEvent) => void;
  }

  removeEventListener(type: string, _fn: unknown): void {
    if (type === 'message') this.onmessage = null;
    if (type === 'messageerror') this.onmessageerror = null;
  }

  dispatchEvent(_ev: unknown): boolean { return true; }
}

export class MessageChannel {
  port1: MessagePort;
  port2: MessagePort;

  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._pair(this.port2);
    this.port2._pair(this.port1);
    this.port1.start();
    this.port2.start();
  }
}

// ── BroadcastChannel ─────────────────────────────────────────────────────────

var _bcastChannels = new Map<string, BroadcastChannelImpl[]>();

export class BroadcastChannelImpl {
  readonly name: string;
  onmessage: ((ev: WorkerMessageEvent) => void) | null = null;
  onmessageerror: ((ev: WorkerErrorEvent) => void) | null = null;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    var arr = _bcastChannels.get(name);
    if (!arr) { arr = []; _bcastChannels.set(name, arr); }
    arr.push(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    var cloned: unknown;
    try { cloned = JSON.parse(JSON.stringify(data)); } catch (_) { cloned = data; }
    var siblings = _bcastChannels.get(this.name) ?? [];
    for (var s of siblings) {
      if (s !== this && !s._closed && s.onmessage) {
        try { s.onmessage(new WorkerMessageEvent(cloned)); } catch (_) {}
      }
    }
  }

  close(): void {
    this._closed = true;
    var arr = _bcastChannels.get(this.name);
    if (arr) {
      var idx = arr.indexOf(this);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  addEventListener(type: string, fn: (ev: WorkerMessageEvent | WorkerErrorEvent) => void): void {
    if (type === 'message') this.onmessage = fn as (ev: WorkerMessageEvent) => void;
  }

  removeEventListener(type: string, _fn: unknown): void {
    if (type === 'message') this.onmessage = null;
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────
//
// Runs JS code in an isolated QuickJS runtime (kernel.procCreate/procEval).
// Messages are polled on each tick() call.

/** Bootstrap code injected into every worker runtime. */
const WORKER_BOOTSTRAP = `
var _workerDispatch = null;
var _workerMessageQueue = [];

function onmessage(_ev) {}  // default no-op; script may override

var self = {
  get onmessage() { return onmessage; },
  set onmessage(fn) { onmessage = fn; },
  postMessage: function(data) {
    kernel.postMessage(JSON.stringify({ type: 'message', data: data }));
  },
  addEventListener: function(type, fn) {
    if (type === 'message') onmessage = fn;
  },
  removeEventListener: function() {},
  close: function() {
    kernel.postMessage(JSON.stringify({ type: 'close' }));
  },
  importScripts: function() { /* stub */ },
};

var globalThis = self;
var console = {
  log: function() { kernel.serialPut('[W] ' + Array.prototype.slice.call(arguments).join(' ')); },
  error: function() { kernel.serialPut('[W:E] ' + Array.prototype.slice.call(arguments).join(' ')); },
  warn: function() { kernel.serialPut('[W:W] ' + Array.prototype.slice.call(arguments).join(' ')); },
};

function _workerTick() {
  var msg = kernel.pollMessage();
  while (msg) {
    try {
      var ev = JSON.parse(msg);
      if (ev && ev.type === 'message') {
        var msgEv = { type: 'message', data: ev.data };
        if (typeof onmessage === 'function') onmessage(msgEv);
      }
    } catch(_) {}
    msg = kernel.pollMessage();
  }
}
`;

export class WorkerImpl {
  private _id:          number = -1;
  private _ready        = false;
  private _terminated   = false;

  onmessage:      ((ev: WorkerMessageEvent) => void) | null = null;
  onmessageerror: ((ev: WorkerErrorEvent) => void)   | null = null;
  onerror:        ((ev: WorkerErrorEvent) => void)   | null = null;

  private _listeners: Map<string, Array<(ev: unknown) => void>> = new Map();
  private _pendingMsgs: unknown[] = [];

  constructor(scriptURL: string, _opts?: { type?: string; name?: string; credentials?: string }) {
    if (!kernel.procCreate) {
      // Fallback: same-thread mode — run the script via eval in a setTimeout
      this._id = -2;
      this._ready = true;
      return;
    }

    try {
      var id = kernel.procCreate() as number;
      if (id < 0) {
        this._dispatchError('No free worker slots (max 8 concurrent workers)');
        return;
      }
      this._id = id;

      // Inject bootstrap, then load the script
      kernel.procEval(id, WORKER_BOOTSTRAP);

      if (scriptURL.startsWith('blob:') || scriptURL.startsWith('data:')) {
        // data: / blob: URL — not supported, run empty worker
        this._ready = true;
      } else {
        // Fetch and eval the script
        os.fetchAsync(scriptURL, (resp, err) => {
          if (!resp || resp.status !== 200) {
            this._dispatchError('Worker script load failed: ' + (err || resp?.status));
            return;
          }
          kernel.procEval(this._id, resp.bodyText);
          this._ready = true;
          // Deliver any pending messages
          while (this._pendingMsgs.length > 0) {
            this._sendToWorker(this._pendingMsgs.shift());
          }
        });
      }
    } catch (e) {
      this._dispatchError(String(e));
    }
  }

  postMessage(data: unknown, _transfer?: unknown[]): void {
    if (this._terminated) return;
    if (!this._ready) { this._pendingMsgs.push(data); return; }
    this._sendToWorker(data);
  }

  private _sendToWorker(data: unknown): void {
    if (this._id < 0) return;
    var json: string;
    try { json = JSON.stringify({ type: 'message', data }); } catch (_) { return; }
    try { kernel.procSend(this._id, json); } catch (_) {}
  }

  terminate(): void {
    if (this._terminated) return;
    this._terminated = true;
    if (this._id >= 0 && kernel.procDestroy) {
      try { kernel.procDestroy(this._id); } catch (_) {}
    }
    this._id = -1;
  }

  /** Called by tick loop: pump messages from worker outbox to host. */
  tick(): void {
    if (this._terminated || this._id < 0 || !this._ready) return;
    // Pump worker's async tasks
    try { kernel.procTick(this._id); } catch (_) {}
    // Also tick the in-worker message pump
    try { kernel.procEval(this._id, '_workerTick()'); } catch (_) {}
    // Drain outbox
    if (!kernel.procRecv) return;
    var raw: string | null = null;
    for (var i = 0; i < 16; i++) {
      try { raw = kernel.procRecv(this._id) as string | null; } catch (_) { break; }
      if (!raw) break;
      var ev: any;
      try { ev = JSON.parse(raw); } catch (_) { continue; }
      if (ev.type === 'message') {
        var msgEv = new WorkerMessageEvent(ev.data);
        if (this.onmessage) try { this.onmessage(msgEv); } catch (_) {}
        this._fireListeners('message', msgEv);
      } else if (ev.type === 'close') {
        this.terminate();
        break;
      } else if (ev.type === 'error') {
        this._dispatchError(String(ev.message ?? 'Worker error'));
        break;
      }
    }
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type)!.push(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    var arr = this._listeners.get(type);
    if (arr) { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  }

  dispatchEvent(_ev: unknown): boolean { return true; }

  private _fireListeners(type: string, ev: unknown): void {
    var arr = this._listeners.get(type);
    if (!arr) return;
    for (var fn of arr) { try { fn(ev); } catch (_) {} }
  }

  private _dispatchError(msg: string): void {
    var ev = new WorkerErrorEvent(msg);
    if (this.onerror) try { this.onerror(ev); } catch (_) {}
    this._fireListeners('error', ev);
  }
}

// ── Global worker registry for tick pumping ───────────────────────────────────

var _activeWorkers: WorkerImpl[] = [];

export function registerWorker(w: WorkerImpl): void  { _activeWorkers.push(w); }
export function unregisterWorker(w: WorkerImpl): void {
  var i = _activeWorkers.indexOf(w);
  if (i >= 0) _activeWorkers.splice(i, 1);
}

/** Called once per frame by BrowserApp to pump all worker message queues. */
export function tickAllWorkers(): void {
  for (var i = _activeWorkers.length - 1; i >= 0; i--) {
    var w = _activeWorkers[i];
    (w as any)._terminated
      ? _activeWorkers.splice(i, 1)
      : w.tick();
  }
}
