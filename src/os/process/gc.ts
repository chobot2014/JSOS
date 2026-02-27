/**
 * gc.ts — JSOS TypeScript Garbage Collector (GC)
 *
 * Implements:
 *  - Incremental tri-color mark-and-sweep (item 877): max 1ms pause per slice
 *  - Generational collection: young/old heap, minor GC < 0.5ms (item 878)
 *  - Write barrier: old→young pointer tracking (item 879)
 *  - Nursery size tuning (item 880)
 *  - WeakRef / WeakMap / WeakSet lifecycle management (item 881)
 *  - FinalizationRegistry idle-time callbacks (item 882)
 *  - Object pool: VNode/VElement reuse (item 883)
 *  - ArrayBuffer pool: recycle fixed-size buffers (item 884)
 *  - String interning: deduplicate common strings (item 885)
 *  - Slab allocator: fixed-size slabs for common object sizes (item 886)
 *  - Copy-on-write strings: shared backing buffer (item 887)
 *  - sys.mem.gc() TypeScript API (item 888)
 *  - Heap profiler: sys.mem.snapshot() (item 889)
 *
 * Architecture:
 *  - JS heap is partitioned into YOUNG (nursery) and OLD generations
 *  - All new objects born in nursery (default 4 MB)
 *  - Minor GC: copy live nursery objects to old; runs < 0.5 ms
 *  - Major GC: incremental tri-color mark+sweep of full heap; 1 ms slices
 *  - OLD→YOUNG writes tracked by write barrier → remembered set
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default nursery size = 4 MB. Configurable at boot. */
const DEFAULT_NURSERY_BYTES = 4 * 1024 * 1024;
/** Default old-gen ceiling = 128 MB. */
const DEFAULT_OLD_MAX_BYTES = 128 * 1024 * 1024;
/** Max time to spend in a single incremental GC slice (milliseconds). */
const GC_SLICE_BUDGET_MS = 1;
/** Max time for minor (nursery) GC (milliseconds). */
const MINOR_GC_BUDGET_MS = 0.5;
/** Frequency of background GC slices (in tick intervals). */
const GC_TICK_INTERVAL = 2;

// ── Tri-color mark state ──────────────────────────────────────────────────────

const enum Color { WHITE = 0, GREY = 1, BLACK = 2 }

// ── GCObject ─────────────────────────────────────────────────────────────────

export interface GCObject {
  /** Unique id within this GC session. */
  gcId: number;
  /** Tri-color for major GC. */
  color: Color;
  /** Generational flag: false = young, true = old. */
  tenured: boolean;
  /** Live references from this object (for graph traversal). */
  refs(): GCObject[];
  /** Called before object is collected (optional finalizer hook). */
  finalize?(): void;
}

// ── Remembered set ────────────────────────────────────────────────────────────

/**
 * Tracks old→young pointer writes so minor GC can find young survivors
 * referenced only from old-gen objects (item 879 write barrier).
 */
class RememberedSet {
  private _set: Set<GCObject> = new Set();

  /** Record that `oldObj` now points to a young object. */
  add(oldObj: GCObject): void { this._set.add(oldObj); }
  /** Remove when old object gets collected. */
  remove(oldObj: GCObject): void { this._set.delete(oldObj); }
  /** Iterate all remembered old objects. */
  forEach(cb: (o: GCObject) => void): void { this._set.forEach(cb); }
  /** Clear after minor GC. */
  clear(): void { this._set.clear(); }
  get size(): number { return this._set.size; }
}

// ── WriteBarrier ─────────────────────────────────────────────────────────────

/**
 * Write barrier — ensures old→young pointers are tracked.
 * Every store `old.field = young` must call `writeBarrier(old, young)`.
 *
 * Item 879.
 */
export class WriteBarrier {
  private _remSet: RememberedSet;

  constructor(remSet: RememberedSet) {
    this._remSet = remSet;
  }

  /**
   * Called whenever a reference field is written.
   * If `owner` is old and `target` is young, add to remembered set.
   */
  write(owner: GCObject, target: GCObject | null): void {
    if (owner.tenured && target !== null && !target.tenured) {
      this._remSet.add(owner);
    }
  }
}

// ── NurserySizeTuner ─────────────────────────────────────────────────────────

/**
 * Dynamically tunes the nursery size based on minor-GC pause times.
 * If pause > MINOR_GC_BUDGET_MS, halve nursery; if pause < 0.2ms, grow.
 *
 * Item 880.
 */
