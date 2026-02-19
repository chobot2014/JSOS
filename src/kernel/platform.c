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
