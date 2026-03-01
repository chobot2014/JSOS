param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
Write-Host "File size: $($content.Length) chars"

# ────────────────────────────────────────────────────────────────────────────
# 1. scheduler.wait()
# ────────────────────────────────────────────────────────────────────────────
$old1 = "    yield(): Promise<void> {`r`n      return new Promise<void>(resolve => setTimeout_(resolve, 0));`r`n    },`r`n  };"
$new1 = "    yield(): Promise<void> {`r`n      return new Promise<void>(resolve => setTimeout_(resolve, 0));`r`n    },`r`n    // scheduler.wait(ms) -- Chrome 124+`r`n    wait(ms: number): Promise<void> {`r`n      return new Promise<void>(resolve => setTimeout_(resolve, ms));`r`n    },`r`n  };"
$idx1 = $content.IndexOf($old1)
Write-Host "scheduler.wait idx: $idx1"
if ($idx1 -ge 0) { $content = $content.Replace($old1, $new1); Write-Host "Applied scheduler.wait" }

# ────────────────────────────────────────────────────────────────────────────
# 2. TaskController_ + documentPictureInPicture (before requestIdleCallback)
# ────────────────────────────────────────────────────────────────────────────
$idleMarker = "  // -- requestIdleCallback / cancelIdleCallback (item 545)"
$idleIdx = $content.IndexOf($idleMarker)
Write-Host "idleCallback idx: $idleIdx"
if ($idleIdx -lt 0) {
  # Try with em-dashes
  $idleMarker = "  // " + [char]0x2500 + [char]0x2500 + " requestIdleCallback"
  $idleIdx = $content.IndexOf($idleMarker)
  Write-Host "idle (unicode) idx: $idleIdx"
}
$taskBlock = @"
  // -- TaskController / TaskSignal (Prioritized Task Scheduling API) ---------
  class TaskController_ {
    _priority: string;
    signal: any;
    constructor(opts?: { priority?: string }) {
      this._priority = opts?.priority ?? 'user-visible';
      var self2 = this;
      this.signal = {
        get priority() { return self2._priority; },
        aborted: false,
        onprioritychange: null as any,
        addEventListener(_t: string, _fn: unknown): void {},
        removeEventListener(_t: string, _fn: unknown): void {},
      };
    }
    setPriority(priority: string): void { this._priority = priority; }
    abort(_reason?: unknown): void { this.signal.aborted = true; }
  }

  // -- documentPictureInPicture (Chrome 116+) --------------------------------
  var documentPictureInPicture = {
    requestWindow(_opts?: { width?: number; height?: number }): Promise<unknown> {
      return Promise.reject(new DOMException('NotSupportedError', 'NotSupportedError'));
    },
    window: null as unknown,
    onenter: null as unknown,
    addEventListener(_t: string, _fn: unknown): void {},
    removeEventListener(_t: string, _fn: unknown): void {},
  };

"@
# Insert the task block before the requestIdleCallback comment
if ($idleIdx -ge 0) {
  # Find the actual line start (character after previous \r\n)
  $insertPos = $idleIdx
  $content = $content.Insert($insertPos, $taskBlock.Replace("`n", "`r`n"))
  Write-Host "Inserted TaskController_ and documentPictureInPicture"
}

# ────────────────────────────────────────────────────────────────────────────
# 3. AbortSignal.timeout() -- fix to use setTimeout_ and DOMException
# ────────────────────────────────────────────────────────────────────────────
$oldAbort = "    static timeout(ms: number): AbortSignalImpl {`r`n      var s = new AbortSignalImpl();`r`n      setTimeout(() => s._abort(new Error('TimeoutError')), ms);`r`n      return s;`r`n    }"
$newAbort = "    static timeout(ms: number): AbortSignalImpl {`r`n      var s = new AbortSignalImpl();`r`n      setTimeout_(() => s._abort(new DOMException('TimeoutError', 'TimeoutError')), ms);`r`n      return s;`r`n    }"
$abortIdx = $content.IndexOf($oldAbort)
Write-Host "AbortSignal.timeout idx: $abortIdx"
if ($abortIdx -ge 0) { $content = $content.Replace($oldAbort, $newAbort); Write-Host "Fixed AbortSignal.timeout" }

# ────────────────────────────────────────────────────────────────────────────
# 4. Polyfills: Promise.allSettled, Array.fromAsync, Promise.try
#    (insert after Promise.any polyfill block)
# ────────────────────────────────────────────────────────────────────────────
$anyEnd = "  // Error.cause support"
$anyIdx = $content.IndexOf($anyEnd)
Write-Host "Error.cause idx: $anyIdx"
$polyfills = @"
  // Promise.allSettled (ES2020) polyfill
  if (typeof Promise.allSettled !== 'function') {
    (Promise as any).allSettled = function<T>(promises: Iterable<Promise<T>>) {
      var arr = Array.from(promises);
      return Promise.all(arr.map((p: Promise<T>) => Promise.resolve(p).then(
        (value: T) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      )));
    };
  }
  // Array.fromAsync (ES2024) polyfill
  if (typeof (Array as any).fromAsync !== 'function') {
    (Array as any).fromAsync = async function fromAsync(source: any, mapFn?: any): Promise<any[]> {
      var result: any[] = []; var i = 0;
      if (source && typeof source[Symbol.asyncIterator] === 'function') {
        for await (var item of source) { result.push(mapFn ? await mapFn(item, i++) : item); }
      } else {
        for (var item2 of source) { var resolved = await item2; result.push(mapFn ? await mapFn(resolved, i++) : resolved); }
      }
      return result;
    };
  }
  // Promise.try (ES2025) polyfill
  if (typeof (Promise as any).try !== 'function') {
    (Promise as any).try = function promiseTry(fn: () => any): Promise<any> {
      return new Promise((resolve, reject) => { try { resolve(fn()); } catch (e) { reject(e); } });
    };
  }
"@
if ($anyIdx -ge 0) {
  $content = $content.Insert($anyIdx, $polyfills.Replace("`n", "`r`n"))
  Write-Host "Inserted allSettled/fromAsync/Promise.try polyfills"
}

# ────────────────────────────────────────────────────────────────────────────
# Write back
# ────────────────────────────────────────────────────────────────────────────
[System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
$finalSize = [System.IO.File]::ReadAllBytes($f).Length
Write-Host "DONE. Final size: $finalSize bytes"
