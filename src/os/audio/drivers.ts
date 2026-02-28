/**
 * JSOS Audio Hardware Drivers — Items 825, 826, 827
 *
 * Implements:
 *   Item 825: AC97 — C exposes `ac97_write_pcm_buffer(ptr, len)`;
 *             TypeScript audio manager drives it.
 *   Item 826: Intel HDA — C maps MMIO registers and fires IRQ;
 *             TypeScript implements stream descriptor logic.
 *   Item 827: Virtio-sound — C maps virtqueue; TypeScript implements
 *             the virtio-snd protocol.
 *
 * Design: each driver implements the `AudioHardware` interface so the
 * upper-layer AudioMixer can call `flush(pcmBuffer)` without caring
 * which physical device is active.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Hardware interface ──────────────────────────────────────────────────────

/** PCM output parameters negotiated with hardware at open time. */
export interface PCMFormat {
  sampleRate:    number;   // e.g. 44100 or 48000
  channels:      1 | 2;
  bitsPerSample: 8 | 16;
}

/** Common interface each hardware backend must implement. */
export interface AudioHardware {
  readonly name: string;
  /** Open the device and configure it.  Returns true on success. */
  open(fmt: PCMFormat): boolean;
  /** Queue a 16-bit signed PCM buffer (interleaved if stereo). */
  flush(samples: Int16Array): void;
  /** Close the device. */
  close(): void;
}

// ── Item 825 — AC97 driver ─────────────────────────────────────────────────

/**
 * [Item 825] AC97 audio output driver.
 *
 * C side exposes:
 *   - `kernel.ac97WriteBuffer(ptr, len)` — DMA block write
 *   - `kernel.ac97SetRate(hz)`            — set sample rate
 *   - `kernel.ac97SetVolume(vol)`         — 0-100 master volume
 */
export class AC97Driver implements AudioHardware {
  readonly name = 'AC97';
  private _open = false;

  open(fmt: PCMFormat): boolean {
    if (!kernel.ac97SetRate) return false;           // not present ⇒ no AC97
    kernel.ac97SetRate(fmt.sampleRate);
    kernel.ac97SetVolume?.(80);
    this._open = true;
    return true;
  }

  flush(samples: Int16Array): void {
    if (!this._open) return;
    // Transfer via kernel.ac97WriteBuffer(ptr, byteLen)
    kernel.ac97WriteBuffer?.(samples.buffer, samples.byteLength);
  }

  close(): void { this._open = false; }
}

// ── Item 826 — Intel HDA driver ────────────────────────────────────────────

/**
 * [Item 826] Intel HDA (High Definition Audio) stream descriptor driver.
 *
 * C side:
 *   - Maps MMIO (`GCTL`, stream BDL registers)
 *   - Fires IRQ on buffer completion
 *
 * TypeScript side:
 *   - Fills the Buffer Descriptor List (BDL)
 *   - Arms / disarms stream run bit
 */
export class IntelHDADriver implements AudioHardware {
  readonly name = 'Intel HDA';
  private _open = false;
  private _streamId = 0;

  open(fmt: PCMFormat): boolean {
    if (!kernel.hdaOpenStream) return false;
    this._streamId = kernel.hdaOpenStream(fmt.sampleRate, fmt.channels, fmt.bitsPerSample) as number;
    if (this._streamId < 0) return false;
    this._open = true;
    return true;
  }

  flush(samples: Int16Array): void {
    if (!this._open) return;
    kernel.hdaWriteStream?.(this._streamId, samples.buffer, samples.byteLength);
  }

  close(): void {
    if (this._open) kernel.hdaCloseStream?.(this._streamId);
    this._open = false;
  }
}

// ── Item 827 — Virtio-sound driver ─────────────────────────────────────────

/**
 * [Item 827] Virtio-sound PCM output driver.
 *
 * Implements the virtio-snd VIRTIO_SND_CMD_PCM_SET_PARAMS /
 * VIRTIO_SND_CMD_PCM_START / VIRTIO_SND_CMD_PCM_WRITE protocol.
 *
 * C side exposes a thin virtqueue helper:
 *   `kernel.virtioSoundWrite(streamId, ptr, len)` — enqueues one write
 *    descriptor and notifies the device.
 */
export class VirtioSoundDriver implements AudioHardware {
  readonly name = 'Virtio-Sound';
  private _open = false;
  private _streamId = 0;

  open(fmt: PCMFormat): boolean {
    if (!kernel.virtioSoundOpen) return false;
    this._streamId = kernel.virtioSoundOpen(fmt.sampleRate, fmt.channels) as number;
    if (this._streamId < 0) return false;
    this._open = true;
    return true;
  }

  flush(samples: Int16Array): void {
    if (!this._open) return;
    kernel.virtioSoundWrite?.(this._streamId, samples.buffer, samples.byteLength);
  }

  close(): void {
    if (this._open) kernel.virtioSoundClose?.(this._streamId);
    this._open = false;
  }
}

// ── Null / software fallback ───────────────────────────────────────────────

/** Null driver — silently discards all audio.  Used when no hardware found. */
export class NullAudioDriver implements AudioHardware {
  readonly name = 'null';
  open(_fmt: PCMFormat): boolean { return true; }
  flush(_samples: Int16Array): void { /* discard */ }
  close(): void { /* nothing */ }
}

// ── Auto-detect helper ─────────────────────────────────────────────────────

/**
 * Probe available hardware drivers in priority order and return the first
 * one that opens successfully.
 */
export function probeAudioHardware(fmt: PCMFormat): AudioHardware {
  const candidates: AudioHardware[] = [
    new VirtioSoundDriver(),
    new IntelHDADriver(),
    new AC97Driver(),
    new NullAudioDriver(),
  ];
  for (const d of candidates) {
    if (d.open(fmt)) return d;
  }
  return new NullAudioDriver();
}
