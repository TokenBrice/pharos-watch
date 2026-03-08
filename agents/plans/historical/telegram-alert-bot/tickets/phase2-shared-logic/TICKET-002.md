---
title: "Add message templates and subscriber query helpers"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "high"
done: false
---

## Goal

Extend `worker/src/lib/telegram-alerts.ts` with alert message formatting, message splitting, subscriber D1 queries, and `/list` output formatting.

## Task

1. **Add to `worker/src/lib/telegram-alerts.ts`** — append these exports to the existing file created in TICKET-001:

First, add this import to the top of the file (alongside the existing `@shared/lib/stablecoins` import):
```typescript
import { escapeHtml } from "./telegram";
```

Then append the following exports:

```typescript
// ---------- Alert Message Formatting ----------

export interface DewsChange {
  stablecoinId: string;
  symbol: string;
  oldBand: string;
  newBand: string;
  score: number;
  topSignals: { name: string; value: number }[];
}

export interface DepegEvent {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  deviationBps: number;
  price: number;
  pegReference: number;
}

export interface DepegResolved {
  stablecoinId: string;
  symbol: string;
  durationMinutes: number;
  peakDeviationBps: number;
  recoveryPrice: number;
}

export interface SafetyChange {
  stablecoinId: string;
  symbol: string;
  oldGrade: string;
  newGrade: string;
  oldScore: number | null;
  newScore: number | null;
}

export function formatDewsLine(e: DewsChange): string {
  const signals = e.topSignals.slice(0, 2).map((s) => `${s.name} (${s.value})`).join(", ");
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldBand} → ${e.newBand} (score: ${e.score})${signals ? `\nTop signals: ${signals}` : ""}`;
}

export function formatDepegTriggeredLine(e: DepegEvent): string {
  const pct = (e.deviationBps / 100).toFixed(1);
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.direction} peg\nDeviation: ${pct}% (${e.deviationBps} bps)\nPrice: $${e.price.toFixed(4)} (peg: $${e.pegReference.toFixed(2)})`;
}

export function formatDepegResolvedLine(e: DepegResolved): string {
  const hours = Math.floor(e.durationMinutes / 60);
  const mins = e.durationMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `<b>${escapeHtml(e.symbol)}</b>\nDuration: ${duration}\nPeak deviation: ${(e.peakDeviationBps / 100).toFixed(1)}%\nRecovery price: $${e.recoveryPrice.toFixed(4)}`;
}

export function formatSafetyLine(e: SafetyChange): string {
  const scores = e.oldScore != null && e.newScore != null ? `\nScore: ${e.oldScore} → ${e.newScore}` : "";
  return `<b>${escapeHtml(e.symbol)}</b> — ${e.oldGrade} → ${e.newGrade}${scores}`;
}

export interface ConsolidatedAlerts {
  dews: DewsChange[];
  depegTriggered: DepegEvent[];
  depegResolved: DepegResolved[];
  safety: SafetyChange[];
}

/** Build a consolidated HTML message for one subscriber. */
export function formatConsolidatedMessage(alerts: ConsolidatedAlerts): string {
  const sections: string[] = [];

  if (alerts.dews.length > 0) {
    sections.push(`<b>DEWS</b>\n${alerts.dews.map(formatDewsLine).join("\n\n")}`);
  }
  if (alerts.depegTriggered.length > 0) {
    sections.push(`<b>Depeg Detected</b>\n${alerts.depegTriggered.map(formatDepegTriggeredLine).join("\n\n")}`);
  }
  if (alerts.depegResolved.length > 0) {
    sections.push(`<b>Depeg Resolved</b>\n${alerts.depegResolved.map(formatDepegResolvedLine).join("\n\n")}`);
  }
  if (alerts.safety.length > 0) {
    sections.push(`<b>Safety Grade Change</b>\n${alerts.safety.map(formatSafetyLine).join("\n\n")}`);
  }

  const body = sections.join("\n\n");
  return `<b>Pharos Alerts</b>\n\n${body}\n\n<a href="https://pharos.watch">View on Pharos</a>`;
}

/** Split a message into chunks under the given character limit. */
export function splitMessage(html: string, limit = 4000): string[] {
  if (html.length <= limit) return [html];
  // Split on double-newline boundaries to preserve structure
  const sections = html.split("\n\n");
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- List Output Formatting ----------

export function formatListOutput(
  alertFlags: { dews: boolean; depeg: boolean; safety: boolean },
  coins: { symbol: string; id: string }[],
): string {
  const types: string[] = [];
  if (alertFlags.dews) types.push("DEWS");
  if (alertFlags.depeg) types.push("Depeg");
  if (alertFlags.safety) types.push("Safety");

  const typesStr = types.length > 0 ? types.join(", ") : "None";
  const coinsStr =
    coins.length > 0
      ? coins.map((c) => `- ${c.symbol} (${c.id})`).join("\n")
      : "None";

  return `Alert types: ${typesStr}\nCoins (${coins.length}):\n${coinsStr}`;
}

// ---------- DEWS Alert Band Filter ----------

const ALERTABLE_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);

/** Returns true if a DEWS band change should trigger a notification. */
export function isDewsAlertable(newBand: string): boolean {
  return ALERTABLE_BANDS.has(newBand);
}

/** Returns true if this is a de-escalation within alertable range (send silently). */
export function isDewsDeescalation(oldBand: string, newBand: string): boolean {
  const order = ["CALM", "WATCH", "ALERT", "WARNING", "DANGER"];
  return order.indexOf(newBand) < order.indexOf(oldBand);
}
```

