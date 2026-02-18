#include "minimal_libc.h"
#include "memory.h"
#include "platform.h"

// Simplified va_list for our minimal implementation
typedef char* va_list;
#define va_start(ap, last) ((ap) = (char*)(&(last)) + sizeof(last))
#define va_arg(ap, type) (*(type*)((ap) += sizeof(type), (ap) - sizeof(type)))
#define va_end(ap) ((ap) = 0)

// Memory functions
void *memcpy(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char*)dest;
    const unsigned char *s = (const unsigned char*)src;
    for (size_t i = 0; i < n; i++) {
        d[i] = s[i];
    }
    return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char*)dest;
    const unsigned char *s = (const unsigned char*)src;
    
    if (d < s) {
        for (size_t i = 0; i < n; i++) {
            d[i] = s[i];
        }
    } else {
        for (size_t i = n; i > 0; i--) {
            d[i-1] = s[i-1];
        }
    }
    return dest;
}

void *memset(void *s, int c, size_t n) {
    unsigned char *p = (unsigned char*)s;
    for (size_t i = 0; i < n; i++) {
        p[i] = (unsigned char)c;
    }
    return s;
}

int memcmp(const void *s1, const void *s2, size_t n) {
    const unsigned char *p1 = (const unsigned char*)s1;
    const unsigned char *p2 = (const unsigned char*)s2;
    for (size_t i = 0; i < n; i++) {
        if (p1[i] != p2[i]) {
            return p1[i] - p2[i];
        }
    }
    return 0;
}

// String functions
int strcmp(const char *s1, const char *s2) {
    while (*s1 && (*s1 == *s2)) {
        s1++;
        s2++;
    }
    return (unsigned char)*s1 - (unsigned char)*s2;
}

int strncmp(const char *s1, const char *s2, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s1[i] != s2[i] || s1[i] == '\0') {
            return (unsigned char)s1[i] - (unsigned char)s2[i];
        }
    }
    return 0;
}

// Simple math implementations (not IEEE 754 compliant, but functional)
double fabs(double x) {
    return x < 0 ? -x : x;
}

double floor(double x) {
    // Simple implementation - not accurate for all cases
    int i = (int)x;
    return (x < 0 && x != i) ? i - 1 : i;
}

double ceil(double x) {
    int i = (int)x;
    return (x > 0 && x != i) ? i + 1 : i;
}

double fmod(double x, double y) {
    // Simple implementation
    if (y == 0) return 0;
    return x - floor(x/y) * y;
}

// Simplified math functions - these are stubs that return reasonable defaults
double sqrt(double x) {
    if (x <= 0) return 0;
    // Newton's method approximation
    double guess = x / 2;
    for (int i = 0; i < 10; i++) {
        guess = (guess + x/guess) / 2;
    }
    return guess;
}

double sin(double x) { return x - (x*x*x)/6; } // First-order approximation
double cos(double x) { return 1 - (x*x)/2; }   // First-order approximation
double tan(double x) { return sin(x)/cos(x); }
double asin(double x) { return x; }             // Simplified
double acos(double x) { return 1.57 - x; }     // Simplified
double atan(double x) { return x; }             // Simplified
double atan2(double y, double x) { return y/x; } // Simplified
double exp(double x) { return 1 + x; }          // Very simplified
double log(double x) { return x - 1; }          // Very simplified
double log10(double x) { return log(x) / 2.3; } // Simplified
double log2(double x) { return log(x) / 0.69; } // Simplified
double pow(double x, double y) {                 // Simplified
    if (y == 0) return 1;
    if (y == 1) return x;
    return x * x; // Just square for simplicity
}
double cbrt(double x) { return sqrt(sqrt(sqrt(x))); } // Approximation
double trunc(double x) { return (int)x; }

// Memory allocation - using our kernel memory manager
static char heap[0x100000]; // 1MB heap
static size_t heap_pos = 0;

void *malloc(size_t size) {
    if (heap_pos + size >= sizeof(heap)) {
        return NULL; // Out of memory
    }
    void *ptr = &heap[heap_pos];
    heap_pos += size;
    return ptr;
}

void *realloc(void *ptr, size_t size) {
    // Simple implementation - just allocate new memory
    void *new_ptr = malloc(size);
    if (new_ptr && ptr) {
        memcpy(new_ptr, ptr, size); // Note: this may copy too much, but it's safe
    }
    return new_ptr;
}

void free(void *ptr) {
    // No-op for now - we don't implement proper free
    (void)ptr;
}

// I/O functions (simplified for kernel environment)
int sprintf(char *str, const char *format, ...) {
    // Very simple implementation - just copy format string for now
    int i = 0;
    while (format[i] && i < 1000) {
        str[i] = format[i];
        i++;
    }
    str[i] = '\0';
    return i;
}

int snprintf(char *str, size_t size, const char *format, ...) {
    if (size == 0) return 0;
    int i = 0;
    while (format[i] && i < (int)(size - 1)) {
        str[i] = format[i];
        i++;
    }
    str[i] = '\0';
    return i;
}

int vsnprintf(char *str, size_t size, const char *format, va_list ap) {
    // Very simplified - just copy the format string
    return snprintf(str, size, format);
}

// Time functions (stubbed - return fixed values)
int gettimeofday(void *tv, void *tz) {
    (void)tv; (void)tz;
    return 0; // Success
}

// Stubbed functions for time/locale
void *localtime_r(const void *timer, void *result) {
    (void)timer; (void)result;
    return NULL;
}

void *gmtime_r(const void *timer, void *result) {
    (void)timer; (void)result;
    return NULL;
}

long mktime(void *tm) {
    (void)tm;
    return 0;
}

double difftime(long time1, long time0) {
    return (double)(time1 - time0);
}

char *strptime(const char *s, const char *format, void *tm) {
    (void)s; (void)format; (void)tm;
    return NULL;
}

size_t strftime(char *s, size_t max, const char *format, const void *tm) {
    (void)s; (void)max; (void)format; (void)tm;
    return 0;
}

int __isoc99_sscanf(const char *str, const char *format, ...) {
    (void)str; (void)format;
    return 0;
}

// setjmp/longjmp - very simplified (dangerous but functional for demo)
typedef struct {
    uint32_t esp;
    uint32_t ebp;
    uint32_t eip;
} jmp_buf[1];

int _setjmp(jmp_buf env) {
    // Very simplified setjmp - not fully functional but compiles
    (void)env;
    return 0;
}

void longjmp(jmp_buf env, int val) {
    // Very simplified longjmp - just panic for now
    (void)env; (void)val;
    platform_boot_print("longjmp called - system halt\n");
    for(;;); // Infinite loop instead of hlt
}

void abort(void) {
    platform_boot_print("abort() called - system halt\n");
    for(;;); // Infinite loop instead of hlt
}
