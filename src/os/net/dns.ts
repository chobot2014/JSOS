/**
 * JSOS DNS Resolver (RFC 1035 / RFC 3596)
 *
 * Full-featured TypeScript resolver:
 *   - TTL-based cache expiry (item 276)
 *   - AAAA (IPv6) record queries (item 277)
 *   - Retransmit on timeout with exponential backoff (item 278)
 *   - Multiple nameserver support with fallback (item 279)
 *   - /etc/hosts lookup before DNS query (item 281)
 *   - CNAME chain resolution up to 10 hops (item 282)
 *   - Negative cache (NXDOMAIN / SERVFAIL cached for 60 s)
 *
 * All DNS protocol logic is in TypeScript; C sees only raw Ethernet frames.
 */

import { net } from './net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

const DNS_PORT   = 53;
const QTYPE_A    = 1;
const QTYPE_AAAA = 28;
const QTYPE_CNAME = 5;
const QCLASS_IN  = 1;
const MAX_CNAME_HOPS = 10;
/** Default per-query timeout in PIT ticks (~10 ms each). */
const DNS_TIMEOUT_TICKS = 100;   // 1 s per attempt
const DNS_RETRIES = 3;

// ── Packet encoder ────────────────────────────────────────────────────────────

function encodeName(name: string): number[] {
  var out: number[] = [];
  var labels = name.split('.');
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (label.length === 0) continue;
    out.push(label.length & 0xff);
    for (var j = 0; j < label.length; j++) out.push(label.charCodeAt(j) & 0xff);
  }
  out.push(0);
  return out;
}

function buildQuery(id: number, hostname: string, qtype: number): number[] {
  var pkt: number[] = [];
  pkt.push((id >> 8) & 0xff, id & 0xff);  // ID
  pkt.push(0x01, 0x00);  // Flags: QR=0 OPCODE=0 RD=1
  pkt.push(0x00, 0x01);  // QDCOUNT = 1
  pkt.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x00); // ANCOUNT NSCOUNT ARCOUNT
  pkt = pkt.concat(encodeName(hostname));
  pkt.push((qtype >> 8) & 0xff, qtype & 0xff);
  pkt.push(0x00, QCLASS_IN);
  return pkt;
}

// ── Packet decoder ────────────────────────────────────────────────────────────

