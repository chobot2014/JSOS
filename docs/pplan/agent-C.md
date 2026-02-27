# Agent C — Network Stack (TCP / UDP / IP / ARP / ICMP)

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §7.1 ARP | 222–228 |
| §7.2 IP | 229–238 |
| §7.3 ICMP | 239–248 |
| §7.4 TCP | 249–269 |
| §7.4a UDP | 270–275 |
| §28e Network Perf | 922–942 |

---

## Source Files to Read

```
src/os/net/net.ts       ← ~1400 lines; the entire IP stack lives here
```

Read the full file. Search carefully — all ARP, IP, ICMP, TCP, UDP logic is
in this one file.

---

## Focus Areas

**ARP:**
- ARP cache TTL / aging (does it expire entries?) — likely NOT
- Gratuitous ARP on interface up
- Pending TX queue while waiting for ARP reply
- ARP for gateway vs direct hosts

**IP:**
- IP fragmentation (reassembly ring buffer) — likely NOT
- TTL decrement + ICMP Time Exceeded — likely NOT
- IP options parsing — likely NOT
- Multicast group join (`IGMP`)

**ICMP:**
- Ping reply (`echo-reply`) — likely YES
- Unreachable messages generation (port unreachable, host unreachable)
- Redirect — likely NOT

**TCP:**
- Full 11-state machine (CLOSED/LISTEN/SYN_SENT/SYN_RCVD/ESTABLISHED/
  FIN_WAIT_1/FIN_WAIT_2/CLOSE_WAIT/CLOSING/LAST_ACK/TIME_WAIT)
- RST handling (both send and receive)
- Nagle algorithm (coalescence of small writes)
- Persist timer (zero-window probe)
- Keepalive timer
- Fast retransmit (3 duplicate ACKs)
- RTO exponential backoff
- SACK support
- Window scaling option
- Listen backlog queue
- `SO_REUSEADDR`

**UDP:**
- Bind collision detection
- Broadcast send/receive
- Multicast send

---

## Already Marked — Skip These

```
232, 234, 235, 249, 250, 251, 252, 253, 254, 261
```

---

## Notes from Prior Work

- **ARP TTL/cache** (items 222–224): Prior check found simple `Map`, no TTL. Confirm.
- **IP fragmentation** (items 229–230): NOT found in `handleIPv4()`. Very likely absent.
- **Item 232** (ICMP echo): already `✓`.
- **Items 249–254, 261**: already `✓`.
