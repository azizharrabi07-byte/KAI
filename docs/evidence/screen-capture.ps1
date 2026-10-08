# Capture the real desktop to a PNG — the ground truth for "is it on screen".
#
#   powershell -File screen-capture.ps1 -Out docs/evidence/foo.png [-All]
#
# -All captures the whole virtual desktop (every monitor); the default captures
# the primary screen only.
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [switch]$All
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($All) { $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen }
else { $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }

$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output "wrote $Out  ($($bounds.Width)x$($bounds.Height) from $($bounds.Left),$($bounds.Top))"
