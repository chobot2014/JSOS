# JSOS Licenses
**Items 910-911 — License audit and third-party notices**

## JSOS License

Copyright (c) 2024 JSOS Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Third-Party Components

### QuickJS
- **License:** MIT
- **Copyright:** 2017-2021 Fabrice Bellard and Charlie Gordon
- **URL:** https://bellard.org/quickjs/
- **Use in JSOS:** Embedded JavaScript runtime (src/kernel/quickjs_binding.c)

### GRUB 2
- **License:** GNU General Public License v3.0
- **Copyright:** 1999-2023 Free Software Foundation
- **URL:** https://www.gnu.org/software/grub/
- **Use in JSOS:** Bootloader (iso/grub.cfg, iso/grub-uefi.cfg)

### Mozilla Root CA Bundle
- **License:** Mozilla Public License 2.0
- **Copyright:** Mozilla Foundation
- **URL:** https://curl.se/docs/caextract.html
- **Use in JSOS:** TLS certificate validation

### BibleText (King James Version)
- **License:** Public Domain
- **URL:** https://www.gutenberg.org/ebooks/10
- **Use in JSOS:** Test resource for large-file I/O benchmarks (resources/bible.txt)

### OVMF (UEFI firmware for QEMU)
- **License:** BSD 2-Clause
- **Copyright:** TianoCore Contributors
- **URL:** https://www.tianocore.org/
- **Use in JSOS:** Optional UEFI firmware for testing (not distributed)

---

## Copyright Notice Template

All JSOS source files should contain the following header:

```
// Copyright (c) 2024 JSOS Contributors
// SPDX-License-Identifier: MIT
```

C files:

```c
/* Copyright (c) 2024 JSOS Contributors
 * SPDX-License-Identifier: MIT
 */
```

---

## SPDX Summary

| Component          | SPDX ID    |
|--------------------|-----------|
| JSOS source code   | MIT        |
| QuickJS            | MIT        |
| GRUB 2             | GPL-3.0    |
| Mozilla Root CAs   | MPL-2.0    |
| Bible text         | Public Domain |
| OVMF               | BSD-2-Clause |