function decodeName(data: number[], off: number): { name: string; end: number } {
  var labels: string[] = [];
  var end = -1;
  var maxIter = 128;
  while (off < data.length && maxIter-- > 0) {
    var len = data[off] & 0xff;
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | (data[off + 1] & 0xff);
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

export interface DnsRecord {
  type:   'A' | 'AAAA' | 'CNAME';
  name:   string;
  value:  string;    // IPv4, IPv6, or CNAME target
  ttl:    number;    // seconds
}

/** Parse all answer RRs from a DNS response packet.
 *  Returns null on protocol error or RCODE != 0/NXDOMAIN.
 *  Returns [] on successful empty answer (NXDOMAIN encoded as rcode).
 */
function parseResponseFull(data: number[], queryID: number): DnsRecord[] | null {
  if (data.length < 12) return null;
  var id = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
  if (id !== queryID) return null;
  var flags  = ((data[2] & 0xff) << 8) | (data[3] & 0xff);
  var qr     = (flags >> 15) & 1;
  var rcode  = flags & 0xf;
  if (qr !== 1) return null;
  // rcode 0 = NOERROR, 3 = NXDOMAIN — both give us valid (possibly empty) answers
  if (rcode !== 0 && rcode !== 3) return null;

  var qdcount = ((data[4]  & 0xff) << 8) | (data[5]  & 0xff);
  var ancount = ((data[6]  & 0xff) << 8) | (data[7]  & 0xff);

  // Skip question section
  var off = 12;
  for (var q = 0; q < qdcount; q++) {
    var n = decodeName(data, off); off = n.end;
    off += 4; // QTYPE + QCLASS
  }

  var records: DnsRecord[] = [];
  for (var a = 0; a < ancount; a++) {
    if (off + 10 > data.length) break;
    var rn   = decodeName(data, off); off = rn.end;
    var rtype  = ((data[off]     & 0xff) << 8) | (data[off + 1] & 0xff); off += 2;
    /*  cls  */ off += 2;
    var rttl   = (((data[off]     & 0xff) * 0x1000000) |
                   ((data[off + 1] & 0xff) << 16) |
                   ((data[off + 2] & 0xff) << 8)  |
                    (data[off + 3] & 0xff)) >>> 0;   off += 4;
    var rdlen  = ((data[off]     & 0xff) << 8) | (data[off + 1] & 0xff); off += 2;
    var rdata  = data.slice(off, off + rdlen); off += rdlen;

    if (rtype === QTYPE_A && rdlen === 4) {
      records.push({
        type: 'A', name: rn.name, ttl: rttl,
        value: (rdata[0] & 0xff) + '.' + (rdata[1] & 0xff) + '.' +
               (rdata[2] & 0xff) + '.' + (rdata[3] & 0xff),
      });
    } else if (rtype === QTYPE_AAAA && rdlen === 16) {
      // Format as full-length hex groups (no :: compression at this layer)
      var groups: string[] = [];
      for (var g = 0; g < 16; g += 2) {
        var hi = (rdata[g] & 0xff).toString(16).padStart(2, '0');
        var lo = (rdata[g + 1] & 0xff).toString(16).padStart(2, '0');
        groups.push(hi + lo);
      }
      records.push({ type: 'AAAA', name: rn.name, ttl: rttl, value: groups.join(':') });
    } else if (rtype === QTYPE_CNAME) {
      var cn = decodeName(rdata, 0);
      records.push({ type: 'CNAME', name: rn.name, ttl: rttl, value: cn.name });
    }
  }
  return records;
}

// ── TTL Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  ip:         string;
  type:       'A' | 'AAAA';
  expiresAt:  number; // kernel.getTicks() value
}

/** Negative cache entry (NXDOMAIN). expiresAt is set to now + 60 s. */
interface NegEntry {
  expiresAt: number;
}

/** Cache key = `${type}:${lowercasedHostname}` */
var dnsCache    = new Map<string, CacheEntry>();
var dnsNegCache = new Map<string, NegEntry>();

function cacheKey(type: 'A' | 'AAAA', hostname: string): string {
  return type + ':' + hostname.toLowerCase();
}

function cachePut(type: 'A' | 'AAAA', hostname: string, ip: string, ttlSec: number): void {
  var ticksPerSec = 100; // PIT ~10 ms per tick → 100 ticks/sec
  dnsCache.set(cacheKey(type, hostname), {
    ip,
    type,
    expiresAt: kernel.getTicks() + ttlSec * ticksPerSec,
  });
  dnsNegCache.delete(cacheKey(type, hostname));
}

function cacheGet(type: 'A' | 'AAAA', hostname: string): string | null {
  var k  = cacheKey(type, hostname);
  var e  = dnsCache.get(k);
  if (!e) return null;
  if (kernel.getTicks() >= e.expiresAt) { dnsCache.delete(k); return null; }
  return e.ip;
}

function negCachePut(type: 'A' | 'AAAA', hostname: string): void {
  var k = cacheKey(type, hostname);
  dnsCache.delete(k);
  dnsNegCache.set(k, { expiresAt: kernel.getTicks() + 60 * 100 }); // 60 s
}

function negCacheGet(type: 'A' | 'AAAA', hostname: string): boolean {
  var k = cacheKey(type, hostname);
  var e = dnsNegCache.get(k);
  if (!e) return false;
  if (kernel.getTicks() >= e.expiresAt) { dnsNegCache.delete(k); return false; }
  return true;
}

// ── /etc/hosts parser ─────────────────────────────────────────────────────────

/** Lookup hostname in /etc/hosts before sending to DNS. */
function hostsLookup(hostname: string): string | null {
  try {
    // Dynamically import fs to avoid circular deps at parse time
    var fsModule = (globalThis as any).fs || null;
    var content: string | null = null;
    if (fsModule && typeof fsModule.readFile === 'function') {
      content = fsModule.readFile('/etc/hosts');
    }
    if (!content) return null;
    var lower = hostname.toLowerCase();
    var lines = content.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line[0] === '#') continue;
      var parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      var ip = parts[0];
      for (var j = 1; j < parts.length; j++) {
        if (parts[j].toLowerCase() === lower) return ip;
      }
    }
  } catch (e) { /* fs not available at this boot stage */ }
  return null;
}

