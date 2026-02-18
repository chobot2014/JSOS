/**
 * JSOS Init System
 *
 * Manages system initialization, service startup, shutdown, and runlevels.
 * All synchronous — bare-metal has no event loop; no async/await or setTimeout.
 */

import { SyscallResult } from './syscalls.js';

export type RunLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface Service {
  name: string;
  description: string;
  executable: string;
  args: string[];
  runlevel: RunLevel;
  dependencies: string[];
  startPriority: number;
  stopPriority: number;
  restartPolicy: 'no' | 'always' | 'on-failure';
  environment: Record<string, string>;
  workingDirectory: string;
  user: string;
  group: string;
}

export interface ServiceInstance {
  service: Service;
  pid?: number;
  state: ServiceState;
  startTime?: number;
  exitCode?: number;
  restarts: number;
}

export class InitSystem {
  private services = new Map<string, Service>();
  private serviceInstances = new Map<string, ServiceInstance>();
  private currentRunlevel: RunLevel = 1;
  private nextPid = 100; // User-space PIDs start at 100
  private runlevelTargets: Record<RunLevel, string[]> = {
    0: ['shutdown'],
    1: ['basic-services'],
    2: ['network-services'],
    3: ['full-services'],
    4: ['user-services'],
    5: ['graphical-services'],
    6: ['reboot']
  };

  constructor() {
    this.registerDefaultServices();
  }

  /**
   * Register a service
   */
  registerService(service: Service): void {
    this.services.set(service.name, service);
    this.serviceInstances.set(service.name, {
      service,
      state: 'stopped',
      restarts: 0
    });
  }

  /**
   * Start a service (synchronous — no event loop on bare metal)
   */
  startService(serviceName: string): SyscallResult<void> {
    const instance = this.serviceInstances.get(serviceName);
    if (!instance) {
      return { success: false, error: 'Service not found' };
    }

    if (instance.state === 'running' || instance.state === 'starting') {
      return { success: true }; // Already running
    }

    instance.state = 'starting';

    try {
      // Start dependencies first
      for (const dep of instance.service.dependencies) {
        const depResult = this.startService(dep);
        if (!depResult.success) {
          instance.state = 'failed';
          return { success: false, error: 'Dependency ' + dep + ' failed to start' };
        }
      }

      // Register service as running (execution is via kernel.eval for JS services)
      const startResult = this.executeService(instance.service);
      if (!startResult.success) {
        instance.state = 'failed';
        return startResult;
      }

      instance.pid = startResult.value;
      instance.state = 'running';
      instance.startTime = Date.now();

      return { success: true };
    } catch (error) {
      instance.state = 'failed';
      return { success: false, error: String(error) };
    }
  }

  /**
   * Stop a service (synchronous)
   */
  stopService(serviceName: string): SyscallResult<void> {
    const instance = this.serviceInstances.get(serviceName);
    if (!instance) {
      return { success: false, error: 'Service not found' };
    }

    if (instance.state === 'stopped') {
      return { success: true };
    }

    instance.state = 'stopping';

    try {
      // On bare metal: mark stopped immediately (no signals/delays)
      instance.state = 'stopped';
      instance.pid = undefined;
      instance.exitCode = undefined;

      return { success: true };
    } catch (error) {
      instance.state = 'failed';
      return { success: false, error: String(error) };
    }
  }

  /**
   * Restart a service
   */
  restartService(serviceName: string): SyscallResult<void> {
    this.stopService(serviceName);
    return this.startService(serviceName);
  }

  /**
   * Change runlevel (synchronous)
   */
  changeRunlevel(newLevel: RunLevel): SyscallResult<void> {
    const oldLevel = this.currentRunlevel;
    this.currentRunlevel = newLevel;

    try {
      if (newLevel === 0) {
        this.shutdown();
      } else if (newLevel === 6) {
        this.reboot();
      } else {
        // Start services with runlevel <= target
        for (const [name, instance] of this.serviceInstances) {
          if (instance.service.runlevel <= newLevel && instance.state === 'stopped') {
            this.startService(name);
          }
        }

        // Stop services that belong to a higher runlevel
        for (const [name, instance] of this.serviceInstances) {
          if (instance.service.runlevel > newLevel && instance.state === 'running') {
            this.stopService(name);
          }
        }
      }

      return { success: true };
    } catch (error) {
      this.currentRunlevel = oldLevel;
      return { success: false, error: String(error) };
    }
  }

