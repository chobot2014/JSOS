# Test JSOS with QEMU on Windows
param(
    [switch]$Install,
    [switch]$Headless,
    [int]$Timeout = 60
)

if ($Headless) {
    Write-Host "Testing JSOS with QEMU (headless)..." -ForegroundColor Cyan
} else {
    Write-Host "Testing JSOS with QEMU on Windows..." -ForegroundColor Green
}

# Check if build/jsos.iso exists
if (-not (Test-Path "build/jsos.iso")) {
    Write-Host "Error: build/jsos.iso not found. Run 'npm run build' first." -ForegroundColor Red
    exit 1
}

# Create a blank 64 MiB disk image if one doesn't exist.
# JSOS will auto-format it as FAT16 on first boot.
if (-not (Test-Path "build/disk.img")) {
    Write-Host "Creating blank 4 GiB disk.img for persistent storage..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path "build" -Force | Out-Null
    $diskStream = [System.IO.File]::Create("$PWD\build\disk.img")
    $diskStream.SetLength(4294967296)   # 4 GiB — auto-formats as FAT32 on first boot
    $diskStream.Close()
    Write-Host "disk.img created (4 GiB sparse) - JSOS will format it as FAT32 on first boot." -ForegroundColor Cyan
}

# Check if QEMU is installed
$qemuPath = Get-Command "qemu-system-x86_64.exe" -ErrorAction SilentlyContinue

# Check common installation paths if not in PATH
$commonPaths = @(
    "C:\Program Files\qemu\qemu-system-x86_64.exe",
    "C:\tools\qemu\qemu-system-x86_64.exe",
    "C:\qemu\qemu-system-x86_64.exe"
)

$qemuExe = $null
if ($qemuPath) {
    $qemuExe = $qemuPath.Source
} else {
    foreach ($path in $commonPaths) {
        if (Test-Path $path) {
            $qemuExe = $path
            break
        }
    }
}

if (-not $qemuExe -or $Install) {
    Write-Host "QEMU not found or installation requested." -ForegroundColor Yellow
    Write-Host "Please install QEMU for Windows from: https://www.qemu.org/download/#windows" -ForegroundColor Yellow
    Write-Host "Or use Chocolatey: choco install qemu" -ForegroundColor Yellow
    Write-Host "Or use winget: winget install qemu.qemu" -ForegroundColor Yellow
    
    if ($Install) {
        # Try to install with winget
        Write-Host "Attempting to install QEMU with winget..." -ForegroundColor Yellow
        try {
            winget install qemu.qemu
            Write-Host "QEMU installation completed. Please restart your terminal and try again." -ForegroundColor Green
            exit 0
        }
        catch {
            Write-Host "Failed to install with winget. Please install manually." -ForegroundColor Red
            exit 1
        }
    }
    exit 1
}

Write-Host "Using QEMU at: $qemuExe" -ForegroundColor Green

if ($Headless) {
    # Headless mode: no GUI, serial output to stdout, auto-exit after timeout
    Write-Host "Running headless for ${Timeout}s (serial output below)..." -ForegroundColor Cyan
    Write-Host "==================" -ForegroundColor Cyan

    $proc = Start-Process -FilePath $qemuExe -ArgumentList @(
        "-cdrom", "build/jsos.iso",
        "-drive", "file=build/disk.img,format=raw,media=disk",
        "-boot", "order=d",
        "-m", "4G",
        "-no-reboot",
        "-display", "none",
        "-serial", "file:test-output/serial.log",
        "-netdev", "user,id=n0",
        "-device", "virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on"
    ) -NoNewWindow -PassThru -RedirectStandardError "test-output\qemu-err.log"

    $deadline = (Get-Date).AddSeconds($Timeout)
    while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (Test-Path "test-output\serial.log") {
            Get-Content "test-output\serial.log" -Tail 5 2>$null
        }
    }

    if (-not $proc.HasExited) {
        $proc.Kill()
        Write-Host "`n[Timeout after ${Timeout}s - QEMU killed]" -ForegroundColor Yellow
    }

    Write-Host "==================" -ForegroundColor Cyan
    if (Test-Path "test-output\serial.log") {
        Write-Host "Full serial log: test-output\serial.log" -ForegroundColor DarkGray
    }
    exit $proc.ExitCode
} else {
    # Interactive GUI mode
    Write-Host "Starting JSOS in QEMU..." -ForegroundColor Green
    Write-Host "Press Ctrl+Alt+G to release mouse/keyboard from QEMU window" -ForegroundColor Yellow
    Write-Host "Press Alt+Ctrl+2 then type 'quit' to exit QEMU" -ForegroundColor Yellow
    Write-Host "==================" -ForegroundColor Green

    & $qemuExe `
        -cdrom "build/jsos.iso" `
        -drive "file=build/disk.img,format=raw,media=disk" `
        -boot order=d `
        -m 4G `
        -no-reboot `
        -netdev "user,id=n0" `
        -device "virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,disable-modern=on"
}
