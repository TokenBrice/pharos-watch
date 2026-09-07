import Link from "next/link";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { SafetyScoreV9TopDriver } from "@shared/lib/safety-score-v9/public";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation";

const CHIP_CLASS =
  "pharos-focus-ring inline-flex max-w-full items-center rounded-full border border-border/60 bg-muted/20 px-2 py-1 text-[10px] leading-none text-muted-foreground hover:border-border hover:text-foreground";

const EVIDENCE_AGE_LABELS: Record<SafetyScoreV9TopDriver["evidenceFreshness"], string> = {
  current: "current",
  stale: "stale",
  unknown: "unknown",
};

export interface SafetyScoreTopDriverProps {
  coinId: string;
  driver: SafetyScoreV9TopDriver | null;
  subjectLabel?: string;
}

function humanizeDriverLabel(label: string): string {
  return humanizeSafetyScoreV9Value(label.replaceAll(":", " "));
}

function driverText(driver: SafetyScoreV9TopDriver): string {
  const evidenceAge = `Evidence age ${EVIDENCE_AGE_LABELS[driver.evidenceFreshness]}`;
  if (driver.kind === "withheld") return `Score withheld · ${evidenceAge}`;
  if (driver.kind === "cap-bound") {
    const limit = driver.value === null ? "" : ` ≤${driver.value.toFixed(0)}`;
    return `Binding cap · ${humanizeDriverLabel(driver.label ?? "cap")}${limit} · ${evidenceAge}`;
  }
  const score = driver.value === null ? "" : ` ${driver.value.toFixed(0)}`;
  return `Weakest pillar · ${humanizeDriverLabel(driver.label ?? "pillar")}${score} · ${evidenceAge}`;
}

export function SafetyScoreTopDriver({ coinId, driver, subjectLabel = coinId }: SafetyScoreTopDriverProps) {
  if (driver === null) return null;
  const text = driverText(driver);
  const detail = driver.reason ? ` ${driver.reason}` : "";
  return (
    <Link
      href={buildStablecoinUrl(coinId, "#report-card")}
      className={CHIP_CLASS}
      title={driver.reason ?? text}
      aria-label={`Open Safety Score waterfall for ${subjectLabel}; top driver: ${text}.${detail}`}
    >
      <span className="truncate">{text}</span>
    </Link>
  );
}
