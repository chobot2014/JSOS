/*
 * Kernel Symbol Table (item 104)
 */
#include "symtab.h"
#include <stddef.h>

static const ksym_entry_t *_syms  = NULL;
static uint32_t             _count = 0;

void symtab_init(const ksym_entry_t *sym_array, uint32_t count) {
    _syms  = sym_array;
    _count = count;
}

const char *symtab_lookup(uint32_t addr, uint32_t *offset) {
    if (!_syms || _count == 0) {
        if (offset) *offset = 0;
        return "<unknown>";
    }

    /* Binary search for the largest symbol address <= addr */
    uint32_t lo = 0, hi = _count;
    while (lo + 1 < hi) {
        uint32_t mid = (lo + hi) / 2u;
        if (_syms[mid].address <= addr) lo = mid;
        else                             hi = mid;
    }

    if (_syms[lo].address > addr) {
        if (offset) *offset = 0;
        return "<unknown>";
    }

    if (offset) *offset = addr - _syms[lo].address;
    return _syms[lo].name ? _syms[lo].name : "<null>";
}
