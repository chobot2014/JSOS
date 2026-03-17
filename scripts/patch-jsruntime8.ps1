$ErrorActionPreference = "Stop"
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$c = [System.IO.File]::ReadAllText($f)
$orig = [System.IO.File]::ReadAllBytes($f).Length
Write-Host "Original: $orig bytes"
function Rep($old, $new) {
  if ($c.IndexOf($old) -lt 0) { Write-Warning "NOT FOUND: $($old.Substring(0,[Math]::Min(60,$old.Length)))"; return }
  $script:c = $script:c.Replace($old, $new)
}
$streamAnchor = "  class ReadableStreamDefaultReader_ {"
$newBlock = @"
  // ── WebCodecs (Chrome 94+) ─────────────────────────────────────────────────
  class VideoColorSpace_ {
    fullRange = false; matrix = "rgb"; primaries = "bt709"; transfer = "iec61966-2-1";
    constructor(_init?: unknown) {}
    toJSON(): unknown { return { fullRange: this.fullRange, matrix: this.matrix, primaries: this.primaries, transfer: this.transfer }; }
  }
  class EncodedVideoChunk_ {
    type: string; timestamp: number; duration: number | null; byteLength: number;
    constructor(init: any) { this.type = init?.type ?? "key"; this.timestamp = init?.timestamp ?? 0; this.duration = init?.duration ?? null; this.byteLength = (init?.data?.byteLength ?? 0); }
    copyTo(_dest: unknown): void {}
  }
  class EncodedAudioChunk_ {
    type: string; timestamp: number; duration: number | null; byteLength: number;
    constructor(init: any) { this.type = init?.type ?? "key"; this.timestamp = init?.timestamp ?? 0; this.duration = init?.duration ?? null; this.byteLength = (init?.data?.byteLength ?? 0); }
    copyTo(_dest: unknown): void {}
  }
  class VideoFrame_ {
    codedWidth = 0; codedHeight = 0; displayWidth = 0; displayHeight = 0;
    timestamp: number; duration: number | null; colorSpace: VideoColorSpace_;
    constructor(_init: unknown, opts?: any) {
      this.timestamp = opts?.timestamp ?? 0; this.duration = opts?.duration ?? null;
      this.colorSpace = new VideoColorSpace_();
    }
    allocationSize(_opts?: unknown): number { return this.codedWidth * this.codedHeight * 4; }
    copyTo(_dest: unknown, _opts?: unknown): Promise<unknown> { return Promise.resolve([]); }
    clone(): VideoFrame_ { return new VideoFrame_(null, { timestamp: this.timestamp }); }
    close(): void {}
  }
  class AudioData_ {
    format = "f32"; sampleRate = 48000; numberOfFrames = 0; numberOfChannels = 1;
    duration = 0; timestamp: number;
    constructor(init: any) { this.timestamp = init?.timestamp ?? 0; }
    allocationSize(_opts?: unknown): number { return this.numberOfFrames * 4; }
    copyTo(_dest: unknown, _opts?: unknown): void {}
    clone(): AudioData_ { return new AudioData_({ timestamp: this.timestamp }); }
    close(): void {}
  }
  class VideoDecoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0; _init: any;
    constructor(init: any) { super(); this._init = init; }
    configure(_cfg: unknown): void { this.state = "configured"; }
    decode(_chunk: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(_c: unknown): Promise<unknown> { return Promise.resolve({ supported: false }); }
  }
  class VideoEncoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; encodeQueueSize = 0;
    constructor(_init: any) { super(); }
    configure(_cfg: unknown): void { this.state = "configured"; }
    encode(_frame: unknown, _opts?: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(_c: unknown): Promise<unknown> { return Promise.resolve({ supported: false }); }
  }
  class AudioDecoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; decodeQueueSize = 0;
    constructor(_init: any) { super(); }
    configure(_cfg: unknown): void { this.state = "configured"; }
    decode(_chunk: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(_c: unknown): Promise<unknown> { return Promise.resolve({ supported: false }); }
  }
  class AudioEncoder_ extends VEventTarget {
    state: "unconfigured" | "configured" | "closed" = "unconfigured"; encodeQueueSize = 0;
    constructor(_init: any) { super(); }
    configure(_cfg: unknown): void { this.state = "configured"; }
    encode(_data: unknown, _opts?: unknown): void {}
    flush(): Promise<void> { return Promise.resolve(); }
    reset(): void { this.state = "unconfigured"; }
    close(): void { this.state = "closed"; }
    static isConfigSupported(_c: unknown): Promise<unknown> { return Promise.resolve({ supported: false }); }
  }
  class ImageTrack_ {
    animated = false; frameCount = 1; repetitionCount = 0; selected = true;
  }
  class ImageTrackList_ {
    length = 0; selectedIndex = -1; selectedTrack: ImageTrack_ | null = null;
    ready: Promise<void> = Promise.resolve();
    [Symbol.iterator](): Iterator<ImageTrack_> { return ([] as ImageTrack_[])[Symbol.iterator](); }
  }
  class ImageDecoder_ {
    complete = false; type = ""; tracks = new ImageTrackList_();
    constructor(_init: unknown) {}
    decode(_opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    reset(): void {} close(): void {}
    static isTypeSupported(_t: string): Promise<boolean> { return Promise.resolve(false); }
  }
  // Navigation API event constructors (Chrome 102+)
  class NavigateEvent_ extends VEvent {
    canIntercept: boolean; destination: unknown; downloadRequest: string | null;
    formData: FormData | null; hashChange: boolean; info: unknown;
    navigationType: string; signal: AbortSignal;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.canIntercept = init.canIntercept ?? false; this.destination = init.destination ?? null;
      this.downloadRequest = init.downloadRequest ?? null; this.formData = init.formData ?? null;
      this.hashChange = init.hashChange ?? false; this.info = init.info ?? undefined;
      this.navigationType = init.navigationType ?? "push";
      this.signal = init.signal ?? new AbortController().signal;
    }
    intercept(_opts?: unknown): void {}
    scroll(): void {}
  }
  class NavigationCurrentEntryChangeEvent_ extends VEvent {
    from: unknown; navigationType: string | null;
    constructor(type: string, init: any = {}) {
      super(type, init); this.from = init.from ?? null; this.navigationType = init.navigationType ?? null;
    }
  }
  // Scroll-driven animations (Chrome 115+)
  class ScrollTimeline_ {
    axis: string; source: unknown | null;
    constructor(opts: any = {}) { this.axis = opts.axis ?? "block"; this.source = opts.source ?? null; }
    get currentTime(): unknown { return null; }
  }
  class ViewTimeline_ {
    axis: string; subject: unknown | null; startOffset: unknown; endOffset: unknown;
    constructor(opts: any = {}) {
      this.axis = opts.axis ?? "block"; this.subject = opts.subject ?? null;
      this.startOffset = null; this.endOffset = null;
    }
    get currentTime(): unknown { return null; }
  }
  // Reporting API (Chrome 69+)
  class ReportingObserver_ {
    _cb: (reports: unknown[], obs: ReportingObserver_) => void;
    constructor(cb: (reports: unknown[], obs: ReportingObserver_) => void, _opts?: unknown) { this._cb = cb; }
    observe(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; }
  }
  // ContactsManager (Android Chrome 80+)
  class ContactsManager_ {
    getProperties(): Promise<string[]> { return Promise.resolve(["name", "email", "tel", "address", "icon"]); }
    select(_props: string[], _opts?: unknown): Promise<unknown[]> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
  }
  // PictureInPictureWindow
  class PictureInPictureWindow_ extends VEventTarget {
    width = 0; height = 0;
    onresize: ((ev: VEvent) => void) | null = null;
  }
  // PushManager / PushSubscription (Chrome 42+)
  class PushSubscription_ {
    endpoint = ""; expirationTime: number | null = null;
    options = { applicationServerKey: null as unknown, userVisibleOnly: true };
    getKey(_name: string): ArrayBuffer | null { return null; }
    toJSON(): unknown { return { endpoint: this.endpoint, expirationTime: this.expirationTime, keys: {} }; }
    unsubscribe(): Promise<boolean> { return Promise.resolve(false); }
  }
  class PushManager_ {
    permissionState(_opts?: unknown): Promise<string> { return Promise.resolve("denied"); }
    subscribe(_opts?: unknown): Promise<PushSubscription_> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    getSubscription(): Promise<PushSubscription_ | null> { return Promise.resolve(null); }
  }
  // SyncManager / PeriodicSyncManager (Chrome 49+/80+)
  class SyncManager_ {
    register(_tag: string): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    getTags(): Promise<string[]> { return Promise.resolve([]); }
  }
  class PeriodicSyncManager_ {
    register(_tag: string, _opts?: unknown): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    unregister(_tag: string): Promise<void> { return Promise.resolve(); }
    getTags(): Promise<string[]> { return Promise.resolve([]); }
  }
  // PageRevealEvent (Chrome 123+)
  class PageRevealEvent_ extends VEvent {
    viewTransition: unknown | null;
    constructor(type: string, init: any = {}) { super(type, init); this.viewTransition = init.viewTransition ?? null; }
  }
  // SnapEvent (CSS Scroll Snap, Chrome 129+)
  class SnapEvent_ extends VEvent {
    snapTargetBlock: unknown | null; snapTargetInline: unknown | null;
    constructor(type: string, init: any = {}) {
      super(type, init); this.snapTargetBlock = init.snapTargetBlock ?? null; this.snapTargetInline = init.snapTargetInline ?? null;
    }
  }
  // CSSPropertyRule (Houdini Properties & Values, Chrome 85+)
  class CSSPropertyRule_ extends CSSRule_ {
    name = ""; syntax = "*"; inherits = false; initialValue: string | null = null;
    constructor(init: any = {}) {
      super(); this.name = init.name ?? ""; this.syntax = init.syntax ?? "*";
      this.inherits = init.inherits ?? false; this.initialValue = init.initialValue ?? null;
    }
  }
  // ResizeObserverSize (Chrome 84+)
  class ResizeObserverSize_ {
    blockSize: number; inlineSize: number;
    constructor(inline = 0, block = 0) { this.inlineSize = inline; this.blockSize = block; }
  }
  class ReadableStreamDefaultReader_ {
"@
Rep $streamAnchor $newBlock
$wgslEnd = "      wgslLanguageFeatures: new Set<string>()," + [char]13 + [char]10 + "    },"
$wgslNew = "      wgslLanguageFeatures: new Set<string>()," + [char]13 + [char]10 + "    }," + [char]13 + [char]10 + "      /** Contacts API - Android Chrome 80+, not available on desktop */" + [char]13 + [char]10 + "      contacts: new ContactsManager_(),"
Rep $wgslEnd $wgslNew
$winTail = "    FileSystemWritableFileStream: Object," + [char]13 + [char]10 + "  };"
$winNew = "    FileSystemWritableFileStream: Object," + [char]13 + [char]10 + @"

    // -- WebCodecs (Chrome 94+) -----------------------------------------------
    VideoDecoder:       VideoDecoder_,
    VideoEncoder:       VideoEncoder_,
    AudioDecoder:       AudioDecoder_,
    AudioEncoder:       AudioEncoder_,
    ImageDecoder:       ImageDecoder_,
    ImageTrack:         ImageTrack_,
    ImageTrackList:     ImageTrackList_,
    VideoFrame:         VideoFrame_,
    AudioData:          AudioData_,
    VideoColorSpace:    VideoColorSpace_,
    EncodedVideoChunk:  EncodedVideoChunk_,
    EncodedAudioChunk:  EncodedAudioChunk_,

    // -- Navigation API events (Chrome 102+) ----------------------------------
    NavigateEvent:                     NavigateEvent_,
    NavigationCurrentEntryChangeEvent: NavigationCurrentEntryChangeEvent_,

    // -- Scroll-driven animations (Chrome 115+) -------------------------------
    ScrollTimeline: ScrollTimeline_,
    ViewTimeline:   ViewTimeline_,

    // -- Reporting API (Chrome 69+) -------------------------------------------
    ReportingObserver: ReportingObserver_,

    // -- Contacts (Android Chrome 80+) ----------------------------------------
    ContactsManager: ContactsManager_,

    // -- PictureInPicture -----------------------------------------------------
    PictureInPictureWindow: PictureInPictureWindow_,
    PictureInPictureEvent:  VEvent,

    // -- Push / Background Sync -----------------------------------------------
    PushManager:          PushManager_,
    PushSubscription:     PushSubscription_,
    PushMessageData:      Object,
    PushEvent:            VEvent,
    SyncManager:          SyncManager_,
    PeriodicSyncManager:  PeriodicSyncManager_,

    // -- PageRevealEvent / SnapEvent ------------------------------------------
    PageRevealEvent: PageRevealEvent_,
    SnapEvent:       SnapEvent_,

    // -- CSS Houdini ----------------------------------------------------------
    CSSPropertyRule:    CSSPropertyRule_,
    ResizeObserverSize: ResizeObserverSize_,
  };
"@
Rep $winTail $winNew
[System.IO.File]::WriteAllText($f, $c, $utf8NoBom)
$newLen = [System.IO.File]::ReadAllBytes($f).Length
Write-Host "New size: $newLen bytes (delta: $($newLen - $orig))"
if ($newLen -le $orig) { Write-Warning "File did not grow!" } else { Write-Host "OK" }
