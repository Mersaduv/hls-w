# HLS Media Packager

Windows desktop app (Electron + React + TypeScript) for packaging local video files (MP4/MKV/MOV/etc), audio tracks, and subtitles into a complete HLS VOD output.

## Features

- Offline Windows workflow (no command line required for end user)
- Video input probe via `ffprobe` (duration/resolution/codec/audio streams)
- Multi-audio support (external files + original audio extraction)
- Subtitle support (`.vtt` direct, `.srt` auto-convert to `.vtt`)
- Editable quality ladder (1080p/720p/480p/360p/240p bitrates)
- HLS segment duration control
  - default is `7.5s` (commonly yields `#EXTINF` around `7.5075` and `#EXT-X-TARGETDURATION:8` on ~23.976fps sources)
- Fast packaging engine:
  - single FFmpeg video process for all selected qualities
  - automatic encoder detection (NVENC/QSV/AMF/libx264)
  - automatic pipeline benchmark (`gpu-scale` vs `cpu-scale`) before final encode on supported hardware
  - Fast Mode speed guards:
    - auto-skip upscale renditions above source resolution
    - minimum segment duration floor (`6s`) for lower file I/O overhead
  - global FPS optimization:
    - automatic FPS cap to `24` for high-FPS sources
  - automatic fallback to CPU when hardware encode fails
  - AAC copy mode when source audio is already AAC-compatible
- One-click packaging with progress, step status, cancel
- Live FFmpeg logs + exact command visibility
- Automatic output subfolder creation per run: `selected-output/YYYY-MM-DD/<movie-name>/`
- Series episode mode with automatic structure: `selected-output/YYYY-MM-DD/<series>/season-XX/episode-XX[-title]/`
- Generates:
  - `master.m3u8`
  - per-quality video playlists and segments
  - per-language audio playlists and segments
  - `metadata.json`
- Post-completion actions:
  - open output folder
  - preview `master.m3u8`
  - copy master path
  - test in VLC (if available)

## Tech Stack

- Electron
- React
- TypeScript
- electron-vite
- electron-builder (NSIS Windows installer)

## Project Structure

```text
hls-media-packager/
  build/
  examples/
    master.example.m3u8
    metadata.example.json
  resources/
    bin/
      ffmpeg.exe        <-- place here (optional but recommended)
      ffprobe.exe       <-- place here (optional but recommended)
  src/
    main/
      index.ts
      services/
        configStore.ts
        ffmpegLocator.ts
        ffprobeService.ts
        manifestService.ts
        packagerService.ts
        subtitleService.ts
      utils/
        ffmpegParsers.ts
        stringUtils.ts
    preload/
      index.ts
    renderer/
      index.html
      src/
        App.tsx
        main.tsx
        styles.css
    shared/
      defaults.ts
      ipc.ts
      types.ts
  electron-builder.yml
  electron.vite.config.ts
  package.json
  tsconfig.json
```

## Installation

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Provide FFmpeg tools:
   - Recommended: copy `ffmpeg.exe` and `ffprobe.exe` into `resources/bin/`
   - Alternative: set custom paths in **Settings** inside the app
   - Fallback: app auto-detects from system `PATH`

## Development Run

```bash
npm run dev
```

## Production Build (Windows .exe Installer)

```bash
npm run build:win
```

Installer output will be created in:

```text
release/
```

## Example End-to-End Workflow

1. Select `input.mp4`
2. Add external audio:
   - `dub-fa.mp3` name: `دوبله فارسی`, language: `fa`, default: true, type: `dubbed`
   - `english.mp3` name: `English`, language: `en`, default: false, type: `original`
3. (Optional) Add subtitles (`.vtt` or `.srt`)
4. Select output folder (base directory)
5. Enable qualities (for acceptance test: 720p and 480p)
6. Click **Start Packaging**

Expected output:

```text
output/
  2026-05-04/
    input/
      master.m3u8
      metadata.json
      video/720/index.m3u8
      video/480/index.m3u8
      audio/fa/index.m3u8
      audio/en/index.m3u8
```

Series example:

```text
output/
  2026-05-04/
    MySeries/
      season-01/
        episode-01-Pilot/
          master.m3u8
          metadata.json
```

## Sample FFmpeg Commands Used

### NVIDIA NVENC multi-quality (single process example)

