/**
 * JSOS Block Device Abstraction
 *
 * Provides a clean interface over the raw ATA kernel bindings,
 * adding a 64-sector LRU write-back cache to reduce physical I/O.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export const SECTOR_SIZE = 512;

/** Generic block device contract */
export interface BlockDevice {
  readonly sectorSize: number;
  /** Total number of sectors (derived from identity or config) */
  readonly sectorCount: number;
  isPresent(): boolean;
  /** Read `count` sectors (1-8) from `lba`. Returns null on error. */
  readSectors(lba: number, count: number): number[] | null;
  /** Write `data` (exactly count*512 bytes) to `lba`. */
  writeSectors(lba: number, count: number, data: number[]): boolean;
  /** Flush all dirty cache lines to hardware */
  flush(): boolean;
}

// ── 64-entry LRU write-back cache ─────────────────────────────────────────

const CACHE_SIZE   = 64;
const SECTORS_PER_LINE = 1;   // one cached sector per entry

interface CacheLine {
  lba:   number;
  data:  number[];    // 512 bytes
  dirty: boolean;
  uses:  number;      // access counter for LRU
}

class AtaBlockDevice implements BlockDevice {
  readonly sectorSize = SECTOR_SIZE;

  /** Total sectors: read from ATA IDENTIFY at runtime, fallback to 8 GiB. */
  get sectorCount(): number {
    var n = kernel.ataSectorCount ? kernel.ataSectorCount() : 0;
    return n > 0 ? n : 16777216; // fallback: 8 GiB / 512
  }

  private _cache: (CacheLine | null)[] = new Array<CacheLine | null>(CACHE_SIZE).fill(null);
  private _clock = 0;

  isPresent(): boolean {
    return kernel.ataPresent();
  }

  /** Read one sector (wraps multi-sector read for cache coherency) */
  private _rawRead(lba: number): number[] | null {
    var ab = (kernel.ataRead as any)(lba, 1) as ArrayBuffer | null;
    if (!ab) return null;
    // Unpack ArrayBuffer → number[] (C now returns ArrayBuffer for zero-copy read)
    var u8 = new Uint8Array(ab);
    var arr: number[] = new Array(u8.length);
    for (var i = 0; i < u8.length; i++) arr[i] = u8[i];
    return arr;
  }

  /** Write one sector */
  private _rawWrite(lba: number, data: number[]): boolean {
    return kernel.ataWrite(lba, 1, data);
  }

  // ── Cache helpers ──────────────────────────────────────────────────────

  private _findLine(lba: number): number {
    for (var i = 0; i < CACHE_SIZE; i++) {
      var line = this._cache[i];
      if (line !== null && line.lba === lba) return i;
    }
    return -1;
  }

  /** Find the LRU slot to evict */
  private _evictSlot(): number {
    var oldest = 0;
    var minUse = Infinity;
    for (var i = 0; i < CACHE_SIZE; i++) {
      var line = this._cache[i];
      if (line === null) return i;          // empty slot — use immediately
      if (line.uses < minUse) { minUse = line.uses; oldest = i; }
    }
    return oldest;
  }

  private _evict(slot: number): boolean {
    var line = this._cache[slot];
    if (line !== null && line.dirty) {
      if (!this._rawWrite(line.lba, line.data)) return false;
    }
    this._cache[slot] = null;
    return true;
  }

  private _loadSector(lba: number): number | null {
    var data = this._rawRead(lba);
    if (data === null) return null;
    var slot = this._evictSlot();
    if (!this._evict(slot)) return null;
    this._cache[slot] = { lba, data, dirty: false, uses: ++this._clock };
    return slot;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  readSectors(lba: number, count: number): number[] | null {
    if (count < 1 || count > 8) return null;
    var result: number[] = [];
    for (var s = 0; s < count; s++) {
      var curLba = lba + s;
      var idx = this._findLine(curLba);
      if (idx < 0) {
        idx = this._loadSector(curLba);
        if (idx === null) return null;
      }
      var line = this._cache[idx]!;
      line.uses = ++this._clock;
      for (var b = 0; b < SECTOR_SIZE; b++) result.push(line.data[b]);
    }
    return result;
  }

  writeSectors(lba: number, count: number, data: number[]): boolean {
    if (count < 1 || count > 8) return false;
    if (data.length < count * SECTOR_SIZE) return false;
    for (var s = 0; s < count; s++) {
      var curLba = lba + s;
      var idx = this._findLine(curLba);
      if (idx < 0) {
        var slot = this._evictSlot();
        if (!this._evict(slot)) return false;
        idx = slot;
        this._cache[idx] = {
          lba: curLba,
          data: new Array<number>(SECTOR_SIZE).fill(0),
          dirty: false,
          uses: 0,
        };
      }
      var line = this._cache[idx]!;
      var base = s * SECTOR_SIZE;
      for (var b = 0; b < SECTOR_SIZE; b++) line.data[b] = data[base + b];
      line.dirty = true;
      line.uses  = ++this._clock;
    }
    return true;
  }

  flush(): boolean {
    for (var i = 0; i < CACHE_SIZE; i++) {
      var line = this._cache[i];
      if (line !== null && line.dirty) {
        if (!this._rawWrite(line.lba, line.data)) return false;
        line.dirty = false;
      }
    }
    return true;
  }
}

export const ataBlockDevice: BlockDevice = new AtaBlockDevice();
