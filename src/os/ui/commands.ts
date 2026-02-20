/**
 * JSOS REPL Commands
 *
 * All shell-like globals available at the REPL prompt.
 * Organised into categories that match help() output.
 *
 * Two APIs for everything:
 *   Convenience functions  (ls, ps, mem …)
 *     — auto-pretty-print as a REPL top-level expression
 *     — return a real Array / plain object so scripting still works:
 *         ls('/bin').filter(f => f.name.endsWith('.js'))   → plain Array
 *         mem().free                                        → number
 *
 *   Raw-data APIs  (fs.*, sys.*, net.*, disk.*, users.*, ipc.*)
 *     — always return plain values, never print anything
 */

import terminal from './terminal.js';
import { Color } from '../core/kernel.js';
import fs from '../fs/filesystem.js';
import { openEditor } from './editor.js';
import { scheduler } from '../process/scheduler.js';
import { vmm } from '../process/vmm.js';
import { init } from '../process/init.js';
import { procFS } from '../fs/proc.js';
import { users } from '../users/users.js';
import { ipc } from '../ipc/ipc.js';
import { net } from '../net/net.js';
import { fat16 } from '../storage/fat16.js';
import { fat32 } from '../storage/fat32.js';
import { globalFDTable } from '../core/fdtable.js';
import { syscalls } from '../core/syscalls.js';
import { processManager } from '../process/process.js';
import { threadManager } from '../process/threads.js';
import { physAlloc } from '../process/physalloc.js';
import { JSProcess, listProcesses } from '../process/jsprocess.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Printable result helpers ──────────────────────────────────────────────────
// A printableArray / printableObject carries a hidden __jsos_print__ method.
// The REPL's evalAndPrint calls it when the value is a top-level expression
// result, giving pretty output.  Chaining (map, filter, spread, …) returns
// a plain value without the sentinel so JSON output is used instead.

export function printableArray<T>(items: T[], printer: (arr: T[]) => void): T[] {
  var arr: any = items.slice();
  Object.defineProperty(arr, '__jsos_print__', {
    value: function() { printer(arr); }, enumerable: false, configurable: true,
  });
  return arr as T[];
}

export function printableObject<T extends object>(data: T, printer: (obj: T) => void): T {
  var obj: any = Object.assign({}, data);
  Object.defineProperty(obj, '__jsos_print__', {
    value: function() { printer(obj); }, enumerable: false, configurable: true,
  });
  return obj as T;
}

// ── Formatting helpers (private) ──────────────────────────────────────────────

function pad(s: string, w: number): string { while (s.length < w) s += ' '; return s; }
function lpad(s: string, w: number): string { while (s.length < w) s = ' ' + s; return s; }

// ── Register all REPL commands onto globalThis ────────────────────────────────

