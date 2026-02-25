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
export type { App, WMWindow, KeyEvent, MouseEvent, MenuItem } from '../ui/wm.js';
export { JSProcess } from '../process/jsprocess.js';
export { Mutex, Condvar, Semaphore } from '../process/sync.js';
export type { User, Group } from '../users/users.js';
export { Pipe } from '../ipc/ipc.js';
export type { ProcessContext } from '../process/scheduler.js';

// ── SDK-defined public types ──────────────────────────────────────────────────

/**
 * A live TCP connection returned by os.net.connect().
 */
export interface RawSocket {
  readonly id: number;
  readonly connected: boolean;
  /** Send a string or byte array. */
  write(data: string | number[]): void;
  /** Receive buffered data as a string (Latin-1). Returns '' if empty. */
  read(maxBytes?: number): string;
  /** Receive buffered data as bytes. Returns [] if empty. */
  readBytes(maxBytes?: number): number[];
  /** Number of bytes currently in the receive buffer. */
  available(): number;
  /** Close the connection. */
  close(): void;
}

/** A named color theme. See os.theme for usage. */
export interface Theme {
  name:       string;
  bg:         number;   // ARGB — main background
  fg:         number;   // foreground text
  accent:     number;   // primary accent (buttons, focus rings)
  titleBg:    number;   // window title bar background
  titleFg:    number;   // title bar text
  taskbarBg:  number;   // taskbar background
  selBg:      number;   // selection background
  selFg:      number;   // selection foreground
  warnFg:     number;   // warning text
  errorFg:    number;   // error text
  successFg:  number;   // success text
  mutedFg:    number;   // muted/disabled text
  border:     number;   // widget border color
}

/** Fluent drawing surface returned by os.canvas.painter(). */
export interface CanvasPainter {
  readonly canvas: import('../ui/canvas.js').Canvas;
  fill(color: number): void;
  fillRect(x: number, y: number, w: number, h: number, color: number): void;
  strokeRect(x: number, y: number, w: number, h: number, color: number): void;
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  strokeRoundRect(x: number, y: number, w: number, h: number, r: number, color: number): void;
  fillCircle(cx: number, cy: number, r: number, color: number): void;
  strokeCircle(cx: number, cy: number, r: number, color: number): void;
  drawLine(x0: number, y0: number, x1: number, y1: number, color: number): void;
  drawText(x: number, y: number, text: string, color: number): void;
  drawTextWrap(x: number, y: number, maxW: number, text: string, color: number, lineH?: number): number;
  measureText(text: string): { width: number; height: number };
  drawScrollbar(x: number, y: number, h: number, total: number, visible: number, offset: number, color?: number): void;
  drawProgressBar(x: number, y: number, w: number, h: number, fraction: number, fgColor?: number, bgColor?: number): void;
  drawButton(x: number, y: number, w: number, h: number, label: string, pressed?: boolean, fgColor?: number, bgColor?: number): void;
  drawCheckbox(x: number, y: number, checked: boolean, label?: string, color?: number): void;
  linearGradient(x: number, y: number, w: number, h: number, stops: Array<{stop: number; color: number}>, dir?: 'horizontal'|'vertical'|'diagonal'): void;
  radialGradient(cx: number, cy: number, r: number, stops: Array<{stop: number; color: number}>): void;
  drawSprite(x: number, y: number, pixels: number[], pw: number, ph: number, palette: number[], scale?: number): void;
}

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

// ── New module-level state ────────────────────────────────────────────────────

/** Cached CMOS RTC read at first call: Unix epoch ms at that moment. */
var _rtcBootEpoch: number | null = null;
var _rtcBootUptime = 0;

/** Animation registry: id → { cb, duration, startUptime } */
var _animRegistry = new Map<number, { cb: (elapsed: number, total: number) => boolean; duration: number; startUptime: number; coroId: number }>();
var _nextAnimId = 1;

/** Theme registry */
var _themeMap = new Map<string, Theme>();
var _activeThemeName = 'dark';

/** fs.watch registry: path prefix → array of callbacks */
type _WatchCb = (ev: 'change'|'delete'|'create', path: string) => void;
var _fsWatchMap = new Map<string, _WatchCb[]>();
var _fsWatchPatched = false;

/** Raw socket receive buffers: socket.id → { sock, buf } */
var _netSockBufs = new Map<number, { sock: import('../net/net.js').Socket; buf: number[] }>();

// ── Built-in themes ───────────────────────────────────────────────────────────

function _makeTheme(
  name: string, bg: number, fg: number, accent: number,
  titleBg: number, titleFg: number, taskbarBg: number,
  selBg: number, selFg: number,
  warnFg: number, errorFg: number, successFg: number, mutedFg: number, border: number,
): Theme {
  return { name, bg, fg, accent, titleBg, titleFg, taskbarBg,
           selBg, selFg, warnFg, errorFg, successFg, mutedFg, border };
}

_themeMap.set('dark',   _makeTheme('dark',   0xFF1E1E2E, 0xFFDDDDEE, 0xFF2255AA, 0xFF1A3A5C, 0xFFFFFFFF, 0xFF1A2B3C, 0xFF2255AA, 0xFFFFFFFF, 0xFFFFB900, 0xFFFF4444, 0xFF44CC44, 0xFF888899, 0xFF445566));
_themeMap.set('light',  _makeTheme('light',  0xFFF5F5F5, 0xFF222222, 0xFF0078D7, 0xFF0078D7, 0xFFFFFFFF, 0xFFE0E0E0, 0xFF0078D7, 0xFFFFFFFF, 0xFFFFB900, 0xFFCC1111, 0xFF007700, 0xFF888888, 0xFFCCCCCC));
_themeMap.set('hacker', _makeTheme('hacker', 0xFF000000, 0xFF00FF00, 0xFF00CC00, 0xFF001100, 0xFF00FF00, 0xFF000800, 0xFF003300, 0xFF00FF00, 0xFFFFFF00, 0xFFFF0000, 0xFF00FF00, 0xFF005500, 0xFF003300));
_themeMap.set('retro',  _makeTheme('retro',  0xFF0000AA, 0xFFAAAAAA, 0xFFFF5555, 0xFFAA0000, 0xFFFFFFFF, 0xFF000055, 0xFFAA0000, 0xFFFFFFFF, 0xFFFFFF55, 0xFFFF5555, 0xFF55FF55, 0xFF5555AA, 0xFF5555AA));

// ── RTC helpers ───────────────────────────────────────────────────────────────

