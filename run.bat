@echo off
setlocal enabledelayedexpansion

rem ── Build ─────────────────────────────────────────────────────────────────────
echo Building claude-connect...
"%USERPROFILE%\.bun\bin\bun.exe" build --compile --outfile dist\claude-connect.exe claude-connect\index.ts --define "process.env.NODE_ENV=\"production\""
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Build succeeded: %~dp0dist\claude-connect.exe

rem ── Add dist to PATH (via PowerShell, no 1024-char limit) ────────────────────
set "DIST_PATH=%~dp0dist"
powershell -NoProfile -Command "$dist='%DIST_PATH%'; $cur=[Environment]::GetEnvironmentVariable('PATH','User'); if (($cur -split ';') -contains $dist) { Write-Host 'PATH already contains dist folder.' } else { [Environment]::SetEnvironmentVariable('PATH', ($cur + ';' + $dist), 'User'); Write-Host 'Added to PATH:' $dist; Write-Host 'Open a new terminal to use claude-connect.' }"

echo.
echo Done.
pause
