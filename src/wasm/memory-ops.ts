/**
 * memory-ops.ts — AssemblyScript bulk memory operations
 *
 * Fast implementations of memcpy, memset, memcmp, and string operations.
 * These are hot in the kernel (FS block copies, network buffers, etc.).
 * All addresses are byte offsets into WASM linear memory.
 */

/**
 * memcopy — copy `len` bytes from `src` to `dst`.
 * Handles overlapping regions correctly (uses memmove semantics).
 */
export function memcopy(dst: i32, src: i32, len: i32): void {
  if (dst === src || len === 0) return;
  if (dst < src || dst >= src + len) {
    // Forward copy (no overlap or dst before src)
    let i: i32 = 0;
    // 4-byte aligned bulk
    while (i + 4 <= len && ((dst + i) & 3) === 0 && ((src + i) & 3) === 0) {
      store<u32>(dst + i, load<u32>(src + i)); i += 4;
    }
    while (i < len) { store<u8>(dst + i, load<u8>(src + i)); i++; }
  } else {
    // Backward copy (dst overlaps src from above)
    let i: i32 = len - 1;
    while (i >= 3 && ((dst + i - 3) & 3) === 0 && ((src + i - 3) & 3) === 0) {
      store<u32>(dst + i - 3, load<u32>(src + i - 3)); i -= 4;
    }
    while (i >= 0) { store<u8>(dst + i, load<u8>(src + i)); i--; }
  }
}

/**
 * memfill — fill `len` bytes at `dst` with `val`.
 */
export function memfill(dst: i32, val: u8, len: i32): void {
  let i: i32 = 0;
  const v32: u32 = (val as u32) | ((val as u32) << 8) | ((val as u32) << 16) | ((val as u32) << 24);
  while (i + 4 <= len && ((dst + i) & 3) === 0) {
    store<u32>(dst + i, v32); i += 4;
  }
  while (i < len) { store<u8>(dst + i, val); i++; }
}

/**
 * memequal — return 1 if `len` bytes at `a` and `b` are identical, else 0.
 */
export function memequal(a: i32, b: i32, len: i32): i32 {
  let i: i32 = 0;
  while (i + 4 <= len) {
    if (load<u32>(a + i) !== load<u32>(b + i)) return 0;
    i += 4;
  }
  while (i < len) {
    if (load<u8>(a + i) !== load<u8>(b + i)) return 0;
    i++;
  }
  return 1;
}

/**
 * memfind — find first occurrence of `needle` (single byte) in `len` bytes at `haystack`.
 * Returns byte offset from `haystack`, or -1 if not found.
 */
export function memfind(haystack: i32, len: i32, needle: u8): i32 {
  for (let i: i32 = 0; i < len; i++) {
    if (load<u8>(haystack + i) === needle) return i;
  }
  return -1;
}

/**
 * strlenZ — length of null-terminated byte string at `ptr`.
 * Returns byte count not including the null terminator.
 */
export function strlenZ(ptr: i32): i32 {
  let n: i32 = 0;
  while (load<u8>(ptr + n) !== 0) n++;
  return n;
}

/**
 * checksum16 — Internet checksum (one's complement sum) of `len` bytes at `ptr`.
 * Returns 16-bit checksum as i32.
 */
export function checksum16(ptr: i32, len: i32): i32 {
  let sum: u32 = 0;
  let i: i32 = 0;
  while (i + 2 <= len) {
    sum += (load<u8>(ptr + i) as u32 << 8) | (load<u8>(ptr + i + 1) as u32);
    i += 2;
  }
  if (i < len) sum += (load<u8>(ptr + i) as u32) << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum & 0xffff) as i32;
}

/**
 * xorBytes — XOR `len` bytes at `dst` with `key` byte, in place.
 * Useful for simple obfuscation, rolling checksums, etc.
 */
export function xorBytes(dst: i32, len: i32, key: u8): void {
  let i: i32 = 0;
  const k32: u32 = (key as u32) | ((key as u32) << 8) | ((key as u32) << 16) | ((key as u32) << 24);
  while (i + 4 <= len && ((dst + i) & 3) === 0) {
    store<u32>(dst + i, load<u32>(dst + i) ^ k32); i += 4;
  }
  while (i < len) { store<u8>(dst + i, load<u8>(dst + i) ^ key); i++; }
}

/**
 * countBytes — count occurrences of `val` in `len` bytes at `ptr`.
 */
export function countBytes(ptr: i32, len: i32, val: u8): i32 {
  let n: i32 = 0;
  for (let i: i32 = 0; i < len; i++) if (load<u8>(ptr + i) === val) n++;
  return n;
}

/**
 * copyWords32 — copy `count` u32 words from `src` to `dst` (both must be 4-byte aligned).
 */
export function copyWords32(dst: i32, src: i32, count: i32): void {
  for (let i: i32 = 0; i < count; i++) store<u32>(dst + i * 4, load<u32>(src + i * 4));
}

/**
 * zeroWords32 — zero `count` u32 words at `dst` (must be 4-byte aligned).
 */
export function zeroWords32(dst: i32, count: i32): void {
  for (let i: i32 = 0; i < count; i++) store<u32>(dst + i * 4, 0);
}
