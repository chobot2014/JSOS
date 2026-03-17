/*
 * multimon.h — Multi-monitor / display output management (items 73-76)
 *
 * Items covered:
 *   73 — Multi-monitor support: enumerate and address secondary displays
 *   74 — Runtime display resolution change
 *   75 — Kernel Mode Setting (KMS) stub for modesetting drivers
 *   76 — HDMI audio co-driver stub
 *
 * All functions are stubs for future GPU driver integration; the API surface
 * is defined here so TypeScript can call kernel.multimonXxx().
 */
#ifndef MULTIMON_H
#define MULTIMON_H

#include <stdint.h>

/* Maximum displays we track (stub supports up to 4). */
#define MULTIMON_MAX_DISPLAYS  4

/* Display info record returned by multimon_get_info(). */
typedef struct {
    uint8_t  id;         /* 0-based display index */
    uint8_t  active;     /* 1 if connected and active */
    uint16_t width;      /* horizontal resolution in pixels */
    uint16_t height;     /* vertical resolution in pixels */
    uint8_t  bpp;        /* bits per pixel */
    uint8_t  hdmi_audio; /* 1 if HDMI audio output is functional */
} multimon_display_t;

/* ── API ─────────────────────────────────────────────────────────────────── */

/* multimon_init() — probe displays; always succeeds with stub (returns 1). */
int multimon_init(void);

/* multimon_count() — number of active displays detected. */
int multimon_count(void);

/* multimon_get_info(id, out) — fill *out for display <id>.
 * Returns 0 on success, -1 if id out of range. */
int multimon_get_info(uint8_t id, multimon_display_t *out);

/* multimon_set_resolution(id, w, h, bpp) — request mode change.
 * Stub: records goal and returns 0; real implementation talks to GPU. */
int multimon_set_resolution(uint8_t id, uint16_t w, uint16_t h, uint8_t bpp);

/* ── KMS stub (item 75) ──────────────────────────────────────────────────── */

/* kms_modesetting_available() — returns 0 (stub; real GPU driver needed). */
int kms_modesetting_available(void);

/* kms_set_mode(display, mode_id) — stub; returns -1 until real driver. */
int kms_set_mode(uint8_t display, uint32_t mode_id);

/* ── HDMI audio stub (item 76) ───────────────────────────────────────────── */

/* hdmi_audio_present(display) — returns 0 in stub. */
int hdmi_audio_present(uint8_t display);

/* hdmi_audio_enable(display) — stub; returns -1. */
int hdmi_audio_enable(uint8_t display);

#endif /* MULTIMON_H */
