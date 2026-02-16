#include "duktape.h"
#include "terminal.h"
#include "memory.h"
#include "keyboard.h"
#include "timer.h"
#include "io.h"
#include "embedded_js.h"
#include <stdint.h>
#include <stddef.h>

static duk_context *ctx = NULL;

/* ============================================================
 * Kernel API functions exposed to JavaScript
 * ============================================================ */

/* --- Terminal / Print --- */

static duk_ret_t js_kernel_print(duk_context *ctx) {
    const char *msg = duk_to_string(ctx, 0);
    terminal_writestring(msg);
    terminal_writestring("\n");
    return 0;
}

static duk_ret_t js_kernel_print_raw(duk_context *ctx) {
    const char *msg = duk_to_string(ctx, 0);
    terminal_writestring(msg);
    return 0;
}

static duk_ret_t js_kernel_putchar(duk_context *ctx) {
    const char *s = duk_to_string(ctx, 0);
    if (s && s[0]) {
        terminal_putchar(s[0]);
    }
    return 0;
}

static duk_ret_t js_kernel_clear(duk_context *ctx) {
    (void)ctx;
    terminal_clear();
    return 0;
}

/* --- Terminal Colors --- */

static duk_ret_t js_kernel_set_color(duk_context *ctx) {
    int fg = duk_to_int(ctx, 0);
    int bg = duk_to_int(ctx, 1);
    terminal_setcolor_fg_bg((uint8_t)fg, (uint8_t)bg);
    return 0;
}

static duk_ret_t js_kernel_get_color(duk_context *ctx) {
    duk_push_int(ctx, terminal_getcolor());
    return 1;
}

static duk_ret_t js_kernel_set_cursor(duk_context *ctx) {
    int row = duk_to_int(ctx, 0);
    int col = duk_to_int(ctx, 1);
    terminal_set_cursor((size_t)row, (size_t)col);
    return 0;
}

static duk_ret_t js_kernel_get_cursor(duk_context *ctx) {
    size_t row, col;
    terminal_get_cursor(&row, &col);
    duk_idx_t obj = duk_push_object(ctx);
    duk_push_uint(ctx, (unsigned int)row);
    duk_put_prop_string(ctx, obj, "row");
    duk_push_uint(ctx, (unsigned int)col);
    duk_put_prop_string(ctx, obj, "col");
    return 1;
}

static duk_ret_t js_kernel_get_screen_size(duk_context *ctx) {
    duk_idx_t obj = duk_push_object(ctx);
    duk_push_uint(ctx, (unsigned int)terminal_get_width());
    duk_put_prop_string(ctx, obj, "width");
    duk_push_uint(ctx, (unsigned int)terminal_get_height());
    duk_put_prop_string(ctx, obj, "height");
    return 1;
}

/* --- Memory --- */

static duk_ret_t js_kernel_get_memory_info(duk_context *ctx) {
    duk_idx_t obj_idx = duk_push_object(ctx);
    
    duk_push_uint(ctx, memory_get_total());
    duk_put_prop_string(ctx, obj_idx, "total");
    
    duk_push_uint(ctx, memory_get_free());
    duk_put_prop_string(ctx, obj_idx, "free");
    
    duk_push_uint(ctx, memory_get_used());
    duk_put_prop_string(ctx, obj_idx, "used");
    
    return 1;
}

/* --- Keyboard --- */

static duk_ret_t js_kernel_read_key(duk_context *ctx) {
    /* Non-blocking: returns empty string if no key */
    char c = keyboard_poll();
    if (c == 0) {
        duk_push_string(ctx, "");
    } else {
        char buf[2] = { c, 0 };
        duk_push_string(ctx, buf);
    }
    return 1;
}

static duk_ret_t js_kernel_wait_key(duk_context *ctx) {
    /* Blocking: waits for a key */
    char c = keyboard_getchar();
    char buf[2] = { c, 0 };
    duk_push_string(ctx, buf);
    return 1;
}

static duk_ret_t js_kernel_has_key(duk_context *ctx) {
    duk_push_boolean(ctx, keyboard_has_key());
    return 1;
}

static duk_ret_t js_kernel_readline(duk_context *ctx) {
    char buffer[256];
    int len = keyboard_readline(buffer, sizeof(buffer));
    (void)len;
    duk_push_string(ctx, buffer);
    return 1;
}

/* --- Timer --- */

static duk_ret_t js_kernel_get_ticks(duk_context *ctx) {
    duk_push_uint(ctx, timer_get_ticks());
    return 1;
}

