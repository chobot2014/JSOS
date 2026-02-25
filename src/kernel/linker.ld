ENTRY(start)

SECTIONS
{
    . = 1M;

    .text BLOCK(4K) : ALIGN(4K)
    {
        *(.multiboot2)
        *(.text)
    }

    .rodata BLOCK(4K) : ALIGN(4K)
    {
        *(.rodata)
    }

    .data BLOCK(4K) : ALIGN(4K)
    {
        *(.data)
    }

    .bss BLOCK(4K) : ALIGN(4K)
    {
        *(COMMON)
        *(.bss)
        *(.bss.*)
        . = ALIGN(4K);
        _heap_start = .;
        . += 0x30000000; /* 768 MB heap — supports 8×64 MB child runtimes + 50 MB kernel
                          * (562 MB peak) with 206 MB headroom. QEMU runs at -m 4G so
                          * physical RAM is not the constraint; this window is.
                          * _heap_end ≈ 815 MB; KERNEL_END_FRAME = 1 GB > _heap_end. */
        _heap_end = .;;
    }
}
