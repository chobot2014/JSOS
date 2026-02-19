/**
 * JSOS Signal Manager — Phase 6
 *
 * POSIX signal delivery and per-process signal handlers.
 * Single-core only; signals are delivered synchronously before a process
 * returns to user mode (Phase 9+ for actual ring-3 delivery).
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
  /** Pending signals not yet delivered. */
  private _pending: PendingSignal[] = [];

  /** Send a signal to a process. */
  send(pid: number, sig: number): void {
    this._pending.push({ pid, sig });
    this._deliver(pid, sig);
  }

  /** Register a signal handler for a process. */
  handle(pid: number, sig: number, handler: SignalHandler): void {
    if (!this._handlers.has(pid)) this._handlers.set(pid, new Map());
    this._handlers.get(pid)!.set(sig, handler);
  }

  /** Deliver all pending signals to pid (called before returning to user). */
  deliverPending(pid: number): void {
    var remaining: PendingSignal[] = [];
    for (var i = 0; i < this._pending.length; i++) {
      var p = this._pending[i];
      if (p.pid === pid) {
        this._deliver(pid, p.sig);
      } else {
        remaining.push(p);
      }
    }
    this._pending = remaining;
  }

  private _deliver(pid: number, sig: number): void {
    var handlers = this._handlers.get(pid);
    var handler: SignalHandler = 'default';
    if (handlers) {
      var h = handlers.get(sig);
      if (h !== undefined) handler = h;
    }

    if (handler === 'ignore') return;
    if (handler === 'default') {
      // Default actions: most signals terminate the process
      if (sig === SIG.SIGCHLD || sig === SIG.SIGCONT) return; // ignore by default
    } else if (typeof handler === 'function') {
      handler(sig);
    }
  }
}

export const signalManager = new SignalManager();
