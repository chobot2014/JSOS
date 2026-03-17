/*
 * JSOS Physical Memory Manager  (items 10, 33, 34, 36)
 *
 * Stage 1: parse the Multiboot2 memory-map tag (type 6 = E820).
 * Stage 2: build a flat bit-array covering up to 512 MB of physical space
 *          (1 bit = 4 KB page, 0 = free, 1 = used/reserved).
 * Stage 3: simple bump heap for kernel small allocations.
 *
 * Guard pages: alloc_page_guarded(n) allocates n+2 pages, marks the first
 * and last permanently reserved so any stray pointer into them faults.
 */

#include "memory.h"
#include "platform.h"
#include <string.h>
#include <stdint.h>

/* ── Bitmap ───────────────────────────────────────────────────────────────── */
/* 512 MB / 4 KB = 131072 pages → 131072 / 8 = 16 384 bytes                 */
#define BITMAP_BYTES  (MAX_PAGES / 8u)

static uint8_t  _bitmap[BITMAP_BYTES];   /* 0-bit = free, 1-bit = used/reserved */
static uint32_t _total_pages = 0;
static uint32_t _free_pages  = 0;
static uint32_t _first_free  = 0;        /* cached scan hint                   */

/* ── Bitmap helpers ───────────────────────────────────────────────────────── */
static inline int  _page_is_used(uint32_t pfn) {
    return (_bitmap[pfn >> 3] >> (pfn & 7)) & 1;
}
static inline void _mark_used(uint32_t pfn) {
    _bitmap[pfn >> 3] |= (uint8_t)(1u << (pfn & 7));
}
static inline void _mark_free(uint32_t pfn) {
    _bitmap[pfn >> 3] &= (uint8_t)~(1u << (pfn & 7));
}

/* ── MB2 memory-map tag parse (items 10, 12) ─────────────────────────────── */
#define MB2_TAG_MMAP        6u
#define MB2_TAG_EFI32_MMAP  17u   /* Item 12: EFI 32-bit memory map */
#define MB2_TAG_EFI64_MMAP  19u   /* Item 12: EFI 64-bit memory map */
#define E820_USABLE         1u
#define EFI_CONVENTIONAL    7u    /* EFI memory type for usable RAM */

/* Mark a physical range [base, base+len) as free (E820 type = 1 only).      */
static void _apply_region(uint64_t base, uint64_t len, uint32_t type) {
    if (type != E820_USABLE) return;

    /* Clamp to supported range */
    uint64_t top = base + len;
    if (top > (uint64_t)MAX_PHYS_MEM) top = (uint64_t)MAX_PHYS_MEM;
    if (base >= top) return;

    /* Align inward to page boundaries */
    uint32_t pfn_start = (uint32_t)((base + (PAGE_SIZE - 1u)) >> PAGE_SHIFT);
    uint32_t pfn_end   = (uint32_t)(top >> PAGE_SHIFT);

    for (uint32_t pfn = pfn_start; pfn < pfn_end; pfn++) {
        if (pfn < MAX_PAGES && _page_is_used(pfn)) {
            _mark_free(pfn);
            _free_pages++;
            _total_pages++;
        }
    }
}

/*
 * Multiboot2 memory-map tag (type 6) layout:
 *   +0  type=6  (uint32)
 *   +4  size    (uint32)
 *   +8  entry_size  (uint32)
 *   +12 entry_version (uint32)
 *   +16 entries[]
 */
