/**
 * ext2.ts — Read-only ext2 filesystem driver
 *
 * Implements the ext2 (Second Extended Filesystem) in TypeScript.
 * No journaling (journal is an ext3/ext4 feature). Pure read-only for now.
 *
 * Supports:
 *  - Superblock parsing and validation
 *  - Block Group Descriptor Table (BGDT)
 *  - Inode table lookup
 *  - File data read via direct, single-indirect, double-indirect blocks
 *  - Directory entry iteration (linear scan)
 *  - Path resolution
 *
 * VFSMount interface implemented so it can be mounted with:
 *   fs.mountVFS('/mnt/ext2', new Ext2FS(blockDevice));
 *
 * Block device interface: must implement `readBlock(blockNo: number): Uint8Array`.
 *
 * Item 177.
 */

import type { VFSMount, FileType } from './filesystem.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ext2 magic number in superblock (little-endian u16 at offset 56). */
const EXT2_MAGIC = 0xEF53;

/** Root inode number. */
const EXT2_ROOT_INO = 2;

/** Superblock offset within the filesystem (1 KiB from start). */
const SUPERBLOCK_OFFSET = 1024;
/** Superblock size. */
const SUPERBLOCK_SIZE   = 1024;

/** Inode file type bits. */
const EXT2_S_IFSOCK = 0xC000;
const EXT2_S_IFLNK  = 0xA000;
const EXT2_S_IFREG  = 0x8000;
const EXT2_S_IFBLK  = 0x6000;
const EXT2_S_IFDIR  = 0x4000;
const EXT2_S_IFCHR  = 0x2000;
const EXT2_S_IFIFO  = 0x1000;

/** Max blocks for direct/indirect addressing. */
const EXT2_NDIR_BLOCKS   = 12;
const EXT2_DIRECT_BLOCKS = EXT2_NDIR_BLOCKS;

// ── BlockDevice interface ─────────────────────────────────────────────────────

export interface Ext2BlockDevice {
  /** Read a 512-byte sector at absolute byte offset `byteOffset`. */
  readSector(byteOffset: number): Uint8Array;
}

// ── DataView helpers ──────────────────────────────────────────────────────────

function u8 (dv: DataView, off: number): number { return dv.getUint8(off); }
function u16(dv: DataView, off: number): number { return dv.getUint16(off, true); }
function u32(dv: DataView, off: number): number { return dv.getUint32(off, true); }
function i32(dv: DataView, off: number): number { return dv.getInt32(off, true); }

// ── Superblock ────────────────────────────────────────────────────────────────

interface Ext2Superblock {
  inodesCount:      number;   // s_inodes_count
  blocksCount:      number;   // s_blocks_count
  firstDataBlock:   number;   // s_first_data_block (0 for 1K+ blocksize)
  logBlockSize:     number;   // s_log_block_size (0→1KB, 1→2KB, 2→4KB)
  blockSize:        number;   // computed: 1024 << logBlockSize
  blocksPerGroup:   number;   // s_blocks_per_group
  inodesPerGroup:   number;   // s_inodes_per_group
  magic:            number;   // s_magic (must equal EXT2_MAGIC)
  inodeSize:        number;   // s_inode_size (128 for ext2)
  firstIno:         number;   // s_first_ino
  revLevel:         number;   // s_rev_level (0=orig, 1=dynamic)
}

function parseSuperblock(data: Uint8Array): Ext2Superblock | null {
  if (data.length < 84) return null;
  var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  var magic = u16(dv, 56);
  if (magic !== EXT2_MAGIC) return null;
  var logBlockSize = u32(dv, 24);
  var revLevel     = u32(dv, 76);
  return {
    inodesCount:    u32(dv, 0),
    blocksCount:    u32(dv, 4),
    firstDataBlock: u32(dv, 20),
    logBlockSize,
    blockSize:      1024 << logBlockSize,
    blocksPerGroup: u32(dv, 32),
    inodesPerGroup: u32(dv, 40),
    magic,
    inodeSize:      revLevel >= 1 ? u16(dv, 88) : 128,
    firstIno:       revLevel >= 1 ? u32(dv, 84) : 11,
    revLevel,
  };
}

// ── Block Group Descriptor ────────────────────────────────────────────────────

interface Ext2BGD {
  blockBitmap:  number;  // bg_block_bitmap
  inodeBitmap:  number;  // bg_inode_bitmap
  inodeTable:   number;  // bg_inode_table
  freeBlocksCount: number;
  freeInodesCount: number;
  usedDirsCount:   number;
}

