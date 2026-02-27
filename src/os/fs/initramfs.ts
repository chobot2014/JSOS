/**
 * initramfs.ts — JSOS Initial RAM Filesystem
 *
 * Implements:
 *  - CPIO "newc" archive format parser (item 168)
 *  - Loads files from the embedded initramfs image into the VFS at boot
 *  - The initramfs is embedded in the ISO as a contiguous byte range and
 *    accessible via kernel.readInitramfs(offset, length)
 *
 * Format: Linux "newc" CPIO (magic "070701")
 *   Each entry:
 *     110-byte header (ASCII hex fields)
 *     filename (namesize bytes, NUL-terminated, padded to 4-byte boundary)
 *     file data (filesize bytes, padded to 4-byte boundary)
 *
 * Usage:
 *   import { loadInitramfs } from './initramfs.js';
 *   loadInitramfs(fs);
 *
 * Item 168.
 */

import type { FileSystem } from './filesystem.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── CPIO newc constants ───────────────────────────────────────────────────────

/** CPIO newc magic string. */
const CPIO_MAGIC = '070701';
/** CPIO newc header size in bytes (110 ASCII chars). */
const CPIO_HEADER_LEN = 110;
/** Sentinel filename that marks end of archive. */
const CPIO_EOF_NAME = 'TRAILER!!!';

// ── CPIOHeader ────────────────────────────────────────────────────────────────

interface CPIOHeader {
  ino:        number;
  mode:       number;   // UNIX file mode bits
  uid:        number;
  gid:        number;
  nlink:      number;
  mtime:      number;
  filesize:   number;
  devmajor:   number;
  devminor:   number;
  rdevmajor:  number;
  rdevminor:  number;
  namesize:   number;
  check:      number;
}

/** Parse one CPIO newc header from `buf` at `offset`. Returns header or null. */
function parseCpioHeader(buf: Uint8Array, offset: number): CPIOHeader | null {
  if (offset + CPIO_HEADER_LEN > buf.length) return null;

  // Magic check
  var magic = String.fromCharCode(
    buf[offset], buf[offset+1], buf[offset+2],
    buf[offset+3], buf[offset+4], buf[offset+5]
  );
  if (magic !== CPIO_MAGIC) return null;

  // Parse 13 hex fields of 8 chars each, starting at offset+6
  function hex8(pos: number): number {
    var s = String.fromCharCode(...buf.slice(offset + pos, offset + pos + 8));
    return parseInt(s, 16) || 0;
  }

  return {
    ino:       hex8(6),
    mode:      hex8(14),
    uid:       hex8(22),
    gid:       hex8(30),
    nlink:     hex8(38),
    mtime:     hex8(46),
    filesize:  hex8(54),
    devmajor:  hex8(62),
    devminor:  hex8(70),
    rdevmajor: hex8(78),
    rdevminor: hex8(86),
    namesize:  hex8(94),
    check:     hex8(102),
  };
}

/** Round up `n` to the next multiple of `align`. */
function alignUp(n: number, align: number): number {
  return Math.ceil(n / align) * align;
}

// ── Initramfs loader ──────────────────────────────────────────────────────────

export interface InitramfsResult {
  filesLoaded:  number;
  dirsCreated:  number;
  bytesTotal:   number;
  errors:       string[];
}

/**
 * Parse a CPIO newc archive from `data` and load all files into `fs`.
 * Existing files are overwritten.
 *
 * Item 168: initramfs: embed initial filesystem image in ISO.
 */
export function parseCpioArchive(data: Uint8Array, fs: FileSystem): InitramfsResult {
  var result: InitramfsResult = { filesLoaded: 0, dirsCreated: 0, bytesTotal: 0, errors: [] };
  var pos = 0;

  while (pos < data.length) {
    // Parse header
    var hdr = parseCpioHeader(data, pos);
    if (!hdr) {
      result.errors.push(`Bad CPIO header at offset ${pos}`);
      break;
    }
    pos += CPIO_HEADER_LEN;

    // Read filename
    var nameEnd = pos + hdr.namesize;
    var nameBytes = data.slice(pos, nameEnd);
    var name = '';
    for (var i = 0; i < nameBytes.length && nameBytes[i] !== 0; i++) {
      name += String.fromCharCode(nameBytes[i]);
    }
    pos = alignUp(pos + hdr.namesize, 4);

    // EOF sentinel
    if (name === CPIO_EOF_NAME) break;

    // File content
    var fileData = data.slice(pos, pos + hdr.filesize);
    pos = alignUp(pos + hdr.filesize, 4);

    // Ensure leading slash for VFS
    if (!name.startsWith('/')) name = '/' + name;

    // Mode bits: S_IFDIR = 0o40000, S_IFREG = 0o100000
    var isDir  = (hdr.mode & 0o170000) === 0o040000;
    var isFile = (hdr.mode & 0o170000) === 0o100000;

    try {
      if (isDir) {
        // Create directory (mkdir -p)
        _mkdirP(fs, name);
        result.dirsCreated++;
      } else if (isFile) {
        // Ensure parent directory exists
        var parent = name.substring(0, name.lastIndexOf('/')) || '/';
        _mkdirP(fs, parent);

        // Decode as UTF-8 text or store raw bytes
        var text = _decodeUTF8(fileData);
        fs.writeFile(name, text);
        result.filesLoaded++;
        result.bytesTotal += hdr.filesize;
      }
    } catch (e: any) {
      result.errors.push(`Failed to install ${name}: ${e?.message ?? e}`);
    }
  }

  return result;
}

