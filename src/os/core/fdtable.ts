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
  /** Optional device-control call (e.g. DRM ioctls). */
  ioctl?(request: number, arg: number): number;
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
 * Wraps a VFS string buffer as a seekable, writable POSIX file description.
 * Created by FDTable.openPath() to give fd semantics to in-memory FS files.
 */
export class VFSFileDescription implements FileDescription {
  private _data: number[];
  private _pos: number = 0;
  private _writeback: ((data: number[]) => void) | null;

  constructor(content: string, writeback?: (data: number[]) => void) {
    this._data = [];
    for (var i = 0; i < content.length; i++) this._data.push(content.charCodeAt(i) & 0xff);
    this._writeback = writeback || null;
  }

  read(count: number): number[] {
    var chunk = this._data.slice(this._pos, this._pos + count);
    this._pos += chunk.length;
    return chunk;
  }

  write(data: number[]): number {
    for (var i = 0; i < data.length; i++) {
      if (this._pos + i < this._data.length) this._data[this._pos + i] = data[i];
      else this._data.push(data[i]);
    }
    this._pos += data.length;
    if (this._writeback) this._writeback(this._data);
    return data.length;
  }

  seek(offset: number, whence: number): number {
    if      (whence === 0) this._pos = offset;               // SEEK_SET
    else if (whence === 1) this._pos += offset;              // SEEK_CUR
    else if (whence === 2) this._pos = this._data.length + offset; // SEEK_END
    if (this._pos < 0) this._pos = 0;
    if (this._pos > this._data.length) this._pos = this._data.length;
    return this._pos;
  }

  close(): void { if (this._writeback) this._writeback(this._data); }

  /** Return current content as a string (for debugging / write-through). */
  toString(): string {
    var s = '';
    for (var i = 0; i < this._data.length; i++) s += String.fromCharCode(this._data[i]);
    return s;
  }
}

/**
 * Wraps a net.ts socket (by socket ID) as a streaming FileDescription.
 * Uses `net: any` to avoid a heavy circular import of net.ts into fdtable.ts.
 * Obtained via FDTable.openSocket(net, type).
 */
export class SocketDescription implements FileDescription {
  private _net: any;
  private _sockId: number;

  constructor(net: any, sockId: number) {
    this._net   = net;
    this._sockId = sockId;
  }

  /** Expose the raw socket ID so callers can pass it to net.connect etc. */
  get sockId(): number { return this._sockId; }

  read(count: number): number[] {
    var s: string | null = this._net.recv(this._sockId);
    if (!s) return [];
    var bytes: number[] = [];
    for (var i = 0; i < s.length && bytes.length < count; i++)
      bytes.push(s.charCodeAt(i) & 0xff);
    return bytes;
  }

  write(data: number[]): number {
    var s = '';
    for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    this._net.send(this._sockId, s);
    return data.length;
  }

  seek(_offset: number, _whence: number): number { return -1; } // not seekable
  close(): void { this._net.close(this._sockId); }
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

  /**
   * Open a VFS path through `fsInst` (a FileSystem instance) and return its fd.
   * The underlying content is read into a VFSFileDescription buffer; writes are
   * flushed back to the FS on close().  Returns -1 if the path does not exist.
   */
  openPath(path: string, fsInst: any): number {
    var content: string | null = fsInst.readFile(path);
    if (content === null) return -1;
    return this.insert(new VFSFileDescription(content, function(data: number[]) {
      var s = '';
      for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
      fsInst.writeFile(path, s);
    }));
  }

  /**
   * Create a network socket via `netInst` of the given type and insert it.
   * Returns the new fd number.  The raw socket ID is accessible via getSocketId().
   */
  openSocket(netInst: any, type: 'tcp' | 'udp'): number {
    var sockId: number = netInst.createSocket(type);
    return this.insert(new SocketDescription(netInst, sockId));
  }

  /**
   * Return the raw socket ID for a socket fd, or -1 if fd is not a socket fd.
   * Use this to obtain the socket ID needed for net.connect/bind/listen etc.
   */
  getSocketId(fd: number): number {
    var d = this._fds.get(fd);
    return (d instanceof SocketDescription) ? d.sockId : -1;
  }

  /** Return the underlying FileDescription for an fd, or null. */
  getDesc(fd: number): FileDescription | null {
    return this._fds.get(fd) || null;
  }

  /**
   * Register any FileDescription directly as a new fd and return that fd.
   * Used by DRM, future character devices, etc. to install typed descs
   * without going through the VFS string-content path.
   */
  openDesc(desc: FileDescription): number {
    return this.insert(desc);
  }

  /**
   * Dispatch an ioctl to the FileDescription for `fd`.
   * Returns -EBADF if the fd does not exist, or -ENOTTY if the
   * description does not implement ioctl.
   */
  ioctl(fd: number, request: number, arg: number): number {
    var d = this._fds.get(fd);
    if (!d) return -9;  // -EBADF
    if (!d.ioctl) return -25; // -ENOTTY
    return d.ioctl(request, arg);
  }

  /**
   * Move the file-position indicator for `fd`.
   * Delegates to the underlying FileDescription's seek().
   * Returns the new offset, or a negative errno on error.
   */
  seek(fd: number, offset: number, whence: number): number {
    var d = this._fds.get(fd);
    if (!d) return -9; // -EBADF
    return d.seek(offset, whence);
  }
}

export const globalFDTable = new FDTable();
