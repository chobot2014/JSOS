/**
 * JSOS DRM / KMS Shim — Phase 8
 *
 * Implements the Linux DRM/KMS ioctl interface as a TypeScript FileDescription
 * mounted at /dev/dri/card0.  Chromium's Ozone/DRM layer opens this device
 * and drives it via ioctl calls to configure display modes and flip
 * framebuffers; we translate those calls to Canvas.flip() / SwiftShader.
 *
 * No new C code required — all logic is in TypeScript using existing Phase 3
 * framebuffer, Phase 4 vmm, and Phase 8 SwiftShader APIs.
 *
 * Phase 8 delivers: ioctl dispatch table, dumb-buffer allocation, page-flip.
 * Phase 9 will call this from the actual Chromium process after exec().
 */

import type { Canvas } from '../ui/canvas.js';
import type { FileDescription } from '../core/fdtable.js';
import type { VFSMount }        from '../fs/filesystem.js';
import { swiftShader }          from '../graphics/swiftshader.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── DRM ioctl request numbers (Linux uapi/drm/drm.h + drm_mode.h) ─────────

export const DRM_IOCTL_VERSION         = 0x00;
export const DRM_IOCTL_GET_UNIQUE      = 0x01;
export const DRM_IOCTL_GET_MAGIC       = 0x02;
export const DRM_IOCTL_AUTH_MAGIC      = 0x11;
export const DRM_IOCTL_GET_CAP        = 0x0c;
export const DRM_IOCTL_SET_CLIENT_CAP = 0x0d;

// Mode-setting ioctls (base 0xA0)
export const DRM_IOCTL_MODE_GETRESOURCES  = 0xa0;
export const DRM_IOCTL_MODE_GETCRTC       = 0xa1;
export const DRM_IOCTL_MODE_SETCRTC       = 0xa2;
export const DRM_IOCTL_MODE_CURSOR        = 0xa3;
export const DRM_IOCTL_MODE_GETGAMMA      = 0xa4;
export const DRM_IOCTL_MODE_SETGAMMA      = 0xa5;
export const DRM_IOCTL_MODE_GETENCODER    = 0xa6;
export const DRM_IOCTL_MODE_GETCONNECTOR  = 0xa7;
export const DRM_IOCTL_MODE_GETPROPERTY   = 0xaa;
export const DRM_IOCTL_MODE_SETPROPERTY   = 0xab;
export const DRM_IOCTL_MODE_GETPROPBLOB   = 0xac;
export const DRM_IOCTL_MODE_GETPLANE      = 0xad;
export const DRM_IOCTL_MODE_ADDFB         = 0xae;
export const DRM_IOCTL_MODE_RMFB          = 0xaf;
export const DRM_IOCTL_MODE_PAGE_FLIP     = 0xb0;
export const DRM_IOCTL_MODE_DIRTYFB       = 0xb1;
export const DRM_IOCTL_MODE_CREATE_DUMB   = 0xb2;
export const DRM_IOCTL_MODE_MAP_DUMB      = 0xb3;
export const DRM_IOCTL_MODE_DESTROY_DUMB  = 0xb4;
export const DRM_IOCTL_MODE_GETPLANERESOURCES = 0xb5;
export const DRM_IOCTL_MODE_ADDFB2        = 0xb8;
export const DRM_IOCTL_MODE_OBJ_GETPROPERTIES = 0xb9;
export const DRM_IOCTL_MODE_OBJ_SETPROPERTY   = 0xba;
export const DRM_IOCTL_MODE_ATOMIC        = 0xbc;

// DRM capability IDs
export const DRM_CAP_DUMB_BUFFER          = 0x1;
export const DRM_CAP_VBLANK_HIGH_CRTC     = 0x2;
export const DRM_CAP_DUMB_PREFERRED_DEPTH = 0x3;
export const DRM_CAP_DUMB_PREFER_SHADOW   = 0x4;
export const DRM_CAP_PRIME               = 0x5;
export const DRM_CAP_TIMESTAMP_MONOTONIC = 0x6;
export const DRM_CAP_ASYNC_PAGE_FLIP     = 0x7;
export const DRM_CAP_CURSOR_WIDTH        = 0x8;
export const DRM_CAP_CURSOR_HEIGHT       = 0x9;
export const DRM_CAP_ADDFB2_MODIFIERS   = 0x10;
export const DRM_CAP_PAGE_FLIP_TARGET   = 0x11;
export const DRM_CLIENT_CAP_STEREO_3D   = 1;
export const DRM_CLIENT_CAP_UNIVERSAL_PLANES = 2;
export const DRM_CLIENT_CAP_ATOMIC      = 3;

