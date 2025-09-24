; NASM boot loader for JSOS
; Multiboot header

MULTIBOOT_ALIGN     equ 1
MULTIBOOT_MEMINFO   equ 2
MULTIBOOT_FLAGS     equ MULTIBOOT_ALIGN | MULTIBOOT_MEMINFO
MULTIBOOT_MAGIC     equ 0x1BADB002
MULTIBOOT_CHECKSUM  equ -(MULTIBOOT_MAGIC + MULTIBOOT_FLAGS)

section .multiboot
align 4
    dd MULTIBOOT_MAGIC
    dd MULTIBOOT_FLAGS
    dd MULTIBOOT_CHECKSUM

section .bss
align 16
stack_bottom:
    resb 16384  ; 16 KiB stack
stack_top:

section .text
global start
start:
    mov esp, stack_top
    extern _start
    call _start
    cli
.hang:
    hlt
    jmp .hang
