/**
 * JSOS Filesystem Compression — Item 205
 *
 * TypeScript implementations of LZ4 block compression and Zstandard (zstd)
 * decompression stubs, plus a CompressedBlockDevice wrapper that transparently
 * handles compressed blocks on top of any block device.
 *
 * LZ4 block format spec: https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md
 * Zstd frame format: RFC 8878
 */

import type { BlockDevice } from './blockdev.js';

// ────────────────────────────────────────────────────────────────────────────
// LZ4 Block Compression
// ────────────────────────────────────────────────────────────────────────────

const LZ4_HASH_LOG  = 16;
const LZ4_HASH_SIZE = 1 << LZ4_HASH_LOG;
const LZ4_MIN_MATCH = 4;
const LZ4_WILDCARD  = 8;
const LZ4_LAST_LITS = 5;
const LZ4_MF_LIMIT  = LZ4_WILCARD_CONST() + LZ4_LAST_LITS;

function LZ4_WILCARD_CONST() { return LZ4_WILDCARD; }

function lz4Hash(v: number): number {
  return (Math.imul(v, 0x9e3779b9) >>> (32 - LZ4_HASH_LOG)) >>> 0;
}

function lz4Read32(src: Uint8Array, pos: number): number {
  return src[pos] | (src[pos+1] << 8) | (src[pos+2] << 16) | (src[pos+3] << 24);
}

/**
 * Compress data using LZ4 block format.
 * Returns the compressed bytes (no frame header — pure block).
 */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const maxOut = src.length + Math.ceil(src.length / 255) + 16;
  const out  = new Uint8Array(maxOut);
  const htab = new Int32Array(LZ4_HASH_SIZE).fill(-1);

  let si = 0, di = 0, anchor = 0;
  const end = src.length;
  const mflim = end - LZ4_MF_LIMIT;

  while (si < mflim) {
    const v = lz4Read32(src, si);
    const h = lz4Hash(v);
    const ref = htab[h];
    htab[h] = si;

    let matchLen = 0;
    if (ref >= 0 && si - ref < 65536 && lz4Read32(src, ref) === v) {
      let mi = ref + LZ4_MIN_MATCH, ii = si + LZ4_MIN_MATCH;
      while (ii < end && src[mi] === src[ii]) { mi++; ii++; }
      matchLen = ii - si - LZ4_MIN_MATCH;

      const litLen = si - anchor;
      let token = Math.min(litLen, 15) << 4 | Math.min(matchLen, 15);
      out[di++] = token;
      // Extra literal length bytes
      let rem = litLen - 15;
      while (rem >= 0) { out[di++] = rem >= 255 ? 255 : rem; rem -= 255; }
      // Literals
      out.set(src.slice(anchor, si), di); di += litLen;
      // Offset (LE)
      const offset = si - ref;
      out[di++] = offset & 0xff; out[di++] = (offset >> 8) & 0xff;
      // Extra match length bytes
      rem = matchLen - 15;
      while (rem >= 0) { out[di++] = rem >= 255 ? 255 : rem; rem -= 255; }

      si += LZ4_MIN_MATCH + matchLen;
      anchor = si;
      continue;
    }
    si++;
  }

  // Last literal sequence
  const litLen = end - anchor;
  let token = Math.min(litLen, 15) << 4;
  out[di++] = token;
  let rem = litLen - 15;
  while (rem >= 0) { out[di++] = rem >= 255 ? 255 : rem; rem -= 255; }
  out.set(src.slice(anchor), di); di += litLen;

  return out.slice(0, di);
}

/**
 * Decompress LZ4 block data.
 * @param src  Compressed block bytes (no frame header)
 * @param maxOutput  Maximum expected output size
 */
