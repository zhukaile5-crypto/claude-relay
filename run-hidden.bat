@echo off
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "ALL_PROXY=http://127.0.0.1:7897"
set "NO_PROXY=localhost,127.0.0.1,::1"
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
for %%A in (logs\relay.log) do if %%~zA GTR 5000000 move /y logs\relay.log logs\relay.old.log >nul
node server.js >> logs\relay.log 2>&1
if "%errorlevel%"=="2" exit /b
echo [%date% %time%] server exited, restarting in 5s >> logs\relay.log
ping -n 6 127.0.0.1 >nul
node tools\pinned-programs.cjs restore >> logs\relay.log 2>&1
goto loop
