#include "irq.h"
#include "io.h"
#include "keyboard.h"
#include "mouse.h"
#include "platform.h"
#include <stddef.h>

/* ── CPU exception dispatcher ───────────────────────────────────────────── */

/* Minimal serial hex printer for use inside exception_dispatch.
 * No libc available; avoids recursion / dynamic allocation. */
static void _exc_hex32(uint32_t v) {
    static const char _h[] = "0123456789ABCDEF";
    char buf[11];
    buf[0]  = '0'; buf[1]  = 'x';
    buf[2]  = _h[(v >> 28) & 0xF];
    buf[3]  = _h[(v >> 24) & 0xF];
    buf[4]  = _h[(v >> 20) & 0xF];
    buf[5]  = _h[(v >> 16) & 0xF];
    buf[6]  = _h[(v >> 12) & 0xF];
    buf[7]  = _h[(v >>  8) & 0xF];
    buf[8]  = _h[(v >>  4) & 0xF];
    buf[9]  = _h[(v >>  0) & 0xF];
    buf[10] = '\0';
    platform_serial_puts(buf);
}
static void _exc_reg(const char *name, uint32_t v) {
    platform_serial_puts(name);
    platform_serial_puts(" = ");
    _exc_hex32(v);
    platform_serial_puts("\n");
}

void exception_dispatch(exception_frame_t *f) {
    static const char * const _names[32] = {
        "#DE Divide-by-zero",       "#DB Debug",
        "NMI",                      "#BP Breakpoint",
        "#OF Overflow",             "#BR Bound Range",
        "#UD Invalid Opcode",       "#NM Device Not Available",
        "#DF Double Fault",         "Coprocessor Seg Overrun",
        "#TS Invalid TSS",          "#NP Segment Not Present",
        "#SS Stack-Segment Fault",  "#GP General Protection",
        "#PF Page Fault",           "Reserved-15",
        "#MF x87 FP Exception",     "#AC Alignment Check",
        "#MC Machine Check",        "#XM SIMD Exception",
        "#VE Virtualization",       "#CP Control-Protection",
        "Reserved-22", "Reserved-23", "Reserved-24", "Reserved-25",
        "Reserved-26", "Reserved-27", "Reserved-28", "Reserved-29",
        "#SX Security Exception",   "Reserved-31"
    };

    const char *name = (f->vector < 32) ? _names[f->vector] : "Unknown";

    platform_serial_puts("\n\n*** KERNEL EXCEPTION ***  ");
    platform_serial_puts(name);
    platform_serial_puts("\n");

    _exc_reg("EIP   ", f->eip);
    _exc_reg("CS    ", f->cs);
    _exc_reg("EFLAGS", f->eflags);
    _exc_reg("EAX   ", f->eax);
    _exc_reg("ECX   ", f->ecx);
    _exc_reg("EDX   ", f->edx);
    _exc_reg("EBX   ", f->ebx);
    _exc_reg("EBP   ", f->ebp);
    _exc_reg("ESI   ", f->esi);
    _exc_reg("EDI   ", f->edi);
    _exc_reg("DS    ", f->ds);
    _exc_reg("ERR   ", f->error_code);

    /* For #PF also print CR2 (faulting linear address) */
    if (f->vector == 14) {
        uint32_t cr2;
        __asm__ volatile("mov %%cr2, %0" : "=r"(cr2));
        _exc_reg("CR2   ", cr2);
    }

    /* For #XM SIMD floating-point exception (vector 19, item 32):
     * read MXCSR to identify which SSE exception fired (invalid op,
     * denormal, divide-by-zero, overflow, underflow, precision).       */
    if (f->vector == 19) {
        uint32_t mxcsr = 0u;
        __asm__ volatile("stmxcsr %0" : "=m"(mxcsr));
        _exc_reg("MXCSR ", mxcsr);
        /* Decode sticky flag bits [5:0] */
        platform_serial_puts("  SIMD flags:");
        if (mxcsr & 0x01u) platform_serial_puts(" IE(#I)");
        if (mxcsr & 0x02u) platform_serial_puts(" DE(#D)");
        if (mxcsr & 0x04u) platform_serial_puts(" ZE(#Z)");
        if (mxcsr & 0x08u) platform_serial_puts(" OE(#O)");
        if (mxcsr & 0x10u) platform_serial_puts(" UE(#U)");
        if (mxcsr & 0x20u) platform_serial_puts(" PE(#P)");
        platform_serial_puts("\n");
    }

    /* Vector 3 (#BP): kprobe INT3 handler — item 110 */
    if (f->vector == 3) {
        extern int kprobes_bp_handler(uint32_t *eip_ptr, uint32_t *eflags_ptr);
        if (kprobes_bp_handler(&f->eip, &f->eflags)) return;
    }
    /* Vector 1 (#DB): kprobe single-step re-arm — item 110 */
    if (f->vector == 1) {
        extern int kprobes_db_handler(uint32_t eip, uint32_t *eflags_ptr);
        if (kprobes_db_handler(f->eip, &f->eflags)) return;
    }

    platform_serial_puts("System halted.\n");
    __asm__ volatile("cli; hlt");
    for (;;); /* unreachable — suppress noreturn warning via loop */
}

