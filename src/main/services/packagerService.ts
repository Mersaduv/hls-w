import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  AudioTrack,
  PackagingJob,
  PackagingProgress,
  PackagingResult,
  QualityPreset,
} from "@shared/types";
import { parseProgressSeconds } from "@main/utils/ffmpegParsers";
import { toSafeLanguageCode } from "@main/utils/stringUtils";
import { probePrimaryAudioCodec, probeVideo } from "@main/services/ffprobeService";
import {
  MasterAudioTrack,
  MasterSubtitleTrack,
  MasterVideoVariant,
  writeMasterPlaylist,
  writeMetadataJson,
} from "@main/services/manifestService";
import { prepareSubtitles } from "@main/services/subtitleService";
import { HardwareEncoderDetector, type SelectedEncoder } from "@main/services/hardwareEncoderDetector";
import { FFmpegCommandBuilder, type VideoOutputVariant } from "@main/services/ffmpegCommandBuilder";

interface BinaryPaths {
  ffmpegPath: string;
  ffprobePath: string;
}

interface PackageCallbacks {
  onProgress: (progress: PackagingProgress) => void;
  onLog: (line: string) => void;
}

class CanceledError extends Error {
  constructor() {
    super("Packaging canceled by user.");
  }
}

interface AudioEncodePlan {
  track: AudioTrack;
  langBase: string;
  langFolder: string;
  playlistPath: string;
  segmentPattern: string;
  inputPath: string;
  mapSelector: string;
  sourceCodec: string | null;
}

