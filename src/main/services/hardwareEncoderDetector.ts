import { spawn } from "node:child_process";
import type {
  EncoderCapabilities,
  EncoderDetectionResult,
  EncoderPreference,
} from "@shared/types";

export type SelectedEncoderKey = "nvidia" | "intel" | "amd" | "cpu";

export interface SelectedEncoder {
  key: SelectedEncoderKey;
  ffmpegEncoder: string;
  label: string;
  isHardware: boolean;
}

const ENCODER_CONFIG: Record<SelectedEncoderKey, SelectedEncoder> = {
  nvidia: {
    key: "nvidia",
    ffmpegEncoder: "h264_nvenc",
    label: "NVIDIA NVENC",
    isHardware: true,
  },
  intel: {
    key: "intel",
    ffmpegEncoder: "h264_qsv",
    label: "Intel QuickSync (QSV)",
    isHardware: true,
  },
  amd: {
    key: "amd",
    ffmpegEncoder: "h264_amf",
    label: "AMD AMF",
    isHardware: true,
  },
  cpu: {
    key: "cpu",
    ffmpegEncoder: "libx264",
    label: "CPU libx264",
    isHardware: false,
  },
};

function isAvailable(key: SelectedEncoderKey, capabilities: EncoderCapabilities): boolean {
  if (key === "nvidia") return capabilities.nvidiaNvenc;
  if (key === "intel") return capabilities.intelQsv;
  if (key === "amd") return capabilities.amdAmf;
  return capabilities.cpuLibx264;
}

function pickFastestAvailable(capabilities: EncoderCapabilities, useHardwareAcceleration: boolean): SelectedEncoder {
  if (useHardwareAcceleration) {
    if (capabilities.nvidiaNvenc) return ENCODER_CONFIG.nvidia;
    if (capabilities.amdAmf) return ENCODER_CONFIG.amd;
    // Prefer discrete AMD AMF over Intel QSV when both are present.
    if (capabilities.intelQsv) return ENCODER_CONFIG.intel;
  }
  return ENCODER_CONFIG.cpu;
}

export class HardwareEncoderDetector {
  async detectCapabilities(ffmpegPath: string): Promise<EncoderCapabilities> {
    const output = await this.readEncodersOutput(ffmpegPath);
    const text = output.toLowerCase();
    return {
      nvidiaNvenc: text.includes("h264_nvenc"),
      intelQsv: text.includes("h264_qsv"),
      amdAmf: text.includes("h264_amf"),
      cpuLibx264: text.includes("libx264"),
    };
  }

  async detectForUi(ffmpegPath: string): Promise<EncoderDetectionResult> {
    const capabilities = await this.detectCapabilities(ffmpegPath);
    const warnings: string[] = [];
    if (!capabilities.cpuLibx264) {
      warnings.push("libx264 was not found in ffmpeg encoders list.");
    }
    const preferredEncoder = pickFastestAvailable(capabilities, true).ffmpegEncoder;
    return {
      capabilities,
      preferredEncoder,
      warnings,
    };
  }

  selectEncoder(input: {
    capabilities: EncoderCapabilities;
    encoderPreference: EncoderPreference;
    useHardwareAcceleration: boolean;
  }): { selected: SelectedEncoder; warnings: string[] } {
    const warnings: string[] = [];
    const { capabilities, encoderPreference, useHardwareAcceleration } = input;

    if (encoderPreference === "auto") {
      const selected = pickFastestAvailable(capabilities, useHardwareAcceleration);
      return { selected, warnings };
    }

    const requestedKey = encoderPreference as SelectedEncoderKey;
    if (isAvailable(requestedKey, capabilities)) {
      return { selected: ENCODER_CONFIG[requestedKey], warnings };
    }

    const fallback = pickFastestAvailable(capabilities, useHardwareAcceleration);
    warnings.push(
      `${ENCODER_CONFIG[requestedKey].label} encoder is not available. Falling back to ${fallback.label}.`
    );
    return { selected: fallback, warnings };
  }

  private readEncodersOutput(ffmpegPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-encoders"];
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code !== 0 && stdout.trim().length === 0 && stderr.trim().length > 0) {
          reject(new Error(`ffmpeg -encoders failed: ${stderr.trim()}`));
          return;
        }
        resolve(`${stdout}\n${stderr}`);
      });
    });
  }
}

