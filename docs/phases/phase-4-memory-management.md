# Phase 4 — Real Memory Management

## Goal

Remove the static 64 MB heap from `linker.ld`. Replace it with a real physical
page frame allocator that uses all RAM reported by GRUB. Enable hardware paging
(CR0.PG) so virtual addresses can differ from physical. Implement a real `mmap`,
`munmap`, and `mprotect` in `vmm.ts`.

---

## Prerequisites

- Phase 3 complete (64 MB heap gives enough room to run the allocator itself
  before it takes over)
- Phase 5 (preemptive threading) depends on Phase 4 paging being complete

---

## The C Code Rule Applied Here

The CPU's paging mechanism is entirely hardware-managed, but enabling it requires
privileged register writes. These are pure, stateless C functions — they write
a register and return. **Every decision about what to map where, what flags to
set, and when to flush is made by TypeScript.**

---

## 4a — Physical Page Frame Allocator

### New C Primitive

```c
// Added to quickjs_binding.c:
kernel.getMemoryMap()
// → [{ base: number, length: number, type: number }, ...]
// type: 1 = usable RAM, 2 = reserved, 3 = ACPI, 4 = NVS, 5 = bad
// Reads directly from the multiboot memory map tag
```

C does nothing else with the memory map — it returns the raw entries.

### PhysicalAllocator (TypeScript — src/os/process/physalloc.ts)

```typescript
class PhysicalAllocator {
  // Initialised from kernel.getMemoryMap()
  // Maintains a bitmap: 1 bit per 4KB page frame over all usable ranges
  // Kernel image and heap are pre-marked as used at init time

  static init(): PhysicalAllocator

  // Allocate n contiguous page frames. Returns physical base address.
  // Throws if insufficient contiguous free frames.
  alloc(pages: number): number

  // Free n frames starting at physical address addr.
  free(addr: number, pages: number): void

  // Statistics
  totalPages(): number
  freePages(): number
  usedPages(): number
  available(): number      // bytes of free physical RAM

  // Internal: bitmap operations
  private findFree(pages: number): number
  private mark(frame: number, used: boolean): void
  private isUsed(frame: number): boolean
}
```

### Bitmap Layout

One `Uint8Array` allocated at OS init time. Each bit represents one 4KB page.
Size: `totalRAM / 4KB / 8` bytes. For 512 MB RAM: 16 KB bitmap.

The bitmap itself is allocated from the old static heap before the new allocator
takes over. Once the allocator is live, the old heap region is registered with
it as free.

---

## 4b — Paging Hardware (C — register writes only)

```c
// New C primitives — each writes exactly one hardware register or entry:

kernel.setPDPT(physAddr: number): void
// Writes physAddr to CR3 (Page Directory Physical Address)
// Flushes entire TLB as a side effect of CR3 write

kernel.flushTLB(): void
// Writes current CR3 back to itself (cheapest full TLB flush)
// For single-page invalidation: invlpg (Phase 5 adds kernel.invlpg)

kernel.setPageEntry(pdIdx: number, ptIdx: number,
                    physAddr: number, flags: number): void
// Writes one Page Table Entry.
// pdIdx: index into current page directory (0–1023)
// ptIdx: index into the page table at pdIdx (0–1023)
// physAddr: must be page-aligned (low 12 bits ignored)
// flags: P|RW|US|PWT|PCD|A|D|PS|G — TypeScript defines the constants

kernel.enablePaging(): void
// Sets CR0.PG bit. Called ONCE during Phase 4 boot.
// After this, all addresses are virtual.
```

**C does not decide what goes into any PTE.** TypeScript passes all the values.

### Page Flag Constants (kernel.ts)

```typescript
namespace PageFlag {
  const PRESENT    = 0x001
  const WRITABLE   = 0x002
  const USER       = 0x004
  const WRITE_THROUGH = 0x008
  const NO_CACHE   = 0x010
  const ACCESSED   = 0x020
  const DIRTY      = 0x040
  const HUGE       = 0x080   // 4MB pages (PS bit)
  const GLOBAL     = 0x100
}
```

