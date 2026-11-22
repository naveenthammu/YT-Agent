@echo off
rem Imports (or updates) the 3 YT Autopilot workflows into your n8n at D:\n8n.
rem Run it while n8n is STOPPED. Re-running overwrites the workflows with the files in .\workflows
rem (your credentials are kept, but edits you made inside these 3 workflows are replaced).

set N8N_USER_FOLDER=D:\n8n\data
set TEMP=D:\n8n\tmp
set TMP=D:\n8n\tmp
set npm_config_cache=D:\n8n\npm-cache

echo.
echo Make sure n8n is closed (close the start-n8n.bat window) before continuing.
pause

call "D:\n8n\app\node_modules\.bin\n8n.cmd" import:workflow --separate --input="%~dp0workflows"
if errorlevel 1 (
  echo.
  echo Import failed - see the message above.
  pause
  exit /b 1
)

echo.
echo Done. Start n8n again with D:\n8n\start-n8n.bat and open "YT Autopilot" workflows.
pause
