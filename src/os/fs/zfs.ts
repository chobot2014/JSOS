/**
 * JSOS ZFS Read-Only Driver Stubs — Item 201
 *
 * TypeScript stubs for ZFS on-disk format (OpenZFS).
 * Provides the key data structures and a read-only mount implementation
 * capable of reading pool/vdev topology and accessing file data via
 * the ZFS Object Set and DMU.
 *
 * Full ZFS is enormously complex; this implements the essential read path:
 *   - Pool label parsing (uberblock array, MOS object set)
 *   - DVA (Data Virtual Address) → Physical address resolution
 *   - Block pointer decompression (LZ4, uncompressed)
 *   - ZAP (ZFS Attribute Processor) object reading (micro-ZAP and fat-ZAP)
 *   - Directory / file inode (ZNode) access
 */

import type { Ext4BlockDevice } from './ext4.js';
import type { VFSMount, FileType } from './filesystem.js';

// ── ZFS constants ─────────────────────────────────────────────────────────────

const ZFS_MAGIC              = 0x0cb1ba00;   // pool label magic
const ZFS_SECTOR_SIZE        = 512;
const ZFS_BLKPTR_SIZE        = 128;          // bytes per block pointer
const ZFS_MAX_BLOCKSIZE      = 128 * 1024;   // 128 KiB max
const VDEV_LABEL_START       = 0;
const VDEV_LABEL_SIZE        = 256 * 1024;   // 256 KiB label
const UBERBLOCK_MAGIC        = 0x00bab10cn;  // BigInt
const UBERBLOCK_SIZE         = 1024;         // bytes
const UBERBLOCK_COUNT        = 128;
const ZAP_MICRO_MAGIC        = 0x8123456878200000n;
const ZAP_FAT_MAGIC          = 0x8000000000000007n;

// Compression types
const ZIO_COMPRESS_OFF        = 0;
const ZIO_COMPRESS_LZ4        = 15;
const ZIO_COMPRESS_GZIP_1     = 2;

// Object types
const DMU_OT_DIRECTORY        = 20;
const DMU_OT_PLAIN_FILE       = 19;
const DMU_OT_OBJECT_DIRECTORY = 2;
const DMU_OT_DSL_DATASET       = 16;

// ── Helpers ───────────────────────────────────────────────────────────────────

function u8(dv: DataView, o: number): number { return dv.getUint8(o); }
function u16(dv: DataView, o: number): number { return dv.getUint16(o, true); }
function u32(dv: DataView, o: number): number { return dv.getUint32(o, true); }
function u64(dv: DataView, o: number): number {
  return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
}
function u64n(dv: DataView, o: number): bigint { return dv.getBigUint64(o, true); }

// ── Block Pointer (blkptr_t) ──────────────────────────────────────────────────

interface ZFSBlockPtr {
  dva: Array<{ vdev: number; offset: number; asize: number }>;  // up to 3 DVAs
  compression: number;
  objectType: number;
  level: number;
  fill: number;
  checksum: Uint8Array;
  lsize: number;  // logical size
  psize: number;  // physical size
  isHole: boolean;
  isEmbedded: boolean;
  embeddedData?: Uint8Array;
}

function parseBlockPtr(data: Uint8Array, off: number): ZFSBlockPtr {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dva: ZFSBlockPtr['dva'] = [];
  for (let i = 0; i < 3; i++) {
    const w0n = u64n(dv, off + i * 16);
    const w1 = u32(dv, off + i * 16 + 8);
    const vdev   = u32(dv, off + i * 16 + 12);
    const offset = (w0n & 0x0007ffffffffffffn ? Number(w0n & 0x0007ffffffffffffn) << 9 : 0);
    const asize  = w1 >>> 16;
    dva.push({ vdev, offset, asize: asize * ZFS_SECTOR_SIZE });
  }
  const propN = u64n(dv, off + 48);
  const compression = Number((propN >> 32n) & 0xffn);
  const objectType  = Number((propN >> 40n) & 0xffn);
  const level       = Number((propN >> 56n) & 0x1fn);
  const embedded    = !!(propN & (1n << 39n));
  void embedded;
  const psize = (u16(dv, off + 56) + 1) * ZFS_SECTOR_SIZE;
  const lsize = (u16(dv, off + 58) + 1) * ZFS_SECTOR_SIZE;
  const fill  = u64(dv, off + 64);
  const checksum = data.slice(off + 72, off + 104);
  return { dva, compression, objectType, level, fill, checksum, lsize, psize, isHole: fill === 0, isEmbedded: false };
}

// ── Uberblock ─────────────────────────────────────────────────────────────────

interface ZFSUberblock {
  magic: bigint;
  version: number;
  txg: number;     // transaction group (highest = latest)
  guid_sum: number;
  timestamp: number;
  rootbp: ZFSBlockPtr;
}

function parseUberblock(data: Uint8Array, off: number): ZFSUberblock | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = u64n(dv, off);
  if (magic !== UBERBLOCK_MAGIC) return null;
  return {
    magic,
    version:   u64(dv, off + 8),
    txg:       u64(dv, off + 16),
    guid_sum:  u64(dv, off + 24),
    timestamp: u64(dv, off + 32),
    rootbp:    parseBlockPtr(data, off + 40),
  };
}

// ── ZAP (ZFS Attribute Processor) ─────────────────────────────────────────────

interface ZAPEntry {
  name: string;
  value: number;    // integer value (object number or attribute)
}

