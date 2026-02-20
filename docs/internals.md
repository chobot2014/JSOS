# Internals

A deep dive into how JSOS actually works — the C kernel, the QuickJS binding layer, the TypeScript build pipeline, and the design decisions behind each.

---

## 1. Boot: from GRUB to `main()`

GRUB loads the kernel ELF at physical address `0x00100000` (1 MB) as required by the multiboot spec.

### `boot.s`
```nasm
; Multiboot header — tells GRUB this is a valid kernel image
section .multiboot
align 4
  dd 0x1BADB002      ; magic
  dd 0x00000000      ; flags
  dd -(0x1BADB002)   ; checksum

; Set up a 16 KB initial stack and call kernel_main
section .bss
align 16
stack_bottom: resb 16384
stack_top:

section .text
global _start
_start:
  mov esp, stack_top
  call kernel_main
  cli
  hlt
```

### `crt0.s`
Handles C runtime initialisation (`.ctors` / `.dtors` sections, calling global constructors) before `main()` runs.

### `linker.ld`
Places sections in order: `.text` at `0x00100000`, then `.rodata`, `.data`, `.bss`. The multiboot header is guaranteed to be in the first 8 KB of the image.

---

## 2. Kernel Initialization (`kernel.c`)

```c
int main(void) {
    terminal_initialize();   // VGA 80×25 text mode
    memory_initialize();     // detect physical RAM
    gdt_flush();             // reload GDT (needed before IDT)
    irq_initialize();        // IDT + PIC remapping + enable interrupts
    timer_initialize(100);   // PIT at 100 Hz
    keyboard_initialize();   // PS/2 keyboard IRQ1 handler
    mouse_initialize();      // PS/2 mouse IRQ12 handler
    pci_scan();              // enumerate PCI bus (finds virtio-net)
    quickjs_initialize();    // QuickJS runtime + context + kernel.* globals
    quickjs_run_os();        // JS_Eval(embedded_js_code)
    // if JS returns, halt
    __asm__ volatile("cli; hlt");
}
```

---

## 3. Hardware Drivers

### Platform (`platform.c`)
Handles VGA text mode, VESA framebuffer, and serial output.

- **VGA text** — writes to `0xB8000`; each cell is `[colour_byte][ascii_byte]`
- **VESA framebuffer** — negotiated by GRUB multiboot framebuffer tag; `kernel.fbInfo()` returns dimensions; `kernel.fbBlit()` copies a pixel buffer to the physical address
- **Serial** — COM1 at `0x3F8`; `kernel.serialPut()` used for headless test output

### Keyboard (`keyboard.c`)
IRQ1 (keyboard interrupt) handler:
- Reads scan code from port `0x60`
- Translates using a US QWERTY scancode map
- Routes to one of two queues:
  - **Char queue** — printable ASCII + control chars (Enter, Backspace, Ctrl+C, …)
  - **Extended queue** — arrow keys, F-keys (stored as synthetic codes 0x80–0x83)

`keyboard_get_extended()` drains from the extended queue; `keyboard_poll()` from the char queue.

`kernel.waitKeyEx()` checks the extended queue first. If empty, checks the char queue. If both empty, executes `hlt` (halts until next interrupt) to avoid busy-waiting.

### Timer (`timer.c`)
Configures the Intel 8253/8254 PIT (Programmable Interval Timer) at **100 Hz**.  
Each IRQ0 fires every 10 ms, incrementing a global `ticks` counter and calling any registered scheduler hook.

`timer_sleep(ms)` busy-waits on the tick counter:
```c
uint32_t target = ticks + (ms / 10);
while (ticks < target) __asm__ volatile("hlt");
```

### Mouse (`mouse.c`)
IRQ12 handler reads PS/2 mouse packets (3-byte sequences: buttons, dx, dy).  
`kernel.readMouse()` pops the next packet from the queue or returns `null`.

