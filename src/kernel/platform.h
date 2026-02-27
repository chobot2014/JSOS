#ifndef PLATFORM_H
#define PLATFORM_H

#include <stdint.h>

/* ── Multiboot2 tag structures ──────────────────────────────────────────── */

#define MULTIBOOT2_BOOTLOADER_MAGIC 0x36d76289

/* Generic tag header */
typedef struct {
    uint32_t type;
    uint32_t size;
} mb2_tag_t;

/* Type 8 — framebuffer info */
typedef struct {
    uint32_t type;          /* = 8 */
    uint32_t size;
    uint64_t framebuffer_addr;
    uint32_t framebuffer_pitch;
    uint32_t framebuffer_width;
    uint32_t framebuffer_height;
    uint8_t  framebuffer_bpp;
    uint8_t  framebuffer_type; /* 1=RGB, 0=indexed, 2=EGA text */
    uint16_t reserved;
} mb2_tag_framebuffer_t;

/* ── Framebuffer descriptor ─────────────────────────────────────────────── */

typedef struct {
    uint32_t *address;      /* physical framebuffer mapping */
    uint32_t  width;
    uint32_t  height;
    uint32_t  pitch;        /* bytes per row */
    uint8_t   bpp;          /* bits per pixel */
    uint8_t   available;    /* 1 if framebuffer was negotiated by GRUB */
} fb_info_t;

/* Initialise VGA buffer, boot-time cursor, and serial port */
void platform_init(void);

/* Initialise framebuffer from multiboot2 boot info (call after platform_init) */
void platform_fb_init(uint32_t mb2_info_addr);

/* Boot-time sequential print (before QuickJS starts) */
void platform_boot_print(const char *s);

/* Item 14: Boot splash — VGA text-mode colour banner drawn early in boot */
void platform_boot_splash(void);

/* Serial port (COM1) — also used as stdio mirror for QEMU -serial stdio */
void platform_serial_putchar(char c);   /* single character (\n → \r\n)  */
void platform_serial_puts(const char *s);
int  platform_serial_getchar(void);     /* -1 = no data available         */

/* Raw VGA cell access ─────────────────────────────────────────────────────
 * colorByte = (bg << 4) | fg   (bg 0-7 to avoid blink)
 * vga_cell layout: bits 15-8 = color, bits 7-0 = ASCII char
 */
void     platform_vga_put(int row, int col, char ch, uint8_t color);
uint16_t platform_vga_get(int row, int col);          /* (color<<8)|ch */
void     platform_vga_draw_row(int row, const char *text, uint8_t color);
void     platform_vga_copy_row(int dst_row, int src_row);
void     platform_vga_fill_row(int row, char ch, uint8_t color);
void     platform_vga_fill(char ch, uint8_t color);

/* Hardware cursor */
void platform_cursor_set(int row, int col);
void platform_cursor_show(void);
void platform_cursor_hide(void);

/* Screen dimensions */
int platform_vga_width(void);   /* 80 */
int platform_vga_height(void);  /* 25 */

/* Framebuffer access ───────────────────────────────────────────────────── */

/* Get framebuffer info (address, size, bpp).  available=0 → no framebuffer. */
void platform_fb_get_info(fb_info_t *out);

/* Copy pixel data (BGRA, w*h*4 bytes) to framebuffer at (x,y).
 * No-op if framebuffer not available. */

/* TSS (Task State Segment) — Phase 5 ─────────────────────────────────────
 * Used so the CPU knows which kernel stack to switch to on ring-3→ring-0
 * transitions (Phase 6+).  Phase 5 initialises the structure; Phase 9 loads TR.
 */
void platform_tss_init(void);
void platform_tss_set_esp0(uint32_t kernel_stack_top);
/* Install the TSS into GDT slot 5 (0x28) and execute ltr.  [Phase 9] */
void platform_gdt_install_tss(void);
void platform_fb_blit(const uint32_t *src, int x, int y, int w, int h);

/**
 * Kernel panic: print message to serial then halt permanently.
 * Never returns.
 */
void platform_panic(const char *msg) __attribute__((noreturn));

/* ── MTRR write-combine (item 67) ──────────────────────────────────────── */
/**
 * Configure an MTRR to map a physical address range as Write-Combining (WC).
 * Call after framebuffer is known (platform_fb_init) to accelerate DMA-style
 * linear blits.  No-op if MTRR or CPUID not available.
 */
void platform_mtrr_set_wc(uint32_t phys_base, uint32_t size);

/* ── VBE / EDID stub (item 66) ──────────────────────────────────────────── */
/**
 * Return EDID preferred display resolution from Multiboot2 framebuffer tag.
 * On JSOS the bootloader (GRUB) handles VBE mode selection; we simply read
 * the negotiated mode back from the MB2 framebuffer tag.
 * Returns 0 on success, -1 if no framebuffer info available.
 */
int platform_edid_get_preferred(uint32_t *out_w, uint32_t *out_h);

/* ── Double-buffered framebuffer (item 70) ──────────────────────────────── */
/**
 * Allocate a software back-buffer of the same dimensions as the primary FB.
 * Subsequent calls to platform_fb_blit() write to the back-buffer.
 * Returns 0 on success, -1 on out-of-memory.
 */
int platform_fb_alloc_backbuffer(void);

/**
 * Flip (synchronously copy) the back-buffer to the primary framebuffer.
 * Equivalent to XCopyArea from back to front.  Called by the compositor.
 */
void platform_fb_flip(void);

/**
 * Return a pointer to the start of the current back-buffer (or the primary
 * FB if no back-buffer was allocated).  TypeScript compositor writes pixels
 * here via kernel.mapMemory / typed-array overlays.
 */
uint32_t platform_fb_backbuffer_addr(void);

/* ── VGA retrace / vsync (item 71) ─────────────────────────────────────── */
/**
 * Spin-wait until the VGA display is in vertical blank (bit 3 of 0x3DA).
 * Use before platform_fb_flip() to eliminate tearing on VGA-compatible modes.
 * On virtio-GPU this is a no-op (GPU handles vsync internally).
 * Typical maximum wait = 1/60 s ≈ 16.7 ms.
 */
void platform_vsync_wait(void);

/* ── Hardware cursor (item 69) ──────────────────────────────────────────── */
/**
 * Enable or disable the VGA text-mode hardware cursor.
 * In graphical modes the cursor is drawn in software by the compositor.
 */
void platform_cursor_enable(int enable);

/**
 * Set the VGA text-mode cursor position (column and row, 0-based).
 */
void platform_cursor_set_pos(uint8_t col, uint8_t row);

/**
 * Set the cursor shape: scan lines [start, end] within a character cell
 * (0–15).  Use [14,15] for an underline cursor; [0,15] for block.
 */
void platform_cursor_set_shape(uint8_t start_line, uint8_t end_line);

/* ── VESA display power management (DPMS) — item 72 ────────────────────── */
typedef enum {
    DPMS_ON      = 0,   /* normal operation */
    DPMS_STANDBY = 1,   /* standby (power-save level 1) */
    DPMS_SUSPEND = 2,   /* suspend (power-save level 2) */
    DPMS_OFF     = 3,   /* display off (deepest power save) */
} dpms_state_t;

/**
 * Set VESA DPMS state by writing the VGA feature-control register (0x3DA)
 * and the appropriate HSYNC/VSYNC blanking bits.
 * On virtio-GPU / VBE modes this controls the blanking period via port 0x3C0.
 */
void platform_dpms_set(dpms_state_t state);

#endif /* PLATFORM_H */

