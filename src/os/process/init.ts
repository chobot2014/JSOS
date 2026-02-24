/**
 * JSOS Init System
 *
 * Manages system initialization, service startup, shutdown, and runlevels.
 * All synchronous — bare-metal has no event loop; no async/await or setTimeout.
 */

import { SyscallResult } from '../core/syscalls.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

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
        return { success: false, error: startResult.error };
      }

      instance.pid = startResult.value;
      instance.state = 'running';
      instance.startTime = kernel.getUptime();

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
    // Helper to build a service descriptor quickly
    function svc(
      name: string, desc: string, exec: string,
      runlevel: RunLevel, deps: string[],
      startPri: number, stopPri: number,
      restart: 'no' | 'always' | 'on-failure' = 'no',
      user: string = 'root', group: string = 'root'
    ): Service {
      return { name, description: desc, executable: exec, args: [], runlevel,
               dependencies: deps, startPriority: startPri, stopPriority: stopPri,
               restartPolicy: restart, environment: {}, workingDirectory: '/',
               user, group };
    }

    // Runlevel 1 — single-user / core OS services
    this.registerService(svc('kernel',   'Core kernel',                '',                        1, [],                  0,  100, 'no'));
    this.registerService(svc('vmmd',     'Virtual memory manager',     '/bin/vmmd.js',            1, [],                  5,   95, 'always'));
    this.registerService(svc('procfs',   'Virtual /proc filesystem',   '/bin/procfs.js',          1, ['kernel'],         10,   90, 'no'));
    this.registerService(svc('klogd',    'Kernel log daemon',          '/bin/klogd.js',           1, ['kernel'],         15,   85, 'always'));
    this.registerService(svc('syslogd',  'System log daemon',          '/bin/syslogd.js',         1, ['klogd'],          20,   80, 'always'));

    // Runlevel 2 — network
    this.registerService(svc('udevd',    'Device event daemon',        '/bin/udevd.js',           2, ['kernel'],         25,   75, 'on-failure'));
    this.registerService(svc('network',  'Network stack',              '/bin/network.js',         2, ['syslogd','udevd'],30,   70, 'on-failure'));
    this.registerService(svc('dhcpcd',   'DHCP client',                '/bin/dhcpcd.js',          2, ['network'],        35,   65, 'on-failure'));

    // Runlevel 3 — full multi-user
    this.registerService(svc('users',    'User account service',       '/bin/userd.js',           3, ['syslogd'],        40,   60, 'always'));
    this.registerService(svc('cron',     'Periodic task scheduler',    '/bin/cron.js',            3, ['syslogd'],        45,   55, 'always'));
    this.registerService(svc('ipc',      'IPC bus daemon',             '/bin/ipc.js',             3, ['syslogd'],        50,   50, 'always'));
    this.registerService(svc('repl',     'Interactive JavaScript REPL','/bin/repl',               3, ['users','network'],90,   10, 'always', 'user', 'users'));

    // Runlevel 4 — graphical environment
    this.registerService(svc('display',  'Display/WM service',         '/bin/display.js',         4, ['ipc'],            55,   45, 'always'));

    // Runlevel 5 — JSOS native browser  [Phase 9]
    // Built 100% in TypeScript.  Uses the JSOS DNS + HTTP/HTTPS stack for
    // real network requests.  Launched as a JS service by the WM init path.
    const browserSvc: Service = {
      name:          'browser',
      description:   'JSOS native TypeScript browser',
      executable:    '/bin/browser.js',
      args:          [],
      runlevel:      5 as RunLevel,
      dependencies:  ['network', 'display'],
      startPriority: 70,
      stopPriority:  30,
      restartPolicy: 'on-failure',
      environment:   { DISPLAY: ':0', HOME: '/root' },
      workingDirectory: '/',
      user:          'root',
      group:         'root',
    };
    this.registerService(browserSvc);
    kernel.serialPut('JSOS native browser service registered (runlevel 5)\n');
  }

  /**
   * Execute a service — on bare metal, JS services are eval'd by the kernel;
   * native/built-in services (empty executable) are registered and tracked by PID.
   */
  private executeService(service: Service): SyscallResult<number> {
    const pid = this.nextPid++;
    if (!service.executable) {
      // Built-in / native service — already wired by the TS boot sequence.
      return { success: true, value: pid };
    }
    try {
      var code = (globalThis as any).fs && (globalThis as any).fs.readFile
        ? (globalThis as any).fs.readFile(service.executable)
        : null;
      if (code) {
        kernel.eval(code);
        kernel.serialPut('[init] started ' + service.name + ' pid=' + pid + '\n');
      }
    } catch (e) {
      // Non-fatal: service registered but code could not run.
      kernel.serialPut('[init] warn: could not exec ' + service.executable + '\n');
    }
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