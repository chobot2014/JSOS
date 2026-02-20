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
  var len = (length !== undefined) ? length : data.length - offset;
  var sum = 0;
  for (var i = 0; i < len - 1; i += 2) {
    sum += ((data[offset + i] & 0xff) << 8) | (data[offset + i + 1] & 0xff);
  }
  if (len & 1) sum += (data[offset + len - 1] & 0xff) << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
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

export interface TCPSegment {
  srcPort: number;
  dstPort: number;
  seq:     number;
  ack:     number;
  flags:   number;
  window:  number;
  urgent:  number;
  payload: number[];
}

function parseTCP(raw: number[]): TCPSegment | null {
  if (raw.length < 20) return null;
  var dataOff = ((raw[12] >> 4) & 0xf) * 4;
  if (raw.length < dataOff) return null;
  return {
    srcPort: u16be(raw, 0),
    dstPort: u16be(raw, 2),
    seq:     u32be(raw, 4),
    ack:     u32be(raw, 8),
    flags:   raw[13],
    window:  u16be(raw, 14),
    urgent:  u16be(raw, 18),
    payload: raw.slice(dataOff),
  };
}
function buildTCP(seg: TCPSegment, srcIP: IPv4Address, dstIP: IPv4Address): number[] {
  var h = fill(20);
  wu16be(h, 0,  seg.srcPort);
  wu16be(h, 2,  seg.dstPort);
  wu32be(h, 4,  seg.seq);
  wu32be(h, 8,  seg.ack);
  wu8(h, 12, 0x50); // data offset = 5 words
  wu8(h, 13, seg.flags);
  wu16be(h, 14, seg.window);
  wu16be(h, 16, 0);
  wu16be(h, 18, seg.urgent);
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
  window:     number;
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
    var isForUs = (ip.dst === this.ip || ip.dst === '255.255.255.255' || ip.dst === '127.0.0.1');
    if (!isForUs) return;
    switch (ip.protocol) {
      case PROTO_ICMP: this.handleICMP(ip);  break;
      case PROTO_TCP:  this.handleTCP(ip);   break;
      case PROTO_UDP:  this.handleUDP(ip);   break;
    }
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
    // Deliver to socket API (string-based)
    var sock = this._findUDPSock(udp.dstPort);
    if (sock) sock.recvQueue.push(bytesToStr(udp.payload));
    // Deliver to raw UDP inbox (byte-based, for DHCP/DNS)
    var inbox = this.udpRxMap.get(udp.dstPort);
    if (inbox !== undefined) {
      inbox.push({ from: ip.src, fromPort: udp.srcPort, data: udp.payload });
    }
  }

  // ── TCP state machine ─────────────────────────────────────────────────────

  private _randSeq(): number { return (Math.floor(Math.random() * 0x7fffffff)) >>> 0; }

  private _tcpAccept(listener: Socket, ip: IPv4Packet, seg: TCPSegment): void {
    var iss = this._randSeq();
    var conn: TCPConnection = {
      id: this.nextConn++, state: 'SYN_RECEIVED',
      localIP: this.ip, localPort: seg.dstPort,
      remoteIP: ip.src, remotePort: seg.srcPort,
      sendSeq: iss, recvSeq: seg.seq + 1,
      sendBuf: [], recvBuf: [], window: 65535,
    };
    this.connections.set(conn.id, conn);
    this._sendTCPSeg(conn, TCP_SYN | TCP_ACK, []);
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
  }

  private _tcpStateMachine(conn: TCPConnection, ip: IPv4Packet, seg: TCPSegment): void {
    switch (conn.state) {
      case 'SYN_RECEIVED':
        if (seg.flags & TCP_ACK) conn.state = 'ESTABLISHED';
        break;
      case 'ESTABLISHED':
        if (seg.payload.length > 0) {
          conn.recvBuf = conn.recvBuf.concat(seg.payload);
          conn.recvSeq = (conn.recvSeq + seg.payload.length) >>> 0;
          // Deliver to socket's recvQueue
          var sock = this._findSockForConn(conn);
          if (sock) sock.recvQueue.push(bytesToStr(seg.payload));
          this._sendTCPSeg(conn, TCP_ACK, []);
        }
        if (seg.flags & TCP_FIN) {
          conn.recvSeq = (conn.recvSeq + 1) >>> 0;
          conn.state = 'CLOSE_WAIT';
          this._sendTCPSeg(conn, TCP_ACK, []);
        }
        break;
      case 'FIN_WAIT_1':
        if (seg.flags & TCP_ACK) conn.state = 'FIN_WAIT_2';
        break;
      case 'FIN_WAIT_2':
        if (seg.flags & TCP_FIN) {
          conn.recvSeq = (conn.recvSeq + 1) >>> 0;
          this._sendTCPSeg(conn, TCP_ACK, []);
          conn.state = 'CLOSED';
          this.connections.delete(conn.id);
        }
        break;
      case 'SYN_SENT':
        if ((seg.flags & (TCP_SYN | TCP_ACK)) === (TCP_SYN | TCP_ACK)) {
          conn.recvSeq = (seg.seq + 1) >>> 0;
          conn.state = 'ESTABLISHED';
          this._sendTCPSeg(conn, TCP_ACK, []);
        }
        break;
    }
  }

  private _sendTCPSeg(conn: TCPConnection, flags: number, payload: number[]): void {
    var raw = buildTCP({
      srcPort: conn.localPort, dstPort: conn.remotePort,
      seq: conn.sendSeq, ack: conn.recvSeq,
      flags, window: conn.window, urgent: 0, payload,
    }, conn.localIP, conn.remoteIP);
    this._sendIPv4({
      ihl: 5, dscp: 0, ecn: 0, id: this.idCounter++,
      flags: 2, fragOff: 0, ttl: 64, protocol: PROTO_TCP,
      src: conn.localIP, dst: conn.remoteIP,
      payload: raw,
    });
    if (payload.length > 0) conn.sendSeq = (conn.sendSeq + payload.length) >>> 0;
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
      // Real hardware path: send every frame out the virtio-net NIC.
      // QEMU SLIRP will reflect broadcast/unicast replies back to us.
      kernel.netSendFrame(raw);
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
      var raw = kernel.netRecvFrame();
      if (!raw) break;
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
        // When NIC is active, block-wait for ARP reply (short timeout = 30 ticks ≈ 300 ms)
        dstMac = this.arpWait(nextHop, this.nicReady ? 100 : 0) || 'ff:ff:ff:ff:ff:ff';
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
    };
    this.sockets.set(s.id, s);
    return s;
  }

  bind(sock: Socket, port: number, ip?: IPv4Address): boolean {
    sock.localPort = port;
    if (ip) sock.localIP = ip;
    sock.state = 'bound';
    return true;
  }

  listen(sock: Socket): boolean {
    if (sock.state !== 'bound') return false;
    sock.state = 'listening';
    this.listeners.set(sock.localPort, sock);
    return true;
  }

  connect(sock: Socket, remoteIP: IPv4Address, remotePort: number): boolean {
    sock.remoteIP   = remoteIP;
    sock.remotePort = remotePort;
    if (!sock.localPort) sock.localPort = this.nextEph++;
    if (sock.type === 'tcp') {
      var iss = this._randSeq();
      var conn: TCPConnection = {
        id: this.nextConn++, state: 'SYN_SENT',
        localIP: sock.localIP, localPort: sock.localPort,
        remoteIP, remotePort,
        sendSeq: iss, recvSeq: 0,
        sendBuf: [], recvBuf: [], window: 65535,
      };
      this.connections.set(conn.id, conn);
      this._sendTCPSeg(conn, TCP_SYN, []);
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

  send(sock: Socket, data: string): boolean {
    var bytes = strToBytes(data);
    if (sock.type === 'tcp') {
      var conn = this._connForSock(sock);
      if (!conn || conn.state !== 'ESTABLISHED') return false;
      this._sendTCPSeg(conn, TCP_PSH | TCP_ACK, bytes);
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

  getStats() { return Object.assign({}, this.stats); }

  getConnections(): TCPConnection[] {
    return Array.from(this.connections.values());
  }

  getSockets(): Socket[] {
    return Array.from(this.sockets.values());
  }

  ifconfig(): string {
    var m = kernel.getMemoryInfo(); // dummy — not used, just callable
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
}

export const net = new NetworkStack();
