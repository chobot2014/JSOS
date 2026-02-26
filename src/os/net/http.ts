/**
 * JSOS HTTP / HTTPS Client
 *
 * Pure TypeScript. Sends HTTP/1.1 requests over plain TCP (via net.ts) or
 * TLS 1.3 (via tls.ts). All framing, header parsing, and body accumulation
 * live here; C sees only raw TCP bytes.
 */

import { net, strToBytes, bytesToStr } from './net.js';
import { TLSSocket } from './tls.js';
import { httpDecompress } from './deflate.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── HTTP response cache (per-session, keyed by full URL) ──────────────────────

interface CacheEntry {
  response: HttpResponse;
  expiry:   number;  // kernel.getTicks() target
}

var _httpCache = new Map<string, CacheEntry>();

export function httpCacheClear(): void { _httpCache.clear(); }

function _cacheGet(url: string): HttpResponse | null {
  var e = _httpCache.get(url);
  if (!e) return null;
  if (kernel.getTicks() > e.expiry) { _httpCache.delete(url); return null; }
  return e.response;
}

function _cacheSet(url: string, resp: HttpResponse): void {
  // Only cache successful, cacheable responses: 200 OK, static content types
  if (resp.status !== 200) return;
  var ct = resp.headers.get('content-type') || '';
  var cc = resp.headers.get('cache-control') || '';
  if (cc.includes('no-store')) return;
  // Default TTL: 60 seconds (6000 ticks at 100 Hz)
  var maxAge = 6000;
  var m = cc.match(/max-age=([\d]+)/);
  if (m) maxAge = Math.min(parseInt(m[1]) * 100, 36000);  // cap at 1 hr
  // Only cache JS, CSS, fonts, images — not HTML (dynamic)
  var cacheable = ct.includes('javascript') || ct.includes('css') ||
                  ct.includes('font') || ct.includes('image') ||
                  ct.includes('json');
  if (!cacheable) return;
  _httpCache.set(url, { response: resp, expiry: kernel.getTicks() + maxAge });
}

// ── HTTP connection pool (keep-alive sockets) ─────────────────────────────────

interface PooledSocket {
  sock:       import('./net.js').Socket | null;
  tls:        TLSSocket | null;
  host:       string;
  port:       number;
  https:      boolean;
  expiry:     number;  // idle timeout (100 ticks = 1 s)
}

var _pool: PooledSocket[] = [];
var _MAX_POOL = 8;

function _poolGet(host: string, port: number, https: boolean): PooledSocket | null {
  var now = kernel.getTicks();
  for (var i = _pool.length - 1; i >= 0; i--) {
    var p = _pool[i];
    if (p.host === host && p.port === port && p.https === https && now < p.expiry) {
      _pool.splice(i, 1);
      return p;
    }
    if (now >= p.expiry) { _pool.splice(i, 1); }  // evict stale
  }
  return null;
}

function _poolReturn(p: PooledSocket): void {
  if (_pool.length >= _MAX_POOL) { _poolClose(p); return; }
  p.expiry = kernel.getTicks() + 300;  // 3-second idle window
  _pool.push(p);
}

function _poolClose(p: PooledSocket): void {
  if (p.tls) p.tls.close();
  else if (p.sock) net.close(p.sock);
}

export interface HttpResponse {
  status:  number;
  headers: Map<string, string>;
  body:    number[];
}

// ── HTTP request builder ──────────────────────────────────────────────────────

function buildGetRequest(host: string, path: string, keepAlive = true): number[] {
  var req = 'GET ' + path + ' HTTP/1.1\r\n' +
            'Host: ' + host + '\r\n' +
            'Connection: ' + (keepAlive ? 'keep-alive' : 'close') + '\r\n' +
            'User-Agent: JSOS/1.0\r\n' +
            'Accept-Encoding: gzip, deflate\r\n' +
            'Accept: text/html,application/xhtml+xml,*/*;q=0.9\r\n' +
            '\r\n';
  return strToBytes(req);
}

function buildPostRequest(
    host: string, path: string, body: number[],
    contentType = 'application/x-www-form-urlencoded'): number[] {
  var header = 'POST ' + path + ' HTTP/1.1\r\n' +
               'Host: ' + host + '\r\n' +
               'Connection: keep-alive\r\n' +
               'User-Agent: JSOS/1.0\r\n' +
               'Accept-Encoding: gzip, deflate\r\n' +
               'Content-Type: ' + contentType + '\r\n' +
               'Content-Length: ' + body.length + '\r\n' +
               '\r\n';
  var h = strToBytes(header);
  var out = new Array(h.length + body.length);
  for (var i = 0; i < h.length; i++)    out[i]            = h[i];
  for (var j = 0; j < body.length; j++) out[h.length + j] = body[j];
  return out;
}

// ── HTTP response parser ──────────────────────────────────────────────────────

