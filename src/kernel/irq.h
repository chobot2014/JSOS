#ifndef IRQ_H
#define IRQ_H

#include <stdint.h>

/* IDT entry structure */
struct idt_entry {
    uint16_t base_lo;
    uint16_t sel;
    uint8_t  always0;
    uint8_t  flags;
    uint16_t base_hi;
} __attribute__((packed));

/* IDT pointer structure */
struct idt_ptr {
    uint16_t limit;
    uint32_t base;
} __attribute__((packed));

/* Maximum number of IRQ handlers */
#define IRQ_COUNT 16

/* Function pointer type for IRQ handlers */
typedef void (*irq_handler_t)(void);

/* Initialize the IDT and PIC */
void irq_initialize(void);

/* Install a handler for a specific IRQ */
void irq_install_handler(int irq, irq_handler_t handler);

/* Remove a handler for a specific IRQ */
void irq_uninstall_handler(int irq);

/* Send End-Of-Interrupt signal to PIC */
void irq_send_eoi(int irq);

/* Phase 9: int 0x80 syscall dispatcher (called from ring-3 via gate) */
int syscall_dispatch(int num, int arg1, int arg2, int arg3);

#endif /* IRQ_H */