```bash
ffmpeg -y -progress pipe:1 -nostats -hwaccel cuda -i "input.mp4" \
  -filter_complex "[0:v]split=4[v1080][v720][v480][v360];[v1080]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080out];[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out];[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out];[v360]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360out]" \
  -map "[v1080out]" -c:v:0 h264_nvenc -preset:v:0 p1 -tune:v:0 ll -rc:v:0 vbr -rc-lookahead:v:0 0 -spatial-aq:v:0 0 -temporal-aq:v:0 0 -b:v:0 4500k -maxrate:v:0 5040k -bufsize:v:0 9000k -r:v:0 30 -g:v:0 180 -keyint_min:v:0 180 -force_key_frames:v:0 "expr:gte(t,n_forced*6)" -sc_threshold:v:0 0 -an \
  -map "[v720out]" -c:v:1 h264_nvenc -preset:v:1 p1 -tune:v:1 ll -rc:v:1 vbr -rc-lookahead:v:1 0 -spatial-aq:v:1 0 -temporal-aq:v:1 0 -b:v:1 2500k -maxrate:v:1 2800k -bufsize:v:1 5000k -r:v:1 30 -g:v:1 180 -keyint_min:v:1 180 -force_key_frames:v:1 "expr:gte(t,n_forced*6)" -sc_threshold:v:1 0 -an \
  -map "[v480out]" -c:v:2 h264_nvenc -preset:v:2 p1 -tune:v:2 ll -rc:v:2 vbr -rc-lookahead:v:2 0 -spatial-aq:v:2 0 -temporal-aq:v:2 0 -b:v:2 1100k -maxrate:v:2 1232k -bufsize:v:2 2200k -r:v:2 30 -g:v:2 180 -keyint_min:v:2 180 -force_key_frames:v:2 "expr:gte(t,n_forced*6)" -sc_threshold:v:2 0 -an \
  -map "[v360out]" -c:v:3 h264_nvenc -preset:v:3 p1 -tune:v:3 ll -rc:v:3 vbr -rc-lookahead:v:3 0 -spatial-aq:v:3 0 -temporal-aq:v:3 0 -b:v:3 700k -maxrate:v:3 784k -bufsize:v:3 1400k -r:v:3 30 -g:v:3 180 -keyint_min:v:3 180 -force_key_frames:v:3 "expr:gte(t,n_forced*6)" -sc_threshold:v:3 0 -an \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/1080/seg_%03d.ts" "video/1080/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/720/seg_%03d.ts" "video/720/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/480/seg_%03d.ts" "video/480/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/360/seg_%03d.ts" "video/360/index.m3u8"
```

### CPU libx264 fallback (single process example)

```bash
ffmpeg -y -progress pipe:1 -nostats -i "input.mp4" \
  -filter_complex "[0:v]split=2[v720][v480];[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out];[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out]" \
  -map "[v720out]" -c:v:0 libx264 -preset:v:0 veryfast -tune:v:0 fastdecode -threads:v:0 0 -profile:v:0 high -pix_fmt:v:0 yuv420p -b:v:0 2500k -maxrate:v:0 2800k -bufsize:v:0 5000k -r:v:0 30 -g:v:0 180 -keyint_min:v:0 180 -force_key_frames:v:0 "expr:gte(t,n_forced*6)" -sc_threshold:v:0 0 -an \
  -map "[v480out]" -c:v:1 libx264 -preset:v:1 veryfast -tune:v:1 fastdecode -threads:v:1 0 -profile:v:1 high -pix_fmt:v:1 yuv420p -b:v:1 1100k -maxrate:v:1 1232k -bufsize:v:1 2200k -r:v:1 30 -g:v:1 180 -keyint_min:v:1 180 -force_key_frames:v:1 "expr:gte(t,n_forced*6)" -sc_threshold:v:1 0 -an \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/720/seg_%03d.ts" "video/720/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags independent_segments+temp_file -hls_segment_filename "video/480/seg_%03d.ts" "video/480/index.m3u8"
```

### Audio track variant (example language `fa`)

```bash
ffmpeg -y -progress pipe:1 -nostats -i "dub-fa.mp3" -map 0:a:0 -vn -c:a aac -b:a 128k -ac 2 -ar 48000 \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_list_size 0 -hls_flags temp_file \
  -hls_segment_filename "audio/fa/seg_%03d.aac" "audio/fa/index.m3u8"
```

## Output Metadata

The app writes `metadata.json` with:

- `hls_url`
- `has_dubbed`
- `is_multi_audio`
- `has_subtitle`
- `qualities`
- `audio_tracks[]`
- `subtitles[]`

See example:
- [examples/master.example.m3u8](examples/master.example.m3u8)
- [examples/metadata.example.json](examples/metadata.example.json)

## Notes

- App creates a new dated movie folder automatically for each run.
- If same movie folder already exists for that date, app creates a unique suffix (`_2`, `_3`, ...), unless overwrite is enabled.
- Unicode / Persian / Arabic file paths are supported because arguments are passed to `spawn()` safely.
- Packaging can be canceled during FFmpeg execution.

## How to get fastest HLS packaging on Windows

1. Put `ffmpeg.exe` and `ffprobe.exe` in `resources/bin/` (or set paths in Settings).
2. In **Settings -> Speed / Performance**:
   - set `Mode` to `Fast`
   - set `Encoder` to `Auto (Recommended)`
   - keep `Parallel audio processing` enabled
   - set `Audio mode` to `Copy AAC when possible`
3. Click `Auto Detect FFmpeg` and confirm encoder status shows NVENC/QSV/AMF when available.
4. Keep only needed qualities (for fastest turn-around use 720p/480p/360p).
5. Start packaging and monitor **Current FFmpeg Command** to verify the single-process multi-quality pipeline.

If only CPU is available, the app falls back to `libx264` and shows a warning that long movies can take more time.

Optional manual benchmark script:
- `powershell -ExecutionPolicy Bypass -File scripts/benchmark-hls-pipeline.ps1 -InputPath "D:\path\movie.mp4" -SampleSeconds 45 -SegmentDuration 6 -OutputFps 30`
