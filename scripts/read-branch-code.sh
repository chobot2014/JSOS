#!/bin/bash
set -e
cd /opt/quickjs

echo "=== BRANCH IMPLEMENTATION (lines 18425-18530) ==="
sed -n '18425,18530p' quickjs.c

echo ""
echo "=== get_u32 / get_u16 / get_i8 macros ==="
grep -n 'static.*get_u32\|#define get_u32\|static.*get_u16\|#define get_u16\|static.*get_i8\|#define get_i8\|static.*get_u8\|#define get_u8' quickjs.c | head -10

echo ""
echo "=== get_u32 definition ==="
grep -n -A 5 'get_u32' quickjs.c | head -15

echo ""
echo "=== JS_CallInternal signature and first 20 lines ==="
sed -n '17356,17400p' quickjs.c

echo ""
echo "=== emit_goto function ==="
grep -n -A 15 'static int emit_goto' quickjs.c | head -20
