import type {
  AppSettings,
  EncoderDetectionResult,
  IpcResult,
  PackagingJob,
  PackagingProgress,
  PackagingResult,
  VideoInput,
} from "./types";

export const IPC_CHANNELS = {
  pickVideo: "dialog:pickVideo",
  pickAudio: "dialog:pickAudio",
  pickSubtitle: "dialog:pickSubtitle",
  pickOutputFolder: "dialog:pickOutputFolder",
  probeVideo: "media:probeVideo",
  settingsLoad: "settings:load",
  settingsSave: "settings:save",
  resolveBinaries: "ffmpeg:resolveBinaries",
  detectEncoders: "ffmpeg:detectEncoders",
  startPackaging: "packaging:start",
  cancelPackaging: "packaging:cancel",
  packagingProgress: "packaging:progress",
  packagingLog: "packaging:log",
  openFolder: "system:openFolder",
  showInFolder: "system:showInFolder",
  previewMaster: "system:previewMaster",
  copyToClipboard: "system:copyToClipboard",
  detectVlc: "system:detectVlc",
  launchVlc: "system:launchVlc",
} as const;

export interface ResolvedBinaries {
  ffmpegPath: string;
  ffprobePath: string;
}

export interface ElectronApi {
  pickVideo(): Promise<string | null>;
  pickAudio(): Promise<string | null>;
  pickSubtitle(): Promise<string | null>;
  pickOutputFolder(): Promise<string | null>;
  probeVideo(videoPath: string, ffprobePathOverride?: string): Promise<IpcResult<VideoInput>>;
  loadSettings(): Promise<IpcResult<AppSettings>>;
  saveSettings(settings: Partial<AppSettings>): Promise<IpcResult<AppSettings>>;
  resolveBinaries(
    ffmpegPathOverride?: string,
    ffprobePathOverride?: string
  ): Promise<IpcResult<ResolvedBinaries>>;
  detectEncoders(ffmpegPathOverride?: string): Promise<IpcResult<EncoderDetectionResult>>;
  startPackaging(job: PackagingJob): Promise<IpcResult<PackagingResult>>;
  cancelPackaging(): Promise<IpcResult<boolean>>;
  onPackagingProgress(listener: (progress: PackagingProgress) => void): () => void;
  onPackagingLog(listener: (line: string) => void): () => void;
  openFolder(folderPath: string): Promise<IpcResult<boolean>>;
  showInFolder(filePath: string): Promise<IpcResult<boolean>>;
  previewMaster(masterPath: string): Promise<IpcResult<string>>;
  copyToClipboard(value: string): Promise<IpcResult<boolean>>;
  detectVlc(): Promise<IpcResult<{ exists: boolean; path?: string }>>;
  launchVlc(masterPath: string): Promise<IpcResult<boolean>>;
}

declare global {
  interface Window {
    electronAPI: ElectronApi;
  }
}
