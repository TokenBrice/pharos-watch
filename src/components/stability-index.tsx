"use client";

import { useId } from "react";
import { PSI_PULSE_DURATION, type ConditionBand } from "@shared/lib/psi-colors";

export function PsiLighthouse({ band, color, size = 36 }: { band: string; color: string; size?: number }) {
  const uid = useId();
  const glowId = `psi-glow${uid}`;
  const bodyId = `psi-tBody${uid}`;
  const filterId = `psi-sg${uid}`;
  const dur = PSI_PULSE_DURATION[band as ConditionBand] ?? 3;

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
          <stop offset="0%" stopColor="var(--surface-raised, #D4C8B0)" />
          <stop offset="40%" stopColor="var(--border-default, #E8DCC4)" />
          <stop offset="100%" stopColor="var(--surface-raised, #C8BBAA)" />
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
      <path d="M39,22 C39,14 49,14 49,22 Z" fill="var(--border-default, #E8DCC4)" opacity={0.9} />

      {/* Lantern room */}
      <rect x="38.5" y="22" width="11" height="7" rx="1" fill="var(--surface-overlay, #F5F0E6)" opacity={0.85} />
      <line x1="42" y1="22" x2="42" y2="29" stroke="var(--text-primary, #0a1628)" strokeWidth={0.8} opacity={0.3} />
      <line x1="46" y1="22" x2="46" y2="29" stroke="var(--text-primary, #0a1628)" strokeWidth={0.8} opacity={0.3} />

      {/* Gallery */}
      <rect x="34" y="29" width="20" height="4" rx="1.5" fill="var(--border-default, #E8DCC4)" opacity={0.85} />

      {/* Tower shaft */}
      <path d="M37,33 L51,33 L54,66 L34,66 Z" fill={`url(#${bodyId})`} opacity={0.8} />
      <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="var(--text-secondary, #0d1f3c)" strokeWidth={2} opacity={0.35} />
      <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="var(--text-secondary, #0d1f3c)" strokeWidth={2} opacity={0.35} />

      {/* Base */}
      <rect x="30" y="66" width="28" height="5" rx="2.5" fill="var(--border-default, #E8DCC4)" opacity={0.7} />
      <rect x="26" y="71" width="36" height="5" rx="2.5" fill="var(--border-default, #E8DCC4)" opacity={0.45} />
    </svg>
  );
}
