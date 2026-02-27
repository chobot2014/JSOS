/**
 * JSOS Syscall Allowlist Sandboxing
 *
 * [Item 759b] pledge-style syscall allowlist sandboxing for processes.
 *
 * Inspired by OpenBSD's pledge(2), this module lets a process (or its parent)
 * declare precisely which syscall categories are needed.  Once pledged, any
 * attempt to invoke a syscall outside the allowlist is denied and logged.
 *
 * Usage:
 *   sandboxManager.pledge(pid, ['stdio', 'inet']);   // allow stdio + networking
 *   sandboxManager.check(pid, 'SYS_read');           // true
 *   sandboxManager.check(pid, 'SYS_fork');           // false (not pledged)
 *   sandboxManager.revoke(pid);                      // remove sandbox
 *
 * Predefined pledge groups match JSOS syscall naming (SYS_*).
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export type SyscallName = string;  // e.g. 'SYS_read', 'SYS_write', 'SYS_fork'

/** Named pledge groups, each containing a set of allowed syscalls. */
export type PledgeGroup =
  | 'stdio'     // read, write, seek, stat, ioctl on stdio FDs
  | 'rpath'     // read-only file access
  | 'wpath'     // write file access
  | 'cpath'     // create/delete files
  | 'exec'      // process execution (fork+exec)
  | 'inet'      // IPv4/IPv6 sockets
  | 'unix'      // Unix-domain IPC sockets
  | 'proc'      // process management (kill, wait, getpid, etc.)
  | 'id'        // user/group identity (getuid, getgid, etc.)
  | 'timer'     // timers and clocks
  | 'mmap'      // memory mapping
  | 'tty'       // terminal I/O (ioctl on tty device)
  | 'vminfo'    // /proc/meminfo, /proc/stat queries
  | 'crypto'    // getrandom, cryptographic helpers
  | 'all';      // unrestricted (no sandbox)

export interface SandboxEntry {
  pid: number;
  groups: Set<PledgeGroup>;
  allowedSyscalls: Set<SyscallName>;
  pledgedAt: number;
  violationCount: number;
}

export interface SandboxViolation {
  pid: number;
  syscall: SyscallName;
  timestamp: number;
  groups: PledgeGroup[];
}

// ── Syscall → group mapping ────────────────────────────────────────────────────

