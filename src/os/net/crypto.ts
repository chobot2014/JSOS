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
  // Padding
  var msg = data.slice();
  var bitLen = data.length * 8;
  msg.push(0x80);
  while ((msg.length % 64) !== 56) msg.push(0);
  // 64-bit big-endian bit length
  msg.push(0); msg.push(0); msg.push(0); msg.push(0); // high 32 bits
  msg.push((bitLen >>> 24) & 0xff);
  msg.push((bitLen >>> 16) & 0xff);
  msg.push((bitLen >>>  8) & 0xff);
  msg.push( bitLen         & 0xff);

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

  var ipad: number[] = new Array(64);
  var opad: number[] = new Array(64);
  for (var i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  return sha256(opad.concat(sha256(ipad.concat(data))));
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
  // Returns 176 bytes = 11 round keys × 16 bytes
  var ek = key.slice();
  var i = 4; // already have 4 words (16 bytes)
  while (ek.length < 176) {
    var base = ek.length - 4;
    var prev4 = [ek[base], ek[base+1], ek[base+2], ek[base+3]];
    if ((i & 3) === 0) {
      // RotWord + SubWord + Rcon
      var t0 = prev4[0];
      prev4[0] = AES_SBOX[prev4[1]] ^ AES_RCON[i >> 2];
      prev4[1] = AES_SBOX[prev4[2]];
      prev4[2] = AES_SBOX[prev4[3]];
      prev4[3] = AES_SBOX[t0];
    }
    var base2 = ek.length - 16;
    ek.push(ek[base2]   ^ prev4[0]);
    ek.push(ek[base2+1] ^ prev4[1]);
    ek.push(ek[base2+2] ^ prev4[2]);
    ek.push(ek[base2+3] ^ prev4[3]);
    i++;
  }
  return ek;
}

