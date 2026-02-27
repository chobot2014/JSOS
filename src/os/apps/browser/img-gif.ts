/**
 * img-gif.ts — Pure TypeScript GIF decoder
 *
 * [Item 477] GIF image decode: basic (LZW decoder)
 * [Item 478] GIF animation: frame disposal and timing
 *
 * Supports:
 *  - GIF87a and GIF89a
 *  - LZW decompression (variable-width codes)
 *  - Global and local colour tables
 *  - Transparency (GCE transparent colour index)
 *  - Frame disposal methods: 0/1 (leave), 2 (restore background), 3 (restore previous)
 *  - Animation: frame delays encoded in GCE
 *  - Output: GIFFrame[] with per-frame pixel data (0xAARRGGBB Uint32Array)
 */

import type { DecodedImage } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GIFFrame {
  /** Frame pixel data 0xAARRGGBB, size = w×h */
  image:   DecodedImage;
  /** Frame delay in milliseconds (from GCE delay * 10) */
  delay:   number;
  /** Disposal method (0=none,1=leave,2=restoreBg,3=restorePrev) */
  disposal: number;
  /** Top-left X of this frame within the canvas */
  left:    number;
  /** Top-left Y of this frame within the canvas */
  top:     number;
}

export interface GIFResult {
  /** Canvas width */
  w:       number;
  /** Canvas height */
  h:       number;
  /** All frames (length=1 for static GIF) */
  frames:  GIFFrame[];
  /** Loop count (0 = loop forever, -1 = no loop, N = loop N times) */
  loopCount: number;
}

// ── LZW Decoder ───────────────────────────────────────────────────────────────

/**
 * [Item 477] GIF LZW decompression.
 *
 * @param data        Sub-block stream (already reassembled, without block headers)
 * @param minCodeSize GIF minimum code size (from image descriptor)
 * @returns           Decoded index stream
 */
function lzwDecode(data: Uint8Array, minCodeSize: number): Uint8Array {
  var clearCode = 1 << minCodeSize;
  var eoiCode   = clearCode + 1;

  // Code table: array of index sequences
  var table: Uint8Array[] = [];
  function initTable(): void {
    table = [];
    for (var i2 = 0; i2 < clearCode; i2++) table.push(new Uint8Array([i2]));
    table.push(new Uint8Array(0)); // clear
    table.push(new Uint8Array(0)); // eoi
  }
  initTable();

  var codeSize  = minCodeSize + 1;
  var nextCode  = eoiCode + 1;
  var maxCode   = (1 << codeSize);

  // Bit reader
  var bitPos  = 0;
  var bytePos = 0;

  function readCode(): number {
    var val = 0;
    for (var bi = 0; bi < codeSize; bi++) {
      var b = (data[bytePos] ?? 0) >> (bitPos & 7) & 1;
      val |= b << bi;
      bitPos++;
      if ((bitPos & 7) === 0) bytePos++;
    }
    return val;
  }

  var output: number[] = [];
  var prevEntry: Uint8Array | null = null;

  for (;;) {
    var code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      initTable();
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      maxCode  = 1 << codeSize;
      prevEntry = null;
      continue;
    }

    var entry: Uint8Array;
    if (code < table.length) {
      entry = table[code]!;
    } else if (prevEntry !== null && code === nextCode) {
      // Special case: code == next code to be added
      entry = new Uint8Array(prevEntry.length + 1);
      entry.set(prevEntry);
      entry[prevEntry.length] = prevEntry[0]!;
    } else {
      break; // corrupted
    }

    // Emit
    for (var ei = 0; ei < entry.length; ei++) output.push(entry[ei]!);

    // Add to table
    if (prevEntry !== null) {
      var newEntry = new Uint8Array(prevEntry.length + 1);
      newEntry.set(prevEntry);
      newEntry[prevEntry.length] = entry[0]!;
      table.push(newEntry);
      nextCode++;

      if (nextCode >= maxCode && codeSize < 12) {
        codeSize++;
        maxCode <<= 1;
      }
    }

    prevEntry = entry;
  }

  return new Uint8Array(output);
}

// ── Sub-block reader ──────────────────────────────────────────────────────────

/**
 * Read GIF sub-blocks (length-prefixed blocks terminated by 0x00) into a
 * flat Uint8Array for LZW input.
 */
