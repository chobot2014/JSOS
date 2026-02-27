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
#include "memory.h"
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

/*
 * Item 14 — Boot splash screen.
 * Drawn in VGA text mode immediately after platform_init().
 * Renders a coloured banner across the top 5 rows of the 80×25 display.
 * VGA colour: 0x17 = white text on blue BG; 0x1E = yellow on blue;
 * 0x1F = bright white on blue; 0x70 = black on light grey.
 */
void platform_boot_splash(void) {
    /* Colour codes (bg<<4|fg):
     *   0x17 = blue BG + white FG
     *   0x1E = blue BG + yellow FG
     *   0x1F = blue BG + bright-white FG   (title)
     *   0x1B = blue BG + cyan FG           (subtitle)
     */
    static const char title[]    = "       JSOS \xbb TypeScript Operating System       ";
    static const char subtitle[] = "             The OS written entirely in TypeScript ";
    static const char version[]  = "                    Version  0.1.0-alpha           ";
    static const char rule[]     = "  \xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd"
                                   "\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd"
                                   "\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd"
                                   "\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd\xcd  ";

    /* Fill rows 0-5 with blue background */
    for (int r = 0; r < 6; r++)
        for (int c = 0; c < VGA_WIDTH; c++)
            vga[r * VGA_WIDTH + c] = vga_cell(' ', 0x17);

    platform_vga_draw_row(0, rule,     0x1B);  /* cyan double-rule line */
    platform_vga_draw_row(1, title,    0x1F);  /* bright-white title    */
    platform_vga_draw_row(2, subtitle, 0x1B);  /* cyan subtitle         */
    platform_vga_draw_row(3, version,  0x1E);  /* yellow version        */
    platform_vga_draw_row(4, rule,     0x1B);  /* cyan double-rule line */
    /* Row 5 left blank as separator; boot messages begin from row 6    */

    /* Advance boot cursor so platform_boot_print starts below splash   */
    boot_row = 6;
    boot_col = 0;
    hw_cursor_update(boot_row, boot_col);

    /* Mirror a brief header to serial as well */
    serial_puts("\r\n========================================================\r\n");
    serial_puts("  JSOS — TypeScript Operating System   v0.1.0-alpha\r\n");
    serial_puts("========================================================\r\n\r\n");
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

/* ── Framebuffer ─────────────────────────────────────────────────────────── */

static fb_info_t _fb = { NULL, 0, 0, 0, 0, 0 };

/*
 * Parse multiboot2 boot information to locate the framebuffer tag (type=8).
 * Called from kernel.c after platform_init().
 * mb2_info_addr: physical address of the multiboot2 boot info structure.
 */
void platform_fb_init(uint32_t mb2_info_addr) {
    if (mb2_info_addr == 0) return;

    /* Multiboot2 info: first 8 bytes are total_size + reserved, then tags */
    uint8_t *info = (uint8_t *)(uintptr_t)mb2_info_addr;
    uint32_t total_size = *(uint32_t *)info;

    /* Walk tags */
    uint8_t *tag = info + 8;
    uint8_t *end = info + total_size;

    while (tag < end) {
        mb2_tag_t *hdr = (mb2_tag_t *)tag;

        if (hdr->type == 0) break; /* end tag */

        if (hdr->type == 8) { /* MULTIBOOT_TAG_TYPE_FRAMEBUFFER */
            mb2_tag_framebuffer_t *fbt = (mb2_tag_framebuffer_t *)tag;
            if (fbt->framebuffer_type == 1) { /* RGB mode */
                _fb.address   = (uint32_t *)(uintptr_t)(uint32_t)fbt->framebuffer_addr;
                _fb.width     = fbt->framebuffer_width;
                _fb.height    = fbt->framebuffer_height;
                _fb.pitch     = fbt->framebuffer_pitch;
                _fb.bpp       = fbt->framebuffer_bpp;
                _fb.available = 1;
            }
        }

        /* Each tag is padded to 8-byte boundary */
        uint32_t size = hdr->size;
        tag += (size + 7) & ~7u;
    }
}

void platform_fb_get_info(fb_info_t *out) {
    *out = _fb;
}

/*
 * Copy a w*h BGRA (32-bit) pixel array into the framebuffer at (x, y).
 * No-op if framebuffer is not available or bpp != 32.
 */
/* ── TSS (Task State Segment) — Phase 5 ─────────────────────────────────── */

typedef struct __attribute__((packed)) {
    uint32_t prev_tss;
    uint32_t esp0;            /* kernel ESP on ring-3 → ring-0 transition */
    uint32_t ss0;             /* kernel SS (= 0x10, data segment)          */
    uint32_t esp1; uint32_t ss1;
    uint32_t esp2; uint32_t ss2;
    uint32_t cr3, eip, eflags;
    uint32_t eax, ecx, edx, ebx, esp, ebp, esi, edi;
    uint32_t es, cs, ss, ds, fs, gs, ldt;
    uint16_t trap, iomap_base;
} tss_t;

static tss_t kernel_tss;

void platform_tss_init(void) {
    uint32_t i;
    uint8_t *p = (uint8_t *)&kernel_tss;
    for (i = 0; i < (uint32_t)sizeof(kernel_tss); i++) p[i] = 0;
    kernel_tss.ss0        = 0x10;                        /* kernel data segment */
    kernel_tss.iomap_base = (uint16_t)sizeof(tss_t); /* no I/O permission map */
}

void platform_tss_set_esp0(uint32_t kernel_stack_top) {
    kernel_tss.esp0 = kernel_stack_top;
}

/*
 * platform_gdt_install_tss()  [Phase 9]
 * Writes a 32-bit available TSS descriptor into GDT slot 5 (offset 0x28)
 * then executes `ltr` to make the CPU aware of the task register.
 *
 * GDT layout after Phase 9:
 *   0x00  null
 *   0x08  kernel code  (ring 0)
 *   0x10  kernel data  (ring 0)
 *   0x18  user code    (ring 3)
 *   0x20  user data    (ring 3)
 *   0x28  TSS          (DPL 0, type 0x9 = 32-bit available TSS)
 */
extern uint8_t gdt_start[];   /* defined in irq_asm.s */

void platform_gdt_install_tss(void) {
    uint32_t base  = (uint32_t)(uintptr_t)&kernel_tss;
    uint32_t limit = (uint32_t)sizeof(tss_t) - 1;

    /* GDT entry format (8 bytes):
     * [15: 0] limit[15:0]
     * [31:16] base[15:0]
     * [39:32] base[23:16]
     * [47:40] type/access:  P=1, DPL=0, S=0 (system), type=9 (32-bit avail TSS)
     * [51:48] limit[19:16]
     * [55:52] flags: G=0, D/B=0, L=0, AVL=0
     * [63:56] base[31:24]
     */
    uint8_t *entry = gdt_start + 0x28;   /* slot 5 */

    entry[0] = (uint8_t)(limit & 0xFF);
    entry[1] = (uint8_t)((limit >> 8) & 0xFF);
    entry[2] = (uint8_t)(base & 0xFF);
    entry[3] = (uint8_t)((base >> 8) & 0xFF);
    entry[4] = (uint8_t)((base >> 16) & 0xFF);
    entry[5] = 0x89;   /* P=1, DPL=0, S=0, type=9 (32-bit avail. TSS) */
    entry[6] = (uint8_t)((limit >> 16) & 0x0F);  /* limit[19:16], flags=0 */
    entry[7] = (uint8_t)((base >> 24) & 0xFF);

    /* Load Task Register with TSS selector 0x28 */
    __asm__ volatile("ltr %%ax" :: "a"((uint16_t)0x28));
}

/* ── Framebuffer blit ────────────────────────────────────────────────────── */

void platform_fb_blit(const uint32_t *src, int x, int y, int w, int h) {
    if (!_fb.available || _fb.bpp != 32) return;
    if (!_fb.address) return;
    if (x < 0 || y < 0) return;
    if ((uint32_t)x + (uint32_t)w > _fb.width)  w = (int)(_fb.width  - (uint32_t)x);
    if ((uint32_t)y + (uint32_t)h > _fb.height) h = (int)(_fb.height - (uint32_t)y);
    if (w <= 0 || h <= 0) return;

    uint32_t pitch_words = _fb.pitch / 4; /* pitch in 32-bit words */
    size_t row_bytes = (size_t)w * sizeof(uint32_t);
    for (int row = 0; row < h; row++) {
        uint32_t       *dst_row = _fb.address + (uint32_t)(y + row) * pitch_words + (uint32_t)x;
        const uint32_t *src_row = src + row * w;
        __builtin_memcpy(dst_row, src_row, row_bytes);
    }
}

/* ── Kernel panic ─────────────────────────────────────────────────── */

void platform_panic(const char *msg) {
    /* Disable interrupts so nothing preempts the panic output */
    __asm__ volatile("cli");
    serial_puts("\n\n*** KERNEL PANIC: ");
    if (msg) serial_puts(msg);
    else     serial_puts("(no message)");
    serial_puts(" ***\nSystem halted.\n");
    for (;;) __asm__ volatile("hlt");
}

/* ── MTRR Write-Combine (item 67) ──────────────────────────────────────── */
/*
 * MTRRs (Memory Type Range Registers) are 64-bit MSRs that allow the CPU to
 * map a physical address range to a caching type.
 *
 * MSRs used:
 *   0xFE  MTRRcap       — bits 7:0 = number of variable MTRRs available
 *   0x2FF MTRRdefType   — bit 11 = MTRR enable, bit 10 = fixed MTRR enable
 *   0x200 + 2*n  MTRRphysBaseN — [7:0] type, [35:12] base
 *   0x201 + 2*n  MTRRphysMaskN — bit 11 = valid, [35:12] mask
 *
 * Type 1 = Write Combining (WC) — ideal for linear framebuffer access.
 *
 * We find the first unused variable MTRR and program it.
 */

static inline void _wrmsr(uint32_t msr, uint64_t val) {
    __asm__ volatile("wrmsr" :: "c"(msr), "a"((uint32_t)val),
                                          "d"((uint32_t)(val >> 32)));
}
static inline uint64_t _rdmsr(uint32_t msr) {
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(msr));
    return ((uint64_t)hi << 32) | lo;
}

