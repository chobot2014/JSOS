/* JSOS sysroot — unistd.h
 * Maps to Phase 6 POSIX syscall numbers in JSOS syscalls.ts.
 */
#ifndef _JSOS_UNISTD_H
#define _JSOS_UNISTD_H

#include <stddef.h>
#include <stdint.h>
#include "sys/types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Syscall numbers (must match SyscallNumber enum in syscalls.ts) */
#define __NR_fork     1
#define __NR_exec     2
#define __NR_exit     3
#define __NR_wait     4
#define __NR_getpid   5
#define __NR_getppid  6
#define __NR_kill     7
#define __NR_brk      8
#define __NR_mmap     9
#define __NR_munmap  10
#define __NR_open    11
#define __NR_close   12
#define __NR_read    13
#define __NR_write   14
#define __NR_lseek   15
#define __NR_stat    16
#define __NR_fstat   17
#define __NR_chdir   18
#define __NR_getcwd  19
#define __NR_mkdir   20
#define __NR_rmdir   21
#define __NR_unlink  23
#define __NR_time    24
#define __NR_uname   26
#define __NR_getuid  27
#define __NR_getgid  28

/* lseek whence values */
#define SEEK_SET  0
#define SEEK_CUR  1
#define SEEK_END  2

/* Access mode bits for open() / access() */
#define R_OK  4
#define W_OK  2
#define X_OK  1
#define F_OK  0

/* Standard file descriptors */
#define STDIN_FILENO   0
#define STDOUT_FILENO  1
#define STDERR_FILENO  2

typedef int    pid_t;
typedef int    uid_t;
typedef int    gid_t;
typedef long   off_t;
typedef long   ssize_t;

/* POSIX syscall stubs — implemented via JSOS int 0x80 */
pid_t  getpid(void);
pid_t  getppid(void);
uid_t  getuid(void);
gid_t  getgid(void);
int    close(int fd);
ssize_t read(int fd, void *buf, size_t count);
ssize_t write(int fd, const void *buf, size_t count);
off_t  lseek(int fd, off_t offset, int whence);
int    unlink(const char *pathname);
int    rmdir(const char *pathname);
int    mkdir(const char *pathname, unsigned mode);
int    chdir(const char *path);
char  *getcwd(char *buf, size_t size);
int    access(const char *pathname, int mode);
void   _exit(int status) __attribute__((noreturn));

/* madvise — no-op on JSOS (no swap/NUMA pressure) */
#define MADV_NORMAL       0
#define MADV_SEQUENTIAL   2
#define MADV_DONTNEED     4
#define MADV_FREE         8
static inline int madvise(void *addr, size_t length, int advice)
    { (void)addr; (void)length; (void)advice; return 0; }

/* setlocale / iconv stub */
#define LC_ALL     6
#define LC_CTYPE   0

/* getpagesize */
static inline int getpagesize(void) { return 4096; }

/* usleep / sleep stubs backed by kernel.sleep */
int    usleep(unsigned long usecs);
unsigned int sleep(unsigned int seconds);

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_UNISTD_H */
