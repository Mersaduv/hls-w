import path from "node:path";
import type { AudioMode, PerformanceMode, QualityPreset } from "@shared/types";
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

    if (input.useHardwareAcceleration && input.encoder.key === "nvidia") {
      args.push("-hwaccel", "cuda");
    } else if (input.useHardwareAcceleration) {
      args.push("-hwaccel", "auto");
    }

    args.push("-i", input.inputPath);

    const filterComplex = this.buildFilterComplex(variants);
    args.push("-filter_complex", filterComplex);

    const gop = Math.max(30, Math.round(input.segmentDuration * 30));
    variants.forEach((variant, streamIndex) => {
      args.push("-map", `[v${variant.quality}out]`);
      args.push(...this.buildPerStreamVideoArgs(input.encoder, input.mode, streamIndex, gop, variant.bitrateKbps));
    });

    variants.forEach((variant) => {
      args.push(
        "-f",
        "hls",
        "-hls_time",
        String(input.segmentDuration),
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        variant.segmentPattern,
        variant.playlistPath
      );
    });

    return { args, variants };
  }

  buildAudioCommand(input: {
    inputPath: string;
    mapSelector: string;
    playlistPath: string;
    segmentPattern: string;
    segmentDuration: number;
    audioCodec?: string;
    audioMode: AudioMode;
  }): string[] {
    const sourceCodec = (input.audioCodec ?? "").trim().toLowerCase();
    const canCopyAudio = sourceCodec === "aac" || sourceCodec === "mp4a";
    const useCopy = input.audioMode === "copy-when-possible" && canCopyAudio;

    const args = [
      "-y",
      "-progress",
      "pipe:1",
      "-nostats",
      "-i",
      input.inputPath,
      "-map",
      input.mapSelector,
      "-vn",
      "-c:a",
      useCopy ? "copy" : "aac",
    ];

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
      "-hls_segment_filename",
      input.segmentPattern,
      input.playlistPath
    );

    return args;
  }

  private buildFilterComplex(variants: VideoOutputVariant[]): string {
    if (variants.length === 1) {
      const variant = variants[0];
      return `[0:v]scale=${variant.width}:${variant.height}:force_original_aspect_ratio=decrease,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2[v${variant.quality}out]`;
    }

    const splitLabels = variants.map((variant) => `v${variant.quality}`).join("][");
    const parts = [`[0:v]split=${variants.length}[${splitLabels}]`];
    for (const variant of variants) {
      parts.push(
        `[v${variant.quality}]scale=${variant.width}:${variant.height}:force_original_aspect_ratio=decrease,pad=${variant.width}:${variant.height}:(ow-iw)/2:(oh-ih)/2[v${variant.quality}out]`
      );
    }
    return parts.join(";");
  }

  private buildPerStreamVideoArgs(
    encoder: SelectedEncoder,
    mode: PerformanceMode,
    streamIndex: number,
    gop: number,
    bitrateKbps: number
  ): string[] {
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
      "-an",
    ];

    if (encoder.key === "cpu") {
      args.push(`-preset:v:${streamIndex}`, this.cpuPreset(mode));
      args.push(`-profile:v:${streamIndex}`, "high");
      args.push(`-pix_fmt:v:${streamIndex}`, "yuv420p");
      return args;
    }

    if (encoder.key === "nvidia") {
      args.push(`-preset:v:${streamIndex}`, this.nvencPreset(mode));
      args.push(`-rc:v:${streamIndex}`, "vbr");
      return args;
    }

    if (encoder.key === "intel") {
      args.push(`-preset:v:${streamIndex}`, this.qsvPreset(mode));
      return args;
    }

    args.push(`-quality:v:${streamIndex}`, this.amfQuality(mode));
    return args;
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

