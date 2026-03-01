param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "Initial size: $($content.Length) chars"

$CR = "`r`n"

function Replace-Block($content, $old, $new, $name) {
    $idx = $content.IndexOf($old)
    if ($idx -ge 0) {
        Write-Host "OK: $name (idx $idx)"
        return $content.Replace($old, $new)
    } else {
        Write-Host "MISS: $name"
        return $content
    }
}

# ============================================================
# 1. Enhance mediaDevices (add getDisplayMedia, DOMException, addEventListener)
# ============================================================
$oldNav = "    mediaDevices: {" + $CR + "      getUserMedia(_c: unknown): Promise<unknown> { return Promise.reject(new Error('NotSupportedError')); }," + $CR + "      enumerateDevices(): Promise<unknown[]> { return Promise.resolve([]); }," + $CR + "      getSupportedConstraints(): object { return {}; }," + $CR + "    },"
$newNav = "    mediaDevices: {" + $CR + "      getUserMedia(_c: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); }," + $CR + "      getDisplayMedia(_c?: unknown): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError')); }," + $CR + "      enumerateDevices(): Promise<unknown[]> { return Promise.resolve([]); }," + $CR + "      getSupportedConstraints(): object { return {}; }," + $CR + "      addEventListener(_t: string, _fn: unknown): void {}," + $CR + "      removeEventListener(_t: string, _fn: unknown): void {}," + $CR + "    },"
$content = Replace-Block $content $oldNav $newNav "mediaDevices"

# ============================================================
# 2. Add navigator extensions before the closing }; of navigator
#    (after wakeLock block)
# ============================================================
$oldWake = "    // Wake Lock API stub" + $CR + "    wakeLock: {" + $CR + "      request(_type?: string): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }," + $CR + "    }," + $CR + "  };"
$newWake = "    // Wake Lock API stub" + $CR + "    wakeLock: {" + $CR + "      request(_type?: string): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }," + $CR + "    }," + $CR + "    // User Activation API (Chrome 72+)" + $CR + "    userActivation: { hasBeenActive: false, isActive: false }," + $CR + "    hasStorageAccess(): Promise<boolean> { return Promise.resolve(true); }," + $CR + "    requestStorageAccess(): Promise<void> { return Promise.resolve(); }," + $CR + "    // Battery Status API (Chrome 38+)" + $CR + "    getBattery(): Promise<unknown> {" + $CR + "      return Promise.resolve({" + $CR + "        charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0," + $CR + "        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null," + $CR + "        addEventListener(_t: string, _fn: unknown): void {}," + $CR + "        removeEventListener(_t: string, _fn: unknown): void {}," + $CR + "      });" + $CR + "    }," + $CR + "    // App Badge API (Chrome 81+)" + $CR + "    setAppBadge(_count?: number): Promise<void> { return Promise.resolve(); }," + $CR + "    clearAppBadge(): Promise<void> { return Promise.resolve(); }," + $CR + "    // Related Apps API (Chrome 80+)" + $CR + "    getInstalledRelatedApps(): Promise<unknown[]> { return Promise.resolve([]); }," + $CR + "    // Media Session API (Chrome 57+)" + $CR + "    mediaSession: {" + $CR + "      metadata: null as any," + $CR + "      playbackState: 'none' as string," + $CR + "      setActionHandler(_action: string, _handler: unknown): void {}," + $CR + "      setPositionState(_state?: unknown): void {}," + $CR + "      setMicrophoneActive(_active: boolean): void {}," + $CR + "      setCameraActive(_active: boolean): void {}," + $CR + "    }," + $CR + "  };"
$content = Replace-Block $content $oldWake $newWake "navigator extensions"

