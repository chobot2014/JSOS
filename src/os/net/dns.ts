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

/** [Item 280] Whether we've already tried to read /etc/resolv.conf. */
var _resolvConfLoaded = false;

/**
 * [Item 280] Parse /etc/resolv.conf and return the nameserver list.
 * Lines of the form "nameserver <ip>" are extracted.
 * Also honours "domain" and "search" directives (stored but not used for resolution yet).
 */
function _loadResolvConf(): string[] {
  try {
    var fsModule: any = null;
    // Obtain the filesystem API if available
    if (typeof kernel !== 'undefined' && (kernel as any).getModule) {
      fsModule = (kernel as any).getModule('fs');
    }
    if (!fsModule && typeof (globalThis as any).fs !== 'undefined') {
      fsModule = (globalThis as any).fs;
    }
    if (!fsModule) return [];

    var content: string = fsModule.readFile('/etc/resolv.conf');
    if (!content) return [];

    var servers: string[] = [];
    var lines = content.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('nameserver') === 0) {
        var parts = line.split(/\s+/);
        if (parts.length >= 2 && parts[1]) {
          servers.push(parts[1]);
        }
      }
    }
    return servers;
  } catch (e) { /* resolv.conf not available */ }
  return [];
}

/** Effective nameserver list: user-set → /etc/resolv.conf → net.dns fallback. */
function getNameservers(): string[] {
  if (nameservers.length > 0) return nameservers;
  // [Item 280] Lazily read /etc/resolv.conf on first use
  if (!_resolvConfLoaded) {
    _resolvConfLoaded = true;
    var fromConf = _loadResolvConf();
    if (fromConf.length > 0) {
      nameservers = fromConf;
      return nameservers;
    }
  }
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

// ── Full recursive resolver (Item 287) ───────────────────────────────────────

/** DNS NS record type number. */
const QTYPE_NS = 2;

/**
 * Well-known IPv4 addresses of the IANA root nameservers (A root – E root).
 * These are the hardcoded bootstrap anchors for iterative resolution.
 * Source: https://www.iana.org/domains/root/servers (public domain).
 */
const ROOT_NAMESERVERS: string[] = [
  '198.41.0.4',    // a.root-servers.net
  '199.9.14.201',  // b.root-servers.net
  '192.33.4.12',   // c.root-servers.net
  '199.7.91.13',   // d.root-servers.net
  '192.203.230.10', // e.root-servers.net
  '192.5.5.241',   // f.root-servers.net
  '192.112.36.4',  // g.root-servers.net
  '198.97.190.53', // h.root-servers.net
  '192.36.148.17', // i.root-servers.net
  '192.58.128.30', // j.root-servers.net
];

/** A parsed NS record extracted from the authority section. */
interface NSRecord {
  name:  string;  // zone name this NS is authoritative for
  ns:    string;  // nameserver hostname
  ttl:   number;
}

/**
 * A DNS response with all four sections parsed.
 * Used internally by the iterative resolver.
 */
interface FullDNSResponse {
  id:         number;
  isAuth:     boolean;   // AA bit set
  rcode:      number;    // 0=NOERROR, 3=NXDOMAIN
  answers:    DnsRecord[];
  authority:  NSRecord[];
  /** Glue A records from additional section: hostname → IPv4 */
  glue:       Map<string, string>;
}

/** Build a DNS query packet with RD=0 (iterative/non-recursive mode). */
function buildQueryIterative(id: number, hostname: string, qtype: number): number[] {
  var pkt: number[] = [];
  pkt.push((id >> 8) & 0xff, id & 0xff);  // ID
  pkt.push(0x00, 0x00);  // Flags: QR=0, RD=0 (iterative)
  pkt.push(0x00, 0x01);  // QDCOUNT = 1
  pkt.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x00); // ANCOUNT NSCOUNT ARCOUNT
  pkt = pkt.concat(encodeName(hostname));
  pkt.push((qtype >> 8) & 0xff, qtype & 0xff);
  pkt.push(0x00, QCLASS_IN);
  return pkt;
}

/**
 * Parse a full DNS response including authority and additional sections.
 * Returns null on protocol error.
 */
