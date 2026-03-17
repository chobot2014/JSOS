#!/bin/bash
set -e
cd /opt/quickjs

# Build the probe
cat > /tmp/qjs_probe.c <<'HEADER'
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

# Dump full rodata, then filter for our offset range (0x2e10 through 0x2e5f)
i686-elf-objdump -s -j .rodata /tmp/qjs_probe.o | grep -E '^ 2e[0-5]'
