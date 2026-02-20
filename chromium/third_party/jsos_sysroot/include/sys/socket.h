/* JSOS sysroot — sys/socket.h
 * TCP/UDP socket interface — backed by Phase 7 net.ts syscalls.
 */
#ifndef _JSOS_SYS_SOCKET_H
#define _JSOS_SYS_SOCKET_H

#include <stddef.h>
#include "types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned int   socklen_t;
typedef unsigned short sa_family_t;

struct sockaddr {
    sa_family_t sa_family;
    char        sa_data[14];
};

struct sockaddr_in {
    sa_family_t    sin_family;
    unsigned short sin_port;
    struct { unsigned int s_addr; } sin_addr;
    char           sin_zero[8];
};

struct sockaddr_in6 {
    sa_family_t     sin6_family;
    unsigned short  sin6_port;
    unsigned int    sin6_flowinfo;
    struct { unsigned char s6_addr[16]; } sin6_addr;
    unsigned int    sin6_scope_id;
};

struct sockaddr_storage {
    sa_family_t ss_family;
    char        __ss_padding[126];
    unsigned long __ss_align;
};

/* Address families */
#define AF_UNSPEC  0
#define AF_UNIX    1
#define AF_INET    2
#define AF_INET6   10

/* Socket types */
#define SOCK_STREAM    1
#define SOCK_DGRAM     2
#define SOCK_RAW       3
#define SOCK_NONBLOCK  0x800
#define SOCK_CLOEXEC   0x80000

/* Protocol numbers */
#define IPPROTO_IP    0
#define IPPROTO_TCP   6
#define IPPROTO_UDP   17

/* SOL_SOCKET options */
#define SOL_SOCKET     1
#define SO_REUSEADDR   2
#define SO_KEEPALIVE   9
#define SO_SNDBUF      7
#define SO_RCVBUF      8
#define SO_ERROR       4
#define SO_TYPE        3
#define SO_LINGER     13
#define SO_REUSEPORT  15

/* TCP options */
#define IPPROTO_TCP_OPT  6
#define TCP_NODELAY      1
#define TCP_MAXSEG       2
#define TCP_KEEPIDLE     4
#define TCP_KEEPINTVL    5
#define TCP_KEEPCNT      6

/* send/recv flags */
#define MSG_PEEK        0x02
#define MSG_WAITALL     0x100
#define MSG_NOSIGNAL    0x4000
#define MSG_DONTWAIT    0x40

/* shutdown how */
#define SHUT_RD   0
#define SHUT_WR   1
#define SHUT_RDWR 2

struct msghdr {
    void         *msg_name;
    socklen_t     msg_namelen;
    struct iovec *msg_iov;
    size_t        msg_iovlen;
    void         *msg_control;
    size_t        msg_controllen;
    int           msg_flags;
};

struct iovec {
    void  *iov_base;
    size_t iov_len;
};

int     socket(int domain, int type, int protocol);
int     connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
int     bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
int     listen(int sockfd, int backlog);
int     accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
int     accept4(int sockfd, struct sockaddr *addr, socklen_t *addrlen, int flags);
ssize_t send(int sockfd, const void *buf, size_t len, int flags);
ssize_t recv(int sockfd, void *buf, size_t len, int flags);
ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen);
ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,
                 struct sockaddr *src_addr, socklen_t *addrlen);
ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags);
ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags);
int     getsockopt(int sockfd, int level, int optname, void *optval, socklen_t *optlen);
int     setsockopt(int sockfd, int level, int optname, const void *optval, socklen_t optlen);
int     getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
int     getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
int     shutdown(int sockfd, int how);
int     socketpair(int domain, int type, int protocol, int sv[2]);

#ifdef __cplusplus
}
#endif

#endif /* _JSOS_SYS_SOCKET_H */
