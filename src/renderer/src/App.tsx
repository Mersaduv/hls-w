import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import { DEFAULT_SETTINGS, QUALITY_BUNDLES, QUALITY_PRESETS } from "@shared/defaults";
import type {
  AppSettings,
  AudioTrack,
  ContentType,
  PackageUpdateJob,
  PackageUpdateResult,
  PackagingJob,
  PackagingProgress,
  PackagingResult,
  QualityPreset,
  ScannedHlsPackage,
  SubtitleTrack,
  VideoInput,
} from "@shared/types";

type WorkMode = "package" | "update";

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

function previewSafeName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return cleaned.length > 0 ? cleaned : fallback;
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

function sourceCopyTierFolder(sourceHeight: number): string | null {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) return null;
  if (sourceHeight >= 1080) return "1080";
  if (sourceHeight >= 720) return "720";
  if (sourceHeight >= 480) return "480";
  if (sourceHeight >= 360) return "360";
  return "240";
}

function requiresUpscale(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): boolean {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return false;
  const widthScale = targetWidth / sourceWidth;
  const heightScale = targetHeight / sourceHeight;
  return Math.min(widthScale, heightScale) > 1;
}

function normalizedLang(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || "und";
}

function subtitleIdentity(name: string, language: string): string {
  return `${normalizedLang(language)}|${name.trim().toLowerCase()}`;
}

function audioIdentity(name: string, language: string, type: AudioTrack["type"]): string {
  return `${normalizedLang(language)}|${name.trim().toLowerCase()}|${type}`;
}

