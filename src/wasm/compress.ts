/**
 * compress.ts — AssemblyScript LZ4 block compression / decompression
 *
 * LZ4 block format (frame-less): used for in-memory compression of FS blocks,
 * log buffers, and network packet payloads.
 *
 * All addresses are byte offsets into WASM linear memory.
 */

const HASH_BITS: i32 = 14;
const HASH_SIZE: i32 = 1 << HASH_BITS;   // 16384 entries
const HASH_BASE: i32 = 0x4000;           // 16 KB table at 0x4000

const MIN_MATCH:  i32 = 4;
const MAX_OFFSET: i32 = 65535;
const SKIP_STEP:  i32 = 6;

@inline function hash4(v: u32): i32 {
  return (((v * 0x9e3779b9) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1)) as i32;
}

/**
 * lz4Compress — compress `srcLen` bytes at `srcPtr` into `dstPtr`.
 * `dstPtr` must have at least `srcLen + srcLen/255 + 16` bytes available.
 * Returns the compressed byte length, or 0 on failure (output too large).
 *
 * Both pointers are byte offsets in linear memory.
 */
export function lz4Compress(srcPtr: i32, srcLen: i32, dstPtr: i32, dstMax: i32): i32 {
  // Clear hash table
  for (let i: i32 = 0; i < HASH_SIZE; i++) store<i32>(HASH_BASE + i * 4, -1);

  let sp: i32 = srcPtr;         // current source position
  let dp: i32 = dstPtr;         // current dest position
  const srcEnd:  i32 = srcPtr + srcLen;
  const srcLimit: i32 = srcEnd - 12;  // last safe match start

  let anchor: i32 = sp;         // start of current literal run

  if (srcLen < MIN_MATCH) {
    // Too short to compress — emit as literals
    if (srcLen > dstMax) return 0;
    store<u8>(dp++, srcLen as u8);
    for (let i: i32 = 0; i < srcLen; i++) store<u8>(dp++, load<u8>(sp + i));
    return dp - dstPtr;
  }

  sp += MIN_MATCH;  // skip first match (not enough history)

  while (sp < srcLimit) {
    // Load 4 bytes and hash
    const v: u32 = load<u32>(sp);
    const h: i32 = hash4(v);
    const ref: i32 = load<i32>(HASH_BASE + h * 4);
    store<i32>(HASH_BASE + h * 4, sp);

    const offset: i32 = sp - ref;
    if (ref >= srcPtr && offset > 0 && offset <= MAX_OFFSET && load<u32>(ref) === v) {
      // Found a match — count length
      let matchLen: i32 = MIN_MATCH;
      while (sp + matchLen < srcEnd - 5 && load<u8>(ref + matchLen) === load<u8>(sp + matchLen))
        matchLen++;

      // Emit token + literals + offset + extra match len
      const litLen: i32 = sp - anchor;
      let token: u8 = 0;

      // Literal length nibble
      const litNib: i32 = litLen < 15 ? litLen : 15;
      const matchNib: i32 = (matchLen - MIN_MATCH) < 15 ? (matchLen - MIN_MATCH) : 15;
      token = ((litNib << 4) | matchNib) as u8;

      if (dp >= dstPtr + dstMax - litLen - 10) return 0;  // overflow guard
      store<u8>(dp++, token);

      // Extra literal length bytes
      if (litLen >= 15) {
        let rem: i32 = litLen - 15;
        while (rem >= 255) { store<u8>(dp++, 255); rem -= 255; }
        store<u8>(dp++, rem as u8);
      }
      // Copy literals
      for (let i: i32 = 0; i < litLen; i++) store<u8>(dp++, load<u8>(anchor + i));

      // Offset (little-endian u16)
      store<u8>(dp++, (offset & 0xff) as u8);
      store<u8>(dp++, ((offset >> 8) & 0xff) as u8);

      // Extra match length bytes
      if (matchLen - MIN_MATCH >= 15) {
        let rem: i32 = matchLen - MIN_MATCH - 15;
        while (rem >= 255) { store<u8>(dp++, 255); rem -= 255; }
        store<u8>(dp++, rem as u8);
      }

      sp += matchLen;
      anchor = sp;
    } else {
      sp += SKIP_STEP;
    }
  }

  // Emit final literals
  const finalLit: i32 = srcEnd - anchor;
  if (dp + finalLit + (finalLit >> 8) + 10 > dstPtr + dstMax) return 0;
  const fNib: i32 = finalLit < 15 ? finalLit : 15;
  store<u8>(dp++, (fNib << 4) as u8);
  if (finalLit >= 15) {
    let rem: i32 = finalLit - 15;
    while (rem >= 255) { store<u8>(dp++, 255); rem -= 255; }
    store<u8>(dp++, rem as u8);
  }
  for (let i: i32 = 0; i < finalLit; i++) store<u8>(dp++, load<u8>(anchor + i));

  return dp - dstPtr;
}

