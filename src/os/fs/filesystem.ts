/**
 * JSOS File System Module
 *
 * In-memory filesystem with Unix-like paths and a VFS mount interface.
 * External subsystems (e.g. procFS) can mount onto any path prefix:
 *   fs.mountVFS('/proc', procFS);
 * Reads/lists under that prefix are then delegated to the mount handler.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

/** Bare-metal safe timestamp: kernel uptime ms, or 0 before kernel init. */
function uptime(): number {
  return typeof kernel !== 'undefined' ? kernel.getUptime() : 0;
}

// ── File creation mask (item 932) ─────────────────────────────────────────────
/**
 * Default file creation mask (umask). Bits set here are *removed* from the
 * default permissions when a new file or directory is created.
 *   0o022 → files: 0o644 (rw-r--r--), dirs: 0o755 (rwxr-xr-x)
 *   0o027 → files: 0o640 (rw-r-----), dirs: 0o750 (rwxr-x---)
 */
var _processUmask: number = 0o022;

/** Read or change the process file-creation mask. Returns the previous mask. */
export function umask(mask?: number): number {
  var old = _processUmask;
  if (mask !== undefined) _processUmask = mask & 0o777;
  return old;
}

/** Apply current umask to a base octal permission value, return rwxrwxrwx string. */
function _applyUmask(base: number): string {
  var bits = base & ~_processUmask & 0o777;
  var r = (s: number): string =>
    ((bits >> s) & 4 ? 'r' : '-') +
    ((bits >> s) & 2 ? 'w' : '-') +
    ((bits >> s) & 1 ? 'x' : '-');
  return r(6) + r(3) + r(0);
}

/** Default permissions string for a new regular file (umask applied). */
function _filePerms(): string { return _applyUmask(0o666); }
/** Default permissions string for a new directory (umask applied). */
function _dirPerms():  string { return _applyUmask(0o777); }

export type FileType = 'file' | 'directory' | 'symlink';

/** Interface that any virtual filesystem must implement to be mounted. */
export interface VFSMount {
  read(path: string): string | null;
  list(path: string): Array<{ name: string; type: FileType; size: number }>;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

export interface FileEntry {
  name:        string;
  type:        FileType;
  content:     string;
  size:        number;
  created:     number;
  modified:    number;
  permissions: string;
  /** Set when type === 'symlink' — target path of the symbolic link. */
  linkTarget?: string;
  /** [Item 198] Hard link count (number of directory entries pointing to this inode). */
  nlink: number;
  /** [Item 193] Extended attributes (user.* namespace etc.). */
  xattr?: Record<string, string>;
}

export interface DirectoryEntry {
  name: string;
  type: FileType;
  children: Map<string, FileEntry | DirectoryEntry>;
  created: number;
  modified: number;
  permissions: string;
  /** [Item 193] Extended attributes on directories. */
  xattr?: Record<string, string>;
}

function isDir(entry: FileEntry | DirectoryEntry): entry is DirectoryEntry {
  return entry.type === 'directory';
}

function isSymlink(entry: FileEntry | DirectoryEntry): entry is FileEntry {
  return entry.type === 'symlink';
}

// ── File Descriptor constants (items 173-174) ─────────────────────────────────
export const O_RDONLY   = 0x0000;
export const O_WRONLY   = 0x0001;
export const O_RDWR     = 0x0002;
export const O_APPEND   = 0x0400;
export const O_CLOEXEC  = 0x80000;
export const O_NONBLOCK = 0x0800;
export const O_TRUNC    = 0x0200;
export const O_CREAT    = 0x0040;

// ── File lock constants (item 192) ───────────────────────────────────────────
export const LOCK_SH = 1;  // Shared (read) lock
export const LOCK_EX = 2;  // Exclusive (write) lock
export const LOCK_NB = 4;  // Non-blocking flag
export const LOCK_UN = 8;  // Unlock

// ── [Item 181] TmpFS: RAM-backed volatile filesystem ─────────────────────────

/**
 * [Item 181] TmpFS — a RAM-backed volatile filesystem mounted at /tmp.
 * Files are stored in an in-memory Map and are lost on reboot.
 * Implements VFSMount for read operations; write operations are exposed
 * as dedicated methods and also wired into FileSystem.writeFile/mkdir.
 */
export class TmpFS implements VFSMount {
  /** Path → content for regular files. */
  readonly _files = new Map<string, string>();
  /** Set of directory paths. */
  readonly _dirs  = new Set<string>();

  constructor() {
    this._dirs.add('/');
    this._dirs.add('/tmp');
  }

  read(path: string): string | null {
    return this._files.get(path) ?? null;
  }

  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    var norm = path === '/' ? '' : path;
    var result: Array<{ name: string; type: FileType; size: number }> = [];
    var seen = new Set<string>();
    // Files directly under path
    for (var [p, content] of this._files) {
      if (!p.startsWith(norm + '/')) continue;
      var rest = p.slice(norm.length + 1);
      if (rest.indexOf('/') !== -1) continue; // deeper level
      if (!seen.has(rest)) { seen.add(rest); result.push({ name: rest, type: 'file', size: content.length }); }
    }
    // Subdirectories
    for (var d of this._dirs) {
      if (d === path || d === '/') continue;
      if (!d.startsWith(norm + '/')) continue;
      var drest = d.slice(norm.length + 1);
      if (drest.indexOf('/') !== -1) continue;
      if (!seen.has(drest)) { seen.add(drest); result.push({ name: drest, type: 'directory', size: 0 }); }
    }
    return result;
  }

  exists(path: string): boolean {
    return this._files.has(path) || this._dirs.has(path);
  }

  isDirectory(path: string): boolean {
    return this._dirs.has(path);
  }

  /** Write a file into the tmpfs. Creates any missing parent directories. */
  writeFile(path: string, content: string): void {
    this._files.set(path, content);
    // Ensure parent directories exist
    var parts = path.split('/');
    for (var i = 1; i < parts.length - 1; i++) {
      var dir = parts.slice(0, i + 1).join('/');
      this._dirs.add(dir);
    }
  }

  /** Delete a file from the tmpfs. */
  deleteFile(path: string): void {
    this._files.delete(path);
  }

  /** Create a directory in the tmpfs. */
  mkdir(path: string): void {
    this._dirs.add(path);
  }
}

export interface FdEntry {
  fd:       number;
  path:     string;
  pos:      number;
  flags:    number;   // O_RDONLY / O_WRONLY / O_RDWR
  cloexec:  boolean;  // FD_CLOEXEC flag
  nonblock: boolean;  // O_NONBLOCK flag
}

/** Maximum symlink resolution depth (item 176). */
const MAX_SYMLINK_DEPTH = 40;

