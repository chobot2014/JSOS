/**
 * JSOS DHCP Client (RFC 2131)
 *
 * All DHCP logic lives here in TypeScript.
 * Uses net.ts sendUDPRaw / recvUDPRaw for raw UDP datagrams.
 * The C layer sees only bare Ethernet frames.
 *
 * QEMU SLIRP assigns 10.0.2.15/24, gateway 10.0.2.2, DNS 10.0.2.3.
 */

import { net } from './net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

export interface DHCPConfig {
  ip:      string;
  mask:    string;
  gateway: string;
  dns:     string;
}

// ── DHCP constants ──────────────────────────────────────────────────────────

const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const DHCP_MAGIC = [99, 130, 83, 99];   // 0x63825363

const OPT_MSG_TYPE       = 53;
const OPT_CLIENT_ID      = 61;
const OPT_PARAM_REQ      = 55;
const OPT_REQUESTED_IP   = 50;
const OPT_SERVER_ID      = 54;
const OPT_SUBNET_MASK    = 1;
const OPT_ROUTER         = 3;
const OPT_DNS_SERVER     = 6;
const OPT_LEASE_TIME     = 51;
const OPT_END            = 255;

const DHCP_DISCOVER = 1;
const DHCP_OFFER    = 2;
const DHCP_REQUEST  = 3;
const DHCP_ACK      = 5;

// ── Helpers ─────────────────────────────────────────────────────────────────

function u32(b: number[], i: number): number {
  return ((b[i] & 0xff) * 0x1000000) |
         ((b[i+1] & 0xff) << 16)     |
         ((b[i+2] & 0xff) << 8)      |
          (b[i+3] & 0xff);
}

function macToBytes(mac: string): number[] {
  return mac.split(':').map(function(h) { return parseInt(h, 16); });
}

function bytesToIp(b: number[], off: number): string {
  return (b[off] & 0xff) + '.' + (b[off+1] & 0xff) + '.' +
         (b[off+2] & 0xff) + '.' + (b[off+3] & 0xff);
}

function ipToBytes(ip: string): number[] {
  return ip.split('.').map(Number);
}

// ── DHCP packet builder ─────────────────────────────────────────────────────

function buildDHCP(
    xid: number, msgType: number,
    mac: number[], requestedIP: string | null, serverID: string | null): number[] {
  var pkt: number[] = new Array(236).fill(0);
  pkt[0] = 1;  // BOOTREQUEST
  pkt[1] = 1;  // htype Ethernet
  pkt[2] = 6;  // hlen
  pkt[3] = 0;  // hops
  // xid (big-endian)
  pkt[4] = (xid >>> 24) & 0xff;
  pkt[5] = (xid >>> 16) & 0xff;
  pkt[6] = (xid >>>  8) & 0xff;
  pkt[7] =  xid         & 0xff;
  // flags: broadcast
  pkt[10] = 0x80;
  // chaddr (MAC)
  for (var i = 0; i < 6; i++) pkt[28 + i] = mac[i];

  // Options
  var opts: number[] = DHCP_MAGIC.slice();

  // DHCP Message Type
  opts.push(OPT_MSG_TYPE, 1, msgType);

  // Client Identifier
  opts.push(OPT_CLIENT_ID, 7, 1);
  for (var i = 0; i < 6; i++) opts.push(mac[i]);

  if (requestedIP) {
    opts.push(OPT_REQUESTED_IP, 4);
    var ripb = ipToBytes(requestedIP);
    for (var i = 0; i < 4; i++) opts.push(ripb[i]);
  }

  if (serverID) {
    opts.push(OPT_SERVER_ID, 4);
    var sidb = ipToBytes(serverID);
    for (var i = 0; i < 4; i++) opts.push(sidb[i]);
  }

  // Parameter Request List
  opts.push(OPT_PARAM_REQ, 3, OPT_SUBNET_MASK, OPT_ROUTER, OPT_DNS_SERVER);

  opts.push(OPT_END);
  // Pad to 300 bytes minimum
  while (opts.length < 64) opts.push(0);

  return pkt.concat(opts);
}

