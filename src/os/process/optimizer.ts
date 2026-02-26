/**
 * optimizer.ts — Always-On System Optimizer & Profiler for JSOS
 *
 * Runs every WM frame (~50 fps) via wm.tick() → systemProfiler.tick().
 *
 * ─── What it tracks ───────────────────────────────────────────────────────────
 *   • Frame timing:     measured FPS, min/max/avg frame time, jitter
 *   • Memory:           heap free/used trend, low-memory warnings
 *   • JIT pool:         bytes used, % full, compiled/bailed/deopt counts
 *   • Scheduler:        per-process CPU time deltas, starvation detection,
 *                       context-switch rate
 *   • Subsystem marks:  any code can call profiler.mark/measure for timing
 *   • Event counters:   any code can call profiler.count('label') to track rates
 *
 * ─── Automatic optimizations ─────────────────────────────────────────────────
 *   • Process starvation: if a ready process hasn't gained CPU time in
 *     STARVATION_FRAMES frames → temporarily boost its priority to 1
 *   • JIT pool pressure:  logs a rate-limited warning when pool > 80% consumed
 *   • Memory pressure:    logs a rate-limited warning when heap free < MEM_LOW_MB
 *
 * ─── REPL API (sys.profiler) ─────────────────────────────────────────────────
 *   profiler.stats()     — full snapshot
 *   profiler.top(n?)     — top N processes by CPU time delta
 *   profiler.jit()       — JIT pool summary
 *   profiler.mem()       — memory summary
 *   profiler.fps()       — frame-timing summary
 *   profiler.counters()  — all event counters sorted by rate
 *   profiler.marks()     — all subsystem timing marks
 *   profiler.reset()     — clear rolling accumulators
 *   profiler.count(lbl)  — increment counter (call from any subsystem)
 *   profiler.mark(lbl)   — start a timing measurement
 *   profiler.measure(lbl)— stop timing and record (returns ms)
 */

import { scheduler } from './scheduler.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Frames since last CPU-time change before a process is considered starving. */
const STARVATION_FRAMES = 250;   // ~5 s at 50 fps

/** JIT pool size in bytes (must match jit.c JIT_MAIN_SIZE = 8 MB). */
const JIT_POOL_BYTES = 8 * 1024 * 1024;

/** Warn when JIT pool exceeds this fraction. */
const JIT_POOL_WARN_RATIO = 0.80;

/** Warn when heap free falls below this many MB. */
const MEM_LOW_MB = 1;

/** How many frames to suppress repeat warnings. */
const WARN_SUPPRESS_FRAMES = 500;

/** Rolling window size (frames) for FPS averaging. */
const FPS_WINDOW = 60;

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessSample {
  pid:        number;
  name:       string;
  state:      string;
  cpuTime:    number;
  cpuDelta:   number;   // CPU ticks gained this frame
  priority:   number;
  framesIdle: number;   // frames since cpuTime last changed (ready but not running)
}

export interface FrameStats {
  fps:        number;   // measured frames per second
  frameMin:   number;   // shortest frame (ms)
  frameMax:   number;   // longest frame (ms)
  frameAvg:   number;   // rolling average (ms)
  jitter:     number;   // std-dev of frame times (ms)
  totalFrames: number;
}

export interface JITStats {
  poolUsedBytes:  number;
  poolTotalBytes: number;
  poolPct:        number;   // 0-100
  compiled:       number;
  bailed:         number;
  deopts:         number;
}

export interface MemStats {
  totalBytes:  number;
  freeBytes:   number;
  usedBytes:   number;
  freeMB:      number;
}

export interface ProfilerSnapshot {
  uptime:     number;           // ms since boot
  frame:      FrameStats;
  mem:        MemStats;
  jit:        JITStats;
  processes:  ProcessSample[];
  counters:   Record<string, number>;
  markTimes:  Record<string, number>;   // label → last measured ms
}

// ─────────────────────────────────────────────────────────────────────────────
//  SystemProfiler
// ─────────────────────────────────────────────────────────────────────────────

export class SystemProfiler {
  // ── Frame timing ──────────────────────────────────────────────────────────
  private _lastTickMs:  number = 0;
  private _totalFrames: number = 0;
  private _frameTimes:  number[] = [];  // rolling window of raw frame durations (ms)
  private _frameMin:    number = Infinity;
  private _frameMax:    number = 0;

  // ── Per-process tracking ─────────────────────────────────────────────────
  private _prevCpuTime: Map<number, number> = new Map();
  private _framesIdle:  Map<number, number> = new Map();

  // ── JIT stats (injected by QJSJITHook) ───────────────────────────────────
  private _jitCompiled: number = 0;
  private _jitBailed:   number = 0;
  private _jitDeopts:   number = 0;

  // ── Event counters ────────────────────────────────────────────────────────
  private _counters: Map<string, number> = new Map();

