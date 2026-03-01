param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "Initial size: $($content.Length) chars"
$CR = "`r`n"

$old = "    requestIdleCallback," + $CR + "    cancelIdleCallback," + $CR + "    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v))," + $CR + "  };"
$new = "    requestIdleCallback," + $CR + "    cancelIdleCallback," + $CR + "    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v))," + $CR + $CR + "    // -- New event / media / speech constructors ---------------------------------" + $CR + "    ToggleEvent," + $CR + "    Highlight: Highlight_," + $CR + "    CloseWatcher: CloseWatcher_," + $CR + "    EyeDropper: EyeDropper_," + $CR + "    MediaStream: MediaStream_," + $CR + "    MediaStreamTrack: MediaStreamTrack_," + $CR + "    MediaRecorder: MediaRecorder_," + $CR + "    WebTransport: WebTransport_," + $CR + "    SpeechRecognition: SpeechRecognition_," + $CR + "    webkitSpeechRecognition: SpeechRecognition_," + $CR + "    SpeechGrammar: SpeechGrammar_," + $CR + "    SpeechGrammarList: SpeechGrammarList_," + $CR + "    webkitSpeechGrammarList: SpeechGrammarList_," + $CR + "    MediaMetadata: MediaMetadata_," + $CR + $CR + "    // -- Prioritized Task Scheduling / Picture-in-Picture -----------------------" + $CR + "    TaskController: TaskController_," + $CR + "    TaskPriorityChangeEvent: VEvent," + $CR + "    documentPictureInPicture," + $CR + $CR + "    // -- CSS rule constructors (additional) ------------------------------------" + $CR + "    CSSContainerRule: CSSContainerRule_," + $CR + "    CSSLayerBlockRule: CSSRule_," + $CR + "    CSSLayerStatementRule: CSSRule_," + $CR + $CR + "    // -- Launch Queue API (Chrome 98+) -----------------------------------------" + $CR + "    launchQueue: {" + $CR + "      _handlers: [] as any[]," + $CR + "      setConsumer(fn: (launchParams: unknown) => void): void { this._handlers = [fn]; }," + $CR + "    }," + $CR + $CR + "    // -- PerformanceEntry subclass constructors (instanceof checks) ------------" + $CR + "    PerformanceEntry: Object," + $CR + "    PerformanceMark: Object," + $CR + "    PerformanceMeasure: Object," + $CR + "    PerformanceResourceTiming: Object," + $CR + "    PerformanceNavigationTiming: Object," + $CR + "    PerformancePaintTiming: Object," + $CR + "    PerformanceLongTaskTiming: Object," + $CR + "    PerformanceEventTiming: Object," + $CR + "  };"

$idx = $content.IndexOf($old)
Write-Host "old idx: $idx"
if ($idx -ge 0) {
    $content = $content.Replace($old, $new)
    [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
    Write-Host "DONE. Final size: $([System.IO.File]::ReadAllBytes($f).Length) bytes"
} else {
    Write-Host "NOT FOUND - checking context..."
    $ri = $content.IndexOf("requestIdleCallback,")
    Write-Host "requestIdleCallback idx: $ri"
    if ($ri -ge 0) { Write-Host $content.Substring($ri, 200) }
}
