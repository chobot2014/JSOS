/*
 * posix_ring3.c — Ring-3 POSIX syscall wrappers for JSOS  (Phase 6 / 9)
 *
 * This file is compiled into libposix.a and linked with Chromium (ring-3).
 * Each function issues an `int $0x80` instruction; the JSOS kernel routes
 * the call through syscall_dispatch() in irq.c (ring-0).
 *
 * Calling convention (i686 cdecl syscall gate):
 *   EAX = syscall number
 *   EBX = arg1, ECX = arg2, EDX = arg3, ESI = arg4, EDI = arg5
 *   Return: EAX = result  (negative = -errno)
 *
 * Syscall numbers must match the values dispatched in irq.c.
 */

#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>

/* Syscall numbers — must match irq.c syscall_dispatch() switch cases */
#define NR_EXIT        3
#define NR_GETPID      5
#define NR_GETPPID     6
#define NR_KILL        7
#define NR_BRK         8
#define NR_MMAP        9
#define NR_MUNMAP     10
#define NR_OPEN       11
#define NR_CLOSE      12
#define NR_READ       13
#define NR_WRITE      14
#define NR_LSEEK      15
#define NR_STAT       16
#define NR_FSTAT      17
#define NR_CHDIR      18
#define NR_GETCWD     19
#define NR_MKDIR      20
#define NR_RMDIR      21
#define NR_UNLINK     23
#define NR_TIME       24
#define NR_GETUID     27
#define NR_GETGID     28
#define NR_MPROTECT   29
#define NR_SOCKET     30
#define NR_CONNECT    31
#define NR_ACCEPT     32
#define NR_BIND       33
#define NR_LISTEN     34
#define NR_SEND       35
#define NR_RECV       36
#define NR_SETSOCKOPT 37
#define NR_GETSOCKOPT 38
#define NR_EPOLL_CREATE 39
#define NR_EPOLL_CTL    40
#define NR_EPOLL_WAIT   41
#define NR_FCNTL        42
#define NR_IOCTL        43
#define NR_FORK         44  /* stub: returns -EAGAIN on JSOS */
#define NR_EXECVE       45
#define NR_WAITPID      46
#define NR_PIPE         47
#define NR_DUP2         48
#define NR_CLOCK_GETTIME 49
#define NR_NANOSLEEP    50 /* NB: not 0x50 — that is JSOS_SYS_KEY_READ */
#define NR_PTHREAD_CREATE 51
#define NR_PTHREAD_JOIN   52
#define NR_MUTEX_LOCK     53
#define NR_MUTEX_UNLOCK   54
#define NR_MUTEX_CREATE   55
#define NR_MUTEX_DESTROY  56
#define NR_CONDVAR_WAIT   57
#define NR_CONDVAR_SIGNAL 58
#define NR_THREAD_SELF    59
#define NR_USLEEP         60
#define NR_SCHED_YIELD    61
#define NR_OPENDIR        62
#define NR_READDIR        63
#define NR_CLOSEDIR       64
#define NR_SCANDIR        65
#define NR_GETTIMEOFDAY   66
#define NR_SIGACTION      67
#define NR_PTHREAD_SIGMASK 68
#define NR_PREAD          69
#define NR_PWRITE         70
#define NR_SENDTO         71
#define NR_RECVFROM       72
#define NR_GETPEERNAME    73
#define NR_GETSOCKNAME    74
#define NR_SHUTDOWN       75
#define NR_SOCKETPAIR     76

/* errno storage (thread-local would be ideal; global is fine for Phase 9) */
int errno = 0;

/* ── Inline syscall helpers ─────────────────────────────────────────────── */

static inline int __syscall0(int num) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num) : "memory");
    return r;
}
static inline int __syscall1(int num, int a) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a) : "memory");
    return r;
}
static inline int __syscall2(int num, int a, int b) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a), "c"(b) : "memory");
    return r;
}
static inline int __syscall3(int num, int a, int b, int c) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a), "c"(b), "d"(c) : "memory");
    return r;
}
static inline int __syscall4(int num, int a, int b, int c, int d) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a), "c"(b), "d"(c), "S"(d) : "memory");
    return r;
}
static inline int __syscall5(int num, int a, int b, int c, int d, int e) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a), "c"(b), "d"(c), "S"(d), "D"(e) : "memory");
    return r;
}