/* ── Phase 9: int 0x80 syscall dispatcher ───────────────────────────────── */

/* JSOS syscall numbers used by Chromium's JsosEventSource (ring-3). */
#define JSOS_SYS_KEY_READ    0x50
#define JSOS_SYS_MOUSE_READ  0x51

/* Multi-value output struct for syscalls that return more than one register.
 * Single-threaded OS — a global is fine. */
struct {
    int ebx_out;
    int ecx_out;
    int edx_out;
} syscall_out;

/*
 * syscall_dispatch() — called from syscall_asm (irq_asm.s) when ring-3
 * code executes 'int 0x80'.  Returns the primary result in EAX.
 * Additional return values are placed in syscall_out for the assembly stub
 * to load into EBX/ECX/EDX before iretd.
 */
int syscall_dispatch(int num, int arg1, int arg2, int arg3)
{
    (void)arg1; (void)arg2; (void)arg3;
    syscall_out.ebx_out = 0;
    syscall_out.ecx_out = 0;
    syscall_out.edx_out = 0;

    switch (num) {
        case JSOS_SYS_KEY_READ: {
            /* Return the next key from the keyboard buffer.
             * keyboard_poll() returns 0 if the queue is empty.
             * For special/extended keys, OR in the extended code. */
            char ch = keyboard_poll();
            if (ch == 0) {
                int ext = keyboard_get_extended();
                return ext;   /* 0 = empty, >0 = special key code */
            }
            return (int)(unsigned char)ch;
        }
        case JSOS_SYS_MOUSE_READ: {
            /* Return 1 if a packet is available; set EBX/ECX/EDX to dx/dy/buttons. */
            mouse_packet_t pkt;
            if (mouse_read(&pkt)) {
                syscall_out.ebx_out = (int)pkt.dx;
                syscall_out.ecx_out = -(int)pkt.dy; /* PS/2 y-axis is inverted */
                syscall_out.edx_out = (int)pkt.buttons;
                return 1;
            }
            return 0;
        }
        default:
            return -1;
    }
}

/* PIC ports */
#define PIC1_COMMAND 0x20
#define PIC1_DATA    0x21
#define PIC2_COMMAND 0xA0
#define PIC2_DATA    0xA1

/* PIC commands */
#define PIC_EOI      0x20
#define ICW1_INIT    0x11
#define ICW4_8086    0x01

/* IDT with 256 entries */
static struct idt_entry idt[256];
static struct idt_ptr   idtp;

/* IRQ handler function pointers */
static irq_handler_t irq_handlers[IRQ_COUNT] = { NULL };

/* Set an IDT entry */
static void idt_set_gate(uint8_t num, uint32_t base, uint16_t sel, uint8_t flags) {
    idt[num].base_lo = (base & 0xFFFF);
    idt[num].base_hi = (base >> 16) & 0xFFFF;
    idt[num].sel     = sel;
    idt[num].always0 = 0;
    idt[num].flags   = flags;
}

/* Remap the PIC to use IRQ 32-47 instead of 0-15 */
static void pic_remap(void) {
    uint8_t mask1, mask2;
    
    /* Save masks */
    mask1 = inb(PIC1_DATA);
    mask2 = inb(PIC2_DATA);
    
    /* Start initialization sequence */
    outb(PIC1_COMMAND, ICW1_INIT);
    io_wait();
    outb(PIC2_COMMAND, ICW1_INIT);
    io_wait();
    
    /* Set vector offsets */
    outb(PIC1_DATA, 0x20);  /* IRQ 0-7  -> INT 32-39 */
    io_wait();
    outb(PIC2_DATA, 0x28);  /* IRQ 8-15 -> INT 40-47 */
    io_wait();
    
    /* Tell Master PIC about Slave PIC at IRQ2 */
    outb(PIC1_DATA, 0x04);
    io_wait();
    outb(PIC2_DATA, 0x02);
    io_wait();
    
    /* Set 8086/88 mode */
    outb(PIC1_DATA, ICW4_8086);
    io_wait();
    outb(PIC2_DATA, ICW4_8086);
    io_wait();
    
    /* Restore saved masks */
    outb(PIC1_DATA, mask1);
    outb(PIC2_DATA, mask2);
}

