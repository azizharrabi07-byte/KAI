@echo off
rem EXPERIMENT: launch KAI with the device scale pinned to the window's real DPI,
rem to prove whether Windows' 130% text scale is what shrinks the CSS viewport.
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 --force-device-scale-factor=1.1042
start "" "C:\Users\DELL\Desktop\kai\app\target\release\kai.exe"