/* Set errno from a negative return value and return the POSIX -1/-result. */
static inline int __retval(int r) {
    if (r < 0) { errno = -r; return -1; }
    return r;
}
static inline void* __retptr(int r) {
    if (r < 0) { errno = -r; return (void*)0; }
    return (void*)(uintptr_t)(unsigned)r;
}

/* ── Process / ID ─────────────────────────────────────────────────────── */

int getpid(void)  { return __syscall0(NR_GETPID); }
int getppid(void) { return __syscall0(NR_GETPPID); }
int getuid(void)  { return __syscall0(NR_GETUID); }
int getgid(void)  { return __syscall0(NR_GETGID); }
int geteuid(void) { return 0; }  /* root on JSOS */
int getegid(void) { return 0; }

void _exit(int status) {
    __syscall1(NR_EXIT, status);
    for(;;) __asm__ volatile("hlt");
}

int fork(void) {
    return __retval(__syscall0(NR_FORK));
}

int execve(const char *path, char * const argv[], char * const envp[]) {
    return __retval(__syscall3(NR_EXECVE, (int)path, (int)argv, (int)envp));
}

int waitpid(int pid, int *status, int options) {
    return __retval(__syscall3(NR_WAITPID, pid, (int)status, options));
}

int kill(int pid, int sig) {
    return __retval(__syscall2(NR_KILL, pid, sig));
}

/* ── File I/O ─────────────────────────────────────────────────────────── */

int open(const char *path, int flags, ...) {
    int mode = 0;
    if ((flags & 0x40) || (flags & 0x200)) {  /* O_CREAT */
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, int);
        va_end(ap);
    }
    return __retval(__syscall3(NR_OPEN, (int)path, flags, mode));
}

int close(int fd) {
    return __retval(__syscall1(NR_CLOSE, fd));
}

long read(int fd, void *buf, size_t count) {
    return __retval(__syscall3(NR_READ, fd, (int)buf, (int)count));
}

long write(int fd, const void *buf, size_t count) {
    return __retval(__syscall3(NR_WRITE, fd, (int)buf, (int)count));
}

long lseek(int fd, long offset, int whence) {
    return __retval(__syscall3(NR_LSEEK, fd, (int)offset, whence));
}

long pread(int fd, void *buf, size_t count, long offset) {
    return __retval(__syscall4(NR_PREAD, fd, (int)buf, (int)count, (int)offset));
}

long pwrite(int fd, const void *buf, size_t count, long offset) {
    return __retval(__syscall4(NR_PWRITE, fd, (int)buf, (int)count, (int)offset));
}

int stat(const char *path, void *statbuf) {
    return __retval(__syscall2(NR_STAT, (int)path, (int)statbuf));
}

int fstat(int fd, void *statbuf) {
    return __retval(__syscall2(NR_FSTAT, fd, (int)statbuf));
}

int lstat(const char *path, void *statbuf) {
    return stat(path, statbuf);  /* no symlinks on JSOS */
}

int unlink(const char *path) {
    return __retval(__syscall1(NR_UNLINK, (int)path));
}

int rmdir(const char *path) {
    return __retval(__syscall1(NR_RMDIR, (int)path));
}

int mkdir(const char *path, unsigned mode) {
    return __retval(__syscall2(NR_MKDIR, (int)path, (int)mode));
}

int rename(const char *old, const char *new_) {
    (void)old; (void)new_;
    errno = 22; /* EINVAL — TODO */
    return -1;
}

int chdir(const char *path) {
    return __retval(__syscall1(NR_CHDIR, (int)path));
}

char *getcwd(char *buf, size_t size) {
    int r = __syscall2(NR_GETCWD, (int)buf, (int)size);
    if (r < 0) { errno = -r; return (char*)0; }
    return buf;
}

int access(const char *path, int mode) {
    (void)mode;
    /* Map to stat — if it exists, accessible (Phase 9: no permission model) */
    char tmp[512];
    return stat(path, tmp);
}

int dup2(int oldfd, int newfd) {
    return __retval(__syscall2(NR_DUP2, oldfd, newfd));
}

