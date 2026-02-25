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
import { scheduler, type ProcessContext } from '../process/scheduler.js';
import { SIG } from '../process/signals.js';
import {
  dnsResolveCached,
  dnsSendQueryAsync,
  dnsPollReplyAsync,
  dnsCancelAsync,
} from '../net/dns.js';
import { parseHttpResponse } from '../net/http.js';
import { JSProcess, listProcesses } from '../process/jsprocess.js';
import { ipc, Pipe } from '../ipc/ipc.js';
import { users } from '../users/users.js';
import { wm, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../ui/wm.js';
import { Canvas } from '../ui/canvas.js';
import { Mutex, Condvar, Semaphore } from '../process/sync.js';
import {
  sha256 as _sha256Raw,
  hmacSha256 as _hmacSha256Raw,
  gcmEncrypt as _gcmEncrypt,
  gcmDecrypt as _gcmDecrypt,
  byteToHex as _byteToHex,
} from '../net/crypto.js';
import type { User, Group } from '../users/users.js';
export { Canvas, Colors, defaultFont, type PixelColor } from '../ui/canvas.js';
export type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';
export { JSProcess } from '../process/jsprocess.js';
export { Mutex, Condvar, Semaphore } from '../process/sync.js';
export type { User, Group } from '../users/users.js';
export { Pipe } from '../ipc/ipc.js';

declare var kernel: import('./kernel.js').KernelAPI;

// ── Public types ──────────────────────────────────────────────────────────────

export interface FetchOptions {
  method?:       'GET' | 'POST';
  headers?:      Record<string, string>;
  body?:         string | number[];
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
      var _rawBody = f.opts.body;
      var bodyStr = _rawBody
        ? (typeof _rawBody === 'string'
          ? _rawBody
          : (function(b: number[]){ var s=''; for(var _i=0;_i<b.length;_i++) s+=String.fromCharCode(b[_i]); return s; })(_rawBody as number[]))
        : '';
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

// ── Module-level state (timer, env, events) ─────────────────────────────────

interface _TimerEntry {
  id:       number;
  fn:       () => void;
  deadline: number;
  interval: number;
  active:   boolean;
}
var _timers: _TimerEntry[] = [];
var _nextTimerId = 1;
var _timerPumpId = -1;

function _startTimerPump(): void {
  if (_timerPumpId !== -1) return;
  _timerPumpId = threadManager.runCoroutine('sdk:timer-pump', function(): 'done' | 'pending' {
    var now = kernel.getUptime();
    for (var _ti = 0; _ti < _timers.length; _ti++) {
      var _t = _timers[_ti];
      if (!_t.active) continue;
      if (now >= _t.deadline) {
        try { _t.fn(); } catch (_e) {}
        if (_t.interval > 0) {
          _t.deadline = now + _t.interval;
        } else {
          _t.active = false;
        }
      }
    }
    if (_timers.length > 200) {
      _timers = _timers.filter(function(x) { return x.active; });
    }
    return 'pending';
  });
}

var _envMap: Map<string, string> | null = null;

function _getEnvMap(): Map<string, string> {
  if (_envMap) return _envMap;
  _envMap = new Map<string, string>();
  _envMap.set('PATH',     '/bin:/usr/bin');
  _envMap.set('HOME',     '/home/user');
  _envMap.set('USER',     'root');
  _envMap.set('TERM',     'jsos-vga');
  _envMap.set('EDITOR',   'edit');
  _envMap.set('SHELL',    '/bin/repl');
  _envMap.set('HOSTNAME', fs.readFile('/etc/hostname') || 'jsos');
  var envFile = fs.readFile('/etc/environment');
  if (envFile) {
    var lines = envFile.split('\n');
    for (var _ei = 0; _ei < lines.length; _ei++) {
      var _line = lines[_ei].trim();
      if (!_line || _line.startsWith('#')) continue;
      var _idx = _line.indexOf('=');
      if (_idx > 0) _envMap.set(_line.slice(0, _idx).trim(), _line.slice(_idx + 1).trim());
    }
  }
  return _envMap;
}

var _evtListeners: Map<string, Array<(data: any) => void>> = new Map();

function _sdkStrToBytes(s: string): number[] {
  var out: number[] = new Array(s.length);
  for (var _si = 0; _si < s.length; _si++) out[_si] = s.charCodeAt(_si) & 0xff;
  return out;
}

function _sdkBytesToHex(bytes: number[]): string {
  var hex = '';
  for (var _hi = 0; _hi < bytes.length; _hi++) hex += _byteToHex(bytes[_hi]);
  return hex;
}

function _fsRmrf(path: string): boolean {
  if (fs.isFile(path)) return fs.rm(path);
  var _entries = fs.ls(path);
  if (_entries) {
    for (var _ri = 0; _ri < _entries.length; _ri++) {
      var _child = path.replace(/\/$/, '') + '/' + (_entries[_ri] as any).name;
      _fsRmrf(_child);
    }
  }
  return fs.rm(path);
}

var _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function _base64Encode(bytes: number[]): string {
  var out = '';
  var _i = 0;
  while (_i < bytes.length) {
    var b0 = bytes[_i++];
    var b1 = _i < bytes.length ? bytes[_i++] : 0;
    var b2 = _i < bytes.length ? bytes[_i++] : 0;
    out += _B64[b0 >> 2] + _B64[((b0 & 3) << 4) | (b1 >> 4)] +
           _B64[((b1 & 0xf) << 2) | (b2 >> 6)] + _B64[b2 & 0x3f];
  }
  var pad = bytes.length % 3;
  if (pad === 1) out = out.slice(0, -2) + '==';
  else if (pad === 2) out = out.slice(0, -1) + '=';
  return out;
}

function _base64Decode(b64: string): number[] {
  var _lookup: number[] = [];
  for (var _k0 = 0; _k0 < 256; _k0++) _lookup[_k0] = 0;
  for (var _k = 0; _k < _B64.length; _k++) _lookup[_B64.charCodeAt(_k)] = _k;
  var _out: number[] = [];
  for (var _bi = 0; _bi + 3 < b64.length; _bi += 4) {
    var c0 = _lookup[b64.charCodeAt(_bi)];
    var c1 = _lookup[b64.charCodeAt(_bi + 1)];
    var c2 = b64[_bi + 2] === '=' ? 0 : _lookup[b64.charCodeAt(_bi + 2)];
    var c3 = b64[_bi + 3] === '=' ? 0 : _lookup[b64.charCodeAt(_bi + 3)];
    _out.push((c0 << 2) | (c1 >> 4));
    if (b64[_bi + 2] !== '=') _out.push(((c1 & 0xf) << 4) | (c2 >> 2));
    if (b64[_bi + 3] !== '=') _out.push(((c2 & 3) << 6) | c3);
  }
  return _out;
}

// ── Module-level state: notifications, app registry, persistent disk ──────────

interface _NotifEntry { id: number; message: string; level: string; until: number; active: boolean; }
var _notifications: _NotifEntry[] = [];
var _nextNotifId   = 1;

/** Fire an event directly into the listener map without going through sdk.events. */
function _emitEvent(event: string, data?: any): void {
  var list = _evtListeners.get(event);
  if (!list) return;
  var copy = list.slice();
  for (var _xi = 0; _xi < copy.length; _xi++) { try { copy[_xi](data); } catch (_e) {} }
}

function _notify(message: string, opts?: { level?: 'info'|'success'|'warn'|'error'; durationMs?: number }): number {
  var id  = _nextNotifId++;
  var dur = (opts && opts.durationMs !== undefined) ? opts.durationMs : 3000;
  var lvl: string = (opts && opts.level) ? opts.level : 'info';
  _notifications.push({ id, message, level: lvl, until: kernel.getUptime() + dur, active: true });
  _emitEvent('notify:show', { id, message, level: lvl });
  if (!wm) { (globalThis as any).print('[' + lvl.toUpperCase() + '] ' + message); }
  _startTimerPump();
  _timers.push({ id: _nextTimerId++, fn: function() { _notifyDismiss(id); }, deadline: kernel.getUptime() + dur, interval: 0, active: true });
  return id;
}

function _notifyDismiss(id: number): void {
  for (var _nd = 0; _nd < _notifications.length; _nd++) {
    if (_notifications[_nd].id === id) { _notifications[_nd].active = false; _emitEvent('notify:dismiss', { id }); return; }
  }
}

function _notifyDismissAll(): void {
  for (var _na = 0; _na < _notifications.length; _na++) _notifications[_na].active = false;
  _emitEvent('notify:dismissAll', {});
}

export interface AppManifest {
  name:        string;
  displayName: string;
  category?:   'system' | 'utility' | 'game' | 'other';
  minWidth?:   number;
  minHeight?:  number;
  icon?:       string;
}

interface _AppEntry { manifest: AppManifest; factory: (args?: string[]) => App; }
var _appRegistry = new Map<string, _AppEntry>();

function _sdkPrint(text: string): void {
  (globalThis as any).print(text);
}

// Single disk-storage object — exposed as both os.fs.disk and os.disk (compat alias)
var _diskStorage = {
  /** Returns true when a FAT disk driver has been mounted. */
  available(): boolean { return !!(globalThis as any)._diskFS; },
  /** Read a file from persistent disk.  Returns null if unavailable or not found. */
  read(path: string): string | null {
    var d = (globalThis as any)._diskFS; return d ? d.read(path) : null;
  },
  /** Write (create or overwrite) a file on disk.  Returns false if unavailable. */
  write(path: string, data: string): boolean {
    var d = (globalThis as any)._diskFS; return d ? !!d.writeFile(path, data) : false;
  },
  /** List disk directory entries.  Returns [] if unavailable. */
  list(path?: string): Array<{ name: string; type: 'file' | 'dir'; size: number }> {
    var d = (globalThis as any)._diskFS; return d ? (d.list(path || '/') ?? []) : [];
  },
  /** Create a directory on disk. */
  mkdir(path: string): boolean {
    var d = (globalThis as any)._diskFS; return d ? !!d.mkdir(path) : false;
  },
  /** Check whether a path exists on disk. */
  exists(path: string): boolean {
    var d = (globalThis as any)._diskFS; return d ? !!d.exists(path) : false;
  },
  /** Remove a file or empty directory from disk. */
  rm(path: string): boolean {
    var d = (globalThis as any)._diskFS; return d ? !!d.remove(path) : false;
  },
};

// ── Modal dialog helpers ──────────────────────────────────────────────────────

function _dlgAlert(message: string, title: string): void {
  if (!wm) { (globalThis as any).print('[ALERT] ' + title + ': ' + message); return; }
  var _closed = false;
  var _winId  = -1;
  var _close  = function(): void { if (_closed) return; _closed = true; if (wm && _winId >= 0) wm.closeWindow(_winId); };
  var _dlg: App = {
    name: 'alert-dlg',
    onMount(win: WMWindow):  void { _winId = win.id; },
    onUnmount():             void {},
    onKey(e: KeyEvent):      void { if (e.key === 'Enter' || e.key === 'Escape') _close(); },
    onMouse(_e: MouseEvent): void {},
    render(canvas: Canvas):  boolean {
      canvas.clear(0xFF1E1E2E);
      canvas.drawText(12, 14, message, 0xFFCDD6F4);
      var lbl = '  OK  ';
      var ox = (canvas.width - lbl.length * 8) >> 1;
      canvas.fillRect(ox - 4, canvas.height - 25, lbl.length * 8 + 8, 18, 0xFF313244);
      canvas.drawText(ox, canvas.height - 21, lbl, 0xFF89B4FA);
      return true;
    },
  };
  wm.createWindow({ title, app: _dlg, width: Math.max(220, message.length * 8 + 24), height: 75, closeable: false });
}

function _dlgConfirm(message: string, title: string, okLabel: string, cancelLabel: string, cb: (ok: boolean) => void): void {
  if (!wm) { (globalThis as any).print('[CONFIRM] ' + title + ': ' + message + ' → false'); cb(false); return; }
  var _closed = false;
  var _winId  = -1;
  var _dlgW   = 0;
  var _dlgH   = 0;
  var _close  = function(result: boolean): void { if (_closed) return; _closed = true; if (wm && _winId >= 0) wm.closeWindow(_winId); cb(result); };
  var _dlg: App = {
    name: 'confirm-dlg',
    onMount(win: WMWindow):  void { _winId = win.id; },
    onUnmount():             void {},
    onKey(e: KeyEvent):      void { if (e.key === 'Enter') _close(true); if (e.key === 'Escape') _close(false); },
    onMouse(e: MouseEvent):  void {
      if ((e.type !== 'down' && e.type !== 'click') || e.y < _dlgH - 28) return;
      _close(e.x < (_dlgW >> 1));
    },
    render(canvas: Canvas):  boolean {
      _dlgW = canvas.width; _dlgH = canvas.height;
      canvas.clear(0xFF1E1E2E);
      canvas.drawText(12, 14, message, 0xFFCDD6F4);
      canvas.drawText(12, _dlgH - 21, okLabel, 0xFF89B4FA);
      canvas.drawText(_dlgW - cancelLabel.length * 8 - 12, _dlgH - 21, cancelLabel, 0xFFF38BA8);
      return true;
    },
  };
  wm.createWindow({ title, app: _dlg, width: Math.max(220, message.length * 8 + 24), height: 75, closeable: false });
}

function _dlgPrompt(question: string, title: string, defaultValue: string, cb: (value: string | null) => void): void {
  if (!wm) { (globalThis as any).print('[PROMPT] ' + title + ': ' + question); cb(null); return; }
  var _closed = false;
  var _winId  = -1;
  var _input  = defaultValue;
  var _cursor = defaultValue.length;
  var _dlgW   = 0;
  var _dlgH   = 0;
  var _close  = function(v: string | null): void { if (_closed) return; _closed = true; if (wm && _winId >= 0) wm.closeWindow(_winId); cb(v); };
  var _dlg: App = {
    name: 'prompt-dlg',
    onMount(win: WMWindow):  void { _winId = win.id; },
    onUnmount():             void {},
    onKey(e: KeyEvent):      void {
      if (e.key === 'Enter')     { _close(_input); return; }
      if (e.key === 'Escape')    { _close(null);   return; }
      if (e.key === 'Backspace') {
        if (_cursor > 0) { _input = _input.slice(0, _cursor - 1) + _input.slice(_cursor); _cursor--; if (wm) wm.markDirty(); }
        return;
      }
      if (e.key === 'ArrowLeft')  { if (_cursor > 0)              _cursor--; if (wm) wm.markDirty(); return; }
      if (e.key === 'ArrowRight') { if (_cursor < _input.length)  _cursor++; if (wm) wm.markDirty(); return; }
      if (e.key.length === 1) { _input = _input.slice(0, _cursor) + e.key + _input.slice(_cursor); _cursor++; if (wm) wm.markDirty(); }
    },
    onMouse(e: MouseEvent):  void {
      if ((e.type !== 'down' && e.type !== 'click') || e.y < _dlgH - 28) return;
      _close(e.x < (_dlgW >> 1) ? _input : null);
    },
    render(canvas: Canvas):  boolean {
      _dlgW = canvas.width; _dlgH = canvas.height;
      canvas.clear(0xFF1E1E2E);
      canvas.drawText(12, 10, question, 0xFF89DCEB);
      canvas.fillRect(10, 27, _dlgW - 20, 18, 0xFF313244);
      canvas.drawText(12, 31, _input, 0xFFCDD6F4);
      canvas.fillRect(12 + _cursor * 8, 28, 1, 16, 0xFFCDD6F4);
      canvas.drawText(12,                  _dlgH - 21, 'OK',     0xFF89B4FA);
      canvas.drawText(_dlgW - 12 - 6 * 8, _dlgH - 21, 'Cancel', 0xFFF38BA8);
      return true;
    },
  };
  wm.createWindow({ title, app: _dlg, width: 300, height: 95, closeable: false });
}

// ── Internal fetch function ───────────────────────────────────────────────────

function _doFetch(
  url: string,
  callback: (resp: FetchResponse | null, error?: string) => void,
  opts?: FetchOptions,
): number {
  var o      = opts || {};
  var parsed = _parseURL(url);
  if (!parsed) {
    var _deferCoroId = threadManager.runCoroutine('fetch-err', function() {
      callback(null, 'Invalid URL: ' + url);
      return 'done';
    });
    return _deferCoroId;
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
        var entries = fs.ls(path);
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
      try { return fs.ls(path) != null; } catch (_e) { return false; }
    },
    /** Current working directory. */
    cwd(): string {
      return fs.cwd();
    },
    /** Change directory. Returns false if path not found. */
    cd(path: string): boolean {
      return fs.cd(path);
    },
    /** Remove a file or empty directory. */
    rm(path: string): boolean {
      return fs.rm(path);
    },
    /** Recursively remove a path (file or non-empty directory). */
    rmrf(path: string): boolean {
      return _fsRmrf(path);
    },
    /** Append data to a file (creates it if absent). */
    append(path: string, data: string): boolean {
      return fs.appendFile(path, data);
    },
    /** Rename / move a file or directory. */
    rename(from: string, to: string): boolean {
      return fs.mv(from, to);
    },
    /** Copy a file (not recursive). */
    copy(src: string, dst: string): boolean {
      return fs.cp(src, dst);
    },
    /** Stat a path.  Returns null if not found. */
    stat(path: string): { size: number; isDir: boolean; created: number; mtime: number; permissions: string } | null {
      var s = fs.stat(path);
      if (!s) return null;
      return { size: s.size, isDir: (s.type as any) === 'directory', created: s.created, mtime: s.modified, permissions: s.permissions };
    },
    /** Returns true if path exists and is a regular file. */
    isFile(path: string): boolean {
      return fs.isFile(path);
    },
    /** Returns true if path exists and is a directory. */
    isDir(path: string): boolean {
      return fs.isDirectory(path);
    },
    /** Glob-style recursive search using * as wildcard. */
    find(basePath: string, pattern: string): string[] {
      return fs.find(basePath, pattern);
    },
    /** Resolve a path against the current working directory. */
    resolve(path: string): string {
      return fs.resolvePath(path);
    },
    /** Read a file as an array of lines.  Returns null if file not found. */
    readLines(path: string): string[] | null {
      var t = fs.readFile(path);
      return t !== null ? t.split('\n') : null;
    },
    /** Write an array of lines joined with '\n'. */
    writeLines(path: string, lines: string[]): boolean {
      return fs.writeFile(path, lines.join('\n'));
    },
    /** Read and JSON.parse a file.  Returns null on missing file or parse error. */
    readJSON<T = unknown>(path: string): T | null {
      try {
        var t = fs.readFile(path);
        return t ? JSON.parse(t) as T : null;
      } catch (_e) { return null; }
    },
    /** JSON.stringify and write a file. Pass pretty=true for 2-space indentation. */
    writeJSON(path: string, value: unknown, pretty?: boolean): boolean {
      return fs.writeFile(path, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
    },

    /**
     * Persistent FAT32/FAT16 disk storage.
     * Only available when a block device is present.
     * Check os.fs.disk.available() before calling other disk methods.
     * In-memory VFS and disk are separate — use os.fs.disk for data
     * that must survive a reboot.
     */
    disk: _diskStorage,

    // ── Backward-compat aliases for existing apps ──────────────────────────
    /** @deprecated Use os.fs.list() instead. */
    readdir(path: string): string[] { return sdk.fs.list(path); },
    /** @deprecated Use os.fs.isDir() instead. */
    isDirectory(path: string): boolean { return sdk.fs.isDir(path); },
  },

  // ── Network ─────────────────────────────────────────────────────────────────

  /**
   * Networking — HTTP/HTTPS fetch and IP info.
   *
   * Example:
   *   var id = os.net.fetch('https://example.com', function(resp, err) {
   *     if (err) return;
   *     os.print(resp.bodyText);
   *   });
   *   // abort: os.process.cancel(id);
   */
  net: {
    /**
     * Non-blocking HTTP/HTTPS fetch, driven by the WM scheduler (~16 ms/step).
     * Returns a coroutine id — pass to os.process.cancel() to abort.
     */
    fetch(
      url: string,
      callback: (resp: FetchResponse | null, error?: string) => void,
      opts?: FetchOptions,
    ): number {
      return _doFetch(url, callback, opts);
    },
    /** DHCP-assigned IP address, or null if the network is not up. */
    getIP(): string | null {
      try { return (net as any).getLocalIP ? (net as any).getLocalIP() : null; } catch (_e) { return null; }
    },
  },

  // ── Output ──────────────────────────────────────────────────────────────────

  /**
   * Write a line to the active output.
   * Text mode: terminal.  WM mode: system debug console.
   * Prefer this over bare print() for portability.
   */
  print(text: string): void {
    _sdkPrint(text);
  },

  // ── System information ───────────────────────────────────────────────────────

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
      return scheduler.getpid();
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
    /** Screen width in pixels (0 in text mode). Use os.wm.screenWidth for WM-specific code. */
    screenWidth():  number { return wm ? wm.screenWidth  : 0; },
    /** Screen height in pixels (0 in text mode). Use os.wm.screenHeight for WM-specific code. */
    screenHeight(): number { return wm ? wm.screenHeight : 0; },
  },

  // ── Multi-process ────────────────────────────────────────────────────────────

  /**
   * Process management — spawn child runtimes, signal, cancel coroutines.
   *
   * Example:
   *   var p = os.process.spawn('function step() { kernel.postMessage(String(++n)); }', 'worker');
   *   p.eval('var n=0');
   *   p.eval('step()');
   *   p.recv(); // → '1'
   */
  process: {
    /** Spawn a new isolated QuickJS runtime. */
    spawn(code: string, name?: string): JSProcess {
      return JSProcess.spawn(code, name);
    },
    /** List all live C-level child process slots. */
    list(): Array<{ id: number; inboxCount: number; outboxCount: number }> {
      return listProcesses();
    },
    /** All OS-level processes known to the scheduler (like `ps aux`). */
    all(): ProcessContext[] {
      return scheduler.getLiveProcesses();
    },
    /** Send a POSIX signal to a process.  Example: os.process.kill(5, os.process.SIG.SIGTERM). */
    kill(pid: number, sig: number): boolean {
      return processManager.kill(pid, sig);
    },
    /** POSIX signal number constants. */
    SIG,
    /**
     * Cancel a running coroutine or in-flight os.net.fetch by id.
     * Safe to call even if the coroutine has already finished.
     */
    cancel(coroId: number): void {
      threadManager.cancelCoroutine(coroId);
    },
    /**
     * Register a named cooperative coroutine.
     * step() is called once per WM frame (~16 ms).  Return 'done' to stop.
     * Returns an id for os.process.cancel().
     */
    coroutine(name: string, step: () => 'done' | 'pending'): number {
      return threadManager.runCoroutine(name, step);
    },
    /**
     * Zero-copy shared memory between parent and a child JSProcess.
     * Eliminates JSON serialisation for large data transfers.
     */
    sharedBuffer: {
      /** Allocate bytes of shared memory. Returns a buffer id. */
      create(bytes: number): number {
        return (kernel as any).sharedBufferCreate ? (kernel as any).sharedBufferCreate(bytes) : -1;
      },
      /** Map a shared buffer into the current JS runtime by id. */
      open(id: number): ArrayBuffer | null {
        return (kernel as any).sharedBufferOpen ? (kernel as any).sharedBufferOpen(id) : null;
      },
    },
  },

  // ── IPC ──────────────────────────────────────────────────────────────────────

  /**
   * Inter-process communication: pipes, signals, typed message queues.
   *
   * Example (pipe):
   *   var [r, w] = os.ipc.pipe();
   *   w.write('hello');
   *   r.read(); // → 'hello'
   *
   * Example (signals):
   *   os.ipc.signal.on('SIGTERM', function() { cleanup(); });
   *
   * Example (messages):
   *   os.ipc.message.subscribe();
   *   os.ipc.message.send(0, 'ping', { ts: os.system.uptime() }); // broadcast
   *   var msg = os.ipc.message.recv('ping'); // → { type, from, payload }
   */
  ipc: {
    /** Create a pipe.  Both ends of the returned pair are the same buffer. */
    pipe(): [Pipe, Pipe] { return ipc.pipe(); },
    /** Create a bidirectional FIFO (single Pipe object for both ends). */
    fifo(): Pipe { return ipc.fifo(); },
    /** Look up a pipe by its file descriptor number. */
    getPipe(fd: number): Pipe | null { return ipc.getPipe(fd); },
    /** Close one end of a pipe by its file descriptor. */
    closePipe(fd: number): void { ipc.closePipe(fd); },

    /** Signal handling for the current process. */
    signal: {
      /** Register a handler for a named signal on the current process. */
      on(sigName: string, handler: (sig: number) => void): void {
        var num = (SIG as any)[sigName];
        if (num !== undefined) ipc.signals.handle(scheduler.getpid(), num, handler);
      },
      /** Remove a registered signal handler from the current process. */
      off(sigName: string): void {
        var num = (SIG as any)[sigName];
        if (num !== undefined) ipc.signals.ignore(scheduler.getpid(), num);
      },
      /** Send a named signal to another process by PID. */
      send(pid: number, sigName: string): void {
        var num = (SIG as any)[sigName];
        if (num !== undefined) ipc.signals.send(pid, num);
      },
      /** Dequeue all pending (unhandled) signals for the current process. */
      poll(): number[] {
        return ipc.signals.poll(scheduler.getpid());
      },
    },

    /** Typed message passing between processes. */
    message: {
      /** Send a typed message to a process (toPid=0 = broadcast). */
      send(toPid: number, type: string, payload: unknown): void {
        ipc.mq.send({ type, from: scheduler.getpid(), to: toPid, payload });
      },
      /** Receive the next message for the current process, optionally filtered by type. */
      recv(type?: string): { type: string; from: number; payload: unknown } | null {
        var m = ipc.mq.recv(scheduler.getpid(), type);
        return m ? { type: m.type, from: m.from, payload: m.payload } : null;
      },
      /** Count pending messages for the current process. */
      available(type?: string): number {
        return ipc.mq.available(scheduler.getpid(), type);
      },
      /** Subscribe to broadcast (toPid=0) messages. */
      subscribe(): void { ipc.mq.subscribe(scheduler.getpid()); },
      /** Unsubscribe from broadcasts and clear the message queue. */
      unsubscribe(): void { ipc.mq.unsubscribe(scheduler.getpid()); },
    },

    /** Send SIGINT (Ctrl+C) to a process. */
    interrupt(pid: number): void { ipc.interrupt(pid); },
    /** Send SIGTERM to a process. */
    terminate(pid: number): void { ipc.terminate(pid); },
  },

  // ── User accounts ────────────────────────────────────────────────────────────

  /**
   * User account management and authentication.
   *
   * Example:
   *   os.users.login('user', '');
   *   os.users.whoami()?.name;   // → 'user'
   *   os.users.isRoot();         // → false
   */
  users: {
    /** Returns the currently logged-in user. */
    whoami(): User | null { return users.getCurrentUser(); },
    /** Log in as user (returns false on bad password). */
    login(name: string, pw: string): boolean { return users.login(name, pw); },
    /** Log out and return to the root session. */
    logout(): void { users.logout(); },
    /** Switch user context (root only, or matching credentials). */
    su(nameOrUid: string | number): boolean { return users.su(nameOrUid); },
    /** Returns true when current user is root (uid 0). */
    isRoot(): boolean { return users.isRoot(); },
    /** List all non-system user accounts. */
    list(): User[] { return users.listUsers(); },
    /** List all groups. */
    listGroups(): Group[] { return users.listGroups(); },
    /** Look up a user by name or uid. */
    getUser(nameOrUid: string | number): User | null { return users.getUser(nameOrUid); },
    /** Look up a group by name or gid. */
    getGroup(nameOrGid: string | number): Group | null { return users.getGroup(nameOrGid); },
    /** Get all groups a user belongs to. */
    getGroupsForUser(name: string): Group[] { return users.getGroupsForUser(name); },
    /** Add a new user account.  Requires root. Returns null on failure. */
    addUser(name: string, pw: string, opts?: { displayName?: string; home?: string; shell?: string; uid?: number; gid?: number }): User | null {
      return users.addUser(name, pw, opts);
    },
    /** Remove a user account.  Requires root. Cannot remove root. */
    removeUser(name: string): boolean { return users.removeUser(name); },
    /** Change a user's password. */
    passwd(name: string, newPw: string): boolean { return users.passwd(name, newPw); },
    /** Format user/group identity as a string (like `id`). */
    idString(user?: User): string { return users.idString(user); },
  },

  // ── Clipboard ────────────────────────────────────────────────────────────────

  /**
   * System clipboard backed by the WM.  No-op in text mode.
   *
   * Example:
   *   os.clipboard.write('hello');
   *   os.clipboard.read(); // → 'hello'
   */
  clipboard: {
    /** Read the current clipboard text. */
    read(): string { return wm ? wm.getClipboard() : ''; },
    /** Write text to the clipboard. */
    write(text: string): void { if (wm) wm.setClipboard(text); },
  },

  // ── Window Manager ───────────────────────────────────────────────────────────

  /**
   * Window manager API.  All methods are no-ops when the WM is not running
   * (text mode).  Check os.wm.available() first if in doubt.
   *
   * Example:
   *   var win = os.wm.openWindow({ title: 'Demo', app: myApp, width: 400, height: 300 });
   */
  wm: {
    /** Returns true when the WM is running (framebuffer mode). */
    available(): boolean { return wm !== null; },

    /** Open a new window.  Returns the WMWindow or null in text mode. */
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

    /** Close a window by id (triggers app.onUnmount). */
    closeWindow(id: number): void { if (wm) wm.closeWindow(id); },
    /** Move keyboard focus to a window. */
    focus(id: number): void { if (wm) wm.focusWindow(id); },
    /** Snapshot of all open windows. */
    getWindows(): WMWindow[] { return wm ? wm.getWindows() : []; },
    /** The currently focused window, or null. */
    getFocused(): WMWindow | null { return wm ? wm.getFocused() : null; },
    /** Force a full compositor redraw. */
    markDirty(): void { if (wm) wm.markDirty(); },
    /** Screen width in pixels (0 in text mode). */
    screenWidth():  number { return wm ? wm.screenWidth  : 0; },
    /** Screen height in pixels (0 in text mode). */
    screenHeight(): number { return wm ? wm.screenHeight : 0; },

    /** Update a window's title bar text. */
    setTitle(id: number, title: string): void { if (wm) wm.setTitle(id, title); },
    /** Minimize a window to the taskbar. */
    minimize(id: number): void { if (wm) wm.minimiseWindow(id); },
    /** Restore a minimized window to its normal state. */
    restore(id: number): void { if (wm) wm.restoreWindow(id); },
    /** Maximize / restore a window (toggle). */
    maximize(id: number): void { if (wm) wm.maximiseWindow(id); },
    /** Returns 'normal', 'minimized', 'maximized', or null if window not found. */
    getState(id: number): 'normal' | 'minimized' | 'maximized' | null {
      if (!wm) return null;
      var wins = wm.getWindows();
      for (var _wi = 0; _wi < wins.length; _wi++) {
        var _w = wins[_wi];
        if (_w.id === id) return _w.minimised ? 'minimized' : _w.maximised ? 'maximized' : 'normal';
      }
      return null;
    },

    /**
     * Modal dialogs.  Callbacks are called when the dialog closes.
     * In text mode, dialogs fall back to print() with a default response.
     *
     * Example:
     *   os.wm.dialog.confirm('Delete file?', function(ok) { if (ok) doDelete(); });
     */
    dialog: {
      /** Show an informational alert with an OK button. */
      alert(message: string, opts?: { title?: string }): void {
        _dlgAlert(message, (opts && opts.title) ? opts.title : 'Alert');
      },
      /** Show a confirm dialog.  callback receives true (OK) or false (Cancel). */
      confirm(message: string, callback: (ok: boolean) => void, opts?: { title?: string; okLabel?: string; cancelLabel?: string }): void {
        _dlgConfirm(
          message,
          (opts && opts.title)       ? opts.title       : 'Confirm',
          (opts && opts.okLabel)     ? opts.okLabel     : 'OK',
          (opts && opts.cancelLabel) ? opts.cancelLabel : 'Cancel',
          callback
        );
      },
      /** Show a text-input prompt.  callback receives the string or null on Cancel. */
      prompt(question: string, callback: (value: string | null) => void, opts?: { title?: string; defaultValue?: string }): void {
        _dlgPrompt(
          question,
          (opts && opts.title)        ? opts.title        : 'Input',
          (opts && opts.defaultValue) ? opts.defaultValue : '',
          callback
        );
      },
    },
  },

  // ── Notifications ─────────────────────────────────────────────────────────────

  /**
   * Toast notifications.
   * In text mode: prints a prefixed line to the terminal.
   * In WM mode: emits a 'notify:show' event (subscribe with os.events.on).
   *
   * Example:
   *   os.notify('File saved', { level: 'success', durationMs: 2000 });
   *   var unsub = os.events.on('notify:show', function(n) { renderToast(n); });
   */
  notify: Object.assign(
    function notify_fn(message: string, opts?: { level?: 'info'|'success'|'warn'|'error'; durationMs?: number }): number {
      return _notify(message, opts);
    },
    {
      /** Dismiss a notification before it auto-expires. */
      dismiss(id: number): void { _notifyDismiss(id); },
      /** Dismiss all active notifications. */
      dismissAll(): void { _notifyDismissAll(); },
      /** All currently active (not yet dismissed / expired) notifications. */
      getAll(): Array<{ id: number; message: string; level: string; until: number }> {
        return _notifications.filter(function(n) { return n.active; }).map(function(n) {
          return { id: n.id, message: n.message, level: n.level, until: n.until };
        });
      },
    }
  ),

  // ── App registry ──────────────────────────────────────────────────────────────

  /**
   * Register and launch named apps.
   * The shell `open <name>` command uses this registry.
   *
   * Example:
   *   os.apps.register(
   *     { name: 'my-app', displayName: 'My App', minWidth: 400, minHeight: 300 },
   *     function() { return new MyApp(); }
   *   );
   *   os.apps.launch('my-app');
   */
  apps: {
    /** Register an app with its manifest and factory function. */
    register(manifest: AppManifest, factory: (args?: string[]) => App): void {
      _appRegistry.set(manifest.name, { manifest, factory });
    },
    /** Unregister an app. */
    unregister(name: string): void { _appRegistry.delete(name); },
    /** List all registered app manifests. */
    list(): AppManifest[] {
      var out: AppManifest[] = [];
      _appRegistry.forEach(function(e) { out.push(e.manifest); });
      return out;
    },
    /** Returns true if an app with the given name is registered. */
    isRegistered(name: string): boolean { return _appRegistry.has(name); },
    /**
     * Launch a registered app in a new WM window.
     * Returns the WMWindow, or null in text mode or if not registered.
     */
    launch(name: string, args?: string[]): WMWindow | null {
      var entry = _appRegistry.get(name);
      if (!entry) return null;
      var m = entry.manifest;
      return sdk.wm.openWindow({
        title:  m.displayName,
        app:    entry.factory(args),
        width:  m.minWidth  || 400,
        height: m.minHeight || 300,
      });
    },
  },

  // ── Sync primitives ───────────────────────────────────────────────────────────

  /**
   * Cooperative synchronisation primitives.
   * These are NOT preemptive — lock() blocks only in a cooperative scheduler sense.
   *
   * Example:
   *   var mtx = new os.sync.Mutex();
   *   mtx.lock(); doWork(); mtx.unlock();
   */
  sync: { Mutex, Condvar, Semaphore },

  // ── Environment variables ─────────────────────────────────────────────────────

  /**
   * Environment variables.  Initialised from /etc/environment at first access.
   * Standard variables: PATH, HOME, USER, TERM, EDITOR, SHELL, HOSTNAME.
   *
   * Example:
   *   os.env.get('HOME')              // '/home/user'
   *   os.env.expand('$HOME/notes')    // '/home/user/notes'
   */
  env: {
    /** Get an environment variable.  Returns undefined if not set. */
    get(key: string): string | undefined {
      return _getEnvMap().get(key);
    },
    /** Set an environment variable. */
    set(key: string, value: string): void {
      _getEnvMap().set(key, value);
    },
    /** Delete an environment variable. */
    delete(key: string): void {
      _getEnvMap().delete(key);
    },
    /** Return all environment variables as a plain object. */
    all(): Record<string, string> {
      var out: Record<string, string> = {};
      _getEnvMap().forEach(function(v, k) { out[k] = v; });
      return out;
    },
    /** Expand $VAR and ${VAR} references.  Unknown variables expand to ''. */
    expand(template: string): string {
      return template.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        function(_m: string, brace: string, bare: string): string {
          return _getEnvMap().get(brace || bare) || '';
        });
    },
  },

  // ── Path manipulation ─────────────────────────────────────────────────────────

  /**
   * Pure-string path utilities — no filesystem access.
   *
   * Example:
   *   os.path.join('/etc', 'passwd')           // '/etc/passwd'
   *   os.path.dirname('/etc/passwd')           // '/etc'
   *   os.path.basename('/etc/foo.txt', '.txt') // 'foo'
   */
  path: {
    /** Join path segments, handling absolute right-hand operands and ../. */
    join(...parts: string[]): string {
      var out = '';
      for (var _pi = 0; _pi < parts.length; _pi++) {
        var _p = parts[_pi];
        if (!_p) continue;
        if (_p.startsWith('/')) { out = _p; }
        else if (!out) { out = _p; }
        else { out = out.replace(/\/$/, '') + '/' + _p; }
      }
      return sdk.path.normalize(out || '.');
    },
    /** Directory portion of a path. */
    dirname(path: string): string {
      if (path === '/') return '/';
      var s = path.replace(/\/$/, '');
      var idx = s.lastIndexOf('/');
      if (idx < 0)   return '.';
      if (idx === 0) return '/';
      return s.slice(0, idx);
    },
    /** Final path component, optionally with a given extension stripped. */
    basename(path: string, ext?: string): string {
      var s = path.replace(/\/$/, '');
      var idx = s.lastIndexOf('/');
      var base = idx >= 0 ? s.slice(idx + 1) : s;
      if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
      return base;
    },
    /** File extension including the dot, or '' if none. */
    ext(path: string): string {
      var base = sdk.path.basename(path);
      var dot  = base.lastIndexOf('.');
      return dot > 0 ? base.slice(dot) : '';
    },
    /** Returns true if the path starts with '/'. */
    isAbsolute(path: string): boolean {
      return path.startsWith('/');
    },
    /** Resolve parts against a base directory. */
    resolve(base: string, ...parts: string[]): string {
      var all = [base as string].concat(parts as string[]);
      return sdk.path.join.apply(null as any, all as any);
    },
    /** Collapse //, /./, and /../ in a path. */
    normalize(path: string): string {
      if (!path) return '.';
      var isAbs = path.startsWith('/');
      var segs  = path.split('/');
      var out: string[] = [];
      for (var _ni = 0; _ni < segs.length; _ni++) {
        var seg = segs[_ni];
        if (seg === '' || seg === '.') continue;
        if (seg === '..') { if (out.length > 0) out.pop(); }
        else out.push(seg);
      }
      var result = (isAbs ? '/' : '') + out.join('/');
      return result || (isAbs ? '/' : '.');
    },
    /** Compute the relative path from `from` to `to`. */
    relative(from: string, to: string): string {
      var af = sdk.path.normalize(from).split('/').filter(Boolean);
      var at = sdk.path.normalize(to).split('/').filter(Boolean);
      var i = 0;
      while (i < af.length && i < at.length && af[i] === at[i]) i++;
      var up   = af.length - i;
      var down = at.slice(i);
      var rel: string[] = [];
      for (var _ui = 0; _ui < up; _ui++) rel.push('..');
      return rel.concat(down).join('/') || '.';
    },
  },

  // ── Timers ────────────────────────────────────────────────────────────────────

  /**
   * Coroutine-driven timers (~10 ms granularity on bare metal).
   * Always call os.timer.clearAll() in app.onUnmount to prevent leaks.
   *
   * Example:
   *   var id = os.timer.setInterval(function() { repaint(); }, 1000);
   *   // in onUnmount: os.timer.clearAll();
   */
  timer: {
    /** Call fn once after ms milliseconds.  Returns an id for clearTimeout. */
    setTimeout(fn: () => void, ms: number): number {
      _startTimerPump();
      var id = _nextTimerId++;
      _timers.push({ id, fn, deadline: kernel.getUptime() + ms, interval: 0, active: true });
      return id;
    },
    /** Call fn repeatedly every ms milliseconds.  Returns an id for clearInterval. */
    setInterval(fn: () => void, ms: number): number {
      _startTimerPump();
      var id = _nextTimerId++;
      _timers.push({ id, fn, deadline: kernel.getUptime() + ms, interval: ms, active: true });
      return id;
    },
    /** Cancel a one-shot timer. */
    clearTimeout(id: number): void {
      for (var _ci = 0; _ci < _timers.length; _ci++) {
        if (_timers[_ci].id === id) { _timers[_ci].active = false; break; }
      }
    },
    /** Cancel a repeating interval. */
    clearInterval(id: number): void {
      for (var _ci2 = 0; _ci2 < _timers.length; _ci2++) {
        if (_timers[_ci2].id === id) { _timers[_ci2].active = false; break; }
      }
    },
    /** Cancel all pending timers and intervals.  Call this in app.onUnmount. */
    clearAll(): void {
      for (var _ca = 0; _ca < _timers.length; _ca++) _timers[_ca].active = false;
    },
  },

  // ── Event bus ─────────────────────────────────────────────────────────────────

  /**
   * Lightweight pub/sub event bus for app-to-app and system-to-app messaging.
   * Always call the returned unsubscribe function in app.onUnmount.
   *
   * System events: 'system:boot', 'wm:ready', 'wm:window:open', 'wm:window:close',
   *                'disk:mounted', 'net:up', 'net:down', 'user:login', 'user:logout',
   *                'notify:show', 'notify:dismiss', 'theme:change', 'prefs:change'.
   *
   * Example:
   *   var unsub = os.events.on('net:up', function(d) { os.print('IP: ' + d.ip); });
   *   // in onUnmount: unsub();
   */
  events: {
    /** Subscribe to an event.  Returns an unsubscribe function. */
    on<T = unknown>(event: string, handler: (data: T) => void): () => void {
      if (!_evtListeners.has(event)) _evtListeners.set(event, []);
      var list = _evtListeners.get(event)!;
      var h = handler as (data: any) => void;
      list.push(h);
      return function() {
        var idx = list.indexOf(h);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    /** Subscribe once; auto-unsubscribes after the first fire. */
    once<T = unknown>(event: string, handler: (data: T) => void): void {
      var unsub: () => void;
      unsub = sdk.events.on(event, function(data: T) {
        unsub();
        handler(data);
      });
    },
    /** Publish an event to all subscribers. */
    emit<T = unknown>(event: string, data?: T): void {
      _emitEvent(event, data);
    },
    /** Unsubscribe a specific handler from an event. */
    off(event: string, handler: (data: any) => void): void {
      var list = _evtListeners.get(event);
      if (!list) return;
      var idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    },
    /** Number of registered handlers for a given event name. */
    listeners(event: string): number {
      var list = _evtListeners.get(event);
      return list ? list.length : 0;
    },
  },

  // ── Text utilities ────────────────────────────────────────────────────────────

  /**
   * Text encoding, decoding, and formatting helpers.
   *
   * Example:
   *   os.text.encodeBase64('hello')           // 'aGVsbG8='
   *   os.text.format('%s: %d ms', 'boot', 42) // 'boot: 42 ms'
   *   os.text.bytes(1048576)                  // '1.0 MB'
   */
  text: {
    /** Encode a string to Latin-1 bytes. */
    encodeUTF8(str: string): number[] { return _sdkStrToBytes(str); },
    /** Decode bytes to a string. */
    decodeUTF8(bytes: number[]): string {
      var s = '';
      for (var _i = 0; _i < bytes.length; _i++) s += String.fromCharCode(bytes[_i]);
      return s;
    },
    /** Encode a string or byte array to Base64. */
    encodeBase64(data: string | number[]): string {
      return _base64Encode(typeof data === 'string' ? _sdkStrToBytes(data) : data);
    },
    /** Decode a Base64 string to a byte array. */
    decodeBase64(b64: string): number[] { return _base64Decode(b64); },
    /** Encode a string or byte array to lowercase hex. */
    encodeHex(data: string | number[]): string {
      return _sdkBytesToHex(typeof data === 'string' ? _sdkStrToBytes(data) : data);
    },
    /** Decode a hex string to bytes. */
    decodeHex(hex: string): number[] {
      var out: number[] = [];
      for (var _i = 0; _i + 1 < hex.length; _i += 2)
        out.push(parseInt(hex.slice(_i, _i + 2), 16));
      return out;
    },
    /** Percent-encode a string for use in a URL. */
    encodeURL(str: string): string {
      var safe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*\'()';
      var out = '';
      for (var _i = 0; _i < str.length; _i++) {
        var c = str[_i];
        if (safe.indexOf(c) >= 0) { out += c; }
        else { out += '%' + _byteToHex(str.charCodeAt(_i) & 0xff).toUpperCase(); }
      }
      return out;
    },
    /** Decode percent-encoded URL characters. */
    decodeURL(str: string): string {
      return str.replace(/%([0-9A-Fa-f]{2})/g, function(_m: string, hex: string): string {
        return String.fromCharCode(parseInt(hex, 16));
      });
    },
    /**
     * printf-style formatting.  Supports: %s %d %i %f %x %o %b %% and width.precision.
     * Example: os.text.format('%s: %.2f ms', 'load', 3.1415) → 'load: 3.14 ms'
     */
    format(template: string, ...args: unknown[]): string {
      var ai = 0;
      return template.replace(/%(-?\d*)(?:\.(\d+))?([sdifxob%])/g,
        function(_m: string, width: string, prec: string, spec: string): string {
          if (spec === '%') return '%';
          var v = args[ai++];
          var s: string;
          if      (spec === 's') { s = String(v); }
          else if (spec === 'd' || spec === 'i') { s = Math.trunc(Number(v)).toString(10); }
          else if (spec === 'f') { s = prec ? Number(v).toFixed(parseInt(prec)) : String(Number(v)); }
          else if (spec === 'x') { s = (Math.trunc(Number(v)) >>> 0).toString(16); }
          else if (spec === 'o') { s = (Math.trunc(Number(v)) >>> 0).toString(8); }
          else if (spec === 'b') { s = (Math.trunc(Number(v)) >>> 0).toString(2); }
          else { s = String(v); }
          if (width) {
            var w = parseInt(width);
            var pad = Math.abs(w) - s.length;
            if (pad > 0) {
              var padding = '';
              for (var _pi = 0; _pi < pad; _pi++) padding += (w > 0 && spec !== 's') ? '0' : ' ';
              s = w < 0 ? s + padding : padding + s;
            }
          }
          return s;
        });
    },
    /** Pad string `s` to at least `width` characters.  right=true to left-pad. */
    pad(s: string, width: number, char?: string, right?: boolean): string {
      var pc = char || ' ';
      var padding = '';
      for (var _pi = s.length; _pi < width; _pi++) padding += pc;
      return right ? padding + s : s + padding;
    },
    /** Format a byte count as B / KB / MB / GB. */
    bytes(n: number): string {
      if (n < 1024)       return n + ' B';
      if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
      return (n / 1073741824).toFixed(2) + ' GB';
    },
    /** Return `n singular` or `n plurals` based on count. */
    pluralise(n: number, singular: string, plural?: string): string {
      return n + ' ' + (n === 1 ? singular : (plural || singular + 's'));
    },
    /** Truncate a string, appending suffix ('…' by default) if needed. */
    truncate(s: string, maxLen: number, suffix?: string): string {
      var suf = suffix !== undefined ? suffix : '\u2026';
      if (s.length <= maxLen) return s;
      return s.slice(0, maxLen - suf.length) + suf;
    },
    /** Wrap text to `cols` columns, breaking at word boundaries. */
    wrapWords(s: string, cols: number): string[] {
      var lines: string[] = [];
      var words = s.split(' ');
      var cur = '';
      for (var _wi = 0; _wi < words.length; _wi++) {
        var _w = words[_wi];
        if (!cur) { cur = _w; }
        else if (cur.length + 1 + _w.length <= cols) { cur += ' ' + _w; }
        else { lines.push(cur); cur = _w; }
      }
      if (cur) lines.push(cur);
      return lines;
    },
  },

  // ── Cryptography ──────────────────────────────────────────────────────────────

  /**
   * Cryptographic primitives — pure TypeScript, no C required.
   *
   * Example:
   *   os.crypto.sha256('hello')  // '2cf24dba5fb0…'
   *   os.crypto.uuid()           // 'xxxxxxxx-xxxx-4xxx-…'
   */
  crypto: {
    /** SHA-256 hash.  Input may be a string or byte array.  Returns hex. */
    sha256(data: string | number[]): string {
      return _sdkBytesToHex(_sha256Raw(typeof data === 'string' ? _sdkStrToBytes(data) : data));
    },
    /** SHA-256 as a raw 32-byte array. */
    sha256Bytes(data: string | number[]): number[] {
      return _sha256Raw(typeof data === 'string' ? _sdkStrToBytes(data) : data);
    },
    /** HMAC-SHA-256.  key and data may be strings or byte arrays.  Returns hex. */
    hmacSHA256(key: string | number[], data: string | number[]): string {
      var k = typeof key  === 'string' ? _sdkStrToBytes(key)  : key;
      var d = typeof data === 'string' ? _sdkStrToBytes(data) : data;
      return _sdkBytesToHex(_hmacSha256Raw(k, d));
    },
    /** Generate n random bytes (LCG seeded from kernel tick counter). */
    randomBytes(n: number): number[] {
      var out: number[] = [];
      var seed = kernel.getTicks() >>> 0;
      for (var _rb = 0; _rb < n; _rb++) {
        seed = ((seed * 1664525) + 1013904223) >>> 0;
        if ((_rb & 7) === 0) seed ^= (kernel.getTicks() >>> 0);
        out.push(seed & 0xff);
      }
      return out;
    },
    /**
     * AES-128-GCM encrypt.
     * key: 16 bytes, iv: 12 bytes.  Returns ciphertext + 16-byte auth tag.
     */
    aesEncrypt(key: number[], iv: number[], data: number[]): number[] {
      var r = _gcmEncrypt(key, iv, [], data);
      return r.ciphertext.concat(r.tag);
    },
    /**
     * AES-128-GCM decrypt.
     * data: ciphertext + 16-byte auth tag (as returned by aesEncrypt).
     * Returns plaintext, or null if the auth tag is invalid.
     */
    aesDecrypt(key: number[], iv: number[], data: number[]): number[] | null {
      var ciphertext = data.slice(0, data.length - 16);
      var tag        = data.slice(data.length - 16);
      return _gcmDecrypt(key, iv, [], ciphertext, tag);
    },
    /** Generate a random UUID v4 string. */
    uuid(): string {
      var r = sdk.crypto.randomBytes(16);
      r[6] = (r[6] & 0x0f) | 0x40;
      r[8] = (r[8] & 0x3f) | 0x80;
      var h = _sdkBytesToHex(r);
      return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
    },
  },

  // ── Per-app preferences ───────────────────────────────────────────────────────

  /**
   * Per-app persistent preferences stored at /etc/prefs/<appName>.json.
   *
   * Example:
   *   var prefs = os.prefs.forApp('file-manager');
   *   prefs.set('sortOrder', 'name');
   *   prefs.get('sortOrder', 'name'); // → 'name'
   */
  prefs: {
    /** Return a scoped preferences store for the given app name. */
    forApp(appName: string): {
      get<T>(key: string, fallback?: T): T;
      set(key: string, value: unknown): void;
      delete(key: string): void;
      all(): Record<string, unknown>;
      reset(): void;
      flush(): void;
    } {
      var _path  = '/etc/prefs/' + appName + '.json';
      var _cache: Record<string, unknown> | null = null;

      function _load(): Record<string, unknown> {
        if (_cache) return _cache;
        try {
          var txt = fs.readFile(_path);
          _cache = txt ? JSON.parse(txt) : {};
        } catch (_e) { _cache = {}; }
        return _cache!;
      }

      function _save(): void {
        fs.mkdir('/etc/prefs');
        fs.writeFile(_path, JSON.stringify(_load(), null, 2));
      }

      return {
        get<T>(key: string, fallback?: T): T {
          var v = _load()[key];
          return v !== undefined ? v as T : (fallback as T);
        },
        set(key: string, value: unknown): void {
          _load()[key] = value;
          _save();
        },
        delete(key: string): void {
          delete _load()[key];
          _save();
        },
        all(): Record<string, unknown> {
          return Object.assign({}, _load());
        },
        reset(): void {
          _cache = {};
          _save();
        },
        flush(): void {
          _save();
        },
      };
    },
  },

  // ── Backward-compatibility aliases ────────────────────────────────────────────

  /**
   * @deprecated Use os.net.fetch() instead.
   * Kept for backward compatibility with existing apps.
   */
  fetchAsync(
    url: string,
    callback: (resp: FetchResponse | null, error?: string) => void,
    opts?: FetchOptions,
  ): number {
    return _doFetch(url, callback, opts);
  },

  /**
   * @deprecated Use os.process.coroutine() instead.
   * Kept for backward compatibility with existing apps.
   */
  spawn(name: string, step: () => 'done' | 'pending'): number {
    return threadManager.runCoroutine(name, step);
  },

  /**
   * @deprecated Use os.process.cancel() instead.
   * Kept for backward compatibility with existing apps.
   */
  cancel(coroId: number): void {
    threadManager.cancelCoroutine(coroId);
  },

  /**
   * @deprecated Use os.fs.disk instead.
   * Kept for backward compatibility with existing apps.
   */
  disk: _diskStorage,

};

export default sdk;

/** Convenience alias — import as `os` for the most natural code style. */
export const os = sdk;