### ATA (`ata.c`)
ATA PIO driver. Provides `kernel.ataPresent()`, `kernel.ataRead(lba, sectors)`, `kernel.ataWrite(lba, sectors, data)`.  
All caching and filesystem logic live in TypeScript (`block.ts`, `fat32.ts`, `fat16.ts`).

### IRQ (`irq.c` + `irq_asm.s`)
Sets up the x86 IDT (256 entries). Remaps PIC to vectors 0x20–0x2F (above CPU exceptions).  
Assembly stubs push a common frame and call `irq_handler(regs)` in C.

### PCI (`pci.c`)
Scans all PCI buses to enumerate devices. Identifies virtio-net (vendor=0x1AF4, device=0x1000).  
TypeScript queries via `kernel.netInit()` and `kernel.netPciAddr()`.

### virtio-net (`virtio_net.c`)
Initialises the virtio-net device's TX/RX virtqueues. C provides only `kernel.netSendFrame(bytes)` and `kernel.netRecvFrame()` — raw Ethernet frame I/O. All protocol logic (ARP, IPv4, TCP, TLS) is TypeScript.

---

## 4. QuickJS Binding (`quickjs_binding.c`)

### Runtime Setup
```c
int quickjs_initialize(void) {
    rt = JS_NewRuntime();
    // heap: full 256 MB BSS; no explicit JS_SetMemoryLimit so QuickJS can
    // use all of it (physical allocator manages remaining RAM independently)
    JS_SetMaxStackSize(rt, 256 * 1024);  // 256 KB stack
    ctx = JS_NewContext(rt);

    // Create global `kernel` object and register all C functions
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue kernel_obj = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, kernel_obj, js_kernel_funcs, ARRAY_LEN);
    JS_SetPropertyStr(ctx, global, "kernel", kernel_obj);

    // Add kernel.colors sub-object with integer constants
    // Install console + Date.now polyfills via JS_Eval
}
```

### Function Registration
Each C function has the signature:
```c
static JSValue js_kernel_xxx(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
```

And is registered in a `JSCFunctionListEntry` array:
```c
static const JSCFunctionListEntry js_kernel_funcs[] = {
    JS_CFUNC_DEF("print", 1, js_kernel_print),
    JS_CFUNC_DEF("waitKeyEx", 0, js_kernel_wait_key_ex),
    // ... 25 total
};
```

### `waitKeyEx` — Extended Key Handling
The most complex binding. It loops with `hlt` between polls to avoid CPU spinning:

```c
static JSValue js_kernel_wait_key_ex(...) {
    for (;;) {
        int ext = keyboard_get_extended();
        if (ext != 0) {
            // return { ch: "", ext: <code> }
        }
        if (keyboard_has_key()) {
            char c = keyboard_poll();
            // return { ch: "<c>", ext: 0 }
        }
        __asm__ volatile("hlt");   // sleep until next IRQ
    }
}
```

### `kernel.eval`
Calls `JS_Eval()` in `JS_EVAL_TYPE_GLOBAL` mode (full global scope).  
Exceptions are caught and returned as strings — they never escape to C as crashes.  
Result objects are stringified via `JS_ToCString` (not JSON).

The REPL wraps calls in an IIFE to get proper object serialisation:
```js
(function(){
  var __r = (USER_CODE);
  if (__r === undefined) return "__JSOS_UNDEF__";
  if (typeof __r === "object") return JSON.stringify(__r, null, 2);
  return String(__r);
})()
```

### Running the OS
```c
int quickjs_run_os(void) {
    JSValue result = JS_Eval(ctx, embedded_js_code,
                             strlen(embedded_js_code),
                             "jsos.js",
                             JS_EVAL_TYPE_GLOBAL);
    // error handling …
}
```

`embedded_js_code` is a C `const char[]` defined in `embedded_js.h` (auto-generated at build time).

---

## 5. TypeScript Build Pipeline

