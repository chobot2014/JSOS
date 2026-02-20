/**
 * JSOS FAT32 Filesystem
 *
 * Full read/write FAT32 driver in pure TypeScript.
 * Supports volumes up to ~128 GiB (LBA28), files up to 4 GiB.
 *
 * Layout:
 *   [0]               Boot sector (BPB)
 *   [1]               FSInfo
 *   [RsvdSecCnt..]    Two FAT copies (FATSz32 sectors each)
 *   [dataStart..]     Cluster data; cluster 2 = root directory chain
 */

import { ataBlockDevice, BlockDevice, SECTOR_SIZE } from './block.js';
import type { VFSMount } from '../fs/filesystem.js';

// ── Constants ───────────────────────────────────────────────────────────────

const ATTR_READ_ONLY  = 0x01;
const ATTR_HIDDEN     = 0x02;
const ATTR_SYSTEM     = 0x04;
const ATTR_VOLUME_ID  = 0x08;
const ATTR_DIRECTORY  = 0x10;
const ATTR_LFN        = 0x0F;

const FAT32_EOC_MIN = 0x0FFFFFF8;
const FAT32_BAD     = 0x0FFFFFF7;
const FAT32_FREE    = 0x00000000;
const FAT32_MASK    = 0x0FFFFFFF;
const FAT32_EOC     = 0x0FFFFFFF;

const DIR_ENTRY_SIZE = 32;

// ── Byte helpers ────────────────────────────────────────────────────────────

function readLE16(buf: number[], off: number): number {
  return ((buf[off] & 0xFF) | ((buf[off + 1] & 0xFF) << 8)) >>> 0;
}
function readLE32(buf: number[], off: number): number {
  return (((buf[off] & 0xFF)) |
          ((buf[off+1] & 0xFF) << 8) |
          ((buf[off+2] & 0xFF) << 16) |
          ((buf[off+3] & 0xFF) << 24)) >>> 0;
}
function writeLE16(buf: number[], off: number, val: number): void {
  buf[off]   = val & 0xFF;
  buf[off+1] = (val >> 8) & 0xFF;
}
function writeLE32(buf: number[], off: number, val: number): void {
  buf[off]   = val & 0xFF;
  buf[off+1] = (val >>  8) & 0xFF;
  buf[off+2] = (val >> 16) & 0xFF;
  buf[off+3] = (val >> 24) & 0xFF;
}

function parseName83(buf: number[], off: number): string {
  var name = '';
  for (var i = 0; i < 8; i++) {
    var c = buf[off + i] & 0xFF;
    if (c === 0x20) break;
    name += String.fromCharCode(c);
  }
  var ext = '';
  for (var i = 0; i < 3; i++) {
    var c = buf[off + 8 + i] & 0xFF;
    if (c === 0x20) break;
    ext += String.fromCharCode(c);
  }
  return ext.length > 0 ? name + '.' + ext : name;
}

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

