/**
 * JSOS Virtual /proc Filesystem
 *
 * Provides live kernel/OS data via virtual file reads.
 * All data is generated on-demand — nothing is stored on disk.
 * Follows Linux /proc conventions so common tools and script patterns work.
 *
 * Mounted at /proc by main.ts after boot via fs.mountVFS('/proc', procFS).
 */

import { scheduler } from '../process/scheduler.js';
import { vmm } from '../process/vmm.js';
import { init } from '../process/init.js';
import { FileType } from './filesystem.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

export interface VFSEntry {
  name: string;
  type: FileType;
  size: number;
}

export class ProcFS {
  /**
   * Read a /proc path. Returns null if the path does not exist.
   */
  read(path: string): string | null {
    var rel = path.replace(/^\/proc\/?/, '');
    return this.readRel(rel);
  }

  /**
   * List entries under a /proc path.
   */
  list(path: string): VFSEntry[] {
    var rel = path.replace(/^\/proc\/?/, '');
    if (!rel) {
      var base: VFSEntry[] = [
        { name: 'version',     type: 'file',      size: 64  },
        { name: 'uptime',      type: 'file',      size: 20  },
        { name: 'meminfo',     type: 'file',      size: 256 },
        { name: 'cpuinfo',     type: 'file',      size: 256 },
        { name: 'loadavg',     type: 'file',      size: 32  },
        { name: 'stat',        type: 'file',      size: 128 },
        { name: 'schedstat',   type: 'file',      size: 64  },
        { name: 'mounts',      type: 'file',      size: 128 },
        { name: 'filesystems', type: 'file',      size: 32  },
        { name: 'net',         type: 'directory', size: 0   },
        { name: 'self',        type: 'directory', size: 0   },
      ];
      var procs = scheduler.getAllProcesses().map(function(p) {
        return { name: '' + p.pid, type: 'directory' as FileType, size: 0 };
      });
      return base.concat(procs);
    }

    if (rel === 'net') {
      return [
        { name: 'dev',      type: 'file', size: 256 },
        { name: 'if_inet6', type: 'file', size: 0   },
        { name: 'route',    type: 'file', size: 128 },
        { name: 'tcp',      type: 'file', size: 256 },
      ];
    }

    var pidMatch = rel.match(/^(\d+)$/);
    if (pidMatch && scheduler.getProcess(parseInt(pidMatch[1]))) {
      return [
        { name: 'status',  type: 'file',      size: 256 },
        { name: 'stat',    type: 'file',      size: 128 },
        { name: 'cmdline', type: 'file',      size: 64  },
        { name: 'environ', type: 'file',      size: 128 },
        { name: 'maps',    type: 'file',      size: 128 },
        { name: 'fd',      type: 'directory', size: 0   },
      ];
    }

    if (rel === 'self') {
      var cur = scheduler.getCurrentProcess();
      return cur ? this.list('/proc/' + cur.pid) : [];
    }

    return [];
  }

  /**
   * Check whether a /proc path exists (file or directory).
   */
  exists(path: string): boolean {
    var rel = path.replace(/^\/proc\/?/, '');
    if (!rel) return true;
    return this.readRel(rel) !== null || this.list(path).length > 0;
  }

  /**
   * Returns true if the /proc path is a directory.
   */
  isDirectory(path: string): boolean {
    var rel = path.replace(/^\/proc\/?/, '');
    if (!rel) return true;
    if (rel === 'net' || rel === 'self') return true;
    if (/^\d+$/.test(rel) && scheduler.getProcess(parseInt(rel))) return true;
    return false;
  }

  // ── Content generators ───────────────────────────────────────────────────

  private readRel(rel: string): string | null {
    switch (rel) {
      case '':            return null; // root is a directory, not a file
      case 'version':     return this.version();
      case 'uptime':      return this.uptime();
      case 'meminfo':     return this.meminfo();
      case 'cpuinfo':     return this.cpuinfo();
      case 'loadavg':     return this.loadavg();
      case 'stat':        return this.statFile();
      case 'schedstat':   return this.schedstat();
      case 'mounts':      return this.mounts();
      case 'filesystems': return this.filesystems();
      case 'net/dev':     return this.netDev();
      case 'net/route':   return this.netRoute();
      case 'net/tcp':     return this.netTcp();
      case 'net/if_inet6': return '';
    }

    // /proc/self → redirect to current process
    if (rel === 'self' || rel.indexOf('self/') === 0) {
      var cur = scheduler.getCurrentProcess();
      if (!cur) return null;
      var subpath = rel === 'self' ? '' : rel.slice(5);
      return this.readRel('' + cur.pid + (subpath ? '/' + subpath : ''));
    }

    // /proc/<pid>[/<entry>]
    var pidFile = rel.match(/^(\d+)(?:\/(.+))?$/);
    if (pidFile) {
      return this.processEntry(parseInt(pidFile[1]), pidFile[2] || 'status');
    }

    return null;
  }

  private version(): string {
    return 'JSOS 1.0.0 (i686) QuickJS ES2023 #1 ' + new Date().toUTCString() + '\n';
  }

  private uptime(): string {
    var ms  = kernel.getUptime();
    var sec = ms / 1000;
    var idle = sec * 0.90; // approximation
    return sec.toFixed(2) + ' ' + idle.toFixed(2) + '\n';
  }

