# Boot JSOS headless, take timed screenshots via QEMU monitor, optionally
# navigate the browser to a second URL (Ctrl+L + typed keys), then kill.
param(
    [int]$BootWait = 45,
    [int]$Shots = 2,
    [int]$ShotGap = 8,
    [string]$Navigate = "",     # e.g. "example.com" — typed after first shots
    [int]$NavWait = 25          # seconds to wait after navigation
)

$qemu = "C:\Program Files\qemu\qemu-system-x86_64.exe"
New-Item -ItemType Directory -Path "test-output" -Force | Out-Null
Remove-Item "test-output\serial.log" -ErrorAction SilentlyContinue
Remove-Item "test-output\shot*.png" -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $qemu -ArgumentList @(
    "-accel", "whpx,kernel-irqchip=off", "-accel", "tcg",
    "-cdrom", "build/jsos.iso",
    "-drive", "file=build/disk.img,format=raw,media=disk",
    "-boot", "order=d",
    "-m", "4G",
    "-no-reboot",
    "-display", "none",
    "-vga", "std",
    "-serial", "file:test-output/serial.log",
    "-monitor", "tcp:127.0.0.1:45454,server,nowait",
    "-netdev", "user,id=n0",
    "-device", "virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on"
) -NoNewWindow -PassThru

Write-Host "Waiting ${BootWait}s for boot + page load..."
Start-Sleep -Seconds $BootWait

# Persistent monitor connection
$client = $null
$writer = $null
function Open-Monitor {
    $script:client = New-Object System.Net.Sockets.TcpClient("127.0.0.1", 45454)
    $script:writer = New-Object System.IO.StreamWriter($script:client.GetStream())
    $script:writer.AutoFlush = $true
    Start-Sleep -Milliseconds 300
}
function Send-Monitor([string]$cmd, [int]$delayMs = 120) {
    $script:writer.WriteLine($cmd)
    Start-Sleep -Milliseconds $delayMs
}
Open-Monitor

$shotNum = 0
function Take-Shot {
    $script:shotNum++
    $path = (Resolve-Path "test-output").Path + "\shot$script:shotNum.png"
    Send-Monitor ("screendump " + $path.Replace('\','/') + " -f png") 700
    Write-Host "screenshot $script:shotNum taken"
}

for ($i = 1; $i -le $Shots; $i++) {
    Take-Shot
    if ($i -lt $Shots) { Start-Sleep -Seconds $ShotGap }
}

if ($Navigate) {
    Write-Host "Navigating to $Navigate ..."
    Send-Monitor "sendkey ctrl-l" 400
    foreach ($ch in $Navigate.ToCharArray()) {
        $key = switch -CaseSensitive ([string]$ch) {
            "." { "dot" }
            "/" { "slash" }
            "-" { "minus" }
            ":" { "shift-semicolon" }
            default { ([string]$ch).ToLower() }
        }
        Send-Monitor "sendkey $key" 90
    }
    Send-Monitor "sendkey ret" 200
    Write-Host "Waiting ${NavWait}s for page load..."
    Start-Sleep -Seconds $NavWait
    Take-Shot
    Start-Sleep -Seconds 6
    Take-Shot
}

if (-not $proc.HasExited) { $proc.Kill() }
Write-Host "done"