/** Recursively create directory and all parents. */
function _mkdirP(fs: FileSystem, dirPath: string): void {
  if (!dirPath || dirPath === '/' || fs.exists(dirPath)) return;
  var parent = dirPath.substring(0, dirPath.lastIndexOf('/')) || '/';
  if (parent !== dirPath) _mkdirP(fs, parent);
  if (!fs.exists(dirPath)) {
    try { fs.mkdir(dirPath); } catch (_) {}
  }
}

/** Decode a Uint8Array as UTF-8 text. Falls back to Latin-1 if invalid. */
function _decodeUTF8(bytes: Uint8Array): string {
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch (_) {}
  // Fallback: Latin-1 byte-by-byte
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ── Kernel integration ────────────────────────────────────────────────────────

/**
 * Load the embedded initramfs from the kernel's embedded image table.
 * The kernel makes the initramfs available via `kernel.getInitramfs()` which
 * returns a Uint8Array containing the CPIO archive.
 *
 * Item 168.
 */
export function loadInitramfs(fs: FileSystem): InitramfsResult {
  if (typeof kernel === 'undefined') {
    return { filesLoaded: 0, dirsCreated: 0, bytesTotal: 0, errors: ['kernel not available'] };
  }

  var data: Uint8Array | null = null;

  // The kernel exposes the initramfs as an ArrayBuffer if it was embedded in the ISO
  if (kernel.getInitramfs) {
    var buf = kernel.getInitramfs();
    if (buf) data = new Uint8Array(buf);
  }

  if (!data || data.length === 0) {
    // No initramfs embedded — silently succeed (optional component)
    return { filesLoaded: 0, dirsCreated: 0, bytesTotal: 0, errors: [] };
  }

  return parseCpioArchive(data, fs);
}

// ── CPIO Archive builder ──────────────────────────────────────────────────────
//
// Utility to create a CPIO newc archive from file entries.
// Used by the build system to embed initramfs into the ISO.

export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
  mode: number;   // e.g. 0o100644 for regular file
}

/**
 * Build a CPIO newc archive from `entries`.
 * Returns the archive as a Uint8Array.
 */
export function buildCpioArchive(entries: ArchiveEntry[]): Uint8Array {
  var parts: Uint8Array[] = [];
  var ino   = 1;

  function addEntry(path: string, mode: number, data: Uint8Array): void {
    var nameBytes = _encodeUTF8(path + '\0');
    var namesize  = nameBytes.length;
    var filesize  = data.length;

    // Build 110-byte header
    var hdr = _buildCpioHeader(ino++, mode, filesize, namesize);
    parts.push(hdr);
    parts.push(nameBytes);

    // Pad name to 4-byte boundary (relative to start of header)
    var namePad = alignUp(CPIO_HEADER_LEN + namesize, 4) - (CPIO_HEADER_LEN + namesize);
    if (namePad > 0) parts.push(new Uint8Array(namePad));

    parts.push(data);
    var dataPad = alignUp(filesize, 4) - filesize;
    if (dataPad > 0) parts.push(new Uint8Array(dataPad));
  }

  for (var e of entries) addEntry(e.path, e.mode, e.data);

  // EOF trailer
  addEntry(CPIO_EOF_NAME, 0, new Uint8Array(0));

  // Concatenate all parts
  var total = parts.reduce((acc, p) => acc + p.length, 0);
  var result = new Uint8Array(total);
  var off = 0;
  for (var p of parts) { result.set(p, off); off += p.length; }
  return result;
}

function _buildCpioHeader(ino: number, mode: number, filesize: number, namesize: number): Uint8Array {
  function hex8(n: number): string { return (n >>> 0).toString(16).padStart(8, '0'); }
  var hdr = CPIO_MAGIC +
    hex8(ino)      +  // ino
    hex8(mode)     +  // mode
    hex8(0)        +  // uid
    hex8(0)        +  // gid
    hex8(1)        +  // nlink
    hex8(0)        +  // mtime
    hex8(filesize) +  // filesize
    hex8(0)        +  // devmajor
    hex8(0)        +  // devminor
    hex8(0)        +  // rdevmajor
    hex8(0)        +  // rdevminor
    hex8(namesize) +  // namesize
    hex8(0);          // check
  return _encodeUTF8(hdr);
}

function _encodeUTF8(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  var u = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
  return u;
}