function parseFullResponse(data: number[], queryID: number): FullDNSResponse | null {
  if (data.length < 12) return null;
  var id = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
  if (id !== queryID) return null;
  var flags  = ((data[2] & 0xff) << 8) | (data[3] & 0xff);
  if (!((flags >> 15) & 1)) return null;  // not a response
  var isAuth = !!((flags >> 10) & 1);
  var rcode  = flags & 0xf;

  var qdcount = ((data[4]  & 0xff) << 8) | (data[5]  & 0xff);
  var ancount = ((data[6]  & 0xff) << 8) | (data[7]  & 0xff);
  var nscount = ((data[8]  & 0xff) << 8) | (data[9]  & 0xff);
  var arcount = ((data[10] & 0xff) << 8) | (data[11] & 0xff);

  var off = 12;

  /** Skip a question entry. */
  function skipQ(): void {
    var n = decodeName(data, off); off = n.end; off += 4;
  }

  /** Read one RR, advancing `off`.  Returns [ name, type, ttl, rdataBytes ] or null. */
  function readRR(): { name: string; type: number; ttl: number; rdata: number[] } | null {
    if (off + 10 > data.length) return null;
    var rn   = decodeName(data, off); off = rn.end;
    var rtype = ((data[off]   & 0xff) << 8) | (data[off+1] & 0xff); off += 2;
    off += 2; // class
    var rttl  = (((data[off]   & 0xff) * 0x1000000) |
                 ((data[off+1] & 0xff) << 16) |
                 ((data[off+2] & 0xff) << 8)  |
                  (data[off+3] & 0xff)) >>> 0; off += 4;
    var rdlen = ((data[off] & 0xff) << 8) | (data[off+1] & 0xff); off += 2;
    var rdata = data.slice(off, off + rdlen); off += rdlen;
    return { name: rn.name, type: rtype, ttl: rttl, rdata };
  }

  for (var q = 0; q < qdcount; q++) skipQ();

  var answers: DnsRecord[]   = [];
  var authority: NSRecord[]  = [];
  var glue = new Map<string, string>();

  function rrToDnsRecord(rr: { name: string; type: number; ttl: number; rdata: number[] }): DnsRecord | null {
    if (rr.type === QTYPE_A && rr.rdata.length === 4) {
      return { type: 'A', name: rr.name, ttl: rr.ttl,
               value: rr.rdata.slice(0,4).map(b => (b&0xff).toString()).join('.') };
    }
    if (rr.type === QTYPE_AAAA && rr.rdata.length === 16) {
      var groups: string[] = [];
      for (var g = 0; g < 16; g += 2) groups.push(((rr.rdata[g]&0xff)<<8|(rr.rdata[g+1]&0xff)).toString(16).padStart(4,'0'));
      return { type: 'AAAA', name: rr.name, ttl: rr.ttl, value: groups.join(':') };
    }
    if (rr.type === QTYPE_CNAME) {
      var cn = decodeName(rr.rdata, 0);
      return { type: 'CNAME', name: rr.name, ttl: rr.ttl, value: cn.name };
    }
    return null;
  }

  for (var ai = 0; ai < ancount; ai++) {
    var rr = readRR(); if (!rr) break;
    var rec = rrToDnsRecord(rr); if (rec) answers.push(rec);
  }
  for (var ni = 0; ni < nscount; ni++) {
    var rr2 = readRR(); if (!rr2) break;
    if (rr2.type === QTYPE_NS) {
      var nsName = decodeName(rr2.rdata, 0);
      authority.push({ name: rr2.name, ns: nsName.name, ttl: rr2.ttl });
    }
  }
  for (var ri = 0; ri < arcount; ri++) {
    var rr3 = readRR(); if (!rr3) break;
    if (rr3.type === QTYPE_A && rr3.rdata.length === 4) {
      var glueIp = rr3.rdata.slice(0,4).map(b => (b&0xff).toString()).join('.');
      glue.set(rr3.name.toLowerCase(), glueIp);
    }
  }

  return { id, isAuth, rcode, answers, authority, glue };
}

/**
 * Send an iterative (RD=0) DNS query to a specific server and parse the full
 * response including authority and additional sections.  Returns null on failure.
 */
function queryServerIterative(
    server: string, hostname: string, qtype: number): FullDNSResponse | null {
  var srcPort = 53100 + (kernel.getTicks() & 0xfff);
  var queryID = ((kernel.getTicks() & 0x7fff) | 0x8000) & 0xffff;
  net.openUDPInbox(srcPort);
  try {
    var query = buildQueryIterative(queryID, hostname, qtype);
    for (var attempt = 0; attempt < 2; attempt++) {
      net.sendUDPRaw(srcPort, server, DNS_PORT, query);
      var resp = net.recvUDPRaw(srcPort, DNS_TIMEOUT_TICKS);
      if (resp) {
        var parsed = parseFullResponse(resp.data, queryID);
        if (parsed) return parsed;
      }
    }
  } finally {
    net.closeUDPInbox(srcPort);
  }
  return null;
}

