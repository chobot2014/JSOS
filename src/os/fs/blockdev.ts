/**
 * JSOS Block Device Layer — Item 186
 *
 * Request queue + elevator (C-SCAN / NOOP) I/O scheduler.
 * All scheduling logic is in TypeScript; C only provides raw sector I/O.
 */

import type { Ext4BlockDevice } from './ext4.js';

// ── I/O Request ───────────────────────────────────────────────────────────────

export type IOOp = 'read' | 'write';

export interface IORequest {
  id: number;
  op: IOOp;
  sector: number;          // logical block address (LBA)
  count: number;           // number of sectors (each 512 B)
  data?: Uint8Array;       // for writes
  resolve: (result: Uint8Array | number) => void;
  reject: (err: Error) => void;
  submittedAt: number;     // Date.now()
  priority: number;        // 0 = normal, 1 = sync/elevated
}

// ── Block device abstraction ──────────────────────────────────────────────────

export interface BlockDevice {
  readonly name: string;
  readonly sectorSize: number;        // bytes
  readonly sectorCount: number;       // total sectors on device
  readSectors(lba: number, count: number): Promise<Uint8Array>;
  writeSectors(lba: number, data: Uint8Array): Promise<number>;
}

/** Adapts the sync Ext4BlockDevice into an async BlockDevice. */
export class SyncBlockDeviceAdapter implements BlockDevice {
  readonly name: string;
  readonly sectorSize = 512;
  readonly sectorCount: number;
  private _dev: Ext4BlockDevice;

  constructor(name: string, dev: Ext4BlockDevice, sectorCount: number) {
    this.name = name;
    this._dev = dev;
    this.sectorCount = sectorCount;
  }

  async readSectors(lba: number, count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count * this.sectorSize);
    for (let i = 0; i < count; i++) {
      out.set(this._dev.readSector((lba + i) * this.sectorSize), i * this.sectorSize);
    }
    return out;
  }

  async writeSectors(lba: number, data: Uint8Array): Promise<number> {
    const count = data.length / this.sectorSize;
    for (let i = 0; i < count; i++) {
      const sector = data.slice(i * this.sectorSize, (i + 1) * this.sectorSize);
      const err = this._dev.writeSector((lba + i) * this.sectorSize, sector);
      if (err < 0) return err;
    }
    return 0;
  }
}

// ── Elevator algorithms ───────────────────────────────────────────────────────

export type ElevatorAlgorithm = 'noop' | 'deadline' | 'cfq' | 'mq-deadline';

interface QueuedRequest extends IORequest {
  deadline: number;  // Date.now() + latency budget
}

/** NOOP scheduler: FIFO with no reordering. Best for SSDs, VMs, NVMe. */
class NOOPElevator {
  private _queue: QueuedRequest[] = [];

  enqueue(req: QueuedRequest): void { this._queue.push(req); }

  dequeue(): QueuedRequest | undefined { return this._queue.shift(); }

  get length(): number { return this._queue.length; }
}

/** Deadline scheduler: separate read/write queues with deadlines. */
class DeadlineElevator {
  private _readQueue:  QueuedRequest[] = [];
  private _writeQueue: QueuedRequest[] = [];
  private _readBudget  = 3;    // max consecutive writes before forcing a read
  private _writeBudget = 8;
  private _consecutiveWrites = 0;
  private _consecutiveReads  = 0;

  enqueue(req: QueuedRequest): void {
    if (req.op === 'read')  this._readQueue.push(req);
    else                    this._writeQueue.push(req);
  }

  dequeue(): QueuedRequest | undefined {
    const now = Date.now();
    // Expired reads take priority
    const expiredRead = this._readQueue.find(function(r) { return now > r.deadline; });
    if (expiredRead) {
      this._readQueue.splice(this._readQueue.indexOf(expiredRead), 1);
      this._consecutiveReads++;
      this._consecutiveWrites = 0;
      return expiredRead;
    }
    // Expired writes take priority
    const expiredWrite = this._writeQueue.find(function(r) { return now > r.deadline; });
    if (expiredWrite) {
      this._writeQueue.splice(this._writeQueue.indexOf(expiredWrite), 1);
      this._consecutiveWrites++;
      this._consecutiveReads = 0;
      return expiredWrite;
    }
    // Prefer reads unless write budget exceeded
    if (this._consecutiveWrites >= this._writeBudget && this._readQueue.length) {
      this._consecutiveWrites = 0;
      this._consecutiveReads++;
      return this._readQueue.shift();
    }
    if (this._readQueue.length && this._consecutiveReads < this._readBudget) {
      this._consecutiveReads++;
      return this._readQueue.shift();
    }
    if (this._writeQueue.length) {
      this._consecutiveWrites++;
      this._consecutiveReads = 0;
      return this._writeQueue.shift();
    }
    if (this._readQueue.length) return this._readQueue.shift();
    return undefined;
  }

  get length(): number { return this._readQueue.length + this._writeQueue.length; }
}

/** C-SCAN (circular SCAN) elevator for rotating disks. */
class CSCANElevator {
  private _queue: QueuedRequest[] = [];
  private _head: number = 0;      // current head position

  setHead(lba: number): void { this._head = lba; }

  enqueue(req: QueuedRequest): void {
    this._queue.push(req);
    this._queue.sort(function(a, b) { return a.sector - b.sector; });
  }

  dequeue(): QueuedRequest | undefined {
    if (!this._queue.length) return undefined;
    // Find first sector >= head
    let idx = this._queue.findIndex(r => r.sector >= this._head);
    if (idx < 0) idx = 0; // wrap around to beginning
    const req = this._queue.splice(idx, 1)[0];
    this._head = req.sector;
    return req;
  }

