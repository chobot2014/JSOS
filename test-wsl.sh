#!/bin/bash
# Test JSOS in WSL with QEMU

echo "Testing JSOS in WSL..."

# Check if build/jsos.iso exists
if [ ! -f "build/jsos.iso" ]; then
    echo "Error: build/jsos.iso not found. Run 'npm run build' first."
    exit 1
fi

# Install QEMU if not already installed
if ! command -v qemu-system-x86_64 &> /dev/null; then
    echo "Installing QEMU..."
    sudo apt update
    # Fix any broken dependencies first
    sudo apt --fix-broken install -y
    # Install minimal QEMU without GUI dependencies
    sudo apt install -y qemu-system-x86 --no-install-recommends
fi

echo "Starting JSOS..."
echo "Press Ctrl+A then X to exit QEMU"
echo "=================="

# Check if we have X11 display available
if [ -z "$DISPLAY" ]; then
    echo "No X11 display found. Setting up X forwarding..."
    export DISPLAY=:0
fi

echo "Note: Make sure you have an X server running on Windows (like VcXsrv, X410, or WSLg)"
echo "Or install one if you don't have it already."
echo ""

# Run QEMU with our ISO in a graphical window
qemu-system-x86_64 \
    -cdrom build/jsos.iso \
    -m 512M \
    -no-reboot \
    -display gtk \
    -serial mon:stdio
