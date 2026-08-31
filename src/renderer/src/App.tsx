import { useEffect } from "react";
import { PackagerProvider, usePackager } from "./app/PackagerContext";
import { HomeScreen } from "./components/HomeScreen";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { Workbench } from "./components/Workbench";

function Shell() {
  const { view, settingsOpen, setSettingsOpen, isRunning, startCurrentJob, jobReady } = usePackager();

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && view === "workbench" && jobReady && !isRunning) {
        event.preventDefault();
        void startCurrentJob();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen, isRunning, startCurrentJob, jobReady, view]);

  return (
    <div className="app">
      {view === "home" ? <HomeScreen /> : <Workbench />}
      <SettingsDrawer />
    </div>
  );
}

export default function App() {
  return (
    <PackagerProvider>
      <Shell />
    </PackagerProvider>
  );
}
