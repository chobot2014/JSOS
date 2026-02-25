/**
 * JSOS Application SDK
 *
 * The ONLY module that application code should import OS services from.
 *
 * Abstractions provided:
 *   os.fs       — Virtual filesystem (read, write, list, mkdir, …)
 *   os.net      — High-level networking (fetchAsync, raw socket)
 *   os.spawn()  — Register a cooperative coroutine (advanced use)
 *   os.cancel() — Cancel a running coroutine
 *   os.system   — System information (uptime, ticks, pid, memory, …)
 *
 * Implementation details (DNS, TCP, TLS, coroutine state machine, etc.)
 * are hidden here and NOT exposed to application code.  Apps only see
 * clean, typed interfaces.
 *
 * Architecture constraint from agents.md:
 *   "C code exists only to provide generic hardware access primitives."
 *   All OS logic — including the async fetch state machine — lives here
 *   in TypeScript, never in C.
 */

import fs            from '../fs/filesystem.js';
import { net }       from '../net/net.js';
import { TLSSocket } from '../net/tls.js';
import { threadManager, type CoroutineStep } from '../process/threads.js';
import { processManager } from '../process/process.js';
import {
  dnsResolveCached,
  dnsSendQueryAsync,
  dnsPollReplyAsync,
  dnsCancelAsync,
} from '../net/dns.js';
import { parseHttpResponse } from '../net/http.js';
import { JSProcess, listProcesses } from '../process/jsprocess.js';
import { ipc } from '../ipc/ipc.js';
import { users } from '../users/users.js';
import { wm, getWM, type App, type WMWindow } from '../ui/wm.js';
export { Colors, type PixelColor } from '../ui/canvas.js';
export { JSProcess } from '../process/jsprocess.js';

declare var kernel: import('./kernel.js').KernelAPI;

// ── Public types ──────────────────────────────────────────────────────────────

export interface FetchOptions {
  method?:       'GET' | 'POST';
  headers?:      Record<string, string>;
  body?:         string;
  /** Maximum redirects to follow (default 5). */
  maxRedirects?: number;
}

export interface FetchResponse {
  status:   number;
  headers:  Map<string, string>;
  /** Raw response body bytes. */
  body:     number[];
  /** Body decoded as Latin-1 (suitable for HTML/text). */
  bodyText: string;
  /** Final URL after any redirects. */
  finalURL: string;
}

// ── Internal fetch state ──────────────────────────────────────────────────────

type FetchStage =
  | 'dns' | 'connecting' | 'tls' | 'sending' | 'receiving' | 'parsing' | 'done';

interface ParsedURL {
  protocol: 'http' | 'https';
  host:     string;
  port:     number;
  path:     string;
}

function _parseURL(raw: string): ParsedURL | null {
  var m = raw.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/);
  if (!m) return null;
  var protocol = m[1] as 'http' | 'https';
  var port     = m[3] ? parseInt(m[3], 10) : (protocol === 'https' ? 443 : 80);
  return { protocol, host: m[2], port, path: m[4] || '/' };
}

function _resolveHref(href: string, baseURL: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) {
    return (baseURL.startsWith('https://') ? 'https' : 'http') + ':' + href;
  }
  var base = _parseURL(baseURL);
  if (!base) return href;
  var ps = (base.protocol === 'http' && base.port === 80) ||
           (base.protocol === 'https' && base.port === 443)
           ? '' : ':' + base.port;
  var origin = base.protocol + '://' + base.host + ps;
  if (href.startsWith('/')) return origin + href;
  return origin + base.path.replace(/\/[^/]*$/, '/') + href;
}

interface InFlightFetch {
  coroId:       number;
  stage:        FetchStage;
  originalURL:  string;
  currentURL:   string;
  parsed:       ParsedURL;
  fetchIP:      string;
  sock:         any;   // net.Socket
  tls:          any;   // TLSSocket | null
  chunks:       number[][];
  deadline:     number;
  dnsPort:      number;
  dnsId:        number;
  redirects:    number;
  maxRedirects: number;
  opts:         FetchOptions;
  callback:     (resp: FetchResponse | null, error?: string) => void;
}

function _cleanupFetch(f: InFlightFetch): void {
  if (f.sock) { try { net.close(f.sock); } catch (_e) {} f.sock = null; }
  if (f.tls)  { try { f.tls.close();    } catch (_e) {} f.tls  = null; }
  if (f.dnsPort > 0) { dnsCancelAsync(f.dnsPort); f.dnsPort = 0; }
}

