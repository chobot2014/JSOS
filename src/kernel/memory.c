#include <stddef.h>
#include <stdint.h>

// Simple memory management for kernel
static uint8_t memory_pool[1024 * 1024]; // 1MB memory pool
static size_t memory_used = 0;
static const size_t memory_total = sizeof(memory_pool);

void memory_initialize(void) {
    memory_used = 0;
    // Clear memory pool
    for (size_t i = 0; i < memory_total; i++) {
        memory_pool[i] = 0;
    }
}

void* memory_allocate(size_t size) {
    if (memory_used + size > memory_total) {
        return NULL; // Out of memory
    }
    
    void* ptr = &memory_pool[memory_used];
    memory_used += size;
    return ptr;
}

size_t memory_get_total(void) {
    return memory_total;
}

size_t memory_get_used(void) {
    return memory_used;
}

size_t memory_get_free(void) {
    return memory_total - memory_used;
}
