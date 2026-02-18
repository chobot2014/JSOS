#include "keyboard.h"
#include "irq.h"
#include "io.h"
#include <stddef.h>

/* Keyboard I/O ports */
#define KB_DATA_PORT    0x60
#define KB_STATUS_PORT  0x64

/* Keyboard buffer */
static char kb_buffer[KB_BUFFER_SIZE];
static volatile int kb_buffer_head = 0;
static volatile int kb_buffer_tail = 0;

/* Extended key buffer for special keys */
static volatile int kb_extended_key = 0;

/* Modifier key state */
static volatile int kb_shift = 0;
static volatile int kb_ctrl = 0;
static volatile int kb_alt = 0;
static volatile int kb_caps = 0;

/* US keyboard scancode to ASCII mapping (set 1) */
static const char scancode_normal[128] = {
    0,    0x1B, '1',  '2',  '3',  '4',  '5',  '6',   /* 0x00-0x07 */
    '7',  '8',  '9',  '0',  '-',  '=',  '\b', '\t',  /* 0x08-0x0F */
    'q',  'w',  'e',  'r',  't',  'y',  'u',  'i',   /* 0x10-0x17 */
    'o',  'p',  '[',  ']',  '\n', 0,    'a',  's',   /* 0x18-0x1F */
    'd',  'f',  'g',  'h',  'j',  'k',  'l',  ';',   /* 0x20-0x27 */
    '\'', '`',  0,    '\\', 'z',  'x',  'c',  'v',   /* 0x28-0x2F */
    'b',  'n',  'm',  ',',  '.',  '/',  0,    '*',   /* 0x30-0x37 */
    0,    ' ',  0,    0,    0,    0,    0,    0,     /* 0x38-0x3F */
    0,    0,    0,    0,    0,    0,    0,    0,     /* 0x40-0x47 */
    0,    0,    '-',  0,    0,    0,    '+',  0,     /* 0x48-0x4F */
    0,    0,    0,    0,    0,    0,    0,    0,     /* 0x50-0x57 */
    0,    0,    0,    0,    0,    0,    0,    0,     /* 0x58-0x5F */
};

static const char scancode_shift[128] = {
    0,    0x1B, '!',  '@',  '#',  '$',  '%',  '^',   /* 0x00-0x07 */
    '&',  '*',  '(',  ')',  '_',  '+',  '\b', '\t',  /* 0x08-0x0F */
    'Q',  'W',  'E',  'R',  'T',  'Y',  'U',  'I',   /* 0x10-0x17 */
    'O',  'P',  '{',  '}',  '\n', 0,    'A',  'S',   /* 0x18-0x1F */
    'D',  'F',  'G',  'H',  'J',  'K',  'L',  ':',   /* 0x20-0x27 */
    '"',  '~',  0,    '|',  'Z',  'X',  'C',  'V',   /* 0x28-0x2F */
    'B',  'N',  'M',  '<',  '>',  '?',  0,    '*',   /* 0x30-0x37 */
    0,    ' ',  0,    0,    0,    0,    0,    0,     /* 0x38-0x3F */
};

/* Push a character into the keyboard buffer */
static void kb_buffer_push(char c) {
    int next = (kb_buffer_head + 1) % KB_BUFFER_SIZE;
    if (next != kb_buffer_tail) {
        kb_buffer[kb_buffer_head] = c;
        kb_buffer_head = next;
    }
}

