# JSOS: 1,000 Things Before Release

> Generated 2026-02-25. Items are grouped by subsystem. P0 = blocks launch, P1 = required for usability, P2 = important, P3 = nice-to-have.

---

## 1. KERNEL / BOOT (src/kernel/)

### 1.1 Boot & Startup
1. [P0] Multiboot2 header support (current is Multiboot1 only)
2. [P0] GRUB2 native boot without xorriso ISO workaround
3. [P0] UEFI/GPT boot path (GRUB EFI stub)
4. [P0] Boot parameter parsing (kernel command line: `root=`, `quiet`, `debug`)
5. [P0] Proper stack canary setup before entering C
6. [P1] FPU/SSE state initialization (`FNINIT`, `FXSAVE` area)
7. [P1] CR4 flags: enable SSE (`OSFXSR`), `OSXMMEXCPT`
8. [P1] CPUID feature detection at boot (SSE2, PAE, NX bit, APIC)
9. [P1] A20 line enable with fallback (BIOS int 15h -> Fast A20 -> KBC)
10. [P1] Parse BIOS memory map (E820) and pass to memory manager
11. [P1] ACPI RSDP detection and table parsing
12. [P2] EFI memory map handoff support
13. [P2] Secure Boot compatibility (no unsigned code execution)
14. [P2] Bootloader logo / splash screen
15. [P2] Boot timeout countdown display
16. [P3] GRUB menu with multiple kernel options
17. [P3] PXE/netboot support

### 1.2 Interrupts & Exceptions
18. [P0] Full IDT: all 256 vectors properly initialized
19. [P0] CPU exception handlers for all 32 vectors (0–31) with register dump
20. [P0] Double fault handler with separate stack (IST1)
21. [P0] Page fault handler wired to virtual memory manager
22. [P0] GP fault handler with proper error code decoding
23. [P1] NMI handler (non-maskable interrupt)
24. [P1] APIC initialization (local APIC + I/O APIC)
25. [P1] PIC (8259A) cascade mode -> APIC migration path
26. [P1] IRQ priority levels (TPR register)
27. [P1] Spurious interrupt handling
28. [P2] IOAPIC RedTable programming for all ISA IRQs
29. [P2] MSI (Message Signaled Interrupts) for PCI devices
30. [P2] x2APIC support
31. [P3] SMP: inter-processor interrupts (IPI)
32. [P3] SIMD exception handler (SSE/AVX faults)

### 1.3 Memory (C layer)
33. [P0] Physical memory allocator: proper free-list after E820 parsing
34. [P0] Physical page allocator: buddy system or bitmap allocator
35. [P0] Fix hardcoded `0x400000` heap base — derive from linker symbols
36. [P0] Guard pages around kernel stack
37. [P1] PAE (Physical Address Extension) support for >4GB physical RAM
38. [P1] NX bit support in page tables
39. [P1] TLB shootdown on page unmap
40. [P1] `mmap`-style physical region reservations for MMIO
41. [P2] NUMA-aware page allocation
42. [P2] Large page (4MB) support for kernel mappings
43. [P2] Physical memory statistics export to JS
44. [P3] Memory hotplug stubs

### 1.4 Timers
45. [P0] PIT channel 0: verify 1ms tick accuracy
46. [P0] TSC calibration against PIT for high-res timing
47. [P1] HPET detection and initialization
48. [P1] `clock_gettime` with nanosecond resolution via TSC
49. [P1] APIC timer for per-CPU preemption
50. [P2] RTC (CMOS) read for wall-clock time at boot
51. [P2] NTP synchronization via network (TypeScript)
52. [P3] ACPI PM timer fallback

### 1.5 Keyboard / Input
53. [P0] PS/2 keyboard: full scancode set 2 translation table
54. [P0] Ctrl+C, Ctrl+D, Ctrl+Z signal generation
55. [P0] Shift, CapsLock, NumLock, ScrollLock state tracking
56. [P0] Alt+Fx virtual terminal switching
57. [P1] PS/2 mouse: 3-button + scroll wheel packet parsing
58. [P1] USB HID keyboard driver (basic, via UHCI/OHCI)
59. [P1] USB HID mouse driver
60. [P2] Keyboard layout support (QWERTY, AZERTY, DVORAK)
61. [P2] Dead-key composition for international characters
62. [P2] Input method editor (IME) stub
63. [P3] Gamepad HID driver stub
64. [P3] Touchscreen stub

### 1.6 Video / Display
65. [P0] VGA text mode fallback for early panic output
66. [P0] VBE 2.0 EDID read and mode selection
67. [P0] Framebuffer: 32bpp linear, write-combine MTRRs
68. [P1] Virtio-GPU driver (replaces VBE in QEMU virtio mode)
69. [P1] Hardware cursor (SVGA register or virtio cursor plane)
70. [P1] Double-buffered framebuffer (no tearing)
71. [P1] vsync / vblank interrupt
72. [P2] VESA display power management (DPMS)
73. [P2] Multi-monitor support stubs
74. [P2] Resolution change at runtime
75. [P3] KMS/DRM-style driver abstraction layer
76. [P3] HDMI audio detection

### 1.7 Storage (C layer)
77. [P0] ATA PIO: verify LBA48 read/write for disks >128GB
78. [P0] ATA interrupt-driven I/O (currently polling — blocks CPU)
79. [P0] ATA DMA (UDMA) mode for performance
80. [P1] ATAPI (CD-ROM) read support
81. [P1] Virtio-BLK driver for QEMU virtio disks
82. [P1] NVMe driver (admin queue + I/O queue, basic)
83. [P2] SATA AHCI driver
84. [P2] SD/MMC driver stub
85. [P3] USB mass storage class (MSC) driver
86. [P3] Floppy driver (legacy BIOS path)

### 1.8 Network (C layer)
87. [P0] Virtio-net: TX ring not flushed when queue full — fix
88. [P0] Virtio-net: handle multiple RX packets per interrupt
89. [P0] Ethernet frame validation (min frame size, FCS strip)
90. [P1] E1000 NIC driver (most common in QEMU default config)
91. [P1] RTL8139 driver
92. [P2] PCNET driver (VirtualBox default)
93. [P2] USB CDC-ECM networking driver
94. [P3] WiFi (Realtek RTL8188) stub driver

### 1.9 PCI
95. [P0] PCI config space: MSI capability detection and enable
96. [P0] PCI bus/device enumeration: handle multi-function devices
97. [P1] PCI resource allocation: BARs above 4GB (64-bit BARs)
98. [P1] PCIE extended config space (MMIO-based, 256 bytes -> 4KB)
99. [P2] PCI power management (D0/D3 state transitions)
100. [P2] PCI hotplug stub
101. [P3] Thunderbolt/USB4 stub

### 1.10 Kernel Misc
102. [P0] Kernel panic: print full register dump + stack trace to serial
103. [P0] Serial port (COM1) debug output — currently works, needs baud-rate auto-detect
104. [P0] Kernel symbol table embedded in binary for stack trace resolution
105. [P1] ACPI shutdown (`S5` sleep state via ACPI PM)
106. [P1] ACPI reboot
107. [P1] Watchdog timer (if hardware stall > 30s, auto-reboot)
108. [P2] Kernel self-test suite at boot (`--selftest` flag)
109. [P2] KASLR: randomize kernel load address
110. [P3] kprobes / ftrace-style kernel tracing

---

## 2. QUICKJS BINDING (src/kernel/quickjs_binding.c)

111. [P0] JIT hook: handle recursive JS calls through native hot path
112. [P0] JIT hook: guard against re-entry during compilation
113. [P0] Exception propagation from C syscall back to JS (currently swallowed)
114. [P0] `JS_SetMemoryLimit` wired — prevent runaway JS from OOMing kernel
115. [P0] `JS_SetMaxStackSize` wired
116. [P1] Garbage collector: expose `gc()` to JS as `sys.gc()`
117. [P1] QuickJS runtime per-process isolation (separate JSRuntime per process)
118. [P1] Module loader: `import()` dynamic import from filesystem
119. [P1] Module loader: `import()` from built-in packages (`@jsos/net`, etc.)
120. [P1] Shared heap between JS runtimes via SharedArrayBuffer
121. [P1] `Atomics.*` support wired to actual memory operations
122. [P2] SourceMap support for stack traces
123. [P2] QuickJS `debugger` statement → serial port breakpoint
124. [P2] Remote DevTools Protocol over serial/TCP
125. [P2] BigInt64Array / BigUint64Array typed arrays
126. [P3] WASM interpreter integration (wasm3 or wabt)
127. [P3] WASM JSJIT: compile WASM hot functions to x86

---

## 3. VIRTUAL MEMORY MANAGER (src/os/core/)

