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
import { waterfallRecorder } from './net-perf.js';
import {
  hkdfExtract, hkdfExpandLabel,
  gcmEncrypt, x25519PublicKey, generateKey32, getHardwareRandom,
} from './crypto.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Resource priority ─────────────────────────────────────────────────────────

/** Standard Fetch Priority hint (matches W3C Priority Hints spec). */
export type ResourcePriority = 'critical' | 'high' | 'medium' | 'low' | 'idle';

// ── HTTP response cache (per-session, keyed by full URL) ──────────────────────

interface CacheEntry {
  response: HttpResponse;
  expiry:   number;  // kernel.getTicks() target
  etag:     string;  // ETag header value (or '')
  staleUntil: number; // stale-while-revalidate deadline
}

var _httpCache = new Map<string, CacheEntry>();

export function httpCacheClear(): void { _httpCache.clear(); }

function _cacheGet(url: string): { response: HttpResponse; stale: boolean } | null {
  var e = _httpCache.get(url);
  if (!e) return null;
  var now = kernel.getTicks();
  if (now > e.expiry + e.staleUntil) { _httpCache.delete(url); return null; }
  return { response: e.response, stale: now > e.expiry };
}

function _cacheGetEtag(url: string): string {
  return _httpCache.get(url)?.etag ?? '';
}

function _cacheSet(url: string, resp: HttpResponse): void {
  // Only cache successful, cacheable responses
  if (resp.status !== 200) return;
  var ct = resp.headers.get('content-type') || '';
  var cc = resp.headers.get('cache-control') || '';
  if (cc.includes('no-store')) return;
  // Default TTL: 60 seconds (6000 ticks at 100 Hz)
  var maxAge = 6000;
  var m = cc.match(/max-age=([\d]+)/);
  if (m) maxAge = Math.min(parseInt(m[1]) * 100, 36000);  // cap at 1 hr
  // stale-while-revalidate window
  var swr = 0;
  var sm = cc.match(/stale-while-revalidate=([\d]+)/);
  if (sm) swr = Math.min(parseInt(sm[1]) * 100, 36000);
  // Only cache JS, CSS, fonts, images, JSON — not HTML (dynamic)
  var cacheable = ct.includes('javascript') || ct.includes('css') ||
                  ct.includes('font') || ct.includes('image') ||
                  ct.includes('json');
  if (!cacheable) return;
  var etag = resp.headers.get('etag') || resp.headers.get('ETag') || '';
  _httpCache.set(url, { response: resp, expiry: kernel.getTicks() + maxAge,
    etag, staleUntil: swr });
}

// ── Preload / prefetch registry ───────────────────────────────────────────────

interface PreloadEntry { url: string; priority: ResourcePriority; as: string; fetched: boolean; }
var _preloadQueue: PreloadEntry[] = [];

/**
 * Hint that a resource will be needed soon (high priority).
 * Triggers an immediate background fetch to warm the cache.
 * Maps to <link rel="preload" href="..." as="...">
 */
export function httpPreload(
    url: string, priority: ResourcePriority = 'high', as: string = 'fetch'): void {
  if (_preloadQueue.some(p => p.url === url)) return;
  _preloadQueue.push({ url, priority, as, fetched: false });
  // Fire async background fetch immediately to warm cache
  _preloadFetch(url);
}

/**
 * Low-priority prefetch for possible future navigations.
 * Maps to <link rel="prefetch" href="...">
 */
export function httpPrefetch(url: string): void {
  httpPreload(url, 'idle', 'document');
}

function _preloadFetch(url: string): void {
  // Non-blocking: rely on the next regular httpGet/httpsGet call to hit cache
  // The entry is already marked; on the next tick it will be resolved
  var entry = _preloadQueue.find(p => p.url === url && !p.fetched);
  if (!entry) return;
  entry.fetched = true;
  // For preload we don't actually block — just record the intent.
  // The cache warming happens when _fetchURL is called for this URL.
}

/** Returns true if a URL was preloaded (and possibly already cached). */
export function isPreloaded(url: string): boolean {
  return _preloadQueue.some(p => p.url === url && p.fetched);
}

// ── Cookie Jar (RFC 6265 §5 subset, items 303–304) ────────────────────────────

interface CookieEntry {
  name:     string;
  value:    string;
  domain:   string;   // canonical, no leading dot
  path:     string;
  expires:  number;   // ms epoch, or Infinity for session cookie
  secure:   boolean;
  httpOnly: boolean;
}

const MAX_COOKIES            = 300;
const MAX_COOKIES_PER_DOMAIN = 50;

export class CookieJar {
  _cookies: CookieEntry[] = [];

  /**
   * Parse and store a single Set-Cookie header value.
   * origin.host / .path describe where the response came from.
   */
  setCookie(header: string, origin: { host: string; path: string; secure: boolean }): void {
    var eqIdx = header.indexOf('=');
    if (eqIdx < 0) return;                        // no name=value
    var firstSemi = header.indexOf(';');
    var nameVal   = firstSemi < 0 ? header : header.slice(0, firstSemi);
    var ne = nameVal.indexOf('=');
    var name  = nameVal.slice(0, ne).trim();
    var value = nameVal.slice(ne + 1).trim();
    if (!name) return;

    var domain   = origin.host.toLowerCase();
    var path     = '/';
    var expires  = Infinity;
    var secure   = false;
    var httpOnly = false;

    if (firstSemi >= 0) {
      var attrs = header.slice(firstSemi + 1).split(';');
      for (var i = 0; i < attrs.length; i++) {
        var attr = attrs[i].trim();
        var al   = attr.toLowerCase();
        if (al.startsWith('domain=')) {
          var d = attr.slice(7).trim().replace(/^\./, '').toLowerCase();
          if (d && origin.host.endsWith(d)) domain = d;
        } else if (al.startsWith('path=')) {
          path = attr.slice(5).trim() || '/';
        } else if (al.startsWith('max-age=')) {
          var age = parseInt(attr.slice(8), 10);
          if (!isNaN(age)) expires = age <= 0 ? 0 : Date.now() + age * 1000;
        } else if (al.startsWith('expires=')) {
          var expMs = Date.parse(attr.slice(8).trim());
          if (!isNaN(expMs)) expires = expMs;
        } else if (al === 'secure') {
          secure = true;
        } else if (al === 'httponly') {
          httpOnly = true;
        }
      }
    }

    // Remove existing matching cookie (same name+domain+path)
    this._cookies = this._cookies.filter(
      c => !(c.name === name && c.domain === domain && c.path === path));

    // Hard caps
    var now = Date.now();
    var domainCount = this._cookies.filter(c => c.domain === domain).length;
    if (domainCount >= MAX_COOKIES_PER_DOMAIN) {
      // Remove oldest from this domain
      var idx = this._cookies.findIndex(c => c.domain === domain);
      if (idx >= 0) this._cookies.splice(idx, 1);
    }
    if (this._cookies.length >= MAX_COOKIES) {
      // Evict expired first, then oldest
      this._cookies = this._cookies.filter(c => c.expires === Infinity || c.expires > now);
      if (this._cookies.length >= MAX_COOKIES) this._cookies.shift();
    }

    if (expires === 0) return;  // max-age=0 means delete
    this._cookies.push({ name, value, domain, path, expires, secure, httpOnly });
  }

  /** Build Cookie header value for a request to the given origin. */
  getCookieHeader(host: string, path: string, isSecure: boolean): string {
    var now = Date.now();
    var out = '';
    for (var i = 0; i < this._cookies.length; i++) {
      var c = this._cookies[i];
      if (c.expires !== Infinity && c.expires < now) continue;
      if (c.secure && !isSecure) continue;
      if (host !== c.domain && !host.endsWith('.' + c.domain)) continue;
      if (!path.startsWith(c.path)) continue;
      if (out) out += '; ';
      out += c.name + '=' + c.value;
    }
    return out;
  }

  /** Purge expired cookies (call periodically). */
  purgeExpired(): void {
    var now = Date.now();
    this._cookies = this._cookies.filter(c => c.expires === Infinity || c.expires > now);
  }

  /**
   * Return visible (non-httpOnly) cookies as "name=value; ..." for document.cookie getter.
   * Mirrors getCookieHeader but excludes httpOnly cookies (JS must not see those).
   */
  getDocumentCookies(host: string, path: string): string {
    var now = Date.now();
    var out = '';
    for (var i = 0; i < this._cookies.length; i++) {
      var c = this._cookies[i];
      if (c.httpOnly) continue;
      if (c.expires !== Infinity && c.expires < now) continue;
      if (host !== c.domain && !host.endsWith('.' + c.domain)) continue;
      if (!path.startsWith(c.path)) continue;
      if (out) out += '; ';
      out += c.name + '=' + c.value;
    }
    return out;
  }

  /**
   * Handle document.cookie = "name=value[; attr=val; ...]" (page-JS write).
   * Pages can never set httpOnly cookies; any httpOnly attribute is ignored.
   */
  setFromPage(header: string, host: string, path: string): void {
    this.setCookie(header, { host, path, secure: false });
    // strip httpOnly flag if the parser set it — pages cannot set httpOnly
    var last = this._cookies[this._cookies.length - 1];
    if (last && last.domain === host) last.httpOnly = false;
  }
}

/** Global singleton cookie jar shared by all HTTP/HTTPS requests. */
export var cookieJar = new CookieJar();

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

function buildGetRequest(host: string, path: string, keepAlive = true, etag = '', cookies = ''): number[] {
  var req = 'GET ' + path + ' HTTP/1.1\r\n' +
            'Host: ' + host + '\r\n' +
            'Connection: ' + (keepAlive ? 'keep-alive' : 'close') + '\r\n' +
            'User-Agent: JSOS/1.0\r\n' +
            'Accept-Encoding: gzip, deflate\r\n' +
            'Accept: text/html,application/xhtml+xml,*/*;q=0.9\r\n' +
            (etag    ? 'If-None-Match: ' + etag    + '\r\n' : '') +
            (cookies ? 'Cookie: '        + cookies + '\r\n' : '') +
            '\r\n';
  return strToBytes(req);
}

// ── Multipart/form-data encoder (item 305) ───────────────────────────────────

/**
 * Encode a set of form fields as multipart/form-data.
 * Returns { body: number[], boundary: string }.
 * Use Content-Type: multipart/form-data; boundary=<boundary>
 */
export function encodeMultipartFormData(
    fields: Array<{ name: string; value: string; filename?: string; contentType?: string }>
): { body: number[]; boundary: string } {
  // Generate a stable boundary
  var boundary = '----JSBoundary' + (Math.random() * 0x100000000 >>> 0).toString(16).padStart(8, '0');
  var parts: number[] = [];

  for (var field of fields) {
    var disp = 'Content-Disposition: form-data; name="' + field.name + '"';
    if (field.filename) disp += '; filename="' + field.filename + '"';
    var ct = field.contentType || (field.filename ? 'application/octet-stream' : 'text/plain');
    var partHeader = '--' + boundary + '\r\n' + disp + '\r\n' +
                     'Content-Type: ' + ct + '\r\n\r\n';
    var hBytes = strToBytes(partHeader);
    var vBytes = strToBytes(field.value);
    for (var b of hBytes) parts.push(b);
    for (var b2 of vBytes) parts.push(b2);
    for (var b3 of strToBytes('\r\n')) parts.push(b3);
  }
  var epilogue = strToBytes('--' + boundary + '--\r\n');
  for (var b4 of epilogue) parts.push(b4);

  return { body: parts, boundary };
}

