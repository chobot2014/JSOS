/*
 * Kernel Symbol Table Stub  (item 104)
 *
 * Provides address-to-name lookup for panic backtraces.
 * Symbols are embedded by the build system (embed-js.js passes
 * a .nm-style symbol table via a generated symbol_table[] array).
 *
 * Alternatively: `nm --defined-only kernel.elf` output gets embedded
 * as a sorted array of (address, name) pairs.
 */
#ifndef SYMTAB_H
#define SYMTAB_H

#include <stdint.h>

typedef struct {
    uint32_t    address;
    const char *name;
} ksym_entry_t;

/**
 * Initialise the symbol table.  sym_array must point to a sorted array of
 * ksym_entry_t terminated by an entry with address=0 and name=NULL.
 * Pass NULL to disable symbol lookup (all lookups return "<unknown>").
 */
void symtab_init(const ksym_entry_t *sym_array, uint32_t count);

/**
 * Look up the nearest symbol at or before `addr`.
 * Returns the symbol name string, or "<unknown>" if not found.
 * *offset is set to (addr - symbol_base) if non-NULL.
 */
const char *symtab_lookup(uint32_t addr, uint32_t *offset);

#endif /* SYMTAB_H */
