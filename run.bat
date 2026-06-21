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

echo.
set /p ADD_PATH="Add dist folder to PATH? (y/n): "
if /i "%ADD_PATH%"=="y" (
    set "DIST_PATH=%~dp0dist"

    rem Check if already in PATH
    echo %PATH% | findstr /i /c:"!DIST_PATH!" >nul
    if not errorlevel 1 (
        echo Already in PATH.
    ) else (
        rem Add to user PATH permanently
        for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%B"
        if "!USER_PATH!"=="" (
            reg add "HKCU\Environment" /v PATH /t REG_EXPAND_SZ /d "!DIST_PATH!" /f >nul
        ) else (
            reg add "HKCU\Environment" /v PATH /t REG_EXPAND_SZ /d "!USER_PATH!;!DIST_PATH!" /f >nul
        )
        echo Added to user PATH: !DIST_PATH!
        echo (Restart terminals for changes to take effect)
    )
)

echo.
echo Done. Run: claude-connect --dir=^<folder^>
pause
