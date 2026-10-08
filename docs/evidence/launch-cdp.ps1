# Launch KAI with the WebView2 debug port open, for CDP-driven evidence.
#
# The port is injected through the environment, not baked into the build:
# nothing that ships carries an open debugging port.
#
#   powershell -File launch-cdp.ps1
#   (then) curl -s http://127.0.0.1:9222/json
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process -FilePath "$PSScriptRoot\..\..\app\target\release\kai.exe"
Write-Output "kai.exe started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