/** Read one 32-byte Block Group Descriptor from `data`. */
function parseBGD(data: Uint8Array, offset: number): Ext2BGD {
  var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    blockBitmap:     u32(dv, offset +  0),
    inodeBitmap:     u32(dv, offset +  4),
    inodeTable:      u32(dv, offset +  8),
    freeBlocksCount: u16(dv, offset + 12),
    freeInodesCount: u16(dv, offset + 14),
    usedDirsCount:   u16(dv, offset + 16),
  };
}

// ── Inode ─────────────────────────────────────────────────────────────────────

interface Ext2Inode {
  mode:     number;   // i_mode
  size:     number;   // i_size (lower 32 bits for regular files)
  blocks:   number[]; // i_block[15] (15 block pointers)
  uid:      number;   // i_uid
  gid:      number;   // i_gid
  linksCount: number; // i_links_count
}

/** Parse a 128-byte ext2 inode from `data` at `offset`. */
function parseInode(data: Uint8Array, offset: number): Ext2Inode {
  var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  var blks: number[] = [];
  for (var bi = 0; bi < 15; bi++) {
    blks.push(u32(dv, offset + 40 + bi * 4));
  }
  return {
    mode:       u16(dv, offset + 0),
    uid:        u16(dv, offset + 2),
    size:       u32(dv, offset + 4),
    gid:        u16(dv, offset + 26),
    linksCount: u16(dv, offset + 26 + 2),
    blocks:     blks,
  };
}

// ── DirEntry ──────────────────────────────────────────────────────────────────

interface Ext2DirEntry {
  ino:       number;
  recLen:    number;
  nameLen:   number;
  fileType:  number;  // EXT2_FT_*: 1=REG, 2=DIR, 7=SYMLINK
  name:      string;
}

function parseDirEntry(data: Uint8Array, offset: number): Ext2DirEntry | null {
  if (offset + 8 > data.length) return null;
  var dv      = new DataView(data.buffer, data.byteOffset, data.byteLength);
  var ino     = u32(dv, offset + 0);
  var recLen  = u16(dv, offset + 4);
  var nameLen = u8(dv, offset + 6);
  var fileType = u8(dv, offset + 7);
  if (ino === 0 || recLen < 8 || offset + recLen > data.length) return null;
  var name = String.fromCharCode(...data.slice(offset + 8, offset + 8 + nameLen));
  return { ino, recLen, nameLen, fileType, name };
}

// ── Ext2FS ────────────────────────────────────────────────────────────────────

/**
 * Read-only ext2 filesystem driver implementing VFSMount.
 *
 * Item 177.
 */
export class Ext2FS implements VFSMount {
  private _dev:    Ext2BlockDevice;
  private _sb:     Ext2Superblock | null = null;
  private _bgdLen: number = 0;
  private _ready:  boolean = false;

  constructor(dev: Ext2BlockDevice) {
    this._dev = dev;
    this._init();
  }

  private _init(): void {
    try {
      // Read superblock at byte 1024
      var sbData = this._readBytes(SUPERBLOCK_OFFSET, SUPERBLOCK_SIZE);
      this._sb   = parseSuperblock(sbData);
      if (!this._sb) return;

      // Number of block groups
      var groupCount = Math.ceil(this._sb.blocksCount / this._sb.blocksPerGroup);
      this._bgdLen   = groupCount;
      this._ready    = true;
    } catch (_) {
      this._ready = false;
    }
  }

  get ready(): boolean { return this._ready; }
  get blockSize(): number { return this._sb?.blockSize ?? 1024; }

  // ── Block I/O ────────────────────────────────────────────────────────────

  /** Read `length` bytes from absolute byte offset `byteOffset`. */
  private _readBytes(byteOffset: number, length: number): Uint8Array {
    var buf    = new Uint8Array(length);
    var filled = 0;
    while (filled < length) {
      var sector   = this._dev.readSector(byteOffset + filled);
      var toCopy   = Math.min(sector.length, length - filled);
      buf.set(sector.slice(0, toCopy), filled);
      filled += toCopy;
    }
    return buf;
  }

  /** Read a filesystem block by block number. */
  private _readBlock(blockNo: number): Uint8Array {
    if (!this._sb || blockNo === 0) return new Uint8Array(this._sb?.blockSize ?? 1024);
    var bs = this._sb.blockSize;
    return this._readBytes(blockNo * bs, bs);
  }

  // ── Block Group Descriptor ────────────────────────────────────────────────

