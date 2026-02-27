# Agent G — IPC / Users / Security / VMM / Storage

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §3 Virtual Memory Manager | 128–144 |
| §5 File System | 168–206 |
| §6 IPC | 207–221 |
| §19 Users & Security | items in that section |
| §33 Miscellaneous | items in that section |

---

## Source Files to Read

```
src/os/ipc/ipc.ts
src/os/users/users.ts
src/os/core/sdk.ts         ← IPC/users surface area
src/os/core/fdtable.ts     ← already confirmed FDTable.clone()
src/os/core/config.ts
src/os/core/locale.ts
src/os/core/timezone.ts
src/os/fs/filesystem.ts    ← VFS mount, VMA/memory sections
src/os/fs/proc.ts          ← /proc filesystem
src/os/storage/block.ts    ← ATA LRU cache
src/os/storage/fat.ts      ← FAT32 implementation
```

---

## Focus Areas

**VMM (§3):**
- Page frame allocator — free list, buddy system, or bitmap?
- `vmm.alloc(n)` / `vmm.free(ptr)` — virtual address space management
- Copy-on-write page faults
- Demand paging (page not present → allocate on access)
- `/proc/meminfo` — free/used/total physical memory
- Memory-mapped files (`mmap`)
- Swap — likely NOT

**File System (§5):**
- Buffer cache — block cache with LRU eviction
- FAT32 long filename (LFN) support
- FAT32 directory traversal, `readdir()`
- FAT32 create/delete/rename
- Journaling — likely NOT
- Hard links — FAT doesn't support, so likely NOT
- Symbolic links — likely NOT
- `tmpfs` — check: `/tmp` in `filesystem.ts` config, does a `TmpFS` class exist?
- `procfs` — is `/proc` virtual filesystem implemented?
- File locking (`flock`, `lockf`)
- `inotify` / `fs.watch`

**IPC (§6):**
- Anonymous pipes (`pipe()`) — read/write ends as FDs
- Named pipes / FIFOs
- Unix-domain sockets (for local IPC)
- Message queues
- Shared memory (`shmget`, `shmat`)
- Eventfd, timerfd
- `select()` / `poll()` / `epoll()` — I/O multiplexing
- Signal-based IPC (`kill`, `sigqueue`)
- Sleep timers (`setTimeout` in kernel context)

**Users & Security (§19):**
- User store: `users.ts` — create, delete, list users
- Password hashing: bcrypt? SHA-256 + salt?
- Login / session tokens
- Capability flags (per-process permission bits)
- Audit log (write ops logged?)
- `chroot` / process sandbox
- `setuid` / `setgid`

**Misc (§33):**
- Timezone: `timezone.ts` — does it have a zone database?
- Locale: `locale.ts` — language strings, number/date formatting?
- System config: `config.ts` — `sys.config.get/set`
- PRNG seeding: entropy sources (ticks + Date.now in `dev.ts` confirmed)
- `sys.uptime()`, `sys.hostname()`
- `sys.env` get/set
- Resource limits (`ulimit`)

---

## Already Marked — Skip These

```
138, 169, 170, 173, 174, 176, 180, 182, 184, 185, 186, 187, 188, 189,
196, 207, 208, 211, 212, 214, 215
```

---

## Notes from Prior Work

- **Item 169** (VFS mount/unmount): `mountVFS/unmountVFS` in `fs/filesystem.ts` ✓
- **Item 170** (FDTable per process): `FDTable.clone()` in `core/fdtable.ts` ✓
- **Item 184** (devfs `/dev`): `DevFS` + `DevFSMount` in `fs/dev.ts` ✓
- **Item 181** (tmpfs): listed in config/proc but **no `TmpFS` class found**. Do NOT mark.
- **Item 160** (real-time `proc.setScheduler()`): NOT exposed as syscall. Do NOT mark.
