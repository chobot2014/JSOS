#include "irq.h"
#include "io.h"
#include <stddef.h>

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

/* Assembly ISR stubs - defined in irq_asm.s */
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
    
    /* Install IRQ handlers (ISR 32-47) */
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
    if (irq_num >= 0 && irq_num < IRQ_COUNT && irq_handlers[irq_num]) {
        irq_handlers[irq_num]();
    }
    irq_send_eoi(irq_num);
}