int pipe(int fds[2]) {
    return __retval(__syscall1(NR_PIPE, (int)fds));
}

int fcntl(int fd, int cmd, ...) {
    int arg = 0;
    va_list ap; va_start(ap, cmd); arg = va_arg(ap, int); va_end(ap);
    return __retval(__syscall3(NR_FCNTL, fd, cmd, arg));
}

int ioctl(int fd, unsigned long req, ...) {
    void *arg = (void*)0;
    va_list ap; va_start(ap, req); arg = va_arg(ap, void*); va_end(ap);
    return __retval(__syscall3(NR_IOCTL, fd, (int)req, (int)arg));
}

int isatty(int fd) { return (fd >= 0 && fd <= 2) ? 1 : 0; }

/* ── Memory ──────────────────────────────────────────────────────────── */

void *mmap(void *addr, size_t len, int prot, int flags, int fd, long off) {
    /* Pack addr+len into two args; prot+flags in third */
    int r = __syscall5(NR_MMAP, (int)addr, (int)len, prot | (flags << 8),
                       fd, (int)off);
    return __retptr(r);
}

int munmap(void *addr, size_t len) {
    return __retval(__syscall2(NR_MUNMAP, (int)addr, (int)len));
}

int mprotect(void *addr, size_t len, int prot) {
    return __retval(__syscall3(NR_MPROTECT, (int)addr, (int)len, prot));
}

void *sbrk(long incr) {
    int r = __syscall1(NR_BRK, (int)incr);
    return __retptr(r);
}

/* ── Directory ───────────────────────────────────────────────────────── */

void *opendir(const char *path) {
    int r = __syscall1(NR_OPENDIR, (int)path);
    return __retptr(r);
}

void *readdir(void *dir) {
    int r = __syscall1(NR_READDIR, (int)dir);
    return __retptr(r);
}

int closedir(void *dir) {
    return __retval(__syscall1(NR_CLOSEDIR, (int)dir));
}

/* ── Sockets ─────────────────────────────────────────────────────────── */

int socket(int domain, int type, int protocol) {
    return __retval(__syscall3(NR_SOCKET, domain, type, protocol));
}

int connect(int sockfd, const void *addr, unsigned addrlen) {
    return __retval(__syscall3(NR_CONNECT, sockfd, (int)addr, (int)addrlen));
}

int bind(int sockfd, const void *addr, unsigned addrlen) {
    return __retval(__syscall3(NR_BIND, sockfd, (int)addr, (int)addrlen));
}

int listen(int sockfd, int backlog) {
    return __retval(__syscall2(NR_LISTEN, sockfd, backlog));
}

int accept(int sockfd, void *addr, unsigned *addrlen) {
    return __retval(__syscall3(NR_ACCEPT, sockfd, (int)addr, (int)addrlen));
}

long send(int sockfd, const void *buf, size_t len, int flags) {
    return __retval(__syscall4(NR_SEND, sockfd, (int)buf, (int)len, flags));
}

long recv(int sockfd, void *buf, size_t len, int flags) {
    return __retval(__syscall4(NR_RECV, sockfd, (int)buf, (int)len, flags));
}

long sendto(int sockfd, const void *buf, size_t len, int flags,
            const void *addr, unsigned addrlen) {
    (void)addr; (void)addrlen;
    return send(sockfd, buf, len, flags);
}

long recvfrom(int sockfd, void *buf, size_t len, int flags,
              void *addr, unsigned *addrlen) {
    (void)addr; (void)addrlen;
    return recv(sockfd, buf, len, flags);
}

int setsockopt(int sockfd, int level, int optname, const void *optval,
               unsigned optlen) {
    return __retval(__syscall4(NR_SETSOCKOPT, sockfd, level, optname,
                               (int)optval));
    (void)optlen;
}

int getsockopt(int sockfd, int level, int optname, void *optval,
               unsigned *optlen) {
    return __retval(__syscall4(NR_GETSOCKOPT, sockfd, level, optname,
                               (int)optval));
    (void)optlen;
}

int getsockname(int sockfd, void *addr, unsigned *addrlen) {
    return __retval(__syscall3(NR_GETSOCKNAME, sockfd, (int)addr, (int)addrlen));
}

