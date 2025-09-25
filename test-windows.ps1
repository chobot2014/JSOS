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
$screenshotFile = "$testDir\screenshot_$timestamp.ppm"

if ($Automated) {
    Write-Host "Running automated test..." -ForegroundColor Green
    Write-Host "Timeout: $Timeout seconds" -ForegroundColor Yellow
    Write-Host "Log file: $logFile" -ForegroundColor Yellow
    Write-Host "Screenshot: $screenshotFile" -ForegroundColor Yellow
    Write-Host "==================" -ForegroundColor Green

    # Run QEMU in automated mode
    $qemuArgs = @(
        "-cdrom", "build/jsos.iso",
        "-m", "512M",
        "-no-reboot",
        "-nographic",
        "-monitor", "telnet:127.0.0.1:4444,server,nowait"
    )

    Write-Host "Starting QEMU..." -ForegroundColor Yellow
    $qemuProcess = Start-Process -FilePath $qemuExe -ArgumentList $qemuArgs -NoNewWindow -PassThru

    # Wait for QEMU to start
    Start-Sleep -Seconds 3

    # Try to connect to monitor and check status
    try {
        $tcpClient = New-Object System.Net.Sockets.TcpClient
        $tcpClient.Connect("127.0.0.1", 4444)
        $stream = $tcpClient.GetStream()
        $reader = New-Object System.IO.StreamReader $stream
        $writer = New-Object System.IO.StreamWriter $stream

        # Send info command to check if QEMU is responsive
        $writer.WriteLine("info status")
        $writer.Flush()
        Start-Sleep -Milliseconds 500

        $response = $reader.ReadLine()
        Write-Host "QEMU Monitor Response: $response" -ForegroundColor Cyan

        $tcpClient.Close()
    } catch {
        Write-Host "Could not connect to QEMU monitor: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # Wait for timeout
    $timeoutReached = $false
    $startTime = Get-Date
    while (-not $qemuProcess.HasExited -and ((Get-Date) - $startTime).TotalSeconds -lt $Timeout) {
        Start-Sleep -Milliseconds 500
    }

    if (-not $qemuProcess.HasExited) {
        $timeoutReached = $true
        Write-Host "Timeout reached, terminating QEMU..." -ForegroundColor Yellow
        $qemuProcess.Kill()
        $qemuProcess.WaitForExit()
    }
        Start-Sleep -Milliseconds 500
    }

    if (-not $qemuProcess.HasExited) {
        $timeoutReached = $true
        Write-Host "Timeout reached, terminating QEMU..." -ForegroundColor Yellow
        $qemuProcess.Kill()
        $qemuProcess.WaitForExit()
    }

    # Analyze the log output
    Write-Host "`nAnalyzing test results..." -ForegroundColor Green
    Write-Host "==================" -ForegroundColor Green

    if (Test-Path $logFile) {
        $logContent = Get-Content $logFile -Raw

        # Check for boot success
        $bootSuccess = $logContent -match "System boot complete"
        $jsErrors = $logContent -match "SyntaxError|parse error|empty expression"
        $panicErrors = $logContent -match "panic|fatal error"

        Write-Host "Boot Status: $(if ($bootSuccess) { 'SUCCESS' } else { 'FAILED' })" -ForegroundColor $(if ($bootSuccess) { 'Green' } else { 'Red' })
        Write-Host "JavaScript Errors: $(if ($jsErrors) { 'FOUND' } else { 'NONE' })" -ForegroundColor $(if ($jsErrors) { 'Red' } else { 'Green' })
        Write-Host "System Panics: $(if ($panicErrors) { 'FOUND' } else { 'NONE' })" -ForegroundColor $(if ($panicErrors) { 'Red' } else { 'Green' })

        if ($jsErrors) {
            Write-Host "`nJavaScript Errors Found:" -ForegroundColor Red
            $errorLines = ($logContent -split "`n") | Where-Object { $_ -match "SyntaxError|parse error|empty expression" }
            $errorLines | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        }

        if ($panicErrors) {
            Write-Host "`nSystem Panics Found:" -ForegroundColor Red
            $panicLines = ($logContent -split "`n") | Where-Object { $_ -match "panic|fatal error" }
            $panicLines | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        }

        # Show last 20 lines of log
        Write-Host "`nLast 20 lines of log:" -ForegroundColor Yellow
        $lines = $logContent -split "`n"
        $lastLines = $lines | Select-Object -Last 20
        $lastLines | ForEach-Object { Write-Host "  $_" }

    } else {
        Write-Host "No log file generated!" -ForegroundColor Red
    }

    Write-Host "`nTest completed. Full log saved to: $logFile" -ForegroundColor Green

} else {
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
}
