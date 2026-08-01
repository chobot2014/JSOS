/**
 * img-png.ts — Pure TypeScript PNG decoder
 *
 * Supports:
 *  - DEFLATE inflate (non-compressed, fixed Huffman, dynamic Huffman blocks)
 *  - zlib header stripping
 *  - PNG filter reconstruction (None, Sub, Up, Average, Paeth)
 *  - Color types: Greyscale(0), RGB(2), Palette(3), Greyscale+Alpha(4), RGBA(6)
 *  - Bit depth: 1, 2, 4, 8 (16-bit downsampled to 8-bit)
 *  - Output: DecodedImage { w, h, data: Uint32Array (0xAARRGGBB) }
 *
 * Limitations (acceptable for JSOS Browser):
 *  - Interlaced (Adam7) PNGs: displays as corrupted (rare in practice)
 *  - Max image size: limited by QuickJS heap (set to ~2048×2048 in index.ts)
 *  - No tRNS chunk yet (palette transparency)
 */

import type { DecodedImage } from './types.js';

// ── LIT/LENGTH and DISTANCE tables ───────────────────────────────────────────

// RFC 1951 — length codes 257-285
var _LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
var _LEN_EXTRA = [0,0,0,0,0,0,0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4,  4,  5,  5,  5,  5,  0];
// Distance codes 0-29
var _DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
var _DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,  4, 4, 5, 5,  6,  6,  7,  7,  8,  8,   9,   9,  10,  10,  11,  11,  12,   12,   13,   13];
// Code-length alphabet order
var _CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

// ── Bit reader ────────────────────────────────────────────────────────────────

function makeBR(buf: Uint8Array, start: number): { rb: () => number; rbs: (n: number) => number; align: () => void; r8: () => number; r16le: () => number; pos: () => number } {
  var _pos = start;
  var _bit = 0;

  function rb(): number {
    if (_pos >= buf.length) return 0;
    var b = (buf[_pos]! >> _bit) & 1;
    _bit++;
    if (_bit === 8) { _bit = 0; _pos++; }
    return b;
  }
  function rbs(n: number): number {
    var r = 0;
    for (var i = 0; i < n; i++) r |= rb() << i;
    return r;
  }
  function align(): void { if (_bit > 0) { _bit = 0; _pos++; } }
  function r8(): number { align(); return buf[_pos++] ?? 0; }
  function r16le(): number { var v = (buf[_pos] ?? 0) | ((buf[_pos + 1] ?? 0) << 8); _pos += 2; return v; }
  function pos(): number { return _pos; }

  return { rb, rbs, align, r8, r16le, pos };
}

// ── Huffman table builder ─────────────────────────────────────────────────────

type HuffDecoder = (rb: () => number) => number;

function buildHuff(lengths: number[]): HuffDecoder {
  var maxLen = 0;
  for (var i = 0; i < lengths.length; i++) if ((lengths[i] ?? 0) > maxLen) maxLen = lengths[i]!;
  if (maxLen === 0) return function(_rb) { return -1; };

  // Count codes per length
  var blCount = new Int32Array(maxLen + 2);
  for (var i2 = 0; i2 < lengths.length; i2++) { var l = lengths[i2] ?? 0; if (l > 0) blCount[l]++; }

  // First code for each bit length
  var nextCode = new Int32Array(maxLen + 2);
  var code = 0;
  for (var bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]!) << 1;
    nextCode[bits] = code;
  }

  // Build lookup: (len << 20 | code) -> symbol
  // We use a flat Uint32Array keyed by a hash for speed
  var table = new Map<number, number>();
  for (var sym = 0; sym < lengths.length; sym++) {
    var ll = lengths[sym] ?? 0;
    if (ll === 0) continue;
    var kk = (ll << 20) | nextCode[ll]!;
    table.set(kk, sym);
    nextCode[ll]!++;
  }

  return function(rb3: () => number): number {
    var c3 = 0;
    for (var b3 = 1; b3 <= maxLen; b3++) {
      c3 = (c3 << 1) | rb3();
      var sym3 = table.get((b3 << 20) | c3);
      if (sym3 !== undefined) return sym3;
    }
    return -1;
  };
}

// ── DEFLATE inflate ───────────────────────────────────────────────────────────

/**
 * Decompress a zlib-wrapped DEFLATE stream (as used by PNG IDAT chunks).
 * Input: concatenated IDAT byte array starting with the 2-byte zlib header.
 * Output: raw decompressed bytes as Uint8Array.
 */
