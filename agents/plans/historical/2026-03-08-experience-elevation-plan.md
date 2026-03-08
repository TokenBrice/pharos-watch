# Experience Elevation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Elevate Pharos from solid dashboard to premium intelligence product through three synergetic additions: narrative intelligence homepage, cinematic motion design, and dynamic shareable OG cards.

**Architecture:** Pure-frontend motion system (CSS keyframes + one React hook, no libraries). Template-driven briefing engine (pure function, no LLM). Worker-side OG image generation (Satori + resvg-wasm). All data from existing hooks — no new API data endpoints.

**Tech Stack:** React 19, Tailwind CSS v4, CSS custom properties, requestAnimationFrame, Satori, resvg-wasm, Cloudflare Workers

**Design doc:** `agents/plans/2026-03-08-experience-elevation-design.md`

---

## Phase 1: Motion Foundation

Infrastructure-only — no visible changes until Phase 3 wires it to components.

---

### Task 1: Add Motion Tokens

**Files:**
- Modify: `src/styles/tokens/semantic.css` (after line ~129 in `:root` and ~203 in `.dark`)

**Step 1: Add tokens to `:root` block**

Find the existing motion tokens in `:root` (around line 127-129):
```css
--motion-duration-fast: 160ms;
--motion-duration-base: 220ms;
--motion-ease-standard: cubic-bezier(0.22, 1, 0.36, 1);
```

Add immediately after:
```css
--motion-duration-slow: 600ms;
--motion-duration-entrance: 400ms;
--motion-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
--motion-ease-decelerate: cubic-bezier(0.0, 0.0, 0.2, 1);
```

**Step 2: Duplicate in `.dark` block**

Find the same three existing tokens in the `.dark` selector (around line 201-203) and add the same four new tokens after them.

**Step 3: Verify**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add src/styles/tokens/semantic.css
git commit -m "feat(motion): add slow/entrance/spring/decelerate motion tokens"
```

---

### Task 2: Add CSS Keyframes and Utility Classes

**Files:**
- Modify: `src/app/globals.css`

**Step 1: Add keyframes**

Add these keyframes after the existing `@keyframes pharos-pulse` block (around line 292):

```css
/* --- Experience Elevation: motion primitives --- */

@keyframes pharos-fade-in-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pharos-grade-pop {
  0% {
    transform: scale(0);
    opacity: 0;
  }
  60% {
    transform: scale(1.08);
    opacity: 1;
  }
  100% {
    transform: scale(1);
  }
}

