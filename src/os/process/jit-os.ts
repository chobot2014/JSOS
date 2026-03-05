/**
 * jit-os.ts — JIT-compiled OS kernel hot-paths (integer tier)
 *
 * Companion to jit-canvas.ts.  Provides native x86-32 versions of the
 * integer-heavy OS primitives that are called on every packet, every disk
 * block, and every memory operation.
 *
 * ─── Two-tier JIT architecture ────────────────────────────────────────────────
 *
 *   Tier 1 — QJSJITHook (automatic, global)
 *     The QuickJS JIT hook fires for *every* JS function in the entire OS
 *     after 100 calls — scheduler, net stack, filesystem, all of it.
 *     No code changes needed; everything gets compiled eventually.
 *
 *   Tier 2 — JIT.compile() / JITProfiler.wrap() (explicit, zero warmup)
 *     For loops whose shape is always "integer math over flat memory" we
 *     compile at module load time so the very first call runs native.
 *     This is what jit-canvas.ts does for pixel operations, and what this
 *     file does for network, memory, and storage hot-paths.
 *
 * ─── Exported operations ──────────────────────────────────────────────────────
 *
 *   JITChecksum
 *     compute(physAddr, len)      — RFC 1071 Internet checksum over physmem
 *     computeBuf(ab)              — same but accepts an ArrayBuffer (auto physAddrOf)
 *
 *   JITMem
 *     fill8(physAddr, val, len)   — memset (byte granularity)
 *     fill32(physAddr, val, len)  — memset (dword granularity, len in dwords)
 *     copy8(dst, src, len)        — memmove (byte granularity)
 *     copy32(dst, src, len)       — memmove (dword granularity)
 *     compare(a, b, len)          — memcmp → 0 if equal, non-zero otherwise
 *
 *   JITCRC32
 *     update(physAddr, len, crc)  — software CRC-32 (Ethernet/ZIP/FAT) over physmem
 *     table                       — pre-computed 256-entry CRC table (ArrayBuffer)
 *
 *   JITOSInit
 *     init()                      — compile all of the above at boot; must be called once.
 *     stats()                     — how many compiled, bytes used
 *
 * All functions silently fall back to TypeScript if JIT is unavailable
 * (e.g. in unit-test environments without a kernel).
 */

import { JIT } from './jit.js';

declare var kernel: any;

// ─────────────────────────────────────────────────────────────────────────────
//  JIT source strings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 1071 Internet checksum over a flat byte buffer in physical memory.
 * Returns the 16-bit one's-complement checksum (in the low 16 bits of EAX).
 *
 * Algorithm (2-byte words, big-endian):
 *   sum = Σ word_i;  while(sum>>16) sum = (sum&0xffff)+(sum>>16);  return ~sum & 0xffff
 */
const _SRC_CHECKSUM = `
function checksum(physAddr, len) {
  var sum = 0;
  var i = 0;
  var n = len - 1;
  while (i < n) {
    var hi = mem8[physAddr + i] & 0xff;
    var lo = mem8[physAddr + i + 1] & 0xff;
    sum = sum + ((hi << 8) | lo);
    i = i + 2;
  }
  if (len & 1) {
    sum = sum + ((mem8[physAddr + len - 1] & 0xff) << 8);
  }
  var carry = sum >> 16;
  while (carry) {
    sum = (sum & 0xffff) + carry;
    carry = sum >> 16;
  }
  return (~sum) & 0xffff;
}
`;

/** Fill len bytes at physAddr with value (byte write). */
const _SRC_FILL8 = `
function fill8(physAddr, val, len) {
  var i = 0;
  var v = val & 0xff;
  while (i < len) {
    mem8[physAddr + i] = v;
    i = i + 1;
  }
  return 0;
}
`;

/** Fill len dwords at physAddr with value (32-bit write). */
const _SRC_FILL32 = `
function fill32(physAddr, val, len) {
  var i = 0;
  while (i < len) {
    mem32[physAddr + i * 4] = val;
    i = i + 1;
  }
  return 0;
}
`;

/** Copy len bytes from src to dst (non-overlapping). */
const _SRC_COPY8 = `
function copy8(dst, src, len) {
  var i = 0;
  while (i < len) {
    mem8[dst + i] = mem8[src + i];
    i = i + 1;
  }
  return 0;
}
`;

/** Copy len dwords from src to dst (non-overlapping). */
const _SRC_COPY32 = `
function copy32(dst, src, len) {
  var i = 0;
  while (i < len) {
    mem32[dst + i * 4] = mem32[src + i * 4];
    i = i + 1;
  }
  return 0;
}
`;

/** memcmp: returns 0 if len bytes at a == b, else first differing byte difference. */
const _SRC_COMPARE = `
function compare(a, b, len) {
  var i = 0;
  while (i < len) {
    var da = mem8[a + i] & 0xff;
    var db = mem8[b + i] & 0xff;
    if (da !== db) { return da - db; }
    i = i + 1;
  }
  return 0;
}
`;

/**
 * CRC-32 (ISO 3309 / Ethernet FCS).
 * tableAddr = physical address of the 256×4-byte CRC table.
 * crc        = running CRC, pass 0xFFFFFFFF for first block.
 * Returns updated CRC (caller must XOR with 0xFFFFFFFF at the end).
 */
