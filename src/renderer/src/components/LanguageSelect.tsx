import { LANGUAGE_OPTIONS } from "@renderer/data/languages";

export function LanguageSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const known = LANGUAGE_OPTIONS.some((item) => item.code === value);
  return (
    <select
      aria-label={ariaLabel}
      value={known ? value : value || "und"}
      onChange={(event) => onChange(event.target.value)}
    >
      {!known && value ? <option value={value}>{value}</option> : null}
      {LANGUAGE_OPTIONS.map((item) => (
        <option key={item.code} value={item.code}>
          {item.label} ({item.code})
        </option>
      ))}
    </select>
  );
}
