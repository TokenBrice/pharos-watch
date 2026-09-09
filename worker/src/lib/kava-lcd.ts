import { z } from "zod";

/**
 * Shared Kava LCD (api.data.kava.io) parsing primitives used by both the
 * reserve CDP adapter and the authoritative USDX pricefeed provider. The two
 * consumers must agree on block freshness, chain identity, and decimal
 * parsing so a reserve snapshot and the price that values it can never drift
 * on a stale or malformed block.
 */

const KAVA_CHAIN_ID = "kava_2222-10";

/** Blocks older than this are rejected as stale-oracle evidence. */
const KAVA_BLOCK_MAX_AGE_SEC = 2 * 60;
/** Blocks more than this far in the future are rejected as clock-skewed evidence. */
const KAVA_BLOCK_MAX_FUTURE_SKEW_SEC = 60;

export const KavaBlockSchema = z.object({
  block: z.object({
    header: z.object({
      chain_id: z.string(),
      height: z.string(),
      time: z.string(),
    }),
  }),
});

export type KavaBlockPayload = z.infer<typeof KavaBlockSchema>;

export interface KavaBlockHeader {
  chain_id: string;
  height: string;
  time: string;
}

export interface KavaBlockPin {
  blockHeight: number;
  blockTimeSec: number;
}

/** Parses a finite, positive decimal string (pricefeed prices). Rejects
 *  malformed, non-finite, or non-positive inputs. */
export function parseFinitePositiveDecimal(value: string): number | null {
  const characters = [...value];
  let decimalPoints = 0;
  if (
    characters.length === 0 ||
    characters.length > 128 ||
    characters[0] === "." ||
    characters[characters.length - 1] === "." ||
    characters.some((character) => {
      if (character === ".") {
        decimalPoints += 1;
        return decimalPoints > 1;
      }
      return character < "0" || character > "9";
    })
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Parses an RFC 3339 timestamp into floored Unix seconds, or null. */
export function parseTimestampSec(value: string): number | null {
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) && parsedMs > 0 ? Math.floor(parsedMs / 1_000) : null;
}

/** Validates a Kava latest-block header against the pinned chain identity and
 *  freshness bounds. Returns the parsed block height and time, or null when
 *  the header is stale, future-skewed, malformed, or from the wrong chain. */
export function validateKavaBlockHeader(header: KavaBlockHeader, nowSec: number): KavaBlockPin | null {
  const blockHeight = Number(header.height);
  const blockTimeSec = parseTimestampSec(header.time);
  if (
    header.chain_id !== KAVA_CHAIN_ID ||
    !Number.isSafeInteger(blockHeight) ||
    blockHeight <= 0 ||
    blockTimeSec == null ||
    nowSec - blockTimeSec > KAVA_BLOCK_MAX_AGE_SEC ||
    blockTimeSec - nowSec > KAVA_BLOCK_MAX_FUTURE_SKEW_SEC
  ) {
    return null;
  }
  return { blockHeight, blockTimeSec };
}
