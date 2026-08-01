#ifndef MEMORY_H
#define MEMORY_H

/* JSOS Physical Memory Manager  (items 10, 33, 34, 36)
 *
 * Two-layer allocator:
 *   Layer 1 — Physical Page Allocator
 *             4KB pages, bitmap-based.
 *             Populated from Multiboot2 memory-map tag (E820).
 *   Layer 2 — Kernel Heap Bump Allocator
 *             memory_allocate() / memory_free() for sub-page kernel objects.
 *
 * Guard pages: page_alloc_guard() marks flanking pages reserved; they are
 * never handed out and cause an instant page-fault if touched.
 */

#include <stddef.h>
#include <stdint.h>

/* ── Page size ────────────────────────────────────────────────────────────── */
#define PAGE_SIZE      4096u
#define PAGE_SHIFT     12u
#define PHYS_TO_PAGE(a) ((uint32_t)(a) >> PAGE_SHIFT)
#define PAGE_TO_PHYS(p) ((uint32_t)(p) << PAGE_SHIFT)

/* Maximum tracked physical address (512 MB) */
#define MAX_PHYS_MEM   (512u * 1024u * 1024u)
#define MAX_PAGES      (MAX_PHYS_MEM / PAGE_SIZE)   /* 131072 pages          */

/* ── E820 memory-region types (MB2 type-6 tag) ──────────────────────────── */
typedef struct {
    uint64_t base_addr;
    uint64_t length;
    uint32_t type;      /* 1=usable, 2=reserved, 3=ACPI reclaim, 4=ACPI NVS,
                         * 5=bad, anything else = reserved                   */
    uint32_t acpi_ext;
} __attribute__((packed)) e820_entry_t;

/* ── Page-bitmap functions ──────────────────────────────────────────────── */
/* Primary init — parses MB2 memory-map tag and populates free bitmap.
 * Must be called before any alloc_page().                                   */
void memory_init_from_mb2(uint32_t mb2_info_addr);

/* Legacy shim (called by old kernel.c).  Falls back to a 4 MB flat region. */
void memory_initialize(void);

/* Allocate/free a single 4 KB physical page.
 * alloc_page() returns physical address or 0 on OOM.
 * free_page()  marks page available again.                                  */
uint32_t alloc_page(void);
void     free_page(uint32_t phys_addr);

/* Allocate N *contiguous* 4 KB pages.  Returns physical base or 0.         */
uint32_t alloc_pages(uint32_t count);

/* Guard-page allocation: allocates (count+2) pages, marks first and last
 * as permanently reserved (guard), returns address of first usable page.   */
uint32_t alloc_page_guarded(uint32_t count);

/* ── Kernel heap ────────────────────────────────────────────────────────── */
/* Simple bump allocator for small kernel objects; backed by physical pages. */
void  *memory_allocate(size_t size);
void   memory_free(void *ptr);     /* no-op in bump mode; reserved for slab */

/* ── Statistics ─────────────────────────────────────────────────────────── */
size_t memory_get_total(void);
size_t memory_get_used(void);
size_t memory_get_free(void);
size_t memory_get_pages_free(void);
size_t memory_get_pages_used(void);

/* Reserve a physical memory region as permanently in-use (item 40).
 * Marks every 4 KB page that overlaps [phys_base, phys_base+size) as
 * reserved so the allocator never hands them out.
 * Use for MMIO regions: framebuffer, LAPIC, IOAPIC, VirtIO MMIO, etc. */
void memory_reserve_region(uint32_t phys_base, uint32_t size);

/* ── Paging extensions ──────────────────────────────────────────────────── */

/* item 37: Enable PAE mode (CR4.PAE = 1) for >4 GB physical RAM support */
void memory_enable_pae(void);

/* item 38: Enable No-Execute (NX) bit via EFER MSR (EFER.NXE = 1) */
void memory_enable_nx(void);

/* item 39: TLB shootdown — flush vaddr on this CPU (INVLPG) */
void memory_tlb_flush_local(uint32_t vaddr);

/* Range flush: calls memory_tlb_flush_local for every page in [base, base+size) */
void memory_tlb_flush_range(uint32_t base, uint32_t size);

/* Reload CR3 to flush entire TLB */
void memory_tlb_flush_all(void);

/* ── Large pages (item 42) ───────────────────────────────────────────────── */
/* Allocate 1024 contiguous 4 KB pages (= one 4 MB large page frame).
 * Returns physical address; 0 on failure.  Caller must set CR4.PSE and the
 * PS bit in the page-directory entry to map it as a 4 MB page. */
uint32_t memory_alloc_large_page(void);
void     memory_free_large_page(uint32_t phys_base);   /* returns 1024 frames */

/* ── NUMA stubs (item 41) ────────────────────────────────────────────────── */
/* node is ignored on non-NUMA systems — falls back to alloc_pages() */
uint32_t memory_alloc_node(uint32_t count, uint32_t node);

/* ── CR4 large-page enable (item 42) ─────────────────────────────────────── */
void memory_enable_large_pages(void);   /* sets CR4.PSE (bit 4) */

/* ── Memory hotplug stubs (item 44) ─────────────────────────────────────── */
/* Mark a newly added physical memory range as available.  Returns count of
 * pages added.  Actual ACPI hot-add notifications handled in TypeScript. */
uint32_t memory_hotplug_add_region(uint32_t phys_base, uint32_t size);

#endif /* MEMORY_H */