/* Round size up to the next power-of-two >= size (for MTRR mask) */
static uint32_t _next_pow2(uint32_t s) {
    if (s == 0) return 1;
    s--;
    s |= s >> 1; s |= s >> 2; s |= s >> 4; s |= s >> 8; s |= s >> 16;
    return s + 1u;
}

void platform_mtrr_set_wc(uint32_t phys_base, uint32_t size) {
    /* Check MTRR support via CPUID leaf 1 EDX bit 12 */
    uint32_t dummy, edx;
    __asm__ volatile("cpuid" : "=a"(dummy),"=b"(dummy),"=c"(dummy),"=d"(edx)
                             : "a"(1), "c"(0));
    if (!(edx & (1u << 12))) return; /* no MTRR */

    uint64_t mtrrcap  = _rdmsr(0xFE);
    int vcnt = (int)(mtrrcap & 0xFFu);

    /* Find first unused variable MTRR (valid bit 11 of mask MSR = 0) */
    int slot = -1;
    for (int i = 0; i < vcnt; i++) {
        uint64_t mask = _rdmsr(0x201u + (uint32_t)(i * 2));
        if (!(mask & (1ull << 11))) { slot = i; break; }
    }
    if (slot < 0) return; /* no free slot */

    uint32_t aligned_size = _next_pow2(size);
    /* MTRR mask covers 36-bit physical; PA_BITS for i686 = 32 */
    uint64_t base_msr = ((uint64_t)phys_base & ~0xFFFull) | 0x01ull; /* type WC=1 */
    uint64_t mask_msr = (~((uint64_t)aligned_size - 1u) & 0xFFFFF000ull)
                        | (1ull << 11); /* valid */

    /* Disable caches & MTRRs during update (Intel SDM Vol 3 §11.11.8) */
    uint32_t cr0;
    __asm__ volatile("mov %%cr0, %0" : "=r"(cr0));
    __asm__ volatile("wbinvd");
    __asm__ volatile("mov %0, %%cr0" :: "r"(cr0 | 0x40000000u)); /* set CD */
    __asm__ volatile("wbinvd");

    uint64_t def = _rdmsr(0x2FF);
    _wrmsr(0x2FF, def & ~(1ull << 11));  /* disable MTRRs */

    _wrmsr(0x200u + (uint32_t)(slot * 2),     base_msr);
    _wrmsr(0x201u + (uint32_t)(slot * 2),     mask_msr);

    _wrmsr(0x2FF, def | (1ull << 11));   /* re-enable MTRRs */

    __asm__ volatile("wbinvd");
    __asm__ volatile("mov %0, %%cr0" :: "r"(cr0));  /* restore CD */
}

