/**
 * crypto.ts — AssemblyScript hot-path cryptographic primitives
 *
 * All functions operate on linear memory (shared ArrayBuffer on the JS side).
 * Parameters are byte offsets into WASM linear memory, not JS pointers.
 *
 * Exported functions are callable from TypeScript via:
 *   inst.callByName('sha256', msgOffset, msgLen, outOffset)
 * or via JIT: kernel.jitCallI(nativeAddr, msgOffset, msgLen, outOffset, 0)
 *
 * RULES for this file (AssemblyScript constraints):
 *   - No classes with vtables, no closures, no GC, no Map/Set
 *   - All params / return values must be i32 or f64
 *   - Memory access via load<T>() / store<T>()
 */

// ── SHA-256 ──────────────────────────────────────────────────────────────────

const K0:  u32 = 0x428a2f98; const K1:  u32 = 0x71374491;
const K2:  u32 = 0xb5c0fbcf; const K3:  u32 = 0xe9b5dba5;
const K4:  u32 = 0x3956c25b; const K5:  u32 = 0x59f111f1;
const K6:  u32 = 0x923f82a4; const K7:  u32 = 0xab1c5ed5;
const K8:  u32 = 0xd807aa98; const K9:  u32 = 0x12835b01;
const K10: u32 = 0x243185be; const K11: u32 = 0x550c7dc3;
const K12: u32 = 0x72be5d74; const K13: u32 = 0x80deb1fe;
const K14: u32 = 0x9bdc06a7; const K15: u32 = 0xc19bf174;
const K16: u32 = 0xe49b69c1; const K17: u32 = 0xefbe4786;
const K18: u32 = 0x0fc19dc6; const K19: u32 = 0x240ca1cc;
const K20: u32 = 0x2de92c6f; const K21: u32 = 0x4a7484aa;
const K22: u32 = 0x5cb0a9dc; const K23: u32 = 0x76f988da;
const K24: u32 = 0x983e5152; const K25: u32 = 0xa831c66d;
const K26: u32 = 0xb00327c8; const K27: u32 = 0xbf597fc7;
const K28: u32 = 0xc6e00bf3; const K29: u32 = 0xd5a79147;
const K30: u32 = 0x06ca6351; const K31: u32 = 0x14292967;
const K32: u32 = 0x27b70a85; const K33: u32 = 0x2e1b2138;
const K34: u32 = 0x4d2c6dfc; const K35: u32 = 0x53380d13;
const K36: u32 = 0x650a7354; const K37: u32 = 0x766a0abb;
const K38: u32 = 0x81c2c92e; const K39: u32 = 0x92722c85;
const K40: u32 = 0xa2bfe8a1; const K41: u32 = 0xa81a664b;
const K42: u32 = 0xc24b8b70; const K43: u32 = 0xc76c51a3;
const K44: u32 = 0xd192e819; const K45: u32 = 0xd6990624;
const K46: u32 = 0xf40e3585; const K47: u32 = 0x106aa070;
const K48: u32 = 0x19a4c116; const K49: u32 = 0x1e376c08;
const K50: u32 = 0x2748774c; const K51: u32 = 0x34b0bcb5;
const K52: u32 = 0x391c0cb3; const K53: u32 = 0x4ed8aa4a;
const K54: u32 = 0x5b9cca4f; const K55: u32 = 0x682e6ff3;
const K56: u32 = 0x748f82ee; const K57: u32 = 0x78a5636f;
const K58: u32 = 0x84c87814; const K59: u32 = 0x8cc70208;
const K60: u32 = 0x90befffa; const K61: u32 = 0xa4506ceb;
const K62: u32 = 0xbef9a3f7; const K63: u32 = 0xc67178f2;

// K table stored in linear memory at offset 0x1000 (4 KB)
const K_BASE: i32 = 0x1000;
const W_BASE: i32 = 0x1100;  // 64 * 4 = 256 bytes for schedule
const H_BASE: i32 = 0x1200;  // 8 * 4 = 32 bytes for state

@inline function rotr32(x: u32, n: u32): u32 {
  return (x >>> n) | (x << (32 - n));
}

/**
 * sha256Init — write the SHA-256 K table and initial hash into linear memory.
 * Must be called once before sha256Block().
 * No parameters; operates on fixed memory addresses.
 */
