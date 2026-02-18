# The JSOS REPL

JSOS boots directly into a JavaScript REPL. There is no shell, no command interpreter, no special syntax — every line you type is **live ES2023 JavaScript** running on bare-metal i686.

Shell-like functions (`ls`, `cd`, `cat`, …) are plain JavaScript functions registered as globals. They print formatted output and return `undefined`, so the REPL stays quiet — exactly like a shell command.

---

## Prompt

```
jsos:~>
```

| Part | Meaning |
|---|---|
| `jsos` | Contents of `/etc/hostname` (change with `hostname('newname')`) |
| `:` | Separator |
| `~` | Current working directory (`/home/user` → `~`, other paths shown as-is) |
| `>` | Prompt character |

The prompt is **live** — after `cd('/tmp')` it immediately shows `jsos:/tmp>`.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Execute the current line |
| `↑` / `↓` | Browse history (up to 200 entries) |
| `Ctrl+U` | Erase the current line |
| `Ctrl+C` | Cancel the current line (prints `^C`) |
| `Ctrl+L` | Clear screen and redraw the prompt |
| `Backspace` | Delete last character |

---

## Multiline Mode

Opening a `{`, `(`, or `[` without closing it switches to multiline mode.  
The prompt changes to `.. ` and input accumulates.  
An **empty line** triggers execution of the whole block.

```
jsos:~> function greet(name) {
..       kernel.print('Hello, ' + name + '!');
..     }
..
jsos:~> greet('world')
Hello, world!
```

```
jsos:~> [1, 2, 3].map(function(n) {
..   return n * n;
.. })
..
→ [1,4,9]
```

---

## Output Colouring

| Value type | Colour |
|---|---|
| Number | Cyan |
| String | Green (includes surrounding `"`) |
| Boolean | Yellow |
| `null` | Dark grey |
| Error | Red |
| Object / Array | White (JSON-pretty-printed) |
| `undefined` | *(suppressed — no output)* |

Shell functions return `undefined` → silent, just like real shell commands.

---

## Filesystem Functions

These print formatted output. For raw data suitable for scripting, use `fs.*` instead.

### `ls(path?)`
List directory contents. Defaults to current directory.
```js
ls()            // list ~
ls('/bin')      // list /bin
ls('/tmp')
```
Directories shown in blue with `/` suffix. `.js` files in green.

### `cd(path?)`
Change directory. Defaults to `~` (`/home/user`). Supports `..` and `~`.
```js
cd('/bin')
cd('..')
cd()          // go home
cd('~/notes') // /home/user/notes
```

### `pwd()`
Print current working directory.

### `cat(path)`
Print file contents.
```js
cat('/etc/hostname')
cat('/etc/motd')
cat('/bin/hello.js')
```

### `mkdir(path)`
Create a directory.
```js
mkdir('/tmp/mydir')
```

### `touch(path)`
Create an empty file (no-op if it already exists).
```js
touch('/tmp/notes.txt')
```

### `rm(path)`
Remove a file, or an empty directory.
```js
rm('/tmp/notes.txt')
rm('/tmp/mydir')   // only if empty
```

### `cp(src, dst)`
Copy a file.
```js
cp('/etc/hostname', '/tmp/hostname.bak')
```

### `mv(src, dst)`
Move or rename a file.
```js
mv('/tmp/foo.txt', '/tmp/bar.txt')
```

### `write(path, text)`
Overwrite a file with `text`.
```js
write('/tmp/hi.js', 'kernel.print("hi!")')
```

### `append(path, text)`
Append `text` to a file.
```js
append('/var/log/boot.log', 'manual entry\n')
```

### `find(path?, pattern)`
Find files matching a glob-style pattern (`*` wildcard).
```js
find('*.js')             // search / for .js files
find('/bin', '*.js')     // search /bin only
find('/etc', 'host*')
```

### `stat(path)`
Print file metadata (type, size, permissions).
```js
stat('/etc/hostname')
```

### `run(path)`
Execute a `.js` file. Also searches `/bin/` if the path isn't found directly.
```js
run('/bin/hello.js')
run('sysinfo.js')    // looks in /bin/sysinfo.js
```

---

## System Functions

### `ps()`
Print the process table.
```
  PID  NAME                STATE        PRI
  -----------------------------------------------
     1  kernel              running      0
     2  init                running      1
```

### `kill(pid)`
Terminate a process by PID. The kernel process (PID 1) cannot be killed.
```js
kill(3)
```

### `mem()`
Print memory usage with a visual bar.
```
Memory
  total : 768 KB
  used  : 42 KB
  free  : 726 KB
  [####................................]  5%
```

### `uptime()`
Print system uptime since boot.
```js
uptime()
// → 2m 14s  (134321 ms)
//   ticks: 13432
```

