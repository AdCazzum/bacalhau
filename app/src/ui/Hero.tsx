/**
 * Hero banner on the key visual (palette strip cropped off). The banner opens
 * at the art's own aspect ratio (capped at 62vh) so head and sponsor marks are
 * both in frame, then collapses into the slim sticky topbar on scroll. Height
 * is measured on mount and on resize; the scroll listener is rAF-throttled and
 * drives transform/opacity only, so the collapse never janks.
 */
import { useEffect, useState } from "react";

import keyart from "../assets/keyart.jpg";

const ART_RATIO = 2752 / 1142;

const naturalHeight = () =>
  Math.round(Math.min(window.innerWidth / ART_RATIO, window.innerHeight * 0.62));

export function Hero() {
  const [y, setY] = useState(0);
  const [h, setH] = useState(naturalHeight);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setY(Math.min(window.scrollY, naturalHeight())));
    };
    const onResize = () => setH(naturalHeight());
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  const gone = Math.min(y / h, 1); // 0 → fully shown, 1 → collapsed

  return (
    <div className="hero" aria-hidden style={{ height: Math.max(h - y * 0.85, 0) }}>
      <img
        src={keyart}
        alt=""
        className="hero-art"
        style={{ transform: `translateY(${y * 0.15}px)`, opacity: 1 - gone * 0.45 }}
      />

      <div className="hero-title" style={{ opacity: 1 - gone * 1.6 }}>
        <h1>Bacalhau</h1>
        <p>
          compose <span className="pk">·</span> ship <span className="pk">·</span> observe
        </p>
      </div>
    </div>
  );
}
