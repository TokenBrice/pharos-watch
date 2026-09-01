import { logWorkerEventArgs } from "../../lib/structured-log";
import type { DigestMeta } from "./prompt";
import { toErrorMessage } from "@shared/lib/error-utils";

export interface RecentDigestMetaEntry {
  meta: DigestMeta | null;
  /**
   * Prompt-only variety fallback for pre-meta editions. `buildUserPrompt` uses
   * this solely in its `else` branch, so it stays null once structured `meta`
   * exists and never inflates the prompt for modern editions.
   */
  rawText: string | null;
  /**
   * Validator history, always populated. The opening-fingerprint and
   * structural-repetition checks measure the body, not the tweet-sized text, so
   * they need `digest_extended` for every recent edition — including modern ones
   * that carry `meta` and therefore have a null `rawText`.
   */
  extended: string | null;
  title: string | null;
}

export function buildRecentDigestMeta(
  rows: Array<{
    digest_title: string | null;
    digest_text: string;
    digest_extended?: string | null;
    digest_meta: string | null;
  }>,
): RecentDigestMetaEntry[] {
  return rows.map((row) => {
    let storedMeta: DigestMeta | null = null;
    if (row.digest_meta) {
      try {
        const decoded: unknown = JSON.parse(row.digest_meta);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
          storedMeta = decoded as DigestMeta;
        }
      } catch (err) {
        logWorkerEventArgs("handler", "warn", `[daily-digest] Failed to parse digest_meta: ${toErrorMessage(err)}`);
      }
    }

    const meta: DigestMeta = {
      ...(storedMeta ?? {}),
      editorialStyleVersion: storedMeta?.editorialStyleVersion ?? "pre-policy",
      editorialStyleHash: storedMeta?.editorialStyleHash ?? "pre-policy",
    };

    return {
      meta,
      // Preserve the pre-meta prompt fallback without writing a sentinel back
      // to D1. A legacy row with no metadata still supplies its old copy.
      rawText: !storedMeta ? (row.digest_title ? `${row.digest_title}: ${row.digest_text}` : row.digest_text) : null,
      extended: row.digest_extended ?? null,
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