// DRM connector states
export const DRM_MODE_CONNECTED         = 1;
export const DRM_MODE_DISCONNECTED      = 2;

// DRM connector types
export const DRM_MODE_CONNECTOR_VGA     = 1;
export const DRM_MODE_CONNECTOR_HDMIA   = 11;

// DRM encoder types
export const DRM_MODE_ENCODER_DAC       = 1;

// POSIX errno values (subset)
const EINVAL  = -22;
const ENOENT  = -2;
const ENOSYS  = -38;

// ── Internal data model ────────────────────────────────────────────────────

interface DRMMode {
  width:  number;
  height: number;
  vrefresh: number;  // Hz
  name:   string;
}

interface DRMCrtc {
  id:     number;
  width:  number;
  height: number;
  fbId:   number;
}

interface DRMEncoder {
  id:     number;
  type:   number;
  crtcId: number;
}

interface DRMConnector {
  id:        number;
  type:      number;
  state:     number;
  encoderId: number;
  modes:     DRMMode[];
}

interface DRMDumbBuffer {
  handle: number;
  width:  number;
  height: number;
  bpp:    number;
  pitch:  number;
  size:   number;
  offset: number;       // mmap offset (== simulated physical address)
  pixels: Uint32Array;
}

interface DRMFramebuffer {
  id:     number;
  handle: number;
  width:  number;
  height: number;
  depth:  number;
  bpp:    number;
  pitch:  number;
}

// ── DRM device ────────────────────────────────────────────────────────────

export class DRMDevice implements FileDescription {
  private _canvas:       Canvas | null = null;
  private _width:        number = 0;
  private _height:       number = 0;

  // DRM object sets
  private _crtcs:       DRMCrtc[]      = [];
  private _encoders:    DRMEncoder[]   = [];
  private _connectors:  DRMConnector[] = [];
  private _framebuffers: Map<number, DRMFramebuffer> = new Map();
  private _dumbBuffers:  Map<number, DRMDumbBuffer>  = new Map();

  // ID allocator
  private _nextId:     number = 1;

  // Page-flip count (for testing)
  private _flipCount:  number = 0;

  // ── Attach to framebuffer ────────────────────────────────────────────────

  attachCanvas(canvas: Canvas): void {
    this._canvas  = canvas;
    this._width   = canvas.width;
    this._height  = canvas.height;

    var mode: DRMMode = {
      width: this._width, height: this._height, vrefresh: 60,
      name:  this._width + 'x' + this._height,
    };

    var crtcId    = this._nextId++;
    var encId     = this._nextId++;
    var connId    = this._nextId++;

    this._crtcs.push({ id: crtcId, width: this._width, height: this._height, fbId: 0 });
    this._encoders.push({ id: encId, type: DRM_MODE_ENCODER_DAC, crtcId: crtcId });
    this._connectors.push({
      id: connId, type: DRM_MODE_CONNECTOR_HDMIA,
      state: DRM_MODE_CONNECTED, encoderId: encId, modes: [mode],
    });

    kernel.serialPut('DRM: /dev/dri/card0 ready (' +
                     this._width + 'x' + this._height + ')\n');
  }

  // ── FileDescription interface ────────────────────────────────────────────

  read(_count: number): number[] { return []; }
  write(_data: number[]): number { return -1; }
  seek(_offset: number, _whence: number): number { return -1; }
  close(): void { /* device persists */ }

  // ── ioctl dispatch ───────────────────────────────────────────────────────

