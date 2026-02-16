#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "terminal.h"
#include "memory.h"
#include "irq.h"
#include "keyboard.h"
#include "timer.h"
#include "quickjs_binding.h"

// Check that we're targeting the right architecture
#if !defined(__i386__)
#error "This kernel needs to be compiled with a ix86-elf compiler"
#endif

// GDT setup (defined in irq_asm.s)
extern void gdt_flush(void);

int main(void) {
    /* Initialize terminal interface */
    terminal_initialize();
    
    terminal_writestring("JSOS Kernel v1.0.0\n");
    terminal_writestring("==================\n\n");
    
    /* Initialize memory management */
    terminal_writestring("[BOOT] Initializing memory...\n");
    memory_initialize();
    
    /* Initialize GDT (needed before IDT) */
    terminal_writestring("[BOOT] Loading GDT...\n");
    gdt_flush();
    
    /* Initialize IRQ system (IDT + PIC) */
    terminal_writestring("[BOOT] Initializing interrupts...\n");
    irq_initialize();
    
    /* Initialize timer at 100 Hz */
    terminal_writestring("[BOOT] Initializing timer (100 Hz)...\n");
    timer_initialize(100);
    
    /* Initialize keyboard driver */
    terminal_writestring("[BOOT] Initializing keyboard...\n");
    keyboard_initialize();
    
    /* Initialize JavaScript runtime */
    terminal_writestring("[BOOT] Initializing QuickJS runtime (ES2023)...\n");
    if (quickjs_initialize() != 0) {
        terminal_writestring("FATAL: Failed to initialize JavaScript runtime\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }
    terminal_writestring("[BOOT] QuickJS runtime ready\n");
    
    /* Run the embedded JavaScript OS */
    terminal_writestring("[BOOT] Loading JavaScript OS...\n\n");
    if (quickjs_run_os() != 0) {
        terminal_writestring("FATAL: Failed to run JavaScript OS\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }
    
    /* If JS returns, halt */
    terminal_writestring("\nSystem halted.\n");
    __asm__ volatile ("cli; hlt");
    
    return 0;
}
