/**
 * JSOS System Manager
 *
 * User-facing process management API. Delegates all process lifecycle
 * operations to the ProcessScheduler, which is the authoritative source
 * of process state. This layer adapts ProcessContext -> ProcessDescriptor
 * for display and scripting consumers (shell, REPL, etc.).
 */

import terminal from '../ui/terminal.js';
import { Color } from './kernel.js';
import { scheduler } from '../process/scheduler.js';

declare var kernel: import('./kernel.js').KernelAPI;

/** User-visible process descriptor (adapted from scheduler's ProcessContext) */
export interface ProcessDescriptor {
  readonly id: number;
  readonly name: string;
  readonly state: 'running' | 'waiting' | 'terminated';
  readonly priority: number;
  readonly memoryUsage: number;
}

export class SystemManager {
  private version = '1.0.0';

  get systemVersion(): string {
    return this.version;
  }

  get processCount(): number {
    return scheduler.getAllProcesses().length;
  }

  /** Create a new user-space process (delegates to scheduler) */
  createProcess(
    name: string,
    options: { priority?: number; memorySize?: number } = {}
  ): ProcessDescriptor | null {
    var priority = (options.priority !== undefined) ? options.priority : 10;
    var ctx = scheduler.createProcess(0, {
      name: name,
      priority: priority,
      timeSlice: 10,
      memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 }
    });
    return this.toDescriptor(ctx);
  }

  /** Terminate a process by PID (delegates to scheduler) */
  terminateProcess(pid: number): boolean {
    return scheduler.terminateProcess(pid);
  }

  /** Get a flat list of all processes */
  getProcessList(): ProcessDescriptor[] {
    return scheduler.getAllProcesses().map((ctx) => this.toDescriptor(ctx));
  }

  /** Get processes filtered by state */
  getProcessesByState(state: ProcessDescriptor['state']): ProcessDescriptor[] {
    return this.getProcessList().filter(function(p) { return p.state === state; });
  }

  /** Shutdown: stop all non-kernel processes */
  shutdown(): void {
    terminal.println('Terminating all processes...');
    var procs = this.getProcessList();
    for (var i = 0; i < procs.length; i++) {
      if (procs[i].name !== 'kernel') {
        scheduler.terminateProcess(procs[i].id);
      }
    }
    terminal.println('System shutdown complete.');
  }

  /** Panic and halt */
  panic(message: string): void {
    terminal.setColor(Color.WHITE, 4); // White on red
    terminal.println('');
    terminal.println('*** KERNEL PANIC ***');
    terminal.println(message);
    terminal.println('');
    terminal.println('System halted.');
    terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
    kernel.halt();
  }

  /** Adapt a ProcessContext to the simplified ProcessDescriptor interface */
  private toDescriptor(ctx: import('../process/scheduler').ProcessContext): ProcessDescriptor {
    var stateMap: Record<string, ProcessDescriptor['state']> = {
      ready: 'waiting',
      running: 'running',
      blocked: 'waiting',
      terminated: 'terminated',
      waiting: 'waiting'
    };
    return {
      id:          ctx.pid,
      name:        ctx.name,
      state:       stateMap[ctx.state] || 'waiting',
      priority:    ctx.priority,
      memoryUsage: ctx.memory.heapEnd - ctx.memory.heapStart
    };
  }
}

const systemManager = new SystemManager();
export default systemManager;


