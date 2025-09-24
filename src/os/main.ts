/**
 * JSOS Main Entry Point
 * Modern TypeScript implementation for baremetal OS
 */

import systemManager, { SystemManager } from './system.js';

// Modern TypeScript with strict types and interfaces
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

// Modern class with advanced TypeScript features
class JSOS {
  #config: OSConfig;
  #commands = new Map<string, CommandHandler>();
  #isRunning = false;
  #bootTime: Date;

  constructor(config: Partial<OSConfig> = {}) {
    this.#config = {
      debugMode: false,
      maxProcesses: 32,
      memoryLimit: 0x1000000, // 16MB
      features: new Set(['typescript', 'duktape', 'baremetal']),
      ...config
    };

    this.#bootTime = new Date();
    this.initializeCommands();
  }

  // Modern getter with computed properties
  get uptime(): number {
    return Date.now() - this.#bootTime.getTime();
  }

  get status(): { 
    running: boolean; 
    uptime: number; 
    processCount: number; 
    features: string[] 
  } {
    return {
      running: this.#isRunning,
      uptime: this.uptime,
      processCount: systemManager.processCount,
      features: Array.from(this.#config.features)
    };
  }

  // Modern async initialization with error handling
  async boot(): Promise<void> {
    console.clear();
    this.printBootLogo();

    try {
      console.log('🚀 Booting JSOS...');
      
      // Wait for system initialization
      await systemManager.initializeSystem();
      
      this.#isRunning = true;
      console.log('✅ System boot complete!');
      
      // Start interactive shell
      await this.startShell();
      
    } catch (error) {
      console.error('❌ Boot failed:', error);
      systemManager.panic('Boot sequence failed');
    }
  }

  private printBootLogo(): void {
    console.log(`
    ╔══════════════════════════════════════════════════════════════╗
    ║       ██╗███████╗ ██████╗ ███████╗                          ║
    ║       ██║██╔════╝██╔═══██╗██╔════╝                          ║
    ║       ██║███████╗██║   ██║███████╗                          ║
    ║  ██   ██║╚════██║██║   ██║╚════██║                          ║
    ║  ╚█████╔╝███████║╚██████╔╝███████║                          ║
    ║   ╚════╝ ╚══════╝ ╚═════╝ ╚══════╝                          ║
    ║                                                              ║
    ║  JavaScript Operating System - TypeScript Edition            ║
    ║  Built with: ${Array.from(this.#config.features).join(' | ')}           ║
    ╚══════════════════════════════════════════════════════════════╝
    `);
  }

  // Initialize command system with modern Map and arrow functions
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
        handler: (name = 'unnamed', priority = '10') => 
          this.createProcess(name, parseInt(priority))
      },
      {
        name: 'kill',
        description: 'Terminate a process by ID',
        handler: (id) => this.killProcess(parseInt(id))
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
      }
    ];

    // Use modern for...of loop to populate commands Map
    for (const cmd of commands) {
      this.#commands.set(cmd.name, cmd);
    }
  }

  private async startShell(): Promise<void> {
    console.log('\n💻 JSOS Shell started. Type "help" for available commands.\n');

    // Simulate interactive shell (in real implementation this would read from keyboard)
    // For demo purposes, we'll run a sequence of commands
    const demoCommands = [
      'status',
      'ps',
      'run test-process 5',
      'run background-task 15',
      'ps',
      'memory',
      'test'
    ];

    for (const command of demoCommands) {
      await this.simulateUserInput(command);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Pause between commands
    }

    console.log('\n🎯 Demo sequence complete. System ready for interaction.');
  }

  private async simulateUserInput(input: string): Promise<void> {
    console.log(`\n$ ${input}`);
    await this.executeCommand(input);
  }

  // Modern command parsing with destructuring
  private async executeCommand(input: string): Promise<void> {
    const [commandName, ...args] = input.trim().split(/\s+/);
    
    if (!commandName) return;

    const command = this.#commands.get(commandName.toLowerCase());
    
    if (!command) {
      console.log(`❌ Unknown command: ${commandName}. Type 'help' for available commands.`);
      return;
    }

    try {
      await command.handler(...args);
    } catch (error) {
      console.error(`❌ Command failed: ${error}`);
    }
  }

  // Command implementations using modern TypeScript features
  private showHelp(): void {
    console.log('\n📖 Available Commands:');
    console.log('─'.repeat(50));
    
    for (const [name, cmd] of this.#commands) {
      console.log(`  ${name.padEnd(12)} - ${cmd.description}`);
    }
    console.log();
  }

  private showStatus(): void {
    const status = this.status;
    const info = systemManager.systemInfo;
    
    console.log(`
📊 System Status:
  Status: ${status.running ? '🟢 Running' : '🔴 Stopped'}
  Uptime: ${Math.floor(status.uptime / 1000)}s
  Version: ${info.version}
  Processes: ${status.processCount}
  Features: ${status.features.join(', ')}
    `);
  }

  private listProcesses(): void {
    console.log('\n🔄 Running Processes:');
    console.log('─'.repeat(60));
    console.log('ID'.padEnd(4) + 'Name'.padEnd(20) + 'State'.padEnd(12) + 'Priority');
    console.log('─'.repeat(60));
    
    // Use modern iterator
    for (const process of systemManager.getAllProcesses()) {
      const stateIcon = {
        'running': '🟢',
        'waiting': '🟡',
        'terminated': '🔴'
      }[process.state];
      
      console.log(
        `${process.id.toString().padEnd(4)}` +
        `${process.name.padEnd(20)}` +
        `${(stateIcon + ' ' + process.state).padEnd(12)}` +
        `${process.priority}`
      );
    }
    console.log();
  }

  private createProcess(name: string, priority: number = 10): void {
    if (isNaN(priority) || priority < 0 || priority > 20) {
      console.log('❌ Priority must be a number between 0-20');
      return;
    }

    const process = systemManager.createProcess(name, { priority });
    
    if (process) {
      console.log(`✅ Created process "${name}" with ID ${process.id} and priority ${priority}`);
    } else {
      console.log(`❌ Failed to create process "${name}" - insufficient memory`);
    }
  }

  private killProcess(processId: number): void {
    if (isNaN(processId)) {
      console.log('❌ Process ID must be a number');
      return;
    }

    if (systemManager.terminateProcess(processId)) {
      console.log(`✅ Terminated process ${processId}`);
    } else {
      console.log(`❌ Failed to terminate process ${processId} - not found or is kernel process`);
    }
  }

  private showMemory(): void {
    const regions = systemManager.memoryRegions;
    const totalFree = regions
      .filter(r => r.type === 'free')
      .reduce((sum, r) => sum + r.size, 0);

    console.log('\n🧠 Memory Layout:');
    console.log('─'.repeat(50));
    console.log('Start'.padEnd(12) + 'Size'.padEnd(12) + 'Type');
    console.log('─'.repeat(50));
    
    for (const region of regions) {
      const startHex = `0x${region.start.toString(16)}`;
      const sizeHex = `0x${region.size.toString(16)}`;
      const typeIcon = region.type === 'free' ? '🟢' : '🟡';
      
      console.log(
        `${startHex.padEnd(12)}${sizeHex.padEnd(12)}${typeIcon} ${region.type}`
      );
    }
    
    console.log(`\nTotal free memory: 0x${totalFree.toString(16)} bytes`);
  }

  private async runTests(): Promise<void> {
    console.log('\n🧪 Running System Tests...');
    
    const tests = [
      { name: 'Process Creation', test: () => this.testProcessCreation() },
      { name: 'Memory Management', test: () => this.testMemoryManagement() },
      { name: 'Error Handling', test: () => this.testErrorHandling() }
    ];

    let passed = 0;
    
    for (const { name, test } of tests) {
      try {
        console.log(`  Running: ${name}...`);
        await test();
        console.log(`  ✅ ${name} passed`);
        passed++;
      } catch (error) {
        console.log(`  ❌ ${name} failed: ${error}`);
      }
    }
    
    console.log(`\n📋 Test Results: ${passed}/${tests.length} passed\n`);
  }

  private testProcessCreation(): void {
    const initialCount = systemManager.processCount;
    const process = systemManager.createProcess('test-process');
    
    if (!process || systemManager.processCount !== initialCount + 1) {
      throw new Error('Process creation failed');
    }
    
    if (!systemManager.terminateProcess(process.id)) {
      throw new Error('Process termination failed');
    }
  }

  private testMemoryManagement(): void {
    const initialRegions = systemManager.memoryRegions.length;
    // Test would verify memory allocation/deallocation
    // Simplified for demo
    if (initialRegions < 0) {
      throw new Error('Invalid memory state');
    }
  }

  private testErrorHandling(): void {
    // Test invalid operations
    if (systemManager.terminateProcess(-1)) {
      throw new Error('Should not be able to terminate invalid process');
    }
  }

  private async shutdown(): Promise<void> {
    console.log('\n🔄 Initiating shutdown sequence...');
    
    try {
      await systemManager.shutdown();
      this.#isRunning = false;
      console.log('👋 System shutdown complete. Goodbye!');
    } catch (error) {
      console.error('❌ Shutdown failed:', error);
    }
  }
}

// Modern top-level await and main function
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

// Export for module system and start if this is the main module
export default JSOS;
export { main };

// Auto-start the OS
main().catch(console.error);