/* IRQ1 handler - keyboard interrupt */
static void keyboard_irq_handler(void) {
    uint8_t scancode = inb(KB_DATA_PORT);
    
    /* Handle key release (bit 7 set) */
    if (scancode & 0x80) {
        uint8_t released = scancode & 0x7F;
        switch (released) {
            case 0x2A: /* Left Shift */
            case 0x36: /* Right Shift */
                kb_shift = 0;
                break;
            case 0x1D: /* Ctrl */
                kb_ctrl = 0;
                break;
            case 0x38: /* Alt */
                kb_alt = 0;
                break;
        }
        return;
    }
    
    /* Handle key press */
    switch (scancode) {
        case 0x2A: /* Left Shift */
        case 0x36: /* Right Shift */
            kb_shift = 1;
            return;
        case 0x1D: /* Ctrl */
            kb_ctrl = 1;
            return;
        case 0x38: /* Alt */
            kb_alt = 1;
            return;
        case 0x3A: /* Caps Lock */
            kb_caps = !kb_caps;
            return;
        
        /* Arrow keys */
        case 0x48: kb_extended_key = KEY_UP;       return;
        case 0x50: kb_extended_key = KEY_DOWN;     return;
        case 0x4B: kb_extended_key = KEY_LEFT;     return;
        case 0x4D: kb_extended_key = KEY_RIGHT;    return;
        case 0x47: kb_extended_key = KEY_HOME;     return;
        case 0x4F: kb_extended_key = KEY_END;      return;
        case 0x49: kb_extended_key = KEY_PAGEUP;   return;
        case 0x51: kb_extended_key = KEY_PAGEDOWN; return;
        case 0x53: kb_extended_key = KEY_DELETE;   return;
        
        /* Function keys */
        case 0x3B: kb_extended_key = KEY_F1;  return;
        case 0x3C: kb_extended_key = KEY_F2;  return;
        case 0x3D: kb_extended_key = KEY_F3;  return;
        case 0x3E: kb_extended_key = KEY_F4;  return;
        case 0x3F: kb_extended_key = KEY_F5;  return;
        case 0x40: kb_extended_key = KEY_F6;  return;
        case 0x41: kb_extended_key = KEY_F7;  return;
        case 0x42: kb_extended_key = KEY_F8;  return;
        case 0x43: kb_extended_key = KEY_F9;  return;
        case 0x44: kb_extended_key = KEY_F10; return;
        case 0x57: kb_extended_key = KEY_F11; return;
        case 0x58: kb_extended_key = KEY_F12; return;
    }
    
    /* Regular keys */
    if (scancode < 128) {
        char c;
        
        if (kb_shift) {
            c = scancode_shift[scancode];
        } else {
            c = scancode_normal[scancode];
        }
        
        /* Apply caps lock to letters */
        if (kb_caps && c >= 'a' && c <= 'z') {
            c -= 32;
        } else if (kb_caps && c >= 'A' && c <= 'Z') {
            c += 32;
        }
        
        /* Handle Ctrl combinations */
        if (kb_ctrl && c >= 'a' && c <= 'z') {
            c = c - 'a' + 1;  /* Ctrl+A = 0x01, Ctrl+C = 0x03, etc. */
        }
        
        if (c != 0) {
            kb_buffer_push(c);
        }
    }
}

void keyboard_initialize(void) {
    /* Clear the buffer */
    kb_buffer_head = 0;
    kb_buffer_tail = 0;
    kb_extended_key = 0;
    
    /* Install keyboard IRQ handler (IRQ 1) */
    irq_install_handler(1, keyboard_irq_handler);
    
    /* Flush any pending keyboard data */
    while (inb(KB_STATUS_PORT) & 0x01) {
        inb(KB_DATA_PORT);
    }
}

int keyboard_has_key(void) {
    return kb_buffer_head != kb_buffer_tail;
}

char keyboard_getchar(void) {
    /* Block until a key is available */
    while (kb_buffer_head == kb_buffer_tail) {
        __asm__ volatile ("hlt");  /* Wait for next interrupt */
    }
    
    char c = kb_buffer[kb_buffer_tail];
    kb_buffer_tail = (kb_buffer_tail + 1) % KB_BUFFER_SIZE;
    return c;
}

char keyboard_poll(void) {
    if (kb_buffer_head == kb_buffer_tail) {
        return 0;
    }
    
    char c = kb_buffer[kb_buffer_tail];
    kb_buffer_tail = (kb_buffer_tail + 1) % KB_BUFFER_SIZE;
    return c;
}

int keyboard_get_extended(void) {
    int key = kb_extended_key;
    kb_extended_key = 0;
    return key;
}