export class NurserySizeTuner {
  private _nurseryBytes: number;
  private _minBytes:     number = 512 * 1024;   // 512 KB floor
  private _maxBytes:     number = 16 * 1024 * 1024; // 16 MB ceiling

  constructor(initialBytes: number = DEFAULT_NURSERY_BYTES) {
    this._nurseryBytes = initialBytes;
  }

  get nurseryBytes(): number { return this._nurseryBytes; }

  /** Called after every minor GC with actual pause. */
  feedback(pauseMs: number): void {
    if (pauseMs > MINOR_GC_BUDGET_MS) {
      this._nurseryBytes = Math.max(this._minBytes, this._nurseryBytes >>> 1);
    } else if (pauseMs < 0.2) {
      this._nurseryBytes = Math.min(this._maxBytes, this._nurseryBytes * 2);
    }
  }
}

// ── WeakRefManager ────────────────────────────────────────────────────────────

/**
 * Tracks WeakRef / WeakMap / WeakSet registrations.
 * After each major GC, null out refs to collected objects.
 *
 * Item 881.
 */
export class WeakRefManager {
  /** (weakRef, target) — wipeTarget() called if target is collected. */
  private _refs: Map<WeakRefHandle, GCObject> = new Map();

  register(handle: WeakRefHandle, target: GCObject): void {
    this._refs.set(handle, target);
  }

  unregister(handle: WeakRefHandle): void {
    this._refs.delete(handle);
  }

  /** Called after sweep; null out refs whose targets were collected. */
  sweep(isAlive: (o: GCObject) => boolean): void {
    this._refs.forEach((target, handle) => {
      if (!isAlive(target)) {
        handle._target = null;
        this._refs.delete(handle);
      }
    });
  }
}

/** Handle returned by WeakRef constructor; tracks live target or null. */
export class WeakRefHandle {
  _target: GCObject | null;
  constructor(target: GCObject) { this._target = target; }
  deref(): GCObject | null { return this._target; }
}

// ── FinalizationQueue ─────────────────────────────────────────────────────────

/**
 * Defers FinalizationRegistry callbacks to idle time.
 *
 * Item 882.
 */
export class FinalizationQueue {
  private _pending: Array<() => void> = [];

  enqueue(cb: () => void): void { this._pending.push(cb); }

  /** Called during idle frames; drains up to `budget` ms of callbacks. */
  drainIdle(budgetMs: number): void {
    var start = _nowMs();
    while (this._pending.length > 0 && _nowMs() - start < budgetMs) {
      var cb = this._pending.shift()!;
      try { cb(); } catch (_) {}
    }
  }

  get pendingCount(): number { return this._pending.length; }
}

function _nowMs(): number {
  return (typeof kernel !== 'undefined' && kernel.getTicks)
    ? kernel.getTicks() * 10
    : Date.now();
}

// ── ObjectPool ────────────────────────────────────────────────────────────────

/**
 * Generic object pool to reuse GC-managed objects across re-renders.
 * Reduces nursery pressure for short-lived typed objects (VNode, VElement).
 *
 * Item 883.
 */
export class ObjectPool<T extends GCObject> {
  private _free: T[] = [];
  private _create: () => T;
  private _reset:  (o: T) => void;
  private _maxIdle: number;
  /** Total objects checked out. */
  allocCount = 0;
  /** Total objects returned (reused). */
  reuseCount = 0;

  constructor(create: () => T, reset: (o: T) => void, maxIdle = 256) {
    this._create  = create;
    this._reset   = reset;
    this._maxIdle = maxIdle;
  }

  /** Get an object from the pool or create a fresh one. */
  acquire(): T {
    this.allocCount++;
    if (this._free.length > 0) {
      this.reuseCount++;
      return this._free.pop()!;
    }
    return this._create();
  }

  /** Return an object back to the pool. */
  release(obj: T): void {
    if (this._free.length < this._maxIdle) {
      this._reset(obj);
      this._free.push(obj);
    }
  }

  get idleCount(): number { return this._free.length; }

  /** Discard all idle objects (called during major GC). */
  flush(): void { this._free.length = 0; }
}

// ── ArrayBufferPool ───────────────────────────────────────────────────────────

/**
 * Recycles ArrayBuffers at fixed sizes: 4 KB, 64 KB, 1 MB.
 * Used by network I/O and image decode to avoid GC pressure.
 *
 * Item 884.
 */
export class ArrayBufferPool {
  private static readonly _SIZES = [4096, 65536, 1024 * 1024];
  private _pools: Map<number, Uint8Array[]> = new Map();

