/* JSOS sysroot — time.h
 * Backed by kernel.getUptime() / PIT timer ticks from Phase 2.
 */
#ifndef _JSOS_TIME_H
#define _JSOS_TIME_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef long time_t;
typedef long clock_t;
typedef long long int64_t;

#define CLOCKS_PER_SEC  1000

struct timespec {
    time_t tv_sec;
    long   tv_nsec;
};

struct timeval {
    long tv_sec;
    long tv_usec;
};

struct timezone {
    int tz_minuteswest;
    int tz_dsttime;
};

struct tm {
    int tm_sec;    /* 0-60 */
    int tm_min;    /* 0-59 */
    int tm_hour;   /* 0-23 */
    int tm_mday;   /* 1-31 */
    int tm_mon;    /* 0-11 */
    int tm_year;   /* years since 1900 */
    int tm_wday;   /* 0-6 (Sunday=0) */
    int tm_yday;   /* 0-365 */
    int tm_isdst;
    long tm_gmtoff;
    const char *tm_zone;
};

/* Clock IDs */
#define CLOCK_REALTIME          0
#define CLOCK_MONOTONIC         1
#define CLOCK_PROCESS_CPUTIME_ID 2
#define CLOCK_THREAD_CPUTIME_ID  3
#define CLOCK_MONOTONIC_RAW     4
#define CLOCK_REALTIME_COARSE   5
#define CLOCK_MONOTONIC_COARSE  6

/* Timer creation flags */
#define TIMER_ABSTIME  1

time_t    time(time_t *tloc);
clock_t   clock(void);
int       clock_gettime(int clk_id, struct timespec *tp);
int       clock_getres(int clk_id, struct timespec *res);
int       clock_settime(int clk_id, const struct timespec *tp);
int       gettimeofday(struct timeval *tv, struct timezone *tz);

struct tm *gmtime(const time_t *timep);
struct tm *localtime(const time_t *timep);
time_t     mktime(struct tm *tm);
char      *asctime(const struct tm *tm);
char      *ctime(const time_t *timep);

/* Locale stub (no international support on JSOS) */
char *setlocale(int category, const char *locale);

/* nanosleep backed by kernel.sleep(ms) */
int nanosleep(const struct timespec *req, struct timespec *rem);

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_TIME_H */
