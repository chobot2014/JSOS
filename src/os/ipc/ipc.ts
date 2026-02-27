/**
 * JSOS Inter-Process Communication
 *
 * Pipes, signals, and message queues — all in TypeScript.
 *
 * On bare-metal single-threaded QuickJS there is no true concurrency,
 * but these primitives allow JS programs to hand data between "processes"
 * (scheduler contexts), coordinate state changes, and build pipelines.
 *
 * Design:
 *  - Pipe:             byte stream buffer between two file descriptors
 *  - SignalDispatcher: POSIX-style signal delivery with handler registration
 *  - MessageQueue:     typed message passing by PID
 *  - IPCManager:       unified facade combining all primitives
 */

// ── POSIX Signal Numbers ─────────────────────────────────────────────────────
// Use SIG / SignalName from ../process/signals.ts — not duplicated here.

declare var kernel: import('../core/kernel.js').KernelAPI;
import { SIG } from '../process/signals.js';

export type SignalNumber = number;
export type SignalHandler = (signum: SignalNumber) => void;

// ── Pipe ─────────────────────────────────────────────────────────────────────

export class Pipe {
  private chunks: string[] = [];
  private _closed = false;
  readonly readFd:  number;
  readonly writeFd: number;

  constructor(readFd: number, writeFd: number) {
    this.readFd  = readFd;
    this.writeFd = writeFd;
  }

  /** Write data into the pipe. Returns false if pipe is closed. */
  write(data: string): boolean {
    if (this._closed) return false;
    this.chunks.push(data);
    return true;
  }

  /** Read all (or up to maxBytes) data from the pipe. */
  read(maxBytes?: number): string {
    if (this.chunks.length === 0) return '';
    var all = this.chunks.join('');
    if (maxBytes !== undefined && all.length > maxBytes) {
      var chunk = all.slice(0, maxBytes);
      this.chunks = [all.slice(maxBytes)];
      return chunk;
    }
    this.chunks = [];
    return all;
  }

  /** Peek at buffered data without consuming it. */
  peek(): string { return this.chunks.join(''); }

  /** Number of bytes buffered. */
  get available(): number {
    return this.chunks.reduce(function(s, c) { return s + c.length; }, 0);
  }

  close(): void { this._closed = true; }
  get isClosed(): boolean { return this._closed; }
}

// ── Signal Dispatcher ────────────────────────────────────────────────────────

export class SignalDispatcher {
  /** Registered signal handlers:  pid → (signum → handler) */
  private handlers = new Map<number, Map<SignalNumber, SignalHandler>>();
  /** Unhandled pending signals:  pid → signum[] */
  private pending  = new Map<number, SignalNumber[]>();

  /** Register a signal handler for a process. */
  handle(pid: number, signum: SignalNumber, handler: SignalHandler): void {
    if (!this.handlers.has(pid)) this.handlers.set(pid, new Map());
    this.handlers.get(pid)!.set(signum, handler);
  }

  /** Unregister a specific handler. */
  ignore(pid: number, signum: SignalNumber): void {
    var m = this.handlers.get(pid);
    if (m) m.delete(signum);
  }

  /**
   * Deliver a signal to a process.
   * If the process has a registered handler, it runs immediately (synchronous).
   * Otherwise the signal is queued for later poll().
   */
  send(pid: number, signum: SignalNumber): boolean {
    var pidHandlers = this.handlers.get(pid);
    if (pidHandlers) {
      var h = pidHandlers.get(signum);
      if (h) {
        try { h(signum); } catch(e) { /* handler threw — swallow */ }
        return true;
      }
    }
    // Default SIGKILL / SIGTERM behaviour: no handler → just queue
    if (!this.pending.has(pid)) this.pending.set(pid, []);
    this.pending.get(pid)!.push(signum);
    return true;
  }

  /** Dequeue all pending signals for a process (non-destructive for other PIDs). */
  poll(pid: number): SignalNumber[] {
    var sigs = this.pending.get(pid) || [];
    this.pending.delete(pid);
    return sigs;
  }

