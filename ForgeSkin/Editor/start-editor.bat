@echo off
setlocal
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ForgeSkin] pnpm not found. Install Node.js and run: npm i -g pnpm
  pause
  exit /b 1
)

if not exist node_modules (
  echo [ForgeSkin] Installing dependencies...
  call pnpm install
  if errorlevel 1 (
    echo [ForgeSkin] pnpm install failed.
    pause
    exit /b 1
  )
)

echo [ForgeSkin] Starting editor (pnpm start)...
call pnpm start
if errorlevel 1 (
  echo.
  echo [ForgeSkin] Editor exited with an error.
  pause
)
