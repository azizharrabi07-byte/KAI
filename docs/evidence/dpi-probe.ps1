# Ground-truth DPI / coordinate probe for the KAI evidence run.
# Prints the process DPI awareness, then re-measures everything after becoming
# per-monitor-v2 aware, so virtualized coordinates cannot be mistaken for real ones.
Add-Type -Namespace P -Name D -MemberDefinition @'
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr ctx);
    [DllImport("user32.dll")] public static extern System.IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetDpiForSystem();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(System.IntPtr h);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(System.IntPtr m, int type, out uint x, out uint y);
    [DllImport("user32.dll")] public static extern System.IntPtr MonitorFromPoint(POINT p, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Report([string]$when) {
    $pt = New-Object P.D+POINT
    [void][P.D]::GetCursorPos([ref]$pt)
    $mon = [P.D]::MonitorFromPoint($pt, 2)
    $dx = [uint32]0; $dy = [uint32]0
    [void][P.D]::GetDpiForMonitor($mon, 0, [ref]$dx, [ref]$dy)
    $kai = Get-Process kai -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    $kr = New-Object P.D+RECT
    if ($kai) { [void][P.D]::GetWindowRect($kai.MainWindowHandle, [ref]$kr) }
    [pscustomobject]@{
        when          = $when
        dpi_awareness = ("0x{0:X}" -f [P.D]::GetThreadDpiAwarenessContext().ToInt64())
        system_dpi    = [P.D]::GetDpiForSystem()
        monitor_dpi   = "$dx"
        screen        = "$([P.D]::GetSystemMetrics(0))x$([P.D]::GetSystemMetrics(1))"
        cursor        = "$($pt.X),$($pt.Y)"
        kai_window    = if ($kai) { "$($kr.Left),$($kr.Top) $($kr.Right - $kr.Left)x$($kr.Bottom - $kr.Top) dpi=$([P.D]::GetDpiForWindow($kai.MainWindowHandle))" } else { "n/a" }
    }
}

Report "unaware"
# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
[void][P.D]::SetProcessDpiAwarenessContext([System.IntPtr](-4))
Report "per-monitor-v2"