// ── DHCP response parser ────────────────────────────────────────────────────

interface DHCPResponse {
  msgType: number;
  yiaddr:  string;
  siaddr:  string;
  serverID: string;
  mask:    string;
  gateway: string;
  dns:     string;
}

function parseDHCP(data: number[]): DHCPResponse | null {
  if (data.length < 240) return null;
  if (data[0] !== 2) return null;  // BOOTREPLY
  // Verify magic cookie
  if (data[236] !== 99 || data[237] !== 130 ||
      data[238] !== 83 || data[239] !== 99) return null;

  var yiaddr   = bytesToIp(data, 16);
  var siaddr   = bytesToIp(data, 20);
  var msgType  = 0;
  var mask     = '255.255.255.0';
  var gateway  = '';
  var dns      = '';
  var serverID = '';

  // Parse options
  var off = 240;
  while (off < data.length) {
    var optCode = data[off++];
    if (optCode === OPT_END) break;
    if (optCode === 0) continue;  // pad
    if (off >= data.length) break;
    var optLen = data[off++];
    if (off + optLen > data.length) break;
    switch (optCode) {
      case OPT_MSG_TYPE:   msgType  = data[off]; break;
      case OPT_SUBNET_MASK: mask    = bytesToIp(data, off); break;
      case OPT_ROUTER:     gateway  = bytesToIp(data, off); break;
      case OPT_DNS_SERVER: dns      = bytesToIp(data, off); break;
      case OPT_SERVER_ID:  serverID = bytesToIp(data, off); break;
    }
    off += optLen;
  }
  return { msgType, yiaddr, siaddr, serverID, mask, gateway, dns };
}

// ── Public DHCP client ─────────────────────────────────────────────────────

/**
 * Perform a full DHCP Discover → Offer → Request → ACK exchange.
 * Updates the net stack configuration on success.
 * Returns the obtained config or null on failure.
 */
export function dhcpDiscover(): DHCPConfig | null {
  var mac = macToBytes(net.mac);
  var xid = (kernel.getTicks() * 0x9e3779b9) >>> 0;

  // Pre-register the UDP inbox so we don't miss the server's broadcast response.
  net.openUDPInbox(DHCP_CLIENT_PORT);

  // Send DHCP Discover
  var discover = buildDHCP(xid, DHCP_DISCOVER, mac, null, null);
  net.sendUDPRaw(DHCP_CLIENT_PORT, '255.255.255.255', DHCP_SERVER_PORT, discover);

  // Wait for DHCP Offer
  var offerPkt = net.recvUDPRaw(DHCP_CLIENT_PORT, 500);
  if (!offerPkt) return null;
  var offer = parseDHCP(offerPkt.data);
  if (!offer || offer.msgType !== DHCP_OFFER) return null;

  // Send DHCP Request
  var request = buildDHCP(xid, DHCP_REQUEST, mac, offer.yiaddr, offer.serverID);
  net.sendUDPRaw(DHCP_CLIENT_PORT, '255.255.255.255', DHCP_SERVER_PORT, request);

  // Wait for DHCP ACK
  var ackPkt = net.recvUDPRaw(DHCP_CLIENT_PORT, 500);
  if (!ackPkt) return null;
  var ack = parseDHCP(ackPkt.data);
  if (!ack || ack.msgType !== DHCP_ACK) return null;

  var config: DHCPConfig = {
    ip:      ack.yiaddr || offer.yiaddr,
    mask:    ack.mask   || offer.mask,
    gateway: ack.gateway || offer.gateway,
    dns:     ack.dns    || offer.dns,
  };

  // Apply to network stack
  net.configure({
    ip:      config.ip,
    mask:    config.mask,
    gateway: config.gateway,
    dns:     config.dns,
  });

  return config;
}