/* IRQ stubs (ISR 32-47) defined in irq_asm.s */
extern void irq0(void);
extern void irq1(void);
extern void irq2(void);
extern void irq3(void);
extern void irq4(void);
extern void irq5(void);
extern void irq6(void);
extern void irq7(void);
extern void irq8(void);
extern void irq9(void);
extern void irq10(void);
extern void irq11(void);
extern void irq12(void);
extern void irq13(void);
extern void irq14(void);
extern void irq15(void);

/* CPU exception stubs (ISR 0-31) defined in irq_asm.s */
extern void isr0(void);  extern void isr1(void);  extern void isr2(void);
extern void isr3(void);  extern void isr4(void);  extern void isr5(void);
extern void isr6(void);  extern void isr7(void);  extern void isr8(void);
extern void isr9(void);  extern void isr10(void); extern void isr11(void);
extern void isr12(void); extern void isr13(void); extern void isr14(void);
extern void isr15(void); extern void isr16(void); extern void isr17(void);
extern void isr18(void); extern void isr19(void); extern void isr20(void);
extern void isr21(void); extern void isr22(void); extern void isr23(void);
extern void isr24(void); extern void isr25(void); extern void isr26(void);
extern void isr27(void); extern void isr28(void); extern void isr29(void);
extern void isr30(void); extern void isr31(void);

