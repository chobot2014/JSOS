/*
 * multimon.c — Multi-monitor / display output management (items 73-76)
 *
 * All implementations are stubs. Real GPU-driver support (VirtIO-GPU 3D,
 * Intel iGPU modesetting) would replace these with MMIO register programming.
 */
#include "multimon.h"
#include "platform.h"
#include <stddef.h>

/* Primary display is always present (from multiboot2 framebuffer tag). */
static multimon_display_t _displays[MULTIMON_MAX_DISPLAYS];
static int _display_count = 0;

int multimon_init(void) {
    /* Populate display 0 from the platform framebuffer info */
    fb_info_t fb;
    platform_fb_get_info(&fb);

    _displays[0].id          = 0;
    _displays[0].active      = 1;
    _displays[0].width       = (uint16_t)fb.width;
    _displays[0].height      = (uint16_t)fb.height;
    _displays[0].bpp         = (uint8_t)fb.bpp;
    _displays[0].hdmi_audio  = 0;  /* stub: no HDMI audio detected */
    _display_count = 1;

    /* Displays 1-3 are stub entries (not connected). */
    for (int i = 1; i < MULTIMON_MAX_DISPLAYS; i++) {
        _displays[i].id     = (uint8_t)i;
        _displays[i].active = 0;
    }

    platform_boot_print("[MULTIMON] 1 display (primary only, stub)\n");
    return 1;
}

int multimon_count(void) { return _display_count; }

int multimon_get_info(uint8_t id, multimon_display_t *out) {
    if (id >= MULTIMON_MAX_DISPLAYS || !out) return -1;
    *out = _displays[id];
    return 0;
}

int multimon_set_resolution(uint8_t id, uint16_t w, uint16_t h, uint8_t bpp) {
    /* Stub: VirtIO-GPU 3D or VESA real driver needed for modesetting. */
    if (id >= MULTIMON_MAX_DISPLAYS || !_displays[id].active) return -1;
    _displays[id].width  = w;
    _displays[id].height = h;
    _displays[id].bpp    = bpp;
    (void)w; (void)h; (void)bpp;
    return 0;   /* OK as far as stub is concerned */
}

/* ── KMS stub ────────────────────────────────────────────────────────────── */
int kms_modesetting_available(void) { return 0; }
int kms_set_mode(uint8_t display, uint32_t mode_id) {
    (void)display; (void)mode_id; return -1; }

/* ── HDMI audio stub ─────────────────────────────────────────────────────── */
int hdmi_audio_present(uint8_t display) { (void)display; return 0; }
int hdmi_audio_enable(uint8_t display)  { (void)display; return -1; }