/* ── VBE / EDID stub (item 66) ──────────────────────────────────────────── */
/*
 * On JSOS, GRUB negotiates the VBE/GOP mode before jumping to the kernel.
 * The framebuffer details are passed via the Multiboot2 framebuffer tag (type 8).
 * We simply read them back — no direct EDID I2C DDC access needed.
 */
int platform_edid_get_preferred(uint32_t *out_w, uint32_t *out_h) {
    if (!out_w || !out_h) return -1;
    fb_info_t fb;
    platform_fb_get_info(&fb);
    if (!fb.available) return -1;
    *out_w = fb.width;
    *out_h = fb.height;
    return 0;
}

/* ── Double-buffered framebuffer (item 70) ──────────────────────────────── */

static uint32_t *_backbuf      = 0;   /* allocated back-buffer */
static uint32_t  _backbuf_addr = 0;

int platform_fb_alloc_backbuffer(void) {
    if (_backbuf) return 0;   /* already allocated */
    if (!_fb.available) return -1;
    uint32_t fb_size = _fb.pitch * _fb.height;
    /* Allocate physically contiguous pages for the back-buffer */
    uint32_t npages = (fb_size + 4095u) >> 12u;
    extern uint32_t alloc_pages(uint32_t);
    uint32_t phys = alloc_pages(npages);
    if (!phys) return -1;
    _backbuf      = (uint32_t *)phys;
    _backbuf_addr = phys;
    return 0;
}

