import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_SETTINGS, QUALITY_BUNDLES } from "@shared/defaults";
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
import {
  applySourceAwareQualities,
  audioIdentity,
  basename,
  buildOutputPreview,
  cloneQualityDefaults,
  createDefaultOriginalAudio,
  makeId,
  requiresUpscale,
  subtitleFormat,
  subtitleIdentity,
  titleFromFilePath,
} from "@renderer/lib/helpers";
import type { AppView, PackageStep, ReadinessItem, UpdateStep, WorkMode } from "./types";

interface PackagerContextValue {
  view: AppView;
  workMode: WorkMode;
  packageStep: PackageStep;
  updateStep: UpdateStep;
  isRunning: boolean;
  elapsedSeconds: number;
  etaSeconds: number | null;
  statusMessage: string;
  warnings: string[];
  validationErrors: string[];
  logs: string[];
  showLogs: boolean;
  setShowLogs: (value: boolean) => void;
  showCommand: boolean;
  setShowCommand: (value: boolean) => void;
  currentCommand: string;
  masterPreview: string;
  progress: PackagingProgress;
  result: PackagingResult | null;
  updateResult: PackageUpdateResult | null;
  videoPath: string;
  videoInfo: VideoInput | null;
  contentType: ContentType;
  movieTitle: string;
  setMovieTitle: (value: string) => void;
  seriesTitle: string;
  setSeriesTitle: (value: string) => void;
  seasonNumber: number;
  setSeasonNumber: (value: number) => void;
  episodeNumber: number;
  setEpisodeNumber: (value: number) => void;
  episodeTitle: string;
  setEpisodeTitle: (value: string) => void;
  preferredAudioLanguage: string;
  setPreferredAudioLanguage: (value: string) => void;
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  qualities: QualityPreset[];
  outputDir: string;
  allowOverwrite: boolean;
  setAllowOverwrite: (value: boolean) => void;
  packageDir: string;
  scannedPackage: ScannedHlsPackage | null;
  updateSubtitles: SubtitleTrack[];
  updateAudioTracks: AudioTrack[];
  segmentDuration: number;
  setSegmentDuration: (value: number) => void;
  ffmpegPath: string;
  setFfmpegPath: (value: string) => void;
  ffprobePath: string;
  setFfprobePath: (value: string) => void;
  useHardwareAcceleration: boolean;
  setUseHardwareAcceleration: (value: boolean) => void;
  performanceMode: AppSettings["performanceMode"];
  setPerformanceMode: (value: AppSettings["performanceMode"]) => void;
  encoderPreference: AppSettings["encoderPreference"];
  setEncoderPreference: (value: AppSettings["encoderPreference"]) => void;
  audioMode: AppSettings["audioMode"];
  setAudioMode: (value: AppSettings["audioMode"]) => void;
  parallelAudioProcessing: boolean;
  setParallelAudioProcessing: (value: boolean) => void;
  theme: AppSettings["theme"];
  setTheme: (value: AppSettings["theme"]) => void;
  encoderStatus: string;
  vlcAvailable: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (value: boolean) => void;
  outputPreview: string;
  safeProgress: number;
  readiness: ReadinessItem[];
  jobReady: boolean;
  jobTitle: string;
  beginJob: (kind: "movie" | "series" | "update") => void;
  goHome: () => void;
  setPackageStep: (step: PackageStep) => void;
  setUpdateStep: (step: UpdateStep) => void;
  goNext: () => void;
  goBack: () => void;
  loadVideo: (path: string) => Promise<void>;
  pickVideo: () => Promise<void>;
  pickOutputFolder: () => Promise<void>;
  addExternalAudio: () => Promise<void>;
  addOriginalAudio: () => void;
  updateAudioTrack: (id: string, partial: Partial<AudioTrack>) => void;
  removeAudioTrack: (id: string) => void;
  setDefaultAudio: (id: string, enabled: boolean) => void;
  addSubtitle: () => Promise<void>;
  updateSubtitle: (id: string, partial: Partial<SubtitleTrack>) => void;
  removeSubtitle: (id: string) => void;
  setDefaultSubtitle: (id: string, enabled: boolean) => void;
  updateQuality: (key: QualityPreset["key"], partial: Partial<QualityPreset>) => void;
  applyLadderPreset: (mode: keyof typeof QUALITY_BUNDLES) => void;
  startPackaging: () => Promise<void>;
  pickPackageFolder: () => Promise<void>;
  scanPackage: () => Promise<void>;
  addUpdateSubtitle: () => Promise<void>;
  updateUpdateSubtitle: (id: string, partial: Partial<SubtitleTrack>) => void;
  removeUpdateSubtitle: (id: string) => void;
  addUpdateAudio: () => Promise<void>;
  updateUpdateAudio: (id: string, partial: Partial<AudioTrack>) => void;
  removeUpdateAudio: (id: string) => void;
  startPackageUpdate: () => Promise<void>;
  cancelRun: () => Promise<void>;
  autoDetectBinaries: () => Promise<void>;
  openOutputFolder: () => Promise<void>;
  openUpdatedPackageFolder: () => Promise<void>;
  copyMasterPath: () => Promise<void>;
  playInVlc: () => Promise<void>;
  startCurrentJob: () => Promise<void>;
}

