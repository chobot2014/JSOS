/*
 * JSOS CPUID Feature Detection  (item 8)
 *
 * Probes the processor's CPUID leaf for the flags needed by the OS kernel.
 * Call cpuid_detect() once at boot; thereafter query cpuid_features.
 *
 * C code only — no OS logic here, just raw CPUID instruction access.
 */

#ifndef CPUID_H
#define CPUID_H

#include <stdint.h>

typedef struct {
    /* Basic feature flags from CPUID leaf 1, ECX */
    uint8_t sse3;       /* bit 0  — SSE3 / Prescott New Instructions       */
    uint8_t ssse3;      /* bit 9  — Supplemental SSE3                      */
    uint8_t sse41;      /* bit 19 — SSE 4.1                                */
    uint8_t sse42;      /* bit 20 — SSE 4.2                                */
    uint8_t popcnt;     /* bit 23 — POPCNT instruction                     */
    uint8_t aes;        /* bit 25 — AES-NI                                 */
    uint8_t avx;        /* bit 28 — Advanced Vector Extensions             */
    uint8_t rdrand;     /* bit 30 — RDRAND instruction                     */
    /* Basic feature flags from CPUID leaf 1, EDX */
    uint8_t tsc;        /* bit 4  — Time Stamp Counter                     */
    uint8_t pae;        /* bit 6  — Physical Address Extension             */
    uint8_t apic;       /* bit 9  — On-chip APIC                           */
    uint8_t mtrr;       /* bit 12 — Memory Type Range Registers            */
    uint8_t sse;        /* bit 25 — SSE                                    */
    uint8_t sse2;       /* bit 26 — SSE2                                   */
    uint8_t htt;        /* bit 28 — Hyper-Threading Technology             */
    /* Extended feature flags from CPUID leaf 0x80000001, EDX */
    uint8_t nx;         /* bit 20 — No-Execute / XD page protection bit    */
    uint8_t rdtscp;     /* bit 27 — RDTSCP instruction                     */
    uint8_t lm;         /* bit 29 — Long Mode (64-bit capable)             */
    /* CPU identification */
    uint32_t max_leaf;          /* highest basic CPUID leaf                */
    uint32_t max_ext_leaf;      /* highest extended CPUID leaf             */
    char vendor[13];            /* null-terminated, e.g. "GenuineIntel"   */
    uint8_t family;             /* CPUID family                            */
    uint8_t model;              /* CPUID model                             */
    uint8_t stepping;           /* CPUID stepping                          */
} cpuid_features_t;

/* Populated by cpuid_detect().  Safe to read after that call. */
extern cpuid_features_t cpuid_features;

/**
 * Run CPUID leaf 0, 1 and 0x80000001, populate cpuid_features.
 * Must be called once before any feature test.
 */
void cpuid_detect(void);

#endif /* CPUID_H */
