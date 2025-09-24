#!/bin/bash

# JSOS Build Script

set -e

echo "Building JSOS..."

# Ensure we're in the project root
cd "$(dirname "$0")/.."

# Check if bundle.js exists
if [ ! -f "build/bundle.js" ]; then
    echo "Error: build/bundle.js not found. Run 'npm run bundle' first."
    exit 1
fi

# Embed JavaScript into C header
echo "Embedding JavaScript code..."
chmod +x scripts/embed-js.sh
./scripts/embed-js.sh

# Build the kernel
echo "Building kernel..."
cd src/kernel
make clean
make

# Create GRUB ISO
echo "Creating ISO..."
cd ../..
mkdir -p build/iso/boot/grub
cp src/kernel/jsos.bin build/iso/boot/jsos.bin
cp iso/grub.cfg build/iso/boot/grub/grub.cfg

grub-mkrescue -o build/jsos.iso build/iso

echo "Build complete! ISO created at build/jsos.iso"
