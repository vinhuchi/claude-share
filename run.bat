@echo off
setlocal enabledelayedexpansion

echo Building claude-connect...
bun build --compile --outfile dist\claude-connect.exe claude-connect\index.ts --define "process.env.NODE_ENV=\"production\""
if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
)

echo.
echo Build succeeded: %~dp0dist\claude-connect.exe

set "DIST_PATH=%~dp0dist"

echo %PATH% | findstr /i /c:"!DIST_PATH!" >nul
if not errorlevel 1 (
    echo PATH already contains dist folder.
) else (
    for /f "skip=2 tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"
    if "!USER_PATH!"=="" (
        setx PATH "!DIST_PATH!" >nul
    ) else (
        setx PATH "!USER_PATH!;!DIST_PATH!" >nul
    )
    echo Added to PATH: !DIST_PATH!
    echo Open a new terminal to use claude-connect.
)

echo.
echo Done.
pause
