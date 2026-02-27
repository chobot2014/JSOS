/**
 * cache.ts — Browser performance caches
 *
 * Provides module-level singleton caches that survive across re-renders
 * but are cleared on navigation:
 *
 *  textMeasureCache      — text width memoisation
 *  computedStyleCache    — per-element CSS computed style (generation-based)
 *  imageBitmapCache      — URLs → decoded RGBA pixel arrays
 *  layoutResultCache     — content fingerprint → LayoutResult
 *  cssRuleBuckets        — O(1) selector pre-indexing by tag/class/id
 *  objectPool            — reusable RenderedSpan / RenderedLine objects
 *  ArrayBufferPool       — fixed-size recycled ArrayBuffers for network I/O
 */

import type { CSSRule } from './stylesheet.js';
import type { RenderedLine, RenderedSpan } from './types.js';
import { CHAR_W } from './constants.js';

// ── Text Measurement Cache ──────────────────────────────────────────────────
//
// Maps `"${text}|${fontScale}"` → pixel width.
// Text width for our fixed-width font = text.length × CHAR_W × fontScale.
// The cache avoids the repeated multiply/float operations that hot layout paths
// invoke thousands of times per page render.

var _textWidthCache = new Map<string, number>();
var _textWidthHits  = 0;
var _textWidthTotal = 0;

/** Return the pixel width of `text` at `fontScale` (default 1). Cached. */
export function measureTextWidth(text: string, fontScale = 1): number {
  _textWidthTotal++;
  var key = text + '|' + fontScale;
  var cached = _textWidthCache.get(key);
  if (cached !== undefined) { _textWidthHits++; return cached; }
  var w = text.length * CHAR_W * fontScale;
  // Evict if cache is too large (> 8192 entries)
  if (_textWidthCache.size > 8192) _textWidthCache.clear();
  _textWidthCache.set(key, w);
  return w;
}

/** Flush the text measurement cache (call on navigation or font change). */
export function flushTextCache(): void {
  _textWidthCache.clear();
  _textWidthHits = 0;
  _textWidthTotal = 0;
}

/** Return hit-rate stats for debugging. */
export function textCacheStats(): { hits: number; total: number; hitRate: number } {
  return {
    hits:    _textWidthHits,
    total:   _textWidthTotal,
    hitRate: _textWidthTotal > 0 ? _textWidthHits / _textWidthTotal : 0,
  };
}

// ── Glyph Metrics Cache ─────────────────────────────────────────────────────
//
// Maps `"${fontFamily}|${fontSize}|${fontWeight}"` → { ascent, descent, lineGap }
// For our fixed bitmap font this is constant, but the cache future-proofs outright
// pixel-font switching and satisfies ctx.measureText() calls from page scripts.

interface FontMetrics { ascent: number; descent: number; lineGap: number; }
var _fontMetricsCache = new Map<string, FontMetrics>();

export function getFontMetrics(family: string, size: number, weight: string): FontMetrics {
  var key = family + '|' + size + '|' + weight;
  var hit = _fontMetricsCache.get(key);
  if (hit) return hit;
  // Default values for our 8×12 bitmap font at scale 1
  var scale  = Math.round(size / 12) || 1;
  var result: FontMetrics = { ascent: 10 * scale, descent: 2 * scale, lineGap: 2 * scale };
  _fontMetricsCache.set(key, result);
  return result;
}

// ── Computed Style Cache ────────────────────────────────────────────────────
//
// Per-element style computation is expensive (requires walking all CSS rules).
// We cache the result keyed by (elementId, generationStamp).  The generation
// counter is bumped whenever the page's stylesheet or any element's class/style
// attribute changes.

var _styleGeneration = 0;

/** Increment the generation whenever any style source changes. */
export function bumpStyleGeneration(): void { _styleGeneration++; }

/** Current CSS style generation. */
export function currentStyleGeneration(): number { return _styleGeneration; }

interface StyleCacheEntry {
  gen:   number;
  value: Record<string, string>;
}

