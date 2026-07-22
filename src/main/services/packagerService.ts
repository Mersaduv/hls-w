import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type {
  AudioTrack,
  ContentType,
  EncoderPreference,
  VideoInput,
  PackagingJob,
  PackagingProgress,
  PackagingResult,
  PackageUpdateJob,
  PackageUpdateResult,
  PerformanceMode,
  QualityPreset,
} from "@shared/types";
import { parseProgressSeconds } from "@main/utils/ffmpegParsers";
import { sanitizeFolderName, toSafeLanguageCode } from "@main/utils/stringUtils";
import { probePrimaryAudioCodec, probeVideo } from "@main/services/ffprobeService";
import {
  MasterAudioTrack,
  MasterSubtitleTrack,
  MasterVideoVariant,
  writeMasterPlaylist,
  writeMetadataJson,
} from "@main/services/manifestService";
import { prepareSubtitles } from "@main/services/subtitleService";
import { runPackageUpdate } from "@main/services/packageUpdateService";
import { scanHlsPackage } from "@main/services/manifestParser";
import { HardwareEncoderDetector, type SelectedEncoder } from "@main/services/hardwareEncoderDetector";
import { FFmpegCommandBuilder, type VideoOutputVariant } from "@main/services/ffmpegCommandBuilder";
import { VideoPipelineBenchmarkService } from "@main/services/videoPipelineBenchmarkService";

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

function isDiscreteHardwareEncoder(key: SelectedEncoder["key"]): boolean {
  return key === "nvidia" || key === "amd";
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
    text.includes("amf") ||
    // decode/hwaccel failure can bubble up as "no packets / nothing written"
    text.includes("nothing was written into output file") ||
    text.includes("received no packets") ||
    text.includes("nothing was written into output file, because") ||
    text.includes("conversion failed")
  );
}

function qualityRequiresUpscale(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): boolean {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return false;
  const widthScale = targetWidth / sourceWidth;
  const heightScale = targetHeight / sourceHeight;
  return Math.min(widthScale, heightScale) > 1;
}

function chooseSourceBucket(height: number): "1080" | "720" | "480" | "360" | "240" {
  if (!Number.isFinite(height) || height <= 0) return "240";
  if (height >= 1080) return "1080";
  if (height >= 720) return "720";
  if (height >= 480) return "480";
  if (height >= 360) return "360";
  return "240";
}

function safeFileBaseName(value: string): string {
  const cleaned = sanitizeFolderName(value);
  return cleaned.length > 0 ? cleaned : "source";
}

export class HlsPackagerService {
  private currentProcess: ChildProcessWithoutNullStreams | null = null;
  private activeProcesses = new Set<ChildProcessWithoutNullStreams>();
  private canceled = false;
  private readonly hardwareDetector = new HardwareEncoderDetector();
  private readonly commandBuilder = new FFmpegCommandBuilder();
  private readonly pipelineBenchmarker = new VideoPipelineBenchmarkService();

  cancel(): void {
    this.canceled = true;
    for (const child of Array.from(this.activeProcesses.values())) {
      this.killProcessTree(child);
    }
  }

  async scanPackage(packageDir: string) {
    return scanHlsPackage(packageDir);
  }

  async updatePackage(
    job: PackageUpdateJob,
    binaries: BinaryPaths,
    callbacks: PackageCallbacks
  ): Promise<PackageUpdateResult> {
    this.canceled = false;
    try {
      return await runPackageUpdate(this, job, binaries, callbacks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof CanceledError || /canceled/i.test(message)) {
        return {
          success: false,
          canceled: true,
          packageDir: job.packageDir,
          addedSubtitles: [],
          addedAudioTracks: [],
          warnings: [],
          error: "Package update canceled.",
        };
      }
      throw error;
    }
  }

