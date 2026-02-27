/**
 * JSOS Signal Manager — Phase 6
 *
 * POSIX signal delivery and per-process signal handlers.
 * Single-core only; signals are delivered synchronously before a process
 * returns to user mode (Phase 9+ for actual ring-3 delivery).
 *
 * Items implemented here:
 *   156 — Signal delivery interrupts blocked syscalls (blockedCb)
 *   157 — Signal masking via per-process sigMask bitmask
 *   158 — Signal queuing: send() enqueues, deliverPending() drains
 */

import { threadManager } from './threads.js';

export const SIG = {
  SIGHUP:  1,  SIGINT:   2,  SIGQUIT:  3,  SIGILL:   4,
  SIGTRAP: 5,  SIGABRT:  6,  SIGBUS:   7,  SIGFPE:   8,
  SIGKILL: 9,  SIGUSR1: 10,  SIGSEGV: 11,  SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14,  SIGTERM: 15,  SIGCHLD: 17,
  SIGCONT: 18, SIGSTOP: 19,
};

export type SignalHandler = 'default' | 'ignore' | ((sig: number) => void);

interface PendingSignal { pid: number; sig: number; }

export class SignalManager {
  /** Per-process signal handlers: pid → sig → handler */
  private _handlers: Map<number, Map<number, SignalHandler>> = new Map();

  /**
   * [Item 158] Pending signals — send() enqueues, deliverPending() drains.
   * Queuing enables masking at delivery time (item 157) and allows multiple
   * signals to accumulate correctly between scheduler ticks.
   */
  private _pending: PendingSignal[] = [];

  /**
   * [Item 157] Per-process signal mask: pid → bitmask.
   * Bit (sig-1) set means signal `sig` is blocked.
   * SIGKILL (9) and SIGSTOP (19) cannot be masked regardless of this value.
   */
  private _sigMasks: Map<number, number> = new Map();

  /** Called when a signal's default action is to terminate the process. */
  private _terminateCb: ((pid: number) => void) | null = null;

  /**
   * [Item 156] Called after a signal is queued so that a process blocked in a
   * slow syscall can be woken with EINTR.  Set by the scheduler.
   */
  private _blockedCb: ((pid: number) => void) | null = null;

  // ── Registration ─────────────────────────────────────────────────────────

  /** Register the callback that terminates a process (set by scheduler). */
  setTerminateCallback(fn: (pid: number) => void): void {
    this._terminateCb = fn;
  }

  /**
   * [Item 156] Register the callback invoked after a signal is queued so that
   * blocked-syscall contexts can be interrupted with EINTR.
   */
  setBlockedCallback(fn: (pid: number) => void): void {
    this._blockedCb = fn;
  }

  // ── Signal mask (item 157) ────────────────────────────────────────────────

  /** Get the signal mask for a process (bit N = signal N+1 blocked). */
  getSigMask(pid: number): number {
    return this._sigMasks.get(pid) ?? 0;
  }

  /**
   * Set the signal mask for a process.  SIGKILL and SIGSTOP are silently
   * cleared from the mask.  After updating, any newly-unblocked pending
   * signals are immediately delivered.
   */
  setSigMask(pid: number, mask: number): void {
    mask &= ~((1 << (SIG.SIGKILL - 1)) | (1 << (SIG.SIGSTOP - 1)));
    this._sigMasks.set(pid, mask);
    this.deliverPending(pid);
  }

  // ── Signal send / delivery ────────────────────────────────────────────────

  /**
   * Send a signal to a process.
   * [Item 158] Enqueues into _pending[] so masking is checked at delivery time.
   * [Item 156] Calls blockedCb to wake any blocked syscall.
   */
  send(pid: number, sig: number): void {
    this._pending.push({ pid, sig });
    if (this._blockedCb) this._blockedCb(pid);
  }

  /** Register a signal handler for a process. */
  handle(pid: number, sig: number, handler: SignalHandler): void {
    if (!this._handlers.has(pid)) this._handlers.set(pid, new Map());
    this._handlers.get(pid)!.set(sig, handler);
  }

  /** Deliver all pending (and unmasked) signals to pid. */
  deliverPending(pid: number): void {
    var remaining: PendingSignal[] = [];
    for (var i = 0; i < this._pending.length; i++) {
      var p = this._pending[i];
      if (p.pid === pid) {
        this._deliver(pid, p.sig, remaining);
      } else {
        remaining.push(p);
      }
    }
    this._pending = remaining;
  }

  /** Remove all signal state for a pid (called on process exit). */
  cleanup(pid: number): void {
    this._pending   = this._pending.filter(function(p) { return p.pid !== pid; });
    this._sigMasks.delete(pid);
    this._handlers.delete(pid);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _deliver(pid: number, sig: number, requeue: PendingSignal[]): void {
    // [Item 157] SIGKILL and SIGSTOP bypass the mask.
    if (sig !== SIG.SIGKILL && sig !== SIG.SIGSTOP) {
      var mask = this._sigMasks.get(pid) ?? 0;
      if (sig >= 1 && sig <= 30 && (mask & (1 << (sig - 1))) !== 0) {
        requeue.push({ pid, sig });
        return;
      }
    }

    var handlers = this._handlers.get(pid);
    var handler: SignalHandler = 'default';
    if (handlers) {
      var h = handlers.get(sig);
      if (h !== undefined) handler = h;
    }

    if (handler === 'ignore') return;
    if (handler === 'default') {
      if (sig === SIG.SIGCHLD || sig === SIG.SIGCONT) return;
      if (this._terminateCb) this._terminateCb(pid);
    } else if (typeof handler === 'function') {
      handler(sig);
    }
  }
}

export const signalManager = new SignalManager();
