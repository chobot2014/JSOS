/**
 * JSOS OverlayFS — Union Mount
 *
 * [Item 191] OverlayFS: writable layer over read-only base.
 *
 * Architecture:
 *   - One writable **upper** layer (implements WritableVFSMount).
 *   - One or more read-only **lower** layers (implements VFSMount).
 *   - Read path: check upper first → lower layers in order.
 *   - Write path: copy-on-write to upper layer.
 *   - Delete: record a "whiteout" tombstone in the upper layer.
 *
 * The overlay is itself a VFSMount and a WritableVFSMount so it can be
 * mounted anywhere in the JSOS kernel VFS tree.
 *
 * Whiteout convention (Docker/OCI compatible):
 *   A file named `.wh.<name>` in the upper layer shadows `<name>` from
 *   lower layers.  Opaque directories are marked with `.wh..wh..opq`.
 *
 * The upper layer is represented by OverlayUpperLayer (an in-memory store);
 * swap it for an ext4-backed implementation for persistence.
 */

import type { VFSMount, FileType } from './filesystem.js';

// ── Writable VFS mount interface ─────────────────────────────────────────────

export interface WritableVFSMount extends VFSMount {
  write(path: string, content: string): number;  // 0 = success, <0 = error
  unlink(path: string): number;
  mkdir(path: string): number;
  rmdir(path: string): number;
}

// ── In-memory upper layer ────────────────────────────────────────────────────

interface UpperEntry {
  type:    FileType;
  content: string;  // empty for directories
}

/**
 * Simple in-memory upper layer for OverlayFS.
 *
 * Can be replaced with a persistent ext4-backed upper layer.
 */
export class MemoryUpperLayer implements WritableVFSMount {
  private _files: Map<string, UpperEntry> = new Map();

  private _norm(p: string): string {
    return '/' + p.replace(/^\//, '').replace(/\/$/, '');
  }

  read(path: string): string | null {
    var e = this._files.get(this._norm(path));
    if (!e || e.type !== 'file') return null;
    return e.content;
  }

  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    var base = this._norm(path).replace(/\/$/, '');
    var out: Array<{ name: string; type: FileType; size: number }> = [];
    this._files.forEach((entry, key) => {
      if (key === base || !key.startsWith(base + '/')) return;
      var rela = key.slice(base.length + 1);
      if (rela.indexOf('/') >= 0) return; // skip nested
      out.push({ name: rela, type: entry.type, size: entry.content.length });
    });
    return out;
  }

  exists(path: string): boolean { return this._files.has(this._norm(path)); }

  isDirectory(path: string): boolean {
    var e = this._files.get(this._norm(path));
    return !!e && e.type === 'directory';
  }

  write(path: string, content: string): number {
    var n = this._norm(path);
    // Ensure parent directory exists
    var parent = n.slice(0, n.lastIndexOf('/')) || '/';
    if (!this._files.has(parent) && parent !== '/') this.mkdir(parent);
    this._files.set(n, { type: 'file', content });
    return 0;
  }

  unlink(path: string): number {
    var n = this._norm(path);
    if (!this._files.has(n)) return -2; // ENOENT
    var e = this._files.get(n)!;
    if (e.type === 'directory') return -21; // EISDIR
    this._files.delete(n);
    return 0;
  }

  mkdir(path: string): number {
    var n = this._norm(path);
    if (this._files.has(n)) return -17; // EEXIST
    this._files.set(n, { type: 'directory', content: '' });
    return 0;
  }

  rmdir(path: string): number {
    var n = this._norm(path);
    if (!this._files.has(n)) return -2;
    if (!this.isDirectory(path)) return -20; // ENOTDIR
    // Only remove if empty
    var entries = this.list(path);
    if (entries.length > 0) return -39; // ENOTEMPTY
    this._files.delete(n);
    return 0;
  }

  /** Snapshot the upper layer for debugging / persistence. */
  snapshot(): Record<string, { type: FileType; content: string }> {
    var out: Record<string, { type: FileType; content: string }> = {};
    this._files.forEach((v, k) => { out[k] = { type: v.type, content: v.content }; });
    return out;
  }
}

