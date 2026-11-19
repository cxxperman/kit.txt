# Собирает снимки окон в одну картинку 3×2 с подписями — чтобы видеть приложения рядом
param([string]$Files, [string]$Labels, [string]$Out)
$F = @($Files -split ","); $L = @($Labels -split ",")
Add-Type -AssemblyName System.Drawing
$cw = 760; $ch = 560; $pad = 24; $cols = 3; $rows = [math]::Ceiling($F.Count / $cols)
$bmp = New-Object System.Drawing.Bitmap ($cols * ($cw + $pad) + $pad), ($rows * ($ch + $pad + 30) + $pad)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::FromArgb(0x14, 0x14, 0x14))
$font = New-Object System.Drawing.Font 'Segoe UI', 13
for ($i = 0; $i -lt $F.Count; $i++) {
  $img = [System.Drawing.Image]::FromFile($F[$i])
  $x = $pad + ($i % $cols) * ($cw + $pad); $y = $pad + [math]::Floor($i / $cols) * ($ch + $pad + 30)
  $k = [math]::Min($cw / $img.Width, $ch / $img.Height); $w = [int]($img.Width * $k); $h = [int]($img.Height * $k)
  $g.DrawString($L[$i], $font, [System.Drawing.Brushes]::Gainsboro, $x, $y)
  $g.DrawImage($img, $x, $y + 30, $w, $h)
  $img.Dispose()
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); "saved $Out"
