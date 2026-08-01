/*
 * floppy.h — Legacy floppy disk controller driver (item 86)
 *
 * Drives the Intel 82077AA / NEC µPD765 compatible FDC at I/O 0x3F0.
 * Supports 3.5" 1.44 MB drives only.
 */
#ifndef FLOPPY_H
#define FLOPPY_H

#include <stdint.h>

#define FDC_BASE        0x3F0u   /* Primary FDC I/O base */
#define FLOPPY_SECTOR_SIZE 512u
#define FLOPPY_SECTORS_PER_TRACK 18u
#define FLOPPY_HEADS    2u
#define FLOPPY_TRACKS   80u
#define FLOPPY_CAPACITY (FLOPPY_SECTORS_PER_TRACK * FLOPPY_HEADS * FLOPPY_TRACKS)

/* floppy_init() — detect and initialise FDC; returns 1 if drive 0 present. */
int floppy_init(void);

/* floppy_present() — 1 if drive A: was detected. */
int floppy_present(void);

/* floppy_motor_on/off() — spin motor up/down. */
void floppy_motor_on(uint8_t drive);
void floppy_motor_off(uint8_t drive);

/* floppy_read_sector(track, head, sector, buf) — 512-byte sector read.
 * Returns 0 OK, -1 error. */
int floppy_read_sector(uint8_t track, uint8_t head, uint8_t sector, void *buf);

/* floppy_read_lba(lba, buf) — LBA convenience wrapper. */
int floppy_read_lba(uint32_t lba, void *buf);

/* floppy_sector_count() — total 512-byte sectors (2880 for 1.44M). */
uint32_t floppy_sector_count(void);

#endif /* FLOPPY_H */
