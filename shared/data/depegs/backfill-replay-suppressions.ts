/**
 * Reviewed depeg backfill replay-suppression registry (ADR-32 guarded).
 *
 * An entry records an operator verdict that a recomputed backfill episode is a
 * price-feed artifact, not a market depeg: backfill replay (the
 * buildBackfillPlan -> executeBackfillForCoin -> applyBackfillEvents pipeline)
 * must never persist episodes whose window overlaps a matching entry. This is
 * what keeps reviewed artifact deletions durable against future admin replays,
 * which otherwise delete + recompute every `source='backfill'` row.
 *
 * Entries are reviewed data: each one cites the primary evidence behind the
 * verdict. The corpus is validated at module initialization (fail closed, the
 * `shared/data/annotations/curated-annotations.ts` precedent) and the
 * registry-integrity vitest suite in `__tests__/` guards coin ids and
 * cross-entry overlap against the stablecoin catalog.
 */
import canonicalOrderAsset from "../stablecoins/canonical-order.json";
import { DepegDirectionSchema } from "@shared/types/market";
import type { DepegDirection } from "@shared/types/market";

export interface BackfillReplaySuppression {
  /** Tracked stablecoin id whose recomputed backfill episodes are suppressed. */
  readonly coinId: string;
  /** Depeg side the verdict applies to (existing DepegDirection vocabulary). */
  readonly direction: DepegDirection;
  /** Inclusive UTC window bounds, Unix seconds. */
  readonly windowStart: number;
  /** Inclusive UTC window bounds, Unix seconds. */
  readonly windowEnd: number;
  /** Reviewed verdict, stated as the artifact conclusion. */
  readonly reason: string;
  /** Primary evidence (on-chain forensics + price-feed pages) behind the verdict. */
  readonly evidenceUrls: readonly string[];
  /** Date the evidence was reviewed (YYYY-MM-DD, UTC). */
  readonly reviewedAt: string;
}

const REVIEWED_AT = "2026-09-22";
const REASON =
  "CoinGecko last-trade print artifact: no economic-size on-chain USN trade executed above 1.0011 in the window; pool mids stayed ~$1.000.";

/**
 * Reviewed suppression windows for the Noon USN upside artifacts. Windows span
 * the union of the stored episode, its dust/recovery transactions, and a ±2h
 * margin: CoinGecko's current history has already moved episode edges and peaks
 * by up to ~1h versus the captured samples (see evidence), and hourly sample
 * granularity means one revised sample shifts an episode edge by 3600s.
 */
