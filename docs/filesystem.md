# Filesystem

JSOS has a layered virtual filesystem implemented entirely in TypeScript. The VFS in `src/os/fs/filesystem.ts` supports pluggable mount points, so different providers serve different parts of the tree.

---

## Filesystem Providers

| Mount Point | Provider | Type | Persistent |
|---|---|---|---|
| `/` | `filesystem.ts` | In-memory VFS | No |
| `/proc` | `proc.ts` | Dynamic virtual FS | No |
| `/dev` | `dev.ts` | Device node FS | No |
| `/disk` | `fat32.ts` / `fat16.ts` | Block-backed FAT | **Yes** |

---

## Default Layout

```
/
├── bin/
│   ├── hello.js        print "Hello, World!"
│   ├── sysinfo.js      display memory / screen / uptime
│   └── colors.js       16-colour VGA palette demo
├── etc/
│   ├── hostname        "jsos"
│   ├── version         "1.0.0"
│   └── motd            welcome message
├── home/
│   └── user/           home directory (~)
│       └── .profile    user profile (empty by default)
├── tmp/                scratch space (not persisted across reboots)
├── var/
│   └── log/
│       └── boot.log    boot timestamp
├── dev/                device nodes (see /dev below)
├── proc/               system information (see /proc below)
└── disk/               persistent FAT32 disk (if attached)
```

---

## /proc

Read-only virtual files. Contents are generated on each `read()` call.

| File | Contents |
|---|---|
| `/proc/version` | `JSOS 1.0.0 QuickJS ES2023 i686` |
| `/proc/uptime` | milliseconds since boot |
| `/proc/meminfo` | `MemTotal / MemFree / MemUsed` |
| `/proc/self/maps` | virtual memory regions for current process |

---

## /dev

Device nodes backed by `dev.ts`.

| Node | Behaviour |
|---|---|
| `/dev/null` | reads return 0 bytes; writes are discarded |
| `/dev/zero` | reads return unlimited zero bytes |
| `/dev/urandom` | reads return pseudo-random bytes (xorshift64) |
| `/dev/tty` | reads poll keyboard; writes go to terminal |

---

## /disk — Persistent Storage

`/disk` is mounted from a real ATA block device (QEMU `-drive`) formatted as FAT32 (or FAT16 on small images). Data survives reboots.

On boot, `main.ts` tries `fat32.mount()` first, then `fat16.mount()`. If a blank disk is detected it is automatically formatted.

Use via `fs.*` with paths under `/disk`, or via the `disk.*` convenience API:

```javascript
disk.write('/notes.txt', 'hello')   // write to persistent disk
disk.read('/notes.txt')             // 'hello' — survives reboot
disk.ls()                           // list disk root
disk.format()                       // reformat (all data lost)
```

---

## REPL Functions (print output)

See [repl.md](repl.md) for full usage. Quick reference:

```
ls(path?)          list directory
cd(path?)          change directory
pwd()              print working dir
cat(path)          print file contents
mkdir(path)        create directory
touch(path)        create empty file
rm(path)           remove file or empty dir
cp(src, dst)       copy file
mv(src, dst)       move / rename
write(path, text)  overwrite file
append(path, text) append to file
find(path?, pat)   find files  (* wildcard)
stat(path)         file info
run(path)          execute .js file
```

---

## Scripting API (`fs.*`)

These return raw data for use in JavaScript expressions.

### `fs.ls(path?): FileListEntry[]`
List directory. Returns an array of:
```typescript
{
  name: string;          // filename
  type: 'file' | 'directory';
  size: number;          // bytes (0 for directories)
  created: number;       // ms timestamp
  modified: number;      // ms timestamp
  permissions: string;   // e.g. "rw-r--r--"
}
```

```js
var bins = fs.ls('/bin')
bins.map(function(f){ return f.name })   // → ["hello.js", "sysinfo.js", "colors.js"]
```

### `fs.read(path): string | null`
Read file contents. Returns `null` if the path doesn't exist or is a directory.

```js
var hostname = fs.read('/etc/hostname')  // → "jsos"
```

### `fs.write(path, content): boolean`
Overwrite file with `content`. Creates the file if it doesn't exist. Returns `false` if the parent directory doesn't exist.

```js
fs.write('/tmp/hello.js', 'kernel.print("hi")')
```

### `fs.append(path, content): boolean`
Append `content` to an existing file. Creates the file if it doesn't exist.

```js
fs.append('/var/log/boot.log', 'custom entry\n')
```

### `fs.mkdir(path): boolean`
Create a directory. Parent must exist. Returns `false` if it already exists or parent is missing.

```js
fs.mkdir('/home/user/projects')
```

### `fs.touch(path): boolean`
Create an empty file if it doesn't exist. No-op if it already exists. Always returns `true`.

```js
fs.touch('/tmp/lock')
```

### `fs.rm(path): boolean`
Remove a file or an **empty** directory. Returns `false` if not found or if a directory is non-empty.

```js
fs.rm('/tmp/lock')
```

