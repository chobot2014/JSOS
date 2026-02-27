# Agent C — Network Stack (TCP / UDP / IP / ARP / ICMP)

**One-shot agent. Read source files and directly mark all implemented items in `docs/1000-things.md`.**

## Your Job

1. Read each source file listed below.
2. For every item in your assigned sections (§7.1–7.4a, §28e — items 222–275, 922–942), determine whether it is implemented.
3. Use `multi_replace_string_in_file` to edit `docs/1000-things.md` directly — mark each implemented item with `✓` and append a short evidence note.
4. Do **not** return JSON. Do **not** wait for a coordinator. Just implement all the markings and stop.

### Mark format

```
Before: 249. [P0] TCP: three-way handshake (SYN/SYN-ACK/ACK) ...
After:  249. [P0 ✓] TCP: three-way handshake (SYN/SYN-ACK/ACK) ... — handleTCP() in net.ts line 512
```

Only mark items you are **confident** are implemented (you found the code). Skip items you cannot confirm.  
Items already marked `✓` — leave them alone.

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

## Already Confirmed — These Are Already Marked ✓

```
232, 234, 235, 249, 250, 251, 252, 253, 254, 261
```

These are already done in `docs/1000-things.md`. Skip them.

## Prior Research Notes (Use as Starting Points)

- **ARP cache** (items 222–224): Prior check found simple `Map`, no TTL. Do not mark TTL expiry unless you find it.
- **IP fragmentation** (items 229–230): NOT found in `handleIPv4()` — likely absent.

Now read the unconfirmed items and mark everything else that you find implemented.
