/**
 * JSOS Filesystem AES-XTS Encryption — Item 206
 *
 * Full AES-128 and AES-256 implementation in TypeScript plus XTS (XEX-based
 * Tweakable-codebook mode with ciphertext Stealing) for full-disk/per-file
 * block encryption as used by dm-crypt, VeraCrypt, and APFS.
 *
 * AES reference: FIPS-197
 * XTS reference: IEEE 1619-2007
 */

import type { BlockDevice } from './blockdev.js';

// ────────────────────────────────────────────────────────────────────────────
// AES lookup tables (S-box, inverse S-box, MixColumns)
// ────────────────────────────────────────────────────────────────────────────

// AES S-box
const SBOX = new Uint8Array([
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
]);

// Inverse S-box
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;

// GF(2^8) multiply mod 0x11b
function xtime(b: number): number { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; }
function mul(a: number, b: number): number {
  return (
    (b & 1 ? a : 0) ^
    (b & 2 ? xtime(a) : 0) ^
    (b & 4 ? xtime(xtime(a)) : 0) ^
    (b & 8 ? xtime(xtime(xtime(a))) : 0)
  );
}

// Precomputed MixColumns tables (Te0..Te3, Td0..Td3)
function buildMCTable(e0: number, e1: number, e2: number, e3: number, box: Uint8Array): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const s = box[i];
    t[i] = ((mul(s, e0) << 24) | (mul(s, e1) << 16) | (mul(s, e2) << 8) | mul(s, e3)) >>> 0;
  }
  return t;
}
const Te0 = buildMCTable(2, 1, 1, 3, SBOX);
const Te1 = buildMCTable(3, 2, 1, 1, SBOX);
const Te2 = buildMCTable(1, 3, 2, 1, SBOX);
const Te3 = buildMCTable(1, 1, 3, 2, SBOX);
const Td0 = buildMCTable(14, 9, 13, 11, INV_SBOX);
const Td1 = buildMCTable(11, 14, 9, 13, INV_SBOX);
const Td2 = buildMCTable(13, 11, 14, 9, INV_SBOX);
const Td3 = buildMCTable(9, 13, 11, 14, INV_SBOX);

// ────────────────────────────────────────────────────────────────────────────
// AES key schedule
// ────────────────────────────────────────────────────────────────────────────

const RCON = new Uint32Array([
  0x01000000, 0x02000000, 0x04000000, 0x08000000,
  0x10000000, 0x20000000, 0x40000000, 0x80000000,
  0x1b000000, 0x36000000,
]);

function keyScheduleExpand(key: Uint8Array): Uint32Array {
  const nk = key.length >>> 2;     // 4 for AES-128, 8 for AES-256
  const nr = nk + 6;               // 10 or 14 rounds
  const w  = new Uint32Array((nr + 1) * 4);
  for (let i = 0; i < nk; i++) {
    w[i] = (key[i*4] << 24) | (key[i*4+1] << 16) | (key[i*4+2] << 8) | key[i*4+3];
  }
  const subWord = (x: number) =>
    (SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) |
    (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff];
  const rotWord = (x: number) => ((x << 8) | (x >>> 24)) >>> 0;
  for (let i = nk; i < (nr + 1) * 4; i++) {
    let temp = w[i - 1];
    if (i % nk === 0) temp = (subWord(rotWord(temp)) ^ RCON[(i / nk) - 1]) >>> 0;
    else if (nk > 6 && i % nk === 4) temp = subWord(temp);
    w[i] = (w[i - nk] ^ temp) >>> 0;
  }
  return w;
}

// ────────────────────────────────────────────────────────────────────────────
// AES block encrypt/decrypt (16-byte block in-place)
// ────────────────────────────────────────────────────────────────────────────

