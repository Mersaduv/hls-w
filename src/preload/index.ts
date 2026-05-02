import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, PackagingJob, PackagingProgress } from "@shared/types";
import { IPC_CHANNELS, type ElectronApi, type ResolvedBinaries } from "@shared/ipc";

const api: ElectronApi = {
  pickVideo: () => ipcRenderer.invoke(IPC_CHANNELS.pickVideo),
  pickAudio: () => ipcRenderer.invoke(IPC_CHANNELS.pickAudio),
  pickSubtitle: () => ipcRenderer.invoke(IPC_CHANNELS.pickSubtitle),
  pickOutputFolder: () => ipcRenderer.invoke(IPC_CHANNELS.pickOutputFolder),
  probeVideo: (videoPath: string, ffprobePathOverride?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.probeVideo, videoPath, ffprobePathOverride),
  loadSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsLoad),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke(IPC_CHANNELS.settingsSave, settings),
  resolveBinaries: (ffmpegPathOverride?: string, ffprobePathOverride?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveBinaries, ffmpegPathOverride, ffprobePathOverride),
  detectEncoders: (ffmpegPathOverride?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectEncoders, ffmpegPathOverride),
  startPackaging: (job: PackagingJob) => ipcRenderer.invoke(IPC_CHANNELS.startPackaging, job),
  cancelPackaging: () => ipcRenderer.invoke(IPC_CHANNELS.cancelPackaging),
  onPackagingProgress: (listener: (progress: PackagingProgress) => void) => {
    const channel = IPC_CHANNELS.packagingProgress;
    const wrapped = (_event: Electron.IpcRendererEvent, payload: PackagingProgress) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onPackagingLog: (listener: (line: string) => void) => {
    const channel = IPC_CHANNELS.packagingLog;
    const wrapped = (_event: Electron.IpcRendererEvent, payload: string) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  openFolder: (folderPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openFolder, folderPath),
  showInFolder: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.showInFolder, filePath),
  previewMaster: (masterPath: string) => ipcRenderer.invoke(IPC_CHANNELS.previewMaster, masterPath),
  copyToClipboard: (value: string) => ipcRenderer.invoke(IPC_CHANNELS.copyToClipboard, value),
  detectVlc: () => ipcRenderer.invoke(IPC_CHANNELS.detectVlc),
  launchVlc: (masterPath: string) => ipcRenderer.invoke(IPC_CHANNELS.launchVlc, masterPath),
};

contextBridge.exposeInMainWorld("electronAPI", api);
