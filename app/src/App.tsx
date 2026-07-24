import { useState } from "react";

import { Canvas } from "./ui/Canvas";
import { Dashboard } from "./ui/Dashboard";
import { useDemo } from "./state/useDemo";

export function App() {
  const demo = useDemo();
  const [view, setView] = useState<"canvas" | "dashboard">("dashboard");

  return (
    <div className="app">
      <header className="topbar">
        <h1>🐟 Bacalhau</h1>
        <nav>
          <button
            className={view === "canvas" ? "tab active" : "tab"}
            onClick={() => setView("canvas")}
          >
            Canvas
          </button>
          <button
            className={view === "dashboard" ? "tab active" : "tab"}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
        </nav>
        <span className="net">
          {demo.deployment ? "anvil · demo wallet" : "connecting…"}
        </span>
      </header>

      {demo.error && <div className="banner error">{demo.error}</div>}

      {view === "canvas" ? (
        <Canvas demo={demo} onShipped={() => setView("dashboard")} />
      ) : (
        <Dashboard demo={demo} />
      )}
    </div>
  );
}