export function parseHttpResponse(data: number[]): HttpResponse | null {
  var raw = bytesToStr(data);
  var headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) headerEnd = raw.indexOf('\n\n');
  if (headerEnd < 0) return null;

  var headerStr = raw.substring(0, headerEnd);
  var bodyStart = raw.indexOf('\r\n\r\n') >= 0
      ? headerEnd + 4 : headerEnd + 2;

  var lines = headerStr.split(/\r?\n/);
  if (lines.length === 0) return null;

  // Status line
  var statusLine = lines[0];
  var m = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
  if (!m) return null;
  var status = parseInt(m[1], 10);

  // Headers
  var headers = new Map<string, string>();
  for (var i = 1; i < lines.length; i++) {
    var sep = lines[i].indexOf(':');
    if (sep < 0) continue;
    var key = lines[i].substring(0, sep).trim().toLowerCase();
    var val = lines[i].substring(sep + 1).trim();
    headers.set(key, val);
  }

  var body = data.slice(bodyStart);

  // Decode chunked Transfer-Encoding
  var te = headers.get('transfer-encoding') || '';
  if (te.toLowerCase().indexOf('chunked') >= 0) {
    body = decodeChunked(body);
  }

  // Decompress Content-Encoding: gzip / deflate
  var ce = headers.get('content-encoding') || '';
  if (ce) body = httpDecompress(body, ce);

  return { status, headers, body };
}

// ── Chunked Transfer-Encoding decoder ────────────────────────────────────────

function decodeChunked(body: number[]): number[] {
  var result: number[] = [];
  var i = 0;
  while (i < body.length) {
    // Read hex chunk-size up to CRLF (skip chunk extensions after ';')
    var sizeStr = '';
    while (i < body.length) {
      if (body[i] === 13 /* CR */ && i + 1 < body.length && body[i + 1] === 10 /* LF */) {
        i += 2; break;
      }
      if (body[i] === 10 /* bare LF */) { i++; break; }
      sizeStr += String.fromCharCode(body[i++] & 0x7f);
    }
    var semiIdx = sizeStr.indexOf(';');
    if (semiIdx >= 0) sizeStr = sizeStr.slice(0, semiIdx);
    var chunkSize = parseInt(sizeStr.trim(), 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;  // last-chunk
    // Copy chunk data
    for (var j = 0; j < chunkSize && i < body.length; j++) result.push(body[i++]);
    // Skip trailing CRLF after chunk data
    if (i < body.length && body[i] === 13) i++;
    if (i < body.length && body[i] === 10) i++;
  }
  return result;
}

// ── Plain HTTP GET ────────────────────────────────────────────────────────────

/**
 * Perform an HTTP GET request.
 * host: hostname → must already be an IP address (call dnsResolve first).
 * Returns parsed response or null on failure.
 */
export function httpGet(
    host: string, ip: string, port: number = 80, path: string = '/'): HttpResponse | null {
  // Check response cache
  var cacheKey = 'http://' + host + path;
  var cached = _cacheGet(cacheKey);
  if (cached) return cached;

  // Try to reuse pooled keep-alive connection
  var pooled = _poolGet(host, port, false);
  var sock = pooled?.sock ?? null;

  if (!sock) {
    sock = net.createSocket('tcp');
    if (!net.connect(sock, ip, port)) { net.close(sock); return null; }
  }

  var req = buildGetRequest(host, path, true);
  if (!net.sendBytes(sock, req)) { net.close(sock); return null; }

  // Accumulate response into a chunk list — avoid O(n²) concat on every packet
  var chunks: number[][] = [];
  var deadline = kernel.getTicks() + 500;  // 5 seconds
  while (kernel.getTicks() < deadline) {
    if (net.nicReady) net.pollNIC();
    var chunk = net.recvBytes(sock, 50);
    if (chunk && chunk.length > 0) {
      chunks.push(chunk);
      deadline = kernel.getTicks() + 100;  // reset on new data
    }
  }

  if (chunks.length === 0) { net.close(sock); return null; }
  var buf: number[] = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var ch = chunks[ci];
    for (var cj = 0; cj < ch.length; cj++) buf.push(ch[cj]);
  }
  var resp = parseHttpResponse(buf);
  if (!resp) { net.close(sock); return null; }

  // Return socket to pool unless server said to close
  var connHdr = resp.headers.get('connection') || '';
  if (connHdr.toLowerCase() !== 'close') {
    _poolReturn({ sock, tls: null, host, port, https: false, expiry: 0 });
  } else { net.close(sock); }

  _cacheSet(cacheKey, resp);
  return resp;
}

// ── HTTPS GET ─────────────────────────────────────────────────────────────────

/**
 * Perform an HTTPS GET request using TLS 1.3.
 * host: hostname for SNI + Host header.
 * ip:   resolved IP address of the host.
 * Returns { tlsOk, response } where tlsOk indicates if TLS handshake succeeded.
 */