128. [P0] VirtualMemoryManager: `allocatePages` must track which physical frames are in use
129. [P0] `freePages`: actually unmap pages and return physical frames to allocator
130. [P0] Prevent double-free of physical pages
131. [P0] Stack growth: handle guard page fault by extending stack mapping
132. [P0] Kernel vs userspace page table split (ring 0 vs ring 3 mappings)
133. [P1] Copy-on-write (COW) for forked processes
134. [P1] Memory-mapped files (`mmap` with file backing)
135. [P1] Demand paging: page fault loads data from disk lazily
136. [P1] Swap space: evict LRU pages to disk when physical memory low
137. [P1] Page reclaim: LRU clock algorithm
138. [P1] `/proc/meminfo`-style memory stats export
139. [P2] Huge pages (explicit 4MB allocations for performance)
140. [P2] ASLR for process address spaces
141. [P2] Memory protection keys (MPK)
142. [P2] `madvise(MADV_WILLNEED)` prefetch hint
143. [P3] Transparent huge pages (THP)
144. [P3] ZRAM compressed swap

---

## 4. PROCESS MANAGER (src/os/process/)

145. [P0] ProcessScheduler: O(1) or O(log n) scheduler — current O(n) scan is unbounded
146. [P0] Preemptive scheduling: APIC timer fires `schedule()` every 10ms
147. [P0] Context switch: save/restore FPU/SSE state (`FXSAVE`/`FXRSTOR`)
148. [P0] Process exit: clean up all owned file descriptors
149. [P0] Process exit: release all virtual memory regions
150. [P0] Zombie process reaping (`waitpid`)
151. [P0] `fork()` syscall wired and working
152. [P0] `exec()` syscall: load JS bundle from filesystem and run
153. [P1] `pid_t` namespace: PID 1 = init, wraps at 32768
154. [P1] Process groups and sessions (`setsid`, `setpgrp`)
155. [P1] Signals: SIGTERM, SIGKILL, SIGSTOP, SIGCONT, SIGCHLD, SIGHUP
156. [P1] Signal delivery: interrupt blocked syscall (`SA_RESTART`)
157. [P1] Signal masking (`sigprocmask`)
158. [P1] Signal queuing (real-time signals, `sigqueue`)
159. [P1] `setpriority` / `getpriority` (nice values -20..+19)
160. [P1] Real-time scheduling class (SCHED_FIFO, SCHED_RR)
161. [P2] CPU affinity (`sched_setaffinity`) — preparation for SMP
162. [P2] Process resource limits (`setrlimit`: RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE)
163. [P2] `/proc/<pid>/` virtual filesystem entries
164. [P2] Process accounting (CPU time, wall time, I/O bytes)
165. [P3] Namespaces (PID, mount, network, UTS, IPC, user)
166. [P3] cgroups v2 stubs
167. [P3] Seccomp-style syscall filter

---

## 5. FILE SYSTEM (src/os/fs/ and src/os/storage/)

168. [P0] initramfs: embed initial filesystem image in ISO
169. [P0] VFS layer: mount/unmount with per-mount superblock
170. [P0] VFS: file descriptor table per process
171. [P0] VFS: `open`, `close`, `read`, `write`, `seek`, `stat`
172. [P0] VFS: `readdir`, `mkdir`, `rmdir`, `unlink`, `rename`
173. [P0] VFS: `dup`, `dup2` for file descriptor duplication
174. [P0] VFS: `fcntl` (O_NONBLOCK, F_GETFD, F_SETFD, F_GETFL, F_SETFL)
175. [P0] VFS: `ioctl` dispatch framework
176. [P0] VFS: path resolution with symlink support (max 40 levels)
177. [P0] Implement ext2 read (no journal) — simplest real FS
178. [P1] Implement ext4 read-only (extent tree, large file support)
179. [P1] Implement ext4 write (journaling, metadata journal)
180. [P1] FAT32 read/write (USB drives, shared with host)
181. [P1] tmpfs: RAM-backed filesystem for `/tmp`
182. [P1] procfs: `/proc` virtual filesystem
183. [P1] sysfs: `/sys` virtual filesystem
184. [P1] devfs: `/dev` character devices (null, zero, random, urandom, tty)
185. [P1] `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`
186. [P1] Block device layer: request queue, elevator I/O scheduler
187. [P1] Buffer cache: block-level read cache (LRU eviction)
188. [P1] Page cache: file-level read cache
189. [P1] Writeback: dirty page flush with 30s timeout
190. [P2] ISO 9660 read (boot media access)
191. [P2] OverlayFS (union mount — writable layer over read-only base)
192. [P2] File locking (`flock`, `fcntl` advisory locks)
193. [P2] Extended attributes (`xattr`: user, security, trusted namespaces)
194. [P2] POSIX ACLs
195. [P2] Filesystem quota (per-user block/inode limits)
196. [P2] `inotify` for filesystem event notifications
197. [P2] Sparse file support
198. [P2] Hard links across same device
199. [P2] `sendfile` zero-copy syscall
200. [P3] Btrfs read-only support
201. [P3] ZFS stubs (licensing issues — at least stubs for future)
202. [P3] FUSE-style userspace filesystem driver API
203. [P3] NFS client (NFSv3 or v4)
204. [P3] Samba/CIFS client
205. [P3] Filesystem compression (zstd per-file attribute)
206. [P3] Filesystem encryption (fscrypt or dm-crypt)

---

## 6. IPC (src/os/ipc/)

207. [P0] Anonymous pipes: `pipe()` syscall, kernel ring buffer
208. [P0] Named pipes (FIFO): `mkfifo`, VFS entry in `/dev/fifo/`
209. [P1] Unix domain sockets: `AF_UNIX SOCK_STREAM` and `SOCK_DGRAM`
210. [P1] Unix domain socket: `sendmsg`/`recvmsg` with SCM_RIGHTS (fd passing)
211. [P1] POSIX message queues: `mq_open`, `mq_send`, `mq_receive`
212. [P1] eventfd: lightweight notification primitive
213. [P1] signalfd: read signals as file descriptors
214. [P1] timerfd: timer events as file descriptors
215. [P2] POSIX shared memory: `shm_open`, `mmap(MAP_SHARED)`
216. [P2] System V IPC: `shmget`, `msgget`, `semget` (legacy compat)
217. [P2] `epoll`: level-triggered and edge-triggered modes
218. [P2] `poll` and `select` multiplexing
219. [P2] `io_uring`: submission/completion ring for async I/O
220. [P3] D-Bus protocol as native IPC mechanism
221. [P3] `memfd_create` anonymous shared memory

---

## 7. NETWORK STACK (src/os/net/)

### 7.1 Layer 2
222. [P0] ARP: gratuitous ARP on interface up
223. [P0] ARP: timeout and re-request stale entries
224. [P0] ARP: handle ARP replies for pending TX queue
225. [P1] Ethernet: VLAN 802.1Q tag handling
226. [P1] Ethernet: jumbo frames (MTU > 1500)
227. [P2] Ethernet: 802.3ad link aggregation stubs
228. [P2] Bridge: software Ethernet bridge

### 7.2 IPv4
229. [P0] IP fragmentation: reassemble out-of-order fragments
230. [P0] IP TTL expiry: send ICMP TTL-exceeded back
231. [P0] IP options parsing (record route, timestamp, strict route)
232. [P0] ICMP: echo reply (ping response) working
233. [P0] ICMP: destination unreachable generation
234. [P1] DHCP client: full RFC 2131 (REQUEST/ACK/RENEW/REBIND)
235. [P1] DHCP: route and DNS server options parsed and applied
236. [P1] IP routing table: longest-prefix match
237. [P1] IP multicast: join/leave (`IGMP v2`)
238. [P2] IP source routing
239. [P2] Policy-based routing
240. [P2] `ip rule` equivalents (multiple routing tables)

### 7.3 IPv6
241. [P1] IPv6 basic forwarding and addressing
242. [P1] ICMPv6: neighbor discovery (NDP replacing ARP)
243. [P1] SLAAC: stateless address autoconfiguration (RFC 4862)
244. [P1] DHCPv6 client (stateful config)
245. [P1] IPv6 extension headers: routing, fragmentation, hop-by-hop
246. [P2] MLDv2 (multicast listener discovery)
247. [P2] IPv6 Privacy Extensions (RFC 4941 — random interface IDs)
248. [P3] 6to4 / Teredo tunneling