2. **Append tests to `worker/src/lib/__tests__/telegram-alerts.test.ts`**:

```typescript
// Add these imports to the existing import statement:
// formatConsolidatedMessage, splitMessage, formatListOutput, isDewsAlertable, isDewsDeescalation

describe("formatConsolidatedMessage", () => {
  it("includes all alert sections", () => {
    const msg = formatConsolidatedMessage({
      dews: [{ stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "ALERT", score: 42, topSignals: [{ name: "supply", value: 45 }] }],
      depegTriggered: [{ stablecoinId: "bold-liquity", symbol: "BOLD", direction: "below", deviationBps: 230, price: 0.977, pegReference: 1.0 }],
      depegResolved: [],
      safety: [],
    });
    expect(msg).toContain("DEWS");
    expect(msg).toContain("Depeg Detected");
    expect(msg).toContain("Pharos Alerts");
    expect(msg).toContain("View on Pharos");
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("splits long messages at section boundaries", () => {
    const long = Array(100).fill("Section text here").join("\n\n");
    const chunks = splitMessage(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200 + 100); // allow single oversized section
    }
  });
});

describe("formatListOutput", () => {
  it("formats active subscriptions", () => {
    const output = formatListOutput(
      { dews: true, depeg: true, safety: false },
      [{ symbol: "USDC", id: "usdc-circle" }, { symbol: "BOLD", id: "bold-liquity" }],
    );
    expect(output).toContain("DEWS, Depeg");
    expect(output).toContain("Coins (2)");
    expect(output).toContain("USDC (usdc-circle)");
  });

  it("shows None when no types or coins", () => {
    const output = formatListOutput({ dews: false, depeg: false, safety: false }, []);
    expect(output).toContain("Alert types: None");
    expect(output).toContain("Coins (0):\nNone");
  });
});

describe("isDewsAlertable", () => {
  it("returns true for ALERT, WARNING, DANGER", () => {
    expect(isDewsAlertable("ALERT")).toBe(true);
    expect(isDewsAlertable("WARNING")).toBe(true);
    expect(isDewsAlertable("DANGER")).toBe(true);
  });

  it("returns false for CALM and WATCH", () => {
    expect(isDewsAlertable("CALM")).toBe(false);
    expect(isDewsAlertable("WATCH")).toBe(false);
  });
});

describe("isDewsDeescalation", () => {
  it("detects de-escalation", () => {
    expect(isDewsDeescalation("DANGER", "WARNING")).toBe(true);
    expect(isDewsDeescalation("WARNING", "ALERT")).toBe(true);
  });

  it("detects escalation", () => {
    expect(isDewsDeescalation("ALERT", "WARNING")).toBe(false);
    expect(isDewsDeescalation("CALM", "DANGER")).toBe(false);
  });
});
```

## Acceptance Criteria

- `grep -c 'export function format' worker/src/lib/telegram-alerts.ts` returns at least 5
- `grep -c 'export function splitMessage' worker/src/lib/telegram-alerts.ts` returns 1
- `grep -c 'export function isDewsAlertable' worker/src/lib/telegram-alerts.ts` returns 1
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
