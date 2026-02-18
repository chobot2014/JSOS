/**
 * JSOS Process Scheduler
 *
 * Implements multiple scheduling algorithms:
 * - Round-robin scheduling
 * - Priority-based scheduling
 * - Real-time scheduling
 *
 * Manages process states, time slices, and context switching.
 */

import { SyscallResult } from './syscalls.js';

export type ProcessState = 'ready' | 'running' | 'blocked' | 'terminated' | 'waiting';

export interface ProcessContext {
  pid: number;
  ppid: number;
  name: string;
  state: ProcessState;
  priority: number;
  timeSlice: number;
  remainingTime: number;
  cpuTime: number;
  startTime: number;
  registers: {
    pc: number;    // Program counter
    sp: number;    // Stack pointer
    fp: number;    // Frame pointer
    [key: string]: any;
  };
  memory: {
    heapStart: number;
    heapEnd: number;
    stackStart: number;
    stackEnd: number;
  };
  openFiles: Set<number>;
  waitingFor?: number; // PID this process is waiting for
  exitCode?: number;
}

export type SchedulingAlgorithm = 'round-robin' | 'priority' | 'real-time';

export class ProcessScheduler {
  private processes = new Map<number, ProcessContext>();
  private readyQueue: ProcessContext[] = [];
  private blockedQueue: ProcessContext[] = [];
  private currentProcess: ProcessContext | null = null;
  private nextPid = 1;
  private timeSlice = 10; // milliseconds
  private algorithm: SchedulingAlgorithm = 'round-robin';