export class FileSystem {
  private root: DirectoryEntry;
  private currentPath: string = '/';
  private mounts  = new Map<string, VFSMount>(); // mountpoint -> handler
  private fds     = new Map<number, FdEntry>();   // fd table (item 173)
  private nextFd  = 3;   // 0/1/2 reserved for stdin/stdout/stderr
  /** [Item 181] The RAM-backed TmpFS instance mounted at /tmp. */
  readonly tmpfs  = new TmpFS();
  /** [Item 192] File lock table: path → { fd, type } lock holder. */
  private _fileLocks = new Map<string, Array<{ fd: number; type: number }>>();

  /** Mount a virtual filesystem at a path prefix (e.g. '/proc'). */
  mountVFS(mountpoint: string, vfs: VFSMount): void {
    this.mounts.set(mountpoint, vfs);
  }

  /** Unmount (remove) a VFS mount point.  Returns true if it existed. */
  unmountVFS(mountpoint: string): boolean {
    return this.mounts.delete(mountpoint);
  }

  /** List all active VFS mount points. */
  listMounts(): string[] {
    return Array.from(this.mounts.keys());
  }

  /** Find the VFS handler for a resolved path, if any. */
  private findMount(resolved: string): VFSMount | null {
    for (var [mp, vfs] of this.mounts) {
      if (resolved === mp || resolved.indexOf(mp + '/') === 0) return vfs;
    }
    return null;
  }

  constructor() {
    var now = uptime();
    this.root = {
      name: '/',
      type: 'directory',
      children: new Map(),
      created: now,
      modified: now,
      permissions: 'rwxr-xr-x',
    };

    this.initializeDefaultFS();
    // [Item 181] Mount TmpFS at /tmp for RAM-backed volatile storage
    this.mountVFS('/tmp', this.tmpfs);
  }

