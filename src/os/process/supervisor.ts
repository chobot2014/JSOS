/**
 * JSOS Process Supervisor
 *
 * Wraps JSProcess with production-grade lifecycle management:
 *
 *   • spawn child runtime  — wraps JSProcess.spawn with supervision preamble
 *   • heartbeat            — child must ping within N ms or is considered hung
 *   • CPU / tick budget    — kill child if it consumes more than N ticks/window
 *   • memory budget        — kill child when heap exceeds N bytes (if measurable)
 *   • kill / restart       — graceful SIGTERM → forceful kill, auto-restart policy
 *   • stderr / log capture — child messages tagged { __sv:'log' } land in log ring
 *   • crash reason         — categorised: 'oom' | 'timeout' | 'budget' | 'error'
 *                            | 'killed' | 'exited' | 'unknown'
 *
 * ─── Child supervisor protocol ───────────────────────────────────────────────
 * The supervisor injects a small preamble into every child runtime that adds
 * several globals the child may call (all optional):
 *
 *   sv.heartbeat()               — signal "I am alive" (call periodically)
 *   sv.log(level, msg)           — send a log line to the parent's ring buffer
 *   sv.memInfo()                 — send a memory snapshot (used for budget checks)
 *
 * Messages from the child that match { __sv: ... } are consumed by the
 * supervisor and never forwarded to application onMessage handlers.
 * All other child messages pass through normally.
 *
 * ─── Typical usage ────────────────────────────────────────────────────────────
 *
 *   var sup = new ProcessSupervisor();
 *
 *   var proc = sup.spawn(`
 *     var n = 0;
 *     function work() {
 *       n++;
 *       sv.heartbeat();                          // keep-alive
 *       sv.log('info', 'tick ' + n);             // captured log
 *       kernel.postMessage(JSON.stringify(n));   // app message
 *     }
 *   `, {
 *     name: 'worker',
 *     heartbeatIntervalMs: 2000,
 *     cpuTickBudget:       500,
 *     memoryBudgetBytes:   2 * 1024 * 1024,    // 2 MB
 *     restartPolicy:       'on-failure',
 *     maxRestarts:         5,
 *     restartDelayMs:      500,
 *     logBufferSize:       200,
 *   });
 *
 *   proc.onMessage(function(msg) { print('msg:', msg); });
 *   proc.onCrash(function(r)    { print('crash:', r.reason, r.error); });
 *
 *   // each WM frame:
 *   sup.tick();
 *
 * The supervisor itself integrates with the WM coroutine system; if you hold a
 * ProcessSupervisor instance inside a WM app, call sup.tick() from your app's
 * per-frame handler, or call sup.startCoroutine() once to register an autonomous
 * per-frame coroutine (requires os context, see sdk.ts).
 */

import { JSProcess } from './jsprocess.js';
import { threadManager } from './threads.js';

declare var kernel: any;

// ─── Public types ─────────────────────────────────────────────────────────────

export type CrashReason =
  | 'oom'             // memory budget exceeded
  | 'timeout'         // heartbeat expired
  | 'budget'          // CPU tick budget exceeded
  | 'error'           // evalSlice returned an error
  | 'killed'          // explicitly killed by caller
  | 'exited'          // child runtime died without a known reason
  | 'unknown';

export type RestartPolicy = 'no' | 'always' | 'on-failure' | 'on-crash';

export interface SupervisedProcessOptions {
  /** A human-readable name shown in logs and stats. */
  name?: string;

  /**
   * Maximum ms between heartbeats before the child is declared hung.
   * 0 = heartbeat checking disabled (default).
   */
  heartbeatIntervalMs?: number;

  /**
   * Maximum number of supervisor tick() calls the child may consume in a
   * `cpuWindowTicks`-wide rolling window before being killed.
   * 0 = no limit (default).
   */
  cpuTickBudget?: number;

  /**
   * Width of the CPU rolling window in tick() calls.
   * Default: 300 (≈ 6 s at 50 fps).
   */
  cpuWindowTicks?: number;

  /**
   * If > 0, call `__sv_meminfo()` inside the child every N ticks and kill
   * it if its self-reported heap usage exceeds `memoryBudgetBytes`.
   * 0 = disabled (default).
   */
  memoryBudgetBytes?: number;

  /** How often to sample memory (in tick() calls). Default: 60. */
  memorySampleIntervalTicks?: number;

  /** Restart policy. Default: 'no'. */
  restartPolicy?: RestartPolicy;

