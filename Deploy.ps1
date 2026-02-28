# Deploy.ps1 - Deploy seismometer server to remote Docker host via SSH
# Uses SSH connection details from root .env file

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

# Load .env from project root
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+?)\s*=\s*(.+)\s*$') {
            $key = $matches[1].Trim()
            $val = $matches[2].Trim()
            Set-Variable -Name $key -Value $val
        }
    }
} else {
    Write-Error "No .env file found at $envFile"
    exit 1
}

# SSH connection details (from .env)
$sshUser = $SSH_USER
$sshHost = $SSH_HOST
$sshKeyPath = $SSH_KEY_PATH

# Expand ~ in key path
if ($sshKeyPath -match '^~') {
    $sshKeyPath = $sshKeyPath -replace '^~', $env:USERPROFILE
}

# Remote deployment directory
$remoteDir = "/home/$sshUser/seismometer"

# ─── Firmware version ─────────────────────────────────────────────
# Bump this string whenever you build and deploy new firmware
$FIRMWARE_VERSION = "1.2.0"

# Source directory
$source = Join-Path $PSScriptRoot 'server'

Write-Host "============================================="
Write-Host " Seismometer Docker Deployment"
Write-Host "============================================="
Write-Host "SSH Target: $sshUser@$sshHost"
Write-Host "SSH Key:    $sshKeyPath"
Write-Host "Remote Dir: $remoteDir"
Write-Host "Source:     $source"
Write-Host "============================================="

# Test SSH connection
Write-Host "`nTesting SSH connection..."
ssh -i $sshKeyPath -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$sshUser@$sshHost" "echo 'SSH OK'"
if ($LASTEXITCODE -ne 0) {
    Write-Error "SSH connection failed!"
    exit 1
}
Write-Host "SSH connection successful."

# Create remote directory
Write-Host "`nCreating remote directory..."
ssh -i $sshKeyPath "$sshUser@$sshHost" "mkdir -p $remoteDir"

# Copy files via SCP
Write-Host "`nCopying server files..."
$filesToCopy = @(
    'server.js',
    'package.json',
    'Dockerfile',
    'docker-compose.yml',
    '.dockerignore'
)

foreach ($file in $filesToCopy) {
    $localFile = Join-Path $source $file
    if (Test-Path $localFile) {
        Write-Host "  Copying $file..."
        scp -i $sshKeyPath -o StrictHostKeyChecking=no "$localFile" "${sshUser}@${sshHost}:${remoteDir}/${file}"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to copy $file"
            exit 1
        }
    } else {
        Write-Warning "File not found: $localFile"
    }
}

# Copy frontend directory
Write-Host "`nCopying frontend files..."
ssh -i $sshKeyPath "$sshUser@$sshHost" "mkdir -p $remoteDir/frontend/src"
$frontendFiles = @(
    'frontend/package.json',
    'frontend/vite.config.js',
    'frontend/index.html',
    'frontend/src/main.jsx',
    'frontend/src/App.jsx',
    'frontend/src/App.css',
    'frontend/src/Admin.jsx',
    'frontend/src/Admin.css'
)

foreach ($file in $frontendFiles) {
    $localFile = Join-Path $source $file
    if (Test-Path $localFile) {
        Write-Host "  Copying $file..."
        scp -i $sshKeyPath -o StrictHostKeyChecking=no "$localFile" "${sshUser}@${sshHost}:${remoteDir}/${file}"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to copy $file"
            exit 1
        }
    }
}

# Deploy firmware binary (PlatformIO builds to .pio/build/nodemcuv2/firmware.bin)
$firmwareBin = Join-Path $PSScriptRoot '.pio\build\nodemcuv2\firmware.bin'
Write-Host "`n============================================="
Write-Host " Firmware Deploy"
Write-Host "============================================="
if (Test-Path $firmwareBin) {
    Write-Host "  Found firmware.bin - uploading v$FIRMWARE_VERSION..."
    ssh -i $sshKeyPath "$sshUser@$sshHost" "mkdir -p $remoteDir/firmware"

    # Upload the binary
    scp -i $sshKeyPath -o StrictHostKeyChecking=no "$firmwareBin" "${sshUser}@${sshHost}:${remoteDir}/firmware/firmware.bin"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to upload firmware.bin"
        exit 1
    }

    # Write firmware.json metadata alongside the binary
    $builtAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
    $fwJson = '{"version": "' + $FIRMWARE_VERSION + '", "built_at": "' + $builtAt + '"}'
    ssh -i $sshKeyPath "$sshUser@$sshHost" "echo '$fwJson' > $remoteDir/firmware/firmware.json"
    Write-Host "  Firmware v$FIRMWARE_VERSION deployed to server."
    Write-Host "  Devices will self-update on next heartbeat/reboot."
} else {
    Write-Host "  WARNING: No firmware.bin found at:"
    Write-Host "    $firmwareBin"
    Write-Host "  Build firmware in PlatformIO IDE (Ctrl+Alt+B) then re-run Deploy.ps1."
    Write-Host "  Continuing deploy without firmware update..."
    ssh -i $sshKeyPath "$sshUser@$sshHost" "mkdir -p $remoteDir/firmware"
}

# Build and deploy with Docker Compose
Write-Host "`nBuilding and starting Docker containers..."
ssh -i $sshKeyPath "$sshUser@$sshHost" "cd $remoteDir; docker compose down --remove-orphans 2>/dev/null; docker compose build --no-cache; docker compose up -d"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker deployment failed!"
    exit 1
}

# Wait a moment and check container status
Write-Host "`nWaiting for containers to start..."
Start-Sleep -Seconds 5

ssh -i $sshKeyPath "$sshUser@$sshHost" "docker ps --filter name=seismometer"

Write-Host "`n============================================="
Write-Host " Deployment Complete!"
Write-Host "============================================="
Write-Host " Dashboard:  http://${sshHost}:3000"
Write-Host "============================================="
Write-Host ""