void platform_fb_flip(void) {
    if (!_backbuf || !_fb.available) return;
    uint32_t words = (_fb.pitch * _fb.height) >> 2u;
    uint32_t *src = _backbuf;
    uint32_t *dst = _fb.address;
    /* Simple 32-bit word copy: equivalent to memcpy but avoids libc dep */
    for (uint32_t i = 0u; i < words; i++) dst[i] = src[i];
}

uint32_t platform_fb_backbuffer_addr(void) {
    return _backbuf ? _backbuf_addr : (uint32_t)(uintptr_t)_fb.address;
}

/* ── VGA retrace / vsync (item 71) ─────────────────────────────────────── */

#define VGA_INPUT_STATUS_1  0x3DAu  /* colour mode; read resets ATC flip-flop */
#define VGA_VBLANK_BIT      (1u << 3)
#define VGA_RETRACE_BIT     (1u << 3)

void platform_vsync_wait(void) {
    /* Wait for vertical retrace start (bit 3 high in VGA Input Status 1).
     * First wait if we are currently IN vblank, so we catch the NEXT one. */
    while (  inb(VGA_INPUT_STATUS_1) & VGA_VBLANK_BIT) ; /* wait until out */
    while (!(inb(VGA_INPUT_STATUS_1) & VGA_VBLANK_BIT)) ; /* wait until in  */
}

/* ── Hardware cursor (item 69) ──────────────────────────────────────────── */

#define VGA_CRTC_INDEX  0x3D4u
#define VGA_CRTC_DATA   0x3D5u

void platform_cursor_enable(int enable) {
    /* CRTC reg 0x0A = cursor start scan line; bit 5 = cursor disable */
    outb(VGA_CRTC_INDEX, 0x0Au);
    uint8_t val = inb(VGA_CRTC_DATA);
    if (enable) val &= ~(1u << 5u);
    else        val |=  (1u << 5u);
    outb(VGA_CRTC_DATA, val);
}

void platform_cursor_set_pos(uint8_t col, uint8_t row) {
    uint16_t pos = (uint16_t)(row * VGA_WIDTH + col);
    outb(VGA_CRTC_INDEX, 0x0Fu); outb(VGA_CRTC_DATA, (uint8_t)(pos & 0xFFu));
    outb(VGA_CRTC_INDEX, 0x0Eu); outb(VGA_CRTC_DATA, (uint8_t)(pos >> 8u));
}

void platform_cursor_set_shape(uint8_t start_line, uint8_t end_line) {
    outb(VGA_CRTC_INDEX, 0x0Au);
    uint8_t cur = inb(VGA_CRTC_DATA);
    outb(VGA_CRTC_DATA, (cur & 0xC0u) | (start_line & 0x1Fu));
    outb(VGA_CRTC_INDEX, 0x0Bu);
    outb(VGA_CRTC_DATA, (uint8_t)(end_line & 0x1Fu));
}

/* ── VESA DPMS (item 72) ─────────────────────────────────────────────────── */

void platform_dpms_set(dpms_state_t state) {
    /* DPMS is implemented via the VGA Attribute Controller register 0 and
     * Sequencer register 1. Simplest portable method: write to port 0x3C4
     * (screen off via Clocking Mode) for STANDBY/SUSPEND/OFF.             */
    uint8_t seq1;
    outb(0x3C4u, 0x01u);  /* index SR1 */
    seq1 = inb(0x3C5u);

    if (state == DPMS_ON) {
        seq1 &= ~(1u << 5u);      /* clear Screen Off bit */
    } else {
        seq1 |=  (1u << 5u);      /* set Screen Off bit */
    }
    /* Toggle screen off in sync with the start of a retrace */
    outb(0x3C2u, inb(0x3CCu));   /* preserve Misc Output */
    outb(0x3C4u, 0x01u);
    outb(0x3C5u, seq1);
    /* For STANDBY/SUSPEND/OFF also toggle H/V sync via VGA Feature Control */
    uint8_t fc = (state == DPMS_ON)      ? 0x00u
               : (state == DPMS_STANDBY) ? 0x01u
               : (state == DPMS_SUSPEND) ? 0x02u
               :                           0x03u;
    outb(0x3DAu, fc);   /* write to VGA Feature Control (colour, write-only) */
}


