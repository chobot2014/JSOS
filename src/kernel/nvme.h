/*
 * nvme.h — NVMe (Non-Volatile Memory Express) C register interface
 *
 * Item 82: C maps BAR0 NVMe MMIO registers; TypeScript implements the
 *          admin queue and I/O queue state machines.
 *
 * ARCHITECTURE CONSTRAINT: All NVMe protocol logic (queue state machines,
 * command building, completion handling) lives in TypeScript.  This header
 * exposes only the lowest-level MMIO register access primitives and
 * queue-memory setup.
 */
#ifndef NVME_H
#define NVME_H

#include <stdint.h>

/* ── PCI identity ───────────────────────────────────────────────────────── */
#define NVME_PCI_CLASS    0x010802u   /* Class=01 Sub=08 Prog-I/F=02 (NVMe) */

/* ── BAR0 register offsets (Controller Capabilities and Configuration) ─── */
#define NVME_REG_CAP      0x0000u  /* Controller Capabilities  (64-bit) */
#define NVME_REG_VS       0x0008u  /* Version                  (32-bit) */
#define NVME_REG_INTMS    0x000Cu  /* Interrupt Mask Set       (32-bit) */
#define NVME_REG_INTMC    0x0010u  /* Interrupt Mask Clear     (32-bit) */
#define NVME_REG_CC       0x0014u  /* Controller Configuration (32-bit) */
#define NVME_REG_CSTS     0x001Cu  /* Controller Status        (32-bit) */
#define NVME_REG_NSSR     0x0020u  /* NVM Subsystem Reset      (32-bit) */
#define NVME_REG_AQA      0x0024u  /* Admin Queue Attributes   (32-bit) */
#define NVME_REG_ASQ      0x0028u  /* Admin SQ Base Address    (64-bit) */
#define NVME_REG_ACQ      0x0030u  /* Admin CQ Base Address    (64-bit) */

/* CC bits */
#define NVME_CC_EN        (1u << 0)   /* Controller Enable */
#define NVME_CC_CSS_NVM   (0u << 4)   /* Command Set: NVM */
#define NVME_CC_MPS_4K    (0u << 7)   /* Memory Page Size: 4 KB (host page size = 2^(12+MPS)) */
#define NVME_CC_AMS_RR    (0u << 11)  /* Arbitration: round-robin */
#define NVME_CC_IOSQES_64 (6u << 16)  /* SQ entry size: 64 bytes (2^6) */
#define NVME_CC_IOCQES_16 (4u << 20)  /* CQ entry size: 16 bytes (2^4) */

/* CSTS bits */
#define NVME_CSTS_RDY     (1u << 0)   /* Ready */
#define NVME_CSTS_CFS     (1u << 1)   /* Controller Fatal Status */

/* AQA: admin queue depths (0-based: n means n+1 entries) */
#define NVME_AQ_DEPTH     63u      /* admin queue size − 1 (64 entries) */
#define NVME_AQ_MASK      63u

/* ── NVMe submission queue entry (SQE) — 64 bytes ──────────────────────── */
typedef struct {
    uint8_t  opc;          /* Opcode */
    uint8_t  fuse_psdt;    /* FUSE[1:0] | PSDT [3:2] */
    uint16_t cid;          /* Command Identifier */
    uint32_t nsid;         /* Namespace ID */
    uint64_t reserved;
    uint64_t mptr;         /* Metadata Pointer */
    uint64_t prp1;         /* PRP Entry 1 (first physical page) */
    uint64_t prp2;         /* PRP Entry 2 or PRP List Pointer */
    uint32_t cdw10;        /* Command-specific DWord 10 */
    uint32_t cdw11;
    uint32_t cdw12;
    uint32_t cdw13;
    uint32_t cdw14;
    uint32_t cdw15;
} __attribute__((packed)) nvme_sqe_t;

/* ── NVMe completion queue entry (CQE) — 16 bytes ──────────────────────── */
typedef struct {
    uint32_t dw0;          /* Command-specific result */
    uint32_t reserved;
    uint16_t sqhd;         /* SQ Head Pointer */
    uint16_t sqid;         /* SQ Identifier */
    uint16_t cid;          /* Command Identifier */
    uint16_t sf_p;         /* Status Field [15:1] | Phase [0] */
} __attribute__((packed)) nvme_cqe_t;

/* Status code extraction */
#define NVME_CQE_STATUS(cqe)  (((cqe).sf_p >> 1u) & 0xFFu)
#define NVME_CQE_PHASE(cqe)   ((cqe).sf_p & 1u)

/* ── Admin opcode mnemonics ─────────────────────────────────────────────── */
#define NVME_OPC_DELETE_SQ    0x00u
#define NVME_OPC_CREATE_SQ    0x01u
#define NVME_OPC_GET_LOG_PAGE 0x02u
#define NVME_OPC_DELETE_CQ    0x04u
#define NVME_OPC_CREATE_CQ    0x05u
#define NVME_OPC_IDENTIFY     0x06u
#define NVME_OPC_ABORT        0x08u
#define NVME_OPC_SET_FEATURES 0x09u
#define NVME_OPC_GET_FEATURES 0x0Au

/* I/O NVM opcode mnemonics */
#define NVME_OPC_FLUSH        0x00u
#define NVME_OPC_WRITE        0x01u
#define NVME_OPC_READ         0x02u

/* ── Public C API ───────────────────────────────────────────────────────── */

/**
 * Locate the first NVMe controller via PCI class code 0x010802.
 * Maps BAR0 MMIO and validates the controller is present.
 * Returns 0 on success, -1 if not found or failed.
 * (item 82)
 */
int nvme_init(void);

/**
 * Returns 1 if an NVMe controller was found and initialised, 0 otherwise.
 */
int nvme_present(void);

/**
 * Return the BAR0 MMIO base address (as a 32-bit physical address).
 * TypeScript uses this to read controller capabilities before issuing
 * admin commands via kernel.outl / kernel.inl / DMA.
 */
uint32_t nvme_bar0(void);

/**
 * Read a 32-bit NVMe controller register at byte offset `reg`.
 */
uint32_t nvme_read32(uint32_t reg);

/**
 * Write a 32-bit NVMe controller register.
 */
void nvme_write32(uint32_t reg, uint32_t val);

/**
 * Read the 64-bit CAP register.
 */
uint64_t nvme_read_cap(void);

/**
 * Perform controller reset (CC.EN=0 → wait CSTS.RDY=0 → CC.EN=1).
 * Returns 0 on success, -1 on timeout.
 * (Called by TypeScript after setting up admin queue physical addresses)
 */
int nvme_controller_reset(void);

/**
 * Enable the controller (CC.EN=1) with default configuration:
 *   CSS=NVM, MPS=4K, IOSQES=64, IOCQES=16.
 * Returns 0 when CSTS.RDY=1, -1 on timeout or fatal error.
 */
int nvme_enable(void);

/**
 * Doorbell stride in bytes (from CAP.DSTRD field + 4).
 * Admin SQ doorbell = BAR0 + 0x1000.
 * Admin CQ doorbell = BAR0 + 0x1000 + stride.
 * I/O SQ(n) doorbell = BAR0 + 0x1000 + (2*n) * stride.
 */
uint32_t nvme_doorbell_stride(void);

/**
 * Ring admin submission queue doorbell (write tail index).
 */
void nvme_ring_admin_sq(uint16_t tail);

/**
 * Ring admin completion queue doorbell (write head index consumed by host).
 */
void nvme_ring_admin_cq(uint16_t head);

#endif /* NVME_H */