  /** Remove all handlers and pending signals for a process (call on exit). */
  cleanup(pid: number): void {
    this.handlers.delete(pid);
    this.pending.delete(pid);
  }
}

// ── Message Queue ────────────────────────────────────────────────────────────

export interface Message {
  type:      string;
  from:      number; // sender PID (0 = kernel)
  to:        number; // recipient PID (0 = broadcast)
  payload:   any;
  timestamp: number;
}

export class MessageQueue {
  /** Queues keyed by recipient PID. */
  private queues = new Map<number, Message[]>();

  /**
   * Send a message.  If `to` is 0 it is a broadcast to all registered queues.
   */
  send(msg: Omit<Message, 'timestamp'>): void {
    var m: Message = { type: msg.type, from: msg.from, to: msg.to, payload: msg.payload, timestamp: kernel.getUptime() };
    if (m.to === 0) {
      // Broadcast
      this.queues.forEach(function(q) { q.push(m); });
    } else {
      if (!this.queues.has(m.to)) this.queues.set(m.to, []);
      this.queues.get(m.to)!.push(m);
    }
  }

  /** Receive the next message for `pid`, optionally filtered by `type`. */
  recv(pid: number, type?: string): Message | null {
    var q = this.queues.get(pid) || [];
    if (type) {
      var idx = q.findIndex(function(m) { return m.type === type; });
      if (idx === -1) return null;
      return q.splice(idx, 1)[0];
    }
    if (q.length === 0) return null;
    var msg = q.shift()!;
    if (q.length === 0) this.queues.delete(pid);
    return msg;
  }

  /** Non-destructive look at the queue for `pid`. */
  peek(pid: number, type?: string): Message[] {
    var q = this.queues.get(pid) || [];
    return type ? q.filter(function(m) { return m.type === type; }) : q.slice();
  }

  /** Count of pending messages for `pid`. */
  available(pid: number, type?: string): number {
    return this.peek(pid, type).length;
  }

  /** Register a PID to receive broadcast messages. */
  subscribe(pid: number): void {
    if (!this.queues.has(pid)) this.queues.set(pid, []);
  }

  /** Remove all queued messages for a PID. */
  unsubscribe(pid: number): void {
    this.queues.delete(pid);
  }
}

// ── IPC Manager ──────────────────────────────────────────────────────────────

export class IPCManager {
  /** Global signal dispatcher. */
  readonly signals = new SignalDispatcher();

  /** Global message queue. */
  readonly mq = new MessageQueue();

  /** Open pipes, keyed by file descriptor. */
  private pipes  = new Map<number, Pipe>();
  private nextFd = 10; // fds 0-2 = stdio; 3-9 reserved for future stdio variants

  /**
   * Create a pipe.
   * Returns [readEnd, writeEnd] — both are the same underlying Pipe object
   * but accessed via their respective fds.
   */
  pipe(): [Pipe, Pipe] {
    var rFd = this.nextFd++;
    var wFd = this.nextFd++;
    var p = new Pipe(rFd, wFd);
    this.pipes.set(rFd, p);
    this.pipes.set(wFd, p);
    return [p, p];
  }

  /**
   * Create a named pipe (FIFO) reachable by any process with the fd.
   * Identical to pipe() but returns a single Pipe for bidirectional use.
   */
  fifo(): Pipe {
    var fd = this.nextFd++;
    var p = new Pipe(fd, fd);
    this.pipes.set(fd, p);
    return p;
  }

  getPipe(fd: number): Pipe | null {
    return this.pipes.get(fd) || null;
  }

  closePipe(fd: number): void {
    var p = this.pipes.get(fd);
    if (p) {
      // Only fully close if both ends are being released
      this.pipes.delete(fd);
      if (fd === p.readFd && !this.pipes.has(p.writeFd)) p.close();
      if (fd === p.writeFd && !this.pipes.has(p.readFd)) p.close();
    }
  }

  /** Send SIGINT to a process (Ctrl+C equivalent). */
  interrupt(pid: number): void {
    this.signals.send(pid, SIG.SIGINT);
  }

