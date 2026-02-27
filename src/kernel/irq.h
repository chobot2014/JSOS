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

/* IRQ priority level (Task Priority Register) — item 26.
 * class: high nibble of TPR (0 = accept all, 15 = accept nothing).
 * Reads/writes LAPIC TPR at default base 0xFEE00080 via MSR 0x1B.
 * No-op if LAPIC is not available. */
void    irq_set_tpr(uint8_t irq_class);
uint8_t irq_get_tpr(void);

/*
 * CPU exception frame layout on the stack when exception_dispatch() is called.
 * Stack grows down; lowest address = lowest offset below:
 *
 *  [0]  ds           — pushed by exception_common_stub after pusha
 *  [4]  edi          ─┐
 *  [8]  esi           │
 *  [12] ebp           │  pusha register save (order: edi,esi,ebp,
 *  [16] esp_dummy     │                             esp_dummy,ebx,edx,ecx,eax)
 *  [20] ebx           │
 *  [24] edx           │
 *  [28] ecx           │
 *  [32] eax          ─┘
 *  [36] vector        — pushed by ISR_NOERR/ISR_ERR stub
 *  [40] error_code    — pushed by stub (dummy 0) or by CPU
 *  [44] eip           ─┐
 *  [48] cs             │  pushed by CPU on exception entry
 *  [52] eflags        ─┘
 */
typedef struct {
    uint32_t ds;
    uint32_t edi, esi, ebp, esp_dummy, ebx, edx, ecx, eax;  /* pusha order */
    uint32_t vector;
    uint32_t error_code;
    uint32_t eip, cs, eflags;   /* CPU-pushed */
} __attribute__((packed)) exception_frame_t;

/* Exception dispatcher — called from irq_asm.s exception_common_stub */
void exception_dispatch(exception_frame_t *frame);

/* 8259 PIC mask helpers — item 3 (selftest uses irq_is_masked) */
void    irq_mask(uint8_t irq);       /* mask IRQ line at 8259 PIC */
void    irq_unmask(uint8_t irq);     /* unmask IRQ line at 8259 PIC */
int     irq_is_masked(uint8_t irq);  /* 1 if masked, 0 if active */

#endif /* IRQ_H */
