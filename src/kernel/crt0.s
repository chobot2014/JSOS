; crt0.s - C runtime startup for newlib
; This provides the _start symbol that newlib expects

global _start
extern main
extern __libc_init_array
extern __libc_fini_array
extern exit

section .text
_start:
    ; Set up stack pointer (should already be set by boot.s)
    
    ; Initialize constructors
    call __libc_init_array
    
    ; Call main function
    call main
    
    ; Call destructors  
    call __libc_fini_array
    
    ; Exit with return code from main
    call exit
    
    ; Should never reach here
.hang:
    hlt
    jmp .hang
