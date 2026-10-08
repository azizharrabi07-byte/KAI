# Click a point in a page's CSS coordinates with the REAL mouse.
#
# The island and the settings window are WebView2 windows, and their pages live in a
# CSS coordinate space that is smaller than the physical window by the device pixel
# ratio (here 1.4354: a 110 % display scale times a 130 % text scale). A synthetic
# renderer-level click goes around the OS, so it cannot tell you whether a window is
# really on screen and really taking input. This converts one point of the page into
# screen coordinates and moves/clicks the actual cursor there.
#
#   powershell -File win-client.ps1 -TitleMatch Settings -X 240.5 -Y 330 -Dpr 1.4354 -Action click
#   powershell -File win-client.ps1 -TitleExact KAI     -X 694 -Y 16  -Dpr 1.4354 -Action move
param(
    [string]$ProcessName = 'kai',
    [string]$TitleMatch = '',
    [switch]$TitleExact,
    [Parameter(Mandatory = $true)][double]$X,
    [Parameter(Mandatory = $true)][double]$Y,
    [Parameter(Mandatory = $true)][double]$Dpr,
    [ValidateSet('screen', 'move', 'click')][string]$Action = 'screen'
)

Add-Type -Namespace Kai -Name Client -MemberDefinition @'
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(System.IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
    public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $proc) { throw "no process '$ProcessName'" }
$pids = @($proc | ForEach-Object { [uint32]$_.Id })

$targets = New-Object System.Collections.ArrayList
$cb = [Kai.Client+EnumProc]{
    param($hWnd, $p)
    $wpid = [uint32]0
    [void][Kai.Client]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($pids -contains $wpid) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][Kai.Client]::GetWindowTextW($hWnd, $sb, 512)
        [void]$targets.Add([pscustomobject]@{ handle = $hWnd.ToInt64(); title = $sb.ToString() })
    }
    return $true
}
[void][Kai.Client]::EnumWindows($cb, [System.IntPtr]::Zero)

# Filter AFTER the callback: a scriptblock used as a native callback runs in its own
# scope and cannot see -TitleMatch/-TitleExact, so filtering inside it matched every
# window of the process and then clicked at the first one's coordinates.
if ($TitleExact) { $rows = @($targets | Where-Object { $_.title -eq $TitleMatch }) }
else { $rows = @($targets | Where-Object { $_.title -like "*$TitleMatch*" }) }
if ($rows.Count -eq 0) { throw "no window matching '$TitleMatch' (exact=$TitleExact) in $ProcessName" }
$hwnd = [System.IntPtr]$rows[0].handle

$origin = New-Object Kai.Client+POINT
[void][Kai.Client]::ClientToScreen($hwnd, [ref]$origin)
$rect = New-Object Kai.Client+RECT
[void][Kai.Client]::GetClientRect($hwnd, [ref]$rect)

$sx = [int][math]::Round($origin.X + $X * $Dpr)
$sy = [int][math]::Round($origin.Y + $Y * $Dpr)

switch ($Action) {
    'screen' {
        [pscustomobject]@{
            hwnd            = $hwnd.ToInt64()
            title           = $rows[0].title
            candidates      = ($targets | ForEach-Object { "$($_.handle):$($_.title)" }) -join ' '
            clientOrigin    = "$($origin.X),$($origin.Y)"
            clientSize      = "$($rect.Right)x$($rect.Bottom)"
            cssPoint        = "$X,$Y"
            dpr             = $Dpr
            screenPoint     = "$sx,$sy"
        } | ConvertTo-Json -Compress
    }
    'move' {
        [void][Kai.Client]::SetCursorPos($sx, $sy)
        Write-Output "moved the real cursor to $sx,$sy (page $X,$Y)"
    }
    'click' {
        [void][Kai.Client]::SetCursorPos($sx, $sy)
        Start-Sleep -Milliseconds 260
        [Kai.Client]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 90
        [Kai.Client]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 150
        $now = New-Object Kai.Client+POINT
        [void][Kai.Client]::GetCursorPos([ref]$now)
        Write-Output "real click at $sx,$sy (page $X,$Y); cursor now $($now.X),$($now.Y)"
    }
}
