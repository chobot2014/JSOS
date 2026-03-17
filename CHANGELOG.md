# CHANGELOG
**Item 892**

All notable changes to JSOS are documented in this file.
Format: [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- **Audio system** — AC97 / Intel HDA / VirtIO Sound drivers; MP3, OGG, AAC, FLAC codec decoders; 3-band EQ biquad mixer; sys.audio API; `<audio>` and `<video>` HTML elements; microphone capture via navigator.mediaDevices.getUserMedia
- **CSS `@layer`** — Full cascade-layer support in jsruntime: statement-form layer ordering + block-form rule tagging + correct specificity sort (unlayered always wins)
- **Shadow DOM slots** — `<slot>` element with `assignedNodes()`, `assignedElements()`, and `ShadowRoot.assignSlots()` distribution
- **Platform compat polyfills** — React 18, Vue 3, Bootstrap, and Tailwind CSS compatibility shims
- **Platform arch abstraction** — `PlatformArch` interface with implementations for x86 bare metal, Raspberry Pi 4 (ARM64), and RISC-V; `detectArch()` factory
- **Hypervisor guest addons** — VMware Tools, VirtualBox Additions, KVM paravirt, Hyper-V enlightenments detection and integration
- **Unit test suite** — Tests for deflate, TLS, DNS, HTTP, CSS specificity, flex layout, HTML parser, TCP state machine
- **Integration tests** — Boot/render, form POST, localStorage, WebSocket, 100-page parser regression
- **Guided installer** — Partition, GRUB install, filesystem copy, config write, timezone/locale setup, boot image rebuild
- **Documentation** — kernel-api-reference, sys-api-reference, getting-started, architecture-overview, network-internals, browser-internals, filesystem-layout, contributing, security

### Changed
- CSS cascade sort now accounts for `@layer` index
- `ShadowRoot` gained `assignSlots()` method

### Fixed
- (none)

---

## [0.1.0] — 2024-01-01

### Added
- Bootloader (GRUB2 + UEFI)
- QuickJS VM embedded in kernel
- VGA / framebuffer terminal
- PS/2 keyboard driver
- PIT timer + APIC
- Physical memory manager (bitmap allocator)
- Virtual memory manager (x86 4-level paging)
- PCI bus enumeration
- ATA / AHCI disk driver
- ext2 filesystem
- Process scheduler (round-robin + priority)
- System call interface
- TCP/IP stack (ARP, IP, ICMP, TCP, UDP)
- TLS 1.3
- DNS resolver
- HTTP/1.1 + HTTP/2
- WebSocket
- HTML5 parser
- CSS2.1 + CSS3 engine
- Flexbox + Grid layout
- JavaScript + TypeScript runtime (QuickJS)
- REPL shell
- `sys.*` API (process, fs, net, vmm, ipc, storage, users, env, time, display, debug)