  constructor() {
    // Create the idle process (PID 0)
    this.createProcess(0, {
      name: 'idle',
      priority: 0,
      timeSlice: 0,
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 }
    });
    // Create the kernel process (PID 1)
    this.createProcess(0, {
      name: 'kernel',
      priority: 0,
      timeSlice: 0,
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 }
    });
    // Create the init process (PID 2)
    this.createProcess(1, {
      name: 'init',
      priority: 1,
      timeSlice: 10,
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 }
    });
  }

  /**
   * Create a new process
   */
  createProcess(ppid: number, options: {
    name?: string;
    priority?: number;
    timeSlice?: number;
    memory: ProcessContext['memory'];
  }): ProcessContext {
    const pid = this.nextPid++;
    const now = Date.now();

    const context: ProcessContext = {
      pid,
      ppid,
      name: options.name || 'process-' + pid,
      state: 'ready',
      priority: options.priority || 10,
      timeSlice: options.timeSlice || this.timeSlice,
      remainingTime: options.timeSlice || this.timeSlice,
      cpuTime: 0,
      startTime: now,
      registers: {
        pc: 0,
        sp: options.memory.stackEnd,
        fp: options.memory.stackEnd
      },
      memory: options.memory,
      openFiles: new Set([0, 1, 2]) // stdin, stdout, stderr
    };

    this.processes.set(pid, context);
    this.readyQueue.push(context);

    return context;
  }

  /**
   * Terminate a process
   */
  terminateProcess(pid: number, exitCode: number = 0): boolean {
    const process = this.processes.get(pid);
    if (!process || process.state === 'terminated') {
      return false;
    }

    process.state = 'terminated';
    process.exitCode = exitCode;

    // Remove from queues
    this.readyQueue = this.readyQueue.filter(p => p.pid !== pid);
    this.blockedQueue = this.blockedQueue.filter(p => p.pid !== pid);

    // Wake up waiting processes
    for (const p of this.processes.values()) {
      if (p.waitingFor === pid) {
        p.state = 'ready';
        p.waitingFor = undefined;
        this.readyQueue.push(p);
        this.blockedQueue = this.blockedQueue.filter(bp => bp.pid !== p.pid);
      }
    }

    // If this was the current process, schedule next
    if (this.currentProcess?.pid === pid) {
      this.currentProcess = null;
      this.schedule();
    }

    return true;
  }

  /**
   * Block a process (e.g., waiting for I/O)
   */
  blockProcess(pid: number, reason?: string): boolean {
    const process = this.processes.get(pid);
    if (!process || process.state !== 'running') {
      return false;
    }

    process.state = 'blocked';
    this.blockedQueue.push(process);

    if (this.currentProcess?.pid === pid) {
      this.currentProcess = null;
      this.schedule();
    }

    return true;
  }

  /**
   * Unblock a process
   */
  unblockProcess(pid: number): boolean {
    const index = this.blockedQueue.findIndex(p => p.pid === pid);
    if (index === -1) {
      return false;
    }

    const process = this.blockedQueue[index];
    this.blockedQueue.splice(index, 1);
    process.state = 'ready';
    this.readyQueue.push(process);

    return true;
  }

  /**
   * Wait for a specific process to terminate
   */
  waitForProcess(pid: number): SyscallResult<{ pid: number; exitCode: number }> {
    const process = this.processes.get(pid);
    if (!process) {
      return { success: false, error: 'No such process', errno: 3 };
    }

    if (process.state === 'terminated') {
      this.processes.delete(pid);
      return { success: true, value: { pid, exitCode: process.exitCode || 0 } };
    }

    // Block current process until target terminates
    if (this.currentProcess) {
      this.currentProcess.state = 'waiting';
      this.currentProcess.waitingFor = pid;
      this.blockedQueue.push(this.currentProcess);
    }

    return { success: false, error: 'Process not terminated', errno: 4 };
  }

  /**
   * Main scheduling function - called by timer interrupt
   */
  schedule(): ProcessContext | null {
    if (this.readyQueue.length === 0) {
      // No ready processes, run idle process
      return this.processes.get(0) || null;
    }

    // Save current process context
    if (this.currentProcess && this.currentProcess.state === 'running') {
      this.currentProcess.state = 'ready';
      this.readyQueue.push(this.currentProcess);
    }

    // Select next process based on algorithm
    let nextProcess: ProcessContext;

    switch (this.algorithm) {
      case 'round-robin':
        nextProcess = this.scheduleRoundRobin();
        break;
      case 'priority':
        nextProcess = this.schedulePriority();
        break;
      case 'real-time':
        nextProcess = this.scheduleRealTime();
        break;
      default:
        nextProcess = this.scheduleRoundRobin();
    }

    nextProcess.state = 'running';
    this.currentProcess = nextProcess;

    return nextProcess;
  }

  /**
   * Round-robin scheduling
   */
  private scheduleRoundRobin(): ProcessContext {
    return this.readyQueue.shift()!;
  }

  /**
   * Priority-based scheduling
   */
  private schedulePriority(): ProcessContext {
    // Sort by priority (lower number = higher priority)
    this.readyQueue.sort((a, b) => a.priority - b.priority);
    return this.readyQueue.shift()!;
  }

  /**
   * Real-time scheduling (fixed priority, preemptive)
   */
  private scheduleRealTime(): ProcessContext {
    // Real-time processes get highest priority
    const rtProcesses = this.readyQueue.filter(p => p.priority <= 5);
    if (rtProcesses.length > 0) {
      rtProcesses.sort((a, b) => a.priority - b.priority);
      const index = this.readyQueue.indexOf(rtProcesses[0]);
      this.readyQueue.splice(index, 1);
      return rtProcesses[0];
    }

    // Fall back to priority scheduling
    return this.schedulePriority();
  }

  /**
   * Handle time slice expiration
   */
  tick(): void {
    if (!this.currentProcess) return;

    this.currentProcess.cpuTime++;
    this.currentProcess.remainingTime--;

    if (this.currentProcess.remainingTime <= 0) {
      // Time slice expired, reschedule
      this.currentProcess.remainingTime = this.currentProcess.timeSlice;
      this.schedule();
    }
  }

  /**
   * Get current running process
   */
  getCurrentProcess(): ProcessContext | null {
    return this.currentProcess;
  }

  /**
   * Get process by PID
   */
  getProcess(pid: number): ProcessContext | undefined {
    return this.processes.get(pid);
  }

  /**
   * Get all processes
   */
  getAllProcesses(): ProcessContext[] {
    return Array.from(this.processes.values());
  }

  /**
   * Set scheduling algorithm
   */
  setAlgorithm(algorithm: SchedulingAlgorithm): void {
    this.algorithm = algorithm;
  }

  /**
   * Set time slice for round-robin scheduling
   */
  setTimeSlice(ms: number): void {
    this.timeSlice = ms;
  }

  /**
   * Get current scheduling algorithm
   */
  getAlgorithm(): SchedulingAlgorithm {
    return this.algorithm;
  }

  /**
   * Change process priority
   */
  setPriority(pid: number, priority: number): boolean {
    const process = this.processes.get(pid);
    if (!process) return false;

    process.priority = Math.max(0, Math.min(255, priority));
    return true;
  }
}

export const scheduler = new ProcessScheduler();