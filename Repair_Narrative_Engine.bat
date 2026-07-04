@echo off
title Narrative Engine - Repair
cd /d "%~dp0"

echo ============================================
echo   Narrative Engine - Repair Tool
echo ============================================
echo.
echo This tool fixes one common problem:
echo.
echo   The app's internal database file was built
echo   for an older version of Node.js (the software
echo   that runs this app). It needs to be rebuilt
echo   to match the version of Node you have now.
echo.
echo You might need this if:
echo   - You upgraded Node.js and the app stopped working
echo   - You see an error mentioning "NODE_MODULE_VERSION"
echo   - Start_Narrative_Engine.bat told you to run this
echo.
echo IMPORTANT: Before continuing, please make sure
echo the Narrative Engine app is fully closed:
echo   - Close any app windows
echo   - Close any black terminal/command windows that
echo     say "Narrative Engine" in the title bar
echo   - If you ran "npm run dev" in a terminal, close
echo     that terminal
echo.
echo ============================================
echo.

REM ===== Pre-flight: Node must be installed and new enough =====
where node >nul 2>nul
if errorlevel 1 (
    echo [STOP] Node.js is not installed on this computer.
    echo.
    echo To fix this:
    echo   1. Open your web browser and go to https://nodejs.org/
    echo   2. Download the "LTS" version (the green button)
    echo   3. Run the installer - just click Next through all the steps
    echo   4. Come back and double-click this file again
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%v"
for /f "tokens=1,2 delims=." %%a in ("%NODE_VERSION%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
if "%NODE_MAJOR:~0,1%"=="0" set "NODE_MAJOR=%NODE_MAJOR:~1%"
if "%NODE_MINOR:~0,1%"=="0" set "NODE_MINOR=%NODE_MINOR:~1%"

set "REQUIRED_MAJOR=20"
set "REQUIRED_MINOR=19"

if %NODE_MAJOR% GTR %REQUIRED_MAJOR% goto :node_ok
if %NODE_MAJOR% EQU %REQUIRED_MAJOR% (
    if %NODE_MINOR% GEQ %REQUIRED_MINOR% goto :node_ok
)

echo [STOP] Your Node.js is too old (version %NODE_VERSION%).
echo.
echo This app needs Node 20.19 or newer. This repair tool cannot help yet.
echo.
echo To fix this:
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version (the green button)
echo   3. Run the installer - just click Next through all the steps
echo   4. Come back and double-click this file again
echo.
pause
exit /b 1

:node_ok
echo Node %NODE_VERSION% detected - OK.
echo.

REM ===== Consent gate: explain what will happen, require YES =====
echo ============================================
echo   What this tool will do:
echo ============================================
echo.
echo   1. Run a repair command that rebuilds the
echo      app's database file to match your current
echo      Node version.
echo   2. This takes about 1 to 2 minutes. A lot of
echo      text will scroll by - that is normal,
echo      please do not close the window.
echo.
echo   What it will NOT do:
echo     - It will NOT change your Node.js version
echo     - It will NOT delete your saved campaigns
echo       or any of your data
echo     - It will NOT touch any other programs
echo       on your computer
echo     - It only fixes one internal file inside
echo       this app's folder
echo.
echo   If it fails, nothing harmful happens - it
echo   will simply tell you what went wrong and
echo   what to install.
echo.
echo ============================================
echo.
set /p CONFIRM="Type YES to continue, or press any other key and Enter to cancel: "
if /i not "%CONFIRM%"=="YES" (
    echo.
    echo Cancelled. No changes were made to your computer.
    echo You can run this file again any time.
    echo.
    pause
    exit /b 0
)

echo.
echo ============================================
echo   Starting the repair. Please do not close
echo   this window. This takes 1-2 minutes.
echo ============================================
echo.

REM ===== Rebuild better-sqlite3 =====
call npm rebuild better-sqlite3
if errorlevel 1 goto :rebuild_failed

echo.
echo ============================================
echo   Repair complete!
echo ============================================
echo.
echo The database file has been rebuilt for Node %NODE_VERSION%.
echo.
echo Next step: double-click Start_Narrative_Engine.bat
echo (in this same folder) to start the app.
echo.
pause
exit /b 0

:rebuild_failed
echo.
echo ============================================
echo   The repair did not finish.
echo ============================================
echo.
echo This usually means your computer is missing a
echo free piece of software called "C++ Build Tools"
echo that Windows needs to build the database file.
echo.
echo To install it:
echo.
echo   1. Open your web browser and go to:
echo      https://visualstudio.microsoft.com/
echo      visual-cpp-build-tools/
echo.
echo   2. Click "Download Build Tools" and run the
echo      installer.
echo.
echo   3. In the installer, look for a list of
echo      options on the right side. Tick the box
echo      that says:
echo      "Desktop development with C++"
echo      (it has a C++ icon next to it)
echo.
echo   4. Click "Install" at the bottom right.
echo      This is a large download (about 6 GB)
echo      and may take 15-30 minutes.
echo.
echo   5. When it finishes, come back and
echo      double-click this repair file again.
echo.
echo ============================================
echo.
pause
exit /b 1