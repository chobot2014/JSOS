/*
 * JSOS QuickJS Binding Layer  Platform Edition
 *
 * Exposes raw hardware primitives to JavaScript via QuickJS.
 * The global `kernel` object covers:
 *   VGA raw cell access, hardware cursor, keyboard, timer, memory,
 *   port I/O, native call trampoline, eval, halt/reboot.
 *
 * All higher-level behaviour (terminal emulation, scrollback, readline,
 * colour tracking) is implemented entirely in TypeScript/JavaScript.
 */

#include "quickjs.h"
#include "platform.h"
#include "keyboard.h"
#include "mouse.h"
#include "timer.h"
#include "io.h"
#include "embedded_js.h"
#include "ata.h"
#include "virtio_net.h"
#include "jit.h"
#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* Static ATA sector buffer: 8 sectors × 256 words = 4 KB on BSS, not stack */
static uint16_t ata_sector_buf[256 * 8];

/* ── Paging support (Phase 4) ──────────────────────────────────────────── */
/*
 * A 4 KB-aligned page directory stored in BSS.
 * TypeScript fills PDEs via js_set_page_entry(); js_enable_paging() then
 * loads CR3 with its physical address and sets CR0.PG.
 */
static uint32_t __attribute__((aligned(4096))) paging_pd[1024];

/* The multiboot2 boot-info pointer saved by boot.s */
extern uint32_t _multiboot2_ptr;

static JSRuntime *rt  = NULL;
static JSContext *ctx = NULL;

/* ── Phase 10: Multi-process pool ─────────────────────────────────────────
 * Each slot is an independent QuickJS runtime (separate GC, heap, globals).
 * Up to 8 concurrent child processes; up to 1 GB heap each (JS_SetMemoryLimit soft cap;
 * no pre-allocation — pages come from the shared 2 GB NOLOAD _sbrk window lazily).
 * IPC is done via ring-buffer message queues in BSS (parent ↔ child).
 */
#define JSPROC_MAX       8
#define JSPROC_MSGSLOTS  8
#define JSPROC_MSGSIZE   2048

typedef struct { char data[JSPROC_MSGSIZE]; int len; } ProcMsg_t;

typedef struct {
    JSRuntime  *rt;
    JSContext  *ctx;
    uint8_t     used;
    uint32_t    width, height;    /* render surface dimensions set by procSetDimensions */
    /* parent → child */
    ProcMsg_t   inbox[JSPROC_MSGSLOTS];
    int         inbox_r, inbox_w, inbox_cnt;
    /* child → parent */
    ProcMsg_t   outbox[JSPROC_MSGSLOTS];
    int         outbox_r, outbox_w, outbox_cnt;
} JSProc_t;

static JSProc_t _procs[JSPROC_MAX];
static int      _cur_proc = -1;   /* -1 = main runtime; ≥0 = child slot index */

/* Pending JIT request from a child runtime — stored by _jit_hook_child,
 * consumed by js_proc_pending_jit() from the TypeScript tick loop.
 * Declared early because js_proc_create / js_proc_destroy reference it.     */
typedef struct {
    uint32_t bc_addr;   /* physical address of JSFunctionBytecode, 0 = none  */
    int      pending;   /* 1 if a compilation request is outstanding          */
} JITProcPending_t;
static JITProcPending_t _jit_proc_pending[JSPROC_MAX];

/* Forward declaration — defined in the Step-5 block below (~line 1880).
 * Called from js_proc_create which is compiled before that block. */
#ifdef JSOS_JIT_HOOK
extern void JS_SetJITHook(JSRuntime *rt,
    int (*hook)(JSRuntime *, JSContext *, void *, void *, int));
static int _jit_hook_child(JSRuntime *rt, JSContext *hook_ctx,
                            void *bc_ptr, void *sp, int argc);
#endif

/* ── Phase A: Per-app BSS render surfaces (3 MB each = 1024×768 @ 32bpp) ──
 * Stable BSS address — both main and child runtimes see the same bytes.
 * Exposed via getRenderBuffer() (child) / getProcRenderBuffer(id) (main). */
#define RENDER_BUF_BYTES  (3 * 1024 * 1024)
static uint8_t _app_render_bufs[JSPROC_MAX][RENDER_BUF_BYTES] __attribute__((aligned(4096)));

/* ── Phase B3: Per-child timer state ─────────────────────────────────────
 * Callbacks stored as DupValue'd JSValues; freed safely in procDestroy. */
#define MAX_TIMERS  32
typedef struct {
    uint32_t id;          /* timer handle returned to JS */
    uint32_t interval_ms; /* delay (setTimeout) or period (setInterval) in ms */
    uint32_t due_ticks;   /* PIT tick count when callback fires */
    int      repeat;      /* 1 = interval, 0 = timeout */
    int      active;      /* 0 = slot free */
    JSValue  cb;          /* JS callback DupValue'd from child ctx */
} ProcTimer_t;
static ProcTimer_t _proc_timers[JSPROC_MAX][MAX_TIMERS];
static uint32_t    _proc_timer_next_id[JSPROC_MAX]; /* monotonic ID per slot */

/* ── Phase B4: Per-child event inbox (keyboard/mouse events as JSON) ──── */
#define PROC_EVENT_QUEUE_SLOTS  16
#define PROC_EVENT_SLOT_BYTES   256
typedef struct { char data[PROC_EVENT_SLOT_BYTES]; int used; } ProcEventSlot_t;
typedef struct {
    ProcEventSlot_t slots[PROC_EVENT_QUEUE_SLOTS];
    int             head, tail, count;
} ProcEventQueue_t;
static ProcEventQueue_t _proc_event_queues[JSPROC_MAX];

/* ── Phase B6: Per-child window command outbox (child→WM JSON messages) ── */
#define PROC_WINCMD_SLOTS  8
#define PROC_WINCMD_SIZE   256
typedef struct { char data[PROC_WINCMD_SIZE]; int len; } ProcWinCmd_t;
typedef struct { ProcWinCmd_t slots[PROC_WINCMD_SLOTS]; int r, w, cnt; } ProcWinCmdBuf_t;
static ProcWinCmdBuf_t _proc_wincmds[JSPROC_MAX];

/* ── Phase B2: FS bridge ─────────────────────────────────────────────────
 * Main runtime registers a JS object with readFile/writeFile/readDir/exists/stat
 * methods via kernel.registerChildFSBridge(obj).  Child-side FS calls invoke
 * those TS callbacks through the stable main-runtime context pointer `ctx'. */
static JSValue _fs_bridge_obj; /* initialised to JS_UNDEFINED in quickjs_initialize() */

/* ── Phase 10: Shared memory buffers ──────────────────────────────────────
 * Static BSS slabs mapped as ArrayBuffers into any runtime that calls
 * sharedBufferOpen(id).  Because the memory is BSS (stable address, never
 * moved by QuickJS GC), both parent and child see the same physical bytes
 * with zero serialisation overhead.
 */
#define SHARED_BUF_MAX    8
#define SHARED_BUF_BYTES  (256 * 1024)   /* 256 KB per slot; 8 slots = 2 MB BSS */

static uint8_t  _sbufs[SHARED_BUF_MAX][SHARED_BUF_BYTES] __attribute__((aligned(4096)));
static uint8_t  _sbuf_used[SHARED_BUF_MAX];
static uint32_t _sbuf_sizes[SHARED_BUF_MAX];

/* No-op free: BSS is never heap-freed — QuickJS must not touch the pointer. */
static void _sbuf_no_free(JSRuntime *rt, void *opaque, void *ptr) {
    (void)rt; (void)opaque; (void)ptr;
}

/* ── Phase 10: Time-slice interrupt handler ──────────────────────────────
 * Set on every child runtime.  When _proc_slice_deadline is non-zero and
 * the PIT tick counter reaches it, QuickJS throws "InternalError: interrupted"
 * which procEvalSlice() catches and returns as "timeout".
 */
static volatile uint32_t _proc_slice_deadline = 0;   /* 0 = disabled */

static int _proc_interrupt_cb(JSRuntime *rt, void *opaque) {
    (void)rt; (void)opaque;
    if (_proc_slice_deadline == 0) return 0;
    return (timer_get_ticks() >= _proc_slice_deadline) ? 1 : 0;
}

/*  VGA raw access  */

static JSValue js_vga_put(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t row = 0, col = 0, color = 0x07;
    JS_ToInt32(c, &row, argv[0]);
    JS_ToInt32(c, &col, argv[1]);
    const char *ch = JS_ToCString(c, argv[2]);
    if (argc > 3) JS_ToInt32(c, &color, argv[3]);
    platform_vga_put(row, col, (ch && ch[0]) ? ch[0] : ' ', (uint8_t)color);
    if (ch) JS_FreeCString(c, ch);
    return JS_UNDEFINED;
}

static JSValue js_vga_get(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t row = 0, col = 0;
    JS_ToInt32(c, &row, argv[0]);
    JS_ToInt32(c, &col, argv[1]);
    return JS_NewInt32(c, (int32_t)platform_vga_get(row, col));
}

static JSValue js_vga_draw_row(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t row = 0, color = 0x07;
    JS_ToInt32(c, &row, argv[0]);
    const char *text = JS_ToCString(c, argv[1]);
    if (argc > 2) JS_ToInt32(c, &color, argv[2]);
    platform_vga_draw_row(row, text, (uint8_t)color);
    if (text) JS_FreeCString(c, text);
    return JS_UNDEFINED;
}

static JSValue js_vga_copy_row(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t dst = 0, src = 0;
    JS_ToInt32(c, &dst, argv[0]);
    JS_ToInt32(c, &src, argv[1]);
    platform_vga_copy_row(dst, src);
    return JS_UNDEFINED;
}

static JSValue js_vga_fill_row(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t row = 0, color = 0x07;
    JS_ToInt32(c, &row, argv[0]);
    const char *ch = JS_ToCString(c, argv[1]);
    if (argc > 2) JS_ToInt32(c, &color, argv[2]);
    platform_vga_fill_row(row, (ch && ch[0]) ? ch[0] : ' ', (uint8_t)color);
    if (ch) JS_FreeCString(c, ch);
    return JS_UNDEFINED;
}

static JSValue js_vga_fill(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t color = 0x07;
    char ch_val = ' ';
    if (argc > 0) {
        const char *s = JS_ToCString(c, argv[0]);
        if (s) { ch_val = s[0]; JS_FreeCString(c, s); }
    }
    if (argc > 1) JS_ToInt32(c, &color, argv[1]);
    platform_vga_fill(ch_val, (uint8_t)color);
    return JS_UNDEFINED;
}

static JSValue js_vga_set_cursor(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t row = 0, col = 0;
    JS_ToInt32(c, &row, argv[0]);
    JS_ToInt32(c, &col, argv[1]);
    platform_cursor_set(row, col);
    return JS_UNDEFINED;
}

static JSValue js_vga_hide_cursor(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    platform_cursor_hide(); return JS_UNDEFINED;
}
static JSValue js_vga_show_cursor(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    platform_cursor_show(); return JS_UNDEFINED;
}

static JSValue js_get_screen_size(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "width",  JS_NewInt32(c, platform_vga_width()));
    JS_SetPropertyStr(c, obj, "height", JS_NewInt32(c, platform_vga_height()));
    return obj;
}

/*  Keyboard 
 * readKey()   non-blocking poll
 * waitKey()   blocking regular char
 * waitKeyEx() blocking {ch, ext}  ext!=0 for special keys
 * hasKey()    bool
 */

static JSValue js_read_key(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    char ch = keyboard_poll();
    if (!ch) return JS_NewString(c, "");
    char buf[2] = { ch, 0 };
    return JS_NewString(c, buf);
}

/**
 * readKeyEx() — non-blocking; checks extended-key slot first, then char buffer.
 * Returns {ch, ext} or JS_NULL when nothing is queued.
 * Use this in event loops (WM tick) instead of readKey() so arrow keys work.
 */
static JSValue js_read_key_ex(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int ext = keyboard_get_extended();
    if (ext != 0) {
        JSValue obj = JS_NewObject(c);
        JS_SetPropertyStr(c, obj, "ch",  JS_NewString(c, ""));
        JS_SetPropertyStr(c, obj, "ext", JS_NewInt32(c, ext));
        return obj;
    }
    char ch = keyboard_poll();
    if (ch) {
        char buf[2] = { ch, 0 };
        JSValue obj = JS_NewObject(c);
        JS_SetPropertyStr(c, obj, "ch",  JS_NewString(c, buf));
        JS_SetPropertyStr(c, obj, "ext", JS_NewInt32(c, 0));
        return obj;
    }
    return JS_NULL;
}

static JSValue js_wait_key(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    char ch = keyboard_getchar();
    char buf[2] = { ch, 0 };
    return JS_NewString(c, buf);
}

static JSValue js_wait_key_ex(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    for (;;) {
        int ext = keyboard_get_extended();
        if (ext != 0) {
            JSValue obj = JS_NewObject(c);
            JS_SetPropertyStr(c, obj, "ch",  JS_NewString(c, ""));
            JS_SetPropertyStr(c, obj, "ext", JS_NewInt32(c, ext));
            return obj;
        }
        if (keyboard_has_key()) {
            char ch = keyboard_poll();
            char buf[2] = { ch, 0 };
            JSValue obj = JS_NewObject(c);
            JS_SetPropertyStr(c, obj, "ch",  JS_NewString(c, buf));
            JS_SetPropertyStr(c, obj, "ext", JS_NewInt32(c, 0));
            return obj;
        }
        __asm__ volatile ("hlt");
    }
}

static JSValue js_has_key(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewBool(c, keyboard_has_key());
}

/*  Timer */

static JSValue js_get_ticks(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewInt32(c, (int32_t)timer_get_ticks());
}
static JSValue js_get_uptime(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewInt32(c, (int32_t)timer_get_ms());
}
/* Forward-declared here so js_sleep() can call the scheduler hook on every
 * tick during its busy-wait.  The actual storage lives further down in the
 * Phase-5 section near js_register_scheduler_hook().                        */
static JSValue _scheduler_hook;
static JSValue js_sleep(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t ms = 0; JS_ToInt32(c, &ms, argv[0]);
    uint32_t target    = timer_get_ms() + (uint32_t)ms;
    uint32_t last_tick = timer_get_ticks();
    while (timer_get_ms() < target) {
        uint32_t now = timer_get_ticks();
        if (now != last_tick) {
            last_tick = now;
            /* Cooperatively yield to the TypeScript scheduler on each tick. */
            if (!JS_IsUndefined(_scheduler_hook)) {
                JSValue r = JS_Call(c, _scheduler_hook, JS_UNDEFINED, 0, NULL);
                JS_FreeValue(c, r);
            }
        }
        __asm__ volatile ("hlt");
    }
    return JS_UNDEFINED;
}

/*  Memory  */

static JSValue js_mem_info(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    JSMemoryUsage stats;
    JS_ComputeMemoryUsage(rt, &stats);
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "total", JS_NewInt32(c, (int32_t)stats.malloc_limit));
    JS_SetPropertyStr(c, obj, "used",  JS_NewInt32(c, (int32_t)stats.malloc_size));
    JS_SetPropertyStr(c, obj, "free",  JS_NewInt32(c, (int32_t)(stats.malloc_limit - stats.malloc_size)));
    return obj;
}

/*  Port I/O  */

static JSValue js_inb(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t port = 0; JS_ToInt32(c, &port, argv[0]);
    return JS_NewInt32(c, inb((uint16_t)port));
}
static JSValue js_outb(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t port = 0, val = 0;
    JS_ToInt32(c, &port, argv[0]); JS_ToInt32(c, &val, argv[1]);
    outb((uint16_t)port, (uint8_t)val); return JS_UNDEFINED;
}

/*  Native code execution 
 * callNative(addr)              call void fn() at memory address
 * callNativeI(addr,a0,a1,a2)   call int fn(int,int,int), returns int
 * readMem8(addr)                read one byte from physical address
 * writeMem8(addr, byte)         write one byte to physical address
 */

static JSValue js_call_native(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t addr = 0; JS_ToInt32(c, &addr, argv[0]);
    if (!addr) return JS_UNDEFINED;
    typedef void (*fn_t)(void);
    ((fn_t)(uintptr_t)(uint32_t)addr)();
    return JS_UNDEFINED;
}

static JSValue js_call_native_i(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    int32_t addr = 0, a0 = 0, a1 = 0, a2 = 0;
    JS_ToInt32(c, &addr, argv[0]);
    if (argc > 1) JS_ToInt32(c, &a0, argv[1]);
    if (argc > 2) JS_ToInt32(c, &a1, argv[2]);
    if (argc > 3) JS_ToInt32(c, &a2, argv[3]);
    if (!addr) return JS_NewInt32(c, 0);
    typedef int32_t (*fn_t)(int32_t, int32_t, int32_t);
    return JS_NewInt32(c, ((fn_t)(uintptr_t)(uint32_t)addr)(a0, a1, a2));
}

static JSValue js_read_mem8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t addr = 0;
    JS_ToInt32(c, (int32_t *)&addr, argv[0]);
    return JS_NewInt32(c, *(volatile uint8_t *)(uintptr_t)addr);
}

static JSValue js_write_mem8(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint32_t addr = 0; int32_t val = 0;
    JS_ToInt32(c, (int32_t *)&addr, argv[0]);
    JS_ToInt32(c, &val, argv[1]);
    *(volatile uint8_t *)(uintptr_t)addr = (uint8_t)val;
    return JS_UNDEFINED;
}

/* ─ Physical memory bulk access (Step 2) ─────────────────────────────────── */

static void js_free_array_buffer(JSRuntime *rt, void *opaque, void *ptr) {
    (void)opaque; js_free_rt(rt, ptr);
}

/*
 * kernel.readPhysMem(addr, length) → ArrayBuffer | null
 * Copy `length` bytes from the physical address `addr` into a new ArrayBuffer.
 * Maximum length: 1 MB.  Returns null on bad arguments or allocation failure.
 */
static JSValue js_read_phys_mem(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NULL;
    uint32_t addr = 0, length = 0;
    JS_ToUint32(c, &addr,   argv[0]);
    JS_ToUint32(c, &length, argv[1]);
    if (length == 0 || length > (1024u * 1024u)) return JS_NULL;
    uint8_t *buf = js_malloc(c, length);
    if (!buf) return JS_NULL;
    memcpy(buf, (const void *)(uintptr_t)addr, length);
    return JS_NewArrayBuffer(c, buf, length, js_free_array_buffer, NULL, 0);
}

/*
 * kernel.writePhysMem(addr, data) — copy an ArrayBuffer to a physical address.
 * The caller is responsible for range-safety; no bounds checking is performed.
 */
static JSValue js_write_phys_mem(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    size_t len = 0;
    uint8_t *data = JS_GetArrayBuffer(c, &len, argv[1]);
    if (!data || len == 0) return JS_UNDEFINED;
    memcpy((void *)(uintptr_t)addr, data, len);
    return JS_UNDEFINED;
}

/* ─ QuickJS internal struct offsets probe (Step 3) ───────────────────────── */
/*
 * kernel.qjsOffsets() → { bcBuf, bcLen, argCount, varCount, stackSize,
 *                          cpoolPtr, cpoolCount, structSize,
 *                          callCount, jitNativePtr, funcName,
 *                          gcHeaderSize, objShape, objSize }
 *
 * Returns hardcoded offsets verified against the JSOS-patched QuickJS build
 * (JSFunctionBytecode after Step-5 additions: call_count @20, jit_native_ptr @24).
 * Used by qjs-jit.ts / QJSBytecodeReader to interpret live GC objects.
 */
