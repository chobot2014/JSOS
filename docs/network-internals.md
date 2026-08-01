# JSOS Network Stack Internals
**Item 887**

## Overview

The JSOS network stack is implemented entirely in TypeScript. C provides only
raw Ethernet frame send/receive via DMA ring buffers.

## Layer Structure

```
Application Layer     HTTP, WebSocket, DNS, TLS 1.3
Transport Layer       TCP (state machine + congestion control), UDP
Network Layer         IPv4 / IPv6, ARP, ICMP
Data Link Layer       Ethernet II framing, MAC address table
Physical (C binding)  kernel.netSend(frame), kernel.netRecv()
```

## TCP State Machine (src/os/net/tcp.ts)

States: `CLOSED → LISTEN → SYN_RECEIVED → ESTABLISHED → FIN_WAIT_1 → ...`

Key algorithms:
- **Slow start + CWND**: `cwnd` starts at 1 MSS, doubles until ssthresh
- **Fast retransmit**: 3 duplicate ACKs trigger immediate retransmit without waiting for timeout
- **Nagle's algorithm**: small segments buffered unless urgency flag or no unACKed data
- **RTT estimation**: Karn/Jacobson algorithm (SRTT + 4×RTTVAR) for RTO

## TLS 1.3 (src/os/net/tls.ts)

Handshake flow:
```
Client: ClientHello (TLS 1.3, X25519 key share)
Server: ServerHello + EncryptedExtensions + Certificate + CertificateVerify + Finished
Client: Finished
→ Application data via AES-128-GCM or ChaCha20-Poly1305
```

Key derivation: HKDF-SHA256 for all traffic secrets.

Certificate validation: RSA-PSS and ECDSA (P-256) signatures; Mozilla Root CA bundle in `/etc/ssl/cacerts.pem`.

## DNS Resolver (src/os/net/dns.ts)

- Recursive resolver with A/AAAA/CNAME/MX record support
- TTL-based cache (default nameserver: `1.1.1.1` and `8.8.8.8`)
- DNSSEC validation stubs (chain-of-trust not yet enforced)
- `sys.net.dns.resolve(hostname)` → `Promise<string>`

## HTTP Client (src/os/net/http.ts)

- HTTP/1.1 persistent connections (keep-alive pool, max 6 per origin)
- HTTP/2 over TLS (ALPN `h2`): multiplexed streams, HPACK header compression
- Redirects: follow up to 10 redirects, preserving method for 307/308
- Cache: `Cache-Control` header support, ETag / If-None-Match revalidation
- Chunked transfer encoding decode

## WebSocket (src/os/net/websocket.ts)

- RFC 6455 framing (text/binary/ping/pong/close frames)
- Masking applied for client → server direction
- Backpressure via `bufferedAmount`

## Network Interfaces

```typescript
sys.net.interfaces()   // [{name: 'eth0', mac, ip4, ip6}]
sys.net.wifi           // future: 802.11 management frames
```
