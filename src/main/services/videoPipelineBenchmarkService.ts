import { spawn } from "node:child_process";
import type { PerformanceMode, QualityPreset, VideoPipelineMode } from "@shared/types";
import type { SelectedEncoder } from "@main/services/hardwareEncoderDetector";
import { FFmpegCommandBuilder } from "@main/services/ffmpegCommandBuilder";

interface BenchmarkInput {
  ffmpegPath: string;
  inputPath: string;
  qualities: QualityPreset[];
  segmentDuration: number;
  mode: PerformanceMode;
  encoder: SelectedEncoder;
  useHardwareAcceleration: boolean;
  sourceDurationSeconds: number;
  sourceFps?: number;
  outputFps?: number;
  onLog?: (line: string) => void;
}

interface BenchmarkResult {
  ok: boolean;
  elapsedMs: number;
  message: string;
}

interface BenchmarkOutput {
  pipelineMode: VideoPipelineMode;
  warnings: string[];
}

function quoteArg(arg: string): string {
  if (/[\s"]/g.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}

function commandToString(binary: string, args: string[]): string {
  return [quoteArg(binary), ...args.map(quoteArg)].join(" ");
}

export class VideoPipelineBenchmarkService {
  private readonly commandBuilder = new FFmpegCommandBuilder();

  async selectBestPipeline(input: BenchmarkInput): Promise<BenchmarkOutput> {
    if (!input.useHardwareAcceleration) {
      return { pipelineMode: "cpu-scale", warnings: [] };
    }

    if (input.encoder.key !== "nvidia") {
      // For now we keep non-NVIDIA paths on CPU scaling for compatibility.
      return { pipelineMode: "cpu-scale", warnings: [] };
    }

    const filtersText = await this.readFiltersOutput(input.ffmpegPath);
    const hasScaleCuda = filtersText.includes("scale_cuda");
    const hasPadCuda = filtersText.includes("pad_cuda");
    if (!hasScaleCuda || !hasPadCuda) {
      return {
        pipelineMode: "cpu-scale",
        warnings: ["GPU scaling filters are missing (scale_cuda/pad_cuda). Using CPU scaling."],
      };
    }

    const sampleSeconds = Math.max(12, Math.min(45, Math.floor(input.sourceDurationSeconds || 45)));
    const gpuArgs = this.commandBuilder.buildVideoBenchmarkCommand({
      inputPath: input.inputPath,
      qualities: input.qualities,
      mode: input.mode,
      encoder: input.encoder,
      useHardwareAcceleration: input.useHardwareAcceleration,
      pipelineMode: "gpu-scale",
      sampleSeconds,
      segmentDuration: input.segmentDuration,
      sourceFps: input.sourceFps,
      outputFps: input.outputFps,
    });

    const cpuArgs = this.commandBuilder.buildVideoBenchmarkCommand({
      inputPath: input.inputPath,
      qualities: input.qualities,
      mode: input.mode,
      encoder: input.encoder,
      useHardwareAcceleration: input.useHardwareAcceleration,
      pipelineMode: "cpu-scale",
      sampleSeconds,
      segmentDuration: input.segmentDuration,
      sourceFps: input.sourceFps,
      outputFps: input.outputFps,
    });

    input.onLog?.(`[benchmark] GPU-scale test (${sampleSeconds}s): ${commandToString(input.ffmpegPath, gpuArgs)}`);
    const gpuResult = await this.runBenchmark(input.ffmpegPath, gpuArgs);
    input.onLog?.(`[benchmark] ${gpuResult.message}`);

    input.onLog?.(`[benchmark] CPU-scale test (${sampleSeconds}s): ${commandToString(input.ffmpegPath, cpuArgs)}`);
    const cpuResult = await this.runBenchmark(input.ffmpegPath, cpuArgs);
    input.onLog?.(`[benchmark] ${cpuResult.message}`);

    if (gpuResult.ok && cpuResult.ok) {
      return {
        pipelineMode: gpuResult.elapsedMs <= cpuResult.elapsedMs ? "gpu-scale" : "cpu-scale",
        warnings: [],
      };
    }

    if (gpuResult.ok) {
      return {
        pipelineMode: "gpu-scale",
        warnings: ["CPU-scale benchmark failed. Using GPU-scale benchmark result."],
      };
    }

    if (cpuResult.ok) {
      return {
        pipelineMode: "cpu-scale",
        warnings: ["GPU-scale benchmark failed. Falling back to CPU-scale pipeline."],
      };
    }

    return {
      pipelineMode: "cpu-scale",
      warnings: [
        "GPU and CPU benchmark probes both failed. Falling back to CPU-scale for maximum compatibility.",
      ],
    };
  }

  private readFiltersOutput(ffmpegPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-filters"], { windowsHide: true });
      let output = "";

      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code !== 0 && output.trim().length === 0) {
          reject(new Error("Unable to read FFmpeg filter list."));
          return;
        }
        resolve(output.toLowerCase());
      });
    });
  }

  private runBenchmark(ffmpegPath: string, args: string[]): Promise<BenchmarkResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(ffmpegPath, args, { windowsHide: true });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      child.stdout.on("data", () => {
        // progress output is ignored during benchmark timing
      });

      child.on("error", (error) => {
        resolve({
          ok: false,
          elapsedMs: Date.now() - startedAt,
          message: `benchmark failed to start: ${error.message}`,
        });
      });

      child.on("close", (code) => {
        const elapsedMs = Date.now() - startedAt;
        if (code !== 0) {
          const compactError = stderr.trim().split(/\r?\n/).slice(-5).join(" | ");
          resolve({
            ok: false,
            elapsedMs,
            message: `benchmark failed (code ${code}) in ${elapsedMs}ms: ${compactError || "no stderr"}`,
          });
          return;
        }
        resolve({
          ok: true,
          elapsedMs,
          message: `benchmark finished in ${elapsedMs}ms`,
        });
      });
    });
  }
}
