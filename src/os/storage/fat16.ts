/**
 * JSOS FAT16 Filesystem
 *
 * Full read/write FAT16 driver implemented entirely in TypeScript.
 * Depends only on the block device abstraction layer.
 *
 * Layout (standard FAT16):
 *   [0]         Boot Sector / BPB
 *   [reserved]  FAT copies (numFats × fatSizeSectors)
 *   [root dir]  Fixed root directory (rootEntryCount × 32 bytes = rootDirSectors)
 *   [data]      Cluster data starting at cluster 2
 */

import { ataBlockDevice, BlockDevice, SECTOR_SIZE } from './block.js';
import type { VFSMount } from '../fs/filesystem.js';

// ── Constants ──────────────────────────────────────────────────────────────

const ATTR_READ_ONLY  = 0x01;
const ATTR_HIDDEN     = 0x02;
const ATTR_SYSTEM     = 0x04;
const ATTR_VOLUME_ID  = 0x08;
const ATTR_DIRECTORY  = 0x10;
const ATTR_LFN        = 0x0F;  // combination used for LFN entries

const FAT16_EOC  = 0xFFF8;   // end-of-chain threshold
const FAT16_FREE = 0x0000;
const FAT16_BAD  = 0xFFF7;

const DIR_ENTRY_SIZE = 32;

// ── Low-level helpers ──────────────────────────────────────────────────────

function readLE16(buf: number[], off: number): number {
  return (buf[off] | (buf[off + 1] << 8)) >>> 0;
}
function readLE32(buf: number[], off: number): number {
  return (buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16) | (buf[off+3]<<24)) >>> 0;
}
function writeLE16(buf: number[], off: number, val: number): void {
  buf[off]   = val & 0xFF;
  buf[off+1] = (val >> 8) & 0xFF;
}
function writeLE32(buf: number[], off: number, val: number): void {
  buf[off]   = val & 0xFF;
  buf[off+1] = (val >> 8)  & 0xFF;
  buf[off+2] = (val >> 16) & 0xFF;
  buf[off+3] = (val >> 24) & 0xFF;
}