function aesEncryptBlock(state: Uint8Array, w: Uint32Array): void {
  const nr = (w.length >>> 2) - 1;
  let s0 = (state[0]<<24|state[1]<<16|state[2]<<8|state[3]) ^ w[0];
  let s1 = (state[4]<<24|state[5]<<16|state[6]<<8|state[7]) ^ w[1];
  let s2 = (state[8]<<24|state[9]<<16|state[10]<<8|state[11]) ^ w[2];
  let s3 = (state[12]<<24|state[13]<<16|state[14]<<8|state[15]) ^ w[3];
  let t0: number, t1: number, t2: number, t3: number;
  for (let r = 1; r < nr; r++) {
    t0 = (Te0[s0>>>24] ^ Te1[(s1>>>16)&0xff] ^ Te2[(s2>>>8)&0xff] ^ Te3[s3&0xff] ^ w[r*4  ]) >>> 0;
    t1 = (Te0[s1>>>24] ^ Te1[(s2>>>16)&0xff] ^ Te2[(s3>>>8)&0xff] ^ Te3[s0&0xff] ^ w[r*4+1]) >>> 0;
    t2 = (Te0[s2>>>24] ^ Te1[(s3>>>16)&0xff] ^ Te2[(s0>>>8)&0xff] ^ Te3[s1&0xff] ^ w[r*4+2]) >>> 0;
    t3 = (Te0[s3>>>24] ^ Te1[(s0>>>16)&0xff] ^ Te2[(s1>>>8)&0xff] ^ Te3[s2&0xff] ^ w[r*4+3]) >>> 0;
    s0=t0; s1=t1; s2=t2; s3=t3;
  }
  const r = nr;
  t0 = (SBOX[s0>>>24]<<24|SBOX[(s1>>>16)&0xff]<<16|SBOX[(s2>>>8)&0xff]<<8|SBOX[s3&0xff]) ^ w[r*4  ];
  t1 = (SBOX[s1>>>24]<<24|SBOX[(s2>>>16)&0xff]<<16|SBOX[(s3>>>8)&0xff]<<8|SBOX[s0&0xff]) ^ w[r*4+1];
  t2 = (SBOX[s2>>>24]<<24|SBOX[(s3>>>16)&0xff]<<16|SBOX[(s0>>>8)&0xff]<<8|SBOX[s1&0xff]) ^ w[r*4+2];
  t3 = (SBOX[s3>>>24]<<24|SBOX[(s0>>>16)&0xff]<<16|SBOX[(s1>>>8)&0xff]<<8|SBOX[s2&0xff]) ^ w[r*4+3];
  state[0]=t0>>>24; state[1]=(t0>>>16)&0xff; state[2]=(t0>>>8)&0xff; state[3]=t0&0xff;
  state[4]=t1>>>24; state[5]=(t1>>>16)&0xff; state[6]=(t1>>>8)&0xff; state[7]=t1&0xff;
  state[8]=t2>>>24; state[9]=(t2>>>16)&0xff; state[10]=(t2>>>8)&0xff; state[11]=t2&0xff;
  state[12]=t3>>>24; state[13]=(t3>>>16)&0xff; state[14]=(t3>>>8)&0xff; state[15]=t3&0xff;
}