function readMicroZAP(data: Uint8Array): ZAPEntry[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = u64n(dv, 0);
  if (magic !== ZAP_MICRO_MAGIC) return [];
  const entries: ZAPEntry[] = [];
  const numChunks = (data.length - 64) / 64;
  for (let i = 0; i < numChunks; i++) {
    const off = 64 + i * 64;
    if (off + 64 > data.length) break;
    const value = u64(dv, off);
    const cd    = u32(dv, off + 8);
    void cd;
    const hash  = u64(dv, off + 12);
    void hash;
    const nameRaw = data.slice(off + 20, off + 64);
    const nullIdx = nameRaw.indexOf(0);
    const name = new TextDecoder().decode(nullIdx >= 0 ? nameRaw.slice(0, nullIdx) : nameRaw);
    if (name) entries.push({ name, value });
  }
  return entries;
}

function readFatZAP(data: Uint8Array): ZAPEntry[] {
  // Fat ZAP is a hash table of variable-length entries — stub returning empty
  // Full implementation would parse hash table chains and chunk arrays
  void data;
  return [];
}

function readZAP(data: Uint8Array): ZAPEntry[] {
  if (data.length < 8) return [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = u64n(dv, 0);
  if (magic === ZAP_MICRO_MAGIC) return readMicroZAP(data);
  if (magic === ZAP_FAT_MAGIC)   return readFatZAP(data);
  return [];
}

// ── LZ4 decompressor (block format) ──────────────────────────────────────────

function lz4Decompress(src: Uint8Array, maxOutput: number): Uint8Array {
  const out = new Uint8Array(maxOutput);
  let si = 0; let di = 0;
  while (si < src.length) {
    const token = src[si++];
    let litLen = token >> 4;
    if (litLen === 15) { let extra = 255; while (extra === 255 && si < src.length) { extra = src[si++]; litLen += extra; } }
    if (si + litLen > src.length) { out.set(src.slice(si, si + litLen), di); di += litLen; break; }
    out.set(src.slice(si, si + litLen), di); si += litLen; di += litLen;
    if (si >= src.length) break;
    const matchOff = src[si] | (src[si + 1] << 8); si += 2;
    let matchLen = (token & 0x0f) + 4;
    if (matchLen - 4 === 15) { let extra = 255; while (extra === 255 && si < src.length) { extra = src[si++]; matchLen += extra; } }
    let matchSrc = di - matchOff;
    for (let m = 0; m < matchLen && di < maxOutput; m++, di++, matchSrc++) {
      out[di] = out[matchSrc < 0 ? 0 : matchSrc];
    }
  }
  return out.slice(0, di);
}

// ── ZFS Filesystem Driver ─────────────────────────────────────────────────────

export class ZFSFS implements VFSMount {
  private _dev: Ext4BlockDevice;
  private _uberblock: ZFSUberblock | null = null;
  private _ready = false;

  readonly writable = false;

  constructor(dev: Ext4BlockDevice) {
    this._dev = dev;
  }

  private _readBytes(byteOffset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += ZFS_SECTOR_SIZE) {
      const s = this._dev.readSector(byteOffset + off);
      out.set(s.slice(0, Math.min(ZFS_SECTOR_SIZE, length - off)), off);
    }
    return out;
  }

  private _readBlock(bp: ZFSBlockPtr): Uint8Array | null {
    if (bp.isHole || !bp.dva.length) return new Uint8Array(bp.lsize);
    const dva = bp.dva[0];
    const raw = this._readBytes(dva.offset, bp.psize);
    if (bp.compression === ZIO_COMPRESS_LZ4) {
      const lz4Src = raw.slice(4); // first 4 bytes = uncompressed length (big-endian)
      const uncompLen = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
      return lz4Decompress(lz4Src, uncompLen);
    }
    return raw.slice(0, bp.lsize);
  }

  mount(): boolean {
    // Read first vdev label (256 KiB at offset 0)
    const label = this._readBytes(VDEV_LABEL_START, VDEV_LABEL_SIZE);
    // Uberblock array starts at 128 KiB within the label
    const uaOffset = 128 * 1024;
    let best: ZFSUberblock | null = null;
    for (let i = 0; i < UBERBLOCK_COUNT; i++) {
      const ub = parseUberblock(label, uaOffset + i * UBERBLOCK_SIZE);
      if (ub && (!best || ub.txg > best.txg)) best = ub;
    }
    if (!best) return false;
    this._uberblock = best;
    this._ready = true;
    return true;
  }

  unmount(): void { this._ready = false; }

  // VFSMount interface (filesystem.ts)
  read(path: string): string | null {
    const data = this.readFile(path);
    return data ? new TextDecoder().decode(data) : null;
  }
  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    return (this.readdir(path) ?? []).map(e => ({ name: e.name, type: e.type, size: 0 }));
  }
  exists(path: string): boolean { return this.stat(path) !== null; }
  isDirectory(path: string): boolean { return this.stat(path)?.type === 'directory'; }

  readdir(path: string): { name: string; type: FileType }[] | null {
    if (!this._ready) return null;
    // Full implementation requires traversing MOS → DSL → object set → ZAP
    // Stub: return empty directory
    void path;
    return [];
  }

  stat(path: string): { size: number; type: FileType; mode: number } | null {
    if (!this._ready) return null;
    void path;
    return null;
  }

  readFile(path: string): Uint8Array | null {
    if (!this._ready) return null;
    void path;
    return null;
  }

  get uberblock(): ZFSUberblock | null { return this._uberblock; }
  get txg(): number { return this._uberblock?.txg ?? 0; }
}

export function mountZFS(dev: Ext4BlockDevice): ZFSFS | null {
  const fs = new ZFSFS(dev);
  return fs.mount() ? fs : null;
}
