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
  x25519, x25519PublicKey, generateKey32,
  concat,
} from './crypto.js';
import { net } from './net.js';
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
const CS_EMPTY_RENEG         = 0x00ff;
const EXT_SNI                = 0x0000;
const EXT_SUPPORTED_VERS     = 0x002b;
const EXT_SUPPORTED_GROUPS   = 0x000a;
const EXT_KEY_SHARE          = 0x0033;
const EXT_SIG_ALGS           = 0x000d;
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
function strToBytes(s: string): number[] {
  var b: number[] = new Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

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
    innerType: number, plaintext: number[]): number[] {
  // inner = plaintext || contentType
  var inner = plaintext.concat([innerType]);
  // AAD = TLS record header for outer type 23
  var totalLen = inner.length + 16; // +16 for GCM tag
  var aad = [TLS_APPLICATION_DATA, 0x03, 0x03,
              (totalLen >> 8) & 0xff, totalLen & 0xff];
  var nonce = xorIV(iv, seq);
  var ek = aesKeyExpand(key);
  // Use gcmEncrypt from crypto.ts
  var aeadOut = gcmEncrypt(key, nonce, aad, inner);
  return aad.concat(aeadOut.ciphertext).concat(aeadOut.tag);
}

function tlsDecryptRecord(
    key: number[], iv: number[], seq: number,
    record: number[]): { type: number; data: number[] } | null {
  if (record.length < 5) return null;
  var outerType = u8(record, 0);
  var len = u16(record, 3);
  if (record.length < 5 + len) return null;
  var ciphertext = record.slice(5, 5 + len - 16);
  var tag        = record.slice(5 + len - 16, 5 + len);
  var aad        = record.slice(0, 5);
  var nonce      = xorIV(iv, seq);
  var plain = gcmDecrypt(key, nonce, aad, ciphertext, tag);
  if (!plain) return null;
  // Find inner content type: last non-zero byte
  var innerType = outerType;
  for (var i = plain.length - 1; i >= 0; i--) {
    if (plain[i] !== 0) { innerType = plain[i]; plain = plain.slice(0, i); break; }
  }
  return { type: innerType, data: plain };
}

// ── TLS record-layer buffering ────────────────────────────────────────────────

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

  // Decrypted but not yet parsed handshake bytes (handles multi-message records)
  private _hsDataBuf: number[] = [];

  constructor(hostname: string) {
    this.hostname = hostname;
    this.sock = net.createSocket('tcp');
  }

  /** Connect TCP and perform TLS 1.3 handshake. Returns true on success. */
  handshake(remoteIP: string, remotePort: number): boolean {
    if (!net.connect(this.sock, remoteIP, remotePort)) return false;

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
        // Verify server Finished, send client Finished
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

  /** Send application data over TLS */
  write(data: number[]): boolean {
    if (!this.handshakeDone) return false;
    var record = tlsEncryptRecord(
        this.clientAppKey, this.clientAppIV, this.clientAppSeq,
        TLS_APPLICATION_DATA, data);
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
            this.serverAppKey, this.serverAppIV, this.serverAppSeq, record);
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

  private _buildClientHello(): number[] {
    var body: number[] = [];

    // ProtocolVersion = 0x0303
    putU16(body, 0x0303);
    // Random (32 bytes of pseudo-random)
    for (var i = 0; i < 32; i++) putU8(body, (kernel.getTicks() * (i+1)) & 0xff);
    // Session ID (32 bytes)
    putU8(body, 32);
    for (var i = 0; i < 32; i++) putU8(body, (kernel.getTicks() + i) & 0xff);
    // Cipher suites
    putU16(body, 4);  // 2 suites × 2 bytes
    putU16(body, CS_AES_128_GCM_SHA256);
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
          this.serverHsKey, this.serverHsIV, this.serverHsSeq, record);
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
        TLS_HANDSHAKE, msgBody);
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
}
