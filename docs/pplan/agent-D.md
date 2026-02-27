# Agent D — DNS / TLS / HTTP / Crypto

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §7.6 DNS | 276–287 |
| §7.7 TLS | 288–300 |
| §7.8 HTTP | 301–322 |
| §8 Crypto | 323–348 |

---

## Source Files to Read

```
src/os/net/dns.ts
src/os/net/tls.ts        ← 559 lines; TLS 1.3 client
src/os/net/crypto.ts     ← 536 lines; AES-GCM, X25519, HKDF, SHA-256
src/os/net/http.ts       ← 661 lines; HTTP/1.1 client + parser
src/os/net/dhcp.ts
src/os/net/deflate.ts
```

---

## Focus Areas

**DNS:**
- Retry logic on timeout
- AAAA record support
- CNAME chain following
- `/etc/hosts` lookup before DNS
- Multiple nameserver fallback
- DNS over TCP fallback (for large responses)

**TLS:**
- TLS 1.3 only vs TLS 1.2 fallback — which ciphersuites advertised?
- Certificate validation — this is **NOT implemented** (confirmed by tls.ts header)
- ALPN extension
- Session tickets / resumption — **NOT implemented** (confirmed)
- 0-RTT (early data) — NOT implemented
- Client certificates — NOT implemented

**HTTP:**
- Redirect loop detection (max 10 redirects or cycle detection?)
- Cookie jar — is there a cookie store?
- ETag / Last-Modified caching
- `multipart/form-data` body encoding
- HTTP/2 — NOT implemented
- Pipelining
- Compression: gzip, deflate, brotli — which are supported?
- CONNECT tunneling for HTTPS proxies

**Crypto:**
- AES-128-GCM: encrypt + decrypt (constant-time tag check confirmed ✓ item 326)
- X25519 key exchange
- HKDF (with SHA-256 and/or SHA-384)
- SHA-256, SHA-384, HMAC-SHA
- RSA PKCS#1.5 — NOT found in prior scan
- RSA-PSS — NOT found
- ECDSA P-384 verify — NOT found
- ChaCha20-Poly1305 — NOT found
- P-256 / P-384 field arithmetic

---

## Already Marked — Skip These

```
276, 277, 278, 279, 281, 282, 289, 301, 302, 303, 304, 305, 306, 317, 326
```

---

## Notes from Prior Work

- **Item 289** (TLS SNI): `EXT_SNI=0x0000` at `tls.ts` line 46; builder at lines 288–296.
- **Item 306** (HTTP TE vs CE precedence): `parseHttpResponse()` checks TE first, confirmed.
- **Item 326** (AES-GCM null on tag fail): `gcmDecrypt()` lines 352–367 in `crypto.ts`.
- **Items 288/290–292** (session resumption, cert chain, trust store, revocation): NOT found.
- **Items 323–325, 327** (RSA, ECDSA, ChaCha20): NOT found in `crypto.ts`.
