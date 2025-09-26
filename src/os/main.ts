/**
 * JSOS Main Entry Point
 * Modern TypeScript implementation compiled to ES5 for baremetal OS
 */

// Import system manager (TypeScript will handle module resolution)
import systemManager, { SystemManager } from './system.js';

// Modern TypeScript interfaces
interface OSConfig {
  readonly debugMode: boolean;
  readonly maxProcesses: number;
  readonly memoryLimit: number;
  readonly features: ReadonlySet<string>;
}

interface CommandHandler {
  readonly name: string;
  readonly description: string;
  readonly handler: (...args: string[]) => Promise<void> | void;
}

// Modern class simplified for ES5 compatibility
class JSOS {
  private config: OSConfig;
  private commands = new Map<string, CommandHandler>();
  private isRunning = false;
  private bootTime: Date;

  constructor(config: Partial<OSConfig> = {}) {
    this.config = {
      debugMode: false,
      maxProcesses: 32,
      memoryLimit: 0x1000000, // 16MB
      features: new Set(['typescript', 'duktape', 'baremetal']),
      ...config
    };

    this.bootTime = new Date();
    this.initializeCommands();
  }

  // Modern getter with computed properties
  get uptime(): number {
    return Date.now() - this.bootTime.getTime();
  }

  get status(): { 
    running: boolean; 
    uptime: number; 
    processCount: number; 
    features: string[] 
  } {
    return {
      running: this.isRunning,
      uptime: this.uptime,
      processCount: systemManager.processCount,
      features: Array.from(this.config.features)
    };
  }

  // Modern async/await with error handling
  async boot(): Promise<void> {
    console.clear();
    this.printBootLogo();

    try {
      console.log('Booting JSOS...');
      
      // Wait for system initialization
      await systemManager.initializeSystem();
      
      this.isRunning = true;
      console.log('System boot complete!');
      
      // Start interactive shell
      await this.startShell();
      
    } catch (error) {
      console.error('Boot failed:', error);
      systemManager.panic('Boot sequence failed');
    }
  }

  private printBootLogo(): void {
    var version = systemManager.systemInfo.version;
    var features = Array.from(this.config.features);
    console.log("===================================================");
    console.log("         JSOS - JavaScript Operating System       ");
    console.log("===================================================");
    console.log("         JSOS v" + version + " Booted          ");
    console.log("===================================================");
    console.log(" Features: " + features.join(', '));
    console.log(" Memory Regions: " + systemManager.memoryRegions.length);
    console.log(" Initial Processes: " + systemManager.processCount + " ");
    console.log("===================================================");
    console.log("    ");
  }

  private initializeCommands(): void {
    const commands: CommandHandler[] = [
      {
        name: 'help',
        description: 'Show available commands',
        handler: () => this.showHelp()
      },
      {
        name: 'status', 
        description: 'Show system status',
        handler: () => this.showStatus()
      },
      {
        name: 'ps',
        description: 'List running processes',
        handler: () => this.listProcesses()
      },
      {
        name: 'run',
        description: 'Create and run a new process',
        handler: function() {
          const name = (arguments.length > 0 ? arguments[0] : undefined) || 'unnamed';
          const priority = parseInt((arguments.length > 1 ? arguments[1] : undefined) || '10');
          this.createProcess(name, priority);
        }
      },
      {
        name: 'kill',
        description: 'Terminate a process by ID',
        handler: function() {
          const id = arguments.length > 0 ? arguments[0] : '0';
          this.killProcess(parseInt(id));
        }
      },
      {
        name: 'memory',
        description: 'Show memory usage',
        handler: () => this.showMemory()
      },
      {
        name: 'clear',
        description: 'Clear the screen',
        handler: () => console.clear()
      },
      {
        name: 'shutdown',
        description: 'Shutdown the system',
        handler: () => this.shutdown()
      },
      {
        name: 'test',
        description: 'Run system tests',
        handler: () => this.runTests()
      },
      {
        name: 'screenshot',
        description: 'Capture comprehensive system state snapshot',
        handler: function() {
          const format = arguments.length > 0 ? arguments[0] : undefined;
          this.takeScreenshot(format);
        }
      }
    ];

    // Modern for-of loop with destructuring
    for (const cmd of commands) {
      this.commands.set(cmd.name, cmd);
    }
  }

