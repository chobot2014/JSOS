/**
 * JSOS System Call Interface
 *
 * Provides a clean, typed interface for system calls between the TypeScript OS
 * layer and the underlying kernel. This replaces direct kernel API calls with
 * proper system call numbers, parameter validation, and return value handling.
 */

import { globalFDTable, VFSFileDescription, SocketDescription } from './fdtable.js';
import { processManager } from '../process/process.js';
import { vmm } from '../process/vmm.js';
import { signalManager } from '../process/signals.js';
import { net } from '../net/net.js';
import fs from '../fs/filesystem.js';

declare var kernel: import('./kernel.js').KernelAPI;

// System call numbers (must match kernel implementation)
export const enum SyscallNumber {
  // Process management
  FORK = 1,
  EXEC = 2,
  EXIT = 3,
  WAIT = 4,
  GETPID = 5,
  GETPPID = 6,
  KILL = 7,

  // Memory management
  BRK = 8,
  MMAP = 9,
  MUNMAP = 10,

  // File I/O
  OPEN = 11,
  CLOSE = 12,
  READ = 13,
  WRITE = 14,
  LSEEK = 15,
  STAT = 16,
  FSTAT = 17,

  // Directory operations
  CHDIR = 18,
  GETCWD = 19,
  MKDIR = 20,
  RMDIR = 21,
  LINK = 22,
  UNLINK = 23,

  // Time
  TIME = 24,
  STIME = 25,

  // System info
  UNAME = 26,
  GETUID = 27,
  GETGID = 28,

  // Signals
  SIGNAL = 29,
  SIGACTION = 30,
  SIGPROCMASK = 31,

  // IPC
  PIPE = 32,
  MSGGET = 33,
  MSGSND = 34,
  MSGRCV = 35,

  // Network (future)
  SOCKET = 40,
  BIND = 41,
  LISTEN = 42,
  ACCEPT = 43,
  CONNECT = 44,
  SEND = 45,
  RECV = 46
}

export interface SyscallResult<T = any> {
  success: boolean;
  value?: T;
  error?: string;
  errno?: number;
}

// Error codes (POSIX-style)
export const enum Errno {
  EPERM = 1,      // Operation not permitted
  ENOENT = 2,     // No such file or directory
  ESRCH = 3,      // No such process
  EINTR = 4,      // Interrupted system call
  EIO = 5,        // I/O error
  ENXIO = 6,      // No such device or address
  E2BIG = 7,      // Argument list too long
  ENOEXEC = 8,    // Exec format error
  EBADF = 9,      // Bad file descriptor
  ECHILD = 10,    // No child processes
  EAGAIN = 11,    // Try again
  ENOMEM = 12,    // Out of memory
  EACCES = 13,    // Permission denied
  EFAULT = 14,    // Bad address
  ENOTBLK = 15,   // Block device required
  EBUSY = 16,     // Device or resource busy
  EEXIST = 17,    // File exists
  EXDEV = 18,     // Cross-device link
  ENODEV = 19,    // No such device
  ENOTDIR = 20,   // Not a directory
  EISDIR = 21,    // Is a directory
  EINVAL = 22,    // Invalid argument
  ENFILE = 23,    // File table overflow
  EMFILE = 24,    // Too many open files
  ENOTTY = 25,    // Not a typewriter
  ETXTBSY = 26,   // Text file busy
  EFBIG = 27,     // File too large
  ENOSPC = 28,    // No space left on device
  ESPIPE = 29,    // Illegal seek
  EROFS = 30,     // Read-only file system
  EMLINK = 31,    // Too many links
  EPIPE = 32,     // Broken pipe
  EDOM = 33,      // Math argument out of domain
  ERANGE = 34,    // Math result not representable
  ENOSYS = 38     // Function not implemented
}

export class SystemCallInterface {
  // ── Process ───────────────────────────────────────────────────────────────

  fork(): SyscallResult<number> {
    try { return { success: true, value: processManager.fork() }; }
    catch (e) { return { success: false, error: String(e), errno: Errno.ENOMEM }; }
  }