static JSValue js_qjs_offsets(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue o = JS_NewObject(c);
    /* JSFunctionBytecode layout (post Step-5 patch, 32-bit i686):
     *   [0]  gc_header      4 B   (GCObjectHeader)
     *   [4]  realm          4 B   (JSContext*)
     *   [8]  shape          4 B   (JSShape*)       → objShape
     *  [12]  proto          8 B   (JSValue = tag+val) → objSize=12 for the pair
     *  [20]  call_count     4 B   (uint32_t)        ← NEW Step-5 field
     *  [24]  jit_native_ptr 4 B   (void*)           ← NEW Step-5 field
     *  [28]  byte_code_buf  4 B   (uint8_t*)        → bcBuf
     *  [32]  byte_code_len  4 B   (int)             → bcLen
     *  [36]  func_name      4 B   (JSAtom)          → funcName
     *  [40]  vardefs        4 B   (JSVarDef*)
     *  [44]  closure_var    4 B   (JSClosureVar*)
     *  [48]  arg_count      2 B   (uint16_t)        → argCount
     *  [50]  var_count      2 B   (uint16_t)        → varCount
     *  [52]  defined_arg_count 2 B
     *  [54]  stack_size     2 B   (uint16_t)        → stackSize
     *  [56]  closure_var_count 2 B
     *  [58]  cpool_count    2 B                      (small variant; full below)
     *  [60]  vardefs_count  2 B
     *  [62]  ic_count       2 B
     *  [64]  cpool          4 B   (JSValue*)        → cpoolPtr
     *  [68]  ic             4 B                     → cpoolCount slot (count at [58])
     *  [72]  source_len     4 B
     *  structSize: 96 bytes total (aligned to 16 B with trailing bitfields).  */
    JS_SetPropertyStr(c, o, "gcHeaderSize",  JS_NewUint32(c,  4));
    JS_SetPropertyStr(c, o, "objShape",      JS_NewUint32(c,  8));
    JS_SetPropertyStr(c, o, "objSize",       JS_NewUint32(c, 12));
    JS_SetPropertyStr(c, o, "callCount",     JS_NewUint32(c, 20));
    JS_SetPropertyStr(c, o, "jitNativePtr",  JS_NewUint32(c, 24));
    JS_SetPropertyStr(c, o, "bcBuf",         JS_NewUint32(c, 28));
    JS_SetPropertyStr(c, o, "bcLen",         JS_NewUint32(c, 32));
    JS_SetPropertyStr(c, o, "funcName",      JS_NewUint32(c, 36));
    JS_SetPropertyStr(c, o, "argCount",      JS_NewUint32(c, 48));
    JS_SetPropertyStr(c, o, "varCount",      JS_NewUint32(c, 50));
    JS_SetPropertyStr(c, o, "stackSize",     JS_NewUint32(c, 54));
    JS_SetPropertyStr(c, o, "cpoolPtr",      JS_NewUint32(c, 64));
    JS_SetPropertyStr(c, o, "cpoolCount",    JS_NewUint32(c, 58)); /* uint16 at [58] */
    JS_SetPropertyStr(c, o, "structSize",    JS_NewUint32(c, 96));
    return o;
}

/*  System  */

static JSValue js_halt(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    __asm__ volatile ("cli; hlt"); return JS_UNDEFINED;
}

static JSValue js_reboot(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    uint8_t good = 0x02;
    while (good & 0x02) good = inb(0x64);
    outb(0x64, 0xFE); return JS_UNDEFINED;
}

/*  Serial port  */

static JSValue js_serial_put(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *s = JS_ToCString(c, argv[0]);
    if (s) { platform_serial_puts(s); JS_FreeCString(c, s); }
    return JS_UNDEFINED;
}

static JSValue js_serial_getchar(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewInt32(c, platform_serial_getchar());
}

/*  Eval  */

static JSValue js_eval(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *code = JS_ToCString(c, argv[0]);
    if (!code) return JS_UNDEFINED;
    JSValue result = JS_Eval(c, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(c, code);
    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(c);
        const char *err = JS_ToCString(c, exc);
        JSValue ret = JS_NewString(c, err ? err : "Unknown error");
        if (err) JS_FreeCString(c, err);
        JS_FreeValue(c, exc);
        return ret;
    }
    const char *str = JS_ToCString(c, result);
    JSValue ret = JS_NewString(c, str ? str : "undefined");
    if (str) JS_FreeCString(c, str);
    JS_FreeValue(c, result);
    return ret;
}

/*  Function table  */
/* ── Framebuffer bindings ──────────────────────────────────────────── */

/*
 * kernel.fbInfo() → {width, height, pitch, bpp} | null
 * Returns null when no pixel framebuffer was negotiated by GRUB.
 */
static JSValue js_fb_info(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    fb_info_t fb;
    platform_fb_get_info(&fb);
    if (!fb.available) return JS_NULL;
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "width",  JS_NewInt32(c, (int32_t)fb.width));
    JS_SetPropertyStr(c, obj, "height", JS_NewInt32(c, (int32_t)fb.height));
    JS_SetPropertyStr(c, obj, "pitch",  JS_NewInt32(c, (int32_t)fb.pitch));
    JS_SetPropertyStr(c, obj, "bpp",    JS_NewInt32(c, (int32_t)fb.bpp));
    return obj;
}

/*
 * kernel.fbBlit(pixels, x, y, w, h)
 *
 * Fast path  (preferred): pixels is an ArrayBuffer / Uint32Array.buffer
 *   → JS_GetArrayBuffer() gives a raw C pointer; single platform_fb_blit() call.
 *
 * Slow/legacy path: pixels is a plain JS number[].
 *   → kept for compatibility but ~1000× slower; avoid in hot paths.
 */
static JSValue js_fb_blit(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 5) return JS_UNDEFINED;
    int32_t x = 0, y = 0, w = 0, h = 0;
    JS_ToInt32(c, &x, argv[1]);
    JS_ToInt32(c, &y, argv[2]);
    JS_ToInt32(c, &w, argv[3]);
    JS_ToInt32(c, &h, argv[4]);
    if (w <= 0 || h <= 0) return JS_UNDEFINED;

    int total = w * h;

    /* ── Fast path: ArrayBuffer → zero-copy blit ────────────────────────── */
    size_t byte_len = 0;
    uint8_t *ab_data = JS_GetArrayBuffer(c, &byte_len, argv[0]);
    if (ab_data) {
        /* Sanity: buffer must be large enough for w*h 32-bit pixels */
        if ((size_t)total * 4 <= byte_len)
            platform_fb_blit((const uint32_t *)ab_data, x, y, w, h);
        return JS_UNDEFINED;
    }

    /* ── Slow path: plain JS Array (legacy / fallback) ──────────────────── */
    static uint32_t fb_blit_buf[1024 * 768]; /* 3 MB in BSS */
    if (total > 1024 * 768) total = 1024 * 768;
    for (int i = 0; i < total; i++) {
        JSValue v = JS_GetPropertyUint32(c, argv[0], (uint32_t)i);
        uint32_t px = 0;
        JS_ToUint32(c, &px, v);
        JS_FreeValue(c, v);
        fb_blit_buf[i] = px;
    }
    platform_fb_blit(fb_blit_buf, x, y, w, h);
    return JS_UNDEFINED;
}

/* ── Volatile ASM ────────────────────────────────────────────────────────── */

/*
 * kernel.volatileAsm(hexBytes) — inject and execute raw x86 machine code.
 *
 * hexBytes: space/comma-separated hex bytes, e.g.
 *   "B8 2A 00 00 00 C3"   →  mov eax, 42; ret  → returns 42
 *
 * The code runs as a cdecl void* → uint32_t function in ring-0.
 * A static 4 KB buffer in BSS is used as the code page; on bare metal
 * all BSS is mapped execute-readable so no mprotect is needed.
 *
 * Returns the EAX value set by the code, or 0 on parse error.
 */
static int _hex_nibble(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static JSValue js_volatile_asm(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewInt32(c, 0);
    const char *hex = JS_ToCString(c, argv[0]);
    if (!hex) return JS_NewInt32(c, 0);

    /* Static code buffer in BSS — bare-metal: all pages are RWX */
    static uint8_t __attribute__((aligned(16))) _asm_buf[4096];

    int len = 0;
    const char *p = hex;
    while (*p && len < (int)sizeof(_asm_buf)) {
        /* skip whitespace, commas, semicolons */
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == ',' || *p == ';') p++;
        /* skip optional 0x / 0X prefix */
        if (*p == '0' && (*(p+1) == 'x' || *(p+1) == 'X')) p += 2;
        if (!*p) break;
        int hi = _hex_nibble(*p);
        if (hi < 0) { p++; continue; }   /* skip non-hex char */
        p++;
        int lo = _hex_nibble(*p);
        if (lo < 0) {
            _asm_buf[len++] = (uint8_t)hi;  /* single-nibble byte */
        } else {
            _asm_buf[len++] = (uint8_t)((hi << 4) | lo);
            p++;
        }
    }
    JS_FreeCString(c, hex);
    if (len == 0) return JS_NewInt32(c, 0);

    /* Execute — treats buffer as  uint32_t fn(void)  cdecl */
    typedef uint32_t (*asm_fn_t)(void);
    uint32_t result = ((asm_fn_t)(void *)_asm_buf)();
    return JS_NewUint32(c, result);
}

/* ── Phase 4 — Memory map ──────────────────────────────────────────────── */

/*
 * Multiboot2 tag layouts used by js_get_memory_map() / js_get_ram_bytes().
 * We redeclare them here to avoid pulling in platform.h tag structs
 * (and to keep this file's C dependencies minimal).
 */
typedef struct { uint32_t type; uint32_t size; } _mb2hdr_t;
typedef struct {
    uint32_t type;          /* 6 */
    uint32_t size;
    uint32_t entry_size;
    uint32_t entry_version;
} _mb2mmap_tag_t;
typedef struct {
    uint64_t base_addr;
    uint64_t length;
    uint32_t type;          /* 1=usable 2=reserved 3=ACPI 4=NVS 5=bad */
    uint32_t reserved;
} _mb2mmap_entry_t;

/*
 * Walk the multiboot2 memory map and return the highest physical address
 * among type-1 (usable) entries.  Returns 0 if the MBI is unavailable.
 * Used internally by js_get_ram_bytes() and js_get_memory_map().
 */
static uint32_t _mb2_max_usable_addr(void) {
    uint32_t mb2 = _multiboot2_ptr;
    if (!mb2) return 0;
    uint8_t *info = (uint8_t *)(uintptr_t)mb2;
    uint32_t total_size = *(uint32_t *)info;
    uint8_t *tag        = info + 8;
    uint8_t *end        = info + total_size;
    uint32_t max_addr   = 0;
    while (tag < end) {
        _mb2hdr_t *hdr = (_mb2hdr_t *)tag;
        if (hdr->type == 0) break;
        if (hdr->type == 6) {
            _mb2mmap_tag_t *mt = (_mb2mmap_tag_t *)tag;
            uint32_t esz = mt->entry_size;
            uint8_t *ep  = tag + sizeof(_mb2mmap_tag_t);
            uint8_t *ee  = tag + hdr->size;
            for (; ep + esz <= ee; ep += esz) {
                _mb2mmap_entry_t *e = (_mb2mmap_entry_t *)ep;
                if (e->type == 1 && (e->base_addr >> 32) == 0) {
                    uint32_t end_addr = (uint32_t)e->base_addr
                                      + (uint32_t)e->length;
                    if (end_addr > max_addr) max_addr = end_addr;
                }
            }
            break;
        }
        uint32_t sz = hdr->size;
        tag += (sz + 7) & ~7u;
    }
    return max_addr;
}

/*
 * kernel.getRamBytes() → number
 * Returns the highest usable physical address from the multiboot2 memory map.
 * For a 512 MB QEMU VM this is 0x20000000 (536870912).
 */
static JSValue js_get_ram_bytes(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewFloat64(c, (double)_mb2_max_usable_addr());
}

/*
 * kernel.getMemoryMap() → [{base,length,type}, ...]
 * Walks the multiboot2 memory-map tag and returns all entries as a JS array.
 * base / length are 32-bit (JS number) — high halves are baseHi / lenHi.
 */
static JSValue js_get_memory_map(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue arr = JS_NewArray(c);
    uint32_t mb2 = _multiboot2_ptr;
    if (!mb2) return arr;

    uint8_t *info = (uint8_t *)(uintptr_t)mb2;
    uint32_t total_size = *(uint32_t *)info;
    uint8_t *tag        = info + 8;
    uint8_t *end        = info + total_size;
    int idx = 0;

    while (tag < end) {
        _mb2hdr_t *hdr = (_mb2hdr_t *)tag;
        if (hdr->type == 0) break;           /* end tag */
        if (hdr->type == 6) {                /* memory map */
            _mb2mmap_tag_t *mt = (_mb2mmap_tag_t *)tag;
            uint32_t esz = mt->entry_size;
            uint8_t *ep  = tag + sizeof(_mb2mmap_tag_t);
            uint8_t *ee  = tag + hdr->size;
            for (; ep + esz <= ee; ep += esz) {
                _mb2mmap_entry_t *e = (_mb2mmap_entry_t *)ep;
                JSValue obj = JS_NewObject(c);
                JS_SetPropertyStr(c, obj, "base",
                    JS_NewFloat64(c, (double)(uint32_t)e->base_addr));
                JS_SetPropertyStr(c, obj, "baseHi",
                    JS_NewFloat64(c, (double)(uint32_t)(e->base_addr >> 32)));
                JS_SetPropertyStr(c, obj, "length",
                    JS_NewFloat64(c, (double)(uint32_t)e->length));
                JS_SetPropertyStr(c, obj, "lenHi",
                    JS_NewFloat64(c, (double)(uint32_t)(e->length >> 32)));
                JS_SetPropertyStr(c, obj, "type",
                    JS_NewInt32(c, (int32_t)e->type));
                JS_SetPropertyUint32(c, arr, (uint32_t)idx++, obj);
                JS_FreeValue(c, obj);
            }
            break;
        }
        uint32_t sz = hdr->size;
        tag += (sz + 7) & ~7u;
    }
    return arr;
}

/* ── Phase 4 — Paging primitives ───────────────────────────────────────── */

/*
 * kernel.setPDPT(physAddr) — write physAddr into CR3.
 * Flushes the entire TLB as a side-effect.
 */
static JSValue js_set_pdpt(JSContext *c, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val;
    uint32_t addr = 0;
    if (argc >= 1) JS_ToUint32(c, &addr, argv[0]);
    __asm__ volatile("mov %0, %%cr3" :: "r"(addr) : "memory");
    return JS_UNDEFINED;
}

/*
 * kernel.flushTLB() — re-write CR3 to itself, flushing all non-global TLB.
 */
static JSValue js_flush_tlb(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint32_t cr3;
    __asm__ volatile("mov %%cr3, %0" : "=r"(cr3));
    __asm__ volatile("mov %0, %%cr3" :: "r"(cr3) : "memory");
    return JS_UNDEFINED;
}

/*
 * kernel.setPageEntry(pdIdx, ptIdx, physAddr, flags)
 * Write one entry in the statically allocated page directory.
 *   flags bit 0x080 (PS) → 4 MB huge page (PDE only, ptIdx ignored).
 *   Otherwise, physAddr is treated as a page-table physical address (PDE)
 *   or a 4 KB frame address (PTE) — TypeScript decides which to fill.
 *
 * For Phase 4 we only use huge pages.
 */
static JSValue js_set_page_entry(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 4) return JS_UNDEFINED;
    uint32_t pdIdx = 0, ptIdx = 0, physAddr = 0, flags = 0;
    JS_ToUint32(c, &pdIdx,    argv[0]);
    JS_ToUint32(c, &ptIdx,    argv[1]);
    JS_ToUint32(c, &physAddr, argv[2]);
    JS_ToUint32(c, &flags,    argv[3]);
    (void)ptIdx;   /* only used when !PS -- Phase 5 adds small-page support */
    if (pdIdx >= 1024) return JS_UNDEFINED;
    if (flags & 0x080u) {
        /* 4 MB huge page: PDE = 4MB-aligned physAddr | flags */
        paging_pd[pdIdx] = (physAddr & 0xFFC00000u) | flags;
    } else {
        /* Small-page PDE: physAddr is the page-table physical address */
        paging_pd[pdIdx] = (physAddr & 0xFFFFF000u) | (flags & 0xFFFu);
    }
    return JS_UNDEFINED;
}

/*
 * kernel.enablePaging() → boolean
 * 1. Enables CR4.PSE (4 MB page support).
 * 2. Sets CR3 to the physical address of paging_pd.
 * 3. Sets CR0.PG.
 * Returns true on success, false if the page directory appears empty.
 */
static JSValue js_enable_paging(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    /* Sanity: PDE[0] must be present (should cover the kernel at ~1 MB) */
    if (!(paging_pd[0] & 1u)) return JS_FALSE;

    /* Enable PSE (4 MB pages) in CR4 */
    uint32_t cr4;
    __asm__ volatile("mov %%cr4, %0" : "=r"(cr4));
    cr4 |= 0x10u; /* CR4.PSE */
    __asm__ volatile("mov %0, %%cr4" :: "r"(cr4) : "memory");

    /* Load CR3 with page directory physical address */
    uint32_t pd_phys = (uint32_t)(uintptr_t)paging_pd;
    __asm__ volatile("mov %0, %%cr3" :: "r"(pd_phys) : "memory");

    /* Set CR0.PG — paging is now live */
    uint32_t cr0;
    __asm__ volatile("mov %%cr0, %0" : "=r"(cr0));
    cr0 |= 0x80000000u;
    __asm__ volatile("mov %0, %%cr0" :: "r"(cr0) : "memory");

    return JS_TRUE;
}

/* ── Phase 9: real process primitives ─────────────────────────────────── */

/*
 * Pool of user-space page directories.  Each is 4 KiB, 4 KiB-aligned.
 * We support up to 32 concurrent user address spaces.
 */
#define MAX_USER_PDS 32
static uint32_t _user_pds[MAX_USER_PDS][1024] __attribute__((aligned(4096)));
static uint8_t  _user_pd_used[MAX_USER_PDS];

/*
 * kernel.cloneAddressSpace() → number
 * Allocates a new page directory and copies all present huge-page PDEs from
 * the current kernel paging_pd.  Returns the physical address of the new PD
 * so TypeScript can pass it to kernel.setPDPT() when setting up the child
 * address space.
 * Phase 9: real eager-copy implementation.
 */
static JSValue js_clone_address_space(JSContext *c, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    /* Find a free slot */
    int slot = -1;
    for (int i = 0; i < MAX_USER_PDS; i++) {
        if (!_user_pd_used[i]) { slot = i; break; }
    }
    if (slot < 0) return JS_NewInt32(c, 0);   /* out of PD slots */

    _user_pd_used[slot] = 1;

    /* Eager copy: duplicate all present kernel PDEs (huge pages) */
    for (int i = 0; i < 1024; i++)
        _user_pds[slot][i] = paging_pd[i];

    uint32_t phys = (uint32_t)(uintptr_t)_user_pds[slot];
    return JS_NewInt32(c, (int32_t)phys);
}

