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
    }

    /*
     * Heap reservation — (NOLOAD) means the ELF loader (GRUB / multiboot2)
     * does NOT zero or load this region at boot.  Without NOLOAD, this was
     * inside .bss and GRUB would zero the entire window, causing a multi-
     * second freeze for every 256 MB of window size.
     *
     * _sbrk() in syscalls.c advances a break pointer lazily from _heap_start
     * up to _heap_end; pages are demand-faulted from QEMU's 4 GB RAM.
     *
     * Window: 2 GB (0x80000000).
     *   Theoretical cap: 8 × 256 MB children + 50 MB main = 2098 MB.
     *   In practice only 2-3 runtimes are active simultaneously (cooperative
     *   scheduler), so real peak is 500-800 MB.  If all 8 somehow filled up,
     *   later sbrk() calls return ENOMEM, QuickJS OOMs that child — kernel
     *   keeps running.  Set KERNEL_END_FRAME = 2.5 GB so physAlloc returns
     *   frames 2.5 GB – 3.5 GB (≈1 GB of user page frames).
     */
    .heap (NOLOAD) : ALIGN(4K)
    {
        _heap_start = .;
        . += 0x80000000; /* 2 GB */
        _heap_end = .;
    }
}
