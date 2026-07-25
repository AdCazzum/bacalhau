/**
 * Hero banner on the key visual (palette strip cropped off). The banner opens
 * at the art's own aspect ratio, measured from the hero's width, so head and
 * sponsor marks are both in frame; on scroll it collapses into the slim
 * sticky topbar, the shrinking container cropping the fixed-height art.
 * Height is measured on mount and on resize; the scroll listener is rAF-throttled and
 * drives transform/opacity only, so the collapse never janks.
 */
import { useEffect, useRef, useState } from "react";

import keyart from "../assets/keyart.jpg";

const ART_RATIO = 2752 / 1142;

export function Hero() {
  const box = useRef<HTMLDivElement>(null);
  const [y, setY] = useState(0);
  const [h, setH] = useState(0);

  // Full art ratio from the hero's own width (the .app container is narrower
  // than the viewport): any mismatch or height cap makes `cover` crop the art.
  const naturalHeight = () =>
    Math.round((box.current?.offsetWidth ?? window.innerWidth) / ART_RATIO);

  useEffect(() => {
    setH(naturalHeight());
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

  const gone = h > 0 ? Math.min(y / h, 1) : 0; // 0 → fully shown, 1 → collapsed

  return (
    <div ref={box} className="hero" aria-hidden style={{ height: h > 0 ? Math.max(h - y * 0.85, 0) : undefined }}>
      {/* Fixed at natural height: the shrinking container crops it from the
          bottom instead of rescaling it. */}
      <img
        src={keyart}
        alt=""
        className="hero-art"
        style={{ height: h, transform: `translateY(${y * 0.15}px)`, opacity: 1 - gone * 0.45 }}
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
