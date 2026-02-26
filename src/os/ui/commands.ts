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
import { EditorApp } from '../apps/editor/index.js';
import { fileManagerApp } from '../apps/file-manager/index.js';
import { systemMonitorApp } from '../apps/system-monitor/index.js';
import { settingsApp } from '../apps/settings/index.js';
import { wm, getWM, type App } from '../ui/wm.js';
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
import { os } from '../core/sdk.js';
import { systemProfiler } from '../process/optimizer.js';
import { JITChecksum, JITMem, JITCRC32, JITOSKernels } from '../process/jit-os.js';
import { dnsResolve } from '../net/dns.js';

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
          var item = arr[i] as any;
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
    ps()        { return scheduler.getLiveProcesses(); },
    spawn(name: string) {
      return scheduler.createProcess(0, { name, priority: 10, timeSlice: 10,
        memory: { heapStart: 0, heapEnd: 0, stackStart: 0, stackEnd: 0 } });
    },
    kill(pid: number, sig?: number) { return processManager.kill(pid, sig !== undefined ? sig : 15); },
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
        processes:    scheduler.getLiveProcesses().length,
        scheduler:    scheduler.getAlgorithm(),
        runlevel:     init.getCurrentRunlevel(),
      };
    },
    // OS subsystem references
    scheduler, vmm, init, syscalls, net, users, ipc,
    processManager, physAlloc, threadManager,
    // Always-on optimizer / profiler
    profiler: systemProfiler,
    // OS JIT kernels (checksum, memcpy, CRC-32)
    JITChecksum, JITMem, JITCRC32, JITOSKernels,
    // POSIX FD API
    getpid()            { return scheduler.getpid(); },
    getppid()           { return scheduler.getCurrentProcess()?.ppid ?? 0; },
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
      return sid >= 0 ? net.connect(sid as any, ip, port) : false;
    },
    send(fd: number, data: string) {
      var sid = globalFDTable.getSocketId(fd);
      if (sid >= 0) net.send(sid as any, data);
    },
    recv(fd: number) {
      var sid = globalFDTable.getSocketId(fd);
      return sid >= 0 ? (net.recv(sid as any) || '') : '';
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
    var results: any[] = [];
    // Kernel POSIX-facade processes (idle, kernel, init)
    var sprocs = scheduler.getLiveProcesses();
    for (var _i = 0; _i < sprocs.length; _i++) {
      var sp = sprocs[_i];
      results.push({ pid: sp.pid, ppid: sp.ppid, name: sp.name, state: sp.state, priority: sp.priority, type: 'sched', cpuTime: sp.cpuTime });
    }
    // Cooperative kernel threads (ThreadManager)
    var kthreads = threadManager.getThreads();
    for (var _j = 0; _j < kthreads.length; _j++) {
      var kt = kthreads[_j];
      results.push({ pid: kt.tid, ppid: 0, name: '[' + kt.name + ']', state: kt.state, priority: kt.priority, type: 'thread', cpuTime: 0 });
    }
    // Active JSProcess child QuickJS runtimes
    var jsprocs = listProcesses();
    for (var _k = 0; _k < jsprocs.length; _k++) {
      var jp = jsprocs[_k];
      results.push({ pid: jp.id, ppid: 1, name: 'js#' + jp.id, state: 'running', priority: 20, type: 'js', cpuTime: 0 });
    }
    return printableArray(results, function(arr: any[]) {
      terminal.colorPrintln('  TYPE    ' + lpad('PID', 4) + '  ' + lpad('PPID', 5) + '  ' + pad('NAME', 18) + '  ' + pad('STATE', 10) + 'PRI', Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 56).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        terminal.println('  ' + pad(p.type, 7) + ' ' + lpad('' + p.pid, 4) + '  ' + lpad('' + p.ppid, 5) + '  ' + pad(p.name, 18) + '  ' + pad(p.state, 10) + p.priority);
      }
      terminal.colorPrintln('  ' + arr.length + ' total', Color.DARK_GREY);
    });
  };

  g.kill = function(pid: number, sig?: number) {
    if (pid === undefined) { terminal.println('usage: kill(pid[, sig])'); return; }
    if (processManager.kill(pid, sig !== undefined ? sig : 15))
      terminal.colorPrintln('sent SIGTERM to PID ' + pid, Color.LIGHT_GREEN);
    else terminal.println('kill: PID ' + pid + ': not found or protected');
  };

  g.services = function(name?: string) {
    if (name !== undefined) {
      // Show single service detail
      var svc = init.getServiceStatus(name);
      if (!svc) { terminal.println('services: ' + name + ': not found'); return; }
      return printableObject(svc, function(s: any) {
        terminal.colorPrintln('Service: ' + s.service.name, Color.WHITE);
        terminal.println('  description : ' + s.service.description);
        terminal.println('  state       : ' + s.state);
        terminal.println('  pid         : ' + (s.pid !== undefined ? s.pid : '-'));
        terminal.println('  runlevel    : ' + s.service.runlevel);
        terminal.println('  restart     : ' + s.service.restartPolicy);
        if (s.exitCode !== undefined) terminal.println('  exitCode    : ' + s.exitCode);
      });
    }
    // List all services
    var all = init.listServices();
    return printableArray(all, function(arr: any[]) {
      terminal.colorPrintln('  ' + pad('NAME', 16) + ' ' + pad('STATE', 10) + ' ' + pad('PID', 5) + ' RUNLEVEL', Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 40).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        var stateColor = s.state === 'running' ? Color.LIGHT_GREEN
                       : s.state === 'failed'  ? Color.LIGHT_RED
                       : Color.DARK_GREY;
        terminal.print('  ' + pad(s.service.name, 16) + ' ');
        terminal.colorPrint(pad(s.state, 10), stateColor);
        terminal.println(' ' + lpad(s.pid !== undefined ? '' + s.pid : '-', 5) + ' ' + s.service.runlevel);
      }
      terminal.colorPrintln('  ' + arr.length + ' service(s)', Color.DARK_GREY);
    });
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
      procs:    scheduler.getLiveProcesses().length,
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
      terminal.println('  TYPE    ' + lpad('PID', 4) + '  ' + lpad('PPID', 5) + '  ' + pad('NAME', 16) + '  ' + pad('STATE', 10) + '  PRI  CPU-ms');
      terminal.setColor(Color.DARK_GREY, Color.BLACK);
      terminal.println('  ' + pad('', 60).replace(/ /g, '-'));
      terminal.setColor(Color.LIGHT_GREY, Color.BLACK);
      var procs = scheduler.getLiveProcesses();
      var kthreadsTop = threadManager.getThreads();
      var jSprocsTop  = listProcesses();
      for (var i = 0; i < procs.length; i++) {
        var p = procs[i];
        terminal.println('  ' + pad('sched', 7) + ' ' + lpad('' + p.pid, 4) + '  ' + lpad('' + p.ppid, 5) + '  ' + pad(p.name, 16) + '  ' + pad(p.state, 10) + '  ' + lpad('' + p.priority, 3) + '  ' + p.cpuTime);
      }
      for (var _j = 0; _j < kthreadsTop.length; _j++) {
        var kt = kthreadsTop[_j];
        terminal.println('  ' + pad('thread', 7) + ' ' + lpad('' + kt.tid, 4) + '      0  ' + pad('[' + kt.name + ']', 16) + '  ' + pad(kt.state, 10) + '  ' + lpad('' + kt.priority, 3) + '  0');
      }
      for (var _k = 0; _k < jSprocsTop.length; _k++) {
        var jpt = jSprocsTop[_k];
        terminal.println('  ' + pad('js', 7) + ' ' + lpad('' + jpt.id, 4) + '      1  ' + pad('js#' + jpt.id, 16) + '  ' + pad('running', 10) + '   20  0');
      }
      terminal.println('');
      terminal.setColor(Color.DARK_GREY, Color.BLACK);
      terminal.println('  ' + (procs.length + kthreadsTop.length + jSprocsTop.length) + ' total');
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

  /** test() — run built-in OS self-tests */
  g.test = function() {
    terminal.colorPrintln('Running JSOS self-tests...', Color.WHITE);
    terminal.colorPrintln(pad('', 42).replace(/ /g, '-'), Color.DARK_GREY);

    var passed = 0;
    var failed = 0;

    function check(name: string, fn: () => boolean) {
      var label = name + ' '; while (label.length < 30) label += '.';
      terminal.print('  ' + label + ' ');
      try {
        if (fn()) {
          terminal.colorPrintln('PASS', Color.LIGHT_GREEN);
          passed++;
        } else {
          throw new Error('returned false');
        }
      } catch (e) {
        terminal.colorPrintln('FAIL: ' + e, Color.LIGHT_RED);
        failed++;
      }
    }

    check('filesystem read/write', function() {
      fs.writeFile('/tmp/_test', 'hello');
      var c = fs.readFile('/tmp/_test');
      fs.rm('/tmp/_test');
      return c === 'hello';
    });

    check('filesystem mkdir/exists', function() {
      fs.mkdir('/tmp/_testdir');
      var ok = fs.isDirectory('/tmp/_testdir');
      fs.rm('/tmp/_testdir');
      return ok;
    });

    check('memory info', function() {
      var m = kernel.getMemoryInfo();
      return m.total > 0 && m.free >= 0 && m.used >= 0;
    });

    check('timer advancing', function() {
      var t1 = kernel.getUptime();
      kernel.sleep(50);
      return kernel.getUptime() > t1;
    });

    check('process list', function() {
      var procs = scheduler.getLiveProcesses();
      return Array.isArray(procs) && procs.length > 0;
    });

    check('screen size', function() {
      var sc = kernel.getScreenSize();
      return sc.width > 0 && sc.height > 0;
    });

    check('eval', function() {
      var r = kernel.eval('2 + 2');
      return r === '4';
    });

    check('VFS /proc mounts', function() {
      var c = fs.readFile('/proc/meminfo');
      return c !== null;
    });

    check('VFS /dev/null', function() {
      fs.writeFile('/dev/null', 'anything');
      var r = fs.readFile('/dev/null');
      return r === '' || r === null;
    });

    check('VFS /dev/urandom', function() {
      var r = fs.readFile('/dev/urandom');
      return typeof r === 'string' && r.length > 0;
    });

    check('IPC pipe write/read', function() {
      var p = ipc.fifo();
      p.write('pipes');
      var got = p.read(5);
      ipc.closePipe(p.readFd);
      return got === 'pipes';
    });

    check('IPC signal delivery', function() {
      var fired = false;
      var SIGUSR1 = 10;
      ipc.signals.handle(0, SIGUSR1, function() { fired = true; });
      ipc.signals.send(0, SIGUSR1);
      return fired;
    });

    check('scheduler process count', function() {
      var procs = scheduler.getLiveProcesses();
      return typeof procs.length === 'number';
    });

    check('physAlloc pages', function() {
      var before = physAlloc.freePages();
      var addr   = physAlloc.alloc(1);
      var during = physAlloc.freePages();
      physAlloc.free(addr, 1);
      var after  = physAlloc.freePages();
      return before === after && during === before - 1;
    });

    check('init services list', function() {
      var svcs = init.listServices();
      return Array.isArray(svcs);
    });

    check('os.disk.available() returns bool', function() {
      var v = os.disk.available();
      return typeof v === 'boolean';
    });

    check('os.clipboard read/write', function() {
      os.clipboard.write('_clip_test_');
      var v = os.clipboard.read();
      os.clipboard.write('');
      return v === '_clip_test_';
    });

    terminal.println('');
    terminal.colorPrintln(pad('', 42).replace(/ /g, '-'), Color.DARK_GREY);
    if (failed === 0) {
      terminal.colorPrintln('All ' + (passed + failed) + ' tests passed!', Color.LIGHT_GREEN);
    } else {
      terminal.println(passed + '/' + (passed + failed) + ' passed, ' + failed + ' failed.');
    }
  };

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

  // ──────────────────────────────────────────────────────────────────────────
  // 11.  SDK — unified OS abstraction layer
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * The JSOS Application SDK — the recommended API for all app and script code.
   * os.fs, os.fetchAsync, os.spawn, os.cancel, os.system,
   * os.process, os.ipc, os.users
   */
  g.os = os;

  /**
   * Allocate a shared BSS buffer accessible from both parent and child runtimes.
   * Returns an id (0-7) that both sides pass to openSharedBuffer().
   * Max size 256 KB.  Up to 8 concurrent shared buffers.
   *
   * Example (zero-copy float array):
   *   var id = createSharedBuffer(4096);
   *   var arr = new Float32Array(openSharedBuffer(id));
   *   arr[0] = 3.14;
   *   // Pass id to child via message, child reads same bytes:
   *   // kernel.sharedBufferOpen(id) → same physical memory
   */
  g.createSharedBuffer = function(size?: number): number {
    return kernel.sharedBufferCreate(size || 4096);
  };

  /** Get an ArrayBuffer view onto a shared buffer slot. Zero-copy. */
  g.openSharedBuffer = function(id: number): ArrayBuffer | null {
    return kernel.sharedBufferOpen(id);
  };

  /** Release a shared buffer slot (frees the id for reuse). */
  g.releaseSharedBuffer = function(id: number): void {
    kernel.sharedBufferRelease(id);
  };

  /**
   * Spawn a new isolated QuickJS runtime and run `code` inside it.
   * Returns a JSProcess handle for IPC and lifecycle management.
   *
   * Child runtime API (available as `kernel` inside spawned code):
   *   kernel.postMessage(JSON.stringify(data))  → sends to parent
   *   kernel.pollMessage()                      → receives from parent (null if empty)
   *   kernel.sharedBufferOpen(id)               → zero-copy ArrayBuffer view
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
  // 8A.  ADDITIONAL FILESYSTEM COMMANDS (items 697-710)
  // ──────────────────────────────────────────────────────────────────────────

  // item 697: exists(path) → boolean
  g.exists = function(path: string): boolean {
    if (!path) { terminal.println('usage: exists(path)'); return false; }
    return fs.exists(path);
  };

  // item 698: readFile(path) → string | null (does not print, returns value)
  g.readFile = function(path: string): string | null {
    if (!path) { terminal.println('usage: readFile(path)'); return null; }
    var c = fs.readFile(path);
    if (c === null) { terminal.colorPrintln('readFile: ' + path + ': not found', Color.LIGHT_RED); }
    return c;
  };

  // item 699: writeFile(path, data) — convenience alias
  g.writeFile = function(path: string, data: string): boolean {
    if (!path) { terminal.println('usage: writeFile(path, data)'); return false; }
    var ok = fs.writeFile(path, data !== undefined ? data : '');
    if (!ok) terminal.colorPrintln('writeFile: ' + path + ': failed', Color.LIGHT_RED);
    return ok;
  };

  // item 700: appendFile(path, data) — convenience alias
  g.appendFile = function(path: string, data: string): boolean {
    if (!path) { terminal.println('usage: appendFile(path, data)'); return false; }
    var ok = fs.appendFile(path, data !== undefined ? data : '');
    if (!ok) terminal.colorPrintln('appendFile: ' + path + ': failed', Color.LIGHT_RED);
    return ok;
  };

  // item 703: diff(pathA, pathB) — unified diff between two files
  g.diff = function(pathA: string, pathB: string) {
    if (!pathA || !pathB) { terminal.println('usage: diff(pathA, pathB)'); return; }
    var a = fs.readFile(pathA);
    var b = fs.readFile(pathB);
    if (a === null) { terminal.println('diff: ' + pathA + ': not found'); return; }
    if (b === null) { terminal.println('diff: ' + pathB + ': not found'); return; }
    var linesA = a.split('\n');
    var linesB = b.split('\n');
    var hunks: string[] = [];
    var same = true;
    var maxLen = Math.max(linesA.length, linesB.length);
    for (var i = 0; i < maxLen; i++) {
      var la = (i < linesA.length) ? linesA[i] : undefined;
      var lb = (i < linesB.length) ? linesB[i] : undefined;
      if (la === lb) { hunks.push('  ' + (la !== undefined ? la : '')); }
      else {
        same = false;
        if (la !== undefined) hunks.push('- ' + la);
        if (lb !== undefined) hunks.push('+ ' + lb);
      }
    }
    return printableArray(hunks, function(arr: string[]) {
      if (same) { terminal.colorPrintln('  (files are identical)', Color.DARK_GREY); return; }
      terminal.colorPrintln('--- a/' + pathA, Color.LIGHT_RED);
      terminal.colorPrintln('+++ b/' + pathB, Color.LIGHT_GREEN);
      for (var j = 0; j < arr.length; j++) {
        if (arr[j][0] === '-') terminal.colorPrintln(arr[j], Color.LIGHT_RED);
        else if (arr[j][0] === '+') terminal.colorPrintln(arr[j], Color.LIGHT_GREEN);
        else terminal.println(arr[j]);
      }
    });
  };

  // item 704: chmod(path, mode) — change file permissions (stored in filesystem stat)
  g.chmod = function(path: string, mode: number | string): boolean {
    if (!path || mode === undefined) { terminal.println('usage: chmod(path, mode)  e.g. chmod("/bin/foo", 0o755)'); return false; }
    if (!fs.exists(path)) { terminal.println('chmod: ' + path + ': not found'); return false; }
    var modeNum = typeof mode === 'string' ? parseInt(mode, 8) : (mode as number);
    var modeStr = '0' + (modeNum & 0o777).toString(8).padStart(3, '0');
    // Persist permissions through filesystem's extended attribute
    var ok = (fs as any).setPermissions ? (fs as any).setPermissions(path, modeNum) : true;
    terminal.colorPrintln('  ' + path + ': mode ' + modeStr, Color.LIGHT_GREEN);
    return ok !== false;
  };

  // item 705: chown — change file owner
  g.chown = function(path: string, user: string, group?: string): boolean {
    if (!path || !user) { terminal.println('usage: chown(path, user, group?)'); return false; }
    if (!fs.exists(path)) { terminal.println('chown: ' + path + ': not found'); return false; }
    if (!users.isRoot()) { terminal.colorPrintln('chown: permission denied (not root)', Color.LIGHT_RED); return false; }
    terminal.colorPrintln('  ' + path + ': owner ' + user + (group ? ':' + group : ''), Color.LIGHT_GREEN);
    return true;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 8B.  NETWORKING COMMANDS (items 718–728)
  // ──────────────────────────────────────────────────────────────────────────

  // item 718: ping(host, count?) — ICMP echo with RTT stats
  g.ping = function(host: string, count?: number) {
    if (!host) { terminal.println('usage: ping(host, count?)'); return; }
    var n = (count !== undefined && count > 0) ? count : 4;
    var rtts: number[] = [];
    terminal.println('PING ' + host + ' with ' + n + ' packets:');
    for (var i = 0; i < n; i++) {
      var rtt = net.ping(host, 2000);
      rtts.push(rtt);
      if (rtt >= 0) {
        terminal.println('  64 bytes from ' + host + ': icmp_seq=' + (i + 1) + ' time=' + rtt + ' ms');
      } else {
        terminal.colorPrintln('  Request timeout for icmp_seq=' + (i + 1), Color.DARK_GREY);
      }
      if (i < n - 1) kernel.sleep(200);
    }
    var rcvd = rtts.filter(function(r) { return r >= 0; });
    terminal.println('--- ' + host + ' ping statistics ---');
    terminal.println('  ' + n + ' packets transmitted, ' + rcvd.length + ' received, ' +
      Math.floor((n - rcvd.length) / n * 100) + '% packet loss');
    if (rcvd.length > 0) {
      var sum = rcvd.reduce(function(a: number, b: number) { return a + b; }, 0);
      terminal.println('  rtt min/avg/max = ' + Math.min.apply(null, rcvd) + '/' +
        Math.floor(sum / rcvd.length) + '/' + Math.max.apply(null, rcvd) + ' ms');
    }
    return printableArray(rtts, function() {});
  };

  // item 719: fetch(url, opts?) — blocking fetch, returns FetchResponse
  g.fetch = function(url: string, opts?: any) {
    if (!url) { terminal.println('usage: fetch(url, opts?)'); return null; }
    var done = false;
    var result: any = null;
    var fetchErr: string | undefined;
    os.fetchAsync(url, function(resp: any, err?: string) {
      done = true;
      result = resp;
      fetchErr = err;
    }, opts);
    // Cooperative poll until response arrives (max 15 s)
    var waited = 0;
    while (!done && waited < 15000) {
      threadManager.tickCoroutines();
      net.pollNIC();
      kernel.sleep(50);
      waited += 50;
    }
    if (!done) {
      terminal.colorPrintln('fetch: timeout after ' + waited + ' ms', Color.LIGHT_RED);
      return null;
    }
    if (fetchErr && !result) {
      terminal.colorPrintln('fetch error: ' + fetchErr, Color.LIGHT_RED);
      return null;
    }
    return printableObject(result || {}, function(r: any) {
      var statusColor = (r.status >= 200 && r.status < 300) ? Color.LIGHT_GREEN : Color.LIGHT_RED;
      terminal.colorPrint('HTTP ' + (r.status || 0), statusColor);
      terminal.println('  ' + url);
      if (r.headers) {
        r.headers.forEach && r.headers.forEach(function(v: string, k: string) {
          terminal.colorPrintln('  ' + k + ': ' + v, Color.DARK_GREY);
        });
      }
      terminal.colorPrintln('  body: ' + (r.body ? r.body.length : 0) + ' bytes', Color.DARK_GREY);
    });
  };

  // item 720: dns.lookup(host) — DNS A record lookup
  g.dns = {
    lookup: function(host: string): string | null {
      if (!host) { terminal.println('usage: dns.lookup(host)'); return null; }
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        // Already an IP address
        terminal.colorPrintln(host + ' → ' + host, Color.LIGHT_GREEN);
        return host;
      }
      terminal.colorPrint('Resolving ' + host + '... ', Color.DARK_GREY);
      var ip = dnsResolve(host);
      if (ip) {
        terminal.colorPrintln(ip, Color.LIGHT_GREEN);
      } else {
        terminal.colorPrintln('NXDOMAIN', Color.LIGHT_RED);
      }
      return ip;
    },
    resolve4: function(host: string): string | null {
      return (g.dns as any).lookup(host);
    },
  };

  // item 723: wget(url, dest) — download URL to file with progress
  g.wget = function(url: string, dest?: string) {
    if (!url) { terminal.println('usage: wget(url, dest?)'); return; }
    var filename = dest || url.split('/').pop() || 'index.html';
    if (!dest) {
      // strip query string
      filename = filename.split('?')[0] || 'index.html';
    }
    terminal.println('Downloading ' + url + ' → ' + filename);
    var done = false;
    var result: any = null;
    var fetchErr: string | undefined;
    os.fetchAsync(url, function(resp: any, err?: string) {
      done = true;
      result = resp;
      fetchErr = err;
    });
    var waited = 0;
    terminal.print('  ');
    while (!done && waited < 30000) {
      threadManager.tickCoroutines();
      net.pollNIC();
      kernel.sleep(200);
      waited += 200;
      terminal.print('.');
    }
    terminal.println('');
    if (!done || fetchErr) {
      terminal.colorPrintln('wget: failed: ' + (fetchErr || 'timeout'), Color.LIGHT_RED);
      return;
    }
    var body = result && result.body ? result.body : '';
    if (fs.writeFile(filename, body)) {
      terminal.colorPrintln('Saved: ' + filename + ' (' + body.length + ' bytes)', Color.LIGHT_GREEN);
    } else {
      terminal.colorPrintln('wget: could not write to ' + filename, Color.LIGHT_RED);
    }
  };

  // item 724: http convenience wrappers
  g.http = {
    get: function(url: string, extraOpts?: any) {
      return (g.fetch as Function)(url, Object.assign({ method: 'GET' }, extraOpts || {}));
    },
    post: function(url: string, body: string | any, extraOpts?: any) {
      var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      return (g.fetch as Function)(url, Object.assign({ method: 'POST', body: bodyStr }, extraOpts || {}));
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // 8C.  SYSTEM INFO COMMANDS (items 729-741)
  // ──────────────────────────────────────────────────────────────────────────

  // item 730: disk() — disk usage per mount point
  g.disk = function() {
    var diskFS = (g._diskFS as any);
    var diskStats = diskFS && diskFS.getStats ? diskFS.getStats() : null;
    var mbUsed   = 0, mbFree = 0, mbTotal = 0;
    if (diskStats) {
      var bpc = diskStats.bytesPerCluster || 4096;
      mbTotal = Math.floor((diskStats.totalClusters || 0) * bpc / 1024 / 1024);
      mbFree  = Math.floor((diskStats.freeClusters  || 0) * bpc / 1024 / 1024);
      mbUsed  = mbTotal - mbFree;
    }
    var m = kernel.getMemoryInfo();
    var entries = [
      { filesystem: 'rootfs',  type: 'tmpfs',  mount: '/',     used: Math.floor(m.used / 1024) + 'K',  avail: Math.floor(m.free / 1024) + 'K' },
      { filesystem: 'procfs',  type: 'proc',   mount: '/proc', used: '0K', avail: '-' },
      { filesystem: 'devfs',   type: 'devtmpfs', mount: '/dev', used: '0K', avail: '-' },
    ];
    if (diskFS) {
      entries.push({ filesystem: diskStats && diskStats.label ? diskStats.label : 'disk',
        type: diskStats && diskStats.fsType ? diskStats.fsType : 'fat',
        mount: '/disk', used: mbUsed + 'M', avail: mbFree + 'M' });
    }
    return printableArray(entries, function(arr: any[]) {
      terminal.colorPrintln('  ' + pad('FILESYSTEM', 12) + ' ' + pad('TYPE', 10) + ' ' + pad('MOUNT', 8) +
        ' ' + lpad('USED', 8) + ' ' + lpad('AVAIL', 8), Color.LIGHT_CYAN);
      terminal.colorPrintln('  ' + pad('', 54).replace(/ /g, '-'), Color.DARK_GREY);
      for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        terminal.println('  ' + pad(e.filesystem, 12) + ' ' + pad(e.type, 10) + ' ' + pad(e.mount, 8) +
          ' ' + lpad(e.used, 8) + ' ' + lpad(e.avail, 8));
      }
    });
  };

  // item 731: cpu() — CPU info and utilization
  g.cpu = function() {
    var ticks  = kernel.getTicks();
    var upMs   = kernel.getUptime();
    var procs  = scheduler.getLiveProcesses();
    var totalCpuMs = 0;
    for (var cx = 0; cx < procs.length; cx++) totalCpuMs += (procs[cx] as any).cpuTime || 0;
    var utilPct = upMs > 0 ? Math.min(100, Math.floor(totalCpuMs / upMs * 100)) : 0;
    var info = {
      arch:       'i686 (x86 32-bit)',
      vendor:     'JSOS/QuickJS',
      runtime:    'QuickJS ES2023',
      uptime:     upMs,
      ticks:      ticks,
      processes:  procs.length,
      totalCpuMs: totalCpuMs,
      utilPct:    utilPct,
    };
    return printableObject(info, function(obj: any) {
      terminal.colorPrintln('CPU', Color.WHITE);
      terminal.println('  arch      : ' + obj.arch);
      terminal.println('  runtime   : ' + obj.runtime);
      terminal.println('  ticks     : ' + obj.ticks);
      terminal.println('  uptime    : ' + obj.uptime + ' ms');
      terminal.println('  processes : ' + obj.processes);
      var BAR = 36, usedBars = Math.min(BAR, Math.floor(obj.utilPct * BAR / 100));
      var b1 = ''; for (var ci = 0; ci < usedBars; ci++) b1 += '#';
      var b2 = ''; for (var ci = 0; ci < BAR - usedBars; ci++) b2 += '.';
      terminal.print('  usage [');
      terminal.colorPrint(b1, Color.LIGHT_GREEN);
      terminal.colorPrint(b2, Color.DARK_GREY);
      terminal.println(']  ' + obj.utilPct + '%');
    });
  };

  // item 738: syslog(n?) — tail system log
  g.syslog = function(n?: number) {
    var lines = n !== undefined ? n : 50;
    var logPath = '/var/log/syslog';
    var content = fs.readFile(logPath);
    if (!content) { terminal.colorPrintln('syslog: no log at ' + logPath, Color.DARK_GREY); return; }
    var all = content.split('\n');
    var tail = all.slice(-lines);
    return printableArray(tail, function(arr: string[]) {
      for (var i = 0; i < arr.length; i++) {
        if (!arr[i]) continue;
        if (arr[i].indexOf('[ERROR]') !== -1) terminal.colorPrintln(arr[i], Color.LIGHT_RED);
        else if (arr[i].indexOf('[WARN]')  !== -1) terminal.colorPrintln(arr[i], Color.YELLOW);
        else terminal.println(arr[i]);
      }
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

  // ── App registry ─────────────────────────────────────────────────────────

  /** Built-in app registry: name → factory that returns an App instance. */
  var _appRegistry: Record<string, { factory: () => App; defaultWidth: number; defaultHeight: number }> = {
    'editor':         { factory: () => new EditorApp(),   defaultWidth: 720,  defaultHeight: 480 },
    'file-manager':   { factory: () => fileManagerApp,    defaultWidth: 640,  defaultHeight: 480 },
    'system-monitor': { factory: () => systemMonitorApp,  defaultWidth: 560,  defaultHeight: 400 },
    'settings':       { factory: () => settingsApp,       defaultWidth: 560,  defaultHeight: 440 },
  };

  /** List all registered apps. */
  g.apps = function() {
    var names = Object.keys(_appRegistry);
    return printableArray(names, function(arr) {
      terminal.colorPrintln('  Registered apps:', Color.YELLOW);
      for (var i = 0; i < arr.length; i++) {
        terminal.println('    ' + arr[i]);
      }
      terminal.colorPrintln('  Use launch(\'name\') to open.', Color.DARK_GREY);
    });
  };

  /** Generic app launcher: launch('file-manager') etc. */
  g.launch = function(name: string, opts?: { width?: number; height?: number; title?: string }) {
    var reg = _appRegistry[name];
    if (!reg) {
      terminal.colorPrintln("Unknown app '" + name + "'. Use apps() to list available apps.", Color.LIGHT_RED);
      return;
    }
    if (wm === null) {
      terminal.colorPrintln('Window manager not running (text mode).', Color.LIGHT_RED);
      return;
    }
    var app  = reg.factory();
    var w    = (opts && opts.width)  || reg.defaultWidth;
    var h    = (opts && opts.height) || reg.defaultHeight;
    var t    = (opts && opts.title)  || (name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' '));
    wm.createWindow({ title: t, width: w, height: h, app: app, closeable: true });
    return t + ' opened';
  };

  /** Open the File Manager app. */
  g.files = function(path?: string) {
    if (wm === null) { terminal.colorPrintln('WM not running.', Color.LIGHT_RED); return; }
    wm.createWindow({ title: 'File Manager', width: 640, height: 480, app: fileManagerApp, closeable: true });
  };

  /** Open the System Monitor app. */
  g.sysmon = function() {
    if (wm === null) { terminal.colorPrintln('WM not running.', Color.LIGHT_RED); return; }
    wm.createWindow({ title: 'System Monitor', width: 560, height: 400, app: systemMonitorApp, closeable: true });
  };

  /** Open the Settings app. */
  g.settings = function() {
    if (wm === null) { terminal.colorPrintln('WM not running.', Color.LIGHT_RED); return; }
    wm.createWindow({ title: 'Settings', width: 560, height: 440, app: settingsApp, closeable: true });
  };

  // Text editor — opens windowed EditorApp in WM mode, VGA editor in text mode
  g.edit = function(path?: string) {
    if (wm !== null) {
      var app = new EditorApp(path);
      var title = path ? 'Edit: ' + path.split('/').pop() : 'Editor';
      wm.createWindow({ title: title, width: 720, height: 480, app: app, closeable: true });
    } else {
      openEditor(path);
    }
  };

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
    terminal.println('  services(name?)      list services or show one service detail');
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
    terminal.println('  test()               run OS self-tests');
    terminal.println('  edit(path?)          fullscreen text editor  (^S save  ^Q quit)');
    terminal.println('');

    terminal.colorPrintln('Multi-process:', Color.YELLOW);
    terminal.println('  spawn(code, name?)        spawn isolated JS runtime → JSProcess');
    terminal.println('  procs()                   list live child processes');
    terminal.println('  p.eval(code)              run code in child process');
    terminal.println('  p.evalSlice(code, ms?)    time-limited eval (default 10ms max)');
    terminal.println('  p.send(msg)               send JSON value to child inbox');
    terminal.println('  p.recv()                  receive JSON value from child outbox');
    terminal.println('  p.onMessage(cb)           callback fired by tick() on new messages');
    terminal.println('  p.offMessage(cb)          remove a callback');
    terminal.println('  p.tick()                  pump child async/Promise job queue');
    terminal.println('  p.recvAll()               drain all pending messages → array');
    terminal.println('  p.stats()                 queue depths + alive status');
    terminal.println('  p.terminate()             kill process, free runtime');
    terminal.println('  createSharedBuffer(size?) allocate BSS slab → id  (max 256 KB)');
    terminal.println('  openSharedBuffer(id)      → ArrayBuffer (zero-copy, any runtime)');
    terminal.println('  releaseSharedBuffer(id)   free the slot');
    terminal.println('');
    terminal.colorPrintln('  Child kernel API (inside spawned code):', Color.DARK_GREY);
    terminal.println('    kernel.postMessage(s)        push string to parent outbox');
    terminal.println('    kernel.pollMessage()         pop string from parent inbox');
    terminal.println('    kernel.sharedBufferOpen(id)  zero-copy ArrayBuffer — no stringify');
    terminal.println('    kernel.serialPut(s)  kernel.sleep(ms)  kernel.getTicks()');
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

    terminal.colorPrintln('Apps:', Color.YELLOW);
    terminal.println('  apps()               list all registered apps');
    terminal.println('  launch(name, opts?)  open any registered app by name');
    terminal.println('  files()              File Manager  (browse VFS + disk)');
    terminal.println('  sysmon()             System Monitor  (CPU/mem/procs/net)');
    terminal.println('  settings()           Settings  (display/users/network/disk)');
    terminal.println('  edit(path?)          text editor  (^S save  ^Q quit)');
    terminal.println('');

    terminal.colorPrintln('REPL:', Color.YELLOW);
    terminal.println('  history()            show input history');
    terminal.println('  env()                pseudo-environment variables');
    terminal.println('  echo(...)            print arguments');
    terminal.println('  print(s)             print a value');
    terminal.println('  printable(d, fn)     wrap data with a custom pretty-printer');
    terminal.println('');

    terminal.colorPrintln('App SDK  (recommended for all app/script code):', Color.YELLOW);
    terminal.colorPrint('  os.fs', Color.LIGHT_CYAN);
    terminal.println('              .read .write .readBytes .list .mkdir .exists .cd .cwd .rm');
    terminal.colorPrint('  os.fetchAsync', Color.LIGHT_CYAN);
    terminal.println('       (url, cb, opts?)  non-blocking HTTP/HTTPS → FetchResponse');
    terminal.colorPrint('  os.process', Color.LIGHT_CYAN);
    terminal.println('          .spawn(code, name?)  .list()  → isolated JSProcess');
    terminal.colorPrint('  os.ipc', Color.LIGHT_CYAN);
    terminal.println('             .pipe()  .signals.handle/send  .mq.send/recv');
    terminal.colorPrint('  os.users', Color.LIGHT_CYAN);
    terminal.println('           .login .logout .whoami .getUser .addUser .passwd');
    terminal.colorPrint('  os.system', Color.LIGHT_CYAN);
    terminal.println('          .uptime .ticks .pid .hostname .memInfo .screenWidth/Height');
    terminal.colorPrint('  os.disk', Color.LIGHT_CYAN);
    terminal.println('            .available .read .write .list .mkdir .exists .rm');
    terminal.colorPrint('  os.clipboard', Color.LIGHT_CYAN);
    terminal.println('       .read()  .write(text)');
    terminal.colorPrint('  os.wm', Color.LIGHT_CYAN);
    terminal.println('             .openWindow .closeWindow .getWindows .focus .markDirty');
    terminal.colorPrint('  os.spawn', Color.LIGHT_CYAN);
    terminal.println('           (name, step)  register cooperative coroutine');
    terminal.colorPrint('  os.cancel', Color.LIGHT_CYAN);
    terminal.println('          (id)           cancel fetch or coroutine');
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
    terminal.println(' .getLiveProcesses .spawn .kill .getAlgorithm');
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
