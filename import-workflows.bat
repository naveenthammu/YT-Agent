@echo off
rem Imports (or updates) all workflows into your n8n at D:\n8n. Everything arrives inactive.
rem   .\workflows\autopilot  - 3 YT Autopilot workflows (free stack: studio + Kokoro + stock footage)
rem   .\workflows            - 6 MiniMax AI-video workflows (Shotstack + PostgreSQL, Shorts + Reels)
rem Run it while n8n is STOPPED. Re-running overwrites the workflows with the files in this repo
rem (your credentials are kept, but edits you made inside these workflows are replaced).

set N8N_USER_FOLDER=D:\n8n\data
set TEMP=D:\n8n\tmp
set TMP=D:\n8n\tmp
set npm_config_cache=D:\n8n\npm-cache

echo.
echo Make sure n8n is closed (close the start-n8n.bat window) before continuing.
pause

call "D:\n8n\app\node_modules\.bin\n8n.cmd" import:workflow --separate --input="%~dp0workflows\autopilot"
if errorlevel 1 goto failed
call "D:\n8n\app\node_modules\.bin\n8n.cmd" import:workflow --separate --input="%~dp0workflows"
if errorlevel 1 goto failed

echo.
echo Done. Start n8n again with D:\n8n\start-n8n.bat and open the "YT Autopilot" workflows.
pause
exit /b 0

:failed
echo.
echo Import failed - see the message above.
pause
exit /b 1
