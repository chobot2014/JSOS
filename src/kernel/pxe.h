/*
 * pxe.h — PXE / network boot detection stub (item 17)
 *
 * Provides APIs for detecting whether the kernel was loaded via PXE and for
 * reading DHCP lease information passed by the boot firmware.
 */
#ifndef PXE_H
#define PXE_H

#include <stdint.h>

typedef struct {
    uint8_t  client_ip[4];    /* Our IP address from DHCP */
    uint8_t  server_ip[4];    /* TFTP server IP */
    uint8_t  gateway_ip[4];   /* Default gateway */
    uint8_t  netmask[4];      /* Subnet mask */
    char     boot_file[128];  /* Filename of the file that was loaded */
    char     server_name[64]; /* Boot server hostname (optional) */
    int      valid;           /* Non-zero if PXE lease data is available */
} pxe_boot_info_t;

/*
 * Initialise PXE detection from the kernel command line and/or MB2 tags.
 * Must be called after cmdline_init() and memory_init_from_mb2().
 *
 * @param mb2_info_addr MB2 information block physical address (0 for none).
 */
void pxe_init(uint32_t mb2_info_addr);

/*
 * Return non-zero if the kernel appears to have been network-booted via PXE.
 */
int pxe_is_netboot(void);

/*
 * Return a pointer to the PXE DHCP lease information parsed during pxe_init().
 * The struct is zeroed when pxe_is_netboot() returns 0.
 */
const pxe_boot_info_t *pxe_get_info(void);

/*
 * Attempt to retrieve an additional file from the TFTP server that provided
 * the kernel image.  Writes up to *len bytes into buf and updates *len to the
 * number of bytes actually received.
 * Returns 0 on success, -1 on error or when not running from a PXE boot.
 */
int pxe_tftp_get(const char *filename, void *buf, uint32_t *len);

#endif /* PXE_H */
