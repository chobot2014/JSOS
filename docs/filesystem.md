# Filesystem

JSOS has a fully in-memory Unix-like virtual filesystem implemented in TypeScript (`src/os/filesystem.ts`). It persists only for the lifetime of the running OS session — it resets on reboot.

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
│   └── user/           home directory  (~)
│       └── .profile    # User profile (empty by default)
├── tmp/                scratch space (not persisted)
├── var/
│   └── log/
│       └── boot.log    [timestamp] System booted
├── dev/
│   └── null            empty file
└── proc/
    ├── version         "JSOS 1.0.0 ..."
    ├── uptime          "0"
    └── meminfo         ""
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

- **Storage:** Everything lives in a JavaScript `Map<string, FileEntry | DirectoryEntry>` tree rooted at `/`.
- **Permissions:** Stored as Unix-style strings (`"rw-r--r--"`) but not enforced — they're display-only.
- **Timestamps:** `Date.now()` returns `kernel.getUptime()` (ms since boot), so timestamps are relative to boot, not calendar time.
- **No inodes:** Each path lookup traverses the tree from root. Hardlinks are not supported.
- **No persistence:** All data is lost on reboot. Future work could add a RAM disk image embedded in the kernel.
