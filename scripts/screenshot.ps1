<# 
.SYNOPSIS
  Launch QEMU, wait for page load, take a screenshot, and exit.

.PARAMETER WaitFor
  Regex to wait for in serial log. Default: "layoutPage in"

.PARAMETER Delay
  Seconds to wait after marker match. Default: 3

.PARAMETER Timeout
  Max seconds to wait. Default: 90

.PARAMETER KeepRunning
  Don't kill QEMU after screenshot.

.EXAMPLE
  .\scripts\screenshot.ps1
  .\scripts\screenshot.ps1 -WaitFor "rerender.*done" -Delay 5
#>
param(
    [string]$WaitFor = "ruleIndex:",
    [int]$Delay = 5,
    [int]$Timeout = 120,
    [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

# Locate QEMU
$qemuExe = $null
$cmd = Get-Command "qemu-system-x86_64.exe" -ErrorAction SilentlyContinue
if ($cmd) {
    $qemuExe = $cmd.Source
} else {
    $tryPaths = @(
        "C:\Program Files\qemu\qemu-system-x86_64.exe",
        "C:\tools\qemu\qemu-system-x86_64.exe",
        "C:\qemu\qemu-system-x86_64.exe"
    )
    foreach ($p in $tryPaths) {
        if (Test-Path $p) { $qemuExe = $p; break }
    }
}
if (-not $qemuExe) {
    Write-Host "QEMU not found." -ForegroundColor Red
    exit 1
}

# Verify ISO
if (-not (Test-Path "build/jsos.iso")) {
    Write-Host "build/jsos.iso not found. Run 'npm run build' first." -ForegroundColor Red
    exit 1
}

# Create disk image if needed
if (-not (Test-Path "build/disk.img")) {
    Write-Host "Creating 4 GiB disk.img..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path "build" -Force | Out-Null
    $diskStream = [System.IO.File]::Create("$PWD\build\disk.img")
    $diskStream.SetLength(4294967296)
    $diskStream.Close()
}

# Clean output
New-Item -ItemType Directory -Path "test-output" -Force | Out-Null
Remove-Item "test-output\serial.log"     -ErrorAction SilentlyContinue
Remove-Item "test-output\screenshot.ppm" -ErrorAction SilentlyContinue
Remove-Item "test-output\screenshot.bmp" -ErrorAction SilentlyContinue
Remove-Item "test-output\screenshot.png" -ErrorAction SilentlyContinue
Remove-Item "test-output\qemu-err.log"   -ErrorAction SilentlyContinue

# Pick a free TCP port for QEMU monitor
$monitorPort = 55555
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $testPort = $monitorPort + $attempt
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $testPort)
        $listener.Start()
        $listener.Stop()
        $monitorPort = $testPort
        break
    } catch {
        continue
    }
}

Write-Host "Screenshot tool: monitor=tcp:$monitorPort" -ForegroundColor DarkGray
Write-Host "Waiting for: '$WaitFor' (timeout ${Timeout}s, then +${Delay}s paint delay)" -ForegroundColor Cyan

# Launch QEMU
$qemuArgs = @(
    "-cdrom", "build/jsos.iso",
    "-drive", "file=build/disk.img,format=raw,media=disk",
    "-boot", "order=d",
    "-m", "4G",
    "-no-reboot",
    "-display", "sdl",
    "-vga", "std",
    "-serial", "file:test-output/serial.log",
    "-monitor", "tcp:127.0.0.1:${monitorPort},server,nowait",
    "-netdev", "user,id=n0",
    "-device", "virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on"
)

$proc = Start-Process -FilePath $qemuExe -ArgumentList $qemuArgs -PassThru -RedirectStandardError "test-output\qemu-err.log"

Start-Sleep -Seconds 2

if ($proc.HasExited) {
    Write-Host "QEMU exited immediately (code $($proc.ExitCode))." -ForegroundColor Red
    exit 1
}

# Wait for page load marker in serial log
$deadline = (Get-Date).AddSeconds($Timeout)
$matched = $false
$linesShown = 0

while ((-not $proc.HasExited) -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 500

    if (-not (Test-Path "test-output\serial.log")) { continue }

    $all = Get-Content "test-output\serial.log" -ErrorAction SilentlyContinue
    if (-not $all) { continue }

    # Show new lines
    if ($all.Count -gt $linesShown) {
        $newLines = $all[$linesShown..($all.Count - 1)]
        foreach ($line in $newLines) {
            if ($line -match "FATAL|ERROR|THREW") {
                Write-Host $line -ForegroundColor Red
            } elseif ($line -match "showHTML|layoutPage|rerender") {
                Write-Host $line -ForegroundColor Green
            } else {
                Write-Host $line -ForegroundColor DarkGray
            }
        }
        $linesShown = $all.Count
    }

    # Check for marker
    $content = $all -join "`n"
    if ($content -match $WaitFor) {
        $matched = $true
        Write-Host "`n>>> Marker '$WaitFor' found! Waiting ${Delay}s for paint..." -ForegroundColor Yellow
        break
    }
}

if (-not $matched) {
    if ($proc.HasExited) {
        Write-Host "QEMU exited before marker was found." -ForegroundColor Red
    } else {
        Write-Host "Timeout (${Timeout}s) -- taking screenshot anyway." -ForegroundColor Yellow
    }
}

# Extra delay for rendering to complete
if (-not $proc.HasExited) {
    Start-Sleep -Seconds $Delay
}

