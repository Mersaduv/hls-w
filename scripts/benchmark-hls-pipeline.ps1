param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$FfmpegPath = "ffmpeg",
  [int]$SampleSeconds = 45,
  [int]$SegmentDuration = 6,
  [double]$OutputFps = 30
)

if (-not (Test-Path -LiteralPath $InputPath)) {
  Write-Error "Input file not found: $InputPath"
  exit 1
}

function Run-Benchmark {
  param(
    [string]$Title,
    [string[]]$Args
  )

  Write-Host ""
  Write-Host "== $Title =="
  Write-Host "$FfmpegPath $($Args -join ' ')"

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $FfmpegPath @Args
  $exitCode = $LASTEXITCODE
  $sw.Stop()

  return [PSCustomObject]@{
    Title = $Title
    ExitCode = $exitCode
    Milliseconds = [int]$sw.ElapsedMilliseconds
  }
}

$gop = [Math]::Max(24, [int][Math]::Round($SegmentDuration * $OutputFps))
$fpsText = ("{0:0.###}" -f $OutputFps)
$forceKeyExpr = "expr:gte(t,n_forced*$SegmentDuration)"

$gpuArgs = @(
  "-v", "error",
  "-y",
  "-ss", "0",
  "-t", "$SampleSeconds",
  "-hwaccel", "cuda",
  "-hwaccel_output_format", "cuda",
  "-i", $InputPath,
  "-filter_complex", "[0:v]split=4[v1080][v720][v480][v360];[v1080]scale_cuda=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad_cuda=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2:color=black[v1080out];[v720]scale_cuda=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2,pad_cuda=w=1280:h=720:x=(ow-iw)/2:y=(oh-ih)/2:color=black[v720out];[v480]scale_cuda=w=854:h=480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad_cuda=w=854:h=480:x=(ow-iw)/2:y=(oh-ih)/2:color=black[v480out];[v360]scale_cuda=w=640:h=360:force_original_aspect_ratio=decrease:force_divisible_by=2,pad_cuda=w=640:h=360:x=(ow-iw)/2:y=(oh-ih)/2:color=black[v360out]",
  "-map", "[v1080out]", "-c:v:0", "h264_nvenc", "-preset:v:0", "p1", "-tune:v:0", "ll", "-rc:v:0", "vbr", "-rc-lookahead:v:0", "0", "-spatial-aq:v:0", "0", "-temporal-aq:v:0", "0", "-b:v:0", "4500k", "-maxrate:v:0", "5000k", "-bufsize:v:0", "9000k", "-r:v:0", "$fpsText", "-g:v:0", "$gop", "-keyint_min:v:0", "$gop", "-sc_threshold:v:0", "0", "-force_key_frames:v:0", "$forceKeyExpr", "-forced-idr:v:0", "1", "-an",
  "-map", "[v720out]", "-c:v:1", "h264_nvenc", "-preset:v:1", "p1", "-tune:v:1", "ll", "-rc:v:1", "vbr", "-rc-lookahead:v:1", "0", "-spatial-aq:v:1", "0", "-temporal-aq:v:1", "0", "-b:v:1", "2500k", "-maxrate:v:1", "2800k", "-bufsize:v:1", "5000k", "-r:v:1", "$fpsText", "-g:v:1", "$gop", "-keyint_min:v:1", "$gop", "-sc_threshold:v:1", "0", "-force_key_frames:v:1", "$forceKeyExpr", "-forced-idr:v:1", "1", "-an",
  "-map", "[v480out]", "-c:v:2", "h264_nvenc", "-preset:v:2", "p1", "-tune:v:2", "ll", "-rc:v:2", "vbr", "-rc-lookahead:v:2", "0", "-spatial-aq:v:2", "0", "-temporal-aq:v:2", "0", "-b:v:2", "1100k", "-maxrate:v:2", "1232k", "-bufsize:v:2", "2200k", "-r:v:2", "$fpsText", "-g:v:2", "$gop", "-keyint_min:v:2", "$gop", "-sc_threshold:v:2", "0", "-force_key_frames:v:2", "$forceKeyExpr", "-forced-idr:v:2", "1", "-an",
  "-map", "[v360out]", "-c:v:3", "h264_nvenc", "-preset:v:3", "p1", "-tune:v:3", "ll", "-rc:v:3", "vbr", "-rc-lookahead:v:3", "0", "-spatial-aq:v:3", "0", "-temporal-aq:v:3", "0", "-b:v:3", "700k", "-maxrate:v:3", "784k", "-bufsize:v:3", "1400k", "-r:v:3", "$fpsText", "-g:v:3", "$gop", "-keyint_min:v:3", "$gop", "-sc_threshold:v:3", "0", "-force_key_frames:v:3", "$forceKeyExpr", "-forced-idr:v:3", "1", "-an",
  "-f", "null", "NUL"
)

