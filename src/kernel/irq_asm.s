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
