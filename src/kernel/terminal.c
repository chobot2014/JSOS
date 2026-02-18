#include <stddef.h>
#include <stdint.h>
#include "io.h"

/* Hardware text mode color constants. */
enum vga_color {
    VGA_COLOR_BLACK = 0,
    VGA_COLOR_BLUE = 1,
    VGA_COLOR_GREEN = 2,
    VGA_COLOR_CYAN = 3,
    VGA_COLOR_RED = 4,
    VGA_COLOR_MAGENTA = 5,
    VGA_COLOR_BROWN = 6,
    VGA_COLOR_LIGHT_GREY = 7,
    VGA_COLOR_DARK_GREY = 8,
    VGA_COLOR_LIGHT_BLUE = 9,
    VGA_COLOR_LIGHT_GREEN = 10,
    VGA_COLOR_LIGHT_CYAN = 11,
    VGA_COLOR_LIGHT_RED = 12,
    VGA_COLOR_LIGHT_MAGENTA = 13,
    VGA_COLOR_LIGHT_BROWN = 14,
    VGA_COLOR_WHITE = 15,
};

static inline uint8_t vga_entry_color(enum vga_color fg, enum vga_color bg) {
    return fg | bg << 4;
}

static inline uint16_t vga_entry(unsigned char uc, uint8_t color) {
    return (uint16_t) uc | (uint16_t) color << 8;
}

#define VGA_WIDTH  80
#define VGA_HEIGHT 25

size_t terminal_row;
size_t terminal_column;
uint8_t terminal_color;
uint16_t* terminal_buffer;

/* ─── Scrollback buffer ──────────────────────────────────────────────────── */
#define SCROLLBACK_LINES 200
static uint16_t scrollback_buf[SCROLLBACK_LINES][VGA_WIDTH];
static int sb_write = 0;   /* next write index (circular)        */
static int sb_count = 0;   /* lines stored, 0..SCROLLBACK_LINES  */
static int sb_view  = 0;   /* 0=live; N=scrolled N lines up      */
static uint16_t live_snapshot[VGA_HEIGHT][VGA_WIDTH]; /* VGA at scroll entry */

/* Push the about-to-be-evicted top row into the scrollback ring */
static void scrollback_push(void) {
    for (size_t x = 0; x < VGA_WIDTH; x++)
        scrollback_buf[sb_write][x] = terminal_buffer[x]; /* row 0 */
    sb_write = (sb_write + 1) % SCROLLBACK_LINES;
    if (sb_count < SCROLLBACK_LINES) sb_count++;
}

/* Re-paint VGA from scrollback + live_snapshot for current sb_view.
 * For screen row r:
 *   tape_idx = r + sb_count - sb_view
 *   < 0          → blank (beyond oldest record)
 *   < sb_count   → circular scrollback
 *   >= sb_count  → live_snapshot row (tape_idx - sb_count)
 */
static void scrollback_render(void) {
    for (int r = 0; r < (int)VGA_HEIGHT; r++) {
        int tape_idx = r + sb_count - sb_view;
        if (tape_idx < 0) {
            for (int c = 0; c < (int)VGA_WIDTH; c++)
                terminal_buffer[r * VGA_WIDTH + c] = vga_entry(' ', terminal_color);
        } else if (tape_idx < sb_count) {
            int sb_abs = sb_write - sb_count + tape_idx;
            int idx = ((sb_abs % SCROLLBACK_LINES) + SCROLLBACK_LINES) % SCROLLBACK_LINES;
            for (int c = 0; c < (int)VGA_WIDTH; c++)
                terminal_buffer[r * VGA_WIDTH + c] = scrollback_buf[idx][c];
        } else {
            int live_r = tape_idx - sb_count;
            if (live_r < (int)VGA_HEIGHT)
                for (int c = 0; c < (int)VGA_WIDTH; c++)
                    terminal_buffer[r * VGA_WIDTH + c] = live_snapshot[live_r][c];
        }
    }
}

/* Scroll the terminal up by one line */
static void terminal_scroll(void) {
    scrollback_push(); /* save evicted top row before overwriting */
    /* Move all lines up by one */
    for (size_t y = 0; y < VGA_HEIGHT - 1; y++) {
        for (size_t x = 0; x < VGA_WIDTH; x++) {
            terminal_buffer[y * VGA_WIDTH + x] = terminal_buffer[(y + 1) * VGA_WIDTH + x];
        }
    }
    
    /* Clear the last line */
    for (size_t x = 0; x < VGA_WIDTH; x++) {
        terminal_buffer[(VGA_HEIGHT - 1) * VGA_WIDTH + x] = vga_entry(' ', terminal_color);
    }
    
    terminal_row = VGA_HEIGHT - 1;
}

/* Update the hardware cursor position */
static void terminal_update_cursor(void) {
    uint16_t pos = terminal_row * VGA_WIDTH + terminal_column;
    outb(0x3D4, 0x0F);
    outb(0x3D5, (uint8_t)(pos & 0xFF));
    outb(0x3D4, 0x0E);
    outb(0x3D5, (uint8_t)((pos >> 8) & 0xFF));
}

/* Enable the hardware cursor */
static void terminal_enable_cursor(void) {
    outb(0x3D4, 0x0A);
    outb(0x3D5, (inb(0x3D5) & 0xC0) | 14);  /* Start scanline 14 */
    outb(0x3D4, 0x0B);
    outb(0x3D5, (inb(0x3D5) & 0xE0) | 15);  /* End scanline 15 */
}

