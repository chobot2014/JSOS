/*
 * virtio_net.c  –  Legacy PCI virtio-net driver (spec 0.9.5 / QEMU "legacy")
 *
 * Everything above raw frame send/receive lives in TypeScript (net.ts).
 * This file only:
 *   - Probes PCI for vendor=0x1AF4 device=0x1000
 *   - Initialises the two split-ring virtqueues
 *   - Provides virtio_net_send() and virtio_net_recv()
 *
 * Ring layout (QUEUE_SIZE = 64):
 *   [ desc[64] (1024 B) | avail (132 B) | padding (2940 B) | used (518 B) ]
 *   two pages = 8192 bytes, aligned to 4096, per queue.
 */

#include "virtio_net.h"
#include "pci.h"
#include "io.h"
#include "platform.h"

#include <stdint.h>
#include <string.h>

/* Simple helper: print 4-digit hex to serial */
static void _dbg_hex16(const char *label, uint16_t val) {
    const char *h = "0123456789abcdef";
    char buf[20];
    int i = 0;
    while (label[i]) { buf[i] = label[i]; i++; }
    buf[i++] = '0'; buf[i++] = 'x';
    buf[i++] = h[(val>>12)&0xf]; buf[i++] = h[(val>>8)&0xf];
    buf[i++] = h[(val>>4)&0xf];  buf[i++] = h[val&0xf];
    buf[i++] = '\n'; buf[i] = '\0';
    platform_serial_puts(buf);
}

/* ── Virtio PCI legacy register offsets (from I/O BAR0) ─────────────────── */
#define VPIO_HOST_FEATURES   0x00   /* 32-bit RO */
#define VPIO_GUEST_FEATURES  0x04   /* 32-bit WO */
#define VPIO_QUEUE_PFN       0x08   /* 32-bit RW: physical addr >> 12 */
#define VPIO_QUEUE_SIZE      0x0C   /* 16-bit RO: number of entries */
#define VPIO_QUEUE_SEL       0x0E   /* 16-bit WO: choose queue 0/1 */
#define VPIO_QUEUE_NOTIFY    0x10   /* 16-bit WO: kick a queue */
#define VPIO_DEVICE_STATUS   0x12   /* 8-bit  RW */
#define VPIO_ISR_STATUS      0x13   /* 8-bit  RO: clear-on-read */
#define VPIO_NET_MAC         0x14   /* 6 × 8-bit: device MAC */

/* Virtio device status bits */
#define VSTAT_ACKNOWLEDGE    0x01
#define VSTAT_DRIVER         0x02
#define VSTAT_DRIVER_OK      0x04

/* Virtio-net feature bits */
#define VIRTIO_NET_F_MAC     (1u << 5)

/* Virtqueue descriptor flags */
#define VRING_F_NEXT         0x0001   /* descriptor is chained */
#define VRING_F_WRITE        0x0002   /* device writes (RX) */

/* ── Ring geometry ───────────────────────────────────────────────────────── */
#define QUEUE_SIZE  256             /* match QEMU's default max queue size      */
#define PAGE_SIZE   4096

/*
 * Virtqueue layout for QUEUE_SIZE=256 (legacy virtio):
 *
 * Offset    Size    Content
 * ------    ----    -------
 *      0    4096    Descriptor table (256 × 16 = 4096 bytes) — page 0
 *   4096     516    Avail ring (4 + 256×2 = 516 bytes)       — start of page 1
 *   4612    3580    Padding to 2×4096 = 8192                 — end of page 1
 *   8192    2052    Used ring (4 + 256×8 = 2052 bytes)       — page 2
 *  10244    2044    Padding to 3×4096 = 12288                — end of page 2
 * Total: 3 pages
 */
