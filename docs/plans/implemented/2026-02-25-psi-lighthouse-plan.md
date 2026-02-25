# PSI Lighthouse Visual Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a colored, pulsing lighthouse icon to the PSI widget that reflects the current stability band.

**Architecture:** Add a private `PsiLighthouse` React component (inline SVG) to `stability-index.tsx`. The lantern glow, light, and beams take the band's hex color. A CSS keyframe pulse on the glow circle varies speed by severity. Layout updated to place the icon left of the score.

**Tech Stack:** React 19, inline SVG, CSS animations via inline styles

**Design doc:** `docs/plans/2026-02-25-psi-lighthouse-design.md`

---

### Task 1: Add `PsiLighthouse` component

**Files:**
- Modify: `src/components/stability-index.tsx`

**Step 1: Add pulse duration map and `PsiLighthouse` function**

Add below the existing `SPARKLINE_COLORS` constant (after line 22), before the `StabilityIndex` export:

```tsx
const PULSE_DURATION: Record<string, number> = {
  BEDROCK: 3,
  STEADY: 3,
  TREMOR: 2,
  FRACTURE: 1.5,
  CRISIS: 1,
  MELTDOWN: 0.7,
};

function PsiLighthouse({ band, color }: { band: string; color: string }) {
  const dur = PULSE_DURATION[band] ?? 3;

  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 88 88"
      fill="none"
      className="shrink-0"
      aria-label={`Pharos lighthouse — ${band}`}
    >
      <defs>
        <radialGradient id="psi-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </radialGradient>
        <linearGradient id="psi-tBody" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#D4C8B0" />
          <stop offset="40%" stopColor="#E8DCC4" />
          <stop offset="100%" stopColor="#C8BBAA" />
        </linearGradient>
        <filter id="psi-sg" x="-40%" y="-40%" width="180%" height="180%">
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
        fill="url(#psi-glow)"
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

      {/* Shield */}
      <path d="M14,8 L74,8 L74,36 Q74,74 44,84 Q14,74 14,36 Z" fill="none" stroke="#E8DCC4" strokeWidth={3} opacity={0.5} strokeLinejoin="round" />

      {/* Lantern light */}
      <circle cx="44" cy="16" r="5" fill={color} opacity={0.85} filter="url(#psi-sg)" />

      {/* Dome */}
      <path d="M39,22 C39,14 49,14 49,22 Z" fill="#E8DCC4" opacity={0.9} />

      {/* Lantern room */}
      <rect x="38.5" y="22" width="11" height="7" rx="1" fill="#F5F0E6" opacity={0.85} />
      <line x1="42" y1="22" x2="42" y2="29" stroke="#0a1628" strokeWidth={0.8} opacity={0.3} />
      <line x1="46" y1="22" x2="46" y2="29" stroke="#0a1628" strokeWidth={0.8} opacity={0.3} />

      {/* Gallery */}
      <rect x="34" y="29" width="20" height="4" rx="1.5" fill="#E8DCC4" opacity={0.85} />

      {/* Tower shaft */}
      <path d="M37,33 L51,33 L54,66 L34,66 Z" fill="url(#psi-tBody)" opacity={0.8} />
      <line x1="36.2" y1="44" x2="52.2" y2="44" stroke="#0d1f3c" strokeWidth={2} opacity={0.35} />
      <line x1="35.3" y1="55" x2="53.1" y2="55" stroke="#0d1f3c" strokeWidth={2} opacity={0.35} />

      {/* Base */}
      <rect x="30" y="66" width="28" height="5" rx="2.5" fill="#E8DCC4" opacity={0.7} />
      <rect x="26" y="71" width="36" height="5" rx="2.5" fill="#E8DCC4" opacity={0.45} />
    </svg>
  );
}
```

**Step 2: Add the `psi-pulse` CSS keyframe**

Add a `<style>` element inside the SVG (just after the opening `<svg>` tag, before `<defs>`):

Actually, better approach — use a global `<style>` tag injected once. Add this inside the SVG's `<defs>` block:

```tsx
<style>{`@keyframes psi-pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }`}</style>
```

**Step 3: Integrate `PsiLighthouse` into `StabilityIndex` layout**

In the `StabilityIndex` return JSX, add the lighthouse icon before the score text. Change the inner layout from:

```tsx
<div className="flex items-baseline gap-2">
  <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
    Stability Index
  </span>
  <span className={`text-2xl font-bold tabular-nums ${colorClass}`}>
    {score.toFixed(1)}
  </span>
  <span className={`text-sm font-bold uppercase tracking-wide ${colorClass}`}>
    {band}
  </span>
</div>
```

To:

```tsx
<div className="flex items-center gap-3">
  <PsiLighthouse band={band} color={sparkColor} />
  <div className="flex items-baseline gap-2">
    <span className={`text-2xl font-bold tabular-nums ${colorClass}`}>
      {score.toFixed(1)}
    </span>
    <span className={`text-sm font-bold uppercase tracking-wide ${colorClass}`}>
      {band}
    </span>
  </div>
</div>
```

Note: The "Stability Index" text label is removed — the lighthouse icon replaces it as the visual identifier.

**Step 4: Build and type-check**

Run: `npm run build`
Expected: Build succeeds, no type errors.

**Step 5: Visual check**

Run: `npm run dev`
Open http://localhost:3000 and verify:
- Lighthouse appears left of the score
- Lantern and beams are green (assuming BEDROCK)
- Glow pulses gently at ~3s interval
- Tower body stays cream-colored
- Sparkline and delta still render correctly
- Mobile responsive — stacks cleanly

**Step 6: Commit**

```bash
git add src/components/stability-index.tsx
git commit -m "feat(psi): add colored lighthouse icon to stability index widget"
```

---

### Task 2: Update loading skeleton

**Files:**
- Modify: `src/components/stability-index.tsx`

**Step 1: Update the skeleton to include an icon placeholder**

Change the loading skeleton from:

```tsx
<div className="flex items-center gap-4 py-3">
  <Skeleton className="h-8 w-48" />
  <Skeleton className="h-6 w-32" />
</div>
```

To:

```tsx
<div className="flex items-center gap-4 py-3">
  <Skeleton className="h-9 w-9 rounded-full" />
  <Skeleton className="h-8 w-36" />
  <Skeleton className="h-6 w-32" />
</div>
```

**Step 2: Build verify**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/components/stability-index.tsx
git commit -m "feat(psi): update loading skeleton to include lighthouse placeholder"
```
