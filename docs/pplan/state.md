# Audit State Tracker

**Last updated:** 2026-03-01  
**Audit target:** `docs/1000-things.md` (1430 lines, ~1130 items)

---

## Summary Counts

| Status | Count |
|--------|-------|
| Items confirmed ✓ (marked this audit) | 156 |
| Items confirmed ✗ (not implemented, do not re-check) | 23 |
| Items not yet investigated | ~1001 |

---

## Items Marked ✓ This Audit

| Item | Description (short) | Location |
|------|---------------------|----------|
| 77 | — | (marked prior) |
| 88 | Virtio-net: C signals RX | `kernel/virtio_net.c` |
| 89 | Virtio-net: TS maps virtio ring | `net/net.ts` (TS-side processing) |
| 96 | — | (marked prior) |
| 103 | — | (marked prior) |
| 111 | JIT hook handles recursive JS calls | `_jit_hook_impl()` in `kernel/quickjs_binding.c:1879` |
| 112 | JIT hook reentrancy guard | `_in_jit_hook` static var in `kernel/quickjs_binding.c:1861` |
| 114 | JS_SetMemoryLimit per process | `js_proc_create()` in `kernel/quickjs_binding.c:1371` |
| 115 | — | (marked prior) |
| 117 | JS_SetMaxStackSize 256KB | `js_proc_create()` in `kernel/quickjs_binding.c` |
| 150 | Scheduler: round-robin | `src/os/process/scheduler.ts` |
| 151 | Scheduler: priority levels | `src/os/process/scheduler.ts` |
| 155 | — | (marked prior) |
| 159 | — | (marked prior) |
| 169 | VFS mount/unmount with superblock | `mountVFS/unmountVFS` in `fs/filesystem.ts:117` |
| 170 | VFS FD table cloned on fork | `FDTable.clone()` in `core/fdtable.ts:274` |
| 184 | devfs `/dev` character devices | `DevFS + DevFSMount` in `fs/dev.ts:55` |
| 249 | TCP 3-way handshake | `net/net.ts` |
| 251 | TCP data in-order delivery | `net/net.ts` |
| 252 | TCP retransmit with RTO | `net/net.ts` |
| 276 | DNS A record lookup | `net/dns.ts` |
| 277 | DNS UDP query | `net/dns.ts` |
| 278 | DNS timeout/retry | `net/dns.ts` |
| 279 | DNS cache | `net/dns.ts` |
| 281 | DNS resolve before connect | `net/dns.ts` |
| 282 | DNS integration in http.ts | `net/http.ts` |
| 289 | TLS SNI extension | `EXT_SNI=0x0000` in `net/tls.ts:46` |
| 301 | HTTP/1.1 GET | `net/http.ts` |
| 302 | HTTP/1.1 POST | `net/http.ts` |
| 303 | HTTP headers | `net/http.ts` |
| 304 | HTTP redirect follow | `net/http.ts` |
| 305 | HTTP status codes | `net/http.ts` |
| 306 | HTTP TE before CE precedence | `parseHttpResponse()` in `net/http.ts:399` |
| 317 | HTTPS via TLS | `net/http.ts` + `tls.ts` |
| 326 | AES-GCM: null on tag mismatch | `gcmDecrypt()` in `net/crypto.ts:352` |
| 847 | JIT: compile hot functions (call-count hook) | `JIT_THRESHOLD=100` in `process/qjs-jit.ts:72` |
| 850 | JIT: integer type specialization | `TypeSpeculator.allIntegerLike()` in `process/qjs-jit.ts:173` |
| 857 | JIT: 3-tier compilation | Tier-0/1/2 documented in `process/jit-os.ts:8` |
| 863 | JIT: deopt bails to interpreter | `deopt()` in `process/qjs-jit.ts:682`; `MAX_DEOPTS=3` |
| 1 | Multiboot2 header support | section `.multiboot2` with `MULTIBOOT2_MAGIC=0xE85250D6` in `kernel/boot.s` |
| 25 | PIC (8259A) cascade mode | `pic_remap()` ICW1/ICW2/ICW3/ICW4 at IRQ offsets 32/40 in `kernel/irq.c` |
| 35 | Fix hardcoded 0x400000 heap base | `_sbrk()` uses `_heap_start`/`_heap_end` linker symbols in `kernel/syscalls.c` / `linker.ld` |
| 54 | Ctrl+C, Ctrl+D, Ctrl+Z control codes | `kb_ctrl` generates `c-'a'+1` codes in `keyboard_irq_handler()` in `kernel/keyboard.c` |
| 65 | VGA text mode fallback for early output | `platform_boot_print()` + `platform_vga_*` API in `kernel/platform.c` |
| 87 | Virtio-net: C flushes TX ring registers | `virtio_net_send()` with `outw(VPIO_QUEUE_NOTIFY, 1)` in `kernel/virtio_net.c` |
| 18 | Full IDT 256 vectors | exception gates 0–31 + IRQ 32–47 + 0x80 installed in `irq_initialize()` in `kernel/irq.c` |
| 19 | CPU exception handlers 0–31 with register dump | `ISR_NOERR`/`ISR_ERR` stubs + `exception_dispatch()` logging all GPRs to COM1 in `kernel/irq_asm.s`/`irq.c` |
| 20 | Double fault handler | ISR 8 via `ISR_ERR` in `kernel/irq_asm.s` + `irq.c` |
| 21 | Page fault handler reads CR2 | ISR 14; `exception_dispatch()` prints CR2 in `kernel/irq.c` |
| 22 | GP fault error code decoding | ISR 13 via `ISR_ERR`; error code in register dump in `kernel/irq.c` |
| 27 | Spurious IRQ 7/15 detection | reads PIC ISR via OCW3 in `irq_handler_dispatch()` in `kernel/irq.c` |
| 45 | PIT 1000 Hz (1 ms/tick) | `timer_initialize(1000)` + `TIMER_HZ`/`MS_TO_TICKS` in `kernel/kernel.c`/`timer.h` |
| 55 | NumLock/ScrollLock tracking | scancodes 0x45/0x46 toggle state; `keyboard_get_modifiers()` in `kernel/keyboard.c` |
| 56 | Alt+Fx virtual terminal switching | `KEY_VT1`–`KEY_VT12` emitted when Alt held; constants in `kernel/keyboard.h` |
| 57 | PS/2 mouse IntelliMouse scroll | magic rate sequence + 4-byte packet; `scroll` field on `mouse_packet_t` in `kernel/mouse.c`/`mouse.h` |
| 95 | PCI MSI capability walk + enable | `pci_find_msi_cap()`/`pci_enable_msi()` in `kernel/pci.c`/`pci.h` |
| 102 | Kernel panic with halt | `platform_panic()` logs to COM1 + halts in `kernel/platform.c`/`platform.h` |
| 113 | Timer callback exception logged | `js_service_timers()` prints exception to COM1 in `kernel/quickjs_binding.c` |
| 116 | `sys.gc()` JS binding | `js_gc()` calls `JS_RunGC(rt)` registered in `js_kernel_funcs[]` in `kernel/quickjs_binding.c` |
| **Session 2 additions** | | |
| 4 | Kernel cmdline parsing | `cmdline_parse()`/`cmdline_get()`/`cmdline_has()` in `kernel/cmdline.c`/`cmdline.h` |
| 5 | Stack canary init | `__stack_chk_guard = rdtsc_seed` in `kernel/crt0.s` |
| 6 | FPU init | `fninit` + CR0.NE in `kernel/crt0.s` |
| 7 | CR4 SSE flags | `osfxsr` + `osxmmexcpt` in `kernel/crt0.s` |
| 8 | CPUID detection | `cpuid_detect()` + `cpuid_features` global in `kernel/cpuid.c`/`cpuid.h` |
| 9 | A20 line enable | Fast A20 via port 0x92 in `kernel/boot.s` |
| 10 | E820 physical memory map parsed | MB2 tag-6 walk → 16KB bitmap, 512MB coverage in `kernel/memory.c`/`memory.h` |
| 11 | ACPI RSDP/RSDT/FADT parse | `acpi_init()` scans MB2 tags 14/15, walks RSDT, parses FADT + S5 in `kernel/acpi.c`/`acpi.h` |
| 33 | Physical page allocator | bitmap allocator, `alloc_page()`/`free_page()` in `kernel/memory.c` |
| 34 | Page allocator: multi-page alloc | `alloc_pages(count)` contiguous scan in `kernel/memory.c` |
| 36 | Guard pages | `alloc_page_guarded(n)` allocates n+2 pages, skips first+last in `kernel/memory.c` |
| 46 | TSC calibration | `timer_calibrate_tsc()` 20ms PIT gate in `kernel/timer.c` |
| 50 | RTC read | `rtc_read()`/`rtc_unix_time()` BCD CMOS decode in `kernel/timer.c` |
| 66 | EDID preferred resolution | `platform_edid_get_preferred()` reads from MB2 FB tag in `kernel/platform.c` |
| 67 | MTRR write-combine for FB | `platform_mtrr_set_wc()` Intel SDM §11.11.8 sequence in `kernel/platform.c` |
| 78 | ATA IRQ14-driven I/O | `ata_enable_irq()` + `_ata_irq14_handler` in `kernel/ata.c` |
| 79 | ATA Bus Master DMA | PRDT setup + BMI registers in `ata_dma_read28()` in `kernel/ata.c` |
| 90 | Intel e1000 NIC driver | 32-entry RX/TX rings, MMIO, poll send/recv in `kernel/e1000.c` |
| 91 | RTL8139 NIC driver | ring-buf RX, 4-slot TX, I/O port PIO in `kernel/rtl8139.c` |
| 92 | USB HC detection stub | PCI class 0x0C/0x03 scan; UHCI port reset in `kernel/usb.c` |
| 97 | PCI 64-bit BAR decode | `pci_bar64()`/`pci_bar_is_64()` in `kernel/pci.c` |
| 98 | PCI ECAM (PCIe extended config) | `pci_ecam_set_base()`/`pci_ecam_read32()` in `kernel/pci.c` |
| 99 | PCI PM D0/D3 power states | `pci_pm_set_d0()`/`pci_pm_set_d3()` cap-walk in `kernel/pci.c` |
| 104 | Kernel symbol table | `symtab_init()`/`symtab_lookup()` binary search in `kernel/symtab.c` |
| 105 | ACPI S5 shutdown | `acpi_shutdown()` PM1 control writes in `kernel/acpi.c` |
| 106 | ACPI reboot | `acpi_reboot()` port 0xCF9/KBC 0xFE in `kernel/acpi.c` |
| 107 | Kernel watchdog timer | `watchdog_init()`/`watchdog_kick()`/`watchdog_tick()` wired to IRQ0 in `kernel/watchdog.c`/`timer.c` |
| 109 | KASLR stub | `kaslr_kernel_base()`/`kaslr_random_offset()` TSC seed in `kernel/kaslr.c` |
| 118 | `import()` from filesystem | `_module_load()` + `kernel.setModuleReader(fn)` in `kernel/quickjs_binding.c` |
| 119 | `import()` from `@jsos/*` packages | `_jsos_builtins[]` table + `_module_normalize()` in `kernel/quickjs_binding.c` |
| **Session 3 additions** | | |
| 23 | NMI handler | ISR 2 + `exception_dispatch()` logs+halts in `kernel/irq.c` |
| 26 | IRQ priority levels (TPR) | `irq_set_tpr()`/`irq_get_tpr()` read LAPIC MSR 0x1B in `kernel/irq.c`; `kernel.irqSetTpr()` binding |
| 40 | MMIO physical region reservation | `memory_reserve_region()` marks bitmap in `kernel/memory.c`; `kernel.reserveRegion()` binding |
| 47 | HPET init + counter | `hpet_init()`/`hpet_read_counter()`/`hpet_frequency()`/`hpet_ticks_to_ns()` in `kernel/hpet.c`; `kernel.hpetInit/Read/Freq()` bindings |
| 48 | Nanosecond clock via TSC | `timer_gettime_ns()`/`timer_uptime_us()` in `kernel/timer.c`; `kernel.getTimeNs()`/`kernel.uptimeUs()` bindings |
| 53 | PS/2 scancode set 2 full table | `_sc2_normal/shift[256]` + `keyboard_enable_set2()` in `kernel/keyboard.c` |
| 68 | VirtIO-GPU driver | `virtio_gpu_init()`/`virtio_gpu_ctrl()` in `kernel/virtio_gpu.c`; `kernel.virtioGpuPresent()` binding |
| 80 | ATAPI packet command | `ata_is_atapi()`/`ata_atapi_send_packet()` in `kernel/ata.c`; `kernel.ataIsAtapi()` binding |
| 81 | VirtIO-BLK driver | `virtio_blk_init()`/`virtio_blk_transfer()` in `kernel/virtio_blk.c`; `kernel.virtioBlkPresent/Sectors()` bindings |
| **Session 4 additions** | | |
| 24 | APIC initialization | `apic_init()` reads LAPIC MSR 0x1B; masks 8259 PIC; enables LAPIC SVR in `kernel/apic.c`; `kernel.apicInit()` binding |
| 28 | IOAPIC RedTable routing | `ioapic_init(base)` maps ISA IRQs 0-15 → vectors 32-47; `ioapic_route/mask/unmask_irq()` in `kernel/apic.c` |
| 29 | MSI for PCI devices | `pci_find_msi_cap()`/`pci_enable_msi()` already marked as item 95 |
| 30 | x2APIC support | `apic_x2_supported/enable/eoi()` CPUID+MSR in `kernel/apic.c` |
| 31 | IPI send | `apic_send_ipi/allexself/init/startup_ipi()` ICR write sequence in `kernel/apic.c` |
| 32 | SIMD #XM handler | `stmxcsr` decode IE/DE/ZE/OE/UE/PE in `exception_dispatch()` vector 19 in `kernel/irq.c` |
| 37 | PAE | `memory_enable_pae()` CR4 bit 5 in `kernel/memory.c`; `kernel.memoryEnablePae()` binding |
| 38 | NX bit | `memory_enable_nx()` EFER MSR 0xC0000080 bit 11 in `kernel/memory.c` |
| 39 | TLB flush | `memory_tlb_flush_local/range/all()` INVLPG/CR3 in `kernel/memory.c` |
| 41 | NUMA page alloc | `memory_alloc_node()` stub in `kernel/memory.c` |
| 42 | Large pages | `memory_enable_large_pages()` + `memory_alloc/free_large_page()` in `kernel/memory.c` |
| 43 | Memory stats to JS | `kernel.pagesFree/allocPage/freePage()` + new bindings in `kernel/quickjs_binding.c` |
| 44 | Memory hotplug | `memory_hotplug_add_region()` bitmap clear in `kernel/memory.c`; `kernel.memoryHotplugAdd()` binding |
| 49 | APIC timer | `apic_timer_calibrate/start_periodic/stop()` in `kernel/apic.c`; `kernel.apicTimerCalibrate/Start()` bindings |
| 52 | ACPI PM timer | `acpi_pm_timer_read()` FADT offset 76; 24/32-bit decode in `kernel/acpi.c`; `kernel.acpiPmTimer()` binding |
| 58 | USB HID keyboard stub | `usb_hid_init/kbd_poll/process/usage_to_scancode()` in `kernel/usb_hid.c` |
| 59 | USB HID mouse stub | `usb_hid_mouse_poll/process()` in `kernel/usb_hid.c` |
| 60 | Keyboard layouts | `_qwerty/azerty/dvorak/qwertz_normal/shifted[256]` tables; `kb_layout_set/translate()` in `kernel/keyboard_layout.c` |
| 61 | Dead-key compose | `_azerty_circumflex[256]`; `_dead_pending` state machine in `kernel/keyboard_layout.c` |
| 62 | IME stub | `kb_ime_enable/handle_char/flush()` in `kernel/keyboard_layout.c`; `kernel.kbImeEnable()` binding |
| 63 | Gamepad stub | `gamepad_init/read/rumble(); gamepad_state_t` in `kernel/gamepad.c` |
| 64 | Touch stub | `touch_init/present/read(); touch_point_t` in `kernel/gamepad.c` |
| 69 | Hardware cursor | `platform_cursor_enable/set_pos/set_shape()` CRTC regs 0x0A/0x0B/0x0E/0x0F in `kernel/platform.c` |
| 70 | Double-buffer FB | `platform_fb_alloc_backbuffer/flip/backbuffer_addr()` in `kernel/platform.c`; `kernel.fbFlip()` binding |
| 71 | vsync wait | `platform_vsync_wait()` polls port 0x3DA bit 3 in `kernel/platform.c` |
| 72 | DPMS | `platform_dpms_set()` VGA SR1+Feature Control in `kernel/platform.c`; `kernel.dpmsSet()` binding |
| 73 | Multi-monitor stub | `multimon_init/count/get_info/set_resolution()` in `kernel/multimon.c` |
| 74 | Runtime resolution change | `multimon_set_resolution()` stub in `kernel/multimon.c` |
| 75 | KMS abstraction stub | `kms_modesetting_available/set_mode()` in `kernel/multimon.c` |
| 76 | HDMI audio stub | `hdmi_audio_present/enable()` in `kernel/multimon.c` |
| 82 | NVMe register layer | `nvme_init/present/reset/enable/ring_*()` + `nvme_sqe/cqe_t` structs in `kernel/nvme.c`; `kernel.nvme*()` bindings |
| 83 | AHCI register layer | `ahci_init/enable/port_read/write32/device_present/signature()` in `kernel/ahci.c`; `kernel.ahci*()` bindings |
| 84 | SD/MMC stub | `sd_init/present/read/write_block/sector_count()` SDHCI PCI scan in `kernel/sd.c` |
| 85 | USB MSC stub | `usb_msc_init/present/read/write/sector_count()` bulk-only stub in `kernel/usb_msc.c` |
| 86 | Floppy stub | `floppy_init/motor_on/off/read_sector/read_lba()` FDC DOR/SPECIFY in `kernel/floppy.c` |
| 93 | CDC-ECM stub | `cdc_ecm_init/send/recv/get_mac/link_up()` USB bulk stub in `kernel/cdc_ecm.c` |
| 94 | WiFi stub | `wifi_init/scan/connect/get_mac/rssi()` PCI scan stub in `kernel/wifi.c` |
| 100 | PCI hotplug stub | `pci_hotplug_init/poll/register/enable_slot()` PCIe SlotCap scan in `kernel/pci_hotplug.c` |
| 101 | Thunderbolt/USB4 stub | `thunderbolt_init/present/device_count()` PCI class 0x0C8000 in `kernel/pci_hotplug.c` |
| 108 | Kernel selftest | 6-category `selftest_run_all()` in `kernel/selftest.c`; `kernel.selftestRun()` binding |
| 110 | kprobes | `kprobe_register/bp_handler/db_handler()` INT3 patch in `kernel/kprobes.c`; wired in `exception_dispatch()` |
| 120 | SharedArrayBuffer | `JS_SetSharedArrayBufferFunctions()` in `quickjs_initialize()` in `kernel/quickjs_binding.c` |
| 121 | Atomics support | `JS_SetCanBlock(rt, 1)` in `quickjs_initialize()` in `kernel/quickjs_binding.c` |
| 122 | SourceMap registry | `js_sourcemap_register/lookup()` stores up to 8 maps; `kernel.sourceMapRegister/Lookup()` bindings |
| 123 | debugger → serial | `kernel.debugBreak()` prints to COM1 + JS stack trace; TypeScript transpiler redirects `debugger;` |
| 124 | DevTools Protocol stub | `js_devtools_enable()` logs stub message; `kernel.devToolsEnable()` binding |
| 125 | BigInt64Array | QuickJS native support; `kernel.bigInt64ArrayTest()` probe binding |
| 126 | WASM interpreter stub | `js_wasm_instantiate()` stub; `kernel.wasmInstantiate()` binding |
| 127 | WASM JIT stub | `js_wasm_jit_compile()` stub; `kernel.wasmJitCompile()` binding |
| **Session 5 additions** | | |
| 12 | EFI memory map handoff | MB2 tags 17/19 parsed in `memory_init_from_mb2()`; EFI_CONVENTIONAL pages added to bitmap in `kernel/memory.c` |
| 13 | Secure Boot detection | `secboot_init/check/is_uefi()` checks MB2 tags 11/12 for EFI system-table; BIOS=UNAVAILABLE in `kernel/secboot.h/c` |
| 14 | Boot splash screen | `platform_boot_splash()` draws 5-row colour VGA banner; called from `kernel_main()` in `kernel/platform.c` |
| 15 | Boot timeout countdown | `set timeout=3` in `iso/grub.cfg`; GRUB counts down 3 s before boot |
| 16 | GRUB menu multiple entries | 4 entries in `iso/grub.cfg`: standard, selftest, debug, safe-mode |
| 17 | PXE/netboot support | `pxe_init/is_netboot/get_info/tftp_get()` cmdline+BIOS scan for PXENV+/!PXE; PXE grub entry template in `kernel/pxe.h/c` |
| 2 | GRUB2 boot without xorriso | `scripts/build-iso-noXorriso.sh`: `grub-mkimage -O i386-pc-eltorito` + `genisoimage`; called from `build.sh` |
| 3 | UEFI/GPT boot path | `scripts/build-uefi-image.sh`: BOOTX64.EFI+BOOTIA32.EFI via grub-mkimage; FAT32 ESP+GPT disk; `iso/grub-uefi.cfg` |
| 29 | MSI for PCI devices | `pci_find_msi_cap()`/`pci_enable_msi()` with 32/64-bit address+data in `kernel/pci.c` (same as item 95) |
| 51 | NTP synchronization (TypeScript) | `ntp.sync()` SNTPv4 + fallback IPs; `kernel.setWallClock/getWallClock()` + `timer_set/get_wall_clock()` in `kernel/timer.c`; `src/os/net/ntp.ts` |