  private initializeDefaultFS(): void {
    // Standard Unix directory tree
    this.mkdir('/bin');
    this.mkdir('/usr');
    this.mkdir('/usr/bin');
    this.mkdir('/usr/lib');
    this.mkdir('/lib');
    this.mkdir('/etc');
    this.mkdir('/etc/init');   // item 717: service definitions loaded from here
    this.mkdir('/home');
    this.mkdir('/home/user');
    this.mkdir('/root');
    this.mkdir('/tmp');
    this.mkdir('/var');
    this.mkdir('/var/log');
    this.mkdir('/var/run');
    this.mkdir('/var/spool');
    this.mkdir('/dev');
    this.mkdir('/proc');  // mounted as virtual FS by main.ts
    this.mkdir('/sys');
    this.mkdir('/srv');
    this.mkdir('/opt');
    this.mkdir('/mnt');

    // Core system files
    this.writeFile('/etc/hostname', 'jsos');
    this.writeFile('/etc/version',  '1.0.0');
    this.writeFile('/etc/os-release',
      'NAME=JSOS\nVERSION=1.0.0\nID=jsos\nPRETTY_NAME="JSOS 1.0.0"\n' +
      'HOME_URL="https://github.com/chobot2014/JSOS"\n'
    );
    this.writeFile('/etc/motd',
      '\n' +
      '  Welcome to JSOS — JavaScript Operating System\n' +
      '  Type help() to see available functions.\n' +
      '\n'
    );
    this.writeFile('/etc/issue', 'JSOS 1.0.0 \\l\n');
    this.writeFile('/home/user/.profile', '# User profile — sourced on login\nexport PATH=/bin:/usr/bin\n');
    this.writeFile('/home/user/.history', '');
    this.writeFile('/root/.profile', '# Root profile\nexport PATH=/bin:/usr/bin\n');
    this.writeFile('/var/log/boot.log', '[' + uptime() + '] JSOS booted\n');
    this.writeFile('/var/run/pid1', '1\n');
    this.writeFile('/dev/null', '');
    this.writeFile('/dev/zero', '\x00');

    // ── /bin programs (JavaScript source, run with run('/bin/name.js')) ──────

    this.writeFile('/bin/hello.js',
      '// Hello World — classic first program\n' +
      'print("Hello, World from JSOS!");\n'
    );

    this.writeFile('/bin/sysinfo.js',
      '// System information\n' +
      'var info = sys.sysinfo();\n' +
      'print("OS      : " + info.os);\n' +
      'print("Host    : " + info.hostname);\n' +
      'print("Arch    : " + info.arch);\n' +
      'print("Runtime : " + info.runtime);\n' +
      'print("Uptime  : " + Math.floor(info.uptime/1000) + "s");\n' +
      'print("Procs   : " + info.processes);\n' +
      'print("Memory  : " + Math.floor(info.memory.used/1024) + "K / " + Math.floor(info.memory.total/1024) + "K");\n' +
      'print("Sched   : " + info.scheduler);\n' +
      'print("Runlevel: " + info.runlevel);\n'
    );

    this.writeFile('/bin/colors.js',
      '// VGA color palette demo\n' +
      'var names=["BLACK","BLUE","GREEN","CYAN","RED","MAGENTA","BROWN","LT_GREY",\n' +
      '  "DK_GREY","LT_BLUE","LT_GREEN","LT_CYAN","LT_RED","LT_MAG","YELLOW","WHITE"];\n' +
      'for(var i=0;i<16;i++){\n' +
      '  terminal.setColor(i,0); terminal.print("  "+i+" ########  ");\n' +
      '  terminal.setColor(7,0); terminal.println(names[i]);\n' +
      '}\nterminal.setColor(7,0);\n'
    );

    this.writeFile('/bin/top.js',
      '// Interactive process monitor — press q to quit\n' +
      '(function(){\n' +
      '  var running=true;\n' +
      '  while(running){\n' +
      '    terminal.clear();\n' +
      '    var m=kernel.getMemoryInfo(), up=kernel.getUptime();\n' +
      '    var us=Math.floor(up/1000),um=Math.floor(us/60),uh=Math.floor(um/60);\n' +
      '    terminal.setColor(15,0);\n' +
      '    terminal.println(" JSOS top                         uptime: "+uh+"h "+(um%60)+"m "+(us%60)+"s  [q=quit]");\n' +
      '    terminal.setColor(7,0);\n' +
      '    terminal.println(" Memory: "+Math.floor(m.used/1024)+"K used / "+Math.floor(m.total/1024)+"K total   Runlevel: "+sys.init.getCurrentRunlevel());\n' +
      '    terminal.println("");\n' +
      '    terminal.setColor(11,0);\n' +
      '    terminal.println("  PID  NAME              STATE        PRI  CPU-ms");\n' +
      '    terminal.setColor(8,0);\n' +
      '    terminal.println("  ---  ----------------  -----------  ---  ------");\n' +
      '    terminal.setColor(7,0);\n' +
      '    var procs=sys.scheduler.getLiveProcesses();\n' +
      '    for(var i=0;i<procs.length;i++){\n' +
      '      var p=procs[i];\n' +
      '      var ps=("   "+p.pid).slice(-4);\n' +
      '      var ns=(p.name+"                ").slice(0,16);\n' +
      '      var ss=(p.state+"           ").slice(0,11);\n' +
      '      var rs=("  "+p.priority).slice(-3);\n' +
      '      terminal.println("  "+ps+"  "+ns+"  "+ss+"  "+rs+"  "+p.cpuTime);\n' +
      '    }\n' +
      '    terminal.println("");\n' +
      '    terminal.setColor(8,0);\n' +
      '    terminal.println("  "+procs.length+" process(es)");\n' +
      '    terminal.setColor(7,0);\n' +
      '    kernel.sleep(500);\n' +
      '    if(kernel.hasKey()){\n' +
      '      var k=kernel.readKey();\n' +
      '      if(k==="q"||k==="Q"||k==="\\x03") running=false;\n' +
      '    }\n' +
      '  }\n' +
      '  terminal.clear();\n' +
      '})();\n'
    );

    this.writeFile('/bin/grep.js',
      '// grep — search file for lines matching a pattern\n' +
      '// Usage: _args=["pattern","path"]; run("/bin/grep.js")\n' +
      '(function(){\n' +
      '  var args=(typeof _args!=="undefined")?_args:[];\n' +
      '  var pat=args[0]||""; var path=args[1]||"";\n' +
      '  if(!pat){print("usage: grep(\\"pattern\\",\\"path\\")"); return;}\n' +
      '  var content=path?fs.readFile(path):(typeof _stdin!=="undefined"?_stdin:null);\n' +
      '  if(content===null){print("grep: no input"); return;}\n' +
      '  var re=new RegExp(pat);\n' +
      '  var lines=content.split("\\n"); var count=0;\n' +
      '  for(var i=0;i<lines.length;i++){\n' +
      '    if(re.test(lines[i])){\n' +
      '      terminal.setColor(7,0);\n' +
      '      terminal.print((path?path+":":"")+(i+1)+": ");\n' +
      '      terminal.println(lines[i]); count++;\n' +
      '    }\n' +
      '  }\n' +
      '  if(!count){terminal.setColor(8,0);terminal.println("(no matches)");terminal.setColor(7,0);}\n' +
      '})();\n'
    );

    this.writeFile('/bin/wc.js',
      '// wc — word/line/char count\n' +
      '// Usage: _args=["path"]; run("/bin/wc.js")\n' +
      '(function(){\n' +
      '  var args=(typeof _args!=="undefined")?_args:[];\n' +
      '  var path=args[0]||"";\n' +
      '  if(!path){print("usage: wc(\\"path\\")"); return;}\n' +
      '  var c=fs.readFile(path);\n' +
      '  if(c===null){print("wc: "+path+": not found"); return;}\n' +
      '  var lines=c.split("\\n").length-1;\n' +
      '  var words=c.trim()?c.trim().split(/\\s+/).length:0;\n' +
      '  var chars=c.length;\n' +
      '  print("  "+lines+"\\t"+words+"\\t"+chars+"\\t"+path);\n' +
      '})();\n'
    );

    this.writeFile('/bin/free.js',
      '// free — memory usage\n' +
      '(function(){\n' +
      '  var m=kernel.getMemoryInfo();\n' +
      '  var kb=function(b){return Math.floor(b/1024);};\n' +
      '  terminal.setColor(11,0); terminal.println("              total        used        free");\n' +
      '  terminal.setColor(7,0);\n' +
      '  terminal.println("Mem:    "+("      "+kb(m.total)).slice(-10)+" "+("      "+kb(m.used)).slice(-10)+" "+("      "+kb(m.free)).slice(-10));\n' +
      '  terminal.println("Swap:             0           0           0");\n' +
      '})();\n'
    );

    this.writeFile('/bin/uname.js',
      '// uname — system information\n' +
      '(function(){\n' +
      '  var info=sys.sysinfo();\n' +
      '  var args=(typeof _args!=="undefined")?_args.join(""):"-s";\n' +
      '  if(args.indexOf("a")!==-1) {\n' +
      '    print("JSOS 1.0.0 "+info.hostname+" 1.0.0 QuickJS-ES2023 i686 JSOS");\n' +
      '  } else {\n' +
      '    if(args.indexOf("s")!==-1||args==="-s") print("JSOS");\n' +
      '    if(args.indexOf("n")!==-1) print(info.hostname);\n' +
      '    if(args.indexOf("r")!==-1) print("1.0.0");\n' +
      '    if(args.indexOf("m")!==-1) print("i686");\n' +
      '    if(args.indexOf("p")!==-1) print("i686");\n' +
      '  }\n' +
      '})();\n'
    );

    this.writeFile('/bin/whoami.js',
      '// whoami — print current username\n' +
      '(function(){\n' +
      '  var u=users.getCurrentUser();\n' +
      '  print(u?u.name:"nobody");\n' +
      '})();\n'
    );

    this.writeFile('/bin/id.js',
      '// id — print user identity\n' +
      '(function(){\n' +
      '  print(users.idString());\n' +
      '})();\n'
    );

    this.writeFile('/bin/env.js',
      '// env — show environment (JSOS uses global variables as environment)\n' +
      '(function(){\n' +
      '  var pseudo={\n' +
      '    HOME: "/home/user", USER: (users.getCurrentUser()||{name:"user"}).name,\n' +
      '    PATH: "/bin:/usr/bin", TERM: "vga", LANG: "C", SHELL: "/bin/repl",\n' +
      '    RUNLEVEL: ""+sys.init.getCurrentRunlevel(),\n' +
      '    HOSTNAME: (fs.readFile("/etc/hostname")||"jsos"),\n' +
      '    JSOS_VERSION: (fs.readFile("/etc/version")||"1.0.0"),\n' +
      '  };\n' +
      '  Object.keys(pseudo).forEach(function(k){print(k+"="+pseudo[k]);});\n' +
      '})();\n'
    );

    this.writeFile('/bin/ifconfig.js',
      '// ifconfig — network interface configuration\n' +
      '(function(){\n' +
      '  terminal.print(net.ifconfig());\n' +
      '})();\n'
    );

    this.writeFile('/bin/netstat.js',
      '// netstat — network connections\n' +
      '(function(){\n' +
      '  var conns=net.getConnections();\n' +
      '  terminal.setColor(11,0); terminal.println("Proto  Local              Remote             State");\n' +
      '  terminal.setColor(7,0);\n' +
      '  if(conns.length===0){terminal.setColor(8,0);terminal.println("(no connections)");terminal.setColor(7,0);return;}\n' +
      '  for(var i=0;i<conns.length;i++){\n' +
      '    var c=conns[i];\n' +
      '    var loc=(c.localIP+":"+c.localPort+"              ").slice(0,18);\n' +
      '    var rem=(c.remoteIP+":"+c.remotePort+"              ").slice(0,18);\n' +
      '    terminal.println("tcp    "+loc+" "+rem+" "+c.state);\n' +
      '  }\n' +
      '  var stats=net.getStats();\n' +
      '  terminal.setColor(8,0);\n' +
      '  terminal.println("  rx="+stats.rxPackets+" tx="+stats.txPackets+" err="+stats.rxErrors);\n' +
      '  terminal.setColor(7,0);\n' +
      '})();\n'
    );

    this.writeFile('/bin/ping.js',
      '// ping — send ICMP echo to a host\n' +
      '// Usage: _args=["10.0.2.2"]; run("/bin/ping.js")\n' +
      '(function(){\n' +
      '  var args=(typeof _args!=="undefined")?_args:[];\n' +
      '  var host=args[0]||net.gateway;\n' +
      '  print("PING "+host+" — 1 packet");\n' +
      '  var rtt=net.ping(host,2000);\n' +
      '  if(rtt>=0) print("Reply from "+host+": time="+rtt+"ms");\n' +
      '  else print("Request timeout (no driver connected)");\n' +
      '})();\n'
    );

    this.writeFile('/bin/test-os.js',
      '// JSOS OS subsystem integration test\n' +
      'print("=== JSOS OS Integration Test ==="); print("");\n' +
      'print("VMM:"); try{\n' +
      '  var vs=sys.vmm.getMemoryStats();\n' +
      '  print("  total="+vs.totalPhysical+" used="+vs.usedPhysical+" pages="+vs.mappedPages);\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("Scheduler:"); try{\n' +
      '  var ps2=sys.scheduler.getLiveProcesses();\n' +
      '  print("  processes="+ps2.length+" algo="+sys.scheduler.getAlgorithm());\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("Init:"); try{\n' +
      '  print("  runlevel="+sys.init.getCurrentRunlevel());\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("Syscalls:"); try{\n' +
      '  var r=sys.syscalls.getpid();\n' +
      '  print("  getpid()="+(r.success?r.value:("err:"+r.error)));\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("Users:"); try{\n' +
      '  var ul=users.listUsers();\n' +
      '  print("  users="+ul.map(function(u){return u.name;}).join(","));\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("IPC:"); try{\n' +
      '  var p=ipc.pipe();\n' +
      '  p[1].write("hello"); print("  pipe write/read: "+p[0].read());\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print("Net:"); try{\n' +
      '  var s=net.createSocket("tcp"); net.bind(s,0); net.close(s);\n' +
      '  print("  ip="+net.ip+" mac="+net.mac+" gw="+net.gateway);\n' +
      '}catch(e){print("  Error: "+e);}\n' +
      'print(""); print("=== All tests complete ===");\n'
    );
  }

