/*
 * JSOS QuickJS Binding Layer
 *
 * Exposes kernel hardware APIs to JavaScript via the QuickJS ES2023 engine.
 * All functions are registered on the global `kernel` object.
 */

#include "quickjs.h"
#include "terminal.h"
#include "memory.h"
#include "keyboard.h"
#include "timer.h"
#include "io.h"
#include "embedded_js.h"
#include <stdint.h>
#include <stddef.h>
#include <string.h>

static JSRuntime *rt = NULL;
static JSContext *ctx = NULL;

/* ============================================================
 * Kernel API functions exposed to JavaScript
 * ============================================================ */

/* --- Terminal / Print --- */

static JSValue js_kernel_print(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) {
        terminal_writestring(msg);
        terminal_writestring("\n");
        JS_FreeCString(ctx, msg);
    }
    return JS_UNDEFINED;
}

static JSValue js_kernel_print_raw(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *msg = JS_ToCString(ctx, argv[0]);
    if (msg) {
        terminal_writestring(msg);
        JS_FreeCString(ctx, msg);
    }
    return JS_UNDEFINED;
}

static JSValue js_kernel_putchar(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    const char *s = JS_ToCString(ctx, argv[0]);
    if (s && s[0]) {
        terminal_putchar(s[0]);
    }
    if (s) JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue js_kernel_clear(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    terminal_clear();
    return JS_UNDEFINED;
}

/* --- Terminal Colors --- */

static JSValue js_kernel_set_color(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    int32_t fg, bg;
    JS_ToInt32(ctx, &fg, argv[0]);
    JS_ToInt32(ctx, &bg, argv[1]);
    terminal_setcolor_fg_bg((uint8_t)fg, (uint8_t)bg);
    return JS_UNDEFINED;
}

static JSValue js_kernel_get_color(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, terminal_getcolor());
}

static JSValue js_kernel_set_cursor(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    int32_t row, col;
    JS_ToInt32(ctx, &row, argv[0]);
    JS_ToInt32(ctx, &col, argv[1]);
    terminal_set_cursor((size_t)row, (size_t)col);
    return JS_UNDEFINED;
}

static JSValue js_kernel_get_cursor(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    size_t row, col;
    terminal_get_cursor(&row, &col);
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "row", JS_NewInt32(ctx, (int32_t)row));
    JS_SetPropertyStr(ctx, obj, "col", JS_NewInt32(ctx, (int32_t)col));
    return obj;
}

static JSValue js_kernel_get_screen_size(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "width", JS_NewInt32(ctx, (int32_t)terminal_get_width()));
    JS_SetPropertyStr(ctx, obj, "height", JS_NewInt32(ctx, (int32_t)terminal_get_height()));
    return obj;
}

/* --- Memory --- */

static JSValue js_kernel_get_memory_info(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "total", JS_NewInt32(ctx, (int32_t)memory_get_total()));
    JS_SetPropertyStr(ctx, obj, "free", JS_NewInt32(ctx, (int32_t)memory_get_free()));
    JS_SetPropertyStr(ctx, obj, "used", JS_NewInt32(ctx, (int32_t)memory_get_used()));
    return obj;
}

/* --- Keyboard --- */

static JSValue js_kernel_read_key(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    char c = keyboard_poll();
    if (c == 0) {
        return JS_NewString(ctx, "");
    } else {
        char buf[2] = { c, 0 };
        return JS_NewString(ctx, buf);
    }
}

static JSValue js_kernel_wait_key(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    char c = keyboard_getchar();
    char buf[2] = { c, 0 };
    return JS_NewString(ctx, buf);
}

static JSValue js_kernel_has_key(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    return JS_NewBool(ctx, keyboard_has_key());
}

static JSValue js_kernel_readline(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    char buffer[256];
    keyboard_readline(buffer, sizeof(buffer));
    return JS_NewString(ctx, buffer);
}

/* waitKeyEx — blocks until a regular key OR an extended key (arrow, fn, etc.)
 * is available.  Returns { ch: string, ext: number }.
 * ext == 0  → regular key in ch
 * ext != 0  → special key code (KEY_UP=0x80, KEY_DOWN=0x81, …), ch == ""
 */
static JSValue js_kernel_wait_key_ex(JSContext *ctx, JSValueConst this_val,
                                     int argc, JSValueConst *argv)
{
    for (;;) {
        int ext = keyboard_get_extended();
        if (ext != 0) {
            JSValue obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, obj, "ch",  JS_NewString(ctx, ""));
            JS_SetPropertyStr(ctx, obj, "ext", JS_NewInt32(ctx, ext));
            return obj;
        }
        if (keyboard_has_key()) {
            char c = keyboard_poll();
            char buf[2] = { c, 0 };
            JSValue obj = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, obj, "ch",  JS_NewString(ctx, buf));
            JS_SetPropertyStr(ctx, obj, "ext", JS_NewInt32(ctx, 0));
            return obj;
        }
        __asm__ volatile ("hlt");
    }
}

