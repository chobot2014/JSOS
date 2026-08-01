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
$anchor = "  class ReadableStreamDefaultReader_ {"
$newBlock = @"
  // WritableStreamDefaultWriter (needed for WritableStream.getWriter() return type detection)
  class WritableStreamDefaultWriter_ {
    closed: Promise<void>; ready: Promise<void>; desiredSize: number | null;
    _stream: any;
    constructor(stream: any) {
      this._stream = stream;
      this.desiredSize = 1;
      this.closed  = new Promise<void>(res => { (this as any)._closedResolve = res; });
      this.ready   = Promise.resolve();
    }
    write(chunk: unknown): Promise<void> {
      if (this._stream && this._stream._write) { this._stream._write(chunk); }
      return Promise.resolve();
    }
    close(): Promise<void> { return Promise.resolve(); }
    abort(_reason?: unknown): Promise<void> { return Promise.resolve(); }
    releaseLock(): void {}
  }
  // TransformStreamDefaultController
  class TransformStreamDefaultController_ {
    desiredSize: number | null = 1;
    enqueue(_chunk: unknown): void {}
    error(_reason?: unknown): void {}
    terminate(): void {}
  }
  // ScreenOrientation (Chrome 38+)
  class ScreenOrientation_ extends VEventTarget {
    angle = 0; type = "landscape-primary";
    onchange: ((ev: VEvent) => void) | null = null;
    lock(_orientation: string): Promise<void> { return Promise.reject(new DOMException("Not supported", "NotSupportedError")); }
    unlock(): void {}
  }
  // CSS Typed OM stubs (Chrome 66+)
  class CSSStyleValue_ {
    toString(): string { return ""; }
    static parse(_p: string, _v: string): CSSStyleValue_ { return new CSSStyleValue_(); }
    static parseAll(_p: string, _v: string): CSSStyleValue_[] { return []; }
  }
  class CSSNumericValue_ extends CSSStyleValue_ {
    value = 0; unit = "";
    constructor(v = 0, u = "") { super(); this.value = v; this.unit = u; }
    add(..._vals: unknown[]): CSSNumericValue_ { return this; }
    sub(..._vals: unknown[]): CSSNumericValue_ { return this; }
    mul(..._vals: unknown[]): CSSNumericValue_ { return this; }
    div(..._vals: unknown[]): CSSNumericValue_ { return this; }
    min(..._vals: unknown[]): CSSNumericValue_ { return this; }
    max(..._vals: unknown[]): CSSNumericValue_ { return this; }
    equals(..._vals: unknown[]): boolean { return false; }
    to(_unit: string): CSSNumericValue_ { return this; }
    toSum(..._units: string[]): CSSNumericValue_ { return this; }
    type(): unknown { return {}; }
  }
  class CSSUnitValue_ extends CSSNumericValue_ {
    constructor(value: number, unit: string) { super(value, unit); }
    toString(): string { return `${this.value}${this.unit}`; }
  }
  class CSSKeywordValue_ extends CSSStyleValue_ {
    value: string;
    constructor(v: string) { super(); this.value = v; }
    toString(): string { return this.value; }
  }
  class StylePropertyMap_ {
    _map = new Map<string, CSSStyleValue_>();
    get(property: string): CSSStyleValue_ | undefined { return this._map.get(property); }
    getAll(property: string): CSSStyleValue_[] { var v = this._map.get(property); return v ? [v] : []; }
    has(property: string): boolean { return this._map.has(property); }
    set(property: string, ...values: unknown[]): void { this._map.set(property, values[0] as CSSStyleValue_); }
    append(_property: string, ..._values: unknown[]): void {}
    delete(property: string): void { this._map.delete(property); }
    clear(): void { this._map.clear(); }
    forEach(fn: (v: CSSStyleValue_, k: string, m: StylePropertyMap_) => void): void { this._map.forEach((v, k) => fn(v, k, this)); }
    get size(): number { return this._map.size; }
    entries(): IterableIterator<[string, CSSStyleValue_]> { return this._map.entries(); }
    keys(): IterableIterator<string> { return this._map.keys(); }
    values(): IterableIterator<CSSStyleValue_> { return this._map.values(); }
    [Symbol.iterator](): IterableIterator<[string, CSSStyleValue_]> { return this._map.entries(); }
  }
  // Sanitizer API (Chrome 105+)
  class Sanitizer_ {
    _config: unknown;
    constructor(config?: unknown) { this._config = config; }
    sanitize(_input: unknown): unknown { return _input; }
    sanitizeFor(_element: string, _input: string): unknown { return null; }
    getConfiguration(): unknown { return this._config ?? {}; }
    static getDefaultConfiguration(): unknown { return {}; }
  }
  // Trusted Types stubs (Chrome 83+)
  class TrustedHTML_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedScript_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedScriptURL_ {
    _value: string; constructor(v: string) { this._value = v; }
    toString(): string { return this._value; }
    toJSON(): string { return this._value; }
  }
  class TrustedTypePolicy_ {
    name: string;
    constructor(name: string, _rules: unknown) { this.name = name; }
    createHTML(input: string, ..._args: unknown[]): TrustedHTML_ { return new TrustedHTML_(input); }
    createScript(input: string, ..._args: unknown[]): TrustedScript_ { return new TrustedScript_(input); }
    createScriptURL(input: string, ..._args: unknown[]): TrustedScriptURL_ { return new TrustedScriptURL_(input); }
  }
  class TrustedTypePolicyFactory_ {
    _policies = new Map<string, TrustedTypePolicy_>();
    defaultPolicy: TrustedTypePolicy_ | null = null;
    emptyHTML: TrustedHTML_ = new TrustedHTML_("");
    emptyScript: TrustedScript_ = new TrustedScript_("");
    createPolicy(name: string, rules?: unknown): TrustedTypePolicy_ {
      var p = new TrustedTypePolicy_(name, rules ?? {});
      this._policies.set(name, p);
      if (name === "default") this.defaultPolicy = p;
      return p;
    }
    isHTML(val: unknown): val is TrustedHTML_ { return val instanceof TrustedHTML_; }
    isScript(val: unknown): val is TrustedScript_ { return val instanceof TrustedScript_; }
    isScriptURL(val: unknown): val is TrustedScriptURL_ { return val instanceof TrustedScriptURL_; }
    getAttributeType(_tagName: string, _attr: string, _ns?: string): string | null { return null; }
    getPropertyType(_tagName: string, _prop: string, _ns?: string): string | null { return null; }
    getPolicyNames(): string[] { return [...this._policies.keys()]; }
    getTypeMapping(_ns?: string): unknown { return {}; }
  }
  // MessagePort (Chrome 1+) - needed for MessageChannel
  class MessagePort_ extends VEventTarget {
    onmessage: ((ev: VEvent) => void) | null = null;
    onmessageerror: ((ev: VEvent) => void) | null = null;
    _other: MessagePort_ | null = null;
    postMessage(data: unknown, _transfer?: unknown): void {
      var port = this._other;
      if (!port) return;
      var ev = new VEvent("message", { bubbles: false, cancelable: false });
      (ev as any).data = data; (ev as any).source = null; (ev as any).lastEventId = ""; (ev as any).origin = "";
      setTimeout_(() => { try { port!.dispatchEvent(ev); } catch(_) {} }, 0);
    }
    start(): void {}
    close(): void {}
  }
  // WakeLockSentinel (Screen Wake Lock API, Chrome 84+)
  class WakeLockSentinel_ extends VEventTarget {
    released = false; type = "screen";
    onrelease: ((ev: VEvent) => void) | null = null;
    release(): Promise<void> { this.released = true; return Promise.resolve(); }
  }
  // LockManager (Web Locks API, Chrome 69+)
  class Lock_ {
    mode: string; name: string;
    constructor(name: string, mode: string) { this.name = name; this.mode = mode; }
  }
  class LockManager_ {
    request(name: string, cbOrOptions: unknown, cb?: (lock: Lock_) => unknown): Promise<unknown> {
      var theCb = typeof cbOrOptions === "function" ? cbOrOptions as (lock: Lock_) => unknown : cb;
      var opts: any = typeof cbOrOptions === "object" && cbOrOptions !== null ? cbOrOptions : {};
      var mode = opts.mode ?? "exclusive";
      if (!theCb) return Promise.resolve();
      var lock = new Lock_(name, mode);
      try { var result = (theCb as any)(lock); return Promise.resolve(result); } catch(e) { return Promise.reject(e); }
    }
    query(): Promise<unknown> { return Promise.resolve({ held: [], pending: [] }); }
  }
  // CacheStorage / Cache (Service Worker Caches API, Chrome 43+)
  class Cache_ {
    _entries: Map<string, unknown> = new Map();
    match(request: unknown, _opts?: unknown): Promise<unknown> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      return Promise.resolve(this._entries.get(url) ?? undefined);
    }
    matchAll(request?: unknown, _opts?: unknown): Promise<unknown[]> {
      if (!request) return Promise.resolve([...this._entries.values()]);
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      var v = this._entries.get(url); return Promise.resolve(v ? [v] : []);
    }
    add(_request: unknown): Promise<void> { return Promise.resolve(); }
    addAll(_requests: unknown[]): Promise<void> { return Promise.resolve(); }
    put(request: unknown, _response: unknown): Promise<void> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      this._entries.set(url, _response); return Promise.resolve();
    }
    delete(request: unknown, _opts?: unknown): Promise<boolean> {
      var url = typeof request === "string" ? request : (request as any)?.url ?? "";
      return Promise.resolve(this._entries.delete(url));
    }
    keys(_request?: unknown, _opts?: unknown): Promise<unknown[]> { return Promise.resolve([...this._entries.keys()]); }
  }
  class CacheStorage_ {
    _caches: Map<string, Cache_> = new Map();
    match(request: unknown, opts?: unknown): Promise<unknown> {
      for (var cache of this._caches.values()) {
        var url = typeof request === "string" ? request : (request as any)?.url ?? "";
        if (cache._entries.has(url)) return cache.match(request, opts);
      }
      return Promise.resolve(undefined);
    }
    has(cacheName: string): Promise<boolean> { return Promise.resolve(this._caches.has(cacheName)); }
    open(cacheName: string): Promise<Cache_> {
      if (!this._caches.has(cacheName)) this._caches.set(cacheName, new Cache_());
      return Promise.resolve(this._caches.get(cacheName)!);
    }
    delete(cacheName: string): Promise<boolean> { return Promise.resolve(this._caches.delete(cacheName)); }
    keys(): Promise<string[]> { return Promise.resolve([...this._caches.keys()]); }
  }
  // ServiceWorkerContainer stub (Chrome 40+)
  class ServiceWorkerContainer_ extends VEventTarget {
    controller: unknown | null = null;
    ready: Promise<unknown> = new Promise(() => {}); // never resolves (no SW)
    oncontrollerchange: ((ev: VEvent) => void) | null = null;
    onmessage: ((ev: VEvent) => void) | null = null;
    onmessageerror: ((ev: VEvent) => void) | null = null;
    register(_scriptURL: string, _options?: unknown): Promise<unknown> {
      return Promise.reject(new DOMException("Service workers are not supported in JSOS", "NotSupportedError"));
    }
    getRegistration(_scope?: string): Promise<unknown> { return Promise.resolve(undefined); }
    getRegistrations(): Promise<unknown[]> { return Promise.resolve([]); }
    startMessages(): void {}
  }
  // PaymentRequest (Chrome 60+) — stub so feature detection works
  class PaymentRequest_ extends VEventTarget {
    id = ""; shippingAddress: unknown | null = null; shippingOption: string | null = null; shippingType: string | null = null;
    onshippingaddresschange: ((ev: VEvent) => void) | null = null;
    onshippingoptionchange: ((ev: VEvent) => void) | null = null;
    onpaymentmethodchange: ((ev: VEvent) => void) | null = null;
    constructor(_methodData: unknown, _details: unknown, _options?: unknown) { super(); }
    show(_details?: unknown): Promise<unknown> { return Promise.reject(new DOMException("Payment not supported", "NotSupportedError")); }
    abort(): Promise<void> { return Promise.resolve(); }
    canMakePayment(): Promise<boolean> { return Promise.resolve(false); }
    hasEnrolledInstrument(): Promise<boolean> { return Promise.resolve(false); }
    static canMakePayment(_data: unknown): Promise<boolean> { return Promise.resolve(false); }
  }
  // PublicKeyCredential / CredentialsContainer (WebAuthn, Chrome 67+)
  class Credential_ {
    id = ""; type = "";
  }
  class PublicKeyCredential_ extends Credential_ {
    rawId: ArrayBuffer = new ArrayBuffer(0);
    response: unknown = {};
    authenticatorAttachment: string | null = null;
    getClientExtensionResults(): unknown { return {}; }
    toJSON(): unknown { return {}; }
    static isConditionalMediationAvailable(): Promise<boolean> { return Promise.resolve(false); }
    static isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> { return Promise.resolve(false); }
    static parseCreationOptionsFromJSON(_opts: unknown): unknown { return _opts; }
    static parseRequestOptionsFromJSON(_opts: unknown): unknown { return _opts; }
  }
  class CredentialsContainer_ {
    get(_options?: unknown): Promise<Credential_ | null> { return Promise.resolve(null); }
    create(_options?: unknown): Promise<Credential_ | null> { return Promise.reject(new DOMException("Credentials not supported", "NotSupportedError")); }
    store(_credential: unknown): Promise<Credential_> { return Promise.reject(new DOMException("Credentials not supported", "NotSupportedError")); }
    preventSilentAccess(): Promise<void> { return Promise.resolve(); }
  }
  // XR (WebXR Device API, Chrome 79+) — minimal stubs
  class XRSystem_ extends VEventTarget {
    ondevicechange: ((ev: VEvent) => void) | null = null;
    isSessionSupported(_mode: string): Promise<boolean> { return Promise.resolve(false); }
    requestSession(_mode: string, _opts?: unknown): Promise<unknown> { return Promise.reject(new DOMException("WebXR not supported", "NotSupportedError")); }
  }
  class XRSession_ extends VEventTarget {
    renderState: unknown = {}; inputSources: unknown[] = [];
    visibilityState = "hidden"; frameRate: number | null = null;
    onend: ((ev: VEvent) => void) | null = null;
    onselect: ((ev: VEvent) => void) | null = null;
    onselectstart: ((ev: VEvent) => void) | null = null;
    onselectend: ((ev: VEvent) => void) | null = null;
    onsqueeze: ((ev: VEvent) => void) | null = null;
    updateRenderState(_state?: unknown): void {}
    requestReferenceSpace(_type: string): Promise<unknown> { return Promise.reject(new DOMException("WebXR not supported", "NotSupportedError")); }
    requestAnimationFrame(_callback: (time: number, frame: unknown) => void): number { return 0; }
    cancelAnimationFrame(_id: number): void {}
    end(): Promise<void> { return Promise.resolve(); }
  }
  // BarcodeDetector / Shape Detection API (Chrome 83+)
  class BarcodeDetector_ {
    constructor(_opts?: unknown) {}
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
    static getSupportedFormats(): Promise<string[]> { return Promise.resolve([]); }
  }
  class FaceDetector_ {
    constructor(_opts?: unknown) {}
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
  }
  class TextDetector_ {
    detect(_image: unknown): Promise<unknown[]> { return Promise.resolve([]); }
  }
  // NavigationPreloadManager (Service Worker, Chrome 62+)
  class NavigationPreloadManager_ {
    enable(): Promise<void> { return Promise.resolve(); }
    disable(): Promise<void> { return Promise.resolve(); }
    setHeaderValue(_value: string): Promise<void> { return Promise.resolve(); }
    getState(): Promise<unknown> { return Promise.resolve({ enabled: false, headerValue: "true" }); }
  }  class ReadableStreamDefaultReader_ {
"@
Rep $anchor $newBlock
$navContactsEnd = "      contacts: new ContactsManager_(),"
if ($c.IndexOf($navContactsEnd) -lt 0) { Write-Warning "contacts not found; using alternate anchor" }
Rep $navContactsEnd ($navContactsEnd + [char]13 + [char]10 + "      credentials: new CredentialsContainer_()," + [char]13 + [char]10 + "      serviceWorker: new ServiceWorkerContainer_()," + [char]13 + [char]10 + "      locks: new LockManager_(),")
$screenOrient = "      availLeft: 0, availTop: 0,"
Rep $screenOrient ($screenOrient + [char]13 + [char]10 + "      orientation: new ScreenOrientation_(),")
$cookieLine = "      cookieStore: {"
$winTail = "    ResizeObserverSize: ResizeObserverSize_," + [char]13 + [char]10 + "  };"
$winNew = "    ResizeObserverSize: ResizeObserverSize_," + [char]13 + [char]10 + @"

    // -- Streams writers/controllers ------------------------------------------
    WritableStreamDefaultWriter:       WritableStreamDefaultWriter_,
    TransformStreamDefaultController:  TransformStreamDefaultController_,

    // -- ScreenOrientation (Chrome 38+) ----------------------------------------
    ScreenOrientation: ScreenOrientation_,

    // -- CSS Typed OM (Chrome 66+) ---------------------------------------------
    CSSStyleValue:    CSSStyleValue_,
    CSSNumericValue:  CSSNumericValue_,
    CSSUnitValue:     CSSUnitValue_,
    CSSKeywordValue:  CSSKeywordValue_,
    StylePropertyMap: StylePropertyMap_,
    CSS:              (win as any).CSS ?? {},

    // -- Sanitizer API (Chrome 105+) -------------------------------------------
    Sanitizer: Sanitizer_,

    // -- Trusted Types (Chrome 83+) --------------------------------------------
    TrustedHTML:               TrustedHTML_,
    TrustedScript:             TrustedScript_,
    TrustedScriptURL:          TrustedScriptURL_,
    TrustedTypePolicy:         TrustedTypePolicy_,
    TrustedTypePolicyFactory:  TrustedTypePolicyFactory_,
    trustedTypes:              new TrustedTypePolicyFactory_(),

    // -- MessagePort ----------------------------------------------------------
    MessagePort: MessagePort_,

    // -- WakeLock (Chrome 84+) ------------------------------------------------
    WakeLockSentinel: WakeLockSentinel_,

    // -- Web Locks (Chrome 69+) -----------------------------------------------
    Lock:        Lock_,
    LockManager: LockManager_,

    // -- CacheStorage / Cache (Chrome 43+) ------------------------------------
    caches:       new CacheStorage_(),
    Cache:        Cache_,
    CacheStorage: CacheStorage_,

    // -- ServiceWorkerContainer -----------------------------------------------
    ServiceWorkerContainer: ServiceWorkerContainer_,

    // -- PaymentRequest (Chrome 60+) ------------------------------------------
    PaymentRequest:           PaymentRequest_,
    PaymentResponse:          Object,
    PaymentMethodChangeEvent: VEvent,

    // -- WebAuthn (Chrome 67+) ------------------------------------------------
    Credential:               Credential_,
    PublicKeyCredential:      PublicKeyCredential_,
    CredentialsContainer:     CredentialsContainer_,

    // -- WebXR (Chrome 79+) ---------------------------------------------------
    XRSystem:     XRSystem_,
    XRSession:    XRSession_,
    XRRigidTransform: Object,
    XRFrame:      Object,

    // -- Shape Detection API (Chrome 83+) ------------------------------------
    BarcodeDetector: BarcodeDetector_,
    FaceDetector:    FaceDetector_,
    TextDetector:    TextDetector_,

    // -- NavigationPreloadManager (Chrome 62+) --------------------------------
    NavigationPreloadManager: NavigationPreloadManager_,
  };
"@
Rep $winTail $winNew
[System.IO.File]::WriteAllText($f, $c, $utf8NoBom)
$newLen = [System.IO.File]::ReadAllBytes($f).Length
Write-Host "New size: $newLen bytes (delta: $($newLen - $orig))"
if ($newLen -le $orig) { Write-Warning "File did not grow!" } else { Write-Host "OK" }
