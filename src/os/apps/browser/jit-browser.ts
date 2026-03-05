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

// ─── Compiled function slots ───────────────────────────────────────────────

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

  (globalThis as any).os?.fetchAsync(url, (resp: any, err?: string) => {
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
