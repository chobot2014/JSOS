/**
 * JSOS JSProcess — Phase 10: Multi-process QuickJS runtime instances
 *
 * Each JSProcess runs in its own fully isolated QuickJS runtime:
 *   • Separate GC and heap (4 MB limit per process)
 *   • Separate global scope — no shared globals with parent
 *   • Message-passing IPC via C-managed ring buffers (8 slots, 2 KB each)
 *   • Up to 8 concurrent child processes
 *
 * ─── Child runtime kernel API ────────────────────────────────────────────────
 * The child's global `kernel` object exposes:
 *
 *   kernel.serialPut(s)        serial/debug output (visible in QEMU serial log)
 *   kernel.getTicks()          PIT timer ticks since boot
 *   kernel.getUptime()         uptime in milliseconds
 *   kernel.sleep(ms)           cooperative sleep
 *   kernel.getMemoryInfo()     { total, used, free } in bytes
 *   kernel.postMessage(s)      send a string to the parent (→ parent's outbox)
 *   kernel.pollMessage()       receive a string from the parent (← parent's inbox)
 *                              returns null when inbox is empty
 *
 * ─── Parent kernel API ───────────────────────────────────────────────────────
 * Low-level kernel.proc* primitives (use JSProcess class instead):
 *
 *   kernel.procCreate()           allocate new runtime slot → id 0-7, or -1
 *   kernel.procEval(id, code)     run code in child runtime → result string
 *   kernel.procTick(id)           pump child async jobs → jobs-run count
 *   kernel.procSend(id, msg)      push string into child inbox → bool
 *   kernel.procRecv(id)           pop string from child outbox → string | null
 *   kernel.procDestroy(id)        free the child runtime
 *   kernel.procAlive(id)          check if slot is live → bool
 *   kernel.procList()             → [{id, inboxCount, outboxCount}, ...]
 *
 * ─── Typical REPL usage ──────────────────────────────────────────────────────
 *
 *   var p = spawn(`
 *     var n = 0;
 *     function work() {
 *       n++;
 *       kernel.postMessage(JSON.stringify({ n, ticks: kernel.getTicks() }));
 *     }
 *   `);
 *   p.eval('work()');   // run more code in the process
 *   p.recv()            // → { n: 1, ticks: 12345 }
 *   p.send({ hello: 'world' });
 *   p.eval('kernel.pollMessage()');   // → '{"hello":"world"}'
 *   p.terminate();
 *
 * ─── Shared memory (zero-copy, no JSON) ─────────────────────────────────────────────
 *
 * JS object references CANNOT be shared between runtimes — each QuickJS
 * runtime has its own GC heap.  Passing an object pointer across runtimes
 * would corrupt both heaps.
 *
 * Binary memory CAN be shared.  A BSS slab (stable physical address, never
 * moved by any GC) is mapped as an ArrayBuffer into every runtime that calls
 * sharedBufferOpen(id).  Both sides see the same bytes instantly:
 *
 *   // Parent
 *   var id = kernel.sharedBufferCreate(1024);
 *   var view = new Uint32Array(kernel.sharedBufferOpen(id)!);
 *   view[0] = 0xDEADBEEF;
 *
 *   // Child (pass id via JSON message)
 *   p.send({ sharedId: id });
 *   p.eval(`
 *     var msg = JSON.parse(kernel.pollMessage());
 *     var v = new Uint32Array(kernel.sharedBufferOpen(msg.sharedId));
 *     v[0]; // → 0xDEADBEEF — same physical bytes, zero copy
 *   `);
 *
 * ─── Non-blocking execution ─────────────────────────────────────────────────────
 *
 * p.evalSlice(code, maxMs) aborts the child after maxMs milliseconds using
 * QuickJS's interrupt handler.  The WM calls kernel.procTick(id) for every
 * live process each frame, so Promise callbacks run even without explicit
 * p.tick() calls.  Design CPU-bound children to work in steps:
 *
 *   var p = spawn(`
 *     var i = 0, results = [];
 *     function step() {              // called each WM frame via p.eval()
 *       var end = Math.min(i + 500, data.length);
 *       while (i < end) results.push(crunch(data[i++]));
 *       if (i >= data.length) kernel.postMessage(JSON.stringify(results));
 *     }
 *   `);
 *   // WM loop: each frame calls p.evalSlice('step()', 5)
 *   // Mouse stays smooth — each step takes at most 5 ms
 */

declare var kernel: any;   // extended with proc* by C runtime

export class JSProcess {
  readonly id:   number;
  readonly name: string;
  private _alive: boolean;
  private _onMessageCbs: Array<(msg: any) => void> = [];

  private constructor(id: number, name: string) {
    this.id     = id;
    this.name   = name;
    this._alive = true;
  }

  // ── Static factory ─────────────────────────────────────────────────────────

