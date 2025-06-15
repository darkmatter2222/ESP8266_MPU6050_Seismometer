# Deploy.ps1 - copies server directory to remote UNC path

param([switch]$Bypassed)

if (-not $Bypassed) {
    Write-Host "Re-launching script with ExecutionPolicy Bypass..."
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @(
            '-ExecutionPolicy','Bypass',
            '-NoProfile',
            '-File',$PSCommandPath,
            '-Bypassed'
        ) `
        -Wait
    exit
}

# Determine source and destination
$source      = Join-Path $PSScriptRoot 'server'
$destination = '\\192.168.86.48\Users\ryans\source\repos\earthquakeDetector'

Write-Host "Deploying from '$source' to '$destination'..."

# Create destination if it doesn't exist
if (-not (Test-Path $destination)) {
    Write-Host "Destination not found, creating directory..."
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
}

# Copy all files and subdirectories
Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse -Force

Write-Host "Deployment complete."