  /** Terminate a process gracefully. */
  terminate(pid: number): void {
    this.signals.send(pid, SIG.SIGTERM);
  }
}

export const ipc = new IPCManager();

// ── EventBus (pub/sub, item 207) ─────────────────────────────────────────────

export type EventHandler<T = any> = (data: T, topic: string) => void;

interface EventSubscription<T> {
  id:      number;
  topic:   string;
  handler: EventHandler<T>;
  once:    boolean;
}

/**
 * Publish-subscribe event bus.
 * Topics are strings; use '*' as a wildcard to receive all events.
 * Handlers are synchronous and called in subscription order.
 */
export class EventBus {
  private subs  = new Map<string, EventSubscription<any>[]>();
  private nextId = 1;
  readonly stats = { emitted: 0, delivered: 0, dropped: 0 };

  /**
   * Subscribe to a topic.
   * Returns a subscription ID that can be passed to off().
   *
   * Use topic '*' to receive every event regardless of topic.
   */
  on<T>(topic: string, handler: EventHandler<T>): number {
    return this._add(topic, handler, false);
  }

  /** Subscribe to exactly one event, then auto-unsubscribe. */
  once<T>(topic: string, handler: EventHandler<T>): number {
    return this._add(topic, handler, true);
  }

  private _add<T>(topic: string, handler: EventHandler<T>, once: boolean): number {
    var id   = this.nextId++;
    var sub: EventSubscription<T> = { id, topic, handler, once };
    if (!this.subs.has(topic)) this.subs.set(topic, []);
    this.subs.get(topic)!.push(sub);
    return id;
  }

  /**
   * Unsubscribe by subscription ID.
   * Returns true if found and removed.
   */
  off(id: number): boolean {
    var found = false;
    this.subs.forEach(function(list, topic, map) {
      var idx = list.findIndex(function(s) { return s.id === id; });
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) map.delete(topic);
        found = true;
      }
    });
    return found;
  }

  /**
   * Emit an event to all subscribers for `topic`, plus any wildcard ('*') subscribers.
   * Returns the number of handlers invoked.
   */
  emit<T>(topic: string, data: T): number {
    this.stats.emitted++;
    var count  = 0;
    var toCall: EventSubscription<any>[] = [];
    var direct = this.subs.get(topic);
    if (direct) toCall = toCall.concat(direct);
    var wild = this.subs.get('*');
    if (wild) toCall = toCall.concat(wild);

    var toRemove: number[] = [];
    for (var i = 0; i < toCall.length; i++) {
      var sub = toCall[i];
      try {
        sub.handler(data, topic);
        count++;
        this.stats.delivered++;
      } catch(e) {
        this.stats.dropped++;
      }
      if (sub.once) toRemove.push(sub.id);
    }
    for (var j = 0; j < toRemove.length; j++) this.off(toRemove[j]);
    return count;
  }

  /** Remove all subscriptions for a topic. */
  clearTopic(topic: string): void { this.subs.delete(topic); }

  /** Remove all subscriptions everywhere. */
  clearAll(): void { this.subs.clear(); }

  /** List all active topics. */
  topics(): string[] {
    var result: string[] = [];
    this.subs.forEach(function(_v, k) { result.push(k); });
    return result;
  }
}

export const eventBus = new EventBus();

// ── Typed Channel<T> (item 208) ──────────────────────────────────────────────

/**
 * Bounded typed channel for structured message passing between cooperating
 * JS "tasks".  Unlike MessageQueue, Channel is generic and does not require
 * PID routing.
 *
 * Push blocks (cooperative yield via kernel.sleep) when full.
 * Pull returns null immediately when empty.
 */
export class Channel<T> {
  private buf:     T[] = [];
  readonly capacity: number;
  private _closed  = false;
  readonly name:   string;

  constructor(name: string, capacity = 128) {
    this.name     = name;
    this.capacity = capacity;
  }

  /**
   * Non-blocking send.
   * Returns false if the channel is full or closed.
   */
  trySend(item: T): boolean {
    if (this._closed || this.buf.length >= this.capacity) return false;
    this.buf.push(item);
    return true;
  }

