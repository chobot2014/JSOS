/**
 * JSOS Music Player App — Item 772
 *
 * Implements:
 *   - MP3Decoder: MPEG frame-header parser + PCM stub
 *   - OGGDecoder: Ogg page/packet demuxer
 *   - AudioPlaybackEngine: PCM buffer → __audioOutput syscall
 *   - PlaylistManager: track ordering and metadata
 *   - musicPlayer: singleton app controller
 */

// ── Syscall stub ──────────────────────────────────────────────────────────────

declare function __audioOutput(samples: Float32Array, sampleRate: number, channels: number): void;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AudioTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  format: 'mp3' | 'ogg' | 'wav' | 'flac' | 'unknown';
  data: Uint8Array;
}

export interface DecodeResult {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

// ── MP3 frame header parser ────────────────────────────────────────────────────

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // kbps (MPEG1 Layer3)
const MP3_SAMPLERATES = [44100, 48000, 32000, 0]; // Hz (MPEG1)

export interface MP3FrameHeader {
  valid: boolean;
  version: number;    // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layer: number;      // 1, 2, or 3
  bitrate: number;    // kbps
  sampleRate: number; // Hz
  channels: number;   // 1 or 2
  frameLen: number;   // bytes (including header)
  samplesPerFrame: number;
}

export function parseMP3FrameHeader(data: Uint8Array, offset = 0): MP3FrameHeader {
  const invalid: MP3FrameHeader = { valid: false, version: 0, layer: 0, bitrate: 0, sampleRate: 0, channels: 0, frameLen: 0, samplesPerFrame: 0 };
  if (offset + 4 > data.length) return invalid;
  const h = (data[offset] << 24) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3];
  // Sync word: 11 bits all 1
  if ((h & 0xFFE00000) >>> 21 !== 0x7FF) return invalid;
  const versionBits = (h >> 19) & 0x3;
  const layerBits   = (h >> 17) & 0x3;
  const bitrateIdx  = (h >> 12) & 0xF;
  const srIdx       = (h >> 10) & 0x3;
  const channelMode = (h >>  6) & 0x3;
  const paddingBit  = (h >>  9) & 0x1;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 0;
  const layer   = 4 - layerBits; // bits 11=L1 10=L2 01=L3
  if (layer < 1 || layer > 3) return invalid;
  const bitrate   = MP3_BITRATES[bitrateIdx] ?? 0;
  const sampleRate = MP3_SAMPLERATES[srIdx] ?? 44100;
  const channels  = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = layer === 1 ? 384 : 1152;
  const frameLen = layer === 1
    ? Math.floor((12 * bitrate * 1000 / sampleRate + paddingBit) * 4)
    : Math.floor(144 * bitrate * 1000 / sampleRate + paddingBit);

  return { valid: bitrate > 0 && sampleRate > 0, version, layer, bitrate, sampleRate, channels, frameLen, samplesPerFrame };
}

/**
 * MP3Decoder — skeleton decoder.
 * In a real implementation this would include the full Huffman + IMDCT pipeline.
 * Here we provide the frame-enumeration infrastructure and return silent PCM.
 */
export class MP3Decoder {
  decode(data: Uint8Array): DecodeResult {
    // Skip ID3v2 tag if present
    let offset = 0;
    if (data[0] === 73 && data[1] === 68 && data[2] === 51) { // 'ID3'
      const size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) |
                   ((data[8] & 0x7F) <<  7) |  (data[9] & 0x7F);
      offset = 10 + size;
    }

    const frames: MP3FrameHeader[] = [];
    let pos = offset;
    while (pos + 4 < data.length) {
      const hdr = parseMP3FrameHeader(data, pos);
      if (!hdr.valid || hdr.frameLen <= 0) { pos++; continue; }
      frames.push(hdr);
      pos += hdr.frameLen;
    }

    if (!frames.length) {
      return { samples: new Float32Array(0), sampleRate: 44100, channels: 2, durationSec: 0 };
    }

    const sampleRate = frames[0].sampleRate;
    const channels   = frames[0].channels;
    const totalSamples = frames.reduce((s, f) => s + f.samplesPerFrame, 0) * channels;