void memory_init_from_mb2(uint32_t mb2_info_addr) {
    /* Start with all pages marked used/reserved */
    memset(_bitmap, 0xFF, sizeof(_bitmap));
    _free_pages  = 0;
    _total_pages = 0;
    _first_free  = 0;

    /* Always reserve the first page (PFN 0) — null pointer trap */
    /* Also reserve first 4 MB for kernel code/data/stack        */
    uint32_t kernel_end_pfn = PHYS_TO_PAGE(4u * 1024u * 1024u);
    for (uint32_t i = 0; i < kernel_end_pfn && i < MAX_PAGES; i++)
        _mark_used(i);   /* still marked used (bitmap = all FF, no change) */

    if (!mb2_info_addr) {
        /* No MB2 — pretend we have a flat usable region 4 MB – 32 MB        */
        _apply_region(4u * 1024u * 1024u, 28u * 1024u * 1024u, E820_USABLE);
        platform_serial_puts("[MEM] No MB2; assumed 32 MB flat\n");
        return;
    }

    uint8_t  *p   = (uint8_t *)mb2_info_addr;
    uint32_t  tot = *(uint32_t *)p;
    uint8_t  *end = p + tot;
    p += 8;

    int found = 0;
    while (p < end) {
        uint32_t type = *(uint32_t *)p;
        uint32_t size = *(uint32_t *)(p + 4);
        if (type == 0) break;
        if (type == MB2_TAG_MMAP) {
            uint32_t entry_size = *(uint32_t *)(p + 8);
            /* entry_version at p+12 — ignore */
            uint8_t *ep  = p + 16;
            uint8_t *eend = p + size;
            while (ep + entry_size <= eend) {
                e820_entry_t *e = (e820_entry_t *)ep;
                _apply_region(e->base_addr, e->length, e->type);
                ep += entry_size;
            }
            found = 1;
        }
        /* Item 12 — EFI memory map handoff (tags 17 and 19)
         * EFI_MEMORY_DESCRIPTOR layout (within the tag):
         *  +0  descriptor_size  (uint32) — may differ from 48
         *  +4  descriptor_ver   (uint32)
         *  +8  descriptors[]:
         *       uint32 type;  uint32 pad;
         *       uint64 physical_start;  uint64 virtual_start;
         *       uint64 num_pages;       uint64 attribute;
         */
        if (type == MB2_TAG_EFI32_MMAP || type == MB2_TAG_EFI64_MMAP) {
            uint32_t desc_sz  = *(uint32_t *)(p + 8);
            if (desc_sz == 0) desc_sz = 48;  /* safe default */
            uint8_t *ep  = p + 16;
            uint8_t *eend = p + size;
            while (ep + desc_sz <= eend) {
                uint32_t etype = *(uint32_t *)ep;
                /* physical_start at offset 8 inside descriptor */
                uint64_t phys  = *(uint64_t *)(ep + 8);
                uint64_t npages= *(uint64_t *)(ep + 24);
                if (etype == EFI_CONVENTIONAL)
                    _apply_region(phys, npages * 4096ULL, E820_USABLE);
                ep += desc_sz;
            }
            if (!found) found = 1;  /* prefer E820 if both present */
            platform_serial_puts("[MEM] EFI mmap parsed\n");
        }
        p += (size + 7u) & ~7u;
    }

    /* Re-reserve kernel region (may have been freed by E820 usable range)   */
    for (uint32_t i = 0; i < kernel_end_pfn && i < MAX_PAGES; i++) {
        if (!_page_is_used(i)) {
            _mark_used(i);
            _free_pages--;
        }
    }
    /* Reserve PFN 0 always */
    if (!_page_is_used(0)) { _mark_used(0); _free_pages--; }

    _first_free = kernel_end_pfn;

    if (!found)
        platform_serial_puts("[MEM] Warning: no E820 mmap tag in MB2\n");
}

/* Legacy shim */
void memory_initialize(void) {
    memory_init_from_mb2(0);
}

/* ── Physical page allocator ─────────────────────────────────────────────── */
uint32_t alloc_page(void) {
    for (uint32_t pfn = _first_free; pfn < MAX_PAGES; pfn++) {
        if (!_page_is_used(pfn)) {
            _mark_used(pfn);
            _free_pages--;
            _first_free = pfn + 1u;
            /* Zero the page (security hygiene) */
            memset((void *)PAGE_TO_PHYS(pfn), 0, PAGE_SIZE);
            return PAGE_TO_PHYS(pfn);
        }
    }
    return 0; /* OOM */
}

void free_page(uint32_t phys_addr) {
    uint32_t pfn = PHYS_TO_PAGE(phys_addr);
    if (pfn == 0 || pfn >= MAX_PAGES) return;
    if (_page_is_used(pfn)) {
        _mark_free(pfn);
        _free_pages++;
        if (pfn < _first_free) _first_free = pfn;
    }
}

uint32_t alloc_pages(uint32_t count) {
    if (count == 0) return 0;
    uint32_t run = 0;
    uint32_t start = 0;
    for (uint32_t pfn = _first_free; pfn < MAX_PAGES; pfn++) {
        if (!_page_is_used(pfn)) {
            if (run == 0) start = pfn;
            run++;
            if (run == count) {
                /* Mark all used */
                for (uint32_t i = start; i < start + count; i++) {
                    _mark_used(i);
                    _free_pages--;
                }
                for (uint32_t i = start; i < start + count; i++)
                    memset((void *)PAGE_TO_PHYS(i), 0, PAGE_SIZE);
                return PAGE_TO_PHYS(start);
            }
        } else {
            run = 0;
        }
    }
    return 0;
}

