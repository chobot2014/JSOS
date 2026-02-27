/*
 * floppy.c — Legacy floppy disk controller driver (item 86)
 *
 * Implements basic DOR/MSR/FIFO programming for the 82077AA-compatible FDC.
 * DMA-based transfers use the i8237A legacy DMA controller (channel 2).
 */
#include "floppy.h"
#include "io.h"
#include "platform.h"
#include "timer.h"
#include <string.h>

/* FDC register offsets from FDC_BASE */
#define FDC_DOR   0u  /* Digital Output Register        */
#define FDC_MSR   4u  /* Main Status Register (read)     */
#define FDC_FIFO  5u  /* Data FIFO                       */
#define FDC_DIR   7u  /* Digital Input Register (read)   */
#define FDC_CCR   7u  /* Configuration Control (write)   */

/* DOR bits */
#define DOR_MOTOR_A  (1u << 4)
#define DOR_DMA_EN   (1u << 3)
#define DOR_RESET_N  (1u << 2)
#define DOR_SEL_A    0u

/* MSR bits */
#define MSR_RQM  (1u << 7)
#define MSR_DIO  (1u << 6)

static int _present = 0;

/* Wait until FDC is ready to accept a command byte (MSR.RQM=1, DIO=0) */
static int _fdc_wait_ready(void) {
    for (int i = 0; i < 10000; i++) {
        uint8_t msr = inb(FDC_BASE + FDC_MSR);
        if ((msr & (MSR_RQM | MSR_DIO)) == MSR_RQM) return 0;
    }
    return -1;
}

static void _fdc_send(uint8_t cmd) {
    _fdc_wait_ready();
    outb(FDC_BASE + FDC_FIFO, cmd);
}

int floppy_init(void) {
    /* Reset FDC */
    outb(FDC_BASE + FDC_DOR, 0x00);          /* assert RESET */
    timer_sleep_ms(2);
    outb(FDC_BASE + FDC_DOR, DOR_RESET_N | DOR_DMA_EN); /* deassert */
    timer_sleep_ms(2);

    /* Sense interrupt (×4 for four drives) to clear reset state */
    for (int i = 0; i < 4; i++) {
        _fdc_send(0x08);  /* SENSE INTERRUPT STATUS */
        uint8_t st0 = inb(FDC_BASE + FDC_FIFO);
        uint8_t pcn = inb(FDC_BASE + FDC_FIFO);
        (void)st0; (void)pcn;
    }

    /* Specify: SRT=8ms, HUT=240ms, HLT=16ms, NDMA=0 */
    _fdc_send(0x03);   /* SPECIFY */
    _fdc_send(0xAF);   /* SRT+HUT */
    _fdc_send(0x02);   /* HLT+NDMA */

    /* Check MSR to see if a drive responds */
    uint8_t msr = inb(FDC_BASE + FDC_MSR);
    _present = (msr != 0xFF) ? 1 : 0;

    if (_present)
        platform_boot_print("[FDC] Drive A: detected (1.44M stub, no DMA yet)\n");
    else
        platform_boot_print("[FDC] No floppy drive detected\n");

    return _present;
}

int floppy_present(void) { return _present; }

void floppy_motor_on(uint8_t drive) {
    (void)drive;
    outb(FDC_BASE + FDC_DOR, DOR_RESET_N | DOR_DMA_EN | DOR_MOTOR_A | DOR_SEL_A);
    timer_sleep_ms(300);  /* Motor spin-up */
}

void floppy_motor_off(uint8_t drive) {
    (void)drive;
    outb(FDC_BASE + FDC_DOR, DOR_RESET_N | DOR_DMA_EN);
}

int floppy_read_sector(uint8_t track, uint8_t head, uint8_t sector, void *buf) {
    /* Full DMA-based read requires i8237A + DMAC programming.
     * Stub: returns error until DMA layer is implemented. */
    (void)track; (void)head; (void)sector; (void)buf;
    return -1;
}

int floppy_read_lba(uint32_t lba, void *buf) {
    uint8_t track  = (uint8_t)(lba / (FLOPPY_SECTORS_PER_TRACK * FLOPPY_HEADS));
    uint8_t head   = (uint8_t)((lba / FLOPPY_SECTORS_PER_TRACK) % FLOPPY_HEADS);
    uint8_t sector = (uint8_t)((lba % FLOPPY_SECTORS_PER_TRACK) + 1u);
    return floppy_read_sector(track, head, sector, buf);
}

uint32_t floppy_sector_count(void) {
    return _present ? (uint32_t)FLOPPY_CAPACITY : 0u;
}