function quoteArg(arg: string): string {
  if (/[\s"]/g.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function commandToString(binary: string, args: string[]): string {
  return [quoteArg(binary), ...args.map(quoteArg)].join(" ");
}

function pathExists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

function ensureSingleDefaultAudio(audioTracks: AudioTrack[]): AudioTrack[] {
  let foundDefault = false;
  return audioTracks.map((track) => {
    if (!track.isDefault) return track;
    if (!foundDefault) {
      foundDefault = true;
      return track;
    }
    return { ...track, isDefault: false };
  });
}

function looksLikeEncoderFailure(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("unknown encoder") ||
    text.includes("no capable devices found") ||
    text.includes("cannot load") ||
    text.includes("device failed") ||
    text.includes("qsv") ||
    text.includes("nvenc") ||
    text.includes("amf")
  );
}

export class HlsPackagerService {
  private currentProcess: ChildProcessWithoutNullStreams | null = null;
  private activeProcesses = new Set<ChildProcessWithoutNullStreams>();
  private canceled = false;
  private readonly hardwareDetector = new HardwareEncoderDetector();
  private readonly commandBuilder = new FFmpegCommandBuilder();

  cancel(): void {
    this.canceled = true;
    for (const child of Array.from(this.activeProcesses.values())) {
      this.killProcessTree(child);
    }
  }

  async package(job: PackagingJob, binaries: BinaryPaths, callbacks: PackageCallbacks): Promise<PackagingResult> {
    this.canceled = false;
    const warnings: string[] = [];
    const onProgress = callbacks.onProgress;
    const onLog = callbacks.onLog;

    const enabledQualities = job.qualities
      .filter((quality) => quality.enabled)
      .sort((a, b) => b.height - a.height);
    const audioTracks = ensureSingleDefaultAudio(job.audioTracks);

    this.validateJob(job, enabledQualities, audioTracks);

    onProgress({
      step: "validating",
      message: "Validating job inputs...",
      percent: 2,
    });

    const capabilities = await this.hardwareDetector.detectCapabilities(binaries.ffmpegPath);
    const selectedEncoderResult = this.hardwareDetector.selectEncoder({
      capabilities,
      encoderPreference: job.encoderPreference,
      useHardwareAcceleration: job.useHardwareAcceleration,
    });
    let selectedEncoder = selectedEncoderResult.selected;
    warnings.push(...selectedEncoderResult.warnings);

    if (selectedEncoder.key === "cpu") {
      warnings.push(
        "CPU-only encoding may take longer than 10 minutes for long movies. Use NVIDIA/Intel/AMD hardware encoding for fastest speed."
      );
    }

    onProgress({
      step: "validating",
      message: `Selected encoder: ${selectedEncoder.label} (${selectedEncoder.ffmpegEncoder})`,
      percent: 4,
    });

    const videoInfo = await probeVideo(job.videoPath, binaries.ffprobePath);
    if (!videoInfo.audioStreamCount && audioTracks.some((track) => track.source === "video-original")) {
      throw new Error("Input video has no audio stream to extract.");
    }

    await this.prepareOutput(job.outputDir, job.allowOverwrite);

    onProgress({
      step: "preparing",
      message: "Preparing output directories...",
      percent: 7,
    });

    await this.prepareVideoDirectories(job.outputDir, enabledQualities);
    const audioPlans = await this.prepareAudioPlans(job, audioTracks, binaries.ffprobePath);

    const videoVariants: MasterVideoVariant[] = [];
    const masterAudioTracks: MasterAudioTrack[] = [];

    let videoCommandInput = this.commandBuilder.buildVideoCommand({
      inputPath: job.videoPath,
      outputDir: job.outputDir,
      qualities: enabledQualities,
      segmentDuration: job.segmentDuration,
      mode: job.performanceMode,
      encoder: selectedEncoder,
      useHardwareAcceleration: job.useHardwareAcceleration,
    });

    try {
      await this.runFfmpeg({
        binaryPath: binaries.ffmpegPath,
        args: videoCommandInput.args,
        durationSeconds: videoInfo.durationSeconds,
        step: "video",
        message: `Encoding video ladder with ${selectedEncoder.label}`,
        startPercent: 8,
        endPercent: 70,
        onProgress,
        onLog,
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      if (selectedEncoder.key !== "cpu" && looksLikeEncoderFailure(failureMessage)) {
        warnings.push(
          `${selectedEncoder.label} failed during encoding. Falling back to CPU libx264 for reliability.`
        );
        selectedEncoder = {
          key: "cpu",
          ffmpegEncoder: "libx264",
          label: "CPU libx264",
          isHardware: false,
        };
        videoCommandInput = this.commandBuilder.buildVideoCommand({
          inputPath: job.videoPath,
          outputDir: job.outputDir,
          qualities: enabledQualities,
          segmentDuration: job.segmentDuration,
          mode: job.performanceMode,
          encoder: selectedEncoder,
          useHardwareAcceleration: false,
        });
        await this.runFfmpeg({
          binaryPath: binaries.ffmpegPath,
          args: videoCommandInput.args,
          durationSeconds: videoInfo.durationSeconds,
          step: "video",
          message: "Encoding video ladder with CPU fallback (libx264)",
          startPercent: 8,
          endPercent: 70,
          onProgress,
          onLog,
        });
      } else {
        throw error;
      }
    }

    for (const variant of videoCommandInput.variants) {
      videoVariants.push(this.toMasterVariant(variant));
    }

    if (audioPlans.length > 0) {
      await this.processAudioTracks({
        plans: audioPlans,
        binaries,
        durationSeconds: videoInfo.durationSeconds,
        job,
        onProgress,
        onLog,
      });
    }

    let audioLanguageDefaultAssigned = false;
    for (const plan of audioPlans) {
      const shouldBeDefault = plan.track.isDefault && !audioLanguageDefaultAssigned;
      if (shouldBeDefault) {
        audioLanguageDefaultAssigned = true;
      }

      masterAudioTracks.push({
        name: plan.track.name,
        language: plan.langBase,
        type: plan.track.type,
        isDefault: shouldBeDefault,
        uri: `audio/${plan.langFolder}/index.m3u8`.replace(/\\/g, "/"),
      });
    }

    if (!masterAudioTracks.some((track) => track.isDefault) && masterAudioTracks.length > 0) {
      masterAudioTracks[0].isDefault = true;
      warnings.push("No default audio track was selected, first track is now default.");
    }

    onProgress({
      step: "subtitles",
      message: "Preparing subtitles...",
      percent: 89,
    });

    const preparedSubtitles = await prepareSubtitles(job.subtitles, job.outputDir);
    const masterSubtitles: MasterSubtitleTrack[] = preparedSubtitles.map((subtitle) => ({
      name: subtitle.name,
      language: subtitle.language,
      isDefault: subtitle.isDefault,
      uri: subtitle.uri,
    }));

    onProgress({
      step: "playlist",
      message: "Writing master playlist...",
      percent: 94,
    });

    const masterPath = await writeMasterPlaylist(job.outputDir, {
      videoVariants,
      audioTracks: masterAudioTracks,
      subtitles: masterSubtitles,
    });

    onProgress({
      step: "metadata",
      message: "Writing metadata.json...",
      percent: 98,
    });

    const metadataPath = await writeMetadataJson(job.outputDir, {
      qualities: videoVariants.map((variant) => variant.quality),
      audioTracks: masterAudioTracks,
      subtitles: masterSubtitles,
    });

    onProgress({
      step: "completed",
      message: "Packaging completed successfully.",
      percent: 100,
    });

    return {
      success: true,
      canceled: false,
      outputDir: job.outputDir,
      masterPlaylistPath: masterPath,
      metadataPath,
      selectedEncoder: selectedEncoder.ffmpegEncoder,
      generatedQualities: videoVariants.map((variant) => variant.quality),
      audioTracks: masterAudioTracks.map((track) => ({
        name: track.name,
        language: track.language,
        type: track.type,
        isDefault: track.isDefault,
        uri: track.uri,
      })),
      subtitles: masterSubtitles.map((subtitle) => ({
        name: subtitle.name,
        language: subtitle.language,
        isDefault: subtitle.isDefault,
        uri: subtitle.uri,
      })),
      warnings,
    };
  }

  private async processAudioTracks(input: {
    plans: AudioEncodePlan[];
    binaries: BinaryPaths;
    durationSeconds: number;
    job: PackagingJob;
    onProgress: (progress: PackagingProgress) => void;
    onLog: (line: string) => void;
  }): Promise<void> {
    const { plans, binaries, durationSeconds, job, onProgress, onLog } = input;
    const startPercent = 70;
    const endPercent = 88;
    const total = Math.max(plans.length, 1);
    const progressByTrack = new Array<number>(plans.length).fill(0);

    const reportOverall = (): void => {
      const ratio = progressByTrack.reduce((sum, value) => sum + value, 0) / total;
      const percent = startPercent + (endPercent - startPercent) * ratio;
      onProgress({
        step: "audio",
        message: `Encoding ${plans.length} audio track(s)`,
        percent,
      });
    };

    const runSingle = async (plan: AudioEncodePlan, index: number): Promise<void> => {
      const args = this.commandBuilder.buildAudioCommand({
        inputPath: plan.inputPath,
        mapSelector: plan.mapSelector,
        playlistPath: plan.playlistPath,
        segmentPattern: plan.segmentPattern,
        segmentDuration: job.segmentDuration,
        audioCodec: plan.sourceCodec ?? undefined,
        audioMode: job.audioMode,
      });

      await this.runFfmpeg({
        binaryPath: binaries.ffmpegPath,
        args,
        durationSeconds,
        step: "audio",
        message: `Encoding audio track: ${plan.track.name}`,
        startPercent,
        endPercent,
        onProgress,
        onLog,
        onRatio: (ratio) => {
          progressByTrack[index] = ratio;
          reportOverall();
        },
      });
      progressByTrack[index] = 1;
      reportOverall();
    };

    if (job.parallelAudioProcessing && plans.length > 1) {
      await Promise.all(plans.map((plan, index) => runSingle(plan, index)));
      return;
    }

    for (let index = 0; index < plans.length; index += 1) {
      await runSingle(plans[index], index);
    }
  }

  private async prepareVideoDirectories(outputDir: string, qualities: QualityPreset[]): Promise<void> {
    const tasks = qualities.map((quality) => fs.mkdir(path.join(outputDir, "video", quality.key), { recursive: true }));
    await Promise.all(tasks);
  }

  private async prepareAudioPlans(
    job: PackagingJob,
    audioTracks: AudioTrack[],
    ffprobePath: string
  ): Promise<AudioEncodePlan[]> {
    const plans: AudioEncodePlan[] = [];
    const audioLanguageCounter = new Map<string, number>();

    for (const audioTrack of audioTracks) {
      this.throwIfCanceled();
      const langBase = toSafeLanguageCode(audioTrack.language) || "und";
      const langCounter = audioLanguageCounter.get(langBase) ?? 0;
      audioLanguageCounter.set(langBase, langCounter + 1);
      const langFolder = langCounter === 0 ? langBase : `${langBase}_${langCounter + 1}`;

      const audioDir = path.join(job.outputDir, "audio", langFolder);
      await fs.mkdir(audioDir, { recursive: true });
      const playlistPath = path.join(audioDir, "index.m3u8");
      const segmentPattern = path.join(audioDir, "seg_%03d.aac");
      const inputPath = audioTrack.source === "video-original" ? job.videoPath : audioTrack.filePath;
      if (!inputPath) {
        throw new Error(`Audio track "${audioTrack.name}" has no file path.`);
      }

      let sourceCodec: string | null = null;
      try {
        sourceCodec = await probePrimaryAudioCodec(inputPath, ffprobePath);
      } catch {
        sourceCodec = null;
      }

      plans.push({
        track: audioTrack,
        langBase,
        langFolder,
        playlistPath,
        segmentPattern,
        inputPath,
        mapSelector: "0:a:0",
        sourceCodec,
      });
    }

    return plans;
  }

  private toMasterVariant(variant: VideoOutputVariant): MasterVideoVariant {
    return {
      quality: variant.quality,
      width: variant.width,
      height: variant.height,
      bitrateKbps: variant.bitrateKbps,
      uri: `video/${variant.quality}/index.m3u8`.replace(/\\/g, "/"),
    };
  }

  private throwIfCanceled(): void {
    if (this.canceled) {
      throw new CanceledError();
    }
  }

  private validateJob(job: PackagingJob, qualities: QualityPreset[], audioTracks: AudioTrack[]): void {
    if (!job.videoPath) {
      throw new Error("Input video is required.");
    }
    if (!job.outputDir) {
      throw new Error("Output folder is required.");
    }
    if (qualities.length === 0) {
      throw new Error("At least one quality must be enabled.");
    }
    if (audioTracks.length === 0) {
      throw new Error("At least one audio track is required.");
    }
    if (job.segmentDuration <= 0) {
      throw new Error("Segment duration must be greater than zero.");
    }

    const defaultCount = audioTracks.filter((track) => track.isDefault).length;
    if (defaultCount > 1) {
      throw new Error("Only one audio track can be marked as default.");
    }

    for (const track of audioTracks) {
      if (!track.name.trim()) {
        throw new Error("Audio track display name is required.");
      }
      if (!track.language.trim()) {
        throw new Error(`Language code is required for audio track "${track.name}".`);
      }
      if (track.source === "external" && !track.filePath) {
        throw new Error(`Audio file is required for track "${track.name}".`);
      }
    }

    for (const subtitle of job.subtitles) {
      if (!subtitle.language.trim()) {
        throw new Error(`Language code is required for subtitle "${subtitle.name}".`);
      }
      if (!subtitle.filePath) {
        throw new Error(`Subtitle file is missing for "${subtitle.name}".`);
      }
    }
  }

  private async prepareOutput(outputDir: string, allowOverwrite: boolean): Promise<void> {
    const resolvedOutput = path.resolve(outputDir);
    const rootDir = path.parse(resolvedOutput).root;
    if (resolvedOutput === rootDir) {
      throw new Error("Output folder cannot be a drive root.");
    }

    const outputExists = await pathExists(outputDir);
    if (!outputExists) {
      await fs.mkdir(outputDir, { recursive: true });
      return;
    }

    const entries = await fs.readdir(outputDir);
    if (entries.length === 0) {
      return;
    }

    if (!allowOverwrite) {
      throw new Error("Output folder is not empty. Enable overwrite confirmation to continue.");
    }

    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
  }

  private runFfmpeg(input: {
    binaryPath: string;
    args: string[];
    durationSeconds: number;
    step: PackagingProgress["step"];
    message: string;
    startPercent: number;
    endPercent: number;
    onProgress: (progress: PackagingProgress) => void;
    onLog: (line: string) => void;
    onRatio?: (ratio: number) => void;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.throwIfCanceled();
      if (!existsSync(input.binaryPath)) {
        reject(new Error(`FFmpeg binary not found: ${input.binaryPath}`));
        return;
      }

      const commandText = commandToString(input.binaryPath, input.args);
      input.onProgress({
        step: input.step,
        message: input.message,
        percent: input.startPercent,
        currentCommand: commandText,
      });
      input.onLog(`$ ${commandText}`);

      const child = spawn(input.binaryPath, input.args, {
        windowsHide: true,
      });
      this.currentProcess = child;
      this.activeProcesses.add(child);

      let stderrBuffer = "";
      let stdoutBuffer = "";
      const errorTail: string[] = [];
      const maxTailLines = 40;

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        input.onLog(trimmed);
        errorTail.push(trimmed);
        if (errorTail.length > maxTailLines) {
          errorTail.shift();
        }
        const progressSeconds = parseProgressSeconds(trimmed);
        if (progressSeconds !== null && input.durationSeconds > 0) {
          const ratio = Math.max(0, Math.min(1, progressSeconds / input.durationSeconds));
          const percent = input.startPercent + (input.endPercent - input.startPercent) * ratio;
          input.onRatio?.(ratio);
          input.onProgress({
            step: input.step,
            message: input.message,
            percent,
            logLine: trimmed,
            currentCommand: commandText,
          });
        }
      };

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        lines.forEach(handleLine);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(handleLine);
      });

      child.on("error", (error) => {
        this.activeProcesses.delete(child);
        if (this.currentProcess === child) {
          this.currentProcess = null;
        }
        reject(error);
      });

      child.on("close", (code) => {
        this.activeProcesses.delete(child);
        if (this.currentProcess === child) {
          this.currentProcess = null;
        }
        if (this.canceled) {
          reject(new CanceledError());
          return;
        }
        if (code !== 0) {
          const tail = errorTail.slice(-20).join("\n");
          const message = tail.length > 0 ? `FFmpeg exited with code ${code}:\n${tail}` : `FFmpeg exited with code ${code}.`;
          reject(new Error(message));
          return;
        }
        input.onRatio?.(1);
        input.onProgress({
          step: input.step,
          message: input.message,
          percent: input.endPercent,
          currentCommand: commandText,
        });
        resolve();
      });
    });
  }

  private killProcessTree(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid;

    try {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    } catch {
      // noop
    }

    if (!pid) return;

    if (process.platform === "win32") {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.unref();
      } catch {
        // noop
      }
      return;
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // noop
    }
  }
}

