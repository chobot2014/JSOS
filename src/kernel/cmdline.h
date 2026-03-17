/*
 * JSOS Boot Command-Line Parser  (item 4)
 *
 * Parses the kernel command line string provided by GRUB via the Multiboot2
 * cmdline tag (type 1).  Parameters are space-separated key=value or bare
 * key tokens.
 *
 * Usage:
 *   cmdline_parse(mb2_info_addr);  // called once at boot
 *   const char *root = cmdline_get("root");  // NULL if not present
 *   int quiet = cmdline_has("quiet");
 */

#ifndef CMDLINE_H
#define CMDLINE_H

#include <stdint.h>

/**
 * Parse the kernel command line from the Multiboot2 boot info block.
 * Must be called once before any cmdline_get / cmdline_has calls.
 * Safe to call with 0 if no MB2 info is available.
 */
void cmdline_parse(uint32_t mb2_info_addr);

/**
 * Return the value string for a key=value parameter, or NULL if the key
 * is absent or has no '=' assignment.  The returned pointer is into the
 * internal static buffer — do not free.
 */
const char *cmdline_get(const char *key);

/**
 * Return 1 if the bare flag 'key' (or 'key=...') is present, 0 otherwise.
 */
int cmdline_has(const char *key);

/** Return the raw command-line string (empty string if not set). */
const char *cmdline_raw(void);

#endif /* CMDLINE_H */
