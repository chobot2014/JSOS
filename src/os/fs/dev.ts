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
