/* JSOS sysroot — signal.h
 * Maps to Phase 6 signalManager in JSOS signals.ts.
 */
#ifndef _JSOS_SIGNAL_H
#define _JSOS_SIGNAL_H

#include "sys/types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*sighandler_t)(int);
typedef unsigned long sigset_t;

/* Standard signal numbers (Linux-compatible) */
#define SIGHUP    1
#define SIGINT    2
#define SIGQUIT   3
#define SIGILL    4
#define SIGABRT   6
#define SIGFPE    8
#define SIGKILL   9
#define SIGSEGV  11
#define SIGPIPE  13
#define SIGALRM  14
#define SIGTERM  15
#define SIGUSR1  10
#define SIGUSR2  12
#define SIGCHLD  17
#define SIGCONT  18
#define SIGSTOP  19
#define SIGTSTP  20
#define SIGTTIN  21
#define SIGTTOU  22
#define SIGURG   23
#define SIGWINCH 28
#define SIGIO    29

#define SIG_ERR    ((sighandler_t)-1)
#define SIG_DFL    ((sighandler_t)0)
#define SIG_IGN    ((sighandler_t)1)

/* sigaction flags */
#define SA_NOCLDSTOP  0x00000001
#define SA_NOCLDWAIT  0x00000002
#define SA_SIGINFO    0x00000004
#define SA_RESTART    0x10000000
#define SA_NODEFER    0x40000000
#define SA_RESETHAND  0x80000000

typedef struct {
    int si_signo;
    int si_errno;
    int si_code;
} siginfo_t;

struct sigaction {
    union {
        sighandler_t sa_handler;
        void (*sa_sigaction)(int, siginfo_t *, void *);
    };
    sigset_t sa_mask;
    int      sa_flags;
};

/* sigset manipulation */
static inline int sigemptyset(sigset_t *set)  { *set = 0UL; return 0; }
static inline int sigfillset(sigset_t *set)   { *set = ~0UL; return 0; }
static inline int sigaddset(sigset_t *set, int sig)
    { *set |= (1UL << (sig - 1)); return 0; }
static inline int sigdelset(sigset_t *set, int sig)
    { *set &= ~(1UL << (sig - 1)); return 0; }
static inline int sigismember(const sigset_t *set, int sig)
    { return (*set >> (sig - 1)) & 1; }

sighandler_t signal(int signum, sighandler_t handler);
int          sigaction(int signum, const struct sigaction *act,
                       struct sigaction *oldact);
int          kill(pid_t pid, int sig);
int          raise(int sig);
int          sigprocmask(int how, const sigset_t *set, sigset_t *oldset);

#define SIG_BLOCK    0
#define SIG_UNBLOCK  1
#define SIG_SETMASK  2

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_SIGNAL_H */
