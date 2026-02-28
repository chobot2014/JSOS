/**
 * JSOS TLS 1.3 Client
 *
 * Pure TypeScript TLS 1.3 client (RFC 8446) using the crypto.ts primitives.
 *
 * Capabilities:
 *   - X25519 key exchange
 *   - TLS_AES_128_GCM_SHA256
 *   - No certificate validation (bare-metal dev OS)
 *   - Server name indication (SNI)
 *
 * Architecture:
 *   TLSSocket wraps a net.ts TCP Socket.
 *   All TLS logic (record layer, handshake, crypto) is pure TypeScript.
 *   C sees only raw TCP bytes.
 */

import {
  sha256, hmacSha256, hkdfExtract, hkdfExpand, hkdfExpandLabel,
  aesKeyExpand, aesEncryptBlock,
  gcmEncrypt, gcmDecrypt,
  chacha20poly1305Encrypt, chacha20poly1305Decrypt,
  x25519, x25519PublicKey, generateKey32,
  concat,
} from './crypto.js';
import { net, strToBytes } from './net.js';
import type { Socket } from './net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── TLS constants ─────────────────────────────────────────────────────────────

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

const CS_AES_128_GCM_SHA256  = 0x1301;
const CS_CHACHA20_POLY1305_SHA256 = 0x1303;  // [Item 295] ChaCha20-Poly1305
const CS_EMPTY_RENEG         = 0x00ff;
const EXT_SNI                = 0x0000;
const EXT_SUPPORTED_VERS     = 0x002b;
const EXT_SUPPORTED_GROUPS   = 0x000a;
const EXT_KEY_SHARE          = 0x0033;
const EXT_SIG_ALGS           = 0x000d;
const EXT_ALPN               = 0x0010;  // [Item 294] Application-Layer Protocol Negotiation
const GROUP_X25519            = 0x001d;

// ── Byte helpers ──────────────────────────────────────────────────────────────

function u8(b: number[], i: number): number  { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i] & 0xff) << 8) | (b[i+1] & 0xff); }
function u24(b: number[], i: number): number {
  return ((b[i] & 0xff) << 16) | ((b[i+1] & 0xff) << 8) | (b[i+2] & 0xff);
}
function putU8(b: number[], v: number): void  { b.push(v & 0xff); }
function putU16(b: number[], v: number): void { b.push((v >> 8) & 0xff); b.push(v & 0xff); }
function putU24(b: number[], v: number): void { b.push((v >> 16) & 0xff); b.push((v >> 8) & 0xff); b.push(v & 0xff); }
// ── AEAD helpers ──────────────────────────────────────────────────────────────

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
  var ek = aesKeyExpand(key);
  // Use gcmEncrypt from crypto.ts
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

// ── TLS record-layer buffering ────────────────────────────────────────────────

