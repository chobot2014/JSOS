#!/bin/bash
set -e

echo "Building JSOS Kernel and ISO..."

# Create build directory
mkdir -p build
mkdir -p build/iso/boot/grub

# Assume TypeScript has already been built by npm run build:local
# Check if JavaScript bundle exists
if [ ! -f "build/bundle.js" ]; then
    echo "Error: JavaScript bundle not found. Run 'npm run build:local' first."
    exit 1
fi

# Embed JavaScript into C header
echo "Embedding JavaScript into kernel..."
./scripts/embed-js.sh

# Build kernel
echo "Building kernel..."
make -C src/kernel

# Create bootable ISO
echo "Creating ISO..."
cp src/kernel/jsos.bin build/iso/boot/
cp iso/grub.cfg build/iso/boot/grub/

grub-mkrescue -o build/jsos.iso build/iso

echo "Build complete! ISO: build/jsos.iso"
ls -la build/jsos.iso
