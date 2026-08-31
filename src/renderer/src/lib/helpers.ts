import { QUALITY_BUNDLES, QUALITY_PRESETS } from "@shared/defaults";
import type { AudioTrack, ContentType, QualityPreset, SubtitleTrack, VideoInput } from "@shared/types";

export function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function basename(filePath: string): string {
  return filePath.split(/[/\\]/g).pop() ?? filePath;
}

export function subtitleFormat(filePath: string): "vtt" | "srt" {
  return filePath.toLowerCase().endsWith(".srt") ? "srt" : "vtt";
}

export function createDefaultOriginalAudio(language: string): AudioTrack {
  const lang = language.trim() || "und";
  return {
    id: makeId(),
    source: "video-original",
    name: "Original Audio",
    language: lang,
    type: "original",
    isDefault: true,
  };
}

export function applySourceAwareQualities(video: VideoInput): QualityPreset[] {
  return QUALITY_PRESETS.map((item) => {
    const upscaled = requiresUpscale(video.width, video.height, item.width, item.height);
    const belowSource = item.height <= video.height;
    const enableByDefault = belowSource && !upscaled && (item.key !== "240" || video.height <= 480);
    return {
      ...item,
      enabled: enableByDefault,
      bitrateKbps: QUALITY_BUNDLES.balanced[item.key],
    };
  });
}

export function titleFromFilePath(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/i, "");
}

export function cloneQualityDefaults(): QualityPreset[] {
  return QUALITY_PRESETS.map((item) => ({ ...item }));
}

export function previewSafeName(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return cleaned.length > 0 ? cleaned : fallback;
}

export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--:--";
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function sourceCopyTierFolder(sourceHeight: number): string | null {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) return null;
  if (sourceHeight >= 1080) return "1080";
  if (sourceHeight >= 720) return "720";
  if (sourceHeight >= 480) return "480";
  if (sourceHeight >= 360) return "360";
  return "240";
}

export function requiresUpscale(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): boolean {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) return false;
  const widthScale = targetWidth / sourceWidth;
  const heightScale = targetHeight / sourceHeight;
  return Math.min(widthScale, heightScale) > 1;
}

export function normalizedLang(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || "und";
}

export function subtitleIdentity(name: string, language: string): string {
  return `${normalizedLang(language)}|${name.trim().toLowerCase()}`;
}

export function audioIdentity(name: string, language: string, type: AudioTrack["type"]): string {
  return `${normalizedLang(language)}|${name.trim().toLowerCase()}|${type}`;
}

export function isVideoFileName(name: string): boolean {
  return /\.(mp4|mkv|mov|m4v|avi|webm|ts|m2ts|mpg|mpeg)$/i.test(name);
}

export function buildOutputPreview(input: {
  qualities: QualityPreset[];
  audioTracks: AudioTrack[];
  subtitles: SubtitleTrack[];
  contentType: ContentType;
  movieTitle: string;
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  videoInfo: VideoInput | null;
}): string {
  const {
    qualities,
    audioTracks,
    subtitles,
    contentType,
    movieTitle,
    seriesTitle,
    seasonNumber,
    episodeNumber,
    episodeTitle,
    videoInfo,
  } = input;
  const normalizedSeason = Number.isFinite(seasonNumber) ? Math.max(1, Math.floor(seasonNumber)) : 1;
  const normalizedEpisode = Number.isFinite(episodeNumber) ? Math.max(1, Math.floor(episodeNumber)) : 1;
  const movieFolder = previewSafeName(movieTitle.trim(), "movie-title-required");
  const seriesFolder = previewSafeName(seriesTitle.trim() || "series", "series");
  const episodeBase = `episode-${String(normalizedEpisode).padStart(2, "0")}`;
  const episodeName =
    contentType === "series" && episodeTitle.trim()
      ? `${episodeBase}-${previewSafeName(episodeTitle, "episode")}`
      : episodeBase;

  const root =
    contentType === "series"
      ? `YYYY-MM-DD/${seriesFolder}/season-${String(normalizedSeason).padStart(2, "0")}/${episodeName}/`
      : `YYYY-MM-DD/${movieFolder}/`;
  const sourceTier = videoInfo ? sourceCopyTierFolder(videoInfo.height) : null;
  const sourceName = contentType === "series" ? seriesFolder : movieFolder;

  const lines: string[] = [root, "  master.m3u8", "  metadata.json", "  video/", "    sources/"];
  if (sourceTier) {
    lines.push(`      ${sourceTier}/${sourceName}.mp4`);
  } else {
    lines.push("      {source-tier}/{title}.mp4");
  }

  for (const quality of qualities.filter((q) => q.enabled).sort((a, b) => b.height - a.height)) {
    lines.push(`    ${quality.key}/`);
    lines.push("      index.m3u8");
    lines.push("      seg_000.ts");
  }

  lines.push("  audio/");
  for (const audio of audioTracks) {
    const lang = audio.language.trim() || "und";
    lines.push(`    ${lang}/`);
    lines.push("      index.m3u8");
    lines.push("      seg_000.aac");
  }

  if (subtitles.length > 0) {
    lines.push("  subtitles/");
    for (const subtitle of subtitles) {
      const lang = subtitle.language.trim() || "und";
      lines.push(`    ${lang}.vtt`);
    }
  }
  return lines.join("\n");
}
