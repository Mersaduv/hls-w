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
  uri: string;
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
}

export function buildMasterPlaylist(input: MasterManifestInput): string {
  const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", ""];

  for (const audio of input.audioTracks) {
    const defaultFlag = audio.isDefault ? "YES" : "NO";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${audio.name}",LANGUAGE="${audio.language}",AUTOSELECT=YES,DEFAULT=${defaultFlag},URI="${audio.uri}"`
    );
  }

  if (input.subtitles.length > 0) {
    lines.push("");
    for (const subtitle of input.subtitles) {
      const defaultFlag = subtitle.isDefault ? "YES" : "NO";
      lines.push(
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${subtitle.name}",LANGUAGE="${subtitle.language}",AUTOSELECT=YES,DEFAULT=${defaultFlag},FORCED=NO,URI="${subtitle.uri}"`
      );
    }
  }

  lines.push("");
  for (const variant of input.videoVariants) {
    const bandwidth = variant.bitrateKbps * 1000;
    const subtitlePart = input.subtitles.length > 0 ? `,SUBTITLES="subs"` : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"${subtitlePart}`
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

export async function writeMetadataJson(
  outputDir: string,
  payload: {
    contentType: ContentType;
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
