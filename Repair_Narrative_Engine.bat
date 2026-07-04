@echo off
title Narrative Engine - Repair
cd /d "%~dp0"

echo ============================================
echo   Narrative Engine - Repair Tool
echo ============================================
echo.
echo This tool can fix two common problems that
echo stop the app from starting.
echo.
echo You might need this if:
echo   - You upgraded Node.js and the app stopped working
echo   - You see an error mentioning "NODE_MODULE_VERSION"
echo   - You see an error about "native binding", "rolldown",
echo     "Cannot find module", or "is not a valid Win32
echo     application"
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

REM ===== Menu =====
:menu
echo ============================================
echo   What kind of problem are you having?
echo ============================================
echo.
echo   1) Quick fix - rebuild the database file only
echo      Use this if you upgraded Node.js and the app
echo      stopped working with a "NODE_MODULE_VERSION"
echo      error. Takes 1-2 minutes. Keeps your current
echo      installed dependencies.
echo.
echo   2) Full clean reinstall - delete everything and
echo      start fresh
echo      Use this if the app won't start and you see
echo      errors about "native binding", "rolldown",
echo      "Cannot find module", "is not a valid Win32
echo      application", or anything else from Vite.
echo      Takes 3-5 minutes. Downloads all dependencies
echo      again.
echo.
echo   3) Cancel - don't change anything
echo.
set /p CHOICE="Type 1, 2, or 3 and press Enter: "
echo.

if "%CHOICE%"=="1" goto :quick_fix
if "%CHOICE%"=="2" goto :clean_reinstall
if "%CHOICE%"=="3" goto :cancel
echo You typed "%CHOICE%". Please type 1, 2, or 3.
echo.
goto :menu

:cancel
echo Cancelled. No changes were made to your computer.
echo You can run this file again any time.
echo.
pause
exit /b 0

REM ===== Option 1: Quick fix (rebuild better-sqlite3) =====
:quick_fix
echo ============================================
echo   Quick fix: rebuild the database file
echo ============================================
echo.
echo This will rebuild one internal file so it
echo matches your current Node version.
echo.
echo It will NOT change your Node.js version.
echo It will NOT delete your saved campaigns or data.
echo It will NOT touch any other programs on your computer.
echo.
echo This takes 1-2 minutes. A lot of text will scroll
echo by - that is normal, please do not close the window.
echo.
set /p CONFIRM="Type YES to continue, or any other key and Enter to cancel: "
if /i not "%CONFIRM%"=="YES" goto :user_cancelled

echo.
echo Starting the rebuild. Please wait...
echo.
call npm rebuild better-sqlite3
if errorlevel 1 goto :rebuild_failed

echo.
echo ============================================
echo   Quick fix complete!
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
echo   The quick fix did not finish.
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
echo Alternatively, try option 2 (Full clean reinstall)
echo from the menu - it may succeed without needing
echo the C++ Build Tools.
echo.
pause
exit /b 1

REM ===== Option 2: Full clean reinstall =====
:clean_reinstall
echo ============================================
echo   Full clean reinstall
echo ============================================
echo.
echo This will delete and re-download all of the
echo app's installed code files. This fixes problems
echo where the install was incomplete (a known npm bug).
echo.
echo This will do the following:
echo   - Delete the "node_modules" folder
echo     (all the app's installed code files -
echo      they will be re-downloaded automatically)
echo   - Delete "package-lock.json"
echo     (a small file that tracks which versions
echo      are installed)
echo   - Run "npm install" to download fresh copies
echo     of everything
echo.
echo This will NOT touch:
echo   - Your saved campaigns, characters, or lore
echo     (stored in the "data" folder)
echo   - Your API keys and settings
echo   - Your Node.js installation
echo   - Any other programs on your computer
echo.
echo Your data is completely safe.
echo.
echo This takes 3-5 minutes and downloads about
echo 200 MB. A lot of text will scroll by - that is
echo normal, please do not close the window.
echo.
set /p CONFIRM="Type YES to continue, or any other key and Enter to cancel: "
if /i not "%CONFIRM%"=="YES" goto :user_cancelled

echo.
echo ============================================
echo   Starting the clean reinstall.
echo   Please do not close this window.
echo ============================================
echo.

REM Step 1: delete node_modules
echo Deleting old installed files...
if exist "node_modules" (
    rmdir /s /q "node_modules"
    if exist "node_modules" (
        echo.
        echo [ERROR] Could not delete the "node_modules" folder.
        echo This usually means the app is still running, or
        echo an antivirus program is locking the files.
        echo.
        echo Please make sure the Narrative Engine app is
        echo fully closed, then run this repair again.
        echo.
        pause
        exit /b 1
    )
)

REM Step 2: delete package-lock.json
if exist "package-lock.json" del /q "package-lock.json"

REM Step 3: fresh install
echo.
echo Downloading and installing fresh copies...
echo This is the slowest step. Please be patient.
echo.
call npm install
if errorlevel 1 goto :reinstall_failed

echo.
echo ============================================
echo   Full clean reinstall complete!
echo ============================================
echo.
echo All dependencies have been reinstalled successfully.
echo.
echo Next step: double-click Start_Narrative_Engine.bat
echo (in this same folder) to start the app.
echo.
pause
exit /b 0

:reinstall_failed
echo.
echo ============================================
echo   The reinstall did not finish.
echo ============================================
echo.
echo This is usually a network problem - the
echo installer could not download some files.
echo.
echo To fix this:
echo   1. Check your internet connection
echo   2. Try again in a few minutes
echo   3. Run this repair file again and choose
echo      option 2
echo.
echo If it keeps failing, you may need to ask for
echo help - there may be a problem with your npm
echo setup or a temporary issue with the download
echo servers.
echo.
pause
exit /b 1

:user_cancelled
echo.
echo Cancelled. No changes were made to your computer.
echo You can run this file again any time.
echo.
pause
exit /b 0