  /**
   * Get service status
   */
  getServiceStatus(serviceName: string): ServiceInstance | null {
    return this.serviceInstances.get(serviceName) || null;
  }

  /**
   * List all services
   */
  listServices(): ServiceInstance[] {
    return Array.from(this.serviceInstances.values());
  }

  /**
   * System shutdown (synchronous)
   */
  shutdown(): void {
    const services = Array.from(this.serviceInstances.values())
      .sort((a, b) => b.service.stopPriority - a.service.stopPriority);

    for (const instance of services) {
      if (instance.state === 'running') {
        this.stopService(instance.service.name);
      }
    }
  }

  /**
   * System reboot (synchronous)
   */
  reboot(): void {
    this.shutdown();
    // Triggers hardware reboot via kernel
  }

  /**
   * Initialize system (called during boot, synchronous)
   */
  initialize(): void {
    // Register and start all services up to runlevel 3 (full multi-user)
    this.changeRunlevel(3);
  }

  /**
   * Register default system services
   */
  private registerDefaultServices(): void {
    // Kernel services
    this.registerService({
      name: 'kernel',
      description: 'Core kernel services',
      executable: '',
      args: [],
      runlevel: 1,
      dependencies: [],
      startPriority: 0,
      stopPriority: 100,
      restartPolicy: 'no',
      environment: {},
      workingDirectory: '/',
      user: 'root',
      group: 'root'
    });

    // Basic filesystem
    this.registerService({
      name: 'filesystem',
      description: 'Basic filesystem services',
      executable: '/bin/fs-init.js',
      args: [],
      runlevel: 1,
      dependencies: ['kernel'],
      startPriority: 10,
      stopPriority: 90,
      restartPolicy: 'no',
      environment: {},
      workingDirectory: '/',
      user: 'root',
      group: 'root'
    });

    // Terminal services
    this.registerService({
      name: 'terminal',
      description: 'Terminal and console services',
      executable: '/bin/terminal-init.js',
      args: [],
      runlevel: 1,
      dependencies: ['filesystem'],
      startPriority: 20,
      stopPriority: 80,
      restartPolicy: 'always',
      environment: {},
      workingDirectory: '/',
      user: 'root',
      group: 'root'
    });

    // Network services
    this.registerService({
      name: 'network',
      description: 'Network stack initialization',
      executable: '/bin/network-init.js',
      args: [],
      runlevel: 2,
      dependencies: ['filesystem'],
      startPriority: 30,
      stopPriority: 70,
      restartPolicy: 'on-failure',
      environment: {},
      workingDirectory: '/',
      user: 'root',
      group: 'root'
    });

    // User services
    this.registerService({
      name: 'user-services',
      description: 'User-level services',
      executable: '/bin/user-init.js',
      args: [],
      runlevel: 4,
      dependencies: ['network', 'terminal'],
      startPriority: 40,
      stopPriority: 60,
      restartPolicy: 'on-failure',
      environment: {},
      workingDirectory: '/',
      user: 'root',
      group: 'root'
    });

    // REPL service (main shell)
    this.registerService({
      name: 'repl',
      description: 'JavaScript REPL interface',
      executable: '/bin/repl.js',
      args: [],
      runlevel: 5,
      dependencies: ['terminal', 'user-services'],
      startPriority: 50,
      stopPriority: 50,
      restartPolicy: 'always',
      environment: {},
      workingDirectory: '/home/user',
      user: 'user',
      group: 'users'
    });
  }

  /**
   * Execute a service — on bare metal, JS services are eval'd by the kernel;
   * native services are just registered and tracked by PID.
   */
  private executeService(service: Service): SyscallResult<number> {
    // Assign a sequential PID; real execution happens via kernel.eval for JS services
    const pid = this.nextPid++;
    return { success: true, value: pid };
  }

  /**
   * Get current runlevel
   */
  getCurrentRunlevel(): RunLevel {
    return this.currentRunlevel;
  }
}

export const init = new InitSystem();