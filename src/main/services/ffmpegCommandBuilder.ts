import path from "node:path";
import type { AudioMode, PerformanceMode, QualityPreset, VideoPipelineMode } from "@shared/types";
import type { SelectedEncoder } from "@main/services/hardwareEncoderDetector";

export interface VideoOutputVariant {
  quality: string;
  width: number;
  height: number;
  bitrateKbps: number;
  playlistPath: string;
  segmentPattern: string;
}

export class FFmpegCommandBuilder {
  buildVideoCommand(input: {
    inputPath: string;
    outputDir: string;
    qualities: QualityPreset[];
    segmentDuration: number;
    mode: PerformanceMode;
    encoder: SelectedEncoder;
    useHardwareAcceleration: boolean;
    pipelineMode: VideoPipelineMode;
    sourceFps?: number;
    outputFps?: number;
  }): { args: string[]; variants: VideoOutputVariant[] } {
    const qualities = input.qualities
      .filter((quality) => quality.enabled)
      .sort((a, b) => b.height - a.height);

    const variants: VideoOutputVariant[] = qualities.map((quality) => ({
      quality: quality.key,
      width: quality.width,
      height: quality.height,
      bitrateKbps: quality.bitrateKbps,
      playlistPath: path.join(input.outputDir, "video", quality.key, "index.m3u8"),
      segmentPattern: path.join(input.outputDir, "video", quality.key, "seg_%03d.ts"),
    }));

    const args: string[] = ["-y", "-progress", "pipe:1", "-nostats"];
    args.push(...this.buildDecodeArgs(input.useHardwareAcceleration, input.encoder, input.pipelineMode));
    args.push("-i", input.inputPath);

    const filterComplex = this.buildFilterComplex(variants, input.encoder, input.pipelineMode);
    args.push("-filter_complex", filterComplex);

    const targetFps = this.resolveTargetFps(input.outputFps, input.sourceFps);
    const gop = Math.max(24, Math.round(input.segmentDuration * targetFps));
    variants.forEach((variant) => {
      // Output options are reset per output file in ffmpeg, so map+codec must be set per output.
      args.push("-map", `[v${variant.quality}out]`);
      args.push(
        ...this.buildPerStreamVideoArgs(
          input.encoder,
          input.mode,
          0,
          gop,
          variant.bitrateKbps,
          input.segmentDuration,
          targetFps
        )
      );
      args.push(
        "-f",
        "hls",
        "-hls_time",
        String(input.segmentDuration),
        "-hls_playlist_type",
        "vod",
        "-hls_list_size",
        "0",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        variant.segmentPattern,
        variant.playlistPath
      );
    });

    return { args, variants };
  }

  buildVideoBenchmarkCommand(input: {
    inputPath: string;
    qualities: QualityPreset[];
    mode: PerformanceMode;
    encoder: SelectedEncoder;
    useHardwareAcceleration: boolean;
    pipelineMode: VideoPipelineMode;
    sampleSeconds: number;
    segmentDuration: number;
    sourceFps?: number;
    outputFps?: number;
  }): string[] {
    const variants = input.qualities
      .filter((quality) => quality.enabled)
      .sort((a, b) => b.height - a.height)
      .slice(0, 3)
      .map((quality) => ({
        quality: quality.key,
        width: quality.width,
        height: quality.height,
        bitrateKbps: quality.bitrateKbps,
        playlistPath: "",
        segmentPattern: "",
      }));

    const args: string[] = [
      "-v",
      "error",
      "-y",
      "-progress",
      "pipe:1",
      "-nostats",
      "-ss",
      "0",
      "-t",
      String(Math.max(8, input.sampleSeconds)),
    ];

    args.push(...this.buildDecodeArgs(input.useHardwareAcceleration, input.encoder, input.pipelineMode));
    args.push("-i", input.inputPath);

    const filterComplex = this.buildFilterComplex(variants, input.encoder, input.pipelineMode);
    args.push("-filter_complex", filterComplex);

    const targetFps = this.resolveTargetFps(input.outputFps, input.sourceFps);
    const benchmarkGop = Math.max(24, Math.round(input.segmentDuration * targetFps));
    variants.forEach((variant, streamIndex) => {
      args.push("-map", `[v${variant.quality}out]`);
      args.push(
        ...this.buildPerStreamVideoArgs(
          input.encoder,
          input.mode,
          streamIndex,
          benchmarkGop,
          variant.bitrateKbps,
          input.segmentDuration,
          targetFps
        )
      );
    });

    args.push("-f", "null", "NUL");
    return args;
  }

