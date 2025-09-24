#ifndef MEMORY_H
#define MEMORY_H

#include <stddef.h>

void memory_initialize(void);
void* memory_allocate(size_t size);
size_t memory_get_total(void);
size_t memory_get_used(void);
size_t memory_get_free(void);

#endif
