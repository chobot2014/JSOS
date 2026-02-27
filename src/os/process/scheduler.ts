/**
 * JSOS Process Scheduler
 *
 * Implements multiple scheduling algorithms:
 * - Round-robin scheduling (default)
 * - Priority-based scheduling
 * - Real-time scheduling
 *
 * Manages process states, time slices, and context switching.
 *
 * Integration:
 *   • Hardware timer (100 Hz IRQ0) → kernel.registerSchedulerHook → threadManager.tick()
 *     Handles kernel-thread preemption and sleeping-thread wakeup.
 *   • WM event loop (~50 fps)       → scheduler.tick()
 *     Handles process-level CPU-time accounting, signal delivery, and
 *     time-slice preemption (calls schedule() when slice expires).
 *
 * These are deliberately separate so that process-level policy
 * (priority, signals, wait) lives entirely in TypeScript (agents.md rule).
 */

import { threadManager } from './threads.js';
import { signalManager } from './signals.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── O(log n) run queue — binary min-heap keyed by (priority, seqNo) ─────────

/**
 * Binary min-heap that orders `ProcessContext` objects by ascending
 * `priority`, breaking ties by ascending insertion-sequence number so that
 * equal-priority processes are served FIFO (round-robin within a class).
 *
 * All core ops are O(log n):
 *   push    – O(log n)
 *   pop     – O(log n)
 *   remove  – O(n) scan + O(log n) sift (acceptable; only on process exit)
 *
 * peek and size are O(1).
 */
class RunQueue {
  private _heap:  ProcessContext[] = [];
  private _seqNo: Map<number, number> = new Map(); // pid → insertion seqNo
  private _seq    = 0;

  get size(): number { return this._heap.length; }

  push(p: ProcessContext): void {
    this._seqNo.set(p.pid, this._seq++);
    this._heap.push(p);
    this._siftUp(this._heap.length - 1);
  }

  /** Remove and return the highest-priority (lowest numeric priority) process. */
  pop(): ProcessContext | undefined {
    if (this._heap.length === 0) return undefined;
    const top = this._heap[0];
    const last = this._heap.pop()!;
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._siftDown(0);
    }
    this._seqNo.delete(top.pid);
    return top;
  }

  peek(): ProcessContext | undefined { return this._heap[0]; }

  /** Remove a specific process by pid (O(n) scan + O(log n) sift). */
  remove(pid: number): boolean {
    const i = this._heap.findIndex(p => p.pid === pid);
    if (i === -1) return false;
    const last = this._heap.pop()!;
    if (i < this._heap.length) {
      this._heap[i] = last;
      this._siftUp(i);
      this._siftDown(i);
    }
    this._seqNo.delete(pid);
    return true;
  }

  has(pid: number): boolean {
    return this._seqNo.has(pid);
  }

  toArray(): ProcessContext[] { return [...this._heap]; }

  private _cmp(a: ProcessContext, b: ProcessContext): boolean {
    // Lower priority number = higher urgency.  Tie-break by seqNo (FIFO).
    const pa = a.priority, pb = b.priority;
    if (pa !== pb) return pa < pb;
    return (this._seqNo.get(a.pid) ?? 0) < (this._seqNo.get(b.pid) ?? 0);
  }

  private _siftUp(i: number): void {
    const heap = this._heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._cmp(heap[i], heap[parent])) {
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      } else break;
    }
  }

  private _siftDown(i: number): void {
    const heap = this._heap;
    const n = heap.length;
    for (;;) {
      let best = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._cmp(heap[l], heap[best])) best = l;
      if (r < n && this._cmp(heap[r], heap[best])) best = r;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]];
      i = best;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export type ProcessState = 'ready' | 'running' | 'blocked' | 'terminated' | 'waiting';

