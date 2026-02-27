; irq_asm.s - Assembly IRQ stubs for JSOS
; These save registers and call the C dispatch function

extern irq_handler_dispatch

%macro IRQ_STUB 1
global irq%1
irq%1:
    pusha
    push dword %1
    call irq_handler_dispatch
    add esp, 4
    popa
    iret
%endmacro

IRQ_STUB 0
IRQ_STUB 1
IRQ_STUB 2
IRQ_STUB 3
IRQ_STUB 4
IRQ_STUB 5
IRQ_STUB 6
IRQ_STUB 7
IRQ_STUB 8
IRQ_STUB 9
IRQ_STUB 10
IRQ_STUB 11
IRQ_STUB 12
IRQ_STUB 13
IRQ_STUB 14
IRQ_STUB 15

; ── CPU exception stubs (vectors 0–31) ────────────────────────────────────
; Intel SDM Vol. 3A §6.3.1 — some exceptions push an error code before EIP;
; the rest do not.  We normalise the stack by pushing a dummy 0 so that
; exception_common_stub always sees:
;   [esp+0]  vector       (pushed by stub)
;   [esp+4]  error_code   (CPU-pushed, or dummy 0 from ISR_NOERR)
;   [esp+8]  eip          ]
;   [esp+12] cs           } pushed by CPU
;   [esp+16] eflags       ]

extern exception_dispatch

%macro ISR_NOERR 1
global isr%1
isr%1:
    cli
    push dword 0        ; dummy error_code (no hardware error code)
    push dword %1       ; vector number
    jmp  exception_common_stub
%endmacro

%macro ISR_ERR 1
global isr%1
isr%1:
    cli
    ; CPU already pushed error_code before EIP/CS/EFLAGS
    push dword %1       ; vector number
    jmp  exception_common_stub
%endmacro

; Assignments per Intel SDM §6.3 / §6.15
ISR_NOERR  0  ; #DE  Divide-by-zero
ISR_NOERR  1  ; #DB  Debug
ISR_NOERR  2  ;      NMI
ISR_NOERR  3  ; #BP  Breakpoint
ISR_NOERR  4  ; #OF  Overflow
ISR_NOERR  5  ; #BR  Bound Range Exceeded
ISR_NOERR  6  ; #UD  Invalid Opcode
ISR_NOERR  7  ; #NM  Device Not Available (FPU)
ISR_ERR    8  ; #DF  Double Fault       (error code always = 0)
ISR_NOERR  9  ;      Coprocessor Segment Overrun (reserved)
ISR_ERR   10  ; #TS  Invalid TSS
ISR_ERR   11  ; #NP  Segment Not Present
ISR_ERR   12  ; #SS  Stack-Segment Fault
ISR_ERR   13  ; #GP  General Protection Fault
ISR_ERR   14  ; #PF  Page Fault
ISR_NOERR 15  ;      Reserved
ISR_NOERR 16  ; #MF  x87 FPU Exception
ISR_ERR   17  ; #AC  Alignment Check
ISR_NOERR 18  ; #MC  Machine Check
ISR_NOERR 19  ; #XM  SIMD Floating-Point Exception
ISR_NOERR 20  ; #VE  Virtualization Exception
ISR_ERR   21  ; #CP  Control-Protection Exception
ISR_NOERR 22  ;      Reserved
ISR_NOERR 23  ;      Reserved
ISR_NOERR 24  ;      Reserved
ISR_NOERR 25  ;      Reserved
ISR_NOERR 26  ;      Reserved
ISR_NOERR 27  ;      Reserved
ISR_NOERR 28  ;      Reserved
ISR_NOERR 29  ;      Reserved
ISR_ERR   30  ; #SX  Security Exception
ISR_NOERR 31  ;      Reserved