  ioctl(request: number, arg: number): number {
    switch (request) {

      case DRM_IOCTL_VERSION:
        // arg is a pointer to drm_version struct — in our TS simulation
        // we just return success; Phase 9 Chromium will interpret via mmap.
        return 0;

      case DRM_IOCTL_GET_MAGIC:
        return 0; // grant magic 0 (single-process DRM, always authenticated)

      case DRM_IOCTL_AUTH_MAGIC:
        return 0;

      case DRM_IOCTL_GET_CAP:
        return this._getCap(arg);

      case DRM_IOCTL_SET_CLIENT_CAP:
        return 0; // accept all client capabilities

      case DRM_IOCTL_MODE_GETRESOURCES:
        return this._getResources(arg);

      case DRM_IOCTL_MODE_GETCRTC:
        return this._getCrtc(arg);

      case DRM_IOCTL_MODE_SETCRTC:
        return this._setCrtc(arg);

      case DRM_IOCTL_MODE_GETENCODER:
        return this._getEncoder(arg);

      case DRM_IOCTL_MODE_GETCONNECTOR:
        return this._getConnector(arg);

      case DRM_IOCTL_MODE_ADDFB:
        return this._addFb(arg);

      case DRM_IOCTL_MODE_ADDFB2:
        return this._addFb2(arg);

      case DRM_IOCTL_MODE_RMFB:
        this._framebuffers.delete(arg);
        return 0;

      case DRM_IOCTL_MODE_PAGE_FLIP:
        return this._pageFlip(arg);

      case DRM_IOCTL_MODE_CREATE_DUMB:
        return this._createDumb(arg);

      case DRM_IOCTL_MODE_MAP_DUMB:
        return this._mapDumb(arg);

      case DRM_IOCTL_MODE_DESTROY_DUMB:
        this._dumbBuffers.delete(arg);
        return 0;

      case DRM_IOCTL_MODE_GETPLANE:
      case DRM_IOCTL_MODE_GETPLANERESOURCES:
        return EINVAL; // no plane support in Phase 8

      default:
        kernel.serialPut('DRM: unknown ioctl 0x' + request.toString(16) + '\n');
        return ENOSYS;
    }
  }

  // ── ioctl implementations ────────────────────────────────────────────────

  private _getCap(capId: number): number {
    switch (capId) {
      case DRM_CAP_DUMB_BUFFER:          return 1;
      case DRM_CAP_DUMB_PREFERRED_DEPTH: return 32;
      case DRM_CAP_DUMB_PREFER_SHADOW:   return 0;
      case DRM_CAP_PRIME:                return 0;
      case DRM_CAP_TIMESTAMP_MONOTONIC:  return 1;
      case DRM_CAP_ASYNC_PAGE_FLIP:      return 0;
      case DRM_CAP_CURSOR_WIDTH:         return 64;
      case DRM_CAP_CURSOR_HEIGHT:        return 64;
      case DRM_CAP_ADDFB2_MODIFIERS:    return 0;
      default:                           return EINVAL;
    }
  }

  private _getResources(_arg: number): number {
    // In production: write counts + IDs into the userspace struct at arg.
    // For Phase 8 testing we just return counts (trusting arg=0 test calls).
    // Phase 9 wires real struct writes via vmm.writeU32(arg + offset, val).
    return 0; // success; Chromium retries with populated arrays
  }

  private _getCrtc(crtcId: number): number {
    for (var i = 0; i < this._crtcs.length; i++) {
      if (this._crtcs[i].id === crtcId) return 0;
    }
    return EINVAL;
  }

  private _setCrtc(_arg: number): number {
    // Accept CRTC mode-set; display is always-on at our fixed resolution.
    return 0;
  }

  private _getEncoder(encId: number): number {
    for (var i = 0; i < this._encoders.length; i++) {
      if (this._encoders[i].id === encId) return 0;
    }
    return EINVAL;
  }

  private _getConnector(connId: number): number {
    for (var i = 0; i < this._connectors.length; i++) {
      if (this._connectors[i].id === connId) return 0;
    }
    return EINVAL;
  }

  private _addFb(arg: number): number {
    // arg encodes: (handle | (width << 8) | (height << 16)) — simplified packing
    // for Phase 9 full struct support.
    var fbId = this._nextId++;
    this._framebuffers.set(fbId, {
      id: fbId, handle: arg & 0xff,
      width:  this._width, height: this._height,
      depth: 24, bpp: 32, pitch: this._width * 4,
    });
    return fbId;
  }

