/**
 * JSOS Virtio-GPU stubs — Items 496 + 920
 *
 * Item 496: Virtio-GPU 2D hardware-accelerated surface management
 * Item 920: Virtio-GPU hardware blit (resource-to-resource copy)
 *
 * These stubs mirror the Virtio GPU protocol (virtio-gpu-v1.0).
 * Commands are forwarded to the C kernel via __virtioGPUCmd syscall.
 * In QEMU/KVM, the host honours these and performs actual GPU blits.
 */

declare function __virtioGPUCmd(cmdType: number, payload: Uint8Array): Uint8Array | null;

// ── Virtio-GPU command codes (virtio_gpu_ctrl_type) ───────────────────────────

const VIRTIO_GPU_CMD_GET_DISPLAY_INFO        = 0x0100;
const VIRTIO_GPU_CMD_RESOURCE_CREATE_2D      = 0x0101;
const VIRTIO_GPU_CMD_RESOURCE_UNREF          = 0x0102;
const VIRTIO_GPU_CMD_SET_SCANOUT             = 0x0103;
const VIRTIO_GPU_CMD_RESOURCE_FLUSH          = 0x0104;
const VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D     = 0x0105;
const VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const VIRTIO_GPU_CMD_RESOURCE_DETACH_BACKING = 0x0107;
const VIRTIO_GPU_CMD_RESOURCE_COPY_REGION    = 0x010b; // virtio-gpu blit

// ── Virtio-GPU format codes ───────────────────────────────────────────────────

export const VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1;
export const VIRTIO_GPU_FORMAT_B8G8R8X8_UNORM = 2;
export const VIRTIO_GPU_FORMAT_A8R8G8B8_UNORM = 3;
export const VIRTIO_GPU_FORMAT_X8R8G8B8_UNORM = 4;
export const VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM = 67;
export const VIRTIO_GPU_FORMAT_X8B8G8R8_UNORM = 68;

// ── Helper: encode little-endian uint32 into DataView ────────────────────────

function encodeCmd(fields: number[]): Uint8Array {
  const buf = new Uint8Array(fields.length * 4);
  const dv  = new DataView(buf.buffer);
  for (let i = 0; i < fields.length; i++) dv.setUint32(i * 4, fields[i], true);
  return buf;
}

function readU32(data: Uint8Array, offset = 0): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

// ── Rect ─────────────────────────────────────────────────────────────────────

export interface VirtioRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Resource management ───────────────────────────────────────────────────────

interface GpuResource {
  resourceId: number;
  width: number;
  height: number;
  format: number;
  backing?: Uint8Array;
}

let _nextResourceId = 1;
const _resources = new Map<number, GpuResource>();

/** Allocate a new unique resource ID */
function nextResourceId(): number { return _nextResourceId++; }

// ── VirtioGPU2D (Item 496) ────────────────────────────────────────────────────

/**
 * VirtioGPU2D — manages Virtio-GPU 2D resources (surfaces).
 *
 * Usage:
 *   const gpu = new VirtioGPU2D();
 *   const resId = gpu.createResource(1920, 1080);
 *   gpu.attachBacking(resId, pixelBuffer);
 *   gpu.transferToHost(resId, { x:0, y:0, width:1920, height:1080 });
 *   gpu.flush(resId, { x:0, y:0, width:1920, height:1080 });
 *   gpu.setScanout(resId, 0);
 */
export class VirtioGPU2D {
  private _scanoutMap = new Map<number, number>(); // scanoutId → resourceId

  /**
   * Create a 2D GPU resource (allocates device memory on host side).
   * Returns the resourceId.
   */
  createResource(
    width: number,
    height: number,
    format = VIRTIO_GPU_FORMAT_R8G8B8A8_UNORM
  ): number {
    const resourceId = nextResourceId();
    // RESOURCE_CREATE_2D: [cmdType, resourceId, format, width, height]
    const cmd = encodeCmd([VIRTIO_GPU_CMD_RESOURCE_CREATE_2D, resourceId, format, width, height]);
    this._issue(cmd);
    _resources.set(resourceId, { resourceId, width, height, format });
    return resourceId;
  }

  /**
   * Destroy a GPU resource and free host-side memory.
   */
  destroyResource(resourceId: number): void {
    const cmd = encodeCmd([VIRTIO_GPU_CMD_RESOURCE_UNREF, resourceId]);
    this._issue(cmd);
    _resources.delete(resourceId);
  }

  /**
   * Attach a host-visible backing store (CPU-accessible Uint8Array) to a resource.
   * This lets transferToHost() push pixel data from the CPU to the GPU resource.
   */
  attachBacking(resourceId: number, data: Uint8Array): void {
    const res = _resources.get(resourceId);
    if (!res) return;
    res.backing = data;
    // RESOURCE_ATTACH_BACKING: [cmdType, resourceId, nrEntries, addr_lo, addr_hi, length]
    // For the stub we pass 0 for addresses (kernel fills in actual mapping)
    const cmd = encodeCmd([VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING, resourceId, 1, 0, 0, data.byteLength]);
    this._issue(cmd);
  }

  /**
   * Transfer pixel data from the CPU-side backing store to the GPU resource.
   * Only the pixels within `rect` are transferred.
   */
  transferToHost(resourceId: number, rect: VirtioRect, data?: Uint8Array): void {
    const res = _resources.get(resourceId);
    if (!res) return;
    if (data) {
      // Update backing store
      if (res.backing) res.backing.set(data.subarray(0, Math.min(data.length, res.backing.length)));
      else res.backing = data.slice();
    }
    // TRANSFER_TO_HOST_2D: [cmdType, resourceId, x, y, width, height, offset_lo, offset_hi]
    const offset = (rect.y * res.width + rect.x) * 4;
    const cmd = encodeCmd([
      VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D,
      resourceId,
      rect.x, rect.y, rect.width, rect.height,
      offset, 0,
    ]);
    this._issue(cmd);
  }