export interface ProcessContext {
  pid:           number;
  ppid:          number;
  /** [Item 154] Process group ID. */
  groupId:       number;
  name:          string;
  state:         ProcessState;
  priority:      number;
  /** [Item 160] Per-process scheduling policy (overrides global algorithm). */
  schedPolicy:   SchedulingAlgorithm | 'inherit';
  timeSlice:     number;
  remainingTime: number;
  cpuTime:       number;
  startTime:     number;   // kernel.getTicks() at process creation
  /** [Item 164] Wall-clock start time in ms (kernel.getTime()). */
  wallTimeStart: number;
  /** [Item 164] Total I/O bytes read+written (incremented by fs/net). */
  ioBytes:       number;
  /** [Item 161] CPU affinity bitmask (bit N = allowed on logical CPU N). */
  cpuMask:       number;
  /**
   * [Item 162] Per-process resource limits.
   * maxRSS    — max resident pages (0 = unlimited)
   * maxFDs    — max open file descriptors (0 = unlimited)
   * maxCPUMs  — max total CPU time in ms before SIGXCPU (0 = unlimited)
   */
  limits:        { maxRSS: number; maxFDs: number; maxCPUMs: number };
  /** Associated kernel TID (-1 = no dedicated thread). */
  threadId:      number;
  registers: {
    pc: number;
    sp: number;
    fp: number;
    [key: string]: any;
  };
  memory: {
    heapStart:  number;
    heapEnd:    number;
    stackStart: number;
    stackEnd:   number;
  };
  openFiles:   Set<number>;
  waitingFor?: number;   // PID this process is waiting for
  exitCode?:   number;
  /**
   * Physical address of the 512-byte FXSAVE/FXRSTOR buffer allocated by
   * `kernel.fpuAllocState()` on first context switch away from this process.
   * 0 = not yet allocated (lazy init on first preemption).
   */
  fpuStateAddr: number;
}

export type SchedulingAlgorithm = 'round-robin' | 'priority' | 'real-time';

export class ProcessScheduler {
  private processes     = new Map<number, ProcessContext>();
  private readyQueue    = new RunQueue();   // O(log n) min-heap
  private blockedQueue:  ProcessContext[] = [];
  private currentProcess: ProcessContext | null = null;
  private nextPid        = 1;
  private timeSlice      = 10;   // frames (~200 ms at 50 fps)
  private algorithm: SchedulingAlgorithm = 'round-robin';

  /**
   * Hooks called synchronously when a process is terminated (items 148 & 149).
   * Registered by ProcessManager to release per-process resources (FDs, VMAs).
   */
  private _exitHooks: Array<(pid: number) => void> = [];

  constructor() {
    // Wiring fatal signals: when signalManager would "default-terminate" a pid,
    // it calls this callback so the scheduler can remove the process from queues.
    signalManager.setTerminateCallback((pid: number) => {
      this.terminateProcess(pid, 128 + 9 /* SIGKILL */);
    });
    // [Item 156] When a signal is sent to a blocked process, wake it from any
    // slow syscall so it can return EINTR on the next scheduler tick.
    signalManager.setBlockedCallback((pid: number) => {
      this.unblockProcess(pid);
    });
  }

  /**
   * Register a callback to be invoked synchronously when any process terminates.
   * Used by ProcessManager to close FDs (item 148) and release VMAs (item 149).
   */
  addProcessExitHook(fn: (pid: number) => void): void {
    this._exitHooks.push(fn);
  }

  // ── Boot-time initialisation ───────────────────────────────────────────────