#define SZ_DESCS    (QUEUE_SIZE * 16)                          /* 4096 */
#define SZ_AVAIL    (4 + QUEUE_SIZE * 2)                       /*  516 */
#define SZ_DESCS_AVAIL (SZ_DESCS + SZ_AVAIL)                  /* 4612 */
/* Pad from end of avail ring to next page boundary (8192): */
#define SZ_PAD0     (PAGE_SIZE * 2 - SZ_DESCS_AVAIL)          /* 3580 */
#define SZ_USED     (4 + QUEUE_SIZE * 8)                       /* 2052 */
/* Pad used ring to fill page 2 (to 3×4096 = 12288): */
#define SZ_PAD1     (PAGE_SIZE * 3 - PAGE_SIZE * 2 - SZ_USED) /* 2044 */

/* ── Virtqueue structures ─────────────────────────────────────────────────── */
typedef struct __attribute__((packed)) {
    uint64_t addr;
    uint32_t len;
    uint16_t flags;
    uint16_t next;
} vring_desc_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    uint16_t ring[QUEUE_SIZE];
} vring_avail_t;

typedef struct __attribute__((packed)) {
    uint32_t id;
    uint32_t len;
} vring_used_elem_t;

typedef struct __attribute__((packed)) {
    uint16_t flags;
    uint16_t idx;
    vring_used_elem_t ring[QUEUE_SIZE];
} vring_used_t;

/*
 * A full virtqueue in three 4096-byte pages (for QUEUE_SIZE=256).
 * page 0 (0x000): descriptor table (4096 B)
 * page 1 (0x000+4096=0x1000): avail ring (516 B) + padding (3580 B)
 * page 2 (0x2000): used ring (2052 B) + padding (2044 B)
 */
typedef struct __attribute__((aligned(PAGE_SIZE))) {
    vring_desc_t  desc [QUEUE_SIZE];   /* 4096 B @ offset 0    */
    vring_avail_t avail;               /*  516 B @ offset 4096 */
    uint8_t       _pad0[SZ_PAD0];      /* 3580 B @ offset 4612 (fills to 8192) */
    vring_used_t  used;                /* 2052 B @ offset 8192 */
    uint8_t       _pad1[SZ_PAD1];      /* 2044 B (fills to 12288) */
} virtqueue_t;

/* ── Buffer pools (10 B virtio header + up to 1514 B frame = 1524; use 2048) */
#define BUF_SIZE    2048

typedef struct __attribute__((packed)) {
    uint8_t  flags;
    uint8_t  gso_type;
    uint16_t hdr_len;
    uint16_t gso_size;
    uint16_t csum_start;
    uint16_t csum_offset;
} virtio_net_hdr_t;          /* exactly 10 bytes */

#define VNHDR_LEN   sizeof(virtio_net_hdr_t)   /* 10 */

/* ── Static storage (in BSS, zero-initialised at boot) ───────────────────── */
static virtqueue_t  rx_vq          __attribute__((aligned(PAGE_SIZE)));
static virtqueue_t  tx_vq          __attribute__((aligned(PAGE_SIZE)));

/* Each RX buffer: virtio_net_hdr (10 B) + Ethernet data (up to 1514 B) */
static uint8_t rx_bufs[QUEUE_SIZE][BUF_SIZE] __attribute__((aligned(sizeof(uintptr_t))));
/* Each TX buffer: virtio_net_hdr (10 B) + Ethernet data                  */
static uint8_t tx_bufs[QUEUE_SIZE][BUF_SIZE] __attribute__((aligned(sizeof(uintptr_t))));

/* ── Driver state ─────────────────────────────────────────────────────────── */
int     virtio_net_ready   = 0;
uint8_t virtio_net_pci_bus = 0;
uint8_t virtio_net_pci_dev = 0;
uint8_t virtio_net_pci_fn  = 0;
uint8_t virtio_net_mac[6]  = {0};

static uint16_t  io_base  = 0;   /* BAR0 I/O port base */
static uint16_t  rx_last_used = 0;
static uint16_t  tx_next_desc = 0;   /* round-robin TX slot */

/* ── Helpers ─────────────────────────────────────────────────────────────── */
static inline uint32_t va_to_pfn(const void *p)
{
    return (uint32_t)(uintptr_t)p >> 12;
}

/* ── Queue initialisation ─────────────────────────────────────────────────── */

