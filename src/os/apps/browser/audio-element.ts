/**
 * JSOS Browser — HTMLMediaElement wiring to sys.audio
 *
 * [Item 835] HTMLAudioElement: loads encoded audio, decodes via sys.audio,
 *            exposes play/pause/stop, currentTime, duration, volume, loop.
 * [Item 836] HTMLVideoElement: extends HTMLAudioElement with video-track
 *            synchronisation (frame scheduler tick = audio cursor position).
 *
 * These classes are registered on the browser window object (window.Audio,
 * window.HTMLAudioElement, window.HTMLVideoElement) by installMediaElements().
 */

import audio, { type AudioFormat, type AudioSource } from '../../audio/index.js';

// ── Format detection ────────────────────────────────────────────────────────

function sniffFormat(src: string, type?: string): AudioFormat {
  if (type) {
    if (type.includes('mp3') || type.includes('mpeg')) return 'mp3';
    if (type.includes('ogg'))                         return 'ogg';
    if (type.includes('aac') || type.includes('mp4')) return 'aac';
    if (type.includes('flac'))                        return 'flac';
    return 'pcm';
  }
  const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp3': case 'mpeg': return 'mp3';
    case 'ogg': case 'oga': return 'ogg';
    case 'aac': case 'm4a': return 'aac';
    case 'flac':            return 'flac';
    default:                return 'pcm';
  }
}

// ── EventTarget stub ────────────────────────────────────────────────────────

type EventCallback = (evt: Record<string, unknown>) => void;

class MediaEventTarget {
  private _listeners: Map<string, EventCallback[]> = new Map();

  addEventListener(type: string, cb: EventCallback): void {
    const arr = this._listeners.get(type) ?? [];
    arr.push(cb);
    this._listeners.set(type, arr);
  }
  removeEventListener(type: string, cb: EventCallback): void {
    const arr = this._listeners.get(type) ?? [];
    this._listeners.set(type, arr.filter(fn => fn !== cb));
  }
  dispatchEvent(type: string, detail: Record<string, unknown> = {}): void {
    const evt = { type, target: this, ...detail };
    // Call IDL event handler (on${type} property) first
    const idlFn = (this as any)['on' + type];
    if (typeof idlFn === 'function') { try { idlFn(evt); } catch (_) {} }
    for (const cb of this._listeners.get(type) ?? []) cb(evt);
  }
}

// ── [Item 835] HTMLAudioElement ─────────────────────────────────────────────

export class JSAudioElement extends MediaEventTarget {
  // public IDL attributes
  src:     string  = '';
  loop:    boolean = false;
  autoplay: boolean = false;
  preload: string  = 'auto';
  controls: boolean = false;
  crossOrigin: string | null = null;
  defaultMuted: boolean = false;
  defaultPlaybackRate: number = 1.0;
  // Error state
  error: null = null;
  // Network state constants (matches HTMLMediaElement spec)
  static readonly NETWORK_EMPTY      = 0;
  static readonly NETWORK_IDLE       = 1;
  static readonly NETWORK_LOADING    = 2;
  static readonly NETWORK_NO_SOURCE  = 3;
  // ReadyState constants
  static readonly HAVE_NOTHING       = 0;
  static readonly HAVE_METADATA      = 1;
  static readonly HAVE_CURRENT_DATA  = 2;
  static readonly HAVE_FUTURE_DATA   = 3;
  static readonly HAVE_ENOUGH_DATA   = 4;
  // IDL event handler properties
  onplay:           ((e: unknown) => void) | null = null;
  onpause:          ((e: unknown) => void) | null = null;
  onended:          ((e: unknown) => void) | null = null;
  ontimeupdate:     ((e: unknown) => void) | null = null;
  onloadedmetadata: ((e: unknown) => void) | null = null;
  onloadeddata:     ((e: unknown) => void) | null = null;
  oncanplay:        ((e: unknown) => void) | null = null;
  oncanplaythrough: ((e: unknown) => void) | null = null;
  onerror:          ((e: unknown) => void) | null = null;
  onwaiting:        ((e: unknown) => void) | null = null;
  onstalled:        ((e: unknown) => void) | null = null;
  onsuspend:        ((e: unknown) => void) | null = null;
  onabort:          ((e: unknown) => void) | null = null;
  onemptied:        ((e: unknown) => void) | null = null;
  ondurationchange: ((e: unknown) => void) | null = null;
  onprogress:       ((e: unknown) => void) | null = null;
  onseeked:         ((e: unknown) => void) | null = null;
  onseeking:        ((e: unknown) => void) | null = null;
  onvolumechange:   ((e: unknown) => void) | null = null;
  onratechange:     ((e: unknown) => void) | null = null;

