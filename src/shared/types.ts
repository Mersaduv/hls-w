export type AudioType = "dubbed" | "original" | "commentary";
export type SourceAudioType = "external" | "video-original";
export type ThemeMode = "light" | "dark";
export type QualityKey = "1080" | "720" | "480" | "360" | "240";
export type PerformanceMode = "fast" | "balanced" | "quality";
export type EncoderPreference = "auto" | "nvidia" | "intel" | "amd" | "cpu";
export type AudioMode = "copy-when-possible" | "encode-aac";
export type VideoPipelineMode = "gpu-scale" | "cpu-scale";
export type ContentType = "movie" | "series";

export interface VideoInput {
  path: string;
  durationSeconds: number;
  frameRate: number;
  width: number;
  height: number;
  videoCodec: string;
  formatBitrateKbps?: number;
  videoBitrateKbps?: number;
  audioCodec?: string;
  audioStreamCount: number;
  defaultAudioLanguage?: string;
}

export interface AudioTrack {
  id: string;
  source: SourceAudioType;
  filePath?: string;
  name: string;
  language: string;
  type: AudioType;
  isDefault: boolean;
}

export interface SubtitleTrack {
  id: string;
  filePath: string;
  name: string;
  language: string;
  isDefault: boolean;
  inputFormat: "vtt" | "srt";
}

export interface QualityPreset {
  key: QualityKey;
  label: string;
  width: number;
  height: number;
  enabled: boolean;
  bitrateKbps: number;
}

export interface PackagingJob {
  videoPath: string;
  outputDir: string;
  movieTitle?: string;
  contentType?: ContentType;
  seriesTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  qualities: QualityPreset[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  allowUpscaleQualities?: boolean;
  segmentDuration: number;
  useHardwareAcceleration: boolean;
  performanceMode: PerformanceMode;
  encoderPreference: EncoderPreference;
  audioMode: AudioMode;
  parallelAudioProcessing: boolean;
  allowOverwrite: boolean;
  ffmpegPathOverride?: string;
  ffprobePathOverride?: string;
}

export interface PackagingProgress {
  step:
    | "validating"
    | "preparing"
    | "benchmark"
    | "video"
    | "audio"
    | "subtitles"
    | "playlist"
    | "metadata"
    | "completed"
    | "failed"
    | "canceled";
  message: string;
  percent: number;
  currentCommand?: string;
  logLine?: string;
}

export interface PackagingResult {
  success: boolean;
  canceled: boolean;
  outputDir: string;
  masterPlaylistPath?: string;
  metadataPath?: string;
  selectedEncoder?: string;
  selectedVideoPipeline?: VideoPipelineMode;
  effectiveSegmentDuration?: number;
  effectiveOutputFps?: number;
  generatedQualities: string[];
  audioTracks: Array<{
    name: string;
    language: string;
    type: AudioType;
    isDefault: boolean;
    uri: string;
  }>;
  subtitles: Array<{
    name: string;
    language: string;
    isDefault: boolean;
    uri: string;
  }>;
  warnings: string[];
  error?: string;
}

export interface AppSettings {
  ffmpegPath?: string;
  ffprobePath?: string;
  segmentDuration: number;
  useHardwareAcceleration: boolean;
  performanceMode: PerformanceMode;
  encoderPreference: EncoderPreference;
  audioMode: AudioMode;
  parallelAudioProcessing: boolean;
  theme: ThemeMode;
  recentVideoPath?: string;
  recentOutputDir?: string;
  recentContentType?: ContentType;
  recentSeriesTitle?: string;
  recentSeasonNumber?: number;
  recentEpisodeNumber?: number;
  recentEpisodeTitle?: string;
}

export interface EncoderCapabilities {
  nvidiaNvenc: boolean;
  intelQsv: boolean;
  amdAmf: boolean;
  cpuLibx264: boolean;
}

export interface EncoderDetectionResult {
  capabilities: EncoderCapabilities;
  preferredEncoder: string;
  warnings: string[];
}

export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

export interface ProbeWarning {
  type: "upscale";
  message: string;
  qualities: QualityKey[];
}
