import { spawn } from "node:child_process";
import type { VideoInput } from "@shared/types";

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  disposition?: {
    default?: number;
  };
  tags?: {
    language?: string;
  };
}

interface FFprobeFormat {
  duration?: string;
  bit_rate?: string;
}

interface FFprobeOutput {
  streams?: FFprobeStream[];
  format?: FFprobeFormat;
}

function parseFrameRate(raw?: string): number {
  if (!raw) return 0;
  const cleaned = raw.trim();
  if (!cleaned) return 0;

  if (cleaned.includes("/")) {
    const [numRaw, denRaw] = cleaned.split("/", 2);
    const numerator = Number.parseFloat(numRaw);
    const denominator = Number.parseFloat(denRaw);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return 0;
    }
    const value = numerator / denominator;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseBitrateKbps(raw?: string): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / 1000);
}

export function probeVideo(videoPath: string, ffprobePath: string): Promise<VideoInput> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      videoPath,
    ];
    const child = spawn(ffprobePath, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => reject(error));

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe failed with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as FFprobeOutput;
        const streams = parsed.streams ?? [];
        const videoStream = streams.find((stream) => stream.codec_type === "video");
        if (!videoStream || !videoStream.width || !videoStream.height) {
          throw new Error("Could not find a valid video stream in input file.");
        }

        const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
        const defaultAudioStream =
          audioStreams.find((stream) => (stream.disposition?.default ?? 0) === 1) ?? audioStreams[0];
        const defaultAudioLanguage = defaultAudioStream?.tags?.language?.trim().toLowerCase();
        const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "0") || 0;
        const frameRate =
          parseFrameRate(videoStream.avg_frame_rate) ||
          parseFrameRate(videoStream.r_frame_rate) ||
          0;
        const videoBitrateKbps = parseBitrateKbps(videoStream.bit_rate);
        const formatBitrateKbps = parseBitrateKbps(parsed.format?.bit_rate);

        resolve({
          path: videoPath,
          durationSeconds,
          frameRate,
          width: videoStream.width,
          height: videoStream.height,
          videoCodec: videoStream.codec_name ?? "unknown",
          formatBitrateKbps,
          videoBitrateKbps,
          audioCodec: audioStreams[0]?.codec_name,
          audioStreamCount: audioStreams.length,
          defaultAudioLanguage: defaultAudioLanguage && defaultAudioLanguage.length > 0 ? defaultAudioLanguage : undefined,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function probePrimaryAudioCodec(inputPath: string, ffprobePath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ];
    const child = spawn(ffprobePath, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe audio codec probe failed with code ${code}`));
        return;
      }
      const codec = stdout.trim().toLowerCase();
      resolve(codec.length > 0 ? codec : null);
    });
  });
}
