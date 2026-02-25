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

export type FileType = 'file' | 'directory';

/** Interface that any virtual filesystem must implement to be mounted. */
export interface VFSMount {
  read(path: string): string | null;
  list(path: string): Array<{ name: string; type: FileType; size: number }>;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
}

export interface FileEntry {
  name: string;
  type: FileType;
  content: string;
  size: number;
  created: number;
  modified: number;
  permissions: string;
}

export interface DirectoryEntry {
  name: string;
  type: FileType;
  children: Map<string, FileEntry | DirectoryEntry>;
  created: number;
  modified: number;
  permissions: string;
}

function isDir(entry: FileEntry | DirectoryEntry): entry is DirectoryEntry {
  return entry.type === 'directory';
}

export class FileSystem {
  private root: DirectoryEntry;
  private currentPath: string = '/';
  private mounts = new Map<string, VFSMount>(); // mountpoint -> handler

  /** Mount a virtual filesystem at a path prefix (e.g. '/proc'). */
  mountVFS(mountpoint: string, vfs: VFSMount): void {
    this.mounts.set(mountpoint, vfs);
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
  }

  private initializeDefaultFS(): void {
    // Standard Unix directory tree
    this.mkdir('/bin');
    this.mkdir('/usr');
    this.mkdir('/usr/bin');
    this.mkdir('/usr/lib');
    this.mkdir('/lib');
    this.mkdir('/etc');
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

  /** Navigate to a directory entry by path */
  private navigate(path: string): FileEntry | DirectoryEntry | null {
    var resolved = this.resolvePath(path);
    if (resolved === '/') return this.root;

    var parts = resolved.split('/').filter(function(p) { return p.length > 0; });
    var current: FileEntry | DirectoryEntry = this.root;

    for (var i = 0; i < parts.length; i++) {
      if (!isDir(current)) return null;
      var child = current.children.get(parts[i]);
      if (!child) return null;
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
          permissions: 'rwxr-xr-x',
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
      permissions: 'rw-r--r--',
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
