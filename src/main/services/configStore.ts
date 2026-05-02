import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppSettings } from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/defaults";

export class SettingsStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "settings.json");
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.load();
    const next = { ...current, ...partial };
    const tempPath = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(next, null, 2), "utf-8");
    await fs.rename(tempPath, this.filePath);
    return next;
  }
}
