/*
 * keyboard_layout.c — Keyboard layout + dead-key + IME stub (items 60–62)
 */

#include "keyboard_layout.h"
#include "platform.h"
#include <stdint.h>
#include <string.h>

/* ══════════════════════════════════════════════════════════════════════════
 * LAYOUT TABLES (PS/2 scancode set 1, 0x00–0x57)
 * Only printable ASCII range; special keys return 0.
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── US QWERTY ────────────────────────────────────────────────────────── */
static const uint8_t _qwerty_normal[256] = {
    [0x02]='1',[0x03]='2',[0x04]='3',[0x05]='4',[0x06]='5',
    [0x07]='6',[0x08]='7',[0x09]='8',[0x0A]='9',[0x0B]='0',
    [0x0C]='-',[0x0D]='=',[0x0F]='\t',
    [0x10]='q',[0x11]='w',[0x12]='e',[0x13]='r',[0x14]='t',
    [0x15]='y',[0x16]='u',[0x17]='i',[0x18]='o',[0x19]='p',
    [0x1A]='[',[0x1B]=']',
    [0x1E]='a',[0x1F]='s',[0x20]='d',[0x21]='f',[0x22]='g',
    [0x23]='h',[0x24]='j',[0x25]='k',[0x26]='l',[0x27]=';',
    [0x28]='\'',
    [0x29]='`',[0x2B]='\\',
    [0x2C]='z',[0x2D]='x',[0x2E]='c',[0x2F]='v',[0x30]='b',
    [0x31]='n',[0x32]='m',[0x33]=',',[0x34]='.',[0x35]='/',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};
static const uint8_t _qwerty_shifted[256] = {
    [0x02]='!',[0x03]='@',[0x04]='#',[0x05]='$',[0x06]='%',
    [0x07]='^',[0x08]='&',[0x09]='*',[0x0A]='(',[0x0B]=')',
    [0x0C]='_',[0x0D]='+',
    [0x10]='Q',[0x11]='W',[0x12]='E',[0x13]='R',[0x14]='T',
    [0x15]='Y',[0x16]='U',[0x17]='I',[0x18]='O',[0x19]='P',
    [0x1A]='{',[0x1B]='}',
    [0x1E]='A',[0x1F]='S',[0x20]='D',[0x21]='F',[0x22]='G',
    [0x23]='H',[0x24]='J',[0x25]='K',[0x26]='L',[0x27]=':',
    [0x28]='"',
    [0x29]='~',[0x2B]='|',
    [0x2C]='Z',[0x2D]='X',[0x2E]='C',[0x2F]='V',[0x30]='B',
    [0x31]='N',[0x32]='M',[0x33]='<',[0x34]='>',[0x35]='?',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};

/* ── FR AZERTY ────────────────────────────────────────────────────────── */
static const uint8_t _azerty_normal[256] = {
    /* Row 1: &é"'(-è_çà) */
    [0x02]='&',[0x03]=0xE9,[0x04]='"',[0x05]='\'',[0x06]='(',
    [0x07]='-',[0x08]=0xE8,[0x09]='_',[0x0A]=0xE7,[0x0B]=0xE0,
    [0x0C]=')',[0x0D]='=',
    /* Row 2: azertyuiop^$ */
    [0x10]='a',[0x11]='z',[0x12]='e',[0x13]='r',[0x14]='t',
    [0x15]='y',[0x16]='u',[0x17]='i',[0x18]='o',[0x19]='p',
    [0x1A]='^',[0x1B]='$',
    /* Row 3: qsdfghjklmù* */
    [0x1E]='q',[0x1F]='s',[0x20]='d',[0x21]='f',[0x22]='g',
    [0x23]='h',[0x24]='j',[0x25]='k',[0x26]='l',[0x27]='m',
    [0x28]=0xF9,[0x29]='`',[0x2B]='*',
    /* Row 4: wxcvbn,;:! */
    [0x2C]='w',[0x2D]='x',[0x2E]='c',[0x2F]='v',[0x30]='b',
    [0x31]='n',[0x32]=',',[0x33]=';',[0x34]=':',[0x35]='!',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};
static const uint8_t _azerty_shifted[256] = {
    [0x02]='1',[0x03]='2',[0x04]='3',[0x05]='4',[0x06]='5',
    [0x07]='6',[0x08]='7',[0x09]='8',[0x0A]='9',[0x0B]='0',
    [0x0C]='°',[0x0D]='+',
    [0x10]='A',[0x11]='Z',[0x12]='E',[0x13]='R',[0x14]='T',
    [0x15]='Y',[0x16]='U',[0x17]='I',[0x18]='O',[0x19]='P',
    [0x1A]=0xA8,[0x1B]=0xA3,
    [0x1E]='Q',[0x1F]='S',[0x20]='D',[0x21]='F',[0x22]='G',
    [0x23]='H',[0x24]='J',[0x25]='K',[0x26]='L',[0x27]='M',
    [0x28]='%',[0x29]='~',[0x2B]='/',
    [0x2C]='W',[0x2D]='X',[0x2E]='C',[0x2F]='V',[0x30]='B',
    [0x31]='N',[0x32]='?',[0x33]='.',[0x34]='/',[0x35]=0xA7,
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};

