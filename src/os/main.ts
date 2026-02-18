/**
 * JSOS - JavaScript Operating System
 * Main entry point
 *
 * Boots directly into a JavaScript REPL. No traditional shell or
 * filesystem commands  everything is live JavaScript running on
 * bare metal via QuickJS ES2023.
 */

import terminal from './terminal.js';
import { Color } from './kernel.js';
import { startRepl } from './repl.js';
import fs from './filesystem.js';
import { openEditor } from './editor.js';
import { syscalls } from './syscalls.js';
import { scheduler } from './scheduler.js';
import { vmm } from './vmm.js';
import { init } from './init.js';

declare var kernel: import('./kernel.js').KernelAPI;

/** Route console.log / .error / .warn through the TypeScript terminal */
function setupConsole(): void {
  var con = {
    log: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if (arg === null) {
          parts.push('null');
        } else if (arg === undefined) {
          parts.push('undefined');
        } else if (typeof arg === 'object') {
          try { parts.push(JSON.stringify(arg)); } catch (e) { parts.push('' + arg); }
        } else {
          parts.push('' + arg);
        }
      }
      terminal.println(parts.join(' '));
    },
    error: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = terminal.pushColor(Color.LIGHT_RED, Color.BLACK);
      terminal.println(parts.join(' '));
      terminal.popColor(saved);
    },
    warn: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = terminal.pushColor(Color.YELLOW, Color.BLACK);
      terminal.println(parts.join(' '));
      terminal.popColor(saved);
    },
    clear: function() { terminal.clear(); }
  };
  (globalThis as any).console = con;
}

// ── Printable result helpers ──────────────────────────────────────────────
// Wrap a real JS value so the REPL auto-pretty-prints it when it is the
// result of an expression, while keeping it fully usable for scripting:
//   ls()                   → pretty-prints the directory listing
//   ls().map(f => f.name)  → returns a plain string array (no magic)
//   ls().length            → number of entries
//
// The sentinel method __jsos_print__ is non-enumerable so it never shows up
// in JSON.stringify, Object.keys, for..in, or spread.

function printableArray<T>(items: T[], printer: (arr: T[]) => void): T[] {
  var arr: any = items.slice();
  Object.defineProperty(arr, '__jsos_print__', {
    value: function() { printer(arr); }, enumerable: false, configurable: true,
  });
  return arr as T[];
}

function printableObject<T extends object>(data: T, printer: (obj: T) => void): T {
  var obj: any = Object.assign({}, data);
  Object.defineProperty(obj, '__jsos_print__', {
    value: function() { printer(obj); }, enumerable: false, configurable: true,
  });
  return obj as T;
}

/**
 * All OS functionality exposed as plain JS globals in the REPL.
 * Data functions (ls, ps, mem, …) return Printable values: they auto-
 * pretty-print as a REPL expression but are real arrays/objects for scripting.
 * Raw-data functions (fs.*, sys.*) always return plain values.
 */