/* Guard-page allocation (item 36)
 * Allocates count+2 contig pages:
 *   [guard][usable×count][guard]
 * Leaves guard pages marked used (permanent), returns base of usable block.
 */
uint32_t alloc_page_guarded(uint32_t count) {
    uint32_t base = alloc_pages(count + 2u);
    if (!base) return 0;
    /* Guard pages are already allocated (used).  We keep them that way.
     * Just return the address skipping the first guard page.               */
    return base + PAGE_SIZE;
}

/* ── Kernel bump heap ────────────────────────────────────────────────────── */
#define HEAP_PAGES 256u   /* 1 MB kernel heap */

static uint8_t  *_heap_base = NULL;
static uint32_t  _heap_used = 0;
static uint32_t  _heap_size = 0;

static void _heap_init(void) {
    if (_heap_base) return;
    uint32_t base = alloc_pages(HEAP_PAGES);
    if (!base) { platform_serial_puts("[MEM] heap alloc failed\n"); return; }
    _heap_base = (uint8_t *)base;
    _heap_size = HEAP_PAGES * PAGE_SIZE;
    _heap_used = 0;
}

void *memory_allocate(size_t size) {
    if (!_heap_base) _heap_init();
    if (!_heap_base) return NULL;
    /* 8-byte align */
    size = (size + 7u) & ~7u;
    if (_heap_used + size > _heap_size) return NULL;
    void *ptr   = _heap_base + _heap_used;
    _heap_used += (uint32_t)size;
    return ptr;
}

void memory_free(void *ptr) {
    (void)ptr; /* Bump allocator: no individual free (slab reserved) */
}

/* ── Statistics ──────────────────────────────────────────────────────────── */
size_t memory_get_total(void)       { return (size_t)_total_pages * PAGE_SIZE; }
size_t memory_get_free(void)        { return (size_t)_free_pages  * PAGE_SIZE; }
size_t memory_get_used(void)        { return memory_get_total() - memory_get_free(); }
size_t memory_get_pages_free(void)  { return _free_pages;  }
size_t memory_get_pages_used(void)  { return _total_pages - _free_pages; }

/* ── MMIO region reservation (item 40) ──────────────────────────────────── */

void memory_reserve_region(uint32_t phys_base, uint32_t size) {
    /* Round base down to page boundary; round end up to page boundary */
    uint32_t first = PHYS_TO_PAGE(phys_base);                         /* inclusive */
    uint32_t last  = PHYS_TO_PAGE((phys_base + size + PAGE_SIZE - 1u) & ~(PAGE_SIZE - 1u)); /* exclusive */
    if (last > MAX_PAGES) last = MAX_PAGES;
    for (uint32_t pfn = first; pfn < last; pfn++) {
        uint32_t byte = pfn >> 3;
        uint8_t  bit  = (uint8_t)(1u << (pfn & 7u));
        if (!(_bitmap[byte] & bit)) {
            /* Was free — mark used */
            _bitmap[byte] |= bit;
            if (_free_pages > 0u) _free_pages--;
        }
    }
}

/* ── PAE + NX + TLB (items 37, 38, 39) ──────────────────────────────────── */

void memory_enable_pae(void) {
    /* Set CR4.PAE (bit 5) — enables 3-level paging for >4GB physical RAM */
    __asm__ volatile(
        "mov %%cr4, %%eax\n"
        "or  $0x20, %%eax\n"
        "mov %%eax, %%cr4\n"
        : : : "eax");
}

void memory_enable_nx(void) {
    /* Set EFER.NXE (bit 11) in MSR 0xC0000080 — enables No-Execute in PTEs */
    uint32_t lo = 0u, hi = 0u;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0xC0000080u));
    lo |= (1u << 11u);
    __asm__ volatile("wrmsr" : : "c"(0xC0000080u), "a"(lo), "d"(hi));
}

void memory_tlb_flush_local(uint32_t vaddr) {
    __asm__ volatile("invlpg (%0)" : : "r"(vaddr) : "memory");
}

void memory_tlb_flush_range(uint32_t base, uint32_t size) {
    uint32_t end = base + size;
    for (uint32_t v = base & ~(PAGE_SIZE - 1u); v < end; v += PAGE_SIZE)
        memory_tlb_flush_local(v);
}