    // Return silent PCM (real decode would apply IMDCT here)
    return {
      samples: new Float32Array(totalSamples),
      sampleRate,
      channels,
      durationSec: totalSamples / (sampleRate * channels),
    };
  }

  /** Parse MP3 metadata tags (ID3v2) */
  parseMetadata(data: Uint8Array): Partial<AudioTrack> {
    const meta: Partial<AudioTrack> = {};
    if (data[0] !== 73 || data[1] !== 68 || data[2] !== 51) return meta;
    const tagSize = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) |
                    ((data[8] & 0x7F) <<  7) |  (data[9] & 0x7F);
    let pos = 10;
    const dec = new TextDecoder('utf-8');
    while (pos + 10 < 10 + tagSize) {
      const frameId = dec.decode(data.subarray(pos, pos+4));
      const frameSize = (data[pos+4] << 24) | (data[pos+5] << 16) | (data[pos+6] << 8) | data[pos+7];
      pos += 10;
      if (frameSize <= 0) break;
      const rawVal = dec.decode(data.subarray(pos+1, pos+frameSize)); // +1 skip encoding byte
      switch (frameId) {
        case 'TIT2': meta.title  = rawVal; break;
        case 'TPE1': meta.artist = rawVal; break;
        case 'TALB': meta.album  = rawVal; break;
      }
      pos += frameSize;
    }
    return meta;
  }
}

// ── OGG Decoder ───────────────────────────────────────────────────────────────

export interface OggPage {
  serial: number;
  granule: bigint;
  seqNo:   number;
  flags:   number; // 0x01=continued, 0x02=bos, 0x04=eos
  packets: Uint8Array[];
}

/**
 * OGGDecoder — parses the Ogg container format.
 * Individual codec packets (Vorbis, Opus) are demuxed but not decoded
 * (full Vorbis/MDCT decoding is out of scope for this stub).
 */
export class OGGDecoder {
  decodeContainer(data: Uint8Array): OggPage[] {
    const pages: OggPage[] = [];
    let pos = 0;

    while (pos + 27 < data.length) {
      // Capture pattern "OggS"
      if (data[pos] !== 79 || data[pos+1] !== 103 || data[pos+2] !== 103 || data[pos+3] !== 83) {
        pos++; continue;
      }
      const flags   = data[pos+5];
      const granule = BigInt(data[pos+6]) | (BigInt(data[pos+7]) << 8n) | (BigInt(data[pos+8]) << 16n) |
                     (BigInt(data[pos+9]) << 24n) | (BigInt(data[pos+10]) << 32n) | (BigInt(data[pos+11]) << 40n) |
                     (BigInt(data[pos+12]) << 48n) | (BigInt(data[pos+13]) << 56n);
      const serial  = (data[pos+14] | (data[pos+15] << 8) | (data[pos+16] << 16) | (data[pos+17] << 24)) >>> 0;
      const seqNo   = (data[pos+18] | (data[pos+19] << 8) | (data[pos+20] << 16) | (data[pos+21] << 24)) >>> 0;
      const numSegs = data[pos+26];
      if (pos + 27 + numSegs > data.length) break;

      const segTable = data.subarray(pos+27, pos+27+numSegs);
      pos += 27 + numSegs;

      const packets: Uint8Array[] = [];
      let pktBuf: number[] = [];
      for (let s = 0; s < numSegs; s++) {
        const segLen = segTable[s];
        pktBuf.push(...Array.from(data.subarray(pos, pos + segLen)));
        pos += segLen;
        if (segLen < 255) {
          packets.push(new Uint8Array(pktBuf));
          pktBuf = [];
        }
      }
      if (pktBuf.length) packets.push(new Uint8Array(pktBuf));
      pages.push({ serial, granule, seqNo, flags, packets });
    }

    return pages;
  }

  /** Decode an Ogg/Vorbis or Ogg/Opus file to stub PCM */
  decode(data: Uint8Array): DecodeResult {
    const pages = this.decodeContainer(data);
    if (!pages.length) return { samples: new Float32Array(0), sampleRate: 44100, channels: 2, durationSec: 0 };

    // Detect Vorbis vs Opus from BOS packet
    const bos = pages.find(p => p.flags & 0x02);
    let sampleRate = 44100, channels = 2;
    if (bos?.packets[0]) {
      const id = bos.packets[0];
      if (id[0] === 1 && id[1] === 'v'.charCodeAt(0)) {
        // Vorbis ID header
        channels   = id[11] ?? 2;
        sampleRate = (id[12] | (id[13] << 8) | (id[14] << 16) | (id[15] << 24)) >>> 0;
      } else if (id.length >= 8 && new TextDecoder().decode(id.subarray(0,8)) === 'OpusHead') {
        channels   = id[9] ?? 2;
        sampleRate = 48000;
      }
    }

    // Stub: return silent PCM
    const totalPages = pages.filter(p => !(p.flags & 0x02) && !(p.flags & 0x01)).length;
    const totalSamples = totalPages * 512 * channels;
    return {
      samples: new Float32Array(totalSamples),
      sampleRate,
      channels,
      durationSec: totalSamples / (sampleRate * channels),
    };
  }
}

