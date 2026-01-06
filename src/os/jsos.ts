/**
 * JSOS Namespace Root
 * 
 * All OS functionality is accessed via jsos.namespace.method pattern
 * Examples:
 *   jsos.system.info()
 *   jsos.process.list()
 *   jsos.memory.stats()
 *   jsos.cli.exec('help')
 *   jsos.ui.window.create()
 */

// ============================================================================
// Type Definitions
// ============================================================================

interface ProcessDescriptor {
  readonly id: number;
  readonly name: string;
  readonly state: 'running' | 'waiting' | 'terminated';
  readonly priority: number;
  readonly memoryUsage: number;
  readonly createdAt: number;
}

interface MemoryRegion {
  readonly start: number;
  readonly size: number;
  readonly type: 'free' | 'reserved' | 'used';
}

interface SystemInfo {
  readonly version: string;
  readonly buildTime: Date;
  readonly features: ReadonlyArray<string>;
  readonly arch: string;
}

interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

interface WindowDescriptor {
  readonly id: number;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly zIndex: number;
}

interface FileDescriptor {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly type: 'file' | 'directory';
  readonly permissions: string;
  readonly modified: number;
}

interface NetworkInterface {
  readonly name: string;
  readonly address: string;
  readonly status: 'up' | 'down';
}

interface EventListener {
  readonly id: number;
  readonly event: string;
  readonly callback: Function;
}

// ============================================================================
// JSOS Namespace Implementation
// ============================================================================