export function lz4Decompress(src: Uint8Array, maxOutput: number): Uint8Array {
  const out = new Uint8Array(maxOutput);
  let si = 0, di = 0;
  while (si < src.length) {
    const token = src[si++];
    // Literal length
    let litLen = token >> 4;
    if (litLen === 15) {
      let extra: number;
      do { extra = src[si++]; litLen += extra; } while (extra === 255 && si < src.length);
    }
    // Copy literals
    for (let i = 0; i < litLen && si < src.length && di < maxOutput; i++) out[di++] = src[si++];
    if (si >= src.length) break;
    // Match
    const offset = src[si] | (src[si+1] << 8); si += 2;
    let matchLen = (token & 0x0f) + LZ4_MIN_MATCH;
    if (matchLen - LZ4_MIN_MATCH === 15) {
      let extra: number;
      do { extra = src[si++]; matchLen += extra; } while (extra === 255 && si < src.length);
    }
    let matchPos = di - offset;
    for (let i = 0; i < matchLen && di < maxOutput; i++, di++, matchPos++) {
      out[di] = out[matchPos >= 0 ? matchPos : 0];
    }
  }
  return out.slice(0, di);
}

// ────────────────────────────────────────────────────────────────────────────
// Zstandard (zstd) — Frame decompression stubs
// ────────────────────────────────────────────────────────────────────────────

const ZSTD_MAGIC = 0xfd2fb528;

export interface ZstdFrameHeader {
  magic: number;
  windowSize: number;
  contentSize: number;
  hasDict: boolean;
  dictId: number;
  hasChecksum: boolean;
}

/** Parse Zstd frame header (RFC 8878 §3.1) */
export function parseZstdFrameHeader(data: Uint8Array): ZstdFrameHeader | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 4) return null;
  const magic = dv.getUint32(0, true);
  if (magic !== ZSTD_MAGIC) return null;
  const fhd = data[4];  // Frame_Header_Descriptor
  const fcs_field_size = [0, 2, 4, 8][ (fhd >> 6) & 3];
  const single_segment  = !!(fhd & 0x20);
  const has_checksum    = !!(fhd & 0x04);
  const dict_id_flag    = fhd & 0x03;
  const dictIdSizes     = [0, 1, 2, 4];
  const dictIdSize      = dictIdSizes[dict_id_flag];
  let off = 5;
  let windowSize = 0;
  if (!single_segment) {
    // Window_Descriptor byte
    const wlog = data[off] >> 3;
    const wmantissa = data[off] & 0x07;
    windowSize = ((wmantissa | 8) << wlog) >> 3;
    off++;
  }
  let dictId = 0;
  for (let i = 0; i < dictIdSize; i++) dictId |= data[off++] << (i * 8);
  let contentSize = 0;
  for (let i = 0; i < fcs_field_size; i++) contentSize |= data[off++] << (i * 8);
  return { magic, windowSize, contentSize, hasDict: dictId !== 0, dictId, hasChecksum: has_checksum };
}

/**
 * Zstd decompression — STUB.
 *
 * Full Zstd decompression requires implementing:
 *  - Huffman tree decoding (FSE compressed format)
 *  - ANS/FSE bit streams
 *  - Sequence decoding (literals + match lengths + offsets)
 *
 * For JSOS, leverage the native QuickJS runtime's built-in WASM Zstd if available,
 * or the kernel's zstd_decompress() C function via syscall.
 *
 * Returns null if decompression is not yet available.
 */