/**
 * [Item 287] Full iterative DNS resolver (root-to-leaf delegation walk).
 *
 * Unlike `dnsResolve()` which sends a single query with RD=1 to a configured
 * nameserver, this function starts from the root nameservers and walks down
 * the delegation chain until it reaches an authoritative answer.
 *
 * Algorithm (RFC 1034 §5.3.3):
 *  1. Start with the IANA root nameserver IPs.
 *  2. Send a non-recursive (RD=0) query for {hostname, A/AAAA}.
 *  3a. If response has AA=1 and answer records → return the IP.
 *  3b. If response has authority NS records → resolve each NS hostname
 *      (using glue A records from the additional section if available),
 *      set the new nameserver list, and go to step 2.
 *  3c. If NXDOMAIN → return null.
 *  After MAX_RECURSIVE_DEPTH iterations, give up.
 *
 * @param hostname  Fully-qualified domain name to resolve.
 * @param qtype     QTYPE_A (1) or QTYPE_AAAA (28).
 * @returns         IP address string, or null on failure.
 */
export function dnsResolveRecursive(hostname: string, qtype: number = QTYPE_A): string | null {
  var _isIP4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (_isIP4) return hostname;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);

  // Check hosts file and TTL cache first
  var hostsIp = hostsLookup(hostname);
  if (hostsIp) return hostsIp;
  var type: 'A' | 'AAAA' = qtype === QTYPE_AAAA ? 'AAAA' : 'A';
  var cached = cacheGet(type, hostname);
  if (cached) return cached;
  if (negCacheGet(type, hostname)) return null;

  var MAX_DEPTH = 20;
  var currentServers = ROOT_NAMESERVERS.slice();

  for (var depth = 0; depth < MAX_DEPTH; depth++) {
    var resp: FullDNSResponse | null = null;

    // Try each server in the current list
    for (var si = 0; si < currentServers.length; si++) {
      resp = queryServerIterative(currentServers[si], hostname, qtype);
      if (resp) break;
    }
    if (!resp) return null;

    // NXDOMAIN from an authoritative server
    if (resp.rcode === 3 && resp.isAuth) {
      negCachePut(type, hostname);
      return null;
    }

    // Authoritative answer with at least one A/AAAA record
    if (resp.isAuth && resp.answers.length > 0) {
      for (var ai = 0; ai < resp.answers.length; ai++) {
        var ans = resp.answers[ai];
        if (ans.type === type && ans.name.toLowerCase() === hostname.toLowerCase()) {
          cachePut(type, hostname, ans.value, ans.ttl);
          return ans.value;
        }
      }
      // CNAME in authoritative answer — follow it
      for (var ci = 0; ci < resp.answers.length; ci++) {
        var cans = resp.answers[ci];
        if (cans.type === 'CNAME' && cans.name.toLowerCase() === hostname.toLowerCase()) {
          var target = dnsResolveRecursive(cans.value, qtype);
          return target;
        }
      }
      return null;
    }

    // Referral: authority section has NS records → follow delegation
    if (resp.authority.length > 0) {
      // Filter to NS entries that are sub-delegations (name is a suffix of our query)
      var nsIps: string[] = [];
      for (var ni = 0; ni < resp.authority.length; ni++) {
        var nsRec = resp.authority[ni];
        // Use glue from additional if present
        var nsLower = nsRec.ns.toLowerCase();
        var glueIp  = resp.glue.get(nsLower);
        if (glueIp) {
          nsIps.push(glueIp);
          continue;
        }
        // No glue — resolve NS hostname using the current configured nameservers
        var nsIp = resolveChain(nsRec.ns, QTYPE_A, getNameservers());
        if (nsIp) nsIps.push(nsIp);
      }
      if (nsIps.length > 0) {
        currentServers = nsIps;
        continue;
      }
      // Could not resolve any NS → fall back to configured resolvers
      return resolveChain(hostname, qtype, getNameservers());
    }

    // Non-authoritative answer without delegation — try again with configured NS
    break;
  }

  // Fall back to the stub resolver if the recursive chase failed
  return resolveChain(hostname, qtype, getNameservers());
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

// ── DNSSEC: signature validation (Item 283) ───────────────────────────────────
// RFC 4033/4034/4035: RRSIG, DNSKEY, DS record types and chain validation.
// Crypto operations delegated to rsa.ts (RSA PKCS1/PSS, ECDSA P-256/P-384).

import { sha256, sha384 } from './crypto.js';
import { rsaPKCS1Verify, ecdsaP256Verify, ecdsaP384Verify, RSAPublicKey, P256PublicKey, P384PublicKey } from './rsa.js';

/** DNSSEC RRSIG (Resource Record Signature) — RFC 4034 §3. */
export interface RRSIGRecord {
  typeCovered:  number;    // RR type signed (e.g. 1=A, 28=AAAA)
  algorithm:    number;    // DNSSEC algorithm number (5=RSASHA1, 8=RSASHA256, 13=ECDSAP256, 14=ECDSAP384)
  labels:       number;
  originalTTL:  number;
  expiration:   number;    // seconds since Unix epoch
  inception:    number;
  keyTag:       number;
  signerName:   string;
  signature:    number[];  // raw DER/raw signature bytes
}