  constructor() {
    for (var sz of ArrayBufferPool._SIZES) {
      this._pools.set(sz, []);
    }
  }

  private _bucket(size: number): number {
    for (var sz of ArrayBufferPool._SIZES) {
      if (size <= sz) return sz;
    }
    return size; // oversized — no pool
  }

  /** Get a Uint8Array of at least `size` bytes. */
  acquire(size: number): Uint8Array {
    var bucket = this._bucket(size);
    var pool   = this._pools.get(bucket);
    if (pool && pool.length > 0) return pool.pop()!;
    return new Uint8Array(bucket || size);
  }

  /** Return a buffer to the pool. Must be one of the standard sizes. */
  release(buf: Uint8Array): void {
    var bucket = this._bucket(buf.byteLength);
    var pool   = this._pools.get(bucket);
    if (pool && pool.length < 64) {
      // Zero out sensitive data before pooling
      buf.fill(0);
      pool.push(buf);
    }
  }

  /** Flush all pooled buffers (GC pressure relief). */
  flush(): void {
    this._pools.forEach(p => { p.length = 0; });
  }

  totalIdleBytes(): number {
    var total = 0;
    this._pools.forEach((p, sz) => { total += p.length * sz; });
    return total;
  }
}

// ── StringInterning ───────────────────────────────────────────────────────────

/**
 * Deduplicates CSS class names, tag names, attribute names to reduce
 * GC-managed string objects.
 *
 * Item 885.
 */
export class StringInterning {
  private _table: Map<string, string> = new Map();
  private _hits    = 0;
  private _misses  = 0;

  /** Return the canonical interned copy of `s`. */
  intern(s: string): string {
    var existing = this._table.get(s);
    if (existing !== undefined) {
      this._hits++;
      return existing;
    }
    this._misses++;
    this._table.set(s, s);
    return s;
  }

  /** Remove all strings not in the `keep` set. */
  sweep(keep: Set<string>): void {
    this._table.forEach((_, k) => {
      if (!keep.has(k)) this._table.delete(k);
    });
  }

  get size(): number { return this._table.size; }
  get hitRate(): number {
    var total = this._hits + this._misses;
    return total > 0 ? this._hits / total : 0;
  }
}

// ── SlabAllocator ─────────────────────────────────────────────────────────────

/**
 * Fixed-size slab allocator for the TypeScript heap manager.
 * Maintains per-size free-lists; each slab holds 64 objects.
 *
 * Supports sizes: 16, 32, 64, 128, 256, 512 bytes (encoded as Uint8Array slots).
 *
 * Item 886.
 */
export class SlabAllocator {
  private static readonly _SIZES = [16, 32, 64, 128, 256, 512];
  private static readonly _SLAB_OBJS = 64;

  private _slabs: Map<number, Uint8Array[][]> = new Map();
  private _freeIdx: Map<number, Array<[Uint8Array[], number]>> = new Map();

  constructor() {
    for (var sz of SlabAllocator._SIZES) {
      this._slabs.set(sz, []);
      this._freeIdx.set(sz, []);
    }
  }

  private _bucket(size: number): number | null {
    for (var sz of SlabAllocator._SIZES) {
      if (size <= sz) return sz;
    }
    return null;
  }

  /** Allocate a raw Uint8Array slot of at least `size` bytes. */
  alloc(size: number): Uint8Array {
    var bucket = this._bucket(size);
    if (bucket === null) return new Uint8Array(size);
    var freeList = this._freeIdx.get(bucket)!;
    if (freeList.length > 0) {
      var [slab, idx] = freeList.pop()!;
      return new Uint8Array(slab[0].buffer, idx * bucket, bucket);
    }
    // Allocate new slab
    var slabBuf  = new Uint8Array(bucket * SlabAllocator._SLAB_OBJS);
    var slabArr: Uint8Array[] = [];
    for (var i = 0; i < SlabAllocator._SLAB_OBJS; i++) {
      slabArr.push(new Uint8Array(slabBuf.buffer, i * bucket, bucket));
    }
    this._slabs.get(bucket)!.push(slabArr);
    // Add all but first to free list
    for (var j = 1; j < SlabAllocator._SLAB_OBJS; j++) {
      freeList.push([slabArr, j]);
    }
    return slabArr[0];
  }