export function registerCommands(g: any): void {

  // ──────────────────────────────────────────────────────────────────────────
  // 1.  RAW SCRIPTING APIs  (return plain data, never print)
  // ──────────────────────────────────────────────────────────────────────────

  // terminal — direct access for user scripts
  g.terminal = terminal;

  // OS subsystems
  g.users = users;
  g.ipc   = ipc;
  g.net   = net;

  // Persistent disk (FAT32 / FAT16)
  g.disk = {
    ls(path?: string) {
      var p = path || '/';
      var items = (g._diskFS as any) ? (g._diskFS as any).list(p) : [];
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
    read(path: string)                { return (g._diskFS as any) ? (g._diskFS as any).read(path) : null; },
    write(path: string, c: string)    { return (g._diskFS as any) ? (g._diskFS as any).writeFile(path, c) : false; },
    mkdir(path: string)               { return (g._diskFS as any) ? (g._diskFS as any).mkdir(path) : false; },
    rm(path: string)                  { return (g._diskFS as any) ? (g._diskFS as any).remove(path) : false; },
    exists(path: string)              { return (g._diskFS as any) ? (g._diskFS as any).exists(path) : false; },
    isDir(path: string)               { return (g._diskFS as any) ? (g._diskFS as any).isDirectory(path) : false; },
    stat(path: string) {
      if (!(g._diskFS as any)) return null;
      var dir   = path.substring(0, path.lastIndexOf('/')) || '/';
      var name  = path.substring(path.lastIndexOf('/') + 1);
      var items = (g._diskFS as any).list(dir);
      for (var i = 0; i < items.length; i++)
        if (items[i].name.toUpperCase() === name.toUpperCase()) return items[i];
      return null;
    },
    stats() { return (g._diskFS as any) ? (g._diskFS as any).getStats() : null; },
    cp(src: string, dst: string) {
      if (!(g._diskFS as any)) return false;
      var data = (g._diskFS as any).read(src);
      if (data === null) { terminal.println('disk.cp: ' + src + ': not found'); return false; }
      return (g._diskFS as any).writeFile(dst, data);
    },
    format(label?: string) {
      var ok = (g._diskFS as any) ? (g._diskFS as any).format(label || 'JSDISK') : false;
      terminal.println(ok ? '[disk] Formatted and mounted' : '[disk] Format failed');
      return ok;
    },
  };

  // Low-level filesystem API
  g.fs = {
    ls(p?: string)                    { return fs.ls(p || ''); },
    read(p: string)                   { return fs.readFile(p); },
    write(p: string, c: string)       { return fs.writeFile(p, c); },
    append(p: string, c: string)      { return fs.appendFile(p, c); },
    mkdir(p: string)                  { return fs.mkdir(p); },
    touch(p: string)                  { if (!fs.exists(p)) fs.writeFile(p, ''); return true; },
    rm(p: string)                     { return fs.rm(p); },
    cp(s: string, d: string)          { return fs.cp(s, d); },
    mv(s: string, d: string)          { return fs.mv(s, d); },
    stat(p: string)                   { return fs.stat(p); },
    exists(p: string)                 { return fs.exists(p); },
    isDir(p: string)                  { return fs.isDirectory(p); },
    isFile(p: string)                 { return fs.isFile(p); },
    pwd()                             { return fs.cwd(); },
    cd(p: string)                     { return fs.cd(p); },
    find(path: string, pat: string)   { return fs.find(path, pat); },
    run(p: string) {
      var code = fs.readFile(p) || fs.readFile('/bin/' + p);
      if (!code) { terminal.println('Not found: ' + p); return; }
      return kernel.eval(code);
    },
  };

  // System API
  g.sys = {
    mem()       { return kernel.getMemoryInfo(); },
    uptime()    { return kernel.getUptime(); },
    ticks()     { return kernel.getTicks(); },
    screen()    { return kernel.getScreenSize(); },
    ps()        { return scheduler.getAllProcesses(); },
    spawn(name: string) {
      return scheduler.createProcess(0, { priority: 10, timeSlice: 10,
        memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 } });
    },
    kill(pid: number)   { return scheduler.terminateProcess(pid); },
    sleep(ms: number)   { kernel.sleep(ms); },
    reboot()            { kernel.reboot(); },
    halt()              { kernel.halt(); },
    hostname(n?: string) {
      if (n !== undefined) { fs.writeFile('/etc/hostname', n); return n; }
      return fs.readFile('/etc/hostname') || 'jsos';
    },
    version()   { return fs.readFile('/etc/version') || '1.0.0'; },
    sysinfo() {
      var m = kernel.getMemoryInfo();
      var vm = vmm.getMemoryStats();
      return {
        os:           'JSOS v' + (fs.readFile('/etc/version') || '1.0.0'),
        hostname:     fs.readFile('/etc/hostname') || 'jsos',
        arch:         'i686',
        runtime:      'QuickJS ES2023',
        screen:       kernel.getScreenSize(),
        memory:       m,
        virtualMemory: vm,
        uptime:       kernel.getUptime(),
        processes:    scheduler.getAllProcesses().length,
        scheduler:    scheduler.getAlgorithm(),
        runlevel:     init.getCurrentRunlevel(),
      };
    },
    // OS subsystem references
    scheduler, vmm, init, syscalls, net, users, ipc,
    processManager, physAlloc, threadManager,
    // POSIX FD API
    getpid()            { return processManager.getpid(); },
    getppid()           { return processManager.getppid(); },
    open(path: string, flags?: number) { return syscalls.open(path, flags || 0); },
    read(fd: number, count?: number) {
      var bytes = globalFDTable.read(fd, count !== undefined ? count : 4096);
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    },
    readBytes(fd: number, count?: number) {
      return globalFDTable.read(fd, count !== undefined ? count : 4096);
    },
    write(fd: number, data: string | number[]) {
      var bytes: number[] = typeof data === 'string'
        ? (data as string).split('').map((c: string) => c.charCodeAt(0))
        : (data as number[]);
      return globalFDTable.write(fd, bytes);
    },
    close(fd: number)   { globalFDTable.close(fd); },
    pipe()              { var p = globalFDTable.pipe(); return { read: p[0], write: p[1] }; },
    dup(fd: number)     { return globalFDTable.dup(fd); },
    fdtable:            globalFDTable,
    socket(type?: string) {
      return globalFDTable.openSocket(net, (type === 'udp' ? 'udp' : 'tcp') as 'tcp' | 'udp');
    },
    getSocketId(fd: number)          { return globalFDTable.getSocketId(fd); },
    connect(fd: number, ip: string, port: number) {
      var sid = globalFDTable.getSocketId(fd);
      return sid >= 0 ? net.connect(sid, ip, port) : false;
    },
    send(fd: number, data: string) {
      var sid = globalFDTable.getSocketId(fd);
      if (sid >= 0) net.send(sid, data);
    },
    recv(fd: number) {
      var sid = globalFDTable.getSocketId(fd);
      return sid >= 0 ? (net.recv(sid) || '') : '';
    },
    ioctl(fd: number, request: number, arg: number) {
      return globalFDTable.ioctl(fd, request, arg);
    },
    exec(path: string, args?: string[]) { return syscalls.exec(path, args || []); },
  };

  // Print shorthand
  g.print = function(s: any) { terminal.println(String(s)); };

  // ──────────────────────────────────────────────────────────────────────────
  // 2.  FILESYSTEM COMMANDS  (pretty-print AND return chainable values)
  // ──────────────────────────────────────────────────────────────────────────

  g.ls = function(path?: string) {
    var target = path || fs.cwd();
    if (path && !fs.exists(path)) { terminal.println('ls: ' + path + ': no such directory'); return printableArray([], () => {}); }
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
    if (fs.cp(src, dst)) terminal.colorPrintln('copied: ' + src + ' → ' + dst, Color.LIGHT_GREEN);
    else terminal.println('cp: ' + src + ': failed');
  };

  g.mv = function(src: string, dst: string) {
    if (!src || !dst) { terminal.println('usage: mv(src, dst)'); return; }
    if (fs.mv(src, dst)) terminal.colorPrintln('moved: ' + src + ' → ' + dst, Color.LIGHT_GREEN);
    else terminal.println('mv: ' + src + ': failed');
  };

  g.write = function(path: string, content: string) {
    if (!path) { terminal.println('usage: write(path, content)'); return; }
    if (fs.writeFile(path, content || ''))
      terminal.colorPrintln('wrote ' + (content || '').length + 'B → ' + path, Color.LIGHT_GREEN);
    else terminal.println('write: ' + path + ': failed');
  };

  g.append = function(path: string, content: string) {
    if (!path) { terminal.println('usage: append(path, content)'); return; }
    if (fs.appendFile(path, content || ''))
      terminal.colorPrintln('appended ' + (content || '').length + 'B → ' + path, Color.LIGHT_GREEN);
    else terminal.println('append: ' + path + ': failed');
  };

  g.find = function(pathOrPat: string, pattern?: string) {
    var base = pattern ? pathOrPat : '/';
    var pat  = pattern || pathOrPat || '*';
    var results = fs.find(base, pat);
    return printableArray(results, function(arr: string[]) {
      for (var i = 0; i < arr.length; i++) terminal.println('  ' + arr[i]);
      terminal.colorPrintln('  ' + arr.length + ' match(es)', Color.DARK_GREY);
    });
  };

  g.stat = function(path: string) {
    if (!path) { terminal.println('usage: stat(path)'); return; }
    var info = fs.stat(path);
    if (!info) { terminal.println('stat: ' + path + ': no such path'); return; }
    var data = Object.assign({ path }, info);
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

  g.which = function(cmd: string) {
    if (!cmd) { terminal.println('usage: which(command)'); return; }
    var paths = ['/bin/' + cmd, '/bin/' + cmd + '.js', '/usr/bin/' + cmd, '/usr/bin/' + cmd + '.js'];
    for (var i = 0; i < paths.length; i++) {
      if (fs.exists(paths[i])) { terminal.colorPrintln(paths[i], Color.LIGHT_GREEN); return; }
    }
    if ((globalThis as any)[cmd] !== undefined) {
      terminal.colorPrintln(cmd + ': built-in function', Color.LIGHT_CYAN); return;
    }
    terminal.println(cmd + ': not found');
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 3.  SYSTEM / PROCESS COMMANDS
  // ──────────────────────────────────────────────────────────────────────────

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

  g.env = function() {
    var u = users.getCurrentUser();
    var pseudo: Record<string, string> = {
      HOME:         u ? u.home : '/tmp',
      USER:         u ? u.name : 'nobody',
      PATH:         '/bin:/usr/bin',
      TERM:         'vga',
      LANG:         'C',
      SHELL:        '/bin/repl',
      HOSTNAME:     fs.readFile('/etc/hostname') || 'jsos',
      RUNLEVEL:     '' + init.getCurrentRunlevel(),
      JSOS_VERSION: fs.readFile('/etc/version') || '1.0.0',
    };
    return printableObject(pseudo, function(obj: any) {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) terminal.println('  ' + pad(keys[i], 14) + '= ' + obj[keys[i]]);
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 4.  TERMINAL / DISPLAY COMMANDS
  // ──────────────────────────────────────────────────────────────────────────

  g.colors = function() {
    var names = ['BLACK','BLUE','GREEN','CYAN','RED','MAGENTA','BROWN','LT_GREY',
                 'DK_GREY','LT_BLUE','LT_GREEN','LT_CYAN','LT_RED','LT_MAG','YELLOW','WHITE'];
    terminal.colorPrintln('VGA Palette (0-15)', Color.WHITE);
    for (var i = 0; i < 16; i++) {
      terminal.setColor(i, 0);
      terminal.print('  ' + lpad('' + i, 2) + ' ########  ');
      terminal.setColor(Color.LIGHT_GREY, Color.BLACK);  // reset before name
      terminal.colorPrintln(names[i], Color.DARK_GREY);
    }
    terminal.setColor(Color.LIGHT_GREY, Color.BLACK);  // always restore after loop
  };

  g.clear  = function() { terminal.clear(); };
  g.sleep  = function(ms: number) { kernel.sleep(ms); };
  g.halt   = function() { kernel.halt(); };
  g.reboot = function() { kernel.reboot(); };

  /** shutdown — friendly alias for halt() */
  g.shutdown = function() {
    terminal.println('Shutting down...');
    kernel.sleep(300);
    kernel.halt();
  };

  /** motd — display the message of the day (/etc/motd) */
  g.motd = function() {
    var m = fs.readFile('/etc/motd');
    if (m) terminal.print(m);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 5.  USER / IDENTITY COMMANDS
  // ──────────────────────────────────────────────────────────────────────────

  g.hostname = function(name?: string) {
    if (name) { fs.writeFile('/etc/hostname', name); terminal.colorPrintln('hostname → ' + name, Color.LIGHT_GREEN); }
    else terminal.println(fs.readFile('/etc/hostname') || 'jsos');
  };

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

  // ──────────────────────────────────────────────────────────────────────────
  // 6.  NETWORKING COMMANDS
  // ──────────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────────
  // 7.  LOW-LEVEL / POWER-USER COMMANDS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Execute raw x86 machine code from a hex string.
   * Usage:  __asm("B8 2A 00 00 00 C3")  // mov eax, 42; ret  → returns 42
   * Also available as a tagged template: __asm`B8 2A 00 00 00 C3`
   */
  g.__asm = function(hexOrStrings: TemplateStringsArray | string, ...vals: any[]): number {
    var hex: string;
    if (typeof hexOrStrings === 'string') {
      hex = hexOrStrings;
    } else {
      hex = '';
      for (var _i = 0; _i < hexOrStrings.length; _i++) {
        hex += hexOrStrings[_i];
        if (_i < vals.length) hex += String(vals[_i]);
      }
    }
    return kernel.volatileAsm(hex);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 10.  MULTI-PROCESS
  // ──────────────────────────────────────────────────────────────────────────

  // Make JSProcess available as a global constructor for scripts
  g.JSProcess = JSProcess;

  /**
   * Spawn a new isolated QuickJS runtime and run `code` inside it.
   * Returns a JSProcess handle for IPC and lifecycle management.
   *
   * Child runtime API (available as `kernel` inside spawned code):
   *   kernel.postMessage(JSON.stringify(data))  → sends to parent
   *   kernel.pollMessage()                      → receives from parent (null if empty)
   *   kernel.serialPut(s)   kernel.getTicks()   kernel.sleep(ms)
   *
   * Example:
   *   var p = spawn('kernel.postMessage(JSON.stringify({hi:42}))');
   *   p.recv()          // → {hi: 42}
   *   p.send({x: 1});   p.eval('kernel.pollMessage()')   // → '{"x":1}'
   *   p.terminate()
   */
  g.spawn = function(code: string, name?: string) {
    var p = JSProcess.spawn(code, name);
    // Add a REPL pretty-printer so `spawn(...)` shows nicely at the prompt
    Object.defineProperty(p, '__jsos_print__', {
      value: function() {
        terminal.colorPrint('JSProcess ', Color.LIGHT_CYAN);
        terminal.colorPrint('#' + p.id + ' ', Color.YELLOW);
        terminal.colorPrint('(' + p.name + ')', Color.DARK_GREY);
        terminal.colorPrintln(' spawned ✓', Color.LIGHT_GREEN);
        terminal.colorPrintln('  .eval(code)   .send(msg)   .recv()   .tick()   .terminate()', Color.DARK_GREY);
      },
      enumerable: false, configurable: true,
    });
    return p;
  };

  /** List all live child processes. */
  g.procs = function() {
    var list = listProcesses();
    return printableArray(list, function(arr) {
      if (arr.length === 0) {
        terminal.colorPrintln('  (no child processes running)', Color.DARK_GREY);
        return;
      }
      terminal.colorPrintln('  ' + pad('ID', 4) + pad('NAME', 12) + pad('INBOX', 8) + 'OUTBOX', Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 36).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var slot = arr[i];
        terminal.println('  ' + pad('' + slot.id, 4) + pad('proc' + slot.id, 12) +
                         pad('' + slot.inboxCount, 8) + slot.outboxCount);
      }
      terminal.colorPrintln('  ' + arr.length + ' process(es)', Color.DARK_GREY);
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 8.  REPL UTILITIES
  // ──────────────────────────────────────────────────────────────────────────

  g.echo = function() {
    var parts: string[] = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    terminal.println(parts.join(' '));
  };

  /** Wrap any value with a custom pretty-printer for the REPL */
  g.printable = function(data: any, printer: (d: any) => void): any {
    if (Array.isArray(data)) return printableArray(data, printer);
    return printableObject(data, printer);
  };

  // Text editor
  g.edit = function(path?: string) { openEditor(path); };

  // ──────────────────────────────────────────────────────────────────────────
  // 9.  HELP
  // ──────────────────────────────────────────────────────────────────────────

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
    terminal.println('  motd()               message of the day  (/etc/motd)');
    terminal.println('  sleep(ms)            sleep N milliseconds');
    terminal.println('  clear()              clear the screen');
    terminal.println('  halt()               power off');
    terminal.println('  shutdown()           power off (graceful)');
    terminal.println('  reboot()             reboot');
    terminal.println('  edit(path?)          fullscreen text editor  (^S save  ^Q quit)');
    terminal.println('');

    terminal.colorPrintln('Multi-process:', Color.YELLOW);
    terminal.println('  spawn(code, name?)   spawn isolated JS runtime → JSProcess');
    terminal.println('  procs()              list live child processes');
    terminal.println('  p.eval(code)         run code in child process');
    terminal.println('  p.send(msg)          send JSON value to child inbox');
    terminal.println('  p.recv()             receive JSON value from child outbox');
    terminal.println('  p.tick()             pump child async/Promise job queue');
    terminal.println('  p.recvAll()          drain all pending messages → array');
    terminal.println('  p.stats()            queue depths + alive status');
    terminal.println('  p.terminate()        kill process, free runtime');
    terminal.println('  JSProcess.spawn(c)   same as spawn() — class form');
    terminal.println('');
    terminal.colorPrintln('  Child kernel API (inside spawned code):', Color.DARK_GREY);
    terminal.println('    kernel.postMessage(s)   push string to parent outbox');
    terminal.println('    kernel.pollMessage()    pop string from parent inbox (null=empty)');
    terminal.println('    kernel.serialPut(s)     serial debug output');
    terminal.println('    kernel.sleep(ms)        sleep');
    terminal.println('    kernel.getTicks()       timer ticks');
    terminal.println('');

    terminal.colorPrintln('Users:', Color.YELLOW);
    terminal.println('  whoami()             current username');
    terminal.println('  id(name?)            uid/gid identity string');
    terminal.println('  who()                logged-in users');
    terminal.println('  su(name)             switch user  (root only)');
    terminal.println('  adduser(name, pw)    create user account');
    terminal.println('  passwd(name, pw)     change password');
    terminal.println('');

    terminal.colorPrintln('Disk (FAT32/FAT16 persistent storage):', Color.YELLOW);
    terminal.println('  disk.ls(path?)       list directory on disk');
    terminal.println('  disk.read(path)      read file from disk');
    terminal.println('  disk.write(path, s)  write/create file on disk');
    terminal.println('  disk.mkdir(path)     create directory on disk');
    terminal.println('  disk.rm(path)        delete file or empty dir');
    terminal.println('  disk.cp(src, dst)    copy file on disk');
    terminal.println('  disk.exists(path)    check if path exists');
    terminal.println('  disk.stats()         free/used cluster info');
    terminal.println('  disk.format(label?)  format a blank attached disk');
    terminal.println('');

    terminal.colorPrintln('Networking:', Color.YELLOW);
    terminal.println('  ifconfig()           interface configuration');
    terminal.println('  netstat()            active TCP connections');
    terminal.println('  arp()                ARP table');
    terminal.println('  net.ping(ip, ms?)    ICMP echo');
    terminal.println('  net.configure(opts)  set ip/mac/gw/dns');
    terminal.println('  net.createSocket(t)  UDP or TCP socket');
    terminal.println('');

    terminal.colorPrintln('REPL:', Color.YELLOW);
    terminal.println('  history()            show input history');
    terminal.println('  env()                pseudo-environment variables');
    terminal.println('  echo(...)            print arguments');
    terminal.println('  print(s)             print a value');
    terminal.println('  printable(d, fn)     wrap data with a custom pretty-printer');
    terminal.println('');

    terminal.colorPrintln('Scripting APIs (raw data, never print):', Color.YELLOW);
    terminal.colorPrint('  fs', Color.LIGHT_CYAN);
    terminal.println('       .ls .read .write .append .mkdir .rm .cp .mv .stat .find');
    terminal.colorPrint('  sys', Color.LIGHT_CYAN);
    terminal.println('      .mem .ps .kill .uptime .sysinfo .spawn .hostname');
    terminal.colorPrint('  net', Color.LIGHT_CYAN);
    terminal.println('      .createSocket .bind .connect .send .recv .close .ping');
    terminal.colorPrint('  users', Color.LIGHT_CYAN);
    terminal.println('    .getCurrentUser .getUser .addUser .removeUser .su .passwd');
    terminal.colorPrint('  ipc', Color.LIGHT_CYAN);
    terminal.println('      .pipe() .signal.send(pid,sig) .mq.send(pid,msg)');
    terminal.colorPrint('  scheduler', Color.LIGHT_CYAN);
    terminal.println(' .getAllProcesses .spawn .terminate .getAlgorithm');
    terminal.colorPrint('  vmm', Color.LIGHT_CYAN);
    terminal.println('      .allocate .free .getStats .protect .mmap');
    terminal.colorPrint('  disk', Color.LIGHT_CYAN);
    terminal.println('      .ls .read .write .mkdir .rm .cp .exists .stats .format');
    terminal.println('');

    terminal.colorPrintln('Keyboard shortcuts:', Color.YELLOW);
    terminal.println('  Up / Down    browse history');
    terminal.println('  Tab          tab-complete globals and object.property');
    terminal.println('  Ctrl+U       erase line');
    terminal.println('  Ctrl+C       cancel line');
    terminal.println('  Ctrl+L       redraw screen');
    terminal.println('  open { ( [   enter multiline mode; blank line to run');
    terminal.println('  PgUp/PgDn    scroll through scrollback buffer');
    terminal.println('');

    terminal.colorPrintln('Examples:', Color.YELLOW);
    terminal.colorPrintln("  ls('/bin').map(f => f.name)", Color.WHITE);
    terminal.colorPrintln("  ps().find(p => p.name === 'repl')", Color.WHITE);
    terminal.colorPrintln("  cat('/proc/meminfo')", Color.WHITE);
    terminal.colorPrintln("  grep('root', '/etc/passwd')", Color.WHITE);
    terminal.colorPrintln("  mem().free", Color.WHITE);
    terminal.colorPrintln("  net.configure({ip:'10.0.2.15', gw:'10.0.2.2'})", Color.WHITE);
    terminal.colorPrintln("  write('/tmp/hi.js', 'print(42)'); run('/tmp/hi.js')", Color.WHITE);
    terminal.colorPrintln("  JSON.stringify(sys.sysinfo(), null, 2)", Color.WHITE);
    terminal.colorPrintln("  top()", Color.WHITE);
    terminal.println('');
  };
}
