/**
 * JSOS Shell
 * Interactive command-line shell written in TypeScript
 * Runs on bare metal via Duktape, using real keyboard input from the kernel
 */

import terminal from './terminal.js';
import fs from './filesystem.js';
import { Color } from './kernel.js';
import { startRepl } from './repl.js';
import systemManager from './system.js';

declare var kernel: import('./kernel.js').KernelAPI;

export interface CommandDef {
  name: string;
  description: string;
  usage?: string;
  handler: (args: string[]) => void;
}

export class Shell {
  private commands = new Map<string, CommandDef>();
  private running = true;
  private history: string[] = [];

  constructor() {
    this.registerBuiltins();
  }

  /** Register all built-in commands */
  private registerBuiltins(): void {
    var self = this;

    this.register({
      name: 'help',
      description: 'Show available commands',
      usage: 'help [command]',
      handler: function(args) { self.cmdHelp(args); }
    });

    this.register({
      name: 'clear',
      description: 'Clear the screen',
      handler: function() { terminal.clear(); }
    });

    this.register({
      name: 'echo',
      description: 'Print text to the screen',
      usage: 'echo <text...>',
      handler: function(args) { terminal.println(args.join(' ')); }
    });

    this.register({
      name: 'ls',
      description: 'List directory contents',
      usage: 'ls [path]',
      handler: function(args) { self.cmdLs(args); }
    });

    this.register({
      name: 'cd',
      description: 'Change directory',
      usage: 'cd <path>',
      handler: function(args) { self.cmdCd(args); }
    });

    this.register({
      name: 'pwd',
      description: 'Print working directory',
      handler: function() { terminal.println(fs.cwd()); }
    });

    this.register({
      name: 'cat',
      description: 'Display file contents',
      usage: 'cat <file>',
      handler: function(args) { self.cmdCat(args); }
    });

    this.register({
      name: 'mkdir',
      description: 'Create a directory',
      usage: 'mkdir <path>',
      handler: function(args) { self.cmdMkdir(args); }
    });

    this.register({
      name: 'touch',
      description: 'Create an empty file',
      usage: 'touch <file>',
      handler: function(args) { self.cmdTouch(args); }
    });

    this.register({
      name: 'rm',
      description: 'Remove a file or empty directory',
      usage: 'rm <path>',
      handler: function(args) { self.cmdRm(args); }
    });

    this.register({
      name: 'cp',
      description: 'Copy a file',
      usage: 'cp <source> <dest>',
      handler: function(args) { self.cmdCp(args); }
    });

    this.register({
      name: 'mv',
      description: 'Move/rename a file',
      usage: 'mv <source> <dest>',
      handler: function(args) { self.cmdMv(args); }
    });

    this.register({
      name: 'write',
      description: 'Write text to a file',
      usage: 'write <file> <text...>',
      handler: function(args) { self.cmdWrite(args); }
    });

    this.register({
      name: 'find',
      description: 'Find files matching a pattern',
      usage: 'find [path] <pattern>',
      handler: function(args) { self.cmdFind(args); }
    });

    this.register({
      name: 'stat',
      description: 'Show file/directory info',
      usage: 'stat <path>',
      handler: function(args) { self.cmdStat(args); }
    });

    this.register({
      name: 'mem',
      description: 'Show memory usage',
      handler: function() { self.cmdMem(); }
    });

    this.register({
      name: 'uptime',
      description: 'Show system uptime',
      handler: function() { self.cmdUptime(); }
    });

    this.register({
      name: 'ps',
      description: 'List running processes',
      handler: function() { self.cmdPs(); }
    });

    this.register({
      name: 'run',
      description: 'Execute a JavaScript file',
      usage: 'run <file.js>',
      handler: function(args) { self.cmdRun(args); }
    });

    this.register({
      name: 'js',
      description: 'Enter JavaScript REPL',
      handler: function() { startRepl(); }
    });

    this.register({
      name: 'eval',
      description: 'Evaluate a JavaScript expression',
      usage: 'eval <expression>',
      handler: function(args) { self.cmdEval(args); }
    });

    this.register({
      name: 'colors',
      description: 'Show all available colors',
      handler: function() { self.cmdColors(); }
    });

    this.register({
      name: 'sysinfo',
      description: 'Show system information',
      handler: function() { self.cmdSysinfo(); }
    });

    this.register({
      name: 'history',
      description: 'Show command history',
      handler: function() { self.cmdHistory(); }
    });

    this.register({
      name: 'date',
      description: 'Show current uptime as system time',
      handler: function() {
        terminal.println('System uptime: ' + kernel.getUptime() + ' ms');
        terminal.println('Timer ticks: ' + kernel.getTicks());
      }
    });

    this.register({
      name: 'reboot',
      description: 'Reboot the system',
      handler: function() {
        terminal.println('Rebooting...');
        kernel.sleep(500);
        kernel.reboot();
      }
    });

    this.register({
      name: 'halt',
      description: 'Halt the system',
      handler: function() {
        terminal.println('System halting...');
        kernel.sleep(500);
        kernel.halt();
      }
    });

    this.register({
      name: 'shutdown',
      description: 'Shutdown the system',
      handler: function() {
        terminal.println('Shutting down JSOS...');
        self.running = false;
      }
    });

    this.register({
      name: 'test',
      description: 'Run system self-tests',
      handler: function() { self.cmdTest(); }
    });

    this.register({
      name: 'motd',
      description: 'Show the message of the day',
      handler: function() {
        var motd = fs.readFile('/etc/motd');
        if (motd) terminal.println(motd);
      }
    });

    this.register({
      name: 'hostname',
      description: 'Show or set hostname',
      usage: 'hostname [new_name]',
      handler: function(args) {
        if (args.length > 0) {
          fs.writeFile('/etc/hostname', args[0]);
          terminal.success('Hostname set to ' + args[0]);
        } else {
          terminal.println(fs.readFile('/etc/hostname') || 'jsos');
        }
      }
    });

    this.register({
      name: 'sleep',
      description: 'Sleep for N milliseconds',
      usage: 'sleep <ms>',
      handler: function(args) {
        var ms = parseInt(args[0]) || 1000;
        terminal.println('Sleeping for ' + ms + 'ms...');
        kernel.sleep(ms);
        terminal.println('Done.');
      }
    });
  }

