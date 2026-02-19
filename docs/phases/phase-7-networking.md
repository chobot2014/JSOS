# Phase 7 — Real Networking

## Goal

Wire the existing TypeScript TCP/IP stack to real hardware. Expose POSIX
socket fds to user-space programs. Add DHCP, DNS, and TLS so a process can
make real HTTPS requests.

---

## Prerequisites

- Phase 5 complete (threads — NIC interrupt runs in its own thread)
- Phase 6 complete (FDTable, POSIX, fork/exec — socket fds live in FDTable)
- Phase 4 complete (DMA buffers need physically contiguous pages)

---

## The C Code Rule Applied Here

The NIC driver in C does two things: put a frame on the wire, take a frame
off the wire. **All ARP, IP, TCP, UDP, ICMP, DNS, DHCP logic is TypeScript.**

---

## 7a — Ethernet Driver (C)

Two targets:

### virtio-net (QEMU) — implement first

PCI device vendor=0x1AF4, device=0x1000. Simpler than real hardware: a shared
memory descriptor ring, no real DMA engine.

```c
// kernel/virtio_net.c:
void virtio_net_init(void);         // probe PCI, set up TX/RX rings
void virtio_net_send(uint8_t *frame, uint16_t len);
int  virtio_net_recv(uint8_t *buf, uint16_t *len);  // -1 if empty
void virtio_net_get_mac(uint8_t mac[6]);
```

### Intel E1000 (real hardware / QEMU -net e1000)

PCI device vendor=0x8086, device=0x100E (QEMU) / 0x100F (8254x).

```c
// kernel/e1000.c:
void e1000_init(void);
void e1000_send(uint8_t *frame, uint16_t len);
int  e1000_recv(uint8_t *buf, uint16_t *len);
void e1000_get_mac(uint8_t mac[6]);
```

### QuickJS Bindings

```c
// In quickjs_binding.c — new NIC bindings:
kernel.netInit(): boolean
// Probes PCI for virtio-net then E1000. Returns true if found.

kernel.netSendFrame(bytes: number[]): void
// Sends raw Ethernet frame. bytes is the complete frame including
// Ethernet header. C copies to NIC TX ring.

kernel.netRecvFrame(): number[] | null
// Returns next received frame from RX ring, or null if empty.
// Called by a TypeScript polling loop / IRQ handler.

kernel.netMacAddress(): number[]
// Returns 6-byte MAC address array.

kernel.netIRQ(): void
// Called by the NIC interrupt handler. Unblocks the RX thread.
```

**C does not inspect the frame contents.** It does not know what Ethernet,
ARP, or IP are.

---

## 7b — TCP/IP Stack Wired to Hardware

`src/os/net/net.ts` already has the complete stack in TypeScript (pre-Phase 7
it runs over a loopback stub). Phase 7b replaces the loopback with real NIC
bindings.

```typescript
// net.ts — change the transport layer:
class PhysicalTransport implements Transport {
  sendFrame(frame: Uint8Array): void {
    kernel.netSendFrame(Array.from(frame))
  }
}

// RX loop — runs in a dedicated kernel thread (Phase 5):
function rxThread(): never {
  while (true) {
    const frame = kernel.netRecvFrame()
    if (frame) {
      tcpStack.handlePacket(new Uint8Array(frame))
    } else {
      threadManager.sleepThread(currentThread().tid, 1)  // 1ms poll
    }
  }
}
```

No ARP logic, no IP routing, no TCP state machine moves to C. The stack is
identical to Phase 1 — only the bottom transport changes.

### ARP Resolution

ARP request/response logic is in TypeScript. The ARP table maps IPv4 addresses
to MAC addresses and is maintained by `net.ts`.

---

## 7c — POSIX Socket API (src/os/net/sockets.ts)

All socket fds integrate with Phase 6b's `FDTable` so `select`/`epoll` work
transparently.

```typescript
class TCPSocketDescription implements FileDescription {
  private socket: TCPSocket   // from net.ts internal API
  read(count: number): Uint8Array    { return this.socket.recv(count) }
  write(data: Uint8Array): number    { this.socket.send(data); return data.length }
  poll(): { readable: boolean; ... } { return this.socket.poll() }
  ioctl(req: number, arg?: number)   { /* FIONREAD etc. */ }
  close(): void                      { this.socket.close() }
}

// POSIX socket syscalls (added to syscalls.ts):
function socket(domain: number, type: number, protocol: number): number
function bind(fd: number, addr: SockAddr): void
function connect(fd: number, addr: SockAddr): void
function listen(fd: number, backlog: number): void
function accept(fd: number): number       // returns new fd
function send(fd: number, data: Uint8Array, flags: number): number
function recv(fd: number, len: number, flags: number): Uint8Array
function sendto(fd: number, data: Uint8Array, addr: SockAddr): number
function recvfrom(fd: number, len: number): { data: Uint8Array; addr: SockAddr }
function setsockopt(fd: number, level: number, opt: number, val: any): void
function getsockopt(fd: number, level: number, opt: number): any
function shutdown(fd: number, how: number): void
function getaddrinfo(host: string, service: string): AddrInfo[]
function gethostbyname(host: string): string   // DNS lookup
```

