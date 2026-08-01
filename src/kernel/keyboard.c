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
static volatile int kb_ctrl  = 0;
static volatile int kb_alt   = 0;
static volatile int kb_caps  = 0;
static volatile int kb_numlock    = 0;  /* item 55: NumLock state  */
static volatile int kb_scrolllock = 0;  /* item 55: ScrollLock state */

/* Scancode Set 2 state (item 53) */
static int _use_set2  = 0;
static int _sc2_break = 0;
static int _sc2_ext   = 0;

static void _sc2_handle_byte(uint8_t code);  /* forward declaration */

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

    /* Dispatch to Set-2 handler if enabled (item 53) */
    if (_use_set2) {
        _sc2_handle_byte(scancode);
        return;
    }

    /* Original Set-1 handler below */
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
        case 0x45: /* Num Lock  */
            kb_numlock = !kb_numlock;
            return;
        case 0x46: /* Scroll Lock */
            kb_scrolllock = !kb_scrolllock;
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
        case 0x3B: kb_extended_key = kb_alt ? KEY_VT1  : KEY_F1;  return;
        case 0x3C: kb_extended_key = kb_alt ? KEY_VT2  : KEY_F2;  return;
        case 0x3D: kb_extended_key = kb_alt ? KEY_VT3  : KEY_F3;  return;
        case 0x3E: kb_extended_key = kb_alt ? KEY_VT4  : KEY_F4;  return;
        case 0x3F: kb_extended_key = kb_alt ? KEY_VT5  : KEY_F5;  return;
        case 0x40: kb_extended_key = kb_alt ? KEY_VT6  : KEY_F6;  return;
        case 0x41: kb_extended_key = kb_alt ? KEY_VT7  : KEY_F7;  return;
        case 0x42: kb_extended_key = kb_alt ? KEY_VT8  : KEY_F8;  return;
        case 0x43: kb_extended_key = kb_alt ? KEY_VT9  : KEY_F9;  return;
        case 0x44: kb_extended_key = kb_alt ? KEY_VT10 : KEY_F10; return;
        case 0x57: kb_extended_key = kb_alt ? KEY_VT11 : KEY_F11; return;
        case 0x58: kb_extended_key = kb_alt ? KEY_VT12 : KEY_F12; return;
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

