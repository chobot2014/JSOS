/* JSOS sysroot — string.h
 * String and memory functions for Chromium compiled against the JSOS sysroot.
 * Backed by minimal_libc.c (kernel) + additional helpers in libposix.a.
 */
#ifndef _JSOS_STRING_H
#define _JSOS_STRING_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Memory ─────────────────────────────────────────────────────────────── */
void  *memcpy(void * __restrict dst, const void * __restrict src, size_t n);
void  *memmove(void *dst, const void *src, size_t n);
void  *memset(void *s, int c, size_t n);
int    memcmp(const void *s1, const void *s2, size_t n);
void  *memchr(const void *s, int c, size_t n);

/* ── String length ──────────────────────────────────────────────────────── */
size_t strlen(const char *s);
size_t strnlen(const char *s, size_t maxlen);

/* ── String copy / concatenation ────────────────────────────────────────── */
char  *strcpy(char * __restrict dst, const char * __restrict src);
char  *strncpy(char * __restrict dst, const char * __restrict src, size_t n);
char  *strcat(char * __restrict dst, const char * __restrict src);
char  *strncat(char * __restrict dst, const char * __restrict src, size_t n);

/* ── Comparison ─────────────────────────────────────────────────────────── */
int    strcmp(const char *s1, const char *s2);
int    strncmp(const char *s1, const char *s2, size_t n);
int    strcasecmp(const char *s1, const char *s2);
int    strncasecmp(const char *s1, const char *s2, size_t n);
int    strcoll(const char *s1, const char *s2); /* stub: delegates to strcmp */

/* ── Search ─────────────────────────────────────────────────────────────── */
char  *strchr(const char *s, int c);
char  *strrchr(const char *s, int c);
char  *strstr(const char *haystack, const char *needle);
char  *strcasestr(const char *haystack, const char *needle);
char  *strpbrk(const char *s, const char *accept);
size_t strspn(const char *s, const char *accept);
size_t strcspn(const char *s, const char *reject);
char  *strtok(char * __restrict s, const char * __restrict delim);
char  *strtok_r(char * __restrict s, const char * __restrict delim,
                char ** __restrict saveptr);

/* ── Error strings ──────────────────────────────────────────────────────── */
char  *strerror(int errnum);
int    strerror_r(int errnum, char *buf, size_t buflen);

/* ── Miscellaneous ──────────────────────────────────────────────────────── */
size_t strxfrm(char * __restrict dst, const char * __restrict src, size_t n);
char  *strdup(const char *s);
char  *strndup(const char *s, size_t n);

/* GCC/Clang builtins — provided inline for optimisation paths. */
#define bcopy(src, dst, n)   (memmove((dst), (src), (n)))
#define bzero(s, n)          (memset((s), 0, (n)))
#define bcmp(s1, s2, n)      (memcmp((s1), (s2), (n)))

#ifdef __cplusplus
}
#endif
#endif /* _JSOS_STRING_H */