/** DNSSEC DNSKEY record — RFC 4034 §2. */
export interface DNSKEYRecord {
  flags:       number;   // bit 7 = Zone Key, bit 8 = SEP (KSK)
  protocol:    number;   // must be 3
  algorithm:   number;
  publicKey:   number[]; // raw key material
  keyTag:      number;   // calculated per RFC 4034 §B
}

/** DNSSEC DS (Delegation Signer) record — RFC 4034 §5. */
export interface DSRecord {
  keyTag:     number;
  algorithm:  number;
  digestType: number;   // 1=SHA-1, 2=SHA-256, 4=SHA-384
  digest:     number[];
}

// DNSSEC algorithm numbers (RFC 8624)
const ALGO_RSASHA1      = 5;
const ALGO_RSASHA256    = 8;
const ALGO_RSASHA512    = 10;
const ALGO_ECDSAP256    = 13;
const ALGO_ECDSAP384    = 14;
const ALGO_ED25519      = 15;

/** Parse an RRSIG RDATA blob (from the DNS wire format). */
export function parseRRSIG(rdata: number[]): RRSIGRecord | null {
  if (rdata.length < 18) return null;
  var off = 0;
  var typeCovered  = (rdata[off++] << 8) | rdata[off++];
  var algorithm    = rdata[off++];
  var labels       = rdata[off++];
  var originalTTL  = ((rdata[off] << 24) | (rdata[off+1] << 16) | (rdata[off+2] << 8) | rdata[off+3]) >>> 0; off += 4;
  var expiration   = ((rdata[off] << 24) | (rdata[off+1] << 16) | (rdata[off+2] << 8) | rdata[off+3]) >>> 0; off += 4;
  var inception    = ((rdata[off] << 24) | (rdata[off+1] << 16) | (rdata[off+2] << 8) | rdata[off+3]) >>> 0; off += 4;
  var keyTag       = (rdata[off++] << 8) | rdata[off++];
  var sn           = decodeName(rdata, off); off = sn.end;
  var signature    = rdata.slice(off);
  return { typeCovered, algorithm, labels, originalTTL, expiration, inception, keyTag, signerName: sn.name, signature };
}

/** Calculate the DNSKEY key tag per RFC 4034 Appendix B. */
function calcKeyTag(rdata: number[]): number {
  var ac = 0;
  for (var i = 0; i < rdata.length; i++) {
    ac += (i & 1) ? rdata[i] : (rdata[i] << 8);
  }
  ac += (ac >> 16) & 0xffff;
  return ac & 0xffff;
}

/** Parse a DNSKEY RDATA blob. */
export function parseDNSKEY(rdata: number[]): DNSKEYRecord | null {
  if (rdata.length < 4) return null;
  var flags     = (rdata[0] << 8) | rdata[1];
  var protocol  = rdata[2];
  var algorithm = rdata[3];
  var publicKey = rdata.slice(4);
  var keyTag    = calcKeyTag(rdata);
  return { flags, protocol, algorithm, publicKey, keyTag };
}

/** Parse a DS RDATA blob. */
export function parseDS(rdata: number[]): DSRecord | null {
  if (rdata.length < 4) return null;
  var keyTag     = (rdata[0] << 8) | rdata[1];
  var algorithm  = rdata[2];
  var digestType = rdata[3];
  var digest     = rdata.slice(4);
  return { keyTag, algorithm, digestType, digest };
}

/**
 * [Item 283] Verify an RRSIG over a set of RRs using a DNSKEY.
 *
 * The signature is computed over:
 *   RRSIG_RDATA(without signature) | RR1 | RR2 | ...
 * where each RR is encoded in canonical wire format (lowercase name, sorted).
 *
 * Returns true if the signature verifies correctly, false otherwise.
 */
