/**
 * Parallax hero built on the key visual (src/assets/keyart.png, palette strip
 * cropped off). The art scrolls slowly; two overlay layers in the same
 * palette — a node mesh echoing the strategy graph, and an aqua wave — move
 * faster, so the banner reads as three depth planes and collapses into the
 * slim sticky topbar. One rAF-throttled scroll listener; transform/opacity
 * only, so the collapse never janks.
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
      {/* Back: the key visual. Slowest plane. */}
      <img src={keyart} alt="" className="hero-art" style={layer(0.15)} />

      {/* Middle: node mesh — the strategy-graph motif, Graph purple. */}
      <svg style={layer(0.35)} viewBox="0 0 1200 320">
        <g stroke="#6706c0" strokeWidth="1" opacity="0.55">
          <line x1="820" y1="240" x2="930" y2="170" />
          <line x1="930" y1="170" x2="1040" y2="220" />
          <line x1="1040" y1="220" x2="1130" y2="140" />
          <line x1="930" y1="170" x2="1010" y2="90" />
          <line x1="1010" y1="90" x2="1130" y2="140" />
          <line x1="820" y1="240" x2="1040" y2="220" />
        </g>
        <g fill="#00ebfc">
          {[[820, 240], [930, 170], [1040, 220], [1130, 140], [1010, 90]].map(
            ([cx, cy]) => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" />
            ),
          )}
        </g>
      </svg>

      {/* Front: aqua wave. Fastest plane. */}
      <svg style={layer(0.6)} viewBox="0 0 1200 320" preserveAspectRatio="xMidYMax slice">
        <path
          d="M0 290 C 150 250, 280 320, 430 285 S 720 240, 900 290 S 1120 320, 1200 280 L 1200 320 L 0 320 Z"
          fill="#00ebfc"
          opacity="0.16"
        />
        <path
          d="M0 305 C 200 275, 360 330, 560 300 S 900 265, 1200 305 L 1200 320 L 0 320 Z"
          fill="#00ebfc"
          opacity="0.28"
        />
      </svg>

      <div className="hero-title" style={{ opacity: 1 - gone * 1.6 }}>
        <h1>Bacalhau</h1>
        <p>
          compose <span className="pk">·</span> ship <span className="pk">·</span> observe
        </p>
      </div>
    </div>
  );
}
