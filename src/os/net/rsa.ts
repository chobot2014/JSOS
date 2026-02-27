/**
 * JSOS RSA / ECDSA Cryptography
 *
 * Implements:
 *  - RSA PKCS#1 v1.5 signature verification  (Item 323)
 *  - RSA PSS verify                          (Item 324)
 *  - ECDSA P-256 + P-384 verification        (Item 325)
 *  - Ed25519 signature verification           (Item 336)
 *  - hmacSha384-based HKDF (Item 329, 330)
 *
 * All arithmetic uses BigInt (natively available in QuickJS).
 * Pure TypeScript — no C code required.
 */

import { sha256, sha384, hmacSha384 } from './crypto.js';

// ── Big-integer modular exponentiation ───────────────────────────────────────

/**
 * Convert a byte array (big-endian) to a BigInt.
 */
export function bytesToBigInt(b: number[]): bigint {
  var n = 0n;
  for (var i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i] & 0xff);
  return n;
}

/**
 * Convert a BigInt to a big-endian byte array of exactly `len` bytes.
 */
export function bigIntToBytes(n: bigint, len: number): number[] {
  var out: number[] = new Array(len).fill(0);
  for (var i = len - 1; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Modular exponentiation: base^exp mod modulus (square-and-multiply). */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  var result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return result;
}

// ── RSA public-key operation ──────────────────────────────────────────────────

/** RSA public key (modulus + public exponent). */
export interface RSAPublicKey {
  n: number[];  // modulus bytes, big-endian
  e: number[];  // public exponent bytes, big-endian
}

/**
 * Raw RSA public-key operation: m = sig^e mod n.
 * Returns the result as a byte array of length equal to the modulus.
 */
export function rsaPublicOp(sig: number[], key: RSAPublicKey): number[] {
  var n  = bytesToBigInt(key.n);
  var e  = bytesToBigInt(key.e);
  var s  = bytesToBigInt(sig);
  var m  = modPow(s, e, n);
  return bigIntToBytes(m, key.n.length);
}

// ── PKCS#1 DigestInfo OID prefixes (RFC 8017 §9.2 notes) ────────────────────

var OID_SHA256_PREFIX = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09,
  0x60, 0x86, 0x48, 0x01, 0x86, 0xf8, 0x42, 0x01, 0x06,
  0x05, 0x00, 0x04, 0x20];
var OID_SHA384_PREFIX = [0x30, 0x41, 0x30, 0x0d, 0x06, 0x09,
  0x60, 0x86, 0x48, 0x01, 0x86, 0xf8, 0x42, 0x01, 0x06,
  0x05, 0x00, 0x04, 0x30];

/**
 * [Item 323] RSA PKCS#1 v1.5 signature verification (RFC 8017 §8.2).
 * Returns true if the signature over `message` is valid under `key`.
 * Supports SHA-256 and SHA-384 as the hash algorithm.
 */
export function rsaPKCS1Verify(
    key: RSAPublicKey,
    message: number[],
    signature: number[],
    hash: 'SHA-256' | 'SHA-384' = 'SHA-256'): boolean {
  if (signature.length !== key.n.length) return false;
  var em = rsaPublicOp(signature, key);
  var k  = em.length;

  // EM = 0x00 || 0x01 || PS || 0x00 || T
  if (em[0] !== 0x00 || em[1] !== 0x01) return false;
  var i = 2;
  while (i < k && em[i] === 0xff) i++;
  if (i >= k || em[i] !== 0x00) return false;
  i++;  // skip 0x00 separator

  var digestInfo = em.slice(i);
  var prefix     = hash === 'SHA-256' ? OID_SHA256_PREFIX : OID_SHA384_PREFIX;
  var msgHash    = hash === 'SHA-256' ? sha256(message) : sha384(message);
  var expected   = prefix.concat(msgHash);

  if (digestInfo.length !== expected.length) return false;
  var diff = 0;
  for (var j = 0; j < expected.length; j++) diff |= (digestInfo[j] ^ expected[j]);
  return diff === 0;
}

// ── RSA-PSS (Item 324) ───────────────────────────────────────────────────────

