#ifndef MINIMAL_LIBC_H
#define MINIMAL_LIBC_H

#include <stddef.h>
#include <stdint.h>

// Forward declare va_list for our minimal implementation
typedef char* va_list;

// Memory functions
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
int memcmp(const void *s1, const void *s2, size_t n);

// String functions
int strcmp(const char *s1, const char *s2);
int strncmp(const char *s1, const char *s2, size_t n);

// Math functions (simplified implementations)
double fabs(double x);
double floor(double x);
double ceil(double x);
double fmod(double x, double y);
double sqrt(double x);
double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan(double x);
double atan2(double y, double x);
double exp(double x);
double log(double x);
double log10(double x);
double log2(double x);
double pow(double x, double y);
double cbrt(double x);
double trunc(double x);

// Memory allocation (simplified)
void *malloc(size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);

// I/O functions (stubbed for freestanding)
int sprintf(char *str, const char *format, ...);
int snprintf(char *str, size_t size, const char *format, ...);
int vsnprintf(char *str, size_t size, const char *format, va_list ap);

// Time functions (stubbed)
int gettimeofday(void *tv, void *tz);

// Other functions
void abort(void);

#endif // MINIMAL_LIBC_H
