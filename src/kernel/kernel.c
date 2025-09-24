#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "terminal.h"
#include "memory.h"
#include "duktape_binding.h"

// Check that we're targeting the right architecture
#if !defined(__i386__)
#error "This kernel needs to be compiled with a ix86-elf compiler"
#endif

int main(void) {
    /* Initialize terminal interface */
    terminal_initialize();
    
    /* Initialize memory management */
    memory_initialize();
    
    terminal_writestring("JSOS Kernel Starting...\n");
    terminal_writestring("Initializing JavaScript Runtime...\n");
    
    /* Initialize and run JavaScript */
    if (duktape_initialize() != 0) {
        terminal_writestring("ERROR: Failed to initialize JavaScript runtime\n");
        return;
    }
    
    terminal_writestring("JavaScript Runtime Initialized\n");
    terminal_writestring("Loading Operating System...\n");
    
    /* Run the embedded JavaScript OS */
    if (duktape_run_os() != 0) {
        terminal_writestring("ERROR: Failed to run JavaScript OS\n");
        return;
    }
    
    terminal_writestring("Operating System Finished\n");
    terminal_writestring("System Halted\n");
    
    return 0;
}
