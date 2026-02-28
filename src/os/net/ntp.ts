/**
 * JSOS NTP Client (RFC 5905 / SNTPv4) — item 51
 *
 * All NTP logic lives here in TypeScript.
 * The C kernel provides only raw UDP packet send/receive via net.ts.
 *
 * Protocol overview:
 *   1. Open local UDP port 123 (or any ephemeral port).
 *   2. Send a 48-byte NTPv4 client request to pool.ntp.org:123
 *      (resolved via DNS first; falls back to hardcoded Google NTP IP).
 *   3. Read the 48-byte server response.
 *   4. Extract the Transmit Timestamp (bytes 40-43 = seconds since 1900-01-01).
 *   5. Subtract 70-year offset (2208988800s) to get Unix epoch.
 *   6. Call kernel.setWallClock(epochSeconds) so the kernel wall clock advances.
 *   7. Schedule a re-sync every NTP_RESYNC_INTERVAL_S seconds.
 *
 * Usage:
 *   import { ntp } from '@jsos/net/ntp.js';
 *   await ntp.sync();                      // one-shot sync
 *   ntp.startPeriodicSync(3600);           // re-sync every hour
 *   const now = ntp.now();                 // Unix seconds (corrected)
 */

import { net } from './net.js';
import { dnsResolve } from './dns.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Constants ────────────────────────────────────────────────────────────────

const NTP_PORT        = 123;
const NTP_EPOCH_DELTA = 2208988800;   // seconds from 1900-01-01 to 1970-01-01
const NTP_PACKET_SIZE = 48;
const NTP_TIMEOUT_TICKS = 3000;       // 3 s at 1000 Hz PIT

// NTPv4 client request byte layout:
//   Byte 0: LI=0 (00), VN=4 (100), Mode=3 client (011) → 0b00_100_011 = 0x23
const NTP_REQUEST_BYTE0 = 0x23;

// Fallback NTP server IPs (Google Public NTP)
const NTP_FALLBACK_SERVERS: string[] = [
  '216.239.35.0',   // time1.google.com
  '216.239.35.4',   // time2.google.com
  '216.239.35.8',   // time3.google.com
];

// Primary NTP pool hostname (resolved via DNS on each sync attempt)
const NTP_POOL_HOST = 'pool.ntp.org';

// Ephemeral source port for NTP requests
const NTP_CLIENT_PORT = 32000 + ((kernel.getTicks() & 0x0FFF) | 0x80);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a 32-bit big-endian unsigned integer from byte array at offset i. */
function u32be(b: number[], i: number): number {
  return ((b[i]     & 0xff) * 0x1000000)
       | ((b[i + 1] & 0xff) << 16)
       | ((b[i + 2] & 0xff) << 8)
       |  (b[i + 3] & 0xff);
}

/** Build a 48-byte NTPv4 client request. */
function buildNTPRequest(): number[] {
  const pkt = new Array<number>(NTP_PACKET_SIZE).fill(0);
  pkt[0] = NTP_REQUEST_BYTE0;
  // All other fields zero: stratum=0 (unspecified), poll=0, precision=0,
  // reference/originate/receive timestamps all zero.
  return pkt;
}

/**
 * Parse an NTPv4 server response.
 * Returns Unix epoch seconds, or null if the packet is invalid.
 */
function parseNTPResponse(pkt: number[]): number | null {
  if (pkt.length < NTP_PACKET_SIZE) return null;

  const mode = pkt[0] & 0x07;
  // Valid response modes: Server (4) or Broadcast (5)
  if (mode !== 4 && mode !== 5) return null;

  // Transmit Timestamp is at bytes 40-47 (seconds in [40..43], fraction in [44..47])
  const ntpSeconds = u32be(pkt, 40);
  if (ntpSeconds === 0) return null;                // server sent no time

  // Convert from NTP epoch (1900) to Unix epoch (1970)
  const unixSeconds = ntpSeconds - NTP_EPOCH_DELTA;
  if (unixSeconds <= 0) return null;               // implausible (pre-1970)

  return unixSeconds;
}

// ── NTP sync state ──────────────────────────────────────────────────────────