@keyframes pharos-slide-in-right {
  from {
    transform: translateX(20px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
```

**Step 2: Add stagger entrance utility class**

Add after the new keyframes, near the other `.pharos-*` utility classes (around line 201-225):

```css
.pharos-stagger-entrance > * {
  animation: pharos-fade-in-up var(--motion-duration-entrance) var(--motion-ease-standard) both;
  animation-delay: calc(var(--stagger-index, 0) * 60ms);
}
```

**Step 3: Verify**

Run: `npm run build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(motion): add fade-in-up, grade-pop, slide-in-right keyframes and stagger utility"
```

---

### Task 3: Create `useCountUp` Hook

**Files:**
- Create: `src/hooks/use-count-up.ts`
- Create: `src/hooks/__tests__/use-count-up.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/hooks/__tests__/use-count-up.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useCountUp } from "../use-count-up";

// Mock matchMedia for reduced-motion tests
function mockReducedMotion(prefers: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? prefers : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe("useCountUp", () => {
  beforeEach(() => {
    mockReducedMotion(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the target value after animation completes", () => {
    const { result } = renderHook(() => useCountUp(100));
    // Fast-forward past animation duration
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("100");
  });

  it("returns formatted value with prefix and suffix", () => {
    const { result } = renderHook(() =>
      useCountUp(42.5, { prefix: "$", suffix: "B", decimals: 1 }),
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("$42.5B");
  });

  it("returns final value immediately when reduced motion is preferred", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useCountUp(100));
    // No timer advance needed — should be immediate
    expect(result.current).toBe("100");
  });

  it("starts at 0 initially", () => {
    const { result } = renderHook(() => useCountUp(100));
    expect(result.current).toBe("0");
  });

  it("handles zero target", () => {
    const { result } = renderHook(() => useCountUp(0));
    expect(result.current).toBe("0");
  });

  it("handles negative target", () => {
    const { result } = renderHook(() =>
      useCountUp(-50, { prefix: "", decimals: 0 }),
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("-50");
  });

  it("animates from previous to new target on value change", () => {
    const { result, rerender } = renderHook(
      ({ target }) => useCountUp(target),
      { initialProps: { target: 100 } },
    );
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("100");

    rerender({ target: 200 });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe("200");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/hooks/__tests__/use-count-up.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the hook**

```typescript
// src/hooks/use-count-up.ts
"use client";

import { useEffect, useRef, useState } from "react";

interface CountUpOptions {
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}

// Decelerate easing: fast start, smooth landing
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function formatNumber(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useCountUp(target: number, opts?: CountUpOptions): string {
  const {
    duration = 600,
    decimals = Number.isInteger(target) ? 0 : 1,
    prefix = "",
    suffix = "",
  } = opts ?? {};

  const [display, setDisplay] = useState(() =>
    prefersReducedMotion() ? target : 0,
  );
  const fromRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(target);
      return;
    }

    const from = fromRef.current;
    const delta = target - from;
    if (delta === 0) return;

    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const current = from + delta * eased;

      setDisplay(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = display;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return `${prefix}${formatNumber(display, decimals)}${suffix}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/hooks/__tests__/use-count-up.test.ts`
Expected: All 7 tests PASS.

Note: The fake timer tests with rAF can be tricky. If tests fail due to rAF not advancing with fake timers, add `vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(performance.now() + 700); return 0; })` in the relevant tests, or use `vi.advanceTimersToNextTimer()` in a loop.

**Step 5: Commit**

```bash
git add src/hooks/use-count-up.ts src/hooks/__tests__/use-count-up.test.ts
git commit -m "feat(motion): add useCountUp hook with tests"
```

---

### Task 4: Create `useEntranceSequence` Hook

**Files:**
- Create: `src/hooks/use-entrance-sequence.ts`
- Create: `src/hooks/__tests__/use-entrance-sequence.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/hooks/__tests__/use-entrance-sequence.test.ts
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEntranceSequence } from "../use-entrance-sequence";

function mockReducedMotion(prefers: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? prefers : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe("useEntranceSequence", () => {
  beforeEach(() => {
    mockReducedMotion(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in briefing phase", () => {
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.phase).toBe("briefing");
  });

  it("advances to kpi phase after 400ms", () => {
    const { result } = renderHook(() => useEntranceSequence());
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.phase).toBe("kpi");
  });

  it("advances to complete after 800ms", () => {
    const { result } = renderHook(() => useEntranceSequence());
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.phase).toBe("complete");
  });

  it("returns correct delay offsets for briefing group", () => {
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.delayFor("briefing", 0)).toBe(0);
    expect(result.current.delayFor("briefing", 1)).toBe(60);
    expect(result.current.delayFor("briefing", 2)).toBe(120);
  });

  it("returns correct delay offsets for kpi group", () => {
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.delayFor("kpi", 0)).toBe(400);
    expect(result.current.delayFor("kpi", 1)).toBe(480);
  });

  it("returns 0 delays when reduced motion is preferred", () => {
    mockReducedMotion(true);
    const { result } = renderHook(() => useEntranceSequence());
    expect(result.current.phase).toBe("complete");
    expect(result.current.delayFor("briefing", 0)).toBe(0);
    expect(result.current.delayFor("kpi", 3)).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/hooks/__tests__/use-entrance-sequence.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the hook**

```typescript
// src/hooks/use-entrance-sequence.ts
"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Phase = "briefing" | "kpi" | "complete";

interface EntranceSequence {
  phase: Phase;
  delayFor: (group: string, index: number) => number;
}

const PHASE_TIMINGS: Record<Phase, number> = {
  briefing: 0,
  kpi: 400,
  complete: 800,
};

const GROUP_OFFSETS: Record<string, { base: number; stagger: number }> = {
  briefing: { base: 0, stagger: 60 },
  "briefing-lines": { base: 150, stagger: 60 },
  kpi: { base: 400, stagger: 80 },
  cards: { base: 400, stagger: 60 },
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useEntranceSequence(): EntranceSequence {
  const reduced = useRef(prefersReducedMotion());
  const [phase, setPhase] = useState<Phase>(
    reduced.current ? "complete" : "briefing",
  );

  useEffect(() => {
    if (reduced.current) return;

    const timers = [
      setTimeout(() => setPhase("kpi"), PHASE_TIMINGS.kpi),
      setTimeout(() => setPhase("complete"), PHASE_TIMINGS.complete),
    ];

    return () => timers.forEach(clearTimeout);
  }, []);

  const delayFor = useCallback(
    (group: string, index: number): number => {
      if (reduced.current) return 0;
      const config = GROUP_OFFSETS[group];
      if (!config) return 0;
      const cappedIndex = Math.min(index, 8);
      return config.base + cappedIndex * config.stagger;
    },
    [],
  );

  return { phase, delayFor };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/hooks/__tests__/use-entrance-sequence.test.ts`
Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add src/hooks/use-entrance-sequence.ts src/hooks/__tests__/use-entrance-sequence.test.ts
git commit -m "feat(motion): add useEntranceSequence choreography hook with tests"
```

---

## Phase 2: Narrative Intelligence Briefing

---

### Task 5: Create `buildBriefing` Pure Function

**Files:**
- Create: `src/lib/build-briefing.ts`
- Create: `src/lib/__tests__/build-briefing.test.ts`

**Context:** Check these files for return type shapes before writing:
- `src/hooks/use-stability-index.ts` — `StabilityIndexResponse` type
- `src/hooks/use-peg-summary.ts` — `PegSummaryResponse` type
- `src/hooks/use-stress-signals.ts` — `StressSignalsAllResponse` type
- `src/hooks/use-mint-burn-flows.ts` — `MintBurnFlowsResponse` type
- `src/hooks/use-report-cards.ts` — `ReportCardsResponse` type

Also check `shared/lib/psi-colors.ts` for PSI band names/thresholds.

The function takes simplified input types (not full hook responses) so it stays decoupled from API shapes.

**Step 1: Write the failing tests**

```typescript
// src/lib/__tests__/build-briefing.test.ts
import { describe, it, expect } from "vitest";
import { buildBriefing, type BriefingInput } from "../build-briefing";

const CALM_INPUT: BriefingInput = {
  psi: { score: 82, band: "STEADY", delta24h: 3, delta7d: 5, daysInBand: 14 },
  depegs: { activeCount: 0, activeCoins: [], lastClosedCoin: "TUSD", lastClosedDaysAgo: 6, lastClosedBps: 47 },
  dews: { dangerCount: 0, alertCount: 0, warningCount: 2, topStressed: [] },
  flows: { net24hUsd: 340_000_000, direction: "minting" as const, isStrongestIn7d: true, ftqTriggered: false, bankRunElevated: false },
};

const STRESSED_INPUT: BriefingInput = {
  psi: { score: 55, band: "FRACTURE", delta24h: -8, delta7d: -15, daysInBand: 2 },
  depegs: { activeCount: 2, activeCoins: [{ symbol: "TUSD", bps: 120 }, { symbol: "FDUSD", bps: 85 }], lastClosedCoin: null, lastClosedDaysAgo: null, lastClosedBps: null },
  dews: { dangerCount: 1, alertCount: 2, warningCount: 3, topStressed: [{ symbol: "TUSD", band: "DANGER" }] },
  flows: { net24hUsd: -520_000_000, direction: "burning" as const, isStrongestIn7d: true, ftqTriggered: true, bankRunElevated: false },
};

describe("buildBriefing", () => {
  it("produces 3 lines in calm market", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.lines.length).toBeGreaterThanOrEqual(3);
    expect(result.lines.length).toBeLessThanOrEqual(4);
  });

  it("includes PSI band and score in headline", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.headline).toContain("STEADY");
    expect(result.headline).toContain("82");
  });

  it("includes temporal context in headline", () => {
    const result = buildBriefing(CALM_INPUT);
    expect(result.headline).toContain("day 14");
  });

  it("uses 'over a month' for daysInBand > 30", () => {
    const input = { ...CALM_INPUT, psi: { ...CALM_INPUT.psi, daysInBand: 45 } };
    const result = buildBriefing(input);
    expect(result.headline).toContain("over a month");
    expect(result.headline).not.toContain("day 45");
  });

  it("mentions last closed depeg when no active depegs", () => {
    const result = buildBriefing(CALM_INPUT);
    const depegLine = result.lines.find((l) => l.type === "depegs");
    expect(depegLine?.text).toContain("TUSD");
    expect(depegLine?.text).toContain("6 days ago");
  });

  it("collapses depegs + stress into one line when all calm", () => {
    const allCalm = {
      ...CALM_INPUT,
      depegs: { ...CALM_INPUT.depegs, lastClosedCoin: null, lastClosedDaysAgo: null, lastClosedBps: null },
      dews: { dangerCount: 0, alertCount: 0, warningCount: 0, topStressed: [] },
    };
    const result = buildBriefing(allCalm);
    const collapsed = result.lines.find((l) => l.type === "calm-summary");
    expect(collapsed).toBeDefined();
  });

  it("produces 5 lines in stressed market", () => {
    const result = buildBriefing(STRESSED_INPUT);
    expect(result.lines.length).toBeGreaterThanOrEqual(4);
    expect(result.lines.length).toBeLessThanOrEqual(5);
  });

  it("lists active depeg coins in stressed market", () => {
    const result = buildBriefing(STRESSED_INPUT);
    const depegLine = result.lines.find((l) => l.type === "depegs");
    expect(depegLine?.text).toContain("TUSD");
    expect(depegLine?.text).toContain("FDUSD");
  });

  it("includes FTQ line when triggered", () => {
    const result = buildBriefing(STRESSED_INPUT);
    const ftqLine = result.lines.find((l) => l.type === "extra");
    expect(ftqLine?.text).toContain("Flight-to-quality");
  });

  it("includes flow comparative anchor", () => {
    const result = buildBriefing(CALM_INPUT);
    const flowLine = result.lines.find((l) => l.type === "flows");
    expect(flowLine?.text).toContain("strongest");
  });

  it("sets tone based on PSI band", () => {
    expect(buildBriefing(CALM_INPUT).tone).toBe("calm");
    expect(buildBriefing(STRESSED_INPUT).tone).toBe("alert");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/__tests__/build-briefing.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the function**

```typescript
// src/lib/build-briefing.ts

export interface BriefingPsiInput {
  score: number;
  band: string;
  delta24h: number;
  delta7d: number;
  daysInBand: number;
}

export interface BriefingDepegInput {
  activeCount: number;
  activeCoins: Array<{ symbol: string; bps: number }>;
  lastClosedCoin: string | null;
  lastClosedDaysAgo: number | null;
  lastClosedBps: number | null;
}

export interface BriefingDewsInput {
  dangerCount: number;
  alertCount: number;
  warningCount: number;
  topStressed: Array<{ symbol: string; band: string }>;
}

export interface BriefingFlowsInput {
  net24hUsd: number;
  direction: "minting" | "burning" | "neutral";
  isStrongestIn7d: boolean;
  ftqTriggered: boolean;
  bankRunElevated: boolean;
}

export interface BriefingInput {
  psi: BriefingPsiInput;
  depegs: BriefingDepegInput;
  dews: BriefingDewsInput;
  flows: BriefingFlowsInput;
}

export type BriefingTone =
  | "confident"
  | "calm"
  | "watchful"
  | "alert"
  | "urgent"
  | "emergency";

export interface BriefingLine {
  type: "depegs" | "stress" | "flows" | "calm-summary" | "extra";
  text: string;
}

export interface BriefingOutput {
  headline: string;
  bandKeyword: string;
  tone: BriefingTone;
  lines: BriefingLine[];
}

const BAND_HEADLINES: Record<string, string> = {
  BEDROCK: "The stablecoin ecosystem is rock-solid",
  STEADY: "The stablecoin ecosystem is steady",
  TREMOR: "The stablecoin ecosystem shows minor stress",
  FRACTURE: "The stablecoin ecosystem is under pressure",
  CRISIS: "Multiple stablecoins are in distress",
  MELTDOWN: "Systemic stress across the stablecoin market",
};

const BAND_TONES: Record<string, BriefingTone> = {
  BEDROCK: "confident",
  STEADY: "calm",
  TREMOR: "watchful",
  FRACTURE: "alert",
  CRISIS: "urgent",
  MELTDOWN: "emergency",
};

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  return `$${abs.toLocaleString("en-US")}`;
}

function durationText(days: number): string {
  if (days > 30) return "for over a month";
  if (days === 1) return "since yesterday";
  return `day ${days} of the current run`;
}

function deltaText(score: number, delta24h: number, delta7d: number): string {
  const parts: string[] = [];
  if (delta24h > 0) parts.push(`up ${delta24h} since yesterday`);
  else if (delta24h < 0) parts.push(`down ${Math.abs(delta24h)} since yesterday`);

  if (delta7d !== 0 && score === Math.max(score, score - delta7d))
    parts.push("highest this week");
  else if (delta7d !== 0 && score === Math.min(score, score - delta7d))
    parts.push("lowest this week");

  return parts.length > 0 ? parts.join(", ") : "";
}

export function buildBriefing(input: BriefingInput): BriefingOutput {
  const { psi, depegs, dews, flows } = input;

  const bandBase = BAND_HEADLINES[psi.band] ?? "The stablecoin ecosystem status is unknown";
  const duration = durationText(psi.daysInBand);
  const delta = deltaText(psi.score, psi.delta24h, psi.delta7d);
  const scorePart = `PSI ${psi.score}`;
  const headline = [
    `${bandBase} \u2014 ${duration}.`,
    delta ? `${scorePart}, ${delta}.` : `${scorePart}.`,
  ].join(" ");

  const tone = BAND_TONES[psi.band] ?? "calm";
  const lines: BriefingLine[] = [];

  // Depegs + stress: collapse if all calm
  const allCalm =
    depegs.activeCount === 0 &&
    dews.dangerCount === 0 &&
    dews.alertCount === 0 &&
    dews.warningCount === 0 &&
    !depegs.lastClosedCoin;

  if (allCalm) {
    lines.push({ type: "calm-summary", text: "All pegs stable, no stress signals." });
  } else {
    // Depeg line
    if (depegs.activeCount > 0) {
      const coins = depegs.activeCoins.map((c) => c.symbol).join(", ");
      lines.push({
        type: "depegs",
        text: `${depegs.activeCount} coin${depegs.activeCount > 1 ? "s" : ""} depegged: ${coins}.`,
      });
    } else if (depegs.lastClosedCoin) {
      lines.push({
        type: "depegs",
        text: `No active depegs. Last event ended ${depegs.lastClosedDaysAgo} days ago (${depegs.lastClosedCoin}, ${depegs.lastClosedBps} bps).`,
      });
    }

    // Stress line
    if (dews.dangerCount > 0) {
      const top = dews.topStressed.map((s) => s.symbol).join(", ");
      lines.push({
        type: "stress",
        text: `DEWS signals: ${dews.dangerCount} in DANGER${top ? ` (${top})` : ""}, ${dews.alertCount} ALERT, ${dews.warningCount} WARNING.`,
      });
    } else if (dews.alertCount > 0 || dews.warningCount > 0) {
      lines.push({
        type: "stress",
        text: `DEWS signals show elevated stress on ${dews.alertCount + dews.warningCount} coin${dews.alertCount + dews.warningCount > 1 ? "s" : ""}.`,
      });
    }
  }

  // Flows line
  const flowAmount = formatUsd(flows.net24hUsd);
  const flowDir = flows.direction === "minting" ? "Net minting" : flows.direction === "burning" ? "Net burning" : "Balanced flows";
  const anchor = flows.isStrongestIn7d
    ? ` \u2014 the strongest ${flows.direction} day in 7 days`
    : "";
  lines.push({ type: "flows", text: `${flowDir} of ${flowAmount} in 24h${anchor}.` });

  // Extra line (optional)
  if (flows.ftqTriggered) {
    lines.push({
      type: "extra",
      text: "Flight-to-quality in progress \u2014 capital rotating between stablecoins.",
    });
  } else if (flows.bankRunElevated) {
    lines.push({
      type: "extra",
      text: "Bank run gauge elevated \u2014 aggregate redemption pressure above baseline.",
    });
  }

  return { headline, bandKeyword: psi.band, tone, lines };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/__tests__/build-briefing.test.ts`
Expected: All 11 tests PASS. Adjust test expectations to match exact output strings if needed.

**Step 5: Commit**

```bash
git add src/lib/build-briefing.ts src/lib/__tests__/build-briefing.test.ts
git commit -m "feat(briefing): add buildBriefing template engine with tests"
```

---

### Task 6: Create Intelligence Briefing Component

**Files:**
- Create: `src/components/intelligence-briefing.tsx`

**Context:** Read these files before implementing:
- `src/hooks/use-stability-index.ts` — for exact return shape and how to extract PSI fields
- `src/hooks/use-peg-summary.ts` — for how to derive active depegs and last closed event
- `src/hooks/use-stress-signals.ts` — for how to count bands
- `src/hooks/use-mint-burn-flows.ts` — for net flow and FTQ fields
- `src/components/kpi-bar.tsx` — for how these hooks are already called (patterns to reuse)
- `shared/lib/psi-colors.ts` — for PSI band color mapping

**Step 1: Implement the component**

The component should:
1. Call the 4 existing hooks (stability, peg-summary, stress-signals, mint-burn-flows)
2. Transform hook responses into `BriefingInput` shape
3. Call `buildBriefing()`
4. Render headline + lines with appropriate styling
5. Show 3-line skeleton during loading
6. Hide entirely if all hooks error

Key implementation notes:
- Use the same hooks already called by `homepage-client.tsx` and `kpi-bar.tsx`. TanStack Query deduplicates — no extra network requests.
- Map PSI band to background color using the existing semantic tokens (check `shared/lib/psi-colors.ts` for the band-to-color map).
- The `bandKeyword` in the headline should be wrapped in `<strong>` with the band's semantic color class.
- Numbers in supporting lines use `font-mono` for consistency with Pharos design language.
- Add `transition: background-color var(--motion-duration-base) var(--motion-ease-standard)` for smooth band-change morphing.

**Step 2: Verify**

Run: `npm run build`
Expected: Clean build, component compiles without errors.

**Step 3: Commit**

```bash
git add src/components/intelligence-briefing.tsx
git commit -m "feat(briefing): add IntelligenceBriefing component"
```

---

### Task 7: Integrate Briefing into Homepage

**Files:**
- Modify: `src/app/page.tsx` (insert between SiteHeader/KpiBar and HomepageClient)

**Context:** Read `src/app/page.tsx` first. The component is a server component that renders `SiteHeader`, `KpiBar`, then `HomepageClient`. We need to add `IntelligenceBriefing` (a client component) between the `<div className="space-y-3">` block and `<HomepageClient>`.

**Step 1: Add import and render**

Add the import at the top:
```typescript
import { IntelligenceBriefing } from "@/components/intelligence-briefing";
```

Insert `<IntelligenceBriefing />` after the `<div className="space-y-3">` block containing SiteHeader + KpiBar, before `<HomepageClient>`.

**Step 2: Verify**

Run: `npm run build`
Expected: Clean build.

Run: `npm run dev` and visually verify the briefing appears on the homepage between the header area and the main content.

**Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(briefing): integrate IntelligenceBriefing into homepage"
```

---

## Phase 3: Motion Integration

Apply motion primitives to existing components.

---

### Task 8: Apply `useCountUp` to KPI Bar

**Files:**
- Modify: `src/components/kpi-bar.tsx`

**Context:** Read `kpi-bar.tsx` first. Numeric values are rendered around lines 311 (PSI), 321 (mcap), 323 (changes). The `metricDefinitions` array (line ~454) maps values to display. We need to wrap key numeric values with `useCountUp`.

**Step 1: Apply count-up to PSI score**

Find where `psiScoreNum.toFixed(1)` is rendered and replace with `useCountUp(psiScoreNum, { decimals: 1 })`.

**Step 2: Apply count-up to total market cap**

Find `formatCurrency(totalMcap, 1)` and wrap with the count-up hook. Since `formatCurrency` does its own formatting, you may need to use `useCountUp` on the raw number and format the output, or call `useCountUp` with appropriate prefix/suffix.

Alternatively, apply count-up only to the most prominent values (PSI score and total mcap) to avoid over-animation. Use your judgment — if a value already updates rarely, count-up is most impactful there.

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — verify PSI score and mcap animate on page load.

**Step 4: Commit**

```bash
git add src/components/kpi-bar.tsx
git commit -m "feat(motion): apply useCountUp to KpiBar PSI and mcap values"
```

---

### Task 9: Apply Stagger Entrance to Card Grids

**Files:**
- Modify: `src/components/feature-highlights.tsx` (line ~129, the `.map()` grid)
- Modify: `src/components/market-highlights.tsx` (line ~243 depegs grid, line ~260 movers grid)

**Step 1: Feature highlights**

Add `pharos-stagger-entrance` class to the grid container. On each child in the `.map()`, add `style={{ '--stagger-index': i } as React.CSSProperties}`.

**Step 2: Market highlights**

Same pattern on the depegs and movers grids.

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — verify cards cascade in with staggered fade-up.

**Step 4: Commit**

```bash
git add src/components/feature-highlights.tsx src/components/market-highlights.tsx
git commit -m "feat(motion): apply stagger entrance to feature and market highlight cards"
```

---

### Task 10: Enable Chart Draw-In

**Files:**
- Modify: Chart components on the homepage. Check these files:
  - The PSI history chart component (find via `src/components/` or dynamically imported in `homepage-client.tsx`)
  - The total mcap chart component
  - The safety overview stacked bar
  - The peg diversity chart

**Context:** Currently all charts use `isAnimationActive={false}`. We selectively enable animation on the homepage charts with a `hasAnimated` ref guard.

**Step 1: Create shared animation config**

Add to `src/lib/chart-colors.ts` (or a new `src/lib/chart-animation.ts` if the file is too large):

```typescript
export const CHART_DRAW_IN = {
  isAnimationActive: true,
  animationDuration: 800,
  animationEasing: "ease-out" as const,
} as const;
```

**Step 2: Apply to target charts**

For each chart, replace `isAnimationActive={false}` with `{...CHART_DRAW_IN}` on the `<Area>`, `<Bar>`, or `<Line>` Recharts component. Add a `useRef(false)` guard so animation only fires on first render:

```typescript
const hasAnimated = useRef(false);
const animProps = hasAnimated.current ? { isAnimationActive: false } : CHART_DRAW_IN;
useEffect(() => { hasAnimated.current = true; }, []);
```

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — verify charts draw in on first visit, no re-animation on data refresh.

**Step 4: Commit**

```bash
git add src/lib/chart-animation.ts [modified chart files]
git commit -m "feat(motion): enable chart draw-in animation on homepage charts"
```

---

### Task 11: Add Grade Badge Pop

**Files:**
- Modify: `src/app/safety-scores/client.tsx` (around line 61-86, the LazyCard pattern)
- Modify: The grade badge component (find where grade letters like "A+", "B" are rendered as badges)

**Step 1: Extend LazyCard with pop animation**

When `visible` becomes true, the grade badge child should receive the `pharos-grade-pop` animation class:

```css
.pharos-grade-pop {
  animation: pharos-grade-pop 400ms var(--motion-ease-spring) both;
}
```

Add this utility class to `globals.css` alongside the keyframe from Task 2.

**Step 2: Apply to grade badges**

Find where grade badges are rendered in the safety-scores page and wrap them to receive the pop class when their container enters the viewport.

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — scroll the safety scores page and verify grade badges pop in.

**Step 4: Commit**

```bash
git add src/app/globals.css src/app/safety-scores/client.tsx [badge component if modified]
git commit -m "feat(motion): add grade badge pop animation on safety-scores page"
```

---

### Task 12: Add Depeg Feed Slide-In

**Files:**
- Modify: `src/components/depeg-feed.tsx` (around line 60-110, the event list `.map()`)

**Step 1: Track previously seen event IDs**

Add a `useRef<Set<string>>()` to track which event IDs have been rendered before. New events (not in the set) get the `pharos-slide-in-right` animation class. Existing events render without animation.

```typescript
const seenIds = useRef(new Set<string>());
// In the render:
const isNew = !seenIds.current.has(evt.id);
if (!isNew) { /* no animation */ }
// After render, add to set:
useEffect(() => { visible.forEach(e => seenIds.current.add(e.id)); }, [visible]);
```

**Step 2: Apply animation class**

On new events, add:
```
className="..." style={{ animation: 'pharos-slide-in-right 300ms var(--motion-ease-standard) both' }}
```

Stagger: first new item gets 0ms delay, second gets 100ms, third gets 200ms. Cap at 3.

**Step 3: Verify**

Run: `npm run build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/components/depeg-feed.tsx
git commit -m "feat(motion): add slide-in animation for new depeg feed events"
```

---

### Task 13: Wire Entrance Choreography on Homepage

**Files:**
- Modify: `src/components/intelligence-briefing.tsx` — accept delay offsets
- Modify: `src/components/kpi-bar.tsx` — accept delay offsets for count-up start
- Modify: `src/app/page.tsx` or `src/components/homepage-client.tsx` — provide entrance context

**Context:** The `useEntranceSequence` hook should be called at the homepage level and passed down via props (not context — keep it simple).

**Step 1: Call `useEntranceSequence` in the homepage client**

Add to `homepage-client.tsx`:
```typescript
const entrance = useEntranceSequence();
```

Pass `entrance.delayFor` to IntelligenceBriefing and KpiBar as props.

**Step 2: Apply delays in IntelligenceBriefing**

The headline gets `animation-delay: delayFor('briefing', 0)`. Each supporting line gets `delayFor('briefing-lines', i)`.

**Step 3: Apply delays in KpiBar**

Each KPI cell gets `animation-delay: delayFor('kpi', i)` on its count-up start. The `useCountUp` hook already starts from 0, so delaying the mount of the count-up or adding a CSS animation-delay on the container works.

**Step 4: Verify**

Run: `npm run build`
Run: `npm run dev` — verify the homepage reveals in sequence: briefing headline -> lines -> KPI numbers.

**Step 5: Commit**

```bash
git add src/components/intelligence-briefing.tsx src/components/kpi-bar.tsx src/components/homepage-client.tsx
git commit -m "feat(motion): wire entrance choreography across homepage components"
```

---

### Task 14: Add Contagion Ripple to Dependency Map

**Files:**
- Modify: The dependency map component (find in `src/app/dependency-map/`)

**Context:** This task depends on how the dependency graph is rendered (likely SVG with `<line>` or `<path>` elements). Read the component first.

**Step 1: Add CSS transitions to edges and nodes**

```css
.dep-edge {
  transition: stroke-dashoffset 300ms var(--motion-ease-standard),
              stroke-opacity 200ms;
  stroke-dasharray: var(--edge-length);
  stroke-dashoffset: 0;
}

.dep-edge.ripple-active {
  stroke-dashoffset: 0;
  stroke-opacity: 1;
}

.dep-node {
  transition: transform 200ms var(--motion-ease-standard);
}

.dep-node.ripple-active {
  transform: scale(1.05);
}
```

**Step 2: Add hover handler**

On node hover, find connected edges via the graph data, add `.ripple-active` class with staggered `transition-delay` based on graph distance (100ms per hop). On mouse-leave, remove the class.

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — hover over dependency map nodes, verify ripple effect.

**Step 4: Commit**

```bash
git add src/app/dependency-map/ src/app/globals.css
git commit -m "feat(motion): add contagion ripple effect to dependency map"
```

---

## Phase 4: OG Image Infrastructure

Worker-side Satori + resvg-wasm image generation.

---

### Task 15: Install Dependencies and Set Up Fonts

**Files:**
- Modify: `worker/package.json`
- Create: `worker/src/lib/og-fonts.ts`
- Create: `worker/assets/fonts/` directory with Geist font files

**Step 1: Install Satori and resvg-wasm**

```bash
cd worker
npm install satori @resvg/resvg-wasm
```

**Step 2: Copy Geist font files**

The Geist fonts are installed as npm packages in the root project (`next/font/google` downloads them). Find the font files:
```bash
find node_modules -name "*.ttf" | grep -i geist
```

Copy Regular and Bold weights for Geist Sans and Regular for Geist Mono into `worker/assets/fonts/`.

If fonts aren't available locally, download from the Geist GitHub releases.

**Step 3: Create font loader**

```typescript
// worker/src/lib/og-fonts.ts
import geistSansRegular from "../../assets/fonts/GeistSans-Regular.ttf";
import geistSansBold from "../../assets/fonts/GeistSans-Bold.ttf";
import geistMonoRegular from "../../assets/fonts/GeistMono-Regular.ttf";

export const OG_FONTS = [
  { name: "Geist Sans", data: geistSansRegular, weight: 400 as const, style: "normal" as const },
  { name: "Geist Sans", data: geistSansBold, weight: 700 as const, style: "normal" as const },
  { name: "Geist Mono", data: geistMonoRegular, weight: 400 as const, style: "normal" as const },
];
```

Note: Wrangler may need `rules` in `wrangler.toml` to handle `.ttf` imports as ArrayBuffer. Check Satori docs for Cloudflare Workers examples. You may need to use `fs.readFileSync` at build time or configure wrangler rules:

```toml
# In wrangler.toml
[[rules]]
type = "Data"
globs = ["**/*.ttf"]
```

**Step 4: Verify Worker builds**

```bash
cd worker && npx tsc --noEmit
```

Expected: No type errors. If `.ttf` imports fail, add a `worker/src/types/assets.d.ts`:
```typescript
declare module "*.ttf" {
  const content: ArrayBuffer;
  export default content;
}
```

**Step 5: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/assets/fonts/ worker/src/lib/og-fonts.ts worker/wrangler.toml
git commit -m "feat(og): install satori + resvg-wasm, add Geist font loading"
```

---

### Task 16: Create Shared Card Frame Template

**Files:**
- Create: `worker/src/lib/og-templates/shared.tsx`

**Context:** Satori uses JSX (React-like) syntax to describe the layout, then converts to SVG. All styles must use the inline `style={{}}` prop — no CSS classes. Check Satori's supported CSS properties: https://github.com/vercel/satori#css

**Step 1: Implement the shared card frame**

```tsx
// worker/src/lib/og-templates/shared.tsx
import type { ReactNode } from "react";

const BG = "#0a0f1e";
const TEXT_PRIMARY = "#e8e8e8";
const TEXT_SECONDARY = "#8b8fa3";
const FROST_BLUE = "#5ba3d9";
const BORDER = "#1e293b";

export interface CardFrameProps {
  title: string;
  subtitle?: string;
  borderTopColor?: string;
  badge?: { text: string; color: string };
  children: ReactNode;
}

export function CardFrame({ title, subtitle, borderTopColor, badge, children }: CardFrameProps) {
  return (
    <div
      style={{
        width: 1200,
        height: 628,
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        color: TEXT_PRIMARY,
        fontFamily: "Geist Sans",
        padding: "48px 56px",
        borderTop: borderTopColor ? `4px solid ${borderTopColor}` : "none",
        position: "relative",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 20, fontWeight: 700, color: FROST_BLUE, letterSpacing: "0.08em" }}>
            PHAROS
          </span>
          {subtitle && (
            <span style={{ fontSize: 16, color: TEXT_SECONDARY }}>{subtitle}</span>
          )}
        </div>
        <span style={{ fontSize: 14, color: TEXT_SECONDARY }}>pharos.watch</span>
      </div>

      {/* Badge */}
      {badge && (
        <div
          style={{
            position: "absolute",
            top: 48,
            right: 56,
            padding: "4px 12px",
            borderRadius: 4,
            backgroundColor: badge.color,
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          {badge.text}
        </div>
      )}

      {/* Title */}
      <div style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>{title}</div>

      {/* Content */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

// Sparkline SVG path from price data
export function Sparkline({ data, color = FROST_BLUE }: { data: number[]; color?: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 1080;
  const h = 60;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - ((v - min) / range) * h}`);
  const d = `M ${points.join(" L ")}`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ marginTop: 16 }}>
      <path d={d} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

export { BG, TEXT_PRIMARY, TEXT_SECONDARY, FROST_BLUE, BORDER };
```

**Step 2: Verify**

```bash
cd worker && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add worker/src/lib/og-templates/shared.tsx
git commit -m "feat(og): add shared CardFrame and Sparkline templates"
```

---

### Task 17: Create Stablecoin Card Template with State-Adaptive Treatment

**Files:**
- Create: `worker/src/lib/og-templates/stablecoin-card.tsx`

**Context:** This template receives coin data and renders the per-coin OG card. It includes state-adaptive treatment: border-top color and badge vary based on DEWS band and depeg status.

Check `shared/lib/classification.ts` for grade-to-color mapping. Check `shared/lib/psi-colors.ts` for PSI band colors.

**Step 1: Implement the template**

The template should:
1. Import `CardFrame` and `Sparkline` from `shared.tsx`
2. Accept a `StablecoinCardData` interface with: name, symbol, grade, pegPrice, dewsBand, liquidityScore, psiScore, psiBand, mcap, vol24h, flow7d, sparklineData, hasActiveDepeg, deviationPct
3. Determine state-adaptive treatment:
   - `hasActiveDepeg` → red border, "DEPEGGED" badge
   - `dewsBand === 'DANGER'` → red border, "DANGER" badge
   - `dewsBand === 'ALERT' || dewsBand === 'WARNING'` → amber border, "ELEVATED STRESS" badge
   - else → no border, no badge
4. Render metrics row (grade, peg, DEWS, liquidity, PSI) in monospace
5. Render secondary row (mcap, vol, flow)
6. Render sparkline

**Step 2: Verify type-check**

```bash
cd worker && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add worker/src/lib/og-templates/stablecoin-card.tsx
git commit -m "feat(og): add stablecoin OG card template with state-adaptive treatment"
```

---

### Task 18: Create Aggregate Card Templates

**Files:**
- Create: `worker/src/lib/og-templates/safety-scores-card.tsx`
- Create: `worker/src/lib/og-templates/depeg-card.tsx`
- Create: `worker/src/lib/og-templates/stability-index-card.tsx`

**Step 1: Implement safety-scores card**

Shows: grade distribution counts, market safety pulse grade/score, coverage ratio. Uses `CardFrame` from shared.

**Step 2: Implement depeg card**

Shows: active depeg count, PSI score + band, coins at peg ratio, DEWS band distribution.

**Step 3: Implement stability-index card**

Shows: PSI score + band + 24h delta, mini area sparkline of 7-day PSI history, 6 condition band labels.

**Step 4: Verify type-check**

```bash
cd worker && npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add worker/src/lib/og-templates/
git commit -m "feat(og): add aggregate OG card templates (safety, depeg, PSI)"
```

---

### Task 19: Create OG Route Handler

**Files:**
- Create: `worker/src/api/og.ts`
- Modify: Worker router file (find the main router in `worker/src/` that dispatches to API handlers)

**Context:** Read the existing router pattern — how other endpoints like `stability-index.ts` are registered. Follow the same pattern.

**Step 1: Implement the OG handler**

```typescript
// worker/src/api/og.ts
import satori from "satori";
import { Resvg } from "@resvg/resvg-wasm";
import { OG_FONTS } from "../lib/og-fonts";
// import card templates...

// Initialize resvg-wasm once
let wasmInitialized = false;

export async function handleOgRequest(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  // Initialize WASM on first call
  if (!wasmInitialized) {
    // @resvg/resvg-wasm needs initialization
    // Follow the library's Cloudflare Workers setup guide
    wasmInitialized = true;
  }

  // Route: /api/og/stablecoin/:id
  // Route: /api/og/safety-scores
  // Route: /api/og/depeg
  // Route: /api/og/stability-index

  // 1. Parse route, extract ID if present
  // 2. Query D1 for required data (reuse existing query helpers)
  // 3. Build JSX template
  // 4. Render with Satori → SVG
  const svg = await satori(jsxTemplate, {
    width: 1200,
    height: 628,
    fonts: OG_FONTS,
  });

  // 5. Convert SVG → PNG with resvg
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  const png = resvg.render().asPng();

  // 6. Return with cache headers
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=900, s-maxage=900",
    },
  });
}
```

**Step 2: Register in router**

Add the OG route to the main Worker router. Match paths starting with `/api/og/` and dispatch to `handleOgRequest`.

**Step 3: Verify locally**

```bash
cd worker && npx wrangler dev
```

Test with: `curl http://localhost:8787/api/og/stablecoin/usdc-circle -o test.png`
Open `test.png` and verify it renders a valid card.

