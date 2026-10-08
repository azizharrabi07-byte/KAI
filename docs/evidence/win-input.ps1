# Real OS-level mouse + window geometry for the KAI island.
#
# The island does not use DOM mousemove: island.rs polls GetCursorPos() at 60 Hz
# and emits the position to the webview, so the only way to make the island
# hover, expand or take a click is to move the actual Windows cursor.
#
#   powershell -File win-input.ps1 -Action rect  [-ProcessName kai]
#   powershell -File win-input.ps1 -Action move  -X 100 -Y 20
#   powershell -File win-input.ps1 -Action click -X 100 -Y 20
param(
    [Parameter(Mandatory = $true)][ValidateSet('rect', 'move', 'click', 'pos', 'windows')][string]$Action,
    [int]$X = 0,
    [int]$Y = 0,
    [string]$ProcessName = 'kai',
    [string]$TitleMatch = ''
)

Add-Type -Namespace Kai -Name Native -MemberDefinition @'
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(System.IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
    public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004

function Get-Rect {
    $p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw "no window for process '$ProcessName'" }
    $r = New-Object Kai.Native+RECT
    [void][Kai.Native]::GetWindowRect($p.MainWindowHandle, [ref]$r)
    $dpi = [Kai.Native]::GetDpiForWindow($p.MainWindowHandle)
    [pscustomobject]@{
        pid    = $p.Id
        handle = $p.MainWindowHandle
        left   = $r.Left
        top    = $r.Top
        width  = $r.Right - $r.Left
        height = $r.Bottom - $r.Top
        dpi    = $dpi
        scale  = [math]::Round($dpi / 96.0, 4)
    } | ConvertTo-Json -Compress
}

switch ($Action) {
    'rect' { Get-Rect }
    'windows' {
        # Every top-level window of the process, with its rect — the island and
        # the settings window are two separate HWNDs in the same process.
        $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
        if (-not $proc) { throw "no process '$ProcessName'" }
        $pids = @($proc | ForEach-Object { [uint32]$_.Id })
        $found = New-Object System.Collections.ArrayList
        $cb = [Kai.Native+EnumProc]{
            param($hWnd, $p)
            $wpid = [uint32]0
            [void][Kai.Native]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
            if ($pids -contains $wpid) {
                $sb = New-Object System.Text.StringBuilder 512
                [void][Kai.Native]::GetWindowTextW($hWnd, $sb, 512)
                $r = New-Object Kai.Native+RECT
                [void][Kai.Native]::GetWindowRect($hWnd, [ref]$r)
                [void]$found.Add([pscustomobject]@{
                    hwnd    = $hWnd.ToInt64()
                    pid     = $wpid
                    title   = $sb.ToString()
                    visible = [Kai.Native]::IsWindowVisible($hWnd)
                    left    = $r.Left
                    top     = $r.Top
                    width   = $r.Right - $r.Left
                    height  = $r.Bottom - $r.Top
                })
            }
            return $true
        }
        [void][Kai.Native]::EnumWindows($cb, [System.IntPtr]::Zero)
        , @($found) | ConvertTo-Json -Depth 4
    }
    'pos' {
        $pt = New-Object Kai.Native+POINT
        [void][Kai.Native]::GetCursorPos([ref]$pt)
        [pscustomobject]@{ x = $pt.X; y = $pt.Y } | ConvertTo-Json -Compress
    }
    'move' {
        [void][Kai.Native]::SetCursorPos($X, $Y)
        Start-Sleep -Milliseconds 120
        $pt = New-Object Kai.Native+POINT
        [void][Kai.Native]::GetCursorPos([ref]$pt)
        [pscustomobject]@{ requested = "$X,$Y"; actual = "$($pt.X),$($pt.Y)" } | ConvertTo-Json -Compress
    }
    'click' {
        [void][Kai.Native]::SetCursorPos($X, $Y)
        Start-Sleep -Milliseconds 250
        [Kai.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 90
        [Kai.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 120
        $pt = New-Object Kai.Native+POINT
        [void][Kai.Native]::GetCursorPos([ref]$pt)
        [pscustomobject]@{ clicked = "$X,$Y"; actual = "$($pt.X),$($pt.Y)" } | ConvertTo-Json -Compress
    }
}