### 7.4 TCP
249. [P0] TCP: fix RST handling when connection already half-closed
250. [P0] TCP: Nagle algorithm (can be disabled with TCP_NODELAY)
251. [P0] TCP: zero-window probe
252. [P0] TCP: persist timer
253. [P0] TCP: retransmission timeout (RTO) with exponential backoff
254. [P0] TCP: fast retransmit on 3 duplicate ACKs
255. [P1] TCP: SACK (selective acknowledgment) — RFC 2018
256. [P1] TCP: window scaling — RFC 1323
257. [P1] TCP: timestamps — RFC 1323
258. [P1] TCP: MSS negotiation
259. [P1] TCP: CUBIC or New Reno congestion control
260. [P1] TCP: BBR congestion control
261. [P1] TCP: TIME_WAIT state with 2MSL timer
262. [P1] TCP: listen backlog queue
263. [P1] TCP: `SO_REUSEADDR`, `SO_REUSEPORT`
264. [P1] TCP: keepalive (`SO_KEEPALIVE`)
265. [P2] TCP: TCP_FASTOPEN
266. [P2] TCP: connection tracking for NAT
267. [P2] TCP: MD5 authentication (BGP use case)
268. [P3] MPTCP (multipath TCP) stubs
269. [P3] QUIC protocol (UDP-based transport layer)

### 7.5 UDP
270. [P0] UDP: `EADDRINUSE` on bind collision
271. [P0] UDP: broadcast (`SO_BROADCAST`)
272. [P1] UDP: multicast send/receive
273. [P1] UDP: `SO_RCVBUF` / `SO_SNDBUF` tunable
274. [P2] DTLS (Datagram TLS) — for WebRTC data channels
275. [P3] SCTP (stream control transmission protocol)

### 7.6 DNS
276. [P0] DNS: TTL-based cache expiry (currently session-global, no TTL honored)
277. [P0] DNS: AAAA record queries and response parsing
278. [P0] DNS: retransmit query on timeout (3 retries, exponential backoff)
279. [P0] DNS: multiple nameserver support with fallback
280. [P1] DNS: `/etc/resolv.conf`-style reading from filesystem
281. [P1] DNS: `/etc/hosts` file lookup before DNS query
282. [P1] DNS: CNAME chain resolution
283. [P1] DNSSEC: signature validation (RRSIG, DNSKEY, DS)
284. [P2] DNS-over-HTTPS (DoH) — RFC 8484
285. [P2] DNS-over-TLS (DoT) — RFC 7858
286. [P2] mDNS: `.local` name resolution (RFC 6762)
287. [P3] DNS: full recursive resolver (not just stub)

### 7.7 TLS
288. [P0] TLS: session resumption (session tickets, RFC 5077)
289. [P0] TLS: SNI (Server Name Indication) — critical for shared hosting
290. [P0] TLS: certificate chain validation (full PKI)
291. [P0] TLS: system trust store (Mozilla root CA bundle embedded)
292. [P0] TLS: certificate revocation (CRL download or OCSP)
293. [P1] TLS: OCSP stapling
294. [P1] TLS: ALPN negotiation (announce `h2` for HTTP/2 preference)
295. [P1] TLS: ChaCha20-Poly1305 cipher suite
296. [P1] TLS: ECDSA certificate support (not just RSA)
297. [P2] TLS 1.2 fallback for older servers
298. [P2] TLS: client certificates
299. [P2] TLS: certificate pinning API
300. [P3] QUIC/TLS 1.3 unified handshake

### 7.8 HTTP
301. [P0] HTTP: chunked transfer encoding decode (many servers send chunked)
302. [P0] HTTP: redirect loop detection (max 10 redirects)
303. [P0] HTTP: cookie jar — store, send, expire (RFC 6265)
304. [P0] HTTP: `Set-Cookie` header parsing (domain, path, SameSite, Secure, HttpOnly)
305. [P0] HTTP: multipart/form-data POST encoding
306. [P0] HTTP: `Content-Length` vs `Transfer-Encoding` precedence
307. [P1] HTTP/2: HPACK header compression
308. [P1] HTTP/2: multiplexed streams over single TLS connection
309. [P1] HTTP/2: server push handling
310. [P1] HTTP/2: flow control (stream-level and connection-level)
311. [P1] HTTP/2: SETTINGS frame negotiation
312. [P1] HTTP/2: priority and dependency tree
313. [P2] HTTP/3: QUIC transport
314. [P2] WebSocket: `Upgrade: websocket` handshake + framing (RFC 6455)
315. [P2] WebSocket: ping/pong keepalive
316. [P2] Server-Sent Events (SSE) streaming reads
317. [P2] HTTP cache: `ETag` + `If-None-Match` support
318. [P2] HTTP cache: `Last-Modified` + `If-Modified-Since` support
319. [P2] HTTP cache: `Vary` header awareness
320. [P3] HTTP/2 push promise cache pre-population
321. [P3] CORS preflight request handling
322. [P3] Fetch API: `ReadableStream` body streaming

---

## 8. TLS / CRYPTO (src/os/net/tls.ts, crypto)

323. [P0] RSA: PKCS#1 v1.5 verify (needed for older certs)
324. [P0] RSA: PSS verify (needed for TLS 1.3 certs)
325. [P0] ECDSA: P-384 support (many CAs use P-384 now)
326. [P0] AES-GCM: verify tag failure returns proper error, not silent corruption
327. [P0] ChaCha20-Poly1305 cipher suite implementation
328. [P1] SHA-384 hash implementation (used in TLS 1.3 cipher suites)
329. [P1] HMAC-SHA384
330. [P1] HKDF-Expand with SHA-384
331. [P1] X.509: parse `subjectAltName` extension for hostname validation
332. [P1] X.509: parse `basicConstraints` + `keyUsage` extensions
333. [P1] X.509: certificate chain length validation
334. [P1] X.509: validity date range check (notBefore, notAfter)
335. [P1] X.509: name comparison case-insensitive ASCII
336. [P1] Ed25519 signature verification
337. [P2] Curve448 / X448 key exchange
338. [P2] AES-CBC with HMAC-SHA256 (TLS 1.2 fallback ciphers)
339. [P2] RSA key generation (for self-signed certs)
340. [P2] ECDSA key generation (P-256)
341. [P2] `window.crypto.subtle` — full Web Crypto API implementation
342. [P2] `SubtleCrypto.importKey` (JWK, raw, SPKI, PKCS8 formats)
343. [P2] `SubtleCrypto.encrypt`/`decrypt` (AES-GCM, AES-CBC)
344. [P2] `SubtleCrypto.sign`/`verify` (ECDSA, HMAC)
345. [P2] `SubtleCrypto.deriveKey` / `deriveBits` (ECDH, HKDF, PBKDF2)
346. [P3] Post-quantum: Kyber-768 key exchange stubs
347. [P3] Post-quantum: Dilithium3 signature stubs
348. [P3] Hardware RNG (RDRAND instruction) instead of Math.random()

---

## 9. BROWSER — HTML PARSER (src/os/apps/browser/html.ts)

