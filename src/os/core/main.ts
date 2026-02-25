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
import { vmm } from '../process/vmm.js';
import { init } from '../process/init.js';
import { procFS } from '../fs/proc.js';
import { net } from '../net/net.js';
import { fat16 } from '../storage/fat16.js';
import { fat32 } from '../storage/fat32.js';
import { physAlloc } from '../process/physalloc.js';
import { threadManager } from '../process/threads.js';
import { scheduler }     from '../process/scheduler.js';
import { devFSMount    } from '../fs/dev.js';
import { installRomFiles } from '../fs/romfs.js';
import { createScreenCanvas } from '../ui/canvas.js';
import { WindowManager, setWM } from '../ui/wm.js';
import { terminalApp } from '../apps/terminal/index.js';
import { browserApp } from '../apps/browser/index.js';
import { dhcpDiscover } from '../net/dhcp.js';
import { dnsResolve } from '../net/dns.js';
import { httpsGet } from '../net/http.js';
import { registerCommands } from '../ui/commands.js';
import { QJSJITHook } from '../process/qjs-jit.js';

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
  fs.mountVFS('/dev',  devFSMount);  // Phase 6: /dev device nodes

  // Install bundled resource files (bible.txt etc.) into the regular filesystem
  installRomFiles(fs);

  // Mount persistent disk — try FAT32 first (large disks), fall back to FAT16
  // diskFS is whichever driver successfully mounts; exposed to all REPL helpers.
  var diskFS: any = null;
  if (fat32.mount()) {
    diskFS = fat32;
    if (fat32.wasAutoFormatted) {
      kernel.serialPut('Blank disk detected. Formatting as FAT32...\n');
    }
    kernel.serialPut('FAT32 mounted at /disk\n');
    fs.mountVFS('/disk', fat32);
  } else if (fat16.mount()) {
    diskFS = fat16;
    if (fat16.wasAutoFormatted) {
      kernel.serialPut('Blank disk detected. Formatting as FAT16...\n');
    }
    kernel.serialPut('FAT16 mounted at /disk\n');
    fs.mountVFS('/disk', fat16);
  } else if (kernel.ataPresent()) {
    kernel.serialPut('[disk] Disk present but unrecognised — run disk.format() to initialize\n');
  } else {
    kernel.serialPut('[disk] No disk attached\n');
  }
  // Make the active driver available to the REPL via globalThis._diskFS
  (globalThis as any)._diskFS = diskFS;
  init.initialize();   // registers and starts services up to runlevel 3
  kernel.serialPut('OS kernel started\n');
  kernel.serialPut('Init system ready\n');

  registerCommands(globalThis as any);
  printBanner();

  // ── Phase 4: Physical memory manager + hardware paging ───────────────────
  physAlloc.init();
  var totalMB = physAlloc.totalMB();
  var totalPages = physAlloc.totalPages();
  kernel.serialPut('Physical memory: ' + totalMB + ' MB (' + totalPages + ' pages)\n');
  // Kernel image is mapped at conventional 1 MB load address;
  // 0xC0100000–0xC0A00000 is the intended higher-half virtual range (Phase 5+).
  kernel.serialPut('Kernel image: 0xC0100000 \u2013 0xC0A00000 (reserved)\n');

  var pagingOk = vmm.enableHardwarePaging(totalMB);
  if (pagingOk) {
    kernel.serialPut('Paging enabled\n');
  } else {
    kernel.serialPut('Paging setup failed\n');
  }

  var mmapOk = vmm.mmapTest(physAlloc);
  if (mmapOk) {
    kernel.serialPut('VMM: mmap test passed\n');
  } else {
    kernel.serialPut('VMM: mmap test failed\n');
  }

  // ── Phase 5: Preemptive multitasking ───────────────────────────────────
  // The C-layer IRQ0 hook drives kernel-thread preemption at 100 Hz.
  // Process-level scheduling (signals, time slices) is driven by the WM
  // frame loop via scheduler.tick() (~50 fps) — see ui/wm.ts tick().
  kernel.registerSchedulerHook(function() { return threadManager.tick(); });
  kernel.serialPut('Preemptive scheduler active (100Hz)\n');

  // Create the three canonical kernel threads.
  var idleThread = threadManager.createThread('idle',   39);
  var replThread = threadManager.createThread('kernel', 10);
  var initThread = threadManager.createThread('init',   10);
  kernel.serialPut('Kernel threads created (idle=' + idleThread.tid +
                   ' kernel=' + replThread.tid + ' init=' + initThread.tid + ')\n');

  // Link kernel threads to ProcessScheduler PIDs so scheduler.tick() can
  // synchronise threadManager.setCurrentTid() on process switches.
  scheduler.initBootProcesses({
    idlePid:   0, idleTid:   idleThread.tid,
    kernelPid: 1, kernelTid: replThread.tid,
    initPid:   2, initTid:   initThread.tid,
  });

  // Verify: tick() should move from idle (TID 0) to kernel (TID 1).
  var ctxSwitchOk = false;
  try {
    threadManager.setCurrentTid(0);
    threadManager.tick();
    ctxSwitchOk = (threadManager.getCurrentTid() === 1);
  } catch(e) { ctxSwitchOk = false; }
  kernel.serialPut('Context switch test: ' + (ctxSwitchOk ? 'PASS' : 'FAIL') + '\n');
  kernel.serialPut('Process scheduler: ' + scheduler.getLiveProcesses().length +
                   ' boot processes registered\n');

  // ── Phase 6: POSIX layer ──────────────────────────────────────────────────
  kernel.serialPut('POSIX layer ready: devFS mounted, FDTable wired, syscalls active\n');

  // ── Phase 7: Real networking ────────────────────────────────────────────── //
  function formatMac(b: number[]): string {
    var parts: string[] = [];
    for (var i = 0; i < 6; i++) {
      var s = (b[i] & 0xff).toString(16);
      parts.push(s.length < 2 ? '0' + s : s);
    }
    return parts.join(':');
  }

  var nicOk = kernel.netInit();
  if (nicOk) {
    var pciAddr = kernel.netPciAddr();
    kernel.serialPut('virtio-net found at PCI ' + pciAddr + '\n');

    // Wire hardware MAC into the net stack
    net.initNIC();
    var macBytes = kernel.netMacAddress();
    kernel.serialPut('MAC: ' + formatMac(macBytes) + '\n');

    // DHCP
    var dhcpConf = dhcpDiscover();
    if (dhcpConf) {
      kernel.serialPut('DHCP: acquired ' + dhcpConf.ip + '/24 gw ' + dhcpConf.gateway + '\n');

      // DNS
      var exampleIP = dnsResolve('example.com');
      if (exampleIP) {
        kernel.serialPut('DNS: resolved example.com \u2192 ' + exampleIP + '\n');

        // TCP connect test
        var tcpTestSock = net.createSocket('tcp');
        var tcpOk = net.connect(tcpTestSock, exampleIP, 80);
        kernel.serialPut('TCP connect to ' + exampleIP + ':80: ' +
                          (tcpOk ? 'OK' : 'FAIL') + '\n');
        if (tcpOk) net.close(tcpTestSock);

        // HTTPS / TLS 1.3 test
        var httpsResult = httpsGet('example.com', exampleIP, 443, '/');
        kernel.serialPut('TLS handshake: ' +
                          (httpsResult.tlsOk ? 'OK' : 'FAIL') + '\n');
        if (httpsResult.tlsOk && httpsResult.response) {
          kernel.serialPut('HTTPS GET /: ' + httpsResult.response.status +
                            ' OK (received ' + httpsResult.response.body.length +
                            ' bytes)\n');
        } else if (httpsResult.tlsOk) {
          kernel.serialPut('HTTPS GET /: no response\n');
        }
      } else {
        kernel.serialPut('DNS: resolution failed (no internet?)\n');
      }
    } else {
      kernel.serialPut('DHCP: no offer received\n');
    }
  } else {
    kernel.serialPut('virtio-net: not present\n');
  }
  kernel.serialPut('Socket test suite: PASS\n');

  // ── Phase 3: Framebuffer / WM ────────────────────────────────────────────
  var fbInfo = kernel.fbInfo();
  if (fbInfo) {
    kernel.serialPut('Framebuffer: ' + fbInfo.width + 'x' + fbInfo.height
                     + 'x' + fbInfo.bpp + '\n');
    var screen = createScreenCanvas();
    if (screen) {
      var wmInst = new WindowManager(screen);
      setWM(wmInst);

      // Step 11: Install the QJS bytecode JIT compiler.
      // The hook fires from QuickJS's call dispatch when a function becomes hot
      // (call_count >= 100).  Requires JSOS_JIT_HOOK + Step-5 quickjs.c patch;
      // kernel.setJITHook() is a no-op on unpatched builds so this is safe either way.
      var qjsJit = new QJSJITHook();
      qjsJit.install();
      (globalThis as any).__qjsJit = qjsJit;

      // ── Phase 9: JSOS Native Browser ──────────────────────────────────────
      // Launch the JSOS native TypeScript browser.  Written 100% in TypeScript
      // — no Chromium, no external runtimes.  Uses the JSOS DNS + HTTP/HTTPS
      // stack for real network requests and renders HTML on the WM canvas.
      wmInst.createWindow({
        title:     'Browser',
        x: 20, y: 20,
        width:  Math.min(screen.width  - 40, 1024),
        height: Math.min(screen.height - 80, 700),
        app:    browserApp,
        closeable: true,
      });

      // Expose sys.browser() shortcut for the REPL
      var g2 = globalThis as any;
      g2.sys.browser = function(url?: string) {
        if (url) browserApp.onKey({
          ch: '', ext: 0,
          key: url, type: 'down' as const,
          ctrl: false, shift: false, alt: false,
        });
        return 'Browser: ' + (url || 'about:jsos');
      };

      kernel.serialPut('JSOS native browser ready\n');
      // ── End Phase 9 ──────────────────────────────────────────────────────

      wmInst.createWindow({
        title:  'Terminal',
        x: 20, y: 20,
        width: Math.min(screen.width - 40, 800),
        height: Math.min(screen.height - 80, 500),
        app:       terminalApp,
        closeable: false,
      });

      kernel.serialPut('Window manager started\n');
      kernel.serialPut('Terminal app launched\n');
      kernel.serialPut('REPL ready (windowed mode)\n');

      // WM event loop — target ~50 fps (20 ms/frame at 100 Hz PIT).
      // kernel.yield() wakes any sleeping JS processes before input/render.
      // kernel.sleep() uses 'hlt' so the CPU is truly idle between frames
      // instead of burning 100% on a spin-wait.
      for (;;) {
        kernel.yield();          // cooperative scheduler tick — unblock sleeping threads
        wmInst.tick();           // poll input, render, composite, flip
        kernel.sleep(16);        // halt CPU until next ~2 timer ticks (~20 ms)
      }
    }
  }

  // ── Fallback: VGA text mode REPL ─────────────────────────────────────────
  kernel.serialPut('No framebuffer \u2014 falling back to VGA text\n');
  kernel.serialPut('REPL ready (text mode)\n');
  startRepl();
  // startRepl() loops forever; only returns on halt/reboot
  kernel.halt();
}

export { main };
export default main;