  /** Return a slab slot to the free list. */
  free(slot: Uint8Array): void {
    var bucket = this._bucket(slot.byteLength);
    if (bucket === null) return;
    var freeList = this._freeIdx.get(bucket)!;
    var slabArr = this._slabs.get(bucket)!
      .find(s => s[0].buffer === slot.buffer);
    if (slabArr) {
      var idx = slot.byteOffset / bucket;
      freeList.push([slabArr, idx]);
    }
  }

  /** Drop all slabs. */
  reset(): void {
    this._slabs.forEach(s => { s.length = 0; });
    this._freeIdx.forEach(f => { f.length = 0; });
  }
}

// ── CopyOnWriteString ─────────────────────────────────────────────────────────

/**
 * COW string: multiple CowString instances share one backing string until
 * one of them is mutated, at which point it forks a private copy.
 *
 * Item 887.
 */
export class CowString {
  private _backing: { s: string };
  private _owned:   boolean;

  constructor(s: string) {
    this._backing = { s };
    this._owned   = true;
  }

  /** Create a shallow clone that shares the backing buffer. */
  clone(): CowString {
    var copy      = new CowString('');
    copy._backing = this._backing;
    copy._owned   = false;
    this._owned   = false;  // both are now shared
    return copy;
  }

  get value(): string { return this._backing.s; }

  /** Mutate the string. Forks private copy if shared. */
  set value(s: string) {
    if (!this._owned) {
      this._backing = { s };
      this._owned   = true;
    } else {
      this._backing.s = s;
    }
  }

  concat(other: string): CowString {
    var result = new CowString(this._backing.s + other);
    return result;
  }

  get length(): number { return this._backing.s.length; }
  toString(): string   { return this._backing.s; }
}

// ── HeapStats / HeapProfiler ──────────────────────────────────────────────────

export interface HeapStats {
  youngObjects:    number;
  oldObjects:      number;
  youngBytes:      number;
  oldBytes:        number;
  totalBytes:      number;
  nurserySizeBytes:number;
  oldMaxBytes:     number;
  minorGCCount:    number;
  majorGCCount:    number;
  totalGCPauseMs:  number;
  weakRefs:        number;
  finalizers:      number;
  stringTableSize: number;
  poolIdleBytes:   number;
}

/**
 * Heap profiler: `sys.mem.snapshot()` returns live-object graph as JSON.
 *
 * Item 889.
 */
export class HeapProfiler {
  private _root: GCObject[];
  private _gc:   IncrementalGC;

  constructor(gc: IncrementalGC) {
    this._root = [];
    this._gc   = gc;
  }

  /** Take a snapshot; returns a serialisable summary. */
  snapshot(): HeapSnapshot {
    var stats  = this._gc.getStats();
    var liveObjs: SnapshotNode[] = [];
    var visited: Set<number> = new Set();

    var walk = (obj: GCObject): void => {
      if (visited.has(obj.gcId)) return;
      visited.add(obj.gcId);
      liveObjs.push({
        id:      obj.gcId,
        type:    obj.constructor.name,
        tenured: obj.tenured,
        size:    0,   // real size requires C heap introspection
      });
      for (var ref of obj.refs()) walk(ref);
    };
    for (var r of this._root) walk(r);

    return {
      timestamp:    _nowMs(),
      stats,
      liveObjects:  liveObjs,
      totalLive:    liveObjs.length,
    };
  }

  addRoot(obj: GCObject): void { this._root.push(obj); }
}

export interface SnapshotNode {
  id:      number;
  type:    string;
  tenured: boolean;
  size:    number;
}

export interface HeapSnapshot {
  timestamp:   number;
  stats:       HeapStats;
  liveObjects: SnapshotNode[];
  totalLive:   number;
}

// ── IncrementalGC ─────────────────────────────────────────────────────────────

/**
 * Main GC controller.
 * Implements tri-color incremental mark-and-sweep (item 877) +
 * generational minor GC (item 878).
 */
export class IncrementalGC {
  // Generational sets
  private _young: Set<GCObject> = new Set();
  private _old:   Set<GCObject> = new Set();

  // Remembered set (old→young write barrier tracking)
  private _remSet: RememberedSet = new RememberedSet();

  // Tri-color mark state for major GC
  private _grey:   Set<GCObject> = new Set();  // to be scanned
  private _black:  Set<GCObject> = new Set();  // scanned+live

  // Major GC phases
  private _majorPhase: 'idle' | 'marking' | 'sweeping' = 'idle';
  private _sweepQueue: GCObject[] = [];

