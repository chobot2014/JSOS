/*
 * KASLR Stub (item 109)
 */
#include "kaslr.h"
#include <stdint.h>

/* Linker exports the kernel load address as _start */
extern void _start(void);

static uint32_t _rand_offset = 0;
static int      _seeded = 0;

uint32_t kaslr_kernel_base(void) {
    return (uint32_t)(uintptr_t)_start;
}

uint32_t kaslr_random_offset(void) {
    if (!_seeded) {
        /* Seed with TSC low word XOR stack guard */
        uint32_t tsc_lo;
        __asm__ volatile("rdtsc" : "=a"(tsc_lo) :: "edx");
        extern uint32_t __stack_chk_guard;
        _rand_offset = (tsc_lo ^ __stack_chk_guard) & 0xFFF00000u; /* 1MB-aligned */
        _seeded = 1;
    }
    return _rand_offset;
}