  /**
   * Called from main.ts *after* threadManager threads exist.
   * Creates the three well-known boot ProcessContexts and links them to
   * their TIDs so schedule() can drive threadManager.setCurrentTid().
   */
  initBootProcesses(opts: {
    idlePid:    number; idleTid:    number;
    kernelPid:  number; kernelTid:  number;
    initPid:    number; initTid:    number;
  }): void {
    var now = kernel.getTicks();

    var defaultLimits = { maxRSS: 0, maxFDs: 0, maxCPUMs: 0 };

    var idle: ProcessContext = {
      pid: opts.idlePid, ppid: 0, groupId: 0, name: 'idle', state: 'ready',
      priority: 39, schedPolicy: 'inherit', timeSlice: 0, remainingTime: 0,
      cpuTime: 0, startTime: now, wallTimeStart: now, ioBytes: 0,
      cpuMask: 0xffffffff, limits: defaultLimits, threadId: opts.idleTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set(),
      fpuStateAddr: 0,
    };

    var kproc: ProcessContext = {
      pid: opts.kernelPid, ppid: 0, groupId: 0, name: 'kernel', state: 'ready',
      priority: 0, schedPolicy: 'inherit', timeSlice: this.timeSlice,
      remainingTime: this.timeSlice, cpuTime: 0, startTime: now,
      wallTimeStart: now, ioBytes: 0, cpuMask: 0xffffffff,
      limits: defaultLimits, threadId: opts.kernelTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set([0, 1, 2]),
      fpuStateAddr: 0,
    };

    var init: ProcessContext = {
      pid: opts.initPid, ppid: opts.kernelPid, groupId: opts.initPid,
      name: 'init', state: 'running',
      priority: 10, schedPolicy: 'inherit', timeSlice: this.timeSlice,
      remainingTime: this.timeSlice, cpuTime: 0, startTime: now,
      wallTimeStart: now, ioBytes: 0, cpuMask: 0xffffffff,
      limits: defaultLimits, threadId: opts.initTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set([0, 1, 2]),
      fpuStateAddr: 0,
    };

    this.processes.set(idle.pid,  idle);
    this.processes.set(kproc.pid, kproc);
    this.processes.set(init.pid,  init);

    this.readyQueue.push(idle);
    this.readyQueue.push(kproc);
    this.currentProcess = init;   // init runs first
    this.nextPid = opts.initPid + 1;
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────

  createProcess(ppid: number, options: {
    name?:     string;
    priority?: number;
    timeSlice?: number;
    threadId?:  number;
    memory:    ProcessContext['memory'];
  }): ProcessContext {
    // [Item 153] PID namespace: wrap at 32768 (Linux convention).
    var pid = this.nextPid;
    this.nextPid = (this.nextPid >= 32767) ? 2 : this.nextPid + 1;
    var now = kernel.getTicks();

    var parent = this.processes.get(ppid);
    var ctx: ProcessContext = {
      pid,
      ppid,
      // [Item 154] Inherit process group from parent; new session leaders
      // get their own groupId (defaults to pid if no parent group).
      groupId:       parent ? parent.groupId : pid,
      name:          options.name || 'process-' + pid,
      state:         'ready',
      priority:      options.priority  !== undefined ? options.priority  : 10,
      schedPolicy:   'inherit',
      timeSlice:     options.timeSlice !== undefined ? options.timeSlice : this.timeSlice,
      remainingTime: options.timeSlice !== undefined ? options.timeSlice : this.timeSlice,
      cpuTime:       0,
      startTime:     now,
      wallTimeStart: now,
      ioBytes:       0,
      cpuMask:       0xffffffff,
      limits:        { maxRSS: 0, maxFDs: 0, maxCPUMs: 0 },
      threadId:      options.threadId !== undefined ? options.threadId : -1,
      registers:     { pc: 0, sp: options.memory.stackEnd, fp: options.memory.stackEnd },
      memory:        options.memory,
      openFiles:     new Set([0, 1, 2]),
      fpuStateAddr:  0,
    };

    this.processes.set(pid, ctx);
    this.readyQueue.push(ctx);
    return ctx;
  }

  /**
   * Register a process created externally (e.g. by ProcessManager.fork())
   * so the scheduler knows about it and can schedule/signal it.
   */
  registerProcess(ctx: ProcessContext): void {
    if (!this.processes.has(ctx.pid)) {
      this.processes.set(ctx.pid, ctx);
    }
    // Only enqueue if not already in ready queue.
    if (ctx.state === 'ready' && !this.readyQueue.has(ctx.pid)) {
      this.readyQueue.push(ctx);
    }
  }

  terminateProcess(pid: number, exitCode: number = 0): boolean {
    var process = this.processes.get(pid);
    if (!process || process.state === 'terminated') return false;

    process.state    = 'terminated';
    process.exitCode = exitCode;

    // ── Items 148, 149, 156-158: release per-process resources before removing queues.
    for (var h = 0; h < this._exitHooks.length; h++) {
      try { this._exitHooks[h](pid); } catch (_) { /* never let a hook abort the reaper */ }
    }
    // Clean up signal state (items 157, 158) — masks, pending signals, handlers.
    signalManager.cleanup(pid);

    // Remove from queues — O(n) for readyQueue, O(n) for blocked.
    this.readyQueue.remove(pid);
    this.blockedQueue = this.blockedQueue.filter(function(p) { return p.pid !== pid; });

    // Wake any process waiting for this one — O(n) scan, acceptable.
    this.processes.forEach((p) => {
      if (p.waitingFor === pid) {
        p.state      = 'ready';
        p.waitingFor = undefined;
        // Push directly into the heap; no second full-table scan needed.
        if (!this.readyQueue.has(p.pid)) this.readyQueue.push(p);
      }
    });

    if (this.currentProcess && this.currentProcess.pid === pid) {
      this.currentProcess = null;
      this.schedule();
    }

    return true;
  }

  blockProcess(pid: number): boolean {
    var process = this.processes.get(pid);
    if (!process || process.state !== 'running') return false;
    process.state = 'blocked';
    this.blockedQueue.push(process);
    if (this.currentProcess && this.currentProcess.pid === pid) {
      this.currentProcess = null;
      this.schedule();
    }
    return true;
  }

  unblockProcess(pid: number): boolean {
    for (var i = 0; i < this.blockedQueue.length; i++) {
      if (this.blockedQueue[i].pid === pid) {
        var process = this.blockedQueue.splice(i, 1)[0];
        process.state = 'ready';
        this.readyQueue.push(process);
        return true;
      }
    }
    return false;
  }

  waitForProcess(pid: number): { success: boolean; error?: string; errno?: number; value?: { pid: number; exitCode: number } } {
    var process = this.processes.get(pid);
    if (!process) return { success: false, error: 'No such process', errno: 3 };
    if (process.state === 'terminated') {
      var code = process.exitCode || 0;
      this.processes.delete(pid);
      return { success: true, value: { pid, exitCode: code } };
    }
    if (this.currentProcess) {
      this.currentProcess.state      = 'waiting';
      this.currentProcess.waitingFor = pid;
      this.blockedQueue.push(this.currentProcess);
    }
    return { success: false, error: 'Process not terminated', errno: 4 };
  }

  // ── Scheduler tick — called every WM frame (~50 fps) ──────────────────────

  /**
   * Process-level scheduling tick.
   * Deliberately does NOT call threadManager.tick() — that is the hardware-level
   * preemption hook registered separately with kernel.registerSchedulerHook.
   *
   * Responsibilities:
   *   1. Deliver pending signals to the running process
   *   2. Increment per-process CPU-time counter
   *   3. Decrement remaining time-slice; preempt if expired
   */
  tick(): void {
    if (!this.currentProcess) {
      this.schedule();
      return;
    }

    // Deliver any pending signals before the process gets more CPU time.
    signalManager.deliverPending(this.currentProcess.pid);

    // If signal delivery terminated the process, currentProcess is now null.
    if (!this.currentProcess) return;

    this.currentProcess.cpuTime++;
    this.currentProcess.remainingTime--;

    // [Item 162] Enforce max CPU time limit: send SIGXCPU when exceeded.
    const cpuMs = this.currentProcess.cpuTime * 20; // ~ 20 ms per tick at 50 fps
    if (this.currentProcess.limits.maxCPUMs > 0 &&
        cpuMs >= this.currentProcess.limits.maxCPUMs) {
      // SIGXCPU = 24; default action is terminate.
      signalManager.send(this.currentProcess.pid, 24 /* SIGXCPU */);
    }

    if (this.currentProcess.remainingTime <= 0) {
      this.currentProcess.remainingTime = this.currentProcess.timeSlice;
      this.schedule();
    }
  }

  schedule(): ProcessContext | null {
    if (this.readyQueue.size === 0) {
      var idleProc = this.processes.get(0);
      if (idleProc) {
        idleProc.state      = 'running';
        this.currentProcess = idleProc;
        if (idleProc.threadId >= 0) threadManager.setCurrentTid(idleProc.threadId);
      }
      return idleProc || null;
    }

    // Preempt current process: put back on ready queue if still runnable.
    if (this.currentProcess && this.currentProcess.state === 'running') {
      this.currentProcess.state = 'ready';
      // ── FPU/SSE save (item 147) ─────────────────────────────────────────
      // Lazily allocate an FXSAVE area on the first preemption of this process.
      if (this.currentProcess.fpuStateAddr === 0) {
        this.currentProcess.fpuStateAddr = kernel.fpuAllocState ? kernel.fpuAllocState() : 0;
      }
      if (this.currentProcess.fpuStateAddr) {
        kernel.fpuSave && kernel.fpuSave(this.currentProcess.fpuStateAddr);
      }
      this.readyQueue.push(this.currentProcess);
    }

    // With the RunQueue min-heap the three "algorithm" branches all reduce to
    // pop() — the heap already orders by priority+seqNo — but we keep the
    // branch for API compatibility and to allow future policy overrides.
    var next: ProcessContext;
    switch (this.algorithm) {
      case 'priority':   next = this._schedulePriority();  break;
      case 'real-time':  next = this._scheduleRealTime();  break;
      default:           next = this._scheduleRoundRobin(); break;
    }

    next.state          = 'running';
    this.currentProcess = next;
    // ── FPU/SSE restore (item 147) ──────────────────────────────────────────
    // Restore the incoming process's FPU/SSE state if it was previously saved.
    if (next.fpuStateAddr) {
      kernel.fpuRestore && kernel.fpuRestore(next.fpuStateAddr);
    }
    if (next.threadId >= 0) threadManager.setCurrentTid(next.threadId);

    return next;
  }

  // ── Scheduling algorithms — all O(log n) with RunQueue ───────────────────

  /**
   * Round-robin: pop the process that has been waiting longest among those
   * sharing the lowest priority number.  O(log n) — RunQueue FIFO tie-break.
   */
  private _scheduleRoundRobin(): ProcessContext {
    return this.readyQueue.pop()!;
  }

  /**
   * Priority: pure highest-priority-first.  O(log n) — RunQueue min-heap.
   * (Identical to round-robin here because the heap already orders correctly.)
   */
  private _schedulePriority(): ProcessContext {
    return this.readyQueue.pop()!;
  }

  /**
   * Real-time: prefer processes with schedPolicy='real-time' or global RT
   * algorithm with priority ≤ 5.  Falls back to priority scheduling.
   * [Item 160] Per-process schedPolicy is honoured: if the process's own
   * policy is 'real-time', it is promoted regardless of priority.
   */
  private _scheduleRealTime(): ProcessContext {
    const heapArr = this.readyQueue.toArray();
    // Processes with explicit RT policy OR priority ≤ 5 are candidates.
    const rtProc  = heapArr.filter(p =>
        p.schedPolicy === 'real-time' || (p.schedPolicy === 'inherit' && p.priority <= 5))
      .sort((a, b) => a.priority - b.priority)[0];
    if (rtProc) {
      this.readyQueue.remove(rtProc.pid);
      return rtProc;
    }
    return this.readyQueue.pop()!;
  }

  // ── Process group API (item 154) ─────────────────────────────────────────

  /** Get the process group ID of pid (returns pid if not found). */
  getpgid(pid: number): number {
    var p = this.processes.get(pid);
    return p ? p.groupId : pid;
  }

  /** Set the process group of pid.  pgid=0 means use pid as the new group ID. */
  setpgid(pid: number, pgid: number): boolean {
    var p = this.processes.get(pid);
    if (!p) return false;
    p.groupId = pgid === 0 ? pid : pgid;
    return true;
  }

  // ── Scheduling policy per-process (item 160) ──────────────────────────────

  /**
   * Set the scheduling policy for an individual process.
   * 'inherit' means the process follows the global scheduler algorithm.
   */
  setScheduler(pid: number, policy: SchedulingAlgorithm | 'inherit'): boolean {
    var p = this.processes.get(pid);
    if (!p) return false;
    p.schedPolicy = policy;
    return true;
  }

  getScheduler(pid: number): SchedulingAlgorithm | 'inherit' | null {
    var p = this.processes.get(pid);
    return p ? p.schedPolicy : null;
  }

  // ── CPU affinity (item 161) ───────────────────────────────────────────────

  /** Set the CPU affinity bitmask for pid (bit N = allowed on logical CPU N). */
  setCpuAffinity(pid: number, mask: number): boolean {
    var p = this.processes.get(pid);
    if (!p) return false;
    p.cpuMask = mask || 0xffffffff;
    return true;
  }

  getCpuAffinity(pid: number): number | null {
    var p = this.processes.get(pid);
    return p ? p.cpuMask : null;
  }

  // ── Per-process limits (item 162) ─────────────────────────────────────────

  setProcessLimits(pid: number, limits: Partial<ProcessContext['limits']>): boolean {
    var p = this.processes.get(pid);
    if (!p) return false;
    if (limits.maxRSS    !== undefined) p.limits.maxRSS    = limits.maxRSS;
    if (limits.maxFDs    !== undefined) p.limits.maxFDs    = limits.maxFDs;
    if (limits.maxCPUMs  !== undefined) p.limits.maxCPUMs  = limits.maxCPUMs;
    return true;
  }

  getProcessLimits(pid: number): ProcessContext['limits'] | null {
    var p = this.processes.get(pid);
    return p ? Object.assign({}, p.limits) : null;
  }

  // ── Process accounting (item 164) ─────────────────────────────────────────

  /**
   * Returns accounting data for pid:
   *   cpuMs    — total CPU time consumed (frames × 20 ms)
   *   wallMs   — elapsed wall-clock time (ticks since start × 10 ms @ 100 Hz)
   *   ioBytes  — total bytes read+written (updated by fs/net subsystems)
   */
  getAccounting(pid: number): { pid: number; cpuMs: number; wallMs: number; ioBytes: number } | null {
    var p = this.processes.get(pid);
    if (!p) return null;
    var now = kernel.getTicks();
    return {
      pid,
      cpuMs:   p.cpuTime * 20,
      wallMs:  (now - p.startTime) * 10,
      ioBytes: p.ioBytes,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getCurrentProcess(): ProcessContext | null { return this.currentProcess; }

  /** Returns the PID of the currently running process (default 1 before init). */
  getpid(): number { return this.currentProcess ? this.currentProcess.pid : 1; }

  setCurrentPid(pid: number): void {
    var p = this.processes.get(pid);
    if (p) this.currentProcess = p;
  }

  getProcess(pid: number): ProcessContext | undefined {
    return this.processes.get(pid);
  }

  getAllProcesses(): ProcessContext[] {
    var out: ProcessContext[] = [];
    this.processes.forEach(function(p) { out.push(p); });
    return out;
  }

  getLiveProcesses(): ProcessContext[] {
    var out: ProcessContext[] = [];
    this.processes.forEach(function(p) {
      if (p.state !== 'terminated') out.push(p);
    });
    return out;
  }

  setPriority(pid: number, priority: number): boolean {
    var p = this.processes.get(pid);
    if (!p) return false;
    p.priority = Math.max(0, Math.min(255, priority));
    return true;
  }

  setAlgorithm(algorithm: SchedulingAlgorithm): void { this.algorithm = algorithm; }
  getAlgorithm(): SchedulingAlgorithm { return this.algorithm; }
  setTimeSlice(frames: number): void { this.timeSlice = frames; }
}

export const scheduler = new ProcessScheduler();
