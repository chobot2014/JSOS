/*
 * net_helpers.c  inet_* / byte-order / getaddrinfo for JSOS (Phase 9)
 *
 * Compiled into libnet.a.  Pure-C implementations; no kernel syscalls except
 * getaddrinfo which routes through the JSOS DNS resolver (syscall NR_RESOLVE).
 */

#include <stddef.h>
#include <stdint.h>

#define AF_INET   2
#define AF_INET6  10
#define NR_RESOLVE 80

/*  Byte-order swaps (i686 = little-endian)  */

uint32_t htonl(uint32_t x) {
    return ((x & 0xFF000000u) >> 24) | ((x & 0x00FF0000u) >> 8) |
           ((x & 0x0000FF00u) <<  8) | ((x & 0x000000FFu) << 24);
}
uint32_t ntohl(uint32_t x) { return htonl(x); }
uint16_t htons(uint16_t x) { return (uint16_t)(((x) >> 8) | ((x) << 8)); }
uint16_t ntohs(uint16_t x) { return htons(x); }

/*  Private helpers  */

static int _isdigit(int c) { return c >= '0' && c <= '9'; }

static size_t _strlen(const char *s) { size_t n=0; while(*s++) n++; return n; }
static void _memcpy(void *d, const void *s, size_t n) {
    uint8_t *dd=(uint8_t*)d; const uint8_t *ss=(const uint8_t*)s;
    while(n--) *dd++ = *ss++;
}
static void _memset(void *d, int c, size_t n) {
    uint8_t *p=(uint8_t*)d; while(n--) *p++=(uint8_t)c;
}

/* Write decimal octet into p, return new p */
static char *_put_u8(char *p, unsigned v) {
    if (v >= 100) { *p++ = (char)('0'+v/100); v%=100; *p++ = (char)('0'+v/10); v%=10; }
    else if (v >= 10) { *p++ = (char)('0'+v/10); v%=10; }
    *p++ = (char)('0'+v); return p;
}

static const char _hex[] = "0123456789abcdef";

/*  inet_addr  */

uint32_t inet_addr(const char *cp) {
    unsigned parts[4]; int n; const char *p = cp;
    for (n = 0; n < 4; n++) {
        if (!_isdigit(*p)) return 0xFFFFFFFFu;
        unsigned v = 0;
        while (_isdigit(*p)) { v = v*10 + (unsigned)(*p++ - '0'); if (v>255) return 0xFFFFFFFFu; }
        parts[n] = v;
        if (n < 3) { if (*p != '.') return 0xFFFFFFFFu; p++; }
    }
    if (*p != '\0') return 0xFFFFFFFFu;
    return htonl((parts[0]<<24)|(parts[1]<<16)|(parts[2]<<8)|parts[3]);
}

/*  inet_ntoa  */

typedef struct { uint32_t s_addr; } jsos_in_addr_t;

static char _ntoa_buf[16];   /* one static buffer  matches POSIX spec */

char *inet_ntoa(jsos_in_addr_t in) {
    uint32_t a = ntohl(in.s_addr); char *p = _ntoa_buf;
    p = _put_u8(p,(a>>24)&0xFF); *p++='.';
    p = _put_u8(p,(a>>16)&0xFF); *p++='.';
    p = _put_u8(p,(a>> 8)&0xFF); *p++='.';
    p = _put_u8(p, a     &0xFF); *p='\0';
    return _ntoa_buf;
}

/*  inet_pton  */

int inet_pton(int af, const char *src, void *dst) {
    if (af == AF_INET) {
        uint32_t addr = inet_addr(src);
        /* 255.255.255.255 is the only valid address that returns 0xFFFFFFFF */
        if (addr == 0xFFFFFFFFu) {
            const char *q = src;
            int ok = (*q=='2'&&*(q+1)=='5'&&*(q+2)=='5'&&*(q+3)=='.');
            if (!ok) return 0;
        }
        *(uint32_t*)dst = addr;
        return 1;
    }
    if (af == AF_INET6) {
        _memset(dst, 0, 16);
        return 0; /* TODO: full IPv6 (Phase 10) */
    }
    return -1;
}

/*  inet_ntop  */

const char *inet_ntop(int af, const void *src, char *dst, size_t size) {
    if (af == AF_INET) {
        jsos_in_addr_t tmp; tmp.s_addr = *(const uint32_t*)src;
        char *s = inet_ntoa(tmp);
        size_t len = _strlen(s);
        if (len+1 > size) return (const char*)0;
        _memcpy(dst, s, len+1); return dst;
    }
    if (af == AF_INET6) {
        const uint8_t *a = (const uint8_t*)src; char tmp[40]; char *p = tmp;
        for (int i=0;i<8;i++) {
            unsigned v = ((unsigned)a[i*2]<<8)|a[i*2+1];
            *p++ = _hex[(v>>12)&0xF]; *p++ = _hex[(v>>8)&0xF];
            *p++ = _hex[(v>> 4)&0xF]; *p++ = _hex[v&0xF];
            if (i<7) *p++=':';
        }
        *p='\0'; size_t len=_strlen(tmp);
        if (len+1>size) return (const char*)0;
        _memcpy(dst,tmp,len+1); return dst;
    }
    return (const char*)0;
}

/*  getaddrinfo / freeaddrinfo  */

struct addrinfo {
    int              ai_flags;
    int              ai_family;
    int              ai_socktype;
    int              ai_protocol;
    unsigned         ai_addrlen;
    void            *ai_addr;
    char            *ai_canonname;
    struct addrinfo *ai_next;
};

static inline int _syscall2(int num, int a, int b) {
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(num), "b"(a), "c"(b) : "memory");
    return r;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    (void)service; (void)hints;
    int r = _syscall2(NR_RESOLVE, (int)(uintptr_t)node, (int)(uintptr_t)res);
    return r < 0 ? -r : 0;
}

void freeaddrinfo(struct addrinfo *res) { (void)res; }

const char *gai_strerror(int e) { (void)e; return "name resolution error"; }

int getnameinfo(const void *addr, unsigned al, char *host, unsigned hl,
                char *serv, unsigned sl, int flags) {
    (void)addr;(void)al;(void)host;(void)hl;(void)serv;(void)sl;(void)flags;
    return -1;
}
