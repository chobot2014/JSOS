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

export type ProcessState = 'ready' | 'running' | 'blocked' | 'terminated' | 'waiting';

export interface ProcessContext {
  pid:           number;
  ppid:          number;
  name:          string;
  state:         ProcessState;
  priority:      number;
  timeSlice:     number;
  remainingTime: number;
  cpuTime:       number;
  startTime:     number;   // kernel.getTicks() at process creation
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
}

export type SchedulingAlgorithm = 'round-robin' | 'priority' | 'real-time';

export class ProcessScheduler {
  private processes     = new Map<number, ProcessContext>();
  private readyQueue:    ProcessContext[] = [];
  private blockedQueue:  ProcessContext[] = [];
  private currentProcess: ProcessContext | null = null;
  private nextPid        = 1;
  private timeSlice      = 10;   // frames (~200 ms at 50 fps)
  private algorithm: SchedulingAlgorithm = 'round-robin';

  constructor() {
    // Processes are created lazily via initBootProcesses() or registerProcess().
    // Wiring fatal signals: when signalManager would "default-terminate" a pid,
    // it calls this callback so the scheduler can remove the process from queues.
    signalManager.setTerminateCallback((pid: number) => {
      this.terminateProcess(pid, 128 + 9 /* SIGKILL */);
    });
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

    var idle: ProcessContext = {
      pid: opts.idlePid, ppid: 0, name: 'idle', state: 'ready',
      priority: 39, timeSlice: 0, remainingTime: 0, cpuTime: 0,
      startTime: now, threadId: opts.idleTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set(),
    };

    var kproc: ProcessContext = {
      pid: opts.kernelPid, ppid: 0, name: 'kernel', state: 'ready',
      priority: 0, timeSlice: this.timeSlice, remainingTime: this.timeSlice,
      cpuTime: 0, startTime: now, threadId: opts.kernelTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set([0, 1, 2]),
    };

    var init: ProcessContext = {
      pid: opts.initPid, ppid: opts.kernelPid, name: 'init', state: 'running',
      priority: 10, timeSlice: this.timeSlice, remainingTime: this.timeSlice,
      cpuTime: 0, startTime: now, threadId: opts.initTid,
      registers: { pc: 0, sp: 0, fp: 0 },
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles: new Set([0, 1, 2]),
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
    var pid = this.nextPid++;
    var now = kernel.getTicks();

    var ctx: ProcessContext = {
      pid,
      ppid,
      name:          options.name || 'process-' + pid,
      state:         'ready',
      priority:      options.priority  !== undefined ? options.priority  : 10,
      timeSlice:     options.timeSlice !== undefined ? options.timeSlice : this.timeSlice,
      remainingTime: options.timeSlice !== undefined ? options.timeSlice : this.timeSlice,
      cpuTime:       0,
      startTime:     now,
      threadId:      options.threadId !== undefined ? options.threadId : -1,
      registers:     { pc: 0, sp: options.memory.stackEnd, fp: options.memory.stackEnd },
      memory:        options.memory,
      openFiles:     new Set([0, 1, 2]),
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
    // Only enqueue if it's not already in ready/blocked queue.
    for (var i = 0; i < this.readyQueue.length; i++) {
      if (this.readyQueue[i].pid === ctx.pid) return;
    }
    if (ctx.state === 'ready') this.readyQueue.push(ctx);
  }

  terminateProcess(pid: number, exitCode: number = 0): boolean {
    var process = this.processes.get(pid);
    if (!process || process.state === 'terminated') return false;

    process.state    = 'terminated';
    process.exitCode = exitCode;

    this.readyQueue   = this.readyQueue.filter(function(p)   { return p.pid !== pid; });
    this.blockedQueue = this.blockedQueue.filter(function(p) { return p.pid !== pid; });

    // Wake any process waiting for this one.
    this.processes.forEach(function(p) {
      if (p.waitingFor === pid) {
        p.state        = 'ready';
        p.waitingFor   = undefined;
      }
    });

    // Rebuild readyQueue to include newly-woken processes.
    this.processes.forEach((p) => {
      if (p.state === 'ready') {
        var already = false;
        for (var i = 0; i < this.readyQueue.length; i++) {
          if (this.readyQueue[i].pid === p.pid) { already = true; break; }
        }
        if (!already) this.readyQueue.push(p);
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

    if (this.currentProcess.remainingTime <= 0) {
      this.currentProcess.remainingTime = this.currentProcess.timeSlice;
      this.schedule();
    }
  }

  schedule(): ProcessContext | null {
    if (this.readyQueue.length === 0) {
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
      this.readyQueue.push(this.currentProcess);
    }

    var next: ProcessContext;
    switch (this.algorithm) {
      case 'priority':   next = this._schedulePriority();  break;
      case 'real-time':  next = this._scheduleRealTime();  break;
      default:           next = this._scheduleRoundRobin(); break;
    }

    next.state          = 'running';
    this.currentProcess = next;
    // Synchronise the kernel-thread scheduler so threadManager.tick() picks
    // the same thread as the chosen process.
    if (next.threadId >= 0) threadManager.setCurrentTid(next.threadId);

    return next;
  }

  // ── Scheduling algorithms ─────────────────────────────────────────────────

  private _scheduleRoundRobin(): ProcessContext {
    return this.readyQueue.shift()!;
  }

  private _schedulePriority(): ProcessContext {
    this.readyQueue.sort(function(a, b) { return a.priority - b.priority; });
    return this.readyQueue.shift()!;
  }

  private _scheduleRealTime(): ProcessContext {
    var rt: ProcessContext[] = [];
    for (var i = 0; i < this.readyQueue.length; i++) {
      if (this.readyQueue[i].priority <= 5) rt.push(this.readyQueue[i]);
    }
    if (rt.length > 0) {
      rt.sort(function(a, b) { return a.priority - b.priority; });
      var idx = this.readyQueue.indexOf(rt[0]);
      this.readyQueue.splice(idx, 1);
      return rt[0];
    }
    return this._schedulePriority();
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
