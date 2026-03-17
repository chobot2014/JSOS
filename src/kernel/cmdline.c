/*
 * JSOS Boot Command-Line Parser  (item 4)
 *
 * Multiboot2 tag type 1 contains the kernel command line as a null-terminated
 * string immediately after the 8-byte tag header.  We copy it into a static
 * buffer and then tokenize into up to CMDLINE_MAX_PARAMS key/value pairs.
 *
 * C code — pure string parsing, no OS logic.
 */

#include "cmdline.h"
#include <string.h>
#include <stddef.h>

/* ── Multiboot2 minimal tag header ──────────────────────────────────────── */
typedef struct {
    uint32_t type;
    uint32_t size;
} mb2_tag_hdr_t;

#define MB2_TAG_CMDLINE  1u

/* ── Internal storage ──────────────────────────────────────────────────── */
#define CMDLINE_BUF_LEN    512
#define CMDLINE_MAX_PARAMS  64

static char _raw_buf[CMDLINE_BUF_LEN];
static int  _parsed = 0;

typedef struct {
    char key[64];
    char val[128];
} param_t;

static param_t _params[CMDLINE_MAX_PARAMS];
static int     _param_count = 0;

/* ── Helpers ────────────────────────────────────────────────────────────── */
static int _streq_n(const char *a, const char *b, size_t n) {
    return (strncmp(a, b, n) == 0 && (a[n] == '\0' || a[n] == '='));
}

/* ── Public API ─────────────────────────────────────────────────────────── */

void cmdline_parse(uint32_t mb2_info_addr) {
    _raw_buf[0]  = '\0';
    _param_count = 0;
    _parsed      = 1;

    if (!mb2_info_addr) return;

    /* Multiboot2 info: 4-byte total_size + 4-byte reserved, then tags. */
    uint8_t *p   = (uint8_t *)mb2_info_addr;
    uint32_t total = *(uint32_t *)p;
    uint8_t *end = p + total;
    p += 8; /* skip total_size + reserved */

    while (p < end) {
        mb2_tag_hdr_t *tag = (mb2_tag_hdr_t *)p;
        if (tag->type == 0) break; /* end tag */

        if (tag->type == MB2_TAG_CMDLINE) {
            const char *s = (const char *)(p + 8);
            size_t len = tag->size - 8;
            if (len >= CMDLINE_BUF_LEN) len = CMDLINE_BUF_LEN - 1;
            memcpy(_raw_buf, s, len);
            _raw_buf[len] = '\0';
            break;
        }
        /* Tags are 8-byte aligned */
        uint32_t aligned = (tag->size + 7u) & ~7u;
        p += aligned;
    }

    /* Tokenize: split on spaces, split on '=' */
    char buf[CMDLINE_BUF_LEN];
    strncpy(buf, _raw_buf, CMDLINE_BUF_LEN - 1);
    buf[CMDLINE_BUF_LEN - 1] = '\0';

    char *tok = buf;
    while (*tok && _param_count < CMDLINE_MAX_PARAMS) {
        /* Skip leading spaces */
        while (*tok == ' ') tok++;
        if (!*tok) break;

        /* Find end of token */
        char *end_tok = tok;
        while (*end_tok && *end_tok != ' ') end_tok++;
        char saved = *end_tok;
        *end_tok = '\0';

        /* Split on '=' */
        char *eq = strchr(tok, '=');
        if (eq) {
            size_t kl = (size_t)(eq - tok);
            if (kl >= sizeof(_params[0].key)) kl = sizeof(_params[0].key) - 1;
            strncpy(_params[_param_count].key, tok, kl);
            _params[_param_count].key[kl] = '\0';
            strncpy(_params[_param_count].val, eq + 1, sizeof(_params[0].val) - 1);
            _params[_param_count].val[sizeof(_params[0].val) - 1] = '\0';
        } else {
            strncpy(_params[_param_count].key, tok, sizeof(_params[0].key) - 1);
            _params[_param_count].key[sizeof(_params[0].key) - 1] = '\0';
            _params[_param_count].val[0] = '\0';
        }
        _param_count++;

        *end_tok = saved;
        tok = end_tok;
    }
}

const char *cmdline_get(const char *key) {
    if (!_parsed) return NULL;
    size_t kl = strlen(key);
    for (int i = 0; i < _param_count; i++) {
        if (_streq_n(_params[i].key, key, kl) && _params[i].val[0] != '\0')
            return _params[i].val;
    }
    return NULL;
}

int cmdline_has(const char *key) {
    if (!_parsed) return 0;
    size_t kl = strlen(key);
    for (int i = 0; i < _param_count; i++) {
        if (_streq_n(_params[i].key, key, kl))
            return 1;
    }
    return 0;
}

const char *cmdline_raw(void) {
    return _raw_buf;
}
