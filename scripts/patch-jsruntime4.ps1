param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "Initial: $($content.Length) chars"
$CR = "`r`n"

function Replace-Block($c, $old, $new, $name) {
    $idx = $c.IndexOf($old)
    if ($idx -ge 0) { Write-Host "OK: $name"; return $c.Replace($old, $new) }
    else { Write-Host "MISS: $name"; return $c }
}

# ============================================================
# 1. screen: add availLeft, availTop
# ============================================================
$old1 = "  var screen = {" + $CR + "    width: 1024, height: 768, availWidth: 1024, availHeight: 768," + $CR + "    colorDepth: 32, pixelDepth: 32,"
$new1 = "  var screen = {" + $CR + "    width: 1024, height: 768, availWidth: 1024, availHeight: 768," + $CR + "    availLeft: 0, availTop: 0," + $CR + "    colorDepth: 32, pixelDepth: 32,"
$content = Replace-Block $content $old1 $new1 "screen.availLeft/Top"

# ============================================================
# 2. ReadableStreamBYOBReader stub (before class EventTarget_)
#    Find the CSSRule_ block or another safe anchor near the stream classes
# ============================================================
$byobMarker = "  class ReadableStreamDefaultReader_ {"
$byobIdx = $content.IndexOf($byobMarker)
Write-Host "ReadableStreamDefaultReader_ idx: $byobIdx"
if ($byobIdx -ge 0) {
    # Add ReadableStreamBYOBReader right after ReadableStreamDefaultReader_
    # Find where it ends
    $end1 = $content.IndexOf($CR + "  class ", $byobIdx + 10)
    if ($end1 -ge 0) {
        $byobClass = $CR + "  // -- ReadableStreamBYOBReader (stub) --------------------------------" + $CR + "  class ReadableStreamBYOBReader_ {" + $CR + "    _reader: ReadableStreamDefaultReader_;" + $CR + "    constructor(stream: ReadableStream_) {" + $CR + "      this._reader = (stream as any).getReader ? (stream as any).getReader() : new ReadableStreamDefaultReader_(stream);" + $CR + "    }" + $CR + "    read(_view: ArrayBufferView): Promise<{ done: boolean; value: ArrayBufferView | undefined }> {" + $CR + "      return this._reader.read() as any;" + $CR + "    }" + $CR + "    cancel(_reason?: unknown): Promise<void> { return this._reader.cancel(_reason); }" + $CR + "    releaseLock(): void { this._reader.releaseLock(); }" + $CR + "    get closed(): Promise<void> { return this._reader.closed; }" + $CR + "  }"
        $content = $content.Insert($end1, $byobClass)
        Write-Host "OK: ReadableStreamBYOBReader_ inserted"
    }
}

# ============================================================
# 3. cookieStore API stub (add to navigator area, before navigator closing })
# ============================================================
$csMarker = "    // Media Session API (Chrome 57+)"
$csIdx = $content.IndexOf($csMarker)
Write-Host "mediaSession marker idx: $csIdx"
$cookieStub = "    // Cookie Store API (Chrome 87+)" + $CR + "    // cookieStore is a window-level global; also stub navigator.cookieEnabled is true above" + $CR + $CR
# cookieStore is on window, not navigator - add to win object instead
# We'll add it to the win object with the other globals

