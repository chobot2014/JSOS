/**
 * JSOS File Descriptor Table — Phase 6
 *
 * Unified fd table layered over all I/O backends.
 * Every process gets its own FDTable; it is cloned on fork().
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

/** A simple ring-buffer used by pipes. */
class RingBuffer {
  private _buf: number[] = [];

  write(data: number[]): number {
    for (var i = 0; i < data.length; i++) this._buf.push(data[i]);
    return data.length;
  }

  read(n: number): number[] {
    return this._buf.splice(0, n);
  }

  available(): number { return this._buf.length; }
}

/** Abstract file description — every open fd points to one. */
export interface FileDescription {
  read(count: number): number[];
  write(data: number[]): number;
  seek(offset: number, whence: number): number;
  close(): void;
}

/** Terminal stdin/stdout/stderr shim. */
class TerminalDescription implements FileDescription {
  private _isRead: boolean;
  constructor(isRead: boolean) { this._isRead = isRead; }

  read(count: number): number[] {
    if (!this._isRead) return [];
    var ch = kernel.waitKey();
    return ch ? [ch.charCodeAt(0)] : [];
  }

  write(data: number[]): number {
    var s = '';
    for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    kernel.serialPut(s);
    return data.length;
  }

  seek(offset: number, whence: number): number { return -1; }
  close(): void {}
}

/** Read end of a pipe. */
class PipeReadDescription implements FileDescription {
  constructor(private _buf: RingBuffer) {}

  read(count: number): number[] { return this._buf.read(count); }
  write(data: number[]): number { return -1; } // EBADF
  seek(offset: number, whence: number): number { return -1; }
  close(): void {}
}

/** Write end of a pipe. */
class PipeWriteDescription implements FileDescription {
  constructor(private _buf: RingBuffer) {}

  read(count: number): number[] { return []; } // EBADF
  write(data: number[]): number { return this._buf.write(data); }
  seek(offset: number, whence: number): number { return -1; }
  close(): void {}
}

/** /dev/null */
class DevNullDescription implements FileDescription {
  read(count: number): number[] { return []; }
  write(data: number[]): number { return data.length; } // swallow silently
  seek(offset: number, whence: number): number { return 0; }
  close(): void {}
}

/** /dev/zero */
class DevZeroDescription implements FileDescription {
  read(count: number): number[] {
    var out: number[] = [];
    for (var i = 0; i < count; i++) out.push(0);
    return out;
  }
  write(data: number[]): number { return data.length; }
  seek(offset: number, whence: number): number { return 0; }
  close(): void {}
}

/** /dev/urandom — xorshift32 PRNG */
class DevUrandomDescription implements FileDescription {
  private _state: number = 0xdeadbeef;

  read(count: number): number[] {
    var out: number[] = [];
    for (var i = 0; i < count; i++) {
      this._state ^= this._state << 13;
      this._state ^= this._state >> 17;
      this._state ^= this._state << 5;
      out.push(this._state & 0xff);
    }
    return out;
  }
  write(data: number[]): number { return data.length; }
  seek(offset: number, whence: number): number { return 0; }
  close(): void {}
}

/**
 * Pipe: a pair of connected read/write file descriptions.
 * Used both as a standalone object and inserted into an FDTable.
 */
export class Pipe {
  private _buf: RingBuffer = new RingBuffer();
  readonly reader: PipeReadDescription;
  readonly writer: PipeWriteDescription;

  constructor() {
    this.reader = new PipeReadDescription(this._buf);
    this.writer = new PipeWriteDescription(this._buf);
  }

  write(data: number[]): number { return this.writer.write(data); }
  read(count: number): number[] { return this.reader.read(count); }
  available(): number { return this._buf.available(); }
}

/**
 * Unified file descriptor table for one process.
 */
export class FDTable {
  private _fds: Map<number, FileDescription> = new Map();
  private _nextFd: number = 3;

  constructor() {
    // Install standard descriptors
    this._fds.set(0, new TerminalDescription(true));   // stdin
    this._fds.set(1, new TerminalDescription(false));  // stdout
    this._fds.set(2, new TerminalDescription(false));  // stderr
  }

  /** Insert a FileDescription and return its assigned fd. */
  insert(desc: FileDescription): number {
    var fd = this._nextFd++;
    this._fds.set(fd, desc);
    return fd;
  }

  /** Create a pipe and return [readFd, writeFd]. */
  pipe(): [number, number] {
    var p = new Pipe();
    var rfd = this.insert(p.reader);
    var wfd = this.insert(p.writer);
    return [rfd, wfd];
  }

  openDevNull(): number { return this.insert(new DevNullDescription()); }
  openDevZero(): number { return this.insert(new DevZeroDescription()); }
  openDevUrandom(): number { return this.insert(new DevUrandomDescription()); }

  read(fd: number, count: number): number[] {
    var d = this._fds.get(fd);
    return d ? d.read(count) : [];
  }

  write(fd: number, data: number[]): number {
    var d = this._fds.get(fd);
    return d ? d.write(data) : -1;
  }

  close(fd: number): void {
    var d = this._fds.get(fd);
    if (d) { d.close(); this._fds.delete(fd); }
  }

  dup(fd: number): number {
    var d = this._fds.get(fd);
    if (!d) return -1;
    return this.insert(d); // shared reference
  }

  /** Clone this table (for fork). */
  clone(): FDTable {
    var t = new FDTable();
    this._fds.forEach(function(desc, fd) { t._fds.set(fd, desc); });
    t._nextFd = this._nextFd;
    return t;
  }

  has(fd: number): boolean { return this._fds.has(fd); }
}

export const globalFDTable = new FDTable();
