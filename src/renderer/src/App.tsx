import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { DEFAULT_SETTINGS, QUALITY_BUNDLES, QUALITY_PRESETS } from "@shared/defaults";
import type {
  AppSettings,
  AudioTrack,
  PackagingJob,
  PackagingProgress,
  PackagingResult,
  QualityPreset,
  SubtitleTrack,
  VideoInput,
} from "@shared/types";

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/g).pop() ?? filePath;
}

function subtitleFormat(filePath: string): "vtt" | "srt" {
  return filePath.toLowerCase().endsWith(".srt") ? "srt" : "vtt";
}

function cloneQualityDefaults(): QualityPreset[] {
  return QUALITY_PRESETS.map((item) => ({ ...item }));
}

function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildOutputPreview(
  qualities: QualityPreset[],
  audios: AudioTrack[],
  subtitles: SubtitleTrack[]
): string {
  const lines: string[] = [
    "movie_output/",
    "  master.m3u8",
    "  metadata.json",
    "  video/",
  ];

  for (const quality of qualities.filter((q) => q.enabled).sort((a, b) => b.height - a.height)) {
    lines.push(`    ${quality.key}/`);
    lines.push("      index.m3u8");
    lines.push("      seg_000.ts");
  }

  lines.push("  audio/");
  for (const audio of audios) {
    const lang = audio.language.trim() || "und";
    lines.push(`    ${lang}/`);
    lines.push("      index.m3u8");
    lines.push("      seg_000.aac");
  }

  if (subtitles.length > 0) {
    lines.push("  subtitles/");
    for (const subtitle of subtitles) {
      const lang = subtitle.language.trim() || "und";
      lines.push(`    ${lang}.vtt`);
    }
  }

  return lines.join("\n");
}

