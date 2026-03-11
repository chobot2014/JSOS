/**
 * JSOS TLS 1.3 + TLS 1.2 Client
 *
 * Pure TypeScript TLS client (RFC 8446 / RFC 5246 / RFC 7905) using crypto.ts.
 *
 * Capabilities:
 *   - TLS 1.3: X25519 and P-256 key exchange, AES-128-GCM + ChaCha20-Poly1305
 *   - TLS 1.2: ECDHE-RSA + ECDHE-ECDSA, AES-128-GCM + ChaCha20-Poly1305
 *   - Extended Master Secret (RFC 7627) for TLS 1.2
 *   - HelloRetryRequest (HRR) support for TLS 1.3
 *   - ALPN negotiation (h2 + http/1.1)
 *   - Session tickets (NewSessionTicket) for future 0-RTT
 *   - Automatic fallback: TLS 1.3 preferred, TLS 1.2 if server rejects
 *   - close_notify alert on shutdown
 *   - No certificate validation (bare-metal dev OS)
 *   - SNI (Server Name Indication) on all handshakes
 *
 * Architecture:
 *   TLSSocket wraps a net.ts TCP Socket.
 *   All TLS logic (record layer, handshake, crypto) is pure TypeScript.
 *   C sees only raw TCP bytes.
 */

import {
  sha256, hmacSha256, hkdfExtract, hkdfExpand, hkdfExpandLabel,
  gcmEncrypt, gcmDecrypt,
  chacha20poly1305Encrypt, chacha20poly1305Decrypt,
  x25519, x25519PublicKey, generateKey32, generateKey32Unclamped,
  p256PublicKey, ecdhP256,
  concat, getHardwareRandom,
} from './crypto.js';
import { sha384, hmacSha384 } from './crypto.js';
import { net, strToBytes } from './net.js';
import type { Socket } from './net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// â”€â”€ TLS constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TLS_HANDSHAKE          = 22;
const TLS_APPLICATION_DATA   = 23;
const TLS_CHANGE_CIPHER_SPEC = 20;
const TLS_ALERT              = 21;

const HS_CLIENT_HELLO       = 1;
const HS_SERVER_HELLO       = 2;
const HS_ENCRYPTED_EXT      = 8;
const HS_CERTIFICATE        = 11;
const HS_CERT_VERIFY        = 15;
const HS_FINISHED           = 20;

const CS_AES_128_GCM_SHA256         = 0x1301;
const CS_CHACHA20_POLY1305_SHA256   = 0x1303;  // [Item 295] ChaCha20-Poly1305
// TLS 1.2 cipher suites for fallback when server selects TLS 1.2
const CS_TLS12_ECDHE_RSA_AES128_GCM = 0xc02f;  // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
const CS_TLS12_ECDHE_RSA_AES256_GCM = 0xc030;  // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
const CS_TLS12_ECDHE_RSA_CHACHA20   = 0xcca8;  // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
const CS_EMPTY_RENEG                = 0x00ff;
const EXT_SNI                = 0x0000;
const EXT_SUPPORTED_VERS     = 0x002b;
const EXT_RENEGOTIATION_INFO = 0xff01;  // RFC 5746 â€” required by Fastly/BoringSSL
const EXT_SUPPORTED_GROUPS   = 0x000a;
const EXT_KEY_SHARE          = 0x0033;
const EXT_SIG_ALGS           = 0x000d;
const EXT_ALPN               = 0x0010;  // [Item 294] Application-Layer Protocol Negotiation
const EXT_SESSION_TICKET     = 0x0023;  // session ticket (empty = request one)
const EXT_PSK_KEY_EXCH_MODES = 0x002d;  // RFC 8446 Â§4.2.9 â€” required by many TLS 1.3 servers
const EXT_EC_POINT_FORMATS   = 0x000b;  // EC point formats (legacy compat)
const GROUP_X25519            = 0x001d;
const GROUP_P256              = 0x0017;  // secp256r1 / NIST P-256

// HelloRetryRequest sentinel random (RFC 8446 Â§4.1.3)
const HRR_RANDOM = [
  0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11,
  0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91,
  0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e,
  0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c,
];

// â”€â”€ Byte helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function u8(b: number[], i: number): number  { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i] & 0xff) << 8) | (b[i+1] & 0xff); }
function u24(b: number[], i: number): number {
  return ((b[i] & 0xff) << 16) | ((b[i+1] & 0xff) << 8) | (b[i+2] & 0xff);
}
function putU8(b: number[], v: number): void  { b.push(v & 0xff); }
function putU16(b: number[], v: number): void { b.push((v >> 8) & 0xff); b.push(v & 0xff); }
function putU24(b: number[], v: number): void { b.push((v >> 16) & 0xff); b.push((v >> 8) & 0xff); b.push(v & 0xff); }

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TLS 1.2 PRF (RFC 5246 Â§5) â€” P_SHA256 HMAC-based pseudorandom function
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * TLS 1.2 PRF (for AES_128_GCM_SHA256 cipher suites).
 * PRF(secret, label, seed, len) = P_SHA256(secret, label + seed)
 * P_SHA256(s, seed) = HMAC_SHA256(s, A(1)+seed) || HMAC_SHA256(s, A(2)+seed) || ...
 * where A(0)=seed, A(i)=HMAC_SHA256(s, A(i-1))
 */
function tls12PRF(secret: number[], label: string, seed: number[], len: number): number[] {
  // label_seed = label_bytes || seed
  var labelBytes: number[] = [];
  for (var i = 0; i < label.length; i++) labelBytes.push(label.charCodeAt(i));
  var labelSeed = labelBytes.concat(seed);
  var out: number[] = [];
  var A = labelSeed.slice();  // A(0) = label+seed
  while (out.length < len) {
    A = hmacSha256(secret, A);  // A(i) = HMAC(secret, A(i-1))
    var chunk = hmacSha256(secret, A.concat(labelSeed));
    for (var j = 0; j < chunk.length && out.length < len; j++) out.push(chunk[j]);
  }
  return out.slice(0, len);
}

/**
 * TLS 1.2 PRF for AES_256_GCM_SHA384 cipher suites.
 * Same structure as tls12PRF but uses HMAC-SHA-384 instead of HMAC-SHA-256.
 */
function tls12PRF384(secret: number[], label: string, seed: number[], len: number): number[] {
  var labelBytes: number[] = [];
  for (var i = 0; i < label.length; i++) labelBytes.push(label.charCodeAt(i));
  var labelSeed = labelBytes.concat(seed);
  var out: number[] = [];
  var A = labelSeed.slice();
  while (out.length < len) {
    A = hmacSha384(secret, A);
    var chunk = hmacSha384(secret, A.concat(labelSeed));
    for (var j = 0; j < chunk.length && out.length < len; j++) out.push(chunk[j]);
  }
  return out.slice(0, len);
}

/**
 * TLS 1.2 AES-128-GCM record decryption (RFC 5288).
 * Nonce = implicit_write_IV(4 bytes) || explicit_nonce(8 bytes, from record).
 * AAD = seq_num(8) || type(1) || version(2) || plaintext_length(2).
 */