/* --- Timer --- */

static JSValue js_kernel_get_ticks(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, (int32_t)timer_get_ticks());
}

static JSValue js_kernel_get_uptime(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, (int32_t)timer_get_ms());
}

static JSValue js_kernel_sleep(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    int32_t ms;
    JS_ToInt32(ctx, &ms, argv[0]);
    timer_sleep((uint32_t)ms);
    return JS_UNDEFINED;
}

/* --- System Control --- */

static JSValue js_kernel_halt(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    terminal_writestring("System halting...\n");
    __asm__ volatile ("cli; hlt");
    return JS_UNDEFINED;
}

static JSValue js_kernel_reboot(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    terminal_writestring("System rebooting...\n");
    uint8_t good = 0x02;
    while (good & 0x02) {
        good = inb(0x64);
    }
    outb(0x64, 0xFE);
    return JS_UNDEFINED;
}

/* --- JavaScript Eval --- */

static JSValue js_kernel_eval(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *code = JS_ToCString(ctx, argv[0]);
    if (!code) return JS_UNDEFINED;

    JSValue result = JS_Eval(ctx, code, strlen(code), "<eval>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(ctx, code);

    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);
        const char *err_str = JS_ToCString(ctx, exc);
        JSValue ret = JS_NewString(ctx, err_str ? err_str : "Unknown error");
        if (err_str) JS_FreeCString(ctx, err_str);
        JS_FreeValue(ctx, exc);
        return ret;
    }

    /* Convert result to string for display */
    const char *str = JS_ToCString(ctx, result);
    JSValue ret = JS_NewString(ctx, str ? str : "undefined");
    if (str) JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, result);
    return ret;
}

/* --- Port I/O (for advanced users) --- */

static JSValue js_kernel_inb(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    int32_t port;
    JS_ToInt32(ctx, &port, argv[0]);
    return JS_NewInt32(ctx, inb((uint16_t)port));
}

static JSValue js_kernel_outb(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    int32_t port, val;
    JS_ToInt32(ctx, &port, argv[0]);
    JS_ToInt32(ctx, &val, argv[1]);
    outb((uint16_t)port, (uint8_t)val);
    return JS_UNDEFINED;
}

/* ============================================================
 * Function list for kernel object
 * ============================================================ */

static const JSCFunctionListEntry js_kernel_funcs[] = {
    /* Terminal */
    JS_CFUNC_DEF("print", 1, js_kernel_print),
    JS_CFUNC_DEF("printRaw", 1, js_kernel_print_raw),
    JS_CFUNC_DEF("putchar", 1, js_kernel_putchar),
    JS_CFUNC_DEF("clear", 0, js_kernel_clear),
    /* Colors / Cursor */
    JS_CFUNC_DEF("setColor", 2, js_kernel_set_color),
    JS_CFUNC_DEF("getColor", 0, js_kernel_get_color),
    JS_CFUNC_DEF("setCursor", 2, js_kernel_set_cursor),
    JS_CFUNC_DEF("getCursor", 0, js_kernel_get_cursor),
    JS_CFUNC_DEF("getScreenSize", 0, js_kernel_get_screen_size),
    /* Memory */
    JS_CFUNC_DEF("getMemoryInfo", 0, js_kernel_get_memory_info),
    /* Keyboard */
    JS_CFUNC_DEF("readKey", 0, js_kernel_read_key),
    JS_CFUNC_DEF("waitKey", 0, js_kernel_wait_key),
    JS_CFUNC_DEF("hasKey", 0, js_kernel_has_key),
    JS_CFUNC_DEF("readline", 0, js_kernel_readline),
    JS_CFUNC_DEF("waitKeyEx", 0, js_kernel_wait_key_ex),
    /* Timer */
    JS_CFUNC_DEF("getTicks", 0, js_kernel_get_ticks),
    JS_CFUNC_DEF("getUptime", 0, js_kernel_get_uptime),
    JS_CFUNC_DEF("sleep", 1, js_kernel_sleep),
    /* System control */
    JS_CFUNC_DEF("halt", 0, js_kernel_halt),
    JS_CFUNC_DEF("reboot", 0, js_kernel_reboot),
    /* Eval */
    JS_CFUNC_DEF("eval", 1, js_kernel_eval),
    /* Port I/O */
    JS_CFUNC_DEF("inb", 1, js_kernel_inb),
    JS_CFUNC_DEF("outb", 2, js_kernel_outb),
};