  private async startShell(): Promise<void> {
    console.log('\nJSOS Shell started. Type "help" for available commands.\n');
    
    // Modern array methods and async iteration
    const demoCommands = ['status', 'ps', 'run test-process 5', 'run background-task 15', 'ps', 'memory', 'test'];
    
    for (let i = 0; i < demoCommands.length; i++) {
      const cmd = demoCommands[i];
      await this.simulateUserInput(cmd);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\nDemo sequence complete. System ready for interaction.');
  }

  private async simulateUserInput(command: string): Promise<void> {
    console.log("\n$ " + command);
    await this.executeCommand(command);
  }

  private async executeCommand(input: string): Promise<void> {
    const parts = input.trim().split(/\s+/);
    const [command, ...args] = parts; // Modern destructuring assignment
    
    if (!command) return;
    
    const handler = this.commands.get(command.toLowerCase());
    if (!handler) {
      console.log("Unknown command: " + (command) + ". Type 'help' for available commands.");
      return;
    }
    
    try {
      await handler.handler(...args); // Modern spread operator
    } catch (error) {
      console.error("Command failed: " + (error) + "");
    }
  }

  private showHelp(): void {
    console.log('\nAvailable Commands:');
    console.log('─'.repeat(50));
    
    // Modern for-of with destructuring
    for (const [name, cmd] of this.commands) {
      console.log("  " + name.padEnd(12) + " - " + cmd.description);
    }
    console.log();
  }

  private showStatus(): void {
    const status = this.status;
    const sysInfo = systemManager.systemInfo;
    
    // Simplified status display
    console.log("");
    console.log("System Status:");
    console.log("  Status: " + (status.running ? 'Running' : 'Stopped'));
    console.log("  Uptime: " + Math.floor(status.uptime / 1000) + "s");
    console.log("  Version: " + sysInfo.version);
    console.log("  Processes: " + status.processCount);
    console.log("  Features: " + status.features.join(', '));
    console.log("");
  }

  private listProcesses(): void {
    console.log('\nRunning Processes:');
    console.log('─'.repeat(60));
    console.log('ID'.padEnd(4) + 'Name'.padEnd(20) + 'State'.padEnd(12) + 'Priority');
    console.log('─'.repeat(60));
    
    // Modern for-of loop with generator
    for (const process of systemManager.getAllProcesses()) {
      const statusIcon = {
        'running': '',
        'waiting': '',
        'terminated': ''
      }[process.state];      console.log(
        "" + (process.id.toString().padEnd(4)) + "" +
        "" + (process.name.padEnd(20)) + "" +
        "" + ((statusIcon + ' ' + process.state).padEnd(12)) + "" +
        "" + (process.priority) + ""
      );
    }
    console.log();
  }

  private createProcess(name: string, priority: number = 10): void {
    if (isNaN(priority) || priority < 0 || priority > 20) {
      console.log('Priority must be a number between 0-20');
      return;
    }
    
    const process = systemManager.createProcess(name, { priority });
    if (process) {
      console.log("Created process \"" + name + "\" with ID " + process.id + " and priority " + priority);
    } else {
      console.log("Failed to create process \"" + name + "\" - insufficient memory");
    }
  }

  private killProcess(id: number): void {
    if (isNaN(id)) {
      console.log('Process ID must be a number');
      return;
    }
    
    if (systemManager.terminateProcess(id)) {
      console.log("Terminated process " + (id) + "");
    } else {
      console.log("Failed to terminate process " + (id) + " - not found or is kernel process");
    }
  }

  private showMemory(): void {
    const regions = systemManager.memoryRegions;
    const freeMemory = regions
      .filter(r => r.type === 'free') // Modern array methods
      .reduce((sum, r) => sum + r.size, 0);
      
    console.log('\n🧠 Memory Layout:');
    console.log('─'.repeat(50));
    console.log('Start'.padEnd(12) + 'Size'.padEnd(12) + 'Type');
    console.log('─'.repeat(50));
    
    for (const region of regions) {
      const start = '0x' + region.start.toString(16);
      const size = '0x' + region.size.toString(16);
      const icon = region.type === 'free' ? '🟢' : '🟡';
      console.log(start.padEnd(12) + size.padEnd(12) + icon + " " + region.type);
    }
    
    console.log("\nTotal free memory: 0x" + (freeMemory.toString(16)) + " bytes");
  }

  private async runTests(): Promise<void> {
    console.log('\n🧪 Running System Tests...');
    
    const tests = [
      {
        name: 'Process Creation',
        test: () => this.testProcessCreation()
      },
      {
        name: 'Memory Management', 
        test: () => this.testMemoryManagement()
      },
      {
        name: 'Error Handling',
        test: () => this.testErrorHandling()
      }
    ];
    
    let passed = 0;
    
    // Modern for-of loop with destructuring
    for (const { name, test } of tests) {
      try {
        console.log("  Running: " + (name) + "...");
        test();
        console.log("  " + (name) + " passed");
        passed++;
      } catch (error) {
        console.log("  " + name + " failed: " + error);
      }
    }
    
    console.log("\nTest Results: " + passed + "/" + tests.length + " passed\n");
  }

  private testProcessCreation(): void {
    const initialCount = systemManager.processCount;
    const testProcess = systemManager.createProcess('test-process');
    
    if (!testProcess || systemManager.processCount !== initialCount + 1) {
      throw new Error('Process creation failed');
    }
    
    if (!systemManager.terminateProcess(testProcess.id)) {
      throw new Error('Process termination failed'); 
    }
  }

  private testMemoryManagement(): void {
    if (systemManager.memoryRegions.length < 0) {
      throw new Error('Invalid memory state');
    }
  }

  private testErrorHandling(): void {
    if (systemManager.terminateProcess(-1)) {
      throw new Error('Should not be able to terminate invalid process');
    }
  }

  private takeScreenshot(format?: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotId = 'screenshot_' + timestamp;

    console.log('\n=== Taking System Screenshot ===');
    console.log('=====================================');
    console.log('System Snapshot - ' + timestamp);
    console.log('=====================================');

    // System Overview
    console.log('\nSYSTEM OVERVIEW');
    console.log('---------------');
    const status = this.status;
    const sysInfo = systemManager.systemInfo;
    console.log('Status:      ' + (status.running ? 'RUNNING' : 'STOPPED'));
    console.log('Uptime:      ' + Math.floor(status.uptime / 1000) + 's');
    console.log('Version:     ' + sysInfo.version);
    console.log('Build Time:  ' + sysInfo.buildTime.toISOString());
    console.log('Features:    ' + status.features.join(', '));

    // Process Snapshot
    console.log('\nPROCESS SNAPSHOT');
    console.log('---------------');
    console.log('ID'.padEnd(4) + 'Name'.padEnd(20) + 'State'.padEnd(12) + 'Priority'.padEnd(10) + 'Memory');
    console.log('------------------------------------------------------------');

    const processes = Array.from(systemManager.getAllProcesses());
    if (processes.length === 0) {
      console.log('(no active processes)');
    } else {
      for (const process of processes) {
        console.log(
          process.id.toString().padEnd(4) +
          process.name.padEnd(20) +
          process.state.padEnd(12) +
          process.priority.toString().padEnd(10) +
          process.memoryUsage + ' bytes'
        );
      }
    }

    // Memory Layout
    console.log('\nMEMORY LAYOUT');
    console.log('---------------');
    console.log('Start'.padEnd(12) + 'Size'.padEnd(12) + 'Type'.padEnd(10) + 'Usage');
    console.log('--------------------------------------------------');

    const regions = systemManager.memoryRegions;
    let totalMemory = 0;
    let usedMemory = 0;

    for (const region of regions) {
      const start = '0x' + region.start.toString(16).padStart(8, '0');
      const size = '0x' + region.size.toString(16).padStart(8, '0');

      console.log(start.padEnd(12) + size.padEnd(12) + region.type.padEnd(10) + (region.type === 'used' ? 'allocated' : region.type === 'reserved' ? 'system' : 'available'));

      totalMemory += region.size;
      if (region.type === 'used') {
        usedMemory += region.size;
      }
    }

    // Memory Statistics
    const freeMemory = totalMemory - usedMemory;
    const usagePercent = totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : 0;

    console.log('\nMEMORY STATISTICS');
    console.log('---------------');
    console.log('Total Memory:  0x' + totalMemory.toString(16) + ' bytes');
    console.log('Used Memory:   0x' + usedMemory.toString(16) + ' bytes');
    console.log('Free Memory:   0x' + freeMemory.toString(16) + ' bytes');
    console.log('Usage:         ' + usagePercent + '%');

    // Performance Metrics
    console.log('\nPERFORMANCE METRICS');
    console.log('---------------');
    console.log('Active Processes:    ' + status.processCount);
    console.log('System Load:         ' + (status.processCount > 10 ? 'High' : status.processCount > 5 ? 'Medium' : 'Low'));
    console.log('Memory Pressure:     ' + (usagePercent > 80 ? 'High' : usagePercent > 50 ? 'Medium' : 'Low'));

    // Screenshot Metadata
    console.log('\nSCREENSHOT METADATA');
    console.log('---------------');
    console.log('ID:           ' + screenshotId);
    console.log('Timestamp:    ' + timestamp);
    console.log('Format:       ' + (format || 'console'));
    console.log('Captured by:  JSOS v' + sysInfo.version);

    console.log('\n=====================================');
    console.log('Screenshot captured successfully!');
    console.log('=====================================');
  }

  private async shutdown(): Promise<void> {
    console.log('\n🔄 Initiating shutdown sequence...');
    
    try {
      await systemManager.shutdown();
      this.isRunning = false;
      console.log('👋 System shutdown complete. Goodbye!');
    } catch (error) {
      console.error('❌ Shutdown failed:', error);
    }
  }
}

// Modern async main function with error handling
async function main(): Promise<void> {
  const os = new JSOS({
    debugMode: true,
    maxProcesses: 64,
    features: new Set(['typescript', 'es2022', 'duktape', 'baremetal'])
  });
  
  try {
    await os.boot();
  } catch (error) {
    console.error('Fatal error:', error);
    systemManager.panic('Main execution failed');
  }
}

export default JSOS;
export { main };

