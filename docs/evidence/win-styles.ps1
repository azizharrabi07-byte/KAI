# Window styles of every top-level window a process owns.
#
# `IsWindowVisible` alone cannot say *why* a window is invisible, and the island's
# mouse behaviour is decided entirely by its extended style. This reads both, plus
# the layered-window attributes (LWA_COLORKEY / LWA_ALPHA and the key colour), which
# is what a transparent Tauri window actually gets.
#
#   powershell -File win-styles.ps1 [-ProcessName kai] [-TitleMatch Settings]
param(
    [string]$ProcessName = 'kai',
    [string]$TitleMatch = '',
    [switch]$TitleExact
)

Add-Type -Namespace Kai -Name Styles -MemberDefinition @'
    [DllImport("user32.dll", SetLastError = true)] public static extern long GetWindowLongPtrW(System.IntPtr hWnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern long SetWindowLongPtrW(System.IntPtr hWnd, int index, long value);
    [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(System.IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hWnd, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(System.IntPtr hWnd, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(System.IntPtr parent, EnumProc cb, System.IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(System.IntPtr hWnd, out uint key, out byte alpha, out uint flags);
    public delegate bool EnumProc(System.IntPtr hWnd, System.IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$GWL_STYLE = -16
$GWL_EXSTYLE = -20

$WS_VISIBLE        = 0x10000000
$WS_EX_TRANSPARENT = 0x00000020
$WS_EX_LAYERED     = 0x00080000
$WS_EX_NOACTIVATE  = 0x08000000
$WS_EX_TOOLWINDOW  = 0x00000080
$WS_EX_TOPMOST     = 0x00000008

function Explain([long]$ex) {
    $names = New-Object System.Collections.ArrayList
    foreach ($pair in @(
            @('WS_EX_TRANSPARENT', $WS_EX_TRANSPARENT),
            @('WS_EX_LAYERED', $WS_EX_LAYERED),
            @('WS_EX_NOACTIVATE', $WS_EX_NOACTIVATE),
            @('WS_EX_TOOLWINDOW', $WS_EX_TOOLWINDOW),
            @('WS_EX_TOPMOST', $WS_EX_TOPMOST))) {
        if (($ex -band [long]$pair[1]) -ne 0) { [void]$names.Add($pair[0]) }
    }
    return ($names -join '|')
}

function Describe([System.IntPtr]$hWnd) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Kai.Styles]::GetWindowTextW($hWnd, $sb, 512)
    $cls = New-Object System.Text.StringBuilder 256
    [void][Kai.Styles]::GetClassNameW($hWnd, $cls, 256)
    $r = New-Object Kai.Styles+RECT
    [void][Kai.Styles]::GetWindowRect($hWnd, [ref]$r)
    $style = [Kai.Styles]::GetWindowLongPtrW($hWnd, $GWL_STYLE)
    $ex = [Kai.Styles]::GetWindowLongPtrW($hWnd, $GWL_EXSTYLE)
    $key = [uint32]0; $alpha = [byte]0; $flags = [uint32]0
    $layered = [Kai.Styles]::GetLayeredWindowAttributes($hWnd, [ref]$key, [ref]$alpha, [ref]$flags)
    [pscustomobject]@{
        hwnd      = $hWnd.ToInt64()
        class     = $cls.ToString()
        title     = $sb.ToString()
        visible   = [Kai.Styles]::IsWindowVisible($hWnd)
        enabled   = [Kai.Styles]::IsWindowEnabled($hWnd)
        style     = ('0x{0:X8}' -f $style)
        exstyle   = ('0x{0:X8}' -f $ex)
        exflags   = (Explain $ex)
        layered   = if ($layered) { "ok key=0x{0:X6} alpha={1} flags={2}" -f $key, $alpha, $flags } else { 'none' }
        rect      = "$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
        ws_visible = (($style -band $WS_VISIBLE) -ne 0)
    }
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
if (-not $proc) { throw "no process '$ProcessName'" }
$pids = @($proc | ForEach-Object { [uint32]$_.Id })

$found = New-Object System.Collections.ArrayList
$cb = [Kai.Styles+EnumProc]{
    param($hWnd, $p)
    $wpid = [uint32]0
    [void][Kai.Styles]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($pids -contains $wpid) { [void]$found.Add((Describe $hWnd)) }
    return $true
}
[void][Kai.Styles]::EnumWindows($cb, [System.IntPtr]::Zero)

$rows = $found
if ($TitleExact) { $rows = @($found | Where-Object { $_.title -eq $TitleMatch }) }
elseif ($TitleMatch -ne '') { $rows = @($found | Where-Object { $_.title -like "*$TitleMatch*" }) }
, @($rows) | ConvertTo-Json -Depth 4