### `fs.cp(src, dst): boolean`
Copy a file. `dst` must not be a directory — it's the full target path.

```js
fs.cp('/etc/hostname', '/tmp/hostname.bak')
```

### `fs.mv(src, dst): boolean`
Move or rename a file. Equivalent to copy + remove.

```js
fs.mv('/tmp/old.txt', '/tmp/new.txt')
```

### `fs.stat(path): StatInfo | null`
Return file metadata:
```typescript
{
  type: 'file' | 'directory';
  size: number;
  permissions: string;
  created: number;
  modified: number;
}
```

```js
fs.stat('/etc/hostname')
// → { type: "file", size: 4, permissions: "rw-r--r--", … }
```

### `fs.exists(path): boolean`
Return `true` if the path exists (file or directory).

```js
fs.exists('/tmp/lock')
```

### `fs.isDir(path): boolean`
Return `true` if the path is a directory.

### `fs.isFile(path): boolean`
Return `true` if the path is a regular file.

### `fs.pwd(): string`
Return the current working directory as an absolute path.

```js
fs.pwd()  // → "/home/user"
```

### `fs.cd(path): boolean`
Change current directory. Supports `..`, `.`, and `~`. Returns `false` if the path doesn't exist.

```js
fs.cd('/tmp')       // → true
fs.cd('/nope')      // → false
fs.cd('..')
fs.cd('~')          // → /home/user
```

### `fs.find(path, pattern): string[]`
Recursively search `path` for entries whose name matches `pattern` (`*` is the wildcard).

```js
fs.find('/', '*.js')
// → ["/bin/hello.js", "/bin/sysinfo.js", "/bin/colors.js"]

fs.find('/etc', 'host*')
// → ["/etc/hostname"]
```

### `fs.run(path): string`
Read and evaluate a `.js` file via `kernel.eval()`. Also searches `/bin/<path>` if the direct path fails. Returns the eval result string.

```js
fs.run('/bin/hello.js')    // prints "Hello, World!", returns "undefined"
fs.run('sysinfo.js')       // searches /bin/sysinfo.js
```

---

## Path Resolution

Paths are resolved relative to the current working directory:

| Input | Resolved to |
|---|---|
| `/etc/hostname` | `/etc/hostname` (absolute) |
| `hostname` | `<cwd>/hostname` |
| `./hostname` | `<cwd>/hostname` |
| `../etc/hostname` | resolved with `..` |
| `~` | `/home/user` |
| `~/notes` | `/home/user/notes` |

`.` and `..` components are normalised. Multiple slashes are collapsed.

---

## Writing Scripts

Scripts stored in the filesystem are plain JavaScript. They run in the **same global context** as the REPL, so they can use any global (`kernel`, `ls`, `fs`, `sys`, etc.).

### Example: `/bin/hello.js`
```js
kernel.print('Hello, World!')
```

### Example: `/bin/sysinfo.js`
```js
var mem = kernel.getMemoryInfo()
var screen = kernel.getScreenSize()
kernel.print('Memory: ' + mem.used + ' / ' + mem.total + ' bytes used')
kernel.print('Screen: ' + screen.width + 'x' + screen.height)
kernel.print('Uptime: ' + kernel.getUptime() + ' ms')
```

### Example: `/bin/colors.js`
```js
var names = ['BLACK','BLUE','GREEN','CYAN','RED','MAGENTA','BROWN','LIGHT_GREY',
             'DARK_GREY','LIGHT_BLUE','LIGHT_GREEN','LIGHT_CYAN',
             'LIGHT_RED','LIGHT_MAGENTA','YELLOW','WHITE']
for (var i = 0; i < 16; i++) {
  kernel.setColor(i, 0)
  kernel.printRaw(names[i] + ' ')
}
kernel.setColor(7, 0)
kernel.print('')
```

### Writing your own script at the REPL

```js
write('/tmp/fizzbuzz.js',
  'for (var i = 1; i <= 30; i++) {\n' +
  '  if (i % 15 === 0) kernel.print("FizzBuzz");\n' +
  '  else if (i % 3 === 0) kernel.print("Fizz");\n' +
  '  else if (i % 5 === 0) kernel.print("Buzz");\n' +
  '  else kernel.print(i);\n' +
  '}\n'
)
run('/tmp/fizzbuzz.js')
```

---

## Implementation Notes

- **In-memory VFS:** Lives in a `Map<path, entry>` tree. No inodes; lookups traverse from root. Hardlinks not supported.
- **Permissions:** Stored as Unix-style strings (`"rw-r--r--"`) but not enforced — display-only.
- **Timestamps:** `Date.now()` is `kernel.getUptime()` (ms since boot), so timestamps are boot-relative, not calendar.
- **Persistence:** `/disk` survives reboots via FAT32/FAT16 on a QEMU disk image. Everything else resets on reboot.
- **Mount points:** `fs.mountVFS(path, provider)` registers any object with `read/write/ls/mkdir/rm/stat` as a provider.