/** Read an ASCII string from a byte buffer */
function readAscii(buf: number[], off: number, len: number): string {
  var s = '';
  for (var i = 0; i < len; i++) {
    var c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** 8.3 name → "NAME.EXT" (or "NAME" if no extension) */
function parseName83(buf: number[], off: number): string {
  var name = '';
  for (var i = 0; i < 8; i++) {
    var c = buf[off + i];
    if (c === 0x20) break;
    name += String.fromCharCode(c);
  }
  var ext = '';
  for (var i = 0; i < 3; i++) {
    var c = buf[off + 8 + i];
    if (c === 0x20) break;
    ext += String.fromCharCode(c);
  }
  return ext.length > 0 ? name + '.' + ext : name;
}

/** "name.ext" or "name" → 11-byte 8.3 uppercase space-padded array */
function formatName83(name: string): number[] {
  var upper = name.toUpperCase();
  var dot   = upper.lastIndexOf('.');
  var base  = dot >= 0 ? upper.substring(0, dot)  : upper;
  var ext   = dot >= 0 ? upper.substring(dot + 1) : '';
  var out   = new Array<number>(11).fill(0x20);
  for (var i = 0; i < 8 && i < base.length; i++) out[i]     = base.charCodeAt(i);
  for (var i = 0; i < 3 && i < ext.length;  i++) out[8 + i] = ext.charCodeAt(i);
  return out;
}

/** Decode a full sector (512 bytes) from `sectors` starting at byte offset `secOff` */
function sectorSlice(sectors: number[], secOff: number): number[] {
  return sectors.slice(secOff * SECTOR_SIZE, (secOff + 1) * SECTOR_SIZE);
}

function zeroPad(arr: number[], len: number): number[] {
  while (arr.length < len) arr.push(0);
  return arr;
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

// ── Directory entry descriptor ─────────────────────────────────────────────

interface DirEntry {
  name:         string;   // parsed 8.3 name
  attr:         number;
  cluster:      number;
  size:         number;   // bytes (0 for dirs)
  // location — for updates
  dirLba:       number;   // which LBA this entry was read from
  entryOffset:  number;   // byte offset within that sector
}

// ── BPB / layout ──────────────────────────────────────────────────────────

interface BPB {
  bytesPerSector:  number;
  secsPerCluster:  number;
  reservedSectors: number;
  numFats:         number;
  rootEntryCount:  number;
  fatSizeSectors:  number;
  // derived
  fatStart:        number;  // LBA of first FAT
  rootDirStart:    number;  // LBA of root directory
  rootDirSectors:  number;
  dataStart:       number;  // LBA of cluster 2
}

// ── FAT16 class ────────────────────────────────────────────────────────────

export class FAT16 implements VFSMount {
  private _dev:    BlockDevice;
  private _bpb:    BPB | null   = null;
  private _fat:    number[]     = [];   // full FAT16 table (16-bit entries)
  private _fatDirty = false;
  private _mounted  = false;
  private _autoFormatted = false;

  get wasAutoFormatted(): boolean { return this._autoFormatted; }

  constructor(dev: BlockDevice) {
    this._dev = dev;
  }

  // ── Format ─────────────────────────────────────────────────────────────

  /**
   * Low-level FAT16 format.  Writes a valid BPB, two FAT copies, and a
   * zeroed root directory.  The device is left in a mountable state.
   * Safe to call on a blank or previously-formatted disk.
   */
  format(label: string = 'JSDISK'): boolean {
    if (!this._dev.isPresent()) return false;

    var totalSectors = this._dev.sectorCount;
    var reserved     = 4;
    var numFats      = 2;
    var rootEntries  = 512;
    var rootDirSecs  = ceilDiv(rootEntries * DIR_ENTRY_SIZE, SECTOR_SIZE); // 32

    // Choose sectors-per-cluster based on disk size
    var spc = 4;
    if      (totalSectors <= 65536 ) spc = 2;
    else if (totalSectors <= 131072) spc = 4;
    else if (totalSectors <= 262144) spc = 8;
    else if (totalSectors <= 524288) spc = 16;
    else                             spc = 32;

    // Iterate twice to converge on the correct FAT size
    var fatSize = ceilDiv((Math.floor(totalSectors / spc) + 2) * 2, SECTOR_SIZE);
    for (var pass = 0; pass < 2; pass++) {
      var dataStart   = reserved + numFats * fatSize + rootDirSecs;
      var dataSectors = totalSectors - dataStart;
      var numClusters = Math.floor(dataSectors / spc);
      fatSize         = ceilDiv((numClusters + 2) * 2, SECTOR_SIZE);
    }

    // ── Write boot sector / BPB ────────────────────────────────────────
    var boot = new Array<number>(SECTOR_SIZE).fill(0);
    // Jump boot + NOP
    boot[0] = 0xEB; boot[1] = 0x58; boot[2] = 0x90;
    // OEM name: "JSOS    "
    var oem = 'JSOS    ';
    for (var i = 0; i < 8; i++) boot[3 + i] = oem.charCodeAt(i);
    // BPB fields
    writeLE16(boot, 11, SECTOR_SIZE);           // bytesPerSector
    boot[13] = spc;                             // sectorsPerCluster
    writeLE16(boot, 14, reserved);              // reservedSectors
    boot[16] = numFats;                         // numFATs
    writeLE16(boot, 17, rootEntries);           // rootEntryCount
    writeLE16(boot, 19, 0);                     // totalSectors16 (0 = use 32-bit)
    boot[21] = 0xF8;                            // mediaType (fixed disk)
    writeLE16(boot, 22, fatSize);               // fatSizeSectors
    writeLE16(boot, 24, 63);                    // sectorsPerTrack
    writeLE16(boot, 26, 255);                   // numHeads
    writeLE32(boot, 28, 0);                     // hiddenSectors
    writeLE32(boot, 32, totalSectors);          // totalSectors32
    boot[36] = 0x80;                            // driveNumber
    boot[38] = 0x29;                            // extBootSig
    // Volume ID (pseudo-random from uptime)
    writeLE32(boot, 39, 0xDEAD0000 | (totalSectors & 0xFFFF));
    // Volume label (11 bytes, space-padded)
    var padLabel = (label + '           ').substring(0, 11).toUpperCase();
    for (var i = 0; i < 11; i++) boot[43 + i] = padLabel.charCodeAt(i);
    // FS type string: "FAT16   "
    var fsType = 'FAT16   ';
    for (var i = 0; i < 8; i++) boot[54 + i] = fsType.charCodeAt(i);
    // Boot signature
    boot[510] = 0x55; boot[511] = 0xAA;
    if (!this._dev.writeSectors(0, 1, boot)) return false;

    // ── Write FAT copies ───────────────────────────────────────────────
    var fatBase = new Array<number>(fatSize * SECTOR_SIZE).fill(0);
    // FAT[0] = media byte | 0xFF00, FAT[1] = EOC
    fatBase[0] = 0xF8; fatBase[1] = 0xFF;   // FAT[0]
    fatBase[2] = 0xFF; fatBase[3] = 0xFF;   // FAT[1]
    for (var copy = 0; copy < numFats; copy++) {
      var base = reserved + copy * fatSize;
      for (var s = 0; s < fatSize; s++) {
        var sec = fatBase.slice(s * SECTOR_SIZE, (s + 1) * SECTOR_SIZE);
        if (!this._dev.writeSectors(base + s, 1, sec)) return false;
      }
    }

    // ── Zero root directory ────────────────────────────────────────────
    var blank  = new Array<number>(SECTOR_SIZE).fill(0);
    var rdBase = reserved + numFats * fatSize;
    for (var s = 0; s < rootDirSecs; s++) {
      if (!this._dev.writeSectors(rdBase + s, 1, blank)) return false;
    }

    this._dev.flush();

    // Re-mount immediately
    this._bpb     = null;
    this._fat     = [];
    this._fatDirty = false;
    this._mounted  = false;
    return this.mount();
  }

  // ── Mount ──────────────────────────────────────────────────────────────

  mount(): boolean {
    if (!this._dev.isPresent()) return false;

    var boot = this._dev.readSectors(0, 1);
    if (boot === null) return false;

    // Check for a blank disk (first 512 bytes all zero) → auto-format
    var isBlank = true;
    for (var i = 0; i < SECTOR_SIZE; i++) { if (boot[i] !== 0) { isBlank = false; break; } }
    if (isBlank) { this._autoFormatted = true; return this.format(); }

    // Verify FAT boot signature
    if (boot[510] !== 0x55 || boot[511] !== 0xAA) return false;

    var bps  = readLE16(boot, 11);
    var spc  = boot[13];
    var rsv  = readLE16(boot, 14);
    var nf   = boot[16];
    var rec  = readLE16(boot, 17);
    var fss  = readLE16(boot, 22);

    if (bps !== 512 || spc === 0) return false; // sanity check

    var fatStart     = rsv;
    var rootDirStart = fatStart + nf * fss;
    var rootDirSecs  = ceilDiv(rec * DIR_ENTRY_SIZE, bps);
    var dataStart    = rootDirStart + rootDirSecs;

    this._bpb = {
      bytesPerSector:  bps,
      secsPerCluster:  spc,
      reservedSectors: rsv,
      numFats:         nf,
      rootEntryCount:  rec,
      fatSizeSectors:  fss,
      fatStart,
      rootDirStart,
      rootDirSectors:  rootDirSecs,
      dataStart,
    };

    // Load FAT into memory (FAT16: 2 bytes per entry)
    var fatBytes: number[] = [];
    for (var s = 0; s < fss; s++) {
      var sec = this._dev.readSectors(fatStart + s, 1);
      if (sec === null) return false;
      for (var b = 0; b < 512; b++) fatBytes.push(sec[b]);
    }
    this._fat = [];
    for (var i = 0; i < fatBytes.length; i += 2)
      this._fat.push(readLE16(fatBytes, i));

    this._mounted = true;
    return true;
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /** Convert cluster number to starting LBA */
  private _clusterLba(cluster: number): number {
    var bpb = this._bpb!;
    return bpb.dataStart + (cluster - 2) * bpb.secsPerCluster;
  }

  /** Follow cluster chain from `start`, returns ordered cluster list */
  private _chain(start: number): number[] {
    var result: number[] = [];
    var c = start;
    while (c >= 2 && c < FAT16_BAD) {
      result.push(c);
      var next = this._fat[c] !== undefined ? this._fat[c] : FAT16_EOC;
      if (next >= FAT16_EOC) break;
      c = next;
    }
    return result;
  }

  /** Read all sectors in a cluster chain, returns flat byte array */
  private _readChain(start: number): number[] | null {
    var bpb    = this._bpb!;
    var chain  = this._chain(start);
    var result: number[] = [];
    for (var i = 0; i < chain.length; i++) {
      var lba  = this._clusterLba(chain[i]);
      var secs = this._dev.readSectors(lba, bpb.secsPerCluster);
      if (secs === null) return null;
      for (var b = 0; b < secs.length; b++) result.push(secs[b]);
    }
    return result;
  }

  /** Parse directory entries from a flat byte array; returns array of DirEntry */
  private _parseDirBytes(bytes: number[], baseLba: number): DirEntry[] {
    var entries: DirEntry[] = [];
    var secsPerCluster = this._bpb!.secsPerCluster;
    for (var off = 0; off < bytes.length; off += DIR_ENTRY_SIZE) {
      var first = bytes[off];
      if (first === 0x00) break;           // end of directory
      if (first === 0xE5) continue;        // deleted entry
      var attr = bytes[off + 11];
      if ((attr & ATTR_LFN) === ATTR_LFN) continue;   // LFN entry
      if (attr & ATTR_VOLUME_ID) continue;             // volume label
      var name    = parseName83(bytes, off);
      var cluster = readLE16(bytes, off + 26);
      var size    = readLE32(bytes, off + 28);
      // Compute the LBA of the sector containing this entry
      var secIdx  = Math.floor(off / SECTOR_SIZE);
      entries.push({
        name, attr, cluster, size,
        dirLba: baseLba + secIdx,
        entryOffset: off % SECTOR_SIZE,
      });
    }
    return entries;
  }

  /** Read root directory entries */
  private _readRootDir(): DirEntry[] | null {
    var bpb    = this._bpb!;
    var total  = bpb.rootDirSectors;
    var bytes: number[] = [];
    for (var s = 0; s < total; s++) {
      var sec = this._dev.readSectors(bpb.rootDirStart + s, 1);
      if (sec === null) return null;
      for (var b = 0; b < 512; b++) bytes.push(sec[b]);
    }
    return this._parseDirBytes(bytes, bpb.rootDirStart);
  }

  /** Read subdirectory entries for a given cluster chain */
  private _readSubDir(cluster: number): DirEntry[] | null {
    var bpb   = this._bpb!;
    var chain = this._chain(cluster);
    if (chain.length === 0) return [];
    var bytes: number[] = [];
    for (var i = 0; i < chain.length; i++) {
      var lba  = this._clusterLba(chain[i]);
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        var sec = this._dev.readSectors(lba + s, 1);
        if (sec === null) return null;
        for (var b = 0; b < 512; b++) bytes.push(sec[b]);
      }
    }
    return this._parseDirBytes(bytes, this._clusterLba(chain[0]));
  }

  // ── Path resolution ────────────────────────────────────────────────────

  /**
   * Walk a path (relative to the FAT16 root), return the final DirEntry
   * or null if not found.  The path may start with '/' or not.
   */
  private _resolve(path: string): DirEntry | null {
    var parts = path.replace(/^\/+/, '').split('/').filter(p => p.length > 0);
    if (parts.length === 0) return null;  // root dir itself — callers handle

    var entries = this._readRootDir();
    if (entries === null) return null;

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].toUpperCase();
      var found: DirEntry | null = null;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].name.toUpperCase() === part) { found = entries[j]; break; }
      }
      if (found === null) return null;
      if (i < parts.length - 1) {
        if (!(found.attr & ATTR_DIRECTORY)) return null;
        entries = this._readSubDir(found.cluster);
        if (entries === null) return null;
      } else {
        return found;
      }
    }
    return null;
  }

  /** Like _resolve but returns directory entries *inside* the given path */
  private _listPath(path: string): DirEntry[] | null {
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return this._readRootDir();

    var entry = this._resolve(norm);
    if (entry === null) return null;
    if (!(entry.attr & ATTR_DIRECTORY)) return null;
    if (entry.cluster === 0) return this._readRootDir();
    return this._readSubDir(entry.cluster);
  }

  // ── VFSMount interface ─────────────────────────────────────────────────

  exists(path: string): boolean {
    if (!this._mounted) return false;
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return true;  // root
    return this._resolve(norm) !== null;
  }

  isDirectory(path: string): boolean {
    if (!this._mounted) return false;
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return true;  // root
    var entry = this._resolve(norm);
    if (entry === null) return false;
    return !!(entry.attr & ATTR_DIRECTORY);
  }

  read(path: string): string | null {
    if (!this._mounted) return null;
    var entry = this._resolve(path.replace(/^\/+/, ''));
    if (entry === null) return null;
    if (entry.attr & ATTR_DIRECTORY) return null;
    if (entry.cluster === 0) return '';
    var bytes = this._readChain(entry.cluster);
    if (bytes === null) return null;
    // Trim to declared file size
    var len  = Math.min(entry.size, bytes.length);
    var text = '';
    for (var i = 0; i < len; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }

  list(path: string): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
    if (!this._mounted) return [];
    var entries = this._listPath(path);
    if (entries === null) return [];
    var result: Array<{ name: string; type: 'file' | 'directory'; size: number }> = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.name === '.' || e.name === '..') continue;
      result.push({
        name: e.name,
        type: (e.attr & ATTR_DIRECTORY) ? 'directory' : 'file',
        size: e.size,
      });
    }
    return result;
  }

  // ── FAT write helpers ──────────────────────────────────────────────────

  private _flushFat(): boolean {
    if (!this._fatDirty) return true;
    var bpb     = this._bpb!;
    var fatBytes: number[] = [];
    for (var i = 0; i < this._fat.length; i++) {
      fatBytes.push(this._fat[i] & 0xFF);
      fatBytes.push((this._fat[i] >> 8) & 0xFF);
    }
    // Write all FAT copies
    for (var copy = 0; copy < bpb.numFats; copy++) {
      var base = bpb.fatStart + copy * bpb.fatSizeSectors;
      for (var s = 0; s < bpb.fatSizeSectors; s++) {
        var offset = s * SECTOR_SIZE;
        var sec    = fatBytes.slice(offset, offset + SECTOR_SIZE);
        zeroPad(sec, SECTOR_SIZE);
        if (!this._dev.writeSectors(base + s, 1, sec)) return false;
      }
    }
    this._fatDirty = false;
    return true;
  }

  private _allocFreeCluster(): number | null {
    for (var i = 2; i < this._fat.length; i++) {
      if (this._fat[i] === FAT16_FREE) return i;
    }
    return null;   // disk full
  }

  /** Allocate a cluster chain to hold `dataBytes` bytes, writing `data`. */
  private _allocChain(data: number[]): number | null {
    var bpb       = this._bpb!;
    var clusterBytes = bpb.secsPerCluster * SECTOR_SIZE;
    var numClusters  = data.length === 0 ? 1 : ceilDiv(data.length, clusterBytes);

    var clusters: number[] = [];
    for (var n = 0; n < numClusters; n++) {
      var c = this._allocFreeCluster();
      if (c === null) return null;
      this._fat[c] = 0xFFFF;  // temporarily mark allocated
      clusters.push(c);
    }

    // Link chain in FAT
    for (var n = 0; n < clusters.length - 1; n++)
      this._fat[clusters[n]] = clusters[n + 1];
    this._fat[clusters[clusters.length - 1]] = 0xFFFF; // EOC
    this._fatDirty = true;

    // Write data to clusters
    for (var n = 0; n < clusters.length; n++) {
      var lba  = this._clusterLba(clusters[n]);
      var base = n * clusterBytes;
      var sec: number[] = [];
      for (var b = 0; b < clusterBytes; b++)
        sec.push(base + b < data.length ? data[base + b] : 0);
      // Write sector by sector within the cluster
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        var slice = sec.slice(s * SECTOR_SIZE, (s + 1) * SECTOR_SIZE);
        if (!this._dev.writeSectors(lba + s, 1, slice)) return null;
      }
    }

    return clusters[0];
  }

  private _freeChain(startCluster: number): void {
    var chain = this._chain(startCluster);
    for (var i = 0; i < chain.length; i++) this._fat[chain[i]] = FAT16_FREE;
    this._fatDirty = true;
  }

  // ── Directory entry creation / deletion ───────────────────────────────

  /**
   * Find a free 32-byte slot in the root directory or a cluster-chained dir.
   * Returns { lba, offset } of the free slot, or null if no space.
   */
  private _findFreeSlot(dirCluster: number | null): { lba: number; offset: number } | null {
    var bpb = this._bpb!;
    if (dirCluster === null) {
      // Root directory
      for (var s = 0; s < bpb.rootDirSectors; s++) {
        var lba = bpb.rootDirStart + s;
        var sec = this._dev.readSectors(lba, 1);
        if (sec === null) return null;
        for (var off = 0; off + DIR_ENTRY_SIZE <= SECTOR_SIZE; off += DIR_ENTRY_SIZE) {
          var first = sec[off];
          if (first === 0x00 || first === 0xE5) return { lba, offset: off };
        }
      }
      return null; // root dir full (fixed-size in FAT16)
    } else {
      // Cluster-chained subdirectory — scan existing clusters
      var chain = this._chain(dirCluster);
      for (var ci = 0; ci < chain.length; ci++) {
        var clLba = this._clusterLba(chain[ci]);
        for (var s = 0; s < bpb.secsPerCluster; s++) {
          var lba = clLba + s;
          var sec = this._dev.readSectors(lba, 1);
          if (sec === null) return null;
          for (var off = 0; off + DIR_ENTRY_SIZE <= SECTOR_SIZE; off += DIR_ENTRY_SIZE) {
            var first = sec[off];
            if (first === 0x00 || first === 0xE5) return { lba, offset: off };
          }
        }
      }
      // No free slot — extend the directory with a new cluster
      var newCluster = this._allocFreeCluster();
      if (newCluster === null) return null;
      this._fat[chain[chain.length - 1]] = newCluster;
      this._fat[newCluster] = 0xFFFF;
      this._fatDirty = true;
      // Zero the new cluster
      var clLba = this._clusterLba(newCluster);
      var blank = new Array<number>(SECTOR_SIZE).fill(0);
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        if (!this._dev.writeSectors(clLba + s, 1, blank)) return null;
      }
      return { lba: clLba, offset: 0 };
    }
  }

  /** Write a 32-byte directory entry at the given sector/offset */
  private _writeDirEntry(lba: number, off: number, ent: number[]): boolean {
    var sec = this._dev.readSectors(lba, 1);
    if (sec === null) return false;
    for (var i = 0; i < DIR_ENTRY_SIZE; i++) sec[off + i] = ent[i];
    return this._dev.writeSectors(lba, 1, sec);
  }

  /** Build a 32-byte directory entry array */
  private _buildDirEntry(name: string, attr: number, cluster: number, size: number): number[] {
    var ent = new Array<number>(DIR_ENTRY_SIZE).fill(0);
    var n83 = formatName83(name);
    for (var i = 0; i < 11; i++) ent[i] = n83[i];
    ent[11] = attr;
    writeLE16(ent, 26, cluster);
    writeLE32(ent, 28, size);
    return ent;
  }

  // ── Public write API ───────────────────────────────────────────────────

  /**
   * Write a text file to the filesystem.
   * Creates or overwrites; intermediate directories must already exist.
   */
  writeFile(path: string, content: string): boolean {
    if (!this._mounted) return false;
    var norm  = path.replace(/^\/+/, '');
    var slash = norm.lastIndexOf('/');
    var dir   = slash >= 0 ? norm.substring(0, slash) : '';
    var fname = slash >= 0 ? norm.substring(slash + 1) : norm;
    if (!fname) return false;

    // Resolve parent directory cluster (null = root)
    var dirCluster: number | null = null;
    if (dir !== '') {
      var dirEntry = this._resolve(dir);
      if (dirEntry === null || !(dirEntry.attr & ATTR_DIRECTORY)) return false;
      dirCluster = dirEntry.cluster > 0 ? dirEntry.cluster : null;
    }

    // Check if file already exists — if so, delete old chain
    var existing = this._resolve(norm);
    if (existing !== null) {
      if (existing.attr & ATTR_DIRECTORY) return false; // can't overwrite dir
      if (existing.cluster > 0) this._freeChain(existing.cluster);
      // Mark entry deleted
      var sec = this._dev.readSectors(existing.dirLba, 1);
      if (sec !== null) {
        sec[existing.entryOffset] = 0xE5;
        this._dev.writeSectors(existing.dirLba, 1, sec);
      }
    }

    // Convert content to bytes
    var data: number[] = [];
    for (var i = 0; i < content.length; i++) data.push(content.charCodeAt(i) & 0xFF);

    // Allocate cluster chain
    var firstCluster = 0;
    if (data.length > 0) {
      var fc = this._allocChain(data);
      if (fc === null) return false;
      firstCluster = fc;
    }

    // Create directory entry
    var slot = this._findFreeSlot(dirCluster);
    if (slot === null) { if (firstCluster > 0) this._freeChain(firstCluster); return false; }
    var ent = this._buildDirEntry(fname, 0x20 /* ARCHIVE */, firstCluster, data.length);
    if (!this._writeDirEntry(slot.lba, slot.offset, ent)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

  /** Create a directory (parent must exist) */
  mkdir(path: string): boolean {
    if (!this._mounted) return false;
    var norm  = path.replace(/^\/+/, '');
    var slash = norm.lastIndexOf('/');
    var dir   = slash >= 0 ? norm.substring(0, slash) : '';
    var dname = slash >= 0 ? norm.substring(slash + 1) : norm;
    if (!dname) return false;

    var dirCluster: number | null = null;
    if (dir !== '') {
      var dirEntry = this._resolve(dir);
      if (dirEntry === null || !(dirEntry.attr & ATTR_DIRECTORY)) return false;
      dirCluster = dirEntry.cluster > 0 ? dirEntry.cluster : null;
    }

    if (this._resolve(norm) !== null) return false; // already exists

    // Allocate one cluster for the new directory
    var newCluster = this._allocFreeCluster();
    if (newCluster === null) return false;
    this._fat[newCluster] = 0xFFFF; // EOC
    this._fatDirty = true;

    // Zero the cluster and write . and .. entries
    var bpb      = this._bpb!;
    var clLba    = this._clusterLba(newCluster);
    var blank    = new Array<number>(SECTOR_SIZE).fill(0);
    // Build '.' entry
    var dotEnt   = this._buildDirEntry('.', ATTR_DIRECTORY, newCluster, 0);
    var ddotEnt  = this._buildDirEntry('..', ATTR_DIRECTORY, dirCluster ?? 0, 0);
    var firstSec = blank.slice();
    for (var i = 0; i < DIR_ENTRY_SIZE; i++) { firstSec[i] = dotEnt[i]; firstSec[DIR_ENTRY_SIZE + i] = ddotEnt[i]; }
    for (var s = 0; s < bpb.secsPerCluster; s++) {
      if (!this._dev.writeSectors(clLba + s, 1, s === 0 ? firstSec : blank)) return false;
    }

    // Write directory entry in parent
    var slot = this._findFreeSlot(dirCluster);
    if (slot === null) { this._fat[newCluster] = FAT16_FREE; this._fatDirty = true; return false; }
    var ent = this._buildDirEntry(dname, ATTR_DIRECTORY, newCluster, 0);
    if (!this._writeDirEntry(slot.lba, slot.offset, ent)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

  /** Remove a file or empty directory */
  remove(path: string): boolean {
    if (!this._mounted) return false;
    var norm  = path.replace(/^\/+/, '');
    var entry = this._resolve(norm);
    if (entry === null) return false;

    // If a directory, must be empty (only . and ..)
    if (entry.attr & ATTR_DIRECTORY) {
      var children = this._readSubDir(entry.cluster);
      if (children === null) return false;
      var real = children.filter(e => e.name !== '.' && e.name !== '..');
      if (real.length > 0) return false;
      if (entry.cluster > 0) this._freeChain(entry.cluster);
    } else {
      if (entry.cluster > 0) this._freeChain(entry.cluster);
    }

    // Mark directory entry as deleted
    var sec = this._dev.readSectors(entry.dirLba, 1);
    if (sec === null) return false;
    sec[entry.entryOffset] = 0xE5;
    if (!this._dev.writeSectors(entry.dirLba, 1, sec)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  getStats(): { totalClusters: number; freeClusters: number; bytesPerCluster: number } {
    if (!this._mounted) return { totalClusters: 0, freeClusters: 0, bytesPerCluster: 0 };
    var bpb   = this._bpb!;
    var total = this._fat.length - 2;  // clusters 2..N
    var free  = 0;
    for (var i = 2; i < this._fat.length; i++) if (this._fat[i] === FAT16_FREE) free++;
    return { totalClusters: total, freeClusters: free, bytesPerCluster: bpb.secsPerCluster * SECTOR_SIZE };
  }
}

export const fat16 = new FAT16(ataBlockDevice);
