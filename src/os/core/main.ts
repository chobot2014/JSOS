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
import { dhcpDiscoverAsync } from '../net/dhcp.js';
import { registerCommands } from '../ui/commands.js';
import { QJSJITHook } from '../process/qjs-jit.js';
import { JITOSKernels } from '../process/jit-os.js';
import { JITBrowserEngine } from '../apps/browser/jit-browser.js';
import { _registerJITStats, os } from './sdk.js';
import { writebackTimer } from '../fs/buffer-cache.js';
import { ntp } from '../net/ntp.js';
import { detectHypervisor } from '../process/guest-addons.js';
import { gunzip } from '../net/deflate.js';

declare var kernel: import('./kernel.js').KernelAPI; // kernel.js is in core/

/**
 * Pre-warm gzip/DEFLATE inner loops so QJSJITHook auto-JITs them before the
 * first real network response.  Uses a known-valid 21-byte gzip of "A"
 * (single fixed-Huffman block).  Called 4× so every inner function
 * (gunzip, inflateDEFLATE, inflateBlock, huffDecode, BitReader) exceeds
 * JIT_THRESHOLD=2 and gets compiled to native code before DHCP finishes.
 */
function _prewarmDeflate(): void {
  // gzip of the single ASCII byte 'A' (0x41), fixed-Huffman DEFLATE block.
  // gunzip() skips the CRC32+ISIZE trailer so the last 8 bytes can be zero.
  var _GZ: number[] = [
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, // gzip header
    0x73, 0x04, 0x00,                                             // DEFLATE 'A' + EOB
    0x43, 0xbe, 0xb7, 0xe8,                                       // CRC32 (not checked)
    0x01, 0x00, 0x00, 0x00,                                       // ISIZE = 1
  ];
  // 4 calls: functions reached >=2 calls early; 3rd call triggers native compile.
  try { gunzip(_GZ); } catch (_) {}
  try { gunzip(_GZ); } catch (_) {}
  try { gunzip(_GZ); } catch (_) {}
  try { gunzip(_GZ); } catch (_) {}
}

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

  // Expose the SDK as globalThis.os for modules that access it dynamically
  // (e.g. jit-browser.ts uses (globalThis as any).os?.fetchAsync).
  (globalThis as any).os = os;

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

  // ── Phase 3.5: Hypervisor / guest-addons detection ─────────────────────
  var hvInfo = detectHypervisor();
  kernel.serialPut('[hypervisor] detected: ' + hvInfo.hypervisor + '\n');

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
  // Detect and init the NIC immediately (fast — just reads MAC address).
  // DHCP discovery runs later as a non-blocking background coroutine so the
  // WM / browser start without waiting for a DHCP server (fixes boot freeze).
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
    net.initNIC();
    var macBytes = kernel.netMacAddress();
    kernel.serialPut('MAC: ' + formatMac(macBytes) + '\n');
    kernel.serialPut('[net] NIC ready — DHCP will run in background\n');
  } else {
    kernel.serialPut('virtio-net: not present\n');
  }

  // ── Phase 3: Framebuffer / WM ────────────────────────────────────────────
  var fbInfo = kernel.fbInfo();
  if (fbInfo) {
    kernel.serialPut('Framebuffer: ' + fbInfo.width + 'x' + fbInfo.height
                     + 'x' + fbInfo.bpp + '\n');
    var screen = createScreenCanvas();
    if (screen) {
      var wmInst = new WindowManager(screen);
      setWM(wmInst);

      // Register the child-process FS bridge so child runtimes spawned via
      // wm.launchApp() / os.wm.launchApp() can perform file I/O via the main
      // runtime's filesystem implementation (in-memory VFS + FAT32/FAT16).
      kernel.registerChildFSBridge({
        readFile:  function(path: string) { return fs.readFile(path); },
        writeFile: function(path: string, data: string) { return fs.writeFile(path, data); },
        readDir:   function(path: string) {
          var entries = fs.ls(path);
          return JSON.stringify(entries ? (entries as any[]).map(function(e: any) { return e.name; }) : []);
        },
        exists:    function(path: string) { return fs.readFile(path) !== null || fs.ls(path) !== null; },
        stat:      function(path: string) { var s = fs.stat(path); return s ? JSON.stringify(s) : null; },
      });

      // Step 11: Install the QJS bytecode JIT compiler.
      // The hook fires from QuickJS's call dispatch when a function becomes hot
      // (call_count >= 100).  Requires JSOS_JIT_HOOK + Step-5 quickjs.c patch;
      // kernel.setJITHook() is a no-op on unpatched builds so this is safe either way.
      var qjsJit = new QJSJITHook();
      qjsJit.install();
      (globalThis as any).__qjsJit = qjsJit;

      // Tier-2 JIT: compile OS integer kernels (checksum, memcpy, CRC-32, etc.)
      // at module-load time so they run native from the very first call.
      JITOSKernels.init();

      // Tier-2 JIT: compile browser engine hot-paths (string hash, canvas clear,
      // CSS int parse, composite row, text width, HTML scan) so the browser
      // renders pages at native speed from the very first page load.
      JITBrowserEngine.init();

      // Pre-warm the gzip/DEFLATE pipeline so the first HTTP response is fast.
      // This runs gunzip() 4x on a tiny synthetic payload, causing QJSJITHook
      // to compile huffDecode/inflateBlock/BitReader to native before DHCP fires.
      _prewarmDeflate();
      kernel.serialPut('[boot] deflate pipeline pre-warmed\n');

      // Register JIT stats providers so os.system.jitStats() returns live data.
      _registerJITStats(qjsJit, () => JITOSKernels.stats());

      // ── Background network bootstrap (non-blocking) ────────────────────
      // DHCP runs as a coroutine driven by kernel.yield() in the WM loop.
      // The browser uses os.fetchAsync which is also coroutine-based, so
      // it will naturally wait until the stack has an IP before succeeding.
      if (nicOk) {
        dhcpDiscoverAsync(function(conf) {
          if (conf) {
            kernel.serialPut('[net] DHCP ok: ' + conf.ip + ' gw ' + conf.gateway + '\n');
            ntp.startPeriodicSync();
            // Navigate the browser to google.com now that the network stack has an IP.
            browserApp.navigate('https://www.google.com/');
          } else {
            kernel.serialPut('[net] DHCP: no offer — no network\n');
          }
        });
      }

      // ── Phase 9: JSOS Native Browser ──────────────────────────────────────
      // Launch the JSOS native TypeScript browser.  Written 100% in TypeScript
      // — no Chromium, no external runtimes.  Uses the JSOS DNS + HTTP/HTTPS
      // stack for real network requests and renders HTML on the WM canvas.
      var browserWin = wmInst.createWindow({
        title:     'Browser',
        x: 0, y: 20,
        width:  Math.min(screen.width  - 40, 1024),
        height: Math.min(screen.height - 178, 700),
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

      // Focus the browser window so it renders on top of the terminal
      wmInst.focusWindow(browserWin.id);
      wmInst.bringToFront(browserWin.id);

      kernel.serialPut('Window manager started\n');
      kernel.serialPut('Terminal app launched\n');
      kernel.serialPut('REPL ready (windowed mode)\n');

      // WM event loop — target ~50 fps (20 ms/frame at 100 Hz PIT).
      // kernel.yield() wakes any sleeping JS processes before input/render.
      // kernel.sleep() uses 'hlt' so the CPU is truly idle between frames
      // instead of burning 100% on a spin-wait.
      var _guardedRun = typeof (kernel as any).guardedRun === 'function'
        ? (kernel as any).guardedRun.bind(kernel)
        : null;
      // Minimal event loop: ALL JS logic is inside guardedRun so that any
      // #PF / #GP during a frame is caught.  No complex code between
      // guardedRun calls — only kernel.sleep(8) which is a trivial C call.
      // _tickChildProcs now auto-destroys faulting children, so the same
      // corrupt child won't be re-ticked on the next frame.
      var _wasActive = false;
      var _tickFn = function() {
        kernel.yield();          // cooperative scheduler tick — unblock sleeping threads
        try { _wasActive = wmInst.tick(); } catch(e) { kernel.serialPut('[tick] wm error: ' + String(e).slice(0, 100) + '\n'); }
        try { init.tick(kernel.getUptime()); } catch(e) { kernel.serialPut('[tick] init error: ' + String(e).slice(0, 100) + '\n'); }
        try { writebackTimer.tick(kernel.getTicks()); } catch(e) { kernel.serialPut('[tick] wb error: ' + String(e).slice(0, 100) + '\n'); }
      };
      // Fault storm detection: if guardedRun returns -1 (CPU fault) more than
      // _FAULT_THRESHOLD consecutive times, we assume a coroutine is stuck in a
      // crash loop.  Clear all pending coroutines to break the cycle so the OS
      // can continue operating.  The threshold is low (3) so recovery is fast.
      var _consecutiveFaults = 0;
      var _FAULT_THRESHOLD = 3;
      var _idleCount = 0;
      for (;;) {
        if (_guardedRun) {
          var _gr = _guardedRun(_tickFn);
          if (_gr === -1) {
            _consecutiveFaults++;
            if (_consecutiveFaults >= _FAULT_THRESHOLD) {
              kernel.serialPut('[main] fault storm (' + _consecutiveFaults + ' consecutive faults) — clearing coroutines\n');
              threadManager.clearCoroutines();
              _consecutiveFaults = 0;
            }
          } else {
            _consecutiveFaults = 0;
          }
        } else {
          try { _tickFn(); } catch (_) {}
        }
        // Adaptive sleep: 1ms when active (fast poll), ramp to 4ms when idle.
        // Reset idle count on real activity (input, dirty windows, coroutines).
        if (_consecutiveFaults > 0) { kernel.sleep(2); _idleCount = 0; }
        else if (_wasActive) { kernel.sleep(1); _idleCount = 0; }
        else if (_idleCount < 4) { kernel.sleep(1); _idleCount++; }
        else { kernel.sleep(4); }
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