/* ── US Dvorak Simplified ─────────────────────────────────────────────── */
static const uint8_t _dvorak_normal[256] = {
    [0x02]='1',[0x03]='2',[0x04]='3',[0x05]='4',[0x06]='5',
    [0x07]='6',[0x08]='7',[0x09]='8',[0x0A]='9',[0x0B]='0',
    [0x0C]='[',[0x0D]=']',
    /* QWERTY qwertyuiop => Dvorak '\",<.pyfgcrl */
    [0x10]='\'',[0x11]=',',[0x12]='.',[0x13]='p',[0x14]='y',
    [0x15]='f',[0x16]='g',[0x17]='c',[0x18]='r',[0x19]='l',
    [0x1A]='/',[0x1B]='=',
    /* QWERTY asdfghjkl; => Dvorak aoeuidhtns */
    [0x1E]='a',[0x1F]='o',[0x20]='e',[0x21]='u',[0x22]='i',
    [0x23]='d',[0x24]='h',[0x25]='t',[0x26]='n',[0x27]='s',
    [0x28]='-',
    [0x29]='`',[0x2B]='\\',
    /* QWERTY zxcvbnm,./ => Dvorak ;qjkxbmwvz */
    [0x2C]=';',[0x2D]='q',[0x2E]='j',[0x2F]='k',[0x30]='x',
    [0x31]='b',[0x32]='m',[0x33]='w',[0x34]='v',[0x35]='z',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};
static const uint8_t _dvorak_shifted[256] = {
    [0x02]='!',[0x03]='@',[0x04]='#',[0x05]='$',[0x06]='%',
    [0x07]='^',[0x08]='&',[0x09]='*',[0x0A]='(',[0x0B]=')',
    [0x0C]='{',[0x0D]='}',
    [0x10]='"',[0x11]='<',[0x12]='>',[0x13]='P',[0x14]='Y',
    [0x15]='F',[0x16]='G',[0x17]='C',[0x18]='R',[0x19]='L',
    [0x1A]='?',[0x1B]='+',
    [0x1E]='A',[0x1F]='O',[0x20]='E',[0x21]='U',[0x22]='I',
    [0x23]='D',[0x24]='H',[0x25]='T',[0x26]='N',[0x27]='S',
    [0x28]='_',
    [0x29]='~',[0x2B]='|',
    [0x2C]=':',[0x2D]='Q',[0x2E]='J',[0x2F]='K',[0x30]='X',
    [0x31]='B',[0x32]='M',[0x33]='W',[0x34]='V',[0x35]='Z',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};

/* ── DE QWERTZ ────────────────────────────────────────────────────────── */
static const uint8_t _qwertz_normal[256] = {
    [0x02]='1',[0x03]='2',[0x04]='3',[0x05]='4',[0x06]='5',
    [0x07]='6',[0x08]='7',[0x09]='8',[0x0A]='9',[0x0B]='0',
    [0x0C]=0xDF,[0x0D]='`',  /* ß ` */
    [0x10]='q',[0x11]='w',[0x12]='e',[0x13]='r',[0x14]='t',
    [0x15]='z',[0x16]='u',[0x17]='i',[0x18]='o',[0x19]='p',
    [0x1A]=0xFC,[0x1B]='+',  /* ü + */
    [0x1E]='a',[0x1F]='s',[0x20]='d',[0x21]='f',[0x22]='g',
    [0x23]='h',[0x24]='j',[0x25]='k',[0x26]='l',[0x27]=0xF6,
    [0x28]=0xE4,[0x29]='^',[0x2B]='#', /* ö ä ^ # */
    [0x2C]='y',[0x2D]='x',[0x2E]='c',[0x2F]='v',[0x30]='b',
    [0x31]='n',[0x32]='m',[0x33]=',',[0x34]='.',[0x35]='-',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};
static const uint8_t _qwertz_shifted[256] = {
    [0x02]='!',[0x03]='"',[0x04]=0xA7,[0x05]='$',[0x06]='%',
    [0x07]='&',[0x08]='/',[0x09]='(',[0x0A]=')',[0x0B]='=',
    [0x0C]='?',[0x0D]='`',
    [0x10]='Q',[0x11]='W',[0x12]='E',[0x13]='R',[0x14]='T',
    [0x15]='Z',[0x16]='U',[0x17]='I',[0x18]='O',[0x19]='P',
    [0x1A]=0xDC,[0x1B]='*', /* Ü */
    [0x1E]='A',[0x1F]='S',[0x20]='D',[0x21]='F',[0x22]='G',
    [0x23]='H',[0x24]='J',[0x25]='K',[0x26]='L',[0x27]=0xD6,
    [0x28]=0xC4,[0x29]=0xB0,[0x2B]='\'', /* Ö Ä ° */
    [0x2C]='Y',[0x2D]='X',[0x2E]='C',[0x2F]='V',[0x30]='B',
    [0x31]='N',[0x32]='M',[0x33]=';',[0x34]=':',[0x35]='_',
    [0x39]=' ',[0x1C]='\n',[0x0E]='\b',
};

