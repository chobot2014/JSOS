#!/bin/bash
set -e
cd /opt/quickjs

echo "=== get_u32 DEFINITION ==="
grep -n -B 2 'get_u32' quickjs.c | head -20

echo ""
echo "=== Searching in quickjs.h or cutils.h ==="
grep -rn 'get_u32\|get_u16\|get_u8' cutils.h | head -10
grep -rn 'get_u32\|get_u16\|get_u8' quickjs.h | head -10

echo ""
echo "=== JS_CallInternal after bytecode setup (lines 17396-17470) ==="
sed -n '17396,17470p' quickjs.c

echo ""
echo "=== JSFunctionBytecode struct (check for call_count etc) ==="
sed -n '620,660p' quickjs.c
