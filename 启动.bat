@echo off
chcp 65001 >nul
title Claude 远程传输服务
cd /d "%~dp0"
if not exist "node_modules\marked" (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
)
node control.js start
pause
