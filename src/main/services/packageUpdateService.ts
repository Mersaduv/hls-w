import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AudioTrack,
  PackageUpdateJob,
  PackageUpdateResult,
  PackagingProgress,
  SubtitleTrack,
} from "@shared/types";
import { toSafeLanguageCode } from "@main/utils/stringUtils";
import { probePrimaryAudioCodec } from "@main/services/ffprobeService";
import {
  type MasterAudioTrack,
  type MasterSubtitleTrack,
  readMetadataJson,
  writeMasterPlaylist,
  writeMetadataJson,
} from "@main/services/manifestService";
import { prepareSubtitles } from "@main/services/subtitleService";
import { scanHlsPackage } from "@main/services/manifestParser";
import { FFmpegCommandBuilder } from "@main/services/ffmpegCommandBuilder";

interface FfmpegHost {
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
  }): Promise<void>;
}

interface BinaryPaths {
  ffmpegPath: string;
  ffprobePath: string;
}

interface PackageCallbacks {
  onProgress: (progress: PackagingProgress) => void;
  onLog: (line: string) => void;
}

interface UpdateAudioPlan {
  track: AudioTrack;
  langBase: string;
  langFolder: string;
  playlistPath: string;
  segmentPattern: string;
  inputPath: string;
  mapSelector: string;
  sourceCodec: string | null;
}

function subtitleIdentity(input: { language: string; name: string }): string {
  const language = toSafeLanguageCode(input.language) || "und";
  const name = input.name.trim().toLowerCase();
  return `${language}|${name}`;
}

function audioIdentity(input: { language: string; name: string; type: AudioTrack["type"] }): string {
  const language = toSafeLanguageCode(input.language) || "und";
  const name = input.name.trim().toLowerCase();
  return `${language}|${name}|${input.type}`;
}