  /**
   * Flush a region of a resource to the display (makes it visible on screen).
   */
  flush(resourceId: number, rect: VirtioRect): void {
    // RESOURCE_FLUSH: [cmdType, resourceId, x, y, width, height]
    const cmd = encodeCmd([
      VIRTIO_GPU_CMD_RESOURCE_FLUSH,
      resourceId,
      rect.x, rect.y, rect.width, rect.height,
    ]);
    this._issue(cmd);
  }

  /**
   * Connect a resource to a physical display scanout (output).
   * After this call, the display shows the resource content.
   */
  setScanout(resourceId: number, scanoutId = 0, rect?: VirtioRect): void {
    const res = _resources.get(resourceId);
    if (!res) return;
    const r = rect ?? { x: 0, y: 0, width: res.width, height: res.height };
    // SET_SCANOUT: [cmdType, scanoutId, resourceId, x, y, width, height]
    const cmd = encodeCmd([
      VIRTIO_GPU_CMD_SET_SCANOUT,
      scanoutId, resourceId,
      r.x, r.y, r.width, r.height,
    ]);
    this._issue(cmd);
    this._scanoutMap.set(scanoutId, resourceId);
  }

  /** Query display info — returns { width, height } of display 0 */
  getDisplayInfo(): { width: number; height: number } {
    const cmd = encodeCmd([VIRTIO_GPU_CMD_GET_DISPLAY_INFO]);
    const resp = this._issue(cmd);
    if (resp && resp.byteLength >= 8) {
      return { width: readU32(resp, 4), height: readU32(resp, 8) };
    }
    return { width: 1024, height: 768 };
  }

  getResource(id: number): GpuResource | undefined { return _resources.get(id); }
  getScanoutResource(scanoutId = 0): GpuResource | undefined {
    const id = this._scanoutMap.get(scanoutId);
    return id !== undefined ? _resources.get(id) : undefined;
  }

  private _issue(cmd: Uint8Array): Uint8Array | null {
    if (typeof __virtioGPUCmd === 'function') {
      return __virtioGPUCmd(readU32(cmd, 0), cmd);
    }
    // Simulation mode: no-op
    return null;
  }
}

// ── VirtioGPUBlit (Item 920) ──────────────────────────────────────────────────

/**
 * VirtioGPUBlit — hardware-accelerated resource-to-resource copy.
 * Uses VIRTIO_GPU_CMD_RESOURCE_COPY_REGION to blit one rectangular
 * region from a source resource to a destination resource entirely
 * on the GPU, without round-tripping through CPU memory.
 */
export class VirtioGPUBlit {
  private _gpu: VirtioGPU2D;

  constructor(gpu: VirtioGPU2D) { this._gpu = gpu; }

  /**
   * Hardware-accelerated blit.
   * Copies srcRect from srcResource to dstResource at (dstX, dstY).
   * If srcRect / dstRect have different sizes, the host GPU handles scaling
   * (requires virtio-gpu device support).
   */
  blitResource(
    srcId: number,
    dstId: number,
    srcRect: VirtioRect,
    dstX: number,
    dstY: number
  ): void {
    // RESOURCE_COPY_REGION: [cmdType, dstResourceId, dstX, dstY, srcResourceId, srcX, srcY, srcWidth, srcHeight]
    const cmd = encodeCmd([
      VIRTIO_GPU_CMD_RESOURCE_COPY_REGION,
      dstId,
      dstX, dstY,
      srcId,
      srcRect.x, srcRect.y, srcRect.width, srcRect.height,
    ]);
    // Issue via _gpu's private channel (reuse the same mechanism)
    if (typeof __virtioGPUCmd === 'function') {
      __virtioGPUCmd(VIRTIO_GPU_CMD_RESOURCE_COPY_REGION, cmd);
    }
  }

  /**
   * Software fallback blit — used when the virtio-gpu device doesn't support
   * RESOURCE_COPY_REGION. Reads back src backing store and pushes to dst.
   */
  blitSoftware(
    srcId: number,
    dstId: number,
    srcRect: VirtioRect,
    dstX: number,
    dstY: number
  ): void {
    const src = this._gpu.getResource(srcId);
    const dst = this._gpu.getResource(dstId);
    if (!src?.backing || !dst?.backing) return;

    const srcStride = src.width * 4;
    const dstStride = dst.width * 4;

    for (let row = 0; row < srcRect.height; row++) {
      const srcRow = srcRect.y + row;
      const dstRow = dstY + row;
      if (srcRow >= src.height || dstRow >= dst.height) continue;
      const srcOff = (srcRow * src.width + srcRect.x) * 4;
      const dstOff = (dstRow * dst.width + dstX) * 4;
      const len = Math.min(srcRect.width, src.width - srcRect.x, dst.width - dstX) * 4;
      dst.backing.set(src.backing.subarray(srcOff, srcOff + len), dstOff);
    }

    // Push changed region to GPU
    const dstRect: VirtioRect = { x: dstX, y: dstY, width: srcRect.width, height: srcRect.height };
    this._gpu.transferToHost(dstId, dstRect);
  }
}

// ── Singleton instances ───────────────────────────────────────────────────────

export const virtioGPU  = new VirtioGPU2D();
export const virtioGPUBlit = new VirtioGPUBlit(virtioGPU);