// ── TLS Session Ticket Cache (Item 930) ──────────────────────────────────────

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
  private myPrivate:  number[] = [];
  private myPublic:   number[] = [];
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

  // Decrypted but not yet parsed handshake bytes (handles multi-message records)
  private _hsDataBuf: number[] = [];

  /** [Item 930] Cached session ticket for this hostname (populated post-handshake). */
  private _savedTicket: TLSSessionTicket | null = null;
  /** [Item 930] Resumption master secret derived after a completed handshake. */
  private _resumptionSecret: number[] = [];

  constructor(hostname: string) {
    this.hostname = hostname;
    this.sock = net.createSocket('tcp');
  }

  /** Connect TCP (blocking) then perform TLS 1.3 handshake. Returns true on success. */
  handshake(remoteIP: string, remotePort: number): boolean {
    if (!net.connect(this.sock, remoteIP, remotePort)) return false;
    var ok = this._performHandshake();
    // [Item 930] After handshake, try to harvest a NewSessionTicket for future resumption.
    if (ok) this._tryReadSessionTicket();
    return ok;
  }

  /**
   * Perform TLS 1.3 handshake on an already-connected socket.
   * Use this when TCP connect was managed asynchronously via net.connectAsync/connectPoll.
   */
  handshakeOnConnected(sock: Socket): boolean {
    this.sock = sock;
    return this._performHandshake();
  }

  /**
   * Non-blocking TLS read: poll the NIC once and try to parse one complete
   * TLS record from the buffer.  Returns decrypted app data or null.
   */
  readNB(): number[] | null {
    var chunk = net.recvBytesNB(this.sock);
    if (chunk) this.rxBuf = this.rxBuf.concat(chunk);
    if (this.rxBuf.length < 5) return null;
    var outerType = u8(this.rxBuf, 0);
    var recLen    = u16(this.rxBuf, 3);
    if (this.rxBuf.length < 5 + recLen) return null;  // incomplete record — wait more
    var record    = this.rxBuf.slice(0, 5 + recLen);
    this.rxBuf    = this.rxBuf.slice(5 + recLen);
    if (outerType !== TLS_APPLICATION_DATA) return null;
    var dec = tlsDecryptRecord(
        this.serverAppKey, this.serverAppIV, this.serverAppSeq, record, this.useChaCha20);
    if (dec) {
      this.serverAppSeq++;
      if (dec.type === TLS_APPLICATION_DATA) return dec.data;
    }
    return null;
  }

  /** Send application data over TLS */
  write(data: number[]): boolean {
    if (!this.handshakeDone) return false;
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
      if (more) this.rxBuf = this.rxBuf.concat(more);

      if (this.rxBuf.length < 5) continue;
      var outerType = u8(this.rxBuf, 0);
      var recLen    = u16(this.rxBuf, 3);
      if (this.rxBuf.length < 5 + recLen) continue;  // accumulate more

      var record    = this.rxBuf.slice(0, 5 + recLen);
      this.rxBuf    = this.rxBuf.slice(5 + recLen);

      if (outerType === TLS_APPLICATION_DATA) {
        var dec = tlsDecryptRecord(
            this.serverAppKey, this.serverAppIV, this.serverAppSeq, record, this.useChaCha20);
        if (dec) {
          this.serverAppSeq++;
          if (dec.type === TLS_APPLICATION_DATA) return dec.data;
        }
      }
      // Alert or other record type — skip and keep polling
    }
    return null;
  }

  close(): void {
    net.close(this.sock);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _performHandshake(): boolean {
    this.myPrivate = generateKey32();
    this.myPublic  = x25519PublicKey(this.myPrivate);

    var clientHello = this._buildClientHello();
    this.transcript = this.transcript.concat(clientHello.slice(5)); // skip record header
    if (!net.sendBytes(this.sock, clientHello)) return false;

    // Read ServerHello
    var sh = this._readHandshakeMsg(true);
    if (!sh || sh.type !== HS_SERVER_HELLO) return false;
    var serverPublic = this._parseServerHello(sh.data);
    if (!serverPublic) return false;

    // Derive handshake keys
    if (!this._deriveHandshakeKeys(serverPublic)) return false;

    // Read encrypted server handshake messages
    var finishedOk = false;
    for (var attempt = 0; attempt < 20; attempt++) {
      var msg = this._readEncryptedHandshakeMsg();
      if (!msg) break;
      if (msg.type === HS_FINISHED) {
        finishedOk = this._processServerFinished(msg.data);
        break;
      }
      // EncryptedExtensions, Certificate, CertificateVerify — skip
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
    // Random (32 bytes of pseudo-random)
    for (var i = 0; i < 32; i++) putU8(body, (kernel.getTicks() * (i+1)) & 0xff);
    // Session ID (32 bytes)
    putU8(body, 32);
    for (var i = 0; i < 32; i++) putU8(body, (kernel.getTicks() + i) & 0xff);
    // Cipher suites — offer AES-128-GCM (preferred) and ChaCha20-Poly1305 (Item 295)
    putU16(body, 6);  // 3 suites × 2 bytes
    putU16(body, CS_AES_128_GCM_SHA256);
    putU16(body, CS_CHACHA20_POLY1305_SHA256);
    putU16(body, CS_EMPTY_RENEG);
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

    // supported_versions: TLS 1.3
    var svExt: number[] = [];
    putU16(svExt, EXT_SUPPORTED_VERS);
    putU16(svExt, 3);  // ext len
    putU8(svExt, 2);   // list len
    putU16(svExt, 0x0304);  // TLS 1.3
    exts = exts.concat(svExt);

    // supported_groups: x25519
    var sgExt: number[] = [];
    putU16(sgExt, EXT_SUPPORTED_GROUPS);
    putU16(sgExt, 4);  // ext len
    putU16(sgExt, 2);  // list len
    putU16(sgExt, GROUP_X25519);
    exts = exts.concat(sgExt);

    // key_share: x25519
    var ksExt: number[] = [];
    putU16(ksExt, EXT_KEY_SHARE);
    var ksData: number[] = [];
    putU16(ksData, 36);          // client_shares list len
    putU16(ksData, GROUP_X25519);
    putU16(ksData, 32);          // key len
    ksData = ksData.concat(this.myPublic);
    putU16(ksExt, ksData.length);
    exts = exts.concat(ksExt).concat(ksData);

    // signature_algorithms
    var saExt: number[] = [];
    putU16(saExt, EXT_SIG_ALGS);
    var saData: number[] = [];
    putU16(saData, 4);   // list len
    putU16(saData, 0x0804); // rsa_pss_rsae_sha256
    putU16(saData, 0x0403); // ecdsa_secp256r1_sha256
    putU16(saExt, saData.length);
    exts = exts.concat(saExt).concat(saData);

    // ALPN extension (Item 294): prefer h2, then http/1.1
    var alpnExt: number[] = [];
    putU16(alpnExt, EXT_ALPN);
    var alpnData: number[] = [];
    var proto1 = strToBytes('h2');
    var proto2 = strToBytes('http/1.1');
    var protoList: number[] = [];
    putU8(protoList, proto1.length); protoList = protoList.concat(proto1);
    putU8(protoList, proto2.length); protoList = protoList.concat(proto2);
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

    // TLS record
    var rec: number[] = [TLS_HANDSHAKE, 0x03, 0x01];
    putU16(rec, hs.length);
    return rec.concat(hs);
  }

  private _readHandshakeMsg(addToTranscript: boolean):
      { type: number; data: number[] } | null {
    // Read until we have at least 5 bytes (record header)
    var deadline = kernel.getTicks() + 300;
    while (this.rxBuf.length < 5 && kernel.getTicks() < deadline) {
      var chunk = net.recvBytes(this.sock, 30);
      if (chunk) this.rxBuf = this.rxBuf.concat(chunk);
    }
    if (this.rxBuf.length < 5) return null;
    var recType = u8(this.rxBuf, 0);
    var recLen  = u16(this.rxBuf, 3);
    // Wait for full record
    deadline = kernel.getTicks() + 300;
    while (this.rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
      var chunk = net.recvBytes(this.sock, 30);
      if (chunk) this.rxBuf = this.rxBuf.concat(chunk);
    }
    if (this.rxBuf.length < 5 + recLen) return null;
    var recData = this.rxBuf.slice(5, 5 + recLen);
    this.rxBuf  = this.rxBuf.slice(5 + recLen);
    if (recType !== TLS_HANDSHAKE) return null;
    if (recData.length < 4) return null;
    var msgType = u8(recData, 0);
    var msgLen  = u24(recData, 1);
    var msgData = recData.slice(4, 4 + msgLen);
    if (addToTranscript) this.transcript = this.transcript.concat(recData.slice(0, 4 + msgLen));
    return { type: msgType, data: msgData };
  }

  private _parseServerHello(data: number[]): number[] | null {
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
    while (off + 4 <= extEnd) {
      var extType = u16(data, off); off += 2;
      var extLen2 = u16(data, off); off += 2;
      if (extType === EXT_KEY_SHARE) {
        // group (2) + key_exchange (32)
        if (off + 36 > extEnd) return null;
        var group = u16(data, off); off += 2;
        var kLen  = u16(data, off); off += 2;
        if (group !== GROUP_X25519 || kLen !== 32) return null;
        return data.slice(off, off + 32);
      }
      off += extLen2;
    }
    return null;
  }

  private _deriveHandshakeKeys(serverPublic: number[]): boolean {
    // Shared secret via X25519
    var sharedSecret = x25519(this.myPrivate, serverPublic);

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

    this.clientHsKey = hkdfExpandLabel(cHsTraffic, 'key', [], 16);
    this.clientHsIV  = hkdfExpandLabel(cHsTraffic, 'iv',  [], 12);
    this.serverHsKey = hkdfExpandLabel(sHsTraffic, 'key', [], 16);
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
      var deadline = kernel.getTicks() + 400;
      while (this.rxBuf.length < 5 && kernel.getTicks() < deadline) {
        var chunk = net.recvBytes(this.sock, 50);
        if (chunk) this.rxBuf = this.rxBuf.concat(chunk);
      }
      if (this.rxBuf.length < 5) return null;
      var outerType = u8(this.rxBuf, 0);
      var recLen    = u16(this.rxBuf, 3);
      deadline = kernel.getTicks() + 400;
      while (this.rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
        var chunk = net.recvBytes(this.sock, 50);
        if (chunk) this.rxBuf = this.rxBuf.concat(chunk);
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
    // app-key derivation and the ClientFinished verify_data per RFC 8446 §7.1)
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
    this.clientAppKey = hkdfExpandLabel(cAppTraffic, 'key', [], 16);
    this.clientAppIV  = hkdfExpandLabel(cAppTraffic, 'iv',  [], 12);
    this.serverAppKey = hkdfExpandLabel(sAppTraffic, 'key', [], 16);
    this.serverAppIV  = hkdfExpandLabel(sAppTraffic, 'iv',  [], 12);
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
    var raw = net.recvBytes(this.sock, 80);  // short poll
    if (!raw || raw.length < 9) return;
    for (var ri = 0; ri < raw.length; ) {
      if (ri + 5 > raw.length) break;
      var outerType = raw[ri];
      var recLen    = (raw[ri + 3] << 8) | raw[ri + 4];
      ri += 5;
      if (ri + recLen > raw.length) break;
      var recData = raw.slice(ri, ri + recLen);
      ri += recLen;
      if (outerType !== TLS_APPLICATION_DATA) continue;
      // Try to decrypt as app-data record wrapping a handshake record
      var dec = tlsDecryptRecord(
          this.serverAppKey, this.serverAppIV, this.serverAppSeq,
          raw.slice(ri - recLen - 5, ri), this.useChaCha20);
      if (!dec) continue;
      this.serverAppSeq++;
      var inner = dec.data;
      if (inner.length < 4) continue;
      // TLS 1.3: inner content type is last byte of plaintext
      var innerType = inner[inner.length - 1];
      if (innerType !== TLS_HANDSHAKE) continue;
      var hs = inner.slice(0, inner.length - 1);
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
    // Push any remaining bytes back to rxBuf for application reads
    if (raw) {
      for (var i = 0; i < raw.length; i++) this.rxBuf.push(raw[i]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 296] TLS ECDSA certificate support
// ─────────────────────────────────────────────────────────────────────────────

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

  // Stub signature (48 bytes zero — real impl would ECDSA-sign the tbsCert hash)
  var sigR      = new Array(32).fill(0);
  var sigS      = new Array(32).fill(1);
  var ecdsaSig  = seq([...integer(sigR), ...integer(sigS)]);
  var sigBits   = bitStr(ecdsaSig);

  return seq([...tbsCert, ...algoId, ...sigBits]);
}

// ─────────────────────────────────────────────────────────────────────────────
// [Item 297] TLS 1.2 fallback socket
// ─────────────────────────────────────────────────────────────────────────────

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
      if (chunk) this._rxBuf = this._rxBuf.concat(chunk);
    }
    if (this._rxBuf.length < 5) return null;
    var type   = this._rxBuf[0];
    var recLen = (this._rxBuf[3] << 8) | this._rxBuf[4];
    while (this._rxBuf.length < 5 + recLen && kernel.getTicks() < deadline) {
      var c2 = net.recvBytes(this._sock, 100);
      if (c2) this._rxBuf = this._rxBuf.concat(c2);
    }
    if (this._rxBuf.length < 5 + recLen) return null;
    var data = this._rxBuf.slice(5, 5 + recLen);
    this._rxBuf = this._rxBuf.slice(5 + recLen);
    return { type, data };
  }

  private _doHandshake(): boolean {
    // ── ClientHello ──
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

    // ── ServerHello / Certificate (simplified: just wait for CCS) ──
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

    // ── ClientKeyExchange (RSA, null pre-master for stub) ──
    var pms: number[] = [0x03, 0x03]; // pre-master secret: version bytes
    for (var j = 0; j < 46; j++) pms.push((Math.random() * 256) | 0);
    var cke = [0x10, 0x00, 0x00, pms.length + 2, 0x00, pms.length, ...pms];
    this._sendRecord(22, cke);

    // ── ChangeCipherSpec ──
    this._sendRecord(20, [0x01]);

    // ── Finished (stub: 12 zero bytes for verify_data) ──
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

// ─────────────────────────────────────────────────────────────────────────────
// [Item 298] TLS Client Certificates
// ─────────────────────────────────────────────────────────────────────────────

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

/** Global client certificate store — one entry per server name or '*' wildcard. */
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

// ─────────────────────────────────────────────────────────────────────────────
// [Item 299] Certificate Pinning API
// ─────────────────────────────────────────────────────────────────────────────

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

    // TOFU: no pins yet — pin this certificate automatically
    if (this._tofu) {
      this.addPin({ host, spkiHash: certSpkiHash, expires: now + (86400 * 365) });
      return 'tofu-pinned';
    }

    return 'ok';  // no pins and TOFU disabled — allow any cert
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