export function zstdDecompress(compressed: Uint8Array): Uint8Array | null {
  // Check if syscall is available
  if (typeof (globalThis as unknown as Record<string, unknown>).__zstdDecompress === 'function') {
    return (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).__zstdDecompress(compressed) as Uint8Array;
  }
  // Stub: return null to signal unavailability
  void compressed;
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// CompressedBlockDevice
// ────────────────────────────────────────────────────────────────────────────

export type CompressionAlgorithm = 'lz4' | 'zstd' | 'none';

export interface CompressedSectorHeader {
  algorithm: CompressionAlgorithm;
  originalSize: number;
  compressedSize: number;
}

/** Parse a 12-byte sector header prepended by the filesystem layer */
function parseSectorHeader(sector: Uint8Array): CompressedSectorHeader | null {
  if (sector.length < 12) return null;
  const magic = sector[0] | (sector[1] << 8);
  if (magic !== 0x4c5a /* 'LZ' */ && magic !== 0x5a53 /* 'ZS' */ && magic !== 0x4e4f /* 'NO' */) return null;
  const algorithm: CompressionAlgorithm = magic === 0x4c5a ? 'lz4' : magic === 0x5a53 ? 'zstd' : 'none';
  const dv = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
  const originalSize   = dv.getUint32(4, true);
  const compressedSize = dv.getUint32(8, true);
  return { algorithm, originalSize, compressedSize };
}

/**
 * A BlockDevice wrapper that transparently decompresses blocks.
 *
 * Each physical sector starts with a 12-byte CompressedSectorHeader.
 * If algorithm is 'none', the remaining data is returned as-is.
 */
export class CompressedBlockDevice implements BlockDevice {
  readonly name: string;
  readonly sectorSize: number;
  readonly sectorCount: number;

  constructor(private _inner: BlockDevice) {
    this.name = `compressed(${_inner.name})`;
    this.sectorSize = _inner.sectorSize;
    this.sectorCount = _inner.sectorCount;
  }

  async readSectors(lba: number, count: number): Promise<Uint8Array> {
    const raw = await this._inner.readSectors(lba, count);
    return this._decompress(raw);
  }

  async writeSectors(lba: number, data: Uint8Array): Promise<number> {
    const compressed = this._compress('lz4', data);
    return this._inner.writeSectors(lba, compressed);
  }

  private _decompress(data: Uint8Array): Uint8Array {
    const hdr = parseSectorHeader(data);
    if (!hdr || hdr.algorithm === 'none') return data.slice(12);
    const payload = data.slice(12, 12 + hdr.compressedSize);
    if (hdr.algorithm === 'lz4') return lz4Decompress(payload, hdr.originalSize);
    if (hdr.algorithm === 'zstd') return zstdDecompress(payload) ?? payload;
    return payload;
  }

  private _compress(algorithm: CompressionAlgorithm, data: Uint8Array): Uint8Array {
    const compressed = algorithm === 'lz4' ? lz4Compress(data) : data;
    const hdr = new Uint8Array(12);
    const dv = new DataView(hdr.buffer);
    const magic = algorithm === 'lz4' ? 0x4c5a : algorithm === 'zstd' ? 0x5a53 : 0x4e4f;
    dv.setUint16(0, magic, true);
    dv.setUint16(2, 1, true);  // version
    dv.setUint32(4, data.length, true);
    dv.setUint32(8, compressed.length, true);
    const out = new Uint8Array(12 + compressed.length);
    out.set(hdr); out.set(compressed, 12);
    return out;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// fsCompression singleton
// ────────────────────────────────────────────────────────────────────────────

interface FSCompression {
  compress(algorithm: CompressionAlgorithm, data: Uint8Array): Uint8Array;
  decompress(algorithm: CompressionAlgorithm, data: Uint8Array, maxOutput?: number): Uint8Array | null;
  wrapDevice(dev: BlockDevice): CompressedBlockDevice;
  detectAlgorithm(data: Uint8Array): CompressionAlgorithm;
}

export const fsCompression: FSCompression = {
  compress(algorithm, data) {
    if (algorithm === 'lz4') return lz4Compress(data);
    // zstd compression not yet implemented — fall back to uncompressed
    return data;
  },

  decompress(algorithm, data, maxOutput = data.length * 4) {
    if (algorithm === 'lz4') return lz4Decompress(data, maxOutput);
    if (algorithm === 'zstd') return zstdDecompress(data);
    return data;
  },

  wrapDevice(dev) { return new CompressedBlockDevice(dev); },

  detectAlgorithm(data) {
    if (data.length < 4) return 'none';
    const magic32 = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
    if (magic32 === ZSTD_MAGIC) return 'zstd';
    // LZ4 frame magic: 0x04224D18
    if (magic32 === 0x04224d18) return 'lz4';
    return 'none';
  },
};
