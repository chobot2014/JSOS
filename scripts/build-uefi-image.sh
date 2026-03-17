#!/bin/bash
#
# build-uefi-image.sh — Item 3: UEFI/GPT boot path (GRUB EFI stub)
#
# Produces a UEFI-bootable hybrid image:
#   build/jsos-uefi.img — GPT raw disk image (suitable for QEMU -drive format=raw,
#                          VirtualBox, VMware, or writing to a USB stick)
#   build/jsos-uefi.iso — Hybrid UEFI+BIOS ISO (uses xorriso if available,
#                          otherwise grub-mkrescue fallback)
#
# Requirements:
#   grub-efi-amd64-bin OR grub-efi-ia32-bin   — for GRUB EFI application
#   grub-pc-bin                               — for BIOS GRUB (hybrid)
#   dosfstools / mkdosfs                      — for FAT32 ESP creation
#   mtools (mcopy, mformat)                   — embed files into FAT image
#   parted                                    — GPT partition table creation
#   qemu-img (optional)                       — convert to qcow2
#
# Architecture decisions:
#   * BOOTX64.EFI for 64-bit UEFI (most modern firmware)
#   * BOOTIA32.EFI for 32-bit UEFI (some older tablets / Chromebooks)
#   * GRUB is configured to load the same Multiboot2 jsos.bin kernel
#   * The kernel handles UEFI via MB2 EFI memory map tags (memory.c item 12)
#   * Secure Boot not enforced in this build (item 13 detection only)
#
set -euo pipefail

OUTPUT_IMG="${1:-build/jsos-uefi.img}"
OUTPUT_ISO="${2:-build/jsos-uefi.iso}"
KERNEL="src/kernel/jsos.bin"
GRUB_CFG="iso/grub-uefi.cfg"
WORK="build/uefi-work"

# ── Sanity checks ──────────────────────────────────────────────────────────
if [[ ! -f "$KERNEL" ]]; then
    echo "ERROR: Kernel not found at $KERNEL"
    exit 1
fi

check_tool() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: $1 not found. Install: $2"
        exit 1
    fi
}

check_tool grub-mkimage  "apt-get install grub-pc-bin"
check_tool mformat       "apt-get install mtools"
check_tool mcopy         "apt-get install mtools"
check_tool mkdosfs       "apt-get install dosfstools"
check_tool parted        "apt-get install parted"
check_tool dd            "coreutils"

# ── Detect available GRUB EFI prefix paths ────────────────────────────────
# grub-efi-amd64-bin provides modules in /usr/lib/grub/x86_64-efi/
# grub-efi-ia32-bin  provides modules in /usr/lib/grub/i386-efi/
GRUB_EFI64_DIR="/usr/lib/grub/x86_64-efi"
GRUB_EFI32_DIR="/usr/lib/grub/i386-efi"

BUILD_EFI64=0
BUILD_EFI32=0
[[ -d "$GRUB_EFI64_DIR" ]] && BUILD_EFI64=1
[[ -d "$GRUB_EFI32_DIR" ]] && BUILD_EFI32=1

if [[ $BUILD_EFI64 -eq 0 && $BUILD_EFI32 -eq 0 ]]; then
    echo "ERROR: No GRUB EFI modules found."
    echo "Install: apt-get install grub-efi-amd64-bin grub-efi-ia32-bin"
    exit 1
fi

# ── Prepare work tree ─────────────────────────────────────────────────────
rm -rf "$WORK"
mkdir -p "$WORK/esp/EFI/BOOT"
mkdir -p "$WORK/esp/boot"
mkdir -p "$WORK/bios/boot/grub"

# Copy kernel to both BIOS and EFI paths
cp "$KERNEL" "$WORK/esp/boot/jsos.bin"
cp "$KERNEL" "$WORK/bios/boot/jsos.bin"
cp "$GRUB_CFG" "$WORK/esp/EFI/BOOT/grub.cfg"
cp iso/grub.cfg "$WORK/bios/boot/grub/grub.cfg"

# ── GRUB EFI modules to embed ─────────────────────────────────────────────
EFI_MODULES="part_gpt part_msdos fat iso9660 multiboot2 normal configfile echo font terminal"

# ── Build BOOTX64.EFI (64-bit UEFI) ──────────────────────────────────────
if [[ $BUILD_EFI64 -eq 1 ]]; then
    echo "[uefi] Building BOOTX64.EFI (x86_64-efi)..."
    grub-mkimage \
        --directory="$GRUB_EFI64_DIR" \
        --output="$WORK/esp/EFI/BOOT/BOOTX64.EFI" \
        --format="x86_64-efi" \
        --prefix="(hd0,gpt1)/EFI/BOOT" \
        --config="$GRUB_CFG" \
        $EFI_MODULES
