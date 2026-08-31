import { APP_NAME, APP_PUBLISHER, APP_TAGLINE, APP_VERSION } from "@shared/appMeta";
import { usePackager } from "@renderer/app/PackagerContext";

export function HomeScreen() {
  const { beginJob, encoderStatus, outputDir, setSettingsOpen } = usePackager();

  return (
    <div className="home">
      <div className="home-bg" aria-hidden="true" />
      <header className="home-brand">
        <div className="brand-mark">HLS</div>
        <div>
          <p className="brand-kicker">{APP_TAGLINE}</p>
          <h1>{APP_NAME}</h1>
          <p className="brand-sub">Package movies and series for HLS VOD — adaptive quality, multi-audio, and subtitles.</p>
        </div>
      </header>

      <section className="home-jobs" aria-label="Start a job">
        <button type="button" className="job-card" onClick={() => beginJob("movie")}>
          <span className="job-index">01</span>
          <span className="job-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect x="6" y="10" width="36" height="28" rx="3" stroke="currentColor" strokeWidth="1.8" />
              <path d="M6 32h36" stroke="currentColor" strokeWidth="1.8" />
              <path d="M14 18h12M14 22h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <h2>Movie</h2>
          <p>Standalone feature or title. Output is dated under the movie name.</p>
          <span className="job-cta">Start movie job</span>
        </button>

        <button type="button" className="job-card job-card-accent" onClick={() => beginJob("series")}>
          <span className="job-index">02</span>
          <span className="job-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect x="8" y="8" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <rect x="12" y="14" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <rect x="16" y="20" width="28" height="20" rx="2" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
          <h2>Series</h2>
          <p>Episode workflow with season and episode folders for catalog ingest.</p>
          <span className="job-cta">Start series job</span>
        </button>

        <button type="button" className="job-card" onClick={() => beginJob("update")}>
          <span className="job-index">03</span>
          <span className="job-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <path d="M10 24a14 14 0 1 1 4 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M10 34V24h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h2>Update package</h2>
          <p>Add dubbed audio or subtitles to an existing HLS folder without re-encoding video.</p>
          <span className="job-cta">Open existing package</span>
        </button>
      </section>

      <footer className="home-foot">
        <div>
          <span className="foot-label">Hardware</span>
          <span>{encoderStatus}</span>
        </div>
        <div>
          <span className="foot-label">Last destination</span>
          <span className="path-text">{outputDir || "Not set"}</span>
        </div>
        <div>
          <span className="foot-label">Publisher</span>
          <span>{APP_PUBLISHER}</span>
        </div>
        <div>
          <span className="foot-label">Version</span>
          <span>{APP_VERSION}</span>
        </div>
        <button type="button" className="ghost home-settings" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
      </footer>
    </div>
  );
}