  /**
   * Spawn a new isolated JS runtime, immediately evaluate `code` inside it,
   * and return the process handle.
   *
   * Throws if no runtime slots are free (max 8) or if the initial eval throws.
   */
  static spawn(code: string, name?: string): JSProcess {
    var id: number = kernel.procCreate();
    if (id < 0) throw new Error('JSProcess: no free runtime slots (max 8 concurrent)');
    var proc = new JSProcess(id, name || ('proc' + id));
    var result: string = kernel.procEval(id, code);
    // Surface errors from the initial eval
    if (result && result.indexOf('Error') === 0) {
      kernel.procDestroy(id);
      throw new Error('JSProcess.spawn: ' + result);
    }
    return proc;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** True while the child runtime is allocated and alive. */
  get alive(): boolean {
    return this._alive && !!kernel.procAlive(this.id);
  }

  /**
   * Free the child runtime and all its memory.
   * After calling this, all further method calls are no-ops.
   */
  terminate(): void {
    if (!this._alive) return;
    kernel.procDestroy(this.id);
    this._alive = false;
  }

  // ── Code execution ─────────────────────────────────────────────────────────

  /**
   * Evaluate additional code inside the child runtime.
   * The child retains all previously defined variables and functions.
   * Returns the string result of the expression (or an error string if it threw).
   */
  eval(code: string): string {
    if (!this._alive) return 'Error: process not alive';
    return kernel.procEval(this.id, code);
  }

  /**
   * Pump the child's pending job queue (Promise .then callbacks, async functions).
   * Also drains the outbox and fires any registered onMessage() callbacks.
   * The WM calls this automatically for every live process each frame.
   * Returns the number of async jobs that ran.
   */
  tick(): number {
    if (!this._alive) return 0;
    var jobs = kernel.procTick(this.id);
    // Drain outbox and fire callbacks (only if anyone is listening)
    if (this._onMessageCbs.length > 0) {
      var msg: any;
      while ((msg = this.recv()) !== null) {
        for (var i = 0; i < this._onMessageCbs.length; i++) {
          try { this._onMessageCbs[i](msg); } catch (_) {}
        }
      }
    }
    return jobs;
  }

  /**
   * Time-limited eval: run `code` in the child but abort after `maxMs` ms.
   * Returns { status, result } where status is 'done' | 'timeout' | 'error'.
   *
   * Use this instead of eval() for code that might run long, so the WM frame
   * (mouse, keyboard, compositing) is never blocked for more than maxMs ms.
   *
   * Design child code to work in fixed-size steps:
   *   p.evalSlice('step()', 5);  // ≤ 5 ms per frame → smooth 60fps mouse
   */
  evalSlice(code: string, maxMs: number = 10): { status: 'done' | 'timeout' | 'error'; result: string } {
    if (!this._alive) return { status: 'error', result: 'process not alive' };
    var raw = kernel.procEvalSlice(this.id, code, maxMs);
    if (raw === 'timeout') return { status: 'timeout', result: '' };
    if (raw.indexOf('done:')  === 0) return { status: 'done',  result: raw.slice(5) };
    if (raw.indexOf('error:') === 0) return { status: 'error', result: raw.slice(6) };
    return { status: 'done', result: raw };
  }

  /**
   * Register a callback fired each time a message arrives from the child.
   * Called automatically inside tick() after draining the outbox.
   * Returns `this` for chaining:  spawn(code).onMessage(handler).send(init)
   */
  onMessage(cb: (msg: any) => void): this {
    this._onMessageCbs.push(cb);
    return this;
  }

  /** Remove a previously registered onMessage callback. */
  offMessage(cb: (msg: any) => void): this {
    var idx = this._onMessageCbs.indexOf(cb);
    if (idx >= 0) this._onMessageCbs.splice(idx, 1);
    return this;
  }

  // ── Message passing ────────────────────────────────────────────────────────

  /**
   * Send a JSON-serialisable value to the child.
   * The child reads it with kernel.pollMessage() → JSON.parse(...).
   * Returns false if the inbox is full (8 slot ring buffer).
   */
  send(msg: any): boolean {
    if (!this._alive) return false;
    return kernel.procSend(this.id, JSON.stringify(msg));
  }

  /**
   * Receive the next message from the child (child wrote it with
   * kernel.postMessage(JSON.stringify(data))).
   * Returns null when the outbox is empty.
   * Automatically JSON.parses the payload; returns the raw string on parse failure.
   */
  recv(): any {
    if (!this._alive) return null;
    var s: string | null = kernel.procRecv(this.id);
    if (s === null) return null;
    try { return JSON.parse(s); } catch (_) { return s; }
  }

  /**
   * Drain all pending messages from the child into an array (oldest first).
   * Returns [] when the outbox is empty.
   */
  recvAll(): any[] {
    var msgs: any[] = [];
    var m: any;
    while ((m = this.recv()) !== null) msgs.push(m);
    return msgs;
  }

  // ── Inspect ────────────────────────────────────────────────────────────────

  toString(): string {
    return '[JSProcess #' + this.id + ' ' + this.name +
           (this._alive ? ' alive' : ' dead') + ']';
  }

  /** Snapshot of the C-level queue depths for this process. */
  stats(): { id: number; name: string; alive: boolean; inbox: number; outbox: number } {
    if (!this._alive) return { id: this.id, name: this.name, alive: false, inbox: 0, outbox: 0 };
    var list: Array<{ id: number; inboxCount: number; outboxCount: number }> = kernel.procList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === this.id)
        return { id: this.id, name: this.name, alive: true,
                 inbox: list[i].inboxCount, outbox: list[i].outboxCount };
    }
    return { id: this.id, name: this.name, alive: false, inbox: 0, outbox: 0 };
  }
}

/**
 * List all live child process slots from the C pool.
 * Returns raw C-level info; use procs() at the REPL for a pretty view.
 */
export function listProcesses(): Array<{ id: number; inboxCount: number; outboxCount: number }> {
  return kernel.procList();
}