  exec(_path: string, _args: string[]): SyscallResult<never> {
    // Full ELF exec + ring-3 CPU switch is Phase 9; cooperative stub for now.
    return { success: false, error: 'exec: Phase 9 (ring-3) not yet active', errno: Errno.ENOSYS };
  }

  exit(status: number): void {
    var pid = processManager.getpid();
    var p   = processManager.getProcess(pid);
    if (p) { p.exitCode = status; p.state = 'dead'; }
  }

  wait(pid?: number): SyscallResult<{ pid: number; status: number }> {
    var target = (pid !== undefined && pid > 0) ? pid : processManager.getpid() + 1;
    try {
      var ws = processManager.waitpid(target);
      return { success: ws.pid >= 0, value: { pid: ws.pid, status: ws.exitCode } };
    } catch (e) { return { success: false, error: String(e), errno: Errno.ECHILD }; }
  }

  getpid():  SyscallResult<number> { return { success: true, value: processManager.getpid()  }; }
  getppid(): SyscallResult<number> { return { success: true, value: processManager.getppid() }; }

  kill(pid: number, sig: number): SyscallResult<void> {
    signalManager.send(pid, sig);
    return { success: true };
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  brk(addr?: number): SyscallResult<number> {
    var a = vmm.allocateVirtualMemory(addr || 4096, 'rw');
    return a !== null
      ? { success: true, value: a }
      : { success: false, errno: Errno.ENOMEM, error: 'ENOMEM' };
  }

  mmap(_addr: number, length: number, _prot: number, _flags: number,
       _fd: number, _offset: number): SyscallResult<number> {
    var a = vmm.allocateVirtualMemory(length || 4096, 'rw');
    return a !== null
      ? { success: true, value: a }
      : { success: false, errno: Errno.ENOMEM, error: 'ENOMEM' };
  }

  munmap(addr: number, length: number): SyscallResult<void> {
    vmm.freeVirtualMemory(addr, length);
    return { success: true };
  }

  // ── File I/O ──────────────────────────────────────────────────────────────

  open(pathname: string, _flags: number, _mode?: number): SyscallResult<number> {
    // /dev shortcuts
    if (pathname === '/dev/null')    return { success: true, value: globalFDTable.openDevNull()    };
    if (pathname === '/dev/zero')    return { success: true, value: globalFDTable.openDevZero()    };
    if (pathname === '/dev/urandom') return { success: true, value: globalFDTable.openDevUrandom() };
    // General VFS path
    var fd = globalFDTable.openPath(pathname, fs);
    return fd >= 0
      ? { success: true, value: fd }
      : { success: false, error: 'ENOENT: ' + pathname, errno: Errno.ENOENT };
  }

  close(fd: number): SyscallResult<void> {
    globalFDTable.close(fd);
    return { success: true };
  }

  read(fd: number, buf: Uint8Array, count: number): SyscallResult<number> {
    var data = globalFDTable.read(fd, count);
    for (var i = 0; i < data.length; i++) buf[i] = data[i];
    return { success: true, value: data.length };
  }

  write(fd: number, buf: Uint8Array, count: number): SyscallResult<number> {
    var data: number[] = [];
    for (var i = 0; i < count; i++) data.push(buf[i] || 0);
    var n = globalFDTable.write(fd, data);
    return n >= 0
      ? { success: true, value: n }
      : { success: false, errno: Errno.EBADF, error: 'EBADF' };
  }

  lseek(_fd: number, _offset: number, _whence: number): SyscallResult<number> {
    return { success: true, value: 0 }; // Phase 9: full seek via FDTable
  }

  // ── Directory ─────────────────────────────────────────────────────────────

  chdir(path: string): SyscallResult<void> {
    return fs.cd(path)
      ? { success: true }
      : { success: false, errno: Errno.ENOENT, error: 'ENOENT: ' + path };
  }

  getcwd(): SyscallResult<string> {
    return { success: true, value: fs.cwd() };
  }

  mkdir(pathname: string, _mode: number): SyscallResult<void> {
    return fs.mkdir(pathname)
      ? { success: true }
      : { success: false, errno: Errno.EEXIST, error: 'EEXIST: ' + pathname };
  }

  rmdir(pathname: string): SyscallResult<void> {
    return fs.rm(pathname)
      ? { success: true }
      : { success: false, errno: Errno.ENOENT, error: 'ENOENT: ' + pathname };
  }

  // ── Time ──────────────────────────────────────────────────────────────────

  time(): SyscallResult<number> {
    return { success: true, value: Math.floor(kernel.getUptime() / 1000) };
  }

  stime(_t: number): SyscallResult<void> { return { success: true }; }

  // ── System info ───────────────────────────────────────────────────────────

  uname(): SyscallResult<{ sysname: string; nodename: string; release: string; version: string; machine: string }> {
    return { success: true, value: {
      sysname:  'JSOS',
      nodename: fs.readFile('/etc/hostname') || 'jsos',
      release:  '1.0.0',
      version:  'QuickJS-ES2023 #1',
      machine:  'i686',
    }};
  }

  getuid(): SyscallResult<number> { return { success: true, value: 0 }; }
  getgid(): SyscallResult<number> { return { success: true, value: 0 }; }

  // ── Signals ───────────────────────────────────────────────────────────────

  signal(signum: number, handler: Function): SyscallResult<Function> {
    signalManager.handle(processManager.getpid(), signum, handler as (sig: number) => void);
    return { success: true, value: handler };
  }

  // ── IPC / Pipes ───────────────────────────────────────────────────────────

  pipe(): SyscallResult<{ read: number; write: number }> {
    var pair = globalFDTable.pipe();
    return { success: true, value: { read: pair[0], write: pair[1] } };
  }

  // ── Sockets (Phase 7) ─────────────────────────────────────────────────────

  /**
   * Create a TCP or UDP socket and return its fd number.
   * The fd can be read/written like a file via sys.read/write/close.
   * For connect/bind/listen, use sys.getSocketId(fd) to get the raw socket ID
   * and pass it to the net.* API directly.
   */
  socket(type: 'tcp' | 'udp' = 'tcp'): SyscallResult<number> {
    try {
      return { success: true, value: globalFDTable.openSocket(net, type) };
    } catch (e) { return { success: false, errno: Errno.ENOMEM, error: String(e) }; }
  }

  connect(fd: number, ip: string, port: number): SyscallResult<boolean> {
    var sockId = globalFDTable.getSocketId(fd);
    if (sockId < 0) return { success: false, errno: Errno.EBADF, error: 'EBADF' };
    var ok = net.connect(sockId, ip, port);
    return { success: ok, value: ok };
  }

  bind(fd: number, port: number): SyscallResult<void> {
    var sockId = globalFDTable.getSocketId(fd);
    if (sockId < 0) return { success: false, errno: Errno.EBADF, error: 'EBADF' };
    try { (net as any).bind(sockId, port); } catch (_e) { /* optional in net */ }
    return { success: true };
  }

  listen(fd: number): SyscallResult<void> {
    var sockId = globalFDTable.getSocketId(fd);
    if (sockId < 0) return { success: false, errno: Errno.EBADF, error: 'EBADF' };
    try { (net as any).listen(sockId); } catch (_e) { /* optional in net */ }
    return { success: true };
  }

  send(fd: number, data: string): SyscallResult<number> {
    var sockId = globalFDTable.getSocketId(fd);
    if (sockId < 0) return { success: false, errno: Errno.EBADF, error: 'EBADF' };
    net.send(sockId, data);
    return { success: true, value: data.length };
  }

  recv(fd: number): SyscallResult<string> {
    var sockId = globalFDTable.getSocketId(fd);
    if (sockId < 0) return { success: false, errno: Errno.EBADF, error: 'EBADF' };
    return { success: true, value: net.recv(sockId) || '' };
  }
}

export const syscalls = new SystemCallInterface();