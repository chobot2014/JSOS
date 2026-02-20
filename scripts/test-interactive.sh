#!/bin/bash
set -e

echo "Starting interactive QEMU session..."

if [ ! -f "build/jsos.iso" ]; then
    echo "Error: build/jsos.iso not found. Run build first."
    exit 1
fi

echo "Press Ctrl+A then X to exit QEMU"
echo "Starting QEMU..."

# Create 4 GiB sparse disk image if absent
if [ ! -f "build/disk.img" ]; then
    truncate -s 4G build/disk.img
fi

qemu-system-x86_64 \
    -cdrom build/jsos.iso \
    -drive file=build/disk.img,format=raw,media=disk \
    -m 4G \
    -serial stdio \
    -display none \
    -accel tcg \
    -netdev user,id=n0 \
    -device virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on \
    -no-reboot
