import { useState } from "react";

import { canWrite, isPublicDemo } from "./lib/chain";
import { Canvas } from "./ui/Canvas";
import { Dashboard } from "./ui/Dashboard";
import { Hero } from "./ui/Hero";
import { Indexed } from "./ui/Indexed";
import { useDemo } from "./state/useDemo";

export function App() {
  const demo = useDemo();
  // Compose first: the canvas is the product, and landing on the dashboard hid
  // the templates behind a tab nobody thought to click.
  const [view, setView] = useState<"canvas" | "dashboard" | "indexed">("canvas");

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
          <button
            className={view === "indexed" ? "tab active" : "tab"}
            onClick={() => setView("indexed")}
          >
            Indexed
          </button>
        </nav>
        <span className="net">
          {demo.deployment
            ? canWrite
              ? isPublicDemo
                ? "Base Sepolia · shared demo wallet"
                : "anvil · demo wallet"
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

      {canWrite && isPublicDemo && (
        <div className="banner">
          Every action here is a real Base Sepolia transaction from a shared
          throwaway wallet — ship, swap and dock away, it is all testnet.
        </div>
      )}

      {demo.error && <div className="banner error">{demo.error}</div>}

      {view === "canvas" && <Canvas demo={demo} onShipped={() => setView("dashboard")} />}
      {view === "dashboard" && <Dashboard demo={demo} />}
      {view === "indexed" && <Indexed />}
    </div>
  );
}
