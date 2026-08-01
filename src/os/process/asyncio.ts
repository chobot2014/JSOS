/**
 * JSOS Async I/O — select / poll / io_uring style Promise APIs
 *
 * [Item 217] Async I/O multiplexing: TypeScript `select([...promises])` —
 *            built on native Promise.race.
 *
 * [Item 218] `poll`/`select` POSIX compat shims for any C-adjacent code that
 *            needs to bridge into the TypeScript async runtime.
 *
 * [Item 219] Async I/O: io_uring concepts expressed as typed Promise APIs.
 *            A SQE (submission queue entry) carries the operation; the CQE
 *            (completion queue entry) resolves a Promise.
 *
 * All I/O in JSOS is structurally asynchronous — the JavaScript event loop
 * provides the scheduler.  This module builds familiar Unix I/O multiplexing
 * APIs on top of native JS Promises.
 */

// ─────────────────────────────────────────────────────────────────────────────
// [Item 217]  select([...waitables]) — Promise.race wrapper
// ─────────────────────────────────────────────────────────────────────────────

/** An I/O-ready event returned by select() or poll(). */
export interface IOEvent<T = unknown> {
  /** The index in the original array that became ready. */
  index:  number;
  /** Resolved value (data from readable, bytes written for writable, etc.). */
  value:  T;
}

/**
 * [Item 217] `select` — wait until any one of the supplied Promises resolves.
 *
 * Analogous to POSIX `select(2)` / Linux `epoll_wait(2)` but expressed as a
 * typed async function.  The call resolves as soon as the first promise in
 * `waitables` settles.
 *
 * @param waitables  Array of Promises to monitor.
 * @param timeout    Optional timeout in milliseconds (0 = no timeout).
 * @returns The index and resolved value of the first ready waitable.
 *
 * @example
 *   const ev = await select([sockRecv, diskRead, timerFired]);
 *   switch (ev.index) {
 *     case 0: handleNetworkData(ev.value); break;
 *     case 1: processDiskData(ev.value);   break;
 *     case 2: handleTimeout();             break;
 *   }
 */
export async function select<T>(
  waitables: Array<Promise<T>>,
  timeout?: number,
): Promise<IOEvent<T>> {
  if (waitables.length === 0) {
    return new Promise<IOEvent<T>>(function(_, reject) {
      reject(new Error('select: empty waitable set'));
    });
  }

  var tagged: Array<Promise<IOEvent<T>>> = waitables.map(function(p, i) {
    return p.then(function(v) { return { index: i, value: v }; });
  });

  if (timeout && timeout > 0) {
    var timeoutPromise = new Promise<IOEvent<T>>(function(resolve) {
      setTimeout(function() { resolve({ index: -1, value: undefined as unknown as T }); }, timeout);
    });
    tagged.push(timeoutPromise);
  }

  return Promise.race(tagged);
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 217/218]  PollFd / poll() — POSIX compat shim
// ─────────────────────────────────────────────────────────────────────────────

/** Poll event bitmask flags (mirrors <poll.h>). */
export const POLLIN   = 0x0001;  // Data to read
export const POLLPRI  = 0x0002;  // Urgent data
export const POLLOUT  = 0x0004;  // Not full / writable
export const POLLERR  = 0x0008;  // Error condition (output only)
export const POLLHUP  = 0x0010;  // Hang-up (output only)
export const POLLNVAL = 0x0020;  // Invalid fd (output only)
export const POLLRDHUP = 0x2000; // Peer closed write end

export interface PollFd {
  /** File descriptor number (logical in JSOS). */
  fd:      number;
  /** Requested events bitmask. */
  events:  number;
  /** Revents — filled in by poll() with what actually happened. */
  revents?: number;
}

/**
 * I/O source registered with the poll infrastructure.
 * FD → (events → Promise that resolves when those events fire).
 */
export type PollSource = (events: number) => Promise<number>;

/**
 * [Item 218] poll() POSIX compat shim.
 *
 * Callers register a `PollSource` per file descriptor with `registerPollFd`.
 * poll() monitors all fds in the array and resolves when at least one fd
 * satisfies its requested events, or when the timeout expires.
 *
 * The returned number is the count of fds with non-zero revents (POSIX
 * semantics; -1 on error).
 *
 * @param fds     Array of poll file descriptors to monitor.
 * @param timeout Timeout in milliseconds. -1 = infinite, 0 = non-blocking.
 * @returns       Count of ready fds, or 0 on timeout, or -1 on error.
 */
export async function poll(fds: PollFd[], timeout: number = -1): Promise<number> {
  // Fill revents = 0
  fds.forEach(function(f) { f.revents = 0; });

  var waiting: Array<Promise<{ i: number; revents: number }>> = fds.map(function(f, i) {
    var src = _pollSources.get(f.fd);
    if (!src) {
      f.revents = POLLNVAL;
      return Promise.resolve({ i, revents: POLLNVAL });
    }
    return src(f.events).then(function(revs) { return { i, revents: revs }; });
  });

  if (timeout === 0) {
    // Non-blocking: check all fds right now via Promise.allSettled
    var results = await Promise.allSettled(waiting);
    var ready = 0;
    results.forEach(function(r, i) {
      if (r.status === 'fulfilled') {
        fds[r.value.i].revents = r.value.revents;
        if (r.value.revents) ready++;
      }
    });
    return ready;
  }

  var selected: Array<Promise<{ i: number; revents: number }>> = waiting.slice();
  if (timeout > 0) {
    var timerP = new Promise<{ i: number; revents: number }>(function(resolve) {
      setTimeout(function() { resolve({ i: -1, revents: 0 }); }, timeout);
    });
    selected.push(timerP);
  }

  var first = await Promise.race(selected);
  if (first.i < 0) return 0; // timeout
  fds[first.i].revents = first.revents;
  return first.revents ? 1 : 0;
}

