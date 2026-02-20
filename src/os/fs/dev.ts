/**
 * JSOS /dev Virtual Filesystem — Phase 6
 *
 * Provides standard Linux-compatible device nodes as virtual files.
 * Backed by the same FileDescription implementations used by FDTable.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

/** A simple xorshift32 PRNG for /dev/urandom. */
function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state >>> 0;
}

export class DevFS {
  private _rngState: number = 0xdeadbeef;

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

      case '/dev/urandom': {
        var rnd: number[] = [];
        for (var j = 0; j < count; j++) {
          this._rngState = xorshift32(this._rngState);
          rnd.push(this._rngState & 0xff);
        }
        return rnd;
      }

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
      '/dev/null', '/dev/zero', '/dev/urandom',
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
      'null', 'zero', 'urandom',
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