  /**
   * Blocking send — spins (kernel.sleep(1)) until space is available.
   * Returns false if closed before space became available (max 1s wait).
   */
  send(item: T): boolean {
    var deadline = kernel.getTicks() + 100; // 1 s @ 100 Hz
    while (this.buf.length >= this.capacity && !this._closed) {
      if (kernel.getTicks() >= deadline) return false;
      kernel.sleep(1);
    }
    if (this._closed) return false;
    this.buf.push(item);
    return true;
  }

  /**
   * Non-blocking receive.
   * Returns null when the channel is empty.
   */
  tryRecv(): T | null {
    return this.buf.length > 0 ? this.buf.shift()! : null;
  }

  /**
   * Blocking receive — waits up to `timeoutTicks` for an item.
   * Default timeout is 100 ticks (~1 s at 100 Hz).
   */
  recv(timeoutTicks = 100): T | null {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this.buf.length === 0 && !this._closed) {
      if (kernel.getTicks() >= deadline) return null;
      kernel.sleep(1);
    }
    return this.buf.length > 0 ? this.buf.shift()! : null;
  }

  /** Peek at the next item without removing it. */
  peek(): T | null { return this.buf.length > 0 ? this.buf[0] : null; }

  get length(): number  { return this.buf.length; }
  get isFull(): boolean { return this.buf.length >= this.capacity; }
  get isEmpty(): boolean { return this.buf.length === 0; }
  get isClosed(): boolean { return this._closed; }

  /**
   * Close the channel.  New sends will be rejected; pending items can still
   * be drained with tryRecv().
   */
  close(): void { this._closed = true; }

  /** Drain all remaining items (useful after close). */
  drain(): T[] {
    var all = this.buf.slice();
    this.buf = [];
    return all;
  }
}

// ── Named Pipes / FIFOs by path (item 209) ───────────────────────────────────

interface NamedPipeEntry {
  pipe:   Pipe;
  writer: number; // PID (-1 = any)
  reader: number; // PID (-1 = any)
}

const namedPipes = new Map<string, NamedPipeEntry>();
var namedFdCounter = 1000;

/**
 * Create a named pipe reachable by path (e.g. '/dev/pipes/logd').
 * Returns the Pipe, or null if a pipe with that path already exists.
 */
export function createNamedPipe(path: string, writer = -1, reader = -1): Pipe | null {
  if (namedPipes.has(path)) return null;
  var fd = namedFdCounter++;
  var p  = new Pipe(fd, fd);
  namedPipes.set(path, { pipe: p, writer, reader });
  return p;
}

/** Open an existing named pipe by path. Returns null if not found. */
export function openNamedPipe(path: string): Pipe | null {
  var entry = namedPipes.get(path);
  return entry ? entry.pipe : null;
}

/** Remove a named pipe. */
export function unlinkNamedPipe(path: string): boolean {
  var entry = namedPipes.get(path);
  if (!entry) return false;
  entry.pipe.close();
  namedPipes.delete(path);
  return true;
}

/** List all registered named pipe paths. */
export function listNamedPipes(): string[] {
  var result: string[] = [];
  namedPipes.forEach(function(_v, k) { result.push(k); });
  return result;
}

// ── Shared Memory (item 210) ──────────────────────────────────────────────────

interface SharedMemEntry { buf: number[]; size: number; }
const sharedMem = new Map<string, SharedMemEntry>();

/**
 * Create a named shared memory region.
 * Returns the backing byte array, or null if the name is already taken.
 *
 * QuickJS on bare metal has no real shared memory; we simulate it with a
 * plain number[] that all "processes" (closures) can reference.
 */
export function shmCreate(name: string, size: number): number[] | null {
  if (sharedMem.has(name)) return null;
  var buf = new Array<number>(size).fill(0);
  sharedMem.set(name, { buf, size });
  return buf;
}

/** Open an existing shared memory region.  Returns null if not found. */
export function shmOpen(name: string): number[] | null {
  var entry = sharedMem.get(name);
  return entry ? entry.buf : null;
}

/** Destroy a named shared memory region. */
export function shmUnlink(name: string): boolean { return sharedMem.delete(name); }