/* ============================================================
 * Initialization
 * ============================================================ */

int quickjs_initialize(void)
{
    /* Create QuickJS runtime using newlib malloc/free/realloc */
    rt = JS_NewRuntime();
    if (!rt) {
        return -1;
    }

    /* Set memory limit and stack size for bare metal */
    JS_SetMemoryLimit(rt, 768 * 1024);    /* 768KB for JS heap */
    JS_SetMaxStackSize(rt, 32 * 1024);    /* 32KB stack */

    /* Create context with full ES2023 support */
    ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        rt = NULL;
        return -1;
    }

    /* Create global kernel object */
    JSValue global_obj = JS_GetGlobalObject(ctx);
    JSValue kernel_obj = JS_NewObject(ctx);

    /* Register all kernel functions */
    JS_SetPropertyFunctionList(ctx, kernel_obj, js_kernel_funcs,
                               sizeof(js_kernel_funcs) / sizeof(js_kernel_funcs[0]));

    /* Add color constants sub-object */
    JSValue colors_obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, colors_obj, "BLACK",         JS_NewInt32(ctx, 0));
    JS_SetPropertyStr(ctx, colors_obj, "BLUE",          JS_NewInt32(ctx, 1));
    JS_SetPropertyStr(ctx, colors_obj, "GREEN",         JS_NewInt32(ctx, 2));
    JS_SetPropertyStr(ctx, colors_obj, "CYAN",          JS_NewInt32(ctx, 3));
    JS_SetPropertyStr(ctx, colors_obj, "RED",           JS_NewInt32(ctx, 4));
    JS_SetPropertyStr(ctx, colors_obj, "MAGENTA",       JS_NewInt32(ctx, 5));
    JS_SetPropertyStr(ctx, colors_obj, "BROWN",         JS_NewInt32(ctx, 6));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_GREY",    JS_NewInt32(ctx, 7));
    JS_SetPropertyStr(ctx, colors_obj, "DARK_GREY",     JS_NewInt32(ctx, 8));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_BLUE",    JS_NewInt32(ctx, 9));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_GREEN",   JS_NewInt32(ctx, 10));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_CYAN",    JS_NewInt32(ctx, 11));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_RED",     JS_NewInt32(ctx, 12));
    JS_SetPropertyStr(ctx, colors_obj, "LIGHT_MAGENTA", JS_NewInt32(ctx, 13));
    JS_SetPropertyStr(ctx, colors_obj, "YELLOW",        JS_NewInt32(ctx, 14));
    JS_SetPropertyStr(ctx, colors_obj, "WHITE",         JS_NewInt32(ctx, 15));
    JS_SetPropertyStr(ctx, kernel_obj, "colors", colors_obj);

    /* Set kernel as global */
    JS_SetPropertyStr(ctx, global_obj, "kernel", kernel_obj);

    /* Install console polyfill via JS */
    const char *console_init =
        "globalThis.console = {"
        "  log: function(...args) { kernel.print(args.join(' ')); },"
        "  error: function(...args) { kernel.print('ERROR: ' + args.join(' ')); },"
        "  warn: function(...args) { kernel.print('WARN: ' + args.join(' ')); },"
        "  clear: function() { kernel.clear(); }"
        "};"
        "Date.now = function() { return kernel.getUptime(); };";

    JSValue init_result = JS_Eval(ctx, console_init, strlen(console_init),
                                  "<init>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, init_result);
    JS_FreeValue(ctx, global_obj);

    return 0;
}

int quickjs_run_os(void)
{
    if (!ctx) {
        return -1;
    }

    /* Execute the embedded JavaScript code */
    JSValue result = JS_Eval(ctx, embedded_js_code, strlen(embedded_js_code),
                             "jsos.js", JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(result)) {
        JSValue exc = JS_GetException(ctx);
        const char *err = JS_ToCString(ctx, exc);
        terminal_writestring("JavaScript Error: ");
        terminal_writestring(err ? err : "unknown error");
        terminal_writestring("\n");
        if (err) JS_FreeCString(ctx, err);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, result);
        return -1;
    }

    JS_FreeValue(ctx, result);
    return 0;
}

void quickjs_cleanup(void)
{
    if (ctx) {
        JS_FreeContext(ctx);
        ctx = NULL;
    }
    if (rt) {
        JS_FreeRuntime(rt);
        rt = NULL;
    }
}