export function httpsGet(
    host: string, ip: string, port: number = 443, path: string = '/'):
    { tlsOk: boolean; response: HttpResponse | null } {
  // Check response cache
  var cacheKey = 'https://' + host + path;
  var cached = _cacheGet(cacheKey);
  if (cached) return { tlsOk: true, response: cached };

  // Try to reuse a pooled TLS connection
  var pooled = _poolGet(host, port, true);
  var tls: TLSSocket;
  if (pooled?.tls) {
    tls = pooled.tls;
  } else {
    tls = new TLSSocket(host);
    if (!tls.handshake(ip, port)) {
      tls.close();
      return { tlsOk: false, response: null };
    }
  }

  // Send HTTP request over TLS
  var req = buildGetRequest(host, path, true);
  if (!tls.write(req)) {
    tls.close();
    return { tlsOk: true, response: null };
  }

  // Receive and accumulate response — chunk list avoids O(n²) concat
  var tlsChunks: number[][] = [];
  var tlsDeadline = kernel.getTicks() + 500;  // 5 seconds
  while (kernel.getTicks() < tlsDeadline) {
    var chunk2 = tls.read(100);
    if (chunk2 && chunk2.length > 0) {
      tlsChunks.push(chunk2);
      tlsDeadline = kernel.getTicks() + 100;  // reset on new data
    }
  }

  if (tlsChunks.length === 0) { tls.close(); return { tlsOk: true, response: null }; }
  var tlsBuf: number[] = [];
  for (var tci = 0; tci < tlsChunks.length; tci++) {
    var tch = tlsChunks[tci];
    for (var tcj = 0; tcj < tch.length; tcj++) tlsBuf.push(tch[tcj]);
  }
  var resp2 = parseHttpResponse(tlsBuf);
  if (!resp2) { tls.close(); return { tlsOk: true, response: null }; }

  // Return TLS socket to pool unless server closed
  var connHdr2 = resp2.headers.get('connection') || '';
  if (connHdr2.toLowerCase() !== 'close') {
    _poolReturn({ sock: null, tls, host, port, https: true, expiry: 0 });
  } else { tls.close(); }

  _cacheSet(cacheKey, resp2);
  return { tlsOk: true, response: resp2 };
}

// ── Plain HTTP POST ───────────────────────────────────────────────────────────

export function httpPost(
    host: string, ip: string, port: number = 80, path: string = '/',
    body: number[] = [],
    contentType = 'application/x-www-form-urlencoded'): HttpResponse | null {
  var sock = net.createSocket('tcp');
  if (!net.connect(sock, ip, port)) { net.close(sock); return null; }

  var req = buildPostRequest(host, path, body, contentType);
  if (!net.sendBytes(sock, req)) { net.close(sock); return null; }

  var chunks: number[][] = [];
  var deadline = kernel.getTicks() + 500;
  while (kernel.getTicks() < deadline) {
    if (net.nicReady) net.pollNIC();
    var chunk = net.recvBytes(sock, 50);
    if (chunk && chunk.length > 0) { chunks.push(chunk); deadline = kernel.getTicks() + 100; }
  }
  net.close(sock);

  if (chunks.length === 0) return null;
  var buf: number[] = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var ch = chunks[ci];
    for (var cj = 0; cj < ch.length; cj++) buf.push(ch[cj]);
  }
  return parseHttpResponse(buf);
}

// ── HTTPS POST ────────────────────────────────────────────────────────────────

export function httpsPost(
    host: string, ip: string, port: number = 443, path: string = '/',
    body: number[] = [],
    contentType = 'application/x-www-form-urlencoded'):
    { tlsOk: boolean; response: HttpResponse | null } {
  var tls = new TLSSocket(host);
  if (!tls.handshake(ip, port)) { tls.close(); return { tlsOk: false, response: null }; }

  var req = buildPostRequest(host, path, body, contentType);
  if (!tls.write(req)) { tls.close(); return { tlsOk: true, response: null }; }

  var tlsChunks: number[][] = [];
  var tlsDeadline = kernel.getTicks() + 500;
  while (kernel.getTicks() < tlsDeadline) {
    var chunk2 = tls.read(100);
    if (chunk2 && chunk2.length > 0) { tlsChunks.push(chunk2); tlsDeadline = kernel.getTicks() + 100; }
  }
  tls.close();

  if (tlsChunks.length === 0) return { tlsOk: true, response: null };
  var tlsBuf: number[] = [];
  for (var tci = 0; tci < tlsChunks.length; tci++) {
    var tch = tlsChunks[tci];
    for (var tcj = 0; tcj < tch.length; tcj++) tlsBuf.push(tch[tcj]);
  }
  return { tlsOk: true, response: parseHttpResponse(tlsBuf) };
}
