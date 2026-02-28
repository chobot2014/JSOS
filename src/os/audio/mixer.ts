/**
 * JSOS Audio Mixer — Item 834
 *
 * TypeScript software audio mixer:
 *   - N audio source tracks (AudioSource)
 *   - Per-source volume, pan, and playback state
 *   - Global master volume
 *   - EQ chain (low-shelf, high-shelf, peak filter)
 *   - Ring-buffer mixing into PCM output frame
 *
 * Call `AudioMixer.tick()` at the hardware IRQ or timer interval to get
 * the next PCM buffer; pass it to AudioHardware.flush().
 */

import type { AudioHardware } from './drivers.js';

// ── EQ filter ──────────────────────────────────────────────────────────────

/** 2nd-order IIR biquad filter (direct form II transpose). */
export class BiquadFilter {
  private _b0 = 1; private _b1 = 0; private _b2 = 0;
  private _a1 = 0; private _a2 = 0;
  private _z1 = 0; private _z2 = 0;

  /** Configure as low-shelf filter. */
  lowShelf(sampleRate: number, freq: number, gain_dB: number): this {
    const A  = Math.pow(10, gain_dB / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const S  = 1;
    const alpha = sin / 2 * Math.sqrt((A + 1/A) * (1/S - 1) + 2);
    const a0 = (A+1) + (A-1)*cos + 2*Math.sqrt(A)*alpha;
    this._b0 = (A * ((A+1) - (A-1)*cos + 2*Math.sqrt(A)*alpha)) / a0;
    this._b1 = (2*A * ((A-1) - (A+1)*cos))                        / a0;
    this._b2 = (A * ((A+1) - (A-1)*cos - 2*Math.sqrt(A)*alpha))  / a0;
    this._a1 = (-2*  ((A-1) + (A+1)*cos))                        / a0;
    this._a2 = ((A+1) + (A-1)*cos - 2*Math.sqrt(A)*alpha)        / a0;
    return this;
  }

  /** Configure as high-shelf filter. */
  highShelf(sampleRate: number, freq: number, gain_dB: number): this {
    const A  = Math.pow(10, gain_dB / 40);
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const S  = 1;
    const alpha = sin / 2 * Math.sqrt((A + 1/A) * (1/S - 1) + 2);
    const a0 = (A+1) - (A-1)*cos + 2*Math.sqrt(A)*alpha;
    this._b0 = (A*((A+1) + (A-1)*cos + 2*Math.sqrt(A)*alpha))  / a0;
    this._b1 = (-2*A*((A-1) + (A+1)*cos))                      / a0;
    this._b2 = (A*((A+1) + (A-1)*cos - 2*Math.sqrt(A)*alpha))  / a0;
    this._a1 = (2*  ((A-1) - (A+1)*cos))                       / a0;
    this._a2 = ((A+1) - (A-1)*cos - 2*Math.sqrt(A)*alpha)      / a0;
    return this;
  }

  /** Configure as peak/notch EQ filter. */
  peak(sampleRate: number, freq: number, gain_dB: number, Q = 1): this {
    const A     = Math.pow(10, gain_dB / 40);
    const w0    = 2 * Math.PI * freq / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha / A;
    this._b0 = (1 + alpha * A) / a0;
    this._b1 = (-2 * Math.cos(w0)) / a0;
    this._b2 = (1 - alpha * A) / a0;
    this._a1 = (-2 * Math.cos(w0)) / a0;
    this._a2 = (1 - alpha / A) / a0;
    return this;
  }

  process(x: number): number {
    const y = this._b0 * x + this._z1;
    this._z1 = this._b1 * x - this._a1 * y + this._z2;
    this._z2 = this._b2 * x - this._a2 * y;
    return y;
  }

  reset(): void { this._z1 = 0; this._z2 = 0; }
}

// ── AudioSource ────────────────────────────────────────────────────────────

export type PlaybackState = 'playing' | 'paused' | 'stopped';

/**
 * [Item 834] An audio source — feeds PCM samples into the mixer.
 */
export class AudioSource {
  id:      string;
  volume:  number = 1.0;   // 0..1
  pan:     number = 0;     // -1..1 (left..right)
  loop:    boolean = false;
  state:   PlaybackState = 'stopped';

  private _data:    Int16Array;
  private _cursor:  number = 0;
  readonly channels:   number;
  readonly sampleRate: number;

