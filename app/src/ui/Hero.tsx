/**
 * Hero banner on the key visual (palette strip cropped off). The art drifts
 * slightly slower than the page and fades, so the banner collapses into the
 * slim sticky topbar. Framed low (object-position 62%) so the sponsor marks
 * in the art's lower half stay visible. One rAF-throttled scroll listener;
 * transform/opacity only, so the collapse never janks.
 */
import { useEffect, useState } from "react";

import keyart from "../assets/keyart.jpg";

const HERO_H = 320; // px, matches .hero height in styles.css

export function Hero() {
  const [y, setY] = useState(0);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setY(Math.min(window.scrollY, HERO_H)));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const gone = y / HERO_H; // 0 → fully shown, 1 → collapsed
  const layer = (speed: number) => ({
    transform: `translateY(${y * speed}px)`,
    opacity: 1 - gone * (0.3 + speed),
  });

  return (
    <div className="hero" aria-hidden style={{ height: HERO_H - y * 0.85 }}>
      {/* The key visual, slow plane; sponsors sit in its lower half. */}
      <img src={keyart} alt="" className="hero-art" style={layer(0.15)} />

      <div className="hero-title" style={{ opacity: 1 - gone * 1.6 }}>
        <h1>Bacalhau</h1>
        <p>
          compose <span className="pk">·</span> ship <span className="pk">·</span> observe
        </p>
      </div>
    </div>
  );
}