// ── Timer helpers (items 211–212) ────────────────────────────────────────────

/**
 * Cooperative sleep: suspends the calling JS task for `ms` milliseconds.
 * Uses kernel.sleep() which yields to the QEMU/hardware interrupt handler.
 */
export function sleep(ms: number): void {
  // kernel.sleep takes ticks; the tick rate is exposed via kernel.tickRateHz
  // Default: 100Hz → 1 tick = 10ms
  var ticks = Math.max(1, Math.round(ms / 10));
  kernel.sleep(ticks);
}

/** One-shot timer: calls `fn` after `ms` milliseconds (cooperative). */
export function setTimeout_ipc(fn: () => void, ms: number): void {
  var deadline = kernel.getTicks() + Math.max(1, Math.round(ms / 10));
  // Register with the global tick runner
  pendingTimers.push({ deadline, fn, repeat: false, interval: 0 });
}

/** Repeating timer: calls `fn` every `ms` milliseconds. Returns a handle. */
export function setInterval_ipc(fn: () => void, ms: number): number {
  var ticks    = Math.max(1, Math.round(ms / 10));
  var deadline = kernel.getTicks() + ticks;
  var id       = nextTimerId++;
  pendingTimers.push({ deadline, fn, repeat: true, interval: ticks, id });
  activeIntervals.set(id, pendingTimers[pendingTimers.length - 1]);
  return id;
}

/** Cancel a repeating interval. */
export function clearInterval_ipc(id: number): void {
  activeIntervals.delete(id);
  var idx = pendingTimers.findIndex(function(t) { return (t as any).id === id; });
  if (idx !== -1) pendingTimers.splice(idx, 1);
}

interface TimerEntry { deadline: number; fn: () => void; repeat: boolean; interval: number; id?: number; }
var pendingTimers:   TimerEntry[] = [];
var activeIntervals  = new Map<number, TimerEntry>();
var nextTimerId      = 1;

/**
 * Run all due timers.  Call from the main event loop / WM tick.
 */
export function tickTimers(): void {
  var now  = kernel.getTicks();
  var keep: TimerEntry[] = [];
  for (var i = 0; i < pendingTimers.length; i++) {
    var t = pendingTimers[i];
    if (now >= t.deadline) {
      try { t.fn(); } catch(e) { /* swallow */ }
      if (t.repeat && (t.id === undefined || activeIntervals.has(t.id!))) {
        keep.push({ deadline: now + t.interval, fn: t.fn, repeat: true, interval: t.interval, id: t.id });
      }
    } else {
      keep.push(t);
    }
  }
  pendingTimers = keep;
}

// ── Semaphore (item 213) ─────────────────────────────────────────────────────

/**
 * Counting semaphore (cooperative — no real blocking, just spin+yield).
 */
export class Semaphore {
  private count: number;
  readonly name: string;

  constructor(name: string, initial = 1) {
    this.name  = name;
    this.count = initial;
  }

  /**
   * Acquire (P / wait).
   * Spins via kernel.sleep(1) until count > 0.  Returns false on timeout.
   */
  acquire(timeoutTicks = 500): boolean {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this.count <= 0) {
      if (kernel.getTicks() >= deadline) return false;
      kernel.sleep(1);
    }
    this.count--;
    return true;
  }

  /** Non-blocking tryAcquire.  Returns false immediately if count == 0. */
  tryAcquire(): boolean {
    if (this.count <= 0) return false;
    this.count--;
    return true;
  }

  /** Release (V / signal). */
  release(): void { this.count++; }

  get value(): number { return this.count; }
}

// ── Mutex (item 214) ─────────────────────────────────────────────────────────

/**
 * Non-reentrant mutex.  On single-threaded QuickJS the 'owner' field
 * ensures logical exclusivity (e.g. guarding shared state across
 * async-style co-routine yields).
 */
export class Mutex {
  private _locked = false;
  private _owner  = -1;
  readonly name:  string;

  constructor(name: string) { this.name = name; }

