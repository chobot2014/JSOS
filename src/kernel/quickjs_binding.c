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
 * kernel.netRecvFrame() → number[] | null
 * Poll the NIC for one received Ethernet frame.
 * Returns null when the RX ring is empty.
 */
static JSValue js_net_recv_frame(JSContext *c, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    uint16_t frame_len = virtio_net_recv(_net_recv_buf);
    if (frame_len == 0) return JS_NULL;
    JSValue arr = JS_NewArray(c);
    for (int i = 0; i < (int)frame_len; i++)
        JS_SetPropertyUint32(c, arr, (uint32_t)i,
                             JS_NewInt32(c, _net_recv_buf[i]));
    return arr;
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

    /* Return flat byte array (length = secs * 512) */
    int total = secs * 512;
    JSValue arr = JS_NewArray(c);
    uint8_t *bytes = (uint8_t *)ata_sector_buf;
    for (int i = 0; i < total; i++)
        JS_SetPropertyUint32(c, arr, (uint32_t)i, JS_NewInt32(c, bytes[i]));
    return arr;
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
    for (int i = 0; i < total; i++) {
        JSValue v = JS_GetPropertyUint32(c, argv[2], (uint32_t)i);
        int32_t b = 0;
        JS_ToInt32(c, &b, v);
        JS_FreeValue(c, v);
        bytes[i] = (uint8_t)b;
    }
    return JS_NewBool(c, ata_write28(lba, (uint8_t)secs, ata_sector_buf) == 0);
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
    JS_CFUNC_DEF("readKey",   0, js_read_key),
    JS_CFUNC_DEF("waitKey",   0, js_wait_key),
    JS_CFUNC_DEF("waitKeyEx", 0, js_wait_key_ex),
    JS_CFUNC_DEF("hasKey",    0, js_has_key),
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
    /* System */
    JS_CFUNC_DEF("halt",   0, js_halt),
    JS_CFUNC_DEF("reboot", 0, js_reboot),
    /* Serial */
    JS_CFUNC_DEF("serialPut",     1, js_serial_put),
    JS_CFUNC_DEF("serialGetchar", 0, js_serial_getchar),
    /* Eval */
    JS_CFUNC_DEF("eval",   1, js_eval),
    /* ATA block device */
    JS_CFUNC_DEF("ataPresent", 0, js_ata_present),
    JS_CFUNC_DEF("ataRead",    2, js_ata_read),
    JS_CFUNC_DEF("ataWrite",   3, js_ata_write),
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
};

/*  Initialization  */

int quickjs_initialize(void) {
    /* Probe ATA before starting QuickJS */
    ata_initialize();
    platform_boot_print(ata_present() ? "ATA disk detected\n"
                                      : "[ATA] No drive\n");

    rt = JS_NewRuntime();
    if (!rt) return -1;

    JS_SetMemoryLimit(rt, 50 * 1024 * 1024);  /* 50 MB — Phase 3 needs space for framebuffer */
    JS_SetMaxStackSize(rt, 256 * 1024);

    ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); rt = NULL; return -1; }

    /* Phase 5: initialise scheduler hook slot + TSS data structure */
    _scheduler_hook = JS_UNDEFINED;
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