$cpuScaleArgs = @(
  "-v", "error",
  "-y",
  "-ss", "0",
  "-t", "$SampleSeconds",
  "-hwaccel", "auto",
  "-i", $InputPath,
  "-filter_complex", "[0:v]split=4[v1080][v720][v480][v360];[v1080]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080out];[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out];[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out];[v360]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360out]",
  "-map", "[v1080out]", "-c:v:0", "h264_nvenc", "-preset:v:0", "p1", "-tune:v:0", "ll", "-rc:v:0", "vbr", "-rc-lookahead:v:0", "0", "-spatial-aq:v:0", "0", "-temporal-aq:v:0", "0", "-b:v:0", "4500k", "-maxrate:v:0", "5000k", "-bufsize:v:0", "9000k", "-r:v:0", "$fpsText", "-g:v:0", "$gop", "-keyint_min:v:0", "$gop", "-sc_threshold:v:0", "0", "-force_key_frames:v:0", "$forceKeyExpr", "-forced-idr:v:0", "1", "-an",
  "-map", "[v720out]", "-c:v:1", "h264_nvenc", "-preset:v:1", "p1", "-tune:v:1", "ll", "-rc:v:1", "vbr", "-rc-lookahead:v:1", "0", "-spatial-aq:v:1", "0", "-temporal-aq:v:1", "0", "-b:v:1", "2500k", "-maxrate:v:1", "2800k", "-bufsize:v:1", "5000k", "-r:v:1", "$fpsText", "-g:v:1", "$gop", "-keyint_min:v:1", "$gop", "-sc_threshold:v:1", "0", "-force_key_frames:v:1", "$forceKeyExpr", "-forced-idr:v:1", "1", "-an",
  "-map", "[v480out]", "-c:v:2", "h264_nvenc", "-preset:v:2", "p1", "-tune:v:2", "ll", "-rc:v:2", "vbr", "-rc-lookahead:v:2", "0", "-spatial-aq:v:2", "0", "-temporal-aq:v:2", "0", "-b:v:2", "1100k", "-maxrate:v:2", "1232k", "-bufsize:v:2", "2200k", "-r:v:2", "$fpsText", "-g:v:2", "$gop", "-keyint_min:v:2", "$gop", "-sc_threshold:v:2", "0", "-force_key_frames:v:2", "$forceKeyExpr", "-forced-idr:v:2", "1", "-an",
  "-map", "[v360out]", "-c:v:3", "h264_nvenc", "-preset:v:3", "p1", "-tune:v:3", "ll", "-rc:v:3", "vbr", "-rc-lookahead:v:3", "0", "-spatial-aq:v:3", "0", "-temporal-aq:v:3", "0", "-b:v:3", "700k", "-maxrate:v:3", "784k", "-bufsize:v:3", "1400k", "-r:v:3", "$fpsText", "-g:v:3", "$gop", "-keyint_min:v:3", "$gop", "-sc_threshold:v:3", "0", "-force_key_frames:v:3", "$forceKeyExpr", "-forced-idr:v:3", "1", "-an",
  "-f", "null", "NUL"
)

$gpuResult = Run-Benchmark -Title "NVENC + GPU scale/pad (scale_cuda + pad_cuda)" -Args $gpuArgs
$cpuResult = Run-Benchmark -Title "NVENC + CPU scale/pad (scale + pad)" -Args $cpuScaleArgs

Write-Host ""
Write-Host "=== Benchmark Summary ==="
Write-Host "$($gpuResult.Title): exit=$($gpuResult.ExitCode), time=$($gpuResult.Milliseconds)ms"
Write-Host "$($cpuResult.Title): exit=$($cpuResult.ExitCode), time=$($cpuResult.Milliseconds)ms"

if ($gpuResult.ExitCode -eq 0 -and $cpuResult.ExitCode -eq 0) {
  if ($gpuResult.Milliseconds -le $cpuResult.Milliseconds) {
    Write-Host "Winner: GPU-scale pipeline"
  } else {
    Write-Host "Winner: CPU-scale pipeline"
  }
} elseif ($gpuResult.ExitCode -eq 0) {
  Write-Host "Winner: GPU-scale pipeline (CPU-scale failed)"
} elseif ($cpuResult.ExitCode -eq 0) {
  Write-Host "Winner: CPU-scale pipeline (GPU-scale failed)"
} else {
  Write-Host "Both benchmark paths failed. Check FFmpeg/GPU logs."
}