export const BACKFILL_REPLAY_SUPPRESSIONS: readonly BackfillReplaySuppression[] = [
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_759_849_487, // 2025-10-07T15:04:47Z
    windowEnd: 1_759_878_119, // 2025-10-07T23:01:59Z
    reason: REASON,
    evidenceUrls: [
      "https://etherscan.io/tx/0xb7de18d338721b6d57f429239ed8b0a1f4b9347aff114823db559206f932d2c1",
      "https://etherscan.io/tx/0x4d6f52b8fad9a6878155dc8e3f18a0995c33f76e16b532cdca19e277da60d971",
      "https://etherscan.io/tx/0x159e87e14969caafd667b27944a8d9b72b9296f0ad1ca77b67867dcb045d8c9b",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_766_853_587, // 2025-12-27T16:39:47Z
    windowEnd: 1_766_894_494, // 2025-12-28T04:01:34Z
    reason: REASON,
    evidenceUrls: [
      "https://etherscan.io/tx/0x7014ed8ca2b1537276bd37058cb54c3ebdc44c998714c59b203097b72a56966f",
      "https://etherscan.io/tx/0x9e0b9b3f05d4a40aadd0528666b878fcc0a222e7ddb4ad1700658ec0730bd363",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_771_065_524, // 2026-02-14T10:38:44Z
    windowEnd: 1_771_104_920, // 2026-02-14T21:35:20Z
    reason: REASON,
    evidenceUrls: [
      "https://starkscan.co/tx/0x07d34fc678b61239d32725b01bfd2bb6d7669b58d2f782e98e6631b0315106c9",
      "https://starkscan.co/tx/0x0273de25b5c85ca7d851b3cbf1824565506632b03cf4f9818d4b356fa86ddea3",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
  {
    coinId: "usn-noon",
    direction: "above",
    windowStart: 1_772_453_730, // 2026-03-02T12:15:30Z
    windowEnd: 1_772_471_721, // 2026-03-02T17:15:21Z
    reason: REASON,
    evidenceUrls: [
      "https://starkscan.co/tx/0x04c69b971c345f9774d24495062f50d7eda09d661ca67e8517e0ccafcded9b31",
      "https://starkscan.co/tx/0x04fdf45b0020118046ec7de859377cfe968910de8361644ab2afbabc3eb2ac93",
      "https://www.coingecko.com/en/coins/noon-usn",
    ],
    reviewedAt: REVIEWED_AT,
  },
];

const KNOWN_STABLECOIN_IDS = new Set(canonicalOrderAsset as readonly string[]);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(index: number, message: string): never {
  throw new Error(`Invalid backfill replay suppression [${index}]: ${message}`);
}

function validateRegistry(entries: readonly BackfillReplaySuppression[]): void {
  entries.forEach((entry, index) => {
    if (!KNOWN_STABLECOIN_IDS.has(entry.coinId)) {
      invalid(index, `unknown stablecoin id ${entry.coinId}`);
    }
    if (!DepegDirectionSchema.options.includes(entry.direction)) {
      invalid(index, `direction must be one of ${DepegDirectionSchema.options.join(", ")}`);
    }
    if (!Number.isInteger(entry.windowStart) || !Number.isInteger(entry.windowEnd)) {
      invalid(index, "window bounds must be integer Unix seconds");
    }
    if (entry.windowStart >= entry.windowEnd) {
      invalid(index, "windowStart must be before windowEnd");
    }
    if (entry.reason.trim().length === 0) {
      invalid(index, "reason must be non-empty");
    }
    if (!DATE_ONLY_RE.test(entry.reviewedAt) || Number.isNaN(Date.parse(entry.reviewedAt))) {
      invalid(index, "reviewedAt must be a YYYY-MM-DD date");
    }
    if (entry.evidenceUrls.length === 0) {
      invalid(index, "at least one evidence URL is required");
    }
    entry.evidenceUrls.forEach((url, urlIndex) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        invalid(index, `evidenceUrls[${urlIndex}] is not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "https:") {
        invalid(index, `evidenceUrls[${urlIndex}] must use https: ${url}`);
      }
    });
  });
}

validateRegistry(BACKFILL_REPLAY_SUPPRESSIONS);

/**
 * Interval-overlap test between a recomputed backfill episode and a suppression
 * window. Both bounds are inclusive: an episode shares at least one second with
 * the window iff `episodeStart <= windowEnd && windowStart <= episodeEnd`.
 * Open episodes (endedAt null) are treated as point-in-time intervals at their
 * start, matching how the live/open rows are compared elsewhere.
 */
export function backfillEpisodeInSuppressionWindow(
  episode: { startedAt: number; endedAt: number | null },
  entry: Pick<BackfillReplaySuppression, "windowStart" | "windowEnd">,
): boolean {
  const episodeEnd = episode.endedAt ?? episode.startedAt;
  return episode.startedAt <= entry.windowEnd && entry.windowStart <= episodeEnd;
}

/**
 * Returns the reviewed suppression covering a recomputed backfill episode for
 * this coin and direction, or null when the episode is not suppressed.
 */
export function findBackfillReplaySuppression(
  coinId: string,
  direction: string,
  episode: { startedAt: number; endedAt: number | null },
): BackfillReplaySuppression | null {
  return BACKFILL_REPLAY_SUPPRESSIONS.find(
    (entry) =>
      entry.coinId === coinId &&
      entry.direction === direction &&
      backfillEpisodeInSuppressionWindow(episode, entry),
  ) ?? null;
}