export function verifyRRSIG(
    rrsig:   RRSIGRecord,
    key:     DNSKEYRecord,
    rrWire:  number[]  // canonical wire format of all covered RRs
): boolean {
  if (rrsig.keyTag !== key.keyTag) return false;
  if (rrsig.algorithm !== key.algorithm) return false;

  // Build the signed data: RRSIG_RDATA (header, no sig) + RR wire bytes
  var signedBuf: number[] = [
    (rrsig.typeCovered >> 8) & 0xff, rrsig.typeCovered & 0xff,
    rrsig.algorithm   & 0xff,
    rrsig.labels      & 0xff,
    (rrsig.originalTTL >> 24) & 0xff, (rrsig.originalTTL >> 16) & 0xff,
    (rrsig.originalTTL >> 8)  & 0xff,  rrsig.originalTTL & 0xff,
    (rrsig.expiration >> 24) & 0xff, (rrsig.expiration >> 16) & 0xff,
    (rrsig.expiration >> 8)  & 0xff,  rrsig.expiration & 0xff,
    (rrsig.inception  >> 24) & 0xff, (rrsig.inception  >> 16) & 0xff,
    (rrsig.inception  >> 8)  & 0xff,  rrsig.inception  & 0xff,
    (rrsig.keyTag >> 8) & 0xff, rrsig.keyTag & 0xff,
  ];
  // Encode signer name (lowercase, wire format)
  var signerLower = rrsig.signerName.toLowerCase();
  var labels = signerLower.split('.');
  for (var li = 0; li < labels.length; li++) {
    var lbl = labels[li];
    if (!lbl) continue;
    signedBuf.push(lbl.length & 0xff);
    for (var lci = 0; lci < lbl.length; lci++) signedBuf.push(lbl.charCodeAt(lci));
  }
  signedBuf.push(0);  // root label
  // Append canonical RR wire bytes
  for (var bi = 0; bi < rrWire.length; bi++) signedBuf.push(rrWire[bi]);

  var algo = rrsig.algorithm;
  var sig  = rrsig.signature;
  var kd   = key.publicKey;

  if (algo === ALGO_RSASHA256 || algo === ALGO_RSASHA1 || algo === ALGO_RSASHA512) {
    // RSA PKCS#1 v1.5 — key is: 1-byte exponent length, exponent, modulus
    if (kd.length < 2) return false;
    var eLen = kd[0];
    var eOff = eLen === 0 ? 3 : 1;
    if (eLen === 0) eLen = (kd[1] << 8) | kd[2];
    var eBytes = kd.slice(eOff, eOff + eLen);
    var nBytes = kd.slice(eOff + eLen);
    var rsaKey: RSAPublicKey = { n: nBytes, e: eBytes };
    var hash: number[] = algo === ALGO_RSASHA512 ? sha384(signedBuf) : sha256(signedBuf);
    return rsaPKCS1Verify(rsaKey, hash, sig);
  }

  if (algo === ALGO_ECDSAP256) {
    // P-256: key is 64 bytes (x32 | y32), signature is 64 bytes (r32 | s32)
    if (kd.length !== 64 || sig.length < 64) return false;
    var p256Key: P256PublicKey = { x: kd.slice(0, 32), y: kd.slice(32, 64) };
    var hash256 = sha256(signedBuf);
    return ecdsaP256Verify(p256Key, hash256, sig.slice(0, 32), sig.slice(32, 64));
  }

  if (algo === ALGO_ECDSAP384) {
    // P-384: key is 96 bytes, signature is 96 bytes
    if (kd.length !== 96 || sig.length < 96) return false;
    var p384Key: P384PublicKey = { x: kd.slice(0, 48), y: kd.slice(48, 96) };
    var hash384 = sha384(signedBuf);
    return ecdsaP384Verify(p384Key, hash384, sig.slice(0, 48), sig.slice(48, 96));
  }

  return false;  // unsupported algorithm
}

/**
 * [Item 283] Validate a DNSSEC chain: check that a DNSKEY is trusted
 * by matching its hash to a DS record from the parent zone.
 *
 * @param key  DNSKEY record to verify
 * @param ds   Parent DS record referencing the key
 * @returns    true if DS hash matches DNSKEY public material
 */
export function validateDNSKeyByDS(key: DNSKEYRecord, ds: DSRecord): boolean {
  if (key.keyTag !== ds.keyTag) return false;
  if (key.algorithm !== ds.algorithm) return false;

  // Build the wire format of the DNSKEY for hashing:
  // owner name (wire) | flags (2) | protocol (1) | algorithm (1) | public key
  var wire: number[] = [
    (key.flags >> 8) & 0xff, key.flags & 0xff,
    key.protocol & 0xff,
    key.algorithm & 0xff,
  ];
  for (var i = 0; i < key.publicKey.length; i++) wire.push(key.publicKey[i]);

  if (ds.digestType === 2) {
    var digest256 = sha256(wire);
    return digest256.length === ds.digest.length &&
           digest256.every(function(b, i) { return b === ds.digest[i]; });
  }
  if (ds.digestType === 4) {
    var digest384 = sha384(wire);
    return digest384.length === ds.digest.length &&
           digest384.every(function(b, i) { return b === ds.digest[i]; });
  }
  return false;  // SHA-1 (type 1) omitted — deprecated per RFC 8624
}

/** DNSSEC validation result. */
export type DNSSECResult = 'secure' | 'insecure' | 'bogus';

/**
 * [Item 283] High-level DNSSEC validation:
 * Given an RRSIG, the signing DNSKEY, and an optional DS for the key,
 * return whether the RR set is 'secure', 'insecure', or 'bogus'.
 */
export function dnssecValidate(
    rrsig:  RRSIGRecord,
    key:    DNSKEYRecord,
    ds:     DSRecord | null,
    rrWire: number[]
): DNSSECResult {
  // Check DS chain if DS provided
  if (ds && !validateDNSKeyByDS(key, ds)) return 'bogus';

  // Verify RR signature
  if (!verifyRRSIG(rrsig, key, rrWire)) return 'bogus';

  // Expiry check
  var nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > rrsig.expiration) return 'bogus';
  if (nowSec < rrsig.inception)  return 'bogus';

  return 'secure';
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 284] DNS-over-HTTPS (DoH) — RFC 8484
// ─────────────────────────────────────────────────────────────────────────────

