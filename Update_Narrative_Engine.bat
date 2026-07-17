@echo off
title Narrative Engine - Update

REM ============================================================
REM Self-copy guard: git pull can overwrite THIS .bat file while
REM it is running. When that happens, cmd loses its place in the
REM file and the window closes silently (pause never runs).
REM To prevent that, we copy this script to a temp file and run
REM from there, passing the real app folder as an argument.
REM ============================================================
if "%~1"=="__tempcopy__" (
    set "APP_DIR=%~2"
    goto :begin
)
set "TEMP_BAT=%TEMP%\narrative_engine_updater_tmp.bat"
copy /y "%~f0" "%TEMP_BAT%" >nul 2>nul
if exist "%TEMP_BAT%" (
    "%TEMP_BAT%" __tempcopy__ "%~dp0"
    REM exit /b with no code passes through the temp copy's exit
    REM code; %errorlevel% here would expand before the copy runs.
    exit /b
)

:begin
if not defined APP_DIR set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

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
REM Checks both the frontend (5173) and backend server (3001)
REM ports. The [^0-9] guard stops ":5173" from also matching
REM ports like 15173 or 51737.
echo Checking whether the app is still running...
echo.
netstat -ano | findstr /r ":5173[^0-9]" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto :app_still_running
netstat -ano | findstr /r ":3001[^0-9]" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 goto :app_still_running
echo No running instance detected - OK.
echo.
goto :app_check_done

:app_still_running
echo ============================================
echo   [STOP] The app appears to still be running
echo ============================================
echo.
echo One of the app's ports (5173 or 3001) is busy,
echo which means the Narrative Engine is probably
echo still open. Updating while it is running can
echo cause file-lock errors on Windows and corrupt
echo the update.
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

:app_check_done

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
REM NOTE: goto-based on purpose. An unescaped ) inside an echo line
REM ends a parenthesized if-block early and corrupts the script, so
REM message text with parentheses must live outside ( ) blocks.
if exist ".git" goto :repo_ok

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

:repo_ok

REM ===== Pre-flight: npm must be available =====
where npm >nul 2>nul
if not errorlevel 1 goto :npm_found

REM Fallback: Explorer sometimes spawns cmd with a stale PATH that
REM predates the Node.js install. Try the default install location.
if exist "C:\Program Files\nodejs\npm.cmd" set "PATH=%PATH%;C:\Program Files\nodejs\"

where npm >nul 2>nul
if not errorlevel 1 goto :npm_found

echo [STOP] Node.js was not found on this computer.
echo.
echo This updater needs Node.js to refresh the app's
echo dependencies after downloading the update.
echo.
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version - the green button
echo   3. Run the installer - just click Next through all steps
echo   4. Come back and double-click this file again
echo.
pause
exit /b 1

:npm_found

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
REM NOTE: this section must stay goto-based, NOT a parenthesized
REM if-block. Inside a ( ) block, %CONFIRM% expands when the block
REM is parsed - before set /p runs - so the YES check would always
REM see an empty string and always cancel.
git update-index -q --refresh
git diff-index --quiet HEAD -- >nul 2>nul
if not errorlevel 1 goto :worktree_clean

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
set "CONFIRM="
set /p CONFIRM="Type YES to overwrite these edits and update, or any other key and Enter to cancel: "
if /i not "%CONFIRM%"=="YES" goto :user_cancelled
echo.
echo Overwriting local edits and continuing...
REM reset --hard also discards staged (git add-ed) edits, which
REM checkout -- . would silently leave behind. Untracked files
REM like the data folder are never touched by either.
git reset --hard
echo.

:worktree_clean

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

REM ===== Build the local engine package =====
REM The app imports @narrative/engine from packages/engine, whose
REM compiled dist/ output is git-ignored. npm install does not
REM reliably rebuild an already-linked local package, so without
REM this step the app can fail on startup with:
REM   Failed to resolve import "@narrative/engine"
if not exist "packages\engine\package.json" goto :engine_done
echo Building the game engine...
echo.
call npm run build --prefix packages/engine
if errorlevel 1 goto :engine_build_failed
if not exist "packages\engine\dist\index.js" goto :engine_build_failed
echo.
echo Engine build complete - OK.
echo.
:engine_done

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
echo         git reset --hard
echo         git pull
echo      This will overwrite ANY local edits to
echo      app files (but never your saved campaigns
echo      in the "data" folder).
echo.
pause
exit /b 1

:engine_build_failed
echo.
echo ============================================
echo   The engine build did not finish.
echo ============================================
echo.
echo The app files were downloaded, but one part
echo of the app - the game engine - could not be
echo compiled. The app will not start until this
echo is fixed - you would see an error mentioning
echo "@narrative/engine" if you tried.
echo.
echo Your saved campaigns and settings are safe.
echo.
echo What to do:
echo   1. Run this updater again - this can be a
echo      one-off problem.
echo   2. If it fails again, take a screenshot or
echo      photo of ALL the text in this window -
echo      especially any lines containing the word
echo      "error" - and send it to support.
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

REM ===== Safety net: if execution ever falls through
REM      to here (should not happen), still pause so the
REM      user can read the output before the window
REM      closes.
REM =====
echo.
echo ============================================
echo   Script ended unexpectedly.
echo ============================================
echo.
echo Please take a screenshot of this window and
echo report it, then close this window.
echo.
pause
exit /b 1

REM ===== Subroutine: mark the first Sagesheep remote as the pull source =====
:check_remote
echo %2 | findstr /i "Sagesheep/NarrativeEngine-P" >nul
if not errorlevel 1 if not defined PULL_REMOTE set "PULL_REMOTE=%1"
goto :eof