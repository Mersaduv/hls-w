import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AppSettings, IpcResult, PackagingJob, PackagingResult } from "@shared/types";
import { IPC_CHANNELS } from "@shared/ipc";
import { probeVideo } from "@main/services/ffprobeService";
import { resolveBinaryPaths } from "@main/services/ffmpegLocator";
import { SettingsStore } from "@main/services/configStore";
import { HlsPackagerService } from "@main/services/packagerService";
import { HardwareEncoderDetector } from "@main/services/hardwareEncoderDetector";

let mainWindow: BrowserWindow | null = null;
let settingsStore: SettingsStore;
let packagingRunning = false;
const packager = new HlsPackagerService();
const hardwareDetector = new HardwareEncoderDetector();

function ok<T>(data: T, warnings: string[] = []): IpcResult<T> {
  return { ok: true, data, warnings };
}

function fail<T>(error: unknown): IpcResult<T> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : "Unexpected error",
  };
}

function sendProgress(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#f5f8ff",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function detectVlcPath(): string | undefined {
  const knownPaths = [
    "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
  ];
  for (const candidate of knownPaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const lookup = spawnSync("where", ["vlc"], {
    windowsHide: true,
    encoding: "utf-8",
  });
  if (lookup.status !== 0 || !lookup.stdout) {
    return undefined;
  }
  const lines = lookup.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(line));
  return lines[0];
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickVideo, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "MP4 Video", extensions: ["mp4"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.pickAudio, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["mp3", "aac", "m4a", "wav", "flac", "ogg", "mka", "ac3", "eac3", "opus"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.pickSubtitle, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Subtitles", extensions: ["vtt", "srt"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.pickOutputFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.settingsLoad, async () => {
    try {
      const data = await settingsStore.load();
      return ok<AppSettings>(data);
    } catch (error) {
      return fail<AppSettings>(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.settingsSave, async (_event, partial: Partial<AppSettings>) => {
    try {
      const data = await settingsStore.save(partial);
      return ok<AppSettings>(data);
    } catch (error) {
      return fail<AppSettings>(error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.resolveBinaries,
    async (_event, ffmpegPathOverride?: string, ffprobePathOverride?: string) => {
      try {
        const resolved = resolveBinaryPaths({ ffmpegPathOverride, ffprobePathOverride });
        return ok(
          {
            ffmpegPath: resolved.ffmpegPath,
            ffprobePath: resolved.ffprobePath,
          },
          resolved.warnings
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.detectEncoders, async (_event, ffmpegPathOverride?: string) => {
    try {
      const settings = await settingsStore.load();
      const binaries = resolveBinaryPaths({
        ffmpegPathOverride: ffmpegPathOverride ?? settings.ffmpegPath,
        ffprobePathOverride: settings.ffprobePath,
      });
      const detection = await hardwareDetector.detectForUi(binaries.ffmpegPath);
      return ok(detection, binaries.warnings);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.probeVideo, async (_event, videoPath: string, ffprobePathOverride?: string) => {
    try {
      const settings = await settingsStore.load();
      const binaries = resolveBinaryPaths({
        ffmpegPathOverride: settings.ffmpegPath,
        ffprobePathOverride: ffprobePathOverride ?? settings.ffprobePath,
      });
      const info = await probeVideo(videoPath, binaries.ffprobePath);
      return ok(info, binaries.warnings);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.startPackaging, async (_event, job: PackagingJob) => {
    if (packagingRunning) {
      return fail<PackagingResult>(new Error("A packaging task is already running."));
    }

    try {
      packagingRunning = true;
      const settings = await settingsStore.load();
      const binaries = resolveBinaryPaths({
        ffmpegPathOverride: job.ffmpegPathOverride ?? settings.ffmpegPath,
        ffprobePathOverride: job.ffprobePathOverride ?? settings.ffprobePath,
      });

      const result = await packager.package(job, binaries, {
        onProgress: (progress) => sendProgress(IPC_CHANNELS.packagingProgress, progress),
        onLog: (line) => sendProgress(IPC_CHANNELS.packagingLog, line),
      });

      await settingsStore.save({
        recentVideoPath: job.videoPath,
        recentOutputDir: job.outputDir,
        ffmpegPath: job.ffmpegPathOverride ?? settings.ffmpegPath,
        ffprobePath: job.ffprobePathOverride ?? settings.ffprobePath,
      });

      return ok(result, binaries.warnings);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected packaging failure";
      const canceled = /canceled/i.test(message);
      if (canceled) {
        const canceledResult: PackagingResult = {
          success: false,
          canceled: true,
          outputDir: job.outputDir,
          generatedQualities: [],
          audioTracks: [],
          subtitles: [],
          warnings: [],
          error: "Packaging canceled.",
        };
        sendProgress(IPC_CHANNELS.packagingProgress, {
          step: "canceled",
          message: "Packaging canceled.",
          percent: 0,
        });
        return ok(canceledResult);
      }
      sendProgress(IPC_CHANNELS.packagingProgress, {
        step: "failed",
        message,
        percent: 0,
      });
      return fail<PackagingResult>(new Error(message));
    } finally {
      packagingRunning = false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.cancelPackaging, async () => {
    try {
      if (!packagingRunning) {
        return ok(false);
      }
      packager.cancel();
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.openFolder, async (_event, folderPath: string) => {
    try {
      const error = await shell.openPath(folderPath);
      if (error) {
        throw new Error(error);
      }
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.showInFolder, async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.previewMaster, async (_event, masterPath: string) => {
    try {
      const raw = await fs.readFile(masterPath, "utf-8");
      return ok(raw);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.copyToClipboard, async (_event, value: string) => {
    try {
      clipboard.writeText(value);
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.detectVlc, async () => {
    try {
      const vlcPath = detectVlcPath();
      return ok({
        exists: Boolean(vlcPath),
        path: vlcPath,
      });
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.launchVlc, async (_event, masterPath: string) => {
    try {
      const vlcPath = detectVlcPath();
      if (!vlcPath) {
        throw new Error("VLC was not found on this machine.");
      }
      const process = spawn(vlcPath, [masterPath], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      process.unref();
      return ok(true);
    } catch (error) {
      return fail(error);
    }
  });
}

app.whenReady().then(() => {
  settingsStore = new SettingsStore(app.getPath("userData"));
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
