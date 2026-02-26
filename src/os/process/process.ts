/**
 * JSOS Process Manager — Phase 6
 *
 * Manages the process table, fork/exec/waitpid lifecycle, and per-process
 * virtual memory area (VMA) tracking used by /proc/self/maps.
 *
 * Phase 6 uses a synchronous cooperative model — no ring-3 CPU transition yet
 * (that is Phase 9).  exec() runs the provided TypeScript function as a
 * stand-in for the real ELF entry point.
 */

import { FDTable } from '../core/fdtable.js';
import { signalManager } from './signals.js';
import { scheduler } from './scheduler.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Describes one virtual memory area in a process's address space. */
export interface VMA {
  start: number;
  end:   number;
  prot:  string;   // e.g. "r-x", "rw-"
  name:  string;   // e.g. "[stack]", "hello_world"
}

export type ProcessState = 'ready' | 'running' | 'blocked' | 'sleeping' | 'dead';

export class Process {
  pid:      number;
  ppid:     number;
  state:    ProcessState;
  exitCode: number;
  fdTable:  FDTable;
  vmas:     VMA[];
  /** Current working directory. */
  cwd:      string;
  /** argv[0] or command name. */
  name:     string;

  constructor(pid: number, ppid: number) {
    this.pid      = pid;
    this.ppid     = ppid;
    this.state    = 'ready';
    this.exitCode = 0;
    this.fdTable  = new FDTable();
    this.vmas     = [];
    this.cwd      = '/';
    this.name     = 'process-' + pid;
  }

  addVMA(start: number, end: number, prot: string, name: string): void {
    this.vmas.push({ start, end, prot, name });
  }
}

export class ProcessManager {
  private _procs:      Map<number, Process> = new Map();
  private _nextPid:    number = 1;
  private _currentPid: number = 1;

  constructor() {
    // PID 1: the initial kernel process with 4 canonical VMAs.
    var init = new Process(this._nextPid++, 0);
    init.name = 'jsos';
    init.addVMA(0x08048000, 0x08049000, 'r-x', '[code]');
    init.addVMA(0x08049000, 0x0804a000, 'rw-', '[data]');
    init.addVMA(0x0804a000, 0x0804b000, 'rw-', '[heap]');
    init.addVMA(0xbffff000, 0xc0000000, 'rwx', '[stack]');
    init.state = 'running';
    this._procs.set(init.pid, init);
    this._currentPid = init.pid;
  }

  /**
   * Create a child process by copying the current process's state.
   * Returns the child PID (caller is always the "parent").
   * Also registers the child in the ProcessScheduler's ready queue.
   * Phase 6 does not fork address spaces at the hardware level (Phase 9).
   */
  fork(): number {
    var parent = this._procs.get(this._currentPid);
    if (!parent) throw new Error('fork: no current process');

    var child = new Process(this._nextPid++, parent.pid);
    child.name    = parent.name;
    child.cwd     = parent.cwd;
    child.fdTable = parent.fdTable.clone();
    for (var i = 0; i < parent.vmas.length; i++) {
      var v = parent.vmas[i];
      child.addVMA(v.start, v.end, v.prot, v.name);
    }
    this._procs.set(child.pid, child);

    // Register the new child in the process scheduler so it appears in
    // 'ps' output, receives signals, and gets time-slice accounting.
    scheduler.registerProcess({
      pid:           child.pid,
      ppid:          child.ppid,
      name:          child.name,
      state:         'ready',
      priority:      10,
      timeSlice:     10,
      remainingTime: 10,
      cpuTime:       0,
      startTime:     kernel.getTicks(),
      threadId:      -1,   // no dedicated kernel thread yet
      registers:     { pc: 0, sp: 0, fp: 0 },
      memory:        { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 },
      openFiles:     new Set([0, 1, 2]),
    });

    return child.pid;
  }

  /**
   * Execute a TypeScript function inside a process (cooperative exec for Phase 6).
   * In Phase 9 this will be replaced by ELFLoader + kernel.jumpToUserMode.
   */
  execInProcess(pid: number, fn: () => number): void {
    var p = this._procs.get(pid);
    if (!p) throw new Error('execInProcess: no such PID ' + pid);
    p.exitCode = fn();
    p.state = 'dead';
  }

  /**
   * Block until pid changes state (Phase 6: process already ran synchronously).
   * Returns { pid, exitCode }.
   */
  waitpid(pid: number): { pid: number; exitCode: number } {
    var p = this._procs.get(pid);
    if (!p) return { pid: -1, exitCode: -1 };
    signalManager.send(this._currentPid, 17 /* SIGCHLD */);
    return { pid: p.pid, exitCode: p.exitCode };
  }

  /**
   * Send a signal to a process.
   * Delegates to signalManager, which may invoke the terminate callback
   * (→ scheduler.terminateProcess) for fatal default-action signals.
   */
  kill(pid: number, sig: number): boolean {
    var p = this._procs.get(pid);
    if (!p) return false;
    signalManager.send(pid, sig);
    // If fatal, mark dead in our own table too.
    if (p.state === 'dead') return true;
    var ctx = scheduler.getProcess(pid);
    if (ctx && ctx.state === 'terminated') {
      p.state    = 'dead';
      p.exitCode = ctx.exitCode || 0;
    }
    return true;
  }

  /** Return the current process's VMA count (used by /proc/self/maps). */
  selfVMAs(): number {
    var p = this._procs.get(this._currentPid);
    return p ? p.vmas.length : 0;
  }

  getProcess(pid: number): Process | null {
    return this._procs.get(pid) || null;
  }

  currentProcess(): Process | null {
    return this._procs.get(this._currentPid) || null;
  }

  getpid(): number  { return this._currentPid; }
  getppid(): number {
    var p = this._procs.get(this._currentPid);
    return p ? p.ppid : 0;
  }

  getAllPIDs(): number[] {
    var pids: number[] = [];
    this._procs.forEach(function(_p, pid) { pids.push(pid); });
    return pids;
  }

  /**
   * Adjust the scheduling priority of a process (item 715: nice).
   * Priority 0 = highest (real-time); 39 = lowest (idle).
   * Returns true if the process was found and updated.
   */
  setPriority(pid: number, value: number): boolean {
    var ctx = scheduler.getProcess(pid);
    if (!ctx) return false;
    ctx.priority = Math.max(0, Math.min(39, value));
    return true;
  }
}

export const processManager = new ProcessManager();