interface NTPState {
  synced:       boolean;
  lastSyncEpoch: number;        // Unix seconds from last successful sync
  lastSyncTick:  number;        // kernel.getTicks() at last sync
  offset:        number;        // seconds difference vs RTC
  stratum:       number;        // server stratum
  server:        string | null; // server IP used for last sync
}

const _state: NTPState = {
  synced:        false,
  lastSyncEpoch: 0,
  lastSyncTick:  0,
  offset:        0,
  stratum:       0,
  server:        null,
};

let _resyncTimer: number | null = null;

// ── Core sync logic ──────────────────────────────────────────────────────────

/**
 * Attempt to sync with a specific NTP server IP.
 * Returns the synced Unix epoch on success, or null on failure.
 */
function syncWithServer(serverIP: string): number | null {
  net.openUDPInbox(NTP_CLIENT_PORT);

  const request = buildNTPRequest();
  net.sendUDPRaw(NTP_CLIENT_PORT, serverIP, NTP_PORT, request);

  const response = net.recvUDPRaw(NTP_CLIENT_PORT, NTP_TIMEOUT_TICKS);
  if (!response) return null;

  const epoch = parseNTPResponse(response.data);
  if (epoch === null) return null;

  _state.synced        = true;
  _state.lastSyncEpoch = epoch;
  _state.lastSyncTick  = kernel.getTicks();
  _state.server        = serverIP;
  // Stratum is byte 1 of the response
  _state.stratum = response.data[1] & 0xff;

  // Compare against RTC to record offset
  const rtc = kernel.rtcRead?.();
  _state.offset = rtc ? epoch - rtc.unix : 0;

  // Update the kernel wall clock
  kernel.setWallClock?.(epoch);

  return epoch;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Perform a one-shot NTP synchronization.
 * Tries pool.ntp.org via DNS first; falls back through hardcoded servers.
 * Returns the synced Unix epoch seconds, or null if all servers failed.
 */
function sync(): number | null {
  // Attempt 1: resolve pool.ntp.org via DNS
  try {
    const resolved = dnsResolve(NTP_POOL_HOST);
    if (resolved) {
      const epoch = syncWithServer(resolved);
      if (epoch !== null) return epoch;
    }
  } catch (_) {
    // DNS failure — continue to fallbacks
  }

  // Attempt 2: try hardcoded fallback IPs in order
  for (const ip of NTP_FALLBACK_SERVERS) {
    const epoch = syncWithServer(ip);
    if (epoch !== null) return epoch;
  }

  return null;  // all attempts failed
}

/**
 * Return the current wall-clock time in Unix seconds.
 * Uses the kernel.getWallClock() value which advances via PIT ticker from
 * the last NTP sync point (or RTC if no sync has occurred).
 */
function now(): number {
  return kernel.getWallClock?.() ?? Math.floor(Date.now() / 1000);
}

/**
 * Return a human-readable ISO-8601 date/time string for the current time.
 * Example: "2026-02-25T14:30:00Z"
 */
function nowISO(): string {
  const secs = now();
  const d = new Date(secs * 1000);
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear()
    + '-' + pad(d.getUTCMonth() + 1)
    + '-' + pad(d.getUTCDate())
    + 'T' + pad(d.getUTCHours())
    + ':' + pad(d.getUTCMinutes())
    + ':' + pad(d.getUTCSeconds())
    + 'Z';
}

/**
 * Start periodic NTP re-sync.
 * @param intervalSeconds  Re-sync interval in seconds (default: 3600 = 1 hour)
 */
function startPeriodicSync(intervalSeconds: number = 3600): void {
  stopPeriodicSync();
  function doSync() {
    sync();
    _resyncTimer = setTimeout(doSync, intervalSeconds * 1000);
  }
  doSync();
}

/** Stop periodic NTP re-sync. */
function stopPeriodicSync(): void {
  if (_resyncTimer !== null) {
    clearTimeout(_resyncTimer);
    _resyncTimer = null;
  }
}

/** Return the current NTP sync state (for diagnostics). */
function getState(): Readonly<NTPState> {
  return _state;
}

// ── Export ───────────────────────────────────────────────────────────────────

export const ntp = {
  sync,
  now,
  nowISO,
  startPeriodicSync,
  stopPeriodicSync,
  getState,
};
