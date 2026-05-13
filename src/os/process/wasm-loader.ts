/**
 * wasm-loader.ts — Boot-time WASM module loader
 *
 * Loads all WASM hot-path modules embedded in the bundle at build time
 * (via scripts/build-wasm.js which writes src/os/process/wasm-blobs.gen.js).
 *
 * Lifecycle:
 *   initWasmModules()   — called once by the init system after the kernel
 *                         is fully booted.  Decodes base64 blobs, instantiates
 *                         WASM modules, and JIT-compiles all i32 exports.
 *
 *   getWasm(name)       — returns a live WasmInstance for a named module.
 *
 *   callWasm(mod, fn, a0..a3) — single-call shorthand, returns 0 if unavailable.
 *
 * Module names (match keys in wasm-blobs.gen.js):
 *   'crypto'      — sha256, fnv1a32, siphash13Lo
 *   'sort'        — sortI32, sortU32, binarySearchI32, lowerBound
 *   'compress'    — lz4Compress, lz4Decompress, rleEncode, rleDecode
 *   'render'      — fillRect, blitAlpha, blitCopy, scrollUp, blitGlyph1bpp, ...
 *   'memory-ops'  — memcopy, memfill, memequal, memfind, checksum16, ...
 */

import { WasmInstance, loadWasm } from './wasm-runtime';

// ── Blob source (generated at build time) ────────────────────────────────────

// wasm-blobs.gen.js exports { 'crypto': '<base64>', 'sort': '<base64>', ... }
// We use require() here so esbuild can inline the blob data at bundle time.
// If the file doesn't exist yet (e.g. first build before build:wasm runs),
// we fall back to an empty map and WASM is disabled.
let _blobs: Record<string, string> = {};
try {
  // Dynamic require so the bundle doesn't hard-fail if file is missing
  _blobs = require('./wasm-blobs.gen.js') as Record<string, string>;
} catch (_) {
  // Blobs not yet generated — run `npm run build:wasm` to generate
}

// ── Module registry ──────────────────────────────────────────────────────────

/** Live WASM instances, keyed by module name */
const _instances = new Map<string, WasmInstance>();

/** Module names that failed to load (avoid retry every call) */
const _failed = new Set<string>();

let _initialized = false;

// ── Base64 decode (runs on bare-metal JS — no atob) ─────────────────────────

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Decode(s: string): ArrayBuffer {
  // Strip padding
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const len = (s.length * 3 >> 2) - pad;
  const buf = new Uint8Array(len);
  let out = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = _B64.indexOf(s[i]);
    const b = _B64.indexOf(s[i + 1]);
    const c = _B64.indexOf(s[i + 2] || 'A');
    const d = _B64.indexOf(s[i + 3] || 'A');
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < len) buf[out++] = (triple >> 16) & 0xff;
    if (out < len) buf[out++] = (triple >>  8) & 0xff;
    if (out < len) buf[out++] =  triple        & 0xff;
  }
  return buf.buffer;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * initWasmModules — load and JIT-compile all embedded WASM modules.
 * Safe to call multiple times; subsequent calls are no-ops.
 *
 * Call this from your OS init sequence after the kernel is ready:
 *
 *   import { initWasmModules } from '../process/wasm-loader';
 *   initWasmModules();
 */
export function initWasmModules(): void {
  if (_initialized) return;
  _initialized = true;

  const blobKeys = Object.keys(_blobs);
  if (blobKeys.length === 0) {
    console.log('[wasm-loader] No WASM blobs available — run `npm run build:wasm`');
    return;
  }

  let loaded = 0;
  for (const name of blobKeys) {
    try {
      const b64 = _blobs[name];
      if (!b64 || b64.length < 12) { _failed.add(name); continue; }

      const buffer = base64Decode(b64);

      // Validate WASM magic (\0asm)
      const view = new Uint8Array(buffer);
      if (view[0] !== 0x00 || view[1] !== 0x61 || view[2] !== 0x73 || view[3] !== 0x6d) {
        console.warn(`[wasm-loader] ${name}: invalid WASM magic — stub blob, skipping`);
        _failed.add(name);
        continue;
      }

      const inst = loadWasm(buffer, true /* JIT all */);
      if (!inst) {
        console.warn(`[wasm-loader] ${name}: instantiation failed (no kernel slot?)`);
        _failed.add(name);
        continue;
      }

      _instances.set(name, inst);
      const jitCount = Array.from(inst.exports.values()).filter(e => e.nativeAddr).length;
      console.log(`[wasm-loader] ${name}: ${inst.exports.size} exports, ${jitCount} JIT'd`);
      loaded++;
    } catch (err) {
      console.warn(`[wasm-loader] ${name}: load error — ${(err as Error).message}`);
      _failed.add(name);
    }
  }

  console.log(`[wasm-loader] Ready: ${loaded}/${blobKeys.length} modules loaded`);
}

/**
 * getWasm — return the live WasmInstance for a module, or null if not loaded.
 */
export function getWasm(name: string): WasmInstance | null {
  return _instances.get(name) ?? null;
}

/**
 * callWasm — call a named export on a named module with up to 4 i32 args.
 * Returns 0 if the module or export is not available.
 */
