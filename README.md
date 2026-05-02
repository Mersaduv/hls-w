# HLS Media Packager

Windows desktop app (Electron + React + TypeScript) for packaging local MP4, audio tracks, and subtitles into a complete HLS VOD output.

## Features

- Offline Windows workflow (no command line required for end user)
- MP4 input probe via `ffprobe` (duration/resolution/codec/audio streams)
- Multi-audio support (external files + original audio extraction)
- Subtitle support (`.vtt` direct, `.srt` auto-convert to `.vtt`)
- Editable quality ladder (1080p/720p/480p/360p/240p bitrates)
- HLS segment duration control
- Fast packaging engine:
  - single FFmpeg video process for all selected qualities
  - automatic encoder detection (NVENC/QSV/AMF/libx264)
  - automatic fallback to CPU when hardware encode fails
  - AAC copy mode when source audio is already AAC-compatible
- One-click packaging with progress, step status, cancel
- Live FFmpeg logs + exact command visibility
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
4. Select output folder
5. Enable qualities (for acceptance test: 720p and 480p)
6. Click **Start Packaging**

Expected output:

```text
output/
  master.m3u8
  metadata.json
  video/720/index.m3u8
  video/480/index.m3u8
  audio/fa/index.m3u8
  audio/en/index.m3u8
```

## Sample FFmpeg Commands Used

### NVIDIA NVENC multi-quality (single process example)

```bash
ffmpeg -y -progress pipe:1 -nostats -hwaccel cuda -i "input.mp4" \
  -filter_complex "[0:v]split=4[v1080][v720][v480][v360];[v1080]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080out];[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out];[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out];[v360]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360out]" \
  -map "[v1080out]" -c:v:0 h264_nvenc -preset:v:0 p1 -rc:v:0 vbr -b:v:0 4500k -maxrate:v:0 5040k -bufsize:v:0 9000k -g:v:0 180 -keyint_min:v:0 180 -sc_threshold:v:0 0 -an \
  -map "[v720out]" -c:v:1 h264_nvenc -preset:v:1 p1 -rc:v:1 vbr -b:v:1 2500k -maxrate:v:1 2800k -bufsize:v:1 5000k -g:v:1 180 -keyint_min:v:1 180 -sc_threshold:v:1 0 -an \
  -map "[v480out]" -c:v:2 h264_nvenc -preset:v:2 p1 -rc:v:2 vbr -b:v:2 1100k -maxrate:v:2 1232k -bufsize:v:2 2200k -g:v:2 180 -keyint_min:v:2 180 -sc_threshold:v:2 0 -an \
  -map "[v360out]" -c:v:3 h264_nvenc -preset:v:3 p1 -rc:v:3 vbr -b:v:3 700k -maxrate:v:3 784k -bufsize:v:3 1400k -g:v:3 180 -keyint_min:v:3 180 -sc_threshold:v:3 0 -an \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/1080/seg_%03d.ts" "video/1080/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/720/seg_%03d.ts" "video/720/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/480/seg_%03d.ts" "video/480/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/360/seg_%03d.ts" "video/360/index.m3u8"
```

### CPU libx264 fallback (single process example)

```bash
ffmpeg -y -progress pipe:1 -nostats -i "input.mp4" \
  -filter_complex "[0:v]split=2[v720][v480];[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out];[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out]" \
  -map "[v720out]" -c:v:0 libx264 -preset:v:0 veryfast -profile:v:0 high -pix_fmt:v:0 yuv420p -b:v:0 2500k -maxrate:v:0 2800k -bufsize:v:0 5000k -g:v:0 180 -keyint_min:v:0 180 -sc_threshold:v:0 0 -an \
  -map "[v480out]" -c:v:1 libx264 -preset:v:1 veryfast -profile:v:1 high -pix_fmt:v:1 yuv420p -b:v:1 1100k -maxrate:v:1 1232k -bufsize:v:1 2200k -g:v:1 180 -keyint_min:v:1 180 -sc_threshold:v:1 0 -an \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/720/seg_%03d.ts" "video/720/index.m3u8" \
  -f hls -hls_time 6 -hls_playlist_type vod -hls_flags independent_segments -hls_segment_filename "video/480/seg_%03d.ts" "video/480/index.m3u8"
```

### Audio track variant (example language `fa`)

```bash
ffmpeg -y -progress pipe:1 -nostats -i "dub-fa.mp3" -map 0:a:0 -vn -c:a aac -b:a 128k -ac 2 -ar 48000 \
  -f hls -hls_time 6 -hls_playlist_type vod \
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

- App prevents overwrite unless user enables overwrite confirmation.
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
Build verification is complete:

npm run build succeeded
npm run build:win succeeded
Installer generated at release/HLS Media Packager-1.0.0-setup.exe
