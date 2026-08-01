/**
 * img-jpeg.ts — Baseline JPEG decoder (SOF0)
 *
 * Supports:
 *   • 8-bit YCbCr and greyscale
 *   • 4:4:4, 4:2:2, 4:2:0 chroma subsampling
 *   • Standard JFIF/EXIF markers
 *
 * Returns DecodedImage { w, h, data: Uint32Array(w*h) } of 0xFFRRGGBB pixels.
 */

export interface DecodedImage { w: number; h: number; data: Uint32Array; }

// ── Zigzag scan order ─────────────────────────────────────────────────────
// Maps zigzag index → natural matrix index (row*8+col)
const ZZ = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10, 17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// ── IDCT cosine lookup ────────────────────────────────────────────────────
// ICOS[u*8+x] = C(u) * cos((2x+1)*u*pi/16)  (floating point, computed once)
const ICOS = new Float32Array(64);
(function () {
  const SQRT2_INV = 0.7071067811865476;
  for (var u = 0; u < 8; u++) {
    var cu = u === 0 ? SQRT2_INV : 1.0;
    for (var x = 0; x < 8; x++) {
      ICOS[u * 8 + x] = cu * Math.cos((2 * x + 1) * u * Math.PI / 16);
    }
  }
})();

// 2D separable IDCT — coeff[v*8+u] (dequantized), out[y*8+x] (0-255 + level shift)
function idct2d(coeff: Int16Array, out: Uint8Array): void {
  var tmp = new Float32Array(64);
  // Row-wise 1D IDCT: for each row v, transform over u → x
  for (var v = 0; v < 8; v++) {
    for (var x = 0; x < 8; x++) {
      var s = 0.0;
      for (var u = 0; u < 8; u++) s += ICOS[u * 8 + x] * coeff[v * 8 + u];
      tmp[v * 8 + x] = s * 0.5;
    }
  }
  // Column-wise 1D IDCT: for each col x, transform over v → y
  for (var x2 = 0; x2 < 8; x2++) {
    for (var y = 0; y < 8; y++) {
      var s2 = 0.0;
      for (var v2 = 0; v2 < 8; v2++) s2 += ICOS[v2 * 8 + y] * tmp[v2 * 8 + x2];
      var val = Math.round(s2 * 0.5) + 128; // level-shift
      out[y * 8 + x2] = val < 0 ? 0 : val > 255 ? 255 : val;
    }
  }
}

// ── Huffman table ─────────────────────────────────────────────────────────
interface HuffTable {
  // Lookup map: packed key (length<<16|code) → symbol (0-255)
  map: Map<number, number>;
  // minCode[len], maxCode[len], offset[len] for fast range check
  minCode: Int32Array;  // 17 entries [1..16]
  maxCode: Int32Array;
  offset:  Int32Array;
  vals:    Uint8Array;
}

function buildHuff(bits: Uint8Array, vals: Uint8Array): HuffTable {
  var minCode = new Int32Array(17);
  var maxCode = new Int32Array(17).fill(-1);
  var offset  = new Int32Array(17);
  var code = 0;
  var vi   = 0;
  var map  = new Map<number, number>();

  for (var len = 1; len <= 16; len++) {
    var count = bits[len - 1];
    if (count > 0) {
      minCode[len] = code;
      for (var k = 0; k < count; k++) {
        map.set((len << 16) | (code++), vals[vi++]);
      }
      maxCode[len] = code - 1;
      offset[len]  = vi - count;
    } else {
      minCode[len] = 0x7FFFFFFF;
    }
    code <<= 1;
  }

  return { map, minCode, maxCode, offset, vals };
}

// ── Bit reader (MSB-first, with FF00 byte stuffing) ───────────────────────
interface BitReader {
  data: Uint8Array;
  pos:  number;  // byte position
  buf:  number;  // current bit buffer
  blen: number;  // bits available in buf
}

function makeBR(data: Uint8Array, start: number): BitReader {
  return { data, pos: start, buf: 0, blen: 0 };
}