// ── Nameserver list ───────────────────────────────────────────────────────────

/** Configured nameservers — primary + fallbacks.  Updated by DHCP. */
var nameservers: string[] = [];

/** Effective nameserver list: user-set list or fall back to net.dns. */
function getNameservers(): string[] {
  if (nameservers.length > 0) return nameservers;
  return [net.dns];
}

/** Set/replace the nameserver list (called from DHCP or dhcp.ts). */
export function setNameservers(servers: string[]): void {
  nameservers = servers.slice().filter(function(s) { return s && s.length > 0; });
}

// ── Core query function ───────────────────────────────────────────────────────

/**
 * Send a DNS query to `server`, wait up to `timeoutTicks`, retry up to
 * `retries` times with exponential backoff.  Returns parsed records or null.
 */
function queryServer(
  server: string,
  hostname: string,
  qtype: number,
  timeoutTicks: number,
  retries: number
): DnsRecord[] | null {
  var srcPort = 53000 + (kernel.getTicks() & 0xfff);
  var queryID = ((kernel.getTicks() & 0x7fff) | 1) & 0xffff;

  net.openUDPInbox(srcPort);
  try {
    var query = buildQuery(queryID, hostname, qtype);
    var wait  = timeoutTicks;
    var attempt = 0;
    while (attempt <= retries) {
      // (Re-)send query
      net.sendUDPRaw(srcPort, server, DNS_PORT, query);
      var resp = net.recvUDPRaw(srcPort, wait);
      if (resp) {
        var records = parseResponseFull(resp.data, queryID);
        if (records !== null) return records;
      }
      // Back-off: double wait per retry, cap at 8 s
      wait = Math.min(wait * 2, 800);
      attempt++;
    }
  } finally {
    net.closeUDPInbox(srcPort);
  }
  return null;
}

// ── CNAME-chain resolver ──────────────────────────────────────────────────────

/**
 * Resolve `hostname` for `qtype` (A or AAAA), following CNAME chains up to
 * MAX_CNAME_HOPS deep.  Returns the final IP string or null.
 */
function resolveChain(hostname: string, qtype: number, servers: string[]): string | null {
  var type: 'A' | 'AAAA' = (qtype === QTYPE_AAAA) ? 'AAAA' : 'A';
  var name = hostname;

  for (var hop = 0; hop < MAX_CNAME_HOPS; hop++) {
    // Check TTL cache first
    var cached = cacheGet(type, name);
    if (cached) return cached;

    // Check negative cache
    if (negCacheGet(type, name)) return null;

    // /etc/hosts
    var hostsIp = hostsLookup(name);
    if (hostsIp) {
      cachePut(type, name, hostsIp, 3600);
      return hostsIp;
    }

    // Query each nameserver in order until one responds
    var records: DnsRecord[] | null = null;
    for (var si = 0; si < servers.length; si++) {
      records = queryServer(servers[si], name, qtype, DNS_TIMEOUT_TICKS, DNS_RETRIES);
      if (records !== null) break;
    }

    if (records === null) return null;       // all servers timed out
    if (records.length === 0) {              // NXDOMAIN
      negCachePut(type, name);
      return null;
    }

    // Walk records: prefer the desired type, follow CNAME
    var found: string | null = null;
    var cname: string | null = null;
    var minTTL = 86400;
    for (var ri = 0; ri < records.length; ri++) {
      var r = records[ri];
      minTTL = Math.min(minTTL, r.ttl);
      if (r.type === type && r.name.toLowerCase() === name.toLowerCase()) {
        found = r.value;
      } else if (r.type === 'CNAME' && r.name.toLowerCase() === name.toLowerCase()) {
        cname = r.value;
      }
    }

    if (found) {
      cachePut(type, name, found, minTTL);
      return found;
    }

    if (cname) {
      // Cache the CNAME mapping and follow it
      // (We don't store CNAME as A/AAAA; just follow the chain)
      name = cname;
      continue;
    }

    // No useful records
    negCachePut(type, name);
    return null;
  }

  return null;  // exceeded MAX_CNAME_HOPS
}

