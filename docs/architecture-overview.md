# JSOS Architecture Overview Diagram
**Item 885** — Updated architecture diagram

## System Layers

```
╔══════════════════════════════════════════════════════════════╗
║                     User Applications                        ║
║  Browser  Terminal  Calculator  Music Player  Text Editor    ║
║         (src/os/apps/ — all TypeScript)                      ║
╠══════════════════════════════════════════════════════════════╣
║                    System Services                           ║
║  sys.fs   sys.net   sys.audio   sys.process   sys.users      ║
║         (src/os/core/ + subsystems — TypeScript)             ║
╠══════════════════════════════════════════════════════════════╣
║              OS Subsystems (all TypeScript)                  ║
║ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     ║
║ │ VMM  │ │  FS  │ │ Net  │ │ IPC  │ │Audio │ │  UI  │     ║
║ │Sched.│ │Ext4  │ │TCP/IP│ │Pipes │ │Mixer │ │ WM/  │     ║
║ │Debug │ │Over- │ │DNS   │ │Chan- │ │Codec │ │REPL/ │     ║
║ │Proc. │ │layFS │ │HTTP  │ │nels  │ │Drivers│ │Term  │     ║
║ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘     ║
╠══════════════════════════════════════════════════════════════╣
║           QuickJS JIT Engine (embedded in kernel binary)     ║
║     Executes the TypeScript-compiled JS bundle at boot       ║
╠══════════════════════════════════════════════════════════════╣
║       Thin C Hardware Abstraction Layer (< 5% of code)       ║
║  I/O Ports  Interrupts  DMA  PCI  VGA  ATA  NVMe  Timers    ║
║  Audio DMA  Network DMA  Memory Map  CPUID  MSR  APIC        ║
║                 (src/kernel/ — C/ASM)                        ║
╠══════════════════════════════════════════════════════════════╣
║                    x86 Bare Metal                            ║
╚══════════════════════════════════════════════════════════════╝
```

## Boot Sequence

```
BIOS/UEFI → GRUB2 → kernel binary (Multiboot2) →
  C init: GDT/IDT/paging/COM1 → QuickJS init →
    load embedded bundle.js → TypeScript OS boot →
      sys.process.init() → sys.fs.mount() → sys.net.init() →
        init.ts (service manager) → repl.ts (user shell)
```

## Browser Engine Architecture

```
URL → HTML parser → DOM tree
  → CSS parser → CSSOM
  → Layout engine (Flex/Grid/Block)
  → Paint (canvas2d.ts)
  → Composite (advanced-css.ts opacity/transform layers)
  → framebuffer blit (kernel.fbWrite)
JS execution: jsruntime.ts injects APIs into QuickJS context
```

## Network Stack

```
Ethernet frame → e1000/RTL8139 DMA ring → net/ethernet.ts
  → ARP table → net/ip.ts (IPv4/IPv6)
  → net/tcp.ts (state machine) → net/tls.ts (TLS 1.3)
  → net/http.ts (HTTP/1.1 + HTTP/2) → browser fetch API
  → net/dns.ts → DNS cache
```

## File System Stack

```
sys.fs API → VFS (fs/filesystem.ts) → mount table
  → ext4 (fs/ext4.ts) → block device cache
  → overlayFS (fs/overlayfs.ts) (live ISO root)
  → ISO9660 (fs/iso9660.ts) (read-only ISO layer)
  → block device → kernel.ataRead/ataWrite
```
