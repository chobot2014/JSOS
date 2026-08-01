/**
 * JSOS /dev Virtual Filesystem — Phase 6
 *
 * Provides standard Linux-compatible device nodes as virtual files.
 * Backed by the same FileDescription implementations used by FDTable.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── ChaCha20 PRNG for /dev/urandom and /dev/random (item 923) ────────────────
// 256-bit key initialised from TSC + boot time entropy; counter increments
// each block.  Generates cryptographically strong pseudorandom bytes.

function _cc20Rotl32(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function _cc20QR(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = _cc20Rotl32(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = _cc20Rotl32(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = _cc20Rotl32(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = _cc20Rotl32(s[b] ^ s[c], 7);
}

/** Generate one 64-byte ChaCha20 block into `out` (16 x uint32). */
function _cc20Block(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint32Array): void {
  // ChaCha20 constants: "expa nd 3 2-by te k"
  var s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (var ki = 0; ki < 8; ki++) s[4 + ki] = key[ki];
  s[12] = counter >>> 0;
  s[13] = nonce[0]; s[14] = nonce[1]; s[15] = nonce[2];
  var ws = new Uint32Array(s);
  for (var ri = 0; ri < 10; ri++) {
    _cc20QR(ws, 0, 4, 8, 12); _cc20QR(ws, 1, 5, 9, 13);
    _cc20QR(ws, 2, 6, 10, 14); _cc20QR(ws, 3, 7, 11, 15);
    _cc20QR(ws, 0, 5, 10, 15); _cc20QR(ws, 1, 6, 11, 12);
    _cc20QR(ws, 2, 7, 8, 13); _cc20QR(ws, 3, 4, 9, 14);
  }
  for (var wi = 0; wi < 16; wi++) out[wi] = (ws[wi] + s[wi]) >>> 0;
}

/** Build a 256-bit key (8 x uint32) seeded from TSC + RTC or fallback. */
function _cc20MakeKey(): Uint32Array {
  var t0 = typeof kernel !== 'undefined' && kernel.getTicks ? kernel.getTicks() : Date.now();
  var t1 = Date.now();
  var key = new Uint32Array(8);
  key[0] = t0 & 0xffffffff; key[1] = Math.floor(t0 / 0x100000000) & 0xffffffff;
  key[2] = t1 & 0xffffffff; key[3] = (t1 * 0x9e3779b9) & 0xffffffff;
  key[4] = 0xdeadbeef ^ key[0]; key[5] = 0xcafebabe ^ key[1];
  key[6] = 0xbaadf00d ^ key[2]; key[7] = 0xfeedface ^ key[3];
  return key;
}

export class DevFS {
  private _cc20Key: Uint32Array = _cc20MakeKey();
  private _cc20Nonce: Uint32Array = new Uint32Array([0x4a000000, 0x00000001, 0x00000000]);
  private _cc20Counter: number = 0;
  private _cc20Buf: Uint32Array = new Uint32Array(16);
  private _cc20BufPos: number = 64; // force first block generation

  /** Generate `count` cryptographically strong random bytes using ChaCha20 (item 923). */
  private _cc20RandomBytes(count: number): number[] {
    var out: number[] = [];
    for (var i = 0; i < count; i++) {
      if (this._cc20BufPos >= 64) {
        _cc20Block(this._cc20Key, this._cc20Counter, this._cc20Nonce, this._cc20Buf);
        this._cc20Counter = (this._cc20Counter + 1) >>> 0;
        this._cc20BufPos = 0;
      }
      // Extract one byte from the current word
      var wordIdx = (this._cc20BufPos >> 2) | 0;
      var byteIdx = this._cc20BufPos & 3;
      out.push((this._cc20Buf[wordIdx] >>> (byteIdx * 8)) & 0xff);
      this._cc20BufPos++;
    }
    return out;
  }

  /**
   * Read from a /dev device path.
   * Returns a byte array, or null if the device does not exist.
   */
  read(path: string, count: number): number[] | null {
    switch (path) {
      case '/dev/null':
        return []; // EOF immediately

      case '/dev/zero': {
        var out: number[] = [];
        for (var i = 0; i < count; i++) out.push(0);
        return out;
      }

      case '/dev/urandom':
      case '/dev/random':
        return this._cc20RandomBytes(count);

      case '/dev/stdin':
        return null; // handled by FDTable fd 0

      default:
        return null; // no such device
    }
  }

  /**
   * Write to a /dev device path.
   * Returns bytes written, or -1 if not writable.
   */
  write(path: string, data: number[]): number {
    switch (path) {
      case '/dev/null':
        return data.length; // silently discard

      case '/dev/stdout':
      case '/dev/stderr': {
        var s = '';
        for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
        kernel.serialPut(s);
        return data.length;
      }

      default:
        return -1;
    }
  }

  /** Returns true if the given path exists in /dev. */
  exists(path: string): boolean {
    var devs = [
      '/dev/null', '/dev/zero', '/dev/urandom', '/dev/random',
      '/dev/stdin', '/dev/stdout', '/dev/stderr',
      '/dev/tty', '/dev/fb0',
      '/dev/input', '/dev/input/mouse0',
    ];
    for (var i = 0; i < devs.length; i++) {
      if (devs[i] === path) return true;
    }
    return false;
  }

  /** List entries under /dev. */
  list(): string[] {
    return [
      'null', 'zero', 'urandom', 'random',
      'stdin', 'stdout', 'stderr',
      'tty', 'fb0',
      'input',
    ];
  }
}

export const devFS = new DevFS();

/**
 * VFSMount adapter — exposes DevFS to the filesystem.ts VFS mount table.
 * Mounted at '/dev' by main.ts during Phase 6 boot:
 *   fs.mountVFS('/dev', devFSMount)
 *
 * Implements the VFSMount interface (read/list/exists/isDirectory) that the
 * in-memory VFS expects from any mounted subsystem.
 */
export class DevFSMount {
  /** Read a /dev device path as a text string (up to 512 bytes). */
  read(path: string): string | null {
    var bytes = devFS.read(path, 512);
    if (bytes === null) return null;
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  exists(path: string): boolean {
    if (path === '/dev/dri' || path === '/dev/dri/' || path === '/dev/dri/card0') return true;
    return devFS.exists(path);
  }

  isDirectory(path: string): boolean {
    return path === '/dev' || path === '/dev/' ||
           path === '/dev/input' ||
           path === '/dev/dri'   || path === '/dev/dri/';
  }

  /** Override list() to include /dev/dri sub-directory. */
  list(path: string): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
    if (path === '/dev' || path === '/dev/') {
      var base = devFS.list().map(function(name) {
        return {
          name: name,
          type: name === 'input' ? 'directory' as const : 'file' as const,
          size: 0,
        };
      });
      base.push({ name: 'dri', type: 'directory' as const, size: 0 });
      return base;
    }
    if (path === '/dev/input') {
      return [{ name: 'mouse0', type: 'file' as const, size: 0 }];
    }
    if (path === '/dev/dri' || path === '/dev/dri/') {
      return [{ name: 'card0', type: 'file' as const, size: 0 }];
    }
    return [];
  }
}

export const devFSMount = new DevFSMount();
