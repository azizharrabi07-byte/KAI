$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$procs = Get-Process kai -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'kai' }
if (-not $procs) { Write-Output 'NO kai.exe PROCESS'; exit }
$ids = @{}
foreach ($p in $procs) { $ids[[uint32]$p.Id] = $p }
Write-Output ("kai.exe pids: " + ($procs.Id -join ','))
$results = New-Object System.Collections.ArrayList
$cb = [W+EnumWindowsProc]{
  param($h, $l)
  $pid2 = [uint32]0
  [void][W]::GetWindowThreadProcessId($h, [ref]$pid2)
  if ($ids.ContainsKey($pid2)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][W]::GetWindowText($h, $sb, 512)
    $cn = New-Object System.Text.StringBuilder 256
    [void][W]::GetClassName($h, $cn, 256)
    $r = New-Object W+RECT
    [void][W]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    if ($w -gt 0 -and $hh -gt 0) {
      [void]$results.Add([pscustomobject]@{
        pid   = $pid2
        hwnd  = ('0x{0:X}' -f [int64]$h)
        class = $cn.ToString()
        title = $sb.ToString()
        visible = [W]::IsWindowVisible($h)
        x = $r.L; y = $r.T; w = $w; h = $hh
        size = "$w x $hh"
      })
    }
  }
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)
$results | Sort-Object -Property w -Descending | Format-Table -AutoSize | Out-String -Width 200
