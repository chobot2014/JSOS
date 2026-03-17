/**
 * sys.shm — Shared Memory API
 * Item 221: sys.shm.anonymous()
 *
 * Provides POSIX-style anonymous shared memory backed by the virtual memory manager.
 * Anonymous regions are not tied to any file path; they exist only while at least
 * one process holds a mapping.
 */

declare const kernel: any;

// ── region descriptor ──────────────────────────────────────────────────────

export interface ShmRegion {
  /** Physical page base (opaque handle for the kernel) */
  readonly physBase: number;
  /** Size in bytes (rounded up to page boundary) */
  readonly size: number;
  /** Read/write view backed by the region */
  readonly buffer: ArrayBuffer;
  /** Map the region into the calling process's address space */
  map(): ArrayBuffer;
  /** Unmap (release the process reference; region freed when count reaches 0) */
  unmap(): void;
  /** Get current reference count */
  refCount(): number;
}

// ── private bookkeeping ────────────────────────────────────────────────────

const _regions = new Map<number, { physBase: number; size: number; refs: number; buf: ArrayBuffer }>();
let _nextId = 1;

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Allocate a new anonymous shared memory region of at least `size` bytes.
 *
 * The returned region is already mapped into the caller's address space.
 * Other processes can receive it via an IPC message (send the ShmRegion object).
 *
 * @throws if the kernel cannot allocate pages (out of memory)
 */
export function anonymous(size: number): ShmRegion {
  if (size <= 0) throw new Error('shm.anonymous: size must be > 0');

  // Round up to page boundary (4096 bytes)
  const pageSize = 4096;
  const alignedSize = Math.ceil(size / pageSize) * pageSize;

  // Ask the kernel to allocate physically contiguous pages
  const physBase: number = kernel.allocPages(alignedSize / pageSize);
  if (physBase === 0) throw new Error('shm.anonymous: out of memory');

  // Get a JS ArrayBuffer view of the physical memory
  const buf: ArrayBuffer = kernel.mmioBuffer(physBase, alignedSize);

  const id = _nextId++;
  _regions.set(id, { physBase, size: alignedSize, refs: 1, buf });

  const region: ShmRegion = {
    physBase,
    size: alignedSize,
    buffer: buf,

    map(): ArrayBuffer {
      const rec = _regions.get(id);
      if (!rec) throw new Error('shm: region already freed');
      rec.refs++;
      return rec.buf;
    },

    unmap(): void {
      const rec = _regions.get(id);
      if (!rec) return;
      rec.refs--;
      if (rec.refs <= 0) {
        kernel.freePages(rec.physBase, rec.size / pageSize);
        _regions.delete(id);
      }
    },

    refCount(): number {
      return _regions.get(id)?.refs ?? 0;
    },
  };

  return region;
}

/**
 * Create a shared memory region pre-filled from an existing ArrayBuffer.
 * Useful for efficiently passing large blobs between processes.
 */
export function fromBuffer(data: ArrayBuffer): ShmRegion {
  const region = anonymous(data.byteLength);
  new Uint8Array(region.buffer).set(new Uint8Array(data));
  return region;
}

/**
 * Total bytes currently allocated in anonymous SHM regions.
 */
export function totalAllocated(): number {
  let total = 0;
  for (const rec of _regions.values()) total += rec.size;
  return total;
}

// ── sys.shm namespace export ───────────────────────────────────────────────

export const shm = {
  anonymous,
  fromBuffer,
  totalAllocated,
};