static duk_ret_t js_kernel_get_uptime(duk_context *ctx) {
    duk_push_uint(ctx, timer_get_ms());
    return 1;
}

static duk_ret_t js_kernel_sleep(duk_context *ctx) {
    uint32_t ms = duk_to_uint32(ctx, 0);
    timer_sleep(ms);
    return 0;
}

/* --- System Control --- */

static duk_ret_t js_kernel_halt(duk_context *ctx) {
    (void)ctx;
    terminal_writestring("System halting...\n");
    __asm__ volatile ("cli; hlt");
    return 0;
}

static duk_ret_t js_kernel_reboot(duk_context *ctx) {
    (void)ctx;
    terminal_writestring("System rebooting...\n");
    /* Reboot via keyboard controller */
    uint8_t good = 0x02;
    while (good & 0x02) {
        good = inb(0x64);
    }
    outb(0x64, 0xFE);
    return 0;
}

/* --- JavaScript Eval --- */

static duk_ret_t js_kernel_eval(duk_context *ctx) {
    const char *code = duk_to_string(ctx, 0);
    
    if (duk_peval_string(ctx, code) != 0) {
        /* Error - push the error string */
        const char *err = duk_safe_to_string(ctx, -1);
        duk_pop(ctx);
        duk_push_string(ctx, err);
        return 1;
    }
    
    /* Success - convert result to string */
    const char *result = duk_safe_to_string(ctx, -1);
    duk_pop(ctx);
    duk_push_string(ctx, result);
    return 1;
}

/* --- Port I/O (for advanced users) --- */

static duk_ret_t js_kernel_inb(duk_context *ctx) {
    uint16_t port = (uint16_t)duk_to_uint(ctx, 0);
    duk_push_uint(ctx, inb(port));
    return 1;
}

static duk_ret_t js_kernel_outb(duk_context *ctx) {
    uint16_t port = (uint16_t)duk_to_uint(ctx, 0);
    uint8_t val = (uint8_t)duk_to_uint(ctx, 1);
    outb(port, val);
    return 0;
}

/* Custom fatal error handler */
static void duktape_fatal_handler(void *udata, const char *msg) {
    (void) udata;
    terminal_writestring("FATAL JavaScript Error: ");
    terminal_writestring(msg ? msg : "no message");
    terminal_writestring("\n");
    __asm__ volatile ("cli; hlt");
}

