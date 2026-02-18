/**
 * JSOS Init System
 *
 * Manages system initialization, service startup, shutdown, and runlevels.
 * Similar to systemd or init.d, but implemented in TypeScript.
 */

import { ProcessContext } from './scheduler.js';
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
   * Start a service
   */
  async startService(serviceName: string): Promise<SyscallResult<void>> {
    const instance = this.serviceInstances.get(serviceName);
    if (!instance) {
      return { success: false, error: 'Service not found' };
    }

    if (instance.state === 'running' || instance.state === 'starting') {
      return { success: true }; // Already running
    }

    instance.state = 'starting';

    try {
      // Check dependencies
      for (const dep of instance.service.dependencies) {
        const depResult = await this.startService(dep);
        if (!depResult.success) {
          instance.state = 'failed';
          return { success: false, error: `Dependency ${dep} failed to start` };
        }
      }

      // Start the service
      const startResult = await this.executeService(instance.service);
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
   * Stop a service
   */
  async stopService(serviceName: string): Promise<SyscallResult<void>> {
    const instance = this.serviceInstances.get(serviceName);
    if (!instance) {
      return { success: false, error: 'Service not found' };
    }

    if (instance.state === 'stopped') {
      return { success: true };
    }

    instance.state = 'stopping';

    try {
      if (instance.pid) {
        // Send SIGTERM first
        await this.sendSignal(instance.pid, 15); // SIGTERM

        // Wait a bit, then SIGKILL if still running
        await this.delay(5000);
        if (instance.state !== 'stopped') {
          await this.sendSignal(instance.pid, 9); // SIGKILL
        }
      }

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
  async restartService(serviceName: string): Promise<SyscallResult<void>> {
    await this.stopService(serviceName);
    return await this.startService(serviceName);
  }

  /**
   * Change runlevel
   */
  async changeRunlevel(newLevel: RunLevel): Promise<SyscallResult<void>> {
    const oldLevel = this.currentRunlevel;
    this.currentRunlevel = newLevel;

    try {
      if (newLevel === 0) {
        // Shutdown
        await this.shutdown();
      } else if (newLevel === 6) {
        // Reboot
        await this.reboot();
      } else {
        // Start services for new runlevel
        const servicesToStart = this.runlevelTargets[newLevel] || [];
        for (const service of servicesToStart) {
          await this.startService(service);
        }

        // Stop services not needed in new runlevel
        for (const [name, instance] of this.serviceInstances) {
          if (instance.service.runlevel > newLevel && instance.state === 'running') {
            await this.stopService(name);
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
   * System shutdown
   */
  async shutdown(): Promise<void> {
    // Stop all services in reverse order
    const services = Array.from(this.serviceInstances.values())
      .sort((a, b) => b.service.stopPriority - a.service.stopPriority);

    for (const instance of services) {
      if (instance.state === 'running') {
        await this.stopService(instance.service.name);
      }
    }

    // Final cleanup
    console.log('System shutdown complete');
  }

  /**
   * System reboot
   */
  async reboot(): Promise<void> {
    await this.shutdown();
    // In a real system, this would trigger hardware reset
    console.log('System reboot initiated');
  }

  /**
   * Initialize system (called during boot)
   */
  async initialize(): Promise<void> {
    console.log('JSOS Init System starting...');

    // Start basic services
    await this.changeRunlevel(1);

    // Start full system
    await this.changeRunlevel(3);

    console.log('System initialization complete');
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
   * Execute a service
   */
  private async executeService(service: Service): Promise<SyscallResult<number>> {
    // In a real implementation, this would fork and exec
    // For now, we'll simulate with a mock PID
    return { success: true, value: Math.floor(Math.random() * 1000) + 100 };
  }

  /**
   * Send signal to process
   */
  private async sendSignal(pid: number, signal: number): Promise<void> {
    // Mock signal sending
    console.log(`Sending signal ${signal} to process ${pid}`);
  }

  /**
   * Simple delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current runlevel
   */
  getCurrentRunlevel(): RunLevel {
    return this.currentRunlevel;
  }
}

export const init = new InitSystem();