import type { AppSettings, QualityPreset } from "./types";

export const QUALITY_PRESETS: QualityPreset[] = [
  { key: "1080", label: "1080p", width: 1920, height: 1080, enabled: true, bitrateKbps: 4500 },
  { key: "720", label: "720p", width: 1280, height: 720, enabled: true, bitrateKbps: 2500 },
  { key: "480", label: "480p", width: 854, height: 480, enabled: true, bitrateKbps: 1100 },
  { key: "360", label: "360p", width: 640, height: 360, enabled: true, bitrateKbps: 700 },
  { key: "240", label: "240p", width: 426, height: 240, enabled: true, bitrateKbps: 300 }
];

export const DEFAULT_SETTINGS: AppSettings = {
  segmentDuration: 7.5,
  useHardwareAcceleration: true,
  performanceMode: "fast",
  encoderPreference: "auto",
  audioMode: "copy-when-possible",
  parallelAudioProcessing: true,
  theme: "dark"
};

export const QUALITY_BUNDLES = {
  high: {
    "1080": 5000,
    "720": 3000,
    "480": 1500,
    "360": 900,
    "240": 450
  },
  balanced: {
    "1080": 4500,
    "720": 2500,
    "480": 1100,
    "360": 700,
    "240": 300
  },
  low: {
    "1080": 3500,
    "720": 1800,
    "480": 800,
    "360": 500,
    "240": 220
  }
} as const;
