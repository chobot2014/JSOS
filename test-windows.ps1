# Test JSOS with QEMU on Windows
param(
    [switch]$Install,
    [switch]$Automated,
    [int]$Timeout = 30
)

Write-Host "Testing JSOS with QEMU on Windows..." -ForegroundColor Green

# Check if build/jsos.iso exists
if (-not (Test-Path "build/jsos.iso")) {
    Write-Host "Error: build/jsos.iso not found. Run 'npm run build' first." -ForegroundColor Red
    exit 1
}

# Check ISO contents (basic check)
Write-Host "Checking ISO contents..." -ForegroundColor Yellow
try {
    # Try to read ISO as raw data and look for GRUB and kernel signatures
    $isoBytes = [System.IO.File]::ReadAllBytes("build/jsos.iso")
    $isoString = [System.Text.Encoding]::ASCII.GetString($isoBytes)
    $hasGrub = $isoString -match "GRUB"
    $hasMultiboot = $isoString -match "multiboot"
    Write-Host "ISO contains GRUB: $(if ($hasGrub) { 'YES' } else { 'NO' })" -ForegroundColor $(if ($hasGrub) { 'Green' } else { 'Red' })
    Write-Host "ISO contains multiboot: $(if ($hasMultiboot) { 'YES' } else { 'NO' })" -ForegroundColor $(if ($hasMultiboot) { 'Green' } else { 'Red' })
} catch {
    Write-Host "Warning: Could not analyze ISO contents" -ForegroundColor Yellow
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

# Create test output directory
$testDir = "test-output"
if (-not (Test-Path $testDir)) {
    New-Item -ItemType Directory -Path $testDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "$testDir\test_$timestamp.log"

if ($Automated) {
    Write-Host "Running automated test..." -ForegroundColor Green
    Write-Host "Timeout: $Timeout seconds" -ForegroundColor Yellow
    Write-Host "Log file: $logFile" -ForegroundColor Yellow
    Write-Host "==================" -ForegroundColor Green

    # Run QEMU in automated mode
    $qemuArgs = @(
        "-cdrom", "build/jsos.iso",
        "-m", "512M",
        "-no-reboot",
        "-nographic"
    )

    Write-Host "Starting QEMU..." -ForegroundColor Yellow
    $qemuProcess = Start-Process -FilePath $qemuExe -ArgumentList $qemuArgs -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError ($logFile + ".err")

    # Wait for timeout
    $startTime = Get-Date
    while (-not $qemuProcess.HasExited -and ((Get-Date) - $startTime).TotalSeconds -lt $Timeout) {
        Start-Sleep -Milliseconds 500
    }

    if (-not $qemuProcess.HasExited) {
        Write-Host "Timeout reached, terminating QEMU..." -ForegroundColor Yellow
        $qemuProcess.Kill()
        $qemuProcess.WaitForExit()
    }

    # Analyze results
    Write-Host "
Analyzing test results..." -ForegroundColor Green
    if (Test-Path $logFile) {
        $logContent = Get-Content $logFile -Raw
        
        # Check for various boot indicators
        $grubStarted = $logContent -match "GRUB"
        $kernelLoaded = $logContent -match "Multiboot"
        $systemBoot = $logContent -match "System boot complete|JSOS|Welcome to"
        $jsErrors = $logContent -match "SyntaxError|parse error|empty expression|ReferenceError|TypeError"
        
        Write-Host "GRUB Started: $(if ($grubStarted) { 'YES' } else { 'NO' })" -ForegroundColor $(if ($grubStarted) { 'Green' } else { 'Red' })
        Write-Host "Kernel Loaded: $(if ($kernelLoaded) { 'YES' } else { 'NO' })" -ForegroundColor $(if ($kernelLoaded) { 'Green' } else { 'Red' })
        Write-Host "System Boot: $(if ($systemBoot) { 'SUCCESS' } else { 'FAILED' })" -ForegroundColor $(if ($systemBoot) { 'Green' } else { 'Red' })
        Write-Host "JavaScript Errors: $(if ($jsErrors) { 'FOUND' } else { 'NONE' })" -ForegroundColor $(if ($jsErrors) { 'Red' } else { 'Green' })
        
        if ($jsErrors) {
            Write-Host "
JavaScript Errors:" -ForegroundColor Red
            ($logContent -split "`n") | Where-Object { $_ -match "SyntaxError|parse error|empty expression|ReferenceError|TypeError" } | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        }
        
        # Show last few lines for debugging
        Write-Host "
Last 10 lines of output:" -ForegroundColor Yellow
        ($logContent -split "`n") | Select-Object -Last 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }
    
    Write-Host "
Test completed. Log saved to: $logFile" -ForegroundColor Green

} else {
    Write-Host "Starting JSOS in QEMU..." -ForegroundColor Green
    Write-Host "Press Ctrl+Alt+G to release mouse/keyboard from QEMU window" -ForegroundColor Yellow
    Write-Host "Press Alt+Ctrl+2 then type 'quit' to exit QEMU" -ForegroundColor Yellow
    Write-Host "==================" -ForegroundColor Green

    # Run QEMU with our ISO in a graphical window
    Write-Host "Using QEMU at: $qemuExe" -ForegroundColor Green
    & $qemuExe -cdrom "build/jsos.iso" -m 512M -no-reboot
}