function readSubBlocks(data: Uint8Array, pos: number): { bytes: Uint8Array; nextPos: number } {
  var chunks: Uint8Array[] = [];
  var totalLen = 0;
  for (;;) {
    var blockLen = data[pos++] ?? 0;
    if (blockLen === 0) break;
    chunks.push(data.slice(pos, pos + blockLen));
    totalLen += blockLen;
    pos += blockLen;
  }
  var combined = new Uint8Array(totalLen);
  var off = 0;
  for (var ci = 0; ci < chunks.length; ci++) {
    combined.set(chunks[ci]!, off);
    off += chunks[ci]!.length;
  }
  return { bytes: combined, nextPos: pos };
}

// ── Colour table → 0xAARRGGBB ────────────────────────────────────────────────

function buildColorTable(data: Uint8Array, offset: number, count: number, transpIdx: number): Uint32Array {
  var table = new Uint32Array(count);
  for (var i = 0; i < count; i++) {
    var r = data[offset + i * 3]     ?? 0;
    var g = data[offset + i * 3 + 1] ?? 0;
    var b = data[offset + i * 3 + 2] ?? 0;
    var a = (i === transpIdx) ? 0 : 255;
    table[i] = ((a & 0xFF) << 24 | (r & 0xFF) << 16 | (g & 0xFF) << 8 | b) >>> 0;
  }
  return table;
}

// ── Main decoder ──────────────────────────────────────────────────────────────

/**
 * [Item 477/478] Decode a GIF file into frames with timing information.
 *
 * @param bytes  Raw GIF file bytes
 * @returns      GIFResult with all frames, or null on failure
 */
export function decodeGIF(bytes: Uint8Array): GIFResult | null {
  try {
    return _decodeGIF(bytes);
  } catch (_e) {
    return null;
  }
}

