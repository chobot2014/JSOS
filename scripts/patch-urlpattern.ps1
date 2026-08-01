param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
$marker = "  class PromiseRejectionEvent extends VEvent {"
$idx = $content.IndexOf($marker)
Write-Host "idx: $idx"
if ($idx -ge 0) {
    $urlClass = "  // URLPattern (Chrome 95+)" + "`r`n" + "  class URLPattern_ {" + "`r`n" + "    hash: string = '*'; hostname: string = '*'; password: string = '*';" + "`r`n" + "    pathname: string = '*'; port: string = '*'; protocol: string = '*';" + "`r`n" + "    search: string = '*'; username: string = '*';" + "`r`n" + "    constructor(input?: string | Record<string,string>, _basePath?: string) {" + "`r`n" + "      if (typeof input === 'object' && input) { Object.assign(this, input); }" + "`r`n" + "    }" + "`r`n" + "    test(_input?: string | Record<string,string>): boolean { return false; }" + "`r`n" + "    exec(_input?: string | Record<string,string>): unknown { return null; }" + "`r`n" + "  }" + "`r`n`r`n"
    $newContent = $content.Insert($idx, $urlClass)
    [System.IO.File]::WriteAllText($f, $newContent, $utf8NoBom)
    Write-Host "Done. Size: $([System.IO.File]::ReadAllBytes($f).Length)"
} else { Write-Host "NOT FOUND" }
