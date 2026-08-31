import type { DragEvent } from "react";
import { usePackager } from "@renderer/app/PackagerContext";
import { formatClock, isVideoFileName, requiresUpscale } from "@renderer/lib/helpers";
import { LanguageSelect } from "./LanguageSelect";

export function StepPanels() {
  const { workMode, packageStep, updateStep } = usePackager();
  if (workMode === "update") {
    if (updateStep === "package") return <UpdatePackagePanel />;
    if (updateStep === "tracks") return <UpdateTracksPanel />;
    return <EncodePanel />;
  }
  switch (packageStep) {
    case "source":
      return <SourcePanel />;
    case "identity":
      return <IdentityPanel />;
    case "audio":
      return <AudioPanel />;
    case "subtitles":
      return <SubtitlePanel />;
    case "ladder":
      return <LadderPanel />;
    case "destination":
      return <DestinationPanel />;
    default:
      return <EncodePanel />;
  }
}

function SourcePanel() {
  const { videoPath, videoInfo, pickVideo, loadVideo, statusMessage } = usePackager();

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined;
    if (!file?.path || !isVideoFileName(file.name)) return;
    void loadVideo(file.path);
  }

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Source</p>
        <h2>Import the master file</h2>
        <p>MP4, MKV, MOV and related containers. The file is probed with FFprobe before the rest of the job is configured.</p>
      </header>

      <div
        className={`dropzone ${videoPath ? "has-file" : ""}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <strong>{videoPath ? "Source loaded" : "Drop a video file here"}</strong>
        <p>{videoPath || "or browse from disk"}</p>
        <button type="button" className="primary" onClick={() => void pickVideo()}>
          Browse source
        </button>
      </div>

      {videoInfo ? (
        <dl className="spec-grid">
          <div>
            <dt>Duration</dt>
            <dd>{formatClock(videoInfo.durationSeconds)}</dd>
          </div>
          <div>
            <dt>Resolution</dt>
            <dd>
              {videoInfo.width}×{videoInfo.height}
            </dd>
          </div>
          <div>
            <dt>Frame rate</dt>
            <dd>{videoInfo.frameRate > 0 ? `${videoInfo.frameRate.toFixed(3)} fps` : "Unknown"}</dd>
          </div>
          <div>
            <dt>Video codec</dt>
            <dd>{videoInfo.videoCodec}</dd>
          </div>
          <div>
            <dt>Audio streams</dt>
            <dd>{videoInfo.audioStreamCount}</dd>
          </div>
          <div>
            <dt>Default language</dt>
            <dd>{videoInfo.defaultAudioLanguage || "und"}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">{statusMessage}</p>
      )}
    </div>
  );
}

function IdentityPanel() {
  const {
    contentType,
    movieTitle,
    setMovieTitle,
    seriesTitle,
    setSeriesTitle,
    seasonNumber,
    setSeasonNumber,
    episodeNumber,
    setEpisodeNumber,
    episodeTitle,
    setEpisodeTitle,
  } = usePackager();

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Identity</p>
        <h2>{contentType === "movie" ? "Movie catalog title" : "Series episode metadata"}</h2>
        <p>
          {contentType === "movie"
            ? "This name becomes the output folder and metadata title."
            : "Season and episode numbers drive the HLS folder layout used by the catalog."}
        </p>
      </header>

      {contentType === "movie" ? (
        <label className="field-lg">
          Movie title
          <input value={movieTitle} onChange={(e) => setMovieTitle(e.target.value)} placeholder="Sinners" autoFocus />
        </label>
      ) : (
        <div className="form-grid">
          <label className="span-2">
            Series title
            <input value={seriesTitle} onChange={(e) => setSeriesTitle(e.target.value)} placeholder="Series name" autoFocus />
          </label>
          <label>
            Season
            <input type="number" min={1} value={seasonNumber} onChange={(e) => setSeasonNumber(Number.parseInt(e.target.value, 10) || 0)} />
          </label>
          <label>
            Episode
            <input type="number" min={1} value={episodeNumber} onChange={(e) => setEpisodeNumber(Number.parseInt(e.target.value, 10) || 0)} />
          </label>
          <label className="span-2">
            Episode title (optional)
            <input value={episodeTitle} onChange={(e) => setEpisodeTitle(e.target.value)} placeholder="Pilot" />
          </label>
        </div>
      )}
    </div>
  );
}

function AudioPanel() {
  const {
    audioTracks,
    addExternalAudio,
    addOriginalAudio,
    updateAudioTrack,
    removeAudioTrack,
    setDefaultAudio,
  } = usePackager();

  const hasOriginal = audioTracks.some((track) => track.source === "video-original");

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Audio</p>
        <h2>Program audio</h2>
        <p>Original audio from the source file is added automatically. Add dubbed tracks only when you need extra languages.</p>
      </header>

      <div className="toolbar">
        <button type="button" className="primary" onClick={() => void addExternalAudio()}>
          Add dubbed audio
        </button>
        {!hasOriginal ? (
          <button type="button" className="secondary" onClick={addOriginalAudio}>
            Restore original from video
          </button>
        ) : null}
      </div>

      <div className="track-list">
        {audioTracks.map((track) => {
          const isOriginal = track.source === "video-original";
          return (
            <article key={track.id} className={`track-card ${isOriginal ? "track-card-simple" : ""}`}>
              <header>
                <strong>{track.name || "Untitled track"}</strong>
                <span className={`chip ${isOriginal ? "" : "chip-ext"}`}>{isOriginal ? "Original" : "Dubbed"}</span>
                {track.isDefault ? <span className="chip chip-default">Default</span> : null}
              </header>
              {isOriginal ? (
                <p className="track-summary muted">
                  Uses the embedded audio stream from the source file ({track.language}).
                </p>
              ) : (
                <>
                  <div className="form-grid compact">
                    <label>
                      Name
                      <input value={track.name} onChange={(e) => updateAudioTrack(track.id, { name: e.target.value })} />
                    </label>
                    <label>
                      Language
                      <LanguageSelect
                        value={track.language}
                        onChange={(value) => updateAudioTrack(track.id, { language: value })}
                        ariaLabel="Audio language"
                      />
                    </label>
                    <label>
                      Offset (ms)
                      <input
                        type="number"
                        step={100}
                        value={track.audioOffsetMs ?? 0}
                        onChange={(e) => updateAudioTrack(track.id, { audioOffsetMs: Number.parseInt(e.target.value, 10) || 0 })}
                      />
                    </label>
                  </div>
                  <footer className="track-foot">
                    <label className="toggle">
                      <input type="checkbox" checked={track.isDefault} onChange={(e) => setDefaultAudio(track.id, e.target.checked)} />
                      Default program
                    </label>
                    <span className="path-text">{track.filePath}</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={async () => {
                        const selected = await window.electronAPI.pickAudio();
                        if (selected) updateAudioTrack(track.id, { filePath: selected });
                      }}
                    >
                      Replace file
                    </button>
                    <button type="button" className="danger" onClick={() => removeAudioTrack(track.id)}>
                      Remove
                    </button>
                  </footer>
                </>
              )}
              {isOriginal ? (
                <footer className="track-foot">
                  <label>
                    Language
                    <LanguageSelect
                      value={track.language}
                      onChange={(value) => updateAudioTrack(track.id, { language: value })}
                      ariaLabel="Original audio language"
                    />
                  </label>
                  <label className="toggle">
                    <input type="checkbox" checked={track.isDefault} onChange={(e) => setDefaultAudio(track.id, e.target.checked)} />
                    Default program
                  </label>
                </footer>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function SubtitlePanel() {
  const { subtitles, addSubtitle, updateSubtitle, removeSubtitle, setDefaultSubtitle, goNext } = usePackager();

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Subtitles</p>
        <h2>Captions (optional)</h2>
        <p>Skip this step if the title ships without subtitles. SRT files are converted to VTT automatically.</p>
      </header>

      <div className="toolbar">
        <button type="button" className="primary" onClick={() => void addSubtitle()}>
          Add subtitle
        </button>
        {subtitles.length === 0 ? (
          <button type="button" className="secondary" onClick={goNext}>
            Continue without subtitles
          </button>
        ) : null}
      </div>

      <div className="track-list">
        {subtitles.map((sub) => (
          <article key={sub.id} className="track-card">
            <header>
              <strong>{sub.name || "Untitled subtitle"}</strong>
              <span className="chip">{sub.inputFormat.toUpperCase()}</span>
              {sub.isDefault ? <span className="chip chip-default">Default</span> : null}
            </header>
            <div className="form-grid compact">
              <label>
                Name
                <input value={sub.name} onChange={(e) => updateSubtitle(sub.id, { name: e.target.value })} />
              </label>
              <label>
                Language
                <LanguageSelect value={sub.language} onChange={(value) => updateSubtitle(sub.id, { language: value })} ariaLabel="Subtitle language" />
              </label>
            </div>
            <footer className="track-foot">
              <label className="toggle">
                <input type="checkbox" checked={sub.isDefault} onChange={(e) => setDefaultSubtitle(sub.id, e.target.checked)} />
                Default
              </label>
              <span className="path-text">{sub.filePath}</span>
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  const picked = await window.electronAPI.pickSubtitle();
                  if (picked) updateSubtitle(sub.id, { filePath: picked, inputFormat: picked.toLowerCase().endsWith(".srt") ? "srt" : "vtt" });
                }}
              >
                Replace file
              </button>
              <button type="button" className="danger" onClick={() => removeSubtitle(sub.id)}>
                Remove
              </button>
            </footer>
          </article>
        ))}
        {subtitles.length === 0 ? <p className="empty-hint">No subtitles attached. Continue if captions are not required.</p> : null}
      </div>
    </div>
  );
}

function LadderPanel() {
  const { qualities, videoInfo, updateQuality, applyLadderPreset } = usePackager();
  const enabledCount = qualities.filter((q) => q.enabled).length;

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Quality</p>
        <h2>Adaptive ladder</h2>
        <p>
          A balanced ladder is applied automatically from the source resolution. Adjust only if you need a different delivery profile.
        </p>
      </header>

      {videoInfo ? (
        <p className="info-banner">
          {enabledCount} rendition{enabledCount === 1 ? "" : "s"} enabled for {videoInfo.width}×{videoInfo.height} source (balanced bitrates).
        </p>
      ) : null}

      <div className="toolbar preset-row">
        <span className="preset-label">Presets</span>
        <button type="button" className="secondary" onClick={() => applyLadderPreset("high")}>
          High
        </button>
        <button type="button" className="secondary" onClick={() => applyLadderPreset("balanced")}>
          Balanced
        </button>
        <button type="button" className="secondary" onClick={() => applyLadderPreset("low")}>
          Low size
        </button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>On</th>
            <th>Rendition</th>
            <th>Resolution</th>
            <th>Bitrate</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {qualities
            .slice()
            .sort((a, b) => b.height - a.height)
            .map((q) => {
              const disabledBySource = !!videoInfo && requiresUpscale(videoInfo.width, videoInfo.height, q.width, q.height);
              return (
                <tr key={q.key} className={q.enabled && !disabledBySource ? "row-on" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={q.enabled}
                      disabled={disabledBySource}
                      onChange={(e) => updateQuality(q.key, { enabled: e.target.checked })}
                      aria-label={`Enable ${q.label}`}
                    />
                  </td>
                  <td>{q.label}</td>
                  <td>
                    {q.width}×{q.height}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={100}
                      step={50}
                      value={q.bitrateKbps}
                      onChange={(e) => updateQuality(q.key, { bitrateKbps: Number.parseInt(e.target.value, 10) || 0 })}
                    />
                  </td>
                  <td>{disabledBySource ? <span className="chip">Above source</span> : null}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function DestinationPanel() {
  const { outputDir, pickOutputFolder, allowOverwrite, setAllowOverwrite, outputPreview } = usePackager();

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Output</p>
        <h2>Save location</h2>
        <p>Choose the base folder. The app creates a dated package folder automatically.</p>
      </header>

      <div className="path-row">
        <input value={outputDir} readOnly placeholder="Select a destination folder" />
        <button type="button" className="primary" onClick={() => void pickOutputFolder()}>
          Browse
        </button>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={allowOverwrite} onChange={(e) => setAllowOverwrite(e.target.checked)} />
        Allow overwrite if the output folder already exists
      </label>
      <pre className="tree">{outputPreview}</pre>
    </div>
  );
}

function UpdatePackagePanel() {
  const { packageDir, pickPackageFolder, scannedPackage, masterPreview } = usePackager();

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">Existing package</p>
        <h2>Open an HLS folder</h2>
        <p>Select the folder that contains master.m3u8. Video is left untouched; only new tracks are packaged.</p>
      </header>
      <div className="path-row">
        <input value={packageDir} readOnly placeholder="Folder containing master.m3u8" />
        <button type="button" className="primary" onClick={() => void pickPackageFolder()}>
          Browse
        </button>
      </div>
      {scannedPackage ? (
        <>
          <dl className="spec-grid">
            <div>
              <dt>Variants</dt>
              <dd>{scannedPackage.parsed.videoVariants.length}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{scannedPackage.parsed.audioTracks.length}</dd>
            </div>
            <div>
              <dt>Subtitles</dt>
              <dd>{scannedPackage.parsed.subtitles.length}</dd>
            </div>
            <div>
              <dt>Segment</dt>
              <dd>{scannedPackage.segmentDuration}s</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatClock(scannedPackage.durationSeconds)}</dd>
            </div>
          </dl>
          <pre className="tree">{masterPreview || "No preview loaded."}</pre>
        </>
      ) : null}
    </div>
  );
}

function UpdateTracksPanel() {
  const {
    updateSubtitles,
    updateAudioTracks,
    addUpdateSubtitle,
    updateUpdateSubtitle,
    removeUpdateSubtitle,
    addUpdateAudio,
    updateUpdateAudio,
    removeUpdateAudio,
  } = usePackager();

  return (
    <div className="stage-body">
      <header className="stage-head">
        <p className="kicker">New tracks</p>
        <h2>Add audio or subtitles</h2>
        <p>These tracks are muxed into the existing package and the master playlist is rewritten.</p>
      </header>

      <div className="split-cols">
        <section>
          <div className="toolbar">
            <h3>Subtitles</h3>
            <button type="button" className="secondary" onClick={() => void addUpdateSubtitle()}>
              Add subtitle
            </button>
          </div>
          {updateSubtitles.map((sub) => (
            <article key={sub.id} className="track-card">
              <div className="form-grid compact">
                <label>
                  Name
                  <input value={sub.name} onChange={(e) => updateUpdateSubtitle(sub.id, { name: e.target.value })} />
                </label>
                <label>
                  Language
                  <LanguageSelect value={sub.language} onChange={(value) => updateUpdateSubtitle(sub.id, { language: value })} ariaLabel="Update subtitle language" />
                </label>
              </div>
              <footer className="track-foot">
                <span className="path-text">{sub.filePath}</span>
                <button type="button" className="danger" onClick={() => removeUpdateSubtitle(sub.id)}>
                  Remove
                </button>
              </footer>
            </article>
          ))}
          {updateSubtitles.length === 0 ? <p className="empty-hint">No new subtitles.</p> : null}
        </section>

        <section>
          <div className="toolbar">
            <h3>Dubbed audio</h3>
            <button type="button" className="secondary" onClick={() => void addUpdateAudio()}>
              Add audio
            </button>
          </div>
          {updateAudioTracks.map((track) => (
            <article key={track.id} className="track-card">
              <div className="form-grid compact">
                <label>
                  Name
                  <input value={track.name} onChange={(e) => updateUpdateAudio(track.id, { name: e.target.value })} />
                </label>
                <label>
                  Language
                  <LanguageSelect value={track.language} onChange={(value) => updateUpdateAudio(track.id, { language: value })} ariaLabel="Update audio language" />
                </label>
                <label>
                  Offset (ms)
                  <input
                    type="number"
                    step={100}
                    value={track.audioOffsetMs ?? 0}
                    onChange={(e) => updateUpdateAudio(track.id, { audioOffsetMs: Number.parseInt(e.target.value, 10) || 0 })}
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={track.isDefault}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      updateUpdateAudio(track.id, { isDefault: checked });
                      if (checked) {
                        for (const other of updateAudioTracks) {
                          if (other.id !== track.id && other.isDefault) {
                            updateUpdateAudio(other.id, { isDefault: false });
                          }
                        }
                      }
                    }}
                  />
                  Default
                </label>
              </div>
              <footer className="track-foot">
                <span className="path-text">{track.filePath}</span>
                <button type="button" className="danger" onClick={() => removeUpdateAudio(track.id)}>
                  Remove
                </button>
              </footer>
            </article>
          ))}
          {updateAudioTracks.length === 0 ? <p className="empty-hint">No new dubbed audio.</p> : null}
        </section>
      </div>
    </div>
  );
}

function EncodePanel() {
  const {
    workMode,
    isRunning,
    progress,
    logs,
    showLogs,
    setShowLogs,
    showCommand,
    setShowCommand,
    currentCommand,
    result,
    updateResult,
    startCurrentJob,
    cancelRun,
    openOutputFolder,
    openUpdatedPackageFolder,
    copyMasterPath,
    playInVlc,
    vlcAvailable,
    jobReady,
    elapsedSeconds,
    etaSeconds,
    safeProgress,
  } = usePackager();

  return (
    <div className="stage-body encode-stage">
      <header className="stage-head">
        <p className="kicker">{workMode === "update" ? "Sync" : "Encode"}</p>
        <h2>{workMode === "update" ? "Update the package" : "Review and package"}</h2>
        <p>Ctrl+Enter starts the job. Progress, FFmpeg command, and logs stay on this page while encoding.</p>
      </header>

      <div className="encode-meter">
        <div className="encode-meter-top">
          <span className="step-name">{progress.step}</span>
          <span>
            {formatClock(elapsedSeconds)} elapsed
            {etaSeconds !== null ? `  ·  ${formatClock(etaSeconds)} remaining` : ""}
          </span>
        </div>
        <div className="progress-wrap" aria-label="Task progress">
          <div className="progress-bar" style={{ width: `${safeProgress}%` }} />
        </div>
        <p className="muted">{progress.message}</p>
      </div>

      <div className="toolbar">
        <button type="button" className="primary final-start" disabled={isRunning || !jobReady} onClick={() => void startCurrentJob()}>
          {workMode === "update" ? "Update & sync" : "Start packaging"}
        </button>
        <button type="button" className="danger" disabled={!isRunning} onClick={() => void cancelRun()}>
          Cancel
        </button>
      </div>

      <details className="console" open={showCommand} onToggle={(e) => setShowCommand(e.currentTarget.open)}>
        <summary>Current FFmpeg command</summary>
        <pre className="log">{currentCommand || "No command yet."}</pre>
      </details>
      <details className="console" open={showLogs} onToggle={(e) => setShowLogs(e.currentTarget.open)}>
        <summary>Log ({logs.length})</summary>
        <pre className="log">{logs.join("\n") || "No logs yet."}</pre>
      </details>

      {workMode === "package" && result?.success ? (
        <div className="result-box">
          <p>Packaging completed.</p>
          <div className="toolbar">
            <button type="button" className="secondary" onClick={() => void openOutputFolder()}>
              Open output
            </button>
            <button type="button" className="secondary" onClick={() => void copyMasterPath()}>
              Copy master path
            </button>
            <button type="button" className="secondary" onClick={() => void playInVlc()} disabled={!vlcAvailable}>
              Test in VLC
            </button>
          </div>
        </div>
      ) : null}

      {workMode === "update" && updateResult?.success ? (
        <div className="result-box">
          <p>
            Added {updateResult.addedSubtitles.length} subtitle(s) and {updateResult.addedAudioTracks.length} audio track(s).
          </p>
          <button type="button" className="secondary" onClick={() => void openUpdatedPackageFolder()}>
            Open package folder
          </button>
        </div>
      ) : null}
    </div>
  );
}
