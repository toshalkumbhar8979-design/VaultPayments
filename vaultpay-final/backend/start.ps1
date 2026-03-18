# VaultPay Backend Starter
# Run from the backend folder: .\start.ps1

# Known Node 20 paths (set by nvm-windows)
$nodePaths = @(
    "C:\nvm4w\nodejs\node.exe",
    "C:\Users\tosha\AppData\Local\nvm\v20.20.1\node.exe",
    "$([System.Environment]::GetEnvironmentVariable('NVM_HOME','Machine'))\v20.20.1\node.exe"
)

$nodeExe = $nodePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $nodeExe) {
    Write-Error "Could not find Node.js. Please open a new terminal and run: nvm use 20"
    exit 1
}

# Kill any existing process on port 5000
$portInUse = netstat -ano | findstr ":5000 " | Select-Object -First 1
if ($portInUse) {
    $pid5000 = ($portInUse -split '\s+' | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
    if ($pid5000) {
        Write-Host "Stopping existing process on port 5000 (PID: $pid5000)..." -ForegroundColor Yellow
        Stop-Process -Id $pid5000 -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
}

Write-Host "Using Node: $nodeExe" -ForegroundColor Cyan
Write-Host "Version: $( & $nodeExe --version )" -ForegroundColor Green
Write-Host "Starting VaultPay backend on port 5000..." -ForegroundColor Green
Write-Host ""

& $nodeExe server.js