/**
 * lz4Decompress — decompress `srcLen` bytes at `srcPtr` into `dstPtr`.
 * `dstMax` is the maximum number of bytes to write.
 * Returns decompressed byte count, or -1 on malformed input.
 */
export function lz4Decompress(srcPtr: i32, srcLen: i32, dstPtr: i32, dstMax: i32): i32 {
  let sp: i32 = srcPtr;
  let dp: i32 = dstPtr;
  const srcEnd: i32 = srcPtr + srcLen;
  const dstEnd: i32 = dstPtr + dstMax;

  while (sp < srcEnd) {
    const token: u8 = load<u8>(sp++);

    // Literal length
    let litLen: i32 = (token >> 4) as i32;
    if (litLen === 15) {
      let b: u8;
      do { b = load<u8>(sp++); litLen += b as i32; } while (b === 255 && sp < srcEnd);
    }

    // Copy literals
    if (dp + litLen > dstEnd) return -1;
    for (let i: i32 = 0; i < litLen; i++) store<u8>(dp++, load<u8>(sp++));

    if (sp >= srcEnd) break;  // last sequence has no match

    // Offset
    const off: i32 = (load<u8>(sp) as i32) | ((load<u8>(sp + 1) as i32) << 8);
    sp += 2;
    if (off === 0) return -1;

    // Match length
    let matchLen: i32 = (token & 0xf) as i32 + MIN_MATCH;
    if (matchLen === 15 + MIN_MATCH) {
      let b: u8;
      do { b = load<u8>(sp++); matchLen += b as i32; } while (b === 255 && sp < srcEnd);
    }

    // Copy match (may overlap)
    const matchSrc: i32 = dp - off;
    if (matchSrc < dstPtr || dp + matchLen > dstEnd) return -1;
    for (let i: i32 = 0; i < matchLen; i++) store<u8>(dp++, load<u8>(matchSrc + i));
  }

  return dp - dstPtr;
}

/**
 * rleEncode — simple run-length encode `len` bytes at `src` into `dst`.
 * Format: [count:u8][byte:u8] pairs.  Max run length = 255.
 * Returns encoded byte count.
 */
export function rleEncode(src: i32, len: i32, dst: i32, dstMax: i32): i32 {
  let sp: i32 = 0; let dp: i32 = 0;
  while (sp < len) {
    const b: u8 = load<u8>(src + sp);
    let run: i32 = 1;
    while (sp + run < len && run < 255 && load<u8>(src + sp + run) === b) run++;
    if (dp + 2 > dstMax) return dp;  // truncate
    store<u8>(dst + dp++, run as u8);
    store<u8>(dst + dp++, b);
    sp += run;
  }
  return dp;
}

/**
 * rleDecode — decode `srcLen` RLE bytes at `src` into `dst`.
 * Returns decoded byte count.
 */
export function rleDecode(src: i32, srcLen: i32, dst: i32, dstMax: i32): i32 {
  let sp: i32 = 0; let dp: i32 = 0;
  while (sp + 1 < srcLen) {
    const run: i32 = load<u8>(src + sp++) as i32;
    const b: u8 = load<u8>(src + sp++);
    for (let i: i32 = 0; i < run && dp < dstMax; i++) store<u8>(dst + dp++, b);
  }
  return dp;
}