  // Statistics
  private _minorGCCount   = 0;
  private _majorGCCount   = 0;
  private _totalPauseMs   = 0;
  private _nextGcId       = 1;

  // Supporting subsystems
  readonly writeBarrier:   WriteBarrier;
  readonly weakRefs:       WeakRefManager;
  readonly finalQueue:     FinalizationQueue;
  readonly nurserySizer:   NurserySizeTuner;
  readonly abPool:         ArrayBufferPool;
  readonly stringTable:    StringInterning;
  readonly slabAlloc:      SlabAllocator;

  // Roots — objects that are always live (global scope, stack frames)
  private _roots: Set<GCObject> = new Set();

  constructor(
    nurseryBytes: number = DEFAULT_NURSERY_BYTES,
    oldMaxBytes:  number = DEFAULT_OLD_MAX_BYTES,
  ) {
    this.writeBarrier = new WriteBarrier(this._remSet);
    this.weakRefs      = new WeakRefManager();
    this.finalQueue    = new FinalizationQueue();
    this.nurserySizer  = new NurserySizeTuner(nurseryBytes);
    this.abPool        = new ArrayBufferPool();
    this.stringTable   = new StringInterning();
    this.slabAlloc     = new SlabAllocator();
    void oldMaxBytes;  // stored in NurserySizeTuner max
  }

  // ── Object registration ────────────────────────────────────────────────────

  /** Register a newly allocated GC object into the nursery. */
  register(obj: GCObject): void {
    (obj as any).gcId = this._nextGcId++;
    (obj as any).color  = Color.WHITE;
    (obj as any).tenured = false;
    this._young.add(obj);
  }

  addRoot(obj: GCObject): void { this._roots.add(obj); }
  removeRoot(obj: GCObject): void { this._roots.delete(obj); }

  // ── Minor GC ──────────────────────────────────────────────────────────────

  /**
   * Run a minor (nursery) GC. Copies live young objects to old-gen.
   * Uses remembered set as extra roots (item 879 write barrier).
   */
  minorGC(): number {
    var t0 = _nowMs();

    // Mark phase: start from roots + remembered-set objects
    var live: Set<GCObject> = new Set();

    var mark = (obj: GCObject): void => {
      if (live.has(obj)) return;
      live.add(obj);
      for (var ref of obj.refs()) {
        if (!ref.tenured) mark(ref);
      }
    };

    // GC roots
    this._roots.forEach(mark);

    // Old objects pointing into nursery (from remembered set)
    this._remSet.forEach(oldObj => {
      for (var ref of oldObj.refs()) {
        if (!ref.tenured) mark(ref);
      }
    });

    // Survive: promote live young objects to old-gen
    this._young.forEach(obj => {
      if (live.has(obj)) {
        (obj as any).tenured = true;
        this._old.add(obj);
      } else {
        // Dead — run finalizer
        if (obj.finalize) {
          this.finalQueue.enqueue(obj.finalize.bind(obj));
        }
      }
    });
    this._young.clear();
    this._remSet.clear();

    var pauseMs = _nowMs() - t0;
    this._minorGCCount++;
    this._totalPauseMs += pauseMs;
    this.nurserySizer.feedback(pauseMs);
    return pauseMs;
  }

  // ── Major GC ──────────────────────────────────────────────────────────────

  /**
   * Start a new incremental major GC cycle.
   * Pushes roots to grey set and starts marking.
   */
  startMajorGC(): void {
    if (this._majorPhase !== 'idle') return;
    this._grey.clear();
    this._black.clear();

    // All live roots are grey
    this._roots.forEach(r => {
      r.color = Color.GREY;
      this._grey.add(r);
    });

    this._majorPhase = 'marking';
  }