function _rtcCmosRead(reg: number): number {
  kernel.outb(0x70, reg);
  var v = kernel.inb(0x71);
  return ((v >> 4) * 10) + (v & 0xF); // BCD → decimal
}

function _rtcGetUnixMs(): number {
  // Read CMOS RTC registers
  var sec = _rtcCmosRead(0x00);
  var min = _rtcCmosRead(0x02);
  var hr  = _rtcCmosRead(0x04);
  var day = _rtcCmosRead(0x07);
  var mon = _rtcCmosRead(0x08);
  var yr2 = _rtcCmosRead(0x09);
  var cen = _rtcCmosRead(0x32) || 20; // century register (may be 0)
  var year = cen * 100 + yr2;
  if (year < 2000) year += 2000;
  // Days from 1970-01-01 to this date via a simple formula
  var m = mon, y = year;
  if (m <= 2) { m += 12; y--; }
  var jdn = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day - 1524;
  var epoch1970 = 2440588; // JDN of 1970-01-01
  var daysSinceEpoch = jdn - epoch1970;
  return (daysSinceEpoch * 86400 + hr * 3600 + min * 60 + sec) * 1000;
}

function _sdkTimeNow(): number {
  if (_rtcBootEpoch === null) {
    try {
      _rtcBootEpoch  = _rtcGetUnixMs();
      _rtcBootUptime = kernel.getUptime();
    } catch (_e) {
      // Fallback: treat boot as 2026-01-01T00:00:00Z
      _rtcBootEpoch  = 1735689600000;
      _rtcBootUptime = kernel.getUptime();
    }
  }
  return _rtcBootEpoch + (kernel.getUptime() - _rtcBootUptime);
}

// ── fs.watch patcher ──────────────────────────────────────────────────────────

function _fireWatch(path: string, ev: 'change'|'delete'|'create'): void {
  _fsWatchMap.forEach(function(cbs: _WatchCb[], prefix: string) {
    if (path.startsWith(prefix)) {
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](ev, path); } catch (_e) {} }
    }
  });
}

function _patchFsWatch(): void {
  if (_fsWatchPatched) return;
  _fsWatchPatched = true;
  var origWrite = fs.writeFile.bind(fs);
  var origRm    = fs.rm.bind(fs);
  var origMkdir = fs.mkdir.bind(fs);
  (fs as any).writeFile = function(p: string, d: string) {
    var existed = fs.readFile(p) !== null;
    var r = origWrite(p, d);
    _fireWatch(p, existed ? 'change' : 'create');
    return r;
  };
  (fs as any).rm = function(p: string) {
    var r = origRm(p);
    if (r) _fireWatch(p, 'delete');
    return r;
  };
  (fs as any).mkdir = function(p: string) {
    var r = origMkdir(p);
    if (r) _fireWatch(p, 'create');
    return r;
  };
}

// ── Debug serial helper ───────────────────────────────────────────────────────