const jsos = {
  // Version and metadata
  version: '1.0.0',
  name: 'JSOS',
  
  // -------------------------------------------------------------------------
  // jsos.system - Core system operations
  // -------------------------------------------------------------------------
  system: {
    _info: {
      version: '1.0.0',
      buildTime: new Date(),
      features: ['typescript', 'duktape', 'baremetal', 'web-ui'] as const,
      arch: 'x86'
    } as SystemInfo,
    
    _bootTime: Date.now(),
    _running: false,
    
    info: function(): SystemInfo {
      return this._info;
    },
    
    uptime: function(): number {
      return Date.now() - this._bootTime;
    },
    
    status: function(): { running: boolean; uptime: number; load: string } {
      var processCount = jsos.process.count();
      return {
        running: this._running,
        uptime: this.uptime(),
        load: processCount > 10 ? 'high' : processCount > 5 ? 'medium' : 'low'
      };
    },
    
    boot: async function(): Promise<void> {
      jsos.cli.print('Booting JSOS...');
      await jsos.memory.init();
      await jsos.process.init();
      await jsos.fs.init();
      await jsos.net.init();
      this._running = true;
      jsos.cli.print('System boot complete.');
    },
    
    shutdown: async function(): Promise<void> {
      jsos.cli.print('Initiating shutdown...');
      await jsos.process.killAll();
      this._running = false;
      jsos.cli.print('System halted.');
    },
    
    panic: function(message: string): never {
      jsos.cli.error('KERNEL PANIC: ' + message);
      throw new Error('KERNEL PANIC: ' + message);
    },
    
    reboot: async function(): Promise<void> {
      await this.shutdown();
      await this.boot();
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.process - Process management
  // -------------------------------------------------------------------------
  process: {
    _processes: new Map<number, ProcessDescriptor>(),
    _nextId: 1,
    
    init: async function(): Promise<void> {
      // Create kernel process
      this.create('kernel', { priority: 0, memorySize: 0x10000 });
      this.create('init', { priority: 1, memorySize: 0x4000 });
      jsos.cli.print('Process manager initialized.');
    },
    
    list: function(): ProcessDescriptor[] {
      return Array.from(this._processes.values());
    },
    
    count: function(): number {
      return this._processes.size;
    },
    
    get: function(id: number): ProcessDescriptor | undefined {
      return this._processes.get(id);
    },
    
    create: function(name: string, options?: { priority?: number; memorySize?: number }): ProcessDescriptor | null {
      var priority = (options && options.priority !== undefined) ? options.priority : 10;
      var memorySize = (options && options.memorySize !== undefined) ? options.memorySize : 0x1000;
      
      if (!jsos.memory.allocate(memorySize)) {
        return null;
      }
      
      var process: ProcessDescriptor = {
        id: this._nextId++,
        name: name,
        state: 'running',
        priority: priority,
        memoryUsage: memorySize,
        createdAt: Date.now()
      };
      
      this._processes.set(process.id, process);
      return process;
    },
    
    kill: function(id: number): boolean {
      var process = this._processes.get(id);
      if (!process || process.name === 'kernel') {
        return false;
      }
      
      jsos.memory.free(process.memoryUsage);
      this._processes.delete(id);
      return true;
    },
    
    killAll: async function(): Promise<void> {
      var ids = Array.from(this._processes.keys());
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var p = this._processes.get(id);
        if (p && p.name !== 'kernel') {
          this.kill(id);
        }
      }
    },
    
    byState: function(state: ProcessDescriptor['state']): ProcessDescriptor[] {
      return this.list().filter(function(p) { return p.state === state; });
    },
    
    byName: function(name: string): ProcessDescriptor | undefined {
      return this.list().find(function(p) { return p.name === name; });
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.memory - Memory management
  // -------------------------------------------------------------------------
  memory: {
    _regions: [] as MemoryRegion[],
    _totalSize: 0x1000000, // 16MB
    _usedSize: 0,
    
    init: async function(): Promise<void> {
      this._regions = [
        { start: 0x100000, size: 0x400000, type: 'free' },
        { start: 0x500000, size: 0x100000, type: 'reserved' },
        { start: 0x600000, size: 0x800000, type: 'free' }
      ];
      jsos.cli.print('Memory manager initialized.');
    },
    
    regions: function(): MemoryRegion[] {
      return this._regions.slice();
    },
    
    stats: function(): { total: number; used: number; free: number; percent: number } {
      var free = this._regions
        .filter(function(r) { return r.type === 'free'; })
        .reduce(function(sum, r) { return sum + r.size; }, 0);
      
      return {
        total: this._totalSize,
        used: this._usedSize,
        free: free,
        percent: Math.round((this._usedSize / this._totalSize) * 100)
      };
    },
    
    allocate: function(size: number): boolean {
      var region = this._regions.find(function(r) {
        return r.type === 'free' && r.size >= size;
      });
      
      if (!region) {
        return false;
      }
      
      this._usedSize += size;
      
      var index = this._regions.indexOf(region);
      if (region.size > size) {
        this._regions[index] = {
          start: region.start + size,
          size: region.size - size,
          type: 'free'
        };
      } else {
        this._regions.splice(index, 1);
      }
      
      return true;
    },
    
    free: function(size: number): void {
      this._usedSize = Math.max(0, this._usedSize - size);
      this._regions.push({
        start: 0x300000,
        size: size,
        type: 'free'
      });
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.fs - File system operations
  // -------------------------------------------------------------------------
  fs: {
    _files: new Map<string, FileDescriptor>(),
    _cwd: '/',
    
    init: async function(): Promise<void> {
      // Create root directories
      this._files.set('/', { path: '/', name: '/', size: 0, type: 'directory', permissions: 'rwxr-xr-x', modified: Date.now() });
      this._files.set('/bin', { path: '/bin', name: 'bin', size: 0, type: 'directory', permissions: 'rwxr-xr-x', modified: Date.now() });
      this._files.set('/etc', { path: '/etc', name: 'etc', size: 0, type: 'directory', permissions: 'rwxr-xr-x', modified: Date.now() });
      this._files.set('/home', { path: '/home', name: 'home', size: 0, type: 'directory', permissions: 'rwxr-xr-x', modified: Date.now() });
      this._files.set('/tmp', { path: '/tmp', name: 'tmp', size: 0, type: 'directory', permissions: 'rwxrwxrwx', modified: Date.now() });
      this._files.set('/var', { path: '/var', name: 'var', size: 0, type: 'directory', permissions: 'rwxr-xr-x', modified: Date.now() });
      jsos.cli.print('File system initialized.');
    },
    
    cwd: function(): string {
      return this._cwd;
    },
    
    cd: function(path: string): boolean {
      var resolved = this.resolve(path);
      var file = this._files.get(resolved);
      if (file && file.type === 'directory') {
        this._cwd = resolved;
        return true;
      }
      return false;
    },
    
    resolve: function(path: string): string {
      if (path.charAt(0) === '/') {
        return path;
      }
      if (this._cwd === '/') {
        return '/' + path;
      }
      return this._cwd + '/' + path;
    },
    
    ls: function(path?: string): FileDescriptor[] {
      var dir = path ? this.resolve(path) : this._cwd;
      var results: FileDescriptor[] = [];
      
      this._files.forEach(function(file) {
        var parent = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
        if (parent === dir && file.path !== dir) {
          results.push(file);
        }
      });
      
      return results;
    },
    
    stat: function(path: string): FileDescriptor | undefined {
      return this._files.get(this.resolve(path));
    },
    
    mkdir: function(path: string): boolean {
      var resolved = this.resolve(path);
      if (this._files.has(resolved)) {
        return false;
      }
      
      var name = resolved.substring(resolved.lastIndexOf('/') + 1);
      this._files.set(resolved, {
        path: resolved,
        name: name,
        size: 0,
        type: 'directory',
        permissions: 'rwxr-xr-x',
        modified: Date.now()
      });
      return true;
    },
    
    touch: function(path: string): boolean {
      var resolved = this.resolve(path);
      if (this._files.has(resolved)) {
        return false;
      }
      
      var name = resolved.substring(resolved.lastIndexOf('/') + 1);
      this._files.set(resolved, {
        path: resolved,
        name: name,
        size: 0,
        type: 'file',
        permissions: 'rw-r--r--',
        modified: Date.now()
      });
      return true;
    },
    
    rm: function(path: string): boolean {
      var resolved = this.resolve(path);
      return this._files.delete(resolved);
    },
    
    exists: function(path: string): boolean {
      return this._files.has(this.resolve(path));
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.net - Network operations
  // -------------------------------------------------------------------------
  net: {
    _interfaces: [] as NetworkInterface[],
    _connected: false,
    
    init: async function(): Promise<void> {
      this._interfaces = [
        { name: 'lo', address: '127.0.0.1', status: 'up' },
        { name: 'eth0', address: '192.168.1.100', status: 'down' }
      ];
      jsos.cli.print('Network manager initialized.');
    },
    
    interfaces: function(): NetworkInterface[] {
      return this._interfaces.slice();
    },
    
    ifconfig: function(name: string): NetworkInterface | undefined {
      return this._interfaces.find(function(i) { return i.name === name; });
    },
    
    up: function(name: string): boolean {
      var iface = this._interfaces.find(function(i) { return i.name === name; });
      if (iface) {
        var index = this._interfaces.indexOf(iface);
        this._interfaces[index] = { name: iface.name, address: iface.address, status: 'up' };
        return true;
      }
      return false;
    },
    
    down: function(name: string): boolean {
      var iface = this._interfaces.find(function(i) { return i.name === name; });
      if (iface) {
        var index = this._interfaces.indexOf(iface);
        this._interfaces[index] = { name: iface.name, address: iface.address, status: 'down' };
        return true;
      }
      return false;
    },
    
    ping: function(host: string): { success: boolean; time: number } {
      // Simulated ping
      return { success: true, time: Math.floor(Math.random() * 100) + 1 };
    },
    
    hostname: function(): string {
      return 'jsos-host';
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.cli - Command line interface (JavaScript-based)
  // -------------------------------------------------------------------------
  cli: {
    _commands: new Map<string, { description: string; handler: Function }>(),
    _history: [] as string[],
    _historyIndex: 0,
    _prompt: 'jsos$ ',
    
    init: function(): void {
      // Register built-in commands
      this.register('help', 'Show available commands', function() { return jsos.cli.help(); });
      this.register('status', 'Show system status', function() { return jsos.cli.showStatus(); });
      this.register('ps', 'List processes', function() { return jsos.cli.showProcesses(); });
      this.register('kill', 'Kill a process', function(id: string) { return jsos.cli.killProcess(id); });
      this.register('memory', 'Show memory stats', function() { return jsos.cli.showMemory(); });
      this.register('ls', 'List directory', function(path?: string) { return jsos.cli.listDir(path); });
      this.register('cd', 'Change directory', function(path: string) { return jsos.cli.changeDir(path); });
      this.register('pwd', 'Print working directory', function() { return jsos.cli.printWorkDir(); });
      this.register('mkdir', 'Create directory', function(path: string) { return jsos.cli.makeDir(path); });
      this.register('touch', 'Create file', function(path: string) { return jsos.cli.createFile(path); });
      this.register('rm', 'Remove file/directory', function(path: string) { return jsos.cli.remove(path); });
      this.register('ifconfig', 'Show network interfaces', function() { return jsos.cli.showNetwork(); });
      this.register('ping', 'Ping a host', function(host: string) { return jsos.cli.pingHost(host); });
      this.register('clear', 'Clear screen', function() { console.clear(); return { success: true, output: '' }; });
      this.register('reboot', 'Reboot system', function() { return jsos.system.reboot(); });
      this.register('shutdown', 'Shutdown system', function() { return jsos.system.shutdown(); });
      this.register('version', 'Show version', function() { return jsos.cli.showVersion(); });
      this.register('uptime', 'Show uptime', function() { return jsos.cli.showUptime(); });
    },
    
    register: function(name: string, description: string, handler: Function): void {
      this._commands.set(name, { description: description, handler: handler });
    },
    
    exec: async function(input: string): Promise<CommandResult> {
      if (!input || !input.trim()) {
        return { success: true, output: '' };
      }
      
      this._history.push(input);
      
      var parts = input.trim().split(/\s+/);
      var cmd = parts[0];
      var args = parts.slice(1);
      
      var command = this._commands.get(cmd);
      if (!command) {
        return { success: false, output: '', error: 'Unknown command: ' + cmd };
      }
      
      try {
        var result = await command.handler.apply(null, args);
        return result || { success: true, output: '' };
      } catch (err) {
        return { success: false, output: '', error: String(err) };
      }
    },
    
    print: function(msg: string): void {
      console.log(msg);
    },
    
    error: function(msg: string): void {
      console.error(msg);
    },
    
    prompt: function(): string {
      return this._prompt;
    },
    
    history: function(): string[] {
      return this._history.slice();
    },
    
    // Command implementations
    help: function(): CommandResult {
      var lines = ['Available commands:', ''];
      jsos.cli._commands.forEach(function(cmd, name) {
        lines.push('  ' + name.padEnd(12) + ' - ' + cmd.description);
      });
      return { success: true, output: lines.join('\n') };
    },
    
    showStatus: function(): CommandResult {
      var status = jsos.system.status();
      var info = jsos.system.info();
      var lines = [
        'System Status:',
        '  Running:  ' + (status.running ? 'yes' : 'no'),
        '  Uptime:   ' + Math.floor(status.uptime / 1000) + 's',
        '  Load:     ' + status.load,
        '  Version:  ' + info.version,
        '  Arch:     ' + info.arch,
        '  Features: ' + info.features.join(', ')
      ];
      return { success: true, output: lines.join('\n') };
    },
    
    showProcesses: function(): CommandResult {
      var procs = jsos.process.list();
      var lines = [
        'PID'.padEnd(6) + 'NAME'.padEnd(20) + 'STATE'.padEnd(12) + 'PRI'.padEnd(6) + 'MEM'
      ];
      
      for (var i = 0; i < procs.length; i++) {
        var p = procs[i];
        lines.push(
          p.id.toString().padEnd(6) +
          p.name.padEnd(20) +
          p.state.padEnd(12) +
          p.priority.toString().padEnd(6) +
          '0x' + p.memoryUsage.toString(16)
        );
      }
      
      return { success: true, output: lines.join('\n') };
    },
    
    killProcess: function(id: string): CommandResult {
      var pid = parseInt(id, 10);
      if (isNaN(pid)) {
        return { success: false, output: '', error: 'Invalid PID' };
      }
      
      if (jsos.process.kill(pid)) {
        return { success: true, output: 'Process ' + pid + ' terminated' };
      }
      return { success: false, output: '', error: 'Failed to kill process ' + pid };
    },
    
    showMemory: function(): CommandResult {
      var stats = jsos.memory.stats();
      var lines = [
        'Memory Statistics:',
        '  Total:  0x' + stats.total.toString(16) + ' bytes',
        '  Used:   0x' + stats.used.toString(16) + ' bytes',
        '  Free:   0x' + stats.free.toString(16) + ' bytes',
        '  Usage:  ' + stats.percent + '%'
      ];
      return { success: true, output: lines.join('\n') };
    },
    
    listDir: function(path?: string): CommandResult {
      var files = jsos.fs.ls(path);
      if (files.length === 0) {
        return { success: true, output: '(empty)' };
      }
      
      var lines = files.map(function(f) {
        var icon = f.type === 'directory' ? 'd' : '-';
        return icon + f.permissions + ' ' + f.name;
      });
      
      return { success: true, output: lines.join('\n') };
    },
    
    changeDir: function(path: string): CommandResult {
      if (jsos.fs.cd(path)) {
        return { success: true, output: '' };
      }
      return { success: false, output: '', error: 'No such directory: ' + path };
    },
    
    printWorkDir: function(): CommandResult {
      return { success: true, output: jsos.fs.cwd() };
    },
    
    makeDir: function(path: string): CommandResult {
      if (jsos.fs.mkdir(path)) {
        return { success: true, output: '' };
      }
      return { success: false, output: '', error: 'Failed to create directory' };
    },
    
    createFile: function(path: string): CommandResult {
      if (jsos.fs.touch(path)) {
        return { success: true, output: '' };
      }
      return { success: false, output: '', error: 'Failed to create file' };
    },
    
    remove: function(path: string): CommandResult {
      if (jsos.fs.rm(path)) {
        return { success: true, output: '' };
      }
      return { success: false, output: '', error: 'Failed to remove' };
    },
    
    showNetwork: function(): CommandResult {
      var ifaces = jsos.net.interfaces();
      var lines = ifaces.map(function(i) {
        return i.name.padEnd(8) + i.address.padEnd(20) + i.status;
      });
      return { success: true, output: lines.join('\n') };
    },
    
    pingHost: function(host: string): CommandResult {
      if (!host) {
        return { success: false, output: '', error: 'Usage: ping <host>' };
      }
      var result = jsos.net.ping(host);
      if (result.success) {
        return { success: true, output: 'Reply from ' + host + ': time=' + result.time + 'ms' };
      }
      return { success: false, output: '', error: 'Host unreachable' };
    },
    
    showVersion: function(): CommandResult {
      return { success: true, output: 'JSOS v' + jsos.version };
    },
    
    showUptime: function(): CommandResult {
      var ms = jsos.system.uptime();
      var secs = Math.floor(ms / 1000);
      var mins = Math.floor(secs / 60);
      var hours = Math.floor(mins / 60);
      
      return { success: true, output: 'Uptime: ' + hours + 'h ' + (mins % 60) + 'm ' + (secs % 60) + 's' };
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.ui - Web-based UI components
  // -------------------------------------------------------------------------
  ui: {
    _windows: new Map<number, WindowDescriptor>(),
    _nextWindowId: 1,
    _focusedWindow: 0,
    
    // jsos.ui.window - Window management
    window: {
      create: function(options: { title?: string; x?: number; y?: number; width?: number; height?: number }): WindowDescriptor {
        var id = jsos.ui._nextWindowId++;
        var win: WindowDescriptor = {
          id: id,
          title: (options && options.title) || 'Untitled',
          x: (options && options.x !== undefined) ? options.x : 100,
          y: (options && options.y !== undefined) ? options.y : 100,
          width: (options && options.width !== undefined) ? options.width : 400,
          height: (options && options.height !== undefined) ? options.height : 300,
          visible: true,
          zIndex: id
        };
        
        jsos.ui._windows.set(id, win);
        jsos.ui._focusedWindow = id;
        return win;
      },
      
      close: function(id: number): boolean {
        return jsos.ui._windows.delete(id);
      },
      
      list: function(): WindowDescriptor[] {
        return Array.from(jsos.ui._windows.values());
      },
      
      get: function(id: number): WindowDescriptor | undefined {
        return jsos.ui._windows.get(id);
      },
      
      focus: function(id: number): boolean {
        if (jsos.ui._windows.has(id)) {
          jsos.ui._focusedWindow = id;
          return true;
        }
        return false;
      },
      
      focused: function(): WindowDescriptor | undefined {
        return jsos.ui._windows.get(jsos.ui._focusedWindow);
      },
      
      move: function(id: number, x: number, y: number): boolean {
        var win = jsos.ui._windows.get(id);
        if (win) {
          jsos.ui._windows.set(id, {
            id: win.id,
            title: win.title,
            x: x,
            y: y,
            width: win.width,
            height: win.height,
            visible: win.visible,
            zIndex: win.zIndex
          });
          return true;
        }
        return false;
      },
      
      resize: function(id: number, width: number, height: number): boolean {
        var win = jsos.ui._windows.get(id);
        if (win) {
          jsos.ui._windows.set(id, {
            id: win.id,
            title: win.title,
            x: win.x,
            y: win.y,
            width: width,
            height: height,
            visible: win.visible,
            zIndex: win.zIndex
          });
          return true;
        }
        return false;
      },
      
      show: function(id: number): boolean {
        var win = jsos.ui._windows.get(id);
        if (win) {
          jsos.ui._windows.set(id, {
            id: win.id,
            title: win.title,
            x: win.x,
            y: win.y,
            width: win.width,
            height: win.height,
            visible: true,
            zIndex: win.zIndex
          });
          return true;
        }
        return false;
      },
      
      hide: function(id: number): boolean {
        var win = jsos.ui._windows.get(id);
        if (win) {
          jsos.ui._windows.set(id, {
            id: win.id,
            title: win.title,
            x: win.x,
            y: win.y,
            width: win.width,
            height: win.height,
            visible: false,
            zIndex: win.zIndex
          });
          return true;
        }
        return false;
      }
    },
    
    // jsos.ui.desktop - Desktop operations
    desktop: {
      width: 1024,
      height: 768,
      background: '#1a1a2e',
      
      setResolution: function(width: number, height: number): void {
        this.width = width;
        this.height = height;
      },
      
      setBackground: function(color: string): void {
        this.background = color;
      },
      
      info: function(): { width: number; height: number; background: string } {
        return {
          width: this.width,
          height: this.height,
          background: this.background
        };
      }
    },
    
    // jsos.ui.dialog - Dialog boxes
    dialog: {
      alert: function(message: string): void {
        jsos.cli.print('[ALERT] ' + message);
      },
      
      confirm: function(message: string): boolean {
        jsos.cli.print('[CONFIRM] ' + message);
        return true; // Simulated
      },
      
      prompt: function(message: string, defaultValue?: string): string {
        jsos.cli.print('[PROMPT] ' + message);
        return defaultValue || '';
      }
    },
    
    // jsos.ui.theme - Theme management
    theme: {
      _current: 'dark',
      _themes: {
        dark: { bg: '#1a1a2e', fg: '#eee', accent: '#4a9eff' },
        light: { bg: '#f0f0f0', fg: '#333', accent: '#0066cc' }
      } as Record<string, { bg: string; fg: string; accent: string }>,
      
      current: function(): string {
        return this._current;
      },
      
      set: function(name: string): boolean {
        if (this._themes[name]) {
          this._current = name;
          return true;
        }
        return false;
      },
      
      get: function(name?: string): { bg: string; fg: string; accent: string } | undefined {
        return this._themes[name || this._current];
      },
      
      list: function(): string[] {
        return Object.keys(this._themes);
      }
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.event - Event system
  // -------------------------------------------------------------------------
  event: {
    _listeners: new Map<string, EventListener[]>(),
    _nextListenerId: 1,
    
    on: function(event: string, callback: Function): number {
      var id = this._nextListenerId++;
      var listeners = this._listeners.get(event) || [];
      listeners.push({ id: id, event: event, callback: callback });
      this._listeners.set(event, listeners);
      return id;
    },
    
    off: function(id: number): boolean {
      var found = false;
      this._listeners.forEach(function(listeners, event, map) {
        var filtered = listeners.filter(function(l) { return l.id !== id; });
        if (filtered.length !== listeners.length) {
          found = true;
          map.set(event, filtered);
        }
      });
      return found;
    },
    
    emit: function(event: string, data?: any): void {
      var listeners = this._listeners.get(event);
      if (listeners) {
        for (var i = 0; i < listeners.length; i++) {
          try {
            listeners[i].callback(data);
          } catch (e) {
            jsos.cli.error('Event handler error: ' + e);
          }
        }
      }
    },
    
    once: function(event: string, callback: Function): number {
      var self = this;
      var id = this.on(event, function(data: any) {
        self.off(id);
        callback(data);
      });
      return id;
    }
  },
  
  // -------------------------------------------------------------------------
  // jsos.config - Configuration management
  // -------------------------------------------------------------------------
  config: {
    _values: new Map<string, any>(),
    
    get: function(key: string, defaultValue?: any): any {
      if (this._values.has(key)) {
        return this._values.get(key);
      }
      return defaultValue;
    },
    
    set: function(key: string, value: any): void {
      this._values.set(key, value);
    },
    
    has: function(key: string): boolean {
      return this._values.has(key);
    },
    
    remove: function(key: string): boolean {
      return this._values.delete(key);
    },
    
    all: function(): Record<string, any> {
      var result: Record<string, any> = {};
      this._values.forEach(function(value, key) {
        result[key] = value;
      });
      return result;
    }
  }
};

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  console.clear();
  console.log('===================================================');
  console.log('       JSOS - JavaScript Operating System');
  console.log('===================================================');
  console.log('');
  
  // Initialize CLI commands
  jsos.cli.init();
  
  // Boot the system
  await jsos.system.boot();
  
  console.log('');
  console.log('System ready. Type "help" for commands.');
  console.log('Access the OS via: jsos.system, jsos.process, jsos.fs, etc.');
  console.log('');
  
  // Demo: run some commands
  var demoCommands = ['status', 'ps', 'memory', 'ls', 'ifconfig'];
  
  for (var i = 0; i < demoCommands.length; i++) {
    var cmd = demoCommands[i];
    console.log('\n' + jsos.cli.prompt() + cmd);
    var result = await jsos.cli.exec(cmd);
    if (result.output) {
      console.log(result.output);
    }
    if (result.error) {
      console.error('Error: ' + result.error);
    }
  }
  
  console.log('\n-------------------------------------------');
  console.log('Demo complete. System running.');
}

// Export the namespace and main function
export { jsos, main };
export default jsos;
