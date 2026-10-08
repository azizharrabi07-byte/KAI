# Lists processes that could be authoring/building the KAI repo, so a second
# development session can be identified before edits begin. Read-only.
$patterns = @('*hermes*', '*Desktop\kai*', '*coucou*', 'cargo*', '*tauri*')

$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$hits = $procs | Where-Object {
  $cl = $_.CommandLine
  if ([string]::IsNullOrWhiteSpace($cl)) { return $false }
  foreach ($p in $patterns) { if ($cl -like $p) { return $true } }
  return $false
}

if (-not $hits) {
  Write-Output "no authoring/build processes found"
} else {
  $hits | Select-Object ProcessId, Name, ParentProcessId, @{n='Cmd';e={ $_.CommandLine.Substring(0, [Math]::Min(160, $_.CommandLine.Length)) }} | Format-List
}

Write-Output "--- kai.exe ---"
Get-Process kai -ErrorAction SilentlyContinue | Select-Object Id, StartTime | Format-List

Write-Output "--- repo write activity (last 10 min) ---"
$cut = (Get-Date).AddMinutes(-10)
$recent = Get-ChildItem -Path 'C:\Users\DELL\Desktop\kai' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $cut -and $_.FullName -notmatch '\\node_modules\\|\\target\\|\\.git\\' }
if (-not $recent) { Write-Output "no files written in the last 10 minutes" }
else { $recent | Select-Object -First 10 LastWriteTime, FullName | Format-Table -AutoSize }