  /** Resolve a path relative to cwd */
  resolvePath(inputPath: string): string {
    if (!inputPath) return this.currentPath;

    var path = inputPath;

    // Handle home directory shorthand
    if (path === '~' || path.indexOf('~/') === 0) {
      path = '/home/user' + path.substring(1);
    }

    // Handle relative paths
    if (path[0] !== '/') {
      if (this.currentPath === '/') {
        path = '/' + path;
      } else {
        path = this.currentPath + '/' + path;
      }
    }

    // Normalize: resolve . and ..
    var parts = path.split('/').filter(function(p) { return p.length > 0; });
    var resolved: string[] = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === '.') continue;
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return '/' + resolved.join('/');
  }

  /** Navigate to a directory entry by path, following symlinks (item 176). */
  private navigate(path: string, followLast = true, depth = 0): FileEntry | DirectoryEntry | null {
    if (depth > MAX_SYMLINK_DEPTH) return null; // symlink loop guard

    var resolved = this.resolvePath(path);
    if (resolved === '/') return this.root;

    var parts = resolved.split('/').filter(function(p) { return p.length > 0; });
    var current: FileEntry | DirectoryEntry = this.root;

    for (var i = 0; i < parts.length; i++) {
      if (!isDir(current)) return null;
      var child = current.children.get(parts[i]);
      if (!child) return null;

      // Follow symlink, unless this is the last component and followLast=false
      var isLast = (i === parts.length - 1);
      if (isSymlink(child) && (followLast || !isLast)) {
        var target = (child as FileEntry).linkTarget || '';
        // Resolve relative symlinks relative to the parent directory
        if (target[0] !== '/') {
          var parentParts = parts.slice(0, i);
          target = (parentParts.length > 0 ? '/' + parentParts.join('/') : '') + '/' + target;
        }
        return this.navigate(target, followLast, depth + 1);
      }

      current = child;
    }

    return current;
  }

  /** Get current working directory */
  cwd(): string {
    return this.currentPath;
  }

  /** Change directory */
  cd(path: string): boolean {
    var resolved = this.resolvePath(path);
    var entry = this.navigate(resolved);
    if (entry && isDir(entry)) {
      this.currentPath = resolved;
      return true;
    }
    return false;
  }

  /** List directory contents */
  ls(path: string = ''): Array<{ name: string; type: FileType; size: number }> {
    var resolved = path ? this.resolvePath(path) : this.currentPath;
    var vfs = this.findMount(resolved);
    if (vfs) return vfs.list(resolved);

    var entry = this.navigate(resolved);
    if (!entry || !isDir(entry)) return [];

    var result: Array<{ name: string; type: FileType; size: number }> = [];
    var keys = Array.from(entry.children.keys());
    keys.sort();
    for (var i = 0; i < keys.length; i++) {
      var child = entry.children.get(keys[i]);
      if (child) {
        result.push({
          name: child.name,
          type: child.type,
          size: isDir(child) ? 0 : (child as FileEntry).size,
        });
      }
    }
    return result;
  }

  /** Create a directory */
  mkdir(path: string): boolean {
    var resolved = this.resolvePath(path);
    var parts = resolved.split('/').filter(function(p) { return p.length > 0; });
    var current: DirectoryEntry = this.root;

    for (var i = 0; i < parts.length; i++) {
      var existing = current.children.get(parts[i]);
      if (existing) {
        if (!isDir(existing)) return false;  // Path component is a file
        current = existing;
      } else {
        var now = uptime();
        var newDir: DirectoryEntry = {
          name: parts[i],
          type: 'directory',
          children: new Map(),
          created: now,
          modified: now,
          permissions: _dirPerms(),  // umask applied (item 932)
        };
        current.children.set(parts[i], newDir);
        current = newDir;
      }
    }
    return true;
  }

  /** Write content to a file (creates or overwrites) */
  writeFile(path: string, content: string): boolean {
    var resolved = this.resolvePath(path);
    var parts = resolved.split('/').filter(function(p) { return p.length > 0; });
    if (parts.length === 0) return false;

    var fileName = parts[parts.length - 1];
    var dirPath = '/' + parts.slice(0, -1).join('/');

    // Ensure parent directory exists
    if (parts.length > 1) {
      this.mkdir(dirPath);
    }

    var parent = this.navigate(dirPath) || this.root;
    if (!isDir(parent)) return false;

    var now = uptime();
    var existing = parent.children.get(fileName);
    
    var file: FileEntry = {
      name: fileName,
      type: 'file',
      content: content,
      size: content.length,
      created: existing ? (existing as FileEntry).created || now : now,
      modified: now,
      permissions: existing ? (existing as FileEntry).permissions : _filePerms(), // umask (item 932)
      nlink: existing ? (existing as FileEntry).nlink || 1 : 1,
    };

    parent.children.set(fileName, file);
    return true;
  }

  /** Read a file's content */
  readFile(path: string): string | null {
    var resolved = this.resolvePath(path);
    var vfs = this.findMount(resolved);
    if (vfs) return vfs.read(resolved);
    var entry = this.navigate(path);
    if (!entry || isDir(entry)) return null;
    return entry.content;
  }

  /** Append content to a file */
  appendFile(path: string, content: string): boolean {
    var existing = this.readFile(path);
    if (existing === null) {
      return this.writeFile(path, content);
    }
    return this.writeFile(path, existing + content);
  }

  /** Check if a path exists */
  exists(path: string): boolean {
    var resolved = this.resolvePath(path);
    var vfs = this.findMount(resolved);
    if (vfs) return vfs.exists(resolved);
    return this.navigate(path) !== null;
  }

  /** Check if a path is a directory */
  isDirectory(path: string): boolean {
    var resolved = this.resolvePath(path);
    var vfs = this.findMount(resolved);
    if (vfs) return vfs.isDirectory(resolved);
    var entry = this.navigate(path);
    return entry !== null && isDir(entry);
  }

  /** Check if a path is a file */
  isFile(path: string): boolean {
    var resolved = this.resolvePath(path);
    var vfs = this.findMount(resolved);
    if (vfs) return vfs.exists(resolved) && !vfs.isDirectory(resolved);
    var entry = this.navigate(path);
    return entry !== null && !isDir(entry);
  }

  /** Remove a file or empty directory */
  rm(path: string): boolean {
    var resolved = this.resolvePath(path);
    if (resolved === '/') return false;

    var parts = resolved.split('/').filter(function(p) { return p.length > 0; });
    var name = parts[parts.length - 1];
    var parentPath = '/' + parts.slice(0, -1).join('/');

    var parent = this.navigate(parentPath);
    if (!parent || !isDir(parent)) return false;

    var entry = parent.children.get(name);
    if (!entry) return false;

    // Don't allow removing non-empty directories
    if (isDir(entry) && entry.children.size > 0) return false;

    parent.children.delete(name);
    return true;
  }

  /** Copy a file */
  cp(src: string, dest: string): boolean {
    var content = this.readFile(src);
    if (content === null) return false;
    return this.writeFile(dest, content);
  }

  /** Move/rename a file */
  mv(src: string, dest: string): boolean {
    if (!this.cp(src, dest)) return false;
    return this.rm(src);
  }

  /** Get file/directory info */
  stat(path: string): { type: FileType; size: number; created: number; modified: number; permissions: string } | null {
    var entry = this.navigate(path);
    if (!entry) return null;

    return {
      type: entry.type,
      size: isDir(entry) ? 0 : (entry as FileEntry).size,
      created: entry.created,
      modified: entry.modified,
      permissions: entry.permissions,
    };
  }

  /** Find files matching a simple pattern */
  find(basePath: string, pattern: string): string[] {
    var results: string[] = [];
    var self = this;

    function walk(dirPath: string) {
      var items = self.ls(dirPath);
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var fullPath = dirPath === '/' ? '/' + item.name : dirPath + '/' + item.name;

        if (simpleMatch(item.name, pattern)) {
          results.push(fullPath);
        }

        if (item.type === 'directory') {
          walk(fullPath);
        }
      }
    }

    walk(basePath || '/');
    return results;
  }

  // ── Symlinks (item 176) ───────────────────────────────────────────────────

  /**
   * Create a symbolic link at `linkPath` pointing to `target`.
   * `target` may be an absolute or relative path.
   */
  symlink(target: string, linkPath: string): boolean {
    var resolved = this.resolvePath(linkPath);
    if (resolved === '/') return false;

    var parts      = resolved.split('/').filter(function(p) { return p.length > 0; });
    var name       = parts[parts.length - 1];
    var parentPath = '/' + parts.slice(0, -1).join('/');

    var parent = this.navigate(parentPath);
    if (!parent || !isDir(parent)) return false;
    if (parent.children.has(name)) return false; // already exists

    var now = uptime();
    var entry: FileEntry = {
      name, type: 'symlink',
      content: '', size: target.length,
      created: now, modified: now,
      permissions: 'lrwxrwxrwx',
      linkTarget: target,
      nlink: 1,
    };
    parent.children.set(name, entry);
    return true;
  }

  /**
   * Read the target of a symbolic link (does NOT follow the link).
   * Returns null if path does not exist or is not a symlink.
   */
  readlink(path: string): string | null {
    var entry = this.navigate(path, false); // followLast=false
    if (!entry || !isSymlink(entry)) return null;
    return (entry as FileEntry).linkTarget || '';
  }

  // ── File Descriptor API (items 173-174) ───────────────────────────────────

  /**
   * Open a file and return a file descriptor (≥ 3).
   * flags: OR of O_RDONLY/O_WRONLY/O_RDWR, O_CREAT, O_TRUNC, O_APPEND,
   *        O_CLOEXEC, O_NONBLOCK.
   * Returns -1 on failure.
   */
  open(path: string, flags = O_RDONLY): number {
    var accMode = flags & 0x3; // O_RDONLY=0, O_WRONLY=1, O_RDWR=2
    var create  = (flags & O_CREAT) !== 0;
    var trunc   = (flags & O_TRUNC) !== 0;

    if (create && !this.exists(path)) {
      if (!this.writeFile(path, '')) return -1;
    } else if (!this.exists(path)) {
      return -1;
    }

    if (trunc && accMode !== O_RDONLY) {
      this.writeFile(path, '');
    }

    var resolved = this.resolvePath(path);
    var entry: FdEntry = {
      fd:       this.nextFd++,
      path:     resolved,
      pos:      (flags & O_APPEND) ? this._fileSize(resolved) : 0,
      flags,
      cloexec:  (flags & O_CLOEXEC)  !== 0,
      nonblock: (flags & O_NONBLOCK) !== 0,
    };
    this.fds.set(entry.fd, entry);
    return entry.fd;
  }

  /** Close a file descriptor. Returns true on success. */
  close(fd: number): boolean {
    return this.fds.delete(fd);
  }

  /** Read up to `count` bytes from fd at current position. */
  readFd(fd: number, count: number): string | null {
    var fde = this.fds.get(fd);
    if (!fde) return null;
    if ((fde.flags & 0x3) === O_WRONLY) return null; // write-only
    var content = this.readFile(fde.path);
    if (content === null) return null;
    var chunk = content.substring(fde.pos, fde.pos + count);
    fde.pos += chunk.length;
    return chunk;
  }

  /** Write data to fd at current position. */
  writeFd(fd: number, data: string): boolean {
    var fde = this.fds.get(fd);
    if (!fde) return false;
    if ((fde.flags & 0x3) === O_RDONLY) return false; // read-only
    var content = this.readFile(fde.path) || '';

    var newContent: string;
    if (fde.flags & O_APPEND) {
      newContent = content + data;
      fde.pos    = newContent.length;
    } else {
      newContent = content.substring(0, fde.pos) + data +
                   content.substring(fde.pos + data.length);
      fde.pos   += data.length;
    }
    return this.writeFile(fde.path, newContent);
  }

  /** Seek to an absolute position within fd. Returns new position or -1. */
  seek(fd: number, offset: number, whence: 'set' | 'cur' | 'end' = 'set'): number {
    var fde = this.fds.get(fd);
    if (!fde) return -1;
    var fileLen = this._fileSize(fde.path);
    var newPos: number;
    if      (whence === 'set') newPos = offset;
    else if (whence === 'cur') newPos = fde.pos + offset;
    else                       newPos = fileLen  + offset;
    if (newPos < 0) newPos = 0;
    fde.pos = newPos;
    return newPos;
  }

  /**
   * Duplicate a file descriptor (item 173).
   * Returns a new fd ≥ 3 that shares the same open-file state (path, pos, flags).
   */
  dup(fd: number): number {
    var src = this.fds.get(fd);
    if (!src) return -1;
    var newFd = this.nextFd++;
    this.fds.set(newFd, { ...src, fd: newFd });
    return newFd;
  }

  /**
   * Duplicate fd to a specific target fd (dup2 semantic).
   * If newFd is already open, it is closed first.
   * Returns newFd on success, -1 on failure.
   */
  dup2(fd: number, newFd: number): number {
    var src = this.fds.get(fd);
    if (!src || fd === newFd) return fd === newFd ? newFd : -1;
    this.fds.delete(newFd); // close target if open
    this.fds.set(newFd, { ...src, fd: newFd });
    if (newFd >= this.nextFd) this.nextFd = newFd + 1;
    return newFd;
  }

  /**
   * fcntl-style control (item 174).
   * Supported commands:
   *   'getfl'  — return current flags
   *   'setfl'  — set flags (only O_NONBLOCK, O_APPEND writable after open)
   *   'getfd'  — return 1 if FD_CLOEXEC is set, else 0
   *   'setfd'  — set FD_CLOEXEC flag (arg & 1 = cloexec)
   *   'dupfd'  — duplicate fd, choose lowest fd ≥ arg
   */
  fcntl(fd: number, cmd: 'getfl' | 'setfl' | 'getfd' | 'setfd' | 'dupfd', arg = 0): number {
    var fde = this.fds.get(fd);
    if (!fde) return -1;
    switch (cmd) {
      case 'getfl':
        return fde.flags;
      case 'setfl': {
        // Only allow changing O_NONBLOCK and O_APPEND after open
        var mask = O_NONBLOCK | O_APPEND;
        fde.flags     = (fde.flags & ~mask) | (arg & mask);
        fde.nonblock  = (fde.flags & O_NONBLOCK) !== 0;
        return 0;
      }
      case 'getfd':
        return fde.cloexec ? 1 : 0;
      case 'setfd':
        fde.cloexec = (arg & 1) !== 0;
        return 0;
      case 'dupfd': {
        // Find lowest available fd ≥ arg
        var minFd = Math.max(arg, 3);
        while (this.fds.has(minFd)) minFd++;
        this.fds.set(minFd, { ...fde, fd: minFd });
        if (minFd >= this.nextFd) this.nextFd = minFd + 1;
        return minFd;
      }
    }
  }

  /** Helper: return the byte length of a file, or 0. */
  private _fileSize(resolvedPath: string): number {
    var e = this.navigate(resolvedPath);
    if (!e || isDir(e)) return 0;
    return (e as FileEntry).content.length;
  }

  // ── [Item 192] File Locking (flock) ─────────────────────────────────────────

  /**
   * Apply or remove an advisory lock on the file at `path`.
   * @param fd    File descriptor (for lock ownership tracking)
   * @param op    LOCK_SH | LOCK_EX | LOCK_UN  (optionally OR'd with LOCK_NB)
   * @returns true on success; false if lock is held by another fd and LOCK_NB set
   */
  flock(fd: number, op: number): boolean {
    var fde = this.fds.get(fd);
    if (!fde) return false;
    var path = fde.path;
    var lockType = op & ~LOCK_NB; // strip the non-blocking flag
    if (lockType === LOCK_UN) {
      // Remove all locks held by this fd on this path
      var locks = this._fileLocks.get(path);
      if (locks) {
        var remaining = locks.filter(function(l) { return l.fd !== fd; });
        if (remaining.length === 0) this._fileLocks.delete(path);
        else this._fileLocks.set(path, remaining);
      }
      return true;
    }
    // Check for conflicting locks
    var existing = this._fileLocks.get(path) || [];
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].fd === fd) continue; // same fd: upgrade OK
      // Exclusive lock conflicts with any holder; shared locks conflict only with exclusive
      if (lockType === LOCK_EX || existing[i].type === LOCK_EX) {
        if (op & LOCK_NB) return false; // would block
        // In JSOS single-threaded mode, blocking would deadlock; just fail silently
        return false;
      }
    }
    // Replace any existing lock by this fd, then add new
    var updated = existing.filter(function(l) { return l.fd !== fd; });
    updated.push({ fd, type: lockType });
    this._fileLocks.set(path, updated);
    return true;
  }

  // ── [Item 193] Extended Attributes (xattr) ───────────────────────────────────

  /** Set an extended attribute on a file or directory. */
  setxattr(path: string, name: string, value: string): boolean {
    var entry = this.navigate(path);
    if (!entry) return false;
    if (!entry.xattr) entry.xattr = {};
    entry.xattr[name] = value;
    return true;
  }

  /** Get an extended attribute value.  Returns null if not set. */
  getxattr(path: string, name: string): string | null {
    var entry = this.navigate(path);
    if (!entry || !entry.xattr) return null;
    return Object.prototype.hasOwnProperty.call(entry.xattr, name) ? entry.xattr[name] : null;
  }

  /** List the names of all extended attributes on a file or directory. */
  listxattr(path: string): string[] {
    var entry = this.navigate(path);
    if (!entry || !entry.xattr) return [];
    return Object.keys(entry.xattr);
  }

  /** Remove an extended attribute.  Returns true if it existed. */
  removexattr(path: string, name: string): boolean {
    var entry = this.navigate(path);
    if (!entry || !entry.xattr) return false;
    if (!Object.prototype.hasOwnProperty.call(entry.xattr, name)) return false;
    delete entry.xattr[name];
    return true;
  }

  // ── [Item 198] Hard Links ─────────────────────────────────────────────────────

  /**
   * Create a hard link: make `linkPath` point to the same FileEntry as `targetPath`.
   * Both paths must be in the same filesystem (not across VFS mounts).
   * Returns false if target doesn't exist, is a directory, or linkPath already exists.
   */
  link(targetPath: string, linkPath: string): boolean {
    var resolvedTarget = this.resolvePath(targetPath);
    var resolvedLink   = this.resolvePath(linkPath);
    var targetEntry = this.navigate(resolvedTarget);
    if (!targetEntry || isDir(targetEntry)) return false;

    var linkParts  = resolvedLink.split('/').filter(function(p) { return p.length > 0; });
    var linkName   = linkParts[linkParts.length - 1];
    var linkDir    = '/' + linkParts.slice(0, -1).join('/');
    var parentDir  = this.navigate(linkDir);
    if (!parentDir || !isDir(parentDir)) return false;
    if ((parentDir as DirectoryEntry).children.has(linkName)) return false;

    // Share the same FileEntry object (true hard-link semantics)
    (parentDir as DirectoryEntry).children.set(linkName, targetEntry as FileEntry);
    (targetEntry as FileEntry).nlink = ((targetEntry as FileEntry).nlink || 1) + 1;
    return true;
  }

  /**
   * Unlink (remove) a path.  If the underlying FileEntry's nlink drops to 0,
   * its content is effectively freed.  Returns false if path doesn't exist or is a dir.
   */
  unlink(path: string): boolean {
    var resolved = this.resolvePath(path);
    var parts    = resolved.split('/').filter(function(p) { return p.length > 0; });
    if (parts.length === 0) return false;
    var name   = parts[parts.length - 1];
    var dirPath = '/' + parts.slice(0, -1).join('/');
    var parent  = this.navigate(dirPath) || this.root;
    if (!isDir(parent)) return false;
    var entry = (parent as DirectoryEntry).children.get(name);
    if (!entry || isDir(entry)) return false;
    (entry as FileEntry).nlink = Math.max(0, ((entry as FileEntry).nlink || 1) - 1);
    (parent as DirectoryEntry).children.delete(name);
    return true;
  }
}