**Step 4: Commit**

```bash
git add worker/src/api/og.ts [router file]
git commit -m "feat(og): add OG image generation endpoint with Satori + resvg-wasm"
```

---

### Task 20: Verify Worker Bundle Size

**Step 1: Build the worker**

```bash
cd worker && npx wrangler deploy --dry-run
```

Check the output for bundle size. Must be under 10MB for Cloudflare paid plan.

**Step 2: If over budget**

Options:
- Remove one font weight (e.g., drop Geist Sans Bold, use Regular for everything)
- Compress font files (subset to Latin characters only with `fonttools`)
- Split OG generation into a separate Worker (last resort — documented in design doc)

**Step 3: Commit if changes were needed**

```bash
git add worker/
git commit -m "chore(og): optimize worker bundle size"
```

---

## Phase 5: Frontend Metadata & Share Button

---

### Task 21: Update Frontend OG Metadata

**Files:**
- Modify: `src/app/stablecoin/[id]/page.tsx` (line ~22-35, `generateMetadata`)
- Modify: `src/app/safety-scores/page.tsx` (line ~25-30, metadata export)
- Modify: `src/app/depeg/page.tsx` (line ~20-25, metadata export)
- Modify: `src/app/stability-index/page.tsx` (find metadata export)

**Step 1: Update stablecoin detail pages**

