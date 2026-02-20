/**
 * JSOS DNS Resolver (RFC 1035)
 *
 * Pure TypeScript. Sends a UDP DNS query to net.dns and parses the A-record
 * response. All parsing is done in TypeScript; C sees only raw frames.
 */

import { net } from './net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

const DNS_PORT = 53;

// ── DNS packet builder ────────────────────────────────────────────────────────

function encodeName(name: string): number[] {
  var out: number[] = [];
  var labels = name.split('.');
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    out.push(label.length & 0xff);
    for (var j = 0; j < label.length; j++) out.push(label.charCodeAt(j) & 0xff);
  }
  out.push(0);  // root label
  return out;
}

function buildQuery(id: number, hostname: string): number[] {
  var pkt: number[] = [];
  // Header
  pkt.push((id >> 8) & 0xff, id & 0xff);  // ID
  pkt.push(0x01, 0x00);  // Flags: RD=1
  pkt.push(0x00, 0x01);  // QDCOUNT = 1
  pkt.push(0x00, 0x00);  // ANCOUNT = 0
  pkt.push(0x00, 0x00);  // NSCOUNT = 0
  pkt.push(0x00, 0x00);  // ARCOUNT = 0
  // Question
  var qname = encodeName(hostname);
  pkt = pkt.concat(qname);
  pkt.push(0x00, 0x01);  // QTYPE  = A
  pkt.push(0x00, 0x01);  // QCLASS = IN
  return pkt;
}

// ── DNS response parser ───────────────────────────────────────────────────────

function decodeName(data: number[], off: number): { name: string; end: number } {
  var labels: string[] = [];
  var end = -1;
  var maxIter = 128;
  while (off < data.length && maxIter-- > 0) {
    var len = data[off] & 0xff;
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      // Pointer
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | (data[off+1] & 0xff);
      continue;
    }
    off++;
    var label = '';
    for (var i = 0; i < len && off < data.length; i++, off++) {
      label += String.fromCharCode(data[off] & 0xff);
    }
    labels.push(label);
  }
  if (end < 0) end = off;
  return { name: labels.join('.'), end };
}

function parseResponse(data: number[], queryID: number): string | null {
  if (data.length < 12) return null;
  var id     = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
  if (id !== queryID) return null;
  var flags  = ((data[2] & 0xff) << 8) | (data[3] & 0xff);
  var qr     = (flags >> 15) & 1;
  var rcode  = flags & 0xf;
  if (qr !== 1 || rcode !== 0) return null;
  var qdcount = ((data[4] & 0xff) << 8) | (data[5] & 0xff);
  var ancount = ((data[6] & 0xff) << 8) | (data[7] & 0xff);
  if (ancount === 0) return null;

  // Skip questions
  var off = 12;
  for (var i = 0; i < qdcount; i++) {
    var n = decodeName(data, off);
    off = n.end;
    off += 4;  // QTYPE + QCLASS
  }

  // Parse answers
  for (var i = 0; i < ancount; i++) {
    var n = decodeName(data, off);
    off = n.end;
    if (off + 10 > data.length) break;
    var type  = ((data[off] & 0xff) << 8) | (data[off+1] & 0xff); off += 2;
    var cls   = ((data[off] & 0xff) << 8) | (data[off+1] & 0xff); off += 2;
    var ttl   = ((data[off] & 0xff) << 24) | ((data[off+1] & 0xff) << 16) |
                ((data[off+2] & 0xff) << 8)  |  (data[off+3] & 0xff);     off += 4;
    var rdlen = ((data[off] & 0xff) << 8) | (data[off+1] & 0xff);         off += 2;
    if (type === 1 && cls === 1 && rdlen === 4) {
      // A record
      return (data[off] & 0xff) + '.' + (data[off+1] & 0xff) + '.' +
             (data[off+2] & 0xff) + '.' + (data[off+3] & 0xff);
    }
    off += rdlen;
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

// DNS query cache
var dnsCache = new Map<string, string>();

/**
 * Resolve a hostname to an IPv4 address string using the configured DNS server.
 * Returns a dotted-decimal string or null on failure / timeout.
 *
 * @param hostname   DNS name to resolve, e.g. "example.com"
 * @param timeoutTicks  Number of ~10ms PIT ticks to wait (default 300 = ~3 s)
 */
export function dnsResolve(hostname: string, timeoutTicks: number = 300): string | null {
  // Return cached result
  var cached = dnsCache.get(hostname);
  if (cached) return cached;

  // Choose a source port (ephemeral)
  var srcPort = (53000 + (kernel.getTicks() & 0xfff));
  var queryID = (kernel.getTicks() & 0xffff) | 1;

  // Pre-register inbox
  (net as any).udpRxMap.set(srcPort, []);

  // Send query
  var query = buildQuery(queryID, hostname);
  net.sendUDPRaw(srcPort, net.dns, DNS_PORT, query);

  // Wait for response
  var resp = net.recvUDPRaw(srcPort, timeoutTicks);
  if (!resp) return null;

  var ip = parseResponse(resp.data, queryID);
  if (ip) dnsCache.set(hostname, ip);
  return ip;
}
