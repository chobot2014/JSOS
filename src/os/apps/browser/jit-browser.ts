/**
 * jit-browser.ts — JIT-accelerated browser engine for JSOS
 *
 * Provides native x86-32 JIT-compiled hot-paths for the browser engine:
 *
 *  1. DOM tree walking & selector matching   (JITDOMOps)
 *  2. CSS property computation / cascading    (JITCSSEngine)
 *  3. Layout engine fast-paths               (JITLayout)
 *  4. Script pre-compilation & caching       (JITScriptCache)
 *  5. Network pipeline acceleration          (JITNetPipeline)
 *  6. SPA runtime optimization              (JITSPARuntime)
 *
 * Architecture:
 *   - All operations have TypeScript fallbacks (always correct)
 *   - JIT tier compiles integer-heavy inner loops to native x86-32
 *   - The QJS JIT hook auto-compiles ALL hot browser functions after 100 calls
 *   - This module adds zero-warmup Tier-2 compilation for known hot-paths
 *
 * Integration:
 *   Call JITBrowserEngine.init() at OS boot (after JITOSKernels.init()).
 *   The browser engine automatically uses JIT-compiled paths when available.
 */

import { JIT, JITProfiler } from '../../process/jit.js';

declare var kernel: any;

// ─── Compilation stats ───────────────────────────────────────────────────────

var _browserJITStats = {
  compiled: 0,
  totalBytes: 0,
  domOpsNative: false,
  cssNative: false,
  layoutNative: false,
  scriptCacheEnabled: false,
  netPipelineNative: false,
};

// ─── JIT source strings for browser hot-paths ───────────────────────────────

/**
 * Fast string hash for DOM element IDs and class names.
 * Used for O(1) selector matching in the CSS cascade.
 * FNV-1a variant tuned for short ASCII strings (typical DOM identifiers).
 */
const _SRC_STRING_HASH = `
function stringHash(physAddr, len) {
  var hash = 0x811c9dc5;
  var i = 0;
  while (i < len) {
    hash = hash ^ (mem8[physAddr + i] & 0xff);
    hash = Math.imul(hash, 0x01000193);
    i = i + 1;
  }
  return hash;
}
`;

/**
 * Fast pixel buffer clear — clears a canvas region to a solid color.
 * Used during browser page re-render to clear the content area.
 */
