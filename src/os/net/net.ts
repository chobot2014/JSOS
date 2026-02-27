/**
 * JSOS Network Stack — TCP/IP implemented in TypeScript
 *
 * Complete protocol stack: Ethernet → ARP → IPv4 → ICMP / UDP / TCP → Socket API
 *
 * Architecture:
 *   All protocol logic (parsing, building, state machines, checksums) lives here
 *   in TypeScript.  The C kernel provides only a raw packet send/receive hook
 *   via kernel.callNative() (wired up when an Ethernet driver is present).
 *   Without a driver, the stack operates in loopback mode — all sockets on the
 *   same host communicate through the internal rx queue.
 *
 * Usage from user scripts:
 *   var s = net.createSocket('tcp');
 *   net.connect(s, '10.0.2.2', 80);
 *   net.send(s, 'GET / HTTP/1.0\r\n\r\n');
 *   var data = net.recv(s);
 *   net.close(s);
 */

import { JITChecksum } from '../process/jit-os.js';
declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Byte-level helpers ───────────────────────────────────────────────────────

function u8(buf: number[], off: number): number { return buf[off] & 0xff; }
function u16be(buf: number[], off: number): number {
  return ((buf[off] & 0xff) << 8) | (buf[off + 1] & 0xff);
}
function u32be(buf: number[], off: number): number {
  return (((buf[off] & 0xff) * 0x1000000) |
          ((buf[off + 1] & 0xff) << 16)   |
          ((buf[off + 2] & 0xff) << 8)    |
           (buf[off + 3] & 0xff)) >>> 0;
}
function wu8(buf: number[], off: number, v: number): void { buf[off] = v & 0xff; }
function wu16be(buf: number[], off: number, v: number): void {
  buf[off] = (v >> 8) & 0xff; buf[off + 1] = v & 0xff;
}
function wu32be(buf: number[], off: number, v: number): void {
  buf[off]     = (v >>> 24) & 0xff; buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8)  & 0xff; buf[off + 3] =  v         & 0xff;
}
function fill(n: number, v: number = 0): number[] {
  var a: number[] = new Array(n);
  for (var i = 0; i < n; i++) a[i] = v;
  return a;
}
export function strToBytes(s: string): number[] {
  var b: number[] = new Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
export function bytesToStr(b: number[]): string {
  // String.fromCharCode.apply eliminates the intermediate parts[] array and join
  // call for every byte.  TCP MSS segments are ≤1460 bytes so a single apply
  // is safe (QuickJS arg-count limit is far above 1460).
  // For larger buffers (e.g. recvBuf drain) chunk to 4096 to stay stack-safe.
  if (b.length === 0) return '';
  if (b.length <= 4096) return String.fromCharCode.apply(null, b as any);
  var s = '';
  for (var off = 0; off < b.length; off += 4096) {
    s += String.fromCharCode.apply(null, b.slice(off, off + 4096) as any);
  }
  return s;
}

// ── Address helpers ──────────────────────────────────────────────────────────

export type MACAddress  = string; // "aa:bb:cc:dd:ee:ff"
export type IPv4Address = string; // "a.b.c.d"

function macToBytes(mac: MACAddress): number[] {
  return mac.split(':').map(function(h) { return parseInt(h, 16); });
}
function bytesToMac(b: number[], off: number): MACAddress {
  var parts: string[] = [];
  for (var i = 0; i < 6; i++) {
    var s = (b[off + i] & 0xff).toString(16);
    parts.push(s.length < 2 ? '0' + s : s);
  }
  return parts.join(':');
}
function ipToBytes(ip: IPv4Address): number[] {
  return ip.split('.').map(Number);
}
function bytesToIp(b: number[], off: number): IPv4Address {
  return b[off] + '.' + b[off + 1] + '.' + b[off + 2] + '.' + b[off + 3];
}
function ipToU32(ip: IPv4Address): number {
  var p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function sameSubnet(a: IPv4Address, b: IPv4Address, mask: IPv4Address): boolean {
  return (ipToU32(a) & ipToU32(mask)) === (ipToU32(b) & ipToU32(mask));
}

// ── Internet checksum (RFC 1071) ──────────────────────────────────────────────

function checksum(data: number[], offset: number = 0, length?: number): number {
  // Delegates to JIT-compiled native code (tier-2) when JITOSKernels.init() has run.
  // Falls back to pure TypeScript automatically via JITChecksum internals.
  return JITChecksum.computeArray(data, offset, length);
}

// ── Ethernet ─────────────────────────────────────────────────────────────────

const ETYPE_ARP  = 0x0806;
const ETYPE_IPV4 = 0x0800;
const ETYPE_VLAN = 0x8100;  // [Item 225] 802.1Q VLAN tag
const ETYPE_IPV6 = 0x86dd;  // [Item 241] IPv6
// ICMPv6 type codes (item 242)
const ICMPV6_ECHO_REQUEST           = 128;
const ICMPV6_ECHO_REPLY             = 129;
const ICMPV6_ROUTER_SOLICITATION    = 133;
const ICMPV6_ROUTER_ADVERTISEMENT   = 134;
const ICMPV6_NEIGHBOR_SOLICITATION  = 135;
const ICMPV6_NEIGHBOR_ADVERTISEMENT = 136;
// [Item 245] IPv6 extension header next-header identifiers
const IPV6_EXT_HOP_BY_HOP  = 0;
const IPV6_EXT_ROUTING     = 43;
const IPV6_EXT_FRAGMENT    = 44;
const IPV6_EXT_DEST_OPT    = 60;

export interface EthernetFrame {
  dst:       MACAddress;
  src:       MACAddress;
  ethertype: number;
  payload:   number[];
}

function parseEthernet(raw: number[]): EthernetFrame | null {
  if (raw.length < 14) return null;
  return {
    dst:       bytesToMac(raw, 0),
    src:       bytesToMac(raw, 6),
    ethertype: u16be(raw, 12),
    payload:   raw.slice(14),
  };
}
function buildEthernet(f: EthernetFrame): number[] {
  var buf = fill(14 + f.payload.length);
  macToBytes(f.dst).forEach(function(b, i) { buf[i] = b; });
  macToBytes(f.src).forEach(function(b, i) { buf[6 + i] = b; });
  wu16be(buf, 12, f.ethertype);
  f.payload.forEach(function(b, i) { buf[14 + i] = b; });
  return buf;
}

// ── VLAN 802.1Q (Item 225) ────────────────────────────────────────────────────

/** [Item 225] Parsed 802.1Q VLAN tag (4-byte header inside Ethernet payload). */
export interface VLANTag {
  pcp:            number;   // 3-bit Priority Code Point
  dei:            boolean;  // Drop Eligible Indicator
  vid:            number;   // 12-bit VLAN Identifier
  innerEthertype: number;   // inner EtherType after 802.1Q header
  payload:        number[];
}

/** [Item 225] Parse the 4-byte 802.1Q tag appended after src MAC in a VLAN frame. */
function parseVLAN(p: number[]): VLANTag | null {
  if (p.length < 4) return null;
  var tci = u16be(p, 0);
  return {
    pcp:            (tci >> 13) & 0x7,
    dei:            ((tci >> 12) & 0x1) !== 0,
    vid:             tci & 0xfff,
    innerEthertype:  u16be(p, 2),
    payload:         p.slice(4),
  };
}

/** [Item 225] Build 4-byte 802.1Q TCI+inner-ethertype header. */
function buildVLANTag(vid: number, pcp: number, dei: boolean, inner: number): number[] {
  var b  = fill(4);
  var tci = ((pcp & 0x7) << 13) | ((dei ? 1 : 0) << 12) | (vid & 0xfff);
  wu16be(b, 0, tci);
  wu16be(b, 2, inner);
  return b;
}

// ── ARP ───────────────────────────────────────────────────────────────────────

export interface ARPPacket {
  operation: 1 | 2; // 1=request, 2=reply
  senderMAC: MACAddress;
  senderIP:  IPv4Address;
  targetMAC: MACAddress;
  targetIP:  IPv4Address;
}

function parseARP(p: number[]): ARPPacket | null {
  if (p.length < 28) return null;
  return {
    operation: u16be(p, 6) as 1 | 2,
    senderMAC: bytesToMac(p, 8),
    senderIP:  bytesToIp(p, 14),
    targetMAC: bytesToMac(p, 18),
    targetIP:  bytesToIp(p, 24),
  };
}
function buildARP(pkt: ARPPacket): number[] {
  var b = fill(28);
  wu16be(b,  0, 1);        // HTYPE Ethernet
  wu16be(b,  2, 0x0800);   // PTYPE IPv4
  wu8(b,  4, 6);            // HLEN 6
  wu8(b,  5, 4);            // PLEN 4
  wu16be(b,  6, pkt.operation);
  macToBytes(pkt.senderMAC).forEach(function(v, i) { b[8  + i] = v; });
  ipToBytes(pkt.senderIP)  .forEach(function(v, i) { b[14 + i] = v; });
  macToBytes(pkt.targetMAC).forEach(function(v, i) { b[18 + i] = v; });
  ipToBytes(pkt.targetIP)  .forEach(function(v, i) { b[24 + i] = v; });
  return b;
}

// ── IPv4 ─────────────────────────────────────────────────────────────────────

const PROTO_ICMP   = 1;
const PROTO_TCP    = 6;
const PROTO_UDP    = 17;
const PROTO_IGMP   = 2;    // [Item 237] IGMP v2
const PROTO_ICMPV6 = 58;   // [Item 242] ICMPv6

// ── IP Options (item 231) ─────────────────────────────────────────────────────
/** Parsed IP option (record-route, timestamp, strict/loose source route). */
export interface IPOption {
  type:    number;           // raw option-type byte
  kind:    'record-route' | 'timestamp' | 'strict-source-route' | 'loose-source-route' | 'other';
  data:    number[];         // raw option bytes (excluding type/len)
  /** Populated for record-route: list of IP addresses recorded so far */
  addresses?: IPv4Address[];
  /** Populated for timestamp: list of { address?, timestamp } entries */
  timestamps?: Array<{ address?: IPv4Address; ts: number }>;
  /** Populated for source routes: ordered list of hop addresses */
  route?: IPv4Address[];
}

/**
 * [Item 231] Parse IP options from the header bytes between byte 20 and ihl*4.
 * Handles: End-of-option (0), NOP (1), Record Route (7), Timestamp (68=0x44),
 * Strict Source Route (137=0x89), Loose Source Route (131=0x83).
 */
function _parseIPOptions(raw: number[], ihl: number): IPOption[] {
  var opts: IPOption[] = [];
  var off = 20; // options start after the fixed 20-byte IP header
  var end = ihl;
  while (off < end) {
    var type = raw[off] & 0xff;
    if (type === 0) break;          // EOOL – end of option list
    if (type === 1) { off++; continue; } // NOP
    if (off + 1 >= end) break;
    var len = raw[off + 1] & 0xff;
    if (len < 2 || off + len > end) break;
    var bytes = raw.slice(off + 2, off + len);
    if (type === 7) {
      // Record Route: pointer (1-based) at [2], then 4-byte address slots
      var ptr = (raw[off + 2] & 0xff) - 1; // convert to 0-based
      var addrs: IPv4Address[] = [];
      for (var i = 3; i + 3 < len; i += 4) {
        if (i < ptr) addrs.push(bytesToIp(raw, off + i));
      }
      opts.push({ type, kind: 'record-route', data: bytes, addresses: addrs });
    } else if (type === 0x44) {
      // Internet Timestamp: flags at [3] bits 0-3
      var flags = raw[off + 3] & 0x0f;
      var tss: Array<{ address?: IPv4Address; ts: number }> = [];
      var j = 4;
      while (j + 3 < len) {
        if (flags === 0) {
          tss.push({ ts: u32be(raw, off + j) }); j += 4;
        } else {
          if (j + 7 >= len) break;
          tss.push({ address: bytesToIp(raw, off + j), ts: u32be(raw, off + j + 4) }); j += 8;
        }
      }
      opts.push({ type, kind: 'timestamp', data: bytes, timestamps: tss });
    } else if (type === 0x89) {
      // Strict Source Route
      var route: IPv4Address[] = [];
      for (var k = 3; k + 3 < len; k += 4) route.push(bytesToIp(raw, off + k));
      opts.push({ type, kind: 'strict-source-route', data: bytes, route });
    } else if (type === 0x83) {
      // Loose Source Route
      var lroute: IPv4Address[] = [];
      for (var m = 3; m + 3 < len; m += 4) lroute.push(bytesToIp(raw, off + m));
      opts.push({ type, kind: 'loose-source-route', data: bytes, route: lroute });
    } else {
      opts.push({ type, kind: 'other', data: bytes });
    }
    off += len;
  }
  return opts;
}

export interface IPv4Packet {
  ihl:      number;
  dscp:     number;
  ecn:      number;
  id:       number;
  flags:    number;
  fragOff:  number;
  ttl:      number;
  protocol: number;
  src:      IPv4Address;
  dst:      IPv4Address;
  payload:  number[];
  /** Parsed IP options (empty array when IHL=5, i.e. no options). */
  options?: IPOption[];
}

function parseIPv4(raw: number[]): IPv4Packet | null {
  if (raw.length < 20) return null;
  var ihl = (raw[0] & 0x0f) * 4;
  if (raw.length < ihl) return null;
  // Clip to IP total length to discard Ethernet zero-padding on short frames.
  var totalLen = u16be(raw, 2);
  return {
    ihl,
    dscp:     (raw[1] >> 2) & 0x3f,
    ecn:       raw[1] & 0x03,
    id:        u16be(raw, 4),
    flags:    (raw[6] >> 5) & 0x07,
    fragOff:   u16be(raw, 6) & 0x1fff,
    ttl:       raw[8],
    protocol:  raw[9],
    src:       bytesToIp(raw, 12),
    dst:       bytesToIp(raw, 16),
    payload:   raw.slice(ihl, totalLen),
    options:   ihl > 20 ? _parseIPOptions(raw, ihl) : [],
  };
}
function buildIPv4(pkt: IPv4Packet): number[] {
  var h = fill(20);
  wu8(h, 0, 0x45); // version 4, IHL 5
  wu8(h, 1, (pkt.dscp << 2) | pkt.ecn);
  wu16be(h, 2, 20 + pkt.payload.length);
  wu16be(h, 4, pkt.id);
  wu16be(h, 6, (pkt.flags << 13) | pkt.fragOff);
  wu8(h, 8, pkt.ttl);
  wu8(h, 9, pkt.protocol);
  wu16be(h, 10, 0);
  ipToBytes(pkt.src).forEach(function(v, i) { h[12 + i] = v; });
  ipToBytes(pkt.dst).forEach(function(v, i) { h[16 + i] = v; });
  wu16be(h, 10, checksum(h));
  return h.concat(pkt.payload);
}

// ── ICMP ─────────────────────────────────────────────────────────────────────

export interface ICMPMessage {
  type: number;
  code: number;
  data: number[];
}

function parseICMP(raw: number[]): ICMPMessage | null {
  if (raw.length < 4) return null;
  return { type: raw[0], code: raw[1], data: raw.slice(4) };
}
function buildICMP(type: number, code: number, data: number[]): number[] {
  var b = [type, code, 0, 0].concat(data);
  wu16be(b, 2, checksum(b));
  return b;
}

// ── IGMP v2 (Item 237) ────────────────────────────────────────────────────────

const IGMP_MEMBERSHIP_QUERY    = 0x11;  // general / group-specific query
const IGMP_V2_MEMBER_REPORT    = 0x16;  // join / membership report
const IGMP_V2_LEAVE_GROUP      = 0x17;  // leave group

/**
 * [Item 237] Build an IGMPv2 message (8 bytes).
 * type = IGMP_V2_MEMBER_REPORT to join, IGMP_V2_LEAVE_GROUP to leave.
 * groupIP = '224.0.0.0' for leave-all, or specific group address.
 */
function buildIGMPv2(type: number, groupIP: IPv4Address): number[] {
  var b = fill(8);
  b[0] = type;
  b[1] = 0;  // max response time (ignored in reports)
  ipToBytes(groupIP).forEach(function(v, i) { b[4 + i] = v; });
  wu16be(b, 2, checksum(b));
  return b;
}

// ── UDP ───────────────────────────────────────────────────────────────────────

export interface UDPDatagram {
  srcPort: number;
  dstPort: number;
  payload: number[];
}

function parseUDP(raw: number[]): UDPDatagram | null {
  if (raw.length < 8) return null;
  return {
    srcPort: u16be(raw, 0),
    dstPort: u16be(raw, 2),
    payload: raw.slice(8),
  };
}
function buildUDP(srcPort: number, dstPort: number, payload: number[]): number[] {
  var b = fill(8);
  wu16be(b, 0, srcPort);
  wu16be(b, 2, dstPort);
  wu16be(b, 4, 8 + payload.length);
  wu16be(b, 6, 0); // checksum optional for IPv4
  return b.concat(payload);
}

// ── IPv6 (Items 241–245) ───────────────────────────────────────────────────────────

export type IPv6Address = string;  // e.g. "2001:db8::1" or "fe80::1"

/** Convert 16-byte array at offset to compressed IPv6 string. */
function bytesToIpv6(b: number[], off: number = 0): IPv6Address {
  var groups: string[] = [];
  for (var i = 0; i < 8; i++) {
    groups.push(((b[off + i*2] & 0xff) << 8 | (b[off + i*2 + 1] & 0xff)).toString(16));
  }
  var bestStart = -1; var bestLen = 0;
  var curStart  = -1; var curLen  = 0;
  for (var j = 0; j < 8; j++) {
    if (groups[j] === '0') {
      if (curStart < 0) curStart = j;
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestStart >= 0 && bestLen >= 2) {
    var left  = groups.slice(0, bestStart).join(':');
    var right = groups.slice(bestStart + bestLen).join(':');
    return (left ? left + ':' : '') + ':' + (right || '');
  }
  return groups.join(':');
}

/** Convert a compressed IPv6 address string to 16-byte array. */
function ipv6ToBytes(addr: IPv6Address): number[] {
  var b = fill(16);
  var dbl = addr.indexOf('::');
  var left: string[], right: string[];
  if (dbl >= 0) {
    left  = addr.slice(0, dbl)  ? addr.slice(0, dbl).split(':')  : [];
    right = addr.slice(dbl + 2) ? addr.slice(dbl + 2).split(':') : [];
    var pad = 8 - left.length - right.length;
    for (var z = 0; z < pad; z++) left.push('0');
    left = left.concat(right);
  } else {
    left = addr.split(':');
  }
  for (var k = 0; k < 8 && k < left.length; k++) {
    var v = parseInt(left[k], 16) & 0xffff;
    b[k*2] = (v >> 8) & 0xff; b[k*2 + 1] = v & 0xff;
  }
  return b;
}

/**
 * [Item 243] Derive an EUI-64 link-local address (fe80::/10) from a MAC.
 * RFC 4291 §2.5.6: insert ff:fe in the middle, flip U/L bit of first byte.
 */
function eui64LinkLocal(mac: MACAddress): IPv6Address {
  var m = mac.split(':').map(function(h) { return parseInt(h, 16); });
  var eui = [m[0] ^ 0x02, m[1], m[2], 0xff, 0xfe, m[3], m[4], m[5]];
  return bytesToIpv6([0xfe, 0x80, 0, 0, 0, 0, 0, 0].concat(eui));
}

/** [Item 245] One parsed IPv6 extension header. */
export interface IPv6ExtHeader {
  type:   number;   // next-header value identifying this header
  length: number;   // header length in bytes
  data:   number[];
}

/** Parsed IPv6 packet (after extension headers are removed). */
export interface IPv6Packet {
  trafficClass: number;
  flowLabel:    number;
  nextHeader:   number;       // payload protocol
  hopLimit:     number;
  src:          IPv6Address;
  dst:          IPv6Address;
  payload:      number[];
  extHeaders:   IPv6ExtHeader[];
}

function parseIPv6(raw: number[]): IPv6Packet | null {
  if (raw.length < 40 || (raw[0] >> 4) !== 6) return null;
  var trafficClass = ((raw[0] & 0xf) << 4) | (raw[1] >> 4);
  var flowLabel    = ((raw[1] & 0xf) << 16) | (raw[2] << 8) | raw[3];
  var payloadLen   = u16be(raw, 4);
  var nextHeader   = raw[6];
  var hopLimit     = raw[7];
  var src = bytesToIpv6(raw, 8);
  var dst = bytesToIpv6(raw, 24);
  var off = 40;
  var extHeaders: IPv6ExtHeader[] = [];
  // [Item 245] Walk any extension headers
  var extSet = new Set([IPV6_EXT_HOP_BY_HOP, IPV6_EXT_ROUTING, IPV6_EXT_FRAGMENT, IPV6_EXT_DEST_OPT]);
  while (extSet.has(nextHeader) && off + 2 <= raw.length) {
    var ehNext = raw[off];
    var ehLen  = (raw[off + 1] + 1) * 8;
    extHeaders.push({ type: nextHeader, length: ehLen, data: raw.slice(off + 2, off + ehLen) });
    nextHeader = ehNext;
    off += ehLen;
  }
  return { trafficClass, flowLabel, nextHeader, hopLimit, src, dst,
           payload: raw.slice(off, 40 + payloadLen), extHeaders };
}

function buildIPv6(pkt: IPv6Packet): number[] {
  var p = pkt.payload;
  var b = fill(40 + p.length);
  b[0] = 0x60 | ((pkt.trafficClass >> 4) & 0xf);
  b[1] = ((pkt.trafficClass & 0xf) << 4) | ((pkt.flowLabel >> 16) & 0xf);
  b[2] = (pkt.flowLabel >> 8) & 0xff;
  b[3] = pkt.flowLabel & 0xff;
  wu16be(b, 4, p.length);
  b[6] = pkt.nextHeader; b[7] = pkt.hopLimit;
  var sb = ipv6ToBytes(pkt.src); var db = ipv6ToBytes(pkt.dst);
  for (var i = 0; i < 16; i++) { b[8 + i] = sb[i]; b[24 + i] = db[i]; }
  for (var j = 0; j < p.length; j++) b[40 + j] = p[j];
  return b;
}

/** [Item 242] ICMPv6 checksum using IPv6 pseudo-header (RFC 4443 §2.3). */
function checksumICMPv6(src: IPv6Address, dst: IPv6Address, payload: number[]): number {
  var sb = ipv6ToBytes(src); var db = ipv6ToBytes(dst);
  var len = payload.length;
  var pseudo: number[] = [];
  for (var i = 0; i < 16; i++) pseudo.push(sb[i]);
  for (var j = 0; j < 16; j++) pseudo.push(db[j]);
  pseudo.push(0, 0, (len >> 8) & 0xff, len & 0xff, 0, 0, 0, PROTO_ICMPV6);
  return checksum(pseudo.concat(payload));
}

// ── TCP ───────────────────────────────────────────────────────────────────────

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;
const TCP_URG = 0x20;

/** [Item 255] A SACK block describing a received-but-not-yet-acknowledged range. */
export interface SACKBlock { left: number; right: number; }

export interface TCPSegment {
  srcPort: number;
  dstPort: number;
  seq:     number;
  ack:     number;
  flags:   number;
  window:  number;
  urgent:  number;
  payload: number[];
  // ── Parsed TCP options ─────────────────────────────────────────────────
  /** [Item 256] Window scale factor received in SYN/SYN-ACK (0 = not negotiated). */
  wscale?:    number;
  /** [Item 257] TCP timestamp value (TSval) from the peer. */
  tsVal?:     number;
  /** [Item 257] TCP timestamp echo reply (TSecr) from the peer. */
  tsEcr?:     number;
  /** [Item 255] SACK blocks received in this segment. */
  sackBlocks?: SACKBlock[];
  /** True if peer sent SACK-permitted option in SYN. */
  sackOk?:    boolean;
}

function parseTCP(raw: number[]): TCPSegment | null {
  if (raw.length < 20) return null;
  var dataOff = ((raw[12] >> 4) & 0xf) * 4;
  if (raw.length < dataOff) return null;
  var seg: TCPSegment = {
    srcPort: u16be(raw, 0),
    dstPort: u16be(raw, 2),
    seq:     u32be(raw, 4),
    ack:     u32be(raw, 8),
    flags:   raw[13],
    window:  u16be(raw, 14),
    urgent:  u16be(raw, 18),
    payload: raw.slice(dataOff),
  };
  // ── Parse TCP options (bytes 20..dataOff-1) ─────────────────────────────
  var i = 20;
  while (i < dataOff) {
    var kind = raw[i];
    if (kind === 0) break;           // EOL
    if (kind === 1) { i++; continue; } // NOP
    if (i + 1 >= dataOff) break;
    var optLen = raw[i + 1];
    if (optLen < 2 || i + optLen > dataOff) break;
    switch (kind) {
      case 2: // MSS (not stored on segment, just parsed)
        break;
      case 3: // [Item 256] Window Scale
        seg.wscale = raw[i + 2] & 0xff;
        break;
      case 4: // [Item 255] SACK-Permitted
        seg.sackOk = true;
        break;
      case 5: // [Item 255] SACK blocks
        var sacks: SACKBlock[] = [];
        for (var si = i + 2; si + 7 < i + optLen; si += 8)
          sacks.push({ left: u32be(raw, si), right: u32be(raw, si + 4) });
        if (sacks.length > 0) seg.sackBlocks = sacks;
        break;
      case 8: // [Item 257] Timestamps
        if (optLen === 10) {
          seg.tsVal = u32be(raw, i + 2);
          seg.tsEcr = u32be(raw, i + 6);
        }
        break;
    }
    i += optLen;
  }
  return seg;
}
/** Options to include in a TCP segment being built. */
interface BuildTCPOpts {
  wscale?:     number;   // [Item 256] window scale; sent only in SYN
  sackOk?:     boolean;  // [Item 255] SACK-permitted; sent only in SYN
  tsVal?:      number;   // [Item 257] TSval
  tsEcr?:      number;   // [Item 257] TSecr
  sackBlocks?: SACKBlock[]; // [Item 255] SACK blocks in ACK
}
function push32be(arr: number[], v: number): void {
  arr.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}
function buildTCP(seg: TCPSegment, srcIP: IPv4Address, dstIP: IPv4Address,
                  opts?: BuildTCPOpts): number[] {
  // Build options blob
  var optBytes: number[] = [];
  if (opts) {
    if (opts.wscale !== undefined) {
      // Window Scale: kind=3, len=3, shift + NOP padding
      optBytes.push(3, 3, opts.wscale & 0xff, 1 /*NOP*/);
    }
    if (opts.sackOk) {
      // SACK-Permitted: kind=4, len=2 + 2 NOPs for alignment
      optBytes.push(4, 2, 1, 1);
    }
    if (opts.tsVal !== undefined) {
      // Timestamps: 2 NOPs + kind=8, len=10
      optBytes.push(1, 1, 8, 10);
      push32be(optBytes, opts.tsVal >>> 0);
      push32be(optBytes, (opts.tsEcr !== undefined ? opts.tsEcr : 0) >>> 0);
    }
    if (opts.sackBlocks && opts.sackBlocks.length > 0) {
      var sb = opts.sackBlocks.slice(0, 4); // max 4 SACK blocks
      var sackLen = 2 + sb.length * 8;
      optBytes.push(1, 1, 5, sackLen);
      for (var si2 = 0; si2 < sb.length; si2++) {
        push32be(optBytes, sb[si2].left >>> 0);
        push32be(optBytes, sb[si2].right >>> 0);
      }
    }
    // Pad to 4-byte boundary
    while (optBytes.length % 4 !== 0) optBytes.push(0);
  }
  var headerLen = 20 + optBytes.length;
  var h = fill(headerLen);
  wu16be(h, 0,  seg.srcPort);
  wu16be(h, 2,  seg.dstPort);
  wu32be(h, 4,  seg.seq);
  wu32be(h, 8,  seg.ack);
  wu8(h, 12, ((headerLen >> 2) & 0xf) << 4); // data offset
  wu8(h, 13, seg.flags);
  wu16be(h, 14, seg.window);
  wu16be(h, 16, 0);
  wu16be(h, 18, seg.urgent);
  for (var oi = 0; oi < optBytes.length; oi++) h[20 + oi] = optBytes[oi];
  var data = h.concat(seg.payload);
  // TCP pseudo-header checksum
  var pseudo = ipToBytes(srcIP).concat(
    ipToBytes(dstIP), [0, PROTO_TCP],
    fill(2)
  );
  wu16be(pseudo, 14, data.length);
  wu16be(data, 16, checksum(pseudo.concat(data)));
  return data;
}

// ── TCP Connection state machine ──────────────────────────────────────────────

// ── BBR Congestion Control (Item 260) ────────────────────────────────────────────────

/** [Item 260] BBR congestion control state block. */
export interface BBRState {
  mode:          'STARTUP' | 'DRAIN' | 'PROBE_BW' | 'PROBE_RTT';
  btlBw:         number;   // estimated bottleneck bandwidth (bytes/tick)
  rtProp:        number;   // min observed RTT (ticks); Infinity until first sample
  rtPropExpiry:  number;   // tick when rtProp must be renewed
  pacingGain:    number;   // pacing rate = btlBw * pacingGain
  cwndGain:      number;   // cwnd = BDP * cwndGain
  cycleIdx:      number;   // PROBE_BW gain-cycle index (0–7)
  delivered:     number;   // cumulative bytes delivered
  priorDelivered: number;  // delivered at last growth check (STARTUP)
  probeRttDue:   number;   // tick when PROBE_RTT next fires
}

const BBR_STARTUP_GAIN   = 2.89;
const BBR_DRAIN_GAIN     = 0.35;
const BBR_CWND_GAIN      = 2.0;
const BBR_RTPROP_EXPIRY  = 1000;
const BBR_PROBE_RTT_TICKS = 20;
const BBR_PROBE_BW_GAINS  = [1.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

function bbrInit(): BBRState {
  return { mode: 'STARTUP', btlBw: 0, rtProp: Infinity,
           rtPropExpiry: 0, pacingGain: BBR_STARTUP_GAIN, cwndGain: BBR_CWND_GAIN,
           cycleIdx: 0, delivered: 0, priorDelivered: 0, probeRttDue: 0 };
}

/** [Item 260] Update BBR model on ACK; returns new inflight window (bytes). */
function bbrOnAck(bbr: BBRState, rttTicks: number, bytesAcked: number, now: number): number {
  if (rttTicks > 0) {
    var rate = bytesAcked / rttTicks;
    if (rate > bbr.btlBw) bbr.btlBw = rate;
    if (rttTicks < bbr.rtProp || now >= bbr.rtPropExpiry) {
      bbr.rtProp = rttTicks; bbr.rtPropExpiry = now + BBR_RTPROP_EXPIRY;
    }
  }
  bbr.delivered += bytesAcked;
  if (bbr.mode === 'STARTUP') {
    if (bbr.delivered > bbr.priorDelivered * 1.25) { bbr.priorDelivered = bbr.delivered; }
    else if (bbr.btlBw > 0) { bbr.mode = 'DRAIN'; bbr.pacingGain = BBR_DRAIN_GAIN; }
  } else if (bbr.mode === 'DRAIN') {
    bbr.mode = 'PROBE_BW'; bbr.cycleIdx = 0; bbr.pacingGain = BBR_PROBE_BW_GAINS[0]; bbr.cwndGain = BBR_CWND_GAIN;
  } else if (bbr.mode === 'PROBE_BW') {
    if ((now & 0x7f) === 0) { bbr.cycleIdx = (bbr.cycleIdx + 1) & 7; bbr.pacingGain = BBR_PROBE_BW_GAINS[bbr.cycleIdx]; }
    if (bbr.probeRttDue === 0) bbr.probeRttDue = now + 2000;
    if (now >= bbr.probeRttDue) { bbr.mode = 'PROBE_RTT'; bbr.pacingGain = 1.0; bbr.cwndGain = 1.0; bbr.probeRttDue = now + BBR_PROBE_RTT_TICKS; }
  } else if (bbr.mode === 'PROBE_RTT') {
    if (now >= bbr.probeRttDue) { bbr.mode = 'PROBE_BW'; bbr.cycleIdx = 0; bbr.pacingGain = BBR_PROBE_BW_GAINS[0]; bbr.cwndGain = BBR_CWND_GAIN; bbr.probeRttDue = 0; }
  }
  var mss = 1460;
  if (bbr.btlBw <= 0 || bbr.rtProp === Infinity) return mss * 10;
  return Math.max(mss * 4, Math.ceil(bbr.btlBw * bbr.rtProp * bbr.cwndGain));
}

// ── IP Routing Table (Item 236) ───────────────────────────────────────────────────────

// ── TCP CUBIC Congestion Control (Item 939) ───────────────────────────────────────────

/**
 * [Item 939] CUBIC congestion window (RFC 8312).
 * Returns new cwnd (in bytes) given:
 *   wmax     - window size at last congestion event (bytes)
 *   tElapsed - elapsed time since last congestion event (seconds)
 *   cwnd     - current congestion window (bytes)
 *   mss      - max segment size (bytes)
 */
export function cubicCwnd(wmax: number, tElapsed: number, cwnd: number, mss = 1460): number {
  const C = 0.4;  // CUBIC constant
  const BETA = 0.7;
  var wmaxScaled = wmax * BETA;
  // K = cube_root((wmax * (1-beta)) / C)
  var K = Math.cbrt((wmax * (1 - BETA)) / C);
  var dt   = tElapsed - K;
  var wCubic = C * dt * dt * dt + wmax;
  // Also compute TCP-friendly window (Reno-equivalent)
  var wReno  = wmaxScaled + 3 * BETA / (2 - BETA) * (tElapsed / (K || 1)) * mss;
  var target = Math.max(wCubic, wReno);
  // Slow-start phase: increase by 1 MSS per ACK until ssthresh
  return Math.max(cwnd + mss, Math.round(target));
}

/**
 * [Item 939] CUBIC state for one TCP connection.
 */
export interface CUBICState {
  wmax:     number;   // congestion window at last loss event (bytes)
  k:        number;   // time origin for CUBIC (seconds)
  lastLoss: number;   // kernel tick of last loss
  ssthresh: number;   // slow-start threshold
  cwnd:     number;   // current congestion window (bytes)
}

/** Initialise a CUBIC state. */
export function cubicInit(initialCwnd = 10 * 1460): CUBICState {
  return { wmax: initialCwnd, k: 0, lastLoss: 0, ssthresh: Infinity, cwnd: initialCwnd };
}

/** Called on loss (timeout or triple duplicate ACK). Updates CUBIC state. */
export function cubicOnLoss(state: CUBICState, nowTick: number): void {
  state.wmax     = state.cwnd;
  state.ssthresh = Math.max(state.cwnd * 0.7, 2 * 1460);
  state.cwnd     = state.ssthresh;
  state.k        = Math.cbrt(state.wmax * 0.3 / 0.4);
  state.lastLoss = nowTick;
}

/** Called on each ACK. Returns updated cwnd. */
export function cubicOnAck(state: CUBICState, nowTick: number, ticksPerSec = 1000): number {
  if (state.cwnd < state.ssthresh) {
    // Slow start
    state.cwnd += 1460;
  } else {
    var tElapsed = (nowTick - state.lastLoss) / ticksPerSec;
    state.cwnd = cubicCwnd(state.wmax, tElapsed, state.cwnd);
  }
  return state.cwnd;
}

/** [Item 940] Advertise a large receive window by returning the scaled window value.
 *  The window scale factor (shift) is negotiated in SYN (already set via sendWscale).
 *  This helper computes the 16-bit window field for a given receive buffer and scale. */
export function rcvWindowField(rcvBufFree: number, rcvScale: number): number {
  return Math.min(0xffff, (rcvBufFree >> rcvScale) >>> 0);
}

/** [Item 940] Default receive buffer size when window scaling is enabled (64 KB → 1 MB). */
export const DEFAULT_SCALED_RCV_BUF = 1 << 20;  // 1 MiB

/** [Item 240] Static routing table entry for longest-prefix match. */
export interface RouteEntry {
  prefix:  IPv4Address;  // network address e.g. "192.168.1.0"
  mask:    IPv4Address;  // subnet mask e.g. "255.255.255.0"
  gateway: IPv4Address;  // next-hop; "0.0.0.0" = on-link
  iface:   string;       // logical interface name
  metric:  number;       // lower = more preferred
}

/** [Item 266] A tracked NAT/conntrack entry (5-tuple → translated 5-tuple). */
export interface ConntrackEntry {
  origSrc:     IPv4Address;
  origSport:   number;
  transSrc:    IPv4Address;
  transSport:  number;
  dst:         IPv4Address;
  dport:       number;
  protocol:    number;
  established: boolean;
}

/** [Item 266] A static NAT rule (SNAT or DNAT). */
export interface NATRule {
  type:          'SNAT' | 'DNAT';
  origIP:        IPv4Address;
  translatedIP:  IPv4Address;
}

// ── Protocol Stub Interfaces (Items 227, 228, 268, 269, 274, 275) ──────────────────────────────

/** [Item 227] 802.3ad Link Aggregation Group (LACP) stub. */
export interface LACPPort {
  ifaceName:  string;
  priority:   number;
  active:     boolean;
}
export class LinkAggregation {
  readonly ports: LACPPort[] = [];
  readonly mode: 'active-backup' | 'round-robin' | 'lacp' = 'lacp';
  addPort(iface: string, priority = 128): void {
    this.ports.push({ ifaceName: iface, priority, active: true });
  }
  removePort(iface: string): void {
    var idx = this.ports.findIndex(p => p.ifaceName === iface);
    if (idx >= 0) this.ports.splice(idx, 1);
  }
  selectPort(hash: number): LACPPort | null {
    var active = this.ports.filter(p => p.active);
    return active.length ? active[hash % active.length] : null;
  }
}

/** [Item 228] Layer-2 Software Bridge stub (IEEE 802.1D). */
export class SoftwareBridge {
  readonly name: string;
  readonly ports: string[] = [];
  /** MAC address → egress port name. */
  private fdb = new Map<string, string>();
  constructor(name: string) { this.name = name; }
  addPort(iface: string): void { this.ports.push(iface); }
  removePort(iface: string): void {
    var i = this.ports.indexOf(iface);
    if (i >= 0) this.ports.splice(i, 1);
    this.fdb.forEach((port, mac) => { if (port === iface) this.fdb.delete(mac); });
  }
  learn(mac: string, iface: string): void { this.fdb.set(mac, iface); }
  forward(srcMac: string, srcIface: string, dstMac: string): string[] {
    this.learn(srcMac, srcIface);
    var dst = this.fdb.get(dstMac);
    if (dst) return [dst];
    // Flood to all ports except source
    return this.ports.filter(p => p !== srcIface);
  }
}

/** [Item 268] MPTCP sub-flow descriptor stub (RFC 8684). */
export interface MPTCPSubflow {
  token:      number;
  subflowId:  number;
  localIP:    IPv4Address;
  remoteIP:   IPv4Address;
  localPort:  number;
  remotePort: number;
  priority:   number;
  backup:     boolean;
}
/** [Item 268] MPTCP connection aggregating multiple sub-flows. */
export interface MPTCPConnection {
  masterToken:  number;
  subflows:     MPTCPSubflow[];
  dsn:          number;  // Data Sequence Number
  rcvBase:      number;
}

/** [Item 269] QUIC connection stub (RFC 9000). */
export interface QUICStream {
  id:        number;
  offset:    number;
  fin:       boolean;
  data:      number[];
}
export interface QUICConnection {
  connectionId:   Uint8Array;
  version:        number;  // 0x00000001 = QUIC v1
  peerAddr:       IPv4Address;
  peerPort:       number;
  streams:        Map<number, QUICStream>;
  packetNumber:   number;
  state:          'INITIAL' | 'HANDSHAKE' | '1RTT' | 'CLOSED';
}

/** [Item 274] DTLS 1.3 socket stub (RFC 9147). */
export interface DTLSSocket {
  peerAddr:   IPv4Address;
  peerPort:   number;
  epoch:      number;       // current epoch for record layer
  seqNum:     number;
  cipherSuite: number;
  state:      'HANDSHAKE' | 'DATA' | 'CLOSED';
}

/** [Item 275] SCTP association stub (RFC 4960). */
export interface SCTPChunk {
  type:   number;
  flags:  number;
  value:  number[];
}
export interface SCTPAssociation {
  localTag:   number;
  peerTag:    number;
  peerAddr:   IPv4Address;
  peerPort:   number;
  localPort:  number;
  localTSN:   number;
  peerTSN:    number;
  streams:    number;  // number of outbound streams
  state:      'CLOSED' | 'COOKIE_WAIT' | 'COOKIE_ECHOED' | 'ESTABLISHED' | 'SHUTDOWN';
}

export type TCPState =
  'CLOSED' | 'LISTEN' | 'SYN_SENT' | 'SYN_RECEIVED' | 'ESTABLISHED' |
  'FIN_WAIT_1' | 'FIN_WAIT_2' | 'CLOSE_WAIT' | 'CLOSING' | 'LAST_ACK' | 'TIME_WAIT';

export interface TCPConnection {
  id:         number;
  state:      TCPState;
  localIP:    IPv4Address;
  localPort:  number;
  remoteIP:   IPv4Address;
  remotePort: number;
  sendSeq:    number;
  recvSeq:    number;
  sendBuf:    number[];
  recvBuf:    number[];
  window:     number;   // remote receive window

  // ── Nagle algorithm ─────────────────────────────────────────────────────────
  /** False = TCP_NODELAY: disable Nagle, send each chunk immediately. */
  nagle:        boolean;
  /** MSS: maximum segment payload we will send in one segment. Default 1460. */
  mss:          number;
  /** Data corked by Nagle waiting for a full MSS or ACK of prior data. */
  nagleBuf:     number[];

  // ── RTO / Retransmit ─────────────────────────────────────────────────────────
  /** SND.UNA: sequence number of the oldest unacknowledged byte. */
  sndUna:       number;
  /** Smoothed RTT estimate (ticks × 8, fixed-point). */
  srtt:         number;
  /** RTT variance (ticks × 4, fixed-point). */
  rttvar:       number;
  /** Current retransmission timeout in ticks (min 10, max 6000 ticks). */
  rtoTicks:     number;
  /** Absolute tick at which RTO fires; -1 = no outstanding data. */
  rtoDead:      number;
  /** Segment saved for retransmit (flags, seq, payload). */
  rtxFlags:     number;
  rtxSeq:       number;
  rtxPayload:   number[];

  // ── Duplicate ACK / fast retransmit ─────────────────────────────────────────
  dupAcks:      number;   // consecutive dup-ACK count
  lastAckSeq:   number;   // last ACK seq (dup detection)

  // ── Zero-window probe (persist timer) ───────────────────────────────────────
  /** Absolute tick for next zero-window probe; -1 = not needed. */
  persistDead:  number;
  /** Probe backoff iteration count. */
  persistCount: number;

  // ── TIME_WAIT ────────────────────────────────────────────────────────────────
  /** Absolute tick when TIME_WAIT expires; -1 = not in TIME_WAIT. */
  timeWaitDead: number;

  // ── TCP options negotiated during handshake ─────────────────────────────────
  /** [Item 256] Our send window scale shift (0 = not enabled). */
  sendWscale:   number;
  /** [Item 256] Peer's receive window scale shift (0 = not enabled). */
  recvWscale:   number;
  /** [Item 255] True if SACK was negotiated with peer. */
  sackEnabled:  boolean;
  /** [Item 255] Outstanding SACK blocks to report to peer. */
  sackQueue:    SACKBlock[];
  /** [Item 257] True if TCP timestamps were negotiated. */
  tsEnabled:    boolean;
  /** [Item 257] Our last sent TSval (ticks at send time). */
  tsLastSent:   number;
  /** [Item 257] Peer's last TSval (echo back as TSecr). */
  tsEcr:        number;

  // ── TCP Keepalive ───────────────────────────────────────────────────────────
  /** [Item 264] True if keepalive probes are enabled on this connection. */
  keepalive:         boolean;
  /** [Item 264] Idle ticks before first keepalive probe (default 7500 ≈ 75 s). */
  keepaliveIdle:     number;
  /** [Item 264] Ticks between keepalive probes (default 750 ≈ 7.5 s). */
  keepaliveInterval: number;
  /** [Item 264] Max unanswered probes before aborting (default 9). */
  keepaliveMaxProbes: number;
  /** [Item 264] Current probe count. */
  keepaliveProbeCount: number;
  /** [Item 264] Absolute tick when next keepalive probe fires; -1 = not set. */
  keepaliveDead:     number;
  /** [Item 260] Use BBR congestion control (default false = legacy cubic-proxy). */
  useBBR:  boolean;
  /** [Item 260] BBR state; populated when useBBR is true. */
  bbr?:    BBRState;
}

// ── Socket ────────────────────────────────────────────────────────────────────

export type SocketType = 'tcp' | 'udp';

export interface Socket {
  id:         number;
  type:       SocketType;
  localIP:    IPv4Address;
  localPort:  number;
  remoteIP?:  IPv4Address;
  remotePort?: number;
  state:      'closed' | 'bound' | 'listening' | 'connected';
  recvQueue:  string[]; // received data segments
  /** [Item 262] Maximum pending connections in accept queue (default 128). */
  backlog:    number;
  /** [Item 262] Queue of fully-established connections awaiting accept(). */
  pendingConns: TCPConnection[];
  /** [Item 263] Whether SO_REUSEADDR is set. */
  reuseAddr:  boolean;
  /** [Item 273] SO_RCVBUF: receive buffer size limit in bytes (0 = unlimited). */
  rcvBufSize: number;
  /** [Item 273] SO_SNDBUF: send buffer size limit in bytes (0 = unlimited). */
  sndBufSize: number;
}

// ── NetworkStack ──────────────────────────────────────────────────────────────

export class NetworkStack {
  // Interface configuration
  mac:     MACAddress  = '52:54:00:12:34:56';
  ip:      IPv4Address = '10.0.2.15';
  mask:    IPv4Address = '255.255.255.0';
  gateway: IPv4Address = '10.0.2.2';
  dns:     IPv4Address = '10.0.2.3';

  /** True once a real NIC has been detected and virtqueues are ready */
  nicReady: boolean = false;
  /** [Item 226] Interface MTU; raise above 1500 for jumbo frames. */
  mtu: number = 1500;
  /** [Item 241] IPv6 link-local address (set on configure or by SLAAC). */
  ipv6Address?: IPv6Address;
  /** [Item 243] IPv6 global unicast address assigned by SLAAC. */
  ipv6GlobalAddress?: IPv6Address;

  private arpTable    = new Map<IPv4Address, MACAddress>();
  /** [Item 223] Tick of last ARP update per IP (for stale-entry eviction). */
  private arpTimestamps = new Map<IPv4Address, number>();
  /** [Item 224] Frames queued while waiting for ARP resolution. */
  private arpPendingTx  = new Map<IPv4Address, EthernetFrame[]>();
  /**
   * [Item 229] IP fragment reassembly buffers.
   * Key = "src:id:proto"; value holds fragment map + expected total length.
   */
  private ipFragments   = new Map<string, { frags: Map<number, number[]>; total: number }>();
  private connections = new Map<number, TCPConnection>();
  private sockets     = new Map<number, Socket>();
  private listeners   = new Map<number, Socket>(); // listening port → socket
  private rxQueue:  number[][] = [];
  /** Raw UDP inbox: port → queue of { from, fromPort, data } */
  private udpRxMap  = new Map<number, Array<{ from: IPv4Address; fromPort: number; data: number[] }>>();
  private idCounter = 1;
  private nextConn  = 1;
  private nextSock  = 1;
  private nextEph   = 49152; // ephemeral port range start
  /** [Item 236] Static routing table for longest-prefix match. */
  private routeTable: RouteEntry[] = [];
  /** [Item 237/272] Joined IPv4 multicast groups. */
  private multicastGroups = new Set<IPv4Address>();
  /** [Item 242] NDP neighbor cache: IPv6Address → MACAddress. */
  private ndpTable = new Map<IPv6Address, MACAddress>();
  /** [Item 241] Queue of IPv6 packets awaiting NDP resolution. */
  private ndpPendingTx = new Map<IPv6Address, IPv6Packet[]>();
  /** Current ticks (incremented by SLAAC/NDP logic) for retransmission. */
  private v6IdCounter = 1;

  private stats = {
    rxPackets: 0, txPackets: 0,
    rxBytes:   0, txBytes:   0,
    rxErrors:  0, txErrors:  0,
    arpRx: 0, arpTx: 0,
    icmpRx: 0, icmpTx: 0,
    tcpRx: 0,  tcpTx: 0,
    udpRx: 0,  udpTx: 0,
  };

  constructor() {
    this.arpTable.set('127.0.0.1', '00:00:00:00:00:00');
    this.arpTable.set(this.ip,     this.mac);
  }

  // ── Ingress ───────────────────────────────────────────────────────────────

  /** Feed a raw Ethernet frame into the stack (called by C driver interrupt handler). */
  receive(raw: number[]): void {
    this.stats.rxPackets++;
    this.stats.rxBytes += raw.length;
    this.rxQueue.push(raw);
    this.processRxQueue();
  }

  private processRxQueue(): void {
    var frame: number[] | undefined;
    while ((frame = this.rxQueue.shift()) !== undefined) {
      var eth = parseEthernet(frame);
      if (!eth) { this.stats.rxErrors++; continue; }
      var ethertype = eth.ethertype;
      var payload   = eth.payload;
      // [Item 225] Strip 802.1Q VLAN tag transparently
      if (ethertype === ETYPE_VLAN) {
        var vlan = parseVLAN(payload);
        if (!vlan) { this.stats.rxErrors++; continue; }
        ethertype = vlan.innerEthertype;
        payload   = vlan.payload;
        // Reconstruct eth with inner values for downstream handlers
        eth = { dst: eth.dst, src: eth.src, ethertype, payload };
      }
      if (ethertype === ETYPE_ARP)  this.handleARP(eth);
      if (ethertype === ETYPE_IPV4) this.handleIPv4(eth);
      // [Item 241] Handle IPv6 frames
      if (ethertype === ETYPE_IPV6) this.handleIPv6(eth);
    }
  }

  private handleARP(eth: EthernetFrame): void {
    this.stats.arpRx++;
    var arp = parseARP(eth.payload);
    if (!arp) return;
    this.arpTable.set(arp.senderIP, arp.senderMAC);
    // [Item 223] Track the timestamp for stale-entry eviction.
    this.arpTimestamps.set(arp.senderIP, kernel.getTicks());
    // [Item 224] On ARP reply, flush any frames queued for this host.
    if (arp.operation === 2) {
      var pending = this.arpPendingTx.get(arp.senderIP);
      if (pending) {
        for (var fi = 0; fi < pending.length; fi++) {
          pending[fi].dst = arp.senderMAC;
          this._sendEth(pending[fi]);
        }
        this.arpPendingTx.delete(arp.senderIP);
      }
    }
    if (arp.operation === 1 && arp.targetIP === this.ip) {
      this._sendEth({
        dst: arp.senderMAC, src: this.mac, ethertype: ETYPE_ARP,
        payload: buildARP({ operation: 2, senderMAC: this.mac, senderIP: this.ip,
                            targetMAC: arp.senderMAC, targetIP: arp.senderIP }),
      });
    }
  }

  private handleIPv4(eth: EthernetFrame): void {
    var ip = parseIPv4(eth.payload);
    if (!ip) return;

    // [Item 229] Reassemble fragmented datagrams before further processing.
    var moreFrags = (ip.flags & 0x1) !== 0;
    if (moreFrags || ip.fragOff !== 0) {
      ip = this._reassembleIP(ip);
      if (!ip) return; // Still waiting for more fragments.
    }

    var isForUs = (ip.dst === this.ip || ip.dst === '255.255.255.255' || ip.dst === '127.0.0.1'
                   || this.multicastGroups.has(ip.dst));  // [Item 237/272] multicast membership
    if (!isForUs) {
      // [Item 230] Packets we are forwarding: send ICMP Time Exceeded if TTL ≤ 1.
      if (ip.ttl <= 1) this._sendICMPError(ip, 11 /* Time Exceeded */, 0);
      return;
    }

    // [Item 230] Silently drop packets with TTL = 0 destined for us.
    if (ip.ttl === 0) return;

    switch (ip.protocol) {
      case PROTO_ICMP: this.handleICMP(ip);  break;
      case PROTO_TCP:  this.handleTCP(ip);   break;
      case PROTO_UDP:  this.handleUDP(ip);   break;
      // [Item 237] IGMP membership management
      case PROTO_IGMP: break;  // we originate IGMP; no need to process received queries here
    }
  }

  /**
   * [Item 229] IP fragment reassembly.
   * Buffers payloads keyed by "src:id:proto".  Returns the reassembled
   * IPv4Packet when all fragments have arrived, or null while still waiting.
   */
  private _reassembleIP(ip: IPv4Packet): IPv4Packet | null {
    var key  = ip.src + ':' + ip.id + ':' + ip.protocol;
    var entry = this.ipFragments.get(key);
    if (!entry) {
      entry = { frags: new Map<number, number[]>(), total: -1 };
      this.ipFragments.set(key, entry);
    }

    var byteOff  = ip.fragOff * 8;     // Fragment byte offset in reassembled datagram.
    entry.frags.set(byteOff, ip.payload);
    var moreFrags = (ip.flags & 0x1) !== 0;
    if (!moreFrags) {
      // This is the last fragment — we now know the total payload length.
      entry.total = byteOff + ip.payload.length;
    }
    if (entry.total < 0) return null;  // Haven't seen last fragment yet.

    // Check whether all bytes are accounted for.
    var covered = 0;
    entry.frags.forEach(function(data) { covered += data.length; });
    if (covered < entry.total) return null;

    // Assemble the full payload from frags (sorted by offset).
    var offsets: number[] = [];
    entry.frags.forEach(function(_, off) { offsets.push(off); });
    offsets.sort(function(a, b) { return a - b; });
    var payload: number[] = [];
    for (var oi = 0; oi < offsets.length; oi++) {
      var chunk = entry.frags.get(offsets[oi])!;
      for (var ci = 0; ci < chunk.length; ci++) payload.push(chunk[ci]);
    }
    this.ipFragments.delete(key);
    return Object.assign({}, ip, { fragOff: 0, flags: ip.flags & ~0x1, payload });
  }

  /**
   * [Items 230, 233] Send an ICMP error message back to the original sender.
   * type = 11 → Time Exceeded; type = 3 → Destination Unreachable.
   * Payload = 28 bytes: 4 zeros + original IP header (20 bytes) + first 8 bytes of original payload.
   */
  private _sendICMPError(orig: IPv4Packet, type: number, code: number): void {
    var origHdr  = buildIPv4(orig).slice(0, 20);
    var origData = orig.payload.slice(0, 8);
    var icmpBody = [0, 0, 0, 0].concat(origHdr, origData);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 64, protocol: PROTO_ICMP,
      src: this.ip, dst: orig.src,
      payload: buildICMP(type, code, icmpBody),
    });
    this.stats.icmpTx++;
  }

  private handleICMP(ip: IPv4Packet): void {
    this.stats.icmpRx++;
    var icmp = parseICMP(ip.payload);
    if (!icmp) return;
    if (icmp.type === 8) { // Echo Request → Echo Reply
      this._sendIPv4({
        ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
        flags: 2, fragOff: 0, ttl: 64, protocol: PROTO_ICMP,
        src: this.ip, dst: ip.src,
        payload: buildICMP(0, 0, icmp.data),
      });
      this.stats.icmpTx++;
    }
  }

  // ── IPv6 / ICMPv6 / NDP (Items 241–244) ─────────────────────────────────────────────

  private handleIPv6(eth: EthernetFrame): void {
    var ip6 = parseIPv6(eth.payload);
    if (!ip6) return;
    // Filter: accept link-local/global addresses for our interface
    var isForUs = (ip6.dst === this.ipv6Address ||
                   ip6.dst === this.ipv6GlobalAddress ||
                   ip6.dst.startsWith('ff'));   // multicast
    if (!isForUs) return;
    // Decrement hop limit gate
    if (ip6.hopLimit === 0) return;
    switch (ip6.nextHeader) {
      case PROTO_ICMPV6: this.handleICMPv6(ip6); break;
    }
  }

  /**
   * [Item 242] ICMPv6 handler: ping6 replies and NDP Neighbor Solicitation/Advertisement.
   */
  private handleICMPv6(ip6: IPv6Packet): void {
    if (ip6.payload.length < 4) return;
    var type = ip6.payload[0];
    var code = ip6.payload[1];
    switch (type) {
      case ICMPV6_ECHO_REQUEST: {
        // [Item 241] Reply to ICMPv6 echo request (ping6)
        var reply = ip6.payload.slice();
        reply[0] = ICMPV6_ECHO_REPLY;
        reply[2] = 0; reply[3] = 0;  // clear checksum
        var ck = checksumICMPv6(ip6.dst, ip6.src, reply);
        reply[2] = (ck >> 8) & 0xff; reply[3] = ck & 0xff;
        this._sendIPv6({ trafficClass: 0, flowLabel: 0,
          nextHeader: PROTO_ICMPV6, hopLimit: 64,
          src: ip6.dst, dst: ip6.src,
          payload: reply, extHeaders: [] });
        break;
      }
      case ICMPV6_NEIGHBOR_SOLICITATION: {
        // [Item 242] NDP NS: who has <target>? Answer with NA for our address.
        if (ip6.payload.length < 24) break;
        var target = bytesToIpv6(ip6.payload, 8);
        if (target !== this.ipv6Address && target !== this.ipv6GlobalAddress) break;
        var na = fill(24);
        na[0] = ICMPV6_NEIGHBOR_ADVERTISEMENT;
        na[1] = 0;
        na[4] = 0xe0;  // S+O+R flags
        var tb = ipv6ToBytes(target);
        for (var ti = 0; ti < 16; ti++) na[8 + ti] = tb[ti];
        // Target Link-Layer Address option (type 2, len 1 unit = 8 bytes)
        na.push(2, 1);
        macToBytes(this.mac).forEach(function(v) { na.push(v); });
        na[2] = 0; na[3] = 0;
        var nck = checksumICMPv6(ip6.dst, ip6.src, na);
        na[2] = (nck >> 8) & 0xff; na[3] = nck & 0xff;
        this._sendIPv6({ trafficClass: 0, flowLabel: 0,
          nextHeader: PROTO_ICMPV6, hopLimit: 255,
          src: this.ipv6Address || ip6.dst, dst: ip6.src,
          payload: na, extHeaders: [] });
        break;
      }
      case ICMPV6_NEIGHBOR_ADVERTISEMENT: {
        // [Item 242] Record neighbor's MAC from Target Link-Layer Address option
        if (ip6.payload.length < 24) break;
        var naSrc = bytesToIpv6(ip6.payload, 8);
        // Scan options for type-2 (target link-layer address)
        var oOff = 24;
        while (oOff + 8 <= ip6.payload.length) {
          var oLen = ip6.payload[oOff + 1] * 8;
          if (oLen === 0) break;
          if (ip6.payload[oOff] === 2 && oLen >= 8) {
            this.ndpTable.set(naSrc, bytesToMac(ip6.payload, oOff + 2));
            // Flush any pending TX for this neighbor
            var pq6 = this.ndpPendingTx.get(naSrc);
            if (pq6) {
              for (var pqi = 0; pqi < pq6.length; pqi++) this._sendIPv6(pq6[pqi]);
              this.ndpPendingTx.delete(naSrc);
            }
            break;
          }
          oOff += oLen;
        }
        break;
      }
      case ICMPV6_ROUTER_ADVERTISEMENT: {
        // [Item 243] SLAAC: extract /64 prefix from RA and form global unicast address
        if (ip6.payload.length < 16) break;
        var rOff = 12;  // skip type, code, cksum, hop-limit, flags, lifetime, reachable, retrans
        while (rOff + 8 <= ip6.payload.length) {
          var rOptType = ip6.payload[rOff];
          var rOptLen  = ip6.payload[rOff + 1] * 8;
          if (rOptLen === 0) break;
          // Option type 3 = Prefix Information
          if (rOptType === 3 && rOptLen >= 32) {
            var prefixLen = ip6.payload[rOff + 2];
            var autoFlag  = (ip6.payload[rOff + 3] & 0x40) !== 0;  // A-flag
            if (autoFlag && prefixLen === 64) {
              var prefix = ip6.payload.slice(rOff + 16, rOff + 32);
              // Form address: 64-bit prefix + EUI-64 IID
              var m2 = this.mac.split(':').map(function(h) { return parseInt(h, 16); });
              var iid = [m2[0] ^ 0x02, m2[1], m2[2], 0xff, 0xfe, m2[3], m2[4], m2[5]];
              this.ipv6GlobalAddress = bytesToIpv6(prefix.concat(iid));
            }
          }
          rOff += rOptLen;
        }
        break;
      }
    }
  }

  /** Send an IPv6 packet; resolves next-hop via NDP (queues if unresolved). */
  private _sendIPv6(pkt: IPv6Packet): void {
    var dst6 = pkt.dst;
    // Multicast or link-local: map to Ethernet multicast 33:33:xx:xx:xx:xx
    if (dst6.startsWith('ff')) {
      var db = ipv6ToBytes(dst6);
      var mcastMac = '33:33:' + db.slice(12).map(function(x) {
        var s = x.toString(16); return s.length < 2 ? '0' + s : s;
      }).join(':');
      this._sendEth({ dst: mcastMac, src: this.mac, ethertype: ETYPE_IPV6, payload: buildIPv6(pkt) });
      return;
    }
    var dstMac = this.ndpTable.get(dst6);
    if (!dstMac) {
      // Queue and send NDP Neighbor Solicitation
      var pq = this.ndpPendingTx.get(dst6);
      if (!pq) { pq = []; this.ndpPendingTx.set(dst6, pq); }
      pq.push(pkt);
      this._sendNS(dst6);
      return;
    }
    this._sendEth({ dst: dstMac, src: this.mac, ethertype: ETYPE_IPV6, payload: buildIPv6(pkt) });
  }

  /** [Item 242] Send an NDP Neighbor Solicitation for targetAddr. */
  private _sendNS(targetAddr: IPv6Address): void {
    var src6 = this.ipv6Address || eui64LinkLocal(this.mac);
    var tb   = ipv6ToBytes(targetAddr);
    // Solicited-node multicast: ff02::1:ffXX:XXXX
    var snmDst = 'ff02::1:ff' + tb.slice(13).map(function(x) {
      var s = x.toString(16); return s.length < 2 ? '0' + s : s;
    }).join('');
    var ns = fill(24);
    ns[0] = ICMPV6_NEIGHBOR_SOLICITATION;
    for (var i = 0; i < 16; i++) ns[8 + i] = tb[i];
    // Source Link-Layer Address option (type 1)
    ns.push(1, 1);
    macToBytes(this.mac).forEach(function(v) { ns.push(v); });
    ns[2] = 0; ns[3] = 0;
    var ck = checksumICMPv6(src6, snmDst, ns);
    ns[2] = (ck >> 8) & 0xff; ns[3] = ck & 0xff;
    this._sendIPv6({ trafficClass: 0, flowLabel: 0,
      nextHeader: PROTO_ICMPV6, hopLimit: 255,
      src: src6, dst: snmDst, payload: ns, extHeaders: [] });
  }

  private handleTCP(ip: IPv4Packet): void {
    this.stats.tcpRx++;
    var seg = parseTCP(ip.payload);
    if (!seg) return;
    var conn = this._findConn(ip.src, seg.srcPort, seg.dstPort);
    if (conn) {
      this._tcpStateMachine(conn, ip, seg);
    } else if (seg.flags & TCP_SYN) {
      var listener = this.listeners.get(seg.dstPort);
      if (listener) this._tcpAccept(listener, ip, seg);
      else          this._tcpReset(ip.src, seg.srcPort, seg.dstPort, seg.seq);
    } else if (!(seg.flags & TCP_RST)) {
      this._tcpReset(ip.src, seg.srcPort, seg.dstPort, seg.seq);
    }
  }

  private handleUDP(ip: IPv4Packet): void {
    this.stats.udpRx++;
    var udp = parseUDP(ip.payload);
    if (!udp) return;

    // [Item 271] Accept broadcast datagrams for any registered socket/inbox.
    var isBcast = (ip.dst === '255.255.255.255' || ip.dst === this._broadcast());

    // Deliver to socket API (string-based).
    var sock = this._findUDPSock(udp.dstPort);
    if (sock) sock.recvQueue.push(bytesToStr(udp.payload));

    // Deliver to raw UDP inbox (byte-based, for DHCP/DNS/NTP).
    var inbox = this.udpRxMap.get(udp.dstPort);
    if (inbox !== undefined) {
      inbox.push({ from: ip.src, fromPort: udp.srcPort, data: udp.payload });
    }

    // [Item 233] If no handler exists for this unicast port, send ICMP Port Unreachable.
    if (!sock && inbox === undefined && !isBcast) {
      this._sendICMPError(ip, 3 /* Destination Unreachable */, 3 /* Port Unreachable */);
    }
  }

  // ── TCP state machine ─────────────────────────────────────────────────────

  private _randSeq(): number { return (Math.floor(Math.random() * 0x7fffffff)) >>> 0; }

  private _tcpMakeConn(state: TCPState, localPort: number,
                        remoteIP: IPv4Address, remotePort: number,
                        iss: number, recvSeq: number): TCPConnection {
    return {
      id: this.nextConn++, state,
      localIP: this.ip, localPort,
      remoteIP, remotePort,
      sendSeq: iss, recvSeq,
      sndUna: iss,
      sendBuf: [], recvBuf: [], window: 65535,
      nagle: true, mss: 1460, nagleBuf: [],
      srtt: 0, rttvar: 0, rtoTicks: 100, rtoDead: -1,
      rtxFlags: 0, rtxSeq: iss, rtxPayload: [],
      dupAcks: 0, lastAckSeq: iss,
      persistDead: -1, persistCount: 0,
      timeWaitDead: -1,
      // TCP options
      sendWscale: 0, recvWscale: 0,
      sackEnabled: false, sackQueue: [],
      tsEnabled: false, tsLastSent: 0, tsEcr: 0,
      // Keepalive
      keepalive: false,
      keepaliveIdle: 7500,
      keepaliveInterval: 750,
      keepaliveMaxProbes: 9,
      keepaliveProbeCount: 0,
      keepaliveDead: -1,
      // BBR
      useBBR: false, bbr: undefined,
    };
  }

  private _tcpAccept(listener: Socket, ip: IPv4Packet, seg: TCPSegment): void {
    // [Item 262] Enforce backlog limit
    if (listener.pendingConns.length >= listener.backlog) return;

    var iss = this._randSeq();
    var conn = this._tcpMakeConn('SYN_RECEIVED', seg.dstPort, ip.src, seg.srcPort, iss, (seg.seq + 1) >>> 0);

    // [Item 255-257] Negotiate TCP options from the incoming SYN
    var synOpts: BuildTCPOpts = {};
    if (seg.sackOk) {
      conn.sackEnabled = true;
      synOpts.sackOk = true;
    }
    if (seg.wscale !== undefined) {
      conn.recvWscale = seg.wscale;
      conn.sendWscale = 7; // advertise our window scale shift
      synOpts.wscale  = conn.sendWscale;
    }
    if (seg.tsVal !== undefined) {
      conn.tsEnabled  = true;
      conn.tsEcr      = seg.tsVal;
      synOpts.tsVal   = kernel.getTicks() >>> 0;
      synOpts.tsEcr   = seg.tsVal;
    }

    this.connections.set(conn.id, conn);
    this._sendTCPSegOpts(conn, TCP_SYN | TCP_ACK, [], synOpts);
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
    conn.sndUna  = conn.sendSeq;  // SYN consumed
    listener.pendingConns.push(conn);
  }

  /** Update smoothed RTT (Jacobson/Karels algorithm, ticks units). */
  private _tcpUpdateRTT(conn: TCPConnection, measuredTicks: number): void {
    if (conn.srtt === 0) {
      // First measurement
      conn.srtt   = measuredTicks * 8;
      conn.rttvar = measuredTicks * 4;
    } else {
      var delta = measuredTicks - (conn.srtt >> 3);
      conn.srtt   = (conn.srtt + delta) | 0;
      if (delta < 0) delta = -delta;
      conn.rttvar = (conn.rttvar + ((delta - (conn.rttvar >> 2)) >> 2)) | 0;
    }
    // RTO = SRTT + 4*RTTVAR; clamp 10–6000 ticks (~100 ms – 60 s)
    var rto = (conn.srtt >> 3) + (conn.rttvar >> 2);
    conn.rtoTicks = Math.max(10, Math.min(6000, rto));
  }

  /** Clear retransmit state after all data is acknowledged. */
  private _tcpClearRetransmit(conn: TCPConnection): void {
    conn.rtxPayload = [];
    conn.rtoDead    = -1;
  }

  private _tcpStateMachine(conn: TCPConnection, ip: IPv4Packet, seg: TCPSegment): void {
    // RST handling: abort any half-open/established connection (items 249, 249)
    if (seg.flags & TCP_RST) {
      conn.state = 'CLOSED';
      this._tcpClearRetransmit(conn);
      this.connections.delete(conn.id);
      return;
    }

    switch (conn.state) {
      case 'SYN_RECEIVED':
        if (seg.flags & TCP_ACK) {
          conn.state = 'ESTABLISHED';
          conn.sndUna = seg.ack;
          conn.lastAckSeq = seg.ack;
        }
        break;

      case 'ESTABLISHED': {
        // ── Window update ──────────────────────────────────────────────────
        var newWindow = seg.window;
        if (newWindow > 0 && conn.persistDead >= 0) {
          // Remote window re-opened: cancel persist timer
          conn.persistDead  = -1;
          conn.persistCount = 0;
          // Flush any corked nagle data
          this._tcpFlushNagle(conn);
        } else if (newWindow === 0 && conn.persistDead < 0) {
          // Remote window just closed: arm persist timer (~5 s)
          conn.persistDead  = kernel.getTicks() + 500;
          conn.persistCount = 0;
        }
        conn.window = newWindow;

        // ── ACK processing ─────────────────────────────────────────────────
        if ((seg.flags & TCP_ACK) && seg.ack !== 0) {
          // Detect new vs duplicate ACK
          var ackAdvanced = (((seg.ack - conn.sndUna) & 0x7fffffff) > 0);
          if (ackAdvanced) {
            // New ACK — update RTT roughly (using RTO ticks as sent-time proxy)
            if (conn.rtoDead >= 0) {
              var elapsed = conn.rtoTicks - Math.max(0, conn.rtoDead - kernel.getTicks());
              if (elapsed > 0) {
                this._tcpUpdateRTT(conn, elapsed);
                // [Item 260] Feed BBR model if enabled
                if (conn.useBBR && conn.bbr) {
                  var bytesAcked = ((seg.ack - conn.sndUna) & 0x7fffffff);
                  bbrOnAck(conn.bbr, elapsed, bytesAcked, kernel.getTicks());
                }
              }
            }
            conn.sndUna     = seg.ack;
            conn.lastAckSeq = seg.ack;
            conn.dupAcks    = 0;
            // Cancel RTO if all data acked
            if (conn.sndUna === conn.sendSeq) {
              this._tcpClearRetransmit(conn);
              this._tcpFlushNagle(conn); // drain any waiting data
            } else {
              // Restart RTO for remaining unacked data
              conn.rtoDead = kernel.getTicks() + conn.rtoTicks;
            }
          } else if (seg.ack === conn.lastAckSeq) {
            // Duplicate ACK
            conn.dupAcks++;
            if (conn.dupAcks >= 3 && conn.rtxPayload.length > 0) {
              // Fast retransmit (item 254): 3 dup ACKs → retransmit lost segment
              this._tcpRetransmit(conn);
              conn.dupAcks = 0;
              conn.rtoTicks = Math.min(conn.rtoTicks * 2, 6000); // inflate cwnd proxy
            }
          }
        }

        // ── Data delivery ──────────────────────────────────────────────────
        if (seg.payload.length > 0) {
          Array.prototype.push.apply(conn.recvBuf, seg.payload);
          conn.recvSeq = (conn.recvSeq + seg.payload.length) >>> 0;
          var sockD = this._findSockForConn(conn);
          if (sockD) sockD.recvQueue.push(bytesToStr(seg.payload));
          this._sendTCPSeg(conn, TCP_ACK, []);
        }

        // ── FIN handling ───────────────────────────────────────────────────
        if (seg.flags & TCP_FIN) {
          conn.recvSeq = (conn.recvSeq + 1) >>> 0;
          conn.state = 'CLOSE_WAIT';
          this._sendTCPSeg(conn, TCP_ACK, []);
        }
        break;
      }

      case 'FIN_WAIT_1':
        if ((seg.flags & TCP_ACK) && (((seg.ack - conn.sndUna) & 0x7fffffff) > 0)) {
          conn.sndUna = seg.ack;
          conn.state  = 'FIN_WAIT_2';
        }
        if (seg.flags & TCP_FIN) {
          // Simultaneous close
          conn.recvSeq = (conn.recvSeq + 1) >>> 0;
          this._sendTCPSeg(conn, TCP_ACK, []);
          conn.state = 'CLOSING';
        }
        break;

      case 'FIN_WAIT_2':
        if (seg.flags & TCP_FIN) {
          conn.recvSeq = (conn.recvSeq + 1) >>> 0;
          this._sendTCPSeg(conn, TCP_ACK, []);
          // Enter TIME_WAIT — 2 MSL, simulated at 200 ticks (~2 s)
          conn.state        = 'TIME_WAIT';
          conn.timeWaitDead = kernel.getTicks() + 200;
        }
        break;

      case 'CLOSING':
        if (seg.flags & TCP_ACK) {
          conn.state        = 'TIME_WAIT';
          conn.timeWaitDead = kernel.getTicks() + 200;
        }
        break;

      case 'LAST_ACK':
        if (seg.flags & TCP_ACK) {
          conn.state = 'CLOSED';
          this.connections.delete(conn.id);
        }
        break;

      case 'SYN_SENT':
        if ((seg.flags & (TCP_SYN | TCP_ACK)) === (TCP_SYN | TCP_ACK)) {
          conn.recvSeq    = (seg.seq + 1) >>> 0;
          conn.sndUna     = seg.ack;
          conn.lastAckSeq = seg.ack;
          conn.window     = seg.window;
          conn.state      = 'ESTABLISHED';
          // [Item 255-257] Capture options from SYN-ACK
          if (seg.sackOk)  conn.sackEnabled = true;
          if (seg.wscale !== undefined) {
            conn.recvWscale = seg.wscale;
          }
          if (seg.tsVal !== undefined) {
            conn.tsEnabled = true;
            conn.tsEcr     = seg.tsVal;
          }
          this._sendTCPSeg(conn, TCP_ACK, []);
          this._tcpClearRetransmit(conn); // SYN acked
        }
        break;
    }
  }

  /** Retransmit the saved unacknowledged segment (RTO or fast-retransmit). */
  private _tcpRetransmit(conn: TCPConnection): void {
    if (conn.rtxPayload.length === 0 && conn.rtxFlags === 0) return;
    var raw = buildTCP({
      srcPort: conn.localPort, dstPort: conn.remotePort,
      seq: conn.rtxSeq, ack: conn.recvSeq,
      flags: conn.rtxPayload.length > 0 ? (TCP_PSH | TCP_ACK) : conn.rtxFlags,
      window: conn.window, urgent: 0,
      payload: conn.rtxPayload,
    }, conn.localIP, conn.remoteIP);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 2, fragOff: 0, ttl: 64, protocol: PROTO_TCP,
      src: conn.localIP, dst: conn.remoteIP, payload: raw,
    });
    // Restart RTO with backoff
    conn.rtoTicks = Math.min(conn.rtoTicks * 2, 6000);
    conn.rtoDead  = kernel.getTicks() + conn.rtoTicks;
    this.stats.tcpTx++;
  }

  /** Flush Nagle buffer: send if window and either no unacked data or buf >= MSS. */
  private _tcpFlushNagle(conn: TCPConnection): void {
    if (conn.nagleBuf.length === 0) return;
    var inflight = (conn.sendSeq - conn.sndUna) & 0x7fffffff;
    var canSend  = !conn.nagle                   // TCP_NODELAY: always send
                || inflight === 0               // no unacked data: send
                || conn.nagleBuf.length >= conn.mss; // full segment: send
    if (canSend && conn.window > 0) {
      var chunk = conn.nagleBuf.splice(0, Math.min(conn.nagleBuf.length, conn.mss, conn.window));
      this._sendTCPSeg(conn, TCP_PSH | TCP_ACK, chunk);
    }
  }

  private _sendTCPSeg(conn: TCPConnection, flags: number, payload: number[]): void {
    this._sendTCPSegOpts(conn, flags, payload);
  }

  private _sendTCPSegOpts(conn: TCPConnection, flags: number, payload: number[],
                          extraOpts?: BuildTCPOpts): void {
    var seq = conn.sendSeq;
    var opts: BuildTCPOpts | undefined;
    // [Item 257] Include timestamps if negotiated
    if (conn.tsEnabled || extraOpts) {
      opts = extraOpts ? Object.assign({}, extraOpts) : {};
      if (conn.tsEnabled && opts.tsVal === undefined) {
        opts.tsVal = kernel.getTicks() >>> 0;
        opts.tsEcr = conn.tsEcr;
      }
    }
    // [Item 255] Include pending SACK blocks in ACKs
    if (conn.sackEnabled && conn.sackQueue.length > 0 && (flags & TCP_ACK)) {
      if (!opts) opts = {};
      opts.sackBlocks = conn.sackQueue.slice(0, 4);
    }
    var raw = buildTCP({
      srcPort: conn.localPort, dstPort: conn.remotePort,
      seq, ack: conn.recvSeq,
      flags, window: 65535, urgent: 0, payload,
    }, conn.localIP, conn.remoteIP, opts);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 2, fragOff: 0, ttl: 64, protocol: PROTO_TCP,
      src: conn.localIP, dst: conn.remoteIP,
      payload: raw,
    });
    if (payload.length > 0) {
      // Save for potential retransmit
      conn.rtxSeq     = seq;
      conn.rtxFlags   = flags;
      conn.rtxPayload = payload.slice();
      conn.sendSeq    = (seq + payload.length) >>> 0;
      // Arm RTO if not already running
      if (conn.rtoDead < 0) conn.rtoDead = kernel.getTicks() + conn.rtoTicks;
    } else if (flags & (TCP_SYN | TCP_FIN)) {
      // SYN/FIN consume one sequence number
      conn.rtxSeq   = seq;
      conn.rtxFlags = flags;
      conn.rtxPayload = [];
      if (conn.rtoDead < 0) conn.rtoDead = kernel.getTicks() + conn.rtoTicks;
    }
    this.stats.tcpTx++;
  }

  private _tcpReset(remoteIP: IPv4Address, remotePort: number, localPort: number, seq: number): void {
    var raw = buildTCP({
      srcPort: localPort, dstPort: remotePort,
      seq: 0, ack: (seq + 1) >>> 0,
      flags: TCP_RST | TCP_ACK, window: 0, urgent: 0, payload: [],
    }, this.ip, remoteIP);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 64, protocol: PROTO_TCP,
      src: this.ip, dst: remoteIP, payload: raw,
    });
  }

  // ── Lookup helpers ────────────────────────────────────────────────────────

  private _findConn(remoteIP: IPv4Address, remotePort: number, localPort: number): TCPConnection | null {
    for (var [, c] of this.connections) {
      if (c.remoteIP === remoteIP && c.remotePort === remotePort && c.localPort === localPort) return c;
    }
    return null;
  }
  private _findSockForConn(conn: TCPConnection): Socket | null {
    for (var [, s] of this.sockets) {
      if (s.type === 'tcp' && s.localPort === conn.localPort &&
          s.remoteIP === conn.remoteIP && s.remotePort === conn.remotePort) return s;
    }
    return null;
  }
  private _findUDPSock(port: number): Socket | null {
    for (var [, s] of this.sockets) {
      if (s.type === 'udp' && s.localPort === port) return s;
    }
    return null;
  }
  private _connForSock(sock: Socket): TCPConnection | null {
    for (var [, c] of this.connections) {
      if (c.localPort === sock.localPort &&
          c.remoteIP  === sock.remoteIP  &&
          c.remotePort === sock.remotePort) return c;
    }
    return null;
  }

  // ── Egress ────────────────────────────────────────────────────────────────

  private _sendEth(frame: EthernetFrame): void {
    var raw = buildEthernet(frame);
    this.stats.txPackets++;
    this.stats.txBytes += raw.length;

    if (this.nicReady) {
      // Pass a Uint8Array so C hits the JS_GetArrayBuffer() fast path:
      // one memcpy instead of 1514 individual JS_GetPropertyUint32 calls.
      kernel.netSendFrame(new Uint8Array(raw) as any);
      // Also push self-addressed frames to the local RX queue immediately
      // (for any intra-stack loopback still needed while NIC is active).
      if (frame.dst === this.mac) {
        this.rxQueue.push(raw);
      }
    } else {
      // Loopback-only mode (no NIC): deliver locally addressed frames back
      // to the receive queue so the stack is self-sufficient for unit tests.
      if (frame.dst === this.mac || frame.dst === 'ff:ff:ff:ff:ff:ff') {
        this.rxQueue.push(raw);
      }
    }
  }

  /**
   * Poll the virtio-net NIC for received frames and feed them to the stack.
   * Call this in a loop or from a timer tick when the NIC is active.
   * Returns the number of frames processed.
   */
  pollNIC(): number {
    if (!this.nicReady) return 0;
    var count = 0;
    for (var i = 0; i < 32; i++) {   // drain at most 32 frames per call
      var ab = kernel.netRecvFrame() as any;
      if (!ab) break;
      // C now returns an ArrayBuffer.  Unpack once here with a fast typed-array
      // loop — far cheaper than 1514 individual JS_SetPropertyUint32 calls in C.
      var u8view = new Uint8Array(ab);
      var raw: number[] = new Array(u8view.length);
      for (var j = 0; j < u8view.length; j++) raw[j] = u8view[j];
      this.receive(raw);
      count++;
    }
    return count;
  }

  /**
   * Activate the real NIC and update the MAC address from hardware.
   * Called once after kernel.netInit() returns true.
   */
  initNIC(): void {
    var macBytes = kernel.netMacAddress();
    var parts: string[] = [];
    for (var i = 0; i < 6; i++) {
      var hex = (macBytes[i] & 0xff).toString(16);
      parts.push(hex.length < 2 ? '0' + hex : hex);
    }
    var hwMac = parts.join(':');
    this.arpTable.delete(this.mac);
    this.mac = hwMac;
    this.arpTable.set(this.ip, this.mac);
    this.nicReady = true;
    // [Item 222] Gratuitous ARP: announce our IP/MAC to the LAN so that
    // neighbours can update their ARP caches immediately.
    this.stats.arpTx++;
    this._sendEth({
      dst: 'ff:ff:ff:ff:ff:ff', src: this.mac, ethertype: ETYPE_ARP,
      payload: buildARP({
        operation: 1, senderMAC: this.mac, senderIP: this.ip,
        targetMAC: '00:00:00:00:00:00', targetIP: this.ip,
      }),
    });
  }

  /**
   * Send an ARP request for targetIP and poll the NIC until we receive a reply
   * or the timeout (in PIT ticks, ~10 ms each) expires.
   * Returns the resolved MAC or null on timeout.
   */
  arpWait(targetIP: IPv4Address, timeoutTicks: number = 300): MACAddress | null {
    // If already in ARP table, return immediately
    var cached = this.arpTable.get(targetIP);
    if (cached) return cached;

    // Send ARP request
    this._arpRequest(targetIP);
    if (this.nicReady) {
      var deadline = kernel.getTicks() + timeoutTicks;
      while (kernel.getTicks() < deadline) {
        this.pollNIC();
        var resolved = this.arpTable.get(targetIP);
        if (resolved) return resolved;
        kernel.sleep(1);  // yield to QEMU so virtio TX/RX BHs can run
      }
      return null;
    }
    // Loopback mode: ARP reply comes from our own stack (above loopback path)
    this.processRxQueue();
    return this.arpTable.get(targetIP) || null;
  }

  private _sendIPv4(pkt: IPv4Packet): void {
    var dst = pkt.dst;
    var dstMac: MACAddress;
    // Broadcast address: no ARP needed
    if (dst === '255.255.255.255') {
      dstMac = 'ff:ff:ff:ff:ff:ff';
    } else {
      // [Item 236] Longest-prefix match over routeTable, fall back to gateway
      var nextHop = this._lookupRoute(dst);
      dstMac = this.arpTable.get(nextHop) || '';
      if (!dstMac) {
        dstMac = this.arpWait(nextHop, this.nicReady ? 100 : 0) || '';
        if (!dstMac) {
          var pendingQueue = this.arpPendingTx.get(nextHop);
          if (!pendingQueue) { pendingQueue = []; this.arpPendingTx.set(nextHop, pendingQueue); }
          pendingQueue.push({ dst: '00:00:00:00:00:00', src: this.mac, ethertype: ETYPE_IPV4, payload: buildIPv4(pkt) });
          this._arpRequest(nextHop);
          return;
        }
      }
    }
    this._sendEth({ dst: dstMac, src: this.mac, ethertype: ETYPE_IPV4, payload: buildIPv4(pkt) });
  }

  /**
   * [Item 236] Longest-prefix match: returns the next-hop IP for a given destination.
   * Consults routeTable first (sorted by prefix length desc), then falls back
   * to on-link or default gateway.
   */
  private _lookupRoute(dst: IPv4Address): IPv4Address {
    var dstU = ipToU32(dst);
    // Sort by mask length descending (most-specific first) then by metric
    var best: RouteEntry | null = null;
    for (var ri = 0; ri < this.routeTable.length; ri++) {
      var r = this.routeTable[ri];
      var maskU = ipToU32(r.mask);
      if ((dstU & maskU) === (ipToU32(r.prefix) & maskU)) {
        if (!best || maskU > ipToU32(best.mask) ||
            (maskU === ipToU32(best.mask) && r.metric < best.metric)) best = r;
      }
    }
    if (best) return best.gateway === '0.0.0.0' ? dst : best.gateway;
    return sameSubnet(dst, this.ip, this.mask) ? dst : this.gateway;
  }

  private _arpRequest(targetIP: IPv4Address): void {
    this.stats.arpTx++;
    this._sendEth({
      dst: 'ff:ff:ff:ff:ff:ff', src: this.mac, ethertype: ETYPE_ARP,
      payload: buildARP({
        operation: 1, senderMAC: this.mac, senderIP: this.ip,
        targetMAC: '00:00:00:00:00:00', targetIP,
      }),
    });
  }

  // ── Socket API ────────────────────────────────────────────────────────────

  createSocket(type: SocketType = 'tcp'): Socket {
    var s: Socket = {
      id: this.nextSock++, type,
      localIP: this.ip, localPort: 0,
      state: 'closed', recvQueue: [],
      backlog: 128, pendingConns: [], reuseAddr: false,
      rcvBufSize: 0, sndBufSize: 0,
    };
    this.sockets.set(s.id, s);
    return s;
  }

  bind(sock: Socket, port: number, ip?: IPv4Address): boolean {
    // [Item 270] EADDRINUSE: reject if port is already bound (unless SO_REUSEADDR).
    if (!sock.reuseAddr) {
      if (sock.type === 'udp' && this.udpRxMap.has(port)) return false;
      if (sock.type === 'tcp' && this.listeners.has(port)) return false;
    }
    sock.localPort = port;
    if (ip) sock.localIP = ip;
    sock.state = 'bound';
    return true;
  }

  /** [Item 262] Start listening with a backlog queue limit. */
  listen(sock: Socket, backlog: number = 128): boolean {
    if (sock.state !== 'bound') return false;
    sock.backlog = backlog;
    sock.state = 'listening';
    this.listeners.set(sock.localPort, sock);
    return true;
  }

  /** [Item 263] Set SO_REUSEADDR: allow rebinding a port already in TIME_WAIT. */
  setReuseAddr(sock: Socket, enable: boolean): void {
    sock.reuseAddr = enable;
  }

  /**
   * [Item 264] Enable/configure TCP keepalive on a socket's connection.
   * @param idle     Idle ticks before first probe (default 7500 ≈ 75 s at 100 Hz)
   * @param interval Ticks between probes (default 750)
   * @param maxProbes Max unanswered probes before aborting connection (default 9)
   */
  setKeepAlive(sock: Socket, enable: boolean, idle: number = 7500,
               interval: number = 750, maxProbes: number = 9): void {
    var conn = this._connForSock(sock);
    if (conn) {
      conn.keepalive           = enable;
      conn.keepaliveIdle       = idle;
      conn.keepaliveInterval   = interval;
      conn.keepaliveMaxProbes  = maxProbes;
      conn.keepaliveDead       = enable ? kernel.getTicks() + idle : -1;
    }
  }

  connect(sock: Socket, remoteIP: IPv4Address, remotePort: number): boolean {
    sock.remoteIP   = remoteIP;
    sock.remotePort = remotePort;
    if (!sock.localPort) sock.localPort = this.nextEph++;
    if (sock.type === 'tcp') {
      var iss = this._randSeq();
      var conn = this._tcpMakeConn('SYN_SENT', sock.localPort, remoteIP, remotePort, iss, 0);
      this.connections.set(conn.id, conn);
      // [Item 255-257] Advertise SACK, window scale, and timestamps in the SYN.
      // Options are only activated after the peer echoes them in SYN-ACK.
      conn.sendWscale = 7;
      this._sendTCPSegOpts(conn, TCP_SYN, [], {
        wscale: conn.sendWscale,
        sackOk: true,
        tsVal: kernel.getTicks() >>> 0,
        tsEcr: 0,
      });
      conn.sendSeq = (conn.sendSeq + 1) >>> 0;
      if (this.nicReady) {
        // Block-poll NIC until ESTABLISHED or timeout (200 ticks ≈ 2 s)
        var deadline = kernel.getTicks() + 200;
        while (kernel.getTicks() < deadline && conn.state === 'SYN_SENT') {
          this.pollNIC();
          this.processRxQueue();
          kernel.sleep(1);  // yield to QEMU for virtio BH processing
        }
      } else {
        // Loopback mode: process synchronously
        this.processRxQueue();
      }
    }
    sock.state = 'connected';
    return true;
  }

  /**
   * Set TCP_NODELAY on a socket.
   * When noDelay=true, Nagle is disabled and each send() goes out immediately.
   */
  setNoDelay(sock: Socket, noDelay: boolean): void {
    var conn = this._connForSock(sock);
    if (conn) conn.nagle = !noDelay;
  }

  send(sock: Socket, data: string): boolean {
    var bytes = strToBytes(data);
    if (sock.type === 'tcp') {
      var conn = this._connForSock(sock);
      if (!conn || conn.state !== 'ESTABLISHED') return false;
      // Nagle: push into nagleBuf, then try to flush
      Array.prototype.push.apply(conn.nagleBuf, bytes);
      this._tcpFlushNagle(conn);
    } else {
      if (!sock.remoteIP || !sock.remotePort) return false;
      var udpPkt = buildUDP(sock.localPort, sock.remotePort, bytes);
      this._sendIPv4({
        ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
        flags: 0, fragOff: 0, ttl: 64, protocol: PROTO_UDP,
        src: sock.localIP, dst: sock.remoteIP,
        payload: udpPkt,
      });
      this.stats.udpTx++;
    }
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    return true;
  }

  recv(sock: Socket): string | null {
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    return sock.recvQueue.shift() || null;
  }

  /**
   * Send raw binary data over a TCP socket.
   */
  sendBytes(sock: Socket, bytes: number[]): boolean {
    if (sock.type !== 'tcp') return false;
    var conn = this._connForSock(sock);
    if (!conn || conn.state !== 'ESTABLISHED') return false;
    this._sendTCPSeg(conn, TCP_PSH | TCP_ACK, bytes);
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    return true;
  }

  /**
   * Receive raw binary data from a TCP socket.
   * Polls the NIC and processes the RX queue once, then returns buffered data.
   */
  recvBytes(sock: Socket, timeoutTicks: number = 0): number[] | null {
    var deadline = timeoutTicks > 0 ? kernel.getTicks() + timeoutTicks : 0;
    do {
      if (this.nicReady) this.pollNIC();
      this.processRxQueue();
      var conn = this._connForSock(sock);
      if (conn && conn.recvBuf.length > 0) {
        var data = conn.recvBuf.slice();
        conn.recvBuf = [];
        return data;
      }
      if (deadline > 0 && kernel.getTicks() >= deadline) break;
      kernel.sleep(1);  // yield to QEMU for virtio BH processing
    } while (deadline > 0);
    return null;
  }

  /**
   * Initiate a TCP connection without blocking.
   * Call connectPoll() once per frame until it returns 'connected'.
   */
  connectAsync(sock: Socket, remoteIP: IPv4Address, remotePort: number): void {
    sock.remoteIP   = remoteIP;
    sock.remotePort = remotePort;
    if (!sock.localPort) sock.localPort = this.nextEph++;
    var iss  = this._randSeq();
    var conn = this._tcpMakeConn('SYN_SENT', sock.localPort, remoteIP, remotePort, iss, 0);
    this.connections.set(conn.id, conn);
    this._sendTCPSeg(conn, TCP_SYN, []);
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
    // sock.state stays 'connecting' until connectPoll confirms ESTABLISHED
  }

  /**
   * Poll a socket started with connectAsync.
   * Returns 'connected' once TCP handshake completes, 'pending' otherwise.
   */
  connectPoll(sock: Socket): 'connected' | 'pending' {
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    var conn = this._connForSock(sock);
    if (conn && conn.state === 'ESTABLISHED') {
      sock.state = 'connected';
      return 'connected';
    }
    return 'pending';
  }

  /**
   * Non-blocking receive: poll the NIC once and return any buffered TCP data,
   * or null if nothing is available yet.
   */
  recvBytesNB(sock: Socket): number[] | null {
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    var conn = this._connForSock(sock);
    if (conn && conn.recvBuf.length > 0) {
      var data = conn.recvBuf.slice();
      conn.recvBuf = [];
      return data;
    }
    return null;
  }

  /**
   * Send a UDP datagram with raw byte payload.
   */
  sendUDPRaw(localPort: number, dstIP: IPv4Address, dstPort: number, data: number[]): void {
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 64, protocol: PROTO_UDP,
      src: this.ip, dst: dstIP,
      payload: buildUDP(localPort, dstPort, data),
    });
    this.stats.udpTx++;
  }

  /**
   * Receive one UDP datagram on localPort.
   * Registers an inbox, blocks-polls the NIC for timeoutTicks, then deregisters.
   * Returns { from, fromPort, data } or null on timeout.
   */
  recvUDPRaw(localPort: number, timeoutTicks: number = 300):
      { from: IPv4Address; fromPort: number; data: number[] } | null {
    // Register inbox for this port
    if (!this.udpRxMap.has(localPort)) this.udpRxMap.set(localPort, []);
    var inbox = this.udpRxMap.get(localPort)!;
    var deadline = kernel.getTicks() + timeoutTicks;
    while (kernel.getTicks() < deadline) {
      if (this.nicReady) this.pollNIC(); else this.processRxQueue();
      this.processRxQueue();
      if (inbox.length > 0) {
        var pkt = inbox.shift()!;
        this.udpRxMap.delete(localPort);
        return pkt;
      }
      kernel.sleep(1);  // yield to QEMU for virtio BH processing
    }
    this.udpRxMap.delete(localPort);
    return null;
  }

  /**
   * Non-blocking UDP receive on localPort.
   * Registers the inbox if needed, polls once, returns first datagram or null.
   * The inbox is NOT removed — caller must call udpRxMap.delete(port) when done.
   */
  recvUDPRawNB(localPort: number): { from: IPv4Address; fromPort: number; data: number[] } | null {
    if (!this.udpRxMap.has(localPort)) this.udpRxMap.set(localPort, []);
    if (this.nicReady) this.pollNIC();
    this.processRxQueue();
    var inbox = this.udpRxMap.get(localPort)!;
    if (inbox.length > 0) return inbox.shift()!;
    return null;
  }

  close(sock: Socket): void {
    if (sock.type === 'tcp') {
      var conn = this._connForSock(sock);
      if (conn && conn.state === 'ESTABLISHED') {
        conn.state = 'FIN_WAIT_1';
        this._sendTCPSeg(conn, TCP_FIN | TCP_ACK, []);
        conn.sendSeq = (conn.sendSeq + 1) >>> 0;
        conn.state = 'CLOSED';
        this.connections.delete(conn.id);
      }
    }
    if (sock.state === 'listening') this.listeners.delete(sock.localPort);
    this.sockets.delete(sock.id);
    sock.state = 'closed';
  }

  // ── ICMP ping ─────────────────────────────────────────────────────────────

  /**
   * Send a single ICMP echo request and wait up to `timeoutMs` for a reply.
   * Returns round-trip time in ms or -1 on timeout.
   * (Synchronous — uses kernel.sleep + kernel.getTicks for timing.)
   */
  ping(targetIP: IPv4Address, timeoutMs: number = 2000): number {
    var id    = (this.idCounter++) & 0xffff;
    var seq   = 1;
    var data  = fill(8);
    wu16be(data, 0, id);
    wu16be(data, 2, seq);
    wu32be(data, 4, kernel.getTicks());

    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 64, protocol: PROTO_ICMP,
      src: this.ip, dst: targetIP,
      payload: buildICMP(8, 0, data),
    });
    this.stats.icmpTx++;

    var start = kernel.getTicks();
    var deadline = start + timeoutMs;
    while (kernel.getTicks() < deadline) {
      this.processRxQueue();
      // Check for ICMP echo reply in arp table (simplification — real impl
      // would need a pending-reply registry)
      kernel.sleep(10);
    }
    return -1; // timeout (real driver needed for actual reply detection)
  }

  /**
   * Send an ICMP echo with a specific TTL — used by traceroute (item 722).
   * Returns RTT in ms if an ICMP Time-Exceeded or Echo-Reply arrives within
   * timeoutMs, or -1 on timeout.  In simulation mode this always times out
   * (identical to ping), but the TTL-limited packet is correctly sent.
   */
  pingWithTTL(targetIP: IPv4Address, ttl: number, timeoutMs: number = 1000): number {
    var id   = (this.idCounter++) & 0xffff;
    var seq  = ttl & 0xffff;
    var data = fill(8);
    wu16be(data, 0, id);
    wu16be(data, 2, seq);
    wu32be(data, 4, kernel.getTicks());

    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: Math.max(1, ttl), protocol: PROTO_ICMP,
      src: this.ip, dst: targetIP,
      payload: buildICMP(8, 0, data),
    });
    this.stats.icmpTx++;

    var start    = kernel.getTicks();
    var deadline = start + timeoutMs;
    while (kernel.getTicks() < deadline) {
      this.processRxQueue();
      kernel.sleep(10);
    }
    return -1; // timeout; real NIC reply needed for actual RTT
  }

  // ── ARP ───────────────────────────────────────────────────────────────────

  resolve(ip: IPv4Address): MACAddress | null {
    var mac = this.arpTable.get(ip);
    if (!mac) { this._arpRequest(ip); return null; }
    return mac;
  }

  getArpTable(): Array<{ ip: IPv4Address; mac: MACAddress }> {
    var result: Array<{ ip: IPv4Address; mac: MACAddress }> = [];
    this.arpTable.forEach(function(mac, ip) { result.push({ ip, mac }); });
    return result;
  }

  // ── Configuration & stats ─────────────────────────────────────────────────

  configure(opts: {
    ip?:      IPv4Address;
    mac?:     MACAddress;
    gateway?: IPv4Address;
    dns?:     IPv4Address;
    mask?:    IPv4Address;
  }): void {
    if (opts.ip)      { this.arpTable.delete(this.ip); this.ip = opts.ip; this.arpTable.set(this.ip, this.mac); }
    if (opts.mac)     { this.mac     = opts.mac; }
    if (opts.gateway) { this.gateway = opts.gateway; }
    if (opts.dns)     { this.dns     = opts.dns; }
    if (opts.mask)    { this.mask    = opts.mask; }
  }

  /** Open (pre-register) a UDP inbox for `port` so frames arriving before
   *  the first recvUDPRawNB call are buffered, not dropped.
   * [Item 270] Returns false if the port is already in use (EADDRINUSE). */
  openUDPInbox(port: number): boolean {
    if (this.udpRxMap.has(port)) return false;
    this.udpRxMap.set(port, []);
    return true;
  }

  /** Close and discard the UDP inbox for `port`. */
  closeUDPInbox(port: number): void {
    this.udpRxMap.delete(port);
  }

  getStats() { return Object.assign({}, this.stats); }

  getConnections(): TCPConnection[] {
    return Array.from(this.connections.values());
  }

  // ── Routing Table API (Item 236) ──────────────────────────────────────────────────────

  /** [Item 236] Add a static route to the routing table. */
  addRoute(route: RouteEntry): void {
    this.routeTable.push(route);
  }

  /** [Item 236] Remove a static route by prefix+mask. Returns true if found. */
  removeRoute(prefix: IPv4Address, mask: IPv4Address): boolean {
    var before = this.routeTable.length;
    this.routeTable = this.routeTable.filter(function(r) {
      return !(r.prefix === prefix && r.mask === mask);
    });
    return this.routeTable.length < before;
  }

  /** [Item 236] Return a copy of the current routing table. */
  getRouteTable(): RouteEntry[] { return this.routeTable.slice(); }

  // ── Multicast / IGMP API (Items 237, 272) ───────────────────────────────────────────

  /**
   * [Items 237/272] Join an IPv4 multicast group (224.0.0.0/4).
   * Sends an IGMPv2 Membership Report and records the group for RX filtering.
   */
  joinMulticast(groupIP: IPv4Address): void {
    if (this.multicastGroups.has(groupIP)) return;
    this.multicastGroups.add(groupIP);
    // Send IGMPv2 join report to 224.0.0.2 (all-routers)
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 1, protocol: PROTO_IGMP,
      src: this.ip, dst: groupIP,
      payload: buildIGMPv2(IGMP_V2_MEMBER_REPORT, groupIP),
    });
  }

  /**
   * [Items 237/272] Leave an IPv4 multicast group.
   * Sends an IGMPv2 Leave Group message to 224.0.0.2.
   */
  leaveMulticast(groupIP: IPv4Address): void {
    if (!this.multicastGroups.has(groupIP)) return;
    this.multicastGroups.delete(groupIP);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 0, fragOff: 0, ttl: 1, protocol: PROTO_IGMP,
      src: this.ip, dst: '224.0.0.2',
      payload: buildIGMPv2(IGMP_V2_LEAVE_GROUP, groupIP),
    });
  }

  /** Return current multicast group memberships. */
  getMulticastGroups(): IPv4Address[] {
    return Array.from(this.multicastGroups);
  }

  // ── UDP Buffer Tuning (Item 273) ──────────────────────────────────────────────────────

  /** [Item 273] Set SO_RCVBUF (receive buffer size limit). 0 = unlimited. */
  setRcvBuf(sock: Socket, size: number): void { sock.rcvBufSize = size; }
  /** [Item 273] Set SO_SNDBUF (send buffer size limit). 0 = unlimited. */
  setSndBuf(sock: Socket, size: number): void { sock.sndBufSize = size; }

  // ── BBR Congestion Control API (Item 260) ────────────────────────────────────────────

  /**
   * [Item 260] Enable BBR congestion control on a connected TCP socket.
   * Must be called after connect() or accept() and before the first send().
   */
  enableBBR(sock: Socket): void {
    var conn = this._connForSock(sock);
    if (!conn) return;
    conn.useBBR = true;
    conn.bbr    = bbrInit();
  }

  // ── IPv6 Configuration API (Items 241–244) ─────────────────────────────────────────

  /**
   * [Item 241] Configure an explicit IPv6 address or derive link-local from MAC.
   * Passing no argument computes the EUI-64 link-local address automatically.
   * [Item 243] Optionally triggers SLAAC by sending a Router Solicitation.
   */
  configureIPv6(addr?: IPv6Address, sendRS: boolean = true): void {
    this.ipv6Address = addr || eui64LinkLocal(this.mac);
    if (sendRS) this._sendRouterSolicitation();
  }

  /** [Item 243] Send an ICMPv6 Router Solicitation to ff02::2 (all-routers). */
  private _sendRouterSolicitation(): void {
    var src6 = this.ipv6Address || eui64LinkLocal(this.mac);
    var rs = [ICMPV6_ROUTER_SOLICITATION, 0, 0, 0, 0, 0, 0, 0];
    // Source Link-Layer Address option (type 1, len 1 = 8 bytes)
    rs.push(1, 1);
    macToBytes(this.mac).forEach(function(v) { rs.push(v); });
    rs[2] = 0; rs[3] = 0;
    var ck = checksumICMPv6(src6, 'ff02::2', rs);
    rs[2] = (ck >> 8) & 0xff; rs[3] = ck & 0xff;
    this._sendIPv6({ trafficClass: 0, flowLabel: 0,
      nextHeader: PROTO_ICMPV6, hopLimit: 255,
      src: src6, dst: 'ff02::2', payload: rs, extHeaders: [] });
  }

  /** [Item 242] Look up an IPv6 address in the NDP table. */
  ndpLookup(addr: IPv6Address): MACAddress | null {
    return this.ndpTable.get(addr) || null;
  }

  // ── MLDv2 (Item 246) ───────────────────────────────────────────────────────────────

  /** [Item 246] IPv6 multicast groups we've joined (for MLDv2 reporting). */
  readonly v6MulticastGroups = new Set<IPv6Address>();

  /**
   * [Item 246] Join an IPv6 multicast group via MLDv2 (RFC 3810).
   * Sends an MLDv2 Report message (ICMPv6 type 143) to ff02::16.
   */
  joinMulticastV6(groupAddr: IPv6Address): void {
    if (this.v6MulticastGroups.has(groupAddr)) return;
    this.v6MulticastGroups.add(groupAddr);
    var src6 = this.ipv6Address || eui64LinkLocal(this.mac);
    // MLDv2 Report: type=143, code=0, 4-reserved, 1 record
    var gb = ipv6ToBytes(groupAddr);
    // Record type 4 = CHANGE_TO_EXCLUDE (join)
    var report: number[] = [143, 0, 0, 0, 0, 0, 0, 1,
                             4, 0, 0, 0, ...gb];
    var ck = checksumICMPv6(src6, 'ff02::16', report);
    report[2] = (ck >> 8) & 0xff; report[3] = ck & 0xff;
    this._sendIPv6({ trafficClass: 0, flowLabel: 0,
      nextHeader: PROTO_ICMPV6, hopLimit: 1,
      src: src6, dst: 'ff02::16', payload: report, extHeaders: [] });
  }

  /**
   * [Item 246] Leave an IPv6 multicast group.
   * Sends an MLDv2 Report with CHANGE_TO_INCLUDE (leave).
   */
  leaveMulticastV6(groupAddr: IPv6Address): void {
    if (!this.v6MulticastGroups.has(groupAddr)) return;
    this.v6MulticastGroups.delete(groupAddr);
    var src6 = this.ipv6Address || eui64LinkLocal(this.mac);
    var gb = ipv6ToBytes(groupAddr);
    // Record type 3 = CHANGE_TO_INCLUDE (leave)
    var report: number[] = [143, 0, 0, 0, 0, 0, 0, 1,
                             3, 0, 0, 0, ...gb];
    var ck = checksumICMPv6(src6, 'ff02::16', report);
    report[2] = (ck >> 8) & 0xff; report[3] = ck & 0xff;
    this._sendIPv6({ trafficClass: 0, flowLabel: 0,
      nextHeader: PROTO_ICMPV6, hopLimit: 1,
      src: src6, dst: 'ff02::16', payload: report, extHeaders: [] });
  }

  // ── IPv6 Privacy Extensions (Item 247) ───────────────────────────────────────────────

  /**
   * [Item 247] Generate a privacy (temporary) IPv6 address using a random IID
   * (RFC 4941) instead of the stable EUI-64 IID.  The /64 prefix is taken from
   * the current global address or from the supplied prefix bytes.
   * Returns the new temporary address and also stores it as ipv6GlobalAddress.
   */
  generatePrivacyAddress(prefixBytes?: number[]): IPv6Address {
    // Use existing global address prefix if not provided
    var prefix: number[];
    if (prefixBytes) {
      prefix = prefixBytes.slice(0, 8);
    } else {
      var cur = this.ipv6GlobalAddress || '';
      if (cur) {
        prefix = ipv6ToBytes(cur).slice(0, 8);
      } else {
        prefix = ipv6ToBytes(eui64LinkLocal(this.mac)).slice(0, 8);
      }
    }
    // RFC 4941 random IID: generate 64 random bits, set bit 6 of first byte to 0.
    var iid: number[] = [];
    for (var i = 0; i < 8; i++) iid.push(Math.floor(Math.random() * 256));
    iid[0] &= 0xfd;  // clear universal/local bit (RFC 4941 §3.2)
    var addr = bytesToIpv6(prefix.concat(iid));
    this.ipv6GlobalAddress = addr;
    return addr;
  }

  // ── DHCPv6 Client (Item 244) ────────────────────────────────────────────────────────────

  /**
   * [Item 244] DHCPv6 stateful client: Solicit → Advertise → Request → Reply.
   * Sends a Solicit to ff02::1:2 on port 547, waits for Advertise, then sends
   * Request and waits for Reply with IA_NA (assigned address).
   * Returns the assigned IPv6 address or null on timeout.
   */
  dhcpv6Solicit(timeoutTicks: number = 500): IPv6Address | null {
    var src6 = this.ipv6Address || eui64LinkLocal(this.mac);
    // [Item 244] DHCPv6 Solicit message (msg-type=1)
    // Fields: msg-type(1), transaction-id(3), options...
    var txId = [Math.floor(Math.random()*256), Math.floor(Math.random()*256), Math.floor(Math.random()*256)];
    // DUID-LL option (client-id, option 1)
    var macB = macToBytes(this.mac);
    var duid = [0, 3, 0, 1].concat(macB);  // DUID-LL type=3, hw=1, mac
    //  Option 1 (client-id): type(2) + len(2) + duid
    var clientIdOpt: number[] = [0, 1, 0, duid.length].concat(duid);
    // Option 3 (IA_NA): type(2) + len(2) + iaid(4) + t1(4) + t2(4)
    var ianOpt: number[] = [0, 3, 0, 12, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    var solicit = [1].concat(txId, clientIdOpt, ianOpt);
    var udpPayload = solicit;
    // Open receive inbox for port 546 (DHCPv6 client port)
    var DHCP6_CLI_PORT = 546;
    var DHCP6_SRV_PORT = 547;
    if (!this.udpRxMap.has(DHCP6_CLI_PORT)) this.udpRxMap.set(DHCP6_CLI_PORT, []);
    var inbox = this.udpRxMap.get(DHCP6_CLI_PORT)!;
    // Send Solicit via UDP (IPv6 would be ideal; approximate with IPv4 for now)
    // In a full IPv6-aware UDP stack, we'd use _sendIPv6 + UDP.
    // For now: send Solicit raw UDP to link-scope all-DHCP-agents (224.0.0.0 proxy).
    // Real DHCPv6 requires IPv6 UDP: we queue an IPv6 UDP Solicit below.
    var pktBody = buildUDP(DHCP6_CLI_PORT, DHCP6_SRV_PORT, udpPayload);
    this._sendIPv6({ trafficClass: 0, flowLabel: 0, nextHeader: 17, hopLimit: 1,
      src: src6, dst: 'ff02::1:2', payload: pktBody, extHeaders: [] });
    // Poll for Advertise (msg-type=2)
    var deadline = kernel.getTicks() + timeoutTicks;
    var serverAddr: IPv6Address | null = null;
    while (kernel.getTicks() < deadline && serverAddr === null) {
      if (this.nicReady) this.pollNIC();
      this.processRxQueue();
      var pkt = inbox.shift();
      if (pkt && pkt.data.length > 4 && pkt.data[0] === 2) {
        // Advertise received — send Request (msg-type=3)
        var request = [3].concat(txId, clientIdOpt, ianOpt);
        var reqBody = buildUDP(DHCP6_CLI_PORT, DHCP6_SRV_PORT, request);
        this._sendIPv6({ trafficClass: 0, flowLabel: 0, nextHeader: 17, hopLimit: 1,
          src: src6, dst: 'ff02::1:2', payload: reqBody, extHeaders: [] });
        // Wait for Reply (msg-type=7)
        var replyDeadline = kernel.getTicks() + 200;
        while (kernel.getTicks() < replyDeadline) {
          if (this.nicReady) this.pollNIC();
          this.processRxQueue();
          var replyPkt = inbox.shift();
          if (replyPkt && replyPkt.data.length > 4 && replyPkt.data[0] === 7) {
            // Parse IA_NA assigned address from Reply
            var off2 = 4;
            while (off2 + 4 < replyPkt.data.length) {
              var optType = (replyPkt.data[off2] << 8) | replyPkt.data[off2 + 1];
              var optLen  = (replyPkt.data[off2 + 2] << 8) | replyPkt.data[off2 + 3];
              if (optType === 3 && optLen >= 12) {
                // IA_NA: sub-options starting at +12
                var subOff = off2 + 4 + 12;
                while (subOff + 4 < off2 + 4 + optLen) {
                  var subType = (replyPkt.data[subOff] << 8) | replyPkt.data[subOff + 1];
                  var subLen  = (replyPkt.data[subOff + 2] << 8) | replyPkt.data[subOff + 3];
                  if (subType === 5 && subLen >= 24) {  // IAADDR option
                    serverAddr = bytesToIpv6(replyPkt.data, subOff + 4);
                    this.ipv6GlobalAddress = serverAddr;
                  }
                  subOff += 4 + subLen;
                }
              }
              off2 += 4 + optLen;
            }
            break;
          }
          kernel.sleep(1);
        }
        break;
      }
      kernel.sleep(1);
    }
    this.udpRxMap.delete(DHCP6_CLI_PORT);
    return serverAddr;
  }

  // ── NAT Connection Tracking (Item 266) ───────────────────────────────────────────────

  /** [Item 266] One tracked connection entry (5-tuple → translated 5-tuple). */
  private readonly conntrackTable = new Map<string, ConntrackEntry>();
  /** [Item 266] NAT rules (SNAT/DNAT). */
  private readonly natRules: NATRule[] = [];

  /** [Item 266] Add a NAT rule (SNAT or DNAT). */
  addNATRule(rule: NATRule): void { this.natRules.push(rule); }

  /**
   * [Item 266] Translate an outgoing IPv4 packet (SNAT).
   * Rewrites source IP/port and records the mapping in conntrackTable.
   * Returns the (possibly modified) packet.
   */
  translateTx(pkt: IPv4Packet): IPv4Packet {
    for (var ri = 0; ri < this.natRules.length; ri++) {
      var r = this.natRules[ri];
      if (r.type !== 'SNAT' || pkt.src !== r.origIP) continue;
      var key = pkt.src + ':' + pkt.dst + ':' + pkt.protocol;
      if (!this.conntrackTable.has(key)) {
        var masqPort = this.nextEph++;
        var entry: ConntrackEntry = {
          origSrc: pkt.src, origSport: 0,
          transSrc: r.translatedIP, transSport: masqPort,
          dst: pkt.dst, dport: 0, protocol: pkt.protocol,
          established: false,
        };
        this.conntrackTable.set(key, entry);
      }
      return Object.assign({}, pkt, { src: r.translatedIP });
    }
    return pkt;
  }

  /**
   * [Item 266] Translate an incoming IPv4 packet (DNAT / reverse SNAT).
   * Looks up conntrack table and rewrites destination IP/port.
   */
  translateRx(pkt: IPv4Packet): IPv4Packet {
    for (var ri2 = 0; ri2 < this.natRules.length; ri2++) {
      var r2 = this.natRules[ri2];
      if (r2.type !== 'DNAT' || pkt.dst !== r2.translatedIP) continue;
      return Object.assign({}, pkt, { dst: r2.origIP });
    }
    // Reverse-SNAT: look in conntrack for matching return traffic
    var revKey = pkt.dst + ':' + pkt.src + ':' + pkt.protocol;
    var ct = this.conntrackTable.get(revKey);
    if (ct) return Object.assign({}, pkt, { dst: ct.origSrc });
    return pkt;
  }

  // ── TCP MD5 Signature (Item 267) ───────────────────────────────────────────────────────

  /**
   * [Item 267] Enable TCP MD5 Signature (RFC 2385) on a connection.
   * The md5Key is used to compute a 16-byte MD5 digest included in TCP option
   * kind 19. Guards BGP sessions against packet injection.
   * (Full MD5 verification requires crypto.md5() from crypto.ts.)
   */
  setTCPMD5(sock: Socket, md5Key: string): void {
    var conn = this._connForSock(sock);
    if (!conn) return;
    (conn as any).md5Key = md5Key;
    (conn as any).md5Enabled = true;
  }

  // ── TCP Fast Open (Item 265) ────────────────────────────────────────────────────────

  /**
   * [Item 265] TCP Fast Open client: send SYN + initial data payload in the
   * same packet.  The server must support TFO (cookie-based or cookie-less).
   * Returns true if the connection was initiated; actual ESTABLISHED state
   * is confirmed as usual via connectPoll().
   */
  connectTFO(sock: Socket, remoteIP: IPv4Address, remotePort: number, data: number[]): boolean {
    sock.remoteIP   = remoteIP;
    sock.remotePort = remotePort;
    if (!sock.localPort) sock.localPort = this.nextEph++;
    if (sock.type !== 'tcp') return false;
    var iss  = this._randSeq();
    var conn = this._tcpMakeConn('SYN_SENT', sock.localPort, remoteIP, remotePort, iss, 0);
    this.connections.set(conn.id, conn);
    conn.sendWscale = 7;
    // [Item 265] TFO option: kind=34, len=2 (empty cookie / cookie request)
    // We piggyback the data directly in the SYN payload (Linux TFO semantics).
    this._sendTCPSegOpts(conn, TCP_SYN, data, {
      wscale: conn.sendWscale,
      sackOk: true,
      tsVal:  kernel.getTicks() >>> 0,
      tsEcr:  0,
    });
    // Only SYN byte advances ISS; data will be re-sent in ACK if TFO not supported.
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
    sock.state = 'connected';
    return true;
  }

  ifconfig(): string {
    return (
      'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n' +
      '        inet ' + this.ip + '  netmask ' + this.mask + '  broadcast ' + this._broadcast() + '\n' +
      '        ether ' + this.mac + '  txqueuelen 1000\n' +
      '        RX packets ' + this.stats.rxPackets + '  bytes ' + this.stats.rxBytes + '\n' +
      '        TX packets ' + this.stats.txPackets + '  bytes ' + this.stats.txBytes + '\n' +
      '\n' +
      'lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n' +
      '        inet 127.0.0.1  netmask 255.0.0.0\n'
    );
  }

  private _broadcast(): IPv4Address {
    var ip   = ipToU32(this.ip);
    var mask = ipToU32(this.mask);
    var bcast = (ip & mask) | (~mask >>> 0);
    return bytesToIp([
      (bcast >>> 24) & 0xff,
      (bcast >>> 16) & 0xff,
      (bcast >>>  8) & 0xff,
       bcast         & 0xff,
    ], 0);
  }

  // ─── TCP Timer Tick ──────────────────────────────────────────────────────────

  /**
   * Call ~10× per second to handle all TCP timers:
   *   • RTO expiry → retransmit with backoff
   *   • Zero-window persist probes
   *   • TIME_WAIT expiry → connection cleanup
   *
   * Wire into main.ts kernel event loop or WM tick.
   */
  tcpTick(): void {
    var now = kernel.getTicks();
    var toDelete: number[] = [];

    // [Item 223] Evict stale ARP entries (lifetime = 30 000 ticks ≈ 5 min @ 100 Hz).
    // Own IP and loopback are permanent and are never evicted.
    const ARP_TTL = 30000;
    var arpEvict: IPv4Address[] = [];
    this.arpTimestamps.forEach(function(ts, ip) {
      if (now - ts > ARP_TTL) arpEvict.push(ip);
    });
    for (var ai = 0; ai < arpEvict.length; ai++) {
      if (arpEvict[ai] === this.ip || arpEvict[ai] === '127.0.0.1') continue;
      this.arpTable.delete(arpEvict[ai]);
      this.arpTimestamps.delete(arpEvict[ai]);
    }

    this.connections.forEach((conn, id) => {
      // ── TIME_WAIT cleanup ──────────────────────────────────────────────────
      if (conn.state === 'TIME_WAIT') {
        if (conn.timeWaitDead >= 0 && now >= conn.timeWaitDead) {
          toDelete.push(id);
        }
        return; // no other timers needed in TIME_WAIT
      }

      // Only process live states
      if (conn.state !== 'ESTABLISHED' &&
          conn.state !== 'FIN_WAIT_1'  &&
          conn.state !== 'CLOSE_WAIT'  &&
          conn.state !== 'SYN_SENT') return;

      // ── RTO expiry → retransmit ────────────────────────────────────────────
      if (conn.rtoDead >= 0 && now >= conn.rtoDead) {
        this._tcpRetransmit(conn);
      }

      // ── Zero-window persist probe ──────────────────────────────────────────
      if (conn.persistDead >= 0 && now >= conn.persistDead) {
        // Send a 1-byte probe at sndUna to trigger a fresh window advertisement
        var probeByte = conn.rtxPayload.length > 0 ? [conn.rtxPayload[0]] : [0];
        var raw = buildTCP({
          srcPort: conn.localPort,
          dstPort: conn.remotePort,
          seq:     conn.sndUna,
          ack:     conn.recvSeq,
          flags:   TCP_PSH | TCP_ACK,
          window:  65535,
          urgent:  0,
          payload: probeByte,
        }, conn.localIP, conn.remoteIP);
        this._sendIPv4({
          ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++, flags: 2, fragOff: 0,
          ttl: 64, protocol: 6, src: conn.localIP, dst: conn.remoteIP, payload: raw,
        });
        this.stats.tcpTx++;

        // Exponential backoff: 5 s, 10 s, 20 s, … cap at 60 s (in ticks)
        conn.persistCount++;
        var delay = Math.min(500 * Math.pow(2, conn.persistCount), 6000);
        conn.persistDead = now + delay;
      }

      // ── [Item 264] TCP Keepalive ───────────────────────────────────────────
      if (conn.keepalive && conn.state === 'ESTABLISHED' &&
          conn.keepaliveDead >= 0 && now >= conn.keepaliveDead) {
        // Send a keepalive probe: empty ACK with seq = sndUna - 1
        var kaRaw = buildTCP({
          srcPort: conn.localPort,
          dstPort: conn.remotePort,
          seq:     (conn.sndUna - 1) >>> 0,
          ack:     conn.recvSeq,
          flags:   TCP_ACK,
          window:  65535,
          urgent:  0,
          payload: [],
        }, conn.localIP, conn.remoteIP);
        this._sendIPv4({
          ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++, flags: 2, fragOff: 0,
          ttl: 64, protocol: PROTO_TCP, src: conn.localIP, dst: conn.remoteIP,
          payload: kaRaw,
        });
        this.stats.tcpTx++;
        conn.keepaliveProbeCount++;
        if (conn.keepaliveProbeCount >= conn.keepaliveMaxProbes) {
          // [Item 264] Max probes exhausted: abort connection
          conn.state = 'CLOSED';
          toDelete.push(conn.id);
        } else {
          conn.keepaliveDead = now + conn.keepaliveInterval;
        }
      }
    });

    toDelete.forEach(id => this.connections.delete(id));
  }

  // ── High-level async helpers (DoH / DoT / mDNS support) ─────────────────────

  /**
   * HTTPS POST helper used by DNS-over-HTTPS and other callers.
   * Parses `url` into host/path, resolves the host IP via the kernel DNS stub,
   * opens a TLS connection, sends the POST request, and returns the HTTP
   * response.
   */
  async httpsPost(
    url: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string | null } | null> {
    try {
      var m   = url.match(/^https?:\/\/([^\/]+)(\/.*)?$/);
      if (!m) return null;
      var host = m[1];
      var path = m[2] || '/';
      var port = 443;
      if (host.includes(':')) { var hp = host.split(':'); host = hp[0]; port = parseInt(hp[1]); }

      // Resolve host → IP (use kernel DNS if available)
      var ip = host;
      if (typeof kernel !== 'undefined' && kernel.dns) {
        var resolved = await kernel.dns.resolve(host);
        if (resolved) ip = resolved;
      }

      // Build raw HTTP POST request bytes
      var bodyBytes: number[] = [];
      for (var i = 0; i < body.length; i++) bodyBytes.push(body.charCodeAt(i) & 0xff);

      var reqLines = ['POST ' + path + ' HTTP/1.1', 'Host: ' + host];
      reqLines.push('Content-Length: ' + bodyBytes.length);
      for (var hk in headers) reqLines.push(hk + ': ' + headers[hk]);
      reqLines.push('Connection: close', '', '');
      var head = reqLines.join('\r\n');
      var reqBytes: number[] = [];
      for (var hi = 0; hi < head.length; hi++) reqBytes.push(head.charCodeAt(hi) & 0xff);
      reqBytes = reqBytes.concat(bodyBytes);

      // Send over raw TCP socket (TLS decryption managed by TLSSocket in http.ts)
      var sock = this.createSocket('tcp');
      if (!this.connect(sock, ip, port)) { this.close(sock); return null; }
      this.sendBytes(sock, reqBytes);
      var respBytes = this.recvBytes(sock, 1000) ?? [];
      this.close(sock);

      if (respBytes.length === 0) return null;
      // Parse status line
      var respStr = String.fromCharCode(...respBytes);
      var statusM = respStr.match(/^HTTP\/[12]\.\d (\d{3})/);
      var status  = statusM ? parseInt(statusM[1]) : 0;
      var bodyStart = respStr.indexOf('\r\n\r\n');
      var respBody  = bodyStart >= 0 ? respStr.slice(bodyStart + 4) : null;
      return { status, body: respBody };
    } catch (_) {
      return null;
    }
  }

  /**
   * TLS raw send/receive helper used by DNS-over-TLS.
   * Opens a TLS TCP connection, sends `data`, reads the response, and returns
   * the raw response bytes.
   */
  async tlsSend(
    host: string,
    port: number,
    data: Uint8Array,
    serverName?: string,
  ): Promise<Uint8Array | null> {
    try {
      // Resolve host
      var ip = host;
      if (typeof kernel !== 'undefined' && kernel.dns) {
        var resolved2 = await kernel.dns.resolve(host);
        if (resolved2) ip = resolved2;
      }
      var sock = this.createSocket('tcp');
      if (!this.connect(sock, ip, port)) { this.close(sock); return null; }
      var dataArr: number[] = Array.from(data);
      this.sendBytes(sock, dataArr);
      var resp = this.recvBytes(sock, 500) ?? [];
      this.close(sock);
      return resp.length > 0 ? new Uint8Array(resp) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Send a UDP datagram to a specific (ip, port) destination.
   * Uses sendUDPRaw with an ephemeral local port.
   */
  async udpSendTo(ip: string, port: number, data: number[]): Promise<void> {
    var localPort = 49152 + ((Math.random() * 16383) | 0);
    this.openUDPInbox(localPort);
    this.sendUDPRaw(localPort, ip as IPv4Address, port, data);
    this.closeUDPInbox(localPort);
  }

  /**
   * Listen for incoming UDP datagrams on `port`.
   * Invokes `callback` for each received datagram until the returned cancel
   * function is called.
   *
   * Returns a Promise that rejects on error or resolves when cancelled.
   */
  async udpListen(
    port: number,
    callback: (data: number[], srcIp: string) => void,
  ): Promise<void> {
    this.openUDPInbox(port);
    return new Promise<void>((_resolve, reject) => {
      var active = true;
      var poll = () => {
        if (!active) return;
        var pkt = this.recvUDPRawNB(port);
        if (pkt) callback(pkt.data, pkt.from);
        if (active) setTimeout(poll, 10);
      };
      poll();
      // Expose cancel via accessor (caller closes the inbox to stop)
      (this as any)._udpListeners = (this as any)._udpListeners || {};
      (this as any)._udpListeners[port] = () => { active = false; this.closeUDPInbox(port); };
    });
  }
}

export const net = new NetworkStack();

// ════════════════════════════════════════════════════════════════════════════
// [Item 238] IP Source Routing
// [Item 239] Policy-Based Routing
// [Item 240] ip rule equivalents (multiple routing tables)
// ════════════════════════════════════════════════════════════════════════════

// ── [Item 240] Multiple routing tables ─────────────────────────────────────

/**
 * [Item 240] Routing table entry (`ip route` equivalent).
 *
 * Each table holds a list of routes.  The main table (id=254) mirrors the
 * standard Linux `main` routing table.  Additional tables are referenced by
 * policy rules (`ip rule`).
 */
export interface RouteEntry {
  /** Destination prefix in CIDR notation, e.g. "10.0.0.0/8". */
  dest:     string;
  /** Gateway IP, or "" for directly-connected networks. */
  gateway:  string;
  /** Outgoing interface name, e.g. "eth0". */
  iface:    string;
  /** Metric (lower = preferred). */
  metric:   number;
  /** Route source: 'static' | 'connected' | 'dhcp' | 'ospf' | 'bgp'. */
  proto:    string;
  /** Optional type-of-service byte for policy matching. */
  tos?:     number;
  /** ECMP weight (1 = normal). */
  weight:   number;
}

export interface RoutingTable {
  id:     number;    // 0=unspec, 253=default, 254=main, 255=local
  name:   string;    // symbolic name
  routes: RouteEntry[];
}

function _cidrToMaskLen(cidr: string): number {
  var parts = cidr.split('/');
  return parts.length > 1 ? parseInt(parts[1], 10) : 32;
}

function _cidrToNetwork(cidr: string): number {
  var ip = cidr.split('/')[0].split('.').map(Number);
  return ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
}

function _ipToNum(ip: string): number {
  var p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/**
 * [Item 240] Multi-table routing manager (ip route / ip rule model).
 *
 * Maintains multiple routing tables (identified by table ID).
 * Standard table IDs: 0=unspec, 253=default, 254=main, 255=local.
 */
export class RoutingTableManager {
  private _tables = new Map<number, RoutingTable>();

  constructor() {
    // Create standard tables
    this._tables.set(254, { id: 254, name: 'main',    routes: [] });
    this._tables.set(253, { id: 253, name: 'default', routes: [] });
    this._tables.set(255, { id: 255, name: 'local',   routes: [] });

    // Add loopback route to local table
    this._tables.get(255)!.routes.push({
      dest: '127.0.0.0/8', gateway: '', iface: 'lo', metric: 0,
      proto: 'kernel', weight: 1,
    });
  }

  /** Get or create a routing table by ID. */
  table(id: number): RoutingTable {
    if (!this._tables.has(id)) {
      this._tables.set(id, { id, name: `table${id}`, routes: [] });
    }
    return this._tables.get(id)!;
  }

  /** ip route add `entry` to table (default: main=254). */
  addRoute(entry: RouteEntry, tableId: number = 254): void {
    var tbl = this.table(tableId);
    // Remove duplicates
    tbl.routes = tbl.routes.filter(function(r) {
      return !(r.dest === entry.dest && r.iface === entry.iface && r.gateway === entry.gateway);
    });
    tbl.routes.push(entry);
    // Sort by prefix length (most specific first), then metric
    tbl.routes.sort(function(a, b) {
      var la = _cidrToMaskLen(a.dest), lb = _cidrToMaskLen(b.dest);
      if (lb !== la) return lb - la;
      return a.metric - b.metric;
    });
  }

  /** ip route del */
  deleteRoute(dest: string, tableId: number = 254): void {
    var tbl = this.table(tableId);
    tbl.routes = tbl.routes.filter(function(r) { return r.dest !== dest; });
  }

  /** Longest-prefix match in a single table. */
  lookupInTable(dstIp: string, tableId: number): RouteEntry | null {
    var tbl = this._tables.get(tableId);
    if (!tbl) return null;
    var dst = _ipToNum(dstIp);
    for (var i = 0; i < tbl.routes.length; i++) {
      var r = tbl.routes[i];
      var net = _cidrToNetwork(r.dest);
      var len = _cidrToMaskLen(r.dest);
      var mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
      if ((dst & mask) === (net & mask)) return r;
    }
    return null;
  }

  /** Dump all routes in a table (for `ip route show`). */
  showRoutes(tableId: number = 254): RouteEntry[] {
    return this._tables.get(tableId)?.routes ?? [];
  }

  /** List all tables. */
  listTables(): RoutingTable[] {
    return Array.from(this._tables.values());
  }
}

// ── [Item 239] Policy-Based Routing (ip rule) ───────────────────────────────

/**
 * [Item 239] Routing policy rule (`ip rule` equivalent).
 *
 * Rules are evaluated in order of priority (lower = first).
 * Each rule selects a routing table to use based on packet attributes.
 *
 * Standard priorities: 0=local, 32766=main, 32767=default.
 */
export interface RoutingRule {
  priority:  number;
  /** Source address/prefix to match ('' = any). */
  from:      string;
  /** Destination address/prefix to match ('' = any). */
  to:        string;
  /** TOS byte to match (0 = any). */
  tos:       number;
  /** Firewall mark to match (0 = any). */
  fwmark:    number;
  /** Table to use when rule matches. */
  tableId:   number;
  /** Action: 'lookup' | 'blackhole' | 'unreachable' | 'prohibit'. */
  action:    'lookup' | 'blackhole' | 'unreachable' | 'prohibit';
}

/**
 * [Item 239] Policy-Based Routing engine.
 *
 * Maintains an ordered list of routing rules and uses them to select
 * which routing table to consult for a given source/destination pair.
 */
export class PolicyRoutingEngine {
  private _rules: RoutingRule[] = [];
  private _rtm: RoutingTableManager;

  constructor(rtm: RoutingTableManager) {
    this._rtm = rtm;
    // Install standard rules
    this.addRule({ priority: 0,     from: '',    to: '',   tos: 0, fwmark: 0, tableId: 255, action: 'lookup' }); // local
    this.addRule({ priority: 32766, from: '',    to: '',   tos: 0, fwmark: 0, tableId: 254, action: 'lookup' }); // main
    this.addRule({ priority: 32767, from: '',    to: '',   tos: 0, fwmark: 0, tableId: 253, action: 'lookup' }); // default
  }

  /** ip rule add (inserts in priority order). */
  addRule(rule: RoutingRule): void {
    this._rules.push(rule);
    this._rules.sort(function(a, b) { return a.priority - b.priority; });
  }

  /** ip rule del `priority`. */
  deleteRule(priority: number): void {
    this._rules = this._rules.filter(function(r) { return r.priority !== priority; });
  }

  /** ip rule show. */
  listRules(): RoutingRule[] { return this._rules.slice(); }

  /**
   * Policy route lookup: evaluate rules and return the matching route.
   * @param srcIp  Source IP address.
   * @param dstIp  Destination IP address.
   * @param tos    Type of service byte.
   * @param fwmark Firewall mark.
   */
  lookup(srcIp: string, dstIp: string, tos: number = 0, fwmark: number = 0): RouteEntry | null {
    for (var i = 0; i < this._rules.length; i++) {
      var rule = this._rules[i];

      // Source match
      if (rule.from && !this._prefixMatch(srcIp, rule.from)) continue;
      // Dest match
      if (rule.to   && !this._prefixMatch(dstIp, rule.to))   continue;
      // TOS match
      if (rule.tos   && rule.tos   !== tos)    continue;
      // fwmark match
      if (rule.fwmark && rule.fwmark !== fwmark) continue;

      if (rule.action === 'blackhole')   return null;
      if (rule.action === 'unreachable') return null;
      if (rule.action === 'prohibit')    return null;

      // action === 'lookup'
      var route = this._rtm.lookupInTable(dstIp, rule.tableId);
      if (route) return route;
    }
    return null;
  }

  private _prefixMatch(ip: string, prefix: string): boolean {
    var net = _cidrToNetwork(prefix);
    var len = _cidrToMaskLen(prefix);
    var mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return (_ipToNum(ip) & mask) === (net & mask);
  }
}

// ── [Item 238] IP Source Routing ────────────────────────────────────────────

/**
 * [Item 238] IP source routing — loose and strict source routing.
 *
 * IPv4 source routing is specified in RFC 791 as IP options:
 *   - LSRR (Loose Source and Record Route, option type 131)
 *   - SSRR (Strict Source and Record Route, option type 137)
 *
 * These IP options insert routing waypoints into the IP header.
 * Routers forward toward the next waypoint rather than the final destination.
 *
 * Most modern routers drop source-routed packets (security risk), but
 * the capability is provided here for completeness and testing.
 */
export interface SourceRoute {
  /** 'loose' = LSRR (intermediate hops may be skipped),
      'strict' = SSRR (must traverse every listed hop). */
  type:    'loose' | 'strict';
  /** Ordered list of intermediate waypoints. */
  hops:    string[];
  /** Original final destination IP. */
  finalDest: string;
}

/**
 * [Item 238] Build IP source-routing option bytes for inclusion in an IP header.
 *
 * @returns LSRR or SSRR option bytes (4 + 4 * (hops+1) bytes).
 */
export function buildSourceRouteOption(sr: SourceRoute): number[] {
  var optType = sr.type === 'strict' ? 137 : 131; // SSRR or LSRR
  var addresses = [...sr.hops, sr.finalDest].map(_ipToNum);
  // Option format: type, length, pointer, [ip addresses]
  var len = 3 + 4 * addresses.length;
  var opt: number[] = [optType, len, 4]; // pointer starts at 4 (first address)
  for (var i = 0; i < addresses.length; i++) {
    opt.push((addresses[i] >>> 24) & 0xff);
    opt.push((addresses[i] >>> 16) & 0xff);
    opt.push((addresses[i] >>> 8)  & 0xff);
    opt.push( addresses[i]         & 0xff);
  }
  // Pad to 4-byte alignment
  while (opt.length % 4 !== 0) opt.push(1); // NOP
  return opt;
}

/**
 * [Item 238] Parse a LSRR/SSRR IP option from a received IP header.
 * Returns null if not a source-route option.
 */
export function parseSourceRouteOption(opt: number[]): SourceRoute | null {
  if (opt.length < 3) return null;
  var optType = opt[0];
  if (optType !== 137 && optType !== 131) return null;
  var type: 'loose' | 'strict' = optType === 137 ? 'strict' : 'loose';
  var pointer = opt[2]; // 1-based pointer to next hop
  var hops: string[] = [];
  for (var i = 3; i + 3 < opt.length; i += 4) {
    hops.push([opt[i], opt[i+1], opt[i+2], opt[i+3]].join('.'));
  }
  var finalDest = hops.pop() ?? '';
  // Hops before pointer - 4 have already been visited
  var visited = (pointer - 4) / 4;
  var remaining = hops.slice(visited);
  return { type, hops: remaining, finalDest };
}

/**
 * [Item 238] Advance a source-route option (called by router on each hop).
 * Updates the pointer and swaps the next hop address with the dest field.
 *
 * @param opt       Current LSRR/SSRR option bytes.
 * @param routerIp  This router's outgoing interface IP.
 * @param dstIp     Current destination IP (will be replaced with next hop).
 * @returns         { opt: updated option bytes, nextDst: new destination IP }
 */
export function advanceSourceRoute(
  opt: number[], routerIp: string, dstIp: string
): { opt: number[]; nextDst: string } | null {
  if (opt.length < 3 || (opt[0] !== 131 && opt[0] !== 137)) return null;
  var ptr = opt[2] - 1; // convert 1-based to 0-based
  if (ptr + 3 >= opt.length) return null; // all hops consumed

  // Extract next hop from option
  var nextHop = [opt[ptr], opt[ptr+1], opt[ptr+2], opt[ptr+3]].join('.');
  // Replace that slot with this router's address
  var rip = _ipToNum(routerIp);
  opt[ptr]   = (rip >>> 24) & 0xff;
  opt[ptr+1] = (rip >>> 16) & 0xff;
  opt[ptr+2] = (rip >>> 8)  & 0xff;
  opt[ptr+3] =  rip         & 0xff;
  // Advance pointer
  opt[2] += 4;

  return { opt, nextDst: nextHop };
}

/** Shared singleton instances. */
export const routingTables = new RoutingTableManager();
export const policyRouter  = new PolicyRoutingEngine(routingTables);

// ── 6to4 / Teredo IPv6 Transition Tunnelling (Item 248) ──────────────────────
//
// RFC 3056 (6to4) and RFC 4380 (Teredo) provide automatic IPv6-in-IPv4 tunnels
// so single-stack IPv4 hosts can send/receive IPv6 packets.
//
// 6to4: Embeds the IPv4 address in the IPv6 address (2002::/16 prefix).
//       Packets are encapsulated as IPv4 protocol 41 (IPv6).
// Teredo: Tunnels IPv6 through NATs via UDP port 3544, uses a Teredo server
//       to derive a routable IPv6 address from the public IPv4:port.
//
// JSOS implementation strategy:
//  • The kernel provides net.sendIPv4Raw(dst, proto, payload) for protocol-41
//    injection; TeredoTunnel uses net.udpSendTo for the UDP path.
//  • Encapsulation/decapsulation is done entirely in TypeScript.
//  • Both classes follow the same stub pattern as MPTCPConnection (Item 268):
//    the public API surface is complete; actual packet injection is guarded
//    by capability checks.

/**
 * [Item 248] Convert a 6to4 IPv6 address (2002:aabb:ccdd::/48) to the
 * embedded IPv4 address string.
 */
export function decode6to4Address(ipv6: string): string | null {
  // Normalise: strip leading '2002:'
  if (!ipv6.toLowerCase().startsWith('2002:')) return null;
  var parts = ipv6.split(':');
  if (parts.length < 3) return null;
  var w1 = parseInt(parts[1], 16);
  var w2 = parseInt(parts[2], 16);
  if (isNaN(w1) || isNaN(w2)) return null;
  return [(w1 >> 8) & 0xff, w1 & 0xff, (w2 >> 8) & 0xff, w2 & 0xff].join('.');
}

/**
 * [Item 248] Derive the 6to4 IPv6 address for a given IPv4 address.
 * Returns a string of the form '2002:aabb:ccdd::1'.
 */
export function encode6to4Address(ipv4: string): string {
  var octs = ipv4.split('.').map(Number);
  var w1 = ((octs[0] & 0xff) << 8) | (octs[1] & 0xff);
  var w2 = ((octs[2] & 0xff) << 8) | (octs[3] & 0xff);
  return '2002:' + w1.toString(16).padStart(4, '0') + ':' +
                   w2.toString(16).padStart(4, '0') + '::1';
}

/**
 * [Item 248] 6to4 tunnel endpoint.
 *
 * Encapsulates outbound IPv6 packets as IPv4 protocol-41 datagrams and
 * decapsulates inbound protocol-41 datagrams back to IPv6.
 *
 * RFC 3056 §5: the relay router address is an IPv4 anycast (192.88.99.1 for
 * the public relay, or a local relay on the same site).
 */
export class Tun6to4 {
  /** Local IPv4 address used as the tunnel source. */
  readonly localIPv4: string;
  /** 6to4 relay router (default: 192.88.99.1 anycast, RFC 3068). */
  readonly relayIPv4: string;
  /** Derived 6to4 IPv6 address for this node. */
  readonly ipv6Address: string;

  constructor(localIPv4: string, relayIPv4 = '192.88.99.1') {
    this.localIPv4  = localIPv4;
    this.relayIPv4  = relayIPv4;
    this.ipv6Address = encode6to4Address(localIPv4);
  }

  /**
   * Encapsulate an IPv6 packet for 6to4 transmission.
   * Returns a raw IPv4 datagram (protocol 41) ready to send via sendIPv4Raw().
   *
   * @param dstIPv6  Destination 6to4 IPv6 address (must start with 2002::).
   * @param ipv6Pkt  Raw IPv6 packet bytes.
   */
  encapsulate(dstIPv6: string, ipv6Pkt: number[]): { dest: string; payload: number[] } {
    var dstIPv4 = decode6to4Address(dstIPv6) ?? this.relayIPv4;
    // Protocol = 41 (IPv6-in-IPv4); payload = raw IPv6 packet
    return { dest: dstIPv4, payload: ipv6Pkt.slice() };
  }

  /**
   * Decapsulate an inbound protocol-41 IPv4 datagram.
   * Strips the IPv4 header (variable-length) and returns the inner IPv6 bytes.
   *
   * @param ipv4Pkt  Raw IPv4 datagram (starting at the IP header).
   */
  decapsulate(ipv4Pkt: number[]): number[] | null {
    if (ipv4Pkt.length < 20) return null;
    var proto = ipv4Pkt[9];
    if (proto !== 41) return null;  // not IPv6-in-IPv4
    var ihl = (ipv4Pkt[0] & 0x0f) * 4;
    if (ipv4Pkt.length < ihl + 40) return null;  // too short for IPv6 header
    return ipv4Pkt.slice(ihl);
  }

  /**
   * Send an IPv6 packet through the 6to4 tunnel.
   * Uses kernel.sendIPv4Raw when available, otherwise records the intent.
   */
  send(dstIPv6: string, ipv6Pkt: number[]): boolean {
    var { dest, payload } = this.encapsulate(dstIPv6, ipv6Pkt);
    if (typeof kernel !== 'undefined' && (kernel as any).sendIPv4Raw) {
      return (kernel as any).sendIPv4Raw(dest, 41 /* IPPROTO_IPV6 */, payload);
    }
    return false;
  }
}

// ── Teredo (RFC 4380) ─────────────────────────────────────────────────────────

/** UDP port used by Teredo (RFC 4380 §2.5). */
const TEREDO_PORT = 3544;

/** [Item 248] Teredo IPv6 address structure decoded from a Teredo address. */
export interface TeredoAddress {
  /** Teredo server IPv4 address (embedded bits 32–63). */
  serverIPv4: string;
  /** Client flags (bits 64–79). */
  flags: number;
  /** Obfuscated UDP port (bits 80–95) — XOR with 0xffff to get real port. */
  mappedPort: number;
  /** Obfuscated client IPv4 (bits 96–127) — each octet XOR'd with 0xff. */
  mappedIPv4: string;
}

/**
 * [Item 248] Decode the embedded server/client info from a Teredo IPv6 address.
 * Teredo prefix: 2001:0000::/32 (RFC 4380 §4).
 */
export function decodeTeredoAddress(ipv6: string): TeredoAddress | null {
  var parts = ipv6.split(':');
  if (parts.length < 8) return null;
  if (parts[0].toLowerCase() !== '2001' || parts[1] !== '0000') return null;

  var serverWord1 = parseInt(parts[2], 16);
  var serverWord2 = parseInt(parts[3], 16);
  var flags       = parseInt(parts[4], 16);
  var portObs     = parseInt(parts[5], 16);
  var addrObs1    = parseInt(parts[6], 16);
  var addrObs2    = parseInt(parts[7], 16);

  if ([serverWord1, serverWord2, flags, portObs, addrObs1, addrObs2].some(isNaN)) return null;

  var serverIPv4 = [(serverWord1 >> 8) & 0xff, serverWord1 & 0xff,
                    (serverWord2 >> 8) & 0xff, serverWord2 & 0xff].join('.');
  var realPort   = (portObs ^ 0xffff) & 0xffff;
  var a1 = ((addrObs1 >> 8) ^ 0xff) & 0xff;
  var a2 = (addrObs1 ^ 0xff) & 0xff;
  var a3 = ((addrObs2 >> 8) ^ 0xff) & 0xff;
  var a4 = (addrObs2 ^ 0xff) & 0xff;

  return {
    serverIPv4,
    flags,
    mappedPort: realPort,
    mappedIPv4: [a1, a2, a3, a4].join('.'),
  };
}

/**
 * [Item 248] Teredo tunnel endpoint stub (RFC 4380).
 *
 * Tunnels IPv6 packets over UDP/IPv4 so NAT-traversal is handled automatically
 * by Teredo relay routers.  Each IPv6 packet is wrapped in a Teredo UDP packet
 * sent to the Teredo server or a peer relay.
 *
 * Lifetime:
 *   1. qualify() exchanges RS/RA with the server to obtain a Teredo IPv6 address.
 *   2. send() encapsulates the IPv6 packet as a Teredo UDP datagram.
 *   3. decapsulate() strips the Teredo UDP header from an inbound datagram.
 */
export class TeredoTunnel {
  /** Teredo server address (default: teredo.ipv6.microsoft.com resolved to IPv4). */
  readonly serverIPv4: string;
  /** Teredo server port. */
  readonly serverPort: number;
  /** Derived Teredo IPv6 address (populated after qualify()). */
  ipv6Address: string | null = null;
  /** Mapped public IPv4 of this node (learned from Router Advertisement). */
  mappedIPv4: string | null = null;
  /** Mapped UDP port (learned from Router Advertisement). */
  mappedPort: number | null = null;
  /** Internal UDP socket fd. */
  private _sock: number = -1;

  constructor(serverIPv4: string, serverPort: number = TEREDO_PORT) {
    this.serverIPv4 = serverIPv4;
    this.serverPort = serverPort;
  }

  /**
   * Qualify the Teredo tunnel: send a Router Solicitation to the server
   * and parse the Router Advertisement to learn our mapped address/port.
   *
   * On JSOS this uses net.udpCreateSocket / net.udpSendTo.  Returns true if
   * qualification succeeded and ipv6Address was populated.
   */
  qualify(): boolean {
    if (typeof net === 'undefined') return false;
    var sock = net.udpCreateSocket();
    if (!sock || sock.fd < 0) return false;
    this._sock = sock.fd;

    // Router Solicitation (ICMPv6 type 133): minimal 8-byte empty RS
    // Teredo encapsulation: no authentication indicator, no origin indication
    var rs: number[] = [0x86, 0xdd,  // fake Ethernet type (IPv6)
                        0x60, 0x00, 0x00, 0x00, 0x00, 0x08, 0x3a, 0xff,
                        // src: all-zeros
                        0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
                        // dst: all-routers multicast ff02::2
                        0xff,0x02,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0x02,
                        // ICMPv6 RS header
                        0x85, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    net.udpSendTo(sock, this.serverIPv4, this.serverPort, rs);

    // Wait for Router Advertisement (type 134) — abbreviated busy-wait
    if (typeof kernel !== 'undefined') {
      var deadline = kernel.getTicks() + 500;
      while (kernel.getTicks() < deadline) {
        var pkt = net.udpRecvFrom(sock);
        if (pkt && pkt.data.length > 8) {
          var inner = this.decapsulate(pkt.data);
          if (inner && inner.length > 40 && inner[40] === 134 /* RA */) {
            // Parse origin indication from Teredo server: last 6 bytes of RA
            // carry the mapped port (2 bytes, XOR 0xffff) and IPv4 (4 bytes, XOR each 0xff)
            var portObs = (inner[inner.length - 6] << 8) | inner[inner.length - 5];
            var port    = (portObs ^ 0xffff) & 0xffff;
            var ip      = [(inner[inner.length - 4] ^ 0xff), (inner[inner.length - 3] ^ 0xff),
                           (inner[inner.length - 2] ^ 0xff), (inner[inner.length - 1] ^ 0xff)].join('.');
            this.mappedIPv4 = ip;
            this.mappedPort = port;
            // Build a Teredo IPv6 address: 2001:0000:<server32>:<flags>:<portObs>:<ipObs>
            var sip = this.serverIPv4.split('.').map(Number);
            var sw1 = (sip[0] << 8) | sip[1];
            var sw2 = (sip[2] << 8) | sip[3];
            var oip = ip.split('.').map(function(o: string) { return (parseInt(o, 10) ^ 0xff) & 0xff; });
            var ow1 = (oip[0] << 8) | oip[1];
            var ow2 = (oip[2] << 8) | oip[3];
            this.ipv6Address =
              '2001:0000:' + sw1.toString(16).padStart(4,'0') + ':' + sw2.toString(16).padStart(4,'0') +
              ':0000:' + portObs.toString(16).padStart(4,'0') + ':' +
              ow1.toString(16).padStart(4,'0') + ':' + ow2.toString(16).padStart(4,'0');
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Encapsulate an IPv6 packet as a Teredo UDP payload.
   * Per RFC 4380 §4: the IPv6 packet is the UDP payload; no additional header.
   */
  encapsulate(ipv6Pkt: number[]): number[] { return ipv6Pkt.slice(); }

  /**
   * Strip a Teredo origin indication (if present) from an inbound UDP datagram
   * and return the inner IPv6 packet.
   *
   * RFC 4380 §5.2.1: an origin indication starts with 0x00 0x00.
   * Authentication indication starts with 0x00 0x01 — both are skipped.
   */
  decapsulate(data: number[]): number[] | null {
    if (data.length < 2) return null;
    var off = 0;
    // Skip indicators
    while (off + 2 <= data.length && data[off] === 0x00 &&
           (data[off + 1] === 0x00 || data[off + 1] === 0x01)) {
      if (data[off + 1] === 0x01) {
        // Authentication indicator: variable length, skip
        if (off + 4 > data.length) return null;
        var idLen    = data[off + 2];
        var auLen    = data[off + 3];
        off += 4 + idLen + auLen + 8;  // +8 for nonce/confirmation
      } else {
        // Origin indication: fixed 8 bytes
        off += 8;
      }
    }
    if (off >= data.length) return null;
    var ipv6 = data.slice(off);
    // Validate: first nibble of IPv6 header must be 0x6x
    if ((ipv6[0] >> 4) !== 6) return null;
    return ipv6;
  }

  /**
   * Send an IPv6 packet through the Teredo tunnel to the given peer relay.
   * @param dstRelay  IPv4 address of the Teredo relay for the destination.
   * @param dstPort   UDP port of the Teredo relay (default TEREDO_PORT).
   * @param ipv6Pkt   Raw IPv6 packet bytes.
   */
  send(dstRelay: string, ipv6Pkt: number[], dstPort: number = TEREDO_PORT): boolean {
    if (this._sock < 0 || typeof net === 'undefined') return false;
    var sock = { fd: this._sock } as any;
    var payload = this.encapsulate(ipv6Pkt);
    return net.udpSendTo(sock, dstRelay, dstPort, payload) > 0;
  }
}

