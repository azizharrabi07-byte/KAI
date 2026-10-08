@echo off
rem Launch the UPSTREAM Coucou build with its own CDP port, so its viewport can be
rem measured and compared against KAI's on the same machine and display settings.
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
start "" "C:\Users\DELL\Desktop\coucou-source\windows\target\release\coucou.exe"
