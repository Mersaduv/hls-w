export function toSafeLanguageCode(language: string): string {
  return language.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export function sanitizeFolderName(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return cleaned.length > 0 ? cleaned : "track";
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "00:00:00";
  const total = Math.floor(seconds);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
