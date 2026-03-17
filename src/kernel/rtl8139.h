/*
 * Realtek RTL8139 Ethernet Driver Stub  (item 91)
 *
 * RTL8139 uses I/O ports (BAR0 is an I/O space BAR).
 * Provides rx ring buffer + PIO transmit.
 * PCI ID: 0x10EC:0x8139
 */
#ifndef RTL8139_H
#define RTL8139_H

#include <stdint.h>

/* I/O port offsets from BAR0 */
#define RTL_REG_MAC0        0x00u  /* 6 bytes MAC address                   */
#define RTL_REG_MAR0        0x08u  /* Multicast filter (8 bytes)            */
#define RTL_REG_TXSTATUS0   0x10u  /* TX status 0-3 (4 × uint32)           */
#define RTL_REG_TXADDR0     0x20u  /* TX buffer physical addresses (4×u32)  */
#define RTL_REG_RBSTART     0x30u  /* RX ring buffer start address          */
#define RTL_REG_CMD         0x37u  /* Command register                      */
#define RTL_REG_CAPR        0x38u  /* Current address of packet read        */
#define RTL_REG_IMR         0x3Cu  /* Interrupt Mask                        */
#define RTL_REG_ISR         0x3Eu  /* Interrupt Status                      */
#define RTL_REG_TCR         0x40u  /* TX Config register                    */
#define RTL_REG_RCR         0x44u  /* RX Config register                    */
#define RTL_REG_CONFIG1     0x52u  /* Config 1                              */

#define RTL_RX_BUF_SIZE  (8192u + 16u + 1500u)   /* typical Rx ring         */
#define RTL_NUM_TX       4u                        /* 4 TX descriptors       */
#define RTL_TX_BUF_SIZE  1536u

int  rtl8139_init(uint16_t io_base);
int  rtl8139_present(void);
int  rtl8139_recv(uint8_t *buf, uint16_t buf_len);
int  rtl8139_send(const uint8_t *buf, uint16_t len);
void rtl8139_get_mac(uint8_t mac[6]);

#endif /* RTL8139_H */
