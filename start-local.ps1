<#
  YT Autopilot - start the video studio + voice on this Windows PC.
  Your n8n (D:\n8n\start-n8n.bat) runs separately; this starts the two helpers it calls:
    kokoro  - free text-to-speech
    studio  - video renderer + stats dashboard on http://localhost:8000
  Right-click > "Run with PowerShell". Needs Docker Desktop running.
#>
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Rand([int]$n) { -join ((48..57) + (97..122) | Get-Random -Count $n | ForEach-Object { [char]$_ }) }
function Set-EnvValue([string]$text, [string]$key, [string]$value) {
    if ($text -match "(?m)^$key=") { return ($text -replace "(?m)^$key=.*$", "$key=$value") }
    return ($text.TrimEnd() + "`r`n$key=$value`r`n")
}
function Get-EnvValue([string]$key) {
    $line = (Get-Content .env) | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
    if ($line) { return $line.Substring($key.Length + 1).Trim() } else { return '' }
}

# 1. Docker check
$dockerOk = $false
try { docker info *> $null; $dockerOk = ($LASTEXITCODE -eq 0) } catch { $dockerOk = $false }
if (-not $dockerOk) {
    Write-Host "Docker Desktop is not running. Start it (or install from https://www.docker.com/products/docker-desktop/) and run this again." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

# 2. .env (first run)
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env" -ForegroundColor Green }
$envText = Get-Content .env -Raw
if (-not (Get-EnvValue 'DASHBOARD_TOKEN')) { $envText = Set-EnvValue $envText 'DASHBOARD_TOKEN' (Rand 24) }
if (-not (Get-EnvValue 'STUDIO_INTERNAL_URL')) { $envText = Set-EnvValue $envText 'STUDIO_INTERNAL_URL' 'http://127.0.0.1:8000' }
Set-Content .env $envText -NoNewline

if (-not (Get-EnvValue 'PEXELS_API_KEY') -and -not (Get-EnvValue 'PIXABAY_API_KEY')) {
    Write-Host "No stock-footage key yet. Free Pixabay key (instant): log in at https://pixabay.com/api/docs/ and copy the key shown there." -ForegroundColor Yellow
    $k = Read-Host "Paste your Pixabay API key (or press Enter to skip - videos will have a plain background)"
    if ($k) { $envText = Set-EnvValue (Get-Content .env -Raw) 'PIXABAY_API_KEY' $k.Trim(); Set-Content .env $envText -NoNewline }
}

# 3. This PC's Wi-Fi/LAN IP, so dashboard + download links also open on your phone (same Wi-Fi)
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
       Select-Object -First 1).IPAddress
if (-not $ip) { $ip = 'localhost' }
Set-Content .env (Set-EnvValue (Get-Content .env -Raw) 'LOCAL_HOST' $ip) -NoNewline

# 4. Start only the helpers (your own n8n stays as it is)
Write-Host "Starting Kokoro voice + video studio (first run downloads ~3 GB)..." -ForegroundColor Cyan
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build kokoro studio
if ($LASTEXITCODE -ne 0) { Read-Host "Something failed - see above. Press Enter to exit"; exit 1 }

Write-Host "Waiting for the studio to answer..."
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-RestMethod http://localhost:8000/health -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep 3 }
}
$token = Get-EnvValue 'DASHBOARD_TOKEN'
Write-Host ""
if ($ok) { Write-Host "Studio is running." -ForegroundColor Green } else { Write-Host "Studio not answering yet - check: docker compose logs studio" -ForegroundColor Yellow }
Write-Host "  Dashboard (this PC):  http://localhost:8000/dashboard?token=$token"
Write-Host "  Dashboard (phone):    http://$($ip):8000/dashboard?token=$token"
Write-Host "  Stop helpers:         docker compose -f docker-compose.yml -f docker-compose.local.yml stop kokoro studio"
Write-Host ""
Write-Host "Next: start n8n with D:\n8n\start-n8n.bat (the helpers restart automatically with Docker Desktop)."
Read-Host "Press Enter to close"