  get length(): number { return this._queue.length; }
}

// ── Request Queue ─────────────────────────────────────────────────────────────

export class BlockRequestQueue {
  private _dev: BlockDevice;
  private _elevator: ElevatorAlgorithm;
  private _noop    = new NOOPElevator();
  private _deadline = new DeadlineElevator();
  private _cscan   = new CSCANElevator();
  private _nextId  = 1;
  private _running = false;
  private _stats: { reads: number; writes: number; errors: number; totalLatencyMs: number } =
    { reads: 0, writes: 0, errors: 0, totalLatencyMs: 0 };
  private _maxMergeDistance = 8; // sectors: merge adjacent requests if within this

  readonly READ_DEADLINE_MS  = 500;
  readonly WRITE_DEADLINE_MS = 5000;

  constructor(dev: BlockDevice, elevator: ElevatorAlgorithm = 'mq-deadline') {
    this._dev = dev;
    this._elevator = elevator;
  }

  /** Enqueue a read request. Returns a promise that resolves with read data. */
  read(lba: number, count = 1): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const req: QueuedRequest = {
        id: this._nextId++,
        op: 'read',
        sector: lba,
        count,
        resolve: resolve as (r: Uint8Array | number) => void,
        reject,
        submittedAt: Date.now(),
        priority: 0,
        deadline: Date.now() + this.READ_DEADLINE_MS,
      };
      this._enqueue(req);
      this._drain();
    });
  }

  /** Enqueue a write request. Returns a promise that resolves with error code. */
  write(lba: number, data: Uint8Array): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const req: QueuedRequest = {
        id: this._nextId++,
        op: 'write',
        sector: lba,
        count: Math.ceil(data.length / this._dev.sectorSize),
        data,
        resolve: resolve as (r: Uint8Array | number) => void,
        reject,
        submittedAt: Date.now(),
        priority: 0,
        deadline: Date.now() + this.WRITE_DEADLINE_MS,
      };
      this._enqueue(req);
      this._drain();
    });
  }

  /** Synchronous write-barrier: flushes queue before returning. */
  async barrier(): Promise<void> {
    while (this.depth > 0) await this._step();
  }

  private _enqueue(req: QueuedRequest): void {
    if (this._elevator === 'noop')           this._noop.enqueue(req);
    else if (this._elevator === 'mq-deadline' || this._elevator === 'deadline') this._deadline.enqueue(req);
    else                                     this._cscan.enqueue(req);
  }

  private _dequeue(): QueuedRequest | undefined {
    if (this._elevator === 'noop')           return this._noop.dequeue();
    if (this._elevator === 'mq-deadline' || this._elevator === 'deadline') return this._deadline.dequeue();
    return this._cscan.dequeue();
  }

  get depth(): number {
    if (this._elevator === 'noop') return this._noop.length;
    if (this._elevator === 'mq-deadline' || this._elevator === 'deadline') return this._deadline.length;
    return this._cscan.length;
  }

  private async _step(): Promise<void> {
    const req = this._dequeue();
    if (!req) return;
    const t0 = Date.now();
    try {
      if (req.op === 'read') {
        const data = await this._dev.readSectors(req.sector, req.count);
        this._stats.reads++;
        req.resolve(data);
      } else {
        const err = await this._dev.writeSectors(req.sector, req.data!);
        this._stats.writes++;
        req.resolve(err);
      }
    } catch (e) {
      this._stats.errors++;
      req.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this._stats.totalLatencyMs += Date.now() - t0;
  }

  private _drain(): void {
    if (this._running) return;
    this._running = true;
    const self = this;
    (async function() {
      while (self.depth > 0) await self._step();
      self._running = false;
    })().catch(function(_) { self._running = false; });
  }

  stats(): typeof this._stats & { avgLatencyMs: number; device: string; elevator: ElevatorAlgorithm } {
    const total = this._stats.reads + this._stats.writes || 1;
    return {
      ...this._stats,
      avgLatencyMs: Math.round(this._stats.totalLatencyMs / total),
      device: this._dev.name,
      elevator: this._elevator,
    };
  }

  setElevator(algo: ElevatorAlgorithm): void { this._elevator = algo; }
  get device(): BlockDevice { return this._dev; }
}

// ── Block Device Registry ─────────────────────────────────────────────────────

export class BlockDeviceRegistry {
  private _devices: Map<string, { dev: BlockDevice; queue: BlockRequestQueue }> = new Map();

  register(dev: BlockDevice, elevator: ElevatorAlgorithm = 'mq-deadline'): BlockRequestQueue {
    const q = new BlockRequestQueue(dev, elevator);
    this._devices.set(dev.name, { dev, queue: q });
    return q;
  }

  unregister(name: string): void { this._devices.delete(name); }

  queue(name: string): BlockRequestQueue | undefined { return this._devices.get(name)?.queue; }

  list(): Array<{ name: string; sectorCount: number; sectorSize: number; elevator: ElevatorAlgorithm }> {
    const arr: Array<{ name: string; sectorCount: number; sectorSize: number; elevator: ElevatorAlgorithm }> = [];
    this._devices.forEach(function({ dev, queue }) {
      arr.push({ name: dev.name, sectorCount: dev.sectorCount, sectorSize: dev.sectorSize, elevator: queue.stats().elevator });
    });
    return arr;
  }
}

export const blockDeviceRegistry = new BlockDeviceRegistry();