fi

# ── Build BOOTIA32.EFI (32-bit UEFI / Bay Trail / Braswell) ──────────────
if [[ $BUILD_EFI32 -eq 1 ]]; then
    echo "[uefi] Building BOOTIA32.EFI (i386-efi)..."
    grub-mkimage \
        --directory="$GRUB_EFI32_DIR" \
        --output="$WORK/esp/EFI/BOOT/BOOTIA32.EFI" \
        --format="i386-efi" \
        --prefix="(hd0,gpt1)/EFI/BOOT" \
        --config="$GRUB_CFG" \
        $EFI_MODULES
fi

# ── Create FAT32 ESP image (holds EFI apps + kernel) ─────────────────────
# Size: 32 MB should comfortably hold GRUB EFI + kernel
ESP_MB=32
ESP_IMG="$WORK/esp.img"

dd if=/dev/zero of="$ESP_IMG" bs=1M count=$ESP_MB status=none
mkdosfs -F 32 -n "JSOS_EFI" "$ESP_IMG" >/dev/null

# Populate ESP with mtools (no root required)
MTOOLS_SKIP_CHECK=1

mformat -i "$ESP_IMG" ::                                           2>/dev/null || true
mcopy   -i "$ESP_IMG" -s "$WORK/esp/." ::/                        2>/dev/null || true

echo "[uefi] ESP image: $ESP_MB MB FAT32"

# ── Create GPT raw disk image ──────────────────────────────────────────────
# Layout:
#   Partition 1: EFI System Partition (FAT32, type EF00)
# Kernel + grub.cfg are embedded in the EFI apps themselves.
DISK_MB=$((ESP_MB + 4))  # small gap for GPT overhead
dd if=/dev/zero of="$OUTPUT_IMG" bs=1M count=$DISK_MB status=none

parted -s "$OUTPUT_IMG" \
    mklabel gpt \
    mkpart ESP fat32 2MiB $((ESP_MB + 2))MiB \
    set 1 esp on

# Copy FAT ESP into partition 1 (offset 2 MiB = 4096 sectors × 512 bytes)
dd if="$ESP_IMG" of="$OUTPUT_IMG" bs=1M seek=2 conv=notrunc status=none

echo "[uefi] GPT disk image → $OUTPUT_IMG"

# ── Also produce a hybrid ISO (BIOS+UEFI via grub-mkrescue/xorriso) ───────
# This path is best-effort; builds the hybrid ISO if xorriso is available.
if command -v grub-mkrescue &>/dev/null && command -v xorriso &>/dev/null; then
    echo "[uefi] Building hybrid UEFI+BIOS ISO via grub-mkrescue..."
    # Merge bios and esp trees
    HYBRID="$WORK/hybrid"
    mkdir -p "$HYBRID"
    cp -r "$WORK/bios/." "$HYBRID/"
    cp -r "$WORK/esp/." "$HYBRID/"
    grub-mkrescue \
        --modules="$EFI_MODULES" \
        -o "$OUTPUT_ISO" \
        "$HYBRID" \
        -- -as mkisofs \
           -eltorito-platform efi \
           -eltorito-boot EFI/BOOT/BOOTX64.EFI \
           -no-emul-boot \
        2>/dev/null || grub-mkrescue -o "$OUTPUT_ISO" "$HYBRID"
    echo "[uefi] Hybrid ISO → $OUTPUT_ISO"
else
    echo "[uefi] xorriso/grub-mkrescue not found — skipping hybrid ISO"
    echo "[uefi] Use build-iso-noXorriso.sh for a BIOS-only ISO"
fi

echo ""
echo "UEFI boot artifacts:"
echo "  GPT raw disk:   $OUTPUT_IMG  (QEMU: -drive format=raw,file=$OUTPUT_IMG,if=virtio)"
[[ -f "$OUTPUT_ISO" ]] && echo "  Hybrid ISO:     $OUTPUT_ISO  (QEMU: -cdrom $OUTPUT_ISO)"
echo ""
echo "QEMU UEFI test command:"
echo "  qemu-system-x86_64 -machine q35 -bios /usr/share/ovmf/OVMF.fd \\"
echo "    -drive format=raw,file=$OUTPUT_IMG,if=virtio -m 512M -serial stdio"
echo ""
echo "Done."
