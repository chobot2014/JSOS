param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "Initial: $($content.Length) chars"
$CR = "`r`n"

function Replace-Block($c, $old, $new, $name) {
    $idx = $c.IndexOf($old)
    if ($idx -ge 0) { Write-Host "OK: $name"; return $c.Replace($old, $new) }
    else { Write-Host "MISS: $name (idx=-1)"; return $c }
}

# ============================================================
# 1. audioWorklet - check if the VS Code buffer saved it
# ============================================================
$awIdx = $content.IndexOf("audioWorklet")
Write-Host "audioWorklet idx: $awIdx"

# ============================================================
# 2. Add Text, Comment, TreeWalker, NodeIterator, Selection, AudioWorkletNode
#    to win object (append before SVGElement block)
# ============================================================
$svgOld = "    // -- SVG / MathML element constructors (for instanceof) ---------------" + $CR + "    SVGElement: VElement," + $CR + "    SVGSVGElement: VElement," + $CR + "    SVGPathElement: VElement," + $CR + "    MathMLElement: VElement," + $CR + "  };"
$svgNew = "    // -- SVG / MathML element constructors (for instanceof) ---------------" + $CR + "    SVGElement: VElement," + $CR + "    SVGSVGElement: VElement," + $CR + "    SVGPathElement: VElement," + $CR + "    MathMLElement: VElement," + $CR + $CR + "    // -- DOM node constructors (for instanceof) ---------------------------" + $CR + "    Text: VNode," + $CR + "    CDATASection: VNode," + $CR + "    Comment: VNode," + $CR + "    Attr: Object," + $CR + "    NodeFilter: { SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 0x1, SHOW_TEXT: 0x4, SHOW_COMMENT: 0x80, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }," + $CR + "    TreeWalker: Object," + $CR + "    NodeIterator: Object," + $CR + "    Selection: Object," + $CR + $CR + "    // -- Audio Worklet (Chrome 66+) ----------------------------------------" + $CR + "    AudioWorkletNode: AudioNode_," + $CR + "    OfflineAudioContext: AudioContext_," + $CR + "  };"
$content = Replace-Block $content $svgOld $svgNew "win DOM+AudioWorklet"

# ============================================================
# 3. If audioWorklet is NOT in file (VS Code buffer issue), add it via PS
# ============================================================
if ($content.IndexOf("audioWorklet") -lt 0) {
    Write-Host "Adding audioWorklet to AudioContext_ via PS"
    $old3 = "    resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }" + $CR + "    suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }" + $CR + "    close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }" + $CR + "    getOutputTimestamp(): { contextTime: number; performanceTime: number } { return { contextTime: 0, performanceTime: 0 }; }" + $CR + "  }"
    $new3 = "    resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }" + $CR + "    suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }" + $CR + "    close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }" + $CR + "    getOutputTimestamp(): { contextTime: number; performanceTime: number } { return { contextTime: 0, performanceTime: 0 }; }" + $CR + "    // Audio Worklet (Chrome 66+)" + $CR + "    audioWorklet = { addModule(_url: string): Promise<void> { return Promise.resolve(); } };" + $CR + "  }"
    $content = Replace-Block $content $old3 $new3 "AudioContext_.audioWorklet"
} else {
    Write-Host "audioWorklet already present in file"
}

# ============================================================
# 4. OfflineAudioContext stub class before AudioContext_
# ============================================================
$offlineExists = $content.IndexOf("class OfflineAudioContext_")
if ($offlineExists -lt 0) {
    $acMarker = "  class AudioContext_ extends AudioNode_ {"
    $acIdx = $content.IndexOf($acMarker)
    if ($acIdx -ge 0) {
        $offlineClass = "  // -- OfflineAudioContext stub -----------------------------------------------" + $CR + "  class OfflineAudioContext_ extends AudioNode_ {" + $CR + "    length: number; numberOfChannels: number; sampleRate: number;" + $CR + "    constructor(channelsOrOpts: number | { numberOfChannels: number; length: number; sampleRate: number }, length?: number, sampleRate?: number) {" + $CR + "      super();" + $CR + "      if (typeof channelsOrOpts === 'object') {" + $CR + "        this.numberOfChannels = channelsOrOpts.numberOfChannels; this.length = channelsOrOpts.length; this.sampleRate = channelsOrOpts.sampleRate;" + $CR + "      } else { this.numberOfChannels = channelsOrOpts; this.length = length ?? 0; this.sampleRate = sampleRate ?? 44100; }" + $CR + "    }" + $CR + "    startRendering(): Promise<unknown> { return Promise.resolve(null); }" + $CR + "    resume(): Promise<void> { return Promise.resolve(); }" + $CR + "    suspend(_sec: number): Promise<void> { return Promise.resolve(); }" + $CR + "    createBuffer(_ch: number, _len: number, _sr: number): unknown { return null; }" + $CR + "  }" + $CR + $CR
        $content = $content.Insert($acIdx, $offlineClass)
        Write-Host "OK: OfflineAudioContext_ inserted"
    }
}

# ============================================================
# Write back
# ============================================================
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
Write-Host "DONE. Final size: $([System.IO.File]::ReadAllBytes($f).Length) bytes"
