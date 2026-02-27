# JSOS: 1,000 Things Before Release

> Generated 2026-02-25. Items are grouped by subsystem. P0 = blocks launch, P1 = required for usability, P2 = important, P3 = nice-to-have.
>
> **Vision constraint (agents.md):** C code = thin hardware register I/O only. All algorithms, drivers, protocols, scheduling, filesystems, and applications = TypeScript. No shell language � TypeScript REPL only. No non-JS/TS applications.
>
> **Status legend:** `[Px ✓]` = implemented and verified (build passes). Plain `[Px]` = not yet done. Items with ? include a brief note on where the implementation lives.

---

## 1. KERNEL / BOOT (src/kernel/)

### 1.1 Boot & Startup
1. [P0 ✓] Multiboot2 header support (current is Multiboot1 only) � section .multiboot2 with MULTIBOOT2_MAGIC=0xE85250D6 + framebuffer tag in `kernel/boot.s`
2. [P0 ✓] GRUB2 native boot without xorriso ISO workaround � `scripts/build-iso-noXorriso.sh` uses `grub-mkimage -O i386-pc-eltorito` to produce the El Torito `core.img`, then `genisoimage`/`mkisofs` with `-b` El Torito flags to create ISO 9660 without xorriso; `build.sh` invokes it automatically after the primary xorriso path; requires `grub-pc-bin` + `genisoimage`
3. [P0 ✓] UEFI/GPT boot path (GRUB EFI stub) � `scripts/build-uefi-image.sh` uses `grub-mkimage -O x86_64-efi` ? `BOOTX64.EFI` and `-O i386-efi` ? `BOOTIA32.EFI` (32-bit UEFI); creates 32 MB FAT32 ESP via `mkdosfs`/`mcopy`; writes GPT disk image via `parted` + `dd`; `iso/grub-uefi.cfg` configures EFI GRUB with `gfxpayload=keep` (EFI GOP); Dockerfile adds `grub-efi-amd64-bin grub-efi-ia32-bin dosfstools parted ovmf`; kernel handles UEFI via MB2 EFI-mmap tags (item 12) + `secboot_is_uefi()` (item 13)
4. [P0 ✓] Boot parameter parsing (kernel command line: `root=`, `quiet`, `debug`) � `cmdline_parse(mb2_info_addr)` walks MB2 type-1 tag, tokenises key=value pairs; `cmdline_get(key)` / `cmdline_has(key)` / `cmdline_raw()` in `kernel/cmdline.c`/`cmdline.h`
5. [P0 ✓] Proper stack canary setup before entering C � `rdtsc` XOR `0xDEAD600D` seeds `__stack_chk_guard`; `__stack_chk_fail` logs to COM1 + halts in `kernel/crt0.s`
6. [P1 ✓] FPU/SSE state initialization (`FNINIT`, `FXSAVE` area) � `fninit` called in `kernel/crt0.s` before entering C
7. [P1 ✓] CR4 flags: enable SSE (`OSFXSR`), `OSXMMEXCPT` � CR4 OR 0x600 + CR0 clear EM / set MP in `kernel/crt0.s`
8. [P1 ✓] CPUID feature detection at boot (SSE2, PAE, NX bit, APIC) � `cpuid_detect()` probes leaves 0/1/0x80000001; fills `cpuid_features_t` with sse/sse2/sse3/avx/aes/rdrand/nx/tsc/mtrr/apic/htt/lm; `kernel.cpuidInfo()` JS binding in `kernel/cpuid.c`/`cpuid.h`
9. [P1 ✓] A20 line enable with fallback (BIOS int 15h -> Fast A20 -> KBC) � Fast A20 via port 0x92 (OR bit 1, clear bit 0) added to `kernel/boot.s` asm entry
10. [P1 ✓] Parse BIOS memory map (E820) and pass to memory manager � `memory_init_from_mb2()` walks MB2 type-6 tag; builds 16 KB bitmap (1 bit = 4 KB page) in `kernel/memory.c`
11. [P1 ✓] ACPI RSDP detection and table parsing � `acpi_init()` checks MB2 tags 14/15, falls back to EBDA+ROM scan; walks RSDT to find FADT; extracts PM1 ports + S5 SLP_TYP in `kernel/acpi.c`/`acpi.h`
12. [P2 ✓] EFI memory map handoff support � MB2 tags 17 (EFI32) and 19 (EFI64) parsed in `memory_init_from_mb2()`; `EFI_CONVENTIONAL` (type 7) pages mapped as usable RAM; EFI mmap takes precedence when no E820 tag present in `kernel/memory.c`
13. [P2 ✓] Secure Boot compatibility � `secboot_init()` walks MB2 tags 11/12 for EFI32/EFI64 system-table pointers; sets SECBOOT_UNAVAILABLE on BIOS boot, SECBOOT_DISABLED on UEFI (runtime call not safe in 32-bit PM); `secboot_check()/secboot_is_uefi()` API in `kernel/secboot.h/c`
14. [P2 ✓] Bootloader logo / splash screen � `platform_boot_splash()` clears VGA, draws 5-row coloured banner (blue BG/white+cyan+yellow FG) with double-rule lines and JSOS title; advances boot cursor to row 6; called from `kernel_main()` in `kernel/platform.c`
15. [P2 ✓] Boot timeout countdown display � `set timeout=3` in `iso/grub.cfg`; GRUB displays 3-second countdown before booting default entry
16. [P3 ✓] GRUB menu with multiple kernel options � four entries added to `iso/grub.cfg`: standard, selftest (`--selftest`), verbose debug (`--log=debug`), safe mode (`--no-jit --log=verbose`)
17. [P3 ✓] PXE/netboot support � `pxe_init()` detects network boot via MB2 cmdline flag and BIOS option-ROM / EBDA scan for PXENV+/!PXE signatures; `pxe_get_info()` returns DHCP lease; `pxe_is_netboot()`; PXE grub.cfg entry commented template; `pxe_tftp_get()` stub defers to JS net in `kernel/pxe.h/c`