void terminal_initialize(void) {
    terminal_row = 0;
    terminal_column = 0;
    terminal_color = vga_entry_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
    terminal_buffer = (uint16_t*) 0xB8000;
    for (size_t y = 0; y < VGA_HEIGHT; y++) {
        for (size_t x = 0; x < VGA_WIDTH; x++) {
            const size_t index = y * VGA_WIDTH + x;
            terminal_buffer[index] = vga_entry(' ', terminal_color);
        }
    }
    terminal_enable_cursor();
    terminal_update_cursor();
}

void terminal_setcolor(uint8_t color) {
    terminal_color = color;
}

void terminal_setcolor_fg_bg(uint8_t fg, uint8_t bg) {
    terminal_color = vga_entry_color(fg, bg);
}

uint8_t terminal_getcolor(void) {
    return terminal_color;
}

void terminal_putentryat(char c, uint8_t color, size_t x, size_t y) {
    const size_t index = y * VGA_WIDTH + x;
    terminal_buffer[index] = vga_entry(c, color);
}

void terminal_putchar(char c) {
    if (c == '\n') {
        terminal_column = 0;
        terminal_row++;
        if (terminal_row >= VGA_HEIGHT) {
            terminal_scroll();
        }
        terminal_update_cursor();
        return;
    }
    
    if (c == '\r') {
        terminal_column = 0;
        terminal_update_cursor();
        return;
    }
    
    if (c == '\b') {
        if (terminal_column > 0) {
            terminal_column--;
            terminal_putentryat(' ', terminal_color, terminal_column, terminal_row);
            terminal_update_cursor();
        }
        return;
    }
    
    if (c == '\t') {
        /* Tab to next 8-column boundary */
        size_t next_tab = (terminal_column + 8) & ~7;
        if (next_tab >= VGA_WIDTH) {
            terminal_column = 0;
            terminal_row++;
            if (terminal_row >= VGA_HEIGHT) {
                terminal_scroll();
            }
        } else {
            while (terminal_column < next_tab) {
                terminal_putentryat(' ', terminal_color, terminal_column, terminal_row);
                terminal_column++;
            }
        }
        terminal_update_cursor();
        return;
    }
    
    terminal_putentryat(c, terminal_color, terminal_column, terminal_row);
    if (++terminal_column == VGA_WIDTH) {
        terminal_column = 0;
        terminal_row++;
        if (terminal_row >= VGA_HEIGHT) {
            terminal_scroll();
        }
    }
    terminal_update_cursor();
}

void terminal_write(const char* data, size_t size) {
    for (size_t i = 0; i < size; i++)
        terminal_putchar(data[i]);
}

void terminal_writestring(const char* data) {
    size_t len = 0;
    while (data[len]) len++;
    terminal_write(data, len);
}

void terminal_clear(void) {
    for (size_t y = 0; y < VGA_HEIGHT; y++) {
        for (size_t x = 0; x < VGA_WIDTH; x++) {
            terminal_buffer[y * VGA_WIDTH + x] = vga_entry(' ', terminal_color);
        }
    }
    terminal_row = 0;
    terminal_column = 0;
    terminal_update_cursor();
}

void terminal_get_cursor(size_t *row, size_t *col) {
    *row = terminal_row;
    *col = terminal_column;
}

void terminal_set_cursor(size_t row, size_t col) {
    if (row < VGA_HEIGHT) terminal_row = row;
    if (col < VGA_WIDTH) terminal_column = col;
    terminal_update_cursor();
}

size_t terminal_get_width(void) {
    return VGA_WIDTH;
}

size_t terminal_get_height(void) {
    return VGA_HEIGHT;
}

/* ─── Public scrollback-view API ─────────────────────────────────────────── */

void terminal_scroll_view_up(int n) {
    if (sb_count == 0) return;
    if (sb_view == 0) {
        /* First scroll away from live — snapshot current VGA */
        for (size_t r = 0; r < VGA_HEIGHT; r++)
            for (size_t c = 0; c < VGA_WIDTH; c++)
                live_snapshot[r][c] = terminal_buffer[r * VGA_WIDTH + c];
        /* Hide hardware cursor to signal scroll mode */
        outb(0x3D4, 0x0A);
        outb(0x3D5, 0x20);
    }
    sb_view += n;
    if (sb_view > sb_count) sb_view = sb_count;
    scrollback_render();
}

void terminal_scroll_view_down(int n) {
    if (sb_view == 0) return;
    sb_view -= n;
    if (sb_view < 0) sb_view = 0;
    if (sb_view == 0) {
        /* Restore live VGA */
        for (size_t r = 0; r < VGA_HEIGHT; r++)
            for (size_t c = 0; c < VGA_WIDTH; c++)
                terminal_buffer[r * VGA_WIDTH + c] = live_snapshot[r][c];
        terminal_enable_cursor();
        terminal_update_cursor();
    } else {
        scrollback_render();
    }
}

void terminal_resume_live(void) {
    if (sb_view == 0) return;
    sb_view = 0;
    for (size_t r = 0; r < VGA_HEIGHT; r++)
        for (size_t c = 0; c < VGA_WIDTH; c++)
            terminal_buffer[r * VGA_WIDTH + c] = live_snapshot[r][c];
    terminal_enable_cursor();
    terminal_update_cursor();
}

int terminal_get_view_offset(void) {
    return sb_view;
}

/*
 * Write exactly VGA_WIDTH characters to a VGA row with the given colour byte.
 * No cursor movement, no newline/scroll side-effects. For the fullscreen editor.
 * colorByte = (bg << 4) | fg  (bg must be 0-7 to avoid blink)
 */
void terminal_drawrow(int row, const char *text, uint8_t color) {
    if (row < 0 || row >= (int)VGA_HEIGHT) return;
    for (int c = 0; c < (int)VGA_WIDTH; c++) {
        char ch = (text && *text) ? *text++ : ' ';
        terminal_buffer[row * VGA_WIDTH + c] = vga_entry((unsigned char)ch, color);
    }
}