  private _addFb2(arg: number): number {
    return this._addFb(arg); // same handling for Phase 8
  }

  /**
   * DRM page-flip: copy pixels from the named framebuffer's dumb buffer
   * into SwiftShader's render target and call present().
   *
   * arg = framebuffer ID (or 0 for "present whatever is in the render target").
   */
  private _pageFlip(arg: number): number {
    if (arg !== 0) {
      var fb = this._framebuffers.get(arg);
      if (!fb) return EINVAL;
      var db = this._dumbBuffers.get(fb.handle);
      if (db) {
        swiftShader.blitRaw(db.pixels, 0, 0, db.width, db.height);
      }
    }
    swiftShader.present();
    this._flipCount++;
    return 0;
  }

  /**
   * DRM_IOCTL_MODE_CREATE_DUMB — allocate a dumb (CPU-accessible) buffer.
   * arg encodes requested (width | height<<16) for Phase 8 testing.
   * Phase 9 reads the real drm_mode_create_dumb struct via vmm.
   */
  private _createDumb(arg: number): number {
    var reqW = arg & 0xffff || this._width;
    var reqH = (arg >> 16) & 0xffff || this._height;
    var handle = this._nextId++;
    var pitch  = reqW * 4;  // 32-bit pixels
    var size   = pitch * reqH;
    var offset = 0x40000000 + handle * 0x400000; // simulated mmap offset

    this._dumbBuffers.set(handle, {
      handle, width: reqW, height: reqH, bpp: 32,
      pitch, size, offset,
      pixels: new Uint32Array(reqW * reqH),
    });
    return handle; // return handle as success code; Phase 9 struct-packs it
  }

  /** DRM_IOCTL_MODE_MAP_DUMB — return the mmap offset for a dumb buffer handle. */
  private _mapDumb(handle: number): number {
    var db = this._dumbBuffers.get(handle);
    return db ? db.offset : EINVAL;
  }

  // ── Public accessors ─────────────────────────────────────────────────────

  get flipCount(): number { return this._flipCount; }
  get crtcs():      DRMCrtc[]      { return this._crtcs;      }
  get connectors(): DRMConnector[] { return this._connectors; }
  get encoders():   DRMEncoder[]   { return this._encoders;   }

  getDumbBuffer(handle: number): DRMDumbBuffer | undefined {
    return this._dumbBuffers.get(handle);
  }

  getFramebuffer(id: number): DRMFramebuffer | undefined {
    return this._framebuffers.get(id);
  }

  get width():  number { return this._width;  }
  get height(): number { return this._height; }
}

// ── VFS mount for /dev/dri ────────────────────────────────────────────────

/**
 * VFSMount adapter that exposes /dev/dri/card0 to the filesystem.ts
 * mount table.  Mounted at '/dev/dri' by main.ts during Phase 8 boot.
 *
 * When syscalls.open('/dev/dri/card0') is called, it bypasses this VFSMount
 * (which returns dummy string content) and instead calls
 * globalFDTable.openDesc(drmDevice) to register the real DRMDevice
 * FileDescription.  This VFSMount only exists so that ls('/dev/dri') and
 * fs.exists('/dev/dri/card0') work correctly.
 */
export class DRMVFSMount implements VFSMount {
  read(path: string): string | null {
    if (path === '/dev/dri/card0') return '';   // exists but content via ioctl
    return null;
  }

  list(path: string): Array<{ name: string; type: 'file' | 'directory'; size: number }> {
    if (path === '/dev/dri' || path === '/dev/dri/') {
      return [{ name: 'card0', type: 'file' as const, size: 0 }];
    }
    return [];
  }

  exists(path: string): boolean {
    return path === '/dev/dri' || path === '/dev/dri/' ||
           path === '/dev/dri/card0';
  }

  isDirectory(path: string): boolean {
    return path === '/dev/dri' || path === '/dev/dri/';
  }
}

/** Process-global DRM device singleton. Wire to canvas via attachCanvas(). */
export const drmDevice    = new DRMDevice();
export const drmVFSMount  = new DRMVFSMount();