// ── OverlayFS ─────────────────────────────────────────────────────────────────

const WHITEOUT_PREFIX = '.wh.';
const OPAQUE_MARKER   = '.wh..wh..opq';

function whiteoutName(name: string): string { return WHITEOUT_PREFIX + name; }
function isWhiteout(name: string): boolean  { return name.startsWith(WHITEOUT_PREFIX); }
function originalName(wh: string): string   { return wh.slice(WHITEOUT_PREFIX.length); }

/**
 * [Item 191] OverlayFS: union filesystem.
 *
 * Stacks zero or more read-only lower layers under a writable upper layer.
 * All JSOS VFS path operations are dispatched through this overlay.
 *
 * Copy-Up:
 *   Before the first write to a file that exists only in a lower layer, OverlayFS
 *   copies the file to the upper layer. Subsequent writes to the upper copy do not
 *   affect lower layers.
 *
 * Deletion:
 *   Deleting a file creates a whiteout in the upper layer.  The file becomes
 *   invisible even though it still exists in the lower layers.
 *
 * Opaque Directory:
 *   Creating a new directory on top of a lower directory adds a `.wh..wh..opq`
 *   marker to prevent lower-layer entries from leaking up (used for `rm -rf` then `mkdir`).
 */
export class OverlayFS implements WritableVFSMount {
  private _upper:  WritableVFSMount;
  private _lower:  VFSMount[];

  /**
   * @param upper Writable upper layer (copy-up target, receives all writes).
   * @param lower Zero or more read-only lower layers (checked in order, index 0 first).
   */
  constructor(upper: WritableVFSMount, ...lower: VFSMount[]) {
    this._upper = upper;
    this._lower = lower;
  }

  private _norm(p: string): string {
    return '/' + p.replace(/^\//, '').replace(/\/$/, '');
  }

  private _basename(path: string): string {
    var n = this._norm(path);
    var i = n.lastIndexOf('/');
    return n.slice(i + 1);
  }

  private _dirname(path: string): string {
    var n = this._norm(path);
    var i = n.lastIndexOf('/');
    return i === 0 ? '/' : n.slice(0, i);
  }

  /** Check if a name is hidden by a whiteout in the upper layer. */
  private _isHidden(parentPath: string, name: string): boolean {
    var wh = this._norm(parentPath + '/' + whiteoutName(name));
    return this._upper.exists(wh);
  }

  /** Check if a directory is opaque (lower entries should not be merged). */
  private _isOpaque(dirPath: string): boolean {
    return this._upper.exists(this._norm(dirPath + '/' + OPAQUE_MARKER));
  }

  // ── Copy-Up ────────────────────────────────────────────────────────────────

  /**
   * [Item 191 — copy-up] Copy a file from the first lower layer that has it
   * to the upper layer.  Called before any write to a lower file.
   */
  private _copyUp(path: string): void {
    if (this._upper.exists(path)) return;
    for (var i = 0; i < this._lower.length; i++) {
      var content = this._lower[i].read(path);
      if (content !== null) {
        // Ensure parent dirs exist in upper
        var dir = this._dirname(path);
        if (!this._upper.exists(dir)) this._copyUpDir(dir);
        this._upper.write(path, content);
        return;
      }
    }
  }

  private _copyUpDir(path: string): void {
    if (this._upper.exists(path)) return;
    this._upper.mkdir(path);
  }

  // ── VFSMount interface ──────────────────────────────────────────────────────

  read(path: string): string | null {
    // Upper layer first
    if (this._upper.exists(path)) {
      var content = this._upper.read(path);
      if (content !== null) return content;
    }
    var name = this._basename(path);
    var dir  = this._dirname(path);
    if (this._isHidden(dir, name)) return null; // whiteout
    for (var i = 0; i < this._lower.length; i++) {
      var data = this._lower[i].read(path);
      if (data !== null) return data;
    }
    return null;
  }

  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    var seen    = new Set<string>();
    var hidden  = new Set<string>();
    var result:  Array<{ name: string; type: FileType; size: number }> = [];
    var opaque  = this._isOpaque(path);

    // Collect from upper layer
    var upperEntries = this._upper.list(path);
    for (var ui = 0; ui < upperEntries.length; ui++) {
      var uEntry = upperEntries[ui];
      if (uEntry.name === OPAQUE_MARKER) continue;
      if (isWhiteout(uEntry.name)) {
        hidden.add(originalName(uEntry.name));
        continue;
      }
      if (!seen.has(uEntry.name)) {
        seen.add(uEntry.name);
        result.push(uEntry);
      }
    }

    // Stop here if the directory is opaque (no lower passthrough)
    if (opaque) return result;

    // Merge lower layers (respecting whiteouts)
    for (var li = 0; li < this._lower.length; li++) {
      var lowerEntries = this._lower[li].list(path);
      for (var lj = 0; lj < lowerEntries.length; lj++) {
        var lEntry = lowerEntries[lj];
        if (seen.has(lEntry.name) || hidden.has(lEntry.name)) continue;
        seen.add(lEntry.name);
        result.push(lEntry);
      }
    }
    return result;
  }