/* ── Dead-key compose table for AZERTY (circumflex 0x1A + vowel) ────────── */
/* Layout: dead_compose[sc] for vowels following circumflex key scan 0x1A */
/* Only a sparse table; we use a flat 256-entry array per dead key.        */
/* For brevity, only the ^-vowel compositions for AZERTY are provided.    */
static const uint16_t _azerty_circumflex[256] = {
    ['a']=0xE2,[  /* â */
    'e']=0xEA,   /* ê */
    'i']=0xEE,   /* î */
    'o']=0xF4,   /* ô */
    'u']=0xFB,   /* û */
    'A']=0xC2,   /* Â */
    'E']=0xCA,   /* Ê */
    'I']=0xCE,   /* Î */
    'O']=0xD4,   /* Ô */
    'U']=0xDB,   /* Û */
};
static const uint8_t _azerty_dead_keys[1] = { 0x1Au };

/* ── Layout table registry ────────────────────────────────────────────── */
static const kb_layout_t _layouts[KB_LAYOUT_COUNT] = {
    [KB_LAYOUT_QWERTY] = {
        "US QWERTY", _qwerty_normal, _qwerty_shifted,
        0, 0, 0 },
    [KB_LAYOUT_AZERTY] = {
        "FR AZERTY", _azerty_normal, _azerty_shifted,
        _azerty_circumflex, 1, _azerty_dead_keys },
    [KB_LAYOUT_DVORAK] = {
        "US Dvorak", _dvorak_normal, _dvorak_shifted,
        0, 0, 0 },
    [KB_LAYOUT_QWERTZ] = {
        "DE QWERTZ", _qwertz_normal, _qwertz_shifted,
        0, 0, 0 },
};

/* ── State ───────────────────────────────────────────────────────────────── */
static kb_layout_id_t _current   = KB_LAYOUT_QWERTY;
static int            _dead_pending = 0;   /* 1 = waiting for combining char */
static uint8_t        _dead_sc      = 0;   /* scancode of the dead key */

void kb_layout_init(void) {
    _current      = KB_LAYOUT_QWERTY;
    _dead_pending = 0;
    _dead_sc      = 0u;
}

int kb_layout_set(kb_layout_id_t id) {
    if ((int)id < 0 || id >= KB_LAYOUT_COUNT) return -1;
    _current      = id;
    _dead_pending = 0;   /* cancel pending compose */
    _dead_sc      = 0u;
    return 0;
}

kb_layout_id_t kb_layout_get(void) { return _current; }

const kb_layout_t *kb_layout_get_table(kb_layout_id_t id) {
    if ((int)id < 0 || id >= KB_LAYOUT_COUNT) return 0;
    return &_layouts[id];
}

void kb_layout_cancel_dead(void) { _dead_pending = 0; _dead_sc = 0u; }

int kb_layout_translate(uint8_t sc, int shift, uint16_t *output) {
    const kb_layout_t *L = &_layouts[_current];
    *output = 0u;

    /* Check if sc is a dead key in this layout */
    for (int i = 0; i < L->dead_count; i++) {
        if (L->dead_keys[i] == sc) {
            if (_dead_pending && _dead_sc == sc) {
                /* Double dead key = emit the dead key character itself */
                *output = shift ? L->shifted[sc] : L->normal[sc];
                _dead_pending = 0; _dead_sc = 0u;
                return (*output != 0);
            }
            _dead_pending = 1;
            _dead_sc      = sc;
            return 0;   /* pending */
        }
    }

    uint8_t ch = shift ? L->shifted[sc] : L->normal[sc];

    if (_dead_pending && L->dead_compose) {
        /* Look up compose: table is indexed by base character */
        uint16_t composed = L->dead_compose[(uint8_t)ch];
        _dead_pending = 0; _dead_sc = 0u;
        if (composed) { *output = composed; return 1; }
        /* No composition: emit dead key char + this char separately —
         * TypeScript handles the resulting sequence.  Emit ch for now. */
    }

    if (ch) { *output = (uint16_t)ch; return 1; }
    return 0;
}

/* ── IME stub (item 62) ──────────────────────────────────────────────────── */

static int _ime_enabled = 0;

void kb_ime_enable(int enable) { _ime_enabled = enable ? 1 : 0; }
int  kb_ime_enabled(void)      { return _ime_enabled; }

int kb_ime_handle_char(uint16_t codepoint) {
    /* Stub: pass directly through.  TypeScript overrides this via JS callback.
     * In a real IME, we would buffer multi-character sequences here.      */
    (void)codepoint;
    return 1;   /* "emitted immediately" */
}

void kb_ime_flush(void) {
    /* Stub: nothing to flush in the minimal C implementation */
}
