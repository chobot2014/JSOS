; boot.s — multiboot2 bootloader header with pixel framebuffer request
;
; Multiboot2 spec section 3.1: header must be 64-bit aligned, within first
; 32768 bytes of the image. GRUB scans the ELF sections for the magic.

%define MULTIBOOT2_MAGIC        0xE85250D6
%define MULTIBOOT2_ARCH_I386    0
%define MB2_TAG_FRAMEBUFFER     5
%define MB2_TAG_END             0

section .multiboot2
align 8

header_start:
    dd MULTIBOOT2_MAGIC                                         ; magic
    dd MULTIBOOT2_ARCH_I386                                     ; architecture
    dd (header_end - header_start)                              ; header length
    ; checksum: -(magic + arch + length) mod 2^32
    dd (0x100000000 - MULTIBOOT2_MAGIC - MULTIBOOT2_ARCH_I386 - (header_end - header_start))

    ; ── Framebuffer request tag ────────────────────────────────────────────
    align 8
.fb_tag_start:
    dw MB2_TAG_FRAMEBUFFER                                      ; type
    dw 0                                                        ; flags (optional)
    dd .fb_tag_end - .fb_tag_start                              ; size
    dd 1024                                                     ; preferred width
    dd 768                                                      ; preferred height
    dd 32                                                       ; bpp (32 = BGRA)
.fb_tag_end:

    ; ── End tag ───────────────────────────────────────────────────────────
    align 8
.end_tag:
    dw MB2_TAG_END                                              ; type = 0
    dw 0
    dd 8                                                        ; size of end tag
header_end:

; ── BSS: stack + boot-info pointer ────────────────────────────────────────
section .bss
align 16
stack_bottom:
    resb 32768          ; 32 KiB kernel stack
stack_top:

global _multiboot2_ptr
_multiboot2_ptr: resd 1

; ── Entry point ───────────────────────────────────────────────────────────
section .text
global start
start:
    mov     esp, stack_top          ; set up stack
    mov     [_multiboot2_ptr], ebx  ; save multiboot2 boot info pointer
    extern  _start
    call    _start                  ; → crt0.s → main()
    cli
.hang:
    hlt
    jmp .hang