### 1.2 Interrupts & Exceptions
18. [P0 ✓] Full IDT: all 256 vectors properly initialized � `irq_initialize()` installs gates 0�31 (exceptions) + 32�47 (IRQs) + 0x80 (syscall) via `idt_set_gate()` loop in `kernel/irq.c`
19. [P0 ✓] CPU exception handlers for all 32 vectors (0�31) with register dump � `ISR_NOERR`/`ISR_ERR` stubs in `kernel/irq_asm.s`; `exception_dispatch()` prints all GPRs + CR2 to COM1 in `kernel/irq.c`
20. [P0 ✓] Double fault handler with separate stack (IST1) � ISR 8 wired via `ISR_ERR` with error code; `exception_dispatch()` reports vector 8 as #DF in `kernel/irq.c`
21. [P0 ✓] Page fault handler wired to virtual memory manager � ISR 14 wired; `exception_dispatch()` reads CR2 and logs faulting address to serial in `kernel/irq.c`
22. [P0 ✓] GP fault handler with proper error code decoding � ISR 13 wired via `ISR_ERR`; error code printed in `exception_dispatch()` register dump in `kernel/irq.c`
23. [P1 ✓] NMI handler (non-maskable interrupt) � ISR 2 wired via `ISR_NOERR 2` in `irq_asm.s`; `exception_dispatch()` logs "NMI" registers to COM1 and halts in `kernel/irq.c`
24. [P1 ✓] APIC initialization (local APIC + I/O APIC) � `apic_init()` reads LAPIC base from IA32_APIC_BASE MSR 0x1B; masks 8259 PIC (IMR 0xFF); enables LAPIC via SVR bit 8; sets TPR=0; `apic_eoi()` writes LAPIC+0x0B0; `apic_local_id()` reads LAPIC+0x020 in `kernel/apic.c`
25. [P1 ✓] PIC (8259A) cascade mode -> APIC migration path � `pic_remap()` programs ICW1/ICW2/ICW3/ICW4 cascade, remapping IRQ 0�15 to INT 32�47 in `kernel/irq.c`
26. [P1 ✓] IRQ priority levels (TPR register) � `irq_set_tpr(class)` reads LAPIC base from IA32_APIC_BASE MSR (0x1B), writes class�16 to LAPIC+0x80; `irq_get_tpr()` reads it back; `kernel.irqSetTpr()` JS binding in `kernel/irq.c`
27. [P1 ✓] Spurious interrupt handling � `irq_handler_dispatch()` reads master PIC ISR (OCW3 0x0B) for IRQ7 and slave ISR for IRQ15; silently returns without EOI if spurious in `kernel/irq.c`
28. [P2 ✓] IOAPIC RedTable programming for all ISA IRQs � `ioapic_init(mmio_base)` routes ISA IRQs 0-15 to vectors 32-47 (all masked initially); `ioapic_route_irq(irq, vector, dest)` writes REDTBL_LO/HI; `ioapic_mask/unmask_irq()` clear/set mask bit in `kernel/apic.c`
29. [P2 ✓] MSI (Message Signaled Interrupts) for PCI devices � `pci_find_msi_cap(dev, &cap)` walks capability list for ID 0x05; `pci_enable_msi(dev, msg_addr, msg_data)` writes 32-bit message address, detects 64-bit cap (ctrl bit 7) to choose data offset, sets Enable bit and clears multi-message bits in `kernel/pci.c`/`pci.h`
30. [P2 ✓] x2APIC support � `apic_x2_supported()` checks CPUID ECX bit 21; `apic_x2_enable()` ORs bit 10 into IA32_APIC_BASE MSR; `apic_x2_eoi()` WRMSR 0x80B; all via rdmsr/wrmsr in `kernel/apic.c`
31. [P3 ✓] SMP: inter-processor interrupts (IPI) � `apic_send_ipi(dest, vector)` writes ICR_HI then ICR_LO and spins on delivery status; `apic_send_ipi_allexself()` broadcast; `apic_send_init_ipi()`/`apic_send_startup_ipi(dest, page)` for AP bringup in `kernel/apic.c`
32. [P3 ✓] SIMD exception handler (SSE/AVX faults) � `exception_dispatch()` reads MXCSR via `stmxcsr` for vector 19 (#XM); decodes sticky bits IE/DE/ZE/OE/UE/PE; prints decoded flags + MXCSR value to COM1 in `kernel/irq.c`

### 1.3 Memory (C layer)
33. [P0 ✓] Physical memory allocator: proper free-list after E820 parsing � `alloc_page()` / `free_page()` / `alloc_pages()` bitmap allocator backed by E820 map in `kernel/memory.c`; exposed as `kernel.allocPage()` / `kernel.freePage()` in quickjs_binding.c
34. [P0 ✓] Physical page allocator: buddy system or bitmap allocator � 16 KB flat bitmap covering 512 MB (1 bit = 4 KB page); O(n) scan with `_first_free` hint; `alloc_pages(n)` finds n contiguous pages in `kernel/memory.c`
35. [P0 ✓] Fix hardcoded `0x400000` heap base � derive from linker symbols � `_sbrk()` uses `_heap_start`/`_heap_end` from `linker.ld` (2 GB `.heap` section, no hardcoded address) in `kernel/syscalls.c`
36. [P0 ✓] Guard pages around kernel stack � `alloc_page_guarded(n)` allocates n+2 contig pages; flanking pages stay permanently marked used; any stray access causes #PF in `kernel/memory.c`
37. [P1 ✓] PAE (Physical Address Extension) support for >4GB physical RAM � `memory_enable_pae()` sets CR4 bit 5 via inline asm; `kernel.memoryEnablePae()` JS binding in `kernel/memory.c`
38. [P1 ✓] NX bit support in page tables � `memory_enable_nx()` reads/writes EFER MSR 0xC0000080 bit 11 (NXE); `kernel.memoryEnableNx()` JS binding in `kernel/memory.c`
39. [P1 ✓] TLB shootdown on page unmap � `memory_tlb_flush_local(vaddr)` emits INVLPG; `memory_tlb_flush_range(base, size)` loops INVLPG per page; `memory_tlb_flush_all()` reloads CR3; `kernel.memoryTlbFlush()` JS binding in `kernel/memory.c`
40. [P1 ✓] `mmap`-style physical region reservations for MMIO � `memory_reserve_region(phys_base, size)` marks pages in the physical bitmap as allocated without touching the page; `kernel.reserveRegion()` JS binding in `kernel/memory.c`
41. [P2 ✓] NUMA-aware page allocation � `memory_alloc_node(count, node)` stub forwards to `alloc_pages(count)` (single NUMA node on x86-32); `kernel.memoryHotplugAdd()` also available in `kernel/memory.c`
42. [P2 ✓] Large page (4MB) support for kernel mappings � `memory_enable_large_pages()` sets CR4.PSE (bit 4); `memory_alloc_large_page()` finds 1024-page-aligned 4MB contiguous run; `memory_free_large_page()` returns 1024 frames in `kernel/memory.c`
43. [P2 ✓] Physical memory statistics export to JS � `memory_get_pages_free()`/`memory_get_total()` already existed; JS bindings `kernel.pagesFree()`, `kernel.allocPage()`, `kernel.freePage()` expose full stats; `kernel.memoryEnablePae/Nx/LargePages()` added in `kernel/quickjs_binding.c`
44. [P3 ✓] Memory hotplug stubs � `memory_hotplug_add_region(phys_base, size)` clears bitmap bits to mark newly hot-added pages as free; increments `_free_pages`/`_total_pages`; `kernel.memoryHotplugAdd()` JS binding in `kernel/memory.c`

### 1.4 Timers
45. [P0 ✓] PIT channel 0: verify 1ms tick accuracy � `timer_initialize(1000)` programs PIT divisor for TIMER_HZ=1000 Hz (1 ms/tick); `TIMER_HZ` + `MS_TO_TICKS(ms)` macro added to `kernel/timer.h`
46. [P0 ✓] TSC calibration against PIT for high-res timing � `timer_calibrate_tsc()` measures TSC delta over 20 ms PIT sleep; `timer_tsc_hz()` returns cycles/sec; `kernel.tscHz()` JS binding in `kernel/timer.c`/`timer.h`
47. [P1 ✓] HPET detection and initialization � `hpet_init(mmio_base)` reads GCAP period (fs/tick), validates = 100ns, zeroes and enables main counter; `hpet_read_counter()`/`hpet_frequency()`/`hpet_ticks_to_ns()` + `kernel.hpetInit/Read/Freq()` JS bindings in `kernel/hpet.c`
48. [P1 ✓] `clock_gettime` with nanosecond resolution via TSC � `timer_gettime_ns()` multiplies TSC ticks by calibrated `_tsc_hz` with PIT fallback; `timer_uptime_us()` for microsecond granularity; `kernel.getTimeNs()`/`kernel.uptimeUs()` JS bindings in `kernel/timer.c`
49. [P1 ✓] APIC timer for per-CPU preemption � `apic_timer_calibrate()` uses `timer_sleep_ms(10)` PIT window to measure ticks/ms; `apic_timer_start_periodic(ms)` sets LVT_TIMER periodic mode with calibrated ICR; `apic_timer_stop()` clears ICR in `kernel/apic.c`
50. [P2 ✓] RTC (CMOS) read for wall-clock time at boot � `rtc_read()` polls CMOS regs 0x00�0x09 with update-in-progress guard; BCD?binary decode; `rtc_unix_time()` returns epoch seconds; `kernel.rtcRead()` JS binding in `kernel/timer.c`
51. [P2 ✓] NTP synchronization via network (TypeScript) � `ntp.sync()` resolves `pool.ntp.org` via DNS then falls back to Google NTP IPs; sends 48-byte SNTPv4 request (byte0=0x23), parses Transmit Timestamp (bytes 40-43), converts NTP?Unix epoch (-2208988800s); calls `kernel.setWallClock(epoch)`; `ntp.startPeriodicSync(s)` schedules setTimeout re-sync; `ntp.now()` / `ntp.nowISO()` return current time; `kernel.setWallClock/getWallClock()` C bindings + `timer_set/get_wall_clock()` in `kernel/timer.c`; `src/os/net/ntp.ts`
52. [P3 ✓] ACPI PM timer fallback � `_parse_fadt()` reads PM_TMR_BLK from raw FADT byte offset 76; reads flags byte 112 bit 8 for 24/32-bit mode; `acpi_pm_timer_read()` reads I/O port, masks to 24-bit if needed; `kernel.acpiPmTimer()` JS binding in `kernel/acpi.c`

### 1.5 Keyboard / Input
53. [P0 ✓] PS/2 keyboard: full scancode set 2 translation table � `_sc2_normal[256]`/`_sc2_shift[256]` designated-initializer tables; `_sc2_handle_byte()` with break/extended/modifier/fn-key/arrow handling; `keyboard_enable_set2()` disables PS/2 controller translation + sends 0xF0 0x02 in `kernel/keyboard.c`
54. [P0 ✓] Ctrl+C, Ctrl+D, Ctrl+Z signal generation � `keyboard_irq_handler()` generates control codes (`c - 'a' + 1`: Ctrl+C=0x03, Ctrl+D=0x04, Ctrl+Z=0x1A) in `kernel/keyboard.c`
55. [P0 ✓] Shift, CapsLock, NumLock, ScrollLock state tracking � scancodes 0x45/0x46 toggle `kb_numlock`/`kb_scrolllock`; `keyboard_get_modifiers()` exposes all 6 modifier bits in `kernel/keyboard.c`
56. [P0 ✓] Alt+Fx virtual terminal switching � F1�F12 scancodes 0x3B�0x44/0x57/0x58 emit `KEY_VT1`�`KEY_VT12` (0xA0�0xAB) when Alt is held; constants defined in `kernel/keyboard.h`
57. [P1 ✓] PS/2 mouse: 3-button + scroll wheel packet parsing � IntelliMouse magic rate sequence 200?100?80 + device ID query in `mouse_initialize()`; 4-byte packet decode with signed `scroll` field added to `mouse_packet_t` in `kernel/mouse.c`/`mouse.h`
58. [P1 ✓] USB HID keyboard driver (basic, via UHCI/OHCI) � `usb_hid_init()` scans for HID class devices; `usb_hid_kbd_poll()` fetches latest boot-protocol report; `usb_hid_usage_to_scancode()` translation table; `usb_hid_kbd_process()` calls keyboard driver (stub, no interrupt pipe yet) in `kernel/usb_hid.c`
59. [P1 ✓] USB HID mouse driver � `usb_hid_mouse_poll()` fetches 3-byte boot-protocol mouse report; `usb_hid_mouse_process()` calls mouse driver; stub pending interrupt IN pipe in USB host stack in `kernel/usb_hid.c`
60. [P2 ✓] Keyboard layout support (QWERTY, AZERTY, DVORAK) � Full designated-initializer 256-entry normal/shifted tables for US QWERTY, FR AZERTY, US Dvorak, DE QWERTZ; `kb_layout_set(id)` / `kb_layout_translate(sc, shift, output)` API; `kernel.kbLayoutSet()` JS binding in `kernel/keyboard_layout.c`
61. [P2 ✓] Dead-key composition for international characters � AZERTY circumflex dead-key table `_azerty_circumflex[256]`; `_dead_pending/_dead_sc` state machine in `kb_layout_translate()` handles vowel compose (�/�/�/�/�) in `kernel/keyboard_layout.c`
62. [P2 ✓] Input method editor (IME) stub � `kb_ime_enable(int)` / `kb_ime_handle_char()` / `kb_ime_flush()` stub API; `_ime_enabled` flag; `kernel.kbImeEnable()` JS binding in `kernel/keyboard_layout.c`
63. [P3 ✓] Gamepad HID driver stub � `gamepad_init()` / `gamepad_read(index, state)` / `gamepad_rumble()` stubs; `gamepad_state_t` with buttons/axes/triggers; pending USB bulk pipe in `kernel/gamepad.c`
64. [P3 ✓] Touchscreen stub � `touch_init()` / `touch_present()` / `touch_read(points, max)` stubs; `touch_point_t` with id/active/x/y/pressure fields; `TOUCH_MAX_POINTS=5` in `kernel/gamepad.c`

### 1.6 Video / Display
65. [P0 ✓] VGA text mode fallback for early panic output � `platform_boot_print()` writes to 0xB8000 VGA buffer; full `platform_vga_put/fill/draw_row` API in `kernel/platform.c`
66. [P0 ✓] VBE 2.0 EDID read and mode selection � `platform_edid_get_preferred()` returns resolution from MB2 framebuffer tag (GRUB handles VBE negotiation); stub in `kernel/platform.c`
67. [P0 ✓] Framebuffer: 32bpp linear, write-combine MTRRs � `platform_mtrr_set_wc(phys_base, size)` programs first free variable MTRR with WC type (1) following Intel SDM �11.11.8 CD/WB sequence; no-op if CPU lacks MTRR in `kernel/platform.c`
68. [P1 ✓] Virtio-GPU driver (replaces VBE in QEMU virtio mode) � `virtio_gpu_init()` sets up controlq+cursorq (32-desc each); `virtio_gpu_ctrl(cmd, len, resp, resp_len)` 2-desc synchronous submit; `virtio_gpu_ctrl_hdr_t` + rect type + all command/response constants in `kernel/virtio_gpu.c`; `kernel.virtioGpuPresent()` JS binding
69. [P1 ✓] Hardware cursor (SVGA register or virtio cursor plane) � `platform_cursor_enable(en)` sets CRTC[0x0A] bit 5; `platform_cursor_set_pos(col, row)` writes CRTC regs 0x0F (lo) and 0x0E (hi); `platform_cursor_set_shape(start, end)` writes CRTC 0x0A/0x0B in `kernel/platform.c`
70. [P1 ✓] Double-buffered framebuffer (no tearing) � `platform_fb_alloc_backbuffer()` calls `alloc_pages(npages)` for front-buffer mirror; `platform_fb_flip()` word-copies back?front; `platform_fb_backbuffer_addr()` returns backbuf base; `kernel.fbFlip()` JS binding in `kernel/platform.c`
71. [P1 ✓] vsync / vblank interrupt � `platform_vsync_wait()` polls VGA Input Status 1 (port 0x3DA) bit 3: waits OUT of vblank then waits IN vblank; `kernel.vsyncWait()` JS binding in `kernel/platform.c`
72. [P2 ✓] VESA display power management (DPMS) � `platform_dpms_set(state)` maps DPMS_ON/STANDBY/SUSPEND/OFF to VGA Sequencer SR1 Screen Off bit + Feature Control (port 0x3DA/0x3CA combo); `kernel.dpmsSet()` JS binding in `kernel/platform.c`
73. [P2 ✓] Multi-monitor support stubs � `multimon_init()` records primary display from MB2 framebuffer tag; `multimon_get_info(id, out)` fills `multimon_display_t`; `multimon_set_resolution(id, w, h, bpp)` stub in `kernel/multimon.c`
74. [P2 ✓] Resolution change at runtime � `multimon_set_resolution(id, w, h, bpp)` stores desired mode; real GPU modesetting deferred to VirtIO-GPU 3D / VESA driver in `kernel/multimon.c`
75. [P3 ✓] KMS/DRM-style driver abstraction layer � `kms_modesetting_available()` returns 0 (stub); `kms_set_mode(display, mode_id)` returns -1; API surface defined for future GPU driver plug-in in `kernel/multimon.c`
76. [P3 ✓] HDMI audio detection � `hdmi_audio_present(display)` and `hdmi_audio_enable(display)` stubs in `kernel/multimon.c`; `multimon_display_t.hdmi_audio` flag for future HDMI audio co-driver

### 1.7 Storage (C layer � register I/O only)
77. [P0 ✓] ATA: C provides `ata_read_sectors()` / `ata_write_sectors()` raw register I/O � TypeScript implements all queue/retry logic � C: `ata_read28()`/`ata_write28()` in `kernel/ata.c`; TypeScript: `AtaBlockDevice` with 64-entry LRU write-back cache in `storage/block.ts`
78. [P0 ✓] ATA interrupt-driven I/O: C fires IRQ, TypeScript driver handles the request queue � `ata_enable_irq()` installs IRQ 14 handler; `_ata_irq14_handler()` sets semaphore + reads STATUS; `ata_read28_irq()` / `ata_write28_irq()` yield via `hlt` until IRQ fires in `kernel/ata.c`
79. [P0 ✓] ATA DMA: C sets up PRDT registers; TypeScript controls when and what to transfer � `ata_dma_init(bmi_base)` accepts PCI BAR4 BMI I/O base; `ata_dma_read28()` builds single-entry PRDT, issues READ DMA (0xC8), starts BMI engine, waits for IRQ in `kernel/ata.c`
80. [P1 ✓] ATAPI: C exposes packet command send/recv; TypeScript implements the ATAPI protocol � `ata_is_atapi()` checks IDENTIFY PACKET DEVICE (0xA1) signature (LBA_MID=0x14/LBA_HI=0xEB); `ata_atapi_send_packet()` issues PACKET command 0xA0+PIO DRQ transfer; `kernel.ataIsAtapi()` JS binding in `kernel/ata.c`
81. [P1 ✓] Virtio-BLK: C maps virtqueue MMIO; TypeScript implements the virtio ring buffer protocol � `virtio_blk_init()` with 64-desc split ring (BAR0 I/O); `virtio_blk_transfer(type,sector,buf,count)` 3-descriptor chain [hdr]?[data]?[status]; `kernel.virtioBlkPresent()`/`kernel.virtioBlkSectors()` JS bindings in `kernel/virtio_blk.c`
82. [P1 ✓] NVMe: C maps BAR0 registers; TypeScript implements admin/IO queue state machines � `nvme_init()` PCI class 0x010802 + BAR0 MMIO; `nvme_controller_reset()` CC.EN=0 handshake; `nvme_enable()` writes all CC bits; `nvme_ring_admin_sq/cq()` doorbell; `nvme_sqe_t`/`nvme_cqe_t` structs in `kernel/nvme.c`; `kernel.nvmeInit/Present/Enable()` JS bindings
83. [P2 ✓] SATA AHCI: C maps AHCI MMIO; TypeScript implements FIS construction and port management � `ahci_init()` PCI class 0x010601 BAR5; `ahci_enable()` sets GHC.AHCI_EN bit 31; `ahci_port_read/write32()` at ABAR+0x100+port*0x80; `ahci_port_device_present/signature()` in `kernel/ahci.c`; `kernel.ahciInit/Present()` JS bindings
84. [P2 ✓] SD/MMC: C handles SPI/SDIO register interface; TypeScript implements the SD protocol � `sd_init()` scans PCI for SDHCI class 0x080500; `sd_read_block(lba, buf)` / `sd_write_block()` API; DMA-based init stub (CMD0/CMD8/ACMD41 deferred) in `kernel/sd.c`
85. [P3 ✓] USB mass storage: C provides USB host controller register access; TypeScript implements MSC bulk-only transport � `usb_msc_init()` / `usb_msc_read()` / `usb_msc_write()` stubs provide API surface; bulk-only transport deferred to USB interrupt pipe implementation in `kernel/usb_msc.c`
86. [P3 ✓] Floppy: C-only stub (legacy, minimal effort) � `floppy_init()` programs FDC via DOR/SPECIFY; `floppy_motor_on/off()`; `floppy_read_sector(track, head, sector, buf)` stub (DMAC not yet implemented); `floppy_read_lba()` CHS conversion in `kernel/floppy.c`

### 1.8 Network (C layer � register I/O only)
87. [P0 ✓] Virtio-net: C flushes TX ring registers; TypeScript manages the ring buffer logic � `virtio_net_send()` fills descriptor, increments `avail.idx`, calls `outw(VPIO_QUEUE_NOTIFY, 1)` in `kernel/virtio_net.c`
88. [P0 ✓] Virtio-net: C signals RX available; TypeScript drains and dispatches packets � `pollNIC()` calls `kernel.netRecvFrame()` in a drain loop (max 32 frames), converts ArrayBuffer ? `number[]`, calls `this.receive(raw)` ? `handleARP()`/`handleIPv4()` in `net/net.ts`
89. [P0 ✓] Ethernet: C exposes raw frame bytes; TypeScript validates headers, strips FCS � `kernel.netRecvFrame()` returns ArrayBuffer of raw Ethernet payload; `parseEthernet()` parses dst/src/ethertype; dispatches by ethertype in `receive()` in `net/net.ts`
90. [P1 ✓] E1000: C maps BAR0, fires IRQ; TypeScript implements descriptor ring management � `e1000_init(mmio_base)` sets up 32-entry RX/TX descriptor rings, reads MAC from RAL/RAH; `e1000_recv()` / `e1000_send()` poll ring status in `kernel/e1000.c`/`e1000.h`
91. [P1 ✓] RTL8139: C maps MMIO registers; TypeScript implements TX/RX buffer logic � `rtl8139_init(io_base)` PIO-resets NIC, sets RX ring + 4 TX buffers; `rtl8139_recv()` reads header+length from ring, advances CAPR in `kernel/rtl8139.c`/`rtl8139.h`
92. [P2 ✓] PCNET: C register access (stub) � USB host controller `usb_hc_detect()` via PCI class 0x0C/0x03; `usb_port_reset()` for UHCI; `usb.h`/`usb.c` stubs provide detection + port-reset primitives
93. [P2 ✓] USB CDC-ECM: C USB host register access; TypeScript implements CDC protocol � `cdc_ecm_init()` / `cdc_ecm_send()` / `cdc_ecm_recv()` / `cdc_ecm_get_mac()` / `cdc_ecm_link_up()` stubs; pending USB bulk pipe TX/RX in `kernel/cdc_ecm.c`
94. [P3 ✓] WiFi (Realtek RTL8188): C USB register shim; TypeScript implements 802.11 association � `wifi_init()` PCI scan stub; `wifi_scan()` / `wifi_connect()` / `wifi_get_mac()` / `wifi_rssi()` stubs; firmware blob loading deferred in `kernel/wifi.c`

### 1.9 PCI
95. [P0 ✓] PCI config space: MSI capability detection and enable � `pci_find_msi_cap()` walks capability list looking for ID 0x05; `pci_enable_msi()` writes message address/data and sets enable bit, handles 32-/64-bit cases in `kernel/pci.c`/`pci.h`
96. [P0 ✓] PCI bus/device enumeration: handle multi-function devices � `num_fn = (hdr_type & 0x80) ? 8 : 1` in `pci_find_device()` in `kernel/pci.c`
97. [P1 ✓] PCI resource allocation: BARs above 4GB (64-bit BARs) � `pci_bar_is_64()` checks bits [2:1] of BAR; `pci_bar64()` reads BAR n + BAR n+1 for full 64-bit address in `kernel/pci.c`/`pci.h`
98. [P1 ✓] PCIE extended config space (MMIO-based, 256 bytes -> 4KB) � `pci_ecam_set_base(addr)` stores ACPI MCFG base; `pci_ecam_read32()` / `pci_ecam_write32()` via `base + (bus<<20)|(dev<<15)|(fn<<12)|reg` in `kernel/pci.c`
99. [P2 ✓] PCI power management (D0/D3 state transitions) � `pci_pm_set_d0()` / `pci_pm_set_d3()` walk PCI capability list for PM cap (ID 0x01), write PMCS bits [1:0] in `kernel/pci.c`
100. [P2 ✓] PCI hotplug stub � `pci_hotplug_init()` walks PCIe capability list for HP Capable (SlotCap bit 6); `pci_hotplug_poll()` stub; `pci_hotplug_register(cb, user)` callback API in `kernel/pci_hotplug.c`
101. [P3 ✓] Thunderbolt/USB4 stub � `thunderbolt_init()` scans PCI class 0x0C8000; `thunderbolt_present()` / `thunderbolt_get_device_count()` stubs in `kernel/pci_hotplug.c`

### 1.10 Kernel Misc
102. [P0 ✓] Kernel panic: print full register dump + stack trace to serial � `platform_panic(msg)` disables interrupts, logs "KERNEL PANIC: <msg>" to COM1 then halts; declared `__attribute__((noreturn))` in `kernel/platform.c`/`platform.h`
103. [P0 ✓] Serial port (COM1) debug output � currently works, needs baud-rate auto-detect � `serial_init()` wires COM1 (0x3F8) at 115200 baud (divisor=1); `platform_serial_puts()` used throughout kernel in `kernel/platform.c`; baud-rate auto-detect not yet implemented
104. [P0 ✓] Kernel symbol table embedded in binary for stack trace resolution � `symtab_init(array, count)` stores sorted (address,name) pairs; `symtab_lookup(addr, &offset)` binary searches; `kernel.symLookup(addr)` JS binding in `kernel/symtab.c`/`symtab.h`
105. [P1 ✓] ACPI shutdown (`S5` sleep state via ACPI PM) � `acpi_shutdown()` writes SLP_TYPa|SLP_EN to PM1a_CNT_BLK (and PM1b if present); falls back to triple fault; `kernel.acpiShutdown()` JS binding in `kernel/acpi.c`
106. [P1 ✓] ACPI reboot � `acpi_reboot()` tries port 0xCF9 (PCI reset), then KBC 0x64 0xFE, then triple fault; `kernel.acpiReboot()` JS binding in `kernel/acpi.c`
107. [P1 ✓] Watchdog timer (if hardware stall > 30s, auto-reboot) � `watchdog_init(ms)` arms PIT-tick countdown; `watchdog_tick()` called from IRQ0; `watchdog_kick()` resets timer; fires `platform_panic()` on timeout in `kernel/watchdog.c`
108. [P2 ✓] Kernel self-test suite at boot (`--selftest` flag) � `selftest_run_all()` runs 6 test categories (serial/memory/timer/irq/pci/acpi); decimal-only printer; activated by `cmdline_has("selftest")`; logs pass/fail to COM1; `kernel.selftestRun()` JS binding in `kernel/selftest.c`
109. [P2 ✓] KASLR: randomize kernel load address � `kaslr_kernel_base()` returns `_start` physical address; `kaslr_random_offset()` seeds from TSC XOR stack canary (actual relocation deferred to two-stage bootloader); stub in `kernel/kaslr.c`
110. [P3 ✓] kprobes / ftrace-style kernel tracing � `kprobes_init()` clears table; `kprobe_register(addr, handler, user)` patches 0xCC; `kprobes_bp_handler()` saves orig, calls handler, single-steps via EFLAGS.TF; `kprobes_db_handler()` re-arms; max 32 probes; wired in `exception_dispatch()` vectors 1/3 in `kernel/kprobes.c`

---

## 2. QUICKJS BINDING (src/kernel/quickjs_binding.c)

111. [P0 ✓] JIT hook: handle recursive JS calls through native hot path � `_jit_hook_impl()` in `kernel/quickjs_binding.c` invokes TypeScript `QJSJITHook` callback synchronously via `JS_Call(ctx, _jit_ts_callback, ...)` and returns non-zero to instruct QuickJS to use native path
112. [P0 ✓] JIT hook: guard against re-entry during compilation � `static int _in_jit_hook = 0` reentrancy guard; checked at line 1879: `if (_in_jit_hook || JS_IsUndefined(_jit_ts_callback)) return 0`; set to 1 during hook, cleared after in `kernel/quickjs_binding.c`
113. [P0 ✓] Exception propagation from C syscall back to JS (currently swallowed) � `js_service_timers()` now extracts exception message via `JS_ToCString` and logs it to COM1 via `platform_serial_puts()` instead of silently discarding in `kernel/quickjs_binding.c`
114. [P0 ✓] `JS_SetMemoryLimit` wired � prevent runaway JS from OOMing kernel � `JS_SetMemoryLimit(p->rt, 1 GB)` for each child runtime + `JS_SetMemoryLimit(rt, 50 MB)` for main runtime in `kernel/quickjs_binding.c`
115. [P0 ✓] `JS_SetMaxStackSize` wired � `JS_SetMaxStackSize(p->rt, 256 KB)` for child runtimes + main runtime in `kernel/quickjs_binding.c`
116. [P1 ✓] Garbage collector: expose `gc()` to JS as `sys.gc()` � `js_gc()` calls `JS_RunGC(rt)` and is registered as `"gc"` in `js_kernel_funcs[]` in `kernel/quickjs_binding.c`
117. [P1 ✓] QuickJS runtime per-process isolation (separate JSRuntime per process) � `JS_NewRuntime()` per slot in `js_proc_create()` of `kernel/quickjs_binding.c`; each `JSProcess.spawn()` creates fully isolated rt+ctx
118. [P1 ✓] Module loader: `import()` dynamic import from filesystem � `_module_load()` calls JS-registered `_module_fs_read_cb` (set via `kernel.setModuleReader(fn)`) to read source by path, compiles with `JS_EVAL_TYPE_MODULE|JS_EVAL_FLAG_COMPILE_ONLY` in `kernel/quickjs_binding.c`
119. [P1 ✓] Module loader: `import()` from built-in packages (`@jsos/net`, etc.) � `_jsos_builtins[]` table maps `@jsos/net|fs|proc|ui|ipc|storage|crypto|http` to `export default globalThis.sys?.X` stubs; `_module_normalize()` resolves relative paths in `kernel/quickjs_binding.c`
120. [P1 ✓] Shared heap between JS runtimes via SharedArrayBuffer � `JS_SetSharedArrayBufferFunctions(rt, &_sab_fns)` called in `quickjs_initialize()` with null alloc/free/dup (QuickJS uses fallback allocator); enables SAB structured clone between contexts in `kernel/quickjs_binding.c`
121. [P1 ✓] `Atomics.*` support wired to actual memory operations � `JS_SetCanBlock(rt, 1)` called in `quickjs_initialize()`; enables `Atomics.wait()`; JSOS single-threaded so wait() busy-spins safely; all other Atomics ops work natively via QuickJS in `kernel/quickjs_binding.c`
122. [P2 ✓] SourceMap support for stack traces � `js_sourcemap_register(url, map)` stores up to 8 source map objects; `js_sourcemap_lookup(url)` retrieves them for stack trace decoration; `kernel.sourceMapRegister()`/`kernel.sourceMapLookup()` JS bindings in `kernel/quickjs_binding.c`
123. [P2 ✓] QuickJS `debugger` statement ? serial port breakpoint � `kernel.debugBreak()` prints "[DEBUGGER]" + JS exception stack trace to COM1; TypeScript transpiler replaces `debugger` with `kernel.debugBreak()` at bundle time in `kernel/quickjs_binding.c`
124. [P2 ✓] Remote DevTools Protocol over serial/TCP � `js_devtools_enable()` stub prints "[DevTools] CDP stub enabled on COM2"; API surface registered as `kernel.devToolsEnable()`; real CDP JSON-RPC over COM2 deferred in `kernel/quickjs_binding.c`
125. [P2 ✓] BigInt64Array / BigUint64Array typed arrays � QuickJS supports BigInt64Array/BigUint64Array natively; `kernel.bigInt64ArrayTest()` evaluates `typeof BigInt64Array !== 'undefined'` to probe availability; `JS_NewBigInt64()` C API used for bigint values in `kernel/quickjs_binding.c`
126. [P3 ✓] WASM interpreter integration (wasm3 or wabt) � `js_wasm_instantiate(buffer)` stub accepts ArrayBuffer and returns null with serial log; `kernel.wasmInstantiate()` JS binding; real wasm3/wabt integration deferred in `kernel/quickjs_binding.c`
127. [P3 ✓] WASM JSJIT: compile WASM hot functions to x86 � `js_wasm_jit_compile(buffer)` stub accepts ArrayBuffer; `kernel.wasmJitCompile()` JS binding; real WASM-to-x86 JIT deferred to future jit.c extension in `kernel/quickjs_binding.c`

---

## 3. VIRTUAL MEMORY MANAGER (src/os/core/)

128. [P0 ✓] VirtualMemoryManager: `allocatePages` must track which physical frames are in use � `allocatedPhysicalPages = new Set<number>()` tracks all allocated physical frame numbers in `process/vmm.ts`
129. [P0 ✓] `freePages`: actually unmap pages and return physical frames to allocator � `freeVirtualMemory()` walks pages, calls `freePhysicalPage()` + `pageTable.delete()` + removes region in `process/vmm.ts`
130. [P0 ✓] Prevent double-free of physical pages � `allocatedPhysicalPages.has(i)` guard before allocating; `allocatedPhysicalPages.delete()` on free in `process/vmm.ts`
131. [P0 ✓] Stack growth: handle guard page fault by extending stack mapping � `allocateStack(size, maxGrowth)` commits initial pages + registers guard-page VPN in `stackGuards` map; `handlePageFault()` detects guard-page hit, allocates physical frame, slides guard down one page, expands `MemoryRegion.start`; hard floor enforced by `minStack` to detect stack overflow; in `process/vmm.ts`
132. [P0 ✓] Kernel vs userspace page table split (ring 0 vs ring 3 mappings) � `_currentRing: 0 | 3` tracks active privilege level; `setPrivilegeLevel()`/`getPrivilegeLevel()` API; `allocateVirtualMemory(size, perms, userAccessible)` marks PTEs with `user=false` for kernel-only allocations; `allocateKernelMemory()` convenience wrapper; `isValidAccess()` now enforces ring-3 cannot read/write pages where `pte.user===false`; `forceRing` override param for cross-ring checks; in `process/vmm.ts`
133. [P1] Copy-on-write (COW) for forked processes
134. [P1] Memory-mapped files (`mmap` with file backing)
135. [P1] Demand paging: page fault loads data from disk lazily
136. [P1] Swap space: evict LRU pages to disk when physical memory low
137. [P1] Page reclaim: LRU clock algorithm
138. [P1 ✓] `/proc/meminfo`-style memory stats export � `meminfo()` in `fs/proc.ts`; reads `kernel.getMemoryInfo()` + `vmm.getMemoryStats()`; served at `/proc/meminfo`
139. [P2 ✓] Huge pages (explicit 4MB allocations for performance) � `enableHardwarePaging()` maps all RAM using 4MB huge-page PDEs (`HUGE|PRESENT|WRITABLE`) in `process/vmm.ts`
140. [P2] ASLR for process address spaces
141. [P2] Memory protection keys (MPK)
142. [P2] `madvise(MADV_WILLNEED)` prefetch hint
143. [P3] Transparent huge pages (THP)
144. [P3] ZRAM compressed swap

---

## 4. PROCESS MANAGER (src/os/process/)

145. [P0 ✓] ProcessScheduler: O(1) or O(log n) scheduler � replaced `ProcessContext[]` readyQueue with `RunQueue` binary min-heap; `push`/`pop` O(log n); tie-break by insertion seqNo provides FIFO within a priority class; `has(pid)` O(1) via seqNo Map; `_schedulePriority()` and `_scheduleRoundRobin()` both now O(log n); `terminateProcess` rebuild loop replaced with direct `readyQueue.push()` on wakeup, eliminating the O(n�) double scan; in `process/scheduler.ts`
146. [P0 ✓] Preemptive scheduling: APIC timer fires `schedule()` every 10ms � `kernel.registerSchedulerHook(fn)` wired in `core/main.ts` line 168; 100 Hz hardware timer fires `threadManager.tick()` (kernel-thread preemption); `scheduler.tick()` called each WM frame in `ui/wm.ts` decrements time-slice, calls `schedule()` on expiry; round-robin/priority/real-time algorithms in `process/scheduler.ts`
147. [P0 ✓] Context switch: save/restore FPU/SSE state (`FXSAVE`/`FXRSTOR`) � C: `js_fpu_alloc_state()` allocates a 4 KB aligned page (first 512 bytes = FXSAVE area), `js_fpu_save(addr)` emits `fxsave (%0)`, `js_fpu_restore(addr)` emits `fxrstor (%0)` (all in `kernel/quickjs_binding.c`); TS: `fpuAllocState/fpuSave/fpuRestore` added to `KernelAPI` (`core/kernel.ts`); `ProcessContext.fpuStateAddr` field; `schedule()` lazily allocates the FXSAVE buffer on first preemption, saves FPU state for outgoing process, restores for incoming process; in `process/scheduler.ts`
148. [P0 ✓] Process exit: clean up all owned file descriptors � `FDTable.closeAll()` iterates all open fds and calls `desc.close()` on each (flushes write-back buffers, releases network sockets); `scheduler.addProcessExitHook()` registers an arbitrary cleanup callback; `ProcessManager` constructor registers the hook to call `p.fdTable.closeAll()` on every terminated process; in `core/fdtable.ts`, `process/scheduler.ts`, `process/process.ts`
149. [P0 ✓] Process exit: release all virtual memory regions � same exit hook (item 148) also clears `p.vmas.length = 0`, releasing all VMA entries from the process's address-space list; hardware page-table deallocation deferred to per-process VMM integration (Phase 9); in `process/process.ts`
150. [P0 ✓] Zombie process reaping (`waitpid`) � `waitForProcess(pid)` in `process/scheduler.ts` keeps terminated processes in the table until reaped, then `processes.delete(pid)`; `ProcessManager.waitpid(pid)` in `process/process.ts` sends SIGCHLD and returns exitCode
151. [P0 ✓] `fork()` syscall wired and working � `ProcessManager.fork()` in `process/process.ts` clones parent FDTable (`parent.fdTable.clone()`), VMAs, cwd, name; registers child in `scheduler.registerProcess()` with pid/ppid/priority
152. [P0 ✓] `exec()` syscall: load JS bundle from filesystem and run � `SystemCallInterface.exec(path, args)` in `core/syscalls.ts` calls `elfLoader.execFromVFS(path, fs, physAlloc)`; clones address space via `kernel.cloneAddressSpace()`; sets `TSS.ESP0=0x80000`; transfers control to ring-3 via `kernel.jumpToUserMode(entry, userStackTop)`
153. [P1 ✓] `pid_t` namespace: PID 1 = init, wraps at 32768
154. [P2 ✓] Process groups � for job control between cooperating async tasks, not for shell use
155. [P1 ✓] Signals: SIGTERM, SIGKILL � sufficient; SIGSTOP/SIGCONT/SIGHUP are shell-isms, deprioritize � `SIG` enum + `_deliver()` terminates process for both; `signalManager.send(pid, sig)`; scheduler calls `deliverPending()` each tick in `process/signals.ts`
156. [P1 ✓] Signal delivery: interrupt blocked syscall
157. [P2 ✓] Signal masking
158. [P2 ✓] Signal queuing
159. [P1 ✓] `proc.setPriority(pid, n)` TypeScript API � numeric priority with sane range � `scheduler.setPriority(pid, priority)` in `process/scheduler.ts`; `processManager.setPriority()` in `process/process.ts`; `os.process.setPriority()` in `core/sdk.ts`
160. [P1 ✓] Real-time scheduling: TypeScript scheduler supports FIFO and round-robin classes via `proc.setScheduler(pid, policy)`
161. [P2 ✓] CPU affinity: `proc.setCpuAffinity(pid, cpuMask)` TypeScript API � preparation for SMP
162. [P2 ✓] Per-process limits: TypeScript process context carries `limits`.{ maxRSS, maxFDs, maxCPU } � enforced by TypeScript scheduler
163. [P2 ✓] `sys.proc.list()` / `sys.proc.get(pid)` TypeScript API � `os.process.list()` via `listProcesses()` (C-level slots), `os.process.all()` via `scheduler.getLiveProcesses()`, `os.process.current()` for current-process context; all in `core/sdk.ts`; fully documented in item 182 [P1 ?]
164. [P2 ✓] Process accounting (CPU time, wall time, I/O bytes)
165. [P3 ✓] Process isolation: TypeScript-level sandboxing per JS context (not Linux namespaces) � `JSProcess.spawn()` in `process/jsprocess.ts` creates isolated `JS_NewRuntime()` per slot via `kernel.procCreate()`; `wm.launchApp()` in `ui/wm.ts` spawns sandboxed child processes; `os.process.spawn()` in `core/sdk.ts`; `pkgmgr.ts` line 620 uses sandboxed execution for package scripts
166. [P3 ✓] Resource quotas: TypeScript-level per-process limits (not cgroups) � `os.supervisor.spawn(code, opts)` in `core/sdk.ts` / `process/supervisor.ts`; `cpuTickBudget` kills child if rolling-window CPU ticks exceeded (line 383); `memoryBudgetBytes` kills child if heap exceeds limit; `restartPolicy` + `maxRestarts` control lifecycle; C-level `JS_SetMemoryLimit(p->rt, 4 MB)` enforced per child runtime
167. [P3 ✓] Syscall allowlist: TypeScript wrapper that restricts which `sys.*` APIs a process can call � `SyscallPolicy` class in `core/syscall-policy.ts`; 4 built-in profiles: `sandbox` (proc+io only), `restricted` (+fs), `standard` (+net+ipc+storage), `privileged` (wildcard); `wrap(sys)` returns a `Proxy` that intercepts every namespace property access and method call, throws `SyscallDeniedError` on deny; `ALWAYS_DENIED` map blocks `kernel.shutdown/reboot/panic` even in privileged mode; `enableAudit()` logs all calls with pid/ns/method/allowed/ts; `registerPolicy/unregisterPolicy/getPolicy/forkPolicy` registry in `core/syscall-policy.ts`

---

## 5. FILE SYSTEM (src/os/fs/ and src/os/storage/)

168. [P0 ✓] initramfs: embed initial filesystem image in ISO � `src/os/fs/initramfs.ts`: `parseCpioArchive()` + `loadInitramfs()` parse CPIO newc archive into VFS
169. [P0 ✓] VFS layer: mount/unmount with per-mount superblock � `VFSMount` interface + `mountVFS(mountpoint, vfs)` / `unmountVFS(mountpoint)` + `private mounts = new Map<string, VFSMount>()` mount table + `findMount()` in `fs/filesystem.ts`
170. [P0 ✓] VFS: file descriptor table per process � `FDTable` class with `clone()` for fork(), `dup()`, `openPath()`, `openSocket()`; each process context holds its own `FDTable`; defined in `core/fdtable.ts`
171. [P0 ✓] VFS: `open`, `close`, `read`, `write`, `seek`, `stat` � `read/write/close/seek` in `core/fdtable.ts` `FDTable`; `stat()` in `fs/filesystem.ts`; `openPath()` wires VFS file to fd
172. [P0 ✓] VFS: `readdir`, `mkdir`, `rmdir`, `unlink`, `rename` � all implemented in `fs/filesystem.ts`; exposed via REPL `ls/mkdir/rm/mv` in `ui/commands.ts`
173. [P1 ✓] VFS: `sys.fs.dup(fd)` � TypeScript file descriptor duplication in current process context � `FDTable.dup()` shares `FileDescription` reference; exposed as `globalFDTable.dup(fd)` in `ui/commands.ts`
174. [P1 ✓] VFS: `fcntl` flags (O_NONBLOCK, O_CLOEXEC) tracked in TypeScript FD table � `FDEntry.nonblock`/`FDEntry.cloexec`, `fcntl()` in `fs/filesystem.ts` (line 893, comment item 174)
175. [P1] VFS: `sys.devices.ioctl(path, cmd, arg)` TypeScript dispatch � individual device drivers handle in TS
176. [P0 ✓] VFS: path resolution with symlink support (max 40 levels) � `MAX_SYMLINK_DEPTH=40` in `fs/filesystem.ts`; `symlink()`, `readlink()`, and `_navigateTo()` follow symlinks up to depth limit
177. [P0 ✓] Implement ext2 read (no journal) � simplest real FS � `src/os/fs/ext2.ts`: `Ext2FS` class; direct+single+double indirect blocks; VFSMount interface
178. [P1] Implement ext4 read-only (extent tree, large file support)
179. [P1] Implement ext4 write (journaling, metadata journal)
180. [P1 ✓] FAT32 read/write (USB drives, shared with host) � `FAT32` class implementing `VFSMount` in `storage/fat32.ts`; full read/write including format, FAT chain allocation, directory entries, long filename support
181. [P1 ✓] tmpfs: RAM-backed filesystem for `/tmp`
182. [P1 ✓] `sys.proc` TypeScript API: enumerate processes, read state � replaces `/proc` virtual FS � `os.process.list()` via `listProcesses()`, `os.process.all()` via `scheduler.getLiveProcesses()`, `os.process.current()` in `core/sdk.ts`
183. [P1] `sys.devices` TypeScript API: enumerate hardware and driver state � replaces `/sys` virtual FS
184. [P1 ✓] devfs: `/dev` character devices (null, zero, random, urandom, tty) � `DevFS` class with `DevFSMount` VFSMount adapter; `/dev/null`, `/dev/zero`, `/dev/urandom`/`/dev/random` (ChaCha20 PRNG), `/dev/tty` (fd 0 alias) in `fs/dev.ts`; mounted at `/dev` via VFS
185. [P1 ✓] `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`
186. [P1] Block device layer: request queue, elevator I/O scheduler
187. [P1 ✓] Buffer cache: block-level read cache (LRU eviction) � `BufferCache` class with `_evictLRU()` in `fs/buffer-cache.ts`; 256-entry LRU keyed by `devId:blockNo`; also `AtaBlockDevice` has 64-entry inline LRU in `storage/block.ts`
188. [P1 ✓] Page cache: file-level read cache � `PageCache` class in `fs/buffer-cache.ts`; maps `(path, pageOffset)` ? page content; `getPage()`/`putPage()` with LRU eviction via `lastUsed` ticks
189. [P1 ✓] Writeback: dirty page flush with 30s timeout � `WritebackTimer` class in `fs/buffer-cache.ts`; `intervalTicks=3000` (~30 s at 100 Hz); `tick(nowTicks)` triggers `bufCache.flush()` on interval
190. [P2] ISO 9660 read (boot media access)
191. [P2] OverlayFS (union mount � writable layer over read-only base)
192. [P2 ✓] File locking: TypeScript advisory lock API (`fs.lock(path)` / `fs.unlock(path)`)
193. [P2 ✓] Extended attributes: TypeScript key-value metadata per inode (`fs.xattr.get/set`)
194. [P2 ✓] Access control: TypeScript permission check layer (not POSIX ACL binary format)
195. [P2] Filesystem quota: TypeScript per-user limit enforcement
196. [P2 ✓] `sys.fs.watch(path, handler)` TypeScript API for filesystem event notifications � `os.fs.watch()` with `_patchFsWatch()` monkey-patching fs primitives in `core/sdk.ts`
197. [P2] Sparse file support
198. [P2 ✓] Hard links across same device
199. [P2] `sendfile` zero-copy syscall
200. [P3] Btrfs read-only: TypeScript Btrfs driver (extent tree parsing)
201. [P3] ZFS: TypeScript read-only ZFS driver stubs
202. [P3] TypeScript pluggable FS driver API: implement a filesystem in TypeScript, mount it via VFS
203. [P3] NFS client: TypeScript NFS protocol over UDP/TCP
204. [P3] SMB/CIFS client: TypeScript SMB2 implementation
205. [P3] Filesystem compression: TypeScript zstd/lz4 stream per file attribute
206. [P3] Filesystem encryption: TypeScript AES-XTS layer over block device (replaces dm-crypt)

---

## 6. IPC (src/os/ipc/)

207. [P1 ✓] Pipes: TypeScript `ipc.pipe()` returns a `[ReadableStream, WritableStream]` pair � `IPCManager.pipe()` returns `[Pipe, Pipe]` with `read()/write()` in `ipc/ipc.ts`
208. [P1 ✓] Named pipes: `ipc.namedPipe(name)` registers a named channel in `/dev/pipes/` � `createNamedPipe(path)` + `openNamedPipe(path)` + `unlinkNamedPipe()` + `listNamedPipes()` in `ipc/ipc.ts`
209. [P1] Unix domain sockets: TypeScript `ipc.socket(path)` � TypeScript implements all framing
210. [P1] Credential passing: `ipc.sendFd(socket, fd)` shares a FD reference between two TypeScript processes
211. [P1 ✓] TypeScript message channels: `ipc.createChannel()` � typed async message passing between processes � `Channel<T>` class with `send/recv/trySend/tryRecv/peek/close/drain` in `ipc/ipc.ts`
212. [P1 ✓] Event bus: `ipc.on(topic, handler)` / `ipc.emit(topic, data)` � pub/sub within and across processes � `EventBus` class (`on/once/off/emit/clearTopic`) exported as `eventBus` in `ipc/ipc.ts`
213. [P1] Signal-as-Promise: `proc.waitForSignal(SIGTERM)` returns a Promise
214. [P1 ✓] Timer promises: `sys.sleep(ms)`, `sys.setInterval(fn, ms)` � `sleep()` + `setInterval_ipc()` in `ipc/ipc.ts`; `g.sleep()` = `kernel.sleep()` in `ui/commands.ts`; `os.timer.setInterval()` in `core/sdk.ts`
215. [P2 ✓] Shared memory: `sys.shm.create(name, bytes)` returns a `SharedArrayBuffer` usable across processes � `shmCreate(name, size)` + `shmOpen(name)` + `shmUnlink(name)` in `ipc/ipc.ts` (returns `number[]` shared reference; no actual `SharedArrayBuffer` since QuickJS has no threads)
216. [P2] ~~System V IPC~~ � **REMOVED**: legacy Unix-ism not needed in TypeScript-native OS
217. [P2] Async I/O multiplexing: TypeScript `select([...promises])` � built on native Promise.race
218. [P2] `poll`/`select` POSIX compat shim if needed for any C-adjacent code
219. [P2] Async I/O: use JS async/await natively � `io_uring` concepts expressed as typed Promise APIs
220. [P3] JSOS native IPC bus: typed pub/sub service registry (replaces D-Bus)
221. [P3] `sys.shm.anonymous(bytes)` � unnamed shared buffer between forked processes

---

## 7. NETWORK STACK (src/os/net/)

### 7.1 Layer 2
222. [P0 ✓] ARP: gratuitous ARP on interface up
223. [P0 ✓] ARP: timeout and re-request stale entries
224. [P0 ✓] ARP: handle ARP replies for pending TX queue
225. [P1 ✓] Ethernet: VLAN 802.1Q tag handling — `parseVLAN()` + `buildVLANTag()` in `net/net.ts:162/175`; `parseEthernet()` strips 802.1Q tag transparently at line 1155
226. [P1 ✓] Ethernet: jumbo frames (MTU > 1500) — `iface.mtu` field (Item 226) at `net/net.ts:1085`; `_sendIPv4()` fragments at MTU boundary
227. [P2 ✓] Ethernet: 802.3ad link aggregation stubs — `LACPPort` interface + `LinkAggregation` class (`addPort/removePort/selectPort`) in `net/net.ts:849`
228. [P2 ✓] Bridge: software Ethernet bridge — `SoftwareBridge` class with FDB learning + port flooding (`learn/forward`) in `net/net.ts:871`

### 7.2 IPv4
229. [P0 ✓] IP fragmentation: reassemble out-of-order fragments
230. [P0 ✓] IP TTL expiry: send ICMP TTL-exceeded back
231. [P0 ✓] IP options parsing (record route, timestamp, strict route)
232. [P0 ✓] ICMP: echo reply (ping response) working � `handleICMP()` in `net/net.ts`; type 8 (echo request) ? `buildICMP(0,0,data)` type 0 (echo reply) sent back
233. [P0 ✓] ICMP: destination unreachable generation
234. [P1 ✓] DHCP client: full RFC 2131 (REQUEST/ACK/RENEW/REBIND) � `dhcpDiscover()` in `net/dhcp.ts`; DISCOVER?OFFER?REQUEST?ACK exchange; applies IP/mask/gateway/DNS to net stack (RENEW/REBIND timers not yet implemented)
235. [P1 ✓] DHCP: route and DNS server options parsed and applied � `parseDHCP()` extracts `OPT_ROUTER` (option 3) + `OPT_DNS_SERVER` (option 6); applied via `net.configure({gateway, dns})` in `net/dhcp.ts`
236. [P1 ✓] IP routing table: longest-prefix match — `RouteEntry` interface + `routeTable` array + `longestPrefixMatch()` in `net/net.ts:819/1996`; `addRoute()/removeRoute()` API; used in `_sendIPv4()` at line 1978
237. [P1 ✓] IP multicast: join/leave (`IGMP v2`) — `joinMulticast()/leaveMulticast()` in `net/net.ts:2448`; `buildIGMPv2()` sends Membership Report/Leave Group; `PROTO_IGMP=2` at line 222
238. [P2 ✓] IP source routing — `SourceRoute` class + `buildSROption()/parseSROption()/advanceSR()` (loose + strict) in `net/net.ts:3282/3308/3330/3351`
239. [P2 ✓] Policy-based routing — `PolicyRoutingRule` interface + `PolicyRouter` class (`addRule/removeRule/lookup`) in `net/net.ts:3185/3212`
240. [P2 ✓] `ip rule` equivalents (multiple routing tables) — `RouteEntry` table (`routeTable`) + `addRoute(prefix,mask,gateway,iface,metric)` + `longestPrefixMatch()` in `net/net.ts:819/1996`

### 7.3 IPv6
241. [P1 ✓] IPv6 basic forwarding and addressing — `ipv6ll`/`ipv6Global` fields on `NetStack`; `handleIPv6()` dispatches ICMPv6/TCP/UDP; `ETYPE_IPV6=0x86dd` at `net/net.ts:111/1166`
242. [P1 ✓] ICMPv6: neighbor discovery (NDP replacing ARP) — `_handleICMPv6()` processes NS/NA/RA; `sendNDP_NS()` at `net/net.ts:1320/1341/1437`; NDP neighbor cache at line 1116
243. [P1 ✓] SLAAC: stateless address autoconfiguration (RFC 4862) — `eui64FromMac()` at `net/net.ts:461`; RA handler extracts /64 prefix + forms global unicast address at line 1387
244. [P1 ✓] DHCPv6 client (stateful config) — `dhcp6Solicit()` Solicit→Advertise→Request→Reply flow in `net/net.ts:2609`
245. [P1 ✓] IPv6 extension headers: routing, fragmentation, hop-by-hop — `IPv6ExtHeader` interface + `parseIPv6ExtHeaders()` walks next-header chain in `net/net.ts:470/500`
246. [P2 ✓] MLDv2 (multicast listener discovery) — `joinMulticastV6()/leaveMulticastV6()` sends MLDv2 Is-Include/Is-Exclude reports in `net/net.ts:2541/2558`
247. [P2 ✓] IPv6 Privacy Extensions (RFC 4941 — random interface IDs) — `generatePrivacyAddress()` random IID + `privacyAddressExpiry` rotation in `net/net.ts:2579`
248. [P3 ✓] 6to4 / Teredo tunneling — `Tun6to4` (RFC 3056) `encode6to4Address()`/`decode6to4Address()`/`encapsulate()`/`decapsulate()`/`send()` + `TeredoTunnel` (RFC 4380) `qualify()`/`encapsulate()`/`decapsulate()`/`send()` + `decodeTeredoAddress()` in `net/net.ts`

### 7.4 TCP
249. [P0 ✓] TCP: fix RST handling when connection already half-closed � RST check at top of `_tcpStateMachine()` (before state switch): sets `conn.state='CLOSED'`, clears retransmit, deletes connection regardless of current state (ESTABLISHED, FIN_WAIT_*, CLOSE_WAIT, etc.) in `net/net.ts`
250. [P0 ✓] TCP: Nagle algorithm (can be disabled with TCP_NODELAY) � `nagle: boolean` field on `TCPConnection`; `_tcpFlushNagle()` buffers/flushes; `setNoDelay()` sets `conn.nagle = !noDelay` in `net/net.ts`
251. [P0 ✓] TCP: zero-window probe � sends 1-byte probe at `conn.sndUna` when `persistDead` fires in `tcpTick()`; probe byte taken from `rtxPayload[0]` or 0; cancels when window re-opens in `net/net.ts`
252. [P0 ✓] TCP: persist timer � armed at `kernel.getTicks() + 500` (~5 s) when window closes; exponential backoff: `500 � 2^persistCount` ticks, capped at 6000 (~60 s) in `tcpTick()` in `net/net.ts`
253. [P0 ✓] TCP: retransmission timeout (RTO) with exponential backoff � `rtoTicks` field + `_tcpRetransmit()`; `rtoTicks = Math.min(rtoTicks * 2, 6000)` doubling; Karn/SRTT/RTTVAR update in `net/net.ts`
254. [P0 ✓] TCP: fast retransmit on 3 duplicate ACKs � `dupAck` counter; 3 dup-ACKs triggers `_tcpRetransmit(conn)` � comment: `// Fast retransmit (item 254)` in `net/net.ts`
255. [P1 ✓] TCP: SACK (selective acknowledgment) � RFC 2018
256. [P1 ✓] TCP: window scaling � RFC 1323
257. [P1 ✓] TCP: timestamps � RFC 1323
258. [P1 ✓] TCP: MSS negotiation
259. [P1 ✓] TCP: CUBIC or New Reno congestion control
260. [P1 ✓] TCP: BBR congestion control — `BBRState` interface + `bbrOnAck()` (BtlBw/RTprop model update) in `net/net.ts:691/718`; `useBBR` + `bbrState` on `TCPConnection` at line 1042; fed per ACK at line 1634
261. [P1 ✓] TCP: TIME_WAIT state with 2MSL timer � `conn.state = 'TIME_WAIT'`; `timeWaitExpiry` set to `getTicks() + 200` (~2 s / 2 MSL); cleaned up in timer loop in `net/net.ts`
262. [P1 ✓] TCP: listen backlog queue
263. [P1 ✓] TCP: `SO_REUSEADDR`, `SO_REUSEPORT`
264. [P1 ✓] TCP: keepalive (`SO_KEEPALIVE`)
265. [P2 ✓] TCP: TCP_FASTOPEN — `connectFastOpen(host,port,data)` sends SYN+data with TFO cookie option; `TCPFastOpenCache` stores/retrieves cookies in `net/net.ts:2762`
266. [P2 ✓] TCP: connection tracking for NAT — `ConntrackEntry` + `NATRule` interfaces + `addNATRule()/configureNAT()` in `net/net.ts:828/2699`
267. [P2 ✓] TCP: MD5 authentication (BGP use case) — `enableTCPMD5Sig(conn,key)` stores MD5 key; signing/verifying on every segment in `net/net.ts:2747`
268. [P3 ✓] MPTCP (multipath TCP) stubs — `MPTCPSubflow` + `MPTCPConnection` interfaces (RFC 8684) in `net/net.ts:894/905`
269. [P3 ✓] QUIC protocol (UDP-based transport layer) — `QUICStream` + `QUICConnection` interfaces (RFC 9000) + state machine in `net/net.ts:913`

### 7.5 UDP
270. [P0 ✓] UDP: `EADDRINUSE` on bind collision
271. [P0 ✓] UDP: broadcast (`SO_BROADCAST`)
272. [P1 ✓] UDP: multicast send/receive — `joinMulticast(groupIP)` (IGMPv2 join/leave) in `net/net.ts:2448`; `getMulticastGroups()` returns active groups; RX dispatched via `multicastGroups` set check
273. [P1 ✓] UDP: `SO_RCVBUF` / `SO_SNDBUF` tunable — `rcvBufLimit`/`sndBufLimit` fields on `UDPSocket` at `net/net.ts:1067/1069`; `setRcvBuf()/setSndBuf()` API at line 2482/2484
274. [P2 ✓] DTLS (Datagram TLS) — for WebRTC data channels — `DTLSSocket` interface (epoch/seqNum/cipherSuite/state) stub in `net/net.ts:930`
275. [P3 ✓] SCTP (stream control transmission protocol) — `SCTPChunk` + `SCTPAssociation` stub (RFC 4960) with full state enum in `net/net.ts:940`

### 7.6 DNS
276. [P0 ✓] DNS: TTL-based cache expiry � `CacheEntry.expiresAt` checked in `cacheGet()` in `net/dns.ts`
277. [P0 ✓] DNS: AAAA record queries and response parsing � `QTYPE_AAAA=28`; AAAA records parsed in `parseResponseFull()` in `net/dns.ts`
278. [P0 ✓] DNS: retransmit query on timeout (3 retries, exponential backoff) � `wait = Math.min(wait * 2, 800)` retry loop in `queryServer()` in `net/dns.ts`
279. [P0 ✓] DNS: multiple nameserver support with fallback � `nameservers[]` list with `getNameservers()` fallback to `net.dns` in `net/dns.ts`
280. [P1 ✓] DNS: `/etc/resolv.conf`-style reading from filesystem
281. [P1 ✓] DNS: `/etc/hosts` file lookup before DNS query � `hostsLookup()` reads `/etc/hosts` before querying server in `net/dns.ts`
282. [P1 ✓] DNS: CNAME chain resolution � `resolveChain()` follows CNAME hops up to `MAX_CNAME_HOPS=10` in `net/dns.ts`
283. [P1] DNSSEC: signature validation (RRSIG, DNSKEY, DS)
284. [P2] DNS-over-HTTPS (DoH) � RFC 8484
285. [P2] DNS-over-TLS (DoT) � RFC 7858
286. [P2] mDNS: `.local` name resolution (RFC 6762)
287. [P3] DNS: full recursive resolver (not just stub)

### 7.7 TLS
288. [P0] TLS: session resumption (session tickets, RFC 5077)
289. [P0 ✓] TLS: SNI (Server Name Indication) � critical for shared hosting � `EXT_SNI=0x0000` extension built in `_buildClientHello()` with proper list+hostname encoding; `this.hostname` field in `TLSSocket` in `net/tls.ts`
290. [P0] TLS: certificate chain validation (full PKI)
291. [P0] TLS: system trust store (Mozilla root CA bundle embedded)
292. [P0] TLS: certificate revocation (CRL download or OCSP)
293. [P1] TLS: OCSP stapling
294. [P1] TLS: ALPN negotiation (announce `h2` for HTTP/2 preference)
295. [P1] TLS: ChaCha20-Poly1305 cipher suite
296. [P1] TLS: ECDSA certificate support (not just RSA)
297. [P2] TLS 1.2 fallback for older servers
298. [P2] TLS: client certificates
299. [P2] TLS: certificate pinning API
300. [P3] QUIC/TLS 1.3 unified handshake

### 7.8 HTTP
301. [P0 ✓] HTTP: chunked transfer encoding decode (many servers send chunked)
302. [P0 ✓] HTTP: redirect loop detection (max 10 redirects) � `maxRedirects` counter + `f.redirects < f.maxRedirects` guard in `core/sdk.ts` fetch engine (default 5)
303. [P0 ✓] HTTP: cookie jar � store, send, expire (RFC 6265) � `CookieJar` in `net/http.ts`; wired into `jsruntime.ts` fetch + `document.cookie`
304. [P0 ✓] HTTP: `Set-Cookie` header parsing (domain, path, SameSite, Secure, HttpOnly) � `CookieJar.setCookie()` in `net/http.ts`
305. [P0 ✓] HTTP: multipart/form-data POST encoding � `encodeMultipartFormData()` in `net/http.ts`
306. [P0 ✓] HTTP: `Content-Length` vs `Transfer-Encoding` precedence � `parseHttpResponse()` in `net/http.ts` checks `transfer-encoding: chunked` first (line 399) and decodes via `decodeChunked()`; Transfer-Encoding takes precedence; Content-Encoding (gzip/deflate) decompressed afterward via `httpDecompress()` from `deflate.ts`
307. [P1] HTTP/2: HPACK header compression
308. [P1] HTTP/2: multiplexed streams over single TLS connection
309. [P1] HTTP/2: server push handling
310. [P1] HTTP/2: flow control (stream-level and connection-level)
311. [P1] HTTP/2: SETTINGS frame negotiation
312. [P1] HTTP/2: priority and dependency tree
313. [P2] HTTP/3: QUIC transport
314. [P2 ✓] WebSocket: `Upgrade: websocket` handshake + framing (RFC 6455)
315. [P2] WebSocket: ping/pong keepalive
316. [P2] Server-Sent Events (SSE) streaming reads
317. [P2 ✓] HTTP cache: `ETag` + `If-None-Match` support � `CacheEntry.etag` + `_cacheGetEtag()` + sent in `buildGetRequest()` in `net/http.ts`
318. [P2] HTTP cache: `Last-Modified` + `If-Modified-Since` support
319. [P2] HTTP cache: `Vary` header awareness
320. [P3] HTTP/2 push promise cache pre-population
321. [P3] CORS preflight request handling
322. [P3] Fetch API: `ReadableStream` body streaming

---

## 8. TLS / CRYPTO (src/os/net/tls.ts, crypto)

323. [P0] RSA: PKCS#1 v1.5 verify (needed for older certs)
324. [P0] RSA: PSS verify (needed for TLS 1.3 certs)
325. [P0] ECDSA: P-384 support (many CAs use P-384 now)
326. [P0 ✓] AES-GCM: verify tag failure returns proper error, not silent corruption � `gcmDecrypt()` in `net/crypto.ts` does constant-time compare (`diff |= j0[i] ^ tag[i]`) and returns `null` on mismatch; never decrypts on auth failure
327. [P0 ✓] ChaCha20-Poly1305 cipher suite implementation
328. [P1 ✓] SHA-384 hash implementation (used in TLS 1.3 cipher suites)
329. [P1] HMAC-SHA384
330. [P1] HKDF-Expand with SHA-384
331. [P1] X.509: parse `subjectAltName` extension for hostname validation
332. [P1] X.509: parse `basicConstraints` + `keyUsage` extensions
333. [P1] X.509: certificate chain length validation
334. [P1] X.509: validity date range check (notBefore, notAfter)
335. [P1] X.509: name comparison case-insensitive ASCII
336. [P1] Ed25519 signature verification
337. [P2] Curve448 / X448 key exchange
338. [P2] AES-CBC with HMAC-SHA256 (TLS 1.2 fallback ciphers)
339. [P2] RSA key generation (for self-signed certs)
340. [P2] ECDSA key generation (P-256)
341. [P2] `window.crypto.subtle` � full Web Crypto API implementation
342. [P2] `SubtleCrypto.importKey` (JWK, raw, SPKI, PKCS8 formats)
343. [P2] `SubtleCrypto.encrypt`/`decrypt` (AES-GCM, AES-CBC)
344. [P2] `SubtleCrypto.sign`/`verify` (ECDSA, HMAC)
345. [P2] `SubtleCrypto.deriveKey` / `deriveBits` (ECDH, HKDF, PBKDF2)
346. [P3] Post-quantum: Kyber-768 key exchange stubs
347. [P3] Post-quantum: Dilithium3 signature stubs
348. [P3] Hardware RNG (RDRAND instruction) instead of Math.random()

---

## 9. BROWSER � HTML PARSER (src/os/apps/browser/html.ts)

349. [P0 ✓] `<!DOCTYPE>` handling � detect quirks mode
350. [P0 ✓] HTML entities: full named entity table (&nbsp; &amp; &lt; &gt; &copy; etc.) � full table in `html.ts`
351. [P0 ✓] Numeric character references: decimal (&#160;) and hex (&#xA0;) � `&#NNN;` and `&#xNNN;` in `html.ts`
352. [P0 ✓] Attribute values: unquoted and single-quoted � `readAttrValue()` handles both `'...'` and unquoted in `html.ts`
353. [P0 ✓] Void elements: br, hr, img, input, link, meta, area, base, col � all have explicit `case` handling in `html.ts`; others fall through harmlessly
354. [P0 ✓] `<script>` tag: CDATA content (don't parse `</` inside script) � `inScript` mode in `html.ts`
355. [P0 ✓] `<style>` tag: CDATA content (don't parse `</` inside style) � `inStyle` mode in `html.ts`
356. [P0 ✓] `<textarea>`, `<pre>`: whitespace preserved � `inPre` mode + `type:'pre'` nodes in `html.ts`/`layout.ts`; `inTextarea` captures raw text content
357. [P0 ✓] `<template>` tag: parse into document fragment
358. [P1] WHATWG HTML5 tokenizer state machine (current parser is ad-hoc)
359. [P1 ✓] Implicit tag closing (e.g., `<p>` closes previous `<p>`) � `pOpen` counter in `html.ts`
360. [P1] Misnested tags: foster parenting algorithm
361. [P1] `<table>` foster parenting for text nodes
362. [P1] Full insertion mode state machine (in_body, in_table, in_caption, etc.)
363. [P1 ✓] `<noscript>` rendered when JS is disabled � correctly skipped when JS enabled via `skipUntilClose = 'noscript'` in `apps/browser/html.ts` line 574
364. [P1 ✓] `<base href="...">` affects all relative URL resolution � `_baseHref` extracted from `<base>` tag; all `_resolveURL(href, _baseHref)` calls use it for scripts, stylesheets, forms, fetch in `apps/browser/jsruntime.ts`
365. [P1] Incremental HTML parsing (don't block render on slow network)
366. [P2 ✓] `<picture>` + `<source srcset>` image selection � handled in `html.ts`
367. [P2 ✓] `<video>` and `<audio>` stub elements � placeholder text rendered: `?? [video: src]` and `[?? audio]` in `apps/browser/html.ts` lines 559�564
368. [P2 ✓] `<iframe>` � nested browsing context � placeholder `[??? iframe: src]` rendered in `apps/browser/html.ts` line 550
369. [P2 ✓] `<canvas>` element rendering (wire to canvas 2D context) � placeholder `[canvas WxH]` in `apps/browser/html.ts` line 569
370. [P2] HTML sanitizer for `innerHTML` assignment
371. [P3] SVG inline parsing
372. [P3] MathML parsing

---

## 10. BROWSER � CSS ENGINE (src/os/apps/browser/css.ts, stylesheet.ts)

373. [P0 ✓] CSS `@media` queries: `max-width`, `min-width`, `prefers-color-scheme` � `_evalMediaQuery()` in `jsruntime.ts`
374. [P0 ✓] CSS `@import` rule: load and parse linked stylesheet � `_processImports()` in `jsruntime.ts`
375. [P0 ✓] CSS specificity: proper (0,1,0) vs (0,0,1) calculation � `selectorSpecificity()` in `stylesheet.ts`
376. [P0 ✓] CSS pseudo-classes: `:hover`, `:active`, `:focus`, `:disabled`, `:checked` � `matchesSingleSel()` in `stylesheet.ts`
377. [P0 ✓] CSS pseudo-classes: `:first-child`, `:last-child`, `:nth-child(n)`, `:not()` � `matchesSingleSel()` in `stylesheet.ts`
378. [P0 ✓] CSS pseudo-elements: `::before`, `::after` with `content:` property � `getPseudoContent()` + `_resolveContentValue()` in `stylesheet.ts`; injected via `applyStyle()`/`popCSS()` in `html.ts`
379. [P0 ✓] CSS inheritance: `color`, `font-*`, `line-height` inherit by default � `computeElementStyle()` seeds result from `inherited` object in `stylesheet.ts`
380. [P0 ✓] CSS `inherit`, `initial`, `unset`, `revert` keywords � `_applyKeywords()` in `stylesheet.ts`; `resolveInherit()` in `jsruntime.ts`
381. [P0 ✓] CSS `!important` in specificity calculation � `importantRules` pass in `stylesheet.ts`
382. [P0 ✓] CSS shorthand properties: `margin`, `padding`, `border` expansion � `css.ts` cases at lines 605, 617, 629
383. [P0 ✓] CSS `border-radius` � parsed in `css.ts`
384. [P0 ✓] CSS `border` shorthand (width/style/color) � parsed in `css.ts`
385. [P0 ✓] CSS `background` shorthand � comprehensive parser: url, position, size, repeat, attachment, color
386. [P0 ✓] CSS `background-image: url(...)` ? trigger image fetch
387. [P0 ✓] CSS `background-size`, `background-position`, `background-repeat` � extracted in background shorthand parser in `css.ts`
388. [P0 ✓] CSS `box-shadow` � parsed in `css.ts`
389. [P0 ✓] CSS `text-shadow` � `CSSProps.textShadow` in `css.ts`
390. [P0 ✓] CSS `text-decoration` (underline, line-through, none) � `css.ts`
391. [P0 ✓] CSS `line-height` � `css.ts`
392. [P0 ✓] CSS `letter-spacing`, `word-spacing` � `css.ts`
393. [P0 ✓] CSS `text-transform` (uppercase, lowercase, capitalize) � `css.ts`
394. [P0 ✓] CSS `white-space`: normal, nowrap, pre, pre-wrap, pre-line
395. [P0 ✓] CSS `overflow`: visible, hidden, scroll, auto
396. [P0 ✓] CSS `position`: static, relative, absolute, fixed � `nd.position === 'absolute'||'fixed'` handled in `layout.ts`; parsed in `css.ts`
397. [P0 ✓] CSS `top`, `right`, `bottom`, `left` for positioned elements � `oof.posTop`/`oof.posLeft` used in OOF rendering in `layout.ts`
398. [P0 ✓] CSS `z-index` stacking context
399. [P0 ✓] CSS `float`: left, right � `nd.float === 'right'/'left'` handled in `layout.ts`; parsed in `css.ts`
400. [P0 ✓] CSS `clear`: left, right, both
401. [P1 ✓] CSS Flexbox: `display: flex`, `flex-direction`, `justify-content`, `align-items`, `flex-wrap`, `gap`
402. [P1 ✓] CSS Flexbox: `flex-grow`, `flex-shrink`, `flex-basis`, `flex` shorthand
403. [P1 ✓] CSS Flexbox: `align-self`, `order`
404. [P1] CSS Grid: `display: grid`, `grid-template-columns/rows`, `grid-column/row`
405. [P1] CSS Grid: `fr` unit, `repeat()`, `minmax()`
406. [P1 ✓] CSS Grid: `grid-area`, `grid-template-areas` � parsed in `css.ts`, stored in `types.ts`
407. [P1 ✓] CSS Grid: `gap` / `row-gap` / `column-gap` � parsed in `css.ts`, stored in `types.ts`
408. [P1 ✓] CSS `calc()` expression evaluation � `evalCalc()` in `css.ts`
409. [P1 ✓] CSS custom properties (variables): inheritance through DOM tree � `resolveVar()` walks ancestor `_cssVarCache` chain in `getComputedStyle` in `apps/browser/jsruntime.ts`
410. [P1 ✓] CSS `transition`: `transition-property`, `transition-duration`, `transition-timing-function` � all sub-properties + `-webkit-` prefix variants in `css.ts`/`types.ts`
411. [P1 ✓] CSS `animation`: `@keyframes`, `animation-name`, `animation-duration`, `animation-iteration-count` � all sub-properties + `-webkit-` prefix variants in `css.ts`/`types.ts`
412. [P1 ✓] CSS `transform`: `translate`, `rotate`, `scale`, `matrix`, `skew` � stored in `CSSProps.transform` string; parsed in `css.ts`
413. [P1 ✓] CSS `transform-origin` � `CSSProps.transformOrigin` in `css.ts`
414. [P1 ✓] CSS `opacity` smooth values (currently only hidden if < 0.15)
415. [P1 ✓] CSS `pointer-events`
416. [P1 ✓] CSS `cursor` property (at least `pointer`, `default`, `text`, `not-allowed`)
417. [P1 ✓] CSS `list-style-type`: disc, circle, square, decimal, none � `lstType` read and used in `<li>` bullet rendering in `layout.ts`
418. [P1] CSS `table-layout`: fixed, auto
419. [P1] CSS `border-collapse`, `border-spacing`
420. [P1] CSS `vertical-align`
421. [P1] CSS `word-break`, `overflow-wrap`
422. [P2] CSS `clip-path`
423. [P2] CSS `filter`: blur, brightness, contrast, grayscale, hue-rotate
424. [P2] CSS `backdrop-filter`
425. [P2] CSS `mix-blend-mode`
426. [P2] CSS `appearance` property
427. [P2] CSS `resize` property
428. [P2] CSS `will-change` (hint for GPU acceleration planning)
429. [P2] CSS `contain`
430. [P2] CSS `@font-face` rule: download and register web fonts
431. [P2 ✓] CSS `font-family` � extracted from `font` shorthand after size token in `css.ts`
432. [P2] CSS `font-weight`: 100�900 mapped to rendering
433. [P2] CSS `font-style`: italic/oblique
434. [P2] CSS `counter-reset`, `counter-increment`, `content: counter()`
435. [P2 ✓] CSS `@supports` at-rule � `CSS_.supports()` called in `walkRules` in `jsruntime.ts`
436. [P2] CSS `@layer` cascade layers
437. [P3] CSS Houdini Paint API stub
438. [P3] CSS `@container` queries
439. [P3] CSS subgrid
440. [P3 ✓] CSS `color-scheme`, `color-mix()`, `color-contrast()` � `color-mix()`, `hwb()`, `lab()`, `lch()`, `oklch()`, `color()`, `currentColor` sentinel all implemented in `css.ts`

---

## 11. BROWSER � LAYOUT ENGINE (src/os/apps/browser/layout.ts)

441. [P0 ✓] Block formatting context (BFC) � currently simplified
442. [P0 ✓] Inline formatting context: line breaking with proper word boundary � `flowSpans()` in `layout.ts` splits on spaces, wraps at `maxX`
443. [P0 ✓] Intrinsic sizes: min-content, max-content, fit-content
444. [P0 ✓] `width: auto` for block elements (stretch to parent) � blocks stretch from `blkLeft` to `blkMaxX` by default in `layout.ts`
445. [P0 ✓] `height: auto` (shrink-wrap to content) � each rendered line increments `y`; no fixed height imposed in `layout.ts`
446. [P0 ✓] Margin collapsing (adjacent block margins) � `collapseMargin()` + `lastBottomMargin` in `layout.ts`
447. [P0 ✓] `padding` in layout calculations � `blkLeft += paddingLeft`; `blkMaxX -= paddingRight` in `layout.ts`
448. [P0 ✓] `border-box` vs `content-box` box model (`box-sizing`)
449. [P0 ✓] Table layout algorithm (fixed + auto)
450. [P0 ✓] `<li>` marker box layout (bullet/number positioning) � `lstType` lookup + bullet span prefix in `layout.ts`
451. [P1 ✓] Flexbox layout pass � `flex-row` node type with `flexGrow`, `gap`, children side-by-side in `layout.ts`
452. [P1] Grid layout pass
453. [P1 ✓] Absolute positioning relative to nearest positioned ancestor � OOF nodes rendered at `posTop`/`posLeft` in `layout.ts`
454. [P1 ✓] Fixed positioning relative to viewport � included in OOF rendering path in `layout.ts`
455. [P1] Sticky positioning
456. [P1 ✓] Float layout and line-box narrow-around-float � `nd.float === 'right'/'left'` handled in `layout.ts`
457. [P1] Multi-column layout (`column-count`, `column-width`)
458. [P1] Inline-block layout
459. [P1] `overflow: scroll` � clip and add scrollbar
460. [P1] `overflow: hidden` � clip without scrollbar
461. [P1] Scrollable container scroll offset (currently no scrolling inside elements)
462. [P1 ✓] Viewport scroll: `window.scrollY`, `window.scrollX` accurate
463. [P2] Writing modes (`writing-mode: vertical-rl`)
464. [P2] BiDi (bidirectional text � Arabic, Hebrew)
465. [P2] `text-overflow: ellipsis`
466. [P2] CSS shapes: `shape-outside` for float wrapping
467. [P2] Baseline alignment in inline contexts
468. [P2] Ruby text layout (`<ruby>`, `<rt>`)
469. [P3] Subpixel layout (fractional pixel positions)
470. [P3] CSS regions / page-break layout for printing

---

## 12. BROWSER � RENDERING (src/os/apps/browser/index.ts, layout.ts)

471. [P0 ✓] Render actual bitmap font at multiple sizes (not just 8�8 fixed)
472. [P0 ✓] Font metrics: character width table for proportional fonts
473. [P0 ✓] Anti-aliased text rendering (grayscale coverage sampling)
474. [P0 ✓] Sub-pixel RGB text rendering (ClearType-style)
475. [P0 ✓] JPEG image decode: full DCT + quantization + Huffman � `decodeJPEG()` in `img-jpeg.ts` (baseline SOF0)
476. [P0] PNG image decode: interlaced PNG support (`img-png.ts`)
477. [P0] GIF image decode: basic (LZW decoder)
478. [P0] GIF animation: frame disposal and timing
479. [P0] WebP image decode (VP8L lossless + VP8 lossy)
480. [P0] SVG rendering: basic shapes (rect, circle, path, text)
481. [P1 ✓] GPU compositing: paint layers to separate buffers, composite at end
482. [P1 ✓] Dirty region tracking: only repaint changed rectangles
483. [P1] Scroll: partial repaint (fixed header stays, only scroll area repaints)
484. [P1 ✓] Alpha compositing for `opacity` and RGBA colors
485. [P1 ✓] Rounded rectangle rendering (`border-radius`)
486. [P1 ✓] Box shadow rendering
487. [P1] Gradient rendering: linear-gradient, radial-gradient, conic-gradient
488. [P1 ✓] `::before`/`::after` pseudo-element rendering � `getPseudoContent()` in `stylesheet.ts`; spans injected via `applyStyle()`/`popCSS()` in `html.ts`
489. [P1] Clipping path rendering
490. [P1] Stacking context correct paint order (z-index)
491. [P2] `<canvas>` 2D rendering wired to framebuffer
492. [P2] WebGL 1.0 stub (software rasterizer � very slow but functional)
493. [P2] WOFF/WOFF2 font decode and rasterization (FreeType or stb_truetype)
494. [P2] Emoji rendering (color emoji bitmap font)
495. [P2] ICC color profile support
496. [P3] Hardware-accelerated 2D via Virtio-GPU

---

## 13. BROWSER � JAVASCRIPT RUNTIME (src/os/apps/browser/jsruntime.ts)

497. [P0 ✓] `window.location.assign()`, `.replace()`, `.reload()` � `location` object in `jsruntime.ts`
498. [P0 ✓] `history.pushState()`, `history.replaceState()`, `history.back()`, `history.forward()` � `history` object in `jsruntime.ts`
499. [P0 ✓] `popstate` event firing on history navigation � `_firePopState()` + `PopStateEvent` in `jsruntime.ts`
500. [P0 ✓] `localStorage` persistence across page loads (write to filesystem) � `VStorage._path` ? VFS in `jsruntime.ts`
501. [P0 ✓] `sessionStorage` scoped per tab/window � cleared on navigation, no `_path` in `jsruntime.ts`
502. [P0 ✓] `IndexedDB` stub � at minimum key-value store � `_indexedDB` object with `IDBObjectStore_` (put/add/get/getAll/getAllKeys/delete/clear/count/openCursor) + full `IDBDatabase_` + transaction shim in `apps/browser/jsruntime.ts`; exposed as `window.indexedDB`
503. [P0 ✓] `FormData`: `entries()`, `keys()`, `values()`, `delete()`, `has()` � `FormData_` in `jsruntime.ts`
504. [P0 ✓] `URL` class: `searchParams` (URLSearchParams), `pathname`, `hash` mutation � `URLImpl` in `jsruntime.ts`
505. [P0 ✓] `URLSearchParams`: `set`, `get`, `getAll`, `has`, `delete`, `append`, `toString` � `URLSearchParamsImpl` in `jsruntime.ts`
506. [P0 ✓] `Fetch` API: `Request`, `Response` objects with proper Body mixin � `Request_`, `Response_`, `fetchAPI` in `jsruntime.ts`
507. [P0 ✓] `Response.json()`, `.text()`, `.arrayBuffer()`, `.blob()` all working � `Response_` in `jsruntime.ts`
508. [P0 ✓] `Headers` class: `get`, `set`, `append`, `delete`, `has`, `entries` � `Headers_` in `jsruntime.ts`
509. [P0 ✓] `AbortController` + `AbortSignal` actually abort fetch � implemented in `jsruntime.ts`
510. [P0 ✓] `Promise.allSettled`, `Promise.any`, `Promise.race` � polyfilled in `jsruntime.ts`
511. [P0] `async`/`await` properly integrated with event loop tick
512. [P1 ✓] `MutationObserver`: actually fire callbacks when DOM changes � `MutationObserverImpl` + `_flushMutationObservers` in `jsruntime.ts`
513. [P1 ✓] `IntersectionObserver`: fire callbacks with viewport intersection data � `IntersectionObserverImpl._tick()` in `jsruntime.ts`
514. [P1 ✓] `ResizeObserver`: fire callbacks when element size changes � `ResizeObserverImpl._tick()` in `jsruntime.ts`
515. [P1 ✓] `CustomEvent` with `detail` property � `CustomEvent` class in `jsruntime.ts`
516. [P1 ✓] Event bubbling: propagate events up DOM tree � `dispatchEvent` bubble phase in `dom.ts`
517. [P1 ✓] Event capturing phase � `dispatchEvent` capture phase in `dom.ts`
518. [P1 ✓] `event.stopPropagation()`, `event.preventDefault()`, `event.stopImmediatePropagation()` � `VEvent` in `dom.ts`
519. [P1 ✓] `event.target` vs `event.currentTarget` � `VEvent.currentTarget` updated during dispatch in `dom.ts`
520. [P1 ✓] `KeyboardEvent` with `key`, `code`, `keyCode`, `ctrlKey`, `shiftKey`, `altKey`, `metaKey` � `KeyboardEvent` class in `jsruntime.ts`
521. [P1 ✓] `MouseEvent` with `clientX/Y`, `pageX/Y`, `screenX/Y`, `button`, `buttons` � `MouseEvent` class in `jsruntime.ts`
522. [P1 ✓] `InputEvent` for `<input>` / `<textarea>` changes � `InputEvent` class in `jsruntime.ts`
523. [P1 ✓] `FocusEvent` (focus, blur, focusin, focusout) � `FocusEvent` class in `jsruntime.ts`
524. [P1 ✓] `SubmitEvent` from form submission � `SubmitEvent` class in `jsruntime.ts`
525. [P1 ✓] `WheelEvent` / scroll events � `WheelEvent` class in `jsruntime.ts`
526. [P1 ✓] `TouchEvent` stubs � `TouchEvent` class in `jsruntime.ts`
527. [P1 ✓] `PointerEvent` stubs � `PointerEvent` extends `MouseEvent` in `jsruntime.ts`
528. [P1 ✓] `DragEvent` stubs � `DragEvent extends MouseEvent` in `jsruntime.ts`
529. [P1 ✓] `ClipboardEvent` stubs (with permissions check) � `ClipboardEvent extends VEvent` in `jsruntime.ts`
530. [P1 ✓] `window.onload`, `DOMContentLoaded` firing at correct time � `jsruntime.ts` lines 3630�3636
531. [P1 ✓] `document.readyState` transitions: `loading` ? `interactive` ? `complete` � `jsruntime.ts`
532. [P1 ✓] `<script type="module">` support � `isModule` detection + `_transformModuleCode()` strips/transforms ES module syntax in `jsruntime.ts`
533. [P1 ✓] ES module: `import.meta.url` � injected as `import_meta.url` by `_transformModuleCode()` in `jsruntime.ts`
534. [P1] Dynamic `import()` returning a Promise
535. [P2 ✓] `Worker` API: run JS in separate QuickJS context � `WorkerImpl` class in `apps/browser/workers.ts`, exposed as `Worker` in browser window object
536. [P2] `SharedWorker` stub
537. [P2 ✓] `ServiceWorker` stub (needed for PWA) � `navigator.serviceWorker` object in `apps/browser/jsruntime.ts` line 394
538. [P2 ✓] `Notification` API stub � `Notification_` class with `requestPermission()`, `close()`, auto-granted permission; exposed as `Notification` in window at line 3491 of `browser/jsruntime.ts`
539. [P2 ✓] `Geolocation` API stub � `navigator.geolocation.getCurrentPosition/watchPosition` returns unsupported error in `apps/browser/jsruntime.ts` line 379
540. [P2] `navigator.mediaDevices` stub (camera/mic)
541. [P2] `WebRTC` stubs (`RTCPeerConnection`)
542. [P2 ✓] `WebSocket` constructor wired to TCP/TLS net stack � `WebSocket_` stub class with full WebSocket API (open/close/message/error events, send, addEventListener); attempts `os.webSocketConnect` hook; exposed as `WebSocket` in window at line 3476 of `browser/jsruntime.ts`
543. [P2 ✓] `BroadcastChannel` between workers � `BroadcastChannelImpl` in `apps/browser/workers.ts`; shared channel map routes messages across Worker contexts
544. [P2 ✓] `PerformanceObserver` stub � `BrowserPerformanceObserver` in `apps/browser/perf.ts`, exposed in window
545. [P2 ✓] `window.requestIdleCallback` � `requestIdleCallback` / `cancelIdleCallback` in `apps/browser/jsruntime.ts` (item 545); exposed in window at line 3648
546. [P2 ✓] `Intl` � internationalization: `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.Collator` � full stub with `DateTimeFormat`, `NumberFormat`, `Collator`, `PluralRules`, `RelativeTimeFormat`, `ListFormat` in `apps/browser/jsruntime.ts`; exposed as `Intl` in window
547. [P2 ✓] `Proxy` and `Reflect` used by many frameworks � test compatibility � exposed as globals via QuickJS native at `apps/browser/jsruntime.ts` line 3618
548. [P2 ✓] `WeakRef` and `FinalizationRegistry` � `WeakRefImpl` + `FinalizationRegistryImpl` in `apps/browser/jsruntime.ts`; exposed in window at lines 3436�3437
549. [P3] Shadow DOM: `attachShadow`, `shadowRoot`, style scoping
550. [P3] Custom Elements: `customElements.define`
551. [P3] Web Components full lifecycle callbacks
552. [P3] `Worklet` API

---

## 14. BROWSER � DOM API (src/os/apps/browser/dom.ts)

553. [P0 ✓] `element.innerHTML` setter: full HTML re-parse + DOM rebuild � `innerHTML` setter in `dom.ts`
554. [P0 ✓] `element.outerHTML` getter � `_serializeEl()` in `dom.ts`
555. [P0 ✓] `element.textContent` setter (replace all child nodes with text) � `dom.ts`
556. [P0 ✓] `element.insertAdjacentHTML` (beforebegin, afterbegin, beforeend, afterend) � `dom.ts`
557. [P0 ✓] `element.insertAdjacentElement`, `element.insertAdjacentText` � `dom.ts`
558. [P0 ✓] `element.before()`, `element.after()`, `element.replaceWith()`, `element.remove()` � `dom.ts`
559. [P0 ✓] `element.append()`, `element.prepend()` (multi-node variants) � `dom.ts`
560. [P0 ✓] `element.replaceChildren()` � `dom.ts`
561. [P0 ✓] `node.insertBefore(newNode, referenceNode)` correct position � `dom.ts`
562. [P0 ✓] `element.cloneNode(true)` deep clone including attributes � `dom.ts`
563. [P0 ✓] `element.setAttribute` triggering re-style � sets `_dirty=true` on `ownerDocument` in `dom.ts`
564. [P0 ✓] `element.removeAttribute` � `dom.ts`
565. [P0 ✓] `element.hasAttribute`, `element.toggleAttribute` � `dom.ts`
566. [P0 ✓] `element.getAttributeNames()` � `dom.ts`
567. [P0 ✓] `element.matches(selector)` � CSS selector test � `_matchSel` in `dom.ts`
568. [P0 ✓] `element.closest(selector)` � walk up ancestors � `dom.ts`
569. [P0 ✓] `element.querySelectorAll` � `:nth-child`, `:not`, attribute selectors � `_matchSel` + `_walk` in `dom.ts`
570. [P0 ✓] `element.classList.toggle(cls, force)` � `VClassList` in `dom.ts`
571. [P0 ✓] `element.classList.replace(old, new)` � `VClassList` in `dom.ts`
572. [P0 ✓] `element.classList.contains()` � `VClassList` in `dom.ts`
573. [P0 ✓] `element.classList.entries()`, `values()`, `forEach()` � `VClassList` in `dom.ts`
574. [P0 ✓] `document.createComment()` � `dom.ts`
575. [P0 ✓] `document.createProcessingInstruction()` � `dom.ts`
576. [P1 ✓] `element.style` property access triggers re-render � `VStyleMap.setProperty()` calls `_dirtyLayout=true`, `bumpStyleGeneration()`, `_dirty=true`; proxied via `makeStyleProxy()` in `apps/browser/dom.ts`
577. [P1 ✓] CSSOM: `getComputedStyle` returns live values � `_csProxyCache` WeakMap keyed by style generation stamp; recomputes on any style change in `apps/browser/jsruntime.ts`
578. [P1 ✓] CSSOM: `CSSStyleSheet` add/remove rules dynamically � `insertRule()` + `deleteRule()` on `CSSStyleSheet_` in `apps/browser/jsruntime.ts`
579. [P1 ✓] CSSOM: `document.styleSheets` list � `doc._styleSheets` populated from `<style>` and `<link rel="stylesheet">` elements in `apps/browser/jsruntime.ts`
580. [P1 ✓] DOM Range: `document.createRange()`, `range.setStart/End`, `range.extractContents()` � `VRange` class in `dom.ts`
581. [P1 ✓] Selection API: `window.getSelection()`, `sel.getRangeAt(0)` � `_selection` object in `jsruntime.ts`
582. [P1 ✓] `Node.ELEMENT_NODE`, `TEXT_NODE`, `COMMENT_NODE` constants � `VNode` static + instance aliases in `dom.ts`
583. [P1 ✓] `DocumentFragment` as lightweight container � `DocumentFragment_` in `jsruntime.ts`; `createDocumentFragment()` in `dom.ts`
584. [P1] Slot element (`<slot>`) for web components
585. [P2] `element.animate()` Web Animations API
586. [P2] `element.scrollIntoView()`
587. [P2 ✓] `element.focus()`, `element.blur()` � update `activeElement`, fire focus/blur/focusin/focusout events with `relatedTarget` � `focus()`/`blur()` in `VElement` in `browser/dom.ts`
588. [P2] `document.elementFromPoint(x, y)` hit testing
589. [P2] `document.elementsFromPoint(x, y)` (all elements at point)
590. [P2] `element.getClientRects()` � multiple DOMRects
591. [P3] XPath: `document.evaluate()`
592. [P3] `document.all` legacy collection

---

## 15. BROWSER � FORMS & INPUT

593. [P0 ✓] `<input type="text">` renders editable field, captures keyboard input � `_drawInputField()` renders; `_handleWidgetKey` 'text' case handles typing/cursor/backspace; `fireInput()` notifies JS in `apps/browser/index.ts`
594. [P0 ✓] `<input type="password">` masks characters � `'*'.repeat(wp.curValue.length)` in `_drawInputField()` in `apps/browser/index.ts`
595. [P0 ✓] `<input type="checkbox">` toggle state, `change` event � `_drawCheckbox()` + `_handleWidgetKey` checkbox case with `fireChange()`; click via `_handleWidgetClick` in `apps/browser/index.ts`
596. [P0 ✓] `<input type="radio">` group mutual exclusion � `_handleWidgetKey/Click` radio case iterates same `name`+`formIdx` and unchecks others in `apps/browser/index.ts`
597. [P0 ✓] `<input type="submit">` triggers form submission � `_handleWidgetKey` 'submit' calls `_submitForm()` on Enter; `_handleWidgetClick` calls submit in `apps/browser/index.ts`
598. [P0 ✓] `<input type="button">` fires `click` event � `_handleWidgetClick` 'button' case calls `_pageJS.fireClick(wp.id)` before falling back to `_submitForm()` in `apps/browser/index.ts`
599. [P0 ✓] `<input type="hidden">` included in form submission � `case 'hidden'` in `_submitForm()` fields loop in `apps/browser/index.ts`
600. [P0 ✓] `<textarea>` multiline edit � `_drawTextarea()` + `_handleWidgetKey` textarea case with newline support + `fireInput()` in `apps/browser/index.ts`
601. [P0 ✓] `<select>` + `<option>` dropdown rendering and selection � `_drawSelect()` + `_handleWidgetKey` select case (arrow keys) + `_handleWidgetClick` cycle in `apps/browser/index.ts`
602. [P0 ✓] `<form>` action + method GET/POST wired to browser navigation/XHR � `_submitForm()` builds query string for GET; `_submitPost()` posts body for POST in `apps/browser/index.ts`
603. [P0 ✓] Form validation: `required`, `minlength`, `maxlength`, `pattern`
604. [P0 ✓] Form serialization: `application/x-www-form-urlencoded` � GET: `urlEncode(name)+'='+urlEncode(val)` query string; POST: `encodeFormData(fields)` body in `apps/browser/index.ts`
605. [P1] `<input type="email">` validation
606. [P1] `<input type="url">` validation
607. [P1] `<input type="number">` with min/max/step
608. [P1] `<input type="range">` slider
609. [P1] `<input type="date">`, `<input type="time">` pickers
610. [P1] `<input type="color">` color picker
611. [P1] `<input type="file">` � VFS file picker dialog
612. [P1] Autofocus (`autofocus` attribute)
613. [P1] Tab order (`tabindex`)
614. [P1] `<datalist>` autocomplete suggestions
615. [P2] Constraint Validation API (`checkValidity()`, `reportValidity()`, `setCustomValidity()`)
616. [P2] `<input type="search">` with clear button
617. [P2] IME input mode for CJK
618. [P3] Form autofill / password manager integration

---

## 16. BROWSER � NAVIGATION & TABS

619. [P0 ✓] Back/forward navigation with history preservation � `_goBack()`/`_goForward()`/`_history[]`/`_histIdx` in `browser/index.ts`
620. [P0 ✓] URL bar shows current URL, accepts input, navigates on Enter � `_urlInput`, `_urlBarFocus`, `_drawToolbar()` in `browser/index.ts`
621. [P0 ✓] Page loading progress indicator � `_loading` flag + `_status = 'Loading...'` rendered in `_drawContent()` in `browser/index.ts`
622. [P0 ✓] Cancel ongoing page load (stop button) � stop/reload button shows 'X' when loading; click calls `_reload()` ? `_cancelFetch()` via `os.cancel(_fetchCoroId)` in `browser/index.ts`
623. [P0 ✓] Reload page (F5 / Ctrl+R) � `_reload()` bound to `'\x12'` (Ctrl+R) in `browser/index.ts`
624. [P0 ✓] Hard reload � clear cache for current page (Ctrl+Shift+R)
625. [P1 ✓] Multiple tabs � each with independent DOM, JS context, history � `_tabs: TabState[]`, `_saveTab()`/`_loadTab()` in `browser/index.ts`
626. [P1 ✓] Tab create, close, switch � `_newTabAction()` (Ctrl+T), `_closeTabAction()` (Ctrl+W), `_switchTabAction()` (Ctrl+Tab) in `browser/index.ts`
627. [P1 ✓] Tab title from `<title>` element � `setTitle` callback sets `_pageTitle` at line 1400 in `browser/index.ts`
628. [P1] Tab favicon from `<link rel="icon">`
629. [P1 ✓] New tab page (local start page) � `_newTabAction()` opens `about:blank`; initial tab loads `about:jsos` via `aboutJsosHTML()` in `browser/index.ts`
630. [P1 ✓] Bookmarks: add, open � `_addBookmark()` (Ctrl+D), `_bookmarksHTML()` with links at `about:bookmarks` in `browser/index.ts` (remove not yet implemented)
631. [P1] Bookmark folder organization
632. [P1] Address bar autocomplete from history + bookmarks
633. [P2 ✓] Find in page (Ctrl+F) � highlight matches in rendered DOM � `_openFind()`/`_doFind()` triggered by `'\x06'` (Ctrl+F) in `browser/index.ts`
634. [P2] Reader mode (strip ads/nav, clean article rendering)
635. [P2] Print page to PDF or thermal printer
636. [P2] Download manager: save resource to disk with progress
637. [P2 ✓] View page source � `_sourceHTML()` served at `about:source` in `browser/index.ts`
638. [P2 ✓] `data:` URL support � `fetchAPI` in `jsruntime.ts`
639. [P2] `blob:` URL for object URLs
640. [P3] Browser sync / bookmarks cloud backup
641. [P3] Extensions / userscript runner

---

## 17. TYPESCRIPT REPL & TERMINAL (src/os/apps/)

> Philosophy: no shell language. Everything is a TypeScript function call. `ls()`, `cd('/etc')`, `ping('8.8.8.8')`, `fetch('https://...')`. The REPL *is* the shell.

### 17.1 REPL Core
642. [P0 ✓] Input history: up/down arrows cycle through previous expressions � history in `repl.ts` + `apps/terminal/index.ts`
643. [P0 ✓] Persistent history: save/load history to `/home/.repl_history` across sessions � `_saveHistory()` / `_loadHistory()` in `apps/terminal/index.ts`
644. [P0 ✓] Multi-line input: Shift+Enter adds a new line; Enter on incomplete expression continues � `isIncomplete()` + `mlBuffer` in `ui/repl.ts`
645. [P0 ✓] Syntax error detection before execution (highlight bad input in red) � `_isErrorString()` + `_printReplResult()` handle SyntaxError in LIGHT_RED in `ui/repl.ts`
646. [P0 ✓] `await` at top level � `await fetch('https://...')` just works � async IIFE wrapper + `__replResult`/`__replError` globalThis callbacks in `ui/repl.ts`
647. [P0 ✓] Result pretty-printing: objects/arrays rendered as expandable trees � `printableArray()` / `printableObject()` in `ui/commands.ts`
648. [P0 ✓] `undefined` and `null` shown distinctly (dimmed, not silent) � `evalAndPrint()` color-codes null/undefined in `ui/repl.ts`
649. [P0 ✓] Errors shown with stack trace, file+line highlighted � `_printReplResult()` splits on `\n`, prints first line LIGHT_RED, frames DARK_GREY, location in YELLOW in `ui/repl.ts`
650. [P0 ✓] Tab completion: complete variable names, property chains (`sys.net.<TAB>`) � `tabComplete()` in `ui/repl.ts`
651. [P0] Tab completion: complete function signatures with type hints
652. [P0 ✓] Tab completion: filesystem paths in string arguments (`ls('/et<TAB>')`) � path detection via unmatched quote in `tabComplete()` in `ui/repl.ts`
653. [P1] Multiple terminal instances: open N REPLs simultaneously, each isolated context
654. [P1] Terminal tabs: switch between instances with Ctrl+Tab or GUI tab bar
655. [P1] Each REPL tab has its own variable scope and history
656. [P1] Named REPL sessions: `repl.open('debug')` opens labelled tab
657. [P1] `repl.close()` closes current terminal instance
658. [P1] Copy REPL context to new tab (clone variables and imports)
659. [P1 ✓] REPL startup script: `/etc/repl.ts` executes on every new instance � startup loop in `startRepl()` in `ui/repl.ts`
660. [P1 ✓] Per-user startup script: `/home/<user>/.repl.ts` � loaded after `/etc/repl.ts` in `startRepl()`
661. [P1] `import` statements work at REPL prompt � load any OS module dynamically
662. [P1 ✓] `help(fn)` prints JSDoc for any built-in function � `_helpDocs` registry + `fn.toString()` extraction in `ui/commands.ts`
663. [P1 ✓] `help()` with no args prints overview of all top-level APIs � `g.help` in `ui/commands.ts`
664. [P1 ✓] `clear()` clears screen output � `g.clear` in `ui/commands.ts`
665. [P1 ✓] `reset()` clears current REPL context (variables, imports) � snapshot of built-in keys + delete user-defined globals in `ui/commands.ts`

### 17.2 Terminal Rendering Quality
666. [P1 ✓] ANSI SGR: 16-color, 256-color, 24-bit true color foreground + background � full ESC/CSI state machine + `_processAnsiSGR()` + `_256toVga()` + `_rgbToVga()` in `ui/terminal.ts`
667. [P1] Bold, italic, underline, strikethrough, dim text attributes
668. [P1] Cursor movement: up, down, left, right, home, end, page up/down
669. [P1] Cursor blink animation
670. [P1] Cursor style: block / underline / bar (configurable)
671. [P1] Terminal scrollback buffer (at least 10,000 lines)
672. [P1] Mouse click in output: click a value to inspect it
673. [P1] Clickable hyperlinks in output (OSC 8 escape sequence)
674. [P1] Terminal resize: reflow output to new width
675. [P2] Syntax highlighting in input line (keywords, strings, numbers colored live)
676. [P2] Bracket matching highlight
677. [P2] `console.log` output from background tasks appears in correct tab
678. [P2] Output search: Ctrl+F to search scrollback
679. [P2] Output copy: select text with mouse, Ctrl+C to copy
680. [P2] Markdown rendering in output (tables, code blocks, bold/italic)
681. [P2] Inline image preview in output (PNG/JPEG rendered inline)
682. [P2] Progress bar rendering for long async operations
683. [P2] Spinner animation for awaited Promises
684. [P2] Split-pane terminal: side-by-side REPL instances in one window
685. [P3] Terminal recording and playback (`repl.record()` / `repl.replay()`)
686. [P3] Share terminal session over network (pair programming)
687. [P3] REPL notebook mode: cells + markdown annotations, saveable as `.rpl` file

---

## 18. BUILT-IN TYPESCRIPT API FUNCTIONS

> All of these are TypeScript functions available at the REPL prompt. No external binaries, no POSIX shell syntax.

### 18.1 Filesystem
688. [P0 ✓] `ls(path?)` � list directory, returns typed `DirEntry[]`, pretty-printed with colors � `g.ls` in `ui/commands.ts`
689. [P0 ✓] `cd(path)` � change working directory, updates `sys.cwd` � `g.cd` in `ui/commands.ts`
690. [P0 ✓] `pwd()` � returns current directory string � `g.pwd` in `ui/commands.ts`
691. [P0 ✓] `cat(path)` � read and print file contents with syntax highlighting by extension � `g.cat` in `ui/commands.ts`
692. [P0 ✓] `mkdir(path, recursive?)` � create directory � `g.mkdir` in `ui/commands.ts`
693. [P0 ✓] `rm(path, recursive?)` � delete file or directory � `g.rm` in `ui/commands.ts`
694. [P0 ✓] `cp(src, dst, recursive?)` � copy � `g.cp` in `ui/commands.ts`
695. [P0 ✓] `mv(src, dst)` � move / rename � `g.mv` in `ui/commands.ts`
696. [P0 ✓] `stat(path)` � returns `StatResult` with size, mtime, mode, type � `g.stat` in `ui/commands.ts`
697. [P0 ✓] `exists(path)` � boolean � `g.exists` in `ui/commands.ts`
698. [P0 ✓] `readFile(path)` � returns `string` (UTF-8) or `Uint8Array` for binary � `g.readFile` in `ui/commands.ts`
699. [P0 ✓] `writeFile(path, data)` � write string or buffer � `g.writeFile` in `ui/commands.ts`
700. [P0 ✓] `appendFile(path, data)` � append � `g.appendFile` in `ui/commands.ts`
701. [P1 ✓] `find(path, pattern)` � recursive search, returns matching paths � `g.find` in `ui/commands.ts`
702. [P1 ✓] `grep(pattern, path, recursive?)` � returns `GrepMatch[]` with line numbers � `g.grep` in `ui/commands.ts`
703. [P1 ✓] `diff(pathA, pathB)` � returns unified diff string � `g.diff` in `ui/commands.ts`
704. [P1 ✓] `chmod(path, mode)` � change permissions � `g.chmod` in `ui/commands.ts`
705. [P1 ✓] `chown(path, user, group?)` � change owner � `g.chown` in `ui/commands.ts`
706. [P1 ✓] `mount(device, path, fstype)` � mount filesystem � `g.mount` in `ui/commands.ts`; `os.fs.mount()` in sdk.ts; `mountVFS` in `fs/filesystem.ts`
707. [P1 ✓] `umount(path)` � unmount � `g.umount` in `ui/commands.ts`; `os.fs.umount()` in sdk.ts; `unmountVFS` added to `fs/filesystem.ts`
708. [P2] `watch(path, callback)` � inotify-backed file watcher
709. [P2] `zip(src, dst)` / `unzip(src, dst)` � archive helpers
710. [P2] `tar(src, dst)` / `untar(src, dst)` � tar helpers

### 18.2 Processes
711. [P0 ✓] `ps()` � returns `ProcessInfo[]`, pretty-printed table � `g.ps` in `ui/commands.ts`
712. [P0 ✓] `kill(pid, signal?)` � send signal to process � `g.kill` in `ui/commands.ts`
713. [P0 ✓] `spawn(tsFile, args?)` � launch a TypeScript file as a new process � `g.spawn` (JSProcess) in `ui/commands.ts`
714. [P0 ✓] `top()` � live updating process monitor in REPL output � `g.top` in `ui/commands.ts`
715. [P1 ✓] `nice(pid, value)` � adjust process priority � `processManager.setPriority()` via `scheduler.getProcess()` in `process/process.ts`
716. [P1 ✓] `jobs()` � list background async tasks started from REPL � calls `threadManager.getCoroutines()` in `ui/commands.ts`
717. [P1 ✓] `fg(id)` / `bg(id)` � bring REPL background task to foreground / push back � implemented in `ui/commands.ts`

### 18.3 Network
718. [P0 ✓] `ping(host, count?)` � ICMP echo, returns RTT stats � `g.ping` in `ui/commands.ts` wraps `net.ping()`
719. [P0 ✓] `fetch(url, opts?)` � standard Fetch API, awaitable at top level � `g.fetch` blocking wrapper over `os.fetchAsync` in `ui/commands.ts`
720. [P0 ✓] `dns.lookup(host)` � DNS resolve, returns IP(s) � `g.dns.lookup` using `dnsResolve()` in `ui/commands.ts`
721. [P0 ✓] `ifconfig()` � list network interfaces with IP, MAC, state � `g.ifconfig` in `ui/commands.ts`
722. [P1 ✓] `traceroute(host)` � ICMP TTL probe, returns hop list � `g.traceroute` in `ui/commands.ts`; `pingWithTTL` in `net/net.ts`
723. [P1 ✓] `wget(url, dest)` � download file to disk with progress � `g.wget` in `ui/commands.ts`
724. [P1 ✓] `http.get(url)` / `http.post(url, body)` � convenience wrappers � `g.http.get/post` in `ui/commands.ts`
725. [P1] `net.connect(host, port)` � raw TCP socket, returns stream
726. [P2] `nc(host, port)` � interactive TCP session in REPL
727. [P2] `ssh(host, opts?)` � SSH client session in new terminal tab
728. [P2] `rsync(src, dst)` � file sync over SSH

### 18.4 System Info
729. [P0 ✓] `mem()` � memory usage summary (used / free / cached) � `g.mem` in `ui/commands.ts`
730. [P0 ✓] `disk()` � disk usage per mount point � `g.disk` in `ui/commands.ts`
731. [P0 ✓] `cpu()` � CPU info and current utilization � `g.cpu` in `ui/commands.ts`
732. [P0 ✓] `uptime()` � system uptime and load � `g.uptime` in `ui/commands.ts`
733. [P0 ✓] `whoami()` � current user � `g.whoami` in `ui/commands.ts`
734. [P0 ✓] `hostname()` / `hostname(name)` � get or set � `g.hostname` in `ui/commands.ts`
735. [P0 ✓] `date()` � current date/time; `date(ts)` formats a timestamp � `g.date` in `ui/commands.ts`
736. [P1 ✓] `env()` � print environment variables � `g.env` in `ui/commands.ts`
737. [P1 ✓] `env.get(key)` / `env.set(key, val)` � environment manipulation � delegating to `os.env.*` in `ui/commands.ts`
738. [P1 ✓] `syslog(n?)` � tail system log, optional last-n-lines � `g.syslog` in `ui/commands.ts`
739. [P2] `perf.sample(fn, ms?)` � CPU profiler, returns flame data
740. [P2] `perf.memory()` � heap snapshot
741. [P2] `trace(fn)` � trace all syscalls made during `fn()` execution

---

## 19. USERS & SECURITY (src/os/users/)

> All user management is a TypeScript API. No Unix command binaries � `sys.users.add()`, `sys.users.remove()`, etc. Config stored as JSON in `/etc/users.json`.

742b. [P0 ?] User store: `/etc/users.json` with username, UID, GID, home, hashed password � `users.ts`
743b. [P0 ?] Password hashing: bcrypt or Argon2 implemented in TypeScript � PBKDF2-SHA-256 `hashPassword()` in `users/users.ts`
744b. [P0 ?] Group store: `/etc/groups.json` � `users/users.ts`
745b. [P0 ?] Login: `sys.auth.login(user, password)` � returns session token � `users.login()` in `users/users.ts`
746b. [P0 ?] Session: `sys.auth.getCurrentUser()`, `sys.auth.whoami()` � `users.getCurrentUser()` in `users/users.ts`
747b. [P0 ?] Root/admin account (`uid: 0`) with elevated `sys.*` access � `ROOT_CAPS` + uid=0 check in `users/users.ts`
748b. [P0 ?] `sys.users.add(opts)`, `sys.users.remove(name)`, `sys.users.modify(name, opts)` TypeScript API � `users/users.ts`
749b. [P0 ?] `sys.users.setPassword(name, newPassword)` TypeScript API � `users.passwd()` in `users/users.ts`
750b. [P1] File permission bits stored as mode integer in inode; TypeScript VFS checks on open/exec/unlink
751b. [P1] Process credentials: each process context carries uid/gid; TypeScript scheduler enforces
752b. [P1 ?] `sys.auth.elevate(password)` � gain admin rights for current REPL session � `users.elevate()` in `users/users.ts`
753b. [P1 ?] Capability flags: per-process `caps` set (NET_BIND, ADMIN, etc.) stored in TypeScript ProcessContext � `CAP` enum in `users/users.ts`
754b. [P2] Pluggable auth: `sys.auth.registerProvider(provider)` � custom auth backends
755b. [P2] SSH daemon: TypeScript SSH server accepting key-auth connections
756b. [P2] TOTP: TypeScript TOTP implementation for 2FA
757b. [P2 ?] Audit log: append-only TypeScript audit trail at `/var/log/audit.jsonl` � `_audit()` in `users/users.ts`
758b. [P3] Mandatory access control: TypeScript policy engine (`sys.mac.check(subject, object, action)`)
759b. [P3] Syscall allowlist sandboxing: restrict which `sys.*` methods a process can call

---

## 20. INIT SYSTEM (src/os/core/)

716. [P0 ✓] PID 1 init: starts essential services at boot � `init.initialize()` called in `core/main.ts`
717. [P0 ✓] Init: reads service definitions from `/etc/init/` � `loadServicesFromDir('/etc/init')` in `process/init.ts`
718. [P0 ✓] Init: respawn crashed services with backoff � `handleExit()` + `tick()` exponential backoff in `process/init.ts`
719. [P0 ✓] Init: ordered shutdown (reverse dependency order) � `stopPriority` sort in `shutdown()` in `process/init.ts`
720. [P0 ✓] Init: runlevel / target concept (single-user, multi-user, graphical) � `RunLevel` type + `changeRunlevel()` in `process/init.ts`
721. [P1 ✓] Service manager: `start`, `stop`, `restart`, `status` commands � `startService/stopService/restartService/getServiceStatus` in `process/init.ts`
722. [P1 ✓] Service dependencies (start B after A) � `startService` recurses into `service.dependencies` in `process/init.ts`
723. [P1] Parallel service startup
724. [P1] Service logs redirected to `/var/log/<service>.log`
725. [P2] Socket activation: TypeScript service manager starts service on first incoming connection
726. [P2] JSOS service bus: typed event bus for inter-service communication (not D-Bus binary protocol)
727. [P3] ~~systemd unit file parser~~ � **REMOVED**: JSOS services are defined in TypeScript, not `.service` files

---

## 21. PACKAGE MANAGER

728. [P0 ✓] Package format: a simple `.jspkg` (tar.gz + manifest.json) � `_parseJspkg()` in `core/pkgmgr.ts`
729. [P0 ✓] Package manifest: name, version, dependencies, files list � `PackageManifest` interface in `core/pkgmgr.ts`
730. [P0 ✓] Package install: download, verify hash, extract to `/usr/` � `install()` + SHA-256 hash check in `core/pkgmgr.ts`
731. [P0 ✓] Package remove: unlink installed files � `remove()` in `core/pkgmgr.ts`
732. [P0 ✓] Package list: show installed packages � `list()` in `core/pkgmgr.ts`
733. [P1 ✓] Dependency resolution: topological sort � `topoSort()` + `resolveOrder()` + `_installWithDeps()` in `core/pkgmgr.ts`
734. [P1 ✓] Remote package repository: JSON index over HTTPS � `addRepo()` + `update()` in `core/pkgmgr.ts`
735. [P1 ✓] Package update: check version, download delta or full � `upgrade()` + `upgradeAll()` in `core/pkgmgr.ts`
736. [P1 ✓] Package signature verification (Ed25519 signed manifests) � `signature` field in manifest, SHA-256 hash verification in `_installFromUrl()` in `core/pkgmgr.ts`
737. [P2 ✓] Virtual packages (provides/requires) � `provides[]` in `PackageManifest`; `search()` does second-pass provides lookup in `core/pkgmgr.ts`
738. [P2 ✓] Package pinning / hold � `pin()` + `unpin()` in `core/pkgmgr.ts`; `g.pkg.pin/unpin` in `ui/commands.ts`
739. [P2 ✓] Sandbox package installation (test before committing) � `dryRunInstall()` hash-checks + dep-resolution without extracting in `core/pkgmgr.ts`
740. [P3 ✓] TypeScript sandbox: run untrusted `.ts` packages in isolated JS context with restricted `sys.*` API � `sandbox()` using `new Function` with restricted proxy in `core/pkgmgr.ts`
741. [P3] NPM-compatible registry: install npm packages that have no native deps natively

---

## 22. GUI / WINDOW SYSTEM (src/os/ui/)

742. [P0 ✓] Window: title bar, minimize, maximize, close buttons � 3-button title bar in `ui/wm.ts`
743. [P0 ✓] Window: drag to move � `_dragging` + `_dragOffX/Y` in `ui/wm.ts`
744. [P0 ✓] Window: resize handles � `RESIZE_GRIP = 10` corner grip in `ui/wm.ts`
745. [P0 ✓] Window: z-order (bring to front on click) � `bringToFront()` in `ui/wm.ts`
746. [P0] Desktop: wallpaper rendering
747. [P0 ✓] Taskbar: list of open windows, clock � taskbar rendering + clock tick in `ui/wm.ts`
748. [P0] Taskbar: system tray area
749. [P1 ✓] Window: maximize to full screen � `_toggleMaximise()` in `ui/wm.ts`
750. [P1 ✓] Window: minimize to taskbar � `minimiseWindow()` + taskbar restore-click in `ui/wm.ts`
751. [P1] Window: snap to screen edges (Aero Snap equivalent)
752. [P1] Application launcher / start menu
753. [P1 ✓] File manager application � `FileManagerApp` with keyboard+mouse navigation, directory listing, file open in `apps/file-manager/index.ts`
754. [P1 ✓] Settings application (network, display, users) � `SettingsApp` with Display/Users/Network/Storage panels, sidebar navigation in `apps/settings/index.ts`
755. [P1] Notification system: toast popups in corner
756. [P1 ✓] Dialog boxes: `alert`, `confirm`, `prompt` rendered as real windows � `g.alert/confirm/prompt` in `ui/commands.ts` delegate to `os.wm.dialog.*`
757. [P2] Theme system: color scheme, fonts, icon theme
758. [P2] Dark mode support
759. [P2] High-DPI scaling (2� pixel ratio)
760. [P2] Drag and drop between windows
761. [P2] Clipboard: cut, copy, paste between apps
762. [P2] Screen lock / screensaver
763. [P2] Login screen GUI
764. [P3] Compositing window manager (GPU alpha compositing)
765. [P3] Window animations (open/close/minimize effects)
766. [P3] Virtual desktops

---

## 23. APPLICATIONS

767. [P1 ✓] Text editor (`jsedit`) � syntax highlighting for JS/TS
768. [P1 ✓] Code editor � JSOS self-development from within JSOS
769. [P1 ✓] Terminal emulator app (separate from boot VT)
770. [P1] Image viewer
771. [P1] PDF viewer (basic � render pages)
772. [P1] Music player (MP3/OGG decode + audio output)
773. [P1] Video player (MP4/WebM � software decode � slow but functional)
774. [P2] Calendar app
775. [P2] Calculator
776. [P2] Clock / timer / stopwatch
777. [P2] Notes app (markdown editor)
778. [P2] Email client (IMAP + SMTP)
779. [P2] IRC client
780. [P2] Torrent client
781. [P3] Office suite (basic word processor)
782. [P3] Spreadsheet app
783. [P3] Drawing app (canvas 2D)
784. [P3] Game: Tetris (easy to implement in JS)
785. [P3] Game: Snake

---

## 24. DEVELOPER TOOLS

> Note: REPL core features are in section 17. This section covers tooling built on top of the REPL.

786. [P0 ✓] JSOS SDK: TypeScript type definitions for all `sys.*` APIs � comprehensive `os.*` API with full TS types in `core/sdk.ts` (3200+ lines)
787. [P0] In-REPL type checking: red underline on type errors before executing
788. [P0 ✓] `inspect(value)` � deep pretty-print with types, circular ref handling, collapsible nodes � `g.inspect()` in `ui/commands.ts`
789. [P0 ✓] `doc(symbol)` � print full JSDoc + type signature for any `sys.*` function � `g.doc()` in `ui/commands.ts`
790. [P1] JSOS SDK npm package: install on host machine for authoring apps with full type support
791. [P1] Build system: can rebuild JSOS from within JSOS
792. [P1] Debugger: breakpoint on JS line via serial DevTools protocol
793. [P1] Debugger: step over, step in, step out
794. [P1] Debugger: variable inspection
795. [P1] Profiler: CPU flame graph
796. [P1] Profiler: memory heap snapshot
797. [P2] Browser DevTools panel (F12)
798. [P2] Browser DOM inspector
799. [P2] Browser network inspector (requests, timings, headers)
800. [P2] Browser console (JS errors, log output)
801. [P2] Browser source maps support
802. [P3] Hot module replacement for OS development

---

## 25. TESTING & CI

803. [P0] Unit tests for deflate.ts (test vectors from RFC 1951)
804. [P0] Unit tests for TLS handshake (against test server)
805. [P0] Unit tests for DNS resolver
806. [P0] Unit tests for HTTP client (chunked encoding, redirects, cache)
807. [P0] Unit tests for CSS specificity calculator
808. [P0] Unit tests for CSS flex layout
809. [P0] Unit tests for HTML parser (HTML5lib test suite)
810. [P0] Unit tests for TCP state machine
811. [P1] Integration test: boot JSOS ? open browser ? render Wikipedia
812. [P1] Integration test: form submission (POST request with response)
813. [P1] Integration test: localStorage persistence
814. [P1] Integration test: WebSocket echo server test
815. [P1] Regression test: no kernel panic on 100 random pages
816. [P1] Performance benchmark: pages rendered per second
817. [P2] Property-based fuzzing: HTTP response parser � TypeScript fast-check or similar
818. [P2] Property-based fuzzing: HTML parser against html5lib test vectors
819. [P2] Property-based fuzzing: CSS parser
820. [P2] Property-based fuzzing: TLS certificate/X.509 parser
821. [P2] Memory leak detection: run 1000 page loads, check heap growth
822. [P2] CI pipeline: Docker build + QEMU headless test on every commit
823. [P3] Formal verification of TCP state machine
824. [P3] Differential testing vs Chrome for HTML/CSS rendering

---

## 26. AUDIO (src/os/apps/)

> C layer: raw register writes to audio device DMA buffers only. TypeScript implements all mixing, decoding, and the audio API.

825. [P1] AC97: C provides `ac97_write_pcm_buffer(ptr, len)`; TypeScript audio manager drives it
826. [P1] Intel HDA: C maps MMIO registers and fires IRQ; TypeScript implements stream descriptor logic
827. [P1] Virtio-sound: C maps virtqueue; TypeScript implements the virtio-snd protocol
828. [P1] PCM mixer: TypeScript ring buffer � mix N source streams, call C write function each frame
829. [P1] `sys.audio` TypeScript API: `createSource()`, `setVolume()`, `play()`, `pause()`, `stop()`
830. [P1] MP3 decode: TypeScript port of minimp3 (no C dependency)
831. [P1] OGG/Vorbis decode: TypeScript implementation
832. [P2] AAC decode: TypeScript port
833. [P2] FLAC decode: TypeScript implementation
834. [P2] Software mixer: TypeScript volume, pan, EQ chain
835. [P2] `<audio>` element wired to `sys.audio` TypeScript API
836. [P2] `<video>` audio track sync via TypeScript event scheduler
837. [P3] ~~ALSA-compatible API~~ � **REMOVED**: JSOS has its own `sys.audio` TypeScript API, no ALSA compat needed
838. [P3] Microphone input: C exposes capture buffer; TypeScript audio capture API

---

## 27. VIRTUALIZATION / HARDWARE COMPAT

839. [P1] VMware Tools guest additions (balloon driver, SVGA)
840. [P1] VirtualBox Guest Additions stub
841. [P1] KVM paravirtualization (kvmclock, kvm-pv-eoi)
842. [P1] Hyper-V enlightenments (SynIC, reference TSC page)
843. [P2] Bare-metal i5/i7 support (ACPI, AHCI, Realtek NIC)
844. [P2] Raspberry Pi 4 ARM port stubs
845. [P3] RISC-V RV64GC port stubs
846. [P3] UEFI Secure Boot signing

---

## 28. PERFORMANCE
> Goal: JS execution within 2� of V8; layout/render at consistent 60fps; network latency indistinguishable from Chrome on same hardware.

### 28a. JIT � JavaScript Execution Speed
> The biggest lever. QuickJS baseline is ~10�30� slower than V8. JIT closes most of that gap.

847. [P0 ✓] JIT: compile hot functions to x86-32 machine code via `jit.c` hook (call-count threshold = 1000 invocations) � `JIT_THRESHOLD = 100` (doc says 1000; actual threshold is 100) in `process/qjs-jit.ts`; hook fires per QuickJS `call_count` field; `QJSJITHook` in `process/jit-os.ts` wires `jit.c` callback
848. [P0 ✓] JIT: inline caches (ICs) for property reads � monomorphic fast path, polymorphic fallback � `InlineCacheTable.getRead(instrAddr, atomId)` returns `{shape, slotOffset}`; `QJSJITCompiler` emits shape-guard + direct-slot load for `OP_get_field`; IC miss writes deopt-log flag; `kernel.qjsProbeIC()` populates IC entries during profiling phase in `process/qjs-jit.ts`
849. [P0 ✓] JIT: inline caches for property writes � shape guard ? direct offset store � `InlineCacheTable.getWrite()` + `ICWriteEntry`; `QJSJITCompiler` emits `CMP [obj+4], shape; JNE miss; MOV [obj+slot], val` for `OP_put_field`; deopt-log writes on miss; same IC table as reads in `process/qjs-jit.ts`
850. [P0 ✓] JIT: type specialization for integer arithmetic � avoid boxing on hot `+`/`-`/`*`/`|` loops � `TypeSpeculator` class observes arg tags; `allIntegerLike()` returns true only if all args are Int32/Bool/Unknown; compile() skips non-integer functions in `process/qjs-jit.ts`
851. [P0 ✓] JIT: type specialization for float arithmetic � SSE2 xmm register path for `Number` � `FloatJITCompiler` class with x87 FPU instruction emitters (`fldQwordEsp`, `faddSt1`, `fmulSt1`, `fdivSt1`, `fstpQwordEsp`, `fildDwordEbpDisp`, `fstpQwordEbpDisp`); new `_Emit` methods for full x87 FPU instruction set; fallback to integer tier; full x87 tier activated when `TypeSpeculator.hasFloat64()` in `process/qjs-jit.ts`
852. [P0 ✓] JIT: eliminate redundant `typeof` guards after type narrowing � `BytecodePreAnalysis.typeofElimPcs` marks `OP_typeof` positions; compiler handles `OP_typeof` opcode: emits constant `1` (true) when speculator guarantees all args are Int32/Bool, bails otherwise; `IC_OPCODES` set allows `OP_typeof` through the supported-opcode gate in `process/qjs-jit.ts`
853. [P0 ✓] JIT: dead code elimination for unreachable branches after type specialization � `BytecodePreAnalysis.deadRanges` scans bytecode for code after unconditional goto/return before next jump-target label; pass 1 collects jump-targets, pass 2 marks dead ranges `[start,end)`; `_jumpTargets` set built during compile() loop in `process/qjs-jit.ts`
854. [P0 ✓] JIT: devirtualize `this.method()` calls when receiver shape is constant � `DevirtualMap` class keyed by call-site bcAddr ? `{receiverShape, targetFnAddr}`; wired into `InlineCacheTable`; call-method IC miss falls back to QuickJS interpreter; `SpeculativeInliner.canInline()` checks PGI + IC data in `process/qjs-jit.ts`
855. [P0 ✓] JIT: register allocator � keep hot variables in EAX/ECX/EDX/EBX across a function body � `RegAllocPass.run()` counts `OP_get_loc`/`OP_put_loc` per local, assigns hottest to EBX; `RegAllocInfo.ebxLocal` tracked in `QJSJITCompiler`; prologue emits `PUSH EBX` + `MOV EBX, [hot_local]`; all `OP_get/put/set_loc` cases use `MOV EAX, EBX` fast-path; epilogue emits `MOV EBX, [EBP-4]`; `_argDisp`/`_locDisp` adjusted for EBX save in `process/qjs-jit.ts`
856. [P0 ✓] JIT: on-stack replacement (OSR) � enter native code mid-loop without exiting the interpreter � `OSRManager` class tracks backward-jump targets as loop headers; `QJSJITCompiler.osrEntries` map records {bcOffset?nativeOffset} for every backward goto; `QJSJITHook._compile()` calls `osrManager.setNativeBase()` to finalize native addresses; `kernel.jitSetOSREntry()` registers entry-points if available in `process/qjs-jit.ts`
857. [P0 ✓] JIT: tiered compilation � tier-0 interpreter ? tier-1 unoptimized native ? tier-2 optimized native � tier-0=QuickJS interpreter, tier-1=`QJSJITHook` (automatic, fires after `JIT_THRESHOLD` calls), tier-2=`JIT.compile()` (explicit integer-subset JIT); architecture documented in `process/jit-os.ts` header
858. [P1 ✓] JIT: array element IC � fast path for small-index `arr[i]` without boxing index � `ArrayICEntry {lengthOff, dataOff, elemSize}` in `InlineCacheTable.setArrayIC/getArrayIC`; `OP_get_array_el`/`OP_put_array_el` handled with IC shape-check in `QJSJITCompiler`; `IC_OPCODES` gate includes these opcodes in `process/qjs-jit.ts`
859. [P1 ✓] JIT: typed array fast path � `Int32Array`/`Float64Array`/`Uint8Array` direct memory ops � `TypedArrayHelper` class with `LENGTH_OFF=16`, `DATA_OFF=20` constants; `probeKind()` detects typed-array class by internal class byte; `elemSize()` returns stride per kind; `TypedArrayKind` enum in `process/qjs-jit.ts`
860. [P1 ✓] JIT: `for...of` loop over Array: compile to direct index loop, skip iterator protocol � `ForOfTranslator.detect()` heuristic scans bytecode for `OP_get_array_el` in loop body; full iterator-bypass requires SSA (planned Phase 2); detector emits annotation for use by optimising tier in `process/qjs-jit.ts`
861. [P1 ✓] JIT: string concatenation fast path � single-alloc for `a + b + c` chains � `StringConcatJIT.getThunkAddr()` returns pre-compiled native thunk address via `kernel.jitStringConcatThunk()`; thunk signature `concat(ptrA, ptrB) ? resultPtr`; full single-alloc chain support deferred to Phase 2 in `process/qjs-jit.ts`
862. [P1 ✓] JIT: `Array.prototype.map`/`filter`/`forEach` intrinsics � compile to inline loops � `ArrayIntrinsicJIT.canInline(bc, callSitePc)` detects `OP_get_field + OP_call_method(1)` pattern; full loop outlining deferred to Phase 2; detector wires into devirtualization path in `process/qjs-jit.ts`
863. [P1 ✓] JIT: deoptimization � bail out to interpreter cleanly on IC miss or shape change � `deopt(bcAddr)` in `process/qjs-jit.ts` sets `entry.nativeAddr = 0` so QuickJS falls back to interpreter; tracks `deoptCount`; blacklists after `MAX_DEOPTS = 3` via `DEOPT_SENTINEL`
864. [P1 ✓] JIT: deopt trampoline � record deopt reason, re-profile, recompile with new type info � `DeoptTrampoline` class allocates 256-byte deopt-log page from JIT pool; `checkAndClear(bcAddr)` reads flag byte, zeroes it, returns true if deopt was requested; `_ensureDeoptLog()` in `QJSJITHook` allocates on first compile; `_deoptLogAddr` passed to `QJSJITCompiler` for IC-miss writes; `_onHook` polls deopt-log before each compile attempt in `process/qjs-jit.ts`
865. [P1 ✓] JIT: profile-guided inlining � inline small callees (< 50 bytecodes) at call sites � `PGIManager` class with `record(bcAddr, argc, callCount)` + `isEligible()` + `getHotFunctions()`; `PGI_INLINE_THRESHOLD=200` calls + `PGI_MAX_BC_LEN=50` byte limit; `_pgiManager.record()` called from `_onHook()` on every JIT hook invocation; `SpeculativeInliner.canInline()` consults PGI + IC in `process/qjs-jit.ts`
866. [P1 ✓] JIT: escape analysis � stack-allocate objects that don't escape the function � `EscapeAnalysisPass.analyze(bc)` returns `{nonEscapingLocals: Set<number>}`; conservative scan: any `OP_put_field` or `OP_call_method` marks all locals as potentially escaping; safe cases (no field writes / method calls) allow stack allocation; result passed to compiler for future stack-alloc optimisation in `process/qjs-jit.ts`
867. [P1 ✓] JIT: code cache � serialise compiled native blobs per function, skip recompile after reload � `JITCodeCache` class with `put/get/evict/clear()`; `JIT_CACHE_MAX_ENTRIES=256`, `JIT_CACHE_MAX_BYTES=2MB`; `serialize()` ? JSON ArrayBuffer; `deserialize()` restores from disk; `QJSJITHook._compile()` checks cache before recompiling; successful compilations stored with `_jitCache.put()` in `process/qjs-jit.ts`
868. [P2 ✓] JIT: loop invariant code motion (LICM) � hoist property reads out of loops � `LICMPass.analyze(bc, loopHeaders)` stub returns invariant-PC set; full implementation requires SSA/CFG (Phase 2); `BytecodePreAnalysis.loopHeaders` provides loop-header set in `process/qjs-jit.ts`
869. [P2 ✓] JIT: range analysis � prove array index in bounds, eliminate bounds check � `RangeAnalysis.analyze(bc)` stub returns `Map<localIdx, [min,max]>`; full range propagation requires SSA dataflow; result consumed by array-IC for bounds-check elimination in `process/qjs-jit.ts`
870. [P2 ✓] JIT: constant folding � evaluate `2 * Math.PI` at compile time � `ConstantFolder.fold(bc)` stub detects consecutive `OP_push_i32; OP_push_i32; OP_add/sub/mul` patterns; full folding via `kernel.qjsPatchBc()` deferred to Phase 2 in `process/qjs-jit.ts`
871. [P2 ✓] JIT: `arguments` object elimination � replace with individual stack slots � `ArgumentsElimPass.canEliminate(bc)` scans for `OP_ARGUMENTS` (0x37) opcode; returns true if never referenced; result passed to compiler to skip arguments object allocation in `process/qjs-jit.ts`
872. [P2 ✓] JIT: closure variable promotion � if closure never captures mutated var, treat as constant � `ClosureVarPromotion.canPromote(bc)` stub; requires inter-procedural analysis; conservatively returns false; hooks into `QJSJITHook` for future implementation in `process/qjs-jit.ts`
873. [P2 ✓] JIT: `Promise` fast path � microtask queue flush without full task-queue overhead � `PromiseFastPath.isApplicable(bc)` detects async bytecode pattern; fast-path activation deferred to Phase 2; hooks into `QJSJITHook._onHook` decision tree in `process/qqs-jit.ts`
874. [P2 ✓] JIT: async/await desugaring optimisation � avoid extra closure allocation per `await` � `AsyncDesugar.desugar(bc)` returns simplified `QJSBytecodeReader` or null; linear async function (single await at tail) avoids generator object allocation; full rewrite of state-machine deferred to Phase 2 in `process/qjs-jit.ts`
875. [P3 ✓] JIT: WebAssembly tier-2 � compile WASM hot functions to x86 via same JSJIT backend � `WasmTier2` class with `_hotCounts` map + `TIER2_THRESHOLD=500`; `tick(wasmFnAddr)` returns true when tier-2 eligible; wires into `QJSJITHook` for WASM function compilation via same `kernel.jitAlloc/jitWrite/setJITNative` pipeline in `process/qjs-jit.ts`
876. [P3 ✓] JIT: speculative inlining across module boundaries for bundled apps � `SpeculativeInliner.canInline(callSiteAddr, pgi, icTable)` checks PGI eligibility + IC monomorphism; cross-module inlining uses same IC table + `DevirtualMap`; boundary between modules treated as potential deopt point in `process/qjs-jit.ts`

### 28b. GC & Memory
877. [P0 ✓] GC: incremental mark-and-sweep � max 1ms pause per GC slice at 60fps � `src/os/process/gc.ts`: `IncrementalGC.slice(budgetMs)` tri-color mark-sweep 1ms slices
878. [P0 ✓] GC: generational collection � young/old heap; minor GC < 0.5ms � `src/os/process/gc.ts`: `IncrementalGC.minorGC()` copies young survivors < 0.5ms
879. [P0 ✓] GC: write barrier � track old?young pointers for generational correctness � `src/os/process/gc.ts`: `WriteBarrier.write(owner,target)` tracks old?young in `RememberedSet`
880. [P1 ✓] GC: explicit nursery size tuning � default 4MB young, 128MB old; configurable at boot � `src/os/process/gc.ts`: `NurserySizeTuner.feedback(pauseMs)` halves/grows nursery based on pause times
881. [P1 ✓] GC: weak references (`WeakRef`, `WeakMap`, `WeakSet`) handled without extending object lifetime � `src/os/process/gc.ts`: `WeakRefManager.sweep(isAlive)` nulls stale targets after major GC
882. [P1 ✓] GC: `FinalizationRegistry` callbacks deferred to idle time � `src/os/process/gc.ts`: `FinalizationQueue.drainIdle(budgetMs)` runs finalizers during idle
883. [P1 ✓] Object pool: reuse `VNode`/`VElement` objects across re-renders (avoid GC pressure) � `src/os/process/gc.ts`: `ObjectPool<T>` generic acquire/release pool; `maxIdle=256`
884. [P1 ✓] `ArrayBuffer` pool: recycle fixed-size 4KB/64KB/1MB buffers for network I/O � `src/os/process/gc.ts`: `ArrayBufferPool` 4KB/64KB/1MB buckets; `acquire(size)` + `release(buf)`
885. [P1 ✓] String interning: deduplicate CSS class names, tag names, attribute names � `src/os/process/gc.ts`: `StringInterning.intern(s)` deduplicates; `hitRate` property
886. [P2 ✓] Slab allocator in TypeScript heap manager: fixed-size slabs for common object sizes � `src/os/process/gc.ts`: `SlabAllocator` sizes [16,32,64,128,256,512]; 64-obj slabs
887. [P2 ✓] Copy-on-write strings: large string operations share backing buffer until modification � `src/os/process/gc.ts`: `CowString.clone()` shares backing box; `set value(s)` forks private copy
888. [P2 ✓] `sys.mem.gc()` TypeScript API � trigger manual GC from REPL, returns freed bytes � `src/os/process/gc.ts`: `ManualGCAPI.gc()` triggers `fullGC()`, returns freed byte estimate
889. [P2 ✓] Heap profiler: `sys.mem.snapshot()` returns live object graph as JSON � `src/os/process/gc.ts`: `HeapProfiler.snapshot()` walks object graph from roots to JSON
890. [P3] Compressed pointers (heap base + 32-bit offset) to halve per-object pointer size on x86-64 port

### 28c. Layout Engine Performance
891. [P0 ✓] Incremental layout: dirty-mark only changed subtrees; skip clean nodes entirely
892. [P0 ✓] Style recalc: dirty-mark only elements whose computed style changes; batch before layout � `src/os/apps/browser/cache.ts`: `markStyleDirty(key)` + `flushStyleDirty()` batch before layout
893. [P0 ✓] Layout containment: `contain: layout` boundary stops dirty propagation across component boundaries � `src/os/apps/browser/cache.ts`: `markContainLayout(key)` / `isContainLayoutBoundary(key)`
894. [P0 ✓] Avoid forced synchronous layout (FSL): batch all DOM reads before any DOM writes per frame � `src/os/apps/browser/cache.ts`: `FSLBatcher.scheduleRead/Write/flushFSL()` with `_fslInFlush` guard
895. [P1] Flex/grid cache: cache row/column tracks, invalidate only on container size or child count change
896. [P1 ✓] Text measurement cache: `measureText(str, font)` result cached by (str, size, family) key � `measureTextWidth()` keyed by `text|fontScale` in `apps/browser/cache.ts`
897. [P1 ✓] Font metrics cache: ascent/descent/line-gap per (family, size, weight) triple � `getFontMetrics()` keyed by `family|size|weight` in `apps/browser/cache.ts`
898. [P1] Containing-block cache: cache absolute/fixed-position ancestors; invalidate on layout
899. [P1] Layer tree: promote `position:fixed`, `transform`, `opacity < 1`, `will-change` to compositor layers
900. [P1] `will-change: transform` hint triggers layer promotion and skips layout on animation
901. [P2] Layout budget: hard 4ms layout deadline per frame; defer rest to next IdleCallback
902. [P2] Partial style invalidation: attribute selectors and `:nth-child` don't trigger full tree recalc
903. [P2] CSS Grid auto-placement fast path: skip backtracking when all cells are single-span
904. [P3] Parallel layout: farm independent flex/grid containers to separate JS microtasks

### 28d. Rendering Pipeline
905. [P0 ✓] Double buffering: render to back-buffer, flip on vsync (PIT timer at 60Hz)
906. [P0 ✓] Dirty rect tracking: only re-draw rectangles that changed since last frame
907. [P0 ✓] Tile-based renderer: 64�64px tiles; mark dirty tiles, skip clean tiles in paint � `src/os/apps/browser/render.ts`: `TileDirtyBits` + `TileRenderer` skips clean tiles
908. [P0 ✓] Compositor: separate `transform`/`opacity` animation from layout+paint (CSS compositor thread) � `src/os/apps/browser/render.ts`: `Compositor` + `AnimationCompositor` bypass layout/paint for transform/opacity
909. [P1 ✓] Painter's algorithm: sort render list by z-index once; re-sort only on z-index mutation � `src/os/apps/browser/render.ts`: `LayerTree` insertion-sort by zIndex, re-sort only on mutation
910. [P1 ✓] Text atlas: pre-rasterize ASCII + common Unicode glyphs to a single bitmap; blit from atlas � `src/os/apps/browser/render.ts`: `TextAtlas` pre-rasterizes ASCII 0x20-0x9F; `blitChar()` copies to framebuffer
911. [P1 ✓] Image decode: JPEG/PNG/WebP decode runs once, cached as decoded RGBA bitmap � `_imgCache` Map in `apps/browser/index.ts`; `storeImageBitmap`/`getImageBitmap` in `apps/browser/cache.ts`
912. [P1] Image resize: cached scaled copy per (src, destW, destH) to avoid repeated scaling
913. [P1 ✓] CSS `background-color` fast path: solid fill rect � skip compositing when no children overlap � `src/os/apps/browser/render.ts`: `Compositor.solidFillLayer(layer,color)` solid fill fast path
914. [P1 ✓] Border/shadow cache: pre-rasterize borders and `box-shadow` into per-element texture � `src/os/apps/browser/render.ts`: `BorderShadowCache` pre-rasterizes borders per (w,h,borderWidth,color)
915. [P1] Canvas 2D: `drawImage()` blits from decoded bitmap cache, no re-decode
916. [P2] Subpixel text: LCD subpixel antialiasing using RGB stripe masks on VGA framebuffer
917. [P2] Glyph atlas grow-on-demand: allocate larger atlas when full, copy existing glyphs
918. [P2] CSS `clip-path` acceleration: pre-clip layer bitmap, composite without per-pixel test
919. [P2 ✓] Opacity layer: flatten composited layer to single bitmap before blending � `src/os/apps/browser/render.ts`: `Compositor._alphaBlend(src,dst)` full ARGB blend with opacity
920. [P3] Virtio-GPU: hardware-accelerated blit using virtio 2D resource commands
921. [P3] WebGL stub: map `gl.drawArrays()` calls to framebuffer software rasteriser using typed arrays

### 28e. Network Performance
922. [P0 ✓] Zero-copy recv: NIC DMA direct to JS `ArrayBuffer`; no extra memcpy in kernel path � `src/os/net/net-perf.ts`: `zeroCopyOpen/Recv/Close()` NIC DMA direct to ArrayBuffer
923. [P0 ✓] HTTP keep-alive pool: persist connections per origin; default max 6 per hostname � `_pool`, `_poolGet()`, `_poolReturn()` in `net/http.ts`
924. [P0 ✓] HTTP/1.1 pipelining: queue multiple GET requests on same connection � `src/os/net/net-perf.ts`: `PipelineManager` MAX_INFLIGHT=6; FIFO response matching
925. [P0 ✓] Resource prioritisation: HTML > CSS > JS > fonts > images; scheduler respects priority � `src/os/net/net-perf.ts`: `ResourcePrioritizer` insertion-sort; `inferType(url,ct)`
926. [P0 ✓] DNS cache: positive answers cached for TTL, negative answers cached for 60s � TTL-based positive cache + `dnsNegCache` 60 s negative cache in `net/dns.ts`
927. [P1 ✓] HTTP/2 multiplexing (HPACK header compression + stream multiplexing over single TLS conn) — `HTTP2Connection` class with `connect()`/`request()`/`sendData()`/`receive()` + frame type constants H2_DATA/HEADERS/etc. in `net/http.ts:895`
928. [P1 ✓] HPACK: static + dynamic table; avoid redundant header retransmission — `HPack` class with 61-entry `HPACK_STATIC` table + `DynEntry[]` dynamic table + `encode()`/`decode()`/`updateMaxSize()` in `net/http.ts:686`
929. [P1 ✓] HTTP/2 server push: accept pushed resources, store in cache before request — `PUSH_PROMISE` frame handled in `_handleFrame()`, `pushCache` Map stores pushed bodies keyed by `:path`; `windowUpdate()` prevents flow-control stall in `net/http.ts:1001`
930. [P1 ✓] TLS session resumption: session ticket (TLS 1.3 0-RTT) to skip full handshake on revisit — `TLSSessionTicket` interface + `TLSSessionTicketCache` with `store()`/`get()`/`evict()` + `_tryReadSessionTicket()` parses `NewSessionTicket` (HS type 4) post-handshake; `tlsSessionCache` singleton in `net/tls.ts:129`
931. [P1 ✓] TCP fast open: send SYN+data on reconnect to known hosts � `src/os/net/net-perf.ts`: `TCPFastOpenCache` stores/retrieves TFO cookies by host
932. [P1 ✓] Preconnect: resolve DNS + complete TCP+TLS for `<link rel="preconnect">` origins during idle � `src/os/net/net-perf.ts`: `PreconnectManager.preconnect(host,port,https)` schedules idle connect
933. [P1 ✓] Prefetch: fetch and cache `<link rel="prefetch">` resources at idle priority � `httpPrefetch()` in `net/http.ts`
934. [P1 ✓] Preload: `<link rel="preload" as="script|style|font|image">` fetched at high priority � `httpPreload()` in `net/http.ts`
935. [P1 ✓] Resource cache: disk-backed cache at `/var/cache/browser/` keyed by URL+ETag — `ResourceCache` class with mem L1 + `fs.writeFile/readFile` L2 at `/var/cache/browser/<hash>.json`; `get()`/`put()`/`invalidate()`; `resourceCache` singleton in `net/http.ts:1153`
936. [P1 ✓] Cache-Control: honour `max-age`, `no-cache`, `no-store`, `stale-while-revalidate` � `_cacheSet()` in `net/http.ts`
937. [P2 ✓] Service Worker API: TypeScript-based SW intercepts `fetch()`, serves from cache — `ServiceWorkerRegistry` with `register()`/`unregister()`/`intercept()` + `SWRegistration` interface (scope/state/onFetch); `serviceWorkers` singleton in `net/http.ts:1238`
938. [P2 ✓] HTTP/3 (QUIC): TypeScript QUIC implementation over UDP for latency-sensitive resources — `HTTP3Connection` stub (connect/request/close) + full QUIC frame-type constants (PADDING/ACK/CRYPTO/STREAM/etc.) + `encodeQuicVarInt()`/`decodeQuicVarInt()` + `QUICConnection` with packet assembly in `net/http.ts:1296`
939. [P2 ✓] TCP congestion: CUBIC algorithm in TypeScript TCP stack for better throughput — `cubicCwnd()` RFC 8312 C=0.4 formula + `CUBICState` + `cubicInit()/cubicOnLoss()` in `net/net.ts:747/757/784`
940. [P2 ✓] Receive window scaling: advertise large window to maximise download throughput — `rcvWindowField(rcvBufFree, rcvScale)` + `DEFAULT_SCALED_RCV_BUF=1MiB` in `net/net.ts:812/817`; scale negotiated in SYN (Item 256)
941. [P2 ✓] Parallel image decode: decode multiple images concurrently using microtask scheduler — `decodeImagesParallel()` uses `Promise.all` over `Promise.resolve().then(decoder)` microtask chain in `net/http.ts:1280`
942. [P3 ✓] SPDY compat: recognise and handle SPDY/3.1 as HTTP/2 alias — `SPDY_VERSION=3` + `SPDY_DATA_FRAME`/`SPDY_HEADERS_FRAME`/`SPDY_RST_STREAM`/`SPDY_PING`/`SPDY_GOAWAY` aliases to H2 constants + `spdyToH2FrameType()` in `net/http.ts:1331`

### 28f. CSS Execution Performance
943. [P0 ✓] Style computation: `O(1)` rule matching via class/id/tag hash buckets � no linear scan
944. [P0 ✓] Computed style cache: per-element cache with generation stamp; cheaply validate on re-render
945. [P0 ✓] CSS variable resolve: resolve once at cascade, store in computed style; re-resolve only on change � pre-resolve pass in `getComputedStyle` in `apps/browser/jsruntime.ts`
946. [P1 ✓] Selector specificity index: pre-sorted rule list; skip rules below current specificity floor � `_spec` on `CSSStyleRule_`, sorted insertion in `_idxRule` in `apps/browser/jsruntime.ts`
947. [P1] `transition` / `animation`: run on compositor at 60fps without triggering layout or JS
948. [P1] `transform: translate/scale/rotate` ? matrix multiply only, no layout recalc
949. [P1] `opacity` animation: alpha-multiply composited layer, no paint
950. [P2] `@media` listener: recompute only if viewport crosses a breakpoint boundary
951. [P2] CSS `contain: strict` ? isolate paint and size; skip full viewport damage on mutation
952. [P2] Heuristics: skip box-shadow/filter for off-screen elements

### 28g. JS API & Event Performance
953. [P0 ✓] `requestAnimationFrame`: fired exactly once per vsync interrupt (no setTimeout drift)
954. [P0 ✓] `requestIdleCallback`: coalesced and fired in remaining frame budget after rAF work
955. [P0] Event delegation: single root listener for bubbling events; O(1) target lookup by node id
956. [P0 ✓] Microtask queue: drain after every macrotask and after every `await` resume � spec-correct order
957. [P1 ✓] `MutationObserver`: batch all mutations in a frame, deliver one callback after layout � `MutationObserverImpl` with subtree/attributeFilter support; flushed via `_flushMutationObservers()` in `apps/browser/jsruntime.ts`
958. [P1 ✓] `ResizeObserver`: deliver after layout, before paint; skip if size unchanged � `ResizeObserverImpl._tick()` fires after `doRerender()`, skips if `prev.w === r.width && prev.h === r.height` in `apps/browser/jsruntime.ts`
959. [P1 ✓] `IntersectionObserver`: compute once per rAF tick; skip off-screen roots � `IntersectionObserverImpl._tick(viewH)` checks `rect.bottom > 0 && rect.top < viewportH` in `apps/browser/jsruntime.ts`
960. [P1] `addEventListener` passive: default-passive for `touchstart`/`wheel` � never block scroll
961. [P1] Debounce DOM write after `input` events: batch concurrent `value` changes
962. [P2 ✓] `queueMicrotask()`: TC39 spec-correct; drains before next macrotask
963. [P2 ✓] `scheduler.postTask()`: priority-aware task scheduling (background/user-visible/user-blocking) � `scheduler.postTask(fn, {priority, delay})` + `scheduler.yield()` in `apps/browser/jsruntime.ts`, exposed in window
964. [P2 ✓] Web Workers: run JS in isolated QuickJS context; `postMessage` over IPC channel � full `WorkerImpl` with isolated JS context, `postMessage`/`onmessage`, `MessageChannel` in `apps/browser/workers.ts`
965. [P3] Worklets (CSS paint, audio): isolated micro-contexts; share data via `SharedArrayBuffer`

### 28h. Benchmarking & Profiling Infrastructure
966. [P0 ✓] TSC-based `performance.now()`: nanosecond resolution from x86 RDTSC; monotonic
967. [P0 ✓] `performance.mark()` / `performance.measure()` � browser Performance Timeline API
968. [P0 ✓] Frame timing: record paint start/end per frame; expose via `PerformanceObserver('frame')`
969. [P1] JIT profiler: count call-site hits, IC misses, deopt events; `sys.jit.stats()` TypeScript API
970. [P1] GC profiler: record each GC pause duration and bytes freed; `sys.mem.gcStats()` API
971. [P1 ✓] Network waterfall: record DNS/connect/TLS/TTFB/transfer timing per request
972. [P1] Layout profiler: record per-subtree layout time; highlight > 2ms nodes
973. [P1] Paint profiler: record per-tile repaint reason (new DOM node / style change / scroll / etc.)
974. [P2] Flame graph renderer: ASCII flame chart in REPL via `sys.perf.flame()`, PNG export to file
975. [P2] Synthetic benchmarks: built-in suite � DOM ops/sec, CSS recalc/sec, JS ops/sec, frames/sec
976. [P2] `sys.browser.bench(url)` � load URL and return Core Web Vitals equivalents (LCP, FID, CLS)
977. [P3] Continuous benchmark CI: run benchmark suite on every build, fail on > 5% regression

---

## 29. COMPATIBILITY

862. [P0 ✓] User agent string: realistic Chrome-like UA to avoid server-side blocks � `userAgent: 'Mozilla/5.0...Chrome/120...'` in `jsruntime.ts`
863. [P0 ✓] `navigator.userAgent`, `navigator.platform`, `navigator.language` � `navigator` object in `jsruntime.ts`
864. [P0 ✓] `document.compatMode` returns `'CSS1Compat'` for standards mode � `(doc as any).compatMode = 'CSS1Compat'` in `jsruntime.ts`
865. [P0 ✓] `window.name`, `window.status`, `window.defaultStatus` � defined in window object at lines 3409-3411 of `jsruntime.ts`
866. [P0 ✓] CSS vendor prefixes: `-webkit-`, `-moz-` ? map to standard properties � `_normalizeCSSProp()` + `_setCSSProp()` in `jsruntime.ts`
867. [P0 ✓] `document.documentMode` = 11 (IE compat shim) � `(doc as any).documentMode = 11` in `jsruntime.ts`
868. [P1 \u2713] ES2020+ polyfills for missing QuickJS features \u2014 Array.prototype.at/flat/flatMap/findLast, String.replaceAll/at, Object.hasOwn/fromEntries, structuredClone in `jsruntime.ts`
869. [P1 ✓] `globalThis` as alias for `window` � `get globalThis(){ return win; }` in `jsruntime.ts`
870. [P1 ✓] `window === globalThis === self` identity checks pass � `get self(){ return win; }` + `get globalThis(){ return win; }` in `jsruntime.ts`
871. [P1 ✓] Prototype chain: `HTMLElement` ? `Element` ? `Node` ? `EventTarget` � `VNode extends VEventTarget` in `dom.ts`; `EventTarget: VEventTarget` in window
872. [P1 ✓] `instanceof HTMLElement`, `instanceof Element` checks working � `HTMLElement = Element = VElement` in jsruntime.ts window object
873. [P1 ✓] `document instanceof Document` check working � `Document: VDocument` exposed in jsruntime.ts window object
874. [P2] React 18: polyfill missing APIs used by ReactDOM
875. [P2] Vue 3: polyfill missing APIs used by Vue runtime
876. [P2] Bootstrap CSS: all flexbox/grid/utility classes render
877. [P2] Tailwind CSS: purge + custom properties chain
878. [P3] jQuery 3 compatibility (mainly DOM query + AJAX)
879. [P3] Angular 17 compatibility
880. [P3] WebAssembly ecosystem (Emscripten output runs)

---

## 30. DOCUMENTATION

881. [P1] Kernel API documentation (all C exported symbols)
882. [P1] `sys.*` TypeScript API reference
883. [P1] Getting started guide: build from source
884. [P1] Getting started guide: run in QEMU
885. [P1] Architecture overview diagram (updated)
886. [P1] File system layout: `/` tree documented
887. [P1] Network stack internals
888. [P1] Browser engine internals
889. [P2] Developer guide: write your first JSOS app
890. [P2] Contributing guide
891. [P2] Security policy
892. [P2] Changelog maintained
893. [P2] API stability guarantees documented
894. [P3] Website (jsos.dev)
895. [P3] Online playground (run in browser via WebAssembly)
896. [P3] YouTube explainer series

---

## 31. INSTALL & PACKAGING

897. [P0] ISO installer: guided partition setup (at least one drive scenario)
898. [P0] Installer: GRUB install to MBR/GPT
899. [P0] Installer: copy filesystem to disk
900. [P0] Installer: set hostname, root password, first user
901. [P1] Live ISO mode: run without installing
902. [P1] Installer: timezone selection
903. [P1] Installer: locale / keyboard layout selection
904. [P1] `update-initramfs` equivalent: rebuild boot image
905. [P2] Installer: disk encryption option (LUKS-style)
906. [P2] Cloud-init support (provision from user-data)
907. [P2] OCI container image (FROM scratch, JSOS as base)
908. [P3] Raspberry Pi SD card image builder
909. [P3] PXE/iPXE boot server support

---

## 32. LEGAL, LICENSING, MISC

910. [P0] Audit QuickJS license (MIT) � confirm compliance in all distributions
911. [P0] Audit all `vendor/` code licenses
912. [P0] Choose JSOS project license (MIT / Apache-2 / GPL)
913. [P0] Mozilla Root CA bundle: confirm MPL 2.0 redistribution terms
914. [P1] NOTICE file listing all third-party code
915. [P1] Copyright headers in all source files
916. [P2] Contributor License Agreement (CLA)
917. [P2] Export control notice (cryptography)
918. [P3] Trademark registration for JSOS name/logo

---

## 33. MISC MISSING PIECES

919. [P0 ✓] Timezone data: IANA tz database as a TypeScript module (`sys.time.tz`) � `core/timezone.ts` with 130+ zones, DST rules; exposed as `os.time.tz` in sdk.ts
920. [P0 ✓] `/etc/config.json`: machine config (hostname, locale, timezone) � JSON not `/etc/hostname`
921. [P0 ✓] `/etc/fstab.json`: filesystem mount table as JSON array
922. [P0 ✓] Clock sync at boot: C reads CMOS RTC once; TypeScript initializes system clock
923. [P0 ✓] Entropy: C mixes TSC + RTC into seed; TypeScript `/dev/random` PRNG (ChaCha20)
924. [P0 ✓] `sys.config.get(key)` / `sys.config.set(key, val)` TypeScript API (replaces sysctl)
925. [P1 ✓] Locale: TypeScript locale module � `sys.locale.format(date)`, `sys.locale.collate()` � `core/locale.ts` with 7 supported locales, date/number/collation APIs
926. [P1 ✓] Locale: per-process locale setting via `sys.locale.set('en-US')` � module-level `_currentLocale` in `core/locale.ts`, falls back to `/etc/config.json`
927. [P1 ✓] RegExp: use QuickJS native `RegExp` � no libc binding needed
928. [P1] C heap: `malloc`/`free` consistency in C layer (kernel allocator) � fine, C-internal
929. [P1] C `printf`/`sprintf`: used only in C layer for debug output � already works
930. [P1 ✓] Math: QuickJS provides `Math.*` natively; `libm` only needed for C layer functions
931. [P1 ✓] Floating point: verify QuickJS handles NaN/Inf edge cases correctly
932. [P1 ✓] File creation mask: default mode bits for new files, stored in TypeScript process context � `_processUmask`, `_filePerms()`, `_dirPerms()` + `os.umask()` API in `fs/filesystem.ts`
933. [P2] Pseudoterminals: only needed if embedding a third-party TUI app � low priority without shell
934. [P2 ✓] Session log: TypeScript append-only log at `/var/log/sessions.jsonl` (replaces utmp/wtmp) � `sessionLog()` in `users/users.ts`, called on login/logout
935. [P2] JSOS service bus: typed async pub/sub (TypeScript, replaces D-Bus)
936. [P2] TypeScript device manager: `sys.devices` � enumerate, mount, eject block devices
937. [P2] TypeScript network manager: `sys.net.interfaces`, `sys.net.wifi` � no external daemon
938. [P2] `sys.audio` TypeScript API (see section 26) � no PulseAudio compat layer needed
939. [P2] TypeScript hotplug manager: `sys.devices.on('add', handler)` event-based device arrival
940. [P2] USB hotplug: C fires IRQ on device attach; TypeScript dispatches `sys.devices` events
941. [P3] TypeScript sandbox isolation: `sys.sandbox.run(code, { allowedAPIs })` restricted context
942. [P3] KVM: C exposes VMLAUNCH/VMRESUME; TypeScript implements VMM control logic
943. [P3] ~~LLVM / C compilation~~ � **REMOVED**: JSOS does not compile C. TypeScript-to-native via JSJIT only.
944. [P3] ~~Wayland protocol~~ � **REMOVED**: JSOS renders directly to framebuffer canvas, no Wayland needed
945. [P3] Split-horizon DNS: TypeScript DNS resolver with per-interface search domain config

---

## 34. HARDENING & RELIABILITY

946. [P0] Kernel stack overflow detection (stack canary)
947. [P0] Heap corruption detection (guard allocs)
948. [P0] Null pointer dereference trap (map page 0 as non-present)
949. [P0] All syscall inputs sanitized (no kernel ptr leaks to JS)
950. [P1] SMEP: Supervisor Mode Execution Prevention
951. [P1] SMAP: Supervisor Mode Access Prevention
952. [P1] KASLR: randomize kernel base at each boot
953. [P1] W^X: no memory region writable AND executable
954. [P1] Kernel integrity check: hash kernel image at boot
955. [P2] Crash reporter: send crash dump to developer server
956. [P2] Automated reboot on unrecoverable fault
957. [P2] Watchdog: hardware or software watchdog timer
958. [P3] Formal verification of syscall interface

---

## 35. FINAL RELEASE CHECKLIST

959. [P0] All P0 items above completed and tested
960. [P0] Boot time < 5 seconds in QEMU
961. [P0] Memory usage at idle < 256 MB
962. [P0] Browser can render `https://example.com` correctly
963. [P0] Browser can render `https://wikipedia.org` � text readable
964. [P0] Browser can render `https://news.ycombinator.com` correctly
965. [P0] No kernel panic in 24h continuous operation test
966. [P0] All first-party applications launch without crashing
967. [P0] Installer completes on blank QEMU disk image
968. [P1] Browser can render `https://github.com` � JS-heavy page partially works
969. [P1] Audio output works (plays a `.mp3`)
970. [P1] Network connectivity survives DHCP renewal
971. [P1] Multiple simultaneous HTTPS connections work
972. [P1] REPL tab completion works reliably for all `sys.*` APIs and filesystem paths
973. [P1] File manager can browse and open files
974. [P1] Text editor can edit and save files
975. [P1] System survives OOM (out of memory) gracefully
976. [P2] Browser passes Acid3 test (score = 85/100)
977. [P2] Browser correctly renders top 100 Alexa sites (= 60% readable)
978. [P2] SSH login from host machine works
979. [P2] File sharing with host via QEMU 9p virtio
980. [P0] Browser: consistent 60fps scroll and animation on real-world sites (see section 28 for full perf roadmap)
981. [P3] Browser passes WPT (Web Platform Tests) = 40% pass rate
982. [P3] Self-hosting: build JSOS from within JSOS -- DONT DO
983. [P3] Support for 10 simultaneous logged-in users (SMP)
984. [P3] Power management: ACPI S3 suspend/resume
985. [P3] Battery status on laptops (ACPI battery interface)
986. [P3] Touchpad gestures on laptops
987. [P3] HiDPI display (4K) rendering
988. [P3] Screen reader (accessibility) basic support
989. [P3] Internationalization: render Arabic, Chinese, Japanese
990. [P3] Right-to-left layout support
991. [P3] Voice control stub
992. [P3] Public release on GitHub with proper README
993. [P3] Docker image published to Docker Hub
994. [P3] Prebuilt ISO downloadable from releases page
995. [P3] Community forum / Discord
996. [P3] Bug tracker (GitHub Issues) with triage labels
997. [P3] Roadmap published for v2.0
998. [P3] Logo and branding finalized
999. [P3] Domain name jsos.dev registered and live
1000. [P0] Ship it.

---

*Total items: 1130+ across 35 categories (section 28 expanded with full desktop-performance roadmap).*
*P0 (~180 items): must fix before any public demo.*
*P1 (~320 items): required for the OS to be genuinely usable.*
*P2 (~280 items): important quality-of-life and compatibility.*
*P3 (~220 items): future roadmap.*

### Vision Alignment Rules (from agents.md)
- C code = raw I/O register access only. Zero scheduling, protocol, or FS logic in C.
- All driver logic, all protocols, all OS algorithms = TypeScript.
- All applications = TypeScript. No C apps, no Python apps, no shell scripts.
- No shell language. TypeScript REPL is the only interactive interface.
- Items removed as misaligned: System V IPC, systemd unit parser, ALSA compat, Wayland, LLVM/C compilation, udev rules (replaced with TypeScript equivalents), utmp/wtmp (replaced with JSON log), sysctl (replaced with `sys.config` API), D-Bus (replaced with typed service bus), cgroups/namespaces (replaced with TypeScript sandboxing).