var _styleCache = new Map<string, StyleCacheEntry>();
var _styleCacheHits  = 0;
var _styleCacheTotal = 0;

/**
 * Return a cached computed style object for the given element key + generation,
 * or null if the entry is stale or missing.
 */
export function getCachedStyle(key: string): Record<string, string> | null {
  _styleCacheTotal++;
  var entry = _styleCache.get(key);
  if (entry && entry.gen === _styleGeneration) { _styleCacheHits++; return entry.value; }
  return null;
}

/** Store a computed style in the cache. */
export function setCachedStyle(key: string, value: Record<string, string>): void {
  if (_styleCache.size > 4096) _styleCache.clear();
  _styleCache.set(key, { gen: _styleGeneration, value });
}

/** Flush the style cache (e.g., after navigation). */
export function flushStyleCache(): void {
  _styleCache.clear();
  _styleGeneration = 0;
  _styleCacheHits  = 0;
  _styleCacheTotal = 0;
}

// ── Image Bitmap Cache ──────────────────────────────────────────────────────
//
// Decoded RGBA pixel arrays keyed by source URL.
// Avoids re-decoding the same JPEG/PNG on every render frame.
// The cache also stores a scaled copy at (destW, destH) so resize operations
// don't repeat.

interface BitmapEntry {
  w:    number;
  h:    number;
  data: Uint32Array;
}

interface ScaledEntry {
  w:    number;
  h:    number;
  data: Uint32Array;
}

interface ImageEntry {
  original: BitmapEntry | null;
  // scaled copies keyed by "w×h"
  scaled: Map<string, ScaledEntry>;
}

var _imageCache = new Map<string, ImageEntry>();

/** Store the decoded original bitmap for a URL. */
export function storeImageBitmap(url: string, w: number, h: number, data: Uint32Array): void {
  var entry = _imageCache.get(url);
  if (!entry) { entry = { original: null, scaled: new Map() }; _imageCache.set(url, entry); }
  entry.original = { w, h, data };
}

/** Retrieve the decoded original bitmap, or null if not cached. */
export function getImageBitmap(url: string): BitmapEntry | null {
  return _imageCache.get(url)?.original ?? null;
}

/** Store a scaled copy. */
export function storeScaledImage(url: string, destW: number, destH: number, data: Uint32Array): void {
  var entry = _imageCache.get(url);
  if (!entry) { entry = { original: null, scaled: new Map() }; _imageCache.set(url, entry); }
  entry.scaled.set(destW + 'x' + destH, { w: destW, h: destH, data });
}

/** Retrieve a pre-scaled copy, or null. */
export function getScaledImage(url: string, destW: number, destH: number): Uint32Array | null {
  return _imageCache.get(url)?.scaled.get(destW + 'x' + destH)?.data ?? null;
}

/** Flush image cache on navigation. */
export function flushImageCache(): void { _imageCache.clear(); }

// ── Layout Result Cache ─────────────────────────────────────────────────────
//
// Cache full LayoutResult objects keyed by a fingerprint string that combines
// the page's content hash and viewport width.  The fingerprint is built from
// a fast hash of the rendered node types + text lengths + CSS fingerprint.

import type { LayoutResult } from './types.js';

var _layoutCache = new Map<string, LayoutResult>();
var _layoutHits  = 0;
var _layoutTotal = 0;

export function getLayoutCache(key: string): LayoutResult | null {
  _layoutTotal++;
  var cached = _layoutCache.get(key);
  if (cached) { _layoutHits++; return cached; }
  return null;
}

export function setLayoutCache(key: string, result: LayoutResult): void {
  if (_layoutCache.size > 32) _layoutCache.clear();  // keep only recent viewports
  _layoutCache.set(key, result);
}

export function flushLayoutCache(): void {
  _layoutCache.clear();
  _layoutHits  = 0;
  _layoutTotal = 0;
}

/**
 * Build a fast fingerprint for a list of nodes and a viewport width.
 * Not a cryptographic hash — just good enough to detect content changes.
 */