In `generateMetadata()`, change the `buildStablecoinDetailMetadata` call (or the `buildPageMetadata` call within it) to include:
```typescript
ogImage: `https://api.pharos.watch/api/og/stablecoin/${id}`,
```

**Step 2: Update feature pages**

Change `ogImage` from static PNG URLs to Worker endpoints:
```typescript
// safety-scores/page.tsx
ogImage: "https://api.pharos.watch/api/og/safety-scores",

// depeg/page.tsx
ogImage: "https://api.pharos.watch/api/og/depeg",

// stability-index/page.tsx
ogImage: "https://api.pharos.watch/api/og/stability-index",
```

**Step 3: Verify**

Run: `npm run build`
Expected: Clean build. Verify meta tags in the generated HTML contain the new URLs.

**Step 4: Commit**

```bash
git add src/app/stablecoin/ src/app/safety-scores/ src/app/depeg/ src/app/stability-index/
git commit -m "feat(og): point OG metadata to dynamic Worker-generated images"
```

---

### Task 22: Create Share Button Component

**Files:**
- Create: `src/components/share-button.tsx`

**Step 1: Implement the component**

```typescript
// Props: ogPath (e.g., "/api/og/stablecoin/usdc-circle"), label (optional)
// Renders: [Copy Link] [Copy as Image] [Download PNG]
// Uses: navigator.clipboard.write for image, navigator.clipboard.writeText for link
// Fallback: download link if clipboard API unavailable
// Loading state: show spinner while fetching image
// Error state: show toast/notice on failure
```

Key implementation notes:
- Use the existing `Button` component from `src/components/ui/button.tsx`
- Fetch from the Worker's OG endpoint (relative URL, API client handles base URL)
- `navigator.clipboard.write` requires a `ClipboardItem` with `image/png` blob
- Not all browsers support image clipboard — detect and hide the button if unsupported
- The "Copy Link" button copies the current page URL

**Step 2: Verify**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/share-button.tsx
git commit -m "feat(og): add ShareButton component for copy-link and copy-as-image"
```

