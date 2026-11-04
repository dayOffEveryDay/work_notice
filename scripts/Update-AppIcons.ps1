# Convert the supplied artwork to Windows icon containers / package logo sizes.
# Fits visible artwork instead of transparent canvas; original source PNGs remain unchanged.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = Split-Path -Parent $PSScriptRoot
$assetDirectory = Join-Path $taskRoot 'src/WorkNoticeAgent.App/Assets'
$packageAssets = Join-Path $taskRoot 'packaging/WorkNoticeAgent.Package/Assets'
if (-not ('WorkNoticeIconPixels' -as [type])) {
    Add-Type -TypeDefinition @'
public static class WorkNoticeIconPixels {
    public static int[] Bounds(byte[] pixels, int width, int height) {
        int left=width, top=height, right=-1, bottom=-1;
        for (int y=0; y<height; y++) for (int x=0; x<width; x++) {
            // Ignore nearly invisible alpha noise outside the supplied character.
            if (pixels[(y*width+x)*4+3] <= 8) continue;
            if(x<left)left=x; if(x>right)right=x;
            if(y<top)top=y; if(y>bottom)bottom=y;
        }
        return new[]{left,top,right,bottom};
    }
}
'@
}
function Get-ArtworkBounds([Drawing.Bitmap]$Image) {
    $data = $Image.LockBits([Drawing.Rectangle]::new(0,0,$Image.Width,$Image.Height), [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $pixels = [byte[]]::new($Image.Width*$Image.Height*4)
        for ($y=0; $y -lt $Image.Height; $y++) {
            [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($data.Scan0,$y*$data.Stride),$pixels,$y*$Image.Width*4,$Image.Width*4)
        }
    } finally { $Image.UnlockBits($data) }
    $bounds = [WorkNoticeIconPixels]::Bounds($pixels,$Image.Width,$Image.Height)
    if ($bounds[2] -lt $bounds[0]) { throw 'Source image is transparent.' }
    # Keep two source pixels around the antialiased edges; retain the moon / antenna.
    $left=[Math]::Max(0,$bounds[0]-2); $top=[Math]::Max(0,$bounds[1]-2)
    $right=[Math]::Min($Image.Width-1,$bounds[2]+2); $bottom=[Math]::Min($Image.Height-1,$bounds[3]+2)
    return [Drawing.RectangleF]::new($left,$top,$right-$left+1,$bottom-$top+1)
}
function Get-ScaledPng([Drawing.Image]$Image, [int]$Size, [Drawing.RectangleF]$Bounds) {
    $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $margin = [Math]::Max(0.25, $Size*0.015)
        $scale = ($Size-2*$margin)/[Math]::Max($Bounds.Width,$Bounds.Height)
        $width=$Bounds.Width*$scale; $height=$Bounds.Height*$scale
        $destination=[Drawing.RectangleF]::new(($Size-$width)/2,($Size-$height)/2,$width,$height)
        $graphics.DrawImage($Image,$destination,$Bounds,[Drawing.GraphicsUnit]::Pixel)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
foreach ($name in @('Standby', 'Monitoring')) {
    $source = [Drawing.Bitmap]::new((Join-Path $assetDirectory "Source/$name.png"))
    try {
        $bounds = Get-ArtworkBounds $source
        $sizes = @(256, 128, 64, 48, 40, 32, 24, 20, 16)
        $frames = @($sizes | ForEach-Object { Get-ScaledPng $source $_ $bounds })
        $output = [IO.File]::Create((Join-Path $assetDirectory "$name.ico"))
        $writer = [IO.BinaryWriter]::new($output)
        try {
            $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
            $offset = 6 + 16 * $sizes.Count
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
                $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
                $writer.Write([byte]0); $writer.Write([byte]0)
                $writer.Write([uint16]1); $writer.Write([uint16]32)
                $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
                $offset += $frames[$i].Length
            }
            foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
        } finally { $writer.Dispose(); $output.Dispose() }
        if ($name -eq 'Monitoring') {
            foreach ($logo in @(@('StoreLogo', 50), @('Square44x44Logo', 44), @('Square150x150Logo', 150))) {
                [IO.File]::WriteAllBytes((Join-Path $packageAssets ($logo[0] + '.png')), (Get-ScaledPng $source $logo[1] $bounds))
            }
        }
    } finally { $source.Dispose() }
}
Write-Output 'Updated monitoring / standby ICOs and MSIX logos from the original transparent PNGs.'