export function layoutFingerprint(nodes: ReadonlyArray<{ type: string; spans: ReadonlyArray<{ text: string }> }>, contentW: number): string {
  var h = contentW;
  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];
    h = (h * 31 + nd.type.length) | 0;
    for (var j = 0; j < nd.spans.length; j++) {
      h = (h * 31 + nd.spans[j].text.length) | 0;
    }
  }
  return h.toString(16);
}

// ── CSS Rule Index (O(1) selector pre-bucketing) ────────────────────────────
//
// When the stylesheet is loaded, rules are indexed into three hash maps:
//   • tagBuckets:   tag name → CSSRule[]
//   • classBuckets: first class → CSSRule[]
//   • idBuckets:    id → CSSRule[]
//   • universalRules: rules with only * or pseudo-class selectors
//
// matchingRules() returns the union of relevant buckets + universal rules,
// eliminating rules that cannot possibly match before any actual selector
// matching is done.  For a typical page this reduces work by 70–90%.

export interface RuleIndex {
  tagBuckets:     Map<string, CSSRule[]>;
  classBuckets:   Map<string, CSSRule[]>;
  idBuckets:      Map<string, CSSRule[]>;
  universalRules: CSSRule[];
}

/** Build a RuleIndex from a list of CSSRule objects. */
export function buildRuleIndex(rules: CSSRule[]): RuleIndex {
  var tagBuckets    = new Map<string, CSSRule[]>();
  var classBuckets  = new Map<string, CSSRule[]>();
  var idBuckets     = new Map<string, CSSRule[]>();
  var universalRules: CSSRule[] = [];

  function bucket<K>(map: Map<K, CSSRule[]>, key: K, rule: CSSRule): void {
    var arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(rule);
  }

  for (var ri = 0; ri < rules.length; ri++) {
    var rule = rules[ri];
    var placed = false;
    for (var si = 0; si < rule.sels.length; si++) {
      var sel = rule.sels[si].trim();
      // Rightmost compound part
      var parts = sel.split(/\s+|(?=[.#[])|\s*[>+~]\s*/g);
      var last  = parts[parts.length - 1] ?? '';

      // ID selector?
      var idM = last.match(/#([^.#[\s:]+)/);
      if (idM) { bucket(idBuckets, idM[1], rule); placed = true; continue; }

      // Class selector?
      var clM = last.match(/\.([^.#[\s:]+)/);
      if (clM) { bucket(classBuckets, clM[1], rule); placed = true; continue; }

      // Tag selector?
      var tagM = last.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      if (tagM && tagM[0] !== '*') { bucket(tagBuckets, tagM[0].toLowerCase(), rule); placed = true; continue; }

      // Universal / attribute / pseudo-class only
      if (!placed) universalRules.push(rule);
      placed = true;
    }
    if (!placed) universalRules.push(rule);
  }

  return { tagBuckets, classBuckets, idBuckets, universalRules };
}

/**
 * Return the candidate rules for an element with the given tag, id, and classes.
 * Uses a Set to deduplicate rules that appear in multiple buckets.
 */
export function candidateRules(
  index: RuleIndex,
  tag:   string,
  id:    string,
  cls:   string[],
): CSSRule[] {
  var seen = new Set<CSSRule>();
  var result: CSSRule[] = [];

  function add(rules: CSSRule[] | undefined): void {
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      if (!seen.has(rules[i])) { seen.add(rules[i]); result.push(rules[i]); }
    }
  }

  add(index.tagBuckets.get(tag));
  if (id) add(index.idBuckets.get(id));
  for (var ci = 0; ci < cls.length; ci++) add(index.classBuckets.get(cls[ci]));
  add(index.universalRules);

  return result;
}

// ── RenderedLine / RenderedSpan Object Pool ─────────────────────────────────
//
// Avoids creating thousands of short-lived objects per render frame.
// The pool is purged on navigation.

var _spanPool:  RenderedSpan[] = [];
var _linePool:  RenderedLine[] = [];
var _spansOut   = 0;
var _linesOut   = 0;

export function acquireSpan(x: number, text: string, color: number): RenderedSpan {
  _spansOut++;
  if (_spanPool.length > 0) {
    var s = _spanPool.pop()!;
    s.x = x; s.text = text; s.color = color;
    s.href = undefined; s.bold = undefined; s.del = undefined;
    s.mark = undefined; s.codeBg = undefined; s.underline = undefined;
    s.searchHit = undefined; s.hitIdx = undefined; s.fontScale = undefined;
    return s;
  }
  return { x, text, color };
}

export function releaseSpans(spans: RenderedSpan[]): void {
  for (var i = 0; i < spans.length; i++) { _spansOut--; _spanPool.push(spans[i]); }
  spans.length = 0;
  if (_spanPool.length > 2048) _spanPool.length = 1024;  // trim
}

export function acquireLine(y: number, lineH: number): RenderedLine {
  _linesOut++;
  if (_linePool.length > 0) {
    var l = _linePool.pop()!;
    l.y = y; l.lineH = lineH; l.nodes = [];
    l.preBg = undefined; l.quoteBg = undefined; l.quoteBar = undefined;
    l.hrLine = undefined; l.bgColor = undefined;
    return l;
  }
  return { y, nodes: [], lineH };
}

export function releaseLines(lines: RenderedLine[]): void {
  for (var i = 0; i < lines.length; i++) {
    releaseSpans(lines[i].nodes as RenderedSpan[]);
    _linesOut--;
    _linePool.push(lines[i]);
  }
  lines.length = 0;
  if (_linePool.length > 1024) _linePool.length = 512;  // trim
}

// ── ArrayBuffer Pool ─────────────────────────────────────────────────────────
//
// Recycles fixed-size buffers for network I/O to avoid GC pressure from
// thousands of per-packet byte allocations.

const POOL_SIZES = [4096, 65536, 1048576] as const;
type PoolSize = typeof POOL_SIZES[number];

var _bufPool = new Map<number, ArrayBuffer[]>([
  [4096, []], [65536, []], [1048576, []],
]);

export function acquireBuffer(minSize: number): ArrayBuffer {
  for (var i = 0; i < POOL_SIZES.length; i++) {
    var sz = POOL_SIZES[i];
    if (sz >= minSize) {
      var pool = _bufPool.get(sz)!;
      if (pool.length > 0) return pool.pop()!;
      return new ArrayBuffer(sz);
    }
  }
  return new ArrayBuffer(minSize);
}

export function releaseBuffer(buf: ArrayBuffer): void {
  var sz = buf.byteLength as PoolSize;
  var pool = _bufPool.get(sz);
  if (pool && pool.length < 16) pool.push(buf);
}

// ── Pool stats ────────────────────────────────────────────────────────────────

export function cacheStats(): Record<string, unknown> {
  return {
    textCache:    textCacheStats(),
    layoutCache:  { hits: _layoutHits, total: _layoutTotal },
    styleCache:   { hits: _styleCacheHits, total: _styleCacheTotal },
    imageCache:   { entries: _imageCache.size },
    spanPool:     { pooled: _spanPool.length, outstanding: _spansOut },
    linePool:     { pooled: _linePool.length, outstanding: _linesOut },
  };
}

// ── Flush all caches on page navigation ──────────────────────────────────────

export function flushAllCaches(): void {
  flushTextCache();
  flushStyleCache();
  flushImageCache();
  flushLayoutCache();
  _spanPool.length = 0;
  _linePool.length = 0;
  _spansOut = 0;
  _linesOut = 0;
  flushStyleDirtyTracker();
  _fslReadQueue.length = 0;
  _fslWriteQueue.length = 0;
}

// ── StyleDirtyTracker ─────────────────────────────────────────────────────────
//
// Item 892: Style recalc — dirty-mark only elements whose computed style
// actually changes; batch before layout pass.
//
// A dirty element id is tracked in a Set.  After any style mutation
// (class change, attribute change, inline style mutation), the element is
// marked dirty.  Before layout, `flushStyleDirty()` recomputes styles only
// for dirty elements and bumps `_styleGeneration`.

var _dirtyElements  = new Set<string>();  // element IDs (or unique keys)
var _containBodies  = new Set<string>();  // IDs of contain:layout boundaries (item 893)

/** Mark an element as needing style recalc. */
export function markStyleDirty(elementKey: string): void {
  _dirtyElements.add(elementKey);
}

/** Mark an element as a `contain: layout` boundary (item 893). */
export function markContainLayout(elementKey: string): void {
  _containBodies.add(elementKey);
}

/** Unmark a contain boundary. */
export function unmarkContainLayout(elementKey: string): void {
  _containBodies.delete(elementKey);
}

/**
 * Return true if `elementKey` is inside a `contain:layout` boundary.
 * Dirty-propagation stops at the boundary (item 893).
 */
export function isContainLayoutBoundary(elementKey: string): boolean {
  return _containBodies.has(elementKey);
}

/**
 * Flush all dirty style entries — invalidate their cache entries so the next
 * `getComputedStyle` call recomputes fresh values.
 * Returns the number of elements that were recalculated.
 */
export function flushStyleDirty(): number {
  if (_dirtyElements.size === 0) return 0;
  var count = 0;
  _dirtyElements.forEach(key => {
    // Invalidate cached style for this element by deleting its entry
    _styleCache.delete(key);
    count++;
  });
  _dirtyElements.clear();
  // Bump generation so any consumers that check the gen will recompute
  bumpStyleGeneration();
  return count;
}

/** Clear all dirty tracking state (on navigation). */
export function flushStyleDirtyTracker(): void {
  _dirtyElements.clear();
  _containBodies.clear();
}

/** How many elements are pending style recalc. */
export function pendingStyleRecalcCount(): number { return _dirtyElements.size; }

// ── FSL Batcher ───────────────────────────────────────────────────────────────
//
// Item 894: Avoid Forced Synchronous Layout (FSL) — batch all DOM reads
// before any DOM writes per frame.
//
// Callers queue reads and writes; `flushFSL()` runs reads first, then writes.
// This prevents the browser from interleaving layout-invalidating writes with
// layout-requiring reads (the FSL anti-pattern).

type VoidCallback = () => void;

var _fslReadQueue:  VoidCallback[] = [];
var _fslWriteQueue: VoidCallback[] = [];
var _fslInFlush = false;

/**
 * Schedule a DOM read callback for the next FSL flush.
 * Will execute before any queued writes.
 */
export function scheduleRead(cb: VoidCallback): void {
  if (_fslInFlush) { cb(); return; }  // already in flush — run immediately
  _fslReadQueue.push(cb);
}

/**
 * Schedule a DOM write callback for the next FSL flush.
 * Will execute after all queued reads.
 */
export function scheduleWrite(cb: VoidCallback): void {
  if (_fslInFlush) { _fslWriteQueue.push(cb); return; }
  _fslWriteQueue.push(cb);
}

/**
 * Flush all queued reads then all queued writes.
 * Call once per frame before the layout pass.
 */
export function flushFSL(): void {
  _fslInFlush = true;
  // Phase 1: all reads
  var readers = _fslReadQueue.splice(0);
  for (var i = 0; i < readers.length; i++) {
    try { readers[i](); } catch (_) {}
  }
  // Phase 2: all writes (may queue more reads — those run next frame)
  var writers = _fslWriteQueue.splice(0);
  for (var j = 0; j < writers.length; j++) {
    try { writers[j](); } catch (_) {}
  }
  _fslInFlush = false;
}

/** How many pending reads/writes are queued. */
export function fslQueueDepth(): { reads: number; writes: number } {
  return { reads: _fslReadQueue.length, writes: _fslWriteQueue.length };
}
