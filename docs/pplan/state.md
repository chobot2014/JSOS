# Audit State Tracker

**Last updated:** 2026-02-26  
**Audit target:** `docs/1000-things.md` (1430 lines, ~1130 items)

---

## Summary Counts

| Status | Count |
|--------|-------|
| Items confirmed ✓ (marked this audit) | 45 |
| Items confirmed ✗ (not implemented, do not re-check) | 20 |
| Items not yet investigated | ~1089 |

---

## Items Marked ✓ This Audit

| Item | Description (short) | Location |
|------|---------------------|----------|
| 77 | — | (marked prior) |
| 88 | Virtio-net: C signals RX | `kernel/virtio_net.c` |
| 89 | Virtio-net: TS maps virtio ring | `net/net.ts` (TS-side processing) |
| 96 | — | (marked prior) |
| 103 | — | (marked prior) |
| 111 | JIT hook handles recursive JS calls | `_jit_hook_impl()` in `kernel/quickjs_binding.c:1879` |
| 112 | JIT hook reentrancy guard | `_in_jit_hook` static var in `kernel/quickjs_binding.c:1861` |
| 114 | JS_SetMemoryLimit per process | `js_proc_create()` in `kernel/quickjs_binding.c:1371` |
| 115 | — | (marked prior) |
| 117 | JS_SetMaxStackSize 256KB | `js_proc_create()` in `kernel/quickjs_binding.c` |
| 150 | Scheduler: round-robin | `src/os/process/scheduler.ts` |
| 151 | Scheduler: priority levels | `src/os/process/scheduler.ts` |
| 155 | — | (marked prior) |
| 159 | — | (marked prior) |
| 169 | VFS mount/unmount with superblock | `mountVFS/unmountVFS` in `fs/filesystem.ts:117` |
| 170 | VFS FD table cloned on fork | `FDTable.clone()` in `core/fdtable.ts:274` |
| 184 | devfs `/dev` character devices | `DevFS + DevFSMount` in `fs/dev.ts:55` |
| 249 | TCP 3-way handshake | `net/net.ts` |
| 251 | TCP data in-order delivery | `net/net.ts` |
| 252 | TCP retransmit with RTO | `net/net.ts` |
| 276 | DNS A record lookup | `net/dns.ts` |
| 277 | DNS UDP query | `net/dns.ts` |
| 278 | DNS timeout/retry | `net/dns.ts` |
| 279 | DNS cache | `net/dns.ts` |
| 281 | DNS resolve before connect | `net/dns.ts` |
| 282 | DNS integration in http.ts | `net/http.ts` |
| 289 | TLS SNI extension | `EXT_SNI=0x0000` in `net/tls.ts:46` |
| 301 | HTTP/1.1 GET | `net/http.ts` |
| 302 | HTTP/1.1 POST | `net/http.ts` |
| 303 | HTTP headers | `net/http.ts` |
| 304 | HTTP redirect follow | `net/http.ts` |
| 305 | HTTP status codes | `net/http.ts` |
| 306 | HTTP TE before CE precedence | `parseHttpResponse()` in `net/http.ts:399` |
| 317 | HTTPS via TLS | `net/http.ts` + `tls.ts` |
| 326 | AES-GCM: null on tag mismatch | `gcmDecrypt()` in `net/crypto.ts:352` |
| 847 | JIT: compile hot functions (call-count hook) | `JIT_THRESHOLD=100` in `process/qjs-jit.ts:72` |
| 850 | JIT: integer type specialization | `TypeSpeculator.allIntegerLike()` in `process/qjs-jit.ts:173` |
| 857 | JIT: 3-tier compilation | Tier-0/1/2 documented in `process/jit-os.ts:8` |
| 863 | JIT: deopt bails to interpreter | `deopt()` in `process/qjs-jit.ts:682`; `MAX_DEOPTS=3` |
| 1 | Multiboot2 header support | section `.multiboot2` with `MULTIBOOT2_MAGIC=0xE85250D6` in `kernel/boot.s` |
| 25 | PIC (8259A) cascade mode | `pic_remap()` ICW1/ICW2/ICW3/ICW4 at IRQ offsets 32/40 in `kernel/irq.c` |
| 35 | Fix hardcoded 0x400000 heap base | `_sbrk()` uses `_heap_start`/`_heap_end` linker symbols in `kernel/syscalls.c` / `linker.ld` |
| 54 | Ctrl+C, Ctrl+D, Ctrl+Z control codes | `kb_ctrl` generates `c-'a'+1` codes in `keyboard_irq_handler()` in `kernel/keyboard.c` |
| 65 | VGA text mode fallback for early output | `platform_boot_print()` + `platform_vga_*` API in `kernel/platform.c` |
| 87 | Virtio-net: C flushes TX ring registers | `virtio_net_send()` with `outw(VPIO_QUEUE_NOTIFY, 1)` in `kernel/virtio_net.c` |

---

## Items Confirmed NOT Implemented (do not re-check)

| Item | Description | Evidence |
|------|-------------|----------|
| 78 | ATA interrupt-driven I/O | `ata.c` comment: "No DMA, no IRQs — polling only" |
| 79 | ATA DMA | same as above |
| 160 | `proc.setScheduler()` real-time policy exposed | `setAlgorithm()` internal only; no syscall |
| 181 | tmpfs | referenced in config but no `TmpFS` class found |
| 222 | ARP cache TTL/aging | simple `Map`, no expiry logic |
| 223 | ARP cache timeout | same |
| 224 | ARP pending TX queue | not in `handleARP()` |
| 229 | IP fragmentation | not in `handleIPv4()` |
| 230 | IP TTL-exceeded ICMP | not in `handleIPv4()` |
| 288 | TLS session resumption | confirmed absent at `tls.ts` header comment |
| 290 | TLS cert chain validation | "No certificate validation" in `tls.ts` header |
| 291 | TLS trust store | same |
| 292 | TLS revocation check (OCSP/CRL) | same |
| 323 | RSA PKCS#1.5 | not in `crypto.ts` |
| 324 | RSA-PSS | not in `crypto.ts` |
| 325 | ECDSA P-384 verify | not in `crypto.ts` |
| 327 | ChaCha20-Poly1305 | not in `crypto.ts` |
| 848 | JIT inline cache for property reads | not in `qjs-jit.ts` |
| 849 | JIT inline cache for property writes | not in `qjs-jit.ts` |
| 851 | JIT float/SSE2 ops | not in `qjs-jit.ts` |
| 852 | JIT dead code elimination | not in `qjs-jit.ts` |
| 853 | JIT register allocator | not in `qjs-jit.ts` (linear scan only) |
| 855 | JIT on-stack replacement (OSR) | not in `qjs-jit.ts` |
| 856 | JIT loop optimization | not in `qjs-jit.ts` |

---

## Phase Progress

- [x] Phase 0 — Manual incremental sessions (21 items marked)
- [ ] Phase 1 — Parallel research (9 agents) — **not started**
- [ ] Phase 2 — Batch writes — **blocked on Phase 1**
- [ ] Phase 3 — Validation — **blocked on Phase 2**

---

## Next Actions

1. Run all 9 Phase 1 agents simultaneously using the specs in `agent-A.md` through `agent-G.md`.
2. Collect JSON findings from each agent.
3. Merge, dedup, filter to `confidence: "high"` only.
4. Write Phase 2 batches using `multi_replace_string_in_file`.
5. Update this file with new counts.