/*
 * kernel.jumpToUserMode(eip, esp) → void
 * Loads user-mode data segments, builds a 5-word iret frame on the kernel
 * stack, and issues iret — transferring control to ring-3 at EIP:ESP.
 * Phase 9: real ring-3 transition.  Never returns.
 */
static JSValue js_jump_to_user_mode(JSContext *c, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)c; (void)this_val;
    uint32_t eip = 0, esp = 0;
    if (argc >= 1) JS_ToUint32(c, &eip, argv[0]);
    if (argc >= 2) JS_ToUint32(c, &esp, argv[1]);

    /* User selectors: 0x1B = 0x18|3 (code, RPL=3), 0x23 = 0x20|3 (data, RPL=3) */
    const uint32_t user_cs = 0x1B;
    const uint32_t user_ss = 0x23;

    /* Switch data segments to ring-3 before iret so that DS/ES/FS/GS are
     * all set to the user data selector inside the new ring-3 context.       */
    __asm__ volatile(
        "mov %0, %%ds\n\t"
        "mov %0, %%es\n\t"
        "mov %0, %%fs\n\t"
        "mov %0, %%gs\n\t"
        :: "r"(user_ss) : "memory"
    );

    /* Push iret frame: SS, ESP, EFLAGS(IF=1), CS, EIP then iret             */
    __asm__ volatile(
        "push %0\n\t"           /* user SS                                   */
        "push %1\n\t"           /* user ESP                                  */
        "pushf\n\t"             /* current EFLAGS → push                     */
        "orl  $0x200, (%%esp)\n\t" /* set IF (enable interrupts in ring-3)  */
        "push %2\n\t"           /* user CS (0x1B)                            */
        "push %3\n\t"           /* user EIP                                  */
        "iret\n\t"
        :: "r"(user_ss), "r"(esp), "r"(user_cs), "r"(eip)
        : "memory"
    );
    __builtin_unreachable();
    return JS_UNDEFINED;
}

/* ── Phase 7: virtio-net NIC bindings ──────────────────────────────────── */

/*
 * kernel.netInit() → boolean
 * Probe PCI for virtio-net, initialise TX/RX virtqueues.
 * Returns true when a NIC is found and ready.
 */
static JSValue js_net_init(JSContext *c, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewBool(c, virtio_net_init());
}

/* Reusable receive buffer in BSS (avoids large stack frame) */
static uint8_t _net_recv_buf[1514];
/* Reusable send buffer in BSS */
static uint8_t _net_send_buf[1514];

/*
 * kernel.netSendFrame(bytes: number[]) → void
 * Send a raw Ethernet frame (byte array from TypeScript).
 */
static JSValue js_net_send_frame(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    int32_t len = 0;
    {
        JSValue jlen = JS_GetPropertyStr(c, argv[0], "length");
        JS_ToInt32(c, &len, jlen);
        JS_FreeValue(c, jlen);
    }
    if (len <= 0 || len > 1514) return JS_UNDEFINED;
    /* Copy JS array into BSS send buffer */
    for (int i = 0; i < len; i++) {
        JSValue v = JS_GetPropertyUint32(c, argv[0], (uint32_t)i);
        int32_t b = 0;
        JS_ToInt32(c, &b, v);
        JS_FreeValue(c, v);
        _net_send_buf[i] = (uint8_t)b;
    }
    virtio_net_send(_net_send_buf, (uint16_t)len);
    return JS_UNDEFINED;
}

/*
 * kernel.netRecvFrame() → ArrayBuffer | null
 * Poll the NIC for one received Ethernet frame.
 * Returns an ArrayBuffer (fast path — single memcpy) or null when RX ring is empty.
 * Using ArrayBuffer instead of number[] eliminates ~1514 JS property assignments
 * per frame, reducing C↔JS overhead by ~1500× per received packet.
 */
static JSValue js_net_recv_frame(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint16_t frame_len = virtio_net_recv(_net_recv_buf);
    if (frame_len == 0) return JS_NULL;
    /* Single memcpy into a new ArrayBuffer — no per-byte JS property ops */
    return JS_NewArrayBufferCopy(c, _net_recv_buf, (size_t)frame_len);
}

/*
 * kernel.netMacAddress() → number[6]
 * Return the NIC's 6-byte MAC address as a JS number array.
 */
static JSValue js_net_mac_address(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue arr = JS_NewArray(c);
    for (int i = 0; i < 6; i++)
        JS_SetPropertyUint32(c, arr, (uint32_t)i,
                             JS_NewInt32(c, virtio_net_mac[i]));
    return arr;
}

static JSValue js_net_debug_rx_used_idx(JSContext *c, JSValueConst this_val,
                                         int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(c, (int32_t)virtio_net_rx_used_idx());
}

static JSValue js_net_debug_info(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(c, (int32_t)virtio_net_debug_info());
}

static JSValue js_net_debug_status(JSContext *c, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(c, (int32_t)virtio_net_debug_status());
}

static JSValue js_net_debug_queues(JSContext *c, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewInt32(c, (int32_t)virtio_net_debug_queues());
}

/*
 * kernel.netPciAddr() → string  (e.g. "00:03.0")
 * Returns the PCI bus:dev.fn string of the found NIC.
 */
static void _pci_hex2(char *p, uint8_t v) {
    const char *h = "0123456789abcdef";
    p[0] = h[v >> 4]; p[1] = h[v & 0xf];
}

static JSValue js_net_pci_addr(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    /* Format: "BB:DD.F" e.g. "00:03.0" */
    char buf[8];
    _pci_hex2(buf,   virtio_net_pci_bus);
    buf[2] = ':';
    _pci_hex2(buf+3, virtio_net_pci_dev);
    buf[5] = '.';
    buf[6] = (char)('0' + (virtio_net_pci_fn & 7));
    buf[7] = '\0';
    return JS_NewString(c, buf);
}

/*
 * kernel.getPageFaultAddr() → number
 * Reads CR2, which the CPU populates with the faulting linear address on a
 * page-fault exception (#14).  Safe to call at any time.
 */
static JSValue js_get_page_fault_addr(JSContext *c, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint32_t cr2;
    __asm__ volatile("mov %%cr2, %0" : "=r"(cr2));
    return JS_NewInt32(c, (int32_t)cr2);
}

/* ── Phase 5: scheduler hook + TSS ─────────────────────────────────── */

/*
 * The registered JS function is called cooperatively at yield points.
 * It is NOT called from the IRQ0 ISR directly (QuickJS is not re-entrant).
 * TypeScript's ThreadManager registers its tick() here so C can invoke it
 * in future phases via js_scheduler_tick() when proper per-thread C stacks
 * are in place.
 * (_scheduler_hook is forward-declared near js_sleep above.)
 */

static JSValue js_register_scheduler_hook(JSContext *c, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1 || !JS_IsFunction(c, argv[0])) return JS_UNDEFINED;
    if (!JS_IsUndefined(_scheduler_hook)) JS_FreeValue(c, _scheduler_hook);
    _scheduler_hook = JS_DupValue(c, argv[0]);
    return JS_UNDEFINED;
}

/* kernel.yield() — immediately invoke the TypeScript scheduler hook from a
 * safe JS context (i.e. not inside a C interrupt handler).  Call this at
 * known-safe points (top of WM loop, etc.) so the cooperative thread manager
 * gets a chance to run even without a sleep.                                 */
static JSValue js_yield(JSContext *c, JSValueConst this_val,
                        int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    if (!JS_IsUndefined(_scheduler_hook)) {
        JSValue r = JS_Call(c, _scheduler_hook, JS_UNDEFINED, 0, NULL);
        JS_FreeValue(c, r);
    }
    return JS_UNDEFINED;
}

/* kernel.schedTick() — returns the number of IRQ0 ticks that fired since the
 * last call and resets the counter to zero.  JS can poll this to decide when
 * to call kernel.yield() without a hard sleep.                               */
static JSValue js_sched_tick(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint32_t n = _preempt_counter;
    _preempt_counter = 0;
    return JS_NewUint32(c, n);
}

static JSValue js_tss_set_esp0(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    uint32_t addr = 0;
    if (argc > 0) JS_ToUint32(c, &addr, argv[0]);
    platform_tss_set_esp0(addr);
    return JS_UNDEFINED;
}

/* ── Mouse binding ─────────────────────────────────────────────────── */

/*
 * kernel.readMouse() → {dx, dy, buttons} | null
 * Returns null when the mouse packet queue is empty.
 */
static JSValue js_read_mouse(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    mouse_packet_t pkt;
    if (!mouse_read(&pkt)) return JS_NULL;
    JSValue obj = JS_NewObject(c);
    JS_SetPropertyStr(c, obj, "dx",      JS_NewInt32(c, (int32_t)pkt.dx));
    JS_SetPropertyStr(c, obj, "dy",      JS_NewInt32(c, (int32_t)pkt.dy));
    JS_SetPropertyStr(c, obj, "buttons", JS_NewInt32(c, (int32_t)pkt.buttons));
    return obj;
}
/* ── ATA block device bindings ─────────────────────────────────── */

static JSValue js_ata_present(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewBool(c, ata_present());
}

/* kernel.ataSectorCount() → number
 * Returns the total LBA28 addressable sector count from IDENTIFY.
 * Each sector is 512 bytes.  Returns 0 if no drive detected. */
static JSValue js_ata_sector_count(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewUint32(c, ata_sector_count());
}

static JSValue js_ata_read(JSContext *c, JSValueConst this_val,
                           int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_ThrowTypeError(c, "ataRead(lba, sectors)");
    uint32_t lba;
    int32_t  secs;
    if (JS_ToUint32(c, &lba,  argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32 (c, &secs, argv[1])) return JS_EXCEPTION;
    if (secs < 1 || secs > 8)
        return JS_ThrowRangeError(c, "sectors must be 1-8");

    if (ata_read28(lba, (uint8_t)secs, ata_sector_buf) != 0)
        return JS_NULL;

    /* Return as ArrayBuffer — single memcpy, no per-byte property assignments */
    int total = secs * 512;
    return JS_NewArrayBufferCopy(c, (const uint8_t *)ata_sector_buf, (size_t)total);
}

static JSValue js_ata_write(JSContext *c, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 3) return JS_ThrowTypeError(c, "ataWrite(lba, sectors, data)");
    uint32_t lba;
    int32_t  secs;
    if (JS_ToUint32(c, &lba,  argv[0])) return JS_EXCEPTION;
    if (JS_ToInt32 (c, &secs, argv[1])) return JS_EXCEPTION;
    if (secs < 1 || secs > 8)
        return JS_ThrowRangeError(c, "sectors must be 1-8");

    int total = secs * 512;
    uint8_t *bytes = (uint8_t *)ata_sector_buf;

    /* Fast path: Uint8Array / ArrayBuffer — single memcpy */
    size_t ab_len = 0;
    uint8_t *ab_data = JS_GetArrayBuffer(c, &ab_len, argv[2]);
    if (ab_data) {
        int copy = (int)ab_len < total ? (int)ab_len : total;
        memcpy(bytes, ab_data, (size_t)copy);
    } else {
        /* Slow path: plain JS number[] */
        for (int i = 0; i < total; i++) {
            JSValue v = JS_GetPropertyUint32(c, argv[2], (uint32_t)i);
            int32_t b = 0;
            JS_ToInt32(c, &b, v);
            JS_FreeValue(c, v);
            bytes[i] = (uint8_t)b;
        }
    }
    return JS_NewBool(c, ata_write28(lba, (uint8_t)secs, ata_sector_buf) == 0);
}

/* ── Phase 10: Child runtime IPC + parent management functions ──────────── */

/* Inside a child runtime: push a message to the parent outbox */
static JSValue js_proc_post_msg(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val;
    if (_cur_proc < 0 || _cur_proc >= JSPROC_MAX || !_procs[_cur_proc].used)
        return JS_FALSE;
    if (argc < 1) return JS_FALSE;
    JSProc_t *p = &_procs[_cur_proc];
    if (p->outbox_cnt >= JSPROC_MSGSLOTS) return JS_FALSE;
    const char *msg = JS_ToCString(c, argv[0]);
    if (!msg) return JS_FALSE;
    ProcMsg_t *slot = &p->outbox[p->outbox_w];
    int n = (int)strlen(msg);
    if (n >= JSPROC_MSGSIZE) n = JSPROC_MSGSIZE - 1;
    memcpy(slot->data, msg, (size_t)n);
    slot->data[n] = '\0';
    slot->len = n;
    JS_FreeCString(c, msg);
    p->outbox_w = (p->outbox_w + 1) % JSPROC_MSGSLOTS;
    p->outbox_cnt++;
    return JS_TRUE;
}

/* Inside a child runtime: receive a message from the parent inbox */
static JSValue js_proc_poll_msg(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    if (_cur_proc < 0 || _cur_proc >= JSPROC_MAX || !_procs[_cur_proc].used)
        return JS_NULL;
    JSProc_t *p = &_procs[_cur_proc];
    if (p->inbox_cnt == 0) return JS_NULL;
    ProcMsg_t *slot = &p->inbox[p->inbox_r];
    JSValue ret = JS_NewStringLen(c, slot->data, (size_t)slot->len);
    p->inbox_r = (p->inbox_r + 1) % JSPROC_MSGSLOTS;
    p->inbox_cnt--;
    return ret;
}

/* ── Shared buffer accessors (callable from both parent and child) ──────── */

/* kernel.sharedBufferOpen(id) → ArrayBuffer backed by BSS (zero-copy).
 * Works from any runtime — the same physical bytes are visible everywhere. */
static JSValue js_shared_buf_open(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= SHARED_BUF_MAX || !_sbuf_used[id]) return JS_NULL;
    return JS_NewArrayBuffer(c, _sbufs[id], (size_t)_sbuf_sizes[id],
                             _sbuf_no_free, NULL, 0);
}

/* kernel.sharedBufferSize(id) → byte length of the slot, or 0. */
static JSValue js_shared_buf_size(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewInt32(c, 0);
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= SHARED_BUF_MAX || !_sbuf_used[id]) return JS_NewInt32(c, 0);
    return JS_NewUint32(c, _sbuf_sizes[id]);
}