### `sysinfo()`
Full system summary.
```
JSOS System Information
  os       : JSOS v1.0.0
  hostname : jsos
  arch     : i686 (x86-bit)
  runtime  : QuickJS ES2023
  screen   : 80x25 VGA text
  memory   : 768 KB total, 726 KB free
  uptime   : 134s
  procs    : 2
```

### `colors()`
Display the full VGA 16-colour palette with colour names.

### `hostname(name?)`
Print or set the system hostname.
```js
hostname()             // print current
hostname('mybox')      // set and print confirmation
```

### `sleep(ms)`
Block for `ms` milliseconds.
```js
sleep(1000)   // pause 1 second
```

### `clear()`
Clear the screen.

### `halt()`
Power off (executes `cli; hlt`).

### `reboot()`
Reboot via PS/2 controller pulse (`outb(0x64, 0xFE)`).

---

## REPL Utility Functions

### `history()`
Print the input history (up to 200 entries, numbered).

### `echo(...args)`
Print arguments joined by spaces.
```js
echo('hello', 'world')   // → hello world
```

### `print(s)`
Shorthand for `kernel.print(String(s))`. Adds a newline.
```js
print(42)
print('done')
```

### `help()`
Print the full built-in reference (same as this doc, on-screen).

---

## Scripting APIs

These functions return **raw data** rather than printing. Use them when you want to manipulate the results in JavaScript.

### `fs` object

```js
fs.ls(path?)            // → Array<{name, type, size, …}>
fs.read(path)           // → string | null
fs.write(path, content) // → boolean
fs.append(path, content)// → boolean
fs.mkdir(path)          // → boolean
fs.touch(path)          // → true
fs.rm(path)             // → boolean
fs.cp(src, dst)         // → boolean
fs.mv(src, dst)         // → boolean
fs.stat(path)           // → {type, size, permissions, …} | null
fs.exists(path)         // → boolean
fs.isDir(path)          // → boolean
fs.isFile(path)         // → boolean
fs.pwd()                // → string  (current working dir)
fs.cd(path)             // → boolean
fs.find(path, pattern)  // → string[]
fs.run(path)            // → eval result string
```

### `sys` object

```js
sys.mem()               // → {total, used, free}  (bytes)
sys.uptime()            // → number  (ms since boot)
sys.ticks()             // → number  (100 Hz tick count)
sys.screen()            // → {width, height}
sys.ps()                // → ProcessDescriptor[]
sys.spawn(name)         // → ProcessDescriptor | null
sys.kill(pid)           // → boolean
sys.sleep(ms)           // → void
sys.hostname(name?)     // → string
sys.version()           // → string  (e.g. "1.0.0")
sys.sysinfo()           // → {os, hostname, arch, runtime, screen, memory, uptime, processes}
sys.reboot()            // → void
sys.halt()              // → void
```

---

## Scripting Examples

### List all .js files in /bin

```js
fs.ls('/bin').filter(function(f){ return f.name.slice(-3) === '.js' })
```

### Read, modify, write a file

```js
var text = fs.read('/etc/motd')
fs.write('/etc/motd', text + '\nUpdated!\n')
cat('/etc/motd')
```

### Write and run an inline script

```js
write('/tmp/demo.js', [
  'for (var i = 0; i < 16; i++) {',
  '  kernel.setColor(i, 0);',
  '  kernel.printRaw("  " + i + " ");',
  '}',
  'kernel.setColor(7, 0);',
  'kernel.print("");',
].join('\n'))
run('/tmp/demo.js')
```

### Custom process management

```js
var p = sys.spawn('worker')
sys.ps()
sys.kill(p.id)
```

### JSON pretty-print system info

```js
JSON.stringify(sys.sysinfo(), null, 2)
```

### Memory check in a loop

```js
var start = sys.mem().free
write('/tmp/big.txt', new Array(10000).join('x'))
var end = sys.mem().free
print('used: ' + (start - end) + ' bytes')
```

### Measure uptime delta

```js
var t0 = sys.uptime()
sleep(500)
print(sys.uptime() - t0 + 'ms')
```

### Explore the filesystem tree

```js
function tree(path, indent) {
  indent = indent || '';
  var items = fs.ls(path);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    print(indent + item.name + (item.type === 'directory' ? '/' : ''));
    if (item.type === 'directory')
      tree((path === '/' ? '' : path) + '/' + item.name, indent + '  ');
  }
}
tree('/')
```

---

## Tips

- **Expressions** are displayed; **statements** (`var x = 1`) are silent unless you also type `x` after.
- `undefined` is always suppressed — shell functions are completely silent unless they print explicitly.
- Objects are automatically `JSON.stringify`'d with 2-space indent.
- The REPL shares the **same QuickJS global context** as everything else — variables you define persist for the session.
- `kernel.*` is always available for low-level hardware access (see [kernel-api.md](kernel-api.md)).
