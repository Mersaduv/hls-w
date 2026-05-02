export function ffmpegTimeToSeconds(raw: string): number {
  const parts = raw.trim().split(":");
  if (parts.length !== 3) return 0;
  const hours = Number.parseFloat(parts[0]) || 0;
  const minutes = Number.parseFloat(parts[1]) || 0;
  const seconds = Number.parseFloat(parts[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseProgressSeconds(line: string): number | null {
  const outTimeMsMatch = line.match(/out_time_ms=(\d+)/);
  if (outTimeMsMatch) {
    return Number.parseInt(outTimeMsMatch[1], 10) / 1_000_000;
  }

  const outTimeUsMatch = line.match(/out_time_us=(\d+)/);
  if (outTimeUsMatch) {
    return Number.parseInt(outTimeUsMatch[1], 10) / 1_000_000;
  }

  const outTimeMatch = line.match(/out_time=([0-9:.]+)/);
  if (outTimeMatch) {
    return ffmpegTimeToSeconds(outTimeMatch[1]);
  }

  const match = line.match(/time=([0-9:.]+)/);
  if (!match) return null;
  return ffmpegTimeToSeconds(match[1]);
}