function buildOutputPreview(input: {
  qualities: QualityPreset[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  contentType: ContentType;
  movieTitle: string;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  videoInfo: VideoInput | null;
}): string {
  const {
    qualities,
    audioTracks,
    subtitles,
    contentType,
    movieTitle,
    seriesTitle,
    seasonNumber,
    episodeNumber,
    episodeTitle,
    videoInfo,
  } = input;
  const normalizedSeason = Number.isFinite(seasonNumber) ? Math.max(1, Math.floor(seasonNumber)) : 1;
  const normalizedEpisode = Number.isFinite(episodeNumber) ? Math.max(1, Math.floor(episodeNumber)) : 1;
  const movieFolder = previewSafeName(movieTitle.trim(), "movie-title-required");
  const seriesFolder = previewSafeName(seriesTitle.trim() || "series", "series");
  const episodeBase = `episode-${String(normalizedEpisode).padStart(2, "0")}`;
  const episodeName =
    contentType === "series" && episodeTitle.trim()
      ? `${episodeBase}-${previewSafeName(episodeTitle, "episode")}`
      : episodeBase;

  const root =
    contentType === "series"
      ? `YYYY-MM-DD/${seriesFolder}/season-${String(normalizedSeason).padStart(2, "0")}/${episodeName}/`
      : `YYYY-MM-DD/${movieFolder}/`;
  const sourceTier = videoInfo ? sourceCopyTierFolder(videoInfo.height) : null;
  const sourceName = contentType === "series" ? seriesFolder : movieFolder;

  const lines: string[] = [root, "  master.m3u8", "  metadata.json", "  video/", "    sources/"];
  if (sourceTier) {
    lines.push(`      ${sourceTier}/${sourceName}.mp4`);
  } else {
    lines.push("      {source-tier}/{title}.mp4");
  }

  for (const quality of qualities.filter((q) => q.enabled).sort((a, b) => b.height - a.height)) {
    lines.push(`    ${quality.key}/`);
    lines.push("      index.m3u8");
    lines.push("      seg_000.ts");
  }

  lines.push("  audio/");
  for (const audio of audioTracks) {
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
  const [workMode, setWorkMode] = useState<WorkMode>("package");
  const [isRunning, setIsRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [maxProgressSeen, setMaxProgressSeen] = useState(0);

  const [statusMessage, setStatusMessage] = useState("Ready.");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [currentCommand, setCurrentCommand] = useState("");
  const [masterPreview, setMasterPreview] = useState("");
  const [progress, setProgress] = useState<PackagingProgress>({
    step: "preparing",
    message: "Idle",
    percent: 0,
  });

  const [result, setResult] = useState<PackagingResult | null>(null);
  const [updateResult, setUpdateResult] = useState<PackageUpdateResult | null>(null);

  const [videoPath, setVideoPath] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInput | null>(null);
  const [contentType, setContentType] = useState<ContentType>("movie");
  const [movieTitle, setMovieTitle] = useState("");
  const [seriesTitle, setSeriesTitle] = useState("");
  const [seasonNumber, setSeasonNumber] = useState(1);
  const [episodeNumber, setEpisodeNumber] = useState(1);
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState("und");
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [qualities, setQualities] = useState<QualityPreset[]>(cloneQualityDefaults);
  const [outputDir, setOutputDir] = useState("");
  const [allowOverwrite, setAllowOverwrite] = useState(false);

  const [packageDir, setPackageDir] = useState("");
  const [scannedPackage, setScannedPackage] = useState<ScannedHlsPackage | null>(null);
  const [updateSubtitles, setUpdateSubtitles] = useState<SubtitleTrack[]>([]);
  const [updateAudioTracks, setUpdateAudioTracks] = useState<AudioTrack[]>([]);

  const [segmentDuration, setSegmentDuration] = useState(DEFAULT_SETTINGS.segmentDuration);
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffprobePath, setFfprobePath] = useState("");
  const [useHardwareAcceleration, setUseHardwareAcceleration] = useState(DEFAULT_SETTINGS.useHardwareAcceleration);
  const [performanceMode, setPerformanceMode] = useState(DEFAULT_SETTINGS.performanceMode);
  const [encoderPreference, setEncoderPreference] = useState(DEFAULT_SETTINGS.encoderPreference);
  const [audioMode, setAudioMode] = useState(DEFAULT_SETTINGS.audioMode);
  const [parallelAudioProcessing, setParallelAudioProcessing] = useState(DEFAULT_SETTINGS.parallelAudioProcessing);
  const [theme, setTheme] = useState(DEFAULT_SETTINGS.theme);
  const [encoderStatus, setEncoderStatus] = useState("Encoder detection not run yet.");
  const [vlcAvailable, setVlcAvailable] = useState(false);

  const deferredLogs = useDeferredValue(logs);
  const safeProgress = Math.min(100, Math.max(0, progress.percent));

  const outputPreview = useMemo(
    () =>
      buildOutputPreview({
        qualities,
        audioTracks,
        subtitles,
        contentType,
        movieTitle,
        seriesTitle,
        seasonNumber,
        episodeNumber,
        episodeTitle,
        videoInfo,
      }),
    [qualities, audioTracks, subtitles, contentType, movieTitle, seriesTitle, seasonNumber, episodeNumber, episodeTitle, videoInfo]
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!isRunning || startedAt === null) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
      setEtaSeconds((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, startedAt]);

  useEffect(() => {
    const offProgress = window.electronAPI.onPackagingProgress((payload) => {
      setProgress(payload);
      if (payload.currentCommand) setCurrentCommand(payload.currentCommand);

      if (payload.percent > 0 && payload.percent <= 100) {
        setMaxProgressSeen((prev) => {
          const next = Math.max(prev, payload.percent);
          if (startedAt !== null && next > 0) {
            const elapsed = Math.floor((Date.now() - startedAt) / 1000);
            const estimate = Math.max(0, Math.round((elapsed * (100 - next)) / next));
            setEtaSeconds((old) => (old === null ? estimate : Math.min(old, estimate)));
          }
          return next;
        });
      }

      if (payload.step === "completed") {
        setIsRunning(false);
        setEtaSeconds(0);
        setStatusMessage(workMode === "update" ? "Package update finished." : "Packaging finished.");
      } else if (payload.step === "failed") {
        setIsRunning(false);
      } else if (payload.step === "canceled") {
        setIsRunning(false);
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
      const vlc = await window.electronAPI.detectVlc();
      if (vlc.ok && vlc.data) setVlcAvailable(vlc.data.exists);
      const enc = await window.electronAPI.detectEncoders(undefined);
      if (enc.ok && enc.data) {
        const parts = [
          enc.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC unavailable",
          enc.data.capabilities.intelQsv ? "QSV" : "QSV unavailable",
          enc.data.capabilities.amdAmf ? "AMF" : "AMF unavailable",
          `Auto picks: ${enc.data.preferredEncoder}`,
        ];
        setEncoderStatus(parts.join(" | "));
      } else {
        setEncoderStatus(enc.error ?? "Encoder detection failed.");
      }
    })();

    return () => {
      offProgress();
      offLog();
    };
  }, [startedAt, workMode]);

  useEffect(() => {
    if (!videoInfo) return;
    setQualities((prev) =>
      prev.map((quality) => {
        const disabledBySource = requiresUpscale(videoInfo.width, videoInfo.height, quality.width, quality.height);
        return disabledBySource && quality.enabled ? { ...quality, enabled: false } : quality;
      })
    );
  }, [videoInfo]);

  function resetRunUi(): void {
    setValidationErrors([]);
    setWarnings([]);
    setLogs([]);
    setShowLogs(false);
    setShowCommand(false);
    setCurrentCommand("");
    setProgress({ step: "preparing", message: "Idle", percent: 0 });
    setIsRunning(false);
    setStartedAt(null);
    setElapsedSeconds(0);
    setEtaSeconds(null);
    setMaxProgressSeen(0);
  }

  function clearAll(): void {
    resetRunUi();
    setStatusMessage("Ready.");
    setResult(null);
    setUpdateResult(null);
    setMasterPreview("");

    setVideoPath("");
    setVideoInfo(null);
    setContentType("movie");
    setMovieTitle("");
    setSeriesTitle("");
    setSeasonNumber(1);
    setEpisodeNumber(1);
    setEpisodeTitle("");
    setPreferredAudioLanguage("und");
    setAudioTracks([]);
    setSubtitles([]);
    setQualities(cloneQualityDefaults());
    setOutputDir("");
    setAllowOverwrite(false);

    setPackageDir("");
    setScannedPackage(null);
    setUpdateSubtitles([]);
    setUpdateAudioTracks([]);
  }

  async function pickVideo(): Promise<void> {
    const selected = await window.electronAPI.pickVideo();
    if (!selected) return;
    resetRunUi();
    setStatusMessage("Analyzing video...");
    setResult(null);
    setMasterPreview("");
    setVideoPath(selected);
    const probe = await window.electronAPI.probeVideo(selected, ffprobePath.trim() || undefined);
    if (!probe.ok || !probe.data) {
      setVideoInfo(null);
      setStatusMessage(probe.error ?? "Failed to probe video.");
      return;
    }
    setVideoInfo(probe.data);
    const detectedLang = probe.data.defaultAudioLanguage?.trim().toLowerCase() || "und";
    setPreferredAudioLanguage(detectedLang);
    setWarnings(probe.warnings ?? []);
    setStatusMessage("Video analyzed successfully.");
  }

  async function pickOutputFolder(): Promise<void> {
    const selected = await window.electronAPI.pickOutputFolder();
    if (selected) setOutputDir(selected);
  }

  async function addExternalAudio(): Promise<void> {
    const picked = await window.electronAPI.pickAudio();
    if (!picked) return;
    setAudioTracks((prev) => [
      ...prev,
      {
        id: makeId(),
        source: "external",
        filePath: picked,
        name: basename(picked),
        language: preferredAudioLanguage,
        type: "dubbed",
        isDefault: prev.length === 0,
        audioOffsetMs: 0,
      },
    ]);
  }

  function addOriginalAudio(): void {
    setAudioTracks((prev) => [
      ...prev,
      {
        id: makeId(),
        source: "video-original",
        name: "Original Audio",
        language: preferredAudioLanguage,
        type: "original",
        isDefault: prev.length === 0,
      },
    ]);
  }

  function updateAudioTrack(id: string, partial: Partial<AudioTrack>): void {
    setAudioTracks((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  function removeAudioTrack(id: string): void {
    setAudioTracks((prev) => prev.filter((item) => item.id !== id));
  }

  function setDefaultAudio(id: string, enabled: boolean): void {
    setAudioTracks((prev) =>
      prev.map((item) => {
        if (item.id === id) return { ...item, isDefault: enabled };
        return enabled ? { ...item, isDefault: false } : item;
      })
    );
  }

  async function addSubtitle(): Promise<void> {
    const picked = await window.electronAPI.pickSubtitle();
    if (!picked) return;
    setSubtitles((prev) => [
      ...prev,
      {
        id: makeId(),
        filePath: picked,
        name: basename(picked),
        language: "fa",
        isDefault: false,
        inputFormat: subtitleFormat(picked),
      },
    ]);
  }

  function updateSubtitle(id: string, partial: Partial<SubtitleTrack>): void {
    setSubtitles((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  function removeSubtitle(id: string): void {
    setSubtitles((prev) => prev.filter((item) => item.id !== id));
  }

  function setDefaultSubtitle(id: string, enabled: boolean): void {
    setSubtitles((prev) =>
      prev.map((item) => {
        if (item.id === id) return { ...item, isDefault: enabled };
        return enabled ? { ...item, isDefault: false } : item;
      })
    );
  }

  function updateQuality(key: QualityPreset["key"], partial: Partial<QualityPreset>): void {
    setQualities((prev) => prev.map((item) => (item.key === key ? { ...item, ...partial } : item)));
  }

  function applyLadderPreset(mode: keyof typeof QUALITY_BUNDLES): void {
    setQualities((prev) =>
      prev.map((item) => ({
        ...item,
        enabled: true,
        bitrateKbps: QUALITY_BUNDLES[mode][item.key],
      }))
    );
  }

  function validatePackageForm(): string[] {
    const errors: string[] = [];
    if (!videoPath.trim()) errors.push("Input video is required.");
    if (!outputDir.trim()) errors.push("Output folder is required.");
    if (contentType === "movie" && !movieTitle.trim()) errors.push("Movie title is required.");
    if (contentType === "series") {
      if (!seriesTitle.trim()) errors.push("Series title is required.");
      if (!Number.isFinite(seasonNumber) || seasonNumber < 1) errors.push("Season number must be at least 1.");
      if (!Number.isFinite(episodeNumber) || episodeNumber < 1) errors.push("Episode number must be at least 1.");
    }
    if (!qualities.some((q) => q.enabled)) errors.push("Enable at least one quality.");
    if (audioTracks.length === 0) errors.push("Add at least one audio track.");
    if (segmentDuration <= 0 || Number.isNaN(segmentDuration)) errors.push("Segment duration must be greater than zero.");

    const defaultAudioCount = audioTracks.filter((a) => a.isDefault).length;
    if (defaultAudioCount > 1) errors.push("Only one default audio track is allowed.");
    if (defaultAudioCount === 0 && audioTracks.length > 0) errors.push("Set one default audio track.");

    for (const track of audioTracks) {
      if (!track.name.trim()) errors.push("Audio track name is required.");
      if (!track.language.trim()) errors.push(`Language code is required for audio track "${track.name || "Unnamed"}".`);
      if (track.source === "external" && !track.filePath) errors.push(`Audio file is required for "${track.name || "Unnamed"}".`);
    }
    for (const sub of subtitles) {
      if (!sub.name.trim()) errors.push("Subtitle name is required.");
      if (!sub.language.trim()) errors.push(`Language code is required for subtitle "${sub.name || "Unnamed"}".`);
      if (!sub.filePath) errors.push(`Subtitle file is required for "${sub.name || "Unnamed"}".`);
    }
    return errors;
  }

  async function startPackaging(): Promise<void> {
    if (isRunning) return;
    const errors = validatePackageForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setStatusMessage("Please fix validation errors.");
      return;
    }

    setValidationErrors([]);
    setWarnings([]);
    setResult(null);
    setMasterPreview("");
    setLogs([]);
    setShowLogs(true);
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setEtaSeconds(null);
    setMaxProgressSeen(0);
    setIsRunning(true);
    setStatusMessage("Starting packaging...");

    const job: PackagingJob = {
      videoPath,
      outputDir,
      movieTitle: contentType === "movie" ? movieTitle.trim() : undefined,
      contentType,
      seriesTitle: contentType === "series" ? seriesTitle.trim() : undefined,
      seasonNumber: contentType === "series" ? Math.max(1, Math.floor(seasonNumber || 1)) : undefined,
      episodeNumber: contentType === "series" ? Math.max(1, Math.floor(episodeNumber || 1)) : undefined,
      episodeTitle: contentType === "series" ? episodeTitle.trim() || undefined : undefined,
      qualities,
      audioTracks,
      subtitles,
      allowUpscaleQualities: false,
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
    setIsRunning(false);
    setStartedAt(null);
    setEtaSeconds(null);

    if (!response.ok || !response.data) {
      setStatusMessage(response.error ?? "Packaging failed.");
      return;
    }
    setWarnings(response.warnings ?? []);
    setResult(response.data);
    setStatusMessage("Packaging completed.");

    if (response.data.masterPlaylistPath) {
      const preview = await window.electronAPI.previewMaster(response.data.masterPlaylistPath);
      if (preview.ok && preview.data) setMasterPreview(preview.data);
    }
  }

  async function pickPackageFolder(): Promise<void> {
    const selected = await window.electronAPI.pickHlsPackageFolder();
    if (!selected) return;
    setPackageDir(selected);
    setScannedPackage(null);
    setUpdateResult(null);
    setValidationErrors([]);
    setMasterPreview("");
  }

  async function scanPackage(): Promise<void> {
    if (!packageDir.trim()) {
      setValidationErrors(["Select an HLS package folder first."]);
      return;
    }
    setValidationErrors([]);
    setStatusMessage("Scanning package...");
    const response = await window.electronAPI.scanHlsPackage(packageDir);
    if (!response.ok || !response.data) {
      setScannedPackage(null);
      setStatusMessage(response.error ?? "Failed to scan package.");
      return;
    }
    setScannedPackage(response.data);
    setStatusMessage("Package scanned.");
    const preview = await window.electronAPI.previewMaster(response.data.masterPlaylistPath);
    if (preview.ok && preview.data) setMasterPreview(preview.data);
  }

  useEffect(() => {
    if (workMode !== "update") return;
    if (!packageDir.trim()) return;
    void scanPackage();
  }, [packageDir, workMode]);

  async function addUpdateSubtitle(): Promise<void> {
    const picked = await window.electronAPI.pickSubtitle();
    if (!picked) return;
    setUpdateSubtitles((prev) => [
      ...prev,
      {
        id: makeId(),
        filePath: picked,
        name: basename(picked),
        language: "fa",
        isDefault: false,
        inputFormat: subtitleFormat(picked),
      },
    ]);
  }

  function updateUpdateSubtitle(id: string, partial: Partial<SubtitleTrack>): void {
    setUpdateSubtitles((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  function removeUpdateSubtitle(id: string): void {
    setUpdateSubtitles((prev) => prev.filter((item) => item.id !== id));
  }

  async function addUpdateAudio(): Promise<void> {
    const picked = await window.electronAPI.pickAudio();
    if (!picked) return;
    setUpdateAudioTracks((prev) => [
      ...prev,
      {
        id: makeId(),
        source: "external",
        filePath: picked,
        name: basename(picked),
        language: "fa",
        type: "dubbed",
        isDefault: false,
        audioOffsetMs: 0,
      },
    ]);
  }

  function updateUpdateAudio(id: string, partial: Partial<AudioTrack>): void {
    setUpdateAudioTracks((prev) => prev.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  function removeUpdateAudio(id: string): void {
    setUpdateAudioTracks((prev) => prev.filter((item) => item.id !== id));
  }

  function validateUpdateForm(): string[] {
    const errors: string[] = [];
    if (!packageDir.trim()) errors.push("Select existing HLS package folder.");
    if (!scannedPackage) errors.push("Scan the package before update.");
    if (updateSubtitles.length === 0 && updateAudioTracks.length === 0) {
      errors.push("Add at least one new subtitle or dubbed audio track.");
    }

    const newDefaultCount = updateAudioTracks.filter((a) => a.isDefault).length;
    if (newDefaultCount > 1) errors.push("Only one new audio track can be set as default.");

    for (const track of updateAudioTracks) {
      if (!track.name.trim()) errors.push("New audio track name is required.");
      if (!track.language.trim()) errors.push(`Language code is required for "${track.name || "Unnamed"}".`);
      if (!track.filePath) errors.push(`Audio file is required for "${track.name || "Unnamed"}".`);
    }
    for (const sub of updateSubtitles) {
      if (!sub.name.trim()) errors.push("New subtitle name is required.");
      if (!sub.language.trim()) errors.push(`Language code is required for subtitle "${sub.name || "Unnamed"}".`);
      if (!sub.filePath) errors.push(`Subtitle file is required for subtitle "${sub.name || "Unnamed"}".`);
    }

    const seenSubtitleKeys = new Set<string>();
    const seenAudioKeys = new Set<string>();
    const existingSubtitleKeys = new Set(
      (scannedPackage?.parsed.subtitles ?? []).map((item) => subtitleIdentity(item.name, item.language))
    );
    const existingAudioKeys = new Set(
      (scannedPackage?.parsed.audioTracks ?? []).map((item) => audioIdentity(item.name, item.language, item.type))
    );

    for (const sub of updateSubtitles) {
      const key = subtitleIdentity(sub.name, sub.language);
      if (seenSubtitleKeys.has(key)) {
        errors.push(`Duplicate subtitle in update list: "${sub.name}" (${sub.language}).`);
      }
      if (existingSubtitleKeys.has(key)) {
        errors.push(`Subtitle already exists in package: "${sub.name}" (${sub.language}).`);
      }
      seenSubtitleKeys.add(key);
    }

    for (const track of updateAudioTracks) {
      const key = audioIdentity(track.name, track.language, track.type);
      if (seenAudioKeys.has(key)) {
        errors.push(`Duplicate audio track in update list: "${track.name}" (${track.language}, ${track.type}).`);
      }
      if (existingAudioKeys.has(key)) {
        errors.push(`Audio track already exists in package: "${track.name}" (${track.language}, ${track.type}).`);
      }
      seenAudioKeys.add(key);
    }

    return errors;
  }

  async function startPackageUpdate(): Promise<void> {
    if (isRunning) return;
    const errors = validateUpdateForm();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setStatusMessage("Please fix validation errors.");
      return;
    }

    setValidationErrors([]);
    setWarnings([]);
    setUpdateResult(null);
    setMasterPreview("");
    setLogs([]);
    setShowLogs(true);
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setEtaSeconds(null);
    setMaxProgressSeen(0);
    setIsRunning(true);
    setStatusMessage("Starting package update...");

    const job: PackageUpdateJob = {
      packageDir,
      newSubtitles: updateSubtitles,
      newAudioTracks: updateAudioTracks,
      segmentDuration: scannedPackage?.segmentDuration,
      audioMode,
      parallelAudioProcessing,
      ffmpegPathOverride: ffmpegPath.trim() || undefined,
      ffprobePathOverride: ffprobePath.trim() || undefined,
    };

    const response = await window.electronAPI.startPackageUpdate(job);
    setIsRunning(false);
    setStartedAt(null);
    setEtaSeconds(null);

    if (!response.ok || !response.data) {
      setStatusMessage(response.error ?? "Package update failed.");
      return;
    }

    setWarnings(response.warnings ?? []);
    setUpdateResult(response.data);
    setStatusMessage("Package update completed.");
    if (response.data.masterPlaylistPath) {
      const preview = await window.electronAPI.previewMaster(response.data.masterPlaylistPath);
      if (preview.ok && preview.data) setMasterPreview(preview.data);
    }
    await scanPackage();
  }

  async function cancelRun(): Promise<void> {
    await window.electronAPI.cancelPackaging();
    setIsRunning(false);
    setStartedAt(null);
    setEtaSeconds(null);
    setStatusMessage("Cancel requested...");
  }

  async function autoDetectBinaries(): Promise<void> {
    const check = await window.electronAPI.resolveBinaries(ffmpegPath.trim() || undefined, ffprobePath.trim() || undefined);
    if (!check.ok || !check.data) {
      setStatusMessage(check.error ?? "Failed to resolve binaries.");
      return;
    }
    setFfmpegPath(check.data.ffmpegPath);
    setFfprobePath(check.data.ffprobePath);
    setWarnings(check.warnings ?? []);

    const encoderCheck = await window.electronAPI.detectEncoders(check.data.ffmpegPath);
    if (encoderCheck.ok && encoderCheck.data) {
      const capabilityParts = [
        encoderCheck.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC unavailable",
        encoderCheck.data.capabilities.intelQsv ? "QSV" : "QSV unavailable",
        encoderCheck.data.capabilities.amdAmf ? "AMF" : "AMF unavailable",
        `Auto picks: ${encoderCheck.data.preferredEncoder}`,
      ];
      setEncoderStatus(capabilityParts.join(" | "));
    } else {
      setEncoderStatus(encoderCheck.error ?? "Encoder detection failed.");
    }
    setStatusMessage("FFmpeg and FFprobe are ready.");
  }

  async function openOutputFolder(): Promise<void> {
    if (result?.outputDir) await window.electronAPI.openFolder(result.outputDir);
  }

  async function openUpdatedPackageFolder(): Promise<void> {
    if (updateResult?.packageDir) await window.electronAPI.openFolder(updateResult.packageDir);
  }

  async function copyMasterPath(): Promise<void> {
    if (!result?.masterPlaylistPath) return;
    await window.electronAPI.copyToClipboard(result.masterPlaylistPath);
    setStatusMessage("Master path copied.");
  }

  async function playInVlc(): Promise<void> {
    if (!result?.masterPlaylistPath) return;
    const launch = await window.electronAPI.launchVlc(result.masterPlaylistPath);
    if (!launch.ok) setStatusMessage(launch.error ?? "Could not launch VLC.");
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <h1>HLS Media Packager</h1>
          <p>Create and update HLS packages for movies and series.</p>
        </div>
        <div className="status-pill" role="status" aria-live="polite">
          {statusMessage}
        </div>
      </header>

      <nav className="mode-switch" aria-label="Work mode">
        <button
          type="button"
          className={workMode === "package" ? "primary" : "secondary"}
          disabled={isRunning}
          onClick={() => setWorkMode("package")}
        >
          New Package
        </button>
        <button
          type="button"
          className={workMode === "update" ? "primary" : "secondary"}
          disabled={isRunning}
          onClick={() => setWorkMode("update")}
        >
          Update Existing Package
        </button>
        <button type="button" className="secondary" disabled={isRunning} onClick={clearAll}>
          Clear
        </button>
      </nav>

      {validationErrors.length > 0 && (
        <section className="alert error" role="alert">
          <strong>Validation errors</strong>
          <ul>
            {validationErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {warnings.length > 0 && (
        <section className="alert warning" role="status">
          <strong>Warnings</strong>
          <ul>
            {warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="grid">
        {workMode === "package" ? (
          <>
            <article className="card">
              <h2>Input Video</h2>
              <div className="inline">
                <input value={videoPath} readOnly placeholder="Select input video file" aria-label="Selected input video" />
                <button type="button" onClick={pickVideo}>
                  Select Video
                </button>
              </div>
              {videoInfo && (
                <div className="meta-row">
                  <span>Duration: {Math.round(videoInfo.durationSeconds)}s</span>
                  <span>
                    Resolution: {videoInfo.width}x{videoInfo.height}
                  </span>
                  <span>Frame Rate: {videoInfo.frameRate > 0 ? `${videoInfo.frameRate.toFixed(3)} fps` : "unknown"}</span>
                  <span>Codec: {videoInfo.videoCodec}</span>
                  <span>Audio Streams: {videoInfo.audioStreamCount}</span>
                </div>
              )}
            </article>

            <article className="card">
              <h2>Content</h2>
              <div className="inline wrap">
                <label>
                  Content Type
                  <select value={contentType} onChange={(event) => setContentType(event.target.value as ContentType)}>
                    <option value="movie">Movie</option>
                    <option value="series">Series Episode</option>
                  </select>
                </label>
                {contentType === "movie" && (
                  <label className="grow">
                    Movie Title
                    <input value={movieTitle} onChange={(event) => setMovieTitle(event.target.value)} placeholder="Sinners" required />
                  </label>
                )}
                {contentType === "series" && (
                  <>
                    <label className="grow">
                      Series Title
                      <input value={seriesTitle} onChange={(event) => setSeriesTitle(event.target.value)} />
                    </label>
                    <label>
                      Season
                      <input type="number" min={1} value={seasonNumber} onChange={(e) => setSeasonNumber(Number.parseInt(e.target.value, 10) || 0)} />
                    </label>
                    <label>
                      Episode
                      <input type="number" min={1} value={episodeNumber} onChange={(e) => setEpisodeNumber(Number.parseInt(e.target.value, 10) || 0)} />
                    </label>
                  </>
                )}
              </div>
              {contentType === "series" && (
                <label className="grow">
                  Episode Title (Optional)
                  <input value={episodeTitle} onChange={(event) => setEpisodeTitle(event.target.value)} />
                </label>
              )}
            </article>

            <article className="card">
              <h2>Audio Tracks</h2>
              <div className="inline">
                <button type="button" onClick={addExternalAudio}>
                  Add External Audio
                </button>
                <button type="button" onClick={addOriginalAudio}>
                  Use Original Audio
                </button>
              </div>
              <div className="stack">
                {audioTracks.map((track) => (
                  <div key={track.id} className="subcard">
                    <div className="inline wrap">
                      <label className="grow">
                        Name
                        <input value={track.name} onChange={(e) => updateAudioTrack(track.id, { name: e.target.value })} />
                      </label>
                      <label>
                        Language
                        <input value={track.language} onChange={(e) => updateAudioTrack(track.id, { language: e.target.value })} />
                      </label>
                      <label>
                        Type
                        <select value={track.type} onChange={(e) => updateAudioTrack(track.id, { type: e.target.value as AudioTrack["type"] })}>
                          <option value="dubbed">dubbed</option>
                          <option value="original">original</option>
                          <option value="commentary">commentary</option>
                        </select>
                      </label>
                      <label>
                        Offset (ms)
                        <input
                          type="number"
                          step={100}
                          value={track.audioOffsetMs ?? 0}
                          onChange={(e) => updateAudioTrack(track.id, { audioOffsetMs: Number.parseInt(e.target.value, 10) || 0 })}
                        />
                      </label>
                    </div>
                    <div className="inline wrap">
                      <label className="toggle">
                        <input type="checkbox" checked={track.isDefault} onChange={(e) => setDefaultAudio(track.id, e.target.checked)} />
                        Default
                      </label>
                      {track.source === "external" && (
                        <>
                          <input value={track.filePath ?? ""} readOnly aria-label="Audio file path" />
                          <button
                            type="button"
                            onClick={async () => {
                              const selected = await window.electronAPI.pickAudio();
                              if (selected) updateAudioTrack(track.id, { filePath: selected });
                            }}
                          >
                            Pick File
                          </button>
                        </>
                      )}
                      <button type="button" className="danger" onClick={() => removeAudioTrack(track.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {audioTracks.length === 0 && <p className="muted">No audio tracks added yet.</p>}
              </div>
            </article>

            <article className="card">
              <h2>Subtitles</h2>
              <button type="button" onClick={addSubtitle}>
                Add Subtitle
              </button>
              <div className="stack">
                {subtitles.map((sub) => (
                  <div key={sub.id} className="subcard">
                    <div className="inline wrap">
                      <label className="grow">
                        Name
                        <input value={sub.name} onChange={(e) => updateSubtitle(sub.id, { name: e.target.value })} />
                      </label>
                      <label>
                        Language
                        <input value={sub.language} onChange={(e) => updateSubtitle(sub.id, { language: e.target.value })} />
                      </label>
                      <label className="toggle">
                        <input type="checkbox" checked={sub.isDefault} onChange={(e) => setDefaultSubtitle(sub.id, e.target.checked)} />
                        Default
                      </label>
                    </div>
                    <div className="inline wrap">
                      <input value={sub.filePath} readOnly aria-label="Subtitle file path" />
                      <input value={sub.inputFormat.toUpperCase()} readOnly aria-label="Subtitle format" />
                      <button
                        type="button"
                        onClick={async () => {
                          const picked = await window.electronAPI.pickSubtitle();
                          if (picked) updateSubtitle(sub.id, { filePath: picked, inputFormat: subtitleFormat(picked) });
                        }}
                      >
                        Pick File
                      </button>
                      <button type="button" className="danger" onClick={() => removeSubtitle(sub.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {subtitles.length === 0 && <p className="muted">No subtitles added yet.</p>}
              </div>
            </article>

            <article className="card">
              <h2>Quality Ladder</h2>
              <div className="inline">
                <button type="button" onClick={() => applyLadderPreset("high")}>
                  High
                </button>
                <button type="button" onClick={() => applyLadderPreset("balanced")}>
                  Balanced
                </button>
                <button type="button" onClick={() => applyLadderPreset("low")}>
                  Low Size
                </button>
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
                    .map((q) => {
                      const disabledBySource = !!videoInfo && requiresUpscale(videoInfo.width, videoInfo.height, q.width, q.height);
                      return (
                        <tr key={q.key}>
                          <td>
                            <input type="checkbox" checked={q.enabled} disabled={disabledBySource} onChange={(e) => updateQuality(q.key, { enabled: e.target.checked })} />
                          </td>
                          <td>{q.label}</td>
                          <td>
                            {q.width}x{q.height}
                          </td>
                          <td>
                            <input
                              type="number"
                              min={100}
                              step={50}
                              value={q.bitrateKbps}
                              onChange={(e) => updateQuality(q.key, { bitrateKbps: Number.parseInt(e.target.value, 10) || 0 })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </article>

            <article className="card">
              <h2>Output</h2>
              <div className="inline">
                <input value={outputDir} readOnly placeholder="Select output folder" />
                <button type="button" onClick={pickOutputFolder}>
                  Select Folder
                </button>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={allowOverwrite} onChange={(e) => setAllowOverwrite(e.target.checked)} />
                Allow overwrite for non-empty output folder
              </label>
              <pre className="tree">{outputPreview}</pre>
            </article>
          </>
        ) : (
          <>
            <article className="card">
              <h2>Existing HLS Package</h2>
              <div className="inline">
                <input value={packageDir} readOnly placeholder="Select folder containing master.m3u8" />
                <button type="button" onClick={pickPackageFolder}>
                  Select Folder
                </button>
              </div>
              {scannedPackage && (
                <>
                  <div className="meta-row">
                    <span>Variants: {scannedPackage.parsed.videoVariants.length}</span>
                    <span>Audio: {scannedPackage.parsed.audioTracks.length}</span>
                    <span>Subtitles: {scannedPackage.parsed.subtitles.length}</span>
                    <span>Segment: {scannedPackage.segmentDuration}s</span>
                    <span>Duration: {Math.round(scannedPackage.durationSeconds)}s</span>
                  </div>
                  <pre className="tree">{masterPreview || "No preview loaded yet."}</pre>
                </>
              )}
            </article>

            <article className="card">
              <h2>New Subtitles</h2>
              <button type="button" onClick={addUpdateSubtitle}>
                Add Subtitle
              </button>
              <div className="stack">
                {updateSubtitles.map((sub) => (
                  <div key={sub.id} className="subcard">
                    <div className="inline wrap">
                      <label className="grow">
                        Name
                        <input value={sub.name} onChange={(e) => updateUpdateSubtitle(sub.id, { name: e.target.value })} />
                      </label>
                      <label>
                        Language
                        <input value={sub.language} onChange={(e) => updateUpdateSubtitle(sub.id, { language: e.target.value })} />
                      </label>
                    </div>
                    <div className="inline wrap">
                      <input value={sub.filePath} readOnly />
                      <button
                        type="button"
                        onClick={async () => {
                          const picked = await window.electronAPI.pickSubtitle();
                          if (picked) updateUpdateSubtitle(sub.id, { filePath: picked, inputFormat: subtitleFormat(picked) });
                        }}
                      >
                        Pick File
                      </button>
                      <button type="button" className="danger" onClick={() => removeUpdateSubtitle(sub.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {updateSubtitles.length === 0 && <p className="muted">No new subtitles added yet.</p>}
              </div>
            </article>

            <article className="card">
              <h2>New Dubbed Audio</h2>
              <button type="button" onClick={addUpdateAudio}>
                Add Dubbed Audio
              </button>
              <div className="stack">
                {updateAudioTracks.map((track) => (
                  <div key={track.id} className="subcard">
                    <div className="inline wrap">
                      <label className="grow">
                        Name
                        <input value={track.name} onChange={(e) => updateUpdateAudio(track.id, { name: e.target.value })} />
                      </label>
                      <label>
                        Language
                        <input value={track.language} onChange={(e) => updateUpdateAudio(track.id, { language: e.target.value })} />
                      </label>
                      <label>
                        Offset (ms)
                        <input
                          type="number"
                          step={100}
                          value={track.audioOffsetMs ?? 0}
                          onChange={(e) => updateUpdateAudio(track.id, { audioOffsetMs: Number.parseInt(e.target.value, 10) || 0 })}
                        />
                      </label>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={track.isDefault}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setUpdateAudioTracks((prev) =>
                              prev.map((item) => {
                                if (item.id === track.id) return { ...item, isDefault: checked };
                                return checked ? { ...item, isDefault: false } : item;
                              })
                            );
                          }}
                        />
                        Default
                      </label>
                    </div>
                    <div className="inline wrap">
                      <input value={track.filePath ?? ""} readOnly />
                      <button
                        type="button"
                        onClick={async () => {
                          const selected = await window.electronAPI.pickAudio();
                          if (selected) updateUpdateAudio(track.id, { filePath: selected });
                        }}
                      >
                        Pick File
                      </button>
                      <button type="button" className="danger" onClick={() => removeUpdateAudio(track.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {updateAudioTracks.length === 0 && <p className="muted">No new dubbed audio added yet.</p>}
              </div>
            </article>
          </>
        )}

        <article className="card">
          <h2>{workMode === "update" ? "Update & Sync" : "Run Packaging"}</h2>
          <div className="inline">
            <button type="button" className="primary final-start" disabled={isRunning} onClick={workMode === "update" ? startPackageUpdate : startPackaging}>
              {workMode === "update" ? "Update & Sync" : "Start Packaging"}
            </button>
            <button type="button" disabled={!isRunning} onClick={cancelRun}>
              Cancel
            </button>
          </div>
          <div className="progress-wrap" aria-label="Task progress">
            <div className="progress-bar" style={{ width: `${safeProgress}%` }} />
          </div>
          <p className="muted">
            Step: <strong>{progress.step}</strong> | {progress.message}
          </p>
          <p className="muted">
            Elapsed: <strong>{formatClock(elapsedSeconds)}</strong> | ETA: <strong>{etaSeconds === null ? "--:--" : formatClock(etaSeconds)}</strong>
          </p>

          <details open={showCommand} onToggle={(e) => setShowCommand(e.currentTarget.open)}>
            <summary>Current FFmpeg Command</summary>
            <pre className="log">{currentCommand || "No command yet."}</pre>
          </details>
          <details open={showLogs} onToggle={(e) => setShowLogs(e.currentTarget.open)}>
            <summary>Logs ({deferredLogs.length})</summary>
            <pre className="log">{deferredLogs.join("\n") || "No logs yet."}</pre>
          </details>

          {workMode === "package" && result?.success && (
            <div className="result-box">
              <p>Packaging completed successfully.</p>
              <div className="inline wrap">
                <button type="button" onClick={openOutputFolder}>
                  Open Output Folder
                </button>
                <button type="button" onClick={copyMasterPath}>
                  Copy Master Path
                </button>
                <button type="button" onClick={playInVlc} disabled={!vlcAvailable}>
                  Test in VLC
                </button>
              </div>
            </div>
          )}

          {workMode === "update" && updateResult?.success && (
            <div className="result-box">
              <p>Package updated successfully.</p>
              <p className="muted">
                Added {updateResult.addedSubtitles.length} subtitle(s) and {updateResult.addedAudioTracks.length} audio track(s).
              </p>
              <button type="button" onClick={openUpdatedPackageFolder}>
                Open Package Folder
              </button>
            </div>
          )}
        </article>

        <article className="card">
          <h2>Settings</h2>
          <fieldset>
            <legend>Encoding</legend>
            <div className="inline wrap">
              <label>
                Mode
                <select value={performanceMode} onChange={(e) => setPerformanceMode(e.target.value as typeof performanceMode)}>
                  <option value="fast">Fast</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                </select>
              </label>
              <label>
                Encoder
                <select value={encoderPreference} onChange={(e) => setEncoderPreference(e.target.value as typeof encoderPreference)}>
                  <option value="auto">Auto (Recommended)</option>
                  <option value="nvidia">NVIDIA NVENC</option>
                  <option value="intel">Intel QSV</option>
                  <option value="amd">AMD AMF</option>
                  <option value="cpu">CPU libx264</option>
                </select>
              </label>
              <label>
                Audio Mode
                <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as typeof audioMode)}>
                  <option value="copy-when-possible">Copy AAC when possible</option>
                  <option value="encode-aac">Always encode AAC</option>
                </select>
              </label>
              <label>
                Segment Duration (sec)
                <input type="number" min={1} step={0.5} value={segmentDuration} onChange={(e) => setSegmentDuration(Number.parseFloat(e.target.value) || 0)} />
              </label>
              <label className="toggle">
                <input type="checkbox" checked={parallelAudioProcessing} onChange={(e) => setParallelAudioProcessing(e.target.checked)} />
                Parallel audio processing
              </label>
              <label className="toggle">
                <input type="checkbox" checked={useHardwareAcceleration} onChange={(e) => setUseHardwareAcceleration(e.target.checked)} />
                Use hardware acceleration
              </label>
              <label>
                Theme
                <select value={theme} onChange={(e) => setTheme(e.target.value as AppSettings["theme"])}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Binary Paths</legend>
            <div className="inline wrap">
              <label className="grow">
                FFmpeg Path
                <input value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="Auto-detected if empty" />
              </label>
              <label className="grow">
                FFprobe Path
                <input value={ffprobePath} onChange={(e) => setFfprobePath(e.target.value)} placeholder="Auto-detected if empty" />
              </label>
            </div>
            <div className="inline wrap">
              <button type="button" onClick={autoDetectBinaries}>
                Auto Detect FFmpeg
              </button>
              <p className="muted">{encoderStatus}</p>
            </div>
          </fieldset>
        </article>
      </section>
    </div>
  );
}
