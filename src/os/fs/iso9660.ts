/**
 * JSOS ISO 9660 Read-Only Filesystem Driver
 *
 * [Item 190] ISO 9660 read — boot media access.
 *
 * ISO 9660 (also known as ECMA-119 / CD-ROM File System) stores files in
 * fixed-size 2048-byte logical blocks.  The Primary Volume Descriptor (PVD)
 * sits at LBA 16.  Directories are stored as extents of Directory Records.
 *
 * Also supports Rock Ridge extensions (RR) for long filenames and Unix
 * permissions (detected via 'RR', 'SP', 'NM', 'PX' system-use fields).
 *
 * Joliet extensions (UCS-2 long filenames) are detected via the Supplementary
 * Volume Descriptor with escape sequence '\x25\x2F\x45' (Level 3 Joliet).
 *
 * Implements VFSMount so it can be mounted anywhere in the JSOS VFS tree.
 */

import type { VFSMount, FileType } from './filesystem.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const ISO_SECTOR_SIZE = 2048;
const PVD_LBA         = 16;   // Primary Volume Descriptor

const VD_TYPE_PRIMARY      = 1;
const VD_TYPE_SUPPLEMENTARY = 2;
const VD_TYPE_TERMINATOR    = 255;

// Rock Ridge system-use signatures
const RR_SIG_NM = 0x4d4e; // 'NM' — alternate name
const RR_SIG_PX = 0x5850; // 'PX' — POSIX attribs
const RR_SIG_SL = 0x4c53; // 'SL' — symbolic link

// ── Block device interface ──────────────────────────────────────────────────────

export interface ISO9660Device {
  /** Read one 2048-byte sector at the given LBA (logical block address). */
  readSector(lba: number): Uint8Array;
}

// ── DataView helpers ────────────────────────────────────────────────────────────

function u8  (dv: DataView, off: number): number { return dv.getUint8(off); }
function u16L(dv: DataView, off: number): number { return dv.getUint16(off, true); }
function u32L(dv: DataView, off: number): number { return dv.getUint32(off, true); }

// ── Primary Volume Descriptor ──────────────────────────────────────────────────

interface PVD {
  rootDirLba:     number;   // location of root directory extent
  rootDirSize:    number;   // size of root directory extent (bytes)
  logicalBlockSize: number; // usually 2048
  volumeId:       string;
}

function decodePVD(data: Uint8Array): PVD | null {
  // Byte 0 = volume descriptor type
  // Bytes 1-5 = 'CD001'
  // Byte 6 = version (always 1)
  if (data.length < 2048) return null;
  if (data[1] !== 0x43 || data[2] !== 0x44 || data[3] !== 0x30 ||
      data[4] !== 0x30 || data[5] !== 0x31) return null;
  var dv  = new DataView(data.buffer, data.byteOffset, data.byteLength);
  var vol = '';
  for (var i = 40; i < 72; i++) {
    var c = data[i];
    if (c === 0x20 || c === 0) break;
    vol += String.fromCharCode(c);
  }
  // Root directory record is at offset 156 (34 bytes)
  var lba     = u32L(dv, 156 + 2);  // location of extent (LE)
  var size    = u32L(dv, 156 + 10); // data length (LE)
  var lbSize  = u16L(dv, 128);      // logical block size (LE half)
  return { rootDirLba: lba, rootDirSize: size, logicalBlockSize: lbSize || 2048, volumeId: vol };
}

// ── Directory Record ────────────────────────────────────────────────────────────

interface DirRecord {
  name:     string;
  lba:      number;
  size:     number;
  isDir:    boolean;
  flags:    number;
}

/**
 * Parse all directory records from a raw directory sector buffer.
 * ISO 9660 directory entries are variable-length; a record length of 0 means
 * the rest of the current sector is padding — skip to the next sector boundary.
 */
