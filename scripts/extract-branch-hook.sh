#!/bin/bash
set -e
cd /opt/quickjs

echo "=== BRANCH OFFSET HANDLING (OP_goto, OP_if_false, OP_if_true) ==="
grep -n 'OP_goto\b\|OP_if_false\b\|OP_if_true\b\|CASE(OP_goto)\|CASE(OP_if_false)\|CASE(OP_if_true)' quickjs.c | head -40

echo ""
echo "=== GOTO8/GOTO16 HANDLING ==="
grep -n 'OP_goto8\|OP_goto16\|OP_if_false8\|OP_if_true8' quickjs.c | head -20

echo ""
echo "=== get_u32 / get_i32 for branch offset ==="
grep -n 'get_u32\|get_i32' quickjs.c | head -15

echo ""
echo "=== JS_CallInternal function signature ==="
grep -n 'JS_CallInternal' quickjs.c | head -10

echo ""
echo "=== call_count / jit_count / hot ==="
grep -n 'call_count\|jit_count\|hot_count\|exec_count' quickjs.c | head -20

echo ""
echo "=== CASE macro definition ==="
grep -n '#define CASE\|#define SWITCH' quickjs.c | head -5