function _debugSerial(level: string, args: unknown[]): void {
  var msg = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
  var line = '[' + level + '] ' + msg + '\n';
  for (var _di = 0; _di < line.length; _di++) kernel.serialPut(line.charCodeAt(_di));
  // Also fire event bus so in-process listeners can pick it up
  if ((sdk as any).events) {
    try { sdk.events.emit('debug:event', { level: level.toLowerCase(), msg, ts: _sdkTimeNow() }); } catch (_e) {}
  }
}

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

    /**
     * Watch a path (or prefix) for changes.
     * Returns an unsubscribe function.
     *
     * Example:
     *   var unsub = os.fs.watch('/home', function(ev, path) {
     *     os.print(ev + ': ' + path);
     *   });
     *   // in onUnmount: unsub();
     */
    watch(path: string, callback: (event: 'change'|'delete'|'create', path: string) => void): () => void {
      _patchFsWatch();
      var prefix = path.endsWith('/') ? path : path + '/';
      // Also match exact path
      var key = path;
      if (!_fsWatchMap.has(key)) _fsWatchMap.set(key, []);
      var list = _fsWatchMap.get(key)!;
      list.push(callback);
      return function() {
        var idx = list.indexOf(callback);
        if (idx >= 0) list.splice(idx, 1);
      };
    },

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
    /** Device MAC address, or null if not available. */
    getMACAddress(): string | null {
      try { return (net as any).mac || null; } catch (_e) { return null; }
    },
    /** True when a DHCP lease has been obtained. */
    online(): boolean {
      try { return !!(net as any).leased || !!(net as any).nicReady; } catch (_e) { return false; }
    },
    /**
     * Open a raw TCP connection.  The callback is called with a RawSocket
     * when connected (or null on error).  Returns a coroutine id.
     *
     * Example:
     *   var id = os.net.connect('93.184.216.34', 80, function(sock, err) {
     *     if (!sock) return;
     *     sock.write('GET / HTTP/1.0\r\nHost: example.com\r\n\r\n');
     *     os.timer.setInterval(function() {
     *       var data = sock.read();
     *       if (data) os.print(data);
     *     }, 100);
     *   });
     */
    connect(
      host: string,
      port: number,
      callback: (sock: RawSocket | null, error?: string) => void,
      opts?: { timeoutMs?: number },
    ): number {
      var timeoutTicks = ((opts && opts.timeoutMs) ? opts.timeoutMs : 5000) / 10;
      var netSock: import('../net/net.js').Socket | null = null;
      var done   = false;
      var deadline = kernel.getTicks() + timeoutTicks;
      var resolvedIP: string | null = dnsResolveCached(host);
      if (!resolvedIP && /^\d+\.\d+\.\d+\.\d+$/.test(host)) resolvedIP = host;

      // If DNS needed, start async query
      if (!resolvedIP) {
        var q = dnsSendQueryAsync(host);
        threadManager.runCoroutine('rawsock-dns:' + host, function(): 'done'|'pending' {
          var r = dnsPollReplyAsync(q.port, q.id);
          if (r) { resolvedIP = r; return 'done'; }
          return 'pending';
        });
      }

      var step: () => 'done' | 'pending' = function() {
        if (done) return 'done';
        if (kernel.getTicks() > deadline) {
          done = true;
          try { callback(null, 'timeout'); } catch (_e) {}
          return 'done';
        }
        if (!resolvedIP) return 'pending';

        if (!netSock) {
          netSock = net.createSocket('tcp');
          _netSockBufs.set(netSock.id, { sock: netSock, buf: [] });
          net.connectAsync(netSock, resolvedIP!, port);
          return 'pending';
        }

        var state = net.connectPoll(netSock);
        if (state === 'pending') return 'pending';
        if (state !== 'connected') {
          done = true;
          _netSockBufs.delete(netSock.id);
          try { callback(null, 'connection refused'); } catch (_e) {}
          return 'done';
        }

        done = true;
        var entry = _netSockBufs.get(netSock.id)!;
        var nSock = netSock; // capture
        var _closed = false;
        var sock: RawSocket = {
          get id()        { return nSock.id; },
          get connected() { return !_closed; },
          write(data: string | number[]): void {
            if (_closed) return;
            var bytes: number[];
            if (typeof data === 'string') {
              bytes = [];
              for (var _i = 0; _i < data.length; _i++) bytes.push(data.charCodeAt(_i) & 0xFF);
            } else { bytes = data; }
            net.send(nSock, bytes);
          },
          read(maxBytes?: number): string {
            var bytes = sock.readBytes(maxBytes);
            var s = '';
            for (var _ri = 0; _ri < bytes.length; _ri++) s += String.fromCharCode(bytes[_ri]);
            return s;
          },
          readBytes(maxBytes?: number): number[] {
            if (!_closed) {
              var fresh = net.recvBytesNB(nSock);
              if (fresh && fresh.length > 0) {
                for (var _bi = 0; _bi < fresh.length; _bi++) entry.buf.push(fresh[_bi]);
              }
            }
            if (maxBytes !== undefined && maxBytes < entry.buf.length) {
              return entry.buf.splice(0, maxBytes);
            }
            var out = entry.buf.slice();
            entry.buf.length = 0;
            return out;
          },
          available(): number {
            if (!_closed) {
              var fresh2 = net.recvBytesNB(nSock);
              if (fresh2 && fresh2.length > 0) {
                for (var _bi2 = 0; _bi2 < fresh2.length; _bi2++) entry.buf.push(fresh2[_bi2]);
              }
            }
            return entry.buf.length;
          },
          close(): void {
            if (_closed) return;
            _closed = true;
            net.close(nSock);
            _netSockBufs.delete(nSock.id);
          },
        };
        try { callback(sock); } catch (_e) {}
        return 'done';
      };

      return threadManager.runCoroutine('rawsock:' + host + ':' + port, step);
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

    /** Return the ProcessContext for the current process, or null. */
    current(): ProcessContext | null {
      var pid = scheduler.getpid();
      var live = scheduler.getLiveProcesses();
      for (var _pi = 0; _pi < live.length; _pi++) {
        if (live[_pi].pid === pid) return live[_pi];
      }
      return null;
    },

    /**
     * Wait for a process to finish, then call callback with its exit code.
     * Returns a coroutine id (cancel with os.process.cancel()).
     *
     * Example:
     *   os.process.wait(childPid, function(code) { print('exit ' + code); });
     */
    wait(pid: number, callback: (exitCode: number) => void): number {
      return threadManager.runCoroutine('wait:' + pid, function(): 'done' | 'pending' {
        var live = scheduler.getLiveProcesses();
        for (var _wi = 0; _wi < live.length; _wi++) {
          if (live[_wi].pid === pid) return 'pending';
        }
        try { callback(0); } catch (_e) {}
        return 'done';
      });
    },

    /** Rename the current process (visible in os.process.all()). */
    setName(name: string): void {
      if ((scheduler as any).setProcessName) (scheduler as any).setProcessName(scheduler.getpid(), name);
    },

    /**
     * Set the scheduling priority of the current process.
     * Higher numbers = higher priority (range 0–19, like UNIX nice inverted).
     * No-op on kernels that don't support priorities.
     */
    setPriority(priority: number): void {
      if ((scheduler as any).setPriority) (scheduler as any).setPriority(scheduler.getpid(), priority);
    },

    /**
     * Handle a POSIX signal by number for the current process.
     * Returns an unsubscribe function.
     *
     * Example:
     *   var unsub = os.process.onSignal(os.process.SIG.SIGTERM, cleanup);
     *   // Later: unsub();
     */
    onSignal(sig: number, handler: () => void): () => void {
      var pid = scheduler.getpid();
      ipc.signals.handle(pid, sig, handler);
      return function() { ipc.signals.ignore(pid, sig); };
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

    /** Move a window to absolute screen coordinates. */
    move(id: number, x: number, y: number): void { if (wm) wm.moveWindow(id, x, y); },
    /** Resize a window (pixel dimensions). */
    resize(id: number, w: number, h: number): void { if (wm) wm.resizeWindow(id, w, h); },
    /** Bring a window to the front of the Z-order. */
    bringToFront(id: number): void { if (wm) wm.bringToFront(id); },
    /** Show or hide the close button on a window. */
    setCloseable(id: number, closeable: boolean): void { if (wm) wm.setCloseable(id, closeable); },
    /** Set per-window opacity (0=transparent … 255=opaque). */
    setOpacity(id: number, opacity: number): void { if (wm) wm.setWindowOpacity(id, opacity); },
    /** Change the mouse cursor shape: 'default', 'pointer', 'text', 'crosshair', 'none'. */
    setCursor(shape: string): void { if (wm) wm.setCursorShape(shape); },
    /** Height of the WM taskbar in pixels (0 in text mode). */
    getTaskbarHeight(): number { return wm ? wm.taskbarH : 0; },
    /**
     * Open a window as a modal (dims everything behind it).
     * Only one modal can be active at a time.
     * Returns the WMWindow or null in text mode.
     *
     * Example:
     *   os.wm.openModal({ title: 'Settings', app: settingsApp, width: 480, height: 360 });
     */
    openModal(opts: { title: string; app: App; width: number; height: number; x?: number; y?: number }): WMWindow | null {
      return wm ? wm.openModal(opts) : null;
    },
    /**
     * Show a context menu at screen coordinates.
     *
     * Example:
     *   os.wm.showContextMenu(x, y, [
     *     { label: 'Open',   action: () => openFile() },
     *     { label: 'Delete', action: () => deleteFile(), disabled: isReadOnly },
     *     { separator: true },
     *     { label: 'Cancel' },
     *   ]);
     */
    showContextMenu(x: number, y: number, items: MenuItem[]): void { if (wm) wm.showContextMenu(x, y, items); },
    /** Close the active context menu without invoking any action. */
    dismissContextMenu(): void { if (wm) wm.dismissContextMenu(); },

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
      /**
       * Open a file-picker dialog.  callback receives the chosen path or null.
       *
       * Example:
       *   os.wm.dialog.filePicker(function(path) { if (path) openFile(path); });
       */
      filePicker(callback: (path: string | null) => void, opts?: { title?: string; startDir?: string }): void {
        var startDir = (opts && opts.startDir) ? opts.startDir : '/';
        var title    = (opts && opts.title)    ? opts.title    : 'Open File';
        if (!wm) { callback(null); return; }
        var chosen: string | null = null;
        var _cbFired = false;
        var entries: string[] = [];
        try { entries = fs.readdir(startDir) || []; } catch (_e) { entries = []; }
        var selected = -1;
        var H = 22;
        var BG = 0xFF1E1E1E, FG = 0xFFD0D0D0, SEL = 0xFF2060C0;
        var _win: WMWindow | null = null;
        var _dirty = true;
        var dlgApp: App = {
          name: 'file-picker',
          onMount(win: WMWindow): void { _win = win; },
          onUnmount(): void {
            if (!_cbFired) { _cbFired = true; callback(chosen); }
          },
          onKey(_ev: KeyEvent): void {},
          onMouse(ev: MouseEvent): void {
            if (ev.type !== 'mousedown' || !_win) return;
            var row = Math.floor(ev.y / H);
            if (ev.y >= _win.height - H) {
              if (ev.x < 50 && selected >= 0) chosen = startDir.replace(/\/$/, '') + '/' + entries[selected];
              if (!_cbFired) { _cbFired = true; callback(chosen); }
              wm!.closeWindow(_win.id);
            } else {
              selected = (row < entries.length) ? row : -1;
              _dirty = true;
            }
          },
          render(canvas: import('../ui/canvas.js').Canvas): boolean {
            if (!_dirty || !_win) return false;
            _dirty = false;
            canvas.fillRect(0, 0, _win.width, _win.height, BG);
            for (var _ei = 0; _ei < entries.length; _ei++) {
              if (_ei === selected) canvas.fillRect(0, _ei * H, _win.width, H, SEL);
              canvas.drawText(4, _ei * H + 5, entries[_ei], FG);
            }
            canvas.drawText(4,  _win.height - H + 5, 'OK',     FG);
            canvas.drawText(60, _win.height - H + 5, 'Cancel', FG);
            return true;
          },
        };
        wm.openModal({ title, app: dlgApp, width: 320, height: 400 });
      },
      /**
       * Open a colour-picker dialog.  callback receives a 0xRRGGBB number or null.
       *
       * Example:
       *   os.wm.dialog.colorPicker(function(color) { if (color !== null) applyColor(color); });
       */
      colorPicker(callback: (color: number | null) => void, opts?: { title?: string; initial?: number }): void {
        var title   = (opts && opts.title)               ? opts.title   : 'Pick Color';
        var initial = (opts && opts.initial !== undefined) ? opts.initial : 0xFF0000;
        if (!wm) { callback(null); return; }
        var sr = (initial >> 16) & 0xFF;
        var sg = (initial >>  8) & 0xFF;
        var sb =  initial        & 0xFF;
        var chosen: number | null = null;
        var _cbFired = false;
        var _win: WMWindow | null = null;
        var _dirty = true;
        var BG = 0xFF1E1E1E, FG = 0xFFD0D0D0;
        function clamp(v: number) { return v < 0 ? 0 : v > 255 ? 255 : v; }
        var dlgApp: App = {
          name: 'color-picker',
          onMount(win: WMWindow): void { _win = win; },
          onUnmount(): void {
            if (!_cbFired) { _cbFired = true; callback(chosen); }
          },
          onKey(_ev: KeyEvent): void {},
          onMouse(ev: MouseEvent): void {
            if (ev.type !== 'mousedown' || !_win) return;
            if (ev.y >= _win.height - 40) {
              if (ev.x < 50) { chosen = (sr << 16) | (sg << 8) | sb; }
              if (!_cbFired) { _cbFired = true; callback(chosen); }
              wm!.closeWindow(_win.id);
            } else if (ev.y >= 60 && ev.y < 72) { sr = clamp(Math.round((ev.x / _win.width) * 255)); _dirty = true; }
            else if (ev.y >= 82 && ev.y < 94)   { sg = clamp(Math.round((ev.x / _win.width) * 255)); _dirty = true; }
            else if (ev.y >= 104 && ev.y < 116) { sb = clamp(Math.round((ev.x / _win.width) * 255)); _dirty = true; }
          },
          render(canvas: import('../ui/canvas.js').Canvas): boolean {
            if (!_dirty || !_win) return false;
            _dirty = false;
            canvas.fillRect(0, 0, _win.width, _win.height, BG);
            var preview = 0xFF000000 | (sr << 16) | (sg << 8) | sb;
            canvas.fillRect(10, 10, _win.width - 20, 40, preview);
            canvas.drawText(10, 60,  'R: ' + sr, FG);
            canvas.drawText(10, 82,  'G: ' + sg, FG);
            canvas.drawText(10, 104, 'B: ' + sb, FG);
            canvas.drawText(10,  _win.height - 30, 'OK',     FG);
            canvas.drawText(60,  _win.height - 30, 'Cancel', FG);
            return true;
          },
        };
        wm.openModal({ title, app: dlgApp, width: 280, height: 220 });
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
          sdk.events.emit('prefs:change', { app: appName, key, value });
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
        /**
         * Watch for changes to a specific key.  Returns an unsubscribe function.
         *
         * Example:
         *   var unsub = prefs.onChange('theme', function(v) { applyTheme(v); });
         */
        onChange(key: string, cb: (value: unknown) => void): () => void {
          return sdk.events.on('prefs:change', function(d: any) {
            if (d && d.app === appName && d.key === key) cb(d.value);
          });
        },
      };
    },
  },

  // ── Time ─────────────────────────────────────────────────────────────────────

  /**
   * Wall-clock time and duration helpers (backed by CMOS RTC on first call).
   *
   * Example:
   *   var t = os.time.now();          // Unix epoch ms
   *   os.time.since(t);               // elapsed ms
   *   os.time.format(t);              // '2026-01-15 09:22:04'
   *   os.time.duration(90500);        // '1m 30s'
   */
  time: {
    /** Current time as Unix epoch milliseconds. */
    now(): number { return _sdkTimeNow(); },
    /** OS uptime in milliseconds since boot. */
    uptime(): number { return kernel.getUptime ? kernel.getUptime() * 1000 : 0; },
    /** Current date/time as a structured object. */
    date(epochMs?: number): { year: number; month: number; day: number; hour: number; minute: number; second: number; dow: number } {
      var d = (epochMs !== undefined ? epochMs : _sdkTimeNow()) / 1000;
      var sec = Math.floor(d) % 60;
      var min = Math.floor(d / 60) % 60;
      var hr  = Math.floor(d / 3600) % 24;
      var days = Math.floor(d / 86400);
      var dow = (days + 4) % 7; // 0=Sun
      var z   = days + 719468;
      var era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
      var doe = z - era * 146097;
      var yoe = Math.floor((doe - Math.floor(doe/1460) + Math.floor(doe/36524) - Math.floor(doe/146096)) / 365);
      var y   = yoe + era * 400;
      var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
      var mp  = Math.floor((5 * doy + 2) / 153);
      var dd  = doy - Math.floor((153 * mp + 2) / 5) + 1;
      var mm  = mp < 10 ? mp + 3 : mp - 9;
      if (mm <= 2) y++;
      return { year: y, month: mm, day: dd, hour: hr, minute: min, second: sec, dow };
    },
    /**
     * Milliseconds elapsed since epoch value `t`.
     * If called with one numeric arg, returns elapsed ms (numeric).
     */
    since(t: number): number { return _sdkTimeNow() - t; },
    /**
     * Human-readable relative time string from an epoch ms value to now.
     * e.g. 'just now', '5s ago', '3m ago', '2h ago', '4d ago'.
     */
    ago(epochMs: number): string {
      var diff = Math.floor((_sdkTimeNow() - epochMs) / 1000);
      if (diff < 5)  return 'just now';
      if (diff < 60) return diff + 's ago';
      var m = Math.floor(diff / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      var days = Math.floor(h / 24);
      if (days < 30) return days + 'd ago';
      return Math.floor(days / 30) + 'mo ago';
    },
    /**
     * Format a Unix epoch ms value as a human-readable string.
     * fmt tokens: YYYY MM DD HH mm ss.  Default: 'YYYY-MM-DD HH:mm:ss'.
     */
    format(epochMs: number, fmt?: string): string {
      var dt = sdk.time.date(epochMs);
      function p2(n: number) { return (n < 10 ? '0' : '') + n; }
      var f = fmt || 'YYYY-MM-DD HH:mm:ss';
      return f.replace('YYYY', '' + dt.year)
              .replace('MM',   p2(dt.month))
              .replace('DD',   p2(dt.day))
              .replace('HH',   p2(dt.hour))
              .replace('mm',   p2(dt.minute))
              .replace('ss',   p2(dt.second));
    },
    /** Human-readable duration.  e.g. 90500 → '1m 30s', 3700000 → '1h 1m'. */
    duration(ms: number): string {
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60); s %= 60;
      if (m < 60) return m + 'm ' + (s ? s + 's' : '');
      var h = Math.floor(m / 60); m %= 60;
      if (h < 24) return h + 'h ' + (m ? m + 'm' : '');
      var d = Math.floor(h / 24); h %= 24;
      return d + 'd ' + (h ? h + 'h' : '');
    },
  },

  // ── Audio (PC speaker) ────────────────────────────────────────────────────────

  /**
   * PC-speaker audio.  Tones are generated via the 8253 PIT channel 2.
   * Only one tone can play at a time.  Only audible in real hardware / QEMU
   * when configured with '-soundhw pcspk'.
   *
   * Example:
   *   os.audio.beep(440, 200);     // 440 Hz for 200 ms
   *   os.audio.play([{ freq: 261, duration: 150 }, { freq: 329, duration: 150 }]);
   */
  audio: {
    /**
     * Returns true — PC speaker is always available on i686.
     * Can be used to guard audio code on architectures without it.
     */
    isAvailable(): boolean { return true; },
    /** Start a continuous tone at `freq` Hz.  Call silence() to stop. */
    tone(freq: number): void {
      if (freq <= 0) { sdk.audio.silence(); return; }
      var divisor = Math.floor(1193180 / freq) & 0xFFFF;
      kernel.outb(0x43, 0xB6);
      kernel.outb(0x42, divisor & 0xFF);
      kernel.outb(0x42, (divisor >> 8) & 0xFF);
      kernel.outb(0x61, kernel.inb(0x61) | 0x03);
    },
    /** Stop any playing tone immediately. */
    silence(): void {
      kernel.outb(0x61, kernel.inb(0x61) & 0xFC);
    },
    /** Alias for silence() — more intuitive when paired with beep(). */
    stop(): void { sdk.audio.silence(); },
    /** Play a tone at `freq` Hz for `durationMs` milliseconds. */
    beep(freq: number, durationMs?: number): void {
      if (freq <= 0) { sdk.audio.silence(); return; }
      sdk.audio.tone(freq);
      if (durationMs && durationMs > 0) {
        sdk.process.coroutine('audio:beep', (function() {
          var endTicks = kernel.getTicks() + Math.ceil(durationMs / 10);
          return function(): 'done'|'pending' {
            if (kernel.getTicks() >= endTicks) { sdk.audio.silence(); return 'done'; }
            return 'pending';
          };
        })());
      }
    },
    /**
     * Play a sequence of notes.  Each note: { freq, duration } in Hz / ms.
     * freq=0 is a rest.  Returns a coroutine id (cancel with os.process.cancel()).
     *
     * Example:
     *   os.audio.play([
     *     { freq: 523, duration: 150 }, // C5
     *     { freq: 0,   duration:  50 }, // rest
     *     { freq: 659, duration: 150 }, // E5
     *   ]);
     */
    play(notes: Array<{ freq: number; duration: number }>): number {
      var idx = 0;
      var noteEndTick = 0;
      return sdk.process.coroutine('audio:play', function(): 'done'|'pending' {
        var now = kernel.getTicks();
        if (idx >= notes.length) { sdk.audio.silence(); return 'done'; }
        if (now >= noteEndTick) {
          var note = notes[idx++];
          noteEndTick = now + Math.ceil(note.duration / 10);
          if (note.freq > 0) sdk.audio.tone(note.freq);
          else sdk.audio.silence();
        }
        return 'pending';
      });
    },
  },

  // ── Animation ─────────────────────────────────────────────────────────────────

  /**
   * Cooperative frame-based animation engine.
   * Each animation calls `tick(progress)` once per WM frame (~16 ms) with
   * an eased progress value in [0,1].
   *
   * Example:
   *   var id = os.anim.start({ duration: 300, easing: os.anim.easings.easeOut },
   *     function(p) { win.x = Math.round(p * 200); os.wm.markDirty(); },
   *     function() { print('done'); }
   *   );
   *   // cancel early:
   *   os.anim.cancel(id);
   */
  anim: {
    /**
     * Start an animation.  Returns an animation id for `os.anim.cancel()`.
     * tick(progress) is called with 0..1 eased progress each frame.
     * done() is called once when the animation completes.
     */
    start(
      opts: { duration?: number; easing?: (t: number) => number },
      tick: (progress: number) => void,
      done?: () => void,
    ): number {
      var animId     = _nextAnimId++;
      var duration   = (opts && opts.duration !== undefined) ? opts.duration : 300;
      var easing     = (opts && opts.easing)                 ? opts.easing   : function(t: number) { return t; };
      var startUp    = _sdkTimeNow();
      var coroId     = threadManager.runCoroutine('anim:' + animId, function(): 'done'|'pending' {
        var elapsed = _sdkTimeNow() - startUp;
        var t       = duration > 0 ? Math.min(elapsed / duration, 1) : 1;
        var p       = easing(t);
        try { tick(p); } catch (_e) {}
        if (t >= 1) {
          _animRegistry.delete(animId);
          if (done) try { done(); } catch (_e2) {}
          return 'done';
        }
        return 'pending';
      });
      _animRegistry.set(animId, { cb: tick, duration, startUptime: startUp, coroId });
      return animId;
    },
    /** Cancel a running animation by id. */
    cancel(animId: number): void {
      var entry = _animRegistry.get(animId);
      if (!entry) return;
      threadManager.cancelCoroutine(entry.coroId);
      _animRegistry.delete(animId);
    },
    /** Named easing functions. */
    easings: {
      linear:    function(t: number): number { return t; },
      easeIn:    function(t: number): number { return t * t; },
      easeOut:   function(t: number): number { return t * (2 - t); },
      easeInOut: function(t: number): number { return t < 0.5 ? 2*t*t : -1+(4-2*t)*t; },
      bounce:    function(t: number): number {
        if (t < 1/2.75)  return 7.5625*t*t;
        if (t < 2/2.75)  { t -= 1.5/2.75;   return 7.5625*t*t+0.75; }
        if (t < 2.5/2.75){ t -= 2.25/2.75;  return 7.5625*t*t+0.9375; }
        t -= 2.625/2.75; return 7.5625*t*t+0.984375;
      },
      elastic: function(t: number): number {
        if (t === 0 || t === 1) return t;
        return -Math.pow(2, 10*(t-1)) * Math.sin((t-1.1)*5*Math.PI);
      },
    },
  },

  // ── Persistent storage ────────────────────────────────────────────────────────

  /**
   * Persistent storage — file-path based, disk-first with VFS fallback.
   * Also includes a key-value convenience layer (get/set).
   *
   * Example:
   *   os.storage.write('/data/notes.txt', 'hello');
   *   os.storage.read('/data/notes.txt');       // → 'hello'
   *   os.storage.readJSON('/config/app.json');  // → parsed object
   *   os.storage.isPersistent();                // true when disk mounted
   *
   *   // Key-value layer:
   *   os.storage.set('last-file', '/home/user/notes.txt');
   *   os.storage.get<string>('last-file', '/');
   */
  storage: {
    /** True when a persistent disk is mounted (writes survive reboot). */
    isPersistent(): boolean {
      return !!((_diskStorage as any).available && (_diskStorage as any).available());
    },
    /** Read a file as a string.  Returns null if not found. */
    read(path: string): string | null {
      try {
        if (sdk.storage.isPersistent()) {
          var v = (_diskStorage as any).read ? (_diskStorage as any).read(path) : null;
          if (v !== null) return v;
        }
        return fs.readFile(path);
      } catch (_e) { return null; }
    },
    /** Write a string to a file.  Returns true on success. */
    write(path: string, data: string): boolean {
      try {
        if (sdk.storage.isPersistent() && (_diskStorage as any).write) {
          return (_diskStorage as any).write(path, data);
        }
        return fs.writeFile(path, data);
      } catch (_e) { return false; }
    },
    /** Append to a file (creates it if missing). */
    append(path: string, data: string): boolean {
      var existing = sdk.storage.read(path) || '';
      return sdk.storage.write(path, existing + data);
    },
    /** Returns true if the path exists (file or directory). */
    exists(path: string): boolean {
      try { return fs.stat(path) !== null; } catch (_e) { return false; }
    },
    /** List names in a directory (defaults to '/'). */
    list(path?: string): string[] {
      try { return fs.readdir(path || '/') || []; } catch (_e) { return []; }
    },
    /** Delete a file. */
    rm(path: string): boolean {
      try { return !!(fs.rm(path)); } catch (_e) { return false; }
    },
    /** Create a directory (and parents). */
    mkdir(path: string): boolean {
      try { fs.mkdir(path); return true; } catch (_e) { return false; }
    },
    /** Read a file and JSON.parse it.  Returns null on error. */
    readJSON<T>(path: string): T | null {
      try {
        var txt = sdk.storage.read(path);
        return txt ? JSON.parse(txt) as T : null;
      } catch (_e) { return null; }
    },
    /** JSON.stringify a value and write it. */
    writeJSON(path: string, value: unknown, pretty?: boolean): boolean {
      try {
        return sdk.storage.write(path, JSON.stringify(value, null, pretty ? 2 : 0));
      } catch (_e) { return false; }
    },

    // ── Key-value convenience layer ───────────────────────────────────────────
    /** Get a stored value by key.  Returns `fallback` if not found. */
    get<T>(key: string, fallback?: T): T {
      return sdk.storage.readJSON<T>('/etc/storage/' + key + '.json') ?? (fallback as T);
    },
    /** Store a value by key. */
    set(key: string, value: unknown): void {
      fs.mkdir('/etc/storage');
      sdk.storage.writeJSON('/etc/storage/' + key + '.json', value);
    },
    /** Delete a stored value by key. */
    delete(key: string): void {
      sdk.storage.rm('/etc/storage/' + key + '.json');
    },
    /** All stored keys. */
    keys(): string[] {
      try {
        var items = fs.readdir('/etc/storage') || [];
        return items.filter(function(n: string) { return n.endsWith('.json'); })
                    .map(function(n: string) { return n.slice(0, -5); });
      } catch (_e) { return []; }
    },
    /** Delete all stored key-value entries. */
    clear(): void {
      var ks = sdk.storage.keys();
      for (var _ki = 0; _ki < ks.length; _ki++) sdk.storage.delete(ks[_ki]);
    },
  },

  // ── Debug ─────────────────────────────────────────────────────────────────────

  /**
   * Debug utilities: structured logging to serial port + event bus.
   *
   * Example:
   *   os.debug.log('Loaded', { count: 5 });    // serial: [LOG] Loaded {"count":5}
   *   os.debug.warn('Low memory:', free);
   *   os.debug.assert(x > 0, 'x must be positive');
   *   os.debug.measure('sort', () => array.sort());  // → elapsed ms
   *   print(os.debug.inspect({ a: [1, 2] }));        // '{ a: [1, 2] }'
   *   var unsub = os.debug.onEvent(e => panel.add(e.level + ': ' + e.msg));
   */
  debug: {
    /** Log an informational message to serial and the debug event bus. */
    log(...args: unknown[]): void  { _debugSerial('LOG',   args); },
    /** Log a warning. */
    warn(...args: unknown[]): void  { _debugSerial('WARN',  args); },
    /** Log an error. */
    error(...args: unknown[]): void { _debugSerial('ERROR', args); },
    /** Write directly to the serial debug port (no level prefix). */
    print(...args: unknown[]): void {
      var line = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ') + '\n';
      for (var _di = 0; _di < line.length; _di++) kernel.serialPut(line.charCodeAt(_di));
    },
    /** Throw an Error if `cond` is falsy.  Message is included in the stack. */
    assert(cond: boolean, message?: string): void {
      if (!cond) {
        var msg = 'Assertion failed' + (message ? ': ' + message : '');
        sdk.debug.error(msg);
        throw new Error(msg);
      }
    },
    /** Capture an approximate stack trace as a string. */
    trace(): string {
      try { return (new Error()).stack || '(no stack)'; } catch (_e) { return '(no stack)'; }
    },
    /**
     * Human-readable serialisation, similar to util.inspect.
     * depth limits recursive expansion (default 2).
     *
     * Example:  os.debug.inspect({ a: [1, 2, 3], b: { c: true } })
     *   // → '{ a: [1, 2, 3], b: { c: true } }'
     */
    inspect(value: unknown, depth?: number): string {
      var maxDepth = depth !== undefined ? depth : 2;
      function _ins(v: unknown, d: number): string {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        var t = typeof v;
        if (t === 'string') return JSON.stringify(v);
        if (t === 'number' || t === 'boolean') return String(v);
        if (t === 'function') return '[Function ' + ((v as any).name || 'anonymous') + ']';
        if (Array.isArray(v)) {
          if (d >= maxDepth) return '[Array(' + (v as any[]).length + ')]';
          var aItems = (v as any[]).slice(0, 10).map(function(x) { return _ins(x, d + 1); });
          if ((v as any[]).length > 10) aItems.push('... ' + ((v as any[]).length - 10) + ' more');
          return '[' + aItems.join(', ') + ']';
        }
        if (t === 'object') {
          if (d >= maxDepth) return '{...}';
          var keys = Object.keys(v as object).slice(0, 8);
          var pairs = keys.map(function(k) { return k + ': ' + _ins((v as any)[k], d + 1); });
          if (Object.keys(v as object).length > 8) pairs.push('...');
          return '{ ' + pairs.join(', ') + ' }';
        }
        return String(v);
      }
      return _ins(value, 0);
    },
    /**
     * Measure execution time of a function.  Returns elapsed milliseconds.
     *
     * Example:  var ms = os.debug.measure('sort', () => bigArray.sort());
     */
    measure(label: string, fn: () => void): number {
      var t0 = kernel.getTicks();
      try { fn(); } catch (_e) {}
      var elapsed = (kernel.getTicks() - t0) * 10; // ticks are ~10ms
      sdk.debug.log('measure(' + label + '):', elapsed + 'ms');
      return elapsed;
    },
    /** Software breakpoint — no-op unless the kernel exposes debugBreak(). */
    break(): void {
      if ((kernel as any).debugBreak) (kernel as any).debugBreak();
      else sdk.debug.log('BREAKPOINT');
    },
    /** JSON-dump an object to serial — handy for deep objects. */
    dump(label: string, obj: unknown): void {
      sdk.debug.print('[dump] ' + label + ': ' + JSON.stringify(obj, null, 2));
    },
    /** Approximate heap usage from the QuickJS runtime. */
    heapSnapshot(): { total: number; free: number; used: number } {
      try {
        var mem = (globalThis as any).os?.memoryUsage?.() ||
                  (typeof (globalThis as any).gc === 'function' ? { heapSize: 0, heapUsed: 0 } : null);
        if (mem) return { total: mem.heapSize || 0, free: (mem.heapSize || 0) - (mem.heapUsed || 0), used: mem.heapUsed || 0 };
      } catch (_e) {}
      return { total: 0, free: 0, used: 0 };
    },
    /** Subscribe to debug events emitted via os.debug.log/warn/error/event(). */
    onEvent(handler: (ev: { level: string; msg: string; ts: number }) => void): () => void {
      return sdk.events.on('debug:event', handler);
    },
    /** Emit a debug event with an explicit level. */
    event(level: 'trace'|'info'|'warn'|'error', msg: string): void {
      sdk.events.emit('debug:event', { level, msg, ts: _sdkTimeNow() });
    },
  },

  // ── Canvas helpers ────────────────────────────────────────────────────────────

  /**
   * High-level drawing utilities.
   *
   * Example — fluent painter:
   *   var p = os.canvas.painter(canvas);
   *   p.fillRect(0, 0, 200, 100, 0xFF1E1E2E);
   *   p.drawText(10, 10, 'Hello', 0xFFFFFFFF);
   *
   * Example — sprite:
   *   os.canvas.drawSprite(canvas, 10, 10, pixelData, 8, 8, palette, 2);
   */
  canvas: {
    /** Wrap a Canvas in a fluent CanvasPainter. */
    painter(c: import('../ui/canvas.js').Canvas): CanvasPainter {
      var C = c as any;
      return {
        get canvas(): import('../ui/canvas.js').Canvas { return c; },
        fill(color: number)                             { c.fillRect(0, 0, 99999, 99999, color); },
        fillRect(x, y, w, h, color)                    { c.fillRect(x, y, w, h, color); },
        strokeRect(x, y, w, h, color)                  { c.drawRect(x, y, w, h, color); },
        fillRoundRect(x, y, w, h, r, color)            { C.fillRoundRect(x, y, w, h, r, color); },
        strokeRoundRect(x, y, w, h, r, color)          { C.drawRoundRect(x, y, w, h, r, color); },
        fillCircle(cx, cy, r, color)                   { C.fillCircle(cx, cy, r, color); },
        strokeCircle(cx, cy, r, color)                 { C.drawCircle(cx, cy, r, color); },
        drawLine(x0, y0, x1, y1, color)                { c.drawLine(x0, y0, x1, y1, color); },
        drawText(x, y, text, color)                    { c.drawText(x, y, text, color); },
        drawTextWrap(x, y, maxW, text, color, lineH) {
          var words = text.split(' ');
          var cx = x, cy = y, lh = lineH || 16;
          for (var _wi = 0; _wi < words.length; _wi++) {
            var w = words[_wi];
            var m = c.measureText(w + ' ');
            if (cx + m.width > x + maxW && cx > x) { cx = x; cy += lh; }
            c.drawText(cx, cy, w + ' ', color);
            cx += m.width;
          }
          return cy + lh;
        },
        measureText(text)          { return c.measureText(text); },
        drawScrollbar(x, y, h, total, visible, offset, color) {
          var track = color || 0xFF333344;
          var thumb = color ? (color | 0xFF000000) : 0xFF6688AA;
          c.drawRect(x, y, 8, h, track);
          if (total > 0 && visible < total) {
            var ratio = visible / total;
            var th = Math.max(8, Math.floor(h * ratio));
            var ty = y + Math.floor((h - th) * (offset / (total - visible)));
            c.fillRect(x, ty, 8, th, thumb);
          }
        },
        drawProgressBar(x, y, w, h, fraction, fgColor, bgColor) {
          c.fillRect(x, y, w, h, bgColor || 0xFF222233);
          c.fillRect(x, y, Math.floor(w * Math.min(1, Math.max(0, fraction))), h, fgColor || 0xFF4488DD);
        },
        drawButton(x, y, w, h, label, pressed, fgColor, bgColor) {
          var bg = pressed ? 0xFF2255AA : (bgColor || 0xFF334466);
          var fg = fgColor || 0xFFDDDDFF;
          c.fillRect(x, y, w, h, bg);
          c.drawRect(x, y, w, h, 0xFF6688AA);
          var m = c.measureText(label);
          c.drawText(x + Math.floor((w - m.width) / 2), y + Math.floor((h - m.height) / 2), label, fg);
        },
        drawCheckbox(x, y, checked, label, color) {
          var fg = color || 0xFFDDDDFF;
          c.drawRect(x, y, 12, 12, fg);
          if (checked) { c.drawLine(x+2, y+6, x+5, y+9, fg); c.drawLine(x+5, y+9, x+10, y+3, fg); }
          if (label) c.drawText(x + 16, y, label, fg);
        },
        linearGradient(x, y, w, h, stops, dir) { C.drawLinearGradient(x, y, w, h, stops, dir); },
        radialGradient(cx, cy, r, stops)        { C.drawRadialGradient(cx, cy, r, stops); },
        drawSprite(x, y, pixels, pw, ph, palette, scale) { C.drawSprite(x, y, pixels, pw, ph, palette, scale); },
      };
    },
    /**
     * Draw an indexed-colour sprite directly onto a canvas.
     * pixels = array of palette indices; palette = array of 0xAARRGGBB colours.
     * scale = integer pixel multiplier (default 1).
     */
    drawSprite(
      canvas: import('../ui/canvas.js').Canvas,
      x: number, y: number,
      pixels: number[], pw: number, ph: number,
      palette: number[], scale?: number,
    ): void {
      (canvas as any).drawSprite(x, y, pixels, pw, ph, palette, scale);
    },
    /**
     * Allocate a new off-screen Canvas (not attached to any window).
     * Useful for pre-rendering, double-buffering, or sprite sheets.
     *
     * Example:
     *   var offscreen = os.canvas.create(200, 100);
     *   var p = os.canvas.painter(offscreen);
     *   p.fill(0xFF000000);
     *   p.drawText(10, 10, 'Buffered', 0xFFFFFFFF);
     *   // Then blit to a window canvas:
     *   windowCanvas.blit(offscreen, 0, 0, destX, destY, 200, 100);
     */
    create(w: number, h: number): import('../ui/canvas.js').Canvas {
      return new Canvas(w, h);
    },
  },

  // ── Theme ─────────────────────────────────────────────────────────────────────

  /**
   * Colour theme system.  Built-in themes: 'dark', 'light', 'hacker', 'retro'.
   *
   * Example:
   *   var theme = os.theme.current();
   *   canvas.fillRect(0, 0, w, h, theme.bg);
   *   canvas.drawText(10, 10, 'Hello', theme.fg);
   *   os.theme.set('hacker');
   *   os.events.on('theme:change', function(t) { repaint(t.theme); });
   */
  theme: {
    /** Name of the active theme. */
    name(): string { return _activeThemeName; },
    /** The active Theme object. */
    current(): Theme {
      return _themeMap.get(_activeThemeName) ||
             _makeTheme('dark', 0xFF1E1E2E, 0xFFDDDDEE, 0xFF2255AA,
                        0xFF1A3A5C, 0xFFFFFFFF, 0xFF1A2B3C,
                        0xFF2255AA, 0xFFFFFFFF,
                        0xFFFFB900, 0xFFFF4444, 0xFF44CC44, 0xFF888899, 0xFF445566);
    },
    /** All registered theme names. */
    list(): string[] {
      var out: string[] = [];
      _themeMap.forEach(function(_v: Theme, k: string) { out.push(k); });
      return out;
    },
    /** Get a theme by name.  Returns null if not registered. */
    get(name: string): Theme | null { return _themeMap.get(name) || null; },
    /** Register (or overwrite) a named theme. */
    register(name: string, theme: Theme): void { _themeMap.set(name, theme); },
    /**
     * Activate a theme by name.
     * Returns false if the theme is not registered.
     * Emits 'theme:change' event with { name, theme }.
     */
    set(name: string): boolean {
      if (!_themeMap.has(name)) return false;
      _activeThemeName = name;
      sdk.events.emit('theme:change', { name, theme: _themeMap.get(name) });
      return true;
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
