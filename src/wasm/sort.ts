/**
 * sort.ts — AssemblyScript hot-path sorting and searching
 *
 * All functions operate on i32 arrays in linear memory.
 * `ptr` = byte offset of the array, `len` = element count.
 */

// ── Insertion sort (fast for small N, used as radix base case) ──────────────

function insertionSort(ptr: i32, lo: i32, hi: i32): void {
  for (let i: i32 = lo + 1; i <= hi; i++) {
    const key: i32 = load<i32>(ptr + i * 4);
    let j: i32 = i - 1;
    while (j >= lo && load<i32>(ptr + j * 4) > key) {
      store<i32>(ptr + (j + 1) * 4, load<i32>(ptr + j * 4));
      j--;
    }
    store<i32>(ptr + (j + 1) * 4, key);
  }
}

// ── Quicksort (in-place, 3-way partition) ───────────────────────────────────

function median3(ptr: i32, a: i32, b: i32, c: i32): i32 {
  const va: i32 = load<i32>(ptr + a * 4);
  const vb: i32 = load<i32>(ptr + b * 4);
  const vc: i32 = load<i32>(ptr + c * 4);
  if (va < vb) {
    if (vb < vc) return b;
    if (va < vc) return c;
    return a;
  } else {
    if (va < vc) return a;
    if (vb < vc) return c;
    return b;
  }
}

function qsort3(ptr: i32, lo: i32, hi: i32): void {
  while (hi - lo > 12) {
    const mid: i32 = lo + ((hi - lo) >> 1);
    const p: i32 = median3(ptr, lo, mid, hi);
    const pivot: i32 = load<i32>(ptr + p * 4);
    // swap p to lo
    let tmp: i32 = load<i32>(ptr + lo * 4);
    store<i32>(ptr + lo * 4, load<i32>(ptr + p * 4));
    store<i32>(ptr + p * 4, tmp);

    let lt: i32 = lo; let gt: i32 = hi; let i: i32 = lo + 1;
    while (i <= gt) {
      const v: i32 = load<i32>(ptr + i * 4);
      if (v < pivot) {
        tmp = load<i32>(ptr + lt * 4);
        store<i32>(ptr + lt * 4, load<i32>(ptr + i * 4));
        store<i32>(ptr + i * 4, tmp);
        lt++; i++;
      } else if (v > pivot) {
        tmp = load<i32>(ptr + gt * 4);
        store<i32>(ptr + gt * 4, load<i32>(ptr + i * 4));
        store<i32>(ptr + i * 4, tmp);
        gt--;
      } else {
        i++;
      }
    }
    // Recurse on smaller partition, loop on larger
    if (lt - lo < hi - gt) {
      qsort3(ptr, lo, lt - 1);
      lo = gt + 1;
    } else {
      qsort3(ptr, gt + 1, hi);
      hi = lt - 1;
    }
  }
  insertionSort(ptr, lo, hi);
}

/**
 * sortI32 — in-place sort of `len` i32 values at `ptr`.
 */
export function sortI32(ptr: i32, len: i32): void {
  if (len < 2) return;
  qsort3(ptr, 0, len - 1);
}

/**
 * sortU32 — in-place sort of `len` u32 values at `ptr` (unsigned comparison).
 */
export function sortU32(ptr: i32, len: i32): void {
  if (len < 2) return;
  // Use radix sort (8-bit LSD, 4 passes) for linear-time u32 sort
  const HIST_BASE: i32 = 0x2000;  // 4 * 256 * 4 = 4 KB histogram
  const TMP_BASE:  i32 = 0x3000;  // tmp buffer (len * 4 bytes, max 16 KB)

  // Clear histograms
  for (let i: i32 = 0; i < 1024; i++) store<u32>(HIST_BASE + i * 4, 0);

  // Build histograms for all 4 bytes
  for (let i: i32 = 0; i < len; i++) {
    const v: u32 = load<u32>(ptr + i * 4);
    store<u32>(HIST_BASE +          ((v        & 0xff) * 4), load<u32>(HIST_BASE +          ((v        & 0xff) * 4)) + 1);
    store<u32>(HIST_BASE + 1024 + (((v >>  8) & 0xff) * 4), load<u32>(HIST_BASE + 1024 + (((v >>  8) & 0xff) * 4)) + 1);
    store<u32>(HIST_BASE + 2048 + (((v >> 16) & 0xff) * 4), load<u32>(HIST_BASE + 2048 + (((v >> 16) & 0xff) * 4)) + 1);
    store<u32>(HIST_BASE + 3072 + (((v >> 24) & 0xff) * 4), load<u32>(HIST_BASE + 3072 + (((v >> 24) & 0xff) * 4)) + 1);
  }

  // Prefix-sum each histogram
  for (let pass: i32 = 0; pass < 4; pass++) {
    const hBase: i32 = HIST_BASE + pass * 1024;
    let sum: u32 = 0;
    for (let b: i32 = 0; b < 256; b++) {
      const cnt: u32 = load<u32>(hBase + b * 4);
      store<u32>(hBase + b * 4, sum);
      sum += cnt;
    }
  }

  // 4 scatter passes
  for (let pass: i32 = 0; pass < 4; pass++) {
    const hBase: i32 = HIST_BASE + pass * 1024;
    const shift: i32 = pass * 8;
    const src: i32 = (pass & 1) === 0 ? ptr : TMP_BASE;
    const dst: i32 = (pass & 1) === 0 ? TMP_BASE : ptr;
    for (let i: i32 = 0; i < len; i++) {
      const v: u32 = load<u32>(src + i * 4);
      const b: i32 = ((v >>> (shift as u32)) & 0xff) as i32;
      const pos: u32 = load<u32>(hBase + b * 4);
      store<u32>(dst + pos as i32 * 4, v);
      store<u32>(hBase + b * 4, pos + 1);
    }
  }
  // After 4 passes, result is back in ptr (even number of passes)
}

/**
 * binarySearchI32 — find `key` in sorted i32 array at `ptr` (len elements).
 * Returns index (0-based) or -1 if not found.
 */
export function binarySearchI32(ptr: i32, len: i32, key: i32): i32 {
  let lo: i32 = 0; let hi: i32 = len - 1;
  while (lo <= hi) {
    const mid: i32 = lo + ((hi - lo) >> 1);
    const v: i32 = load<i32>(ptr + mid * 4);
    if (v === key) return mid;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * lowerBound — first index where arr[i] >= key, or len if all < key.
 */
export function lowerBound(ptr: i32, len: i32, key: i32): i32 {
  let lo: i32 = 0; let hi: i32 = len;
  while (lo < hi) {
    const mid: i32 = lo + ((hi - lo) >> 1);
    if (load<i32>(ptr + mid * 4) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * memcmpI32 — compare two i32 arrays of length `len`.
 * Returns 0 if equal, <0 / >0 based on first differing element.
 */
export function memcmpI32(a: i32, b: i32, len: i32): i32 {
  for (let i: i32 = 0; i < len; i++) {
    const va: i32 = load<i32>(a + i * 4);
    const vb: i32 = load<i32>(b + i * 4);
    if (va !== vb) return va - vb;
  }
  return 0;
}
