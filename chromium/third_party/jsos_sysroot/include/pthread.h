/* JSOS sysroot — pthread.h
 * POSIX threads stub — on JSOS, "threads" are cooperative JS coroutines
 * managed by Phase 5 threads.ts.  The C-level pthread API maps onto the
 * kernel.registerSchedulerHook / kernel.yield cooperative interface.
 */
#ifndef _JSOS_PTHREAD_H
#define _JSOS_PTHREAD_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned long  pthread_t;
typedef unsigned int   pthread_key_t;

typedef struct {
    int   detachstate;    /* PTHREAD_CREATE_JOINABLE / DETACHED */
    int   schedpolicy;
    int   schedpriority;
    size_t stacksize;
} pthread_attr_t;

typedef struct {
    int locked;
    int recursive;
    unsigned owner;
} pthread_mutex_t;

typedef struct {
    int kind;
} pthread_mutexattr_t;

typedef struct {
    int waiters;
} pthread_cond_t;

typedef struct { int dummy; } pthread_condattr_t;
typedef struct { int done; } pthread_once_t;
typedef struct { unsigned long key; } pthread_rwlock_t;
typedef struct { int dummy; } pthread_rwlockattr_t;
typedef struct { int dummy; } pthread_spinlock_t;
typedef struct { int dummy; } pthread_barrier_t;
typedef struct { int dummy; } pthread_barrierattr_t;

#define PTHREAD_MUTEX_INITIALIZER  { 0, 0, 0 }
#define PTHREAD_COND_INITIALIZER   { 0 }
#define PTHREAD_ONCE_INIT          { 0 }
#define PTHREAD_RWLOCK_INITIALIZER { 0UL }

#define PTHREAD_CREATE_JOINABLE    0
#define PTHREAD_CREATE_DETACHED    1
#define PTHREAD_MUTEX_NORMAL       0
#define PTHREAD_MUTEX_RECURSIVE    1
#define PTHREAD_MUTEX_ERRORCHECK   2
#define PTHREAD_MUTEX_DEFAULT      PTHREAD_MUTEX_NORMAL

/* Thread lifecycle */
int pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                   void *(*start_routine)(void *), void *arg);
int pthread_join(pthread_t thread, void **retval);
int pthread_detach(pthread_t thread);
void pthread_exit(void *retval) __attribute__((noreturn));
pthread_t pthread_self(void);
int pthread_equal(pthread_t t1, pthread_t t2);
int pthread_cancel(pthread_t thread);

/* Mutex */
int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr);
int pthread_mutex_destroy(pthread_mutex_t *mutex);
int pthread_mutex_lock(pthread_mutex_t *mutex);
int pthread_mutex_trylock(pthread_mutex_t *mutex);
int pthread_mutex_unlock(pthread_mutex_t *mutex);

int pthread_mutexattr_init(pthread_mutexattr_t *attr);
int pthread_mutexattr_destroy(pthread_mutexattr_t *attr);
int pthread_mutexattr_settype(pthread_mutexattr_t *attr, int type);

/* Condition variables */
int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr);
int pthread_cond_destroy(pthread_cond_t *cond);
int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex);
int pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex,
                           const struct timespec *abstime);
int pthread_cond_signal(pthread_cond_t *cond);
int pthread_cond_broadcast(pthread_cond_t *cond);

/* Thread-local storage */
int pthread_key_create(pthread_key_t *key, void (*destructor)(void *));
int pthread_key_delete(pthread_key_t key);
void *pthread_getspecific(pthread_key_t key);
int pthread_setspecific(pthread_key_t key, const void *value);

/* Attributes */
int pthread_attr_init(pthread_attr_t *attr);
int pthread_attr_destroy(pthread_attr_t *attr);
int pthread_attr_setdetachstate(pthread_attr_t *attr, int detachstate);
int pthread_attr_setstacksize(pthread_attr_t *attr, size_t stacksize);
int pthread_attr_getstacksize(const pthread_attr_t *attr, size_t *stacksize);

/* Once */
int pthread_once(pthread_once_t *once_control, void (*init_routine)(void));

/* RW lock (simplified) */
int pthread_rwlock_init(pthread_rwlock_t *rwlock, const pthread_rwlockattr_t *attr);
int pthread_rwlock_destroy(pthread_rwlock_t *rwlock);
int pthread_rwlock_rdlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_wrlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_tryrdlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_trywrlock(pthread_rwlock_t *rwlock);
int pthread_rwlock_unlock(pthread_rwlock_t *rwlock);

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_PTHREAD_H */
