import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface BinaryPaths {
  ffmpegPath: string;
  ffprobePath: string;
  warnings: string[];
}

interface ResolveBinaryOptions {
  ffmpegPathOverride?: string;
  ffprobePathOverride?: string;
}

const BIN_DIRS = [
  path.join(process.resourcesPath, "bin"),
  path.join(process.cwd(), "resources", "bin"),
  path.join(process.cwd(), "bin"),
  path.join(path.dirname(process.execPath), "resources", "bin"),
];

function cleanPath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function candidateBinaryPaths(binaryName: "ffmpeg" | "ffprobe", override?: string): string[] {
  const executable = `${binaryName}.exe`;
  const list: string[] = [];
  const cleanedOverride = cleanPath(override);
  if (cleanedOverride) {
    list.push(cleanedOverride);
  }
  for (const dir of BIN_DIRS) {
    list.push(path.join(dir, executable));
  }
  return list;
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function resolveFromPath(binaryName: "ffmpeg" | "ffprobe"): string | undefined {
  const lookup = spawnSync("where", [binaryName], {
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

export function resolveBinaryPaths(options: ResolveBinaryOptions = {}): BinaryPaths {
  const warnings: string[] = [];
  const ffmpegCandidates = candidateBinaryPaths("ffmpeg", options.ffmpegPathOverride);
  const ffprobeCandidates = candidateBinaryPaths("ffprobe", options.ffprobePathOverride);

  let ffmpegPath = firstExisting(ffmpegCandidates);
  let ffprobePath = firstExisting(ffprobeCandidates);

  if (!ffmpegPath) {
    ffmpegPath = resolveFromPath("ffmpeg");
  }

  if (!ffprobePath) {
    ffprobePath = resolveFromPath("ffprobe");
  }

  if (!ffmpegPath || !ffprobePath) {
    throw new Error(
      "Could not find ffmpeg.exe and ffprobe.exe. Place them in resources/bin or set custom paths in Settings."
    );
  }

  return {
    ffmpegPath,
    ffprobePath,
    warnings,
  };
}