  private _volume:      number = 1.0;
  private _playbackRate: number = 1.0;
  private _muted:       boolean = false;
  private _networkState: number = 0;  // NETWORK_EMPTY initially
  private _source:      AudioSource | null = null;
  private _ready:       boolean = false;
  private _dataCache:   Uint8Array | null = null;

  constructor(src?: string) {
    super();
    if (src) { this.src = src; this._load(src); }
  }

  // ── IDL properties ──────────────────────────────────────────────────────

  get volume(): number { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._source) audio.setVolume(this._source, this._muted ? 0 : this._volume);
  }

  get muted(): boolean { return this._muted; }
  set muted(v: boolean) {
    this._muted = v;
    if (this._source) audio.setVolume(this._source, v ? 0 : this._volume);
  }

  get playbackRate(): number { return this._playbackRate; }
  set playbackRate(v: number) { this._playbackRate = v; /* TODO: resample on tick */ }

  get currentTime(): number {
    return this._source ? this._source.position / this._source.sampleRate : 0;
  }
  set currentTime(v: number) { if (this._source) audio.seek(this._source, v); }

  get duration(): number {
    return this._source ? this._source.duration / this._source.sampleRate : NaN;
  }

  get paused():  boolean { return this._source?.state === 'paused'; }
  get ended():   boolean { return this._source?.state === 'stopped'; }
  get readyState(): number { return this._ready ? 4 : 0; }
  get networkState(): number { return this._networkState; }

  get buffered(): any {
    const dur = this._source ? (this._source.duration / (this._source.sampleRate || 44100)) : NaN;
    return isFinite(dur) && dur > 0
      ? { length: 1, start(_i: number) { return 0; }, end(_i: number) { return dur; } }
      : { length: 0, start(_i: number) { return 0; }, end(_i: number) { return 0; } };
  }
  get seekable(): any { return this.buffered; }
  get played(): any { return this.buffered; }  // HAVE_ENOUGH_DATA = 4

  // ── Loading ─────────────────────────────────────────────────────────────

  load(): void { if (this.src) this._load(this.src); }

  private _load(url: string): void {
    this._ready = false;
    this.dispatchEvent('emptied');
    // Fetch via kernel HTTP — falls back to empty buffer in stub environments
    const fetchFn: ((u: string) => Promise<Uint8Array>) | undefined =
      (globalThis as any).kernel?.fetchBytes ??
      ((globalThis as any).fetch
        ? (u: string) => (globalThis as any).fetch(u).then((r: any) => r.arrayBuffer()).then((ab: ArrayBuffer) => new Uint8Array(ab))
        : undefined);

    if (!fetchFn) {
      // No network available — create a silent source so API calls don't throw
      this._source = audio.createSource(new Int16Array(0));
      this._ready  = true;
      this._networkState = 1;  // NETWORK_IDLE
      this.dispatchEvent('canplaythrough');
      return;
    }

    this._networkState = 2;  // NETWORK_LOADING
    this.dispatchEvent('loadstart');
    fetchFn(url).then(data => {
      this._dataCache = data;
      const fmt = sniffFormat(url);
      if (this._source) { audio.destroySource(this._source); }
      this._source = audio.loadDecoded(fmt, data, { volume: this._volume, loop: this.loop });
      this._ready  = true;
      this._networkState = 1;  // NETWORK_IDLE
      this.dispatchEvent('loadedmetadata');
      this.dispatchEvent('loadeddata');
      this.dispatchEvent('canplaythrough');
      if (this.autoplay) this.play().catch(() => {/**/});
    }).catch((err: unknown) => {
      this._networkState = 3;  // NETWORK_NO_SOURCE
      this.dispatchEvent('error', { message: String(err) });
    });
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  play(): Promise<void> {
    if (!this._ready || !this._source) {
      return new Promise(resolve => this.addEventListener('canplaythrough', () => { this._doPlay(); resolve(undefined); }));
    }
    this._doPlay();
    return Promise.resolve();
  }

  pause(): void {
    if (this._source) { audio.pause(this._source); this.dispatchEvent('pause'); }
  }

  private _doPlay(): void {
    if (!this._source) return;
    this._source.loop = this.loop;
    audio.setVolume(this._source, this._muted ? 0 : this._volume);
    audio.play(this._source);
    this.dispatchEvent('play');
    this.dispatchEvent('playing');
  }

  /** Clamp [0,1] as per spec */
  cloneNode(): JSAudioElement { return new JSAudioElement(this.src); }

  canPlayType(type: string): string {
    const t = type.toLowerCase();
    if (t.includes('mp3') || t.includes('mpeg')) return 'probably';
    if (t.includes('ogg'))                       return 'probably';
    if (t.includes('aac') || t.includes('mp4')) return 'maybe';
    if (t.includes('flac'))                      return 'maybe';
    return '';
  }
}

