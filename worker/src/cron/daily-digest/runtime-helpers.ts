import { logWorkerEventArgs } from "../../lib/structured-log";
import type { DigestMeta } from "./prompt";
import { toErrorMessage } from "@shared/lib/error-utils";

export interface RecentDigestMetaEntry {
  meta: DigestMeta | null;
  rawText: string | null;
  title: string | null;
}

export function buildRecentDigestMeta(
  rows: Array<{
    digest_title: string | null;
    digest_text: string;
    digest_meta: string | null;
  }>,
): RecentDigestMetaEntry[] {
  return rows.map((row) => {
    let meta: DigestMeta | null = null;
    if (row.digest_meta) {
      try {
        meta = JSON.parse(row.digest_meta) as DigestMeta;
      } catch (err) {
        logWorkerEventArgs("handler", "warn", `[daily-digest] Failed to parse digest_meta: ${toErrorMessage(err)}`);
      }
    }

    return {
      meta,
      rawText: !meta ? (row.digest_title ? `${row.digest_title}: ${row.digest_text}` : row.digest_text) : null,
      title: row.digest_title ?? null,
    };
  });
}

export function logDailyDigestLlmCall(params: {
  activeDepegCount: number;
  topDepegs: readonly unknown[];
  resolvedDepegs?: readonly unknown[] | null;
  yieldAnomalies?: readonly unknown[] | null;
  liquidityShifts?: readonly unknown[] | null;
  recentMeta: readonly unknown[];
  degradedReasons: readonly string[];
}): void {
  logWorkerEventArgs("handler", "info",
    `[daily-digest] Calling Claude API ` +
      `(activeDepegs=${params.activeDepegCount}, topDepegs=${params.topDepegs.length}, ` +
      `resolvedDepegs=${params.resolvedDepegs?.length ?? 0}, yieldAnomalies=${params.yieldAnomalies?.length ?? 0}, ` +
      `liquidityShifts=${params.liquidityShifts?.length ?? 0}, recentDigests=${params.recentMeta.length}, ` +
      `degradedSources=${params.degradedReasons.length})`,
  );
}