---

## 4c — Virtual Memory Manager (upgrade vmm.ts)

The simulated VMM from Phase 1 is replaced with real page table management.
The `VirtualMemoryManager` class now interacts with `PhysicalAllocator` and the
C paging primitives.

### Address Space

```typescript
class AddressSpace {
  private cr3: number          // physical address of page directory
  private physAlloc: PhysicalAllocator

  constructor(physAlloc: PhysicalAllocator)

  // Map a virtual page to a physical frame with given flags
  mapPage(virt: number, phys: number, flags: number): void

  // Unmap a virtual page (set PTE to not-present)
  unmapPage(virt: number): void

  // Translate virtual to physical (walks page tables)
  translate(virt: number): number | null

  // Install as the active address space (calls kernel.setPDPT)
  activate(): void

  // Clone this address space (used by fork — Phase 6)
  clone(): AddressSpace
}
```

### mmap / munmap / mprotect

```typescript
class VirtualMemoryManager {
  private space: AddressSpace
  private allocations: Map<number, VMAllocation>

  mmap(hint: number, length: number, prot: Protection, flags: MMapFlags): number
  // hint=0: pick any available virtual range
  // PROT_READ|PROT_WRITE|PROT_EXEC
  // MAP_ANON|MAP_FIXED|MAP_SHARED

  munmap(addr: number, length: number): void
  // Frees physical frames and removes PTEs

  mprotect(addr: number, length: number, prot: Protection): void
  // Updates PTE flags — needed for JIT (W^X transitions)

  brk(addr: number): number
  // Heap expansion for malloc implementations
}
```

---

## 4d — Kernel/User Address Split

```
Virtual Address Space Layout (i686, 4GB total)
──────────────────────────────────────────────
0x00000000 – 0xBFFFFFFF   User space     (3 GB, ring 3)
0xC0000000 – 0xFFFFFFFF   Kernel space   (1 GB, ring 0)
                           Identity mapped to physical 0x00000000–0x3FFFFFFF
```

- Kernel is always mapped in every address space at 0xC0000000
- User processes (Phase 6) see only their own virtual memory below 0xC0000000
- Kernel stack is at a fixed address in kernel space per thread (Phase 5)

### Kernel Identity Map

At Phase 4 init, the kernel sets up the initial page directory:
- First 1 GB of physical RAM mapped identity at 0xC0000000 (kernel space)
- Framebuffer physical address mapped into kernel space (no-cache flag)
- All other PTEs not-present initially (demand-paged in Phase 6)

---

## New C Primitives Summary

| Binding | Description |
|---|---|
| `kernel.getMemoryMap()` | Multiboot memory map → JS array |
| `kernel.setPDPT(addr)` | Write CR3 |
| `kernel.flushTLB()` | Full TLB flush |
| `kernel.setPageEntry(pd, pt, phys, flags)` | Write one PTE |
| `kernel.enablePaging()` | Set CR0.PG (called once) |

---

## New / Modified TypeScript Files

| File | Change |
|---|---|
| `src/os/process/physalloc.ts` | NEW: physical page frame allocator |
| `src/os/process/vmm.ts` | REWRITE: real paging, mmap/munmap/mprotect |
| `src/os/core/kernel.ts` | Add new C binding declarations |

---

## Test Oracle

```
[SERIAL] Physical memory: 512 MB (131072 pages)
[SERIAL] Kernel image: 0xC0100000 – 0xC0A00000 (reserved)
[SERIAL] Paging enabled
[SERIAL] VMM: mmap test passed
[SERIAL] REPL ready
```

---

## What Phase 4 Does NOT Do

- ❌ No copy-on-write fork (Phase 6)
- ❌ No demand paging / page fault handler (Phase 6)
- ❌ No NUMA awareness
- ❌ No huge pages (2MB/4MB) by default — can be added with `PageFlag.HUGE`
- ❌ No user-space isolation (Phase 6 adds TSS + ring 3)