; Common handler stub.
; On entry: [esp] = vector, [esp+4] = error_code, [esp+8]+ = CPU frame.
; Saves all GP registers + DS and passes a pointer to the frame to C.
exception_common_stub:
    pusha                   ; pushes edi,esi,ebp,esp(dummy),ebx,edx,ecx,eax
    mov  eax, ds
    push eax                ; save DS
    mov  ax,  0x10          ; switch to kernel data segment (GDT slot 1)
    mov  ds,  ax
    mov  es,  ax
    mov  fs,  ax
    mov  gs,  ax
    push esp                ; *exception_frame_t — argument to exception_dispatch
    call exception_dispatch
    add  esp, 4
    pop  eax                ; restore DS
    mov  ds,  ax
    mov  es,  ax
    mov  fs,  ax
    mov  gs,  ax
    popa
    add  esp, 8             ; discard vector + error_code
    iret

; GDT for protected mode (required for IDT to work)
global gdt_flush
global gdt_start
global gdt_end

section .data
align 16
gdt_start:
    ; Null descriptor (0x00)
    dd 0x0
    dd 0x0
    ; Kernel code segment (0x08) — ring 0, exec+read
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 10011010b ; Access: present, ring 0, code, executable, readable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high=0xF
    db 0x00      ; Base high
    ; Kernel data segment (0x10) — ring 0, read+write
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 10010010b ; Access: present, ring 0, data, writable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high=0xF
    db 0x00      ; Base high
    ; User code segment (0x18, selector 0x1B) — ring 3, exec+read  [Phase 9]
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 11111010b ; Access: present, ring 3, code, executable, readable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high=0xF
    db 0x00      ; Base high
    ; User data segment (0x20, selector 0x23) — ring 3, read+write  [Phase 9]
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 11110010b ; Access: present, ring 3, data, writable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high=0xF
    db 0x00      ; Base high
    ; TSS descriptor (0x28) — filled at runtime by platform_gdt_install_tss()  [Phase 9]
    dq 0x0000000000000000
gdt_end:

gdtr:
    dw gdt_end - gdt_start - 1 ; Size
    dd gdt_start                ; Offset

; ── Phase 9: int 0x80 syscall gate ─────────────────────────────────────────
; Ring-3 Chromium code calls `int $0x80` with:
;   eax = syscall number  (0x50 = KEY_READ, 0x51 = MOUSE_READ)
;   ebx = arg1, ecx = arg2, edx = arg3
; On return: eax = result; ebx/ecx/edx may hold additional output values
;            (e.g. mouse dx/dy/buttons).
;
; The IDT gate is installed with DPL=3 (0xEE) so ring-3 can invoke it.
; The kernel stack switch (ring-0 ESP from TSS.esp0) is automatic on the
; ring-change crossing.

extern syscall_dispatch
extern syscall_out      ; struct { int ebx_out, ecx_out, edx_out; }

global syscall_asm
syscall_asm:
    ; Push args right-to-left (cdecl) from the live registers.
    ; The CPU has already switched to the kernel stack and pushed
    ; SS, ESP, EFLAGS, CS, EIP before our stub runs.
    push edx            ; arg3
    push ecx            ; arg2
    push ebx            ; arg1
    push eax            ; syscall number
    call syscall_dispatch
    add esp, 16         ; clean cdecl args
    ; eax now holds the primary return value.
    ; Load output regs from the syscall_out global (set by C for multi-value
    ; syscalls like MOUSE_READ).
    mov ebx, [syscall_out]
    mov ecx, [syscall_out + 4]
    mov edx, [syscall_out + 8]
    ; iretd pops EIP, CS, EFLAGS (and SS, ESP for ring change) restoring ring-3.
    ; eax/ebx/ecx/edx are not touched by iretd — they are the return values.
    iretd

section .text
gdt_flush:
    lgdt [gdtr]
    ; Reload segment registers
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov fs, ax
    mov gs, ax
    mov ss, ax
    jmp 0x08:.flush
.flush:
    ret
