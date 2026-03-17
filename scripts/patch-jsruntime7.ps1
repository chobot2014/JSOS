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
# 1. Add navigator.storage.getDirectory (OPFS)
# ============================================================
$old1 = "    storage: {" + $CR + "      estimate(): Promise<{quota: number; usage: number}> { return Promise.resolve({ quota: 1024 * 1024 * 50, usage: 0 }); }," + $CR + "      persist(): Promise<boolean> { return Promise.resolve(false); }," + $CR + "      persisted(): Promise<boolean> { return Promise.resolve(false); }," + $CR + "    },"
$new1 = "    storage: {" + $CR + "      estimate(): Promise<{quota: number; usage: number}> { return Promise.resolve({ quota: 1024 * 1024 * 50, usage: 0 }); }," + $CR + "      persist(): Promise<boolean> { return Promise.resolve(false); }," + $CR + "      persisted(): Promise<boolean> { return Promise.resolve(false); }," + $CR + "      // Origin Private File System (OPFS) (Chrome 86+)" + $CR + "      getDirectory(): Promise<unknown> { return Promise.reject(new DOMException('NotSupportedError', 'OPFS not supported')); }," + $CR + "    },"
$content = Replace-Block $content $old1 $new1 "navigator.storage.getDirectory"

# ============================================================
# 2. Add URLPattern class before class EventTarget_
# ============================================================
$evtMarker = "  // -- PromiseRejectionEvent"
$evtIdx = $content.IndexOf($evtMarker)
Write-Host "PromiseRejectionEvent marker idx: $evtIdx"
if ($evtIdx -ge 0) {
    $urlPatternClass = @"
  // -- URLPattern (Chrome 95+) -----------------------------------------------
  class URLPattern_ {
    pattern: string;
    hash: string = '*'; hostname: string = '*'; password: string = '*';
    pathname: string = '*'; port: string = '*'; protocol: string = '*';
    search: string = '*'; username: string = '*';
    constructor(input?: string | { baseURL?: string; hash?: string; hostname?: string; password?: string; pathname?: string; port?: string; protocol?: string; search?: string; username?: string }, basePath?: string) {
      this.pattern = typeof input === 'string' ? input : (basePath ?? '');
      if (typeof input === 'object' && input) {
        this.hash = input.hash ?? '*'; this.hostname = input.hostname ?? '*';
        this.password = input.password ?? '*'; this.pathname = input.pathname ?? '*';
        this.port = input.port ?? '*'; this.protocol = input.protocol ?? '*';
        this.search = input.search ?? '*'; this.username = input.username ?? '*';
      }
    }
    test(_input?: string | { baseURL?: string; pathname?: string }): boolean { return false; }
    exec(_input?: string | { baseURL?: string; pathname?: string }): unknown { return null; }
  }

"@
    $content = $content.Insert($evtIdx, $urlPatternClass.Replace("`n", "`r`n"))
    Write-Host "OK: URLPattern_ class inserted"
}

# ============================================================
# 3. Add URLPattern to the win object (after AudioWorkletNode entry)
# ============================================================
$old3 = "    AudioWorkletNode: AudioNode_," + $CR + "    OfflineAudioContext: AudioContext_," + $CR + "  };"
$new3 = "    AudioWorkletNode: AudioNode_," + $CR + "    OfflineAudioContext: AudioContext_," + $CR + $CR + "    // -- URLPattern (Chrome 95+) ------------------------------------------" + $CR + "    URLPattern: URLPattern_," + $CR + $CR + "    // -- FileSystem API (for instanceof/feature detect) --------------------" + $CR + "    FileSystemHandle: Object," + $CR + "    FileSystemFileHandle: Object," + $CR + "    FileSystemDirectoryHandle: Object," + $CR + "    FileSystemWritableFileStream: Object," + $CR + "  };"
$content = Replace-Block $content $old3 $new3 "win URLPattern + FileSystem stubs"

# ============================================================
# Write back
# ============================================================
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
Write-Host "DONE. Final size: $([System.IO.File]::ReadAllBytes($f).Length) bytes"
