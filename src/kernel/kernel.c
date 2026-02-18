#include <stddef.h>
#include <stdint.h>
#include "platform.h"
#include "memory.h"
#include "irq.h"
#include "keyboard.h"
#include "timer.h"
#include "quickjs_binding.h"

#if !defined(__i386__)
#error "This kernel needs to be compiled with a ix86-elf compiler"
#endif

extern void gdt_flush(void);

int main(void) {
    platform_init();
    platform_boot_print("JSOS Kernel v1.0.0\n==================\n\n");

    platform_boot_print("[BOOT] Initializing memory...\n");
    memory_initialize();

    platform_boot_print("[BOOT] Loading GDT...\n");
    gdt_flush();

    platform_boot_print("[BOOT] Initializing interrupts...\n");
    irq_initialize();

    platform_boot_print("[BOOT] Initializing timer (100 Hz)...\n");
    timer_initialize(100);

    platform_boot_print("[BOOT] Initializing keyboard...\n");
    keyboard_initialize();

    platform_boot_print("[BOOT] Initializing QuickJS runtime (ES2023)...\n");
    if (quickjs_initialize() != 0) {
        platform_boot_print("FATAL: Failed to initialize JavaScript runtime\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }
    platform_boot_print("[BOOT] QuickJS runtime ready\n");

    platform_boot_print("[BOOT] Loading JavaScript OS...\n\n");
    if (quickjs_run_os() != 0) {
        platform_boot_print("FATAL: Failed to run JavaScript OS\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }

    platform_boot_print("\nSystem halted.\n");
    __asm__ volatile ("cli; hlt");
    return 0;
}
