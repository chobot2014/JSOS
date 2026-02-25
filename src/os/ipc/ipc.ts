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
    this.signals.send(pid, Signal.SIGINT);
  }

  /** Terminate a process gracefully. */
  terminate(pid: number): void {
    this.signals.send(pid, Signal.SIGTERM);
  }
}

export const ipc = new IPCManager();
