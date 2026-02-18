#ifndef PLATFORM_H
#define PLATFORM_H

#include <stdint.h>

/* Initialise VGA buffer and boot-time cursor */
void platform_init(void);

/* Boot-time sequential print (before QuickJS starts) */
void platform_boot_print(const char *s);

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

#endif /* PLATFORM_H */