  // ── Subsystem timing marks ────────────────────────────────────────────────
  private _markStart: Map<string, number> = new Map();
  private _markLast:  Map<string, number> = new Map();

  // ── Warning suppression ───────────────────────────────────────────────────
  private _warnJITAt:  number = -WARN_SUPPRESS_FRAMES;
  private _warnMemAt:  number = -WARN_SUPPRESS_FRAMES;

  // ─────────────────────────────────────────────────────────────────────────
  //  Main tick — called every WM frame
  // ─────────────────────────────────────────────────────────────────────────

  tick(): void {
    var now = kernel.getUptime();
    this._totalFrames++;

    // ── Frame timing ───────────────────────────────────────────────────────
    if (this._lastTickMs > 0) {
      var dt = now - this._lastTickMs;
      if (dt > 0) {
        this._frameTimes.push(dt);
        if (this._frameTimes.length > FPS_WINDOW)
          this._frameTimes.shift();
        if (dt < this._frameMin) this._frameMin = dt;
        if (dt > this._frameMax) this._frameMax = dt;
      }
    }
    this._lastTickMs = now;

    // ── Memory pressure check ─────────────────────────────────────────────
    var mem = kernel.getMemoryInfo();
    var freeMB = (mem.free / (1024 * 1024)) | 0;
    if (freeMB < MEM_LOW_MB &&
        this._totalFrames - this._warnMemAt > WARN_SUPPRESS_FRAMES) {
      kernel.serialPut('[profiler] LOW MEMORY: ' + freeMB + ' MB free\n');
      this._warnMemAt = this._totalFrames;
    }

    // ── JIT pool pressure check ───────────────────────────────────────────
    var jitUsed = kernel.jitUsedBytes();
    var jitRatio = jitUsed / JIT_POOL_BYTES;
    if (jitRatio > JIT_POOL_WARN_RATIO &&
        this._totalFrames - this._warnJITAt > WARN_SUPPRESS_FRAMES) {
      var jitPct = (jitRatio * 100) | 0;
      kernel.serialPut('[profiler] JIT pool ' + jitPct + '% full (' +
                       ((jitUsed / 1024) | 0) + ' KB / ' +
                       ((JIT_POOL_BYTES / 1024) | 0) + ' KB)\n');
      this._warnJITAt = this._totalFrames;
    }

    // ── Sync JIT stats from the live QJSJITHook (set by main.ts) ─────────
    var qjsJit = (globalThis as any).__qjsJit;
    if (qjsJit) {
      this._jitCompiled = qjsJit.compiledCount || 0;
      this._jitBailed   = qjsJit.bailedCount   || 0;
      this._jitDeopts   = qjsJit.deoptCount    || 0;
    }

    // ── Scheduler: per-process CPU delta + starvation detection ──────────
    var procs = scheduler.getLiveProcesses();
    for (var i = 0; i < procs.length; i++) {
      var p = procs[i];
      var prev = this._prevCpuTime.get(p.pid) ?? 0;
      var delta = p.cpuTime - prev;
      this._prevCpuTime.set(p.pid, p.cpuTime);

      // Track frames where a ready (runnable) process gains no CPU time
      if (p.state === 'ready' && delta === 0) {
        var idle = (this._framesIdle.get(p.pid) ?? 0) + 1;
        this._framesIdle.set(p.pid, idle);
        // Starvation: boost priority temporarily
        if (idle === STARVATION_FRAMES) {
          var boosted = Math.max(1, p.priority - 10);
          scheduler.setPriority(p.pid, boosted);
          kernel.serialPut('[profiler] starvation: pid ' + p.pid +
                           ' (' + p.name + ') priority → ' + boosted + '\n');
        }
      } else {
        this._framesIdle.set(p.pid, 0);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Public instrumentation API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Increment a named event counter.  Call from any subsystem to track
   * rates (e.g. profiler.count('net.rx'), profiler.count('draw.blit')).
   */
  count(label: string): void {
    this._counters.set(label, (this._counters.get(label) ?? 0) + 1);
  }

  /**
   * Start a timing measurement.  Pair with measure(label) to record elapsed ms.
   * Uses kernel.getUptime() (millisecond resolution).
   */
  mark(label: string): void {
    this._markStart.set(label, kernel.getUptime());
  }

  /**
   * Stop a timing measurement and record the elapsed milliseconds.
   * Returns the elapsed time in ms (0 if mark was never started).
   */
  measure(label: string): number {
    var start = this._markStart.get(label);
    if (start === undefined) return 0;
    var elapsed = kernel.getUptime() - start;
    this._markLast.set(label, elapsed);
    this._markStart.delete(label);
    return elapsed;
  }

  /**
   * Update JIT compilation statistics.  Called by QJSJITHook after each
   * compile attempt so the profiler can track success/failure rates.
   */
  reportJIT(compiled: number, bailed: number, deopts: number): void {
    this._jitCompiled = compiled;
    this._jitBailed   = bailed;
    this._jitDeopts   = deopts;
  }

  /**
   * Reset all rolling accumulators.  Useful after a burst startup phase
   * to get steady-state metrics.
   */
  reset(): void {
    this._frameTimes  = [];
    this._frameMin    = Infinity;
    this._frameMax    = 0;
    this._prevCpuTime = new Map();
    this._framesIdle  = new Map();
    this._counters    = new Map();
    this._markStart   = new Map();
    this._markLast    = new Map();
    this._jitCompiled = 0;
    this._jitBailed   = 0;
    this._jitDeopts   = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Query API (for sys.profiler)
  // ─────────────────────────────────────────────────────────────────────────

  /** Full snapshot of all metrics. */
  stats(): ProfilerSnapshot {
    return {
      uptime:    kernel.getUptime(),
      frame:     this.fps(),
      mem:       this.mem(),
      jit:       this.jit(),
      processes: this._processSamples(),
      counters:  this._counterMap(),
      markTimes: this._markMap(),
    };
  }

  /** Frame-timing summary. */
  fps(): FrameStats {
    var window = this._frameTimes;
    var n = window.length;
    if (n === 0) {
      return {
        fps: 0, frameMin: 0, frameMax: 0,
        frameAvg: 0, jitter: 0, totalFrames: this._totalFrames,
      };
    }
    var sum = 0;
    for (var i = 0; i < n; i++) sum += window[i];
    var avg = sum / n;
    var variance = 0;
    for (var j = 0; j < n; j++) {
      var d = window[j] - avg;
      variance += d * d;
    }
    var jitter = Math.sqrt(variance / n);
    return {
      fps:         avg > 0 ? Math.round(1000 / avg) : 0,
      frameMin:    Math.round(this._frameMin),
      frameMax:    Math.round(this._frameMax),
      frameAvg:    Math.round(avg * 10) / 10,
      jitter:      Math.round(jitter * 10) / 10,
      totalFrames: this._totalFrames,
    };
  }

  /** Memory summary. */
  mem(): MemStats {
    var info = kernel.getMemoryInfo();
    return {
      totalBytes: info.total,
      freeBytes:  info.free,
      usedBytes:  info.used,
      freeMB:     Math.round(info.free  / (1024 * 1024) * 10) / 10,
    };
  }

  /** JIT pool summary. */
  jit(): JITStats {
    var used = kernel.jitUsedBytes();
    return {
      poolUsedBytes:  used,
      poolTotalBytes: JIT_POOL_BYTES,
      poolPct:        Math.round(used / JIT_POOL_BYTES * 1000) / 10,
      compiled:       this._jitCompiled,
      bailed:         this._jitBailed,
      deopts:         this._jitDeopts,
    };
  }

  /**
   * Top N processes by CPU time (total ticks consumed since boot).
   * Defaults to all processes sorted descending.
   */
  top(n: number = 10): ProcessSample[] {
    var samples = this._processSamples();
    samples.sort(function(a, b) { return b.cpuTime - a.cpuTime; });
    return samples.slice(0, n);
  }

  /** All named event counters, sorted by count descending. */
  counters(): Array<{ label: string; count: number }> {
    var out: Array<{ label: string; count: number }> = [];
    this._counters.forEach(function(count, label) {
      out.push({ label, count });
    });
    out.sort(function(a, b) { return b.count - a.count; });
    return out;
  }

  /** All recorded subsystem timing measurements. */
  marks(): Array<{ label: string; lastMs: number }> {
    var out: Array<{ label: string; lastMs: number }> = [];
    this._markLast.forEach(function(ms, label) {
      out.push({ label, lastMs: ms });
    });
    out.sort(function(a, b) { return b.lastMs - a.lastMs; });
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _processSamples(): ProcessSample[] {
    var procs = scheduler.getLiveProcesses();
    var out: ProcessSample[] = [];
    for (var i = 0; i < procs.length; i++) {
      var p = procs[i];
      var prev = this._prevCpuTime.get(p.pid) ?? p.cpuTime;
      out.push({
        pid:        p.pid,
        name:       p.name,
        state:      p.state,
        cpuTime:    p.cpuTime,
        cpuDelta:   p.cpuTime - prev,
        priority:   p.priority,
        framesIdle: this._framesIdle.get(p.pid) ?? 0,
      });
    }
    return out;
  }

  private _counterMap(): Record<string, number> {
    var out: Record<string, number> = {};
    this._counters.forEach(function(count, label) { out[label] = count; });
    return out;
  }

  private _markMap(): Record<string, number> {
    var out: Record<string, number> = {};
    this._markLast.forEach(function(ms, label) { out[label] = ms; });
    return out;
  }
}

/** Singleton — the one profiler the whole OS uses. */
export const systemProfiler = new SystemProfiler();
