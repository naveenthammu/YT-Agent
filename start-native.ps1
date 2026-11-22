<#
  YT Autopilot - start kokoro (voice) + studio (renderer) natively, no Docker.
  One-time setup:
    studio:  py -3.12 -m venv studio\.venv ; studio\.venv\Scripts\pip install -r studio\requirements.txt
    kokoro:  git clone https://github.com/remsky/Kokoro-FastAPI.git kokoro ; cd kokoro ;
             uv venv --python 3.12 .venv ; uv pip install -e ".[cpu]" ;
             uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
  Right-click > "Run with PowerShell". Each service opens in its own window; close it to stop.
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env - fill in a Pixabay/Pexels key." -ForegroundColor Yellow }
$cfg = @{}
foreach ($line in Get-Content .env) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
if (-not $cfg['DASHBOARD_TOKEN']) { Write-Host "Set DASHBOARD_TOKEN in .env first." -ForegroundColor Red; Read-Host "Enter to exit"; exit 1 }
$lan = if ($cfg['LOCAL_HOST']) { $cfg['LOCAL_HOST'] } else { 'localhost' }

# kokoro (port 8880)
$kokoro = Join-Path $root 'kokoro'
if (Test-Path "$kokoro\.venv") {
    $k = @"
`$env:PHONEMIZER_ESPEAK_LIBRARY='C:\Program Files\eSpeak NG\libespeak-ng.dll'
`$env:PYTHONUTF8='1'; `$env:USE_GPU='false'; `$env:PROJECT_ROOT='$kokoro'
`$env:PYTHONPATH='$kokoro;$kokoro\api'; `$env:MODEL_DIR='src/models'; `$env:VOICES_DIR='src/voices/v1_0'
`$env:WEB_PLAYER_PATH='$kokoro\web'
Set-Location '$kokoro'; uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port 8880
"@
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $k
} else {
    Write-Host "kokoro not installed (no $kokoro\.venv) - videos will fail at the voice step. See the setup lines at the top of this file." -ForegroundColor Yellow
}

# studio (port 8000)
$s = @"
`$env:DATA_DIR='$root\data'; `$env:MUSIC_DIR='$root\assets\music'
`$env:KOKORO_URL='http://localhost:8880'
`$env:PUBLIC_BASE_URL='http://${lan}:8000'; `$env:INTERNAL_BASE_URL='http://localhost:8000'
`$env:FONT_FILE='C:\Windows\Fonts\arialbd.ttf'; `$env:FONT_NAME='Arial'
`$env:PEXELS_API_KEY='$($cfg['PEXELS_API_KEY'])'; `$env:PIXABAY_API_KEY='$($cfg['PIXABAY_API_KEY'])'
`$env:DASHBOARD_TOKEN='$($cfg['DASHBOARD_TOKEN'])'; `$env:MEDIA_RETENTION_DAYS='$($cfg['MEDIA_RETENTION_DAYS'])'
`$env:PYTHONUNBUFFERED='1'
Set-Location '$root\studio'; .\.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 1300
"@
Start-Process powershell -ArgumentList '-NoExit', '-Command', $s

Write-Host "Waiting for the studio..."
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-RestMethod http://localhost:8000/health -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep 2 }
}
if ($ok) { Write-Host "Studio is running." -ForegroundColor Green } else { Write-Host "Studio not answering - check its window." -ForegroundColor Yellow }
Write-Host "  Dashboard: http://localhost:8000/dashboard?token=$($cfg['DASHBOARD_TOKEN'])"
Write-Host "Next: start n8n with D:\n8n\start-n8n.bat"
Read-Host "Press Enter to close"
