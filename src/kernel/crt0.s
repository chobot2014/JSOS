; crt0.s - C runtime startup for newlib
; This provides the _start symbol that newlib expects

global _start
extern main
extern __libc_init_array
extern __libc_fini_array
extern exit
extern __stack_chk_guard   ; stack canary global (item 5)

; Stack canary magic: a fixed seed XOR'd with a pattern the CPU would never
; write naturally.  On real hardware you would seed from RDRAND or RDTSC.
%define CANARY_SEED 0xDEAD600D

section .text
_start:
    ; ── Stack canary initialisation (item 5) ────────────────────────────
    ; Write a non-zero cookie into __stack_chk_guard so that
    ; -fstack-protector can detect stack smashing via __stack_chk_fail.
    ; Read TSC for extra entropy (may be 0 right after reset, but better
    ; than a fully static constant).
    rdtsc                           ; edx:eax = TSC
    xor  eax, CANARY_SEED
    or   eax, 0x01                  ; ensure non-zero
    mov  [__stack_chk_guard], eax

    ; ── FPU initialisation (item 6) ─────────────────────────────────────
    fninit                          ; reset FPU to clean default state

    ; ── Enable SSE: CR4.OSFXSR + CR4.OSXMMEXCPT (item 7) ───────────────
    mov  eax, cr4
    or   eax, 0x600                 ; bit 9 = OSFXSR, bit 10 = OSXMMEXCPT
    mov  cr4, eax
    ; CR0.EM must be clear, CR0.MP must be set for FXSAVE/FXRSTOR to work.
    mov  eax, cr0
    and  eax, 0xFFFFFFFB            ; clear EM (bit 2)
    or   eax, 0x00000002            ; set  MP (bit 1)
    mov  cr0, eax

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

; ── Stack smashing detected (item 5) ────────────────────────────────────────
; __stack_chk_fail is called by GCC's -fstack-protector when the canary was
; overwritten.  We use platform_serial_puts (already initialised by the time
; any user function runs) and then halt.
global __stack_chk_fail
extern platform_serial_puts
__stack_chk_fail:
    push msg_canary
    call platform_serial_puts
    add  esp, 4
    cli
.halt:
    hlt
    jmp .halt

section .rodata
msg_canary:
    db "*** STACK SMASHING DETECTED — kernel halted ***", 0x0D, 0x0A, 0
