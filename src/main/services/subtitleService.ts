import { promises as fs } from "node:fs";
import path from "node:path";
import type { SubtitleTrack } from "@shared/types";
import { toSafeLanguageCode } from "@main/utils/stringUtils";

export interface PreparedSubtitle {
  name: string;
  language: string;
  isDefault: boolean;
  uri: string;
  absolutePath: string;
}

function srtToVtt(input: string): string {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const lines = normalized.split("\n");
  const output: string[] = ["WEBVTT", ""];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? "";
    if (/^\d+$/.test(line.trim()) && /-->/.test(next)) {
      continue;
    }
    if (/-->/.test(line)) {
      output.push(line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2"));
      continue;
    }
    output.push(line);
  }

  return output.join("\n");
}

export async function prepareSubtitles(
  subtitleTracks: SubtitleTrack[],
  outputDir: string,
  existingLanguageCount?: Map<string, number>
): Promise<PreparedSubtitle[]> {
  const prepared: PreparedSubtitle[] = [];
  const subtitlesDir = path.join(outputDir, "subtitles");
  await fs.mkdir(subtitlesDir, { recursive: true });

  const languageCount = new Map(existingLanguageCount ?? []);

  for (const subtitle of subtitleTracks) {
    const baseLang = toSafeLanguageCode(subtitle.language);
    const lang = baseLang || "und";
    const seen = languageCount.get(lang) ?? 0;
    languageCount.set(lang, seen + 1);
    const suffix = seen === 0 ? "" : `_${seen + 1}`;
    const fileName = `${lang}${suffix}.vtt`;
    const targetPath = path.join(subtitlesDir, fileName);

    if (subtitle.inputFormat === "vtt") {
      await fs.copyFile(subtitle.filePath, targetPath);
    } else {
      const srt = await fs.readFile(subtitle.filePath, "utf-8");
      const vtt = srtToVtt(srt);
      await fs.writeFile(targetPath, vtt, "utf-8");
    }

    prepared.push({
      name: subtitle.name,
      language: lang,
      isDefault: subtitle.isDefault,
      uri: `subtitles/${fileName}`.replace(/\\/g, "/"),
      absolutePath: targetPath,
    });
  }

  return prepared;
}