  private _readBGD(groupNo: number): Ext2BGD {
    if (!this._sb) throw new Error('Ext2: not initialised');
    var bs         = this._sb.blockSize;
    var bgdtBlock  = this._sb.firstDataBlock + 1;  // BGDT is in block 1 (or 2 for 1K blocks)
    var bgdtOffset = bgdtBlock * bs + groupNo * 32;
    var data       = this._readBytes(bgdtOffset, 32);
    return parseBGD(data, 0);
  }

  // ── Inode ─────────────────────────────────────────────────────────────────

  private _readInode(ino: number): Ext2Inode {
    if (!this._sb) throw new Error('Ext2: not initialised');
    if (ino < 1) throw new Error(`Ext2: invalid inode ${ino}`);
    var groupNo = Math.floor((ino - 1) / this._sb.inodesPerGroup);
    var localNo = (ino - 1) % this._sb.inodesPerGroup;
    var bgd     = this._readBGD(groupNo);
    var bs      = this._sb.blockSize;
    var inodeOff = bgd.inodeTable * bs + localNo * this._sb.inodeSize;
    var data     = this._readBytes(inodeOff, this._sb.inodeSize);
    return parseInode(data, 0);
  }

  // ── Data block resolution (direct + single + double indirect) ────────────

  /**
   * Read all data bytes of a file given its inode.
   * Handles direct (0-11), single-indirect (12), double-indirect (13) blocks.
   */
  private _readFileData(inode: Ext2Inode): Uint8Array {
    if (!this._sb) return new Uint8Array(0);
    var bs     = this._sb.blockSize;
    var size   = inode.size;
    var result = new Uint8Array(size);
    var filled = 0;

    var copyBlock = (blockNo: number): void => {
      if (filled >= size) return;
      var data    = this._readBlock(blockNo);
      var toCopy  = Math.min(bs, size - filled);
      result.set(data.slice(0, toCopy), filled);
      filled += toCopy;
    };

    var resolveIndirect = (blockNo: number): void => {
      var data = this._readBlock(blockNo);
      var dv   = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (var i = 0; i < bs / 4 && filled < size; i++) {
        var child = dv.getUint32(i * 4, true);
        if (child !== 0) copyBlock(child);
      }
    };

    var resolveDoubleIndirect = (blockNo: number): void => {
      var data = this._readBlock(blockNo);
      var dv   = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (var i = 0; i < bs / 4 && filled < size; i++) {
        var child = dv.getUint32(i * 4, true);
        if (child !== 0) resolveIndirect(child);
      }
    };

    // Direct blocks 0-11
    for (var di = 0; di < EXT2_DIRECT_BLOCKS && filled < size; di++) {
      if (inode.blocks[di] !== 0) copyBlock(inode.blocks[di]);
    }
    // Single-indirect block (index 12)
    if (filled < size && inode.blocks[12] !== 0) {
      resolveIndirect(inode.blocks[12]);
    }
    // Double-indirect block (index 13)
    if (filled < size && inode.blocks[13] !== 0) {
      resolveDoubleIndirect(inode.blocks[13]);
    }
    // Triple-indirect (index 14) — not implemented for basic read-only ext2

    return result;
  }

  // ── Directory iteration ───────────────────────────────────────────────────

  /** Read all directory entries for the given directory inode. */
  private _readDir(dirIno: Ext2Inode): Ext2DirEntry[] {
    var data    = this._readFileData(dirIno);
    var entries: Ext2DirEntry[] = [];
    var off = 0;
    while (off < data.length) {
      var entry = parseDirEntry(data, off);
      if (!entry) break;
      if (entry.name !== '.' && entry.name !== '..') {
        entries.push(entry);
      }
      off += entry.recLen;
    }
    return entries;
  }

  // ── Path resolution ───────────────────────────────────────────────────────

  private _splitPath(path: string): string[] {
    return path.split('/').filter(p => p.length > 0);
  }

  /** Resolve `path` to its inode, starting from root. Returns null if not found. */
  private _resolvePath(path: string): Ext2Inode | null {
    if (!this._ready || !this._sb) return null;
    try {
      var parts = this._splitPath(path);
      var inode = this._readInode(EXT2_ROOT_INO);
      for (var pi = 0; pi < parts.length; pi++) {
        var part    = parts[pi];
        var entries = this._readDir(inode);
        var found   = entries.find(e => e.name === part);
        if (!found) return null;
        inode = this._readInode(found.ino);
        // Follow symlink (simple inline symlink via direct blocks)
        if ((inode.mode & 0xF000) === EXT2_S_IFLNK && inode.size < this._sb!.blockSize * 12) {
          var linkTarget = new TextDecoder().decode(this._readFileData(inode));
          // Absolute symlink
          if (linkTarget.startsWith('/')) {
            inode = this._resolvePath(linkTarget) ?? null!;
            if (!inode) return null;
          }
          // Relative symlink not implemented — return null for simplicity
        }
      }
      return inode;
    } catch (_) {
      return null;
    }
  }