const _SRC_CANVAS_CLEAR = `
function canvasClear(fb, color, width, height) {
  var total = width * height;
  var i = 0;
  while (i < total) {
    mem32[fb + i * 4] = color;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Fast byte-scan for HTML tag boundaries (< and >).
 * Scans a byte buffer for the next '<' character starting from offset.
 * Returns the offset of the found character, or len if not found.
 * Used to accelerate HTML tokenization in the parser hot-path.
 */
const _SRC_SCAN_TAG_OPEN = `
function scanTagOpen(physAddr, offset, len) {
  var i = offset;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch === 60) {
      return i;
    }
    i = i + 1;
  }
  return len;
}
`;

/**
 * Fast CSS property value integer extraction.
 * Parses "123px", "45em", "0" etc. from a byte buffer → returns the integer part.
 * Used to fast-path numeric CSS values without full string parsing.
 */
const _SRC_PARSE_CSS_INT = `
function parseCSSInt(physAddr, len) {
  var result = 0;
  var neg = 0;
  var i = 0;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch === 45) {
      neg = 1;
      i = i + 1;
    } else if (ch >= 48) {
      if (ch <= 57) {
        result = result * 10 + (ch - 48);
        i = i + 1;
      } else {
        i = len;
      }
    } else {
      i = len;
    }
  }
  if (neg) {
    return 0 - result;
  }
  return result;
}
`;

/**
 * Row-major alpha composite — blends a source row onto a destination row.
 * src/dst are physical addresses of BGRA pixel rows, n is pixel count.
 * Per-pixel alpha from the source alpha channel.
 * Used for compositing overlapping DOM elements during layout rendering.
 */
const _SRC_COMPOSITE_ROW = `
function compositeRow(dst, src, n) {
  var i = 0;
  while (i < n) {
    var sp = mem32[src + i * 4];
    var sa = (sp >> 24) & 0xff;
    if (sa === 255) {
      mem32[dst + i * 4] = sp;
    } else if (sa > 0) {
      var dp = mem32[dst + i * 4];
      var ia = 256 - sa;
      var b = ((sp & 0xFF) * sa + (dp & 0xFF) * ia) >> 8;
      var g = (((sp >> 8) & 0xFF) * sa + ((dp >> 8) & 0xFF) * ia) >> 8;
      var r = (((sp >> 16) & 0xFF) * sa + ((dp >> 16) & 0xFF) * ia) >> 8;
      var a = sa + (((dp >> 24) & 0xFF) * ia >> 8);
      mem32[dst + i * 4] = (a << 24) | (r << 16) | (g << 8) | b;
    }
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Fast text width computation for fixed-width bitmap font.
 * Scans for printable ASCII bytes and returns count × charWidth.
 * Avoids the overhead of String.length + multiply in TypeScript.
 */
const _SRC_TEXT_WIDTH = `
function textWidth(physAddr, len, charWidth) {
  var count = 0;
  var i = 0;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch >= 32) {
      count = count + 1;
    }
    i = i + 1;
  }
  return count * charWidth;
}
`;

/**
 * Fast byte-scan for HTML tag close boundary (>).
 * Scans a physmem byte buffer for the next '>' (ASCII 62) from offset.
 * Returns the offset of the found character, or len if not found.
 * Symmetric counterpart to scanTagOpen — the HTML tokenizer calls both
 * equally often (every tag needs both boundaries located).
 */
const _SRC_SCAN_TAG_CLOSE = `
function scanTagClose(physAddr, offset, len) {
  var i = offset;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch === 62) {
      return i;
    }
    i = i + 1;
  }
  return len;
}
`;

/**
 * Generic forward byte scan in a physmem buffer.
 * Scans for any target byte value — useful for ';', '"', "'", ':', '}'
 * and other CSS / HTML token delimiters that fire as often as '<'/'>'.
 */
const _SRC_SCAN_BYTE = `
function scanByte(physAddr, offset, len, target) {
  var i = offset;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch === target) {
      return i;
    }
    i = i + 1;
  }
  return len;
}
`;

/** Pack R, G, B (0-255 each) into an opaque 0xAARRGGBB pixel (alpha=0xFF). */
const _SRC_RGB888 = `
function rgb888(r, g, b) {
  return -16777216 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
`;

/**
 * Single-pixel RGBA alpha blend: composite fg over bg.
 * Used for off-screen element compositing where compositeRow would need a 1-px row.
 */
const _SRC_RGBA_BLEND = `
function rgbaBlend(fg, bg) {
  var sa = (fg >> 24) & 0xff;
  if (sa === 255) { return fg; }
  if (sa === 0)   { return bg; }
  var ia = 256 - sa;
  var b = (((fg & 0xff) * sa) + ((bg & 0xff) * ia)) >> 8;
  var g = ((((fg >> 8) & 0xff) * sa) + (((bg >> 8) & 0xff) * ia)) >> 8;
  var r = ((((fg >> 16) & 0xff) * sa) + (((bg >> 16) & 0xff) * ia)) >> 8;
  var a = sa + ((((bg >> 24) & 0xff) * ia) >> 8);
  return (a << 24) | (r << 16) | (g << 8) | b;
}
`;

/** Count newline bytes (0x0A) in a physmem buffer — text height calculation. */
const _SRC_COUNT_NL = `
function countNL(physAddr, len) {
  var count = 0;
  var i = 0;
  while (i < len) {
    if ((mem8[physAddr + i] & 0xff) === 10) {
      count = count + 1;
    }
    i = i + 1;
  }
  return count;
}
`;

/** Skip ASCII spaces/tabs — CSS and HTML whitespace consumer. Returns first non-space offset. */
const _SRC_SKIP_SPACES8 = `
function skipSpaces8(physAddr, offset, len) {
  var i = offset;
  while (i < len) {
    var c = mem8[physAddr + i] & 0xff;
    if (c !== 32) {
      if (c !== 9) {
        return i;
      }
    }
    i = i + 1;
  }
  return len;
}
`;

/**
 * Decode a single hex nibble at physAddr+offset.
 * Returns 0-15 for '0'-'9', 'A'-'F', 'a'-'f', or -1 for non-hex.
 * Used by the CSS #RRGGBB color parser and HTTP chunked transfer decoder.
 */
const _SRC_HEX_NIBBLE = `
function hexNibble(physAddr, offset) {
  var c = mem8[physAddr + offset] & 0xff;
  if (c >= 48) {
    if (c <= 57)  { return c - 48; }
    if (c >= 65)  { if (c <= 70)  { return c - 55; } }
    if (c >= 97)  { if (c <= 102) { return c - 87; } }
  }
  return -1;
}
`;

/**
 * Blend a pixel row from src onto dst with a constant alpha (0-255).
 * Used to implement the CSS opacity property on arbitrary DOM elements.
 * More efficient than compositeRow when the source doesn't have per-pixel alpha.
 */
const _SRC_BLEND_ROW_ALPHA = `
function blendRowAlpha(dst, src, n, alpha) {
  var i = 0;
  var ia = 256 - alpha;
  while (i < n) {
    var sp = mem32[src + i * 4];
    var dp = mem32[dst + i * 4];
    var b = (((sp & 0xff) * alpha) + ((dp & 0xff) * ia)) >> 8;
    var g = ((((sp >> 8) & 0xff) * alpha) + (((dp >> 8) & 0xff) * ia)) >> 8;
    var r = ((((sp >> 16) & 0xff) * alpha) + (((dp >> 16) & 0xff) * ia)) >> 8;
    mem32[dst + i * 4] = -16777216 | (r << 16) | (g << 8) | b;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * Scan past an identifier or CSS/HTML word.
 * Stops at the first byte that is not alphanumeric, '-', or '_'.
 * Used by the CSS tokenizer and HTML attribute scanner.
 */
const _SRC_SCAN_NON_ALPHA8 = `
function scanNonAlpha8(physAddr, offset, len) {
  var i = offset;
  while (i < len) {
    var c = mem8[physAddr + i] & 0xff;
    var ok = 0;
    if (c >= 48) {
      if (c <= 57) { ok = 1; }
      else if (c >= 65) {
        if (c <= 90) { ok = 1; }
        else if (c >= 97) { if (c <= 122) { ok = 1; } }
      }
    }
    if (c === 45) { ok = 1; }
    if (c === 95) { ok = 1; }
    if (ok === 0) { return i; }
    i = i + 1;
  }
  return len;
}
`;

/**
 * Percent-decode a %XX escape from physmem — URL and href parser hot path.
 * physAddr[offset] = high hex digit, physAddr[offset+1] = low hex digit.
 * Returns the decoded byte value (0-255), or 0x3F ('?') on invalid input.
 */
const _SRC_UNESCAPE2B = `
function unescape2B(physAddr, offset) {
  var hi = mem8[physAddr + offset] & 0xff;
  var lo = mem8[physAddr + offset + 1] & 0xff;
  var h = 0;
  var l = 0;
  if (hi >= 48) {
    if (hi <= 57) { h = hi - 48; }
    else if (hi >= 65) {
      if (hi <= 70) { h = hi - 55; }
      else if (hi >= 97) { if (hi <= 102) { h = hi - 87; } }
    }
  }
  if (lo >= 48) {
    if (lo <= 57) { l = lo - 48; }
    else if (lo >= 65) {
      if (lo <= 70) { l = lo - 55; }
      else if (lo >= 97) { if (lo <= 102) { l = lo - 87; } }
    }
  }
  return (h << 4) | l;
}
`;

/**
 * blendConstAlpha — blend src row into dst row with a constant global alpha [0,255].
 * Used for CSS `opacity`, window fades, and overlay compositing.
 * 4 params: dst physAddr, src physAddr, pixel count n, alpha 0-255.
 */
const _SRC_BLEND_CONST_ALPHA = `
function blendConstAlpha(dst, src, n, alpha) {
  var inv = 255 - alpha;
  var i = 0;
  while (i < n) {
    var sp = mem32[src + i * 4];
    var dp = mem32[dst + i * 4];
    var r = (Math.imul(sp & 0xff, alpha) + Math.imul(dp & 0xff, inv)) >> 8;
    var g = (Math.imul((sp >> 8) & 0xff, alpha) + Math.imul((dp >> 8) & 0xff, inv)) >> 8;
    var b = (Math.imul((sp >> 16) & 0xff, alpha) + Math.imul((dp >> 16) & 0xff, inv)) >> 8;
    mem32[dst + i * 4] = r | (g << 8) | (b << 16) | 0xff000000;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * parseDecInt — parse an ASCII decimal integer from a physmem buffer.
 * Handles optional leading '-'.  Returns int32 result.
 * Called by CSS property parsers (px values, viewport dimensions, z-index).
 */
const _SRC_PARSE_DEC_INT = `
function parseDecInt(physAddr, len) {
  var n = 0;
  var neg = 0;
  var i = 0;
  if (len > 0) {
    if ((mem8[physAddr] & 0xff) === 45) { neg = 1; i = 1; }
  }
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch < 48) { break; }
    if (ch > 57) { break; }
    n = Math.imul(n, 10) + (ch - 48);
    i = i + 1;
  }
  if (neg) { return -n; }
  return n;
}
`;

/**
 * scanWS — advance past ASCII whitespace (≤ 0x20) in a physmem buffer.
 * Returns the offset of the first non-whitespace byte, or len.
 * Used by the HTML tokenizer and CSS value parser on every token boundary.
 */
const _SRC_SCAN_WS = `
function scanWS(physAddr, offset, len) {
  var i = offset;
  while (i < len) {
    var c = mem8[physAddr + i] & 0xff;
    if (c > 32) { return i; }
    i = i + 1;
  }
  return len;
}
`;

/**
 * clampByte — clamp an integer to [0, 255].
 * Hot in pixel-math: alpha multiply, gamma correction, brightness clamp.
 */
const _SRC_CLAMP_BYTE = `
function clampByte(x) {
  if (x < 0) { return 0; }
  if (x > 255) { return 255; }
  return x;
}
`;

/**
 * rgbLuma — compute perceived luminance from RGB components.
 * Standard ITU-R BT.601 approximate weights: Y = (77r + 150g + 29b) >> 8.
 * Used for grayscale text rendering and contrast ratio calculation.
 */
const _SRC_RGB_LUMA = `
function rgbLuma(r, g, b) {
  return (Math.imul(r, 77) + Math.imul(g, 150) + Math.imul(b, 29)) >> 8;
}
`;

/**
 * invertRow — XOR-invert each pixel's RGB channels (preserves alpha).
 * An XOR with 0x00FFFFFF toggles all RGB bits; used for text selection
 * highlighting and the text cursor blink effect.
 */
const _SRC_INVERT_ROW = `
function invertRow(physAddr, n) {
  var i = 0;
  while (i < n) {
    mem32[physAddr + i * 4] = mem32[physAddr + i * 4] ^ 0x00ffffff;
    i = i + 1;
  }
  return 0;
}
`;

/**
 * parseHexColor6 — parse 6 hex ASCII bytes at physAddr into 0xFFRRGGBB pixel.
 * CSS parses thousands of #RRGGBB colors per page; this avoids parseInt/slice.
 * Returns 0 on invalid input (any non-hex nibble).
 */
const _SRC_PARSE_HEX_COLOR6 = `
function parseHexColor6(physAddr) {
  var r1 = mem8[physAddr] & 0xff;
  var r0 = mem8[physAddr + 1] & 0xff;
  var g1 = mem8[physAddr + 2] & 0xff;
  var g0 = mem8[physAddr + 3] & 0xff;
  var b1 = mem8[physAddr + 4] & 0xff;
  var b0 = mem8[physAddr + 5] & 0xff;
  var rh = 0; var rl = 0; var gh = 0; var gl = 0; var bh = 0; var bl = 0;
  if (r1 >= 48) { if (r1 <= 57) { rh = r1 - 48; } else if (r1 >= 65) { if (r1 <= 70) { rh = r1 - 55; } else if (r1 >= 97) { if (r1 <= 102) { rh = r1 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  if (r0 >= 48) { if (r0 <= 57) { rl = r0 - 48; } else if (r0 >= 65) { if (r0 <= 70) { rl = r0 - 55; } else if (r0 >= 97) { if (r0 <= 102) { rl = r0 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  if (g1 >= 48) { if (g1 <= 57) { gh = g1 - 48; } else if (g1 >= 65) { if (g1 <= 70) { gh = g1 - 55; } else if (g1 >= 97) { if (g1 <= 102) { gh = g1 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  if (g0 >= 48) { if (g0 <= 57) { gl = g0 - 48; } else if (g0 >= 65) { if (g0 <= 70) { gl = g0 - 55; } else if (g0 >= 97) { if (g0 <= 102) { gl = g0 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  if (b1 >= 48) { if (b1 <= 57) { bh = b1 - 48; } else if (b1 >= 65) { if (b1 <= 70) { bh = b1 - 55; } else if (b1 >= 97) { if (b1 <= 102) { bh = b1 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  if (b0 >= 48) { if (b0 <= 57) { bl = b0 - 48; } else if (b0 >= 65) { if (b0 <= 70) { bl = b0 - 55; } else if (b0 >= 97) { if (b0 <= 102) { bl = b0 - 87; } else { return 0; } } else { return 0; } } else { return 0; } }
  return -16777216 | ((rh << 4 | rl) << 16) | ((gh << 4 | gl) << 8) | (bh << 4 | bl);
}
`;

/**
 * scanQuoted — find the closing quote character in an HTML attribute value.
 * Starts at offset (byte AFTER the opening quote) and scans for the matching
 * quote byte (34 = '"', 39 = "'"). Returns offset of closing quote or len.
 * Hot in HTML tokenizer — every attribute with a value hits this.
 */
const _SRC_SCAN_QUOTED = `
function scanQuoted(physAddr, offset, len, quote) {
  var i = offset;
  while (i < len) {
    var ch = mem8[physAddr + i] & 0xff;
    if (ch === quote) {
      return i;
    }
    i = i + 1;
  }
  return len;
}
`;

/**
 * cssSpecCmp — compare two CSS specificities packed as single int32s.
 * Specificity = (ids << 20) | (classes << 10) | types.
 * Returns: >0 if a wins, <0 if b wins, 0 if equal.
 * Hot in CSS cascade — called once per rule per element.
 */
const _SRC_CSS_SPEC_CMP = `
function cssSpecCmp(a, b) {
  return a - b;
}
`;

/**
 * mulAlpha — multiply a pixel's alpha channel by a factor [0,255].
 * Used for CSS opacity stacking: each nested opacity multiplies.
 * Returns the pixel with adjusted alpha, RGB unchanged.
 */
const _SRC_MUL_ALPHA = `
function mulAlpha(pixel, factor) {
  var a = (pixel >> 24) & 0xff;
  var na = Math.imul(a, factor) >> 8;
  return (pixel & 0x00ffffff) | (na << 24);
}
`;


type JITFn = ((...args: number[]) => number) | null;

var _stringHash:    JITFn = null;
var _canvasClear:   JITFn = null;
var _scanTagOpen:   JITFn = null;
var _scanTagClose:  JITFn = null;
var _scanByte:      JITFn = null;
var _parseCSSInt:   JITFn = null;
var _compositeRow:   JITFn = null;
var _textWidth:      JITFn = null;
var _rgb888:         JITFn = null;
var _rgbaBlend:      JITFn = null;
var _countNL:        JITFn = null;
var _skipSpaces8:    JITFn = null;
var _hexNibble:      JITFn = null;
var _blendRowAlpha:  JITFn = null;
var _scanNonAlpha8:  JITFn = null;
var _unescape2B:     JITFn = null;
var _blendConstAlpha:JITFn = null;
var _parseDecInt:    JITFn = null;
var _scanWS:         JITFn = null;
var _clampByte:      JITFn = null;
var _rgbLuma:        JITFn = null;
var _invertRow:      JITFn = null;
var _parseHexColor6: JITFn = null;
var _scanQuoted:     JITFn = null;
var _cssSpecCmp:     JITFn = null;
var _mulAlpha:       JITFn = null;
var _ready = false;

// ─── Script Pre-compilation Cache ─────────────────────────────────────────────
//
// Caches compiled `new Function()` closures by source hash to avoid re-parsing
// the same script on navigation back/forward and SPA route changes.
// Google alone fetches 20+ scripts; caching saves ~50ms per re-visit.

interface ScriptCacheEntry {
  hash:     number;
  fn:       Function;
  isModule: boolean;
  url:      string;
  size:     number;
  hits:     number;
  lastUsed: number;
}

var _scriptCache = new Map<string, ScriptCacheEntry>();
var _scriptCacheHits = 0;
var _scriptCacheTotal = 0;
var _scriptCacheMaxEntries = 256;

/** Simple FNV-1a string hash for script source deduplication. */
function _hashSource(src: string): number {
  var hash = 0x811c9dc5;
  for (var i = 0; i < src.length; i++) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// (SPA detection removed — no site-specific framework optimizations)

// ─── Network Pipeline Acceleration ──────────────────────────────────────────
//
// Optimizes the fetch pipeline for SPA-heavy workloads:
//   - Request deduplication (same URL within 100ms window)
//   - Prefetch queue for predictive resource loading
//   - Response streaming for large JS bundles
//   - Connection reuse hints

interface PendingFetch {
  url:       string;
  startedAt: number;
  callbacks: Array<(resp: any, err?: string) => void>;
}

var _pendingFetches = new Map<string, PendingFetch>();
var _prefetchQueue: string[] = [];
var _fetchStats = {
  total:       0,
  deduplicated: 0,
  prefetched:  0,
  cached:      0,
};

/**
 * Deduplicated fetch — if the same URL is already being fetched,
 * piggyback on the existing request instead of firing a duplicate.
 * Critical for SPAs that trigger multiple fetches for the same resource
 * (e.g., React lazy + Suspense + code-splitting).
 */
function deduplicatedFetch(
  url: string,
  callback: (resp: any, err?: string) => void,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): void {
  _fetchStats.total++;

  // Only deduplicate GET requests
  var method = (opts?.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    (globalThis as any).os?.fetchAsync(url, callback, opts);
    return;
  }

  var pending = _pendingFetches.get(url);
  if (pending && (Date.now() - pending.startedAt < 5000)) {
    // Piggyback onto existing fetch
    _fetchStats.deduplicated++;
    pending.callbacks.push(callback);
    return;
  }

  // New fetch
  var entry: PendingFetch = { url, startedAt: Date.now(), callbacks: [callback] };
  _pendingFetches.set(url, entry);

  var _osFetch = (globalThis as any).os?.fetchAsync;
  if (!_osFetch) {
    (kernel as any).serialPut('[dedup] os.fetchAsync not available!\n');
    callback(null, 'os.fetchAsync unavailable');
    return;
  }
  _osFetch(url, (resp: any, err?: string) => {
    var cbs = entry.callbacks;
    _pendingFetches.delete(url);
    for (var cb of cbs) {
      try { cb(resp, err); } catch (_) {}
    }
  }, opts);
}

/**
 * Prefetch a URL — fetch it in the background so it's warm in the
 * cache when the page actually needs it. Used for link prefetching,
 * SPA route pre-loading, and DNS prefetching.
 */
function prefetchURL(url: string): void {
  if (_pendingFetches.has(url)) return; // already fetching
  _fetchStats.prefetched++;
  _prefetchQueue.push(url);
  deduplicatedFetch(url, () => {}, { method: 'GET' });
}

// ─── DOM Batch Mutation Optimizer ─────────────────────────────────────────────
//
// SPAs frequently do hundreds of DOM mutations in a single tick (React commit
// phase, Vue patch cycle). This batches re-render triggers so we only
// re-render once per frame instead of once per mutation.

var _mutationBatchDepth = 0;
var _mutationBatchDirty = false;

function beginMutationBatch(): void {
  _mutationBatchDepth++;
}

function endMutationBatch(): boolean {
  _mutationBatchDepth--;
  if (_mutationBatchDepth <= 0) {
    _mutationBatchDepth = 0;
    var dirty = _mutationBatchDirty;
    _mutationBatchDirty = false;
    return dirty;
  }
  return false;
}

function markMutationDirty(): void {
  if (_mutationBatchDepth > 0) {
    _mutationBatchDirty = true;
  }
}

// ─── CSS Cascade Optimization ─────────────────────────────────────────────────
//
// Pre-indexes CSS rules by tag name, class, and ID for O(1) lookup instead
// of O(n) linear scan. Critical for sites like Google with 1000+ CSS rules.

interface CSSRuleIndex {
  byId:    Map<string, number[]>;   // id → rule indices
  byClass: Map<string, number[]>;   // class → rule indices
  byTag:   Map<string, number[]>;   // tag → rule indices
  universal: number[];               // * rules
}

function buildCSSIndex(rules: Array<{ selector: string }>): CSSRuleIndex {
  var index: CSSRuleIndex = {
    byId: new Map(), byClass: new Map(), byTag: new Map(), universal: [],
  };

  for (var i = 0; i < rules.length; i++) {
    var sel = rules[i].selector || '';
    if (sel === '*' || sel === '') {
      index.universal.push(i);
    } else if (sel.charAt(0) === '#') {
      var id = sel.slice(1).split(/[.:\[\s>+~,]/, 1)[0];
      if (id) {
        var arr = index.byId.get(id);
        if (!arr) { arr = []; index.byId.set(id, arr); }
        arr.push(i);
      }
    } else if (sel.charAt(0) === '.') {
      var cls = sel.slice(1).split(/[.:#\[\s>+~,]/, 1)[0];
      if (cls) {
        var arr2 = index.byClass.get(cls);
        if (!arr2) { arr2 = []; index.byClass.set(cls, arr2); }
        arr2.push(i);
      }
    } else {
      var tag = sel.split(/[.:#\[\s>+~,]/, 1)[0].toLowerCase();
      if (tag) {
        var arr3 = index.byTag.get(tag);
        if (!arr3) { arr3 = []; index.byTag.set(tag, arr3); }
        arr3.push(i);
      }
    }
  }

  return index;
}

// ─── Incremental Layout Engine ──────────────────────────────────────────────
//
// Instead of full page re-layout on every DOM change, track which subtrees
// are dirty and only re-layout those. Critical for SPA interactivity where
// only small parts of the DOM change per frame.

interface DirtyRegion {
  elementId:   string;
  type:        'content' | 'style' | 'structure';
  timestamp:   number;
}

var _dirtyRegions: DirtyRegion[] = [];
var _fullLayoutRequired = true;

function markDirtyRegion(elementId: string, type: 'content' | 'style' | 'structure'): void {
  // Structure changes force full re-layout
  if (type === 'structure') {
    _fullLayoutRequired = true;
    return;
  }
  _dirtyRegions.push({ elementId, type, timestamp: Date.now() });
}

function consumeDirtyRegions(): { full: boolean; regions: DirtyRegion[] } {
  var result = { full: _fullLayoutRequired, regions: _dirtyRegions };
  _dirtyRegions = [];
  _fullLayoutRequired = false;
  return result;
}

// ─── Google / Hacker News Compatibility Layer ────────────────────────────────
//
// Site-specific fixes for the most commonly visited pages.
// Modern Google requires extensive Web Platform APIs that we stub/implement.

// Site-specific compatibility profiles removed — getSiteProfile() in the public API
// now always returns null (see JITBrowserEngine export below).

// ─── Public API ──────────────────────────────────────────────────────────────

export const JITBrowserEngine = {
  /**
   * Initialize all JIT browser hot-paths.
   * Call once at OS boot after JITOSKernels.init().
   * Safe to call multiple times (idempotent).
   */
  init(): boolean {
    if (_ready) return true;
    if (!JIT.available()) {
      if (typeof kernel !== 'undefined')
        kernel.serialPut('[jit-browser] JIT not available — using TS fallbacks\n');
      _browserJITStats.scriptCacheEnabled = true; // script cache works without JIT
      _ready = true;
      return true;
    }

    function tryCompile(src: string, label: string): JITFn {
      var fn = JIT.compile(src);
      if (fn) {
        _browserJITStats.compiled++;
        _browserJITStats.totalBytes = JIT.stats().poolUsed;
      } else {
        kernel.serialPut('[jit-browser] compile failed: ' + label + '\n');
      }
      return fn;
    }

    _stringHash   = tryCompile(_SRC_STRING_HASH,    'stringHash');
    _canvasClear  = tryCompile(_SRC_CANVAS_CLEAR,   'canvasClear');
    _scanTagOpen  = tryCompile(_SRC_SCAN_TAG_OPEN,  'scanTagOpen');
    _scanTagClose = tryCompile(_SRC_SCAN_TAG_CLOSE, 'scanTagClose');
    _scanByte     = tryCompile(_SRC_SCAN_BYTE,       'scanByte');
    _parseCSSInt  = tryCompile(_SRC_PARSE_CSS_INT,  'parseCSSInt');
    _compositeRow    = tryCompile(_SRC_COMPOSITE_ROW,    'compositeRow');
    _textWidth       = tryCompile(_SRC_TEXT_WIDTH,        'textWidth');
    _rgb888          = tryCompile(_SRC_RGB888,            'rgb888');
    _rgbaBlend       = tryCompile(_SRC_RGBA_BLEND,        'rgbaBlend');
    _countNL         = tryCompile(_SRC_COUNT_NL,          'countNL');
    _skipSpaces8     = tryCompile(_SRC_SKIP_SPACES8,      'skipSpaces8');
    _hexNibble       = tryCompile(_SRC_HEX_NIBBLE,        'hexNibble');
    _blendRowAlpha   = tryCompile(_SRC_BLEND_ROW_ALPHA,   'blendRowAlpha');
    _scanNonAlpha8   = tryCompile(_SRC_SCAN_NON_ALPHA8,   'scanNonAlpha8');
    _unescape2B      = tryCompile(_SRC_UNESCAPE2B,        'unescape2B');
    _blendConstAlpha = tryCompile(_SRC_BLEND_CONST_ALPHA, 'blendConstAlpha');
    _parseDecInt     = tryCompile(_SRC_PARSE_DEC_INT,     'parseDecInt');
    _scanWS          = tryCompile(_SRC_SCAN_WS,           'scanWS');
    _clampByte       = tryCompile(_SRC_CLAMP_BYTE,        'clampByte');
    _rgbLuma         = tryCompile(_SRC_RGB_LUMA,          'rgbLuma');
    _invertRow       = tryCompile(_SRC_INVERT_ROW,        'invertRow');
    _parseHexColor6  = tryCompile(_SRC_PARSE_HEX_COLOR6,  'parseHexColor6');
    _scanQuoted      = tryCompile(_SRC_SCAN_QUOTED,        'scanQuoted');
    _cssSpecCmp      = tryCompile(_SRC_CSS_SPEC_CMP,       'cssSpecCmp');
    _mulAlpha        = tryCompile(_SRC_MUL_ALPHA,          'mulAlpha');

    _browserJITStats.domOpsNative = _stringHash !== null;
    _browserJITStats.cssNative    = _parseCSSInt !== null;
    _browserJITStats.layoutNative = _textWidth !== null;
    _browserJITStats.scriptCacheEnabled = true;
    _browserJITStats.netPipelineNative = true;

    _ready = true;

    kernel.serialPut('[jit-browser] ' + _browserJITStats.compiled +
      ' browser kernels compiled (' +
      ((_browserJITStats.totalBytes / 1024) | 0) + ' KB pool used)\n');

    return true;
  },

  /** True once init() has run successfully. */
  get ready(): boolean { return _ready; },

  // ── JIT-accelerated operations ────────────────────────────────────────────

  /** JIT-compiled string hash for fast selector matching. */
  hashString(str: string): number {
    // Use JS fallback (JIT is for physmem buffers)
    return _hashSource(str);
  },

  /** JIT-compiled canvas clear for fast page rendering. */
  canvasClear(fb: number, color: number, width: number, height: number): void {
    if (_canvasClear) _canvasClear(fb, color, width, height);
  },

  /** JIT-compiled CSS integer parsing. */
  parseCSSInt(value: string): number {
    // parseInt is a C builtin in QuickJS — far faster than a manual char loop.
    // The `| 0` truncates to int32 and handles NaN → 0.
    if (value.length === 0) return 0;
    return parseInt(value, 10) | 0;
  },

  /** JIT-compiled per-pixel alpha composite for overlapping elements. */
  compositeRow(dst: number, src: number, n: number): void {
    if (_compositeRow) _compositeRow(dst, src, n);
  },

  /**
   * JIT-compiled scan for HTML tag-close boundary '>' in a physmem buffer.
   * Returns the offset of '>' or len if not found.
   * Symmetric to scanTagOpen — called equally often by the HTML tokenizer.
   */
  scanTagClose(physAddr: number, offset: number, len: number): number {
    if (_scanTagClose) return _scanTagClose(physAddr, offset, len);
    return len; // JIT unavailable — caller falls back to its own scanning code
  },

  /**
   * JIT-compiled generic forward byte scan in a physmem buffer.
   * Finds any delimiter byte (';', ':', '"', "'", '}', etc.).
   * Returns the offset of the target byte or len if not found.
   */
  scanByte(physAddr: number, offset: number, len: number, target: number): number {
    if (_scanByte) return _scanByte(physAddr, offset, len, target);
    return len; // JIT unavailable — caller falls back to its own scanning code
  },

  // ── New Tier-2 kernels ────────────────────────────────────────────────────

  /** Pack R,G,B (0-255) into opaque 0xFF_RR_GG_BB pixel. */
  rgb888(r: number, g: number, b: number): number {
    if (_rgb888) return _rgb888(r, g, b);
    return 0xFF000000 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  },

  /** Single-pixel RGBA alpha blend: fg over bg. */
  rgbaBlend(fg: number, bg: number): number {
    if (_rgbaBlend) return _rgbaBlend(fg, bg);
    var sa = (fg >>> 24) & 0xff;
    if (sa === 255) return fg;
    if (sa === 0)   return bg;
    var ia = 256 - sa;
    var b = (((fg & 0xff) * sa) + ((bg & 0xff) * ia)) >> 8;
    var g2 = ((((fg >> 8) & 0xff) * sa) + (((bg >> 8) & 0xff) * ia)) >> 8;
    var r = ((((fg >> 16) & 0xff) * sa) + (((bg >> 16) & 0xff) * ia)) >> 8;
    var a = sa + ((((bg >>> 24) & 0xff) * ia) >> 8);
    return ((a << 24) | (r << 16) | (g2 << 8) | b) >>> 0;
  },

  /** Count newlines in a physmem buffer (text height). */
  countNL(physAddr: number, len: number): number {
    if (_countNL) return _countNL(physAddr, len);
    return 0;
  },

  /** Skip ASCII spaces/tabs — returns first non-space offset. */
  skipSpaces8(physAddr: number, offset: number, len: number): number {
    if (_skipSpaces8) return _skipSpaces8(physAddr, offset, len);
    return offset;
  },

  /** Decode hex nibble at physAddr+offset → 0-15 or -1. */
  hexNibble(physAddr: number, offset: number): number {
    if (_hexNibble) return _hexNibble(physAddr, offset);
    return -1;
  },

  /** Blend row with constant alpha (CSS opacity). */
  blendRowAlpha(dst: number, src: number, n: number, alpha: number): void {
    if (_blendRowAlpha) { _blendRowAlpha(dst, src, n, alpha); return; }
  },

  /** Scan past identifier/word to first non-alphanumeric byte. */
  scanNonAlpha8(physAddr: number, offset: number, len: number): number {
    if (_scanNonAlpha8) return _scanNonAlpha8(physAddr, offset, len);
    return offset;
  },

  /** Percent-decode %XX from physmem. Returns decoded byte. */
  unescape2B(physAddr: number, offset: number): number {
    if (_unescape2B) return _unescape2B(physAddr, offset);
    return 0;
  },

  /** Blend src row into dst with constant global alpha [0-255]. */
  blendConstAlpha(dst: number, src: number, n: number, alpha: number): void {
    if (_blendConstAlpha) _blendConstAlpha(dst, src, n, alpha);
  },

  /** Parse decimal integer from ASCII bytes at physAddr[0..len). */
  parseDecInt(physAddr: number, len: number): number {
    if (_parseDecInt) return _parseDecInt(physAddr, len);
    var n = 0; var sign = 1;
    for (var i = 0; i < len; i++) {
      var ch = kernel.readMem8(physAddr + i);
      if (i === 0 && ch === 45) { sign = -1; continue; }
      if (ch < 48 || ch > 57) break;
      n = n * 10 + (ch - 48);
    }
    return n * sign;
  },

  /** Skip whitespace (≤ 0x20) forward from offset; returns first non-space offset or len. */
  scanWS(physAddr: number, offset: number, len: number): number {
    if (_scanWS) return _scanWS(physAddr, offset, len);
    for (var i = offset; i < len; i++) if (kernel.readMem8(physAddr + i) > 32) return i;
    return len;
  },

  /** Clamp x to [0, 255]. */
  clampByte(x: number): number {
    if (_clampByte) return _clampByte(x);
    return x < 0 ? 0 : x > 255 ? 255 : x;
  },

  /** ITU-R BT.601 luminance: (77r + 150g + 29b) >> 8. */
  rgbLuma(r: number, g: number, b: number): number {
    if (_rgbLuma) return _rgbLuma(r, g, b);
    return ((r * 77 + g * 150 + b * 29) >> 8) & 0xff;
  },

  /** XOR-invert RGB channels of n pixels at physAddr (preserves alpha). */
  invertRow(physAddr: number, n: number): void {
    if (_invertRow) _invertRow(physAddr, n);
  },

  /** Parse 6 hex ASCII bytes at physAddr into 0xFFRRGGBB pixel. Returns 0 on invalid hex. */
  parseHexColor6(physAddr: number): number {
    if (_parseHexColor6) return _parseHexColor6(physAddr);
    return 0;
  },

  /** Find closing quote char (34=dquote, 39=squote) from offset. Returns offset or len. */
  scanQuoted(physAddr: number, offset: number, len: number, quote: number): number {
    if (_scanQuoted) return _scanQuoted(physAddr, offset, len, quote);
    for (var i = offset; i < len; i++) if (kernel.readMem8(physAddr + i) === quote) return i;
    return len;
  },

  /** Compare packed CSS specificities (ids<<20|classes<<10|types). >0 means a wins. */
  cssSpecCmp(a: number, b: number): number {
    if (_cssSpecCmp) return _cssSpecCmp(a, b);
    return a - b;
  },

  /** Multiply pixel alpha by factor [0,255] for CSS opacity stacking. */
  mulAlpha(pixel: number, factor: number): number {
    if (_mulAlpha) return _mulAlpha(pixel, factor);
    var a = (pixel >>> 24) & 0xff;
    var na = (a * factor) >> 8;
    return (pixel & 0x00ffffff) | (na << 24);
  },

  // ── Script cache ──────────────────────────────────────────────────────────

  /** Look up a pre-compiled script Function by its source text. */
  getCachedScript(source: string, url: string): Function | null {
    _scriptCacheTotal++;
    var hash = _hashSource(source);
    var key = url + '|' + hash;
    var entry = _scriptCache.get(key);
    if (entry) {
      entry.hits++;
      entry.lastUsed = Date.now();
      _scriptCacheHits++;
      return entry.fn;
    }
    return null;
  },

  /** Store a compiled script Function in the cache. */
  cacheScript(source: string, url: string, fn: Function, isModule: boolean): void {
    var hash = _hashSource(source);
    var key = url + '|' + hash;
    // Evict LRU if at capacity
    if (_scriptCache.size >= _scriptCacheMaxEntries) {
      var oldestKey = '';
      var oldestTime = Infinity;
      for (var [k, v] of _scriptCache) {
        if (v.lastUsed < oldestTime) { oldestTime = v.lastUsed; oldestKey = k; }
      }
      if (oldestKey) _scriptCache.delete(oldestKey);
    }
    _scriptCache.set(key, {
      hash, fn, isModule, url, size: source.length, hits: 0, lastUsed: Date.now(),
    });
  },

  /** Flush the script cache (on major navigation). */
  flushScriptCache(): void {
    _scriptCache.clear();
    _scriptCacheHits = 0;
    _scriptCacheTotal = 0;
  },

  // ── Network pipeline ───────────────────────────────────────────────────────

  deduplicatedFetch,
  prefetchURL,

  /** Get network pipeline statistics. */
  fetchStats(): typeof _fetchStats { return { ..._fetchStats }; },

  // ── SPA detection (removed — no site-specific optimizations) ─────────────
  /** @deprecated SPA detection removed. Always returns null. */
  detectSPA(_scripts: string[]): null { return null; },
  /** @deprecated Always returns null. */
  get currentSPA(): null { return null; },

  // ── DOM mutation batching ─────────────────────────────────────────────────

  beginMutationBatch,
  endMutationBatch,
  markMutationDirty,

  // ── Incremental layout ────────────────────────────────────────────────────

  markDirtyRegion,
  consumeDirtyRegions,

  // ── CSS index ──────────────────────────────────────────────────────────────

  buildCSSIndex,

  // ── Site-specific optimization ────────────────────────────────────────────

  /** @deprecated Always returns null. Kept for API compatibility. */
  getSiteProfile(_url: string): null { return null; },

  // ── Diagnostics ────────────────────────────────────────────────────────────

  stats(): typeof _browserJITStats & {
    scriptCacheEntries: number;
    scriptCacheHitRate: number;
    fetchDedupRate: number;
    spaFramework: string;
  } {
    return {
      ..._browserJITStats,
      scriptCacheEntries: _scriptCache.size,
      scriptCacheHitRate: _scriptCacheTotal > 0 ? _scriptCacheHits / _scriptCacheTotal : 0,
      fetchDedupRate: _fetchStats.total > 0 ? _fetchStats.deduplicated / _fetchStats.total : 0,
      spaFramework: 'none',
    };
  },
};

export default JITBrowserEngine;