  /** Register a command */
  register(cmd: CommandDef): void {
    this.commands.set(cmd.name, cmd);
  }

  /** Print the shell prompt */
  private printPrompt(): void {
    var hostname = fs.readFile('/etc/hostname') || 'jsos';
    var cwd = fs.cwd();
    // Shorten home directory
    if (cwd.indexOf('/home/user') === 0) {
      cwd = '~' + cwd.substring(10);
    }
    terminal.colorPrint(hostname, Color.LIGHT_GREEN);
    terminal.colorPrint(':', Color.LIGHT_GREY);
    terminal.colorPrint(cwd, Color.LIGHT_BLUE);
    terminal.colorPrint('$ ', Color.LIGHT_GREY);
  }

  /** Parse and execute a command string */
  execute(input: string): void {
    var trimmed = input.trim();
    if (trimmed.length === 0) return;

    // Add to history
    this.history.push(trimmed);

    // Split into command and args
    var parts = trimmed.split(' ');
    var cmdName = parts[0].toLowerCase();
    var args = parts.slice(1);

    var cmd = this.commands.get(cmdName);
    if (!cmd) {
      // Check if it's a path to a JS file
      if (cmdName.indexOf('.js') !== -1 || fs.isFile(cmdName)) {
        this.cmdRun([cmdName]);
        return;
      }
      terminal.error('Unknown command: ' + cmdName);
      terminal.println('Type "help" for available commands.');
      return;
    }

    try {
      cmd.handler(args);
    } catch (e) {
      terminal.error('Command failed: ' + e);
    }
  }

  /** Start the interactive shell loop */
  start(): void {
    // Show MOTD
    var motd = fs.readFile('/etc/motd');
    if (motd) {
      terminal.println(motd);
    }

    terminal.println('');

    // Main event loop - this blocks on keyboard input via kernel.readline()
    while (this.running) {
      this.printPrompt();
      var line = kernel.readline();
      this.execute(line);
    }

    terminal.println('Shell exited.');
  }

  // ==========================================
  // Command implementations
  // ==========================================

