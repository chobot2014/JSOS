#ifndef KEYBOARD_H
#define KEYBOARD_H

#include <stdint.h>

/* Keyboard buffer size */
#define KB_BUFFER_SIZE 256

/* Special key codes (returned as negative values or high bytes) */
#define KEY_BACKSPACE  0x08
#define KEY_TAB        0x09
#define KEY_ENTER      0x0A
#define KEY_ESCAPE     0x1B
#define KEY_UP         0x80
#define KEY_DOWN       0x81
#define KEY_LEFT       0x82
#define KEY_RIGHT      0x83
#define KEY_HOME       0x84
#define KEY_END        0x85
#define KEY_PAGEUP     0x86
#define KEY_PAGEDOWN   0x87
#define KEY_DELETE     0x88
#define KEY_F1         0x90
#define KEY_F2         0x91
#define KEY_F3         0x92
#define KEY_F4         0x93
#define KEY_F5         0x94
#define KEY_F6         0x95
#define KEY_F7         0x96
#define KEY_F8         0x97
#define KEY_F9         0x98
#define KEY_F10        0x99
#define KEY_F11        0x9A
#define KEY_F12        0x9B

/* Initialize the keyboard driver */
void keyboard_initialize(void);

/* Check if a key is available in the buffer */
int keyboard_has_key(void);

/* Get a key from the buffer (blocks if none available) */
char keyboard_getchar(void);

/* Get a key from the buffer (returns 0 if none available) */
char keyboard_poll(void);

/* Get extended key code (for special keys) */
int keyboard_get_extended(void);

#endif /* KEYBOARD_H */