const PackagerContext = createContext<PackagerContextValue | null>(null);

export function usePackager(): PackagerContextValue {
  const value = useContext(PackagerContext);
  if (!value) throw new Error("usePackager must be used inside PackagerProvider");
  return value;
}

export function PackagerProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AppView>("home");
  const [workMode, setWorkMode] = useState<WorkMode>("package");
  const [packageStep, setPackageStep] = useState<PackageStep>("source");
  const [updateStep, setUpdateStep] = useState<UpdateStep>("package");
  const [settingsOpen, setSettingsOpen] = useState(false);

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
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState("fa");
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
  const [encoderStatus, setEncoderStatus] = useState("Detecting encoders...");
  const [vlcAvailable, setVlcAvailable] = useState(false);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const workModeRef = useRef<WorkMode>(workMode);
  startedAtRef.current = startedAt;
  workModeRef.current = workMode;

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

  const jobTitle = useMemo(() => {
    if (workMode === "update") return scannedPackage ? basename(packageDir) : "Existing package";
    if (contentType === "series") {
      const series = seriesTitle.trim() || "Untitled series";
      return `${series} · S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
    }
    return movieTitle.trim() || "Untitled movie";
  }, [workMode, scannedPackage, packageDir, contentType, seriesTitle, seasonNumber, episodeNumber, movieTitle]);

  const readiness = useMemo<ReadinessItem[]>(() => {
    if (workMode === "update") {
      return [
        { id: "folder", label: "HLS package selected", ok: Boolean(packageDir.trim()) },
        { id: "scan", label: "Package scanned", ok: Boolean(scannedPackage) },
        {
          id: "tracks",
          label: "New audio or subtitle added",
          ok: updateSubtitles.length > 0 || updateAudioTracks.length > 0,
        },
      ];
    }
    return [
      { id: "video", label: "Source video analyzed", ok: Boolean(videoPath && videoInfo) },
      {
        id: "title",
        label: contentType === "movie" ? "Movie title set" : "Series title set",
        ok: contentType === "movie" ? Boolean(movieTitle.trim()) : Boolean(seriesTitle.trim()),
      },
      { id: "audio", label: "At least one audio track", ok: audioTracks.length > 0 },
      { id: "quality", label: "Quality ladder enabled", ok: qualities.some((q) => q.enabled) },
      { id: "output", label: "Destination folder set", ok: Boolean(outputDir.trim()) },
    ];
  }, [
    workMode,
    packageDir,
    scannedPackage,
    updateSubtitles.length,
    updateAudioTracks.length,
    videoPath,
    videoInfo,
    contentType,
    movieTitle,
    seriesTitle,
    audioTracks.length,
    qualities,
    outputDir,
  ]);

  const jobReady = readiness.every((item) => item.ok);

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
          const started = startedAtRef.current;
          if (started !== null && next > 0) {
            const elapsed = Math.floor((Date.now() - started) / 1000);
            const estimate = Math.max(0, Math.round((elapsed * (100 - next)) / next));
            setEtaSeconds((old) => (old === null ? estimate : Math.min(old, estimate)));
          }
          return next;
        });
      }

      if (payload.step === "completed") {
        setIsRunning(false);
        setEtaSeconds(0);
        setStatusMessage(workModeRef.current === "update" ? "Package update finished." : "Packaging finished.");
      } else if (payload.step === "failed" || payload.step === "canceled") {
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
      const settings = await window.electronAPI.loadSettings();
      if (settings.ok && settings.data) {
        const data = settings.data;
        setSegmentDuration(data.segmentDuration);
        setUseHardwareAcceleration(data.useHardwareAcceleration);
        setPerformanceMode(data.performanceMode);
        setEncoderPreference(data.encoderPreference);
        setAudioMode(data.audioMode);
        setParallelAudioProcessing(data.parallelAudioProcessing);
        setTheme(data.theme);
        setFfmpegPath(data.ffmpegPath ?? "");
        setFfprobePath(data.ffprobePath ?? "");
        if (data.recentOutputDir) setOutputDir(data.recentOutputDir);
        if (data.recentMovieTitle) setMovieTitle(data.recentMovieTitle);
        if (data.recentSeriesTitle) setSeriesTitle(data.recentSeriesTitle);
        if (data.recentSeasonNumber) setSeasonNumber(data.recentSeasonNumber);
        if (data.recentEpisodeNumber) setEpisodeNumber(data.recentEpisodeNumber);
        if (data.recentEpisodeTitle) setEpisodeTitle(data.recentEpisodeTitle);
      }
      setSettingsHydrated(true);

      const vlc = await window.electronAPI.detectVlc();
      if (vlc.ok && vlc.data) setVlcAvailable(vlc.data.exists);
      const enc = await window.electronAPI.detectEncoders(undefined);
      if (enc.ok && enc.data) {
        const parts = [
          enc.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC off",
          enc.data.capabilities.intelQsv ? "QSV" : "QSV off",
          enc.data.capabilities.amdAmf ? "AMF" : "AMF off",
          `Auto: ${enc.data.preferredEncoder}`,
        ];
        setEncoderStatus(parts.join("  ·  "));
      } else {
        setEncoderStatus(enc.error ?? "Encoder detection failed.");
      }
    })();

    return () => {
      offProgress();
      offLog();
    };
  }, []);

  useEffect(() => {
    if (!videoInfo) return;
    setQualities((prev) =>
      prev.map((quality) => {
        const disabledBySource = requiresUpscale(videoInfo.width, videoInfo.height, quality.width, quality.height);
        return disabledBySource && quality.enabled ? { ...quality, enabled: false } : quality;
      })
    );
  }, [videoInfo]);

  useEffect(() => {
    if (!settingsHydrated) return;
    const timer = window.setTimeout(() => {
      void window.electronAPI.saveSettings({
        segmentDuration,
        useHardwareAcceleration,
        performanceMode,
        encoderPreference,
        audioMode,
        parallelAudioProcessing,
        theme,
        ffmpegPath: ffmpegPath.trim() || undefined,
        ffprobePath: ffprobePath.trim() || undefined,
        recentOutputDir: outputDir.trim() || undefined,
        recentContentType: contentType,
        recentMovieTitle: movieTitle.trim() || undefined,
        recentSeriesTitle: seriesTitle.trim() || undefined,
        recentSeasonNumber: seasonNumber,
        recentEpisodeNumber: episodeNumber,
        recentEpisodeTitle: episodeTitle.trim() || undefined,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    settingsHydrated,
    segmentDuration,
    useHardwareAcceleration,
    performanceMode,
    encoderPreference,
    audioMode,
    parallelAudioProcessing,
    theme,
    ffmpegPath,
    ffprobePath,
    outputDir,
    contentType,
    movieTitle,
    seriesTitle,
    seasonNumber,
    episodeNumber,
    episodeTitle,
  ]);

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

  function resetJobFields(): void {
    resetRunUi();
    setStatusMessage("Ready.");
    setResult(null);
    setUpdateResult(null);
    setMasterPreview("");
    setVideoPath("");
    setVideoInfo(null);
    setPreferredAudioLanguage("fa");
    setAudioTracks([]);
    setSubtitles([]);
    setQualities(cloneQualityDefaults());
    setAllowOverwrite(false);
    setPackageDir("");
    setScannedPackage(null);
    setUpdateSubtitles([]);
    setUpdateAudioTracks([]);
  }

  const beginJob = useCallback((kind: "movie" | "series" | "update") => {
    resetJobFields();
    if (kind === "update") {
      setWorkMode("update");
      setUpdateStep("package");
    } else {
      setWorkMode("package");
      setContentType(kind);
      setPackageStep("source");
    }
    setView("workbench");
    setStatusMessage(kind === "update" ? "Open an existing HLS package." : "Import the source master.");
  }, []);

  const goHome = useCallback(() => {
    if (isRunning) return;
    setView("home");
    setSettingsOpen(false);
    setStatusMessage("Ready.");
  }, [isRunning]);

  const goNext = useCallback(() => {
    if (workMode === "package") {
      const order: PackageStep[] = ["source", "identity", "audio", "subtitles", "ladder", "destination", "encode"];
      const idx = order.indexOf(packageStep);
      if (idx < order.length - 1) setPackageStep(order[idx + 1]);
      return;
    }
    const order: UpdateStep[] = ["package", "tracks", "encode"];
    const idx = order.indexOf(updateStep);
    if (idx < order.length - 1) setUpdateStep(order[idx + 1]);
  }, [workMode, packageStep, updateStep]);

  const goBack = useCallback(() => {
    if (workMode === "package") {
      const order: PackageStep[] = ["source", "identity", "audio", "subtitles", "ladder", "destination", "encode"];
      const idx = order.indexOf(packageStep);
      if (idx <= 0) {
        goHome();
        return;
      }
      setPackageStep(order[idx - 1]);
      return;
    }
    const order: UpdateStep[] = ["package", "tracks", "encode"];
    const idx = order.indexOf(updateStep);
    if (idx <= 0) {
      goHome();
      return;
    }
    setUpdateStep(order[idx - 1]);
  }, [workMode, packageStep, updateStep, goHome]);

  const loadVideo = useCallback(
    async (selected: string) => {
      resetRunUi();
      setStatusMessage("Analyzing source...");
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
      const detectedLang = probe.data.defaultAudioLanguage?.trim().toLowerCase() || preferredAudioLanguage;
      setPreferredAudioLanguage(detectedLang);
      setAudioTracks([createDefaultOriginalAudio(detectedLang)]);
      setQualities(applySourceAwareQualities(probe.data));
      setWarnings(probe.warnings ?? []);
      setStatusMessage("Source analyzed.");
      const baseTitle = titleFromFilePath(selected);
      if (contentType === "movie" && !movieTitle.trim()) {
        setMovieTitle(baseTitle);
      }
      if (contentType === "series" && !seriesTitle.trim()) {
        setSeriesTitle(baseTitle);
      }
      void window.electronAPI.saveSettings({ recentVideoPath: selected });
    },
    [ffprobePath, preferredAudioLanguage, movieTitle, seriesTitle, contentType]
  );

  async function pickVideo(): Promise<void> {
    const selected = await window.electronAPI.pickVideo();
    if (!selected) return;
    await loadVideo(selected);
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
        name: basename(picked).replace(/\.[^.]+$/, ""),
        language: preferredAudioLanguage,
        type: "dubbed",
        isDefault: false,
        audioOffsetMs: 0,
      },
    ]);
  }

  function addOriginalAudio(): void {
    setAudioTracks((prev) => {
      if (prev.some((track) => track.source === "video-original")) return prev;
      return [...prev, { ...createDefaultOriginalAudio(preferredAudioLanguage), isDefault: prev.length === 0 }];
    });
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
        name: basename(picked).replace(/\.[^.]+$/, ""),
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
      setStatusMessage("Fix the job checklist before encoding.");
      setPackageStep("encode");
      return;
    }

    setValidationErrors([]);
    setWarnings([]);
    setResult(null);
    setMasterPreview("");
    setLogs([]);
    setShowLogs(true);
    setPackageStep("encode");
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setEtaSeconds(null);
    setMaxProgressSeen(0);
    setIsRunning(true);
    setStatusMessage("Packaging...");

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

  const scanPackage = useCallback(async () => {
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
  }, [packageDir]);

  useEffect(() => {
    if (workMode !== "update") return;
    if (!packageDir.trim()) return;
    void scanPackage();
  }, [packageDir, workMode, scanPackage]);

  async function addUpdateSubtitle(): Promise<void> {
    const picked = await window.electronAPI.pickSubtitle();
    if (!picked) return;
    setUpdateSubtitles((prev) => [
      ...prev,
      {
        id: makeId(),
        filePath: picked,
        name: basename(picked).replace(/\.[^.]+$/, ""),
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
        name: basename(picked).replace(/\.[^.]+$/, ""),
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
      setStatusMessage("Fix the job checklist before syncing.");
      setUpdateStep("encode");
      return;
    }

    setValidationErrors([]);
    setWarnings([]);
    setUpdateResult(null);
    setMasterPreview("");
    setLogs([]);
    setShowLogs(true);
    setUpdateStep("encode");
    setStartedAt(Date.now());
    setElapsedSeconds(0);
    setEtaSeconds(null);
    setMaxProgressSeen(0);
    setIsRunning(true);
    setStatusMessage("Updating package...");

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
        encoderCheck.data.capabilities.nvidiaNvenc ? "NVENC" : "NVENC off",
        encoderCheck.data.capabilities.intelQsv ? "QSV" : "QSV off",
        encoderCheck.data.capabilities.amdAmf ? "AMF" : "AMF off",
        `Auto: ${encoderCheck.data.preferredEncoder}`,
      ];
      setEncoderStatus(capabilityParts.join("  ·  "));
    } else {
      setEncoderStatus(encoderCheck.error ?? "Encoder detection failed.");
    }
    setStatusMessage("FFmpeg tools are ready.");
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

  async function startCurrentJob(): Promise<void> {
    if (workMode === "update") {
      await startPackageUpdate();
      return;
    }
    await startPackaging();
  }

  const value: PackagerContextValue = {
    view,
    workMode,
    packageStep,
    updateStep,
    isRunning,
    elapsedSeconds,
    etaSeconds,
    statusMessage,
    warnings,
    validationErrors,
    logs,
    showLogs,
    setShowLogs,
    showCommand,
    setShowCommand,
    currentCommand,
    masterPreview,
    progress,
    result,
    updateResult,
    videoPath,
    videoInfo,
    contentType,
    movieTitle,
    setMovieTitle,
    seriesTitle,
    setSeriesTitle,
    seasonNumber,
    setSeasonNumber,
    episodeNumber,
    setEpisodeNumber,
    episodeTitle,
    setEpisodeTitle,
    preferredAudioLanguage,
    setPreferredAudioLanguage,
    audioTracks,
    subtitles,
    qualities,
    outputDir,
    allowOverwrite,
    setAllowOverwrite,
    packageDir,
    scannedPackage,
    updateSubtitles,
    updateAudioTracks,
    segmentDuration,
    setSegmentDuration,
    ffmpegPath,
    setFfmpegPath,
    ffprobePath,
    setFfprobePath,
    useHardwareAcceleration,
    setUseHardwareAcceleration,
    performanceMode,
    setPerformanceMode,
    encoderPreference,
    setEncoderPreference,
    audioMode,
    setAudioMode,
    parallelAudioProcessing,
    setParallelAudioProcessing,
    theme,
    setTheme,
    encoderStatus,
    vlcAvailable,
    settingsOpen,
    setSettingsOpen,
    outputPreview,
    safeProgress,
    readiness,
    jobReady,
    jobTitle,
    beginJob,
    goHome,
    setPackageStep,
    setUpdateStep,
    goNext,
    goBack,
    loadVideo,
    pickVideo,
    pickOutputFolder,
    addExternalAudio,
    addOriginalAudio,
    updateAudioTrack,
    removeAudioTrack,
    setDefaultAudio,
    addSubtitle,
    updateSubtitle,
    removeSubtitle,
    setDefaultSubtitle,
    updateQuality,
    applyLadderPreset,
    startPackaging,
    pickPackageFolder,
    scanPackage,
    addUpdateSubtitle,
    updateUpdateSubtitle,
    removeUpdateSubtitle,
    addUpdateAudio,
    updateUpdateAudio,
    removeUpdateAudio,
    startPackageUpdate,
    cancelRun,
    autoDetectBinaries,
    openOutputFolder,
    openUpdatedPackageFolder,
    copyMasterPath,
    playInVlc,
    startCurrentJob,
  };

  return <PackagerContext.Provider value={value}>{children}</PackagerContext.Provider>;
}