function _buildFetchCoroutine(f: InFlightFetch): CoroutineStep {
  return function (): 'done' | 'pending' {
    // ── DNS ────────────────────────────────────────────────────────────────
    if (f.stage === 'dns') {
      var ip = dnsPollReplyAsync(f.parsed.host, f.dnsPort, f.dnsId);
      if (ip) {
        f.fetchIP  = ip;
        f.dnsPort  = 0;
        f.stage    = 'connecting';
        f.deadline = kernel.getTicks() + 200;
        f.sock     = net.createSocket('tcp');
        net.connectAsync(f.sock, ip, f.parsed.port);
        return 'pending';
      }
      if (kernel.getTicks() >= f.deadline) {
        dnsCancelAsync(f.dnsPort); f.dnsPort = 0;
        _cleanupFetch(f);
        f.callback(null, 'DNS lookup failed for ' + f.parsed.host);
        return 'done';
      }
      return 'pending';
    }

    // ── TCP connect ────────────────────────────────────────────────────────
    if (f.stage === 'connecting') {
      var status = net.connectPoll(f.sock);
      if (status === 'connected') {
        f.stage = (f.parsed.protocol === 'https') ? 'tls' : 'sending';
        return 'pending';
      }
      if (kernel.getTicks() >= f.deadline) {
        _cleanupFetch(f);
        f.callback(null, 'Connection timed out: ' + f.fetchIP + ':' + f.parsed.port);
        return 'done';
      }
      return 'pending';
    }

    // ── TLS handshake (synchronous — typically < 200 ms) ──────────────────
    if (f.stage === 'tls') {
      var tls = new TLSSocket(f.parsed.host);
      if (!tls.handshakeOnConnected(f.sock)) {
        _cleanupFetch(f);
        f.callback(null, 'TLS handshake failed with ' + f.fetchIP);
        return 'done';
      }
      f.tls   = tls;
      f.stage = 'sending';
      return 'pending';
    }

    // ── Send HTTP request ──────────────────────────────────────────────────
    if (f.stage === 'sending') {
      var method  = (f.opts.method || 'GET').toUpperCase();
      var path    = f.parsed.path;
      var extraHdrs = '';
      if (f.opts.headers) {
        for (var k in f.opts.headers) extraHdrs += k + ': ' + f.opts.headers[k] + '\r\n';
      }
      var bodyStr = f.opts.body || '';
      var req  = method + ' ' + path + ' HTTP/1.1\r\n' +
                 'Host: ' + f.parsed.host + '\r\n' +
                 'Connection: close\r\n' +
                 'Accept: text/html,*/*\r\n' +
                 (bodyStr ? 'Content-Length: ' + bodyStr.length + '\r\n' : '') +
                 extraHdrs +
                 '\r\n' + bodyStr;
      var reqBytes: number[] = new Array(req.length);
      for (var ri = 0; ri < req.length; ri++) reqBytes[ri] = req.charCodeAt(ri) & 0xff;
      if (f.tls) f.tls.write(reqBytes); else net.sendBytes(f.sock, reqBytes);
      f.chunks   = [];
      f.deadline = kernel.getTicks() + 500;   // 5 s hard timeout
      f.stage    = 'receiving';
      return 'pending';
    }

    // ── Receive ────────────────────────────────────────────────────────────
    if (f.stage === 'receiving') {
      var chunk: number[] | null = f.tls ? f.tls.readNB() : net.recvBytesNB(f.sock);
      if (chunk && chunk.length > 0) {
        f.chunks.push(chunk);
        f.deadline = kernel.getTicks() + 100;  // silence timeout resets on each chunk
      }
      if (kernel.getTicks() >= f.deadline) f.stage = 'parsing';
      return 'pending';
    }

    // ── Parse ──────────────────────────────────────────────────────────────
    if (f.stage === 'parsing') {
      if (f.sock) { try { net.close(f.sock); } catch (_e) {} f.sock = null; }
      if (f.tls)  { try { f.tls.close();    } catch (_e) {} f.tls  = null; }

      var total = 0;
      for (var ci = 0; ci < f.chunks.length; ci++) total += f.chunks[ci].length;
      if (total === 0) {
        f.callback(null, 'No response from ' + f.fetchIP);
        return 'done';
      }
      var flat: number[] = new Array(total);
      var off = 0;
      for (var ci2 = 0; ci2 < f.chunks.length; ci2++) {
        var ch = f.chunks[ci2];
        for (var j = 0; j < ch.length; j++) flat[off++] = ch[j];
      }
      f.chunks = [];

      var resp = parseHttpResponse(flat);
      if (!resp) {
        f.callback(null, 'Could not parse HTTP response from ' + f.fetchIP);
        return 'done';
      }

      // Redirect handling
      if (resp.status >= 300 && resp.status < 400) {
        var loc = resp.headers.get('location') || '';
        if (loc && f.redirects < f.maxRedirects) {
          f.redirects++;
          var rURL    = _resolveHref(loc, f.currentURL);
          var rParsed = _parseURL(rURL);
          if (!rParsed) { f.callback(null, 'Invalid redirect URL: ' + rURL); return 'done'; }
          f.currentURL = rURL;
          f.parsed     = rParsed;
          var rIP = dnsResolveCached(rParsed.host);
          if (rIP) {
            f.fetchIP  = rIP;
            f.stage    = 'connecting';
            f.deadline = kernel.getTicks() + 200;
            f.sock     = net.createSocket('tcp');
            net.connectAsync(f.sock, rIP, rParsed.port);
          } else {
            f.stage    = 'dns';
            f.deadline = kernel.getTicks() + 300;
            var rq     = dnsSendQueryAsync(rParsed.host);
            f.dnsPort  = rq.port;
            f.dnsId    = rq.id;
          }
          return 'pending';
        } else if (loc) {
          f.callback(null, 'Too many redirects');
          return 'done';
        }
      }

      if (resp.status < 200 || resp.status >= 400) {
        // Return the error response — caller decides how to render it
        var bodyText = '';
        for (var bi = 0; bi < resp.body.length; bi++)
          bodyText += String.fromCharCode(resp.body[bi] & 0xff);
        f.callback({
          status: resp.status, headers: resp.headers,
          body: resp.body, bodyText, finalURL: f.currentURL
        }, 'HTTP ' + resp.status);
        return 'done';
      }

      var bodyText2 = '';
      for (var bi2 = 0; bi2 < resp.body.length; bi2++)
        bodyText2 += String.fromCharCode(resp.body[bi2] & 0xff);
      f.callback({ status: resp.status, headers: resp.headers, body: resp.body, bodyText: bodyText2, finalURL: f.currentURL });
      return 'done';
    }

    return 'done';
  };
}