function setupGlobals(): void {
  var g = globalThis as any;

  // ── Scripting APIs (return raw data) ──────────────────────────────────────

  // Expose terminal directly so user scripts can use terminal.println(),
  // terminal.setColor(), etc. without going through the kernel binding.
  g.terminal = terminal;

  g.fs = {
    ls:     function(p?: string) { return fs.ls(p || ''); },
    read:   function(p: string)  { return fs.readFile(p); },
    write:  function(p: string, c: string) { return fs.writeFile(p, c); },
    append: function(p: string, c: string) { return fs.appendFile(p, c); },
    mkdir:  function(p: string) { return fs.mkdir(p); },
    touch:  function(p: string) { if (!fs.exists(p)) fs.writeFile(p, ''); return true; },
    rm:     function(p: string) { return fs.rm(p); },
    cp:     function(s: string, d: string) { return fs.cp(s, d); },
    mv:     function(s: string, d: string) { return fs.mv(s, d); },
    stat:   function(p: string) { return fs.stat(p); },
    exists: function(p: string) { return fs.exists(p); },
    isDir:  function(p: string) { return fs.isDirectory(p); },
    isFile: function(p: string) { return fs.isFile(p); },
    pwd:    function() { return fs.cwd(); },
    cd:     function(p: string) { return fs.cd(p); },
    find:   function(path: string, pat: string) { return fs.find(path, pat); },
    run:    function(p: string) {
      var code = fs.readFile(p) || fs.readFile('/bin/' + p);
      if (!code) { terminal.println('Not found: ' + p); return; }
      return kernel.eval(code);
    },
  };

  g.sys = {
    mem:      function() { return kernel.getMemoryInfo(); },
    uptime:   function() { return kernel.getUptime(); },
    ticks:    function() { return kernel.getTicks(); },
    screen:   function() { return kernel.getScreenSize(); },
    ps:       function() { return scheduler.getAllProcesses(); },
    spawn:    function(name: string) {
      return scheduler.createProcess(0, { priority: 10, timeSlice: 10, memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 } });
    },
    kill:     function(pid: number) { return scheduler.terminateProcess(pid); },
    sleep:    function(ms: number) { kernel.sleep(ms); },
    reboot:   function() { kernel.reboot(); },
    halt:     function() { kernel.halt(); },
    hostname: function(n?: string) {
      if (n !== undefined) { fs.writeFile('/etc/hostname', n); return n; }
      return fs.readFile('/etc/hostname') || 'jsos';
    },
    version:  function() { return fs.readFile('/etc/version') || '1.0.0'; },
    sysinfo:  function() {
      var m = kernel.getMemoryInfo();
      var vm = vmm.getMemoryStats();
      return { os: 'JSOS v' + (fs.readFile('/etc/version') || '1.0.0'),
               hostname: fs.readFile('/etc/hostname') || 'jsos',
               arch: 'i686',
               runtime: 'QuickJS ES2023',
               screen: kernel.getScreenSize(),
               memory: m,
               virtualMemory: vm,
               uptime: kernel.getUptime(),
               processes: scheduler.getAllProcesses().length,
               scheduler: scheduler.getAlgorithm(),
               runlevel: init.getCurrentRunlevel() };
    },
    // New OS components
    scheduler: scheduler,
    vmm: vmm,
    init: init,
    syscalls: syscalls,
  };

  // ── Shorthand print ───────────────────────────────────────────────────────

  g.print = function(s: any) { terminal.println(String(s)); };

  // ── Shell-like functions (print output, return undefined) ─────────────────
  // These behave like unix commands: they display formatted output.
  // For scriptable data, use fs.* and sys.* above.

  function pad(s: string, w: number) { while (s.length < w) s += ' '; return s; }
  function lpad(s: string, w: number) { while (s.length < w) s = ' ' + s; return s; }

  g.ls = function(path?: string) {
    var target = path || fs.cwd();
    if (path && !fs.exists(path)) { terminal.println('ls: ' + path + ': no such directory'); return; }
    var items = fs.ls(path || '');
    return printableArray(items, function(arr) {
      terminal.colorPrintln('  ' + target, Color.DARK_GREY);
      if (arr.length === 0) { terminal.colorPrintln('  (empty)', Color.DARK_GREY); return; }
      for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        terminal.print('  ');
        if (item.type === 'directory') {
          terminal.colorPrint(item.name + '/', Color.LIGHT_BLUE);
          terminal.println('');
        } else {
          var nameCol = item.name.slice(-3) === '.js' ? Color.LIGHT_GREEN : Color.LIGHT_GREY;
          terminal.colorPrint(pad(item.name, 28), nameCol);
          terminal.colorPrintln(item.size + 'B', Color.DARK_GREY);
        }
      }
    });
  };

  g.cd = function(path?: string) {
    var p = path || '/home/user';
    if (!fs.cd(p)) { terminal.println('cd: ' + p + ': no such directory'); return; }
    var cwd = fs.cwd();
    if (cwd.indexOf('/home/user') === 0) cwd = '~' + cwd.slice(10);
    terminal.colorPrintln(cwd, Color.LIGHT_BLUE);
  };

  g.pwd = function() { terminal.colorPrintln(fs.cwd(), Color.LIGHT_BLUE); };

  g.cat = function(path: string) {
    if (!path) { terminal.println('usage: cat(path)'); return; }
    var c = fs.readFile(path);
    if (c === null) { terminal.println('cat: ' + path + ': no such file'); return; }
    terminal.print(c[c.length - 1] === '\n' ? c : c + '\n');
  };

  g.mkdir = function(path: string) {
    if (!path) { terminal.println('usage: mkdir(path)'); return; }
    if (fs.mkdir(path)) terminal.colorPrintln('created: ' + path, Color.LIGHT_GREEN);
    else terminal.println('mkdir: ' + path + ': failed');
  };

  g.touch = function(path: string) {
    if (!path) { terminal.println('usage: touch(path)'); return; }
    if (!fs.exists(path)) fs.writeFile(path, '');
    terminal.colorPrintln('touched: ' + path, Color.LIGHT_GREEN);
  };

  g.rm = function(path: string) {
    if (!path) { terminal.println('usage: rm(path)'); return; }
    if (fs.rm(path)) terminal.colorPrintln('removed: ' + path, Color.LIGHT_GREEN);
    else terminal.println('rm: ' + path + ': failed (not found or non-empty dir)');
  };

  g.cp = function(src: string, dst: string) {
    if (!src || !dst) { terminal.println('usage: cp(src, dst)'); return; }
    if (fs.cp(src, dst)) terminal.colorPrintln('copied: ' + src + ' -> ' + dst, Color.LIGHT_GREEN);
    else terminal.println('cp: ' + src + ': failed');
  };

  g.mv = function(src: string, dst: string) {
    if (!src || !dst) { terminal.println('usage: mv(src, dst)'); return; }
    if (fs.mv(src, dst)) terminal.colorPrintln('moved: ' + src + ' -> ' + dst, Color.LIGHT_GREEN);
    else terminal.println('mv: ' + src + ': failed');
  };

  g.write = function(path: string, content: string) {
    if (!path) { terminal.println('usage: write(path, content)'); return; }
    if (fs.writeFile(path, content || ''))
      terminal.colorPrintln('wrote ' + (content || '').length + 'B -> ' + path, Color.LIGHT_GREEN);
    else terminal.println('write: ' + path + ': failed');
  };

  g.append = function(path: string, content: string) {
    if (!path) { terminal.println('usage: append(path, content)'); return; }
    if (fs.appendFile(path, content || ''))
      terminal.colorPrintln('appended ' + (content || '').length + 'B -> ' + path, Color.LIGHT_GREEN);
    else terminal.println('append: ' + path + ': failed');
  };

  g.find = function(pathOrPat: string, pattern?: string) {
    var base = pattern ? pathOrPat : '/';
    var pat  = pattern || pathOrPat || '*';
    var results = fs.find(base, pat);
    return printableArray(results, function(arr) {
      for (var i = 0; i < arr.length; i++) terminal.println('  ' + arr[i]);
      terminal.colorPrintln('  ' + arr.length + ' match(es)', Color.DARK_GREY);
    });
  };

  g.stat = function(path: string) {
    if (!path) { terminal.println('usage: stat(path)'); return; }
    var info = fs.stat(path);
    if (!info) { terminal.println('stat: ' + path + ': no such path'); return; }
    var data = Object.assign({ path: path }, info);
    return printableObject(data, function(obj: any) {
      terminal.println('  path : ' + obj.path);
      terminal.println('  type : ' + obj.type);
      terminal.println('  size : ' + obj.size + ' bytes');
      terminal.println('  perm : ' + obj.permissions);
    });
  };

  g.run = function(path: string) {
    if (!path) { terminal.println('usage: run(path)'); return; }
    var code = fs.readFile(path) || fs.readFile('/bin/' + path);
    if (!code) { terminal.println('run: ' + path + ': not found'); return; }
    terminal.colorPrintln('running ' + path + '...', Color.DARK_GREY);
    var r = kernel.eval(code);
    if (r && r !== 'undefined') terminal.println(r);
  };

  g.ps = function() {
    var procs = scheduler.getAllProcesses();
    return printableArray(procs, function(arr: any[]) {
      terminal.colorPrintln('  ' + lpad('PID', 4) + '  ' + pad('NAME', 18) + pad('STATE', 12) + 'PRI', Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 42).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        terminal.println('  ' + lpad('' + p.pid, 4) + '  ' + pad(p.ppid ? '[' + p.ppid + '] ' : '[0] ', 18) + pad(p.state, 12) + p.priority);
      }
      terminal.colorPrintln('  ' + arr.length + ' process(es)', Color.DARK_GREY);
    });
  };

  g.kill = function(pid: number) {
    if (pid === undefined) { terminal.println('usage: kill(pid)'); return; }
    if (scheduler.terminateProcess(pid))
      terminal.colorPrintln('killed PID ' + pid, Color.LIGHT_GREEN);
    else terminal.println('kill: PID ' + pid + ': not found or protected');
  };

  g.mem = function() {
    var m = kernel.getMemoryInfo();
    var kb = { total: Math.floor(m.total / 1024), used: Math.floor(m.used / 1024), free: Math.floor(m.free / 1024) };
    return printableObject(kb, function(obj: any) {
      terminal.colorPrintln('Memory', Color.WHITE);
      terminal.println('  total : ' + obj.total + ' KB');
      terminal.println('  used  : ' + obj.used  + ' KB');
      terminal.println('  free  : ' + obj.free  + ' KB');
      var BAR = 36, usedBars = Math.min(BAR, Math.floor((m.used / m.total) * BAR));
      var b1 = pad('', usedBars).replace(/ /g, '#');
      var b2 = pad('', BAR - usedBars).replace(/ /g, '.');
      terminal.print('  ['); terminal.colorPrint(b1, Color.LIGHT_RED);
      terminal.colorPrint(b2, Color.LIGHT_GREEN);
      terminal.println(']  ' + Math.floor((m.used / m.total) * 100) + '%');
    });
  };

  g.uptime = function() {
    var ms = kernel.getUptime();
    var s = Math.floor(ms / 1000), m2 = Math.floor(s / 60), h = Math.floor(m2 / 60);
    s = s % 60; m2 = m2 % 60;
    var parts: string[] = [];
    if (h > 0) parts.push(h + 'h');
    if (m2 > 0) parts.push(m2 + 'm');
    parts.push(s + 's');
    var info = { uptime: parts.join(' '), ms: ms, ticks: kernel.getTicks() };
    return printableObject(info, function(obj: any) {
      terminal.println('  ' + obj.uptime + '  (' + obj.ms + ' ms)');
      terminal.colorPrintln('  ticks: ' + obj.ticks, Color.DARK_GREY);
    });
  };

  g.sysinfo = function() {
    var m = kernel.getMemoryInfo(), sc = kernel.getScreenSize();
    var info = {
      os:       'JSOS v' + (fs.readFile('/etc/version') || '1.0.0'),
      hostname: fs.readFile('/etc/hostname') || 'jsos',
      arch:     'i686 (x86 32-bit)',
      runtime:  'QuickJS ES2023',
      screen:   sc.width + 'x' + sc.height + ' VGA text',
      memory:   { total: Math.floor(m.total/1024), free: Math.floor(m.free/1024), used: Math.floor(m.used/1024) },
      uptime:   Math.floor(kernel.getUptime() / 1000) + 's',
      procs:    scheduler.getAllProcesses().length,
    };
    return printableObject(info, function(obj: any) {
      terminal.colorPrintln('JSOS System Information', Color.WHITE);
      terminal.println('  os       : ' + obj.os);
      terminal.println('  hostname : ' + obj.hostname);
      terminal.println('  arch     : ' + obj.arch);
      terminal.println('  runtime  : ' + obj.runtime);
      terminal.println('  screen   : ' + obj.screen);
      terminal.println('  memory   : ' + obj.memory.total + ' KB total, ' + obj.memory.free + ' KB free');
      terminal.println('  uptime   : ' + obj.uptime);
      terminal.println('  procs    : ' + obj.procs);
    });
  };

  g.colors = function() {
    var names = ['BLACK','BLUE','GREEN','CYAN','RED','MAGENTA','BROWN','LT_GREY',
                 'DK_GREY','LT_BLUE','LT_GREEN','LT_CYAN','LT_RED','LT_MAG','YELLOW','WHITE'];
    terminal.colorPrintln('VGA Palette (0-15)', Color.WHITE);
    for (var i = 0; i < 16; i++) {
      terminal.setColor(i, 0); terminal.print('  ' + lpad('' + i, 2) + ' ########  ');
      terminal.setColor(7, 0); terminal.colorPrintln(names[i], Color.DARK_GREY);
    }
  };

  g.hostname = function(name?: string) {
    if (name) { fs.writeFile('/etc/hostname', name); terminal.colorPrintln('hostname -> ' + name, Color.LIGHT_GREEN); }
    else terminal.println(fs.readFile('/etc/hostname') || 'jsos');
  };

  g.echo = function() {
    var parts: string[] = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    terminal.println(parts.join(' '));
  };

  g.clear  = function() { terminal.clear(); };
  g.sleep  = function(ms: number) { kernel.sleep(ms); };
  g.halt   = function() { kernel.halt(); };
  g.reboot = function() { kernel.reboot(); };

  // ── Text editor ──────────────────────────────────────────────────
  g.edit = function(path?: string) { openEditor(path); };

  // ── User-defined printables ──────────────────────────────────────
  // Let users wrap their own data: printable([1,2,3], arr => arr.forEach(x => print(x)))
  g.printable = function(data: any, printer: (d: any) => void): any {
    if (Array.isArray(data)) return printableArray(data, printer);
    return printableObject(data, printer);
  };

  g.help = function() {
    terminal.println('');
    terminal.colorPrintln('JSOS  —  everything is JavaScript', Color.WHITE);
    terminal.colorPrintln('QuickJS ES2023 on bare-metal i686', Color.DARK_GREY);
    terminal.println('');
    terminal.colorPrintln('Filesystem functions:', Color.YELLOW);
    terminal.println('  ls(path?)            list directory');
    terminal.println('  cd(path?)            change directory  (~ = /home/user)');
    terminal.println('  pwd()                print working directory');
    terminal.println('  cat(path)            print file contents');
    terminal.println('  mkdir(path)          create directory');
    terminal.println('  touch(path)          create empty file');
    terminal.println('  rm(path)             remove file or empty dir');
    terminal.println('  cp(src, dst)         copy file');
    terminal.println('  mv(src, dst)         move / rename');
    terminal.println('  write(path, text)    overwrite file');
    terminal.println('  append(path, text)   append to file');
    terminal.println('  find(path?, pat)     find files  (* wildcard)');
    terminal.println('  stat(path)           file info');
    terminal.println('  run(path)            execute a .js file');
    terminal.println('');
    terminal.colorPrintln('System functions:', Color.YELLOW);
    terminal.println('  ps()                 process list');
    terminal.println('  kill(pid)            terminate process');
    terminal.println('  mem()                memory usage + bar');
    terminal.println('  uptime()             system uptime');
    terminal.println('  sysinfo()            full system summary');
    terminal.println('  colors()             VGA color palette');
    terminal.println('  hostname(name?)      show or set hostname');
    terminal.println('  sleep(ms)            sleep N milliseconds');
    terminal.println('  clear()              clear the screen');
    terminal.println('  halt()               power off');
    terminal.println('  reboot()             reboot');
    terminal.println('  edit(path?)          fullscreen text editor  (^S save  ^Q quit)');
    terminal.println('');
    terminal.colorPrintln('REPL functions:', Color.YELLOW);
    terminal.println('  history()            show input history');
    terminal.println('  echo(...)            print arguments');
    terminal.println('  print(s)             print a value');
    terminal.println('  printable(data, fn)  wrap data with a custom pretty-printer');
    terminal.println('');
    terminal.colorPrintln('Scripting APIs (return raw data):', Color.YELLOW);
    terminal.colorPrint('  fs', Color.LIGHT_CYAN);
    terminal.println('   .ls .read .write .append .mkdir .rm .cp .mv .stat');
    terminal.println('       .exists .isDir .isFile .pwd .cd .find .run');
    terminal.colorPrint('  sys', Color.LIGHT_CYAN);
    terminal.println('  .mem .ps .kill .uptime .screen .sysinfo .spawn');
    terminal.println('       .hostname .version .reboot .halt');
    terminal.println('');
    terminal.colorPrintln('Keyboard:', Color.YELLOW);
    terminal.println('  Up / Down    browse history');
    terminal.println('  Ctrl+U       erase line');
    terminal.println('  Ctrl+C       cancel line');
    terminal.println('  Ctrl+L       redraw screen');
    terminal.println('  open { ( [   enter multiline mode; blank line to run');
    terminal.println('');
    terminal.colorPrintln('Examples:', Color.YELLOW);
    terminal.colorPrintln("  ls()", Color.WHITE);
    terminal.colorPrintln("  ls('/bin').map(f => f.name)", Color.WHITE);
    terminal.colorPrintln("  ls('/bin').filter(f => f.type === 'file')", Color.WHITE);
    terminal.colorPrintln("  ps().find(p => p.name === 'repl')", Color.WHITE);
    terminal.colorPrintln("  mem().free", Color.WHITE);
    terminal.colorPrintln("  sysinfo().hostname", Color.WHITE);
    terminal.colorPrintln("  cat('/etc/hostname')", Color.WHITE);
    terminal.colorPrintln("  write('/tmp/hi.js', 'print(42)')", Color.WHITE);
    terminal.colorPrintln("  run('/tmp/hi.js')", Color.WHITE);
    terminal.colorPrintln("  JSON.stringify(sys.sysinfo(), null, 2)", Color.WHITE);
    terminal.println('');
  };
}

