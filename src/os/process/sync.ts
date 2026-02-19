/**
 * JSOS Synchronisation Primitives — Phase 5
 *
 * Mutex, Condvar, and Semaphore built on top of the ThreadManager.
 * These are the foundations for pthread_mutex_t / pthread_cond_t / sem_t
 * in the Phase 6 POSIX layer.
 *
 * Single-core only (no spinlocks needed).  All logic is TypeScript.
 */

import { threadManager } from './threads.js';

export class Mutex {
  /** TID of current owner, or null when unlocked. */
  private _owner: number | null = null;
  /** TIDs waiting to acquire this mutex. */
  private _waitQueue: number[] = [];

  lock(): void {
    var cur = threadManager.currentThread();
    var tid = cur !== null ? cur.tid : 0;
    if (this._owner === null) {
      this._owner = tid;
    } else {
      this._waitQueue.push(tid);
      if (cur !== null) {
        threadManager.blockThread(tid, this);
        // The scheduler will resume us here when unlock() wakes us.
      }
    }
  }

  unlock(): void {
    if (this._waitQueue.length > 0) {
      var next = this._waitQueue.shift()!;
      this._owner = next;
      threadManager.unblockThread(next);
    } else {
      this._owner = null;
    }
  }

  /** Non-blocking attempt.  Returns true if the lock was acquired. */
  tryLock(): boolean {
    if (this._owner !== null) return false;
    var cur = threadManager.currentThread();
    this._owner = cur !== null ? cur.tid : 0;
    return true;
  }

  isLocked(): boolean { return this._owner !== null; }
}

export class Condvar {
  private _waitQueue: number[] = [];

  /** Atomically release mutex and wait.  Reacquires mutex before returning. */
  wait(mutex: Mutex): void {
    var cur = threadManager.currentThread();
    if (cur === null) return;
    mutex.unlock();
    this._waitQueue.push(cur.tid);
    threadManager.blockThread(cur.tid, this);
    // Resumed after signal()/broadcast() — re-acquire mutex.
    mutex.lock();
  }

  /** Wake one waiter. */
  signal(): void {
    if (this._waitQueue.length > 0) {
      var tid = this._waitQueue.shift()!;
      threadManager.unblockThread(tid);
    }
  }

  /** Wake all waiters. */
  broadcast(): void {
    while (this._waitQueue.length > 0) {
      var tid = this._waitQueue.shift()!;
      threadManager.unblockThread(tid);
    }
  }
}

export class Semaphore {
  private _count: number;
  private _waitQueue: number[] = [];

  constructor(initial: number) {
    this._count = initial >= 0 ? initial : 0;
  }

  /** Decrement; blocks if count is already 0. */
  acquire(): void {
    if (this._count > 0) {
      this._count--;
      return;
    }
    var cur = threadManager.currentThread();
    if (cur !== null) {
      this._waitQueue.push(cur.tid);
      threadManager.blockThread(cur.tid, this);
    }
  }

  /** Increment; unblocks one waiter if any. */
  release(): void {
    if (this._waitQueue.length > 0) {
      var tid = this._waitQueue.shift()!;
      threadManager.unblockThread(tid);
    } else {
      this._count++;
    }
  }

  value(): number { return this._count; }
}