# ============================================================
# 3. Add new classes block before class EventTarget_
# ============================================================
$evtTargetMarker = "  class EventTarget_ {"
$evtIdx = $content.IndexOf($evtTargetMarker)
if ($evtIdx -ge 0) {
    Write-Host "OK: EventTarget_ found at idx $evtIdx"
    $newClasses = @"
  // ── ToggleEvent (Chrome 120+) ──────────────────────────────────────────────
  class ToggleEvent extends VEvent {
    oldState: string; newState: string;
    constructor(type: string, init?: { oldState?: string; newState?: string; bubbles?: boolean; cancelable?: boolean }) {
      super(type, init); this.oldState = init?.oldState ?? ''; this.newState = init?.newState ?? '';
    }
  }

  // ── Highlight API (Chrome 105+) ────────────────────────────────────────────
  class Highlight_ extends Set<unknown> {
    priority: number = 0;
    type: string = 'highlight';
  }

  // ── CloseWatcher (Chrome 120+) ────────────────────────────────────────────
  class CloseWatcher_ extends VEventTarget {
    onclose: ((e: VEvent) => void) | null = null;
    oncancel: ((e: VEvent) => void) | null = null;
    requestClose(): void { var e = new VEvent('close'); if (this.onclose) this.onclose(e); }
    close(): void { this.requestClose(); }
    destroy(): void {}
  }

  // ── EyeDropper (Chrome 95+) ───────────────────────────────────────────────
  class EyeDropper_ {
    open(_signal?: unknown): Promise<{ sRGBHex: string }> {
      return Promise.reject(new DOMException('NotSupportedError', 'EyeDropper not supported'));
    }
  }

  // ── MediaStreamTrack (stub) ───────────────────────────────────────────────
  class MediaStreamTrack_ extends VEventTarget {
    kind: string = 'video'; id: string = ''; label: string = '';
    enabled: boolean = true; muted: boolean = false; readyState: string = 'ended';
    contentHint: string = '';
    onmute: ((e: VEvent) => void) | null = null;
    onunmute: ((e: VEvent) => void) | null = null;
    onended: ((e: VEvent) => void) | null = null;
    stop(): void { this.readyState = 'ended'; }
    getSettings(): object { return {}; }
    getCapabilities(): object { return {}; }
    getConstraints(): object { return {}; }
    applyConstraints(_c?: unknown): Promise<void> { return Promise.resolve(); }
    clone(): MediaStreamTrack_ { return new MediaStreamTrack_(); }
  }

  // ── MediaStream (stub) ────────────────────────────────────────────────────
  class MediaStream_ extends VEventTarget {
    id: string = Math.random().toString(36).slice(2);
    active: boolean = false;
    _tracks: MediaStreamTrack_[] = [];
    constructor(tracks?: MediaStreamTrack_[]) { super(); if (tracks) this._tracks = [...tracks]; }
    getTracks(): MediaStreamTrack_[] { return [...this._tracks]; }
    getAudioTracks(): MediaStreamTrack_[] { return this._tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks(): MediaStreamTrack_[] { return this._tracks.filter(t => t.kind === 'video'); }
    getTrackById(id: string): MediaStreamTrack_ | null { return this._tracks.find(t => t.id === id) ?? null; }
    addTrack(t: MediaStreamTrack_): void { if (!this._tracks.includes(t)) this._tracks.push(t); }
    removeTrack(t: MediaStreamTrack_): void { this._tracks = this._tracks.filter(x => x !== t); }
    clone(): MediaStream_ { return new MediaStream_(this._tracks.map(t => t.clone())); }
  }

  // ── MediaRecorder (stub) ──────────────────────────────────────────────────
  class MediaRecorder_ extends VEventTarget {
    state: string = 'inactive'; mimeType: string = '';
    videoBitsPerSecond: number = 0; audioBitsPerSecond: number = 0;
    stream: MediaStream_; ondataavailable: ((e: unknown) => void) | null = null;
    onstop: ((e: VEvent) => void) | null = null;
    onstart: ((e: VEvent) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onpause: ((e: VEvent) => void) | null = null;
    onresume: ((e: VEvent) => void) | null = null;
    constructor(stream: MediaStream_, _opts?: unknown) { super(); this.stream = stream; }
    start(_timeslice?: number): void { this.state = 'recording'; }
    stop(): void { this.state = 'inactive'; }
    pause(): void { this.state = 'paused'; }
    resume(): void { this.state = 'recording'; }
    requestData(): void {}
    static isTypeSupported(_mime: string): boolean { return false; }
  }

  // ── WebTransport (stub) ───────────────────────────────────────────────────
  class WebTransport_ {
    readonly ready: Promise<void>;
    readonly closed: Promise<{ closeCode: number; reason: string }>;
    constructor(_url: string, _opts?: unknown) {
      this.ready = Promise.reject(new DOMException('NotSupportedError', 'WebTransport not supported'));
      this.closed = Promise.reject(new DOMException('NotSupportedError', 'WebTransport not supported'));
    }
    close(_info?: unknown): void {}
    createBidirectionalStream(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }
    createUnidirectionalStream(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError')); }
  }

  // ── SpeechRecognition (stub) ──────────────────────────────────────────────
  class SpeechRecognition_ extends VEventTarget {
    lang: string = ''; continuous: boolean = false; interimResults: boolean = false;
    maxAlternatives: number = 1; grammars: any = null;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: ((e: VEvent) => void) | null = null;
    onstart: ((e: VEvent) => void) | null = null;
    onnomatch: ((e: unknown) => void) | null = null;
    start(): void {
      setTimeout_(() => {
        if (this.onerror) this.onerror({ error: 'not-allowed', message: 'Speech recognition not supported' });
        if (this.onend) this.onend(new VEvent('end'));
      }, 0);
    }
    stop(): void {} abort(): void {}
  }

  // ── SpeechGrammar / SpeechGrammarList (stubs) ─────────────────────────────
  class SpeechGrammar_ { src: string = ''; weight: number = 1; }
  class SpeechGrammarList_ {
    _list: SpeechGrammar_[] = [];
    get length(): number { return this._list.length; }
    item(idx: number): SpeechGrammar_ { return this._list[idx]; }
    addFromURI(_src: string, _weight?: number): void {}
    addFromString(_str: string, _weight?: number): void {}
  }

  // ── MediaMetadata (Chrome 57+) ─────────────────────────────────────────────
  class MediaMetadata_ {
    title: string; artist: string; album: string; artwork: unknown[];
    constructor(init?: { title?: string; artist?: string; album?: string; artwork?: unknown[] }) {
      this.title = init?.title ?? ''; this.artist = init?.artist ?? '';
      this.album = init?.album ?? ''; this.artwork = init?.artwork ?? [];
    }
  }

"@
    $content = $content.Insert($evtIdx, $newClasses.Replace("`n", "`r`n"))
    Write-Host "Inserted new classes block"
} else {
    Write-Host "MISS: EventTarget_ not found"
}

# ============================================================
# Write back
# ============================================================
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
$finalSize = [System.IO.File]::ReadAllBytes($f).Length
Write-Host "DONE. Final size: $finalSize bytes"
