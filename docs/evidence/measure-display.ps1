Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class S {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
Write-Output "=== SCREENS (physical px) ==="
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $dpi = if ($s.DeviceName) { 0 } else { 0 }
  Write-Output ("{0} bounds={1} workarea={2} primary={3} bitsPerPixel={4}" -f $s.DeviceName, $s.Bounds, $s.WorkingArea, $s.Primary, $s.BitsPerPixel)
}
Write-Output "=== DPI / text scale ==="
$reg = Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
Write-Output ("LogPixels(desktop dpi) = " + $reg.LogPixels + " ; Win8DpiScaling = " + $reg.Win8DpiScaling)
$acc = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Accessibility' -ErrorAction SilentlyContinue
Write-Output ("TextScaleFactor = " + $acc.TextScaleFactor)
$c = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output ("VirtualScreen = " + $c)
Write-Output "=== kai.exe windows: rect + client + dpi ==="
$procs = Get-Process kai -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output '(no kai.exe running)' } else {
  $ids = @{}
  foreach ($p in $procs) { $ids[[uint32]$p.Id] = $true }
  $cb = [S+EnumWindowsProc]{
    param($h,$l)
    $pp = [uint32]0
    [void][S]::GetWindowThreadProcessId($h,[ref]$pp)
    if ($ids.ContainsKey($pp)) {
      $wr = New-Object S+RECT; [void][S]::GetWindowRect($h,[ref]$wr)
      $cr = New-Object S+RECT; [void][S]::GetClientRect($h,[ref]$cr)
      $dpi = [S]::GetDpiForWindow($h)
      $t = New-Object System.Text.StringBuilder 256; [void][S]::GetWindowText($h,$t,256)
      $cl = New-Object System.Text.StringBuilder 128; [void][S]::GetClassName($h,$cl,128)
      $scale = if ($dpi -gt 0) { [math]::Round($dpi/96.0,4) } else { 0 }
      Write-Output ("{0} | {1} | rect={2}x{3} at {4},{5} | client={6}x{7} | dpi={8} scale={9} | clientCss={10}x{11}" -f `
        $t.ToString(), $cl.ToString(), ($wr.R-$wr.L), ($wr.B-$wr.T), $wr.L, $wr.T, ($cr.R-$cr.L), ($cr.B-$cr.T), $dpi, $scale, `
        [math]::Round(($cr.R-$cr.L)/$scale,1), [math]::Round(($cr.B-$cr.T)/$scale,1))
    }
    return $true
  }
  [void][S]::EnumWindows($cb,[IntPtr]::Zero)
}