  /** Max consecutive restarts before the supervisor gives up. Default: 3. */
  maxRestarts?: number;

  /** Milliseconds (approximated in ticks) to wait before restart. Default: 500. */
  restartDelayMs?: number;

  /** Number of log lines to keep in the ring buffer. Default: 100. */
  logBufferSize?: number;

  /**
   * Maximum ms allowed per evalSlice when ticking the child.
   * Default: 10 ms.
   */
  sliceBudgetMs?: number;
}

export interface CrashEvent {
  reason:    CrashReason;
  error?:    string;
  timestamp: number;   // kernel.getTicks()
  restarts:  number;
}

export interface SupervisedProcessStats {
  id:            number;
  name:          string;
  state:         SupervisedProcessState;
  restarts:      number;
  startTime:     number;
  lastHeartbeat: number;
  cpuTicks:      number;
  memoryBytes:   number;
  crashReason:   CrashReason | null;
  crashError:    string | null;
  logs:          string[];
}

export type SupervisedProcessState =
  | 'running'
  | 'crashed'
  | 'killed'
  | 'restarting'
  | 'stopped';

// ─── Supervisor preamble ──────────────────────────────────────────────────────

/**
 * Code injected at the head of every supervised child runtime.
 * Provides the `sv` global with heartbeat / log / memInfo helpers.
 */
const SUPERVISOR_PREAMBLE = `
(function() {
  var globalThis = this;
  globalThis.sv = {
    heartbeat: function() {
      kernel.postMessage(JSON.stringify({ __sv: 'hb', t: kernel.getTicks() }));
    },
    log: function(level, msg) {
      kernel.postMessage(JSON.stringify({ __sv: 'log', level: String(level), msg: String(msg) }));
    },
    memInfo: function() {
      var info = (kernel.getMemoryInfo ? kernel.getMemoryInfo() : null);
      kernel.postMessage(JSON.stringify({ __sv: 'mem', used: info ? (info.used || 0) : 0 }));
    },
    error: function(msg) { globalThis.sv.log('error', msg); },
    warn:  function(msg) { globalThis.sv.log('warn',  msg); },
    info:  function(msg) { globalThis.sv.log('info',  msg); },
    debug: function(msg) { globalThis.sv.log('debug', msg); },
  };
})();
`;

// ─── SupervisedProcess ─────────────────────────────────────────────────────────

export class SupervisedProcess {
  readonly name: string;

  private _proc:          JSProcess | null = null;
  private _code:          string;           // child source (re-used on restart)
  private _opts:          Required<SupervisedProcessOptions>;
  private _state:         SupervisedProcessState = 'stopped';
  private _restarts:      number  = 0;
  private _startTime:     number  = 0;
  private _lastHeartbeat: number  = 0;
  private _cpuTicks:      number  = 0;      // total tick() calls for this child
  private _cpuWindow:     number  = 0;      // ticks in current rolling window
  private _windowStart:   number  = 0;      // tick() call index at window start
  private _memoryBytes:   number  = 0;
  private _memSampleTick: number  = 0;
  private _crashReason:   CrashReason | null = null;
  private _crashError:    string  | null = null;
  private _logs:          string[]        = [];
  private _logHead:       number  = 0;     // ring buffer write head
  private _restartAt:     number  = 0;     // tick count at which to restart
  private _tickCount:     number  = 0;     // supervisor tick() calls

  private _onMessageCbs: Array<(msg: any) => void> = [];
  private _onCrashCbs:   Array<(ev: CrashEvent)  => void> = [];

