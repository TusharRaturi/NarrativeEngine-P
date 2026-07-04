@echo off
title Narrative Engine
cd /d "%~dp0"

REM ===== Pre-flight checks =====
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [STOP] Node.js is not installed on this computer.
    echo.
    echo This app needs Node.js to run. To install it:
    echo   1. Open your web browser and go to https://nodejs.org/
    echo   2. Download the "LTS" version (the green button)
    echo   3. Run the installer - just click Next through all the steps
    echo   4. Close this window and double-click
    echo      Start_Narrative_Engine.bat again
    echo.
    pause
    exit /b 1
)

REM Get clean Node version string (e.g. 22.14.0)
for /f "delims=" %%v in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%v"

REM Parse major and minor
for /f "tokens=1,2 delims=." %%a in ("%NODE_VERSION%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)

REM Remove leading zeros so 09 doesn't break comparison
if "%NODE_MAJOR:~0,1%"=="0" set "NODE_MAJOR=%NODE_MAJOR:~1%"
if "%NODE_MINOR:~0,1%"=="0" set "NODE_MINOR=%NODE_MINOR:~1%"

REM Compare against required 20.19.0
set "REQUIRED_MAJOR=20"
set "REQUIRED_MINOR=19"

REM If major is greater than required, we're fine
if %NODE_MAJOR% GTR %REQUIRED_MAJOR% goto :node_ok
REM If major equals required, check minor
if %NODE_MAJOR% EQU %REQUIRED_MAJOR% (
    if %NODE_MINOR% GEQ %REQUIRED_MINOR% goto :node_ok
)

REM Too old
echo.
echo [STOP] Your version of Node.js is too old for this app.
echo.
echo You have version %NODE_VERSION%. The app needs version 20.19 or newer.
echo.
echo To fix this:
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version (the green button)
echo   3. Run the installer - just click Next through all the steps
echo   4. Close this window and double-click
echo      Start_Narrative_Engine.bat again
echo.
echo --------------------------------------------
echo Already upgraded Node but the app still won't start?
echo --------------------------------------------
echo There is a second file in this folder called
echo "Repair_Narrative_Engine.bat". Double-click it
echo and it will fix the app's database file to match
echo your new Node version. It will:
echo   - Ask you to type YES before doing anything
echo   - NOT change your Node.js version
echo   - NOT delete your saved campaigns or data
echo   - NOT touch any other programs on your computer
echo You must open that file yourself - this window
echo will not do it for you.
echo.
pause
exit /b 1

:node_ok
echo Node %NODE_VERSION% detected - OK.
echo.

REM ===== Main flow (unchanged) =====
echo Installing dependencies...
call npm install
echo Starting the application...
start cmd /c "timeout /t 3 /nobreak > nul & start http://localhost:5173"
npm run dev
pause