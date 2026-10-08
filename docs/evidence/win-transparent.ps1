# Force a window's WS_EX_LAYERED|WS_EX_TRANSPARENT flags on or off.
#
# This is the exact state that stranded the island: with both flags set, Windows
# delivers the webview no mouse messages, so a DOM `mouseenter` can never fire. Being
# able to set it deliberately is what makes it possible to test the wake path that does
# NOT depend on the webview.
#
#   powershell -File win-transparent.ps1 -TitleMatch KAI -TitleExact -On
#   powershell -File win-transparent.ps1 -TitleMatch KAI -TitleExact -Off
param(
    [string]$ProcessName = 'kai',
    [string]$TitleMatch = '',
    [switch]$TitleExact,
    [switch]$On,
    [switch]$Off
)

Add-Type -Namespace Kai -Name ExSet -MemberDefinition @'
    [DllImport("user32.dll", SetLastError = true)] public static extern long GetWindowLongPtrW(System.IntPtr hWnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern long SetWindowLongPtrW(System.IntPtr hWnd, int index, long value);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
    public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr p);
'@

if (-not $On -and -not $Off) { throw "pass -On or -Off" }

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x20
$WS_EX_LAYERED = 0x80000

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $proc) { throw "no process '$ProcessName'" }
$pids = @($proc | ForEach-Object { [uint32]$_.Id })

# Collect first, decide afterwards: a scriptblock used as a native callback runs in its
# own scope and cannot see $TitleMatch/$TitleExact (that bug made an earlier version of
# this file report "no window matching" for a window that was plainly there).
$found = New-Object System.Collections.ArrayList
$cb = [Kai.ExSet+EnumProc]{
    param($hWnd, $p)
    $wpid = [uint32]0
    [void][Kai.ExSet]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($pids -contains $wpid) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][Kai.ExSet]::GetWindowTextW($hWnd, $sb, 512)
        [void]$found.Add([pscustomobject]@{ handle = $hWnd.ToInt64(); title = $sb.ToString() })
    }
    return $true
}
[void][Kai.ExSet]::EnumWindows($cb, [System.IntPtr]::Zero)

if ($TitleExact) { $rows = @($found | Where-Object { $_.title -eq $TitleMatch }) }
elseif ($TitleMatch -ne '') { $rows = @($found | Where-Object { $_.title -like "*$TitleMatch*" }) }
else { $rows = @($found) }
if ($rows.Count -eq 0) { throw "no window matching '$TitleMatch'" }

foreach ($row in $rows) {
    $h = [System.IntPtr]$row.handle
    $before = [Kai.ExSet]::GetWindowLongPtrW($h, $GWL_EXSTYLE)
    $after = if ($On) { $before -bor $WS_EX_TRANSPARENT -bor $WS_EX_LAYERED }
             else { $before -band (-bnot ($WS_EX_TRANSPARENT -bor $WS_EX_LAYERED)) }
    [void][Kai.ExSet]::SetWindowLongPtrW($h, $GWL_EXSTYLE, $after)
    $now = [Kai.ExSet]::GetWindowLongPtrW($h, $GWL_EXSTYLE)
    Write-Output ("[" + $row.title + "] exstyle 0x" + $before.ToString("X8") + " -> 0x" + $now.ToString("X8"))
}
