@echo off
chcp 65001 >nul
cd /d "%~dp0"
node control.js stop
echo.
pause