function ensureSingleDefaultAudio(audioTracks: MasterAudioTrack[]): MasterAudioTrack[] {
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

function ensureSingleDefaultSubtitle(subtitles: MasterSubtitleTrack[]): MasterSubtitleTrack[] {
  let foundDefault = false;
  return subtitles.map((track) => {
    if (!track.isDefault) return track;
    if (!foundDefault) {
      foundDefault = true;
      return track;
    }
    return { ...track, isDefault: false };
  });
}

function buildExistingSubtitleLanguageCount(subtitles: MasterSubtitleTrack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const subtitle of subtitles) {
    const lang = toSafeLanguageCode(subtitle.language) || "und";
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return counts;
}

function buildExistingAudioLanguageCount(audioTracks: MasterAudioTrack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const track of audioTracks) {
    const lang = toSafeLanguageCode(track.language) || "und";
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return counts;
}

function validateUpdateJob(job: PackageUpdateJob): void {
  if (!job.packageDir.trim()) {
    throw new Error("HLS package folder is required.");
  }
  if (job.newSubtitles.length === 0 && job.newAudioTracks.length === 0) {
    throw new Error("Add at least one new subtitle or dubbed audio track.");
  }

  for (const subtitle of job.newSubtitles) {
    if (!subtitle.name.trim()) {
      throw new Error("Every subtitle track must have a name.");
    }
    if (!subtitle.language.trim()) {
      throw new Error(`Language code is required for subtitle "${subtitle.name}".`);
    }
    if (!subtitle.filePath) {
      throw new Error(`Subtitle file is missing for "${subtitle.name}".`);
    }
  }

  for (const track of job.newAudioTracks) {
    if (!track.name.trim()) {
      throw new Error("Audio track display name is required.");
    }
    if (!track.language.trim()) {
      throw new Error(`Language code is required for audio track "${track.name}".`);
    }
    if (!track.filePath) {
      throw new Error(`Audio file is required for track "${track.name}".`);
    }
  }

  const defaultAudioCount = job.newAudioTracks.filter((track) => track.isDefault).length;
  if (defaultAudioCount > 1) {
    throw new Error("Only one new audio track can be marked as default.");
  }
}

async function prepareUpdateAudioPlans(
  packageDir: string,
  newAudioTracks: AudioTrack[],
  existingAudioTracks: MasterAudioTrack[],
  ffprobePath: string
): Promise<UpdateAudioPlan[]> {
  const plans: UpdateAudioPlan[] = [];
  const languageCounter = buildExistingAudioLanguageCount(existingAudioTracks);

  for (const audioTrack of newAudioTracks) {
    const langBase = toSafeLanguageCode(audioTrack.language) || "und";
    const langCounter = languageCounter.get(langBase) ?? 0;
    languageCounter.set(langBase, langCounter + 1);
    const langFolder = langCounter === 0 ? langBase : `${langBase}_${langCounter + 1}`;

    const audioDir = path.join(packageDir, "audio", langFolder);
    await fs.mkdir(audioDir, { recursive: true });
    const playlistPath = path.join(audioDir, "index.m3u8");
    const segmentPattern = path.join(audioDir, "seg_%03d.aac");
    const inputPath = audioTrack.filePath;
    if (!inputPath) {
      throw new Error(`Audio file is required for track "${audioTrack.name}".`);
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

export async function runPackageUpdate(
  host: FfmpegHost,
  job: PackageUpdateJob,
  binaries: BinaryPaths,
  callbacks: PackageCallbacks
): Promise<PackageUpdateResult> {
  const warnings: string[] = [];
  const onProgress = callbacks.onProgress;
  const onLog = callbacks.onLog;
  const commandBuilder = new FFmpegCommandBuilder();

  validateUpdateJob(job);

  onProgress({
    step: "validating",
    message: "Scanning existing HLS package...",
    percent: 5,
  });

  const scanned = await scanHlsPackage(job.packageDir);
  const packageDir = scanned.packageDir;
  const existing = scanned.parsed;
  const segmentDuration = job.segmentDuration ?? scanned.segmentDuration;
  const durationSeconds = scanned.durationSeconds;

  if (durationSeconds <= 0) {
    warnings.push("Could not detect package duration from playlists; audio progress may be less accurate.");
  }

  const mergedSubtitles: MasterSubtitleTrack[] = [...existing.subtitles];
  const mergedAudio: MasterAudioTrack[] = [...existing.audioTracks];
  const addedSubtitles: PackageUpdateResult["addedSubtitles"] = [];
  const addedAudioTracks: PackageUpdateResult["addedAudioTracks"] = [];
  const existingSubtitleKeys = new Set(existing.subtitles.map((item) => subtitleIdentity(item)));
  const existingAudioKeys = new Set(
    existing.audioTracks.map((item) => audioIdentity({ language: item.language, name: item.name, type: item.type }))
  );

  const uniqueNewSubtitles: SubtitleTrack[] = [];
  const seenNewSubtitleKeys = new Set<string>();
  for (const subtitle of job.newSubtitles) {
    const key = subtitleIdentity(subtitle);
    if (existingSubtitleKeys.has(key)) {
      warnings.push(`Skipped duplicate subtitle "${subtitle.name}" (${subtitle.language}) because it already exists.`);
      continue;
    }
    if (seenNewSubtitleKeys.has(key)) {
      warnings.push(`Skipped duplicate subtitle "${subtitle.name}" (${subtitle.language}) in this update request.`);
      continue;
    }
    seenNewSubtitleKeys.add(key);
    uniqueNewSubtitles.push(subtitle);
  }

  const uniqueNewAudioTracks: AudioTrack[] = [];
  const seenNewAudioKeys = new Set<string>();
  for (const audioTrack of job.newAudioTracks) {
    const key = audioIdentity(audioTrack);
    if (existingAudioKeys.has(key)) {
      warnings.push(
        `Skipped duplicate audio track "${audioTrack.name}" (${audioTrack.language}, ${audioTrack.type}) because it already exists.`
      );
      continue;
    }
    if (seenNewAudioKeys.has(key)) {
      warnings.push(
        `Skipped duplicate audio track "${audioTrack.name}" (${audioTrack.language}, ${audioTrack.type}) in this update request.`
      );
      continue;
    }
    seenNewAudioKeys.add(key);
    uniqueNewAudioTracks.push(audioTrack);
  }

  if (uniqueNewSubtitles.length === 0 && uniqueNewAudioTracks.length === 0) {
    throw new Error("All selected tracks are duplicates. No new subtitle/audio track to add.");
  }

  if (uniqueNewSubtitles.length > 0) {
    onProgress({
      step: "subtitles",
      message: "Preparing new subtitles...",
      percent: 20,
    });

    const prepared = await prepareSubtitles(
      uniqueNewSubtitles,
      packageDir,
      buildExistingSubtitleLanguageCount(existing.subtitles)
    );

    for (const subtitle of prepared) {
      const entry: MasterSubtitleTrack = {
        name: subtitle.name,
        language: subtitle.language,
        isDefault: subtitle.isDefault,
        uri: subtitle.uri,
      };
      mergedSubtitles.push(entry);
      addedSubtitles.push(entry);
    }
  }

  if (uniqueNewAudioTracks.length > 0) {
    onProgress({
      step: "audio",
      message: "Encoding new audio track(s)...",
      percent: 35,
    });

    const plans = await prepareUpdateAudioPlans(
      packageDir,
      uniqueNewAudioTracks,
      existing.audioTracks,
      binaries.ffprobePath
    );

    const total = Math.max(plans.length, 1);
    const progressByTrack = new Array<number>(plans.length).fill(0);
    const startPercent = 35;
    const endPercent = 85;

    const reportOverall = (): void => {
      const ratio = progressByTrack.reduce((sum, value) => sum + value, 0) / total;
      onProgress({
        step: "audio",
        message: `Encoding ${plans.length} new audio track(s)...`,
        percent: startPercent + (endPercent - startPercent) * ratio,
      });
    };

    const runSingle = async (plan: UpdateAudioPlan, index: number): Promise<void> => {
      const args = commandBuilder.buildAudioCommand({
        inputPath: plan.inputPath,
        mapSelector: plan.mapSelector,
        playlistPath: plan.playlistPath,
        segmentPattern: plan.segmentPattern,
        segmentDuration,
        audioCodec: plan.sourceCodec ?? undefined,
        audioMode: job.audioMode,
        audioOffsetMs: plan.track.audioOffsetMs,
      });

      await host.runFfmpegPublic({
        binaryPath: binaries.ffmpegPath,
        args,
        durationSeconds: Math.max(durationSeconds, 1),
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

      const entry: MasterAudioTrack = {
        name: plan.track.name,
        language: plan.langBase,
        type: plan.track.type,
        isDefault: plan.track.isDefault,
        uri: `audio/${plan.langFolder}/index.m3u8`.replace(/\\/g, "/"),
      };
      mergedAudio.push(entry);
      addedAudioTracks.push({
        name: entry.name,
        language: entry.language,
        type: entry.type,
        isDefault: entry.isDefault,
        uri: entry.uri ?? "",
      });
    };

    if (job.parallelAudioProcessing && plans.length > 1) {
      await Promise.all(plans.map((plan, index) => runSingle(plan, index)));
    } else {
      for (let index = 0; index < plans.length; index += 1) {
        await runSingle(plans[index], index);
      }
    }
  }

  const normalizedAudio = ensureSingleDefaultAudio(mergedAudio);
  const normalizedSubtitles = ensureSingleDefaultSubtitle(mergedSubtitles);

  if (!normalizedAudio.some((track) => track.isDefault) && normalizedAudio.length > 0) {
    normalizedAudio[0].isDefault = true;
    warnings.push("No default audio track was selected; first track is now default.");
  }

  onProgress({
    step: "playlist",
    message: "Syncing master.m3u8...",
    percent: 92,
  });

  const masterPath = await writeMasterPlaylist(packageDir, {
    videoVariants: existing.videoVariants,
    audioTracks: normalizedAudio,
    subtitles: normalizedSubtitles,
    audioGroupId: existing.audioGroupId,
    subtitleGroupId: existing.subtitleGroupId,
  });

  onProgress({
    step: "metadata",
    message: "Syncing metadata.json...",
    percent: 96,
  });

  const storedMetadata = await readMetadataJson(packageDir);
  const contentType = storedMetadata?.content_type === "series" ? "series" : "movie";
  const metadataPath = await writeMetadataJson(packageDir, {
    contentType,
    movieTitle: storedMetadata?.movie_title,
    seriesTitle: storedMetadata?.series?.title,
    seasonNumber: storedMetadata?.series?.season,
    episodeNumber: storedMetadata?.series?.episode,
    episodeTitle: storedMetadata?.series?.episode_title,
    qualities: existing.videoVariants.map((variant) => variant.quality),
    audioTracks: normalizedAudio,
    subtitles: normalizedSubtitles,
  });

  onProgress({
    step: "completed",
    message: "Package update completed successfully.",
    percent: 100,
  });

  return {
    success: true,
    canceled: false,
    packageDir,
    masterPlaylistPath: masterPath,
    metadataPath,
    addedSubtitles,
    addedAudioTracks,
    warnings,
  };
}