---

### Task 23: Integrate Share Button

**Files:**
- Modify: `src/app/stablecoin/[id]/` client component (find the detail page client)
- Optionally: `src/app/safety-scores/client.tsx`, `src/app/depeg/client.tsx`

**Step 1: Add to stablecoin detail page**

Place `<ShareButton ogPath={`/api/og/stablecoin/${id}`} />` in the page header area, near the coin name and grade.

**Step 2: Optionally add to feature pages**

Add share buttons to safety-scores and depeg pages if appropriate (top-right of page header).

**Step 3: Verify**

Run: `npm run build`
Run: `npm run dev` — verify share button appears, copy-as-image works with the Worker endpoint.

**Step 4: Commit**

```bash
git add src/app/stablecoin/ src/app/safety-scores/ src/app/depeg/
git commit -m "feat(og): integrate ShareButton into stablecoin detail and feature pages"
```

---

## Phase 6: Verification & Polish

---

### Task 24: Full Build, Type-Check, and Lint

**Step 1: Frontend build**

```bash
npm run build
```

Expected: Clean build, no errors, no warnings.

**Step 2: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: No type errors.

**Step 3: Lint**

```bash
npm run lint
```

Expected: No new lint errors.

**Step 4: Run tests**

```bash
npm test
```

Expected: All tests pass including the new `build-briefing` and `useCountUp` tests.

