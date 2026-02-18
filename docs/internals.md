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
    memory_initialize();     // heap allocator
    gdt_flush();             // reload GDT (needed before IDT)
    irq_initialize();        // IDT + PIC remapping + enable interrupts
    timer_initialize(100);   // PIT at 100 Hz
    keyboard_initialize();   // PS/2 IRQ1 handler
    quickjs_initialize();    // QuickJS runtime + context + kernel.* globals
    quickjs_run_os();        // JS_Eval(embedded_js_code)
    // if JS returns, halt
    __asm__ volatile("cli; hlt");
}
```

---

## 3. Hardware Drivers

### Terminal (`terminal.c`)
Writes directly to the VGA text buffer at physical address `0xB8000`.  
Each character cell is 2 bytes: `[colour_byte][ascii_byte]`.  
The colour byte is `(bg << 4) | fg` where fg/bg are 4-bit VGA colour indices.

Key operations:
- `terminal_putchar(c)` — write char at cursor, scroll if at bottom
- `terminal_setcolor_fg_bg(fg, bg)` — set global colour byte
- `terminal_clear()` — fill with spaces at current colour
- `terminal_set_cursor(row, col)` — update hardware cursor via I/O ports `0x3D4`/`0x3D5`

### Memory (`memory.c`)
A simple two-stage allocator:
1. **Bump allocator** for the initial heap (past the kernel BSS end)
2. **Free list** for subsequent allocations

The heap start is determined by `_kernel_end` from the linker script. QuickJS gets 768 KB allocated up front via `JS_SetMemoryLimit`.

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
Each IRQ0 fires every 10 ms, incrementing a global `ticks` counter.

`timer_sleep(ms)` busy-waits on the tick counter:
```c
uint32_t target = ticks + (ms / 10);
while (ticks < target) __asm__ volatile("hlt");
```

### IRQ (`irq.c` + `irq_asm.s`)
Sets up the x86 IDT (Interrupt Descriptor Table) with 256 entries.  
Remaps the PIC (Programmable Interrupt Controller) to IRQ vectors 0x20–0x2F (above CPU exceptions 0x00–0x1F).  
Assembly stubs push a common frame and call `irq_handler(regs)` in C.

---

## 4. QuickJS Binding (`quickjs_binding.c`)

### Runtime Setup
```c
int quickjs_initialize(void) {
    rt = JS_NewRuntime();
    JS_SetMemoryLimit(rt, 768 * 1024);   // 768 KB JS heap
    JS_SetMaxStackSize(rt, 32 * 1024);   // 32 KB stack
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

### Step 1: Babel transpilation

`scripts/bundle-hybrid.js` uses Babel programmatically:
```js
const result = await babel.transformAsync(combined_source, {
  presets: [
    ['@babel/preset-env', { targets: 'defaults' }],  // → ES5
    '@babel/preset-typescript',
  ],
  plugins: [
    '@babel/plugin-transform-class-properties',
    '@babel/plugin-transform-private-methods',
    // ...
  ]
})
```

TypeScript's `const enum` values (like `Color.LIGHT_GREEN`) are **inlined** at compile time by `@babel/preset-typescript` — they become integer literals in the output, no `Color` object exists at runtime.

### Step 2: esbuild bundling

After Babel, esbuild combines all modules into a single IIFE:
```js
(function() {
  // ... all OS code ...
  main();
})();
```

No `import`/`export` remains. Tree-shaking removes unused code.

### Step 3: JS embedding

`scripts/embed-js.sh` produces `src/kernel/embedded_js.h`:
```bash
echo 'const char embedded_js_code[] = ' > embedded_js.h
cat build/bundle.js | python3 -c "
import sys, json
data = sys.stdin.read()
sys.stdout.write(json.dumps(data))
" >> embedded_js.h
echo ';' >> embedded_js.h
```

The result is a C string literal with all special characters escaped. It's included by `quickjs_binding.c`:
```c
#include "embedded_js.h"
// embedded_js_code is now available as a C string
```

---

## 6. TypeScript OS Layer

### Module structure

All modules use ES module syntax (`import`/`export`) which esbuild resolves at bundle time.

```
main.ts          ──imports──▶  repl.ts
                 ──imports──▶  terminal.ts
                 ──imports──▶  filesystem.ts
                 ──imports──▶  system.ts
                 ──imports──▶  kernel.ts  (types only)
repl.ts          ──imports──▶  terminal.ts
                 ──imports──▶  filesystem.ts
                 ──imports──▶  kernel.ts  (types only)
```

`kernel.ts` exports only types and `const enum` — it produces no runtime JavaScript.

### `terminal.ts`

Provides typed wrappers over `kernel.setColor` / `kernel.print`:
```typescript
colorPrint(msg: string, color: Color): void
colorPrintln(msg: string, color: Color): void
println(msg: string): void
```

The saved-and-restored colour pattern ensures each call is colour-safe:
```typescript
colorPrint(msg: string, color: Color): void {
  var saved = kernel.getColor();
  kernel.setColor(color, Color.BLACK);
  kernel.printRaw(msg);
  kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
}
```

### `filesystem.ts`

`FileSystem` class with a `Map`-based tree:
```typescript
class FileSystem {
  private root: DirectoryEntry;   // { children: Map<name, Entry> }
  private currentPath: string;

  resolvePath(input: string): string { /* handles ~, .., relative */ }
  private navigate(path: string): DirectoryEntry | null { /* tree walk */ }
  readFile(path: string): string | null { /* … */ }
  writeFile(path: string, content: string): boolean { /* … */ }
  // ... all operations
}
```

All file operations resolve the path, navigate to the parent directory, then operate on the leaf node.

### `system.ts`

`SystemManager` class maintains a `Map<number, ProcessDescriptor>`:
```typescript
class SystemManager {
  private processes = new Map<number, ProcessDescriptor>();
  private nextProcessId = 1;

  constructor() {
    // Pre-populate: kernel (PID 1), init (PID 2)
  }
  createProcess(name, options?): ProcessDescriptor | null
  terminateProcess(pid): boolean   // PID 1 (kernel) is protected
  getProcessList(): ProcessDescriptor[]
  panic(message): void             // White-on-red screen + halt
}
```

Processes are entirely in-memory metadata — there's no real scheduler.

### `repl.ts`

The REPL is a pure event loop:
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

`evalAndPrint` uses a two-pass strategy:
1. Wrap in IIFE → `(function(){ var __r=(CODE); return ... })()`
2. If QuickJS returns `"SyntaxError: ..."` → re-eval as a statement directly

This lets `2 + 2` return `4`, while `var x = 5` works silently (statements don't return values).

---

## 7. Global Context Architecture

Everything in JSOS — the REPL, your scripts, the OS globals — shares **one QuickJS global context**. This means:

- Variables you define in the REPL (`var x = 5`) persist for the session
- Scripts loaded with `run()` see all REPL globals and vice versa
- `kernel`, `fs`, `sys`, `ls`, `cd`, `cat`, etc. are all on `globalThis`
- `console.log` → `kernel.print` everywhere

This is intentional: the REPL IS the runtime. There's no isolation boundary between "user code" and "OS code".

---

## 8. Constraints and Limitations

| Constraint | Detail |
|---|---|
| No `setTimeout` / `setInterval` | QuickJS event loop not running — halted in readline |
| No `Promise` await (in practice) | Promises would resolve but `.then` never fires without event loop ticks |
| No dynamic `import()` | All modules bundled at build time |
| No disk I/O | Filesystem is RAM-only |
| No networking | No NIC driver |
| No floating-point display | `math_impl.c` provides `sin/cos/sqrt` but `printf` FP formatting not fully working |
| 768 KB JS heap max | QuickJS hard limit — large allocations will throw `InternalError: out of memory` |
| 80×25 VGA text only | No graphics mode |
| 32 MB physical RAM | QEMU default; can increase with `-m` but allocator doesn't use all of it |

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

3. **Add the TypeScript type** in `src/os/kernel.ts`:
```typescript
export interface KernelAPI {
  // ...existing...
  myFunc(arg: number): number;
}
```

4. **Expose it as a global** (optional) in `src/os/main.ts :: setupGlobals()`:
```typescript
g.myFunc = function(arg: number) {
  var result = kernel.myFunc(arg);
  terminal.println('result: ' + result);
};
```

5. `npm run build` — Docker rebuilds everything.
