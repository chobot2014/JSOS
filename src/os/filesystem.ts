/**
 * JSOS File System Module
 * In-memory filesystem with Unix-like paths
 */

export type FileType = 'file' | 'directory';

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

  constructor() {
    var now = Date.now();
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
    // Create standard directories
    this.mkdir('/bin');
    this.mkdir('/etc');
    this.mkdir('/home');
    this.mkdir('/home/user');
    this.mkdir('/tmp');
    this.mkdir('/var');
    this.mkdir('/var/log');
    this.mkdir('/dev');
    this.mkdir('/proc');

    // Create default files
    this.writeFile('/etc/hostname', 'jsos');
    this.writeFile('/etc/version', '1.0.0');
    this.writeFile('/etc/motd',
      'Welcome to JSOS - JavaScript Operating System\n' +
      'Type "help" for available commands.\n' +
      'Type "js" to enter the JavaScript REPL.\n'
    );
    this.writeFile('/home/user/.profile', '# User profile\n');
    this.writeFile('/var/log/boot.log', '[' + Date.now() + '] System booted\n');
    this.writeFile('/proc/version', 'JSOS 1.0.0 (i686-elf-gcc) Duktape JavaScript Runtime');
    this.writeFile('/proc/uptime', '0');
    this.writeFile('/proc/meminfo', '');
    this.writeFile('/dev/null', '');

    // Create some example programs
    this.writeFile('/bin/hello.js',
      '// Hello World program\n' +
      'print("Hello, World!");\n'
    );
    this.writeFile('/bin/sysinfo.js',
      '// System information\n' +
      'var mem = kernel.getMemoryInfo();\n' +
      'var screen = kernel.getScreenSize();\n' +
      'print("Memory: " + mem.used + " / " + mem.total + " bytes used");\n' +
      'print("Screen: " + screen.width + "x" + screen.height);\n' +
      'print("Uptime: " + kernel.getUptime() + " ms");\n'
    );
    this.writeFile('/bin/colors.js',
      '// Color palette demo\n' +
      'var names = ["BLACK","BLUE","GREEN","CYAN","RED","MAGENTA","BROWN","LT_GREY",\n' +
      '  "DK_GREY","LT_BLUE","LT_GREEN","LT_CYAN","LT_RED","LT_MAG","YELLOW","WHITE"];\n' +
      'for (var i = 0; i < 16; i++) {\n' +
      '  terminal.setColor(i, 0);\n' +
      '  terminal.print("  " + i + " ########  ");\n' +
      '  terminal.setColor(7, 0);\n' +
      '  terminal.println(names[i]);\n' +
      '}\n' +
      'terminal.setColor(7, 0);\n'
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
        var now = Date.now();
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

    var now = Date.now();
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
    return this.navigate(path) !== null;
  }

  /** Check if a path is a directory */
  isDirectory(path: string): boolean {
    var entry = this.navigate(path);
    return entry !== null && isDir(entry);
  }

  /** Check if a path is a file */
  isFile(path: string): boolean {
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
