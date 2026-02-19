/*
 * JSOS Platform Layer
 *
 * Minimal VGA text-mode hardware abstraction. This is the ONLY place that
 * touches the VGA buffer (0xB8000) or the cursor control registers.
 *
 * All higher-level terminal behaviour — character processing, scrolling,
 * colour state, scrollback buffer, readline — lives in TypeScript.
 *
 * Serial port (COM1, 0x3F8) mirrors all output so QEMU -serial stdio works.
 */

#include <stddef.h>
#include <stdint.h>
#include "io.h"
#include "platform.h"

#define VGA_WIDTH  80
#define VGA_HEIGHT 25

static uint16_t * const vga = (uint16_t *)0xB8000;

/* ── Serial port (COM1) ─────────────────────────────────────────────────── */

#define COM1 0x3F8

static void serial_init(void) {
    outb(COM1 + 1, 0x00); /* disable interrupts                          */
    outb(COM1 + 3, 0x80); /* enable DLAB to set baud divisor             */
    outb(COM1 + 0, 0x01); /* divisor = 1 → 115200 baud (lo byte)        */
    outb(COM1 + 1, 0x00); /*                             (hi byte)       */
    outb(COM1 + 3, 0x03); /* 8-N-1                                       */
    outb(COM1 + 2, 0xC7); /* enable FIFO, clear, 14-byte threshold       */
    outb(COM1 + 4, 0x0B); /* RTS + DTR, IRQ enable                       */
}

static inline void serial_waitready(void) {
    while ((inb(COM1 + 5) & 0x20) == 0);
}

static void serial_putbyte(char c) {
    serial_waitready();
    outb(COM1, c);
}

/* Write a single character; translate \n → \r\n */
static void serial_putchar(char c) {
    if (c == '\n') serial_putbyte('\r');
    serial_putbyte(c);
}

static void serial_puts(const char *s) {
    while (*s) serial_putchar(*s++);
}

/* Public API used by JS bindings */
void platform_serial_putchar(char c) { serial_putchar(c); }
void platform_serial_puts(const char *s) { serial_puts(s); }

int platform_serial_getchar(void) {
    if (inb(COM1 + 5) & 0x01) return (int)(unsigned char)inb(COM1);
    return -1; /* no data */
}


/* ── Helpers ─────────────────────────────────────────────────────────────── */

static inline uint16_t vga_cell(uint8_t ch, uint8_t color) {
    return (uint16_t)ch | ((uint16_t)color << 8);
}

static void hw_cursor_update(int row, int col) {
    uint16_t pos = (uint16_t)(row * VGA_WIDTH + col);
    outb(0x3D4, 0x0F); outb(0x3D5, (uint8_t)(pos & 0xFF));
    outb(0x3D4, 0x0E); outb(0x3D5, (uint8_t)(pos >> 8));
}

static void hw_cursor_enable(void) {
    outb(0x3D4, 0x0A); outb(0x3D5, (inb(0x3D5) & 0xC0) | 14);
    outb(0x3D4, 0x0B); outb(0x3D5, (inb(0x3D5) & 0xE0) | 15);
}

/* ── Boot-time sequential printer ────────────────────────────────────────── */
/* Used before QuickJS starts; manages its own cursor state. */

static int boot_row = 0, boot_col = 0;

