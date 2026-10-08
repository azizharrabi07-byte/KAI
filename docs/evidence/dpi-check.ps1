# Reports the display DPI, the island window's DPI, and the resulting scale.
# Read-only probe: it changes nothing.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DpiProbe {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int index);
  [DllImport("shcore.dll")] public static extern int GetScaleFactorForMonitor(IntPtr hmon, out int scale);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
}
"@

Add-Type -AssemblyName System.Windows.Forms

Write-Output "--- screens ---"
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  Write-Output ("{0} bounds={1}x{2} at {3},{4} primary={5}" -f $s.DeviceName, $s.Bounds.Width, $s.Bounds.Height, $s.Bounds.X, $s.Bounds.Y, $s.Primary)
}

$dc = [DpiProbe]::GetDC([IntPtr]::Zero)
Write-Output ("screen DPI (LOGPIXELSX) = " + [DpiProbe]::GetDeviceCaps($dc, 88))

Write-Output "--- island window ---"
$proc = Get-Process kai -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output "kai.exe not running"; exit 0 }
$hwnd = $proc.MainWindowHandle
Write-Output ("kai.exe pid=" + $proc.Id + " mainHwnd=" + $hwnd)
if ($hwnd -ne [IntPtr]::Zero) {
  $wdpi = [DpiProbe]::GetDpiForWindow($hwnd)
  Write-Output ("GetDpiForWindow = " + $wdpi + "  -> scale " + [math]::Round($wdpi / 96.0, 4))
  $mon = [DpiProbe]::MonitorFromWindow($hwnd, 2)
  $scale = 0
  $hr = [DpiProbe]::GetScaleFactorForMonitor($mon, [ref]$scale)
  Write-Output ("GetScaleFactorForMonitor hr=" + $hr + " scale=" + $scale + "%")
}