  private cmdHelp(args: string[]): void {
    if (args.length > 0) {
      var cmd = this.commands.get(args[0]);
      if (cmd) {
        terminal.colorPrintln(cmd.name, Color.WHITE);
        terminal.println('  ' + cmd.description);
        if (cmd.usage) {
          terminal.println('  Usage: ' + cmd.usage);
        }
      } else {
        terminal.error('Unknown command: ' + args[0]);
      }
      return;
    }

    terminal.colorPrintln('JSOS Shell - Available Commands', Color.WHITE);
    terminal.rule('-', 50);

    // Group commands by category
    var categories: { [key: string]: string[] } = {
      'File System': ['ls', 'cd', 'pwd', 'cat', 'mkdir', 'touch', 'rm', 'cp', 'mv', 'write', 'find', 'stat'],
      'System': ['mem', 'uptime', 'ps', 'sysinfo', 'date', 'hostname', 'test'],
      'JavaScript': ['js', 'eval', 'run'],
      'Terminal': ['clear', 'echo', 'colors', 'sleep', 'motd', 'history'],
      'Power': ['reboot', 'halt', 'shutdown'],
    };

    var catKeys = Object.keys(categories);
    for (var c = 0; c < catKeys.length; c++) {
      var catName = catKeys[c];
      terminal.println('');
      terminal.colorPrintln('  ' + catName + ':', Color.YELLOW);
      var cmds = categories[catName];
      for (var i = 0; i < cmds.length; i++) {
        var cmd = this.commands.get(cmds[i]);
        if (cmd) {
          var name = cmd.name;
          while (name.length < 12) name += ' ';
          terminal.print('    ');
          terminal.colorPrint(name, Color.LIGHT_CYAN);
          terminal.println(cmd.description);
        }
      }
    }

    terminal.println('');
    terminal.println('Type "help <command>" for detailed usage.');
  }

  private cmdLs(args: string[]): void {
    var path = args[0] || '';
    var items = fs.ls(path);

    if (items.length === 0) {
      var target = path || fs.cwd();
      if (!fs.exists(target)) {
        terminal.error('No such directory: ' + target);
      } else {
        terminal.println('(empty)');
      }
      return;
    }

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type === 'directory') {
        terminal.colorPrint(item.name + '/', Color.LIGHT_BLUE);
      } else if (item.name.indexOf('.js') !== -1) {
        terminal.colorPrint(item.name, Color.LIGHT_GREEN);
      } else {
        terminal.print(item.name);
      }

      if (item.type === 'file') {
        // Show file size
        var sizeStr = '' + item.size;
        var padding = '';
        for (var p = 0; p < 30 - item.name.length; p++) padding += ' ';
        terminal.colorPrint(padding + sizeStr + ' bytes', Color.DARK_GREY);
      }