/* Forward declarations for child-only APIs defined later in this translation unit */
static JSValue js_child_get_render_buf(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_get_width(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_get_height(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_fs_read_file(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_fs_write_file(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_fs_read_dir(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_fs_exists(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_fs_stat(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_set_timeout(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_clear_timeout(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_set_interval(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_clear_interval(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_poll_event(JSContext *, JSValueConst, int, JSValueConst *);
static JSValue js_child_window_command(JSContext *, JSValueConst, int, JSValueConst *);

/* Minimal kernel API exposed inside child runtimes */
static const JSCFunctionListEntry js_child_kernel_funcs[] = {
    JS_CFUNC_DEF("serialPut",       1, js_serial_put),
    JS_CFUNC_DEF("getTicks",        0, js_get_ticks),
    JS_CFUNC_DEF("getUptime",       0, js_get_uptime),
    JS_CFUNC_DEF("sleep",           1, js_sleep),
    JS_CFUNC_DEF("getMemoryInfo",   0, js_mem_info),
    JS_CFUNC_DEF("postMessage",     1, js_proc_post_msg),
    JS_CFUNC_DEF("pollMessage",     0, js_proc_poll_msg),
    /* Shared memory — same physical bytes as parent */
    JS_CFUNC_DEF("sharedBufferOpen", 1, js_shared_buf_open),
    JS_CFUNC_DEF("sharedBufferSize", 1, js_shared_buf_size),
    /* Phase A/B: render surface + dimensions */
    JS_CFUNC_DEF("getRenderBuffer", 0, js_child_get_render_buf),
    JS_CFUNC_DEF("getWidth",        0, js_child_get_width),
    JS_CFUNC_DEF("getHeight",       0, js_child_get_height),
    /* Phase B2: FS bridge */
    JS_CFUNC_DEF("fsReadFile",        1, js_child_fs_read_file),
    JS_CFUNC_DEF("fsWriteFile",       2, js_child_fs_write_file),
    JS_CFUNC_DEF("fsReadDir",         1, js_child_fs_read_dir),
    JS_CFUNC_DEF("fsExists",          1, js_child_fs_exists),
    JS_CFUNC_DEF("fsStat",            1, js_child_fs_stat),
    /* Phase B3: timers */
    JS_CFUNC_DEF("setTimeout",      2, js_child_set_timeout),
    JS_CFUNC_DEF("clearTimeout",    1, js_child_clear_timeout),
    JS_CFUNC_DEF("setInterval",     2, js_child_set_interval),
    JS_CFUNC_DEF("clearInterval",   1, js_child_clear_interval),
    /* Phase B4: event queue */
    JS_CFUNC_DEF("pollEvent",       0, js_child_poll_event),
    /* Phase B6: window commands */
    JS_CFUNC_DEF("windowCommand",   1, js_child_window_command),
};

/* kernel.procCreate() → id (0-7) or -1 if all slots are occupied */
static JSValue js_proc_create(JSContext *c, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int id = -1;
    for (int i = 0; i < JSPROC_MAX; i++)
        if (!_procs[i].used) { id = i; break; }
    if (id < 0) return JS_NewInt32(c, -1);
    JSProc_t *p = &_procs[id];
    memset(p, 0, sizeof(*p));
    p->rt = JS_NewRuntime();
    if (!p->rt) return JS_NewInt32(c, -1);
    JS_SetMemoryLimit(p->rt, 1u * 1024u * 1024u * 1024u); /* 1 GB per child.
                                                    * Covers heavy tabs: Gmail, Google Docs,
                                                    * Maps, SPAs, video editors (100 MB–1 GB).
                                                    * Hard ceiling on 32-bit i686: x86 without
                                                    * PAE can only address ~3 GB physical RAM
                                                    * (4 GB minus ~1 GB MMIO/PCI hole at
                                                    * 0xC0000000). 1 GB/child is the practical
                                                    * maximum for a single runtime; true 4 GB+
                                                    * tabs require a 64-bit kernel.
                                                    * Heap window is 2 GB NOLOAD. In cooperative
                                                    * scheduling only 2-3 runtimes run at once
                                                    * (~1-1.3 GB real peak). If sbrk exhausts
                                                    * the window, that child gets ENOMEM —
                                                    * kernel continues unaffected. */
    JS_SetGCThreshold(p->rt, 256u * 1024u * 1024u); /* GC at 256 MB — keeps heap tidy during
                                                    * React/Vue reconciliation bursts without
                                                    * waiting until near the 1 GB wall. */
    JS_SetMaxStackSize(p->rt, 512 * 1024);        /* 512 KB — deep component trees (React,
                                                    * Angular), recursive HTML parser, deeply
                                                    * nested JS eval all need headroom. */
    p->ctx = JS_NewContext(p->rt);
    if (!p->ctx) { JS_FreeRuntime(p->rt); p->rt = NULL; return JS_NewInt32(c, -1); }
    /* Inject minimal child kernel API */
    JSValue global = JS_GetGlobalObject(p->ctx);
    JSValue kobj   = JS_NewObject(p->ctx);
    JS_SetPropertyFunctionList(p->ctx, kobj, js_child_kernel_funcs,
        sizeof(js_child_kernel_funcs) / sizeof(js_child_kernel_funcs[0]));
    JS_SetPropertyStr(p->ctx, global, "kernel", kobj);
    /* Inject console stub so child code can use console.log() */
    JS_Eval(p->ctx,
        "var console={log:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut(a.join(' '));},"
        "error:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut('[E] '+a.join(' '));},"
        "warn:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut('[W] '+a.join(' '));}}",
        strlen("var console={log:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut(a.join(' '));},"
        "error:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut('[E] '+a.join(' '));},"
        "warn:function(){var a=Array.prototype.slice.call(arguments);"
        "kernel.serialPut('[W] '+a.join(' '));}}"),
        "<boot>", JS_EVAL_TYPE_GLOBAL);
    /* Inject Date.now() using kernel uptime */
    JS_Eval(p->ctx,
        "var Date={now:function(){return kernel.getUptime();}}",
        strlen("var Date={now:function(){return kernel.getUptime();}}"),
        "<boot>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(p->ctx, global);
    /* Initialise per-proc BSS state */
    memset(&_proc_timers[id], 0, sizeof(_proc_timers[id]));
    memset(&_proc_event_queues[id], 0, sizeof(_proc_event_queues[id]));
    memset(&_proc_wincmds[id], 0, sizeof(_proc_wincmds[id]));
    _proc_timer_next_id[id] = 0;
    _procs[id].width  = 0;
    _procs[id].height = 0;
    /* Arm the time-slice interrupt handler on the child runtime.
     * _proc_interrupt_cb fires periodically during JS_Eval and returns 1
     * when _proc_slice_deadline (a PIT tick count) has been reached.       */
    JS_SetInterruptHandler(p->rt, _proc_interrupt_cb, NULL);
    /* Arm the JIT hook so hot functions in the child defer compilation to
     * the main-runtime tick loop (procPendingJIT / _serviceChildJIT).     */
#ifdef JSOS_JIT_HOOK
    JS_SetJITHook(p->rt, _jit_hook_child);
#endif
    /* Reset any leftover JIT allocation slab for this slot */
    jit_proc_reset(id);
    memset(&_jit_proc_pending[id], 0, sizeof(_jit_proc_pending[id]));
    p->used = 1;
    return JS_NewInt32(c, id);
}

/* kernel.procEval(id, code) → result string (or error string on exception) */
static JSValue js_proc_eval(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NewString(c, "undefined");
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used)
        return JS_NewString(c, "Error: invalid process id");
    const char *code = JS_ToCString(c, argv[1]);
    if (!code) return JS_NewString(c, "undefined");
    _cur_proc = id;
    JSValue result = JS_Eval(_procs[id].ctx, code, strlen(code),
                             "<process>", JS_EVAL_TYPE_GLOBAL);
    _cur_proc = -1;
    JS_FreeCString(c, code);
    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(_procs[id].ctx);
        const char *err = JS_ToCString(_procs[id].ctx, exc);
        JSValue ret = JS_NewString(c, err ? err : "Unknown error");
        if (err) JS_FreeCString(_procs[id].ctx, err);
        JS_FreeValue(_procs[id].ctx, exc);
        return ret;
    }
    if (JS_IsUndefined(result)) {
        JS_FreeValue(_procs[id].ctx, result);
        return JS_NewString(c, "undefined");
    }
    const char *str = JS_ToCString(_procs[id].ctx, result);
    JSValue ret = JS_NewString(c, str ? str : "undefined");
    if (str) JS_FreeCString(_procs[id].ctx, str);
    JS_FreeValue(_procs[id].ctx, result);
    return ret;
}

/* kernel.procTick(id) → number of pending async jobs executed */
static JSValue js_proc_tick(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewInt32(c, 0);
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_NewInt32(c, 0);
    _cur_proc = id;
    int count = 0;
    JSContext *job_ctx = NULL;
    while (JS_ExecutePendingJob(_procs[id].rt, &job_ctx) > 0 && count < 256) count++;
    _cur_proc = -1;
    return JS_NewInt32(c, count);
}

/* kernel.procSend(id, msg) → bool — push string message into child inbox */
static JSValue js_proc_send(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_FALSE;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_FALSE;
    JSProc_t *p = &_procs[id];
    if (p->inbox_cnt >= JSPROC_MSGSLOTS) return JS_FALSE;
    const char *msg = JS_ToCString(c, argv[1]);
    if (!msg) return JS_FALSE;
    ProcMsg_t *slot = &p->inbox[p->inbox_w];
    int n = (int)strlen(msg);
    if (n >= JSPROC_MSGSIZE) n = JSPROC_MSGSIZE - 1;
    memcpy(slot->data, msg, (size_t)n);
    slot->data[n] = '\0';
    slot->len = n;
    JS_FreeCString(c, msg);
    p->inbox_w = (p->inbox_w + 1) % JSPROC_MSGSLOTS;
    p->inbox_cnt++;
    return JS_TRUE;
}

/* kernel.procRecv(id) → string from child outbox, or null if empty */
static JSValue js_proc_recv(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_NULL;
    JSProc_t *p = &_procs[id];
    if (p->outbox_cnt == 0) return JS_NULL;
    ProcMsg_t *slot = &p->outbox[p->outbox_r];
    JSValue ret = JS_NewStringLen(c, slot->data, (size_t)slot->len);
    p->outbox_r = (p->outbox_r + 1) % JSPROC_MSGSLOTS;
    p->outbox_cnt--;
    return ret;
}

/* kernel.procDestroy(id) — free the child runtime and release the slot */
static JSValue js_proc_destroy(JSContext *c, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_UNDEFINED;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_UNDEFINED;
    /* Free timer callbacks BEFORE FreeContext so JSValues are still valid */
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (t->active) {
            JS_FreeValue(_procs[id].ctx, t->cb);
            t->active = 0;
        }
    }
    JS_FreeContext(_procs[id].ctx);
    JS_FreeRuntime(_procs[id].rt);
    _procs[id].ctx  = NULL;
    _procs[id].rt   = NULL;
    _procs[id].used = 0;
    /* Clear JIT slab + pending requests for this slot */
    _jit_proc_pending[id].pending = 0;
    _jit_proc_pending[id].bc_addr = 0;
    jit_proc_reset(id);
    /* Clear per-proc queues */
    memset(&_proc_event_queues[id], 0, sizeof(_proc_event_queues[id]));
    memset(&_proc_wincmds[id], 0, sizeof(_proc_wincmds[id]));
    return JS_UNDEFINED;
}

/* kernel.procAlive(id) → bool */
static JSValue js_proc_alive(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_FALSE;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX) return JS_FALSE;
    return JS_NewBool(c, _procs[id].used);
}

/* kernel.procList() → [{id, inboxCount, outboxCount}, ...] */
static JSValue js_proc_list(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    JSValue arr = JS_NewArray(c);
    int idx = 0;
    for (int i = 0; i < JSPROC_MAX; i++) {
        if (!_procs[i].used) continue;
        JSValue obj = JS_NewObject(c);
        JS_SetPropertyStr(c, obj, "id",          JS_NewInt32(c, i));
        JS_SetPropertyStr(c, obj, "inboxCount",  JS_NewInt32(c, _procs[i].inbox_cnt));
        JS_SetPropertyStr(c, obj, "outboxCount", JS_NewInt32(c, _procs[i].outbox_cnt));
        JS_SetPropertyUint32(c, arr, (uint32_t)idx++, obj);
        JS_FreeValue(c, obj);
    }
    return arr;
}

/* ── Phase 10: Time-sliced eval ──────────────────────────────────────────
 *
 * kernel.procEvalSlice(id, code, maxMs)
 *
 * Like procEval() but aborts the child after maxMs milliseconds using the
 * PIT-tick interrupt handler registered at procCreate() time.
 *
 * Returns one of:
 *   "done:<result>"   — eval completed within the time budget
 *   "timeout"         — child was interrupted; its eval state is gone,
 *                       but previously committed globals are intact
 *   "error:<message>" — child threw a JS exception
 *
 * maxMs ≤ 0 disables the deadline (equivalent to procEval).
 */
static JSValue js_proc_eval_slice(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NewString(c, "done:undefined");
    int32_t id = 0, max_ms = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (argc >= 3) JS_ToInt32(c, &max_ms, argv[2]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used)
        return JS_NewString(c, "error:invalid process id");
    const char *code = JS_ToCString(c, argv[1]);
    if (!code) return JS_NewString(c, "error:null code");
    /* Arm deadline: timer_get_ticks() runs at TIMER_HZ (1000 Hz = 1 ms/tick) */
    if (max_ms > 0)
        _proc_slice_deadline = timer_get_ticks() + MS_TO_TICKS((uint32_t)max_ms);
    else
        _proc_slice_deadline = 0;
    _cur_proc = id;
    JSValue result = JS_Eval(_procs[id].ctx, code, strlen(code),
                             "<slice>", JS_EVAL_TYPE_GLOBAL);
    _proc_slice_deadline = 0;   /* always clear immediately after eval */
    _cur_proc = -1;
    JS_FreeCString(c, code);
    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(_procs[id].ctx);
        const char *err = JS_ToCString(_procs[id].ctx, exc);
        int is_timeout = (err && strstr(err, "interrupted") != NULL);
        JSValue ret;
        if (is_timeout) {
            ret = JS_NewString(c, "timeout");
        } else {
            static char _es[JSPROC_MSGSIZE + 8];
            _es[0]='e';_es[1]='r';_es[2]='r';_es[3]='o';_es[4]='r';_es[5]=':';
            int n = 6;
            if (err) {
                int el = (int)strlen(err);
                if (el > JSPROC_MSGSIZE) el = JSPROC_MSGSIZE;
                memcpy(_es + 6, err, (size_t)el); n += el;
            }
            _es[n] = '\0';
            ret = JS_NewString(c, _es);
        }
        if (err) JS_FreeCString(_procs[id].ctx, err);
        JS_FreeValue(_procs[id].ctx, exc);
        JS_FreeValue(_procs[id].ctx, result);
        return ret;
    }
    if (JS_IsUndefined(result)) {
        JS_FreeValue(_procs[id].ctx, result);
        return JS_NewString(c, "done:undefined");
    }
    const char *str = JS_ToCString(_procs[id].ctx, result);
    static char _rs[JSPROC_MSGSIZE + 8];
    _rs[0]='d';_rs[1]='o';_rs[2]='n';_rs[3]='e';_rs[4]=':';
    int sn = 5;
    if (str) {
        int sl = (int)strlen(str);
        if (sl > JSPROC_MSGSIZE) sl = JSPROC_MSGSIZE;
        memcpy(_rs + 5, str, (size_t)sl); sn += sl;
        JS_FreeCString(_procs[id].ctx, str);
    }
    _rs[sn] = '\0';
    JS_FreeValue(_procs[id].ctx, result);
    return JS_NewString(c, _rs);
}

/* ── Phase 10: Shared buffer create / release (parent only) ──────────────
 *
 * kernel.sharedBufferCreate(size?) → id (0-7) or -1
 * Allocates a BSS slab.  size is clamped to SHARED_BUF_BYTES (256 KB).
 * Both parent and child call sharedBufferOpen(id) to get their ArrayBuffer.
 */
static JSValue js_shared_buf_create(JSContext *c, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t size = SHARED_BUF_BYTES;
    if (argc >= 1) JS_ToInt32(c, &size, argv[0]);
    if (size <= 0) size = 4;
    if (size > SHARED_BUF_BYTES) size = SHARED_BUF_BYTES;
    for (int i = 0; i < SHARED_BUF_MAX; i++) {
        if (!_sbuf_used[i]) {
            memset(_sbufs[i], 0, (size_t)size);
            _sbuf_used[i]  = 1;
            _sbuf_sizes[i] = (uint32_t)size;
            return JS_NewInt32(c, i);
        }
    }
    return JS_NewInt32(c, -1);
}

/* kernel.sharedBufferRelease(id) — free the slot; the bytes stay in BSS. */
static JSValue js_shared_buf_release(JSContext *c, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_UNDEFINED;
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id >= 0 && id < SHARED_BUF_MAX) {
        _sbuf_used[id]  = 0;
        _sbuf_sizes[id] = 0;
    }
    return JS_UNDEFINED;
}

/* ── Phase 11: JIT compiler primitives ───────────────────────────────────
 *
 * These three functions are the entire C surface exposed to the TypeScript
 * JIT compiler.  All compilation logic lives in jit.ts; C only provides:
 *   jitAlloc(size)           — carve RWX memory from the 256 KB JIT pool
 *   jitWrite(addr, bytes[])  — bulk-copy machine code bytes into the pool
 *   jitCallI(addr,a,b,c,d)  — call compiled cdecl fn with 4 int32 args
 *   jitUsedBytes()           — diagnostic: bytes consumed in pool
 */

/*
 * kernel.jitAlloc(size) → address (uint32) or 0 on failure.
 * Allocates `size` bytes from the static 256 KB RWX JIT pool.
 */
static JSValue js_jit_alloc(JSContext *c, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t size = 0;
    if (argc >= 1) JS_ToInt32(c, &size, argv[0]);
    if (size <= 0) return JS_NewInt32(c, 0);
    void *p = jit_alloc((size_t)size);
    return JS_NewUint32(c, p ? (uint32_t)(uintptr_t)p : 0u);
}

/*
 * kernel.jitWrite(addr, bytes) — copy a JS number[] of byte values into
 * the JIT pool at the address returned by jitAlloc().
 */
static JSValue js_jit_write(JSContext *c, JSValueConst this_val,
                            int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_UNDEFINED;
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    if (!addr) return JS_UNDEFINED;

    /* Fast path: ArrayBuffer */
    size_t ab_len = 0;
    uint8_t *ab = JS_GetArrayBuffer(c, &ab_len, argv[1]);
    if (ab) {
        jit_write((void *)(uintptr_t)addr, ab, ab_len);
        return JS_UNDEFINED;
    }

    /* Slow path: plain JS number[] */
    int32_t len_i = 0;
    JSValue lv = JS_GetPropertyStr(c, argv[1], "length");
    JS_ToInt32(c, &len_i, lv);
    JS_FreeValue(c, lv);
    if (len_i <= 0) return JS_UNDEFINED;
    if (len_i > (int32_t)JIT_ALLOC_MAX) len_i = (int32_t)JIT_ALLOC_MAX;

    /* Stack-allocate up to 4 KB; heap-allocate larger (rare). */
    static uint8_t _jit_write_buf[JIT_ALLOC_MAX];
    for (int32_t i = 0; i < len_i; i++) {
        JSValue bv = JS_GetPropertyUint32(c, argv[1], (uint32_t)i);
        int32_t b  = 0;
        JS_ToInt32(c, &b, bv);
        JS_FreeValue(c, bv);
        _jit_write_buf[i] = (uint8_t)b;
    }
    jit_write((void *)(uintptr_t)addr, _jit_write_buf, (size_t)len_i);
    return JS_UNDEFINED;
}

/*
 * kernel.jitCallI(addr, a0, a1, a2, a3) → int32
 * Call a JIT-compiled cdecl function with four 32-bit integer arguments.
 */
static JSValue js_jit_call_i(JSContext *c, JSValueConst this_val,
                             int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewInt32(c, 0);
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    if (!addr) return JS_NewInt32(c, 0);
    int32_t a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    if (argc > 1) JS_ToInt32(c, &a0, argv[1]);
    if (argc > 2) JS_ToInt32(c, &a1, argv[2]);
    if (argc > 3) JS_ToInt32(c, &a2, argv[3]);
    if (argc > 4) JS_ToInt32(c, &a3, argv[4]);
    return JS_NewInt32(c, jit_call_i4((void *)(uintptr_t)addr, a0, a1, a2, a3));
}

/*
 * kernel.jitUsedBytes() → uint32
 * Returns bytes consumed in the JIT pool (for diagnostics / budget checks).
 */
static JSValue js_jit_used_bytes(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewUint32(c, jit_used_bytes());
}

/*
 * kernel.jitMainReset() — reset the main JIT pool bump pointer to 0.
 * TypeScript must call kernel.setJITNative(addr, 0) for every compiled
 * function before calling this, so that stale native pointers are cleared.
 * Returns the number of bytes that were reclaimed.
 */
static JSValue js_jit_main_reset(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint32_t reclaimed = jit_used_bytes();
    jit_main_reset();
    return JS_NewUint32(c, reclaimed);
}

/*
 * kernel.jitCallI8(addr, a0..a7) → int32
 * Call a JIT-compiled cdecl function with eight 32-bit integer arguments.
 */
static JSValue js_jit_call_i8(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewInt32(c, 0);
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    if (!addr) return JS_NewInt32(c, 0);
    int32_t a[8] = {0};
    for (int i = 0; i < 8 && (i + 1) < argc; i++)
        JS_ToInt32(c, &a[i], argv[i + 1]);
    return JS_NewInt32(c, jit_call_i8((void *)(uintptr_t)addr,
                                      a[0], a[1], a[2], a[3],
                                      a[4], a[5], a[6], a[7]));
}

/*
 * kernel.jitCallF4(addr, d0, d1, d2, d3) → float64
 * Call a JIT-compiled float64 function (x87 double-cdecl ABI, up to 4 double args).
 * addr — native address returned by kernel.jitAlloc() for a FloatJITCompiler result.
 */
static JSValue js_jit_call_f(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewFloat64(c, 0.0);
    uint32_t addr = 0;
    JS_ToUint32(c, &addr, argv[0]);
    if (!addr) return JS_NewFloat64(c, 0.0);
    double a[4] = {0.0, 0.0, 0.0, 0.0};
    for (int i = 0; i < 4 && (i + 1) < argc; i++)
        JS_ToFloat64(c, &a[i], argv[i + 1]);
    return JS_NewFloat64(c, jit_call_d4((void *)(uintptr_t)addr,
                                        a[0], a[1], a[2], a[3]));
}

/*
 * kernel.physAddrOf(arrayBuffer) → uint32
 * Return the physical (linear) address of a JS ArrayBuffer's backing store.
 * QuickJS uses reference-counting (not a moving GC), so the address is stable
 * for the lifetime of the buffer.  Returns 0 if not an ArrayBuffer.
 *
 * JSOS-specific: enables JIT-compiled code to operate directly on JS TypedArray
 * data (canvas pixel buffers, audio buffers, etc.) without an extra copy.
 */
static JSValue js_physaddr_of(JSContext *c, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NewUint32(c, 0);
    size_t len = 0;
    uint8_t *ptr = JS_GetArrayBuffer(c, &len, argv[0]);
    if (!ptr) return JS_NewUint32(c, 0);
    return JS_NewUint32(c, (uint32_t)(uintptr_t)ptr);
}

/* ══════════════════════════════════════════════════════════════════════════
 * JIT runtime helpers — cdecl int32 functions called directly from JIT'd x86.
 * These use the static `ctx` global so they need no context argument.
 * Addresses are exposed to TypeScript via kernel.jitHelperAddrs().
 * ══════════════════════════════════════════════════════════════════════════ */

/*
 * jit_js_getprop_i32(obj_ptr, atom_val) → int32
 * Read an integer property from a JSObject.  Called from OP_get_field slow path.
 * obj_ptr = raw JSObject* passed as int32 from the JIT eval stack (via fixed _JARG).
 * atom_val = JSAtom (property name identifier).
 */
static int32_t jit_js_getprop_i32(uint32_t obj_ptr, uint32_t atom_val)
{
    if (!ctx || !obj_ptr) return 0;
    JSValue obj = JS_MKPTR(JS_TAG_OBJECT, (void *)(uintptr_t)obj_ptr);
    JSValue val = JS_GetProperty(ctx, obj, (JSAtom)atom_val);
    int32_t r = 0;
    if (!JS_IsException(val)) {
        if (JS_VALUE_GET_TAG(val) == JS_TAG_INT)
            r = JS_VALUE_GET_INT(val);
        else
            JS_ToInt32(ctx, &r, val);
    }
    JS_FreeValue(ctx, val);
    return r;
}

/*
 * jit_js_setprop_i32(obj_ptr, atom_val, ival) → void
 * Write an int32 value to a JSObject property.  Called from OP_put_field slow path.
 */
static void jit_js_setprop_i32(uint32_t obj_ptr, uint32_t atom_val, int32_t ival)
{
    if (!ctx || !obj_ptr) return;
    JSValue obj = JS_MKPTR(JS_TAG_OBJECT, (void *)(uintptr_t)obj_ptr);
    JS_SetProperty(ctx, obj, (JSAtom)atom_val, JS_NewInt32(ctx, ival));
}

/*
 * jit_js_call_fn(fn_ptr, a0, a1, a2, a3, argc) → int32
 * Call a JS function from JIT'd code.  Used by OP_call / OP_call0 slow path.
 * fn_ptr = raw JSObject* of the callee (function).
 * a0..a3 = int32 arguments (pass 0 for unused slots).
 * argc   = actual argument count (0–4).
 * Returns int32 result, or 0 on exception / non-integer result.
 */
static int32_t jit_js_call_fn(uint32_t fn_ptr,
                               int32_t a0, int32_t a1, int32_t a2, int32_t a3,
                               int32_t argc)
{
    if (!ctx || !fn_ptr || argc < 0 || argc > 4) return 0;
    JSValue fn = JS_MKPTR(JS_TAG_OBJECT, (void *)(uintptr_t)fn_ptr);
    JSValue args[4] = {
        JS_NewInt32(ctx, a0), JS_NewInt32(ctx, a1),
        JS_NewInt32(ctx, a2), JS_NewInt32(ctx, a3)
    };
    JSValue res = JS_Call(ctx, fn, JS_UNDEFINED, (int)argc, args);
    int32_t r = 0;
    if (!JS_IsException(res)) {
        if (JS_VALUE_GET_TAG(res) == JS_TAG_INT)
            r = JS_VALUE_GET_INT(res);
        else
            JS_ToInt32(ctx, &r, res);
    }
    JS_FreeValue(ctx, res);
    for (int i = 0; i < 4; i++) JS_FreeValue(ctx, args[i]);
    return r;
}

/*
 * kernel.jitHelperAddrs() → {getPropI32, setPropI32, callFn}
 * Returns an object containing the uint32 physical addresses of the three
 * JIT runtime helper functions above.  JIT'd x86 code loads these addresses
 * into ECX and executes CALL ECX to invoke the helper in cdecl fashion.
 */
static JSValue js_jit_get_helper_addrs(JSContext *c, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "getPropI32",
        JS_NewUint32(c, (uint32_t)(uintptr_t)jit_js_getprop_i32));
    JS_SetPropertyStr(c, o, "setPropI32",
        JS_NewUint32(c, (uint32_t)(uintptr_t)jit_js_setprop_i32));
    JS_SetPropertyStr(c, o, "callFn",
        JS_NewUint32(c, (uint32_t)(uintptr_t)jit_js_call_fn));
    return o;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Step 5: QJS JIT hook — callback dispatch + per-process JIT management
 *
 * Compile-time gate: define JSOS_JIT_HOOK once quickjs.c has been patched
 * (Step-5 WSL changes add js_jit_hook_t / JS_SetJITHook / JS_SetNativeIfHot).
 * Until then the global state + JS bindings compile unconditionally; only the
 * C→QuickJS glue that references the new API is guarded by the #ifdef.
 * ══════════════════════════════════════════════════════════════════════════ */

static JSValue         _jit_ts_callback = { 0 };   /* initialised in quickjs_initialize */
static int             _in_jit_hook     = 0;        /* reentrancy guard                  */

#ifdef JSOS_JIT_HOOK
/* Forward declarations for QuickJS post-Step-5 API */
typedef int (*js_jit_hook_t)(JSRuntime *rt, JSContext *ctx, void *bc_ptr,
                              void *stack_ptr, int argc);
extern void JS_SetJITHook(JSRuntime *rt, js_jit_hook_t hook);
extern void JS_SetNativeIfHot(JSContext *ctx, void *bc_ptr, void *native_ptr);

/*
 * Main-runtime JIT hook.
 * Called by QuickJS when a function's call_count reaches JIT_THRESHOLD.
 * Invokes the TypeScript QJSJITHook callback synchronously.
 * Returns non-zero to replace the call with the native version.
 */
static int _jit_hook_impl(JSRuntime *rt, JSContext *hook_ctx,
                           void *bc_ptr, void *sp, int argc) {
    (void)rt; (void)hook_ctx;
    if (_in_jit_hook || JS_IsUndefined(_jit_ts_callback)) return 0;
    _in_jit_hook = 1;
    JSValue args[3] = {
        JS_NewUint32(ctx, (uint32_t)(uintptr_t)bc_ptr),
        JS_NewUint32(ctx, (uint32_t)(uintptr_t)sp),
        JS_NewInt32 (ctx, argc)
    };
    JSValue result = JS_Call(ctx, _jit_ts_callback, JS_UNDEFINED, 3, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
    int ret = 0;
    if (!JS_IsException(result) && !JS_IsUndefined(result)) {
        int32_t r = 0; JS_ToInt32(ctx, &r, result); ret = r;
    }
    JS_FreeValue(ctx, result);
    _in_jit_hook = 0;
    return ret;
}

/*
 * Child-runtime JIT hook.
 * Stores the pending request for pickup by the TypeScript WM tick loop via
 * kernel.procPendingJIT(id).  Must NOT call back into JS (different runtime).
 */
static int _jit_hook_child(JSRuntime *rt, JSContext *hook_ctx,
                            void *bc_ptr, void *sp, int argc) {
    (void)hook_ctx; (void)sp; (void)argc;
    /* Identify which child slot owns this runtime */
    for (int i = 0; i < JSPROC_MAX; i++) {
        if (_procs[i].used && _procs[i].rt == rt) {
            if (!_jit_proc_pending[i].pending) {
                _jit_proc_pending[i].bc_addr = (uint32_t)(uintptr_t)bc_ptr;
                _jit_proc_pending[i].pending  = 1;
            }
            break;
        }
    }
    return 0; /* native pointer not ready yet — run as bytecode this call */
}
#endif /* JSOS_JIT_HOOK */

/* ── JS bindings for the JIT hook API ──────────────────────────────────── */

/*
 * kernel.setJITHook(callback) — install the TS JIT compiler callback.
 * callback(bcAddr, spAddr, argc) → 1 if native code was installed, else 0.
 */
static JSValue js_set_jit_hook(JSContext *c, JSValueConst this_val,
                               int argc, JSValueConst *argv) {
    (void)this_val; (void)argc;
    if (!JS_IsUndefined(_jit_ts_callback)) JS_FreeValue(c, _jit_ts_callback);
    _jit_ts_callback = JS_DupValue(c, argv[0]);
#ifdef JSOS_JIT_HOOK
    JS_SetJITHook(rt, _jit_hook_impl);
#endif
    return JS_UNDEFINED;
}

/*
 * kernel.setJITNative(bcAddr, nativeAddr) — write the compiled function
 * pointer back into the JSFunctionBytecode so QuickJS dispatches it directly.
 */
static JSValue js_set_jit_native(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 2) return JS_UNDEFINED;
    uint32_t bc_addr = 0, native_addr = 0;
    JS_ToUint32(c, &bc_addr,     argv[0]);
    JS_ToUint32(c, &native_addr, argv[1]);
    if (!bc_addr || !native_addr) return JS_UNDEFINED;
#ifdef JSOS_JIT_HOOK
    JS_SetNativeIfHot(ctx,
                      (void *)(uintptr_t)bc_addr,
                      (void *)(uintptr_t)native_addr);
#else
    /* Without the patched QuickJS, manually write jit_native_ptr field @24 */
    *(uint32_t *)((uint8_t *)(uintptr_t)bc_addr + 24) = native_addr;
#endif
    return JS_UNDEFINED;
}

/*
 * kernel.procPendingJIT(id) → uint32 bc_addr (0 = none).
 * Returns and clears the next pending JIT compilation request for child `id`.
 */
static JSValue js_proc_pending_jit(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_NewUint32(c, 0);
    int32_t id = 0;
    JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX) return JS_NewUint32(c, 0);
    if (!_jit_proc_pending[id].pending) return JS_NewUint32(c, 0);
    uint32_t addr = _jit_proc_pending[id].bc_addr;
    _jit_proc_pending[id].pending = 0;
    _jit_proc_pending[id].bc_addr = 0;
    return JS_NewUint32(c, addr);
}

/*
 * kernel.jitProcAlloc(id, size) → uint32 address in child's JIT partition.
 * Allocates `size` bytes from the 512 KB per-process JIT slab.
 */
static JSValue js_jit_proc_alloc(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 2) return JS_NewUint32(c, 0);
    int32_t id = 0; int32_t size = 0;
    JS_ToInt32(c, &id,   argv[0]);
    JS_ToInt32(c, &size, argv[1]);
    if (id < 0 || id >= JSPROC_MAX || size <= 0) return JS_NewUint32(c, 0);
    void *p = jit_proc_alloc(id, (size_t)size);
    return JS_NewUint32(c, p ? (uint32_t)(uintptr_t)p : 0u);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Phase A/B: Child render buffer, dimensions, FS bridge, event, wincmd, timers
 * ══════════════════════════════════════════════════════════════════════════ */

/* Helper: call a named method on _fs_bridge_obj with one string argument.
 * Runs in the MAIN context — safe because cooperative scheduling. */
static JSValue _fs_bridge_call(const char *method, const char *arg) {
    if (JS_IsUndefined(_fs_bridge_obj)) return JS_NULL;
    JSValue fn = JS_GetPropertyStr(ctx, _fs_bridge_obj, method);
    if (!JS_IsFunction(ctx, fn)) { JS_FreeValue(ctx, fn); return JS_NULL; }
    JSValue arg_v = JS_NewString(ctx, arg ? arg : "");
    JSValue result = JS_Call(ctx, fn, _fs_bridge_obj, 1, &arg_v);
    JS_FreeValue(ctx, arg_v);
    JS_FreeValue(ctx, fn);
    return result;
}

/* ── Main-side: kernel.getProcRenderBuffer(id) → ArrayBuffer (view of BSS) ── */
static JSValue js_get_proc_render_buf(JSContext *c, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    int32_t id = 0; JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_NULL;
    uint32_t w = _procs[id].width, h = _procs[id].height;
    if (w == 0 || h == 0) return JS_NULL;
    size_t bytes = (size_t)w * (size_t)h * 4;
    if (bytes > RENDER_BUF_BYTES) bytes = RENDER_BUF_BYTES;
    return JS_NewArrayBuffer(c, _app_render_bufs[id], bytes,
                             _sbuf_no_free, NULL, 0);
}

/* ── Main-side: kernel.procSetDimensions(id, w, h) ── */
static JSValue js_proc_set_dimensions(JSContext *c, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 3) return JS_UNDEFINED;
    int32_t id = 0, w = 0, h = 0;
    JS_ToInt32(c, &id, argv[0]);
    JS_ToInt32(c, &w, argv[1]);
    JS_ToInt32(c, &h, argv[2]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_UNDEFINED;
    _procs[id].width  = (uint32_t)w;
    _procs[id].height = (uint32_t)h;
    return JS_UNDEFINED;
}

/* ── Main-side: kernel.registerChildFSBridge(obj) ── */
static JSValue js_register_child_fs_bridge(JSContext *c, JSValueConst this_val,
                                           int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    if (!JS_IsUndefined(_fs_bridge_obj)) JS_FreeValue(c, _fs_bridge_obj);
    _fs_bridge_obj = JS_DupValue(c, argv[0]);
    return JS_UNDEFINED;
}

/* ── Main-side: kernel.procSendEvent(id, evObj) — JSON-encode evObj into child event queue ── */
static JSValue js_proc_send_event(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_FALSE;
    int32_t id = 0; JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_FALSE;
    ProcEventQueue_t *q = &_proc_event_queues[id];
    if (q->count >= PROC_EVENT_QUEUE_SLOTS) return JS_FALSE;
    JSValue _json_global = JS_GetGlobalObject(c);
    JSValue json_fn = JS_GetPropertyStr(c, _json_global, "JSON");
    JS_FreeValue(c, _json_global);
    JSValue stringify = JS_GetPropertyStr(c, json_fn, "stringify");
    JSValue json_str  = JS_Call(c, stringify, json_fn, 1, &argv[1]);
    JS_FreeValue(c, stringify); JS_FreeValue(c, json_fn);
    if (JS_IsException(json_str)) { JS_FreeValue(c, json_str); return JS_FALSE; }
    const char *s = JS_ToCString(c, json_str);
    JS_FreeValue(c, json_str);
    if (!s) return JS_FALSE;
    ProcEventSlot_t *slot = &q->slots[q->tail];
    int n = (int)strlen(s);
    if (n >= PROC_EVENT_SLOT_BYTES) n = PROC_EVENT_SLOT_BYTES - 1;
    memcpy(slot->data, s, (size_t)n);
    slot->data[n] = '\0';
    slot->used = 1;
    JS_FreeCString(c, s);
    q->tail = (q->tail + 1) % PROC_EVENT_QUEUE_SLOTS;
    q->count++;
    return JS_TRUE;
}

/* ── Main-side: kernel.procDequeueWindowCommand(id) → {type,...} or null ── */
static JSValue js_proc_dequeue_window_cmd(JSContext *c, JSValueConst this_val,
                                          int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    int32_t id = 0; JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_NULL;
    ProcWinCmdBuf_t *b = &_proc_wincmds[id];
    if (b->cnt == 0) return JS_NULL;
    ProcWinCmd_t *slot = &b->slots[b->r];
    /* Parse JSON in main context */
    JSValue parsed = JS_ParseJSON(c, slot->data, (size_t)slot->len, "<wincmd>");
    b->r = (b->r + 1) % PROC_WINCMD_SLOTS;
    b->cnt--;
    return parsed;
}

/* ── Main-side: kernel.serviceTimers(id) — fire expired timers for child id ── */
static JSValue js_service_timers(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_UNDEFINED;
    int32_t id = 0; JS_ToInt32(c, &id, argv[0]);
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_UNDEFINED;
    uint32_t now = timer_get_ticks();
    JSContext *cc = _procs[id].ctx;
    _cur_proc = id;
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (!t->active) continue;
        if ((int32_t)(now - t->due_ticks) < 0) continue; /* not yet due */
        /* Fire callback */
        JSValue r = JS_Call(cc, t->cb, JS_UNDEFINED, 0, NULL);
        if (JS_IsException(r)) {
            /* item 113: log exception instead of silently discarding */
            JSValue exc = JS_GetException(cc);
            const char *msg = JS_ToCString(cc, exc);
            if (msg) {
                platform_serial_puts("[timer] exception in callback: ");
                platform_serial_puts(msg);
                platform_serial_puts("\n");
                JS_FreeCString(cc, msg);
            }
            JS_FreeValue(cc, exc);
        }
        JS_FreeValue(cc, r);
        if (t->repeat) {
            t->due_ticks = now + MS_TO_TICKS(t->interval_ms);
        } else {
            JS_FreeValue(cc, t->cb);
            t->cb = JS_UNDEFINED;
            t->active = 0;
        }
    }
    _cur_proc = -1;
    return JS_UNDEFINED;
}

/* ── Child-side: kernel.getRenderBuffer() → ArrayBuffer pointing at BSS slab ── */
static JSValue js_child_get_render_buf(JSContext *c, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX || !_procs[id].used) return JS_NULL;
    uint32_t w = _procs[id].width, h = _procs[id].height;
    if (w == 0 || h == 0) return JS_NULL;
    size_t bytes = (size_t)w * (size_t)h * 4;
    if (bytes > RENDER_BUF_BYTES) bytes = RENDER_BUF_BYTES;
    return JS_NewArrayBuffer(c, _app_render_bufs[id], bytes,
                             _sbuf_no_free, NULL, 0);
}

/* ── Child-side: kernel.getWidth() / kernel.getHeight() ── */
static JSValue js_child_get_width(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_NewUint32(c, 0);
    return JS_NewUint32(c, _procs[id].width);
}
static JSValue js_child_get_height(JSContext *c, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_NewUint32(c, 0);
    return JS_NewUint32(c, _procs[id].height);
}

/* ── Child-side: FS bridge calls ── */
static JSValue js_child_fs_read_file(JSContext *c, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_NULL;
    JSValue main_result = _fs_bridge_call("readFile", path);
    JS_FreeCString(c, path);
    if (JS_IsNull(main_result) || JS_IsUndefined(main_result)) return JS_NULL;
    const char *str = JS_ToCString(ctx, main_result);
    JS_FreeValue(ctx, main_result);
    if (!str) return JS_NULL;
    JSValue ret = JS_NewString(c, str);
    JS_FreeCString(ctx, str);
    return ret;
}
static JSValue js_child_fs_write_file(JSContext *c, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_FALSE;
    const char *path = JS_ToCString(c, argv[0]);
    const char *cont = JS_ToCString(c, argv[1]);
    if (!path || !cont) { JS_FreeCString(c,path); JS_FreeCString(c,cont); return JS_FALSE; }
    /* encode as "path\x00content" and use writeFile with two args via JSON hack */
    JSValue path_v = JS_NewString(ctx, path);
    JSValue cont_v = JS_NewString(ctx, cont);
    JS_FreeCString(c, path); JS_FreeCString(c, cont);
    if (JS_IsUndefined(_fs_bridge_obj)) { JS_FreeValue(ctx,path_v); JS_FreeValue(ctx,cont_v); return JS_FALSE; }
    JSValue fn = JS_GetPropertyStr(ctx, _fs_bridge_obj, "writeFile");
    JSValue args[2] = { path_v, cont_v };
    JSValue r = JS_Call(ctx, fn, _fs_bridge_obj, 2, args);
    JS_FreeValue(ctx,fn); JS_FreeValue(ctx,path_v); JS_FreeValue(ctx,cont_v);
    int ok = JS_ToBool(ctx, r);
    JS_FreeValue(ctx, r);
    return JS_NewBool(c, ok);
}
static JSValue js_child_fs_read_dir(JSContext *c, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_NULL;
    JSValue main_result = _fs_bridge_call("readDir", path);
    JS_FreeCString(c, path);
    const char *str = JS_IsNull(main_result)||JS_IsUndefined(main_result) ? NULL : JS_ToCString(ctx, main_result);
    JS_FreeValue(ctx, main_result);
    if (!str) return JS_NULL;
    JSValue ret = JS_ParseJSON(c, str, strlen(str), "<readDir>");
    JS_FreeCString(ctx, str);
    return ret;
}
static JSValue js_child_fs_exists(JSContext *c, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_FALSE;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_FALSE;
    JSValue main_result = _fs_bridge_call("exists", path);
    JS_FreeCString(c, path);
    int ok = JS_ToBool(ctx, main_result);
    JS_FreeValue(ctx, main_result);
    return JS_NewBool(c, ok);
}
static JSValue js_child_fs_stat(JSContext *c, JSValueConst this_val,
                                 int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_NULL;
    const char *path = JS_ToCString(c, argv[0]);
    if (!path) return JS_NULL;
    JSValue main_result = _fs_bridge_call("stat", path);
    JS_FreeCString(c, path);
    const char *str = JS_IsNull(main_result)||JS_IsUndefined(main_result) ? NULL : JS_ToCString(ctx, main_result);
    JS_FreeValue(ctx, main_result);
    if (!str) return JS_NULL;
    JSValue ret = JS_ParseJSON(c, str, strlen(str), "<stat>");
    JS_FreeCString(ctx, str);
    return ret;
}

/* ── Child-side: setTimeout / clearTimeout / setInterval / clearInterval ── */
static JSValue js_child_set_timeout(JSContext *c, JSValueConst this_val,
                                     int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NewInt32(c, -1);
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_NewInt32(c, -1);
    int32_t ms = 0; JS_ToInt32(c, &ms, argv[1]);
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (t->active) continue;
        t->id          = ++_proc_timer_next_id[id];
        t->interval_ms = (uint32_t)(ms > 0 ? ms : 1);
        t->due_ticks   = timer_get_ticks() + MS_TO_TICKS(t->interval_ms);
        t->repeat      = 0;
        t->active      = 1;
        t->cb          = JS_DupValue(c, argv[0]);
        return JS_NewUint32(c, t->id);
    }
    return JS_NewInt32(c, -1); /* no free slot */
}
static JSValue js_child_clear_timeout(JSContext *c, JSValueConst this_val,
                                       int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_UNDEFINED;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_UNDEFINED;
    uint32_t tid = 0; JS_ToUint32(c, &tid, argv[0]);
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (!t->active || t->id != tid) continue;
        JS_FreeValue(c, t->cb); t->cb = JS_UNDEFINED; t->active = 0; break;
    }
    return JS_UNDEFINED;
}
static JSValue js_child_set_interval(JSContext *c, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 2) return JS_NewInt32(c, -1);
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_NewInt32(c, -1);
    int32_t ms = 0; JS_ToInt32(c, &ms, argv[1]);
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (t->active) continue;
        t->id          = ++_proc_timer_next_id[id];
        t->interval_ms = (uint32_t)(ms > 0 ? ms : 1);
        t->due_ticks   = timer_get_ticks() + MS_TO_TICKS(t->interval_ms);
        t->repeat      = 1;
        t->active      = 1;
        t->cb          = JS_DupValue(c, argv[0]);
        return JS_NewUint32(c, t->id);
    }
    return JS_NewInt32(c, -1);
}
static JSValue js_child_clear_interval(JSContext *c, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    (void)this_val;
    if (argc < 1) return JS_UNDEFINED;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_UNDEFINED;
    uint32_t tid = 0; JS_ToUint32(c, &tid, argv[0]);
    for (int i = 0; i < MAX_TIMERS; i++) {
        ProcTimer_t *t = &_proc_timers[id][i];
        if (!t->active || t->id != tid) continue;
        JS_FreeValue(c, t->cb); t->cb = JS_UNDEFINED; t->active = 0; break;
    }
    return JS_UNDEFINED;
}

