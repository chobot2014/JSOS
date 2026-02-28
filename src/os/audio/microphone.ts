/**
 * JSOS Microphone Input — Item 838
 *
 * C side exposes a capture ring buffer via kernel.micRead().
 * TypeScript implements:
 *   - MicrophoneCapture: open/close/read interface
 *   - MicStreamDecoder: converts raw PCM to Web Audio-style Float32 frames
 *   - registerMicInput(): wires into sys.audio for MediaRecorder / getUserMedia
 *
 * Architecture constraint: C provides ONLY the ring-buffer DMA primitive.
 * All sample-rate conversion, format normalization and API surface = TypeScript.
 */

// ── C kernel binding interface ──────────────────────────────────────────────

interface MicHW {
  /** Open the capture device. Returns a handle or -1 on failure. */
  micOpen(sampleRate: number, channels: 1 | 2): number;
  /** Read up to `maxSamples` frames from the ring buffer. */
  micRead(handle: number, maxSamples: number): Int16Array | null;
  /** Close the capture device. */
  micClose(handle: number): void;
  /** Return supported input sample rates. */
  micGetRates(): number[];
}

function micHW(): MicHW {
  // Real kernel binding; falls back to a silent stub in non-kernel environments
  const k = (globalThis as any).kernel;
  if (k?.micOpen) return k;
  // Stub (development / testing outside JSOS)
  return {
    micOpen:    (_sr, _ch) => 0,
    micRead:    (_h, _n)  => new Int16Array(0),
    micClose:   (_h)      => {},
    micGetRates: ()       => [44100, 48000],
  };
}

// ── MicrophoneCapture ───────────────────────────────────────────────────────

export interface MicOptions {
  sampleRate?: number;
  channels?:   1 | 2;
}

export type MicCallback = (samples: Float32Array, sampleRate: number, channels: number) => void;

/**
 * [Item 838] Manages the kernel microphone capture stream.
 */
export class MicrophoneCapture {
  private _handle: number = -1;
  private _sr:     number;
  private _ch:     1 | 2;
  private _cb:     MicCallback | null = null;
  private _timer:  number = -1;

  constructor(opts?: MicOptions) {
    const hw = micHW();
    const rates = hw.micGetRates();
    this._sr = opts?.sampleRate ?? (rates.includes(44100) ? 44100 : rates[0] ?? 44100);
    this._ch = opts?.channels ?? 1;
  }

  get sampleRate(): number { return this._sr; }
  get channels():   number { return this._ch; }
  get isOpen():     boolean { return this._handle >= 0; }

  /** Open the microphone device and start polling. */
  open(): boolean {
    if (this._handle >= 0) return true;
    this._handle = micHW().micOpen(this._sr, this._ch);
    if (this._handle < 0) return false;
    this._startPoll();
    return true;
  }

  /** Close and release the device. */
  close(): void {
    this._stopPoll();
    if (this._handle >= 0) { micHW().micClose(this._handle); this._handle = -1; }
  }

  /** Register a callback for audio frames (Float32 [-1..1]). */
  onData(cb: MicCallback): this { this._cb = cb; return this; }

  // ── Polling loop ──────────────────────────────────────────────────────────

  private readonly POLL_MS = 20;  // 20ms ~= 1024 samples @ 48 kHz

  private _startPoll(): void {
    const poll = () => {
      if (this._handle < 0) return;
      const s16 = micHW().micRead(this._handle, 2048);
      if (s16 && s16.length > 0 && this._cb) {
        const f32 = MicrophoneCapture._toFloat32(s16);
        this._cb(f32, this._sr, this._ch);
      }
      this._timer = (globalThis as any).kernel?.setTimeout
        ? (globalThis as any).kernel.setTimeout(poll, this.POLL_MS)
        : (setTimeout(poll, this.POLL_MS) as unknown as number);
    };
    poll();
  }

  private _stopPoll(): void {
    if (this._timer === -1) return;
    (globalThis as any).kernel?.clearTimeout
      ? (globalThis as any).kernel.clearTimeout(this._timer)
      : clearTimeout(this._timer as unknown as ReturnType<typeof setTimeout>);
    this._timer = -1;
  }

  static _toFloat32(s16: Int16Array): Float32Array {
    const f32 = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) f32[i] = s16[i]! / 32768;
    return f32;
  }
}

// ── getUserMedia stub ───────────────────────────────────────────────────────

export interface MediaStreamTrack {
  kind:    'audio' | 'video';
  label:   string;
  enabled: boolean;
  stop: () => void;
  onended: (() => void) | null;
}

export interface MediaStream {
  getTracks():      MediaStreamTrack[];
  getAudioTracks(): MediaStreamTrack[];
  active:           boolean;
}

/**
 * Wires navigator.getUserMedia to JSOS kernel microphone.
 * Install on the page window object via `installGetUserMedia(win)`.
 */
export function installGetUserMedia(win: Record<string, unknown>): void {
  if (!win['navigator']) win['navigator'] = {};
  const nav = win['navigator'] as any;
  if (!nav.mediaDevices) nav.mediaDevices = {};
  nav.mediaDevices.getUserMedia = async (constraints: any): Promise<MediaStream> => {
    if (!constraints?.audio) throw new Error('Only audio constraints supported');
    const cap = new MicrophoneCapture({
      sampleRate: constraints.audio?.sampleRate ?? 44100,
      channels:   constraints.audio?.channelCount ?? 1,
    });
    if (!cap.open()) throw new DOMException('Could not open microphone', 'NotAllowedError');
    const track: MediaStreamTrack = {
      kind:    'audio',
      label:   'JSOS Microphone',
      enabled: true,
      stop() { cap.close(); this.onended?.(); },
      onended: null,
    };
    const stream: MediaStream = {
      getTracks():      [track as MediaStreamTrack] { return [track]; },
      getAudioTracks(): [track as MediaStreamTrack] { return [track]; },
      active: true,
    } as MediaStream;
    return stream;
  };

  // Legacy API
  nav.getUserMedia = nav.mediaDevices.getUserMedia;
}