  // ── VFSMount interface ────────────────────────────────────────────────────

  /** Read a file by path. Returns string content or null if not found. */
  read(path: string): string | null {
    try {
      var inode = this._resolvePath(path);
      if (!inode) return null;
      if ((inode.mode & 0xF000) !== EXT2_S_IFREG) return null;
      var data = this._readFileData(inode);
      return new TextDecoder('utf-8', { fatal: false }).decode(data);
    } catch (_) {
      return null;
    }
  }

  /** Read a file as raw bytes. */
  readBytes(path: string): Uint8Array | null {
    try {
      var inode = this._resolvePath(path);
      if (!inode) return null;
      if ((inode.mode & 0xF000) !== EXT2_S_IFREG) return null;
      return this._readFileData(inode);
    } catch (_) {
      return null;
    }
  }

  /** List directory entries. */
  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    try {
      var inode = this._resolvePath(path || '/');
      if (!inode) return [];
      if ((inode.mode & 0xF000) !== EXT2_S_IFDIR) return [];
      var entries = this._readDir(inode);
      return entries.map(e => {
        var childIno   = this._readInode(e.ino);
        var modeMask   = childIno.mode & 0xF000;
        var type: FileType =
          modeMask === EXT2_S_IFDIR ? 'directory' :
          modeMask === EXT2_S_IFLNK ? 'symlink'   : 'file';
        return { name: e.name, type, size: childIno.size };
      });
    } catch (_) {
      return [];
    }
  }

  /** Check if a path exists. */
  exists(path: string): boolean {
    return this._resolvePath(path) !== null;
  }

  /** Check if a path is a directory. */
  isDirectory(path: string): boolean {
    try {
      var inode = this._resolvePath(path);
      if (!inode) return false;
      return (inode.mode & 0xF000) === EXT2_S_IFDIR;
    } catch (_) {
      return false;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): Record<string, unknown> {
    if (!this._sb) return { ready: false };
    return {
      ready:          this._ready,
      blockSize:      this._sb.blockSize,
      blocksCount:    this._sb.blocksCount,
      inodesCount:    this._sb.inodesCount,
      inodesPerGroup: this._sb.inodesPerGroup,
      blocksPerGroup: this._sb.blocksPerGroup,
      groups:         this._bgdLen,
      inodeSize:      this._sb.inodeSize,
      revLevel:       this._sb.revLevel,
    };
  }
}

// ── SimpleArrayBlockDevice ────────────────────────────────────────────────────

/**
 * In-memory block device backed by a Uint8Array.
 * Useful for testing and for loading ext2 images embedded in the OS binary.
 */
export class SimpleArrayBlockDevice implements Ext2BlockDevice {
  private _data: Uint8Array;

  constructor(data: Uint8Array) { this._data = data; }

  readSector(byteOffset: number): Uint8Array {
    var end = Math.min(byteOffset + 512, this._data.length);
    if (byteOffset >= this._data.length) return new Uint8Array(512);
    var result = new Uint8Array(512);
    result.set(this._data.slice(byteOffset, end));
    return result;
  }

  get size(): number { return this._data.length; }
}

// ── KernelBlockDevice ─────────────────────────────────────────────────────────

/**
 * Block device backed by kernel ATA/NVMe I/O (kernel.readDiskSector).
 * Used for real hardware disk access.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export class KernelBlockDevice implements Ext2BlockDevice {
  private _diskId:   number;
  private _partOff:  number;  // partition start in bytes

  constructor(diskId: number, partitionOffsetBytes: number = 0) {
    this._diskId  = diskId;
    this._partOff = partitionOffsetBytes;
  }

  readSector(byteOffset: number): Uint8Array {
    var absOffset = this._partOff + byteOffset;
    var sectorNo  = Math.floor(absOffset / 512);
    if (typeof kernel !== 'undefined' && kernel.readDiskSector) {
      try {
        return kernel.readDiskSector(this._diskId, sectorNo);
      } catch (_) {}
    }
    return new Uint8Array(512);
  }
}