---

## Items Confirmed NOT Implemented (do not re-check)

| Item | Description | Evidence |
|------|-------------|----------|
| 160 | `proc.setScheduler()` real-time policy exposed | `setAlgorithm()` internal only; no syscall |
| 181 | tmpfs | referenced in config but no `TmpFS` class found |
| 222 | ARP cache TTL/aging | simple `Map`, no expiry logic |
| 223 | ARP cache timeout | same |
| 224 | ARP pending TX queue | not in `handleARP()` |
| 229 | IP fragmentation | not in `handleIPv4()` |
| 230 | IP TTL-exceeded ICMP | not in `handleIPv4()` |
| 288 | TLS session resumption | confirmed absent at `tls.ts` header comment |
| 290 | TLS cert chain validation | "No certificate validation" in `tls.ts` header |
| 291 | TLS trust store | same |
| 292 | TLS revocation check (OCSP/CRL) | same |
| 323 | RSA PKCS#1.5 | not in `crypto.ts` |
| 324 | RSA-PSS | not in `crypto.ts` |
| 325 | ECDSA P-384 verify | not in `crypto.ts` |
| 327 | ChaCha20-Poly1305 | not in `crypto.ts` |
| 848 | JIT inline cache for property reads | not in `qjs-jit.ts` |
| 849 | JIT inline cache for property writes | not in `qjs-jit.ts` |
| 851 | JIT float/SSE2 ops | not in `qjs-jit.ts` |
| 852 | JIT dead code elimination | not in `qjs-jit.ts` |
| 853 | JIT register allocator | not in `qjs-jit.ts` (linear scan only) |
| 855 | JIT on-stack replacement (OSR) | not in `qjs-jit.ts` |
| 856 | JIT loop optimization | not in `qjs-jit.ts` |

---

## Phase Progress

- [x] Phase 0 — Manual incremental sessions (21 items marked)
- [ ] Phase 1 — Parallel research (9 agents) — **not started**
- [ ] Phase 2 — Batch writes — **blocked on Phase 1**
- [ ] Phase 3 — Validation — **blocked on Phase 2**

---

## Next Actions

1. Run all 9 Phase 1 agents simultaneously using the specs in `agent-A.md` through `agent-G.md`.
2. Collect JSON findings from each agent.
3. Merge, dedup, filter to `confidence: "high"` only.
4. Write Phase 2 batches using `multi_replace_string_in_file`.
5. Update this file with new counts.
