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
 */

declare var kernel: any;   // extended with proc* by C runtime

export class JSProcess {
  readonly id:   number;
  readonly name: string;
  private _alive: boolean;

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
   * Call this after sending messages or after spawning code that uses Promises.
   * Returns the number of jobs that ran.
   */
  tick(): number {
    if (!this._alive) return 0;
    return kernel.procTick(this.id);
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