function readBits(br: BitReader, n: number): number {
  while (br.blen < n) {
    if (br.pos >= br.data.length) { br.buf = (br.buf << 8) | 0xFF; br.blen += 8; continue; }
    var b = br.data[br.pos++];
    if (b === 0xFF) {
      var next = br.data[br.pos];
      if (next === 0x00) { br.pos++; }     // byte stuffing: FF00 → FF
      else if (next >= 0xD0 && next <= 0xD7) { /* restart marker, skip */ }
      else { /* unexpected marker — stop reading */ br.blen += n; return 0; }
    }
    br.buf  = (br.buf << 8) | b;
    br.blen += 8;
  }
  br.blen -= n;
  return (br.buf >>> br.blen) & ((1 << n) - 1);
}

function readHuff(br: BitReader, ht: HuffTable): number {
  var code = 0;
  for (var len = 1; len <= 16; len++) {
    code = (code << 1) | readBits(br, 1);
    if (code <= ht.maxCode[len] && code >= ht.minCode[len]) {
      var sym = ht.map.get((len << 16) | code);
      return sym !== undefined ? sym : -1;
    }
  }
  return -1;
}

// Extend (sign-extend) a value with `nBits` bits
function extend(v: number, nBits: number): number {
  if (nBits === 0) return 0;
  return v < (1 << (nBits - 1)) ? v - (1 << nBits) + 1 : v;
}

// Decode one 8×8 block of coefficients from the bit stream
function decodeBlock(
  br: BitReader,
  htDC: HuffTable,
  htAC: HuffTable,
  prevDC: { val: number }
): Int16Array {
  var coeff = new Int16Array(64);

  // DC coefficient
  var dcCat = readHuff(br, htDC);
  if (dcCat < 0) return coeff;
  var dcDiff = dcCat > 0 ? extend(readBits(br, dcCat), dcCat) : 0;
  prevDC.val += dcDiff;
  coeff[0] = prevDC.val;

  // AC coefficients (positions 1..63 in zigzag order)
  var i = 1;
  while (i < 64) {
    var acSym = readHuff(br, htAC);
    if (acSym < 0) break;
    if (acSym === 0x00) break;         // EOB
    if (acSym === 0xF0) { i += 16; continue; }  // ZRL: 16 zeros
    var run  = (acSym >> 4) & 0xF;
    var size = acSym & 0xF;
    i += run;
    if (i >= 64) break;
    coeff[ZZ[i]] = extend(readBits(br, size), size);
    i++;
  }
  return coeff;
}

// ── YCbCr → RGB ───────────────────────────────────────────────────────────
function ycbcr2rgb(Y: number, Cb: number, Cr: number): number {
  Cb -= 128; Cr -= 128;
  var r = Y + 1.40200 * Cr;
  var g = Y - 0.34414 * Cb - 0.71414 * Cr;
  var b = Y + 1.77200 * Cb;
  var ri = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  var gi = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  var bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return 0xFF000000 | (ri << 16) | (gi << 8) | bi;
}

// ── Public entry point ────────────────────────────────────────────────────

export function decodeJPEG(bytes: Uint8Array): DecodedImage | null {
  try { return _decodeJPEG(bytes); } catch (_e) { return null; }
}

