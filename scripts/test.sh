#!/bin/bash
set -e

echo "Testing JSOS in QEMU..."

if [ ! -f "build/jsos.iso" ]; then
    echo "Error: build/jsos.iso not found. Run build first."
    exit 1
fi

# Create 4 GiB sparse disk image if absent (auto-formats as FAT32 on first JSOS boot)
if [ ! -f "build/disk.img" ]; then
    truncate -s 4G build/disk.img
fi

# Run QEMU with timeout
timeout 30s qemu-system-x86_64 \
    -cdrom build/jsos.iso \
    -drive file=build/disk.img,format=raw,media=disk \
    -m 4G \
    -display none \
    -accel tcg \
    -serial stdio \
    -no-reboot \
    -netdev user,id=n0 \
    -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on \
    -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
    || true

echo "Test completed."