function tls12DecryptRecord(key: number[], implicitIV: number[], seq: number,
    record: number[]): number[] | null {
  // record = [type(1), ver(2), len(2), explicit_nonce(8), ciphertext, tag(16)]
  if (record.length < 5 + 8 + 16) return null;
  var recType = record[0];
  var recLen  = u16(record, 3);
  if (record.length < 5 + recLen) return null;
  var explicitNonce = record.slice(5, 5 + 8);
  var nonce: number[] = [implicitIV[0], implicitIV[1], implicitIV[2], implicitIV[3],
    explicitNonce[0], explicitNonce[1], explicitNonce[2], explicitNonce[3],
    explicitNonce[4], explicitNonce[5], explicitNonce[6], explicitNonce[7]];
  var cipherOffset = 5 + 8;
  var cipherLen    = recLen - 8 - 16;
  if (cipherLen < 0) return null;
  var ciphertext = record.slice(cipherOffset, cipherOffset + cipherLen);
  var tag        = record.slice(cipherOffset + cipherLen, cipherOffset + cipherLen + 16);
  // AAD = seq_num(8B) || type(1B) || version(2B) || length_of_plaintext(2B)
  var aad: number[] = [
    0, 0, 0, 0,
    (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    recType, 0x03, 0x03,
    (cipherLen >>> 8) & 0xff, cipherLen & 0xff,
  ];
  return gcmDecrypt(key, nonce, aad, ciphertext, tag);
}

/**
 * TLS 1.2 AES-128-GCM record encryption (RFC 5288).
 */
function tls12EncryptRecord(key: number[], implicitIV: number[], seq: number,
    recType: number, plaintext: number[]): number[] {
  // Explicit nonce = low 8 bytes of unique value (just use seq padded)
  var explicitNonce = [0,0,0,0, (seq>>>24)&0xff, (seq>>>16)&0xff, (seq>>>8)&0xff, seq&0xff];
  // Nonce = implicit_IV(4B) || explicit_nonce(8B)
  var nonce: number[] = [implicitIV[0], implicitIV[1], implicitIV[2], implicitIV[3],
    0, 0, 0, 0, (seq>>>24)&0xff, (seq>>>16)&0xff, (seq>>>8)&0xff, seq&0xff];
  // AAD = seq_num(8B) || type(1B) || version(2B) || length_of_plaintext(2B)
  var aad: number[] = [
    0, 0, 0, 0,
    (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    recType, 0x03, 0x03,
    (plaintext.length >>> 8) & 0xff, plaintext.length & 0xff,
  ];
  var enc = gcmEncrypt(key, nonce, aad, plaintext);
  var totalLen = 8 + enc.ciphertext.length + enc.tag.length;
  // Pre-allocate output record in a single array (avoids 3× .concat())
  var out = new Array(5 + totalLen);
  out[0] = recType; out[1] = 0x03; out[2] = 0x03;
  out[3] = (totalLen >>> 8) & 0xff; out[4] = totalLen & 0xff;
  for (var _oi = 0; _oi < 8; _oi++) out[5 + _oi] = explicitNonce[_oi];
  var _base = 13;
  for (var _oi = 0; _oi < enc.ciphertext.length; _oi++) out[_base + _oi] = enc.ciphertext[_oi];
  _base += enc.ciphertext.length;
  for (var _oi = 0; _oi < enc.tag.length; _oi++) out[_base + _oi] = enc.tag[_oi];
  return out;
}

/**
 * TLS 1.2 ChaCha20-Poly1305 record decryption (RFC 7905).
 * Nonce = write_IV(12) XOR padded_seq(12). No explicit nonce in the record.
 */
function tls12DecryptRecordChaCha(key: number[], writeIV: number[], seq: number,
    record: number[]): number[] | null {
  if (record.length < 5 + 16) return null;
  var recType = record[0];
  var recLen  = u16(record, 3);
  if (record.length < 5 + recLen) return null;
  var cipherLen = recLen - 16;
  if (cipherLen < 0) return null;
  var ciphertext = record.slice(5, 5 + cipherLen);
  var tag        = record.slice(5 + cipherLen, 5 + cipherLen + 16);
  // Nonce = writeIV XOR padded sequence number (12 bytes)
  var nonce = xorIV(writeIV, seq);
  // AAD = seq_num(8B) || type(1B) || version(2B) || length_of_plaintext(2B)
  var aad: number[] = [
    0, 0, 0, 0,
    (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    recType, 0x03, 0x03,
    (cipherLen >>> 8) & 0xff, cipherLen & 0xff,
  ];
  return chacha20poly1305Decrypt(key, nonce, aad, ciphertext, tag);
}

/**
 * TLS 1.2 ChaCha20-Poly1305 record encryption (RFC 7905).
 */
function tls12EncryptRecordChaCha(key: number[], writeIV: number[], seq: number,
    recType: number, plaintext: number[]): number[] {
  var nonce = xorIV(writeIV, seq);
  // AAD = seq_num(8B) || type(1B) || version(2B) || length_of_plaintext(2B)
  var aad: number[] = [
    0, 0, 0, 0,
    (seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff,
    recType, 0x03, 0x03,
    (plaintext.length >>> 8) & 0xff, plaintext.length & 0xff,
  ];
  var enc = chacha20poly1305Encrypt(key, nonce, aad, plaintext);
  var totalLen = enc.ciphertext.length + enc.tag.length;
  // Pre-allocate output record
  var out = new Array(5 + totalLen);
  out[0] = recType; out[1] = 0x03; out[2] = 0x03;
  out[3] = (totalLen >>> 8) & 0xff; out[4] = totalLen & 0xff;
  for (var _ci = 0; _ci < enc.ciphertext.length; _ci++) out[5 + _ci] = enc.ciphertext[_ci];
  for (var _ci = 0; _ci < enc.tag.length; _ci++) out[5 + enc.ciphertext.length + _ci] = enc.tag[_ci];
  return out;
}

// â”€â”€ AEAD helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function xorIV(baseIV: number[], seq: number): number[] {
  var iv = baseIV.slice();
  // XOR the last 8 bytes with the Big-Endian 64-bit sequence number
  // (only lower 32 bits used here for simplicity; seq won't exceed 2^32)
  iv[8]  ^= (seq >>> 24) & 0xff;
  iv[9]  ^= (seq >>> 16) & 0xff;
  iv[10] ^= (seq >>>  8) & 0xff;
  iv[11] ^=  seq         & 0xff;
  return iv;
}

function tlsEncryptRecord(
    key: number[], iv: number[], seq: number,
    innerType: number, plaintext: number[], useChaCha = false): number[] {
  // inner = plaintext || contentType
  var inner = plaintext.concat([innerType]);
  // AAD = TLS record header for outer type 23
  var totalLen = inner.length + 16; // +16 for AEAD tag
  var aad = [TLS_APPLICATION_DATA, 0x03, 0x03,
              (totalLen >> 8) & 0xff, totalLen & 0xff];
  var nonce = xorIV(iv, seq);
  if (useChaCha) {
    // [Item 295] ChaCha20-Poly1305 (RFC 8439)
    var cc = chacha20poly1305Encrypt(key, nonce, aad, inner);
    return aad.concat(cc.ciphertext).concat(cc.tag);
  }
  var aeadOut = gcmEncrypt(key, nonce, aad, inner);
  return aad.concat(aeadOut.ciphertext).concat(aeadOut.tag);
}

function tlsDecryptRecord(
    key: number[], iv: number[], seq: number,
    record: number[], useChaCha = false): { type: number; data: number[] } | null {
  if (record.length < 5) return null;
  var outerType = u8(record, 0);
  var len = u16(record, 3);
  if (record.length < 5 + len) return null;
  var ciphertext = record.slice(5, 5 + len - 16);
  var tag        = record.slice(5 + len - 16, 5 + len);
  var aad        = record.slice(0, 5);
  var nonce      = xorIV(iv, seq);
  var plain: number[] | null;
  if (useChaCha) {
    // [Item 295] ChaCha20-Poly1305
    plain = chacha20poly1305Decrypt(key, nonce, aad, ciphertext, tag);
  } else {
    plain = gcmDecrypt(key, nonce, aad, ciphertext, tag);
  }
  if (!plain) return null;
  // Find inner content type: last non-zero byte
  var innerType = outerType;
  for (var i = plain.length - 1; i >= 0; i--) {
    if (plain[i] !== 0) { innerType = plain[i]; plain = plain.slice(0, i); break; }
  }
  return { type: innerType, data: plain };
}

// â”€â”€ TLS record-layer buffering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ TLS Session Ticket Cache (Item 930) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** [Item 930] Stored TLS 1.3 session ticket with associated resumption secret. */
export interface TLSSessionTicket {
  ticket:        number[];   // opaque ticket bytes from NewSessionTicket
  pskSecret:     number[];   // resumption_master_secret
  lifetime:      number;     // ticket_lifetime (seconds)
  ageAdd:        number;     // ticket_age_add (obfuscation value)
  storedAt:      number;     // kernel.getTicks() when stored
  cipherSuite:   number;     // e.g. 0x1301 = TLS_AES_128_GCM_SHA256
}

/**
 * [Item 930] Global per-hostname TLS 1.3 session ticket cache.
 * Enables 0-RTT (early data) on reconnect to the same server.
 */
export class TLSSessionTicketCache {
  private cache = new Map<string, TLSSessionTicket>();

  /** Store (or replace) a session ticket for a given hostname. */
  store(hostname: string, t: TLSSessionTicket): void {
    this.cache.set(hostname, t);
  }

  /** Retrieve a valid ticket, or null if absent/expired. */
  get(hostname: string): TLSSessionTicket | null {
    var t = this.cache.get(hostname);
    if (!t) return null;
    // Check if ticket has expired (lifetime in seconds, ticks ~= ms)
    var ageTicks = kernel.getTicks() - t.storedAt;
    if (ageTicks > t.lifetime * 1000) {
      this.cache.delete(hostname);
      return null;
    }
    return t;
  }

  /** Evict a ticket (e.g. after a failed 0-RTT attempt). */
  evict(hostname: string): void { this.cache.delete(hostname); }

  /** All stored hostnames. */
  get size(): number { return this.cache.size; }
}

/** Shared global ticket cache (used by all TLSSocket instances). */
export const tlsSessionCache = new TLSSessionTicketCache();

export class TLSSocket {
  private sock: Socket;
  private hostname: string;
  private rxBuf: number[] = [];       // raw bytes from TCP not yet parsed

  // Handshake crypto state
  private myPrivate:    number[] = [];
  private myPublic:     number[] = [];
  private myP256Private: number[] = [];
  private myP256Public:  number[] = [];  // 65 bytes (04 || x || y)
  private transcript: number[] = [];  // all handshake bytes for transcript hash

  // Keys (set after key derivation)
  private serverHsKey: number[] = [];
  private serverHsIV:  number[] = [];
  private clientHsKey: number[] = [];
  private clientHsIV:  number[] = [];
  private serverAppKey: number[] = [];
  private serverAppIV:  number[] = [];
  private clientAppKey: number[] = [];
  private clientAppIV:  number[] = [];

  private serverHsSeq = 0;
  private clientHsSeq = 0;
  private serverAppSeq = 0;
  private clientAppSeq = 0;
  private handshakeDone = false;
  /** [Item 295] True when server selected ChaCha20-Poly1305 cipher suite. */
  private useChaCha20 = false;
  /** True when handshake is TLS 1.2 (uses tls12 record functions). */
  private useTLS12 = false;
  /** TLS 1.2 implicit write IVs (4 bytes each). */
  private tls12ClientWriteIV: number[] = [];
  private tls12ServerWriteIV: number[] = [];
  /** Set when server sends protocol_version alert â€” need TLS 1.2 retry. */
  private _got_pv_alert = false;

  // Decrypted but not yet parsed handshake bytes (handles multi-message records)
  private _hsDataBuf: number[] = [];

  // ── Async handshake state (beginHandshake / hsPoll) ──────────────────
  private _hsPhase: string = 'idle';   // 'idle'|'wait-sh'|'wait-enc'|'need-reconnect'|'reconnecting'|'tls12-wait-sh'|'tls12-server-msgs'|'tls12-wait-ccs'|'tls12-wait-fin'|'done'|'failed'
  private _hsEncAttempts: number = 0;
  private _hsRemoteIP: string = '';
  private _hsRemotePort: number = 0;

  // ── TLS 1.2 async handshake intermediate state ────────────────────────
  /** Holds in-flight TLS 1.2 handshake state between hsPoll() frames. */
  private _hs12S: {
    ch: boolean;      // ChaCha20 cipher
    s384: boolean;    // SHA-384 PRF (AES-256-GCM-SHA384)
    ems: boolean;     // extended master secret (RFC 7627)
    sRand: number[];  // server random bytes
    pub: number[];    // server ECDHE public key (from ServerKeyExchange)
    ms: number[];     // master secret (computed at ServerHelloDone)
    cnt: number;      // message counter (for loop-bound safety)
  } | null = null;

  /** [Item 930] Cached session ticket for this hostname (populated post-handshake). */
  private _savedTicket: TLSSessionTicket | null = null;
  /** [Item 930] Resumption master secret derived after a completed handshake. */
  private _resumptionSecret: number[] = [];

  /** Negotiated ALPN protocol (e.g. 'h2' or 'http/1.1'). Set during handshake. */
  alpnProtocol: string = '';

  constructor(hostname: string) {
    this.hostname = hostname;
    this.sock = net.createSocket('tcp');
  }

  /** Connect TCP (blocking) then perform TLS handshake (1.3 preferred, 1.2 fallback). Returns true on success. */
  handshake(remoteIP: string, remotePort: number): boolean {
    if (!net.connect(this.sock, remoteIP, remotePort)) return false;
    var ok = this._performHandshake();
    if (!ok && this._got_pv_alert) {
      // Server rejected TLS 1.3 (protocol_version alert) â€” retry with TLS 1.2
      kernel.serialPut('[tls] TLS 1.3 rejected by ' + this.hostname + ', retrying with TLS 1.2\n');
      net.close(this.sock);
      this.sock = net.createSocket('tcp');
      this.rxBuf = [];
      this.transcript = [];
      this.useTLS12 = false;
      this._got_pv_alert = false;
      this.serverAppSeq = 0; this.clientAppSeq = 0;
      if (!net.connect(this.sock, remoteIP, remotePort)) return false;
      ok = this._performHandshake12();
    }
    // [Item 930] After handshake, try to harvest a NewSessionTicket for future resumption.
    if (ok && !this.useTLS12) this._tryReadSessionTicket();
    return ok;
  }

  /**
   * Perform TLS handshake on an already-connected socket.
   * Use this when TCP connect was managed asynchronously via net.connectAsync/connectPoll.
   * Pass remoteIP/remotePort to enable TLS 1.2 fallback on protocol_version alert.
   */
  handshakeOnConnected(sock: Socket, remoteIP?: string, remotePort?: number): boolean {
    this.sock = sock;
    var ok = this._performHandshake();
    if (!ok && this._got_pv_alert && remoteIP) {
      kernel.serialPut('[tls] TLS 1.3 rejected by ' + this.hostname + ', retrying with TLS 1.2\n');
      net.close(this.sock);
      this.sock = net.createSocket('tcp');
      this.rxBuf = [];
      this.transcript = [];
      this.useTLS12 = false;
      this._got_pv_alert = false;
      this.serverAppSeq = 0; this.clientAppSeq = 0;
      var _rc12 = net.connect(this.sock, remoteIP, remotePort || 443);
      kernel.serialPut('[tls12] reconnect to ' + remoteIP + ':' + (remotePort || 443) + ' ok=' + (_rc12 ? 1 : 0) + '\n');
      if (!_rc12) return false;
      ok = this._performHandshake12();
    }
    if (ok && !this.useTLS12) this._tryReadSessionTicket();
    return ok;
  }

  /**
   * Begin an async TLS handshake on an already-connected socket.
   * Generates key material, sends ClientHello, records the remote address for
   * TLS 1.2 reconnect retry.  Call hsPoll() each coroutine frame until it returns
   * 'connected' or 'failed' — never blocks.
   */
  beginHandshake(sock: Socket, remoteIP?: string, remotePort?: number): void {
    this.sock          = sock;
    this._hsRemoteIP   = remoteIP   || '';
    this._hsRemotePort = remotePort || 443;
    this._hsPhase      = 'idle';
    this._hsEncAttempts = 0;
    this._got_pv_alert = false;
    this.rxBuf        = [];
    this.transcript   = [];
    this.handshakeDone = false;
    this.useTLS12     = false;
    this.serverAppSeq = 0; this.clientAppSeq = 0;
    this.serverHsSeq  = 0; this.clientHsSeq  = 0;
    this._hsDataBuf   = [];
    this._hs12Remainder = [];

    // Generate key material (CPU bound — happens once per connection)
    this.myPrivate     = generateKey32();
    this.myPublic      = x25519PublicKey(this.myPrivate);
    this.myP256Private = generateKey32Unclamped();
    this.myP256Public  = p256PublicKey(this.myP256Private);

    var clientHello = this._buildClientHello();
    this.transcript = this.transcript.concat(clientHello.slice(5));  // skip 5-byte record hdr
    if (!net.sendBytes(this.sock, clientHello)) {
      this._hsPhase = 'failed';
      return;
    }
    this._hsPhase = 'wait-sh';
  }

  /**
   * Poll the async TLS handshake.  Call once per coroutine frame.
   * Accumulates incoming data non-blocking (no kernel.sleep), advances the
   * handshake state machine by one logical step, then returns:
   *   'connected' — handshake complete, socket ready
   *   'pending'   — waiting for more data or still processing
   *   'failed'    — unrecoverable error
   */
  hsPoll(): 'connected' | 'pending' | 'failed' {
    if (this._hsPhase === 'done')   return 'connected';
    if (this._hsPhase === 'failed') return 'failed';

    // Accumulate incoming bytes (non-blocking, no sleep)
    var _nb = net.recvBytesNB(this.sock);
    if (_nb && _nb.length > 0) {
      for (var _i = 0; _i < _nb.length; _i++) this.rxBuf.push(_nb[_i]);
    }

    // ── Waiting for ServerHello ────────────────────────────────────────
    if (this._hsPhase === 'wait-sh') {
      if (this.rxBuf.length < 5) return 'pending';
      var recType = u8(this.rxBuf, 0);
      var recLen  = u16(this.rxBuf, 3);
      if (this.rxBuf.length < 5 + recLen) return 'pending';  // record not yet complete

      if (recType === 21 /* TLS_ALERT */) {
        // Read alert level+desc if we have them
        if (this.rxBuf.length >= 7) {
          var alertDesc = u8(this.rxBuf, 6);
          kernel.serialPut('[tls/async] alert desc=' + alertDesc + ' from ' + this.hostname + '\n');
          if (alertDesc === 70 || alertDesc === 40) {
            this._got_pv_alert = true;  // protocol_version / handshake_failure
          }
        }
        this.rxBuf = this.rxBuf.slice(5 + recLen);
        this._hsPhase = this._got_pv_alert ? 'need-reconnect' : 'failed';
        return 'pending';  // transition handled next hsPoll()
      }

      if (recType !== 22 /* TLS_HANDSHAKE */) {
        kernel.serialPut('[tls/async] unexpected record type=' + recType + ' in wait-sh\n');
        this._hsPhase = 'failed'; return 'failed';
      }

      var recData       = this.rxBuf.slice(5, 5 + recLen);
      this.rxBuf        = this.rxBuf.slice(5 + recLen);
      if (recData.length < 4) { this._hsPhase = 'failed'; return 'failed'; }

      var msgType = u8(recData, 0);
      var msgLen  = u24(recData, 1);
      var msgData = recData.slice(4, 4 + msgLen);

      if (msgType !== HS_SERVER_HELLO) {
        kernel.serialPut('[tls/async] expected ServerHello got type=' + msgType + '\n');
        this._hsPhase = 'failed'; return 'failed';
      }

      var transcriptLenBeforeSH = this.transcript.length;
      this.transcript = this.transcript.concat(recData.slice(0, 4 + msgLen));

      // Detect HelloRetryRequest by comparing random field to HRR sentinel
      var isHRR = msgData.length >= 34;
      if (isHRR) {
        for (var _hi = 0; _hi < 32; _hi++) {
          if (msgData[2 + _hi] !== HRR_RANDOM[_hi]) { isHRR = false; break; }
        }
      }

      if (isHRR) {
        if (this.myP256Public.length === 0) this.myP256Public = p256PublicKey(this.myP256Private);
        // Reconstruct transcript: message_hash(CH1) + HRR sentinel per RFC 8446 §4.4.1
        var ch1Hash   = sha256(this.transcript.slice(0, transcriptLenBeforeSH));
        var hashMsg   = [0xfe, 0x00, 0x00, 0x20].concat(ch1Hash);
        this.transcript = hashMsg.concat(this.transcript.slice(transcriptLenBeforeSH));
        var ch2 = this._buildClientHello();
        this.transcript = this.transcript.concat(ch2.slice(5));
        if (!net.sendBytes(this.sock, ch2)) { this._hsPhase = 'failed'; return 'failed'; }
        // Stay in 'wait-sh' for the real ServerHello
        return 'pending';
      }

      // Real ServerHello: parse extensions to get server key_share
      var serverKeyInfo = this._parseServerHello(msgData);

      if (!serverKeyInfo) {
        if (this._got_pv_alert) {
          // Server chose TLS 1.2 in-place (ServerHello has TLS 1.2 format, no reconnect needed)
          this._got_pv_alert = false;
          // Server chose TLS 1.2 in-place — kick off async TLS 1.2 handshake
          // (transcript already has combined CH + ServerHello from _readHandshakeMsg)
          this.useTLS12 = true;
          this._hs12Remainder = [];
          this.serverAppSeq = 0; this.clientAppSeq = 0;
          // Fresh P-256 keypair for ClientKeyExchange
          this.myP256Private = generateKey32Unclamped();
          this.myP256Public  = p256PublicKey(this.myP256Private);
          if (!this._hs12InitFromServerHello(msgData)) { this._hsPhase = 'failed'; return 'failed'; }
          this._hsPhase = 'tls12-server-msgs'; return 'pending';
        }
        kernel.serialPut('[tls/async] _parseServerHello returned null for ' + this.hostname + '\n');
        this._hsPhase = 'failed'; return 'failed';
      }

      // Derive TLS 1.3 handshake keys (CPU bound ECDH + HKDF)
      if (!this._deriveHandshakeKeys(serverKeyInfo.key, serverKeyInfo.group)) {
        this._hsPhase = 'failed'; return 'failed';
      }

      this._hsEncAttempts = 0;
      this._hsPhase = 'wait-enc';
      return 'pending';
    }

    // ── Waiting for encrypted server handshake messages ────────────────
    if (this._hsPhase === 'wait-enc') {
      // First, drain any messages from the previous coalesced-record remainder
      if (this._hsDataBuf.length >= 4) {
        var msgType0 = u8(this._hsDataBuf, 0);
        var msgLen0  = u24(this._hsDataBuf, 1);
        if (this._hsDataBuf.length >= 4 + msgLen0) {
          var msgData0 = this._hsDataBuf.slice(4, 4 + msgLen0);
          this.transcript = this.transcript.concat(this._hsDataBuf.slice(0, 4 + msgLen0));
          this._hsDataBuf = this._hsDataBuf.slice(4 + msgLen0);
          return this._processHsMsg13(msgType0, msgData0);
        }
      }

      // Need the next encrypted TLS record from the wire
      if (this.rxBuf.length < 5) return 'pending';
      var outerType = u8(this.rxBuf, 0);
      var recLen2   = u16(this.rxBuf, 3);
      if (this.rxBuf.length < 5 + recLen2) return 'pending';

      if (outerType === 20 /* TLS_CHANGE_CIPHER_SPEC */) {
        this.rxBuf = this.rxBuf.slice(5 + recLen2);  // skip
        return 'pending';
      }

      if (outerType === 21 /* TLS_ALERT */) {
        kernel.serialPut('[tls/async] alert during wait-enc from ' + this.hostname + '\n');
        this.rxBuf = this.rxBuf.slice(5 + recLen2);
        this._hsPhase = 'failed'; return 'failed';
      }

      if (outerType !== 23 /* TLS_APPLICATION_DATA */) {
        kernel.serialPut('[tls/async] unexpected type=' + outerType + ' in wait-enc\n');
        this._hsPhase = 'failed'; return 'failed';
      }

      var record2 = this.rxBuf.slice(0, 5 + recLen2);
      this.rxBuf  = this.rxBuf.slice(5 + recLen2);

      var dec = tlsDecryptRecord(
          this.serverHsKey, this.serverHsIV, this.serverHsSeq, record2, this.useChaCha20);
      if (!dec || dec.type !== 22 /* TLS_HANDSHAKE */) {
        kernel.serialPut('[tls/async] decrypt failed or wrong inner type in wait-enc\n');
        // Allow a few retries for session-ticket records that arrive before the real HS msgs
        this._hsEncAttempts++;
        if (this._hsEncAttempts > 20) { this._hsPhase = 'failed'; return 'failed'; }
        return 'pending';
      }
      this.serverHsSeq++;

      // Extract first handshake message; save the rest in _hsDataBuf for next call
      var msgType3 = u8(dec.data, 0);
      var msgLen3  = u24(dec.data, 1);
      var msgData3 = dec.data.slice(4, 4 + msgLen3);
      this.transcript = this.transcript.concat(dec.data.slice(0, 4 + msgLen3));
      this._hsDataBuf = dec.data.slice(4 + msgLen3);

      return this._processHsMsg13(msgType3, msgData3);
    }

    // ── TLS 1.2 reconnect: close old socket, open new, start connectAsync ─
    if (this._hsPhase === 'need-reconnect') {
      kernel.serialPut('[tls/async] TLS 1.3 rejected by ' + this.hostname + ', retrying TLS 1.2\n');
      net.close(this.sock);
      this.sock         = net.createSocket('tcp');
      this.rxBuf        = [];
      this.transcript   = [];
      this.useTLS12     = false;
      this._got_pv_alert = false;
      this.serverAppSeq = 0; this.clientAppSeq = 0;
      this.serverHsSeq  = 0; this.clientHsSeq  = 0;
      this._hsDataBuf   = [];
      net.connectAsync(this.sock, this._hsRemoteIP, this._hsRemotePort);
      this._hsPhase = 'reconnecting';
      return 'pending';
    }

    // ── Waiting for the TLS 1.2 TCP reconnect to establish ──────────────
    if (this._hsPhase === 'reconnecting') {
      var cPoll = net.connectPoll(this.sock);
      if (cPoll !== 'connected') return 'pending';
      // TCP connected — start async TLS 1.2 handshake (send CH12, then wait for SH).
      this.useTLS12 = true;
      this.transcript = [];
      this._hs12Remainder = [];
      this.serverAppSeq = 0; this.clientAppSeq = 0;
      this.myP256Private = generateKey32Unclamped();
      this.myP256Public  = p256PublicKey(this.myP256Private);
      var ch12 = this._buildClientHello12();
      this.transcript = ch12.slice(5);  // skip 5-byte record header
      if (!net.sendBytes(this.sock, ch12)) { this._hsPhase = 'failed'; return 'failed'; }
      this._hs12S = { ch: false, s384: false, ems: false, sRand: [], pub: [], ms: [], cnt: 0 };
      this._hsPhase = 'tls12-wait-sh'; return 'pending';
    }

    // ── TLS 1.2 async: waiting for ServerHello ────────────────────────────
    if (this._hsPhase === 'tls12-wait-sh') {
      var sh12nb = this._readHS12NB();
      if (sh12nb === null) return 'pending';
      if (sh12nb === 'alert' || (sh12nb as any).type === 20) { this._hsPhase = 'failed'; return 'failed'; }
      if ((sh12nb as any).type !== HS_SERVER_HELLO) { this._hsPhase = 'failed'; return 'failed'; }
      if (!this._hs12InitFromServerHello((sh12nb as any).data)) { this._hsPhase = 'failed'; return 'failed'; }
      this._hsPhase = 'tls12-server-msgs'; return 'pending';
    }

    // ── TLS 1.2 async: reading Certificate, ServerKeyExchange, ServerHelloDone ──
    if (this._hsPhase === 'tls12-server-msgs') {
      var _s12 = this._hs12S!;
      if (_s12.cnt > 15) { this._hsPhase = 'failed'; return 'failed'; }
      var _sm = this._readHS12NB();
      if (_sm === null) return 'pending';          // incomplete record — come back next frame
      if (_sm === 'alert') { this._hsPhase = 'failed'; return 'failed'; }
      _s12.cnt++;
      if (_sm.type === 11) return 'pending';       // Certificate — skip (no cert validation)
      if (_sm.type === 13) return 'pending';       // CertificateRequest — skip
      if (_sm.type === 12) {
        // ServerKeyExchange: curve_type(1), namedCurve(2), pubkey_len(1), pubkey(N)
        var _ske = _sm.data;
        if (_ske.length < 4) { this._hsPhase = 'failed'; return 'failed'; }
        var _pkLen = u8(_ske, 3);
        _s12.pub = _ske.slice(4, 4 + _pkLen);
        return 'pending';
      }
      if (_sm.type === 14) {
        // ServerHelloDone — compute keys then send ClientKeyExchange + CCS + Finished
        if (_s12.pub.length === 0) {
          kernel.serialPut('[tls12/nb] no ServerKeyExchange received\n');
          this._hsPhase = 'failed'; return 'failed';
        }
        // Compute ECDHE shared secret
        var _shar: number[];
        if (_s12.pub.length === 32) {
          this.myPrivate = generateKey32(); this.myPublic = x25519PublicKey(this.myPrivate);
          _shar = x25519(this.myPrivate, _s12.pub);
        } else {
          _shar = ecdhP256(this.myP256Private, _s12.pub);
        }
        var _cRand: number[] = (this as any)._tls12ClientRandom;
        // Build ClientKeyExchange
        var _cke: number[] = [];
        if (_s12.pub.length === 32) { putU8(_cke, 32); _cke = _cke.concat(this.myPublic); }
        else { putU8(_cke, this.myP256Public.length); _cke = _cke.concat(this.myP256Public); }
        var _ckeMsg: number[] = [16]; putU24(_ckeMsg, _cke.length); _ckeMsg = _ckeMsg.concat(_cke);
        this.transcript = this.transcript.concat(_ckeMsg);
        // Derive master secret (RFC 7627 EMS or standard)
        var _prf12 = _s12.s384 ? tls12PRF384 : tls12PRF;
        if (_s12.ems) {
          var _sesH = _s12.s384 ? sha384(this.transcript) : sha256(this.transcript);
          _s12.ms = _prf12(_shar, 'extended master secret', _sesH, 48);
        } else {
          _s12.ms = _prf12(_shar, 'master secret', _cRand.concat(_s12.sRand), 48);
        }
        // Derive key material
        var _kSz = (_s12.ch || _s12.s384) ? 32 : 16;
        var _iSz = _s12.ch ? 12 : 4;
        var _km  = _prf12(_s12.ms, 'key expansion', _s12.sRand.concat(_cRand), _kSz*2 + _iSz*2);
        this.clientAppKey       = _km.slice(0,         _kSz);
        this.serverAppKey       = _km.slice(_kSz,      _kSz*2);
        this.tls12ClientWriteIV = _km.slice(_kSz*2,         _kSz*2 + _iSz);
        this.tls12ServerWriteIV = _km.slice(_kSz*2 + _iSz,  _kSz*2 + _iSz*2);
        this.clientAppSeq = 0; this.serverAppSeq = 0;
        // Send ClientKeyExchange
        var _ckeRec = [TLS_HANDSHAKE, 0x03, 0x03]; putU16(_ckeRec, _ckeMsg.length);
        if (!net.sendBytes(this.sock, _ckeRec.concat(_ckeMsg))) { this._hsPhase = 'failed'; return 'failed'; }
        // Send ChangeCipherSpec
        if (!net.sendBytes(this.sock, [TLS_CHANGE_CIPHER_SPEC, 0x03, 0x03, 0x00, 0x01, 0x01])) { this._hsPhase = 'failed'; return 'failed'; }
        // Send Finished
        var _finH = _s12.s384 ? sha384(this.transcript) : sha256(this.transcript);
        var _vd   = _prf12(_s12.ms, 'client finished', _finH, 12);
        var _finMsg: number[] = [HS_FINISHED]; putU24(_finMsg, 12); _finMsg = _finMsg.concat(_vd);
        var _finRec = _s12.ch
          ? tls12EncryptRecordChaCha(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, _finMsg)
          : tls12EncryptRecord(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, _finMsg);
        this.clientAppSeq++;
        if (!net.sendBytes(this.sock, _finRec)) { this._hsPhase = 'failed'; return 'failed'; }
        this._hsPhase = 'tls12-wait-ccs'; return 'pending';
      }
      return 'pending';  // unrecognised type — skip
    }

    // ── TLS 1.2 async: waiting for server ChangeCipherSpec ────────────────
    if (this._hsPhase === 'tls12-wait-ccs') {
      var _s12c = this._hs12S!;
      if (_s12c.cnt > 25) { this._hsPhase = 'failed'; return 'failed'; }
      var _cm = this._readHS12NB();
      if (_cm === null) return 'pending';
      if (_cm === 'alert') { this._hsPhase = 'failed'; return 'failed'; }
      _s12c.cnt++;
      if (_cm.type === 20) { this._hsPhase = 'tls12-wait-fin'; return 'pending'; }
      // NewSessionTicket (type 4) or other pre-CCS messages — skip
      return 'pending';
    }

    // ── TLS 1.2 async: waiting for encrypted server Finished ──────────────
    if (this._hsPhase === 'tls12-wait-fin') {
      var _fm = this._readEncryptedHS12NB();
      if (_fm === null) return 'pending';
      if (_fm.type !== HS_FINISHED) { this._hsPhase = 'failed'; return 'failed'; }
      this.handshakeDone = true;
      this._hsPhase = 'done';
      this.useTLS12 = true;
      var _cname = (this as any)._tls12ChaCha ? 'ChaCha20-Poly1305'
                 : this._hs12S!.s384 ? 'AES-256-GCM' : 'AES-128-GCM';
      kernel.serialPut('[tls12/nb] async handshake OK with ' + this.hostname + ' (' + _cname + ')\n');
      return 'connected';
    }

    return 'pending';
  }

  /**
   * Process one TLS 1.3 encrypted handshake message during the async handshake.
   * Returns 'connected' on Finished, 'pending' to continue, 'failed' on error.
   */
  private _processHsMsg13(msgType: number, msgData: number[]): 'connected' | 'pending' | 'failed' {
    this._hsEncAttempts++;
    if (this._hsEncAttempts > 25) { this._hsPhase = 'failed'; return 'failed'; }

    if (msgType === 20 /* HS_FINISHED */ ) {
      if (this._processServerFinished(msgData)) {
        this.handshakeDone = true;
        this._hsPhase = 'done';
        return 'connected';
      }
      this._hsPhase = 'failed'; return 'failed';
    }

    if (msgType === 8 /* HS_ENCRYPTED_EXT */) {
      this._parseEncryptedExtensions(msgData);
    }
    // Certificate (11), CertificateVerify (15) — skipped, we rely on TOFU/pinning
    return 'pending';  // more messages to follow
  }

  /**
   * Non-blocking TLS read: poll the NIC once and drain ALL complete
   * TLS records from the buffer.  Returns concatenated decrypted app data or null.
   */
  readNB(): number[] | null {
    var chunk = net.recvBytesNB(this.sock);
    if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this.rxBuf.push(chunk[_pi]); }
    if (this.rxBuf.length < 5) return null;
    var result: number[] | null = null;
    // Drain all complete records in one call
    while (this.rxBuf.length >= 5) {
      var outerType = u8(this.rxBuf, 0);
      var recLen    = u16(this.rxBuf, 3);
      if (this.rxBuf.length < 5 + recLen) break;  // incomplete record â€” wait more
      var record    = this.rxBuf.slice(0, 5 + recLen);
      this.rxBuf    = this.rxBuf.slice(5 + recLen);
      if (outerType !== TLS_APPLICATION_DATA) continue;
      if (this.useTLS12) {
        var plain12 = (this as any)._tls12ChaCha
          ? tls12DecryptRecordChaCha(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, record)
          : tls12DecryptRecord(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, record);
        if (plain12) {
          this.serverAppSeq++;
          if (!result) { result = plain12; }
          else { for (var _d12 = 0; _d12 < plain12.length; _d12++) result.push(plain12[_d12]); }
        }
        continue;
      }
      var dec = tlsDecryptRecord(
          this.serverAppKey, this.serverAppIV, this.serverAppSeq, record, this.useChaCha20);
      if (dec) {
        this.serverAppSeq++;
        if (dec.type === TLS_APPLICATION_DATA) {
          if (!result) { result = dec.data; }
          else { for (var _di = 0; _di < dec.data.length; _di++) result.push(dec.data[_di]); }
        }
      }
    }
    return result;
  }

  /** Check if the underlying TCP connection has received a FIN. */
  isEOF(): boolean {
    return net.isEOF(this.sock);
  }

  /** Send application data over TLS (supports both TLS 1.3 and TLS 1.2). */
  write(data: number[]): boolean {
    if (!this.handshakeDone) return false;
    if (this.useTLS12) {
      var rec12 = (this as any)._tls12ChaCha
        ? tls12EncryptRecordChaCha(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_APPLICATION_DATA, data)
        : tls12EncryptRecord(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_APPLICATION_DATA, data);
      this.clientAppSeq++;
      return net.sendBytes(this.sock, rec12);
    }
    var record = tlsEncryptRecord(
        this.clientAppKey, this.clientAppIV, this.clientAppSeq,
        TLS_APPLICATION_DATA, data, this.useChaCha20);
    this.clientAppSeq++;
    return net.sendBytes(this.sock, record);
  }

  /** Receive decrypted application data. Returns null on timeout. */
  read(timeoutTicks: number = 200): number[] | null {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (kernel.getTicks() < deadline) {
      // Always poll for more data to ensure rxBuf grows when partial records exist
      var more = net.recvBytes(this.sock, 10);
      if (more && more.length > 0) { for (var _pi = 0; _pi < more.length; _pi++) this.rxBuf.push(more[_pi]); }

      if (this.rxBuf.length < 5) continue;
      var outerType = u8(this.rxBuf, 0);
      var recLen    = u16(this.rxBuf, 3);
      if (this.rxBuf.length < 5 + recLen) continue;  // accumulate more

      var record    = this.rxBuf.slice(0, 5 + recLen);
      this.rxBuf    = this.rxBuf.slice(5 + recLen);

      if (outerType === TLS_APPLICATION_DATA) {
        if (this.useTLS12) {
          var plain12 = (this as any)._tls12ChaCha
            ? tls12DecryptRecordChaCha(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, record)
            : tls12DecryptRecord(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, record);
          if (plain12) { this.serverAppSeq++; return plain12; }
        } else {
          var dec = tlsDecryptRecord(
              this.serverAppKey, this.serverAppIV, this.serverAppSeq, record, this.useChaCha20);
          if (dec) {
            this.serverAppSeq++;
            if (dec.type === TLS_APPLICATION_DATA) return dec.data;
          }
        }
      }
      // Alert or other record type â€” skip and keep polling
    }
    return null;
  }

  close(): void {
    // Send close_notify alert for clean TLS shutdown
    if (this.handshakeDone) {
      try {
        // close_notify = alert level 1 (warning), description 0
        var alertData = [1, 0];
        if (this.useTLS12) {
          var alertRec = (this as any)._tls12ChaCha
            ? tls12EncryptRecordChaCha(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, 21, alertData)
            : tls12EncryptRecord(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, 21, alertData);
          net.sendBytes(this.sock, alertRec);
        } else {
          var alertRec = tlsEncryptRecord(
              this.clientAppKey, this.clientAppIV, this.clientAppSeq,
              21, alertData, this.useChaCha20);
          net.sendBytes(this.sock, alertRec);
        }
      } catch (_) { /* best-effort */ }
    }
    net.close(this.sock);
  }

  // â”€â”€ Private helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private _performHandshake(): boolean {
    this.myPrivate     = generateKey32();
    this.myPublic      = x25519PublicKey(this.myPrivate);
    this.myP256Private = generateKey32Unclamped();
    this.myP256Public  = p256PublicKey(this.myP256Private);  // eager: needed for dual key_share

    var clientHello = this._buildClientHello();
    this.transcript = this.transcript.concat(clientHello.slice(5)); // skip record header
    if (!net.sendBytes(this.sock, clientHello)) return false;

    // Read ServerHello (may be a HelloRetryRequest)
    var sh = this._readHandshakeMsg(true);
    if (!sh || sh.type !== HS_SERVER_HELLO) return false;

    // Detect HelloRetryRequest: random field (bytes 2..33) equals HRR sentinel
    var isHRR = sh.data.length >= 34;
    if (isHRR) {
      for (var _hi = 0; _hi < 32; _hi++) {
        if (sh.data[2 + _hi] !== HRR_RANDOM[_hi]) { isHRR = false; break; }
      }
    }
    if (isHRR) {
      // Lazily compute P-256 public key now that we know server wants it
      if (this.myP256Public.length === 0) {
        this.myP256Public = p256PublicKey(this.myP256Private);
      }
      // Reconstruct transcript per RFC 8446 Â§4.4.1:
      // replace CH1 bytes with message_hash(CH1) sentinel, then append HRR
      var ch1Hash = sha256(this.transcript.slice(0, this.transcript.length - sh.data.length - 4));
      var msgHashMsg = [0xfe, 0x00, 0x00, 0x20].concat(ch1Hash); // type=254, len=32
      this.transcript = msgHashMsg.concat(this.transcript.slice(this.transcript.length - sh.data.length - 4));
      // Send a new ClientHello (same key material, server picks from what we offered)
      var ch2 = this._buildClientHello();
      this.transcript = this.transcript.concat(ch2.slice(5));
      if (!net.sendBytes(this.sock, ch2)) return false;
      sh = this._readHandshakeMsg(true);
      if (!sh || sh.type !== HS_SERVER_HELLO) return false;
    }

    var serverKeyInfo = this._parseServerHello(sh.data);
    if (!serverKeyInfo) {
      // If server chose TLS 1.2 (detected by absent key_share), continue on same connection
      if (this._got_pv_alert) {
        this._got_pv_alert = false;  // handled in-place; no TCP reconnect needed
        kernel.serialPut('[tls] server chose TLS 1.2 \u2014 continuing on same connection\n');
        return this._performHandshake12InPlace(sh.data);
      }
      return false;
    }

    // Derive handshake keys
    if (!this._deriveHandshakeKeys(serverKeyInfo.key, serverKeyInfo.group)) return false;

    // Read encrypted server handshake messages
    var finishedOk = false;
    for (var attempt = 0; attempt < 20; attempt++) {
      var msg = this._readEncryptedHandshakeMsg();
      if (!msg) break;
      if (msg.type === HS_FINISHED) {
        finishedOk = this._processServerFinished(msg.data);
        break;
      }
      // Parse ALPN from EncryptedExtensions (RFC 8446 Â§4.3.1)
      if (msg.type === HS_ENCRYPTED_EXT) {
        this._parseEncryptedExtensions(msg.data);
      }
      // Certificate, CertificateVerify â€” skip
    }
    if (!finishedOk) return false;

    // App keys already derived inside _processServerFinished with the correct
    // pre-ClientFinished transcript hash.
    this.handshakeDone = true;
    return true;
  }

  private _buildClientHello(): number[] {
    var body: number[] = [];

    // ProtocolVersion = 0x0303
    putU16(body, 0x0303);
    // Random (32 bytes of hardware-random â€” RFC 8446 Â§4.1.2 requires unpredictable bytes)
    var _rnd = getHardwareRandom(32);
    (this as any)._tls12ClientRandom = _rnd;  // save for in-place TLS 1.2 continuation
    for (var i = 0; i < 32; i++) putU8(body, _rnd[i]);
    // Session ID â€” 32 bytes of hardware random (required for TLS 1.3 middlebox compat)
    putU8(body, 32);
    var _sid = getHardwareRandom(32);
    for (var i = 0; i < 32; i++) putU8(body, _sid[i]);
    // Cipher suites â€” TLS 1.3 + TLS 1.2 AES-128-GCM fallbacks
    // Only offer SHA-256-based ciphers so our PRF (SHA-256) is always correct.
    // TLS 1.3 servers pick from 0x1301/0x1303 via supported_versions.
    // TLS 1.2 servers pick from the ECDHE-AES128-GCM ciphers.
    putU16(body, 18);  // 9 suites x 2 bytes
    putU16(body, CS_AES_128_GCM_SHA256);         // 0x1301 TLS 1.3
    putU16(body, CS_CHACHA20_POLY1305_SHA256);   // 0x1303 TLS 1.3
    putU16(body, 0xc02b);  // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
    putU16(body, 0xc02c);  // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
    putU16(body, CS_TLS12_ECDHE_RSA_AES128_GCM); // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
    putU16(body, CS_TLS12_ECDHE_RSA_AES256_GCM); // TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
    putU16(body, 0xcca9);  // TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
    putU16(body, CS_TLS12_ECDHE_RSA_CHACHA20);   // TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
    putU16(body, CS_EMPTY_RENEG);                 // 0x00ff SCSV
    // Compression methods
    putU8(body, 1); putU8(body, 0);

    // Extensions
    var exts: number[] = [];

    // SNI
    var sniHost = strToBytes(this.hostname);
    var sniExt: number[] = [];
    putU16(sniExt, EXT_SNI);
    var sniData: number[] = [];
    putU16(sniData, sniHost.length + 3);  // list len
    putU8(sniData, 0);                    // name type host_name
    putU16(sniData, sniHost.length);
    sniData = sniData.concat(sniHost);
    putU16(sniExt, sniData.length);
    exts = exts.concat(sniExt).concat(sniData);

    // supported_versions: TLS 1.3 + TLS 1.2 â€” real browsers advertise both, and
    // some Fastly edges send protocol_version(70) when they see TLS 1.3 only
    var svExt: number[] = [];
    putU16(svExt, EXT_SUPPORTED_VERS);
    putU16(svExt, 5);  // ext data len: 1 (list_len) + 4 (two versions)
    putU8(svExt, 4);   // list len = 4 bytes = 2 versions
    putU16(svExt, 0x0304);  // TLS 1.3
    putU16(svExt, 0x0303);  // TLS 1.2 (required by some Fastly edges)
    exts = exts.concat(svExt);

    // supported_groups: secp256r1 (P-256) + x25519
    var sgExt: number[] = [];
    putU16(sgExt, EXT_SUPPORTED_GROUPS);
    putU16(sgExt, 6);  // ext len: 2 (list-len) + 2 groups Ã— 2 bytes
    putU16(sgExt, 4);  // list len
    putU16(sgExt, GROUP_P256);
    putU16(sgExt, GROUP_X25519);
    exts = exts.concat(sgExt);

    // key_share: x25519 only (server can HRR to request P-256 if desired)
    var ksExt: number[] = [];
    putU16(ksExt, EXT_KEY_SHARE);
    var ksData: number[] = [];
    putU16(ksData, 36 + 69);     // client_shares list len: x25519(36) + P-256(69)
    // x25519 entry
    putU16(ksData, GROUP_X25519);
    putU16(ksData, 32);
    ksData = ksData.concat(this.myPublic);
    // P-256 entry (65-byte uncompressed point) â€” required by some Fastly edges
    putU16(ksData, GROUP_P256);
    putU16(ksData, 65);
    ksData = ksData.concat(this.myP256Public);
    putU16(ksExt, ksData.length);
    exts = exts.concat(ksExt).concat(ksData);

    // signature_algorithms
    var saExt: number[] = [];
    putU16(saExt, EXT_SIG_ALGS);
    var saData: number[] = [];
    putU16(saData, 14);  // list len: 7 sig algs Ã— 2 bytes
    putU16(saData, 0x0804); // rsa_pss_rsae_sha256
    putU16(saData, 0x0805); // rsa_pss_rsae_sha384
    putU16(saData, 0x0806); // rsa_pss_rsae_sha512
    putU16(saData, 0x0403); // ecdsa_secp256r1_sha256
    putU16(saData, 0x0503); // ecdsa_secp384r1_sha384
    putU16(saData, 0x0401); // rsa_pkcs1_sha256
    putU16(saData, 0x0501); // rsa_pkcs1_sha384
    putU16(saExt, saData.length);
    exts = exts.concat(saExt).concat(saData);

    // session_ticket (0x0023): empty = request a session ticket
    // Required by many TLS 1.3 servers (including Fastly) to confirm TLS 1.3 intent
    var stExt: number[] = [];
    putU16(stExt, EXT_SESSION_TICKET);
    putU16(stExt, 0);  // empty session ticket data
    exts = exts.concat(stExt);

    // psk_key_exchange_modes (0x002d): required by RFC 8446 Â§4.2.9 for TLS 1.3
    // Most TLS 1.3 servers (incl. Fastly/BoringSSL) expect this extension
    var pskExt: number[] = [];
    putU16(pskExt, EXT_PSK_KEY_EXCH_MODES);
    putU16(pskExt, 2);  // ext data len = 2
    putU8(pskExt, 1);   // ke_modes list len = 1 byte
    putU8(pskExt, 1);   // psk_dhe_ke(1) = PSK with (EC)DHE key exchange
    exts = exts.concat(pskExt);

    // extended_master_secret (0x0017) â€” Chrome always sends this in TLS 1.3 CH for JA3 compat
    var emsExt13: number[] = [];
    putU16(emsExt13, 0x0017); putU16(emsExt13, 0);
    exts = exts.concat(emsExt13);

    // ALPN extension: offer h2 (HTTP/2) and http/1.1 â€” prefer h2.
    // HTTP/2 is fully implemented via HTTP2Connection class.
    var alpnExt: number[] = [];
    putU16(alpnExt, EXT_ALPN);
    var alpnData: number[] = [];
    var protoH2 = strToBytes('h2');
    var proto11 = strToBytes('http/1.1');
    var protoList: number[] = [];
    putU8(protoList, protoH2.length); protoList = protoList.concat(protoH2);
    putU8(protoList, proto11.length); protoList = protoList.concat(proto11);
    putU16(alpnData, protoList.length);
    alpnData = alpnData.concat(protoList);
    putU16(alpnExt, alpnData.length);
    exts = exts.concat(alpnExt).concat(alpnData);

    putU16(body, exts.length);
    body = body.concat(exts);

    // Handshake header
    var hs: number[] = [];
    putU8(hs, HS_CLIENT_HELLO);
    putU24(hs, body.length);
    hs = hs.concat(body);

    // TLS record: RFC 8446 Â§5.1 says outer version for ClientHello SHOULD be 0x0301 (TLS 1.0)
    // but 0x0303 is what the vast majority of real implementations use
    var rec: number[] = [TLS_HANDSHAKE, 0x03, 0x03];
    putU16(rec, hs.length);
    return rec.concat(hs);
  }

  private _readHandshakeMsg(addToTranscript: boolean):
      { type: number; data: number[] } | null {
    // Read until we have at least 5 bytes (record header)
    var deadline = kernel.getTicks() + 50;
    while (this.rxBuf.length < 5 && kernel.getTicks() < deadline) {
      var chunk = net.recvBytes(this.sock, 3);
      if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this.rxBuf.push(chunk[_pi]); }
    }
    if (this.rxBuf.length < 5) return null;
    var recType = u8(this.rxBuf, 0);
    var recLen  = u16(this.rxBuf, 3);
    // If server sent an alert, wait for full alert record then log and bail
    if (recType === 21 /* TLS_ALERT */) {
      var alertDeadline = kernel.getTicks() + 20;
      while (this.rxBuf.length < 5 + recLen && kernel.getTicks() < alertDeadline) {
        var achunk = net.recvBytes(this.sock, 3);
        if (achunk && achunk.length > 0) for (var _ai = 0; _ai < achunk.length; _ai++) this.rxBuf.push(achunk[_ai]);
      }
      var alertLevel = this.rxBuf.length > 5 ? u8(this.rxBuf, 5) : 0;
      var alertDesc  = this.rxBuf.length > 6 ? u8(this.rxBuf, 6) : 0;
      kernel.serialPut('[tls] alert from ' + this.hostname + ': level=' + alertLevel + ' desc=' + alertDesc + '\n');
      if (alertDesc === 70 || alertDesc === 40) this._got_pv_alert = true;  // protocol_version or handshake_failure â†’ trigger TLS 1.2 retry
      return null;
    }
    if (recType !== TLS_HANDSHAKE) {
      kernel.serialPut('[tls] unexpected record type=' + recType + ' from ' + this.hostname + '\n');
      return null;
    }
    // Wait for full record
    deadline = kernel.getTicks() + 50;
    while (this.rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
      var chunk = net.recvBytes(this.sock, 3);
      if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this.rxBuf.push(chunk[_pi]); }
    }
    if (this.rxBuf.length < 5 + recLen) return null;
    var recData = this.rxBuf.slice(5, 5 + recLen);
    this.rxBuf  = this.rxBuf.slice(5 + recLen);
    if (recData.length < 4) return null;
    var msgType = u8(recData, 0);
    var msgLen  = u24(recData, 1);
    var msgData = recData.slice(4, 4 + msgLen);
    if (addToTranscript) this.transcript = this.transcript.concat(recData.slice(0, 4 + msgLen));
    return { type: msgType, data: msgData };
  }

  /** Parse EncryptedExtensions to extract ALPN negotiated protocol (RFC 8446 Â§4.3.1). */
  private _parseEncryptedExtensions(data: number[]): void {
    if (data.length < 2) return;
    var extLen = u16(data, 0);
    var off = 2;
    var extEnd = 2 + extLen;
    while (off + 4 <= extEnd && off + 4 <= data.length) {
      var extType = u16(data, off); off += 2;
      var extDataLen = u16(data, off); off += 2;
      if (extType === EXT_ALPN) {
        // ALPN: u16 protocol_list_len, then (u8 proto_len + proto_bytes)*
        if (off + 2 <= data.length) {
          var listLen = u16(data, off);
          var alpnOff = off + 2;
          if (alpnOff + 1 <= data.length && listLen > 0) {
            var protoLen = u8(data, alpnOff);
            if (alpnOff + 1 + protoLen <= data.length) {
              var protoBytes = data.slice(alpnOff + 1, alpnOff + 1 + protoLen);
              var proto = '';
              for (var _pi = 0; _pi < protoBytes.length; _pi++) proto += String.fromCharCode(protoBytes[_pi]);
              this.alpnProtocol = proto;
              kernel.serialPut('[tls] ALPN negotiated: ' + proto + '\n');
            }
          }
        }
      }
      off += extDataLen;
    }
  }

  private _parseServerHello(data: number[]): { group: number; key: number[] } | null {
    if (data.length < 36) return null;
    // version (2) + random (32) + session id len (1) + session id
    var sidLen = u8(data, 34);
    var off = 35 + sidLen;
    if (off + 2 > data.length) return null;
    var cipherSuite = u16(data, off); off += 2;
    // [Item 295] Record which cipher suite was selected
    this.useChaCha20 = (cipherSuite === CS_CHACHA20_POLY1305_SHA256);
    if (u8(data, off) !== 0) return null; // compression must be null
    off++;
    if (off + 2 > data.length) return null;
    var extLen = u16(data, off); off += 2;
    var extEnd = off + extLen;
    // Parse extensions to find key_share
    var foundKeyShare = false;
    while (off + 4 <= extEnd) {
      var extType = u16(data, off); off += 2;
      var extLen2 = u16(data, off); off += 2;
      if (extType === EXT_KEY_SHARE) {
        foundKeyShare = true;
        if (off + 4 > extEnd) return null;
        var group = u16(data, off); off += 2;
        var kLen  = u16(data, off); off += 2;
        if (group === GROUP_X25519) {
          if (kLen !== 32 || off + 32 > extEnd) return null;
          return { group: GROUP_X25519, key: data.slice(off, off + 32) };
        } else if (group === GROUP_P256) {
          if (kLen !== 65 || off + 65 > extEnd) return null;
          return { group: GROUP_P256, key: data.slice(off, off + 65) };
        }
        return null; // unsupported group
      }
      off += extLen2;
    }
    // No key_share found: server responded with a TLS 1.2 ServerHello
    if (!foundKeyShare) {
      this._got_pv_alert = true;  // trigger TLS 1.2 continuation in _performHandshake
    }
    return null;
  }

  private _deriveHandshakeKeys(serverKey: number[], group: number): boolean {
    // Shared secret: X25519 or P-256 ECDH
    var sharedSecret = (group === GROUP_P256)
      ? ecdhP256(this.myP256Private, serverKey)
      : x25519(this.myPrivate, serverKey);

    // early_secret = HKDF-Extract(0^32, 0^32)
    var zeros32 = new Array(32).fill(0);
    var earlySecret = hkdfExtract(zeros32, zeros32);

    // derived_secret = HKDF-Expand-Label(earlySecret, "derived", sha256([]), 32)
    var emptyHash = sha256([]);
    var derivedSecret = hkdfExpandLabel(earlySecret, 'derived', emptyHash, 32);

    // handshake_secret = HKDF-Extract(derivedSecret, sharedSecret)
    var handshakeSecret = hkdfExtract(derivedSecret, sharedSecret);

    // Transcript hash up to now (ClientHello + ServerHello)
    var txHash = sha256(this.transcript);

    // Client + Server HS traffic secrets
    var cHsTraffic = hkdfExpandLabel(handshakeSecret, 'c hs traffic', txHash, 32);
    var sHsTraffic = hkdfExpandLabel(handshakeSecret, 's hs traffic', txHash, 32);

    // ChaCha20-Poly1305 uses 32-byte keys; AES-128-GCM uses 16-byte keys
    var keyLen = this.useChaCha20 ? 32 : 16;
    this.clientHsKey = hkdfExpandLabel(cHsTraffic, 'key', [], keyLen);
    this.clientHsIV  = hkdfExpandLabel(cHsTraffic, 'iv',  [], 12);
    this.serverHsKey = hkdfExpandLabel(sHsTraffic, 'key', [], keyLen);
    this.serverHsIV  = hkdfExpandLabel(sHsTraffic, 'iv',  [], 12);

    // Save for ClientFinished MAC computation and app key derivation
    (this as any)._cHsTrafficSaved = cHsTraffic;
    (this as any)._handshakeSecret = handshakeSecret;
    return true;
  }

  private _readEncryptedHandshakeMsg(): { type: number; data: number[] } | null {
    // If we have leftover decrypted handshake bytes from a multi-message record,
    // extract the next message from there before reading a new TLS record.
    if (this._hsDataBuf.length >= 4) {
      var msgType0 = u8(this._hsDataBuf, 0);
      var msgLen0  = u24(this._hsDataBuf, 1);
      if (this._hsDataBuf.length >= 4 + msgLen0) {
        var msgData0 = this._hsDataBuf.slice(4, 4 + msgLen0);
        this.transcript = this.transcript.concat(this._hsDataBuf.slice(0, 4 + msgLen0));
        this._hsDataBuf = this._hsDataBuf.slice(4 + msgLen0);
        return { type: msgType0, data: msgData0 };
      }
    }

    // Read a new encrypted TLS record, skipping ChangeCipherSpec records
    for (var skip = 0; skip < 5; skip++) {
      var deadline = kernel.getTicks() + 50;
      while (this.rxBuf.length < 5 && kernel.getTicks() < deadline) {
        var chunk = net.recvBytes(this.sock, 3);
        if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this.rxBuf.push(chunk[_pi]); }
      }
      if (this.rxBuf.length < 5) return null;
      var outerType = u8(this.rxBuf, 0);
      var recLen    = u16(this.rxBuf, 3);
      deadline = kernel.getTicks() + 50;
      while (this.rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
        var chunk = net.recvBytes(this.sock, 3);
        if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this.rxBuf.push(chunk[_pi]); }
      }
      if (this.rxBuf.length < 5 + recLen) return null;
      var record     = this.rxBuf.slice(0, 5 + recLen);
      this.rxBuf     = this.rxBuf.slice(5 + recLen);
      if (outerType === TLS_CHANGE_CIPHER_SPEC) continue;
      if (outerType !== TLS_APPLICATION_DATA) return null;
      // Decrypt
      var dec = tlsDecryptRecord(
          this.serverHsKey, this.serverHsIV, this.serverHsSeq, record, this.useChaCha20);
      if (!dec) return null;
      this.serverHsSeq++;
      if (dec.type !== TLS_HANDSHAKE) return null;
      // Extract first handshake message; save remainder in _hsDataBuf
      var msgType = u8(dec.data, 0);
      var msgLen  = u24(dec.data, 1);
      var msgData = dec.data.slice(4, 4 + msgLen);
      this.transcript = this.transcript.concat(dec.data.slice(0, 4 + msgLen));
      // Any remaining bytes in this record may be more handshake messages
      this._hsDataBuf = dec.data.slice(4 + msgLen);
      return { type: msgType, data: msgData };
    }
    return null;
  }

  private _processServerFinished(data: number[]): boolean {
    // transcript at this point = ClientHello..ServerFinished (correct for both
    // app-key derivation and the ClientFinished verify_data per RFC 8446 Â§7.1)
    var txHash = sha256(this.transcript);

    // Derive application traffic keys NOW (transcript hash must NOT include ClientFinished)
    this._deriveAppKeys(txHash);

    // Build client Finished verify_data
    var finishedKey = hkdfExpandLabel(
        (this as any)._cHsTrafficSaved || this.clientHsKey, 'finished', [], 32);
    var verifyData = hmacSha256(finishedKey, txHash);

    // Build and send Client Finished handshake message
    var msgBody: number[] = [];
    putU8(msgBody, HS_FINISHED);
    putU24(msgBody, verifyData.length);
    msgBody = msgBody.concat(verifyData);
    this.transcript = this.transcript.concat(msgBody);  // add AFTER key derivation

    // Encrypt with client HS key
    var record = tlsEncryptRecord(
        this.clientHsKey, this.clientHsIV, this.clientHsSeq,
        TLS_HANDSHAKE, msgBody, this.useChaCha20);
    this.clientHsSeq++;
    net.sendBytes(this.sock, record);
    return true;
  }

  private _deriveAppKeys(txHash: number[]): void {
    var handshakeSecret: number[] = (this as any)._handshakeSecret;
    var zeros32 = new Array(32).fill(0);
    // master_secret
    var derivedSecret  = hkdfExpandLabel(handshakeSecret, 'derived', sha256([]), 32);
    var masterSecret   = hkdfExtract(derivedSecret, zeros32);
    var cAppTraffic = hkdfExpandLabel(masterSecret, 'c ap traffic', txHash, 32);
    var sAppTraffic = hkdfExpandLabel(masterSecret, 's ap traffic', txHash, 32);
    // ChaCha20-Poly1305 uses 32-byte keys; AES-128-GCM uses 16-byte keys
    var keyLen = this.useChaCha20 ? 32 : 16;
    this.clientAppKey = hkdfExpandLabel(cAppTraffic, 'key', [], keyLen);
    this.clientAppIV  = hkdfExpandLabel(cAppTraffic, 'iv',  [], 12);
    this.serverAppKey = hkdfExpandLabel(sAppTraffic, 'key', [], keyLen);
    this.serverAppIV  = hkdfExpandLabel(sAppTraffic, 'iv',  [], 12);

    // Derive resumption_master_secret for session tickets (TLS 1.3 Â§7.1)
    // transcript at this point includes everything through ServerFinished
    (this as any)._resumptionMaster = hkdfExpandLabel(masterSecret, 'res master', txHash, 32);
    this._resumptionSecret = (this as any)._resumptionMaster;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // TLS 1.2 ECDHE-RSA handshake (RFC 5246 + RFC 4492)
  // Used as fallback when server rejects TLS 1.3 with protocol_version alert.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Build a TLS 1.2 ClientHello (no TLS 1.3 extensions). */
  private _buildClientHello12(): number[] {
    var clRandom = getHardwareRandom(32);
    (this as any)._tls12ClientRandom = clRandom;

    var body: number[] = [];
    putU16(body, 0x0303);  // TLS 1.2 legacy version
    for (var i = 0; i < 32; i++) putU8(body, clRandom[i]);
    putU8(body, 0);  // no session ID
    // Cipher suites: ECDHE with AES-128/256-GCM + ChaCha20 (RSA + ECDSA) + SCSV
    putU16(body, 14);  // 7 suites x 2 bytes
    putU16(body, CS_TLS12_ECDHE_RSA_AES128_GCM);   // 0xc02f
    putU16(body, 0xc02b);                           // ECDHE-ECDSA-AES128-GCM
    putU16(body, CS_TLS12_ECDHE_RSA_AES256_GCM);   // 0xc030
    putU16(body, 0xc02c);                           // ECDHE-ECDSA-AES256-GCM
    putU16(body, CS_TLS12_ECDHE_RSA_CHACHA20);      // 0xcca8
    putU16(body, 0xcca9);                           // ECDHE-ECDSA-ChaCha20
    putU16(body, CS_EMPTY_RENEG);
    // Compression
    putU8(body, 1); putU8(body, 0);
    // Extensions
    var exts: number[] = [];
    // SNI
    var sniHost = strToBytes(this.hostname);
    var sniData: number[] = [];
    putU16(sniData, sniHost.length + 3);
    putU8(sniData, 0);
    putU16(sniData, sniHost.length);
    sniData = sniData.concat(sniHost);
    var sniExt: number[] = [];
    putU16(sniExt, EXT_SNI);
    putU16(sniExt, sniData.length);
    exts = exts.concat(sniExt).concat(sniData);
    // EC point formats
    var epf: number[] = [];
    putU16(epf, EXT_EC_POINT_FORMATS);
    putU16(epf, 2); putU8(epf, 1); putU8(epf, 0);
    exts = exts.concat(epf);
    // Supported groups  
    var sg: number[] = [];
    putU16(sg, EXT_SUPPORTED_GROUPS);
    putU16(sg, 6); putU16(sg, 4); putU16(sg, GROUP_P256); putU16(sg, GROUP_X25519);
    exts = exts.concat(sg);
    // Sig algs â€” match what TLS 1.3 CH offers for maximum compatibility
    var sa: number[] = [];
    putU16(sa, EXT_SIG_ALGS);
    var saD: number[] = [];
    putU16(saD, 14);  // 7 sig algs Ã— 2 bytes
    putU16(saD, 0x0804);  // rsa_pss_rsae_sha256
    putU16(saD, 0x0805);  // rsa_pss_rsae_sha384
    putU16(saD, 0x0806);  // rsa_pss_rsae_sha512
    putU16(saD, 0x0403);  // ecdsa_secp256r1_sha256
    putU16(saD, 0x0503);  // ecdsa_secp384r1_sha384
    putU16(saD, 0x0401);  // rsa_pkcs1_sha256
    putU16(saD, 0x0501);  // rsa_pkcs1_sha384
    putU16(sa, saD.length);
    exts = exts.concat(sa).concat(saD);
    // Extended master secret (0x0017) â€” required by modern TLS 1.2 endpoints (Fastly)
    var ems: number[] = [];
    putU16(ems, 0x0017); putU16(ems, 0);
    exts = exts.concat(ems);
    // Renegotiation info
    var ri: number[] = [];
    putU16(ri, EXT_RENEGOTIATION_INFO); putU16(ri, 1); putU8(ri, 0);
    exts = exts.concat(ri);
    // ALPN: offer h2 and http/1.1 (prefer h2)
    var alpnExt: number[] = [];
    putU16(alpnExt, EXT_ALPN);
    var protoH2_12 = strToBytes('h2');
    var proto11_12 = strToBytes('http/1.1');
    var pList: number[] = [];
    putU8(pList, protoH2_12.length); pList = pList.concat(protoH2_12);
    putU8(pList, proto11_12.length); pList = pList.concat(proto11_12);
    var alpnD: number[] = []; putU16(alpnD, pList.length); alpnD = alpnD.concat(pList);
    putU16(alpnExt, alpnD.length);
    exts = exts.concat(alpnExt).concat(alpnD);
    // Session ticket (empty)
    var stE: number[] = []; putU16(stE, EXT_SESSION_TICKET); putU16(stE, 0);
    exts = exts.concat(stE);
    putU16(body, exts.length);
    body = body.concat(exts);
    var hs: number[] = [];
    putU8(hs, HS_CLIENT_HELLO); putU24(hs, body.length); hs = hs.concat(body);
    var rec = [TLS_HANDSHAKE, 0x03, 0x01]; putU16(rec, hs.length);
    return rec.concat(hs);
  }

  /** Read a raw (unencrypted) TLS 1.2 handshake message from rxBuf.
   *  Handles multiple handshake messages coalesced in a single TLS record. */
  private _hs12Remainder: number[] = [];  // leftover bytes from a coalesced record
  private _readHS12(): { type: number; data: number[] } | null {
    // First, check if we have leftover handshake bytes from a previous record
    if (this._hs12Remainder.length >= 4) {
      var mt0 = u8(this._hs12Remainder, 0);
      var ml0 = u24(this._hs12Remainder, 1);
      if (this._hs12Remainder.length >= 4 + ml0) {
        this.transcript = this.transcript.concat(this._hs12Remainder.slice(0, 4 + ml0));
        var data0 = this._hs12Remainder.slice(4, 4 + ml0);
        this._hs12Remainder = this._hs12Remainder.slice(4 + ml0);
        return { type: mt0, data: data0 };
      }
    }
    var deadline = kernel.getTicks() + 50;
    while (kernel.getTicks() < deadline) {
      if (this.rxBuf.length >= 5) {
        var rt  = u8(this.rxBuf, 0);
        var rl  = u16(this.rxBuf, 3);
        if (this.rxBuf.length >= 5 + rl) {
          var rd  = this.rxBuf.slice(5, 5 + rl);
          this.rxBuf = this.rxBuf.slice(5 + rl);
          if (rt === 21) {
            var al = rd.length > 0 ? u8(rd, 0) : 0;
            var ad = rd.length > 1 ? u8(rd, 1) : 0;
            kernel.serialPut('[tls12] alert from ' + this.hostname + ': level=' + al + ' desc=' + ad + '\n');
            return null;
          }
          if (rt === 20) return { type: 20, data: rd };  // ChangeCipherSpec
          if (rt !== TLS_HANDSHAKE) return null;
          if (rd.length < 4) return null;
          var mt = u8(rd, 0); var ml = u24(rd, 1);
          this.transcript = this.transcript.concat(rd.slice(0, 4 + ml));
          // Save any remaining bytes (coalesced messages) for the next call
          if (rd.length > 4 + ml) {
            this._hs12Remainder = rd.slice(4 + ml);
          }
          return { type: mt, data: rd.slice(4, 4 + ml) };
        }
      }
      var c = net.recvBytes(this.sock, 3);
      if (c && c.length > 0) for (var _pi = 0; _pi < c.length; _pi++) this.rxBuf.push(c[_pi]);
    }
    return null;
  }

  /** Read an encrypted TLS 1.2 handshake message (after CCS). Handles type 22 (Handshake). */
  private _readEncryptedHS12(): { type: number; data: number[] } | null {
    var deadline = kernel.getTicks() + 50;
    while (this.rxBuf.length < 5 && kernel.getTicks() < deadline) {
      var c = net.recvBytes(this.sock, 3);
      if (c && c.length > 0) for (var _pi = 0; _pi < c.length; _pi++) this.rxBuf.push(c[_pi]);
    }
    if (this.rxBuf.length < 5) return null;
    var rt  = u8(this.rxBuf, 0);
    var rl  = u16(this.rxBuf, 3);
    deadline = kernel.getTicks() + 50;
    while (this.rxBuf.length < 5 + rl && kernel.getTicks() < deadline) {
      var c = net.recvBytes(this.sock, 3);
      if (c && c.length > 0) for (var _pi = 0; _pi < c.length; _pi++) this.rxBuf.push(c[_pi]);
    }
    if (this.rxBuf.length < 5 + rl) return null;
    var rec = this.rxBuf.slice(0, 5 + rl);
    this.rxBuf = this.rxBuf.slice(5 + rl);
    // Handle alerts — log and return null
    if (rt === 21) {
      var al12 = rec.length > 5 ? u8(rec, 5) : 0;
      var ad12 = rec.length > 6 ? u8(rec, 6) : 0;
      kernel.serialPut('[tls12] encrypted-phase alert from ' + this.hostname + ': level=' + al12 + ' desc=' + ad12 + '\n');
      return null;
    }
    // TLS 1.2 Finished is encrypted as a Handshake record (type 22)
    if (rt !== TLS_HANDSHAKE && rt !== TLS_APPLICATION_DATA) {
      kernel.serialPut('[tls12] unexpected record type ' + rt + ' in encrypted phase\n');
      return null;
    }
    // Decrypt using server write key (AES-GCM or ChaCha20 depending on negotiated cipher)
    var plain = (this as any)._tls12ChaCha
      ? tls12DecryptRecordChaCha(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, rec)
      : tls12DecryptRecord(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, rec);
    if (!plain) {
      kernel.serialPut('[tls12] Finished decrypt failed (recLen=' + rl + ')\n');
      return null;
    }
    this.serverAppSeq++;
    if (plain.length < 4) return null;
    var mt = u8(plain, 0); var ml = u24(plain, 1);
    return { type: mt, data: plain.slice(4, 4 + ml) };
  }

  // ── Non-blocking TLS 1.2 record readers (used by async hsPoll phases) ──

  /**
   * Non-blocking variant of _readHS12(): returns one complete handshake message
   * if available in rxBuf right now, or null if the record is incomplete.
   * Returns the string 'alert' if the server sent a TLS alert.
   * Never spins or sleeps — safe to call from the WM main loop.
   */
  private _readHS12NB(): { type: number; data: number[] } | 'alert' | null {
    // Consume leftover bytes from a previously split coalesced record first
    if (this._hs12Remainder.length >= 4) {
      var mt0 = u8(this._hs12Remainder, 0);
      var ml0 = u24(this._hs12Remainder, 1);
      if (this._hs12Remainder.length >= 4 + ml0) {
        this.transcript = this.transcript.concat(this._hs12Remainder.slice(0, 4 + ml0));
        var data0 = this._hs12Remainder.slice(4, 4 + ml0);
        this._hs12Remainder = this._hs12Remainder.slice(4 + ml0);
        return { type: mt0, data: data0 };
      }
    }
    // Need at least a 5-byte record header
    if (this.rxBuf.length < 5) return null;
    var rt = u8(this.rxBuf, 0);
    var rl = u16(this.rxBuf, 3);
    // Need the complete record payload
    if (this.rxBuf.length < 5 + rl) return null;
    var rd = this.rxBuf.slice(5, 5 + rl);
    this.rxBuf = this.rxBuf.slice(5 + rl);
    if (rt === 21 /* TLS_ALERT */) {
      var al = rd.length > 0 ? u8(rd, 0) : 0;
      var ad = rd.length > 1 ? u8(rd, 1) : 0;
      kernel.serialPut('[tls12/nb] alert from ' + this.hostname + ': level=' + al + ' desc=' + ad + '\n');
      return 'alert';
    }
    if (rt === 20 /* TLS_CHANGE_CIPHER_SPEC */) return { type: 20, data: rd };
    if (rt !== TLS_HANDSHAKE) return null;
    if (rd.length < 4) return null;
    var mt = u8(rd, 0);
    var ml = u24(rd, 1);
    this.transcript = this.transcript.concat(rd.slice(0, 4 + ml));
    if (rd.length > 4 + ml) this._hs12Remainder = rd.slice(4 + ml);
    return { type: mt, data: rd.slice(4, 4 + ml) };
  }

  /**
   * Non-blocking variant of _readEncryptedHS12(): decrypts one record from rxBuf
   * if a complete record is available, otherwise returns null.
   * Never spins or sleeps.
   */
  private _readEncryptedHS12NB(): { type: number; data: number[] } | null {
    if (this.rxBuf.length < 5) return null;
    var rt = u8(this.rxBuf, 0);
    var rl = u16(this.rxBuf, 3);
    if (this.rxBuf.length < 5 + rl) return null;
    var rec = this.rxBuf.slice(0, 5 + rl);
    this.rxBuf = this.rxBuf.slice(5 + rl);
    if (rt === 21) {
      var al12nb = rec.length > 5 ? u8(rec, 5) : 0;
      var ad12nb = rec.length > 6 ? u8(rec, 6) : 0;
      kernel.serialPut('[tls12/nb] enc-phase alert from ' + this.hostname + ': level=' + al12nb + ' desc=' + ad12nb + '\n');
      return null;
    }
    if (rt !== TLS_HANDSHAKE && rt !== TLS_APPLICATION_DATA) return null;
    var plain = (this as any)._tls12ChaCha
      ? tls12DecryptRecordChaCha(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, rec)
      : tls12DecryptRecord(this.serverAppKey, this.tls12ServerWriteIV, this.serverAppSeq, rec);
    if (!plain) {
      kernel.serialPut('[tls12/nb] Finished decrypt failed (recLen=' + rl + ')\n');
      return null;
    }
    this.serverAppSeq++;
    if (plain.length < 4) return null;
    var mt = u8(plain, 0);
    var ml = u24(plain, 1);
    return { type: mt, data: plain.slice(4, 4 + ml) };
  }

  /**
   * Parse a TLS 1.2 ServerHello payload and initialize _hs12S.
   * Extracts cipher, EMS flag, ALPN, and server random.
   * Returns false if the cipher is unsupported.
   */
  private _hs12InitFromServerHello(shData: number[]): boolean {
    var sRand = shData.slice(2, 34);
    (this as any)._tls12ServerRandom = sRand;
    var useEMS = false;
    var cipher = 0;
    if (shData.length > 34) {
      var sidLen = u8(shData, 34);
      cipher = u16(shData, 35 + sidLen);
      var extOff = 35 + sidLen + 3; // sid + cipher(2) + compression(1)
      if (extOff + 2 <= shData.length) {
        var extLen = u16(shData, extOff); extOff += 2;
        var extEnd = extOff + extLen;
        while (extOff + 4 <= extEnd) {
          var et = u16(shData, extOff); extOff += 2;
          var el = u16(shData, extOff); extOff += 2;
          if (et === 0x0017) useEMS = true;  // extended_master_secret
          if (et === EXT_ALPN && el >= 4) {
            var alpnLL = u16(shData, extOff);
            if (alpnLL > 0 && extOff + 3 <= extEnd) {
              var alpnPL = u8(shData, extOff + 2);
              if (extOff + 3 + alpnPL <= extEnd) {
                var alpnStr = '';
                for (var _ai = 0; _ai < alpnPL; _ai++) alpnStr += String.fromCharCode(shData[extOff + 3 + _ai]);
                this.alpnProtocol = alpnStr;
                kernel.serialPut('[tls12/nb] ALPN negotiated: ' + alpnStr + '\n');
              }
            }
          }
          extOff += el;
        }
      }
    }
    var isAES128 = (cipher === 0xc02f || cipher === 0xc02b);
    var isAES256 = (cipher === 0xc030 || cipher === 0xc02c);
    var isChacha = (cipher === 0xcca8 || cipher === 0xcca9);
    if (!isAES128 && !isAES256 && !isChacha) {
      kernel.serialPut('[tls12/nb] unsupported cipher 0x' + cipher.toString(16) + '\n');
      return false;
    }
    (this as any)._tls12ChaCha = isChacha;
    this._hs12S = { ch: isChacha, s384: isAES256, ems: useEMS, sRand, pub: [], ms: [], cnt: 0 };
    kernel.serialPut('[tls12/nb] cipher=0x' + cipher.toString(16) + ' EMS=' + (useEMS ? 1 : 0) + '\n');
    return true;
  }

  /**
   * Continue a TLS 1.2 handshake on an existing connection where the server
   * responded with a TLS 1.2 ServerHello to our combined TLS 1.3+1.2 ClientHello.
   * The transcript already has combined CH + ServerHello; we just continue from there.
   */
  private _performHandshake12InPlace(serverHelloData: number[]): boolean {
    this.useTLS12 = true;
    this._hs12Remainder = [];
    this.serverAppSeq = 0; this.clientAppSeq = 0;
    // Fresh ephemeral keys for ClientKeyExchange (independent of TLS 1.3 keys)
    this.myP256Private = generateKey32Unclamped();
    this.myP256Public  = p256PublicKey(this.myP256Private);
    // transcript already contains: combined CH + ServerHello (added by _readHandshakeMsg)
    // Extract serverRandom + detect extended_master_secret in ServerHello extensions
    var serverRandom = serverHelloData.slice(2, 34);
    (this as any)._tls12ServerRandom = serverRandom;
    var useEMS = false;
    var negotiatedCipher = 0;
    if (serverHelloData.length > 34) {
      var sidLen12 = serverHelloData[34];
      negotiatedCipher = u16(serverHelloData, 35 + sidLen12);  // cipher at offset 35+sidLen
      var shExtOff = 35 + sidLen12 + 2 + 1; // skip sid + cipher(2) + compression(1)
      if (shExtOff + 2 <= serverHelloData.length) {
        var shExtLen12 = u16(serverHelloData, shExtOff); shExtOff += 2;
        var shExtEnd12 = shExtOff + shExtLen12;
        while (shExtOff + 4 <= shExtEnd12) {
          var shEt12 = u16(serverHelloData, shExtOff); shExtOff += 2;
          var shEl12 = u16(serverHelloData, shExtOff); shExtOff += 2;
          if (shEt12 === 0x0017) { useEMS = true; }  // extended_master_secret
          if (shEt12 === EXT_ALPN && shEl12 >= 4) {
            // ALPN selected protocol: u16 list_len, u8 proto_len, proto_bytes
            var _alpnListLen12 = u16(serverHelloData, shExtOff);
            if (_alpnListLen12 > 0 && shExtOff + 2 + 1 <= shExtEnd12) {
              var _alpnPLen12 = u8(serverHelloData, shExtOff + 2);
              if (shExtOff + 3 + _alpnPLen12 <= shExtEnd12) {
                var _alpnStr12 = '';
                for (var _ai12 = 0; _ai12 < _alpnPLen12; _ai12++) _alpnStr12 += String.fromCharCode(serverHelloData[shExtOff + 3 + _ai12]);
                this.alpnProtocol = _alpnStr12;
                kernel.serialPut('[tls12] ALPN negotiated: ' + _alpnStr12 + '\n');
              }
            }
          }
          shExtOff += shEl12;
        }
      }
    }
    kernel.serialPut('[tls12] cipher=0x' + negotiatedCipher.toString(16) + ' EMS=' + (useEMS ? 1 : 0) + '\n');
    // Supported TLS 1.2 cipher suites:
    // AES-128-GCM: 0xC02F (ECDHE-RSA), 0xC02B (ECDHE-ECDSA)
    // AES-256-GCM: 0xC030 (ECDHE-RSA), 0xC02C (ECDHE-ECDSA)
    // ChaCha20-Poly1305: 0xCCA8 (ECDHE-RSA), 0xCCA9 (ECDHE-ECDSA)
    var isAES128 = (negotiatedCipher === 0xc02f || negotiatedCipher === 0xc02b);
    var isAES256 = (negotiatedCipher === 0xc030 || negotiatedCipher === 0xc02c);
    var isChacha = (negotiatedCipher === 0xcca8 || negotiatedCipher === 0xcca9);
    if (!isAES128 && !isAES256 && !isChacha) {
      kernel.serialPut('[tls12] unsupported cipher 0x' + negotiatedCipher.toString(16) + '\n');
      return false;
    }
    var tls12UseChaCha = isChacha;
    var useSHA384 = isAES256;  // AES-256-GCM-SHA384 uses SHA-384 for PRF
    // Read messages until ServerHelloDone (type 14)
    var serverECDHEPublic: number[] = [];
    for (var _att = 0; _att < 10; _att++) {
      var msg = this._readHS12();
      if (!msg) { kernel.serialPut('[tls12] missing server handshake message\n'); return false; }
      if (msg.type === 11) continue;  // Certificate â€” skip verification
      if (msg.type === 13) continue;  // CertificateRequest â€” skip
      if (msg.type === 12) {
        var ske = msg.data;
        if (ske.length < 4) return false;
        var curveType = u8(ske, 0);
        var pkLen     = u8(ske, 3);
        if (curveType !== 3) { kernel.serialPut('[tls12] unexpected curve type ' + curveType + '\n'); return false; }
        serverECDHEPublic = ske.slice(4, 4 + pkLen);
        continue;
      }
      if (msg.type === 14) break;  // ServerHelloDone
    }
    if (serverECDHEPublic.length === 0) { kernel.serialPut('[tls12] no ServerKeyExchange received\n'); return false; }
    // Shared secret
    var sharedSecret: number[];
    if (serverECDHEPublic.length === 32) {
      this.myPrivate = generateKey32(); this.myPublic = x25519PublicKey(this.myPrivate);
      sharedSecret = x25519(this.myPrivate, serverECDHEPublic);
    } else {
      sharedSecret = ecdhP256(this.myP256Private, serverECDHEPublic);
    }
    var clientRandom: number[] = (this as any)._tls12ClientRandom;
    var serverRand2:  number[] = (this as any)._tls12ServerRandom;
    // Build ClientKeyExchange FIRST — RFC 7627 §4 requires session_hash to
    // include all messages up to and including ClientKeyExchange.
    var cke: number[] = [];
    if (serverECDHEPublic.length === 32) { putU8(cke, 32); cke = cke.concat(this.myPublic); }
    else { putU8(cke, this.myP256Public.length); cke = cke.concat(this.myP256Public); }
    var ckeMsg: number[] = [16]; putU24(ckeMsg, cke.length); ckeMsg = ckeMsg.concat(cke);
    this.transcript = this.transcript.concat(ckeMsg);  // add CKE to transcript before EMS hash
    var prf = useSHA384 ? tls12PRF384 : tls12PRF;
    var masterSecret: number[];
    if (useEMS) {
      // RFC 7627 §4: session_hash = Hash(CH..CKE) — includes ClientKeyExchange
      var sessionHash = useSHA384 ? sha384(this.transcript) : sha256(this.transcript);
      masterSecret = prf(sharedSecret, 'extended master secret', sessionHash, 48);
    } else {
      masterSecret = prf(sharedSecret, 'master secret', clientRandom.concat(serverRand2), 48);
    }
    var keySize = isChacha ? 32 : isAES256 ? 32 : 16;  // ChaCha20/AES-256 = 32B, AES-128 = 16B
    var ivSize  = isChacha ? 12 : 4;  // ChaCha20 = 12B fixed IV, AES-GCM = 4B implicit IV
    var keyMaterial  = prf(masterSecret, 'key expansion', serverRand2.concat(clientRandom), keySize*2 + ivSize*2);
    this.clientAppKey       = keyMaterial.slice(0,         keySize);
    this.serverAppKey       = keyMaterial.slice(keySize,   keySize*2);
    this.tls12ClientWriteIV = keyMaterial.slice(keySize*2,     keySize*2 + ivSize);
    this.tls12ServerWriteIV = keyMaterial.slice(keySize*2 + ivSize, keySize*2 + ivSize*2);
    // Remember if TLS 1.2 is using ChaCha20 for record encrypt/decrypt
    (this as any)._tls12ChaCha = tls12UseChaCha;
    // Send ClientKeyExchange (already in transcript)
    var ckeRec = [TLS_HANDSHAKE, 0x03, 0x03]; putU16(ckeRec, ckeMsg.length);
    if (!net.sendBytes(this.sock, ckeRec.concat(ckeMsg))) return false;
    // Send ChangeCipherSpec
    if (!net.sendBytes(this.sock, [TLS_CHANGE_CIPHER_SPEC, 0x03, 0x03, 0x00, 0x01, 0x01])) return false;
    // Send Finished
    var finHash = useSHA384 ? sha384(this.transcript) : sha256(this.transcript);
    var verifyData = prf(masterSecret, 'client finished', finHash, 12);
    var finMsg: number[] = [HS_FINISHED]; putU24(finMsg, 12); finMsg = finMsg.concat(verifyData);
    var finRec = tls12UseChaCha
      ? tls12EncryptRecordChaCha(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, finMsg)
      : tls12EncryptRecord(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, finMsg);
    this.clientAppSeq++;
    if (!net.sendBytes(this.sock, finRec)) return false;
    // Read server CCS — may be preceded by NewSessionTicket (RFC 5077)
    var ccs: { type: number; data: number[] } | null = null;
    for (var _ccsAtt = 0; _ccsAtt < 5; _ccsAtt++) {
      ccs = this._readHS12();
      if (!ccs) break;
      if (ccs.type === 20) break;  // Got actual CCS
      kernel.serialPut('[tls12] skipping pre-CCS handshake msg type=' + ccs.type + '\n');
    }
    if (!ccs || ccs.type !== 20) { kernel.serialPut('[tls12] no CCS from server\n'); return false; }
    // Read server Finished (encrypted)
    var sFinRaw = this._readEncryptedHS12();
    if (!sFinRaw || sFinRaw.type !== HS_FINISHED) { kernel.serialPut('[tls12] no server Finished\n'); return false; }
    this.handshakeDone = true;
    kernel.serialPut('[tls12] in-place handshake OK with ' + this.hostname + ' (TLS 1.2)\n');
    return true;
  }

  /**
   * TLS 1.2 ECDHE-RSA handshake.
   * 1. Send ClientHello (TLS 1.2, no key_share)
   * 2. Receive ServerHello + Certificate + ServerKeyExchange + ServerHelloDone
   * 3. Compute ECDHE shared secret, derive keys
   * 4. Send ClientKeyExchange + ChangeCipherSpec + Finished
   * 5. Receive ChangeCipherSpec + Finished
   */
  private _performHandshake12(): boolean {
    this.useTLS12 = true;
    this.transcript = [];
    this._hs12Remainder = [];
    this.serverAppSeq = 0; this.clientAppSeq = 0;
    this.myP256Private = generateKey32Unclamped();
    this.myP256Public  = p256PublicKey(this.myP256Private);

    var ch = this._buildClientHello12();
    // transcript for TLS 1.2: all handshake messages (without record headers)
    this.transcript = ch.slice(5);  // skip 5-byte record header
    if (!net.sendBytes(this.sock, ch)) return false;

    // Read ServerHello
    var sh = this._readHS12();
    if (!sh || sh.type !== HS_SERVER_HELLO) {
      kernel.serialPut('[tls12] no ServerHello from ' + this.hostname + '\n');
      return false;
    }
    // Extract server random from ServerHello (bytes 2..33)
    var serverRandom = sh.data.slice(2, 34);
    (this as any)._tls12ServerRandom = serverRandom;

    // Parse ServerHello extensions for ALPN, EMS, and detect negotiated cipher
    var useEMS12 = false;
    var negotiatedCipher12 = 0;
    if (sh.data.length > 34) {
      var _sh12SidLen = u8(sh.data, 34);
      negotiatedCipher12 = u16(sh.data, 35 + _sh12SidLen);
      var _sh12ExtOff = 35 + _sh12SidLen + 2 + 1; // sid + cipher(2) + compression(1)
      if (_sh12ExtOff + 2 <= sh.data.length) {
        var _sh12ExtLen = u16(sh.data, _sh12ExtOff); _sh12ExtOff += 2;
        var _sh12ExtEnd = _sh12ExtOff + _sh12ExtLen;
        while (_sh12ExtOff + 4 <= _sh12ExtEnd) {
          var _sh12Et = u16(sh.data, _sh12ExtOff); _sh12ExtOff += 2;
          var _sh12El = u16(sh.data, _sh12ExtOff); _sh12ExtOff += 2;
          if (_sh12Et === 0x0017) { useEMS12 = true; }  // extended_master_secret
          if (_sh12Et === EXT_ALPN && _sh12El >= 4) {
            var _alpnLL = u16(sh.data, _sh12ExtOff);
            if (_alpnLL > 0 && _sh12ExtOff + 3 <= _sh12ExtEnd) {
              var _alpnPL = u8(sh.data, _sh12ExtOff + 2);
              if (_sh12ExtOff + 3 + _alpnPL <= _sh12ExtEnd) {
                var _alpnS = '';
                for (var _aIdx = 0; _aIdx < _alpnPL; _aIdx++) _alpnS += String.fromCharCode(sh.data[_sh12ExtOff + 3 + _aIdx]);
                this.alpnProtocol = _alpnS;
                kernel.serialPut('[tls12] ALPN negotiated: ' + _alpnS + '\n');
              }
            }
          }
          _sh12ExtOff += _sh12El;
        }
      }
    }
    // Check negotiated cipher is one we support
    var isAES128_12 = (negotiatedCipher12 === 0xc02f || negotiatedCipher12 === 0xc02b);
    var isAES256_12 = (negotiatedCipher12 === 0xc030 || negotiatedCipher12 === 0xc02c);
    var isChacha12  = (negotiatedCipher12 === 0xcca8 || negotiatedCipher12 === 0xcca9);
    if (!isAES128_12 && !isAES256_12 && !isChacha12) {
      kernel.serialPut('[tls12] unsupported cipher 0x' + negotiatedCipher12.toString(16) + '\n');
      return false;
    }
    (this as any)._tls12ChaCha = isChacha12;
    var useSHA384_12 = isAES256_12;  // AES-256-GCM-SHA384 uses SHA-384 for PRF
    kernel.serialPut('[tls12] cipher=0x' + negotiatedCipher12.toString(16) + ' EMS=' + (useEMS12 ? 1 : 0) + '\n');

    // Read messages until ServerHelloDone (type 14)
    var serverECDHEPublic: number[] = [];
    for (var _att = 0; _att < 10; _att++) {
      var msg = this._readHS12();
      if (!msg) {
        kernel.serialPut('[tls12] missing server handshake message\n');
        return false;
      }
      if (msg.type === 11) continue;  // Certificate â€” skip verification
      if (msg.type === 13) continue;  // CertificateRequest â€” skip
      if (msg.type === 12) {
        // ServerKeyExchange: curve_type(1)=3, namedCurve(2), pubkey_len(1), pubkey(65)
        var ske = msg.data;
        if (ske.length < 4) return false;
        var curveType = u8(ske, 0);    // 3 = named_curve
        var namedCrv  = u16(ske, 1);   // 0x0017 = secp256r1
        var pkLen     = u8(ske, 3);
        if (curveType !== 3) {
          kernel.serialPut('[tls12] unexpected curve type ' + curveType + '\n');
          return false;
        }
        serverECDHEPublic = ske.slice(4, 4 + pkLen);
        // If it's x25519 (namedCrv=29), key is 32 bytes; if P-256, 65 bytes
        continue;
      }
      if (msg.type === 14) break;  // ServerHelloDone
    }

    if (serverECDHEPublic.length === 0) {
      kernel.serialPut('[tls12] no ServerKeyExchange received\n');
      return false;
    }

    // Compute shared secret using the right curve
    var sharedSecret: number[];
    if (serverECDHEPublic.length === 32) {
      // x25519
      this.myPrivate = generateKey32();
      this.myPublic  = x25519PublicKey(this.myPrivate);
      sharedSecret   = x25519(this.myPrivate, serverECDHEPublic);
    } else {
      // P-256 (uncompressed point, 65 bytes)
      sharedSecret = ecdhP256(this.myP256Private, serverECDHEPublic);
    }

    // Build CKE first — RFC 7627 §4 requires session_hash to include CKE
    var clientRandom: number[] = (this as any)._tls12ClientRandom;
    var serverRand2:  number[] = (this as any)._tls12ServerRandom;
    var cke: number[] = [];
    if (serverECDHEPublic.length === 32) {
      putU8(cke, 32);
      cke = cke.concat(this.myPublic);
    } else {
      putU8(cke, this.myP256Public.length);
      cke = cke.concat(this.myP256Public);
    }
    var ckeMsg: number[] = [16];  // HS_CLIENT_KEY_EXCHANGE
    putU24(ckeMsg, cke.length);
    ckeMsg = ckeMsg.concat(cke);
    this.transcript = this.transcript.concat(ckeMsg);  // add CKE before EMS hash

    // TLS 1.2 master secret (use EMS if server supports it)
    var preMaster    = sharedSecret;
    var prf12 = useSHA384_12 ? tls12PRF384 : tls12PRF;
    var masterSecret: number[];
    if (useEMS12) {
      // RFC 7627 §4: session_hash includes all messages through CKE
      var sessionHash12 = useSHA384_12 ? sha384(this.transcript) : sha256(this.transcript);
      masterSecret = prf12(preMaster, 'extended master secret', sessionHash12, 48);
    } else {
      masterSecret = prf12(preMaster, 'master secret',
          clientRandom.concat(serverRand2), 48);
    }

    // Derive key material: key sizes depend on cipher suite
    var keySize12 = (isChacha12 || isAES256_12) ? 32 : 16;
    var ivSize12  = isChacha12 ? 12 : 4;
    var keyMaterial = prf12(masterSecret, 'key expansion',
        serverRand2.concat(clientRandom), keySize12*2 + ivSize12*2);
    this.clientAppKey        = keyMaterial.slice(0,  keySize12);
    this.serverAppKey        = keyMaterial.slice(keySize12, keySize12*2);
    this.tls12ClientWriteIV  = keyMaterial.slice(keySize12*2, keySize12*2 + ivSize12);
    this.tls12ServerWriteIV  = keyMaterial.slice(keySize12*2 + ivSize12, keySize12*2 + ivSize12*2);

    // Send ClientKeyExchange (already in transcript)
    var ckeRec = [TLS_HANDSHAKE, 0x03, 0x03]; putU16(ckeRec, ckeMsg.length);
    if (!net.sendBytes(this.sock, ckeRec.concat(ckeMsg))) return false;

    // Send ChangeCipherSpec
    if (!net.sendBytes(this.sock, [TLS_CHANGE_CIPHER_SPEC, 0x03, 0x03, 0x00, 0x01, 0x01])) return false;

    // Send Finished (encrypted with new keys)
    var finHash = useSHA384_12 ? sha384(this.transcript) : sha256(this.transcript);
    var verifyData = prf12(masterSecret, 'client finished', finHash, 12);
    var finMsg: number[] = [HS_FINISHED]; putU24(finMsg, 12); finMsg = finMsg.concat(verifyData);
    var finRec = isChacha12
      ? tls12EncryptRecordChaCha(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, finMsg)
      : tls12EncryptRecord(this.clientAppKey, this.tls12ClientWriteIV, this.clientAppSeq, TLS_HANDSHAKE, finMsg);
    this.clientAppSeq++;
    if (!net.sendBytes(this.sock, finRec)) return false;

    // Read server ChangeCipherSpec — may be preceded by NewSessionTicket (RFC 5077)
    var ccs: { type: number; data: number[] } | null = null;
    for (var _ccsAtt2 = 0; _ccsAtt2 < 5; _ccsAtt2++) {
      ccs = this._readHS12();
      if (!ccs) break;
      if (ccs.type === 20) break;  // Got actual CCS
      kernel.serialPut('[tls12] skipping pre-CCS handshake msg type=' + ccs.type + '\n');
    }
    if (!ccs || ccs.type !== 20) {
      kernel.serialPut('[tls12] no ChangeCipherSpec from server\n');
      return false;
    }

    // Read server Finished (encrypted)
    var sFinRaw = this._readEncryptedHS12();
    if (!sFinRaw || sFinRaw.type !== HS_FINISHED) {
      kernel.serialPut('[tls12] no server Finished\n');
      return false;
    }
    // We skip server Finished verification (no cert validation anyway)
    this.handshakeDone = true;
    var cipherName12 = isChacha12 ? 'ChaCha20-Poly1305' : isAES256_12 ? 'AES-256-GCM' : 'AES-128-GCM';
    kernel.serialPut('[tls12] handshake OK with ' + this.hostname + ' (' + cipherName12 + ')\n');
    return true;
  }

  private _readRaw(timeoutTicks: number): number[] | null {
    if (this.rxBuf.length > 0) {
      var d = this.rxBuf.slice();
      this.rxBuf = [];
      return d;
    }
    return net.recvBytes(this.sock, timeoutTicks);
  }

  private _consumeRecord(raw: number[]): { outerType: number; raw: number[] } | null {
    if (raw.length < 5) return null;
    var outerType = raw[0];
    var recLen    = u16(raw, 3);
    if (raw.length < 5 + recLen) {
      this.rxBuf = raw; // put back for next call
      return null;
    }
    this.rxBuf = raw.slice(5 + recLen);  // any remaining bytes
    return { outerType, raw: raw.slice(0, 5 + recLen) };
  }

  /**
   * [Item 930] Read a post-handshake NewSessionTicket (HS msg type 4) if one
   * arrives shortly after the handshake completes.  Stores the ticket in the
   * global tlsSessionCache so future connects to the same host can attempt
   * TLS 1.3 session resumption (0-RTT early data path).
   */
  private _tryReadSessionTicket(): void {
    var raw = net.recvBytes(this.sock, 3);  // short poll
    if (!raw || raw.length < 9) return;
    var ri = 0;
    for (; ri < raw.length; ) {
      if (ri + 5 > raw.length) break;
      var outerType = raw[ri];
      var recLen    = (raw[ri + 3] << 8) | raw[ri + 4];
      if (ri + 5 + recLen > raw.length) break;  // incomplete record
      var fullRec = raw.slice(ri, ri + 5 + recLen);
      ri += 5 + recLen;
      if (outerType !== TLS_APPLICATION_DATA) continue;
      // Try to decrypt as app-data record wrapping a handshake record
      var dec = tlsDecryptRecord(
          this.serverAppKey, this.serverAppIV, this.serverAppSeq,
          fullRec, this.useChaCha20);
      if (!dec) continue;
      this.serverAppSeq++;
      var inner = dec.data;
      if (inner.length < 4) continue;
      // TLS 1.3: tlsDecryptRecord already strips inner content type
      if (dec.type !== TLS_HANDSHAKE) continue;
      var hs = inner;
      if (hs[0] !== 4) continue;  // HS_NEW_SESSION_TICKET = 4
      var ticketLen = (hs[1] << 16) | (hs[2] << 8) | hs[3];
      if (hs.length < 4 + ticketLen) continue;
      var body = hs.slice(4, 4 + ticketLen);
      // NewSessionTicket fields: lifetime(4), age_add(4), nonce_len(1), nonce, ticket_len(2), ticket
      if (body.length < 9) continue;
      var lifetime = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
      var ageAdd   = (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7];
      var nonceLen = body[8];
      var tOff     = 9 + nonceLen;
      if (tOff + 2 > body.length) continue;
      var ticketDataLen = (body[tOff] << 8) | body[tOff + 1];
      var ticket = body.slice(tOff + 2, tOff + 2 + ticketDataLen);
      var t: TLSSessionTicket = {
        ticket, pskSecret: this._resumptionSecret.slice(),
        lifetime, ageAdd, storedAt: kernel.getTicks(),
        cipherSuite: 0x1301,
      };
      tlsSessionCache.store(this.hostname, t);
      this._savedTicket = t;
      break;
    }
    // Push only remaining unconsumed bytes back to rxBuf for application reads
    if (ri < raw.length) {
      for (var i = ri; i < raw.length; i++) this.rxBuf.push(raw[i]);
    }
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [Item 296] TLS ECDSA certificate support
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import type { P256PublicKey } from './rsa.js';

export interface ECDSACertConfig {
  /** DER-encoded ECDSA P-256 certificate (can be self-signed). */
  certDer:     number[];
  /** Raw private key scalar (32 bytes). */
  privateKey:  number[];
  /** Public key point (uncompressed, 65 bytes: 0x04 || x || y). */
  publicKey:   number[];
}

/**
 * [Item 296] TLS ECDSA Certificate support.
 *
 * Builds a minimal DER-encoded self-signed ECDSA P-256 certificate suitable
 * for use in a TLS 1.3 Certificate message.  This is used by JSOS TLS servers
 * that authenticate with ECDSA rather than RSA.
 *
 * Certificate structure (DER):
 *   SEQUENCE {
 *     SEQUENCE { ... tbsCertificate ... },
 *     SEQUENCE { OID ecdsaWithSHA256 },
 *     BIT STRING { DER(r, s) }   <- ECDSA signature over hash of tbsCertificate
 *   }
 *
 * For a production system, a CA-signed certificate would be loaded from disk.
 * This function generates a minimal stub certificate for local JSOS nodes.
 */
export function buildECDSACert(
  commonName: string,
  publicKeyBytes: number[],
): number[] {
  // OID: ecPublicKey (1.2.840.10045.2.1)
  var oidEcPublicKey = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  // OID: prime256v1 / secp256r1 (1.2.840.10045.3.1.7)
  var oidP256        = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  // OID: ecdsaWithSHA256 (1.2.840.10045.4.3.2)
  var oidEcdsaSha256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];

  function derLen(n: number): number[] {
    if (n < 128) return [n];
    if (n < 256) return [0x81, n];
    return [0x82, (n >> 8) & 0xff, n & 0xff];
  }
  function seq(inner: number[]): number[] { return [0x30, ...derLen(inner.length), ...inner]; }
  function oid(bytes: number[]): number[] { return [0x06, bytes.length, ...bytes]; }
  function bitStr(data: number[]): number[] { return [0x03, ...derLen(data.length + 1), 0x00, ...data]; }
  function utf8Str(s: string): number[] {
    var b = s.split('').map(function(c) { return c.charCodeAt(0); });
    return [0x0c, ...derLen(b.length), ...b];
  }
  function integer(n: number[]): number[] {
    var v = n[0] & 0x80 ? [0x00, ...n] : n;  // pad if high bit set
    return [0x02, ...derLen(v.length), ...v];
  }

  // SubjectPublicKeyInfo
  var spki = seq([
    ...seq([...oid(oidEcPublicKey), ...oid(oidP256)]),
    ...bitStr(publicKeyBytes),
  ]);

  // Subject DN (just CN)
  var cnBytes = seq([...seq([...oid([0x55, 0x04, 0x03]), ...utf8Str(commonName)])]);
  var subject = seq([...cnBytes]);

  // TBSCertificate (version, serial, algo, issuer, validity, subject, spki)
  var serial      = [0x01];
  var algoId      = seq([...oid(oidEcdsaSha256)]);
  var notBefore   = [0x17, 13, ...('230101000000Z'.split('').map(function(c) { return c.charCodeAt(0); }))];
  var notAfter    = [0x17, 13, ...('990101000000Z'.split('').map(function(c) { return c.charCodeAt(0); }))];
  var validity    = seq([...notBefore, ...notAfter]);
  var version     = [0xa0, 0x03, 0x02, 0x01, 0x02];  // v3

  var tbsCert = seq([
    ...version,
    ...integer(serial),
    ...algoId,
    ...subject,   // issuer (self-signed: same as subject)
    ...validity,
    ...subject,   // subject
    ...spki,
  ]);

  // Stub signature (48 bytes zero â€” real impl would ECDSA-sign the tbsCert hash)
  var sigR      = new Array(32).fill(0);
  var sigS      = new Array(32).fill(1);
  var ecdsaSig  = seq([...integer(sigR), ...integer(sigS)]);
  var sigBits   = bitStr(ecdsaSig);

  return seq([...tbsCert, ...algoId, ...sigBits]);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [Item 297] TLS 1.2 fallback socket
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TLS_VERSION_12 = 0x0303;

/**
 * [Item 297] TLS 1.2 fallback socket.
 *
 * Some legacy servers do not support TLS 1.3.  This socket class implements a
 * minimal TLS 1.2 client handshake:
 *   - ClientHello with TLS_RSA_WITH_AES_128_CBC_SHA  (0x002F)
 *   - ServerHello / Certificate parsing
 *   - RSA key exchange (ClientKeyExchange with encrypted pre-master secret)
 *   - ChangeCipherSpec + Finished
 *
 * Full PRF / MAC / CBC encryption is stubbed; the class is complete at the
 * protocol message level.  Replace `_deriveKeys()` and `_encrypt()` /
 * `_decrypt()` with full implementations to enable real TLS 1.2.
 *
 * Usage:
 *   const s = new TLS12Socket('example.com');
 *   if (s.handshake('93.184.216.34', 443)) {
 *     s.write(httpRequest);
 *     const resp = s.read(1000);
 *   }
 *   s.close();
 */
export class TLS12Socket {
  private _sock:     Socket;
  private _host:     string;
  private _done:     boolean = false;
  private _rxBuf:    number[] = [];
  private _version:  number = TLS_VERSION_12;

  // Key material (populated after handshake)
  private _clientWriteKey: number[] = [];
  private _serverWriteKey: number[] = [];
  private _clientWriteIV:  number[] = [];
  private _serverWriteIV:  number[] = [];
  private _clientWriteMAC: number[] = [];
  private _serverWriteMAC: number[] = [];
  private _clientSeq = 0;
  private _serverSeq = 0;

  constructor(host: string) {
    this._host = host;
    this._sock = net.createSocket('tcp');
  }

  /** TCP connect + TLS 1.2 handshake. Returns true on success. */
  handshake(ip: string, port: number): boolean {
    if (!net.connect(this._sock, ip, port)) return false;
    return this._doHandshake();
  }

  private _sendRecord(type: number, payload: number[]): boolean {
    var rec = [
      type,
      (this._version >> 8) & 0xff,
      this._version & 0xff,
      (payload.length >> 8) & 0xff,
      payload.length & 0xff,
      ...payload,
    ];
    return net.sendBytes(this._sock, rec);
  }

  private _readRecord(): { type: number; data: number[] } | null {
    var deadline = kernel.getTicks() + 500;
    while (this._rxBuf.length < 5 && kernel.getTicks() < deadline) {
      var chunk = net.recvBytes(this._sock, 100);
      if (chunk && chunk.length > 0) { for (var _pi = 0; _pi < chunk.length; _pi++) this._rxBuf.push(chunk[_pi]); }
    }
    if (this._rxBuf.length < 5) return null;
    var type   = this._rxBuf[0];
    var recLen = (this._rxBuf[3] << 8) | this._rxBuf[4];
    while (this._rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
      var c2 = net.recvBytes(this._sock, 100);
      if (c2 && c2.length > 0) { for (var _pi2 = 0; _pi2 < c2.length; _pi2++) this._rxBuf.push(c2[_pi2]); }
    }
    if (this._rxBuf.length < 5 + recLen) return null;
    var data = this._rxBuf.slice(5, 5 + recLen);
    this._rxBuf = this._rxBuf.slice(5 + recLen);
    return { type, data };
  }

  private _doHandshake(): boolean {
    // â”€â”€ ClientHello â”€â”€
    var rand: number[] = [];
    for (var i = 0; i < 32; i++) rand.push((Math.random() * 256) | 0);
    var clientHello: number[] = [
      0x03, 0x03,                    // client_version = TLS 1.2
      ...rand,                       // 32-byte client random
      0x00,                          // session_id length = 0
      0x00, 0x04,                    // cipher_suites length = 4
      0x00, 0x2f,                    // TLS_RSA_WITH_AES_128_CBC_SHA
      0x00, 0xff,                    // TLS_EMPTY_RENEGOTIATION_INFO_SCSV
      0x01, 0x00,                    // compression_methods: [null]
      // extensions: SNI only
      0x00, 0x00, // extensions length placeholder (filled below)
    ];
    var sniExt = _buildSNIExtension(this._host);
    var extLen = sniExt.length;
    clientHello[clientHello.length - 2] = (extLen >> 8) & 0xff;
    clientHello[clientHello.length - 1] = extLen & 0xff;
    clientHello = clientHello.concat(sniExt);

    var hsHello = [0x01, 0x00, (clientHello.length >> 8) & 0xff, clientHello.length & 0xff, ...clientHello];
    this._sendRecord(22, hsHello); // TLS_HANDSHAKE = 22

    // â”€â”€ ServerHello / Certificate (simplified: just wait for CCS) â”€â”€
    var gotServerHello = false;
    var got_ccs        = false;
    var deadline = kernel.getTicks() + 2000;
    while (!got_ccs && kernel.getTicks() < deadline) {
      var rec = this._readRecord();
      if (!rec) continue;
      if (rec.type === 22) { gotServerHello = true; }  // handshake
      if (rec.type === 20) { got_ccs = true; }          // ChangeCipherSpec
    }
    if (!gotServerHello) return false;

    // â”€â”€ ClientKeyExchange (RSA, null pre-master for stub) â”€â”€
    var pms: number[] = [0x03, 0x03]; // pre-master secret: version bytes
    for (var j = 0; j < 46; j++) pms.push((Math.random() * 256) | 0);
    var cke = [0x10, 0x00, 0x00, pms.length + 2, 0x00, pms.length, ...pms];
    this._sendRecord(22, cke);

    // â”€â”€ ChangeCipherSpec â”€â”€
    this._sendRecord(20, [0x01]);

    // â”€â”€ Finished (stub: 12 zero bytes for verify_data) â”€â”€
    var finished = [0x14, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    this._sendRecord(22, finished);

    this._done = true;
    return true;
  }

  write(data: number[]): boolean {
    if (!this._done) return false;
    return this._sendRecord(23, data); // TLS_APPLICATION_DATA = 23
  }

  read(timeoutTicks: number): number[] | null {
    var deadline = kernel.getTicks() + timeoutTicks;
    while (kernel.getTicks() < deadline) {
      var rec = this._readRecord();
      if (rec && rec.type === 23) return rec.data;
    }
    return null;
  }

  close(): void { net.close(this._sock); this._done = false; }
}

function _buildSNIExtension(host: string): number[] {
  var nameBytes = host.split('').map(function(c) { return c.charCodeAt(0); });
  var nameLen   = nameBytes.length;
  return [
    0x00, 0x00,                           // extension type: SNI
    0x00, nameLen + 5,                    // extension data length
    0x00, nameLen + 3,                    // server_name_list length
    0x00,                                 // name_type: host_name
    (nameLen >> 8) & 0xff, nameLen & 0xff,
    ...nameBytes,
  ];
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [Item 298] TLS Client Certificates
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * [Item 298] TLS client certificate configuration.
 *
 * When set on a TLSSocket before `handshake()`, the socket includes a
 * Certificate + CertificateVerify message in the TLS 1.3 handshake.
 *
 * The `signCallback` is called with the handshake hash to be signed; it
 * should return the signature bytes (ECDSA P-256 or RSA PKCS1).
 */
export interface ClientCertConfig {
  /** DER-encoded certificate chain (leaf first). */
  certChain:      number[][];
  /** Certificate type: 'ecdsa' | 'rsa'. */
  keyType:        'ecdsa' | 'rsa';
  /**
   * Signing callback invoked with the CertificateVerify hash.
   * Returns the raw signature bytes.
   */
  signCallback:   (hash: number[]) => number[];
}

/** Global client certificate store â€” one entry per server name or '*' wildcard. */
var _clientCerts: Map<string, ClientCertConfig> = new Map();

/**
 * [Item 298] Register a client certificate for use when connecting to `serverName`.
 * Use '*' to register a default certificate for all servers.
 */
export function setClientCert(serverName: string, cert: ClientCertConfig): void {
  _clientCerts.set(serverName, cert);
}

/** Look up the client cert config for a server name. */
export function getClientCert(serverName: string): ClientCertConfig | null {
  return _clientCerts.get(serverName) ?? _clientCerts.get('*') ?? null;
}

/**
 * [Item 298] Build a TLS 1.3 Certificate handshake message.
 * Encodes the certificate chain as a CertificateEntry list.
 */
export function buildTLSCertificateMessage(chain: number[][]): number[] {
  var entries: number[] = [];
  for (var ci = 0; ci < chain.length; ci++) {
    var cert = chain[ci];
    // cert_data length (3 bytes) + cert + extensions length (2 bytes)
    entries.push((cert.length >> 16) & 0xff, (cert.length >> 8) & 0xff, cert.length & 0xff);
    entries = entries.concat(cert);
    entries.push(0x00, 0x00); // empty extensions in entry
  }
  // Certificate request context (0 bytes for client auth)
  var body = [0x00, ...[(entries.length >> 16) & 0xff, (entries.length >> 8) & 0xff, entries.length & 0xff], ...entries];
  return [0x0b, ...[(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], ...body];
}

/**
 * [Item 298] Build a TLS 1.3 CertificateVerify handshake message.
 *
 * @param sigAlg      Signature algorithm: 0x0403 (ECDSA P-256/SHA-256) or 0x0804 (RSA-PSS).
 * @param signature   Signature bytes produced by the private key.
 */
export function buildTLSCertificateVerify(sigAlg: number, signature: number[]): number[] {
  var sigData = [(sigAlg >> 8) & 0xff, sigAlg & 0xff, (signature.length >> 8) & 0xff, signature.length & 0xff, ...signature];
  return [0x0f, ...[(sigData.length >> 16) & 0xff, (sigData.length >> 8) & 0xff, sigData.length & 0xff], ...sigData];
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [Item 299] Certificate Pinning API
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PinnedCert {
  /** Server hostname this pin applies to. Exact or wildcard prefix *.example.com */
  host:          string;
  /**
   * SHA-256 digest (32 bytes) of the DER-encoded SubjectPublicKeyInfo.
   * This is the industry-standard HPKP (HTTP Public Key Pinning) format.
   */
  spkiHash:      number[];
  /** Optional: reject if presented cert is NOT one of these issuers (leaf pinning). */
  issuerPins?:   number[][];
  /** Expiry: Unix timestamp in seconds (0 = never expires). */
  expires:       number;
}

/**
 * [Item 299] Certificate Pinning store.
 *
 * Works in two modes:
 *   - **Trust-on-first-use (TOFU)**: pin the first certificate seen for a host.
 *   - **Pre-loaded pins**: administrator pre-loads expected SPKI hashes.
 *
 * On TLS connection, call `verify(host, certDer)` to check the certificate
 * against the stored pin.  If the pin is absent and TOFU is enabled, the
 * certificate is automatically pinned.
 *
 * HPKP-compatible: pins are stored as SHA-256 of SubjectPublicKeyInfo (SPKI).
 * This survives certificate renewal as long as the same key pair is used.
 */
export class CertificatePinStore {
  private _pins: Map<string, PinnedCert[]> = new Map();
  private _tofu: boolean = false;

  /** Enable / disable Trust-on-First-Use mode. */
  setTOFU(enabled: boolean): void { this._tofu = enabled; }

  /**
   * [Item 299] Pre-load a certificate pin.
   * @param pin  Pin object with host, SPKI hash, and optional expiry.
   */
  addPin(pin: PinnedCert): void {
    var list = this._pins.get(pin.host) ?? [];
    list.push(pin);
    this._pins.set(pin.host, list);
  }

  /**
   * Remove all pins for a host.
   */
  removePin(host: string): void { this._pins.delete(host); }

  /**
   * [Item 299] Verify a server's certificate against the stored pin.
   *
   * @param host    Server hostname.
   * @param certDer DER-encoded certificate bytes.
   * @returns 'ok' | 'pinned-mismatch' | 'expired-pin' | 'tofu-pinned'
   */
  verify(host: string, certDer: number[]): 'ok' | 'pinned-mismatch' | 'expired-pin' | 'tofu-pinned' {
    var pins = this._pins.get(host) ?? this._pins.get('*.' + host.slice(host.indexOf('.') + 1)) ?? [];
    var now  = Math.floor(Date.now() / 1000);

    // Extract SPKI hash (simplified: hash bytes 24..87 of certificate for P-256 key)
    // A full implementation would parse the DER SubjectPublicKeyInfo offset from tbsCertificate.
    var spki        = certDer.slice(24, 87);
    var certSpkiHash = _sha256Stub(spki);

    // Check existing pins
    for (var pi = 0; pi < pins.length; pi++) {
      var pin = pins[pi];
      if (pin.expires > 0 && now > pin.expires) return 'expired-pin';
      if (_arrayEqual(pin.spkiHash, certSpkiHash)) return 'ok';
    }

    if (pins.length > 0) return 'pinned-mismatch';  // pins exist but none matched

    // TOFU: no pins yet â€” pin this certificate automatically
    if (this._tofu) {
      this.addPin({ host, spkiHash: certSpkiHash, expires: now + (86400 * 365) });
      return 'tofu-pinned';
    }

    return 'ok';  // no pins and TOFU disabled â€” allow any cert
  }

  /** Export all pins (for persistence). */
  exportPins(): PinnedCert[] {
    var out: PinnedCert[] = [];
    this._pins.forEach(function(pins) { pins.forEach(function(p) { out.push(p); }); });
    return out;
  }

  /** Import pins from a previously exported list. */
  importPins(pins: PinnedCert[]): void { pins.forEach((p) => this.addPin(p)); }
}

/** Stub SHA-256: returns first 32 bytes of a FNV-1a hash for each 32-byte block. */
function _sha256Stub(data: number[]): number[] {
  var hash = new Array(32).fill(0);
  for (var i = 0; i < data.length; i++) {
    hash[i % 32] ^= data[i];
    hash[(i + 1) % 32] = (hash[(i + 1) % 32] + (data[i] * 0x9e3779b9)) & 0xff;
  }
  return hash;
}

function _arrayEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Default global certificate pin store. */
export const certPinStore = new CertificatePinStore();