const PLEDGE_MAP: Record<PledgeGroup, SyscallName[]> = {
  stdio: [
    'SYS_read', 'SYS_write', 'SYS_readv', 'SYS_writev',
    'SYS_close', 'SYS_fstat', 'SYS_lseek', 'SYS_dup', 'SYS_dup2',
    'SYS_ioctl', 'SYS_fcntl', 'SYS_select', 'SYS_poll',
    'SYS_nanosleep', 'SYS_sigreturn', 'SYS_getdents',
    'SYS_exit', 'SYS_exit_group', 'SYS_brk',
    'SYS_mprotect', 'SYS_munmap', 'SYS_rt_sigaction', 'SYS_rt_sigprocmask',
  ],
  rpath: [
    'SYS_open', 'SYS_openat', 'SYS_stat', 'SYS_lstat',
    'SYS_fstat', 'SYS_access', 'SYS_faccessat', 'SYS_readlink',
    'SYS_readlinkat', 'SYS_getdents', 'SYS_getdents64',
    'SYS_chdir', 'SYS_fchdir',
  ],
  wpath: [
    'SYS_open', 'SYS_openat', 'SYS_write', 'SYS_ftruncate',
    'SYS_fsync', 'SYS_fdatasync', 'SYS_pwrite64',
    'SYS_chown', 'SYS_fchown', 'SYS_fchownat', 'SYS_chmod', 'SYS_fchmod',
    'SYS_utimes', 'SYS_futimes', 'SYS_utimensat',
  ],
  cpath: [
    'SYS_open', 'SYS_openat', 'SYS_creat', 'SYS_mkdir', 'SYS_mkdirat',
    'SYS_rmdir', 'SYS_unlink', 'SYS_unlinkat', 'SYS_rename', 'SYS_renameat',
    'SYS_link', 'SYS_linkat', 'SYS_symlink', 'SYS_symlinkat',
  ],
  exec: [
    'SYS_fork', 'SYS_vfork', 'SYS_clone',
    'SYS_execve', 'SYS_execveat', 'SYS_waitpid', 'SYS_wait4',
    'SYS_signal', 'SYS_kill', 'SYS_sigaction',
  ],
  inet: [
    'SYS_socket', 'SYS_bind', 'SYS_connect', 'SYS_listen', 'SYS_accept',
    'SYS_accept4', 'SYS_sendto', 'SYS_recvfrom', 'SYS_sendmsg', 'SYS_recvmsg',
    'SYS_setsockopt', 'SYS_getsockopt', 'SYS_getpeername', 'SYS_getsockname',
    'SYS_shutdown', 'SYS_getaddrinfo',
  ],
  unix: [
    'SYS_socket', 'SYS_bind', 'SYS_connect', 'SYS_listen', 'SYS_accept',
    'SYS_accept4', 'SYS_sendto', 'SYS_recvfrom', 'SYS_sendmsg', 'SYS_recvmsg',
    'SYS_socketpair', 'SYS_shutdown',
  ],
  proc: [
    'SYS_getpid', 'SYS_getppid', 'SYS_getpgrp', 'SYS_setpgrp',
    'SYS_setsid', 'SYS_getsid',
    'SYS_kill', 'SYS_tgkill', 'SYS_waitpid', 'SYS_wait4',
    'SYS_setpriority', 'SYS_getpriority', 'SYS_nice',
    'SYS_prctl',
  ],
  id: [
    'SYS_getuid', 'SYS_geteuid', 'SYS_getgid', 'SYS_getegid',
    'SYS_getgroups', 'SYS_getresuid', 'SYS_getresgid',
    'SYS_setuid', 'SYS_seteuid', 'SYS_setgid', 'SYS_setegid',
    'SYS_setresuid', 'SYS_setresgid', 'SYS_setgroups',
  ],
  timer: [
    'SYS_gettime', 'SYS_clock_gettime', 'SYS_clock_getres',
    'SYS_gettimeofday', 'SYS_time',
    'SYS_timer_create', 'SYS_timer_settime', 'SYS_timer_gettime',
    'SYS_timer_delete', 'SYS_timerfd_create', 'SYS_timerfd_settime',
    'SYS_nanosleep', 'SYS_clock_nanosleep',
  ],
  mmap: [
    'SYS_mmap', 'SYS_mmap2', 'SYS_munmap', 'SYS_mremap',
    'SYS_mprotect', 'SYS_madvise', 'SYS_mlock', 'SYS_munlock',
    'SYS_msync', 'SYS_mincore',
  ],
  tty: [
    'SYS_ioctl', 'SYS_tcgetattr', 'SYS_tcsetattr',
    'SYS_read', 'SYS_write', 'SYS_open',
  ],
  vminfo: [
    'SYS_sysinfo', 'SYS_getrlimit', 'SYS_setrlimit', 'SYS_getrusage',
  ],
  crypto: [
    'SYS_getrandom',
  ],
  all: [],  // Special: handled separately — allows everything
};

// Expand the 'all' group dynamically
(function() {
  var all = new Set<SyscallName>();
  (Object.keys(PLEDGE_MAP) as PledgeGroup[]).forEach(function(g) {
    if (g !== 'all') PLEDGE_MAP[g].forEach(function(s) { all.add(s); });
  });
  PLEDGE_MAP['all'] = Array.from(all);
})();

/**
 * Build the full set of allowed syscalls for a list of pledge groups.
 */
function expandGroups(groups: PledgeGroup[]): Set<SyscallName> {
  var allowed = new Set<SyscallName>();
  groups.forEach(function(g) {
    (PLEDGE_MAP[g] ?? []).forEach(function(s) { allowed.add(s); });
  });
  return allowed;
}

// ── SandboxManager ─────────────────────────────────────────────────────────────

/**
 * [Item 759b] Syscall allowlist sandboxing manager.
 *
 * Tracks pledges per PID and enforces them on SYS_* calls.
 * Processes that are not sandboxed pass all checks (unrestricted).
 */
export class SandboxManager {
  private _entries:    Map<number, SandboxEntry> = new Map();
  private _violations: SandboxViolation[] = [];
  private _enforcing:  boolean = true;
  private _maxViolations: number = 2000;