/* ── Child-side: kernel.pollEvent() → parsed object or null ── */
static JSValue js_child_poll_event(JSContext *c, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_NULL;
    ProcEventQueue_t *q = &_proc_event_queues[id];
    if (q->count == 0) return JS_NULL;
    ProcEventSlot_t *slot = &q->slots[q->head];
    JSValue parsed = JS_ParseJSON(c, slot->data, strlen(slot->data), "<event>");
    slot->used = 0;
    q->head = (q->head + 1) % PROC_EVENT_QUEUE_SLOTS;
    q->count--;
    return parsed;
}

/* ── Child-side: kernel.sendWindowCommand(jsonStr) ── */
static JSValue js_child_window_command(JSContext *c, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    (void)this_val; (void)c;
    if (argc < 1) return JS_FALSE;
    int id = _cur_proc;
    if (id < 0 || id >= JSPROC_MAX) return JS_FALSE;
    ProcWinCmdBuf_t *b = &_proc_wincmds[id];
    if (b->cnt >= PROC_WINCMD_SLOTS) return JS_FALSE;
    const char *s = JS_ToCString(c, argv[0]);
    if (!s) return JS_FALSE;
    ProcWinCmd_t *slot = &b->slots[b->w];
    int n = (int)strlen(s);
    if (n >= PROC_WINCMD_SIZE) n = PROC_WINCMD_SIZE - 1;
    memcpy(slot->data, s, (size_t)n);
    slot->data[n] = '\0';
    slot->len = n;
    JS_FreeCString(c, s);
    b->w = (b->w + 1) % PROC_WINCMD_SLOTS;
    b->cnt++;
    return JS_TRUE;
}

