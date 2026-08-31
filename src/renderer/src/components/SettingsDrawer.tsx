import type { AppSettings } from "@shared/types";
import { APP_NAME, APP_PUBLISHER, APP_VERSION } from "@shared/appMeta";
import { usePackager } from "@renderer/app/PackagerContext";

export function SettingsDrawer() {
  const {
    settingsOpen,
    setSettingsOpen,
    performanceMode,
    setPerformanceMode,
    encoderPreference,
    setEncoderPreference,
    audioMode,
    setAudioMode,
    segmentDuration,
    setSegmentDuration,
    parallelAudioProcessing,
    setParallelAudioProcessing,
    useHardwareAcceleration,
    setUseHardwareAcceleration,
    theme,
    setTheme,
    ffmpegPath,
    setFfmpegPath,
    ffprobePath,
    setFfprobePath,
    encoderStatus,
    autoDetectBinaries,
  } = usePackager();

  if (!settingsOpen) return null;

  return (
    <div className="drawer-root">
      <button type="button" className="drawer-backdrop" aria-label="Close settings" onClick={() => setSettingsOpen(false)} />
      <aside className="drawer" role="dialog" aria-labelledby="settings-title">
        <header className="drawer-head">
          <div>
            <p className="kicker">Preferences</p>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Close">
            Esc
          </button>
        </header>

        <section className="drawer-section">
          <h3>Encoding</h3>
          <label>
            Performance mode
            <select value={performanceMode} onChange={(e) => setPerformanceMode(e.target.value as AppSettings["performanceMode"])}>
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality</option>
            </select>
          </label>
          <label>
            Encoder
            <select value={encoderPreference} onChange={(e) => setEncoderPreference(e.target.value as AppSettings["encoderPreference"])}>
              <option value="auto">Auto (recommended)</option>
              <option value="nvidia">NVIDIA NVENC</option>
              <option value="intel">Intel QSV</option>
              <option value="amd">AMD AMF</option>
              <option value="cpu">CPU libx264</option>
            </select>
          </label>
          <label>
            Audio mode
            <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as AppSettings["audioMode"])}>
              <option value="copy-when-possible">Copy AAC when possible</option>
              <option value="encode-aac">Always encode AAC</option>
            </select>
          </label>
          <label>
            Segment duration (sec)
            <input
              type="number"
              min={1}
              step={0.5}
              value={segmentDuration}
              onChange={(e) => setSegmentDuration(Number.parseFloat(e.target.value) || 0)}
            />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={parallelAudioProcessing} onChange={(e) => setParallelAudioProcessing(e.target.checked)} />
            Parallel audio processing
          </label>
          <label className="toggle">
            <input type="checkbox" checked={useHardwareAcceleration} onChange={(e) => setUseHardwareAcceleration(e.target.checked)} />
            Hardware acceleration
          </label>
          <label>
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as AppSettings["theme"])}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </section>

        <section className="drawer-section">
          <h3>Binaries</h3>
          <label>
            FFmpeg path
            <input value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder="Auto-detected if empty" />
          </label>
          <label>
            FFprobe path
            <input value={ffprobePath} onChange={(e) => setFfprobePath(e.target.value)} placeholder="Auto-detected if empty" />
          </label>
          <button type="button" className="secondary" onClick={() => void autoDetectBinaries()}>
            Auto-detect FFmpeg
          </button>
          <p className="muted encoder-line">{encoderStatus}</p>
        </section>

        <section className="drawer-section about-section">
          <h3>About</h3>
          <p className="about-name">{APP_NAME}</p>
          <p className="muted">Version {APP_VERSION}</p>
          <p className="about-publisher">Publisher: {APP_PUBLISHER}</p>
        </section>
      </aside>
    </div>
  );
}