/** Boot banner */
function printBanner(): void {
  terminal.clear();
  terminal.setColor(Color.LIGHT_CYAN, Color.BLACK);
  terminal.println('');
  terminal.println('     ######  ######  ####### ######  ');
  terminal.println('       ##   ##       ##   ## ##      ');
  terminal.println('       ##    ######  ##   ##  #####  ');
  terminal.println('  ##   ##        ## ##   ##      ## ');
  terminal.println('   #####   ######  ####### ######  ');
  terminal.println('');
  terminal.setColor(Color.WHITE, Color.BLACK);
  terminal.println('       JavaScript Operating System');
  terminal.println('');
  terminal.setColor(Color.DARK_GREY, Color.BLACK);
  terminal.println('  QuickJS ES2023  |  i686  |  Bare Metal');
  terminal.println('  Type help() to see all available functions');
  terminal.println('');
  terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
}

/** Main entry point - called by the bundled JS IIFE footer */
function main(): void {
  setupConsole();

  // Initialize OS subsystems synchronously (bare metal — no event loop)
  init.initialize();   // registers and starts services up to runlevel 3

  setupGlobals();
  printBanner();
  startRepl();
  // startRepl() loops forever; only returns on halt/reboot
  kernel.halt();
}

export { main };
export default main;