/* ── sys.gc() — run the QuickJS garbage collector (item 116) ─────────────── */
static JSValue js_gc(JSContext *c, JSValueConst this_val,
                     int argc, JSValueConst *argv) {
    (void)c; (void)this_val; (void)argc; (void)argv;
    JS_RunGC(rt);
    return JS_UNDEFINED;
}

/* ── New system bindings (items 118-127) ─────────────────────────────────── */

/* Pull in new subsystem headers */
/* timer.h already included above */
#include "acpi.h"
#include "cpuid.h"
#include "cmdline.h"
#include "memory.h"
#include "symtab.h"
#include "irq.h"
#include "hpet.h"
#include "virtio_blk.h"
#include "virtio_gpu.h"

/* kernel.tscHz() → number of TSC ticks per second (item 46) */
static JSValue js_tsc_hz(JSContext *c, JSValueConst _t,
                         int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, timer_tsc_hz());
}

/* kernel.rtcRead() → {seconds,minutes,hours,day,month,year,unix} (item 50) */
static JSValue js_rtc_read(JSContext *c, JSValueConst _t,
                            int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    rtc_time_t t;
    rtc_read(&t);
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "seconds", JS_NewUint32(c, t.seconds));
    JS_SetPropertyStr(c, o, "minutes", JS_NewUint32(c, t.minutes));
    JS_SetPropertyStr(c, o, "hours",   JS_NewUint32(c, t.hours));
    JS_SetPropertyStr(c, o, "day",     JS_NewUint32(c, t.day));
    JS_SetPropertyStr(c, o, "month",   JS_NewUint32(c, t.month));
    JS_SetPropertyStr(c, o, "year",    JS_NewUint32(c, t.year));
    JS_SetPropertyStr(c, o, "unix",    JS_NewUint32(c, rtc_unix_time()));
    return o;
}

/* kernel.setWallClock(unixSeconds) — NTP sync: store wall-clock epoch (item 51) */
static JSValue js_set_wall_clock(JSContext *c, JSValueConst _t,
                                  int ac, JSValueConst *av) {
    (void)_t;
    if (ac < 1) return JS_UNDEFINED;
    uint32_t epoch;
    if (JS_ToUint32(c, &epoch, av[0])) return JS_UNDEFINED;
    timer_set_wall_clock(epoch);
    return JS_UNDEFINED;
}

/* kernel.getWallClock() → Unix seconds (NTP-adjusted or RTC fallback) (item 51) */
static JSValue js_get_wall_clock(JSContext *c, JSValueConst _t,
                                  int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, timer_get_wall_clock());
}

/* kernel.allocPage() → physical address of a 4 KB page, 0 on OOM (item 33) */
static JSValue js_alloc_page(JSContext *c, JSValueConst _t,
                              int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, alloc_page());
}

/* kernel.freePage(physAddr) — return a page to the allocator (item 34) */
static JSValue js_free_page(JSContext *c, JSValueConst _t,
                             int ac, JSValueConst *av) {
    (void)_t;
    if (ac < 1) return JS_EXCEPTION;
    uint32_t addr;
    if (JS_ToUint32(c, &addr, av[0])) return JS_EXCEPTION;
    free_page(addr);
    return JS_UNDEFINED;
}

/* kernel.pagesFree() → number of free 4 KB pages */
static JSValue js_pages_free(JSContext *c, JSValueConst _t,
                              int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, (uint32_t)memory_get_pages_free());
}

/* kernel.acpiShutdown() — power off via ACPI S5 (item 105) */
static JSValue js_acpi_shutdown(JSContext *c, JSValueConst _t,
                                 int _ac, JSValueConst *_av) {
    (void)c; (void)_t; (void)_ac; (void)_av;
    acpi_shutdown();    /* noreturn */
    return JS_UNDEFINED;
}

/* kernel.acpiReboot() — reboot via ACPI reset / KBC (item 106) */
static JSValue js_acpi_reboot(JSContext *c, JSValueConst _t,
                               int _ac, JSValueConst *_av) {
    (void)c; (void)_t; (void)_ac; (void)_av;
    acpi_reboot();      /* noreturn */
    return JS_UNDEFINED;
}

/* kernel.symLookup(addr) → {name,offset} — kernel symbol table (item 104) */
static JSValue js_sym_lookup(JSContext *c, JSValueConst _t,
                              int ac, JSValueConst *av) {
    (void)_t;
    if (ac < 1) return JS_EXCEPTION;
    uint32_t addr;
    if (JS_ToUint32(c, &addr, av[0])) return JS_EXCEPTION;
    uint32_t off = 0;
    const char *name = symtab_lookup(addr, &off);
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "name",   JS_NewString(c, name));
    JS_SetPropertyStr(c, o, "offset", JS_NewUint32(c, off));
    return o;
}

/* kernel.cmdlineGet(key) → string | null (item 4) */
static JSValue js_cmdline_get(JSContext *c, JSValueConst _t,
                               int ac, JSValueConst *av) {
    (void)_t;
    if (ac < 1) return JS_NULL;
    const char *key = JS_ToCString(c, av[0]);
    if (!key) return JS_NULL;
    const char *val = cmdline_get(key);
    JS_FreeCString(c, key);
    return val ? JS_NewString(c, val) : JS_NULL;
}

/* kernel.cpuidInfo() → CPU feature flags object (item 8) */
static JSValue js_cpuid_info(JSContext *c, JSValueConst _t,
                              int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    JSValue o = JS_NewObject(c);
    JS_SetPropertyStr(c, o, "vendor",  JS_NewString(c, cpuid_features.vendor));
    JS_SetPropertyStr(c, o, "family",  JS_NewUint32(c, cpuid_features.family));
    JS_SetPropertyStr(c, o, "model",   JS_NewUint32(c, cpuid_features.model));
    JS_SetPropertyStr(c, o, "step",    JS_NewUint32(c, cpuid_features.stepping));
    JS_SetPropertyStr(c, o, "sse",     JS_NewBool(c, cpuid_features.sse));
    JS_SetPropertyStr(c, o, "sse2",    JS_NewBool(c, cpuid_features.sse2));
    JS_SetPropertyStr(c, o, "sse3",    JS_NewBool(c, cpuid_features.sse3));
    JS_SetPropertyStr(c, o, "sse41",   JS_NewBool(c, cpuid_features.sse41));
    JS_SetPropertyStr(c, o, "sse42",   JS_NewBool(c, cpuid_features.sse42));
    JS_SetPropertyStr(c, o, "avx",     JS_NewBool(c, cpuid_features.avx));
    JS_SetPropertyStr(c, o, "aes",     JS_NewBool(c, cpuid_features.aes));
    JS_SetPropertyStr(c, o, "rdrand",  JS_NewBool(c, cpuid_features.rdrand));
    JS_SetPropertyStr(c, o, "nx",      JS_NewBool(c, cpuid_features.nx));
    JS_SetPropertyStr(c, o, "tsc",     JS_NewBool(c, cpuid_features.tsc));
    JS_SetPropertyStr(c, o, "mtrr",    JS_NewBool(c, cpuid_features.mtrr));
    JS_SetPropertyStr(c, o, "apic",    JS_NewBool(c, cpuid_features.apic));
    JS_SetPropertyStr(c, o, "htt",     JS_NewBool(c, cpuid_features.htt));
    JS_SetPropertyStr(c, o, "lm",      JS_NewBool(c, cpuid_features.lm));
    return o;
}

/* kernel.getTimeNs() → BigInt nanoseconds since boot via TSC (item 48) */
static JSValue js_gettime_ns(JSContext *c, JSValueConst _t,
                             int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    uint64_t ns = timer_gettime_ns();
    /* Return as a regular JS number — at ~4e9 ns/sec, float64 precision is
     * acceptable for uptime < 104 days; use BigInt if caller needs full res */
    return JS_NewFloat64(c, (double)ns);
}

/* kernel.uptimeUs() → microseconds since boot (item 48) */
static JSValue js_uptime_us(JSContext *c, JSValueConst _t,
                            int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewFloat64(c, (double)timer_uptime_us());
}

/* kernel.rdrand() → one 32-bit hardware random word via RDRAND CPU instruction (item 348)
 * Returns a Uint32.  Falls back to TSC-derived value if RDRAND is not available or fails. */
static JSValue js_rdrand(JSContext *c, JSValueConst _t,
                         int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    uint32_t val = 0;
    if (cpuid_features.rdrand) {
        /* RDRAND: retry up to 10 times if CF=0 (hardware entropy pool exhausted) */
        int ok = 0, i;
        for (i = 0; i < 10 && !ok; i++) {
            __asm__ volatile (
                "rdrand %0\n"
                "setc   %b1\n"
                : "=r"(val), "=q"(ok)
                :
                : "cc"
            );
        }
        if (!ok) val = (uint32_t)timer_uptime_us(); /* TSC fallback */
    } else {
        val = (uint32_t)timer_uptime_us(); /* no RDRAND – TSC fallback */
    }
    return JS_NewUint32(c, val);
}

/* kernel.reserveRegion(base, size) → mark MMIO region used (item 40) */
static JSValue js_reserve_region(JSContext *c, JSValueConst _t,
                                  int argc, JSValueConst *argv) {
    (void)_t;
    if (argc < 2) return JS_ThrowTypeError(c, "reserveRegion(base, size)");
    uint32_t base = 0, size = 0;
    JS_ToUint32(c, &base, argv[0]);
    JS_ToUint32(c, &size, argv[1]);
    memory_reserve_region(base, size);
    return JS_UNDEFINED;
}

/* kernel.irqSetTpr(class) → set LAPIC TPR (item 26) */
static JSValue js_irq_set_tpr(JSContext *c, JSValueConst _t,
                               int argc, JSValueConst *argv) {
    (void)_t;
    uint32_t cls = 0;
    if (argc >= 1) JS_ToUint32(c, &cls, argv[0]);
    irq_set_tpr((uint8_t)(cls & 0xFu));
    return JS_UNDEFINED;
}

/* kernel.hpetInit(mmioBase) → int (item 47) */
static JSValue js_hpet_init(JSContext *c, JSValueConst _t,
                             int argc, JSValueConst *argv) {
    (void)_t;
    uint32_t base = 0;
    if (argc >= 1) JS_ToUint32(c, &base, argv[0]);
    return JS_NewInt32(c, hpet_init(base));
}

/* kernel.hpetRead() → number (lower 32 bits of main counter) (item 47) */
static JSValue js_hpet_read(JSContext *c, JSValueConst _t,
                             int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, hpet_read_counter32());
}

/* kernel.hpetFreq() → Hz (item 47) */
static JSValue js_hpet_freq(JSContext *c, JSValueConst _t,
                             int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewUint32(c, hpet_frequency());
}

/* kernel.ataIsAtapi() → 1/0/-1 (item 80) */
static JSValue js_ata_is_atapi(JSContext *c, JSValueConst _t,
                                int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewInt32(c, ata_is_atapi());
}

/* kernel.virtioBlkPresent() → boolean (item 81) */
static JSValue js_virtio_blk_present(JSContext *c, JSValueConst _t,
                                      int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewBool(c, virtio_blk_present());
}

/* kernel.virtioBlkSectors() → number (item 81) */
static JSValue js_virtio_blk_sectors(JSContext *c, JSValueConst _t,
                                      int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewFloat64(c, (double)virtio_blk_sector_count());
}

/* kernel.virtioGpuPresent() → boolean (item 68) */
static JSValue js_virtio_gpu_present(JSContext *c, JSValueConst _t,
                                      int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    return JS_NewBool(c, virtio_gpu_present());
}

/* ── APIC / IOAPIC / APIC timer (items 24, 28, 49) ──────────────────────── */
#include "apic.h"

static JSValue js_apic_init(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; apic_init(); return JS_UNDEFINED; }
static JSValue js_apic_eoi(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; apic_eoi(); return JS_UNDEFINED; }
static JSValue js_apic_timer_calibrate(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; apic_timer_calibrate(); return JS_UNDEFINED; }
static JSValue js_apic_timer_start(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t ms = 10;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) ms = (uint32_t)v; }
    apic_timer_start_periodic(ms); return JS_UNDEFINED; }
static JSValue js_ioapic_init(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t base = 0xFEC00000u;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) base = (uint32_t)v; }
    ioapic_init(base); return JS_UNDEFINED; }
static JSValue js_ioapic_unmask(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t irq = 0;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) irq = (uint32_t)v; }
    ioapic_unmask_irq((uint8_t)irq); return JS_UNDEFINED; }

/* ── NVMe (item 82) ──────────────────────────────────────────────────────── */
#include "nvme.h"

static JSValue js_nvme_init(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, nvme_init() == 0); }
static JSValue js_nvme_present(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, nvme_present()); }
static JSValue js_nvme_enable(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, nvme_enable() == 0); }

/* ── AHCI (item 83) ──────────────────────────────────────────────────────── */
#include "ahci.h"

static JSValue js_ahci_init(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, ahci_init() == 0); }
static JSValue js_ahci_present(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, ahci_present()); }

/* ── Memory extensions (items 37, 38, 39, 42) ───────────────────────────── */
static JSValue js_mem_enable_pae(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; memory_enable_pae(); return JS_UNDEFINED; }
static JSValue js_mem_enable_nx(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; memory_enable_nx(); return JS_UNDEFINED; }
static JSValue js_mem_tlb_flush(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t vaddr = 0;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) vaddr = (uint32_t)v; }
    memory_tlb_flush_local(vaddr); return JS_UNDEFINED; }
static JSValue js_mem_tlb_flush_all(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; memory_tlb_flush_all(); return JS_UNDEFINED; }
static JSValue js_mem_large_page_en(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; memory_enable_large_pages(); return JS_UNDEFINED; }
static JSValue js_mem_hotplug_add(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t base = 0, size = 0;
    if (_ac >= 2) {
        double b, s;
        if (!JS_ToFloat64(c, &b, av[0])) base = (uint32_t)b;
        if (!JS_ToFloat64(c, &s, av[1])) size = (uint32_t)s;
    }
    return JS_NewInt32(c, (int32_t)memory_hotplug_add_region(base, size)); }

/* ── ACPI PM timer (item 52) ────────────────────────────────────────────── */
static JSValue js_acpi_pm_timer(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewInt32(c, (int32_t)acpi_pm_timer_read()); }