/* Pre-fill all RX descriptors and give them to the device */
static void rx_queue_init(void)
{
    uint16_t i;
    for (i = 0; i < QUEUE_SIZE; i++) {
        rx_vq.desc[i].addr  = (uint32_t)(uintptr_t)rx_bufs[i];
        rx_vq.desc[i].len   = BUF_SIZE;
        rx_vq.desc[i].flags = VRING_F_WRITE;
        rx_vq.desc[i].next  = 0;
        rx_vq.avail.ring[i] = i;
    }
    /* Expose all descriptors to the device */
    rx_vq.avail.idx = QUEUE_SIZE;
    rx_last_used    = 0;
}

/* TX descriptors start empty; we fill them on demand */
static void tx_queue_init(void)
{
    tx_next_desc = 0;
    /* avail.idx stays 0; we increment it per send */
}

/* Select a queue and give its physical address to the device */
static void queue_setup(uint16_t qidx, virtqueue_t *vq)
{
    outw(io_base + VPIO_QUEUE_SEL, qidx);
    /* Verify the device reports our expected size (256) */
    volatile uint16_t sz = inw(io_base + VPIO_QUEUE_SIZE);
    (void)sz;

    /* Write PFN (physical page frame number of the virtqueue) */
    outl(io_base + VPIO_QUEUE_PFN, va_to_pfn(vq));
}

/* ── Public API ──────────────────────────────────────────────────────────── */

int virtio_net_init(void)
{
    pci_device_t nic;

    /* 1. Find legacy virtio-net on PCI bus */
    if (!pci_find_device(0x1AF4, 0x1000, &nic))
        return 0;

    pci_enable_busmaster(&nic);

    virtio_net_pci_bus = nic.bus;
    virtio_net_pci_dev = nic.dev;
    virtio_net_pci_fn  = nic.fn;

    /* 2. BAR0 must be an I/O port BAR */
    if (!nic.bar_is_io[0] || nic.bar[0] == 0)
        return 0;

    io_base = (uint16_t)(nic.bar[0] & 0xFFFC);

    /* 3. Reset the device */
    outb(io_base + VPIO_DEVICE_STATUS, 0);

    /* 4. Acknowledge (we see it) + Driver (we can drive it) */
    outb(io_base + VPIO_DEVICE_STATUS, VSTAT_ACKNOWLEDGE | VSTAT_DRIVER);

    /* 5. Feature negotiation: only accept VIRTIO_NET_F_MAC */
    uint32_t host_feats = inl(io_base + VPIO_HOST_FEATURES);
    uint32_t drv_feats  = host_feats & VIRTIO_NET_F_MAC;
    outl(io_base + VPIO_GUEST_FEATURES, drv_feats);

    /* 6. Read the MAC address the device advertises */
    uint8_t i;
    for (i = 0; i < 6; i++)
        virtio_net_mac[i] = inb(io_base + VPIO_NET_MAC + i);

    /* Make friendly copy */
    for (i = 0; i < 6; i++)
        virtio_net_mac[i] = virtio_net_mac[i];

    /* 7. Set up RX queue (index 0) */
    rx_queue_init();
    queue_setup(0, &rx_vq);

    /* 8. Set up TX queue (index 1) */
    tx_queue_init();
    queue_setup(1, &tx_vq);

    /* Kick RX queue so the device knows descriptors are ready */
    /* (a write-barrier would be ideal; on x86 store ordering is sufficient) */
    outw(io_base + VPIO_QUEUE_NOTIFY, 0);

    /* 9. DRIVER_OK */
    outb(io_base + VPIO_DEVICE_STATUS,
         VSTAT_ACKNOWLEDGE | VSTAT_DRIVER | VSTAT_DRIVER_OK);

    virtio_net_ready = 1;
    return 1;
}