const _SRC_CRC32 = `
function crc32(physAddr, len, tableAddr, crc) {
  var i = 0;
  while (i < len) {
    var b = mem8[physAddr + i] & 0xff;
    var idx = (crc ^ b) & 0xff;
    crc = mem32[tableAddr + idx * 4] ^ ((crc >>> 8) & 0x00ffffff);
    i = i + 1;
  }
  return crc;
}
`;

/**
 * Byte-by-byte compare of two null-terminated strings in physical memory.
 * strcmp8(aAddr, bAddr, maxLen) → <0 / 0 / >0 (like C strcmp).
 * Stops at the first differing byte or either null terminator.
 */
const _SRC_STRCMP = `
function strcmp8(aAddr, bAddr, maxLen) {
  var i = 0;
  while (i < maxLen) {
    var ca = mem8[aAddr + i] & 0xff;
    var cb = mem8[bAddr + i] & 0xff;
    if (ca !== cb) { return ca - cb; }
    if (ca === 0) { return 0; }
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Search for byte `val` in physical memory starting at `physAddr`.
 * memchr8(physAddr, val, len) → address of first match or 0.
 */
const _SRC_MEMCHR = `
function memchr8(physAddr, val, len) {
  var b = val & 0xff;
  var i = 0;
  while (i < len) {
    if ((mem8[physAddr + i] & 0xff) === b) { return physAddr + i; }
    i = i + 1;
  }
  return 0;
}
`;

/**
 * FNV-1a 32-bit hash of `len` bytes at `physAddr`.
 * fnv1a32(physAddr, len) → uint32 hash.
 * Used for fast hash-table keying in VFS path lookups.
 */
const _SRC_FNV1A32 = `
function fnv1a32(physAddr, len) {
  var hash = -2128831035;
  var i = 0;
  while (i < len) {
    hash = (hash ^ (mem8[physAddr + i] & 0xff)) | 0;
    hash = ((hash * 16777619) | 0);
    i = i + 1;
  }
  return hash;
}
`;

/** XOR len bytes from src into dst — AES-GCM CTR-mode decryption, ChaCha20, HKDF XOR. */
const _SRC_XOR_BUF = `
function xorBuf(dst, src, len) {
  var i = 0;
  while (i < len) {
    mem8[dst + i] = (mem8[dst + i] ^ mem8[src + i]) & 0xff;
    i = i + 1;
  }
  return 0;
}
`;

/** Store a big-endian uint32 at physAddr — net packet builder, TLS record header writer. */
const _SRC_PACK_BE32 = `
function packBE32(physAddr, val) {
  mem8[physAddr]     = (val >> 24) & 0xff;
  mem8[physAddr + 1] = (val >> 16) & 0xff;
  mem8[physAddr + 2] = (val >>  8) & 0xff;
  mem8[physAddr + 3] =  val        & 0xff;
  return 0;
}
`;

/** Load a big-endian uint32 from physAddr — net packet parser, IP/TCP field read. */
const _SRC_UNPACK_BE32 = `
function unpackBE32(physAddr) {
  return ((mem8[physAddr] & 0xff) << 24) |
         ((mem8[physAddr + 1] & 0xff) << 16) |
         ((mem8[physAddr + 2] & 0xff) << 8) |
          (mem8[physAddr + 3] & 0xff);
}
`;

/** Load a big-endian uint16 from physAddr — TCP/IP header field (port, length, checksum). */
const _SRC_UNPACK_BE16 = `
function unpackBE16(physAddr) {
  return ((mem8[physAddr] & 0xff) << 8) | (mem8[physAddr + 1] & 0xff);
}
`;

/**
 * LZ77 match copy — hot inner loop of DEFLATE inflate and LZ4 decompress.
 * Byte-by-byte to handle overlapping back-references correctly.
 */
const _SRC_LZ_COPY_MATCH = `
function lzCopyMatch(dst, src, len) {
  var i = 0;
  while (i < len) {
    mem8[dst + i] = mem8[src + i] & 0xff;
    i = i + 1;
  }
  return 0;
}
`;

/** ASCII lowercase a physmem buffer in-place — HTTP/1.1 header name normalization. */
const _SRC_TO_LOWER8 = `
function toLower8(physAddr, len) {
  var i = 0;
  while (i < len) {
    var c = mem8[physAddr + i] & 0xff;
    if (c >= 65) {
      if (c <= 90) {
        mem8[physAddr + i] = c + 32;
      }
    }
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Scan for CRLF (\r\n, bytes 13+10) in a physmem buffer.
 * Returns offset of the \r or len if not found.
 * Called on every HTTP response header line.
 */
const _SRC_SCAN_CRLF = `
function scanCRLF(physAddr, offset, len) {
  var i = offset;
  var n = len - 1;
  while (i < n) {
    if ((mem8[physAddr + i] & 0xff) === 13) {
      if ((mem8[physAddr + i + 1] & 0xff) === 10) {
        return i;
      }
    }
    i = i + 1;
  }
  return len;
}
`;

/** Sum all bytes in a physmem region — ICMP auxiliary checksum, IP options scanner. */
const _SRC_SUM_BUF = `
function sumBuf(physAddr, len) {
  var sum = 0;
  var i = 0;
  while (i < len) {
    sum = sum + (mem8[physAddr + i] & 0xff);
    i = i + 1;
  }
  return sum;
}
`;

/** Clamp x to [lo, hi] — layout engine, CSS calc, audio sample clamping. */
const _SRC_CLAMP32 = `
function clamp32(x, lo, hi) {
  if (x < lo) { return lo; }
  if (x > hi) { return hi; }
  return x;
}
`;

/**
 * Population count — number of set bits in an int32.
 * Kernighan-Knuth bit-trick, O(1).
 * Used by the bitmap block allocator (FAT free-cluster bitmap, inode bitmap).
 */
const _SRC_POP_COUNT32 = `
function popCount32(x) {
  var v = x;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  v = Math.imul(v, 0x01010101) >>> 24;
  return v & 0x3f;
}
`;

/**
 * SHA-256 block compression function.
 * Reads h[0..7] and W[0..63] from physmem, extends W[16..63] in-place,
 * runs 64 rounds, then accumulates the result back into h.
 * "kAddr" must point to the 64-entry 256-byte K constant table.
 */
const _SRC_SHA256_BLOCK = `
function sha256Block(hAddr, wAddr, kAddr) {
  var i = 16;
  while (i < 64) {
    var w15 = mem32[wAddr + (i - 15) * 4];
    var w2  = mem32[wAddr + (i -  2) * 4];
    var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    var s1 = ((w2  >>> 17) | (w2  << 15)) ^ ((w2  >>> 19) | (w2  << 13)) ^ (w2  >>> 10);
    mem32[wAddr + i * 4] = (mem32[wAddr + (i - 16) * 4] + s0 + mem32[wAddr + (i - 7) * 4] + s1) | 0;
    i = i + 1;
  }
  var a  = mem32[hAddr];
  var b  = mem32[hAddr +  4];
  var c  = mem32[hAddr +  8];
  var d  = mem32[hAddr + 12];
  var e  = mem32[hAddr + 16];
  var f  = mem32[hAddr + 20];
  var g  = mem32[hAddr + 24];
  var hh = mem32[hAddr + 28];
  var j = 0;
  while (j < 64) {
    var S1  = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    var ch  = (e & f) ^ (~e & g);
    var t1  = (hh + S1 + ch + mem32[kAddr + j * 4] + mem32[wAddr + j * 4]) | 0;
    var S0  = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    var maj = (a & b) ^ (a & c) ^ (b & c);
    var t2  = (S0 + maj) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
    j = j + 1;
  }
  mem32[hAddr]      = (mem32[hAddr]      + a)  | 0;
  mem32[hAddr +  4] = (mem32[hAddr +  4] + b)  | 0;
  mem32[hAddr +  8] = (mem32[hAddr +  8] + c)  | 0;
  mem32[hAddr + 12] = (mem32[hAddr + 12] + d)  | 0;
  mem32[hAddr + 16] = (mem32[hAddr + 16] + e)  | 0;
  mem32[hAddr + 20] = (mem32[hAddr + 20] + f)  | 0;
  mem32[hAddr + 24] = (mem32[hAddr + 24] + g)  | 0;
  mem32[hAddr + 28] = (mem32[hAddr + 28] + hh) | 0;
  return 0;
}
`;

/**
 * ChaCha20 block function (RFC 7539 §2.1).
 * stateAddr — physmem address of 16-word initial state (64 bytes).
 * outAddr   — physmem address of 64-byte output scratch (also used as
 *             working copy during the 20 rounds; ends with byte output).
 * rndTabAddr — physmem address of 32-byte QR index table (bytes: a,b,c,d × 8).
 */
const _SRC_CHACHA20_BLOCK = `
function chacha20Block(stateAddr, outAddr, rndTabAddr) {
  var i = 0;
  while (i < 16) {
    mem32[outAddr + i * 4] = mem32[stateAddr + i * 4];
    i = i + 1;
  }
  var round = 0;
  while (round < 10) {
    var qr = 0;
    while (qr < 8) {
      var ia = mem8[rndTabAddr + qr * 4];
      var ib = mem8[rndTabAddr + qr * 4 + 1];
      var ic = mem8[rndTabAddr + qr * 4 + 2];
      var id = mem8[rndTabAddr + qr * 4 + 3];
      var sa = mem32[outAddr + ia * 4];
      var sb = mem32[outAddr + ib * 4];
      var sc = mem32[outAddr + ic * 4];
      var sd = mem32[outAddr + id * 4];
      sa = (sa + sb) | 0; sd = sd ^ sa; sd = (sd << 16) | (sd >>> 16);
      sc = (sc + sd) | 0; sb = sb ^ sc; sb = (sb << 12) | (sb >>> 20);
      sa = (sa + sb) | 0; sd = sd ^ sa; sd = (sd <<  8) | (sd >>> 24);
      sc = (sc + sd) | 0; sb = sb ^ sc; sb = (sb <<  7) | (sb >>> 25);
      mem32[outAddr + ia * 4] = sa;
      mem32[outAddr + ib * 4] = sb;
      mem32[outAddr + ic * 4] = sc;
      mem32[outAddr + id * 4] = sd;
      qr = qr + 1;
    }
    round = round + 1;
  }
  i = 0;
  while (i < 16) {
    var w = (mem32[outAddr + i * 4] + mem32[stateAddr + i * 4]) | 0;
    mem8[outAddr + i * 4]     =  w         & 0xff;
    mem8[outAddr + i * 4 + 1] = (w >>>  8) & 0xff;
    mem8[outAddr + i * 4 + 2] = (w >>> 16) & 0xff;
    mem8[outAddr + i * 4 + 3] = (w >>> 24) & 0xff;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Adler-32 checksum over a physmem region (RFC 1950 §2).
 * s1/s2 are initial accumulator values (use 1/0 for a fresh hash).
 * Returns (s2 << 16) | s1.
 * ADLER_MOD = 65521 is the largest prime < 2^16.
 */
const _SRC_ADLER32 = `
function adler32(physAddr, len, s1, s2) {
  var ADLER_MOD = 65521;
  var a = s1 & 0xffff;
  var b = s2 & 0xffff;
  var i = 0;
  while (i < len) {
    a = a + (mem8[physAddr + i] & 0xff);
    if (a >= ADLER_MOD) a = a - ADLER_MOD;
    b = b + a;
    if (b >= ADLER_MOD) b = b - ADLER_MOD;
    i = i + 1;
  }
  return (b << 16) | a;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
//  CRC-32 table (256 × uint32)
// ─────────────────────────────────────────────────────────────────────────────

function _buildCRC32Table(): Uint32Array {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n >>> 0;
    for (var k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else       c = c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

const _crc32TableData = _buildCRC32Table();

// ─────────────────────────────────────────────────────────────────────────────
//  TypeScript fallbacks (correct, zero startup cost)
// ─────────────────────────────────────────────────────────────────────────────

function _tsChecksum(data: number[], offset: number = 0, length?: number): number {
  var len = (length !== undefined) ? length : data.length - offset;
  var sum = 0;
  for (var i = 0; i < len - 1; i += 2)
    sum += ((data[offset + i] & 0xff) << 8) | (data[offset + i + 1] & 0xff);
  if (len & 1) sum += (data[offset + len - 1] & 0xff) << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function _tsChecksumBuf(ab: ArrayBuffer, offset: number = 0, length?: number): number {
  var v = new DataView(ab);
  var len = (length !== undefined) ? length : ab.byteLength - offset;
  var sum = 0;
  for (var i = 0; i < len - 1; i += 2)
    sum += (v.getUint8(offset + i) << 8) | v.getUint8(offset + i + 1);
  if (len & 1) sum += v.getUint8(offset + len - 1) << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function _tsCRC32(data: number[], offset: number, length: number, crc: number = 0xFFFFFFFF): number {
  var c = crc >>> 0;
  for (var i = 0; i < length; i++) {
    var b = data[offset + i] & 0xff;
    c = _crc32TableData[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Compiled native function handles (null = JIT not yet initialised or unavailable)
// ─────────────────────────────────────────────────────────────────────────────

var _nativChecksum:  ((...a: number[]) => number) | null = null;
var _nativFill8:     ((...a: number[]) => number) | null = null;
var _nativFill32:    ((...a: number[]) => number) | null = null;
var _nativCopy8:     ((...a: number[]) => number) | null = null;
var _nativCopy32:    ((...a: number[]) => number) | null = null;
var _nativCompare:   ((...a: number[]) => number) | null = null;
var _nativCRC32:     ((...a: number[]) => number) | null = null;
var _nativStrcmp:    ((...a: number[]) => number) | null = null;
var _nativMemchr:    ((...a: number[]) => number) | null = null;
var _nativFNV1A32:   ((...a: number[]) => number) | null = null;
var _nativXorBuf:    ((...a: number[]) => number) | null = null;
var _nativPackBE32:  ((...a: number[]) => number) | null = null;
var _nativUnpackBE32:((...a: number[]) => number) | null = null;
var _nativUnpackBE16:((...a: number[]) => number) | null = null;
var _nativLzCopy:    ((...a: number[]) => number) | null = null;
var _nativToLower8:  ((...a: number[]) => number) | null = null;
var _nativScanCRLF:  ((...a: number[]) => number) | null = null;
var _nativSumBuf:    ((...a: number[]) => number) | null = null;
var _nativClamp32:   ((...a: number[]) => number) | null = null;
var _nativPopCount:     ((...a: number[]) => number) | null = null;
var _nativSHA256Block:  ((...a: number[]) => number) | null = null;
var _nativChaCha20Block:((...a: number[]) => number) | null = null;
var _nativAdler32:      ((...a: number[]) => number) | null = null;

/** Physical address of the CRC-32 table once copied to a shared kernel buffer. */
var _crc32TablePhys: number = 0;

// SHA-256 K constants (64 × uint32, big-endian values as per FIPS 180-4)
function _buildSHA256KTable(): Uint32Array {
  return new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
}
const _sha256KData = _buildSHA256KTable();
/** Physical address of SHA-256 K table in shared physmem. */
var _sha256KPhys: number = 0;

// ChaCha20 quarter-round index table: 8 sets of (a,b,c,d) byte indices
// Column rounds: (0,4,8,12),(1,5,9,13),(2,6,10,14),(3,7,11,15)
// Diagonal rounds: (0,5,10,15),(1,6,11,12),(2,7,8,13),(3,4,9,14)
const _chacha20QRIndexTab = new Uint8Array([
  0,  4,  8, 12,
  1,  5,  9, 13,
  2,  6, 10, 14,
  3,  7, 11, 15,
  0,  5, 10, 15,
  1,  6, 11, 12,
  2,  7,  8, 13,
  3,  4,  9, 14,
]);
/** Physical address of ChaCha20 QR index table in shared physmem. */
var _chacha20QRTabPhys: number = 0;

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RFC 1071 Internet checksum.
 * Fast path:  uses JIT-compiled native code over an ArrayBuffer (zero copy).
 * Slow path:  falls back to TypeScript over a number[] (always works).
 */
export const JITChecksum = {
  /**
   * Compute checksum over a flat physical memory region.
   * physAddr must have been returned by kernel.physAddrOf() or from jitAlloc.
   */
  compute(physAddr: number, len: number): number {
    if (_nativChecksum) return _nativChecksum(physAddr, len);
    // No native — build a temp array (should be rare after init())
    var bytes: number[] = [];
    for (var i = 0; i < len; i++) bytes.push(kernel.readMem8(physAddr + i));
    return _tsChecksum(bytes);
  },

  /**
   * Compute checksum over an ArrayBuffer.
   * Uses kernel.physAddrOf() to get the flat physical address, then calls
   * the native JIT checksum — no copy of the data.
   */
  computeBuf(ab: ArrayBuffer, offset: number = 0, length?: number): number {
    if (_nativChecksum && typeof kernel !== 'undefined' && kernel.physAddrOf) {
      var phys = kernel.physAddrOf(ab);
      if (phys) {
        var len = (length !== undefined) ? length : ab.byteLength - offset;
        return _nativChecksum(phys + offset, len);
      }
    }
    return _tsChecksumBuf(ab, offset, length);
  },

  /**
   * Compute checksum over a number[] (existing net stack API, unmodified).
   * Automatically upgrades to a fast ArrayBuffer-backed path when possible.
   */
  computeArray(data: number[], offset: number = 0, length?: number): number {
    var len = (length !== undefined) ? length : data.length - offset;
    if (_nativChecksum && typeof kernel !== 'undefined' && kernel.physAddrOf) {
      // Copy into a shared ArrayBuffer once, then call JIT native.
      var ab = new Uint8Array(len);
      for (var i = 0; i < len; i++) ab[i] = data[offset + i];
      var phys = kernel.physAddrOf(ab.buffer);
      if (phys) return _nativChecksum(phys, len);
    }
    return _tsChecksum(data, offset, length);
  },
};

/**
 * Physical memory fill / copy / compare — JIT-compiled.
 * These are called by the canvas, VMM, and any code that handles raw
 * physical memory ranges.
 */
export const JITMem = {
  /** Fill `len` bytes at physAddr with value (byte granularity). */
  fill8(physAddr: number, val: number, len: number): void {
    if (_nativFill8) { _nativFill8(physAddr, val, len); return; }
    for (var i = 0; i < len; i++) kernel.writeMem8(physAddr + i, val & 0xff);
  },

  /** Fill `len` 32-bit dwords at physAddr with value. */
  fill32(physAddr: number, val: number, len: number): void {
    if (_nativFill32) { _nativFill32(physAddr, val, len); return; }
    for (var i = 0; i < len; i++) {
      var a = physAddr + i * 4;
      kernel.writeMem8(a,     (val)       & 0xff);
      kernel.writeMem8(a + 1, (val >> 8)  & 0xff);
      kernel.writeMem8(a + 2, (val >> 16) & 0xff);
      kernel.writeMem8(a + 3, (val >> 24) & 0xff);
    }
  },

  /** Copy `len` bytes from src to dst (non-overlapping physical ranges). */
  copy8(dst: number, src: number, len: number): void {
    if (_nativCopy8) { _nativCopy8(dst, src, len); return; }
    for (var i = 0; i < len; i++)
      kernel.writeMem8(dst + i, kernel.readMem8(src + i));
  },

  /** Copy `len` dwords from src to dst (non-overlapping physical ranges). */
  copy32(dst: number, src: number, len: number): void {
    if (_nativCopy32) { _nativCopy32(dst, src, len); return; }
    for (var i = 0; i < len; i++) {
      var s = src + i * 4; var d = dst + i * 4;
      for (var b = 0; b < 4; b++) kernel.writeMem8(d + b, kernel.readMem8(s + b));
    }
  },

  /**
   * Compare `len` bytes at physical addresses a and b.
   * Returns 0 if equal, non-zero otherwise.
   */
  compare(a: number, b: number, len: number): number {
    if (_nativCompare) return _nativCompare(a, b, len);
    for (var i = 0; i < len; i++) {
      var diff = kernel.readMem8(a + i) - kernel.readMem8(b + i);
      if (diff !== 0) return diff;
    }
    return 0;
  },
};

/**
 * CRC-32 (IEEE 802.3 / Ethernet / ZIP / FAT).
 * init() must be called before these functions (to write the table to physmem).
 */
export const JITCRC32 = {
  /** Update a running CRC with `length` bytes from a number[] at offset. */
  update(data: number[], offset: number, length: number, crc: number = 0xFFFFFFFF): number {
    if (_nativCRC32 && _crc32TablePhys) {
      // Copy bytes to a temp ArrayBuffer, then call JIT native
      var ab = new Uint8Array(length);
      for (var i = 0; i < length; i++) ab[i] = data[offset + i];
      var phys = typeof kernel !== 'undefined' && kernel.physAddrOf
        ? kernel.physAddrOf(ab.buffer) : 0;
      if (phys) return _nativCRC32(phys, length, _crc32TablePhys, crc >>> 0);
    }
    return _tsCRC32(data, offset, length, crc);
  },

  /** Update a running CRC over an ArrayBuffer region. */
  updateBuf(ab: ArrayBuffer, offset: number, length: number, crc: number = 0xFFFFFFFF): number {
    if (_nativCRC32 && _crc32TablePhys && typeof kernel !== 'undefined' && kernel.physAddrOf) {
      var phys = kernel.physAddrOf(ab);
      if (phys) return _nativCRC32(phys + offset, length, _crc32TablePhys, crc >>> 0);
    }
    var v = new DataView(ab);
    var c = crc >>> 0;
    for (var i = 0; i < length; i++) {
      var b = v.getUint8(offset + i);
      c = _crc32TableData[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return c;
  },

  /** Finalise CRC (XOR with 0xFFFFFFFF). */
  finish(crc: number): number { return (crc ^ 0xFFFFFFFF) >>> 0; },
};

// ─────────────────────────────────────────────────────────────────────────────
//  JITString — string/byte-search primitives over physical memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * String / byte-search operations JIT-compiled to native x86-32.
 * All functions degrade gracefully to TypeScript when JIT is unavailable.
 *
 * Physical addresses are used throughout because kernel strings live in
 * raw memory not managed by the JS GC.  Use kernel.physAddrOf(ab) to obtain
 * the physical address of an ArrayBuffer if needed.
 */
export const JITString = {
  /**
   * Compare two null-terminated byte strings in physical memory.
   * strcmp8(aPhys, bPhys, maxLen) → negative / 0 / positive  (C strcmp semantics).
   */
  strcmp8(aPhys: number, bPhys: number, maxLen: number): number {
    if (_nativStrcmp) return _nativStrcmp(aPhys, bPhys, maxLen);
    // TypeScript fallback
    for (let i = 0; i < maxLen; i++) {
      const raw = typeof kernel !== 'undefined'
        ? kernel.readPhysMem(aPhys + i, 2) : null;
      if (!raw) break;
      const v = new DataView(raw);
      const ca = v.getUint8(0), cb = v.getUint8(1); // can't read b independently here
      // For TS fallback, use readPhysMem with 1 byte each
      const ra = typeof kernel !== 'undefined' ? kernel.readPhysMem(aPhys + i, 1) : null;
      const rb = typeof kernel !== 'undefined' ? kernel.readPhysMem(bPhys + i, 1) : null;
      if (!ra || !rb) break;
      const cA = new DataView(ra).getUint8(0);
      const cB = new DataView(rb).getUint8(0);
      if (cA !== cB) return cA - cB;
      if (cA === 0) return 0;
    }
    return 0;
  },

  /**
   * Search for byte `val` in physical memory.
   * memchr8(physAddr, val, len) → physical address of first match or 0 if not found.
   */
  memchr8(physAddr: number, val: number, len: number): number {
    if (_nativMemchr) return _nativMemchr(physAddr, val & 0xFF, len);
    // TypeScript fallback
    const b = val & 0xFF;
    const raw = typeof kernel !== 'undefined' ? kernel.readPhysMem(physAddr, len) : null;
    if (!raw) return 0;
    const v = new Uint8Array(raw);
    for (let i = 0; i < len; i++) if (v[i] === b) return physAddr + i;
    return 0;
  },

  /**
   * FNV-1a 32-bit hash of `len` bytes at `physAddr`.
   * fnv1a32(physAddr, len) → uint32 hash value.
   * Useful for fast string key hashing in VFS path caches.
   */
  fnv1a32(physAddr: number, len: number): number {
    if (_nativFNV1A32) return _nativFNV1A32(physAddr, len) >>> 0;
    // TypeScript fallback
    let hash = 0x811c9dc5;
    const raw = typeof kernel !== 'undefined' ? kernel.readPhysMem(physAddr, len) : null;
    if (!raw) return hash >>> 0;
    const v = new Uint8Array(raw);
    for (let i = 0; i < len; i++) {
      hash ^= v[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  },

  /** True when string ops are JIT-compiled to native code. */
  isNative(): boolean { return _nativStrcmp !== null; },
};

// ─────────────────────────────────────────────────────────────────────────────
//  JITOps — general-purpose OS hot-paths (net, fs, layout, math)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General-purpose JIT-compiled operations.
 * All functions fall back gracefully to TypeScript when JIT is unavailable.
 */
export const JITOps = {
  /** XOR src into dst, len bytes (AES-GCM CTR, ChaCha20 keystream, HKDF XOR). */
  xorBuf(dst: number, src: number, len: number): void {
    if (_nativXorBuf) { _nativXorBuf(dst, src, len); return; }
    for (var i = 0; i < len; i++) kernel.writeMem8(dst + i, (kernel.readMem8(dst + i) ^ kernel.readMem8(src + i)) & 0xff);
  },

  /** Store big-endian uint32 at physAddr (net packet builder). */
  packBE32(physAddr: number, val: number): void {
    if (_nativPackBE32) { _nativPackBE32(physAddr, val); return; }
    kernel.writeMem8(physAddr,     (val >> 24) & 0xff);
    kernel.writeMem8(physAddr + 1, (val >> 16) & 0xff);
    kernel.writeMem8(physAddr + 2, (val >>  8) & 0xff);
    kernel.writeMem8(physAddr + 3,  val        & 0xff);
  },

  /** Load big-endian uint32 from physAddr (net packet parser). */
  unpackBE32(physAddr: number): number {
    if (_nativUnpackBE32) return _nativUnpackBE32(physAddr);
    return ((kernel.readMem8(physAddr)     << 24) |
            (kernel.readMem8(physAddr + 1) << 16) |
            (kernel.readMem8(physAddr + 2) <<  8) |
             kernel.readMem8(physAddr + 3)) >>> 0;
  },

  /** Load big-endian uint16 from physAddr (TCP/IP header fields). */
  unpackBE16(physAddr: number): number {
    if (_nativUnpackBE16) return _nativUnpackBE16(physAddr);
    return ((kernel.readMem8(physAddr) << 8) | kernel.readMem8(physAddr + 1)) & 0xffff;
  },

  /** LZ77 match copy — hot inner loop of DEFLATE inflate / LZ4 decompress. */
  lzCopyMatch(dst: number, src: number, len: number): void {
    if (_nativLzCopy) { _nativLzCopy(dst, src, len); return; }
    for (var i = 0; i < len; i++) kernel.writeMem8(dst + i, kernel.readMem8(src + i));
  },

  /** ASCII lowercase buffer in-place (HTTP header name normalization). */
  toLower8(physAddr: number, len: number): void {
    if (_nativToLower8) { _nativToLower8(physAddr, len); return; }
    for (var i = 0; i < len; i++) {
      var c = kernel.readMem8(physAddr + i);
      if (c >= 65 && c <= 90) kernel.writeMem8(physAddr + i, c + 32);
    }
  },

  /** Scan for CRLF in physmem. Returns offset of \r or len. */
  scanCRLF(physAddr: number, offset: number, len: number): number {
    if (_nativScanCRLF) return _nativScanCRLF(physAddr, offset, len);
    for (var i = offset; i < len - 1; i++)
      if (kernel.readMem8(physAddr + i) === 13 && kernel.readMem8(physAddr + i + 1) === 10) return i;
    return len;
  },

  /** Sum all bytes in physmem region. */
  sumBuf(physAddr: number, len: number): number {
    if (_nativSumBuf) return _nativSumBuf(physAddr, len);
    var s = 0; for (var i = 0; i < len; i++) s += kernel.readMem8(physAddr + i) & 0xff; return s;
  },

  /** Clamp x to [lo, hi]. */
  clamp32(x: number, lo: number, hi: number): number {
    if (_nativClamp32) return _nativClamp32(x, lo, hi);
    return x < lo ? lo : x > hi ? hi : x;
  },

  /** Population count (number of set bits) of a 32-bit integer. */
  popCount32(x: number): number {
    if (_nativPopCount) return _nativPopCount(x);
    var v = x >>> 0;
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    v = (v + (v >> 4)) & 0x0f0f0f0f;
    return Math.imul(v, 0x01010101) >>> 24;
  },

  /** True when all JITOps are compiled to native code. */
  isNative(): boolean { return _nativXorBuf !== null; },
};

/** Physmem-addressed crypto primitives compiled to native x86-32. */
export const JITCrypto = {
  /**
   * SHA-256 block compression — reads/writes physmem directly.
   * hAddr  : 32 bytes  — 8 × uint32 hash state (a..h), updated in-place.
   * wAddr  : 256 bytes — 64 × uint32 message schedule (W[0..15] pre-filled;
   *                      W[16..63] extended by the kernel).
   * Requires JITOSKernels.init() to have been called first.
   * Returns true if the native path was taken.
   */
  sha256Block(hAddr: number, wAddr: number): boolean {
    if (_nativSHA256Block && _sha256KPhys) {
      _nativSHA256Block(hAddr, wAddr, _sha256KPhys);
      return true;
    }
    return false;
  },

  /**
   * ChaCha20 64-byte block — reads initial state from physmem, writes
   * serialised 64-byte output to physmem.
   * stateAddr : 64 bytes — 16 × uint32 initial state (little-endian).
   * outAddr   : 64 bytes — scratch + output (bytes on return).
   * Returns true if the native path was taken.
   */
  chacha20Block(stateAddr: number, outAddr: number): boolean {
    if (_nativChaCha20Block && _chacha20QRTabPhys) {
      _nativChaCha20Block(stateAddr, outAddr, _chacha20QRTabPhys);
      return true;
    }
    return false;
  },

  /**
   * Adler-32 checksum over a physmem region.
   * s1In/s2In are running accumulators (1/0 for a fresh hash).
   * Returns (s2 << 16) | s1 packed result.
   */
  adler32(physAddr: number, len: number, s1In: number, s2In: number): number {
    if (_nativAdler32) return _nativAdler32(physAddr, len, s1In, s2In);
    var a = s1In & 0xffff; var b = s2In & 0xffff;
    for (var i = 0; i < len; i++) {
      a = (a + (kernel.readMem8(physAddr + i) & 0xff)) % 65521;
      b = (b + a) % 65521;
    }
    return (b << 16) | a;
  },

  /** True when all crypto JIT kernels are compiled and physmem tables ready. */
  isNative(): boolean { return _nativSHA256Block !== null && _sha256KPhys !== 0; },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Boot initialisation
// ─────────────────────────────────────────────────────────────────────────────

var _initDone   = false;
var _initStats  = { compiled: 0, bytes: 0 };

export const JITOSKernels = {
  /**
   * Compile all OS JIT kernels.  Called once at boot from main.ts (after QJSJITHook.install).
   * Safe to call multiple times (idempotent).
   */
  init(): void {
    if (_initDone) return;
    _initDone = true;

    if (!JIT.available()) {
      if (typeof kernel !== 'undefined')
        kernel.serialPut('[jit-os] kernel.jitAlloc not available — using TS fallbacks\n');
      return;
    }

    function tryCompile(src: string, label: string): ((...a: number[]) => number) | null {
      var fn = JIT.compile(src);
      if (fn) {
        _initStats.compiled++;
        _initStats.bytes = JIT.stats().poolUsed;
      } else {
        kernel.serialPut('[jit-os] compile failed: ' + label + '\n');
      }
      return fn;
    }

    _nativChecksum = tryCompile(_SRC_CHECKSUM, 'checksum');
    _nativFill8    = tryCompile(_SRC_FILL8,    'fill8');
    _nativFill32   = tryCompile(_SRC_FILL32,   'fill32');
    _nativCopy8    = tryCompile(_SRC_COPY8,    'copy8');
    _nativCopy32   = tryCompile(_SRC_COPY32,   'copy32');
    _nativCompare  = tryCompile(_SRC_COMPARE,  'compare');
    _nativCRC32    = tryCompile(_SRC_CRC32,    'crc32');
    _nativStrcmp   = tryCompile(_SRC_STRCMP,   'strcmp8');
    _nativMemchr   = tryCompile(_SRC_MEMCHR,   'memchr8');
    _nativFNV1A32    = tryCompile(_SRC_FNV1A32,       'fnv1a32');
    _nativXorBuf     = tryCompile(_SRC_XOR_BUF,        'xorBuf');
    _nativPackBE32   = tryCompile(_SRC_PACK_BE32,      'packBE32');
    _nativUnpackBE32 = tryCompile(_SRC_UNPACK_BE32,    'unpackBE32');
    _nativUnpackBE16 = tryCompile(_SRC_UNPACK_BE16,    'unpackBE16');
    _nativLzCopy     = tryCompile(_SRC_LZ_COPY_MATCH,  'lzCopyMatch');
    _nativToLower8   = tryCompile(_SRC_TO_LOWER8,      'toLower8');
    _nativScanCRLF   = tryCompile(_SRC_SCAN_CRLF,      'scanCRLF');
    _nativSumBuf     = tryCompile(_SRC_SUM_BUF,        'sumBuf');
    _nativClamp32    = tryCompile(_SRC_CLAMP32,        'clamp32');
    _nativPopCount      = tryCompile(_SRC_POP_COUNT32,    'popCount32');
    _nativSHA256Block   = tryCompile(_SRC_SHA256_BLOCK,   'sha256Block');
    _nativChaCha20Block = tryCompile(_SRC_CHACHA20_BLOCK, 'chacha20Block');
    _nativAdler32       = tryCompile(_SRC_ADLER32,        'adler32');

    // Write the CRC table into a shared ArrayBuffer so JIT native can access it
    if (_nativCRC32) {
      var tableAB = _crc32TableData.buffer;  // already a 1 KB ArrayBuffer
      var phys = kernel.physAddrOf ? kernel.physAddrOf(tableAB) : 0;
      if (phys) {
        _crc32TablePhys = phys;
      } else {
        // physAddrOf unavailable (old kernel) — disable JIT CRC
        _nativCRC32 = null;
      }
    }

    // Wire SHA-256 K table into physmem
    if (_nativSHA256Block) {
      var sha256KAB = _sha256KData.buffer;
      var sha256KPhys = kernel.physAddrOf ? kernel.physAddrOf(sha256KAB) : 0;
      if (sha256KPhys) {
        _sha256KPhys = sha256KPhys;
      } else {
        _nativSHA256Block = null;  // no physAddrOf — fall back to TS
      }
    }

    // Wire ChaCha20 QR index table into physmem
    if (_nativChaCha20Block) {
      var qrTabAB = _chacha20QRIndexTab.buffer;
      var qrTabPhys = kernel.physAddrOf ? kernel.physAddrOf(qrTabAB) : 0;
      if (qrTabPhys) {
        _chacha20QRTabPhys = qrTabPhys;
      } else {
        _nativChaCha20Block = null;  // no physAddrOf — fall back to TS
      }
    }

    kernel.serialPut('[jit-os] ' + _initStats.compiled + ' OS kernels compiled (' +
                     ((JIT.stats().poolUsed / 1024) | 0) + ' KB pool used)\n');
  },

  stats(): { compiled: number; poolUsedKB: number; checksumNative: boolean;
             memFillNative: boolean; crc32Native: boolean; stringNative: boolean } {
    return {
      compiled:         _initStats.compiled,
      poolUsedKB:       (JIT.stats().poolUsed / 1024) | 0,
      checksumNative:   _nativChecksum !== null,
      memFillNative:    _nativFill8    !== null,
      crc32Native:      _nativCRC32    !== null,
      stringNative:     _nativStrcmp   !== null,
    };
  },
};
