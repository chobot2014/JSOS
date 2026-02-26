/**
 * JSOS Buffer Cache — items 187-189
 *
 * Block-level LRU read/write cache shared by all block-device drivers.
 *
 * Usage:
 *   import { bufCache, writebackTimer } from './buffer-cache.js';
 *
 *   // Driver: register writeback handler
 *   bufCache.registerDevice('ata0', (dev, blk, data) => ataWrite(blk, data));
 *
 *   // Driver: read with caching
 *   let block = bufCache.get('ata0', lba);
 *   if (!block) {
 *     block = ataReadSector(lba);
 *     bufCache.put('ata0', lba, block);
 *   }
 *
 *   // OS timer tick ~100 Hz: item 189 writeback every 30 s
 *   writebackTimer.tick(kernel.getTicks());
 */

export const BLOCK_SIZE = 512; // standard sector size

// ── Cache Entry ───────────────────────────────────────────────────────────────

export interface CacheEntry {
  /** "<devId>:<blockNo>" e.g. "ata0:1024" */
  key:      string;
  /** Raw block bytes (one sector = 512 B by default). */
  data:     Uint8Array;
  /** True if data has been written but not flushed to block device. */
  dirty:    boolean;
  /** Monotonic tick used for LRU ordering. */
  lastUsed: number;
}

// ── Writeback callback ────────────────────────────────────────────────────────

/** Called by the cache when it needs to persist a dirty block to hardware. */
export type WritebackFn = (devId: string, blockNo: number, data: Uint8Array) => void;

// ── Buffer Cache ──────────────────────────────────────────────────────────────

/**
 * LRU block-level cache.  Default capacity: 256 × 512 B = 128 KB.
 */
export class BufferCache {
  private cache        = new Map<string, CacheEntry>();
  private maxEntries:  number;
  private tick         = 0;
  private writebackFns = new Map<string, WritebackFn>();

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  // ── Device registration ───────────────────────────────────────────────────

  /** Register a writeback handler for a device (e.g. 'ata0'). */
  registerDevice(devId: string, writeback: WritebackFn): void {
    this.writebackFns.set(devId, writeback);
  }

  /** Remove a device registration and invalidate all its cached blocks. */
  unregisterDevice(devId: string): void {
    this.writebackFns.delete(devId);
    this.invalidateDevice(devId);
  }

  // ── Read/write operations ────────────────────────────────────────────────

  /**
   * Look up a block in the cache.
   * Returns the data slice on hit, null on miss.
   */
  get(devId: string, blockNo: number): Uint8Array | null {
    var key   = devId + ':' + blockNo;
    var entry = this.cache.get(key);
    if (!entry) return null;
    entry.lastUsed = ++this.tick;
    return entry.data;
  }

  /**
   * Insert or update a block in the cache.
   * If the cache is full, the clean LRU entry is evicted first.
   * @param dirty  True when this is a write (block needs writeback).
   */
  put(devId: string, blockNo: number, data: Uint8Array, dirty = false): void {
    var key     = devId + ':' + blockNo;
    var existing = this.cache.get(key);
    if (existing) {
      existing.data     = data;
      existing.dirty    = existing.dirty || dirty;
      existing.lastUsed = ++this.tick;
      return;
    }
    if (this.cache.size >= this.maxEntries) {
      this._evictLRU();
    }
    this.cache.set(key, { key, data, dirty, lastUsed: ++this.tick });
  }