// ── PCM WAV parser ────────────────────────────────────────────────────────────

function parseWAV(data: Uint8Array): DecodeResult {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0) !== 0x52494646) return { samples: new Float32Array(0), sampleRate: 44100, channels: 2, durationSec: 0 };
  const channels   = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);

  // Find 'data' chunk
  let pos = 36;
  while (pos + 8 < data.length) {
    const id   = dv.getUint32(pos);
    const size = dv.getUint32(pos+4, true);
    if (id === 0x64617461) { // 'data'
      pos += 8;
      const numFrames = Math.floor(size / (channels * (bitsPerSample / 8)));
      const samples = new Float32Array(numFrames * channels);
      for (let i = 0; i < samples.length; i++) {
        if (bitsPerSample === 16) {
          samples[i] = dv.getInt16(pos + i*2, true) / 32768;
        } else if (bitsPerSample === 8) {
          samples[i] = (data[pos+i] - 128) / 128;
        } else {
          samples[i] = dv.getFloat32(pos + i*4, true);
        }
      }
      return { samples, sampleRate, channels, durationSec: numFrames / sampleRate };
    }
    pos += 8 + size;
  }
  return { samples: new Float32Array(0), sampleRate: 44100, channels: 2, durationSec: 0 };
}

// ── AudioPlaybackEngine ───────────────────────────────────────────────────────

export class AudioPlaybackEngine {
  private _playing = false;
  private _paused  = false;
  private _positionSamples = 0;
  private _current: DecodeResult | null = null;
  private _chunkSize = 4096;
  private _timer: ReturnType<typeof setInterval> | null = null;
  onPositionUpdate: ((posSec: number) => void) | null = null;
  onTrackEnd: (() => void) | null = null;

  play(result: DecodeResult): void {
    this.stop();
    this._current = result;
    this._positionSamples = 0;
    this._playing = true;
    this._paused  = false;
    this._schedule();
  }

  pause(): void  { this._paused = !this._paused; }
  resume(): void { this._paused = false; }
  stop(): void {
    this._playing = false;
    if (this._timer !== null) { clearInterval(this._timer as unknown as number); this._timer = null; }
    this._current = null;
    this._positionSamples = 0;
  }

  seek(timeSec: number): void {
    if (!this._current) return;
    this._positionSamples = Math.round(timeSec * this._current.sampleRate * this._current.channels);
  }

  get playing(): boolean { return this._playing && !this._paused; }
  get positionSec(): number {
    if (!this._current) return 0;
    return this._positionSamples / (this._current.sampleRate * this._current.channels);
  }

  private _schedule(): void {
    const chunkIntervalMs = (this._chunkSize / ((this._current?.sampleRate ?? 44100) * (this._current?.channels ?? 2))) * 1000;
    this._timer = setInterval(() => this._tick(), Math.max(1, chunkIntervalMs)) as unknown as ReturnType<typeof setInterval>;
  }

  private _tick(): void {
    if (!this._playing || this._paused || !this._current) return;
    const { samples, sampleRate, channels } = this._current;
    if (this._positionSamples >= samples.length) {
      this.stop();
      this.onTrackEnd?.();
      return;
    }
    const chunk = samples.subarray(this._positionSamples, this._positionSamples + this._chunkSize);
    this._positionSamples += chunk.length;
    if (typeof __audioOutput === 'function') {
      __audioOutput(chunk, sampleRate, channels);
    }
    this.onPositionUpdate?.(this.positionSec);
  }

  setChunkSize(n: number): void { this._chunkSize = n; }
}

// ── PlaylistManager ───────────────────────────────────────────────────────────

export class PlaylistManager {
  private _tracks: AudioTrack[] = [];
  private _current = 0;
  shuffle = false;
  repeatMode: 'none' | 'one' | 'all' = 'none';