  constructor(id: string, data: Int16Array, channels: number, sampleRate: number) {
    this.id = id;
    this._data    = data;
    this.channels = channels;
    this.sampleRate = sampleRate;
  }

  play():  void { this.state = 'playing'; }
  pause(): void { this.state = 'paused'; }
  stop():  void { this.state = 'stopped'; this._cursor = 0; }

  seek(sampleOffset: number): void {
    this._cursor = Math.max(0, Math.min(this._data.length, sampleOffset * this.channels));
  }

  get position(): number { return this._cursor / this.channels; }
  get duration():  number { return this._data.length / this.channels; }

  /**
   * Read `count` stereo frames into `outL`/`outR` (floating point -1..1).
   * Applies volume and pan. Returns number of frames actually read.
   */
  readFrames(outL: Float32Array, outR: Float32Array, count: number): number {
    if (this.state !== 'playing') return 0;
    const panL = this.volume * Math.min(1, 1 - this.pan);
    const panR = this.volume * Math.min(1, 1 + this.pan);
    let written = 0;
    while (written < count) {
      if (this._cursor >= this._data.length) {
        if (this.loop) this._cursor = 0;
        else { this.state = 'stopped'; break; }
      }
      const mono = this.channels === 1;
      const rawL = (this._data[this._cursor] ?? 0) / 32768;
      const rawR = mono ? rawL : ((this._data[this._cursor + 1] ?? 0) / 32768);
      this._cursor += this.channels;
      outL[written] += rawL * panL;
      outR[written] += rawR * panR;
      written++;
    }
    return written;
  }
}

// ── Mixer ──────────────────────────────────────────────────────────────────

export const MIXER_FRAME_SIZE = 1024;   // samples per tick

/**
 * [Item 834] Software audio mixer.
 *
 * Mixes N AudioSources, applies master volume and 3-band EQ, and calls
 * AudioHardware.flush() with the resulting Int16Array.
 */
export class AudioMixer {
  masterVolume = 0.8;
  private _sources: Map<string, AudioSource> = new Map();
  private _hw:      AudioHardware;
  private _eq:      [BiquadFilter, BiquadFilter, BiquadFilter] = [
    new BiquadFilter(),
    new BiquadFilter(),
    new BiquadFilter(),
  ];
  private _sampleRate: number;

  constructor(hw: AudioHardware, sampleRate = 44100) {
    this._hw = hw;
    this._sampleRate = sampleRate;
    // Default EQ: bass boost +3dB, slight treble boost +2dB
    this._eq[0].lowShelf( sampleRate,   80, 3);
    this._eq[1].peak(     sampleRate, 3000, 0);
    this._eq[2].highShelf(sampleRate, 8000, 2);
  }

  addSource(src: AudioSource): void { this._sources.set(src.id, src); }
  removeSource(id: string): void    { this._sources.delete(id); }
  getSource(id: string): AudioSource | undefined { return this._sources.get(id); }

  /** Configure bass EQ (low-shelf). */
  setBass(gain_dB: number): void {
    this._eq[0].lowShelf(this._sampleRate, 80, gain_dB);
  }

  /** Configure treble EQ (high-shelf). */
  setTreble(gain_dB: number): void {
    this._eq[2].highShelf(this._sampleRate, 8000, gain_dB);
  }

  /**
   * Produce one audio frame and flush to hardware.
   * Call at ~44100/MIXER_FRAME_SIZE = ~43 Hz.
   */
  tick(): void {
    const n = MIXER_FRAME_SIZE;
    const mixL = new Float32Array(n);
    const mixR = new Float32Array(n);

    for (const src of this._sources.values()) {
      src.readFrames(mixL, mixR, n);
    }

    // Apply EQ and master volume, clamp, write output
    const out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      let l = mixL[i] * this.masterVolume;
      let r = mixR[i] * this.masterVolume;
      l = this._eq[0].process(this._eq[1].process(this._eq[2].process(l)));
      r = this._eq[0].process(this._eq[1].process(this._eq[2].process(r)));
      out[i * 2]     = (Math.max(-1, Math.min(1, l)) * 32767) | 0;
      out[i * 2 + 1] = (Math.max(-1, Math.min(1, r)) * 32767) | 0;
    }
    this._hw.flush(out);
  }
}
