import re
import sys

with open("/opt/quickjs/quickjs-opcode.h") as f:
    lines = f.read()

idx = 0
for line in lines.split("\n"):
    line = line.strip()
    m = re.match(r'(?:DEF|def)\s*\(\s*(\w+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\w+)', line)
    if m:
        name, size, npop, npush, fmt = m.groups()
        print(f"{idx}\t0x{idx:02X}\tOP_{name}\tsize={size}\tpop={npop}\tpush={npush}\tfmt={fmt}")
        idx += 1