export function sha256Init(): void {
  // Write K constants
  store<u32>(K_BASE +   0, K0);  store<u32>(K_BASE +   4, K1);
  store<u32>(K_BASE +   8, K2);  store<u32>(K_BASE +  12, K3);
  store<u32>(K_BASE +  16, K4);  store<u32>(K_BASE +  20, K5);
  store<u32>(K_BASE +  24, K6);  store<u32>(K_BASE +  28, K7);
  store<u32>(K_BASE +  32, K8);  store<u32>(K_BASE +  36, K9);
  store<u32>(K_BASE +  40, K10); store<u32>(K_BASE +  44, K11);
  store<u32>(K_BASE +  48, K12); store<u32>(K_BASE +  52, K13);
  store<u32>(K_BASE +  56, K14); store<u32>(K_BASE +  60, K15);
  store<u32>(K_BASE +  64, K16); store<u32>(K_BASE +  68, K17);
  store<u32>(K_BASE +  72, K18); store<u32>(K_BASE +  76, K19);
  store<u32>(K_BASE +  80, K20); store<u32>(K_BASE +  84, K21);
  store<u32>(K_BASE +  88, K22); store<u32>(K_BASE +  92, K23);
  store<u32>(K_BASE +  96, K24); store<u32>(K_BASE + 100, K25);
  store<u32>(K_BASE + 104, K26); store<u32>(K_BASE + 108, K27);
  store<u32>(K_BASE + 112, K28); store<u32>(K_BASE + 116, K29);
  store<u32>(K_BASE + 120, K30); store<u32>(K_BASE + 124, K31);
  store<u32>(K_BASE + 128, K32); store<u32>(K_BASE + 132, K33);
  store<u32>(K_BASE + 136, K34); store<u32>(K_BASE + 140, K35);
  store<u32>(K_BASE + 144, K36); store<u32>(K_BASE + 148, K37);
  store<u32>(K_BASE + 152, K38); store<u32>(K_BASE + 156, K39);
  store<u32>(K_BASE + 160, K40); store<u32>(K_BASE + 164, K41);
  store<u32>(K_BASE + 168, K42); store<u32>(K_BASE + 172, K43);
  store<u32>(K_BASE + 176, K44); store<u32>(K_BASE + 180, K45);
  store<u32>(K_BASE + 184, K46); store<u32>(K_BASE + 188, K47);
  store<u32>(K_BASE + 192, K48); store<u32>(K_BASE + 196, K49);
  store<u32>(K_BASE + 200, K50); store<u32>(K_BASE + 204, K51);
  store<u32>(K_BASE + 208, K52); store<u32>(K_BASE + 212, K53);
  store<u32>(K_BASE + 216, K54); store<u32>(K_BASE + 220, K55);
  store<u32>(K_BASE + 224, K56); store<u32>(K_BASE + 228, K57);
  store<u32>(K_BASE + 232, K58); store<u32>(K_BASE + 236, K59);
  store<u32>(K_BASE + 240, K60); store<u32>(K_BASE + 244, K61);
  store<u32>(K_BASE + 248, K62); store<u32>(K_BASE + 252, K63);

  // Initial hash values
  store<u32>(H_BASE +  0, 0x6a09e667);
  store<u32>(H_BASE +  4, 0xbb67ae85);
  store<u32>(H_BASE +  8, 0x3c6ef372);
  store<u32>(H_BASE + 12, 0xa54ff53a);
  store<u32>(H_BASE + 16, 0x510e527f);
  store<u32>(H_BASE + 20, 0x9b05688c);
  store<u32>(H_BASE + 24, 0x1f83d9ab);
  store<u32>(H_BASE + 28, 0x5be0cd19);
}

/**
 * sha256Block — process one 64-byte block at `blockPtr` (offset into linear memory).
 * State (8 u32 words) at H_BASE is updated in place.
 * Call sha256Init() once before the first block.
 */
export function sha256Block(blockPtr: i32): void {
  // Load schedule from block (big-endian)
  for (let t: i32 = 0; t < 16; t++) {
    const b0: u32 = load<u8>(blockPtr + t * 4 + 0);
    const b1: u32 = load<u8>(blockPtr + t * 4 + 1);
    const b2: u32 = load<u8>(blockPtr + t * 4 + 2);
    const b3: u32 = load<u8>(blockPtr + t * 4 + 3);
    store<u32>(W_BASE + t * 4, (b0 << 24) | (b1 << 16) | (b2 << 8) | b3);
  }
  // Expand schedule
  for (let t: i32 = 16; t < 64; t++) {
    const w2:  u32 = load<u32>(W_BASE + (t -  2) * 4);
    const w7:  u32 = load<u32>(W_BASE + (t -  7) * 4);
    const w15: u32 = load<u32>(W_BASE + (t - 15) * 4);
    const w16: u32 = load<u32>(W_BASE + (t - 16) * 4);
    const s0: u32 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
    const s1: u32 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
    store<u32>(W_BASE + t * 4, w16 + s0 + w7 + s1);
  }

  // Load working vars
  let a: u32 = load<u32>(H_BASE +  0);
  let b: u32 = load<u32>(H_BASE +  4);
  let c: u32 = load<u32>(H_BASE +  8);
  let d: u32 = load<u32>(H_BASE + 12);
  let e: u32 = load<u32>(H_BASE + 16);
  let f: u32 = load<u32>(H_BASE + 20);
  let g: u32 = load<u32>(H_BASE + 24);
  let h: u32 = load<u32>(H_BASE + 28);

  // 64 rounds
  for (let t: i32 = 0; t < 64; t++) {
    const S1:  u32 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    const ch:  u32 = (e & f) ^ (~e & g);
    const kt:  u32 = load<u32>(K_BASE + t * 4);
    const wt:  u32 = load<u32>(W_BASE + t * 4);
    const t1:  u32 = h + S1 + ch + kt + wt;
    const S0:  u32 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    const maj: u32 = (a & b) ^ (a & c) ^ (b & c);
    const t2:  u32 = S0 + maj;
    h = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }

  // Add to state
  store<u32>(H_BASE +  0, load<u32>(H_BASE +  0) + a);
  store<u32>(H_BASE +  4, load<u32>(H_BASE +  4) + b);
  store<u32>(H_BASE +  8, load<u32>(H_BASE +  8) + c);
  store<u32>(H_BASE + 12, load<u32>(H_BASE + 12) + d);
  store<u32>(H_BASE + 16, load<u32>(H_BASE + 16) + e);
  store<u32>(H_BASE + 20, load<u32>(H_BASE + 20) + f);
  store<u32>(H_BASE + 24, load<u32>(H_BASE + 24) + g);
  store<u32>(H_BASE + 28, load<u32>(H_BASE + 28) + h);
}

