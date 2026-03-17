/**
 * deflate.ts — Pure TypeScript DEFLATE / gzip / zlib decompressor (RFC 1951/1952/1950)
 *
 * Supports:
 *   - gzip format  (Content-Encoding: gzip, magic 1F 8B)
 *   - zlib format  (Content-Encoding: deflate, magic 78 xx)
 *   - raw DEFLATE  (used internally)
 *
 * Algorithm: LSB-first bit reader + Huffman trees + LZ77 back-reference output.
 * No WASM, no native — 100% TypeScript.
 */

// ── Bit-reader ────────────────────────────────────────────────────────────────

class BitReader {
  private _buf: number[];
  private _pos: number;   // byte index
  private _bits: number;  // bit accumulator (up to 32 bits)
  private _nbits: number; // bits available in accumulator

  constructor(buf: number[]) { this._buf = buf; this._pos = 0; this._bits = 0; this._nbits = 0; }

  /** Ensure at least n bits are in the accumulator. */
  private _fill(n: number): void {
    while (this._nbits < n) {
      if (this._pos >= this._buf.length) break;
      this._bits |= (this._buf[this._pos++] & 0xff) << this._nbits;
      this._nbits += 8;
    }
  }

  /** Read n bits (LSB first). */
  readBits(n: number): number {
    this._fill(n);
    var v = this._bits & ((1 << n) - 1);
    this._bits >>>= n;
    this._nbits -= n;
    return v;
  }

  /** Discard remaining partial byte, realign to byte boundary. */
  align(): void { this._bits = 0; this._nbits = 0; }

  /** Read a full byte (must be aligned). */
  readByte(): number { this._fill(8); return this.readBits(8); }

  /** Read a little-endian 16-bit word (must be aligned). */
  readU16LE(): number { return this.readByte() | (this.readByte() << 8); }

  get pos(): number { return this._pos - (this._nbits >> 3); }
  get remaining(): number { return this._buf.length - this._pos; }
}

// ── Huffman tree ──────────────────────────────────────────────────────────────

/**
 * Build a canonical Huffman table from length array.
 * Returns a decode table: for a given MSB-first code of the maximum bit length,
 * maps to {symbol, bits}. Unused entries have symbol=-1.
 *
 * We use a simple O(2^maxBits) lookup table approach (max 15 bits → 32 KB ints).
 * For DEFLATE max is 15 bits.
 */
interface HuffTable {
  table: Int32Array;  // symbol<<4 | bits_used, indexed by padded code
  maxBits: number;
}