void virtio_net_send(const uint8_t *frame, uint16_t len)
{
    if (!virtio_net_ready) return;
    if (len == 0 || len > 1514) return;

    /* Find a TX descriptor slot (round-robin, wait if all outstanding) */
    uint16_t slot = tx_next_desc % QUEUE_SIZE;
    tx_next_desc++;

    /* Build the buffer: virtio_net_hdr (zero) + raw frame */
    uint8_t *buf = tx_bufs[slot];
    memset(buf, 0, VNHDR_LEN);
    memcpy(buf + VNHDR_LEN, frame, len);

    uint16_t total = (uint16_t)(VNHDR_LEN + len);

    /* Fill the descriptor */
    tx_vq.desc[slot].addr  = (uint32_t)(uintptr_t)buf;
    tx_vq.desc[slot].len   = total;
    tx_vq.desc[slot].flags = 0;   /* read-only: device reads this */
    tx_vq.desc[slot].next  = 0;

    /* Put descriptor index in the avail ring */
    uint16_t avail_slot = tx_vq.avail.idx % QUEUE_SIZE;
    tx_vq.avail.ring[avail_slot] = slot;

    /* Memory barrier: ensure descriptor is written before idx update */
    __asm__ volatile ("" ::: "memory");

    tx_vq.avail.idx++;

    /* Kick the TX queue */
    outw(io_base + VPIO_QUEUE_NOTIFY, 1);
}

uint16_t virtio_net_rx_used_idx(void) {
    __asm__ volatile ("" ::: "memory");
    return *(volatile uint16_t*)&rx_vq.used.idx;
}

uint32_t virtio_net_debug_info(void) {
    /* Returns (io_base << 16) | tx_vq_pfn for diagnosis */
    uint32_t pfn = (uint32_t)(uintptr_t)&tx_vq >> 12;
    return ((uint32_t)io_base << 16) | (pfn & 0xFFFF);
}

uint32_t virtio_net_debug_status(void) {
    __asm__ volatile ("" ::: "memory");
    uint8_t status = inb(io_base + VPIO_DEVICE_STATUS);
    uint16_t tx_used = *(volatile uint16_t*)&tx_vq.used.idx;
    return ((uint32_t)status << 16) | tx_used;
}

uint32_t virtio_net_debug_queues(void) {
    /* Read queue sizes: select queue 0, read size; select queue 1, read size */
    outw(io_base + VPIO_QUEUE_SEL, 0);
    uint16_t sz0 = inw(io_base + VPIO_QUEUE_SIZE);
    outw(io_base + VPIO_QUEUE_SEL, 1);
    uint16_t sz1 = inw(io_base + VPIO_QUEUE_SIZE);
    return ((uint32_t)sz0 << 16) | sz1;
}

uint16_t virtio_net_recv(uint8_t *buf)
{
    if (!virtio_net_ready) return 0;

    /* Memory barrier: ensure we see the device's latest writes */
    __asm__ volatile ("" ::: "memory");

    /* Any new entry in the used ring? */
    if (*(volatile uint16_t*)&rx_vq.used.idx == rx_last_used)
        return 0;

    uint16_t uid   = rx_last_used % QUEUE_SIZE;
    uint32_t desc_id = rx_vq.used.ring[uid].id;
    uint32_t total   = rx_vq.used.ring[uid].len;  /* includes 10-B hdr */

    rx_last_used++;

    if (total <= (uint32_t)VNHDR_LEN)
        goto recycle;   /* empty / corrupt frame */

    uint16_t eth_len = (uint16_t)(total - VNHDR_LEN);
    if (eth_len > 1514) eth_len = 1514;

    /* Copy Ethernet frame (skip virtio header) */
    memcpy(buf, rx_bufs[desc_id] + VNHDR_LEN, eth_len);

recycle:
    /* Give the descriptor back to the device */
    rx_vq.desc[desc_id].len   = BUF_SIZE;
    rx_vq.desc[desc_id].flags = VRING_F_WRITE;

    uint16_t recycle_slot = rx_vq.avail.idx % QUEUE_SIZE;
    rx_vq.avail.ring[recycle_slot] = (uint16_t)desc_id;
    __asm__ volatile ("" ::: "memory");
    rx_vq.avail.idx++;

    outw(io_base + VPIO_QUEUE_NOTIFY, 0);   /* kick RX */

    if (total <= (uint32_t)VNHDR_LEN) return 0;
    return (uint16_t)(total - VNHDR_LEN);
}