void irq_initialize(void) {
    /* Remap the PIC */
    pic_remap();
    
    /* Set up IDT pointer */
    idtp.limit = (sizeof(struct idt_entry) * 256) - 1;
    idtp.base  = (uint32_t)&idt;
    
    /* Clear all IDT entries */
    for (int i = 0; i < 256; i++) {
        idt_set_gate(i, 0, 0, 0);
    }
    
    /* Install CPU exception handlers (IDT vectors 0-31) */
    idt_set_gate( 0, (uint32_t)isr0,  0x08, 0x8E);
    idt_set_gate( 1, (uint32_t)isr1,  0x08, 0x8E);
    idt_set_gate( 2, (uint32_t)isr2,  0x08, 0x8E);
    idt_set_gate( 3, (uint32_t)isr3,  0x08, 0x8F); /* DPL=3: allow int 3 from ring-3 */
    idt_set_gate( 4, (uint32_t)isr4,  0x08, 0x8E);
    idt_set_gate( 5, (uint32_t)isr5,  0x08, 0x8E);
    idt_set_gate( 6, (uint32_t)isr6,  0x08, 0x8E);
    idt_set_gate( 7, (uint32_t)isr7,  0x08, 0x8E);
    idt_set_gate( 8, (uint32_t)isr8,  0x08, 0x8E);
    idt_set_gate( 9, (uint32_t)isr9,  0x08, 0x8E);
    idt_set_gate(10, (uint32_t)isr10, 0x08, 0x8E);
    idt_set_gate(11, (uint32_t)isr11, 0x08, 0x8E);
    idt_set_gate(12, (uint32_t)isr12, 0x08, 0x8E);
    idt_set_gate(13, (uint32_t)isr13, 0x08, 0x8E);
    idt_set_gate(14, (uint32_t)isr14, 0x08, 0x8E);
    idt_set_gate(15, (uint32_t)isr15, 0x08, 0x8E);
    idt_set_gate(16, (uint32_t)isr16, 0x08, 0x8E);
    idt_set_gate(17, (uint32_t)isr17, 0x08, 0x8E);
    idt_set_gate(18, (uint32_t)isr18, 0x08, 0x8E);
    idt_set_gate(19, (uint32_t)isr19, 0x08, 0x8E);
    idt_set_gate(20, (uint32_t)isr20, 0x08, 0x8E);
    idt_set_gate(21, (uint32_t)isr21, 0x08, 0x8E);
    idt_set_gate(22, (uint32_t)isr22, 0x08, 0x8E);
    idt_set_gate(23, (uint32_t)isr23, 0x08, 0x8E);
    idt_set_gate(24, (uint32_t)isr24, 0x08, 0x8E);
    idt_set_gate(25, (uint32_t)isr25, 0x08, 0x8E);
    idt_set_gate(26, (uint32_t)isr26, 0x08, 0x8E);
    idt_set_gate(27, (uint32_t)isr27, 0x08, 0x8E);
    idt_set_gate(28, (uint32_t)isr28, 0x08, 0x8E);
    idt_set_gate(29, (uint32_t)isr29, 0x08, 0x8E);
    idt_set_gate(30, (uint32_t)isr30, 0x08, 0x8E);
    idt_set_gate(31, (uint32_t)isr31, 0x08, 0x8E);

    /* Install hardware IRQ handlers (ISR 32-47) */
    idt_set_gate(32, (uint32_t)irq0,  0x08, 0x8E);
    idt_set_gate(33, (uint32_t)irq1,  0x08, 0x8E);
    idt_set_gate(34, (uint32_t)irq2,  0x08, 0x8E);
    idt_set_gate(35, (uint32_t)irq3,  0x08, 0x8E);
    idt_set_gate(36, (uint32_t)irq4,  0x08, 0x8E);
    idt_set_gate(37, (uint32_t)irq5,  0x08, 0x8E);
    idt_set_gate(38, (uint32_t)irq6,  0x08, 0x8E);
    idt_set_gate(39, (uint32_t)irq7,  0x08, 0x8E);
    idt_set_gate(40, (uint32_t)irq8,  0x08, 0x8E);
    idt_set_gate(41, (uint32_t)irq9,  0x08, 0x8E);
    idt_set_gate(42, (uint32_t)irq10, 0x08, 0x8E);
    idt_set_gate(43, (uint32_t)irq11, 0x08, 0x8E);
    idt_set_gate(44, (uint32_t)irq12, 0x08, 0x8E);
    idt_set_gate(45, (uint32_t)irq13, 0x08, 0x8E);
    idt_set_gate(46, (uint32_t)irq14, 0x08, 0x8E);
    idt_set_gate(47, (uint32_t)irq15, 0x08, 0x8E);
    
    /* Phase 9: install int 0x80 syscall gate with DPL=3 so ring-3 can call it.
     * Flags 0xEE = Present(1) | DPL(11) | StorageSeg(0) | GateType(1110 = 32-bit int).
     * The selector is 0x08 (kernel code segment) — the CPU switches to ring-0
     * automatically and loads ESP0 from the TSS for the kernel stack. */
    extern void syscall_asm(void);
    idt_set_gate(0x80, (uint32_t)syscall_asm, 0x08, 0xEE);

    /* Load IDT */
    __asm__ volatile ("lidt (%0)" : : "r"(&idtp));

    /* Enable only IRQ 0 (timer) and IRQ 1 (keyboard), mask the rest */
    outb(PIC1_DATA, 0xFC);  /* 11111100 - enable IRQ0 and IRQ1 */
    outb(PIC2_DATA, 0xFF);  /* Mask all on slave PIC */
    
    /* Enable interrupts */
    __asm__ volatile ("sti");
}

void irq_install_handler(int irq, irq_handler_t handler) {
    if (irq >= 0 && irq < IRQ_COUNT) {
        irq_handlers[irq] = handler;
        /* Unmask the IRQ in the PIC so it can actually fire */
        if (irq < 8) {
            uint8_t mask = inb(PIC1_DATA);
            mask &= ~(uint8_t)(1u << irq);
            outb(PIC1_DATA, mask);
        } else {
            /* Slave PIC IRQs also require IRQ2 (cascade) on master to be unmasked */
            uint8_t master = inb(PIC1_DATA);
            master &= ~(uint8_t)(1u << 2);   /* unmask IRQ2 cascade */
            outb(PIC1_DATA, master);
            uint8_t slave = inb(PIC2_DATA);
            slave &= ~(uint8_t)(1u << (irq - 8));
            outb(PIC2_DATA, slave);
        }
    }
}

void irq_uninstall_handler(int irq) {
    if (irq >= 0 && irq < IRQ_COUNT) {
        irq_handlers[irq] = NULL;
    }
}

void irq_send_eoi(int irq) {
    if (irq >= 8) {
        outb(PIC2_COMMAND, PIC_EOI);
    }
    outb(PIC1_COMMAND, PIC_EOI);
}