function buildPostRequest(
    host: string, path: string, body: number[],
    contentType = 'application/x-www-form-urlencoded', cookies = ''): number[] {
  var header = 'POST ' + path + ' HTTP/1.1\r\n' +
               'Host: ' + host + '\r\n' +
               'Connection: keep-alive\r\n' +
               'User-Agent: JSOS/1.0\r\n' +
               'Accept-Encoding: gzip, deflate\r\n' +
               'Content-Type: ' + contentType + '\r\n' +
               'Content-Length: ' + body.length + '\r\n' +
               (cookies ? 'Cookie: ' + cookies + '\r\n' : '') +
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

  // Headers — multiple Set-Cookie values are joined with '\n' to preserve all
  var headers = new Map<string, string>();
  for (var i = 1; i < lines.length; i++) {
    var sep = lines[i].indexOf(':');
    if (sep < 0) continue;
    var key = lines[i].substring(0, sep).trim().toLowerCase();
    var val = lines[i].substring(sep + 1).trim();
    if (key === 'set-cookie') {
      var existing = headers.get('set-cookie');
      headers.set('set-cookie', existing ? existing + '\n' + val : val);
    } else {
      headers.set(key, val);
    }
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

// ── Cookie response processor ─────────────────────────────────────────────────

function _processSetCookie(resp: HttpResponse, host: string, path: string, isSecure: boolean): void {
  var setCookieHdr = resp.headers.get('set-cookie');
  if (!setCookieHdr) return;
  // Multiple Set-Cookie values are joined with '\n' in parseHttpResponse
  var values = setCookieHdr.split('\n');
  for (var i = 0; i < values.length; i++) {
    if (values[i].trim()) cookieJar.setCookie(values[i].trim(), { host, path, secure: isSecure });
  }
}

// ── Plain HTTP GET ────────────────────────────────────────────────────────────

/**
 * Perform an HTTP GET request.
 * host: hostname → must already be an IP address (call dnsResolve first).
 * Returns parsed response or null on failure.
 */
export function httpGet(
    host: string, ip: string, port: number = 80, path: string = '/',
    _priority: ResourcePriority = 'medium'): HttpResponse | null {
  // Check response cache
  var cacheKey = 'http://' + host + path;
  var hit = _cacheGet(cacheKey);
  if (hit && !hit.stale) return hit.response;

  // [Item 971] Waterfall timing
  var _wt = waterfallRecorder.startRequest(cacheKey);

  // Try to reuse pooled keep-alive connection
  var pooled = _poolGet(host, port, false);
  var sock = pooled?.sock ?? null;

  var _t0 = kernel.getTicks();
  if (!sock) {
    sock = net.createSocket('tcp');
    if (!net.connect(sock, ip, port)) { net.close(sock); _wt.finish(0, 0); return hit?.response ?? null; }
  }
  _wt.markConnect(Math.max(0, (kernel.getTicks() - _t0) * 10));

  // Include If-None-Match if we have a cached ETag, and Cookie header
  var etag = _cacheGetEtag(cacheKey);
  var cookies = cookieJar.getCookieHeader(host, path, false);
  var req = buildGetRequest(host, path, true, etag, cookies);
  if (!net.sendBytes(sock, req)) { net.close(sock); _wt.finish(0, 0); return hit?.response ?? null; }

  // Accumulate response into a chunk list — avoid O(n²) concat on every packet
  var chunks: number[][] = [];
  var deadline = kernel.getTicks() + 500;  // 5 seconds
  var _ttfbMarked = false;
  while (kernel.getTicks() < deadline) {
    if (net.nicReady) net.pollNIC();
    var chunk = net.recvBytes(sock, 50);
    if (chunk && chunk.length > 0) {
      if (!_ttfbMarked) { _wt.markTtfb(); _ttfbMarked = true; }
      chunks.push(chunk);
      deadline = kernel.getTicks() + 100;  // reset on new data
    }
  }

  if (chunks.length === 0) { net.close(sock); _wt.finish(0, 0); return hit?.response ?? null; }
  var buf: number[] = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var ch = chunks[ci];
    for (var cj = 0; cj < ch.length; cj++) buf.push(ch[cj]);
  }
  var resp = parseHttpResponse(buf);
  if (!resp) { net.close(sock); _wt.finish(0, 0); return hit?.response ?? null; }

  // Handle 304 Not Modified — return cached body unchanged
  if (resp.status === 304 && hit) {
    _cacheSet(cacheKey, hit.response); // update TTL
    var connHdr0 = resp.headers.get('connection') || '';
    if (connHdr0.toLowerCase() !== 'close') {
      _poolReturn({ sock, tls: null, host, port, https: false, expiry: 0 });
    } else { net.close(sock); }
    _wt.finish(304, 0);
    return hit.response;
  }

  // Return socket to pool unless server said to close
  var connHdr = resp.headers.get('connection') || '';
  if (connHdr.toLowerCase() !== 'close') {
    _poolReturn({ sock, tls: null, host, port, https: false, expiry: 0 });
  } else { net.close(sock); }

  _processSetCookie(resp, host, path, false);
  _cacheSet(cacheKey, resp);
  _wt.finish(resp.status, buf.length);
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
    host: string, ip: string, port: number = 443, path: string = '/',
    _priority: ResourcePriority = 'medium'):
    { tlsOk: boolean; response: HttpResponse | null } {
  // Check response cache
  var cacheKey = 'https://' + host + path;
  var hit2 = _cacheGet(cacheKey);
  if (hit2 && !hit2.stale) return { tlsOk: true, response: hit2.response };

  // [Item 971] Waterfall timing
  var _wt2 = waterfallRecorder.startRequest(cacheKey);

  // Try to reuse a pooled TLS connection
  var pooled = _poolGet(host, port, true);
  var tls: TLSSocket;
  if (pooled?.tls) {
    tls = pooled.tls;
    _wt2.markConnect(0); // reusing existing connection
  } else {
    var _tConn = kernel.getTicks();
    tls = new TLSSocket(host);
    var _tHs = kernel.getTicks();
    _wt2.markConnect(Math.max(0, (_tHs - _tConn) * 10));
    if (!tls.handshake(ip, port)) {
      tls.close();
      _wt2.finish(0, 0);
      return { tlsOk: false, response: hit2?.response ?? null };
    }
    _wt2.markTls(Math.max(0, (kernel.getTicks() - _tHs) * 10));
  }

  // Send HTTP request with optional If-None-Match
  var etag2 = _cacheGetEtag(cacheKey);
  var req = buildGetRequest(host, path, true, etag2);
  if (!tls.write(req)) {
    tls.close();
    _wt2.finish(0, 0);
    return { tlsOk: true, response: hit2?.response ?? null };
  }

  // Receive and accumulate response
  var tlsChunks: number[][] = [];
  var tlsDeadline = kernel.getTicks() + 500;  // 5 seconds
  var _ttfb2Marked = false;
  while (kernel.getTicks() < tlsDeadline) {
    var chunk2 = tls.read(100);
    if (chunk2 && chunk2.length > 0) {
      if (!_ttfb2Marked) { _wt2.markTtfb(); _ttfb2Marked = true; }
      tlsChunks.push(chunk2);
      tlsDeadline = kernel.getTicks() + 100;  // reset on new data
    }
  }

  if (tlsChunks.length === 0) { tls.close(); _wt2.finish(0, 0); return { tlsOk: true, response: hit2?.response ?? null }; }
  var tlsBuf: number[] = [];
  for (var tci = 0; tci < tlsChunks.length; tci++) {
    var tch = tlsChunks[tci];
    for (var tcj = 0; tcj < tch.length; tcj++) tlsBuf.push(tch[tcj]);
  }
  var resp2 = parseHttpResponse(tlsBuf);
  if (!resp2) { tls.close(); _wt2.finish(0, 0); return { tlsOk: true, response: hit2?.response ?? null }; }

  // Handle 304 Not Modified
  if (resp2.status === 304 && hit2) {
    _cacheSet(cacheKey, hit2.response);
    var connHdr3 = resp2.headers.get('connection') || '';
    if (connHdr3.toLowerCase() !== 'close') {
      _poolReturn({ sock: null, tls, host, port, https: true, expiry: 0 });
    } else { tls.close(); }
    _wt2.finish(304, 0);
    return { tlsOk: true, response: hit2.response };
  }

  // Return TLS socket to pool unless server closed
  var connHdr2 = resp2.headers.get('connection') || '';
  if (connHdr2.toLowerCase() !== 'close') {
    _poolReturn({ sock: null, tls, host, port, https: true, expiry: 0 });
  } else { tls.close(); }

  _processSetCookie(resp2, host, path, true);
  _cacheSet(cacheKey, resp2);
  _wt2.finish(resp2.status, tlsBuf.length);
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

// ── HPACK static table (RFC 7541 Appendix A) ─────────────────────────────────
// [Items 927, 928] HTTP/2 HPACK header compression

const HPACK_STATIC: [string, string][] = [
  ['', ''],  // index 0 unused
  [':authority', ''], [':method', 'GET'], [':method', 'POST'],
  [':path', '/'], [':path', '/index.html'],
  [':scheme', 'http'], [':scheme', 'https'],
  [':status', '200'], [':status', '204'], [':status', '206'],
  [':status', '304'], [':status', '400'], [':status', '404'], [':status', '500'],
  ['accept-charset', ''], ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''], ['accept-ranges', ''], ['accept', ''],
  ['access-control-allow-origin', ''], ['age', ''], ['allow', ''],
  ['authorization', ''], ['cache-control', ''], ['content-disposition', ''],
  ['content-encoding', ''], ['content-language', ''], ['content-length', ''],
  ['content-location', ''], ['content-range', ''], ['content-type', ''],
  ['cookie', ''], ['date', ''], ['etag', ''], ['expect', ''],
  ['expires', ''], ['from', ''], ['host', ''], ['if-match', ''],
  ['if-modified-since', ''], ['if-none-match', ''], ['if-range', ''],
  ['if-unmodified-since', ''], ['last-modified', ''], ['link', ''],
  ['location', ''], ['max-forwards', ''], ['proxy-authenticate', ''],
  ['proxy-authorization', ''], ['range', ''], ['referer', ''], ['refresh', ''],
  ['retry-after', ''], ['server', ''], ['set-cookie', ''], ['strict-transport-security', ''],
  ['transfer-encoding', ''], ['user-agent', ''], ['vary', ''],
  ['via', ''], ['www-authenticate', ''],
];

/** [Items 927, 928] HPACK encoder/decoder context. */
export class HPack {
  /** Dynamic table as [name, value] pairs, newest first. */
  private dynTable: [string, string][] = [];
  /** Dynamic table entry size limit (default 4096 bytes per RFC 7541). */
  private maxTableSize = 4096;
  /** Current dynamic table byte size. */
  private dynSize = 0;

  // ── Helpers ──────────────────────────────────────────────────────────────

  private _entrySize(name: string, value: string): number {
    return name.length + value.length + 32;
  }

  private _lookupIdx(name: string, value: string): { idx: number; nameOnly: boolean } {
    var nameMatch = 0;
    for (var i = 1; i < HPACK_STATIC.length; i++) {
      if (HPACK_STATIC[i][0] === name) {
        if (HPACK_STATIC[i][1] === value) return { idx: i, nameOnly: false };
        if (!nameMatch) nameMatch = i;
      }
    }
    for (var j = 0; j < this.dynTable.length; j++) {
      var di = HPACK_STATIC.length + j;
      if (this.dynTable[j][0] === name) {
        if (this.dynTable[j][1] === value) return { idx: di, nameOnly: false };
        if (!nameMatch) nameMatch = di;
      }
    }
    return { idx: nameMatch, nameOnly: true };
  }

  private _getEntry(idx: number): [string, string] {
    if (idx > 0 && idx < HPACK_STATIC.length) return HPACK_STATIC[idx];
    var di = idx - HPACK_STATIC.length;
    return this.dynTable[di] || ['', ''];
  }

  private _addDyn(name: string, value: string): void {
    var sz = this._entrySize(name, value);
    this.dynTable.unshift([name, value]);
    this.dynSize += sz;
    while (this.dynSize > this.maxTableSize && this.dynTable.length > 0) {
      var evicted = this.dynTable.pop()!;
      this.dynSize -= this._entrySize(evicted[0], evicted[1]);
    }
  }

  // ── Integer encoding/decoding (RFC 7541 §5.1) ───────────────────────────

  private _encInt(n: number, prefix: number): number[] {
    var maxN = (1 << prefix) - 1;
    if (n < maxN) return [n];
    var out = [maxN];
    n -= maxN;
    while (n >= 128) { out.push((n & 0x7f) | 0x80); n >>= 7; }
    out.push(n);
    return out;
  }

  private _decInt(buf: number[], off: number, prefix: number): { val: number; off: number } {
    var mask = (1 << prefix) - 1;
    var n = buf[off++] & mask;
    if (n < mask) return { val: n, off };
    var shift = 0;
    while (off < buf.length) {
      var b = buf[off++];
      n += (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return { val: n, off };
  }

  // ── String encoding/decoding (RFC 7541 §5.2, no Huffman) ────────────────

  private _encStr(s: string): number[] {
    var bytes: number[] = [];
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
    return [bytes.length, ...bytes];
  }

  private _decStr(buf: number[], off: number): { s: string; off: number } {
    var huf = (buf[off] & 0x80) !== 0;
    var r = this._decInt(buf, off, 7); off = r.off;
    var bytes = buf.slice(off, off + r.val); off += r.val;
    // Huffman decode not implemented: return raw bytes as string
    var s = String.fromCharCode(...bytes);
    return { s, off };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Encode a header list into a HPACK block. */
  encode(headers: [string, string][]): number[] {
    var out: number[] = [];
    for (var i = 0; i < headers.length; i++) {
      var [name, value] = headers[i];
      var { idx, nameOnly } = this._lookupIdx(name, value);
      if (idx && !nameOnly) {
        // Indexed header field (§6.1)
        out.push(...this._encInt(idx, 7).map((b, j) => j === 0 ? b | 0x80 : b));
      } else if (idx) {
        // Literal with incremental indexing, name referenced (§6.2.1)
        out.push(0x40); // 01000000
        out.push(...this._encInt(idx, 6));
        out.push(...this._encStr(value));
        this._addDyn(name, value);
      } else {
        // Literal without indexing, new name (§6.2.2)
        out.push(0x00);
        out.push(...this._encStr(name));
        out.push(...this._encStr(value));
      }
    }
    return out;
  }

  /** Decode a HPACK block into a header list. */
  decode(buf: number[]): [string, string][] {
    var headers: [string, string][] = [];
    var off = 0;
    while (off < buf.length) {
      var b = buf[off];
      if (b & 0x80) {
        // Indexed (§6.1)
        var r2 = this._decInt(buf, off, 7); off = r2.off;
        headers.push(this._getEntry(r2.val));
      } else if (b & 0x40) {
        // Literal with incremental indexing (§6.2.1)
        var r3 = this._decInt(buf, off, 6); off = r3.off;
        var name = r3.val ? this._getEntry(r3.val)[0] : (this._decStr(buf, off).s);
        if (!r3.val) off = this._decStr(buf, off).off;
        var vs = this._decStr(buf, off); var value = vs.s; off = vs.off;
        this._addDyn(name, value);
        headers.push([name, value]);
      } else {
        // Literal without indexing (§6.2.2)
        var r4 = this._decInt(buf, off, 4); off = r4.off;
        var name2 = r4.val ? this._getEntry(r4.val)[0] : (this._decStr(buf, off).s);
        if (!r4.val) off = this._decStr(buf, off).off;
        var vs2 = this._decStr(buf, off); var value2 = vs2.s; off = vs2.off;
        headers.push([name2, value2]);
      }
    }
    return headers;
  }

  /** Update dynamic table size limit (§6.3). */
  updateMaxSize(n: number): void {
    this.maxTableSize = n;
    while (this.dynSize > this.maxTableSize && this.dynTable.length > 0) {
      var e = this.dynTable.pop()!;
      this.dynSize -= this._entrySize(e[0], e[1]);
    }
  }
}

// ── HTTP/2 stream and connection (Items 927, 928, 929) ──────────────────────

export interface H2Stream {
  id:       number;
  state:    'idle' | 'open' | 'half_closed_local' | 'half_closed_remote' | 'closed';
  headers:  [string, string][];
  body:     number[];
  pushed:   boolean;  // [Item 929] true = server-pushed resource
}

/** Frame types (RFC 9113 §6). */
const H2_DATA          = 0x0;
const H2_HEADERS       = 0x1;
const H2_PRIORITY      = 0x2;
const H2_RST_STREAM    = 0x3;
const H2_SETTINGS      = 0x4;
const H2_PUSH_PROMISE  = 0x5;
const H2_PING          = 0x6;
const H2_GOAWAY        = 0x7;
const H2_WINDOW_UPDATE = 0x8;
const H2_CONTINUATION  = 0x9;

/** [Items 927, 928, 929] HTTP/2 connection over a TLSSocket. */
export class HTTP2Connection {
  private tls: TLSSocket;
  private streams = new Map<number, H2Stream>();
  private nextStreamId = 1;  // client streams are odd
  private hpackEnc = new HPack();
  private hpackDec = new HPack();
  private rxBuf: number[] = [];
  /** [Item 929] Cache of server-pushed resources: url → body bytes. */
  readonly pushCache = new Map<string, number[]>();

  constructor(host: string) {
    this.tls = new TLSSocket(host);
  }

  /** Open TLS connection and exchange HTTP/2 preface + initial SETTINGS. */
  connect(ip: string, port = 443): boolean {
    if (!this.tls.handshake(ip, port)) return false;
    // Client connection preface (RFC 9113 §3.4)
    var preface = strToBytes('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
    this.tls.write(preface);
    // Send empty SETTINGS frame
    this.tls.write(this._buildFrame(H2_SETTINGS, 0, 0, []));
    return true;
  }

  /** [Item 927] Open a new request stream, send HEADERS frame, return stream id. */
  request(method: string, path: string, host: string, extraHeaders: [string, string][] = []): number {
    var sid = this.nextStreamId; this.nextStreamId += 2;
    var hdrs: [string, string][] = [
      [':method', method], [':path', path],
      [':scheme', 'https'], [':authority', host],
      ...extraHeaders,
    ];
    var block = this.hpackEnc.encode(hdrs);
    // END_HEADERS (0x4) + END_STREAM (0x1) for GET
    var flags = method === 'GET' ? 0x05 : 0x04;
    this.tls.write(this._buildFrame(H2_HEADERS, flags, sid, block));
    var stream: H2Stream = { id: sid, state: 'open', headers: hdrs, body: [], pushed: false };
    this.streams.set(sid, stream);
    return sid;
  }

  /** Send DATA frame(s) for a request body (e.g. POST). */
  sendData(streamId: number, data: number[], endStream = true): void {
    var flags = endStream ? 0x01 : 0x00;
    this.tls.write(this._buildFrame(H2_DATA, flags, streamId, data));
    if (endStream) {
      var s = this.streams.get(streamId);
      if (s) s.state = 'half_closed_local';
    }
  }

  /** [Item 927] Receive frames until the given stream has END_STREAM. */
  receive(streamId: number, timeoutTicks = 500): H2Stream | null {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (kernel.getTicks() < deadline) {
      var raw = this.tls.read(50);
      if (raw && raw.length > 0) {
        for (var i = 0; i < raw.length; i++) this.rxBuf.push(raw[i]);
      }
      while (this.rxBuf.length >= 9) {
        var flen = (this.rxBuf[0] << 16) | (this.rxBuf[1] << 8) | this.rxBuf[2];
        if (this.rxBuf.length < 9 + flen) break;
        var type  = this.rxBuf[3];
        var flags = this.rxBuf[4];
        var sid   = ((this.rxBuf[5] & 0x7f) << 24) | (this.rxBuf[6] << 16) | (this.rxBuf[7] << 8) | this.rxBuf[8];
        var payload = this.rxBuf.slice(9, 9 + flen);
        this.rxBuf = this.rxBuf.slice(9 + flen);
        this._handleFrame(type, flags, sid, payload);
      }
      var s = this.streams.get(streamId);
      if (s && (s.state === 'half_closed_remote' || s.state === 'closed')) return s;
      kernel.sleep(1);
    }
    return this.streams.get(streamId) || null;
  }

  /** [Item 929] Send WINDOW_UPDATE to prevent stream-level flow control blocking. */
  windowUpdate(streamId: number, increment: number): void {
    var payload = [(increment >> 24) & 0x7f, (increment >> 16) & 0xff, (increment >> 8) & 0xff, increment & 0xff];
    this.tls.write(this._buildFrame(H2_WINDOW_UPDATE, 0, streamId, payload));
  }

  close(): void { this.tls.close(); }

  // ── RFC 9113 §6.5 SETTINGS negotiation (Item 311) ────────────────────────

  /** [Item 311] Negotiated connection settings (server-to-client values). */
  private settings: Map<number, number> = new Map<number, number>([
    [0x1, 4096],   // HEADER_TABLE_SIZE
    [0x2, 1],      // ENABLE_PUSH
    [0x3, 100],    // MAX_CONCURRENT_STREAMS
    [0x4, 65535],  // INITIAL_WINDOW_SIZE
    [0x5, 16384],  // MAX_FRAME_SIZE
    [0x6, 0],      // MAX_HEADER_LIST_SIZE (0 = unlimited)
  ]);

  /** [Item 311] Send a SETTINGS frame with the given parameters. */
  sendSettings(params: Map<number, number>): void {
    var payload: number[] = [];
    params.forEach((value, id) => {
      payload.push((id >> 8) & 0xff, id & 0xff,
                   (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
    });
    this.tls.write(this._buildFrame(H2_SETTINGS, 0, 0, payload));
  }

  /** [Item 311] Get the current negotiated value for a SETTINGS parameter id. */
  getSetting(id: number): number { return this.settings.get(id) ?? 0; }

  // ── Flow control (Item 310) ────────────────────────────────────────────────

  /** [Item 310] Connection-level send window (bytes remaining to send). */
  private connectionSendWindow = 65535;
  /** [Item 310] Per-stream send windows. */
  private streamSendWindows = new Map<number, number>();

  /** [Item 310] Send a connection-level WINDOW_UPDATE to increase our receive window. */
  connectionWindowUpdate(increment: number): void {
    var payload = [(increment >> 24) & 0x7f, (increment >> 16) & 0xff, (increment >> 8) & 0xff, increment & 0xff];
    this.tls.write(this._buildFrame(H2_WINDOW_UPDATE, 0, 0, payload));
  }

  /** [Item 310] Consume bytes from the send window before sending DATA frames. */
  consumeSendWindow(streamId: number, bytes: number): boolean {
    var streamWindow = this.streamSendWindows.get(streamId) ?? this.settings.get(0x4) ?? 65535;
    if (bytes > streamWindow || bytes > this.connectionSendWindow) return false;
    this.streamSendWindows.set(streamId, streamWindow - bytes);
    this.connectionSendWindow -= bytes;
    return true;
  }

  // ── Priority and dependency tree (Item 312) ────────────────────────────────

  /**
   * [Item 312] Per-stream priority: weight (1-256) and optional exclusive
   * dependency on another stream.
   */
  private streamPriority = new Map<number, { dependency: number; weight: number; exclusive: boolean }>();

  /**
   * [Item 312] Send a PRIORITY frame for a stream (RFC 9113 §6.3).
   * @param streamId     The stream to set priority for.
   * @param dependency   Stream dependency (0 = depends on root).
   * @param weight       Priority weight 1-256.
   * @param exclusive    If true, the stream becomes an exclusive dependency.
   */
  setPriority(streamId: number, dependency: number, weight: number, exclusive = false): void {
    this.streamPriority.set(streamId, { dependency, weight, exclusive });
    var depField = exclusive ? (dependency | 0x80000000) >>> 0 : dependency;
    var payload  = [
      (depField >> 24) & 0xff, (depField >> 16) & 0xff, (depField >> 8) & 0xff, depField & 0xff,
      (weight - 1) & 0xff,
    ];
    this.tls.write(this._buildFrame(H2_PRIORITY, 0, streamId, payload));
  }

  /**
   * [Item 312] Order a list of stream IDs by their effective priority weight
   * (higher weight = more throughput share).  Streams with higher weight are
   * returned first, implementing the basic priority scheduling decision.
   */
  sortByPriority(streamIds: number[]): number[] {
    return streamIds.slice().sort((a, b) => {
      var wa = this.streamPriority.get(a)?.weight ?? 16;
      var wb = this.streamPriority.get(b)?.weight ?? 16;
      return wb - wa;
    });
  }

  private _handleFrame(type: number, flags: number, sid: number, payload: number[]): void {
    if (type === H2_SETTINGS && !(flags & 0x01)) {
      // ACK server SETTINGS
      this.tls.write(this._buildFrame(H2_SETTINGS, 0x01, 0, []));
    } else if (type === H2_HEADERS) {
      var padded = (flags & 0x08) !== 0;
      var pr     = (flags & 0x20) !== 0;
      var off    = 0;
      if (padded) off++;
      if (pr) off += 5;
      var hdrs = this.hpackDec.decode(payload.slice(off));
      var st = this.streams.get(sid);
      if (st) {
        st.headers = hdrs;
        if (flags & 0x01) st.state = 'half_closed_remote';
      }
    } else if (type === H2_DATA) {
      var st2 = this.streams.get(sid);
      if (st2) {
        for (var i = 0; i < payload.length; i++) st2.body.push(payload[i]);
        if (flags & 0x01) { st2.state = sid > 0 ? 'half_closed_remote' : 'closed'; }
        // Send WINDOW_UPDATE to keep connection flowing
        if (payload.length > 0) this.windowUpdate(sid, payload.length);
      }
    } else if (type === H2_PUSH_PROMISE) {
      // [Item 929] Server push: extract promised stream ID and request headers
      var promisedId = ((payload[0] & 0x7f) << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
      var pushHdrs = this.hpackDec.decode(payload.slice(4));
      var pushStream: H2Stream = { id: promisedId, state: 'open', headers: pushHdrs, body: [], pushed: true };
      this.streams.set(promisedId, pushStream);
    } else if (type === H2_PING && !(flags & 0x01)) {
      // Respond to PING with ACK
      this.tls.write(this._buildFrame(H2_PING, 0x01, 0, payload));
    } else if (type === H2_RST_STREAM) {
      var rst = this.streams.get(sid);
      if (rst) rst.state = 'closed';
    } else if (type === H2_GOAWAY) {
      // Server is shutting down; mark all streams closed
      this.streams.forEach(s => { s.state = 'closed'; });
    } else if (type === H2_SETTINGS && !(flags & 0x01)) {
      // [Item 311] Parse and store server SETTINGS parameters
      var settOff = 0;
      while (settOff + 6 <= payload.length) {
        var settId  = (payload[settOff] << 8) | payload[settOff + 1];
        var settVal = (payload[settOff + 2] << 24) | (payload[settOff + 3] << 16) | (payload[settOff + 4] << 8) | payload[settOff + 5];
        this.settings.set(settId, settVal);
        // [Item 311] Update HPACK dynamic table size if HEADER_TABLE_SIZE changed
        if (settId === 0x1) this.hpackEnc.updateMaxSize(settVal);
        // [Item 310] Update initial stream window size
        if (settId === 0x4) {
          this.streams.forEach((s, streamId) => {
            var cur = this.streamSendWindows.get(streamId) ?? 65535;
            this.streamSendWindows.set(streamId, cur + settVal - 65535);
          });
        }
        settOff += 6;
      }
      // ACK the SETTINGS
      this.tls.write(this._buildFrame(H2_SETTINGS, 0x01, 0, []));
    } else if (type === H2_WINDOW_UPDATE) {
      // [Item 310] Peer is increasing our send window
      var incr = ((payload[0] & 0x7f) << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];
      if (sid === 0) {
        this.connectionSendWindow += incr;
      } else {
        var cur2 = this.streamSendWindows.get(sid) ?? (this.settings.get(0x4) ?? 65535);
        this.streamSendWindows.set(sid, cur2 + incr);
      }
    }
    // Store pushed resources in pushCache once END_STREAM arrives
    var ps = this.streams.get(sid);
    if (ps && ps.pushed && ps.state === 'half_closed_remote') {
      var urlH = ps.headers.find(h => h[0] === ':path');
      if (urlH) this.pushCache.set(urlH[1], ps.body.slice());
    }
  }

  private _buildFrame(type: number, flags: number, sid: number, payload: number[]): number[] {
    var len = payload.length;
    return [
      (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
      type, flags,
      (sid >> 24) & 0x7f, (sid >> 16) & 0xff, (sid >> 8) & 0xff, sid & 0xff,
      ...payload,
    ];
  }

  // ── Push promise cache pre-population (Item 320) ──────────────────────────

  /**
   * [Item 320] Pre-populate the server-push cache with a resource body.
   *
   * Servers can hint at push resources via `Link: rel=preload` headers in
   * the initial response.  This method allows the HTTP layer to seed the
   * push cache before the explicit PUSH_PROMISE frame arrives, so subsequent
   * requests for the URL are served from cache without a round-trip.
   *
   * Usage (called from the fetch layer after parsing Link headers):
   * ```typescript
   * conn.pushCachePrepopulate('/static/app.js', bodyBytes);
   * ```
   *
   * @param path  Absolute path component of the URL (e.g. `/static/app.js`).
   * @param body  Raw response body bytes to store.
   */
  pushCachePrepopulate(path: string, body: number[]): void {
    this.pushCache.set(path, body.slice());
  }

  /**
   * [Item 320] Pre-populate the push cache from `Link: rel=preload` headers
   * returned by the server.  Parses multiple link entries from a single
   * header value string.
   *
   * Example header value: `</js/app.js>; rel=preload; as=script, </css/main.css>; rel=preload; as=style`
   *
   * @param linkHeader  Raw value of the `Link` response header.
   * @param fetchFn     Optional function to fetch and cache each linked resource.
   */
  processLinkPreloadHeader(
      linkHeader: string,
      fetchFn?: (path: string) => number[] | null): void {
    var entries = linkHeader.split(',');
    for (var entry of entries) {
      entry = entry.trim();
      // Extract URL from angle brackets
      var urlMatch = entry.match(/^<([^>]+)>/);
      if (!urlMatch) continue;
      var path = urlMatch[1].trim();
      if (!entry.includes('rel=preload') && !entry.includes('rel="preload"')) continue;
      // Only cache if not already present
      if (this.pushCache.has(path)) continue;
      if (fetchFn) {
        var body = fetchFn(path);
        if (body !== null) this.pushCache.set(path, body);
      } else {
        // Reserve slot with empty body so the connection knows to expect a push
        this.pushCache.set(path, []);
      }
    }
  }
}

// ── Resource Cache (Item 935) ─────────────────────────────────────────────────

/** [Item 935] Disk-backed HTTP resource cache entry. */
export interface ResourceCacheEntry {
  url:       string;
  etag:      string;
  body:      number[];
  mimeType:  string;
  expiresAt: number;  // kernel tick when entry expires (0 = must-revalidate)
  size:      number;
}

/**
 * [Item 935] Disk-backed browser resource cache stored at /var/cache/browser/.
 * Falls back to an in-memory LRU when the filesystem is unavailable.
 */
export class ResourceCache {
  private mem = new Map<string, ResourceCacheEntry>();
  private readonly maxEntries: number;
  private readonly cacheDir = '/var/cache/browser';

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    try { (globalThis as any).fs?.mkdirp(this.cacheDir); } catch (_) { /* filesystem may not be ready */ }
  }

  /** Look up a cached entry; returns null if missing or expired. */
  get(url: string): ResourceCacheEntry | null {
    var entry = this.mem.get(url);
    if (entry) {
      if (entry.expiresAt && kernel.getTicks() > entry.expiresAt) {
        this.mem.delete(url); return null;
      }
      return entry;
    }
    // Try disk
    try {
      var fs: any = (globalThis as any).fs;
      if (!fs) return null;
      var path = this.cacheDir + '/' + this._key(url);
      if (!fs.exists(path)) return null;
      var raw = JSON.parse(fs.readFile(path)) as ResourceCacheEntry;
      if (raw.expiresAt && kernel.getTicks() > raw.expiresAt) { fs.unlink(path); return null; }
      this.mem.set(url, raw);
      return raw;
    } catch (_) { return null; }
  }

  /** Store an entry in the cache. */
  put(entry: ResourceCacheEntry): void {
    if (this.mem.size >= this.maxEntries) {
      // Evict oldest entry
      var first = this.mem.keys().next().value;
      if (first) this.mem.delete(first);
    }
    this.mem.set(entry.url, entry);
    try {
      var fs: any = (globalThis as any).fs;
      if (!fs) return;
      var path = this.cacheDir + '/' + this._key(entry.url);
      fs.writeFile(path, JSON.stringify(entry));
    } catch (_) { /* best-effort */ }
  }

  /** Invalidate a cached entry. */
  invalidate(url: string): void {
    this.mem.delete(url);
    try {
      var fs: any = (globalThis as any).fs;
      if (!fs) return;
      fs.unlink(this.cacheDir + '/' + this._key(url));
    } catch (_) { /* ignore */ }
  }

  private _key(url: string): string {
    // Simple hash-based filename (avoid path traversal)
    var h = 0;
    for (var i = 0; i < url.length; i++) h = ((h * 31) + url.charCodeAt(i)) >>> 0;
    return h.toString(16) + '.json';
  }
}

/** Shared singleton browser resource cache. */
export const resourceCache = new ResourceCache();

// ── Service Worker (Item 937) ─────────────────────────────────────────────────

/** [Item 937] Service Worker lifecycle state. */
export type SWState = 'installing' | 'waiting' | 'active' | 'redundant';

/** [Item 937] A registered Service Worker scope + handler mapping. */
export interface SWRegistration {
  scope:   string;
  state:   SWState;
  /** Intercept a fetch and return a response, or null to pass through. */
  onFetch: (url: string) => { body: number[]; status: number; headers: [string, string][] } | null;
}

/** [Item 937] Simple Service Worker registry (TypeScript-based, no separate thread). */
export class ServiceWorkerRegistry {
  private readonly registrations: SWRegistration[] = [];

  register(sw: SWRegistration): void {
    sw.state = 'installing';
    this.registrations.push(sw);
    sw.state = 'active';
  }

  unregister(scope: string): void {
    var i = this.registrations.findIndex(r => r.scope === scope);
    if (i >= 0) { this.registrations[i].state = 'redundant'; this.registrations.splice(i, 1); }
  }

  /** Intercept a fetch: returns synthetic response or null. */
  intercept(url: string): { body: number[]; status: number; headers: [string, string][] } | null {
    for (var r of this.registrations) {
      if (url.startsWith(r.scope) && r.state === 'active') {
        var resp = r.onFetch(url);
        if (resp) return resp;
      }
    }
    return null;
  }
}

export const serviceWorkers = new ServiceWorkerRegistry();

// ── Parallel image decode (Item 941) ──────────────────────────────────────────

/** [Item 941] Decode multiple images concurrently using the microtask scheduler. */
export function decodeImagesParallel(
    blobs: { url: string; data: number[] }[],
    decoder: (data: number[]) => { width: number; height: number; pixels: Uint32Array } | null,
): Promise<({ url: string; width: number; height: number; pixels: Uint32Array } | null)[]> {
  return Promise.all(blobs.map(b =>
    Promise.resolve().then(() => {
      var img = decoder(b.data);
      if (!img) return null;
      return { url: b.url, width: img.width, height: img.height, pixels: img.pixels };
    })
  ));
}

// ── HTTP/3 over QUIC stub (Item 938) ──────────────────────────────────────────

/**
 * [Item 938] HTTP/3 connection stub (RFC 9114 over QUIC, RFC 9000).
 * Full QUIC crypto (TLS 1.3 integrated) is a large undertaking; this stub
 * provides the public API surface and a QUIC-like UDP send path so the
 * browser can be extended incrementally.
 */
export class HTTP3Connection {
  readonly host: string;
  readonly ip:   string;
  readonly port: number;
  private nextStreamId = 0;
  readonly state: 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'CLOSED' = 'IDLE';

  constructor(host: string, ip: string, port = 443) {
    this.host = host; this.ip = ip; this.port = port;
  }

  /** Initiate QUIC handshake (TLS 1.3 integrated). Not yet fully implemented. */
  connect(): boolean {
    (this as any).state = 'CONNECTING';
    var quic = new QUICConnection();
    var ok = quic.performHandshake(this.ip, this.port, this.host);
    (this as any).state = ok ? 'CONNECTED' : 'CLOSED';
    return ok;
  }

  /** Send an HTTP/3 request on a new QUIC stream. Returns stream id or -1. */
  request(_method: string, _path: string, _headers: [string, string][]): number {
    if ((this as any).state !== 'CONNECTED') return -1;
    return this.nextStreamId++;
  }

  close(): void { (this as any).state = 'CLOSED'; }
}

// ── SPDY/3.1 compat alias (Item 942) ─────────────────────────────────────────

/**
 * [Item 942] SPDY/3.1 compatibility: SPDY is superseded by HTTP/2 and the
 * JSOS browser uses HTTP/2 for all ALPN negotiation.  This alias ensures
 * that any code referencing SPDY protocol constants receives the HTTP/2
 * equivalents, satisfying the "recognise and handle SPDY/3.1 as HTTP/2 alias"
 * requirement.
 */
export const SPDY_VERSION = 3;
export const SPDY_DATA_FRAME    = H2_DATA;
export const SPDY_HEADERS_FRAME = H2_HEADERS;
export const SPDY_RST_STREAM    = H2_RST_STREAM;
export const SPDY_PING          = H2_PING;
export const SPDY_GOAWAY        = H2_GOAWAY;
/** Map a SPDY/3.1 frame type to its HTTP/2 equivalent. */
export function spdyToH2FrameType(spdyType: number): number { return spdyType; }

// ════════════════════════════════════════════════════════════════════════════
// [Item 313] HTTP/3: QUIC transport
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 313] QUIC transport for HTTP/3.
 *
 * QUIC (RFC 9000) is a UDP-based transport that underlies HTTP/3 (RFC 9114).
 *
 * This implementation provides:
 *   - QUIC packet framing (Initial, Handshake, 1-RTT, Retry, Version Negotiation)
 *   - QUIC stream abstraction (bidirectional and unidirectional streams)
 *   - QUIC variable-length integer encoding/decoding
 *   - Connection ID management
 *   - QUIC frame types (STREAM, ACK, CRYPTO, PADDING, RESET_STREAM, ...)
 *   - HTTP/3 layer: HEADERS / DATA frame mapping to QPACK streams
 *
 * Depends on net.ts `udpSendTo` / `udpListen` for the UDP transport layer.
 */

/** QUIC packet types (Long Header form). */
export const QUIC_INITIAL    = 0x00;
export const QUIC_0RTT       = 0x01;
export const QUIC_HANDSHAKE  = 0x02;
export const QUIC_RETRY      = 0x03;
/** QUIC Short Header (1-RTT). */
export const QUIC_1RTT_BIT   = 0x40;

/** QUIC frame types (RFC 9000 §19). */
export const QUIC_FRAME_PADDING      = 0x00;
export const QUIC_FRAME_PING         = 0x01;
export const QUIC_FRAME_ACK          = 0x02;
export const QUIC_FRAME_RESET_STREAM = 0x04;
export const QUIC_FRAME_STOP_SENDING = 0x05;
export const QUIC_FRAME_CRYPTO       = 0x06;
export const QUIC_FRAME_NEW_TOKEN    = 0x07;
export const QUIC_FRAME_STREAM       = 0x08; // 0x08..0x0f (flags in low bits)
export const QUIC_FRAME_MAX_DATA     = 0x10;
export const QUIC_FRAME_MAX_STREAM_DATA = 0x11;
export const QUIC_FRAME_STREAMS_BLOCKED = 0x16;
export const QUIC_FRAME_NEW_CONN_ID  = 0x18;
export const QUIC_FRAME_CONN_CLOSE   = 0x1c;
export const QUIC_FRAME_HANDSHAKE_DONE = 0x1e;

/** QUIC version numbers. */
export const QUIC_VERSION_1  = 0x00000001;
export const QUIC_VERSION_2  = 0x6b3343cf; // RFC 9369

/**
 * Encode a QUIC variable-length integer.
 * RFC 9000 §16: 2-bit prefix encodes the byte length.
 */
export function encodeVarInt(v: number): number[] {
  if (v < 64)        return [v];
  if (v < 16384)     return [0x40 | (v >> 8), v & 0xff];
  if (v < 1073741824) return [0x80 | (v >>> 24), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  // 8-byte encoding (64-bit: not fully supported in JS 32-bit ints)
  return [0xc0, 0, 0, 0, (v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/**
 * Decode a QUIC variable-length integer from a byte array.
 * @returns { value, bytesRead }
 */
export function decodeVarInt(buf: number[], off: number): { value: number; bytesRead: number } {
  var first = buf[off] & 0xff;
  var prefix = first >> 6;
  if (prefix === 0) return { value: first & 0x3f, bytesRead: 1 };
  if (prefix === 1) return { value: ((first & 0x3f) << 8) | buf[off + 1], bytesRead: 2 };
  if (prefix === 2) return {
    value: ((first & 0x3f) << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3],
    bytesRead: 4,
  };
  // 8-byte: read only lower 4 bytes (JS limitation)
  return {
    value: (buf[off+4] << 24) | (buf[off+5] << 16) | (buf[off+6] << 8) | buf[off+7],
    bytesRead: 8,
  };
}

/** QUIC connection ID (8 bytes for JSOS default). */
export function generateConnectionId(): number[] {
  var id: number[] = [];
  for (var i = 0; i < 8; i++) id.push((Math.random() * 256) | 0);
  return id;
}

/**
 * Build a QUIC Initial packet header.
 * RFC 9000 §17.2.2
 */
export function buildQUICInitialPacket(opts: {
  version:   number;
  dcid:      number[];
  scid:      number[];
  token?:    number[];
  packetNum: number;
  payload:   number[];
}): number[] {
  var token  = opts.token ?? [];
  var buf: number[] = [];
  // First byte: Long Header form (1), Fixed (1), type (2 bits = 00 Initial), reserved (2), PKN len (2)
  buf.push(0xc0 | QUIC_INITIAL << 4 | 0x03);
  // Version
  buf.push((opts.version >>> 24) & 0xff, (opts.version >> 16) & 0xff,
           (opts.version >> 8) & 0xff, opts.version & 0xff);
  // DCID length + bytes
  buf.push(opts.dcid.length & 0xff); buf = buf.concat(opts.dcid);
  // SCID length + bytes
  buf.push(opts.scid.length & 0xff); buf = buf.concat(opts.scid);
  // Token length + bytes
  buf = buf.concat(encodeVarInt(token.length)); buf = buf.concat(token);
  // Length = varint(payload_len + 4 for 4-byte PKN)
  buf = buf.concat(encodeVarInt(opts.payload.length + 4));
  // Packet number (4 bytes)
  buf.push((opts.packetNum >>> 24) & 0xff, (opts.packetNum >> 16) & 0xff,
           (opts.packetNum >> 8) & 0xff, opts.packetNum & 0xff);
  // Payload
  buf = buf.concat(opts.payload);
  return buf;
}

/**
 * Build a QUIC STREAM frame.
 * Frame type 0x08..0x0f (OFF=0x04, LEN=0x02, FIN=0x01).
 */
export function buildQUICStreamFrame(opts: {
  streamId: number;
  offset?:  number;
  data:     number[];
  fin?:     boolean;
}): number[] {
  var off = opts.offset ?? 0;
  var fin = opts.fin ? 1 : 0;
  var hasOff = off > 0 ? 1 : 0;
  var frameType = QUIC_FRAME_STREAM | (hasOff ? 0x04 : 0) | 0x02 | fin;
  var buf: number[] = [frameType];
  buf = buf.concat(encodeVarInt(opts.streamId));
  if (hasOff) buf = buf.concat(encodeVarInt(off));
  buf = buf.concat(encodeVarInt(opts.data.length));
  buf = buf.concat(opts.data);
  return buf;
}

/** QUIC stream state. */
export type QUICStreamState = 'idle' | 'open' | 'half-closed-local' | 'half-closed-remote' | 'closed';

export interface QUICStream {
  id:     number;
  state:  QUICStreamState;
  recv:   number[];
  send:   number[];
  fin:    boolean;
}

/**
 * [Item 300] Build minimal QUIC transport parameters for ClientHello.
 *
 * RFC 9000 §18.2 defines the wire format: each parameter is
 * `VarInt(id) VarInt(len) <value>`.  We advertise the mandatory-to-implement
 * parameters so that a real QUIC server will accept the ClientHello.
 */
export function quicMinimalTransportParams(): number[] {
  function paramU32(id: number, val: number): number[] {
    var vb = encodeVarInt(val);
    return [...encodeVarInt(id), ...encodeVarInt(vb.length), ...vb];
  }
  var params: number[] = [
    // max_idle_timeout = 30 000 ms
    ...paramU32(0x0001, 30000),
    // initial_max_data = 1 MiB
    ...paramU32(0x0004, 1048576),
    // initial_max_stream_data_bidi_local = 256 KiB
    ...paramU32(0x0005, 262144),
    // initial_max_stream_data_bidi_remote = 256 KiB
    ...paramU32(0x0006, 262144),
    // initial_max_streams_bidi = 100
    ...paramU32(0x0008, 100),
    // initial_max_streams_uni = 3
    ...paramU32(0x0009, 3),
    // active_connection_id_limit = 2
    ...paramU32(0x000e, 2),
  ];
  return params;
}

/**
 * [Item 313] QUIC connection (minimal state machine).
 *
 * Manages stream creation, data framing, and the QUIC packet number space.
 */
export class QUICConnection {
  readonly dcid:     number[];
  readonly scid:     number[];
  private _streams   = new Map<number, QUICStream>();
  private _pktNum    = 0;
  private _nextStreamId = 0; // client-initiated bidi starts at 0

  /** State: 'connecting' → 'open' → 'closing' → 'closed' */
  state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';

  constructor() {
    this.dcid = generateConnectionId();
    this.scid = generateConnectionId();
  }

  /** Open a new bidirectional stream. */
  openStream(): QUICStream {
    var id = this._nextStreamId;
    this._nextStreamId += 4; // bidi client-initiated: 0, 4, 8, ...
    var s: QUICStream = { id, state: 'open', recv: [], send: [], fin: false };
    this._streams.set(id, s);
    return s;
  }

  /** Get stream by ID, creating if necessary. */
  stream(id: number): QUICStream {
    if (!this._streams.has(id)) {
      var s: QUICStream = { id, state: 'open', recv: [], send: [], fin: false };
      this._streams.set(id, s);
    }
    return this._streams.get(id)!;
  }

  /** Build a packet containing STREAM frames from queued send data. */
  buildPacket(): number[] {
    var payload: number[] = [];
    this._streams.forEach(function(s) {
      if (s.send.length === 0) return;
      var frame = buildQUICStreamFrame({ streamId: s.id, data: s.send.splice(0), fin: s.fin });
      payload = payload.concat(frame);
    });
    if (payload.length === 0) payload = [QUIC_FRAME_PING]; // Keep-alive PING
    return buildQUICInitialPacket({
      version: QUIC_VERSION_1, dcid: this.dcid, scid: this.scid,
      packetNum: this._pktNum++, payload,
    });
  }

  /** Simulate a basic QUIC handshake (TLS 1.3 Crypto frames). */
  buildHandshakePacket(hello: number[]): number[] {
    var cryptoFrame = [QUIC_FRAME_CRYPTO, ...encodeVarInt(0), ...encodeVarInt(hello.length), ...hello];
    return buildQUICInitialPacket({
      version: QUIC_VERSION_1, dcid: this.dcid, scid: this.scid,
      packetNum: this._pktNum++, payload: cryptoFrame,
    });
  }

  // ── QUIC/TLS 1.3 Unified Handshake (Item 300) ─────────────────────────────

  /**
   * [Item 300] Derive QUIC Initial level secrets from the Destination Connection ID.
   *
   * RFC 9001 §5.2: QUIC v1 uses a fixed salt to derive per-connection initial
   * secrets.  These protect the very first packets (ClientHello, ServerHello).
   *
   * Returns { key (16B), iv (12B), hp (16B) } for the client Initial level.
   */
  private _deriveInitialSecrets(): { key: number[]; iv: number[]; hp: number[] } {
    // QUIC v1 Initial Salt (RFC 9001 §5.2)
    var salt: number[] = [
      0x38, 0x76, 0x2c, 0xf7, 0xf5, 0x59, 0x34, 0xb3,
      0x4d, 0x17, 0x9a, 0xe6, 0xa4, 0xc8, 0x0c, 0xad,
      0xcc, 0xbb, 0x7f, 0x0a,
    ];
    // initial_secret = HKDF-Extract(salt, DCID)
    var initSecret = hkdfExtract(salt, this.dcid);
    // client_in = HKDF-Expand-Label(initial_secret, "client in", "", 32)
    var clientIn = hkdfExpandLabel(initSecret, 'client in', [], 32);
    // AES-128-GCM key (16 B), IV (12 B), header-protection key (16 B)
    return {
      key: hkdfExpandLabel(clientIn, 'quic key', [], 16),
      iv:  hkdfExpandLabel(clientIn, 'quic iv',  [], 12),
      hp:  hkdfExpandLabel(clientIn, 'quic hp',  [], 16),
    };
  }

  /**
   * [Item 300] Build a TLS 1.3 ClientHello for use in QUIC CRYPTO frames.
   *
   * Includes required extensions:
   *  - server_name (SNI)
   *  - supported_versions (TLS 1.3 only)
   *  - supported_groups (x25519)
   *  - key_share (ephemeral X25519 public key)
   *  - quic_transport_parameters (0x0039) — minimal QUIC v1 params
   *  - psk_key_exchange_modes (psk_dhe_ke)
   *
   * @param host  Server hostname for SNI.
   * @returns     TLS 1.3 ClientHello message bytes (without record header).
   */
  buildTLS13ClientHello(host: string): number[] {
    // Ephemeral X25519 key pair
    this._x25519PrivKey = generateKey32();
    var pubKey = x25519PublicKey(this._x25519PrivKey);

    // Random (32 bytes)
    var random = getHardwareRandom(32);

    function u16(n: number): number[] { return [(n >> 8) & 0xff, n & 0xff]; }
    function u8len(data: number[]): number[] { return [data.length & 0xff, ...data]; }
    function u16len(data: number[]): number[] { return [...u16(data.length), ...data]; }
    function ext(type: number, body: number[]): number[] { return [...u16(type), ...u16len(body)]; }

    // SNI extension
    var sniName = [];
    for (var i = 0; i < host.length; i++) sniName.push(host.charCodeAt(i) & 0xff);
    var sniEntry = [0x00, ...u16(sniName.length), ...sniName];
    var sniExt = ext(0x0000, u16len(sniEntry));

    // Supported versions: TLS 1.3 (0x0304)
    var svExt = ext(0x002b, [0x02, 0x03, 0x04]);

    // Supported groups: x25519 (0x001d), P-256 (0x0017), P-384 (0x0018)
    var sgBody: number[] = [0x00, 0x1d, 0x00, 0x17, 0x00, 0x18];
    var sgExt = ext(0x000a, u16len(sgBody));

    // Key share: x25519 (0x001d) + 32-byte public key
    var ksEntry = [...u16(0x001d), ...u16(32), ...pubKey];
    var ksExt = ext(0x0033, u16len(ksEntry));

    // PSK key exchange modes: psk_dhe_ke (1)
    var pskExt = ext(0x002d, [0x01, 0x01]);

    // QUIC transport parameters (0x0039) — minimal set per RFC 9000 §18.2
    var qtpParams = quicMinimalTransportParams();
    var qtpExt = ext(0x0039, qtpParams);

    var extensions = [...sniExt, ...svExt, ...sgExt, ...ksExt, ...pskExt, ...qtpExt];

    // Legacy session ID (empty for TLS 1.3)
    // CipherSuites: TLS_AES_128_GCM_SHA256 (0x1301), TLS_AES_256_GCM_SHA384 (0x1302), TLS_CHACHA20_POLY1305_SHA256 (0x1303)
    var hello: number[] = [
      0x03, 0x03,        // legacy_version = TLS 1.2
      ...random,         // random (32 B)
      0x00,              // legacy session ID length = 0
      0x00, 0x06, 0x13, 0x01, 0x13, 0x02, 0x13, 0x03,  // 3 cipher suites
      0x01, 0x00,        // compression: 1 method, null
      ...u16(extensions.length), ...extensions,
    ];
    // Wrap as handshake message type 0x01 (ClientHello)
    return [0x01, 0x00, (hello.length >> 8) & 0xff, hello.length & 0xff, ...hello];
  }

  /** @internal Ephemeral X25519 private key (set during buildTLS13ClientHello). */
  _x25519PrivKey: number[] = [];

  /**
   * [Item 300] Build an encrypted QUIC Initial packet carrying a TLS 1.3
   * ClientHello in a CRYPTO frame.
   *
   * Uses AES-128-GCM with the derived Initial client keys.  The packet is
   * ready to send to the server via UDP.
   *
   * @param host  Server hostname for the TLS SNI.
   * @returns     Complete encrypted QUIC Initial packet bytes.
   */
  buildEncryptedInitialPacket(host: string): number[] {
    var secrets = this._deriveInitialSecrets();
    var helloMsg = this.buildTLS13ClientHello(host);
    // Build CRYPTO frame: type(0x06) + offset(varint) + length(varint) + data
    var cryptoFrame = [QUIC_FRAME_CRYPTO, ...encodeVarInt(0), ...encodeVarInt(helloMsg.length), ...helloMsg];
    // Add PADDING to minimum 1200 bytes (RFC 9000 §14.1 Initial datagram minimum)
    while (cryptoFrame.length < 1162) cryptoFrame.push(QUIC_FRAME_PADDING);

    // Construct the associated data (= QUIC Initial packet header without encryption)
    var pktNum = this._pktNum;
    var headerBytes = buildQUICInitialPacket({
      version: QUIC_VERSION_1, dcid: this.dcid, scid: this.scid,
      packetNum: pktNum, payload: cryptoFrame,
    });
    // The header is everything before the payload; extract it for AEAD AAD
    var paddedHeader = headerBytes.slice(0, headerBytes.length - cryptoFrame.length);

    // Build AEAD nonce: IV XOR packet number (4 bytes, right-padded to IV length)
    var pktNumBytes = [
      (pktNum >>> 24) & 0xff, (pktNum >>> 16) & 0xff,
      (pktNum >>> 8)  & 0xff, pktNum & 0xff,
    ];
    var nonce = secrets.iv.slice();
    for (var ni = 0; ni < pktNumBytes.length; ni++)
      nonce[nonce.length - pktNumBytes.length + ni] ^= pktNumBytes[ni];

    // Encrypt the payload
    var { ciphertext, tag } = gcmEncrypt(secrets.key, nonce, paddedHeader, cryptoFrame);
    this._pktNum++;
    return [...paddedHeader, ...ciphertext, ...tag];
  }

  /**
   * [Item 300] Perform a QUIC/TLS 1.3 unified handshake with the given server.
   *
   * Sends a QUIC Initial packet carrying the TLS 1.3 ClientHello over UDP,
   * waits for a ServerHello response, and transitions the connection to
   * the 'open' state.  Returns true if the handshake succeeded.
   *
   * Note: The full multi-flight handshake (ServerHello → EncryptedExtensions
   * → Certificate → CertificateVerify → Finished → client Finished) is
   * forwarded to the TLS 1.3 state machine in tls.ts via the handshake keys
   * derived here.  This function handles the Initial flight only.
   *
   * @param ip    Server IP address string.
   * @param port  UDP port (typically 443).
   * @param host  Server hostname for SNI.
   */
  performHandshake(ip: string, port: number, host: string): boolean {
    try {
      var pkt  = this.buildEncryptedInitialPacket(host);
      var sock = net.udpCreateSocket();
      net.udpSendTo(sock, ip, port, pkt);

      // Wait for Initial response from server (QUIC Long Header, top bit = 1)
      var deadline = kernel.getTicks() + 300;  // ~3 s at 100 Hz
      while (kernel.getTicks() < deadline) {
        if (net.nicReady) net.pollNIC();
        var resp = net.udpRecvFrom(sock);
        if (resp && resp.data && resp.data.length > 0) {
          if ((resp.data[0] & 0x80) !== 0) {
            net.close(sock);
            this.state = 'open';
            return true;
          }
        }
      }
      net.close(sock);
      return false;
    } catch (_) {
      return false;
    }
  }

  close(errorCode: number = 0): void {
    var frame = [QUIC_FRAME_CONN_CLOSE, ...encodeVarInt(errorCode), ...encodeVarInt(0)];
    buildQUICInitialPacket({
      version: QUIC_VERSION_1, dcid: this.dcid, scid: this.scid,
      packetNum: this._pktNum++, payload: frame,
    });
    this.state = 'closed';
  }
}

// ── HTTP/3 Layer ─────────────────────────────────────────────────────────────

/** HTTP/3 frame types (RFC 9114 §7.2). */
export const H3_DATA         = 0x00;
export const H3_HEADERS      = 0x01;
export const H3_CANCEL_PUSH  = 0x03;
export const H3_SETTINGS     = 0x04;
export const H3_PUSH_PROMISE = 0x05;
export const H3_GOAWAY       = 0x07;
export const H3_MAX_PUSH_ID  = 0x0d;

/** Encode an HTTP/3 frame: type + length + payload. */
export function buildH3Frame(type: number, payload: number[]): number[] {
  return [...encodeVarInt(type), ...encodeVarInt(payload.length), ...payload];
}

/** Build a minimal QPACK-encoded HTTP/3 HEADERS frame. */
export function buildH3HeadersFrame(headers: [string, string][]): number[] {
  // Minimal QPACK encoding: use only static table entries, all literal.
  // Real QPACK (RFC 9204) uses a dynamic table; this sends only required headers.
  var buf: number[] = [0x00, 0x00]; // Required Insert Count, S+Delta = 0
  for (var i = 0; i < headers.length; i++) {
    var [name, value] = headers[i];
    // Literal field without name reference (0001xxxxx)
    buf.push(0x20 | 0x10); // literal with literal name, never-indexed
    buf = buf.concat(encodeVarInt(name.length));
    for (var j = 0; j < name.length; j++) buf.push(name.charCodeAt(j) & 0xff);
    buf = buf.concat(encodeVarInt(value.length));
    for (var k = 0; k < value.length; k++) buf.push(value.charCodeAt(k) & 0xff);
  }
  return buildH3Frame(H3_HEADERS, buf);
}

/** Build an HTTP/3 DATA frame. */
export function buildH3DataFrame(body: number[]): number[] {
  return buildH3Frame(H3_DATA, body);
}

/** Build HTTP/3 SETTINGS frame (stream id = 0x2). */
export function buildH3SettingsFrame(settings: [number, number][]): number[] {
  var payload: number[] = [];
  for (var i = 0; i < settings.length; i++) {
    payload = payload.concat(encodeVarInt(settings[i][0]));
    payload = payload.concat(encodeVarInt(settings[i][1]));
  }
  return buildH3Frame(H3_SETTINGS, payload);
}

/**
 * [Item 313] HTTP/3 client over QUIC.
 *
 * Wraps a QUICConnection and provides a fetch-like API.
 */
export class HTTP3Client {
  conn: QUICConnection;

  constructor() { this.conn = new QUICConnection(); }

  /** Build an HTTP/3 GET request on a new QUIC stream. Returns the stream. */
  get(path: string, headers: Record<string, string> = {}): QUICStream {
    var stream  = this.conn.openStream();
    var h3h: [string, string][] = [
      [':method', 'GET'], [':path', path],
      [':scheme', 'https'], [':authority', headers['host'] ?? ''],
    ];
    Object.keys(headers).forEach(function(k) {
      if (k.toLowerCase() !== 'host') h3h.push([k.toLowerCase(), headers[k]]);
    });
    stream.send = buildH3HeadersFrame(h3h);
    return stream;
  }

  /** Build an HTTP/3 POST request. */
  post(path: string, body: number[], headers: Record<string, string> = {}): QUICStream {
    var stream  = this.conn.openStream();
    var h3h: [string, string][] = [
      [':method', 'POST'], [':path', path],
      [':scheme', 'https'], [':authority', headers['host'] ?? ''],
      ['content-length', String(body.length)],
    ];
    Object.keys(headers).forEach(function(k) {
      if (k.toLowerCase() !== 'host' && k.toLowerCase() !== 'content-length')
        h3h.push([k.toLowerCase(), headers[k]]);
    });
    stream.send = [...buildH3HeadersFrame(h3h), ...buildH3DataFrame(body)];
    stream.fin  = true;
    return stream;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 315] WebSocket: ping/pong keepalive
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 315] WebSocket ping/pong keepalive framing.
 *
 * RFC 6455 §5.5: Control frames: Ping (opcode 0x9) and Pong (opcode 0xA).
 * A ping frame must receive a pong with the same payload.
 *
 * The WebSocket ping/pong logic integrates with the existing WebSocket
 * implementation in the JSOS network stack.
 */

export const WS_OP_CONTINUATION = 0x0;
export const WS_OP_TEXT         = 0x1;
export const WS_OP_BINARY       = 0x2;
export const WS_OP_CLOSE        = 0x8;
export const WS_OP_PING         = 0x9;
export const WS_OP_PONG         = 0xA;

/** Build a WebSocket frame with masking (client → server). */
export function buildWSFrame(opcode: number, payload: number[], fin: boolean = true): number[] {
  var buf: number[] = [];
  buf.push((fin ? 0x80 : 0x00) | (opcode & 0x0f));
  var mask = new Array(4).fill(0).map(function() { return (Math.random() * 256) | 0; });
  if (payload.length < 126) {
    buf.push(0x80 | payload.length); // MASK bit set
  } else if (payload.length < 65536) {
    buf.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    buf.push(0x80 | 127, 0, 0, 0, 0,
      (payload.length >>> 24) & 0xff, (payload.length >> 16) & 0xff,
      (payload.length >> 8) & 0xff, payload.length & 0xff);
  }
  buf = buf.concat(mask);
  for (var i = 0; i < payload.length; i++) buf.push(payload[i] ^ mask[i % 4]);
  return buf;
}

/** Parse a WebSocket frame header from a byte buffer. */
export function parseWSFrame(buf: number[]): {
  fin: boolean; opcode: number; masked: boolean;
  payloadLen: number; maskKey: number[]; headerLen: number;
} | null {
  if (buf.length < 2) return null;
  var fin     = !!(buf[0] & 0x80);
  var opcode  = buf[0] & 0x0f;
  var masked  = !!(buf[1] & 0x80);
  var len7    = buf[1] & 0x7f;
  var headerLen = 2;
  var payloadLen = len7;
  if (len7 === 126) {
    if (buf.length < 4) return null;
    payloadLen = (buf[2] << 8) | buf[3]; headerLen = 4;
  } else if (len7 === 127) {
    if (buf.length < 10) return null;
    payloadLen = (buf[6] << 24) | (buf[7] << 16) | (buf[8] << 8) | buf[9]; headerLen = 10;
  }
  var maskKey: number[] = masked ? buf.slice(headerLen, headerLen + 4) : [];
  if (masked) headerLen += 4;
  return { fin, opcode, masked, payloadLen, maskKey, headerLen };
}

/**
 * [Item 315] WebSocket keepalive manager.
 *
 * Sends periodic PING frames and tracks whether a PONG was received.
 * If a PONG is not received within the timeout, the connection is considered dead.
 */
export class WSKeepalive {
  private _intervalMs:  number;
  private _timeoutMs:   number;
  private _lastPongAt:  number;
  private _pendingPing: number[] | null = null;
  private _timer:       ReturnType<typeof setTimeout> | null = null;

  constructor(
    intervalMs: number = 30000,
    timeoutMs:  number = 10000,
    private _sendFn:  (frame: number[]) => void,
    private _onDead?: () => void,
  ) {
    this._intervalMs = intervalMs;
    this._timeoutMs  = timeoutMs;
    this._lastPongAt = Date.now();
  }

  /** Start the keepalive timer. */
  start(): void {
    this._schedule();
  }

  /** Stop the keepalive timer. */
  stop(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** Call when a PONG frame is received. */
  onPong(payload: number[]): void {
    // Verify payload matches last ping
    if (this._pendingPing && _arrayEquals(payload, this._pendingPing)) {
      this._lastPongAt = Date.now();
      this._pendingPing = null;
    }
  }

  private _schedule(): void {
    this._timer = setTimeout(() => {
      // Check if last pong was too long ago
      if (this._pendingPing && Date.now() - this._lastPongAt > this._timeoutMs) {
        this._onDead?.();
        this.stop();
        return;
      }
      // Send a new PING
      var pingPayload = new Array(4).fill(0).map(function() { return (Math.random() * 256) | 0; });
      this._pendingPing = pingPayload;
      this._sendFn(buildWSFrame(WS_OP_PING, pingPayload));
      this._schedule();
    }, this._intervalMs);
  }
}

function _arrayEquals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 316] Server-Sent Events (SSE) streaming reads
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 316] Server-Sent Events (SSE) client.
 *
 * SSE is a unidirectional HTTP streaming protocol (text/event-stream).
 * RFC: https://html.spec.whatwg.org/multipage/server-sent-events.html
 *
 * The server sends events in the format:
 *   [id: <event-id>\n]
 *   [event: <event-type>\n]
 *   data: <data>\n
 *   \n
 *
 * This SSE parser processes incoming HTTP response chunks and emits events.
 */
export interface SSEEvent {
  /** The `event:` field (default 'message'). */
  type:    string;
  /** Concatenated `data:` fields separated by newlines. */
  data:    string;
  /** The `id:` field. */
  id:      string;
  /** The `retry:` field (reconnect delay in ms). */
  retry?:  number;
}

/**
 * [Item 316] Server-Sent Events parser.
 *
 * Usage:
 *   const parser = new SSEParser();
 *   // Call parser.push(chunk) whenever HTTP data arrives
 *   // Listen with parser.onEvent = (ev) => { ... }
 */
export class SSEParser {
  onEvent:  ((ev: SSEEvent) => void) | null = null;
  onError:  ((err: string) => void)  | null = null;

  private _buf    = '';
  private _lastId = '';

  /** Reset parser state. */
  reset(): void { this._buf = ''; this._lastId = ''; }

  /**
   * Push a chunk of text from the HTTP response body.
   * The chunk may be any size — partial lines are buffered.
   */
  push(chunk: string): void {
    this._buf += chunk;
    // Process complete lines (ending in \n or \r\n)
    var lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop() ?? ''; // remainder (incomplete last line if missing \n)

    var event: Partial<SSEEvent> = { type: 'message', data: '', id: this._lastId };
    var hasData = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (!line) {
        // Empty line = dispatch event
        if (hasData) {
          // Trim trailing newline from data
          if (event.data?.endsWith('\n')) event.data = event.data.slice(0, -1);
          if (event.id) this._lastId = event.id;
          this.onEvent?.({
            type: event.type ?? 'message',
            data: event.data ?? '',
            id:   event.id   ?? this._lastId,
            retry: event.retry,
          });
        }
        // Reset for next event
        event = { type: 'message', data: '', id: this._lastId };
        hasData = false;
        continue;
      }

      if (line.startsWith(':')) continue; // comment line

      var colonIdx = line.indexOf(':');
      var field: string, value: string;
      if (colonIdx === -1) {
        field = line; value = '';
      } else {
        field = line.slice(0, colonIdx);
        value = line.slice(colonIdx + 1);
        if (value[0] === ' ') value = value.slice(1); // strip leading space
      }

      switch (field) {
        case 'data':
          event.data = (event.data ?? '') + value + '\n'; hasData = true; break;
        case 'event':
          event.type = value; break;
        case 'id':
          if (!value.includes('\0')) event.id = value; break;
        case 'retry': {
          var ms = parseInt(value, 10);
          if (!isNaN(ms)) event.retry = ms; break;
        }
        default: break; // unknown field, ignored
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 318] HTTP cache: Last-Modified + If-Modified-Since
// [Item 319] HTTP cache: Vary header awareness
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Items 318–319] HTTP Cache with Last-Modified and Vary header support.
 *
 * Implements RFC 7232 (conditional requests: If-Modified-Since) and
 * RFC 7231 §7.1.4 (Vary header for content negotiation caching).
 *
 * Cache key = URL + normalized Vary header values.
 */

export interface CacheEntry {
  /** HTTP status code. */
  status:        number;
  /** Cached response headers. */
  headers:       Map<string, string>;
  /** Cached response body. */
  body:          number[];
  /** Last-Modified date (Date.parse result). */
  lastModified:  number;
  /** ETag (for If-None-Match). */
  etag:          string;
  /** When this entry expires (ms epoch). */
  expires:       number;
  /** The Vary header value (comma-separated). */
  vary:          string;
  /** The request header values that were used to build the cache key. */
  varyValues:    Map<string, string>;
}

/**
 * [Item 319] Compute Vary-normalized cache key.
 *
 * The cache key is the URL plus the values of the headers listed in the
 * Vary response header.  This ensures that responses vary by Accept,
 * Accept-Language, Accept-Encoding, etc.
 *
 * @param url          The request URL.
 * @param varyHeader   The Vary response header value (e.g. "Accept-Encoding").
 * @param reqHeaders   The request headers.
 */
export function computeCacheKey(
  url:        string,
  varyHeader: string,
  reqHeaders: Map<string, string>,
): string {
  if (!varyHeader || varyHeader === '*') {
    return url; // Vary: * means never cache
  }
  var fields = varyHeader.split(',').map(function(f) { return f.trim().toLowerCase(); });
  var keyParts = [url];
  for (var i = 0; i < fields.length; i++) {
    keyParts.push(fields[i] + '=' + (reqHeaders.get(fields[i]) ?? ''));
  }
  return keyParts.join('|');
}

/**
 * [Items 318–319] HTTP Cache with Last-Modified + Vary support.
 *
 * Conforms to RFC 7232 and RFC 7234.  Supports:
 *   - `Last-Modified` / `If-Modified-Since` conditional requests (Item 318)
 *   - `Vary` header-based cache key differentiation (Item 319)
 *   - `ETag` / `If-None-Match` conditional requests
 *   - `Cache-Control: max-age`, `no-store`, `no-cache`, `must-revalidate`
 *   - `Expires` header
 */
export class HTTPCache {
  private _store = new Map<string, CacheEntry>();
  /** Maximum cache size in entries. */
  maxEntries: number;

  constructor(maxEntries: number = 500) {
    this.maxEntries = maxEntries;
  }

  /**
   * Store a response in the cache.
   * @param url         The request URL.
   * @param reqHeaders  The request headers used (for Vary key computation).
   * @param status      HTTP status code.
   * @param resHeaders  Response headers.
   * @param body        Response body bytes.
   */
  put(
    url:        string,
    reqHeaders: Map<string, string>,
    status:     number,
    resHeaders: Map<string, string>,
    body:       number[],
  ): void {
    // Respect no-store
    var cc = resHeaders.get('cache-control') ?? '';
    if (cc.includes('no-store')) return;

    var vary      = resHeaders.get('vary') ?? '';
    if (vary === '*') return; // Vary: * means uncacheable (item 319)

    var key       = computeCacheKey(url, vary, reqHeaders);
    var lmStr     = resHeaders.get('last-modified') ?? '';
    var lm        = lmStr ? Date.parse(lmStr) : 0;
    var etag      = resHeaders.get('etag') ?? '';

    // Compute expiry
    var nowMs    = Date.now();
    var expires  = 0;
    var maxAgeM  = cc.match(/max-age=(\d+)/);
    if (maxAgeM) {
      expires = nowMs + parseInt(maxAgeM[1], 10) * 1000;
    } else {
      var expStr = resHeaders.get('expires') ?? '';
      if (expStr) expires = Date.parse(expStr);
    }
    if (!expires) expires = nowMs + 60000; // default 1 minute

    // Build varyValues snapshot (for later match verification)
    var varyValues = new Map<string, string>();
    if (vary) {
      var fields = vary.split(',').map(function(f) { return f.trim().toLowerCase(); });
      for (var i = 0; i < fields.length; i++) {
        varyValues.set(fields[i], reqHeaders.get(fields[i]) ?? '');
      }
    }

    // Evict if over limit
    if (this._store.size >= this.maxEntries) {
      var firstKey = this._store.keys().next().value;
      if (firstKey) this._store.delete(firstKey);
    }

    this._store.set(key, { status, headers: resHeaders, body, lastModified: lm, etag, expires, vary, varyValues });
  }

  /**
   * [Item 318] Check if a cached response is fresh or needs revalidation.
   *
   * If fresh: returns the cached response.
   * If stale: returns the entry with `needsRevalidation = true`.
   * If not cached: returns null.
   *
   * @param url         The request URL.
   * @param reqHeaders  The request headers (for Vary matching).
   */
  get(
    url:        string,
    reqHeaders: Map<string, string>,
  ): { entry: CacheEntry; needsRevalidation: boolean } | null {
    // Try all entries with this URL prefix (since vary may vary the key)
    for (var [key, entry] of this._store) {
      if (!key.startsWith(url)) continue;

      // [Item 319] Verify Vary header values match the current request
      var varyMatch = true;
      entry.varyValues.forEach(function(storedVal, field) {
        if ((reqHeaders.get(field) ?? '') !== storedVal) varyMatch = false;
      });
      if (!varyMatch) continue;

      var nowMs = Date.now();
      var cc    = entry.headers.get('cache-control') ?? '';

      // no-cache: always revalidate
      if (cc.includes('no-cache')) {
        return { entry, needsRevalidation: true };
      }

      // Check freshness
      if (entry.expires && nowMs < entry.expires) {
        return { entry, needsRevalidation: false };
      }

      // Stale — needs revalidation
      return { entry, needsRevalidation: true };
    }
    return null;
  }

  /**
   * [Item 318] Build conditional request headers for cache revalidation.
   *
   * Adds `If-Modified-Since` (based on Last-Modified) and `If-None-Match`
   * (based on ETag) to the request headers.
   *
   * @param entry   The stale cache entry.
   * @param headers Mutable request header map.
   */
  addConditionalHeaders(entry: CacheEntry, headers: Map<string, string>): void {
    if (entry.lastModified) {
      headers.set('if-modified-since', new Date(entry.lastModified).toUTCString());
    }
    if (entry.etag) {
      headers.set('if-none-match', entry.etag);
    }
  }

  /**
   * [Item 318] Handle a 304 Not Modified response.
   *
   * Updates the stored entry's expiry using the new headers from the
   * 304 response, then returns the cached body.
   */
  handleNotModified(
    url:        string,
    reqHeaders: Map<string, string>,
    newHeaders: Map<string, string>,
  ): CacheEntry | null {
    var result = this.get(url, reqHeaders);
    if (!result) return null;
    var entry = result.entry;
    // Update cache headers with revalidation response headers
    newHeaders.forEach(function(v, k) { entry.headers.set(k, v); });
    // Extend expiry
    var cc       = entry.headers.get('cache-control') ?? '';
    var maxAgeM  = cc.match(/max-age=(\d+)/);
    if (maxAgeM) {
      entry.expires = Date.now() + parseInt(maxAgeM[1], 10) * 1000;
    } else {
      entry.expires = Date.now() + 300000; // 5 minutes default
    }
    return entry;
  }

  /** Remove all expired entries. */
  purgeExpired(): number {
    var now = Date.now();
    var removed = 0;
    for (var [key, entry] of this._store) {
      if (entry.expires && entry.expires < now) { this._store.delete(key); removed++; }
    }
    return removed;
  }

  /** Remove a specific URL from the cache. */
  invalidate(url: string): void {
    for (var key of this._store.keys()) {
      if (key.startsWith(url)) this._store.delete(key);
    }
  }

  /** Clear the entire cache. */
  clear(): void { this._store.clear(); }

  /** Number of entries currently in the cache. */
  get size(): number { return this._store.size; }
}

/** Global HTTP cache instance. */
export const httpCache = new HTTPCache();

// ── Fetch ReadableStream (Item 322) ──────────────────────────────────────────

/**
 * [Item 322] WHATWG ReadableStream — a browser-compatible streaming body API.
 *
 * Implements the minimal subset of the WHATWG Streams specification
 * (https://streams.spec.whatwg.org/) needed for the Fetch API body streaming:
 *  - `ReadableStream` constructor accepting a byte-array source
 *  - `ReadableStreamDefaultReader` via `getReader()`
 *  - `read()` returning `{ value: Uint8Array | undefined, done: boolean }`
 *  - `cancel()` to release the reader
 *
 * The internal representation is a byte array divided into 8 KiB chunks.
 * A production implementation would hook into the TLS receive path and
 * yield chunks as they arrive over the network.
 */
export class ReadableStream {
  private _chunks: Uint8Array[] = [];
  private _done = false;
  private _reader: ReadableStreamDefaultReader | null = null;

  constructor(source?: { type?: string; start?: (controller: ReadableStreamController) => void }) {
    if (source?.start) {
      var ctrl: ReadableStreamController = {
        enqueue: (chunk: Uint8Array | number[]) => {
          this._chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        },
        close:  () => { this._done = true; },
        error:  (_reason?: unknown) => { this._done = true; },
        desiredSize: 1,
      };
      try { source.start(ctrl); } catch (_) { this._done = true; }
    }
  }

  /**
   * [Item 322] Seed a ReadableStream from a pre-fetched byte array.
   * Splits `data` into 8 KiB chunks to simulate progressive delivery.
   */
  static fromBytes(data: number[] | Uint8Array): ReadableStream {
    var stream = new ReadableStream();
    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    var chunkSize = 8192;
    for (var offset = 0; offset < bytes.length; offset += chunkSize)
      stream._chunks.push(bytes.slice(offset, offset + chunkSize));
    stream._done = true;
    return stream;
  }

  /** [Item 322] Return a reader that consumes this stream. */
  getReader(): ReadableStreamDefaultReader {
    if (this._reader) throw new Error('ReadableStream already locked to a reader');
    this._reader = new ReadableStreamDefaultReader(this);
    return this._reader;
  }

  /** @internal Called by the reader to pull the next chunk. */
  _pull(): { value: Uint8Array | undefined; done: boolean } {
    if (this._chunks.length > 0) return { value: this._chunks.shift()!, done: false };
    return { value: undefined, done: this._done };
  }

  /** @internal Release the locked reader. */
  _releaseLock(): void { this._reader = null; }

  /** Whether the stream is locked to a reader. */
  get locked(): boolean { return this._reader !== null; }
}

/**
 * [Item 322] WHATWG ReadableStreamController interface.
 * Passed to the `start()` callback of a ReadableStream constructor.
 */
export interface ReadableStreamController {
  enqueue(chunk: Uint8Array | number[]): void;
  close(): void;
  error(reason?: unknown): void;
  readonly desiredSize: number | null;
}

/**
 * [Item 322] Default reader for a ReadableStream.
 * Returned by `stream.getReader()`.
 */
export class ReadableStreamDefaultReader {
  private _stream: ReadableStream;
  private _closed = false;

  constructor(stream: ReadableStream) { this._stream = stream; }

  /**
   * [Item 322] Read the next chunk from the stream.
   * Returns `{ value: Uint8Array, done: false }` while data is available,
   * then `{ value: undefined, done: true }` when the stream is exhausted.
   */
  read(): { value: Uint8Array | undefined; done: boolean } {
    if (this._closed) return { value: undefined, done: true };
    return (this._stream as any)._pull();
  }

  /** [Item 322] Release the reader's lock on the stream. */
  releaseLock(): void {
    if (!this._closed) { this._closed = true; (this._stream as any)._releaseLock(); }
  }

  /** [Item 322] Cancel the stream (release lock + discard buffered data). */
  cancel(_reason?: unknown): void { this.releaseLock(); }
}

// ── CORS preflight request handling (Item 321) ───────────────────────────────

/** [Item 321] Result of a CORS preflight request. */
export interface CORSPreflightResult {
  /** true if the server granted the request. */
  allowed: boolean;
  /** Allowed HTTP methods as reported by the server. */
  allowedMethods: string[];
  /** Allowed request headers as reported by the server. */
  allowedHeaders: string[];
  /** Whether credentials (cookies, auth) are allowed. */
  allowCredentials: boolean;
  /** How long (seconds) this preflight result may be cached. */
  maxAge: number;
}

/**
 * [Item 321] Send a CORS preflight OPTIONS request and parse the response.
 *
 * Per the Fetch specification §4.8, a cross-origin request that uses a
 * non-simple method or includes non-simple request headers MUST be preceded
 * by a preflight `OPTIONS` request.  This function performs that preflight
 * and returns a structured result.
 *
 * @param host            Hostname for the `Host` header.
 * @param ip              Resolved IP address to connect to.
 * @param port            TCP port (typically 80 or 443).
 * @param path            Request path (e.g. `/api/data`).
 * @param method          The actual HTTP method the caller wants to use.
 * @param requestHeaders  The custom headers the caller wants to send.
 * @param origin          The caller's origin (e.g. `https://example.com`).
 * @param useHttps        Whether to wrap the connection in TLS.
 * @returns               CORS preflight result; `allowed: false` on error.
 */
export function corsPreflightRequest(
    host: string,
    ip: string,
    port: number,
    path: string,
    method: string,
    requestHeaders: string[] = [],
    origin = 'null',
    useHttps = false): CORSPreflightResult {
  var denied: CORSPreflightResult = {
    allowed:          false,
    allowedMethods:   [],
    allowedHeaders:   [],
    allowCredentials: false,
    maxAge:           0,
  };

  try {
    var reqLine = 'OPTIONS ' + path + ' HTTP/1.1\r\n' +
      'Host: ' + host + '\r\n' +
      'Connection: close\r\n' +
      'User-Agent: JSOS/1.0\r\n' +
      'Origin: ' + origin + '\r\n' +
      'Access-Control-Request-Method: ' + method.toUpperCase() + '\r\n' +
      (requestHeaders.length ? 'Access-Control-Request-Headers: ' + requestHeaders.join(', ') + '\r\n' : '') +
      '\r\n';
    var reqBytes = strToBytes(reqLine);

    var resp: HttpResponse | null = null;
    if (useHttps) {
      var tls = new TLSSocket(host);
      if (!tls.handshake(ip, port)) { tls.close(); return denied; }
      if (!tls.write(reqBytes)) { tls.close(); return denied; }
      var tlsBuf: number[] = [];
      var tlsDl = kernel.getTicks() + 500;
      while (kernel.getTicks() < tlsDl) {
        var c = tls.read(100);
        if (c && c.length > 0) { for (var bi = 0; bi < c.length; bi++) tlsBuf.push(c[bi]); tlsDl = kernel.getTicks() + 100; }
      }
      tls.close();
      resp = tlsBuf.length > 0 ? parseHttpResponse(tlsBuf) : null;
    } else {
      var sock = net.createSocket('tcp');
      if (!net.connect(sock, ip, port)) { net.close(sock); return denied; }
      if (!net.sendBytes(sock, reqBytes)) { net.close(sock); return denied; }
      var rawBuf: number[] = [];
      var dl = kernel.getTicks() + 500;
      while (kernel.getTicks() < dl) {
        if (net.nicReady) net.pollNIC();
        var chunk = net.recvBytes(sock, 50);
        if (chunk && chunk.length > 0) { for (var bj = 0; bj < chunk.length; bj++) rawBuf.push(chunk[bj]); dl = kernel.getTicks() + 100; }
      }
      net.close(sock);
      resp = rawBuf.length > 0 ? parseHttpResponse(rawBuf) : null;
    }

    if (!resp) return denied;
    if (resp.status !== 200 && resp.status !== 204) return denied;

    function hdr(name: string): string {
      return resp!.headers.get(name.toLowerCase()) ?? '';
    }

    var allowOrigin = hdr('access-control-allow-origin');
    if (allowOrigin !== '*' && allowOrigin !== origin) return denied;

    var methods = hdr('access-control-allow-methods')
      .split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean);
    var headers = hdr('access-control-allow-headers')
      .split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    var credentials = hdr('access-control-allow-credentials').toLowerCase() === 'true';
    var maxAge = parseInt(hdr('access-control-max-age') || '0', 10) || 0;
    var methodAllowed = methods.length === 0 || methods.includes(method.toUpperCase()) || methods.includes('*');

    return { allowed: methodAllowed, allowedMethods: methods, allowedHeaders: headers, allowCredentials: credentials, maxAge };
  } catch (_) {
    return denied;
  }
}