  private meminfo(): string {
    var m  = kernel.getMemoryInfo();
    var vm = vmm.getMemoryStats();
    function kb(b: number) { return Math.floor(b / 1024); }
    return [
      'MemTotal:       ' + kb(m.total)          + ' kB',
      'MemFree:        ' + kb(m.free)            + ' kB',
      'MemAvailable:   ' + kb(m.free)            + ' kB',
      'Buffers:        0 kB',
      'Cached:         0 kB',
      'SwapCached:     0 kB',
      'Active:         ' + kb(m.used)            + ' kB',
      'Inactive:       0 kB',
      'SwapTotal:      0 kB',
      'SwapFree:       0 kB',
      'VmallocTotal:   ' + vm.totalPhysical      + ' kB',
      'VmallocUsed:    ' + vm.usedPhysical       + ' kB',
      'VmallocChunk:   ' + vm.freePhysical       + ' kB',
      'PageTables:     ' + vm.mappedPages * 4    + ' kB',
    ].join('\n') + '\n';
  }

  private cpuinfo(): string {
    return [
      'processor\t: 0',
      'vendor_id\t: JSOS',
      'cpu family\t: 6',
      'model\t\t: 6',
      'model name\t: JSOS i686 QuickJS CPU @ bare metal',
      'stepping\t: 1',
      'cpu MHz\t\t: 100.000',
      'cache size\t: 256 KB',
      'bogomips\t: 200.00',
      'fpu\t\t: yes',
      'flags\t\t: fpu de pse tsc msr pae mce cx8',
      '',
    ].join('\n');
  }

  private loadavg(): string {
    var procs   = scheduler.getAllProcesses();
    var running = procs.filter(function(p) { return p.state === 'running'; }).length;
    var last    = procs.length > 0 ? procs[procs.length - 1].pid : 0;
    return '0.00 0.00 0.00 ' + running + '/' + procs.length + ' ' + last + '\n';
  }

  private statFile(): string {
    var ticks = kernel.getTicks();
    var procs = scheduler.getAllProcesses();
    var run   = procs.filter(function(p) { return p.state === 'running'; }).length;
    var blk   = procs.filter(function(p) { return p.state === 'blocked'; }).length;
    return [
      'cpu  0 0 ' + ticks + ' 0 0 0 0 0 0 0',
      'cpu0 0 0 ' + ticks + ' 0 0 0 0 0 0 0',
      'intr 0',
      'ctxt 0',
      'btime 0',
      'processes ' + procs.length,
      'procs_running ' + run,
      'procs_blocked ' + blk,
    ].join('\n') + '\n';
  }

  private schedstat(): string {
    return 'version 14\ntimestamp ' + kernel.getTicks() + '\ncpu0 0 0 0 0 0 0 0 0 0\n';
  }

  private mounts(): string {
    return [
      'jsos / jsos rw,relatime 0 0',
      'proc /proc proc ro,nosuid,nodev,noexec,relatime 0 0',
      'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
      'devfs /dev devfs rw,relatime 0 0',
    ].join('\n') + '\n';
  }

  private filesystems(): string {
    return 'nodev\tproc\n\tjsos\n\ttmpfs\nnodev\tdevfs\n';
  }

  private netDev(): string {
    return (
      'Inter-|   Receive                                                |  Transmit\n' +
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
      '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n' +
      '  eth0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0\n'
    );
  }

  private netRoute(): string {
    return (
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n' +
      'eth0\t00000000\t0202000A\t0003\t0\t0\t100\t00FFFFFF\t0\t0\t0\n' +
      'eth0\t0F00000A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n'
    );
  }

  private netTcp(): string {
    return (
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    );
  }

  private processEntry(pid: number, entry: string): string | null {
    var proc = scheduler.getProcess(pid);
    if (!proc) return null;

    function hex8(n: number) {
      var s = n.toString(16);
      while (s.length < 8) s = '0' + s;
      return s;
    }

    switch (entry) {
      case 'status':
        return [
          'Name:\t'     + proc.name,
          'State:\t'    + proc.state,
          'Pid:\t'      + proc.pid,
          'PPid:\t'     + proc.ppid,
          'Threads:\t1',
          'Priority:\t' + proc.priority,
          'VmRSS:\t'    + Math.floor((proc.memory.heapEnd - proc.memory.heapStart) / 1024) + ' kB',
          'VmStk:\t'    + Math.floor((proc.memory.stackEnd - proc.memory.stackStart) / 1024) + ' kB',
          'FDSize:\t'   + proc.openFiles.size,
        ].join('\n') + '\n';

      case 'stat':
        return (proc.pid + ' (' + proc.name + ') ' +
          proc.state[0].toUpperCase() + ' ' + proc.ppid +
          ' 0 0 0 0 0 0 0 0 0 ' + proc.cpuTime + ' 0 -' +
          proc.priority + ' ' + proc.priority + '\n');

      case 'cmdline':
        return proc.name + '\0';

      case 'environ':
        return 'HOME=/home/user\0PATH=/bin:/usr/bin\0TERM=vga\0LANG=C\0USER=user\0\0';

      case 'maps':
        return (
          hex8(proc.memory.heapStart)  + '-' + hex8(proc.memory.heapEnd)  + ' rw-p 00000000 00:00 0   [heap]\n' +
          hex8(proc.memory.stackStart) + '-' + hex8(proc.memory.stackEnd) + ' rw-p 00000000 00:00 0   [stack]\n'
        );

      case 'fd':
        return null; // fd is a directory; list() handles it

      default:
        return null;
    }
  }
}

export const procFS = new ProcFS();
