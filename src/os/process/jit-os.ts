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

/** Physical address of the CRC-32 table once copied to a shared kernel buffer. */
var _crc32TablePhys: number = 0;

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
    _nativFNV1A32  = tryCompile(_SRC_FNV1A32,  'fnv1a32');

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
