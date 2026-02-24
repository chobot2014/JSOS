/**
 * JSOS Thread Manager — Phase 5
 *
 * Implements kernel threads as TypeScript objects.  Each Thread holds the
 * logical CPU state that would be saved/restored during a context switch.
 *
 * Scheduling logic is 100% TypeScript (multi-level priority round-robin).
 * The C layer only provides the hardware primitives (TSS.ESP0, timer ticks).
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export type ThreadState = 'ready' | 'running' | 'blocked' | 'sleeping' | 'dead';

/** A coroutine step function: called once per frame. Returns 'done' when finished. */
export type CoroutineStep = () => 'done' | 'pending';

export class Thread {
  tid: number;
  name: string;
  state: ThreadState;
  /** 0 = highest priority, 39 = lowest (idle). Lower number wins. */
  priority: number;
  /** Physical address of the base of this thread's 64 KB kernel stack. */
  kernelStack: number;
  /** Saved ESP value pointing into kernelStack (updated on context switch). */
  savedESP: number;
  /** Tick count after which a sleeping thread becomes ready again. */
  sleepUntil: number;
  /** Sync object this thread is waiting on, or null. */
  blockedOn: any;
  /** Per-thread errno (POSIX Phase 6+). */
  errno: number;

  constructor(tid: number, name: string, priority: number) {
    this.tid = tid;
    this.name = name;
    this.state = 'ready';
    this.priority = priority;
    this.kernelStack = 0;
    this.savedESP = 0;
    this.sleepUntil = 0;
    this.blockedOn = null;
    this.errno = 0;
  }
}

export class ThreadManager {
  private _threads: Thread[] = [];
  private _currentTid: number = 0;
  private _nextTid: number = 0;

  /**
   * Create a new kernel thread and add it to the ready queue.
   * Returns the new Thread object.
   */
  createThread(name: string, priority: number = 20): Thread {
    var t = new Thread(this._nextTid++, name, priority);
    this._threads.push(t);
    return t;
  }

  /**
   * Cooperative scheduler tick.  Called by TypeScript at yield points
   * (and registered with kernel.registerSchedulerHook so the C layer can
   * invoke it when separate per-thread kernel stacks are in place).
   *
   * Wakes any sleeping threads whose deadline has passed, then picks the
   * highest-priority ready thread (round-robin among equal-priority) and
   * records it as current.
   *
   * Returns the new thread's savedESP (0 if unchanged or no threads exist).
   */
  tick(): number {
    var now = kernel.getTicks();

    // Wake sleeping threads whose deadline has passed.
    for (var i = 0; i < this._threads.length; i++) {
      var t = this._threads[i];
      if (t.state === 'sleeping' && now >= t.sleepUntil) {
        t.state = 'ready';
      }
    }

    var next = this._schedule();
    if (next) {
      this._currentTid = next.tid;
      return next.savedESP;
    }
    return 0;
  }

  /** Pick the next thread to run (multi-level priority round-robin). */
  private _schedule(): Thread | null {
    if (this._threads.length === 0) return null;

    var cur = this.currentThread();
    var startIdx = 0;
    if (cur) {
      var curIdx = this._indexOf(cur.tid);
      startIdx = (curIdx + 1) % this._threads.length;
    }

    var best: Thread | null = null;
    for (var i = 0; i < this._threads.length; i++) {
      var idx = (startIdx + i) % this._threads.length;
      var th = this._threads[idx];
      if (th.state === 'ready' || th.state === 'running') {
        if (best === null || th.priority < best.priority) {
          best = th;
        }
      }
    }
    return best;
  }

  /** Returns the currently-running Thread, or null. */
  currentThread(): Thread | null {
    return this._byTid(this._currentTid);
  }

  getCurrentTid(): number {
    return this._currentTid;
  }

  setCurrentTid(tid: number): void {
    this._currentTid = tid;
  }

  blockThread(tid: number, reason: any): void {
    var t = this._byTid(tid);
    if (t) { t.state = 'blocked'; t.blockedOn = reason; }
  }

  unblockThread(tid: number): void {
    var t = this._byTid(tid);
    if (t && (t.state === 'blocked' || t.state === 'sleeping')) {
      t.state = 'ready';
      t.blockedOn = null;
    }
  }

  sleepThread(tid: number, ms: number): void {
    var t = this._byTid(tid);
    if (t) {
      t.state = 'sleeping';
      // Timer fires at ~100 Hz → 1 tick ≈ 10 ms.
      t.sleepUntil = kernel.getTicks() + Math.ceil(ms / 10);
    }
  }

  exitThread(tid: number, code: number): void {
    var t = this._byTid(tid);
    if (t) { t.state = 'dead'; }
  }

  threadCount(): number { return this._threads.length; }

  /** Return a read-only snapshot of all threads (for ps / top display). */
  getThreads(): Array<{ tid: number; name: string; state: ThreadState; priority: number }> {
    return this._threads.map(function(t) {
      return { tid: t.tid, name: t.name, state: t.state, priority: t.priority };
    });
  }

  /** Return a read-only snapshot of all active coroutines. */
  getCoroutines(): Array<{ id: number; name: string }> {
    return this._coroutines.map(function(c) { return { id: c.id, name: c.name }; });
  }

  private _byTid(tid: number): Thread | null {
    for (var i = 0; i < this._threads.length; i++) {
      if (this._threads[i].tid === tid) return this._threads[i];
    }
    return null;
  }

  private _indexOf(tid: number): number {
    for (var i = 0; i < this._threads.length; i++) {
      if (this._threads[i].tid === tid) return i;
    }
    return 0;
  }

  // ── Coroutine scheduler ────────────────────────────────────────────────────

  private _coroutines: Array<{ id: number; name: string; step: CoroutineStep }> = [];
  private _nextCid = 0;

  /**
   * Register a coroutine.  `step` is called once per WM frame until it
   * returns 'done'.  Returns the coroutine id (can be passed to cancelCoroutine).
   */
  runCoroutine(name: string, step: CoroutineStep): number {
    var id = this._nextCid++;
    this._coroutines.push({ id, name, step });
    return id;
  }

  /** Remove a coroutine before it finishes. */
  cancelCoroutine(id: number): void {
    for (var i = 0; i < this._coroutines.length; i++) {
      if (this._coroutines[i].id === id) {
        this._coroutines.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Advance every registered coroutine by one step.
   * Uses a snapshot so that a step() may add or cancel coroutines safely.
   */
  tickCoroutines(): void {
    if (this._coroutines.length === 0) return;
    var snap = this._coroutines.slice();   // snapshot before iteration
    var keep: Array<{ id: number; name: string; step: CoroutineStep }> = [];
    for (var i = 0; i < snap.length; i++) {
      var c = snap[i];
      var result: 'done' | 'pending';
      try { result = c.step(); } catch (_e) { result = 'done'; }
      if (result === 'pending') keep.push(c);
    }
    // Merge: retained pending items + any coroutines added during this tick
    var out: Array<{ id: number; name: string; step: CoroutineStep }> = [];
    for (var j = 0; j < keep.length; j++) out.push(keep[j]);
    for (var k = 0; k < this._coroutines.length; k++) {
      var isNew = true;
      for (var m = 0; m < snap.length; m++) {
        if (snap[m].id === this._coroutines[k].id) { isNew = false; break; }
      }
      if (isNew) out.push(this._coroutines[k]);
    }
    this._coroutines = out;
  }
}

export const threadManager = new ThreadManager();