export function aesEncryptBlock(block: number[], ek: number[]): number[] {
  var s = block.slice();
  // AddRoundKey 0
  for (var i = 0; i < 16; i++) s[i] ^= ek[i];
  for (var rnd = 1; rnd < 11; rnd++) {
    // SubBytes
    for (var i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    // ShiftRows
    var t: number[] = s.slice();
    s[1]=t[5];s[5]=t[9];s[9]=t[13];s[13]=t[1];
    s[2]=t[10];s[6]=t[14];s[10]=t[2];s[14]=t[6];
    s[3]=t[15];s[7]=t[3];s[11]=t[7];s[15]=t[11];
    // MixColumns (skip in last round)
    if (rnd < 10) {
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

/** Multiply two 128-bit values in GF(2^128) with polynomial x^128+x^7+x^2+x+1 */
function ghashMul(X: bigint, Y: bigint): bigint {
  const R = BigInt('0xe1000000000000000000000000000000') << BigInt(0); // 0xe1 << 120
  const MASK128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  const R128 = BigInt('0xe1') << BigInt(120);
  var Z = BigInt(0);
  var V = X & MASK128;
  var yBits = Y;
  for (var i = 0; i < 128; i++) {
    if ((yBits >> BigInt(127)) & BigInt(1)) Z ^= V;
    var lsb = V & BigInt(1);
    V = V >> BigInt(1);
    if (lsb) V ^= R128;
    yBits = (yBits << BigInt(1)) & MASK128;
  }
  return Z;
}

function bytesToBigInt128(b: number[], off: number): bigint {
  var v = BigInt(0);
  for (var i = 0; i < 16; i++) {
    v = (v << BigInt(8)) | BigInt(b[off + i] & 0xff);
  }
  return v;
}

function bigInt128ToBytes(v: bigint): number[] {
  var out: number[] = new Array(16);
  var mask = BigInt(0xff);
  for (var i = 15; i >= 0; i--) {
    out[i] = Number(v & mask);
    v >>= BigInt(8);
  }
  return out;
}

function ghash(H: bigint, aad: number[], ciphertext: number[], MASK128: bigint): number[] {
  var Y = BigInt(0);
  // Process AAD (padded to 16 bytes)
  function processBlock(data: number[], off: number, len: number): void {
    var block: number[] = new Array(16).fill(0);
    for (var i = 0; i < len; i++) block[i] = data[off + i];
    Y = ghashMul(Y ^ bytesToBigInt128(block, 0), H);
  }
  var i = 0;
  while (i + 16 <= aad.length) { processBlock(aad, i, 16); i += 16; }
  if (i < aad.length) processBlock(aad, i, aad.length - i);
  i = 0;
  while (i + 16 <= ciphertext.length) { processBlock(ciphertext, i, 16); i += 16; }
  if (i < ciphertext.length) processBlock(ciphertext, i, ciphertext.length - i);
  // Lengths block
  var lenBlock = new Array(16).fill(0);
  var aadBits = aad.length * 8;
  var ctBits  = ciphertext.length * 8;
  lenBlock[4]  = (aadBits >>> 24) & 0xff;
  lenBlock[5]  = (aadBits >>> 16) & 0xff;
  lenBlock[6]  = (aadBits >>>  8) & 0xff;
  lenBlock[7]  =  aadBits         & 0xff;
  lenBlock[12] = (ctBits >>> 24) & 0xff;
  lenBlock[13] = (ctBits >>> 16) & 0xff;
  lenBlock[14] = (ctBits >>>  8) & 0xff;
  lenBlock[15] =  ctBits         & 0xff;
  Y = ghashMul(Y ^ bytesToBigInt128(lenBlock, 0), H);
  return bigInt128ToBytes(Y);
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
  var H = bytesToBigInt128(aesEncryptBlock(new Array(16).fill(0), ek), 0);
  var MASK128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  // Encrypt
  var ciphertext = gcmCtr(ek, iv, 2, plaintext);
  // GHASH
  var T = ghash(H, aad, ciphertext, MASK128);
  // E_k(J0) = AES_k(IV || 0x00000001)
  var j0 = gcmCtr(ek, iv, 1, T);
  return { ciphertext, tag: j0 };
}

export function gcmDecrypt(
    key: number[], iv: number[], aad: number[],
    ciphertext: number[], tag: number[]): number[] | null {
  var ek = aesKeyExpand(key);
  var H = bytesToBigInt128(aesEncryptBlock(new Array(16).fill(0), ek), 0);
  var MASK128 = (BigInt(1) << BigInt(128)) - BigInt(1);
  // Verify tag
  var T = ghash(H, aad, ciphertext, MASK128);
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

// ─────────────────────────────────────────────── Random key generation ────────

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Generate a 32-byte random private key using kernel tick entropy */
export function generateKey32(): number[] {
  var k: number[] = new Array(32);
  for (var i = 0; i < 32; i++) {
    // Mix tick counter with position for deterministic-but-varied bytes
    k[i] = (kernel.getTicks() * (i + 1) * 6364136223846793005 + 1442695040888963407) & 0xff;
    // Let time advance slightly for next byte
    if ((i & 3) === 0) {
      var t0 = kernel.getTicks();
      while (kernel.getTicks() === t0) { /* spin */ }
    }
  }
  k[0]  &= 248;
  k[31] &= 127;
  k[31] |= 64;
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
  // 128-bit big-endian bit length
  for (var i = 7; i >= 0; i--) msg.push(0, 0, 0, 0); // high 64 bits (always 0 for sane messages)
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
 * @param key  32-byte one-time key
 * @param msg  Message bytes
 * @returns    16-byte tag
 */
export function poly1305Mac(key: number[], msg: number[]): number[] {
  var rBytes = key.slice(0, 16);
  poly1305Clamp(rBytes);
  var r = BigInt('0x' + rBytes.slice().reverse().map(function(b: number) {
    return (b & 0xff).toString(16).padStart(2, '0');
  }).join(''));
  var s = BigInt('0x' + key.slice(16, 32).reverse().map(function(b: number) {
    return (b & 0xff).toString(16).padStart(2, '0');
  }).join(''));
  var P = (1n << 130n) - 5n;
  var acc = 0n;
  for (var i = 0; i < msg.length; i += 16) {
    var chunk = msg.slice(i, i + 16);
    while (chunk.length < 16) chunk.push(0);
    var n = BigInt('0x' + chunk.slice().reverse().map(function(b: number) {
      return (b & 0xff).toString(16).padStart(2, '0');
    }).join('')) + (1n << BigInt(chunk.length * 8 <= 128 ? chunk.length * 8 : 128));
    acc = ((acc + n) * r) % P;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  // Encode 16 bytes little-endian
  var tag: number[] = [];
  for (var i = 0; i < 16; i++) { tag.push(Number(acc & 0xffn)); acc >>= 8n; }
  return tag;
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
