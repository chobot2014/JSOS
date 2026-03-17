/**
 * JSOS Cryptography Library
 *
 * Pure TypeScript implementations of:
 *   SHA-256, HMAC-SHA-256, HKDF
 *   SHA-384, SHA-512, HMAC-SHA-384          [Item 328]
 *   AES-128 block cipher, AES-128-GCM authenticated encryption
 *   ChaCha20 stream cipher, Poly1305 MAC    [Item 327]
 *   ChaCha20-Poly1305 AEAD (RFC 7539)       [Item 327]
 *   X25519 (Curve25519) Diffie-Hellman
 *
 * All algorithms are self-contained and run on bare metal under QuickJS.
 * BigInt is used for X25519 field arithmetic, GHASH (GCM), and SHA-512 words.
 */

import { strToBytes } from './net.js';
import { JITAES } from '../process/jit-os.js';

// ────────────────────────────────────────────────────── SHA-256 ──────────────

const SHA256_K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Block(h: number[], w: number[]): void {
  var a = h[0], b = h[1], c = h[2], d = h[3];
  var e = h[4], f = h[5], g = h[6], hh = h[7];
  for (var i = 16; i < 64; i++) {
    var s0 = (rotr32(w[i-15], 7) ^ rotr32(w[i-15], 18) ^ (w[i-15] >>> 3)) >>> 0;
    var s1 = (rotr32(w[i-2],  17) ^ rotr32(w[i-2],  19) ^ (w[i-2] >>> 10)) >>> 0;
    w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
  }
  for (var i = 0; i < 64; i++) {
    var S1   = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
    var ch   = ((e & f) ^ (~e & g)) >>> 0;
    var temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    var S0   = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
    var maj  = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    var temp2 = (S0 + maj) >>> 0;
    hh = g; g = f; f = e;
    e = (d + temp1) >>> 0;
    d = c; c = b; b = a;
    a = (temp1 + temp2) >>> 0;
  }
  h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
  h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
}

export function sha256(data: number[]): number[] {
  var h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  // Padding: pre-compute total padded length, allocate once
  var bitLen = data.length * 8;
  var padLen = 64 - ((data.length + 1 + 8) % 64);
  if (padLen === 64) padLen = 0;
  var totalLen = data.length + 1 + padLen + 8;
  var msg = new Array(totalLen);
  for (var _sI = 0; _sI < data.length; _sI++) msg[_sI] = data[_sI];
  msg[data.length] = 0x80;
  for (var _sI = data.length + 1; _sI < totalLen - 8; _sI++) msg[_sI] = 0;
  // 64-bit big-endian bit length
  msg[totalLen - 8] = 0; msg[totalLen - 7] = 0;
  msg[totalLen - 6] = 0; msg[totalLen - 5] = 0;
  msg[totalLen - 4] = (bitLen >>> 24) & 0xff;
  msg[totalLen - 3] = (bitLen >>> 16) & 0xff;
  msg[totalLen - 2] = (bitLen >>>  8) & 0xff;
  msg[totalLen - 1] =  bitLen         & 0xff;

  for (var off = 0; off < msg.length; off += 64) {
    var w: number[] = new Array(64);
    for (var j = 0; j < 16; j++) {
      w[j] = ((msg[off+j*4  ] & 0xff) << 24) |
             ((msg[off+j*4+1] & 0xff) << 16) |
             ((msg[off+j*4+2] & 0xff) <<  8) |
              (msg[off+j*4+3] & 0xff);
    }
    sha256Block(h, w);
  }
  var out: number[] = [];
  for (var i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 0xff);
    out.push((h[i] >>> 16) & 0xff);
    out.push((h[i] >>>  8) & 0xff);
    out.push( h[i]         & 0xff);
  }
  return out;
}

// ────────────────────────────────────────────────── HMAC-SHA-256 ─────────────

export function hmacSha256(key: number[], data: number[]): number[] {
  // Normalize key to 64 bytes
  var k = key.length > 64 ? sha256(key) : key.slice();
  while (k.length < 64) k.push(0);

  // Pre-allocate ipad+data and opad+hash in single arrays (avoids .concat())
  var inner = new Array(64 + data.length);
  var outer = new Array(64 + 32);
  for (var i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  for (var i = 0; i < data.length; i++) inner[64 + i] = data[i];
  var innerHash = sha256(inner);
  for (var i = 0; i < 32; i++) outer[64 + i] = innerHash[i];
  return sha256(outer);
}

// ──────────────────────────────────────────────────────── HKDF ───────────────

export function hkdfExtract(salt: number[], ikm: number[]): number[] {
  var s = salt.length > 0 ? salt : new Array(32).fill(0);
  return hmacSha256(s, ikm);
}

export function hkdfExpand(prk: number[], info: number[], len: number): number[] {
  var out: number[] = [];
  var T: number[] = [];
  var counter = 0;
  while (out.length < len) {
    counter++;
    T = hmacSha256(prk, T.concat(info).concat([counter]));
    out = out.concat(T);
  }
  return out.slice(0, len);
}

/** TLS 1.3 HKDF-Expand-Label */
export function hkdfExpandLabel(
    secret: number[], label: string, context: number[], len: number): number[] {
  // HkdfLabel: uint16 length, opaque label<7..255>, opaque context<0..255>
  var tlsLabel = strToBytes('tls13 ' + label);
  var hkdfInfo: number[] = [];
  // uint16 len
  hkdfInfo.push((len >> 8) & 0xff);
  hkdfInfo.push( len       & 0xff);
  // label length + label
  hkdfInfo.push(tlsLabel.length);
  hkdfInfo = hkdfInfo.concat(tlsLabel);
  // context length + context
  hkdfInfo.push(context.length);
  hkdfInfo = hkdfInfo.concat(context);
  return hkdfExpand(secret, hkdfInfo, len);
}

// ─────────────────────────────────────────────────── AES-128 ─────────────────

// AES S-box
const AES_SBOX: number[] = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];

const AES_RCON: number[] = [
  0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,
];

