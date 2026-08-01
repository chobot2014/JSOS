param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
$CR = "`r`n"

# Already have URLPattern: URLPattern_ from patch-jsruntime7.ps1? Check:
$idx = $content.IndexOf("    URLPattern: URLPattern_,")
Write-Host "URLPattern in win: $idx"

if ($idx -lt 0) {
    # Add before FileSystem stubs
    $old = "    // -- FileSystem API (for instanceof/feature detect) --------------------" + $CR + "    FileSystemHandle: Object,"
    $new = "    // -- URLPattern (Chrome 95+) ------------------------------------------" + $CR + "    URLPattern: URLPattern_," + $CR + $CR + "    // -- FileSystem API (for instanceof/feature detect) --------------------" + $CR + "    FileSystemHandle: Object,"
    $idx2 = $content.IndexOf($old)
    Write-Host "FileSystem marker idx: $idx2"
    if ($idx2 -ge 0) {
        $content = $content.Replace($old, $new)
        [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
        Write-Host "Done. Size: $([System.IO.File]::ReadAllBytes($f).Length)"
    } else {
        # Find AudioWorkletNode to insert after
        $awOld = "    AudioWorkletNode: AudioNode_," + $CR + "    OfflineAudioContext: AudioContext_,"
        $awIdx = $content.IndexOf($awOld)
        Write-Host "AudioWorkletNode idx: $awIdx"
        if ($awIdx -ge 0) {
            $awNew = "    AudioWorkletNode: AudioNode_," + $CR + "    OfflineAudioContext: AudioContext_," + $CR + "    URLPattern: URLPattern_,"
            $content = $content.Replace($awOld, $awNew)
            [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
            Write-Host "Done. Size: $([System.IO.File]::ReadAllBytes($f).Length)"
        } else { Write-Host "AudioWorkletNode not found either" }
    }
} else { Write-Host "URLPattern already in win" }