  /**
   * Lock the mutex.
   * Returns false if lock could not be acquired within timeoutTicks.
   */
  lock(callerPid = 0, timeoutTicks = 500): boolean {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this._locked) {
      if (kernel.getTicks() >= deadline) return false;
      kernel.sleep(1);
    }
    this._locked = true;
    this._owner  = callerPid;
    return true;
  }

  /** Non-blocking tryLock. */
  tryLock(callerPid = 0): boolean {
    if (this._locked) return false;
    this._locked = true;
    this._owner  = callerPid;
    return true;
  }

  unlock(callerPid = 0): void {
    if (this._owner === callerPid || callerPid === 0) {
      this._locked = false;
      this._owner  = -1;
    }
  }

  get isLocked(): boolean { return this._locked; }
  get owner(): number     { return this._owner; }
}

// ── Condition Variable (item 215) ────────────────────────────────────────────

/**
 * Cooperative condition variable backed by a Mutex.
 */
export class CondVar {
  private waiters = 0;
  readonly name:  string;

  constructor(name: string) { this.name = name; }

  /**
   * Wait until notify() is called (or timeout expires).
   * The caller must hold `mutex`; it is released while waiting.
   */
  wait(mutex: Mutex, callerPid = 0, timeoutTicks = 500): boolean {
    mutex.unlock(callerPid);
    this.waiters++;
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this.waiters > 0 && kernel.getTicks() < deadline) {
      kernel.sleep(1);
    }
    var signalled = this.waiters === 0;
    mutex.lock(callerPid, timeoutTicks);
    return signalled;
  }

  /** Wake one waiter. */
  notify(): void {
    if (this.waiters > 0) this.waiters = Math.max(0, this.waiters - 1);
  }

  /** Wake all waiters. */
  notifyAll(): void { this.waiters = 0; }
}

// ── WaitGroup / Barrier (item 216) ───────────────────────────────────────────

/**
 * WaitGroup — tracks N running tasks; wait() blocks until all call done().
 * Analogous to sync.WaitGroup in Go.
 */
export class WaitGroup {
  private count = 0;

  add(n = 1): void { this.count += n; }
  done():      void { if (this.count > 0) this.count--; }

  wait(timeoutTicks = 1000): boolean {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this.count > 0 && kernel.getTicks() < deadline) {
      kernel.sleep(1);
    }
    return this.count === 0;
  }
}

// ── IPC Statistics / Telemetry (item 221) ────────────────────────────────────

export interface IPCStats {
  eventsEmitted:   number;
  eventsDelivered: number;
  messagesQueued:  number;
  pipesOpen:       number;
  sharedMemRegions: number;
  namedPipeCount:  number;
  timersActive:    number;
}

export function ipcStats(): IPCStats {
  return {
    eventsEmitted:    eventBus.stats.emitted,
    eventsDelivered:  eventBus.stats.delivered,
    messagesQueued:   0, // MessageQueue doesn't track totals yet
    pipesOpen:        namedPipes.size,
    sharedMemRegions: sharedMem.size,
    namedPipeCount:   namedPipes.size,
    timersActive:     pendingTimers.length,
  };
}

// ── Unix Domain Sockets (Item 209) ────────────────────────────────────────────

/** [Item 209] Connection state of a Unix domain socket. */
export type UnixSocketState = 'UNBOUND' | 'LISTENING' | 'CONNECTING' | 'CONNECTED' | 'CLOSED';

/** [Item 209] A datagram or stream Unix domain socket. */
export class UnixSocket {
  readonly path: string;
  state: UnixSocketState = 'UNBOUND';
  /** Receive buffer: chunks of data written by the peer. */
  private rxBuf: string[] = [];
  /** Peer socket, set after accept()/connect(). */
  private _peer: UnixSocket | null = null;
  /** Pending FDs shared via sendFd(). */
  private _pendingFds: number[] = [];
  /** PID of the process owning this socket. */
  readonly pid: number;

  constructor(path: string, pid: number) {
    this.path = path;
    this.pid  = pid;
  }