  exists(path: string): boolean {
    if (this._upper.exists(path)) return true;
    var name = this._basename(path);
    var dir  = this._dirname(path);
    if (this._isHidden(dir, name)) return false;
    for (var i = 0; i < this._lower.length; i++) {
      if (this._lower[i].exists(path)) return true;
    }
    return false;
  }

  isDirectory(path: string): boolean {
    if (this._upper.exists(path)) return this._upper.isDirectory(path);
    var name = this._basename(path);
    var dir  = this._dirname(path);
    if (this._isHidden(dir, name)) return false;
    for (var i = 0; i < this._lower.length; i++) {
      if (this._lower[i].exists(path)) return this._lower[i].isDirectory(path);
    }
    return false;
  }

  // ── WritableVFSMount interface ──────────────────────────────────────────────

  write(path: string, content: string): number {
    this._copyUp(path);
    return this._upper.write(path, content);
  }

  unlink(path: string): number {
    var lowerExists = false;
    var name = this._basename(path);
    var dir  = this._dirname(path);
    for (var i = 0; i < this._lower.length; i++) {
      if (this._lower[i].exists(path)) { lowerExists = true; break; }
    }
    if (this._upper.exists(path)) {
      var err = this._upper.unlink(path);
      if (err < 0 && err !== -2) return err;
    }
    // If the file exists below, lay down a whiteout
    if (lowerExists) {
      var whPath = dir + '/' + whiteoutName(name);
      this._copyUpDir(dir);
      return this._upper.write(whPath, '');
    }
    return 0;
  }

  mkdir(path: string): number {
    if (this.exists(path)) return -17; // EEXIST
    this._copyUpDir(this._dirname(path));
    var err = this._upper.mkdir(path);
    if (err < 0) return err;
    // If lower has the same directory name, mark as opaque so lower entries
    // don't bleed through after an unlink+mkdir cycle
    for (var i = 0; i < this._lower.length; i++) {
      if (this._lower[i].isDirectory(path)) {
        this._upper.write(path + '/' + OPAQUE_MARKER, '');
        break;
      }
    }
    return 0;
  }

  rmdir(path: string): number {
    var entries = this.list(path);
    if (entries.length > 0) return -39; // ENOTEMPTY
    var name = this._basename(path);
    var dir  = this._dirname(path);
    var lowerHas = this._lower.some(function(l) { return l.isDirectory(path); });
    if (this._upper.exists(path)) this._upper.rmdir(path);
    if (lowerHas) {
      this._copyUpDir(dir);
      this._upper.write(dir + '/' + whiteoutName(name), '');
    }
    return 0;
  }

  // ── Convenience ─────────────────────────────────────────────────────────────

  /**
   * Add an additional lower layer below the existing ones.
   * Useful for Docker-style layer stacking where each image layer is pushed.
   */
  pushLower(layer: VFSMount): void { this._lower.push(layer); }

  get upperLayer(): WritableVFSMount { return this._upper; }
  get lowerLayers(): VFSMount[]      { return this._lower.slice(); }
}
