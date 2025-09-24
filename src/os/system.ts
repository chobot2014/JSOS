/**
 * JSOS System Module
 * Modern TypeScript implementation for baremetal OS
 */

// Modern TypeScript interfaces with strict typing
interface SystemInfo {
  readonly version: string;
  readonly buildTime: Date;
  readonly features: ReadonlyArray<string>;
}

interface MemoryRegion {
  readonly start: number;
  readonly size: number;
  readonly type: 'free' | 'reserved' | 'used';
}

interface ProcessDescriptor {
  readonly id: number;
  readonly name: string;
  readonly state: 'running' | 'waiting' | 'terminated';
  readonly priority: number;
  readonly memoryUsage: number;
}

// Modern class simplified for ES5 compatibility 
export class SystemManager {
  private processes = new Map<number, ProcessDescriptor>();
  private memoryRegionsInternal: MemoryRegion[] = [];
  private nextProcessId = 1;
  private systemInfoInternal: SystemInfo;

  constructor() {
    this.systemInfoInternal = {
      version: '1.0.0',
      buildTime: new Date(),
      features: ['modern-typescript', 'es2022', 'duktape-runtime'] as const
    };

    this.initializeSystem();
  }

  // Getter with modern syntax
  get systemInfo(): SystemInfo {
    return this.systemInfoInternal;
  }

  get processCount(): number {
    return this.processes.size;
  }

  get memoryRegions(): ReadonlyArray<MemoryRegion> {
    return [...this.memoryRegionsInternal];
  }

  // Modern async/await pattern (will be transpiled to ES5 promises)
  async initializeSystem(): Promise<void> {
    try {
      await this.initializeMemory();
      await this.initializeProcessManager();
      this.logSystemBoot();
    } catch (error) {
      this.panic("System initialization failed: " + (error) + "");
    }
  }

  private async initializeMemory(): Promise<void> {
    // Simulate memory detection with modern array methods
    const detectedRegions: MemoryRegion[] = [
      { start: 0x100000, size: 0x100000, type: 'free' },
      { start: 0x200000, size: 0x50000, type: 'reserved' },
      { start: 0x250000, size: 0x200000, type: 'free' }
    ];

    this.memoryRegionsInternal = detectedRegions.filter(region => region.type === 'free');
    
    console.log("Initialized " + (this.memoryRegionsInternal.length) + " memory regions");
  }

  private async initializeProcessManager(): Promise<void> {
    // Create kernel process with modern object spread
    const kernelProcess: ProcessDescriptor = {
      id: this.nextProcessId++,
      name: 'kernel',
      state: 'running',
      priority: 0,
      memoryUsage: 0x10000
    };

    this.processes.set(kernelProcess.id, kernelProcess);
  }

  // Modern method with destructuring and optional parameters
  createProcess(
    name: string, 
    options: { priority?: number; memorySize?: number } = {}
  ): ProcessDescriptor | null {
    const { priority = 10, memorySize = 0x1000 } = options;

    if (!this.allocateMemory(memorySize)) {
      return null;
    }

    const process: ProcessDescriptor = {
      id: this.nextProcessId++,
      name,
      state: 'running',
      priority,
      memoryUsage: memorySize
    };

    this.processes.set(process.id, process);
    return process;
  }

  // Modern array methods and functional programming
  getProcessesByState(state: ProcessDescriptor['state']): ProcessDescriptor[] {
    return Array.from(this.processes.values())
      .filter(process => process.state === state)
      .sort((a, b) => a.priority - b.priority);
  }

  terminateProcess(processId: number): boolean {
    const process = this.processes.get(processId);
    if (!process || process.name === 'kernel') {
      return false;
    }

    // Update with modern object spread for immutability
    const terminatedProcess = { ...process, state: 'terminated' as const };
    this.processes.set(processId, terminatedProcess);
    
    // Clean up memory (simplified)
    this.deallocateMemory(process.memoryUsage);
    return true;
  }

  private allocateMemory(size: number): boolean {
    const availableRegion = this.memoryRegionsInternal.find(region => 
      region.type === 'free' && region.size >= size
    );

    if (!availableRegion) {
      return false;
    }

    // Update memory region (simplified)
    const index = this.memoryRegionsInternal.indexOf(availableRegion);
    if (availableRegion.size > size) {
      // Split the region
      const newRegion: MemoryRegion = {
        start: availableRegion.start + size,
        size: availableRegion.size - size,
        type: 'free'
      };
      this.memoryRegionsInternal[index] = newRegion;
    } else {
      // Remove the region entirely
      this.memoryRegionsInternal.splice(index, 1);
    }

    return true;
  }

  private deallocateMemory(size: number): void {
    // Simplified memory deallocation - in real OS this would be much more complex
    const newRegion: MemoryRegion = {
      start: 0x300000, // Simplified address
      size,
      type: 'free'
    };
    this.memoryRegionsInternal.push(newRegion);
  }

  // Simplified system boot logging
  private logSystemBoot(): void {
    var version = this.systemInfoInternal.version;
    var features = this.systemInfoInternal.features;
    console.log("===================================================");
    console.log("         JSOS v" + version + " System Ready       ");
    console.log("===================================================");
    console.log(" Features: " + features.join(', '));
    console.log(" Memory Regions: " + this.memoryRegionsInternal.length);
    console.log(" Initial Processes: " + this.processes.size);
    console.log("===================================================");
  }

  // System panic with simplified error handling
  panic(message: string): never {
    console.error("💀 KERNEL PANIC 💀");
    console.error("" + message + "");
    console.error("");
    console.error("System halted.");
    
    // In a real OS, this would halt the system
    // For our JS environment, we'll throw an error
    throw new Error("KERNEL PANIC: " + message);
  }

  // Modern iterator support
  *getAllProcesses(): Generator<ProcessDescriptor> {
    for (const process of this.processes.values()) {
      yield process;
    }
  }

  // Modern Promise-based shutdown
  async shutdown(): Promise<void> {
    console.log('Initiating system shutdown...');
    
    // Terminate all non-kernel processes
    const processesToTerminate = Array.from(this.processes.values())
      .filter(p => p.name !== 'kernel')
      .map(p => p.id);

    await Promise.all(
      processesToTerminate.map(async (id) => {
        await new Promise(resolve => setTimeout(resolve, 10)); // Simulate cleanup time
        this.terminateProcess(id);
      })
    );

    console.log('System shutdown complete.');
  }
}

// Modern export with default
const systemManager = new SystemManager();
export default systemManager;