static void boot_scroll(void) {
    for (int r = 0; r < VGA_HEIGHT - 1; r++)
        for (int c = 0; c < VGA_WIDTH; c++)
            vga[r * VGA_WIDTH + c] = vga[(r + 1) * VGA_WIDTH + c];
    for (int c = 0; c < VGA_WIDTH; c++)
        vga[(VGA_HEIGHT - 1) * VGA_WIDTH + c] = vga_cell(' ', 0x07);
    boot_row = VGA_HEIGHT - 1;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

void platform_init(void) {
    serial_init();
    boot_row = boot_col = 0;
    for (int i = 0; i < VGA_WIDTH * VGA_HEIGHT; i++)
        vga[i] = vga_cell(' ', 0x07);
    hw_cursor_enable();
    hw_cursor_update(0, 0);
}

void platform_boot_print(const char *s) {
    serial_puts(s);   /* mirror to serial first (fast, order guaranteed) */
    while (*s) {
        char c = *s++;
        if (c == '\n') {
            boot_col = 0;
            if (++boot_row >= VGA_HEIGHT) boot_scroll();
        } else if (c == '\r') {
            boot_col = 0;
        } else {
            vga[boot_row * VGA_WIDTH + boot_col] = vga_cell((uint8_t)c, 0x07);
            if (++boot_col >= VGA_WIDTH) {
                boot_col = 0;
                if (++boot_row >= VGA_HEIGHT) boot_scroll();
            }
        }
        hw_cursor_update(boot_row, boot_col);
    }
}

void platform_vga_put(int row, int col, char ch, uint8_t color) {
    if (row < 0 || row >= VGA_HEIGHT || col < 0 || col >= VGA_WIDTH) return;
    vga[row * VGA_WIDTH + col] = vga_cell((uint8_t)ch, color);
}

uint16_t platform_vga_get(int row, int col) {
    if (row < 0 || row >= VGA_HEIGHT || col < 0 || col >= VGA_WIDTH) return 0;
    return vga[row * VGA_WIDTH + col];
}

void platform_vga_draw_row(int row, const char *text, uint8_t color) {
    if (row < 0 || row >= VGA_HEIGHT) return;
    uint16_t *dst = &vga[row * VGA_WIDTH];
    for (int c = 0; c < VGA_WIDTH; c++) {
        char ch = (text && *text) ? *text++ : ' ';
        dst[c] = vga_cell((uint8_t)ch, color);
    }
}

void platform_vga_copy_row(int dst_row, int src_row) {
    if (dst_row < 0 || dst_row >= VGA_HEIGHT) return;
    if (src_row < 0 || src_row >= VGA_HEIGHT) return;
    uint16_t *dst = &vga[dst_row * VGA_WIDTH];
    const uint16_t *src = &vga[src_row * VGA_WIDTH];
    for (int c = 0; c < VGA_WIDTH; c++) dst[c] = src[c];
}

void platform_vga_fill_row(int row, char ch, uint8_t color) {
    if (row < 0 || row >= VGA_HEIGHT) return;
    uint16_t cell = vga_cell((uint8_t)ch, color);
    uint16_t *dst = &vga[row * VGA_WIDTH];
    for (int c = 0; c < VGA_WIDTH; c++) dst[c] = cell;
}

void platform_vga_fill(char ch, uint8_t color) {
    uint16_t cell = vga_cell((uint8_t)ch, color);
    for (int i = 0; i < VGA_WIDTH * VGA_HEIGHT; i++) vga[i] = cell;
}

void platform_cursor_set(int row, int col) {
    hw_cursor_update(row, col);
}

void platform_cursor_show(void) {
    hw_cursor_enable();
}

void platform_cursor_hide(void) {
    outb(0x3D4, 0x0A);
    outb(0x3D5, 0x20); /* bit 5 = cursor off */
}

int platform_vga_width(void)  { return VGA_WIDTH;  }
int platform_vga_height(void) { return VGA_HEIGHT; }

/* ── Framebuffer ─────────────────────────────────────────────────────────── */

static fb_info_t _fb = { NULL, 0, 0, 0, 0, 0 };

/*
 * Parse multiboot2 boot information to locate the framebuffer tag (type=8).
 * Called from kernel.c after platform_init().
 * mb2_info_addr: physical address of the multiboot2 boot info structure.
 */
void platform_fb_init(uint32_t mb2_info_addr) {
    if (mb2_info_addr == 0) return;

    /* Multiboot2 info: first 8 bytes are total_size + reserved, then tags */
    uint8_t *info = (uint8_t *)(uintptr_t)mb2_info_addr;
    uint32_t total_size = *(uint32_t *)info;

    /* Walk tags */
    uint8_t *tag = info + 8;
    uint8_t *end = info + total_size;

    while (tag < end) {
        mb2_tag_t *hdr = (mb2_tag_t *)tag;

        if (hdr->type == 0) break; /* end tag */

        if (hdr->type == 8) { /* MULTIBOOT_TAG_TYPE_FRAMEBUFFER */
            mb2_tag_framebuffer_t *fbt = (mb2_tag_framebuffer_t *)tag;
            if (fbt->framebuffer_type == 1) { /* RGB mode */
                _fb.address   = (uint32_t *)(uintptr_t)(uint32_t)fbt->framebuffer_addr;
                _fb.width     = fbt->framebuffer_width;
                _fb.height    = fbt->framebuffer_height;
                _fb.pitch     = fbt->framebuffer_pitch;
                _fb.bpp       = fbt->framebuffer_bpp;
                _fb.available = 1;
            }
        }

        /* Each tag is padded to 8-byte boundary */
        uint32_t size = hdr->size;
        tag += (size + 7) & ~7u;
    }
}

void platform_fb_get_info(fb_info_t *out) {
    *out = _fb;
}

/*
 * Copy a w*h BGRA (32-bit) pixel array into the framebuffer at (x, y).
 * No-op if framebuffer is not available or bpp != 32.
 */
void platform_fb_blit(const uint32_t *src, int x, int y, int w, int h) {
    if (!_fb.available || _fb.bpp != 32) return;
    if (!_fb.address) return;
    if (x < 0 || y < 0) return;
    if ((uint32_t)x + (uint32_t)w > _fb.width)  w = (int)(_fb.width  - (uint32_t)x);
    if ((uint32_t)y + (uint32_t)h > _fb.height) h = (int)(_fb.height - (uint32_t)y);
    if (w <= 0 || h <= 0) return;

    uint32_t pitch_words = _fb.pitch / 4; /* pitch in 32-bit words */
    for (int row = 0; row < h; row++) {
        uint32_t *dst_row = _fb.address + (uint32_t)(y + row) * pitch_words + (uint32_t)x;
        const uint32_t *src_row = src + row * w;
        for (int col = 0; col < w; col++) dst_row[col] = src_row[col];
    }
}

