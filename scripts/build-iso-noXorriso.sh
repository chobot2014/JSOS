#!/bin/bash
#
# build-iso-noXorriso.sh — Item 2: GRUB2 native boot without xorriso
#
# Creates a bootable JSOS ISO using grub-mkimage (El Torito cdrom format)
# and genisoimage/mkisofs as the ISO writer — no xorriso dependency.
#
# Usage:  ./scripts/build-iso-noXorriso.sh [output.iso]
#
# Requirements (all provided by grub-pc-bin + genisoimage):
#   grub-mkimage    — creates core.img for El Torito / cdrom boot
#   grub-mknetdir   — (optional, for PXE variant)
#   genisoimage     — creates the ISO 9660 image (apt: genisoimage)
#   mkisofs         — fallback if genisoimage is absent (usually the same binary)
#   mtools          — only needed for EFI variant; not required here
#
# The strategy:
#   1.  grub-mkimage -O i386-pc-eltorito → stage2 El Torito boot image
#   2.  grub-mkimage -O i386-pc          → cdboot.img (no 1.44 floppy emul)
#   3.  genisoimage -b ...              → ISO 9660 + El Torito boot catalog
#
# This produces a BIOS-bootable ISO that does NOT require xorriso.
#
set -euo pipefail

OUTPUT_ISO="${1:-build/jsos-noXorriso.iso}"
WORK="build/iso-noxorriso-work"
KERNEL="src/kernel/jsos.bin"

# ── Sanity checks ──────────────────────────────────────────────────────────
if [[ ! -f "$KERNEL" ]]; then
    echo "ERROR: Kernel not found at $KERNEL — run 'make' in src/kernel first."
    exit 1
fi

# Prefer genisoimage; fall back to mkisofs (both accept identical flags).
ISO_MAKER=""
for cmd in genisoimage mkisofs; do
    if command -v "$cmd" &>/dev/null; then
        ISO_MAKER="$cmd"
        break
    fi
done
if [[ -z "$ISO_MAKER" ]]; then
    echo "ERROR: Neither genisoimage nor mkisofs found."
    echo "Install with: apt-get install genisoimage  OR  apt-get install mkisofs"
    exit 1
fi

if ! command -v grub-mkimage &>/dev/null; then
    echo "ERROR: grub-mkimage not found. Install grub-pc-bin."
    exit 1
fi

# ── Build directory layout ─────────────────────────────────────────────────
rm -rf "$WORK"
mkdir -p "$WORK/boot/grub"
mkdir -p "$WORK/boot/boot-catalog"

# Copy kernel and grub config.
cp "$KERNEL" "$WORK/boot/jsos.bin"
cp iso/grub.cfg "$WORK/boot/grub/grub.cfg"

# ── Step 1: core.img — GRUB2 core for El Torito ───────────────────────────
# Modules needed for Multiboot2 boot from CDROM:
#   biosdisk  — low-level BIOS disk access
#   part_gpt  — GPT partition reading (future-proof)
#   iso9660   — read ISO 9660 filesystem inside core
#   multiboot2 — load Multiboot2 kernel
#   normal    — normal GRUB menu
#   configfile — read grub.cfg
#   loopback  — loop device (optional)
GRUB_MODULES="biosdisk iso9660 part_gpt part_msdos normal configfile multiboot2 echo font terminal"

CORE_IMG="$WORK/boot/grub/core.img"

grub-mkimage \
    --output="$CORE_IMG" \
    --format="i386-pc-eltorito" \
    --prefix="(cd)/boot/grub" \
    $GRUB_MODULES

echo "[build-iso] grub-mkimage produced $(stat -c %s "$CORE_IMG") byte core.img"

# ── Step 2: Create ISO 9660 + El Torito catalog ───────────────────────────
#
# Flags:
#   -R  : Rockridge extensions (long filenames, permissions)
#   -J  : Joliet extensions (Windows compatibility)
#   -l  : allow 31-char filenames
#   -b  : El Torito boot image path (relative to ISO root)
#   -c  : El Torito boot catalog path
#   -no-emul-boot : raw binary boot (no floppy/HDD emulation)
#   -boot-load-size 4 : number of 512-byte sectors to load
#   -boot-info-table  : patch boot image with ISO geometry (sector/size info)
#   -o  : output ISO file

$ISO_MAKER \
    -R -J -l \
    -V "JSOS" \
    -b "boot/grub/core.img" \
    -c "boot/boot-catalog/boot.cat" \
    -no-emul-boot \
    -boot-load-size 4 \
    -boot-info-table \
    -o "$OUTPUT_ISO" \
    "$WORK"

echo "[build-iso] Created $OUTPUT_ISO ($(stat -c %s "$OUTPUT_ISO") bytes)"
echo "[build-iso] BIOS-bootable ISO with GRUB2 (no xorriso dependency) — done."
