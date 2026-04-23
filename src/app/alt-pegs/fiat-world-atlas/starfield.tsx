import type { CSSProperties } from "react";

interface AvoidZone {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

const AVOID_SKY: AvoidZone[] = [
  { x: 0.16, y: 0.48, rx: 0.22, ry: 0.55 },
  { x: 0.5, y: 0.42, rx: 0.1, ry: 0.3 },
  { x: 0.82, y: 0.55, rx: 0.18, ry: 0.45 },
];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

interface Star {
  cx: number;
  cy: number;
  size: number;
  opacity: number;
  delay: number;
}

function generateStars(count: number, seed: number): Star[] {
  const rnd = seededRandom(seed);
  const out: Star[] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 6) {
    attempts++;
    const x = rnd();
    const y = rnd();
    if (AVOID_SKY.some((z) => ((x - z.x) / z.rx) ** 2 + ((y - z.y) / z.ry) ** 2 < 1)) continue;
    const roll = rnd();
    const size = roll < 0.5 ? 1.5 : roll < 0.82 ? 2 : roll < 0.96 ? 3 : 4;
    const opacity = roll < 0.5 ? 0.45 : roll < 0.82 ? 0.65 : roll < 0.96 ? 0.9 : 1;
    out.push({ cx: x, cy: y, size, opacity, delay: rnd() * 3 });
  }
  return out;
}

const STARS = generateStars(80, 42);

export function Starfield() {
  return (
    <div className="peg-hero-starfield" aria-hidden="true">
      {STARS.map((s, i) => {
        const style: CSSProperties = {
          left: `${s.cx * 100}%`,
          top: `${s.cy * 100}%`,
          width: `${s.size}px`,
          height: `${s.size}px`,
          opacity: s.opacity,
          animationDelay: `${s.delay}s`,
        };
        return <span key={i} className="peg-hero-starfield__star" style={style} />;
      })}
    </div>
  );
}