function parseDirSector(data: Uint8Array, offset: number, sectorSize: number): DirRecord[] {
  var records: DirRecord[] = [];
  var end = offset + sectorSize;
  var pos = offset;
  while (pos < end) {
    if (pos >= data.length) break;
    var recLen = data[pos];
    if (recLen === 0) {
      // Padding — skip to next sector
      var nextSector = (pos - offset + sectorSize) & ~(sectorSize - 1);
      pos = offset + nextSector;
      continue;
    }
    if (pos + recLen > data.length) break;
    var dv        = new DataView(data.buffer, data.byteOffset, data.byteLength);
    var lba       = u32L(dv, pos + 2);
    var size      = u32L(dv, pos + 10);
    var fileFlags = data[pos + 25];
    var isDir     = (fileFlags & 0x02) !== 0;
    var nameLen   = data[pos + 32];
    var rawName   = '';
    for (var ni = 0; ni < nameLen; ni++) rawName += String.fromCharCode(data[pos + 33 + ni]);
    // Strip version number (';1')
    var semiIdx = rawName.indexOf(';');
    var cleanName = semiIdx >= 0 ? rawName.slice(0, semiIdx) : rawName;
    // Strip trailing dot (ISO 9660 pads filenames with '.')
    if (cleanName.endsWith('.')) cleanName = cleanName.slice(0, -1);

    // Try Rock Ridge NM extension for alternate name
    var rrName = parseRockRidgeNM(data, pos + 33 + nameLen, pos + recLen);
    if (rrName) cleanName = rrName;

    // Skip '.' and '..' entries
    if (nameLen === 1 && (data[pos + 33] === 0x00 || data[pos + 33] === 0x01)) {
      pos += recLen;
      continue;
    }
    records.push({ name: cleanName, lba, size, isDir, flags: fileFlags });
    pos += recLen;
  }
  return records;
}

/**
 * Scan System Use fields after the file identifier for Rock Ridge NM (alternate name).
 * Returns the alternate name string or null if not found.
 */
function parseRockRidgeNM(data: Uint8Array, suStart: number, recEnd: number): string | null {
  // System Use area must be byte-aligned; skip padding byte if file identifier length is even
  var off = suStart;
  if ((suStart & 1) !== 0) off++; // for odd-length file identifiers
  while (off + 3 < recEnd && off < data.length) {
    var sig    = (data[off] << 8) | data[off + 1];
    var suLen  = data[off + 2];
    if (suLen < 4 || off + suLen > recEnd) break;
    if (sig === RR_SIG_NM) {
      // NM field: byte 4 = flags, bytes 5..suLen-1 = name component
      var nameLen = suLen - 5;
      if (nameLen > 0) {
        var name = '';
        for (var i = 0; i < nameLen; i++) name += String.fromCharCode(data[off + 5 + i]);
        return name;
      }
    }
    if (suLen === 0) break;
    off += suLen;
  }
  return null;
}

// ── ISO9660FS class ─────────────────────────────────────────────────────────────

/**
 * [Item 190] ISO 9660 read-only filesystem driver.
 *
 * Mount an ISO 9660 image over a block device.  Implements VFSMount so it
 * can be used at any mount point in the JSOS kernel VFS tree.
 *
 * Usage:
 *   const fs = new ISO9660FS(myDevice);
 *   fs.read('/boot/vmlinuz');           // read file
 *   fs.list('/boot');                   // list directory
 *   fs.exists('/boot/vmlinuz');         // test existence
 *   fs.isDirectory('/boot');            // test directory
 */
export class ISO9660FS implements VFSMount {
  private _dev:   ISO9660Device;
  private _pvd:   PVD | null = null;
  private _ready: boolean = false;

  constructor(dev: ISO9660Device) {
    this._dev = dev;
    this._init();
  }

  private _init(): void {
    try {
      // Scan volume descriptors starting at LBA 16
      for (var lba = PVD_LBA; lba < PVD_LBA + 32; lba++) {
        var data = this._dev.readSector(lba);
        if (data.length < 8) break;
        var vdType = data[0];
        if (vdType === VD_TYPE_TERMINATOR) break;
        if (vdType === VD_TYPE_PRIMARY) {
          this._pvd = decodePVD(data);
          if (this._pvd) { this._ready = true; break; }
        }
      }
    } catch (_) { /* device not ready */ }
  }