// ── [Item 836] HTMLVideoElement — audio-track sync ──────────────────────────

export class JSVideoElement extends JSAudioElement {
  /** Dimensions (layout uses these) */
  width  = 0;
  height = 0;
  poster = '';

  private _frameRate   = 30;
  private _totalFrames = 0;
  private _frameTimer: number = -1;
  onframe?: (frameIndex: number) => void;

  constructor(src?: string) { super(src); }

  /**
   * Attach video frame data and synchronise playback.
   * The caller renders frames via `onframe(frameIndex)`.
   */
  attachVideoTrack(totalFrames: number, frameRate = 30): void {
    this._totalFrames = totalFrames;
    this._frameRate   = frameRate;
  }

  override play(): Promise<void> {
    const p = super.play();
    this._startFrameSync();
    return p;
  }

  override pause(): void {
    super.pause();
    this._stopFrameSync();
  }

  private _startFrameSync(): void {
    if (this._frameTimer !== -1) return;
    const msPerFrame = 1000 / this._frameRate;
    const tick = () => {
      const frameIndex = Math.floor(this.currentTime * this._frameRate);
      if (frameIndex < this._totalFrames) {
        this.onframe?.(frameIndex);
        this.dispatchEvent('timeupdate', { currentTime: this.currentTime });
        this._frameTimer = (globalThis as any).kernel?.setTimeout
          ? (globalThis as any).kernel.setTimeout(tick, msPerFrame)
          : (setTimeout(tick, msPerFrame) as unknown as number);
      } else {
        this._stopFrameSync();
        this.dispatchEvent('ended');
      }
    };
    tick();
  }

  private _stopFrameSync(): void {
    if (this._frameTimer === -1) return;
    (globalThis as any).kernel?.clearTimeout
      ? (globalThis as any).kernel.clearTimeout(this._frameTimer)
      : clearTimeout(this._frameTimer as unknown as ReturnType<typeof setTimeout>);
    this._frameTimer = -1;
  }

  canPlayType(type: string): string {
    const t = type.toLowerCase();
    if (t.includes('mp4') || t.includes('avc') || t.includes('aac')) return 'maybe';
    if (t.includes('webm') || t.includes('vp8') || t.includes('vp9')) return 'maybe';
    if (t.includes('ogg') || t.includes('theora'))                    return 'maybe';
    return super.canPlayType(type);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Install HTMLAudioElement / HTMLVideoElement on the page's window object.
 * Called from the browser's window-setup routine.
 */
export function installMediaElements(win: Record<string, unknown>): void {
  audio.init();                          // ensure audio subsystem is up

  win['Audio']              = JSAudioElement;
  win['HTMLAudioElement']   = JSAudioElement;
  win['HTMLVideoElement']   = JSVideoElement;

  // createElement('audio') / ('video') support
  const origCreate = (win['document'] as any)?.createElement?.bind(win['document']);
  if (origCreate) {
    (win['document'] as any).createElement = (tag: string, opts?: any) => {
      switch (tag.toLowerCase()) {
        case 'audio': return new JSAudioElement();
        case 'video': return new JSVideoElement();
        default:      return origCreate(tag, opts);
      }
    };
  }
}
