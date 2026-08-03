# Boot JSOS headless, take timed screenshots via QEMU monitor, then kill.
param([int]$BootWait = 45, [int]$Shots = 3, [int]$ShotGap = 8)

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

function Send-Monitor([string]$cmd) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient("127.0.0.1", 45454)
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $writer.AutoFlush = $true
        Start-Sleep -Milliseconds 300
        $writer.WriteLine($cmd)
        Start-Sleep -Milliseconds 700
        $client.Close()
    } catch { Write-Host "monitor error: $_" }
}

for ($i = 1; $i -le $Shots; $i++) {
    $path = (Resolve-Path "test-output").Path + "\shot$i.png"
    Send-Monitor ("screendump " + $path.Replace('\','/') + " -f png")
    Write-Host "screenshot $i taken"
    if ($i -lt $Shots) { Start-Sleep -Seconds $ShotGap }
}

if (-not $proc.HasExited) { $proc.Kill() }
Write-Host "done"
