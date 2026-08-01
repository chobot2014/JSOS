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
node scripts/embed-js.js

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

# Item 2: also produce a BIOS ISO without xorriso dependency
echo "Creating BIOS ISO (no-xorriso path)..."
if bash scripts/build-iso-noXorriso.sh build/jsos-noXorriso.iso; then
    echo "No-xorriso ISO: build/jsos-noXorriso.iso"
else
    echo "Warning: no-xorriso ISO build failed (genisoimage/mkisofs not installed?)"
fi

# Item 3: produce UEFI/GPT boot image
echo "Creating UEFI GPT disk image..."
if bash scripts/build-uefi-image.sh build/jsos-uefi.img build/jsos-uefi.iso; then
    echo "UEFI image: build/jsos-uefi.img"
else
    echo "Warning: UEFI image build failed (grub-efi-*-bin / dosfstools not installed?)"
fi

echo ""
echo "All build artifacts:"
[[ -f build/jsos.iso ]]         && echo "  BIOS ISO (xorriso):  build/jsos.iso"
[[ -f build/jsos-noXorriso.iso ]] && echo "  BIOS ISO (no-xorriso): build/jsos-noXorriso.iso"
[[ -f build/jsos-uefi.img ]]    && echo "  UEFI GPT image:      build/jsos-uefi.img"
[[ -f build/jsos-uefi.iso ]]    && echo "  UEFI hybrid ISO:     build/jsos-uefi.iso"
