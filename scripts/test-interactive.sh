#!/bin/bash
set -e

echo "Starting interactive QEMU session..."

if [ ! -f "build/jsos.iso" ]; then
    echo "Error: build/jsos.iso not found. Run build first."
    exit 1
fi

echo "Press Ctrl+A then X to exit QEMU"
echo "Starting QEMU..."

qemu-system-x86_64 \
    -cdrom build/jsos.iso \
    -m 512M \
    -serial stdio \
    -nographic \
    -no-reboot
