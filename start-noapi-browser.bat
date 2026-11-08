@echo off
setlocal
title NOAPI browser launcher

rem ============================================================================
rem  NOAPI? - dedicated Brave instance with the NOAPI extension loaded for you.
rem
rem  - Own profile (%PROFILE%): your everyday Brave is not touched and does not
rem    need the extension. Log in to each AI site once in this profile.
rem  - The extension is loaded from extension\chrome on every start.
rem  - Background-tab throttling and "covered window" backgrounding are off.
rem  - Every site in SITES gets its OWN window: a background TAB is still hidden.
rem  Do NOT minimize these windows. Cover them with other apps or move them aside.
rem
rem  Put this file in the project folder (next to package.json), e.g. C:\NOAPI.
rem ============================================================================

rem ---- Settings you may edit --------------------------------------------------
rem Sites to open, one window each, separated by spaces. Add or remove as needed:
rem   set "SITES=https://chat.z.ai https://claude.ai"
set "SITES=https://chat.z.ai"

rem 1 = also start the bridge ("npm start") in its own window. Leave 0 if you
rem start it yourself or OpenCode starts it.
set "START_BRIDGE=0"

rem Extension folder (the one with manifest.json). Leave empty to auto-detect.
set "EXT="

set "PROFILE=%LocalAppData%\noapi-brave"
rem -----------------------------------------------------------------------------

if not defined EXT if exist "%~dp0extension\chrome\manifest.json" set "EXT=%~dp0extension\chrome"
if not defined EXT if exist "C:\NOAPI\extension\chrome\manifest.json" set "EXT=C:\NOAPI\extension\chrome"
if not defined EXT (
  echo Extension folder not found. Looked for extension\chrome\manifest.json next to this file
  echo and in C:\NOAPI. Set EXT at the top of this file to the folder holding manifest.json.
  pause
  exit /b 1
)

set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" set "BRAVE=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE%" (
  echo Brave not found. Edit the BRAVE path in this file.
  pause
  exit /b 1
)

set "FLAGS=--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,DisableLoadExtensionCommandLineSwitch"

if "%START_BRIDGE%"=="1" (
  if exist "%~dp0package.json" (
    echo Starting the bridge...
    start "NOAPI bridge" /d "%~dp0" cmd /k npm start
  ) else (
    echo START_BRIDGE=1 but package.json was not found next to this file; bridge not started.
  )
)

echo Extension : %EXT%
echo Profile   : %PROFILE%
echo Sites     : %SITES%

set "FIRST=1"
for %%U in (%SITES%) do (
  if defined FIRST (
    set "FIRST="
  ) else (
    rem the first window must be up before the next one is opened
    timeout /t 4 /nobreak >nul
  )
  start "" "%BRAVE%" --user-data-dir="%PROFILE%" --load-extension="%EXT%" %FLAGS% --new-window %%U
)

echo.
echo Done. Check brave://extensions: NOAPI should be listed and enabled.
timeout /t 6 >nul
endlocal