**Step 5: Visual smoke test**

Run `npm run dev` and check:
- [ ] Homepage loads with intelligence briefing above KpiBar
- [ ] Briefing text is sensible (not "undefined" or empty)
- [ ] Entrance sequence plays: briefing → KPI numbers → below-fold content
- [ ] KPI numbers count up on page load
- [ ] Feature highlight cards stagger in
- [ ] Market highlight items stagger in
- [ ] Charts draw in on scroll
- [ ] Safety scores grade badges pop on scroll
- [ ] All animations respect `prefers-reduced-motion` (test in browser devtools: Rendering → Emulate CSS media feature → prefers-reduced-motion: reduce)

**Step 6: OG image smoke test**

With the Worker dev server running (`cd worker && npx wrangler dev`):
```bash
curl http://localhost:8787/api/og/stablecoin/usdc-circle -o /tmp/og-usdc.png
curl http://localhost:8787/api/og/safety-scores -o /tmp/og-safety.png
curl http://localhost:8787/api/og/depeg -o /tmp/og-depeg.png
curl http://localhost:8787/api/og/stability-index -o /tmp/og-psi.png
```

Open each PNG and verify:
- [ ] Correct dimensions (1200x628)
- [ ] Readable text (Geist fonts loaded correctly)
- [ ] Monospace numbers
- [ ] State-adaptive border/badge on coins that are stressed or depegged
- [ ] Sparkline renders for stablecoin cards