uint8_t keyboard_get_modifiers(void) {
    uint8_t m = 0;
    if (kb_shift)      m |= (1u << 0);
    if (kb_ctrl)       m |= (1u << 1);
    if (kb_alt)        m |= (1u << 2);
    if (kb_caps)       m |= (1u << 3);
    if (kb_numlock)    m |= (1u << 4);
    if (kb_scrolllock) m |= (1u << 5);
    return m;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scancode Set 2 support (item 53)
 *
 * When keyboard_enable_set2() is called the PS/2 controller's translation
 * feature is disabled and the keyboard sends raw Set-2 make/break codes.
 *
 *   Break prefix  : 0xF0  (next byte is the make code for the released key)
 *   Extended keys : 0xE0  (followed by one more byte for the specific key)
 *
 * The tables below map Set-2 make codes to ASCII characters using GCC
 * designated-initializer syntax so that all unspecified entries default to 0.
 * ───────────────────────────────────────────────────────────────────────── */

/* Make-code → unshifted ASCII (0 = not a printable / modifier key) */
static const char _sc2_normal[256] = {
    [0x0D] = '\t',   [0x0E] = '`',
    [0x15] = 'q',    [0x16] = '1',
    [0x1A] = 'z',    [0x1B] = 's',    [0x1C] = 'a',    [0x1D] = 'w',
    [0x1E] = '2',
    [0x21] = 'c',    [0x22] = 'x',    [0x23] = 'd',    [0x24] = 'e',
    [0x25] = '4',    [0x26] = '3',    [0x29] = ' ',
    [0x2A] = 'v',    [0x2B] = 'f',    [0x2C] = 't',    [0x2D] = 'r',
    [0x2E] = '5',
    [0x31] = 'n',    [0x32] = 'b',    [0x33] = 'h',    [0x34] = 'g',
    [0x35] = 'y',    [0x36] = '6',
    [0x3A] = 'm',    [0x3B] = 'j',    [0x3C] = 'u',    [0x3D] = '7',
    [0x3E] = '8',
    [0x41] = ',',    [0x42] = 'k',    [0x43] = 'i',    [0x44] = 'o',
    [0x45] = '0',    [0x46] = '9',
    [0x49] = '.',    [0x4A] = '/',    [0x4B] = 'l',    [0x4C] = ';',
    [0x4D] = 'p',    [0x4E] = '-',
    [0x52] = '\'',   [0x54] = '[',    [0x55] = '=',
    [0x5A] = '\n',   [0x5B] = ']',    [0x5D] = '\\',
    [0x66] = '\b',   [0x76] = '\x1B',
};

/* Make-code → shifted ASCII */
static const char _sc2_shift[256] = {
    [0x0D] = '\t',   [0x0E] = '~',
    [0x15] = 'Q',    [0x16] = '!',
    [0x1A] = 'Z',    [0x1B] = 'S',    [0x1C] = 'A',    [0x1D] = 'W',
    [0x1E] = '@',
    [0x21] = 'C',    [0x22] = 'X',    [0x23] = 'D',    [0x24] = 'E',
    [0x25] = '$',    [0x26] = '#',    [0x29] = ' ',
    [0x2A] = 'V',    [0x2B] = 'F',    [0x2C] = 'T',    [0x2D] = 'R',
    [0x2E] = '%',
    [0x31] = 'N',    [0x32] = 'B',    [0x33] = 'H',    [0x34] = 'G',
    [0x35] = 'Y',    [0x36] = '^',
    [0x3A] = 'M',    [0x3B] = 'J',    [0x3C] = 'U',    [0x3D] = '&',
    [0x3E] = '*',
    [0x41] = '<',    [0x42] = 'K',    [0x43] = 'I',    [0x44] = 'O',
    [0x45] = ')',     [0x46] = '(',
    [0x49] = '>',    [0x4A] = '?',    [0x4B] = 'L',    [0x4C] = ':',
    [0x4D] = 'P',    [0x4E] = '_',
    [0x52] = '"',    [0x54] = '{',    [0x55] = '+',
    [0x5A] = '\n',   [0x5B] = '}',    [0x5D] = '|',
    [0x66] = '\b',   [0x76] = '\x1B',
};

/* Handle one Set-2 byte from the PS/2 data port.  Called from the IRQ handler
 * when _use_set2 is set. */
static void _sc2_handle_byte(uint8_t code) {
    /* Prefix bytes — just update state and return */
    if (code == 0xF0) { _sc2_break = 1; return; }
    if (code == 0xE0) { _sc2_ext   = 1; return; }

    int is_break = _sc2_break;
    int is_ext   = _sc2_ext;
    _sc2_break   = 0;
    _sc2_ext     = 0;

    if (is_ext) {
        /* Extended make/break codes */
        if (is_break) {
            /* RAlt / RCtrl release */
            if (code == 0x11) kb_alt  = 0;
            if (code == 0x14) kb_ctrl = 0;
            return;
        }
        /* Extended make codes */
        switch (code) {
            case 0x11: kb_alt  = 1; return;    /* RAlt          */
            case 0x14: kb_ctrl = 1; return;    /* RCtrl         */
            case 0x6B: kb_extended_key = KEY_LEFT;     return;
            case 0x72: kb_extended_key = KEY_DOWN;     return;
            case 0x74: kb_extended_key = KEY_RIGHT;    return;
            case 0x75: kb_extended_key = KEY_UP;       return;
            case 0x6C: kb_extended_key = KEY_HOME;     return;
            case 0x69: kb_extended_key = KEY_END;      return;
            case 0x7D: kb_extended_key = KEY_PAGEUP;   return;
            case 0x7A: kb_extended_key = KEY_PAGEDOWN; return;
            case 0x71: kb_extended_key = KEY_DELETE;   return;
        }
        return;
    }

    /* Non-extended modifier / function key releases */
    if (is_break) {
        if (code == 0x12 || code == 0x59) kb_shift = 0;
        if (code == 0x14) kb_ctrl = 0;
        if (code == 0x11) kb_alt  = 0;
        return;
    }

    /* Non-extended make codes — modifiers, function keys, then printable */
    switch (code) {
        case 0x12: case 0x59: kb_shift = 1; return;
        case 0x14: kb_ctrl = 1; return;
        case 0x11: kb_alt  = 1; return;
        case 0x58: kb_caps       = !kb_caps;       return;
        case 0x77: kb_numlock    = !kb_numlock;    return;
        case 0x7E: kb_scrolllock = !kb_scrolllock; return;
        /* Function keys */
        case 0x05: kb_extended_key = kb_alt ? KEY_VT1  : KEY_F1;  return;
        case 0x06: kb_extended_key = kb_alt ? KEY_VT2  : KEY_F2;  return;
        case 0x04: kb_extended_key = kb_alt ? KEY_VT3  : KEY_F3;  return;
        case 0x0C: kb_extended_key = kb_alt ? KEY_VT4  : KEY_F4;  return;
        case 0x03: kb_extended_key = kb_alt ? KEY_VT5  : KEY_F5;  return;
        case 0x0B: kb_extended_key = kb_alt ? KEY_VT6  : KEY_F6;  return;
        case 0x83: kb_extended_key = kb_alt ? KEY_VT7  : KEY_F7;  return;
        case 0x0A: kb_extended_key = kb_alt ? KEY_VT8  : KEY_F8;  return;
        case 0x01: kb_extended_key = kb_alt ? KEY_VT9  : KEY_F9;  return;
        case 0x09: kb_extended_key = kb_alt ? KEY_VT10 : KEY_F10; return;
        case 0x78: kb_extended_key = kb_alt ? KEY_VT11 : KEY_F11; return;
        case 0x07: kb_extended_key = kb_alt ? KEY_VT12 : KEY_F12; return;
    }

    /* Printable characters */
    char c = kb_shift ? _sc2_shift[code] : _sc2_normal[code];
    if (kb_caps && c >= 'a' && c <= 'z') c -= 32;
    else if (kb_caps && c >= 'A' && c <= 'Z') c += 32;
    if (kb_ctrl && c >= 'a' && c <= 'z') c = c - 'a' + 1;
    if (c != 0) kb_buffer_push(c);
}

/* Send a byte to the PS/2 keyboard (waits for input buffer empty) */
static void _kb_send(uint8_t data) {
    int timeout = 100000;
    while ((inb(KB_STATUS_PORT) & 0x02) && --timeout);
    outb(KB_DATA_PORT, data);
    /* Discard the ACK byte (0xFA) */
    timeout = 100000;
    while (!(inb(KB_STATUS_PORT) & 0x01) && --timeout);
    inb(KB_DATA_PORT);
}

void keyboard_enable_set2(void) {
    /* Step 1: disable PS/2 controller translation (bit 6 of config byte) */
    /* Send 0x20 (read config) then write back with bit 6 cleared          */
    int timeout;
    timeout = 100000;
    while ((inb(KB_STATUS_PORT) & 0x02) && --timeout);
    outb(KB_STATUS_PORT, 0x20u);         /* Read controller config byte    */
    timeout = 100000;
    while (!(inb(KB_STATUS_PORT) & 0x01) && --timeout);
    uint8_t cfg = inb(KB_DATA_PORT);
    cfg &= ~(1u << 6);                   /* Clear bit 6 = disable scan-code translation */
    timeout = 100000;
    while ((inb(KB_STATUS_PORT) & 0x02) && --timeout);
    outb(KB_STATUS_PORT, 0x60u);         /* Write controller config byte   */
    timeout = 100000;
    while ((inb(KB_STATUS_PORT) & 0x02) && --timeout);
    outb(KB_DATA_PORT, cfg);

    /* Step 2: tell keyboard to switch to scancode set 2                   */
    _kb_send(0xF0u);
    _kb_send(0x02u);

    _sc2_break = 0;
    _sc2_ext   = 0;
    _use_set2  = 1;
}