  /** Mark a cached block dirty without changing its contents. */
  markDirty(devId: string, blockNo: number): void {
    var entry = this.cache.get(devId + ':' + blockNo);
    if (entry) entry.dirty = true;
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /** Drop a single block from the cache (without writeback). */
  invalidate(devId: string, blockNo: number): void {
    this.cache.delete(devId + ':' + blockNo);
  }

  /** Drop all cached blocks for a device (e.g. on device removal). */
  invalidateDevice(devId: string): void {
    var prefix = devId + ':';
    var toDelete: string[] = [];
    for (var k of this.cache.keys()) {
      if (k.indexOf(prefix) === 0) toDelete.push(k);
    }
    for (var i = 0; i < toDelete.length; i++) this.cache.delete(toDelete[i]);
  }

  // ── Writeback (item 189) ──────────────────────────────────────────────────

  /**
   * Flush all dirty blocks.  If devId is supplied, only that device is flushed.
   * Called by WritebackTimer every 30 s, or explicitly on umount.
   */
  flush(devId?: string): void {
    for (var [key, entry] of this.cache) {
      if (!entry.dirty) continue;
      var colon = key.indexOf(':');
      var dev   = key.substring(0, colon);
      if (devId !== undefined && dev !== devId) continue;
      var blkNo = parseInt(key.substring(colon + 1));
      var wb    = this.writebackFns.get(dev);
      if (wb) {
        wb(dev, blkNo, entry.data);
        entry.dirty = false;
      }
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /** Number of currently cached blocks. */
  size(): number { return this.cache.size; }

  /** Number of dirty entries awaiting writeback. */
  dirtyCount(): number {
    var n = 0;
    for (var [, e] of this.cache) { if (e.dirty) n++; }
    return n;
  }

  /** Return all entries for diagnostics (e.g. from the REPL). */
  dump(): CacheEntry[] {
    return Array.from(this.cache.values());
  }

  // ── LRU eviction ─────────────────────────────────────────────────────────

  private _evictLRU(): void {
    var oldest: CacheEntry | null = null;
    // Prefer evicting a clean entry
    for (var [, entry] of this.cache) {
      if (entry.dirty) continue;
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
    }
    // Fall back to dirty entry (implicit flush)
    if (!oldest) {
      for (var [, dirty] of this.cache) {
        if (!oldest || dirty.lastUsed < (oldest as CacheEntry).lastUsed) {
          oldest = dirty;
        }
      }
    }
    if (!oldest) return; // empty cache
    if (oldest.dirty) {
      // Must flush before eviction
      var colon = oldest.key.indexOf(':');
      var dev2  = oldest.key.substring(0, colon);
      var blk2  = parseInt(oldest.key.substring(colon + 1));
      var wb2   = this.writebackFns.get(dev2);
      if (wb2) wb2(dev2, blk2, oldest.data);
    }
    this.cache.delete(oldest.key);
  }
}

// ── Writeback Timer (item 189) ────────────────────────────────────────────────

/**
 * Calls BufferCache.flush() on a periodic timer tick.
 * Hook into the OS timer at ~100 Hz: writebackTimer.tick(kernel.getTicks()).
 */
export class WritebackTimer {
  private lastFlush = 0;

  /**
   * @param cache           The shared buffer cache to flush.
   * @param intervalTicks   Flush interval in timer ticks.  Default 3 000 ticks
   *                        = 30 s at 100 Hz.
   */
  constructor(
    private cache: BufferCache,
    public  intervalTicks = 3000
  ) {}

  /**
   * Called from the OS timer ISR / scheduler tick.
   * Triggers a writeback pass when the interval has elapsed.
   */
  tick(nowTicks: number): void {
    if (nowTicks - this.lastFlush >= this.intervalTicks) {
      this.cache.flush();
      this.lastFlush = nowTicks;
    }
  }

  /** Force an immediate flush, resetting the timer. */
  forceFlush(): void {
    this.cache.flush();
    this.lastFlush = 0;
  }
}

// ── Page Cache (item 188) ─────────────────────────────────────────────────────

/** One page of file data, tied to an inode identity (path + offset). */
export interface PageCacheEntry {
  path:     string;   // resolved file path (inode identifier)
  offset:   number;   // byte offset of the start of this page (page-aligned)
  data:     string;   // page contents (text, for in-memory FS)
  dirty:    boolean;
  lastUsed: number;
}

/** Page size in bytes. */
export const PAGE_SIZE = 4096;

/**
 * File-level read cache (item 188).
 * Maps (path, pageOffset) → page content.
 * Used by readFile() to avoid re-reading the same data repeatedly.
 */
export class PageCache {
  private pages    = new Map<string, PageCacheEntry>();
  private maxPages: number;
  private tick     = 0;

  constructor(maxPages = 512) {
    this.maxPages = maxPages;
  }

  private _key(path: string, offset: number): string {
    return path + '@' + offset;
  }

  /** Read a page from cache.  Returns null on miss. */
  getPage(path: string, offset: number): string | null {
    var k = this._key(path, offset);
    var e = this.pages.get(k);
    if (!e) return null;
    e.lastUsed = ++this.tick;
    return e.data;
  }

  /** Store a page in cache. */
  putPage(path: string, offset: number, data: string, dirty = false): void {
    var k = this._key(path, offset);
    var existing = this.pages.get(k);
    if (existing) {
      existing.data     = data;
      existing.dirty    = existing.dirty || dirty;
      existing.lastUsed = ++this.tick;
      return;
    }
    if (this.pages.size >= this.maxPages) this._evictLRU();
    this.pages.set(k, { path, offset, data, dirty, lastUsed: ++this.tick });
  }

  /** Invalidate all cached pages for a file (e.g. after write). */
  invalidatePath(path: string): void {
    var toDelete: string[] = [];
    for (var [k, e] of this.pages) {
      if (e.path === path) toDelete.push(k);
    }
    for (var i = 0; i < toDelete.length; i++) this.pages.delete(toDelete[i]);
  }

  private _evictLRU(): void {
    var oldest: PageCacheEntry | null = null;
    for (var [, e] of this.pages) {
      if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
    }
    if (oldest) this.pages.delete(this._key(oldest.path, oldest.offset));
  }
}

// ── Singletons ────────────────────────────────────────────────────────────────

/** Shared buffer cache instance (block level). */
export const bufCache     = new BufferCache();
/** Shared page cache instance (file level). */
export const pageCache    = new PageCache();
/** Writeback timer — call tick() from the OS timer ISR. */
export const writebackTimer = new WritebackTimer(bufCache);
