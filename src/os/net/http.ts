/**
 * JSOS HTTP / HTTPS Client
 *
 * Pure TypeScript. Sends HTTP/1.1 requests over plain TCP (via net.ts) or
 * TLS 1.3 (via tls.ts). All framing, header parsing, and body accumulation
 * live here; C sees only raw TCP bytes.
 */

import { net } from './net.js';
import { TLSSocket } from './tls.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

export interface HttpResponse {
  status:  number;
  headers: Map<string, string>;
  body:    number[];
}

// ── Byte helpers ──────────────────────────────────────────────────────────────

function strToBytes(s: string): number[] {
  var b: number[] = new Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function bytesToStr(b: number[]): string {
  var parts: string[] = [];
  for (var i = 0; i < b.length; i++) parts.push(String.fromCharCode(b[i]));
  return parts.join('');
}

// ── HTTP request builder ──────────────────────────────────────────────────────

function buildGetRequest(host: string, path: string): number[] {
  var req = 'GET ' + path + ' HTTP/1.1\r\n' +
            'Host: ' + host + '\r\n' +
            'Connection: close\r\n' +
            'User-Agent: JSOS/1.0\r\n' +
            '\r\n';
  return strToBytes(req);
}

// ── HTTP response parser ──────────────────────────────────────────────────────

function parseHttpResponse(data: number[]): HttpResponse | null {
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
  var sock = net.createSocket('tcp');
  if (!net.connect(sock, ip, port)) { net.close(sock); return null; }

  var req = buildGetRequest(host, path);
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
  net.close(sock);

  if (chunks.length === 0) return null;
  // Flatten once at the end — single O(n) pass, no intermediate copies
  var buf: number[] = [];
  for (var ci = 0; ci < chunks.length; ci++) {
    var ch = chunks[ci];
    for (var cj = 0; cj < ch.length; cj++) buf.push(ch[cj]);
  }
  return parseHttpResponse(buf);
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
  var tls = new TLSSocket(host);
  if (!tls.handshake(ip, port)) {
    tls.close();
    return { tlsOk: false, response: null };
  }

  // Send HTTP request over TLS
  var req = buildGetRequest(host, path);
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
  tls.close();

  if (tlsChunks.length === 0) return { tlsOk: true, response: null };
  var tlsBuf: number[] = [];
  for (var tci = 0; tci < tlsChunks.length; tci++) {
    var tch = tlsChunks[tci];
    for (var tcj = 0; tcj < tch.length; tcj++) tlsBuf.push(tch[tcj]);
  }
  var resp = parseHttpResponse(tlsBuf);
  return { tlsOk: true, response: resp };
}