  buildAudioCommand(input: {
    inputPath: string;
    mapSelector: string;
    playlistPath: string;
    segmentPattern: string;
    segmentDuration: number;
    audioCodec?: string;
    audioMode: AudioMode;
    audioOffsetMs?: number;
  }): string[] {
    const sourceCodec = (input.audioCodec ?? "").trim().toLowerCase();
    const canCopyAudio = sourceCodec === "aac" || sourceCodec === "mp4a";
    const useCopy = input.audioMode === "copy-when-possible" && canCopyAudio && !input.audioOffsetMs;

    const args = ["-y", "-progress", "pipe:1", "-nostats"];
    const offsetMs = input.audioOffsetMs ?? 0;
    if (offsetMs > 0) {
      args.push("-itsoffset", String(offsetMs / 1000));
    }
    args.push("-i", input.inputPath);
    if (offsetMs < 0) {
      args.push("-ss", String(Math.abs(offsetMs) / 1000));
    }
    args.push("-map", input.mapSelector, "-vn", "-c:a", useCopy ? "copy" : "aac");

    if (!useCopy) {
      args.push("-b:a", "128k", "-ac", "2", "-ar", "48000");
    }

    args.push(
      "-f",
      "hls",
      "-hls_time",
      String(input.segmentDuration),
      "-hls_playlist_type",
      "vod",
      "-hls_list_size",
      "0",
      "-hls_flags",
      "temp_file",
      "-hls_segment_filename",
      input.segmentPattern,
      input.playlistPath
    );

    return args;
  }

  private buildFilterComplex(
    variants: VideoOutputVariant[],
    encoder: SelectedEncoder,
    pipelineMode: VideoPipelineMode
  ): string {
    if (variants.length === 1) {
      const variant = variants[0];
      return `[0:v]${this.scaleChainForVariant(variant.width, variant.height, encoder, pipelineMode)}[v${variant.quality}out]`;
    }

    const splitLabels = variants.map((variant) => `v${variant.quality}`).join("][");
    const parts = [`[0:v]split=${variants.length}[${splitLabels}]`];
    for (const variant of variants) {
      const scaleChain = this.scaleChainForVariant(variant.width, variant.height, encoder, pipelineMode);
      parts.push(`[v${variant.quality}]${scaleChain}[v${variant.quality}out]`);
    }
    return parts.join(";");
  }

