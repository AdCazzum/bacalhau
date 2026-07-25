import { useState } from "react";

import { canWrite } from "./lib/chain";
import { Canvas } from "./ui/Canvas";
import { Dashboard } from "./ui/Dashboard";
import { Hero } from "./ui/Hero";
import { useDemo } from "./state/useDemo";

export function App() {
  const demo = useDemo();
  // Compose first: the canvas is the product, and landing on the dashboard hid
  // the templates behind a tab nobody thought to click.
  const [view, setView] = useState<"canvas" | "dashboard">("canvas");

  return (
    <div className="app">
      <Hero />
      <header className="topbar">
        <h1>QilinSwap</h1>
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
          {demo.deployment
            ? canWrite
              ? "anvil · demo wallet"
              : "Base Sepolia · read-only"
            : "connecting…"}
        </span>
      </header>

      {!canWrite && (
        <div className="banner">
          Live preview on Base Sepolia. Composing strategies and quoting are
          fully interactive; shipping, rebalancing and swapping need a funded
          key, so they run only on the local demo — <code>nix run .#dev</code>.
        </div>
      )}

      {demo.error && <div className="banner error">{demo.error}</div>}

      {view === "canvas" ? (
        <Canvas demo={demo} onShipped={() => setView("dashboard")} />
      ) : (
        <Dashboard demo={demo} />
      )}
    </div>
  );
}
