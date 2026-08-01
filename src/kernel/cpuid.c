/*
 * JSOS CPUID Feature Detection  (item 8)
 *
 * Executes CPUID leaves 0, 1 and 0x80000001 and fills cpuid_features.
 * C code — direct hardware access, no OS logic.
 */

#include "cpuid.h"
#include <string.h>

cpuid_features_t cpuid_features;

/* ── Helper: execute CPUID ────────────────────────────────────────────────── */
static void do_cpuid(uint32_t leaf, uint32_t *eax_out, uint32_t *ebx_out,
                     uint32_t *ecx_out, uint32_t *edx_out) {
    uint32_t eax = leaf, ebx = 0, ecx = 0, edx = 0;
    __asm__ volatile (
        "cpuid"
        : "=a"(eax), "=b"(ebx), "=c"(ecx), "=d"(edx)
        : "0"(leaf), "2"(0)
    );
    if (eax_out) *eax_out = eax;
    if (ebx_out) *ebx_out = ebx;
    if (ecx_out) *ecx_out = ecx;
    if (edx_out) *edx_out = edx;
}

void cpuid_detect(void) {
    uint32_t eax, ebx, ecx, edx;

    /* ── Leaf 0: max basic leaf + vendor string ──────────────────────────── */
    do_cpuid(0, &eax, &ebx, &ecx, &edx);
    cpuid_features.max_leaf = eax;
    /* Vendor string: EBX–EDX–ECX, 4 bytes each, not null-terminated by CPU */
    char *v = cpuid_features.vendor;
    v[0]  = (char)( ebx        & 0xFF); v[1]  = (char)((ebx >>  8) & 0xFF);
    v[2]  = (char)((ebx >> 16) & 0xFF); v[3]  = (char)((ebx >> 24) & 0xFF);
    v[4]  = (char)( edx        & 0xFF); v[5]  = (char)((edx >>  8) & 0xFF);
    v[6]  = (char)((edx >> 16) & 0xFF); v[7]  = (char)((edx >> 24) & 0xFF);
    v[8]  = (char)( ecx        & 0xFF); v[9]  = (char)((ecx >>  8) & 0xFF);
    v[10] = (char)((ecx >> 16) & 0xFF); v[11] = (char)((ecx >> 24) & 0xFF);
    v[12] = '\0';

    if (cpuid_features.max_leaf < 1) return;  /* very old CPU, no features */

    /* ── Leaf 1: feature flags ───────────────────────────────────────────── */
    do_cpuid(1, &eax, &ebx, &ecx, &edx);

    cpuid_features.stepping = (uint8_t)( eax        & 0x0F);
    cpuid_features.model    = (uint8_t)((eax >>  4) & 0x0F);
    cpuid_features.family   = (uint8_t)((eax >>  8) & 0x0F);

    /* ECX flags */
    cpuid_features.sse3   = (uint8_t)((ecx >>  0) & 1);
    cpuid_features.ssse3  = (uint8_t)((ecx >>  9) & 1);
    cpuid_features.sse41  = (uint8_t)((ecx >> 19) & 1);
    cpuid_features.sse42  = (uint8_t)((ecx >> 20) & 1);
    cpuid_features.popcnt = (uint8_t)((ecx >> 23) & 1);
    cpuid_features.aes    = (uint8_t)((ecx >> 25) & 1);
    cpuid_features.avx    = (uint8_t)((ecx >> 28) & 1);
    cpuid_features.rdrand = (uint8_t)((ecx >> 30) & 1);

    /* EDX flags */
    cpuid_features.tsc  = (uint8_t)((edx >>  4) & 1);
    cpuid_features.pae  = (uint8_t)((edx >>  6) & 1);
    cpuid_features.apic = (uint8_t)((edx >>  9) & 1);
    cpuid_features.mtrr = (uint8_t)((edx >> 12) & 1);
    cpuid_features.sse  = (uint8_t)((edx >> 25) & 1);
    cpuid_features.sse2 = (uint8_t)((edx >> 26) & 1);
    cpuid_features.htt  = (uint8_t)((edx >> 28) & 1);

    /* ── Extended leaf 0x80000000: max extended leaf ─────────────────────── */
    do_cpuid(0x80000000u, &eax, &ebx, &ecx, &edx);
    cpuid_features.max_ext_leaf = eax;

    if (cpuid_features.max_ext_leaf < 0x80000001u) return;

    /* ── Extended leaf 0x80000001: NX/XD, RDTSCP, LM ───────────────────── */
    do_cpuid(0x80000001u, &eax, &ebx, &ecx, &edx);
    cpuid_features.nx     = (uint8_t)((edx >> 20) & 1);
    cpuid_features.rdtscp = (uint8_t)((edx >> 27) & 1);
    cpuid_features.lm     = (uint8_t)((edx >> 29) & 1);
}
