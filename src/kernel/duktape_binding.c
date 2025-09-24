#include "duktape.h"
#include "terminal.h"
#include "memory.h"
#include "embedded_js.h"
#include <stdint.h>

static duk_context *ctx = NULL;

// Kernel API functions exposed to JavaScript

static duk_ret_t js_kernel_print(duk_context *ctx) {
    const char *msg = duk_to_string(ctx, 0);
    terminal_writestring(msg);
    terminal_writestring("\n");
    return 0;  /* no return value */
}

static duk_ret_t js_kernel_get_memory_info(duk_context *ctx) {
    duk_idx_t obj_idx = duk_push_object(ctx);
    
    duk_push_uint(ctx, memory_get_total());
    duk_put_prop_string(ctx, obj_idx, "total");
    
    duk_push_uint(ctx, memory_get_free());
    duk_put_prop_string(ctx, obj_idx, "free");
    
    duk_push_uint(ctx, memory_get_used());
    duk_put_prop_string(ctx, obj_idx, "used");
    
    return 1;  /* return object */
}

static duk_ret_t js_kernel_halt(duk_context *ctx) {
    terminal_writestring("System halting...\n");
    
    // Halt the CPU
    __asm__ volatile ("cli; hlt");
    
    return 0;
}

static duk_ret_t js_kernel_reboot(duk_context *ctx) {
    terminal_writestring("System rebooting...\n");
    
    // Reboot via keyboard controller
    uint8_t good = 0x02;
    while (good & 0x02) {
        good = *((uint8_t*)0x64);
    }
    *((uint8_t*)0x64) = 0xFE;
    
    return 0;
}

// Custom fatal error handler
static void duktape_fatal_handler(void *udata, const char *msg) {
    (void) udata;  /* ignored in this case, silence warning */
    terminal_writestring("FATAL JavaScript Error: ");
    terminal_writestring(msg ? msg : "no message");
    terminal_writestring("\n");
    __asm__ volatile ("cli; hlt");
}

int duktape_initialize(void) {
    // Create Duktape context with custom fatal handler
    ctx = duk_create_heap(NULL, NULL, NULL, NULL, duktape_fatal_handler);
    if (!ctx) {
        return -1;
    }
    
    // Create kernel object
    duk_push_object(ctx);
    
    // Register kernel functions
    duk_push_c_function(ctx, js_kernel_print, 1);
    duk_put_prop_string(ctx, -2, "print");
    
    duk_push_c_function(ctx, js_kernel_get_memory_info, 0);
    duk_put_prop_string(ctx, -2, "getMemoryInfo");
    
    duk_push_c_function(ctx, js_kernel_halt, 0);
    duk_put_prop_string(ctx, -2, "halt");
    
    duk_push_c_function(ctx, js_kernel_reboot, 0);
    duk_put_prop_string(ctx, -2, "reboot");
    
    // Set as global 'kernel' object
    duk_put_global_string(ctx, "kernel");
    
    // Prevent module system conflicts by explicitly setting global properties to undefined
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "require");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "exports");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "module");
    duk_push_undefined(ctx);
    duk_put_global_string(ctx, "define");
    
    // Add basic Date.now() support
    duk_eval_string(ctx, 
        "Date = { now: function() { return 0; } };"  // Simplified for demo
    );
    
    return 0;
}

int duktape_run_os(void) {
    if (!ctx) {
        return -1;
    }
    
    // Execute the embedded JavaScript code
    if (duk_peval_string(ctx, embedded_js_code) != 0) {
        terminal_writestring("JavaScript Error: ");
        terminal_writestring(duk_safe_to_string(ctx, -1));
        terminal_writestring("\n");
        duk_pop(ctx);
        return -1;
    }
    
    duk_pop(ctx);  /* ignore result */
    return 0;
}

void duktape_cleanup(void) {
    if (ctx) {
        duk_destroy_heap(ctx);
        ctx = NULL;
    }
}