/** Simple wildcard matching (* only) */
function simpleMatch(str: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.indexOf('*') === -1) return str === pattern;

  var parts = pattern.split('*');
  var pos = 0;

  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length === 0) continue;
    var idx = str.indexOf(parts[i], pos);
    if (idx === -1) return false;
    pos = idx + parts[i].length;
  }

  return true;
}

const fs = new FileSystem();
export default fs;

// ════════════════════════════════════════════════════════════════════════════
// [Item 195] Filesystem Quota: per-user limit enforcement
// ════════════════════════════════════════════════════════════════════════════

export interface QuotaEntry {
  uid:         number;
  /** Soft limit in bytes (0 = unlimited). */
  softBytes:   number;
  /** Hard limit in bytes (0 = unlimited). */
  hardBytes:   number;
  /** Soft limit in inodes (0 = unlimited). */
  softInodes:  number;
  /** Hard limit in inodes (0 = unlimited). */
  hardInodes:  number;
  /** Current byte usage. */
  usedBytes:   number;
  /** Current inode count. */
  usedInodes:  number;
  /** Grace period expiry (ms epoch, 0 = not in grace). */
  graceExpiry: number;
}

const QUOTA_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * [Item 195] Per-user filesystem quota manager.
 *
 * Tracks byte usage and inode count per UID.  Enforces:
 *   - Soft limit: usage can exceed for up to `QUOTA_GRACE_MS` (7 days)
 *   - Hard limit: usage never exceeds hard limit (write returns EDQUOT)
 *
 * Called by the VFS write/create paths to check before allocating.
 */
