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
    ; Null descriptor
    dd 0x0
    dd 0x0
    ; Code segment descriptor (0x08)
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 10011010b ; Access: present, ring 0, code segment, executable, readable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high
    db 0x00      ; Base high
    ; Data segment descriptor (0x10)
    dw 0xFFFF    ; Limit low
    dw 0x0000    ; Base low
    db 0x00      ; Base middle
    db 10010010b ; Access: present, ring 0, data segment, writable
    db 11001111b ; Flags: 4KB granularity, 32-bit, limit high
    db 0x00      ; Base high
gdt_end:

gdtr:
    dw gdt_end - gdt_start - 1 ; Size
    dd gdt_start                ; Offset

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