int duktape_initialize(void) {
    /* Create Duktape context with custom fatal handler */
    ctx = duk_create_heap(NULL, NULL, NULL, NULL, duktape_fatal_handler);
    if (!ctx) {
        return -1;
    }
    
    /* Create kernel object */
    duk_push_object(ctx);
    
    /* --- Terminal functions --- */
    duk_push_c_function(ctx, js_kernel_print, 1);
    duk_put_prop_string(ctx, -2, "print");
    
    duk_push_c_function(ctx, js_kernel_print_raw, 1);
    duk_put_prop_string(ctx, -2, "printRaw");
    
    duk_push_c_function(ctx, js_kernel_putchar, 1);
    duk_put_prop_string(ctx, -2, "putchar");
    
    duk_push_c_function(ctx, js_kernel_clear, 0);
    duk_put_prop_string(ctx, -2, "clear");
    
    /* --- Color / cursor functions --- */
    duk_push_c_function(ctx, js_kernel_set_color, 2);
    duk_put_prop_string(ctx, -2, "setColor");
    
    duk_push_c_function(ctx, js_kernel_get_color, 0);
    duk_put_prop_string(ctx, -2, "getColor");
    
    duk_push_c_function(ctx, js_kernel_set_cursor, 2);
    duk_put_prop_string(ctx, -2, "setCursor");
    
    duk_push_c_function(ctx, js_kernel_get_cursor, 0);
    duk_put_prop_string(ctx, -2, "getCursor");
    
    duk_push_c_function(ctx, js_kernel_get_screen_size, 0);
    duk_put_prop_string(ctx, -2, "getScreenSize");
    
    /* --- Memory functions --- */
    duk_push_c_function(ctx, js_kernel_get_memory_info, 0);
    duk_put_prop_string(ctx, -2, "getMemoryInfo");
    
    /* --- Keyboard functions --- */
    duk_push_c_function(ctx, js_kernel_read_key, 0);
    duk_put_prop_string(ctx, -2, "readKey");
    
    duk_push_c_function(ctx, js_kernel_wait_key, 0);
    duk_put_prop_string(ctx, -2, "waitKey");
    
    duk_push_c_function(ctx, js_kernel_has_key, 0);
    duk_put_prop_string(ctx, -2, "hasKey");
    
    duk_push_c_function(ctx, js_kernel_readline, 0);
    duk_put_prop_string(ctx, -2, "readline");
    
    /* --- Timer functions --- */
    duk_push_c_function(ctx, js_kernel_get_ticks, 0);
    duk_put_prop_string(ctx, -2, "getTicks");
    
    duk_push_c_function(ctx, js_kernel_get_uptime, 0);
    duk_put_prop_string(ctx, -2, "getUptime");
    
    duk_push_c_function(ctx, js_kernel_sleep, 1);
    duk_put_prop_string(ctx, -2, "sleep");
    
    /* --- System control functions --- */
    duk_push_c_function(ctx, js_kernel_halt, 0);
    duk_put_prop_string(ctx, -2, "halt");
    
    duk_push_c_function(ctx, js_kernel_reboot, 0);
    duk_put_prop_string(ctx, -2, "reboot");
    
    /* --- Eval function --- */
    duk_push_c_function(ctx, js_kernel_eval, 1);
    duk_put_prop_string(ctx, -2, "eval");
    
    /* --- Port I/O functions --- */
    duk_push_c_function(ctx, js_kernel_inb, 1);
    duk_put_prop_string(ctx, -2, "inb");
    
    duk_push_c_function(ctx, js_kernel_outb, 2);
    duk_put_prop_string(ctx, -2, "outb");
    
    /* --- Color constants --- */
    duk_push_object(ctx);
    duk_push_int(ctx, 0);  duk_put_prop_string(ctx, -2, "BLACK");
    duk_push_int(ctx, 1);  duk_put_prop_string(ctx, -2, "BLUE");
    duk_push_int(ctx, 2);  duk_put_prop_string(ctx, -2, "GREEN");
    duk_push_int(ctx, 3);  duk_put_prop_string(ctx, -2, "CYAN");
    duk_push_int(ctx, 4);  duk_put_prop_string(ctx, -2, "RED");
    duk_push_int(ctx, 5);  duk_put_prop_string(ctx, -2, "MAGENTA");
    duk_push_int(ctx, 6);  duk_put_prop_string(ctx, -2, "BROWN");
    duk_push_int(ctx, 7);  duk_put_prop_string(ctx, -2, "LIGHT_GREY");
    duk_push_int(ctx, 8);  duk_put_prop_string(ctx, -2, "DARK_GREY");
    duk_push_int(ctx, 9);  duk_put_prop_string(ctx, -2, "LIGHT_BLUE");
    duk_push_int(ctx, 10); duk_put_prop_string(ctx, -2, "LIGHT_GREEN");
    duk_push_int(ctx, 11); duk_put_prop_string(ctx, -2, "LIGHT_CYAN");
    duk_push_int(ctx, 12); duk_put_prop_string(ctx, -2, "LIGHT_RED");
    duk_push_int(ctx, 13); duk_put_prop_string(ctx, -2, "LIGHT_MAGENTA");
    duk_push_int(ctx, 14); duk_put_prop_string(ctx, -2, "YELLOW");
    duk_push_int(ctx, 15); duk_put_prop_string(ctx, -2, "WHITE");
    duk_put_prop_string(ctx, -2, "colors");
    
    /* Set as global 'kernel' object */
    duk_put_global_string(ctx, "kernel");
    
    /* Prevent module system conflicts */
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "require");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "exports");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "module");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "define");
    
    /* Provide Date.now() using timer */
    duk_eval_string(ctx, 
        "Date.now = function() { return kernel.getUptime(); };"
    );
    duk_pop(ctx);
    
    return 0;
}

int duktape_run_os(void) {
    if (!ctx) {
        return -1;
    }
    
    /* Execute the embedded JavaScript code */
    if (duk_peval_string(ctx, embedded_js_code) != 0) {
        terminal_writestring("JavaScript Error: ");
        terminal_writestring(duk_safe_to_string(ctx, -1));
        terminal_writestring("\n");
        duk_pop(ctx);
        return -1;
    }
    
    duk_pop(ctx);
    return 0;
}

void duktape_event_loop(void) {
    /* This is called after the JS OS is loaded.
     * The JS code itself handles the event loop via kernel.waitKey() */
}

void duktape_cleanup(void) {
    if (ctx) {
        duk_destroy_heap(ctx);
        ctx = NULL;
    }
}