  constructor(code: string, opts: SupervisedProcessOptions) {
    this._code = code;
    this._opts = {
      name:                      opts.name                      ?? 'supervised',
      heartbeatIntervalMs:       opts.heartbeatIntervalMs       ?? 0,
      cpuTickBudget:             opts.cpuTickBudget             ?? 0,
      cpuWindowTicks:            opts.cpuWindowTicks            ?? 300,
      memoryBudgetBytes:         opts.memoryBudgetBytes         ?? 0,
      memorySampleIntervalTicks: opts.memorySampleIntervalTicks ?? 60,
      restartPolicy:             opts.restartPolicy             ?? 'no',
      maxRestarts:               opts.maxRestarts               ?? 3,
      restartDelayMs:            opts.restartDelayMs            ?? 500,
      logBufferSize:             opts.logBufferSize             ?? 100,
      sliceBudgetMs:             opts.sliceBudgetMs             ?? 10,
    };
    this.name = this._opts.name;
    // Reserve log ring buffer
    this._logs = new Array(this._opts.logBufferSize).fill('');
    this._logHead = 0;
    this._start();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** True while the child runtime is allocated and alive. */
  get alive(): boolean {
    return this._state === 'running' && this._proc !== null && this._proc.alive;
  }

  get state(): SupervisedProcessState { return this._state; }

  /**
   * Forcefully kill the child and stop supervision.
   * Does NOT trigger restart, regardless of restartPolicy.
   */
  kill(): void {
    this._killProc('killed');
    this._state = 'killed';
  }

  /**
   * Kill and immediately restart the child (ignores restart delay).
   */
  restart(): void {
    this._killProc('killed');
    this._doRestart();
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  /** Called each time the child sends an application message (non-supervisor). */
  onMessage(cb: (msg: any) => void): this {
    this._onMessageCbs.push(cb);
    return this;
  }

  /** Called when the child crashes or is forcefully stopped. */
  onCrash(cb: (ev: CrashEvent) => void): this {
    this._onCrashCbs.push(cb);
    return this;
  }

  // ── Direct child interaction ───────────────────────────────────────────────

  /**
   * Evaluate code in the supervised child.
   * Returns 'Error: process not alive' if the child is not running.
   */
  eval(code: string): string {
    if (!this._proc || !this._proc.alive) return 'Error: process not alive';
    return this._proc.eval(code);
  }

  /**
   * Send a JSON-serialisable message to the child.
   * Returns false if the child is not running or the inbox is full.
   */
  send(msg: any): boolean {
    if (!this._proc || !this._proc.alive) return false;
    return this._proc.send(msg);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  /** Snapshot of the supervised process's current state and metrics. */
  stats(): SupervisedProcessStats {
    return {
      id:            this._proc ? this._proc.id : -1,
      name:          this.name,
      state:         this._state,
      restarts:      this._restarts,
      startTime:     this._startTime,
      lastHeartbeat: this._lastHeartbeat,
      cpuTicks:      this._cpuTicks,
      memoryBytes:   this._memoryBytes,
      crashReason:   this._crashReason,
      crashError:    this._crashError,
      logs:          this._getLogSnapshot(),
    };
  }

  // ── Supervisor tick — called once per WM frame by ProcessSupervisor ────────

  /**
   * Called by ProcessSupervisor.tick() once per WM frame.
   * Drives the child runtime, checks budgets, and handles restarts.
   * Do NOT call this directly unless you are managing the coroutine yourself.
   */
  _tick(): void {
    this._tickCount++;

    // ── Handle pending restart ───────────────────────────────────────────────
    if (this._state === 'restarting') {
      if (this._tickCount >= this._restartAt) {
        this._doRestart();
      }
      return;
    }

    if (this._state !== 'running') return;

    // ── Gate: child should be alive ──────────────────────────────────────────
    if (!this._proc || !this._proc.alive) {
      this._crash('exited', undefined);
      return;
    }

    // ── Tick the child runtime (pump async jobs + drain messages) ────────────
    this._cpuTicks++;
    this._cpuWindow++;

    var raw: any;
    if (this._opts.sliceBudgetMs > 0) {
      var result = this._proc.evalSlice('', this._opts.sliceBudgetMs);
      if (result.status === 'error') {
        this._crash('error', result.result);
        return;
      }
    }
    // Pump async jobs and collect outbox messages
    this._proc.tick();

    // ── Drain outbox — separate sv messages from app messages ─────────────────
    var pending: any[] = [];
    var m: any;
    while ((m = this._proc.recv()) !== null) {
      pending.push(m);
    }
    for (var mi = 0; mi < pending.length; mi++) {
      this._handleMessage(pending[mi]);
    }

    // ── Memory sampling ───────────────────────────────────────────────────────
    if (this._opts.memoryBudgetBytes > 0 &&
        this._tickCount - this._memSampleTick >= this._opts.memorySampleIntervalTicks) {
      this._memSampleTick = this._tickCount;
      // Ask child to report its memory asynchronously (result arrives in next tick)
      if (this._proc.alive) {
        this._proc.eval('if(typeof sv!=="undefined") sv.memInfo();');
      }
    }

    // ── Budget checks ─────────────────────────────────────────────────────────

    // CPU rolling window
    if (this._opts.cpuTickBudget > 0) {
      var windowAge = this._tickCount - this._windowStart;
      if (windowAge >= this._opts.cpuWindowTicks) {
        if (this._cpuWindow > this._opts.cpuTickBudget) {
          this._crash('budget', 'CPU tick budget exceeded: ' +
            this._cpuWindow + ' / ' + this._opts.cpuTickBudget +
            ' ticks in ' + windowAge + ' frames');
          return;
        }
        // Reset window
        this._cpuWindow  = 0;
        this._windowStart = this._tickCount;
      }
    }

    // Heartbeat timeout (convert ms → ticks at ~50 fps; 1 tick ≈ 20 ms)
    if (this._opts.heartbeatIntervalMs > 0 && this._lastHeartbeat > 0) {
      var nowTicks  = (kernel && kernel.getTicks) ? kernel.getTicks() : this._tickCount * 20;
      var elapsed   = nowTicks - this._lastHeartbeat;
      if (elapsed > this._opts.heartbeatIntervalMs) {
        this._crash('timeout', 'No heartbeat for ' + elapsed + ' ms (limit ' +
          this._opts.heartbeatIntervalMs + ' ms)');
        return;
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _start(): void {
    try {
      var code = SUPERVISOR_PREAMBLE + '\n' + this._code;
      this._proc       = JSProcess.spawn(code, this.name);
      this._state      = 'running';
      this._startTime  = (kernel && kernel.getTicks) ? kernel.getTicks() : 0;
      this._lastHeartbeat = this._startTime;
      this._cpuTicks   = 0;
      this._cpuWindow  = 0;
      this._windowStart = this._tickCount;
      this._memSampleTick = this._tickCount;
      this._crashReason = null;
      this._crashError  = null;
    } catch (e: any) {
      this._state      = 'crashed';
      this._crashReason = 'error';
      this._crashError  = String(e);
    }
  }

  private _crash(reason: CrashReason, error: string | undefined): void {
    this._crashReason = reason;
    this._crashError  = error || null;

    // Add crash log entry
    this._pushLog('error', '[CRASH] reason=' + reason + (error ? ' error=' + error : ''));

    // Kill underlying process
    if (this._proc && this._proc.alive) {
      try { this._proc.terminate(); } catch (_) {}
    }
    this._proc = null;

    // Fire crash callbacks
    var ev: CrashEvent = {
      reason,
      error,
      timestamp: (kernel && kernel.getTicks) ? kernel.getTicks() : 0,
      restarts:  this._restarts,
    };
    for (var i = 0; i < this._onCrashCbs.length; i++) {
      try { this._onCrashCbs[i](ev); } catch (_) {}
    }

    // Decide whether to restart
    var shouldRestart = false;
    switch (this._opts.restartPolicy) {
      case 'always':     shouldRestart = true; break;
      case 'on-failure': shouldRestart = reason !== 'killed'; break;
      case 'on-crash':   shouldRestart = (reason === 'error' || reason === 'timeout' ||
                                          reason === 'budget' || reason === 'oom' ||
                                          reason === 'exited'); break;
      default:           shouldRestart = false; break;
    }

    if (shouldRestart && this._restarts < this._opts.maxRestarts) {
      this._state = 'restarting';
      // Compute restart tick (convert ms delay → approx ticks at 50 fps = 20 ms/tick)
      var delayTicks = Math.max(1, Math.round(this._opts.restartDelayMs / 20));
      this._restartAt = this._tickCount + delayTicks;
    } else {
      this._state = 'crashed';
    }
  }

  private _killProc(reason: CrashReason): void {
    this._crashReason = reason;
    if (this._proc && this._proc.alive) {
      try { this._proc.terminate(); } catch (_) {}
    }
    this._proc = null;
  }

  private _doRestart(): void {
    this._restarts++;
    this._pushLog('info', '[RESTART] attempt ' + this._restarts + '/' + this._opts.maxRestarts);
    this._start();
  }

  private _handleMessage(raw: any): void {
    // Detect supervisor protocol messages { __sv: ... }
    if (raw !== null && typeof raw === 'object' && typeof raw.__sv === 'string') {
      var svType = raw.__sv;
      if (svType === 'hb') {
        // Heartbeat
        this._lastHeartbeat = (kernel && kernel.getTicks) ? kernel.getTicks() : this._tickCount * 20;
      } else if (svType === 'log') {
        // Log capture
        var level = String(raw.level || 'info');
        var msg   = String(raw.msg   || '');
        this._pushLog(level, msg);
      } else if (svType === 'mem') {
        // Memory snapshot
        var used = Number(raw.used) || 0;
        this._memoryBytes = used;
        if (this._opts.memoryBudgetBytes > 0 && used > this._opts.memoryBudgetBytes) {
          this._crash('oom', 'Memory budget exceeded: ' + used +
            ' bytes (limit ' + this._opts.memoryBudgetBytes + ' bytes)');
        }
      }
      // Do NOT forward __sv messages to app callbacks
      return;
    }

    // Forward non-sv messages to application onMessage handlers
    for (var ci = 0; ci < this._onMessageCbs.length; ci++) {
      try { this._onMessageCbs[ci](raw); } catch (_) {}
    }
  }

  private _pushLog(level: string, msg: string): void {
    var size = this._opts.logBufferSize;
    if (size <= 0) return;
    var now  = (kernel && kernel.getTicks) ? kernel.getTicks() : 0;
    var line = '[' + now + '] [' + level.toUpperCase() + '] ' + this.name + ': ' + msg;
    this._logs[this._logHead % size] = line;
    this._logHead++;
  }

  private _getLogSnapshot(): string[] {
    var size   = this._opts.logBufferSize;
    var count  = Math.min(this._logHead, size);
    var result = new Array(count);
    // Read in chronological order (oldest first)
    var start  = this._logHead >= size ? this._logHead % size : 0;
    for (var li = 0; li < count; li++) {
      result[li] = this._logs[(start + li) % size];
    }
    return result;
  }
}

// ─── ProcessSupervisor ────────────────────────────────────────────────────────

/**
 * Manages a collection of supervised processes and drives them from a single
 * WM-frame tick.
 *
 * One supervisor instance is typically sufficient for an entire application or
 * OS service manager.  Register it with the WM frame via startCoroutine().
 */
export class ProcessSupervisor {
  private _children: SupervisedProcess[] = [];
  private _coroId:   number = -1;

  // ── Factory ────────────────────────────────────────────────────────────────

  /**
   * Spawn a new supervised child process.
   *
   * @param code   JavaScript / TypeScript source to run in the child.
   * @param opts   Supervision options (heartbeat, budgets, restart policy, …).
   * @returns      A SupervisedProcess handle.
   */
  spawn(code: string, opts: SupervisedProcessOptions = {}): SupervisedProcess {
    var sp = new SupervisedProcess(code, opts);
    this._children.push(sp);
    return sp;
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  /**
   * Drive all supervised children for one WM frame.
   * Call this from your WM app's per-frame handler, or use startCoroutine()
   * to register an autonomous background coroutine.
   */
  tick(): void {
    for (var i = 0; i < this._children.length; i++) {
      try { this._children[i]._tick(); } catch (_) {}
    }
    // Evict children that are permanently dead and have no restart pending
    this._children = this._children.filter(function(c) {
      return c.state !== 'killed';
    });
  }

  /**
   * Register a self-sustaining WM-frame coroutine so you don't have to call
   * tick() manually.  Returns the coroutine id for cancellation.
   *
   * Requires the threadManager (available once the WM has started).
   */
  startCoroutine(): number {
    if (this._coroId >= 0) return this._coroId;
    var self = this;
    this._coroId = threadManager.runCoroutine('process-supervisor', function(): 'done' | 'pending' {
      self.tick();
      return 'pending';   // runs forever
    });
    return this._coroId;
  }

  /** Stop the autonomous coroutine started by startCoroutine(). */
  stopCoroutine(): void {
    if (this._coroId >= 0) {
      threadManager.cancelCoroutine(this._coroId);
      this._coroId = -1;
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** All supervised processes currently managed by this supervisor. */
  children(): SupervisedProcess[] {
    return this._children.slice();
  }

  /** Snapshot stats for all children. */
  allStats(): SupervisedProcessStats[] {
    return this._children.map(function(c) { return c.stats(); });
  }

  /**
   * Kill and release all supervised processes.
   * Also stops the autonomous coroutine if running.
   */
  shutdown(): void {
    this.stopCoroutine();
    for (var i = 0; i < this._children.length; i++) {
      try { this._children[i].kill(); } catch (_) {}
    }
    this._children = [];
  }
}

// ── Module-level singleton (optional convenience) ─────────────────────────────

/**
 * Default module-level ProcessSupervisor.
 * Suitable for use from the REPL or simple apps.
 * For complex apps, create your own instance with `new ProcessSupervisor()`.
 */
export const supervisor = new ProcessSupervisor();
