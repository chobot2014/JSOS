/**
 * JSOS - JavaScript Operating System
 * Main entry point
 *
 * Boots directly into a JavaScript REPL. No traditional shell or
 * filesystem commands  everything is live JavaScript running on
 * bare metal via QuickJS ES2023.
 */

import terminal from '../ui/terminal.js';
import { Color } from './kernel.js';
import { startRepl } from '../ui/repl.js';
import fs from '../fs/filesystem.js';
import { openEditor } from '../ui/editor.js';
import { syscalls } from './syscalls.js';
import { scheduler } from '../process/scheduler.js';
import { vmm } from '../process/vmm.js';
import { init } from '../process/init.js';
import { procFS } from '../fs/proc.js';
import { users } from '../users/users.js';
import { ipc } from '../ipc/ipc.js';
import { net } from '../net/net.js';
import { fat16 } from '../storage/fat16.js';

declare var kernel: import('./kernel.js').KernelAPI; // kernel.js is in core/

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

  // Expose OS subsystems directly — user programs use these
  g.users = users;
  g.ipc   = ipc;
  g.net   = net;

  // ── Persistent disk (FAT16) ───────────────────────────────────────────
  g.disk = {
    ls: function(path?: string) {
      var p = path || '/';
      var items = fat16.list(p);
      return printableArray(items, function(arr) {
        terminal.colorPrintln('  [disk] ' + p, Color.DARK_GREY);
        if (arr.length === 0) { terminal.colorPrintln('  (empty)', Color.DARK_GREY); return; }
        for (var i = 0; i < arr.length; i++) {
          var item = arr[i];
          terminal.print('  ');
          if (item.type === 'directory') terminal.colorPrint(item.name + '/', Color.LIGHT_BLUE);
          else terminal.colorPrint(item.name, Color.WHITE);
          terminal.colorPrintln('  ' + (item.type === 'file' ? item.size + 'B' : ''), Color.DARK_GREY);
        }
      });
    },
    read:   function(path: string) { return fat16.read(path); },
    write:  function(path: string, content: string) { return fat16.writeFile(path, content); },
    mkdir:  function(path: string) { return fat16.mkdir(path); },
    rm:     function(path: string) { return fat16.remove(path); },
    exists: function(path: string) { return fat16.exists(path); },
    isDir:  function(path: string) { return fat16.isDirectory(path); },
    stat:   function(path: string) {
      var items = fat16.list(path.substring(0, path.lastIndexOf('/')) || '/');
      var name  = path.substring(path.lastIndexOf('/') + 1);
      for (var i = 0; i < items.length; i++) if (items[i].name.toUpperCase() === name.toUpperCase()) return items[i];
      return null;
    },
    stats: function() { return fat16.getStats(); },
    cp: function(src: string, dst: string) {
      var data = fat16.read(src);
      if (data === null) { terminal.println('cp: ' + src + ': not found'); return false; }
      return fat16.writeFile(dst, data);
    },
    format: function(label?: string) {
      var ok = fat16.format(label || 'JSDISK');
      terminal.println(ok ? '[disk] Formatted and mounted' : '[disk] Format failed');
      return ok;
    },
  };

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
    vmm:       vmm,
    init:      init,
    syscalls:  syscalls,
    net:       net,
    users:     users,
    ipc:       ipc,
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
      terminal.colorPrintln('  ' + lpad('PID', 4) + '  ' + lpad('PPID', 5) + '  ' + pad('NAME', 16) + '  ' + pad('STATE', 12) + 'PRI', Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 48).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        terminal.println('  ' + lpad('' + p.pid, 4) + '  ' + lpad('' + p.ppid, 5) + '  ' + pad(p.name, 16) + '  ' + pad(p.state, 12) + p.priority);
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

  // ── User & identity ───────────────────────────────────────────────────────
  g.whoami = function() {
    var u = users.getCurrentUser();
    terminal.println(u ? u.name : 'nobody');
  };

  g.id = function(name?: string) {
    var u = name ? users.getUser(name) : users.getCurrentUser();
    if (!u) { terminal.println('id: ' + name + ': no such user'); return; }
    terminal.println(users.idString(u));
  };

  g.who = function() {
    terminal.colorPrintln('NAME             TTY      TIME', Color.LIGHT_CYAN);
    var u = users.getCurrentUser();
    if (u) terminal.println(pad(u.name, 16) + ' console  ' + new Date().toUTCString());
  };

  g.su = function(nameOrUid: string | number) {
    if (!users.isRoot()) { terminal.colorPrintln('su: permission denied (not root)', Color.LIGHT_RED); return; }
    if (users.su(nameOrUid)) {
      var u = users.getCurrentUser();
      terminal.colorPrintln('switched to ' + (u ? u.name : '' + nameOrUid), Color.LIGHT_GREEN);
    } else {
      terminal.println('su: user not found');
    }
  };

  g.adduser = function(name: string, password: string) {
    if (!name) { terminal.println('usage: adduser(name, password)'); return; }
    var u = users.addUser(name, password || '');
    if (u) terminal.colorPrintln('created user ' + u.name + ' (uid=' + u.uid + ')', Color.LIGHT_GREEN);
    else terminal.println('adduser: user already exists');
  };

  g.passwd = function(name: string, newPw: string) {
    if (!name || !newPw) { terminal.println('usage: passwd(name, newPassword)'); return; }
    if (users.passwd(name, newPw)) terminal.colorPrintln('password changed', Color.LIGHT_GREEN);
    else terminal.println('passwd: user not found');
  };

  // ── Date / time ───────────────────────────────────────────────────────────
  g.date = function() {
    var ms = kernel.getUptime();
    var s  = Math.floor(ms / 1000);
    var m  = Math.floor(s / 60); s %= 60;
    var h  = Math.floor(m / 60); m %= 60;
    var info = { uptime: h + 'h ' + m + 'm ' + s + 's', ticks: kernel.getTicks() };
    return printableObject(info, function(obj: any) {
      terminal.println('  uptime : ' + obj.uptime);
      terminal.println('  ticks  : ' + obj.ticks);
    });
  };

  // ── Text search ───────────────────────────────────────────────────────────
  g.grep = function(pattern: string, path: string) {
    if (!pattern) { terminal.println('usage: grep(pattern, path)'); return; }
    var content = path ? fs.readFile(path) : null;
    if (!content) { terminal.colorPrintln('grep: no input', Color.DARK_GREY); return; }
    var re     = new RegExp(pattern);
    var lines  = content.split('\n');
    var matches: string[] = [];
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matches.push((path ? path + ':' : '') + (i + 1) + ': ' + lines[i]);
    }
    return printableArray(matches, function(arr: string[]) {
      if (arr.length === 0) { terminal.colorPrintln('  (no matches)', Color.DARK_GREY); return; }
      for (var j = 0; j < arr.length; j++) terminal.println('  ' + arr[j]);
      terminal.colorPrintln('  ' + arr.length + ' match(es)', Color.DARK_GREY);
    });
  };

  // Word / line / char count
  g.wc = function(path: string) {
    if (!path) { terminal.println('usage: wc(path)'); return; }
    var c = fs.readFile(path);
    if (c === null) { terminal.println('wc: ' + path + ': not found'); return; }
    var lines = c.split('\n').length - 1;
    var words = c.trim() ? c.trim().split(/\s+/).length : 0;
    var info  = { lines, words, chars: c.length, path };
    return printableObject(info, function(obj: any) {
      terminal.println('  ' + lpad('' + obj.lines, 6) + '  ' + lpad('' + obj.words, 6) + '  ' + lpad('' + obj.chars, 6) + '  ' + obj.path);
    });
  };

  // uname
  g.uname = function(opts?: string) {
    var o = opts || '-s';
    if (o === '-a') {
      terminal.println('JSOS 1.0.0 jsos 1.0.0 QuickJS-ES2023 i686 JSOS');
    } else {
      if (o.indexOf('s') !== -1) terminal.println('JSOS');
      if (o.indexOf('r') !== -1) terminal.println('1.0.0');
      if (o.indexOf('m') !== -1) terminal.println('i686');
      if (o.indexOf('n') !== -1) terminal.println(fs.readFile('/etc/hostname') || 'jsos');
    }
  };

  // Environment
  g.env = function() {
    var u = users.getCurrentUser();
    var pseudo: Record<string, string> = {
      HOME:         (u ? u.home : '/tmp'),
      USER:         (u ? u.name : 'nobody'),
      PATH:         '/bin:/usr/bin',
      TERM:         'vga',
      LANG:         'C',
      SHELL:        '/bin/repl',
      HOSTNAME:     (fs.readFile('/etc/hostname') || 'jsos'),
      RUNLEVEL:     '' + init.getCurrentRunlevel(),
      JSOS_VERSION: (fs.readFile('/etc/version') || '1.0.0'),
    };
    return printableObject(pseudo, function(obj: any) {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) terminal.println('  ' + pad(keys[i], 14) + '= ' + obj[keys[i]]);
    });
  };

  // which
  g.which = function(cmd: string) {
    if (!cmd) { terminal.println('usage: which(command)'); return; }
    var paths = ['/bin/' + cmd, '/bin/' + cmd + '.js', '/usr/bin/' + cmd, '/usr/bin/' + cmd + '.js'];
    for (var i = 0; i < paths.length; i++) {
      if (fs.exists(paths[i])) { terminal.colorPrintln(paths[i], Color.LIGHT_GREEN); return; }
    }
    // Also check if it is a defined global
    if ((globalThis as any)[cmd] !== undefined) {
      terminal.colorPrintln(cmd + ': built-in function', Color.LIGHT_CYAN); return;
    }
    terminal.println(cmd + ': not found');
  };

  // ── Networking ────────────────────────────────────────────────────────────
  g.ifconfig = function() { terminal.print(net.ifconfig()); };

  g.netstat = function() {
    var conns = net.getConnections();
    terminal.colorPrintln('  Proto  Local              Remote             State', Color.LIGHT_CYAN);
    terminal.colorPrintln('  -----  -----------------  -----------------  -----------', Color.DARK_GREY);
    if (conns.length === 0) { terminal.colorPrintln('  (no connections)', Color.DARK_GREY); return; }
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      terminal.println('  tcp    ' + pad(c.localIP + ':' + c.localPort, 17) + '  ' + pad(c.remoteIP + ':' + c.remotePort, 17) + '  ' + c.state);
    }
    var st = net.getStats();
    terminal.colorPrintln('  rx=' + st.rxPackets + ' tx=' + st.txPackets + ' errors=' + st.rxErrors, Color.DARK_GREY);
  };

  g.arp = function() {
    var table = net.getArpTable();
    terminal.colorPrintln('  IP               MAC', Color.LIGHT_CYAN);
    for (var i = 0; i < table.length; i++) {
      terminal.println('  ' + pad(table[i].ip, 16) + ' ' + table[i].mac);
    }
  };

  // ── Interactive top ───────────────────────────────────────────────────────
  g.top = function() {
    var running = true;
    while (running) {
      terminal.clear();
      var m  = kernel.getMemoryInfo();
      var ms = kernel.getUptime();
      var s = Math.floor(ms / 1000), mn = Math.floor(s / 60), hr = Math.floor(mn / 60);
      terminal.setColor(Color.WHITE, Color.BLACK);
      terminal.println(' JSOS top   uptime: ' + hr + 'h ' + (mn % 60) + 'm ' + (s % 60) + 's   [q = quit]');
      terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
      terminal.println(' mem: ' + Math.floor(m.used / 1024) + 'K / ' + Math.floor(m.total / 1024) + 'K   runlevel: ' + init.getCurrentRunlevel() + '   scheduler: ' + scheduler.getAlgorithm());
      terminal.println('');
      terminal.setColor(Color.LIGHT_CYAN, Color.BLACK);
      terminal.println('  ' + lpad('PID', 4) + '  ' + lpad('PPID', 5) + '  ' + pad('NAME', 16) + '  ' + pad('STATE', 12) + '  PRI  CPU-ms');
      terminal.setColor(Color.DARK_GREY, Color.BLACK);
      terminal.println('  ' + pad('', 60).replace(/ /g, '-'));
      terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
      var procs = scheduler.getAllProcesses();
      for (var i = 0; i < procs.length; i++) {
        var p = procs[i];
        terminal.println('  ' + lpad('' + p.pid, 4) + '  ' + lpad('' + p.ppid, 5) + '  ' + pad(p.name, 16) + '  ' + pad(p.state, 12) + '  ' + lpad('' + p.priority, 3) + '  ' + p.cpuTime);
      }
      terminal.println('');
      terminal.setColor(Color.DARK_GREY, Color.BLACK);
      terminal.println('  ' + procs.length + ' process(es)');
      terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
      kernel.sleep(500);
      if (kernel.hasKey()) {
        var k = kernel.readKey();
        if (k === 'q' || k === 'Q' || k === '\x03') running = false;
      }
    }
    terminal.clear();
  };

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

    terminal.colorPrintln('Filesystem:', Color.YELLOW);
    terminal.println('  ls(path?)            list directory');
    terminal.println('  cd(path?)            change directory  (~ = /home/user)');
    terminal.println('  pwd()                print working directory');
    terminal.println('  cat(path)            print file contents');
    terminal.println('  mkdir(path)          create directory');
    terminal.println('  touch(path)          create empty file');
    terminal.println('  rm(path)             remove file or empty dir');
    terminal.println('  cp(src, dst)         copy file');
    terminal.println('  mv(src, dst)         move / rename');
    terminal.println('  write(path, text)    write file');
    terminal.println('  append(path, text)   append to file');
    terminal.println('  find(path?, pat)     find files  (* wildcard)');
    terminal.println('  stat(path)           file metadata');
    terminal.println('  run(path)            execute a .js file');
    terminal.println('  grep(pat, path)      search file for regex pattern');
    terminal.println('  wc(path)             line / word / char count');
    terminal.println('  which(cmd)           find command location');
    terminal.println('');

    terminal.colorPrintln('Processes & system:', Color.YELLOW);
    terminal.println('  ps()                 process list  (PID PPID NAME STATE PRI)');
    terminal.println('  top()                interactive process monitor  (q = quit)');
    terminal.println('  kill(pid)            terminate a process');
    terminal.println('  mem()                memory usage + bar');
    terminal.println('  uptime()             system uptime');
    terminal.println('  sysinfo()            full system summary');
    terminal.println('  uname(opts?)         OS info  (-s -r -m -n -a)');
    terminal.println('  date()               uptime-based timestamp');
    terminal.println('  hostname(name?)      show / set hostname');
    terminal.println('  colors()             VGA color palette demo');
    terminal.println('  sleep(ms)            sleep N milliseconds');
    terminal.println('  clear()              clear the screen');
    terminal.println('  halt()               power off');
    terminal.println('  reboot()             reboot');
    terminal.println('  edit(path?)          fullscreen text editor  (^S save  ^Q quit)');
    terminal.println('');

    terminal.colorPrintln('Users:', Color.YELLOW);
    terminal.println('  whoami()             current username');
    terminal.println('  id(name?)            uid/gid identity string');
    terminal.println('  who()                logged-in users');
    terminal.println('  su(name)             switch user  (root only)');
    terminal.println('  adduser(name, pw)    create user account');
    terminal.println('  passwd(name, pw)     change password');
    terminal.println('');

    terminal.colorPrintln('Disk (FAT16 persistent storage):', Color.YELLOW);
    terminal.println('  disk.format(label?)  format a blank attached disk');
    terminal.println('  disk.ls(path?)       list directory on disk');
    terminal.println('  disk.read(path)      read file from disk');
    terminal.println('  disk.write(path, s)  write/create file on disk');
    terminal.println('  disk.mkdir(path)     create directory on disk');
    terminal.println('  disk.rm(path)        delete file or empty dir');
    terminal.println('  disk.cp(src, dst)    copy file on disk');
    terminal.println('  disk.exists(path)    check if path exists');
    terminal.println('  disk.stats()         free/used cluster info');
    terminal.println('');

    terminal.colorPrintln('Networking:', Color.YELLOW);
    terminal.println('  ifconfig()           interface configuration');
    terminal.println('  netstat()            active TCP connections');
    terminal.println('  arp()                ARP table');
    terminal.println('  net.ping(ip, ms?)    ICMP echo');
    terminal.println('  net.configure(opts)  set ip/mac/gw/dns');
    terminal.println('  net.createSocket(type)  UDP or TCP socket');
    terminal.println('');

    terminal.colorPrintln('REPL:', Color.YELLOW);
    terminal.println('  history()            show input history');
    terminal.println('  env()                pseudo-environment variables');
    terminal.println('  echo(...)            print arguments');
    terminal.println('  print(s)             print a value');
    terminal.println('  printable(data, fn)  wrap data with a custom pretty-printer');
    terminal.println('');

    terminal.colorPrintln('Scripting APIs:', Color.YELLOW);
    terminal.colorPrint('  fs', Color.LIGHT_CYAN);
    terminal.println('       .ls .read .write .append .mkdir .rm .cp .mv .stat .find');
    terminal.colorPrint('  sys', Color.LIGHT_CYAN);
    terminal.println('      .mem .ps .kill .uptime .sysinfo .spawn .hostname');
    terminal.colorPrint('  net', Color.LIGHT_CYAN);
    terminal.println('      .createSocket .bind .listen .connect .send .recv .close .ping');
    terminal.colorPrint('  users', Color.LIGHT_CYAN);
    terminal.println('    .getCurrentUser .getUser .addUser .removeUser .su .passwd .listUsers');
    terminal.colorPrint('  ipc', Color.LIGHT_CYAN);
    terminal.println('      .pipe() .signal.send(pid,sig) .mq.send(pid,msg)');
    terminal.colorPrint('  scheduler', Color.LIGHT_CYAN);
    terminal.println(' .getAllProcesses .spawn .terminate .getAlgorithm');
    terminal.colorPrint('  vmm', Color.LIGHT_CYAN);
    terminal.println('      .allocate .free .getStats .protect .mmap');
    terminal.colorPrint('  init', Color.LIGHT_CYAN);
    terminal.println('     .getServices .startService .stopService .getCurrentRunlevel');
    terminal.println('');

    terminal.colorPrintln('Keyboard:', Color.YELLOW);
    terminal.println('  Up / Down    browse history');
    terminal.println('  Tab          tab-complete (globals and object properties)');
    terminal.println('  Ctrl+U       erase line');
    terminal.println('  Ctrl+C       cancel line');
    terminal.println('  Ctrl+L       redraw screen');
    terminal.println('  open { ( [   enter multiline mode; blank line to run');
    terminal.println('');

    terminal.colorPrintln('Examples:', Color.YELLOW);
    terminal.colorPrintln("  ls('/bin').map(f => f.name)", Color.WHITE);
    terminal.colorPrintln("  ps().find(p => p.name === 'repl')", Color.WHITE);
    terminal.colorPrintln("  cat('/proc/meminfo')", Color.WHITE);
    terminal.colorPrintln("  cat('/proc/cpuinfo')", Color.WHITE);
    terminal.colorPrintln("  grep('root', '/etc/passwd')", Color.WHITE);
    terminal.colorPrintln("  mem().free", Color.WHITE);
    terminal.colorPrintln("  net.configure({ip:'10.0.2.15', gw:'10.0.2.2'})", Color.WHITE);
    terminal.colorPrintln("  write('/tmp/hi.js', 'print(42)'); run('/tmp/hi.js')", Color.WHITE);
    terminal.colorPrintln("  JSON.stringify(sys.sysinfo(), null, 2)", Color.WHITE);
    terminal.colorPrintln("  top()", Color.WHITE);
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

  // Mount virtual filesystems before any code reads them
  fs.mountVFS('/proc', procFS);

  // Mount persistent FAT16 disk (non-fatal if not present)
  if (fat16.mount()) {
    kernel.serialPut('[disk] FAT16 mounted\n');
  } else if (kernel.ataPresent()) {
    kernel.serialPut('[disk] Disk present but not FAT16 - run disk.format() to initialize\n');
  } else {
    kernel.serialPut('[disk] No disk attached\n');
  }

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