/* ── Framebuffer / display extras (items 69-72) ─────────────────────────── */
static JSValue js_fb_alloc_backbuf(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewBool(c, platform_fb_alloc_backbuffer() == 0); }
static JSValue js_fb_flip(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; platform_fb_flip(); return JS_UNDEFINED; }
static JSValue js_vsync_wait(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; platform_vsync_wait(); return JS_UNDEFINED; }
static JSValue js_cursor_enable(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; int en = (_ac >= 1) ? JS_ToBool(c, av[0]) : 1;
    platform_cursor_enable(en); return JS_UNDEFINED; }
static JSValue js_cursor_set_pos(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t col = 0, row = 0;
    if (_ac >= 2) { double a, b;
        if (!JS_ToFloat64(c, &a, av[0])) col = (uint32_t)a;
        if (!JS_ToFloat64(c, &b, av[1])) row = (uint32_t)b; }
    platform_cursor_set_pos((uint8_t)col, (uint8_t)row); return JS_UNDEFINED; }
static JSValue js_dpms_set(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t st = 0;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) st = (uint32_t)v; }
    platform_dpms_set((dpms_state_t)st); return JS_UNDEFINED; }

/* ── Keyboard layout (items 60-62) ──────────────────────────────────────── */
#include "keyboard_layout.h"

static JSValue js_kb_layout_set(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; uint32_t id = 0;
    if (_ac >= 1) { double v; if (!JS_ToFloat64(c, &v, av[0])) id = (uint32_t)v; }
    return JS_NewBool(c, kb_layout_set((kb_layout_id_t)id) == 0); }
static JSValue js_kb_layout_get(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewInt32(c, (int32_t)kb_layout_get()); }
static JSValue js_kb_ime_enable(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; int en = (_ac >= 1) ? JS_ToBool(c, av[0]) : 1;
    kb_ime_enable(en); return JS_UNDEFINED; }

/* ── Selftest (item 108) ─────────────────────────────────────────────────── */
#include "selftest.h"

static JSValue js_selftest_run(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; return JS_NewInt32(c, selftest_run_all()); }

/* ── kprobes (item 110) ──────────────────────────────────────────────────── */
#include "kprobes.h"

static JSValue js_kprobes_init(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; kprobes_init(); return JS_UNDEFINED; }
static JSValue js_kprobes_dump(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av; kprobes_dump(); return JS_UNDEFINED; }

/* ── Item 123: debugger statement → serial breakpoint ───────────────────── */
/* QuickJS skips the `debugger` keyword by default.  TypeScript code that
 * is transpiled by the JSOS build system has `debugger` replaced with a
 * call to kernel.debugBreak() at bundle time.  This binding handles it. */
static JSValue js_debug_break(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    platform_serial_puts("[DEBUGGER] JS debugger breakpoint — EIP on serial\n");
    /* Print current JS context backtrace to COM1 */
    JSValue exc = JS_GetException(c);
    if (!JS_IsNull(exc)) {
        JSValue stk = JS_GetPropertyStr(c, exc, "stack");
        if (JS_IsString(stk)) {
            const char *s = JS_ToCString(c, stk);
            if (s) { platform_serial_puts(s); platform_serial_puts("\n"); JS_FreeCString(c, s); }
        }
        JS_FreeValue(c, stk);
        JS_FreeValue(c, exc);
    }
    return JS_UNDEFINED;
}

/* ── Item 122: SourceMap registry (stack trace decoration) ──────────────── */
/* Stores at most 8 registered source maps (url+content) for the stack
 * trace formatter in the OS TypeScript layer.                               */
#define SRCMAP_MAX 8
static struct { char url[128]; JSValue map; } _srcmaps[SRCMAP_MAX];
static int _srcmap_count = 0;

static JSValue js_sourcemap_register(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    if (_ac < 2) return JS_NewBool(c, 0);
    const char *url = JS_ToCString(c, av[0]);
    if (!url) return JS_NewBool(c, 0);
    if (_srcmap_count < SRCMAP_MAX) {
        int i = _srcmap_count++;
        /* Copy URL (truncate to fit) */
        int n = 0;
        while (url[n] && n < 127) { _srcmaps[i].url[n] = url[n]; n++; }
        _srcmaps[i].url[n] = '\0';
        _srcmaps[i].map = JS_DupValue(c, av[1]);
    }
    JS_FreeCString(c, url);
    return JS_NewBool(c, 1);
}

static JSValue js_sourcemap_lookup(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    if (_ac < 1) return JS_NULL;
    const char *url = JS_ToCString(c, av[0]);
    if (!url) return JS_NULL;
    for (int i = 0; i < _srcmap_count; i++) {
        int match = 1;
        for (int j = 0; _srcmaps[i].url[j] || url[j]; j++) {
            if (_srcmaps[i].url[j] != url[j]) { match = 0; break; }
        }
        if (match) { JS_FreeCString(c, url); return JS_DupValue(c, _srcmaps[i].map); }
    }
    JS_FreeCString(c, url);
    return JS_NULL;
}

/* ── Item 124: Remote DevTools Protocol stub ─────────────────────────────── */
/* Stub: exposes a JSON-RPC endpoint over COM2 (0x2F8).  Real implementation
 * would parse Chrome DevTools Protocol messages and forward to QuickJS
 * inspector hooks.                                                          */
static JSValue js_devtools_enable(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    platform_serial_puts("[DevTools] CDP stub enabled on COM2 (not implemented)\n");
    return JS_NewBool(c, 0);  /* Not yet available */
}

/* ── Item 125: BigInt64Array / BigUint64Array ───────────────────────────── */
/* QuickJS already implements BigInt64Array and BigUint64Array natively as
 * part of the TypedArray bigint extension.  This binding just exposes a
 * probe so TypeScript can verify availability.                              */
static JSValue js_bigint64array_test(JSContext *c, JSValueConst _t, int _ac, JSValueConst *_av) {
    (void)_t; (void)_ac; (void)_av;
    /* Evaluate a quick test to see if BigInt64Array is available */
    JSValue r = JS_Eval(c, "typeof BigInt64Array !== 'undefined'", 36,
                        "<bigint64_test>", JS_EVAL_TYPE_GLOBAL);
    return r;
}

/* ── Items 126-127: WASM interpreter stub ───────────────────────────────── */
/* A minimal stub that accepts a WASM binary buffer and either interprets it
 * (item 126: wasm3/wabt binding) or JIT-compiles it (item 127).
 * Real implementation would integrate wasm3 or a custom WASM JIT.         */
static JSValue js_wasm_instantiate(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    platform_serial_puts("[WASM] wasm_instantiate() stub — not yet implemented\n");
    if (_ac < 1) return JS_ThrowTypeError(c, "Expected ArrayBuffer");
    /* Return null to indicate failure */
    return JS_NULL;
}