// ── SDK implementation ────────────────────────────────────────────────────────

const sdk = {

  // ── Filesystem ─────────────────────────────────────────────────────────────

  fs: {
    /** Read a file as a string (Latin-1). Returns null if not found. */
    read(path: string): string | null {
      return fs.readFile(path);
    },
    /** Write a string to a file. Returns true on success. */
    write(path: string, data: string): boolean {
      return fs.writeFile(path, data);
    },
    /** Read a file as raw bytes. Returns null if not found. */
    readBytes(path: string): number[] | null {
      var text = fs.readFile(path);
      if (text === null) return null;
      var out: number[] = new Array(text.length);
      for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    },
    /** List directory entry names. Returns [] for missing/non-dir. */
    list(path: string): string[] {
      try {
        var entries = fs.list(path);
        if (!entries) return [];
        return entries.map(function(e: any) { return e.name as string; });
      } catch (_e) { return []; }
    },
    /** Create a directory (and parents). Returns false if already exists. */
    mkdir(path: string): boolean {
      return fs.mkdir(path);
    },
    /** Returns true if path exists as a file or directory. */
    exists(path: string): boolean {
      if (fs.readFile(path) !== null) return true;
      try { return fs.list(path) != null; } catch (_e) { return false; }
    },
    /** Current working directory. */
    cwd(): string {
      return fs.cwd();
    },
    /** Change directory. Returns false if path not found. */
    cd(path: string): boolean {
      return fs.cd(path);
    },
    /** Remove a file or directory. */
    rm(path: string): boolean {
      return fs.rm(path);
    },
  },

  // ── Async network fetch ─────────────────────────────────────────────────────

  /**
   * Fetch a URL without blocking the OS.
   *
   * The request is driven by the WM coroutine scheduler — one step per frame
   * (~16 ms).  `callback` is invoked on completion (success or failure).
   * Returns a coroutine id that can be passed to `os.cancel()` to abort.
   *
   * Example:
   *   var id = os.fetchAsync('https://example.com/', function(resp, err) {
   *     if (err)  { /* handle error *\/ }
   *     else      { /* use resp.bodyText *\/ }
   *   });
   */
  fetchAsync(
    url: string,
    callback: (resp: FetchResponse | null, error?: string) => void,
    opts?: FetchOptions,
  ): number {
    var o      = opts || {};
    var parsed = _parseURL(url);
    if (!parsed) {
      // Defer callback to next tick so callers can capture the returned id first
      var deferCoroId = -1;
      deferCoroId = threadManager.runCoroutine('fetch-err', function () {
        callback(null, 'Invalid URL: ' + url);
        return 'done';
      });
      return deferCoroId;
    }

    var f: InFlightFetch = {
      coroId:       -1,
      stage:        'dns',
      originalURL:  url,
      currentURL:   url,
      parsed,
      fetchIP:      '',
      sock:         null,
      tls:          null,
      chunks:       [],
      deadline:     0,
      dnsPort:      0,
      dnsId:        0,
      redirects:    0,
      maxRedirects: o.maxRedirects !== undefined ? o.maxRedirects : 5,
      opts:         o,
      callback,
    };

    // If the IP is already cached, skip DNS
    var cachedIP = dnsResolveCached(parsed.host);
    if (cachedIP) {
      f.fetchIP  = cachedIP;
      f.stage    = 'connecting';
      f.deadline = kernel.getTicks() + 200;
      f.sock     = net.createSocket('tcp');
      net.connectAsync(f.sock, cachedIP, parsed.port);
    } else {
      f.stage    = 'dns';
      f.deadline = kernel.getTicks() + 300;
      var q      = dnsSendQueryAsync(parsed.host);
      f.dnsPort  = q.port;
      f.dnsId    = q.id;
    }

    var step = _buildFetchCoroutine(f);
    var id   = threadManager.runCoroutine('fetch:' + parsed.host, step);
    f.coroId = id;
    return id;
  },

  // ── Coroutine control ───────────────────────────────────────────────────────

  /**
   * Register a custom cooperative coroutine.
   * `step` is called once per WM frame (~16 ms).  Return 'done' to finish.
   * Returns a coroutine id for use with `os.cancel()`.
   */
  spawn(name: string, step: CoroutineStep): number {
    return threadManager.runCoroutine(name, step);
  },

  /**
   * Cancel a running coroutine (fetch or custom).
   * The coroutine's step function will not be called again.
   */
  cancel(coroId: number): void {
    threadManager.cancelCoroutine(coroId);
  },

  // ── System information ──────────────────────────────────────────────────────

  system: {
    /** Milliseconds since OS boot. */
    uptime(): number {
      return kernel.getUptime();
    },
    /** Raw PIT tick count (~100 Hz, 1 tick ≈ 10 ms). */
    ticks(): number {
      return kernel.getTicks();
    },
    /** Current process ID. */
    pid(): number {
      return processManager.getpid();
    },
    /** System hostname from /etc/hostname. */
    hostname(): string {
      return fs.readFile('/etc/hostname') || 'jsos';
    },
    /** Physical memory statistics. */
    memory(): { total: number; free: number; used: number } {
      var info = kernel.getMemoryInfo();
      return { total: info.total, free: info.free, used: info.used };
    },
    /** OS identification. */
    uname(): { sysname: string; release: string; machine: string } {
      return { sysname: 'JSOS', release: '1.0.0', machine: 'i686' };
    },
  },

  // ── Multi-process (isolated QuickJS runtimes) ─────────────────────────────

  /**
   * Spawn and manage isolated QuickJS child runtimes.
   * Each process has its own heap, GC, and global scope.
   * The WM automatically ticks all live processes every frame (~16 ms).
   * Communicate via send/recv and kernel.postMessage/pollMessage inside the child.
   *
   * Example:
   *   var p = os.process.spawn(`
   *     var n = 0;
   *     function tick() { kernel.postMessage(String(++n)); }
   *   `, 'counter');
   *   p.eval('tick()');
   *   p.recv(); // → 1
   */
  process: {
    /** Spawn a new isolated QuickJS runtime.  See JSProcess docs for full API. */
    spawn(code: string, name?: string): JSProcess {
      return JSProcess.spawn(code, name);
    },
    /** List all live C-level child process slots. */
    list(): Array<{ id: number; inboxCount: number; outboxCount: number }> {
      return listProcesses();
    },
  },

  // ── IPC (pipes, signals, message queues between JS coroutines) ────────────

  /**
   * Inter-process communication primitives.
   * Provides pipes, POSIX signals, and named message queues that work
   * across scheduler contexts and coroutines.
   *
   * Example:
   *   var pipe = os.ipc.createPipe(3, 4);
   *   pipe.write('hello');
   *   pipe.read(5); // → 'hello'
   */
  ipc,

  // ── User accounts and authentication ─────────────────────────────────────

  /**
   * User account management and authentication.
   * Reads/writes /etc/passwd and /etc/group.
   *
   * Example:
   *   os.users.login('user', '');  // login as unprivileged user
   *   os.users.whoami();           // → { uid: 1000, name: 'user', ... }
   */
  users,

  // ── Disk (FAT32/FAT16 persistent storage) ───────────────────────────────

  /**
   * Persistent disk storage via FAT32/FAT16.  Only available when QEMU
   * presents a block device; check `os.disk.available()` first.
   *
   * Example:
   *   if (os.disk.available()) {
   *     os.disk.write('/notes.txt', 'hello');
   *     os.disk.read('/notes.txt'); // → 'hello'
   *   }
   */
  disk: {
    /** Returns true when a FAT disk driver has been mounted. */
    available(): boolean { return !!(globalThis as any)._diskFS; },
    /** Read a file from disk.  Returns null if unavailable or not found. */
    read(path: string): string | null {
      var d = (globalThis as any)._diskFS; return d ? d.read(path) : null;
    },
    /** Write (create or overwrite) a file on disk.  Returns false if unavailable. */
    write(path: string, data: string): boolean {
      var d = (globalThis as any)._diskFS; return d ? !!d.writeFile(path, data) : false;
    },
    /** List directory entries.  Returns [] if unavailable. */
    list(path?: string): Array<{ name: string; type: 'file' | 'dir'; size: number }> {
      var d = (globalThis as any)._diskFS; return d ? (d.list(path || '/') ?? []) : [];
    },
    /** Create a directory.  Returns false if unavailable. */
    mkdir(path: string): boolean {
      var d = (globalThis as any)._diskFS; return d ? !!d.mkdir(path) : false;
    },
    /** Check whether a path exists. */
    exists(path: string): boolean {
      var d = (globalThis as any)._diskFS; return d ? !!d.exists(path) : false;
    },
    /** Remove a file or empty directory. */
    rm(path: string): boolean {
      var d = (globalThis as any)._diskFS; return d ? !!d.remove(path) : false;
    },
  },

  // ── Clipboard (WM-backed) ───────────────────────────────────────────────

  /**
   * System clipboard backed by the WindowManager.
   * Only meaningful once a WM instance is active (windowed mode).
   *
   * Example:
   *   os.clipboard.write('copy me');
   *   os.clipboard.read(); // → 'copy me'
   */
  clipboard: {
    /** Read the current clipboard text. */
    read(): string { return wm ? wm.getClipboard() : ''; },
    /** Write text to the clipboard. */
    write(text: string): void { if (wm) wm.setClipboard(text); },
  },

  // ── Window Manager ─────────────────────────────────────────────────────

  /**
   * Window manager API for app code that needs to open child windows,
   * query the window list, or force a repaint.
   * All methods are no-ops if the WM has not been initialised (text mode).
   *
   * Example (app that opens a dialog):
   *   os.wm.openWindow({ title: 'Alert', width: 300, height: 120, app: myDialog });
   */
  wm: {
    /** Returns true when the WM is running (framebuffer / windowed mode). */
    available(): boolean { return wm !== null; },

    /**
     * Open a new window.  Returns the WMWindow or null in text mode.
     * `app` must implement the App interface (onMount, render, onKey, onMouse, …)
     */
    openWindow(opts: {
      title: string;
      app: App;
      width: number;
      height: number;
      x?: number;
      y?: number;
      closeable?: boolean;
    }): WMWindow | null {
      return wm ? wm.createWindow(opts) : null;
    },

    /** Close a window by its id (triggers app.onUnmount). */
    closeWindow(id: number): void { if (wm) wm.closeWindow(id); },

    /** Move keyboard focus to a window. */
    focus(id: number): void { if (wm) wm.focusWindow(id); },

    /** Return a snapshot of all open windows. */
    getWindows(): WMWindow[] { return wm ? wm.getWindows() : []; },

    /** Return the currently focused window, or null. */
    getFocused(): WMWindow | null { return wm ? wm.getFocused() : null; },

    /** Signal the compositor that something changed; force a full redraw. */
    markDirty(): void { if (wm) wm.markDirty(); },

    /** Screen dimensions (0 × 0 in text mode). */
    screenWidth():  number { return wm ? wm.screenWidth  : 0; },
    screenHeight(): number { return wm ? wm.screenHeight : 0; },
  },

};

export default sdk;

/** Convenience alias — import as `os` for the most natural code style. */
export const os = sdk;
