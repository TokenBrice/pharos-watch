import type { DigestInputData } from "@shared/types/digest";
import { selectMomentumCandidates } from "../editorial-candidates";

export function formatDigestUsdPrice(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const decimals = Math.abs(value) < 0.1 ? 4 : 3;
  return `$${value.toFixed(decimals)}`;
}

function formatDateTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function pushDataQualityLines(lines: string[], data: DigestInputData): void {
  if (!data.dataQuality) return;

  const quality = data.dataQuality;
  lines.push("", "Data quality notes:");
  if (quality.stablecoinsCacheAgeSec != null) {
    lines.push(`  Stablecoins cache age: ${Math.round(quality.stablecoinsCacheAgeSec / 60)} minutes`);
  }
  if (quality.degradedSources && quality.degradedSources.length > 0) {
    lines.push(`  Missing/degraded collectors: ${quality.degradedSources.join(", ")}`);
    lines.push("  Do not infer calm from missing sections. Avoid claims about unavailable categories.");
  } else {
    lines.push("  No degraded collectors reported.");
  }
  lines.push(`  Blacklist window: ${quality.windows.blacklistActivity.label}, ${formatDateTime(quality.windows.blacklistActivity.start)} to ${formatDateTime(quality.windows.blacklistActivity.end)}`);
  lines.push(`  Mint/burn window: ${quality.windows.mintBurnFlows.label}, ${formatDateTime(quality.windows.mintBurnFlows.start)} to ${formatDateTime(quality.windows.mintBurnFlows.end)}`);
  lines.push(`  PSI source: ${quality.windows.psi.label}; sample=${quality.windows.psi.sampleAt ? formatDateTime(quality.windows.psi.sampleAt) : "n/a"}, daily=${quality.windows.psi.dailySnapshotAt ? formatDateTime(quality.windows.psi.dailySnapshotAt) : "n/a"}`);
}

export function pushEditorialCandidateLines(lines: string[], data: DigestInputData): void {
  const candidates = data.editorialCandidates ?? [];
  if (candidates.length === 0) return;

  const usable = candidates.filter((candidate) => !candidate.suppressReason).slice(0, 8);
  const suppressed = candidates.filter((candidate) => candidate.suppressReason).slice(0, 5);

  lines.push("", "Editorial Candidates (lead from these unless a higher candidate is suppressed):");
  for (const candidate of usable) {
    const symbols = candidate.symbols.length > 0 ? ` | coins=${candidate.symbols.join(",")}` : "";
    lines.push(
      `  ${candidate.id} | ${candidate.kind}/${candidate.novelty}${symbols} | impact/severity=${candidate.impactScore} | confidence=${candidate.confidence} | artifactRisk=${candidate.artifactRisk}`,
    );
    lines.push(`    facts: ${candidate.headlineFacts.join("; ")}`);
    lines.push(`    why: ${candidate.whyItMatters}`);
  }

  if (suppressed.length > 0) {
    lines.push("Suppressed or noisy candidates (do NOT lead with these):");
    for (const candidate of suppressed) {
      lines.push(
        `  ${candidate.id} | ${candidate.kind}/${candidate.novelty} | impact=${candidate.impactScore} | artifactRisk=${candidate.artifactRisk} | reason=${candidate.suppressReason}`,
      );
      lines.push(`    facts: ${candidate.headlineFacts.join("; ")}`);
    }
  }
}

export function pushMomentumLines(lines: string[], data: DigestInputData): void {
  const candidates = data.editorialCandidates ?? [];
  const momentum = selectMomentumCandidates(candidates);
  if (momentum.length === 0) return;
  lines.push("", "Momentum Candidates (forward-watch material; use these to anchor the required forward-look line):");
  for (const candidate of momentum) {
    const symbols = candidate.symbols.length > 0 ? ` | coins=${candidate.symbols.join(",")}` : "";
    lines.push(
      `  ${candidate.id} | ${candidate.kind}/${candidate.novelty}${symbols} | impact=${candidate.impactScore}`,
    );
    lines.push(`    why it may keep moving: ${candidate.whyItMatters}`);
  }
}

export function pushDigestIntelligenceLines(lines: string[], data: DigestInputData): void {
  if (data.riskTape && data.riskTape.length > 0) {
    lines.push("", "Risk Tape (compact reader-facing state):");
    for (const item of data.riskTape) {
      lines.push(`  ${item.label}: ${item.value} | tone=${item.tone}${item.detail ? ` | ${item.detail}` : ""}`);
    }
  }

  const change = data.changeSummary;
  if (change) {
    lines.push("", `What changed since yesterday${change.previousDate ? ` (${change.previousDate})` : ""}:`);
    if (change.newSignals.length > 0) {
      lines.push(`  New: ${change.newSignals.map((item) => `${item.label} (${item.detail})`).join("; ")}`);
    }
    if (change.worsenedSignals.length > 0) {
      lines.push(`  Worsened: ${change.worsenedSignals.map((item) => `${item.label} (${item.detail})`).join("; ")}`);
    }
    if (change.improvedSignals.length > 0) {
      lines.push(`  Improved: ${change.improvedSignals.map((item) => `${item.label} (${item.detail})`).join("; ")}`);
    }
    if (change.resolvedSignals.length > 0) {
      lines.push(`  Cleared: ${change.resolvedSignals.map((item) => `${item.label} (${item.detail})`).join("; ")}`);
    }
    if (change.repeatedSignals.length > 0) {
      lines.push(`  Still present: ${change.repeatedSignals.map((item) => item.label).join("; ")}`);
    }
  }

  if (data.forwardLookOutcomes && data.forwardLookOutcomes.length > 0) {
    lines.push("", "Yesterday's forward-look outcomes:");
    for (const outcome of data.forwardLookOutcomes) {
      lines.push(`  ${outcome.status.toUpperCase()}: ${outcome.label} | ${outcome.detail}`);
    }
  }

  if (data.nextTriggers && data.nextTriggers.length > 0) {
    lines.push("", "Deterministic Next Triggers (use one for the required forward-look line):");
    for (const trigger of data.nextTriggers) {
      lines.push(`  ${trigger.id} | ${trigger.label} | ${trigger.thresholdLabel} | ${trigger.detail}`);
    }
  }

  if (data.calmNarrativeFrame) {
    lines.push("", `Calm Narrative Frame: ${data.calmNarrativeFrame.label} | ${data.calmNarrativeFrame.detail}`);
  }
}
