/**
 * JSOS Video Player App — Item 773
 *
 * Implements:
 *   - MP4DemuxBox: ISOBMFF/MP4 box parser (ftyp, moov, mdat, trak, mdia, stts, stsz)
 *   - WebMDemuxer: EBML element reader, Cluster/Block demux
 *   - VideoFrameBuffer: decoded frame queue with RGBA output
 *   - videoPlayer: singleton app controller
 */

// ── Syscall stub ──────────────────────────────────────────────────────────────

declare function __audioOutput(samples: Float32Array, sampleRate: number, channels: number): void;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VideoTrackInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
}

export interface AudioTrackInfo {
  codec: string;
  channels: number;
  sampleRate: number;
  durationSec: number;
}

export interface MediaInfo {
  format: 'mp4' | 'webm' | 'unknown';
  video?: VideoTrackInfo;
  audio?: AudioTrackInfo;
  durationSec: number;
}

// ── ISOBMFF / MP4 parser ─────────────────────────────────────────────────────

export interface ISOBox {
  type: string;
  offset: number;
  size: number;
  data: Uint8Array;   // box payload (excluding 8-byte header)
  children?: ISOBox[];
}

const CONTAINER_BOXES = new Set(['moov','trak','mdia','minf','stbl','udta','edts','dinf','moof','traf']);

function readU32(dv: DataView, off: number): number { return dv.getUint32(off); }
function readU64(dv: DataView, off: number): number {
  return dv.getUint32(off) * 0x100000000 + dv.getUint32(off+4);
}

