/**
 * JSOS Audio Subsystem — Items 828, 829
 *
 * sys.audio API:
 *   - initAudio()                              — boot-time init (item 828)
 *   - createSource(pcm, opts)                  — wrap PCM data in a playable source
 *   - play / pause / stop / seek / setVolume / setPan
 *   - loadDecoded(format, data) → AudioSource  — item 829 (decode + enqueue)
 *   - scheduled playback via mixer tick timer
 *
 * Called by the browser <audio>/<video> element wiring and CLI apps.
 */

import { probeAudioHardware }         from './drivers.js';
import { AudioMixer, AudioSource, MIXER_FRAME_SIZE } from './mixer.js';
import { decodeMP3 }                  from './mp3.js';
import { decodeOGG }                  from './ogg.js';
import { decodeAAC, decodeFLAC }      from './codecs.js';

export type { AudioSource } from './mixer.js';

// ── Singleton state ────────────────────────────────────────────────────────

let _mixer: AudioMixer | null = null;
let _timerHandle: number = -1;
let _nextId = 1;

/** Audio format hint for loadDecoded(). */
export type AudioFormat = 'mp3' | 'ogg' | 'aac' | 'flac' | 'pcm';

export interface AudioSourceOpts {
  sampleRate?: number;
  channels?:   1 | 2;
  volume?:     number;
  pan?:        number;
  loop?:       boolean;
}

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * [Item 828] Initialise the audio subsystem.
 *
 * Probes hardware, opens the PCM stream, starts the mixer timer.
 * Safe to call multiple times (idempotent).
 */
export function initAudio(sampleRate = 44100): void {
  if (_mixer) return;
  const fmt = { sampleRate, channels: 2 as const, bitsPerSample: 16 as const };
  const hw = probeAudioHardware(fmt);  // probeAudioHardware opens the driver
  _mixer = new AudioMixer(hw, sampleRate);

  // Schedule mixer ticks using the kernel timer (or Date.now() polyfill)
  const tickMs = Math.floor((MIXER_FRAME_SIZE / sampleRate) * 1000);
  _timerHandle = (globalThis as any).kernel?.setInterval
    ? (globalThis as any).kernel.setInterval(() => _mixer!.tick(), tickMs)
    : (setInterval(() => _mixer!.tick(), tickMs) as unknown as number);
}

/** Tear down audio — called on system shutdown. */
export function shutdownAudio(): void {
  if (!_mixer) return;
  (globalThis as any).kernel?.clearInterval
    ? (globalThis as any).kernel.clearInterval(_timerHandle)
    : clearInterval(_timerHandle as unknown as ReturnType<typeof setInterval>);
  _mixer = null;
}

// ── Source management ──────────────────────────────────────────────────────

/** [Item 829] Decode encoded audio data and register it as an AudioSource. */
export function loadDecoded(
  format: AudioFormat,
  data:   Uint8Array,
  opts?:  AudioSourceOpts,
): AudioSource {
  ensureInit();
  let pcm: Int16Array;
  let sampleRate = opts?.sampleRate ?? 44100;
  let channels:   1 | 2 = opts?.channels ?? 2;

  switch (format) {
    case 'mp3': {
      const r = decodeMP3(data);
      pcm = r.samples; sampleRate = r.sampleRate; channels = r.channels as 1|2;
      break;
    }
    case 'ogg': {
      const r = decodeOGG(data);
      pcm = r.samples; sampleRate = r.sampleRate; channels = r.channels as 1|2;
      break;
    }
    case 'aac': {
      const r = decodeAAC(data);
      pcm = r.samples; sampleRate = r.sampleRate; channels = r.channels as 1|2;
      break;
    }
    case 'flac': {
      const r = decodeFLAC(data);
      if (r) {
        const shift = Math.max(0, r.bitsPerSample - 16);
        const i16 = Int16Array.from(r.samples, (s) => (s >> shift));
        pcm = i16; sampleRate = r.sampleRate; channels = r.channels as 1|2;
      }
      break;
    }
    case 'pcm':
    default:
      pcm = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
      break;
  }

  return createSource(pcm, { ...opts, sampleRate, channels });
}

/**
 * Wrap raw PCM data (Int16, interleaved) in an AudioSource and register it.
 */
export function createSource(
  pcm:  Int16Array,
  opts?: AudioSourceOpts,
): AudioSource {
  ensureInit();
  const id  = `src-${_nextId++}`;
  const src = new AudioSource(
    id,
    pcm,
    opts?.channels  ?? 2,
    opts?.sampleRate ?? 44100,
  );
  if (opts?.volume !== undefined) src.volume = opts.volume;
  if (opts?.pan    !== undefined) src.pan    = opts.pan;
  if (opts?.loop   !== undefined) src.loop   = opts.loop;
  _mixer!.addSource(src);
  return src;
}

/** Remove a source from the mixer. */
export function destroySource(src: AudioSource): void {
  _mixer?.removeSource(src.id);
}

// ── Playback controls ──────────────────────────────────────────────────────

export function play(src:  AudioSource): void { src.play(); }
export function pause(src: AudioSource): void { src.pause(); }
export function stop(src:  AudioSource): void { src.stop(); }

export function seek(src: AudioSource, seconds: number): void {
  src.seek(Math.floor(seconds * src.sampleRate));
}

export function setVolume(src: AudioSource, vol: number): void {
  src.volume = Math.max(0, Math.min(1, vol));
}

export function setPan(src: AudioSource, pan: number): void {
  src.pan = Math.max(-1, Math.min(1, pan));
}

// ── Global controls ────────────────────────────────────────────────────────

export function setMasterVolume(vol: number): void {
  ensureInit();
  _mixer!.masterVolume = Math.max(0, Math.min(1, vol));
}

export function setBass(gain_dB: number): void { ensureInit(); _mixer!.setBass(gain_dB); }
export function setTreble(gain_dB: number): void { ensureInit(); _mixer!.setTreble(gain_dB); }

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureInit(): void {
  if (!_mixer) initAudio();
}

// ── Namespaced export (sys.audio) ──────────────────────────────────────────

/**
 * [Items 828, 829] The sys.audio namespace consumed by the OS and applications.
 *
 * Usage:
 *   import { audio } from '@os/audio';
 *   const src = audio.loadDecoded('mp3', data);
 *   audio.play(src);
 */
export const audio = {
  init:            initAudio,
  shutdown:        shutdownAudio,
  loadDecoded,
  createSource,
  destroySource,
  play,
  pause,
  stop,
  seek,
  setVolume,
  setPan,
  setMasterVolume,
  setBass,
  setTreble,
} as const;

export default audio;
