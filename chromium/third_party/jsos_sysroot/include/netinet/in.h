/* JSOS sysroot — netinet/in.h
 * Internet address family structures and constants for Chromium's network
 * stack compiled against the JSOS sysroot.  Maps onto the Phase 7 socket
 * syscall layer (sockets.ts → net.ts).
 *
 * NOTE: struct sockaddr_in / sockaddr_in6 are defined in sys/socket.h to
 * avoid duplicate definitions.  This header includes sys/socket.h and adds
 * the IP-level types, protocol numbers, and byte-order helpers.
 */
#ifndef _JSOS_NETINET_IN_H
#define _JSOS_NETINET_IN_H

#include <stdint.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Integer types ──────────────────────────────────────────────────────── */
typedef uint16_t in_port_t;
typedef uint32_t in_addr_t;

/* ── IPv4 address (standalone; sockaddr_in lives in sys/socket.h) ────────── */
struct in_addr {
    in_addr_t s_addr;   /* network byte order */
};

/* ── IPv6 address (standalone) ──────────────────────────────────────────── */
struct in6_addr {
    uint8_t s6_addr[16];
};

#define IN6ADDR_ANY_INIT      { { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0 } }
#define IN6ADDR_LOOPBACK_INIT { { 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1 } }

/* ── IP protocol numbers ────────────────────────────────────────────────── */
#define IPPROTO_IP      0    /* dummy for IP */
#define IPPROTO_ICMP    1
#define IPPROTO_TCP     6
#define IPPROTO_UDP    17
#define IPPROTO_IPV6   41
#define IPPROTO_RAW   255

/* ── Well-known ports ───────────────────────────────────────────────────── */
#define IPPORT_ECHO        7
#define IPPORT_HTTP       80
#define IPPORT_HTTPS     443

/* ── Special IPv4 addresses ─────────────────────────────────────────────── */
#define INADDR_ANY       ((in_addr_t)0x00000000)
#define INADDR_BROADCAST ((in_addr_t)0xFFFFFFFF)
#define INADDR_LOOPBACK  ((in_addr_t)0x7F000001)
#define INADDR_NONE      ((in_addr_t)0xFFFFFFFF)

/* ── IP socket options (setsockopt level IPPROTO_IP) ────────────────────── */
#define IP_TOS              1
#define IP_TTL              2
#define IP_MULTICAST_TTL   33
#define IP_MULTICAST_LOOP  34
#define IP_ADD_MEMBERSHIP  35
#define IP_DROP_MEMBERSHIP 36

/* ── IPv6 socket options (IPPROTO_IPV6) ─────────────────────────────────── */
#define IPV6_V6ONLY        26
#define IPV6_JOIN_GROUP    20
#define IPV6_LEAVE_GROUP   21

/* ── Byte order helpers ─────────────────────────────────────────────────── */
/* JSOS target is little-endian (i686). */
static inline uint32_t __jsos_bswap32(uint32_t x) {
    return ((x & 0xFF000000u) >> 24) |
           ((x & 0x00FF0000u) >>  8) |
           ((x & 0x0000FF00u) <<  8) |
           ((x & 0x000000FFu) << 24);
}
static inline uint16_t __jsos_bswap16(uint16_t x) {
    return (uint16_t)(((x) >> 8) | ((x) << 8));
}

#ifndef htonl
#define htonl(x)  __jsos_bswap32(x)
#define ntohl(x)  __jsos_bswap32(x)
#define htons(x)  __jsos_bswap16(x)
#define ntohs(x)  __jsos_bswap16(x)
#endif

/* ── inet_addr / inet_ntoa helpers ──────────────────────────────────────── */
in_addr_t    inet_addr(const char *cp);
char        *inet_ntoa(struct in_addr in);
int          inet_pton(int af, const char *src, void *dst);
const char  *inet_ntop(int af, const void *src, char *dst, size_t size);

#ifdef __cplusplus
}
#endif
#endif /* _JSOS_NETINET_IN_H */