349. [P0] `<!DOCTYPE>` handling — detect quirks mode
350. [P0] HTML entities: full named entity table (&nbsp; &amp; &lt; &gt; &copy; etc.) — currently only basic 5
351. [P0] Numeric character references: decimal (&#160;) and hex (&#xA0;)
352. [P0] Attribute values: unquoted and single-quoted in addition to double-quoted
353. [P0] Void elements: br, hr, img, input, link, meta, area, base, col, embed, param, source, track, wbr
354. [P0] `<script>` tag: CDATA content (don't parse `</` inside script)
355. [P0] `<style>` tag: CDATA content (don't parse `</` inside style)
356. [P0] `<textarea>`, `<pre>`: preserve whitespace, no child tags parsed
357. [P0] `<template>` tag: parse into document fragment
358. [P1] WHATWG HTML5 tokenizer state machine (current parser is ad-hoc)
359. [P1] Implicit tag closing (e.g., `<p>` closes previous `<p>`)
360. [P1] Misnested tags: foster parenting algorithm
361. [P1] `<table>` foster parenting for text nodes
362. [P1] Full insertion mode state machine (in_body, in_table, in_caption, etc.)
363. [P1] `<noscript>` rendered when JS is disabled
364. [P1] `<base href="...">` affects all relative URL resolution
365. [P1] Incremental HTML parsing (don't block render on slow network)
366. [P2] `<picture>` + `<source srcset>` image selection
367. [P2] `<video>` and `<audio>` stub elements
368. [P2] `<iframe>` — nested browsing context
369. [P2] `<canvas>` element rendering (wire to canvas 2D context)
370. [P2] HTML sanitizer for `innerHTML` assignment
371. [P3] SVG inline parsing
372. [P3] MathML parsing

---

## 10. BROWSER — CSS ENGINE (src/os/apps/browser/css.ts, stylesheet.ts)

373. [P0] CSS `@media` queries: `max-width`, `min-width`, `prefers-color-scheme`
374. [P0] CSS `@import` rule: load and parse linked stylesheet
375. [P0] CSS specificity: proper (0,1,0) vs (0,0,1) calculation
376. [P0] CSS pseudo-classes: `:hover`, `:active`, `:focus`, `:disabled`, `:checked`
377. [P0] CSS pseudo-classes: `:first-child`, `:last-child`, `:nth-child(n)`, `:not()`
378. [P0] CSS pseudo-elements: `::before`, `::after` with `content:` property
379. [P0] CSS inheritance: `color`, `font-*`, `line-height` inherit by default
380. [P0] CSS `inherit`, `initial`, `unset`, `revert` keywords
381. [P0] CSS `!important` in specificity calculation
382. [P0] CSS shorthand properties: `margin`, `padding`, `border` expansion
383. [P0] CSS `border-radius`
384. [P0] CSS `border` shorthand (width/style/color)
385. [P0] CSS `background` shorthand
386. [P0] CSS `background-image: url(...)` → trigger image fetch
387. [P0] CSS `background-size`, `background-position`, `background-repeat`
388. [P0] CSS `box-shadow`
389. [P0] CSS `text-shadow`
390. [P0] CSS `text-decoration` (underline, line-through, none)
391. [P0] CSS `line-height`
392. [P0] CSS `letter-spacing`, `word-spacing`
393. [P0] CSS `text-transform` (uppercase, lowercase, capitalize)
394. [P0] CSS `white-space`: normal, nowrap, pre, pre-wrap, pre-line
395. [P0] CSS `overflow`: visible, hidden, scroll, auto
396. [P0] CSS `position`: static, relative, absolute, fixed, sticky
397. [P0] CSS `top`, `right`, `bottom`, `left` for positioned elements
398. [P0] CSS `z-index` stacking context
399. [P0] CSS `float`: left, right, none + clearfix
400. [P0] CSS `clear`: left, right, both
401. [P1] CSS Flexbox: `display: flex`, `flex-direction`, `justify-content`, `align-items`, `flex-wrap`, `gap`
402. [P1] CSS Flexbox: `flex-grow`, `flex-shrink`, `flex-basis`, `flex` shorthand
403. [P1] CSS Flexbox: `align-self`, `order`
404. [P1] CSS Grid: `display: grid`, `grid-template-columns/rows`, `grid-column/row`
405. [P1] CSS Grid: `fr` unit, `repeat()`, `minmax()`
406. [P1] CSS Grid: `grid-area`, `grid-template-areas`
407. [P1] CSS Grid: `gap` / `row-gap` / `column-gap`
408. [P1] CSS `calc()` expression evaluation
409. [P1] CSS custom properties (variables): inheritance through DOM tree (currently session-global only)
410. [P1] CSS `transition`: `transition-property`, `transition-duration`, `transition-timing-function`
411. [P1] CSS `animation`: `@keyframes`, `animation-name`, `animation-duration`, `animation-iteration-count`
412. [P1] CSS `transform`: `translate`, `rotate`, `scale`, `matrix`, `skew`
413. [P1] CSS `transform-origin`
414. [P1] CSS `opacity` smooth values (currently only hidden if < 0.15)
415. [P1] CSS `pointer-events`
416. [P1] CSS `cursor` property (at least `pointer`, `default`, `text`, `not-allowed`)
417. [P1] CSS `list-style-type`: disc, circle, square, decimal, none
418. [P1] CSS `table-layout`: fixed, auto
419. [P1] CSS `border-collapse`, `border-spacing`
420. [P1] CSS `vertical-align`
421. [P1] CSS `word-break`, `overflow-wrap`
422. [P2] CSS `clip-path`
423. [P2] CSS `filter`: blur, brightness, contrast, grayscale, hue-rotate
424. [P2] CSS `backdrop-filter`
425. [P2] CSS `mix-blend-mode`
426. [P2] CSS `appearance` property
427. [P2] CSS `resize` property
428. [P2] CSS `will-change` (hint for GPU acceleration planning)
429. [P2] CSS `contain`
430. [P2] CSS `@font-face` rule: download and register web fonts
431. [P2] CSS `font-family` — at minimum serif/sans-serif/monospace fallback chains
432. [P2] CSS `font-weight`: 100–900 mapped to rendering
433. [P2] CSS `font-style`: italic/oblique
434. [P2] CSS `counter-reset`, `counter-increment`, `content: counter()`
435. [P2] CSS `@supports` at-rule
436. [P2] CSS `@layer` cascade layers
437. [P3] CSS Houdini Paint API stub
438. [P3] CSS `@container` queries
439. [P3] CSS subgrid
440. [P3] CSS `color-scheme`, `color-mix()`, `color-contrast()`

---

## 11. BROWSER — LAYOUT ENGINE (src/os/apps/browser/layout.ts)

441. [P0] Block formatting context (BFC) — currently simplified
442. [P0] Inline formatting context: line breaking with proper word boundary
443. [P0] Intrinsic sizes: min-content, max-content, fit-content
444. [P0] `width: auto` for block elements (stretch to parent)
445. [P0] `height: auto` (shrink-wrap to content)
446. [P0] Margin collapsing (adjacent block margins)
447. [P0] `padding` in layout calculations
448. [P0] `border-box` vs `content-box` box model (`box-sizing`)
449. [P0] Table layout algorithm (fixed + auto)
450. [P0] `<li>` marker box layout (bullet/number positioning)
451. [P1] Flexbox layout pass
452. [P1] Grid layout pass
453. [P1] Absolute positioning relative to nearest positioned ancestor
454. [P1] Fixed positioning relative to viewport
455. [P1] Sticky positioning
456. [P1] Float layout and line-box narrow-around-float
457. [P1] Multi-column layout (`column-count`, `column-width`)
458. [P1] Inline-block layout
459. [P1] `overflow: scroll` — clip and add scrollbar
460. [P1] `overflow: hidden` — clip without scrollbar
461. [P1] Scrollable container scroll offset (currently no scrolling inside elements)
462. [P1] Viewport scroll: `window.scrollY`, `window.scrollX` accurate
463. [P2] Writing modes (`writing-mode: vertical-rl`)
464. [P2] BiDi (bidirectional text — Arabic, Hebrew)
465. [P2] `text-overflow: ellipsis`
466. [P2] CSS shapes: `shape-outside` for float wrapping
467. [P2] Baseline alignment in inline contexts
468. [P2] Ruby text layout (`<ruby>`, `<rt>`)
469. [P3] Subpixel layout (fractional pixel positions)
470. [P3] CSS regions / page-break layout for printing

---

## 12. BROWSER — RENDERING (src/os/apps/browser/index.ts, layout.ts)

471. [P0] Render actual bitmap font at multiple sizes (not just 8×8 fixed)
472. [P0] Font metrics: character width table for proportional fonts
473. [P0] Anti-aliased text rendering (grayscale coverage sampling)
474. [P0] Sub-pixel RGB text rendering (ClearType-style)
475. [P0] JPEG image decode: full DCT + quantization + Huffman (`img-jpeg.ts`)
476. [P0] PNG image decode: interlaced PNG support (`img-png.ts`)
477. [P0] GIF image decode: basic (LZW decoder)
478. [P0] GIF animation: frame disposal and timing
479. [P0] WebP image decode (VP8L lossless + VP8 lossy)
480. [P0] SVG rendering: basic shapes (rect, circle, path, text)
481. [P1] GPU compositing: paint layers to separate buffers, composite at end
482. [P1] Dirty region tracking: only repaint changed rectangles
483. [P1] Scroll: partial repaint (fixed header stays, only scroll area repaints)
484. [P1] Alpha compositing for `opacity` and RGBA colors
485. [P1] Rounded rectangle rendering (`border-radius`)
486. [P1] Box shadow rendering
487. [P1] Gradient rendering: linear-gradient, radial-gradient, conic-gradient
488. [P1] `::before`/`::after` pseudo-element rendering
489. [P1] Clipping path rendering
490. [P1] Stacking context correct paint order (z-index)
491. [P2] `<canvas>` 2D rendering wired to framebuffer
492. [P2] WebGL 1.0 stub (software rasterizer — very slow but functional)
493. [P2] WOFF/WOFF2 font decode and rasterization (FreeType or stb_truetype)
494. [P2] Emoji rendering (color emoji bitmap font)
495. [P2] ICC color profile support
496. [P3] Hardware-accelerated 2D via Virtio-GPU

---

## 13. BROWSER — JAVASCRIPT RUNTIME (src/os/apps/browser/jsruntime.ts)

497. [P0] `window.location.assign()`, `.replace()`, `.reload()`
498. [P0] `history.pushState()`, `history.replaceState()`, `history.back()`, `history.forward()`
499. [P0] `popstate` event firing on history navigation
500. [P0] `localStorage` persistence across page loads (write to filesystem)
501. [P0] `sessionStorage` scoped per tab/window
502. [P0] `IndexedDB` stub — at minimum key-value store
503. [P0] `FormData`: `entries()`, `keys()`, `values()`, `delete()`, `has()`
504. [P0] `URL` class: `searchParams` (URLSearchParams), `pathname`, `hash` mutation
505. [P0] `URLSearchParams`: `set`, `get`, `getAll`, `has`, `delete`, `append`, `toString`
506. [P0] `Fetch` API: `Request`, `Response` objects with proper Body mixin
507. [P0] `Response.json()`, `.text()`, `.arrayBuffer()`, `.blob()` all working
508. [P0] `Headers` class: `get`, `set`, `append`, `delete`, `has`, `entries`
509. [P0] `AbortController` + `AbortSignal` actually abort fetch
510. [P0] `Promise.allSettled`, `Promise.any`, `Promise.race`
511. [P0] `async`/`await` properly integrated with event loop tick
512. [P1] `MutationObserver`: actually fire callbacks when DOM changes
513. [P1] `IntersectionObserver`: fire callbacks with viewport intersection data
514. [P1] `ResizeObserver`: fire callbacks when element size changes
515. [P1] `CustomEvent` with `detail` property
516. [P1] Event bubbling: propagate events up DOM tree
517. [P1] Event capturing phase
518. [P1] `event.stopPropagation()`, `event.preventDefault()`, `event.stopImmediatePropagation()`
519. [P1] `event.target` vs `event.currentTarget`
520. [P1] `KeyboardEvent` with `key`, `code`, `keyCode`, `ctrlKey`, `shiftKey`, `altKey`, `metaKey`
521. [P1] `MouseEvent` with `clientX/Y`, `pageX/Y`, `screenX/Y`, `button`, `buttons`
522. [P1] `InputEvent` for `<input>` / `<textarea>` changes
523. [P1] `FocusEvent` (focus, blur, focusin, focusout)
524. [P1] `SubmitEvent` from form submission
525. [P1] `WheelEvent` / scroll events
526. [P1] `TouchEvent` stubs
527. [P1] `PointerEvent` stubs
528. [P1] `DragEvent` stubs
529. [P1] `ClipboardEvent` stubs (with permissions check)
530. [P1] `window.onload`, `DOMContentLoaded` firing at correct time
531. [P1] `document.readyState` transitions: `loading` → `interactive` → `complete`
532. [P1] `<script type="module">` support — ES module loading
533. [P1] ES module: `import.meta.url`
534. [P1] Dynamic `import()` returning a Promise
535. [P2] `Worker` API: run JS in separate QuickJS context
536. [P2] `SharedWorker` stub
537. [P2] `ServiceWorker` stub (needed for PWA)
538. [P2] `Notification` API stub
539. [P2] `Geolocation` API stub
540. [P2] `navigator.mediaDevices` stub (camera/mic)
541. [P2] `WebRTC` stubs (`RTCPeerConnection`)
542. [P2] `WebSocket` constructor wired to TCP/TLS net stack
543. [P2] `BroadcastChannel` between workers
544. [P2] `PerformanceObserver` stub
545. [P2] `window.requestIdleCallback`
546. [P2] `Intl` — internationalization: `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.Collator`
547. [P2] `Proxy` and `Reflect` used by many frameworks — test compatibility
548. [P2] `WeakRef` and `FinalizationRegistry`
549. [P3] Shadow DOM: `attachShadow`, `shadowRoot`, style scoping
550. [P3] Custom Elements: `customElements.define`
551. [P3] Web Components full lifecycle callbacks
552. [P3] `Worklet` API

---

## 14. BROWSER — DOM API (src/os/apps/browser/dom.ts)

553. [P0] `element.innerHTML` setter: full HTML re-parse + DOM rebuild
554. [P0] `element.outerHTML` getter
555. [P0] `element.textContent` setter (replace all child nodes with text)
556. [P0] `element.insertAdjacentHTML` (beforebegin, afterbegin, beforeend, afterend)
557. [P0] `element.insertAdjacentElement`, `element.insertAdjacentText`
558. [P0] `element.before()`, `element.after()`, `element.replaceWith()`, `element.remove()`
559. [P0] `element.append()`, `element.prepend()` (multi-node variants)
560. [P0] `element.replaceChildren()` 
561. [P0] `node.insertBefore(newNode, referenceNode)` correct position
562. [P0] `element.cloneNode(true)` deep clone including attributes
563. [P0] `element.setAttribute` triggering re-style
564. [P0] `element.removeAttribute`
565. [P0] `element.hasAttribute`, `element.toggleAttribute`
566. [P0] `element.getAttributeNames()`
567. [P0] `element.matches(selector)` — CSS selector test
568. [P0] `element.closest(selector)` — walk up ancestors
569. [P0] `element.querySelectorAll` — `:nth-child`, `:not`, attribute selectors
570. [P0] `element.classList.toggle(cls, force)`
571. [P0] `element.classList.replace(old, new)`
572. [P0] `element.classList.contains()`
573. [P0] `element.classList.entries()`, `values()`, `forEach()`
574. [P0] `document.createComment()`
575. [P0] `document.createProcessingInstruction()`
576. [P1] `element.style` property access triggers re-render (currently only on explicit calls)
577. [P1] CSSOM: `getComputedStyle` returns live values (not static snapshot)
578. [P1] CSSOM: `CSSStyleSheet` add/remove rules dynamically
579. [P1] CSSOM: `document.styleSheets` list
580. [P1] DOM Range: `document.createRange()`, `range.setStart/End`, `range.extractContents()`
581. [P1] Selection API: `window.getSelection()`, `sel.getRangeAt(0)`
582. [P1] `Node.ELEMENT_NODE`, `TEXT_NODE`, `COMMENT_NODE` constants
583. [P1] `DocumentFragment` as lightweight container
584. [P1] Slot element (`<slot>`) for web components
585. [P2] `element.animate()` Web Animations API
586. [P2] `element.scrollIntoView()`
587. [P2] `element.focus()`, `element.blur()` — update activeElement
588. [P2] `document.elementFromPoint(x, y)` hit testing
589. [P2] `document.elementsFromPoint(x, y)` (all elements at point)
590. [P2] `element.getClientRects()` — multiple DOMRects
591. [P3] XPath: `document.evaluate()`
592. [P3] `document.all` legacy collection

---

## 15. BROWSER — FORMS & INPUT

593. [P0] `<input type="text">` renders editable field, captures keyboard input
594. [P0] `<input type="password">` masks characters
595. [P0] `<input type="checkbox">` toggle state, `change` event
596. [P0] `<input type="radio">` group mutual exclusion
597. [P0] `<input type="submit">` triggers form submission
598. [P0] `<input type="button">` fires `click` event
599. [P0] `<input type="hidden">` included in form submission
600. [P0] `<textarea>` multiline edit
601. [P0] `<select>` + `<option>` dropdown rendering and selection
602. [P0] `<form>` action + method GET/POST wired to browser navigation/XHR
603. [P0] Form validation: `required`, `minlength`, `maxlength`, `pattern`
604. [P0] Form serialization: `application/x-www-form-urlencoded`
605. [P1] `<input type="email">` validation
606. [P1] `<input type="url">` validation
607. [P1] `<input type="number">` with min/max/step
608. [P1] `<input type="range">` slider
609. [P1] `<input type="date">`, `<input type="time">` pickers
610. [P1] `<input type="color">` color picker
611. [P1] `<input type="file">` — VFS file picker dialog
612. [P1] Autofocus (`autofocus` attribute)
613. [P1] Tab order (`tabindex`)
614. [P1] `<datalist>` autocomplete suggestions
615. [P2] Constraint Validation API (`checkValidity()`, `reportValidity()`, `setCustomValidity()`)
616. [P2] `<input type="search">` with clear button
617. [P2] IME input mode for CJK
618. [P3] Form autofill / password manager integration

---

## 16. BROWSER — NAVIGATION & TABS

619. [P0] Back/forward navigation with history preservation
620. [P0] URL bar shows current URL, accepts input, navigates on Enter
621. [P0] Page loading progress indicator
622. [P0] Cancel ongoing page load (stop button)
623. [P0] Reload page (F5 / Ctrl+R)
624. [P0] Hard reload — clear cache for current page (Ctrl+Shift+R)
625. [P1] Multiple tabs — each with independent DOM, JS context, history
626. [P1] Tab create, close, switch
627. [P1] Tab title from `<title>` element
628. [P1] Tab favicon from `<link rel="icon">`
629. [P1] New tab page (local start page)
630. [P1] Bookmarks: add, remove, open
631. [P1] Bookmark folder organization
632. [P1] Address bar autocomplete from history + bookmarks
633. [P2] Find in page (Ctrl+F) — highlight matches in rendered DOM
634. [P2] Reader mode (strip ads/nav, clean article rendering)
635. [P2] Print page to PDF or thermal printer
636. [P2] Download manager: save resource to disk with progress
637. [P2] View page source
638. [P2] `data:` URL support
639. [P2] `blob:` URL for object URLs
640. [P3] Browser sync / bookmarks cloud backup
641. [P3] Extensions / userscript runner

---

## 17. TYPESCRIPT REPL & TERMINAL (src/os/apps/)

> Philosophy: no shell language. Everything is a TypeScript function call. `ls()`, `cd('/etc')`, `ping('8.8.8.8')`, `fetch('https://...')`. The REPL *is* the shell.

### 17.1 REPL Core
642. [P0] Input history: up/down arrows cycle through previous expressions
643. [P0] Persistent history: save/load history to `/home/.repl_history` across sessions
644. [P0] Multi-line input: Shift+Enter adds a new line; Enter on incomplete expression continues
645. [P0] Syntax error detection before execution (highlight bad input in red)
646. [P0] `await` at top level — `await fetch('https://...')` just works
647. [P0] Result pretty-printing: objects/arrays rendered as expandable trees
648. [P0] `undefined` and `null` shown distinctly (dimmed, not silent)
649. [P0] Errors shown with stack trace, file+line highlighted
650. [P0] Tab completion: complete variable names, property chains (`sys.net.<TAB>`)
651. [P0] Tab completion: complete function signatures with type hints
652. [P0] Tab completion: filesystem paths in string arguments (`ls('/et<TAB>')`)
653. [P1] Multiple terminal instances: open N REPLs simultaneously, each isolated context
654. [P1] Terminal tabs: switch between instances with Ctrl+Tab or GUI tab bar
655. [P1] Each REPL tab has its own variable scope and history
656. [P1] Named REPL sessions: `repl.open('debug')` opens labelled tab
657. [P1] `repl.close()` closes current terminal instance
658. [P1] Copy REPL context to new tab (clone variables and imports)
659. [P1] REPL startup script: `/etc/repl.ts` executes on every new instance
660. [P1] Per-user startup script: `/home/<user>/.repl.ts`
661. [P1] `import` statements work at REPL prompt — load any OS module dynamically
662. [P1] `help(fn)` prints JSDoc for any built-in function
663. [P1] `help()` with no args prints overview of all top-level APIs
664. [P1] `clear()` clears screen output
665. [P1] `reset()` clears current REPL context (variables, imports)

### 17.2 Terminal Rendering Quality
666. [P1] ANSI SGR: 16-color, 256-color, 24-bit true color foreground + background
667. [P1] Bold, italic, underline, strikethrough, dim text attributes
668. [P1] Cursor movement: up, down, left, right, home, end, page up/down
669. [P1] Cursor blink animation
670. [P1] Cursor style: block / underline / bar (configurable)
671. [P1] Terminal scrollback buffer (at least 10,000 lines)
672. [P1] Mouse click in output: click a value to inspect it
673. [P1] Clickable hyperlinks in output (OSC 8 escape sequence)
674. [P1] Terminal resize: reflow output to new width
675. [P2] Syntax highlighting in input line (keywords, strings, numbers colored live)
676. [P2] Bracket matching highlight
677. [P2] `console.log` output from background tasks appears in correct tab
678. [P2] Output search: Ctrl+F to search scrollback
679. [P2] Output copy: select text with mouse, Ctrl+C to copy
680. [P2] Markdown rendering in output (tables, code blocks, bold/italic)
681. [P2] Inline image preview in output (PNG/JPEG rendered inline)
682. [P2] Progress bar rendering for long async operations
683. [P2] Spinner animation for awaited Promises
684. [P2] Split-pane terminal: side-by-side REPL instances in one window
685. [P3] Terminal recording and playback (`repl.record()` / `repl.replay()`)
686. [P3] Share terminal session over network (pair programming)
687. [P3] REPL notebook mode: cells + markdown annotations, saveable as `.rpl` file

---

## 18. BUILT-IN TYPESCRIPT API FUNCTIONS

> All of these are TypeScript functions available at the REPL prompt. No external binaries, no POSIX shell syntax.

### 18.1 Filesystem
688. [P0] `ls(path?)` — list directory, returns typed `DirEntry[]`, pretty-printed with colors
689. [P0] `cd(path)` — change working directory, updates `sys.cwd`
690. [P0] `pwd()` — returns current directory string
691. [P0] `cat(path)` — read and print file contents with syntax highlighting by extension
692. [P0] `mkdir(path, recursive?)` — create directory
693. [P0] `rm(path, recursive?)` — delete file or directory
694. [P0] `cp(src, dst, recursive?)` — copy
695. [P0] `mv(src, dst)` — move / rename
696. [P0] `stat(path)` — returns `StatResult` with size, mtime, mode, type
697. [P0] `exists(path)` — boolean
698. [P0] `readFile(path)` — returns `string` (UTF-8) or `Uint8Array` for binary
699. [P0] `writeFile(path, data)` — write string or buffer
700. [P0] `appendFile(path, data)` — append
701. [P1] `find(path, pattern)` — recursive search, returns matching paths
702. [P1] `grep(pattern, path, recursive?)` — returns `GrepMatch[]` with line numbers
703. [P1] `diff(pathA, pathB)` — returns unified diff string
704. [P1] `chmod(path, mode)` — change permissions
705. [P1] `chown(path, user, group?)` — change owner
706. [P1] `mount(device, path, fstype)` — mount filesystem
707. [P1] `umount(path)` — unmount
708. [P2] `watch(path, callback)` — inotify-backed file watcher
709. [P2] `zip(src, dst)` / `unzip(src, dst)` — archive helpers
710. [P2] `tar(src, dst)` / `untar(src, dst)` — tar helpers

### 18.2 Processes
711. [P0] `ps()` — returns `ProcessInfo[]`, pretty-printed table
712. [P0] `kill(pid, signal?)` — send signal to process
713. [P0] `spawn(tsFile, args?)` — launch a TypeScript file as a new process
714. [P0] `top()` — live updating process monitor in REPL output
715. [P1] `nice(pid, value)` — adjust process priority
716. [P1] `jobs()` — list background async tasks started from REPL
717. [P1] `fg(id)` / `bg(id)` — bring REPL background task to foreground / push back

### 18.3 Network
718. [P0] `ping(host, count?)` — ICMP echo, returns RTT stats
719. [P0] `fetch(url, opts?)` — standard Fetch API, awaitable at top level
720. [P0] `dns.lookup(host)` — DNS resolve, returns IP(s)
721. [P0] `ifconfig()` — list network interfaces with IP, MAC, state
722. [P1] `traceroute(host)` — ICMP TTL probe, returns hop list
723. [P1] `wget(url, dest)` — download file to disk with progress
724. [P1] `http.get(url)` / `http.post(url, body)` — convenience wrappers
725. [P1] `net.connect(host, port)` — raw TCP socket, returns stream
726. [P2] `nc(host, port)` — interactive TCP session in REPL
727. [P2] `ssh(host, opts?)` — SSH client session in new terminal tab
728. [P2] `rsync(src, dst)` — file sync over SSH

### 18.4 System Info
729. [P0] `mem()` — memory usage summary (used / free / cached)
730. [P0] `disk()` — disk usage per mount point
731. [P0] `cpu()` — CPU info and current utilization
732. [P0] `uptime()` — system uptime and load
733. [P0] `whoami()` — current user
734. [P0] `hostname()` / `hostname(name)` — get or set
735. [P0] `date()` — current date/time; `date(ts)` formats a timestamp
736. [P1] `env()` — print environment variables
737. [P1] `env.get(key)` / `env.set(key, val)` — environment manipulation
738. [P1] `syslog(n?)` — tail system log, optional last-n-lines
739. [P2] `perf.sample(fn, ms?)` — CPU profiler, returns flame data
740. [P2] `perf.memory()` — heap snapshot
741. [P2] `trace(fn)` — trace all syscalls made during `fn()` execution

---

## 19. USERS & SECURITY (src/os/users/)

697. [P0] `passwd` file: username, UID, GID, home, shell
698. [P0] `shadow` file: hashed passwords (bcrypt or SHA-512-crypt)
699. [P0] `group` file: group names, GIDs, members
700. [P0] Login: PAM-like authentication against shadow file
701. [P0] Session creation: set UID, GID, supplementary groups, env vars
702. [P0] Root account (UID 0) with superuser privileges
703. [P0] `useradd`, `userdel`, `usermod` commands
704. [P0] `groupadd`, `groupdel`
705. [P0] `passwd` command to change password
706. [P1] DAC: file permission bits (rwxrwxrwx + sticky + setuid + setgid)
707. [P1] Process credential checks on file open/exec/unlink
708. [P1] `su`/`sudo` with password confirmation
709. [P1] Capabilities (CAP_NET_BIND_SERVICE, CAP_SYS_ADMIN, etc.)
710. [P2] Pluggable authentication framework
711. [P2] SSH daemon for remote login
712. [P2] Two-factor authentication stub (TOTP)
713. [P2] Audit log: security events to `/var/log/auth.log`
714. [P3] SELinux / AppArmor style mandatory access control
715. [P3] Seccomp namespace filtering per process

---

## 20. INIT SYSTEM (src/os/core/)

716. [P0] PID 1 init: starts essential services at boot
717. [P0] Init: reads service definitions from `/etc/init/`
718. [P0] Init: respawn crashed services with backoff
719. [P0] Init: ordered shutdown (reverse dependency order)
720. [P0] Init: runlevel / target concept (single-user, multi-user, graphical)
721. [P1] Service manager: `start`, `stop`, `restart`, `status` commands
722. [P1] Service dependencies (start B after A)
723. [P1] Parallel service startup
724. [P1] Service logs redirected to `/var/log/<service>.log`
725. [P2] Socket activation: start service when first connection arrives
726. [P2] D-Bus daemon as optional service
727. [P3] Systemd-compatible unit file parser (for ecosystem compat)

---

## 21. PACKAGE MANAGER

728. [P0] Package format: a simple `.jspkg` (tar.gz + manifest.json)
729. [P0] Package manifest: name, version, dependencies, files list
730. [P0] Package install: download, verify hash, extract to `/usr/`
731. [P0] Package remove: unlink installed files
732. [P0] Package list: show installed packages
733. [P1] Dependency resolution: topological sort
734. [P1] Remote package repository: JSON index over HTTPS
735. [P1] Package update: check version, download delta or full
736. [P1] Package signature verification (Ed25519 signed manifests)
737. [P2] Virtual packages (provides/requires)
738. [P2] Package pinning / hold
739. [P2] Sandbox package installation (test before committing)
740. [P3] Flatpak-style containerized apps
741. [P3] NPM-compatible registry proxy (install npm packages natively)

---

## 22. GUI / WINDOW SYSTEM (src/os/ui/)

742. [P0] Window: title bar, minimize, maximize, close buttons
743. [P0] Window: drag to move
744. [P0] Window: resize handles
745. [P0] Window: z-order (bring to front on click)
746. [P0] Desktop: wallpaper rendering
747. [P0] Taskbar: list of open windows, clock
748. [P0] Taskbar: system tray area
749. [P1] Window: maximize to full screen
750. [P1] Window: minimize to taskbar
751. [P1] Window: snap to screen edges (Aero Snap equivalent)
752. [P1] Application launcher / start menu
753. [P1] File manager application
754. [P1] Settings application (network, display, users)
755. [P1] Notification system: toast popups in corner
756. [P1] Dialog boxes: `alert`, `confirm`, `prompt` rendered as real windows
757. [P2] Theme system: color scheme, fonts, icon theme
758. [P2] Dark mode support
759. [P2] High-DPI scaling (2× pixel ratio)
760. [P2] Drag and drop between windows
761. [P2] Clipboard: cut, copy, paste between apps
762. [P2] Screen lock / screensaver
763. [P2] Login screen GUI
764. [P3] Compositing window manager (GPU alpha compositing)
765. [P3] Window animations (open/close/minimize effects)
766. [P3] Virtual desktops

---

## 23. APPLICATIONS

767. [P1] Text editor (`jsedit`) — syntax highlighting for JS/TS
768. [P1] Code editor — JSOS self-development from within JSOS
769. [P1] Terminal emulator app (separate from boot VT)
770. [P1] Image viewer
771. [P1] PDF viewer (basic — render pages)
772. [P1] Music player (MP3/OGG decode + audio output)
773. [P1] Video player (MP4/WebM — software decode — slow but functional)
774. [P2] Calendar app
775. [P2] Calculator
776. [P2] Clock / timer / stopwatch
777. [P2] Notes app (markdown editor)
778. [P2] Email client (IMAP + SMTP)
779. [P2] IRC client
780. [P2] Torrent client
781. [P3] Office suite (basic word processor)
782. [P3] Spreadsheet app
783. [P3] Drawing app (canvas 2D)
784. [P3] Game: Tetris (easy to implement in JS)
785. [P3] Game: Snake

---

## 24. DEVELOPER TOOLS

786. [P0] REPL: interactive JS console accessible from shell
787. [P0] REPL: multiline input mode
788. [P0] REPL: syntax highlighting input
789. [P0] REPL: pretty-print objects/arrays
790. [P1] JSOS SDK: TypeScript type definitions for all `sys.*` APIs
791. [P1] Build system: can rebuild JSOS from within JSOS
792. [P1] Debugger: breakpoint on JS line via serial DevTools protocol
793. [P1] Debugger: step over, step in, step out
794. [P1] Debugger: variable inspection
795. [P1] Profiler: CPU flame graph
796. [P1] Profiler: memory heap snapshot
797. [P2] Browser DevTools panel (F12)
798. [P2] Browser DOM inspector
799. [P2] Browser network inspector (requests, timings, headers)
800. [P2] Browser console (JS errors, log output)
801. [P2] Browser source maps support
802. [P3] Hot module replacement for OS development

---

## 25. TESTING & CI

803. [P0] Unit tests for deflate.ts (test vectors from RFC 1951)
804. [P0] Unit tests for TLS handshake (against test server)
805. [P0] Unit tests for DNS resolver
806. [P0] Unit tests for HTTP client (chunked encoding, redirects, cache)
807. [P0] Unit tests for CSS specificity calculator
808. [P0] Unit tests for CSS flex layout
809. [P0] Unit tests for HTML parser (HTML5lib test suite)
810. [P0] Unit tests for TCP state machine
811. [P1] Integration test: boot JSOS → open browser → render Wikipedia
812. [P1] Integration test: form submission (POST request with response)
813. [P1] Integration test: localStorage persistence
814. [P1] Integration test: WebSocket echo server test
815. [P1] Regression test: no kernel panic on 100 random pages
816. [P1] Performance benchmark: pages rendered per second
817. [P2] Fuzzing: HTTP response parser with AFL
818. [P2] Fuzzing: HTML parser
819. [P2] Fuzzing: CSS parser
820. [P2] Fuzzing: TLS certificate parser
821. [P2] Memory leak detection: run 1000 page loads, check heap growth
822. [P2] CI pipeline: Docker build + QEMU headless test on every commit
823. [P3] Formal verification of TCP state machine
824. [P3] Differential testing vs Chrome for HTML/CSS rendering

---

## 26. AUDIO (src/os/apps/)

825. [P1] AC97 audio device driver (QEMU default sound)
826. [P1] Intel HDA (ICH6) audio driver
827. [P1] Virtio-sound driver
828. [P1] PCM ring buffer: mix multiple sources, write to hw
829. [P1] `AudioContext` Web Audio API stub
830. [P1] MP3 decode: minimp3 or similar, compiled to TS port
831. [P1] OGG/Vorbis decode
832. [P2] AAC decode stub
833. [P2] FLAC decode
834. [P2] Volume control mixer
835. [P2] `<audio>` element playback wired to AudioContext
836. [P2] `<video>` audio track sync
837. [P3] ALSA-compatible API
838. [P3] Audio recording from microphone

---

## 27. VIRTUALIZATION / HARDWARE COMPAT

839. [P1] VMware Tools guest additions (balloon driver, SVGA)
840. [P1] VirtualBox Guest Additions stub
841. [P1] KVM paravirtualization (kvmclock, kvm-pv-eoi)
842. [P1] Hyper-V enlightenments (SynIC, reference TSC page)
843. [P2] Bare-metal i5/i7 support (ACPI, AHCI, Realtek NIC)
844. [P2] Raspberry Pi 4 ARM port stubs
845. [P3] RISC-V RV64GC port stubs
846. [P3] UEFI Secure Boot signing

---

## 28. PERFORMANCE

847. [P0] JIT: compile hot JS functions to x86 via JSJIT (`jit.c` hook)
848. [P0] JIT: inline caches for property access
849. [P0] JIT: type specialization for arithmetic loops
850. [P0] Renderer: tile-based rendering (only repaint dirty tiles)
851. [P0] Network: avoid copying packet data more than once (zero-copy recv path)
852. [P1] CSS: cache computed styles per element, invalidate on class/attr change
853. [P1] Profiling: TSC-based microsecond timer in every subsystem
854. [P1] HTTP: connection pool per hostname (currently global pool)
855. [P1] DNS: negative cache (NXDOMAIN answers cached too)
856. [P2] Prefetch `<link rel="prefetch">` and `<link rel="preconnect">`
857. [P2] Resource hints: `<link rel="preload">` with `as=` attribute
858. [P2] CSS: avoid reflow on `transform` and `opacity` changes
859. [P2] JS: `requestIdleCallback` for low-priority work
860. [P3] GPU: Virtio-GPU accelerated blitting for large images
861. [P3] WASM: precompile to native via JSJIT for heavy workloads

---

## 29. COMPATIBILITY

862. [P0] User agent string: realistic Chrome-like UA to avoid server-side blocks
863. [P0] `navigator.userAgent`, `navigator.platform`, `navigator.language`
864. [P0] `document.compatMode` returns `'CSS1Compat'` for standards mode
865. [P0] `window.name`, `window.status`, `window.defaultStatus`
866. [P0] CSS vendor prefixes: `-webkit-`, `-moz-` → map to standard properties
867. [P0] `document.documentMode` = 11 (IE compat shim)
868. [P1] ES2020+ polyfills for missing QuickJS features
869. [P1] `globalThis` as alias for `window`
870. [P1] `window === globalThis === self` identity checks pass
871. [P1] Prototype chain: `HTMLElement` → `Element` → `Node` → `EventTarget`
872. [P1] `instanceof HTMLElement`, `instanceof Element` checks working
873. [P1] `document instanceof Document` check working
874. [P2] React 18: polyfill missing APIs used by ReactDOM
875. [P2] Vue 3: polyfill missing APIs used by Vue runtime
876. [P2] Bootstrap CSS: all flexbox/grid/utility classes render
877. [P2] Tailwind CSS: purge + custom properties chain
878. [P3] jQuery 3 compatibility (mainly DOM query + AJAX)
879. [P3] Angular 17 compatibility
880. [P3] WebAssembly ecosystem (Emscripten output runs)

---

## 30. DOCUMENTATION

881. [P1] Kernel API documentation (all C exported symbols)
882. [P1] `sys.*` TypeScript API reference
883. [P1] Getting started guide: build from source
884. [P1] Getting started guide: run in QEMU
885. [P1] Architecture overview diagram (updated)
886. [P1] File system layout: `/` tree documented
887. [P1] Network stack internals
888. [P1] Browser engine internals
889. [P2] Developer guide: write your first JSOS app
890. [P2] Contributing guide
891. [P2] Security policy
892. [P2] Changelog maintained
893. [P2] API stability guarantees documented
894. [P3] Website (jsos.dev)
895. [P3] Online playground (run in browser via WebAssembly)
896. [P3] YouTube explainer series

---

## 31. INSTALL & PACKAGING

897. [P0] ISO installer: guided partition setup (at least one drive scenario)
898. [P0] Installer: GRUB install to MBR/GPT
899. [P0] Installer: copy filesystem to disk
900. [P0] Installer: set hostname, root password, first user
901. [P1] Live ISO mode: run without installing
902. [P1] Installer: timezone selection
903. [P1] Installer: locale / keyboard layout selection
904. [P1] `update-initramfs` equivalent: rebuild boot image
905. [P2] Installer: disk encryption option (LUKS-style)
906. [P2] Cloud-init support (provision from user-data)
907. [P2] OCI container image (FROM scratch, JSOS as base)
908. [P3] Raspberry Pi SD card image builder
909. [P3] PXE/iPXE boot server support

---

## 32. LEGAL, LICENSING, MISC

910. [P0] Audit QuickJS license (MIT) — confirm compliance in all distributions
911. [P0] Audit all `vendor/` code licenses
912. [P0] Choose JSOS project license (MIT / Apache-2 / GPL)
913. [P0] Mozilla Root CA bundle: confirm MPL 2.0 redistribution terms
914. [P1] NOTICE file listing all third-party code
915. [P1] Copyright headers in all source files
916. [P2] Contributor License Agreement (CLA)
917. [P2] Export control notice (cryptography)
918. [P3] Trademark registration for JSOS name/logo

---

## 33. MISC MISSING PIECES

919. [P0] `/etc/localtime`: timezone database (IANA tz data, compact form)
920. [P0] `/etc/hostname`: set and read system hostname
921. [P0] `/etc/fstab`: filesystem mount table at boot
922. [P0] Clock sync at boot: read CMOS RTC, initialize system time
923. [P0] Proper random seed at boot (mix TSC + RTC for `/dev/random`)
924. [P0] `sysctl`-style kernel parameter tuning
925. [P1] Locale: `C.UTF-8` locale always available
926. [P1] Locale: `LC_ALL` env var respected by utilities
927. [P1] POSIX regular expression (libc `regcomp`/`regexec` binding)
928. [P1] `libc` shim: `malloc`/`free` consistency (currently uses raw kernel allocator)
929. [P1] `printf` / `sprintf` from libc working correctly
930. [P1] Math library: `libm` — all trig, exp, log, pow functions
931. [P1] Floating point edge cases: NaN, Inf, denormals in kernel math
932. [P1] Process umask (`umask 022` default)
933. [P1] `openpty`: pseudoterminal creation for terminal emulator
934. [P1] `utmp`/`wtmp`: login records for `who`, `last` commands
935. [P2] D-Bus: basic system bus for IPC between services
936. [P2] UDisks: automatic block device management
937. [P2] NetworkManager-like daemon: manage interfaces, WiFi profiles
938. [P2] PulseAudio-compatible API (volume, routing)
939. [P2] udev rules for dynamic device naming
940. [P2] Hotplug: USB device add/remove events
941. [P3] Containers: `chroot` + namespace isolation
942. [P3] Virtualization: run another OS in JSOS via KVM (meta!)
943. [P3] LLVM backend: compile C/TypeScript to native via JSJIT
944. [P3] Wayland protocol: modern display server replacement
945. [P3] systemd-resolved: split-horizon DNS

---

## 34. HARDENING & RELIABILITY

946. [P0] Kernel stack overflow detection (stack canary)
947. [P0] Heap corruption detection (guard allocs)
948. [P0] Null pointer dereference trap (map page 0 as non-present)
949. [P0] All syscall inputs sanitized (no kernel ptr leaks to JS)
950. [P1] SMEP: Supervisor Mode Execution Prevention
951. [P1] SMAP: Supervisor Mode Access Prevention
952. [P1] KASLR: randomize kernel base at each boot
953. [P1] W^X: no memory region writable AND executable
954. [P1] Kernel integrity check: hash kernel image at boot
955. [P2] Crash reporter: send crash dump to developer server
956. [P2] Automated reboot on unrecoverable fault
957. [P2] Watchdog: hardware or software watchdog timer
958. [P3] Formal verification of syscall interface

---

## 35. FINAL RELEASE CHECKLIST

959. [P0] All P0 items above completed and tested
960. [P0] Boot time < 5 seconds in QEMU
961. [P0] Memory usage at idle < 256 MB
962. [P0] Browser can render `https://example.com` correctly
963. [P0] Browser can render `https://wikipedia.org` — text readable
964. [P0] Browser can render `https://news.ycombinator.com` correctly
965. [P0] No kernel panic in 24h continuous operation test
966. [P0] All first-party applications launch without crashing
967. [P0] Installer completes on blank QEMU disk image
968. [P1] Browser can render `https://github.com` — JS-heavy page partially works
969. [P1] Audio output works (plays a `.mp3`)
970. [P1] Network connectivity survives DHCP renewal
971. [P1] Multiple simultaneous HTTPS connections work
972. [P1] Shell tab completion works reliably
973. [P1] File manager can browse and open files
974. [P1] Text editor can edit and save files
975. [P1] System survives OOM (out of memory) gracefully
976. [P2] Browser passes Acid3 test (score ≥ 85/100)
977. [P2] Browser correctly renders top 100 Alexa sites (≥ 60% readable)
978. [P2] SSH login from host machine works
979. [P2] File sharing with host via QEMU 9p virtio
980. [P2] Performance: browser renders 60fps scroll on simple pages
981. [P3] Browser passes WPT (Web Platform Tests) ≥ 40% pass rate
982. [P3] Self-hosting: build JSOS from within JSOS
983. [P3] Support for 10 simultaneous logged-in users (SMP)
984. [P3] Power management: ACPI S3 suspend/resume
985. [P3] Battery status on laptops (ACPI battery interface)
986. [P3] Touchpad gestures on laptops
987. [P3] HiDPI display (4K) rendering
988. [P3] Screen reader (accessibility) basic support
989. [P3] Internationalization: render Arabic, Chinese, Japanese
990. [P3] Right-to-left layout support
991. [P3] Voice control stub
992. [P3] Public release on GitHub with proper README
993. [P3] Docker image published to Docker Hub
994. [P3] Prebuilt ISO downloadable from releases page
995. [P3] Community forum / Discord
996. [P3] Bug tracker (GitHub Issues) with triage labels
997. [P3] Roadmap published for v2.0
998. [P3] Logo and branding finalized
999. [P3] Domain name jsos.dev registered and live
1000. [P0] Ship it.

---

*Total: 1000 items across 35 categories.*
*P0 (~180 items): must fix before any public demo.*
*P1 (~320 items): required for the OS to be genuinely usable.*
*P2 (~280 items): important quality-of-life and compatibility.*
*P3 (~220 items): future roadmap.*