function aesDecryptBlock(state: Uint8Array, w: Uint32Array): void {
  const nr = (w.length >>> 2) - 1;
  let s0=(state[0]<<24|state[1]<<16|state[2]<<8|state[3])^w[nr*4  ];
  let s1=(state[4]<<24|state[5]<<16|state[6]<<8|state[7])^w[nr*4+1];
  let s2=(state[8]<<24|state[9]<<16|state[10]<<8|state[11])^w[nr*4+2];
  let s3=(state[12]<<24|state[13]<<16|state[14]<<8|state[15])^w[nr*4+3];
  let t0: number, t1: number, t2: number, t3: number;
  for (let r = nr-1; r >= 1; r--) {
    t0=(Td0[s0>>>24]^Td1[(s3>>>16)&0xff]^Td2[(s2>>>8)&0xff]^Td3[s1&0xff]^w[r*4  ])>>>0;
    t1=(Td0[s1>>>24]^Td1[(s0>>>16)&0xff]^Td2[(s3>>>8)&0xff]^Td3[s2&0xff]^w[r*4+1])>>>0;
    t2=(Td0[s2>>>24]^Td1[(s1>>>16)&0xff]^Td2[(s0>>>8)&0xff]^Td3[s3&0xff]^w[r*4+2])>>>0;
    t3=(Td0[s3>>>24]^Td1[(s2>>>16)&0xff]^Td2[(s1>>>8)&0xff]^Td3[s0&0xff]^w[r*4+3])>>>0;
    s0=t0; s1=t1; s2=t2; s3=t3;
  }
  t0=(INV_SBOX[s0>>>24]<<24|INV_SBOX[(s3>>>16)&0xff]<<16|INV_SBOX[(s2>>>8)&0xff]<<8|INV_SBOX[s1&0xff])^w[0];
  t1=(INV_SBOX[s1>>>24]<<24|INV_SBOX[(s0>>>16)&0xff]<<16|INV_SBOX[(s3>>>8)&0xff]<<8|INV_SBOX[s2&0xff])^w[1];
  t2=(INV_SBOX[s2>>>24]<<24|INV_SBOX[(s1>>>16)&0xff]<<16|INV_SBOX[(s0>>>8)&0xff]<<8|INV_SBOX[s3&0xff])^w[2];
  t3=(INV_SBOX[s3>>>24]<<24|INV_SBOX[(s2>>>16)&0xff]<<16|INV_SBOX[(s1>>>8)&0xff]<<8|INV_SBOX[s0&0xff])^w[3];
  state[0]=t0>>>24; state[1]=(t0>>>16)&0xff; state[2]=(t0>>>8)&0xff; state[3]=t0&0xff;
  state[4]=t1>>>24; state[5]=(t1>>>16)&0xff; state[6]=(t1>>>8)&0xff; state[7]=t1&0xff;
  state[8]=t2>>>24; state[9]=(t2>>>16)&0xff; state[10]=(t2>>>8)&0xff; state[11]=t2&0xff;
  state[12]=t3>>>24; state[13]=(t3>>>16)&0xff; state[14]=(t3>>>8)&0xff; state[15]=t3&0xff;
}

// ────────────────────────────────────────────────────────────────────────────
// XTS mode (IEEE 1619)
// ────────────────────────────────────────────────────────────────────────────

/** GF(2^128) multiply by x (polynomial x^128 + x^7 + x^2 + x + 1) */
function gfMul2(t: Uint8Array): void {
  const carry = (t[15] & 0x80) !== 0;
  for (let i = 15; i > 0; i--) t[i] = ((t[i] << 1) | (t[i-1] >> 7)) & 0xff;
  t[0] = (t[0] << 1) & 0xff;
  if (carry) t[0] ^= 0x87;
}

function xorBlock(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < 16; i++) a[i] ^= b[i];
}

export class AESXTS {
  private _w1: Uint32Array;
  private _w2: Uint32Array;

  /**
   * @param key1  First AES key (data key) — 16 or 32 bytes
   * @param key2  Second AES key (tweak key) — same length as key1
   */
  constructor(key1: Uint8Array, key2: Uint8Array) {
    if (key1.length !== key2.length || (key1.length !== 16 && key1.length !== 32)) {
      throw new Error('AESXTS: keys must be 16 or 32 bytes each');
    }
    this._w1 = keyScheduleExpand(key1);
    this._w2 = keyScheduleExpand(key2);
  }

  /**
   * Encrypt a sector (multiple of 16 bytes).
   * @param data     Plaintext (16..n*16 bytes, modified in-place)
   * @param sectorNo Sector number (64-bit, little-endian tweak)
   */
  encryptSector(data: Uint8Array, sectorNo: number): void {
    const tweak = new Uint8Array(16);
    // Encode sector number as little-endian 128-bit integer
    let n = sectorNo;
    for (let i = 0; i < 8 && n > 0; i++) { tweak[i] = n & 0xff; n = Math.floor(n / 256); }
    aesEncryptBlock(tweak, this._w2);

    for (let off = 0; off < data.length; off += 16) {
      const block = data.slice(off, off + 16) as Uint8Array;
      // PP = P xor T
      xorBlock(block, tweak);
      aesEncryptBlock(block, this._w1);
      // CC = C xor T
      xorBlock(block, tweak);
      data.set(block, off);
      gfMul2(tweak);
    }
  }

