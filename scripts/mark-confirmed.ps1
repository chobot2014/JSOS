param([string]$file = "docs\1000-things.md")
$lines = Get-Content $file
$toConfirm = @(732,752,755,756,800,803,847,848,849,1154,1155,1156,1209)
$updated = 0
foreach ($n in $toConfirm) {
    $idx = $n - 1
    $l = $lines[$idx]
    if ($l -match '^(\d+)\. \[(P[0-3])\](.*)$') {
        $num = $Matches[1]; $prio = $Matches[2]; $rest = $Matches[3]
        $lines[$idx] = "$num. [$prio ?]$rest"
        $updated++
        Write-Host "Updated line $n`: $($lines[$idx].Substring(0,[Math]::Min(70,$lines[$idx].Length)))"
    }
}
$lines | Set-Content $file -Encoding UTF8
Write-Host "Total updated: $updated"