# ============================================================
# 4. Add window.cookieStore, navigator.gpu stub, ReadableStreamBYOBReader, Iterator.from in win
# ============================================================
$winOldMarker = "    // -- PerformanceEntry subclass constructors (instanceof checks) ------------" + $CR + "    PerformanceEntry: Object," + $CR + "    PerformanceMark: Object," + $CR + "    PerformanceMeasure: Object," + $CR + "    PerformanceResourceTiming: Object," + $CR + "    PerformanceNavigationTiming: Object," + $CR + "    PerformancePaintTiming: Object," + $CR + "    PerformanceLongTaskTiming: Object," + $CR + "    PerformanceEventTiming: Object," + $CR + "  };"
$winNewMarker = "    // -- PerformanceEntry subclass constructors (instanceof checks) ------------" + $CR + "    PerformanceEntry: Object," + $CR + "    PerformanceMark: Object," + $CR + "    PerformanceMeasure: Object," + $CR + "    PerformanceResourceTiming: Object," + $CR + "    PerformanceNavigationTiming: Object," + $CR + "    PerformancePaintTiming: Object," + $CR + "    PerformanceLongTaskTiming: Object," + $CR + "    PerformanceEventTiming: Object," + $CR + $CR + "    // -- Cookie Store API (Chrome 87+) -----------------------------------------" + $CR + "    cookieStore: {" + $CR + "      get(name: string): Promise<unknown> { return Promise.resolve(null); }," + $CR + "      getAll(_name?: string): Promise<unknown[]> { return Promise.resolve([]); }," + $CR + "      set(_name: string, _value?: string): Promise<void> { return Promise.resolve(); }," + $CR + "      delete(_name: string): Promise<void> { return Promise.resolve(); }," + $CR + "      onchange: null as any," + $CR + "      addEventListener(_t: string, _fn: unknown): void {}," + $CR + "      removeEventListener(_t: string, _fn: unknown): void {}," + $CR + "    }," + $CR + $CR + "    // -- WebGPU stub (Chrome 113+) -- not supported but stub for feature detect --" + $CR + "    // navigator.gpu is on navigator, handled below; this is for GPU types" + $CR + "    GPUValidationError: Object," + $CR + "    GPUOutOfMemoryError: Object," + $CR + "    GPUPipelineError: Object," + $CR + $CR + "    // -- ReadableStreamBYOBReader (Chrome 89+) ---------------------------------" + $CR + "    ReadableStreamBYOBReader: ReadableStreamBYOBReader_," + $CR + "  };"
$content = Replace-Block $content $winOldMarker $winNewMarker "win cookieStore/gpu/BYOB"

# ============================================================
# 5. navigator.gpu stub (add to navigator object via the mediaSession block)
# ============================================================
$navGpuOld = "    mediaSession: {" + $CR + "      metadata: null as any," + $CR + "      playbackState: 'none' as string," + $CR + "      setActionHandler(_action: string, _handler: unknown): void {}," + $CR + "      setPositionState(_state?: unknown): void {}," + $CR + "      setMicrophoneActive(_active: boolean): void {}," + $CR + "      setCameraActive(_active: boolean): void {}," + $CR + "    }," + $CR + "  };"
$navGpuNew = "    mediaSession: {" + $CR + "      metadata: null as any," + $CR + "      playbackState: 'none' as string," + $CR + "      setActionHandler(_action: string, _handler: unknown): void {}," + $CR + "      setPositionState(_state?: unknown): void {}," + $CR + "      setMicrophoneActive(_active: boolean): void {}," + $CR + "      setCameraActive(_active: boolean): void {}," + $CR + "    }," + $CR + "    // WebGPU Device API (Chrome 113+) -- stub for feature detection" + $CR + "    gpu: {" + $CR + "      requestAdapter(_opts?: unknown): Promise<null> { return Promise.resolve(null); }," + $CR + "      getPreferredCanvasFormat(): string { return 'bgra8unorm'; }," + $CR + "      wgslLanguageFeatures: new Set<string>()," + $CR + "    }," + $CR + "  };"
$content = Replace-Block $content $navGpuOld $navGpuNew "navigator.gpu"

# ============================================================
# 6. Iterator.from polyfill (add after Promise.try polyfill)
# ============================================================
$iterOld = "  // -- RTCPeerConnection stub"
$iterNew = "  // -- Iterator helpers (ES2025 Stage 3) polyfill" + $CR + "  if (typeof (Iterator as any).from !== 'function') {" + $CR + "    (Iterator as any).from = function from(iterable: Iterable<unknown>) {" + $CR + "      var iter = (iterable as any)[Symbol.iterator]();" + $CR + "      return iter;" + $CR + "    };" + $CR + "  }" + $CR + $CR + "  // -- RTCPeerConnection stub"
$content = Replace-Block $content $iterOld $iterNew "Iterator.from polyfill"

# ============================================================
# Write back
# ============================================================
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
Write-Host "DONE. Final size: $([System.IO.File]::ReadAllBytes($f).Length) bytes"
