import { promises as fs } from "node:fs";
import path from "node:path";
import type { AudioType } from "@shared/types";
import type { MasterAudioTrack, MasterSubtitleTrack, MasterVideoVariant } from "@main/services/manifestService";

export interface ParsedMasterManifest {
  videoVariants: MasterVideoVariant[];
  audioTracks: MasterAudioTrack[];
  subtitles: MasterSubtitleTrack[];
  audioGroupId: string;
  subtitleGroupId: string;
}

function parseAttributeMap(line: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  let match: RegExpExecArray | null = regex.exec(line);
  while (match) {
    const key = match[1].toUpperCase();
    const value = (match[3] ?? match[4] ?? "").trim();
    attrs.set(key, value);
    match = regex.exec(line);
  }
  return attrs;
}

function inferQualityFromUri(uri: string): string {
  const normalized = uri.replace(/\\/g, "/");
  const folderMatch = normalized.match(/\/(\d{3,4})\//);
  if (folderMatch) return folderMatch[1];
  const labelMatch = normalized.match(/_(?:fhd|hd|sd)_(\d{3,4})\./i);
  if (labelMatch) return labelMatch[1];
  const tailMatch = normalized.match(/(\d{3,4})\.m3u8$/i);
  if (tailMatch) return tailMatch[1];
  return "unknown";
}

function inferAudioType(name: string, language: string): AudioType {
  const text = `${name} ${language}`.toLowerCase();
  if (text.includes("commentary")) return "commentary";
  if (text.includes("dub") || text.includes("دوبله") || text.includes("persian") || text.includes("farsi")) {
    return "dubbed";
  }
  return "original";
}

export function parseMasterPlaylist(content: string): ParsedMasterManifest {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const videoVariants: MasterVideoVariant[] = [];
  const audioTracks: MasterAudioTrack[] = [];
  const subtitles: MasterSubtitleTrack[] = [];
  let audioGroupId = "audio";
  let subtitleGroupId = "subs";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#")) continue;

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributeMap(line);
      const type = (attrs.get("TYPE") ?? "").toUpperCase();
      const groupId = attrs.get("GROUP-ID") ?? "";
      const name = attrs.get("NAME") ?? "Track";
      const language = attrs.get("LANGUAGE") ?? "und";
      const isDefault = (attrs.get("DEFAULT") ?? "NO").toUpperCase() === "YES";
      const uri = attrs.get("URI");

      if (type === "AUDIO") {
        if (groupId) audioGroupId = groupId;
        audioTracks.push({
          name,
          language,
          type: inferAudioType(name, language),
          isDefault,
          uri: uri || undefined,
        });
      }

      if (type === "SUBTITLES") {
        if (groupId) subtitleGroupId = groupId;
        if (uri) {
          subtitles.push({
            name,
            language,
            isDefault,
            uri,
          });
        }
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributeMap(line);
      const bandwidth = Number.parseInt(attrs.get("BANDWIDTH") ?? "0", 10);
      const resolution = attrs.get("RESOLUTION") ?? "0x0";
      const [widthText, heightText] = resolution.split("x");
      const width = Number.parseInt(widthText ?? "0", 10) || 0;
      const height = Number.parseInt(heightText ?? "0", 10) || 0;
      const streamAudioGroup = attrs.get("AUDIO");
      const streamSubtitleGroup = attrs.get("SUBTITLES");
      if (streamAudioGroup) audioGroupId = streamAudioGroup;
      if (streamSubtitleGroup) subtitleGroupId = streamSubtitleGroup;

      const uriLine = lines[index + 1];
      if (!uriLine || uriLine.startsWith("#")) continue;

      const uri = uriLine.replace(/\\/g, "/");
      videoVariants.push({
        quality: inferQualityFromUri(uri),
        width,
        height,
        bitrateKbps: Math.max(1, Math.round(bandwidth / 1000)),
        uri,
      });
    }
  }

  return {
    videoVariants,
    audioTracks,
    subtitles,
    audioGroupId,
    subtitleGroupId,
  };
}

export async function parseMediaPlaylistDuration(playlistPath: string): Promise<number> {
  const raw = await fs.readFile(playlistPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXTINF:")) continue;
    const value = trimmed.slice("#EXTINF:".length).split(",")[0]?.trim();
    const seconds = Number.parseFloat(value ?? "");
    if (Number.isFinite(seconds) && seconds > 0) {
      total += seconds;
    }
  }
  return total;
}

export async function detectPackageSegmentDuration(packageDir: string, variants: MasterVideoVariant[]): Promise<number> {
  for (const variant of variants) {
    const playlistPath = path.join(packageDir, variant.uri);
    try {
      const raw = await fs.readFile(playlistPath, "utf-8");
      const targetMatch = raw.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
      if (targetMatch) {
        const value = Number.parseFloat(targetMatch[1]);
        if (Number.isFinite(value) && value > 0) return value;
      }
      const extinfMatch = raw.match(/#EXTINF:([\d.]+)/);
      if (extinfMatch) {
        const value = Number.parseFloat(extinfMatch[1]);
        if (Number.isFinite(value) && value > 0) return Math.ceil(value);
      }
    } catch {
      // try next variant
    }
  }
  return 6;
}

export async function detectPackageDurationSeconds(
  packageDir: string,
  variants: MasterVideoVariant[]
): Promise<number> {
  for (const variant of variants) {
    const playlistPath = path.join(packageDir, variant.uri);
    try {
      const duration = await parseMediaPlaylistDuration(playlistPath);
      if (duration > 0) return duration;
    } catch {
      // try next variant
    }
  }
  return 0;
}

export interface ScannedHlsPackage {
  packageDir: string;
  masterPlaylistPath: string;
  metadataPath?: string;
  parsed: ParsedMasterManifest;
  segmentDuration: number;
  durationSeconds: number;
}

export async function scanHlsPackage(packageDir: string): Promise<ScannedHlsPackage> {
  const resolvedDir = path.resolve(packageDir);
  const masterPlaylistPath = path.join(resolvedDir, "master.m3u8");
  const metadataPath = path.join(resolvedDir, "metadata.json");

  let masterRaw: string;
  try {
    masterRaw = await fs.readFile(masterPlaylistPath, "utf-8");
  } catch {
    throw new Error(`master.m3u8 was not found in: ${resolvedDir}`);
  }

  const parsed = parseMasterPlaylist(masterRaw);
  if (parsed.videoVariants.length === 0) {
    throw new Error("No video variants were found in master.m3u8.");
  }

  const segmentDuration = await detectPackageSegmentDuration(resolvedDir, parsed.videoVariants);
  const durationSeconds = await detectPackageDurationSeconds(resolvedDir, parsed.videoVariants);

  let metadataExists: string | undefined;
  try {
    await fs.access(metadataPath);
    metadataExists = metadataPath;
  } catch {
    metadataExists = undefined;
  }

  return {
    packageDir: resolvedDir,
    masterPlaylistPath,
    metadataPath: metadataExists,
    parsed,
    segmentDuration,
    durationSeconds,
  };
}
