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
 * Expose fs, sys, and print as globals so they're accessible from kernel.eval()
 * inside the REPL (both share the same QuickJS global context).
 */
function setupGlobals(): void {
  // fs — filesystem scripting API
  (globalThis as any).fs = {
    ls:     function(p?: string) { return fs.ls(p || ''); },
    cat:    function(p: string) { return fs.readFile(p); },
    read:   function(p: string) { return fs.readFile(p); },
    write:  function(p: string, c: string) { return fs.writeFile(p, c); },
    append: function(p: string, c: string) { return fs.appendFile(p, c); },
    mkdir:  function(p: string) { return fs.mkdir(p); },
    touch:  function(p: string) { if (!fs.exists(p)) fs.writeFile(p, ''); return p; },
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
      if (!code) { kernel.print('Not found: ' + p); return undefined; }
      return kernel.eval(code);
    },
  };

  // sys — system operations
  (globalThis as any).sys = {
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
      return {
        os: 'JSOS v' + (fs.readFile('/etc/version') || '1.0.0'),
        hostname: fs.readFile('/etc/hostname') || 'jsos',
        arch: 'i686',
        runtime: 'QuickJS ES2023',
        screen: kernel.getScreenSize(),
        memory: m,
        uptime: kernel.getUptime(),
        processes: systemManager.getProcessList().length,
      };
    },
  };

  // print — shorthand for kernel.print
  (globalThis as any).print = function(s: any) { kernel.print(String(s)); };
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
  kernel.print('  Type .help to see available APIs');
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
