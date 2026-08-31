export const LANGUAGE_OPTIONS = [
  { code: "fa", label: "Persian" },
  { code: "en", label: "English" },
  { code: "ar", label: "Arabic" },
  { code: "tr", label: "Turkish" },
  { code: "ku", label: "Kurdish" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "hi", label: "Hindi" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "und", label: "Undetermined" },
] as const;

export function languageLabel(code: string): string {
  const found = LANGUAGE_OPTIONS.find((item) => item.code === code.toLowerCase());
  return found ? `${found.label} (${found.code})` : code;
}
