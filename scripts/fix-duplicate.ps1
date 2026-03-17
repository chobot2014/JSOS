param()
$f = "c:\DEV\JSOS\src\os\apps\browser\jsruntime.ts"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$content = [System.IO.File]::ReadAllText($f, $utf8NoBom)
$CR = "`r`n"

# Remove the duplicate URLPattern_ class
$duplicateBlock = "  // URLPattern (Chrome 95+)" + $CR + "  class URLPattern_ {" + $CR + "    hash: string = '*'; hostname: string = '*'; password: string = '*';" + $CR + "    pathname: string = '*'; port: string = '*'; protocol: string = '*';" + $CR + "    search: string = '*'; username: string = '*';" + $CR + "    constructor(input?: string | Record<string,string>, _basePath?: string) {" + $CR + "      if (typeof input === 'object' && input) { Object.assign(this, input); }" + $CR + "    }" + $CR + "    test(_input?: string | Record<string,string>): boolean { return false; }" + $CR + "    exec(_input?: string | Record<string,string>): unknown { return null; }" + $CR + "  }" + $CR + $CR + "  // URLPattern (Chrome 95+)"
$replacement = "  // URLPattern (Chrome 95+)"

$idx = $content.IndexOf($duplicateBlock)
Write-Host "duplicate at idx: $idx"
if ($idx -ge 0) {
    $content = $content.Replace($duplicateBlock, $replacement)
    [System.IO.File]::WriteAllText($f, $content, $utf8NoBom)
    Write-Host "Duplicate removed. Size: $([System.IO.File]::ReadAllBytes($f).Length)"
} else {
    Write-Host "Exact block not found, trying count..."
    $count = ($content.Split("class URLPattern_") | Measure-Object).Count - 1
    Write-Host "URLPattern_ occurrences: $count"
}