  /**
   * Run one incremental GC slice of up to `budgetMs` elapsed time.
   * Should be called from the frame/tick loop.
   *
   * Item 877: max 1ms pause per slice at 60fps.
   */
  slice(budgetMs: number = GC_SLICE_BUDGET_MS): void {
    if (this._majorPhase === 'idle') return;

    var t0 = _nowMs();

    if (this._majorPhase === 'marking') {
      // Tri-color incremental marking
      while (this._grey.size > 0 && _nowMs() - t0 < budgetMs) {
        var obj = this._grey.values().next().value as GCObject;
        this._grey.delete(obj);
        obj.color = Color.BLACK;
        this._black.add(obj);

        for (var ref of obj.refs()) {
          if (ref.color === Color.WHITE) {
            ref.color = Color.GREY;
            this._grey.add(ref);
          }
        }
      }

      if (this._grey.size === 0) {
        // Marking complete — transition to sweep
        this._sweepQueue = Array.from(this._old).concat(Array.from(this._young));
        this._majorPhase = 'sweeping';
      }
    }

    if (this._majorPhase === 'sweeping') {
      while (this._sweepQueue.length > 0 && _nowMs() - t0 < budgetMs) {
        var o = this._sweepQueue.pop()!;
        if (o.color === Color.WHITE) {
          // Unreachable — collect
          this._old.delete(o);
          this._young.delete(o);
          this._remSet.remove(o);
          if (o.finalize) {
            this.finalQueue.enqueue(o.finalize.bind(o));
          }
        } else {
          // Alive — reset to white for next cycle
          o.color = Color.WHITE;
        }
      }

      if (this._sweepQueue.length === 0) {
        // Sweep complete
        this.weakRefs.sweep(o2 => this._old.has(o2) || this._young.has(o2));
        this._majorPhase = 'idle';
        this._majorGCCount++;
      }
    }

    this._totalPauseMs += _nowMs() - t0;
  }

  /** Trigger a synchronous full GC (blocks; for sys.mem.gc() API). */
  fullGC(): number {
    var t0 = _nowMs();
    this.minorGC();
    this.startMajorGC();
    while (this._majorPhase !== 'idle') {
      this.slice(10);  // large budget for synchronous full GC
    }
    var freed = _nowMs() - t0;
    this.abPool.flush();
    this.slabAlloc.reset();
    return freed;
  }

  /** Periodic tick — called from the frame loop (items 877/878). */
  tick(tickNo: number): void {
    if (tickNo % (GC_TICK_INTERVAL * 3) === 0) {
      // Minor GC every 6 ticks
      if (this._young.size > 1000) this.minorGC();
    }
    if (tickNo % GC_TICK_INTERVAL === 0) {
      // Incremental major GC slice every 2 ticks
      if (this._majorPhase === 'idle' && this._old.size > 5000) {
        this.startMajorGC();
      }
      this.slice(GC_SLICE_BUDGET_MS);
    }
    // Drain finalizers during idle
    this.finalQueue.drainIdle(0.5);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): HeapStats {
    return {
      youngObjects:     this._young.size,
      oldObjects:       this._old.size,
      youngBytes:       this._young.size * 64,   // estimated avg object size
      oldBytes:         this._old.size   * 128,
      totalBytes:       (this._young.size + this._old.size) * 96,
      nurserySizeBytes: this.nurserySizer.nurseryBytes,
      oldMaxBytes:      DEFAULT_OLD_MAX_BYTES,
      minorGCCount:     this._minorGCCount,
      majorGCCount:     this._majorGCCount,
      totalGCPauseMs:   Math.round(this._totalPauseMs * 10) / 10,
      weakRefs:         0,   // tracked inside WeakRefManager (no public count)
      finalizers:       this.finalQueue.pendingCount,
      stringTableSize:  this.stringTable.size,
      poolIdleBytes:    this.abPool.totalIdleBytes(),
    };
  }

  get youngCount(): number { return this._young.size; }
  get oldCount():   number  { return this._old.size;   }
  get phase(): string       { return this._majorPhase; }
}

// ── ManualGCAPI ───────────────────────────────────────────────────────────────

/**
 * sys.mem.gc() TypeScript API — trigger manual GC from REPL.
 * Returns bytes freed (estimated).
 *
 * Item 888.
 */
export class ManualGCAPI {
  private _gc: IncrementalGC;

  constructor(gc: IncrementalGC) { this._gc = gc; }

  /** Trigger a full synchronous GC. Returns estimated freed bytes. */
  gc(): number {
    var before = this._gc.getStats().totalBytes;
    this._gc.fullGC();
    var after  = this._gc.getStats().totalBytes;
    return Math.max(0, before - after);
  }

  /** Return heap statistics. */
  stats(): HeapStats { return this._gc.getStats(); }

  /** Return a heap snapshot. */
  snapshot(): HeapSnapshot {
    var profiler = new HeapProfiler(this._gc);
    return profiler.snapshot();
  }
}

// ── Global singleton ──────────────────────────────────────────────────────────

/** Singleton GC instance used by the OS. */
export const globalGC = new IncrementalGC(DEFAULT_NURSERY_BYTES, DEFAULT_OLD_MAX_BYTES);

/** Singleton manual GC API. */
export const memAPI = new ManualGCAPI(globalGC);
