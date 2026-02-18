#include <sys/stat.h>
#include <sys/types.h>
#include <sys/fcntl.h>
#include <sys/times.h>
#include <sys/errno.h>
#include <sys/time.h>
#include <stdio.h>
#include <unistd.h>
#include <stddef.h>
#include "platform.h"

#undef errno
extern int errno;

// Environment variables
char *__env[1] = { 0 };
char **environ = __env;

// System call stubs for newlib
void _exit(int status) {
    (void)status;
    platform_boot_print("System exit called\n");
    for(;;);
}

int _close(int file) {
    (void)file;
    return -1;
}

int _execve(char *name, char **argv, char **env) {
    (void)name; (void)argv; (void)env;
    errno = ENOMEM;
    return -1;
}

int _fork() {
    errno = EAGAIN;
    return -1;
}

int _fstat(int file, struct stat *st) {
    (void)file;
    st->st_mode = S_IFCHR;
    return 0;
}

int _getpid() {
    return 1;
}

int _isatty(int file) {
    return (file == 0 || file == 1 || file == 2);
}

int _kill(int pid, int sig) {
    (void)pid; (void)sig;
    errno = EINVAL;
    return -1;
}

int _link(char *old, char *new) {
    (void)old; (void)new;
    errno = EMLINK;
    return -1;
}

int _lseek(int file, int ptr, int dir) {
    (void)file; (void)ptr; (void)dir;
    return 0;
}

int _open(const char *name, int flags, ...) {
    (void)name; (void)flags;
    return -1;
}

int _read(int file, char *ptr, int len) {
    (void)file; (void)ptr; (void)len;
    return 0;
}

caddr_t _sbrk(int incr) {
    // Simple heap management
    extern char _heap_start;
    static char *heap_end = NULL;
    char *prev_heap_end;
    
    if (heap_end == NULL) {
        heap_end = &_heap_start;
    }
    
    prev_heap_end = heap_end;
    heap_end += incr;
    
    return (caddr_t)prev_heap_end;
}

int _stat(const char *filepath, struct stat *st) {
    (void)filepath;
    st->st_mode = S_IFCHR;
    return 0;
}

clock_t _times(struct tms *buf) {
    (void)buf;
    return -1;
}

int _unlink(char *name) {
    (void)name;
    errno = ENOENT;
    return -1;
}

int _wait(int *status) {
    (void)status;
    errno = ECHILD;
    return -1;
}

int _write(int file, char *ptr, int len) {
    if (file == 1 || file == 2) { // stdout or stderr
        char buf[2] = { 0, 0 };
        for (int i = 0; i < len; i++) { buf[0] = ptr[i]; platform_boot_print(buf); }
        return len;
    }
    return -1;
}

// Time functions
int _gettimeofday(struct timeval *tv, struct timezone *tz) {
    (void)tz;
    if (tv) {
        tv->tv_sec = 0;
        tv->tv_usec = 0;
    }
    return 0;
}

// Non-underscore versions required by newlib
int gettimeofday(struct timeval *tv, void *tz) {
    return _gettimeofday(tv, (struct timezone *)tz);
}

int kill(int pid, int sig) {
    return _kill(pid, sig);
}

int getpid(void) {
    return _getpid();
}

void *sbrk(ptrdiff_t incr) {
    return _sbrk(incr);
}

int write(int fd, const void *buf, size_t count) {
    return _write(fd, (char *)buf, count);
}

int close(int fd) {
    return _close(fd);
}

off_t lseek(int fd, off_t offset, int whence) {
    return _lseek(fd, offset, whence);
}

int read(int fd, void *buf, size_t count) {
    return _read(fd, (char *)buf, count);
}

int fstat(int fd, struct stat *st) {
    return _fstat(fd, st);
}

int isatty(int fd) {
    return _isatty(fd);
}

// Init/fini functions required by newlib
void _init(void) {
    // Initialization code (empty for now)
}

void _fini(void) {
    // Finalization code (empty for now)
}
