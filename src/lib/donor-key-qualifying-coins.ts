import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import { getSnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";
import { formatProseList } from "@shared/lib/format";
import {
  DONOR_KEY_QUALIFYING_STABLECOINS,
  donorKeyGradeStatus,
  type DonorKeyGradeStatus,
  type DonorKeyQualifyingStablecoin,
} from "@shared/lib/funding/donor-eligibility";
import type { ReportCardGrade } from "@shared/types/report-card-grade";

/** Grade source for one stablecoin; `null` means no grade is available. */
export type DonorKeyGradeLookup = (
  stablecoinId: string,
) => { grade: ReportCardGrade; score: number | null } | null;

export interface DonorKeyQualifyingCoin {
  label: string;
  stablecoinId: string;
  grade: ReportCardGrade | null;
  score: number | null;
  status: DonorKeyGradeStatus;
}

/** Above this many counting coins, the name summary lists the first few and a remainder. */
const MAX_FULLY_LISTED_COUNTING_COINS = 5;
const LISTED_BEFORE_REMAINDER = 3;

/** Joins the reviewed allowlist with a grade source, keeping allowlist order. */
export function buildDonorKeyQualifyingCoins(
  coins: readonly DonorKeyQualifyingStablecoin[],
  lookupGrade: DonorKeyGradeLookup,
): DonorKeyQualifyingCoin[] {
  return coins.map(({ label, stablecoinId }) => {
    const assessment = lookupGrade(stablecoinId);
    const grade = assessment?.grade ?? null;
    return { label, stablecoinId, grade, score: assessment?.score ?? null, status: donorKeyGradeStatus(grade) };
  });
}

/**
 * Prose list of the coins that currently count, in list order: every name up
 * to five, otherwise the first three and a remainder ("USDC, USDT, DAI, and 3 more").
 */
export function summarizeCountingCoinNames(coins: readonly DonorKeyQualifyingCoin[]): string {
  const labels = coins.filter((coin) => coin.status === "counts").map((coin) => coin.label);
  if (labels.length <= MAX_FULLY_LISTED_COUNTING_COINS) return formatProseList(labels);
  return formatProseList([
    ...labels.slice(0, LISTED_BEFORE_REMAINDER),
    `${labels.length - LISTED_BEFORE_REMAINDER} more`,
  ]);
}

/**
 * The allowlist graded from the release's `scores-latest` snapshot. The Worker
 * checks live grades again at claim time, so this is an as-of view.
 */
export function getCurrentDonorKeyQualifyingCoins(): { asOfDate: string; coins: DonorKeyQualifyingCoin[] } {
  return {
    asOfDate: PUBLIC_DATASET_CURRENT_DATE,
    coins: buildDonorKeyQualifyingCoins(DONOR_KEY_QUALIFYING_STABLECOINS, getSnapshotSafetyAssessment),
  };
}