function _decodeJPEG(raw: Uint8Array): DecodedImage | null {
  if (raw[0] !== 0xFF || raw[1] !== 0xD8) return null;  // not JPEG

  // Tables
  var qtables: Uint16Array[] = [];          // up to 4 quantization tables (64 values each)
  var htDC: (HuffTable | null)[] = [null, null, null, null];
  var htAC: (HuffTable | null)[] = [null, null, null, null];

  // Frame info
  var imgW = 0, imgH = 0;
  var numComp = 0;
  // Per-component: id, H-sampling, V-sampling, qtable index
  var compId   = new Uint8Array(4);
  var compH    = new Uint8Array(4);  // horizontal sampling factor
  var compV    = new Uint8Array(4);  // vertical sampling factor
  var compQt   = new Uint8Array(4);  // quantization table selector
  // Scan component mapping to DC/AC tables
  var scanDC   = new Uint8Array(4);
  var scanAC   = new Uint8Array(4);

  var i = 2;  // skip SOI

  function readU16(): number {
    var v = (raw[i] << 8) | raw[i + 1]; i += 2; return v;
  }

  // ── Marker scan ────────────────────────────────────────────────────────
  outer: while (i < raw.length - 1) {
    // Seek next FF xx marker
    if (raw[i] !== 0xFF) { i++; continue; }
    var marker = raw[i + 1]; i += 2;
    if (marker === 0x00 || (marker >= 0xD0 && marker <= 0xD7)) continue; // stuffing / RST
    if (marker === 0xD9) break; // EOI

    // Segment length (includes the 2 length bytes)
    var segStart = i;
    var segLen   = (raw[i] << 8) | raw[i + 1];
    var segEnd   = segStart + segLen;

    if (marker === 0xC0) {
      // SOF0 — baseline DCT frame header
      i += 2; // skip length
      var precision = raw[i++]; if (precision !== 8) return null;
      imgH = readU16(); imgW = readU16();
      numComp = raw[i++];
      for (var ci = 0; ci < numComp; ci++) {
        compId[ci] = raw[i++];
        var sf = raw[i++];
        compH[ci] = (sf >> 4) & 0xF;
        compV[ci] = sf & 0xF;
        compQt[ci] = raw[i++];
      }
    } else if (marker === 0xC4) {
      // DHT — define Huffman table
      i += 2; // skip length
      while (i < segEnd) {
        var htInfo = raw[i++];
        var htClass = (htInfo >> 4) & 0xF;  // 0=DC, 1=AC
        var htId    = htInfo & 0xF;
        var bits    = raw.slice(i, i + 16); i += 16;
        var count   = 0; for (var k = 0; k < 16; k++) count += bits[k];
        var vals    = raw.slice(i, i + count); i += count;
        var ht      = buildHuff(bits, vals);
        if (htClass === 0) htDC[htId] = ht; else htAC[htId] = ht;
      }
    } else if (marker === 0xDB) {
      // DQT — define quantization table
      i += 2; // skip length
      while (i < segEnd) {
        var qtInfo  = raw[i++];
        var qtPrec  = (qtInfo >> 4) & 0xF;
        var qtId    = qtInfo & 0xF;
        var qt      = new Uint16Array(64);
        for (var q = 0; q < 64; q++) {
          qt[ZZ[q]] = qtPrec === 0 ? raw[i++] : ((raw[i++] << 8) | raw[i++]);
        }
        qtables[qtId] = qt;
      }
    } else if (marker === 0xDA) {
      // SOS — start of scan
      i += 2; // skip length
      var scanComps = raw[i++];
      for (var sc = 0; sc < scanComps; sc++) {
        var scanCompId = raw[i++];
        var tablesSel  = raw[i++];
        // find component index
        var ci2 = 0;
        for (var j = 0; j < numComp; j++) { if (compId[j] === scanCompId) { ci2 = j; break; } }
        scanDC[ci2] = (tablesSel >> 4) & 0xF;
        scanAC[ci2] = tablesSel & 0xF;
      }
      i += 3; // Ss, Se, Ah/Al (baseline: 0, 63, 0)
      // `i` now points to compressed scan data — break out to decode
      break outer;
    } else {
      i = segEnd; // skip unknown segment
    }

    if (i < segEnd) i = segEnd;
  }

  if (imgW <= 0 || imgH <= 0 || numComp === 0) return null;
  if (imgW > 4096 || imgH > 4096) return null;

  // ── Determine max sampling factors ────────────────────────────────────
  var maxH = 1, maxV = 1;
  for (var c = 0; c < numComp; c++) {
    if (compH[c] > maxH) maxH = compH[c];
    if (compV[c] > maxV) maxV = compV[c];
  }

  // MCU size in pixels
  var mcuW = maxH * 8;
  var mcuH = maxV * 8;
  var mcuCols = Math.ceil(imgW / mcuW);
  var mcuRows = Math.ceil(imgH / mcuH);

  // Allocate per-component sample planes
  var planes: Uint8Array[] = [];
  var planePitch: number[] = [];
  var planeH: number[] = [];
  for (var c2 = 0; c2 < numComp; c2++) {
    var pw2 = mcuCols * compH[c2] * 8;
    var ph2 = mcuRows * compV[c2] * 8;
    planes.push(new Uint8Array(pw2 * ph2));
    planePitch.push(pw2);
    planeH.push(ph2);
  }

  // ── Decode scan ──────────────────────────────────────────────────────
  var br  = makeBR(raw, i);
  var prevDC: { val: number }[] = [];
  for (var c3 = 0; c3 < numComp; c3++) prevDC.push({ val: 0 });

  var blockBuf = new Uint8Array(64);
  var deqCoeff = new Int16Array(64);

  for (var mr = 0; mr < mcuRows; mr++) {
    for (var mc = 0; mc < mcuCols; mc++) {
      // Decode each component's blocks in this MCU
      for (var ci3 = 0; ci3 < numComp; ci3++) {
        var hf = compH[ci3];
        var vf = compV[ci3];
        var qt2 = qtables[compQt[ci3]];
        var dc  = htDC[scanDC[ci3]];
        var ac  = htAC[scanAC[ci3]];
        if (!dc || !ac || !qt2) continue;

        for (var bv = 0; bv < vf; bv++) {
          for (var bh = 0; bh < hf; bh++) {
            // Decode block into zigzag coefficients
            var rawCoeff = decodeBlock(br, dc, ac, prevDC[ci3]);
            // Dequantize
            for (var qi = 0; qi < 64; qi++) deqCoeff[qi] = rawCoeff[qi] * qt2[qi];
            // IDCT
            idct2d(deqCoeff, blockBuf);
            // Place into plane
            var plane  = planes[ci3];
            var pitch  = planePitch[ci3];
            var px0    = (mc * hf + bh) * 8;
            var py0    = (mr * vf + bv) * 8;
            for (var by = 0; by < 8; by++) {
              var dst  = (py0 + by) * pitch + px0;
              var src2 = by * 8;
              for (var bx = 0; bx < 8; bx++) {
                plane[dst + bx] = blockBuf[src2 + bx];
              }
            }
          }
        }
      }
    }
  }

  // ── Assemble final image ─────────────────────────────────────────────
  var out = new Uint32Array(imgW * imgH);

  if (numComp === 1) {
    // Greyscale
    var gPlane = planes[0];
    var gPitch = planePitch[0];
    for (var py3 = 0; py3 < imgH; py3++) {
      for (var px3 = 0; px3 < imgW; px3++) {
        var g = gPlane[py3 * gPitch + px3];
        out[py3 * imgW + px3] = 0xFF000000 | (g << 16) | (g << 8) | g;
      }
    }
  } else {
    // YCbCr (3 or 4 components — use first 3)
    var yPlane  = planes[0]; var yPitch  = planePitch[0];
    var cbPlane = planes[1]; var cbPitch = planePitch[1];
    var crPlane = planes[2]; var crPitch = planePitch[2];

    // Upsample ratios for Cb/Cr relative to Y
    var cbScaleH = maxH / compH[1];
    var cbScaleV = maxV / compV[1];
    var crScaleH = maxH / compH[2];
    var crScaleV = maxV / compV[2];

    for (var py4 = 0; py4 < imgH; py4++) {
      for (var px4 = 0; px4 < imgW; px4++) {
        var Y   = yPlane [py4 * yPitch  + px4];
        var Cb  = cbPlane[Math.floor(py4 / cbScaleV) * cbPitch + Math.floor(px4 / cbScaleH)];
        var Cr  = crPlane[Math.floor(py4 / crScaleV) * crPitch + Math.floor(px4 / crScaleH)];
        out[py4 * imgW + px4] = ycbcr2rgb(Y, Cb, Cr);
      }
    }
  }

  return { w: imgW, h: imgH, data: out };
}