export function inflate(data: Uint8Array): Uint8Array {
  // zlib header: CMF + FLG (2 bytes)
  var br = makeBR(data, 2);
  var out: number[] = [];

  // Fixed Huffman literal table (lengths from RFC 1951 §3.2.6)
  var fixLitLengths = new Array<number>(288);
  for (var i = 0;   i < 144; i++) fixLitLengths[i] = 8;
  for (var i2 = 144; i2 < 256; i2++) fixLitLengths[i2] = 9;
  for (var i3 = 256; i3 < 280; i3++) fixLitLengths[i3] = 7;
  for (var i4 = 280; i4 < 288; i4++) fixLitLengths[i4] = 8;
  var fixDistLengths = new Array<number>(32).fill(5);

  var fixLitTable:  HuffDecoder | null = null;
  var fixDistTable: HuffDecoder | null = null;

  function decodeBlock(litDec: HuffDecoder, distDec: HuffDecoder): void {
    while (true) {
      var sym = litDec(br.rb);
      if (sym < 0) break;
      if (sym < 256) {
        out.push(sym);
      } else if (sym === 256) {
        break; // end of block
      } else {
        // Length symbol 257-285
        var li   = sym - 257;
        var len  = (_LEN_BASE[li]  ?? 3) + br.rbs(_LEN_EXTRA[li]  ?? 0);
        var dsym = distDec(br.rb);
        var dist = (_DIST_BASE[dsym] ?? 1) + br.rbs(_DIST_EXTRA[dsym] ?? 0);
        var start = out.length - dist;
        for (var ci = 0; ci < len; ci++) {
          out.push(out[start + (ci % dist)] ?? 0);
        }
      }
    }
  }

  var bfinal = 0;
  while (!bfinal) {
    bfinal = br.rb();
    var btype = br.rbs(2);

    if (btype === 0) {
      // Non-compressed
      br.align();
      var len2  = br.r16le();
      /* nlen = */ br.r16le();
      for (var j = 0; j < len2; j++) out.push(br.r8());
    } else if (btype === 1) {
      // Fixed Huffman
      if (!fixLitTable)  fixLitTable  = buildHuff(fixLitLengths);
      if (!fixDistTable) fixDistTable = buildHuff(fixDistLengths);
      decodeBlock(fixLitTable, fixDistTable);
    } else if (btype === 2) {
      // Dynamic Huffman
      var hlit  = br.rbs(5) + 257;
      var hdist = br.rbs(5) + 1;
      var hclen = br.rbs(4) + 4;

      var clLens = new Array<number>(19).fill(0);
      for (var ki = 0; ki < hclen; ki++) clLens[_CL_ORDER[ki]!] = br.rbs(3);
      var clDec = buildHuff(clLens);

      var lengths: number[] = [];
      while (lengths.length < hlit + hdist) {
        var cs = clDec(br.rb);
        if (cs < 16) {
          lengths.push(cs);
        } else if (cs === 16) {
          var cnt16 = br.rbs(2) + 3;
          var prev  = lengths[lengths.length - 1] ?? 0;
          for (var r = 0; r < cnt16; r++) lengths.push(prev);
        } else if (cs === 17) {
          var cnt17 = br.rbs(3) + 3;
          for (var r2 = 0; r2 < cnt17; r2++) lengths.push(0);
        } else if (cs === 18) {
          var cnt18 = br.rbs(7) + 11;
          for (var r3 = 0; r3 < cnt18; r3++) lengths.push(0);
        }
      }

      decodeBlock(
        buildHuff(lengths.slice(0, hlit)),
        buildHuff(lengths.slice(hlit, hlit + hdist)),
      );
    }
    // btype === 3 is an error — skip
  }

  return new Uint8Array(out);
}

// ── PNG helpers ───────────────────────────────────────────────────────────────

function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) | ((b[o+1] ?? 0) << 16) | ((b[o+2] ?? 0) << 8) | (b[o+3] ?? 0)) >>> 0;
}

function paethPredictor(a: number, b: number, c: number): number {
  var p  = a + b - c;
  var pa = Math.abs(p - a);
  var pb = Math.abs(p - b);
  var pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc)             return b;
  return c;
}

// ── Public: decodePNG ─────────────────────────────────────────────────────────

/**
 * Decode a PNG bytestream into a DecodedImage.
 * Returns null on any parse error.
 */
export function decodePNG(bytes: Uint8Array): DecodedImage | null {
  try {
    return _decodePNG(bytes);
  } catch (_e) {
    return null;
  }
}