### Domain / Type Support

| AF | Type | Description |
|---|---|---|
| `AF_INET` | `SOCK_STREAM` | TCP |
| `AF_INET` | `SOCK_DGRAM` | UDP |
| `AF_UNIX` | `SOCK_STREAM` | Unix domain (over pipe, Phase 6c) |

`AF_INET6` is post-Phase 9.

---

## 7d — DHCP Client and DNS Resolver

Both run as init system services (using the Phase 1 init.ts API). They start
after the NIC is detected.

### DHCP (TypeScript — src/os/net/dhcp.ts)

```typescript
class DHCPClient {
  async discover(): Promise<DHCPOffer>
  async request(offer: DHCPOffer): Promise<DHCPAck>
  async renew(): Promise<void>

  // Result stored in network config:
  address: string         // e.g. "192.168.1.100"
  netmask: string
  gateway: string
  dns: string[]
  leaseExpires: number    // ticks
}
```

DHCP uses UDP broadcast on port 67/68 via the socket API.

### DNS Resolver (TypeScript — src/os/net/dns.ts)

```typescript
class DNSResolver {
  async resolve(hostname: string): Promise<string[]>   // returns IP addresses
  async reverseLookup(ip: string): Promise<string>
  // Caches results with TTL
  readonly servers: string[]   // from DHCP
}
```

DNS uses UDP port 53, falling back to TCP for large responses.

---

## 7e — TLS (lib/mbedtls/)

mbedTLS is a third-party library. It lives in `lib/` and is **not part of JSOS**.

```
lib/
  mbedtls/
    include/mbedtls/   headers
    library/           source files
    jsos-adapter.c     I/O callbacks + entropy source
```

### JSOS mbedTLS Adapter (jsos-adapter.c)

```c
// mbedtls requires a net_send and net_recv callback:
static int jsos_net_send(void *ctx, const unsigned char *buf, size_t len) {
  // calls our socket write via a QuickJS round-trip
}
static int jsos_net_recv(void *ctx, unsigned char *buf, size_t len) {
  // calls our socket read
}
// Entropy: reads /dev/urandom (Phase 6e)
static int jsos_entropy(void *data, unsigned char *output, size_t len, size_t *olen) {
  // reads from /dev/urandom fd
}
```

### TypeScript TLS Socket Wrapper (src/os/net/tls.ts)

```typescript
class TLSSocket {
  constructor(private rawFd: number, private hostname: string)

  async handshake(): Promise<void>
  read(count: number): Uint8Array
  write(data: Uint8Array): number
  close(): void
}

// Used by the browser, fetch API, etc.:
function connectTLS(host: string, port: number): Promise<TLSSocket>
```

---

## New C Files

| File | Description |
|---|---|
| `src/kernel/virtio_net.c` | virtio-net NIC driver primitives |
| `src/kernel/e1000.c` | Intel E1000 NIC driver primitives |
| `src/kernel/pci.c` | PCI bus scan (already needed for ATA in Phase 2, may exist) |

## New TypeScript Files

| File | Description |
|---|---|
| `src/os/net/sockets.ts` | POSIX socket API + FDTable integration |
| `src/os/net/dhcp.ts` | DHCP client service |
| `src/os/net/dns.ts` | DNS resolver |
| `src/os/net/tls.ts` | TLS wrapper around mbedTLS |

## Third-Party Libraries Added

| Library | Location | Purpose |
|---|---|---|
| mbedTLS | `lib/mbedtls/` | TLS 1.2/1.3 |

---

## Test Oracle

```
[SERIAL] virtio-net found at PCI 00:03.0
[SERIAL] MAC: 52:54:00:12:34:56
[SERIAL] DHCP: acquired 10.0.2.15/24 gw 10.0.2.2
[SERIAL] DNS: resolved example.com → 93.184.216.34
[SERIAL] TCP connect to 93.184.216.34:80: OK
[SERIAL] TLS handshake: OK
[SERIAL] HTTPS GET /: 200 OK (received 1256 bytes)
[SERIAL] Socket test suite: PASS
```

---

## What Phase 7 Does NOT Do

- ❌ No IPv6 (post-Phase 9; Chromium works on IPv4)
- ❌ No QUIC / HTTP/3 (mbedTLS covers HTTP/2 via TLS)
- ❌ No WiFi (PCI devices only — Ethernet)
- ❌ No `sendfile`, `splice` optimisation
- ❌ No SO_REUSEPORT