  /** [Item 209] Bind to a path in the abstract namespace. */
  bind(path: string): boolean {
    if (unixSocketRegistry.has(path)) return false;
    (this as any).path = path;
    unixSocketRegistry.set(path, this);
    return true;
  }

  /** [Item 209] Place the socket in the listening state. */
  listen(): void {
    if (this.state !== 'UNBOUND') return;
    this.state = 'LISTENING';
    unixAcceptQueues.set(this.path, []);
  }

  /** [Item 209] Block until a client connects; return the connected peer socket. */
  accept(timeoutTicks = 2000): UnixSocket | null {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (kernel.getTicks() < deadline) {
      var q = unixAcceptQueues.get(this.path);
      if (q && q.length > 0) {
        var client = q.shift()!;
        var serverSide = new UnixSocket(this.path, this.pid);
        serverSide.state = 'CONNECTED';
        serverSide._peer = client;
        client._peer = serverSide;
        client.state = 'CONNECTED';
        return serverSide;
      }
      kernel.sleep(1);
    }
    return null;
  }

  /** [Item 209] Connect to a listening socket at the given path. */
  connect(path: string, timeoutTicks = 1000): boolean {
    if (this.state !== 'UNBOUND') return false;
    var server = unixSocketRegistry.get(path);
    if (!server || server.state !== 'LISTENING') return false;
    this.state = 'CONNECTING';
    var q = unixAcceptQueues.get(path);
    if (!q) return false;
    q.push(this);
    // Wait for accept()
    var deadline = kernel.getTicks() + timeoutTicks;
    while (this.state !== 'CONNECTED' && kernel.getTicks() < deadline) {
      kernel.sleep(1);
    }
    return this.state === 'CONNECTED';
  }

  /** [Item 209] Send data to the peer. */
  write(data: string): boolean {
    if (this.state !== 'CONNECTED' || !this._peer) return false;
    if (this._peer.state !== 'CONNECTED') return false;
    this._peer.rxBuf.push(data);
    return true;
  }

  /** [Item 209] Read from the receive buffer. Returns null if nothing available. */
  read(maxChars?: number): string | null {
    if (this.rxBuf.length === 0) return null;
    var all = this.rxBuf.join('');
    if (maxChars !== undefined && all.length > maxChars) {
      var chunk = all.slice(0, maxChars);
      this.rxBuf = [all.slice(maxChars)];
      return chunk;
    }
    this.rxBuf = [];
    return all;
  }

  /**
   * [Item 210] Send a file descriptor reference to the peer (credential passing).
   * The peer can then call recvFd() to retrieve it.
   */
  sendFd(fd: number): boolean {
    if (this.state !== 'CONNECTED' || !this._peer) return false;
    this._peer._pendingFds.push(fd);
    return true;
  }

  /** [Item 210] Receive a file descriptor sent by the peer via sendFd(). */
  recvFd(): number | null {
    return this._pendingFds.length > 0 ? this._pendingFds.shift()! : null;
  }

  close(): void {
    if (this._peer && this._peer.state === 'CONNECTED') this._peer.state = 'CLOSED';
    this.state = 'CLOSED';
    unixSocketRegistry.delete(this.path);
    unixAcceptQueues.delete(this.path);
  }

  get peer(): UnixSocket | null { return this._peer; }
}

/** Global registry: socket path → listening UnixSocket. */
const unixSocketRegistry = new Map<string, UnixSocket>();
/** Accept queues: path → waiting client sockets. */
const unixAcceptQueues   = new Map<string, UnixSocket[]>();

/** [Item 209] Create a new Unix domain socket bound to path (or unbound if no path). */
export function unixSocket(pid: number, path?: string): UnixSocket {
  return new UnixSocket(path || '', pid);
}

/** [Item 210] Creden passing convenience: open two connected sockets (socketpair). */
export function socketpair(pid1: number, pid2: number): [UnixSocket, UnixSocket] {
  var a = new UnixSocket('@pair', pid1);
  var b = new UnixSocket('@pair', pid2);
  a.state = 'CONNECTED'; (a as any)._peer = b;
  b.state = 'CONNECTED'; (b as any)._peer = a;
  return [a, b];
}