  addTrack(track: AudioTrack): void { this._tracks.push(track); }
  removeTrack(id: string): void { this._tracks = this._tracks.filter(t => t.id !== id); }
  clearAll(): void { this._tracks = []; this._current = 0; }

  get tracks(): AudioTrack[] { return this._tracks; }
  get currentTrack(): AudioTrack | null { return this._tracks[this._current] ?? null; }
  get currentIndex(): number { return this._current; }

  next(): AudioTrack | null {
    if (!this._tracks.length) return null;
    if (this.shuffle) {
      this._current = Math.floor(Math.random() * this._tracks.length);
    } else if (this._current + 1 < this._tracks.length) {
      this._current++;
    } else if (this.repeatMode === 'all') {
      this._current = 0;
    } else {
      return null;
    }
    return this._tracks[this._current];
  }

  prev(): AudioTrack | null {
    if (!this._tracks.length) return null;
    if (this._current > 0) this._current--;
    else if (this.repeatMode === 'all') this._current = this._tracks.length - 1;
    return this._tracks[this._current];
  }

  jumpTo(index: number): AudioTrack | null {
    if (index < 0 || index >= this._tracks.length) return null;
    this._current = index;
    return this._tracks[this._current];
  }
}

// ── MusicPlayerApp ────────────────────────────────────────────────────────────

export class MusicPlayerApp {
  private _mp3     = new MP3Decoder();
  private _ogg     = new OGGDecoder();
  private _engine  = new AudioPlaybackEngine();
  private _playlist = new PlaylistManager();

  constructor() {
    this._engine.onTrackEnd = () => { this._autoAdvance(); };
  }

  get playlist(): PlaylistManager { return this._playlist; }
  get engine(): AudioPlaybackEngine { return this._engine; }

  /** Import a track from raw bytes, detecting format automatically */
  importTrack(data: Uint8Array, filename?: string): AudioTrack {
    const format = this._detectFormat(data, filename);
    let meta: Partial<AudioTrack> = {};
    if (format === 'mp3') meta = this._mp3.parseMetadata(data);
    const track: AudioTrack = {
      id: `track-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      title: meta.title ?? filename ?? 'Unknown',
      artist: meta.artist,
      album: meta.album,
      format,
      data,
    };
    this._playlist.addTrack(track);
    return track;
  }

  /** Play a specific track */
  play(track?: AudioTrack): void {
    const t = track ?? this._playlist.currentTrack;
    if (!t) return;
    const result = this._decode(t);
    this._engine.play(result);
  }

  pause():  void { this._engine.pause(); }
  stop():   void { this._engine.stop(); }
  next():   void { const t = this._playlist.next(); if (t) this.play(t); }
  prev():   void { const t = this._playlist.prev(); if (t) this.play(t); }
  seek(s: number): void { this._engine.seek(s); }

  private _decode(track: AudioTrack): DecodeResult {
    switch (track.format) {
      case 'mp3': return this._mp3.decode(track.data);
      case 'ogg': return this._ogg.decode(track.data);
      case 'wav': return parseWAV(track.data);
      default:    return { samples: new Float32Array(0), sampleRate: 44100, channels: 2, durationSec: 0 };
    }
  }

  private _detectFormat(data: Uint8Array, filename?: string): AudioTrack['format'] {
    if (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0) return 'mp3';
    if (data[0] === 73 && data[1] === 68 && data[2] === 51) return 'mp3'; // ID3
    if (data[0] === 79 && data[1] === 103 && data[2] === 103 && data[3] === 83) return 'ogg'; // OggS
    if (data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70) return 'wav'; // RIFF
    if (data[0] === 102 && data[1] === 76 && data[2] === 97 && data[3] === 67) return 'flac'; // fLaC
    if (filename?.endsWith('.mp3')) return 'mp3';
    if (filename?.endsWith('.ogg') || filename?.endsWith('.oga') || filename?.endsWith('.opus')) return 'ogg';
    if (filename?.endsWith('.wav')) return 'wav';
    if (filename?.endsWith('.flac')) return 'flac';
    return 'unknown';
  }

  private _autoAdvance(): void {
    const { repeatMode } = this._playlist;
    if (repeatMode === 'one') { this.play(); return; }
    const next = this._playlist.next();
    if (next) this.play(next);
  }
}

export const musicPlayer = new MusicPlayerApp();
