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

const PROTO_ICMP = 1;
const PROTO_TCP  = 6;
const PROTO_UDP  = 17;

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
      if (eth.ethertype === ETYPE_ARP)  this.handleARP(eth);
      if (eth.ethertype === ETYPE_IPV4) this.handleIPv4(eth);
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

    var isForUs = (ip.dst === this.ip || ip.dst === '255.255.255.255' || ip.dst === '127.0.0.1');
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
              if (elapsed > 0) this._tcpUpdateRTT(conn, elapsed);
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
    // Broadcast address: no ARP needed – always Ethernet broadcast
    if (dst === '255.255.255.255') {
      dstMac = 'ff:ff:ff:ff:ff:ff';
    } else {
      var nextHop = sameSubnet(dst, this.ip, this.mask) ? dst : this.gateway;
      dstMac = this.arpTable.get(nextHop) || '';
      if (!dstMac) {
        // When NIC is active, block-wait briefly for ARP reply.
        dstMac = this.arpWait(nextHop, this.nicReady ? 100 : 0) || '';
        if (!dstMac) {
          // [Item 224] Queue the frame in arpPendingTx so it is sent once
          // the ARP reply arrives, instead of falling back to broadcast.
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
}

export const net = new NetworkStack();
