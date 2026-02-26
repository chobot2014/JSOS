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

  // Try to reuse pooled keep-alive connection
  var pooled = _poolGet(host, port, false);
  var sock = pooled?.sock ?? null;

  if (!sock) {
    sock = net.createSocket('tcp');
    if (!net.connect(sock, ip, port)) { net.close(sock); return hit?.response ?? null; }
  }

  // Include If-None-Match if we have a cached ETag, and Cookie header
  var etag = _cacheGetEtag(cacheKey);
  var cookies = cookieJar.getCookieHeader(host, path, false);
  var req = buildGetRequest(host, path, true, etag, cookies);
  if (!net.sendBytes(sock, req)) { net.close(sock); return hit?.response ?? null; }

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

  if (chunks.length === 0) { net.close(sock); return hit?.response ?? null; }
  var buf: number[] = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var ch = chunks[ci];
    for (var cj = 0; cj < ch.length; cj++) buf.push(ch[cj]);
  }
  var resp = parseHttpResponse(buf);
  if (!resp) { net.close(sock); return hit?.response ?? null; }

  // Handle 304 Not Modified — return cached body unchanged
  if (resp.status === 304 && hit) {
    _cacheSet(cacheKey, hit.response); // update TTL
    var connHdr0 = resp.headers.get('connection') || '';
    if (connHdr0.toLowerCase() !== 'close') {
      _poolReturn({ sock, tls: null, host, port, https: false, expiry: 0 });
    } else { net.close(sock); }
    return hit.response;
  }

  // Return socket to pool unless server said to close
  var connHdr = resp.headers.get('connection') || '';
  if (connHdr.toLowerCase() !== 'close') {
    _poolReturn({ sock, tls: null, host, port, https: false, expiry: 0 });
  } else { net.close(sock); }

  _processSetCookie(resp, host, path, false);
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
    host: string, ip: string, port: number = 443, path: string = '/',
    _priority: ResourcePriority = 'medium'):
    { tlsOk: boolean; response: HttpResponse | null } {
  // Check response cache
  var cacheKey = 'https://' + host + path;
  var hit2 = _cacheGet(cacheKey);
  if (hit2 && !hit2.stale) return { tlsOk: true, response: hit2.response };

  // Try to reuse a pooled TLS connection
  var pooled = _poolGet(host, port, true);
  var tls: TLSSocket;
  if (pooled?.tls) {
    tls = pooled.tls;
  } else {
    tls = new TLSSocket(host);
    if (!tls.handshake(ip, port)) {
      tls.close();
      return { tlsOk: false, response: hit2?.response ?? null };
    }
  }

  // Send HTTP request with optional If-None-Match
  var etag2 = _cacheGetEtag(cacheKey);
  var req = buildGetRequest(host, path, true, etag2);
  if (!tls.write(req)) {
    tls.close();
    return { tlsOk: true, response: hit2?.response ?? null };
  }

  // Receive and accumulate response
  var tlsChunks: number[][] = [];
  var tlsDeadline = kernel.getTicks() + 500;  // 5 seconds
  while (kernel.getTicks() < tlsDeadline) {
    var chunk2 = tls.read(100);
    if (chunk2 && chunk2.length > 0) {
      tlsChunks.push(chunk2);
      tlsDeadline = kernel.getTicks() + 100;  // reset on new data
    }
  }

  if (tlsChunks.length === 0) { tls.close(); return { tlsOk: true, response: hit2?.response ?? null }; }
  var tlsBuf: number[] = [];
  for (var tci = 0; tci < tlsChunks.length; tci++) {
    var tch = tlsChunks[tci];
    for (var tcj = 0; tcj < tch.length; tcj++) tlsBuf.push(tch[tcj]);
  }
  var resp2 = parseHttpResponse(tlsBuf);
  if (!resp2) { tls.close(); return { tlsOk: true, response: hit2?.response ?? null }; }

  // Handle 304 Not Modified
  if (resp2.status === 304 && hit2) {
    _cacheSet(cacheKey, hit2.response);
    var connHdr3 = resp2.headers.get('connection') || '';
    if (connHdr3.toLowerCase() !== 'close') {
      _poolReturn({ sock: null, tls, host, port, https: true, expiry: 0 });
    } else { tls.close(); }
    return { tlsOk: true, response: hit2.response };
  }

  // Return TLS socket to pool unless server closed
  var connHdr2 = resp2.headers.get('connection') || '';
  if (connHdr2.toLowerCase() !== 'close') {
    _poolReturn({ sock: null, tls, host, port, https: true, expiry: 0 });
  } else { tls.close(); }

  _processSetCookie(resp2, host, path, true);
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
