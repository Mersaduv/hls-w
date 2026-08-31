import { APP_PUBLISHER } from "@shared/appMeta";
import { PACKAGE_STEPS, UPDATE_STEPS } from "@renderer/app/types";
import { usePackager } from "@renderer/app/PackagerContext";
import { formatClock } from "@renderer/lib/helpers";
import { StepPanels } from "./StepPanels";

function WorkbenchAlerts() {
  const { validationErrors, warnings } = usePackager();
  if (validationErrors.length === 0 && warnings.length === 0) return null;
  return (
    <div className="stage-alerts">
      {validationErrors.length > 0 ? (
        <section className="alert error" role="alert">
          <strong>Cannot start</strong>
          <ul>
            {validationErrors.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {warnings.length > 0 ? (
        <section className="alert warning" role="status">
          <strong>Warnings</strong>
          <ul>
            {warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function Workbench() {
  const {
    workMode,
    contentType,
    packageStep,
    updateStep,
    setPackageStep,
    setUpdateStep,
    goHome,
    goNext,
    goBack,
    isRunning,
    jobTitle,
    jobReady,
    statusMessage,
    setSettingsOpen,
    startCurrentJob,
    encoderStatus,
    elapsedSeconds,
    etaSeconds,
    safeProgress,
    performanceMode,
    encoderPreference,
  } = usePackager();

  const steps = workMode === "update" ? UPDATE_STEPS : PACKAGE_STEPS;
  const activeId = workMode === "update" ? updateStep : packageStep;
  const lastId = steps[steps.length - 1]?.id;
  const isLast = activeId === lastId;

  return (
    <div className="workbench">
      <header className="chrome">
        <div className="chrome-left">
          <button type="button" className="ghost" disabled={isRunning} onClick={goHome}>
            New job
          </button>
          <span className="chrome-sep" />
          <span className={`job-badge ${workMode === "update" ? "badge-update" : contentType === "series" ? "badge-series" : "badge-movie"}`}>
            {workMode === "update" ? "Update" : contentType === "series" ? "Series" : "Movie"}
          </span>
          <strong className="chrome-title">{jobTitle}</strong>
        </div>
        <div className="chrome-right">
          <span className={`live-pill ${isRunning ? "live" : jobReady ? "ready" : ""}`}>{statusMessage}</span>
          <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="workbench-body">
        <nav className="rail" aria-label="Job steps">
          <p className="rail-label">Job setup</p>
          {workMode === "package"
            ? PACKAGE_STEPS.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={`rail-step ${packageStep === step.id ? "active" : ""}`}
                  disabled={isRunning && step.id !== "encode"}
                  onClick={() => setPackageStep(step.id)}
                >
                  <span className="rail-index">{step.index}</span>
                  <span>
                    <strong>{step.label}</strong>
                    <em>{step.hint}</em>
                  </span>
                </button>
              ))
            : UPDATE_STEPS.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={`rail-step ${updateStep === step.id ? "active" : ""}`}
                  disabled={isRunning && step.id !== "encode"}
                  onClick={() => setUpdateStep(step.id)}
                >
                  <span className="rail-index">{step.index}</span>
                  <span>
                    <strong>{step.label}</strong>
                    <em>{step.hint}</em>
                  </span>
                </button>
              ))}
        </nav>

        <main className="stage">
          <WorkbenchAlerts />
          <StepPanels />
          <footer className="stage-nav">
            <button type="button" className="secondary" disabled={isRunning} onClick={goBack}>
              Back
            </button>
            {isLast ? (
              <button type="button" className="primary" disabled={isRunning || !jobReady} onClick={() => void startCurrentJob()}>
                {workMode === "update" ? "Update & sync" : "Start packaging"}
              </button>
            ) : (
              <button type="button" className="primary" disabled={isRunning} onClick={goNext}>
                Continue
              </button>
            )}
          </footer>
        </main>
      </div>

      <footer className="statusbar">
        <span>{encoderStatus}</span>
        <span>
          {encoderPreference}  ·  {performanceMode}
        </span>
        <span className="status-progress">
          <i style={{ width: `${safeProgress}%` }} />
        </span>
        <span className="tabular">
          {formatClock(elapsedSeconds)}
          {etaSeconds !== null ? `  /  ${formatClock(etaSeconds)}` : ""}
        </span>
        <span>{APP_PUBLISHER}</span>
      </footer>
    </div>
  );
}
