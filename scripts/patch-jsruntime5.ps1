param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "Initial: $($content.Length) chars"
$CR = "`r`n"

function Replace-Block($c, $old, $new, $name) {
    $idx = $c.IndexOf($old)
    if ($idx -ge 0) { Write-Host "OK: $name"; return $c.Replace($old, $new) }
    else { Write-Host "MISS: $name (not found)"; return $c }
}

# ============================================================
# 1. Add missing event classes before class EventTarget_
#    (PromiseRejectionEvent, FormDataEvent, DeviceMotionEvent, ViewTransition)
# ============================================================
$evtMarker = "  class EventTarget_ {"
$evtIdx = $content.IndexOf($evtMarker)
Write-Host "EventTarget_ idx: $evtIdx"
if ($evtIdx -ge 0) {
    $newClasses = @"
  // ── PromiseRejectionEvent (Chrome 49+) ────────────────────────────────────
  class PromiseRejectionEvent extends VEvent {
    promise: Promise<unknown>; reason: unknown;
    constructor(type: string, init: { promise: Promise<unknown>; reason: unknown; bubbles?: boolean; cancelable?: boolean }) {
      super(type, init); this.promise = init.promise; this.reason = init.reason;
    }
  }

  // ── FormDataEvent (Chrome 77+) ────────────────────────────────────────────
  class FormDataEvent extends VEvent {
    formData: FormData_;
    constructor(type: string, init: { formData: FormData_; bubbles?: boolean; cancelable?: boolean }) {
      super(type, init); this.formData = init.formData;
    }
  }

  // ── DeviceMotionEvent / DeviceOrientationEvent (sensor APIs) ─────────────
  class DeviceMotionEvent extends VEvent {
    acceleration: unknown = null; accelerationIncludingGravity: unknown = null;
    rotationRate: unknown = null; interval: number = 0;
    constructor(type: string, init?: any) { super(type, init); Object.assign(this, init ?? {}); }
    static requestPermission(): Promise<string> { return Promise.resolve('denied'); }
  }
  class DeviceOrientationEvent extends VEvent {
    alpha: number | null = null; beta: number | null = null; gamma: number | null = null; absolute: boolean = false;
    constructor(type: string, init?: any) { super(type, init); Object.assign(this, init ?? {}); }
    static requestPermission(): Promise<string> { return Promise.resolve('denied'); }
  }

  // ── ViewTransition (Chrome 111+) ──────────────────────────────────────────
  class ViewTransition_ {
    ready: Promise<void> = Promise.resolve();
    finished: Promise<void> = Promise.resolve();
    updateCallbackDone: Promise<void> = Promise.resolve();
    skipTransition(): void {}
  }

"@
    $content = $content.Insert($evtIdx, $newClasses.Replace("`n", "`r`n"))
    Write-Host "OK: event classes inserted"
}

# ============================================================
# 2. Add missing wins: IDB constructors, ViewTransition, PromiseRejectionEvent,
#    FormDataEvent, DeviceMotionEvent, getScreenDetails, windowControlsOverlay
# ============================================================
$winOld = "    ReadableStreamBYOBReader: ReadableStreamBYOBReader_," + $CR + "  };"
$winNew = "    ReadableStreamBYOBReader: ReadableStreamBYOBReader_," + $CR + $CR + "    // -- IDB constructors (for instanceof checks) --------------------------------" + $CR + "    IDBRequest: IDBRequest_," + $CR + "    IDBOpenDBRequest: IDBRequest_," + $CR + "    IDBDatabase: IDBDatabase_," + $CR + "    IDBTransaction: IDBTransaction_," + $CR + "    IDBObjectStore: IDBObjectStore_," + $CR + "    IDBCursor: Object," + $CR + "    IDBCursorWithValue: Object," + $CR + "    IDBIndex: Object," + $CR + $CR + "    // -- Additional event constructors ------------------------------------" + $CR + "    PromiseRejectionEvent," + $CR + "    FormDataEvent," + $CR + "    DeviceMotionEvent," + $CR + "    DeviceOrientationEvent," + $CR + $CR + "    // -- ViewTransition API -----------------------------------------------" + $CR + "    ViewTransition: ViewTransition_," + $CR + $CR + "    // -- Window Controls Overlay (Chrome 93+ PWA) -------------------------" + $CR + "    windowControlsOverlay: {" + $CR + "      visible: false," + $CR + "      getTitlebarAreaRect(): DOMRect_ { return new DOMRect_(0, 0, 0, 0); }," + $CR + "      ongeometrychange: null as any," + $CR + "      addEventListener(_t: string, _fn: unknown): void {}," + $CR + "      removeEventListener(_t: string, _fn: unknown): void {}," + $CR + "    }," + $CR + $CR + "    // -- Screen Details API (Chrome 100+) - multi-screen -------------------" + $CR + "    getScreenDetails(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'Not supported')); }," + $CR + $CR + "    // -- SVG / MathML element constructors (for instanceof) ---------------" + $CR + "    SVGElement: VElement," + $CR + "    SVGSVGElement: VElement," + $CR + "    SVGPathElement: VElement," + $CR + "    MathMLElement: VElement," + $CR + "  };"
$content = Replace-Block $content $winOld $winNew "win IDB/events/ViewTransition"

# ============================================================
# Write back
# ============================================================
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
Write-Host "DONE. Final size: $([System.IO.File]::ReadAllBytes($f).Length) bytes"