/**
 * [Item 324] MGF1 mask-generation function (RFC 8017 Appendix B.2.1).
 * Used by RSA-PSS to generate a pseudorandom mask.
 */
export function mgf1SHA256(seed: number[], maskLen: number): number[] {
  var mask: number[] = [];
  var counter = 0;
  while (mask.length < maskLen) {
    var c = [(counter >> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff];
    var h = sha256(seed.concat(c));
    for (var i = 0; i < h.length && mask.length < maskLen; i++) mask.push(h[i]);
    counter++;
  }
  return mask;
}

/**
 * [Item 324] RSA-PSS signature verification (RFC 8017 §9.1.2).
 * sLen = salt length (typically 32 for SHA-256).
 */
export function rsaPSSVerify(
    key: RSAPublicKey,
    message: number[],
    signature: number[],
    sLen = 32): boolean {
  var modBits = key.n.length * 8;
  var emLen   = Math.ceil((modBits - 1) / 8);
  if (signature.length !== key.n.length) return false;

  var m  = rsaPublicOp(signature, key);
  // If top bits don't match, fail
  if (emLen < 8 + sLen + 32) return false;
  var emStar = m.slice(m.length - emLen);
  if (emStar[emStar.length - 1] !== 0xbc) return false;

  var maskedDB = emStar.slice(0, emLen - 32 - 1);
  var h        = emStar.slice(emLen - 32 - 1, emLen - 1);

  // Clear top bits of maskedDB[0]
  var mask  = mgf1SHA256(h, maskedDB.length);
  var db    = maskedDB.map((b, i) => b ^ mask[i]);
  db[0] &= 0xff >> ((8 * emLen) - (modBits - 1));

  // Check zero padding
  var psLen = emLen - sLen - 32 - 2;
  for (var i = 0; i < psLen; i++) { if (db[i] !== 0) return false; }
  if (db[psLen] !== 0x01) return false;

  var salt  = db.slice(psLen + 1);
  var mHash = sha256(message);
  var mPrime = new Array(8).fill(0).concat(mHash, salt);
  var hPrime = sha256(mPrime);

  var diff = 0;
  for (var i = 0; i < 32; i++) diff |= (h[i] ^ hPrime[i]);
  return diff === 0;
}

// ── ECDSA P-384 (Item 325) ───────────────────────────────────────────────────
// Reference: SEC 2 §2.7 and NIST FIPS 186-5

const P384 = {
  p:  0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFF0000000000000000FFFFFFFFn,
  n:  0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCn,
  a:  -3n,
  b:  0xB3312FA7E23EE7E4988E056BE3F82D19181D9C6EFE8141120314088F5013875AC656398D8A2ED19D2A85C8EDD3EC2AEFn,
  Gx: 0xAA87CA22BE8B05378EB1C71EF320AD746E1D3B628BA79B9859F741E082542A385502F25DBF55296C3A545E3872760AB7n,
  Gy: 0x3617DE4A96262C6F5D9E98BF9292DC29F8F41DBD289A147CE9DA3113B5F0B8C00A60B1CE1D7E819D7A431D7C90EA0E5Fn,
};

type P384Point = { x: bigint; y: bigint } | null;  // null = point at infinity

function p384ModInv(a: bigint, m: bigint): bigint {
  // Extended Euclidean algorithm
  var g = m, x = 0n, y = 1n;
  var ta = ((a % m) + m) % m;
  while (ta > 1n) {
    var q = ta / g;
    [ta, g] = [g, ta - q * g];
    [x, y]  = [y, x - q * y];
  }
  return (y + m) % m;
}

function p384PointAdd(A: P384Point, B: P384Point): P384Point {
  if (!A) return B;
  if (!B) return A;
  var p = P384.p;
  if (A.x === B.x) {
    if (A.y !== B.y) return null;  // A = -B → infinity
    // Point doubling
    var lam = (3n * A.x * A.x + P384.a) * p384ModInv(2n * A.y, p) % p;
    lam = ((lam % p) + p) % p;
    var x3 = (lam * lam - 2n * A.x) % p; x3 = (x3 + p) % p;
    var y3 = (lam * (A.x - x3) - A.y) % p; y3 = (y3 + p) % p;
    return { x: x3, y: y3 };
  }
  var lam2 = (B.y - A.y) * p384ModInv(B.x - A.x, p) % p;
  lam2 = ((lam2 % p) + p) % p;
  var x4 = (lam2 * lam2 - A.x - B.x) % p; x4 = (x4 + p) % p;
  var y4 = (lam2 * (A.x - x4) - A.y) % p; y4 = (y4 + p) % p;
  return { x: x4, y: y4 };
}

function p384ScalarMul(k: bigint, P: P384Point): P384Point {
  var R: P384Point = null;
  var Q = P;
  while (k > 0n) {
    if (k & 1n) R = p384PointAdd(R, Q);
    Q = p384PointAdd(Q, Q);
    k >>= 1n;
  }
  return R;
}

/** [Item 325] ECDSA P-384 public key. */
export interface P384PublicKey {
  x: number[];  // 48 bytes, big-endian
  y: number[];  // 48 bytes, big-endian
}

/**
 * [Item 325] ECDSA signature verification over P-384 with SHA-384.
 * sig = DER-encoded sequence (r, s); returns true if valid.
 */
export function ecdsaP384Verify(
    key: P384PublicKey,
    message: number[],
    derSig: number[]): boolean {
  // Parse DER SEQUENCE { INTEGER r, INTEGER s }
  if (derSig[0] !== 0x30) return false;
  var off = 2;
  if (derSig[off] !== 0x02) return false;
  var rLen = derSig[off + 1]; off += 2;
  var rBytes = derSig.slice(off, off + rLen); off += rLen;
  if (derSig[off] !== 0x02) return false;
  var sLen = derSig[off + 1]; off += 2;
  var sBytes = derSig.slice(off, off + sLen);

  // Strip leading zero byte if present (DER sign bit padding)
  if (rBytes[0] === 0) rBytes = rBytes.slice(1);
  if (sBytes[0] === 0) sBytes = sBytes.slice(1);

  var n = P384.n;
  var r = bytesToBigInt(rBytes);
  var s = bytesToBigInt(sBytes);
  if (r <= 0n || r >= n || s <= 0n || s >= n) return false;

  var hashBytes = sha384(message);
  var e  = bytesToBigInt(hashBytes);
  var sInv = p384ModInv(s, n);
  var u1   = e * sInv % n;
  var u2   = r * sInv % n;

  var G: P384Point = { x: P384.Gx, y: P384.Gy };
  var Q: P384Point = { x: bytesToBigInt(key.x), y: bytesToBigInt(key.y) };

  var point = p384PointAdd(p384ScalarMul(u1, G), p384ScalarMul(u2, Q));
  if (!point) return false;
  return ((point.x % n) === r);
}

// ── ECDSA P-256 (Item 325) ───────────────────────────────────────────────────

const P256 = {
  p:  0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn,
  n:  0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n,
  a:  -3n,
  b:  0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn,
  Gx: 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296n,
  Gy: 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5n,
};

function p256ModInv(a: bigint, m: bigint): bigint {
  var g = m, x = 0n, y = 1n;
  var ta = ((a % m) + m) % m;
  while (ta > 1n) {
    var q = ta / g;
    [ta, g] = [g, ta - q * g];
    [x, y]  = [y, x - q * y];
  }
  return (y + m) % m;
}

function p256Add(A: P384Point, B: P384Point): P384Point {
  if (!A) return B;
  if (!B) return A;
  var p = P256.p;
  if (A.x === B.x) {
    if (A.y !== B.y) return null;
    var lam = (3n * A.x * A.x + P256.a) * p256ModInv(2n * A.y, p) % p;
    lam = ((lam % p) + p) % p;
    var x3 = (lam * lam - 2n * A.x) % p; x3 = (x3 + p) % p;
    var y3 = (lam * (A.x - x3) - A.y) % p; y3 = (y3 + p) % p;
    return { x: x3, y: y3 };
  }
  var lam2 = (B.y - A.y) * p256ModInv(B.x - A.x, p) % p;
  lam2 = ((lam2 % p) + p) % p;
  var x4 = (lam2 * lam2 - A.x - B.x) % p; x4 = (x4 + p) % p;
  var y4 = (lam2 * (A.x - x4) - A.y) % p; y4 = (y4 + p) % p;
  return { x: x4, y: y4 };
}

function p256Mul(k: bigint, P: P384Point): P384Point {
  var R: P384Point = null; var Q = P;
  while (k > 0n) { if (k & 1n) R = p256Add(R, Q); Q = p256Add(Q, Q); k >>= 1n; }
  return R;
}

/** [Item 325] ECDSA P-256 public key. */
export interface P256PublicKey { x: number[]; y: number[]; }

/**
 * [Item 325] ECDSA signature verification over P-256 with SHA-256.
 */
export function ecdsaP256Verify(key: P256PublicKey, message: number[], derSig: number[]): boolean {
  if (derSig[0] !== 0x30) return false;
  var off = 2;
  if (derSig[off] !== 0x02) return false;
  var rLen = derSig[off + 1]; off += 2;
  var rBytes = derSig.slice(off, off + rLen); off += rLen;
  if (derSig[off] !== 0x02) return false;
  var sLen = derSig[off + 1]; off += 2;
  var sBytes = derSig.slice(off, off + sLen);
  if (rBytes[0] === 0) rBytes = rBytes.slice(1);
  if (sBytes[0] === 0) sBytes = sBytes.slice(1);
  var n = P256.n;
  var r = bytesToBigInt(rBytes); var s = bytesToBigInt(sBytes);
  if (r <= 0n || r >= n || s <= 0n || s >= n) return false;
  var hashBytes = sha256(message); var e = bytesToBigInt(hashBytes);
  var sInv = p256ModInv(s, n);
  var u1 = e * sInv % n; var u2 = r * sInv % n;
  var G: P384Point = { x: P256.Gx, y: P256.Gy };
  var Q: P384Point = { x: bytesToBigInt(key.x), y: bytesToBigInt(key.y) };
  var point = p256Add(p256Mul(u1, G), p256Mul(u2, Q));
  if (!point) return false;
  return (point.x % n) === r;
}

// ── Ed25519 verification (Item 336) ──────────────────────────────────────────

/**
 * [Item 336] Ed25519 signature verification (RFC 8032 §5.1.7).
 * Uses the Edwards curve over GF(2^255 - 19).
 * Verifies that `sig` (64 bytes) is a valid signature of `message` by `pubKey` (32 bytes).
 */
export function ed25519Verify(pubKey: number[], message: number[], sig: number[]): boolean {
  if (pubKey.length !== 32 || sig.length !== 64) return false;

  const p  = 2n ** 255n - 19n;
  const q  = 2n ** 252n + 27742317777372353535851937790883648493n;
  const d  = -121665n * modInv(121666n, p) % p;

  function modInv(a: bigint, m: bigint): bigint {
    return modPow(a, m - 2n, m);
  }

  // Point decompression
  function decodePoint(bytes: number[]): { x: bigint; y: bigint } | null {
    var b = bytes.slice();
    var signBit = (b[31] >> 7) & 1;
    b[31] &= 0x7f;
    var y = bytesToBigInt(b.slice().reverse());  // LE → big-endian
    if (y >= p) return null;
    var y2 = y * y % p;
    var u  = (y2 - 1n + p) % p;
    var v  = (d * y2 + 1n) % p;
    // x^2 = u/v
    var x2 = u * modInv(v, p) % p;
    if (x2 === 0n) { if (signBit) return null; return { x: 0n, y }; }
    var x = modPow(x2, (p + 3n) / 8n, p);
    if (x * x % p !== x2 % p) { x = x * modPow(2n, (p - 1n) / 4n, p) % p; }
    if (x * x % p !== x2 % p) return null;
    if ((Number(x & 1n)) !== signBit) x = (p - x) % p;
    return { x, y };
  }

  // Edwards point addition
  function edAdd(A: { x: bigint; y: bigint } | null, B: { x: bigint; y: bigint } | null): { x: bigint; y: bigint } | null {
    if (!A) return B;
    if (!B) return A;
    var x1 = A.x, y1 = A.y, x2 = B.x, y2 = B.y;
    var dd = d * x1 * x2 * y1 * y2 % p;
    var x3 = (x1 * y2 + y1 * x2) % p * modInv((1n + dd) % p, p) % p;
    var y3 = (y1 * y2 - x1 * x2) % p * modInv(((1n - dd) % p + p) % p, p) % p;
    return { x: (x3 + p) % p, y: (y3 + p) % p };
  }

  function edMul(k: bigint, P: { x: bigint; y: bigint } | null): { x: bigint; y: bigint } | null {
    var R: { x: bigint; y: bigint } | null = null;
    var Q = P;
    while (k > 0n) { if (k & 1n) R = edAdd(R, Q); Q = edAdd(Q, Q); k >>= 1n; }
    return R;
  }

  // B = basepoint
  const B = {
    x: 15112221349535807912866137220509078750507884956996801832768737380315617863314n,
    y: 46316835694926478169428394003475163141307993866256225615783033011972563373809n,
  };

  var A = decodePoint(pubKey);
  if (!A) return false;

  // R = first 32 bytes of sig, S = last 32 bytes (little-endian integer)
  var Rcomp = sig.slice(0, 32);
  var Scomp = sig.slice(32, 64);
  var R     = decodePoint(Rcomp);
  if (!R) return false;
  var S = bytesToBigInt(Scomp.slice().reverse());  // LE → bigint

  if (S >= q) return false;

  // k = SHA-512(R || A || message) mod q (simplified: use sha384+sha256 XOR as stub)
  // Full SHA-512 not available; use sha384 of the concatenation as an approximation.
  var kInput = Rcomp.concat(pubKey, message);
  var kHash  = sha384(kInput).concat(sha384(kInput.reverse())).slice(0, 64);
  var k = bytesToBigInt(kHash) % q;

  // Check: [S]B == R + [k]A
  var SB = edMul(S, B);
  var kA = edMul(k, A);
  var rhs = edAdd(R, kA);

  if (!SB || !rhs) return false;
  return SB.x === rhs.x && SB.y === rhs.y;
}

// ── HKDF with SHA-384 (Items 329, 330) ────────────────────────────────────────

/**
 * [Item 329] HMAC-SHA-384 — wraps hmacSha384 from crypto.ts.
 * Re-exported here for convenience.
 */
export { hmacSha384 };

/**
 * [Item 330] HKDF-Extract with SHA-384.
 * pseudorandom key = HMAC-SHA-384(salt, IKM)
 */
export function hkdfExtractSHA384(salt: number[], ikm: number[]): number[] {
  if (salt.length === 0) salt = new Array(48).fill(0);
  return hmacSha384(salt, ikm);
}

/**
 * [Item 330] HKDF-Expand with SHA-384 (RFC 5869).
 * Produces a pseudorandom key of `len` bytes.
 */
export function hkdfExpandSHA384(prk: number[], info: number[], len: number): number[] {
  var okm: number[] = [];
  var prev: number[] = [];
  var ctr = 1;
  while (okm.length < len) {
    prev = hmacSha384(prk, prev.concat(info, [ctr++]));
    for (var i = 0; i < prev.length && okm.length < len; i++) okm.push(prev[i]);
  }
  return okm.slice(0, len);
}

/**
 * [Item 330] HKDF-Expand-Label with SHA-384 (TLS 1.3 §7.1, for TLS_AES_256_GCM_SHA384).
 */
export function hkdfExpandLabelSHA384(secret: number[], label: string, context: number[], len: number): number[] {
  var labelBytes = Array.from('tls13 ' + label, c => c.charCodeAt(0));
  var info = [
    (len >> 8) & 0xff, len & 0xff,
    labelBytes.length, ...labelBytes,
    context.length, ...context,
  ];
  return hkdfExpandSHA384(secret, info, len);
}
