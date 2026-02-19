# Phase 2 — Storage & I/O ✅ COMPLETE

## Goal

Give JSOS a real persistent storage layer. A blank disk image attached in QEMU
is automatically detected, formatted as FAT16, and exposed through the `disk.*`
REPL API and VFS. Data survives reboots.

---

## Status: COMPLETE

ATA driver, block cache, FAT16 filesystem, and REPL API all complete and tested.

---

## Design Principle

The ATA driver in C does **one thing**: read and write 512-byte sectors via
x86 PIO port I/O. Every decision above that — which sectors to use, what the
FAT structure means, how to cache blocks, what the filesystem looks like — is
TypeScript.

```
disk.read('README.txt')
        │
        ▼
  fat16.ts   ← parses FAT table, follows cluster chain
        │
        ▼
  block.ts   ← LRU cache, issues read/write requests
        │
        ▼
  kernel.ataRead(lba, sectors)  ← C PIO port reads
        │
        ▼
  ATA PIO hardware (port 0x1F0–0x1F7)
```

---

## C Primitives Added (src/kernel/ata.c)

```c
// Bindings added to quickjs_binding.c:
kernel.ataRead(lba: number, count: number): number[]   // returns byte array
kernel.ataWrite(lba: number, data: number[]): void
kernel.ataPresent(): boolean                           // disk attached?
kernel.ataIdentify(): { sectors: number, model: string }
```

### ATA PIO Implementation Details

- Uses primary ATA bus: command port `0x1F0–0x1F7`, control `0x3F6`
- LBA28 addressing (supports up to 128 GB)
- 28-bit LBA packed into drive/head register + LBA registers
- Polling (not DMA): waits for BSY clear, DRQ set before transfer
- Reads/writes 512-byte sectors; `count` sectors transferred in one call
- Error detection: reads error register if STATUS has ERR bit set
- `kernel.ataPresent()` attempts IDENTIFY and returns false if timeout

**C code is deliberately ignorant of FAT, directories, or filenames.** It
only moves raw 512-byte blocks to/from the disk controller.

---

## TypeScript: Block Device Layer (src/os/storage/block.ts)

Abstracts any sector-addressable device behind a uniform interface, adding a
64-sector LRU cache.

```typescript
interface BlockDeviceBackend {
  readSectors(lba: number, count: number): Uint8Array
  writeSectors(lba: number, data: Uint8Array): void
  getSectorCount(): number
  getSectorSize(): number    // always 512 for ATA
}

class CachedBlockDevice {
  constructor(backend: BlockDeviceBackend, cacheSize?: number)  // default 64 sectors

  readSector(lba: number): Uint8Array          // cache hit or backend read
  writeSector(lba: number, data: Uint8Array): void  // write-through cache
  readSectors(lba: number, count: number): Uint8Array
  writeSectors(lba: number, data: Uint8Array): void
  flush(): void                                // write all dirty cache lines
  invalidate(): void
  getCacheStats(): { hits: number; misses: number; dirty: number }
}
```

### LRU Cache Design

- Fixed array of 64 cache entries (sector LBA → 512-byte buffer + dirty flag)
- Eviction: least-recently-used dirty entry is flushed before eviction
- Write-through option available; default is write-back for performance
- `flush()` called before power-off or unmount

---

## TypeScript: FAT16 Filesystem (src/os/storage/fat16.ts)

Complete FAT16 implementation. Implements the `VFSMount` interface from Phase 1
so it plugs into the existing VFS mount system.

### Structures Parsed (all in TypeScript)

```typescript
interface BPB {                    // BIOS Parameter Block (sector 0)
  bytesPerSector: number           // always 512
  sectorsPerCluster: number
  reservedSectors: number
  numFATs: number                  // always 2
  rootEntries: number
  totalSectors: number
  sectorsPerFAT: number
  volumeLabel: string
}

interface DirEntry {
  name: string                     // 8.3 name, decoded
  attr: number                     // ATTR_DIRECTORY = 0x10
  firstCluster: number
  size: number
  modDate: number
}
```

