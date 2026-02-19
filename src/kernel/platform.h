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
void platform_fb_blit(const uint32_t *src, int x, int y, int w, int h);

#endif /* PLATFORM_H */
