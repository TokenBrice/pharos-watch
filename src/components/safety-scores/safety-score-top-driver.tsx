import Link from "next/link";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { SafetyScoreV9TopDriver } from "@shared/lib/safety-score-v9/public-top-driver";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation";

const STATIC_CHIP_CLASS =
  "inline-flex max-w-full items-center rounded-full border border-border/60 bg-muted/20 px-2 py-1 text-3xs leading-none text-muted-foreground";
const CHIP_CLASS = `pharos-focus-ring ${STATIC_CHIP_CLASS} hover:border-border hover:text-foreground`;

const EVIDENCE_AGE_LABELS: Record<SafetyScoreV9TopDriver["evidenceFreshness"], string> = {
  current: "current",
  stale: "stale",
  unknown: "not assessed",
};

export interface SafetyScoreTopDriverProps {
  coinId: string;
  /** No `evidenceFreshness` (a projection that carries no verdict) omits the evidence-age segment. */
  driver: (Omit<SafetyScoreV9TopDriver, "evidenceFreshness"> & Partial<Pick<SafetyScoreV9TopDriver, "evidenceFreshness">>) | null;
  subjectLabel?: string;
  /** False inside a surface that is already a link (a whole-card link cannot nest another). */
  link?: boolean;
}

function humanizeDriverLabel(label: string): string {
  return humanizeSafetyScoreV9Value(label.replaceAll(":", " "));
}

function driverText(driver: NonNullable<SafetyScoreTopDriverProps["driver"]>): string {
  const evidenceAge = driver.evidenceFreshness === undefined ? "" : ` · Evidence age ${EVIDENCE_AGE_LABELS[driver.evidenceFreshness]}`;
  if (driver.kind === "withheld") return `Score withheld${evidenceAge}`;
  if (driver.kind === "cap-bound") {
    const limit = driver.value === null ? "" : ` ≤${driver.value.toFixed(0)}`;
    return `Binding cap · ${humanizeDriverLabel(driver.label ?? "cap")}${limit}${evidenceAge}`;
  }
  if (driver.kind === "peg-bound") {
    // The score waterfall's label and operator: "Peg performance · x0.510 on pillar quality 52/100".
    const multiplier = driver.value === null ? "" : ` x${driver.value.toFixed(3)}`;
    const quality = driver.quality === undefined ? "" : ` on pillar quality ${driver.quality.toFixed(0)}/100`;
    return `Peg performance ·${multiplier}${quality}${evidenceAge}`;
  }
  const score = driver.value === null ? "" : ` ${driver.value.toFixed(0)}`;
  return `Weakest pillar · ${humanizeDriverLabel(driver.label ?? "pillar")}${score}${evidenceAge}`;
}

export function SafetyScoreTopDriver({ coinId, driver, subjectLabel = coinId, link = true }: SafetyScoreTopDriverProps) {
  if (driver === null) return null;
  const text = driverText(driver);
  if (!link) {
    return (
      <span className={STATIC_CHIP_CLASS} title={driver.reason ?? text}>
        <span className="truncate">{text}</span>
      </span>
    );
  }
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
