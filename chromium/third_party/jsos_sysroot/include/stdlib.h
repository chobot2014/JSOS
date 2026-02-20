/* JSOS sysroot — stdlib.h
 * Standard library stubs for Chromium compiled against the JSOS sysroot.
 * malloc/free delegate to the Phase 4 VMM brk allocator (vmm.ts → PhysAlloc).
 * All functions are backed by the JSOS POSIX layer (libposix.a).
 */
#ifndef _JSOS_STDLIB_H
#define _JSOS_STDLIB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Memory allocation — backed by vmm.brk (Phase 4). */
void *malloc(size_t size);
void *calloc(size_t nmemb, size_t size);
void *realloc(void *ptr, size_t size);
void  free(void *ptr);

/* Aligned allocation (C11 / POSIX). */
void *aligned_alloc(size_t alignment, size_t size);
int   posix_memalign(void **memptr, size_t alignment, size_t size);

/* Process control — delegated to JSOS init system. */
void  _Noreturn exit(int status);
void  _Noreturn abort(void);
int   atexit(void (*func)(void));

/* Environment — stubbed (JSOS has no traditional environment). */
char *getenv(const char *name);
int   setenv(const char *name, const char *value, int overwrite);
int   unsetenv(const char *name);

/* Integer conversion. */
int            atoi(const char *nptr);
long           atol(const char *nptr);
long long      atoll(const char *nptr);
long           strtol(const char *nptr, char **endptr, int base);
long long      strtoll(const char *nptr, char **endptr, int base);
unsigned long  strtoul(const char *nptr, char **endptr, int base);
unsigned long long strtoull(const char *nptr, char **endptr, int base);
double         strtod(const char *nptr, char **endptr);

/* Sorting and searching. */
void  qsort(void *base, size_t nmemb, size_t size,
            int (*compar)(const void *, const void *));
void *bsearch(const void *key, const void *base, size_t nmemb, size_t size,
              int (*compar)(const void *, const void *));

/* Pseudo-random numbers — simple LCG. */
int   rand(void);
void  srand(unsigned int seed);
#define RAND_MAX  2147483647

/* Absolute value helpers. */
int       abs(int j);
long      labs(long j);
long long llabs(long long j);

/* Misc. */
int system(const char *command);  /* always returns -1 on JSOS */

#ifdef __cplusplus
}
#endif
#endif /* _JSOS_STDLIB_H */
