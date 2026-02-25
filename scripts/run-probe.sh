#!/bin/bash
set -e
cd /opt/quickjs
# Define format macros missing in freestanding mode, then quickjs.c, then probe
cat > /tmp/qjs_probe.c <<'HEADER'
#ifndef __STDC_FORMAT_MACROS
#define __STDC_FORMAT_MACROS
#endif
#ifndef PRId64
#define PRId64 "lld"
#endif
#ifndef PRIu64
#define PRIu64 "llu"
#endif
#ifndef PRIx64
#define PRIx64 "llx"
#endif
HEADER
cat quickjs.c >> /tmp/qjs_probe.c
cat /tmp/scripts/probe-offsets.c >> /tmp/qjs_probe.c
i686-elf-gcc -m32 -ffreestanding -O2 -w -I. -DCONFIG_VERSION='"2025"' -c /tmp/qjs_probe.c -o /tmp/qjs_probe.o
echo "COMPILE_OK"
# Dump the actual values from .rodata
i686-elf-objdump -s -j .rodata /tmp/qjs_probe.o > /tmp/rodata_dump.txt
# Get symbol table to map names to addresses
i686-elf-nm /tmp/qjs_probe.o | grep -E 'off_|sz_' | sort > /tmp/symbols.txt
echo "=== SYMBOLS ==="
cat /tmp/symbols.txt
echo "=== RODATA AROUND OFFSETS ==="
# Dump last portion of rodata where our constants live
tail -20 /tmp/rodata_dump.txt