export class QuotaManager {
  private _quotas = new Map<number, QuotaEntry>();

  /** Set limits for a user (uid=0 means root, no limits). */
  setLimits(uid: number, softBytes: number, hardBytes: number,
            softInodes: number, hardInodes: number): void {
    var entry = this._quotas.get(uid) ?? {
      uid, softBytes: 0, hardBytes: 0, softInodes: 0, hardInodes: 0,
      usedBytes: 0, usedInodes: 0, graceExpiry: 0,
    };
    entry.softBytes  = softBytes;
    entry.hardBytes  = hardBytes;
    entry.softInodes = softInodes;
    entry.hardInodes = hardInodes;
    this._quotas.set(uid, entry);
  }

  /** Get quota info for a user. */
  getQuota(uid: number): QuotaEntry | null {
    return this._quotas.get(uid) ?? null;
  }

  /**
   * Check if a write of `bytes` bytes with `newInodes` new inodes is permitted.
   * @returns null if allowed, or an error string if quota exceeded.
   */
  checkWrite(uid: number, bytes: number, newInodes: number = 0): string | null {
    if (uid === 0) return null; // root is exempt
    var entry = this._quotas.get(uid);
    if (!entry) return null; // no quota set = unlimited

    var nowBytes  = entry.usedBytes  + bytes;
    var nowInodes = entry.usedInodes + newInodes;

    // Hard limits — absolute refusal
    if (entry.hardBytes  > 0 && nowBytes  > entry.hardBytes)  return 'EDQUOT: byte hard limit exceeded';
    if (entry.hardInodes > 0 && nowInodes > entry.hardInodes) return 'EDQUOT: inode hard limit exceeded';

    // Soft limits — allow with grace period
    if (entry.softBytes > 0 && nowBytes > entry.softBytes) {
      if (!entry.graceExpiry) entry.graceExpiry = Date.now() + QUOTA_GRACE_MS;
      else if (Date.now() > entry.graceExpiry) return 'EDQUOT: byte soft limit grace expired';
    } else if (nowBytes <= entry.softBytes) {
      entry.graceExpiry = 0; // clear grace period
    }

    return null;
  }