/**
 * sha256GetState — copy the 32-byte hash state to `outPtr`.
 * Call after all blocks are processed.
 */
export function sha256GetState(outPtr: i32): void {
  for (let i: i32 = 0; i < 32; i++) {
    store<u8>(outPtr + i, load<u8>(H_BASE + i));
  }
}

// ── FNV-1a 32-bit hash ───────────────────────────────────────────────────────

/**
 * fnv1a32 — fast 32-bit hash of `len` bytes at `ptr`.
 * Returns hash as i32.
 */
export function fnv1a32(ptr: i32, len: i32): i32 {
  let h: u32 = 0x811c9dc5;
  for (let i: i32 = 0; i < len; i++) {
    h ^= load<u8>(ptr + i);
    h = (h * 0x01000193) | 0;
  }
  return h as i32;
}

// ── SipHash-1-3 (fast non-crypto hash for hash tables) ──────────────────────

/**
 * siphash13 — SipHash-1-3 of `len` bytes at `ptr`, using key at `keyPtr` (16 bytes).
 * Returns lower 32 bits of hash.
 */
export function siphash13Lo(ptr: i32, len: i32, keyPtr: i32): i32 {
  let k0: u32 = load<u32>(keyPtr + 0);
  let k1: u32 = load<u32>(keyPtr + 4);
  let v0: u32 = k0 ^ 0x736f6d65;
  let v1: u32 = k1 ^ 0x646f7261;
  let v2: u32 = k0 ^ 0x6c796765;
  let v3: u32 = k1 ^ 0x74656462;

  let i: i32 = 0;
  while (i + 4 <= len) {
    const m: u32 = load<u32>(ptr + i);
    v3 ^= m;
    // SipRound × 1
    v0 += v1; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v0; v0 = (v0 << 16) | (v0 >>> 16);
    v2 += v3; v3 = (v3 << 17) | (v3 >>> 15); v3 ^= v2;
    v0 += v3; v3 = (v3 << 21) | (v3 >>> 11); v3 ^= v0;
    v2 += v1; v1 = (v1 << 12) | (v1 >>> 20); v1 ^= v2; v2 = (v2 << 32) | (v2 >>> 0);
    v0 ^= m;
    i += 4;
  }
  // Handle remaining bytes
  let last: u32 = (len as u32) << 24;
  let shift: i32 = 0;
  while (i < len) { last |= (load<u8>(ptr + i) as u32) << shift; i++; shift += 8; }
  v3 ^= last;
  v0 += v1; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v0;
  v0 = (v0 << 16) | (v0 >>> 16);
  v2 += v3; v3 = (v3 << 17) | (v3 >>> 15); v3 ^= v2;
  v0 += v3; v3 = (v3 << 21) | (v3 >>> 11); v3 ^= v0;
  v2 += v1; v1 = (v1 << 12) | (v1 >>> 20); v1 ^= v2;
  v0 ^= last;
  v2 ^= 0xff;
  // Finalize × 3
  for (let r: i32 = 0; r < 3; r++) {
    v0 += v1; v1 = (v1 << 13) | (v1 >>> 19); v1 ^= v0;
    v0 = (v0 << 16) | (v0 >>> 16);
    v2 += v3; v3 = (v3 << 17) | (v3 >>> 15); v3 ^= v2;
    v0 += v3; v3 = (v3 << 21) | (v3 >>> 11); v3 ^= v0;
    v2 += v1; v1 = (v1 << 12) | (v1 >>> 20); v1 ^= v2;
  }
  return (v0 ^ v1 ^ v2 ^ v3) as i32;
}