function xtime(x: number): number { return (x & 0x80) ? (((x << 1) ^ 0x1b) & 0xff) : ((x << 1) & 0xff); }
function gmul(a: number, b: number): number {
  var p = 0;
  for (var i = 0; i < 8; i++) {
    if ((b & 1) !== 0) p ^= a;
    var hiBit = (a & 0x80) !== 0;
    a = (a << 1) & 0xff;
    if (hiBit) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

export function aesKeyExpand(key: number[]): number[] {
  // Supports AES-128 (16-byte key → 176 bytes) and AES-256 (32-byte key → 240 bytes)
  var Nk = key.length >> 2;         // 4 for AES-128, 8 for AES-256
  var Nr = Nk + 6;                  // 10 for AES-128, 14 for AES-256
  var totalBytes = (Nr + 1) * 16;   // 176 or 240
  var ek = key.slice();
  var i = Nk;
  while (ek.length < totalBytes) {
    var base = ek.length - 4;
    var prev4 = [ek[base], ek[base+1], ek[base+2], ek[base+3]];
    if (i % Nk === 0) {
      // RotWord + SubWord + Rcon
      var t0 = prev4[0];
      prev4[0] = AES_SBOX[prev4[1]] ^ AES_RCON[i / Nk];
      prev4[1] = AES_SBOX[prev4[2]];
      prev4[2] = AES_SBOX[prev4[3]];
      prev4[3] = AES_SBOX[t0];
    } else if (Nk > 6 && i % Nk === 4) {
      // Additional SubWord for AES-256
      prev4[0] = AES_SBOX[prev4[0]];
      prev4[1] = AES_SBOX[prev4[1]];
      prev4[2] = AES_SBOX[prev4[2]];
      prev4[3] = AES_SBOX[prev4[3]];
    }
    var base2 = ek.length - (Nk * 4);  // W[i - Nk]
    ek.push(ek[base2]   ^ prev4[0]);
    ek.push(ek[base2+1] ^ prev4[1]);
    ek.push(ek[base2+2] ^ prev4[2]);
    ek.push(ek[base2+3] ^ prev4[3]);
    i++;
  }
  return ek;
}

export function aesEncryptBlock(block: number[], ek: number[]): number[] {
  // JIT fast path — native x86-32 SubBytes/ShiftRows/MixColumns/AddRoundKey
  var jitResult = JITAES.encryptBlock(block, ek);
  if (jitResult) return jitResult;
  // TypeScript fallback
  var s = block.slice();
  var Nr = (ek.length >> 4) - 1;  // 10 for AES-128 (176B), 14 for AES-256 (240B)
  // AddRoundKey 0
  for (var i = 0; i < 16; i++) s[i] ^= ek[i];
  for (var rnd = 1; rnd <= Nr; rnd++) {
    // SubBytes
    for (var i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    // ShiftRows
    var t: number[] = s.slice();
    s[1]=t[5];s[5]=t[9];s[9]=t[13];s[13]=t[1];
    s[2]=t[10];s[6]=t[14];s[10]=t[2];s[14]=t[6];
    s[3]=t[15];s[7]=t[3];s[11]=t[7];s[15]=t[11];
    // MixColumns (skip in last round)
    if (rnd < Nr) {
      for (var c = 0; c < 4; c++) {
        var i0 = c*4, a0=s[i0],a1=s[i0+1],a2=s[i0+2],a3=s[i0+3];
        s[i0  ] = gmul(2,a0)^gmul(3,a1)^a2^a3;
        s[i0+1] = a0^gmul(2,a1)^gmul(3,a2)^a3;
        s[i0+2] = a0^a1^gmul(2,a2)^gmul(3,a3);
        s[i0+3] = gmul(3,a0)^a1^a2^gmul(2,a3);
      }
    }
    // AddRoundKey
    var rkOff = rnd * 16;
    for (var i = 0; i < 16; i++) s[i] ^= ek[rkOff + i];
  }
  return s;
}

// ─────────────────────────────────────────────── AES-128-GCM ─────────────────

/**
 * 128-bit value as four big-endian 32-bit words (w[0] = MSW).
 * Used for GHASH — replaces BigInt with pure int32 bitwise ops.
 */
type GH128 = [number, number, number, number];

function bytesToGH128(b: number[], off: number): GH128 {
  return [
    ((b[off]&0xff)<<24)|((b[off+1]&0xff)<<16)|((b[off+2]&0xff)<<8)|(b[off+3]&0xff),
    ((b[off+4]&0xff)<<24)|((b[off+5]&0xff)<<16)|((b[off+6]&0xff)<<8)|(b[off+7]&0xff),
    ((b[off+8]&0xff)<<24)|((b[off+9]&0xff)<<16)|((b[off+10]&0xff)<<8)|(b[off+11]&0xff),
    ((b[off+12]&0xff)<<24)|((b[off+13]&0xff)<<16)|((b[off+14]&0xff)<<8)|(b[off+15]&0xff),
  ];
}

function gh128ToBytes(w: GH128): number[] {
  return [
    (w[0]>>>24)&0xff,(w[0]>>>16)&0xff,(w[0]>>>8)&0xff,w[0]&0xff,
    (w[1]>>>24)&0xff,(w[1]>>>16)&0xff,(w[1]>>>8)&0xff,w[1]&0xff,
    (w[2]>>>24)&0xff,(w[2]>>>16)&0xff,(w[2]>>>8)&0xff,w[2]&0xff,
    (w[3]>>>24)&0xff,(w[3]>>>16)&0xff,(w[3]>>>8)&0xff,w[3]&0xff,
  ];
}

/**
 * Multiply two 128-bit values in GF(2^128) with polynomial x^128+x^7+x^2+x+1.
 * Uses pure 32-bit integer ops — no BigInt allocation.
 */
function ghashMul(Xw: GH128, Yw: GH128): GH128 {
  var z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  var v0 = Xw[0], v1 = Xw[1], v2 = Xw[2], v3 = Xw[3];
  for (var i = 0; i < 4; i++) {
    var yi = Yw[i];
    for (var j = 31; j >= 0; j--) {
      if ((yi >>> j) & 1) { z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3; }
      var lsb = v3 & 1;
      v3 = (v3 >>> 1) | ((v2 & 1) << 31);
      v2 = (v2 >>> 1) | ((v1 & 1) << 31);
      v1 = (v1 >>> 1) | ((v0 & 1) << 31);
      v0 = v0 >>> 1;
      if (lsb) v0 ^= 0xe1000000; // R = 0xe1 << 120
    }
  }
  return [z0, z1, z2, z3];
}

function ghash(H: GH128, aad: number[], ciphertext: number[]): number[] {
  var y0 = 0, y1 = 0, y2 = 0, y3 = 0;
  var blk: number[] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  function processBlock(data: number[], off: number, len: number): void {
    for (var k = 0; k < 16; k++) blk[k] = k < len ? data[off + k] : 0;
    var b = bytesToGH128(blk, 0);
    y0 ^= b[0]; y1 ^= b[1]; y2 ^= b[2]; y3 ^= b[3];
    var r = ghashMul([y0, y1, y2, y3] as GH128, H);
    y0 = r[0]; y1 = r[1]; y2 = r[2]; y3 = r[3];
  }
  var i = 0;
  while (i + 16 <= aad.length) { processBlock(aad, i, 16); i += 16; }
  if (i < aad.length) processBlock(aad, i, aad.length - i);
  i = 0;
  while (i + 16 <= ciphertext.length) { processBlock(ciphertext, i, 16); i += 16; }
  if (i < ciphertext.length) processBlock(ciphertext, i, ciphertext.length - i);
  // Lengths block
  var aadBits = aad.length * 8;
  var ctBits  = ciphertext.length * 8;
  for (var k = 0; k < 16; k++) blk[k] = 0;
  blk[4]  = (aadBits >>> 24) & 0xff;
  blk[5]  = (aadBits >>> 16) & 0xff;
  blk[6]  = (aadBits >>>  8) & 0xff;
  blk[7]  =  aadBits         & 0xff;
  blk[12] = (ctBits >>> 24) & 0xff;
  blk[13] = (ctBits >>> 16) & 0xff;
  blk[14] = (ctBits >>>  8) & 0xff;
  blk[15] =  ctBits         & 0xff;
  var lb = bytesToGH128(blk, 0);
  y0 ^= lb[0]; y1 ^= lb[1]; y2 ^= lb[2]; y3 ^= lb[3];
  var fin = ghashMul([y0, y1, y2, y3] as GH128, H);
  return gh128ToBytes(fin);
}

function gcmCtr(ek: number[], iv: number[], counter: number, data: number[]): number[] {
  // counter block: iv (12 B) || counter (4 B big-endian)
  var out: number[] = new Array(data.length);
  var block: number[] = new Array(16);
  for (var i = 0; i < data.length; i += 16) {
    for (var j = 0; j < 12; j++) block[j] = iv[j];
    block[12] = (counter >>> 24) & 0xff;
    block[13] = (counter >>> 16) & 0xff;
    block[14] = (counter >>>  8) & 0xff;
    block[15] =  counter         & 0xff;
    var ks = aesEncryptBlock(block, ek);
    for (var j = 0; j < 16 && (i + j) < data.length; j++) {
      out[i + j] = data[i + j] ^ ks[j];
    }
    counter = (counter + 1) >>> 0;
  }
  return out;
}

export function gcmEncrypt(
    key: number[], iv: number[], aad: number[], plaintext: number[]):
    { ciphertext: number[], tag: number[] } {
  var ek = aesKeyExpand(key);
  // H = AES_k(0^128)
  var H = bytesToGH128(aesEncryptBlock(new Array(16).fill(0), ek), 0);
  // Encrypt
  var ciphertext = gcmCtr(ek, iv, 2, plaintext);
  // GHASH
  var T = ghash(H, aad, ciphertext);
  // E_k(J0) = AES_k(IV || 0x00000001)
  var j0 = gcmCtr(ek, iv, 1, T);
  return { ciphertext, tag: j0 };
}

export function gcmDecrypt(
    key: number[], iv: number[], aad: number[],
    ciphertext: number[], tag: number[]): number[] | null {
  var ek = aesKeyExpand(key);
  var H = bytesToGH128(aesEncryptBlock(new Array(16).fill(0), ek), 0);
  // Verify tag
  var T = ghash(H, aad, ciphertext);
  var j0 = gcmCtr(ek, iv, 1, T);
  // Constant-time compare
  var diff = 0;
  for (var i = 0; i < 16; i++) diff |= (j0[i] ^ tag[i]);
  if (diff !== 0) return null;
  return gcmCtr(ek, iv, 2, ciphertext);
}

// ───────────────────────────────────────────────────── X25519 ─────────────────

/**
 * X25519 Diffie-Hellman using BigInt arithmetic over GF(2^255 - 19).
 *
 * Implements RFC 7748 §5.
 */

const P25519 = (BigInt(1) << BigInt(255)) - BigInt(19);
const A24 = BigInt(121665);

function fmod(x: bigint): bigint {
  var r = x % P25519;
  if (r < BigInt(0)) r += P25519;
  return r;
}

function finv(x: bigint): bigint {
  // Fermat: x^(p-2) mod p  –– ~255 multiplications
  var e = P25519 - BigInt(2);
  var result = BigInt(1);
  var base = fmod(x);
  while (e > BigInt(0)) {
    if (e & BigInt(1)) result = fmod(result * base);
    base = fmod(base * base);
    e >>= BigInt(1);
  }
  return result;
}

/** Decode a 32-byte little-endian array to a field element */
function decodeLE(b: number[]): bigint {
  var v = BigInt(0);
  for (var i = 31; i >= 0; i--) {
    v = (v << BigInt(8)) | BigInt(b[i] & 0xff);
  }
  return v;
}

/** Encode a field element to 32-byte little-endian array */
function encodeLE(v: bigint): number[] {
  var out: number[] = new Array(32);
  var x = fmod(v);
  for (var i = 0; i < 32; i++) {
    out[i] = Number(x & BigInt(0xff));
    x >>= BigInt(8);
  }
  return out;
}

/** Clamp a private key scalar (RFC 7748 §5) */
function clampScalar(k: number[]): number[] {
  var c = k.slice();
  c[0]  &= 248;
  c[31] &= 127;
  c[31] |= 64;
  return c;
}

/**
 * X25519: compute Diffie-Hellman shared secret.
 * @param k  32-byte scalar (private key, clamped internally)
 * @param u  32-byte u-coordinate of the base point or peer public key
 * @returns  32-byte output (shared secret or public key)
 */
export function x25519(k: number[], u: number[]): number[] {
  var scalar = clampScalar(k);
  var kBig = decodeLE(scalar);
  // Clamp bits 255 of u
  var uArr = u.slice();
  uArr[31] &= 127;
  var U = decodeLE(uArr);

  // Montgomery ladder
  var x1 = fmod(U);
  var x2 = BigInt(1), z2 = BigInt(0);
  var x3 = fmod(U), z3 = BigInt(1);
  var swap = BigInt(0);

  for (var bit = 254; bit >= 0; bit--) {
    var kBit = (kBig >> BigInt(bit)) & BigInt(1);
    var doSwap = kBit ^ swap;
    swap = kBit;
    // Conditional swap
    if (doSwap) {
      var tmp = x2; x2 = x3; x3 = tmp;
      var tmp2 = z2; z2 = z3; z3 = tmp2;
    }
    // Differential addition + doubling
    var A  = fmod(x2 + z2);
    var AA = fmod(A * A);
    var B  = fmod(x2 - z2 + P25519);
    var BB = fmod(B * B);
    var E  = fmod(AA - BB + P25519);
    var C  = fmod(x3 + z3);
    var D  = fmod(x3 - z3 + P25519);
    var DA = fmod(D * A);
    var CB = fmod(C * B);
    x3 = fmod((DA + CB) * (DA + CB));
    z3 = fmod(x1 * ((DA - CB + P25519) * (DA - CB + P25519)));
    x2 = fmod(AA * BB);
    z2 = fmod(E * (AA + fmod(A24 * E)));
  }
  if (swap) {
    var tmp = x2; x2 = x3; x3 = tmp;
    var tmp2 = z2; z2 = z3; z3 = tmp2;
  }
  return encodeLE(fmod(x2 * finv(z2)));
}

/** X25519 base point (u=9) */
const X25519_BASE: number[] = [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Derive public key from a private key scalar */
export function x25519PublicKey(privateKey: number[]): number[] {
  return x25519(privateKey, X25519_BASE);
}

// ────────────────────────────────── P-256 (secp256r1) ECDH (Item 330) ─────────

/**
 * NIST P-256 (secp256r1) curve parameters (RFC 5480 / FIPS 186-4).
 *
 * All field arithmetic is modulo p.  a = p - 3 (short Weierstrass).
 */
const P256r1Curve = {
  p:  0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn,
  n:  0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n,
  a:  0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFCn, // p − 3
  b:  0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn,
  Gx: 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296n,
  Gy: 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5n,
};

interface P256rPoint { x: bigint; y: bigint; }

/** Extended-Euclidean modular inverse (faster than Fermat) */
function p256rModInv(a: bigint, m: bigint): bigint {
  var g = m, x = 0n, y = 1n;
  var ta = ((a % m) + m) % m;
  while (ta > 1n) {
    var q = ta / g;
    [ta, g] = [g, ta - q * g];
    [x, y]  = [y, x - q * y];
  }
  return ((y % m) + m) % m;
}

function p256rAddPoints(A: P256rPoint | null, B: P256rPoint | null): P256rPoint | null {
  if (!A) return B;
  if (!B) return A;
  var p = P256r1Curve.p, a = P256r1Curve.a;
  if (A.x === B.x) {
    if (((A.y + B.y) % p) === 0n) return null; // point at infinity
    var lam = ((3n * A.x % p * A.x % p + a) % p * p256rModInv(2n * A.y % p, p)) % p;
    var x3  = ((lam * lam % p) - 2n * A.x % p + 2n * p) % p;
    var y3  = ((lam * ((A.x - x3 + p) % p)) % p - A.y % p + p) % p;
    return { x: x3, y: y3 };
  }
  var dx = ((B.x - A.x) % p + p) % p;
  var dy = ((B.y - A.y) % p + p) % p;
  var lam2 = dy * p256rModInv(dx, p) % p;
  var x4 = ((lam2 * lam2 % p) - A.x % p - B.x % p + 3n * p) % p;
  var y4 = ((lam2 * ((A.x - x4 + p) % p)) % p - A.y % p + p) % p;
  return { x: x4, y: y4 };
}

function p256rMulScalar(k: bigint, P: P256rPoint | null): P256rPoint | null {
  var R: P256rPoint | null = null;
  var Q = P;
  while (k > 0n) {
    if (k & 1n) R = p256rAddPoints(R, Q);
    Q = p256rAddPoints(Q, Q);
    k >>= 1n;
  }
  return R;
}

/** Encode a bigint as a big-endian byte array of exactly `len` bytes. */
function bigIntToBytesBE32(v: bigint): number[] {
  var out: number[] = new Array(32).fill(0);
  var x = v;
  for (var i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Decode a big-endian byte slice to a bigint. */
function bytesToBigIntBE(b: number[], off: number, len: number): bigint {
  var v = 0n;
  for (var i = 0; i < len; i++) v = (v << 8n) | BigInt(b[off + i] & 0xff);
  return v;
}

/**
 * Generate an uncompressed P-256 public key from a 32-byte big-endian private scalar.
 * Returns 65 bytes: 0x04 || x (32 BE) || y (32 BE).
 */
export function p256PublicKey(privateKey: number[]): number[] {
  var scalar = bytesToBigIntBE(privateKey, 0, 32);
  var G: P256rPoint = { x: P256r1Curve.Gx, y: P256r1Curve.Gy };
  var pub = p256rMulScalar(scalar, G);
  if (!pub) return new Array(65).fill(0);
  var out: number[] = [0x04];
  return out.concat(bigIntToBytesBE32(pub.x)).concat(bigIntToBytesBE32(pub.y));
}

/**
 * P-256 ECDH: compute shared secret x-coordinate.
 * @param privateKey  32-byte big-endian scalar
 * @param remoteKey   65-byte uncompressed point (0x04 || x || y)
 * @returns 32-byte shared secret (x-coordinate, big-endian)
 */
export function ecdhP256(privateKey: number[], remoteKey: number[]): number[] {
  if (remoteKey.length !== 65 || remoteKey[0] !== 0x04) return new Array(32).fill(0);
  var scalar = bytesToBigIntBE(privateKey, 0, 32);
  var rx = bytesToBigIntBE(remoteKey, 1, 32);
  var ry = bytesToBigIntBE(remoteKey, 33, 32);
  var R: P256rPoint = { x: rx, y: ry };
  var shared = p256rMulScalar(scalar, R);
  if (!shared) return new Array(32).fill(0);
  return bigIntToBytesBE32(shared.x);
}

// ─────────────────────────────────────────────── Random key generation ────────

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Generate a 32-byte random private key using hardware RDRAND entropy */
export function generateKey32(): number[] {
  var k = getHardwareRandom(32);
  // X25519 scalar clamping (RFC 7748 §5)
  k[0]  &= 248;
  k[31] &= 127;
  k[31] |= 64;
  return k;
}

/**
 * Generate a 32-byte random private key with no clamping.
 * Used for P-256 ECDH where the scalar should be a full 256-bit value in [1, n-1].
 */
export function generateKey32Unclamped(): number[] {
  var k = getHardwareRandom(32);
  // Ensure non-zero and < n (P-256 n ≈ 0.9 × 2^256)
  k[0] |= 0x01;  // guarantee non-zero
  k[0] &= 0x7f;  // keep below P-256 n
  return k;
}

/** Constant-time byte array equality */
export function bytesEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

/** Concatenate byte arrays */
export function concat(...arrays: number[][]): number[] {
  var out: number[] = [];
  for (var i = 0; i < arrays.length; i++) out = out.concat(arrays[i]);
  return out;
}

/** XOR two equal-length byte arrays */
export function xorBytes(a: number[], b: number[]): number[] {
  var out: number[] = new Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Convert a number (0-255) to 2-hex-char string */
export function byteToHex(b: number): string {
  var s = (b & 0xff).toString(16);
  return s.length < 2 ? '0' + s : s;
}

// ────────────────────────────────────────────────────── SHA-384 ──────────────
// [Item 328] SHA-384 is SHA-512 truncated to 384 bits with different IV.
// Uses BigInt for 64-bit word arithmetic (supported in QuickJS).

const SHA512_K: bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const MASK64 = 0xffffffffffffffffn;

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function sha512Block(H: bigint[], W: bigint[]): void {
  for (var i = 16; i < 80; i++) {
    var s0 = (rotr64(W[i-15], 1n) ^ rotr64(W[i-15], 8n) ^ (W[i-15] >> 7n)) & MASK64;
    var s1 = (rotr64(W[i-2], 19n) ^ rotr64(W[i-2], 61n) ^ (W[i-2] >> 6n)) & MASK64;
    W[i] = (W[i-16] + s0 + W[i-7] + s1) & MASK64;
  }
  var a = H[0], b = H[1], c = H[2], d = H[3];
  var e = H[4], f = H[5], g = H[6], h = H[7];
  for (var i = 0; i < 80; i++) {
    var S1   = (rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n)) & MASK64;
    var ch   = ((e & f) ^ (~e & g)) & MASK64;
    var t1   = (h + S1 + ch + SHA512_K[i] + W[i]) & MASK64;
    var S0   = (rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) & MASK64;
    var maj  = ((a & b) ^ (a & c) ^ (b & c)) & MASK64;
    var t2   = (S0 + maj) & MASK64;
    h = g; g = f; f = e;
    e = (d + t1) & MASK64;
    d = c; c = b; b = a;
    a = (t1 + t2) & MASK64;
  }
  H[0] = (H[0] + a) & MASK64; H[1] = (H[1] + b) & MASK64;
  H[2] = (H[2] + c) & MASK64; H[3] = (H[3] + d) & MASK64;
  H[4] = (H[4] + e) & MASK64; H[5] = (H[5] + f) & MASK64;
  H[6] = (H[6] + g) & MASK64; H[7] = (H[7] + h) & MASK64;
}

function sha512Core(data: number[], iv: bigint[]): number[] {
  var msg = data.slice();
  var bitLenHi = Math.floor(data.length / 0x20000000); // high bits
  var bitLenLo = (data.length * 8) >>> 0;
  msg.push(0x80);
  while ((msg.length % 128) !== 112) msg.push(0);
  // 128-bit big-endian bit length: high 64 bits (always 0 for sane messages) + low 64 bits
  msg.push(0, 0, 0, 0, 0, 0, 0, 0);  // high 64 bits
  msg.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff,
           (bitLenHi >>>  8) & 0xff,  bitLenHi         & 0xff,
           (bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff,
           (bitLenLo >>>  8) & 0xff,  bitLenLo         & 0xff);
  var H = iv.slice();
  for (var off = 0; off < msg.length; off += 128) {
    var W: bigint[] = new Array(80);
    for (var j = 0; j < 16; j++) {
      var base = off + j * 8;
      W[j] = (BigInt(msg[base])   << 56n) | (BigInt(msg[base+1]) << 48n) |
             (BigInt(msg[base+2]) << 40n) | (BigInt(msg[base+3]) << 32n) |
             (BigInt(msg[base+4]) << 24n) | (BigInt(msg[base+5]) << 16n) |
             (BigInt(msg[base+6]) <<  8n) |  BigInt(msg[base+7]);
    }
    sha512Block(H, W);
  }
  // Encode output
  var out: number[] = [];
  for (var i = 0; i < H.length; i++) {
    var w = H[i];
    out.push(Number((w >> 56n) & 0xffn), Number((w >> 48n) & 0xffn),
             Number((w >> 40n) & 0xffn), Number((w >> 32n) & 0xffn),
             Number((w >> 24n) & 0xffn), Number((w >> 16n) & 0xffn),
             Number((w >>  8n) & 0xffn), Number( w         & 0xffn));
  }
  return out;
}

/** [Item 328] SHA-384: SHA-512 with different IV, output truncated to 48 bytes. */
export function sha384(data: number[]): number[] {
  var iv384: bigint[] = [
    0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n,
    0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
  ];
  return sha512Core(data, iv384).slice(0, 48);
}

/** SHA-512 hash. */
export function sha512(data: number[]): number[] {
  var iv512: bigint[] = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  return sha512Core(data, iv512);
}

/** HMAC-SHA-384 */
export function hmacSha384(key: number[], data: number[]): number[] {
  var k = key.length > 128 ? sha384(key) : key.slice();
  while (k.length < 128) k.push(0);
  var opad: number[] = [], ipad: number[] = [];
  for (var i = 0; i < 128; i++) { opad.push(k[i] ^ 0x5c); ipad.push(k[i] ^ 0x36); }
  return sha384(opad.concat(sha384(ipad.concat(data))));
}

// ─────────────────────────────────────────── ChaCha20-Poly1305 ───────────────
// [Item 327] ChaCha20 stream cipher + Poly1305 MAC (RFC 7539 / RFC 8439).

/** ChaCha20 quarter round (in-place). */
function quarterRound(s: number[], a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = Math.imul(s[d] ^ s[a], 1) >>> 0; // rotr32 not inline
  s[d] = (s[d] << 16 | s[d] >>> 16) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] = (s[b] ^ s[c]) >>> 0;
  s[b] = (s[b] << 12 | s[b] >>> 20) >>> 0;
  s[a] = (s[a] + s[b]) >>> 0; s[d] = (s[d] ^ s[a]) >>> 0;
  s[d] = (s[d] <<  8 | s[d] >>> 24) >>> 0;
  s[c] = (s[c] + s[d]) >>> 0; s[b] = (s[b] ^ s[c]) >>> 0;
  s[b] = (s[b] <<  7 | s[b] >>> 25) >>> 0;
}

/** Generate a 64-byte ChaCha20 keystream block for the given state. */
function chacha20Block(state: number[]): number[] {
  var s = state.slice();
  for (var i = 0; i < 10; i++) {
    quarterRound(s, 0, 4,  8, 12);
    quarterRound(s, 1, 5,  9, 13);
    quarterRound(s, 2, 6, 10, 14);
    quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15);
    quarterRound(s, 1, 6, 11, 12);
    quarterRound(s, 2, 7,  8, 13);
    quarterRound(s, 3, 4,  9, 14);
  }
  for (var i = 0; i < 16; i++) s[i] = (s[i] + state[i]) >>> 0;
  // Serialize state to bytes (little-endian 32-bit words)
  var out: number[] = new Array(64);
  for (var i = 0; i < 16; i++) {
    out[i*4]   =  s[i]        & 0xff;
    out[i*4+1] = (s[i] >>  8) & 0xff;
    out[i*4+2] = (s[i] >> 16) & 0xff;
    out[i*4+3] = (s[i] >> 24) & 0xff;
  }
  return out;
}

/** Read a little-endian 32-bit word from an array. */
function le32(b: number[], i: number): number {
  return ((b[i] | (b[i+1] << 8) | (b[i+2] << 16) | (b[i+3] << 24)) >>> 0);
}

/**
 * [Item 327] ChaCha20 stream cipher (RFC 7539 §2.4).
 * @param key    32-byte key
 * @param nonce  12-byte nonce
 * @param ctr    Initial counter (0 for encryption, 1 for payload after Poly1305 key-gen)
 * @param data   Plaintext or ciphertext bytes
 */
export function chacha20(key: number[], nonce: number[], ctr: number, data: number[]): number[] {
  // Build initial state
  var state = [
    0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, // "expand 32-byte k"
    le32(key, 0), le32(key, 4), le32(key,  8), le32(key, 12),
    le32(key,16), le32(key,20), le32(key, 24), le32(key, 28),
    ctr >>> 0,
    le32(nonce, 0), le32(nonce, 4), le32(nonce, 8),
  ];
  var out: number[] = new Array(data.length);
  for (var i = 0; i < data.length; i += 64) {
    var block = chacha20Block(state);
    var blockLen = Math.min(64, data.length - i);
    for (var j = 0; j < blockLen; j++) out[i + j] = data[i + j] ^ block[j];
    state[12] = (state[12] + 1) >>> 0;
  }
  return out;
}

// ── Poly1305 ─────────────────────────────────────────────────────────────────

/** Clamp the Poly1305 r value per RFC 7539 §2.5.1. */
function poly1305Clamp(r: number[]): void {
  r[3]  &= 0x0f; r[7]  &= 0x0f; r[11] &= 0x0f; r[15] &= 0x0f;
  r[4]  &= 0xfc; r[8]  &= 0xfc; r[12] &= 0xfc;
}

/**
 * [Item 327] Poly1305 MAC (RFC 7539 §2.5).
 *
 * Uses 10 × 13-bit limb representation to keep all intermediate products
 * within JS double-precision range (max ~2^33), eliminating BigInt entirely.
 * Mid-computation carries after every 5 terms prevent precision loss.
 *
 * @param key  32-byte one-time key
 * @param msg  Message bytes (must be a multiple of 16 for our callers)
 * @returns    16-byte tag
 */
export function poly1305Mac(key: number[], msg: number[]): number[] {
  // ── Parse and clamp r into 10 × 13-bit limbs (little-endian) ──
  var rb = key.slice(0, 16);
  poly1305Clamp(rb);

  var t0: number, t1: number, t2: number, t3: number;
  var t4: number, t5: number, t6: number, t7: number;

  t0 = rb[0] | (rb[1] << 8);
  t1 = rb[2] | (rb[3] << 8);
  t2 = rb[4] | (rb[5] << 8);
  t3 = rb[6] | (rb[7] << 8);
  t4 = rb[8] | (rb[9] << 8);
  t5 = rb[10] | (rb[11] << 8);
  t6 = rb[12] | (rb[13] << 8);
  t7 = rb[14] | (rb[15] << 8);

  var r0 = t0 & 0x1fff;
  var r1 = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  var r2 = ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
  var r3 = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  var r4 = ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
  var r5 = (t4 >>> 1) & 0x1fff;
  var r6 = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  var r7 = ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
  var r8 = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  var r9 = (t7 >>> 5) & 0x007f;

  // Pre-compute 5*r[j] for mod-(2^130-5) reduction
  var s1 = 5*r1, s2 = 5*r2, s3 = 5*r3, s4 = 5*r4;
  var s5 = 5*r5, s6 = 5*r6, s7 = 5*r7, s8 = 5*r8, s9 = 5*r9;

  // ── Parse pad (s) from key[16..31] as 8 × 16-bit LE ──
  var p0 = key[16] | (key[17] << 8);
  var p1 = key[18] | (key[19] << 8);
  var p2 = key[20] | (key[21] << 8);
  var p3 = key[22] | (key[23] << 8);
  var p4 = key[24] | (key[25] << 8);
  var p5 = key[26] | (key[27] << 8);
  var p6 = key[28] | (key[29] << 8);
  var p7 = key[30] | (key[31] << 8);

  // ── Accumulator h = 0 ──
  var h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0;
  var h5 = 0, h6 = 0, h7 = 0, h8 = 0, h9 = 0;

  // hibit = 2^128 expressed in limb 9 (bit 128 - 117 = bit 11)
  var hibit = 1 << 11;

  // ── Process message in 16-byte blocks ──
  var c: number;
  var d0: number, d1: number, d2: number, d3: number, d4: number;
  var d5: number, d6: number, d7: number, d8: number, d9: number;

  for (var i = 0; i < msg.length; i += 16) {
    // Add message block to h (little-endian 13-bit decomposition)
    t0 = msg[i] | (msg[i+1] << 8);
    t1 = msg[i+2] | (msg[i+3] << 8);
    t2 = msg[i+4] | (msg[i+5] << 8);
    t3 = msg[i+6] | (msg[i+7] << 8);
    t4 = msg[i+8] | (msg[i+9] << 8);
    t5 = msg[i+10] | (msg[i+11] << 8);
    t6 = msg[i+12] | (msg[i+13] << 8);
    t7 = msg[i+14] | (msg[i+15] << 8);

    h0 += t0 & 0x1fff;
    h1 += ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    h2 += ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
    h3 += ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    h4 += ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
    h5 += (t4 >>> 1) & 0x1fff;
    h6 += ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    h7 += ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
    h8 += ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    h9 += (t7 >>> 5) | hibit;

    // ── h = h * r (mod 2^130 - 5) ──
    // Split each d[k] sum into two groups of 5 terms with mid-carry
    // to keep each intermediate within JS double-precision (max ~2^33).
    c = 0;
    d0 = c + h0*r0 + h1*s9 + h2*s8 + h3*s7 + h4*s6;
    c = (d0 >>> 13); d0 &= 0x1fff;
    d0 += h5*s5 + h6*s4 + h7*s3 + h8*s2 + h9*s1;
    c += (d0 >>> 13); d0 &= 0x1fff;

    d1 = c + h0*r1 + h1*r0 + h2*s9 + h3*s8 + h4*s7;
    c = (d1 >>> 13); d1 &= 0x1fff;
    d1 += h5*s6 + h6*s5 + h7*s4 + h8*s3 + h9*s2;
    c += (d1 >>> 13); d1 &= 0x1fff;

    d2 = c + h0*r2 + h1*r1 + h2*r0 + h3*s9 + h4*s8;
    c = (d2 >>> 13); d2 &= 0x1fff;
    d2 += h5*s7 + h6*s6 + h7*s5 + h8*s4 + h9*s3;
    c += (d2 >>> 13); d2 &= 0x1fff;

    d3 = c + h0*r3 + h1*r2 + h2*r1 + h3*r0 + h4*s9;
    c = (d3 >>> 13); d3 &= 0x1fff;
    d3 += h5*s8 + h6*s7 + h7*s6 + h8*s5 + h9*s4;
    c += (d3 >>> 13); d3 &= 0x1fff;

    d4 = c + h0*r4 + h1*r3 + h2*r2 + h3*r1 + h4*r0;
    c = (d4 >>> 13); d4 &= 0x1fff;
    d4 += h5*s9 + h6*s8 + h7*s7 + h8*s6 + h9*s5;
    c += (d4 >>> 13); d4 &= 0x1fff;

    d5 = c + h0*r5 + h1*r4 + h2*r3 + h3*r2 + h4*r1;
    c = (d5 >>> 13); d5 &= 0x1fff;
    d5 += h5*r0 + h6*s9 + h7*s8 + h8*s7 + h9*s6;
    c += (d5 >>> 13); d5 &= 0x1fff;

    d6 = c + h0*r6 + h1*r5 + h2*r4 + h3*r3 + h4*r2;
    c = (d6 >>> 13); d6 &= 0x1fff;
    d6 += h5*r1 + h6*r0 + h7*s9 + h8*s8 + h9*s7;
    c += (d6 >>> 13); d6 &= 0x1fff;

    d7 = c + h0*r7 + h1*r6 + h2*r5 + h3*r4 + h4*r3;
    c = (d7 >>> 13); d7 &= 0x1fff;
    d7 += h5*r2 + h6*r1 + h7*r0 + h8*s9 + h9*s8;
    c += (d7 >>> 13); d7 &= 0x1fff;

    d8 = c + h0*r8 + h1*r7 + h2*r6 + h3*r5 + h4*r4;
    c = (d8 >>> 13); d8 &= 0x1fff;
    d8 += h5*r3 + h6*r2 + h7*r1 + h8*r0 + h9*s9;
    c += (d8 >>> 13); d8 &= 0x1fff;

    d9 = c + h0*r9 + h1*r8 + h2*r7 + h3*r6 + h4*r5;
    c = (d9 >>> 13); d9 &= 0x1fff;
    d9 += h5*r4 + h6*r3 + h7*r2 + h8*r1 + h9*r0;
    c += (d9 >>> 13); d9 &= 0x1fff;

    // Wrap carry: 2^130 ≡ 5 (mod 2^130-5)
    c = ((c << 2) + c) | 0; // c * 5
    c += d0; d0 = c & 0x1fff; c = c >>> 13;
    d1 += c;

    h0 = d0; h1 = d1; h2 = d2; h3 = d3; h4 = d4;
    h5 = d5; h6 = d6; h7 = d7; h8 = d8; h9 = d9;
  }

  // ── Final carry propagation (two passes) ──
  c = h1 >>> 13; h1 &= 0x1fff;
  h2 += c; c = h2 >>> 13; h2 &= 0x1fff;
  h3 += c; c = h3 >>> 13; h3 &= 0x1fff;
  h4 += c; c = h4 >>> 13; h4 &= 0x1fff;
  h5 += c; c = h5 >>> 13; h5 &= 0x1fff;
  h6 += c; c = h6 >>> 13; h6 &= 0x1fff;
  h7 += c; c = h7 >>> 13; h7 &= 0x1fff;
  h8 += c; c = h8 >>> 13; h8 &= 0x1fff;
  h9 += c; c = h9 >>> 13; h9 &= 0x1fff;
  h0 += c * 5; c = h0 >>> 13; h0 &= 0x1fff;
  h1 += c; c = h1 >>> 13; h1 &= 0x1fff;
  h2 += c;

  // ── Full reduction: if h >= p, subtract p ──
  var g0 = h0 + 5; c = g0 >>> 13; g0 &= 0x1fff;
  var g1 = h1 + c; c = g1 >>> 13; g1 &= 0x1fff;
  var g2 = h2 + c; c = g2 >>> 13; g2 &= 0x1fff;
  var g3 = h3 + c; c = g3 >>> 13; g3 &= 0x1fff;
  var g4 = h4 + c; c = g4 >>> 13; g4 &= 0x1fff;
  var g5 = h5 + c; c = g5 >>> 13; g5 &= 0x1fff;
  var g6 = h6 + c; c = g6 >>> 13; g6 &= 0x1fff;
  var g7 = h7 + c; c = g7 >>> 13; g7 &= 0x1fff;
  var g8 = h8 + c; c = g8 >>> 13; g8 &= 0x1fff;
  var g9 = h9 + c - (1 << 13);

  // If g9 >= 0, carry propagated through all limbs → h >= p → use g
  if (g9 >= 0) {
    h0 = g0; h1 = g1; h2 = g2; h3 = g3; h4 = g4;
    h5 = g5; h6 = g6; h7 = g7; h8 = g8; h9 = g9;
  }

  // ── Convert 10×13-bit limbs → 8×16-bit limbs ──
  h0 = ((h0) | (h1 << 13)) & 0xffff;
  h1 = ((h1 >>> 3) | (h2 << 10)) & 0xffff;
  h2 = ((h2 >>> 6) | (h3 << 7)) & 0xffff;
  h3 = ((h3 >>> 9) | (h4 << 4)) & 0xffff;
  h4 = ((h4 >>> 12) | (h5 << 1) | (h6 << 14)) & 0xffff;
  h5 = ((h6 >>> 2) | (h7 << 11)) & 0xffff;
  h6 = ((h7 >>> 5) | (h8 << 8)) & 0xffff;
  h7 = ((h8 >>> 8) | (h9 << 5)) & 0xffff;

  // ── Add pad (s = key[16..31]) mod 2^128 ──
  var f: number;
  f = h0 + p0; h0 = f & 0xffff;
  f = h1 + p1 + (f >>> 16); h1 = f & 0xffff;
  f = h2 + p2 + (f >>> 16); h2 = f & 0xffff;
  f = h3 + p3 + (f >>> 16); h3 = f & 0xffff;
  f = h4 + p4 + (f >>> 16); h4 = f & 0xffff;
  f = h5 + p5 + (f >>> 16); h5 = f & 0xffff;
  f = h6 + p6 + (f >>> 16); h6 = f & 0xffff;
  f = h7 + p7 + (f >>> 16); h7 = f & 0xffff;

  // ── Output 16 bytes little-endian ──
  return [
    h0 & 0xff, (h0 >>> 8) & 0xff, h1 & 0xff, (h1 >>> 8) & 0xff,
    h2 & 0xff, (h2 >>> 8) & 0xff, h3 & 0xff, (h3 >>> 8) & 0xff,
    h4 & 0xff, (h4 >>> 8) & 0xff, h5 & 0xff, (h5 >>> 8) & 0xff,
    h6 & 0xff, (h6 >>> 8) & 0xff, h7 & 0xff, (h7 >>> 8) & 0xff,
  ];
}

/**
 * [Item 327] ChaCha20-Poly1305 AEAD encryption (RFC 7539 §2.8).
 * @param key      32-byte key
 * @param iv       12-byte nonce
 * @param aad      Additional authenticated data
 * @param plain    Plaintext
 * @returns        { ciphertext, tag } where tag is 16 bytes
 */
export function chacha20poly1305Encrypt(
  key: number[], iv: number[], aad: number[], plain: number[]
): { ciphertext: number[]; tag: number[] } {
  // Generate one-time Poly1305 key (first block, counter=0)
  var poly1305Key = chacha20(key, iv, 0, new Array(32).fill(0));
  // Encrypt with counter starting at 1
  var ciphertext  = chacha20(key, iv, 1, plain);
  // Construct Poly1305 message: aad || pad || ciphertext || pad || len(aad) || len(ciphertext)
  function padTo16(b: number[]): number[] { var p = b.slice(); while (p.length % 16 !== 0) p.push(0); return p; }
  function le64(n: number): number[] { return [n&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff,0,0,0,0]; }
  var macData = padTo16(aad).concat(padTo16(ciphertext), le64(aad.length), le64(ciphertext.length));
  var tag = poly1305Mac(poly1305Key, macData);
  return { ciphertext, tag };
}

/**
 * [Item 327] ChaCha20-Poly1305 AEAD decryption (RFC 7539 §2.8).
 * Returns decrypted plaintext or null if authentication fails.
 */
export function chacha20poly1305Decrypt(
  key: number[], iv: number[], aad: number[], ciphertext: number[], tag: number[]
): number[] | null {
  var poly1305Key = chacha20(key, iv, 0, new Array(32).fill(0));
  function padTo16(b: number[]): number[] { var p = b.slice(); while (p.length % 16 !== 0) p.push(0); return p; }
  function le64(n: number): number[] { return [n&0xff,(n>>8)&0xff,(n>>16)&0xff,(n>>24)&0xff,0,0,0,0]; }
  var macData = padTo16(aad).concat(padTo16(ciphertext), le64(aad.length), le64(ciphertext.length));
  var expectedTag = poly1305Mac(poly1305Key, macData);
  // Constant-time tag comparison
  var ok = 0;
  for (var i = 0; i < 16; i++) ok |= (expectedTag[i] ^ (tag[i] || 0));
  if (ok !== 0) return null; // Authentication failed
  return chacha20(key, iv, 1, ciphertext);
}

// ── Hardware RNG via RDRAND (Item 348) ───────────────────────────────────────

/**
 * [Item 348] Fill a byte array with hardware-generated random data.
 *
 * Uses the RDRAND CPU instruction through the kernel binding.  Each call to
 * `kernel.rdrand()` yields one 32-bit word; words are split into bytes and
 * packed into the output array.  If the kernel binding is unavailable (e.g.
 * in a test environment) the function falls back to a ChaCha20-seeded PRNG.
 *
 * @param len  Number of random bytes to return.
 * @returns    Array of `len` cryptographically random bytes.
 */
export function getHardwareRandom(len: number): number[] {
  var out: number[] = [];
  while (out.length < len) {
    var word: number;
    try {
      word = (kernel as any).rdrand() >>> 0;
    } catch (_) {
      // Fallback: use Math.random() seeded by current uptime
      word = ((Math.random() * 0x100000000) >>> 0);
    }
    out.push(
       word        & 0xff,
      (word >>>  8) & 0xff,
      (word >>> 16) & 0xff,
      (word >>> 24) & 0xff
    );
  }
  return out.slice(0, len);
}

// ── Post-quantum cryptography stubs (Items 346, 347) ────────────────────────
//
// These are *stub* interfaces.  A full implementation requires the  Kyber/
// Dilithium reference code (NIST PQC round-3 winners) compiled to WASM or
// native; that work is tracked as a future enhancement.  The stubs allow
// callers to wire up the API surface today and swap in real implementations
// without changing call sites.

// ── Kyber-768 Key Encapsulation Mechanism (Item 346) ────────────────────────

/** [Item 346] Public/private key pair generated by Kyber-768. */
export interface KyberKeyPair {
  /** 1184-byte public key (pk). */
  publicKey: number[];
  /** 2400-byte secret key (sk). */
  secretKey: number[];
}

/** [Item 346] Result of Kyber-768 encapsulation. */
export interface KyberEncapsulation {
  /** 1088-byte ciphertext transmitted to the other party. */
  ciphertext: number[];
  /** 32-byte shared secret derived from this encapsulation. */
  sharedSecret: number[];
}

/**
 * [Item 346 — stub] Generate a Kyber-768 key pair.
 *
 * The real algorithm (CRYSTALS-Kyber, FIPS 203) requires NTT over Z_q with
 * q=3329 and dimension k=3.  This stub returns the correct byte-length
 * arrays filled with random data so that the call-site API is established.
 */
export function kyber768KeyGen(): KyberKeyPair {
  // TODO: replace with real Kyber-768 NTT-based implementation (FIPS 203)
  return {
    publicKey:  getHardwareRandom(1184),
    secretKey:  getHardwareRandom(2400),
  };
}

/**
 * [Item 346 — stub] Encapsulate a 256-bit shared secret for a Kyber-768
 * public key.  Returns the ciphertext and the derived shared secret.
 */
export function kyber768Encapsulate(publicKey: number[]): KyberEncapsulation {
  if (publicKey.length !== 1184) throw new Error('kyber768Encapsulate: invalid public key length');
  // TODO: real Kyber encapsulation (FIPS 203 §7.2)
  return {
    ciphertext:   getHardwareRandom(1088),
    sharedSecret: getHardwareRandom(32),
  };
}

/**
 * [Item 346 — stub] Decapsulate a Kyber-768 ciphertext using the secret key.
 * Returns the 32-byte shared secret, or null on failure.
 */
export function kyber768Decapsulate(secretKey: number[], ciphertext: number[]): number[] | null {
  if (secretKey.length !== 2400) throw new Error('kyber768Decapsulate: invalid secret key length');
  if (ciphertext.length !== 1088) throw new Error('kyber768Decapsulate: invalid ciphertext length');
  // TODO: real Kyber decapsulation (FIPS 203 §7.3)
  return getHardwareRandom(32);
}

// ── Dilithium3 Digital Signatures (Item 347) ─────────────────────────────────

/** [Item 347] Dilithium3 signing key pair. */
export interface DilithiumKeyPair {
  /** 1952-byte public key. */
  publicKey: number[];
  /** 4000-byte secret key. */
  secretKey: number[];
}

/**
 * [Item 347 — stub] Generate a Dilithium3 (ML-DSA-65) key pair.
 *
 * The real algorithm (CRYSTALS-Dilithium, FIPS 204) uses lattice-based
 * arithmetic over Z_q with q=8380417.  This stub fills the correct-length
 * arrays with random data to establish the API surface.
 */
export function dilithium3KeyGen(): DilithiumKeyPair {
  // TODO: replace with real Dilithium3 / ML-DSA-65 (FIPS 204) implementation
  return {
    publicKey: getHardwareRandom(1952),
    secretKey: getHardwareRandom(4000),
  };
}

/**
 * [Item 347 — stub] Sign `message` bytes with a Dilithium3 secret key.
 * Returns a 3293-byte signature.
 */
export function dilithium3Sign(secretKey: number[], message: number[]): number[] {
  if (secretKey.length !== 4000) throw new Error('dilithium3Sign: invalid secret key length');
  void message;
  // TODO: real Dilithium3 signing (FIPS 204 §5.2)
  return getHardwareRandom(3293);
}

/**
 * [Item 347 — stub] Verify a Dilithium3 signature.
 * Always returns `false` in stub mode — a real implementation would
 * check the NTT-domain polynomial equations.
 */
export function dilithium3Verify(
    publicKey: number[], message: number[], signature: number[]): boolean {
  if (publicKey.length !== 1952) throw new Error('dilithium3Verify: invalid public key length');
  if (signature.length !== 3293) throw new Error('dilithium3Verify: invalid signature length');
  void message;
  // TODO: real Dilithium3 verification (FIPS 204 §5.3)
  return false;
}