### Step 1: esbuild (type-strip only)

`scripts/bundle-hybrid.js` uses esbuild to strip TypeScript types and bundle all modules. No polyfills — QuickJS supports ES2023 natively.

```js
await esbuild.build({
  entryPoints: ['src/os/core/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2023',
  platform: 'browser',
  outfile: 'build/bundle.js',
})
```

TypeScript's `const enum` values (like `Color.LIGHT_GREEN`) are inlined as integer literals — no `Color` object exists at runtime.

### Step 2: JS embedding

`scripts/embed-js.js` produces `src/kernel/embedded_js.h`:
```bash
echo 'const char embedded_js_code[] = ' > embedded_js.h
node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('build/bundle.js','utf8')))" >> embedded_js.h
echo ';' >> embedded_js.h
```

The result is a C string literal included by `quickjs_binding.c`:
```c
#include "embedded_js.h"
// embedded_js_code is now available as a C string
```

---

## 6. TypeScript OS Layer

### Module structure

All modules use ES module syntax (`import`/`export`) resolved by esbuild at bundle time. The full dependency graph is in `src/os/core/main.ts`.

Key modules:

```
core/main.ts       boot sequence, hardware init
core/kernel.ts     C binding declarations (types only — zero runtime JS)
core/syscalls.ts   POSIX syscall routing
core/fdtable.ts    unified fd table, pipes, epoll

process/threads.ts      kernel threads, priority round-robin scheduler
process/sync.ts         Mutex / CondVar / Semaphore
process/process.ts      fork / exec / waitpid
process/vmm.ts          virtual memory, mmap, page tables
process/physalloc.ts    physical page bitmap allocator
process/elf.ts          ELF32 parser + loader
process/signals.ts      signal delivery

fs/filesystem.ts   in-memory VFS with mount points
fs/proc.ts         /proc
fs/dev.ts          /dev
fs/romfs.ts        bundled ROM files

storage/block.ts   block device + 64-sector LRU cache
storage/fat32.ts   FAT32 read/write + auto-format
storage/fat16.ts   FAT16 read/write + auto-format

net/net.ts         full TCP/IP stack
net/tls.ts         TLS 1.3 (pure TypeScript)
net/crypto.ts      X25519, AES-GCM, SHA256, HKDF
net/http.ts        HTTP/HTTPS client
net/dhcp.ts        DHCP client
net/dns.ts         DNS resolver

ui/canvas.ts       pixel Canvas, 8x8 bitmap font, color helpers
ui/wm.ts           window manager: z-order, drag, resize, taskbar
ui/terminal.ts     terminal emulator (VGA text + windowed)
ui/repl.ts         JavaScript REPL
ui/editor.ts       text editor

apps/browser.ts        native HTML browser (HTTP/HTTPS + HTML parser)
apps/terminal-app.ts   windowed terminal
apps/editor-app.ts     windowed editor
```

`kernel.ts` exports only types and `const enum` — zero runtime JavaScript.

### Key TypeScript Modules

#### `canvas.ts`
Maintains a `Uint32Array` pixel buffer. `flip()` copies it to the physical framebuffer via `kernel.fbBlit()` (zero-copy ArrayBuffer path). Implements `drawRect`, `drawText` (8×8 bitmap font), `drawLine`, `blit`, color blending.

#### `wm.ts`
Each frame: poll `kernel.readKeyEx()` + `kernel.readMouse()` → dispatch events → composite all windows → flip. Windows own sub-Canvases. Z-order is a sorted array. Drag/resize tracked via mousedown state.

#### `net.ts`
Full TCP/IP in TypeScript. `NetStack` maintains ARP table, socket table, TCP state machines. When `kernel.netInit()` returns true at boot, `net.initNIC()` wires `kernel.netSendFrame` / `kernel.netRecvFrame` as the bottom-layer I/O hooks. Without a NIC, all traffic loops internally.