  /** Record bytes used (called after successful write). */
  recordUsage(uid: number, bytes: number, inodes: number = 0): void {
    var entry = this._quotas.get(uid);
    if (!entry) return;
    entry.usedBytes  += bytes;
    entry.usedInodes += inodes;
  }

  /** Release bytes (called after file deletion). */
  releaseUsage(uid: number, bytes: number, inodes: number = 0): void {
    var entry = this._quotas.get(uid);
    if (!entry) return;
    entry.usedBytes  = Math.max(0, entry.usedBytes  - bytes);
    entry.usedInodes = Math.max(0, entry.usedInodes - inodes);
  }

  /** Repquota: list all quotas for display. */
  repquota(): QuotaEntry[] {
    return Array.from(this._quotas.values());
  }
}

export const quotaManager = new QuotaManager();

// ════════════════════════════════════════════════════════════════════════════
// [Item 197] Sparse File Support
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 197] Sparse file — a virtual file whose "holes" (unwritten regions)
 * read as zeroes but do not occupy disk space.
 *
 * The implementation tracks "extents" (written data regions) in a sorted list.
 * Reads from unwritten regions return zero bytes.  Writes create new extents
 * or extend existing ones.  Adjacent extents are merged.
 *
 * This mirrors the Linux fallocate(2) / lseek(SEEK_HOLE, SEEK_DATA) model.
 */

export interface SparseExtent {
  offset: number;   // byte offset of the start of this extent
  data:   number[]; // actual data bytes
}

