@echo off
title Narrative Engine - Update
cd /d "%~dp0"

echo ============================================
echo   Narrative Engine - Update Tool
echo ============================================
echo.
echo This tool downloads the latest version of
echo the app from GitHub and updates the files
echo in this folder.
echo.
echo It will:
echo   - Download the newest app files
echo   - Update dependencies if needed
echo   - Leave your saved campaigns and settings
echo     untouched
echo.
echo IMPORTANT: Before continuing, please make
echo sure the Narrative Engine app is fully closed:
echo   - Close any app windows
echo   - Close any black terminal/command windows
echo     that say "Narrative Engine" in the title
echo   - If you ran "npm run dev" in a terminal,
echo     close that terminal
echo.
echo ============================================
echo.

REM ===== Pre-flight: is the app still running? =====
echo Checking whether the app is still running...
echo.
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo ============================================
    echo   [STOP] The app appears to still be running
    echo ============================================
    echo.
    echo Port 5173 (the app's port) is busy, which
    echo means the Narrative Engine is probably still
    echo open. Updating while it is running can cause
    echo file-lock errors on Windows and corrupt the
    echo update.
    echo.
    echo Please close the app completely:
    echo   - Close any browser tabs showing the app
    echo   - Close any black terminal/command windows
    echo     that say "Narrative Engine" in the title
    echo   - If you ran "npm run dev" in a terminal,
    echo     close that terminal
    echo.
    echo Then double-click this file again.
    echo.
    pause
    exit /b 1
)
echo No running instance detected - OK.
echo.

REM ===== Pre-flight: git must be installed =====
where git >nul 2>nul
if not errorlevel 1 goto :git_found

REM Fallback: Explorer sometimes spawns cmd with a stale PATH that
REM predates the Git install. Try the default install locations.
if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=%PATH%;C:\Program Files\Git\cmd"

where git >nul 2>nul
if not errorlevel 1 goto :git_found

if exist "C:\Program Files (x86)\Git\cmd\git.exe" set "PATH=%PATH%;C:\Program Files (x86)\Git\cmd"

where git >nul 2>nul
if not errorlevel 1 goto :git_found

echo [STOP] Git is not installed on this computer.
echo.
echo This updater needs Git to download updates.
echo Most users already have it from when they
echo first installed the app. If you do not:
echo.
echo   1. Open your web browser and go to
echo      https://git-scm.com/download/win
echo   2. Download and run the installer
echo      (just click Next through all steps)
echo   3. Close this window and double-click
echo      this file again
echo.
echo If you downloaded the app as a ZIP file
echo instead of cloning it, this updater will
echo not work - you will need to download the
echo newest ZIP from GitHub instead.
echo.
pause
exit /b 1

:git_found

REM ===== Pre-flight: this folder must be a git repo =====
if not exist ".git" (
    echo [STOP] This folder is not a Git repository.
    echo.
    echo This updater only works if the app was
    echo installed by cloning it from GitHub. If you
    echo downloaded it as a ZIP file, you cannot use
    echo this updater - download the newest ZIP from
    echo GitHub instead.
    echo.
    echo If you cloned the app but moved it to a new
    echo folder, that is fine - just make sure you
    echo are running this file from inside the app
    echo folder (the one that contains package.json).
    echo.
    pause
    exit /b 1
)

REM ===== Pre-flight: verify the git remote is official =====
echo Checking that this is the official app...
echo.
set "PULL_REMOTE="
for /f "tokens=1,2 delims= " %%a in ('git remote -v 2^>nul') do call :check_remote %%a %%b
if not defined PULL_REMOTE (
    echo ============================================
    echo   [STOP] Unrecognized download source
    echo ============================================
    echo.
    echo This folder's Git remote does not point to
    echo the official Sagesheep Narrative Engine
    echo repository. Updating from an unknown source
    echo could pull untrusted code.
    echo.
    echo If you are using a fork or a custom version,
    echo update it manually by running:
    echo   git pull
    echo   npm install
    echo.
    echo If you believe this is a mistake, re-clone
    echo the official app from:
    echo   https://github.com/Sagesheep/NarrativeEngine-P.git
    echo.
    pause
    exit /b 1
)
echo Official Sagesheep repository detected - OK.
echo.

REM ===== Check for uncommitted local changes =====
echo Checking your files for unsaved changes...
echo.
git update-index -q --refresh
git diff-index --quiet HEAD -- >nul 2>nul
if errorlevel 1 (
    echo ============================================
    echo   [WARNING] You have unsaved changes
    echo ============================================
    echo.
    echo Some files in this folder have been edited
    echo and are different from the original download.
    echo Updating now could overwrite your edits.
    echo.
    echo Common safe edits:
    echo   - Files inside the "data" folder
    echo     (your saved campaigns and settings)
    echo     These are NOT tracked by Git and will
    echo     never be touched by the update.
    echo   - Files inside the "Example_Setup" folder
    echo     that you copied and renamed
    echo.
    echo If the only changes listed below are inside
    echo "data" or are copies you made, it is safe
    echo to continue.
    echo.
    echo ---- Changed files ----
    git status --short
    echo -----------------------
    echo.
    set /p CONFIRM="Type YES to overwrite these edits and update, or any other key and Enter to cancel: "
    if /i not "%CONFIRM%"=="YES" goto :user_cancelled
    echo.
    echo Overwriting local edits and continuing...
    git checkout -- .
    echo.
)

REM ===== Pull the latest code =====
echo ============================================
echo   Downloading the latest version...
echo ============================================
echo.
git pull "%PULL_REMOTE%"
if errorlevel 1 goto :pull_failed

echo.
echo ============================================
echo   Download complete.
echo ============================================
echo.

REM ===== Sync dependencies =====
echo Running npm install to keep dependencies in sync...
echo (This is safe even if nothing changed - it just
echo checks and skips any work that is not needed.)
echo.
call npm install
if errorlevel 1 goto :install_failed
echo.

REM ===== Done =====
echo ============================================
echo   Update complete!
echo ============================================
echo.
echo Your app is now up to date. Your saved
echo campaigns and settings were not touched.
echo.
echo Next step: double-click Start_Narrative_Engine.bat
echo (in this same folder) to start the app.
echo.
pause
exit /b 0

:pull_failed
echo.
echo ============================================
echo   The download did not finish.
echo ============================================
echo.
echo This is usually one of two things:
echo.
echo   1. A network problem - check your internet
echo      connection and try again.
echo.
echo   2. A merge conflict - you edited files that
echo      the update also changed. If you are not
echo      sure what to keep, you can force the
echo      update by typing the following two
echo      commands in this window:
echo         git checkout -- .
echo         git pull
echo      This will overwrite ANY local edits to
echo      app files (but never your saved campaigns
echo      in the "data" folder).
echo.
pause
exit /b 1

:install_failed
echo.
echo ============================================
echo   Dependency update did not finish.
echo ============================================
echo.
echo The app code was updated, but "npm install"
echo failed. You can still try starting the app -
echo it may work with the old dependencies.
echo.
echo If it does not start, run Repair_Narrative_Engine.bat
echo (in this same folder) and choose option 2
echo (Full clean reinstall).
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

REM ===== Subroutine: mark the first Sagesheep remote as the pull source =====
:check_remote
echo %2 | findstr /i "Sagesheep/NarrativeEngine-P" >nul
if not errorlevel 1 if not defined PULL_REMOTE set "PULL_REMOTE=%1"
goto :eof