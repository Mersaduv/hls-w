import { promises as fs } from "node:fs";
import path from "node:path";
import type { AudioType, ContentType } from "@shared/types";

export interface MasterVideoVariant {
  quality: string;
  width: number;
  height: number;
  bitrateKbps: number;
  uri: string;
}

export interface MasterAudioTrack {
  name: string;
  language: string;
  type: AudioType;
  isDefault: boolean;
  uri?: string;
}

export interface MasterSubtitleTrack {
  name: string;
  language: string;
  isDefault: boolean;
  uri: string;
}

interface MasterManifestInput {
  videoVariants: MasterVideoVariant[];
  audioTracks: MasterAudioTrack[];
  subtitles: MasterSubtitleTrack[];
  audioGroupId?: string;
  subtitleGroupId?: string;
}

export function buildMasterPlaylist(input: MasterManifestInput): string {
  const audioGroupId = input.audioGroupId ?? "audio";
  const subtitleGroupId = input.subtitleGroupId ?? "subs";
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

  for (const audio of input.audioTracks) {
    const defaultFlag = audio.isDefault ? "YES" : "NO";
    const uriPart = audio.uri ? `,URI="${audio.uri}"` : "";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroupId}",NAME="${audio.name}",LANGUAGE="${audio.language}",AUTOSELECT=YES,DEFAULT=${defaultFlag}${uriPart}`
    );
  }

  if (input.subtitles.length > 0) {
    lines.push("");
    for (const subtitle of input.subtitles) {
      const defaultFlag = subtitle.isDefault ? "YES" : "NO";
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${subtitleGroupId}",NAME="${subtitle.name}",LANGUAGE="${subtitle.language}",AUTOSELECT=YES,DEFAULT=${defaultFlag},FORCED=NO,URI="${subtitle.uri}"`
      );
    }
  }

  lines.push("");
  for (const variant of input.videoVariants) {
    const bandwidth = variant.bitrateKbps * 1000;
    const subtitlePart = input.subtitles.length > 0 ? `,SUBTITLES="${subtitleGroupId}"` : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},CODECS="avc1.64001f,mp4a.40.2",AUDIO="${audioGroupId}"${subtitlePart}`
    );
    lines.push(variant.uri);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function writeMasterPlaylist(
  outputDir: string,
  input: MasterManifestInput
): Promise<string> {
  const content = buildMasterPlaylist(input);
  const masterPath = path.join(outputDir, "master.m3u8");
  await fs.writeFile(masterPath, content, "utf-8");
  return masterPath;
}

export interface StoredMetadata {
  hls_url?: string;
  content_type?: ContentType;
  movie_title?: string;
  series?: {
    title?: string;
    season?: number;
    episode?: number;
    episode_title?: string;
  };
  has_dubbed?: boolean;
  is_multi_audio?: boolean;
  has_subtitle?: boolean;
  qualities?: string[];
  audio_tracks?: Array<{
    name: string;
    language: string;
    type?: AudioType;
    default?: boolean;
    uri?: string;
  }>;
  subtitles?: Array<{
    name: string;
    language: string;
    default?: boolean;
    uri: string;
  }>;
}

export async function readMetadataJson(packageDir: string): Promise<StoredMetadata | null> {
  const metadataPath = path.join(packageDir, "metadata.json");
  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    return JSON.parse(raw) as StoredMetadata;
  } catch {
    return null;
  }
}

export async function writeMetadataJson(
  outputDir: string,
  payload: {
    contentType: ContentType;
    movieTitle?: string;
    seriesTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeTitle?: string;
    qualities: string[];
    audioTracks: MasterAudioTrack[];
    subtitles: MasterSubtitleTrack[];
  }
): Promise<string> {
  const isSeries = payload.contentType === "series";
  const metadata = {
    hls_url: "master.m3u8",
    content_type: payload.contentType,
    movie_title: isSeries ? undefined : payload.movieTitle,
    series: isSeries
      ? {
          title: payload.seriesTitle ?? "",
          season: payload.seasonNumber ?? 1,
          episode: payload.episodeNumber ?? 1,
          episode_title: payload.episodeTitle ?? "",
        }
      : undefined,
    has_dubbed: payload.audioTracks.some((track) => track.type === "dubbed"),
    is_multi_audio: payload.audioTracks.length > 1,
    has_subtitle: payload.subtitles.length > 0,
    qualities: payload.qualities,
    audio_tracks: payload.audioTracks.map((track) => ({
      name: track.name,
      language: track.language,
      type: track.type,
      default: track.isDefault,
      uri: track.uri,
    })),
    subtitles: payload.subtitles.map((track) => ({
      name: track.name,
      language: track.language,
      default: track.isDefault,
      uri: track.uri,
    })),
  };

  const metadataPath = path.join(outputDir, "metadata.json");
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");
  return metadataPath;
}