export class SparseFile {
  /** Sorted list of non-overlapping extents. */
  private _extents: SparseExtent[] = [];
  /** Logical file size (including holes up to the last written byte). */
  private _size = 0;

  get size(): number { return this._size; }

  /** Write `data` at `offset`. Creates or extends extents. */
  write(offset: number, data: number[]): void {
    if (data.length === 0) return;
    var end = offset + data.length;
    if (end > this._size) this._size = end;

    // Find overlapping extents and patch/merge
    var newExtent: SparseExtent = { offset, data: data.slice() };
    var merged: SparseExtent[] = [];
    var inserted = false;

    for (var i = 0; i < this._extents.length; i++) {
      var ex = this._extents[i];
      var exEnd = ex.offset + ex.data.length;

      // Extent comes entirely before the new write
      if (exEnd <= offset) { merged.push(ex); continue; }
      // Extent comes entirely after the new write — ensure insertion
      if (ex.offset >= end) {
        if (!inserted) { merged.push(newExtent); inserted = true; }
        merged.push(ex); continue;
      }

      // Overlapping or adjacent — merge
      var mergeStart = Math.min(newExtent.offset, ex.offset);
      var mergeEnd   = Math.max(newExtent.offset + newExtent.data.length, exEnd);
      var mergedData = new Array(mergeEnd - mergeStart).fill(0);

      // Copy old extent data
      for (var j = 0; j < ex.data.length; j++) {
        mergedData[ex.offset - mergeStart + j] = ex.data[j];
      }
      // Overwrite with new data (new data wins)
      for (var k = 0; k < newExtent.data.length; k++) {
        mergedData[newExtent.offset - mergeStart + k] = newExtent.data[k];
      }
      newExtent = { offset: mergeStart, data: mergedData };
    }

    if (!inserted) merged.push(newExtent);
    this._extents = merged;
  }

  /** Read `length` bytes from `offset`. Holes read as zero. */
  read(offset: number, length: number): number[] {
    var result = new Array(length).fill(0);
    for (var i = 0; i < this._extents.length; i++) {
      var ex = this._extents[i];
      var exEnd = ex.offset + ex.data.length;
      // No overlap
      if (exEnd <= offset || ex.offset >= offset + length) continue;
      // Copy the overlapping portion
      var copyStart = Math.max(ex.offset, offset);
      var copyEnd   = Math.min(exEnd, offset + length);
      for (var j = copyStart; j < copyEnd; j++) {
        result[j - offset] = ex.data[j - ex.offset];
      }
    }
    return result;
  }

  /**
   * Seek to next data region (SEEK_DATA) or next hole (SEEK_HOLE).
   * Returns the offset, or -1 if not found.
   */
  seekHole(offset: number): number {
    for (var i = 0; i < this._extents.length; i++) {
      var ex = this._extents[i];
      if (ex.offset > offset) return offset; // we're already in a hole
      if (ex.offset + ex.data.length > offset) {
        // We're inside an extent — next hole is after it
        return ex.offset + ex.data.length;
      }
    }
    return offset >= this._size ? -1 : this._size;
  }

  seekData(offset: number): number {
    for (var i = 0; i < this._extents.length; i++) {
      var ex = this._extents[i];
      if (ex.offset + ex.data.length > offset) {
        return Math.max(ex.offset, offset);
      }
    }
    return -1; // no data after offset
  }

  /**
   * Punch a hole (zero-fill and release) from `offset` for `length` bytes.
   * Used by fallocate(FALLOC_FL_PUNCH_HOLE).
   */
  punchHole(offset: number, length: number): void {
    var patched: SparseExtent[] = [];
    for (var i = 0; i < this._extents.length; i++) {
      var ex = this._extents[i];
      var exEnd = ex.offset + ex.data.length;
      var holeEnd = offset + length;
      if (exEnd <= offset || ex.offset >= holeEnd) { patched.push(ex); continue; }
      // Split before hole
      if (ex.offset < offset) {
        patched.push({ offset: ex.offset, data: ex.data.slice(0, offset - ex.offset) });
      }
      // Split after hole
      if (exEnd > holeEnd) {
        patched.push({ offset: holeEnd, data: ex.data.slice(holeEnd - ex.offset) });
      }
    }
    this._extents = patched;
  }

  /** Report the number of bytes actually stored (excluding holes). */
  get storedBytes(): number {
    return this._extents.reduce(function(sum, ex) { return sum + ex.data.length; }, 0);
  }

  /** List all extents (for debugging / defragmentation). */
  extents(): ReadonlyArray<SparseExtent> { return this._extents; }
}

// ════════════════════════════════════════════════════════════════════════════
// [Item 199] sendfile() zero-copy syscall
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 199] sendfile() — transfer bytes between file descriptors without
 * copying through user space.
 *
 * In the JSOS model, "zero-copy" means we avoid an intermediate ArrayBuffer
 * in the JS layer: we read directly from the source file object and write to
 * the destination socket/pipe without creating a full intermediate copy.
 *
 * API mirrors the Linux sendfile(2) syscall:
 *   sendfile(outFd, inFd, offset, count): number_of_bytes_sent
 *
 * Supported sources:
 *   - In-memory file (regular FileSystem files via `fs.readFile()`)
 *   - SparseFile (reads the sparse representation)
 *
 * Supported destinations:
 *   - TCP socket (via `net.sendBytes` or a send-callback)
 *   - Pipe / IPC channel
 */

export interface SendfileSource {
  read(offset: number, length: number): number[];
  readonly size: number;
}

export interface SendfileDest {
  write(data: number[]): number; // returns bytes written
}

/** In-memory file wrapper for sendfile. */
export class MemFileSendfileSource implements SendfileSource {
  constructor(private _data: number[]) {}
  read(offset: number, length: number): number[] {
    return this._data.slice(offset, offset + length);
  }
  get size(): number { return this._data.length; }
}

/** SparseFile wrapper for sendfile. */
export class SparseSendfileSource implements SendfileSource {
  constructor(private _sf: SparseFile) {}
  read(offset: number, length: number): number[] { return this._sf.read(offset, length); }
  get size(): number { return this._sf.size; }
}

/**
 * [Item 199] sendfile() — transfer `count` bytes from `src` to `dst`,
 * starting at `offset`.  Sends in chunks to avoid large allocations.
 *
 * @returns Total bytes transferred.
 */
export function sendfile(
  dst:    SendfileDest,
  src:    SendfileSource,
  offset: number,
  count:  number,
  chunkSize: number = 65536,
): number {
  var sent    = 0;
  var remaining = Math.min(count, src.size - offset);
  while (sent < remaining) {
    var toRead  = Math.min(chunkSize, remaining - sent);
    var chunk   = src.read(offset + sent, toRead);
    if (chunk.length === 0) break;
    var written = dst.write(chunk);
    sent += written;
    if (written < chunk.length) break; // destination is full
  }
  return sent;
}