  private buildDecodeArgs(
    useHardwareAcceleration: boolean,
    encoder: SelectedEncoder,
    pipelineMode: VideoPipelineMode
  ): string[] {
    const args: string[] = ["-fflags", "+discardcorrupt", "-err_detect", "ignore_err"];
    if (!useHardwareAcceleration) return args;

    if (encoder.key === "nvidia" && pipelineMode === "gpu-scale") {
      return [...args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda"];
    }

    if (pipelineMode === "cpu-scale") {
      // Keep decode on CPU for CPU-scale pipeline to avoid unstable mixed decode paths on some drivers.
      return args;
    }

    return [...args, "-hwaccel", "auto"];
  }

  private scaleChainForVariant(
    width: number,
    height: number,
    encoder: SelectedEncoder,
    pipelineMode: VideoPipelineMode
  ): string {
    if (pipelineMode === "gpu-scale" && encoder.key === "nvidia") {
      return `scale_cuda=w=${width}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad_cuda=w=${width}:h=${height}:x=(ow-iw)/2:y=(oh-ih)/2:color=black`;
    }

    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  }

  private buildPerStreamVideoArgs(
    encoder: SelectedEncoder,
    mode: PerformanceMode,
    streamIndex: number,
    gop: number,
    bitrateKbps: number,
    segmentDuration: number,
    targetFps: number
  ): string[] {
    const fpsText = this.formatFps(targetFps);
    const keyFrameExpr = `expr:gte(t,n_forced*${segmentDuration})`;
    const args = [
      `-c:v:${streamIndex}`,
      encoder.ffmpegEncoder,
      `-b:v:${streamIndex}`,
      `${bitrateKbps}k`,
      `-maxrate:v:${streamIndex}`,
      `${Math.round(bitrateKbps * 1.12)}k`,
      `-bufsize:v:${streamIndex}`,
      `${Math.round(bitrateKbps * 2)}k`,
      `-g:v:${streamIndex}`,
      String(gop),
      `-keyint_min:v:${streamIndex}`,
      String(gop),
      `-sc_threshold:v:${streamIndex}`,
      "0",
      `-r:v:${streamIndex}`,
      fpsText,
      `-force_key_frames:v:${streamIndex}`,
      keyFrameExpr,
      "-an",
    ];

    if (encoder.key === "cpu") {
      args.push(`-preset:v:${streamIndex}`, this.cpuPreset(mode));
      if (mode === "fast") {
        args.push(`-tune:v:${streamIndex}`, "fastdecode");
      }
      args.push(`-profile:v:${streamIndex}`, "high");
      args.push(`-pix_fmt:v:${streamIndex}`, "yuv420p");
      args.push(`-threads:v:${streamIndex}`, "0");
      args.push(`-forced-idr:v:${streamIndex}`, "1");
      return args;
    }

    if (encoder.key === "nvidia") {
      args.push(`-preset:v:${streamIndex}`, this.nvencPreset(mode));
      args.push(`-tune:v:${streamIndex}`, this.nvencTune(mode));
      args.push(`-rc:v:${streamIndex}`, "vbr");
      args.push(`-rc-lookahead:v:${streamIndex}`, "0");
      args.push(`-spatial-aq:v:${streamIndex}`, "0");
      args.push(`-temporal-aq:v:${streamIndex}`, "0");
      // Keep output in standard 8-bit 4:2:0 for maximum NVENC input compatibility.
      args.push(`-pix_fmt:v:${streamIndex}`, "yuv420p");
      args.push(`-forced-idr:v:${streamIndex}`, "1");
      return args;
    }

    if (encoder.key === "intel") {
      args.push(`-preset:v:${streamIndex}`, this.qsvPreset(mode));
      args.push(`-look_ahead:v:${streamIndex}`, "0");
      args.push(`-async_depth:v:${streamIndex}`, mode === "fast" ? "8" : "4");
      args.push(`-forced_idr:v:${streamIndex}`, "1");
      return args;
    }

    args.push(`-usage:v:${streamIndex}`, "transcoding");
    args.push(`-quality:v:${streamIndex}`, this.amfQuality(mode));
    args.push(`-rc:v:${streamIndex}`, "vbr_peak");
    args.push(`-async_depth:v:${streamIndex}`, mode === "fast" ? "24" : "16");
    args.push(`-forced_idr:v:${streamIndex}`, "1");
    return args;
  }

  private resolveTargetFps(outputFps?: number, sourceFps?: number): number {
    const selected = Number.isFinite(outputFps) && (outputFps ?? 0) > 0 ? (outputFps as number) : sourceFps;
    if (!Number.isFinite(selected) || (selected ?? 0) <= 0) {
      return 30;
    }
    return Math.max(10, Math.min(120, selected as number));
  }

  private formatFps(value: number): string {
    const rounded = Math.round(value * 1000) / 1000;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3);
  }

  private cpuPreset(mode: PerformanceMode): string {
    if (mode === "fast") return "veryfast";
    if (mode === "quality") return "slow";
    return "medium";
  }

  private nvencPreset(mode: PerformanceMode): string {
    if (mode === "fast") return "p1";
    if (mode === "quality") return "p5";
    return "p3";
  }

  private nvencTune(mode: PerformanceMode): string {
    if (mode === "fast") return "ll";
    return "hq";
  }

  private qsvPreset(mode: PerformanceMode): string {
    if (mode === "fast") return "veryfast";
    if (mode === "quality") return "slow";
    return "medium";
  }

  private amfQuality(mode: PerformanceMode): string {
    if (mode === "fast") return "speed";
    if (mode === "quality") return "quality";
    return "balanced";
  }
}
