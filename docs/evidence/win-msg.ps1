# Send a single window message to a window by title — used to close the settings
# window the way the user's X button does, so the re-open path can be exercised.
#
#   powershell -File win-msg.ps1 -Action close -ProcessName kai -TitleMatch Settings
param(
    [Parameter(Mandatory = $true)][ValidateSet('close')][string]$Action,
    [string]$ProcessName = 'kai',
    [string]$TitleMatch = ''
)

Add-Type -Namespace Kai -Name Msg -MemberDefinition @'
    [DllImport("user32.dll")] public static extern bool PostMessageW(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
    public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr p);
'@

$WM_CLOSE = 0x0010

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $proc) { throw "no process '$ProcessName'" }
$pids = @($proc | ForEach-Object { [uint32]$_.Id })

$sent = New-Object System.Collections.ArrayList
$cb = [Kai.Msg+EnumProc]{
    param($hWnd, $p)
    $wpid = [uint32]0
    [void][Kai.Msg]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($pids -contains $wpid) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][Kai.Msg]::GetWindowTextW($hWnd, $sb, 512)
        if ($TitleMatch -eq '' -or $sb.ToString() -like "*$TitleMatch*") {
            [void][Kai.Msg]::PostMessageW($hWnd, $WM_CLOSE, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
            [void]$sent.Add("$($hWnd.ToInt64()) $($sb.ToString())")
        }
    }
    return $true
}
[void][Kai.Msg]::EnumWindows($cb, [System.IntPtr]::Zero)
Write-Output "WM_CLOSE sent to: $($sent -join '; ')"
