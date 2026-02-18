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
import systemManager from './system.js';
import { openEditor } from './editor.js';

declare var kernel: import('./kernel.js').KernelAPI;

/** Route console.log / .error / .warn through kernel VGA output */
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
      kernel.print(parts.join(' '));
    },
    error: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = kernel.getColor();
      kernel.setColor(Color.LIGHT_RED, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    warn: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = kernel.getColor();
      kernel.setColor(Color.YELLOW, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    clear: function() { kernel.clear(); }
  };
  (globalThis as any).console = con;
}

/**
 * All OS functionality exposed as plain JS globals in the REPL.
 * Shell-like functions print their own output and return undefined.
 * Raw-data functions (fs.*, sys.*) return values for scripting.
 */
function setupGlobals(): void {
  var g = globalThis as any;

  // ── Scripting APIs (return raw data) ──────────────────────────────────────

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
      if (!code) { kernel.print('Not found: ' + p); return; }
      return kernel.eval(code);
    },
  };

  g.sys = {
    mem:      function() { return kernel.getMemoryInfo(); },
    uptime:   function() { return kernel.getUptime(); },
    ticks:    function() { return kernel.getTicks(); },
    screen:   function() { return kernel.getScreenSize(); },
    ps:       function() { return systemManager.getProcessList(); },
    spawn:    function(name: string) { return systemManager.createProcess(name); },
    kill:     function(pid: number) { return systemManager.terminateProcess(pid); },
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
      return { os: 'JSOS v' + (fs.readFile('/etc/version') || '1.0.0'),
               hostname: fs.readFile('/etc/hostname') || 'jsos',
               arch: 'i686', runtime: 'QuickJS ES2023',
               screen: kernel.getScreenSize(), memory: m,
               uptime: kernel.getUptime(),
               processes: systemManager.getProcessList().length };
    },
  };

  // ── Shorthand print ───────────────────────────────────────────────────────

  g.print = function(s: any) { kernel.print(String(s)); };

  // ── Shell-like functions (print output, return undefined) ─────────────────
  // These behave like unix commands: they display formatted output.
  // For scriptable data, use fs.* and sys.* above.

  function pad(s: string, w: number) { while (s.length < w) s += ' '; return s; }
  function lpad(s: string, w: number) { while (s.length < w) s = ' ' + s; return s; }

  g.ls = function(path?: string) {
    var target = path || fs.cwd();
    var items = fs.ls(path || '');
    if (items.length === 0) {
      if (!fs.exists(target)) { kernel.print('ls: ' + target + ': no such directory'); return; }
      terminal.colorPrintln('(empty)', Color.DARK_GREY);
      return;
    }
    terminal.colorPrintln('  ' + target, Color.DARK_GREY);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
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
  };

  g.cd = function(path?: string) {
    var p = path || '/home/user';
    if (!fs.cd(p)) { kernel.print('cd: ' + p + ': no such directory'); return; }
    var cwd = fs.cwd();
    if (cwd.indexOf('/home/user') === 0) cwd = '~' + cwd.slice(10);
    terminal.colorPrintln(cwd, Color.LIGHT_BLUE);
  };

  g.pwd = function() { terminal.colorPrintln(fs.cwd(), Color.LIGHT_BLUE); };

  g.cat = function(path: string) {
    if (!path) { kernel.print('usage: cat(path)'); return; }
    var c = fs.readFile(path);
    if (c === null) { kernel.print('cat: ' + path + ': no such file'); return; }
    kernel.print(c);
  };

  g.mkdir = function(path: string) {
    if (!path) { kernel.print('usage: mkdir(path)'); return; }
    if (fs.mkdir(path)) terminal.colorPrintln('created: ' + path, Color.LIGHT_GREEN);
    else kernel.print('mkdir: ' + path + ': failed');
  };

  g.touch = function(path: string) {
    if (!path) { kernel.print('usage: touch(path)'); return; }
    if (!fs.exists(path)) fs.writeFile(path, '');
    terminal.colorPrintln('touched: ' + path, Color.LIGHT_GREEN);
  };

  g.rm = function(path: string) {
    if (!path) { kernel.print('usage: rm(path)'); return; }
    if (fs.rm(path)) terminal.colorPrintln('removed: ' + path, Color.LIGHT_GREEN);
    else kernel.print('rm: ' + path + ': failed (not found or non-empty dir)');
  };

  g.cp = function(src: string, dst: string) {
    if (!src || !dst) { kernel.print('usage: cp(src, dst)'); return; }
    if (fs.cp(src, dst)) terminal.colorPrintln('copied: ' + src + ' -> ' + dst, Color.LIGHT_GREEN);
    else kernel.print('cp: ' + src + ': failed');
  };

  g.mv = function(src: string, dst: string) {
    if (!src || !dst) { kernel.print('usage: mv(src, dst)'); return; }
    if (fs.mv(src, dst)) terminal.colorPrintln('moved: ' + src + ' -> ' + dst, Color.LIGHT_GREEN);
    else kernel.print('mv: ' + src + ': failed');
  };

  g.write = function(path: string, content: string) {
    if (!path) { kernel.print('usage: write(path, content)'); return; }
    if (fs.writeFile(path, content || ''))
      terminal.colorPrintln('wrote ' + (content || '').length + 'B -> ' + path, Color.LIGHT_GREEN);
    else kernel.print('write: ' + path + ': failed');
  };

  g.append = function(path: string, content: string) {
    if (!path) { kernel.print('usage: append(path, content)'); return; }
    if (fs.appendFile(path, content || ''))
      terminal.colorPrintln('appended ' + (content || '').length + 'B -> ' + path, Color.LIGHT_GREEN);
    else kernel.print('append: ' + path + ': failed');
  };

  g.find = function(pathOrPat: string, pattern?: string) {
    var base = pattern ? pathOrPat : '/';
    var pat  = pattern || pathOrPat || '*';
    var results = fs.find(base, pat);
    for (var i = 0; i < results.length; i++) terminal.println('  ' + results[i]);
    terminal.colorPrintln('  ' + results.length + ' match(es)', Color.DARK_GREY);
  };

  g.stat = function(path: string) {
    if (!path) { kernel.print('usage: stat(path)'); return; }
    var info = fs.stat(path);
    if (!info) { kernel.print('stat: ' + path + ': no such path'); return; }
    terminal.println('  path : ' + path);
    terminal.println('  type : ' + info.type);
    terminal.println('  size : ' + info.size + ' bytes');
    terminal.println('  perm : ' + info.permissions);
  };

  g.run = function(path: string) {
    if (!path) { kernel.print('usage: run(path)'); return; }
    var code = fs.readFile(path) || fs.readFile('/bin/' + path);
    if (!code) { kernel.print('run: ' + path + ': not found'); return; }
    terminal.colorPrintln('running ' + path + '...', Color.DARK_GREY);
    var r = kernel.eval(code);
    if (r && r !== 'undefined') kernel.print(r);
  };

  g.ps = function() {
    var procs = systemManager.getProcessList();
    terminal.colorPrintln('  ' + lpad('PID', 4) + '  ' + pad('NAME', 20) + pad('STATE', 12) + 'PRI', Color.LIGHT_CYAN);
    terminal.colorPrintln('  ' + pad('', 42, ).replace(/ /g, '-'), Color.DARK_GREY);
    for (var i = 0; i < procs.length; i++) {
      var p = procs[i];
      terminal.println('  ' + lpad('' + p.id, 4) + '  ' + pad(p.name, 20) + pad(p.state, 12) + p.priority);
    }
    terminal.colorPrintln('  ' + procs.length + ' process(es)', Color.DARK_GREY);
  };

  g.kill = function(pid: number) {
    if (pid === undefined) { kernel.print('usage: kill(pid)'); return; }
    if (systemManager.terminateProcess(pid))
      terminal.colorPrintln('killed PID ' + pid, Color.LIGHT_GREEN);
    else kernel.print('kill: PID ' + pid + ': not found or protected');
  };

  g.mem = function() {
    var m = kernel.getMemoryInfo();
    terminal.colorPrintln('Memory', Color.WHITE);
    terminal.println('  total : ' + Math.floor(m.total / 1024) + ' KB');
    terminal.println('  used  : ' + Math.floor(m.used  / 1024) + ' KB');
    terminal.println('  free  : ' + Math.floor(m.free  / 1024) + ' KB');
    var BAR = 36, used = Math.min(BAR, Math.floor((m.used / m.total) * BAR));
    var b1 = pad('', used).replace(/ /g, '#');
    var b2 = pad('', BAR - used).replace(/ /g, '.');
    terminal.print('  ['); terminal.colorPrint(b1, Color.LIGHT_RED);
    terminal.colorPrint(b2, Color.LIGHT_GREEN);
    terminal.println(']  ' + Math.floor((m.used / m.total) * 100) + '%');
  };

  g.uptime = function() {
    var ms = kernel.getUptime();
    var s = Math.floor(ms / 1000), m2 = Math.floor(s / 60), h = Math.floor(m2 / 60);
    s = s % 60; m2 = m2 % 60;
    var parts: string[] = [];
    if (h > 0) parts.push(h + 'h');
    if (m2 > 0) parts.push(m2 + 'm');
    parts.push(s + 's');
    terminal.println('  ' + parts.join(' ') + '  (' + ms + ' ms)');
    terminal.colorPrintln('  ticks: ' + kernel.getTicks(), Color.DARK_GREY);
  };

  g.sysinfo = function() {
    var m = kernel.getMemoryInfo(), sc = kernel.getScreenSize();
    terminal.colorPrintln('JSOS System Information', Color.WHITE);
    terminal.println('  os       : JSOS v' + (fs.readFile('/etc/version') || '1.0.0'));
    terminal.println('  hostname : ' + (fs.readFile('/etc/hostname') || 'jsos'));
    terminal.println('  arch     : i686 (x86 32-bit)');
    terminal.println('  runtime  : QuickJS ES2023');
    terminal.println('  screen   : ' + sc.width + 'x' + sc.height + ' VGA text');
    terminal.println('  memory   : ' + Math.floor(m.total / 1024) + ' KB total, ' + Math.floor(m.free / 1024) + ' KB free');
    terminal.println('  uptime   : ' + Math.floor(kernel.getUptime() / 1000) + 's');
    terminal.println('  procs    : ' + systemManager.getProcessList().length);
  };

  g.colors = function() {
    var names = ['BLACK','BLUE','GREEN','CYAN','RED','MAGENTA','BROWN','LT_GREY',
                 'DK_GREY','LT_BLUE','LT_GREEN','LT_CYAN','LT_RED','LT_MAG','YELLOW','WHITE'];
    terminal.colorPrintln('VGA Palette (0-15)', Color.WHITE);
    for (var i = 0; i < 16; i++) {
      kernel.setColor(i, 0); kernel.printRaw('  ' + lpad('' + i, 2) + ' ########  ');
      kernel.setColor(7, 0); terminal.colorPrintln(names[i], Color.DARK_GREY);
    }
  };

  g.hostname = function(name?: string) {
    if (name) { fs.writeFile('/etc/hostname', name); terminal.colorPrintln('hostname -> ' + name, Color.LIGHT_GREEN); }
    else terminal.println(fs.readFile('/etc/hostname') || 'jsos');
  };

  g.echo = function() {
    var parts: string[] = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    kernel.print(parts.join(' '));
  };

  g.clear  = function() { kernel.clear(); };
  g.sleep  = function(ms: number) { kernel.sleep(ms); };
  g.halt   = function() { kernel.halt(); };
  g.reboot = function() { kernel.reboot(); };

  // ── Text editor ──────────────────────────────────────────────────
  g.edit = function(path?: string) { openEditor(path); };

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
    terminal.println('  print(s)             kernel.print shorthand');
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
    terminal.colorPrintln("  ls('/bin').map(function(f){return f.name;})", Color.WHITE);
    terminal.colorPrintln("  cat('/etc/hostname')", Color.WHITE);
    terminal.colorPrintln("  write('/tmp/hi.js', 'kernel.print(42)')", Color.WHITE);
    terminal.colorPrintln("  run('/tmp/hi.js')", Color.WHITE);
    terminal.colorPrintln("  JSON.stringify(sys.sysinfo(), null, 2)", Color.WHITE);
    terminal.colorPrintln("  for(var i=0;i<16;i++){kernel.setColor(i,0);kernel.printRaw('##');}", Color.WHITE);
    terminal.println('');
  };
}

/** Boot banner */
function printBanner(): void {
  kernel.clear();
  kernel.setColor(Color.LIGHT_CYAN, Color.BLACK);
  kernel.print('');
  kernel.print('     ######  ######  ####### ######  ');
  kernel.print('       ##   ##       ##   ## ##      ');
  kernel.print('       ##    ######  ##   ##  #####  ');
  kernel.print('  ##   ##        ## ##   ##      ## ');
  kernel.print('   #####   ######  ####### ######  ');
  kernel.print('');
  kernel.setColor(Color.WHITE, Color.BLACK);
  kernel.print('       JavaScript Operating System');
  kernel.print('');
  kernel.setColor(Color.DARK_GREY, Color.BLACK);
  kernel.print('  QuickJS ES2023  |  i686  |  Bare Metal');
  kernel.print('  Type help() to see all available functions');
  kernel.print('');
  kernel.setColor(Color.LIGHT_GREY, Color.BLACK);
}

/** Main entry point - called by the bundled JS IIFE footer */
function main(): void {
  setupConsole();
  setupGlobals();
  printBanner();
  startRepl();
  // startRepl() loops forever; only returns on halt/reboot
  kernel.halt();
}

export { main };
export default main;