  /**
   * [Item 759b] Pledge a process to a set of syscall groups.
   * Calling pledge again further restricts (never expands) the allowlist
   * if `narrowOnly` is true (default).
   */
  pledge(pid: number, groups: PledgeGroup[], narrowOnly: boolean = true): void {
    var existing = this._entries.get(pid);
    var newSyscalls = expandGroups(groups);

    if (existing && narrowOnly) {
      // Intersection: can only restrict, never expand
      var intersected = new Set<SyscallName>();
      newSyscalls.forEach(function(s) {
        if (existing!.allowedSyscalls.has(s)) intersected.add(s);
      });
      var newGroups = new Set<PledgeGroup>(groups.filter(function(g) {
        return existing!.groups.has(g);
      }));
      existing.allowedSyscalls = intersected;
      existing.groups = newGroups;
    } else {
      // Fresh pledge (or non-narrowing re-pledge)
      this._entries.set(pid, {
        pid,
        groups: new Set(groups),
        allowedSyscalls: newSyscalls,
        pledgedAt: kernel.getTicks(),
        violationCount: 0,
      });
    }
  }

  /**
   * [Item 759b] Check whether process `pid` is allowed to call `syscall`.
   * Returns true if the process has no sandbox (not pledged) or if
   * the syscall is in the allowlist.  Returns false (and logs violation)
   * if sandboxed and syscall not allowed.
   */
  check(pid: number, syscall: SyscallName): boolean {
    var entry = this._entries.get(pid);
    if (!entry) return true;  // not sandboxed — unrestricted

    if (entry.groups.has('all')) return true;  // explicitly unrestricted

    var allowed = entry.allowedSyscalls.has(syscall);
    if (!allowed) {
      entry.violationCount++;
      this._logViolation(pid, syscall, Array.from(entry.groups) as PledgeGroup[]);
    }
    return this._enforcing ? allowed : true;
  }

  /** Remove sandbox from a process. */
  revoke(pid: number): void { this._entries.delete(pid); }

  /** Check whether a PID is sandboxed. */
  isSandboxed(pid: number): boolean { return this._entries.has(pid); }

  /** Get a copy of the sandbox entry for a PID. */
  get(pid: number): SandboxEntry | undefined {
    var e = this._entries.get(pid);
    if (!e) return undefined;
    return { ...e, groups: new Set(e.groups), allowedSyscalls: new Set(e.allowedSyscalls) };
  }

  /** List all sandboxed PIDs. */
  list(): number[] {
    var pids: number[] = [];
    this._entries.forEach(function(_, pid) { pids.push(pid); });
    return pids;
  }

  /** Return the pledge group → syscall mapping (read-only copy). */
  groupMap(): Record<string, string[]> {
    var out: Record<string, string[]> = {};
    (Object.keys(PLEDGE_MAP) as PledgeGroup[]).forEach(function(g) {
      out[g] = PLEDGE_MAP[g].slice();
    });
    return out;
  }

  /** Add extra syscalls to an existing pledge group (kernel extension point). */
  extendGroup(group: PledgeGroup, syscalls: SyscallName[]): void {
    var arr = PLEDGE_MAP[group] ?? [];
    syscalls.forEach(function(s) { if (!arr.includes(s)) arr.push(s); });
    PLEDGE_MAP[group] = arr;
    // Rebuild any existing entries that include this group
    this._entries.forEach((entry) => {
      if (entry.groups.has(group)) {
        entry.allowedSyscalls = expandGroups(Array.from(entry.groups) as PledgeGroup[]);
      }
    });
  }

  // ── Mode & monitoring ────────────────────────────────────────────────────────

  setEnforcing(v: boolean): void { this._enforcing = v; }
  get isEnforcing(): boolean { return this._enforcing; }

  violations(): SandboxViolation[] { return this._violations.slice(); }
  clearViolations(): void { this._violations = []; }

  violationCount(pid?: number): number {
    if (pid !== undefined) return this._entries.get(pid)?.violationCount ?? 0;
    return this._violations.length;
  }

  private _logViolation(pid: number, syscall: SyscallName, groups: PledgeGroup[]): void {
    if (this._violations.length >= this._maxViolations) this._violations.shift();
    this._violations.push({ pid, syscall, timestamp: kernel.getTicks(), groups });
  }
}

/** Singleton sandbox manager. */
export const sandboxManager = new SandboxManager();

/** Convenience: pledge a PID with a shorthand string like "stdio rpath inet". */
export function pledge(pid: number, groupsStr: string, narrowOnly: boolean = true): void {
  var groups = groupsStr.trim().split(/\s+/) as PledgeGroup[];
  sandboxManager.pledge(pid, groups, narrowOnly);
}