  /**
   * Decrypt a sector (multiple of 16 bytes).
   */
  decryptSector(data: Uint8Array, sectorNo: number): void {
    const tweak = new Uint8Array(16);
    let n = sectorNo;
    for (let i = 0; i < 8 && n > 0; i++) { tweak[i] = n & 0xff; n = Math.floor(n / 256); }
    aesEncryptBlock(tweak, this._w2);

    for (let off = 0; off < data.length; off += 16) {
      const block = data.slice(off, off + 16) as Uint8Array;
      xorBlock(block, tweak);
      aesDecryptBlock(block, this._w1);
      xorBlock(block, tweak);
      data.set(block, off);
      gfMul2(tweak);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EncryptedBlockDevice
// ────────────────────────────────────────────────────────────────────────────

export class EncryptedBlockDevice implements BlockDevice {
  readonly name: string;
  readonly sectorSize: number;
  readonly sectorCount: number;
  private _xts: AESXTS;

  /**
   * Wraps a BlockDevice with AES-XTS transparent encryption.
   * The combined key is split in half: first half → data key, second half → tweak key.
   * @param dev    Underlying block device
   * @param key    32 bytes (AES-128-XTS) or 64 bytes (AES-256-XTS)
   */
  constructor(dev: BlockDevice, key: Uint8Array) {
    this.name        = `encrypted(${dev.name})`;
    this.sectorSize  = dev.sectorSize;
    this.sectorCount = dev.sectorCount;
    if (key.length !== 32 && key.length !== 64) throw new Error('EncryptedBlockDevice: key must be 32 or 64 bytes');
    const half = key.length >>> 1;
    this._xts = new AESXTS(key.slice(0, half), key.slice(half));
    this._inner = dev;
  }

  private _inner: BlockDevice;

  async readSectors(lba: number, count: number): Promise<Uint8Array> {
    const data = await this._inner.readSectors(lba, count);
    const sectorSize = this.sectorSize;
    for (let i = 0; i < count; i++) {
      const sector = data.slice(i * sectorSize, (i + 1) * sectorSize);
      this._xts.decryptSector(sector, lba + i);
      data.set(sector, i * sectorSize);
    }
    return data;
  }

  async writeSectors(lba: number, plaintext: Uint8Array): Promise<number> {
    const data = new Uint8Array(plaintext);  // copy
    const sectorSize = this.sectorSize;
    const count = Math.ceil(data.length / sectorSize);
    for (let i = 0; i < count; i++) {
      const sector = data.slice(i * sectorSize, (i + 1) * sectorSize);
      this._xts.encryptSector(sector, lba + i);
      data.set(sector, i * sectorSize);
    }
    return this._inner.writeSectors(lba, data);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// fsEncrypt singleton
// ────────────────────────────────────────────────────────────────────────────

interface FSEncrypt {
  /** Create an AESXTS cipher from a combined key (32 or 64 bytes) */
  createCipher(key: Uint8Array): AESXTS;
  /** Wrap a block device with AES-XTS encryption */
  wrapDevice(dev: BlockDevice, key: Uint8Array): EncryptedBlockDevice;
  /** Encrypt a single sector in-place */
  encryptSector(cipher: AESXTS, data: Uint8Array, sectorNo: number): void;
  /** Decrypt a single sector in-place */
  decryptSector(cipher: AESXTS, data: Uint8Array, sectorNo: number): void;
  /** Generate a random 256-bit key (AES-128-XTS) using Math.random (NOT crypto-safe) */
  generateKey128(): Uint8Array;
  /** Generate a random 512-bit key (AES-256-XTS) using Math.random (NOT crypto-safe) */
  generateKey256(): Uint8Array;
}

export const fsEncrypt: FSEncrypt = {
  createCipher(key) {
    const half = key.length >>> 1;
    return new AESXTS(key.slice(0, half), key.slice(half));
  },

  wrapDevice(dev, key) { return new EncryptedBlockDevice(dev, key); },

  encryptSector(cipher, data, sectorNo) { cipher.encryptSector(data, sectorNo); },

  decryptSector(cipher, data, sectorNo) { cipher.decryptSector(data, sectorNo); },

  generateKey128() {
    const k = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k[i] = (Math.random() * 256) | 0;
    return k;
  },

  generateKey256() {
    const k = new Uint8Array(64);
    for (let i = 0; i < 64; i++) k[i] = (Math.random() * 256) | 0;
    return k;
  },
};
