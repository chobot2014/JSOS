/*
 * Realtek RTL8139 Ethernet Driver (item 91)
 */

#include "rtl8139.h"
#include "io.h"
#include "platform.h"
#include <string.h>

static uint16_t _io  = 0;
static int      _rdy = 0;
static uint8_t  _mac[6];

static uint8_t  _rx_buf[RTL_RX_BUF_SIZE] __attribute__((aligned(4)));
static uint8_t  _tx_bufs[RTL_NUM_TX][RTL_TX_BUF_SIZE] __attribute__((aligned(4)));
static uint32_t _rx_off = 0;   /* current read offset into ring */
static uint32_t _tx_cur = 0;   /* next TX slot */

int rtl8139_init(uint16_t io_base) {
    _io = io_base;

    /* Power on */
    outb((uint16_t)(_io + RTL_REG_CONFIG1), 0x00);

    /* Software reset */
    outb((uint16_t)(_io + RTL_REG_CMD), 0x10);
    for (volatile int t = 0; inb((uint16_t)(_io + RTL_REG_CMD)) & 0x10 && t < 100000; t++);

    /* Read MAC */
    for (int i = 0; i < 6; i++) _mac[i] = inb((uint16_t)(_io + RTL_REG_MAC0 + i));

    /* Set RX ring buffer address */
    outl((uint16_t)(_io + RTL_REG_RBSTART), (uint32_t)_rx_buf);

    /* Set TX buffer addresses */
    for (uint32_t i = 0; i < RTL_NUM_TX; i++)
        outl((uint16_t)(_io + RTL_REG_TXADDR0 + i * 4), (uint32_t)_tx_bufs[i]);

    /* Mask all interrupts */
    outw((uint16_t)(_io + RTL_REG_IMR), 0x0000);
    /* Clear pending */
    outw((uint16_t)(_io + RTL_REG_ISR), 0xFFFF);

    /* RX config: accept broadcast + unicast, no wrap, DMA burst 1024 */
    outl((uint16_t)(_io + RTL_REG_RCR), 0x0000000Fu | (6u << 8) | (1u << 7));

    /* TX config: default DMA burst */
    outl((uint16_t)(_io + RTL_REG_TCR), 0x03000700u);

    /* Enable RX + TX */
    outb((uint16_t)(_io + RTL_REG_CMD), 0x0Cu);

    _rx_off = 0;
    _tx_cur = 0;
    _rdy    = 1;
    platform_serial_puts("[NET] RTL8139 init OK\n");
    return 0;
}

int  rtl8139_present(void) { return _rdy; }
void rtl8139_get_mac(uint8_t mac[6]) { for (int i=0;i<6;i++) mac[i]=_mac[i]; }

int rtl8139_recv(uint8_t *buf, uint16_t buf_len) {
    if (!_rdy) return -1;

    uint8_t cmd = inb((uint16_t)(_io + RTL_REG_CMD));
    /* Bit 0 = RX buffer empty */
    if (cmd & 0x01) return 0;

    /* Packet header: 4 bytes — status(2) + length(2) */
    uint16_t *hdr = (uint16_t *)(_rx_buf + _rx_off);
    /* uint16_t rx_status = hdr[0]; */
    uint16_t pkt_len = hdr[1];

    if (pkt_len < 4u || pkt_len > 1518u) {
        /* Bad packet — reset ring */
        _rx_off = 0;
        outw((uint16_t)(_io + RTL_REG_CAPR), (uint16_t)(_rx_off - 16u));
        return -1;
    }

    uint16_t data_len = (uint16_t)(pkt_len - 4u); /* strip CRC */
    if (data_len > buf_len) data_len = buf_len;
    memcpy(buf, _rx_buf + _rx_off + 4, data_len);

    /* Advance ring pointer (4-byte aligned) */
    _rx_off = (uint32_t)((_rx_off + pkt_len + 4u + 3u) & ~3u) % RTL_RX_BUF_SIZE;
    outw((uint16_t)(_io + RTL_REG_CAPR), (uint16_t)(_rx_off - 16u));
    return (int)data_len;
}

int rtl8139_send(const uint8_t *buf, uint16_t len) {
    if (!_rdy || len > RTL_TX_BUF_SIZE) return -1;

    /* Wait for TX slot to be free (OWN bit = 1 in status means done) */
    uint32_t ts_reg = (uint32_t)(_io + RTL_REG_TXSTATUS0 + _tx_cur * 4);
    for (volatile int t = 0; !(inl((uint16_t)ts_reg) & 0x2000u) && t < 100000; t++);

    memcpy(_tx_bufs[_tx_cur], buf, len);
    /* Write length (bits 12:0) — clears OWN to start transmission */
    outl((uint16_t)ts_reg, len > 0x1FFFu ? 0x1FFFu : len);

    _tx_cur = (_tx_cur + 1u) % RTL_NUM_TX;
    return 0;
}