export function parseISOBoxes(data: Uint8Array, end?: number): ISOBox[] {
  const boxes: ISOBox[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;
  const limit = end ?? data.length;

  while (pos + 8 <= limit) {
    let size = readU32(dv, pos);
    const type = String.fromCharCode(data[pos+4], data[pos+5], data[pos+6], data[pos+7]);
    let headerSize = 8;
    if (size === 1) { size = readU64(dv, pos+8); headerSize = 16; }
    if (size === 0) size = limit - pos;
    if (size < headerSize || pos + size > limit) break;

    const payload = data.subarray(pos + headerSize, pos + size);
    const box: ISOBox = { type, offset: pos, size, data: payload };

    if (CONTAINER_BOXES.has(type)) {
      box.children = parseISOBoxes(payload, payload.length);
    }
    boxes.push(box);
    pos += size;
  }
  return boxes;
}

/** Find a box by type path, e.g. ['moov', 'trak', 'mdia', 'hdlr'] */
export function findBox(boxes: ISOBox[], ...types: string[]): ISOBox | null {
  if (!types.length) return null;
  for (const box of boxes) {
    if (box.type === types[0]) {
      if (types.length === 1) return box;
      if (box.children) return findBox(box.children, ...types.slice(1));
      return null;
    }
  }
  return null;
}

export class MP4DemuxBox {
  private _boxes: ISOBox[];
  private _data: Uint8Array;

  constructor(data: Uint8Array) {
    this._data = data;
    this._boxes = parseISOBoxes(data);
  }

  getMediaInfo(): MediaInfo {
    const info: MediaInfo = { format: 'mp4', durationSec: 0 };

    // Duration from mvhd
    const mvhd = findBox(this._boxes, 'moov', 'mvhd');
    if (mvhd) {
      const dv = new DataView(mvhd.data.buffer, mvhd.data.byteOffset, mvhd.data.byteLength);
      const version = mvhd.data[0];
      const offset  = version === 1 ? 24 : 16;
      const timeScale = readU32(dv, version === 1 ? 20 : 12);
      const duration  = version === 1 ? readU64(dv, 24) : readU32(dv, 16);
      info.durationSec = timeScale ? duration / timeScale : 0;
    }

    // Video track
    const vtrak = this._findTrack('vide');
    if (vtrak) {
      info.video = this._parseVideoTrack(vtrak, info.durationSec);
    }

    // Audio track
    const atrak = this._findTrack('soun');
    if (atrak) {
      info.audio = this._parseAudioTrack(atrak);
    }

    return info;
  }

  /** Get raw sample data for a given track type and sample index */
  getSampleData(trackType: 'vide' | 'soun', sampleIndex: number): Uint8Array | null {
    const trak = this._findTrack(trackType);
    if (!trak?.children) return null;
    const stbl = findBox(trak.children, 'mdia', 'minf', 'stbl');
    if (!stbl?.children) return null;

    const stsz = findBox(stbl.children, 'stsz');
    const stco = findBox(stbl.children, 'stco') ?? findBox(stbl.children, 'co64');
    const stsc = findBox(stbl.children, 'stsc');
    if (!stsz || !stco || !stsc) return null;

    const dv = new DataView(stsz.data.buffer, stsz.data.byteOffset, stsz.data.byteLength);
    const sampleCount = readU32(dv, 4);
    if (sampleIndex >= sampleCount) return null;
    const sampleSize = readU32(dv, 8 + sampleIndex * 4);

    // Chunk lookup via stsc
    const scDv = new DataView(stsc.data.buffer, stsc.data.byteOffset, stsc.data.byteLength);
    const entryCount = readU32(scDv, 4);
    // stub: use offset 0 from first chunk
    const coDv = new DataView(stco.data.buffer, stco.data.byteOffset, stco.data.byteLength);
    const chunkOffset = readU32(coDv, 8); // first chunk offset

    return this._data.subarray(chunkOffset, chunkOffset + sampleSize);
  }

  private _findTrack(handlerType: string): ISOBox | null {
    const moov = findBox(this._boxes, 'moov');
    if (!moov?.children) return null;
    for (const box of moov.children) {
      if (box.type !== 'trak' || !box.children) continue;
      const hdlr = findBox(box.children, 'mdia', 'hdlr');
      if (!hdlr) continue;
      const handler = String.fromCharCode(hdlr.data[8], hdlr.data[9], hdlr.data[10], hdlr.data[11]);
      if (handler === handlerType) return box;
    }
    return null;
  }

  private _parseVideoTrack(trak: ISOBox, fallbackDuration: number): VideoTrackInfo {
    const info: VideoTrackInfo = { codec: 'unknown', width: 0, height: 0, fps: 0, durationSec: fallbackDuration };
    if (!trak.children) return info;

    // Resolution from tkhd
    const tkhd = trak.children.find(b => b.type === 'tkhd');
    if (tkhd) {
      const dv = new DataView(tkhd.data.buffer, tkhd.data.byteOffset, tkhd.data.byteLength);
      const v = tkhd.data[0];
      const off = v === 1 ? 76 : 68;
      if (off + 8 <= tkhd.data.length) {
        info.width  = readU32(dv, off) >>> 16;
        info.height = readU32(dv, off+4) >>> 16;
      }
    }

    // FPS from stts
    const stts = findBox(trak.children, 'mdia', 'minf', 'stbl', 'stts');
    if (stts) {
      const dv = new DataView(stts.data.buffer, stts.data.byteOffset, stts.data.byteLength);
      const count = readU32(dv, 4);
      if (count > 0 && stts.data.length >= 16) {
        const sampleCount = readU32(dv, 8);
        const sampleDelta = readU32(dv, 12);
        const mdhd = findBox(trak.children, 'mdia', 'mdhd');
        if (mdhd) {
          const mdv = new DataView(mdhd.data.buffer, mdhd.data.byteOffset, mdhd.data.byteLength);
          const mv = mdhd.data[0];
          const ts = readU32(mdv, mv === 1 ? 20 : 12);
          if (sampleDelta && ts) info.fps = ts / sampleDelta;
          if (ts) {
            const dur = mv === 1 ? readU64(mdv, 24) : readU32(mdv, 16);
            info.durationSec = dur / ts;
          }
        }
        void sampleCount;
      }
    }

    // Codec from stsd
    const stsd = findBox(trak.children, 'mdia', 'minf', 'stbl', 'stsd');
    if (stsd && stsd.data.length > 16) {
      info.codec = String.fromCharCode(stsd.data[12], stsd.data[13], stsd.data[14], stsd.data[15]);
    }

    return info;
  }

  private _parseAudioTrack(trak: ISOBox): AudioTrackInfo {
    const info: AudioTrackInfo = { codec: 'unknown', channels: 2, sampleRate: 44100, durationSec: 0 };
    if (!trak.children) return info;

    const stsd = findBox(trak.children, 'mdia', 'minf', 'stbl', 'stsd');
    if (stsd && stsd.data.length > 34) {
      info.codec    = String.fromCharCode(stsd.data[12], stsd.data[13], stsd.data[14], stsd.data[15]);
      const dv = new DataView(stsd.data.buffer, stsd.data.byteOffset, stsd.data.byteLength);
      info.channels   = dv.getUint16(24);
      info.sampleRate = readU32(dv, 28) >>> 16;
    }
    return info;
  }
}

// ── WebM / EBML parser ────────────────────────────────────────────────────────

export interface EBMLElement {
  id: number;
  size: number;
  offset: number;
  data: Uint8Array;
}

export function readVInt(data: Uint8Array, pos: number): [number, number] {
  // Returns [value, bytesRead]
  if (pos >= data.length) return [0, 0];
  const first = data[pos];
  if (first & 0x80) return [first & 0x7F, 1];
  if (first & 0x40) return [(first & 0x3F) << 8  | data[pos+1], 2];
  if (first & 0x20) return [(first & 0x1F) << 16 | data[pos+1] << 8 | data[pos+2], 3];
  if (first & 0x10) return [(first & 0x0F) << 24 | data[pos+1] << 16 | data[pos+2] << 8 | data[pos+3], 4];
  return [0, 1];
}

export function parseEBMLElements(data: Uint8Array, maxDepth = 4): EBMLElement[] {
  const elements: EBMLElement[] = [];
  let pos = 0;

  while (pos + 2 < data.length) {
    // Read element ID (variable-length)
    const idFirst = data[pos];
    let idBytes = 1;
    if (!(idFirst & 0x80))      idBytes = 2;
    if (!(idFirst & 0xC0))      idBytes = 3;
    if (!(idFirst & 0xE0))      idBytes = 4;
    if (pos + idBytes + 1 > data.length) break;

    let id = 0;
    for (let k = 0; k < idBytes; k++) id = (id << 8) | data[pos+k];

    // Read element size (vint, mask off leading bit)
    const [size, sizeBytes] = readVInt(data, pos + idBytes);
    const headerLen = idBytes + sizeBytes;
    if (pos + headerLen + size > data.length) break;

    const payload = data.subarray(pos + headerLen, pos + headerLen + size);
    elements.push({ id, size, offset: pos, data: payload });
    pos += headerLen + size;
  }
  return elements;
}

// Well-known EBML IDs (subset of Matroska/WebM)
const EBML_EBML    = 0x1A45DFA3;
const EBML_SEGMENT = 0x18538067;
const EBML_INFO    = 0x1549A966;
const EBML_TRACKS  = 0x1654AE6B;
const EBML_CLUSTER = 0x1F43B675;
const EBML_BLOCK   = 0xA1;
const EBML_SIMPLE_BLOCK = 0xA3;

export interface WebMBlock {
  trackNumber: number;
  timecode: number;  // relative to cluster
  keyframe: boolean;
  data: Uint8Array;  // encoded frame payload
}

export class WebMDemuxer {
  private _data: Uint8Array;

  constructor(data: Uint8Array) { this._data = data; }

  getMediaInfo(): MediaInfo {
    const info: MediaInfo = { format: 'webm', durationSec: 0 };
    const segs = parseEBMLElements(this._data);
    const seg = segs.find(e => e.id === EBML_SEGMENT);
    if (!seg) return info;

    const topLevel = parseEBMLElements(seg.data);
    const infoEl  = topLevel.find(e => e.id === EBML_INFO);
    const tracksEl = topLevel.find(e => e.id === EBML_TRACKS);

    if (infoEl) {
      const fields = parseEBMLElements(infoEl.data);
      const durEl = fields.find(e => e.id === 0x4489);
      if (durEl?.data.length >= 8) {
        const dv = new DataView(durEl.data.buffer, durEl.data.byteOffset);
        info.durationSec = dv.getFloat64(0) / 1000000; // nanoseconds → seconds (TimestampScale assumed 1ms)
      }
    }

    if (tracksEl) {
      const tracks = parseEBMLElements(tracksEl.data);
      for (const trak of tracks) {
        if (trak.id !== 0xAE) continue; // TrackEntry
        const fields = parseEBMLElements(trak.data);
        const typeEl  = fields.find(e => e.id === 0x83); // TrackType
        const codecEl = fields.find(e => e.id === 0x86); // CodecID
        const videoEl = fields.find(e => e.id === 0xE0); // Video
        const audioEl = fields.find(e => e.id === 0xE1); // Audio
        const ttype   = typeEl?.data[0] ?? 0;
        const codec   = codecEl ? new TextDecoder().decode(codecEl.data) : 'unknown';

        if (ttype === 1 && videoEl) {
          const vf = parseEBMLElements(videoEl.data);
          const wEl = vf.find(e => e.id === 0xB0); // PixelWidth
          const hEl = vf.find(e => e.id === 0xBA); // PixelHeight
          info.video = {
            codec,
            width:  wEl ? readU16LE(wEl.data)  : 0,
            height: hEl ? readU16LE(hEl.data) : 0,
            fps: 0,
            durationSec: info.durationSec,
          };
        }
        if (ttype === 2 && audioEl) {
          const af = parseEBMLElements(audioEl.data);
          const srEl  = af.find(e => e.id === 0xB5); // SamplingFrequency
          const chEl  = af.find(e => e.id === 0x9F); // Channels
          info.audio = {
            codec,
            sampleRate: srEl ? readFloat32BE(srEl.data) : 44100,
            channels:   chEl ? chEl.data[0] : 2,
            durationSec: info.durationSec,
          };
        }
      }
    }

    return info;
  }

  /** Iterate all blocks in all clusters, calling callback for each */
  demuxBlocks(callback: (block: WebMBlock, clusterTimecode: number) => void): void {
    const segs = parseEBMLElements(this._data);
    const seg = segs.find(e => e.id === EBML_SEGMENT);
    if (!seg) return;
    const topLevel = parseEBMLElements(seg.data);

    for (const clusterEl of topLevel.filter(e => e.id === EBML_CLUSTER)) {
      const fields = parseEBMLElements(clusterEl.data);
      const tcEl   = fields.find(e => e.id === 0xE7); // Timestamp
      const clusterTC = tcEl ? readVarInt(tcEl.data) : 0;

      for (const el of fields) {
        if (el.id !== EBML_BLOCK && el.id !== EBML_SIMPLE_BLOCK) continue;
        const block = this._parseBlock(el.data, el.id === EBML_SIMPLE_BLOCK);
        callback(block, clusterTC);
      }
    }
  }

  private _parseBlock(data: Uint8Array, isSimple: boolean): WebMBlock {
    const [trackNumber, vnBytes] = readVInt(data, 0);
    const timecode = (data[vnBytes] << 8) | data[vnBytes+1];
    const flags = data[vnBytes+2];
    const keyframe = isSimple ? !!(flags & 0x80) : !!(flags & 0x80);
    const frameData = data.subarray(vnBytes + 3);
    return { trackNumber, timecode, keyframe, data: frameData };
  }
}

// ── Video frame buffer ────────────────────────────────────────────────────────

export class VideoFrameBuffer {
  private _frames: Map<number, Uint8Array> = new Map(); // presentationTs → RGBA frame
  private _maxFrames: number;
  private _frameW: number;
  private _frameH: number;

  constructor(width: number, height: number, maxFrames = 30) {
    this._frameW = width;
    this._frameH = height;
    this._maxFrames = maxFrames;
  }

  /** Store a decoded RGBA frame for a given presentation timestamp (ms) */
  putFrame(pts: number, rgba: Uint8Array): void {
    if (this._frames.size >= this._maxFrames) {
      // Evict oldest
      const oldest = Math.min(...this._frames.keys());
      this._frames.delete(oldest);
    }
    this._frames.set(pts, rgba);
  }

  /** Get the closest frame to the requested PTS */
  getFrame(pts: number): Uint8Array | null {
    if (!this._frames.size) return null;
    let bestPts = [...this._frames.keys()].reduce((a, b) => Math.abs(a-pts) < Math.abs(b-pts) ? a : b);
    return this._frames.get(bestPts) ?? null;
  }

  /** Allocate a blank RGBA frame for software decoding */
  allocFrame(): Uint8Array { return new Uint8Array(this._frameW * this._frameH * 4); }

  clear(): void { this._frames.clear(); }
  get width():  number { return this._frameW; }
  get height(): number { return this._frameH; }
  get bufferedFrameCount(): number { return this._frames.size; }
}

// ── VideoPlayerApp ────────────────────────────────────────────────────────────

export class VideoPlayerApp {
  private _mediaInfo: MediaInfo | null = null;
  private _mp4: MP4DemuxBox | null = null;
  private _webm: WebMDemuxer | null = null;
  private _frameBuffer: VideoFrameBuffer | null = null;
  private _fb: Uint8Array | null = null;
  private _fbW = 0;
  private _fbH = 0;
  private _playing = false;
  private _positionMs = 0;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _frameDurationMs = 1000 / 30;

  onFrameRendered: ((pts: number) => void) | null = null;

  load(data: Uint8Array): MediaInfo {
    // Detect format by signature
    const sig4 = String.fromCharCode(data[4], data[5], data[6], data[7]);
    const isMP4 = sig4 === 'ftyp' || sig4 === 'moov' || sig4 === 'mdat' ||
                  data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] >= 4 && sig4 === 'ftyp';
    const isWebM = data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3;

    if (isMP4) {
      this._mp4 = new MP4DemuxBox(data);
      this._mediaInfo = this._mp4.getMediaInfo();
    } else if (isWebM) {
      this._webm = new WebMDemuxer(data);
      this._mediaInfo = this._webm.getMediaInfo();
    } else {
      this._mediaInfo = { format: 'unknown', durationSec: 0 };
    }

    const v = this._mediaInfo.video;
    if (v) {
      this._frameBuffer = new VideoFrameBuffer(v.width || 640, v.height || 480, 60);
      if (v.fps > 0) this._frameDurationMs = 1000 / v.fps;
      this._prepareSoftwareDecode();
    }

    return this._mediaInfo;
  }

  setFramebuffer(fb: Uint8Array, width: number, height: number): void {
    this._fb = fb; this._fbW = width; this._fbH = height;
  }

  play(): void {
    if (this._playing) return;
    this._playing = true;
    this._scheduleFrames();
  }

  pause(): void { this._playing = false; if (this._timer !== null) { clearInterval(this._timer as unknown as number); this._timer = null; } }
  stop():  void { this.pause(); this._positionMs = 0; }
  seek(sec: number): void { this._positionMs = sec * 1000; }

  get playing():    boolean { return this._playing; }
  get positionSec(): number { return this._positionMs / 1000; }
  get mediaInfo(): MediaInfo | null { return this._mediaInfo; }

  private _scheduleFrames(): void {
    this._timer = setInterval(() => {
      if (!this._playing) return;
      this._renderFrameAt(this._positionMs);
      this._positionMs += this._frameDurationMs;
      if (this._mediaInfo && this._positionMs > this._mediaInfo.durationSec * 1000) {
        this.stop();
      }
    }, this._frameDurationMs) as unknown as ReturnType<typeof setInterval>;
  }

  private _renderFrameAt(pts: number): void {
    if (!this._fb || !this._frameBuffer) return;
    const frame = this._frameBuffer.getFrame(pts);
    if (!frame) return;
    // Blit frame to framebuffer (nearest-neighbour scale)
    const fw = this._frameBuffer.width, fh = this._frameBuffer.height;
    for (let py = 0; py < this._fbH; py++) {
      const srcY = Math.floor(py * fh / this._fbH);
      for (let px = 0; px < this._fbW; px++) {
        const srcX = Math.floor(px * fw / this._fbW);
        const si = (srcY * fw + srcX) * 4;
        const di = (py * this._fbW + px) * 4;
        this._fb[di]   = frame[si];
        this._fb[di+1] = frame[si+1];
        this._fb[di+2] = frame[si+2];
        this._fb[di+3] = frame[si+3];
      }
    }
    this.onFrameRendered?.(pts);
  }

  /** Software decode stub: generate test pattern frames for the entire video */
  private _prepareSoftwareDecode(): void {
    if (!this._frameBuffer || !this._mediaInfo) return;
    const dur   = this._mediaInfo.durationSec;
    const step  = this._frameDurationMs;
    const total = Math.min(60, Math.floor(dur * 1000 / step)); // pre-decode up to 60 frames

    for (let i = 0; i < total; i++) {
      const pts  = i * step;
      const frame = this._frameBuffer.allocFrame();
      this._fillTestPattern(frame, this._frameBuffer.width, this._frameBuffer.height, i);
      this._frameBuffer.putFrame(pts, frame);
    }
  }

  /** Fills a frame with an animated colour-bar test pattern */
  private _fillTestPattern(fb: Uint8Array, w: number, h: number, frameIndex: number): void {
    const phase = (frameIndex / 30) * Math.PI * 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        fb[i]   = Math.round(128 + 127 * Math.sin(phase + x / w * Math.PI * 2));
        fb[i+1] = Math.round(128 + 127 * Math.sin(phase + y / h * Math.PI * 2));
        fb[i+2] = Math.round(128 + 127 * Math.cos(phase));
        fb[i+3] = 255;
      }
    }
  }
}

// ── Helper utils ──────────────────────────────────────────────────────────────

function readU16LE(data: Uint8Array): number { return data[0] | (data[1] << 8); }
function readFloat32BE(data: Uint8Array): number {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return data.length >= 4 ? dv.getFloat32(0) : 44100;
}
function readVarInt(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < Math.min(8, data.length); i++) n = n * 256 + data[i];
  return n;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const videoPlayer = new VideoPlayerApp();