#### `tls.ts`
TLS 1.3 client. `TLSSocket` wraps a `net.ts` TCP socket. Handshake: ClientHello → ServerHello → EncryptedExtensions → Certificate → CertificateVerify → Finished. Key schedule and AEAD from `crypto.ts`. No cert validation.

#### `process.ts`
`ProcessManager` tracks processes, VMAs, file descriptors. `fork()` clones VMA list (calls `kernel.cloneAddressSpace()` — stub in current build). `exec()` runs a JS function as the new process body. `waitpid()` spins until exit.

#### `filesystem.ts`
`FileSystem` is a `Map<path, entry>` tree. Supports `mountVFS(path, provider)` — any object with `read/write/ls/mkdir/rm/stat` becomes a mount. `/proc` and `/dev` are TypeScript providers; `/disk` delegates to `fat32`/`fat16`.

#### `repl.ts`
The REPL is a pure event loop (text mode):
```typescript
export function startRepl(): void {
  for (;;) {
    var line = readline(printShellPrompt);    // blocking keyboard read
    if (isIncomplete(line)) {                 // bracket depth check
      // accumulate into mlBuffer
    } else {
      evalAndPrint(line);                     // eval + display result
    }
  }
}
```
`evalAndPrint` wraps in an IIFE for expression return values; falls back to statement eval on SyntaxError. In windowed mode the REPL runs inside the terminal app, which relays key events from the WM.

---

## 7. Global Context Architecture

Everything in JSOS — the REPL, your scripts, the OS globals — shares **one QuickJS global context**. This means:

- Variables you define in the REPL (`var x = 5`) persist for the session
- Scripts loaded with `run()` see all REPL globals and vice versa
- `kernel`, `fs`, `sys`, `ls`, `cd`, `cat`, `disk`, etc. are all on `globalThis`
- `console.log` → terminal output everywhere

This is intentional: the REPL IS the runtime. There's no isolation boundary between "user code" and "OS code" in the primary runtime. For true isolation, use `kernel.procCreate()` to spawn a child QuickJS runtime.

---


## 8. Capabilities

| Capability | Detail |
|---|---|
| Display | VGA text 80×25 (fallback) + VESA 32-bit framebuffer (default) |
| Graphics | Pixel Canvas in TypeScript; 8×8 bitmap font; window compositing |
| Mouse | PS/2 relative motion + buttons wired into WM event loop |
| Persistent storage | ATA PIO + FAT32/FAT16; survives reboots |
| Networking | virtio-net → TCP/IP → TLS 1.3 → HTTP/HTTPS, all in TypeScript |
| Memory | Physical page bitmap allocator + hardware paging (CR3, CR4.PSE) |
| Multitasking | Kernel threads, mutex/condvar, fork/exec/waitpid, signals, ELF loader |
| Multi-process | 8 isolated QuickJS runtimes with message-passing and shared memory |
| JS heap | 256 MB BSS (QEMU `-m 256` recommended) |
| `Promise` / async | Cooperative scheduler pumps the job queue at yield points |

---

## 9. Adding a New Kernel Function

1. **Write the C function** in `quickjs_binding.c`:
```c
static JSValue js_kernel_myfunc(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    // do hardware thing
    return JS_NewInt32(ctx, result);
}
```

2. **Register it** in `js_kernel_funcs[]`:
```c
JS_CFUNC_DEF("myFunc", 1, js_kernel_myfunc),
```

4. **Add the TypeScript type** in `src/os/core/kernel.ts`:
```typescript
export interface KernelAPI {
  // ...existing...
  myFunc(arg: number): number;
}
```

5. **Expose it as a global** (optional) via `registerCommands` in `src/os/ui/commands.ts`:
```typescript
g.myFunc = function(arg: number) {
  var result = kernel.myFunc(arg);
  terminal.println('result: ' + result);
};
```

6. `npm run build` — Docker rebuilds everything.