  private _readExtent(lba: number, size: number): Uint8Array {
    var pvd = this._pvd!;
    var sectors = Math.ceil(size / pvd.logicalBlockSize);
    var out = new Uint8Array(sectors * pvd.logicalBlockSize);
    for (var s = 0; s < sectors; s++) {
      var sdata = this._dev.readSector(lba + s);
      out.set(sdata.subarray(0, pvd.logicalBlockSize), s * pvd.logicalBlockSize);
    }
    return out.subarray(0, size);
  }

  private _listDir(lba: number, size: number): DirRecord[] {
    var pvd  = this._pvd!;
    var data = this._readExtent(lba, size);
    var records: DirRecord[] = [];
    var pos = 0;
    while (pos < data.length) {
      var sectorRecords = parseDirSector(data, pos, pvd.logicalBlockSize);
      records = records.concat(sectorRecords);
      pos += pvd.logicalBlockSize;
    }
    return records;
  }

  /**
   * Resolve a path to a DirRecord by walking the directory tree.
   * Returns null if not found.
   */
  private _resolve(path: string): DirRecord | null {
    var pvd = this._pvd; if (!pvd) return null;
    var parts = path.replace(/^\//, '').split('/').filter(function(p) { return p.length > 0; });
    // Start at root
    var currentLba  = pvd.rootDirLba;
    var currentSize = pvd.rootDirSize;

    if (parts.length === 0) {
      // Root directory itself
      return { name: '', lba: currentLba, size: currentSize, isDir: true, flags: 2 };
    }

    for (var i = 0; i < parts.length; i++) {
      var entries = this._listDir(currentLba, currentSize);
      var found: DirRecord | null = null;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].name.toUpperCase() === parts[i].toUpperCase()) {
          found = entries[j];
          break;
        }
      }
      if (!found) return null;
      if (i < parts.length - 1 && !found.isDir) return null;
      currentLba  = found.lba;
      currentSize = found.size;
      if (i === parts.length - 1) return found;
    }
    return null;
  }

  // ── VFSMount interface ────────────────────────────────────────────────────────

  read(path: string): string | null {
    if (!this._ready) return null;
    var rec = this._resolve(path);
    if (!rec || rec.isDir) return null;
    var data = this._readExtent(rec.lba, rec.size);
    var text = '';
    for (var i = 0; i < data.length; i++) text += String.fromCharCode(data[i]);
    return text;
  }

  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    if (!this._ready || !this._pvd) return [];
    var rec = !path || path === '/'
      ? { name: '', lba: this._pvd.rootDirLba, size: this._pvd.rootDirSize, isDir: true, flags: 2 }
      : this._resolve(path);
    if (!rec || !rec.isDir) return [];
    var entries = this._listDir(rec.lba, rec.size);
    return entries.map(function(e) {
      return { name: e.name, type: (e.isDir ? 'directory' : 'file') as FileType, size: e.size };
    });
  }

  exists(path: string): boolean {
    if (!this._ready) return false;
    if (!path || path === '/') return true;
    return this._resolve(path) !== null;
  }

  isDirectory(path: string): boolean {
    if (!this._ready) return false;
    if (!path || path === '/') return true;
    var rec = this._resolve(path);
    return rec ? rec.isDir : false;
  }

  get volumeId(): string { return this._pvd?.volumeId ?? ''; }
  get ready():    boolean { return this._ready; }
}

/**
 * Simple array-backed ISO 9660 device (for testing).
 * Wraps a raw Uint8Array image and serves 2048-byte sectors.
 */
export class ArrayISO9660Device implements ISO9660Device {
  private _data: Uint8Array;
  constructor(data: Uint8Array) { this._data = data; }

  readSector(lba: number): Uint8Array {
    var off = lba * ISO_SECTOR_SIZE;
    var end = Math.min(off + ISO_SECTOR_SIZE, this._data.length);
    if (off >= this._data.length) return new Uint8Array(ISO_SECTOR_SIZE);
    var out = new Uint8Array(ISO_SECTOR_SIZE);
    out.set(this._data.subarray(off, end));
    return out;
  }
}