  runFfmpegPublic(input: {
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
    return this.runFfmpeg(input);
  }

  async package(job: PackagingJob, binaries: BinaryPaths, callbacks: PackageCallbacks): Promise<PackagingResult> {
    this.canceled = false;
    const warnings: string[] = [];
    const onProgress = callbacks.onProgress;
    const onLog = callbacks.onLog;

    const requestedEnabledQualities = job.qualities
      .filter((quality) => quality.enabled)
      .sort((a, b) => b.height - a.height);
    const audioTracks = ensureSingleDefaultAudio(job.audioTracks);
    this.validateJob(job, requestedEnabledQualities, audioTracks);
    const resolvedOutputDir = await this.resolveRunOutputDirectory(job);
    const runtimeJob: PackagingJob = {
      ...job,
      outputDir: resolvedOutputDir,
    };

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
    const forceNvidiaVideoEncoding = runtimeJob.useHardwareAcceleration && capabilities.nvidiaNvenc;
    if (forceNvidiaVideoEncoding && selectedEncoder.key !== "nvidia") {
      selectedEncoder = {
        key: "nvidia",
        ffmpegEncoder: "h264_nvenc",
        label: "NVIDIA NVENC",
        isHardware: true,
      };
      warnings.push("NVIDIA NVENC is available, so video encoding is forced to NVIDIA (audio/subtitles remain CPU).");
    }

    // If a discrete GPU encoder exists, avoid Intel iGPU auto-selection.
    if (
      job.useHardwareAcceleration &&
      selectedEncoder.key === "intel" &&
      (capabilities.nvidiaNvenc || capabilities.amdAmf)
    ) {
      const preferredDiscrete: EncoderPreference = capabilities.nvidiaNvenc ? "nvidia" : "amd";
      const discretePick = this.hardwareDetector.selectEncoder({
        capabilities,
        encoderPreference: preferredDiscrete,
        useHardwareAcceleration: true,
      });
      selectedEncoder = discretePick.selected;
      warnings.push(
        `Intel QSV was skipped because a discrete GPU encoder is available. Using ${selectedEncoder.label}.`
      );
    }

    if (selectedEncoder.key === "cpu") {
      warnings.push(
        "CPU-only encoding may take longer than 10 minutes for long movies. Use NVIDIA/Intel/AMD hardware encoding for fastest speed."
      );
    }

    onProgress({
      step: "validating",
      message: `Selected encoder: ${selectedEncoder.label} (${selectedEncoder.ffmpegEncoder}) | ffmpeg: ${path.basename(
        binaries.ffmpegPath
      )} (${binaries.ffmpegPath})`,
      percent: 4,
    });

    const videoInfo = await probeVideo(runtimeJob.videoPath, binaries.ffprobePath);
    if (!videoInfo.audioStreamCount && audioTracks.some((track) => track.source === "video-original")) {
      throw new Error("Input video has no audio stream to extract.");
    }

    const sourceVideoBitrateKbps = await this.estimateSourceVideoBitrateKbps(videoInfo, runtimeJob.videoPath);
    const bitrateAdjusted = this.adjustBitrateLadderForSource(
      requestedEnabledQualities,
      sourceVideoBitrateKbps,
      videoInfo.width,
      videoInfo.height
    );
    warnings.push(...bitrateAdjusted.warnings);

    const qualityOptimization = this.optimizeQualitiesForSpeed(
      bitrateAdjusted.qualities,
      videoInfo.width,
      videoInfo.height,
      runtimeJob.performanceMode,
      runtimeJob.allowUpscaleQualities === true
    );
    const enabledQualities = qualityOptimization.qualities;
    warnings.push(...qualityOptimization.warnings);
    if (enabledQualities.length === 0) {
      throw new Error("No quality remains after optimization. Enable at least one valid quality.");
    }

    const effectiveSegmentDuration = this.resolveEffectiveSegmentDuration(
      runtimeJob.segmentDuration,
      runtimeJob.performanceMode
    );
    if (effectiveSegmentDuration !== runtimeJob.segmentDuration) {
      warnings.push(
        `Fast mode uses a minimum segment duration of 6s for better throughput (requested ${runtimeJob.segmentDuration}s, applied ${effectiveSegmentDuration}s).`
      );
    }

    const effectiveOutputFps = this.resolveEffectiveOutputFps(videoInfo.frameRate, runtimeJob.performanceMode);
    if (
      effectiveOutputFps !== undefined &&
      Number.isFinite(videoInfo.frameRate) &&
      videoInfo.frameRate > effectiveOutputFps
    ) {
      warnings.push(
        `Output frame rate capped from ${videoInfo.frameRate.toFixed(3)}fps to ${effectiveOutputFps}fps to optimize output size.`
      );
    }

    let selectedPipelineMode: "gpu-scale" | "cpu-scale" = "cpu-scale";
    if (runtimeJob.useHardwareAcceleration && selectedEncoder.key !== "cpu") {
      onProgress({
        step: "benchmark",
        message: "Benchmarking video pipelines for best speed...",
        percent: 6,
      });
      const benchmark = await this.pipelineBenchmarker.selectBestPipeline({
        ffmpegPath: binaries.ffmpegPath,
        inputPath: runtimeJob.videoPath,
        qualities: enabledQualities,
        segmentDuration: effectiveSegmentDuration,
        mode: runtimeJob.performanceMode,
        encoder: selectedEncoder,
        useHardwareAcceleration: runtimeJob.useHardwareAcceleration,
        sourceDurationSeconds: videoInfo.durationSeconds,
        sourceFps: videoInfo.frameRate,
        outputFps: effectiveOutputFps,
        onLog,
      });
      selectedPipelineMode = benchmark.pipelineMode;
      warnings.push(...benchmark.warnings);
      onLog(`[benchmark] selected pipeline: ${selectedPipelineMode}`);
    }

    await this.prepareOutput(runtimeJob.outputDir, runtimeJob.allowOverwrite);

    onProgress({
      step: "preparing",
      message: "Preparing output directories...",
      percent: 7,
    });

    await this.prepareVideoDirectories(runtimeJob.outputDir, enabledQualities);
    await this.prepareVideoSources(
      runtimeJob.outputDir,
      runtimeJob.videoPath,
      videoInfo.height,
      this.resolveSourceFileBaseName(runtimeJob),
      onProgress
    );
    const audioPlans = await this.prepareAudioPlans(runtimeJob, audioTracks, binaries.ffprobePath);

    const videoVariants: MasterVideoVariant[] = [];
    const masterAudioTracks: MasterAudioTrack[] = [];

    let videoCommandInput = this.commandBuilder.buildVideoCommand({
      inputPath: runtimeJob.videoPath,
      outputDir: runtimeJob.outputDir,
      qualities: enabledQualities,
      segmentDuration: effectiveSegmentDuration,
      mode: runtimeJob.performanceMode,
      encoder: selectedEncoder,
      useHardwareAcceleration: runtimeJob.useHardwareAcceleration,
      pipelineMode: selectedPipelineMode,
      sourceFps: videoInfo.frameRate,
      outputFps: effectiveOutputFps,
    });

    const shouldParallelAudioWithVideo = audioPlans.length > 0 && selectedEncoder.key !== "cpu";
    const audioEncodingPromise: Promise<void> | null = shouldParallelAudioWithVideo
      ? this.processAudioTracks({
          plans: audioPlans,
          binaries,
          durationSeconds: videoInfo.durationSeconds,
          job: runtimeJob,
          effectiveSegmentDuration,
          onProgress,
          onLog,
          // Keep audio progress stable while video is still running.
          progressStartPercent: 70,
          progressEndPercent: 70,
        })
      : null;

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
        let recoveredWithSameGpuEncoder = false;

        // First recovery path: keep the same GPU encoder, but switch to software decode / CPU scaling.
        // This is more compatible with tricky sources (e.g. some 10-bit HEVC inputs) while still using discrete GPU encode.
        if (runtimeJob.useHardwareAcceleration) {
          warnings.push(
            `${selectedEncoder.label} failed with hardware decode path. Retrying ${selectedEncoder.label} with software decode for compatibility...`
          );
          videoCommandInput = this.commandBuilder.buildVideoCommand({
            inputPath: runtimeJob.videoPath,
            outputDir: runtimeJob.outputDir,
            qualities: enabledQualities,
            segmentDuration: effectiveSegmentDuration,
            mode: runtimeJob.performanceMode,
            encoder: selectedEncoder,
            useHardwareAcceleration: false,
            pipelineMode: "cpu-scale",
            sourceFps: videoInfo.frameRate,
            outputFps: effectiveOutputFps,
          });
          try {
            await this.runFfmpeg({
              binaryPath: binaries.ffmpegPath,
              args: videoCommandInput.args,
              durationSeconds: videoInfo.durationSeconds,
              step: "video",
              message: `Encoding video ladder with ${selectedEncoder.label} (software decode fallback)`,
              startPercent: 8,
              endPercent: 70,
              onProgress,
              onLog,
            });
            recoveredWithSameGpuEncoder = true;
          } catch (sameGpuRetryError) {
            const sameGpuFailure =
              sameGpuRetryError instanceof Error ? sameGpuRetryError.message : String(sameGpuRetryError);
            warnings.push(
              `${selectedEncoder.label} software-decode retry failed: ${sameGpuFailure}. Trying other discrete GPU encoder...`
            );
          }
        }

        if (recoveredWithSameGpuEncoder) {
          // keep current selectedEncoder and continue packaging
        } else {
        if (forceNvidiaVideoEncoding) {
          this.cancel();
          if (audioEncodingPromise) {
            try {
              await audioEncodingPromise;
            } catch {
              // expected if canceled
            }
          }
          throw new Error(
            `NVIDIA NVENC is required for video encoding but failed on this input. ` +
              `CPU/QSV/AMD fallback is disabled by policy. Check NVIDIA driver, ffmpeg NVENC build, and source compatibility.`
          );
        }

        const hardwareRetryOrder: EncoderPreference[] =
          selectedEncoder.key === "nvidia"
            ? ["amd"]
            : selectedEncoder.key === "amd"
              ? ["nvidia"]
              : capabilities.nvidiaNvenc
                ? ["nvidia", "amd"]
                : ["amd", "nvidia"];

        let videoRetrySucceeded = false;
        let lastFailureMessage = failureMessage;

        // Retry other HW encoders first to keep GPU encoding when possible.
        for (const pref of hardwareRetryOrder) {
          const candidate = this.hardwareDetector.selectEncoder({
            capabilities,
            encoderPreference: pref,
            useHardwareAcceleration: true,
          });

          if (
            candidate.selected.key === selectedEncoder.key ||
            candidate.selected.key === "cpu" ||
            !isDiscreteHardwareEncoder(candidate.selected.key)
          ) {
            continue;
          }

          warnings.push(
            `${selectedEncoder.label} failed during encoding. Retrying with ${candidate.selected.label}...`
          );

          selectedEncoder = candidate.selected;
          const pipelineMode: "gpu-scale" | "cpu-scale" =
            selectedEncoder.key === "nvidia" ? selectedPipelineMode : "cpu-scale";

          videoCommandInput = this.commandBuilder.buildVideoCommand({
            inputPath: runtimeJob.videoPath,
            outputDir: runtimeJob.outputDir,
            qualities: enabledQualities,
            segmentDuration: effectiveSegmentDuration,
            mode: runtimeJob.performanceMode,
            encoder: selectedEncoder,
            useHardwareAcceleration: true,
            pipelineMode,
            sourceFps: videoInfo.frameRate,
            outputFps: effectiveOutputFps,
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
            videoRetrySucceeded = true;
            break;
          } catch (retryError) {
            lastFailureMessage = retryError instanceof Error ? retryError.message : String(retryError);
            continue;
          }
        }

        if (!videoRetrySucceeded) {
          warnings.push(
            `All GPU encoder retries failed (${lastFailureMessage}). Falling back to CPU libx264 for reliability.`
          );

          selectedEncoder = {
            key: "cpu",
            ffmpegEncoder: "libx264",
            label: "CPU libx264",
            isHardware: false,
          };

          videoCommandInput = this.commandBuilder.buildVideoCommand({
            inputPath: runtimeJob.videoPath,
            outputDir: runtimeJob.outputDir,
            qualities: enabledQualities,
            segmentDuration: effectiveSegmentDuration,
            mode: runtimeJob.performanceMode,
            encoder: selectedEncoder,
            useHardwareAcceleration: false,
            pipelineMode: "cpu-scale",
            sourceFps: videoInfo.frameRate,
            outputFps: effectiveOutputFps,
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
        }
      }
      } else {
        // Ensure any parallel audio encoding is stopped too.
        this.cancel();
        if (audioEncodingPromise) {
          try {
            await audioEncodingPromise;
          } catch {
            // Expected once canceled.
          }
        }
        throw error;
      }
    }

    for (const variant of videoCommandInput.variants) {
      videoVariants.push(this.toMasterVariant(variant));
    }

    if (audioEncodingPromise) {
      await audioEncodingPromise;
    } else if (audioPlans.length > 0) {
      await this.processAudioTracks({
        plans: audioPlans,
        binaries,
        durationSeconds: videoInfo.durationSeconds,
        job: runtimeJob,
        effectiveSegmentDuration,
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

    const preparedSubtitles = await prepareSubtitles(runtimeJob.subtitles, runtimeJob.outputDir);
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

    const masterPath = await writeMasterPlaylist(runtimeJob.outputDir, {
      videoVariants,
      audioTracks: masterAudioTracks,
      subtitles: masterSubtitles,
    });

    onProgress({
      step: "metadata",
      message: "Writing metadata.json...",
      percent: 98,
    });

    const metadataPath = await writeMetadataJson(runtimeJob.outputDir, {
      contentType: this.resolveContentType(runtimeJob.contentType),
      movieTitle: runtimeJob.movieTitle,
      seriesTitle: runtimeJob.seriesTitle,
      seasonNumber: runtimeJob.seasonNumber,
      episodeNumber: runtimeJob.episodeNumber,
      episodeTitle: runtimeJob.episodeTitle,
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
      outputDir: runtimeJob.outputDir,
      masterPlaylistPath: masterPath,
      metadataPath,
      selectedEncoder: selectedEncoder.ffmpegEncoder,
      selectedVideoPipeline: selectedPipelineMode,
      effectiveSegmentDuration,
      effectiveOutputFps,
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
    effectiveSegmentDuration: number;
    onProgress: (progress: PackagingProgress) => void;
    onLog: (line: string) => void;
    progressStartPercent?: number;
    progressEndPercent?: number;
  }): Promise<void> {
    const {
      plans,
      binaries,
      durationSeconds,
      job,
      effectiveSegmentDuration,
      onProgress,
      onLog,
      progressStartPercent,
      progressEndPercent,
    } = input;
    const startPercent = progressStartPercent ?? 70;
    const endPercent = progressEndPercent ?? 88;
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
        segmentDuration: effectiveSegmentDuration,
        audioCodec: plan.sourceCodec ?? undefined,
        audioMode: job.audioMode,
        audioOffsetMs: plan.track.audioOffsetMs,
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

  private async prepareVideoSources(
    outputDir: string,
    inputVideoPath: string,
    sourceHeight: number,
    sourceFileBaseName: string,
    onProgress: (progress: PackagingProgress) => void
  ): Promise<void> {
    const selectedBucket = chooseSourceBucket(sourceHeight);
    const sourceRoot = path.join(outputDir, "video", "sources");
    const srcDir = path.join(sourceRoot, selectedBucket);
    await fs.mkdir(srcDir, { recursive: true });

    const parsed = path.parse(inputVideoPath);
    const base = safeFileBaseName(sourceFileBaseName);
    const ext = parsed.ext || ".mp4";

    let destPath = path.join(srcDir, `${base}${ext}`);
    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      if (!(await pathExists(destPath))) break;
      destPath = path.join(srcDir, `${base}_${suffix}${ext}`);
    }

    onProgress({
      step: "preparing",
      message: `Copying source video into video/sources/${selectedBucket}/ ...`,
      percent: 7.2,
    });
    await fs.copyFile(inputVideoPath, destPath);
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

    if (this.resolveContentType(job.contentType) === "series") {
      if (!job.seriesTitle?.trim()) {
        throw new Error("Series title is required when content type is set to series.");
      }
      if (!Number.isFinite(job.seasonNumber) || (job.seasonNumber ?? 0) < 1) {
        throw new Error("Season number must be at least 1 for series processing.");
      }
      if (!Number.isFinite(job.episodeNumber) || (job.episodeNumber ?? 0) < 1) {
        throw new Error("Episode number must be at least 1 for series processing.");
      }
    } else if (!job.movieTitle?.trim()) {
      throw new Error("Movie title is required.");
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

  private optimizeQualitiesForSpeed(
    requestedQualities: QualityPreset[],
    sourceWidth: number,
    sourceHeight: number,
    mode: PerformanceMode,
    allowUpscaleQualities: boolean
  ): { qualities: QualityPreset[]; warnings: string[] } {
    const warnings: string[] = [];
    if (mode !== "fast") {
      return { qualities: requestedQualities, warnings };
    }

    if (allowUpscaleQualities) {
      warnings.push("Upscale qualities kept by user confirmation; Fast mode did not remove them.");
      return { qualities: requestedQualities, warnings };
    }

    const nonUpscale = requestedQualities.filter(
      (quality) => !qualityRequiresUpscale(sourceWidth, sourceHeight, quality.width, quality.height)
    );
    if (nonUpscale.length === 0) {
      return { qualities: requestedQualities, warnings };
    }

    const dropped = requestedQualities.filter((quality) =>
      qualityRequiresUpscale(sourceWidth, sourceHeight, quality.width, quality.height)
    );
    if (dropped.length > 0) {
      warnings.push(
        `Fast mode skipped upscale renditions for speed: ${dropped.map((quality) => quality.label).join(", ")}`
      );
    }

    return { qualities: nonUpscale, warnings };
  }

  private adjustBitrateLadderForSource(
    requestedQualities: QualityPreset[],
    sourceVideoBitrateKbps: number | undefined,
    sourceWidth: number,
    sourceHeight: number
  ): { qualities: QualityPreset[]; warnings: string[] } {
    if (!sourceVideoBitrateKbps || sourceVideoBitrateKbps <= 0) {
      return { qualities: requestedQualities, warnings: [] };
    }

    const sourcePixels = Math.max(1, sourceWidth * sourceHeight);
    const tuned = requestedQualities.map((quality) => {
      const outputPixels = Math.max(1, quality.width * quality.height);
      const scaleRatio = Math.min(1, outputPixels / sourcePixels);
      const scaleFactor = Math.pow(scaleRatio, 0.75);
      const capFromSource = Math.round(sourceVideoBitrateKbps * 1.15 * scaleFactor);
      const floorByHeight = this.minimumReasonableBitrateKbps(quality.height);
      const capped = Math.max(floorByHeight, capFromSource);
      const finalBitrate = Math.min(quality.bitrateKbps, capped);
      return { ...quality, bitrateKbps: finalBitrate };
    });

    const warnings: string[] = [];
    requestedQualities.forEach((quality, index) => {
      const next = tuned[index];
      if (next.bitrateKbps < quality.bitrateKbps) {
        warnings.push(
          `Adjusted ${quality.label} bitrate from ${quality.bitrateKbps}k to ${next.bitrateKbps}k to match source bitrate and avoid oversized output.`
        );
      }
    });

    return { qualities: tuned, warnings };
  }

  private minimumReasonableBitrateKbps(height: number): number {
    if (height >= 1080) return 1800;
    if (height >= 720) return 900;
    if (height >= 480) return 500;
    if (height >= 360) return 350;
    return 220;
  }

  private async estimateSourceVideoBitrateKbps(
    videoInfo: VideoInput,
    videoPath: string
  ): Promise<number | undefined> {
    if (videoInfo.videoBitrateKbps && videoInfo.videoBitrateKbps > 0) {
      return videoInfo.videoBitrateKbps;
    }

    if (videoInfo.formatBitrateKbps && videoInfo.formatBitrateKbps > 0) {
      return Math.max(1, Math.round(videoInfo.formatBitrateKbps * 0.9));
    }

    if (!Number.isFinite(videoInfo.durationSeconds) || videoInfo.durationSeconds <= 0) {
      return undefined;
    }

    try {
      const stat = await fs.stat(videoPath);
      const totalKbps = Math.round((stat.size * 8) / Math.max(1, videoInfo.durationSeconds) / 1000);
      return Math.max(1, Math.round(totalKbps * 0.9));
    } catch {
      return undefined;
    }
  }

  private resolveEffectiveSegmentDuration(segmentDuration: number, mode: PerformanceMode): number {
    if (mode === "fast" && segmentDuration < 6) {
      return 6;
    }
    return segmentDuration;
  }

  private resolveEffectiveOutputFps(sourceFps: number, _mode: PerformanceMode): number | undefined {
    if (!Number.isFinite(sourceFps) || sourceFps <= 0) return undefined;
    if (sourceFps > 24) {
      return 24;
    }
    return undefined;
  }

  private formatDateFolder(now: Date): string {
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private resolveSourceFileBaseName(job: PackagingJob): string {
    if (this.resolveContentType(job.contentType) === "series") {
      return sanitizeFolderName((job.seriesTitle ?? "").trim());
    }
    return sanitizeFolderName((job.movieTitle ?? "").trim());
  }

  private resolveContentType(value?: ContentType): ContentType {
    return value === "series" ? "series" : "movie";
  }

  private normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
  }

  private buildSeriesEpisodeFolderName(job: PackagingJob): string {
    const episode = this.normalizePositiveInteger(job.episodeNumber, 1);
    const base = `episode-${String(episode).padStart(2, "0")}`;
    const title = sanitizeFolderName((job.episodeTitle ?? "").trim());
    if (!title || title === "track") {
      return base;
    }
    return `${base}-${title}`;
  }

  private async resolveRunOutputDirectory(job: PackagingJob): Promise<string> {
    const { outputDir: baseOutputDir, videoPath, allowOverwrite } = job;
    const resolvedBase = path.resolve(baseOutputDir);
    const rootDir = path.parse(resolvedBase).root;
    if (resolvedBase === rootDir) {
      throw new Error("Output folder cannot be a drive root.");
    }

    await fs.mkdir(resolvedBase, { recursive: true });

    const movieTitle = sanitizeFolderName((job.movieTitle ?? "").trim());
    if (!movieTitle || movieTitle === "track") {
      throw new Error("Movie title is required.");
    }
    const movieBaseName = movieTitle;
    const dateFolder = this.formatDateFolder(new Date());
    const datedRoot = path.join(resolvedBase, dateFolder);
    await fs.mkdir(datedRoot, { recursive: true });

    const contentType = this.resolveContentType(job.contentType);
    const preferredDir =
      contentType === "series"
        ? path.join(
            datedRoot,
            sanitizeFolderName((job.seriesTitle ?? "").trim() || "series"),
            `season-${String(this.normalizePositiveInteger(job.seasonNumber, 1)).padStart(2, "0")}`,
            this.buildSeriesEpisodeFolderName(job)
          )
        : path.join(datedRoot, movieBaseName);
    const preferredExists = await pathExists(preferredDir);
    if (!preferredExists) {
      await fs.mkdir(preferredDir, { recursive: true });
      return preferredDir;
    }

    const preferredEntries = await fs.readdir(preferredDir);
    if (preferredEntries.length === 0) {
      return preferredDir;
    }

    if (allowOverwrite) {
      await fs.rm(preferredDir, { recursive: true, force: true });
      await fs.mkdir(preferredDir, { recursive: true });
      return preferredDir;
    }

    const candidateBase = path.basename(preferredDir);
    const candidateParent = path.dirname(preferredDir);
    for (let suffix = 2; suffix <= 9999; suffix += 1) {
      const candidate = path.join(candidateParent, `${candidateBase}_${suffix}`);
      const candidateExists = await pathExists(candidate);
      if (!candidateExists) {
        await fs.mkdir(candidate, { recursive: true });
        return candidate;
      }

      const candidateEntries = await fs.readdir(candidate);
      if (candidateEntries.length === 0) {
        return candidate;
      }
    }

    throw new Error("Could not allocate a unique output folder for this title and date.");
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
      const maxTailLines = 200;

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
          const tail = errorTail.slice(-80).join("\n");
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