function zeroPad(arr: number[], len: number): number[] {
  while (arr.length < len) arr.push(0);
  return arr;
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

// ── Internal structures ─────────────────────────────────────────────────────

interface DirEntry32 {
  name:        string;
  attr:        number;
  cluster:     number;  // 28-bit cluster number
  size:        number;
  dirLba:      number;
  entryOffset: number;
}

interface BPB32 {
  bytesPerSector:  number;
  secsPerCluster:  number;
  reservedSectors: number;
  numFats:         number;
  fatSizeSectors:  number;   // FATSz32
  rootCluster:     number;   // BPB_RootClus
  fatStart:        number;
  dataStart:       number;
  totalClusters:   number;
}

// ── FAT32 class ─────────────────────────────────────────────────────────────

export class FAT32 implements VFSMount {
  private _dev:      BlockDevice;
  private _bpb:      BPB32 | null = null;
  private _fat:      Uint32Array  = new Uint32Array(0);
  private _fatDirty  = false;
  private _mounted   = false;
  private _autoFormatted = false;

  get wasAutoFormatted(): boolean { return this._autoFormatted; }
  get mounted():          boolean { return this._mounted; }

  constructor(dev: BlockDevice) {
    this._dev = dev;
  }

  // ── Format ──────────────────────────────────────────────────────────────

  format(label: string = 'JSDISK'): boolean {
    if (!this._dev.isPresent()) return false;

    var totalSectors = this._dev.sectorCount;
    var reserved     = 32;
    var numFats      = 2;

    // Sectors-per-cluster tuned to volume size for fast ATA PIO:
    // We size clusters so the FAT table fits in ≤1024 sectors per copy (~0.5 MB).
    // This keeps format and mount fast on bare-metal PIO (no DMA).
    var spc = 8;
    if      (totalSectors <=    532480) spc = 1;   // ≤256 MiB
    else if (totalSectors <=   4194304) spc = 8;   // ≤2 GiB  → 4 KB clusters
    else if (totalSectors <=  16777216) spc = 64;  // ≤8 GiB  → 32 KB clusters — keeps FAT ≤1K sectors
    else if (totalSectors <=  67108864) spc = 128; // ≤32 GiB → 64 KB clusters
    else                                spc = 256; // >32 GiB → 128 KB clusters

    // Iterate to converge FATSz32
    var fatSize = ceilDiv((Math.floor(totalSectors / spc) + 2) * 4, SECTOR_SIZE);
    for (var pass = 0; pass < 4; pass++) {
      var dataStart   = reserved + numFats * fatSize;
      var dataSectors = totalSectors - dataStart;
      var numClusters = Math.floor(dataSectors / spc);
      fatSize         = ceilDiv((numClusters + 2) * 4, SECTOR_SIZE);
    }

    // ── Boot sector ──────────────────────────────────────────────────────
    var boot = new Array<number>(SECTOR_SIZE).fill(0);
    // Jump + NOP
    boot[0] = 0xEB; boot[1] = 0x58; boot[2] = 0x90;
    // OEM name "JSOS    "
    var oem = 'JSOS    ';
    for (var i = 0; i < 8; i++) boot[3 + i] = oem.charCodeAt(i);

    // Standard BPB fields
    writeLE16(boot, 11, SECTOR_SIZE);     // BytsPerSec
    boot[13] = spc;                       // SecPerClus
    writeLE16(boot, 14, reserved);        // RsvdSecCnt
    boot[16] = numFats;                   // NumFATs
    writeLE16(boot, 17, 0);              // RootEntCnt = 0 (FAT32)
    writeLE16(boot, 19, 0);              // TotSec16 = 0 (FAT32)
    boot[21] = 0xF8;                      // Media
    writeLE16(boot, 22, 0);              // FATSz16 = 0 ← FAT32 marker
    writeLE16(boot, 24, 63);             // SecPerTrk
    writeLE16(boot, 26, 255);            // NumHeads
    writeLE32(boot, 28, 0);             // HiddSec
    writeLE32(boot, 32, totalSectors);  // TotSec32

    // FAT32 extended BPB (offset 36–89)
    writeLE32(boot, 36, fatSize);  // FATSz32
    writeLE16(boot, 40, 0);       // ExtFlags
    writeLE16(boot, 42, 0);       // FSVer = 0.0
    writeLE32(boot, 44, 2);       // RootClus = 2
    writeLE16(boot, 48, 1);       // FSInfo sector
    writeLE16(boot, 50, 6);       // BkBootSec

    boot[64] = 0x80;  // DrvNum
    boot[66] = 0x29;  // BootSig
    writeLE32(boot, 67, 0xF32D0000 | (totalSectors & 0xFFFF));  // VolID

    var padLabel = (label + '           ').substring(0, 11).toUpperCase();
    for (var i = 0; i < 11; i++) boot[71 + i] = padLabel.charCodeAt(i);
    var fsType = 'FAT32   ';
    for (var i = 0; i < 8; i++) boot[82 + i] = fsType.charCodeAt(i);

    boot[510] = 0x55; boot[511] = 0xAA;
    if (!this._dev.writeSectors(0, 1, boot)) return false;

    // ── FSInfo (sector 1) ────────────────────────────────────────────────
    var fsi = new Array<number>(SECTOR_SIZE).fill(0);
    writeLE32(fsi, 0, 0x41615252);    // LeadSig
    writeLE32(fsi, 484, 0x61417272);  // StrucSig
    writeLE32(fsi, 488, 0xFFFFFFFF);  // FreeCount = unknown
    writeLE32(fsi, 492, 0x00000003);  // NextFree hint = first data cluster
    fsi[510] = 0x55; fsi[511] = 0xAA;
    if (!this._dev.writeSectors(1, 1, fsi)) return false;

    // ── Two FAT copies ───────────────────────────────────────────────────
    // ── Two FAT copies ───────────────────────────────────────────────────
    // Only the first FAT sector (entries 0-2) needs to be written; everything
    // else is 0x00 = FAT32_FREE which is already correct on a zeroed/sparse disk.
    var oneFat = new Array<number>(SECTOR_SIZE).fill(0);
    // Entry 0: 0x0FFFFFF8 (media byte)
    oneFat[0] = 0xF8; oneFat[1] = 0xFF; oneFat[2] = 0xFF; oneFat[3] = 0x0F;
    // Entry 1: EOC marker
    oneFat[4] = 0xFF; oneFat[5] = 0xFF; oneFat[6] = 0xFF; oneFat[7] = 0x0F;
    // Entry 2: root directory cluster → EOC (single-cluster root dir)
    oneFat[8] = 0xFF; oneFat[9] = 0xFF; oneFat[10] = 0xFF; oneFat[11] = 0x0F;

    for (var copy = 0; copy < numFats; copy++) {
      var fatLba = reserved + copy * fatSize;
      // Only the first FAT sector (entries 0-126) is non-zero; all subsequent
      // sectors are 0x00 = FAT32_FREE and are already correct in a zeroed/sparse
      // disk image.  Writing only sector 0 cuts format time from ~30s to <1s.
      if (!this._dev.writeSectors(fatLba, 1, oneFat)) return false;
    }

    // ── Zero root directory (cluster 2) ──────────────────────────────────
    // Only write explicitly if the disk is not already zeroed (sparse files
    // from QEMU are already zero, but we write it anyway to be safe for HDDs).
    var rootDataStart = reserved + numFats * fatSize;
    var blank = new Array<number>(SECTOR_SIZE).fill(0);
    // Write only the first sector — FAT32 detects end-of-directory on first 0x00 byte
    if (!this._dev.writeSectors(rootDataStart, 1, blank)) return false;

    this._dev.flush();

    // Re-mount immediately
    this._bpb      = null;
    this._fat      = new Uint32Array(0);
    this._fatDirty = false;
    this._mounted  = false;
    return this.mount();
  }

  // ── Mount ────────────────────────────────────────────────────────────────

  mount(): boolean {
    if (!this._dev.isPresent()) return false;

    var boot = this._dev.readSectors(0, 1);
    if (boot === null) return false;

    // Blank disk → auto-format
    var isBlank = true;
    for (var i = 0; i < SECTOR_SIZE; i++) {
      if (boot[i] !== 0) { isBlank = false; break; }
    }
    if (isBlank) { this._autoFormatted = true; return this.format(); }

    // Check boot signature
    if (boot[510] !== 0x55 || boot[511] !== 0xAA) return false;

    var bps   = readLE16(boot, 11);
    var spc   = boot[13] & 0xFF;
    var rsv   = readLE16(boot, 14);
    var nf    = boot[16] & 0xFF;
    var fss16 = readLE16(boot, 22);   // FATSz16: must be 0 for FAT32
    var fss32 = readLE32(boot, 36);   // FATSz32
    var rootCl = readLE32(boot, 44);  // RootClus

    if (bps !== 512 || spc === 0) return false;
    if (fss16 !== 0 || fss32 === 0) return false;

    // Confirm FS type string
    var fstype = '';
    for (var i = 0; i < 8; i++) fstype += String.fromCharCode(boot[82 + i] & 0xFF);
    if (fstype.trim() !== 'FAT32') return false;

    var fatStart  = rsv;
    var dataStart = fatStart + nf * fss32;

    var totSec32  = readLE32(boot, 32);
    var dataSecs  = totSec32 > dataStart ? totSec32 - dataStart : 0;
    var totClust  = Math.floor(dataSecs / spc);

    this._bpb = {
      bytesPerSector:  bps,
      secsPerCluster:  spc,
      reservedSectors: rsv,
      numFats:         nf,
      fatSizeSectors:  fss32,
      rootCluster:     rootCl,
      fatStart,
      dataStart,
      totalClusters:   totClust,
    };

    // Load FAT into a Uint32Array.
    // Read in 8-sector chunks and parse entries in-place to avoid a
    // large intermediate buffer (was 524K-element number[] on heap).
    var entryCount = Math.min(totClust + 2 + 8, fss32 * SECTOR_SIZE / 4);
    this._fat = new Uint32Array(entryCount);
    var fatBase = 0;  // next _fat index to fill
    var s = 0;
    while (s < fss32 && fatBase < entryCount) {
      var chunk = Math.min(8, fss32 - s);
      var sec = this._dev.readSectors(fatStart + s, chunk);
      if (sec === null) return false;
      var chunkEntries = Math.floor(sec.length / 4);
      var toFill = Math.min(chunkEntries, entryCount - fatBase);
      for (var ei = 0; ei < toFill; ei++) {
        this._fat[fatBase + ei] = readLE32(sec, ei * 4) & FAT32_MASK;
      }
      fatBase += toFill;
      s += chunk;
    }

    this._mounted = true;
    return true;
  }

  // ── Internal cluster helpers ─────────────────────────────────────────────

  private _clusterLba(cluster: number): number {
    var bpb = this._bpb!;
    return bpb.dataStart + (cluster - 2) * bpb.secsPerCluster;
  }

  private _chain(start: number): number[] {
    var result: number[] = [];
    var c = start & FAT32_MASK;
    var max = 65536;  // guard against corrupt chains
    while (c >= 2 && c < FAT32_BAD && max-- > 0) {
      result.push(c);
      var next = (c < this._fat.length) ? (this._fat[c] & FAT32_MASK) : FAT32_EOC;
      if (next >= FAT32_EOC_MIN) break;
      c = next;
    }
    return result;
  }

  private _readChain(start: number): number[] | null {
    var bpb   = this._bpb!;
    var chain = this._chain(start);
    var result: number[] = [];
    for (var i = 0; i < chain.length; i++) {
      var lba  = this._clusterLba(chain[i]);
      var secs = this._dev.readSectors(lba, bpb.secsPerCluster);
      if (secs === null) return null;
      for (var b = 0; b < secs.length; b++) result.push(secs[b]);
    }
    return result;
  }

  private _parseDirBytes(bytes: number[], baseLba: number): DirEntry32[] {
    var entries: DirEntry32[] = [];
    for (var off = 0; off < bytes.length; off += DIR_ENTRY_SIZE) {
      var first = bytes[off] & 0xFF;
      if (first === 0x00) break;
      if (first === 0xE5) continue;
      var attr = bytes[off + 11] & 0xFF;
      if ((attr & ATTR_LFN) === ATTR_LFN) continue;
      if (attr & ATTR_VOLUME_ID) continue;
      var name      = parseName83(bytes, off);
      var clusterHi = readLE16(bytes, off + 20);
      var clusterLo = readLE16(bytes, off + 26);
      var cluster   = ((clusterHi << 16) | clusterLo) >>> 0;
      var size      = readLE32(bytes, off + 28);
      var secIdx    = Math.floor(off / SECTOR_SIZE);
      entries.push({
        name, attr, cluster, size,
        dirLba:      baseLba + secIdx,
        entryOffset: off % SECTOR_SIZE,
      });
    }
    return entries;
  }

  private _readDir(cluster: number): DirEntry32[] | null {
    var bpb   = this._bpb!;
    var chain = this._chain(cluster);
    if (chain.length === 0) return [];
    var bytes: number[] = [];
    for (var i = 0; i < chain.length; i++) {
      var lba = this._clusterLba(chain[i]);
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        var sec = this._dev.readSectors(lba + s, 1);
        if (sec === null) return null;
        for (var b = 0; b < 512; b++) bytes.push(sec[b]);
      }
    }
    return this._parseDirBytes(bytes, this._clusterLba(chain[0]));
  }

  // ── Path resolution ──────────────────────────────────────────────────────

  private _resolve(path: string): DirEntry32 | null {
    var parts = path.replace(/^\/+/, '').split('/').filter(p => p.length > 0);
    if (parts.length === 0) return null;

    var entries = this._readDir(this._bpb!.rootCluster);
    if (entries === null) return null;

    for (var i = 0; i < parts.length; i++) {
      var part  = parts[i].toUpperCase();
      var found: DirEntry32 | null = null;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].name.toUpperCase() === part) { found = entries[j]; break; }
      }
      if (found === null) return null;
      if (i < parts.length - 1) {
        if (!(found.attr & ATTR_DIRECTORY)) return null;
        entries = this._readDir(found.cluster);
        if (entries === null) return null;
      } else {
        return found;
      }
    }
    return null;
  }

  private _listPath(path: string): DirEntry32[] | null {
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return this._readDir(this._bpb!.rootCluster);
    var entry = this._resolve(norm);
    if (entry === null) return null;
    if (!(entry.attr & ATTR_DIRECTORY)) return null;
    if (entry.cluster === 0) return this._readDir(this._bpb!.rootCluster);
    return this._readDir(entry.cluster);
  }

  // ── VFSMount interface ───────────────────────────────────────────────────

  exists(path: string): boolean {
    if (!this._mounted) return false;
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return true;
    return this._resolve(norm) !== null;
  }

  isDirectory(path: string): boolean {
    if (!this._mounted) return false;
    var norm = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (norm === '') return true;
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
    var len  = Math.min(entry.size, bytes.length);
    var text = '';
    for (var i = 0; i < len; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }

  readBinary(path: string): number[] | null {
    if (!this._mounted) return null;
    var entry = this._resolve(path.replace(/^\/+/, ''));
    if (entry === null) return null;
    if (entry.attr & ATTR_DIRECTORY) return null;
    if (entry.cluster === 0) return [];
    var bytes = this._readChain(entry.cluster);
    if (bytes === null) return null;
    return bytes.slice(0, entry.size);
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

  // ── FAT write helpers ────────────────────────────────────────────────────

  private _flushFat(): boolean {
    if (!this._fatDirty) return true;
    var bpb       = this._bpb!;
    var entriesPerSector = SECTOR_SIZE / 4;  // 128 entries per 512-byte sector

    for (var copy = 0; copy < bpb.numFats; copy++) {
      var base = bpb.fatStart + copy * bpb.fatSizeSectors;
      for (var s = 0; s < bpb.fatSizeSectors; s++) {
        var firstEntry = s * entriesPerSector;
        var lastEntry  = Math.min(firstEntry + entriesPerSector, this._fat.length);

        // Skip sectors that only contain zero FAT entries (free clusters).
        // A zero entry IS valid on a sparse disk image, so no write needed.
        var hasNonZero = false;
        for (var e = firstEntry; e < lastEntry; e++) {
          if ((this._fat[e] & FAT32_MASK) !== 0) { hasNonZero = true; break; }
        }
        if (!hasNonZero) continue;

        // Serialise this sector's FAT entries to bytes and write.
        var sec: number[] = [];
        for (var e = firstEntry; e < lastEntry; e++) {
          var v = this._fat[e] & FAT32_MASK;
          sec.push(v & 0xFF);
          sec.push((v >>  8) & 0xFF);
          sec.push((v >> 16) & 0xFF);
          sec.push((v >> 24) & 0xFF);
        }
        zeroPad(sec, SECTOR_SIZE);
        if (!this._dev.writeSectors(base + s, 1, sec)) return false;
      }
    }
    this._fatDirty = false;
    return true;
  }

  private _allocFreeCluster(): number | null {
    for (var i = 2; i < this._fat.length; i++) {
      if ((this._fat[i] & FAT32_MASK) === FAT32_FREE) return i;
    }
    return null;
  }

  private _allocChain(data: number[]): number | null {
    var bpb          = this._bpb!;
    var clusterBytes = bpb.secsPerCluster * SECTOR_SIZE;
    var numClusters  = data.length === 0 ? 1 : ceilDiv(data.length, clusterBytes);

    var clusters: number[] = [];
    for (var n = 0; n < numClusters; n++) {
      var c = this._allocFreeCluster();
      if (c === null) return null;
      this._fat[c] = FAT32_EOC;  // temporarily mark as end
      clusters.push(c);
    }

    // Link chain
    for (var n = 0; n < clusters.length - 1; n++)
      this._fat[clusters[n]] = clusters[n + 1] & FAT32_MASK;
    this._fat[clusters[clusters.length - 1]] = FAT32_EOC;
    this._fatDirty = true;

    // Write data to clusters
    for (var n = 0; n < clusters.length; n++) {
      var lba  = this._clusterLba(clusters[n]);
      var base = n * clusterBytes;
      var clusterData: number[] = [];
      for (var b = 0; b < clusterBytes; b++)
        clusterData.push(base + b < data.length ? data[base + b] : 0);
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        var slice = clusterData.slice(s * SECTOR_SIZE, (s + 1) * SECTOR_SIZE);
        if (!this._dev.writeSectors(lba + s, 1, slice)) return null;
      }
    }
    return clusters[0];
  }

  private _freeChain(startCluster: number): void {
    var chain = this._chain(startCluster);
    for (var i = 0; i < chain.length; i++) this._fat[chain[i]] = FAT32_FREE;
    this._fatDirty = true;
  }

  private _buildDirEntry(name: string, attr: number, cluster: number, size: number): number[] {
    var ent = new Array<number>(DIR_ENTRY_SIZE).fill(0);
    var n83 = formatName83(name);
    for (var i = 0; i < 11; i++) ent[i] = n83[i];
    ent[11] = attr;
    writeLE16(ent, 20, (cluster >> 16) & 0xFFFF);  // clusterHi
    writeLE16(ent, 26,  cluster        & 0xFFFF);  // clusterLo
    writeLE32(ent, 28, size);
    return ent;
  }

  private _writeDirEntry(lba: number, offset: number, entry: number[]): boolean {
    var sec = this._dev.readSectors(lba, 1);
    if (sec === null) return false;
    for (var i = 0; i < DIR_ENTRY_SIZE; i++) sec[offset + i] = entry[i];
    return this._dev.writeSectors(lba, 1, sec);
  }

  /** Find a free 32-byte slot in `dirCluster`'s directory, extending if needed. */
  private _findFreeSlot(dirCluster: number | null): { lba: number; offset: number } | null {
    var bpb    = this._bpb!;
    var rootCl = dirCluster ?? bpb.rootCluster;
    var chain  = this._chain(rootCl);

    for (var ci = 0; ci < chain.length; ci++) {
      var cLba = this._clusterLba(chain[ci]);
      for (var s = 0; s < bpb.secsPerCluster; s++) {
        var sec = this._dev.readSectors(cLba + s, 1);
        if (sec === null) return null;
        for (var off = 0; off < SECTOR_SIZE; off += DIR_ENTRY_SIZE) {
          var first = sec[off] & 0xFF;
          if (first === 0x00 || first === 0xE5)
            return { lba: cLba + s, offset: off };
        }
      }
    }

    // Extend directory with a new cluster
    var newCluster = this._allocFreeCluster();
    if (newCluster === null) return null;
    this._fat[chain[chain.length - 1]] = newCluster & FAT32_MASK;
    this._fat[newCluster] = FAT32_EOC;
    this._fatDirty = true;

    var newLba  = this._clusterLba(newCluster);
    var blank   = new Array<number>(SECTOR_SIZE).fill(0);
    for (var s = 0; s < bpb.secsPerCluster; s++) {
      if (!this._dev.writeSectors(newLba + s, 1, blank)) return null;
    }
    return { lba: newLba, offset: 0 };
  }

  // ── Public write API ─────────────────────────────────────────────────────

  writeFile(path: string, content: string): boolean {
    var data: number[] = [];
    for (var i = 0; i < content.length; i++) data.push(content.charCodeAt(i) & 0xFF);
    return this.writeBinary(path, data);
  }

  writeBinary(path: string, data: number[]): boolean {
    if (!this._mounted) return false;
    var norm  = path.replace(/^\/+/, '');
    var slash = norm.lastIndexOf('/');
    var dir   = slash >= 0 ? norm.substring(0, slash) : '';
    var fname = slash >= 0 ? norm.substring(slash + 1) : norm;
    if (!fname) return false;

    var dirCluster: number | null = null;
    if (dir !== '') {
      var dirEntry = this._resolve(dir);
      if (dirEntry === null || !(dirEntry.attr & ATTR_DIRECTORY)) return false;
      dirCluster = dirEntry.cluster;
    }

    // Overwrite: delete existing entry first
    var existing = this._resolve(norm);
    if (existing !== null && !(existing.attr & ATTR_DIRECTORY)) {
      if (existing.cluster >= 2) this._freeChain(existing.cluster);
      var oldSec = this._dev.readSectors(existing.dirLba, 1);
      if (oldSec) { oldSec[existing.entryOffset] = 0xE5; this._dev.writeSectors(existing.dirLba, 1, oldSec); }
      this._flushFat();
    }

    var firstCluster = this._allocChain(data);
    if (firstCluster === null) return false;

    var slot = this._findFreeSlot(dirCluster);
    if (slot === null) { this._freeChain(firstCluster); return false; }
    var ent = this._buildDirEntry(fname, 0x20 /* ARCHIVE */, firstCluster, data.length);
    if (!this._writeDirEntry(slot.lba, slot.offset, ent)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

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
      dirCluster = dirEntry.cluster;
    }

    if (this._resolve(norm) !== null) return false;  // already exists

    var newCluster = this._allocFreeCluster();
    if (newCluster === null) return false;
    this._fat[newCluster] = FAT32_EOC;
    this._fatDirty = true;

    var bpb         = this._bpb!;
    var clLba       = this._clusterLba(newCluster);
    var parentCl    = dirCluster ?? bpb.rootCluster;
    var blank       = new Array<number>(SECTOR_SIZE).fill(0);
    var dotEnt      = this._buildDirEntry('.', ATTR_DIRECTORY, newCluster, 0);
    var ddotEnt     = this._buildDirEntry('..', ATTR_DIRECTORY, parentCl, 0);
    var firstSec    = blank.slice();
    for (var i = 0; i < DIR_ENTRY_SIZE; i++) {
      firstSec[i]                = dotEnt[i];
      firstSec[DIR_ENTRY_SIZE+i] = ddotEnt[i];
    }
    for (var s = 0; s < bpb.secsPerCluster; s++) {
      if (!this._dev.writeSectors(clLba + s, 1, s === 0 ? firstSec : blank)) return false;
    }

    var slot = this._findFreeSlot(dirCluster);
    if (slot === null) { this._fat[newCluster] = FAT32_FREE; this._fatDirty = true; return false; }
    var ent = this._buildDirEntry(dname, ATTR_DIRECTORY, newCluster, 0);
    if (!this._writeDirEntry(slot.lba, slot.offset, ent)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

  remove(path: string): boolean {
    if (!this._mounted) return false;
    var norm  = path.replace(/^\/+/, '');
    var entry = this._resolve(norm);
    if (entry === null) return false;

    if (entry.attr & ATTR_DIRECTORY) {
      var children = this._readDir(entry.cluster);
      if (children === null) return false;
      if (children.filter(e => e.name !== '.' && e.name !== '..').length > 0) return false;
      if (entry.cluster >= 2) this._freeChain(entry.cluster);
    } else {
      if (entry.cluster >= 2) this._freeChain(entry.cluster);
    }

    var sec = this._dev.readSectors(entry.dirLba, 1);
    if (sec === null) return false;
    sec[entry.entryOffset] = 0xE5;
    if (!this._dev.writeSectors(entry.dirLba, 1, sec)) return false;

    this._flushFat();
    this._dev.flush();
    return true;
  }

  getStats(): { totalClusters: number; freeClusters: number; bytesPerCluster: number; freeGB: string } {
    if (!this._mounted) {
      return { totalClusters: 0, freeClusters: 0, bytesPerCluster: 0, freeGB: '0.00' };
    }
    var bpb   = this._bpb!;
    var total = this._fat.length - 2;
    var free  = 0;
    for (var i = 2; i < this._fat.length; i++) {
      if ((this._fat[i] & FAT32_MASK) === FAT32_FREE) free++;
    }
    var bpc      = bpb.secsPerCluster * SECTOR_SIZE;
    var freeBytes = free * bpc;
    var freeGB    = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);
    return { totalClusters: total, freeClusters: free, bytesPerCluster: bpc, freeGB };
  }
}

export const fat32 = new FAT32(ataBlockDevice);