function buildHuffTable(lengths: number[]): HuffTable {
  var maxBits = 0;
  for (var i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  if (maxBits === 0) return { table: new Int32Array(1), maxBits: 0 };

  // Count symbols per bit length
  var bl_count = new Int32Array(maxBits + 1);
  for (var i = 0; i < lengths.length; i++) if (lengths[i] > 0) bl_count[lengths[i]]++;

  // Calculate starting code for each bit length
  var next_code = new Int32Array(maxBits + 2);
  var code = 0;
  for (var bits = 1; bits <= maxBits; bits++) {
    code = (code + bl_count[bits - 1]) << 1;
    next_code[bits] = code;
  }

  // Build symbol → code mapping
  var sz = 1 << maxBits;
  var table = new Int32Array(sz).fill(-1);

  for (var sym = 0; sym < lengths.length; sym++) {
    var len = lengths[sym];
    if (len === 0) continue;
    var c = next_code[len]++;
    // Store in table for ALL possible bit suffixes (LSB-first → reverse the code)
    var rev = 0;
    for (var b = 0; b < len; b++) rev = (rev << 1) | ((c >> b) & 1);
    // Fill the table for all values starting with this reversed code
    var step = 1 << len;
    for (var j = rev; j < sz; j += step) {
      table[j] = (sym << 4) | len;
    }
  }

  return { table, maxBits };
}

/** Decode one symbol from the BitReader using Huffman table. */
function huffDecode(br: BitReader, ht: HuffTable): number {
  // Peek maxBits bits
  var nb = ht.maxBits;
  // fill accumulator
  var peek = 0; var bitsRead = 0;
  // We need to do LSB-first peek — readBits and put them back is expensive.
  // Instead, build a fresh read, then shorten by actual length used.
  peek = br.readBits(nb);
  var entry = ht.table[peek];
  if (entry < 0) return -1;  // error
  var sym  = entry >> 4;
  var used = entry & 0xF;
  // We read 'nb' bits but only used 'used' — return the rest
  if (used < nb) {
    var excess = nb - used;
    var back   = (peek >> used) & ((1 << excess) - 1);
    // Put the excess bits back (prepend to accumulator)
    // We destructure the BitReader internals via casting — same obj
    (br as any)._bits     = back | ((br as any)._bits << excess);
    (br as any)._nbits   += excess;
  }
  return sym;
}

// ── Fixed Huffman tables (DEFLATE block type 01) ──────────────────────────────

var _fixedLitHT: HuffTable | null = null;
var _fixedDistHT: HuffTable | null = null;

function getFixedTables(): { litHT: HuffTable; distHT: HuffTable } {
  if (_fixedLitHT) return { litHT: _fixedLitHT, distHT: _fixedDistHT! };

  // Literal/length: 0-143 → 8 bits, 144-255 → 9 bits, 256-279 → 7 bits, 280-287 → 8 bits
  var litLen = new Array(288);
  for (var i =   0; i <= 143; i++) litLen[i] = 8;
  for (var i = 144; i <= 255; i++) litLen[i] = 9;
  for (var i = 256; i <= 279; i++) litLen[i] = 7;
  for (var i = 280; i <= 287; i++) litLen[i] = 8;
  _fixedLitHT = buildHuffTable(litLen);

  // Distance: all 30 codes use 5 bits
  var distLen = new Array(32).fill(5);
  _fixedDistHT = buildHuffTable(distLen);

  return { litHT: _fixedLitHT, distHT: _fixedDistHT };
}

// ── Length / distance extra bits tables ──────────────────────────────────────

var _LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var _LEN_EXTRA = [0,0,0,0,0,0,0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,  4,  5,  5,  5,  5,  0];
var _DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var _DIST_EXTRA = [0,0,0,0,1,1,2,2,3, 3, 4, 4, 5, 5,  6,  6,  7,  7,  8,  8,   9,   9,  10,  10,  11,  11,  12,   12,   13,   13];

// ── Dynamic Huffman code lengths ──────────────────────────────────────────────

var _CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function readDynamicTables(br: BitReader): { litHT: HuffTable; distHT: HuffTable } | null {
  var hlit  = br.readBits(5) + 257;  // # lit/len codes
  var hdist = br.readBits(5) + 1;    // # distance codes
  var hclen = br.readBits(4) + 4;    // # code-length codes

  // Read code-length code lengths
  var clLens = new Array(19).fill(0);
  for (var i = 0; i < hclen; i++) clLens[_CL_ORDER[i]] = br.readBits(3);
  var clHT = buildHuffTable(clLens);

  // Decode literal+distance code lengths
  var totalLen = hlit + hdist;
  var lengths  = new Array(totalLen).fill(0);
  var j = 0;
  while (j < totalLen) {
    var sym = huffDecode(br, clHT);
    if (sym < 0) return null;
    if (sym <= 15) { lengths[j++] = sym; }
    else if (sym === 16) {
      var rep = br.readBits(2) + 3;
      var last = j > 0 ? lengths[j - 1] : 0;
      for (var k = 0; k < rep && j < totalLen; k++) lengths[j++] = last;
    } else if (sym === 17) {
      var rep2 = br.readBits(3) + 3;
      for (var k = 0; k < rep2 && j < totalLen; k++) lengths[j++] = 0;
    } else if (sym === 18) {
      var rep3 = br.readBits(7) + 11;
      for (var k = 0; k < rep3 && j < totalLen; k++) lengths[j++] = 0;
    }
  }

  var litHT  = buildHuffTable(lengths.slice(0, hlit));
  var distHT = buildHuffTable(lengths.slice(hlit, hlit + hdist));
  return { litHT, distHT };
}

// ── DEFLATE block decoder ─────────────────────────────────────────────────────

function inflateBlock(br: BitReader, out: number[], litHT: HuffTable, distHT: HuffTable): boolean {
  for (;;) {
    var sym = huffDecode(br, litHT);
    if (sym < 0) return false;
    if (sym < 256) { out.push(sym); continue; }
    if (sym === 256) break;  // end of block

    // Length symbol: 257..285
    var lenIdx = sym - 257;
    if (lenIdx >= _LEN_BASE.length) return false;
    var length = _LEN_BASE[lenIdx] + br.readBits(_LEN_EXTRA[lenIdx]);

    var distSym = huffDecode(br, distHT);
    if (distSym < 0 || distSym >= _DIST_BASE.length) return false;
    var dist = _DIST_BASE[distSym] + br.readBits(_DIST_EXTRA[distSym]);

    // Copy back-reference
    var from = out.length - dist;
    if (from < 0) return false;
    for (var ci = 0; ci < length; ci++) out.push(out[from + (ci % dist)]);
  }
  return true;
}

// ── Raw DEFLATE decompress ────────────────────────────────────────────────────

function inflateDEFLATE(data: number[]): number[] | null {
  var br  = new BitReader(data);
  var out: number[] = [];

  for (;;) {
    var bfinal = br.readBits(1);
    var btype  = br.readBits(2);

    if (btype === 0) {
      // Stored block — no compression
      br.align();
      var len  = br.readU16LE();
      var nlen = br.readU16LE();
      if ((len ^ nlen) !== 0xFFFF) return null;  // integrity check
      for (var i = 0; i < len; i++) out.push(br.readByte());
    } else if (btype === 1) {
      // Fixed Huffman
      var { litHT, distHT } = getFixedTables();
      if (!inflateBlock(br, out, litHT, distHT)) return null;
    } else if (btype === 2) {
      // Dynamic Huffman
      var tables = readDynamicTables(br);
      if (!tables) return null;
      if (!inflateBlock(br, out, tables.litHT, tables.distHT)) return null;
    } else {
      return null;  // reserved
    }

    if (bfinal) break;
  }

  return out;
}

// ── gzip wrapper ──────────────────────────────────────────────────────────────

/**
 * Decompress gzip-encoded data (RFC 1952).
 * Returns the decompressed bytes, or null on any error.
 */
export function gunzip(data: number[]): number[] | null {
  if (data.length < 18) return null;
  if (data[0] !== 0x1F || data[1] !== 0x8B) return null;  // magic
  if (data[2] !== 8) return null;  // CM = DEFLATE only

  var flg = data[3];
  var offset = 10;

  // skip FEXTRA
  if (flg & 0x04) {
    if (offset + 2 > data.length) return null;
    var xlen = data[offset] | (data[offset + 1] << 8);
    offset += 2 + xlen;
  }
  // skip FNAME (null-term string)
  if (flg & 0x08) { while (offset < data.length && data[offset] !== 0) offset++; offset++; }
  // skip FCOMMENT
  if (flg & 0x10) { while (offset < data.length && data[offset] !== 0) offset++; offset++; }
  // skip CRC16
  if (flg & 0x02) offset += 2;

  if (offset >= data.length) return null;
  // last 8 bytes = CRC32 + ISIZE — skip them from the DEFLATE stream
  var deflateEnd = data.length - 8;
  if (deflateEnd <= offset) return null;

  return inflateDEFLATE(data.slice(offset, deflateEnd));
}

// ── zlib wrapper (Content-Encoding: deflate from servers) ────────────────────

/**
 * Decompress zlib-wrapped DEFLATE data (RFC 1950).
 * Most HTTP servers that say "deflate" actually send zlib-wrapped data.
 * Returns decompressed bytes or null.
 */
export function zlibInflate(data: number[]): number[] | null {
  if (data.length < 2) return null;
  var cmf = data[0];
  var cm  = cmf & 0x0F;
  if (cm !== 8) return null;  // only DEFLATE compression method
  // skip 2-byte zlib header (and optional 4-byte preset dict)
  var hasDict = (data[1] & 0x20) !== 0;
  var offset  = hasDict ? 6 : 2;
  if (offset >= data.length) return null;
  // last 4 bytes = Adler-32 checksum — skip
  var deflateEnd = data.length - 4;
  if (deflateEnd <= offset) return null;
  return inflateDEFLATE(data.slice(offset, deflateEnd));
}

/**
 * Decompress HTTP response body based on Content-Encoding header.
 * Returns the decompressed bytes, or the original bytes if not compressed.
 */
export function httpDecompress(body: number[], encoding: string): number[] {
  var enc = encoding.trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') {
    return gunzip(body) ?? body;
  }
  if (enc === 'deflate') {
    // Try zlib first, then raw DEFLATE (some servers send raw despite saying "deflate")
    var r = zlibInflate(body);
    if (r) return r;
    r = inflateDEFLATE(body);
    if (r) return r;
    return body;  // pass through on failure
  }
  // identity / unknown: pass through
  return body;
}