int getpeername(int sockfd, void *addr, unsigned *addrlen) {
    return __retval(__syscall3(NR_GETPEERNAME, sockfd, (int)addr, (int)addrlen));
}

int shutdown(int sockfd, int how) {
    return __retval(__syscall2(NR_SHUTDOWN, sockfd, how));
}

int socketpair(int domain, int type, int protocol, int fds[2]) {
    return __retval(__syscall4(NR_SOCKETPAIR, domain, type, protocol, (int)fds));
}

/* ── epoll ───────────────────────────────────────────────────────────── */

int epoll_create(int size) {
    return __retval(__syscall1(NR_EPOLL_CREATE, size));
}

int epoll_create1(int flags) {
    return __retval(__syscall1(NR_EPOLL_CREATE, flags));
}

int epoll_ctl(int epfd, int op, int fd, void *event) {
    return __retval(__syscall4(NR_EPOLL_CTL, epfd, op, fd, (int)event));
}

int epoll_wait(int epfd, void *events, int maxevents, int timeout) {
    return __retval(__syscall4(NR_EPOLL_WAIT, epfd, (int)events, maxevents, timeout));
}

/* ── Time ────────────────────────────────────────────────────────────── */

int clock_gettime(int clk_id, void *tp) {
    return __retval(__syscall2(NR_CLOCK_GETTIME, clk_id, (int)tp));
}

int gettimeofday(void *tv, void *tz) {
    (void)tz;
    return __retval(__syscall1(NR_GETTIMEOFDAY, (int)tv));
}

long time(long *tloc) {
    long t = __syscall0(NR_TIME);
    if (tloc) *tloc = t;
    return t;
}

int nanosleep(const void *req, void *rem) {
    (void)rem;
    return __retval(__syscall1(NR_NANOSLEEP, (int)req));
}

unsigned int sleep(unsigned int sec) {
    return __retval(__syscall1(NR_USLEEP, (int)(sec * 1000000u)));
}

int usleep(unsigned long usec) {
    return __retval(__syscall1(NR_USLEEP, (int)usec));
}

int sched_yield(void) {
    return __retval(__syscall0(NR_SCHED_YIELD));
}

/* ── Signals ─────────────────────────────────────────────────────────── */

int sigaction(int signum, const void *act, void *oldact) {
    return __retval(__syscall3(NR_SIGACTION, signum, (int)act, (int)oldact));
}

void *signal(int signum, void *handler) {
    return __retptr(__syscall2(NR_SIGACTION, signum, (int)handler));
}

int sigprocmask(int how, const void *set, void *oldset) {
    (void)how; (void)set; if (oldset) *(int*)oldset = 0;
    return 0;
}

/* ── Threads (pthread) ───────────────────────────────────────────────── */

int pthread_create(unsigned long *thread, const void *attr,
                   void *(*fn)(void*), void *arg) {
    int r = __syscall3(NR_PTHREAD_CREATE, (int)fn, (int)arg, (int)attr);
    if (r < 0) { errno = -r; return -r; }
    if (thread) *thread = (unsigned long)r;
    return 0;
}

int pthread_join(unsigned long thread, void **retval) {
    (void)retval;
    return __retval(__syscall1(NR_PTHREAD_JOIN, (int)thread));
}

int pthread_detach(unsigned long thread) {
    (void)thread; return 0;
}

unsigned long pthread_self(void) {
    return (unsigned long)__syscall0(NR_THREAD_SELF);
}

int pthread_exit(void *retval) {
    (void)retval; _exit(0);
    return 0;
}

int pthread_sigmask(int how, const void *set, void *old) {
    return sigprocmask(how, set, old);
}

/* Mutex */
int pthread_mutex_init(void *m, const void *attr) {
    (void)attr;
    int r = __syscall0(NR_MUTEX_CREATE);
    if (r > 0) { *(int*)m = r; return 0; }
    return -r;
}

int pthread_mutex_destroy(void *m) {
    return __retval(__syscall1(NR_MUTEX_DESTROY, *(int*)m));
}

int pthread_mutex_lock(void *m) {
    return __retval(__syscall1(NR_MUTEX_LOCK, *(int*)m));
}

