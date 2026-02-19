#!/bin/bash
set -e

echo "Testing JSOS in QEMU..."

if [ ! -f "build/jsos.iso" ]; then
    echo "Error: build/jsos.iso not found. Run build first."
    exit 1
fi

# Run QEMU with timeout
timeout 30s qemu-system-x86_64 \
    -cdrom build/jsos.iso \
    -m 512M \
    -display none \
    -accel tcg \
    -serial stdio \
    -no-reboot \
    -device isa-debug-exit,iobase=0xf4,iosize=0x04 \
    || true

echo "Test completed."
