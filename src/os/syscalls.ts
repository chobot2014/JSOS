/**
 * JSOS System Call Interface
 *
 * Provides a clean, typed interface for system calls between the TypeScript OS
 * layer and the underlying kernel. This replaces direct kernel API calls with
 * proper system call numbers, parameter validation, and return value handling.
 */

import { KernelAPI } from './kernel.js';

declare var kernel: KernelAPI;

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
  ERANGE = 34     // Math result not representable
}

export class SystemCallInterface {
  private nextFd = 3; // 0=stdin, 1=stdout, 2=stderr

  /**
   * Make a system call to the kernel
   * This is a placeholder - in a real implementation, this would use
   * architecture-specific syscall instructions
   */
  private syscall(num: SyscallNumber, ...args: any[]): SyscallResult {
    try {
      // For now, we'll simulate syscalls by calling kernel functions
      // In a real OS, this would be: syscall(num, arg1, arg2, ...)
      switch (num) {
        case SyscallNumber.GETPID:
          return { success: true, value: 1 }; // Mock PID

        case SyscallNumber.TIME:
          return { success: true, value: Math.floor(Date.now() / 1000) };

        case SyscallNumber.BRK:
          // Mock memory allocation
          return { success: true, value: 0x100000 };

        default:
          return { success: false, error: 'Not implemented', errno: Errno.ENOSYS };
      }
    } catch (e) {
      return { success: false, error: String(e), errno: Errno.EFAULT };
    }
  }

  // Process Management System Calls
  fork(): SyscallResult<number> {
    return this.syscall(SyscallNumber.FORK);
  }

  exec(path: string, args: string[]): SyscallResult<never> {
    return this.syscall(SyscallNumber.EXEC, path, args);
  }

  exit(status: number): void {
    this.syscall(SyscallNumber.EXIT, status);
  }

  wait(pid?: number): SyscallResult<{ pid: number; status: number }> {
    return this.syscall(SyscallNumber.WAIT, pid);
  }

  getpid(): SyscallResult<number> {
    return this.syscall(SyscallNumber.GETPID);
  }

  getppid(): SyscallResult<number> {
    return this.syscall(SyscallNumber.GETPPID);
  }

  kill(pid: number, sig: number): SyscallResult<void> {
    return this.syscall(SyscallNumber.KILL, pid, sig);
  }

  // Memory Management System Calls
  brk(addr?: number): SyscallResult<number> {
    return this.syscall(SyscallNumber.BRK, addr);
  }

  mmap(addr: number, length: number, prot: number, flags: number, fd: number, offset: number): SyscallResult<number> {
    return this.syscall(SyscallNumber.MMAP, addr, length, prot, flags, fd, offset);
  }

  munmap(addr: number, length: number): SyscallResult<void> {
    return this.syscall(SyscallNumber.MUNMAP, addr, length);
  }

  // File I/O System Calls
  open(pathname: string, flags: number, mode?: number): SyscallResult<number> {
    const result = this.syscall(SyscallNumber.OPEN, pathname, flags, mode);
    if (result.success && typeof result.value === 'number') {
      return { success: true, value: this.nextFd++ };
    }
    return result;
  }

  close(fd: number): SyscallResult<void> {
    return this.syscall(SyscallNumber.CLOSE, fd);
  }

  read(fd: number, buf: Uint8Array, count: number): SyscallResult<number> {
    return this.syscall(SyscallNumber.READ, fd, buf, count);
  }

  write(fd: number, buf: Uint8Array, count: number): SyscallResult<number> {
    return this.syscall(SyscallNumber.WRITE, fd, buf, count);
  }

  lseek(fd: number, offset: number, whence: number): SyscallResult<number> {
    return this.syscall(SyscallNumber.LSEEK, fd, offset, whence);
  }

  // Directory Operations
  chdir(path: string): SyscallResult<void> {
    return this.syscall(SyscallNumber.CHDIR, path);
  }

  getcwd(): SyscallResult<string> {
    return this.syscall(SyscallNumber.GETCWD);
  }

  mkdir(pathname: string, mode: number): SyscallResult<void> {
    return this.syscall(SyscallNumber.MKDIR, pathname, mode);
  }

  rmdir(pathname: string): SyscallResult<void> {
    return this.syscall(SyscallNumber.RMDIR, pathname);
  }

  // Time Operations
  time(): SyscallResult<number> {
    return this.syscall(SyscallNumber.TIME);
  }

  stime(t: number): SyscallResult<void> {
    return this.syscall(SyscallNumber.STIME, t);
  }

  // System Information
  uname(): SyscallResult<{
    sysname: string;
    nodename: string;
    release: string;
    version: string;
    machine: string;
  }> {
    return this.syscall(SyscallNumber.UNAME);
  }

  getuid(): SyscallResult<number> {
    return this.syscall(SyscallNumber.GETUID);
  }

  getgid(): SyscallResult<number> {
    return this.syscall(SyscallNumber.GETGID);
  }

  // Signal Operations
  signal(signum: number, handler: Function): SyscallResult<Function> {
    return this.syscall(SyscallNumber.SIGNAL, signum, handler);
  }

  // IPC Operations
  pipe(): SyscallResult<{ read: number; write: number }> {
    return this.syscall(SyscallNumber.PIPE);
  }
}

export const syscalls = new SystemCallInterface();