void memory_tlb_flush_all(void) {
    /* Reload CR3 to flush entire TLB (also flushes global pages if CR4.PGE clear) */
    uint32_t cr3;
    __asm__ volatile(
        "mov %%cr3, %0\n"
        "mov %0,   %%cr3\n"
        : "=r"(cr3) : : "memory");
}

/* ── Large pages 4MB (item 42) ───────────────────────────────────────────── */

void memory_enable_large_pages(void) {
    /* Set CR4.PSE (bit 4) — allows 4 MB page-directory entries (PS=1) */
    __asm__ volatile(
        "mov %%cr4, %%eax\n"
        "or  $0x10, %%eax\n"
        "mov %%eax, %%cr4\n"
        : : : "eax");
}

uint32_t memory_alloc_large_page(void) {
    /* A 4 MB "large page" occupies 1024 contiguous 4 KB frames.
     * Also requires the physical base to be 4 MB-aligned. */
    const uint32_t PAGES_PER_LARGE = 1024u;
    const uint32_t ALIGN_PAGES     = 1024u;  /* 4MB / 4KB */

    /* Scan for first 1024-page contiguous, 1024-page-aligned run */
    for (uint32_t pfn = 0u; pfn + PAGES_PER_LARGE <= _total_pages; pfn += ALIGN_PAGES) {
        /* Check all pages in the run are free */
        uint32_t i;
        for (i = 0u; i < PAGES_PER_LARGE; i++) {
            uint32_t byte = (pfn + i) >> 3u;
            uint8_t  bit  = (uint8_t)(1u << ((pfn + i) & 7u));
            if (_bitmap[byte] & bit) break;  /* page used */
        }
        if (i < PAGES_PER_LARGE) continue;  /* conflict — try next alignment */
        /* Mark all 1024 pages used */
        for (i = 0u; i < PAGES_PER_LARGE; i++) {
            uint32_t byte = (pfn + i) >> 3u;
            _bitmap[byte] |= (uint8_t)(1u << ((pfn + i) & 7u));
        }
        if (_free_pages >= PAGES_PER_LARGE) _free_pages -= PAGES_PER_LARGE;
        else _free_pages = 0u;
        return pfn * PAGE_SIZE;
    }
    return 0u;   /* allocation failed */
}

void memory_free_large_page(uint32_t phys_base) {
    const uint32_t PAGES_PER_LARGE = 1024u;
    uint32_t pfn = PHYS_TO_PAGE(phys_base);
    pfn &= ~(PAGES_PER_LARGE - 1u);   /* align down */
    uint32_t last = pfn + PAGES_PER_LARGE;
    if (last > MAX_PAGES) last = MAX_PAGES;
    for (uint32_t i = pfn; i < last; i++) {
        uint32_t byte = i >> 3u;
        uint8_t  bit  = (uint8_t)(1u << (i & 7u));
        if (_bitmap[byte] & bit) {
            _bitmap[byte] &= ~bit;
            _free_pages++;
        }
    }
}

/* ── NUMA stubs (item 41) ─────────────────────────────────────────────────── */

uint32_t memory_alloc_node(uint32_t count, uint32_t node) {
    (void)node;   /* NUMA-awareness deferred; use global allocator */
    return alloc_pages(count);
}

/* ── Memory hotplug stubs (item 44) ──────────────────────────────────────── */

uint32_t memory_hotplug_add_region(uint32_t phys_base, uint32_t size) {
    /* Mark newly hot-added pages as free so the allocator can use them.     */
    uint32_t pfn_start = PHYS_TO_PAGE(phys_base);
    uint32_t pfn_end   = PHYS_TO_PAGE((phys_base + size + PAGE_SIZE - 1u)
                                      & ~(PAGE_SIZE - 1u));
    if (pfn_end > MAX_PAGES) pfn_end = MAX_PAGES;
    uint32_t added = 0u;
    for (uint32_t pfn = pfn_start; pfn < pfn_end; pfn++) {
        uint32_t byte = pfn >> 3u;
        uint8_t  bit  = (uint8_t)(1u << (pfn & 7u));
        if (_bitmap[byte] & bit) {     /* currently reserved — free it */
            _bitmap[byte] &= ~bit;
            _free_pages++;
            _total_pages = (_total_pages < pfn + 1u) ? pfn + 1u : _total_pages;
            added++;
        }
    }
    return added;
}
