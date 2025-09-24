# Test JSOS with QEMU on Windows
param(
    [switch]$Install
)

Write-Host "Testing JSOS with QEMU on Windows..." -ForegroundColor Green

# Check if build/jsos.iso exists
if (-not (Test-Path "build/jsos.iso")) {
    Write-Host "Error: build/jsos.iso not found. Run 'npm run build' first." -ForegroundColor Red
    exit 1
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

Write-Host "Starting JSOS in QEMU..." -ForegroundColor Green
Write-Host "Press Ctrl+Alt+G to release mouse/keyboard from QEMU window" -ForegroundColor Yellow
Write-Host "Press Alt+Ctrl+2 then type 'quit' to exit QEMU" -ForegroundColor Yellow
Write-Host "==================" -ForegroundColor Green

# Run QEMU with our ISO in a graphical window
Write-Host "Using QEMU at: $qemuExe" -ForegroundColor Green
& $qemuExe `
    -cdrom "build/jsos.iso" `
    -m 512M `
    -no-reboot
