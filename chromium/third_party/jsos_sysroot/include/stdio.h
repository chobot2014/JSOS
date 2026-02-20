/* JSOS sysroot — stdio.h
 * Minimal stdio for Chromium compiled against the JSOS sysroot.
 * fprintf(stderr, ...) writes to the serial port (fd 2 → COM1 log).
 * FILE* I/O above that maps to JSOS VFS file descriptors.
 */
#ifndef _JSOS_STDIO_H
#define _JSOS_STDIO_H

#include <stdarg.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque FILE type — JSOS uses integer file descriptors internally. */
typedef struct _JSOS_FILE {
    int   fd;
    int   flags;
    char *buf;
    int   buflen;
    int   pos;
} FILE;

/* Standard streams backed by JSOS VFS fds 0/1/2. */
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;

#define STDIN_FILENO  0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2

/* Seek constants. */
#define SEEK_SET  0
#define SEEK_CUR  1
#define SEEK_END  2

/* End-of-file / error sentinels. */
#define EOF  (-1)

/* Formatted output. */
int printf(const char * __restrict fmt, ...);
int fprintf(FILE * __restrict stream, const char * __restrict fmt, ...);
int sprintf(char * __restrict str, const char * __restrict fmt, ...);
int snprintf(char * __restrict str, size_t size,
             const char * __restrict fmt, ...);
int vprintf(const char * __restrict fmt, va_list ap);
int vfprintf(FILE * __restrict stream,
             const char * __restrict fmt, va_list ap);
int vsprintf(char * __restrict str,
             const char * __restrict fmt, va_list ap);
int vsnprintf(char * __restrict str, size_t size,
              const char * __restrict fmt, va_list ap);

/* Formatted input. */
int scanf(const char * __restrict fmt, ...);
int fscanf(FILE * __restrict stream, const char * __restrict fmt, ...);
int sscanf(const char * __restrict str, const char * __restrict fmt, ...);

/* Character I/O. */
int  fputc(int c, FILE *stream);
int  fputs(const char *s, FILE *stream);
int  fgetc(FILE *stream);
char *fgets(char *s, int n, FILE *stream);
int  putchar(int c);
int  puts(const char *s);
int  getchar(void);

/* File operations (backed by JSOS VFS). */
FILE *fopen(const char * __restrict path, const char * __restrict mode);
FILE *fdopen(int fd, const char *mode);
int   fclose(FILE *stream);
int   fflush(FILE *stream);
size_t fread(void * __restrict ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void * __restrict ptr, size_t size, size_t nmemb,
              FILE *stream);
int   fseek(FILE *stream, long offset, int whence);
long  ftell(FILE *stream);
void  rewind(FILE *stream);
int   feof(FILE *stream);
int   ferror(FILE *stream);
void  clearerr(FILE *stream);

/* Error printing. */
void  perror(const char *s);

/* Temporary files — JSOS maps these to /tmp/ on the VFS. */
FILE *tmpfile(void);
char *tmpnam(char *s);

/* Misc. */
int   remove(const char *path);
int   rename(const char *old, const char *newpath);

#ifdef __cplusplus
}
#endif
#endif /* _JSOS_STDIO_H */