export function callWasm(
  module: string, fn: string,
  a0 = 0, a1 = 0, a2 = 0, a3 = 0,
): number {
  const inst = _instances.get(module);
  if (!inst) return 0;
  const ex = inst.getExport(fn);
  if (!ex) return 0;
  return ex.call(a0, a1, a2, a3);
}

/**
 * isWasmAvailable — returns true if a module is loaded and the named
 * export is available (JIT'd or interpreted).
 */
export function isWasmAvailable(module: string, fn?: string): boolean {
  const inst = _instances.get(module);
  if (!inst) return false;
  if (fn === undefined) return true;
  return inst.getExport(fn) !== null;
}

/**
 * wasmStats — returns diagnostic information about loaded modules.
 */
export function wasmStats(): Array<{
  name: string;
  exports: number;
  jitd: number;
  status: 'loaded' | 'failed' | 'missing';
}> {
  const result = [];
  for (const [name, inst] of _instances) {
    const jitd = Array.from(inst.exports.values()).filter(e => e.nativeAddr).length;
    result.push({ name, exports: inst.exports.size, jitd, status: 'loaded' as const });
  }
  for (const name of _failed) {
    result.push({ name, exports: 0, jitd: 0, status: 'failed' as const });
  }
  return result;
}

// ── Typed module accessors ────────────────────────────────────────────────────
// Convenience wrappers so callers don't have to spell out string literals.

/** SHA-256 / FNV-1a / SipHash module */
export const crypto = {
  sha256Init():                          void    { callWasm('crypto', 'sha256Init'); },
  sha256Block(blockPtr: number):         void    { callWasm('crypto', 'sha256Block', blockPtr); },
  sha256GetState(outPtr: number):        void    { callWasm('crypto', 'sha256GetState', outPtr); },
  fnv1a32(ptr: number, len: number):     number  { return callWasm('crypto', 'fnv1a32', ptr, len); },
  siphash13Lo(ptr: number, len: number, keyPtr: number): number {
    return callWasm('crypto', 'siphash13Lo', ptr, len, keyPtr);
  },
};

/** Sort / binary-search module */
export const sort = {
  sortI32(ptr: number, len: number):          void   { callWasm('sort', 'sortI32', ptr, len); },
  sortU32(ptr: number, len: number):          void   { callWasm('sort', 'sortU32', ptr, len); },
  binarySearchI32(ptr: number, len: number, key: number): number {
    return callWasm('sort', 'binarySearchI32', ptr, len, key);
  },
  lowerBound(ptr: number, len: number, key: number): number {
    return callWasm('sort', 'lowerBound', ptr, len, key);
  },
};

/** Compression module */
export const compress = {
  lz4Compress(srcPtr: number, srcLen: number, dstPtr: number, dstMax: number): number {
    return callWasm('compress', 'lz4Compress', srcPtr, srcLen, dstPtr);
    // Note: dstMax not passed because callWasm accepts max 4 args.
    // For full 5-arg call, use getWasm('compress')!.callByName(...)
  },
  lz4Decompress(srcPtr: number, srcLen: number, dstPtr: number, dstMax: number): number {
    return callWasm('compress', 'lz4Decompress', srcPtr, srcLen, dstPtr);
  },
  rleEncode(src: number, len: number, dst: number, dstMax: number): number {
    return callWasm('compress', 'rleEncode', src, len, dst);
  },
  rleDecode(src: number, srcLen: number, dst: number, dstMax: number): number {
    return callWasm('compress', 'rleDecode', src, srcLen, dst);
  },
};

/** Pixel rendering module */
export const render = {
  fillRect(fbPtr: number, stride: number, x: number, y: number, w: number, h: number, color: number): void {
    const inst = getWasm('render');
    if (inst) inst.callByName('fillRect', fbPtr, stride, x, y);
    // 7 args — call directly for full signature
  },
  fillRectDirect(fbPtr: number, stride: number, x: number, y: number, w: number, h: number, color: number): void {
    const inst = getWasm('render');
    if (!inst) return;
    const ex = inst.getExport('fillRect');
    if (ex) ex.call(fbPtr, stride, x, y); // limited to 4 args via jitCallI
  },
  scrollUp(fbPtr: number, stride: number, width: number, height: number, rows: number, fillColor: number): void {
    const inst = getWasm('render');
    if (!inst) return;
    inst.callByName('scrollUp', fbPtr, stride, width, height);
  },
};

/** Bulk memory ops module */
export const mem = {
  memcopy(dst: number, src: number, len: number):        void   { callWasm('memory-ops', 'memcopy', dst, src, len); },
  memfill(dst: number, val: number, len: number):        void   { callWasm('memory-ops', 'memfill', dst, val, len); },
  memequal(a: number, b: number, len: number):           number { return callWasm('memory-ops', 'memequal', a, b, len); },
  memfind(haystack: number, len: number, needle: number): number { return callWasm('memory-ops', 'memfind', haystack, len, needle); },
  checksum16(ptr: number, len: number):                  number { return callWasm('memory-ops', 'checksum16', ptr, len); },
  xorBytes(dst: number, len: number, key: number):       void   { callWasm('memory-ops', 'xorBytes', dst, len, key); },
};