# Take screenshot via QEMU monitor
if (-not $proc.HasExited) {
    Write-Host "Taking screenshot via QEMU monitor..." -ForegroundColor Cyan
    $ppmPath = (Resolve-Path "test-output").Path + "\screenshot.ppm"

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $monitorPort)
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $reader = New-Object System.IO.StreamReader($stream)

        # Read QEMU monitor banner
        Start-Sleep -Milliseconds 500
        while ($stream.DataAvailable) { $reader.ReadLine() | Out-Null }

        # Send screendump command
        $writer.WriteLine("screendump $ppmPath")
        $writer.Flush()
        Start-Sleep -Milliseconds 1000

        # Read response
        while ($stream.DataAvailable) {
            $line = $reader.ReadLine()
            if ($line) { Write-Host "  monitor: $line" -ForegroundColor DarkGray }
        }

        $writer.Close()
        $reader.Close()
        $client.Close()
    } catch {
        Write-Host "Failed to connect to QEMU monitor: $_" -ForegroundColor Red
    }

    # Convert PPM to PNG (manual parser -- System.Drawing can't read PPM)
    if (Test-Path $ppmPath) {
        $size = (Get-Item $ppmPath).Length
        Write-Host "Screenshot saved: screenshot.ppm ($([math]::Round($size/1024))KB)" -ForegroundColor Green

        try {
            Add-Type -AssemblyName System.Drawing
            $raw = [System.IO.File]::ReadAllBytes($ppmPath)

            # Parse PPM P6 header: "P6\nwidth height\nmaxval\n"
            $headerEnd = 0
            $nlCount = 0
            for ($i = 0; $i -lt [math]::Min($raw.Length, 256); $i++) {
                if ($raw[$i] -eq 0x0A) {
                    $nlCount++
                    if ($nlCount -eq 3) { $headerEnd = $i + 1; break }
                }
            }
            $headerStr = [System.Text.Encoding]::ASCII.GetString($raw, 0, $headerEnd)
            $headerLines = $headerStr.Trim() -split "`n"
            $dims = $headerLines[1].Trim() -split "\s+"
            $ppmW = [int]$dims[0]
            $ppmH = [int]$dims[1]

            Write-Host "  PPM: ${ppmW}x${ppmH}" -ForegroundColor DarkGray

            $bitmap = New-Object System.Drawing.Bitmap($ppmW, $ppmH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $bmpData = $bitmap.LockBits(
                (New-Object System.Drawing.Rectangle(0, 0, $ppmW, $ppmH)),
                [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
                [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
            )

            # PPM is RGB, BMP is BGR -- copy row by row with byte swap
            $stride = $bmpData.Stride
            $pixelData = $headerEnd
            for ($y = 0; $y -lt $ppmH; $y++) {
                $rowStart = $pixelData + ($y * $ppmW * 3)
                for ($x = 0; $x -lt $ppmW; $x++) {
                    $srcOff = $rowStart + ($x * 3)
                    $dstOff = ($y * $stride) + ($x * 3)
                    # RGB -> BGR
                    [System.Runtime.InteropServices.Marshal]::WriteByte($bmpData.Scan0, $dstOff + 0, $raw[$srcOff + 2])
                    [System.Runtime.InteropServices.Marshal]::WriteByte($bmpData.Scan0, $dstOff + 1, $raw[$srcOff + 1])
                    [System.Runtime.InteropServices.Marshal]::WriteByte($bmpData.Scan0, $dstOff + 2, $raw[$srcOff + 0])
                }
            }

            $bitmap.UnlockBits($bmpData)
            $pngPath = (Resolve-Path "test-output").Path + "\screenshot.png"
            $bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $bitmap.Dispose()
            $pngSize = (Get-Item $pngPath).Length
            Write-Host "Converted: screenshot.png ($([math]::Round($pngSize/1024))KB)" -ForegroundColor Green
        } catch {
            Write-Host "PPM-to-PNG conversion failed: $_" -ForegroundColor Yellow
            Write-Host "  (screenshot.ppm is still available)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "Screenshot file not found -- screendump may have failed." -ForegroundColor Red
    }
}

# Flush remaining serial output
if (Test-Path "test-output\serial.log") {
    $all = Get-Content "test-output\serial.log" -ErrorAction SilentlyContinue
    if ($all -and $all.Count -gt $linesShown) {
        $newLines = $all[$linesShown..($all.Count - 1)]
        foreach ($line in $newLines) { Write-Host $line -ForegroundColor DarkGray }
    }
}

# Kill QEMU
if ((-not $KeepRunning) -and (-not $proc.HasExited)) {
    Write-Host "Killing QEMU..." -ForegroundColor DarkGray
    $proc.Kill()
    Start-Sleep -Milliseconds 500
}

# Summary
Write-Host ""
Write-Host "=== Screenshot Summary ===" -ForegroundColor Cyan
if (Test-Path "test-output\screenshot.png") {
    Write-Host "  PNG: test-output\screenshot.png" -ForegroundColor Green
} elseif (Test-Path "test-output\screenshot.ppm") {
    Write-Host "  PPM: test-output\screenshot.ppm" -ForegroundColor Green
} else {
    Write-Host "  No screenshot captured." -ForegroundColor Red
}
if (Test-Path "test-output\serial.log") {
    Write-Host "  Log: test-output\serial.log" -ForegroundColor DarkGray
}
Write-Host ""
