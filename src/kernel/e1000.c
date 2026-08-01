/*
 * Intel e1000 Ethernet Driver (item 90)
 *
 * Minimal ring-based driver.  All higher-level network logic (IP, TCP, UDP,
 * DHCP) lives in TypeScript.  C code handles MMIO register access only.
 */

#include "e1000.h"
#include "platform.h"
#include <string.h>
#include <stdint.h>

/* ── State ───────────────────────────────────────────────────────────────── */
static uint32_t  _mmio = 0;
static int       _ready = 0;
static uint8_t   _mac[6];

static e1000_rx_desc_t _rx_descs[E1000_NUM_RX_DESC] __attribute__((aligned(16)));
static e1000_tx_desc_t _tx_descs[E1000_NUM_TX_DESC] __attribute__((aligned(16)));

static uint8_t _rx_bufs[E1000_NUM_RX_DESC][E1000_PACKET_SIZE] __attribute__((aligned(16)));
static uint8_t _tx_bufs[E1000_NUM_TX_DESC][E1000_PACKET_SIZE] __attribute__((aligned(16)));

static uint32_t _rx_cur = 0;
static uint32_t _tx_cur = 0;

/* ── MMIO helpers ────────────────────────────────────────────────────────── */
static inline uint32_t _e1000_read(uint32_t reg) {
    volatile uint32_t *p = (volatile uint32_t *)(_mmio + reg);
    return *p;
}
static inline void _e1000_write(uint32_t reg, uint32_t val) {
    volatile uint32_t *p = (volatile uint32_t *)(_mmio + reg);
    *p = val;
}

/* ── Init ────────────────────────────────────────────────────────────────── */
int e1000_init(uint32_t mmio_base) {
    _mmio = mmio_base;

    /* Reset the device */
    _e1000_write(E1000_REG_CTRL, _e1000_read(E1000_REG_CTRL) | 0x04000000u);
    /* Spin until self-clearing */
    for (volatile int i = 0; i < 100000; i++);

    /* Read MAC from RAL/RAH */
    uint32_t ral = _e1000_read(E1000_REG_RAL);
    uint32_t rah = _e1000_read(E1000_REG_RAH);
    _mac[0] = (uint8_t)( ral        & 0xFF);
    _mac[1] = (uint8_t)((ral >>  8) & 0xFF);
    _mac[2] = (uint8_t)((ral >> 16) & 0xFF);
    _mac[3] = (uint8_t)((ral >> 24) & 0xFF);
    _mac[4] = (uint8_t)( rah        & 0xFF);
    _mac[5] = (uint8_t)((rah >>  8) & 0xFF);

    /* Initialise RX descriptors */
    memset(_rx_descs, 0, sizeof(_rx_descs));
    for (int i = 0; i < E1000_NUM_RX_DESC; i++) {
        _rx_descs[i].buffer_addr = (uint64_t)(uint32_t)_rx_bufs[i];
    }
    _e1000_write(E1000_REG_RDBAL, (uint32_t)_rx_descs);
    _e1000_write(E1000_REG_RDLEN, E1000_NUM_RX_DESC * 16u);
    _e1000_write(E1000_REG_RDH,   0);
    _e1000_write(E1000_REG_RDT,   E1000_NUM_RX_DESC - 1u);
    /* RCTL: EN | UPE | MPE | LBM=0 | RDMTS=0 | BAM | BSIZE=2KB | SECRC */
    _e1000_write(E1000_REG_RCTL,  0x0000801Au | (1u << 15) | (1u << 2));

    /* Initialise TX descriptors */
    memset(_tx_descs, 0, sizeof(_tx_descs));
    for (int i = 0; i < E1000_NUM_TX_DESC; i++) {
        _tx_descs[i].buffer_addr = (uint64_t)(uint32_t)_tx_bufs[i];
        _tx_descs[i].status      = 1; /* DD = done */
    }
    _e1000_write(E1000_REG_TDBAL, (uint32_t)_tx_descs);
    _e1000_write(E1000_REG_TDLEN, E1000_NUM_TX_DESC * 16u);
    _e1000_write(E1000_REG_TDH,   0);
    _e1000_write(E1000_REG_TDT,   0);
    /* TCTL: EN | PSP | CT=0x10 | COLD=0x40 */
    _e1000_write(E1000_REG_TCTL,  0x00410000u | 0x010u | 0x002u);

    /* Mask all interrupts */
    _e1000_write(E1000_REG_IMC, 0xFFFFFFFFu);

    _rx_cur = 0;
    _tx_cur = 0;
    _ready  = 1;
    platform_serial_puts("[NET] e1000 init OK\n");
    return 0;
}

int e1000_present(void) { return _ready; }

void e1000_get_mac(uint8_t mac[6]) {
    for (int i = 0; i < 6; i++) mac[i] = _mac[i];
}

int e1000_recv(uint8_t *buf, uint16_t buf_len) {
    if (!_ready) return -1;
    e1000_rx_desc_t *desc = &_rx_descs[_rx_cur];
    if (!(desc->status & 0x01)) return 0; /* DD not set = no packet */

    uint16_t len = desc->length;
    if (len > buf_len) len = buf_len;
    memcpy(buf, _rx_bufs[_rx_cur], len);

    /* Return descriptor to hardware */
    desc->status = 0;
    _e1000_write(E1000_REG_RDT, _rx_cur);
    _rx_cur = (_rx_cur + 1u) % E1000_NUM_RX_DESC;
    return (int)len;
}

int e1000_send(const uint8_t *buf, uint16_t len) {
    if (!_ready || len > E1000_PACKET_SIZE) return -1;
    e1000_tx_desc_t *desc = &_tx_descs[_tx_cur];
    /* Wait until the descriptor is done */
    for (volatile int t = 0; !(desc->status & 0x01) && t < 100000; t++);
    if (!(desc->status & 0x01)) return -1;

    memcpy(_tx_bufs[_tx_cur], buf, len);
    desc->length = len;
    desc->cmd    = 0x0Bu; /* EOP | IFCS | RS */
    desc->status = 0;

    uint32_t next = (_tx_cur + 1u) % E1000_NUM_TX_DESC;
    _e1000_write(E1000_REG_TDT, next);
    _tx_cur = next;
    return 0;
}