export default function App() {
  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInput | null>(null);
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState("und");
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [qualities, setQualities] = useState<QualityPreset[]>(cloneQualityDefaults);
  const [outputDir, setOutputDir] = useState("");

  const [segmentDuration, setSegmentDuration] = useState(DEFAULT_SETTINGS.segmentDuration);
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const [useHardwareAcceleration, setUseHardwareAcceleration] = useState(
    DEFAULT_SETTINGS.useHardwareAcceleration
  );
  const [performanceMode, setPerformanceMode] = useState(DEFAULT_SETTINGS.performanceMode);
  const [encoderPreference, setEncoderPreference] = useState(DEFAULT_SETTINGS.encoderPreference);
  const [audioMode, setAudioMode] = useState(DEFAULT_SETTINGS.audioMode);
  const [parallelAudioProcessing, setParallelAudioProcessing] = useState(DEFAULT_SETTINGS.parallelAudioProcessing);
  const [encoderStatus, setEncoderStatus] = useState("Encoder detection not run yet.");
  const [theme, setTheme] = useState(DEFAULT_SETTINGS.theme);

  const [statusMessage, setStatusMessage] = useState("Ready.");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [currentCommand, setCurrentCommand] = useState("");

  const [progress, setProgress] = useState<PackagingProgress>({
    step: "preparing",
    message: "Idle",
    percent: 0,
  });
  const [isPackaging, setIsPackaging] = useState(false);
  const [result, setResult] = useState<PackagingResult | null>(null);
  const [masterPreview, setMasterPreview] = useState("");
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [vlcAvailable, setVlcAvailable] = useState(false);
  const [packagingStartedAt, setPackagingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [maxProgressSeen, setMaxProgressSeen] = useState(0);

  const deferredLogs = useDeferredValue(logs);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!isPackaging || packagingStartedAt === null) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - packagingStartedAt) / 1000)));
      setRemainingSeconds((prev) => {
        if (prev === null) return null;
        return Math.max(0, prev - 1);
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPackaging, packagingStartedAt]);

  useEffect(() => {
    const offProgress = window.electronAPI.onPackagingProgress((payload) => {
      setProgress(payload);
      if (payload.currentCommand) {
        setCurrentCommand(payload.currentCommand);
      }
      if (payload.percent > 0 && payload.percent <= 100) {
        setMaxProgressSeen((prevMax) => {
          const nextMax = Math.max(prevMax, payload.percent);
          if (packagingStartedAt !== null && nextMax > 0) {
            const elapsed = Math.max(0, Math.floor((Date.now() - packagingStartedAt) / 1000));
            const candidate = Math.max(0, Math.round((elapsed * (100 - nextMax)) / nextMax));
            setRemainingSeconds((prevRemaining) =>
              prevRemaining === null ? candidate : Math.min(prevRemaining, candidate)
            );
          }
          return nextMax;
        });
      }
      if (payload.step === "completed") {
        setIsPackaging(false);
        setRemainingSeconds(0);
        setMaxProgressSeen(100);
        setStatusMessage("Packaging finished.");
      } else if (payload.step === "failed") {
        setIsPackaging(false);
        setRemainingSeconds(null);
        setStatusMessage(payload.message);
      } else if (payload.step === "canceled") {
        setIsPackaging(false);
        setRemainingSeconds(null);
        setStatusMessage("Packaging canceled.");
      }
    });

    const offLog = window.electronAPI.onPackagingLog((line) => {
      startTransition(() => {
        setLogs((prev) => {
          const next = [...prev, line];
          return next.length > 1200 ? next.slice(next.length - 1200) : next;
        });
      });
    });

    void (async () => {
      const settings = await window.electronAPI.loadSettings();
      if (settings.ok && settings.data) {
        const loaded: AppSettings = settings.data;
        setSegmentDuration(loaded.segmentDuration);
        setUseHardwareAcceleration(loaded.useHardwareAcceleration);
        setPerformanceMode(loaded.performanceMode);
        setEncoderPreference(loaded.encoderPreference);
        setAudioMode(loaded.audioMode);
        setParallelAudioProcessing(loaded.parallelAudioProcessing);
        setTheme(loaded.theme);
        setFfmpegPath(loaded.ffmpegPath ?? "");
        setFfprobePath(loaded.ffprobePath ?? "");
        setVideoPath(loaded.recentVideoPath ?? "");
        setOutputDir(loaded.recentOutputDir ?? "");
      }

      const vlcCheck = await window.electronAPI.detectVlc();
      if (vlcCheck.ok && vlcCheck.data) {
        setVlcAvailable(vlcCheck.data.exists);
      }

      const encoderCheck = await window.electronAPI.detectEncoders(
        settings.ok && settings.data ? settings.data.ffmpegPath : undefined
      );
      if (encoderCheck.ok && encoderCheck.data) {
        const capabilityParts: string[] = [];
        capabilityParts.push(encoderCheck.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC unavailable");
        capabilityParts.push(encoderCheck.data.capabilities.intelQsv ? "QSV" : "QSV unavailable");
        capabilityParts.push(encoderCheck.data.capabilities.amdAmf ? "AMF" : "AMF unavailable");
        capabilityParts.push(`Auto picks: ${encoderCheck.data.preferredEncoder}`);
        setEncoderStatus(capabilityParts.join(" | "));
      } else {
        setEncoderStatus(encoderCheck.error ?? "Encoder detection failed.");
      }
    })();

    return () => {
      offProgress();
      offLog();
    };
  }, []);

  const outputPreview = buildOutputPreview(qualities, audioTracks, subtitles);

  const upscaleWarnings =
    !videoInfo
      ? []
      : qualities
          .filter(
            (quality) =>
              quality.enabled && (quality.width > videoInfo.width || quality.height > videoInfo.height)
          )
          .map((quality) => quality.label);

  async function pickVideo(): Promise<void> {
    const selected = await window.electronAPI.pickVideo();
    if (!selected) return;
    setVideoPath(selected);
    setResult(null);
    setMasterPreview("");
    setStatusMessage("Analyzing video with ffprobe...");

    const probe = await window.electronAPI.probeVideo(selected, ffprobePath || undefined);
    if (!probe.ok || !probe.data) {
      setVideoInfo(null);
      setStatusMessage(probe.error ?? "Failed to read video info.");
      return;
    }

    setVideoInfo(probe.data);
    const detectedAudioLanguage = probe.data.defaultAudioLanguage?.trim().toLowerCase() || "und";
    setPreferredAudioLanguage(detectedAudioLanguage);
    setAudioTracks((prev) =>
      prev.map((track) => (track.language.trim() ? track : { ...track, language: detectedAudioLanguage }))
    );
    setWarnings(probe.warnings ?? []);
    setStatusMessage("Video analyzed successfully.");
  }

  function updateAudioTrack(id: string, partial: Partial<AudioTrack>): void {
    setAudioTracks((prev) => prev.map((track) => (track.id === id ? { ...track, ...partial } : track)));
  }

  function removeAudioTrack(id: string): void {
    setAudioTracks((prev) => prev.filter((track) => track.id !== id));
  }

  async function addExternalAudio(): Promise<void> {
    const picked = await window.electronAPI.pickAudio();
    if (!picked) return;
    const track: AudioTrack = {
      id: makeId(),
      source: "external",
      filePath: picked,
      name: basename(picked),
      language: preferredAudioLanguage,
      type: "dubbed",
      isDefault: audioTracks.length === 0,
    };
    setAudioTracks((prev) => [...prev, track]);
  }

  function addOriginalAudio(): void {
    const track: AudioTrack = {
      id: makeId(),
      source: "video-original",
      name: "Original Audio",
      language: preferredAudioLanguage,
      type: "original",
      isDefault: audioTracks.length === 0,
    };
    setAudioTracks((prev) => [...prev, track]);
  }

  function setDefaultAudio(id: string, enabled: boolean): void {
    setAudioTracks((prev) =>
      prev.map((track) => {
        if (track.id === id) return { ...track, isDefault: enabled };
        return enabled ? { ...track, isDefault: false } : track;
      })
    );
  }

  async function addSubtitle(): Promise<void> {
    const picked = await window.electronAPI.pickSubtitle();
    if (!picked) return;
    const subtitle: SubtitleTrack = {
      id: makeId(),
      filePath: picked,
      name: basename(picked),
      language: "",
      isDefault: false,
      inputFormat: subtitleFormat(picked),
    };
    setSubtitles((prev) => [...prev, subtitle]);
  }

  function updateSubtitle(id: string, partial: Partial<SubtitleTrack>): void {
    setSubtitles((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  function removeSubtitle(id: string): void {
    setSubtitles((prev) => prev.filter((subtitle) => subtitle.id !== id));
  }

  function setDefaultSubtitle(id: string, enabled: boolean): void {
    setSubtitles((prev) =>
      prev.map((subtitle) => {
        if (subtitle.id === id) return { ...subtitle, isDefault: enabled };
        return enabled ? { ...subtitle, isDefault: false } : subtitle;
      })
    );
  }

  function updateQuality(key: QualityPreset["key"], partial: Partial<QualityPreset>): void {
    setQualities((prev) => prev.map((quality) => (quality.key === key ? { ...quality, ...partial } : quality)));
  }

  function applyLadderPreset(mode: keyof typeof QUALITY_BUNDLES): void {
    setQualities((prev) =>
      prev.map((quality) => ({
        ...quality,
        enabled: true,
        bitrateKbps: QUALITY_BUNDLES[mode][quality.key],
      }))
    );
  }

  async function pickOutputFolder(): Promise<void> {
    const selected = await window.electronAPI.pickOutputFolder();
    if (!selected) return;
    setOutputDir(selected);
  }

  function validateForm(): string[] {
    const errors: string[] = [];
    if (!videoPath.trim()) errors.push("Input video is required.");
    if (!outputDir.trim()) errors.push("Output folder is required.");
    if (!qualities.some((quality) => quality.enabled)) errors.push("Enable at least one quality.");
    if (audioTracks.length === 0) errors.push("Add at least one audio track or use original audio.");

    const defaultAudioCount = audioTracks.filter((track) => track.isDefault).length;
    if (defaultAudioCount > 1) errors.push("Only one default audio track is allowed.");
    if (defaultAudioCount === 0 && audioTracks.length > 0) errors.push("Set one audio track as default.");

    for (const track of audioTracks) {
      if (!track.name.trim()) errors.push("Every audio track must have a display name.");
      if (!track.language.trim()) errors.push(`Language code is required for audio track "${track.name || "Unnamed"}".`);
      if (track.source === "external" && !track.filePath) {
        errors.push(`Audio file is required for "${track.name || "Unnamed"}".`);
      }
    }

    for (const subtitle of subtitles) {
      if (!subtitle.name.trim()) errors.push("Every subtitle track must have a name.");
      if (!subtitle.language.trim()) {
        errors.push(`Language code is required for subtitle "${subtitle.name || "Unnamed"}".`);
      }
    }

    if (segmentDuration <= 0 || Number.isNaN(segmentDuration)) {
      errors.push("Segment duration must be greater than zero.");
    }

    return errors;
  }

  async function startPackaging(): Promise<void> {
    if (isPackaging) return;
    setValidationErrors([]);
    setWarnings([]);
    setResult(null);
    setMasterPreview("");

    const errors = validateForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setStatusMessage("Please fix validation errors.");
      return;
    }

    if (upscaleWarnings.length > 0) {
      const confirmed = window.confirm(
        `Selected qualities are higher than source resolution: ${upscaleWarnings.join(", ")}.\nContinue anyway?`
      );
      if (!confirmed) return;
    }

    setIsPackaging(true);
    setPackagingStartedAt(Date.now());
    setElapsedSeconds(0);
    setRemainingSeconds(null);
    setMaxProgressSeen(0);
    setLogs([]);
    setShowLogs(true);
    setStatusMessage("Starting packaging...");

    await window.electronAPI.saveSettings({
      ffmpegPath: ffmpegPath.trim() || undefined,
      ffprobePath: ffprobePath.trim() || undefined,
      segmentDuration,
      useHardwareAcceleration,
      performanceMode,
      encoderPreference,
      audioMode,
      parallelAudioProcessing,
      theme,
      recentOutputDir: outputDir,
      recentVideoPath: videoPath,
    });

    const job: PackagingJob = {
      videoPath,
      outputDir,
      qualities,
      audioTracks,
      subtitles,
      segmentDuration,
      useHardwareAcceleration,
      performanceMode,
      encoderPreference,
      audioMode,
      parallelAudioProcessing,
      allowOverwrite,
      ffmpegPathOverride: ffmpegPath.trim() || undefined,
      ffprobePathOverride: ffprobePath.trim() || undefined,
    };

    const response = await window.electronAPI.startPackaging(job);
    setIsPackaging(false);
    setPackagingStartedAt(null);
    setRemainingSeconds(null);
    if (!response.ok || !response.data) {
      setStatusMessage(response.error ?? "Packaging failed.");
      return;
    }

    setWarnings(response.warnings ?? []);
    setResult(response.data);
    if (response.data.selectedEncoder) {
      setStatusMessage(`Packaging completed. Encoder used: ${response.data.selectedEncoder}`);
    }

    if (response.data.masterPlaylistPath) {
      const preview = await window.electronAPI.previewMaster(response.data.masterPlaylistPath);
      if (preview.ok && preview.data) {
        setMasterPreview(preview.data);
      }
    }
  }

  async function cancelPackaging(): Promise<void> {
    await window.electronAPI.cancelPackaging();
    setIsPackaging(false);
    setPackagingStartedAt(null);
    setRemainingSeconds(null);
    setStatusMessage("Cancel requested...");
  }

  async function autoDetectBinaries(): Promise<void> {
    const check = await window.electronAPI.resolveBinaries(ffmpegPath || undefined, ffprobePath || undefined);
    if (!check.ok || !check.data) {
      setStatusMessage(check.error ?? "Failed to resolve ffmpeg/ffprobe.");
      return;
    }
    setFfmpegPath(check.data.ffmpegPath);
    setFfprobePath(check.data.ffprobePath);
    setWarnings(check.warnings ?? []);
    const encoderCheck = await window.electronAPI.detectEncoders(check.data.ffmpegPath);
    if (encoderCheck.ok && encoderCheck.data) {
      const capabilityParts: string[] = [];
      capabilityParts.push(encoderCheck.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC unavailable");
      capabilityParts.push(encoderCheck.data.capabilities.intelQsv ? "QSV" : "QSV unavailable");
      capabilityParts.push(encoderCheck.data.capabilities.amdAmf ? "AMF" : "AMF unavailable");
      capabilityParts.push(`Auto picks: ${encoderCheck.data.preferredEncoder}`);
      setEncoderStatus(capabilityParts.join(" | "));
    } else {
      setEncoderStatus(encoderCheck.error ?? "Encoder detection failed.");
    }
    setStatusMessage("FFmpeg and FFprobe are ready.");
  }

  async function openOutputFolder(): Promise<void> {
    if (!result?.outputDir) return;
    await window.electronAPI.openFolder(result.outputDir);
  }

  async function copyMasterPath(): Promise<void> {
    if (!result?.masterPlaylistPath) return;
    await window.electronAPI.copyToClipboard(result.masterPlaylistPath);
    setStatusMessage("Master path copied to clipboard.");
  }

  async function playInVlc(): Promise<void> {
    if (!result?.masterPlaylistPath) return;
    const launch = await window.electronAPI.launchVlc(result.masterPlaylistPath);
    if (!launch.ok) {
      setStatusMessage(launch.error ?? "Could not launch VLC.");
    }
  }

  const safeProgress = Math.min(100, Math.max(0, progress.percent));
  const etaSeconds = isPackaging ? remainingSeconds : null;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <h1>HLS Media Packager</h1>
          <p>Package MP4 + multi-audio + subtitles into a complete HLS VOD output.</p>
        </div>
        <div className="status-pill">{statusMessage}</div>
      </header>

      {validationErrors.length > 0 && (
        <section className="alert error">
          <strong>Validation errors</strong>
          {validationErrors.map((item) => (
            <div key={item}>{item}</div>
          ))}
        </section>
      )}

      {warnings.length > 0 && (
        <section className="alert warning">
          <strong>Warnings</strong>
          {warnings.map((item) => (
            <div key={item}>{item}</div>
          ))}
        </section>
      )}

      <section className="grid">
        <article className="card">
          <h2>A. Input Video</h2>
          <div className="inline">
            <input value={videoPath} readOnly placeholder="Select input .mp4 file" />
            <button onClick={pickVideo}>Select MP4</button>
          </div>
          {videoInfo && (
            <div className="meta-row">
              <span>Duration: {Math.round(videoInfo.durationSeconds)}s</span>
              <span>
                Resolution: {videoInfo.width}x{videoInfo.height}
              </span>
              <span>Video codec: {videoInfo.videoCodec}</span>
              <span>Audio streams: {videoInfo.audioStreamCount}</span>
            </div>
          )}
        </article>

        <article className="card">
          <h2>B. Audio Tracks</h2>
          <div className="inline">
            <button onClick={addExternalAudio}>Add Audio Track</button>
            <button onClick={addOriginalAudio}>Use Original Audio From Video</button>
          </div>
          <div className="stack">
            {audioTracks.map((track) => (
              <div key={track.id} className="subcard">
                <div className="inline wrap">
                  <label className="grow">
                    Source
                    <input value={track.source === "external" ? "external file" : "video original"} readOnly />
                  </label>
                  {track.source === "external" && (
                    <>
                      <label className="grow">
                        File
                        <input value={track.filePath ?? ""} readOnly />
                      </label>
                      <button
                        onClick={async () => {
                          const selected = await window.electronAPI.pickAudio();
                          if (selected) updateAudioTrack(track.id, { filePath: selected });
                        }}
                      >
                        Pick File
                      </button>
                    </>
                  )}
                </div>

                <div className="inline wrap">
                  <label className="grow">
                    Display Name
                    <input
                      value={track.name}
                      onChange={(event) => updateAudioTrack(track.id, { name: event.target.value })}
                      placeholder="دوبله فارسی"
                    />
                  </label>
                  <label>
                    Language
                    <input
                      value={track.language}
                      onChange={(event) => updateAudioTrack(track.id, { language: event.target.value })}
                      placeholder="fa"
                    />
                  </label>
                  <label>
                    Type
                    <select
                      value={track.type}
                      onChange={(event) => updateAudioTrack(track.id, { type: event.target.value as AudioTrack["type"] })}
                    >
                      <option value="dubbed">dubbed</option>
                      <option value="original">original</option>
                      <option value="commentary">commentary</option>
                    </select>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={track.isDefault}
                      onChange={(event) => setDefaultAudio(track.id, event.target.checked)}
                    />
                    Default
                  </label>
                  <button className="danger" onClick={() => removeAudioTrack(track.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {audioTracks.length === 0 && <p className="muted">No audio tracks added.</p>}
          </div>
        </article>

        <article className="card">
          <h2>C. Subtitles</h2>
          <button onClick={addSubtitle}>Add Subtitle</button>
          <div className="stack">
            {subtitles.map((subtitle) => (
              <div key={subtitle.id} className="subcard">
                <div className="inline wrap">
                  <label className="grow">
                    File
                    <input value={subtitle.filePath} readOnly />
                  </label>
                  <label>
                    Format
                    <input value={subtitle.inputFormat.toUpperCase()} readOnly />
                  </label>
                  <button
                    onClick={async () => {
                      const picked = await window.electronAPI.pickSubtitle();
                      if (picked) {
                        updateSubtitle(subtitle.id, { filePath: picked, inputFormat: subtitleFormat(picked) });
                      }
                    }}
                  >
                    Pick File
                  </button>
                </div>

                <div className="inline wrap">
                  <label className="grow">
                    Subtitle Name
                    <input
                      value={subtitle.name}
                      onChange={(event) => updateSubtitle(subtitle.id, { name: event.target.value })}
                      placeholder="Persian Subtitle"
                    />
                  </label>
                  <label>
                    Language
                    <input
                      value={subtitle.language}
                      onChange={(event) => updateSubtitle(subtitle.id, { language: event.target.value })}
                      placeholder="fa"
                    />
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={subtitle.isDefault}
                      onChange={(event) => setDefaultSubtitle(subtitle.id, event.target.checked)}
                    />
                    Default
                  </label>
                  <button className="danger" onClick={() => removeSubtitle(subtitle.id)}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {subtitles.length === 0 && <p className="muted">No subtitles added.</p>}
          </div>
        </article>

        <article className="card">
          <h2>D. Quality Ladder</h2>
          <div className="inline">
            <button onClick={() => applyLadderPreset("high")}>High quality</button>
            <button onClick={() => applyLadderPreset("balanced")}>Balanced</button>
            <button onClick={() => applyLadderPreset("low")}>Low size</button>
          </div>
          <table className="quality-table">
            <thead>
              <tr>
                <th>Enable</th>
                <th>Quality</th>
                <th>Resolution</th>
                <th>Bitrate (k)</th>
              </tr>
            </thead>
            <tbody>
              {qualities
                .slice()
                .sort((a, b) => b.height - a.height)
                .map((quality) => (
                  <tr key={quality.key}>
                    <td>
                      <input
                        type="checkbox"
                        checked={quality.enabled}
                        onChange={(event) => updateQuality(quality.key, { enabled: event.target.checked })}
                      />
                    </td>
                    <td>{quality.label}</td>
                    <td>
                      {quality.width}x{quality.height}
                    </td>
                    <td>
                      <input
                        type="number"
                        min={100}
                        step={50}
                        value={quality.bitrateKbps}
                        onChange={(event) =>
                          updateQuality(quality.key, { bitrateKbps: Number.parseInt(event.target.value, 10) || 0 })
                        }
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </article>

        <article className="card">
          <h2>E. Output</h2>
          <div className="inline">
            <input value={outputDir} readOnly placeholder="Select output folder" />
            <button onClick={pickOutputFolder}>Select Folder</button>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={allowOverwrite}
              onChange={(event) => setAllowOverwrite(event.target.checked)}
            />
            Allow overwrite if output folder is not empty
          </label>
          <pre className="tree">{outputPreview}</pre>
        </article>

        <article className="card">
          <h2>F. Packaging</h2>
          <div className="inline">
            <button className="primary final-start" disabled={isPackaging} onClick={startPackaging}>
              START
            </button>
            <button disabled={!isPackaging} onClick={cancelPackaging}>
              Cancel
            </button>
          </div>
          <div className="progress-wrap">
            <div className="progress-bar" style={{ width: `${safeProgress}%` }} />
          </div>
          <p className="muted">
            Step: <strong>{progress.step}</strong> | {progress.message}
          </p>
          <p className="muted timing-row">
            Elapsed: <strong>{formatClock(elapsedSeconds)}</strong>
          </p>

          <details open={showCommand} onToggle={(event) => setShowCommand(event.currentTarget.open)}>
            <summary>Current FFmpeg Command</summary>
            <pre className="log">{currentCommand || "No command yet."}</pre>
          </details>

          <details open={showLogs} onToggle={(event) => setShowLogs(event.currentTarget.open)}>
            <summary>FFmpeg Logs ({deferredLogs.length})</summary>
            <pre className="log">{deferredLogs.join("\n") || "No logs yet."}</pre>
          </details>

          {result?.success && (
            <div className="result-box">
              <p>Packaging complete.</p>
              <div className="inline wrap">
                <button onClick={openOutputFolder}>Open Output Folder</button>
                <button
                  onClick={async () => {
                    if (result.masterPlaylistPath) {
                      const preview = await window.electronAPI.previewMaster(result.masterPlaylistPath);
                      if (preview.ok && preview.data) {
                        setMasterPreview(preview.data);
                        setStatusMessage("Loaded master.m3u8 preview.");
                      }
                    }
                  }}
                >
                  Preview master.m3u8
                </button>
                <button onClick={copyMasterPath}>Copy Master Path</button>
                <button onClick={playInVlc} disabled={!vlcAvailable}>
                  Test in VLC
                </button>
                <button
                  onClick={async () => {
                    if (result.metadataPath) {
                      await window.electronAPI.showInFolder(result.metadataPath);
                    }
                  }}
                >
                  Save metadata.json
                </button>
              </div>
            </div>
          )}

          {masterPreview && (
            <div>
              <h3>Generated master.m3u8</h3>
              <pre className="log">{masterPreview}</pre>
            </div>
          )}
        </article>

        <article className="card">
          <h2>G. Settings</h2>
          <h3>Speed / Performance</h3>
          <div className="inline wrap">
            <label>
              Mode
              <select
                value={performanceMode}
                onChange={(event) =>
                  setPerformanceMode(event.target.value as typeof performanceMode)
                }
              >
                <option value="fast">Fast</option>
                <option value="balanced">Balanced</option>
                <option value="quality">Quality</option>
              </select>
            </label>
            <label>
              Encoder
              <select
                value={encoderPreference}
                onChange={(event) =>
                  setEncoderPreference(event.target.value as typeof encoderPreference)
                }
              >
                <option value="auto">Auto (Recommended)</option>
                <option value="nvidia">NVIDIA NVENC (h264_nvenc)</option>
                <option value="intel">Intel QSV (h264_qsv)</option>
                <option value="amd">AMD AMF (h264_amf)</option>
                <option value="cpu">CPU libx264</option>
              </select>
            </label>
            <label>
              Audio Mode
              <select
                value={audioMode}
                onChange={(event) =>
                  setAudioMode(event.target.value as typeof audioMode)
                }
              >
                <option value="copy-when-possible">Copy AAC when possible</option>
                <option value="encode-aac">Always encode AAC</option>
              </select>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={parallelAudioProcessing}
                onChange={(event) => setParallelAudioProcessing(event.target.checked)}
              />
              Parallel audio processing
            </label>
          </div>
          <p className="muted">Encoder status: {encoderStatus}</p>

          <div className="inline wrap">
            <label className="grow">
              FFmpeg Path
              <input
                value={ffmpegPath}
                onChange={(event) => setFfmpegPath(event.target.value)}
                placeholder="Auto-detected if empty"
              />
            </label>
            <label className="grow">
              FFprobe Path
              <input
                value={ffprobePath}
                onChange={(event) => setFfprobePath(event.target.value)}
                placeholder="Auto-detected if empty"
              />
            </label>
          </div>
          <div className="inline wrap">
            <label>
              Segment Duration (sec)
              <input
                type="number"
                min={1}
                value={segmentDuration}
                onChange={(event) => setSegmentDuration(Number.parseInt(event.target.value, 10) || 0)}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={useHardwareAcceleration}
                onChange={(event) => setUseHardwareAcceleration(event.target.checked)}
              />
              Use Hardware Acceleration
            </label>
            <label>
              Theme
              <select value={theme} onChange={(event) => setTheme(event.target.value as AppSettings["theme"])}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <button onClick={autoDetectBinaries}>Auto Detect FFmpeg</button>
          </div>

          <div className="result-box">
            <strong>Speed Tips</strong>
            <p className="muted">Use GPU encoder for fastest speed.</p>
            <p className="muted">Disable 1080p if source is below 1080p.</p>
            <p className="muted">Use 720p/480p/360p for faster output.</p>
            <p className="muted">Use AAC copy when possible.</p>
            <p className="muted">Use Fast mode for daily media publishing.</p>
          </div>
        </article>
      </section>
    </div>
  );
}