int pthread_mutex_trylock(void *m) {
    int r = __syscall1(NR_MUTEX_LOCK, *(int*)m);
    if (r == -11 /* EAGAIN */) return 11;
    return __retval(r);
}

int pthread_mutex_unlock(void *m) {
    return __retval(__syscall1(NR_MUTEX_UNLOCK, *(int*)m));
}

/* Condvar — minimal stubs (JSOS Phase 9: single-process Chromium) */
int pthread_cond_init(void *c, const void *attr)  { (void)c;(void)attr; return 0; }
int pthread_cond_destroy(void *c)                  { (void)c; return 0; }
int pthread_cond_wait(void *c, void *m)            {
    pthread_mutex_unlock(m);
    __syscall0(NR_SCHED_YIELD);
    return pthread_mutex_lock(m);
    (void)c;
}
int pthread_cond_timedwait(void *c, void *m, const void *t) {
    (void)t; return pthread_cond_wait(c, m);
}
int pthread_cond_signal(void *c)                   { (void)c; return 0; }
int pthread_cond_broadcast(void *c)                { (void)c; return 0; }

/* pthread_once */
int pthread_once(void *once, void (*init)(void)) {
    int *p = (int*)once;
    if (!*p) { *p = 1; init(); }
    return 0;
}

/* pthread keys */
static void* _keys[64];
int pthread_key_create(unsigned int *key, void(*dtor)(void*)) {
    (void)dtor; static unsigned int next = 0;
    *key = next++; return 0;
}
int pthread_key_delete(unsigned int key)        { (void)key; return 0; }
void *pthread_getspecific(unsigned int key)     { return key < 64 ? _keys[key] : (void*)0; }
int   pthread_setspecific(unsigned int key, const void *val) {
    if (key < 64) { _keys[key] = (void*)val; return 0; } return 22;
}

/* rwlock — map to mutex */
int pthread_rwlock_init(void *rw, const void *a)    { return pthread_mutex_init(rw, a); }
int pthread_rwlock_destroy(void *rw)                { return pthread_mutex_destroy(rw); }
int pthread_rwlock_rdlock(void *rw)                 { return pthread_mutex_lock(rw); }
int pthread_rwlock_wrlock(void *rw)                 { return pthread_mutex_lock(rw); }
int pthread_rwlock_tryrdlock(void *rw)              { return pthread_mutex_trylock(rw); }
int pthread_rwlock_trywrlock(void *rw)              { return pthread_mutex_trylock(rw); }
int pthread_rwlock_unlock(void *rw)                 { return pthread_mutex_unlock(rw); }

/* pthread_attr */
int pthread_attr_init(void *a)                      { (void)a; return 0; }
int pthread_attr_destroy(void *a)                   { (void)a; return 0; }
int pthread_attr_setdetachstate(void *a, int s)     { (void)a;(void)s; return 0; }
int pthread_attr_setstacksize(void *a, size_t sz)   { (void)a;(void)sz; return 0; }
int pthread_attr_setschedpolicy(void *a, int p)     { (void)a;(void)p; return 0; }
int pthread_attr_setschedparam(void *a, const void *p) { (void)a;(void)p; return 0; }
int pthread_attr_getschedparam(const void *a, void *p) { (void)a;(void)p; return 0; }
int pthread_setschedparam(unsigned long t, int p, const void *sp) {
    (void)t;(void)p;(void)sp; return 0;
}

/* ── Locale / charset stubs ─────────────────────────────────────────── */

char *setlocale(int cat, const char *loc) {
    (void)cat; (void)loc; return (char*)"C";
}

char *nl_langinfo(int item) {
    (void)item; return (char*)"UTF-8";
}

/* ── Misc helpers ────────────────────────────────────────────────────── */

int uname(void *buf) {
    return __retval(__syscall1(NR_UNAME, (int)buf));
}

/* dlopen/dlsym/dlclose — static build, these are never called */
void *dlopen(const char *file, int flags)   { (void)file;(void)flags; return (void*)1; }
void *dlsym(void *handle, const char *sym)  { (void)handle;(void)sym; return (void*)0; }
int   dlclose(void *handle)                 { (void)handle; return 0; }
char *dlerror(void)                         { return (char*)"not supported"; }
