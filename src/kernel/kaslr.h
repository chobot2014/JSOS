/*
 * KASLR Stub  (item 109)
 *
 * On JSOS x86-32 the kernel is loaded at a fixed physical address by GRUB.
 * Full ASLR requires a two-stage bootloader to place the kernel at a random
 * base, which is out of scope for Phase 1.
 *
 * This stub records the actual load address from the linker symbols so that
 * future debuggers / relocation tools can query it.
 */
#ifndef KASLR_H
#define KASLR_H

#include <stdint.h>

/** Returns the physical load address of the kernel (from linker _start). */
uint32_t kaslr_kernel_base(void);

/** Returns a seeded random offset that WOULD be used if KASLR were active.
 *  Seeded from TSC at boot.  For informational/audit purposes only in v1.  */
uint32_t kaslr_random_offset(void);

#endif /* KASLR_H */