static JSValue js_wasm_jit_compile(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    platform_serial_puts("[WASM-JIT] wasm_jit_compile() stub — not yet implemented\n");
    if (_ac < 1) return JS_ThrowTypeError(c, "Expected ArrayBuffer");
    return JS_NULL;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * FPU / SSE CONTEXT SAVE & RESTORE — item 147
 *
 * C provides three thin hardware primitives; ALL scheduling policy lives in TS.
 *
 *   fpuAllocState()          → allocate a 512-byte 16-byte-aligned state buffer
 *   fpuSave(physAddr)        → FXSAVE to the buffer (returns bool success)
 *   fpuRestore(physAddr)     → FXRSTOR from the buffer (returns bool success)
 *
 * FXSAVE/FXRSTOR require the target address to be 16-byte aligned.
 * alloc_page() returns a 4096-byte-aligned physical page, so alignment is
 * always satisfied.  Only the first 512 bytes of the page are used.
 * ═══════════════════════════════════════════════════════════════════════════ */

static JSValue js_fpu_alloc_state(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t; (void)_ac; (void)av;
    /* alloc_page() returns physical page number; each page is 4 KB = 16-byte aligned */
    uint32_t page = alloc_page();
    if (page == (uint32_t)-1) return JS_NewInt32(c, 0);   /* 0 = OOM sentinel */
    /* Zero the 512-byte FXSAVE area so FXRSTOR finds a valid initial state */
    uint8_t *buf = (uint8_t *)(uintptr_t)(page * 4096);
    for (int i = 0; i < 512; i++) buf[i] = 0;
    return JS_NewInt32(c, (int32_t)(page * 4096));
}

static JSValue js_fpu_save(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    if (_ac < 1) return JS_NewBool(c, 0);
    uint32_t addr;
    if (JS_ToUint32(c, &addr, av[0])) return JS_EXCEPTION;
    if (!addr || (addr & 0xF)) return JS_NewBool(c, 0);    /* must be 16-byte aligned */
    __asm__ volatile("fxsave (%0)" :: "r"((void *)(uintptr_t)addr) : "memory");
    return JS_NewBool(c, 1);
}

static JSValue js_fpu_restore(JSContext *c, JSValueConst _t, int _ac, JSValueConst *av) {
    (void)_t;
    if (_ac < 1) return JS_NewBool(c, 0);
    uint32_t addr;
    if (JS_ToUint32(c, &addr, av[0])) return JS_EXCEPTION;
    if (!addr || (addr & 0xF)) return JS_NewBool(c, 0);    /* must be 16-byte aligned */
    __asm__ volatile("fxrstor (%0)" :: "r"((void *)(uintptr_t)addr) : "memory");
    return JS_NewBool(c, 1);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * MODULE LOADER — item 118 (filesystem import()) + item 119 (@jsos/* pkgs)
 * ═══════════════════════════════════════════════════════════════════════════ */

/* JS-registered callback: (path: string) => string | null
 * Registered by the TS OS once the VFS is ready, via kernel.setModuleReader() */
static JSValue _module_fs_read_cb; /* initialised to JS_UNDEFINED in quickjs_initialize */

/* Built-in @jsos/ packages that forward to the matching sys.* sub-objects
 * already present on globalThis after the OS has booted (item 119). */
static const struct { const char *name; const char *src; } _jsos_builtins[] = {
    { "@jsos/net",     "export default globalThis.sys?.net;"     },
    { "@jsos/fs",      "export default globalThis.sys?.fs;"      },
    { "@jsos/proc",    "export default globalThis.sys?.proc;"    },
    { "@jsos/ui",      "export default globalThis.sys?.ui;"      },
    { "@jsos/ipc",     "export default globalThis.sys?.ipc;"     },
    { "@jsos/storage", "export default globalThis.sys?.storage;" },
    { "@jsos/crypto",  "export default globalThis.sys?.crypto;"  },
    { "@jsos/http",    "export default globalThis.sys?.http;"    },
    { NULL, NULL }
};

/* Normalize module specifier: resolve relative paths against the importing
 * module's directory.  @jsos/ and absolute paths pass through unchanged. */
static char *_module_normalize(JSContext *c,
                                const char *base, const char *name,
                                void *opaque __attribute__((unused)))
{
    /* @jsos/ built-in packages — return unchanged */
    if (name[0] == '@') return js_strdup(c, name);
    /* Absolute paths — return unchanged */
    if (name[0] == '/') return js_strdup(c, name);
    /* Relative specifiers — join with importing module's directory */
    if (base && name[0] == '.') {
        const char *last_slash = NULL;
        const char *p = base;
        while (*p) { if (*p == '/') last_slash = p; p++; }
        if (last_slash) {
            size_t dir_len = (size_t)(last_slash - base) + 1; /* include '/' */
            size_t nm_len  = strlen(name);
            char  *out     = js_malloc(c, dir_len + nm_len + 1);
            if (!out) return NULL;
            memcpy(out, base, dir_len);
            memcpy(out + dir_len, name, nm_len + 1);
            return out;
        }
    }
    return js_strdup(c, name);
}

/* Load a module by its normalised name.  Priority:
 *  1. @jsos/* built-in packages (item 119)
 *  2. Filesystem source via registered JS reader callback (item 118) */
static JSModuleDef *_module_load(JSContext *c, const char *name,
                                  void *opaque __attribute__((unused)))
{
    const char *src = NULL;

    /* 1. Check @jsos/ built-in packages */
    for (int i = 0; _jsos_builtins[i].name; i++) {
        if (strcmp(name, _jsos_builtins[i].name) == 0) {
            src = _jsos_builtins[i].src;
            break;
        }
    }

    /* 2. Filesystem path via JS-registered reader (item 118) */
    const char *fs_cstr = NULL;
    JSValue     fs_ret  = JS_UNDEFINED;
    if (!src && !JS_IsUndefined(_module_fs_read_cb)) {
        JSValue arg = JS_NewString(c, name);
        fs_ret = JS_Call(c, _module_fs_read_cb, JS_UNDEFINED, 1, &arg);
        JS_FreeValue(c, arg);
        if (!JS_IsException(fs_ret) && JS_IsString(fs_ret)) {
            fs_cstr = JS_ToCString(c, fs_ret);
            src = fs_cstr;
        }
    }

    if (!src) {
        if (!JS_IsUndefined(fs_ret)) JS_FreeValue(c, fs_ret);
        JS_ThrowReferenceError(c, "cannot load module '%s'", name);
        return NULL;
    }

    /* Compile module source — compile-only; runtime evaluates on demand */
    JSValue compiled = JS_Eval(c, src, strlen(src), name,
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (fs_cstr) JS_FreeCString(c, fs_cstr);
    JS_FreeValue(c, fs_ret);

    if (JS_IsException(compiled)) return NULL;

    /* Extract raw pointer — do NOT JS_FreeValue; runtime now owns this def */
    JSModuleDef *m = JS_VALUE_GET_PTR(compiled);
    return m;
}

/* kernel.setModuleReader(fn: (path: string) => string | null)
 * Called by the TS OS after the VFS is ready.  fn must return the UTF-8
 * source text for the given path, or null if the file does not exist. */
static JSValue js_set_module_reader(JSContext *c,
                                     JSValueConst this_val __attribute__((unused)),
                                     int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsFunction(c, argv[0]))
        return JS_ThrowTypeError(c, "setModuleReader: expected a function");
    if (!JS_IsUndefined(_module_fs_read_cb))
        JS_FreeValue(c, _module_fs_read_cb);
    _module_fs_read_cb = JS_DupValue(c, argv[0]);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry js_kernel_funcs[] = {
    /* VGA raw access */
    JS_CFUNC_DEF("vgaPut",        4, js_vga_put),
    JS_CFUNC_DEF("vgaGet",        2, js_vga_get),
    JS_CFUNC_DEF("vgaDrawRow",    3, js_vga_draw_row),
    JS_CFUNC_DEF("vgaCopyRow",    2, js_vga_copy_row),
    JS_CFUNC_DEF("vgaFillRow",    3, js_vga_fill_row),
    JS_CFUNC_DEF("vgaFill",       2, js_vga_fill),
    JS_CFUNC_DEF("vgaSetCursor",  2, js_vga_set_cursor),
    JS_CFUNC_DEF("vgaHideCursor", 0, js_vga_hide_cursor),
    JS_CFUNC_DEF("vgaShowCursor", 0, js_vga_show_cursor),
    JS_CFUNC_DEF("getScreenSize", 0, js_get_screen_size),
    /* Keyboard */
    JS_CFUNC_DEF("readKey",    0, js_read_key),
    JS_CFUNC_DEF("readKeyEx",  0, js_read_key_ex),
    JS_CFUNC_DEF("waitKey",    0, js_wait_key),
    JS_CFUNC_DEF("waitKeyEx",  0, js_wait_key_ex),
    JS_CFUNC_DEF("hasKey",     0, js_has_key),
    /* Timer */
    JS_CFUNC_DEF("getTicks",  0, js_get_ticks),
    JS_CFUNC_DEF("getUptime", 0, js_get_uptime),
    JS_CFUNC_DEF("sleep",     1, js_sleep),
    /* Memory */
    JS_CFUNC_DEF("getMemoryInfo", 0, js_mem_info),
    /* Port I/O */
    JS_CFUNC_DEF("inb",  1, js_inb),
    JS_CFUNC_DEF("outb", 2, js_outb),
    /* Native execution */
    JS_CFUNC_DEF("callNative",  1, js_call_native),
    JS_CFUNC_DEF("callNativeI", 4, js_call_native_i),
    JS_CFUNC_DEF("readMem8",    1, js_read_mem8),
    JS_CFUNC_DEF("writeMem8",   2, js_write_mem8),
    /* Step 2: Physical memory bulk access */
    JS_CFUNC_DEF("readPhysMem",  2, js_read_phys_mem),
    JS_CFUNC_DEF("writePhysMem", 2, js_write_phys_mem),
    /* Step 3: QuickJS struct offsets probe */
    JS_CFUNC_DEF("qjsOffsets",   0, js_qjs_offsets),
    /* System */
    JS_CFUNC_DEF("halt",   0, js_halt),
    JS_CFUNC_DEF("reboot", 0, js_reboot),
    JS_CFUNC_DEF("gc",     0, js_gc),
    /* Serial */
    JS_CFUNC_DEF("serialPut",     1, js_serial_put),
    JS_CFUNC_DEF("serialGetchar", 0, js_serial_getchar),
    /* Eval */
    JS_CFUNC_DEF("eval",   1, js_eval),
    /* ATA block device */
    JS_CFUNC_DEF("ataPresent",     0, js_ata_present),
    JS_CFUNC_DEF("ataSectorCount", 0, js_ata_sector_count),
    JS_CFUNC_DEF("ataRead",        2, js_ata_read),
    JS_CFUNC_DEF("ataWrite",       3, js_ata_write),
    /* Framebuffer (Phase 3) */
    JS_CFUNC_DEF("fbInfo",       0, js_fb_info),
    JS_CFUNC_DEF("fbBlit",       5, js_fb_blit),
    /* Volatile ASM execution */
    JS_CFUNC_DEF("volatileAsm",  1, js_volatile_asm),
    /* Mouse (Phase 3) */
    JS_CFUNC_DEF("readMouse",    0, js_read_mouse),
    /* Memory map + paging (Phase 4) */
    JS_CFUNC_DEF("getRamBytes",    0, js_get_ram_bytes),
    JS_CFUNC_DEF("getMemoryMap",  0, js_get_memory_map),
    JS_CFUNC_DEF("setPDPT",       1, js_set_pdpt),
    JS_CFUNC_DEF("flushTLB",      0, js_flush_tlb),
    JS_CFUNC_DEF("setPageEntry",  4, js_set_page_entry),
    JS_CFUNC_DEF("enablePaging",  0, js_enable_paging),
    /* Scheduler hook + TSS (Phase 5) */
    JS_CFUNC_DEF("registerSchedulerHook", 1, js_register_scheduler_hook),
    JS_CFUNC_DEF("yield",                 0, js_yield),
    JS_CFUNC_DEF("schedTick",             0, js_sched_tick),
    JS_CFUNC_DEF("tssSetESP0",            1, js_tss_set_esp0),
    /* Process primitives (Phase 6) */
    JS_CFUNC_DEF("cloneAddressSpace",  0, js_clone_address_space),
    JS_CFUNC_DEF("jumpToUserMode",     2, js_jump_to_user_mode),
    JS_CFUNC_DEF("getPageFaultAddr",   0, js_get_page_fault_addr),
    /* Network (Phase 7) */
    JS_CFUNC_DEF("netInit",       0, js_net_init),
    JS_CFUNC_DEF("netSendFrame",  1, js_net_send_frame),
    JS_CFUNC_DEF("netRecvFrame",  0, js_net_recv_frame),
    JS_CFUNC_DEF("netMacAddress", 0, js_net_mac_address),
    JS_CFUNC_DEF("netPciAddr",    0, js_net_pci_addr),
    JS_CFUNC_DEF("netDebugRxIdx", 0, js_net_debug_rx_used_idx),
    JS_CFUNC_DEF("netDebugInfo",   0, js_net_debug_info),
    JS_CFUNC_DEF("netDebugStatus", 0, js_net_debug_status),
    JS_CFUNC_DEF("netDebugQueues", 0, js_net_debug_queues),
    /* Multi-process (Phase 10) */
    JS_CFUNC_DEF("procCreate",    0, js_proc_create),
    JS_CFUNC_DEF("procEval",      2, js_proc_eval),
    JS_CFUNC_DEF("procEvalSlice", 3, js_proc_eval_slice),
    JS_CFUNC_DEF("procTick",      1, js_proc_tick),
    JS_CFUNC_DEF("procSend",      2, js_proc_send),
    JS_CFUNC_DEF("procRecv",      1, js_proc_recv),
    JS_CFUNC_DEF("procDestroy",   1, js_proc_destroy),
    JS_CFUNC_DEF("procAlive",     1, js_proc_alive),
    JS_CFUNC_DEF("procList",      0, js_proc_list),
    /* Shared memory (Phase 10) */
    JS_CFUNC_DEF("sharedBufferCreate",  1, js_shared_buf_create),
    JS_CFUNC_DEF("sharedBufferOpen",    1, js_shared_buf_open),
    JS_CFUNC_DEF("sharedBufferRelease", 1, js_shared_buf_release),
    JS_CFUNC_DEF("sharedBufferSize",    1, js_shared_buf_size),
    /* JIT compiler primitives (Phase 11) */
    JS_CFUNC_DEF("jitAlloc",     1, js_jit_alloc),
    JS_CFUNC_DEF("jitWrite",     2, js_jit_write),
    JS_CFUNC_DEF("jitCallI",     5, js_jit_call_i),
    JS_CFUNC_DEF("jitCallI8",    9, js_jit_call_i8),
    JS_CFUNC_DEF("jitCallF4",    5, js_jit_call_f),
    JS_CFUNC_DEF("jitUsedBytes",   0, js_jit_used_bytes),
    JS_CFUNC_DEF("jitMainReset",   0, js_jit_main_reset),
    JS_CFUNC_DEF("physAddrOf",   1, js_physaddr_of),
    JS_CFUNC_DEF("jitHelperAddrs", 0, js_jit_get_helper_addrs),
    /* Step 5: QJS JIT hook + per-process JIT management */
    JS_CFUNC_DEF("setJITHook",    1, js_set_jit_hook),
    JS_CFUNC_DEF("setJITNative",  2, js_set_jit_native),
    JS_CFUNC_DEF("procPendingJIT",1, js_proc_pending_jit),
    JS_CFUNC_DEF("jitProcAlloc",  2, js_jit_proc_alloc),
    /* Phase A/B: render surface + child runtime infrastructure */
    JS_CFUNC_DEF("getProcRenderBuffer",    1, js_get_proc_render_buf),
    JS_CFUNC_DEF("procSetDimensions",      3, js_proc_set_dimensions),
    JS_CFUNC_DEF("registerChildFSBridge",  1, js_register_child_fs_bridge),
    JS_CFUNC_DEF("procSendEvent",          2, js_proc_send_event),
    JS_CFUNC_DEF("procDequeueWindowCommand", 1, js_proc_dequeue_window_cmd),
    JS_CFUNC_DEF("serviceTimers",          1, js_service_timers),
    /* New subsystem bindings (items 8, 4, 33, 34, 46, 50, 104, 105, 106, 118-127) */
    JS_CFUNC_DEF("tscHz",         0, js_tsc_hz),
    JS_CFUNC_DEF("rtcRead",       0, js_rtc_read),
    JS_CFUNC_DEF("setWallClock",  1, js_set_wall_clock),   /* item 51 NTP */
    JS_CFUNC_DEF("getWallClock",  0, js_get_wall_clock),   /* item 51 NTP */
    JS_CFUNC_DEF("allocPage",     0, js_alloc_page),
    JS_CFUNC_DEF("freePage",      1, js_free_page),
    JS_CFUNC_DEF("pagesFree",     0, js_pages_free),
    JS_CFUNC_DEF("acpiShutdown",  0, js_acpi_shutdown),
    JS_CFUNC_DEF("acpiReboot",    0, js_acpi_reboot),
    JS_CFUNC_DEF("symLookup",     1, js_sym_lookup),
    JS_CFUNC_DEF("cmdlineGet",          1, js_cmdline_get),
    JS_CFUNC_DEF("cpuidInfo",           0, js_cpuid_info),
    /* High-resolution time (item 48) */
    JS_CFUNC_DEF("getTimeNs",           0, js_gettime_ns),
    JS_CFUNC_DEF("uptimeUs",            0, js_uptime_us),
    /* MMIO region reservation (item 40) */
    JS_CFUNC_DEF("reserveRegion",       2, js_reserve_region),
    /* LAPIC Task Priority Register (item 26) */
    JS_CFUNC_DEF("irqSetTpr",           1, js_irq_set_tpr),
    /* HPET (item 47) */
    JS_CFUNC_DEF("hpetInit",            1, js_hpet_init),
    JS_CFUNC_DEF("hpetRead",            0, js_hpet_read),
    JS_CFUNC_DEF("hpetFreq",            0, js_hpet_freq),
    /* ATAPI (item 80) */
    JS_CFUNC_DEF("ataIsAtapi",          0, js_ata_is_atapi),
    /* VirtIO-BLK (item 81) */
    JS_CFUNC_DEF("virtioBlkPresent",    0, js_virtio_blk_present),
    JS_CFUNC_DEF("virtioBlkSectors",    0, js_virtio_blk_sectors),
    /* VirtIO-GPU (item 68) */
    JS_CFUNC_DEF("virtioGpuPresent",    0, js_virtio_gpu_present),
    /* APIC / IOAPIC / APIC timer (items 24, 28, 49) */
    JS_CFUNC_DEF("apicInit",            0, js_apic_init),
    JS_CFUNC_DEF("apicEoi",             0, js_apic_eoi),
    JS_CFUNC_DEF("apicTimerCalibrate",  0, js_apic_timer_calibrate),
    JS_CFUNC_DEF("apicTimerStart",      1, js_apic_timer_start),
    JS_CFUNC_DEF("ioapicInit",          1, js_ioapic_init),
    JS_CFUNC_DEF("ioapicUnmask",        1, js_ioapic_unmask),
    /* NVMe (item 82) */
    JS_CFUNC_DEF("nvmeInit",            0, js_nvme_init),
    JS_CFUNC_DEF("nvmePresent",         0, js_nvme_present),
    JS_CFUNC_DEF("nvmeEnable",          0, js_nvme_enable),
    /* AHCI (item 83) */
    JS_CFUNC_DEF("ahciInit",            0, js_ahci_init),
    JS_CFUNC_DEF("ahciPresent",         0, js_ahci_present),
    /* Memory extensions (items 37, 38, 39, 42, 44) */
    JS_CFUNC_DEF("memoryEnablePae",     0, js_mem_enable_pae),
    JS_CFUNC_DEF("memoryEnableNx",      0, js_mem_enable_nx),
    JS_CFUNC_DEF("memoryTlbFlush",      1, js_mem_tlb_flush),
    JS_CFUNC_DEF("memoryTlbFlushAll",   0, js_mem_tlb_flush_all),
    JS_CFUNC_DEF("memoryEnableLargePages", 0, js_mem_large_page_en),
    JS_CFUNC_DEF("memoryHotplugAdd",    2, js_mem_hotplug_add),
    /* ACPI PM timer (item 52) */
    JS_CFUNC_DEF("acpiPmTimer",         0, js_acpi_pm_timer),
    /* Display extras (items 69-72) */
    JS_CFUNC_DEF("fbAllocBackbuffer",   0, js_fb_alloc_backbuf),
    JS_CFUNC_DEF("fbFlip",              0, js_fb_flip),
    JS_CFUNC_DEF("vsyncWait",           0, js_vsync_wait),
    JS_CFUNC_DEF("cursorEnable",        1, js_cursor_enable),
    JS_CFUNC_DEF("cursorSetPos",        2, js_cursor_set_pos),
    JS_CFUNC_DEF("dpmsSet",             1, js_dpms_set),
    /* Keyboard layout (items 60-62) */
    JS_CFUNC_DEF("kbLayoutSet",         1, js_kb_layout_set),
    JS_CFUNC_DEF("kbLayoutGet",         0, js_kb_layout_get),
    JS_CFUNC_DEF("kbImeEnable",         1, js_kb_ime_enable),
    /* Selftest (item 108) */
    JS_CFUNC_DEF("selftestRun",         0, js_selftest_run),
    /* kprobes (item 110) */
    JS_CFUNC_DEF("kprobesInit",         0, js_kprobes_init),
    JS_CFUNC_DEF("kprobesDump",         0, js_kprobes_dump),
    /* debugger → serial (item 123) */
    JS_CFUNC_DEF("debugBreak",          0, js_debug_break),
    /* SourceMap registry (item 122) */
    JS_CFUNC_DEF("sourceMapRegister",   2, js_sourcemap_register),
    JS_CFUNC_DEF("sourceMapLookup",     1, js_sourcemap_lookup),
    /* Remote DevTools stub (item 124) */
    JS_CFUNC_DEF("devToolsEnable",      0, js_devtools_enable),
    /* BigInt64Array availability probe (item 125) */
    JS_CFUNC_DEF("bigInt64ArrayTest",   0, js_bigint64array_test),
    /* WASM stubs (items 126-127) */
    JS_CFUNC_DEF("wasmInstantiate",     1, js_wasm_instantiate),
    JS_CFUNC_DEF("wasmJitCompile",      1, js_wasm_jit_compile),
    /* Module loader registration (items 118, 119) */
    JS_CFUNC_DEF("setModuleReader",     1, js_set_module_reader),
    /* FPU/SSE context save/restore (item 147) */
    JS_CFUNC_DEF("fpuAllocState",       0, js_fpu_alloc_state),
    JS_CFUNC_DEF("fpuSave",             1, js_fpu_save),
    JS_CFUNC_DEF("fpuRestore",          1, js_fpu_restore),
    /* Hardware RDRAND instruction (item 348) */
    JS_CFUNC_DEF("rdrand",              0, js_rdrand),
};

/*  Initialization  */

int quickjs_initialize(void) {
    /* Probe ATA before starting QuickJS */
    ata_initialize();
    if (ata_present()) {
        ata_enable_irq();   /* switch to IRQ14-driven mode (item 78) */
        platform_boot_print("[ATA] IRQ-driven mode enabled\n");
    } else {
        platform_boot_print("[ATA] No drive\n");
    }

    rt = JS_NewRuntime();
    if (!rt) return -1;

    JS_SetMemoryLimit(rt, 512u * 1024u * 1024u); /* 512 MB — main runtime: JS bundle + DOM + net stack + JIT */
    JS_SetGCThreshold(rt, 128u * 1024u * 1024u); /* GC at 128 MB to avoid hitting the cap */
    JS_SetMaxStackSize(rt, 512 * 1024);           /* 512 KB stack — TCP/IP state machine recurses deeply */

    /* Wire dynamic import() module loader (items 118 + 119) */
    JS_SetModuleLoaderFunc(rt, _module_normalize, _module_load, NULL);

    /* ── Item 120: SharedArrayBuffer via JS_SetSharedArrayBufferFunctions ─
     * Single-threaded OS: alloc/free use the QuickJS runtime allocator;
     * dup is a no-op (no reference counting needed).                      */
    {
        static const JSSharedArrayBufferFunctions _sab_fns = {
            /* sab_alloc/free/dup are resolved at link time in C99/C11 via
             * a thin wrapper because the rt pointer is not yet available
             * at static init time.  We rely on the callback receiving
             * rt itself as the opaque pointer.                            */
            .sab_alloc  = NULL,   /* QuickJS uses fallback js_malloc when NULL */
            .sab_free   = NULL,
            .sab_dup    = NULL,
            .sab_opaque = NULL,
        };
        JS_SetSharedArrayBufferFunctions(rt, &_sab_fns);
    }

    /* ── Item 121: Atomics.wait() — declare single-threaded can_block ─── */
    JS_SetCanBlock(rt, 1);

    ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); rt = NULL; return -1; }

    /* Phase 5: initialise scheduler hook slot + TSS data structure */
    _scheduler_hook      = JS_UNDEFINED;
    _fs_bridge_obj       = JS_UNDEFINED;
    _module_fs_read_cb   = JS_UNDEFINED;  /* module loader reader (items 118/119) */
    /* Step 5: JIT hook globals */
    _jit_ts_callback = JS_UNDEFINED;
    _in_jit_hook     = 0;
    memset(_jit_proc_pending, 0, sizeof(_jit_proc_pending));
    platform_tss_init();

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue kobj   = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, kobj, js_kernel_funcs,
        sizeof(js_kernel_funcs) / sizeof(js_kernel_funcs[0]));

    /* VGA color constants */
    JSValue colors = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, colors, "BLACK",         JS_NewInt32(ctx,  0));
    JS_SetPropertyStr(ctx, colors, "BLUE",          JS_NewInt32(ctx,  1));
    JS_SetPropertyStr(ctx, colors, "GREEN",         JS_NewInt32(ctx,  2));
    JS_SetPropertyStr(ctx, colors, "CYAN",          JS_NewInt32(ctx,  3));
    JS_SetPropertyStr(ctx, colors, "RED",           JS_NewInt32(ctx,  4));
    JS_SetPropertyStr(ctx, colors, "MAGENTA",       JS_NewInt32(ctx,  5));
    JS_SetPropertyStr(ctx, colors, "BROWN",         JS_NewInt32(ctx,  6));
    JS_SetPropertyStr(ctx, colors, "LIGHT_GREY",    JS_NewInt32(ctx,  7));
    JS_SetPropertyStr(ctx, colors, "DARK_GREY",     JS_NewInt32(ctx,  8));
    JS_SetPropertyStr(ctx, colors, "LIGHT_BLUE",    JS_NewInt32(ctx,  9));
    JS_SetPropertyStr(ctx, colors, "LIGHT_GREEN",   JS_NewInt32(ctx, 10));
    JS_SetPropertyStr(ctx, colors, "LIGHT_CYAN",    JS_NewInt32(ctx, 11));
    JS_SetPropertyStr(ctx, colors, "LIGHT_RED",     JS_NewInt32(ctx, 12));
    JS_SetPropertyStr(ctx, colors, "LIGHT_MAGENTA", JS_NewInt32(ctx, 13));
    JS_SetPropertyStr(ctx, colors, "YELLOW",        JS_NewInt32(ctx, 14));
    JS_SetPropertyStr(ctx, colors, "WHITE",         JS_NewInt32(ctx, 15));
    JS_SetPropertyStr(ctx, kobj, "colors", colors);

    /* Extended key code constants */
    JS_SetPropertyStr(ctx, kobj, "KEY_UP",       JS_NewInt32(ctx, 0x80));
    JS_SetPropertyStr(ctx, kobj, "KEY_DOWN",     JS_NewInt32(ctx, 0x81));
    JS_SetPropertyStr(ctx, kobj, "KEY_LEFT",     JS_NewInt32(ctx, 0x82));
    JS_SetPropertyStr(ctx, kobj, "KEY_RIGHT",    JS_NewInt32(ctx, 0x83));
    JS_SetPropertyStr(ctx, kobj, "KEY_HOME",     JS_NewInt32(ctx, 0x84));
    JS_SetPropertyStr(ctx, kobj, "KEY_END",      JS_NewInt32(ctx, 0x85));
    JS_SetPropertyStr(ctx, kobj, "KEY_PAGEUP",   JS_NewInt32(ctx, 0x86));
    JS_SetPropertyStr(ctx, kobj, "KEY_PAGEDOWN", JS_NewInt32(ctx, 0x87));
    JS_SetPropertyStr(ctx, kobj, "KEY_DELETE",   JS_NewInt32(ctx, 0x88));
    JS_SetPropertyStr(ctx, kobj, "KEY_F1",       JS_NewInt32(ctx, 0x90));
    JS_SetPropertyStr(ctx, kobj, "KEY_F2",       JS_NewInt32(ctx, 0x91));
    JS_SetPropertyStr(ctx, kobj, "KEY_F3",       JS_NewInt32(ctx, 0x92));
    JS_SetPropertyStr(ctx, kobj, "KEY_F4",       JS_NewInt32(ctx, 0x93));
    JS_SetPropertyStr(ctx, kobj, "KEY_F5",       JS_NewInt32(ctx, 0x94));
    JS_SetPropertyStr(ctx, kobj, "KEY_F6",       JS_NewInt32(ctx, 0x95));
    JS_SetPropertyStr(ctx, kobj, "KEY_F7",       JS_NewInt32(ctx, 0x96));
    JS_SetPropertyStr(ctx, kobj, "KEY_F8",       JS_NewInt32(ctx, 0x97));
    JS_SetPropertyStr(ctx, kobj, "KEY_F9",       JS_NewInt32(ctx, 0x98));
    JS_SetPropertyStr(ctx, kobj, "KEY_F10",      JS_NewInt32(ctx, 0x99));
    JS_SetPropertyStr(ctx, kobj, "KEY_F11",      JS_NewInt32(ctx, 0x9A));
    JS_SetPropertyStr(ctx, kobj, "KEY_F12",      JS_NewInt32(ctx, 0x9B));

    JS_SetPropertyStr(ctx, kobj, "screenWidth",  JS_NewInt32(ctx, platform_vga_width()));
    JS_SetPropertyStr(ctx, kobj, "screenHeight", JS_NewInt32(ctx, platform_vga_height()));

    JS_SetPropertyStr(ctx, global, "kernel", kobj);

    const char *stub =
        "var console={log:function(){},error:function(){},warn:function(){},clear:function(){}};"
        "Date.now=function(){return kernel.getUptime();};";
    JSValue init = JS_Eval(ctx, stub, strlen(stub), "<init>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, init);
    JS_FreeValue(ctx, global);
    return 0;
}

int quickjs_run_os(void) {
    if (!ctx) return -1;
    JSValue result = JS_Eval(ctx, embedded_js_code, strlen(embedded_js_code),
                             "jsos.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);
        const char *err = JS_ToCString(ctx, exc);
        platform_boot_print("JavaScript Error: ");
        platform_boot_print(err ? err : "(null exception)");
        platform_boot_print("\n");
        if (err) JS_FreeCString(ctx, err);
        /* Print stack trace if available */
        if (JS_IsObject(exc)) {
            JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
            if (!JS_IsUndefined(stack) && !JS_IsNull(stack)) {
                const char *stk = JS_ToCString(ctx, stack);
                if (stk) {
                    platform_boot_print(stk);
                    platform_boot_print("\n");
                    JS_FreeCString(ctx, stk);
                }
            }
            JS_FreeValue(ctx, stack);
        }
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, result);
        return -1;
    }
    JS_FreeValue(ctx, result);
    return 0;
}

void quickjs_cleanup(void) {
    if (ctx) { JS_FreeContext(ctx); ctx = NULL; }
    if (rt)  { JS_FreeRuntime(rt);  rt  = NULL; }
}
