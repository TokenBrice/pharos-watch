"use client";

import { useId } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { PSI_BAND_CLASSES, PSI_HEX_COLORS, PSI_PULSE_DURATION } from "@/lib/psi-colors";

export function PsiLighthouse({ band, color, size = 36 }: { band: string; color: string; size?: number }) {
  const uid = useId();
  const glowId = `psi-glow${uid}`;
  const bodyId = `psi-tBody${uid}`;
  const filterId = `psi-sg${uid}`;
  const dur = PSI_PULSE_DURATION[band] ?? 3;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 88 88"
      fill="none"
      className="shrink-0"
      aria-label={`Pharos lighthouse — ${band}`}
    >
      <defs>
        <style>{`
  @keyframes psi-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }
  @media (prefers-reduced-motion: reduce) {
    .psi-glow-circle { animation: none !important; opacity: 0.5; }
  }
`}</style>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </radialGradient>
        <linearGradient id={bodyId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#D4C8B0" />
          <stop offset="40%" stopColor="#E8DCC4" />
          <stop offset="100%" stopColor="#C8BBAA" />
        </linearGradient>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Glow behind lantern */}
      <circle
        cx="44"
        cy="16"
        r="16"
        fill={`url(#${glowId})`}
        className="psi-glow-circle"
        style={{
          animation: `psi-pulse ${dur}s ease-in-out infinite`,
        }}
      />

      {/* Beams */}
      <line x1="44" y1="16" x2="44" y2="-4" stroke={color} strokeWidth={2.5} opacity={0.55} strokeLinecap="round" />
      <line x1="44" y1="16" x2="22" y2="-2" stroke={color} strokeWidth={2.5} opacity={0.4} strokeLinecap="round" />
      <line x1="44" y1="16" x2="66" y2="-2" stroke={color} strokeWidth={2.5} opacity={0.4} strokeLinecap="round" />
      <line x1="44" y1="16" x2="4" y2="4" stroke={color} strokeWidth={2} opacity={0.25} strokeLinecap="round" />
      <line x1="44" y1="16" x2="84" y2="4" stroke={color} strokeWidth={2} opacity={0.25} strokeLinecap="round" />
      <line x1="44" y1="16" x2="-4" y2="14" stroke={color} strokeWidth={1.5} opacity={0.15} strokeLinecap="round" />
      <line x1="44" y1="16" x2="92" y2="14" stroke={color} strokeWidth={1.5} opacity={0.15} strokeLinecap="round" />

      {/* Lantern light */}
      <circle cx="44" cy="16" r="5" fill={color} opacity={0.85} filter={`url(#${filterId})`} />

      {/* Dome */}
      <path d="M39,22 C39,14 49,14 49,22 Z" fill="#E8DCC4" opacity={0.9} />

      {/* Lantern room */}
      <rect x="38.5" y="22" width="11" height="7" rx="1" fill="#F5F0E6" opacity={0.85} />
      <line x1="42" y1="22" x2="42" y2="29" stroke="#0a1628" strokeWidth={0.8} opacity={0.3} />
      <line x1="46" y1="22" x2="46" y2="29" stroke="#0a1628" strokeWidth={0.8} opacity={0.3} />

      {/* Gallery */}
      <rect x="34" y="29" width="20" height="4" rx="1.5" fill="#E8DCC4" opacity={0.85} />

      {/* Tower shaft */}
      <path d="M37,33 L51,33 L54,66 L34,66 Z" fill={`url(#${bodyId})`} opacity={0.8} />
      <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="#0d1f3c" strokeWidth={2} opacity={0.35} />
      <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="#0d1f3c" strokeWidth={2} opacity={0.35} />

      {/* Base */}
      <rect x="30" y="66" width="28" height="5" rx="2.5" fill="#E8DCC4" opacity={0.7} />
      <rect x="26" y="71" width="36" height="5" rx="2.5" fill="#E8DCC4" opacity={0.45} />
    </svg>
  );
}

export function StabilityIndex() {
  const { data, isLoading } = useStabilityIndex();

  if (isLoading) {
    return (
      <div className="flex items-center gap-4 py-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  if (!data || !data.current) return null;

  const { score, band, avg24h, avg24hBand, computedAt } = data.current;
  const displayScore = avg24h ?? score;
  const displayBand = avg24hBand ?? band;
  const history = data.history;

  // Delta from yesterday (first history point)
  const yesterday = history.length > 0 ? history[0] : null;
  const delta = yesterday ? Math.round((displayScore - yesterday.score) * 10) / 10 : null;

  const colorClass = PSI_BAND_CLASSES[displayBand] ?? "text-foreground";
  const sparkColor = PSI_HEX_COLORS[displayBand] ?? "#888";

  // Build sparkline points from history (oldest to newest) + current
  const sparkData = [...history].reverse().concat({ date: computedAt, score: displayScore, band: displayBand });

  return (
    <Link href="/stability-index" className="flex items-center gap-4 animate-in fade-in duration-300 hover:opacity-80 transition-opacity">
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Pharos Stability Index
      </span>
      <div className="flex items-center gap-3">
        <PsiLighthouse band={displayBand} color={sparkColor} />
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-extrabold font-mono tabular-nums ${colorClass}`}>
            {displayScore.toFixed(1)}
          </span>
          <span className={`text-sm font-bold uppercase tracking-wide ${colorClass}`}>
            {displayBand}
          </span>
        </div>
      </div>
      {delta !== null && (
        <span className={`text-sm font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
        </span>
      )}
      {sparkData.length > 1 && (
        <Sparkline data={sparkData} color={sparkColor} />
      )}
    </Link>
  );
}

function Sparkline({ data, color }: { data: { score: number; band: string }[]; color: string }) {
  const scores = data.map((d) => d.score);
  const min = scores.reduce((m, s) => Math.min(m, s), Infinity);
  const max = scores.reduce((m, s) => Math.max(m, s), -Infinity);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const padding = 2;

  const points = scores
    .map((s, i) => {
      const x = padding + (i / (scores.length - 1)) * (w - 2 * padding);
      const y = h - padding - ((s - min) / range) * (h - 2 * padding);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} className="shrink-0" aria-label="30-day stability index trend">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
