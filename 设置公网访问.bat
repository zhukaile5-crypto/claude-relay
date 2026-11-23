@echo off
chcp 65001 >nul
title 设置公网访问
cd /d "%~dp0"
node setup-tunnel.js
pause
