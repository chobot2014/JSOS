#ifndef TERMINAL_H
#define TERMINAL_H

#include <stddef.h>
#include <stdint.h>

/* VGA color constants for JavaScript bindings */
#define TERM_COLOR_BLACK         0
#define TERM_COLOR_BLUE          1
#define TERM_COLOR_GREEN         2
#define TERM_COLOR_CYAN          3
#define TERM_COLOR_RED           4
#define TERM_COLOR_MAGENTA       5
#define TERM_COLOR_BROWN         6
#define TERM_COLOR_LIGHT_GREY    7
#define TERM_COLOR_DARK_GREY     8
#define TERM_COLOR_LIGHT_BLUE    9
#define TERM_COLOR_LIGHT_GREEN   10
#define TERM_COLOR_LIGHT_CYAN    11
#define TERM_COLOR_LIGHT_RED     12
#define TERM_COLOR_LIGHT_MAGENTA 13
#define TERM_COLOR_LIGHT_BROWN   14
#define TERM_COLOR_WHITE         15

void terminal_initialize(void);
void terminal_putchar(char c);
void terminal_write(const char* data, size_t size);
void terminal_writestring(const char* data);
void terminal_setcolor(uint8_t color);
void terminal_setcolor_fg_bg(uint8_t fg, uint8_t bg);
uint8_t terminal_getcolor(void);
void terminal_clear(void);
void terminal_get_cursor(size_t *row, size_t *col);
void terminal_set_cursor(size_t row, size_t col);
size_t terminal_get_width(void);
size_t terminal_get_height(void);

#endif
