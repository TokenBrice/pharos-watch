import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  BACKFILL_REPLAY_SUPPRESSIONS,
  backfillEpisodeInSuppressionWindow,
  findBackfillReplaySuppression,
} from "../backfill-replay-suppressions";
import { DepegDirectionSchema } from "@shared/types/market";

const canonicalOrder = JSON.parse(
  readFileSync(join(process.cwd(), "shared/data/stablecoins/canonical-order.json"), "utf8"),
) as readonly string[];

/** The five stored USN episodes the registry must durably suppress (live API capture 2026-09-23). */
const STORED_USN_EPISODES = [
  { id: 49235, startedAt: 1_759_860_119, endedAt: 1_759_870_919 },
  { id: 49236, startedAt: 1_766_876_508, endedAt: 1_766_887_294 },
  { id: 49237, startedAt: 1_771_074_028, endedAt: 1_771_095_624 },
  { id: 24424, startedAt: 1_771_075_505, endedAt: 1_771_097_720 },
  { id: 83782, startedAt: 1_772_463_628, endedAt: 1_772_464_521 },
] as const;

describe("backfill replay suppression registry", () => {
  it("references only tracked stablecoin ids", () => {
    const known = new Set(canonicalOrder);
    for (const entry of BACKFILL_REPLAY_SUPPRESSIONS) {
      expect(known.has(entry.coinId), entry.coinId).toBe(true);
    }
  });

  it("uses the shared DepegDirection vocabulary", () => {
    for (const entry of BACKFILL_REPLAY_SUPPRESSIONS) {
      expect(DepegDirectionSchema.options).toContain(entry.direction);
    }
  });

  it("keeps ordered integer windows, https evidence, and reviewed dates", () => {
    for (const entry of BACKFILL_REPLAY_SUPPRESSIONS) {
      expect(Number.isInteger(entry.windowStart)).toBe(true);
      expect(Number.isInteger(entry.windowEnd)).toBe(true);
      expect(entry.windowStart).toBeLessThan(entry.windowEnd);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.evidenceUrls.length).toBeGreaterThan(0);
      for (const url of entry.evidenceUrls) {
        expect(url.startsWith("https://"), url).toBe(true);
        expect(() => new URL(url)).not.toThrow();
      }
    }
  });

  it("has no overlapping duplicate entries for the same coin and direction", () => {
    for (let i = 0; i < BACKFILL_REPLAY_SUPPRESSIONS.length; i++) {
      for (let j = i + 1; j < BACKFILL_REPLAY_SUPPRESSIONS.length; j++) {
        const a = BACKFILL_REPLAY_SUPPRESSIONS[i]!;
        const b = BACKFILL_REPLAY_SUPPRESSIONS[j]!;
        if (a.coinId !== b.coinId || a.direction !== b.direction) continue;
        const overlaps = a.windowStart <= b.windowEnd && b.windowStart <= a.windowEnd;
        expect(overlaps, `${a.coinId} entries ${i}/${j} overlap`).toBe(false);
      }
    }
  });

  it("suppresses every stored USN artifact episode, both live and backfill captures", () => {
    for (const episode of STORED_USN_EPISODES) {
      const suppression = findBackfillReplaySuppression("usn-noon", "above", episode);
      expect(suppression, `episode ${episode.id}`).not.toBeNull();
      expect(suppression?.coinId).toBe("usn-noon");
    }
  });

  it("scopes suppression to the reviewed coin and direction", () => {
    const feb14 = STORED_USN_EPISODES[3]!;
    expect(findBackfillReplaySuppression("susn-noon", "above", feb14)).toBeNull();
    expect(findBackfillReplaySuppression("usn-noon", "below", feb14)).toBeNull();
  });

  it("does not suppress episodes adjacent to a reviewed window", () => {
    const entry = BACKFILL_REPLAY_SUPPRESSIONS.find((candidate) => candidate.windowStart === 1_771_065_524)!;
    // One second before the window starts: outside.
    expect(
      backfillEpisodeInSuppressionWindow(
        { startedAt: entry.windowStart - 3_600, endedAt: entry.windowStart - 1 },
        entry,
      ),
    ).toBe(false);
    // Sharing exactly the window's first second: inside (inclusive bounds).
    expect(
      backfillEpisodeInSuppressionWindow({ startedAt: entry.windowStart - 600, endedAt: entry.windowStart }, entry),
    ).toBe(true);
    // Open episodes collapse to their start timestamp.
    expect(
      backfillEpisodeInSuppressionWindow({ startedAt: entry.windowEnd + 1, endedAt: null }, entry),
    ).toBe(false);
    expect(
      backfillEpisodeInSuppressionWindow({ startedAt: entry.windowEnd, endedAt: null }, entry),
    ).toBe(true);
  });
});