/* Called from assembly ISR stubs */
void irq_handler_dispatch(int irq_num) {
    /* Spurious IRQ detection (Intel 8259A §4.3):
     * A spurious IRQ occurs when the CPU acknowledges an IRQ that the PIC
     * has already de-asserted.  In that case the PIC's In-Service Register
     * (ISR) bit for the IRQ is NOT set — it was never latched.
     *
     * IRQ 7  (master PIC): read master ISR, skip if bit 7 clear.
     *                       No EOI needed (PIC never set its ISR bit).
     * IRQ 15 (slave PIC):  read slave  ISR, skip slave EOI if bit 7 clear;
     *                       still send master EOI for the cascaded IRQ 2.
     */
    if (irq_num == 7) {
        outb(PIC1_COMMAND, 0x0B);          /* OCW3: read ISR */
        uint8_t pic1_isr = inb(PIC1_COMMAND);
        if (!(pic1_isr & (1u << 7))) return; /* spurious — do not EOI */
    }
    if (irq_num == 15) {
        outb(PIC2_COMMAND, 0x0B);          /* OCW3: read slave ISR */
        uint8_t pic2_isr = inb(PIC2_COMMAND);
        if (!(pic2_isr & (1u << 7))) {
            outb(PIC1_COMMAND, PIC_EOI);   /* master EOI for cascaded IRQ2 */
            return;
        }
    }

    if (irq_num >= 0 && irq_num < IRQ_COUNT && irq_handlers[irq_num]) {
        irq_handlers[irq_num]();
    }
    irq_send_eoi(irq_num);
}

/* ── IRQ priority level via LAPIC TPR (item 26) ──────────────────────────── *
 *
 * Local APIC TPR layout (LAPIC offset 0x80):
 *   Bits [7:4] = Task-Priority Class (filters out all vectors in that class
 *                and below:  vector < (class << 4) is masked).
 *   Bits [3:0] = Task-Priority Sub-class (not used here).
 *
 * The LAPIC base is read from MSR 0x1B (IA32_APIC_BASE).  Default = 0xFEE00000.
 * Writing is a no-op if the APIC enable bit (MSR bit 11) is clear.
 */

static uint32_t _lapic_base_addr(void) {
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0x1Bu));
    /* Bits [35:12] hold the physical base; in 32-bit mode bits [35:32] are
     * in hi but will be zero on any machine with <4GB physical RAM.         */
    (void)hi;
    uint32_t base = lo & 0xFFFFF000u;
    return base ? base : 0xFEE00000u;   /* fall back to architectural default */
}

void irq_set_tpr(uint8_t irq_class) {
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0x1Bu));
    (void)hi;
    if (!(lo & (1u << 11))) return;      /* APIC software enable bit clear: no-op */
    volatile uint32_t *tpr = (volatile uint32_t *)(_lapic_base_addr() + 0x80u);
    *tpr = ((uint32_t)irq_class & 0xFu) << 4;
}

uint8_t irq_get_tpr(void) {
    uint32_t lo, hi;
    __asm__ volatile("rdmsr" : "=a"(lo), "=d"(hi) : "c"(0x1Bu));
    (void)hi;
    if (!(lo & (1u << 11))) return 0;
    volatile uint32_t *tpr = (volatile uint32_t *)(_lapic_base_addr() + 0x80u);
    return (uint8_t)((*tpr >> 4) & 0xFu);
}

/* ── 8259 PIC mask helpers (used by selftest, item 108) ───────────────────────── */

/* IRQ 0-7 → master PIC (0x21); IRQ 8-15 → slave PIC (0xA1). */
void irq_mask(uint8_t irq) {
    uint16_t port = (irq < 8) ? 0x21u : 0xA1u;
    uint8_t  bit  = (irq < 8) ? irq   : (uint8_t)(irq - 8);
    uint8_t  val  = inb(port);
    outb(port, val | (uint8_t)(1u << bit));
}

void irq_unmask(uint8_t irq) {
    uint16_t port = (irq < 8) ? 0x21u : 0xA1u;
    uint8_t  bit  = (irq < 8) ? irq   : (uint8_t)(irq - 8);
    uint8_t  val  = inb(port);
    outb(port, val & (uint8_t)~(1u << bit));
}

int irq_is_masked(uint8_t irq) {
    uint16_t port = (irq < 8) ? 0x21u : 0xA1u;
    uint8_t  bit  = (irq < 8) ? irq   : (uint8_t)(irq - 8);
    return (inb(port) >> bit) & 1u;
}
