@echo off
setlocal enabledelayedexpansion

rem ── Choose output name ────────────────────────────────────────────────────────
echo Select output name:
echo   1) claude-connect.exe  (default)
echo   2) claude-dev.exe
echo   3) Custom name
echo.
set /p CHOICE="Choice [1]: "
if "!CHOICE!"=="" set CHOICE=1

if "!CHOICE!"=="1" (
  set EXE_NAME=claude-connect
) else if "!CHOICE!"=="2" (
  set EXE_NAME=claude-dev
) else if "!CHOICE!"=="3" (
  set /p EXE_NAME="Enter name (without .exe): "
  if "!EXE_NAME!"=="" set EXE_NAME=claude-connect
) else (
  set EXE_NAME=claude-connect
)

echo.
echo Building !EXE_NAME!.exe...

rem ── Build ─────────────────────────────────────────────────────────────────────
"%USERPROFILE%\.bun\bin\bun.exe" build --compile --outfile dist\!EXE_NAME!.exe claude-connect\index.ts --define "process.env.NODE_ENV=\"production\""
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Build succeeded: %~dp0dist\!EXE_NAME!.exe

rem ── Add dist to PATH (via PowerShell, no 1024-char limit) ────────────────────
set "DIST_PATH=%~dp0dist"
powershell -NoProfile -Command "$dist='%DIST_PATH%'; $cur=[Environment]::GetEnvironmentVariable('PATH','User'); if (($cur -split ';') -contains $dist) { Write-Host 'PATH already contains dist folder.' } else { [Environment]::SetEnvironmentVariable('PATH', ($cur + ';' + $dist), 'User'); Write-Host 'Added to PATH:' $dist; Write-Host 'Open a new terminal to use !EXE_NAME!.' }"

echo.
echo Done.
pause