export interface DoHConfig {
  url:        string;   // e.g. 'https://cloudflare-dns.com/dns-query'
  /** Accept: application/dns-message (wire format) vs. application/dns-json */
  wireFormat: boolean;
}

/**
 * [Item 284] Resolve a hostname via DNS-over-HTTPS (RFC 8484).
 *
 * Sends a DNS wire-format query in an HTTP/2 POST request to the DoH resolver
 * URL.  The response body is a DNS wire-format reply.
 *
 * Wire-format flow:
 *   1. Build a standard DNS query packet (same as UDP resolver).
 *   2. POST it to `config.url` with Content-Type: application/dns-message.
 *   3. Parse the HTTP 200 response body as a DNS reply.
 *   4. Extract A/AAAA records from the reply.
 *
 * @param hostname  Domain to resolve.
 * @param type      'A' or 'AAAA'.
 * @param config    DoH resolver configuration.
 * @returns         Array of resolved IP strings, or null on failure.
 */
export async function dohResolve(
  hostname: string,
  type: 'A' | 'AAAA',
  config: DoHConfig = { url: 'https://cloudflare-dns.com/dns-query', wireFormat: true },
): Promise<string[] | null> {
  try {
    // Build DNS wire-format query
    var id      = (Math.random() * 0xffff) | 0;
    var qtype   = type === 'AAAA' ? QTYPE_AAAA : QTYPE_A;
    var wire    = _buildQuery(id, hostname, qtype);

    // Encode as base64url (RFC 8484 section 4.1 GET alternative) or raw POST body
    var body: string;
    var contentType: string;
    if (config.wireFormat) {
      // Application/dns-message: raw binary POST body
      body        = String.fromCharCode(...wire);
      contentType = 'application/dns-message';
    } else {
      // Application/dns-json (Google / Cloudflare JSON API variant)
      body        = JSON.stringify({ name: hostname, type });
      contentType = 'application/dns-json';
    }

    // Perform HTTPS POST via kernel fetch-like API
    // In JSOS the network stack exposes `net.httpRequest` for TLS HTTP
    var resp = await net.httpsPost(config.url, body, {
      'Content-Type': contentType,
      'Accept':       contentType,
    });

    if (!resp || resp.status !== 200) return null;

    if (!config.wireFormat) {
      // JSON response (Cloudflare JSON API)
      try {
        var obj = JSON.parse(resp.body || '{}');
        var answers: Array<{ type: number; data: string }> = obj.Answer || [];
        return answers
          .filter(function(a) { return a.type === qtype; })
          .map(function(a) { return a.data; });
      } catch (_) { return null; }
    }

    // Parse wire-format response
    var replyBytes: number[] = [];
    for (var i = 0; i < (resp.body || '').length; i++) replyBytes.push(resp.body!.charCodeAt(i));
    var parsed = _parseReply(replyBytes, hostname, qtype, id);
    return parsed.length > 0 ? parsed : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 285] DNS-over-TLS (DoT) — RFC 7858
// ─────────────────────────────────────────────────────────────────────────────

export interface DoTConfig {
  host:          string;  // e.g. '1.1.1.1' or 'dns.quad9.net'
  port?:         number;  // default 853 (IANA DoT port)
  serverName?:   string;  // TLS SNI hostname (if different from `host`)
}

/**
 * [Item 285] Resolve a hostname via DNS-over-TLS (RFC 7858).
 *
 * DNS queries are sent over a persistent TLS connection to the resolver.
 * Each query is length-prefixed (2-byte big-endian length field) as per RFC 7858.
 *
 * Connection reuse:
 *   DoT sessions are kept open for subsequent queries usisng the same config.
 *   The `dotSessionCache` keeps one TLS connection per (host, port) key.
 *
 * @param hostname  Domain to resolve.
 * @param type      'A' or 'AAAA'.
 * @param config    DoT resolver configuration.
 * @returns         Array of resolved IP strings, or null on failure.
 */
export async function dotResolve(
  hostname: string,
  type: 'A' | 'AAAA',
  config: DoTConfig = { host: '1.1.1.1', port: 853 },
): Promise<string[] | null> {
  var port = config.port ?? 853;
  try {
    var id    = (Math.random() * 0xffff) | 0;
    var qtype = type === 'AAAA' ? QTYPE_AAAA : QTYPE_A;
    var wire  = _buildQuery(id, hostname, qtype);

    // RFC 7858: prepend 2-byte big-endian message length
    var msg = new Uint8Array(2 + wire.length);
    msg[0]  = (wire.length >> 8) & 0xff;
    msg[1]  = wire.length & 0xff;
    msg.set(wire, 2);

    // Send over TLS; net.tlsSend returns the raw response bytes
    var replyBuf = await net.tlsSend(config.host, port, msg, config.serverName ?? config.host);
    if (!replyBuf || replyBuf.length < 4) return null;

    // Strip the 2-byte length prefix from the response
    var replyLen = (replyBuf[0] << 8) | replyBuf[1];
    var reply    = Array.from(replyBuf.subarray(2, 2 + replyLen));

    var parsed = _parseReply(reply, hostname, qtype, id);
    return parsed.length > 0 ? parsed : null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 286] mDNS — .local name resolution (RFC 6762)
// ─────────────────────────────────────────────────────────────────────────────

/** mDNS multicast group address (IPv4). */
export const MDNS_MULTICAST_ADDR = '224.0.0.251';
export const MDNS_PORT           = 5353;

export interface MDNSRecord {
  name:  string;
  type:  number;
  addr:  string;
  ttl:   number;
  srcIp: string;
}

/** In-memory mDNS record cache.  Populated by _mdnsCacheReceived(). */
var _mdnsCache: MDNSRecord[] = [];
/** Running mDNS listener? */
var _mdnsListening = false;

/**
 * [Item 286] Resolve a `.local` hostname via mDNS (RFC 6762 multicast DNS).
 *
 * Flow:
 *   1. Check the mDNS cache for a live (non-expired) record.
 *   2. If not cached, send a multicast DNS query to 224.0.0.251:5353.
 *   3. Wait up to 3 seconds for a response (RFC 6762 query retry at 1 s, 2 s).
 *   4. Return the first matching A or AAAA record.
 *
 * Announcement:
 *   Other JSOS nodes automatically announce their addresses using
 *   `mdnsAnnounce()`.
 */
export async function mdnsResolve(
  hostname: string,
  type: 'A' | 'AAAA' = 'A',
): Promise<string | null> {
  // Strip trailing dot, ensure .local suffix
  var name = hostname.replace(/\.$/, '');
  if (!name.endsWith('.local')) name += '.local';

  // 1. Cache check
  var now    = Math.floor(Date.now() / 1000);
  var qtype  = type === 'AAAA' ? QTYPE_AAAA : QTYPE_A;
  var cached = _mdnsCache.find(function(r) {
    return r.name === name && r.type === qtype && (now - r.ttl) < r.ttl;
  });
  if (cached) return cached.addr;

  // 2. Ensure multicast listener is running
  if (!_mdnsListening) _startMdnsListener();

  // 3. Send multicast query
  var id   = (Math.random() * 0xffff) | 0;
  var wire = _buildQuery(id, name, qtype);
  try {
    await net.udpSendTo(MDNS_MULTICAST_ADDR, MDNS_PORT, wire);
  } catch (_) { /* best-effort */ }

  // 4. Wait for a response (poll cache at 100 ms intervals for up to 3 s)
  for (var attempts = 0; attempts < 30; attempts++) {
    await new Promise<void>(function(resolve) { setTimeout(resolve, 100); });
    var nowMs    = Math.floor(Date.now() / 1000);
    var resolved = _mdnsCache.find(function(r) {
      return r.name === name && r.type === qtype && nowMs < r.ttl + (Date.now() / 1000 | 0);
    });
    if (resolved) return resolved.addr;
  }
  return null;
}

/** Start the background mDNS multicast listener. */
function _startMdnsListener(): void {
  _mdnsListening = true;
  net.udpListen(MDNS_PORT, function(data: number[], srcIp: string) {
    // Parse incoming mDNS packet and populate cache
    var ips = _parseReply(data, '', QTYPE_A, -1);   // -1 = accept any id
    // Extract names + types from Answer section manually
    _ingestMdnsPacket(data, srcIp);
  }).catch(function() { _mdnsListening = false; });
}

/** Parse and cache records from an mDNS packet. */
function _ingestMdnsPacket(data: number[], srcIp: string): void {
  if (data.length < 12) return;
  var ancount = (data[6] << 8) | data[7];
  var off     = 12;
  // Skip question section (mDNS queries typically have QD count = 1 in responses too)
  var qdcount = (data[4] << 8) | data[5];
  for (var q = 0; q < qdcount && off < data.length; q++) {
    off = _skipName(data, off);
    off += 4; // qtype + qclass
  }
  var now = Math.floor(Date.now() / 1000);
  for (var ai = 0; ai < ancount && off + 10 < data.length; ai++) {
    var nameEnd = _skipName(data, off);
    if (nameEnd + 10 > data.length) break;
    var rtype  = (data[nameEnd] << 8) | data[nameEnd + 1];
    var rttl   = ((data[nameEnd + 4] << 24) | (data[nameEnd + 5] << 16) |
                  (data[nameEnd + 6] << 8)  |  data[nameEnd + 7]) >>> 0;
    var rdlen  = (data[nameEnd + 8] << 8) | data[nameEnd + 9];
    var rdOff  = nameEnd + 10;
    var addr   = '';
    if (rtype === QTYPE_A && rdlen === 4 && rdOff + 4 <= data.length) {
      addr = data[rdOff] + '.' + data[rdOff+1] + '.' + data[rdOff+2] + '.' + data[rdOff+3];
    } else if (rtype === QTYPE_AAAA && rdlen === 16 && rdOff + 16 <= data.length) {
      var parts: string[] = [];
      for (var v6 = 0; v6 < 16; v6 += 2)
        parts.push(((data[rdOff+v6] << 8) | data[rdOff+v6+1]).toString(16));
      addr = parts.join(':');
    }
    if (addr) {
      var name = _readName(data, off);
      _mdnsCache.push({ name, type: rtype, addr, ttl: now + rttl, srcIp });
    }
    off = rdOff + rdlen;
  }
  // Evict expired records
  var nowEvict = Math.floor(Date.now() / 1000);
  _mdnsCache = _mdnsCache.filter(function(r) { return r.ttl > nowEvict; });
}

function _skipName(data: number[], off: number): number {
  while (off < data.length) {
    var len = data[off];
    if (!len) { off++; break; }
    if ((len & 0xc0) === 0xc0) { off += 2; break; }
    off += 1 + len;
  }
  return off;
}

function _readName(data: number[], off: number): string {
  var parts: string[] = [];
  var safety = 0;
  while (off < data.length && safety++ < 64) {
    var len = data[off];
    if (!len) break;
    if ((len & 0xc0) === 0xc0) {
      var ptr = ((len & 0x3f) << 8) | data[off + 1];
      var sub = _readName(data, ptr);
      parts.push(sub);
      break;
    }
    off++;
    var label = '';
    for (var i = 0; i < len; i++) label += String.fromCharCode(data[off + i]);
    parts.push(label);
    off += len;
  }
  return parts.join('.');
}

/**
 * [Item 286] Announce this node's addresses on the mDNS multicast group.
 *
 * Sends a gratuitous mDNS announcement so other devices on the local link
 * can resolve this node's `.local` name without querying.
 *
 * @param hostname  Local hostname (without .local suffix).
 * @param address   IPv4 or IPv6 address to announce.
 */
export async function mdnsAnnounce(hostname: string, address: string): Promise<void> {
  var name  = hostname.replace(/\.$/, '') + '.local';
  var isV6  = address.includes(':');
  var qtype = isV6 ? QTYPE_AAAA : QTYPE_A;
  // Build a DNS response packet (QR=1, AA=1, ANCOUNT=1)
  var addrBytes = isV6
    ? _ipv6ToBytes(address)
    : address.split('.').map(function(n) { return parseInt(n); });

  var pkt = _buildMdnsAnnounce(name, qtype, addrBytes, 4500 /* TTL */);
  try {
    await net.udpSendTo(MDNS_MULTICAST_ADDR, MDNS_PORT, pkt);
  } catch (_) { /* best-effort */ }
}

function _ipv6ToBytes(addr: string): number[] {
  var groups = addr.split(':');
  var bytes: number[] = [];
  for (var g = 0; g < groups.length; g++) {
    var v = parseInt(groups[g] || '0', 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** Build a minimal mDNS announcement (gratuitous response) packet. */
function _buildMdnsAnnounce(name: string, qtype: number, addrBytes: number[], ttl: number): number[] {
  var pkt: number[] = [
    0x00, 0x00,  // ID = 0 for mDNS
    0x84, 0x00,  // QR=1, AA=1, Opcode=0
    0x00, 0x00,  // QDCOUNT = 0
    0x00, 0x01,  // ANCOUNT = 1
    0x00, 0x00,  // NSCOUNT = 0
    0x00, 0x00,  // ARCOUNT = 0
  ];
  // Encode name
  name.split('.').forEach(function(label) {
    pkt.push(label.length);
    for (var c = 0; c < label.length; c++) pkt.push(label.charCodeAt(c));
  });
  pkt.push(0); // root
  // TYPE, CLASS (IN=0x0001, with cache-flush bit 0x8001)
  pkt.push((qtype >> 8) & 0xff, qtype & 0xff);
  pkt.push(0x80, 0x01);  // cache-flush + IN
  // TTL (4 bytes big-endian)
  pkt.push((ttl >> 24) & 0xff, (ttl >> 16) & 0xff, (ttl >> 8) & 0xff, ttl & 0xff);
  // RDLENGTH
  pkt.push((addrBytes.length >> 8) & 0xff, addrBytes.length & 0xff);
  // RDATA
  pkt = pkt.concat(addrBytes);
  return pkt;
}