      terminal.println('');
    }
  }

  private cmdCd(args: string[]): void {
    var path = args[0] || '/home/user';
    if (!fs.cd(path)) {
      terminal.error('No such directory: ' + path);
    }
  }

  private cmdCat(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: cat <file>');
      return;
    }

    var content = fs.readFile(args[0]);
    if (content === null) {
      terminal.error('No such file: ' + args[0]);
      return;
    }

    terminal.println(content);
  }

  private cmdMkdir(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: mkdir <path>');
      return;
    }
    if (fs.mkdir(args[0])) {
      terminal.success('Created directory: ' + args[0]);
    } else {
      terminal.error('Failed to create directory: ' + args[0]);
    }
  }

  private cmdTouch(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: touch <file>');
      return;
    }
    if (!fs.exists(args[0])) {
      fs.writeFile(args[0], '');
    }
    terminal.success('Created file: ' + args[0]);
  }

  private cmdRm(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: rm <path>');
      return;
    }
    if (fs.rm(args[0])) {
      terminal.success('Removed: ' + args[0]);
    } else {
      terminal.error('Failed to remove: ' + args[0]);
    }
  }

  private cmdCp(args: string[]): void {
    if (args.length < 2) {
      terminal.error('Usage: cp <source> <dest>');
      return;
    }
    if (fs.cp(args[0], args[1])) {
      terminal.success('Copied ' + args[0] + ' -> ' + args[1]);
    } else {
      terminal.error('Failed to copy: ' + args[0]);
    }
  }

  private cmdMv(args: string[]): void {
    if (args.length < 2) {
      terminal.error('Usage: mv <source> <dest>');
      return;
    }
    if (fs.mv(args[0], args[1])) {
      terminal.success('Moved ' + args[0] + ' -> ' + args[1]);
    } else {
      terminal.error('Failed to move: ' + args[0]);
    }
  }

  private cmdWrite(args: string[]): void {
    if (args.length < 2) {
      terminal.error('Usage: write <file> <text...>');
      return;
    }
    var file = args[0];
    var text = args.slice(1).join(' ');
    if (fs.writeFile(file, text + '\n')) {
      terminal.success('Wrote ' + (text.length + 1) + ' bytes to ' + file);
    } else {
      terminal.error('Failed to write: ' + file);
    }
  }

  private cmdFind(args: string[]): void {
    var basePath = '/';
    var pattern = '*';

    if (args.length === 1) {
      pattern = args[0];
    } else if (args.length >= 2) {
      basePath = args[0];
      pattern = args[1];
    }

    var results = fs.find(basePath, pattern);
    if (results.length === 0) {
      terminal.println('No files found matching: ' + pattern);
      return;
    }

    for (var i = 0; i < results.length; i++) {
      terminal.println(results[i]);
    }
    terminal.println('');
    terminal.println(results.length + ' file(s) found.');
  }

  private cmdStat(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: stat <path>');
      return;
    }
    var info = fs.stat(args[0]);
    if (!info) {
      terminal.error('No such file or directory: ' + args[0]);
      return;
    }

    terminal.println('  File: ' + args[0]);
    terminal.println('  Type: ' + info.type);
    terminal.println('  Size: ' + info.size + ' bytes');
    terminal.println('  Perm: ' + info.permissions);
  }

  private cmdMem(): void {
    var mem = kernel.getMemoryInfo();
    terminal.colorPrintln('Memory Information', Color.WHITE);
    terminal.rule('-', 40);
    terminal.println('  Total:  ' + mem.total + ' bytes (' + Math.floor(mem.total / 1024) + ' KB)');
    terminal.println('  Used:   ' + mem.used + ' bytes (' + Math.floor(mem.used / 1024) + ' KB)');
    terminal.println('  Free:   ' + mem.free + ' bytes (' + Math.floor(mem.free / 1024) + ' KB)');

    // Visual bar
    var barWidth = 40;
    var usedBar = Math.floor((mem.used / mem.total) * barWidth);
    var bar = '';
    for (var i = 0; i < barWidth; i++) {
      bar += i < usedBar ? '#' : '.';
    }
    terminal.print('  [');
    terminal.colorPrint(bar.substring(0, usedBar), Color.LIGHT_RED);
    terminal.colorPrint(bar.substring(usedBar), Color.LIGHT_GREEN);
    terminal.println('] ' + Math.floor((mem.used / mem.total) * 100) + '%');
  }

  private cmdUptime(): void {
    var ms = kernel.getUptime();
    var seconds = Math.floor(ms / 1000);
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);

    seconds = seconds % 60;
    minutes = minutes % 60;

    var parts: string[] = [];
    if (hours > 0) parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
    parts.push(seconds + 's');

    terminal.println('Uptime: ' + parts.join(' ') + ' (' + ms + ' ms)');
    terminal.println('Ticks:  ' + kernel.getTicks());
  }

  private cmdPs(): void {
    var processes = systemManager.getProcessList();
    terminal.colorPrintln('Process List', Color.WHITE);
    terminal.rule('-', 55);
    terminal.printRow(['PID', 'NAME', 'STATE', 'PRIORITY'], [6, 20, 14, 10]);
    terminal.rule('-', 55);

    for (var i = 0; i < processes.length; i++) {
      var p = processes[i];
      terminal.printRow(
        ['' + p.id, p.name, p.state, '' + p.priority],
        [6, 20, 14, 10]
      );
    }
    terminal.println('');
    terminal.println(processes.length + ' process(es)');
  }

  private cmdRun(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: run <file.js>');
      return;
    }

    var file = args[0];
    var content = fs.readFile(file);
    if (content === null) {
      // Try with /bin/ prefix
      content = fs.readFile('/bin/' + file);
      if (content === null) {
        terminal.error('File not found: ' + file);
        return;
      }
    }

    terminal.info('Running ' + file + '...');
    try {
      var result = kernel.eval(content);
      if (result && result !== 'undefined') {
        terminal.println(result);
      }
    } catch (e) {
      terminal.error('Execution failed: ' + e);
    }
  }

  private cmdEval(args: string[]): void {
    if (args.length === 0) {
      terminal.error('Usage: eval <expression>');
      return;
    }
    var code = args.join(' ');
    try {
      var result = kernel.eval(code);
      if (result !== 'undefined') {
        terminal.colorPrintln(result, Color.LIGHT_GREEN);
      }
    } catch (e) {
      terminal.error('' + e);
    }
  }

  private cmdColors(): void {
    var names = [
      'BLACK', 'BLUE', 'GREEN', 'CYAN',
      'RED', 'MAGENTA', 'BROWN', 'LIGHT_GREY',
      'DARK_GREY', 'LIGHT_BLUE', 'LIGHT_GREEN', 'LIGHT_CYAN',
      'LIGHT_RED', 'LIGHT_MAGENTA', 'YELLOW', 'WHITE'
    ];

    terminal.colorPrintln('VGA Color Palette', Color.WHITE);
    terminal.rule('-', 40);
    for (var i = 0; i < 16; i++) {
      var label = '' + i;
      while (label.length < 3) label = ' ' + label;
      terminal.colorPrint(' ' + label + ' ', i, Color.BLACK);
      terminal.colorPrint(' ' + names[i], Color.LIGHT_GREY);
      terminal.println('');
    }
  }

  private cmdSysinfo(): void {
    var mem = kernel.getMemoryInfo();
    var screen = kernel.getScreenSize();
    var uptime = kernel.getUptime();

    terminal.colorPrintln('JSOS System Information', Color.WHITE);
    terminal.rule('=', 45);
    terminal.println('  OS:       JSOS v' + (fs.readFile('/etc/version') || '1.0.0'));
    terminal.println('  Hostname: ' + (fs.readFile('/etc/hostname') || 'jsos'));
    terminal.println('  Arch:     i686 (x86 32-bit)');
    terminal.println('  Runtime:  Duktape JavaScript Engine');
    terminal.println('  Language: TypeScript (transpiled to ES5)');
    terminal.println('  Screen:   ' + screen.width + 'x' + screen.height + ' VGA text mode');
    terminal.println('  Memory:   ' + Math.floor(mem.total / 1024) + ' KB total, ' + Math.floor(mem.free / 1024) + ' KB free');
    terminal.println('  Uptime:   ' + Math.floor(uptime / 1000) + ' seconds');
    terminal.println('  Procs:    ' + systemManager.getProcessList().length);
    terminal.rule('=', 45);
  }

  private cmdHistory(): void {
    if (this.history.length === 0) {
      terminal.println('No command history.');
      return;
    }
    for (var i = 0; i < this.history.length; i++) {
      var num = '' + (i + 1);
      while (num.length < 4) num = ' ' + num;
      terminal.colorPrint(num + '  ', Color.DARK_GREY);
      terminal.println(this.history[i]);
    }
  }

  private cmdTest(): void {
    terminal.colorPrintln('Running JSOS Self-Tests...', Color.WHITE);
    terminal.rule('-', 40);
    
    var passed = 0;
    var failed = 0;

    // Test 1: Filesystem
    terminal.print('  Filesystem basics... ');
    try {
      fs.writeFile('/tmp/test', 'hello');
      var content = fs.readFile('/tmp/test');
      if (content === 'hello') {
        fs.rm('/tmp/test');
        if (!fs.exists('/tmp/test')) {
          terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
          passed++;
        } else {
          throw new Error('rm failed');
        }
      } else {
        throw new Error('read/write mismatch');
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 2: Filesystem paths
    terminal.print('  Path resolution... ');
    try {
      fs.mkdir('/tmp/a/b/c');
      if (fs.isDirectory('/tmp/a/b/c') && fs.isDirectory('/tmp/a/b') && fs.isDirectory('/tmp/a')) {
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('mkdir -p failed');
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 3: Memory info
    terminal.print('  Memory info... ');
    try {
      var mem = kernel.getMemoryInfo();
      if (mem.total > 0 && mem.free >= 0 && mem.used >= 0) {
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('invalid memory info');
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 4: Timer
    terminal.print('  Timer... ');
    try {
      var t1 = kernel.getUptime();
      kernel.sleep(100);
      var t2 = kernel.getUptime();
      if (t2 > t1) {
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('timer not advancing');
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 5: Process management
    terminal.print('  Process management... ');
    try {
      var count1 = systemManager.getProcessList().length;
      var p = systemManager.createProcess('test-proc', { priority: 5 });
      if (p && systemManager.getProcessList().length === count1 + 1) {
        systemManager.terminateProcess(p.id);
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('process create failed');
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 6: JS eval
    terminal.print('  JS eval... ');
    try {
      var result = kernel.eval('2 + 2');
      if (result === '4') {
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('expected 4, got: ' + result);
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    // Test 7: Screen info
    terminal.print('  Screen info... ');
    try {
      var screen = kernel.getScreenSize();
      if (screen.width === 80 && screen.height === 25) {
        terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
        passed++;
      } else {
        throw new Error('unexpected: ' + screen.width + 'x' + screen.height);
      }
    } catch (e) {
      terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
      failed++;
    }

    terminal.println('');
    terminal.rule('-', 40);
    var total = passed + failed;
    if (failed === 0) {
      terminal.colorPrintln('All ' + total + ' tests passed!', Color.LIGHT_GREEN);
    } else {
      terminal.println(passed + '/' + total + ' tests passed, ' + failed + ' failed.');
    }
  }
}

const shell = new Shell();
export default shell;
