# Agent A — Kernel / Boot / QuickJS Binding

**Phase 1 agent. Read-only. Returns JSON findings.**  
See [audit-parallel.md](audit-parallel.md) for the full protocol and return format.

---

## Assigned Sections

| Section | Items |
|---------|-------|
| §1 Kernel & Boot | 1–110 |
| §2 QuickJS Binding | 111–127 |

---

## Source Files to Read

```
src/kernel/boot.s
src/kernel/crt0.s
src/kernel/kernel.c
src/kernel/irq.c
src/kernel/irq_asm.s
src/kernel/timer.c
src/kernel/keyboard.c
src/kernel/mouse.c
src/kernel/pci.c
src/kernel/platform.c
src/kernel/ata.c
src/kernel/virtio_net.c
src/kernel/memory.c
src/kernel/syscalls.c
src/kernel/jit.c
src/kernel/quickjs_binding.c        ← very large (~2600 lines), read in sections
```

---

## Focus Areas

- IDT/GDT setup, protected-mode entry (`boot.s`)
- PIC init, IRQ unmasking, spurious IRQ handling (`irq.c`)
- PIT frequency: what Hz is the timer set to? (`timer.c`)
- Keyboard: scancode set 1/2/3, capslock tracking, modifiers (`keyboard.c`)
- Mouse: PS/2 packet decode, `MOUSE_PACKET_COMPLETE` state machine (`mouse.c`)
- PCI: multi-function scan, BAR decoding, bus mastering (`pci.c`)
- Serial port UART init, `platform_putchar` routing (`platform.c`)
- ATA: PIO polling, LBA28/LBA48, identify command — **no DMA, no IRQ** (`ata.c`)
- Virtio-net: virtqueue descriptor chains, notify, RX/TX (`virtio_net.c`)
- Memory: e820 map, free list init, `kmalloc`/`kfree` (`memory.c`)
- System calls dispatch table in `syscalls.c`
- QuickJS binding: `JS_SetMemoryLimit`, `JS_SetMaxStackSize`, per-process runtimes,
  `JS_NewRuntime` per slot, `_in_jit_hook` reentrancy, `_jit_hook_impl`,
  garbage collection trigger, `js_halt`, `js_reboot` (`quickjs_binding.c`)

---

## Already Marked — Skip These

```
77, 78, 79, 88, 89, 96, 103, 111, 112, 114, 115, 117
```

---

## Notes from Prior Work

- **Item 78/79** (ATA interrupt/DMA): `ata.c` line 5 comment confirms "No DMA, no IRQs — polling only". Do NOT re-check.
- **Item 111** (`_jit_hook_impl`): confirmed at `quickjs_binding.c` lines 1879–1895.
- **Item 112** (`_in_jit_hook` guard): confirmed at line 1861.
- **js_halt()**: uses `cli; hlt` — NOT ACPI S5.
- **js_reboot()**: PS/2 keyboard controller `outb(0x64, 0xFE)` — NOT ACPI reset.