### Operations Implemented

```typescript
class FAT16 implements VFSMount {
  // Initialisation
  format(label?: string): void          // write fresh BPB + empty FAT
  mount(): boolean                      // read BPB, validate magic bytes

  // File operations
  readFile(path: string): Uint8Array | null
  writeFile(path: string, data: Uint8Array): boolean
  appendFile(path: string, data: Uint8Array): boolean
  deleteFile(path: string): boolean
  renameFile(oldPath: string, newPath: string): boolean

  // Directory operations
  readdir(path: string): string[] | null
  mkdir(path: string): boolean
  rmdir(path: string): boolean       // must be empty
  stat(path: string): FileStat | null

  // Filesystem info
  getInfo(): { totalBytes: number; usedBytes: number; freeBytes: number; label: string }
}
```

### Cluster Chain Management

- FAT16 table: array of 16-bit entries. 0x0000 = free, 0xFFFF = end-of-chain.
- `allocCluster()`: linear scan of FAT for free entry — marks used, returns cluster number
- `freeChain(start)`: walks chain setting each entry to 0x0000
- `readCluster(n)`: converts cluster to LBA: `dataSector + (n-2) * sectorsPerCluster`
- Growing a file: `appendCluster()` allocates a new cluster and links it to the chain tail

### Auto-Format on First Boot

```typescript
function mountOrFormat(device: CachedBlockDevice): FAT16 {
  const fs = new FAT16(device)
  if (!fs.mount()) {
    // Blank or unrecognised disk — format automatically
    console.log('[storage] Blank disk detected. Formatting as FAT16...')
    fs.format('JSOS')
    fs.mount()
  }
  return fs
}
```

---

## REPL API (disk.*)

Registered on the global object in `main.ts`. All calls funnel through the
VFS so the FAT16 backend is transparent.

```typescript
disk.ls(path?: string)             // list directory (default: '/')
disk.read(path: string)            // read file, print as UTF-8 string
disk.readBytes(path: string)       // read file, return Uint8Array
disk.write(path: string, data)     // write string or Uint8Array
disk.append(path: string, data)    // append to file
disk.rm(path: string)              // delete file
disk.mkdir(path: string)           // create directory
disk.mv(src: string, dst: string)  // rename/move
disk.stat(path: string)            // print file metadata
disk.info()                        // filesystem usage summary
disk.format()                      // reformat (destructive!)
```

`disk.*` API is **stable from Phase 2 onward**. User scripts relying on it
must keep working in all future phases.

---

## VFS Integration

The FAT16 filesystem mounts at `/disk` in the VFS:

```typescript
// main.ts
const ataBackend = new ATABackend()   // wraps kernel.ataRead / kernel.ataWrite
const block = new CachedBlockDevice(ataBackend)
const fat16 = mountOrFormat(block)
vfs.mount('/disk', fat16)
```

All path operations starting with `/disk/...` dispatch to FAT16.
In-memory VFS (`/mem`) continues to work alongside it.

---

## File List Added in Phase 2

```
src/kernel/
  ata.c                  ATA PIO primitive read/write/identify
  ata.h

src/os/storage/
  block.ts               BlockDevice interface + 64-sector LRU cache
  fat16.ts               FAT16 read/write driver + auto-format
```

---

## Test Oracle

After Phase 2, the headless serial log must also contain:

```
[SERIAL] ATA disk detected
[SERIAL] FAT16 mounted at /disk
```

Or on first boot with a blank disk:

```
[SERIAL] Blank disk detected. Formatting as FAT16...
[SERIAL] FAT16 mounted at /disk
```

---

## What Phase 2 Does NOT Do

- ❌ No journaling or crash recovery (FAT16 is inherently fragile)
- ❌ No extended attributes or Unix permissions on disk (FAT16 limitation)
- ❌ No async I/O (PIO is blocking — Phase 5 threads will help)
- ❌ No DMA — PIO only (sufficient for QEMU; Phase 10 can add DMA)
- ❌ No ext2/ext4 (may be added as an alternative VFSMount in future)