/** Map from fd number → poll source callbacks. */
var _pollSources: Map<number, PollSource> = new Map();

/** Register a poll source for a given fd. */
export function registerPollFd(fd: number, source: PollSource): void {
  _pollSources.set(fd, source);
}

/** Unregister a poll source (called on close). */
export function unregisterPollFd(fd: number): void {
  _pollSources.delete(fd);
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 219]  io_uring — typed SQE/CQE Promise API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * io_uring operation codes (subset matching Linux kernel io_uring_op).
 */
export const enum IoUringOp {
  NOP        = 0,
  READV      = 1,   // vectored read
  WRITEV     = 2,   // vectored write
  READ_FIXED = 3,   // read with fixed buffer
  WRITE_FIXED = 4,
  POLL_ADD   = 5,
  POLL_REMOVE = 6,
  FSYNC      = 7,
  ACCEPT     = 8,
  CONNECT    = 9,
  RECV       = 10,
  SEND       = 11,
  TIMEOUT    = 12,
  CLOSE      = 13,
}

/** io_uring Submission Queue Entry (SQE). */
export interface IoUringSQE {
  op:       IoUringOp;
  /** User-supplied cookie echoed in the CQE for matching. */
  userData: number | string;
  fd:       number;
  buf?:     Uint8Array;
  offset?:  number;
  length?:  number;
  flags?:   number;
}

/** io_uring Completion Queue Entry (CQE). */
export interface IoUringCQE {
  userData: number | string;
  /** ≥0 = result value (bytes transferred, fd, etc.), <0 = -errno. */
  result:   number;
  flags?:   number;
}

/**
 * Handler type registered per IoUringOp.
 * Each handler is an async function that accepts the SQE and returns a CQE result.
 */
export type IoUringHandler = (sqe: IoUringSQE) => Promise<number>;

/**
 * [Item 219] io_uring ring buffer — typed Promise-based async I/O.
 *
 * In the Linux kernel, io_uring uses shared memory ring buffers to avoid
 * syscall overhead.  In JSOS the same concept is expressed as a Promise
 * queue: `submit(sqe)` enqueues an I/O operation and returns a Promise that
 * resolves with the CQE when the operation completes.
 *
 *   const ring = new IoUring();
 *   ring.registerHandler(IoUringOp.RECV, myRecvHandler);
 *   const cqe = await ring.submit({ op: IoUringOp.RECV, userData: 42, fd: 3 });
 *   console.log('received bytes:', cqe.result);
 *
 * Batching:
 *   const promises = ops.map(op => ring.submit(op));
 *   const cqes     = await Promise.all(promises);  // all ops in flight simultaneously
 */
export class IoUring {
  private _handlers: Map<IoUringOp, IoUringHandler> = new Map();
  private _pending:  number = 0;

  /** Register an operation handler. */
  registerHandler(op: IoUringOp, handler: IoUringHandler): void {
    this._handlers.set(op, handler);
  }

  /**
   * Submit an I/O operation to the ring.
   * Returns a Promise that resolves with the CQE when the operation completes.
   */
  async submit(sqe: IoUringSQE): Promise<IoUringCQE> {
    this._pending++;
    try {
      var handler = this._handlers.get(sqe.op);
      var result: number;
      if (handler) {
        result = await handler(sqe);
      } else if (sqe.op === IoUringOp.NOP) {
        result = 0;
      } else {
        result = -38; // ENOSYS
      }
      return { userData: sqe.userData, result };
    } catch (e) {
      return { userData: sqe.userData, result: -5 }; // EIO
    } finally {
      this._pending--;
    }
  }

  /**
   * Submit multiple SQEs simultaneously (batched submission).
   * All entries are submitted before waiting for any completion.
   * Returns an array of CQEs in the same order as the input SQEs.
   */
  async submitBatch(sqes: IoUringSQE[]): Promise<IoUringCQE[]> {
    return Promise.all(sqes.map((sqe) => this.submit(sqe)));
  }

  /**
   * Submit a TIMEOUT SQE.  Resolves after `ns` nanoseconds (approximate;
   * capped at setTimeout precision of ~1 ms).
   */
  submitTimeout(userData: number | string, ns: number): Promise<IoUringCQE> {
    return this.submit({
      op: IoUringOp.TIMEOUT,
      userData,
      fd: -1,
      offset: ns,
    });
  }

  get pendingCount(): number { return this._pending; }
}

/** Default process-global io_uring ring. */
export const ioRing = new IoUring();

// ── Register the built-in TIMEOUT handler ───────────────────────────────────

ioRing.registerHandler(IoUringOp.TIMEOUT, async function(sqe: IoUringSQE): Promise<number> {
  var ms = Math.max(1, Math.round((sqe.offset ?? 0) / 1_000_000));
  await new Promise<void>(function(resolve) { setTimeout(resolve, ms); });
  return 0;
});
