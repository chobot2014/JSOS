/**
 * JSOS POSIX Socket API (Phase 7)
 *
 * Wraps net.ts socket objects as FileDescriptions in the FDTable so that
 * POSIX socket syscalls (socket, connect, send, recv, close) work with fds.
 *
 * All TCP/UDP logic lives in net.ts; this file only provides the fd layer.
 */

import { net } from './net.js';
import type { Socket } from './net.js';
import { globalFDTable } from '../core/fdtable.js';
import type { FileDescription } from '../core/fdtable.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Domain / type constants ───────────────────────────────────────────────────

export const AF_INET  = 2;
export const AF_UNIX  = 1;
export const SOCK_STREAM = 1;
export const SOCK_DGRAM  = 2;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;

// ── TCPSocketDescription ──────────────────────────────────────────────────────

class TCPSocketDescription implements FileDescription {
  private sock:   Socket;
  private rxBuf:  number[] = [];

  constructor(sock: Socket) { this.sock = sock; }

  read(count: number): number[] {
    // Drain Net rx
    if (net.nicReady) net.pollNIC();
    var bytes = net.recvBytes(this.sock, 50);
    if (bytes) this.rxBuf = this.rxBuf.concat(bytes);
    var out = this.rxBuf.slice(0, count);
    this.rxBuf = this.rxBuf.slice(count);
    return out;
  }

  write(data: number[]): number {
    net.sendBytes(this.sock, data);
    return data.length;
  }

  seek(_offset: number, _whence: number): number { return -1; }
  close(): void { net.close(this.sock); }
  isReadable(): boolean {
    if (net.nicReady) net.pollNIC();
    return this.rxBuf.length > 0;
  }
}

// ── UDPSocketDescription ──────────────────────────────────────────────────────

class UDPSocketDescription implements FileDescription {
  private sock:    Socket;
  private rxBuf:   number[] = [];

  constructor(sock: Socket) { this.sock = sock; }

  read(count: number): number[] {
    if (net.nicReady) net.pollNIC();
    var r = net.recv(this.sock);
    if (r) {
      for (var i = 0; i < r.length; i++) this.rxBuf.push(r.charCodeAt(i) & 0xff);
    }
    var out = this.rxBuf.slice(0, count);
    this.rxBuf = this.rxBuf.slice(count);
    return out;
  }

  write(data: number[]): number {
    var str = '';
    for (var i = 0; i < data.length; i++) str += String.fromCharCode(data[i]);
    net.send(this.sock, str);
    return data.length;
  }

  seek(_offset: number, _whence: number): number { return -1; }
  close(): void { net.close(this.sock); }
  isReadable(): boolean { return this.rxBuf.length > 0; }
}

// Internal map from fd → raw net.Socket for operations that need it
var _socketMap = new Map<number, Socket>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a socket and return its file descriptor number.
 * domain: AF_INET | AF_UNIX
 * type:   SOCK_STREAM | SOCK_DGRAM
 */
export function socket(domain: number, type: number, _protocol: number = 0): number {
  if (domain === AF_INET && type === SOCK_STREAM) {
    var sock = net.createSocket('tcp');
    var fd = globalFDTable.insert(new TCPSocketDescription(sock));
    _socketMap.set(fd, sock);
    return fd;
  }
  if (domain === AF_INET && type === SOCK_DGRAM) {
    var sock = net.createSocket('udp');
    var fd = globalFDTable.insert(new UDPSocketDescription(sock));
    _socketMap.set(fd, sock);
    return fd;
  }
  return -1;
}

/**
 * Connect a TCP socket fd to a remote host:port.
 * Returns true on success.
 */
export function socketConnect(fd: number, host: string, port: number): boolean {
  var sock = _socketMap.get(fd);
  if (!sock) return false;
  return net.connect(sock, host, port);
}

/**
 * Send bytes over a socket fd. Returns bytes sent or -1.
 */
export function socketSend(fd: number, data: number[]): number {
  return globalFDTable.write(fd, data);
}

/**
 * Receive up to `count` bytes from a socket fd. Returns array or null.
 */
export function socketRecv(fd: number, count: number): number[] | null {
  var bytes = globalFDTable.read(fd, count);
  return bytes.length > 0 ? bytes : null;
}

/**
 * Close a socket fd.
 */
export function socketClose(fd: number): void {
  _socketMap.delete(fd);
  globalFDTable.close(fd);
}
