/*
 * keyboard_layout.h — keyboard layout support (items 60, 61, 62)
 *
 * Item 60: Multiple keyboard layouts (QWERTY, AZERTY, DVORAK)
 * Item 61: Dead-key composition for international characters
 * Item 62: Input method editor (IME) stub
 *
 * ARCHITECTURE CONSTRAINT: Only character-mapping tables and the dead-key
 * state machine live in C.  Full IME logic, dictionary lookups, and
 * candidate selection live in TypeScript.
 */
#ifndef KEYBOARD_LAYOUT_H
#define KEYBOARD_LAYOUT_H

#include <stdint.h>

/* ── Layout identifier ──────────────────────────────────────────────────── */
typedef enum {
    KB_LAYOUT_QWERTY  = 0,   /* US QWERTY (default) */
    KB_LAYOUT_AZERTY  = 1,   /* FR AZERTY */
    KB_LAYOUT_DVORAK  = 2,   /* US Dvorak Simplified */
    KB_LAYOUT_QWERTZ  = 3,   /* DE QWERTZ */
    KB_LAYOUT_COUNT   = 4,
} kb_layout_id_t;

/* ── Layout table entry ─────────────────────────────────────────────────── */
/* A layout table maps PS/2 scancode → (base, shifted) character pair.
 * Dead-key prefix scancodes map to 0xFF in the dead_key[] bitmask. */
typedef struct {
    const char         *name;         /* human-readable name */
    const uint8_t      *normal;       /* 256-entry base character table */
    const uint8_t      *shifted;      /* 256-entry shifted character table */
    const uint16_t     *dead_compose; /* dead_compose[dead_sc*256 + sc] = char */
    uint8_t             dead_count;   /* number of dead keys in this layout */
    const uint8_t      *dead_keys;    /* dead_count scancodes that act as dead keys */
} kb_layout_t;

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Initialise the layout subsystem.  Default layout = QWERTY.
 */
void kb_layout_init(void);

/**
 * Switch the active keyboard layout.
 * @returns 0 on success, -1 if id is out of range.
 */
int kb_layout_set(kb_layout_id_t id);

/**
 * Return the currently active layout id.
 */
kb_layout_id_t kb_layout_get(void);

/**
 * Translate a PS/2 scancode-1 value (with shift state) into a Unicode
 * codepoint (BMP only, ≤ 0xFFFF).  Returns 0 if no character.
 *
 * Dead-key state is maintained internally across calls.
 * @param sc      PS/2 scancode (set 1, 0x01–0x58 range).
 * @param shift   1 if shift is held, 0 otherwise.
 * @param output  Filled with the resulting Unicode codepoint; 0 = pending.
 * @returns 1 if a character was produced, 0 if dead-key pending or no char.
 */
int kb_layout_translate(uint8_t sc, int shift, uint16_t *output);

/**
 * Cancel any pending dead-key state (e.g. on Escape or focus loss).
 */
void kb_layout_cancel_dead(void);

/**
 * Return the layout table for the given id; NULL if out of range.
 */
const kb_layout_t *kb_layout_get_table(kb_layout_id_t id);

/* ── IME stub (item 62) ─────────────────────────────────────────────────── */

/**
 * Enable or disable the Input Method Engine.
 * When enabled, translated characters are passed to ime_handle_char()
 * before being enqueued in the keyboard buffer.
 */
void kb_ime_enable(int enable);
int  kb_ime_enabled(void);

/**
 * Feed a translated codepoint into the IME.
 * The IME may buffer it, output it immediately, or trigger a candidate
 * selection event posted to the JS event queue.
 * TypeScript registers an IME callback via kernel.setImeHandler(fn).
 * Returns the number of codepoints immediately emitted (0 = buffered).
 */
int kb_ime_handle_char(uint16_t codepoint);

/**
 * Flush the IME input buffer (e.g. on Enter or focus loss).
 */
void kb_ime_flush(void);

#endif /* KEYBOARD_LAYOUT_H */