**Step 7: Commit**

```bash
git add -A
git commit -m "chore: verification pass — all builds, tests, and visual checks pass"
```

---

## Task Dependency Graph

```
Phase 1 (Foundation)          Phase 2 (Briefing)         Phase 4 (OG Infra)
  Task 1 ─┐                    Task 5 (pure fn)           Task 15 (deps+fonts)
  Task 2 ─┤                      ↓                          ↓
  Task 3 ─┤ (parallel)         Task 6 (component)         Task 16 (shared frame)
  Task 4 ─┘                      ↓                          ↓
     ↓                         Task 7 (integrate)         Task 17 (coin card)
Phase 3 (Motion Integration)       ↓                     Task 18 (aggregate cards)
  Task 8  (count-up KPI)      ←─ depends on T3              ↓
  Task 9  (stagger cards)     ←─ depends on T2            Task 19 (route handler)
  Task 10 (chart draw-in)                                    ↓
  Task 11 (grade pop)         ←─ depends on T2            Task 20 (bundle check)
  Task 12 (depeg slide-in)    ←─ depends on T2                ↓
  Task 13 (choreography)      ←─ depends on T4,T6,T8    Phase 5 (Frontend Meta)
  Task 14 (contagion ripple)                               Task 21 (update OG URLs)
                                                           Task 22 (share button)
                                                           Task 23 (integrate share)
                                                               ↓
                                                          Phase 6 (Verify)
                                                           Task 24
```

**Parallelizable groups:**
- Tasks 1-4 can all run in parallel (no dependencies between them)
- Tasks 5-7 (briefing) and Tasks 15-20 (OG infra) can run in parallel
- Tasks 8-12 (motion integration) can run in parallel after Phase 1
- Task 13 depends on Tasks 4, 6, and 8
- Task 24 runs last after everything