// ── Public API ────────────────────────────────────────────────────────────────

const _IP4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const _IP6_LITERAL = /^[0-9a-fA-F:]+$/;

/**
 * Resolve a hostname to an IPv4 address.
 * Checks /etc/hosts → TTL cache → DNS with retransmit backoff + CNAME following.
 * Returns dotted-decimal string or null on failure.
 *
 * @param hostname   Name to resolve, e.g. "example.com"
 */
export function dnsResolve(hostname: string): string | null {
  if (_IP4_LITERAL.test(hostname)) return hostname;
  // Normalise
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return resolveChain(hostname, QTYPE_A, getNameservers());
}

/**
 * Resolve a hostname to an IPv6 address string (full hex, no ::).
 * Returns "h:h:h:h:h:h:h:h" or null on failure.
 */
export function dnsResolveAAAA(hostname: string): string | null {
  if (_IP6_LITERAL.test(hostname)) return hostname;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return resolveChain(hostname, QTYPE_AAAA, getNameservers());
}

/**
 * Resolve hostname to either IPv4 or IPv6 (tries A first, then AAAA).
 * Returns an IP string or null.
 */
export function dnsResolveAny(hostname: string): string | null {
  return dnsResolve(hostname) || dnsResolveAAAA(hostname);
}

/**
 * Return cached IP without any network I/O.  Returns null if the entry has
 * expired or was never cached.
 */
export function dnsResolveCached(hostname: string): string | null {
  if (_IP4_LITERAL.test(hostname)) return hostname;
  var n = hostname.toLowerCase();
  return cacheGet('A', n) || cacheGet('AAAA', n);
}

/** Flush the entire DNS cache (useful after DHCP lease renewal). */
export function dnsFlushCache(): void {
  dnsCache.clear();
  dnsNegCache.clear();
}

/** Return a snapshot of all cached entries (for diagnostics). */
export function dnsCacheSnapshot(): Array<{ key: string; ip: string; ttlLeft: number }> {
  var now  = kernel.getTicks();
  var rows: Array<{ key: string; ip: string; ttlLeft: number }> = [];
  dnsCache.forEach(function(e, k) {
    rows.push({ key: k, ip: e.ip, ttlLeft: Math.max(0, Math.floor((e.expiresAt - now) / 100)) });
  });
  return rows;
}

// ── Async (non-blocking) DNS helpers ─────────────────────────────────────────
// Kept for backwards-compat with the browser HTTP pipeline.

/**
 * Fire-and-forget A-record query.  Returns { port, id } for poll/cancel.
 */
export function dnsSendQueryAsync(hostname: string): { port: number; id: number } {
  var srcPort = 53000 + (kernel.getTicks() & 0xfff);
  var queryID = ((kernel.getTicks() & 0x7fff) | 1) & 0xffff;
  net.openUDPInbox(srcPort);
  net.sendUDPRaw(srcPort, getNameservers()[0] || net.dns, DNS_PORT,
    buildQuery(queryID, hostname, QTYPE_A));
  return { port: srcPort, id: queryID };
}

/**
 * Non-blocking poll for a pending async DNS reply.  Call once per frame.
 * Returns resolved IPv4 string on success (and caches it), or null.
 */
export function dnsPollReplyAsync(hostname: string, port: number, id: number): string | null {
  var pkt = net.recvUDPRawNB(port);
  if (!pkt) return null;
  var records = parseResponseFull(pkt.data, id);
  if (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'A') {
        cachePut('A', hostname, r.value, r.ttl);
        net.closeUDPInbox(port);
        return r.value;
      }
    }
  }
  net.closeUDPInbox(port);
  return null;
}

/** Cancel an in-flight async DNS query and free the UDP inbox. */
export function dnsCancelAsync(port: number): void {
  net.closeUDPInbox(port);
}