function _decodePNG(bytes: Uint8Array): DecodedImage | null {
  // Check PNG signature (first 8 bytes)
  if (bytes.length < 8) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47) return null;

  var w = 0, h = 0, bitDepth = 8, colorType = 2, interlace = 0;
  var palette: number[] = [];
  var idatBufs: Uint8Array[] = [];

  var pos = 8; // skip signature

  while (pos + 8 <= bytes.length) {
    var chunkLen  = u32be(bytes, pos);     pos += 4;
    var chunkType = String.fromCharCode(
      bytes[pos]! & 0x7F, bytes[pos+1]! & 0x7F,
      bytes[pos+2]! & 0x7F, bytes[pos+3]! & 0x7F);
    pos += 4;

    if (chunkType === 'IHDR') {
      if (chunkLen < 13) return null;
      w         = u32be(bytes, pos);
      h         = u32be(bytes, pos + 4);
      bitDepth  = bytes[pos + 8] ?? 8;
      colorType = bytes[pos + 9] ?? 2;
      interlace = bytes[pos + 12] ?? 0; // [Item 476] 0=none, 1=Adam7
    } else if (chunkType === 'PLTE') {
      for (var pi = 0; pi < chunkLen; pi++) palette.push(bytes[pos + pi] ?? 0);
    } else if (chunkType === 'IDAT') {
      idatBufs.push(bytes.slice(pos, pos + chunkLen));
    } else if (chunkType === 'IEND') {
      break;
    }

    pos += chunkLen + 4; // data + CRC
    if (pos > bytes.length) break;
  }

  if (w === 0 || h === 0 || idatBufs.length === 0) return null;

  // Clamp image size
  if (w > 2048 || h > 2048) return null;

  // Concatenate IDAT chunks
  var totalLen = 0;
  for (var di = 0; di < idatBufs.length; di++) totalLen += idatBufs[di]!.length;
  var idat = new Uint8Array(totalLen);
  var off2 = 0;
  for (var di2 = 0; di2 < idatBufs.length; di2++) {
    idat.set(idatBufs[di2]!, off2);
    off2 += idatBufs[di2]!.length;
  }

  // Decompress IDAT
  var raw: Uint8Array;
  try { raw = inflate(idat); } catch (_e) { return null; }

  // Bytes per pixel
  var bypp = getBypp(colorType, bitDepth);
  var stride = Math.ceil(w * bypp);

  // [Item 476] Adam7 interlaced PNG support
  // For interlaced images, deinterlace first into a full linear filtered buffer,
  // then fall through to normal pixel conversion.
  var filtered = new Uint8Array(h * stride);

  if (interlace === 1) {
    // Adam7 pass parameters: [xOrigin, yOrigin, xStep, yStep]
    var _A7 = [
      [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8],
      [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
    ];
    var rawPos = 0;
    for (var pass = 0; pass < 7; pass++) {
      var xOrig = _A7[pass]![0] ?? 0;
      var yOrig = _A7[pass]![1] ?? 0;
      var xStep = _A7[pass]![2] ?? 1;
      var yStep = _A7[pass]![3] ?? 1;

      var passW = Math.ceil((w - xOrig) / xStep);
      var passH = Math.ceil((h - yOrig) / yStep);
      if (passW <= 0 || passH <= 0) continue;

      var passStride = Math.ceil(passW * bypp);
      // Temporary buffer for this pass's filtered data
      var passBuf = new Uint8Array(passH * passStride);

      for (var pRow = 0; pRow < passH; pRow++) {
        var fB = raw[rawPos++] ?? 0;
        var pOff = pRow * passStride;
        for (var pCol = 0; pCol < passStride; pCol++) {
          var pBpp = Math.max(1, Math.floor(bypp));
          var pA = pCol >= pBpp ? passBuf[pOff + pCol - pBpp]! : 0;
          var pB = pRow > 0 ? passBuf[(pRow - 1) * passStride + pCol]! : 0;
          var pC = (pRow > 0 && pCol >= pBpp) ? passBuf[(pRow - 1) * passStride + pCol - pBpp]! : 0;
          var pX = raw[rawPos++] ?? 0;
          var pR: number;
          switch (fB) {
            case 1: pR = (pX + pA) & 0xFF; break;
            case 2: pR = (pX + pB) & 0xFF; break;
            case 3: pR = (pX + Math.floor((pA + pB) / 2)) & 0xFF; break;
            case 4: pR = (pX + paethPredictor(pA, pB, pC)) & 0xFF; break;
            default: pR = pX;
          }
          passBuf[pOff + pCol] = pR;
        }
      }

      // Scatter pass pixels back to full image buffer
      for (var prY = 0; prY < passH; prY++) {
        for (var prX = 0; prX < passW; prX++) {
          var srcOff2 = prY * passStride + Math.round(prX * bypp);
          var dstX = xOrig + prX * xStep;
          var dstY = yOrig + prY * yStep;
          var dstOff = dstY * stride + Math.round(dstX * bypp);
          var pLen = Math.ceil(bypp);
          for (var pi2 = 0; pi2 < pLen; pi2++) {
            filtered[dstOff + pi2] = passBuf[srcOff2 + pi2] ?? 0;
          }
        }
      }
    }
  } else {
    // Non-interlaced: Apply PNG filter functions row by row
    for (var row = 0; row < h; row++) {
      var fByte  = raw[row * (stride + 1)] ?? 0;
      var inOff  = row * (stride + 1) + 1;
      var outOff = row * stride;

      for (var col = 0; col < stride; col++) {
        var bpp = Math.max(1, Math.floor(bypp));
        var a   = col >= bpp ? filtered[outOff + col - bpp]! : 0;
        var b   = row  > 0  ? filtered[(row - 1) * stride + col]! : 0;
        var c   = (row > 0 && col >= bpp) ? filtered[(row - 1) * stride + col - bpp]! : 0;
        var x   = raw[inOff + col] ?? 0;
        var result: number;
        switch (fByte) {
          case 0:  result = x; break;
          case 1:  result = (x + a)                           & 0xFF; break;
          case 2:  result = (x + b)                           & 0xFF; break;
          case 3:  result = (x + Math.floor((a + b) / 2))    & 0xFF; break;
          case 4:  result = (x + paethPredictor(a, b, c))    & 0xFF; break;
          default: result = x;
        }
        filtered[outOff + col] = result;
      }
    }
  }

  // Convert to 0xAARRGGBB pixel array
  var pixels = new Uint32Array(w * h);

  for (var py = 0; py < h; py++) {
    for (var px = 0; px < w; px++) {
      var pp = py * stride + px * bypp;
      var pr = 0, pg = 0, pb_v = 0, pa = 255;

      switch (colorType) {
        case 0: { // Greyscale
          pr = pg = pb_v = scaled(filtered[pp] ?? 0, bitDepth);
          break;
        }
        case 2: { // RGB
          if (bitDepth === 16) {
            pr   = filtered[pp]   ?? 0;
            pg   = filtered[pp+2] ?? 0;
            pb_v = filtered[pp+4] ?? 0;
          } else {
            pr   = filtered[pp]   ?? 0;
            pg   = filtered[pp+1] ?? 0;
            pb_v = filtered[pp+2] ?? 0;
          }
          break;
        }
        case 3: { // Palette
          var idx = filtered[pp] ?? 0;
          pr   = palette[idx * 3]     ?? 0;
          pg   = palette[idx * 3 + 1] ?? 0;
          pb_v = palette[idx * 3 + 2] ?? 0;
          break;
        }
        case 4: { // Greyscale + Alpha
          pr = pg = pb_v = scaled(filtered[pp] ?? 0, bitDepth);
          pa = scaled(filtered[pp + (bitDepth === 16 ? 2 : 1)] ?? 255, bitDepth);
          break;
        }
        case 6: { // RGBA
          if (bitDepth === 16) {
            pr   = filtered[pp]   ?? 0;
            pg   = filtered[pp+2] ?? 0;
            pb_v = filtered[pp+4] ?? 0;
            pa   = filtered[pp+6] ?? 255;
          } else {
            pr   = filtered[pp]   ?? 0;
            pg   = filtered[pp+1] ?? 0;
            pb_v = filtered[pp+2] ?? 0;
            pa   = filtered[pp+3] ?? 255;
          }
          break;
        }
      }

      pixels[py * w + px] = ((pa & 0xFF) << 24 | (pr & 0xFF) << 16 | (pg & 0xFF) << 8 | (pb_v & 0xFF)) >>> 0;
    }
  }

  return { w, h, data: pixels };
}

/** Return bytes-per-pixel for the given PNG color type and bit depth. */
function getBypp(colorType: number, bitDepth: number): number {
  var channels: number;
  switch (colorType) {
    case 0: channels = 1; break;   // Greyscale
    case 2: channels = 3; break;   // RGB
    case 3: channels = 1; break;   // Palette (1 byte per pixel index)
    case 4: channels = 2; break;   // Greyscale+Alpha
    case 6: channels = 4; break;   // RGBA
    default: channels = 3;
  }
  if (bitDepth === 16) return channels * 2;
  if (bitDepth < 8)   return 1;  // Sub-byte (1/2/4 bpp packed, we treat as 1 byte/pixel for simplicity)
  return channels;
}

/** Scale a bitDepth-bit value to 8 bits. */
function scaled(v: number, bitDepth: number): number {
  if (bitDepth === 8)  return v;
  if (bitDepth === 16) return v; // already read the high byte
  if (bitDepth === 4)  return v * 17;
  if (bitDepth === 2)  return v * 85;
  if (bitDepth === 1)  return v * 255;
  return v;
}
