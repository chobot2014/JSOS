/**
 * JSOS System Manager
 * Process management and system services backed by real kernel APIs
 */

import terminal from './terminal.js';
import { Color } from './kernel.js';

declare var kernel: import('./kernel.js').KernelAPI;

export interface ProcessDescriptor {
  readonly id: number;
  readonly name: string;
  readonly state: 'running' | 'waiting' | 'terminated';
  readonly priority: number;
  readonly memoryUsage: number;
}

export class SystemManager {
  private processes = new Map<number, ProcessDescriptor>();
  private nextProcessId = 1;
  private version = '1.0.0';

  constructor() {
    // Create the kernel process (PID 1)
    var kernelProc: ProcessDescriptor = {
      id: this.nextProcessId++,
      name: 'kernel',
      state: 'running',
      priority: 0,
      memoryUsage: 0x10000
    };
    this.processes.set(kernelProc.id, kernelProc);

    // Create the init/shell process (PID 2)
    var initProc: ProcessDescriptor = {
      id: this.nextProcessId++,
      name: 'init',
      state: 'running',
      priority: 1,
      memoryUsage: 0x4000
    };
    this.processes.set(initProc.id, initProc);
  }

  get systemVersion(): string {
    return this.version;
  }

  get processCount(): number {
    return this.processes.size;
  }

  /** Create a new process */
  createProcess(
    name: string,
    options: { priority?: number; memorySize?: number } = {}
  ): ProcessDescriptor | null {
    var priority = (options.priority !== undefined) ? options.priority : 10;
    var memorySize = (options.memorySize !== undefined) ? options.memorySize : 0x1000;

    var proc: ProcessDescriptor = {
      id: this.nextProcessId++,
      name: name,
      state: 'running',
      priority: priority,
      memoryUsage: memorySize
    };

    this.processes.set(proc.id, proc);
    return proc;
  }

  /** Terminate a process by PID */
  terminateProcess(pid: number): boolean {
    var proc = this.processes.get(pid);
    if (!proc || proc.name === 'kernel') {
      return false;
    }

    var terminated: ProcessDescriptor = {
      id: proc.id,
      name: proc.name,
      state: 'terminated',
      priority: proc.priority,
      memoryUsage: proc.memoryUsage
    };
    this.processes.set(pid, terminated);

    // Clean up after a tick
    this.processes.delete(pid);
    return true;
  }

  /** Get a flat list of all processes */
  getProcessList(): ProcessDescriptor[] {
    var list: ProcessDescriptor[] = [];
    var keys = Array.from(this.processes.keys());
    for (var i = 0; i < keys.length; i++) {
      var p = this.processes.get(keys[i]);
      if (p) list.push(p);
    }
    return list.sort(function(a, b) { return a.id - b.id; });
  }

  /** Get processes filtered by state */
  getProcessesByState(state: ProcessDescriptor['state']): ProcessDescriptor[] {
    return this.getProcessList().filter(function(p) { return p.state === state; });
  }

  /** Shutdown the system */
  shutdown(): void {
    terminal.println('Terminating all processes...');
    var procs = this.getProcessList();
    for (var i = 0; i < procs.length; i++) {
      if (procs[i].name !== 'kernel') {
        this.terminateProcess(procs[i].id);
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
}

const systemManager = new SystemManager();
export default systemManager;