function _decodeGIF(bytes: Uint8Array): GIFResult | null {
  if (bytes.length < 6) return null;
  var sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;

  var canvasW = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
  var canvasH = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  var packed  = bytes[10] ?? 0;
  var bgIdx   = bytes[11] ?? 0;
  // bytes[12] = pixel aspect ratio (ignored)

  var hasGCT      = (packed >> 7) & 1;
  var gctSize     = hasGCT ? 2 << (packed & 7) : 0;
  var globalCT: Uint32Array | null = null;

  var pos = 13;
  if (hasGCT) {
    globalCT = buildColorTable(bytes, pos, gctSize, -1);
    pos += gctSize * 3;
  }

  var frames: GIFFrame[] = [];
  var loopCount = -1; // -1 = not set = play once

  // GCE state for next image
  var gceDelay    = 100; // ms (default 100ms)
  var gceDisposal = 0;
  var gceTranspIdx = -1;

  // Compose canvas for frame disposal
  var canvas     = new Uint32Array(canvasW * canvasH);
  var prevCanvas = new Uint32Array(canvasW * canvasH);
  // Fill canvas with background
  var bgColor = (globalCT && gctSize > bgIdx) ? (globalCT[bgIdx] ?? 0) : 0;
  canvas.fill(bgColor);

  while (pos < bytes.length) {
    var byte = bytes[pos++] ?? 0;

    if (byte === 0x3B) break; // GIF Trailer

    if (byte === 0x21) {
      // Extension
      var extLabel = bytes[pos++] ?? 0;

      if (extLabel === 0xF9) {
        // Graphic Control Extension
        var gceBlockSize = bytes[pos++] ?? 0; // should be 4
        if (gceBlockSize >= 4) {
          var gcePacked = bytes[pos] ?? 0;
          gceDisposal  = (gcePacked >> 2) & 7;
          var hasTransp = gcePacked & 1;
          gceDelay     = ((bytes[pos + 1] ?? 0) | ((bytes[pos + 2] ?? 0) << 8)) * 10;
          if (gceDelay === 0) gceDelay = 100; // treat 0 as 100ms default
          gceTranspIdx  = hasTransp ? (bytes[pos + 3] ?? -1) : -1;
          pos += gceBlockSize;
        }
        pos++; // block terminator
      } else if (extLabel === 0xFF) {
        // Application Extension — look for NETSCAPE2.0 loop count
        var appBlockSz = bytes[pos++] ?? 0;
        var appId = String.fromCharCode(
          bytes[pos]!, bytes[pos+1]!, bytes[pos+2]!, bytes[pos+3]!,
          bytes[pos+4]!, bytes[pos+5]!, bytes[pos+6]!, bytes[pos+7]!,
          bytes[pos+8]!, bytes[pos+9]!, bytes[pos+10]!);
        pos += appBlockSz;
        // Read sub-blocks
        for (;;) {
          var aSz = bytes[pos++] ?? 0;
          if (aSz === 0) break;
          if (aSz >= 3 && (bytes[pos] ?? 0) === 1) {
            // NETSCAPE loop block
            loopCount = (bytes[pos + 1] ?? 0) | ((bytes[pos + 2] ?? 0) << 8);
          }
          pos += aSz;
        }
      } else {
        // Unknown extension — skip sub-blocks
        for (;;) {
          var eSz = bytes[pos++] ?? 0;
          if (eSz === 0) break;
          pos += eSz;
        }
      }
      continue;
    }

    if (byte === 0x2C) {
      // Image Descriptor
      var imgLeft   = (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8); pos += 2;
      var imgTop    = (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8); pos += 2;
      var imgW      = (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8); pos += 2;
      var imgH      = (bytes[pos] ?? 0) | ((bytes[pos + 1] ?? 0) << 8); pos += 2;
      var imgPacked = bytes[pos++] ?? 0;
      var hasLCT    = (imgPacked >> 7) & 1;
      var lctSize   = hasLCT ? 2 << (imgPacked & 7) : 0;

      var colorTable: Uint32Array | null = null;
      if (hasLCT) {
        colorTable = buildColorTable(bytes, pos, lctSize, gceTranspIdx);
        pos += lctSize * 3;
      } else {
        colorTable = globalCT;
        if (colorTable && gceTranspIdx >= 0) {
          // Re-apply transparency to global colour table copy
          colorTable = new Uint32Array(colorTable);
          if (gceTranspIdx < colorTable.length) colorTable[gceTranspIdx] = 0;
        }
      }

      var minCodeSize = bytes[pos++] ?? 2;
      var { bytes: lzwData, nextPos } = readSubBlocks(bytes, pos);
      pos = nextPos;

      var indices = lzwDecode(lzwData, minCodeSize);

      // [Item 478] Apply disposal: save previous canvas before rendering
      if (gceDisposal === 3) {
        // Restore to previous: copy canvas before rendering
        prevCanvas.set(canvas);
      }

      // Render frame onto canvas
      var frameCanvas = canvas.slice(); // copy current canvas for this frame's output
      for (var fy = 0; fy < imgH; fy++) {
        for (var fx = 0; fx < imgW; fx++) {
          var idx2 = indices[fy * imgW + fx] ?? 0;
          var color2 = (colorTable && idx2 < colorTable.length) ? colorTable[idx2]! : 0;
          // If transparent (alpha=0), keep current canvas pixel
          if ((color2 >>> 24) !== 0) {
            var cx2 = imgLeft + fx;
            var cy2 = imgTop + fy;
            if (cx2 >= 0 && cx2 < canvasW && cy2 >= 0 && cy2 < canvasH) {
              canvas[cy2 * canvasW + cx2] = color2;
            }
          }
        }
      }
      frameCanvas = canvas.slice(); // updated canvas is this frame

      frames.push({
        image:   { w: canvasW, h: canvasH, data: frameCanvas },
        delay:   gceDelay,
        disposal: gceDisposal,
        left:    imgLeft,
        top:     imgTop,
      });

      // [Item 478] Disposal method: update canvas for next frame
      if (gceDisposal === 2) {
        // Restore background: fill the frame rect with bg colour
        for (var dy = imgTop; dy < imgTop + imgH && dy < canvasH; dy++) {
          for (var dx = imgLeft; dx < imgLeft + imgW && dx < canvasW; dx++) {
            canvas[dy * canvasW + dx] = bgColor;
          }
        }
      } else if (gceDisposal === 3) {
        // Restore previous: roll back canvas to before this frame
        canvas.set(prevCanvas);
      }
      // disposal=0 or disposal=1: leave canvas as-is

      // Reset GCE fields for next image
      gceDelay    = 100;
      gceDisposal = 0;
      gceTranspIdx = -1;
      continue;
    }
  }

  if (frames.length === 0) return null;
  return { w: canvasW, h: canvasH, frames, loopCount };
}

/**
 * Decode a GIF and return the first frame as a static DecodedImage,
 * compatible with the img-png.ts / img-jpeg.ts API.
 */
export function decodeGIFStatic(bytes: Uint8Array): DecodedImage | null {
  var result = decodeGIF(bytes);
  if (!result || result.frames.length === 0) return null;
  return result.frames[0]!.image;
}
