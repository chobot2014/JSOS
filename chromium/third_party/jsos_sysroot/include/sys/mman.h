/* JSOS sysroot — sys/mman.h
 * Virtual memory mapping — backed by Phase 6 mmap/munmap syscalls.
 */
#ifndef _JSOS_SYS_MMAN_H
#define _JSOS_SYS_MMAN_H

#include "types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* mmap prot flags */
#define PROT_NONE   0x00
#define PROT_READ   0x01
#define PROT_WRITE  0x02
#define PROT_EXEC   0x04

/* mmap flags */
#define MAP_SHARED      0x001
#define MAP_PRIVATE     0x002
#define MAP_ANONYMOUS   0x020
#define MAP_ANON        MAP_ANONYMOUS
#define MAP_FIXED       0x010
#define MAP_NORESERVE   0x040
#define MAP_POPULATE    0x080
#define MAP_HUGETLB     0x040000
#define MAP_FAILED      ((void *)-1)

/* madvise advice values (no-op on JSOS) */
#define MADV_NORMAL       0
#define MADV_SEQUENTIAL   2
#define MADV_RANDOM       1
#define MADV_WILLNEED     3
#define MADV_DONTNEED     4
#define MADV_FREE         8
#define MADV_HUGEPAGE    14
#define MADV_NOHUGEPAGE  15

/* msync flags */
#define MS_ASYNC      1
#define MS_SYNC       4
#define MS_INVALIDATE 2

/* mprotect flags — same as PROT_* */
#define MLOCK_ONFAULT 1

void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset);
int   munmap(void *addr, size_t length);
int   mprotect(void *addr, size_t len, int prot);
static inline int madvise(void *addr, size_t length, int advice)
    { (void)addr; (void)length; (void)advice; return 0; }
static inline int msync(void *addr, size_t length, int flags)
    { (void)addr; (void)length; (void)flags; return 0; }
static inline int mlock(const void *addr, size_t len)
    { (void)addr; (void)len; return 0; }
static inline int munlock(const void *addr, size_t len)
    { (void)addr; (void)len; return 0; }

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_SYS_MMAN_H */
